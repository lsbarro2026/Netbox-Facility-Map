'use strict';
/* siteplan-editor.js — SiteplanEditor: the siteplan view + an edit mode for
   drawing user building hotspots (e.g. the trailers the source PDF never placed).
   In view mode it renders the PDF hotspots + user hotspots as clickable building
   links. Extends Editor; shapes are buildings rather than rooms. */

// Persisted building-index sizing (NAV-7). Prefixed like the other UI prefs
// (facilitymap:ortho, facilitymap:gridStep:*) so it never collides with them.
const LEGEND_WIDTH_KEY = 'facilitymap:siteLegendWidth';
const LEGEND_COLLAPSED_KEY = 'facilitymap:siteLegendCollapsed';
const LEGEND_MIN_W = 180;         // narrowest usable index (header + search + a row stay legible)
const LEGEND_COLLAPSE_W = 140;    // dragging narrower than this releases into a collapse
const LEGEND_DEFAULT_W = 250;     // the original fixed flex-basis
const LEGEND_MAX_FRAC = 0.45;     // cap the index at this fraction of the stage so the map keeps room

class SiteplanEditor extends Editor {
  constructor(app) {
    super(app);
    this._promoted = null;   // id of a PDF hotspot promoted to a user hotspot but not yet edited
  }

  // ---- Editor hooks ----
  editing() { return this.app.siteEdit; }
  _dirty() { return this.store.siteDirty; }
  _setEditing(on) { this.app.siteEdit = on; }
  /** Beyond the base state reset: drop a promoted-but-unedited hotspot so toggling out of
   *  edit never leaves a stray user hotspot behind (or dirties siteplan.json). */
  _onModeSwitch(mode) { this._discardCleanPromotion(); }
  polys() { return this.store.siteHotspots.map(h => ({ id: h.id, polygon: h.poly })); }
  markDirty() {
    // The first real edit commits a promoted hotspot, so it is no longer discarded.
    if (this.selected && this.selected === this._promoted) this._promoted = null;
    this.store.markSiteDirty(); this._setBadge();
  }
  deselect() {
    this._discardCleanPromotion();
    if (this.selected) { this.selected = null; this.editingLabel = null; this.render(); this.app.closePanel(); }
  }

  // ---- undo hooks (see Editor.snapshot/undo) ----
  /** A snapshot of everything an edit here can change — the user siteplan hotspots — captured
   *  BEFORE the mutation. The siteDirty flag is NOT stored: `_restoreState` re-derives it from the
   *  siteplan baseline (SAVE-6), so it stays correct even after a save advances that baseline (same
   *  contract the floor editor documents). JSON round-trip clone, matching the codebase idiom.
   *  Returning a non-null snapshot also opts vertex drags into undo automatically: the base drag
   *  machinery captures `_gestureSnap = _snapshotState()` on pointerdown (editor.js) and commits it
   *  on pointerup only if the drag moved geometry. */
  _snapshotState() {
    return {
      hotspots: JSON.parse(JSON.stringify(this.store.siteHotspots)),
      promoted: this._promoted,   // preserve the discard-on-deselect safety across undo
    };
  }

  /** Restore a snapshot: write the cloned hotspots back, re-derive the dirty flag from the siteplan
   *  baseline, restore the promotion flag, and drop transient selection/draft state (a restored
   *  delete may have removed the selected shape). Restoring `_promoted` keeps a promoted-but-unbound
   *  hotspot's discard-on-deselect safety intact when undoing back to that state. Closes the panel
   *  under the _switchMode guard so it doesn't fight onPanelClosed. Base undo() re-renders after this. */
  _restoreState(snap) {
    this.store.siteHotspots = snap.hotspots;
    this.store.recomputeSiteDirty();
    this._promoted = snap.promoted || null;
    this.selected = null; this.editingLabel = null; this.draft = null;
    if (this.store.onDirty) this.store.onDirty('site');
    this._setBadge();
    this._switchingMode = true; this.app.closePanel(); this._switchingMode = false;
  }

  /** App.closePanel hook: leaving label-edit mode (e.g. via the panel ✕) restores
   *  the normal selected-shape rendering. */
  onPanelClosed() {
    if (this.editingLabel) { this.editingLabel = null; this.render(); }
  }

  openBuilding(dir, name) {
    // Both hotspot clicks and legend rows route through here, so this covers both.
    const b = this.store.building(dir);
    if (!(b && b.floors.length)) {
      // No floor maps to open. The embed's toast is CSS-hidden, so it just does nothing there.
      if (!this.app.embed) Toast.show('No floor maps for ' + (name || dir));
      return;
    }
    const hash = '/b/' + encodeURIComponent(dir);
    // The dashboard-widget embed is chrome-free with no in-card breadcrumbs, so drilling in
    // there would strand the user with no way back. Open the full map in the top window instead,
    // deep-linked at this building: location.pathname is the MapView URL (minus the ?embed=1
    // query) and the widget iframe is same-origin, so window.top is reachable.
    if (this.app.embed) { window.top.location.href = location.pathname + '#' + this.app._hash(hash); return; }
    this.app.go(hash);
  }

