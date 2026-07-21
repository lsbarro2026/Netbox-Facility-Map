"""Access-point tool configuration (DEV-3).

The AP feature's install-wide settings — its own on/off switch, the device role new APs get, and
the name template + counter scope — plus the role-listing read that backs the Settings page's role
picker. This is the configuration surface only; the Device-create and name-suggestion endpoints
that consume it are DEV-5, and the floor-editor tool is DEV-1.

Three things carry the weight here:
  * every setting merges into the ONE install-wide settings blob without clobbering its siblings
    (MULTI-1 + AUDIT-1's before/after diff depend on it);
  * values are validated/clamped SERVER-side — the Settings page is UX only;
  * a name template is the one setting that RAISES rather than clamps, because there is no sensible
    "nearest valid value" for a typo'd placeholder (see `previews.clean_ap_name_template`).
"""

import json

import pytest
from django.urls import reverse
from django.utils.text import slugify

from netbox_facilitymap import previews
from netbox_facilitymap.models import FacilityMapBlob

from conftest import grant

AP_TOOL = 'plugins:netbox_facilitymap:api-settings-ap-tool'
AP_ROLE = 'plugins:netbox_facilitymap:api-settings-ap-device-role'
AP_NAMING = 'plugins:netbox_facilitymap:api-settings-ap-naming'
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


# --- previews.py resolvers/clamps: enum-safe on read, so a blob written outside the Settings page
# (admin/REST/fixture) can never break a page render. -----------------------------------------


@pytest.mark.parametrize('value,expected', [
    ('none', 'none'), ('room', 'room'), ('floor', 'floor'), ('building', 'building'),
    ('site', 'site'), ('bogus', 'none'), (None, 'none'), ('', 'none'), (7, 'none'),
])
def test_clamp_ap_count_scope(value, expected):
    assert previews.clamp_ap_count_scope(value) == expected


@pytest.mark.parametrize('value,expected', [
    (3, 3), ('3', 3),          # a JSON blob may hold either
    (None, None), ('', None), ('abc', None),
    (0, None), (-1, None),     # not a usable pk
])
def test_clamp_ap_device_role(value, expected):
    assert previews.clamp_ap_device_role(value) == expected


def test_clean_ap_name_template_accepts_known_placeholders():
    assert previews.clean_ap_name_template('{room}-{role_short}') == '{room}-{role_short}'
    assert previews.clean_ap_name_template('  AP-{room}  ') == 'AP-{room}'   # stripped
    assert previews.clean_ap_name_template('no-placeholders-at-all') == 'no-placeholders-at-all'


def test_clean_ap_name_template_empty_resets_to_default():
    # An empty template is a reset, not an error — the field can be cleared.
    assert previews.clean_ap_name_template('') == previews.AP_NAME_TEMPLATE_DEFAULT
    assert previews.clean_ap_name_template(None) == previews.AP_NAME_TEMPLATE_DEFAULT


def test_clean_ap_name_template_rejects_unknown_placeholder():
    # The headline: a typo'd/unsupported token must NOT slip through as a literal and quietly land
    # in every device name. {rack} is the specific one an operator might reach for — APs are never
    # racked, so it will never be supported.
    with pytest.raises(ValueError) as e:
        previews.clean_ap_name_template('{room}-{rack}')
    assert '{rack}' in str(e.value)
    with pytest.raises(ValueError):
        previews.clean_ap_name_template('{count}')   # the counter is a scope dropdown, not a token


def test_clean_ap_name_template_accepts_asset_tag():
    # DEV-6's third placeholder. Adding it to AP_NAME_PLACEHOLDERS is what stops the save path
    # 400ing on a template that uses it.
    assert previews.clean_ap_name_template(
        '{room}-{role_short}-{asset_tag}') == '{room}-{role_short}-{asset_tag}'


def test_clean_ap_name_template_accepts_room_slug():
    # UX-2's fourth placeholder — the room Location's native slug, distinct from {room}'s name.
    assert previews.clean_ap_name_template(
        '{room_slug}-{role_short}') == '{room_slug}-{role_short}'


def test_expand_ap_name_template_expands_all_four():
    assert previews.expand_ap_name_template(
        '{room}-{room_slug}-{role_short}-{asset_tag}', 'Room 101', 'room-101', 'AP',
        'TRI-9931') == 'Room 101-room-101-AP-TRI-9931'


def test_expand_ap_name_template_room_slug_is_distinct_from_room():
    # {room} is not a substring of {room_slug} (the braces differ), but assert both expand to their
    # own value in one template rather than one clobbering the other via naive replace ordering.
    assert previews.expand_ap_name_template(
        '{room}/{room_slug}', 'Room 101', 'room-101', 'AP') == 'Room 101/room-101'


