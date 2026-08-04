'use strict';
/* app.js — App: top-level orchestrator and entry point. Owns the singletons
   (Store, NetBoxClient, GridController), cross-view UI state (edit/view mode,
   siteplan-edit flag, siteplan-label visibility, view-mode highlight mode
   (all rooms / rooms-with-devices / none, default all), the hash
   router, and global chrome
   (breadcrumbs, toolbar, side panel, keyboard). Loaded LAST. */

class App {
  // One representative global per eager <script> in index.html's dependency-order block
  // (INSTALL-1) — a stale collectstatic/CDN copy of any of these throws a bare ReferenceError
  // somewhere downstream instead of failing legibly at boot. Not every class each file defines
  // (lib.js alone has 8) — just enough to catch a whole file failing to update.
  //
  // Each entry is [name, presence check] rather than a bare name: these classes are top-level
  // `class` declarations in classic (non-module) scripts, which bind in the global *lexical*
  // environment, not as properties of `window`/`globalThis` (unlike `var`/`function`) — so a
  // `window[name]` lookup always reads as missing regardless of whether the script actually
  // loaded. `typeof <Identifier>` is the correct (and eval-free, CSP-safe) way to test a lexical
  // binding without throwing on an absent one. Kept as one array so a new required global is a
  // single-line addition here, nothing to keep in sync elsewhere.
  static REQUIRED_GLOBALS = [
    ['Dom', () => typeof Dom !== 'undefined'],
    ['TodoModel', () => typeof TodoModel !== 'undefined'],
    ['TodoChips', () => typeof TodoChips !== 'undefined'],
    ['TodoComposer', () => typeof TodoComposer !== 'undefined'],
    ['TodoPage', () => typeof TodoPage !== 'undefined'],
    ['MobileTodoPage', () => typeof MobileTodoPage !== 'undefined'],
    ['NetBoxClient', () => typeof NetBoxClient !== 'undefined'],
    ['Store', () => typeof Store !== 'undefined'],
    ['GridController', () => typeof GridController !== 'undefined'],
    ['PanZoom', () => typeof PanZoom !== 'undefined'],
    ['UndoStack', () => typeof UndoStack !== 'undefined'],
    ['Editor', () => typeof Editor !== 'undefined'],
    ['SiteplanEditor', () => typeof SiteplanEditor !== 'undefined'],
    ['SettingsPage', () => typeof SettingsPage !== 'undefined'],
    ['ApSettingsPage', () => typeof ApSettingsPage !== 'undefined'],
    ['FloorViewMenu', () => typeof FloorViewMenu !== 'undefined'],
  ];

  constructor() {
    this.store = new Store();
    this.netbox = new NetBoxClient();
    this.grid = new GridController();   // shared by both editors
    this.mode = 'view';                 // floor editor: 'edit' | 'view' (showFloor resets to view per entry); rack placement is FloorEditor.placingRacks, a sub-mode of edit
    this.siteEdit = false;              // siteplan: editing building areas
    this.siteLabels = false;            // siteplan: show building name labels (hidden by default)
    this.highlight = 'all';             // floor view-mode highlight: 'all' rooms (default) | 'placements' (rooms with devices) | 'none'
    this.current = null;                // active Editor (or null on building view)
    this._stagePage = null;             // active non-Editor page mounted into #stage (SettingsPage/
                                         // ApSettingsPage/TodoPage/MobileTodoPage/ImportFlow) —
                                         // cleared, and given its optional detach(), by
                                         // `_detachCurrent`; also where `_navRefusal` asks whether
                                         // the page refuses to be navigated away from right now
    // The app's single phone breakpoint (Util.phoneMq, lib.js). Created here, not in _bindGlobal,
    // so _fitToolbar can read it unguarded no matter which of them runs first; _bindGlobal
    // attaches its change listener.
    this._phoneMq = Util.phoneMq();
    // Embedded in a dashboard-widget iframe (?embed=1): chrome hidden + no in-card navigation.
    // A building click opens the full map in the top window instead (SiteplanEditor.openBuilding),
    // since the chrome-free card has no breadcrumbs to return through. Interactivity (pan/zoom +
    // zoom controls + keyboard) is opt-in there and always on in the standalone app; the editors
    // and the keyboard handler consult `interactive`.
    this.embed = !!(window.MAP && window.MAP.embed);
    this.interactive = !this.embed || !!(window.MAP && window.MAP.interactive);
    // Search-only embed (?finder=1, FacilitySearchWidget): the siteplan renders just the wayfinding
    // finder — no map, no legend (SiteplanEditor.show). Always paired with embed, so a result click
    // still escapes to the top window (openBuilding / _gotoTarget).
    this.finder = !!(window.MAP && window.MAP.finder);
    // Search-widget result-target (NAV-16, FacilitySearchWidget): 'netbox' makes a finder hit open
    // the object's NetBox detail page; anything else keeps the default map deep-link. Only consulted
    // in the embed, and only the search widget ever sets it, so the map widget is unaffected.
    this.resultTarget = (window.MAP && window.MAP.resultTarget) || 'map';
    // Import/reset are gated server-side; these mirror the gate so we don't offer a wizard whose
    // every call would 403 (canImport = import_facilitymapblob) or a reset the user can't run
    // (canReset = superuser). The server is the security boundary — these are UX only.
    this.canImport = !!(window.MAP && window.MAP.canImport);
    this.canReset = !!(window.MAP && window.MAP.canReset);
    // Whether this user holds `dcim.add_location`, so the floor bind panel may offer inline Location
    // creation (LOC-1). The install-wide on/off is `writeMode` (below); this is the per-user half.
    // Both are re-checked server-side — UX only, like canImport/canReset.
    this.canCreateLocation = !!(window.MAP && window.MAP.canCreateLocation);
    // Install-wide "write mode" (LOC-2): the runtime, admin-controlled MASTER GATE on everything the
    // plugin writes into NetBox core, replacing the old redeploy-time `location-create` capability.
    // Since SET-5 it gates and nothing more — each write add-on carries its own switch on top
    // (inlineRoomCreation below, apTool further down). Seeded from the server's settings blob
    // (previews.write_mode_enabled → window.MAP.writeMode) and held live here so the Settings toggle
    // flips it without a reload. UX only — every write endpoint re-checks it server-side.
    this.writeMode = !!(window.MAP && window.MAP.writeMode);
    // The inline-room-creation add-on's own install-wide switch (SET-5): whether the floor bind panel
    // may offer the create tile at all. Needs writeMode AND canCreateLocation too — all three are
    // re-checked server-side in NbLocationCreateView. Note it is seeded from a server reader that
    // DEFAULTS ON for a blob predating SET-5, so an upgrader keeps the tile write mode used to imply.
    this.inlineRoomCreation = !!(window.MAP && window.MAP.inlineRoomCreation);
    // Whether this user holds `dcim.add_device`, the per-user half of the access-point tool's gate
    // (DEV-3) — the exact analogue of canCreateLocation. UX only; re-checked server-side.
    this.canCreateDevice = !!(window.MAP && window.MAP.canCreateDevice);
    // The access-point tool's install-wide configuration (DEV-3), seeded from the settings blob
    // (previews.ap_settings → window.MAP) and held live so the Settings page's saves apply without a
    // reload, like writeMode/floorLabelField. `apTool` is the feature's own switch, stored SEPARATELY
    // from writeMode (the master gate) exactly as inlineRoomCreation is — placing an AP needs apTool
    // AND writeMode AND canCreateDevice AND a configured apDeviceRole ({id,name}, or null when
    // unset/deleted/hidden). All re-enforced server-side; these are the UX mirror.
    this.apTool = !!(window.MAP && window.MAP.apTool);
    // High-quality floor-plan rendering (READ-1). Held live for the same reason as the switches
    // above — so the Settings page's save is reflected without a reload — but nothing in the
    // browser reads it otherwise: the render it controls runs in the import subprocess, and it
    // only bites on the next import/rebuild.
    this.renderHq = !!(window.MAP && window.MAP.renderHq);
    // The to-do feature's install-wide switch (ADDON-4), a general (non-write) add-on seeded from the
    // settings blob (previews.todos_enabled → window.MAP.todos) and held live so the Settings toggle
    // flips it without a reload, like writeMode/apTool. Read by showTodo (the #/todo page) and
    // FloorEditor (the per-floor panel + compose "+"). UX only — every to-do endpoint re-checks it
    // server-side (frontend_api.TodoFeatureGateMixin).
    this.todos = !!(window.MAP && window.MAP.todos);
    this.apDeviceRole = (window.MAP && window.MAP.apDeviceRole) || null;
    this.apNameTemplate = (window.MAP && window.MAP.apNameTemplate) || '{room}-{role_short}';
    this.apCountScope = (window.MAP && window.MAP.apCountScope) || 'none';
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
    // The last floor opened this session ({dir,fid}), recorded by showFloor. Read only by the
    // facility-wide to-do page, to badge that floor's group "Current" (TASK-5) — a "you were just
    // here" anchor in a list that spans every building. Null until a floor is entered, which is the
    // honest answer on a cold deep-link straight to #/todo: nothing is current yet.
    this.lastFloor = null;
    // Where the current view was navigated *from*, when that origin should show in the breadcrumb:
    // 'todo' (the facility-wide to-do page) or null (any other route — today's plain trail). Set by
    // TodoPage as it navigates out, consumed by rootCrumbs(), cleared by the router on any route the
    // to-do page can't reach. Distinct from `lastFloor`, which is "which floor was last opened", not
    // a referrer. UI-only, exactly like lastFloor: it decorates a crumb trail and nothing else —
    // never persisted, never in the hash, never load-bearing for routing.
    this.navOrigin = null;
    // The facility-relative route the settings gear was opened FROM, so closing settings returns
    // there instead of always dumping you on the siteplan (MOBILE-3). Recorded at open time (so it
    // can never go stale) and cleared on close; null means "nothing remembered", which falls back
    // to the siteplan — the old unconditional behaviour. UI-only, like navOrigin: never persisted,
    // never in the hash, never load-bearing for routing.
    this._settingsReturn = null;
    // Active facility ('' = the default facility), threaded onto every per-facility API call via
    // Api.facility. A leading `#/y/<slug>` hash segment selects it; the picker switches it (MULTI-2).
    this.facility = '';
    // The operator-pinned default facility (SET-2): which facility a bare boot (no `#/y/<slug>` in
    // the hash) opens. '' = the default facility (no pin, today's behaviour). Seeded from the
    // server's already-validated value (facilities.default_facility degrades a stale pin to ''), so
    // it's always '' or a reachable, content-having slug. init() reads it once to resolve the boot
    // facility; the Settings select reads/persists it, held live so a re-mount preselects the choice.
    this.defaultFacility = (window.MAP && window.MAP.defaultFacility) || '';
    this.facilities = null;             // [{slug,name,has_content,org_mode}] for the picker; loaded once in init()
    this._facilitiesLoad = null;        // the in-flight init() fetch, awaited by ensureFacilities()
    this.grouping = 'sitegroup';        // which dcim grouping identifies a facility (SiteGroup|Region|top-level Location)
    // facility slug -> the organization mode THIS SESSION wrote for it (MODEL-6). `setOrgMode`
    // fills it; `orgMode()` prefers it over `facilities`, which is a boot-time snapshot that omits
    // an empty facility entirely — so without this a mode written mid-first-import would read back
    // as the default (TOPO-3).
    this._orgModes = new Map();
    // The signed-in viewer, {id,username,display,initials} — the shape a to-do's assignees arrive in
    // (TASK-3), so `TodoModel.assignedTo` compares ids straight across. Null only when window.MAP is
    // absent (standalone), which every reader must tolerate: an unknown viewer just means "no to-do
    // of mine to float to the top", never a broken list.
    this.user = (window.MAP && window.MAP.user) || null;
  }

