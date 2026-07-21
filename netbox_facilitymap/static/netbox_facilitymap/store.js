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
    // Optimistic-concurrency tokens (CONC-1): captured on load, sent back on save, refreshed from
    // the save response. A save with a stale token gets a 409 so a concurrent editor's work isn't
    // clobbered. The per-floor kinds are sharded by floor, so their token is a MAP `{floorKey:
    // token}` — a save carries only the touched floors' tokens, so different-floor saves never
    // collide. `siteplan` is one facility-wide document, so its token stays a scalar (null until
    // loaded). `_base` holds the pruned load-time snapshot each save diffs against to find which
    // floors it actually changed (so it sends only those). The siteplan baseline is a plain clone
    // of the hotspots (no sharding) — it exists so an undo restore can re-derive `siteDirty` from
    // last-saved content, the same way the floor flags re-derive from their sharded baselines
    // (SAVE-6). All baselines are content-only; they never carry the CONC-1 tokens.
    this.versions = { annotations: {}, siteplan: null, placements: {}, layouts: {} };
    this._base = { annotations: {}, placements: {}, layouts: {}, siteplan: [] };
    this._draftTimer = null;       // debounce handle for the localStorage draft (SAVE-5)
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
    this._base.siteplan = JSON.parse(JSON.stringify(this.siteHotspots));
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
    this.versions.annotations = this._parseVersions(annotations.version);
    this.versions.placements = this._parseVersions(placements.version);
    this.versions.layouts = this._parseVersions(layouts.version);
    // Baseline = what a save right now would persist, per floor. Diffing against it on save
    // isolates the floors this editor actually changed, so a save touches only those.
    this._base.annotations = this._annotationsOut();
    this._base.placements = this._placementsOut();
    this._base.layouts = this._layoutsOut();
  }

  /** Parse a per-floor version header (JSON `{floorKey: token}`) into a map; `{}` when the header
   *  is absent or malformed, so a first-ever save treats every floor as a fresh write. */
  _parseVersions(header) {
    if (!header) return {};
    try { const v = JSON.parse(header); return (v && typeof v === 'object') ? v : {}; }
    catch (_) { return {}; }
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
    this._base.siteplan = JSON.parse(JSON.stringify(this.siteHotspots));
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
    this._syncDraft();   // nothing unsaved now → drop the crash-recovery draft (SAVE-5)
  }

  building(dir) { return this.manifest.buildings.find(b => b.dir === dir); }

  /** Flatten every loaded room + rack/device placement into a flat, facility-wide list
   *  for the siteplan wayfinding search. Rooms come from `annotations`, placements from
   *  `placements` — both part of the deferred `loadFloorData` bundle, so this returns `[]`
   *  until that has landed (the finder awaits `App.ensureFloorData` and re-renders). Each
   *  entry carries what a result needs to deep-link (`dir`/`fid`) and frame the target
   *  (`polygon` for a room, `x`/`y` for a placement). No server round-trip: the *placed*
   *  index is built entirely from data already in the browser (the finder pairs it with the
   *  server-side unplaced-inventory search, NAV-3). A placement also exposes its NetBox id
   *  (`nbId`), so a server inventory hit can be deduped against an already-placed marker; a
   *  room already carries its bound Location on `location.id`. */
  searchTargets() {
    const out = [];
    if (!this.manifest) return out;
    for (const b of this.manifest.buildings) {
      for (const f of b.floors) {
        const key = Util.floorKey(b.dir, f.id);
        const rec = this.annotations[key];
        if (rec) for (const r of rec.rooms) {
          out.push({ kind: 'room', dir: b.dir, fid: f.id, building: b.name, floor: f.label,
            // `alias` carries the room's printed-name search synonyms so `_finderPlaced` matches the
            // number on the hallway sign, not just the bound Location name/slug (NAV-18).
            roomId: r.id, label: r.label || '', alias: r.alias || '',
            location: r.location || null, polygon: r.polygon });
        }
        const pdata = this.placements[key];
        if (pdata) for (const p of pdata.placements) {
          out.push({ kind: p.kind === 'device' ? 'device' : 'rack', dir: b.dir, fid: f.id,
            building: b.name, floor: f.label, roomId: p.room, nbId: p.id,
            // `url` is the object's NetBox detail page, enriched server-side onto the placements blob
            // (frontend_api `_placements_with_urls`), for the search widget's NetBox-target mode
            // (NAV-16); absent when the object was deleted/hidden, so the finder falls back to the map.
            label: p.label || '', x: p.x, y: p.y, url: p.url || null });
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
    this.versions = { annotations: {}, siteplan: null, placements: {}, layouts: {} };
    this._base = { annotations: {}, placements: {}, layouts: {}, siteplan: [] };
    // Cancel any pending debounced draft write from the outgoing facility: `Api.facility` is already
    // the new facility here, so a stale flush would target the wrong facility's key (SAVE-5). We do
    // NOT clear the outgoing facility's stored draft — it belongs to that facility and must survive a
    // switch away and back. (The nav guard already flushed/cleared it under the old facility if there
    // was unsaved work; a clean facility has no pending timer.)
    clearTimeout(this._draftTimer); this._draftTimer = null;
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

  markDirty() { this.dirty = true; if (this.onDirty) this.onDirty('floor'); this._scheduleDraft(); }
  markSiteDirty() { this.siteDirty = true; if (this.onDirty) this.onDirty('site'); this._scheduleDraft(); }
  markPlacementsDirty() { this.placementsDirty = true; if (this.onDirty) this.onDirty('racks'); this._scheduleDraft(); }
  markLayoutDirty() { this.layoutDirty = true; if (this.onDirty) this.onDirty('floor'); this._scheduleDraft(); }
  hasUnsaved() { return this.dirty || this.siteDirty || this.placementsDirty || this.layoutDirty; }

  /** The persistable annotations map — floors with rooms, arrows or notes, each a deep clone with
   *  text-less notes dropped. Pure (never mutates the live records), so it backs both the load-time
   *  baseline and the save payload/diff. A floor with only its manifest `image/w/h` (no user
   *  content) is omitted, matching the whole-doc prune the server now enforces. */
  _annotationsOut() {
    const out = {};
    for (const k in this.annotations) {
      const rec = this.annotations[k];
      const notes = (rec.notes || []).filter(
        n => n.labelStyle && n.labelStyle.text && n.labelStyle.text.trim());
      if ((rec.rooms && rec.rooms.length) || (rec.arrows && rec.arrows.length) || notes.length) {
        const clone = JSON.parse(JSON.stringify(rec));
        clone.notes = notes;
        out[k] = clone;
      }
    }
    return out;
  }

  /** The persistable placements map — floors carrying at least one placement, deep-cloned. */
  _placementsOut() {
    const out = {};
    for (const k in this.placements)
      if (this.placements[k].placements.length)
        out[k] = JSON.parse(JSON.stringify(this.placements[k]));
    return out;
  }

  /** The persistable layouts map — floors with a non-default (non-vertical-stack) grid, cloned. */
  _layoutsOut() {
    const out = {};
    for (const k in this.layouts) {
      const grid = this.layouts[k].grid;
      // A vertical stack (col 0, row = index) is the default — no need to store it.
      if (grid && grid.some(([c, r], i) => c !== 0 || r !== i)) out[k] = { grid: JSON.parse(JSON.stringify(grid)) };
    }
    return out;
  }

  /** Diff a sharded kind's current-vs-baseline pruned maps into a per-floor save. A floor whose
   *  pruned record changed (or newly appeared) is sent with its content + current token; a floor
   *  present in the baseline but now empty/absent is sent as `{}` (a delete) with its token.
   *  Unchanged floors are omitted, so a save conflict-checks and writes only the floors this editor
   *  touched — different-floor saves never collide (CONC-1). Returns `{payload, versions, touched}`. */
  _diffShards(kind, cur) {
    const base = this._base[kind] || {}, versionMap = this.versions[kind] || {};
    const payload = {}, versions = {}, touched = [];
    for (const k of new Set([...Object.keys(cur), ...Object.keys(base)])) {
      if (JSON.stringify(cur[k]) === JSON.stringify(base[k])) continue;   // unchanged
      payload[k] = cur[k] || {};                    // absent/empty current → {} deletes the floor
      versions[k] = versionMap[k] || '';
      touched.push(k);
    }
    return { payload, versions, touched };
  }

  /** Whether a sharded kind has unsaved changes: its current pruned output differs from the
   *  baseline on at least one floor. Reads `_base` content only (never the CONC-1 tokens). */
  _shardDirty(kind, cur) { return this._diffShards(kind, cur).touched.length > 0; }

  /** Re-derive the three floor dirty flags from the baselines (SAVE-6). An undo snapshot captures
   *  the flags as they were BEFORE its mutation, but a later save advances `_base`, leaving those
   *  captured flags stale — so on an undo restore the editor recomputes them from last-saved content
   *  here instead of trusting the snapshot. Content-only: never touches `versions`. */
  recomputeFloorDirty() {
    this.dirty = this._shardDirty('annotations', this._annotationsOut());
    this.placementsDirty = this._shardDirty('placements', this._placementsOut());
    this.layoutDirty = this._shardDirty('layouts', this._layoutsOut());
  }

  /** Re-derive `siteDirty` from the siteplan baseline (SAVE-6) — the hotspots differ from what was
   *  last loaded/saved. Same content-only re-derivation the floor flags use, for the siteplan editor's
   *  undo restore. */
  recomputeSiteDirty() {
    this.siteDirty = JSON.stringify(this.siteHotspots) !== JSON.stringify(this._base.siteplan || []);
  }

  /** Fold a sharded save's response into the token map + baseline. The server returns fresh tokens
   *  for the floors it kept (deleted floors are absent): advance each touched floor's baseline to
   *  the just-saved content and adopt its new token, or drop the floor from both when deleted. */
  _mergeShardResult(kind, versionHeader, cur, touched) {
    const returned = this._parseVersions(versionHeader);
    const versions = this.versions[kind] || {}, base = this._base[kind] || {};
    for (const k of touched) {
      if (returned[k] != null) { versions[k] = returned[k]; base[k] = cur[k]; }
      else { delete versions[k]; delete base[k]; }
    }
    this.versions[kind] = versions;
    this._base[kind] = base;
  }

  /** Generic sharded save: diff, POST only the touched floors (empty request skipped), merge the
   *  response. `clear` runs after — clearing the dirty flag regardless of whether a request went
   *  out (a no-op save still leaves the badge clean). */
  async _saveShard(kind, path, cur, clear) {
    const { payload, versions, touched } = this._diffShards(kind, cur);
    if (touched.length) {
      const r = await Api.postV(path, payload, JSON.stringify(versions));
      this._mergeShardResult(kind, r.version, cur, touched);
    }
    clear();
    this._syncDraft();   // reconcile the crash-recovery draft with the now-cleared flag (SAVE-5)
  }

  /** Persist annotations (only the floors changed since load/last-save; empty floors are deleted). */
  async saveAnnotations() {
    const cur = this._annotationsOut();
    // Safety net: also drop text-less notes from the live records (a placed-then-cancelled note),
    // matching what `_annotationsOut` persisted; the editor drops them on close too.
    for (const k in this.annotations) {
      const rec = this.annotations[k];
      if (rec.notes) rec.notes = rec.notes.filter(
        n => n.labelStyle && n.labelStyle.text && n.labelStyle.text.trim());
    }
    await this._saveShard('annotations', '/api/annotations', cur,
      () => { this.dirty = false; if (this.onDirty) this.onDirty('floor'); });
  }

  async saveSiteplan() {
    const r = await Api.postV('/api/siteplan', { hotspots: this.siteHotspots }, this.versions.siteplan);
    this.versions.siteplan = r.version;
    // Advance the baseline to what was just persisted so an undo across this save re-derives
    // siteDirty against saved content, not the pre-save state (SAVE-6).
    this._base.siteplan = JSON.parse(JSON.stringify(this.siteHotspots));
    this.siteDirty = false; if (this.onDirty) this.onDirty('site');
    this._syncDraft();   // reconcile the crash-recovery draft with the now-cleared flag (SAVE-5)
  }

  /** Persist rack/device placements (only changed floors; floors emptied of placements are deleted). */
  async savePlacements() {
    await this._saveShard('placements', '/api/rackplacements', this._placementsOut(),
      () => { this.placementsDirty = false; if (this.onDirty) this.onDirty('racks'); });
  }

  /** Persist sheet arrangements (only changed floors; a floor returned to the default grid is deleted). */
  async saveLayouts() {
    await this._saveShard('layouts', '/api/pagelayouts', this._layoutsOut(),
      () => { this.layoutDirty = false; if (this.onDirty) this.onDirty('floor'); });
  }

  // ---- draft persistence / crash protection (SAVE-5) ----
  // A debounced localStorage mirror of every in-memory unsaved edit, keyed by facility, so a
  // browser crash, a killed tab, or a failed save doesn't lose a long editing session (the
  // beforeunload/navigate guards can only warn — they can't protect against a crash or a rejected
  // POST). The store loads all floors at once and its dirty flags are store-wide, so the draft's
  // unit is the whole facility, not one floor. Restore (App._maybeRestoreDraft) overlays the
  // draft's CONTENT onto freshly-loaded server state but KEEPS the load-time CONC-1 tokens +
  // `_base` baseline, so the save diff still flags the draft's floors as touched and a stale draft
  // still 409s — never a silent clobber. Cleared once a save (or discard) leaves nothing unsaved.

  /** localStorage key for this facility's draft ('' = the default facility). */
  _draftKey() { return Store.DRAFT_PREFIX + (Api.facility || ''); }

  /** Everything a save would persist, plus the dirty flags, as a plain serializable object. */
  _draftSnapshot() {
    return {
      annotations: this._annotationsOut(),
      placements: this._placementsOut(),
      layouts: this._layoutsOut(),
      siteHotspots: this.siteHotspots,
      flags: { dirty: this.dirty, siteDirty: this.siteDirty,
        placementsDirty: this.placementsDirty, layoutDirty: this.layoutDirty },
    };
  }

  /** Write the draft now when there's unsaved work, else clear it. Synchronous (localStorage), so
   *  it's safe to call from `beforeunload`. A quota/serialization failure degrades to a
   *  console.warn — the in-memory edits and the nav guard still hold — rather than breaking editing. */
  flushDraft() {
    if (typeof localStorage === 'undefined') return;
    clearTimeout(this._draftTimer); this._draftTimer = null;
    try {
      if (this.hasUnsaved()) localStorage.setItem(this._draftKey(), JSON.stringify(this._draftSnapshot()));
      else localStorage.removeItem(this._draftKey());
    } catch (e) { console.warn('facilitymap: could not persist editing draft', e); }
  }

  /** Debounced draft write, armed on every edit so a crash loses at most the last ~second of work
   *  (node drags fire markDirty on every pointer move — the debounce keeps that off localStorage). */
  _scheduleDraft() {
    if (typeof localStorage === 'undefined') return;
    clearTimeout(this._draftTimer);
    this._draftTimer = setTimeout(() => { this._draftTimer = null; this.flushDraft(); }, Store.DRAFT_DEBOUNCE_MS);
  }

  /** Reconcile the draft with the current dirty state immediately (used by the save/discard paths:
   *  write if still unsaved, clear once clean). */
  _syncDraft() { this.flushDraft(); }

  /** Drop this facility's persisted draft (used when a restore is declined). */
  clearDraft() {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.removeItem(this._draftKey()); } catch (_) { /* nothing to clean up */ }
  }

  /** Read + validate this facility's draft, returning the parsed object only when it holds actual
   *  unsaved content (else null, discarding a malformed/empty draft), so a stale or corrupt draft
   *  never prompts a pointless restore. */
  peekDraft() {
    if (typeof localStorage === 'undefined') return null;
    let raw;
    try { raw = localStorage.getItem(this._draftKey()); } catch (_) { return null; }
    if (!raw) return null;
    let d;
    try { d = JSON.parse(raw); } catch (_) { this.clearDraft(); return null; }
    if (!d || typeof d !== 'object') { this.clearDraft(); return null; }
    const has = (m) => m && typeof m === 'object' && Object.keys(m).length;
    if (!has(d.annotations) && !has(d.placements) && !has(d.layouts) &&
        !(Array.isArray(d.siteHotspots) && d.siteHotspots.length)) { this.clearDraft(); return null; }
    return d;
  }

  /** Overlay a draft's content onto the freshly-loaded server state and re-arm the dirty flags,
   *  WITHOUT touching the CONC-1 tokens or the `_base` baseline (both set by the load that MUST run
   *  first, so the save still conflict-checks against current server state). The per-floor maps are
   *  merged (Object.assign) rather than replaced, so a concurrent editor's newly-added floor
   *  survives — a wholesale replace could make the next save diff `{}`-delete it. `siteHotspots` is
   *  one facility-wide document, replaced outright. Content is resolution-independent (normalized
   *  0..1), so a draft restores cleanly regardless of viewport. Limitation: a floor emptied of all
   *  content before a crash isn't represented (it prunes to nothing), so that lone deletion is lost
   *  — additions/edits, the long-session case this protects, are preserved. */
  applyDraft(d) {
    Object.assign(this.annotations, d.annotations || {});
    Object.assign(this.placements, d.placements || {});
    Object.assign(this.layouts, d.layouts || {});
    if (Array.isArray(d.siteHotspots)) this.siteHotspots = d.siteHotspots;
    const f = d.flags || {};
    this.dirty = !!f.dirty; this.siteDirty = !!f.siteDirty;
    this.placementsDirty = !!f.placementsDirty; this.layoutDirty = !!f.layoutDirty;
    if (this.onDirty) { this.onDirty('floor'); this.onDirty('site'); this.onDirty('racks'); }
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
// Crash-recovery draft (SAVE-5): one localStorage entry per facility ('' = default), holding the
// in-memory unsaved edits. Debounce keeps rapid edits (node drags) off localStorage; a beforeunload
// flush captures the tail on a clean close.
Store.DRAFT_PREFIX = 'facilitymap:draft:';
Store.DRAFT_DEBOUNCE_MS = 1000;