@pytest.mark.parametrize('template, expected', [
    ('{room}-{role_short}-{asset_tag}', 'Room 101-AP'),   # trailing: takes the separator BEFORE it
    ('{asset_tag}-{room}-{role_short}', 'Room 101-AP'),   # leading: falls back to the one AFTER it
    ('{room}_{asset_tag}_{role_short}', 'Room 101_AP'),   # mid-template: exactly one `_` survives
    ('{room}.{asset_tag}', 'Room 101'),
    ('{room} {asset_tag}', 'Room 101'),
])
def test_expand_ap_name_template_blank_tag_drops_token_and_one_separator(template, expected):
    # The headline of DEV-6's blank rule: asset_tag is optional, so a template that names it must
    # still yield a clean name when it's left empty — never `Room 101-AP--01`.
    assert previews.expand_ap_name_template(template, 'Room 101', 'room-101', 'AP', '') == expected
    # None and whitespace are the same "no tag" as '' — the browser sends a raw field value.
    assert previews.expand_ap_name_template(template, 'Room 101', 'room-101', 'AP', None) == expected
    assert previews.expand_ap_name_template(template, 'Room 101', 'room-101', 'AP', '  ') == expected


def test_expand_ap_name_template_does_not_re_expand_a_tag_value():
    # The tag is operator-typed text, not a template: a tag that happens to read `{room}` must land
    # as those literal characters. This is why `{asset_tag}` is substituted last.
    assert previews.expand_ap_name_template(
        '{room}-{asset_tag}', 'Room 101', 'room-101', 'AP', '{room}') == 'Room 101-{room}'


def test_clean_ap_name_template_rejects_unbalanced_braces():
    with pytest.raises(ValueError):
        previews.clean_ap_name_template('{room-{role_short}')


def test_clean_ap_name_template_rejects_over_long():
    # Longer than dcim.Device.name allows can only ever expand to a name full_clean() rejects.
    with pytest.raises(ValueError):
        previews.clean_ap_name_template('x' * (previews.AP_NAME_TEMPLATE_MAX + 1))


def test_ap_tool_enabled_defaults_false(db):
    # No blob at all, then a blob with no ap_tool key — both read False (back-compatible with a
    # pre-DEV-3 settings blob, exactly like room_embed_*/facility_grouping were).
    assert previews.ap_tool_enabled() is False
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={'write_mode': True})
    assert previews.ap_tool_enabled() is False


def test_ap_settings_defaults_on_empty_blob(db):
    assert previews.ap_settings() == {
        'enabled': False, 'device_role': None,
        'name_template': previews.AP_NAME_TEMPLATE_DEFAULT, 'count_scope': 'none',
    }


def test_ap_settings_clamps_a_hand_edited_blob(db):
    # Written outside the Settings page (admin/REST/fixture), so it never went through the POST
    # validation. Every value must still resolve to something usable rather than raise mid-render.
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={
        'ap_tool': True, 'ap_device_role': 'nonsense',
        'ap_name_template': '{bogus}', 'ap_count_scope': 'galaxy',
    })
    assert previews.ap_settings() == {
        'enabled': True, 'device_role': None,
        'name_template': previews.AP_NAME_TEMPLATE_DEFAULT, 'count_scope': 'none',
    }


# --- The settings endpoints: admin-tier (IMPORT_PERM), merged into the single install-wide blob. --


def test_ap_settings_require_import_permission(client, plain_user):
    # plain_user holds change_facilitymapblob but NOT import_facilitymapblob (PERM-1): these are
    # admin-tier configuration, gated a tier above an ordinary map write.
    client.force_login(plain_user)
    assert _post(client, AP_TOOL, {'ap_tool': True}).status_code == 403
    assert _post(client, AP_ROLE, {'ap_device_role': None}).status_code == 403
    assert _post(client, AP_NAMING, {'ap_name_template': '{room}'}).status_code == 403
    assert not FacilityMapBlob.objects.filter(kind='settings').exists()


def test_ap_tool_persists_to_settings_blob(client, editor_user):
    client.force_login(editor_user)
    r = _post(client, AP_TOOL, {'ap_tool': True})
    assert r.status_code == 200 and r.json() == {'ok': True, 'ap_tool': True}
    assert _settings()['ap_tool'] is True
    assert previews.ap_tool_enabled() is True

    r = _post(client, AP_TOOL, {'ap_tool': False})
    assert r.status_code == 200 and _settings()['ap_tool'] is False


def test_ap_tool_rejects_a_non_object_body(client, editor_user):
    # A syntactically valid JSON body that isn't an object (BUG-1) is a 400, not a 500 — the shared
    # `_SettingView.post` immediately calls `.get(...)` on the decoded payload.
    client.force_login(editor_user)
    assert _post(client, AP_TOOL, [1, 2, 3]).status_code == 400


