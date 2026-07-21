"""The floor to-do list (ADDON-1) — the `RoomTodo` model and its `/api/todos` endpoints.

Covers the three things worth pinning: (1) the resync-safety contract — a `sync_rooms` resave keeps a
room's to-dos, and deleting the room cascades them away; (2) the endpoint permission model —
reads ride the map-read (login) gate, writes require `change_facilitymapblob`, and a to-do is only
addressable through a room the requester may view; and (3) the scheduling fields (TASK-1) —
`priority`/`assignees`/`notes`/`due` round-trip through both write paths and are validated at the
boundary, with an unknown assignee rejected rather than silently dropped.

The facility-wide rollup behind the to-do page (`/api/todos/all`, TASK-5) is covered separately at
the foot: it names no floor, so — unlike the per-floor read — its facility scoping (MULTI-2) is
explicit and is the thing most worth pinning.
"""

import json
from datetime import date

import pytest
from django.urls import reverse

from netbox_facilitymap import previews
from netbox_facilitymap.frontend_api import sync_rooms
from netbox_facilitymap.models import FacilityMapBlob, Room, RoomTodo

pytestmark = pytest.mark.django_db

FLOOR = 'test-site/floor-1'
TODOS = 'plugins:netbox_facilitymap:api-todos'
TODOS_ALL = 'plugins:netbox_facilitymap:api-todos-all'
TODO = 'plugins:netbox_facilitymap:api-todo'
TODO_DELETE = 'plugins:netbox_facilitymap:api-todo-delete'
TODOS_SETTING = 'plugins:netbox_facilitymap:api-settings-todos'


def _set_todos(enabled):
    """Flip the install-wide to-do feature switch (ADDON-4) in the settings blob."""
    FacilityMapBlob.objects.update_or_create(
        kind='settings', facility='', key='', defaults={'data': {'todos': enabled}})


@pytest.fixture(autouse=True)
def _todos_on():
    """ADDON-4 gates the whole to-do feature behind an install-wide switch defaulting off. Every test
    here exercises the feature, so switch it on; the OFF behaviour is pinned explicitly in the gate
    tests below, which flip it back."""
    _set_todos(True)


def _floor():
    from dcim.models import Location, Site
    site = Site.objects.create(name='Test Site', slug='test-site')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    return site, floor


def _room(site, floor, rid='r1', slug='room-101'):
    from dcim.models import Location
    loc = Location.objects.create(name=slug, slug=slug, site=site, parent=floor)
    return Room.objects.create(floor_key=FLOOR, room_id=rid, label=rid.upper(),
                               polygon=[[0, 0], [1, 0], [1, 1]], location=loc)


# ---- model / resync-safety ----

def _user(username):
    from utilities.testing import create_test_user
    return create_test_user(username)


def test_status_defaults_to_planned(editor_user):
    site, floor = _floor()
    todo = RoomTodo.objects.create(room=_room(site, floor), text='paint the wall')
    assert todo.status == 'planned'


def test_scheduling_fields_default_for_an_existing_style_row(editor_user):
    """The migration is additive: a row created the old way (text only) must come out with the
    documented backfill — `med` priority, no assignees, empty notes, no due date."""
    site, floor = _floor()
    todo = RoomTodo.objects.create(room=_room(site, floor), text='paint the wall')
    assert todo.priority == 'med'
    assert todo.notes == ''
    assert todo.due is None
    assert list(todo.assignees.all()) == []


def test_assignees_survive_a_room_resync(editor_user):
    """The M2M hangs off the same resync-stable PK the FK does — a resave must not drop it."""
    site, floor = _floor()
    room = _room(site, floor)
    todo = RoomTodo.objects.create(room=room, text='keep my assignees')
    todo.assignees.set([_user('alice'), _user('bob')])

    sync_rooms({FLOOR: [
        {'id': 'r1', 'label': 'R1', 'polygon': [[0, 0], [1, 0], [1, 1]],
         'location': {'id': room.location_id}},
    ]}, user=editor_user)

    assert todo.assignees.count() == 2