  /** Whether an optional capability (from the server's capability registry) is enabled on this
   *  install — the frontend gate for a capability's lazy-loaded tool (the add-on framework). Mirrors
   *  how `ImportUploader` reads `window.MAP.drawingExts`: the server injects the enabled keys and a
   *  tool only wires itself up when its key is present. */
  hasCapability(key) {
    return this.capabilities.includes(key);
  }

  /** Await the facility list, fetching it if `init()`'s boot load never ran or failed. `init()`
   *  fires that load fire-and-forget (the picker degrades to hidden), which is fine for a
   *  decoration — but a reader that *steers behaviour* off a per-facility fact (`orgMode()`) must
   *  not silently read the default just because the list hadn't landed yet. Resolves to
   *  `this.facilities` (`[]` when unreadable, matching the boot fallback). */
  async ensureFacilities() {
    if (!this._facilitiesLoad)
      this._facilitiesLoad = this.netbox.facilities()
        .then(f => { this.facilities = f.facilities; this.grouping = f.grouping; })
        .catch(() => { this.facilities = []; });
    await this._facilitiesLoad;
    return this.facilities;
  }

  /** The active facility's declared **NetBox organization mode** (MODEL-6):
   *  `'site-as-building'` (a Site *is* a building — the default) or `'site-as-campus'` (a Site is a
   *  campus whose buildings are Locations). Under the `location` grouping (MODEL-8) the server
   *  forces every facility to `'site-as-campus'` (a Location-subtree facility is campus-shaped by
   *  construction) — mirrored here **before** the facility-list lookup, since a brand-new facility
   *  being imported for the first time (no content yet) can be absent from that list, and reading
   *  only the list would silently fall back to the wrong default (IMPORT-15). Then a mode **this
   *  session wrote** (`_orgModes`, below) wins over the list, which was fetched at boot and may not
   *  enumerate this facility at all. Otherwise read from that list, the one place the SPA learns
   *  per-facility facts; a facility absent from it reports the default, matching what the server
   *  reports for an unset facility.
   *  Callers that must not read a premature default should `await ensureFacilities()` first. */
  orgMode() {
    if (this.grouping === 'location') return 'site-as-campus';
    if (this._orgModes.has(this.facility)) return this._orgModes.get(this.facility);
    const rec = (this.facilities || []).find(f => f.slug === this.facility);
    return (rec && rec.org_mode) || 'site-as-building';
  }

  /** Persist the active facility's organization mode (MODEL-6) — the client's one write path,
   *  mirroring the server's single writer (`facilities.set_org_mode`). Records the new value so the
   *  next `orgMode()` read (and anything driven by it — the Settings row, the import wizard's bind
   *  step) reflects the change without a reload. Shared by `SettingsPage._saveOrgMode` and the
   *  import wizard's topology step / inline "Switch to…" control so none of them duplicates the
   *  POST/cache-update; each caller owns its own toast/error handling.
   *
   *  It records into **both** the cached facility record and `_orgModes`, because the record may not
   *  exist: `list_facilities` omits an empty facility, which is exactly the state a brand-new
   *  facility is in while the wizard is configuring it (TOPO-3 — the topology step writes this mode
   *  *before* the first import, so a write with nowhere to land would read straight back as the
   *  default and send the bind step hunting for the wrong object type). */
  async setOrgMode(mode) {
    await Api.post('/api/settings/org-mode', { facility: this.facility, org_mode: mode });
    const rec = (this.facilities || []).find(f => f.slug === this.facility);
    if (rec) rec.org_mode = mode;
    this._orgModes.set(this.facility, mode);
  }

