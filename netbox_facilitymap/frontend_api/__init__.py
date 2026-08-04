"""JSON endpoints for the map frontend.

These replace the standalone `server.py` routes. They are plain Django views (not
DRF) mounted *under the plugin's page mount* (`/plugins/facilitymap/api/...`), so they
ride NetBox's session auth and Django's CSRF middleware directly — the frontend posts
its session CSRF token in the `X-CSRFToken` header (see `Api.post` in `lib.js`). The
contract (paths, request/response shapes) is identical to the old server so the
framework-free frontend is reused unchanged.

Named `frontend_api`, **not** `api`, so it can't be shadowed by the `api/` DRF REST package
NetBox auto-discovers (§10). That is a property of the *name*, so it holds for the package
exactly as it did for the single module this used to be — and nothing here folds into `api/`.

Six families:
  * Annotations — `AnnotationsView`: room polygons are the relational `Room` model
    (Phase 4), while each floor's `image`/`w`/`h`/`arrows` stay in the `annotations`
    blob. GET composes the whole-document shape (blob floors + `Room` rows merged back
    in); POST decomposes it (rooms → `Room` rows, the rest → the blob). The frontend
    round-trips byte-for-byte and is unchanged. GET rides the map-read gate; POST
    requires `EDIT_PERM`.
  * Blob persistence — `siteplan` / `placements` / `layouts`: GET returns the whole
    stored document (or its default), POST upserts it. One `FacilityMapBlob` row per
    kind. GET rides the map-read gate; POST requires `EDIT_PERM`.
  * Floor to-do list — `TodosView`/`TodoView`/`TodoDeleteView`: a per-room to-do list
    (`RoomTodo`) for tracking floor work. GET lists a floor's to-dos grouped by room;
    POST creates/updates/deletes one. GET rides the map-read gate; POST requires
    `EDIT_PERM`.
  * Users lookup — `UsersView`: a searchable list of active NetBox users, backing the
    to-do assignee picker. Rides the map-read gate only — no `EDIT_PERM`, since a
    viewer must be able to render assignee avatars on existing to-dos without edit
    rights.
  * NetBox reads/writes — `netbox/rooms`, `netbox/locations`, `netbox/sites`,
    `netbox/facilities`, `netbox/racks`, `netbox/devices`, `netbox/device-roles`,
    `netbox/device-types`, `netbox/devices/suggest-name`: direct ORM queries over
    `dcim` models, restricted by the requester's object permissions, replacing the
    token-holding proxy. There is no longer a persisted `rackcache` — racks/devices are
    fetched live per room. Two of these are the plugin's only writes into `dcim` core —
    `netbox/locations/create` and `netbox/devices/create` — each gated by an
    install-wide setting plus the matching `dcim.add_location`/`dcim.add_device` object
    permission, on top of the ordinary login gate the reads use.
  * Settings — `FloorLabelFieldSettingView`, `DefaultFacilitySettingView`,
    `WriteModeSettingView`, `ApToolSettingView`, `ApDeviceRoleSettingView`,
    `ApNamingSettingView`, plus `NbFacilitiesView`'s POST half: install-wide
    configuration posted from the map's own `#/settings` page, merged into the single
    install-wide `settings` blob. Login-gated, and additionally requires
    `IMPORT_PERM` — admin-tier configuration, stricter than a login-only NetBox read.

## Layout

One module per family, so no file holds two unrelated concerns:

  | module             | holds                                                       |
  |--------------------|-------------------------------------------------------------|
  | `common.py`        | the row caps, `?facility=` parse, JSON-body parse, room scope |
  | `serializers.py`   | every row → JSON-safe dict shaper                            |
  | `blobs.py`         | blob persistence + concurrency + `BlobView`                  |
  | `annotations.py`   | the `Room` sync engine + `AnnotationsView`                   |
  | `todos.py`         | the to-do endpoints + the users lookup                       |
  | `netbox_reads.py`  | rooms/locations/sites/building-anchors + Location create      |
  | `facility_admin.py`| facilities, assignments, grouping preview + re-key           |
  | `topology_views.py`| the DCIM topology probe + its object search                  |
  | `settings_views.py`| `_SettingView` + its subclasses + per-facility org mode      |
  | `devices.py`       | racks/devices/roles/types + the AP tool's write path         |
  | `inventory.py`     | the finder's facility-wide inventory search                  |

This module is the **facade**: the names below are the package's public surface, so
`urls.py`, `views.py`, `api/`, `backup.py`, the management commands and the tests all keep
addressing `frontend_api.X` regardless of which module X now lives in. Import from here, not
from a submodule, unless you specifically need to reach past the facade — the one case being
a test that patches a module-level constant (`frontend_api.common.NB_LIST_CAP`), which must
name the module that *defines* it for the patch to be seen.
"""

