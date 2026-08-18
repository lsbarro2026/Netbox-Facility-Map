'use strict';
/* netbox.js — client for the NetBox read endpoints. Inside NetBox these are direct
   ORM queries restricted to the requester's object permissions; standalone they were
   the token-holding proxy. The UI never calls NetBox directly. */

class NetBoxClient {
  /** Rooms (child Locations) of a floor; falls back to all site Locations.
   *  Returns { floor:{...}|null, rooms:[{id,name,slug,description,url,parent,depth}] }. */
  async rooms(siteSlug, floorSlug) {
    return Api.get(`/api/netbox/rooms?site=${encodeURIComponent(siteSlug)}`
      + `&floor=${encodeURIComponent(floorSlug)}`);
  }

  /** Free-text Location search within a site. Returns
   *  { rooms:[...], truncated, truncated_depth, site_not_found }.
   *  Rows arrive **shallowest-first** — every root Location, then every root's children, and so on
   *  (IMPORT-49) — not in NetBox's MPTT tree order, whose depth-first walk put each floor's rooms
   *  between the floors and so let the cap clip a building down to a handful of them.
   *  `full` asks for the one-shot `NB_MATCH_CAP` instead of the per-keystroke `NB_LIST_CAP`
   *  (IMPORT-18's shape, as for `sites`/`buildingLocations`) — what `ImportFlow._loadFloors` passes,
   *  since it reads the site's Location list as a whole rather than typing into it.
   *  `truncated` flags a list the cap clipped and `truncated_depth` the tier it clipped at (null
   *  when it didn't), everything shallower being complete. A whole-list caller must not treat a
   *  clipped answer as complete *for the tiers at or below that depth* — `_loadFloors` compares it
   *  against where this building's floors sit before refusing to sweep stale assignments.
   *  `site_not_found` distinguishes "no Site answers to this slug" from "this site has no visible
   *  Locations" — both return an empty `rooms`, but only the first means the binding itself is
   *  broken. */
  async locations(siteSlug, q, full = false) {
    return Api.get(`/api/netbox/locations?site=${encodeURIComponent(siteSlug)}`
      + `&q=${encodeURIComponent(q || '')}` + (full ? '&full=1' : ''));
  }

  /** Create a child Location under a floor Location (LOC-1/LOC-2) — the first of the two NetBox
   *  *writes* the client makes. An opt-in bind escape-hatch: gated server-side on the off-by-default
   *  runtime `write_mode` master gate + the `inline_room_creation` add-on switch (SET-5) + the
   *  `dcim.add_location` permission, so the caller must first check
   *  `app.writeMode && app.inlineRoomCreation && app.canCreateLocation`. Resolves to the trimmed new Location
   *  `{id,name,slug,url,parent,...}`; throws (toastable `.message`) on a 400/403. */
  async createLocation(parentId, name) {
    return Api.post('/api/netbox/locations/create', { parent: parentId, name });
  }

  /** Free-text Site search (the import wizard binds each building to a Site).
   *  Returns { sites:[{id,name,slug,url}], truncated } — `truncated` when the server's row cap
   *  clipped the results, which the split step's one-shot pre-fetch has to know (TOPO-5).
   *  `full` asks for the higher one-shot cap (`NB_MATCH_CAP`) instead of the per-keystroke one
   *  (`NB_LIST_CAP`) — for the caller that matches the whole list at once rather than typing into
   *  it (IMPORT-18). `truncated` still reports the (now higher) ceiling honestly. */
  async sites(q, full = false) {
    return Api.get(`/api/netbox/sites?q=${encodeURIComponent(q || '')}`
      + (full ? '&full=1' : ''));
  }

  /** Free-text search for building-anchor **Locations** (Site = campus topology, MODEL-4): a
   *  building modelled as a `dcim.Location` beneath a campus Site, whose children are its floors.
   *  Sibling of `sites`, facility-scoped the same way (FACIL-1 — `?facility=` threaded by Api).
   *  Returns { locations:[{id,name,slug,site_slug,site_name,url}], truncated } — `site_slug` is the
   *  campus, which becomes the manifest `siteSlug`, and `slug` becomes the `buildingSlug`;
   *  `truncated` flags a list the server's cap clipped (TOPO-5, as for `sites`).
   *  `site` (a Site slug, optional) narrows the search to one campus — what a `site-as-campus`
   *  facility's bind step passes once its campus is chosen (MODEL-7). It narrows *within* the
   *  facility scope, so an out-of-facility slug simply returns nothing.
   *  `full` raises the row cap to the one-shot `NB_MATCH_CAP` (IMPORT-18) — as for `sites`, and
   *  the reason the split step can now propose buildings past the first couple hundred. */
  async buildingLocations(q, site, full = false) {
    return Api.get(`/api/netbox/building-locations?q=${encodeURIComponent(q || '')}`
      + (site ? `&site=${encodeURIComponent(site)}` : '') + (full ? '&full=1' : ''));
  }