  /** PDF hotspots overridden by any user hotspot for the same building, plus all
   *  user hotspots. With no siteplan image (IMPORT-8) there are no PDF hotspots — only
   *  user hotspots (themselves empty, since they can't be drawn without a plan) — so `sp`
   *  may be null here (the building-directory home reuses this via `_legend`). */
  effectiveHotspots() {
    const sp = this.store.manifest.siteplan;
    const overridden = new Set(this.store.siteHotspots.map(h => h.dir));
    const pdf = (sp ? sp.hotspots : []).filter(h => !overridden.has(h.dir))
      .map(h => ({ source: 'pdf', dir: h.dir, name: h.name, code: h.buildingCode, poly: h.poly }));
    const user = this.store.siteHotspots.map(h => ({
      source: 'user', id: h.id, dir: h.dir, name: h.name, ref: h,
      code: Util.code(h.dir || '?'), poly: h.poly,
    }));
    return pdf.concat(user);
  }

  // ---- view assembly ----
  show() {
    const sp = this.store.manifest.siteplan;
    this.draft = null; this.selected = null; this.editingLabel = null; this._promoted = null; this.grid.adjust = false;
    this.grid.setScope('siteplan');
    this.app.crumbs([{ label: this.app.homeCrumbLabel() }]);
    const stage = Dom.$('#stage'); stage.innerHTML = '';
    // Search-only embed (FacilitySearchWidget, NAV-15): render just the wayfinding finder — no
    // siteplan image, legend, or pan/zoom. Returns before the map is built; the finder warms its
    // own floor data (see _finder) and its hits escape to the top window (openBuilding/_gotoTarget).
    if (this.app.finder) { this._showFinderOnly(stage); return; }
    // No overall siteplan image (IMPORT-8): there's no map to draw, so render the building index as
    // a full-stage directory home instead of a dead "No siteplan image" (App.showSiteplan already
    // short-circuited the single-building case to that building, so this path is the ≥2-building one).
    if (!sp) { this._showDirectory(stage); return; }
    this.app.setToolbar(this._toolbar());

    const img = Dom.el('img', { src: this.store.mediaUrl(sp.image), alt: 'siteplan' });
    const s = Dom.svg('svg', { preserveAspectRatio: 'none' });
    const wrap = Dom.el('div', { class: 'map-wrap' }, [img, s]);
    const viewport = Dom.el('div', { class: 'map-viewport' }, wrap);
    const legend = this._legend(s);
    // The drag-to-resize / collapse chrome is for the full app only. The dashboard-widget
    // embed is chrome-free and never persists UI prefs, so it keeps the plain fixed index.
    const children = [viewport, legend];
    let handle = null;
    if (!this.app.embed) {
      handle = Dom.el('div', { class: 'legend-resize',
        title: 'Drag to resize · double-click to hide the buildings panel' });
      children.splice(1, 0, handle);   // viewport | handle | legend
    }
    const view = Dom.el('div', { class: 'siteplan-view' }, children);
    stage.append(view);
    if (!this.app.embed) this._installLegendResize(view, legend, handle);
    this.attach(img, s, [sp.w, sp.h]);
  }

  /** Search-only presentation for the FacilitySearchWidget embed (NAV-15): the wayfinding finder
   *  alone, filling the card. No toolbar, map, legend, or pan/zoom `attach` — the finder is
   *  self-contained (it warms its own floor data via `App.ensureFloorData`, and routes hits through
   *  `openBuilding`/`_gotoTarget`, both of which top-window-redirect in the embed). */
  _showFinderOnly(stage) {
    this.app.setToolbar([]);
    stage.append(Dom.el('div', { class: 'finder-only' }, this._finder()));
  }

  /** Home screen when the facility has no overall siteplan image (IMPORT-8): the building index
   *  rendered full-stage as a navigable directory — the same `_finder()` + browse list the map view
   *  docks alongside, minus the map. Reuses `_legend`, so search / browse / `openBuilding` behave
   *  identically; the `<svg>` handed to it is only touched by the row-hover highlight, which no-ops
   *  (`querySelector` → null) with no map present. Deliberately shows no Edit toggle: drawing
   *  building areas needs a background plan to draw on, so the siteplan edit mode has no meaning
   *  here — a sanctioned per-editor omission, not edit-menu drift (§10 Edit-menu lockstep, the same
   *  "cannot apply to the other editor" exception as the floor-only Add-access-point tool). The base
   *  `_toolbar()` (and its mode toggle) is intentionally bypassed; only the view-mode To-do tool
   *  shows. `_installLegendResize` is skipped too, so the buildings-panel toggle (`#panel-toggle`,
   *  which `App.router` leaves hidden) never appears — there's nothing to dock/undock. */
  _showDirectory(stage) {
    this.app.setToolbar(this._viewButtons());
    stage.append(Dom.el('div', { class: 'siteplan-directory' }, this._legend(Dom.svg('svg'))));
  }

  /** Make the building index drag-resizable and collapsible (NAV-7), persisting the chosen
   *  width + collapsed state to localStorage. The mechanism is shared with the floor to-do panel,
   *  so it lives on the `Editor` base (`_installPanelResize`); this passes the index's own
   *  localStorage keys + sizing. The `.map-viewport` is `flex: 1 1 auto`, so resizing the index
   *  reflows the map, tripping the viewport's ResizeObserver (Editor.attach) → the pan/zoom clamp,
   *  so hotspot coordinates stay correct after a resize. */
  _installLegendResize(view, legend, handle) {
    this._installPanelResize({
      view, panel: legend, handle,
      widthKey: LEGEND_WIDTH_KEY, collapsedKey: LEGEND_COLLAPSED_KEY,
      minW: LEGEND_MIN_W, collapseW: LEGEND_COLLAPSE_W, defaultW: LEGEND_DEFAULT_W,
      maxFrac: LEGEND_MAX_FRAC,
    });
  }

