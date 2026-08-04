'use strict';
/* floor-editor.js — FloorEditor: draw/edit room polygons on a floor image and
   bind each to a NetBox Location. In view mode rooms are invisible clickable
   zones (rooms holding rack/device markers stay highlighted). Extends Editor for
   the shared engine. */

const NB_BIND_LIST_LIMIT = 300;   // room→Location bind list row cap (UX-16); _bindList flags a hit





class FloorEditor extends Editor {
  constructor(app, building, floor) {
    super(app);
    this.building = building;
    this.floor = floor;
    this.netbox = app.netbox;
    this.selectedPlacement = null;   // rack/device marker showing rotate/resize handles
    this.selectedArrow = null;       // route arrow showing editable nodes / panel
    this.selectedNote = null;        // free-standing text note whose label is being edited
    this.rackRoom = null;            // room whose rack panel is open
    this.placingRacks = false;       // Place-racks sub-mode of edit (implies editing())
    this.copyingLink = false;        // Copy-link sub-tool of view mode: click a room/rack/device to copy its deep-link
    this.arranging = false;          // Arrange mode: drag sheets into grid cells
    this.layout = null;              // display geometry (padded while arranging)
    this.baseLayout = null;          // the floor's true (unpadded) sheet geometry
    this._peeked = false;            // first mount frames sheet 1 (peek), later shows full-fit
    this._focus = null;              // pending focus target { roomId, region } to frame on mount
    this._focusRoomId = null;        // room pulsed by the focus highlight (cleared after ~3.5s)
    this.showOverlays = true;        // read-only data-overlay layer visible by default (FMT-9)
    this.todo = null;                // the floor to-do panel (FloorTodo), built per show() (ADDON-1)
    this._containedRings = null;     // per-render map id→contained smaller-room rings (ROOM-2)
    // The self-contained concerns, each constructed with a back-ref and reachable as a field
    // (the ImportFlow collaborator pattern). Selection state deliberately stays on the editor —
    // deselect/handleKey/onPanelClosed/_snapshotState all read it.
    this.arrange = new FloorArrange(this);
    this.todoAdd = new FloorTodoAdd(this);
    this.apTool = new FloorApTool(this);
    this.annotations = new FloorAnnotations(this);
    this.placements = new FloorPlacements(this);
  }

  /** Accept a focus target from App.showFloor (before show()) — a wayfinding-search jump or a
   *  `#/r/` deep-link (room or rack/device, resolved by `_resolveFocusSeg`). `region` frames the
   *  viewport on the target instead of the usual peek/full-fit; `roomId` is pulsed once the floor
   *  renders (a rack/device pulses its containing room, matching the search jump). */
  setFocus(focus) { this._focus = { roomId: focus.roomId, region: focus.region }; }

  // ---- Editor hooks ----
  data() { return this.store.floorData(this.building.dir, this.floor.id); }
  polys() { return this.data().rooms; }
  editing() { return this.app.mode === 'edit'; }
  // gridActive() is inherited from Editor (= editing()): rack placement is a sub-mode of
  // edit, so the grid is already live there and markers snap like room nodes.
  markDirty() { this.store.markDirty(); this._setBadge(); }
  markPlacementsDirty() { this.store.markPlacementsDirty(); this._setBadge(); }
  // The shared label engine serves rack/device placements, route-arrow notes, and
  // free-standing text notes here (floor rooms stay unlabelled). A placement is keyed by
  // its own `uid` — the NetBox `id` collides across racks/devices; arrows/notes fall back
  // to their `id`. Label edits dirty the store the shape lives in: only rack/device
  // placements live in the placement store (they alone carry a `uid`); arrows and notes
  // are annotations in the floor blob.
  _labelKey(shape) { return shape.uid || shape.id; }
  _labelDirty(shape) { if (shape.uid) this.markPlacementsDirty(); else this.markDirty(); }
  deselect() {
    if (!this.selected && !this.selectedArrow && !this.selectedNote && !this.selectedPlacement) return;
    if (this.selectedNote) this.annotations.dropEmptyNote(this.selectedNote);
    this.selected = null; this.selectedArrow = null; this.selectedNote = null;
    this.selectedPlacement = null;   // a plain-edit rack deselects on a background click too
    this.editingLabel = null;
    this.render(); this.app.closePanel();
  }

  /** The save badge covers every unsaved edit on this floor — rooms, sheet layout,
   *  and rack/device placements — regardless of the current mode, so switching modes
   *  (e.g. dropping a rack, then flipping back to edit) never hides a pending change. */
  _dirty() {
    return this.store.dirty || this.store.layoutDirty || this.store.placementsDirty;
  }

  // ---- undo hooks (see Editor.snapshot/undo) ----
  /** A snapshot of everything an edit on this floor can change — its rooms + arrows +
   *  notes, its rack/device placements, its sheet arrangement — captured BEFORE the mutation.
   *  The dirty flags are NOT stored: `_applySnapshot` re-derives them from the store baselines
   *  (SAVE-6), so they stay correct even after a save advances those baselines. Cloned through the
   *  base `_clone` (all are plain JSON). */
  _snapshotState() {
    const dir = this.building.dir, fid = this.floor.id, key = Util.floorKey(dir, fid);
    const rec = this.data(), pdata = this.store.placementData(dir, fid);
    const layout = this.store.layouts[key];
    return {
      rooms: this._clone(rec.rooms), arrows: this._clone(rec.arrows || []),
      notes: this._clone(rec.notes || []), placements: this._clone(pdata.placements),
      layout: layout ? this._clone(layout) : null,
    };
  }

  /** Re-tile the canvas when the restored snapshot changed the sheet arrangement. That alters the
   *  combined canvas geometry (`this.layout`/`baseLayout` are derived in show(), not render()), so
   *  undoing one needs a full show() — a plain render() would draw the restored coords over the
   *  wrong canvas. Detected BEFORE `super` overwrites the blob; run after, so the re-tile sees the
   *  restored data and the shared tail (badge, panel close) has already settled. */
  _restoreState(snap) {
    const key = Util.floorKey(this.building.dir, this.floor.id);
    const layoutChanged = JSON.stringify(this.store.layouts[key] || null) !== JSON.stringify(snap.layout);
    super._restoreState(snap);
    if (layoutChanged) this.show();
  }

  /** Write a snapshot back into the store records and re-derive the dirty flags from the store
   *  baselines. The shared tail — dropping transient selection/drag state (a restored delete may
   *  have removed the selected shape; live drag refs now point at stale arrays), the badge, and the
   *  guarded panel close — is the base's (`Editor._restoreState`). */
  _applySnapshot(snap) {
    const dir = this.building.dir, fid = this.floor.id, key = Util.floorKey(dir, fid);
    const rec = this.store.floorData(dir, fid);
    rec.rooms = snap.rooms; rec.arrows = snap.arrows; rec.notes = snap.notes || [];
    this.store.placementData(dir, fid).placements = snap.placements;
    if (snap.layout) this.store.layouts[key] = snap.layout;
    else delete this.store.layouts[key];
    // Cross-floor copy: also revert the target floor's rooms to their pre-copy state (undoing a
    // copyRoomsToFloor). That floor isn't the one on screen, so no re-render is needed — but it
    // must be reverted BEFORE re-deriving the dirty flag, which diffs the whole annotations map.
    if (snap.extraFloor) {
      const other = this.store.annotations[snap.extraFloor.key];
      if (other) other.rooms = snap.extraFloor.rooms;
    }
    // Re-derive the dirty flags from the (now fully restored) store state — after both this floor's
    // records and any extraFloor revert are in place, so a cross-floor undo is reflected too.
    this.store.recomputeFloorDirty();
    // Re-sync the floor to-do panel's room list: every *forward* room mutation (add, delete,
    // rename, rebind) calls syncRooms, so an undo that reinstates or removes a room must too, or
    // the panel's room picker keeps offering a room that is gone (or omits one that is back).
    // syncRooms early-returns on an unchanged signature, so the non-room undos pay nothing.
    this.todo && this.todo.syncRooms(rec.rooms);
  }

  /** The floor's extra selection channels on top of the base's selected/label/draft. */
  _clearTransientState() {
    super._clearTransientState();
    this.selectedArrow = null; this.selectedNote = null;
    this.selectedPlacement = null; this.rackRoom = null;
  }

  _dirtyScopes() { return ['floor', 'racks']; }

