'use strict';
/* app.js — App: top-level orchestrator and entry point. Owns the singletons
   (Store, NetBoxClient, GridController), cross-view UI state (edit/view mode,
   siteplan-edit flag, siteplan-label visibility, view-mode highlight mode
   (all rooms / rooms-with-devices / none, default all), the hash
   router, and global chrome
   (breadcrumbs, toolbar, side panel, keyboard). Loaded LAST. */

class App {
  constructor() {
    this.store = new Store();
    this.netbox = new NetBoxClient();
    this.grid = new GridController();   // shared by both editors
    this.mode = 'view';                 // floor editor: 'edit' | 'view' (showFloor resets to view per entry); rack placement is FloorEditor.placingRacks, a sub-mode of edit
    this.siteEdit = false;              // siteplan: editing building areas
    this.siteLabels = false;            // siteplan: show building name labels (hidden by default)
    this.highlight = 'all';             // floor view-mode highlight: 'all' rooms (default) | 'placements' (rooms with devices) | 'none'
    this.current = null;                // active Editor (or null on building view)
    // Embedded in a dashboard-widget iframe (?embed=1): chrome hidden + no in-card navigation.
    // A building click opens the full map in the top window instead (SiteplanEditor.openBuilding),
    // since the chrome-free card has no breadcrumbs to return through. Interactivity (pan/zoom +
    // zoom controls + keyboard) is opt-in there and always on in the standalone app; the editors
    // and the keyboard handler consult `interactive`.
    this.embed = !!(window.MAP && window.MAP.embed);
    this.interactive = !this.embed || !!(window.MAP && window.MAP.interactive);
    // Import/reset are gated server-side; these mirror the gate so we don't offer a wizard whose
    // every call would 403 (canImport = import_facilitymapblob) or a reset the user can't run
    // (canReset = superuser). The server is the security boundary — these are UX only.
    this.canImport = !!(window.MAP && window.MAP.canImport);
    this.canReset = !!(window.MAP && window.MAP.canReset);
    // Whether this user holds `dcim.add_location`, so the floor bind panel may offer inline Location
    // creation (LOC-1). The install-wide on/off is the `location-create` capability (hasCapability);
    // this is the per-user half. Both are re-checked server-side — UX only, like canImport/canReset.
    this.canCreateLocation = !!(window.MAP && window.MAP.canCreateLocation);
    // The enabled optional capabilities (keys), from the server's capability registry (the add-on
    // framework). hasCapability(key) gates a capability's lazy-loaded tool on its presence — the
    // detect-and-enable model, the frontend mirror of window.MAP.drawingExts. Absent (non-plugin
    // page) → an empty list, so nothing optional is offered.
    this.capabilities = (window.MAP && window.MAP.capabilities) || [];
    // The install-wide floor-label field (which Location field seeds a floor's label at import).
    // Seeded from the server's effective value (blob → PLUGINS_CONFIG → 'name'); the in-app Settings
    // page's select reads and persists it (SettingsPage / api/settings/floor-label-field, SET-1), so
    // it's held live here to survive re-mounts within a session without a page reload.
    this.floorLabelField = (window.MAP && window.MAP.floorLabelField) || 'name';
    this._floorData = null;             // shared promise for the deferred floor-level load (ensureFloorData)
    this._pendingFocus = null;          // wayfinding-search target to frame+pulse on the next floor entry (focusRoom)
    // Active facility ('' = the default facility), threaded onto every per-facility API call via
    // Api.facility. A leading `#/y/<slug>` hash segment selects it; the picker switches it (MULTI-2).
    this.facility = '';
    // The operator-pinned default facility (SET-2): which facility a bare boot (no `#/y/<slug>` in
    // the hash) opens. '' = the default facility (no pin, today's behaviour). Seeded from the
    // server's already-validated value (facilities.default_facility degrades a stale pin to ''), so
    // it's always '' or a reachable, content-having slug. init() reads it once to resolve the boot
    // facility; the Settings select reads/persists it, held live so a re-mount preselects the choice.
    this.defaultFacility = (window.MAP && window.MAP.defaultFacility) || '';
    this.facilities = null;             // [{slug,name,has_content}] for the picker; loaded once in init()
    this.grouping = 'sitegroup';        // which dcim grouping identifies a facility (SiteGroup|Region)
  }