  // ---- toolbar hooks (assembled by Editor._toolbar) ----
  // The lone edit-mode tool: Add building area (undo + the right-angle/grid factory row
  // and Save+badge come from the base). The siteplan editor always vertex/edge-snaps, so
  // it uses the base _alignTools (no Snap toggle).
  _editButtons() {
    return [Dom.el('button', { class: 'tb-labeled', title: 'Add a building area: click to outline a building',
      onclick: () => this.beginDraw(
      'Click to outline a building · Backspace undoes a point · Right-click removes a point · Enter/double-click to close'),
      html: Icons.draw + '<span>Add building area</span>' })];
  }
  // The lone view-mode tool: the in-app way to the facility-wide to-do page (UX-3). The siteplan
  // is the app's home screen, so this is where a facility-wide destination is discoverable — the
  // NetBox nav's `TodoTabView` redirect is the only other door, and it leaves the app to use it.
  // Skipped in the dashboard-widget embed, which has no in-app navigation (its clicks
  // top-window-redirect, so an in-frame route to #/todo would strand the user in the widget), and
  // when the to-do add-on itself is off install-wide (ADDON-4) — otherwise it's a dead button,
  // since `App.showTodo` immediately bounces `#/todo` back to `/` (UX-12).
  _viewButtons() {
    if (this.app.embed || !this.app.todos) return [];
    return [Dom.el('button', { class: 'tb-labeled', title: 'Every building’s to-dos in one list',
      onclick: () => this.app.go('/todo'),
      html: Icons.todo + '<span>To-do</span>' })];
  }
  // Save/badge only in edit mode: in view the siteplan is the app's home screen, kept
  // uncluttered (the wizard entry point + page-wide labels toggle live in Settings).
  _showsSave() { return this.editing(); }

  _legend(s) {
    const legend = Dom.el('aside', { class: 'legend' });
    // Hiding the index is the top-bar toggle's job now (NAV-8); the panel itself carries no
    // collapse chrome, so it opens straight into the search + browse list.
    // One combined wayfinding search over the building index (NAV-4): it finds buildings plus
    // rooms/racks/devices anywhere in the facility. Skipped in the map embed (FacilityMapWidget),
    // which has no in-app navigation — so the index below is a plain browse list there. (The
    // search-only embed, FacilitySearchWidget/NAV-15, renders the finder standalone via
    // `_showFinderOnly` and never reaches this legend.)
    if (!this.app.embed) legend.append(this._finder());
    legend.append(Dom.el('div', { class: 'legend-head' }, 'All buildings'));
    const numbered = this.store.manifest.buildings.filter(b => Util.isNumbered(b.dir));
    const trailers = this.store.manifest.buildings.filter(b => !Util.isNumbered(b.dir));
    // "Not placed on the map" (◌) is meaningless when there's no siteplan map at all (the directory
    // home, IMPORT-8) — suppress the pin there by treating every building as "on the map".
    const hasMap = !!this.store.manifest.siteplan;
    const onMap = new Set(this.effectiveHotspots().map(h => h.dir));
    const hover = (dir, on) => { const n = s.querySelector(`[data-hs="${CSS.escape(dir)}"]`); if (n) n.classList.toggle('hot', on); };

    const rows = Dom.el('div', { class: 'legend-rows' });
    // The index is a plain browse list — searching now happens in the combined bar above, whose
    // building hits jump straight to a building, so this list no longer filters itself.
    const addGroup = (title, list) => {
      if (!list.length) return;
      if (title) rows.append(Dom.el('div', { class: 'legend-group' }, title));
      for (const b of list) {
        const has = b.floors.length > 0;
        rows.append(Dom.el('div', {
          class: 'legend-row' + (has ? '' : ' nomap'),
          onclick: () => this.openBuilding(b.dir, b.name),
          onmouseenter: () => hover(b.dir, true),
          onmouseleave: () => hover(b.dir, false),
        }, [
          Dom.el('span', { class: 'lc' }, Util.code(b.dir)),
          Dom.el('span', { class: 'ln' }, b.name + (has ? '' : ' (no map)')),
          (!hasMap || onMap.has(b.dir)) ? null : Dom.el('span', { class: 'nopin', title: 'Not placed on the map' }, '◌'),
        ]));
      }
    };
    addGroup('', numbered);
    addGroup('Trailers', trailers);
    legend.append(rows);
    return legend;
  }

