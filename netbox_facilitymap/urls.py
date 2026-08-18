"""URL map for the plugin, rooted at `/plugins/facilitymap/`.

Routes the full-page map (`MapView`) and settings page (`SettingsView`), plus the browser
JSON endpoints the frontend calls: blob persistence (`frontend_api`), the PDF-import pipeline
(`uploads` for ingestion, `imports` for the scan/build workflow) and authenticated
media/manifest serving (`serving`). These `api/` paths mirror the standalone tool's logical
layout and are exposed to the frontend via `window.MAP.api` in index.html; they are distinct
from the DRF REST package under `api/`.
"""

from django.urls import path

from . import capabilities, frontend_api, imports, serving, uploads, views

urlpatterns = [
    path('', views.MapView.as_view(), name='map'),

    # The facility-wide to-do page's nav entry (TASK-5). The page itself is an SPA route
    # (`#/todo`), but a PluginMenuItem links by URL *name*, so this is the reversible URL that
    # lands there. Also makes the page linkable/bookmarkable without a hash.
    path('todo', views.TodoTabView.as_view(), name='todo'),

    # The change-only editor's nav-reachable door into the in-app import/edit flow (`#/import`,
    # HEALTH-8) — same reversible-URL-name shape as `todo` above, for the same reason.
    path('import', views.ImportTabView.as_view(), name='import'),

    # In-app plugin settings (permission-gated write). Reached from the plugin nav.
    path('settings', views.SettingsView.as_view(), name='settings'),

    # Editor data (blob persistence) — same logical paths as the standalone server,
    # rooted here at /plugins/facilitymap/api/ (see window.MAP.api in index.html).
    path('api/annotations', frontend_api.AnnotationsView.as_view(), name='api-annotations'),
    path('api/siteplan', frontend_api.BlobView.as_view(kind='siteplan'), name='api-siteplan'),
    path('api/rackplacements', frontend_api.BlobView.as_view(kind='placements', sharded=True),
         name='api-placements'),
    path('api/pagelayouts', frontend_api.BlobView.as_view(kind='layouts', sharded=True),
         name='api-layouts'),

    # NetBox reads (replace the token-holding proxy with direct ORM queries,
    # restricted by the requester's object permissions).
    path('api/netbox/rooms', frontend_api.NbRoomsView.as_view(), name='api-nb-rooms'),
    path('api/netbox/locations', frontend_api.NbLocationsView.as_view(), name='api-nb-locations'),
    # The plugin's one write into dcim core (LOC-1/LOC-2): create a child Location under a floor
    # Location. Gated on the off-by-default runtime `write_mode` master gate + the
    # `inline_room_creation` add-on switch (SET-5) + the `dcim.add_location` object permission (all
    # enforced in the view), unlike the login-only reads above.
    path('api/netbox/locations/create', frontend_api.NbLocationCreateView.as_view(),
         name='api-nb-location-create'),
    path('api/netbox/sites', frontend_api.NbSitesView.as_view(), name='api-nb-sites'),
    # Sibling of api/netbox/sites for the Site = campus topology: candidate building-anchor
    # Locations, facility-scoped the same way (FACIL-1, MODEL-4).
    path('api/netbox/building-locations', frontend_api.NbBuildingLocationsView.as_view(),
         name='api-nb-building-locations'),
    path('api/netbox/facilities', frontend_api.NbFacilitiesView.as_view(), name='api-nb-facilities'),
    # The explicit Site→facility assignment map (FACILITY-IDENTITY Phase 1) — the write surface
    # the Phase-2 wizard assignment step uses.
    path('api/netbox/facility-assignments', frontend_api.NbFacilityAssignmentsView.as_view(),
         name='api-nb-facility-assignments'),
    # The Phase-3 reassignment modal's two halves (MULTI-7): the read-only before/after a pending
    # grouping change would produce, and the inline re-key of whatever it strands. Both IMPORT_PERM
    # (they front/are an admin-tier action), unlike the login-only reads above.
    path('api/netbox/facility-grouping-preview', frontend_api.NbFacilityGroupingPreviewView.as_view(),
         name='api-nb-facility-grouping-preview'),
    path('api/netbox/facility-reassign', frontend_api.NbFacilityReassignView.as_view(),
         name='api-nb-facility-reassign'),
    # The read-only DCIM topology probe (TOPO-2): what shape is this NetBox, and which
    # grouping/org-mode/campus triple expresses it. IMPORT_PERM like the preview above (it fronts the
    # same admin-tier decision), but object-permission scoped like the ordinary reads.
    path('api/netbox/topology', frontend_api.NbTopologyView.as_view(), name='api-nb-topology'),
    # The probe's search sibling (TOPO-3): name the real Sites/Locations the wizard's guided
    # questions point at, so they can be fed back as exemplar pks above. Install-wide scope like the
    # probe (the facility axis is what's being decided), object-scoped and IMPORT_PERM the same way.
    path('api/netbox/topology-objects', frontend_api.NbTopologyObjectsView.as_view(),
         name='api-nb-topology-objects'),
    path('api/netbox/racks', frontend_api.NbRacksView.as_view(), name='api-nb-racks'),
    path('api/netbox/devices', frontend_api.NbDevicesView.as_view(), name='api-nb-devices'),
    # Read-only diagnostic for the empty placement panel (PLACE-2): counts gear on the room's
    # nearby Locations (ancestors + Site) so the panel can point the user at where to reassign it.
    path('api/netbox/placement-nearby', frontend_api.NbPlacementNearbyView.as_view(),
         name='api-nb-placement-nearby'),
    # Backs the preset editor's role picker and the View filter's role rows (DEV-3);
    # object-permission scoped like the reads above, and facility-agnostic (device roles are
    # global in NetBox).
    path('api/netbox/device-roles', frontend_api.NbDeviceRolesView.as_view(),
         name='api-nb-device-roles'),
    # Backs the Add-device dialog's model picker (DEV-5); an ordinary object-scoped,
    # facility-agnostic read like device-roles above.
    path('api/netbox/device-types', frontend_api.NbDeviceTypesView.as_view(),
         name='api-nb-device-types'),
    # The plugin's second write into dcim core (DEV-5, per-preset since DEV-8) and the name it
    # suggests: create an unracked Device in a room through a device-type preset. Both gated in
    # the view on the device tool + write mode + the `dcim.add_device` permission
    # (`_device_write_gate`) — suggest-name included, since a name is only useful to a caller who
    # could create the device.
    path('api/netbox/devices/suggest-name', frontend_api.NbDeviceSuggestNameView.as_view(),
         name='api-nb-device-suggest-name'),
    path('api/netbox/devices/create', frontend_api.NbDeviceCreateView.as_view(),
         name='api-nb-device-create'),
    # Facility-wide room/rack/device search for the siteplan wayfinding finder's unplaced results
    # (NAV-3). Facility-scoped like /api/netbox/sites (FACIL-1), so it's threaded ?facility= via
    # lib.js FACILITY_PREFIXES; object-permission scoped like the reads above.
    path('api/netbox/inventory', frontend_api.NbInventoryView.as_view(), name='api-nb-inventory'),

    # Floor to-do list (ADDON-1): per-room notes on the floor page. GET/create on the collection,
    # update/delete on a single item. The Api client is GET/POST-only, so update and delete are
    # POSTs rather than PATCH/DELETE. Reads ride the map-read gate; writes require EDIT_PERM.
    path('api/todos', frontend_api.TodosView.as_view(), name='api-todos'),
    # The facility-wide rollup behind the to-do page (TASK-5): every floor's to-dos in one read,
    # nested `floor_key -> room_id`. Explicitly `?facility=`-scoped (threaded by lib.js
    # FACILITY_PREFIXES), unlike the per-floor read whose `floor_key` already implies a facility.
    # `<int:pk>` below can't match `all`, so the two are unambiguous in either order.
    path('api/todos/all', frontend_api.FacilityTodosView.as_view(), name='api-todos-all'),
    path('api/todos/<int:pk>', frontend_api.TodoView.as_view(), name='api-todo'),
    path('api/todos/<int:pk>/delete', frontend_api.TodoDeleteView.as_view(), name='api-todo-delete'),

    # Active-user lookup (TASK-2): backs the to-do assignee picker. Rides the map-read gate like
    # the to-do reads above, not EDIT_PERM — a viewer must be able to render existing assignees.
    path('api/users', frontend_api.UsersView.as_view(), name='api-users'),

    # In-app settings the SPA #/settings page owns (SET-1). NetBox-interaction settings (the
    # room_embed_* controls, facility_grouping) stay on the chrome'd views.SettingsView; everything
    # else lives here. Admin-tier writes (IMPORT_PERM), merged into the install-wide settings blob.
    path('api/settings/floor-label-field', frontend_api.FloorLabelFieldSettingView.as_view(),
         name='api-settings-floor-label-field'),
    path('api/settings/default-facility', frontend_api.DefaultFacilitySettingView.as_view(),
         name='api-settings-default-facility'),
    path('api/settings/write-mode', frontend_api.WriteModeSettingView.as_view(),
         name='api-settings-write-mode'),
    # The facility's DCIM organization mode (MODEL-6) — the one *per-facility* settings endpoint, so
    # it takes its facility in the body (the `/api/settings` prefix is install-wide to Api).
    path('api/settings/org-mode', frontend_api.OrgModeSettingView.as_view(),
         name='api-settings-org-mode'),
    # The inline-room-creation write add-on's own switch (SET-5), sitting on top of write mode's
    # master gate — the Location-create endpoint above checks both.
    path('api/settings/inline-room-creation', frontend_api.InlineRoomCreationSettingView.as_view(),
         name='api-settings-inline-room-creation'),
    # High-quality floor-plan rendering (READ-1). Read by the import build, not the map, so it only
    # bites on the next import/rebuild.
    path('api/settings/render-hq', frontend_api.RenderHqSettingView.as_view(),
         name='api-settings-render-hq'),
    # The to-do feature's install-wide on/off switch (ADDON-4), a general (non-write) add-on — so it
    # sits with the settings family, not behind write mode.
    path('api/settings/todos', frontend_api.TodosSettingView.as_view(),
         name='api-settings-todos'),
    # Device-placement tool configuration (DEV-3, generalized by DEV-8): the feature switch, and
    # the device-type presets as ONE list endpoint — create/edit/delete/reorder are all "send the
    # new list", so the stored order is the toolbar order and there is exactly one write path.
    path('api/settings/device-tool', frontend_api.DeviceToolSettingView.as_view(),
         name='api-settings-device-tool'),
    path('api/settings/device-presets', frontend_api.DevicePresetsSettingView.as_view(),
         name='api-settings-device-presets'),

    # PDF import (permission-gated) + authenticated serving of the rendered result.
    path('api/import/upload', uploads.UploadView.as_view(), name='api-import-upload'),
    path('api/import/upload-zip', uploads.UploadZipView.as_view(), name='api-import-upload-zip'),
    path('api/import/scan', imports.ScanView.as_view(), name='api-import-scan'),
    path('api/import/preview', imports.PreviewView.as_view(), name='api-import-preview'),
    path('api/import/ocr-read', imports.OcrReadView.as_view(), name='api-import-ocr-read'),
    path('api/import/build', imports.BuildView.as_view(), name='api-import-build'),
    # The rebuild-in-place pair (IMPORT-74): read the live import map, then re-render from it
    # without posting one — how the Settings page acts on a render-setting change.
    path('api/import/map', imports.ImportMapView.as_view(), name='api-import-map'),
    path('api/import/rebuild', imports.RebuildView.as_view(), name='api-import-rebuild'),
    path('api/import/reset', imports.ResetView.as_view(), name='api-import-reset'),
    path('api/import/regroup', imports.RegroupView.as_view(), name='api-import-regroup'),
    path('api/import/save-draft', imports.SaveDraftView.as_view(), name='api-import-save-draft'),
    path('api/import/load-draft', imports.LoadDraftView.as_view(), name='api-import-load-draft'),

    # Full-archive backup export (import-gated) + destructive restore (import + superuser).
    path('api/backup/export', imports.ExportArchiveView.as_view(), name='api-backup-export'),
    path('api/backup/restore', imports.RestoreArchiveView.as_view(), name='api-backup-restore'),

    # Full plugin data wipe — DB rows *and* working-dir files (import + superuser, HEALTH-12). Its
    # own `api/data/` prefix on purpose: it is neither the import wizard's workflow (`api/import/`,
    # where the lesser working-dir-only `reset` lives) nor archive I/O (`api/backup/`).
    path('api/data/wipe', imports.WipeView.as_view(), name='api-data-wipe'),

    path('api/manifest', serving.ManifestView.as_view(), name='api-manifest'),
    path('api/media/<path:path>', serving.MediaView.as_view(), name='api-media'),
]

# Routes contributed by enabled optional capabilities (the add-on framework, ADDON-2): a capability
# that adds a backend endpoint appends its `path()`s here rather than editing this file. Empty until
# a feature capability ships one (the shipped format-extra capabilities add no routes).
urlpatterns += capabilities.all_url_patterns()