  /** Whether an optional capability (from the server's capability registry) is enabled on this
   *  install — the frontend gate for a capability's lazy-loaded tool (the add-on framework). Mirrors
   *  how `ImportUploader` reads `window.MAP.drawingExts`: the server injects the enabled keys and a
   *  tool only wires itself up when its key is present. */
  hasCapability(key) {
    return this.capabilities.includes(key);
  }

  async init() {
    // Resolve the boot facility BEFORE the first load so loadCore hydrates the right one
    // (Api.facility is what the manifest/blob GETs carry). An explicit `#/y/<slug>` in the hash
    // wins; a bare hash uses the operator-pinned default facility (SET-2), falling back to '' when
    // none is pinned. Only init consults the pin — router() never does, so in-app navigation to a
    // bare `#/` (e.g. Home within the default facility) never silently re-pins.
    const boot = this._parseHash();
    this.facility = boot.explicit ? boot.facility : (this.defaultFacility || '');
    Api.facility = this.facility;
    // When the pin resolved a non-default facility from a bare hash, rewrite the hash to name it so
    // the router — which re-reads the hash and treats a facility mismatch as a switch — stays in
    // lockstep and doesn't bounce back to ''. replaceState (not a hash assignment) avoids a spurious
    // history entry, so Back doesn't return to the bare pre-resolution hash; the hashchange listener
    // isn't bound yet, so this fires no extra router pass.
    if (this.facility && !boot.explicit) {
      history.replaceState(null, '', '#' + this._hash('/'));
    }
    try { await this.store.loadCore(); }
    catch (e) {
      document.body.innerHTML = '<div class="empty">Failed to load the facility map: '
        + e.message + '</div>';
      return;
    }
    // The facility list backs the picker; a failure is non-fatal (the picker just doesn't show).
    this.netbox.facilities()
      .then(f => { this.facilities = f.facilities; this.grouping = f.grouping; this._renderFacilityPicker(); })
      .catch(() => { this.facilities = []; });
    this._bindGlobal();
    this._navHash = location.hash;   // baseline for the unsaved-work navigation guard
    this.router();
  }

  // ---- routing ----
  /** Navigate to a facility-relative hash (`rest` is unprefixed, e.g. '/f/dir/fid' or '/'); the
   *  active facility is prefixed as `#/y/<slug>` so links stay in-facility (MULTI-2). */
  go(rest) { this._setHash(this._hash(rest)); }

  /** Prefix a facility-relative hash path with the active `#/y/<slug>` segment ('' = default,
   *  no prefix). `rest` may be '' or '/' (the siteplan) or a leading-slash path. */
  _hash(rest) {
    const prefix = this.facility ? '/y/' + encodeURIComponent(this.facility) : '';
    if (!rest || rest === '/') return prefix || '/';
    return prefix + (rest.startsWith('/') ? rest : '/' + rest);
  }

  /** Split the current hash into `{ facility, parts, explicit }`: a leading `y/<slug>` segment
   *  selects the facility and is stripped from the route parts the router dispatches on. `explicit`
   *  is whether that segment was present — a bare hash (`explicit:false`) lets `init` apply the
   *  pinned default facility (SET-2), while `router` ignores the flag and always takes `facility`. */
  _parseHash() {
    const raw = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (raw[0] === 'y') return { facility: decodeURIComponent(raw[1] || ''), parts: raw.slice(2), explicit: true };
    return { facility: '', parts: raw, explicit: false };
  }

  /** Assign a fully-resolved hash and, when it equals the current one (no `hashchange` fires),
   *  drive the navigation chokepoint directly so a same-page crumb/link still routes. */
  _setHash(hash) {
    const before = location.hash;
    location.hash = hash;
    if (location.hash === before) this._navigate();
  }

  /** Switch the active facility from the picker: route to that facility's siteplan (default = the
   *  bare siteplan). The router detects the change, reloads the facility's data, and lands there. */
  switchFacility(slug) {
    this._setHash(slug ? '/y/' + encodeURIComponent(slug) : '/');
  }

  /** Wayfinding-search entry point (SiteplanEditor finder): route to the floor that holds a
   *  room/rack and, once there, frame the viewport on it and pulse it. The target is stashed
   *  for `showFloor` to hand to the FloorEditor rather than encoded in the hash — a room is
   *  not individually hash-addressable, and this keeps the deep-link a plain `#/f/<dir>/<fid>`.
   *  `region` is the normalized rect [nx0,ny0,nx1,ny1] to fit; `roomId` is the room to pulse. */
  focusRoom(dir, fid, roomId, region) {
    this._pendingFocus = { dir, fid, roomId, region };
    this.go('/f/' + encodeURIComponent(dir) + '/' + encodeURIComponent(fid));
  }