  async init() {
    // Boot-time asset sanity check (INSTALL-1): a stale collectstatic/CDN copy of an eager
    // script served alongside a fresh index.html fails here with an actionable message instead
    // of an unhandled ReferenceError deep in some later call.
    const missing = App.REQUIRED_GLOBALS.filter(([, present]) => !present()).map(([name]) => name);
    if (missing.length) {
      document.body.innerHTML = '<div class="empty">Plugin assets are out of date (missing: '
        + missing.join(', ') + '). Re-run collectstatic and hard-refresh.</div>';
      return;
    }
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
    // isn't bound yet, so this fires no extra router pass. Preserve any incoming route (e.g. a shared
    // `#/r/<dir>/<fid>/<seg>` deep-link) rather than collapsing to the bare siteplan — `boot.parts`
    // are the raw, still-encoded segments with the `y/<slug>` prefix already stripped, so rejoining
    // them reconstructs the path for `_hash` to re-prefix (NAV-10).
    if (this.facility && !boot.explicit) {
      const rest = boot.parts.length ? '/' + boot.parts.join('/') : '/';
      history.replaceState(null, '', '#' + this._hash(rest));
    }
    try { await this.store.loadCore(); }
    catch (e) {
      document.body.innerHTML = '<div class="empty">Failed to load the facility map: '
        + e.message + '</div>';
      return;
    }
    // The facility list backs the picker; a failure is non-fatal (the picker just doesn't show).
    // The promise is kept so a later reader that genuinely *needs* the list (`ensureFacilities`)
    // can await this same in-flight fetch instead of racing it or issuing a second one.
    this._facilitiesLoad = this.netbox.facilities()
      .then(f => { this.facilities = f.facilities; this.grouping = f.grouping; this._renderFacilityPicker(); })
      .catch(() => { this.facilities = []; });
    this._bindGlobal();
    this._navHash = location.hash;   // baseline for the unsaved-work navigation guard
    await this._maybeRestoreDraft();
    this.router();
  }

  /** Offer to restore a persisted draft of unsaved edits from a previous session — a crash, a
   *  killed tab, or a save that failed on a session/CSRF expiry (SAVE-5). Called on boot and after
   *  a facility switch (each facility has its own draft). Prompting rather than auto-restoring lets
   *  a stale draft be declined and avoids a surprise dirty badge. Restore loads fresh floor data
   *  first so the CONC-1 tokens + `_base` baseline are current, THEN overlays the draft's content —
   *  a stale draft still 409s on save, never a silent clobber. Skipped in the non-interactive/embed
   *  views, which never edit. */
  async _maybeRestoreDraft() {
    if (!this.interactive || this.embed) return;
    const draft = this.store.peekDraft();
    if (!draft) return;
    if (!await this._confirmRestore()) { this.store.clearDraft(); return; }
    try { await this.ensureFloorData(); }
    catch (e) { Toast.show('Could not load data to restore your draft: ' + e.message, true); return; }
    this.store.applyDraft(draft);
  }

  /** Restore-draft prompt: resolves `true` to restore, `false` to discard. Not `danger` — the
   *  affirmative here *recovers* work rather than destroying it, so Restore takes the emphasis
   *  (`Modal`, §11). Backdrop, Escape, or Discard dismisses as discard. */
  _confirmRestore() {
    return Modal.confirm({
      title: 'Restore unsaved changes?',
      body: 'This browser has map edits from a previous session that were never saved. '
        + 'Restore them, or discard and start from the last saved version.',
      cancelLabel: 'Discard',
      confirmLabel: 'Restore',
    });
  }

  /** Unsaved-work navigation-away prompt, shown by `_navigate` in place of a blocking native
   *  `confirm()` (UX-15). Resolves `true` to leave (the pending edits are then discarded by the
   *  caller), `false` to stay; backdrop and Escape stay. `danger` because leaving discards work
   *  that cannot be recovered — the same reading `Editor._confirmLeaveEdit` gives its own
   *  leave-without-saving choice. */
  _confirmLeavePage() {
    return Modal.confirm({
      title: 'Unsaved changes',
      body: 'You have unsaved changes that will be lost. Leave this page?',
      confirmLabel: 'Leave without saving',
      danger: true,
    });
  }

  /** Disconnect the outgoing editor's container `ResizeObserver` before `this.current` is
   *  replaced or cleared, so navigating away can't leave it observing a detached container and
   *  keeping the torn-down editor reachable (BUG-2).
   *
   *  `Popover.closeAll()` is the same discipline for every trigger-anchored menu, and the reason
   *  no view has to remember it (QUAL-9). A popover's `document` listeners must stay bound for as
   *  long as it is open, so browser Back — which clears the stage without the outside-click that
   *  would otherwise dismiss it — used to strand them; that leak was found in `TodoPage` (QUAL-8)
   *  and again in `FloorViewMenu`, which had no teardown hook of any kind. Closing centrally here
   *  covers both, and every popover added later, whether or not its owner is a stage page.
   *
   *  The outgoing non-`Editor` stage page (`SettingsPage`/`ApSettingsPage`/`TodoPage`/
   *  `MobileTodoPage`) is also given a `detach()` if it defines one — a general hook rather than an
   *  `instanceof` special case, for page-level teardown that isn't a popover. No page needs it
   *  today; it stays as the seam for one that does. */
  _detachCurrent() {
    if (this.current instanceof Editor) this.current.detach();
    Popover.closeAll();
    if (this._stagePage && typeof this._stagePage.detach === 'function') this._stagePage.detach();
    this._stagePage = null;
  }

  /** The active stage page's refusal to be navigated away from *right now*, as the message to show,
   *  or null when it doesn't refuse (or has no say). The first of the two guards `_navigate`
   *  consults, ahead of the unsaved-work prompt — and, like `detach()` above, a general hook rather
   *  than a page-type special case, so no view's state leaks into `App`.
   *
   *  It exists for the import wizard (IMPORT-61): a nav-away taken while an upload run or a scan is
   *  in flight strands the runner narrating into a `#stage` this would wipe, and the scan then
   *  navigates the operator forward out of wherever they went. `ImportFlow` had gated the ways off a
   *  *step* (`_goToStep`), but the crumb trail, browser Back, the settings gear and the facility
   *  picker leave the wizard entirely — and every one of those routes through `_navigate`, so this
   *  is the one place that covers them all, including whatever nav-away is added next.
   *
   *  A refusal must be bounded, or it is a trap: the page owns that (the wizard's phases always
   *  return to idle, and its scan is time-budgeted), which is the other reason the decision stays
   *  with the page rather than being reimplemented here. */
  _navRefusal() {
    const page = this._stagePage;
    return (page && typeof page.navRefusal === 'function' && page.navRefusal()) || null;
  }

  /** Toggle the corner loading indicator (`#nav-loading`) shown while `showFloor`/`renderBuilding`
   *  await their data (UX-15) — the previous view stays on screen underneath, so without this a
   *  slow load reads as a dead click. Mirrors `FloorEditor.openRackPanel`'s inline "Loading…"
   *  placeholder for the same shape of wait. */
  _setBusy(on) {
    const el = Dom.$('#nav-loading');
    if (el) el.hidden = !on;
  }

