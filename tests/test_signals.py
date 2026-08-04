"""Tier C — the slug-rename remap receivers (`signals.py`, HEALTH-4).

Renaming a Site or a floor/building Location in NetBox re-keys, together, every store that froze the
old slug: `Room.floor_key`, the facility `manifest.json`, the wizard `import-map.json`, and the
on-disk `images/<…>` directory. These tests drive a real `.save()` (wrapping it in
`django_capture_on_commit_callbacks` so the `transaction.on_commit` remap actually fires under the
test transaction) and assert all four stores followed the rename.

They also pin *which* renames reach the receivers (HEALTH-11), because that is easy to get wrong:
NetBox's **bulk** paths are covered, since every first-party write saves per object — the CSV/bulk
import and REST bulk-update tests below drive the real views end-to-end and assert the remap ran.
Only a write that skips `save()` entirely (a script calling `QuerySet.update()`, a data migration,
direct SQL) bypasses them — the residue HEALTH-5 covers, pinned as a deliberate non-trigger alongside
a rename during an active import and a non-slug save.

The rename *matrix* is covered in both key shapes (2-segment Site-anchored and 3-segment
Location-anchored) for all three rename kinds, plus the two ways a remap could over-reach — a
prefix-sibling slug and a Location that anchors nothing. The last section covers the paths where a
store is missing or a step fails: each store re-keys independently, and nothing a remap hits may
abort the user's rename (`health.run_checks` is the backstop for whatever didn't land).
"""

import json

import pytest
from django.urls import reverse

from netbox_facilitymap import health, storage
from netbox_facilitymap.models import Room

pytestmark = pytest.mark.django_db


# -- fixtures / helpers ----------------------------------------------------------------------------

def _building(building_dir, floor_id, *, site_slug=None, building_slug=None):
    """One manifest building entry whose floor image lives under
    `images/<building_dir>/<floor_id>.webp`, so a directory-segment rename can be checked against
    both the manifest paths and the files on disk."""
    entry = {'code': 'B', 'dir': building_dir, 'name': 'B',
             'siteSlug': site_slug if site_slug is not None else building_dir,
             'floors': [{'id': floor_id, 'label': 'F', 'floorSlug': floor_id,
                         'image': 'images/%s/%s.webp' % (building_dir, floor_id),
                         'thumb': 'images/%s/%s.thumb.webp' % (building_dir, floor_id),
                         'w': 100, 'h': 100,
                         'pages': [{'image': 'images/%s/%s.webp' % (building_dir, floor_id),
                                    'w': 100, 'h': 100, 'caption': None}]}]}
    if building_slug:
        entry['buildingSlug'] = building_slug
    return entry


def _manifest(workdir, building_dir, floor_id, *, site_slug=None, building_slug=None):
    """A one-floor, one-building manifest. `_write_manifest` takes several `_building` entries when a
    test needs to prove the untouched siblings really are untouched."""
    _write_manifest(workdir, _building(building_dir, floor_id,
                                       site_slug=site_slug, building_slug=building_slug))


def _write_manifest(workdir, *buildings):
    (workdir / 'manifest.json').write_text(
        json.dumps({'siteplan': None, 'buildings': list(buildings)}))


def _import_map(workdir, folder, slug, floor_token, *, building_slug=None):
    entry = {'slug': slug, 'abbr': '', 'name': folder, 'floors': {'1': floor_token}}
    if building_slug:
        entry['buildingSlug'] = building_slug
    (workdir / 'import-map.json').write_text(json.dumps({'buildings': {folder: entry}}))


def _image_files(workdir, building_dir, floor_id):
    d = workdir / 'images' / building_dir
    d.mkdir(parents=True, exist_ok=True)
    (d / ('%s.webp' % floor_id)).write_bytes(b'img')
    (d / ('%s.thumb.webp' % floor_id)).write_bytes(b'thumb')


def _read(workdir, name):
    return json.loads((workdir / name).read_text())


# -- Site rename (2-segment keys) ------------------------------------------------------------------

