"""Device-placement tool configuration (DEV-3, generalized into device-type presets by DEV-8).

The feature's install-wide settings — its own on/off switch and the device-type preset list —
plus the role-listing read that backs the preset editor's role picker, plus the DEV-5 write-path
endpoints (name suggestion + Device create) that consume a preset.

Four things carry the weight here:
  * every setting merges into the ONE install-wide settings blob without clobbering its siblings
    (MULTI-1 + AUDIT-1's before/after diff depend on it);
  * values are validated/clamped SERVER-side — the Settings page is UX only;
  * a name template is the one setting that RAISES rather than clamps, because there is no sensible
    "nearest valid value" for a typo'd placeholder (see `previews.clean_device_name_template`);
  * an install configured with the legacy per-AP keys keeps working with no manual step — the
    read path seeds an "Access point" preset from them (DEV-8 back-compat).
"""

import json

import pytest
from django.urls import reverse
from django.utils.text import slugify

from netbox_facilitymap import previews
from netbox_facilitymap.models import FacilityMapBlob

from conftest import grant

DEVICE_TOOL = 'plugins:netbox_facilitymap:api-settings-device-tool'
DEVICE_PRESETS = 'plugins:netbox_facilitymap:api-settings-device-presets'
DEVICE_ROLES = 'plugins:netbox_facilitymap:api-nb-device-roles'


def _post(client, route, payload):
    return client.post(reverse(route), data=json.dumps(payload),
                       content_type='application/json')


def _settings():
    return FacilityMapBlob.objects.get(kind='settings', facility='', key='').data


def _role(name='Access Point', slug='access-point'):
    from dcim.models import DeviceRole
    return DeviceRole.objects.create(name=name, slug=slug)


def _may_see_roles(user):
    """Grant `user` an unconstrained DeviceRole `view`. The map's own fixtures grant only
    FacilityMapBlob/Room, and every DeviceRole surface here is object-permission scoped — so a test
    about anything *other* than that scoping has to opt in, or it just re-proves the scoping."""
    from dcim.models import DeviceRole
    return grant(user, DeviceRole, ['view'])


def _preset(role=None, key='ap', label='Access point', icon='ap',
            template='{room}-{role_short}', scope='none', enabled=True, fields=None):
    """One preset dict in the stored shape, defaulted to the classic AP configuration."""
    return {'key': key, 'label': label, 'device_role': role.pk if role else None, 'icon': icon,
            'name_template': template, 'count_scope': scope, 'enabled': enabled,
            'fields': fields if fields is not None else ['name', 'device_type', 'asset_tag']}


# --- previews.py resolvers/clamps: enum-safe on read, so a blob written outside the Settings page
# (admin/REST/fixture) can never break a page render. -----------------------------------------


@pytest.mark.parametrize('value,expected', [
    ('none', 'none'), ('room', 'room'), ('floor', 'floor'), ('building', 'building'),
    ('site', 'site'), ('bogus', 'none'), (None, 'none'), ('', 'none'), (7, 'none'),
])
def test_clamp_device_count_scope(value, expected):
    assert previews.clamp_device_count_scope(value) == expected


@pytest.mark.parametrize('value,expected', [
    (3, 3), ('3', 3),          # a JSON blob may hold either
    (None, None), ('', None), ('abc', None),
    (0, None), (-1, None),     # not a usable pk
])
def test_clamp_device_role(value, expected):
    assert previews.clamp_device_role(value) == expected


def test_clean_device_name_template_accepts_known_placeholders():
    assert previews.clean_device_name_template('{room}-{role_short}') == '{room}-{role_short}'
    assert previews.clean_device_name_template('  AP-{room}  ') == 'AP-{room}'   # stripped
    assert previews.clean_device_name_template('no-placeholders-at-all') == 'no-placeholders-at-all'


def test_clean_device_name_template_empty_resets_to_default():
    # An empty template is a reset, not an error — the field can be cleared.
    assert previews.clean_device_name_template('') == previews.DEVICE_NAME_TEMPLATE_DEFAULT
    assert previews.clean_device_name_template(None) == previews.DEVICE_NAME_TEMPLATE_DEFAULT


def test_clean_device_name_template_rejects_unknown_placeholder():
    # The headline: a typo'd/unsupported token must NOT slip through as a literal and quietly land
    # in every device name. {rack} is the specific one an operator might reach for — placed devices
    # are never racked, so it will never be supported.
    with pytest.raises(ValueError) as e:
        previews.clean_device_name_template('{room}-{rack}')
    assert '{rack}' in str(e.value)
    with pytest.raises(ValueError):
        previews.clean_device_name_template('{count}')   # the counter is a scope dropdown, not a token


def test_clean_device_name_template_accepts_asset_tag():
    # DEV-6's third placeholder. Being in DEVICE_NAME_PLACEHOLDERS is what stops the save path
    # 400ing on a template that uses it.
    assert previews.clean_device_name_template(
        '{room}-{role_short}-{asset_tag}') == '{room}-{role_short}-{asset_tag}'


def test_clean_device_name_template_accepts_room_slug():
    # UX-2's fourth placeholder — the room Location's native slug, distinct from {room}'s name.
    assert previews.clean_device_name_template(
        '{room_slug}-{role_short}') == '{room_slug}-{role_short}'


def test_expand_device_name_template_expands_all_four():
    assert previews.expand_device_name_template(
        '{room}-{room_slug}-{role_short}-{asset_tag}', 'Room 101', 'room-101', 'AP',
        'TRI-9931') == 'Room 101-room-101-AP-TRI-9931'


def test_expand_device_name_template_room_slug_is_distinct_from_room():
    # {room} is not a substring of {room_slug} (the braces differ), but assert both expand to their
    # own value in one template rather than one clobbering the other via naive replace ordering.
    assert previews.expand_device_name_template(
        '{room}/{room_slug}', 'Room 101', 'room-101', 'AP') == 'Room 101/room-101'


@pytest.mark.parametrize('template, expected', [
    ('{room}-{role_short}-{asset_tag}', 'Room 101-AP'),   # trailing: takes the separator BEFORE it
    ('{asset_tag}-{room}-{role_short}', 'Room 101-AP'),   # leading: falls back to the one AFTER it
    ('{room}_{asset_tag}_{role_short}', 'Room 101_AP'),   # mid-template: exactly one `_` survives
    ('{room}.{asset_tag}', 'Room 101'),
    ('{room} {asset_tag}', 'Room 101'),
])
def test_expand_device_name_template_blank_tag_drops_token_and_one_separator(template, expected):
    # The headline of DEV-6's blank rule: asset_tag is optional, so a template that names it must
    # still yield a clean name when it's left empty — never `Room 101-AP--01`.
    assert previews.expand_device_name_template(
        template, 'Room 101', 'room-101', 'AP', '') == expected
    # None and whitespace are the same "no tag" as '' — the browser sends a raw field value.
    assert previews.expand_device_name_template(
        template, 'Room 101', 'room-101', 'AP', None) == expected
    assert previews.expand_device_name_template(
        template, 'Room 101', 'room-101', 'AP', '  ') == expected


def test_expand_device_name_template_does_not_re_expand_a_tag_value():
    # The tag is operator-typed text, not a template: a tag that happens to read `{room}` must land
    # as those literal characters. This is why `{asset_tag}` is substituted last.
    assert previews.expand_device_name_template(
        '{room}-{asset_tag}', 'Room 101', 'room-101', 'AP', '{room}') == 'Room 101-{room}'


def test_clean_device_name_template_rejects_unbalanced_braces():
    with pytest.raises(ValueError):
        previews.clean_device_name_template('{room-{role_short}')


