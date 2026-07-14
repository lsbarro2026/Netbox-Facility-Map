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

from netbox_facilitymap.models import FacilityMapBlob, Room

pytestmark = pytest.mark.django_db


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