def test_site_rename_remaps_all_four_stores(workdir, django_capture_on_commit_callbacks):
    from dcim.models import Location, Site
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    Room.objects.create(floor_key='bldg-a/floor-1', room_id='r1', floor_location=floor)
    _manifest(workdir, 'bldg-a', 'floor-1')
    _import_map(workdir, 'BldgA', 'bldg-a', 'floor-1')
    _image_files(workdir, 'bldg-a', 'floor-1')

    with django_capture_on_commit_callbacks(execute=True):
        site.slug = 'bldg-a-renamed'
        site.save()

    # 1. Room.floor_key — first segment swapped.
    assert list(Room.objects.values_list('floor_key', flat=True)) == ['bldg-a-renamed/floor-1']
    # 2. manifest — dir/siteSlug and every image path prefix.
    building = _read(workdir, 'manifest.json')['buildings'][0]
    assert building['dir'] == 'bldg-a-renamed'
    assert building['siteSlug'] == 'bldg-a-renamed'
    floor_entry = building['floors'][0]
    assert floor_entry['image'] == 'images/bldg-a-renamed/floor-1.webp'
    assert floor_entry['thumb'] == 'images/bldg-a-renamed/floor-1.thumb.webp'
    assert floor_entry['pages'][0]['image'] == 'images/bldg-a-renamed/floor-1.webp'
    # 3. import-map — the building's site slug.
    assert _read(workdir, 'import-map.json')['buildings']['BldgA']['slug'] == 'bldg-a-renamed'
    # 4. on-disk image dir moved wholesale.
    assert (workdir / 'images' / 'bldg-a-renamed' / 'floor-1.webp').exists()
    assert not (workdir / 'images' / 'bldg-a').exists()


def test_site_rename_rekeys_the_facility_assignment(workdir, django_capture_on_commit_callbacks):
    # The assignment map's keys are Site slugs (FACILITY-IDENTITY Phase 1), so a Site rename must
    # re-key its entry alongside the four slug-frozen stores — else the Site would silently revert
    # to the grouping derivation, the very re-keying the assignment exists to prevent.
    from dcim.models import Site
    from netbox_facilitymap import facilities
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    facilities.assign_facilities({'bldg-a': 'campus-x'})

    with django_capture_on_commit_callbacks(execute=True):
        site.slug = 'bldg-a-renamed'
        site.save()

    assert facilities.facility_map() == {'bldg-a-renamed': 'campus-x'}
    assert facilities.facility_for_site(site) == 'campus-x'


def test_site_rename_assignment_collision_left_for_operator(workdir,
                                                            django_capture_on_commit_callbacks):
    # An existing assignment under the NEW slug is never clobbered — the re-key is skipped (logged),
    # mirroring the image-dir move's collision stance; the rename itself still succeeds. Site slugs
    # are unique, so the only way an entry can already sit under the new slug is staleness: a Site
    # that was assigned, then deleted (its entry deliberately survives for manual cleanup).
    from dcim.models import Site
    from netbox_facilitymap import facilities
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    site_b = Site.objects.create(name='Bldg B', slug='bldg-b')
    facilities.assign_facilities({'bldg-a': 'campus-x', 'bldg-b': 'campus-y'})
    site_b.delete()   # 'bldg-b' is now a stale entry — and its slug is free to take

    with django_capture_on_commit_callbacks(execute=True):
        site.slug = 'bldg-b'   # collides with the stale assignment key
        site.save()

    assert facilities.facility_map() == {'bldg-a': 'campus-x', 'bldg-b': 'campus-y'}


def test_site_rename_leaves_empty_floor_resolvable(workdir, django_capture_on_commit_callbacks):
    # The core HEALTH-4 win: an EMPTY floor (rendered plan, no room) resolves again after a rename,
    # with no re-import — health reports no drift because the manifest key was re-keyed in place.
    from dcim.models import Location, Site
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    _manifest(workdir, 'bldg-a', 'floor-1')
    _image_files(workdir, 'bldg-a', 'floor-1')

    with django_capture_on_commit_callbacks(execute=True):
        site.slug = 'bldg-a-renamed'
        site.save()

    assert health.run_checks().unresolved_floor_keys == []


# -- Floor-Location rename (2-segment keys, no filesystem move) -------------------------------------

def test_floor_rename_remaps_keys_without_moving_images(workdir, django_capture_on_commit_callbacks):
    from dcim.models import Location, Site
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    Room.objects.create(floor_key='bldg-a/floor-1', room_id='r1', floor_location=floor)
    _manifest(workdir, 'bldg-a', 'floor-1')
    _import_map(workdir, 'BldgA', 'bldg-a', 'floor-1')
    _image_files(workdir, 'bldg-a', 'floor-1')

    with django_capture_on_commit_callbacks(execute=True):
        floor.slug = 'floor-1-renamed'
        floor.save()

    assert list(Room.objects.values_list('floor_key', flat=True)) == ['bldg-a/floor-1-renamed']
    floor_entry = _read(workdir, 'manifest.json')['buildings'][0]['floors'][0]
    assert floor_entry['id'] == 'floor-1-renamed'
    assert floor_entry['floorSlug'] == 'floor-1-renamed'
    # Image paths/files are addressed by explicit manifest path, so a floor rename leaves them put.
    assert floor_entry['image'] == 'images/bldg-a/floor-1.webp'
    assert (workdir / 'images' / 'bldg-a' / 'floor-1.webp').exists()
    assert _read(workdir, 'import-map.json')['buildings']['BldgA']['floors']['1'] == 'floor-1-renamed'
    assert health.run_checks().unresolved_floor_keys == []


