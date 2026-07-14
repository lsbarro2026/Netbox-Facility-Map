"""Plugin navigation.

A dedicated top-level `PluginMenu` (label **Facility Map**, `mdi mdi-floor-plan` icon) so the
plugin gets its own sidebar section instead of living under NetBox's shared **Plugins** menu.
It carries two `PluginMenuItem`s: **Facility Map** (the full-page map, gated on
`view_facilitymapblob`) and **Settings** (the settings page, gated on the destructive-surface
permission `import_facilitymapblob` so only importers/admins see it — not the everyday
rack-placers who hold `change_facilitymapblob`; see PERM-1). NetBox auto-discovers `menu`.

Only `menu` is defined — not `menu_items` — because NetBox registers both when both are present,
which would list the plugin under *both* its own section and the shared Plugins menu.
"""

from netbox.plugins import PluginMenu, PluginMenuItem

from . import capabilities

menu = PluginMenu(
    label='Facility Map',
    icon_class='mdi mdi-floor-plan',
    groups=(
        # The core items, plus any nav items contributed by an enabled optional capability (the
        # add-on framework, ADDON-2): a capability that adds a nav entry contributes it via
        # `nav_items()` rather than editing this tuple. Empty until a feature capability ships one.
        ('Facility Map', (
            PluginMenuItem(
                link='plugins:netbox_facilitymap:map',
                link_text='Facility Map',
                permissions=['netbox_facilitymap.view_facilitymapblob'],
            ),
            # Editable plugin settings. Gated on the import permission (like the settings view
            # itself), so only importers/admins — not everyday rack-placers — see the entry.
            PluginMenuItem(
                link='plugins:netbox_facilitymap:settings',
                link_text='Settings',
                permissions=['netbox_facilitymap.import_facilitymapblob'],
            ),
        ) + tuple(capabilities.all_nav_items())),
    ),
)
