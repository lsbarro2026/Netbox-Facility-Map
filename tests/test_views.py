"""Tier C — `views.MapView`'s config-derived `window.MAP` context (the rest of the page is
static markup, not asserted here), plus `views.TodoTabView`'s and `views.ImportTabView`'s
redirects into the SPA."""

import pytest
from django.urls import reverse

pytestmark = pytest.mark.django_db

MAP = 'plugins:netbox_facilitymap:map'
SETTINGS = 'plugins:netbox_facilitymap:settings'
TODO = 'plugins:netbox_facilitymap:todo'
IMPORT = 'plugins:netbox_facilitymap:import'


def _enable_todos():
    """Switch the to-do add-on on (ADDON-4) — it defaults off, so the pages/redirect below only
    exist once it's enabled."""
    from netbox_facilitymap.models import FacilityMapBlob
    FacilityMapBlob.objects.create(kind='settings', key='', data={'todos': True})


def test_todo_tab_redirects_into_the_map_hash_route(client, editor_user):
    """The nav's To-do entry (TASK-5). A PluginMenuItem links by URL name and can't carry a
    fragment, so this route exists purely to land the browser on the SPA's `#/todo` — when the
    to-do add-on is on (ADDON-4)."""
    _enable_todos()
    client.force_login(editor_user)
    r = client.get(reverse(TODO))
    assert r.status_code == 302
    assert r.url == reverse(MAP) + '#/todo'


def test_todo_tab_bounces_to_the_bare_map_when_the_feature_is_off(client, editor_user):
    """With the add-on off (the default, ADDON-4), the still-registered nav item lands on the bare
    map rather than `#/todo` — the nav menu is a cached NetBox singleton that can't hide live, so the
    destination degrades gracefully instead. The `api/todos*` data endpoints 404 instead (test_todos)."""
    client.force_login(editor_user)
    r = client.get(reverse(TODO))
    assert r.status_code == 302
    assert r.url == reverse(MAP)   # no '#/todo' fragment


def test_todo_tab_hash_names_no_facility(client, editor_user):
    """Deliberately bare: `App.init` applies the operator-pinned default facility to a hash that
    names none (rewriting to `#/y/<slug>/todo`, NAV-10). A facility pinned into this redirect
    would override that."""
    _enable_todos()
    client.force_login(editor_user)
    assert '/y/' not in client.get(reverse(TODO)).url


def test_import_tab_redirects_into_the_map_hash_route(client, editor_user):
    """The nav's `Edit floor plans` entry (HEALTH-8), mirroring `TodoTabView`: a PluginMenuItem
    can't carry a fragment, so this route exists purely to land the browser on the SPA's
    `#/import` route, which App.showImport()/showNoImport() then renders per the viewer's own
    import permission — no feature flag to bounce off, unlike to-do."""
    client.force_login(editor_user)
    r = client.get(reverse(IMPORT))
    assert r.status_code == 302
    assert r.url == reverse(MAP) + '#/import'


def test_import_tab_reachable_by_a_change_only_editor(client, change_only_user):
    """The whole point of HEALTH-8: an editor who holds `change_facilitymapblob` but not
    `import_facilitymapblob` can still reach this redirect (map reads are login-only by default,
    so this passes even without `view_facilitymapblob`, which `change_only_user` also lacks).
    The destination degrades to `App.showNoImport()`'s signpost — that's client-side, not
    asserted here (see app.js's own docs for the content-aware copy)."""
    client.force_login(change_only_user)
    r = client.get(reverse(IMPORT))
    assert r.status_code == 302
    assert r.url == reverse(MAP) + '#/import'


def test_import_tab_hash_names_no_facility(client, editor_user):
    """Bare `#/import`, matching `#/settings`'s and the to-do redirect's precedent (NAV-10) — a
    facility hard-coded here would override the operator-pinned default facility App.init applies
    to a hash that names none."""
    client.force_login(editor_user)
    assert '/y/' not in client.get(reverse(IMPORT)).url


def test_map_view_stamps_default_floor_label_field(client, editor_user):
    client.force_login(editor_user)
    r = client.get(reverse(MAP))
    assert r.status_code == 200
    assert 'floorLabelField: "name"' in r.content.decode()