def test_clean_device_name_template_rejects_over_long():
    # Longer than dcim.Device.name allows can only ever expand to a name full_clean() rejects.
    with pytest.raises(ValueError):
        previews.clean_device_name_template('x' * (previews.DEVICE_NAME_TEMPLATE_MAX + 1))


def test_device_tool_enabled_defaults_false(db):
    # No blob at all, then a blob with neither device_tool nor ap_tool — both read False
    # (back-compatible with a pre-DEV-3 settings blob, exactly like room_embed_* were).
    assert previews.device_tool_enabled() is False
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={'write_mode': True})
    assert previews.device_tool_enabled() is False


def test_device_tool_falls_back_to_the_legacy_ap_tool_key(db):
    # DEV-8 back-compat: an install that switched the AP tool on before presets existed keeps its
    # switch state; an explicit device_tool value wins over the legacy key once written.
    blob = FacilityMapBlob.objects.create(
        kind='settings', facility='', key='', data={'ap_tool': True})
    assert previews.device_tool_enabled() is True
    blob.data = {'ap_tool': True, 'device_tool': False}
    blob.save(update_fields=['data'])
    assert previews.device_tool_enabled() is False


# --- The preset read path: clamps + the legacy-AP seeding (DEV-8 back-compat). -------------------


def test_device_presets_default_empty(db):
    assert previews.device_presets() == []
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={'write_mode': True})
    assert previews.device_presets() == []


def test_device_presets_seed_from_legacy_ap_settings(db):
    # An install configured with the pre-DEV-8 AP keys and no device_presets list reads ONE seeded
    # "Access point" preset — stable key, the ap icon, today's dialog fields — with the legacy
    # template/scope carried over. Read-only: the legacy keys are never rewritten.
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={
        'ap_tool': True, 'ap_device_role': 7,
        'ap_name_template': 'AP-{room}', 'ap_count_scope': 'floor',
    })
    assert previews.device_presets() == [{
        'key': 'access-point', 'label': 'Access point', 'device_role': 7, 'icon': 'ap',
        'name_template': 'AP-{room}', 'count_scope': 'floor', 'enabled': True,
        'fields': ['name', 'device_type', 'asset_tag'],
    }]
    assert 'device_presets' not in _settings()   # seeding never writes back


def test_device_presets_no_seed_without_a_legacy_role(db):
    # The legacy tool was unusable without a role, so there is nothing worth seeding.
    FacilityMapBlob.objects.create(kind='settings', facility='', key='',
                                   data={'ap_tool': True, 'ap_name_template': 'AP-{room}'})
    assert previews.device_presets() == []


def test_device_presets_stored_list_wins_over_the_legacy_keys(db):
    # Once a real list exists — even an explicitly empty one — the legacy keys are ignored: an
    # empty list is a CHOICE, not an unset.
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={
        'ap_device_role': 7, 'device_presets': [],
    })
    assert previews.device_presets() == []


def test_device_presets_clamp_a_hand_edited_blob(db):
    # Written outside the Settings page (admin/REST/fixture), so it never went through the POST
    # validation. Every value must still resolve to something usable rather than raise mid-render:
    # unknown icon → generic, bad template → default, bogus scope → none, fields re-clamped with
    # the required ones forced in, keyless/non-dict entries and duplicate keys dropped.
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={'device_presets': [
        {'key': 'p-1', 'label': 'Speakers', 'device_role': 'nonsense', 'icon': 'no-such-icon',
         'name_template': '{bogus}', 'count_scope': 'galaxy', 'fields': ['asset_tag', 'bogus']},
        {'label': 'no key — dropped'},
        'not-a-dict',
        {'key': 'p-1', 'label': 'duplicate key — dropped'},
    ]})
    assert previews.device_presets() == [{
        'key': 'p-1', 'label': 'Speakers', 'device_role': None, 'icon': 'generic',
        'name_template': previews.DEVICE_NAME_TEMPLATE_DEFAULT, 'count_scope': 'none',
        'enabled': True, 'fields': ['name', 'device_type', 'asset_tag'],
    }]


def test_device_presets_clamp_never_yields_a_rack_icon(db):
    # The rack is a known glyph type but not a placeable device icon — a hand-edited blob naming
    # it reads back as generic, so the tool can never mint rack-glyphed devices.
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={'device_presets': [
        {'key': 'p-1', 'label': 'Cabinet', 'icon': 'rack'},
    ]})
    assert previews.device_presets()[0]['icon'] == 'generic'


def test_clean_device_presets_assigns_keys_and_canonicalizes():
    out = previews.clean_device_presets([
        {'label': 'PA speaker', 'icon': 'speaker', 'device_role': 3,
         'fields': ['asset_tag', 'serial']},
    ])
    assert len(out) == 1
    p = out[0]
    assert p['key'].startswith('p-') and len(p['key']) == 10   # server-minted, stable
    assert p['label'] == 'PA speaker' and p['icon'] == 'speaker' and p['device_role'] == 3
    # Canonical field order, with the required name/device_type forced in.
    assert p['fields'] == ['name', 'device_type', 'asset_tag', 'serial']
    assert p['enabled'] is True and p['count_scope'] == 'none'
    assert p['name_template'] == previews.DEVICE_NAME_TEMPLATE_DEFAULT


def test_clean_device_presets_keeps_an_existing_key():
    out = previews.clean_device_presets([_preset(key='access-point')])
    assert out[0]['key'] == 'access-point'


@pytest.mark.parametrize('bad,message', [
    ('not-a-list', 'must be a list'),
    ([{'icon': 'speaker'}], 'needs a label'),
    ([{'label': 'X', 'icon': 'no-such-icon'}], 'unknown icon'),
    ([{'label': 'X', 'icon': 'rack'}], 'unknown icon'),   # rack is never pickable
    ([{'label': 'X', 'icon': 'speaker', 'fields': ['bogus']}], 'unknown field'),
    ([{'label': 'X', 'icon': 'speaker', 'name_template': '{rack}'}], '{rack}'),
    ([{'label': 'X', 'icon': 'speaker', 'key': 'bad key!'}], 'malformed key'),
    ([{'label': 'X', 'icon': 'speaker', 'key': 'k'}, {'label': 'Y', 'icon': 'mic', 'key': 'k'}],
     'duplicate'),
    ([{'label': 'X', 'icon': 'speaker', 'device_role': 'abc'}], 'numeric'),
])
def test_clean_device_presets_rejects_bad_input(bad, message):
    with pytest.raises(ValueError) as e:
        previews.clean_device_presets(bad)
    assert message in str(e.value)


def test_clean_device_presets_rejects_too_many():
    many = [{'label': 'P%d' % i, 'icon': 'speaker'} for i in range(previews.DEVICE_PRESETS_MAX + 1)]
    with pytest.raises(ValueError):
        previews.clean_device_presets(many)


# --- The settings endpoints: admin-tier (IMPORT_PERM), merged into the single install-wide blob. --


def test_device_settings_require_import_permission(client, plain_user):
    # plain_user holds change_facilitymapblob but NOT import_facilitymapblob (PERM-1): these are
    # admin-tier configuration, gated a tier above an ordinary map write.
    client.force_login(plain_user)
    assert _post(client, DEVICE_TOOL, {'device_tool': True}).status_code == 403
    assert _post(client, DEVICE_PRESETS, {'device_presets': []}).status_code == 403
    assert not FacilityMapBlob.objects.filter(kind='settings').exists()


