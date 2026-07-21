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

  /** Free-text Location search within a site. Returns { rooms:[...] }. */
  async locations(siteSlug, q) {
    return Api.get(`/api/netbox/locations?site=${encodeURIComponent(siteSlug)}`
      + `&q=${encodeURIComponent(q || '')}`);
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
   *  Returns { sites:[{id,name,slug,url}] }. */
  async sites(q) {
    return Api.get(`/api/netbox/sites?q=${encodeURIComponent(q || '')}`);
  }

  /** Free-text search for building-anchor **Locations** (Site = campus topology, MODEL-4): a
   *  building modelled as a `dcim.Location` beneath a campus Site, whose children are its floors.
   *  Sibling of `sites`, facility-scoped the same way (FACIL-1 — `?facility=` threaded by Api).
   *  Returns { locations:[{id,name,slug,site_slug,site_name,url}] } — `site_slug` is the campus,
   *  which becomes the manifest `siteSlug`, and `slug` becomes the `buildingSlug`. */
  async buildingLocations(q) {
    return Api.get(`/api/netbox/building-locations?q=${encodeURIComponent(q || '')}`);
  }

  /** Facilities the picker offers (MULTI-2): every SiteGroup/Region the user may view, flagged
   *  whether it has an imported map, plus the default facility when it has content. Returns
   *  { grouping:'sitegroup'|'region', facilities:[{slug,name,has_content}] }. Facility-agnostic
   *  (no ?facility= appended). */
  async facilities() {
    return Api.get('/api/netbox/facilities');
  }

  /** Set the install-wide grouping the picker resolves against (MULTI-3): 'sitegroup'|'region'.
   *  Admin-tier (import-gated) POST to the same facility-agnostic endpoint; returns
   *  { ok:true, grouping }. Pass `confirm=true` to proceed with a grouping *change* on an install
   *  that already holds map data — the server refuses it otherwise with a 409 (HEALTH-1), since the
   *  change re-scopes which facility each Site resolves to and can orphan existing blobs. */
  async setGrouping(grouping, confirm = false) {
    return Api.post('/api/netbox/facilities', { grouping, confirm });
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

  /** The name to pre-fill when an AP is dropped in a room (DEV-5) — the configured template
   *  expanded, plus a `-NN` counter unless the counter is off. Returns { name }. Suggested, not
   *  reserved: the user may edit it, and nothing holds it between here and the create.
   *
   *  `assetTag` feeds the template's optional `{asset_tag}` placeholder (DEV-6). It is sent only
   *  when non-empty, so a template that doesn't use the token issues exactly the request it always
   *  did. The tag is expanded server-side rather than patched into the response here so the `-NN`
   *  counter and the free-name probe run against the name that will actually be saved; a blank tag
   *  is the server's rule to apply (it drops the token and one adjacent separator), not ours.
   *
   *  Gated server-side like the create below (a name is only useful to someone who could use it),
   *  so the caller must first check `app.apTool && app.writeMode && app.canCreateDevice &&
   *  app.apDeviceRole`. Throws (toastable `.message`) on a 400/403 — including when the room
   *  Location can't be seen or no AP role is configured. */
  async suggestDeviceName(locationId, assetTag = '') {
    const tag = (assetTag || '').trim();
    return Api.get(`/api/netbox/devices/suggest-name?location=${encodeURIComponent(locationId)}`
      + (tag ? `&asset_tag=${encodeURIComponent(tag)}` : ''));
  }

  /** Create an unracked `dcim.Device` — an access point — in a room Location (DEV-5): the plugin's
   *  second (and only other) NetBox *write*, alongside `createLocation`. Gated server-side on the
   *  AP tool + write-mode switches and the `dcim.add_device` permission, so the caller must first
   *  check the gates; all three are re-checked server-side.
   *
   *  Deliberately narrow: `role` is read from the settings blob server-side and never sent, `rack`
   *  is always null, and `site` comes from the room — so a caller can't point any of them
   *  elsewhere. `asset_tag` is optional (blank stores as NULL). Resolves to the trimmed new Device
   *  `{id,name,url,role,device_type}` — the same shape the rack inventory returns, so a marker can
   *  render it. Throws (toastable `.message`) on a 400 (duplicate name/asset tag, unknown type) or
   *  a 403. */
  async createDevice({ location, device_type, name, asset_tag }) {
    return Api.post('/api/netbox/devices/create', { location, device_type, name, asset_tag });
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
