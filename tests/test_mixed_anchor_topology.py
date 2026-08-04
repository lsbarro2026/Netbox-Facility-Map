"""Tier C — mixed-anchor and all-Location-topology regression coverage (MODEL-9).

`BUILDING-ANCHOR-DESIGN.md` §8 open-q 3 asked whether a facility that mixes Site-anchored and
Location-anchored buildings — or is wholly Location-anchored — actually works end to end. Every
individual consumer (`parse_floor_key`, `resolve_floor_location`, `site_floor_scope`,
`scope_floor_keys`, the health checks, the rename remapper, backup/restore, the REST filterset,
`SiteFloors`/`BuildingFloors`) is unit-tested elsewhere, but always against a single building in
isolation — no existing test builds a facility that holds *both* anchor styles together, or two
Location-anchored buildings sharing a floor slug under one campus. That combination is where a
2-segment assumption surviving in a fallback path would actually surface (the `f5d18eb` class of
bug), so this file drives one shared fixture through every one of those consumers.

The fixture: one facility (the default `''`, since neither Site carries a SiteGroup/Region) holding
- **`hq`** — a Site-anchored building, 2-segment `floor_key` (`hq/level-1`).
- **`campus`** — Location-anchored, split into two building Locations, `west-wing` and `east-wing`,
  each with a floor Location of the identical slug `level-1` and a room Location of the identical
  slug `room-1` — every disambiguating code path (`parent__slug`, portable ancestor paths, the
  `(siteSlug, buildingSlug)` anchor) has to actually do its job here, or two rooms with the same key
  suffix but a different building would tell them apart wrong.
"""

import json

import pytest
from django.urls import reverse
from rest_framework.test import APIClient

from netbox_facilitymap import access, facilities, health
from netbox_facilitymap.frontend_api import resolve_floor_location
from netbox_facilitymap.models import Room, parse_floor_key

pytestmark = pytest.mark.django_db

HQ_KEY = 'hq/level-1'
WEST_KEY = 'campus/west-wing/level-1'
EAST_KEY = 'campus/east-wing/level-1'

LIST_URL = 'plugins-api:netbox_facilitymap-api:room-list'


# -- shared fixture builders -------------------------------------------------------------------------

def _build_topology():
    """Create the NetBox tree (Sites/Locations) + bound `Room` rows for `hq` + the two campus wings.
    No manifest/import-map — callers add those when their consumer needs one. Returns a dict of the
    created objects, keyed descriptively."""
    from dcim.models import Location, Site

    hq = Site.objects.create(name='HQ', slug='hq')
    hq_floor = Location.objects.create(name='Level 1', slug='level-1', site=hq)
    hq_room_loc = Location.objects.create(name='Room 1', slug='room-1', site=hq, parent=hq_floor)
    hq_room = Room.objects.create(floor_key=HQ_KEY, room_id='r-hq', label='HQ Room',
                                  location=hq_room_loc, floor_location=hq_floor)

    campus = Site.objects.create(name='Campus', slug='campus')
    west = Location.objects.create(name='West Wing', slug='west-wing', site=campus)
    west_floor = Location.objects.create(name='Level 1', slug='level-1', site=campus, parent=west)
    west_room_loc = Location.objects.create(name='Room 1', slug='room-1', site=campus,
                                            parent=west_floor)
    west_room = Room.objects.create(floor_key=WEST_KEY, room_id='r-west', label='West Room',
                                    location=west_room_loc, floor_location=west_floor)

    east = Location.objects.create(name='East Wing', slug='east-wing', site=campus)
    east_floor = Location.objects.create(name='Level 1', slug='level-1', site=campus, parent=east)
    east_room_loc = Location.objects.create(name='Room 1', slug='room-1', site=campus,
                                            parent=east_floor)
    east_room = Room.objects.create(floor_key=EAST_KEY, room_id='r-east', label='East Room',
                                    location=east_room_loc, floor_location=east_floor)

    return dict(hq=hq, hq_floor=hq_floor, hq_room_loc=hq_room_loc, hq_room=hq_room,
                campus=campus, west=west, west_floor=west_floor, west_room_loc=west_room_loc,
                west_room=west_room, east=east, east_floor=east_floor, east_room_loc=east_room_loc,
                east_room=east_room)


def _manifest_building(dir_, site_slug, floor_id, *, building_slug=None):
    entry = {'code': 'B', 'dir': dir_, 'name': dir_, 'siteSlug': site_slug,
             'floors': [{'id': floor_id, 'label': 'F', 'floorSlug': floor_id,
                         'image': 'images/%s/%s.webp' % (dir_, floor_id),
                         'thumb': 'images/%s/%s.thumb.webp' % (dir_, floor_id),
                         'w': 100, 'h': 100,
                         'pages': [{'image': 'images/%s/%s.webp' % (dir_, floor_id),
                                    'w': 100, 'h': 100, 'caption': None}]}]}
    if building_slug:
        entry['buildingSlug'] = building_slug
    return entry