def test_deleting_an_assignee_keeps_the_todo(editor_user):
    """A user leaving drops their assignment, not the job — the to-do outlives them unassigned."""
    site, floor = _floor()
    todo = RoomTodo.objects.create(room=_room(site, floor), text='still needs doing')
    user = _user('leaver')
    todo.assignees.set([user])
    user.delete()
    todo.refresh_from_db()
    assert list(todo.assignees.all()) == []


def test_todos_survive_a_room_resync(editor_user):
    """The headline resync-safety contract: `sync_rooms` upserts the room in place, so its PK — and
    thus the to-do FK — is stable across a resave. A room's to-dos must not be wiped by re-saving
    the floor."""
    site, floor = _floor()
    room = _room(site, floor)
    RoomTodo.objects.create(room=room, text='keep me')

    # Re-save the floor with the same room present (an ordinary editor save).
    sync_rooms({FLOOR: [
        {'id': 'r1', 'label': 'R1', 'polygon': [[0, 0], [1, 0], [1, 1]],
         'location': {'id': room.location_id}},
    ]}, user=editor_user)

    assert Room.objects.filter(room_id='r1').count() == 1
    assert RoomTodo.objects.filter(text='keep me').exists()


def test_deleting_a_room_cascades_its_todos(editor_user):
    site, floor = _floor()
    room = _room(site, floor)
    RoomTodo.objects.create(room=room, text='goes with the room')

    # The room is dropped from the floor document → sync_rooms deletes it → CASCADE removes to-dos.
    sync_rooms({FLOOR: []}, user=editor_user)

    assert not Room.objects.filter(room_id='r1').exists()
    assert not RoomTodo.objects.filter(text='goes with the room').exists()


# ---- endpoints: reads ----

def test_get_lists_todos_grouped_by_room(client, editor_user):
    site, floor = _floor()
    room = _room(site, floor)
    RoomTodo.objects.create(room=room, text='a', status='planned')
    RoomTodo.objects.create(room=room, text='b', status='completed')

    client.force_login(editor_user)
    r = client.get(reverse(TODOS), {'floor_key': FLOOR})
    assert r.status_code == 200
    data = r.json()
    assert set(t['text'] for t in data['r1']) == {'a', 'b'}


def test_get_requires_floor_key(client, editor_user):
    client.force_login(editor_user)
    assert client.get(reverse(TODOS)).status_code == 400


def test_login_only_user_may_read(client, login_only_user):
    """Reads ride the default login-only map-read gate — a bare authenticated user can see to-dos."""
    site, floor = _floor()
    RoomTodo.objects.create(room=_room(site, floor), text='visible')
    client.force_login(login_only_user)
    assert client.get(reverse(TODOS), {'floor_key': FLOOR}).status_code == 200


# ---- endpoints: the facility-wide rollup (TASK-5) ----
# The read behind the to-do page. Unlike the per-floor GET — where a `floor_key` already names
# exactly one facility — this one names no floor, so MULTI-2 scoping is its own responsibility and
# is what these tests mostly pin.

def _facility_floor(site_slug, floor_slug='floor-1', group=None):
    """A site (optionally in a SiteGroup = a facility) with one floor Location, plus one bound,
    drawn room carrying a to-do. Returns the room's `floor_key`."""
    from dcim.models import Location, Site
    site = Site.objects.create(name=site_slug, slug=site_slug, group=group)
    floor = Location.objects.create(name='Floor 1', slug=floor_slug, site=site)
    loc = Location.objects.create(name=site_slug + '-101', slug=site_slug + '-101',
                                  site=site, parent=floor)
    key = '%s/%s' % (site_slug, floor_slug)
    room = Room.objects.create(floor_key=key, room_id='r1', label='R1',
                               polygon=[[0, 0], [1, 0], [1, 1]], location=loc,
                               floor_location=floor)
    return key, room


def test_all_groups_todos_by_floor_then_room(client, editor_user):
    key, room = _facility_floor('site-a')
    RoomTodo.objects.create(room=room, text='a', status='planned')
    RoomTodo.objects.create(room=room, text='b', status='completed')

    client.force_login(editor_user)
    r = client.get(reverse(TODOS_ALL))
    assert r.status_code == 200
    # Nested floor_key -> room_id -> [todo]: `room_id` is unique only within a floor, which is why
    # the rollup can't use the per-floor endpoint's flat shape.
    assert set(t['text'] for t in r.json()[key]['r1']) == {'a', 'b'}


