"""Tier C — `views.MapView`'s config-derived `window.MAP` context (the rest of the page is
static markup, not asserted here)."""

import pytest
from django.urls import reverse

pytestmark = pytest.mark.django_db

MAP = 'plugins:netbox_facilitymap:map'
SETTINGS = 'plugins:netbox_facilitymap:settings'


def test_map_view_stamps_default_floor_label_field(client, editor_user):
    client.force_login(editor_user)
    r = client.get(reverse(MAP))
    assert r.status_code == 200
    assert 'floorLabelField: "name"' in r.content.decode()


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
    FacilityMapBlob.objects.create(kind='annotations', facility='', key='', data={'a/f1': {}})


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


def test_map_view_flags_orphaned_data_banner(client, editor_user):
    _orphaned_default_facility()
    client.force_login(editor_user)
    assert 'orphan-banner' in client.get(reverse(MAP)).content.decode()


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