def _write_manifest(workdir):
    (workdir / 'manifest.json').write_text(json.dumps({'siteplan': None, 'buildings': [
        _manifest_building('hq', 'hq', 'level-1'),
        _manifest_building('campus/west-wing', 'campus', 'level-1', building_slug='west-wing'),
        _manifest_building('campus/east-wing', 'campus', 'level-1', building_slug='east-wing'),
    ]}))


def _write_import_map(workdir):
    (workdir / 'import-map.json').write_text(json.dumps({'buildings': {
        'HQ': {'slug': 'hq', 'abbr': '', 'name': 'HQ', 'floors': {'1': 'level-1'}},
        'West': {'slug': 'campus', 'abbr': '', 'name': 'West', 'floors': {'1': 'level-1'},
                 'buildingSlug': 'west-wing'},
        'East': {'slug': 'campus', 'abbr': '', 'name': 'East', 'floors': {'1': 'level-1'},
                 'buildingSlug': 'east-wing'},
    }}))


def _image_files(workdir, dir_, floor_id):
    d = workdir / 'images' / dir_
    d.mkdir(parents=True, exist_ok=True)
    (d / ('%s.webp' % floor_id)).write_bytes(b'img')
    (d / ('%s.thumb.webp' % floor_id)).write_bytes(b'thumb')


def _read(workdir, name):
    return json.loads((workdir / name).read_text())