def test_all_spans_every_floor_and_building(client, editor_user):
    """The whole point of the rollup: one read covers floors the per-floor GET would need N of."""
    key_a, room_a = _facility_floor('site-a')
    key_b, room_b = _facility_floor('site-b')
    RoomTodo.objects.create(room=room_a, text='on a')
    RoomTodo.objects.create(room=room_b, text='on b')

    client.force_login(editor_user)
    data = client.get(reverse(TODOS_ALL)).json()
    assert data[key_a]['r1'][0]['text'] == 'on a'
    assert data[key_b]['r1'][0]['text'] == 'on b'


def test_all_does_not_leak_another_facilitys_todos(client, editor_user):
    """MULTI-2: a facility-B read must never surface facility-A's work. `Room` has no facility
    column, so the scope is derived from each floor's site — the one thing that could regress
    silently here."""
    from dcim.models import SiteGroup
    west = SiteGroup.objects.create(name='west', slug='west')
    east = SiteGroup.objects.create(name='east', slug='east')
    key_w, room_w = _facility_floor('site-w', group=west)
    key_e, room_e = _facility_floor('site-e', group=east)
    RoomTodo.objects.create(room=room_w, text='western work')
    RoomTodo.objects.create(room=room_e, text='eastern work')

    client.force_login(editor_user)
    data = client.get(reverse(TODOS_ALL), {'facility': 'west'}).json()
    assert list(data) == [key_w]
    assert data[key_w]['r1'][0]['text'] == 'western work'
    assert key_e not in data


def test_all_scopes_to_rooms_the_user_may_view(client, login_only_user):
    """A to-do is addressable only through a room the requester may view — the rollup must keep
    that scope, not widen it because it queries across floors."""
    from netbox_facilitymap.models import FacilityMapBlob
    from tests.conftest import grant
    key, room = _facility_floor('site-a')
    RoomTodo.objects.create(room=room, text='hidden')
    # Map-read access, but an object permission that matches no room.
    grant(login_only_user, FacilityMapBlob, ['view'])
    grant(login_only_user, Room, ['view'], constraints={'room_id': 'nope'})

    client.force_login(login_only_user)
    assert client.get(reverse(TODOS_ALL)).json() == {}


def test_all_rejects_a_malformed_facility(client, editor_user):
    client.force_login(editor_user)
    assert client.get(reverse(TODOS_ALL), {'facility': '../etc'}).status_code == 400


def test_all_is_empty_for_a_facility_with_no_sites(client, editor_user):
    """A facility whose Sites aren't bound yet owns no floors, so it owns no to-dos. Empty, not an
    error — an install mid-import legitimately looks like this."""
    _facility_floor('site-a')
    client.force_login(editor_user)
    r = client.get(reverse(TODOS_ALL), {'facility': 'nothing-here'})
    assert r.status_code == 200
    assert r.json() == {}


def test_all_login_only_user_passes_the_map_read_gate(client, login_only_user):
    """Rides the default login-only map-read gate, exactly like the per-floor read: a bare
    authenticated user is let in (not 403). What they then *see* is a separate question — the rooms
    stay `restrict(user, 'view')`-scoped, which the two tests either side of this one pin."""
    key, room = _facility_floor('site-a')
    RoomTodo.objects.create(room=room, text='visible')
    client.force_login(login_only_user)
    assert client.get(reverse(TODOS_ALL)).status_code == 200


def test_all_shows_todos_of_rooms_the_user_may_view(client, viewer_user):
    """The other half of the scope: a viewer whose object permission *does* match the room sees its
    to-dos. Without this, `test_all_scopes_to_rooms_the_user_may_view` would also pass on an
    endpoint that returned nothing to anyone."""
    from tests.conftest import grant
    key, room = _facility_floor('site-a')
    RoomTodo.objects.create(room=room, text='visible')
    grant(viewer_user, Room, ['view'])

    client.force_login(viewer_user)
    assert client.get(reverse(TODOS_ALL)).json()[key]['r1'][0]['text'] == 'visible'


# ---- endpoints: writes ----

def _post_json(client, name, body, **kw):
    return client.post(reverse(name, **kw), json.dumps(body), content_type='application/json')