  // ---- view assembly ----
  show() {
    const b = this.building, f = this.floor;
    this.draft = null; this.selected = null; this.editingLabel = null; this.selectedPlacement = null;
    this.selectedArrow = null; this.selectedNote = null; this.rackRoom = null;
    this.rectMode = false; this.rectDraft = null;
    this.arrange.reset();
    // NB: history is NOT cleared here. A FloorEditor is created fresh per navigation
    // (App.showFloor), so history is already empty on a real (re)mount; the only re-`show()`
    // on a live instance is an arrange toggle / sheet-move relayout, where the undo timeline
    // must survive (a sheet move is snapshotted with its layout, so old snapshots stay valid).
    this.grid.adjust = false;
    this.grid.setScope(Util.floorKey(b.dir, f.id));
    if (!this.editing()) { this.arranging = false; this.placingRacks = false; }   // both are edit-mode sub-modes

    // A floor is one or more sheets (some floors split a single level across
    // multiple plan sheets) tiled into a grid; they share one normalized
    // coordinate space spanning the whole canvas. `floorLayout` is the single source
    // of that geometry; while arranging we pad the canvas with a spare column + row
    // so a sheet can be dragged into a not-yet-used cell.
    const base = this.store.floorLayout(b.dir, f.id);
    this.baseLayout = base;
    const multi = base.cells.length > 1;
    const pad = (this.arranging && multi) ? 1 : 0;
    const cols = base.cols + pad, rows = base.rows + pad;
    const W = cols * base.cellW, H = rows * base.cellH;
    this.layout = { cells: base.cells, cellW: base.cellW, cellH: base.cellH, cols, rows, W, H };

    this.app.crumbs([
      ...this.app.rootCrumbs(),
      { label: b.name, hash: '/b/' + encodeURIComponent(b.dir) },
      { label: f.label },
    ]);
    this.app.setToolbar(this.toolbar.build());

    const stage = Dom.$('#stage'); stage.innerHTML = '';
    // Rebuilt fresh every show() (including arrange/sheet-move re-mounts, since stage.innerHTML
    // is cleared above), so there's no stale "already shown" state to reset between mounts.
    const planUnavailable = this._planUnavailableOverlay();
    this._planUnavailableEl = planUnavailable;
    const imgs = base.cells.map(c => Dom.el('img', { class: 'sheet', src: this.store.mediaUrl(c.image), alt: f.label,
      style: `left:${c.col * base.cellW}px;top:${c.row * base.cellH}px;width:${base.cellW}px;height:${base.cellH}px`,
      onerror: (e) => this._onSheetError(e.target, b.dir, f.id, c.image) }));
    const s = Dom.svg('svg', { preserveAspectRatio: 'none' });
    s.append(this._hatchDefs());
    const wrap = Dom.el('div', { class: 'map-wrap', id: 'floor-wrap', style: `width:${W}px;height:${H}px` },
      [...imgs, s]);
    // The sheet stamp, the plan-unavailable overlay, and the armed-mode banner all sit in the
    // viewport (not the wrap), so they stay fixed in place instead of panning/zooming with the map.
    const viewport = Dom.el('div', { class: 'map-viewport' },
      [wrap, this._sheetMark(), planUnavailable, this._modeBanner()]);
    // The room-by-room to-do list sits in a resizable/hideable panel beside the map (ADDON-1),
    // reusing the siteplan index's flex-row + drag-handle chrome via the shared
    // `Editor._installPanelResize`. The chrome-free dashboard embed keeps just the map — no panel,
    // no toggle, no persisted prefs — exactly as it suppresses the siteplan legend resize. The
    // to-do add-on being switched off install-wide (ADDON-4) suppresses the panel the same way, and
    // with `this.todo` left null the hover "+" compose glyph drops out too (`FloorTodoAdd`).
    // Held for the mobile-layout controller installed after `attach()` below.
    let todoPanel = null, todoCollapsedKey = null;
    if (this.app.embed || !this.app.todos) {
      stage.append(viewport);
    } else {
      this.todo = new FloorTodo(this.app, Util.floorKey(b.dir, f.id), this.data().rooms);
      // The ✕ the panel wears as a phone-width sheet; collapsing is the editor's call, so the
      // behaviour is injected rather than reached for from inside the list (NAV-21).
      const panel = this.todo.build({ onClose: () => this._setPanelCollapsed(true, false) });
      const handle = Dom.el('div', { class: 'legend-resize',
        title: 'Drag to resize · double-click to hide the to-do panel' });
      const view = Dom.el('div', { class: 'floor-view' }, [viewport, handle, panel]);
      stage.append(view);
      const resize = this.todo.resizeOpts();
      this._installPanelResize({ view, panel, handle, ...resize });
      todoPanel = panel; todoCollapsedKey = resize.collapsedKey;
    }

    // A focus target (wayfinding-search jump or `#/r/` room deep-link) frames its room and takes
    // priority over the peek. Otherwise the first mount of a multi-sheet floor centres the primary
    // sheet (page 0) zoomed out so the other sheets are discoverable; later re-mounts (mode toggles,
    // arrange drops) just full-fit.
    if (this._focus) {
      this.initialFocus = this._focus.region;
      this._focusRoomId = this._focus.roomId;
      this._focus = null;
      this._scheduleFocusFade();
    } else {
      this.initialFocus = (multi && !this._peeked && !this.arranging)
        ? this._peekRegion(base.cells[0], base) : null;
    }
    this._peeked = true;

    this.attach(imgs[0], s, [W, H]);
    // After attach, so its top-of-attach detach() can't strip the listener just added — the same
    // ordering constraint SiteplanEditor._installMobileLayout is subject to. `_installPanelResize`
    // (which publishes `_setPanelCollapsed`) already ran above, so the controller has what it drives.
    if (todoPanel) this._installMobileLayout(todoPanel, todoCollapsedKey);
    this.loadNbRooms();
    // Markers now show in plain edit (inert reference glyphs), racks mode, and view — any
    // editing state or view mode needs the live inventory so they render real glyphs, not
    // the stale fallback.
    if (this.editing() || this.app.mode === 'view') this.placements.ensureInventory();
  }

  /** Phone layout for the to-do panel (NAV-21) — the floor's counterpart to
   *  `SiteplanEditor._installMobileLayout`, and deliberately the same shape: one `matchMedia`
   *  controller at the app's single 720px breakpoint, driving the panel by class, torn down in
   *  `detach()`.
   *
   *  A 240–320px side column beside a floor plan is a desktop shape; on a phone it left the map a
   *  strip too narrow to read. So at this width the panel becomes its own full-screen page over the
   *  stage (`.mobile-sheet`, a fixed overlay under the topbar with its own ✕) and starts collapsed,
   *  so a floor still OPENS on its map. Two properties matter: the collapse does not persist, so
   *  the desktop show/hide preference is never clobbered (exactly as the siteplan drawer); and the
   *  sheet is `position: fixed`, so the `.map-viewport`'s flex box never changes and the pan/zoom
   *  re-clamp (§10) is never disturbed by opening the list. `#panel-toggle` opens it, as on desktop. */
  _installMobileLayout(panel, collapsedKey) {
    const mq = Util.phoneMq();
    const apply = () => {
      panel.classList.toggle('mobile-sheet', mq.matches);
      if (!this._setPanelCollapsed) return;
      // Narrow: start closed on the map. Wide: hand the persisted preference back, which the
      // sheet's non-persisting collapse never wrote to.
      this._setPanelCollapsed(mq.matches ? true : this._loadPanelCollapsed(collapsedKey), false);
    };
    apply();
    this._mobileMq = mq;
    this._mobileMqHandler = apply;
    mq.addEventListener('change', apply);
  }

  /** Drop the mobile-layout `matchMedia` listener when the editor is torn down on navigation
   *  (App._detachCurrent), so it never fires against a replaced view (BUG-2) — the base handles the
   *  container ResizeObserver. Mirrors `SiteplanEditor.detach`, including its safety on the initial
   *  `attach()`'s top-of-attach detach: the listener is installed only afterwards, so `_mobileMq` is
   *  still null there. */
  detach() {
    super.detach();
    if (this._mobileMq) { this._mobileMq.removeEventListener('change', this._mobileMqHandler); this._mobileMq = null; }
  }

  /** The normalized rect framing a room's polygon bbox, padded so the room sits in a little
   *  context rather than filling the viewport edge-to-edge. Used by App's `#/r/` room deep-link
   *  to derive a `setFocus` region from the room alone. The padding itself lives in
   *  `Geom.focusRegion` — shared with the wayfinding search jump so the two entry points frame a
   *  room identically (see its comment). Returns null if the room/geometry is gone. */
  _roomFocusRegion(id) {
    const room = this.data().rooms.find(r => r.id === id);
    if (!room || !room.polygon || !room.polygon.length) return null;
    return Geom.focusRegion(room.polygon);
  }

  /** Resolve a `#/r/` deep-link segment against this floor into a `{ roomId, region }` for
   *  `setFocus`, or null when it no longer resolves. A `rack-<id>`/`device-<id>` segment matches a
   *  placement (racks/devices have no slug — only a numeric NetBox id + kind) and frames a small
   *  point-region around its marker, pulsing its containing room — exactly the framing the siteplan
   *  search bar uses for a placed rack/device (`SiteplanEditor._gotoTarget`). Anything else is a
   *  room segment: its bound Location slug, then the room uid as a fallback, framed on the padded
   *  polygon bbox (`_roomFocusRegion`). A placement-shaped segment that finds no placement falls
   *  through to room resolution, so a room whose slug happens to look like `rack-…` still resolves. */
  _resolveFocusSeg(seg) {
    const m = /^(rack|device)-(.+)$/.exec(seg);
    if (m) {
      const p = this.store.placementData(this.building.dir, this.floor.id).placements
        .find(pl => pl.kind === m[1] && String(pl.id) === m[2]);
      if (p) return { roomId: p.room, region: Geom.pointRegion(p.x, p.y) };
    }
    const room = this.data().rooms.find(
      r => (r.location && r.location.slug === seg) || r.id === seg);
    const region = room && this._roomFocusRegion(room.id);
    return region ? { roomId: room.id, region } : null;
  }

  /** Clear the focus pulse after a few seconds so the highlight is transient. Guarded
   *  by `app.current === this`: a navigation away replaces the editor, and we must not render
   *  a torn-down view. */
  _scheduleFocusFade() {
    setTimeout(() => {
      if (this._focusRoomId == null || this.app.current !== this) return;
      this._focusRoomId = null;
      this.render();
    }, 3500);
  }

  /** The normalized rect framing the primary sheet's cell, centred and expanded ~1.6×
   *  so the floor opens *zoomed out* around that sheet with the neighbouring sheets
   *  peeking in (rather than zoomed *in* on a single sheet). Coordinates are 0..1 over
   *  the whole tiled canvas and are deliberately *not* clamped to [0,1]: an edge sheet's
   *  expansion runs off the canvas into background, which keeps the sheet centred.
   *  `PanZoom.fitRegion` floors the scale at the whole-wrap fit, so this can never zoom
   *  out past a full fit. */
  _peekRegion(cell, lay) {
    const REVEAL = 1.6;   // frame this ×the cell about its centre → zoom out to reveal neighbours
    const cw = lay.cellW / lay.W, ch = lay.cellH / lay.H;
    const cx = (cell.col * lay.cellW + lay.cellW / 2) / lay.W;
    const cy = (cell.row * lay.cellH + lay.cellH / 2) / lay.H;
    return [cx - cw * REVEAL / 2, cy - ch * REVEAL / 2, cx + cw * REVEAL / 2, cy + ch * REVEAL / 2];
  }

