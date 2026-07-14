'use strict';
/* store.js — single source of truth for loaded + edited data, plus persistence.
   Holds the manifest (read-only), room annotations, and user siteplan hotspots.
   Owns dirty flags; notifies via onDirty(kind) so views can refresh save badges. */

class Store {
  constructor() {
    this.manifest = null;          // { siteplan, buildings:[...] } from manifest.json
    this.annotations = {};         // "dir/floorId" -> { image,w,h, rooms:[...] }
    this.siteHotspots = [];        // user-drawn building hotspots [{id,dir,name,poly}]
    this.dirty = false;            // unsaved room annotations
    this.siteDirty = false;        // unsaved siteplan hotspots
    this.placementsDirty = false;  // unsaved rack/device placements
    this.nbRoomsByFloor = {};      // cache: floorKey -> NetBox rooms response
    this.rackCache = { locations: {} };  // in-memory rack inventory, fetched live per Location
    this.placements = {};          // "dir/floorId" -> { placements:[...] }
    this.layouts = {};             // "dir/floorId" -> { grid:[[col,row],...] } (sheet arrangement)
    this.layoutDirty = false;      // unsaved sheet arrangement
    this.onDirty = null;           // optional callback(kind:'floor'|'site'|'racks')
    // Optimistic-concurrency tokens per document (CONC-1): captured on load, sent back on
    // save, refreshed from the save response. A save with a stale token gets a 409 so a
    // concurrent editor's rooms aren't clobbered. Null until the document is first loaded.
    this.versions = { annotations: null, siteplan: null, placements: null, layouts: null };
  }

  /** Critical-path boot fetch: only what the siteplan (the always-first paint, and the
   *  only view the dashboard-widget embed renders) needs — the manifest + siteplan
   *  hotspots. The manifest is a render artifact served by an authenticated endpoint (it
   *  lives in the working dir under MEDIA_ROOT, not the public static tree). Both GETs are
   *  independent, so fetch in parallel; Promise.all rejects on the first failure, so
   *  App.init's "Failed to load" catch still fires with a useful message. */
  async loadCore() {
    // Fetch the manifest through the logical `/api/manifest` path so Api rebases it onto the
    // plugin mount AND appends the active `?facility=` (see Api._url). Standalone (no window.MAP)
    // keeps the flat-file fallback.
    const manifestUrl = window.MAP ? '/api/manifest' : '/manifest.json';
    const [manifest, siteplan] = await Promise.all([
      Api.get(manifestUrl),
      Api.getV('/api/siteplan'),
    ]);
    this.manifest = manifest;
    this.siteHotspots = siteplan.data.hotspots || [];
    this.versions.siteplan = siteplan.version;
  }

  /** Deferred, off-critical-path bundle: the floor-level documents nothing needs until a
   *  building or floor opens. Warmed after the siteplan paints (standalone) and skipped
   *  entirely in the embed; App.ensureFloorData awaits it before the building/floor views. */
  async loadFloorData() {
    const [annotations, placements, layouts] = await Promise.all([
      Api.getV('/api/annotations'),
      Api.getV('/api/rackplacements'),
      Api.getV('/api/pagelayouts'),
    ]);
    this.annotations = annotations.data;
    this.placements = placements.data;
    this.layouts = layouts.data;
    this.versions.annotations = annotations.version;
    this.versions.placements = placements.version;
    this.versions.layouts = layouts.version;
  }

  /** Full boot fetch (core + floor data). Used by the import wizard's post-rebuild reload,
   *  which then prunes orphaned floors from `annotations` and re-saves — that must run
   *  against fully-loaded annotations, so this path stays eager. */
  async load() { await Promise.all([this.loadCore(), this.loadFloorData()]); }

  /** Re-fetch just the siteplan hotspots (the mutable half of loadCore's boot fetch),
   *  without disturbing the read-only manifest. Used by discard(). */
  async loadSiteplan() {
    const siteplan = await Api.getV('/api/siteplan');
    this.siteHotspots = siteplan.data.hotspots || [];
    this.versions.siteplan = siteplan.version;
  }

  /** Drop all unsaved edits by re-fetching authoritative server state for whichever
   *  scopes are dirty, then clearing every dirty flag. Used when the user confirms
   *  leaving a page with unsaved changes (the hashchange guard in app.js) — without this,
   *  the flags (store-wide, not per-floor) stay dirty and re-arm the guard on some later,
   *  unrelated navigation. Reload before clearing flags: if it throws, the flags stay
   *  dirty, accurately reflecting that the in-memory data still holds un-discarded edits. */
  async discard() {
    const reloads = [];
    if (this.siteDirty) reloads.push(this.loadSiteplan());
    if (this.dirty || this.layoutDirty || this.placementsDirty) reloads.push(this.loadFloorData());
    await Promise.all(reloads);
    this.dirty = this.siteDirty = this.placementsDirty = this.layoutDirty = false;
    if (this.onDirty) { this.onDirty('floor'); this.onDirty('site'); this.onDirty('racks'); }
  }

