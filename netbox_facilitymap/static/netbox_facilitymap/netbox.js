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

  /** Create a child Location under a floor Location (LOC-1) — the one NetBox *write* the client
   *  makes. An opt-in bind escape-hatch: gated server-side on the off-by-default
   *  `allow_location_create` flag + the `dcim.add_location` permission, so the caller must first
   *  check `app.hasCapability('location-create') && app.canCreateLocation`. Resolves to the trimmed
   *  new Location `{id,name,slug,url,parent,...}`; throws (toastable `.message`) on a 400/403. */
  async createLocation(parentId, name) {
    return Api.post('/api/netbox/locations/create', { parent: parentId, name });
  }

  /** Free-text Site search (the import wizard binds each building to a Site).
   *  Returns { sites:[{id,name,slug,url}] }. */
  async sites(q) {
    return Api.get(`/api/netbox/sites?q=${encodeURIComponent(q || '')}`);
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
}
