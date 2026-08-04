"""Tier C — the REST `api/` package (`serializers`/`urls`/`views`), mounted by NetBox under
`/api/plugins/facilitymap/`. This is a public, documented surface that nothing else in the suite
touches. Covers list / detail / create, the `RoomFilterSet` wiring (`floor_key`/`location_id`/
`site_id`), the nested `location` representation, the derived `floor_location` binding, the list's
query cost, and the object-permission gate.

It also pins the **sweep-on-save interaction** with the map editor documented in
`api/serializers.py`. The editor stays authoritative for a floor's room set — a room absent from
its Save is deleted — but since API-1 a REST write bumps that floor's CONC-1 concurrency token, so
an editor holding a *stale* document is rejected with a 409 rather than silently sweeping. The
tests below cover both sides: the 409, and the deliberate escape hatch (a client sending no version
header at all still last-writer-wins).

The last section covers the tokened read-only endpoints (`manifest/`, `placements/`) and — most
importantly — that they honour the same per-Site read scoping as their page-mount twins.

Auth uses DRF's `force_authenticate` rather than a real token: NetBox's token wire-format differs
across the supported 4.x line (4.6 uses a hashed `Bearer <prefix><key>.<token>` scheme), whereas
`force_authenticate` sets `request.user` directly and is version-agnostic. It still exercises the
full permission path — `TokenPermissions` only enforces the token-write check when `request.auth`
is a `Token`, so with `request.auth` None the stock `perms_map` (view/add/…) is what gates the
request, which is exactly the object-permission behaviour under test."""

import json
import warnings

import pytest
from django.urls import reverse
from rest_framework.test import APIClient

from netbox_facilitymap.frontend_api import VERSION_HEADER

pytestmark = pytest.mark.django_db

LIST_URL = 'plugins-api:netbox_facilitymap-api:room-list'
DETAIL_URL = 'plugins-api:netbox_facilitymap-api:room-detail'
#: The map editor's own save endpoint — the other half of the sweep interaction below.
ANNOTATIONS = 'plugins:netbox_facilitymap:api-annotations'

FLOOR = 'test-site/floor-1'
FLOOR2 = 'test-site/floor-2'


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


def test_alias_exposed_and_writable(editor_user):
    # The NAV-18 search-terms field is a durable REST-writable field like `label` — read on detail,
    # settable via PATCH on an editor-owned room.
    from netbox_facilitymap.models import Room
    # A durable REST write targets an editor-drawn room, so it carries a polygon (a blank polygon
    # trips the serializer's own required-field check on PATCH, independent of alias).
    room = Room.objects.create(floor_key=FLOOR, room_id='r1', label='IDF-2A', alias='2107',
                               polygon=[[0, 0], [1, 0], [1, 1]])

    r = _api(editor_user).get(reverse(DETAIL_URL, kwargs={'pk': room.pk}))
    assert r.status_code == 200 and r.data['alias'] == '2107'

    r = _api(editor_user).patch(reverse(DETAIL_URL, kwargs={'pk': room.pk}),
                                {'alias': '2107, Old Server Room'}, format='json')
    assert r.status_code == 200
    room.refresh_from_db()
    assert room.alias == '2107, Old Server Room'


# ---- query cost ----

def _list_queries(editor_user):
    """Run a room-list request and return its captured SQL. A *fresh* user instance each time:
    NetBox caches the resolved object-permission set on the user, so a reused one would make a
    later measurement artificially cheap."""
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    fresh = type(editor_user).objects.get(pk=editor_user.pk)
    with CaptureQueriesContext(connection) as ctx:
        r = _api(fresh).get(reverse(LIST_URL))
        assert r.status_code == 200
    return [q['sql'] for q in ctx.captured_queries]


def _seed_rooms(site, floor, n):
    from dcim.models import Location
    from netbox_facilitymap.models import Room
    Room.objects.all().delete()
    Location.objects.filter(parent=floor).delete()
    for i in range(n):
        loc = Location.objects.create(name=f'Room {i}', slug=f'r{i}', site=site, parent=floor)
        Room.objects.create(floor_key=FLOOR, room_id=f'r{i}', label=f'R{i}', location=loc)


