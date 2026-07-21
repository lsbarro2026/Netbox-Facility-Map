"""Tier C — the slug-rename remap receivers (`signals.py`, HEALTH-4).

Renaming a Site or a floor/building Location in NetBox re-keys, together, every store that froze the
old slug: `Room.floor_key`, the facility `manifest.json`, the wizard `import-map.json`, and the
on-disk `images/<…>` directory. These tests drive a real `.save()` (wrapping it in
`django_capture_on_commit_callbacks` so the `transaction.on_commit` remap actually fires under the
test transaction) and assert all four stores followed the rename — plus the deliberate non-triggers:
a `bulk_update` rename (no `save()` signal — the residue HEALTH-5 covers), a rename during an active
import, and a non-slug save.
"""

import json

import pytest

from netbox_facilitymap import health, storage
from netbox_facilitymap.models import Room

pytestmark = pytest.mark.django_db


# -- fixtures / helpers ----------------------------------------------------------------------------

def _manifest(workdir, building_dir, floor_id, *, site_slug=None, building_slug=None):
    """A one-floor manifest whose floor image lives under `images/<building_dir>/<floor_id>.webp`, so
    a directory-segment rename can be checked against both the manifest paths and the files on disk."""
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
    (workdir / 'manifest.json').write_text(json.dumps({'siteplan': None, 'buildings': [entry]}))


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


# -- Deliberate non-triggers -----------------------------------------------------------------------

def test_bulk_update_rename_bypasses_the_signal(workdir, django_capture_on_commit_callbacks):
    # NetBox CSV import / bulk-edit use `bulk_update`, which fires no save()/post_save — so the map is
    # NOT re-keyed and health still flags it. This is the residue HEALTH-5 addresses (chained after).
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
    from netbox_facilitymap.imports import RenderRunner
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