  /** Facility-wide wayfinding search (NAV-4): one bar that finds a building *and* a room/rack/device
   *  by name anywhere in the facility. Building hits come from `_finderBuildings` (the manifest index,
   *  instant) and lead the results — clicking one opens that building (`openBuilding`). Room/rack hits
   *  merge two sources (NAV-3): the *placed* index — items drawn or placed on the map — is built
   *  client-side from the already-loaded room + placement blobs (`Store.searchTargets`, instant, no
   *  round-trip); the *unplaced* inventory — items that exist in NetBox but were never put on the map —
   *  comes from a debounced, facility-scoped server search (`NetBoxClient.inventory`). A placed hit
   *  jumps to its floor and pulses it (`App.focusRoom`); an unplaced hit on a mapped floor navigates to
   *  that building/floor (no pulse); an unplaced hit on a floor with no map is listed disabled. Empty
   *  query shows nothing (the building index below is the browse view). Rendered inside the legend in
   *  the standalone app (skipped in the map embed, `_legend`); the search-only embed (NAV-15) renders
   *  it standalone via `_showFinderOnly`, where every hit escapes to the top window (`_gotoTarget`). */
  _finder() {
    const box = Dom.el('div', { class: 'finder' });
    const input = Dom.el('input', { class: 'legend-search', type: 'search',
      placeholder: 'Find a building, room, or rack…', 'aria-label': 'Find a building, room, or rack' });
    const results = Dom.el('div', { class: 'finder-results' });
    box.append(input, results);

    let q = '';
    let serverInv = null;   // server inventory response for the CURRENT query, or null until it lands
    let token = 0;          // monotonic request id; a response whose id != token is stale and dropped
    let pending = false;    // a server request is in flight for the current query
    let floorLoaded = false;   // the deferred floor-data bundle (the placed index) has landed
    let timer = null;

    const render = () => {
      results.innerHTML = '';
      const ql = q.trim().toLowerCase();
      if (!ql) return;
      // Buildings lead, then placed rooms/racks, then the server's unplaced inventory.
      const rows = this._finderBuildings(ql)
        .concat(this._finderPlaced(ql), this._finderUnplaced(serverInv)).slice(0, 40);
      if (rows.length) { for (const t of rows) results.append(this._finderRow(t)); return; }
      results.append(Dom.el('div', { class: 'finder-empty' },
        (pending || !floorLoaded) ? 'Searching…' : 'No matches'));
    };

    // Each keystroke re-renders placed results instantly, then (for a query past the server's
    // minimum) debounces one inventory fetch. `serverInv` resets so a prior query's unplaced rows
    // never linger; `token` drops a response that a newer keystroke has superseded.
    const onInput = () => {
      q = input.value;
      serverInv = null;
      render();
      clearTimeout(timer);
      const ql = q.trim();
      if (ql.length < 2) { pending = false; return; }   // mirror the server MIN_Q
      pending = true;
      const reqToken = ++token;
      timer = setTimeout(() => {
        this.app.netbox.inventory(ql)
          .then(inv => { if (reqToken === token) { serverInv = inv; pending = false; render(); } })
          .catch(() => { if (reqToken === token) { pending = false; render(); } });
      }, 250);
    };
    input.addEventListener('input', onInput);
    // The placed index lives in the deferred floor-data bundle (warmed after the siteplan paints).
    // Once it lands, re-run whatever the user has already typed.
    this.app.ensureFloorData().then(() => { floorLoaded = true; render(); }).catch(() => {});
    return box;
  }

  /** The building half of the combined search (NAV-4): manifest buildings whose name/code/`dir`
   *  match `ql` (already lowercased), a leading name/code match ranked ahead of any substring. Each
   *  becomes a `building` target routed through `_finderRow` → `openBuilding`. Instant (the manifest
   *  is already loaded), so it renders on the first keystroke alongside the placed rooms/racks. */
  _finderBuildings(ql) {
    const scored = [];
    for (const b of this.store.manifest.buildings) {
      const name = b.name.toLowerCase(), code = Util.code(b.dir).toLowerCase(), dir = b.dir.toLowerCase();
      let rank = -1;
      if (name.startsWith(ql) || code.startsWith(ql)) rank = 0;
      else if (name.includes(ql) || code.includes(ql) || dir.includes(ql)) rank = 1;
      if (rank >= 0) scored.push({ b, rank });
    }
    scored.sort((a, b) => a.rank - b.rank);
    return scored.map(s => ({ kind: 'building', label: s.b.name, dir: s.b.dir,
      code: Util.code(s.b.dir), hasMap: s.b.floors.length > 0 }));
  }

  /** The *placed* half of the finder: rooms/racks/devices already on the map, scored against `ql`
   *  (already lowercased) from `Store.searchTargets` — a leading label OR alias-synonym match first,
   *  then any label/alias substring, then the bound Location's name/slug. The alias (NAV-18) carries
   *  the room number printed on the plan, so a technician searching that number matches even when the
   *  bound Location is named differently; its comma/newline-separated synonyms are matched per token
   *  so a leading match on any one of them ranks top. `[]` until the deferred floor data lands. */
  _finderPlaced(ql) {
    const scored = [];
    for (const t of this.store.searchTargets()) {
      const label = t.label.toLowerCase();
      const alias = (t.alias || '').toLowerCase();
      const aliasLead = alias.split(/[\n,]/).some(a => a.trim().startsWith(ql));
      const locName = (t.location && t.location.name || '').toLowerCase();
      const locSlug = (t.location && t.location.slug || '').toLowerCase();
      let rank = -1;
      if (label.startsWith(ql) || aliasLead) rank = 0;
      else if (label.includes(ql) || alias.includes(ql)) rank = 1;
      else if (locName.includes(ql) || locSlug.includes(ql)) rank = 2;
      if (rank >= 0) scored.push({ t, rank });
    }
    scored.sort((a, b) => a.rank - b.rank);
    return scored.map(s => s.t);
  }