  /** Load class files on demand, in order (cached per file; a failed file is retried on
   *  the next call). index.html ships only the classes the siteplan first paint needs —
   *  the floor editor and import wizard are fetched here on first navigation, keeping
   *  ~131 KB of JS off the boot path (and out of the embed entirely). */
  ensureScripts(files) {
    this._scripts = this._scripts || {};
    let chain = Promise.resolve();
    for (const f of files) {
      if (!this._scripts[f]) {
        this._scripts[f] = chain.then(() => new Promise((resolve, reject) => {
          const s = document.createElement('script');
          // Cache-bust the on-demand bundles per deploy (mirrors Store.mediaUrl's ?v=): the
          // eager scripts in index.html go through {% static %}, but these plain URLs would
          // otherwise be cached indefinitely, letting a browser run a stale editor bundle
          // against freshly-deployed core scripts (see ARCHITECTURE §10).
          let src = (window.MAP ? window.MAP.static : '/') + f;
          if (window.MAP && window.MAP.version) src += '?v=' + encodeURIComponent(window.MAP.version);
          s.src = src;
          s.onload = resolve;
          s.onerror = () => { delete this._scripts[f]; reject(new Error('failed to load ' + f)); };
          document.body.append(s);
        }));
      }
      chain = this._scripts[f];
    }
    return chain;
  }

  /** Trigger (and cache) the deferred floor-level load. Boot fetches only the siteplan's
   *  core documents; annotations/placements/layouts load here — warmed after the siteplan
   *  paints in standalone, awaited before the building/floor views that read them. Idempotent:
   *  all callers share one promise. A failed load resets the cache so a later navigation retries. */
  ensureFloorData() {
    if (!this._floorData) {
      this._floorData = this.store.loadFloorData().catch(e => {
        this._floorData = null;
        throw e;
      });
    }
    return this._floorData;
  }

  async router() {
    const { facility, parts } = this._parseHash();
    // A facility switch (via the picker or a cross-facility deep-link) reloads that facility's
    // documents before routing. The unsaved-work guard already ran upstream in `_navigate`, so any
    // pending edits to the previous facility were handled there.
    if (facility !== this.facility) {
      this.facility = facility;
      Api.facility = facility;
      this._renderFacilityPicker();
      this.store.reset();
      this._floorData = null;   // drop the deferred floor-load cache for the previous facility
      // An empty facility still yields the EMPTY_MANIFEST stub (a 200), so this only throws on a
      // genuine load failure — degrade like boot rather than routing on a null manifest.
      try { await this.store.loadCore(); }
      catch (e) {
        Dom.$('#stage').innerHTML = '<div class="empty">Could not load facility: '
          + e.message + '</div>';
        return;
      }
    }
    this.closePanel();
    // The persistent settings gear lives in #topbar, outside the per-view toolbar that
    // setToolbar() rebuilds — sync its active tint here so every route (incl. navigating
    // away via breadcrumbs/Back) reflects whether settings is open.
    Dom.$('#settings-gear').classList.toggle('active', parts[0] === 'settings');
    // A pending wayfinding focus only applies to the floor it names. If we're routing
    // anywhere but a floor (e.g. the unsaved-work guard reverted us to the siteplan),
    // drop it so it can't leak onto a later, unrelated floor entry.
    if (parts[0] !== 'f') this._pendingFocus = null;
    if (parts[0] === 'import') return this.showImport();
    if (parts[0] === 'settings') return this.showSettings();
    if (parts[0] === 'b') return this.renderBuilding(decodeURIComponent(parts[1]));
    if (parts[0] === 'f') return this.showFloor(decodeURIComponent(parts[1]), decodeURIComponent(parts[2]));
    // Room deep-link (#/r/<dir>/<fid>/<slug-or-id>): the same floor load/guard path as #/f/,
    // plus a room to frame + highlight (resolved against the loaded floor in showFloor).
    if (parts[0] === 'r') return this.showFloor(decodeURIComponent(parts[1]), decodeURIComponent(parts[2]),
      parts[3] === undefined ? null : decodeURIComponent(parts[3]));
    // A fresh install has no facility yet → land on the import wizard, not an empty siteplan.
    if (!this.store.hasContent()) return this.showImport();
    return this.showSiteplan();
  }