def test_map_view_result_target_defaults_to_map(client, editor_user):
    # No `?target=` → window.MAP.resultTarget is 'map' (the finder deep-links the map, NAV-16).
    client.force_login(editor_user)
    assert 'resultTarget: "map"' in client.get(reverse(MAP)).content.decode()


def test_map_view_result_target_reads_netbox_flag(client, editor_user):
    # `?target=netbox` (set by FacilitySearchWidget) stamps the NetBox-target mode onto window.MAP.
    client.force_login(editor_user)
    assert 'resultTarget: "netbox"' in client.get(reverse(MAP) + '?target=netbox').content.decode()


def test_map_view_result_target_rejects_unknown_value(client, editor_user):
    # Any value other than the whitelisted 'netbox' falls back to 'map' — no arbitrary string leaks.
    client.force_login(editor_user)
    assert 'resultTarget: "map"' in client.get(reverse(MAP) + '?target=bogus').content.decode()


def test_map_view_clamps_invalid_floor_label_field(client, editor_user, monkeypatch):
    from django.conf import settings
    monkeypatch.setitem(settings.PLUGINS_CONFIG['netbox_facilitymap'], 'floor_label_field', 'nope')
    client.force_login(editor_user)
    r = client.get(reverse(MAP))
    assert r.status_code == 200
    assert 'floorLabelField: "name"' in r.content.decode()


def test_map_view_honours_configured_floor_label_field(client, editor_user, monkeypatch):
    from django.conf import settings
    monkeypatch.setitem(
        settings.PLUGINS_CONFIG['netbox_facilitymap'], 'floor_label_field', 'description')
    client.force_login(editor_user)
    r = client.get(reverse(MAP))
    assert r.status_code == 200
    assert 'floorLabelField: "description"' in r.content.decode()


def test_map_view_settings_blob_overrides_configured_floor_label_field(client, editor_user, monkeypatch):
    # A saved Settings-page value is authoritative over the PLUGINS_CONFIG default (SHOW-2's
    # three-tier precedence: blob → config → 'name').
    from django.conf import settings
    from netbox_facilitymap.models import FacilityMapBlob
    monkeypatch.setitem(
        settings.PLUGINS_CONFIG['netbox_facilitymap'], 'floor_label_field', 'description')
    FacilityMapBlob.objects.create(kind='settings', key='', data={'floor_label_field': 'slug'})
    client.force_login(editor_user)
    r = client.get(reverse(MAP))
    assert r.status_code == 200
    assert 'floorLabelField: "slug"' in r.content.decode()


def test_map_view_stamps_write_mode_off_by_default(client, editor_user):
    # No settings row → write mode is off, so the bind panel offers no create tile (LOC-2).
    client.force_login(editor_user)
    r = client.get(reverse(MAP))
    assert r.status_code == 200
    assert 'writeMode: false' in r.content.decode()


def test_map_view_stamps_write_mode_from_settings_blob(client, editor_user):
    # An operator-enabled write_mode in the settings blob is stamped onto window.MAP (LOC-2).
    from netbox_facilitymap.models import FacilityMapBlob
    FacilityMapBlob.objects.create(kind='settings', key='', data={'write_mode': True})
    client.force_login(editor_user)
    r = client.get(reverse(MAP))
    assert r.status_code == 200
    assert 'writeMode: true' in r.content.decode()


def test_map_view_stamps_todos_off_by_default(client, editor_user):
    # The to-do add-on (ADDON-4) defaults off, so window.MAP.todos is false with no settings blob —
    # the SPA hides the to-do pages, the floor panel, and the compose icon.
    client.force_login(editor_user)
    assert 'todos: false' in client.get(reverse(MAP)).content.decode()


def test_map_view_stamps_todos_on_from_settings_blob(client, editor_user):
    from netbox_facilitymap.models import FacilityMapBlob
    FacilityMapBlob.objects.create(kind='settings', key='', data={'todos': True})
    client.force_login(editor_user)
    assert 'todos: true' in client.get(reverse(MAP)).content.decode()