def test_create_todo(client, editor_user):
    site, floor = _floor()
    _room(site, floor)
    client.force_login(editor_user)
    r = _post_json(client, TODOS, {'floor_key': FLOOR, 'room_id': 'r1', 'text': 'do a thing'})
    assert r.status_code == 201
    assert r.json()['text'] == 'do a thing'
    assert RoomTodo.objects.filter(text='do a thing', room__room_id='r1').exists()


def test_create_with_all_scheduling_fields(client, editor_user):
    site, floor = _floor()
    _room(site, floor)
    alice, bob = _user('alice'), _user('bob')
    client.force_login(editor_user)
    r = _post_json(client, TODOS, {
        'floor_key': FLOOR, 'room_id': 'r1', 'text': 'recable the rack',
        'priority': 'high', 'notes': 'bring the long patch leads', 'due': '2026-08-01',
        'assignees': [alice.pk, bob.pk],
    })
    assert r.status_code == 201
    body = r.json()
    assert body['priority'] == 'high'
    assert body['notes'] == 'bring the long patch leads'
    assert body['due'] == '2026-08-01'
    assert {a['username'] for a in body['assignees']} == {'alice', 'bob'}

    todo = RoomTodo.objects.get(text='recable the rack')
    assert todo.priority == 'high'
    assert todo.due.isoformat() == '2026-08-01'
    assert todo.assignees.count() == 2


def test_create_defaults_priority_when_omitted(client, editor_user):
    site, floor = _floor()
    _room(site, floor)
    client.force_login(editor_user)
    r = _post_json(client, TODOS, {'floor_key': FLOOR, 'room_id': 'r1', 'text': 'x'})
    assert r.json()['priority'] == 'med'
    assert r.json()['assignees'] == []
    assert r.json()['due'] is None


def test_create_rejects_invalid_priority(client, editor_user):
    site, floor = _floor()
    _room(site, floor)
    client.force_login(editor_user)
    r = _post_json(client, TODOS, {'floor_key': FLOOR, 'room_id': 'r1', 'text': 'x',
                                   'priority': 'urgent'})
    assert r.status_code == 400
    assert not RoomTodo.objects.exists()


def test_create_rejects_unknown_room(client, editor_user):
    _floor()  # floor exists but no room r1
    client.force_login(editor_user)
    r = _post_json(client, TODOS, {'floor_key': FLOOR, 'room_id': 'nope', 'text': 'x'})
    assert r.status_code == 400


def test_create_rejects_blank_text(client, editor_user):
    site, floor = _floor()
    _room(site, floor)
    client.force_login(editor_user)
    r = _post_json(client, TODOS, {'floor_key': FLOOR, 'room_id': 'r1', 'text': '   '})
    assert r.status_code == 400


def test_write_requires_edit_permission(client, login_only_user):
    """A bare authenticated user can read but not write — POST is gated on change_facilitymapblob."""
    site, floor = _floor()
    _room(site, floor)
    client.force_login(login_only_user)
    r = _post_json(client, TODOS, {'floor_key': FLOOR, 'room_id': 'r1', 'text': 'nope'})
    assert r.status_code == 403
    assert not RoomTodo.objects.exists()


def test_update_status(client, editor_user):
    site, floor = _floor()
    todo = RoomTodo.objects.create(room=_room(site, floor), text='t')
    client.force_login(editor_user)
    r = _post_json(client, TODO, {'status': 'in_progress'}, kwargs={'pk': todo.pk})
    assert r.status_code == 200
    assert r.json()['status'] == 'in_progress'
    todo.refresh_from_db()
    assert todo.status == 'in_progress'


def test_update_scheduling_fields(client, editor_user):
    site, floor = _floor()
    todo = RoomTodo.objects.create(room=_room(site, floor), text='t')
    client.force_login(editor_user)
    r = _post_json(client, TODO, {'priority': 'low', 'notes': 'n', 'due': '2026-09-30'},
                   kwargs={'pk': todo.pk})
    assert r.status_code == 200
    todo.refresh_from_db()
    assert (todo.priority, todo.notes, todo.due.isoformat()) == ('low', 'n', '2026-09-30')