  /** The *unplaced* half of the finder (NAV-3): turn a server inventory response
   *  (`NetBoxClient.inventory`) into result rows for items NOT already on the map. Dedups against the
   *  placed index by NetBox id (a room by its bound Location id, a rack/device by kind+id), then
   *  splits each survivor by whether its floor is mapped: a floor bound to a map floor → a navigable
   *  `unassigned` row (jumps to that building/floor); a floor with no map → a `disabled` row labelled
   *  with the NetBox site/floor names. `null`/absent response → []. */
  _finderUnplaced(inv) {
    if (!inv) return [];
    const placedRooms = new Set(), placedMarks = new Set();
    for (const t of this.store.searchTargets()) {
      if (t.kind === 'room') { if (t.location && t.location.id != null) placedRooms.add(t.location.id); }
      else if (t.nbId != null) placedMarks.add(t.kind + ':' + t.nbId);
    }
    // Manifest floor lookup: "<dir>/<fid>" -> the map building/floor to navigate to. `dir`==site slug
    // and `fid`==floor Location slug, so this keys directly off a result's (site_slug, floor_slug).
    const floors = {};
    for (const b of this.store.manifest.buildings)
      for (const f of b.floors)
        floors[b.dir + '/' + f.id] = { dir: b.dir, fid: f.id, building: b.name, floor: f.label };

    const out = [];
    const add = (item, kind) => {
      const dup = kind === 'room' ? placedRooms.has(item.id) : placedMarks.has(kind + ':' + item.id);
      if (dup) return;   // already surfaced by the placed path
      const mapped = floors[item.site_slug + '/' + item.floor_slug];
      // `url` (the object's NetBox page, from NbInventoryView) rides every row for the search
      // widget's NetBox-target mode (NAV-16); it's what lets an unmapped-floor row still be reached.
      if (mapped) out.push({ kind, unassigned: true, label: item.name || '', url: item.url || null,
        dir: mapped.dir, fid: mapped.fid, building: mapped.building, floor: mapped.floor });
      else out.push({ kind, unassigned: true, disabled: true, label: item.name || '', url: item.url || null,
        building: item.site_name || item.site_slug, floor: item.floor_name || item.floor_slug });
    };
    (inv.rooms || []).forEach(r => add(r, 'room'));
    (inv.racks || []).forEach(r => add(r, 'rack'));
    (inv.devices || []).forEach(d => add(d, 'device'));
    return out;
  }

  /** One search result row: a kind tag (Building/Room/Rack/Device) + the target name. A building
   *  (NAV-4) subtitles its code (with a "no map" note when it has no floors) and opens the building
   *  on click. A room/rack/device subtitles its building · floor (and bound Location, for a placed
   *  room whose label differs from it). An *unplaced* target (NAV-3) adds a note line — "Unassigned"
   *  when its floor is mapped and it still navigates, or "Not on the map" when its floor has no map,
   *  in which case the row is disabled (no click). In the NetBox-target mode (NAV-16) a room/rack/
   *  device hit that has a NetBox page opens there instead (noted "Opens the NetBox page") — even a
   *  normally-disabled unmapped-floor row, since its NetBox page is still reachable; only a hit with
   *  no page (an unbound room, a building) falls back to the map. */
  _finderRow(t) {
    const isBldg = t.kind === 'building';
    // NetBox-target mode (search widget) sends a hit with a NetBox page there rather than to the map;
    // a building has no single NetBox object, so it always opens the map. See `_gotoTarget`.
    const toNetbox = this.app.embed && this.app.resultTarget === 'netbox' && !isBldg && !!this._netboxUrl(t);
    const primary = t.label || (t.location && t.location.name) || '(unbound room)';
    const tag = isBldg ? 'Building'
      : (t.kind === 'room' ? 'Room' : (t.kind === 'device' ? 'Device' : 'Rack'));
    let sub;
    if (isBldg) sub = t.code + (t.hasMap ? '' : ' · no map');
    else {
      const locName = t.kind === 'room' && t.location && t.location.name;
      sub = t.building + ' · ' + t.floor + (locName && locName !== primary ? ' · ' + locName : '');
    }
    const main = [
      Dom.el('div', { class: 'finder-nm' }, primary),
      Dom.el('div', { class: 'finder-sl' }, sub),
    ];
    if (toNetbox) main.push(Dom.el('div', { class: 'finder-un' }, 'Opens the NetBox page'));
    else if (t.unassigned) main.push(Dom.el('div', { class: 'finder-un' },
      t.disabled ? 'Not on the map — floor not imported' : 'Unassigned — not placed on the map'));
    // Clickable when it resolves somewhere: a building always, a NetBox-target hit with a page, or a
    // non-disabled (map-reachable) hit. An unmapped-floor row is disabled only when NetBox mode can't
    // rescue it either.
    const clickable = isBldg || toNetbox || !t.disabled;
    const attrs = { class: 'finder-row' + (clickable ? '' : ' disabled') };
    if (isBldg) attrs.onclick = () => this.openBuilding(t.dir, t.label);
    else if (clickable) attrs.onclick = () => this._gotoTarget(t);
    return Dom.el('div', attrs, [
      Dom.el('span', { class: 'finder-tag ' + t.kind }, tag),
      Dom.el('div', { class: 'finder-main' }, main),
    ]);
  }