  /** Decorative drawing-sheet stamp, pinned to the viewport corner. */
  _sheetMark() {
    const code = (Util.code(this.building) + ' ' + this.floor.id).trim();
    return Dom.el('div', { class: 'sheet-mark' }, Dom.el('div', { class: 'sheet-stamp' }, code));
  }

  /** Non-alarming "plan unavailable" overlay (HEALTH-9), mirroring the server-side
   *  floor_unresolved.html card shown on the Location page for the same rename-drift scenario.
   *  Hidden by default; revealed by `_onSheetError` the first time a sheet <img> 404s. Sits in
   *  the viewport (not the wrap), so it stays fixed on screen regardless of pan/zoom. */
  _planUnavailableOverlay() {
    return Dom.el('div', { class: 'plan-unavailable', hidden: '' }, Dom.el('div', { class: 'plan-unavailable-card' }, [
      Dom.el('span', { class: 'plan-unavailable-icon', html: Icons.info }),
      Dom.el('div', {}, [
        Dom.el('p', { class: 'plan-unavailable-title' }, 'Floor plan unavailable'),
        Dom.el('p', {}, "This floor's plan image is unavailable — a Site or floor may have been "
          + 'renamed; ask an administrator to re-import.'),
      ]),
    ]));
  }

  /** A sheet image genuinely 404'd (not a manifest miss — the SPA reads floor structure from the
   *  manifest, so this is a missing/renamed image *file*, the same drift HEALTH-5 explains
   *  server-side). Hide the browser's broken-image glyph (the <img> keeps its layout box via its
   *  own inline left/top/width/height, so hiding it visually doesn't disturb the sheet grid) and
   *  reveal the shared overlay — guarded so a second/third broken sheet on a multi-sheet floor
   *  doesn't stack duplicate overlays. */
  _onSheetError(img, buildingDir, floorId, image) {
    img.classList.add('sheet-broken');
    if (!this._planUnavailableEl.hidden) return;
    console.warn('Floor plan image failed to load:', Util.floorKey(buildingDir, floorId), image);
    this._planUnavailableEl.hidden = false;
  }

  // ---- toolbar hooks (assembled by EditorToolbar.build) ----
  // Edit-mode draw/add tools. The room polygon + rectangle pair and Undo come from the base
  // (both editors draw the same way); these are the two tools only a floor has — a wayfinding
  // arrow and a free-standing note. They keep the base's `tb-labeled` "Add …" voice: the text
  // shows when the bar has room and collapses to icon+tooltip when it doesn't.
  _editButtons() {
    const arrowBtn = Dom.el('button', { class: 'tb-labeled', title: 'Add a wayfinding route arrow to a room',
      onclick: () => this.annotations.beginArrow(), html: Icons.arrow + '<span>Add arrow</span>' });
    const noteBtn = Dom.el('button', { class: 'tb-labeled', title: 'Add a free-standing text note',
      onclick: () => this.annotations.beginNote(), html: Icons.note + '<span>Add note</span>' });
    return [...super._editButtons(), arrowBtn, noteBtn];
  }

  /** The floor editor's own bindings on top of the shared engine (UX-17). Three things the
   *  siteplan has no equivalent of: Delete/Backspace removes a selected arrow, note or device
   *  marker (rooms deliberately have no delete-by-key, so that row promises nothing it can't do);
   *  a marker can be rotated/resized by its handles with Alt freeing the angle snap; and the
   *  Escape ladder has extra rungs for the Arrange and Place-racks sub-modes. */
  _shortcutGroups() {
    return super._shortcutGroups().concat([
      { title: 'Arrows, notes & devices', rows: [
        ['Delete / Backspace', 'Delete the selected arrow, note or device marker'],
        ['Drag a marker', 'Move it within its room'],
        ['Alt', 'Hold while rotating a marker to free the angle snap'],
      ] },
      { title: 'Sub-modes', rows: [
        ['Esc', 'Leave Arrange sheets'],
        ['Esc', 'Leave label editing, then deselect, then leave Place racks'],
      ] },
      // Non-colour differentiators for the two states colour alone can't carry to a
      // colour-blind viewer (READ-4): the unbound hatch (style.css `.room.unbound`) and the
      // stale marker's dashed outline (`.rack-marker.stale`) — floor-only, since neither state
      // exists on the siteplan.
      { title: 'Room & marker states', rows: [
        ['Hatched red fill', 'Room with no NetBox Location bound (draw-only — fine unless it needs racks, APs or to-dos)'],
        ['Dashed grey outline', 'Rack/device marker not in the latest inventory sync (stale)'],
      ] },
    ]);
  }
  // Device-placement tools: Add access point (when gated) and the Place-racks sub-mode
  // toggle, grouped into their own section between the align row and the trailing extras.
  _deviceTools() {
    const tools = [];
    // The access-point tool is floor-only by nature — it drops a Device in a *room*, and rooms
    // only exist on floors — so it lives in FloorEditor's own `_deviceTools` hook rather than the
    // shared base. SiteplanEditor has no device tools (the base's empty default applies), so this
    // is not the §10 edit-menu lockstep drift it might otherwise look like.
    // Offered only when every gate the create answers to is already satisfied (the `show:`
    // convention the settings rows follow) — a button that could only ever 403 is never shown.
    // Write mode being off is not a silent dead end: it is the master gate on every NetBox-core
    // write, and the Settings page disables the whole Write add-ons section behind it (SET-5), so
    // an operator sees why the tool is unavailable rather than wondering where it went.
    if (this.app.apTool && this.app.writeMode && this.app.canCreateDevice && this.app.apDeviceRole) {
      tools.push(Dom.el('button', { class: 'tb-labeled', title: 'Add a WiFi access point to a room',
        onclick: () => this.apTool.begin(), html: Icons.wifi + '<span>Add access point</span>' }));
    }
    // Place-racks is a sub-mode of edit: an in-place toggle, not a separate mode/toolbar.
    const racksBtn = Dom.el('button', { class: 'icononly' + (this.placingRacks ? ' active' : ''),
      title: 'Place racks/devices in rooms', html: Icons.rack + '<span>Place racks</span>' });
    racksBtn.onclick = () => this._toggleRacks();
    tools.push(racksBtn);
    return tools;
  }
  // Trailing edit-only tools: Arrange sheets (multi-sheet floors), Copy to floor, and the
  // read-only data overlay (when the floor has one).
  _editExtras() {
    const extra = [];
    if (this.layout && this.layout.cells.length > 1) extra.push(this.arrange.button(), this.toolbar.divider());
    const copyBtn = Dom.el('button', { class: 'tb-labeled', title: 'Copy this floor’s rooms onto another floor',
      onclick: () => this.openCopyFloorPanel(), html: Icons.dup + '<span>Copy to floor…</span>' });
    extra.push(copyBtn);
    const overlayBtn = this._overlayButton();
    if (overlayBtn) extra.push(overlayBtn);
    return extra;
  }
  // View-mode tools: highlight select, the data-overlay toggle (when present), and Export.
  _viewButtons() {
    const hlSel = Dom.el('select', { title: 'Highlight in view mode' });
    [['Highlight: all rooms', 'all'], ['Highlight: rooms with devices', 'placements'], ['Highlight: none', 'none']].forEach(([l, v]) => {
      const o = Dom.el('option', { value: v }, l);
      if (v === this.app.highlight) o.selected = true;
      hlSel.append(o);
    });
    hlSel.onchange = () => { this.app.highlight = hlSel.value; this.render(); };
    // Copy-link sub-tool: an in-place toggle (mirrors Place-racks) that turns the cursor into a copy
    // tool — clicking a room/rack/device copies its shareable deep-link instead of opening NetBox.
    const copyBtn = Dom.el('button', { class: 'icononly' + (this.copyingLink ? ' active' : ''),
      title: 'Copy a link to a room, rack, or device', html: Icons.link + '<span>Copy link</span>' });
    copyBtn.onclick = () => this._toggleCopyLink();
    const exportBtn = Dom.el('button', { class: 'tb-labeled', title: 'Download or print this floor',
      onclick: () => this.openExportPanel(), html: Icons.download + '<span>Export</span>' });
    const view = [hlSel, copyBtn];
    const overlayBtn = this._overlayButton();
    if (overlayBtn) view.push(overlayBtn);
    view.push(exportBtn);
    return view;
  }

  /** Toggle the read-only data-overlay layer (FMT-9). Present only when the floor carries
   *  imported overlay features; mirrors FloorArrange.button's stateful-toggle pattern but repaints
   *  just the overlay layer (it changes no geometry, so no full render()). Returns null when the
   *  floor has no overlays, so the toolbar branches can splice it in conditionally. */
  _overlayButton() {
    if (!(this.floor.overlays && this.floor.overlays.length)) return null;
    // Overlays are placed fit-to-bounds, not georeferenced (see preprocess `unit_projector`), so
    // flag the approximate alignment on the toggle for a viewer who wasn't the importer. Driven by
    // the manifest `georeferenced` flag; an overlay predating it (field absent) reads as approximate.
    const approx = this.floor.overlays.some(ov => ov.georeferenced !== true);
    const title = 'Show or hide the data overlay'
      + (approx ? ' (aligned by fitting to the frame — approximate, not georeferenced)' : '');
    const b = Dom.el('button', { class: 'icononly' + (this.showOverlays ? ' active' : ''),
      title, html: Icons.layers + '<span>Overlay</span>' });
    b.onclick = () => {
      this.showOverlays = !this.showOverlays;
      b.classList.toggle('active', this.showOverlays);
      this.renderOverlays();
    };
    return b;
  }