def test_update_reassigns(client, editor_user):
    """`assignees` replaces the set wholesale — the picker posts the full list it wants."""
    site, floor = _floor()
    todo = RoomTodo.objects.create(room=_room(site, floor), text='t')
    alice, bob = _user('alice'), _user('bob')
    todo.assignees.set([alice])
    client.force_login(editor_user)
    r = _post_json(client, TODO, {'assignees': [bob.pk]}, kwargs={'pk': todo.pk})
    assert r.status_code == 200
    assert [a['username'] for a in r.json()['assignees']] == ['bob']
    assert list(todo.assignees.values_list('username', flat=True)) == ['bob']


def test_update_can_clear_assignees_and_due(client, editor_user):
    site, floor = _floor()
    todo = RoomTodo.objects.create(room=_room(site, floor), text='t', due=date(2026, 1, 1))
    todo.assignees.set([_user('alice')])
    client.force_login(editor_user)
    r = _post_json(client, TODO, {'assignees': [], 'due': None}, kwargs={'pk': todo.pk})
    assert r.status_code == 200
    assert r.json()['due'] is None
    todo.refresh_from_db()
    assert todo.due is None
    assert list(todo.assignees.all()) == []


def test_update_leaves_omitted_fields_alone(client, editor_user):
    """Every scheduling field is optional — a status-only POST must not wipe the rest."""
    site, floor = _floor()
    todo = RoomTodo.objects.create(room=_room(site, floor), text='t', priority='high',
                                   notes='keep me', due=date(2026, 1, 1))
    todo.assignees.set([_user('alice')])
    client.force_login(editor_user)
    r = _post_json(client, TODO, {'status': 'completed'}, kwargs={'pk': todo.pk})
    assert r.status_code == 200
    todo.refresh_from_db()
    assert (todo.priority, todo.notes, todo.due.isoformat()) == ('high', 'keep me', '2026-01-01')
    assert todo.assignees.count() == 1


def test_update_rejects_invalid_due(client, editor_user):
    site, floor = _floor()
    todo = RoomTodo.objects.create(room=_room(site, floor), text='t')
    client.force_login(editor_user)
    r = _post_json(client, TODO, {'due': 'next tuesday'}, kwargs={'pk': todo.pk})
    assert r.status_code == 400
    todo.refresh_from_db()
    assert todo.due is None


def test_update_rejects_unknown_assignee(client, editor_user):
    """An id that isn't a real active user is a hard 400 — never a silent drop."""
    site, floor = _floor()
    todo = RoomTodo.objects.create(room=_room(site, floor), text='t')
    alice = _user('alice')
    client.force_login(editor_user)
    r = _post_json(client, TODO, {'assignees': [alice.pk, 999999]}, kwargs={'pk': todo.pk})
    assert r.status_code == 400
    assert list(todo.assignees.all()) == []


def test_update_rejects_inactive_assignee(client, editor_user):
    site, floor = _floor()
    todo = RoomTodo.objects.create(room=_room(site, floor), text='t')
    gone = _user('gone')
    gone.is_active = False
    gone.save()
    client.force_login(editor_user)
    r = _post_json(client, TODO, {'assignees': [gone.pk]}, kwargs={'pk': todo.pk})
    assert r.status_code == 400


def test_update_rejects_malformed_assignees(client, editor_user):
    site, floor = _floor()
    todo = RoomTodo.objects.create(room=_room(site, floor), text='t')
    client.force_login(editor_user)
    assert _post_json(client, TODO, {'assignees': 'alice'},
                      kwargs={'pk': todo.pk}).status_code == 400
    assert _post_json(client, TODO, {'assignees': [{'id': 1}]},
                      kwargs={'pk': todo.pk}).status_code == 400


def test_write_rejects_a_non_object_body(client, editor_user):
    """A JSON body that isn't an object is a 400, not a 500 — the views index into it by key."""
    site, floor = _floor()
    todo = RoomTodo.objects.create(room=_room(site, floor), text='t')
    client.force_login(editor_user)
    assert _post_json(client, TODOS, ['not', 'an', 'object']).status_code == 400
    assert _post_json(client, TODO, ['nope'], kwargs={'pk': todo.pk}).status_code == 400


def test_update_rejects_invalid_status(client, editor_user):
    site, floor = _floor()
    todo = RoomTodo.objects.create(room=_room(site, floor), text='t')
    client.force_login(editor_user)
    r = _post_json(client, TODO, {'status': 'bogus'}, kwargs={'pk': todo.pk})
    assert r.status_code == 400