  /** Facilities the picker offers (MULTI-2): every SiteGroup/Region — or, under the `location`
   *  grouping, top-level Location (MODEL-8) — the user may view, flagged whether it has an
   *  imported map, plus the default facility when it has content. Returns
   *  { grouping:'sitegroup'|'region'|'location', facilities:[{slug,name,has_content}] }.
   *  Facility-agnostic (no ?facility= appended). */
  async facilities() {
    return Api.get('/api/netbox/facilities');
  }

  /** Set the install-wide grouping the picker resolves against (MULTI-3):
   *  'sitegroup'|'region'|'location'.
   *  Admin-tier (import-gated) POST to the same facility-agnostic endpoint; returns
   *  { ok:true, grouping }. Pass `confirm=true` to proceed with a grouping *change* on an install
   *  that already holds map data — the server refuses it otherwise with a 409 (HEALTH-1), since the
   *  change re-scopes which facility each Site resolves to and can orphan existing blobs. The
   *  wizard passes `confirm` only after `FacilityChangeModal` has shown `groupingPreview()`'s
   *  before/after, so in the browser that 409 is unreachable by construction (MULTI-7). */
  async setGrouping(grouping, confirm = false) {
    return Api.post('/api/netbox/facilities', { grouping, confirm });
  }

  /** What changing the install-wide grouping to `grouping` would move (FACILITY-IDENTITY Phase 3):
   *  `{ grouping:{from,to}, moves:[{site,name,from,from_name,to,to_name,floors,rooms}],
   *  orphans:[{facility,name,kinds,suggested,already}], choices:[{slug,name}], assigned }`.
   *  Read-only — nothing is written, so previewing a change the user then cancels is free.
   *  Import-gated (it fronts an admin-tier action) and facility-agnostic. Backs the preview stage
   *  of `FacilityChangeModal`, which replaced the old blanket `window.confirm`. */
  async groupingPreview(grouping) {
    return Api.get('/api/netbox/facility-grouping-preview?grouping='
      + encodeURIComponent(grouping));
  }

  /** What shape this NetBox is, and which settings express it (TOPO-2) — the read-only probe behind
   *  the wizard's "detect my layout" route. Returns
   *  `{ current:{grouping}, inventory:{regions,site_groups,sites,locations:{total,by_depth,deeper,
   *  max_depth}}, candidates:[{grouping,org_mode,campus_site,campus_site_name,facilities,
   *  named_facilities,buildings,floors,rooms,unplaced_locations,floors_per_building,examples}],
   *  warnings:[{code,count,examples,detail}] }` — candidates **best first**, each a concrete
   *  settings triple with the numbers it implies and a few example object names per level, so the
   *  operator can eyeball the proposal instead of trusting it.
   *
   *  `sample` (optional) — `{ site, building, floor, room }` of object **ids**, any subset — switches
   *  to resolve-from-a-sample: the operator points at real objects and the response narrows
   *  `candidates` to the topology they imply, adding `sample:{ok,problems:[{code,detail}]}` which
   *  explains any contradiction (a "room" that isn't a child of the picked floor) rather than
   *  silently repairing it. Same envelope either way, so one renderer handles both.
   *
   *  Read-only — it proposes settings, it never writes one; write them with `setGrouping` /
   *  `api/settings/org-mode`. Import-gated (it fronts an admin-tier decision) and facility-agnostic:
   *  the grouping axis it surveys is install-wide and chosen before any facility exists. Throws
   *  (toastable `.message`) on a 400 — an exemplar id that names nothing the caller may view. */
  async topology(sample) {
    const q = ['site', 'building', 'floor', 'room']
      .filter(role => sample && sample[role] != null)
      .map(role => `${role}=${encodeURIComponent(sample[role])}`);
    return Api.get('/api/netbox/topology' + (q.length ? `?${q.join('&')}` : ''));
  }