  /** Edit ⇄ view runs through the shared in-place `Editor._switchMode` (rebuild toolbar +
   *  re-`render()` the existing `.map-wrap`, so the live PanZoom survives). The one
   *  exception is **Arrange** — a mutually-exclusive edit sub-mode whose padded canvas must
   *  un-pad — so leaving it routes through a full `show()` relayout instead. */
  _switchMode(mode) {
    if (this.arranging) {
      this.arranging = false; this.placingRacks = false; this.app.mode = mode; this.show(); return;
    }
    super._switchMode(mode);
  }
  _setEditing(on) { this.app.mode = on ? 'edit' : 'view'; }
  /** The two armed sub-modes that hijack a room/marker click (UX-16): the toolbar's `.active`
   *  button tint alone is easy to miss once attention is on the map, so `Editor.render()`
   *  keeps this synced into the persistent `.mode-banner` on every render. */
  _armedModeText() {
    if (this.placingRacks) return 'Place racks — click a room to open its rack panel · click the toolbar button to exit';
    if (this.copyingLink) return 'Copy link — click a room, rack, or device to copy its link';
    return null;
  }
  /** Beyond the base state reset: leaving/re-entering edit exits the Place-racks sub-mode
   *  and drops the floor-specific selections; entering view warms the placement inventory. */
  _onModeSwitch(mode) {
    this.placingRacks = false;
    this.copyingLink = false;   // the view-only copy-link tool never carries across a mode switch
    this.selectedArrow = null; this.selectedNote = null; this.selectedPlacement = null;
    this.rackRoom = null;
    this.todoAdd.clearHover();   // the rooms are about to be rebuilt (TASK-4)
    if (mode === 'view') this.placements.ensureInventory();
  }

  /** Toggle the Place-racks sub-mode within edit mode (see `_switchMode` for the in-place
   *  rebuild rationale). Turning it ON while a room is already selected keeps that selection
   *  (edit persists) and opens the room's rack panel immediately — no re-click. Turning it
   *  OFF closes the rack panel and drops back to plain edit. Arrange is a mutually-exclusive
   *  edit sub-mode whose padded canvas must un-pad, so leaving it routes through `show()`. */
  _toggleRacks() {
    this.annotations.endNoteEdit();   // leaving plain edit for racks ends any in-progress note edit
    if (this.arranging) {
      this.arranging = false; this.placingRacks = true;
      this.selectedPlacement = null; this.rackRoom = null;
      this.show(); this.placements.ensureInventory();
      return;
    }
    this.placingRacks = !this.placingRacks;
    this.selectedPlacement = null; this.editingLabel = null;
    if (this.placingRacks) {
      const room = (this.selected != null && this.data().rooms.find(r => r.id === this.selected)) || null;
      this.rackRoom = room;
      this.app.setToolbar(this.toolbar.build());
      this.render();
      this.placements.ensureInventory();
      if (room) this.placements.openRackPanel(room);
    } else {
      this.rackRoom = null;
      this._switchingMode = true; this.app.closePanel(); this._switchingMode = false;
      this.app.setToolbar(this.toolbar.build());
      this.render();
    }
  }

  /** Toggle the Copy-link sub-tool within view mode (NAV-10). An in-place toggle like Place-racks:
   *  flip the flag, rebuild the toolbar (so the button de/activates), and re-render so the room
   *  click-zones and placement markers pick up the copy cursor + copy-on-click behaviour. No panel
   *  or inventory to manage — a successful copy turns the tool back off (`_copyTargetLink`). */
  _toggleCopyLink() {
    this.copyingLink = !this.copyingLink;
    this.app.setToolbar(this.toolbar.build());
    this.render();
  }

  /** Build and copy a shareable deep-link (#/r/<dir>/<fid>/<seg>) to a view-mode click target and,
   *  on success, drop the copy tool. A room uses its bound Location slug (stable, human-readable),
   *  falling back to the room uid when unbound; a rack/device has no slug, so its segment is the
   *  opaque `<kind>-<id>` (numeric NetBox id), resolved against placements by `_resolveFocusSeg`.
   *  The link routes through `App._hash`, so it carries the `#/y/<facility>` prefix and resolves in
   *  a fresh tab. Degrades to a toast of the URL if the clipboard API is unavailable (e.g. non-HTTPS),
   *  leaving the tool on so the click can be retried. */
  async _copyTargetLink(kind, target) {
    const seg = kind === 'room'
      ? ((target.location && target.location.slug) ? target.location.slug : target.id)
      : kind + '-' + target.id;
    const url = location.origin + location.pathname + '#' + this.app._hash(
      '/r/' + encodeURIComponent(this.building.dir) + '/'
      + encodeURIComponent(this.floor.id) + '/' + encodeURIComponent(seg));
    try {
      await navigator.clipboard.writeText(url);
      Toast.show('Link copied');
      this._toggleCopyLink();
    } catch (e) {
      console.warn('Clipboard unavailable', e);
      Toast.show('Copy failed. Link: ' + url, true);
    }
  }

  /** Persist all three categories together (not just the current mode's), so a single
   *  click always clears the badge above — matching what the badge now shows. The
   *  try/catch, badge refresh and toast are the shared `Editor.save`. */
  _persist() {
    return Promise.all([this.store.saveAnnotations(), this.store.saveLayouts(), this.store.savePlacements()]);
  }


  // ---- rendering ----
  // The snapping grid is suppressed while arranging sheets (that mode paints its own
  // sheet-cell grid instead); gridActive() still gates it to edit/racks modes.
  _showGrid() { return !this.arranging; }

  /** Static layer: the catcher, sheet captions, and every non-selected shape (rooms,
   *  arrows, placement markers) with their labels. The selected shape + draft render
   *  live in the active layer. Arrange mode paints its whole (small) UI here. */
  _renderStatic(s, W, H) {
    const editing = this.editing();
    const racks = this.placingRacks;
    const arranging = editing && this.arranging;
    this.shapes.addCatcher(s, W, H);
    if (arranging) { this.arrange.draw(s, W, H); return; }
    this.arrange.drawCaptions(s, W, H);

    // Rooms holding rack/device markers (a placement needs a bound Location to draw),
    // used to highlight them in view mode.
    const placedRooms = new Set(
      this.store.placementData(this.building.dir, this.floor.id).placements.map(p => p.room));
    // View-mode room outlines are collected into one reduced-opacity group so a shared wall
    // draws a single uniform-weight line instead of two translucent strokes compounding
    // darker (VIEW-1). Only view mode adds the `.view` outline, so the group is view-only.
    const outlineGroup = editing ? null : Dom.svg('g', { class: 'room-view-outlines' });
    // Punch each room's contained smaller rooms out of its fill (evenodd <path> in _drawRoom) so a
    // larger room's highlight/hover no longer double-paints over a room nested inside it — the same
    // render-time containment subtraction the NetBox embeds use (ROOM-1/ROOM-2). Computed once per
    // full render over the whole floor (O(n²)); both draw layers read it, and per-frame drags reuse
    // the last value (renderActive doesn't recompute — a drop fires a full render to correct it).
    this._containedRings = Geom.containedMap(this.data().rooms);
    for (const room of this.data().rooms) {
      // In plain edit the selected room is promoted to the active layer (its editable
      // vertices must never be occluded). While placing racks the room has no vertices,
      // so it stays here in the static layer — drawn BEFORE drawPlacements below, its own
      // rack markers therefore sit above its fill and a marker click isn't swallowed by
      // the room polygon.
      if (editing && !racks && room.id === this.selected) continue;   // selected room → active layer
      this._drawRoom(s, room, W, H, placedRooms, editing, racks, outlineGroup);
    }
    // Appended after the fills so every outline paints atop them (an adjacent room's
    // translucent fill can't occlude a shared edge).
    if (outlineGroup && outlineGroup.childElementCount) s.append(outlineGroup);
    if (!racks) this.annotations.drawArrows(s, W, H, true);   // non-selected wayfinding routes (edit + view)
    // Markers draw in every mode that reaches here (arrange returned above): view, racks, and
    // plain edit (inert reference glyphs). The selected room's markers are skipped in plain edit
    // (drawPlacements draws them in the active layer instead — see _renderActive).
    this.placements.drawPlacements(s, W, H, true);
    // Free-standing text notes sit on top (topmost static content) so they stay legible;
    // suppressed while placing racks, matching wayfinding arrows.
    if (!racks) this.annotations.drawNotes(s, W, H, true);
  }