def test_device_tool_persists_to_settings_blob(client, editor_user):
    client.force_login(editor_user)
    r = _post(client, DEVICE_TOOL, {'device_tool': True})
    assert r.status_code == 200 and r.json() == {'ok': True, 'device_tool': True}
    assert _settings()['device_tool'] is True
    assert previews.device_tool_enabled() is True

    r = _post(client, DEVICE_TOOL, {'device_tool': False})
    assert r.status_code == 200 and _settings()['device_tool'] is False


def test_device_tool_rejects_a_non_object_body(client, editor_user):
    # A syntactically valid JSON body that isn't an object (BUG-1) is a 400, not a 500 — the shared
    # `_SettingView.post` immediately calls `.get(...)` on the decoded payload.
    client.force_login(editor_user)
    assert _post(client, DEVICE_TOOL, [1, 2, 3]).status_code == 400


def test_device_tool_is_stored_independently_of_write_mode(client, editor_user):
    # The tool switch is stored on its own terms, separately from write mode's master gate: turning
    # it on must not imply write mode, and turning write mode off later must not silently disable
    # (or forget) it — closing the gate makes an add-on inert, not unconfigured, so reopening it
    # restores what the operator had (SET-5). The UI keeps the two in step by disabling the row
    # while write mode is off; the endpoint deliberately doesn't re-litigate that, and the write
    # path re-checks both switches itself.
    client.force_login(editor_user)
    _post(client, DEVICE_TOOL, {'device_tool': True})
    assert previews.device_tool_enabled() is True
    assert previews.write_mode_enabled() is False

    _post(client, 'plugins:netbox_facilitymap:api-settings-write-mode', {'write_mode': True})
    _post(client, 'plugins:netbox_facilitymap:api-settings-write-mode', {'write_mode': False})
    assert previews.device_tool_enabled() is True


def test_device_presets_persist_and_return_the_stored_list(client, editor_user):
    role = _role()
    _may_see_roles(editor_user)
    client.force_login(editor_user)
    r = _post(client, DEVICE_PRESETS, {'device_presets': [
        {'label': 'PA speaker', 'icon': 'speaker', 'device_role': role.pk,
         'fields': ['asset_tag']},
    ]})
    assert r.status_code == 200
    stored = r.json()['device_presets']
    assert len(stored) == 1 and stored[0]['key'].startswith('p-')
    assert _settings()['device_presets'] == stored
    assert previews.device_presets() == stored


def test_device_presets_reorder_is_send_the_new_list(client, editor_user):
    role = _role()
    _may_see_roles(editor_user)
    client.force_login(editor_user)
    first = _post(client, DEVICE_PRESETS, {'device_presets': [
        _preset(role, key='a', label='A'), _preset(role, key='b', label='B', icon='speaker'),
    ]}).json()['device_presets']
    reordered = [first[1], first[0]]
    r = _post(client, DEVICE_PRESETS, {'device_presets': reordered})
    assert r.status_code == 200
    assert [p['key'] for p in _settings()['device_presets']] == ['b', 'a']


def test_device_presets_merge_preserves_siblings(client, editor_user):
    # The blob is ONE install-wide row shared with room_embed_*/facility_grouping/write_mode/…
    # (MULTI-1). Each save must merge, never overwrite — AUDIT-1's before/after diff rides on it.
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={
        'room_embed_zoom': 3.0, 'facility_grouping': 'region',
        'floor_label_field': 'slug', 'write_mode': True,
    })
    role = _role()
    _may_see_roles(editor_user)
    client.force_login(editor_user)
    _post(client, DEVICE_TOOL, {'device_tool': True})
    _post(client, DEVICE_PRESETS, {'device_presets': [_preset(role)]})

    data = _settings()
    assert data['room_embed_zoom'] == 3.0 and data['facility_grouping'] == 'region'
    assert data['floor_label_field'] == 'slug' and data['write_mode'] is True
    assert data['device_tool'] is True
    assert [p['key'] for p in data['device_presets']] == ['ap']


def test_device_presets_reject_bad_input_without_saving(client, editor_user):
    client.force_login(editor_user)
    for body in (
        {'device_presets': 'nope'},
        {'device_presets': [{'label': '', 'icon': 'speaker'}]},
        {'device_presets': [{'label': 'X', 'icon': 'no-such-icon'}]},
        {'device_presets': [{'label': 'X', 'icon': 'speaker', 'name_template': '{room}-{rack}'}]},
        {'device_presets': [{'label': 'X', 'icon': 'speaker', 'fields': ['bogus']}]},
    ):
        r = _post(client, DEVICE_PRESETS, body)
        assert r.status_code == 400 and r.json()['ok'] is False, body
    assert not FacilityMapBlob.objects.filter(kind='settings').exists()


def test_device_presets_role_must_be_visible_to_the_saver(client, editor_user):
    # editor_user's grants cover FacilityMapBlob/Room, not DeviceRole — so a role it cannot view is
    # not one it may pin, even though it clears the IMPORT_PERM gate. The picker wouldn't have
    # offered it (the listing is scoped the same way); this is the server half of that. A dangling
    # id would otherwise only surface much later, as a mystery 400 from the create path.
    role = _role()
    client.force_login(editor_user)
    r = _post(client, DEVICE_PRESETS, {'device_presets': [_preset(role)]})
    assert r.status_code == 400 and 'not found' in r.json()['error']


def test_device_presets_null_role_is_storable(client, editor_user):
    # An admin mid-configuration may save a preset with no role yet; the toolbar skips it and the
    # write paths refuse it, but the configuration itself must not be lost.
    client.force_login(editor_user)
    r = _post(client, DEVICE_PRESETS, {'device_presets': [_preset(None)]})
    assert r.status_code == 200
    assert _settings()['device_presets'][0]['device_role'] is None


def test_device_settings_reject_invalid_json(client, editor_user):
    client.force_login(editor_user)
    r = client.post(reverse(DEVICE_TOOL), data='not json', content_type='application/json')
    assert r.status_code == 400


# --- The role-listing read: object-permission scoped like its NbRacksView/NbDevicesView siblings. -


def test_device_roles_lists_and_searches(client, editor_user):
    _role('Access Point', 'access-point')
    _role('Core Switch', 'core-switch')
    _may_see_roles(editor_user)
    client.force_login(editor_user)

    roles = client.get(reverse(DEVICE_ROLES)).json()['roles']
    assert {r['name'] for r in roles} == {'Access Point', 'Core Switch'}
    assert roles[0].keys() == {'id', 'name', 'slug'}   # the trimmed shape, not the whole model

    hits = client.get(reverse(DEVICE_ROLES), {'q': 'access'}).json()['roles']
    assert [r['slug'] for r in hits] == ['access-point']


def test_device_roles_requires_login(client):
    r = client.get(reverse(DEVICE_ROLES))
    assert r.status_code in (302, 403)   # LoginRequiredMixin redirects to the login page


def test_device_roles_are_object_permission_scoped(client, login_only_user):
    # login_only_user holds no DeviceRole view grant at all, so `.restrict(user,'view')` returns
    # nothing — the picker must not become a way to enumerate roles you can't see.
    _role()
    client.force_login(login_only_user)
    assert client.get(reverse(DEVICE_ROLES)).json()['roles'] == []


def test_device_roles_respects_a_constrained_grant(client, login_only_user):
    from dcim.models import DeviceRole
    _role('Access Point', 'access-point')
    _role('Core Switch', 'core-switch')
    grant(login_only_user, DeviceRole, ['view'], constraints={'slug': 'access-point'})
    client.force_login(login_only_user)

    roles = client.get(reverse(DEVICE_ROLES)).json()['roles']
    assert [r['slug'] for r in roles] == ['access-point']