def test_map_view_stamps_inline_room_creation_on_when_unset(client, editor_user):
    # The add-on switch split out of write mode (SET-5) defaults ON when its key is absent, so an
    # install predating the split keeps the create tile write mode used to imply. Write mode is a
    # separate stamp and still gates it — off here, so nothing is actually offered.
    client.force_login(editor_user)
    body = client.get(reverse(MAP)).content.decode()
    assert 'inlineRoomCreation: true' in body
    assert 'writeMode: false' in body


def test_map_view_stamps_inline_room_creation_from_settings_blob(client, editor_user):
    # An operator who switched the add-on off keeps write mode's other writes: both stamps are
    # independent, which is the whole point of the split.
    from netbox_facilitymap.models import FacilityMapBlob
    FacilityMapBlob.objects.create(kind='settings', key='',
                                   data={'write_mode': True, 'inline_room_creation': False})
    client.force_login(editor_user)
    body = client.get(reverse(MAP)).content.decode()
    assert 'inlineRoomCreation: false' in body
    assert 'writeMode: true' in body


def test_map_view_stamps_the_signed_in_user(client, editor_user):
    # The to-do surfaces sort a user's own to-dos first (TASK-3), which needs the viewer's identity
    # client-side; MapView stamps it in the same shape a to-do's assignees arrive in.
    client.force_login(editor_user)
    body = client.get(reverse(MAP)).content.decode()
    assert f'user: {{ id: {editor_user.pk}' in body
    assert 'username: "editor"' in body
    assert 'initials: "ED"' in body


def test_map_view_escapes_a_users_display_name(client, editor_user):
    # A display name is user-entered free text landing in a JS *string* — so it rides |escapejs, not
    # json.dumps|safe. JSON escaping leaves `/` alone, and this name would otherwise close the
    # inline <script> and inject the rest as markup.
    editor_user.first_name = '</script><img src=x onerror=alert(1)>'
    editor_user.last_name = 'Doe'
    editor_user.save()
    client.force_login(editor_user)
    body = client.get(reverse(MAP)).content.decode()
    assert '<img src=x onerror=alert(1)>' not in body
    assert '\\u003C/script\\u003E' in body


def test_map_view_leaks_no_unrendered_template_comment():
    """A Django `{# #}` comment **cannot span multiple lines** — a multi-line one is not a comment
    at all: it renders verbatim. Inside the `window.MAP = {…}` object literal that's a JS syntax
    error that kills the whole map page (the bug "Django inline comments can't span multiple lines"
    fixed once already). Asserting on the *rendered* page can't catch it reliably — the leaked text
    doesn't remove the keys a substring check looks for — so this asserts on the **template source**
    instead, which is where the mistake actually lives. Multi-line commentary must use
    `{% comment %}`/`{% endcomment %}`.
    """
    import re
    from pathlib import Path

    import netbox_facilitymap

    src = (Path(netbox_facilitymap.__file__).parent
           / 'templates' / 'netbox_facilitymap' / 'index.html').read_text()
    spanning = [m.group(0) for m in re.finditer(r'\{#.*?#\}', src, re.S) if '\n' in m.group(0)]
    assert not spanning, (
        'multi-line {# #} template comment(s) — these render literally, not as comments; '
        f'use {{% comment %}} instead: {spanning}')


def test_settings_page_omits_floor_label_field(client, editor_user):
    # SET-1 moved floor_label_field off this NetBox-chrome'd page onto the in-app #/settings page;
    # the NetBox Settings form no longer renders (or accepts) it.
    client.force_login(editor_user)
    body = client.get(reverse(SETTINGS)).content.decode()
    assert 'name="floor_label_field"' not in body


def test_settings_save_records_audit_entry(client, editor_user):
    # SettingsView.post shares the AUDIT-1 snapshot pattern: saving the settings blob logs an
    # ObjectChange, and a second save records the before/after zoom in one update entry.
    from core.choices import ObjectChangeActionChoices
    from core.models import ObjectChange

    # editor_user holds `import_facilitymapblob`, the gate SettingsView requires.
    client.force_login(editor_user)
    form = {'room_embed_zoom': '2', 'room_embed_size': '80', 'room_embed_orientation': 'vertical'}
    assert client.post(reverse(SETTINGS), form).status_code == 302
    client.post(reverse(SETTINGS), {**form, 'room_embed_zoom': '3.5'})

    changes = ObjectChange.objects.filter(changed_object_type__model='facilitymapblob')
    upd = changes.get(action=ObjectChangeActionChoices.ACTION_UPDATE)
    assert upd.user_id == editor_user.pk
    assert upd.prechange_data['data']['room_embed_zoom'] == 2
    assert upd.postchange_data['data']['room_embed_zoom'] == 3.5