from .annotations import (
    AnnotationsView, _split_annotations, compose_annotations, resolve_floor_location, sync_rooms,
    touch_floor_version,
)
from .blobs import (
    BLOB_DEFAULTS, VERSION_HEADER, BlobView, _blob_version, _conflict_response,
    _delete_blob_shard, _hotspot_site, _merge_hidden_hotspots, _placements_with_urls, _save_blob,
    _scope_siteplan, _sent_shard_versions, _shard_conflicts, _shard_versions, _version_conflict,
    merge_settings,
)
from .common import (
    NB_LIST_CAP, NB_MATCH_CAP, _capped, _facility, _list_cap, _parse_json_body, _scope_rooms,
)
from .devices import (
    NbDeviceCreateView, NbDeviceRolesView, NbDevicesView, NbDeviceSuggestNameView,
    NbDeviceTypesView, NbPlacementNearbyView, NbRacksView, _ap_count_qs, _ap_write_gate,
    _role_short,
)
from .facility_admin import (
    NbFacilitiesView, NbFacilityAssignmentsView, NbFacilityGroupingPreviewView,
    NbFacilityReassignView,
)
from .inventory import NbInventoryView
from .netbox_reads import (
    NbBuildingLocationsView, NbLocationCreateView, NbLocationsView, NbRoomsView, NbSitesView,
)
from .serializers import (
    _inv_placement, _inv_racked_device, _inv_room, _serialize_room, _serialize_todo, _trim,
    _trim_device, _trim_rack, abs_url, display_name, floor_ref, serialize_user,
)
from .settings_views import (
    ApDeviceRoleSettingView, ApNamingSettingView, ApToolSettingView, DefaultFacilitySettingView,
    FloorLabelFieldSettingView, InlineRoomCreationSettingView, OrgModeSettingView,
    RenderHqSettingView, TodosSettingView, WriteModeSettingView, _SettingView,
)
from .todos import (
    FacilityTodosView, TodoDeleteView, TodoFeatureGateMixin, TodosView, TodoView, UsersView,
    _apply_todo_fields, _resolve_assignees, _todos_for,
)
from .topology_views import NbTopologyObjectsView, NbTopologyView

__all__ = [
    # Views, in route order (see urls.py).
    'AnnotationsView', 'BlobView',
    'NbRoomsView', 'NbLocationsView', 'NbLocationCreateView', 'NbSitesView',
    'NbBuildingLocationsView', 'NbFacilitiesView', 'NbFacilityAssignmentsView',
    'NbFacilityGroupingPreviewView', 'NbFacilityReassignView', 'NbTopologyView',
    'NbTopologyObjectsView', 'NbRacksView', 'NbDevicesView', 'NbPlacementNearbyView',
    'NbDeviceRolesView', 'NbDeviceTypesView', 'NbDeviceSuggestNameView', 'NbDeviceCreateView',
    'NbInventoryView',
    'TodosView', 'FacilityTodosView', 'TodoView', 'TodoDeleteView', 'UsersView',
    'FloorLabelFieldSettingView', 'DefaultFacilitySettingView', 'WriteModeSettingView',
    'OrgModeSettingView', 'InlineRoomCreationSettingView', 'RenderHqSettingView',
    'TodosSettingView', 'ApToolSettingView', 'ApDeviceRoleSettingView', 'ApNamingSettingView',
    # The library surface other backend modules call.
    'VERSION_HEADER', 'merge_settings', 'serialize_user', 'sync_rooms', 'resolve_floor_location',
    'touch_floor_version', 'compose_annotations',
]