  building(dir) { return this.manifest.buildings.find(b => b.dir === dir); }

  /** Flatten every loaded room + rack/device placement into a flat, facility-wide list
   *  for the siteplan wayfinding search. Rooms come from `annotations`, placements from
   *  `placements` — both part of the deferred `loadFloorData` bundle, so this returns `[]`
   *  until that has landed (the finder awaits `App.ensureFloorData` and re-renders). Each
   *  entry carries what a result needs to deep-link (`dir`/`fid`) and frame the target
   *  (`polygon` for a room, `x`/`y` for a placement). No server round-trip: the search
   *  index is built entirely from data already in the browser. */
  searchTargets() {
    const out = [];
    if (!this.manifest) return out;
    for (const b of this.manifest.buildings) {
      for (const f of b.floors) {
        const key = Util.floorKey(b.dir, f.id);
        const rec = this.annotations[key];
        if (rec) for (const r of rec.rooms) {
          out.push({ kind: 'room', dir: b.dir, fid: f.id, building: b.name, floor: f.label,
            roomId: r.id, label: r.label || '', location: r.location || null, polygon: r.polygon });
        }
        const pdata = this.placements[key];
        if (pdata) for (const p of pdata.placements) {
          out.push({ kind: p.kind === 'device' ? 'device' : 'rack', dir: b.dir, fid: f.id,
            building: b.name, floor: f.label, roomId: p.room, label: p.label || '', x: p.x, y: p.y });
        }
      }
    }
    return out;
  }

  /** Authenticated media URL for a manifest image path. Appends the active `?facility=` (so
   *  MediaView resolves the per-facility working dir) and the manifest's `built` token as `v=`
   *  so MediaView marks the response immutably cacheable — a rebuild mints a new token, so the
   *  browser re-fetches instead of showing a stale plan. Manifests from builds that predate the
   *  token fall back to the revalidating (no-`v`) URL. */
  mediaUrl(image) {
    const base = (window.MAP ? window.MAP.media : '/') + image;
    const params = [];
    if (Api.facility) params.push('facility=' + encodeURIComponent(Api.facility));
    const built = this.manifest && this.manifest.built;
    if (built) params.push('v=' + built);
    return params.length ? base + '?' + params.join('&') : base;
  }

  /** Drop all loaded + edited state for a facility switch, so the next `loadCore`/`loadFloorData`
   *  hydrates the newly-selected facility from scratch (App sets `Api.facility` first). Mirrors the
   *  constructor's initial values; leaves the rack inventory cache (keyed by global Location id,
   *  facility-independent) intact. */
  reset() {
    this.manifest = null;
    this.annotations = {};
    this.siteHotspots = [];
    this.placements = {};
    this.layouts = {};
    this.dirty = this.siteDirty = this.placementsDirty = this.layoutDirty = false;
    this.nbRoomsByFloor = {};
    this.versions = { annotations: null, siteplan: null, placements: null, layouts: null };
  }

  /** True once a facility has been imported (the manifest has a siteplan or buildings).
   *  Drives the boot default: an empty install lands on the import wizard. */
  hasContent() {
    return !!(this.manifest && (this.manifest.buildings.length || this.manifest.siteplan));
  }

  /** Resolve a floor's sheets + saved arrangement into geometry. The single place
   *  that knows how sheets tile the combined canvas: each sheet sits in one cell of
   *  a uniform grid (cell = max sheet w×h). Default (no saved grid) is a vertical
   *  stack (`col 0, row = page index`); single-page floors are one cell. Returns
   *  `{ cells:[{page,col,row,image,w,h,caption}], cellW, cellH, cols, rows, W, H }`. */
  floorLayout(dir, fid) {
    const f = this.building(dir).floors.find(x => x.id === fid);
    const pages = (f.pages && f.pages.length) ? f.pages
      : [{ image: f.image, w: f.w, h: f.h, caption: null }];
    const cellW = Math.max(...pages.map(p => p.w));
    const cellH = Math.max(...pages.map(p => p.h));
    const saved = this.layouts[Util.floorKey(dir, fid)];
    const grid = (saved && saved.grid && saved.grid.length === pages.length) ? saved.grid : null;
    const cells = pages.map((p, i) => {
      const [col, row] = grid ? grid[i] : [0, i];
      return { page: i, col, row, image: p.image, w: p.w, h: p.h, caption: p.caption };
    });
    const cols = Math.max(...cells.map(c => c.col)) + 1;
    const rows = Math.max(...cells.map(c => c.row)) + 1;
    return { cells, cellW, cellH, cols, rows, W: cols * cellW, H: rows * cellH };
  }

