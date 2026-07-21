"""Plugin navigation.

A dedicated top-level `PluginMenu` (label **Facility Map**, `mdi mdi-floor-plan` icon) so the
plugin gets its own sidebar section instead of living under NetBox's shared **Plugins** menu.
It carries four `PluginMenuItem`s: **Facility Map** (the full-page map) and **To-do** (the
facility-wide to-do page, TASK-5), both gated on `view_facilitymapblob`; then **Edit floor plans**
(the nav-reachable door into the in-app import/edit flow, HEALTH-8), gated on
`change_facilitymapblob` so an everyday rack-placer can discover that plan edits exist and are
admin-gated, even without import permission; then **Settings** (the settings page, gated on the
destructive-surface permission `import_facilitymapblob` so only importers/admins see it — not the
everyday rack-placers who hold `change_facilitymapblob`; see PERM-1). NetBox auto-discovers `menu`.

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
            # The facility-wide to-do page (TASK-5). Links to `TodoTabView`, which redirects into
            # the map shell's `#/todo` route — a menu item links by URL name and can't carry the
            # fragment itself. Read-gated like the map: a viewer who can see the floors can see
            # their work, and the page's own writes are re-checked server-side.
            PluginMenuItem(
                link='plugins:netbox_facilitymap:todo',
                link_text='To-do',
                permissions=['netbox_facilitymap.view_facilitymapblob'],
            ),
            # Nav-reachable door into the in-app import/edit flow (`#/import`, HEALTH-8). Gated on
            # `change_facilitymapblob`, not the import permission — the destination itself
            # (App.showImport -> App.canImport) already degrades gracefully for anyone who lacks
            # import permission, landing on App.showNoImport()'s "ask an administrator" signpost.
            # An importer typically holds both permissions and sees this alongside `Settings`'
            # own "Edit buildings & floors" button — a small, deliberate duplication, the same way
            # `To-do` above duplicates a way into the map.
            PluginMenuItem(
                link='plugins:netbox_facilitymap:import',
                link_text='Edit floor plans',
                permissions=['netbox_facilitymap.change_facilitymapblob'],
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