def test_floor_rename_under_a_building_remaps_the_3_segment_key(workdir,
                                                                django_capture_on_commit_callbacks):
    # The same floor rename against a Location-anchored building (Site = campus, MODEL-3): the key is
    # 3-segment, so `dispatch_location` gets a `parent_slug` and the manifest floor must be found
    # under the *compound* building `dir` — the import-map entry likewise matches only when its
    # `buildingSlug` lines up, which the 2-segment case never exercises.
    from dcim.models import Location, Site
    campus = Site.objects.create(name='Campus', slug='campus')
    building = Location.objects.create(name='Alpha', slug='alpha-bldg', site=campus)
    floor = Location.objects.create(name='Level 1', slug='level-1', site=campus, parent=building)
    Room.objects.create(floor_key='campus/alpha-bldg/level-1', room_id='r1', floor_location=floor)
    _manifest(workdir, 'campus/alpha-bldg', 'level-1', site_slug='campus', building_slug='alpha-bldg')
    _import_map(workdir, 'Alpha', 'campus', 'level-1', building_slug='alpha-bldg')
    _image_files(workdir, 'campus/alpha-bldg', 'level-1')

    with django_capture_on_commit_callbacks(execute=True):
        floor.slug = 'level-1-renamed'
        floor.save()

    assert list(Room.objects.values_list('floor_key', flat=True)) == [
        'campus/alpha-bldg/level-1-renamed']
    floor_entry = _read(workdir, 'manifest.json')['buildings'][0]['floors'][0]
    assert floor_entry['id'] == 'level-1-renamed'
    assert floor_entry['floorSlug'] == 'level-1-renamed'
    # A floor rename never moves files, in the 3-segment shape either.
    assert floor_entry['image'] == 'images/campus/alpha-bldg/level-1.webp'
    assert (workdir / 'images' / 'campus' / 'alpha-bldg' / 'level-1.webp').exists()
    assert _read(workdir, 'import-map.json')['buildings']['Alpha']['floors']['1'] == 'level-1-renamed'
    assert health.run_checks().unresolved_floor_keys == []


def test_floor_rename_remaps_a_region_split_page_token(workdir,
                                                       django_capture_on_commit_callbacks):
    # A page split into regions (FLOOR-2) stores its import-map floors value as a LIST of
    # `{token, region}` dicts rather than a bare token string. `_map_floor` handles both shapes;
    # only the matching token is re-keyed, its sibling region on the same page is left alone.
    from dcim.models import Location, Site
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    Location.objects.create(name='Floor 2', slug='floor-2', site=site)
    _manifest(workdir, 'bldg-a', 'floor-1')
    (workdir / 'import-map.json').write_text(json.dumps({'buildings': {'BldgA': {
        'slug': 'bldg-a', 'abbr': '', 'name': 'BldgA',
        'floors': {'1': [{'token': 'floor-1', 'region': [0, 0, 0.5, 1]},
                         {'token': 'floor-2', 'region': [0.5, 0, 0.5, 1]}]}}}}))

    with django_capture_on_commit_callbacks(execute=True):
        floor.slug = 'floor-1-renamed'
        floor.save()

    specs = _read(workdir, 'import-map.json')['buildings']['BldgA']['floors']['1']
    assert [s['token'] for s in specs] == ['floor-1-renamed', 'floor-2']
    assert specs[0]['region'] == [0, 0, 0.5, 1]   # the rest of the spec rides along untouched


# -- Building-Location rename (3-segment keys) -----------------------------------------------------