# --- window.MAP stamping: MapView mirrors the resolved config to the browser. --------------------


def _stamped(html, name):
    """Decode a `name: JSON.parse("…")` stamp back to its Python value. The template escapes the
    JSON text with |escapejs (\\uXXXX escapes), which `unicode_escape` reverses exactly."""
    import re as _re
    m = _re.search(_re.escape(name) + r': JSON\.parse\("(.*?)"\)', html)
    assert m, 'no %s stamp in the page' % name
    return json.loads(m.group(1).encode('ascii').decode('unicode_escape'))


def test_map_view_stamps_device_tool_and_presets(client, editor_user):
    role = _role()
    _may_see_roles(editor_user)
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={
        'device_tool': True,
        'device_presets': [_preset(role, template='AP-{room}', scope='floor'),
                           _preset(None, key='spk', label='PA speaker', icon='speaker',
                                   enabled=False)],
    })
    client.force_login(editor_user)
    html = client.get(reverse('plugins:netbox_facilitymap:map')).content.decode()

    assert 'deviceTool: true' in html
    presets = _stamped(html, 'devicePresets')
    # Both presets stamp — the settings editor needs disabled ones too — each with its role
    # resolved to {id,name} (or None) so no per-preset round-trip is needed.
    assert [p['key'] for p in presets] == ['ap', 'spk']
    assert presets[0]['role'] == {'id': role.pk, 'name': 'Access Point'}
    assert presets[0]['name_template'] == 'AP-{room}' and presets[0]['count_scope'] == 'floor'
    assert presets[1]['role'] is None and presets[1]['enabled'] is False
    # The status vocabulary rides alongside, for presets that prompt for status.
    statuses = _stamped(html, 'deviceStatuses')
    assert ['active'] == [v for v, _ in statuses if v == 'active']


def test_map_view_stamps_seeded_preset_for_a_legacy_ap_install(client, editor_user):
    # The DEV-8 back-compat headline: an install still on the ap_* keys boots with the seeded
    # Access point preset in window.MAP, so the toolbar keeps offering the tool with no manual step.
    role = _role()
    _may_see_roles(editor_user)
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={
        'ap_tool': True, 'ap_device_role': role.pk,
        'ap_name_template': 'AP-{room}', 'ap_count_scope': 'floor',
    })
    client.force_login(editor_user)
    html = client.get(reverse('plugins:netbox_facilitymap:map')).content.decode()

    assert 'deviceTool: true' in html   # via the ap_tool fallback
    presets = _stamped(html, 'devicePresets')
    assert [p['key'] for p in presets] == ['access-point']
    assert presets[0]['icon'] == 'ap' and presets[0]['role']['id'] == role.pk


def test_map_view_stamps_null_role_when_it_is_not_visible(client, editor_user):
    # The role is configured but this user can't see it (no DeviceRole view grant) — it must stamp
    # null, i.e. "unconfigured", so the toolbar skips the preset rather than half-offering it.
    role = _role()
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={
        'device_tool': True, 'device_presets': [_preset(role)]})
    client.force_login(editor_user)
    html = client.get(reverse('plugins:netbox_facilitymap:map')).content.decode()
    assert _stamped(html, 'devicePresets')[0]['role'] is None


def test_map_view_stamps_null_role_when_it_was_deleted(client, editor_user):
    role = _role()
    _may_see_roles(editor_user)
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={
        'device_tool': True, 'device_presets': [_preset(role)]})
    role.delete()   # the blob now holds a dangling id — clamp_device_role can't catch this
    client.force_login(editor_user)
    html = client.get(reverse('plugins:netbox_facilitymap:map')).content.decode()
    assert _stamped(html, 'devicePresets')[0]['role'] is None


def test_map_view_escapes_an_operator_typed_preset_label(client, editor_user):
    # Preset labels/templates are operator-typed free text rendered INSIDE an inline <script>.
    # JSON escaping leaves `/` alone, so `</script>` would close the block — the JSON rides
    # |escapejs inside a JS string then JSON.parse. Regression guard for that (a stored-XSS
    # vector, not a cosmetic issue).
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={
        'device_tool': True, 'device_presets': [
            _preset(None, label='</script><img src=x onerror=alert(1)>',
                    template='{room}')]})
    client.force_login(editor_user)
    html = client.get(reverse('plugins:netbox_facilitymap:map')).content.decode()

    assert '</script><img' not in html
    assert '\\u003C' in html or '\\u003c' in html   # escapejs hex-escapes the angle brackets
    # …and the decoded stamp still carries the label verbatim.
    assert _stamped(html, 'devicePresets')[0]['label'] == '</script><img src=x onerror=alert(1)>'


# --- DEV-5: the Device-create + name-suggestion endpoints, and the model listing that feeds the
# tool's picker. This is the security-sensitive half — the plugin's SECOND write into dcim core
# (§10), so every gate is asserted one at a time rather than in aggregate. ----------------------

DEVICE_TYPES = 'plugins:netbox_facilitymap:api-nb-device-types'
SUGGEST_NAME = 'plugins:netbox_facilitymap:api-nb-device-suggest-name'
DEVICE_CREATE = 'plugins:netbox_facilitymap:api-nb-device-create'