def test_list_query_count_is_flat_across_room_count(editor_user):
    """No N+1: listing five rooms costs exactly what listing one does."""
    site, floor, _room_loc = _site_floor_room_locations()

    _seed_rooms(site, floor, 1)
    one_room = len(_list_queries(editor_user))
    _seed_rooms(site, floor, 5)
    assert len(_list_queries(editor_user)) == one_room


def test_list_joins_the_bound_location_rather_than_fetching_it_separately(editor_user):
    """`RoomViewSet.queryset` `select_related`s the forward `location` FK, so the nested Location
    rides the room SELECT's join. Counting queries alone can't see a regression here — NetBox's
    `get_queryset` auto-prefetches serializer-nested fields, so dropping the `select_related` costs
    one *extra* round trip rather than an N+1, and stays flat across room count. So assert the
    shape: `dcim_location` is touched only by the room query itself."""
    site, floor, _room_loc = _site_floor_room_locations()
    _seed_rooms(site, floor, 3)

    location_queries = [q for q in _list_queries(editor_user) if 'dcim_location' in q]

    assert len(location_queries) == 1
    assert 'netbox_facilitymap_room' in location_queries[0]   # joined, not a second trip


# ---- the REST ↔ editor sweep interaction (the `api/serializers.py` caveat) ----
#
# The editor remains authoritative for a floor's room set — that rule is untouched. What API-1
# added is that a REST write bumps the floor's CONC-1 token, converting the old *silent* sweep of a
# REST-created room into the ordinary 409 the client already handles.

def _editor_save(client, floors, version):
    """POST an annotations document as the map editor would — only the floors it touched (CONC-1).
    `version=None` omits the header entirely (the non-versioned client)."""
    headers = {} if version is None else {VERSION_HEADER: json.dumps(version)}
    return client.post(reverse(ANNOTATIONS), data=json.dumps(floors),
                       content_type='application/json', headers=headers)


def _editor_room(rid, label='', poly=None):
    return {'id': rid, 'label': label, 'polygon': poly or [[0, 0], [1, 0], [1, 1]], 'location': None}


def _rest_create(user, floor_key=FLOOR, room_id='rest-room'):
    r = _api(user).post(reverse(LIST_URL),
                        {'floor_key': floor_key, 'room_id': room_id, 'label': 'From REST',
                         'polygon': [[0, 0], [1, 0], [1, 1]]},
                        format='json')
    assert r.status_code == 201
    return r


def test_a_stale_editor_save_is_rejected_rather_than_sweeping_a_rest_created_room(client, editor_user):
    # The headline fix. The editor loaded the floor (token '' — no blob row yet), then a REST client
    # created a room. The REST write bumped the floor's token, so the editor's now-stale Save is a
    # 409 and the room survives, instead of being silently deleted.
    from netbox_facilitymap.models import Room
    client.force_login(editor_user)
    assert client.get(reverse(ANNOTATIONS)).status_code == 200   # the editor's load

    _rest_create(editor_user)

    saved = _editor_save(client, {FLOOR: {'rooms': [_editor_room('r1', 'Drawn')]}}, {FLOOR: ''})
    assert saved.status_code == 409
    assert Room.objects.filter(room_id='rest-room').exists()


def test_reloading_after_the_conflict_lets_the_save_through_and_keeps_the_rest_room(client, editor_user):
    # The other half of the 409 contract: the reloaded document *contains* the REST room
    # (`compose_annotations` serves `Room` rows the editor never drew), so the retried Save carries
    # it and it is not swept.
    from netbox_facilitymap.models import Room
    # A real Site, because `compose_annotations` scopes rooms to the facility's sites — a room whose
    # `floor_key` names no live Site belongs to no facility and is composed into no document.
    _site_floor_room_locations()
    _rest_create(editor_user)
    client.force_login(editor_user)

    reloaded = client.get(reverse(ANNOTATIONS))
    doc = reloaded.json()
    assert {room['id'] for room in doc[FLOOR]['rooms']} == {'rest-room'}

    saved = _editor_save(client, {FLOOR: doc[FLOOR]},
                         json.loads(reloaded.headers[VERSION_HEADER]))
    assert saved.status_code == 200
    assert Room.objects.filter(room_id='rest-room').exists()