  /** Active layer: the selected shape drawn live (reshaping room / arrow / marker with
   *  its editable vertices/handles) plus the draft. Rebuilt on every drag frame so the
   *  static shapes below are left untouched. At most one shape is selected per mode. */
  _renderActive(s, W, H) {
    const editing = this.editing();
    const racks = this.placingRacks;
    if (editing && this.arranging) return;   // arrange has no live overlay

    // The hovered room's "add a to-do" + (TASK-4). It rides this layer — which view mode otherwise
    // leaves empty — because it is transient chrome that must sit above every room and repaint on
    // its own, without disturbing the static layer. `FloorTodoAdd.draw` no-ops outside view mode.
    this.todoAdd.draw(s, W, H);

    // Room-geometry editing is a plain-edit affordance only: while placing racks the
    // selected room draws in the static layer (above) with no editable vertices, so its
    // shape can't be reshaped and marker clicks aren't swallowed by a promoted room fill.
    if (editing && !racks && this.selected != null) {
      const room = this.data().rooms.find(r => r.id === this.selected);
      if (room) {
        const placedRooms = new Set(
          this.store.placementData(this.building.dir, this.floor.id).placements.map(p => p.room));
        const poly = this._drawRoom(s, room, W, H, placedRooms, editing, racks);
        // Grab-and-drag the selected room (CAD-style): a press near a side drags that whole
        // edge (both its endpoints), a press deeper in the body translates every vertex by the
        // same delta. Wired only here (the active-layer, plain-edit selected room), so
        // non-selected and racks-mode rooms stay non-draggable. Vertices/midpoints are drawn
        // AFTER this, so they sit on top — pressing a node still starts a vertex reshape or
        // add-node, not an edge/body move.
        // Differentiate the cursor by hover target (CAD-style) so the user can tell
        // *before pressing* what a drag will do: a resize cursor over a side (edge grab),
        // `move` deeper in the body (whole-room translate). The vertex/midpoint circles are
        // drawn after this with their own CSS cursors, so hovering a node still reads move/copy.
        // Skipped during a drag: the svg captures the pointer then, so this never fires.
        poly.style.cursor = 'move';
        poly.addEventListener('pointermove', (e) => {
          const i = this.pointer.edgeHit(e, room.polygon);
          poly.style.cursor = i >= 0 ? this.pointer.edgeCursor(room.polygon, i) : 'move';
        });
        poly.addEventListener('pointerdown', (e) => this._onRoomBodyPress(e, room));
        // No centroid label is drawn (the floor-plan images already carry the printed
        // room names/numbers); the selected room just gets its editable vertices.
        this.shapes.drawVertices(s, room.polygon, W, H, room.id, () => this.markDirty());
        // The selected room's rack/device markers ride the active layer (drawn after the
        // room fill + vertices) so they (a) stay visible above the promoted room's fill and
        // (b) repaint per frame when the room is dragged (_startRoomDrag translates them too).
        // They are interactive here (grabbable, see _drawPlacement) and sit above the room, so a
        // press ON a marker grabs the rack while a press elsewhere reaches the room beneath —
        // clicking one selects it, which clears `this.selected` and re-renders into the
        // selected-placement path below. drawPlacements skips them in the static layer.
        this.placements.drawRoomPlacements(s, room, W, H);
      }
    }
    if (editing && this.selectedArrow) this.annotations.drawArrow(s, this.selectedArrow, W, H, editing);
    // The note being label-edited draws here so its label drag/handles repaint per frame.
    // Like the selected arrow, it shows even in racks mode (only *non-selected* notes are
    // decluttered there); non-edited notes live in the static layer, gated by `!racks`.
    if (editing && this.selectedNote) this.annotations.drawNote(s, this.selectedNote, W, H);
    this.shapes.drawDraft(s, W, H);
    // The selected marker draws into the active layer (always on top, with its handles). This
    // fires in racks mode and in plain-edit rack selection — where selecting a rack cleared
    // `this.selected`, so no room is promoted above and drawPlacements (skipSelected) leaves
    // this one for here, exactly the racks-mode topology (no double-draw).
    if (this.editing() && this.selectedPlacement) {
      const roomById = {};
      for (const r of this.data().rooms) roomById[r.id] = r;
      this.placements.drawPlacement(s, this.selectedPlacement, W, H, roomById);
    }
  }

  /** Overlay layer: the floor's imported data overlays (FMT-9), drawn read-only over the plan.
   *  Features are normalized 0..1 over the same combined canvas rooms use, so they ride the
   *  pan/zoom transform like every other shape. The layer is pointer-transparent (style.css), so
   *  nothing here is selectable and it never marks the store dirty. */
  _renderOverlays(s, W, H) {
    if (!this.showOverlays || !this.floor.overlays) return;
    for (const ov of this.floor.overlays)
      for (const feat of (ov.features || [])) this._drawFeature(s, ov, feat, W, H);
  }

  /** Draw one overlay feature: a point as a small circle, a line as a polyline, a polygon as an
   *  outline. Coords are 0..1 -> layout px. A `<title>` from the feature's props gives hover
   *  detail. Unknown geometry types are skipped (forward-compatible with richer sources). */
  _drawFeature(s, ov, feat, W, H) {
    let el;
    if (feat.type === 'point') {
      const [nx, ny] = feat.coords;
      el = Dom.svg('circle', { cx: nx * W, cy: ny * H, r: 4, class: 'fm-overlay-point' });
    } else if (feat.type === 'line') {
      el = Dom.svg('polyline', { points: this._featurePts(feat.coords, W, H), class: 'fm-overlay-line' });
    } else if (feat.type === 'polygon') {
      el = Dom.svg('polygon', { points: this._featurePts(feat.coords, W, H), class: 'fm-overlay-polygon' });
    } else {
      return;
    }
    const label = this._featureTitle(ov, feat);
    if (label) { const t = Dom.svg('title'); t.textContent = label; el.append(t); }
    s.append(el);
  }

  _featurePts(coords, W, H) { return coords.map(p => `${p[0] * W},${p[1] * H}`).join(' '); }

  /** Hover text for an overlay feature: the overlay's name plus a short summary of its source
   *  properties (first few key: value pairs). */
  _featureTitle(ov, feat) {
    const props = feat.props || {};
    const detail = Object.keys(props).slice(0, 4).map(k => `${k}: ${props[k]}`).join(' · ');
    return [ov.name, detail].filter(Boolean).join(' · ');
  }