def _api(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _filter(params):
    from netbox_facilitymap.filtersets import RoomFilterSet
    return RoomFilterSet(params, queryset=Room.objects.all()).qs


def _site_floors_html(site, user):
    from django.test import RequestFactory
    from netbox_facilitymap.template_content import SiteFloors
    request = RequestFactory().get('/')
    request.user = user
    return SiteFloors(context={'object': site, 'request': request}).full_width_page()


def _building_floors_html(loc, user):
    from django.test import RequestFactory
    from netbox_facilitymap.template_content import BuildingFloors
    request = RequestFactory().get('/')
    request.user = user
    return BuildingFloors(context={'object': loc, 'request': request}).full_width_page()


# -- parse_floor_key ----------------------------------------------------------------------------

def test_parse_floor_key_across_both_shapes():
    assert parse_floor_key(HQ_KEY) == ('hq', '', 'level-1')
    assert parse_floor_key(WEST_KEY) == ('campus', 'west-wing', 'level-1')
    assert parse_floor_key(EAST_KEY) == ('campus', 'east-wing', 'level-1')


# -- resolve_floor_location -----------------------------------------------------------------------

def test_resolve_floor_location_disambiguates_the_shared_floor_slug():
    t = _build_topology()
    assert resolve_floor_location(HQ_KEY) == t['hq_floor']
    assert resolve_floor_location(WEST_KEY) == t['west_floor']
    assert resolve_floor_location(EAST_KEY) == t['east_floor']
    assert resolve_floor_location(WEST_KEY) != t['east_floor']


# -- site_floor_scope / facility_floor_scope --------------------------------------------------------

def test_facility_floor_scope_spans_both_anchor_styles_in_one_facility():
    t = _build_topology()
    facility = facilities.facility_for_site(t['hq'])
    assert facility == facilities.facility_for_site(t['campus']) == ''  # one, the default, facility

    scope = facilities.facility_floor_scope(facility)
    room_ids = set(Room.objects.filter(scope).values_list('room_id', flat=True))
    assert room_ids == {'r-hq', 'r-west', 'r-east'}


def test_site_floor_scope_narrows_to_one_site_regardless_of_anchor_style():
    _build_topology()
    scope = facilities.site_floor_scope({'campus'})
    room_ids = set(Room.objects.filter(scope).values_list('room_id', flat=True))
    assert room_ids == {'r-west', 'r-east'}

    scope = facilities.site_floor_scope({'hq'})
    room_ids = set(Room.objects.filter(scope).values_list('room_id', flat=True))
    assert room_ids == {'r-hq'}


# -- scope_floor_keys (access.py) -----------------------------------------------------------------

def test_scope_floor_keys_narrows_by_viewable_site_across_anchor_styles():
    keys = [HQ_KEY, WEST_KEY, EAST_KEY]
    assert set(access.scope_floor_keys(keys, {'campus'})) == {WEST_KEY, EAST_KEY}
    assert access.scope_floor_keys(keys, {'hq'}) == [HQ_KEY]
    assert set(access.scope_floor_keys(keys, {'hq', 'campus'})) == set(keys)


# -- health.run_checks ------------------------------------------------------------------------------

def test_health_clean_report_for_the_mixed_topology(workdir):
    _build_topology()
    _write_manifest(workdir)

    report = health.run_checks()
    assert not report.has_drift
    assert report.unresolved_floor_keys == []
    assert report.unbound_rooms == []


def test_health_flags_only_the_broken_building_the_others_stay_clean(workdir):
    # hq and east-wing are wired up correctly; west-wing's key names a building Location that
    # doesn't exist (`_check_floor_keys`'s 'no building Location under site' case) — and only that
    # one building should be reported, proving the check doesn't over- or under-reach across
    # buildings that share a floor slug.
    from dcim.models import Location, Site

    hq = Site.objects.create(name='HQ', slug='hq')
    hq_floor = Location.objects.create(name='Level 1', slug='level-1', site=hq)
    Room.objects.create(floor_key=HQ_KEY, room_id='r-hq', floor_location=hq_floor)

    campus = Site.objects.create(name='Campus', slug='campus')
    east = Location.objects.create(name='East Wing', slug='east-wing', site=campus)
    east_floor = Location.objects.create(name='Level 1', slug='level-1', site=campus, parent=east)
    Room.objects.create(floor_key=EAST_KEY, room_id='r-east', floor_location=east_floor)
    # No 'west-wing' Location exists at all.
    Room.objects.create(floor_key=WEST_KEY, room_id='r-west', label='West Room')

    rows = {r.floor_key: r for r in health.run_checks().unresolved_floor_keys}
    assert set(rows) == {WEST_KEY}
    assert rows[WEST_KEY].reason == 'no building Location under site'


# -- signals.py: the rename remapper against the full mixed fixture ---------------------------------

def _seed_for_rename(workdir):
    t = _build_topology()
    _write_manifest(workdir)
    _write_import_map(workdir)
    _image_files(workdir, 'hq', 'level-1')
    _image_files(workdir, 'campus/west-wing', 'level-1')
    _image_files(workdir, 'campus/east-wing', 'level-1')
    return t


def test_campus_site_rename_remaps_both_wings_and_leaves_hq_alone(
        workdir, django_capture_on_commit_callbacks):
    t = _seed_for_rename(workdir)

    with django_capture_on_commit_callbacks(execute=True):
        t['campus'].slug = 'campus-2'
        t['campus'].save()

    keys = {r.room_id: r.floor_key for r in Room.objects.all()}
    assert keys == {'r-hq': HQ_KEY,
                    'r-west': 'campus-2/west-wing/level-1',
                    'r-east': 'campus-2/east-wing/level-1'}
    dirs = {b['dir'] for b in _read(workdir, 'manifest.json')['buildings']}
    assert dirs == {'hq', 'campus-2/west-wing', 'campus-2/east-wing'}
    assert health.run_checks().unresolved_floor_keys == []


def test_building_rename_touches_only_its_own_wing(workdir, django_capture_on_commit_callbacks):
    t = _seed_for_rename(workdir)

    with django_capture_on_commit_callbacks(execute=True):
        t['west'].slug = 'west-wing-2'
        t['west'].save()

    keys = {r.room_id: r.floor_key for r in Room.objects.all()}
    assert keys == {'r-hq': HQ_KEY,
                    'r-west': 'campus/west-wing-2/level-1',
                    'r-east': EAST_KEY}   # sibling wing, same campus Site, untouched
    dirs = {b['dir'] for b in _read(workdir, 'manifest.json')['buildings']}
    assert dirs == {'hq', 'campus/west-wing-2', 'campus/east-wing'}
    assert (workdir / 'images' / 'campus' / 'west-wing-2' / 'level-1.webp').exists()
    assert (workdir / 'images' / 'campus' / 'east-wing' / 'level-1.webp').exists()  # not moved
    assert health.run_checks().unresolved_floor_keys == []


def test_floor_rename_under_one_wing_leaves_the_identically_slugged_sibling_floor_alone(
        workdir, django_capture_on_commit_callbacks):
    t = _seed_for_rename(workdir)

    with django_capture_on_commit_callbacks(execute=True):
        t['west_floor'].slug = 'level-1-renamed'
        t['west_floor'].save()

    keys = {r.room_id: r.floor_key for r in Room.objects.all()}
    assert keys == {'r-hq': HQ_KEY,
                    'r-west': 'campus/west-wing/level-1-renamed',
                    'r-east': EAST_KEY}   # east-wing's own 'level-1' floor, untouched
    assert health.run_checks().unresolved_floor_keys == []


# -- backup.py: portable round-trip across the whole mixed fixture ----------------------------------

def test_backup_restore_roundtrip_rebinds_all_three_buildings(workdir, backupdir):
    from dcim.models import Location, Site

    from netbox_facilitymap.backup import create_backup, restore_backup
    from netbox_facilitymap.models import FacilityMapBlob

    _build_topology()
    _write_manifest(workdir)

    path, _ = create_backup(stamp='20260101-000000')

    # Simulate restoring onto a fresh target instance: wipe the plugin rows, then recreate the DCIM
    # tree with matching slugs but FRESH pks, so a pk-replay could never accidentally pass.
    Room.objects.all().delete()
    FacilityMapBlob.objects.all().delete()
    Location.objects.all().delete()
    Site.objects.all().delete()

    hq = Site.objects.create(name='HQ', slug='hq')
    hq_floor = Location.objects.create(name='Level 1', slug='level-1', site=hq)
    hq_room_loc = Location.objects.create(name='Room 1', slug='room-1', site=hq, parent=hq_floor)

    campus = Site.objects.create(name='Campus', slug='campus')
    west = Location.objects.create(name='West Wing', slug='west-wing', site=campus)
    west_floor = Location.objects.create(name='Level 1', slug='level-1', site=campus, parent=west)
    west_room_loc = Location.objects.create(name='Room 1', slug='room-1', site=campus,
                                            parent=west_floor)
    east = Location.objects.create(name='East Wing', slug='east-wing', site=campus)
    east_floor = Location.objects.create(name='Level 1', slug='level-1', site=campus, parent=east)
    east_room_loc = Location.objects.create(name='Room 1', slug='room-1', site=campus,
                                            parent=east_floor)

    result = restore_backup(path)

    assert result['unresolved'] == []
    rooms = {r.room_id: r for r in Room.objects.all()}
    assert rooms['r-hq'].location_id == hq_room_loc.pk
    assert rooms['r-west'].location_id == west_room_loc.pk
    assert rooms['r-east'].location_id == east_room_loc.pk
    # The sharpest check: west and east share every slug but the building, so a bare-slug lookup
    # would cross-bind them.
    assert rooms['r-west'].location_id != east_room_loc.pk
    assert rooms['r-east'].location_id != west_room_loc.pk


# -- REST surface: filtersets.RoomFilterSet + the api/ serializer's floor_location derivation -------

def test_rest_site_and_facility_filters_span_both_anchor_styles():
    _build_topology()
    assert {r.room_id for r in _filter({'site': ['hq']})} == {'r-hq'}
    assert {r.room_id for r in _filter({'site': ['campus']})} == {'r-west', 'r-east'}
    assert {r.room_id for r in _filter({'facility': ''})} == {'r-hq', 'r-west', 'r-east'}


def test_rest_create_derives_floor_location_for_the_correct_wing(editor_user):
    _build_topology()

    r = _api(editor_user).post(
        reverse(LIST_URL),
        {'floor_key': WEST_KEY, 'room_id': 'rnew', 'polygon': [[0, 0], [1, 0], [1, 1]]},
        format='json')

    assert r.status_code == 201
    room = Room.objects.get(room_id='rnew')
    west_floor = resolve_floor_location(WEST_KEY)
    east_floor = resolve_floor_location(EAST_KEY)
    assert room.floor_location_id == west_floor.pk
    assert room.floor_location_id != east_floor.pk


# -- SiteFloors vs BuildingFloors: disjoint despite the shared floor slug ---------------------------

def test_site_floors_renders_only_hq(editor_user, workdir):
    from conftest import grant
    from dcim.models import Location

    t = _build_topology()
    _write_manifest(workdir)
    grant(editor_user, Location, ['view'])

    html = _site_floors_html(t['hq'], editor_user)
    assert html
    assert t['hq_floor'].get_absolute_url() in html
    assert html.count('1 room') == 1


def test_building_floors_stay_disjoint_for_wings_sharing_a_floor_slug(editor_user, workdir):
    from conftest import grant
    from dcim.models import Location

    t = _build_topology()
    _write_manifest(workdir)
    grant(editor_user, Location, ['view'])

    west_html = _building_floors_html(t['west'], editor_user)
    east_html = _building_floors_html(t['east'], editor_user)

    assert t['west_floor'].get_absolute_url() in west_html
    assert t['east_floor'].get_absolute_url() not in west_html
    assert t['east_floor'].get_absolute_url() in east_html
    assert t['west_floor'].get_absolute_url() not in east_html