  // ---- routing ----
  /** Navigate to a facility-relative hash (`rest` is unprefixed, e.g. '/f/dir/fid' or '/'); the
   *  active facility is prefixed as `#/y/<slug>` so links stay in-facility (MULTI-2). */
  go(rest) { this._setHash(this._hash(rest)); }

  /** Navigate to a facility-relative hash, but in the dashboard-widget embed **escape to the top
   *  window** instead of drilling in-card. The chrome-free embed has no breadcrumbs to return
   *  through, so an in-iframe drill-in would strand the user (§10); the full map opens deep-linked at
   *  `rest` in the top window (same-origin iframe, `location.pathname` is the `MapView` URL minus the
   *  `?embed=1` query). Standalone (`!embed`) it's a plain `go`. This is the canonical form of the
   *  escape idiom `SiteplanEditor.openBuilding`/`_gotoTarget` also apply. */
  navigateOut(rest) {
    if (this.embed) { window.top.location.href = location.pathname + '#' + this._hash(rest); return; }
    this.go(rest);
  }

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

  /** Make `slug` the active facility **in place**, reloading its documents — the switch itself,
   *  with no routing of its own. Resolves `true` once that facility's core documents are loaded,
   *  `false` when the load failed (the stage already carries the message, so the caller just stops).
   *
   *  Two callers, one implementation: `router()` applies a switch the hash already declares (the
   *  picker's `switchFacility`, a cross-facility deep-link), and the import wizard's layout step
   *  commits to the facility its accepted topology implies (IMPORT-17) — a *programmatic* switch,
   *  whose hash still says the old facility. So the hash is rebuilt from the current route here:
   *  `router` re-reads it and treats a mismatch as a switch, and would otherwise bounce straight
   *  back. `replaceState` (the `init()` idiom) fires no `hashchange`, so this never triggers a
   *  second routing pass, and for `router`'s own call it rebuilds the identical string — a no-op.
   *  The unsaved-work guard is **not** run here; it belongs to the navigation chokepoint upstream
   *  (`_navigate`), and the wizard's own caller is pre-upload by construction. */
  async setFacility(slug) {
    this.facility = slug;
    Api.facility = slug;
    this._renderFacilityPicker();
    this.store.reset();
    this._floorData = null;   // drop the deferred floor-load cache for the previous facility
    const { parts } = this._parseHash();
    history.replaceState(null, '', '#' + this._hash(parts.length ? '/' + parts.join('/') : '/'));
    this._navHash = location.hash;   // keep the guard's baseline on the hash we just wrote
    // An empty facility still yields the EMPTY_MANIFEST stub (a 200), so this only throws on a
    // genuine load failure — degrade like boot rather than routing on a null manifest.
    try { await this.store.loadCore(); }
    catch (e) {
      Dom.$('#stage').innerHTML = '<div class="empty">Could not load facility: '
        + e.message + '</div>';
      return false;
    }
    await this._maybeRestoreDraft();   // this facility may carry a draft from a prior session (SAVE-5)
    return true;
  }

  /** The display label for a facility slug — its name from the boot-loaded list, falling back to
   *  'Default facility' for `''` and to the slug itself for a facility the list doesn't enumerate
   *  (an empty one mid-import). The picker renders from this, and so does any copy that has to name
   *  a facility to the operator (the import wizard's facility-scope diagnostics). */
  facilityName(slug = this.facility) {
    const rec = (this.facilities || []).find(f => f.slug === slug);
    return (rec && rec.name) || slug || 'Default facility';
  }

  async router() {
    const { facility, parts } = this._parseHash();
    // A facility switch (via the picker or a cross-facility deep-link) reloads that facility's
    // documents before routing. The unsaved-work guard already ran upstream in `_navigate`, so any
    // pending edits to the previous facility were handled there.
    if (facility !== this.facility && !await this.setFacility(facility)) return;
    this.closePanel();
    // The persistent settings gear lives in #topbar, outside the per-view toolbar that
    // setToolbar() rebuilds — sync its active tint here so every route (incl. navigating
    // away via breadcrumbs/Back) reflects whether settings is open.
    Dom.$('#settings-gear').classList.toggle('active', parts[0] === 'settings');
    // The buildings-panel toggle (NAV-8) is siteplan-only chrome. Default it hidden on every
    // route; SiteplanEditor.show re-reveals it, so it never leaks onto a floor/settings/import view.
    Dom.$('#panel-toggle').hidden = true;
    // The facility picker is siteplan chrome too — on a PHONE (MOBILE-4). Switching facility is a
    // "where am I working" decision that belongs on the app's home screen; carried onto a floor or
    // the floor-select page it is one more fixed-width control competing for a bar that has none to
    // spare, which is what put the toolbar into a sideways scroll. The route knowledge lives here
    // (the same shape as the gear tint and panel toggle above); the *width* gate is the one CSS
    // breakpoint, so no JS reads a media query for it. A bare hash (no parts) is the siteplan.
    Dom.$('#facility-picker').classList.toggle('non-siteplan', parts.length > 0);
    // A route change must never leave the picker's body-mounted popover open — least of all above a
    // trigger the rule above just hid (BUG-2 discipline). Close only: unlike a re-render, hiding
    // keeps the trigger and its menu paired, so `_teardownFacilityMenu` would be too much.
    this._closeFacilityMenu();
    // A pending wayfinding focus only applies to the floor it names. If we're routing
    // anywhere but a floor (e.g. the unsaved-work guard reverted us to the siteplan),
    // drop it so it can't leak onto a later, unrelated floor entry.
    if (parts[0] !== 'f') this._pendingFocus = null;
    // The `To-do` origin crumb belongs only to the views the to-do page can navigate *to* (a floor,
    // a `#/r/` room deep-link, and the building view a floor's crumb leads back through). Any other
    // route — the siteplan, settings, import, or the to-do page itself — means the user arrived some
    // other way, so a stale `To-do` crumb must not follow them there.
    if (!['f', 'r', 'b'].includes(parts[0])) this.navOrigin = null;
    if (parts[0] === 'import') return this.showImport();
    // Settings is the one route with a second segment: an add-on with more to configure than a
    // settings row can hold gets a sub-page (SET-6). Tabs are still NOT routed — they're instance
    // state, and that distinction is deliberate: a tab is a view of the same page, a sub-page is a
    // place. An unrecognised segment degrades to the settings page rather than a dead end.
    if (parts[0] === 'settings') {
      return parts[1] === 'access-points' ? this.showApSettings() : this.showSettings();
    }
    if (parts[0] === 'todo') return this.showTodo();
    if (parts[0] === 'b') return this.renderBuilding(decodeURIComponent(parts[1]));
    if (parts[0] === 'f') return this.showFloor(decodeURIComponent(parts[1]), decodeURIComponent(parts[2]));
    // Deep-link (#/r/<dir>/<fid>/<seg>): the same floor load/guard path as #/f/, plus a target to
    // frame + highlight — a room (Location slug or uid) or a `rack-<id>`/`device-<id>` placement,
    // resolved against the loaded floor in showFloor (NAV-10).
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
    this._detachCurrent(); this.current = null;
    if (!this.canImport) return this.showNoImport();
    this.ensureScripts(['import-preview.js', 'import-uploader.js', 'facility-change-modal.js',
      'import-build-review.js', 'import-regions.js', 'import-align.js', 'import-bulk.js',
      'import-diff.js', 'import-match.js', 'import-organize.js', 'import-topology.js',
      'import-bind.js', 'import-cards.js', 'import-ocr-sweep.js', 'import-overview.js',
      'import-flow.js', 'fresh-import-flow.js', 'edit-import-flow.js'])
      .then(() => {
        const Flow = this.store.hasContent() ? EditImportFlow : FreshImportFlow;
        // Held as the stage page like every other non-Editor view, so `_navRefusal` can ask it
        // whether a run in flight forbids leaving (IMPORT-61) and `_detachCurrent` drops it on the
        // way out — the wizard's own state stays in the wizard.
        this._stagePage = new Flow(this);
        this._stagePage.show();
      })
      .catch(e => Toast.show('Could not load the import wizard: ' + e.message, true));
  }