def _floor_and_room(room_name='Room 101'):
    """A site → floor Location → room Location chain, the shape every write-path endpoint resolves
    against (a `dcim.Site` is one building here, its floors are Locations, rooms their children —
    §7/§10)."""
    from dcim.models import Location, Site
    site = Site.objects.create(name='Building A', slug='building-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    room = Location.objects.create(name=room_name, slug=slugify(room_name), site=site, parent=floor)
    return site, floor, room


def _device_type(model='MR46', manufacturer='Cisco Meraki'):
    from dcim.models import DeviceType, Manufacturer
    mfr, _ = Manufacturer.objects.get_or_create(
        name=manufacturer, defaults={'slug': slugify(manufacturer)})
    return DeviceType.objects.create(model=model, slug=slugify(model), manufacturer=mfr)


def _tool_on(role=None, template='{room}-{role_short}', scope='none', tool=True, write_mode=True,
             fields=None, enabled=True, presets=None):
    """Configure the device tool in the one install-wide settings blob and switch both install-wide
    gates on. The endpoints read this live via `previews.device_presets`/`write_mode_enabled`, so
    writing the row is the whole setup — no restart, no monkeypatching. The default is one 'ap'
    preset in the classic AP configuration; pass `presets` to store an explicit list instead."""
    if presets is None:
        presets = [_preset(role, template=template, scope=scope, enabled=enabled, fields=fields)]
    FacilityMapBlob.objects.update_or_create(
        kind='settings', facility='', key='', defaults={'data': {
            'device_tool': tool, 'write_mode': write_mode, 'device_presets': presets,
        }})


def _device_creator(user):
    """Grant the object permissions the write path needs: Device view+add (add to create and to
    pass the post-save `restrict(user,'add')` re-check), plus the Location/DeviceType views it
    resolves the room and model through."""
    from dcim.models import Device, DeviceType, Location
    grant(user, Device, ['view', 'add'])
    grant(user, Location, ['view'])
    grant(user, DeviceType, ['view'])


def _device(name, role, site, location, **kw):
    from dcim.models import Device
    return Device.objects.create(name=name, role=role, site=site, location=location,
                                 device_type=kw.pop('device_type', None) or _device_type(name), **kw)


def _suggest(client, room, preset='ap', **params):
    return client.get(reverse(SUGGEST_NAME), dict({'location': room.pk, 'preset': preset}, **params))


# --- The model listing: an ordinary object-scoped read, like its device-roles sibling. -----------


def test_device_types_lists_and_searches_both_names(client, editor_user):
    _device_type('MR46', 'Cisco Meraki')
    _device_type('AP-635', 'Aruba')
    _device_creator(editor_user)
    client.force_login(editor_user)

    types = client.get(reverse(DEVICE_TYPES)).json()['device_types']
    assert {t['model'] for t in types} == {'MR46', 'AP-635'}
    assert types[0].keys() == {'id', 'model', 'manufacturer'}   # trimmed, not the whole model

    # Operators think in model names AND manufacturer names, so both are searched.
    assert [t['model'] for t in client.get(reverse(DEVICE_TYPES), {'q': 'mr4'}).json()
            ['device_types']] == ['MR46']
    assert [t['model'] for t in client.get(reverse(DEVICE_TYPES), {'q': 'meraki'}).json()
            ['device_types']] == ['MR46']


def test_device_types_requires_login(client):
    r = client.get(reverse(DEVICE_TYPES))
    assert r.status_code in (302, 403)


def test_device_types_are_object_permission_scoped(client, login_only_user):
    _device_type()
    client.force_login(login_only_user)
    assert client.get(reverse(DEVICE_TYPES)).json()['device_types'] == []


# --- suggest-name: preset resolution, the template expansion, and the counter's scope semantics. --


def test_suggest_name_expands_room_and_role_short(client, editor_user):
    role = _role('Access Point', 'access-point')
    _, _, room = _floor_and_room()
    _tool_on(role)
    _device_creator(editor_user)
    client.force_login(editor_user)

    r = _suggest(client, room)
    assert r.status_code == 200
    # {role_short} initials a multi-word slug; the `none` scope adds no counter at all.
    assert r.json()['name'] == 'Room 101-AP'


def test_suggest_name_expands_room_slug(client, editor_user):
    # UX-2: {room_slug} expands to the room Location's native slug, distinct from {room}'s name.
    role = _role('Access Point', 'access-point')
    _, _, room = _floor_and_room()
    _tool_on(role, template='{room_slug}-{role_short}')
    _device_creator(editor_user)
    client.force_login(editor_user)

    r = _suggest(client, room)
    assert r.status_code == 200
    assert r.json()['name'] == 'room-101-AP'


def test_suggest_name_uses_a_single_word_slug_whole(client, editor_user):
    # `ap` must expand to AP, never to `A` — an operator whose role is plain "AP" means AP.
    role = _role('AP', 'ap')
    _, _, room = _floor_and_room()
    _tool_on(role)
    _device_creator(editor_user)
    client.force_login(editor_user)

    assert _suggest(client, room).json()['name'] == 'Room 101-AP'


def test_suggest_name_resolves_the_named_preset_not_the_first(client, editor_user):
    # Two presets with different roles/templates: the suggestion must come from the KEYED one.
    ap_role = _role('Access Point', 'access-point')
    spk_role = _role('Speaker', 'speaker')
    _, _, room = _floor_and_room()
    _tool_on(presets=[
        _preset(ap_role),
        _preset(spk_role, key='spk', label='PA speaker', icon='speaker', template='SPK-{room}'),
    ])
    _device_creator(editor_user)
    client.force_login(editor_user)

    assert _suggest(client, room, preset='spk').json()['name'] == 'SPK-Room 101'


def test_suggest_name_counter_resets_per_room_but_climbs_per_floor(client, editor_user):
    # The two scopes' defining difference, asserted against ONE fixture so they can't both drift.
    role = _role()
    site, floor, room_a = _floor_and_room('Room 101')
    from dcim.models import Location
    room_b = Location.objects.create(name='Room 102', slug='room-102', site=site, parent=floor)
    _device('Room 101-AP-01', role, site, room_a)
    _device_creator(editor_user)
    client.force_login(editor_user)

    # room scope: room_b holds no AP of its own, so its counter starts over at 01.
    _tool_on(role, scope='room')
    assert _suggest(client, room_b).json()['name'] == 'Room 102-AP-01'

    # floor scope: the sibling room's AP counts, so room_b's next AP is 02.
    _tool_on(role, scope='floor')
    assert _suggest(client, room_b).json()['name'] == 'Room 102-AP-02'


def test_suggest_name_site_scope_counts_the_whole_building(client, editor_user):
    role = _role()
    site, floor, room = _floor_and_room()
    from dcim.models import Location
    other_floor = Location.objects.create(name='Floor 2', slug='floor-2', site=site)
    other_room = Location.objects.create(name='Room 201', slug='room-201', site=site,
                                         parent=other_floor)
    _device('Room 201-AP-01', role, site, other_room)
    _tool_on(role, scope='site')
    _device_creator(editor_user)
    client.force_login(editor_user)

    # A device on ANOTHER floor of the same building counts — site scope is per building (§10).
    assert _suggest(client, room).json()['name'] == 'Room 101-AP-02'


def test_suggest_name_building_scope_restarts_per_building_under_a_campus(client, editor_user):
    # MODEL-3: under Site = campus a building is a Location, and the `building` scope counts within
    # the building anchor (the floor's parent Location) and its descendants, restarting per building.
    # A device in Building A must NOT bump a suggestion in Building B, even though both share one Site.
    from dcim.models import Location, Site
    role = _role()
    campus = Site.objects.create(name='Campus', slug='campus')
    bldg_a = Location.objects.create(name='Building A', slug='building-a', site=campus)
    bldg_b = Location.objects.create(name='Building B', slug='building-b', site=campus)
    floor_a = Location.objects.create(name='Floor 1', slug='a-floor-1', site=campus, parent=bldg_a)
    room_a = Location.objects.create(name='Room 101', slug='a-room-101', site=campus, parent=floor_a)
    floor_b = Location.objects.create(name='Floor 1', slug='b-floor-1', site=campus, parent=bldg_b)
    room_b = Location.objects.create(name='Room 101', slug='b-room-101', site=campus, parent=floor_b)
    # A device in Building A (name deconflicted so the Site-wide free-name probe doesn't itself bump B).
    _device('A-AP-01', role, campus, room_a)
    _tool_on(role, scope='building')
    _device_creator(editor_user)
    client.force_login(editor_user)

    # Building A already holds one device → its next is 02; Building B holds none → its counter is 01.
    assert _suggest(client, room_a).json()['name'] == 'Room 101-AP-02'
    assert _suggest(client, room_b).json()['name'] == 'Room 101-AP-01'


def test_suggest_name_building_scope_degenerates_to_site_when_site_is_the_building(client, editor_user):
    # For a Site-anchored install (a Site *is* the building — floors sit at the Site root, so a
    # floor has no parent Location), `building` scope degenerates to the whole Site, identical to
    # `site`: a device on another floor of the same Site counts, exactly as the `site` scope does.
    from dcim.models import Location
    role = _role()
    site, floor, room = _floor_and_room()
    other_floor = Location.objects.create(name='Floor 2', slug='floor-2', site=site)
    other_room = Location.objects.create(name='Room 201', slug='room-201', site=site,
                                         parent=other_floor)
    _device('Room 201-AP-01', role, site, other_room)
    _tool_on(role, scope='building')
    _device_creator(editor_user)
    client.force_login(editor_user)

    assert _suggest(client, room).json()['name'] == 'Room 101-AP-02'


@pytest.mark.parametrize('scope', ['room', 'floor', 'building', 'site'])
def test_suggest_name_continues_across_two_polygons_on_one_location(client, editor_user, scope):
    # DEV-11: one physical room modeled as two floor-plan polygons (two plugin `Room` rows) bound
    # to the SAME `dcim.Location`. The counter must keep climbing rather than restart, and it does
    # by construction — `NbDeviceSuggestNameView` counts by the Location pk it's given, never by
    # `Room.room_id`, so which polygon a placement came through is irrelevant. Asserted for every
    # `count_scope`, since each scope's queryset includes `room` itself in this fixture.
    from netbox_facilitymap.models import Room
    role = _role()
    site, floor, room = _floor_and_room()
    Room.objects.create(floor_key='building-a/floor-1', room_id='r1', location=room, floor_location=floor)
    Room.objects.create(floor_key='building-a/floor-1', room_id='r2', location=room, floor_location=floor)
    _device('Room 101-AP-01', role, site, room)
    _tool_on(role, scope=scope)
    _device_creator(editor_user)
    client.force_login(editor_user)

    assert _suggest(client, room).json()['name'] == 'Room 101-AP-02'


def test_suggest_name_none_scope_ignores_two_polygons_on_one_location(client, editor_user):
    # The `none` scope short-circuits before any counting happens (devices.py:300-301), so the
    # two-polygons-one-Location split can't somehow conjure a counter into existence either.
    from netbox_facilitymap.models import Room
    role = _role('Access Point', 'access-point')
    site, floor, room = _floor_and_room()
    Room.objects.create(floor_key='building-a/floor-1', room_id='r1', location=room, floor_location=floor)
    Room.objects.create(floor_key='building-a/floor-1', room_id='r2', location=room, floor_location=floor)
    _device('Room 101-AP', role, site, room)
    _tool_on(role, scope='none')
    _device_creator(editor_user)
    client.force_login(editor_user)

    assert _suggest(client, room).json()['name'] == 'Room 101-AP'


def test_suggest_name_counter_ignores_other_roles(client, editor_user):
    role = _role()
    switch = _role('Core Switch', 'core-switch')
    site, _, room = _floor_and_room()
    _device('sw1', switch, site, room)
    _tool_on(role, scope='room')
    _device_creator(editor_user)
    client.force_login(editor_user)

    # The counter counts the preset's role, not all devices — a switch in the room must not push
    # the AP to 02.
    assert _suggest(client, room).json()['name'] == 'Room 101-AP-01'


def test_suggest_name_bumps_past_a_taken_name(client, editor_user):
    # The count says 01, but 01 is taken by a device the count didn't cover (here: another room's,
    # under `room` scope). The suggestion must step past it rather than hand back a name that
    # immediately 400s on save — Device names are unique per SITE, a wider domain than the counter.
    role = _role()
    site, floor, room_a = _floor_and_room('Room 101')
    from dcim.models import Location
    # Same name, another floor of the same building — Location names are unique per (site, parent),
    # so this is legal, and both rooms expand the template to the same base. One SITE, so both
    # share the Device-name uniqueness domain while `room` scope counts them separately.
    floor_2 = Location.objects.create(name='Floor 2', slug='floor-2', site=site)
    room_b = Location.objects.create(name='Room 101', slug='room-101-b', site=site, parent=floor_2)
    _device('Room 101-AP-01', role, site, room_a)
    _tool_on(role, scope='room')
    _device_creator(editor_user)
    client.force_login(editor_user)

    assert _suggest(client, room_b).json()['name'] == 'Room 101-AP-02'


def test_suggest_name_expands_the_asset_tag_param(client, editor_user):
    # DEV-6: the tag isn't knowable from the room — the browser passes what the user typed.
    role = _role('Access Point', 'access-point')
    _, _, room = _floor_and_room()
    _tool_on(role, template='{room}-{role_short}-{asset_tag}')
    _device_creator(editor_user)
    client.force_login(editor_user)

    r = _suggest(client, room, asset_tag='TRI-9931')
    assert r.status_code == 200
    assert r.json()['name'] == 'Room 101-AP-TRI-9931'


def test_suggest_name_omitted_asset_tag_drops_the_token(client, editor_user):
    # The param is optional (the first fetch happens before the user has typed anything), and an
    # absent tag is the same "no tag" as a blank one — no dangling separator either way.
    role = _role('Access Point', 'access-point')
    _, _, room = _floor_and_room()
    _tool_on(role, template='{room}-{role_short}-{asset_tag}')
    _device_creator(editor_user)
    client.force_login(editor_user)

    assert _suggest(client, room).json()['name'] == 'Room 101-AP'
    assert _suggest(client, room, asset_tag='').json()['name'] == 'Room 101-AP'


def test_suggest_name_probes_the_tag_expanded_name(client, editor_user):
    # THE point of expanding the tag server-side (DEV-6) rather than letting the browser patch it
    # into the response: the free-name probe has to run on the name that will actually be saved. If
    # `{asset_tag}` were still a literal in `base` here, the probe would vet `…-{asset_tag}-01`,
    # miss this collision, and hand back a name that 400s the moment it's created.
    role = _role()
    site, _, room = _floor_and_room('Room 101')
    _device('Room 101-AP-TRI-9931-01', role, site, room)
    _tool_on(role, template='{room}-{role_short}-{asset_tag}', scope='room')
    _device_creator(editor_user)
    client.force_login(editor_user)

    r = _suggest(client, room, asset_tag='TRI-9931')
    assert r.json()['name'] == 'Room 101-AP-TRI-9931-02'


def test_suggest_name_counts_unrestricted(client, editor_user):
    # The deliberate exception to this module's read posture: the count does NOT restrict to what
    # the caller may view. A restricted count would UNDERCOUNT and suggest a colliding name — so
    # a device the user cannot see still advances the counter. It leaks only an integer.
    role = _role()
    site, _, room = _floor_and_room()
    _device('Room 101-AP-01', role, site, room)
    _tool_on(role, scope='room')
    from dcim.models import Device, DeviceType, Location
    grant(editor_user, Device, ['add'], constraints={'name': 'nothing-matches'})
    grant(editor_user, Location, ['view'])
    grant(editor_user, DeviceType, ['view'])
    client.force_login(editor_user)

    assert _suggest(client, room).json()['name'] == 'Room 101-AP-02'


def test_suggest_name_works_for_a_legacy_ap_install(client, editor_user):
    # DEV-8 back-compat: a blob still holding only the ap_* keys serves the seeded preset under
    # its stable `access-point` key — the suggestion works with no manual migration step.
    role = _role('Access Point', 'access-point')
    _, _, room = _floor_and_room()
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={
        'ap_tool': True, 'write_mode': True, 'ap_device_role': role.pk,
        'ap_name_template': '{room}-{role_short}', 'ap_count_scope': 'none',
    })
    _device_creator(editor_user)
    client.force_login(editor_user)

    assert _suggest(client, room, preset='access-point').json()['name'] == 'Room 101-AP'


