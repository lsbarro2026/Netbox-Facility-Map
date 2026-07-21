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
    this.netbox.facilities()
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

  /** Restore-draft prompt (mirrors Editor._confirmLeaveEdit's `.fm-modal` pattern): resolves `true`
   *  to restore, `false` to discard. Backdrop click or Discard dismisses as discard. */
  _confirmRestore() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; overlay.remove(); resolve(v); };
      const overlay = Dom.el('div', { class: 'fm-modal', onclick: (e) => { if (e.target === overlay) finish(false); } }, [
        Dom.el('div', { class: 'fm-modal-panel' }, [
          Dom.el('h3', {}, 'Restore unsaved changes?'),
          Dom.el('p', {}, 'This browser has map edits from a previous session that were never saved. '
            + 'Restore them, or discard and start from the last saved version.'),
          Dom.el('div', { class: 'fm-modal-actions' }, [
            Dom.el('button', { onclick: () => finish(false) }, 'Discard'),
            Dom.el('button', { class: 'primary', onclick: () => finish(true) }, 'Restore'),
          ]),
        ]),
      ]);
      document.body.append(overlay);
    });
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
      await this._maybeRestoreDraft();   // this facility may carry a draft from a prior session (SAVE-5)
    }
    this.closePanel();
    // The persistent settings gear lives in #topbar, outside the per-view toolbar that
    // setToolbar() rebuilds — sync its active tint here so every route (incl. navigating
    // away via breadcrumbs/Back) reflects whether settings is open.
    Dom.$('#settings-gear').classList.toggle('active', parts[0] === 'settings');
    // The buildings-panel toggle (NAV-8) is siteplan-only chrome. Default it hidden on every
    // route; SiteplanEditor.show re-reveals it, so it never leaks onto a floor/settings/import view.
    Dom.$('#panel-toggle').hidden = true;
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
    this.current = null;
    this.crumbs([{ label: this.homeCrumbLabel(), hash: '/' }, { label: 'Settings' }]);
    this.setToolbar([]);
    const stage = Dom.$('#stage'); stage.innerHTML = '';
    new SettingsPage(this).mount(stage);
  }

  /** The access point add-on's configuration sub-page (SET-6) — same shape as `showSettings()`,
   *  delegating to `ApSettingsPage`, which subclasses `SettingsPage` (see ap-settings-page.js). The
   *  linked `Settings` crumb is the way back, so the page carries no back control of its own; the
   *  `#settings-gear` stays lit here and still returns to the siteplan, since both it and `router()`
   *  key their settings-ness off `parts[0]` alone.
   *
   *  Unreachable in practice without import permission — the row carrying the `Configure` button
   *  that leads here is `canImport`-gated — but a typed URL lands on a page whose every row is
   *  likewise gated, so it renders empty rather than offering controls that would 403. */
  showApSettings() {
    this.current = null;
    this.crumbs([{ label: this.homeCrumbLabel(), hash: '/' }, { label: 'Settings', hash: '/settings' },
      { label: 'Access points' }]);
    this.setToolbar([]);
    const stage = Dom.$('#stage'); stage.innerHTML = '';
    new ApSettingsPage(this).mount(stage);
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
    this.current = null;
    this.crumbs([{ label: this.homeCrumbLabel(), hash: '/' }, { label: 'To-do' }]);
    this.setToolbar([]);
    const stage = Dom.$('#stage'); stage.innerHTML = '';
    new TodoPage(this).mount(stage);
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
    this.current = new SiteplanEditor(this); this.current.show();
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
    // rejects the Promise.all and we stay put.
    try {
      await Promise.all([
        this.ensureScripts(['device-shapes.js', 'floor-export.js', 'floor-todo.js', 'floor-editor.js']),
        this.ensureFloorData().catch(e => Toast.show('Could not load floor data: ' + e.message, true)),
      ]);
    } catch (e) { Toast.show('Could not load the floor view: ' + e.message, true); return; }
    this.mode = 'view';   // every floor entry lands in view; reset so a prior floor's edit doesn't carry over
    // Recorded only once the floor is certain to render (past the guards and the bundle load), so a
    // navigation that bailed can't leave a floor the user never saw marked "Current" on the to-do
    // page. Set here rather than in the router because `#/f/` and `#/r/` both land here.
    this.lastFloor = { dir, fid };
    this.current = new FloorEditor(this, b, f);
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
    this.current = null;
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
    try { await this.ensureFloorData(); }
    catch (e) { Toast.show('Could not load room data: ' + e.message, true); }
    this.crumbs([...this.rootCrumbs(), { label: b.name }]);
    const stage = Dom.$('#stage'); stage.innerHTML = '';
    if (!b.floors.length) {
      this.setToolbar([Dom.el('span', { class: 'hint' }, b.siteSlug)]);
      stage.append(Dom.el('div', { class: 'empty' }, 'No floor maps for ' + b.name));
      return;
    }
    // FloorViewMenu owns the card grid + its display preferences (previews / size / layout / sort /
    // badges), rebuilt per building entry. It's not an Editor, so it does NOT route through the
    // shared edit-menu; its View button rides in the toolbar and its render() draws the grid,
    // repainting just the grid (not the toolbar) when a preference changes (NAV-9).
    const view = new FloorViewMenu(this, dir, b);
    this.setToolbar([Dom.el('span', { class: 'hint' }, b.siteSlug), view.button()]);
    view.render(stage);
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
    // The buildings-panel toggle (NAV-8) is a siteplan-only sibling of the gear. Stamp its
    // icon once here; SiteplanEditor.show reveals + wires it (and router() re-hides it on
    // every other route), so no click handler lives here.
    Dom.$('#panel-toggle').innerHTML = Icons.panelRight;
    // Toggle: on the settings route the gear returns to the siteplan; elsewhere it opens
    // settings. Mirrors the floor editor's "inspect state, go to the opposite" mode buttons.
    // The .active tint is kept in sync per-route by router(), not here.
    gear.addEventListener('click', () => {
      const onSettings = this._parseHash().parts[0] === 'settings';
      this.go(onSettings ? '/' : '/settings');
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
