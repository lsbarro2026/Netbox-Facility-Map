"""Tier C — `filtersets.RoomFilterSet` driven directly. The `floor_key`/`location_id` filters are
exercised end-to-end through the REST viewset in `test_api.py`; this file covers what that doesn't:
the `q` free-text `search()` method and the plain `label`/`room_id`/`id` field filters."""

import pytest

pytestmark = pytest.mark.django_db


def _filter(params):
    from netbox_facilitymap.filtersets import RoomFilterSet
    from netbox_facilitymap.models import Room
    return RoomFilterSet(params, queryset=Room.objects.all()).qs


# ---- q free-text search ----

def test_search_matches_label_room_id_and_floor_key():
    from netbox_facilitymap.models import Room
    Room.objects.create(floor_key='site-a/f1', room_id='r1', label='Server Room')
    Room.objects.create(floor_key='site-b/lab', room_id='needle', label='Lab')
    Room.objects.create(floor_key='site-c/f3', room_id='r3', label='Office')

    assert {r.room_id for r in _filter({'q': 'server'})} == {'r1'}   # label icontains
    assert {r.room_id for r in _filter({'q': 'needle'})} == {'needle'}  # room_id icontains
    assert {r.room_id for r in _filter({'q': 'site-c'})} == {'r3'}   # floor_key icontains


def test_search_matches_alias():
    # The NAV-18 printed-name synonyms are searchable via `q` too, so a room bound to a differently
    # named Location is still found by the number printed on the plan.
    from netbox_facilitymap.models import Room
    Room.objects.create(floor_key='s/f', room_id='idf', label='IDF-2A', alias='2107, Old Server Room')
    assert {r.room_id for r in _filter({'q': '2107'})} == {'idf'}


def test_search_is_case_insensitive():
    from netbox_facilitymap.models import Room
    Room.objects.create(floor_key='s/f', room_id='r1', label='Mechanical')
    assert {r.room_id for r in _filter({'q': 'MECH'})} == {'r1'}


def test_blank_search_returns_all_rooms():
    from netbox_facilitymap.models import Room
    Room.objects.create(floor_key='s/f', room_id='r1')
    Room.objects.create(floor_key='s/f', room_id='r2')
    assert _filter({'q': '   '}).count() == 2   # whitespace-only short-circuits to the full qs


# ---- plain field filters ----
# The `id`/`label`/`room_id` fields resolve to NetBox multi-value filters, so each param is a
# list (exactly what the QueryDict the REST viewset builds hands them) — a bare string would be
# iterated character-by-character and an int isn't iterable at all.

def test_filter_by_label():
    from netbox_facilitymap.models import Room
    Room.objects.create(floor_key='s/f', room_id='r1', label='Alpha')
    Room.objects.create(floor_key='s/f', room_id='r2', label='Beta')
    assert {r.room_id for r in _filter({'label': ['Alpha']})} == {'r1'}


def test_filter_by_room_id():
    from netbox_facilitymap.models import Room
    Room.objects.create(floor_key='s/f', room_id='keep')
    Room.objects.create(floor_key='s/f', room_id='drop')
    assert {r.room_id for r in _filter({'room_id': ['keep']})} == {'keep'}


def test_filter_by_id():
    from netbox_facilitymap.models import Room
    keep = Room.objects.create(floor_key='s/f', room_id='r1')
    Room.objects.create(floor_key='s/f', room_id='r2')
    assert [r.pk for r in _filter({'id': [keep.pk]})] == [keep.pk]