  /** Route to a result's floor. A *placed* target is framed on the map (a room on its polygon bbox,
   *  padded; a rack/device on a small box around its placement point, pulsing its room) via
   *  `App.focusRoom`. An *unplaced* target (NAV-3) has no polygon/marker, so it just opens its
   *  building/floor with no focus region — `App.showFloor` only pulses when `_pendingFocus` is set,
   *  so the jump lands on the plain floor. Coordinates are normalized over the whole (possibly
   *  multi-sheet) canvas, so a single rect frames the target regardless of sheet.
   *  NetBox-target mode (NAV-16): when the search widget is set to open a hit's NetBox page and the
   *  hit has one, leave for that page instead — including a `disabled`, unmapped-floor row (its
   *  NetBox page is still reachable; `_finderRow` makes it clickable only in that case). */
  _gotoTarget(t) {
    const nbUrl = this.app.resultTarget === 'netbox' && this._netboxUrl(t);
    if (this.app.embed && nbUrl) {
      // Same-tab redirect, mirroring the map-target one below — the chrome-free card already leaves
      // the dashboard on a hit, and `location`/`window.top` are same-origin.
      window.top.location.href = nbUrl;
      return;
    }
    // Search-only embed (FacilitySearchWidget): there is no map in the card to frame the hit on, so
    // leave the dashboard for the full map in the top window — deep-linked at the target's floor and,
    // for a placed hit, at a `#/r/` focus segment so it still frames + pulses (resolved on the floor
    // by FloorEditor._resolveFocusSeg — the same framing focusRoom applies in-app). Mirrors
    // openBuilding's embed redirect: location.pathname is the MapView URL minus the ?embed=1 query.
    if (this.app.embed) {
      const hash = t.unassigned
        ? '/f/' + encodeURIComponent(t.dir) + '/' + encodeURIComponent(t.fid)
        : '/r/' + encodeURIComponent(t.dir) + '/' + encodeURIComponent(t.fid)
          + '/' + encodeURIComponent(this._focusSeg(t));
      window.top.location.href = location.pathname + '#' + this.app._hash(hash);
      return;
    }
    if (t.unassigned) {
      this.app.go('/f/' + encodeURIComponent(t.dir) + '/' + encodeURIComponent(t.fid));
      return;
    }
    // Framed through the shared Geom helpers, so a search hit and the `#/r/` deep-link
    // (FloorEditor._resolveFocusSeg) land on the same view of the same target.
    const region = (t.kind === 'room' && t.polygon && t.polygon.length)
      ? Geom.focusRegion(t.polygon)
      : Geom.pointRegion(t.x != null ? t.x : 0.5, t.y != null ? t.y : 0.5);
    this.app.focusRoom(t.dir, t.fid, t.roomId, region);
  }

  /** The target's NetBox detail-page URL for the search widget's NetBox-target mode (NAV-16), or
   *  null when it has none. A room resolves to its bound Location page (`location.url` for a placed
   *  room, `url` for an unplaced one; an *unbound* room has neither → null → falls back to the map);
   *  a rack/device to its own page (`url`, surfaced server-side onto the placement/inventory payload).
   *  A building has no single NetBox object, so it never resolves here and always opens the map. */
  _netboxUrl(t) {
    if (t.kind === 'building') return null;
    if (t.kind === 'room') return (t.location && t.location.url) || t.url || null;
    return t.url || null;
  }

  /** The `#/r/` deep-link focus segment for a placed target, used by the search-only embed to carry
   *  the framing across the top-window redirect (a room isn't otherwise hash-addressable). A room is
   *  named by its bound Location slug, falling back to the room uid when unbound; a rack/device by
   *  `<kind>-<nbId>`. FloorEditor._resolveFocusSeg decodes it back to the room/placement on arrival. */
  _focusSeg(t) {
    if (t.kind === 'room') return (t.location && t.location.slug) || t.roomId;
    return t.kind + '-' + t.nbId;
  }

  // ---- rendering ----
  /** Static layer: the catcher and every non-selected hotspot with its label (shown
   *  only when the page-wide toggle is on or the building opted in). The selected
   *  hotspot + draft render live in the active layer. Grid rides the base grid layer. */
  _renderStatic(s, W, H) {
    this.addCatcher(s, W, H);
    const byDir = Object.fromEntries(this.store.manifest.buildings.map(b => [b.dir, b]));
    for (const hs of this.effectiveHotspots()) {
      if (hs.source === 'user' && hs.id === this.selected) continue;   // selected → active layer
      this._drawHotspot(s, hs, W, H, byDir);
      // A non-selected hotspot's label shows when the page-wide toggle is on
      // (app.siteLabels) or this building opted in (hs.ref.showLabel).
      if (this.app.siteLabels || (hs.ref && hs.ref.showLabel)) this._drawLabel(s, hs, W, H);
    }
  }

  /** Active layer: the selected hotspot drawn live (reshaping polygon + editable
   *  vertices, or its label with handles while the label is being edited) plus the
   *  draft. Rebuilt on every drag frame so the static hotspots below are untouched. */
  _renderActive(s, W, H) {
    const editing = this.editing();
    const hs = editing && this.selected != null
      ? this.effectiveHotspots().find(h => h.source === 'user' && h.id === this.selected) : null;
    if (hs) {
      const byDir = Object.fromEntries(this.store.manifest.buildings.map(b => [b.dir, b]));
      this._drawHotspot(s, hs, W, H, byDir);
      // While editing the polygon the label is hidden so it doesn't obscure the
      // vertices; when the label itself is being edited, show it (with its handles).
      if (this.editingLabel === hs.id) this._drawLabel(s, hs, W, H);
      else this.drawVertices(s, hs.poly, W, H, hs.id, () => this.markDirty());
    }
    this.drawDraft(s, W, H);
  }