def test_suggest_name_unknown_room_returns_400(client, editor_user):
    _tool_on(_role())
    _device_creator(editor_user)
    client.force_login(editor_user)
    assert client.get(reverse(SUGGEST_NAME),
                      {'location': 999999, 'preset': 'ap'}).status_code == 400


def test_suggest_name_unknown_preset_returns_400(client, editor_user):
    _, _, room = _floor_and_room()
    _tool_on(_role())
    _device_creator(editor_user)
    client.force_login(editor_user)
    assert _suggest(client, room, preset='no-such-preset').status_code == 400
    assert client.get(reverse(SUGGEST_NAME), {'location': room.pk}).status_code == 400


def test_suggest_name_disabled_preset_returns_400(client, editor_user):
    # A stale toolbar must not keep suggesting through a preset the operator switched off.
    _, _, room = _floor_and_room()
    _tool_on(_role(), enabled=False)
    _device_creator(editor_user)
    client.force_login(editor_user)
    assert _suggest(client, room).status_code == 400


def test_suggest_name_unconfigured_role_returns_400(client, editor_user):
    _, _, room = _floor_and_room()
    _tool_on(role=None)
    _device_creator(editor_user)
    client.force_login(editor_user)
    # A 400 (the preset is stored but unfinished), never a 500 on the null role FK.
    assert _suggest(client, room).status_code == 400