  /** Search the real Sites/Locations the topology step's guided questions point at (TOPO-3) — the
   *  search sibling of `topology()`, whose ids become that call's `sample`. `kind` is `'site'` or
   *  `'location'`; `q` is the typed filter; for Locations `site` (a Site **id**) narrows to one site
   *  and `parent` (a Location id) to one Location's direct children, which is what chains the
   *  pickers into a site → building → floor → room drill-down. Returns
   *  `{ objects:[{id,name,slug,site_name,parent_name}] }`, capped at 200 server-side.
   *
   *  Deliberately **not** `sites()`/`buildingLocations()`: those are facility-scoped (FACIL-1) and
   *  this step is where the facility axis is still being chosen, so a facility-scoped search would
   *  come up empty on exactly the install being configured. Install-wide, object-permission scoped
   *  and import-gated server-side, facility-agnostic like the probe. Throws (toastable `.message`)
   *  on a 400 — an unknown `kind` or a non-numeric id. */
  async topologyObjects(kind, { q = '', site = null, parent = null } = {}) {
    const params = [`kind=${encodeURIComponent(kind)}`, `q=${encodeURIComponent(q || '')}`];
    if (site != null) params.push(`site=${encodeURIComponent(site)}`);
    if (parent != null) params.push(`parent=${encodeURIComponent(parent)}`);
    return Api.get(`/api/netbox/topology-objects?${params.join('&')}`);
  }

  /** Re-key facility `oldSlug`'s stranded map data to `newSlug` (blobs + rendered artifacts), the
   *  HEALTH-1 recovery offered inline by `FacilityChangeModal`'s reassign stage. Admin-tier
   *  (import-gated); returns `{ ok:true, kinds }` — the editor kinds actually moved — or rejects
   *  with the server's own validation message (unreachable target, nothing to move, or a collision
   *  that would overwrite the target). Same one write path as the Settings-page panel. */
  async reassignFacility(oldSlug, newSlug) {
    return Api.post('/api/netbox/facility-reassign', { old: oldSlug, new: newSlug });
  }

  /** The explicit Site→facility assignment map (FACILITY-IDENTITY Phase 1): the plugin-owned state
   *  `facility_for_site` consults *before* the SiteGroup/Region derivation, so an assigned Site's
   *  facility survives an org reorg. Returns `{ assignments: { site_slug: facility_slug } }`; a Site
   *  absent from it still derives. Login-only and facility-agnostic (the map is install-wide, so no
   *  ?facility= is appended). Read by the import wizard's bind step to render each bound site's
   *  assignment state (MULTI-6). */
  async facilityAssignments() {
    return Api.get('/api/netbox/facility-assignments');
  }

  /** Assign one Site to `facility` — or, with `facility === null`, drop its entry so the Site
   *  reverts to the grouping derivation. Admin-tier (import-gated) POST that merges into the map
   *  above; the server is the one write path (`facilities.assign_facilities`), validating the value
   *  as a strict slug and the key as a live Site. Returns `{ ok:true, assignments }` — the whole
   *  saved map, so a caller can refresh its cached copy from the response. */
  async assignFacility(siteSlug, facility) {
    return Api.post('/api/netbox/facility-assignments', { assignments: { [siteSlug]: facility } });
  }

  /** Racks in a Location. Returns { racks:[{id,name,url,u_height,description}] }. */
  async racks(locationId) {
    return Api.get(`/api/netbox/racks?location=${encodeURIComponent(locationId)}`);
  }

  /** Unracked devices in a Location. Returns { devices:[{id,name,url}] }. */
  async devices(locationId) {
    return Api.get(`/api/netbox/devices?location=${encodeURIComponent(locationId)}`);
  }

  /** Diagnostic gear counts on the Locations *near* a room's Location (PLACE-2) — its ancestor
   *  Locations plus the Site — so the empty placement panel can say where gear actually lives and
   *  how to reassign it. Diagnosis only; it does not broaden what `racks()`/`devices()` place.
   *  Returns { nearby:[{kind:'location'|'site', name, racks, devices, racks_url, devices_url}] },
   *  nearest scope first, scopes with no gear omitted. */
  async placementNearby(locationId) {
    return Api.get(`/api/netbox/placement-nearby?location=${encodeURIComponent(locationId)}`);
  }

  /** Free-text device-role search, backing the Settings page's access-point role picker (DEV-3).
   *  Facility-agnostic — device roles are global in NetBox, and the setting they configure is
   *  install-wide. Returns { roles:[{id,name,slug}] }, capped at 200 server-side. */
  async deviceRoles(q) {
    return Api.get(`/api/netbox/device-roles?q=${encodeURIComponent(q || '')}`);
  }