  /** Empty state for a signed-in user who lacks import permission and has landed where the
   *  wizard would be (a fresh install with no content, or #/import — including the nav-reachable
   *  `views.ImportTabView`, HEALTH-8). Reuses the wizard's `.import-view`/`.hint` styling so it
   *  reads as the same surface, minus the controls. The copy is content-aware
   *  (`store.hasContent()`, the same check the router's home-route fallback already uses): a
   *  fresh install has genuinely nothing yet, but a change-only editor who followed the nav here
   *  because a floor plan looks wrong has a facility that's already imported — telling them "no
   *  facility map yet" would be actively misleading. */
  showNoImport() {
    this.crumbs([{ label: this.homeCrumbLabel(), hash: '/' }, { label: 'Import' }]);
    this.setToolbar([]);
    const stage = Dom.$('#stage'); stage.innerHTML = '';
    const hasContent = this.store.hasContent();
    stage.append(Dom.el('div', { class: 'import-view' }, [
      Dom.el('h2', {}, hasContent ? 'Editing needs import permission' : 'No facility map yet'),
      Dom.el('p', { class: 'hint' }, hasContent
        ? 'Only an administrator with import permission can add, replace, or reassign this '
          + 'facility’s floor plans. If a plan looks wrong or outdated, ask one to update it here.'
        : 'No facility map has been imported yet. Ask an administrator with import '
          + 'permission to set one up.'),
    ]));
  }

  /** Settings view (no editor active) — delegated to the SettingsPage framework, which
   *  builds the page from a declarative descriptor registry (see settings-page.js). Rack
   *  inventory now syncs per room from the floor's Place-racks panel, so there is nothing
   *  rack-related to configure here. */
  showSettings() {
    this._detachCurrent(); this.current = null;
    this.crumbs([{ label: this.homeCrumbLabel(), hash: '/' }, { label: 'Settings' }]);
    this.setToolbar([]);
    const stage = Dom.$('#stage'); stage.innerHTML = '';
    this._stagePage = new SettingsPage(this);
    this._stagePage.mount(stage);
  }

  /** The access point add-on's configuration sub-page (SET-6) — same shape as `showSettings()`,
   *  delegating to `ApSettingsPage`, which subclasses `SettingsPage` (see ap-settings-page.js). The
   *  linked `Settings` crumb is the way back, so the page carries no back control of its own; the
   *  `#settings-gear` stays lit here and closes out to wherever settings was opened from
   *  (`_settingsReturn`, MOBILE-3), since both it and `router()` key their settings-ness off
   *  `parts[0]` alone.
   *
   *  Unreachable in practice without import permission — the row carrying the `Configure` button
   *  that leads here is `canImport`-gated — but a typed URL lands on a page whose every row is
   *  likewise gated, so it renders empty rather than offering controls that would 403. */
  showApSettings() {
    this._detachCurrent(); this.current = null;
    this.crumbs([{ label: this.homeCrumbLabel(), hash: '/' }, { label: 'Settings', hash: '/settings' },
      { label: 'Access points' }]);
    this.setToolbar([]);
    const stage = Dom.$('#stage'); stage.innerHTML = '';
    this._stagePage = new ApSettingsPage(this);
    this._stagePage.mount(stage);
  }

  /** The facility-wide to-do page (no editor active) — every building's and floor's work rolled up
   *  into one prioritized list (TASK-5). Reached from the plugin nav (via `views.TodoTabView`) as
   *  well as `#/todo`. Mounted like the settings view: no Editor, just a class into `#stage`.
   *
   *  Deliberately does **not** bounce to the import wizard on an empty install the way the bare
   *  `#/` route does — `TodoPage` renders its own empty state instead. A route the user asked for
   *  by name should land where they aimed it, exactly as `#/settings` and `#/import` do. */
  showTodo() {
    // The to-do add-on can be switched off install-wide (ADDON-4). When it is, #/todo is not a
    // place — bounce to the map home rather than mounting a page for a disabled feature. The nav
    // item (a cached NetBox menu that can't hide live) and TodoTabView redirect here likewise, and
    // the endpoints refuse; this is the client mirror.
    if (!this.todos) return this.go('/');
    this._detachCurrent(); this.current = null;
    this.crumbs([{ label: this.homeCrumbLabel(), hash: '/' }, { label: 'To-do' }]);
    this.setToolbar([]);
    const stage = Dom.$('#stage'); stage.innerHTML = '';
    // A phone gets a purpose-built surface, not the desktop page retuned (MOBILE-9): `MobileTodoPage`
    // is a sibling class with its own `.mtodo-*` styling, chosen here and nowhere else. It re-mounts
    // itself through this same method when the viewport crosses the breakpoint
    // (MobileTodoPage._installBreakpointWatch), so this stays the single decision point.
    //
    // `!this.embed` is load-bearing, not defensive: `FacilityTodoWidget` (DASH-1) iframes this route
    // into a NetBox dashboard card that is routinely narrower than the phone breakpoint ON A DESKTOP,
    // so keying off width alone would flip that card to the phone page. The chrome-free card keeps
    // the desktop rollup.
    const Page = (!this.embed && this._phoneMq.matches) ? MobileTodoPage : TodoPage;
    this._stagePage = new Page(this);
    this._stagePage.mount(stage);
  }

  showSiteplan() {
    // No overall siteplan image (IMPORT-8): the siteplan view has no map to show. With exactly one
    // building, drop straight into it (mirrors renderBuilding's single-floor shortcut) so a
    // single-building facility lands on its content, not a one-row list; with several buildings,
    // SiteplanEditor renders a full-stage building directory instead of a dead "No siteplan image".
    if (this.store.manifest && !this.store.manifest.siteplan) {
      const bs = this.store.manifest.buildings;
      if (bs.length === 1) return this.renderBuilding(bs[0].dir);
    }
    this._detachCurrent(); this.current = new SiteplanEditor(this); this.current.show();
    // Warm the deferred floor data in the background so a drill-in is instant. Skipped in the
    // embed (which only ever shows the siteplan); errors are swallowed here and resurface on an
    // actual navigation, which awaits ensureFloorData and toasts.
    if (!this.embed) this.ensureFloorData().catch(() => {});
  }

  /** The label for the app's home breadcrumb root (hash '/'). Normally "Siteplan"; "Buildings"
   *  when the facility has no overall siteplan image (IMPORT-8), so a trail never reads "Siteplan"
   *  pointing at a plan that doesn't exist — the home there is the building directory / a single
   *  building. Defaults to "Siteplan" before the manifest has loaded. */
  homeCrumbLabel() {
    return (this.store.manifest && !this.store.manifest.siteplan) ? 'Buildings' : 'Siteplan';
  }

