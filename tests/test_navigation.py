"""The plugin nav (`navigation.menu`). A dedicated top-level `PluginMenu` — asserted structurally
(no DB): its label/icon, and its four `PluginMenuItem`s (Map, To-do, Edit floor plans, Settings)
with their links and the distinct permissions that gate each (view for the map and the to-do page,
change for the HEALTH-8 signpost, the destructive import perm for Settings — PERM-1). Only `menu`
is exported, never `menu_items`, so the plugin doesn't double-list."""

from netbox.plugins import PluginMenu

from netbox_facilitymap import navigation


def test_menu_is_a_dedicated_plugin_menu():
    assert isinstance(navigation.menu, PluginMenu)
    assert navigation.menu.label == 'Facility Map'
    assert navigation.menu.icon_class == 'mdi mdi-floor-plan'


def test_menu_has_one_group_with_map_todo_import_and_settings_items():
    (group,) = navigation.menu.groups
    assert group.label == 'Facility Map'
    links = [item.link for item in group.items]
    assert links == [
        'plugins:netbox_facilitymap:map',
        'plugins:netbox_facilitymap:todo',
        'plugins:netbox_facilitymap:import',
        'plugins:netbox_facilitymap:settings',
    ]


def test_todo_item_is_gated_on_the_view_permission():
    # The to-do page reads the same data the map does, so it rides the same read gate — and sits
    # beside the map, above the import-gated Settings entry (TASK-5).
    (group,) = navigation.menu.groups
    todo_item = group.items[1]
    assert todo_item.link_text == 'To-do'
    assert todo_item.permissions == ['netbox_facilitymap.view_facilitymapblob']


def test_map_item_is_gated_on_the_view_permission():
    (group,) = navigation.menu.groups
    map_item = group.items[0]
    assert map_item.link_text == 'Facility Map'
    assert map_item.permissions == ['netbox_facilitymap.view_facilitymapblob']


def test_import_item_is_gated_on_the_change_permission():
    # The HEALTH-8 signpost is gated on plain change, not the destructive import perm — so an
    # everyday rack-placer (change_facilitymapblob but not import_facilitymapblob) can discover
    # that plan edits exist, even though the destination (ImportTabView -> App.showNoImport) is
    # what actually tells them it's admin-gated.
    (group,) = navigation.menu.groups
    import_item = group.items[2]
    assert import_item.link_text == 'Edit floor plans'
    assert import_item.permissions == ['netbox_facilitymap.change_facilitymapblob']


def test_settings_item_is_gated_on_the_import_permission():
    # Settings is gated on the destructive import perm, not plain change — only importers/admins
    # see it, not everyday rack-placers (PERM-1).
    (group,) = navigation.menu.groups
    settings_item = group.items[3]
    assert settings_item.link_text == 'Settings'
    assert settings_item.permissions == ['netbox_facilitymap.import_facilitymapblob']


def test_module_exports_menu_not_menu_items():
    # NetBox registers both when both are present, which would list the plugin under its own
    # section AND the shared Plugins menu — so only `menu` is defined.
    assert hasattr(navigation, 'menu')
    assert not hasattr(navigation, 'menu_items')