def test_a_room_deleted_on_the_canvas_is_still_swept(client, editor_user):
    # The sweep itself is unchanged: a room the user genuinely removes is absent from the *fresh*
    # document they save, and still goes away. The token guards staleness, not deletion.
    from netbox_facilitymap.models import Room
    _rest_create(editor_user)
    client.force_login(editor_user)

    reloaded = client.get(reverse(ANNOTATIONS))
    version = json.loads(reloaded.headers[VERSION_HEADER])
    # The user deletes the REST room on the canvas and draws their own, then saves.
    saved = _editor_save(client, {FLOOR: {'rooms': [_editor_room('r1', 'Drawn')]}}, version)

    assert saved.status_code == 200
    assert not Room.objects.filter(room_id='rest-room').exists()
    assert Room.objects.filter(room_id='r1').exists()


def test_a_save_with_no_version_header_still_last_writer_wins(client, editor_user):
    # The token check is opt-in by design (`_sent_shard_versions` returns None for an absent
    # header), so a non-versioned writer keeps working — and keeps the old sweep semantics. Pinned
    # explicitly so the escape hatch isn't closed by accident.
    from netbox_facilitymap.models import Room
    _rest_create(editor_user)
    client.force_login(editor_user)

    saved = _editor_save(client, {FLOOR: {'rooms': [_editor_room('r1', 'Drawn')]}}, None)

    assert saved.status_code == 200
    assert not Room.objects.filter(room_id='rest-room').exists()


def test_rest_write_bumps_only_its_own_floors_token(client, editor_user):
    # The bump is per-floor, like every other CONC-1 token: a REST write on floor 2 must not force
    # an editor working on floor 1 to reload.
    _rest_create(editor_user, floor_key=FLOOR2)

    client.force_login(editor_user)
    saved = _editor_save(client, {FLOOR: {'rooms': [_editor_room('r1')]}}, {FLOOR: ''})

    assert saved.status_code == 200


def test_rest_delete_also_bumps_the_floor_token(client, editor_user):
    # A REST *delete* is equally lost by a stale save (the stale document still carries the room and
    # would upsert it back), so it bumps the token too.
    from netbox_facilitymap.models import Room
    client.force_login(editor_user)
    first = _editor_save(client, {FLOOR: {'rooms': [_editor_room('r1', 'Drawn')]}}, {FLOOR: ''})
    version = json.loads(first.headers[VERSION_HEADER])
    room = Room.objects.get(room_id='r1')

    assert _api(editor_user).delete(reverse(DETAIL_URL, kwargs={'pk': room.pk})).status_code == 204

    resaved = _editor_save(client, {FLOOR: {'rooms': [_editor_room('r1', 'Drawn')]}}, version)
    assert resaved.status_code == 409
    assert not Room.objects.filter(room_id='r1').exists()


def test_rest_created_room_survives_a_save_of_a_different_floor(client, editor_user):
    # The exposure is scoped to the room's own floor: since CONC-1 an editor POST carries only the
    # floors it touched, so a REST room on an untouched floor is never swept.
    from netbox_facilitymap.models import Room
    r = _api(editor_user).post(reverse(LIST_URL),
                               {'floor_key': FLOOR2, 'room_id': 'rest-room', 'label': 'From REST',
                                'polygon': [[0, 0], [1, 0], [1, 1]]},
                               format='json')
    assert r.status_code == 201

    client.force_login(editor_user)
    _editor_save(client, {FLOOR: {'rooms': [_editor_room('r1')]}}, {FLOOR: ''})

    assert Room.objects.filter(room_id='rest-room').exists()   # a floor-1 save leaves floor-2 alone


def test_rest_edits_to_an_editor_owned_room_round_trip_through_a_resave(client, editor_user):
    # The durable pattern: edit fields on a room the editor already owns. The row upserts in place
    # on `(floor_key, room_id)` and the editor's own GET→POST cycle carries `label`/`alias`/
    # `location` back out, so the REST values survive the next Save.
    from netbox_facilitymap.models import Room
    _site, _floor, room_loc = _site_floor_room_locations()

    client.force_login(editor_user)
    first = _editor_save(client, {FLOOR: {'rooms': [_editor_room('r1', 'Drawn')]}}, {FLOOR: ''})
    room = Room.objects.get(room_id='r1')

    patched = _api(editor_user).patch(
        reverse(DETAIL_URL, kwargs={'pk': room.pk}),
        {'label': 'From REST', 'alias': '2107', 'location': room_loc.pk}, format='json')
    assert patched.status_code == 200

    # The editor reloads and saves back what it was served — the real flow, not a stale document.
    # The reload's token, not `first`'s: the PATCH above bumped the floor's version, which is
    # exactly what makes the pre-PATCH token stale.
    reloaded = client.get(reverse(ANNOTATIONS))
    assert json.loads(reloaded.headers[VERSION_HEADER]) != json.loads(first.headers[VERSION_HEADER])
    resaved = _editor_save(client, {FLOOR: reloaded.json()[FLOOR]},
                           json.loads(reloaded.headers[VERSION_HEADER]))
    assert resaved.status_code == 200

    room.refresh_from_db()
    assert room.label == 'From REST'
    assert room.alias == '2107'
    assert room.location_id == room_loc.pk