def test_building_rename_remaps_middle_segment(workdir, django_capture_on_commit_callbacks):
    from dcim.models import Location, Site
    campus = Site.objects.create(name='Campus', slug='campus')
    building = Location.objects.create(name='Alpha', slug='alpha-bldg', site=campus)
    floor = Location.objects.create(name='Level 1', slug='level-1', site=campus, parent=building)
    Room.objects.create(floor_key='campus/alpha-bldg/level-1', room_id='r1', floor_location=floor)
    _manifest(workdir, 'campus/alpha-bldg', 'level-1', site_slug='campus', building_slug='alpha-bldg')
    _import_map(workdir, 'Alpha', 'campus', 'level-1', building_slug='alpha-bldg')
    _image_files(workdir, 'campus/alpha-bldg', 'level-1')

    with django_capture_on_commit_callbacks(execute=True):
        building.slug = 'alpha-renamed'
        building.save()

    assert list(Room.objects.values_list('floor_key', flat=True)) == ['campus/alpha-renamed/level-1']
    building_entry = _read(workdir, 'manifest.json')['buildings'][0]
    assert building_entry['dir'] == 'campus/alpha-renamed'
    assert building_entry['siteSlug'] == 'campus'   # the pure campus slug is untouched
    assert building_entry['floors'][0]['image'] == 'images/campus/alpha-renamed/level-1.webp'
    assert _read(workdir, 'import-map.json')['buildings']['Alpha']['buildingSlug'] == 'alpha-renamed'
    assert (workdir / 'images' / 'campus' / 'alpha-renamed' / 'level-1.webp').exists()
    assert not (workdir / 'images' / 'campus' / 'alpha-bldg').exists()
    assert health.run_checks().unresolved_floor_keys == []


def test_site_rename_shifts_only_the_first_segment_of_3_segment_keys(
        workdir, django_capture_on_commit_callbacks):
    # A Site rename under the Location-anchored shape: segment 0 moves everywhere, but the building
    # segment must survive it — the manifest `dir` is a compound `<site>/<building>` here, so this is
    # the one case that exercises `_swap_first_segment` on a real two-segment path (the Site-anchored
    # test above only ever has one segment to swap).
    from dcim.models import Location, Site
    campus = Site.objects.create(name='Campus', slug='campus')
    building = Location.objects.create(name='Alpha', slug='alpha-bldg', site=campus)
    floor = Location.objects.create(name='Level 1', slug='level-1', site=campus, parent=building)
    Room.objects.create(floor_key='campus/alpha-bldg/level-1', room_id='r1', floor_location=floor)
    _manifest(workdir, 'campus/alpha-bldg', 'level-1', site_slug='campus', building_slug='alpha-bldg')
    _import_map(workdir, 'Alpha', 'campus', 'level-1', building_slug='alpha-bldg')
    _image_files(workdir, 'campus/alpha-bldg', 'level-1')

    with django_capture_on_commit_callbacks(execute=True):
        campus.slug = 'campus-renamed'
        campus.save()

    assert list(Room.objects.values_list('floor_key', flat=True)) == [
        'campus-renamed/alpha-bldg/level-1']
    entry = _read(workdir, 'manifest.json')['buildings'][0]
    assert entry['dir'] == 'campus-renamed/alpha-bldg'    # only segment 0 moved
    assert entry['siteSlug'] == 'campus-renamed'
    assert entry['floors'][0]['image'] == 'images/campus-renamed/alpha-bldg/level-1.webp'
    assert _read(workdir, 'import-map.json')['buildings']['Alpha'] == {
        'slug': 'campus-renamed', 'abbr': '', 'name': 'Alpha',
        'floors': {'1': 'level-1'}, 'buildingSlug': 'alpha-bldg'}
    # One directory move at the site level carries the whole building tree beneath it.
    assert (workdir / 'images' / 'campus-renamed' / 'alpha-bldg' / 'level-1.webp').exists()
    assert not (workdir / 'images' / 'campus').exists()
    assert health.run_checks().unresolved_floor_keys == []


# -- Only the renamed object's stores move ---------------------------------------------------------
#
# Every store mutator loops over *all* the manifest's buildings and the `Room` re-key is a prefix
# update, so the interesting failure is over-reach: a rename that also rewrites a sibling it merely
# resembles. These pin the two boundaries that guard against it.