  /** Free-text `dcim.DeviceType` search, backing the AP tool's model picker (DEV-1). Searches the
   *  model name and its manufacturer's, since operators think in both ("Meraki" as readily as
   *  "MR46"). Facility-agnostic — device types are global in NetBox. Returns
   *  { device_types:[{id,model,manufacturer}] }, capped at 200 server-side (the combobox re-queries
   *  per keystroke, so the catalogue never has to fit in one payload). */
  async deviceTypes(q) {
    return Api.get(`/api/netbox/device-types?q=${encodeURIComponent(q || '')}`);
  }

  /** The name to pre-fill when a preset's device is dropped in a room (DEV-5, per-preset since
   *  DEV-8) — the preset's template expanded, plus a `-NN` counter unless its counter is off.
   *  Returns { name }. Suggested, not reserved: the user may edit it, and nothing holds it
   *  between here and the create.
   *
   *  `presetKey` names the stored preset; the server resolves the template, counter scope, and
   *  role from it — none of those ride the request.
   *
   *  `assetTag` feeds the template's optional `{asset_tag}` placeholder (DEV-6). It is sent only
   *  when non-empty, so a template that doesn't use the token issues exactly the request it always
   *  did. The tag is expanded server-side rather than patched into the response here so the `-NN`
   *  counter and the free-name probe run against the name that will actually be saved; a blank tag
   *  is the server's rule to apply (it drops the token and one adjacent separator), not ours.
   *
   *  Gated server-side like the create below (a name is only useful to someone who could use it),
   *  so the caller must first check `app.deviceTool && app.writeMode && app.canCreateDevice` and
   *  hold an enabled preset with a resolved role. Throws (toastable `.message`) on a 400/403 —
   *  including when the room Location can't be seen or the preset has no role configured. */
  async suggestDeviceName(locationId, presetKey, assetTag = '') {
    const tag = (assetTag || '').trim();
    return Api.get(`/api/netbox/devices/suggest-name?location=${encodeURIComponent(locationId)}`
      + `&preset=${encodeURIComponent(presetKey)}`
      + (tag ? `&asset_tag=${encodeURIComponent(tag)}` : ''));
  }

  /** Create an unracked `dcim.Device` in a room Location through a device-type preset (DEV-5,
   *  generalized by DEV-8): the plugin's second (and only other) NetBox *write*, alongside
   *  `createLocation`. Gated server-side on the device tool + write-mode switches and the
   *  `dcim.add_device` permission, so the caller must first check the gates; all three are
   *  re-checked server-side.
   *
   *  Deliberately narrow: `role` is resolved from the stored preset server-side and never sent,
   *  `rack` is always null, and `site` comes from the room — so a caller can't point any of them
   *  elsewhere. Of the optional fields (`asset_tag`/`serial`/`description`/`status`) the server
   *  reads ONLY the ones the preset prompts for; a blank `asset_tag` stores as NULL. Resolves to
   *  the trimmed new Device `{id,name,url,role,device_type}` — the same shape the rack inventory
   *  returns, so a marker can render it. Throws (toastable `.message`) on a 400 (duplicate
   *  name/asset tag, unknown type/preset) or a 403. */
  async createDevice(body) {
    return Api.post('/api/netbox/devices/create', body);
  }

  /** Facility-wide room/rack/device search for the siteplan wayfinding finder's *unplaced* results
   *  (NAV-3): the NetBox items that were never drawn/placed on the map. Facility-scoped (FACIL-1 —
   *  `?facility=` threaded by Api). Each result carries its floor Location's `(site_slug,floor_slug)`
   *  (== a manifest `(dir,fid)`) + display names, so the finder can resolve the map floor, dedup
   *  against placed items by NetBox id, and label a row whose floor isn't mapped. Short queries
   *  return empty server-side. Returns { rooms:[...], racks:[...], devices:[...] }. */
  async inventory(q) {
    return Api.get(`/api/netbox/inventory?q=${encodeURIComponent(q || '')}`);
  }

  /** Free-text search over active NetBox users, backing the to-do assignee picker (TASK-2).
   *  Facility-agnostic — users aren't scoped to a facility. Returns
   *  { users:[{id,username,display,initials}] }, capped at 200 server-side. */
  async users(q) {
    return Api.get(`/api/users?q=${encodeURIComponent(q || '')}`);
  }
}
