"""Tier C — the two persisted models directly.

The DB-backed tests elsewhere exercise `Room`/`FacilityMapBlob` only *through* `sync_rooms`,
the backup path, or the REST/frontend views. This file pins the models' own contract: the
`unique_together` constraints, the JSON round-trips (polygon / blob data), `__str__`, and
`Room.get_absolute_url`'s bound-vs-unbound fallback. Neither model defines a custom `clean()`,
so the enforced invariants are the DB constraints and the resolution-independent 0..1 polygon
storage — that is what is asserted here, not validation the models don't have."""

import pytest
from django.db import IntegrityError, transaction
from django.urls import reverse

from netbox_facilitymap.models import FacilityMapBlob, Room, parse_floor_key

pytestmark = pytest.mark.django_db


# ---- parse_floor_key (pure, no DB) — the two building-anchor floor-key shapes (MODEL-3) ----

@pytest.mark.parametrize('key,expected', [
    # 2-segment Site-anchored: no building slug.
    ('campus/floor-1', ('campus', '', 'floor-1')),
    # 3-segment Location-anchored: building slug in the middle.
    ('campus/alpha-bldg/level-1', ('campus', 'alpha-bldg', 'level-1')),
    # Tolerate an unexpected extra segment (deeper nesting is out of scope but must not choke —
    # BUILDING-ANCHOR-DESIGN §8): site=first, floor=last, building=second-to-last.
    ('campus/cluster/bldg/level-1', ('campus', 'bldg', 'level-1')),
    # Malformed (fewer than 2 segments) resolves to empties so callers reject it uniformly.
    ('campus', ('', '', '')),
    ('', ('', '', '')),
    # A trailing-empty floor segment surfaces as an empty floor slug (caller rejects on it).
    ('campus/', ('campus', '', '')),
])
def test_parse_floor_key_shapes(key, expected):
    assert parse_floor_key(key) == expected


def _site_floor_room_locations():
    """A Site with a floor Location and a child room Location — the shape `Room.location` binds to."""
    from dcim.models import Location, Site
    site = Site.objects.create(name='Test Site', slug='test-site')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    room_loc = Location.objects.create(name='Room 101', slug='room-101', site=site, parent=floor)
    return site, floor, room_loc


# ---- Room ----

def test_room_polygon_json_round_trips():
    # Normalized 0..1 geometry must survive the JSONField untouched (resolution-independent).
    polygon = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]
    Room.objects.create(floor_key='test-site/floor-1', room_id='r1', label='R1', polygon=polygon)

    assert Room.objects.get(room_id='r1').polygon == polygon


def test_room_unique_together_floor_key_room_id():
    Room.objects.create(floor_key='test-site/floor-1', room_id='r1')
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            Room.objects.create(floor_key='test-site/floor-1', room_id='r1')


def test_room_same_room_id_on_another_floor_is_allowed():
    # The uniqueness is *per floor* — the same editor uid on a different floor is a distinct room.
    Room.objects.create(floor_key='test-site/floor-1', room_id='r1')
    Room.objects.create(floor_key='test-site/floor-2', room_id='r1')
    assert Room.objects.filter(room_id='r1').count() == 2


def test_room_str_prefers_label_then_room_id():
    assert str(Room(room_id='r1', label='Kitchen')) == 'Kitchen'
    assert str(Room(room_id='r1', label='')) == 'r1'


def test_room_absolute_url_bound_is_its_location():
    _site, _floor, room_loc = _site_floor_room_locations()
    room = Room.objects.create(floor_key='test-site/floor-1', room_id='r1', location=room_loc)
    assert room.get_absolute_url() == room_loc.get_absolute_url()


def test_room_absolute_url_unbound_falls_back_to_map():
    room = Room.objects.create(floor_key='test-site/floor-1', room_id='r1')
    assert room.get_absolute_url() == reverse('plugins:netbox_facilitymap:map')


def test_migration_0009_backfills_floor_location():
    # BIND-1 migration: resolvable floor_key slugs get the floor Location FK; unresolvable ones stay
    # null (exactly today's behaviour). Run the migration's RunPython function against live models.
    import importlib
    from django.apps import apps as global_apps

    _site, floor, _room_loc = _site_floor_room_locations()
    r_ok = Room.objects.create(floor_key='test-site/floor-1', room_id='r1')
    r_bad = Room.objects.create(floor_key='test-site/no-such-floor', room_id='r2')
    assert r_ok.floor_location_id is None  # baseline: created without the FK

    mod = importlib.import_module('netbox_facilitymap.migrations.0009_room_floor_location')
    mod.backfill_floor_location(global_apps, None)

    r_ok.refresh_from_db()
    r_bad.refresh_from_db()
    assert r_ok.floor_location_id == floor.pk
    assert r_bad.floor_location_id is None