  /** The in-app PDF import flow (no editor active). The import bundle is lazy-loaded — it's the
   *  largest one and only needed here. Which flow drives is chosen by store.hasContent(): a built
   *  facility opens the non-linear EditImportFlow (edit hub); a fresh install the linear
   *  FreshImportFlow. Users without import permission (e.g. a rack-placer) are shown a read-only
   *  empty state instead of a flow that would 403 on every call — the server still enforces the
   *  gate; this is only the graceful frontend. */
  showImport() {
    this.current = null;
    if (!this.canImport) return this.showNoImport();
    this.ensureScripts(['import-preview.js', 'import-uploader.js', 'import-flow.js',
      'fresh-import-flow.js', 'edit-import-flow.js'])
      .then(() => {
        const Flow = this.store.hasContent() ? EditImportFlow : FreshImportFlow;
        new Flow(this).show();
      })
      .catch(e => Toast.show('Could not load the import wizard: ' + e.message, true));
  }

  /** Empty state for a signed-in user who lacks import permission and has landed where the
   *  wizard would be (a fresh install with no content, or #/import). Reuses the wizard's
   *  `.import-view`/`.hint` styling so it reads as the same surface, minus the controls. */
  showNoImport() {
    this.crumbs([{ label: 'Siteplan', hash: '/' }, { label: 'Import' }]);
    this.setToolbar([]);
    const stage = Dom.$('#stage'); stage.innerHTML = '';
    stage.append(Dom.el('div', { class: 'import-view' }, [
      Dom.el('h2', {}, 'No facility map yet'),
      Dom.el('p', { class: 'hint' },
        'No facility map has been imported yet. Ask an administrator with import '
        + 'permission to set one up.'),
    ]));
  }

  /** Settings view (no editor active) — delegated to the SettingsPage framework, which
   *  builds the page from a declarative descriptor registry (see settings-page.js). Rack
   *  inventory now syncs per room from the floor's Place-racks panel, so there is nothing
   *  rack-related to configure here. */
  showSettings() {
    this.current = null;
    this.crumbs([{ label: 'Siteplan', hash: '/' }, { label: 'Settings' }]);
    this.setToolbar([]);
    const stage = Dom.$('#stage'); stage.innerHTML = '';
    new SettingsPage(this).mount(stage);
  }

  showSiteplan() {
    this.current = new SiteplanEditor(this); this.current.show();
    // Warm the deferred floor data in the background so a drill-in is instant. Skipped in the
    // embed (which only ever shows the siteplan); errors are swallowed here and resurface on an
    // actual navigation, which awaits ensureFloorData and toasts.
    if (!this.embed) this.ensureFloorData().catch(() => {});
  }

  /** `focusSeg` (room deep-links only) is a room's Location slug or its uid; the resolved
   *  room is framed + highlighted on entry. An unknown/forbidden room degrades to the plain
   *  floor view (a toast, no error). Plain `#/f/` navigation passes no `focusSeg`. */
  async showFloor(dir, fid, focusSeg = null) {
    const b = this.store.building(dir);
    if (!b) return this.showSiteplan();
    const f = b.floors.find(x => x.id === fid);
    if (!f) return this.renderBuilding(dir);
    // FloorEditor.show reads floorLayout/floorData/placementData — ensure the deferred load
    // landed first (usually already warm). A data failure degrades (the accessors fall back
    // to empty/default) and toasts inline; a script failure is fatal for this view, so it
    // rejects the Promise.all and we stay put.
    try {
      await Promise.all([
        this.ensureScripts(['device-shapes.js', 'floor-export.js', 'floor-editor.js']),
        this.ensureFloorData().catch(e => Toast.show('Could not load floor data: ' + e.message, true)),
      ]);
    } catch (e) { Toast.show('Could not load the floor view: ' + e.message, true); return; }
    this.mode = 'view';   // every floor entry lands in view; reset so a prior floor's edit doesn't carry over
    this.current = new FloorEditor(this, b, f);
    // Frame + pulse a room on mount from either entry point (both feed the editor's setFocus
    // before show()): a `#/r/` room deep-link resolves the segment (Location slug, then uid
    // fallback) against this floor's rooms and derives the region from the room's polygon; a
    // wayfinding-search jump hands a precomputed region+room via `_pendingFocus`. The router
    // clears `_pendingFocus` on any non-`f` route, so the two never both apply; consume it
    // either way so it never leaks onto a later navigation.
    const focus = this._pendingFocus; this._pendingFocus = null;
    if (focusSeg) {
      const room = this.current.data().rooms.find(
        r => (r.location && r.location.slug === focusSeg) || r.id === focusSeg);
      const region = room && this.current._roomFocusRegion(room.id);
      if (region) this.current.setFocus({ dir, fid, roomId: room.id, region });
      else Toast.show('That room link no longer resolves; showing the floor.', true);
    } else if (focus && focus.dir === dir && focus.fid === fid) {
      this.current.setFocus(focus);
    }
    this.current.show();
  }