  /** `focusSeg` (deep-links only) names a target on this floor: a room (Location slug or uid) or a
   *  `rack-<id>`/`device-<id>` placement. The resolved target is framed + highlighted on entry
   *  (`FloorEditor._resolveFocusSeg`). An unknown/forbidden target degrades to the plain floor view
   *  (a toast, no error). Plain `#/f/` navigation passes no `focusSeg`. */
  async showFloor(dir, fid, focusSeg = null) {
    const b = this.store.building(dir);
    if (!b) return this.showSiteplan();
    const f = b.floors.find(x => x.id === fid);
    if (!f) return this.renderBuilding(dir);
    // FloorEditor.show reads floorLayout/floorData/placementData — ensure the deferred load
    // landed first (usually already warm). A data failure degrades (the accessors fall back
    // to empty/default) and toasts inline; a script failure is fatal for this view, so it
    // rejects the Promise.all and we stay put. The previous floor/building stays on screen for
    // this whole await, so `_setBusy` (UX-15) flags that a navigation is in flight.
    this._setBusy(true);
    try {
      await Promise.all([
        this.ensureScripts(['device-shapes.js', 'label-nudge.js', 'floor-arrange.js',
          'floor-todo-add.js', 'floor-ap-tool.js', 'floor-annotations.js', 'floor-placements.js',
          'floor-export.js', 'floor-todo.js', 'floor-editor.js']),
        this.ensureFloorData().catch(e => Toast.show('Could not load floor data: ' + e.message, true)),
      ]);
    } catch (e) { Toast.show('Could not load the floor view: ' + e.message, true); return; }
    finally { this._setBusy(false); }
    this.mode = 'view';   // every floor entry lands in view; reset so a prior floor's edit doesn't carry over
    // Recorded only once the floor is certain to render (past the guards and the bundle load), so a
    // navigation that bailed can't leave a floor the user never saw marked "Current" on the to-do
    // page. Set here rather than in the router because `#/f/` and `#/r/` both land here.
    this.lastFloor = { dir, fid };
    this._detachCurrent(); this.current = new FloorEditor(this, b, f);
    // Frame + pulse a target on mount from either entry point (both feed the editor's setFocus
    // before show()): a `#/r/` deep-link resolves its segment against this floor (a room by
    // Location slug/uid → padded polygon bbox, or a `rack-<id>`/`device-<id>` placement → point
    // region, framed like the search bar) via `_resolveFocusSeg`; a wayfinding-search jump hands a
    // precomputed region+room via `_pendingFocus`. The router clears `_pendingFocus` on any non-`f`
    // route, so the two never both apply; consume it either way so it never leaks onto a later
    // navigation.
    const focus = this._pendingFocus; this._pendingFocus = null;
    if (focusSeg) {
      const target = this.current._resolveFocusSeg(focusSeg);
      if (target) this.current.setFocus({ dir, fid, ...target });
      else Toast.show('That link no longer resolves; showing the floor.', true);
    } else if (focus && focus.dir === dir && focus.fid === fid) {
      this.current.setFocus(focus);
    }
    this.current.show();
  }

  /** Building view: a grid of floor cards (no editor active). */
  async renderBuilding(dir) {
    this._detachCurrent(); this.current = null;
    const b = this.store.building(dir);
    if (!b) return this.showSiteplan();
    // A single-floor building has no meaningful picker — go straight to its one floor. Rewrite the
    // hash in place (replaceState, no new history entry) so Back returns to the siteplan rather than
    // a `#/b/<dir>` that would just redirect here again; resync the guard baseline to match. This one
    // redirect covers every entry point (hotspot/legend click, a shared `#/b/<dir>` deep-link, the
    // embed's top-window open), so the shortcut lives here rather than in SiteplanEditor.openBuilding.
    if (b.floors.length === 1) {
      const only = b.floors[0];
      history.replaceState(null, '', '#' + this._hash('/f/' + encodeURIComponent(dir) + '/' + encodeURIComponent(only.id)));
      this._navHash = location.hash;
      return this.showFloor(dir, only.id);
    }
    // The per-floor room counts below read store.annotations, part of the deferred load; await
    // it up front so the whole view renders in one burst (a failed load leaves floors "unmapped").
    // The previous view stays on screen for this await, so `_setBusy` (UX-15) flags it in flight.
    this._setBusy(true);
    try { await this.ensureFloorData(); }
    catch (e) { Toast.show('Could not load room data: ' + e.message, true); }
    finally { this._setBusy(false); }
    this.crumbs([...this.rootCrumbs(), { label: b.name }]);
    const stage = Dom.$('#stage'); stage.innerHTML = '';
    if (!b.floors.length) {
      this.setToolbar([Dom.el('span', { class: 'hint tb-phone-hide' }, b.siteSlug)]);
      stage.append(Dom.el('div', { class: 'empty' }, 'No floor maps for ' + b.name));
      return;
    }
    // FloorViewMenu owns the card grid + its display preferences (previews / size / layout / sort /
    // badges), rebuilt per building entry. It's not an Editor, so it does NOT route through the
    // shared edit-menu; its View button rides in the toolbar and its render() draws the grid,
    // repainting just the grid (not the toolbar) when a preference changes (NAV-9).
    const view = new FloorViewMenu(this, dir, b);
    // The site-slug hint is `tb-phone-hide`: it is unshrinkable AND unfoldable (`_overflowToolbar`
    // only moves `button, select`), so on a narrow bar it holds width no fit can reclaim and pushes
    // the View button into the "…" menu — or past the bar's own scroll. The crumb trail already
    // names the building; the slug is desktop detail (MOBILE-8).
    this.setToolbar([Dom.el('span', { class: 'hint tb-phone-hide' }, b.siteSlug), view.button()]);
    view.render(stage);
  }

  /** (Re)draw the facility picker in the topbar from `this.facilities` (loaded once in init).
   *  Shown only when there's a real choice (≥2 facilities) and not in the chrome-free embed. The
   *  active facility is marked; empty facilities (no imported map) are flagged so picking one
   *  drops into the import wizard for it. Called on boot and on every facility switch.
   *
   *  A button + popover rather than the native `<select>` this replaced (NAV-21): a select is an
   *  un-shrinkable fixed-width block in the bar (it was up to 220px), and with `#crumbs` beside it
   *  that pushed the topbar past a phone's viewport and spilled the whole page into a horizontal
   *  scroll. A button collapses to icon-only at that width while its menu, being body-mounted, can
   *  still be wider than the control that opened it. */
  _renderFacilityPicker() {
    const host = Dom.$('#facility-picker');
    if (!host) return;
    // Re-render replaces the trigger, so drop the previous body-mounted menu and its document
    // listeners first — otherwise a facility switch orphans a menu on `document.body` whose
    // outside-click handler still fires (BUG-2). `destroy()`, not `close()`: the old panel is
    // discarded here, not reopened.
    this._teardownFacilityMenu();
    host.innerHTML = '';
    if (this.embed || !this.facilities || this.facilities.length < 2) return;
    // If the active facility isn't in the list (e.g. a still-empty facility mid-import), prepend it
    // so the control reflects where the user actually is.
    const known = this.facilities.some(f => f.slug === this.facility);
    const opts = known ? this.facilities
      : [{ slug: this.facility, name: this.facilityName(), has_content: false },
         ...this.facilities];
    const label = this.facilityName();
    const trigger = Dom.el('button', { class: 'facility-btn', title: 'Facility: ' + label,
      html: Icons.building + '<span class="facility-name"></span>' });
    trigger.querySelector('.facility-name').textContent = label;
    const menu = this._buildFacilityMenu(opts);
    host.append(trigger);
    document.body.append(menu);
    // Right-aligned: the trigger sits near the bar's right edge, where a left-anchored menu would
    // run off a narrow screen. The Popover wires the trigger's click and owns the open/close state.
    this._facilityPop = new Popover({ trigger, panel: menu, align: 'right' });
  }