def test_migration_0015_seeds_z_order_largest_room_first():
    # ROOM-4 migration: existing rooms are seeded into stacking order by DESCENDING polygon area,
    # per floor, so the largest sits at the bottom (z 0) and a room nested inside it lands above.
    # That default is what preserves the ROOM-1/ROOM-2 contained-room punch, which only applies to a
    # child drawn above its container — left on the uniform `0` default, nested pairs would order
    # arbitrarily and roughly half of them would lose their punch on upgrade.
    import importlib
    from django.apps import apps as global_apps

    big = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]          # area 1.0
    mid = [[0.0, 0.0], [0.5, 0.0], [0.5, 0.5], [0.0, 0.5]]          # area 0.25
    small = [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.2]]        # area 0.01

    # Created smallest-first so a pass that merely preserved insertion order would fail.
    Room.objects.create(floor_key='s/f1', room_id='small', polygon=small)
    Room.objects.create(floor_key='s/f1', room_id='big', polygon=big)
    Room.objects.create(floor_key='s/f1', room_id='mid', polygon=mid)
    # A second floor is seeded independently — z_order is dense *per floor*, not globally.
    Room.objects.create(floor_key='s/f2', room_id='only', polygon=mid)
    # A degenerate ring has area 0, so it sorts to the top rather than crashing the shoelace.
    Room.objects.create(floor_key='s/f2', room_id='line', polygon=[[0.1, 0.1], [0.2, 0.2]])

    mod = importlib.import_module('netbox_facilitymap.migrations.0015_room_z_order')
    mod.seed_z_order(global_apps, None)

    assert {r.room_id: r.z_order for r in Room.objects.filter(floor_key='s/f1')} == {
        'big': 0, 'mid': 1, 'small': 2}
    assert {r.room_id: r.z_order for r in Room.objects.filter(floor_key='s/f2')} == {
        'only': 0, 'line': 1}


def test_migration_0012_shards_editor_blobs_by_floor():
    # CONC-1 migration: each whole-document editor blob (key='') splits into one row per floor
    # (key=floor_key); siteplan/settings are untouched. Reverse recombines into one key='' row.
    import importlib
    from django.apps import apps as global_apps

    FacilityMapBlob.objects.create(kind='annotations', facility='', key='', data={
        'sa/f1': {'arrows': [{'p': 1}]}, 'sb/f2': {'notes': []}})
    FacilityMapBlob.objects.create(kind='placements', facility='west', key='', data={
        'wa/f1': {'placements': [{'room': 'r'}]}})
    FacilityMapBlob.objects.create(kind='siteplan', facility='', key='', data={'hotspots': []})

    mod = importlib.import_module('netbox_facilitymap.migrations.0012_shard_editor_blobs_by_floor')

    mod.shard(global_apps, None)
    # annotations split into two per-floor rows; the whole-doc row is gone.
    assert not FacilityMapBlob.objects.filter(kind='annotations', key='').exists()
    assert FacilityMapBlob.objects.get(kind='annotations', key='sa/f1').data == {'arrows': [{'p': 1}]}
    assert FacilityMapBlob.objects.get(kind='annotations', key='sb/f2').data == {'notes': []}
    assert FacilityMapBlob.objects.get(kind='placements', facility='west', key='wa/f1').data \
        == {'placements': [{'room': 'r'}]}
    # siteplan (facility-wide) is left as one key='' row.
    assert FacilityMapBlob.objects.get(kind='siteplan', key='').data == {'hotspots': []}

    mod.unshard(global_apps, None)
    # Recombined back to one whole-document row per (kind, facility); per-floor rows gone.
    assert not FacilityMapBlob.objects.filter(kind='annotations').exclude(key='').exists()
    assert FacilityMapBlob.objects.get(kind='annotations', facility='', key='').data == {
        'sa/f1': {'arrows': [{'p': 1}]}, 'sb/f2': {'notes': []}}
    assert FacilityMapBlob.objects.get(kind='placements', facility='west', key='').data == {
        'wa/f1': {'placements': [{'room': 'r'}]}}


# ---- FacilityMapBlob ----

def test_blob_data_json_round_trips():
    data = {'room_embed_zoom': 1.5, 'nested': {'a': [1, 2, 3]}}
    FacilityMapBlob.objects.create(kind='settings', key='', data=data)
    assert FacilityMapBlob.objects.get(kind='settings').data == data


def test_blob_unique_together_kind_key():
    FacilityMapBlob.objects.create(kind='annotations', key='test-site/floor-1', data={})
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            FacilityMapBlob.objects.create(kind='annotations', key='test-site/floor-1', data={})


def test_blob_same_kind_different_key_is_allowed():
    FacilityMapBlob.objects.create(kind='annotations', key='site/floor-1', data={})
    FacilityMapBlob.objects.create(kind='annotations', key='site/floor-2', data={})
    assert FacilityMapBlob.objects.filter(kind='annotations').count() == 2


def test_blob_str_includes_key_only_when_set():
    assert str(FacilityMapBlob(kind='annotations', key='site/floor-1')) == 'annotations/site/floor-1'
    assert str(FacilityMapBlob(kind='settings', key='')) == 'settings'


def test_blob_same_kind_key_different_facility_is_allowed():
    # The `facility` discriminator namespaces a whole document set (MULTI-1): the same
    # (kind, key) may exist once *per facility*. '' is the default (single) facility.
    FacilityMapBlob.objects.create(kind='siteplan', facility='', key='', data={})
    FacilityMapBlob.objects.create(kind='siteplan', facility='campus-b', key='', data={})
    assert FacilityMapBlob.objects.filter(kind='siteplan').count() == 2


def test_blob_unique_together_includes_facility():
    # The widened constraint still forbids a duplicate within one facility.
    FacilityMapBlob.objects.create(kind='siteplan', facility='campus-b', key='', data={})
    with pytest.raises(IntegrityError):
        with transaction.atomic():
            FacilityMapBlob.objects.create(kind='siteplan', facility='campus-b', key='', data={})


def test_blob_str_prefixes_facility_when_set():
    assert str(FacilityMapBlob(kind='siteplan', facility='campus-b', key='')) == 'campus-b:siteplan'
    assert (str(FacilityMapBlob(kind='annotations', facility='campus-b', key='site/floor-1'))
            == 'campus-b:annotations/site/floor-1')