@pytest.mark.parametrize('tool,write_mode', [(False, True), (True, False)])
def test_suggest_name_honours_the_install_wide_gates(client, editor_user, tool, write_mode):
    # Suggest-name answers to the same gates as create: a name is only useful to a caller who
    # could actually create the device.
    role = _role()
    _, _, room = _floor_and_room()
    _tool_on(role, tool=tool, write_mode=write_mode)
    _device_creator(editor_user)
    client.force_login(editor_user)
    assert _suggest(client, room).status_code == 403


def test_suggest_name_without_add_device_returns_403(client, editor_user):
    role = _role()
    _, _, room = _floor_and_room()
    _tool_on(role)
    client.force_login(editor_user)   # no dcim.add_device grant
    assert _suggest(client, room).status_code == 403


# --- Device create: the second write into dcim core. Each gate is proven to refuse ON ITS OWN,
# with the others open, so none can be dropped without a test going red. -----------------------


def _create_payload(room, dtype, name='Room 101-AP-01', preset='ap', **kw):
    return dict({'preset': preset, 'location': room.pk, 'device_type': dtype.pk, 'name': name},
                **kw)


def test_create_device_success(client, editor_user):
    from dcim.models import Device
    role = _role()
    site, _, room = _floor_and_room()
    dtype = _device_type()
    _tool_on(role)
    _device_creator(editor_user)
    client.force_login(editor_user)

    r = _post(client, DEVICE_CREATE, _create_payload(room, dtype))
    assert r.status_code == 201
    d = Device.objects.get(name='Room 101-AP-01')
    assert d.location_id == room.pk and d.site_id == site.pk
    assert d.rack is None            # a placed device hangs in the room, never in a rack
    assert d.role_id == role.pk      # the role is server policy, from the stored preset
    assert d.status == 'active'      # the model's own default
    assert r.json()['id'] == d.pk


def test_create_device_through_a_second_preset_uses_its_role(client, editor_user):
    # The generalization headline: a second preset mints devices of ITS role — resolved from the
    # stored preset the key names, never from the request.
    from dcim.models import Device
    ap_role = _role()
    spk_role = _role('Speaker', 'speaker')
    _, _, room = _floor_and_room()
    dtype = _device_type()
    _tool_on(presets=[_preset(ap_role),
                      _preset(spk_role, key='spk', label='PA speaker', icon='speaker')])
    _device_creator(editor_user)
    client.force_login(editor_user)

    r = _post(client, DEVICE_CREATE, _create_payload(room, dtype, name='SPK-01', preset='spk'))
    assert r.status_code == 201
    assert Device.objects.get(name='SPK-01').role_id == spk_role.pk


def test_create_device_ignores_a_client_supplied_role(client, editor_user):
    # The role must come from the stored preset, never the body — else any dcim.add_device holder
    # could mint a device of ANY role through a tool that advertises specific kinds.
    from dcim.models import Device
    role = _role()
    switch = _role('Core Switch', 'core-switch')
    _, _, room = _floor_and_room()
    dtype = _device_type()
    _tool_on(role)
    _device_creator(editor_user)
    client.force_login(editor_user)

    r = _post(client, DEVICE_CREATE, _create_payload(room, dtype, role=switch.pk))
    assert r.status_code == 201
    assert Device.objects.get(name='Room 101-AP-01').role_id == role.pk


def test_create_device_ignores_a_client_supplied_rack_and_site(client, editor_user):
    from dcim.models import Device, Rack, Site
    role = _role()
    site, _, room = _floor_and_room()
    elsewhere = Site.objects.create(name='Building B', slug='building-b')
    rack = Rack.objects.create(name='R1', site=site, location=room, status='active')
    _tool_on(role)
    _device_creator(editor_user)
    client.force_login(editor_user)

    r = _post(client, DEVICE_CREATE,
              _create_payload(room, _device_type(), rack=rack.pk, site=elsewhere.pk))
    assert r.status_code == 201
    d = Device.objects.get(name='Room 101-AP-01')
    assert d.rack is None and d.site_id == site.pk   # both taken from the room, not the payload


def test_create_device_ignores_fields_the_preset_does_not_prompt_for(client, editor_user):
    # The preset's field selection is server-enforced: serial/description/status sent against a
    # preset that doesn't prompt for them are never read — the dialog's field list is a write
    # contract, not a UI courtesy.
    from dcim.models import Device
    role = _role()
    _, _, room = _floor_and_room()
    _tool_on(role, fields=['name', 'device_type'])
    _device_creator(editor_user)
    client.force_login(editor_user)

    r = _post(client, DEVICE_CREATE, _create_payload(
        room, _device_type(), serial='SN-1', description='desc',
        status='planned', asset_tag='TAG-1'))
    assert r.status_code == 201
    d = Device.objects.get(name='Room 101-AP-01')
    assert d.serial == '' and d.description == '' and d.asset_tag is None
    assert d.status == 'active'   # the model default, not the payload's 'planned'


def test_create_device_writes_the_prompted_optional_fields(client, editor_user):
    from dcim.models import Device
    role = _role()
    _, _, room = _floor_and_room()
    _tool_on(role, fields=['name', 'device_type', 'asset_tag', 'serial', 'description', 'status'])
    _device_creator(editor_user)
    client.force_login(editor_user)

    r = _post(client, DEVICE_CREATE, _create_payload(
        room, _device_type(), serial='SN-1', description='PA speaker over the door',
        status='planned', asset_tag='TAG-1'))
    assert r.status_code == 201
    d = Device.objects.get(name='Room 101-AP-01')
    assert d.serial == 'SN-1' and d.description == 'PA speaker over the door'
    assert d.asset_tag == 'TAG-1' and d.status == 'planned'


def test_create_device_bogus_status_returns_400(client, editor_user):
    # A prompted status still has to be a real dcim.Device status — full_clean turns a bogus
    # choice into a clean 400, never a saved device in an invalid state.
    _, _, room = _floor_and_room()
    _tool_on(_role(), fields=['name', 'device_type', 'status'])
    _device_creator(editor_user)
    client.force_login(editor_user)

    r = _post(client, DEVICE_CREATE, _create_payload(room, _device_type(), status='bogus'))
    assert r.status_code == 400


def test_create_device_works_for_a_legacy_ap_install(client, editor_user):
    # DEV-8 back-compat: the seeded preset creates exactly as the old AP tool did.
    from dcim.models import Device
    role = _role()
    _, _, room = _floor_and_room()
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={
        'ap_tool': True, 'write_mode': True, 'ap_device_role': role.pk,
    })
    _device_creator(editor_user)
    client.force_login(editor_user)

    r = _post(client, DEVICE_CREATE,
              _create_payload(room, _device_type(), preset='access-point'))
    assert r.status_code == 201
    assert Device.objects.get(name='Room 101-AP-01').role_id == role.pk


