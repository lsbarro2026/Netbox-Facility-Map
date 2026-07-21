"""The active-user lookup (`UsersView`, TASK-2) — backs the to-do assignee picker.

Covers: the read gate is the map-read gate (login-only), not `EDIT_PERM`, since a viewer must be
able to render existing to-dos' assignee avatars; inactive users are excluded; `?q=` substring-
filters username/first/last name; and the serialized shape carries the `initials` the avatar chip
needs.
"""

import pytest
from django.urls import reverse

pytestmark = pytest.mark.django_db

USERS = 'plugins:netbox_facilitymap:api-users'


def _user(username, first_name='', last_name='', is_active=True):
    from utilities.testing import create_test_user

    user = create_test_user(username)
    user.first_name = first_name
    user.last_name = last_name
    user.is_active = is_active
    user.save()
    return user


def test_lists_active_users(client, editor_user):
    _user('alice')
    _user('bob')
    client.force_login(editor_user)
    r = client.get(reverse(USERS))
    assert r.status_code == 200
    usernames = {u['username'] for u in r.json()['users']}
    assert {'alice', 'bob'} <= usernames


def test_excludes_inactive_users(client, editor_user):
    _user('gone', is_active=False)
    client.force_login(editor_user)
    r = client.get(reverse(USERS))
    assert 'gone' not in {u['username'] for u in r.json()['users']}


def test_serialized_shape(client, editor_user):
    _user('alice', first_name='Alice', last_name='Anderson')
    client.force_login(editor_user)
    r = client.get(reverse(USERS))
    alice = next(u for u in r.json()['users'] if u['username'] == 'alice')
    assert alice == {'id': alice['id'], 'username': 'alice', 'display': 'Alice Anderson',
                      'initials': 'AA'}


def test_initials_fall_back_to_username_when_no_full_name(client, editor_user):
    _user('carol')
    client.force_login(editor_user)
    r = client.get(reverse(USERS))
    carol = next(u for u in r.json()['users'] if u['username'] == 'carol')
    assert carol['display'] == 'carol'
    assert carol['initials'] == 'CA'


def test_q_filters_by_username(client, editor_user):
    _user('alice')
    _user('bob')
    client.force_login(editor_user)
    r = client.get(reverse(USERS), {'q': 'ali'})
    assert {u['username'] for u in r.json()['users']} == {'alice'}


def test_q_filters_by_first_and_last_name(client, editor_user):
    _user('u1', first_name='Alice', last_name='Zephyr')
    _user('u2', first_name='Zed', last_name='Anderson')
    _user('u3', first_name='Nobody', last_name='Nowhere')
    client.force_login(editor_user)
    r = client.get(reverse(USERS), {'q': 'and'})
    assert {u['username'] for u in r.json()['users']} == {'u2'}


def test_q_is_case_insensitive(client, editor_user):
    _user('alice')
    client.force_login(editor_user)
    r = client.get(reverse(USERS), {'q': 'ALI'})
    assert {u['username'] for u in r.json()['users']} == {'alice'}


def test_login_only_user_may_read(client, login_only_user):
    """The gate is map-read (login-only), not EDIT_PERM — a bare authenticated user can see the
    roster to render assignee avatars, matching TodosView's read gate."""
    _user('alice')
    client.force_login(login_only_user)
    assert client.get(reverse(USERS)).status_code == 200


def test_anonymous_is_redirected(client):
    _user('alice')
    r = client.get(reverse(USERS))
    assert r.status_code == 302