  /** `<defs>` for the map svg: currently just the diagonal hatch `.room.unbound` fills with
   *  (READ-4) — a non-colour differentiator so the unbound state (red, `style.css`) doesn't
   *  read as "just another colour" next to `.room`'s bound green, the classic red/green
   *  colour-blind confusion pair. Sized in the same layout-px space as the room polygons
   *  (`patternUnits="userSpaceOnUse"`), so it rides the shared pan/zoom CSS transform in
   *  lockstep with everything else rather than scaling independently. Rebuilt fresh with `s`
   *  on every `show()` — cheap, and keeps this free of any cross-mount stale-id risk. */
  _hatchDefs() {
    const defs = Dom.svg('defs');
    const hatch = Dom.svg('pattern', { id: 'fm-hatch-unbound', width: 8, height: 8,
      patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    hatch.append(Dom.svg('rect', { width: 8, height: 8, class: 'fm-hatch-bg' }));
    hatch.append(Dom.svg('line', { x1: 0, y1: 0, x2: 0, y2: 8, class: 'fm-hatch-line' }));
    defs.append(hatch);
    return defs;
  }

  /** Draw one room polygon into `s`, styled per mode (invisible click-zone in view
   *  unless highlighted; room/selected/placed/unbound in edit/racks). Shared by the
   *  static loop and the active-layer draw of the selected room — the `.selected` class
   *  keys off `this.selected`, so it lights up only for the selected room either way. */
  _drawRoom(s, room, W, H, placedRooms, editing, racks, outlineGroup) {
    const placed = placedRooms.has(room.id) && !!room.location;
    const focused = room.id === this._focusRoomId;   // focus target (search jump or #/r/ deep-link)
    const pts = room.polygon.map(p => `${p[0] * W},${p[1] * H}`).join(' ');
    // A keyhole room (outer boundary + a slit looping around an interior void) is one
    // self-touching ring; splitBridges peels it into [outer, void] contours (a plain room
    // returns the ring unchanged). `holed` drives the evenodd fill (void renders empty) and
    // the per-contour view outline (the doubled slit seam vanishes) below.
    const contours = Geom.splitBridges(room.polygon);
    const holed = contours.length > 1;
    // Racks mode draws every room as a clickable target. View mode keeps rooms as
    // invisible click-zones, except those highlighted: 'all' draws every room,
    // 'placements' draws only rooms holding markers. A focus target is always
    // drawn (and pulsed) so the jump lands on a visible room in any highlight mode.
    const showShape = editing || racks || focused || this.app.highlight === 'all'
      || (placed && this.app.highlight === 'placements');
    let cls;
    let viewOutline = false;
    if (!showShape) cls = 'clickzone';
    else {
      cls = 'room';
      if (placed) cls += ' placed';
      if (editing && room.id === this.selected) cls += ' selected';
      if (editing && !room.location) cls += ' unbound';
      if (focused) cls += ' focus';
      // View-mode-only marker: highlighted rooms get a translucent outline (style.css).
      // The interactive polygon carries only its fill; its stroke is drawn once into the
      // reduced-opacity outline group below, so a shared wall reads as one uniform line
      // (VIEW-1). Skipped while focused so the transient focus pulse owns the stroke; a
      // re-render adds it back when the pulse fades.
      else if (!editing) { cls += ' view'; viewOutline = true; }
    }
    // Any smaller room drawn fully inside this one is punched out of its fill so the highlight/hover
    // no longer double-paints over it (ROOM-2, matching the embed). Only for a visible fill — an
    // invisible `.clickzone` keeps its flat polygon so hit-testing is unchanged; the child punch-out
    // is a paint concern, not a hit one. Combined under evenodd with any keyhole void below, so a
    // room can carry both a void cut and a contained-child cut at once.
    const childRings = cls === 'clickzone' ? [] : ((this._containedRings && this._containedRings.get(room.id)) || []);
    // A holed (keyhole) room or one with contained children draws as an evenodd <path>: the raw
    // self-touching ring empties its void by crossing parity (regardless of which way the user
    // looped it, identical to nonzero for a plain ring), and each child ring punches out its area.
    // Both interiors then stop painting, so they also drop out of hit-testing — clicking the
    // courtyard, or a contained room's footprint, isn't this room. A plain room with neither stays
    // a flat <polygon>, byte-for-byte as before.
    const punched = holed || childRings.length > 0;
    const poly = punched
      ? Dom.svg('path', { d: Geom.evenoddPath([room.polygon, ...childRings], W, H), class: cls })
      : Dom.svg('polygon', { points: pts, class: cls });
    if (punched) poly.setAttribute('fill-rule', 'evenodd');
    if (cls === 'clickzone') poly.style.pointerEvents = 'all';
    // The view-mode copy-link tool turns every room into a copy target — the cursor advertises it.
    if (this.copyingLink && !editing) poly.style.cursor = 'copy';
    const title = Dom.svg('title');
    title.textContent = (room.label || '(unnamed)') + (placed ? ' (has devices)' : '');
    poly.append(title);
    poly.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.pointer.gestureClick()) return;   // pan/pinch tail, not a tap (MOBILE-2)
      if (this.draft) return;
      this.annotations.endNoteEdit();   // selecting a room ends any in-progress note edit
      // While placing racks (a sub-mode of edit, so `editing` is also true) a room click
      // opens its rack panel; racks therefore takes precedence over the plain-edit bind panel.
      if (racks) { this.selected = room.id; this.selectedPlacement = null; this.rackRoom = room; this.render(); this.placements.openRackPanel(room); }
      else if (editing) { this.selected = room.id; this.selectedPlacement = null; this.render(); this.openRoomPanel(room); }
      else if (this.copyingLink) this._copyTargetLink('room', room);
      else if (room.location) window.open(room.location.url, '_blank');
    });
    this.todoAdd.wireHover(poly, room, editing);
    s.append(poly);
    // The view outline is a stroke-only clone drawn into the shared reduced-opacity group
    // (opaque stroke there → seamless single-weight line where two rooms share a wall). The
    // group is pointer-transparent, so clicks/hover still land on the fill polygon above.
    if (outlineGroup && viewOutline) {
      const outlineCls = 'room-outline' + (placed ? ' placed' : '');
      // One outline per contour: a plain room strokes its single ring exactly as before (so the
      // cross-room shared-wall merge is unchanged); a keyhole room strokes its outer boundary and
      // its void boundary separately, and never the dropped slit — so the doubled seam vanishes.
      for (const contour of contours) {
        outlineGroup.append(Dom.svg('polygon',
          { points: contour.map(p => `${p[0] * W},${p[1] * H}`).join(' '), class: outlineCls }));
      }
    }
    return poly;
  }


  /** Whole-room translate (CAD-style): press inside the selected room and drag to move
   *  every vertex by the same delta; drop commits. Rides the shared `Editor.dragItem`
   *  channel (like the label/rack-marker whole-shape drags) rather than a bespoke slot, so
   *  it inherits the 4px drag threshold (a plain select-click moves nothing and stays
   *  clean), the pre-drag undo snapshot pushed on `pointerup` only when it moved, and
   *  `_suppressClick` on drop — none of which needs a change to the base pointer cascade.
   *  The translation *delta* is snapped to a grid multiple (offset 0 — quantizing a
   *  displacement, not a position), so an on-grid room stays on-grid: every vertex shifts
   *  by the same whole-cell offset and the shape moves without distortion (each vertex is
   *  not snapped independently);
   *  Alt frees the drag, and it is a no-op when the grid toggle is off. The delta is then
   *  clamped so the polygon's bounding box stays within [0,1] — clamping each vertex
   *  independently would distort the shape once one vertex hit an edge. `base` holds the
   *  pre-drag vertices so every frame translates from the original press, never drifts. */
  _startRoomDrag(e, room) {
    if (e.button !== 0 || this.draft) return;
    e.stopPropagation();
    const [gx, gy] = this.evtNorm(e);
    const base = room.polygon.map(p => [p[0], p[1]]);
    const b = Geom.bounds(base);
    // Rack/device markers live in the same normalized space but are stored independently of
    // the room polygon, so they don't follow it on their own — translate them by the same
    // delta. Clone each pre-drag centre so every frame shifts from the original press (no
    // per-frame rounding drift), mirroring the polygon's own "translate from a clone" rule.
    // The delta is already clamped to keep the room inside [0,1] and the markers are clamped
    // inside the room, so the shared delta keeps them in-bounds too.
    const placements = this.store.placementData(this.building.dir, this.floor.id).placements
      .filter(p => p.room === room.id);
    const pbase = placements.map(p => [p.x, p.y]);
    this.dragItem = { move: (nx, ny, ev) => {
      let dx = nx - gx, dy = ny - gy;   // raw displacement from the press point
      if (this.grid.on && !(ev && ev.altKey)) {
        // Quantize the *delta* to a grid multiple (offset 0 — this snaps a
        // displacement, not a position), so an on-grid room stays on-grid: the
        // whole shape shifts by a whole number of cells.
        const [iw, ih] = this.dims;
        dx = this.grid.snap(dx * iw, 0) / iw;
        dy = this.grid.snap(dy * ih, 0) / ih;
      }
      dx = Math.max(-b.minX, Math.min(1 - b.maxX, dx));   // clamp after snap (safety net at a [0,1] edge)
      dy = Math.max(-b.minY, Math.min(1 - b.maxY, dy));
      room.polygon = base.map(([x, y]) => [+(x + dx).toFixed(5), +(y + dy).toFixed(5)]);
      placements.forEach((p, i) => {
        p.x = +(pbase[i][0] + dx).toFixed(5);
        p.y = +(pbase[i][1] + dy).toFixed(5);
      });
      this.markDirty();
      if (placements.length) this.markPlacementsDirty();
      this.renderActive();
    } };
    this.svg.setPointerCapture(e.pointerId);
  }

  /** A press on the selected room's body (not on a node — the vertex/midpoint circles
   *  stopPropagation, so those never reach here): a press within the grab band of a side
   *  drags that whole edge, anything deeper translates the whole room. `EditorPointer.edgeHit`
   *  does the zoom-invariant edge hit-test; both starters own their stopPropagation +
   *  pointer capture, so this only picks the channel. */
  _onRoomBodyPress(e, room) {
    if (e.button !== 0 || this.draft) return;
    const i = this.pointer.edgeHit(e, room.polygon);
    if (i >= 0) this._startEdgeDrag(e, room, i);
    else this._startRoomDrag(e, room);
  }

  /** Edge drag (CAD-style "move a wall"): grab a polygon side and drag to translate BOTH its
   *  endpoints by one delta, resizing the room while the adjacent edges follow. Rides the
   *  shared `Editor.dragEdge` channel (parallel to dragVertex/dragItem) so it inherits the 4px
   *  drag threshold (a plain select-click moves nothing and stays clean), the pre-drag undo
   *  snapshot pushed on `pointerup` only when it moved, and `_suppressClick` on drop — none of
   *  which needs a change to the base pointer cascade. Like `_startRoomDrag` the *delta* is
   *  snapped to a grid multiple (offset 0 — a displacement, not a position) and applied to
   *  both endpoints (each vertex is NOT snapped independently, which would distort the edge),
   *  so a near-axis drag rounds the perpendicular delta to 0 and the edge stays grid-aligned;
   *  the delta is clamped so both moved endpoints stay within [0,1]. Alt frees the
   *  grid snap, and it is a no-op when the grid toggle is off. `a0`/`b0` hold the pre-drag
   *  endpoints so every frame translates from the original press and never drifts. */
  _startEdgeDrag(e, room, i) {
    if (e.button !== 0 || this.draft) return;
    e.stopPropagation();
    const n = room.polygon.length, j = (i + 1) % n;
    const [gx, gy] = this.evtNorm(e);
    const a0 = room.polygon[i].slice(), b0 = room.polygon[j].slice();
    const minX = Math.min(a0[0], b0[0]), maxX = Math.max(a0[0], b0[0]);
    const minY = Math.min(a0[1], b0[1]), maxY = Math.max(a0[1], b0[1]);
    this.dragEdge = { move: (nx, ny, ev) => {
      let dx = nx - gx, dy = ny - gy;   // raw displacement from the press point
      if (this.grid.on && !(ev && ev.altKey)) {
        // Quantize the *delta* to a grid multiple (offset 0 — this snaps a
        // displacement, not a position), so on-grid endpoints stay on-grid and a
        // near-axis drag rounds the perpendicular delta to 0 (no shear).
        const [iw, ih] = this.dims;
        dx = this.grid.snap(dx * iw, 0) / iw;
        dy = this.grid.snap(dy * ih, 0) / ih;
      }
      dx = Math.max(-minX, Math.min(1 - maxX, dx));   // clamp after snap (safety net at a [0,1] edge)
      dy = Math.max(-minY, Math.min(1 - maxY, dy));
      room.polygon[i] = [+(a0[0] + dx).toFixed(5), +(a0[1] + dy).toFixed(5)];
      room.polygon[j] = [+(b0[0] + dx).toFixed(5), +(b0[1] + dy).toFixed(5)];
      this.markDirty(); this.renderActive();
    } };
    this.svg.setPointerCapture(e.pointerId);
  }




  // ---- drawing actions ----
  /** Drawing always clears the selected arrow/note (starting a room, arrow or note). */
  beginDraw(msg, kind) { this.selectedArrow = null; this.selectedNote = null; super.beginDraw(msg, kind); }

  /** The floor's extra draft kinds finish differently; a room polygon defers to the shared
   *  base implementation (which the rectangle tool and Duplicate also run through). */
  finish() {
    // A single-point tool has nothing to commit until its click has landed — but Enter can reach
    // finish() first, while the draft is still empty (its finisher would read points[0] of
    // nothing). Cancel the draft instead, as Enter already does for an under-full polygon.
    if (SINGLE_POINT_KINDS.has(this.draft.kind) && !this.draft.points.length) {
      this.draft = null; this.render(); return;
    }
    if (this.draft.kind === 'arrow') return this.annotations.finishArrow();
    if (this.draft.kind === 'note') return this.annotations.finishNote();
    if (this.draft.kind === 'ap') return this.apTool.finish();
    super.finish();
  }

  // ---- the shape seam (Editor's shared create path) ----
  // A "shape" here is a room. Drawing, the rectangle tool and Duplicate all run off these
  // hooks on the base (§10 *Edit-menu lockstep*).
  _newShape(poly) {
    const room = { id: Util.uid(), label: '', polygon: poly, location: null };
    this.data().rooms.push(room);
    return room;
  }
  _openShapePanel(room) { this.openRoomPanel(room); }
  _shapeTerms() { return { noun: 'room', drawLabel: 'Add room area' }; }
  /** A new room joins the to-do panel's room list like any other room mutation does. */
  _afterShapeAdded() { this.todo && this.todo.syncRooms(this.data().rooms); }


  /** Download/print the current floor (plan sheets + room polygons + placement markers +
   *  wayfinding arrows/labels). Reuses the shared side panel; the serialization engine is
   *  FloorExport. Print hands off to the browser's print dialog (see the @media print
   *  rules in style.css). */
  openExportPanel() {
    const panel = Dom.$('#panel'); panel.classList.remove('hidden');
    Dom.$('#panel-title').textContent = 'Export floor';
    const body = Dom.$('#panel-body'); body.innerHTML = '';

    const exporter = new FloorExport(this);
    body.append(Dom.el('div', { class: 'hint' },
      'Save the annotated floor to share or tape up: plan, rooms, racks, and route arrows.'));
    body.append(Dom.el('button', { class: 'wide', title: 'Download this floor as a PNG image', onclick: () => exporter.downloadPng(),
      html: Icons.download + '<span>Download PNG</span>' }));
    body.append(Dom.el('button', { class: 'wide', title: 'Download this floor as an SVG vector file', onclick: () => exporter.downloadSvg(),
      html: Icons.download + '<span>Download SVG</span>' }));
    body.append(Dom.el('button', { class: 'wide', title: 'Open the browser print dialog for this floor', onclick: () => window.print(),
      html: Icons.print + '<span>Print…</span>' }));
  }


  deleteRoom(room) {
    this.snapshot();
    const rooms = this.data().rooms;
    const i = rooms.indexOf(room);
    if (i >= 0) rooms.splice(i, 1);
    this.selected = null; this.markDirty();
    this.todo && this.todo.syncRooms(this.data().rooms);
    this.render(); this.app.closePanel();
    this._deleteToast('Room deleted');
  }

  /** Panel to copy this floor's rooms onto another floor of the same building. Buildings
   *  often have identical floor plates, so this saves re-digitizing them — but because
   *  coordinates are normalized to the plan image, the copies only line up when the target
   *  floor shares the source's aspect/plate, so a mismatched target is flagged. */
  openCopyFloorPanel() {
    const panel = Dom.$('#panel'); panel.classList.remove('hidden');
    Dom.$('#panel-title').textContent = 'Copy rooms to floor';
    const body = Dom.$('#panel-body'); body.innerHTML = '';

    const rooms = this.data().rooms;
    if (!rooms.length) { body.append(Dom.el('div', { class: 'hint' }, 'This floor has no rooms to copy.')); return; }

    body.append(Dom.el('div', { class: 'hint' },
      'Rooms are copied as UNBOUND polygons (no NetBox Location, fresh ids). Coordinates are '
      + 'normalized to the plan image, so they land correctly only on a floor with the same '
      + 'plate/aspect. Copies save with this floor’s next Save (and can be undone with Ctrl+Z).'));

    // Scope: all rooms, or just the currently-selected one (offered only when one is selected).
    const sel = this.selected && rooms.find(r => r.id === this.selected);
    const scopeSel = Dom.el('select');
    scopeSel.append(Dom.el('option', { value: 'all' }, 'All rooms on this floor (' + rooms.length + ')'));
    if (sel) scopeSel.append(Dom.el('option', { value: 'selected' }, 'Only the selected room'));
    body.append(Dom.el('div', { class: 'field' }, [Dom.el('label', {}, 'Copy'), scopeSel]));

    const targets = this.building.floors.filter(f => f.id !== this.floor.id);
    if (!targets.length) { body.append(Dom.el('div', { class: 'hint' }, 'This building has no other floors.')); return; }

    const srcGeom = this.store.floorLayout(this.building.dir, this.floor.id);
    const srcAspect = srcGeom.W / srcGeom.H;
    body.append(Dom.el('div', { class: 'hint' }, 'Copy to:'));
    const list = Dom.el('div', {});
    targets.forEach(f => {
      const geom = this.store.floorLayout(this.building.dir, f.id);
      const mismatch = Math.abs(geom.W / geom.H - srcAspect) > ASPECT_MISMATCH_TOLERANCE;
      const item = Dom.el('div', { class: 'room-item' }, [
        Dom.el('div', { class: 'nm' }, f.label + (mismatch ? '  ⚠' : '')),
        Dom.el('div', { class: 'sl' }, mismatch ? 'different plate; rooms may not line up' : 'same plate'),
      ]);
      item.onclick = () => this.copyRoomsToFloor(f, scopeSel.value);
      list.append(item);
    });
    body.append(list);
  }

  /** Write copies of the chosen rooms into the target floor's store as unbound rooms with
   *  fresh ids. Cross-floor, so it's saved through the normal facility-wide annotations
   *  path (store.dirty). Undoable: the snapshot rides an `extraFloor` payload carrying the
   *  target floor's pre-copy rooms, which _applySnapshot reverts (the current floor is
   *  unchanged by the copy, so its half of the snapshot is a harmless identity restore). */
  copyRoomsToFloor(targetFloor, scope) {
    const rooms = this.data().rooms;
    const src = scope === 'selected' ? rooms.filter(r => r.id === this.selected) : rooms;
    if (!src.length) { Toast.show('Nothing to copy'); return; }
    const dest = this.store.floorData(this.building.dir, targetFloor.id);
    const snap = this._snapshotState();
    snap.extraFloor = { key: Util.floorKey(this.building.dir, targetFloor.id),
      rooms: this._clone(dest.rooms) };
    this.history.push(snap);
    for (const r of src)
      dest.rooms.push({ id: Util.uid(), label: '', polygon: r.polygon.map(p => [p[0], p[1]]), location: null });
    this.markDirty();
    Toast.show('Copied ' + src.length + ' room' + (src.length === 1 ? '' : 's')
      + ' to ' + targetFloor.label + ' (unbound). Save to keep.');
    this.app.closePanel();
  }


  // ---- NetBox binding panel ----
  async loadNbRooms() {
    const key = Util.floorKey(this.building.dir, this.floor.id);
    if (this.store.nbRoomsByFloor[key]) return this.store.nbRoomsByFloor[key];
    try {
      const res = await this.netbox.rooms(this.building.siteSlug, this.floor.id);
      if (this.app.current !== this) return { rooms: [] };   // navigated away mid-fetch; caller shouldn't act on a torn-down editor
      this.store.nbRoomsByFloor[key] = res;
      return res;
    } catch (e) { Toast.show('NetBox: ' + e.message, true); return { rooms: [] }; }
  }

  async openRoomPanel(room) {
    const panel = Dom.$('#panel'); panel.classList.remove('hidden');
    Dom.$('#panel-title').textContent = room.label || 'Bind room';
    const body = Dom.$('#panel-body'); body.innerHTML = '';

    body.append(Dom.el('div', { class: 'field' }, [
      Dom.el('label', {}, 'Selected polygon'),
      Dom.el('div', { class: 'val' }, room.location ? room.location.name : '(draw-only — no Location)'),
      room.location ? Dom.el('div', {}, Dom.el('a', { href: room.location.url, target: '_blank' }, 'open in NetBox ↗')) : null,
    ]));
    body.append(Dom.el('div', { class: 'row' }, [
      // Unbind drops the Location but **keeps the name** (DOC-12): a draw-only room is a supported
      // state, and clearing `label` here left it permanently nameless — the field below is the only
      // way to name one, so wiping it on unbind would undo the user's own text.
      Dom.el('button', { onclick: () => { this.snapshot(); room.location = null; this.markDirty();
        this.todo && this.todo.syncRooms(this.data().rooms);
        this.render(); this.openRoomPanel(room); } }, 'Unbind'),
      Dom.el('button', { class: 'danger', onclick: () => this.deleteRoom(room) }, 'Delete'),
    ]));

    body.append(this.toolbar.duplicateButton(room));

    // The room's name (DOC-12). Binding prefills this from the Location's name, but it is a plain
    // editable field either way — a **draw-only** room (one this install never modelled as a
    // `dcim.Location`) has no other way to be named, and would otherwise read as "(unbound)"
    // everywhere. Like `alias` it is never drawn on the plan (floor rooms stay unlabelled, §10):
    // it names the room in this panel, the polygon tooltip, the wayfinding finder, and REST.
    const labelBox = Dom.el('input', { class: 'label-ctl', placeholder: 'e.g. Server Room' });
    labelBox.value = room.label || '';
    labelBox.onfocus = () => this.snapshot();   // one undo boundary per edit session
    labelBox.oninput = () => { room.label = labelBox.value; this.markDirty(); };
    // The to-do panel groups by room *name*, so it has to follow a rename — but on `change`
    // (commit), not `input`: `syncRooms` rebuilds the panel, and doing that per keystroke would
    // thrash it for no gain.
    labelBox.onchange = () => { this.todo && this.todo.syncRooms(this.data().rooms); this.render(); };
    body.append(Dom.el('div', { class: 'field' }, [Dom.el('label', {}, 'Name'), labelBox]));

    // Search terms / aliases (NAV-18): the names printed on the floor plan (e.g. a room number
    // "2107"), so wayfinding search matches them even when the bound Location is named differently.
    // A search aid only — never drawn on the plan (floor rooms stay unlabelled). Round-tripped by
    // `sync_rooms` like `label`; the finder scores it in `SiteplanEditor._finderPlaced`.
    const aliasBox = Dom.el('textarea', { class: 'label-ctl text', rows: 2,
      placeholder: 'e.g. 2107, Old Server Room' });
    aliasBox.value = room.alias || '';
    aliasBox.onfocus = () => this.snapshot();   // one undo boundary per edit session
    aliasBox.oninput = () => { room.alias = aliasBox.value; this.markDirty(); };
    body.append(Dom.el('div', { class: 'field' }, [
      Dom.el('label', {}, 'Search terms (comma/newline-separated)'), aliasBox]));

    body.append(Dom.el('div', { class: 'hint' }, 'Bind to a NetBox Location on this floor:'));
    // State the modelling requirement where it actually bites (DOC-12). The list below can only
    // offer child Locations of this floor's Location, so an install that doesn't model a Location
    // per room finds it empty — and that is a NetBox data-modelling fact, not a bug in the map.
    // Say so here rather than leaving the user to infer it from an empty picker.
    body.append(Dom.el('div', { class: 'hint sub' },
      'Only Locations directly under this floor can be bound. If your NetBox doesn’t model a '
      + 'Location per room, leave the room draw-only — it still renders, is searchable, and can '
      + 'be named above.'));

    const res = await this.loadNbRooms();
    const rooms = res.rooms || [];
    const boundIds = new Set(this.data().rooms.filter(r => r.location).map(r => r.location.id));
    const bl = this._bindList(body, {
      placeholder: 'Search rooms…', items: rooms, limit: NB_BIND_LIST_LIMIT,
      filter: (r, ql) => !ql || r.name.toLowerCase().includes(ql) || r.slug.includes(ql),
      row: (loc) => {
        const isThis = room.location && room.location.id === loc.id;
        return { nm: loc.name + (isThis ? '  ✓' : (boundIds.has(loc.id) ? '  •' : '')), sl: loc.slug, bound: isThis };
      },
      pick: (loc) => {
        this.snapshot();
        room.location = { id: loc.id, name: loc.name, slug: loc.slug, url: loc.url };
        room.label = loc.name; this.markDirty();
        this.todo && this.todo.syncRooms(this.data().rooms);
        this.render(); this.openRoomPanel(room);
      },
      // Contextual "create new room" tile (LOC-2) — the inline Location-create escape hatch for
      // installs that don't model a Location per room, surfaced right in the results when the search
      // turns up few (≤3) or no matches, so it appears exactly when there's little to bind to.
      // Gated on write mode (the install-wide master gate) AND the inline-room-creation add-on's own
      // switch (SET-5) AND this user's dcim.add_location perm — all three re-checked server-side —
      // and only when a floor Location exists to parent the new child under (res.floor).
      footer: (list, matches, ql) => {
        if (this.app.writeMode && this.app.inlineRoomCreation && this.app.canCreateLocation
            && res.floor && matches.length <= 3)
          this._appendCreateTile(list, room, res.floor, ql);
      },
    });
    if (res.floor === null) body.insertBefore(
      Dom.el('div', { class: 'hint' }, '⚠ No NetBox Location matches floor slug "' + this.floor.id + '"; showing all site locations.'),
      bl.search);
    if (!rooms.length) bl.list.insertBefore(
      Dom.el('div', { class: 'hint' }, 'No NetBox locations returned.'), bl.list.firstChild);
  }

  /** Append the contextual "create new room" tile into the bind results (LOC-2). Rendered by the
   *  `_bindList` footer when write mode and the inline-room-creation add-on are both on, the user
   *  holds `dcim.add_location`, a floor Location exists to parent under, and the search found few
   *  (≤3) or no matches — so the create affordance surfaces exactly when binding to an existing
   *  Location is unlikely, instead of always sitting in the panel. Name-only (prefilled from the
   *  current search text `ql`, or the room's label): a name field + a button that creates the child
   *  Location under this floor and binds the room to it via `_createAndBind`. Every gate is
   *  re-checked server-side in `NbLocationCreateView`. */
  _appendCreateTile(list, room, floor, ql) {
    const input = Dom.el('input', { placeholder: 'New room name…', value: (ql || room.label || '').trim() });
    const btn = Dom.el('button', { class: 'wide' }, 'Create & bind');
    const submit = async () => {
      const name = input.value.trim();
      if (!name) { Toast.show('Enter a room name', true); input.focus(); return; }
      btn.disabled = true;
      try { await this._createAndBind(room, floor, name); }
      catch (e) { Toast.show('Create failed: ' + e.message, true); btn.disabled = false; }
    };
    btn.onclick = submit;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    list.append(Dom.el('div', { class: 'room-item create-tile' }, [
      Dom.el('div', { class: 'nm', html: Icons.plus }, 'Create new room under “' + floor.name + '”'),
      Dom.el('div', { class: 'field' }, [input, btn]),
    ]));
  }

  /** Create a child Location named `name` under `floor` (write mode + the inline-room-creation add-on
   *  + `dcim.add_location` gated, all re-checked server-side — this is one of the plugin's two writes
   *  into `dcim` core) and bind `room` to it.
   *  The shared action behind the create tile: caches the new Location so it lists next open, then
   *  snapshots and binds exactly as the `_bindList` pick does, so a subsequent save posts the binding
   *  (sync_rooms won't orphan it). Throws to the caller on failure so the tile can re-enable. */
  async _createAndBind(room, floor, name) {
    const loc = await this.netbox.createLocation(floor.id, name);
    const cached = this.store.nbRoomsByFloor[Util.floorKey(this.building.dir, this.floor.id)];
    if (cached && cached.rooms) cached.rooms.push(loc);
    this.snapshot();
    room.location = { id: loc.id, name: loc.name, slug: loc.slug, url: loc.url };
    room.label = loc.name;
    this.markDirty();
    this.todo && this.todo.syncRooms(this.data().rooms);
    this.render(); this.openRoomPanel(room);
    Toast.show('Created "' + loc.name + '" in NetBox and bound the room');
  }


  /** Delete the selected marker with Delete/Backspace while placing racks; otherwise the
   *  base editor handles the key (draw undo, escape, …). */
  handleKey(e) {
    if (e.key === 'Escape' && this.arranging) { this.arranging = false; this.show(); return; }
    // Selected route arrow (edit mode, not mid-draw): exit label-edit, then delete or
    // deselect it. Delete is suppressed while the label is being edited.
    if (this.editing() && this.selectedArrow && !this.draft) {
      const arrow = this.selectedArrow;
      if (e.key === 'Escape' && this._exitLabelEdit(() => this.annotations.openArrowPanel(arrow))) return;
      if (!this.editingLabel && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault(); this.annotations.deleteArrow(this.selectedArrow); return; }
      if (e.key === 'Escape') {
        this.selectedArrow = null; this.editingLabel = null; this.render(); this.app.closePanel(); return; }
    }
    // Selected text note (edit mode, focus outside the label field — the app-level
    // keydown swallows keys while the textarea has focus, so text editing is unaffected):
    // Delete/Backspace removes the note; Escape closes its editor (dropping it when empty).
    if (this.editing() && this.selectedNote && !this.draft) {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault(); this.annotations.deleteNote(this.selectedNote); return; }
      if (e.key === 'Escape') { this.app.closePanel(); return; }
    }
    // Delete a selected marker — in the racks sub-mode or in plain edit (rooms have no
    // delete-by-key, so this can't collide with a room selection). editing() covers both.
    if (this.editing() && this.selectedPlacement
        && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      const p = this.selectedPlacement;
      this.placements.removePlacement(p, this.data().rooms.find(r => r.id === p.room));
      return;
    }
    // Plain-edit rack: Escape exits label-edit first (back to the marker panel), else
    // deselects the marker (racks mode has its own richer Escape below).
    if (e.key === 'Escape' && !this.placingRacks && this.selectedPlacement) {
      if (this.placements.exitLabelEditToPlacement()) return;
      this.deselect(); return;
    }
    if (e.key === 'Escape' && this.placingRacks) {
      // Exit label-edit first (back to the marker panel), then deselect, then close.
      if (this.placements.exitLabelEditToPlacement()) return;
      if (this.selectedPlacement) { this.selectedPlacement = null; this.render(); return; }
      if (this.rackRoom) { this.app.closePanel(); return; }   // closePanel → onPanelClosed exits rack placement, stays in edit
    }
    super.handleKey(e);
  }

  /** App.closePanel hook: a closed sidebar means we've left whatever it was driving.
   *  While placing racks that's placement itself — clear the sub-mode and stay in edit
   *  (rebuild the toolbar so the Place-racks button de-activates; one click re-enters). The
   *  edit selection (`selected`/`selectedArrow`) is kept, so re-toggling Place racks re-opens
   *  the same room's rack panel. Skipped during a deliberate `_switchMode`/`_toggleRacks`
   *  (which already close the panel) so entering/leaving the sub-mode doesn't recurse. */
  onPanelClosed() {
    if (this._switchingMode) return;
    if (this.placingRacks) {
      this.placingRacks = false; this.rackRoom = null; this.selectedPlacement = null; this.editingLabel = null;
      this.app.setToolbar(this.toolbar.build()); this.render(); return;
    }
    // A plain-edit rack's panel closed (via the panel's own close, not a background click):
    // deselect the marker so its handles drop.
    if (this.selectedPlacement) { this.selectedPlacement = null; this.editingLabel = null; this.render(); return; }
    // A text note's editor closed: deselect and drop the note if it was left empty
    // (clearing a note's text is how it is deleted).
    if (this.selectedNote) {
      const note = this.selectedNote;
      this.selectedNote = null; this.editingLabel = null;
      this.annotations.dropEmptyNote(note);
      this.render(); return;
    }
    if (this.selectedArrow) { this.selectedArrow = null; this.editingLabel = null; this.render(); }
  }
}