@pytest.mark.parametrize('tool,write_mode', [(False, True), (True, False)])
def test_create_device_honours_the_install_wide_gates(client, editor_user, tool, write_mode):
    from dcim.models import Device
    role = _role()
    _, _, room = _floor_and_room()
    dtype = _device_type()
    _tool_on(role, tool=tool, write_mode=write_mode)
    _device_creator(editor_user)
    client.force_login(editor_user)

    r = _post(client, DEVICE_CREATE, _create_payload(room, dtype))
    assert r.status_code == 403
    assert not Device.objects.exists()


def test_create_device_without_add_device_returns_403(client, editor_user):
    # Both install-wide switches are on, but this user holds no dcim.add_device — the write-mode
    # flag alone is NOT authorization.
    from dcim.models import Device, DeviceType, Location
    role = _role()
    _, _, room = _floor_and_room()
    dtype = _device_type()
    _tool_on(role)
    grant(editor_user, Location, ['view'])
    grant(editor_user, DeviceType, ['view'])
    client.force_login(editor_user)

    r = _post(client, DEVICE_CREATE, _create_payload(room, dtype))
    assert r.status_code == 403
    assert not Device.objects.exists()


def test_create_device_object_level_denial_rolls_back(client, editor_user):
    # A constrained `add` grant passes the model-level has_perm but excludes the saved row. The
    # post-save restrict('add') re-check must catch it and roll the device back — the check runs on
    # a saved pk precisely because an object-level has_perm on an unsaved instance always fails.
    from dcim.models import Device, DeviceType, Location
    role = _role()
    _, _, room = _floor_and_room()
    dtype = _device_type()
    _tool_on(role)
    grant(editor_user, Device, ['view', 'add'], constraints={'name': 'some-other-name'})
    grant(editor_user, Location, ['view'])
    grant(editor_user, DeviceType, ['view'])
    client.force_login(editor_user)

    r = _post(client, DEVICE_CREATE, _create_payload(room, dtype))
    assert r.status_code == 403
    assert not Device.objects.filter(name='Room 101-AP-01').exists()   # rolled back, not orphaned


def test_create_device_unknown_preset_returns_400(client, editor_user):
    from dcim.models import Device
    _, _, room = _floor_and_room()
    _tool_on(_role())
    _device_creator(editor_user)
    client.force_login(editor_user)

    assert _post(client, DEVICE_CREATE,
                 _create_payload(room, _device_type(), preset='no-such-preset')).status_code == 400
    assert not Device.objects.exists()


def test_create_device_disabled_preset_returns_400(client, editor_user):
    from dcim.models import Device
    _, _, room = _floor_and_room()
    _tool_on(_role(), enabled=False)
    _device_creator(editor_user)
    client.force_login(editor_user)

    assert _post(client, DEVICE_CREATE, _create_payload(room, _device_type())).status_code == 400
    assert not Device.objects.exists()


def test_create_device_unconfigured_role_returns_400(client, editor_user):
    _, _, room = _floor_and_room()
    dtype = _device_type()
    _tool_on(role=None)
    _device_creator(editor_user)
    client.force_login(editor_user)

    r = _post(client, DEVICE_CREATE, _create_payload(room, dtype))
    assert r.status_code == 400   # not a 500 on the null role FK


def test_create_device_duplicate_name_returns_400(client, editor_user):
    from dcim.models import Device
    role = _role()
    site, _, room = _floor_and_room()
    dtype = _device_type()
    _device('Room 101-AP-01', role, site, room)
    _tool_on(role)
    _device_creator(editor_user)
    client.force_login(editor_user)

    # Device names are unique per site (case-insensitively) — full_clean turns that into a clean
    # 400, not a 500 from the DB constraint.
    r = _post(client, DEVICE_CREATE, _create_payload(room, dtype))
    assert r.status_code == 400
    assert Device.objects.filter(name='Room 101-AP-01').count() == 1


def test_create_device_blank_name_returns_400(client, editor_user):
    _, _, room = _floor_and_room()
    _tool_on(_role())
    _device_creator(editor_user)
    client.force_login(editor_user)
    assert _post(client, DEVICE_CREATE, _create_payload(room, _device_type(), name='   ')
                 ).status_code == 400


def test_create_device_unknown_room_returns_400(client, editor_user):
    _tool_on(_role())
    _device_creator(editor_user)
    client.force_login(editor_user)
    r = _post(client, DEVICE_CREATE,
              {'preset': 'ap', 'location': 999999, 'device_type': _device_type().pk,
               'name': 'AP-01'})
    assert r.status_code == 400


def test_create_device_hidden_room_returns_400(client, editor_user):
    # A room the user may not see is indistinguishable from one that doesn't exist — never a
    # silent create somewhere else in the tree.
    from dcim.models import Device, DeviceType
    role = _role()
    _, _, room = _floor_and_room()
    _tool_on(role)
    grant(editor_user, Device, ['view', 'add'])
    grant(editor_user, DeviceType, ['view'])   # no Location view grant
    client.force_login(editor_user)

    assert _post(client, DEVICE_CREATE, _create_payload(room, _device_type())).status_code == 400


def test_create_device_unknown_device_type_returns_400(client, editor_user):
    _, _, room = _floor_and_room()
    _tool_on(_role())
    _device_creator(editor_user)
    client.force_login(editor_user)
    r = _post(client, DEVICE_CREATE,
              {'preset': 'ap', 'location': room.pk, 'device_type': 999999, 'name': 'AP-01'})
    assert r.status_code == 400


def test_create_device_blank_asset_tag_stores_null(client, editor_user):
    # asset_tag is globally unique AND nullable, so a blank one must land as NULL — two blank-tagged
    # devices would otherwise collide on '' and the second would 400 for no reason a user could see.
    from dcim.models import Device
    role = _role()
    _, _, room = _floor_and_room()
    _tool_on(role)
    _device_creator(editor_user)
    client.force_login(editor_user)

    assert _post(client, DEVICE_CREATE,
                 _create_payload(room, _device_type('MR46'), name='AP-01', asset_tag='')
                 ).status_code == 201
    assert _post(client, DEVICE_CREATE,
                 _create_payload(room, _device_type('MR44'), name='AP-02', asset_tag='')
                 ).status_code == 201
    assert Device.objects.filter(asset_tag__isnull=True).count() == 2


def test_create_device_duplicate_asset_tag_returns_400(client, editor_user):
    role = _role()
    site, _, room = _floor_and_room()
    _device('other', role, site, room, asset_tag='ASSET-1')
    _tool_on(role)
    _device_creator(editor_user)
    client.force_login(editor_user)

    r = _post(client, DEVICE_CREATE,
              _create_payload(room, _device_type('MR44'), asset_tag='ASSET-1'))
    assert r.status_code == 400   # globally unique — a clean 400 from full_clean()


def test_create_device_rejects_invalid_json(client, editor_user):
    _tool_on(_role())
    _device_creator(editor_user)
    client.force_login(editor_user)
    r = client.post(reverse(DEVICE_CREATE), data='not json', content_type='application/json')
    assert r.status_code == 400


def test_create_device_rejects_a_non_object_body(client, editor_user):
    # A syntactically valid JSON body that isn't an object (BUG-1) is a 400, not a 500 — the view
    # immediately calls `.get(...)` on the decoded payload.
    _tool_on(_role())
    _device_creator(editor_user)
    client.force_login(editor_user)
    assert _post(client, DEVICE_CREATE, ['not', 'an', 'object']).status_code == 400


def test_create_device_requires_login(client):
    r = client.post(reverse(DEVICE_CREATE), data='{}', content_type='application/json')
    assert r.status_code in (302, 403)