def test_rest_room_is_not_swept_by_a_saver_who_may_not_delete_it(client, editor_user, plain_user):
    # The sweep is scoped to `restrict(user, 'delete')`, so it only bites when the *saving* user may
    # delete the room. `plain_user` may change the map but holds no Room delete permission. Saved
    # without a version header so the token guard doesn't short-circuit the delete scoping under test.
    from netbox_facilitymap.models import Room
    _rest_create(editor_user)

    client.force_login(plain_user)
    saved = _editor_save(client, {FLOOR: {'rooms': [_editor_room('r1')]}}, None)
    assert saved.status_code == 200

    assert Room.objects.filter(room_id='rest-room').exists()   # out of that user's delete scope


# ---- the derived floor binding (BIND-1 over REST) ----

def test_floor_location_is_derived_from_floor_key_on_a_rest_create(editor_user):
    # A REST client sets a room's floor by setting `floor_key`; the serializer resolves the
    # rename-proof FK from it, the same way `sync_rooms` does, so a REST-created room resolves on
    # its floor's Location page like an editor-drawn one.
    from netbox_facilitymap.models import Room
    _site, floor, _room_loc = _site_floor_room_locations()

    r = _api(editor_user).post(reverse(LIST_URL),
                               {'floor_key': FLOOR, 'room_id': 'rnew',
                                'polygon': [[0, 0], [1, 0], [1, 1]]},
                               format='json')

    assert r.status_code == 201
    assert Room.objects.get(room_id='rnew').floor_location_id == floor.pk
    assert r.data['floor_location']['id'] == floor.pk


def test_floor_location_is_not_writable_over_rest(editor_user):
    # It stays read-only: it is *derived*, so an explicit value is ignored rather than becoming a
    # second source of truth that could disagree with `floor_key`.
    from dcim.models import Location
    from netbox_facilitymap.models import Room
    site, floor, _room_loc = _site_floor_room_locations()
    other = Location.objects.create(name='Floor 9', slug='floor-9', site=site)

    r = _api(editor_user).post(reverse(LIST_URL),
                               {'floor_key': FLOOR, 'room_id': 'rnew', 'floor_location': other.pk,
                                'polygon': [[0, 0], [1, 0], [1, 1]]},
                               format='json')

    assert r.status_code == 201
    # Resolved from `floor_key` (floor-1), not the floor-9 the caller asked for.
    assert Room.objects.get(room_id='rnew').floor_location_id == floor.pk


def test_floor_location_derivation_is_sticky_when_the_key_no_longer_resolves(editor_user):
    # Same rule as `sync_rooms`: a key that resolves to nothing leaves a previously-stored FK alone
    # rather than nulling it — the Site/floor may simply have been renamed since import (BIND-1).
    from netbox_facilitymap.models import Room
    _site, floor, _room_loc = _site_floor_room_locations()
    room = Room.objects.create(floor_key='gone-site/gone-floor', room_id='r1',
                               polygon=[[0, 0], [1, 0], [1, 1]], floor_location=floor)

    r = _api(editor_user).patch(reverse(DETAIL_URL, kwargs={'pk': room.pk}),
                                {'label': 'Renamed away'}, format='json')

    assert r.status_code == 200
    room.refresh_from_db()
    assert room.floor_location_id == floor.pk


def test_floor_location_is_rederived_when_a_room_moves_floors(editor_user):
    from dcim.models import Location
    from netbox_facilitymap.models import Room
    site, floor, _room_loc = _site_floor_room_locations()
    floor2 = Location.objects.create(name='Floor 2', slug='floor-2', site=site)
    room = Room.objects.create(floor_key=FLOOR, room_id='r1', polygon=[[0, 0], [1, 0], [1, 1]],
                               floor_location=floor)

    r = _api(editor_user).patch(reverse(DETAIL_URL, kwargs={'pk': room.pk}),
                                {'floor_key': FLOOR2}, format='json')

    assert r.status_code == 200
    room.refresh_from_db()
    assert room.floor_location_id == floor2.pk