  /** Draw one hotspot polygon into `s`, styled per mode (view = invisible click zone;
   *  edit = ref outline for PDF, editable for user). Shared by the static loop and the
   *  active-layer draw of the selected hotspot — the `.selected` class keys off
   *  `this.selected`, so it lights up only for the selected hotspot either way. */
  _drawHotspot(s, hs, W, H, byDir) {
    const editing = this.editing();
    const b = byDir[hs.dir];
    const has = !!(b && b.floors.length);
    const pts = hs.poly.map(p => `${p[0] * W},${p[1] * H}`).join(' ');
    let cls = 'hotspot ' + hs.source;
    if (!editing) cls += ' view';
    if (editing && hs.source === 'pdf') cls += ' ref';
    if (hs.source === 'user' && hs.id === this.selected) cls += ' selected';
    const poly = Dom.svg('polygon', { points: pts, class: cls });
    if (hs.dir) poly.setAttribute('data-hs', hs.dir);
    if (!has && !editing) { poly.style.opacity = .4; poly.style.cursor = 'default'; }
    poly.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.draft) return;
      if (editing && hs.source === 'user') {
        if (this._promoted && this._promoted !== hs.id) this._discardCleanPromotion();
        this.selected = hs.id; this.render(); this.openHotspotPanel(hs.ref);
      } else if (editing) { this._discardCleanPromotion(); this.promoteHotspot(hs); }
      else if (!editing) this.openBuilding(hs.dir, hs.name);
    });
    const title = Dom.svg('title');
    title.textContent = (hs.name || hs.dir || 'unassigned') + (has ? '' : ' (no map)');
    poly.append(title);
    s.append(poly);
  }

  /** Centered building-name label. By default it is auto-placed on the polygon
   *  bbox and auto-sized to fit (long names wrap to two lines in roughly-square
   *  areas; tiny areas fall back to the short code). A user `labelStyle` overrides
   *  the centre (`x,y`), `size`, `rot`, `font`, `color`, and the **display `text`**
   *  (visual only — its line breaks are honoured and it is fit to the box, but it
   *  never changes the building name). The text is centred at the group origin so
   *  attachLabel can translate+rotate it (and add edit handles). */
  _drawLabel(s, hs, W, H) {
    const REF = 100, FILL = 0.82, MIN = 7, MAX = 22;
    const shape = hs.ref || hs;        // the persistent store hotspot carries labelStyle
    const ls = shape.labelStyle || {};
    const name = (hs.name && hs.name.trim()) || hs.code || hs.dir || '';
    const custom = ls.text != null ? ls.text : null;
    if (!name && custom == null) return;

    const b = Geom.bounds(hs.poly);
    let cx, cy;
    if (ls.x != null && ls.y != null) { cx = ls.x; cy = ls.y; }   // explicit placement is respected as-is
    else { cx = b.cx; cy = b.cy; if (!Geom.pointInPoly(cx, cy, hs.poly)) [cx, cy] = Geom.clampToPoly(cx, cy, hs.poly); }

    const t = Dom.svg('text', { x: 0, y: 0, 'text-anchor': 'middle',
      'dominant-baseline': 'central', class: 'hotspot-label' });
    const availW = b.w * W * FILL, availH = b.h * H * FILL;
    // Measure once at a reference size then scale analytically
    // (preserveAspectRatio:none → 1 unit == 1 displayed px). The text must be in
    // the DOM to measure; attachLabel re-parents it into the rotatable group.
    const measure = () => {
      const bb = t.getBBox();
      return (bb.width && bb.height) ? Math.min(availW / bb.width, availH / bb.height) : 0;
    };

    let size;
    if (custom != null) {
      // User display text: honour its explicit line breaks; fit it to the box (or to
      // an explicit size). Never auto-wraps or falls back to the code.
      this._setLabelLines(t, custom.split('\n'));
      if (ls.size != null) size = ls.size;
      else {
        if (availW <= 0 || availH <= 0) return;
        t.style.fontSize = REF + 'px'; s.append(t);
        size = Math.max(MIN, Math.min(MAX, REF * measure())); s.removeChild(t);
      }
    } else if (ls.size != null) {
      this._setLabelLines(t, [name]); size = ls.size;
    } else {
      if (availW <= 0 || availH <= 0) return;
      t.style.fontSize = REF + 'px';
      this._setLabelLines(t, [name]); s.append(t);
      let scale = measure();
      const ar = (b.h * H) ? (b.w * W) / (b.h * H) : 1;
      if (name.split(/\s+/).length >= 2 && ar > 0.6 && ar < 1.7 && REF * scale < 11) {
        const wrapped = this._wrapLines(name);
        if (wrapped.length === 2) {
          this._setLabelLines(t, wrapped);
          const wScale = measure();
          if (wScale > scale) scale = wScale; else this._setLabelLines(t, [name]); // keep the bigger fit
        }
      }
      if (REF * scale < MIN && hs.code && name !== hs.code) { this._setLabelLines(t, [hs.code]); scale = measure(); }
      size = Math.max(MIN, Math.min(MAX, REF * scale));
      s.removeChild(t);
    }
    t.style.fontSize = size + 'px'; // inline style — a CSS font-size rule would win over an attribute
    t.style.strokeWidth = (size / 6).toFixed(2) + 'px'; // keep the halo proportional to the text
    this.attachLabel(s, shape, t, cx, cy, size, W, H);
    // A building label is analytically fit to its building box, so opt it out of the zoomed-out
    // legibility floor (like a rack's `inside` name) — flooring it would overflow the building
    // outline. The floor is for the floor-map's floating labels, not these box-fit ones.
    t.parentNode.style.setProperty('--label-floor', '0');
  }

  /** Split a name into two character-balanced lines (greedy on word boundaries). */
  _wrapLines(name) {
    const words = name.trim().split(/\s+/);
    if (words.length < 2) return [name];
    const half = name.length / 2;
    let i = 1, line1 = words[0];
    while (i < words.length && line1.length + 1 + words[i].length <= half) { line1 += ' ' + words[i]; i++; }
    if (i >= words.length) { i = words.length - 1; line1 = words.slice(0, i).join(' '); }
    return [line1, words.slice(i).join(' ')];
  }

  /** Promote a PDF/source hotspot into an editable user hotspot. The new user
   *  hotspot overrides the PDF one for the same `dir` (via effectiveHotspots), so
   *  there is no duplicate. Not marked dirty: an inspect-click that never edits the
   *  shape is discarded again by _discardCleanPromotion (see markDirty/deselect). */
  promoteHotspot(pdfHs) {
    const hs = { id: Util.uid(), dir: pdfHs.dir, name: pdfHs.name,
      poly: pdfHs.poly.map(p => p.slice()) };   // deep copy — never mutate the manifest poly
    this.store.siteHotspots.push(hs);
    this.selected = hs.id; this._promoted = hs.id;
    this.render(); this.openHotspotPanel(hs);
  }

  /** Drop a promoted-but-unedited hotspot so a stray click never dirties the file. */
  _discardCleanPromotion() {
    if (!this._promoted) return;
    const i = this.store.siteHotspots.findIndex(h => h.id === this._promoted);
    if (i >= 0) this.store.siteHotspots.splice(i, 1);
    if (this.selected === this._promoted) this.selected = null;
    this._promoted = null;
  }

  handleKey(e) {
    // Escape out of label-edit mode first (back to the hotspot panel), then out of
    // selection.
    if (e.key === 'Escape' && this.editingLabel && !this.draft) {
      const hs = this.store.siteHotspots.find(h => h.id === this.editingLabel);
      this.editingLabel = null; this.render();
      if (hs) this.openHotspotPanel(hs);
      return;
    }
    if (e.key === 'Escape' && this.selected && !this.draft) {
      this._discardCleanPromotion();
      this.selected = null; this.render(); this.app.closePanel();
      return;
    }
    super.handleKey(e);
  }

  // ---- drawing actions ----
  finish() {
    const dp = this.draft.points;
    if (dp.length < 3) { this.draft = null; this.render(); return; }
    this.snapshot();   // before the new hotspot lands, so Ctrl+Z removes it
    const hs = { id: Util.uid(), dir: null, name: '', poly: dp.slice() };
    this.store.siteHotspots.push(hs);
    this.draft = null; this.selected = hs.id; this.markDirty();
    this.render(); this.openHotspotPanel(hs);
  }

  _persist() { return this.store.saveSiteplan(); }
  _savedMessage() { return 'Siteplan saved'; }

  openHotspotPanel(hs) {
    const panel = Dom.$('#panel'); panel.classList.remove('hidden');
    Dom.$('#panel-title').textContent = hs.dir ? (hs.name || hs.dir) : 'Bind area';
    const body = Dom.$('#panel-body'); body.innerHTML = '';

    body.append(Dom.el('div', { class: 'field' }, [
      Dom.el('label', {}, 'Assigned building'),
      Dom.el('div', { class: 'val' }, hs.dir ? (hs.name || hs.dir) : '(unassigned)'),
    ]));
    body.append(Dom.el('button', { class: 'wide', html: Icons.edit + '<span>Edit label</span>',
      onclick: () => {
        this.editingLabel = hs.id; this.render();
        const dn = (hs.name && hs.name.trim()) || (hs.dir ? Util.code(hs.dir) : '') || '';
        this.openLabelPanel(hs, () => { this.editingLabel = null; this.render(); this.openHotspotPanel(hs); }, dn);
      } }));
    // Per-building label visibility — opts this one building's label in even when the
    // page-wide toggle is off. Persisted on the store hotspot (separate from labelStyle
    // so "Reset to auto" never wipes it); Save siteplan writes it.
    body.append(Dom.el('button', { class: 'wide',
      html: Icons.edit + '<span>' + (hs.showLabel ? 'Hide label' : 'Show label') + '</span>',
      onclick: () => { this.snapshot(); hs.showLabel = !hs.showLabel; this.markDirty(); this.render(); this.openHotspotPanel(hs); } }));
    body.append(Dom.el('button', { class: 'danger wide', onclick: () => {
      this.snapshot();
      const i = this.store.siteHotspots.indexOf(hs);
      if (i >= 0) this.store.siteHotspots.splice(i, 1);
      this.selected = null; this.editingLabel = null; this.markDirty(); this.render(); this.app.closePanel();
    } }, 'Delete area'));
    body.append(Dom.el('div', { class: 'hint' }, 'Assign this area to a building:'));
    this._bindList(body, {
      placeholder: 'Search buildings…', items: this.store.manifest.buildings,
      filter: (b, ql) => !ql || b.name.toLowerCase().includes(ql) || b.dir.toLowerCase().includes(ql),
      row: (b) => ({
        nm: Util.code(b.dir) + ' · ' + b.name + (hs.dir === b.dir ? '  ✓' : ''),
        sl: b.floors.length ? b.floors.length + ' floors' : 'no map',
        bound: hs.dir === b.dir,
      }),
      pick: (b) => { this.snapshot(); hs.dir = b.dir; hs.name = b.name; this.markDirty(); this.render(); this.openHotspotPanel(hs); },
    });
  }
}