# --- orphaned-data reassignment (HEALTH-1) -------------------------------------------------------

def _orphaned_default_facility():
    """A SiteGroup with a Site (so nothing is ungrouped) plus annotations data under '' — orphaned
    because no current Site resolves to the default facility."""
    from dcim.models import Site, SiteGroup
    from netbox_facilitymap.models import FacilityMapBlob
    west = SiteGroup.objects.create(name='West', slug='west')
    Site.objects.create(name='A', slug='a', group=west)
    # Per-floor sharded (CONC-1): the annotations row's key IS the floor key.
    FacilityMapBlob.objects.create(kind='annotations', facility='', key='a/f1', data={})


def test_settings_reassign_rekeys_orphaned_data(client, editor_user, workdir):
    from netbox_facilitymap.models import FacilityMapBlob
    _orphaned_default_facility()
    client.force_login(editor_user)

    r = client.post(reverse(SETTINGS), {'action': 'reassign', 'old': '', 'new': 'west'})
    assert r.status_code == 302
    assert FacilityMapBlob.objects.get(kind='annotations').facility == 'west'


def test_settings_reassign_invalid_target_is_surfaced_not_500(client, editor_user, workdir):
    from netbox_facilitymap.models import FacilityMapBlob
    _orphaned_default_facility()
    client.force_login(editor_user)

    r = client.post(reverse(SETTINGS), {'action': 'reassign', 'old': '', 'new': 'ghost'})
    assert r.status_code == 200   # re-rendered with an error message, not a redirect or crash
    assert FacilityMapBlob.objects.get(kind='annotations').facility == ''


def test_settings_page_renders_orphan_card_with_suggested_target(client, editor_user):
    # The Settings GET renders the "Unassigned map data" card, the orphaned key, and preselects the
    # suggested target — exercises the new template block end to end.
    _orphaned_default_facility()
    client.force_login(editor_user)
    body = client.get(reverse(SETTINGS)).content.decode()
    assert 'Unassigned map data' in body
    assert 'value="west"' in body
    assert '(suggested)' in body


def test_map_view_flags_orphaned_data_banner_with_reassign_link_for_importer(client, editor_user):
    # An importer (editor_user holds import_facilitymapblob) gets the banner AND the actionable
    # "Reassign it in Settings" link into the IMPORT_PERM-gated recovery action.
    _orphaned_default_facility()
    client.force_login(editor_user)
    body = client.get(reverse(MAP)).content.decode()
    assert 'orphan-banner' in body
    assert 'Reassign it in Settings' in body


def test_map_view_shows_orphan_banner_without_reassign_link_for_non_importer(client, change_only_user):
    # A non-import viewer (only change_facilitymapblob) still sees the explanatory banner — the
    # blank map is made legible (HEALTH-6) — but WITHOUT the reassign link, since the Settings
    # action is IMPORT_PERM-gated and would 403. They're told an admin must reassign it.
    _orphaned_default_facility()
    client.force_login(change_only_user)
    body = client.get(reverse(MAP)).content.decode()
    assert 'orphan-banner' in body
    assert 'Reassign it in Settings' not in body


def test_map_view_no_banner_when_clean(client, editor_user):
    client.force_login(editor_user)
    assert 'orphan-banner' not in client.get(reverse(MAP)).content.decode()


def test_map_view_injects_enabled_capabilities(client, editor_user, monkeypatch):
    # window.MAP.capabilities carries the capability registry's enabled keys (the add-on framework,
    # ADDON-2), the frontend gate for a capability's tool — the same detect-and-enable model as
    # drawingExts. Pinned to a synthetic enabled set so the assertion is deterministic regardless of
    # which optional extras happen to be installed in the test env.
    from netbox_facilitymap import capabilities
    monkeypatch.setattr(capabilities, 'enabled_keys', lambda: ['demo'])
    client.force_login(editor_user)
    assert 'capabilities: ["demo"]' in client.get(reverse(MAP)).content.decode()