def test_site_rename_leaves_a_prefix_sibling_site_alone(workdir,
                                                        django_capture_on_commit_callbacks):
    # `bldg-a` is a string prefix of `bldg-a-2`, so the `floor_key__startswith` re-key would corrupt
    # the sibling site's rooms if the prefix didn't end in `/`. Same for the manifest and the images.
    from dcim.models import Location, Site
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    sibling = Site.objects.create(name='Bldg A 2', slug='bldg-a-2')
    Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    Location.objects.create(name='Floor 1', slug='floor-1', site=sibling)
    Room.objects.create(floor_key='bldg-a/floor-1', room_id='r1')
    Room.objects.create(floor_key='bldg-a-2/floor-1', room_id='r2')
    _write_manifest(workdir, _building('bldg-a', 'floor-1'), _building('bldg-a-2', 'floor-1'))
    _image_files(workdir, 'bldg-a', 'floor-1')
    _image_files(workdir, 'bldg-a-2', 'floor-1')

    with django_capture_on_commit_callbacks(execute=True):
        site.slug = 'bldg-a-renamed'
        site.save()

    assert Room.objects.get(room_id='r1').floor_key == 'bldg-a-renamed/floor-1'
    assert Room.objects.get(room_id='r2').floor_key == 'bldg-a-2/floor-1'   # sibling untouched
    renamed, untouched = _read(workdir, 'manifest.json')['buildings']
    assert renamed['dir'] == 'bldg-a-renamed' and renamed['siteSlug'] == 'bldg-a-renamed'
    assert untouched['dir'] == 'bldg-a-2' and untouched['siteSlug'] == 'bldg-a-2'
    assert untouched['floors'][0]['image'] == 'images/bldg-a-2/floor-1.webp'
    assert (workdir / 'images' / 'bldg-a-2' / 'floor-1.webp').exists()


def test_renaming_a_room_location_touches_nothing(workdir, django_capture_on_commit_callbacks):
    # A leaf *room* Location is neither a floor (no store keys off `<site>/<floor>/<room>`) nor a
    # building anchor, so `dispatch_location`'s floor-then-building fall-through must end in a
    # complete no-op — not a spurious re-key of the floor it hangs under.
    from dcim.models import Location, Site
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    room_loc = Location.objects.create(name='Room 101', slug='room-101', site=site, parent=floor)
    Room.objects.create(floor_key='bldg-a/floor-1', room_id='r1', location=room_loc)
    _manifest(workdir, 'bldg-a', 'floor-1')
    _import_map(workdir, 'BldgA', 'bldg-a', 'floor-1')
    _image_files(workdir, 'bldg-a', 'floor-1')
    before = ((workdir / 'manifest.json').read_text(), (workdir / 'import-map.json').read_text())

    with django_capture_on_commit_callbacks(execute=True):
        room_loc.slug = 'room-102'
        room_loc.save()

    assert Room.objects.get(room_id='r1').floor_key == 'bldg-a/floor-1'
    assert ((workdir / 'manifest.json').read_text(),
            (workdir / 'import-map.json').read_text()) == before
    assert (workdir / 'images' / 'bldg-a' / 'floor-1.webp').exists()


# -- NetBox's bulk paths DO reach the receivers (HEALTH-11) ----------------------------------------
#
# The docs once claimed CSV import / bulk-edit bypassed this module. They don't: every first-party
# NetBox write saves per object. These two drive the real views (not a hand-rolled imitation of them),
# so if a future NetBox release ever switches one to `bulk_update`, the test — not a user — finds out.

def test_csv_import_rename_remaps_the_map(workdir, client, superuser,
                                          django_capture_on_commit_callbacks):
    # The manage-DCIM-by-CSV workflow: re-import a CSV carrying an existing object's `id` and a
    # changed `slug`. `BulkImportView` updates it through `object_form.save()`, so the remap runs.
    from dcim.models import Site
    site = Site.objects.create(name='Bldg A', slug='bldg-a', status='active')
    _manifest(workdir, 'bldg-a', 'floor-1')
    client.force_login(superuser)

    with django_capture_on_commit_callbacks(execute=True):
        r = client.post(reverse('dcim:site_bulk_import'), {
            'import_method': 'direct',
            'data': 'id,slug\n%d,bldg-a-renamed\n' % site.pk,
            'format': 'csv',
            'csv_delimiter': 'auto',
        }, follow=True)
    assert r.status_code == 200
    site.refresh_from_db()
    assert site.slug == 'bldg-a-renamed'          # the import really did rename it

    building = _read(workdir, 'manifest.json')['buildings'][0]
    assert building['dir'] == 'bldg-a-renamed'
    assert building['siteSlug'] == 'bldg-a-renamed'


def test_rest_api_bulk_update_rename_remaps_the_map(workdir, client, superuser,
                                                    django_capture_on_commit_callbacks):
    # The REST API's list-level bulk PATCH (`api/viewsets/mixins.py`) — despite the name, it runs
    # `perform_update` per object, i.e. a real `save()`, so it re-keys like any single-object edit.
    from dcim.models import Location, Site
    site = Site.objects.create(name='Bldg A', slug='bldg-a', status='active')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site, status='active')
    _manifest(workdir, 'bldg-a', 'floor-1')
    Room.objects.create(floor_key='bldg-a/floor-1', room_id='r1')
    client.force_login(superuser)

    with django_capture_on_commit_callbacks(execute=True):
        r = client.patch('/api/dcim/locations/',
                         json.dumps([{'id': floor.pk, 'slug': 'floor-1-renamed'}]),
                         content_type='application/json')
    assert r.status_code == 200, r.content

    assert _read(workdir, 'manifest.json')['buildings'][0]['floors'][0]['id'] == 'floor-1-renamed'
    assert Room.objects.get(room_id='r1').floor_key == 'bldg-a/floor-1-renamed'