  /** The picker's popover: one row per facility, the active one carrying the shared `button.active`
   *  tint. Mounted on `document.body` and reusing `.tb-overflow-menu` (plus a `.facility-menu`
   *  width modifier) so it inherits that menu's panel styling and full-width left-aligned rows.
   *  Anchoring, dismissal and teardown come from the shared `Popover` (lib.js), as they do for
   *  `FloorViewMenu` and `_buildToolbarOverflow`. */
  _buildFacilityMenu(opts) {
    const menu = Dom.el('div', { class: 'tb-overflow-menu facility-menu' });
    for (const f of opts) {
      const on = f.slug === this.facility;
      // Plain buttons, no `role="menu"/"menuitem"`: those roles promise arrow-key navigation no
      // `Popover` implements (and neither does the `.tb-overflow-menu` this borrows). Tab order
      // + `aria-current` say everything that's actually true.
      const row = Dom.el('button', { class: on ? 'active' : '',
        'aria-current': on ? 'true' : 'false' }, [Dom.el('span', {}, f.name)]);
      // An empty facility is still offered — choosing it drops into the import wizard for it —
      // but says so, so the choice isn't a surprise.
      if (!f.has_content) row.append(Dom.el('span', { class: 'facility-empty' }, '(empty)'));
      row.addEventListener('click', () => {
        this._closeFacilityMenu();
        if (!on) this.switchFacility(f.slug);
      });
      menu.append(row);
    }
    return menu;
  }

  /** Close the popover, leaving it mounted for the next open. Safe to call when it is already
   *  closed, or before the picker has been rendered at all. */
  _closeFacilityMenu() {
    if (this._facilityPop) this._facilityPop.close();
  }

  /** Close *and* discard the body-mounted menu, so a re-render of the picker can't leave an
   *  orphaned node (or a live document listener) behind. */
  _teardownFacilityMenu() {
    if (this._facilityPop) this._facilityPop.destroy();
    this._facilityPop = null;
  }

  // ---- shared chrome ----
  /** The head of a crumb trail: `Siteplan`, plus a `To-do` crumb when this view was reached from
   *  the facility-wide to-do page (`navOrigin`), so the user can walk back to the list they came
   *  from instead of hunting for Back. Views the to-do page can't reach build their own head — the
   *  router has already cleared the origin by the time they render. */
  rootCrumbs() {
    const root = [{ label: this.homeCrumbLabel(), hash: '/' }];
    if (this.navOrigin === 'todo') root.push({ label: 'To-do', hash: '/todo' });
    return root;
  }
  crumbs(items) {
    const nav = Dom.$('#crumbs'); nav.innerHTML = '';
    items.forEach((it, i) => {
      if (i) nav.append(Dom.el('span', { class: 'sep' }, '›'));
      nav.append(it.hash ? Dom.el('a', { onclick: () => this.go(it.hash) }, it.label)
        : Dom.el('span', {}, it.label));
    });
  }
  setToolbar(nodes) {
    // Keep the node list so _fitToolbar can partition it (labels ↔ overflow menu) on every resize
    // without the editors changing their EditorToolbar.build() contract — the fit rebuilds #toolbar from this.
    this._toolbarNodes = [].concat(nodes).filter(Boolean);
    this._fitToolbar();
  }
  /** Fit the per-view toolbar to the room in the bar, in two measured stages (ARCHITECTURE §10
   *  Responsive tool labels) — never a fixed breakpoint, so it's correct for any editor/mode's
   *  button count. Each stage's expand→measure→set runs synchronously (no paint between), so there
   *  is no flash. Re-run on every setToolbar and on region resize.
   *   1. Reveal the `tb-labeled` tool labels only if the fully-labeled bar fits; else `.compact`
   *      collapses them to icon+tooltip (the original behaviour).
   *   2. If even the compact bar overflows a narrow (phone-width) bar, fold the leading tools into
   *      a "…" overflow menu, keeping the trailing essentials (Save + badge, mode toggle) in the
   *      bar. This replaces the old horizontal scroll on small screens (NAV-20).
   *
   *  The one place the app's 720px breakpoint legitimately enters this measured fit is the node
   *  FILTER below, which drops two kinds of node — kept as two classes because they answer two
   *  different questions, and only the first is about hardware:
   *    · `.tb-desktop-only` — meaningless on TOUCH. Shortcuts (a keyboard/mouse reference) and the
   *      mode toggle's `Edit` face (editing is desktop-only by design, MOBILE-1) say nothing to a
   *      finger, and no width measurement can discover that (NAV-23).
   *    · `.tb-phone-hide` — redundant at phone WIDTH. The building view's site-slug hint duplicates
   *      the crumb trail, and being a `<span>` it can neither shrink nor fold into the "…" menu, so
   *      it holds width the real tools need (MOBILE-8).
   *  Either way the fit itself stays measured, never breakpoint-driven, and the node stays in
   *  `_toolbarNodes`, so crossing back to a wide window re-inserts it with no state to keep in
   *  sync. Don't extend this into a "phone ⇒ always overflow" rule. */
  _fitToolbar() {
    const region = Dom.$('#toolbar-region'), tb = Dom.$('#toolbar');
    if (!region || !tb) return;
    this._closeToolbarOverflow();
    // Rebuild the bar from the stored node list so a prior fit's overflow partition is undone
    // before this one re-measures (the moved buttons are reclaimed from the discarded menu here).
    region.classList.remove('compact');
    tb.innerHTML = '';
    const phone = this._phoneMq.matches;
    for (const n of (this._toolbarNodes || [])) {
      if (phone && n.matches && n.matches('.tb-desktop-only, .tb-phone-hide')) continue;
      tb.append(n);
    }
    // Prune BEFORE measuring, not only after a fold: a tool dropped by the filter above strands the
    // divider beside it, which would otherwise be measured as width the bar still needs (and reads
    // as an odd gap between the survivors). Both stages below must measure an already-tidy bar.
    this._pruneToolbarDividers(tb);
    if (tb.scrollWidth > tb.clientWidth + 1) region.classList.add('compact');   // stage 1
    if (tb.scrollWidth > tb.clientWidth + 1) this._overflowToolbar(tb);         // stage 2
  }
  /** Stage 2 of the fit: move the leading, non-essential tools into a "…" dropdown until the bar
   *  fits. The trailing essentials — Save (`.primary`) + its `.badge`, and the always-anchored mode
   *  toggle (`.mode`, NAV-1) — never move. Buttons are RE-PARENTED into the menu (their click
   *  handlers ride along), never rebuilt. No resize loop: `#toolbar-region` stays `flex:1`, so
   *  moving nodes never resizes the observed region (§10).
   *
   *  The trigger is only ever built when a fold is genuinely required, and only as many tools are
   *  folded as the fit actually needs (NAV-23): the divider prune runs after EVERY move, so the
   *  width a fold frees by stranding a divider is credited to the next fit check instead of being
   *  paid for a second time with another button. An overflow menu holding tools the bar had room
   *  for is as much a bug as a bar that overflows. */
  _overflowToolbar(tb) {
    const essential = (n) => n.matches && n.matches('.mode, .primary, .badge');
    const fits = () => tb.scrollWidth <= tb.clientWidth + 1;
    // Fold the interactive tools (buttons + the grid-size select) — not the essentials, not the
    // dividers (pruned as we go). A `.view-menu-wrap` (building view) is a div, so it stays put.
    const candidates = [...tb.children].filter(n => n.matches && n.matches('button, select') && !essential(n));
    if (candidates.length <= 1) return;   // nothing worth folding
    let pop = null;
    for (const btn of candidates) {
      if (fits()) break;
      // The trigger materializes on the FIRST genuine fold, never before it — so a bar that turns
      // out to fit simply never grows a "…", instead of growing one and tearing it back down. It
      // is prepended in the same step as that fold, so it is part of every width check after it.
      if (!pop) {
        pop = this._buildToolbarOverflow();
        tb.prepend(pop.trigger);
        document.body.append(pop.panel);
      }
      pop.panel.append(btn);
      // Re-tidy before the next measurement: this move may have stranded the divider that sat
      // beside the tool, and that reclaimed width can be enough to fit without folding another.
      this._pruneToolbarDividers(tb);
    }
    if (!pop) return;   // nothing folded after all — no trigger in the bar
    this._overflowPop = pop;
  }
  /** Build the overflow trigger + its (body-mounted, `position:fixed`) menu. The menu lives on
   *  `document.body`, not in `#toolbar`, so the `#toolbar button.icononly span` label-clip never
   *  reaches its buttons (they read as full labeled rows) and it escapes the bar's overflow clip.
   *  Returns the `Popover` (lib.js) that owns the pair — left-aligned, since the "…" sits at the
   *  bar's leading edge with the whole bar's width to hang into. */
  _buildToolbarOverflow() {
    const menu = Dom.el('div', { class: 'tb-overflow-menu' });
    const trigger = Dom.el('button', { class: 'icononly tb-overflow', title: 'More tools',
      html: Icons.more + '<span>More tools</span>' });
    const pop = new Popover({ trigger, panel: menu, align: 'left' });
    // A tool click runs its own handler (still on the node) as the event bubbles, then closes.
    menu.addEventListener('click', (e) => { if (e.target.closest('button')) pop.close(); });
    return pop;
  }
  /** Tear down any overflow menu from a prior fit: `destroy()` drops its outside-click/Escape
   *  listeners and the body-mounted menu (its buttons are reclaimed when `_fitToolbar` rebuilds
   *  the bar from `_toolbarNodes`). */
  _closeToolbarOverflow() {
    if (this._overflowPop) this._overflowPop.destroy();
    this._overflowPop = null;
  }
  /** Drop `.tb-div` separators left dangling once tools moved into the overflow menu: any divider
   *  that is now leading, trailing, doubled, or immediately after the "…" trigger. */
  _pruneToolbarDividers(tb) {
    const kids = [...tb.children];
    kids.forEach((n, i) => {
      if (!(n.classList && n.classList.contains('tb-div'))) return;
      const prev = kids[i - 1], next = kids[i + 1];
      const drop = !prev || !next
        || (prev.classList && (prev.classList.contains('tb-div') || prev.classList.contains('tb-overflow')));
      if (drop) n.remove();
    });
  }
  closePanel() {
    Dom.$('#panel').classList.add('hidden');
    if (this.current && this.current.onPanelClosed) this.current.onPanelClosed();
  }