  /** Building view: a grid of floor cards (no editor active). */
  async renderBuilding(dir) {
    this.current = null;
    const b = this.store.building(dir);
    if (!b) return this.showSiteplan();
    // The per-floor room counts below read store.annotations, part of the deferred load; await
    // it up front so the whole view renders in one burst (a failed load leaves floors "unmapped").
    try { await this.ensureFloorData(); }
    catch (e) { Toast.show('Could not load room data: ' + e.message, true); }
    this.crumbs([{ label: 'Siteplan', hash: '/' }, { label: b.name }]);
    this.setToolbar([Dom.el('span', { class: 'hint' }, b.siteSlug)]);
    const stage = Dom.$('#stage'); stage.innerHTML = '';
    if (!b.floors.length) { stage.append(Dom.el('div', { class: 'empty' }, 'No floor maps for ' + b.name)); return; }

    const grid = Dom.el('div', { class: 'floor-grid' });
    for (const f of b.floors) {
      const key = Util.floorKey(dir, f.id);
      const rec = this.store.annotations[key];
      const n = (rec && rec.rooms.length) || 0;
      grid.append(Dom.el('div', {
        class: 'floor-card',
        onclick: () => this.go('/f/' + encodeURIComponent(dir) + '/' + encodeURIComponent(f.id)),
      }, [
        // Card-sized `thumb` when the manifest has one (builds since 1.44.0); full-res
        // plan as the fallback for older manifests.
        Dom.el('img', { src: this.store.mediaUrl(f.thumb || f.image), loading: 'lazy' }),
        Dom.el('div', { class: 'cap' }, [
          Dom.el('b', {}, f.label),
          Dom.el('span', { class: 'cnt ' + (n ? 'mapped' : 'unmapped') }, n ? n + ' rooms' : 'unmapped'),
          ...(f.pages && f.pages.length > 1 ? [Dom.el('span', { class: 'cnt sheets' }, f.pages.length + ' sheets')] : []),
        ]),
      ]));
    }
    stage.append(grid);
  }

  /** (Re)draw the facility picker in the topbar from `this.facilities` (loaded once in init).
   *  Shown only when there's a real choice (≥2 facilities) and not in the chrome-free embed. The
   *  active facility is selected; empty facilities (no imported map) are flagged so picking one
   *  drops into the import wizard for it. Called on boot and on every facility switch. */
  _renderFacilityPicker() {
    const host = Dom.$('#facility-picker');
    if (!host) return;
    host.innerHTML = '';
    if (this.embed || !this.facilities || this.facilities.length < 2) return;
    // If the active facility isn't in the list (e.g. a still-empty facility mid-import), prepend it
    // so the control reflects where the user actually is.
    const known = this.facilities.some(f => f.slug === this.facility);
    const opts = known ? this.facilities
      : [{ slug: this.facility, name: this.facility || 'Default facility', has_content: false },
         ...this.facilities];
    const sel = Dom.el('select', { class: 'facility-select', title: 'Facility' });
    for (const f of opts) {
      sel.append(Dom.el('option', { value: f.slug },
        f.name + (f.has_content ? '' : ' (empty, import…)')));
    }
    sel.value = this.facility;
    sel.addEventListener('change', () => this.switchFacility(sel.value));
    host.append(sel);
  }