# -- Deliberate non-triggers -----------------------------------------------------------------------

def test_queryset_update_rename_bypasses_the_signal(workdir, django_capture_on_commit_callbacks):
    # A write that skips `save()` altogether — a user-authored NetBox script/plugin calling
    # `QuerySet.update()`/`bulk_update`, a data migration, or direct SQL. No save()/post_save, so the
    # map is NOT re-keyed and health still flags it. This is the residue HEALTH-5 addresses.
    from dcim.models import Location, Site
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    _manifest(workdir, 'bldg-a', 'floor-1')

    with django_capture_on_commit_callbacks(execute=True):
        Location.objects.filter(pk=floor.pk).update(slug='floor-1-renamed')  # bulk path, no signal

    assert _read(workdir, 'manifest.json')['buildings'][0]['floors'][0]['id'] == 'floor-1'  # stale
    rows = {r.floor_key for r in health.run_checks().unresolved_floor_keys}
    assert 'bldg-a/floor-1' in rows


def test_rename_during_active_import_is_skipped(workdir, django_capture_on_commit_callbacks):
    # A fresh render lock means a rebuild is regenerating the manifest/images right now — the remap
    # steps aside (DB/manifest/fs left to the build) and logs; health remains the backstop.
    from dcim.models import Location, Site
    from netbox_facilitymap.render_runner import RenderRunner
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    _manifest(workdir, 'bldg-a', 'floor-1')
    (workdir / RenderRunner.LOCK_NAME).write_text('')   # a fresh lock

    with django_capture_on_commit_callbacks(execute=True):
        floor.slug = 'floor-1-renamed'
        floor.save()

    assert _read(workdir, 'manifest.json')['buildings'][0]['floors'][0]['id'] == 'floor-1'  # untouched


def test_non_slug_save_does_not_remap(workdir, django_capture_on_commit_callbacks):
    from dcim.models import Location, Site
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    _manifest(workdir, 'bldg-a', 'floor-1')

    with django_capture_on_commit_callbacks(execute=True):
        floor.name = 'Floor One'   # a non-slug edit
        floor.save()

    # Nothing re-keyed — the manifest is byte-identical.
    assert _read(workdir, 'manifest.json')['buildings'][0]['floors'][0]['id'] == 'floor-1'


def test_creating_a_site_does_not_remap(workdir, django_capture_on_commit_callbacks):
    # A create has no previous slug to have moved away from, so the receivers bail on `created`
    # before ever building a remapper — even when the new slug collides with a manifest key.
    from dcim.models import Site
    _manifest(workdir, 'bldg-a', 'floor-1')
    before = (workdir / 'manifest.json').read_text()

    with django_capture_on_commit_callbacks(execute=True):
        Site.objects.create(name='Bldg A', slug='bldg-a')

    assert (workdir / 'manifest.json').read_text() == before


# -- Partial stores and failures: a remap is best-effort, never a barrier to the rename -------------
#
# Each store is re-keyed independently and every step is a no-op when its store is absent, so a
# facility missing one of them still gets the others re-keyed. And because a rename is the *user's*
# legitimate edit, nothing here — a raising store write, a blocked directory move — may abort it;
# `health.run_checks` is the backstop for whatever didn't land.

def test_rename_without_an_import_map_still_remaps_the_other_stores(
        workdir, django_capture_on_commit_callbacks):
    # `import-map.json` is absent on an install that imported before the file was retained — a normal
    # state, so its rewrite no-ops rather than failing the remap of the manifest and the rooms.
    from dcim.models import Location, Site
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    Room.objects.create(floor_key='bldg-a/floor-1', room_id='r1', floor_location=floor)
    _manifest(workdir, 'bldg-a', 'floor-1')

    with django_capture_on_commit_callbacks(execute=True):
        floor.slug = 'floor-1-renamed'
        floor.save()

    assert Room.objects.get(room_id='r1').floor_key == 'bldg-a/floor-1-renamed'
    assert _read(workdir, 'manifest.json')['buildings'][0]['floors'][0]['id'] == 'floor-1-renamed'
    assert not (workdir / 'import-map.json').exists()   # nothing conjured one into being