  _bindGlobal() {
    const gear = Dom.$('#settings-gear');
    gear.innerHTML = Icons.settings;
    // The buildings-panel toggle (NAV-8) is a siteplan-only sibling of the gear. Stamp its
    // icon once here; SiteplanEditor.show reveals + wires it (and router() re-hides it on
    // every other route), so no click handler lives here.
    Dom.$('#panel-toggle').innerHTML = Icons.panelRight;
    // Toggle: on the settings route the gear closes settings; elsewhere it opens them. Mirrors
    // the floor editor's "inspect state, go to the opposite" mode buttons. The .active tint is
    // kept in sync per-route by router(), not here.
    //
    // Closing returns to the route the gear was opened FROM (MOBILE-3) rather than the siteplan:
    // settings is a detour, and being thrown back to the app's home screen from a floor you were
    // reading is a navigation loss, not a reset. The route is captured on open, so it is
    // self-refreshing and can never point at a stale place; `parts` from `_parseHash()` are
    // already facility-stripped (and still encoded), so `go()` re-prefixes the active facility.
    // Both the settings page and its `access-points` sub-page (SET-6) key settings-ness off
    // `parts[0]` alone, exactly as router() does, so the sub-page returns through the same door.
    gear.addEventListener('click', () => {
      const parts = this._parseHash().parts;
      if (parts[0] === 'settings') {
        const back = this._settingsReturn || '/';
        this._settingsReturn = null;
        this.go(back);
        return;
      }
      this._settingsReturn = parts.length ? '/' + parts.join('/') : '/';
      this.go('/settings');
    });
    Dom.$('#panel-close').addEventListener('click', () => this.closePanel());
    window.addEventListener('beforeunload', (e) => {
      // Flush the crash-recovery draft synchronously on a clean close, capturing the last edits the
      // debounce hasn't written yet (SAVE-5); the warning below still fires for unsaved work.
      this.store.flushDraft();
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
    // The app's single 720px breakpoint, owned here rather than per-editor (NAV-23): _fitToolbar
    // reads `.matches` to drop the touch-meaningless `.tb-desktop-only` tools and the
    // width-redundant `.tb-phone-hide` ones, so a crossing has to re-run the fit. The observer above would very likely catch it anyway — the region is flex:1,
    // and the mobile block reshapes the topbar around it — but "very likely" is a silent-failure
    // mode for a bar that would then be missing a button until the next resize. This listener is
    // app-lifetime, so unlike the editors' own mobile controllers it needs no detach() teardown.
    this._phoneMq.addEventListener('change', () => this._fitToolbar());
  }

  /** The single in-app navigation chokepoint, run on every `hashchange` (and by `go()` when
   *  the target equals the current hash, which fires no event). Two guards live here, in order:
   *  the active stage page's own hard refusal (`_navRefusal` — a live import run, IMPORT-61), then
   *  the unsaved-work prompt below. Guards unsaved work: on a
   *  real change it shows the shared `.fm-modal` unsaved-work prompt (`_confirmLeavePage`,
   *  UX-15) before routing; Cancel reverts `location.hash` to the last-committed value
   *  (`_navHash`), Leave discards the pending edits first so the dirty flags don't re-arm the
   *  guard on a later, unrelated navigation. `_revertingHash` swallows the synthetic
   *  `hashchange` the revert itself fires. `_confirmingNav` guards against a second `hashchange`
   *  (e.g. rapid Back presses) opening a second overlay while the first prompt's promise is
   *  still pending — unlike the blocking `confirm()` this replaced, an async modal doesn't stop
   *  other JS from running. */
  async _navigate() {
    if (this._revertingHash) { this._revertingHash = false; this._navHash = location.hash; return; }
    if (this._confirmingNav) return;
    // A page that refuses to be left right now (a live import run, IMPORT-61) is a flat refusal, not
    // a choice — so it is answered before the unsaved-work prompt, with a toast rather than a modal,
    // and the hash is put back exactly as Cancel does below.
    const refusal = this._navRefusal();
    if (refusal) {
      Toast.show(refusal, true);
      if (location.hash !== this._navHash) { this._revertingHash = true; location.hash = this._navHash; }
      return;
    }
    if (this.store.hasUnsaved()) {
      this._confirmingNav = true;
      const leave = await this._confirmLeavePage();
      this._confirmingNav = false;
      if (!leave) {
        // The revert re-fires hashchange (swallowed via _revertingHash). Skip it when the hash
        // never actually moved (same-hash go), which would otherwise leave the flag stuck true.
        if (location.hash !== this._navHash) { this._revertingHash = true; location.hash = this._navHash; }
        return;
      }
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