def test_ap_tool_is_stored_independently_of_write_mode(client, editor_user):
    # The AP switch is stored on its own terms, separately from write mode's master gate: turning it
    # on must not imply write mode, and turning write mode off later must not silently disable (or
    # forget) it — closing the gate makes an add-on inert, not unconfigured, so reopening it restores
    # what the operator had (SET-5). The UI keeps the two in step by disabling the row while write
    # mode is off; the endpoint deliberately doesn't re-litigate that, and the write path re-checks
    # both switches itself.
    client.force_login(editor_user)
    _post(client, AP_TOOL, {'ap_tool': True})
    assert previews.ap_tool_enabled() is True
    assert previews.write_mode_enabled() is False

    _post(client, 'plugins:netbox_facilitymap:api-settings-write-mode', {'write_mode': True})
    _post(client, 'plugins:netbox_facilitymap:api-settings-write-mode', {'write_mode': False})
    assert previews.ap_tool_enabled() is True


def test_ap_settings_merge_preserves_siblings(client, editor_user):
    # The blob is ONE install-wide row shared with room_embed_*/facility_grouping/write_mode/…
    # (MULTI-1). Each save must merge, never overwrite — AUDIT-1's before/after diff rides on it.
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={
        'room_embed_zoom': 3.0, 'facility_grouping': 'region',
        'floor_label_field': 'slug', 'write_mode': True,
    })
    role = _role()
    _may_see_roles(editor_user)
    client.force_login(editor_user)
    _post(client, AP_TOOL, {'ap_tool': True})
    _post(client, AP_ROLE, {'ap_device_role': role.pk})
    _post(client, AP_NAMING, {'ap_name_template': 'AP-{room}', 'ap_count_scope': 'floor'})

    data = _settings()
    assert data['room_embed_zoom'] == 3.0 and data['facility_grouping'] == 'region'
    assert data['floor_label_field'] == 'slug' and data['write_mode'] is True
    assert data['ap_tool'] is True and data['ap_device_role'] == role.pk
    assert data['ap_name_template'] == 'AP-{room}' and data['ap_count_scope'] == 'floor'


def test_ap_device_role_persists_and_clears(client, editor_user):
    role = _role()
    _may_see_roles(editor_user)
    client.force_login(editor_user)
    r = _post(client, AP_ROLE, {'ap_device_role': role.pk})
    assert r.status_code == 200 and r.json() == {'ok': True, 'ap_device_role': role.pk}
    assert previews.ap_settings()['device_role'] == role.pk

    # null clears it, leaving the tool unconfigured (and so hidden).
    r = _post(client, AP_ROLE, {'ap_device_role': None})
    assert r.status_code == 200 and _settings()['ap_device_role'] is None
    assert previews.ap_settings()['device_role'] is None


def test_ap_device_role_rejects_unknown_id(client, editor_user):
    # A dangling role reference would only surface much later, as a 500 from the Device-create
    # path — so refuse it here, where the message can say what's wrong.
    _may_see_roles(editor_user)
    client.force_login(editor_user)
    r = _post(client, AP_ROLE, {'ap_device_role': 99999})
    assert r.status_code == 400 and r.json()['ok'] is False
    assert 'not found' in r.json()['error']
    assert not FacilityMapBlob.objects.filter(kind='settings').exists()


def test_ap_device_role_rejects_non_numeric(client, editor_user):
    client.force_login(editor_user)
    r = _post(client, AP_ROLE, {'ap_device_role': 'access-point'})
    assert r.status_code == 400 and 'numeric' in r.json()['error']


def test_ap_naming_persists_both_values(client, editor_user):
    client.force_login(editor_user)
    r = _post(client, AP_NAMING, {'ap_name_template': '{room}-{role_short}',
                                  'ap_count_scope': 'room'})
    assert r.status_code == 200
    assert r.json() == {'ok': True, 'ap_name_template': '{room}-{role_short}',
                        'ap_count_scope': 'room'}
    assert previews.ap_settings()['name_template'] == '{room}-{role_short}'
    assert previews.ap_settings()['count_scope'] == 'room'


def test_ap_naming_rejects_unknown_placeholder_without_saving(client, editor_user):
    client.force_login(editor_user)
    r = _post(client, AP_NAMING, {'ap_name_template': '{room}-{rack}', 'ap_count_scope': 'none'})
    assert r.status_code == 400 and r.json()['ok'] is False and '{rack}' in r.json()['error']
    # Rejected outright — the scope from the same payload must not land either.
    assert not FacilityMapBlob.objects.filter(kind='settings').exists()


def test_ap_naming_clamps_bogus_scope_but_keeps_template(client, editor_user):
    # The scope is enum-clamped (like floor_label_field), while the template raises — the two
    # halves of one row deliberately behave differently, and this pins that down.
    client.force_login(editor_user)
    r = _post(client, AP_NAMING, {'ap_name_template': 'AP-{room}', 'ap_count_scope': 'galaxy'})
    assert r.status_code == 200
    assert _settings() == {'ap_name_template': 'AP-{room}', 'ap_count_scope': 'none'}