def test_rename_without_a_manifest_still_remaps_the_rooms(workdir,
                                                          django_capture_on_commit_callbacks):
    # The mirror case: DB rows exist but the facility was never rendered (or the manifest was wiped).
    # The authoritative store still follows the rename.
    from dcim.models import Location, Site
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    Room.objects.create(floor_key='bldg-a/floor-1', room_id='r1', floor_location=floor)

    with django_capture_on_commit_callbacks(execute=True):
        floor.slug = 'floor-1-renamed'
        floor.save()

    assert Room.objects.get(room_id='r1').floor_key == 'bldg-a/floor-1-renamed'
    assert not (workdir / 'manifest.json').exists()


def test_blocked_image_dir_move_leaves_the_key_remap_standing(workdir,
                                                              django_capture_on_commit_callbacks):
    # `rename_image_subdir` refuses to clobber an existing destination (it raises `ValueError`). That
    # is caught and logged, and — critically — the DB/manifest re-key that already ran is kept, so the
    # facility resolves through the manifest's explicit image paths and only the stale directory is
    # left for the operator.
    from dcim.models import Location, Site
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    Room.objects.create(floor_key='bldg-a/floor-1', room_id='r1', floor_location=floor)
    _manifest(workdir, 'bldg-a', 'floor-1')
    _image_files(workdir, 'bldg-a', 'floor-1')
    (workdir / 'images' / 'bldg-a-renamed').mkdir()   # the move's destination is already taken

    with django_capture_on_commit_callbacks(execute=True):
        site.slug = 'bldg-a-renamed'
        site.save()

    site.refresh_from_db()
    assert site.slug == 'bldg-a-renamed'              # the user's rename went through regardless
    assert Room.objects.get(room_id='r1').floor_key == 'bldg-a-renamed/floor-1'
    assert _read(workdir, 'manifest.json')['buildings'][0]['dir'] == 'bldg-a-renamed'
    assert (workdir / 'images' / 'bldg-a' / 'floor-1.webp').exists()   # source left where it was


def test_a_raising_remap_never_aborts_the_rename(workdir, monkeypatch,
                                                 django_capture_on_commit_callbacks):
    # The `_safely` guard around the on_commit hand-off: whatever the remap hits, the user's save
    # stands and the failure is logged rather than raised into their request.
    from dcim.models import Location, Site
    from netbox_facilitymap import signals

    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    _manifest(workdir, 'bldg-a', 'floor-1')

    def _boom(self, *args, **kwargs):
        raise RuntimeError('the manifest store exploded')

    monkeypatch.setattr(signals.SlugRenameRemapper, 'dispatch_location', _boom)

    with django_capture_on_commit_callbacks(execute=True):
        floor.slug = 'floor-1-renamed'
        floor.save()

    floor.refresh_from_db()
    assert floor.slug == 'floor-1-renamed'
    # Nothing re-keyed, so health still flags the drift — the documented backstop.
    assert _read(workdir, 'manifest.json')['buildings'][0]['floors'][0]['id'] == 'floor-1'


def test_a_raising_receiver_never_aborts_the_rename(workdir, monkeypatch,
                                                    django_capture_on_commit_callbacks):
    # The `_guarded` wrapper covers the other half: the receiver's own synchronous work (resolving
    # the facility, the site and the parent) before it ever reaches `transaction.on_commit`.
    from dcim.models import Location, Site
    from netbox_facilitymap import signals

    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    _manifest(workdir, 'bldg-a', 'floor-1')

    def _boom(_loc):
        raise RuntimeError('facility resolution exploded')

    monkeypatch.setattr(signals, 'facility_for_location', _boom)

    with django_capture_on_commit_callbacks(execute=True):
        floor.slug = 'floor-1-renamed'
        floor.save()

    floor.refresh_from_db()
    assert floor.slug == 'floor-1-renamed'
    assert _read(workdir, 'manifest.json')['buildings'][0]['floors'][0]['id'] == 'floor-1'


# -- the `location` grouping: a top-level Location rename is a facility rename (MODEL-8) ----------

def _location_grouping():
    from netbox_facilitymap.models import FacilityMapBlob
    FacilityMapBlob.objects.update_or_create(
        kind='settings', facility='', key='', defaults={'data': {'facility_grouping': 'location'}})


def _campus(name='campus'):
    from dcim.models import Location, Site
    site = Site.objects.create(name=name, slug=name)
    root = Location.objects.create(name='bldg-a', slug='bldg-a', site=site)
    floor = Location.objects.create(name='a-l1', slug='a-l1', site=site, parent=root)
    return site, root, floor


