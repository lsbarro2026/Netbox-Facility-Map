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
const FINDER_DEBOUNCE_MS = 250;   // keystroke -> inventory-fetch delay in the wayfinding finder

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
  /** The stored array itself (SITE-1) — unlike `polys()` above, which is the *snapping* accessor
   *  and deliberately returns a fresh projection. `store.siteHotspots`' order already IS the
   *  paint order for user hotspots (`effectiveHotspots()` maps it in place, PDF ones always
   *  painted first/beneath), so no new persisted field is needed — the array itself round-trips
   *  through the `siteplan` blob. */
  _shapeList() { return this.store.siteHotspots; }
  markDirty() {
    // The first real edit commits a promoted hotspot, so it is no longer discarded.
    if (this.selected && this.selected === this._promoted) this._promoted = null;
    this.store.markSiteDirty(); this._setBadge();
  }
  /** `had` is read BEFORE the discard because `_discardCleanPromotion` clears `this.selected`
   *  itself when the promoted hotspot is the selected one — testing it afterwards would skip the
   *  re-render and panel close for exactly the case that most needs them (the promoted hotspot has
   *  just been spliced out from under an open panel). */
  deselect() {
    const had = !!this.selected;
    this._discardCleanPromotion();
    if (had) { this.selected = null; this.editingLabel = null; this.render(); this.app.closePanel(); }
  }

  // ---- undo hooks (see Editor.snapshot/undo) ----
  /** A snapshot of everything an edit here can change — the user siteplan hotspots — captured
   *  BEFORE the mutation. The siteDirty flag is NOT stored: `_applySnapshot` re-derives it from the
   *  siteplan baseline (SAVE-6), so it stays correct even after a save advances that baseline (same
   *  contract the floor editor documents). Cloned through the base `_clone`.
   *  Returning a non-null snapshot also opts vertex drags into undo automatically: the base drag
   *  machinery captures `_gestureSnap = _snapshotState()` on pointerdown (editor-pointer.js) and commits it
   *  on pointerup only if the drag moved geometry. */
  _snapshotState() {
    return {
      hotspots: this._clone(this.store.siteHotspots),
      promoted: this._promoted,   // preserve the discard-on-deselect safety across undo
    };
  }

  /** Write a snapshot back: the cloned hotspots, the dirty flag re-derived from the siteplan
   *  baseline, and the promotion flag — restoring `_promoted` keeps a promoted-but-unbound
   *  hotspot's discard-on-deselect safety intact when undoing back to that state. The shared tail
   *  (transient state, badge, panel close) and the re-render are the base's (`Editor._restoreState`
   *  / `undo`). */
  _applySnapshot(snap) {
    this.store.siteHotspots = snap.hotspots;
    this.store.recomputeSiteDirty();
    this._promoted = snap.promoted || null;
  }

  _dirtyScopes() { return ['site']; }

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
      code: this.store.building(h.dir) ? Util.code(this.store.building(h.dir)) : (h.dir || '?'),
      poly: h.poly,
    }));
    return pdf.concat(user);
  }

  // ---- view assembly ----
  show() {
    const sp = this.store.manifest.siteplan;
    this.draft = null; this.selected = null; this.editingLabel = null; this._promoted = null; this.grid.adjust = false;
    this.rectMode = false; this.rectDraft = null;   // a re-show never inherits an armed rectangle tool
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
    this.app.setToolbar(this.toolbar.build());

    const img = Dom.el('img', { src: this.store.mediaUrl(sp.image), alt: 'siteplan' });
    const s = Dom.svg('svg', { preserveAspectRatio: 'none' });
    const wrap = Dom.el('div', { class: 'map-wrap' }, [img, s]);
    const viewport = Dom.el('div', { class: 'map-viewport' }, wrap);
    // Build the finder as a SIBLING of the legend (search-first mobile layout, NAV-20): on desktop
    // `_installMobileLayout` puts it back as the legend's first child (identical to before); on a
    // phone it stays in the `.siteplan-search` bar pinned above the map while the legend is a
    // drawer. The map embed has no finder, so no search bar / mobile relayout there.
    const finderEl = this.app.embed ? null : this._finder();
    const legend = this._legend(s, { finder: false });
    // The drag-to-resize / collapse chrome is for the full app only. The dashboard-widget
    // embed is chrome-free and never persists UI prefs, so it keeps the plain fixed index.
    const children = [viewport, legend];
    let handle = null;
    if (!this.app.embed) {
      handle = Dom.el('div', { class: 'legend-resize',
        title: 'Drag to resize · double-click to hide the buildings panel' });
      children.splice(1, 0, handle);   // viewport | handle | legend
    }
    // The bar carries its own Done control, shown by CSS only while the mobile search is expanded
    // (NAV-21) — the way back to the map when you searched and changed your mind.
    const search = finderEl ? Dom.el('div', { class: 'siteplan-search' },
      Dom.el('button', { class: 'siteplan-search-close', type: 'button' }, 'Done')) : null;
    if (search) children.unshift(search);   // leads the view so its mobile bar sits above the map
    const view = Dom.el('div', { class: 'siteplan-view' }, children);
    stage.append(view);
    if (!this.app.embed) this._installLegendResize(view, legend, handle);
    this.attach(img, s, [sp.w, sp.h]);
    // After attach (so its top-of-attach detach() can't strip the listener just added below).
    if (finderEl) this._installMobileLayout(view, legend, finderEl, search);
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
   *  `EditorToolbar.build()` (and its mode toggle) is intentionally bypassed; only the view-mode To-do tool
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
      view, panel: legend, handle, title: 'Show or hide the buildings panel',
      widthKey: LEGEND_WIDTH_KEY, collapsedKey: LEGEND_COLLAPSED_KEY,
      minW: LEGEND_MIN_W, collapseW: LEGEND_COLLAPSE_W, defaultW: LEGEND_DEFAULT_W,
      maxFrac: LEGEND_MAX_FRAC,
    });
  }

  /** Search-first phone layout (NAV-20): a `matchMedia` controller that relocates the single finder
   *  node by width so desktop stays byte-for-byte identical (finder is the legend's first child, a
   *  fixed side column that drag-resizes as before, NAV-7). On a narrow screen the finder moves into
   *  the top-pinned `.siteplan-search` bar and the legend becomes a fixed slide-in drawer
   *  (`.mobile-drawer`), force-collapsed so the map is full-width; `#panel-toggle` opens it. The
   *  `.map-viewport` reflow to full width trips `attach()`'s ResizeObserver, which re-fits the map.
   *  The collapse here does NOT persist, so it never clobbers the desktop show/hide pref. The
   *  listener is torn down in `detach()` (BUG-2 observer discipline). Runs after `_installLegendResize`
   *  so `_setPanelCollapsed` exists.
   *
   *  It also owns the phone's **expanded search** state (NAV-21). Pinned in flow, the bar is squeezed
   *  between the topbar above and the soft keyboard below, which is what left the results half
   *  visible; so while the finder is focused (or still holds a query) the view carries `.searching`
   *  and CSS lifts the bar out of flow into a full-screen overlay. Expanding also force-collapses
   *  the buildings drawer (NAV-22): an open drawer out-stacks the overlay and covers the search all
   *  over again, and a drawer buried under a full-screen overlay is worse than a closed one.
   *  Otherwise only the class is toggled here;
   *  the map, freed of the bar, reflows to full height, which is a plain viewport resize — it runs
   *  through `attach()`'s ResizeObserver as a re-clamp, never a refit, so the user's pan/zoom
   *  survives a search. The class is width-gated and cleared on the desktop branch, so it can never
   *  leak into the side-column layout. These listeners live on nodes `show()` rebuilds, so they are
   *  discarded with the stage and need no teardown of their own. */
  _installMobileLayout(view, legend, finderEl, search) {
    const mq = Util.phoneMq();
    const input = finderEl.querySelector('.legend-search');
    const closeBtn = search.querySelector('.siteplan-search-close');
    const setSearching = (on) => {
      const expanded = on && mq.matches;
      // Expanding takes over the screen, so the buildings drawer must go with it (NAV-22). Left
      // open it paints OVER the overlay (`.mobile-drawer` z-20 vs the overlay's z-18) and the
      // search is half-covered again — the same report, by a different route. Closing it rather
      // than out-stacking it is the honest fix: a drawer stranded under a full-screen overlay is
      // the worse state. Same non-persisting collapse the width branch uses, so the desktop
      // show/hide pref is never clobbered (§10 *A mobile force-collapse must not persist*).
      if (expanded && this._setPanelCollapsed) this._setPanelCollapsed(true, false);
      view.classList.toggle('searching', expanded);
    };
    if (input) {
      input.addEventListener('focus', () => setSearching(true));
      // Blur alone must not collapse the overlay: dismissing the keyboard to read the results
      // blurs the input, and the list is the whole point. Only an abandoned (empty) box does.
      input.addEventListener('blur', () => { if (!input.value.trim()) setSearching(false); });
    }
    if (closeBtn) closeBtn.addEventListener('click', () => { if (input) input.blur(); setSearching(false); });
    const apply = () => {
      if (mq.matches) {
        if (finderEl.parentNode !== search) search.append(finderEl);
        legend.classList.add('mobile-drawer');
        if (this._setPanelCollapsed) this._setPanelCollapsed(true, false);
      } else {
        if (finderEl.parentNode !== legend) legend.prepend(finderEl);
        legend.classList.remove('mobile-drawer');
        view.classList.remove('searching');
        // Back on desktop: honour the persisted show/hide pref the drawer never wrote to.
        if (this._setPanelCollapsed) this._setPanelCollapsed(this._loadPanelCollapsed(LEGEND_COLLAPSED_KEY), false);
      }
    };
    apply();
    this._mobileMq = mq;
    this._mobileMqHandler = apply;
    mq.addEventListener('change', apply);
  }

  /** Also drop the mobile-layout `matchMedia` listener when the editor is torn down on navigation
   *  (App._detachCurrent), so it never fires against a replaced view (BUG-2). The base handles the
   *  container ResizeObserver. Safe on the initial `attach()`'s top-of-attach detach: the listener
   *  is installed only afterwards, so `_mobileMq` is still null there. */
  detach() {
    super.detach();
    if (this._mobileMq) { this._mobileMq.removeEventListener('change', this._mobileMqHandler); this._mobileMq = null; }
  }

  // ---- toolbar hooks (assembled by EditorToolbar.build) ----
  // The edit-mode draw tools (Add building area + Add rectangle), undo, the
  // snap/right-angle/grid factory row and Save+badge all come from the base — this editor
  // adds no tool of its own, so it overrides neither _editButtons nor _alignTools.
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

  /** `opts.finder` (default true) — whether to mount the wayfinding search atop the index. The
   *  siteplan map view (`show`) passes `false` and mounts the finder as a *sibling* of the legend
   *  instead, so the mobile search-first layout (`_installMobileLayout`, NAV-20) can keep it pinned
   *  at the top of the screen while the legend collapses into a drawer; every other caller
   *  (`_showDirectory`) keeps it inside the panel as before. */
  _legend(s, { finder = true } = {}) {
    const legend = Dom.el('aside', { class: 'legend' });
    // Hiding the index is the top-bar toggle's job now (NAV-8); the panel itself carries no
    // collapse chrome, so it opens straight into the search + browse list.
    // One combined wayfinding search over the building index (NAV-4): it finds buildings plus
    // rooms/racks/devices anywhere in the facility. Skipped in the map embed (FacilityMapWidget),
    // which has no in-app navigation — so the index below is a plain browse list there. (The
    // search-only embed, FacilitySearchWidget/NAV-15, renders the finder standalone via
    // `_showFinderOnly` and never reaches this legend.)
    if (finder && !this.app.embed) legend.append(this._finder());
    legend.append(Dom.el('div', { class: 'legend-head' }, 'All buildings'));
    const numbered = this.store.manifest.buildings.filter(b => Util.isNumbered(b.dir));
    const other = this.store.manifest.buildings.filter(b => !Util.isNumbered(b.dir));
    // Only label the two groups apart when both exist (MULTI-6): an all-numbered facility (the
    // common case) stays a flat unlabeled list exactly as before, and an all-other facility never
    // gets a pointless "Other" heading with nothing to contrast it against.
    const mixed = numbered.length > 0 && other.length > 0;
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
          Dom.el('span', { class: 'lc' }, Util.code(b)),
          Dom.el('span', { class: 'ln' }, b.name + (has ? '' : ' (no map)')),
          (!hasMap || onMap.has(b.dir)) ? null : Dom.el('span', { class: 'nopin', title: 'Not placed on the map' }, '◌'),
        ]));
      }
    };
    addGroup('', numbered);
    addGroup(mixed ? 'Other' : '', other);
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
    let serverErr = false;  // the CURRENT query's inventory fetch failed (distinct from "no matches")
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
      // An outage must read distinctly from a real empty result (UX-16) — a plain re-render of
      // "No matches" would otherwise hide that the unplaced half of the search never ran.
      if (serverErr) {
        const retry = Dom.el('button', { class: 'finder-retry', type: 'button' }, 'Retry');
        retry.onclick = () => fetchInventory(q.trim());
        results.append(Dom.el('div', { class: 'finder-error' },
          [Dom.el('span', {}, "Couldn't reach the server — showing placed results only."), retry]));
        return;
      }
      results.append(Dom.el('div', { class: 'finder-empty' },
        (pending || !floorLoaded) ? 'Searching…' : 'No matches'));
    };

    // Shared by the debounced keystroke path and the error row's Retry button, so a manual retry
    // runs the exact same request/response handling (token check, pending/error flags, re-render).
    const fetchInventory = (ql) => {
      pending = true; serverErr = false;
      render();   // Retry's click has no other re-render on its way to "Searching…"
      const reqToken = ++token;
      this.app.netbox.inventory(ql)
        .then(inv => { if (reqToken === token) { serverInv = inv; pending = false; render(); } })
        .catch(() => { if (reqToken === token) { pending = false; serverErr = true; render(); } });
    };

    // Each keystroke re-renders placed results instantly, then (for a query past the server's
    // minimum) debounces one inventory fetch. `serverInv` resets so a prior query's unplaced rows
    // never linger; `token` drops a response that a newer keystroke has superseded.
    const onInput = () => {
      q = input.value;
      serverInv = null; serverErr = false;
      render();
      clearTimeout(timer);
      const ql = q.trim();
      if (ql.length < 2) { pending = false; return; }   // mirror the server MIN_Q
      pending = true;   // true through the debounce window too, so render() reads "Searching…"
      timer = setTimeout(() => fetchInventory(ql), FINDER_DEBOUNCE_MS);
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
      const name = b.name.toLowerCase(), code = Util.code(b).toLowerCase(), dir = b.dir.toLowerCase();
      let rank = -1;
      if (name.startsWith(ql) || code.startsWith(ql)) rank = 0;
      else if (name.includes(ql) || code.includes(ql) || dir.includes(ql)) rank = 1;
      if (rank >= 0) scored.push({ b, rank });
    }
    scored.sort((a, b) => a.rank - b.rank);
    return scored.map(s => ({ kind: 'building', label: s.b.name, dir: s.b.dir,
      code: Util.code(s.b), hasMap: s.b.floors.length > 0 }));
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
   *  with the NetBox site/floor names. `null`/absent response → [].
   *
   *  The server's `racked_devices` (NAV-19) take a third path: a device inside a rack has no marker
   *  of its own — the rack is one opaque icon — so a hit resolves to its *rack's* placement and
   *  navigates there, and only falls back to the plain unplaced treatment when the rack isn't placed
   *  either. `placedMarks` therefore maps id → the placed target, not just membership. */
  _finderUnplaced(inv) {
    if (!inv) return [];
    const placedRooms = new Set(), placedMarks = new Map();
    for (const t of this.store.searchTargets()) {
      if (t.kind === 'room') { if (t.location && t.location.id != null) placedRooms.add(t.location.id); }
      else if (t.nbId != null) placedMarks.set(t.kind + ':' + t.nbId, t);
    }
    // Manifest floor lookup: "<dir>/<fid>" -> the map building/floor to navigate to. `dir`==site slug
    // and `fid`==floor Location slug, so this keys directly off a result's (site_slug, floor_slug).
    const floors = {};
    for (const b of this.store.manifest.buildings)
      for (const f of b.floors)
        floors[b.dir + '/' + f.id] = { dir: b.dir, fid: f.id, building: b.name, floor: f.label };

    const out = [];
    const add = (item, kind, extra) => {
      const dup = kind === 'room' ? placedRooms.has(item.id) : placedMarks.has(kind + ':' + item.id);
      if (dup) return;   // already surfaced by the placed path
      const mapped = floors[item.site_slug + '/' + item.floor_slug];
      // `url` (the object's NetBox page, from NbInventoryView) rides every row for the search
      // widget's NetBox-target mode (NAV-16); it's what lets an unmapped-floor row still be reached.
      if (mapped) out.push(Object.assign({ kind, unassigned: true, label: item.name || '', url: item.url || null,
        dir: mapped.dir, fid: mapped.fid, building: mapped.building, floor: mapped.floor }, extra));
      else out.push(Object.assign({ kind, unassigned: true, disabled: true, label: item.name || '', url: item.url || null,
        building: item.site_name || item.site_slug, floor: item.floor_name || item.floor_slug }, extra));
    };
    // A rack-mounted device (NAV-19) rides its rack: when the rack is placed, the row is that rack's
    // placed target relabelled with the device — same floor, same marker, same pulse — so clicking it
    // lands exactly where the device physically is. `focusKind` keeps the deep-link segment pointed at
    // the *rack* placement (`_focusSeg`), since no `device-<id>` marker exists to resolve. When the
    // rack isn't placed, fall through to the ordinary unplaced treatment on the rack's own floor.
    const addRacked = (item) => {
      if (placedMarks.has('device:' + item.id)) return;   // separately placed as its own marker
      const rack = placedMarks.get('rack:' + item.rack_id);
      if (!rack) { add(item, 'device', { rack: item.rack_name || '' }); return; }
      out.push(Object.assign({}, rack, { kind: 'device', label: item.name || '',
        url: item.url || null, rack: item.rack_name || '', focusKind: 'rack', nbId: item.rack_id }));
    };
    (inv.rooms || []).forEach(r => add(r, 'room'));
    (inv.racks || []).forEach(r => add(r, 'rack'));
    (inv.devices || []).forEach(d => add(d, 'device'));
    (inv.racked_devices || []).forEach(d => addRacked(d));
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
   *  no page (an unbound room, a building) falls back to the map. A rack-mounted device (NAV-19)
   *  names its containing rack in the subtitle — the map takes you to the rack, so the row says which
   *  one to open. */
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
      sub = t.building + ' · ' + t.floor + (locName && locName !== primary ? ' · ' + locName : '')
        + (t.rack ? ' · Rack ' + t.rack : '');
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
   *  `App.focusRoom`. A rack-mounted device (NAV-19) arrives here already carrying its *rack's*
   *  placement, so it takes the same placed path — no device marker exists to frame.
   *  An *unplaced* target (NAV-3) has no polygon/marker, so it just opens its
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
   *  `<kind>-<nbId>`. FloorEditor._resolveFocusSeg decodes it back to the room/placement on arrival.
   *  `focusKind` overrides the kind when the row's marker isn't its own: a rack-mounted device
   *  (NAV-19) rides its rack's placement, so the segment must name `rack-<rackId>` — there is no
   *  `device-<id>` marker on the floor for the resolver to find. */
  _focusSeg(t) {
    if (t.kind === 'room') return (t.location && t.location.slug) || t.roomId;
    return (t.focusKind || t.kind) + '-' + t.nbId;
  }

  // ---- rendering ----
  /** Static layer: the catcher and every non-selected hotspot with its label (shown
   *  only when the page-wide toggle is on or the building opted in). The selected
   *  hotspot + draft render live in the active layer. Grid rides the base grid layer. */
  _renderStatic(s, W, H) {
    this.shapes.addCatcher(s, W, H);
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
      else this.shapes.drawVertices(s, hs.poly, W, H, hs.id, () => this.markDirty());
    }
    this.shapes.drawDraft(s, W, H);
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
      // This handler stops propagation, so the svg-level click guard never sees the event —
      // consult the shared flag here or a two-finger pinch that lifts over a building opens it
      // (MOBILE-2).
      if (this.pointer.gestureClick()) return;
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
    // the DOM to measure; attachLabel re-parents it into the rotatable group. The measurement
    // itself rides the shared, guarded `EditorShapes.labelBox` (an unmeasurable box → scale 0 → the
    // MIN clamp below); the fit-and-wrap policy around it is this editor's own — a building name
    // is sized to its building box, whereas every floor-map label carries an explicit size (§10
    // *Label engine*: floor rooms aren't labelled at all).
    const measure = () => {
      const bb = this.shapes.labelBox(t);
      return bb ? Math.min(availW / bb.width, availH / bb.height) : 0;
    };

    let size;
    if (custom != null) {
      // User display text: honour its explicit line breaks; fit it to the box (or to
      // an explicit size). Never auto-wraps or falls back to the code.
      this.shapes.setLabelLines(t, custom.split('\n'));
      if (ls.size != null) size = ls.size;
      else {
        if (availW <= 0 || availH <= 0) return;
        t.style.fontSize = REF + 'px'; s.append(t);
        size = Math.max(MIN, Math.min(MAX, REF * measure())); s.removeChild(t);
      }
    } else if (ls.size != null) {
      this.shapes.setLabelLines(t, [name]); size = ls.size;
    } else {
      if (availW <= 0 || availH <= 0) return;
      t.style.fontSize = REF + 'px';
      this.shapes.setLabelLines(t, [name]); s.append(t);
      let scale = measure();
      const ar = (b.h * H) ? (b.w * W) / (b.h * H) : 1;
      if (name.split(/\s+/).length >= 2 && ar > 0.6 && ar < 1.7 && REF * scale < 11) {
        const wrapped = this._wrapLines(name);
        if (wrapped.length === 2) {
          this.shapes.setLabelLines(t, wrapped);
          const wScale = measure();
          if (wScale > scale) scale = wScale; else this.shapes.setLabelLines(t, [name]); // keep the bigger fit
        }
      }
      if (REF * scale < MIN && hs.code && name !== hs.code) { this.shapes.setLabelLines(t, [hs.code]); scale = measure(); }
      size = Math.max(MIN, Math.min(MAX, REF * scale));
      s.removeChild(t);
    }
    t.style.fontSize = size + 'px'; // inline style — a CSS font-size rule would win over an attribute
    t.style.strokeWidth = (size / 6).toFixed(2) + 'px'; // keep the halo proportional to the text
    this.shapes.attachLabel(s, shape, t, cx, cy, size, W, H);
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
    // Escape out of label-edit mode first (back to the hotspot panel) via the shared rung; the
    // base's own Escape ladder then handles the draft and, through `deselect`, the selection.
    if (e.key === 'Escape' && this.editingLabel && !this.draft) {
      const hs = this.store.siteHotspots.find(h => h.id === this.editingLabel);
      this._exitLabelEdit(() => { if (hs) this.openHotspotPanel(hs); });
      return;
    }
    super.handleKey(e);
  }

  /** The siteplan's own bindings on top of the shared engine (UX-17). Its Escape ladder has one
   *  rung the base doesn't describe — label-edit backs out to the area's panel before Escape
   *  reaches the selection — and its shared draw tools outline a building rather than a room. Rooms,
   *  arrows, notes and markers are floor-editor concepts, so none of the floor's Delete-key rows
   *  appear here: this editor genuinely doesn't bind them. */
  _shortcutGroups() {
    return super._shortcutGroups().concat([
      { title: 'Building areas', rows: [
        ['Click an area', 'Open that building'],
        ['Esc', 'Leave label editing, then deselect the area'],
      ] },
    ]);
  }

  // ---- the shape seam (Editor's shared create path) ----
  // A "shape" here is a building-area hotspot. Drawing, the rectangle tool and Duplicate all
  // run off these four hooks on the base — the siteplan never implements a create path of its
  // own (§10 *Edit-menu lockstep*).
  _newShape(poly) {
    const hs = { id: Util.uid(), dir: null, name: '', poly };
    this.store.siteHotspots.push(hs);
    return hs;
  }
  _openShapePanel(hs) { this.openHotspotPanel(hs); }
  _shapePoly(hs) { return hs.poly; }
  _shapeTerms() { return { noun: 'building area', drawLabel: 'Add building area' }; }

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
    body.append(Dom.el('button', { class: 'wide', title: 'Style, resize, or reposition this building’s label',
      html: Icons.edit + '<span>Edit label</span>',
      onclick: () => {
        this.editingLabel = hs.id; this.render();
        const dn = (hs.name && hs.name.trim()) || (hs.dir ? Util.code(this.store.building(hs.dir)) : '') || '';
        this.shapes.openLabelPanel(hs, () => this._exitLabelEdit(() => this.openHotspotPanel(hs)), dn);
      } }));
    // Per-building label visibility — opts this one building's label in even when the
    // page-wide toggle is off. Persisted on the store hotspot (separate from labelStyle
    // so "Reset to auto" never wipes it); Save siteplan writes it.
    body.append(Dom.el('button', { class: 'wide',
      title: 'Override the page-wide label visibility for just this building',
      html: Icons.edit + '<span>' + (hs.showLabel ? 'Hide label' : 'Show label') + '</span>',
      onclick: () => { this.snapshot(); hs.showLabel = !hs.showLabel; this.markDirty(); this.render(); this.openHotspotPanel(hs); } }));
    // Build off this area's outline — the duplicate lands unbound, so an adjacent building
    // starts from a matching footprint instead of being retraced.
    body.append(this.toolbar.duplicateButton(hs));
    // Stacking order (ROOM-4/SITE-1): which building area paints — and takes the click —
    // where two overlap. `layerButtons` returns null for an editor that hasn't opted into
    // layering (`_shapeList`), and `Node.append(null)` would render the string "null" — so
    // guard rather than appending blind, matching FloorEditor.openRoomPanel.
    const layers = this.toolbar.layerButtons(hs);
    if (layers) body.append(layers);
    body.append(Dom.el('button', { class: 'danger wide', onclick: () => {
      this.snapshot();
      const i = this.store.siteHotspots.indexOf(hs);
      if (i >= 0) this.store.siteHotspots.splice(i, 1);
      this.selected = null; this.editingLabel = null; this.markDirty(); this.render(); this.app.closePanel();
      this._deleteToast('Building area deleted');
    } }, 'Delete area'));
    body.append(Dom.el('div', { class: 'hint' }, 'Assign this area to a building:'));
    this._bindList(body, {
      placeholder: 'Search buildings…', items: this.store.manifest.buildings,
      filter: (b, ql) => !ql || b.name.toLowerCase().includes(ql) || b.dir.toLowerCase().includes(ql),
      row: (b) => ({
        nm: Util.code(b) + ' · ' + b.name + (hs.dir === b.dir ? '  ✓' : ''),
        sl: b.floors.length ? b.floors.length + ' floors' : 'no map',
        bound: hs.dir === b.dir,
      }),
      pick: (b) => { this.snapshot(); hs.dir = b.dir; hs.name = b.name; this.markDirty(); this.render(); this.openHotspotPanel(hs); },
    });
  }
}