def test_ap_naming_empty_template_resets_to_default(client, editor_user):
    client.force_login(editor_user)
    r = _post(client, AP_NAMING, {'ap_name_template': '', 'ap_count_scope': 'none'})
    assert r.status_code == 200
    # The response carries the canonical stored value so the Settings text field can adopt it,
    # rather than sitting there blank while the server holds the default.
    assert r.json()['ap_name_template'] == previews.AP_NAME_TEMPLATE_DEFAULT
    assert _settings()['ap_name_template'] == previews.AP_NAME_TEMPLATE_DEFAULT


def test_ap_settings_reject_invalid_json(client, editor_user):
    client.force_login(editor_user)
    r = client.post(reverse(AP_TOOL), data='not json', content_type='application/json')
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


def test_ap_device_role_save_is_scoped_to_what_the_saver_can_see(client, editor_user):
    # editor_user's grants cover FacilityMapBlob/Room, not DeviceRole — so a role it cannot view is
    # not one it may pin, even though it clears the IMPORT_PERM gate. The picker wouldn't have
    # offered it (the listing is scoped the same way); this is the server half of that.
    role = _role()
    client.force_login(editor_user)
    r = _post(client, AP_ROLE, {'ap_device_role': role.pk})
    assert r.status_code == 400 and 'not found' in r.json()['error']


# --- window.MAP stamping: MapView mirrors the resolved config to the browser. --------------------


def test_map_view_stamps_ap_settings(client, editor_user):
    role = _role()
    _may_see_roles(editor_user)
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={
        'ap_tool': True, 'ap_device_role': role.pk,
        'ap_name_template': 'AP-{room}', 'ap_count_scope': 'floor',
    })
    client.force_login(editor_user)
    html = client.get(reverse('plugins:netbox_facilitymap:map')).content.decode()

    assert 'apTool: true' in html
    assert 'apCountScope: "floor"' in html
    assert ('apDeviceRole: { id: %d, name: "Access Point" }' % role.pk) in html
    # escapejs hex-escapes `-` (along with <, >, &, =, ;, quotes) — inert inside a JS string
    # literal, which still evaluates to 'AP-{room}'. Asserted in its escaped form because that is
    # what actually ships; `{`/`}` are untouched, so the placeholders survive verbatim.
    assert r'apNameTemplate: "AP\u002D{room}"' in html


def test_map_view_stamps_null_role_when_it_is_not_visible(client, editor_user):
    # The role is configured but this user can't see it (no DeviceRole view grant) — it must stamp
    # null, i.e. "unconfigured", so the tool stays hidden rather than half-configured.
    role = _role()
    FacilityMapBlob.objects.create(kind='settings', facility='', key='',
                                   data={'ap_tool': True, 'ap_device_role': role.pk})
    client.force_login(editor_user)
    html = client.get(reverse('plugins:netbox_facilitymap:map')).content.decode()
    assert 'apDeviceRole: null' in html


def test_map_view_stamps_null_role_when_it_was_deleted(client, editor_user):
    role = _role()
    _may_see_roles(editor_user)
    FacilityMapBlob.objects.create(kind='settings', facility='', key='',
                                   data={'ap_tool': True, 'ap_device_role': role.pk})
    role.delete()   # the blob now holds a dangling id — clamp_ap_device_role can't catch this
    client.force_login(editor_user)
    html = client.get(reverse('plugins:netbox_facilitymap:map')).content.decode()
    assert 'apDeviceRole: null' in html


def test_map_view_escapes_an_operator_typed_role_name(client, editor_user):
    # Role names and the name template are operator-typed free text rendered INSIDE an inline
    # <script>. JSON escaping leaves `/` alone, so `</script>` would close the block — these ride
    # |escapejs instead. Regression guard for that (a stored-XSS vector, not a cosmetic issue).
    role = _role('</script><img src=x onerror=alert(1)>', 'xss-role')
    _may_see_roles(editor_user)
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={
        'ap_device_role': role.pk, 'ap_name_template': '</script>-{room}',
    })
    client.force_login(editor_user)
    html = client.get(reverse('plugins:netbox_facilitymap:map')).content.decode()

    assert '</script><img' not in html
    assert '"</script>-{room}"' not in html
    assert '\\u003C' in html or '\\u003c' in html   # escapejs hex-escapes the angle brackets


# --- DEV-5: the Device-create + name-suggestion endpoints, and the model listing that feeds the
# tool's picker. This is the security-sensitive half — the plugin's SECOND write into dcim core
# (§10), so every gate is asserted one at a time rather than in aggregate. ----------------------

DEVICE_TYPES = 'plugins:netbox_facilitymap:api-nb-device-types'
SUGGEST_NAME = 'plugins:netbox_facilitymap:api-nb-device-suggest-name'
DEVICE_CREATE = 'plugins:netbox_facilitymap:api-nb-device-create'