# ---- the site filter, end to end ----

def test_filter_by_site_id(editor_user):
    from netbox_facilitymap.models import Room
    site, floor, _room_loc = _site_floor_room_locations()
    Room.objects.create(floor_key=FLOOR, room_id='here', floor_location=floor)
    Room.objects.create(floor_key='other-site/floor-1', room_id='elsewhere')

    r = _api(editor_user).get(reverse(LIST_URL), {'site_id': site.pk})

    assert r.status_code == 200
    assert [row['room_id'] for row in r.data['results']] == ['here']


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


# ---- the tokened read-only endpoints (`manifest/`, `placements/`) ----
#
# These exist so a script holding a NetBox API token can read the same facility documents the
# browser reads through session-authenticated page-mount views. The scoping tests are the point:
# a tokened read must never be a way around the per-Site layer (SEC-1/SEC-2).

MANIFEST_URL = 'plugins-api:netbox_facilitymap-api:manifest'
PLACEMENTS_URL = 'plugins-api:netbox_facilitymap-api:placements'


def _cfg(monkeypatch, key, value):
    from django.conf import settings
    monkeypatch.setitem(settings.PLUGINS_CONFIG['netbox_facilitymap'], key, value)


def _seed_two_building_manifest(workdir):
    """Two ungrouped Sites (so both land in the default facility '') and a manifest naming both,
    plus a campus siteplan — the same shape `test_access.py` uses for the page-mount view."""
    from dcim.models import Site

    Site.objects.create(name='A', slug='a')
    Site.objects.create(name='B', slug='b')
    (workdir / 'manifest.json').write_text(json.dumps({
        'siteplan': {'image': 'images/Siteplan/siteplan.png', 'siteSlug': 'a', 'hotspots': []},
        'buildings': [{'siteSlug': 'a', 'dir': 'a', 'floors': []},
                      {'siteSlug': 'b', 'dir': 'b', 'floors': []}],
        'built': 1,
    }))


def _site_scoped_user(name, slugs):
    from dcim.models import Site
    from utilities.testing import create_test_user
    from tests.conftest import grant

    user = create_test_user(name)
    grant(user, Site, ['view'], constraints={'slug__in': list(slugs)})
    return user


def test_manifest_endpoint_serves_the_rendered_manifest(editor_user, workdir):
    _seed_two_building_manifest(workdir)

    r = _api(editor_user).get(reverse(MANIFEST_URL))

    assert r.status_code == 200
    assert {b['siteSlug'] for b in r.data['buildings']} == {'a', 'b'}


def test_manifest_endpoint_serves_the_stub_before_an_import(editor_user, workdir):
    # No manifest file at all — the pre-import facility. Same answer the page-mount view gives, so
    # a poller sees an empty facility rather than a 404 it has to special-case.
    r = _api(editor_user).get(reverse(MANIFEST_URL))

    assert r.status_code == 200
    assert r.data == {'siteplan': None, 'buildings': []}


def test_manifest_endpoint_rejects_an_invalid_facility(editor_user, workdir):
    r = _api(editor_user).get(reverse(MANIFEST_URL), {'facility': '../etc'})

    assert r.status_code == 400


def test_manifest_endpoint_honours_per_site_read_scoping(workdir, monkeypatch):
    # The headline: a tokened read is filtered exactly like the browser read.
    _cfg(monkeypatch, 'scope_reads_to_sites', True)
    _seed_two_building_manifest(workdir)

    r = _api(_site_scoped_user('api_scoped_a', ['a'])).get(reverse(MANIFEST_URL))

    assert r.status_code == 200
    assert {b['siteSlug'] for b in r.data['buildings']} == {'a'}   # building `b` withheld
    assert r.data['siteplan'] is not None


def test_manifest_endpoint_is_empty_for_a_user_who_views_no_site(workdir, monkeypatch):
    _cfg(monkeypatch, 'scope_reads_to_sites', True)
    _seed_two_building_manifest(workdir)

    r = _api(_site_scoped_user('api_scoped_none', [])).get(reverse(MANIFEST_URL))

    assert r.data['buildings'] == [] and r.data['siteplan'] is None


