"""Tier C — the REST `api/` package (`serializers`/`urls`/`views`), mounted by NetBox under
`/api/plugins/facilitymap/`. This is a public, documented surface that nothing else in the suite
touches. Covers list / detail / create, the `RoomFilterSet` wiring (`floor_key`/`location_id`),
the nested `location` representation, and the object-permission gate.

Auth uses DRF's `force_authenticate` rather than a real token: NetBox's token wire-format differs
across the supported 4.x line (4.6 uses a hashed `Bearer <prefix><key>.<token>` scheme), whereas
`force_authenticate` sets `request.user` directly and is version-agnostic. It still exercises the
full permission path — `TokenPermissions` only enforces the token-write check when `request.auth`
is a `Token`, so with `request.auth` None the stock `perms_map` (view/add/…) is what gates the
request, which is exactly the object-permission behaviour under test."""

import pytest
from django.urls import reverse
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db

LIST_URL = 'plugins-api:netbox_facilitymap-api:room-list'
DETAIL_URL = 'plugins-api:netbox_facilitymap-api:room-detail'

FLOOR = 'test-site/floor-1'


def _api(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _site_floor_room_locations():
    from dcim.models import Location, Site
    site = Site.objects.create(name='Test Site', slug='test-site')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    room_loc = Location.objects.create(name='Room 101', slug='room-101', site=site, parent=floor)
    return site, floor, room_loc


# ---- read ----

def test_list_returns_rooms(editor_user):
    from netbox_facilitymap.models import Room
    Room.objects.create(floor_key=FLOOR, room_id='r1', label='R1')
    Room.objects.create(floor_key=FLOOR, room_id='r2', label='R2')

    r = _api(editor_user).get(reverse(LIST_URL))

    assert r.status_code == 200
    assert r.data['count'] == 2
    assert {row['room_id'] for row in r.data['results']} == {'r1', 'r2'}


def test_detail_exposes_fields_and_nested_location(editor_user):
    from netbox_facilitymap.models import Room
    _site, _floor, room_loc = _site_floor_room_locations()
    room = Room.objects.create(floor_key=FLOOR, room_id='r1', label='R1', location=room_loc)

    r = _api(editor_user).get(reverse(DETAIL_URL, kwargs={'pk': room.pk}))

    assert r.status_code == 200
    assert r.data['floor_key'] == FLOOR
    assert r.data['label'] == 'R1'
    # `location` is the brief-nested LocationSerializer, so it carries the bound Location's id.
    assert r.data['location']['id'] == room_loc.pk


def test_filter_by_floor_key(editor_user):
    from netbox_facilitymap.models import Room
    Room.objects.create(floor_key=FLOOR, room_id='r1')
    Room.objects.create(floor_key='test-site/floor-2', room_id='r2')

    r = _api(editor_user).get(reverse(LIST_URL), {'floor_key': FLOOR})

    assert r.status_code == 200
    assert [row['room_id'] for row in r.data['results']] == ['r1']


def test_filter_by_location_id(editor_user):
    from netbox_facilitymap.models import Room
    _site, _floor, room_loc = _site_floor_room_locations()
    Room.objects.create(floor_key=FLOOR, room_id='bound', location=room_loc)
    Room.objects.create(floor_key=FLOOR, room_id='unbound')

    r = _api(editor_user).get(reverse(LIST_URL), {'location_id': room_loc.pk})

    assert r.status_code == 200
    assert [row['room_id'] for row in r.data['results']] == ['bound']


# ---- write ----

def test_create_room(editor_user):
    from netbox_facilitymap.models import Room
    payload = {'floor_key': FLOOR, 'room_id': 'rnew', 'label': 'New Room',
               'polygon': [[0, 0], [1, 0], [1, 1]]}

    r = _api(editor_user).post(reverse(LIST_URL), payload, format='json')

    assert r.status_code == 201
    room = Room.objects.get(room_id='rnew')
    assert room.label == 'New Room'
    assert room.polygon == [[0, 0], [1, 0], [1, 1]]


# ---- permission gate ----

def test_list_denied_without_view_permission(plain_user):
    # plain_user holds no Room object permission at all, so NetBox's `TokenPermissions` (a
    # DjangoObjectPermissions subclass) fails the `view_room` model-permission check and forbids
    # the list outright — the rows never leak.
    from netbox_facilitymap.models import Room
    Room.objects.create(floor_key=FLOOR, room_id='r1')

    r = _api(plain_user).get(reverse(LIST_URL))

    assert r.status_code == 403


def test_create_denied_without_add_permission(plain_user):
    from netbox_facilitymap.models import Room
    r = _api(plain_user).post(reverse(LIST_URL),
                              {'floor_key': FLOOR, 'room_id': 'rnew'}, format='json')

    assert r.status_code == 403
    assert not Room.objects.filter(room_id='rnew').exists()