def _floor_and_room(room_name='Room 101'):
    """A site → floor Location → room Location chain, the shape every AP endpoint resolves against
    (a `dcim.Site` is one building here, its floors are Locations, rooms their children — §7/§10)."""
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


def _ap_on(role=None, template='{room}-{role_short}', scope='none', tool=True, write_mode=True):
    """Configure the AP tool in the one install-wide settings blob and switch both install-wide
    gates on. The endpoints read this live via `previews.ap_settings`/`write_mode_enabled`, so
    writing the row is the whole setup — no restart, no monkeypatching."""
    FacilityMapBlob.objects.update_or_create(
        kind='settings', facility='', key='', defaults={'data': {
            'ap_tool': tool, 'write_mode': write_mode,
            'ap_device_role': role.pk if role else None,
            'ap_name_template': template, 'ap_count_scope': scope,
        }})


def _ap_creator(user):
    """Grant the object permissions the AP write path needs: Device view+add (add to create and to
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


# --- The model listing: an ordinary object-scoped read, like its device-roles sibling. -----------


def test_device_types_lists_and_searches_both_names(client, editor_user):
    _device_type('MR46', 'Cisco Meraki')
    _device_type('AP-635', 'Aruba')
    _ap_creator(editor_user)
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


# --- suggest-name: the template expansion and the counter's scope semantics. ---------------------


def test_suggest_name_expands_room_and_role_short(client, editor_user):
    role = _role('Access Point', 'access-point')
    _, _, room = _floor_and_room()
    _ap_on(role)
    _ap_creator(editor_user)
    client.force_login(editor_user)

    r = client.get(reverse(SUGGEST_NAME), {'location': room.pk})
    assert r.status_code == 200
    # {role_short} initials a multi-word slug; the `none` scope adds no counter at all.
    assert r.json()['name'] == 'Room 101-AP'


def test_suggest_name_expands_room_slug(client, editor_user):
    # UX-2: {room_slug} expands to the room Location's native slug, distinct from {room}'s name.
    role = _role('Access Point', 'access-point')
    _, _, room = _floor_and_room()
    _ap_on(role, template='{room_slug}-{role_short}')
    _ap_creator(editor_user)
    client.force_login(editor_user)

    r = client.get(reverse(SUGGEST_NAME), {'location': room.pk})
    assert r.status_code == 200
    assert r.json()['name'] == 'room-101-AP'


def test_suggest_name_uses_a_single_word_slug_whole(client, editor_user):
    # `ap` must expand to AP, never to `A` — an operator whose role is plain "AP" means AP.
    role = _role('AP', 'ap')
    _, _, room = _floor_and_room()
    _ap_on(role)
    _ap_creator(editor_user)
    client.force_login(editor_user)

    assert client.get(reverse(SUGGEST_NAME), {'location': room.pk}).json()['name'] == 'Room 101-AP'


def test_suggest_name_counter_resets_per_room_but_climbs_per_floor(client, editor_user):
    # The two scopes' defining difference, asserted against ONE fixture so they can't both drift.
    role = _role()
    site, floor, room_a = _floor_and_room('Room 101')
    from dcim.models import Location
    room_b = Location.objects.create(name='Room 102', slug='room-102', site=site, parent=floor)
    _device('Room 101-AP-01', role, site, room_a)
    _ap_creator(editor_user)
    client.force_login(editor_user)

    # room scope: room_b holds no AP of its own, so its counter starts over at 01.
    _ap_on(role, scope='room')
    assert client.get(reverse(SUGGEST_NAME), {'location': room_b.pk}).json()['name'] == 'Room 102-AP-01'

    # floor scope: the sibling room's AP counts, so room_b's next AP is 02.
    _ap_on(role, scope='floor')
    assert client.get(reverse(SUGGEST_NAME), {'location': room_b.pk}).json()['name'] == 'Room 102-AP-02'


def test_suggest_name_site_scope_counts_the_whole_building(client, editor_user):
    role = _role()
    site, floor, room = _floor_and_room()
    from dcim.models import Location
    other_floor = Location.objects.create(name='Floor 2', slug='floor-2', site=site)
    other_room = Location.objects.create(name='Room 201', slug='room-201', site=site,
                                         parent=other_floor)
    _device('Room 201-AP-01', role, site, other_room)
    _ap_on(role, scope='site')
    _ap_creator(editor_user)
    client.force_login(editor_user)

    # A device on ANOTHER floor of the same building counts — site scope is per building (§10).
    assert client.get(reverse(SUGGEST_NAME), {'location': room.pk}).json()['name'] == 'Room 101-AP-02'


def test_suggest_name_building_scope_restarts_per_building_under_a_campus(client, editor_user):
    # MODEL-3: under Site = campus a building is a Location, and the `building` scope counts within
    # the building anchor (the floor's parent Location) and its descendants, restarting per building.
    # An AP in Building A must NOT bump a suggestion in Building B, even though both share one Site.
    from dcim.models import Location, Site
    role = _role()
    campus = Site.objects.create(name='Campus', slug='campus')
    bldg_a = Location.objects.create(name='Building A', slug='building-a', site=campus)
    bldg_b = Location.objects.create(name='Building B', slug='building-b', site=campus)
    floor_a = Location.objects.create(name='Floor 1', slug='a-floor-1', site=campus, parent=bldg_a)
    room_a = Location.objects.create(name='Room 101', slug='a-room-101', site=campus, parent=floor_a)
    floor_b = Location.objects.create(name='Floor 1', slug='b-floor-1', site=campus, parent=bldg_b)
    room_b = Location.objects.create(name='Room 101', slug='b-room-101', site=campus, parent=floor_b)
    # An AP in Building A (name deconflicted so the Site-wide free-name probe doesn't itself bump B).
    _device('A-AP-01', role, campus, room_a)
    _ap_on(role, scope='building')
    _ap_creator(editor_user)
    client.force_login(editor_user)

    # Building A already holds one AP → its next is 02; Building B holds none → its counter is 01.
    assert client.get(reverse(SUGGEST_NAME), {'location': room_a.pk}).json()['name'] == 'Room 101-AP-02'
    assert client.get(reverse(SUGGEST_NAME), {'location': room_b.pk}).json()['name'] == 'Room 101-AP-01'


def test_suggest_name_building_scope_degenerates_to_site_when_site_is_the_building(client, editor_user):
    # For a Site-anchored install (a Site *is* the building — floors sit at the Site root, so a
    # floor has no parent Location), `building` scope degenerates to the whole Site, identical to
    # `site`: an AP on another floor of the same Site counts, exactly as the `site` scope does.
    from dcim.models import Location
    role = _role()
    site, floor, room = _floor_and_room()
    other_floor = Location.objects.create(name='Floor 2', slug='floor-2', site=site)
    other_room = Location.objects.create(name='Room 201', slug='room-201', site=site,
                                         parent=other_floor)
    _device('Room 201-AP-01', role, site, other_room)
    _ap_on(role, scope='building')
    _ap_creator(editor_user)
    client.force_login(editor_user)

    assert client.get(reverse(SUGGEST_NAME), {'location': room.pk}).json()['name'] == 'Room 101-AP-02'


def test_suggest_name_counter_ignores_other_roles(client, editor_user):
    role = _role()
    switch = _role('Core Switch', 'core-switch')
    site, _, room = _floor_and_room()
    _device('sw1', switch, site, room)
    _ap_on(role, scope='room')
    _ap_creator(editor_user)
    client.force_login(editor_user)

    # The counter counts APs, not devices — a switch in the room must not push the AP to 02.
    assert client.get(reverse(SUGGEST_NAME), {'location': room.pk}).json()['name'] == 'Room 101-AP-01'


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
    _ap_on(role, scope='room')
    _ap_creator(editor_user)
    client.force_login(editor_user)

    assert client.get(reverse(SUGGEST_NAME), {'location': room_b.pk}).json()['name'] == 'Room 101-AP-02'


def test_suggest_name_expands_the_asset_tag_param(client, editor_user):
    # DEV-6: the tag isn't knowable from the room — the browser passes what the user typed.
    role = _role('Access Point', 'access-point')
    _, _, room = _floor_and_room()
    _ap_on(role, template='{room}-{role_short}-{asset_tag}')
    _ap_creator(editor_user)
    client.force_login(editor_user)

    r = client.get(reverse(SUGGEST_NAME), {'location': room.pk, 'asset_tag': 'TRI-9931'})
    assert r.status_code == 200
    assert r.json()['name'] == 'Room 101-AP-TRI-9931'


def test_suggest_name_omitted_asset_tag_drops_the_token(client, editor_user):
    # The param is optional (the first fetch happens before the user has typed anything), and an
    # absent tag is the same "no tag" as a blank one — no dangling separator either way.
    role = _role('Access Point', 'access-point')
    _, _, room = _floor_and_room()
    _ap_on(role, template='{room}-{role_short}-{asset_tag}')
    _ap_creator(editor_user)
    client.force_login(editor_user)

    assert client.get(reverse(SUGGEST_NAME), {'location': room.pk}).json()['name'] == 'Room 101-AP'
    assert client.get(reverse(SUGGEST_NAME),
                      {'location': room.pk, 'asset_tag': ''}).json()['name'] == 'Room 101-AP'


def test_suggest_name_probes_the_tag_expanded_name(client, editor_user):
    # THE point of expanding the tag server-side (DEV-6) rather than letting the browser patch it
    # into the response: the free-name probe has to run on the name that will actually be saved. If
    # `{asset_tag}` were still a literal in `base` here, the probe would vet `…-{asset_tag}-01`,
    # miss this collision, and hand back a name that 400s the moment it's created.
    role = _role()
    site, _, room = _floor_and_room('Room 101')
    _device('Room 101-AP-TRI-9931-01', role, site, room)
    _ap_on(role, template='{room}-{role_short}-{asset_tag}', scope='room')
    _ap_creator(editor_user)
    client.force_login(editor_user)

    r = client.get(reverse(SUGGEST_NAME), {'location': room.pk, 'asset_tag': 'TRI-9931'})
    assert r.json()['name'] == 'Room 101-AP-TRI-9931-02'


def test_suggest_name_counts_unrestricted(client, editor_user):
    # The deliberate exception to this module's read posture: the count does NOT restrict to what
    # the caller may view. A restricted count would UNDERCOUNT and suggest a colliding name — so
    # a device the user cannot see still advances the counter. It leaks only an integer.
    role = _role()
    site, _, room = _floor_and_room()
    _device('Room 101-AP-01', role, site, room)
    _ap_on(role, scope='room')
    from dcim.models import Device, DeviceType, Location
    grant(editor_user, Device, ['add'], constraints={'name': 'nothing-matches'})
    grant(editor_user, Location, ['view'])
    grant(editor_user, DeviceType, ['view'])
    client.force_login(editor_user)

    assert client.get(reverse(SUGGEST_NAME), {'location': room.pk}).json()['name'] == 'Room 101-AP-02'


def test_suggest_name_unknown_room_returns_400(client, editor_user):
    _ap_on(_role())
    _ap_creator(editor_user)
    client.force_login(editor_user)
    assert client.get(reverse(SUGGEST_NAME), {'location': 999999}).status_code == 400


def test_suggest_name_unconfigured_role_returns_400(client, editor_user):
    _, _, room = _floor_and_room()
    _ap_on(role=None)
    _ap_creator(editor_user)
    client.force_login(editor_user)
    # A 400 (the tool is on but unfinished), never a 500 on the null role FK.
    assert client.get(reverse(SUGGEST_NAME), {'location': room.pk}).status_code == 400


@pytest.mark.parametrize('tool,write_mode', [(False, True), (True, False)])
def test_suggest_name_honours_the_install_wide_gates(client, editor_user, tool, write_mode):
    # Suggest-name answers to the same gates as create: a name is only useful to a caller who
    # could actually create the device.
    role = _role()
    _, _, room = _floor_and_room()
    _ap_on(role, tool=tool, write_mode=write_mode)
    _ap_creator(editor_user)
    client.force_login(editor_user)
    assert client.get(reverse(SUGGEST_NAME), {'location': room.pk}).status_code == 403


def test_suggest_name_without_add_device_returns_403(client, editor_user):
    role = _role()
    _, _, room = _floor_and_room()
    _ap_on(role)
    client.force_login(editor_user)   # no dcim.add_device grant
    assert client.get(reverse(SUGGEST_NAME), {'location': room.pk}).status_code == 403


# --- Device create: the second write into dcim core. Each gate is proven to refuse ON ITS OWN,
# with the others open, so none can be dropped without a test going red. -----------------------


def _create_payload(room, dtype, name='Room 101-AP-01', **kw):
    return dict({'location': room.pk, 'device_type': dtype.pk, 'name': name}, **kw)


def test_create_device_success(client, editor_user):
    from dcim.models import Device
    role = _role()
    site, _, room = _floor_and_room()
    dtype = _device_type()
    _ap_on(role)
    _ap_creator(editor_user)
    client.force_login(editor_user)

    r = _post(client, DEVICE_CREATE, _create_payload(room, dtype))
    assert r.status_code == 201
    d = Device.objects.get(name='Room 101-AP-01')
    assert d.location_id == room.pk and d.site_id == site.pk
    assert d.rack is None            # an AP hangs in the room, never in a rack
    assert d.role_id == role.pk      # the role is server policy, from the blob
    assert d.status == 'active'      # the model's own default
    assert r.json()['id'] == d.pk


def test_create_device_ignores_a_client_supplied_role(client, editor_user):
    # The role must come from the settings blob, never the body — else any dcim.add_device holder
    # could mint a device of ANY role through a tool that advertises access points.
    from dcim.models import Device
    role = _role()
    switch = _role('Core Switch', 'core-switch')
    _, _, room = _floor_and_room()
    dtype = _device_type()
    _ap_on(role)
    _ap_creator(editor_user)
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
    _ap_on(role)
    _ap_creator(editor_user)
    client.force_login(editor_user)

    r = _post(client, DEVICE_CREATE,
              _create_payload(room, _device_type(), rack=rack.pk, site=elsewhere.pk))
    assert r.status_code == 201
    d = Device.objects.get(name='Room 101-AP-01')
    assert d.rack is None and d.site_id == site.pk   # both taken from the room, not the payload


@pytest.mark.parametrize('tool,write_mode', [(False, True), (True, False)])
def test_create_device_honours_the_install_wide_gates(client, editor_user, tool, write_mode):
    from dcim.models import Device
    role = _role()
    _, _, room = _floor_and_room()
    dtype = _device_type()
    _ap_on(role, tool=tool, write_mode=write_mode)
    _ap_creator(editor_user)
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
    _ap_on(role)
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
    _ap_on(role)
    grant(editor_user, Device, ['view', 'add'], constraints={'name': 'some-other-name'})
    grant(editor_user, Location, ['view'])
    grant(editor_user, DeviceType, ['view'])
    client.force_login(editor_user)

    r = _post(client, DEVICE_CREATE, _create_payload(room, dtype))
    assert r.status_code == 403
    assert not Device.objects.filter(name='Room 101-AP-01').exists()   # rolled back, not orphaned


def test_create_device_unconfigured_role_returns_400(client, editor_user):
    _, _, room = _floor_and_room()
    dtype = _device_type()
    _ap_on(role=None)
    _ap_creator(editor_user)
    client.force_login(editor_user)

    r = _post(client, DEVICE_CREATE, _create_payload(room, dtype))
    assert r.status_code == 400   # not a 500 on the null role FK


def test_create_device_duplicate_name_returns_400(client, editor_user):
    from dcim.models import Device
    role = _role()
    site, _, room = _floor_and_room()
    dtype = _device_type()
    _device('Room 101-AP-01', role, site, room)
    _ap_on(role)
    _ap_creator(editor_user)
    client.force_login(editor_user)

    # Device names are unique per site (case-insensitively) — full_clean turns that into a clean
    # 400, not a 500 from the DB constraint.
    r = _post(client, DEVICE_CREATE, _create_payload(room, dtype))
    assert r.status_code == 400
    assert Device.objects.filter(name='Room 101-AP-01').count() == 1


def test_create_device_blank_name_returns_400(client, editor_user):
    _, _, room = _floor_and_room()
    _ap_on(_role())
    _ap_creator(editor_user)
    client.force_login(editor_user)
    assert _post(client, DEVICE_CREATE, _create_payload(room, _device_type(), name='   ')
                 ).status_code == 400


def test_create_device_unknown_room_returns_400(client, editor_user):
    _ap_on(_role())
    _ap_creator(editor_user)
    client.force_login(editor_user)
    r = _post(client, DEVICE_CREATE,
              {'location': 999999, 'device_type': _device_type().pk, 'name': 'AP-01'})
    assert r.status_code == 400


def test_create_device_hidden_room_returns_400(client, editor_user):
    # A room the user may not see is indistinguishable from one that doesn't exist — never a
    # silent create somewhere else in the tree.
    from dcim.models import Device, DeviceType
    role = _role()
    _, _, room = _floor_and_room()
    _ap_on(role)
    grant(editor_user, Device, ['view', 'add'])
    grant(editor_user, DeviceType, ['view'])   # no Location view grant
    client.force_login(editor_user)

    assert _post(client, DEVICE_CREATE, _create_payload(room, _device_type())).status_code == 400


def test_create_device_unknown_device_type_returns_400(client, editor_user):
    _, _, room = _floor_and_room()
    _ap_on(_role())
    _ap_creator(editor_user)
    client.force_login(editor_user)
    r = _post(client, DEVICE_CREATE,
              {'location': room.pk, 'device_type': 999999, 'name': 'AP-01'})
    assert r.status_code == 400


def test_create_device_blank_asset_tag_stores_null(client, editor_user):
    # asset_tag is globally unique AND nullable, so a blank one must land as NULL — two blank-tagged
    # APs would otherwise collide on '' and the second would 400 for no reason a user could see.
    from dcim.models import Device
    role = _role()
    _, _, room = _floor_and_room()
    _ap_on(role)
    _ap_creator(editor_user)
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
    _ap_on(role)
    _ap_creator(editor_user)
    client.force_login(editor_user)

    r = _post(client, DEVICE_CREATE,
              _create_payload(room, _device_type('MR44'), asset_tag='ASSET-1'))
    assert r.status_code == 400   # globally unique — a clean 400 from full_clean()


def test_create_device_rejects_invalid_json(client, editor_user):
    _ap_on(_role())
    _ap_creator(editor_user)
    client.force_login(editor_user)
    r = client.post(reverse(DEVICE_CREATE), data='not json', content_type='application/json')
    assert r.status_code == 400


def test_create_device_rejects_a_non_object_body(client, editor_user):
    # A syntactically valid JSON body that isn't an object (BUG-1) is a 400, not a 500 — the view
    # immediately calls `.get(...)` on the decoded payload.
    _ap_on(_role())
    _ap_creator(editor_user)
    client.force_login(editor_user)
    assert _post(client, DEVICE_CREATE, ['not', 'an', 'object']).status_code == 400


def test_create_device_requires_login(client):
    r = client.post(reverse(DEVICE_CREATE), data='{}', content_type='application/json')
    assert r.status_code in (302, 403)