def test_placements_endpoint_returns_the_stored_document_per_floor(editor_user):
    from netbox_facilitymap.models import FacilityMapBlob
    FacilityMapBlob.objects.create(kind='placements', facility='', key=FLOOR,
                                   data={'racks': [{'id': 1}]})
    # The facility-wide `key=''` row is not a floor shard and must not leak into the map.
    FacilityMapBlob.objects.create(kind='placements', facility='', key='', data={'legacy': True})

    r = _api(editor_user).get(reverse(PLACEMENTS_URL))

    assert r.status_code == 200
    assert r.data == {FLOOR: {'racks': [{'id': 1}]}}


def test_placements_endpoint_honours_per_site_read_scoping(monkeypatch):
    # Scoping drops whole floors, keyed on the floor_key's leading Site slug.
    from netbox_facilitymap.models import FacilityMapBlob
    from dcim.models import Site
    _cfg(monkeypatch, 'scope_reads_to_sites', True)
    Site.objects.create(name='A', slug='a')
    Site.objects.create(name='B', slug='b')
    FacilityMapBlob.objects.create(kind='placements', facility='', key='a/f1', data={'racks': []})
    FacilityMapBlob.objects.create(kind='placements', facility='', key='b/f1', data={'racks': []})

    r = _api(_site_scoped_user('api_place_a', ['a'])).get(reverse(PLACEMENTS_URL))

    assert r.status_code == 200
    assert set(r.data) == {'a/f1'}


def test_read_endpoints_require_authentication(workdir):
    from rest_framework.test import APIClient
    assert APIClient().get(reverse(MANIFEST_URL)).status_code in (401, 403)
    assert APIClient().get(reverse(PLACEMENTS_URL)).status_code in (401, 403)


def test_read_endpoints_respect_the_optional_map_read_gate(login_only_user, workdir, monkeypatch):
    # With `require_view_permission` on, a bare authenticated user is shut out of the tokened reads
    # exactly as they are out of the page-mount ones.
    _cfg(monkeypatch, 'require_view_permission', True)

    assert _api(login_only_user).get(reverse(MANIFEST_URL)).status_code == 403
    assert _api(login_only_user).get(reverse(PLACEMENTS_URL)).status_code == 403


def test_read_endpoints_are_login_only_by_default(login_only_user, workdir):
    # Gate off (the default): any signed-in user reads, matching the page-mount views.
    assert _api(login_only_user).get(reverse(MANIFEST_URL)).status_code == 200
    assert _api(login_only_user).get(reverse(PLACEMENTS_URL)).status_code == 200


def test_filter_by_unknown_site_is_a_400_not_a_silent_full_list(editor_user):
    # Fail-closed at the REST boundary: DRF's filter backend rejects an invalid filterset, so a
    # typo'd site slug is an error rather than every room in the facility.
    from netbox_facilitymap.models import Room
    Room.objects.create(floor_key=FLOOR, room_id='r1')

    r = _api(editor_user).get(reverse(LIST_URL), {'site': 'no-such-site'})

    assert r.status_code == 400


# ---- OpenAPI schema ----

def test_the_plugin_api_is_fully_described_in_the_openapi_schema(settings):
    """Every route here must appear in NetBox's `/api/schema/`, warning-free.

    Worth a test because the failure is silent: drf-spectacular cannot introspect an `APIView` that
    returns a whole JSON document rather than serialized model rows, and its fallback is to **drop
    the endpoint from the schema** with a warning nobody reads. `manifest/`/`placements/` carry an
    explicit `@extend_schema` for exactly this reason, and the method-backed `site`/`site_id`
    filters carry `extend_schema_field`. Generated over the plugin's own URL patterns only, so it
    stays fast and can't fail on an unrelated NetBox app."""
    from drf_spectacular.generators import SchemaGenerator
    from netbox_facilitymap.api import urls as api_urls

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter('always')
        schema = SchemaGenerator(patterns=api_urls.urlpatterns).get_schema(request=None, public=True)

    paths = set(schema['paths'])
    assert {'/rooms/', '/rooms/{id}/', '/manifest/', '/placements/'} <= paths
    assert not [str(w.message) for w in caught], 'drf-spectacular reported schema problems'