  /** Get (creating if absent) the annotation record for a floor. */
  floorData(dir, fid) {
    const key = Util.floorKey(dir, fid);
    if (!this.annotations[key]) {
      const f = this.building(dir).floors.find(x => x.id === fid);
      // Rooms are normalized over the whole tiled canvas → record its combined dims.
      const g = this.floorLayout(dir, fid);
      this.annotations[key] = { image: f.image, w: g.W, h: g.H, rooms: [], arrows: [], notes: [] };
    }
    // Back-fill `arrows`/`notes` on every call — records loaded from an existing
    // annotations.json predate these fields and never pass the create branch above.
    const rec = this.annotations[key];
    if (!rec.arrows) rec.arrows = [];
    if (!rec.notes) rec.notes = [];
    return rec;
  }

  /** Persist a floor's sheet arrangement (grid is [[col,row],...] per page index). */
  setLayout(dir, fid, grid) {
    this.layouts[Util.floorKey(dir, fid)] = { grid };
    this.markLayoutDirty();
  }

  /** Get (creating if absent) the rack/device placement record for a floor. */
  placementData(dir, fid) {
    const key = Util.floorKey(dir, fid);
    if (!this.placements[key]) this.placements[key] = { placements: [] };
    return this.placements[key];
  }

  /** Synced racks + unracked devices for a NetBox Location id. */
  racksForLocation(locId) {
    return (locId != null && this.rackCache.locations[locId]) || { racks: [], devices: [] };
  }

  markDirty() { this.dirty = true; if (this.onDirty) this.onDirty('floor'); }
  markSiteDirty() { this.siteDirty = true; if (this.onDirty) this.onDirty('site'); }
  markPlacementsDirty() { this.placementsDirty = true; if (this.onDirty) this.onDirty('racks'); }
  markLayoutDirty() { this.layoutDirty = true; if (this.onDirty) this.onDirty('floor'); }
  hasUnsaved() { return this.dirty || this.siteDirty || this.placementsDirty || this.layoutDirty; }

  /** Persist annotations (floors with no rooms, arrows or notes are pruned). */
  async saveAnnotations() {
    const out = {};
    for (const k in this.annotations) {
      const rec = this.annotations[k];
      // Drop text-less notes so a placed-then-cancelled note never persists as invisible,
      // unselectable cruft (the editor also drops them on close; this is the safety net).
      if (rec.notes) rec.notes = rec.notes.filter(
        n => n.labelStyle && n.labelStyle.text && n.labelStyle.text.trim());
      if (rec.rooms.length || (rec.arrows && rec.arrows.length)
          || (rec.notes && rec.notes.length)) out[k] = rec;
    }
    const r = await Api.postV('/api/annotations', out, this.versions.annotations);
    this.versions.annotations = r.version;
    this.dirty = false; if (this.onDirty) this.onDirty('floor');
  }

  async saveSiteplan() {
    const r = await Api.postV('/api/siteplan', { hotspots: this.siteHotspots }, this.versions.siteplan);
    this.versions.siteplan = r.version;
    this.siteDirty = false; if (this.onDirty) this.onDirty('site');
  }

  /** Persist rack/device placements (floors with no placements are pruned). */
  async savePlacements() {
    const out = {};
    for (const k in this.placements)
      if (this.placements[k].placements.length) out[k] = this.placements[k];
    const r = await Api.postV('/api/rackplacements', out, this.versions.placements);
    this.versions.placements = r.version;
    this.placements = out;
    this.placementsDirty = false; if (this.onDirty) this.onDirty('racks');
  }

  /** Persist sheet arrangements (a default/vertical-stack grid is pruned). */
  async saveLayouts() {
    const out = {};
    for (const k in this.layouts) {
      const grid = this.layouts[k].grid;
      // A vertical stack (col 0, row = index) is the default — no need to store it.
      if (grid && grid.some(([c, r], i) => c !== 0 || r !== i)) out[k] = { grid };
    }
    const r = await Api.postV('/api/pagelayouts', out, this.versions.layouts);
    this.versions.layouts = r.version;
    this.layouts = out;
    this.layoutDirty = false; if (this.onDirty) this.onDirty('floor');
  }

  /** Ensure the in-memory inventory for a Location is loaded, fetching racks +
   *  unracked devices live from NetBox via the given client. Cached after the first
   *  fetch; pass `force` to re-pull (the Refresh racks button). Returns the entry. */
  async ensureRacks(nb, locId, force = false) {
    if (locId == null) return { racks: [], devices: [] };
    if (!force && this.rackCache.locations[locId]) return this.rackCache.locations[locId];
    const [r, d] = await Promise.all([nb.racks(locId), nb.devices(locId)]);
    const entry = { racks: r.racks || [], devices: d.devices || [] };
    this.rackCache.locations[locId] = entry;
    return entry;
  }
}