def test_root_rename_rekeys_the_facility_and_its_anchor_keys(workdir,
                                                             django_capture_on_commit_callbacks):
    # Renaming a top-level Location under the location grouping renames the FACILITY: its blobs
    # re-key, its working dir moves, and the building-anchor segment of its floor keys follows —
    # all without a re-import, mirroring the HEALTH-4 stance for Site renames.
    from netbox_facilitymap.models import FacilityMapBlob

    _location_grouping()
    _site, root, _floor = _campus()
    FacilityMapBlob.objects.create(kind='annotations', facility='bldg-a',
                                   key='campus/bldg-a/a-l1', data={})
    Room.objects.create(floor_key='campus/bldg-a/a-l1', room_id='r1')
    fac_dir = workdir / 'bldg-a'
    fac_dir.mkdir()
    (fac_dir / 'manifest.json').write_text(json.dumps({'siteplan': None, 'buildings': [
        _building('campus/bldg-a', 'a-l1', site_slug='campus', building_slug='bldg-a')]}))
    img = fac_dir / 'images' / 'campus' / 'bldg-a'
    img.mkdir(parents=True)
    (img / 'a-l1.webp').write_bytes(b'img')

    with django_capture_on_commit_callbacks(execute=True):
        root.slug = 'tower-a'
        root.save()

    assert FacilityMapBlob.objects.filter(kind='annotations', facility='tower-a').exists()
    assert not FacilityMapBlob.objects.filter(kind='annotations', facility='bldg-a').exists()
    assert Room.objects.get(room_id='r1').floor_key == 'campus/tower-a/a-l1'
    moved = json.loads((workdir / 'tower-a' / 'manifest.json').read_text())
    assert moved['buildings'][0]['dir'] == 'campus/tower-a'
    assert (workdir / 'tower-a' / 'images' / 'campus' / 'tower-a' / 'a-l1.webp').is_file()


def test_root_rename_collision_leaves_data_parked(workdir, django_capture_on_commit_callbacks):
    # A rename onto another facility's slug can't be re-keyed without clobbering — the data stays
    # under the old key (never merged), where orphan detection + the Settings reassignment find it.
    # NetBox's (site, slug) uniqueness makes a same-campus collision impossible, so the colliding
    # facility lives under a SECOND campus Site — slug-keyed facilities span sites.
    from dcim.models import Location, Site
    from netbox_facilitymap.models import FacilityMapBlob

    _location_grouping()
    _site, root, _floor = _campus()
    other = Site.objects.create(name='Annex Campus', slug='annex')
    sib = Location.objects.create(name='bldg-b', slug='bldg-b', site=other)
    Location.objects.create(name='b-l1', slug='b-l1', site=other, parent=sib)
    FacilityMapBlob.objects.create(kind='annotations', facility='bldg-a',
                                   key='campus/bldg-a/a-l1', data={})
    FacilityMapBlob.objects.create(kind='annotations', facility='bldg-b',
                                   key='annex/bldg-b/b-l1', data={})

    with django_capture_on_commit_callbacks(execute=True):
        root.slug = 'bldg-b'
        root.save()

    assert FacilityMapBlob.objects.filter(kind='annotations', facility='bldg-a',
                                          key='campus/bldg-a/a-l1').exists()
    assert FacilityMapBlob.objects.filter(kind='annotations', facility='bldg-b',
                                          key='annex/bldg-b/b-l1').exists()


def test_site_rename_under_location_grouping_remaps_every_hosted_facility(
        workdir, django_capture_on_commit_callbacks):
    # One campus Site hosts several facilities; its rename must re-key segment 1 in EVERY hosted
    # facility's manifest, not just a single site-resolved one.
    from dcim.models import Location

    _location_grouping()
    site, _root, _floor = _campus()
    sib = Location.objects.create(name='bldg-b', slug='bldg-b', site=site)
    Location.objects.create(name='b-l1', slug='b-l1', site=site, parent=sib)
    for fac, floor_id in (('bldg-a', 'a-l1'), ('bldg-b', 'b-l1')):
        d = workdir / fac
        d.mkdir()
        (d / 'manifest.json').write_text(json.dumps({'siteplan': None, 'buildings': [
            _building('campus/%s' % fac, floor_id, site_slug='campus', building_slug=fac)]}))

    with django_capture_on_commit_callbacks(execute=True):
        site.slug = 'main-campus'
        site.save()

    for fac in ('bldg-a', 'bldg-b'):
        moved = json.loads((workdir / fac / 'manifest.json').read_text())
        assert moved['buildings'][0]['siteSlug'] == 'main-campus'
        assert moved['buildings'][0]['dir'] == 'main-campus/%s' % fac