def test_update_requires_edit_permission(client, login_only_user):
    site, floor = _floor()
    todo = RoomTodo.objects.create(room=_room(site, floor), text='t')
    client.force_login(login_only_user)
    r = _post_json(client, TODO, {'status': 'completed'}, kwargs={'pk': todo.pk})
    assert r.status_code == 403


def test_delete_clears_a_todo(client, editor_user):
    site, floor = _floor()
    todo = RoomTodo.objects.create(room=_room(site, floor), text='t', status='completed')
    client.force_login(editor_user)
    r = _post_json(client, TODO_DELETE, {}, kwargs={'pk': todo.pk})
    assert r.status_code == 200
    assert not RoomTodo.objects.filter(pk=todo.pk).exists()


def test_delete_requires_edit_permission(client, login_only_user):
    site, floor = _floor()
    todo = RoomTodo.objects.create(room=_room(site, floor), text='t')
    client.force_login(login_only_user)
    r = _post_json(client, TODO_DELETE, {}, kwargs={'pk': todo.pk})
    assert r.status_code == 403
    assert RoomTodo.objects.filter(pk=todo.pk).exists()


# ---- ADDON-4: the whole feature gated behind an install-wide switch, default off ----
# The four data endpoints refuse loudly (404) when the to-do add-on is switched off, ahead of the
# read/write gate — the server-side half of the feature gate whose UX mirror hides the pages, the
# floor panel, and the compose icon. The `_todos_on` autouse fixture turns it on for every other
# test here; these flip it back off.

def test_endpoints_404_when_the_feature_is_off(client, editor_user):
    """Every `api/todos*` view 404s while the add-on is off — reads and writes alike, since the gate
    runs in `dispatch` ahead of the read gate and the `EDIT_PERM` check."""
    site, floor = _floor()
    todo = RoomTodo.objects.create(room=_room(site, floor), text='t')
    _set_todos(False)
    client.force_login(editor_user)

    assert client.get(reverse(TODOS), {'floor_key': FLOOR}).status_code == 404
    assert client.get(reverse(TODOS_ALL)).status_code == 404
    assert _post_json(client, TODOS,
                      {'floor_key': FLOOR, 'room_id': 'r1', 'text': 'x'}).status_code == 404
    assert _post_json(client, TODO, {'status': 'completed'},
                      kwargs={'pk': todo.pk}).status_code == 404
    assert _post_json(client, TODO_DELETE, {}, kwargs={'pk': todo.pk}).status_code == 404
    # The write attempts left the data untouched — the gate refused before any mutation.
    assert RoomTodo.objects.filter(pk=todo.pk, text='t').exists()


def test_endpoints_reachable_again_when_switched_on(client, editor_user):
    """The gate is the *only* thing off state changes: flip it on and the endpoints work again. Pins
    that the 404 above is the switch, not a broken route."""
    site, floor = _floor()
    _room(site, floor)
    _set_todos(False)
    client.force_login(editor_user)
    assert client.get(reverse(TODOS), {'floor_key': FLOOR}).status_code == 404
    _set_todos(True)
    assert client.get(reverse(TODOS), {'floor_key': FLOOR}).status_code == 200


# ---- ADDON-4: the settings endpoint that flips the switch (admin-tier, like its ap_tool sibling) --

def test_todos_setting_persists_to_settings_blob(client, editor_user):
    client.force_login(editor_user)
    r = _post_json(client, TODOS_SETTING, {'todos': False})
    assert r.status_code == 200 and r.json() == {'ok': True, 'todos': False}
    assert previews.todos_enabled() is False

    r = _post_json(client, TODOS_SETTING, {'todos': True})
    assert r.status_code == 200 and previews.todos_enabled() is True


def test_todos_setting_requires_import_permission(client, plain_user):
    """Admin-tier configuration (PERM-1): plain_user holds change_facilitymapblob but not
    import_facilitymapblob, so the flip is forbidden and the stored value is left as it was."""
    client.force_login(plain_user)
    assert _post_json(client, TODOS_SETTING, {'todos': False}).status_code == 403
    assert previews.todos_enabled() is True   # unchanged from the autouse fixture