  // ---- shared chrome ----
  crumbs(items) {
    const nav = Dom.$('#crumbs'); nav.innerHTML = '';
    items.forEach((it, i) => {
      if (i) nav.append(Dom.el('span', { class: 'sep' }, '›'));
      nav.append(it.hash ? Dom.el('a', { onclick: () => this.go(it.hash) }, it.label)
        : Dom.el('span', {}, it.label));
    });
  }
  setToolbar(nodes) {
    const tb = Dom.$('#toolbar'); tb.innerHTML = '';
    [].concat(nodes).forEach(n => n && tb.append(n));
    this._fitToolbar();
  }
  /** Reveal the toolbar's tool labels only when the fully-labeled bar actually fits; otherwise
   *  collapse the `tb-labeled` buttons to icon+tooltip. Measures the expanded width against the
   *  room in the bar, so it's correct for any editor/mode's button count — not a fixed breakpoint
   *  (ARCHITECTURE §10 Responsive tool labels). Expand→measure→set runs synchronously (no paint
   *  between), so there is no label flash. Re-run on every setToolbar and on region resize. */
  _fitToolbar() {
    const region = Dom.$('#toolbar-region'), tb = Dom.$('#toolbar');
    if (!region || !tb) return;
    region.classList.remove('compact');                       // measure fully expanded
    if (tb.scrollWidth > tb.clientWidth + 1) region.classList.add('compact');
  }
  closePanel() {
    Dom.$('#panel').classList.add('hidden');
    if (this.current && this.current.onPanelClosed) this.current.onPanelClosed();
  }

  _bindGlobal() {
    const gear = Dom.$('#settings-gear');
    gear.innerHTML = Icons.settings;
    // Toggle: on the settings route the gear returns to the siteplan; elsewhere it opens
    // settings. Mirrors the floor editor's "inspect state, go to the opposite" mode buttons.
    // The .active tint is kept in sync per-route by router(), not here.
    gear.addEventListener('click', () => {
      const onSettings = this._parseHash().parts[0] === 'settings';
      this.go(onSettings ? '/' : '/settings');
    });
    Dom.$('#panel-close').addEventListener('click', () => this.closePanel());
    window.addEventListener('beforeunload', (e) => {
      if (this.store.hasUnsaved()) { e.preventDefault(); e.returnValue = ''; }
    });
    // Every page change — crumbs, hotspots, floor cards, gear, go(), Back/Forward — flows
    // through the one navigation chokepoint (see _navigate for the unsaved-work guard).
    window.addEventListener('hashchange', () => this._navigate());
    document.addEventListener('keydown', (e) => {
      if (!this.interactive) return;   // non-interactive embed: no keyboard zoom/shortcuts
      if (e.target.matches('input, textarea, select')) return;
      if (this.current instanceof Editor) this.current.handleKey(e);
    });
    // Re-fit the toolbar labels whenever the room in the bar changes. The region is flex:1, so
    // this catches both window resizes and breadcrumb-width changes; _fitToolbar toggling
    // `.compact` doesn't resize the region, so the observer can't loop.
    const region = Dom.$('#toolbar-region');
    if (region && window.ResizeObserver) new ResizeObserver(() => this._fitToolbar()).observe(region);
  }

  /** The single in-app navigation chokepoint, run on every `hashchange` (and by `go()` when
   *  the target equals the current hash, which fires no event). Guards unsaved work: on a
   *  real change it shows a native confirm before routing; Cancel reverts `location.hash` to
   *  the last-committed value (`_navHash`), OK discards the pending edits first so the dirty
   *  flags don't re-arm the guard on a later, unrelated navigation. `_revertingHash` swallows
   *  the synthetic `hashchange` the revert itself fires. */
  _navigate() {
    if (this._revertingHash) { this._revertingHash = false; this._navHash = location.hash; return; }
    if (this.store.hasUnsaved() &&
        !confirm('You have unsaved changes that will be lost. Leave this page?')) {
      // The revert re-fires hashchange (swallowed via _revertingHash). Skip it when the hash
      // never actually moved (same-hash go), which would otherwise leave the flag stuck true.
      if (location.hash !== this._navHash) { this._revertingHash = true; location.hash = this._navHash; }
      return;
    }
    this._navHash = location.hash;
    if (this.store.hasUnsaved()) {
      // Leaving with edits still pending: drop them (re-fetch from the server) before
      // routing, so the flags don't stay dirty and re-arm the guard on some later,
      // unrelated navigation.
      this.store.discard()
        .catch(e => Toast.show('Could not discard unsaved changes: ' + e.message, true))
        .finally(() => this.router());
      return;
    }
    this.router();
  }
}

window.addEventListener('DOMContentLoaded', () => new App().init());
