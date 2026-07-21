'use strict';
/* floor-editor.js — FloorEditor: draw/edit room polygons on a floor image and
   bind each to a NetBox Location. In view mode rooms are invisible clickable
   zones (rooms holding rack/device markers stay highlighted). Extends Editor for
   the shared engine. */

const MIN_PLACEMENT_PX = 8; // smallest a manually-resized rack/device marker can go (each axis)

//: Auto label defaults for a placement (READ-1). A rack centres its name INSIDE its filled box, so
//: it has a backdrop and needs neither of these; every other device floats its name over the plan
//: raster, where the printed room names live — hence a smaller default and an opaque chip behind
//: the text rather than a halo (a halo lets plan ink bleed through the gaps in the letters).
//: These are the AUTO fallbacks only: a saved `labelStyle.size` always wins, and "Reset to auto"
//: (which deletes `labelStyle`) is what lands a label back here.
const RACK_LABEL_PX = 11;    // a rack's name, on its own box
const DEVICE_LABEL_PX = 9;   // every other marker's name, over the plan — smaller collides less
const CHIP_PAD_X = 3, CHIP_PAD_Y = 1.5;   // chip padding around the text bbox (layout px)

//: The anti-overlap nudge (READ-1). There is no general label-placement engine: every label draws
//: at its anchor, so a room dense with APs stacks their names on top of each other. `_nudgeLabels`
//: is a deliberately small greedy pass — try the anchor, then alternate below/above it in `STEP`
//: increments until the box is clear. `MAX_STEPS` bounds both the cost and how far a label may
//: drift from the glyph it names; a label with nowhere to go stays at its anchor (overlapping is
//: better than pointing at the wrong marker).
const LABEL_NUDGE_STEP = 2;
const LABEL_NUDGE_MAX_STEPS = 12;
const LABEL_NUDGE_PAD = 1;   // px of clear air kept between two labels

//: The per-room hover "add a to-do" button (TASK-4; redesigned in UX-5). Sizes are **layout px** —
//: the same space `_drawPlacement` measures rack boxes in — so the icon is sized against racks
//: directly. The icon takes `TODO_ADD_REST` where the room affords it and shrinks toward
//: `TODO_ADD_MIN` where it doesn't; a room that cannot host even that gets no icon at all.
const TODO_ADD_REST = 18;    // resting diameter, where the room has room for it
const TODO_ADD_MIN = 12;     // below this it stops reading as a button — show none instead
const TODO_ADD_PAD = 3;      // clearance kept between the icon and a wall or a rack
const TODO_ADD_LATTICE = 24; // search grid over the room bbox, per axis (constant cost)
//: How much roomier than it strictly needs a spot must be to win the corner anchor. Without this
//: bar the corner-most *fitting* point wins, which on an L-shape or a corridor is a thin nook the
//: icon technically fits but visibly jams into; gated, those lose and the icon stays where the
//: room is actually open. Capped by the room's own best clearance, so a tight room still places.
const TODO_ADD_COMFORT = 1.6;
const TODO_ADD_DESIGN = 24;  // the glyph's own design grid (Lucide's); CSS scales it to the fit
//: Whether the device has a real hovering pointer. Held as the live MediaQueryList (its `.matches`
//: tracks a hybrid device that gains/loses a mouse) rather than re-running the query for each of a
//: floor's 60+ rooms on every render.
const TODO_ADD_HOVER_MQ = matchMedia('(hover: hover)');

const AP_DEVICE_TYPE_KEY = 'facilitymap:apDeviceType';   // last-used AP device type, {id,name} (UX-1)

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
    this.dragSheetState = null;      // { page, target:[col,row] } during a sheet drag
    this.layout = null;              // display geometry (padded while arranging)
    this.baseLayout = null;          // the floor's true (unpadded) sheet geometry
    this._peeked = false;            // first mount frames sheet 1 (peek), later shows full-fit
    this._focus = null;              // pending focus target { roomId, region } to frame on mount
    this._focusRoomId = null;        // room pulsed by the focus highlight (cleared after ~3.5s)
    this.showOverlays = true;        // read-only data-overlay layer visible by default (FMT-9)
    this.todo = null;                // the floor to-do panel (FloorTodo), built per show() (ADDON-1)
    this._containedRings = null;     // per-render map id→contained smaller-room rings (ROOM-2)
    this._todoHover = null;          // room the "add a to-do" + is showing for (TASK-4); view-mode hover chrome
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
    if (this.selectedNote) this._dropEmptyNote(this.selectedNote);
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
   *  The dirty flags are NOT stored: `_restoreState` re-derives them from the store baselines
   *  (SAVE-6), so they stay correct even after a save advances those baselines. JSON round-trip
   *  clone (all are plain JSON), matching the codebase's explicit-clone idiom. */
  _snapshotState() {
    const dir = this.building.dir, fid = this.floor.id, key = Util.floorKey(dir, fid);
    const rec = this.data(), pdata = this.store.placementData(dir, fid);
    const layout = this.store.layouts[key];
    const clone = (v) => JSON.parse(JSON.stringify(v));
    return {
      rooms: clone(rec.rooms), arrows: clone(rec.arrows || []), notes: clone(rec.notes || []),
      placements: clone(pdata.placements), layout: layout ? clone(layout) : null,
    };
  }

  /** Restore a snapshot: write the cloned data back into the store records, re-derive the
   *  dirty flags from the store baselines, and drop transient selection/drag state (a restored
   *  delete may have removed the selected shape; live drag refs now point at stale arrays). Closes
   *  the panel under the _switchMode guard so it doesn't bounce racks→edit. */
  _restoreState(snap) {
    const dir = this.building.dir, fid = this.floor.id, key = Util.floorKey(dir, fid);
    // A sheet arrangement change alters the combined canvas geometry (this.layout /
    // baseLayout are derived in show(), not render()), so undoing one needs a full
    // show() to re-tile — a plain render() would draw the restored coords over the wrong
    // canvas. Detect it before overwriting the blob.
    const layoutChanged = JSON.stringify(this.store.layouts[key] || null) !== JSON.stringify(snap.layout);
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
    this.selected = null; this.selectedArrow = null; this.selectedNote = null;
    this.selectedPlacement = null;
    this.editingLabel = null; this.draft = null; this.rackRoom = null;
    if (this.store.onDirty) { this.store.onDirty('floor'); this.store.onDirty('racks'); }
    this._setBadge();
    this._switchingMode = true; this.app.closePanel(); this._switchingMode = false;
    if (layoutChanged) this.show();   // re-tile the canvas for the restored arrangement
  }

  // ---- view assembly ----
  show() {
    const b = this.building, f = this.floor;
    this.draft = null; this.selected = null; this.editingLabel = null; this.selectedPlacement = null;
    this.selectedArrow = null; this.selectedNote = null; this.rackRoom = null;
    this.rectMode = false; this.rectDraft = null;
    this.dragSheetState = null;
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
    this.app.setToolbar(this._toolbar());

    const stage = Dom.$('#stage'); stage.innerHTML = '';
    // Rebuilt fresh every show() (including arrange/sheet-move re-mounts, since stage.innerHTML
    // is cleared above), so there's no stale "already shown" state to reset between mounts.
    const planUnavailable = this._planUnavailableOverlay();
    this._planUnavailableEl = planUnavailable;
    const imgs = base.cells.map(c => Dom.el('img', { class: 'sheet', src: this.store.mediaUrl(c.image), alt: f.label,
      style: `left:${c.col * base.cellW}px;top:${c.row * base.cellH}px;width:${base.cellW}px;height:${base.cellH}px`,
      onerror: (e) => this._onSheetError(e.target, b.dir, f.id, c.image) }));
    const s = Dom.svg('svg', { preserveAspectRatio: 'none' });
    const wrap = Dom.el('div', { class: 'map-wrap', id: 'floor-wrap', style: `width:${W}px;height:${H}px` },
      [...imgs, s]);
    // The sheet stamp and the plan-unavailable overlay both sit in the viewport (not the wrap),
    // so they stay fixed in place instead of panning/zooming with the map.
    const viewport = Dom.el('div', { class: 'map-viewport' }, [wrap, this._sheetMark(), planUnavailable]);
    // The room-by-room to-do list sits in a resizable/hideable panel beside the map (ADDON-1),
    // reusing the siteplan index's flex-row + drag-handle chrome via the shared
    // `Editor._installPanelResize`. The chrome-free dashboard embed keeps just the map — no panel,
    // no toggle, no persisted prefs — exactly as it suppresses the siteplan legend resize. The
    // to-do add-on being switched off install-wide (ADDON-4) suppresses the panel the same way, and
    // with `this.todo` left null the hover "+" compose glyph drops out too (`_todoAddEnabled`).
    if (this.app.embed || !this.app.todos) {
      stage.append(viewport);
    } else {
      this.todo = new FloorTodo(this.app, Util.floorKey(b.dir, f.id), this.data().rooms);
      const panel = this.todo.build();
      const handle = Dom.el('div', { class: 'legend-resize',
        title: 'Drag to resize · double-click to hide the to-do panel' });
      const view = Dom.el('div', { class: 'floor-view' }, [viewport, handle, panel]);
      stage.append(view);
      this._installPanelResize({ view, panel, handle, ...this.todo.resizeOpts() });
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
    this.loadNbRooms();
    // Markers now show in plain edit (inert reference glyphs), racks mode, and view — any
    // editing state or view mode needs the live inventory so they render real glyphs, not
    // the stale fallback.
    if (this.editing() || this.app.mode === 'view') this._ensurePlacementInventory();
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
    const code = (Util.code(this.building.dir) + ' ' + this.floor.id).trim();
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

  // ---- toolbar hooks (assembled by Editor._toolbar) ----
  // Edit-mode draw/add tools. Undo is appended by the base; Snap rides _alignTools. These are
  // `tb-labeled` (the "Add …" voice, matching SiteplanEditor's "Add building area"): their text
  // shows when the bar has room and collapses to icon+tooltip when it doesn't.
  _editButtons() {
    const drawBtn = Dom.el('button', { class: 'tb-labeled', title: 'Add a room: click points · Enter/double-click to close',
      onclick: () => this.beginDraw(
      'Click to add points · Backspace undoes a point · Enter/double-click to close · Esc to cancel'),
      html: Icons.draw + '<span>Add room area</span>' });
    const rectBtn = Dom.el('button', { class: 'tb-labeled', title: 'Add a rectangular room: drag a box',
      onclick: () => this.beginRect('Drag a rectangle to make a room · Esc to cancel'),
      html: Icons.rect + '<span>Add rectangle</span>' });
    const arrowBtn = Dom.el('button', { class: 'tb-labeled', title: 'Add a wayfinding route arrow to a room',
      onclick: () => this.beginArrow(), html: Icons.arrow + '<span>Add arrow</span>' });
    const noteBtn = Dom.el('button', { class: 'tb-labeled', title: 'Add a free-standing text note',
      onclick: () => this.beginNote(), html: Icons.note + '<span>Add note</span>' });
    return [drawBtn, rectBtn, arrowBtn, noteBtn];
  }
  // Prepend the floor's Snap toggle to the shared right-angle/grid factory row (the
  // siteplan editor always snaps, so the base row omits it).
  _alignTools() { return [this.snapButton(), ...super._alignTools()]; }
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
        onclick: () => this.beginAp(), html: Icons.wifi + '<span>Add access point</span>' }));
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
    if (this.layout && this.layout.cells.length > 1) extra.push(this._arrangeButton(), this.toolDivider());
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
   *  imported overlay features; mirrors _arrangeButton's stateful-toggle pattern but repaints
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
  /** Beyond the base state reset: leaving/re-entering edit exits the Place-racks sub-mode
   *  and drops the floor-specific selections; entering view warms the placement inventory. */
  _onModeSwitch(mode) {
    this.placingRacks = false;
    this.copyingLink = false;   // the view-only copy-link tool never carries across a mode switch
    this.selectedArrow = null; this.selectedNote = null; this.selectedPlacement = null;
    this.rackRoom = null;
    // The rooms are about to be rebuilt, so the hovered one's polygon is a dead element and no
    // `pointerleave` will ever arrive for it (TASK-4).
    this._todoHover = null;
    if (mode === 'view') this._ensurePlacementInventory();
  }

  /** Toggle the Place-racks sub-mode within edit mode (see `_switchMode` for the in-place
   *  rebuild rationale). Turning it ON while a room is already selected keeps that selection
   *  (edit persists) and opens the room's rack panel immediately — no re-click. Turning it
   *  OFF closes the rack panel and drops back to plain edit. Arrange is a mutually-exclusive
   *  edit sub-mode whose padded canvas must un-pad, so leaving it routes through `show()`. */
  _toggleRacks() {
    this._endNoteEdit();   // leaving plain edit for racks ends any in-progress note edit
    if (this.arranging) {
      this.arranging = false; this.placingRacks = true;
      this.selectedPlacement = null; this.rackRoom = null;
      this.show(); this._ensurePlacementInventory();
      return;
    }
    this.placingRacks = !this.placingRacks;
    this.selectedPlacement = null; this.editingLabel = null;
    if (this.placingRacks) {
      const room = (this.selected != null && this.data().rooms.find(r => r.id === this.selected)) || null;
      this.rackRoom = room;
      this.app.setToolbar(this._toolbar());
      this.render();
      this._ensurePlacementInventory();
      if (room) this.openRackPanel(room);
    } else {
      this.rackRoom = null;
      this._switchingMode = true; this.app.closePanel(); this._switchingMode = false;
      this.app.setToolbar(this._toolbar());
      this.render();
    }
  }

  /** Toggle the Copy-link sub-tool within view mode (NAV-10). An in-place toggle like Place-racks:
   *  flip the flag, rebuild the toolbar (so the button de/activates), and re-render so the room
   *  click-zones and placement markers pick up the copy cursor + copy-on-click behaviour. No panel
   *  or inventory to manage — a successful copy turns the tool back off (`_copyTargetLink`). */
  _toggleCopyLink() {
    this.copyingLink = !this.copyingLink;
    this.app.setToolbar(this._toolbar());
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

  /** Toggle Arrange mode (drag sheets into grid cells). Edit-mode, multi-sheet only. */
  _arrangeButton() {
    const b = Dom.el('button', { class: 'icononly' + (this.arranging ? ' active' : ''),
      title: 'Drag sheets to arrange them in a grid', html: Icons.arrange + '<span>Arrange sheets</span>' });
    b.onclick = () => {
      this.arranging = !this.arranging;
      if (this.arranging) {
        // Arrange supersedes rack placement (mutually-exclusive edit sub-modes); clear it
        // before closePanel so onPanelClosed's placing-racks branch stays a no-op.
        this._endNoteEdit();   // entering arrange ends any in-progress note edit
        this.placingRacks = false; this.rackRoom = null; this.selectedPlacement = null;
        this.selected = null; this.editingLabel = null; this.draft = null;
        this.app.closePanel();
        Toast.show('Drag a sheet to a cell to move it · drop on another to swap · Esc to exit');
      }
      this.show();
    };
    return b;
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
    this.addCatcher(s, W, H);
    if (arranging) { this._drawArrange(s, W, H); return; }
    this._drawCaptions(s, W, H);

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
    if (!racks) this._drawArrows(s, W, H, true);   // non-selected wayfinding routes (edit + view)
    // Markers draw in every mode that reaches here (arrange returned above): view, racks, and
    // plain edit (inert reference glyphs). The selected room's markers are skipped in plain edit
    // (drawPlacements draws them in the active layer instead — see _renderActive).
    this.drawPlacements(s, W, H, true);
    // Free-standing text notes sit on top (topmost static content) so they stay legible;
    // suppressed while placing racks, matching wayfinding arrows.
    if (!racks) this._drawNotes(s, W, H, true);
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
    // its own, without disturbing the static layer. `_drawTodoAdd` no-ops outside view mode.
    this._drawTodoAdd(s, W, H);

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
          const i = this._edgeHit(e, room.polygon);
          poly.style.cursor = i >= 0 ? this._edgeCursor(room.polygon, i) : 'move';
        });
        poly.addEventListener('pointerdown', (e) => this._onRoomBodyPress(e, room));
        // No centroid label is drawn (the floor-plan images already carry the printed
        // room names/numbers); the selected room just gets its editable vertices.
        this.drawVertices(s, room.polygon, W, H, room.id, () => this.markDirty());
        // The selected room's rack/device markers ride the active layer (drawn after the
        // room fill + vertices) so they (a) stay visible above the promoted room's fill and
        // (b) repaint per frame when the room is dragged (_startRoomDrag translates them too).
        // They are interactive here (grabbable, see _drawPlacement) and sit above the room, so a
        // press ON a marker grabs the rack while a press elsewhere reaches the room beneath —
        // clicking one selects it, which clears `this.selected` and re-renders into the
        // selected-placement path below. drawPlacements skips them in the static layer.
        this._drawRoomPlacements(s, room, W, H);
      }
    }
    if (editing && this.selectedArrow) this._drawArrow(s, this.selectedArrow, W, H, editing);
    // The note being label-edited draws here so its label drag/handles repaint per frame.
    // Like the selected arrow, it shows even in racks mode (only *non-selected* notes are
    // decluttered there); non-edited notes live in the static layer, gated by `!racks`.
    if (editing && this.selectedNote) this._drawNote(s, this.selectedNote, W, H);
    this.drawDraft(s, W, H);
    // The selected marker draws into the active layer (always on top, with its handles). This
    // fires in racks mode and in plain-edit rack selection — where selecting a rack cleared
    // `this.selected`, so no room is promoted above and drawPlacements (skipSelected) leaves
    // this one for here, exactly the racks-mode topology (no double-draw).
    if (this.editing() && this.selectedPlacement) {
      const roomById = {};
      for (const r of this.data().rooms) roomById[r.id] = r;
      this._drawPlacement(s, this.selectedPlacement, W, H, roomById);
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
    title.textContent = (room.label || '(unbound)') + (placed ? ' (has devices)' : '');
    poly.append(title);
    poly.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.draft) return;
      this._endNoteEdit();   // selecting a room ends any in-progress note edit
      // While placing racks (a sub-mode of edit, so `editing` is also true) a room click
      // opens its rack panel; racks therefore takes precedence over the plain-edit bind panel.
      if (racks) { this.selected = room.id; this.selectedPlacement = null; this.rackRoom = room; this.render(); this.openRackPanel(room); }
      else if (editing) { this.selected = room.id; this.selectedPlacement = null; this.render(); this.openRoomPanel(room); }
      else if (this.copyingLink) this._copyTargetLink('room', room);
      else if (room.location) window.open(room.location.url, '_blank');
    });
    this._wireTodoHover(poly, room, editing);
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

  // ---- the per-room "add a to-do" + (TASK-4) ----
  /** Whether `room` may show the hover "+": drawn AND assigned (an unbound scribble isn't a place
   *  you'd track work against — the same rule `FloorTodo` filters its room list by), view mode
   *  only, and only where there is a panel to open into. Suppressed in the chrome-free embed
   *  (`this.todo` is null there) and while the copy-link tool is armed, whose own click meaning
   *  owns every room. Hover is a **mouse** idiom: on a touch/no-hover device the icon is never
   *  drawn — a tap-to-reveal would hijack the view-mode room tap that opens the NetBox Location —
   *  and the to-do panel's always-visible "+ New" is the path instead (see `FloorTodo._head`). */
  _todoAddEnabled(room, editing) {
    return !editing && !!this.todo && !this.copyingLink
      && !!room.location && (room.polygon || []).length > 0
      && TODO_ADD_HOVER_MQ.matches;
  }

  /** Show the "+" while the cursor is over `room`. The icon draws in the **active layer**, which
   *  view mode otherwise leaves empty, so a hover repaints via the existing cheap `renderActive()`
   *  and never touches the static layer's 60+ rooms. This is transient chrome with no stored
   *  position: it must never mark the document dirty (see §10 *To-do*).
   *
   *  Enter/leave rather than a global pointermove, so the rack-avoidance search below runs **once
   *  per hovered room** instead of per-room per-render. The `relatedTarget` guard is what keeps the
   *  icon from flickering out from under the cursor: the icon lives in a different layer than the
   *  polygon, so moving onto it fires the room's `pointerleave` — that is a hop *into* the icon,
   *  not a real leave. Moving back out of the icon re-fires the room's `pointerenter`, so the icon
   *  needs no leave handler of its own. */
  _wireTodoHover(poly, room, editing) {
    if (!this._todoAddEnabled(room, editing)) return;
    poly.addEventListener('pointerenter', () => this._setTodoHover(room));
    poly.addEventListener('pointerleave', (e) => {
      if (e.relatedTarget && this.activeLayer.contains(e.relatedTarget)) return;   // → onto the icon
      this._setTodoHover(null);
    });
  }

  _setTodoHover(room) {
    if ((this._todoHover && this._todoHover.id) === (room && room.id)) return;
    this._todoHover = room;
    this.renderActive();
  }

  /** Every rack/device box in `room` as an axis-aligned rect in layout px. A rotated marker is
   *  tested as the AABB of its rotated corners — conservative (it over-reserves at 45°), which is
   *  the right way to err: the icon keeps clear of a rack it might only have clipped. Mirrors
   *  `_drawPlacement`'s own sizing (per-marker `p.w/p.h`, else the type's default box) so the two
   *  can't drift. The rects are **unpadded**: `_todoAddSpot` applies `TODO_ADD_PAD` once, to walls
   *  and racks alike, so padding here as well would silently double it around racks. */
  _todoRackRects(room, W, H) {
    const rects = [];
    for (const p of this.store.placementData(this.building.dir, this.floor.id).placements) {
      if (p.room !== room.id) continue;
      const box = DeviceShapes.box(DeviceShapes.typeFor(p, this._cacheItem(p)));
      const w = (p.w != null ? p.w * W : box.w), h = (p.h != null ? p.h * H : box.h);
      const rad = (p.rot || 0) * Math.PI / 180;
      const cs = Math.abs(Math.cos(rad)), si = Math.abs(Math.sin(rad));
      const ew = (w * cs + h * si) / 2, eh = (w * si + h * cs) / 2;   // half-extents of the rotated AABB
      rects.push({ x0: p.x * W - ew, x1: p.x * W + ew, y0: p.y * H - eh, y1: p.y * H + eh });
    }
    return rects;
  }

  /** Where the "+" goes for `room`, as `{ x, y, size }` in layout px — **the placement rule**
   *  (§10 *To-do*) — or `null` for a room with nowhere to put it. Deterministic by construction:
   *  same room + same racks always yields the same spot, and it is computed at the **reference
   *  (unzoomed) layout scale**, so the icon never drifts as the user zooms. (The icon *renders*
   *  screen-constant via `--inv-scale`; the two are deliberately decoupled — sizing the search to
   *  the on-screen size would slide the icon around under zoom. The cost is that zoomed far out the
   *  icon's apparent footprint outgrows the one it was placed against and can clip a rack; zoomed
   *  in it only ever gets tighter.)
   *
   *  Walls and racks are one `Geom.clearance` field, and the icon is a **disc**, so
   *  `clearance(p) >= radius` is an exact "the icon fits here, clear of everything" — no separate
   *  corner-in-polygon tests, no box-vs-rack overlap pass.
   *
   *  1. **Size from the room, not a retry ladder.** `Geom.poleOfInaccessibility` returns the
   *     room's most open interior point and, in `r`, how open it is. Too tight for
   *     `TODO_ADD_MIN` → `null`. Otherwise the icon takes `TODO_ADD_REST`, or as much of it as `r`
   *     affords.
   *  2. **Comfort-gated corner anchor.** The floor images print each room's name/number, almost
   *     always dead-centre — exactly where the most open point is — so the icon is pulled to the
   *     room's **top-right**, the side the to-do panel it opens lives on. The anchor is a *target*,
   *     never a position: candidates are the lattice plus the pole itself, only those with
   *     `TODO_ADD_COMFORT` headroom may compete, and the corner-most survivor wins (strict `<`, so
   *     ties keep scan order). On an L whose top-right lies outside the room, the winner is simply
   *     the point in the arm reaching toward it; a *thin* arm fails the comfort bar and the icon
   *     stays where the room is open. The pole always qualifies (`comfort` is capped by `r`), so
   *     the search cannot come up empty and a tight room falls back to it.
   *
   *  Returning `null` — a rack-packed closet, or a room smaller than the icon — is deliberate: the
   *  "+" is a redundant pointer shortcut, and `FloorTodo`'s always-visible, focusable "+ New" is
   *  the path for those rooms, exactly as it already is for every touch user. */
  _todoAddSpot(room, W, H) {
    const poly = room.polygon.map(([x, y]) => [x * W, y * H]);
    const racks = this._todoRackRects(room, W, H);
    const pole = Geom.poleOfInaccessibility(poly, racks);
    if (pole.r < TODO_ADD_MIN / 2 + TODO_ADD_PAD) return null;

    const radius = Math.min(TODO_ADD_REST / 2, pole.r - TODO_ADD_PAD);
    const comfort = Math.min(pole.r, (radius + TODO_ADD_PAD) * TODO_ADD_COMFORT);
    const b = Geom.bounds(poly);
    const toAnchor = (x, y) => Math.hypot(x - b.maxX, y - b.minY);   // the bbox's top-right

    let best = pole, bestD = toAnchor(pole.x, pole.y);
    for (let i = 0; i <= TODO_ADD_LATTICE; i++) {
      for (let j = 0; j <= TODO_ADD_LATTICE; j++) {
        const x = b.minX + (b.w * i) / TODO_ADD_LATTICE, y = b.minY + (b.h * j) / TODO_ADD_LATTICE;
        if (Geom.clearance(x, y, poly, racks) < comfort) continue;
        const d = toAnchor(x, y);
        if (d < bestD) { bestD = d; best = { x, y }; }   // strict <: ties keep the earlier scan order
      }
    }
    return { x: best.x, y: best.y, size: radius * 2 };
  }

  /** Draw the hovered room's "+" into the active layer, as **three nested groups** — each carries
   *  one transform, and they cannot be collapsed:
   *    - outer — the *position*, as a transform **attribute**, plus the fade-in animation (opacity
   *      doesn't collide with the attribute). A CSS `transform` here would clobber the translate:
   *      the property and the attribute are the same property.
   *    - `.todo-add` — `scale(--inv-scale)` (PanZoom.apply), holding a constant on-screen size.
   *    - `.todo-add-glyph` — the fit-to-`spot.size` scale and the grow-on-hover. Separate from the
   *      `--inv-scale` group precisely so its transition can't chase a zoom: zoom moves the
   *      *parent's* transform, leaving this one still.
   *  The glyph is drawn on a fixed `TODO_ADD_DESIGN` grid centred on (0,0) — sizing is `--todo-fit`
   *  alone, so no geometry is recomputed per size and the scale works about the icon's middle.
   *
   *  `aria-hidden` is deliberate, not an oversight: this is a redundant pointer shortcut for the
   *  to-do panel's own "+ New" button, which is always visible and properly focusable. A hover-only
   *  control that can never receive focus has no business in the tab order. */
  _drawTodoAdd(s, W, H) {
    const room = this._todoHover;
    if (!room || !this._todoAddEnabled(room, this.editing())) return;
    // Re-read the room from the store: a hover held across a live refresh may name a room whose
    // geometry or binding has since changed (or gone).
    const live = this.data().rooms.find(r => r.id === room.id);
    if (!live || !live.location || !(live.polygon || []).length) return;

    const spot = this._todoAddSpot(live, W, H);
    if (!spot) return;   // nowhere it fits — the panel's "+ New" is the path for this room
    const outer = Dom.svg('g', { transform: `translate(${spot.x},${spot.y})`, class: 'todo-add-anchor' });
    const g = Dom.svg('g', { class: 'todo-add', 'aria-hidden': 'true' });
    const glyph = Dom.svg('g', { class: 'todo-add-glyph', style: `--todo-fit:${spot.size / TODO_ADD_DESIGN}` });
    const arm = TODO_ADD_DESIGN * (7 / 24);   // the Lucide plus's 14/24 bar, on its own design grid
    glyph.append(Dom.svg('circle', { cx: 0, cy: 0, r: TODO_ADD_DESIGN / 2, class: 'todo-add-disc' }));
    glyph.append(Dom.svg('line', { x1: -arm, y1: 0, x2: arm, y2: 0, class: 'todo-add-bar' }));
    glyph.append(Dom.svg('line', { x1: 0, y1: -arm, x2: 0, y2: arm, class: 'todo-add-bar' }));
    const title = Dom.svg('title');
    title.textContent = 'Add a to-do for ' + (live.label || live.location.name);
    glyph.append(title);
    // The room beneath opens its NetBox Location on click — this must not reach it.
    g.addEventListener('click', (e) => { e.stopPropagation(); this._openTodoFor(live); });
    g.append(glyph);
    outer.append(g);
    s.append(outer);
  }

  /** Open the to-do panel on `room` — revealing it first if the user has it collapsed, since the
   *  pre-filled composer is useless behind a hidden panel. */
  _openTodoFor(room) {
    if (this._panelCollapsed && this._panelCollapsed()) this._setPanelCollapsed(false);
    this.todo.openComposer(room.id);
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
   *  drags that whole edge, anything deeper translates the whole room. `_edgeHit` (base)
   *  does the zoom-invariant edge hit-test; both starters own their stopPropagation +
   *  pointer capture, so this only picks the channel. */
  _onRoomBodyPress(e, room) {
    if (e.button !== 0 || this.draft) return;
    const i = this._edgeHit(e, room.polygon);
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

  /** Caption each sheet of a multi-sheet floor at its cell's top-left (mirrors the
   *  PDF's per-sheet label). Drawn as inert SVG text, so it costs no layout height
   *  and does not shift the shared coordinate space. */
  _drawCaptions(s, W, H) {
    const lay = this.layout; if (!lay || lay.cells.length < 2) return;
    const inset = 0.02 * lay.cellW;
    for (const c of lay.cells) {
      if (!c.caption) continue;
      const t = Dom.svg('text', { x: c.col * lay.cellW + inset, y: c.row * lay.cellH + inset * 1.4,
        'dominant-baseline': 'hanging', class: 'page-caption' });
      t.textContent = c.caption;
      s.append(t);
    }
  }

  // ---- Arrange mode: drag sheets into a grid ----
  /** Draw the sheet grid: cell outlines, a drop-target highlight, and a draggable
   *  tile per sheet. Only the tiles are interactive; the rest of the canvas keeps
   *  panning. */
  _drawArrange(s, W, H) {
    const lay = this.layout, { cellW, cellH, cols, rows } = lay;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        s.append(Dom.svg('rect', { x: c * cellW, y: r * cellH, width: cellW, height: cellH, class: 'sheet-grid' }));

    if (this.dragSheetState && this.dragSheetState.target) {
      const [tc, tr] = this.dragSheetState.target;
      s.append(Dom.svg('rect', { x: tc * cellW, y: tr * cellH, width: cellW, height: cellH, class: 'sheet-drop' }));
    }

    for (const cell of lay.cells) {
      const x = cell.col * cellW, y = cell.row * cellH;
      const dragging = this.dragSheetState && this.dragSheetState.page === cell.page;
      const tile = Dom.svg('rect', { x, y, width: cellW, height: cellH, rx: 8,
        class: 'sheet-tile' + (dragging ? ' dragging' : '') });
      tile.addEventListener('pointerdown', (e) => this._startSheetDrag(e, cell));
      s.append(tile);
      const label = Dom.svg('text', { x: x + cellW / 2, y: y + cellH / 2,
        'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'sheet-tile-label' });
      label.textContent = cell.caption || ('Sheet ' + (cell.page + 1));
      label.style.pointerEvents = 'none';
      s.append(label);
    }
  }

  /** Begin dragging a sheet tile; the target cell follows the pointer (clamped one
   *  cell beyond the current grid so you can extend it), and drop commits the move. */
  _startSheetDrag(e, cell) {
    if (e.button !== 0) return;
    e.stopPropagation();
    this.dragSheetState = { page: cell.page, target: [cell.col, cell.row] };
    this.dragSheet = {
      move: (nx, ny) => {
        const lay = this.layout;
        const c = Math.max(0, Math.min(this.baseLayout.cols, Math.floor(nx * lay.W / lay.cellW)));
        const r = Math.max(0, Math.min(this.baseLayout.rows, Math.floor(ny * lay.H / lay.cellH)));
        this.dragSheetState.target = [c, r];
        this.render();
      },
      drop: () => this._commitSheetMove(),
    };
    this.svg.setPointerCapture(e.pointerId);
    this.render();
  }

  /** Place the dragged sheet in the target cell (swap if occupied), trim the grid to
   *  the origin, remap any rooms/racks to follow their sheet, and re-lay-out. */
  _commitSheetMove() {
    const st = this.dragSheetState; this.dragSheetState = null;
    if (!st) { this.render(); return; }
    const oldGeom = this.store.floorLayout(this.building.dir, this.floor.id);
    const cells = oldGeom.cells.map(c => [c.col, c.row]);   // [col,row] per page index
    const from = cells[st.page], [tc, tr] = st.target;
    if (tc === from[0] && tr === from[1]) { this.render(); return; }   // no-op
    const occ = cells.findIndex(([c, r], i) => i !== st.page && c === tc && r === tr);
    if (occ >= 0) cells[occ] = [from[0], from[1]];   // swap
    cells[st.page] = [tc, tr];
    const minC = Math.min(...cells.map(c => c[0])), minR = Math.min(...cells.map(c => c[1]));
    const grid = cells.map(([c, r]) => [c - minC, r - minR]);
    this.snapshot();   // before setLayout + the room/arrow/placement remap
    this.store.setLayout(this.building.dir, this.floor.id, grid);
    this._remapLayout(oldGeom, this.store.floorLayout(this.building.dir, this.floor.id));
    this.show();   // relayout (still arranging → re-padded)
  }

  /** Re-project every room point / placement from the old tiling to the new one so
   *  each shape stays on its own sheet: locate its old cell, take its within-cell
   *  fraction, and map that into the sheet's new cell. Pure arithmetic on the stored
   *  combined-normalized coords — no schema or engine change. */
  _remapLayout(oldG, newG) {
    if (oldG.W === newG.W && oldG.H === newG.H
        && oldG.cells.every((c, i) => c.col === newG.cells[i].col && c.row === newG.cells[i].row)) return;
    const map = (nx, ny) => {
      const px = nx * oldG.W, py = ny * oldG.H;
      const cell = oldG.cells.find(c => px >= c.col * oldG.cellW && px < (c.col + 1) * oldG.cellW
        && py >= c.row * oldG.cellH && py < (c.row + 1) * oldG.cellH) || oldG.cells[0];
      const lx = (px - cell.col * oldG.cellW) / oldG.cellW, ly = (py - cell.row * oldG.cellH) / oldG.cellH;
      const nc = newG.cells[cell.page];
      return [+(((nc.col + lx) * newG.cellW) / newG.W).toFixed(5),
              +(((nc.row + ly) * newG.cellH) / newG.H).toFixed(5)];
    };
    const fdata = this.store.floorData(this.building.dir, this.floor.id);
    const rooms = fdata.rooms;
    for (const room of rooms) {
      room.polygon = room.polygon.map(p => map(p[0], p[1]));
    }
    // Route arrows live in the same combined-normalized space → remap with the rooms
    // so each route stays on its own sheet. Their `room` binding is an id, untouched.
    const arrows = fdata.arrows;
    for (const a of arrows) a.points = a.points.map(p => map(p[0], p[1]));
    // Free-standing notes are floor-space too → remap their anchor (and any dragged
    // label override) so each note stays on its own sheet.
    const notes = fdata.notes || [];
    for (const nt of notes) {
      [nt.x, nt.y] = map(nt.x, nt.y);
      if (nt.labelStyle && nt.labelStyle.x != null)
        [nt.labelStyle.x, nt.labelStyle.y] = map(nt.labelStyle.x, nt.labelStyle.y);
    }
    const placements = this.store.placementData(this.building.dir, this.floor.id).placements;
    for (const p of placements) {
      const [x, y] = map(p.x, p.y); p.x = x; p.y = y;
      if (p.w != null) p.w = +(p.w * oldG.W / newG.W).toFixed(5);
      if (p.h != null) p.h = +(p.h * oldG.H / newG.H).toFixed(5);
    }
    if (rooms.length || arrows.length || notes.length) this.store.markDirty();
    if (placements.length) this.store.markPlacementsDirty();
  }

  // ---- rack/device placement markers (rooms bound to a Location) ----
  /** Live-load inventory for every bound room that has placements on this floor,
   *  so markers render with their real glyphs instead of the stale fallback. Each
   *  Location is fetched once and kept in the in-memory cache; one re-render restyles
   *  the markers when the inventory lands (roadmap §10 risk 3: brief stale flash). */
  async _ensurePlacementInventory() {
    const pdata = this.store.placementData(this.building.dir, this.floor.id);
    if (!pdata.placements.length) return;
    const roomById = {};
    for (const r of this.data().rooms) roomById[r.id] = r;
    const locIds = new Set();
    for (const p of pdata.placements) {
      const room = roomById[p.room];
      if (room && room.location) locIds.add(room.location.id);
    }
    const pending = [...locIds].filter(id => !this.store.rackCache.locations[id]);
    if (!pending.length) return;
    try {
      await Promise.all(pending.map(id => this.store.ensureRacks(this.netbox, id)));
      this.render();
    } catch (e) { Toast.show('NetBox: ' + e.message, true); }
  }

  /** Cached inventory entry for a placement, or null if it's no longer in NetBox. */
  _cacheItem(p) {
    const loc = this.store.rackCache.locations[p.loc];
    if (!loc) return null;
    return (p.kind === 'rack' ? loc.racks : loc.devices).find(x => x.id === p.id) || null;
  }

  /** Draw a marker per placement. In racks mode markers are draggable (move
   *  clamped to the room polygon) and the selected one gets rotate + resize
   *  handles; in view mode they are read-only links to NetBox. Each marker is a
   *  `translate(center) rotate(rot)` group sized to (normalized) w×h. */
  drawPlacements(s, W, H, skipSelected) {
    const pdata = this.store.placementData(this.building.dir, this.floor.id);
    const roomById = {};
    for (const r of this.data().rooms) roomById[r.id] = r;

    const visible = pdata.placements.filter(p => {
      const room = roomById[p.room];
      return room && room.location;
    });
    // In plain edit the selected room is promoted to the active layer; its markers ride that
    // layer too (drawn in _renderActive), so skip them here to avoid a double-draw and let
    // them repaint per frame during a whole-room drag.
    const activeRoom = (this.editing() && !this.placingRacks) ? this.selected : null;
    // The selected marker renders into the active layer (always on top), so no
    // draw-order sort is needed here; skip it so it isn't drawn twice.
    const labels = [];
    for (const p of visible) {
      if (skipSelected && p === this.selectedPlacement) continue;
      if (activeRoom != null && p.room === activeRoom) continue;
      labels.push(this._drawPlacement(s, p, W, H, roomById));
    }
    // Every marker on the floor is drawn by now, so their names can be pushed apart. Runs over the
    // whole layer (not per room) because adjacent rooms' markers collide across the wall between
    // them just as readily as two in one room.
    this._nudgeLabels(labels);
  }

  /** Draw the selected room's placement markers into `s` (the active layer, in plain edit).
   *  Mirrors drawPlacements' visibility rule (a placement needs a bound Location); markers are
   *  inert here (see _drawPlacement's plain-edit branch). Kept separate so the whole-room drag's
   *  renderActive() repaints them in lockstep with the room. */
  _drawRoomPlacements(s, room, W, H) {
    if (!room.location) return;
    const roomById = { [room.id]: room };
    const labels = [];
    for (const p of this.store.placementData(this.building.dir, this.floor.id).placements)
      if (p.room === room.id) labels.push(this._drawPlacement(s, p, W, H, roomById));
    // Same de-collide pass as the static layer, so a promoted room's labels don't re-stack the
    // moment it is selected. Scoped to this room's markers — the rest live in the layer below.
    this._nudgeLabels(labels);
  }

  /** Draw one placement marker into `s` (glyph + title; draggable with handles in racks
   *  mode, a NetBox link in view mode) plus its label. Shared by the static loop and the
   *  active-layer draw of the selected marker — `.selected`/handles key off
   *  `this.selectedPlacement`, so they light up only for the selected one either way. */
  _drawPlacement(s, p, W, H, roomById) {
    // Markers are interactive throughout edit — the "Place racks" sub-mode AND plain edit —
    // so a rack can be grabbed/rotated/resized without entering the sub-mode. In plain edit a
    // marker press falls on the marker (it's drawn above the room fill + vertices), while a
    // press elsewhere still reaches the room polygon beneath; in view it stays a read-only link.
    const draggable = this.editing();
    const room = roomById[p.room];
    const item = this._cacheItem(p);
    const stale = !item;
    const selected = draggable && p === this.selectedPlacement;
    // The glyph type is keyed off the NetBox role (device-name fallback); its size
    // defaults per type unless the user has resized this marker (p.w/p.h).
    const type = DeviceShapes.typeFor(p, item);
    const box = DeviceShapes.box(type);
    const wpx = p.w != null ? p.w * W : box.w;
    const hpx = p.h != null ? p.h * H : box.h;
    const g = Dom.svg('g', {
      class: 'rack-marker' + (p.kind === 'device' ? ' device' : '')
        + (stale ? ' stale' : '') + (selected ? ' selected' : ''),
      transform: `translate(${p.x * W},${p.y * H}) rotate(${p.rot || 0})`,
    });
    for (const el of DeviceShapes.glyph(type, wpx, hpx)) g.append(el);
    const title = Dom.svg('title');
    title.textContent = (p.kind === 'rack' ? 'Rack: ' : 'Device: ') + (p.label || '?')
      + (stale ? ' (not in latest sync)' : '');
    g.append(title);

    if (draggable) {
      g.style.cursor = 'grab';
      g.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.selectedPlacement = p; this.editingLabel = null;
        // In plain edit, selecting a rack is exclusive of every other selection (like the
        // room/arrow/note selectors clear the others): dropping `this.selected` un-promotes the
        // room so the render collapses to the racks-mode topology (no active-layer room; the
        // selected marker draws via _renderActive's selected-placement path), and clearing the
        // arrow/note keeps one selection at a time (so e.g. handleKey's Delete is unambiguous).
        // Racks mode keeps its room highlighted (rackRoom).
        if (!this.placingRacks) { this.selected = null; this.selectedArrow = null; this._endNoteEdit(); }
        this.dragItem = { move: (nx, ny, ev) => {
          let x = nx, y = ny;
          // Snap the centre to the grid (Alt frees it), then keep it in the room.
          if (this.grid.on && !(ev && ev.altKey)) {
            const [iw, ih] = this.dims;
            x = this.grid.snap(x * iw, this.grid.ox) / iw;
            y = this.grid.snap(y * ih, this.grid.oy) / ih;
          }
          const [cx, cy] = Geom.clampToPoly(x, y, room.polygon);
          p.x = +cx.toFixed(5); p.y = +cy.toFixed(5);
          this.markPlacementsDirty(); this.renderActive();
        } };
        this.svg.setPointerCapture(e.pointerId);
        this.render(); this.openPlacementPanel(p, room);   // selection change → full render
      });
      // Hide the marker's move/rotate/resize handles while its label is being edited
      // (the label grows its own handles — two overlapping sets would collide).
      if (selected && this.editingLabel !== p.uid) this._placementHandles(g, s, p, W, H, wpx, hpx);
    } else if (this.copyingLink) {
      // Copy-link tool (view mode): copy this marker's deep-link. Independent of a cached
      // `item.url` — the link resolves from the placement's own kind+id, so it works even for a
      // marker whose live NetBox item hasn't been fetched.
      g.style.cursor = 'copy';
      g.addEventListener('click', (e) => { e.stopPropagation(); this._copyTargetLink(p.kind, p); });
    } else if (item && item.url) {
      g.style.cursor = 'pointer';
      g.addEventListener('click', (e) => { e.stopPropagation(); window.open(item.url, '_blank'); });
    }
    s.append(g);

    // The name rides the shared label engine as a separate, stylable label (drawn
    // on the svg, not the rotated marker group, so it keeps its own rotation). The returned
    // record feeds the caller's `_nudgeLabels` pass, which needs every label drawn first.
    return this._drawPlacementLabel(s, p, hpx, W, H);
  }

  /** Draw a placement's name as an independently movable/stylable label via the shared
   *  Editor label engine. Auto-placed just below the glyph; an optional `labelStyle`
   *  (x/y/rot/size/font/colour/text) overrides. While this placement's label is being
   *  edited it gains move/rotate/resize handles (keyed by the placement uid).
   *
   *  Returns a record for the caller's `_nudgeLabels` pass. `movable` marks a label still sitting
   *  where we put it — no `labelStyle` x/y/rot — so nudging it only refines our own guess and never
   *  overrides a position the user chose. An immovable label still rides along: it can't be pushed,
   *  but the pass routes the others around it. */
  _drawPlacementLabel(s, p, hpx, W, H) {
    const ls = p.labelStyle || {};
    // Racks carry their name centered inside the (filled) box; devices sit it just
    // below the glyph. `inside` only holds at the default position — a moved label
    // (custom x/y) reverts to the haloed style so it stays legible over the plan.
    const inside = p.kind === 'rack' && ls.x == null && ls.y == null;
    const lcx = ls.x != null ? ls.x : p.x;
    const lcy = ls.y != null ? ls.y : (inside ? p.y : p.y + (hpx / 2 + 10) / H);
    const sizePx = ls.size || (p.kind === 'rack' ? RACK_LABEL_PX : DEVICE_LABEL_PX);
    // A device's name floats over the plan raster with nothing behind it, so it gets an opaque
    // chip; a rack's sits on its own filled box and keeps the established treatment.
    const chip = p.kind !== 'rack';
    const t = Dom.svg('text', { class: 'rack-label' + (inside ? ' inside' : '') + (chip ? ' chip' : ''),
      'text-anchor': 'middle', 'dominant-baseline': 'central' });
    t.style.fontSize = sizePx + 'px';
    this._setLabelLines(t, (ls.text != null ? ls.text : (p.label || '?')).split('\n'));
    const g = this.attachLabel(s, p, t, lcx, lcy, sizePx, W, H);
    // A rack's `inside` name is bound to its (shrinking) box, so opt it out of the zoomed-out
    // legibility floor — flooring it would overflow the box. A moved rack label drops `.inside`,
    // floats over the plan, and floors like every other label. (`t.parentNode` is the scale group.)
    if (inside) t.parentNode.style.setProperty('--label-floor', '0');
    // Measure ONCE and hand the box to both consumers. `getBBox` forces an SVG layout flush, and
    // these run interleaved with the DOM writes above — so a second read per label would double
    // the thrash on a floor full of markers, and `_drawRoomPlacements` repeats this per drag frame.
    const bb = this._labelBox(t);
    if (chip) this._chipBackdrop(t, bb);
    // An `inside` label is anchored to its rack's own box, so it can never be pushed — but it is
    // still real ink a device's name must not land on, so it rides along as an obstacle.
    return { g, bb, x: lcx * W, y: lcy * H,
             movable: !inside && ls.x == null && ls.y == null && !ls.rot };
  }

  /** A label's laid-out text box, or null when it can't be measured — an empty label, or an svg
   *  that isn't displayed (`getBBox` throws on a hidden tree). Both the chip and the nudge treat
   *  null as "skip", so neither depends on the label being on screen. */
  _labelBox(t) {
    let bb;
    try { bb = t.getBBox(); } catch (e) { return null; }
    return bb.width && bb.height ? bb : null;
  }

  /** Insert an opaque rounded chip behind a label's text, sized to the text's own `bb`. This is
   *  what stops a device name from colliding with the room name printed in the plan underneath:
   *  the halo it replaces only outlines the glyphs, so plan ink still shows through between them.
   *  Inserted before the text within the text's `.label-scale` group (so it paints behind the text
   *  and counter-scales with it); edit handles live on the outer group and still paint on top. */
  _chipBackdrop(t, bb) {
    if (!bb) return;
    // Insert into the text's own parent (the `.label-scale` group) so the chip counter-scales with
    // the text under the legibility floor — the two stay locked at every zoom without a re-measure.
    t.parentNode.insertBefore(Dom.svg('rect', {
      x: +(bb.x - CHIP_PAD_X).toFixed(2), y: +(bb.y - CHIP_PAD_Y).toFixed(2),
      width: +(bb.width + CHIP_PAD_X * 2).toFixed(2),
      height: +(bb.height + CHIP_PAD_Y * 2).toFixed(2),
      rx: 2.5, class: 'label-chip',
    }), t);
  }

  /** Push auto-placed labels apart so a room dense with APs doesn't stack their names on top of
   *  each other. Greedy and order-dependent by design: each label in draw order takes the first
   *  free slot at (or symmetrically near) its anchor, and becomes an obstacle for the rest.
   *
   *  This is a **render-time layout pass, not an edit**: it rewrites the group's transform and
   *  never touches `labelStyle`, so it cannot dirty the placement store, can't desync its
   *  optimistic-concurrency version, and can't leak into the normalized-0..1 geometry. A label the
   *  user has positioned (`movable` false) is an immovable obstacle — the others move around it. */
  _nudgeLabels(labels) {
    const offsets = [0];
    for (let i = 1; i <= LABEL_NUDGE_MAX_STEPS; i++)
      offsets.push(i * LABEL_NUDGE_STEP, -i * LABEL_NUDGE_STEP);   // below first, then above
    const taken = [];
    for (const L of labels) {
      if (!L.bb) continue;   // unmeasurable (empty label / hidden svg) — nothing to place
      const box = { x: L.x + L.bb.x - LABEL_NUDGE_PAD, y: L.y + L.bb.y - LABEL_NUDGE_PAD,
                    w: L.bb.width + LABEL_NUDGE_PAD * 2, h: L.bb.height + LABEL_NUDGE_PAD * 2 };
      if (!L.movable) { taken.push(box); continue; }
      const free = offsets.find(dy => !taken.some(b => this._boxesOverlap(b, box, dy)));
      // Nowhere clear within the drift budget: leave it at its anchor. A label flung far from its
      // glyph reads as naming a *different* marker, which is worse than an overlap.
      const dy = free || 0;
      if (dy) L.g.setAttribute('transform', `translate(${L.x},${L.y + dy})`);
      taken.push({ ...box, y: box.y + dy });
    }
  }

  /** Axis-aligned overlap test between a settled label box `a` and candidate box `b` shifted down
   *  by `dy`. Touching edges don't count as overlapping (the boxes already carry their padding). */
  _boxesOverlap(a, b, dy = 0) {
    const by = b.y + dy;
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < by + b.h && by < a.y + a.h;
  }

  /** Rotate handle (above the top edge) + resize handle (bottom-right corner) for
   *  the selected marker. Both reuse the Editor `dragItem` channel; their geometry
   *  is local to the rotated group, but the math works in display px around the
   *  marker centre so it is rotation-correct. */
  _placementHandles(g, s, p, W, H, wpx, hpx) {
    const ry = -hpx / 2 - 16;
    g.append(Dom.svg('line', { x1: 0, y1: -hpx / 2, x2: 0, y2: ry, class: 'rack-stem' }));
    const rot = Dom.svg('circle', { cx: 0, cy: ry, r: 5, class: 'rack-handle' });
    rot.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.dragItem = { move: (nx, ny, ev) => {
        const dx = (nx - p.x) * W, dy = (ny - p.y) * H;
        let deg = Math.atan2(dy, dx) * 180 / Math.PI + 90;
        if (!(ev && ev.altKey)) deg = Math.round(deg / ANGLE_STEP) * ANGLE_STEP;   // Alt frees rotation
        p.rot = ((Math.round(deg) % 360) + 360) % 360;
        this.markPlacementsDirty(); this.renderActive();
      } };
      this.svg.setPointerCapture(e.pointerId);
    });
    g.append(rot);

    const size = Dom.svg('rect', { x: wpx / 2 - 4, y: hpx / 2 - 4, width: 8, height: 8, class: 'rack-handle' });
    size.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const rad = (p.rot || 0) * Math.PI / 180, cs = Math.cos(rad), si = Math.sin(rad);
      this.dragItem = { move: (nx, ny, ev) => {
        const ex = (nx - p.x) * W, ey = (ny - p.y) * H;          // pointer rel. to centre (px)
        const lx = ex * cs + ey * si, ly = -ex * si + ey * cs;   // un-rotate into the marker's frame
        let w = Math.max(MIN_PLACEMENT_PX, 2 * Math.abs(lx)) / W;
        let h = Math.max(MIN_PLACEMENT_PX, 2 * Math.abs(ly)) / H;
        // Quantize the footprint to the grid (offset 0 — this snaps a size, not a
        // position); Alt frees it. Floored at MIN_PLACEMENT_PX, not a whole grid cell,
        // so a marker can still shrink well below one cell on a large-step grid.
        if (this.grid.on && !(ev && ev.altKey)) {
          const [iw, ih] = this.dims;
          w = Math.max(MIN_PLACEMENT_PX, this.grid.snap(w * iw, 0)) / iw;
          h = Math.max(MIN_PLACEMENT_PX, this.grid.snap(h * ih, 0)) / ih;
        }
        p.w = +w.toFixed(5); p.h = +h.toFixed(5);
        this.markPlacementsDirty(); this.renderActive();
      } };
      this.svg.setPointerCapture(e.pointerId);
    });
    g.append(size);
  }

  // ---- drawing actions ----
  /** Drawing always clears the selected arrow/note (starting a room, arrow or note). */
  beginDraw(msg, kind) { this.selectedArrow = null; this.selectedNote = null; super.beginDraw(msg, kind); }

  finish() {
    // A single-point tool has nothing to commit until its click has landed — but Enter can reach
    // finish() first, while the draft is still empty (its finisher would read points[0] of
    // nothing). Cancel the draft instead, as Enter already does for an under-full polygon.
    if (SINGLE_POINT_KINDS.has(this.draft.kind) && !this.draft.points.length) {
      this.draft = null; this.render(); return;
    }
    if (this.draft.kind === 'arrow') return this._finishArrow();
    if (this.draft.kind === 'note') return this._finishNote();
    if (this.draft.kind === 'ap') return this._finishAp();
    const dp = this.draft.points;
    if (dp.length < 3) { this.draft = null; this.render(); return; }
    this.snapshot();
    const room = { id: Util.uid(), label: '', polygon: dp.slice(), location: null };
    this.data().rooms.push(room);
    this.draft = null; this.selected = room.id; this.markDirty();
    this.render(); this.openRoomPanel(room);
  }

  /** Commit a rectangle-tool box into a new room (mirrors finish()/duplicateRoom). */
  _commitRect(poly) {
    this.snapshot();
    const room = { id: Util.uid(), label: '', polygon: poly, location: null };
    this.data().rooms.push(room);
    this.selected = room.id; this.markDirty();
    this.render(); this.openRoomPanel(room);
  }

  // ---- route arrows (wayfinding) ----
  beginArrow() {
    this.beginDraw('Click points along the route · Enter/double-click to finish at the room · Esc to cancel', 'arrow');
  }

  /** Close the arrow draft into a route. Drops a trailing duplicate point (the click
   *  that precedes a double-click already added it) and needs ≥ 2 points. */
  _finishArrow() {
    const dp = this.draft.points;
    const n = dp.length;
    if (n >= 2 && dp[n - 1][0] === dp[n - 2][0] && dp[n - 1][1] === dp[n - 2][1]) dp.pop();
    if (dp.length < 2) { this.draft = null; this.render(); return; }
    this.snapshot();
    const arrow = { id: Util.uid(), points: dp.slice(), room: null, label: '', color: ARROW_COLORS[0] };
    this._bindArrowDest(arrow);
    this.data().arrows.push(arrow);
    this.draft = null; this.selected = null; this.selectedArrow = arrow; this.markDirty();
    this.render(); this.openArrowPanel(arrow);
  }

  /** Auto-bind the arrow's destination to the room its arrowhead (last point) lands
   *  in, or null. Re-run whenever the route is reshaped so the binding stays fresh. */
  _bindArrowDest(arrow) {
    const last = arrow.points[arrow.points.length - 1];
    const hit = this.data().rooms.find(r => Geom.pointInPoly(last[0], last[1], r.polygon));
    arrow.room = hit ? hit.id : null;
  }

  selectArrow(arrow) {
    this._endNoteEdit();   // selecting an arrow ends any in-progress note edit
    this.selected = null; this.selectedPlacement = null; this.editingLabel = null; this.selectedArrow = arrow;
    this.render(); this.openArrowPanel(arrow);
  }

  deleteArrow(arrow) {
    this.snapshot();
    const arr = this.data().arrows;
    const i = arr.indexOf(arrow);
    if (i >= 0) arr.splice(i, 1);
    this.selectedArrow = null; this.editingLabel = null; this.markDirty(); this.render(); this.app.closePanel();
  }

  // ---- free-standing text notes ----
  // A note is a single-point shape whose only content is its label text
  // ({id,x,y,labelStyle:{text,font,size,rot,color,x,y}}). It rides the shared label
  // engine (attachLabel/openLabelPanel) — the note IS its label — and lives in the
  // per-floor `notes` array (annotations blob). An empty note is never persisted.

  /** Arm the text-note tool: the next map click drops a note there and opens its label
   *  editor (the base draft state machine finishes a `note` draft on its first click). */
  beginNote() {
    this.beginDraw('Click on the map to place a text note · Esc to cancel', 'note');
  }

  /** Close the one-point note draft into a note record and open its label editor. */
  _finishNote() {
    const [x, y] = this.draft.points[0];
    this.draft = null;
    this.snapshot();
    const note = { id: Util.uid(), x, y };
    this.data().notes.push(note);
    this.markDirty();
    this._editNote(note);
  }

  /** Enter label-edit for a note via the shared label engine (keyed by the note id) and
   *  focus the text field. The panel carries a "Delete note" button and a note-aware
   *  "Reset to auto" (keeps the text, resets only the styling). Closing the panel
   *  (Done / Esc / ✕) still drops the note when it was left with no text. */
  _editNote(note) {
    this._endNoteEdit();   // drop a previous, still-empty note when switching between notes
    this.selected = null; this.selectedArrow = null; this.selectedPlacement = null; this.selectedNote = note;
    this.editingLabel = note.id;
    this.render();
    this.openLabelPanel(note, () => this.app.closePanel(), '',
      { keepText: true, onDelete: () => this.deleteNote(note) });
    const ta = Dom.$('#panel-body .label-ctl.text');
    if (ta) ta.focus();
  }

  /** Delete a note outright (explicit button / Delete key), independent of whether it has
   *  text — modelled on `deleteArrow`. Clearing `selectedNote` first makes the following
   *  `closePanel` → `onPanelClosed` a no-op rather than a second drop attempt. */
  deleteNote(note) {
    this.snapshot();
    const notes = this.data().notes;
    const i = notes.indexOf(note);
    if (i >= 0) notes.splice(i, 1);
    this.selectedNote = null; this.editingLabel = null; this.markDirty(); this.render(); this.app.closePanel();
  }

  /** End any in-progress note edit before a *different* shape takes the selection: drop the
   *  note if it was left empty, and clear its edit state. The caller opens its own panel, so
   *  this neither renders nor closes the panel. */
  _endNoteEdit() {
    if (!this.selectedNote) return;
    const note = this.selectedNote;
    this.selectedNote = null;
    if (this.editingLabel === note.id) this.editingLabel = null;
    this._dropEmptyNote(note);
  }

  /** True when a note carries no visible text (an empty note is nothing). */
  _noteEmpty(note) { return !(note.labelStyle && note.labelStyle.text && note.labelStyle.text.trim()); }

  /** Remove a note from the floor if it has no text (marking the store dirty). Pure —
   *  the caller re-renders / closes the panel. */
  _dropEmptyNote(note) {
    if (!this._noteEmpty(note)) return;
    const notes = this.data().notes;
    const i = notes.indexOf(note);
    if (i >= 0) { notes.splice(i, 1); this.markDirty(); }
  }

  /** Draw every note into the static layer, skipping the one being edited (it renders in
   *  the active layer so its label drag/handles repaint per frame). */
  _drawNotes(s, W, H, skipSelected) {
    for (const note of this.data().notes) {
      if (skipSelected && note === this.selectedNote) continue;
      this._drawNote(s, note, W, H);
    }
  }

  /** Draw one note as haloed text via the shared label engine. An empty note is invisible
   *  except while being edited (a muted placeholder then marks the spot so the drop and its
   *  handles are visible). In edit mode a note that isn't being edited is click-to-edit; in
   *  view mode notes are inert. */
  _drawNote(s, note, W, H) {
    const ls = note.labelStyle || {};
    const raw = ls.text != null ? ls.text : '';
    const editingThis = this.editingLabel === note.id;
    if (raw.trim() === '' && !editingThis) return;
    const placeholder = raw.trim() === '' && editingThis;
    const sizePx = ls.size || 14;
    const lcx = ls.x != null ? ls.x : note.x;
    const lcy = ls.y != null ? ls.y : note.y;
    const t = Dom.svg('text', { class: 'note-label' + (placeholder ? ' placeholder' : ''),
      'text-anchor': 'middle', 'dominant-baseline': 'central' });
    t.style.fontSize = sizePx + 'px';
    this._setLabelLines(t, (placeholder ? 'New note' : raw).split('\n'));
    this.attachLabel(s, note, t, lcx, lcy, sizePx, W, H);
    if (this.editing() && !this.placingRacks && !editingThis) {
      t.style.pointerEvents = 'auto'; t.style.cursor = 'pointer';
      t.addEventListener('click', (e) => { e.stopPropagation(); if (!this.draft) this._editNote(note); });
    }
  }

  /** Draw each route: a fat transparent hit line (edit only), the coloured polyline,
   *  an arrowhead at the destination end, and an optional note at the start. The
   *  selected arrow grows editable nodes. View-mode arrows are inert overlays. */
  _drawArrows(s, W, H, skipSelected) {
    const editing = this.editing();
    for (const a of this.data().arrows) {
      if (skipSelected && a === this.selectedArrow) continue;   // selected arrow → active layer
      this._drawArrow(s, a, W, H, editing);
    }
  }

  /** Draw one route into `s`. Shared by the static loop and the active-layer draw of
   *  the selected arrow — the `.selected` styling + editable nodes key off
   *  `this.selectedArrow`, so they appear only for the selected route either way. */
  _drawArrow(s, a, W, H, editing) {
    if (!a.points || a.points.length < 2) return;
    const color = a.color || ARROW_COLORS[0];
    const pts = a.points.map(p => `${p[0] * W},${p[1] * H}`).join(' ');

    if (editing) {
      const hit = Dom.svg('polyline', { points: pts, class: 'arrow-hit', fill: 'none' });
      hit.addEventListener('click', (e) => { e.stopPropagation(); if (!this.draft) this.selectArrow(a); });
      s.append(hit);
    }
    const n = a.points.length, p0 = a.points[n - 2], p1 = a.points[n - 1];
    // The visible line stops at the arrowhead's base centre (pulled back ARROW_HEAD_PX
    // toward p0) so its round end-cap doesn't poke past the opaque triangle tip. Clamp
    // the pull to the last segment so a short final hop can't flip the point past p0.
    let dx = (p1[0] - p0[0]) * W, dy = (p1[1] - p0[1]) * H;
    const len = Math.hypot(dx, dy) || 1, pull = Math.min(ARROW_HEAD_PX, len);
    const cx = p1[0] * W - dx / len * pull, cy = p1[1] * H - dy / len * pull;
    const linePts = a.points.slice(0, n - 1).map(p => `${p[0] * W},${p[1] * H}`)
      .concat(`${cx},${cy}`).join(' ');
    const line = Dom.svg('polyline', { points: linePts, fill: 'none',
      class: 'arrow' + (editing && a === this.selectedArrow ? ' selected' : '') });
    line.style.stroke = color;
    line.style.pointerEvents = 'none';   // all hit-testing goes through .arrow-hit (edit only)
    s.append(line);

    const tri = Geom.arrowHead(p0[0] * W, p0[1] * H, p1[0] * W, p1[1] * H, ARROW_HEAD_PX);
    const head = Dom.svg('polygon', { points: tri.map(p => p.join(',')).join(' '), class: 'arrow-head' });
    head.style.fill = color; head.style.pointerEvents = 'none';
    s.append(head);

    this._drawArrowLabel(s, a, W, H);

    // Suppress the editable nodes while this arrow's label is being moved/styled.
    if (editing && a === this.selectedArrow && this.editingLabel !== this._labelKey(a))
      this.drawVertices(s, a.points, W, H, a.id,
        () => { this._bindArrowDest(a); this.markDirty(); }, { closed: false, minPts: 2 });
  }

  /** Draw a route's note as an independently movable/stylable label via the shared
   *  Editor label engine. Auto-placed just above the arrow's start point; an optional
   *  `labelStyle` (x/y/rot/size/font/colour/text) overrides. Rendered only when there
   *  is text (notes are optional). While this arrow's label is being edited it gains
   *  move/rotate/resize handles (keyed by the arrow id). */
  _drawArrowLabel(s, a, W, H) {
    const ls = a.labelStyle || {};
    if (!((ls.text != null && ls.text !== '') || a.label)) return;
    const [sx, sy] = a.points[0];
    const sizePx = ls.size || 13;
    const lcx = ls.x != null ? ls.x : sx;
    const lcy = ls.y != null ? ls.y : sy - (sizePx * 0.7 + 4) / H;   // just above the start
    const t = Dom.svg('text', { class: 'arrow-label', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
    t.style.fontSize = sizePx + 'px';
    t.style.fill = '#000';   // default = black; attachLabel overrides if labelStyle.color
    this._setLabelLines(t, (ls.text != null ? ls.text : a.label).split('\n'));
    this.attachLabel(s, a, t, lcx, lcy, sizePx, W, H);
  }

  /** Side panel for a selected route: its auto-detected destination, an editable
   *  note, a colour swatch row, and delete. */
  openArrowPanel(arrow) {
    const panel = Dom.$('#panel'); panel.classList.remove('hidden');
    Dom.$('#panel-title').textContent = 'Route arrow';
    const body = Dom.$('#panel-body'); body.innerHTML = '';

    const dest = arrow.room && this.data().rooms.find(r => r.id === arrow.room);
    body.append(Dom.el('div', { class: 'field' }, [
      Dom.el('label', {}, 'Destination (at the arrowhead)'),
      Dom.el('div', { class: 'val' }, dest ? (dest.label || '(unbound room)') : '(arrowhead is not over a room)'),
    ]));

    const note = Dom.el('input', { placeholder: 'e.g. Enter from the north stairwell' });
    note.value = arrow.label || '';
    note.oninput = () => { arrow.label = note.value; this.markDirty(); this.render(); };
    body.append(Dom.el('div', { class: 'field' }, [Dom.el('label', {}, 'Note (shown at the start)'), note]));

    const swatches = Dom.el('div', { class: 'swatch-row' }, ARROW_COLORS.map(c => {
      const sw = Dom.el('button', { class: 'swatch' + (c === (arrow.color || ARROW_COLORS[0]) ? ' on' : ''),
        title: c }); sw.style.background = c;
      sw.onclick = () => { arrow.color = c; this.markDirty(); this.render(); this.openArrowPanel(arrow); };
      return sw;
    }));
    body.append(Dom.el('div', { class: 'field' }, [Dom.el('label', {}, 'Colour'), swatches]));

    // Always offered: even a note-less arrow can carry a display-only label via
    // labelStyle.text (openLabelPanel), matching how rooms/placements behave.
    body.append(Dom.el('button', { class: 'wide', onclick: () => this.editArrowLabel(arrow),
      html: Icons.edit + '<span>Edit label</span>' }));

    body.append(Dom.el('div', { class: 'hint' },
      'Drag a node to bend · midpoint adds a turn · right-click removes.'));
    body.append(Dom.el('button', { class: 'wide danger', onclick: () => this.deleteArrow(arrow) }, 'Delete arrow'));
  }

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
    body.append(Dom.el('button', { class: 'wide', onclick: () => exporter.downloadPng(),
      html: Icons.download + '<span>Download PNG</span>' }));
    body.append(Dom.el('button', { class: 'wide', onclick: () => exporter.downloadSvg(),
      html: Icons.download + '<span>Download SVG</span>' }));
    body.append(Dom.el('button', { class: 'wide', onclick: () => window.print(),
      html: Icons.print + '<span>Print…</span>' }));
  }

  /** Enter label-edit for a route: the note grows move/rotate/resize handles and the
   *  shared style panel opens. Done/Escape return to the arrow panel. */
  editArrowLabel(arrow) {
    this.selectedArrow = arrow; this.editingLabel = this._labelKey(arrow);
    this.render();
    this.openLabelPanel(arrow, () => {
      this.editingLabel = null; this.render(); this.openArrowPanel(arrow);
    }, arrow.label || '');
  }

  /** Build off an existing room: clone its (nudged) shape as a new room. */
  duplicateRoom(src) {
    this.snapshot();
    const off = 0.01;
    const poly = src.polygon.map(p => [+Math.min(1, p[0] + off).toFixed(5), +Math.min(1, p[1] + off).toFixed(5)]);
    const room = { id: Util.uid(), label: '', polygon: poly, location: null };
    this.data().rooms.push(room);
    this.selected = room.id; this.markDirty();
    this.todo && this.todo.syncRooms(this.data().rooms);
    this.render(); this.openRoomPanel(room);
    Toast.show('Duplicated. Drag vertices to reshape (snaps to the original).');
  }

  deleteRoom(room) {
    this.snapshot();
    const rooms = this.data().rooms;
    const i = rooms.indexOf(room);
    if (i >= 0) rooms.splice(i, 1);
    this.selected = null; this.markDirty();
    this.todo && this.todo.syncRooms(this.data().rooms);
    this.render(); this.app.closePanel();
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
      const mismatch = Math.abs(geom.W / geom.H - srcAspect) > 0.02;
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
   *  target floor's pre-copy rooms, which _restoreState reverts (the current floor is
   *  unchanged by the copy, so its half of the snapshot is a harmless identity restore). */
  copyRoomsToFloor(targetFloor, scope) {
    const rooms = this.data().rooms;
    const src = scope === 'selected' ? rooms.filter(r => r.id === this.selected) : rooms;
    if (!src.length) { Toast.show('Nothing to copy'); return; }
    const dest = this.store.floorData(this.building.dir, targetFloor.id);
    const snap = this._snapshotState();
    snap.extraFloor = { key: Util.floorKey(this.building.dir, targetFloor.id),
      rooms: JSON.parse(JSON.stringify(dest.rooms)) };
    this.history.push(snap);
    for (const r of src)
      dest.rooms.push({ id: Util.uid(), label: '', polygon: r.polygon.map(p => [p[0], p[1]]), location: null });
    this.markDirty();
    Toast.show('Copied ' + src.length + ' room' + (src.length === 1 ? '' : 's')
      + ' to ' + targetFloor.label + ' (unbound). Save to keep.');
    this.app.closePanel();
  }

  // ---- access-point tool (DEV-1) ----
  // Creates a real NetBox Device and drops a marker for it in one gesture. The AP is NOT a new
  // placement kind: it commits an ordinary `kind:'device'` placement, so marker drawing, dragging,
  // the label engine, the placement panel and the wayfinding finder all handle it unchanged.

  /** Arm the access-point tool: the next map click inside a room creates an AP there (the base
   *  draft state machine finishes an `ap` draft on its first click, exactly as a note does —
   *  which is also what keeps pan gestures and placement clicks from fighting, for free). */
  beginAp() {
    this.beginDraw('Click inside a room to add an access point · Esc to cancel', 'ap');
  }

  /** Close the one-point AP draft: resolve the room under the click, create the Device in NetBox,
   *  then commit a device placement at the clicked point.
   *
   *  Nothing is written to the store until the create has actually succeeded — a dead click, a
   *  cancelled modal or a failed POST must leave the document untouched AND unflagged, since a
   *  stray dirty flip falsely fires the unsaved-work nav guard (§10). A click that lands nowhere
   *  useful re-arms the tool rather than dying silently: the user meant to place an AP, and the
   *  miss is theirs to correct. */
  async _finishAp() {
    const [x, y] = this.draft.points[0];
    this.draft = null;
    this.render();
    const room = this.data().rooms.find(r => Geom.pointInPoly(x, y, r.polygon));
    if (!room) { Toast.show('Click inside a room to place an access point.', true); return this.beginAp(); }
    if (!room.location) {
      Toast.show('That room isn’t bound to a NetBox Location yet — bind it first, then place the access point.', true);
      return this.beginAp();
    }
    let name = '';
    try {
      name = (await this.netbox.suggestDeviceName(room.location.id)).name;
    } catch (e) {
      Toast.show('NetBox: ' + e.message, true); return;
    }
    // The modal owns the create itself, so a rejected name/asset tag can be corrected in place
    // rather than closing the dialog and losing what was typed. It resolves the created Device,
    // or null when the user backed out.
    const device = await this._apModal(name, room);
    if (!device) return;
    // Force-repull the Location's inventory so _cacheItem resolves the new Device and the marker
    // renders with its real role glyph. Pulling (rather than hand-pushing into store.rackCache)
    // keeps the cache the server's answer, not our guess at it.
    //
    // A failed repull does NOT abort the placement: the Device exists in NetBox by now, so
    // dropping it here would orphan a real record and throw away the gesture. Without the pull
    // _cacheItem just finds nothing and the marker draws as stale — which the placement UI already
    // handles — so committing and warning degrades far better than silently placing nothing.
    let warned = false;
    try {
      await this.store.ensureRacks(this.netbox, room.location.id, true);
    } catch (e) {
      warned = true;
      Toast.show('Created ' + device.name + ', but its details could not be loaded: ' + e.message
        + '. Refresh the room to update the marker.', true);
    }
    this.snapshot();
    const [cx, cy] = Geom.clampToPoly(x, y, room.polygon);
    const p = { id: device.id, kind: 'device', room: room.id, loc: room.location.id,
      x: +cx.toFixed(5), y: +cy.toFixed(5), label: device.name, uid: Util.uid() };
    this.store.placementData(this.building.dir, this.floor.id).placements.push(p);
    this.selectedPlacement = p;   // ready to drag / rotate / resize immediately
    this.markPlacementsDirty(); this.render();
    // The placement panel, not the room's rack list: the user placed one specific device.
    this.openPlacementPanel(p, room);
    // Toast is a single element, so don't clobber the repull warning with the success line.
    if (!warned) Toast.show('Created ' + device.name + '. Save to keep it on the map.');
  }

  /** The AP create dialog (device type / optional asset tag / name), resolving the created Device
   *  or null if the user backed out. Reuses the shared `.fm-modal` pattern (mirrors the base's
   *  `_confirmLeaveEdit`).
   *
   *  It drives the POST itself and stays open on a 400 — a duplicate name or asset tag is a
   *  correctable mistake, and the server is the only thing that knows about the clash, so bouncing
   *  the user out of the dialog would throw away the rest of what they typed to fix one field. The
   *  Device already exists in NetBox once this resolves; the *placement* is what's still unsaved.
   *
   *  The asset tag sits **above** the name because that is the order it's really filled in: tag
   *  first, then the name settles from it. When the operator's template uses `{asset_tag}` (DEV-6)
   *  editing the tag re-asks the server for the suggestion, so the name is always one the server's
   *  `-NN` counter and free-name probe have actually vetted — see `_wireApNameFromTag`. */
  _apModal(suggestedName, room) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (device) => { if (done) return; done = true; overlay.remove(); resolve(device); };
      const stored = this._loadApDeviceType();   // last-used device type, pre-filled below (UX-1)
      let dtype = stored;
      const combo = new Combo({
        value: stored,
        placeholder: 'Search device types…',
        load: (q) => this.netbox.deviceTypes(q).then((r) => {
          const opts = r.device_types.map(t => ({ id: t.id, name: t.manufacturer + ' ' + t.model }));
          // The unfiltered focus-open load (q === '', already fired below via combo.input.focus())
          // doubles as a cheap confirmation of the pre-filled last-used type: if a stale preference
          // (its device type was deleted in NetBox since last use) isn't in it, drop it now rather
          // than let Create fail on a dead id. `dtype === stored` means this only ever fires for the
          // original pre-fill — it self-disarms the moment the user picks anything.
          if (q === '' && stored && dtype === stored && !opts.some(o => o.id === stored.id)) {
            dtype = null;
            combo.reset();
            this._clearApDeviceType();
          }
          return opts;
        }),
        onPick: (opt) => { dtype = opt; },
      });
      const nameInput = Dom.el('input', { class: 'fm-text', value: suggestedName });
      const tagInput = Dom.el('input', { class: 'fm-text', placeholder: 'Optional' });
      this._wireApNameFromTag(tagInput, nameInput, room);
      const err = Dom.el('div', { class: 'fm-modal-error' });
      err.style.display = 'none';
      const showErr = (msg) => { err.textContent = msg; err.style.display = ''; };
      const create = Dom.el('button', { class: 'primary' }, 'Create access point');
      create.onclick = async () => {
        if (!dtype) return showErr('Pick a device type.');
        if (!nameInput.value.trim()) return showErr('A device name is required.');
        create.disabled = true;
        try {
          const device = await this.netbox.createDevice({
            location: room.location.id, device_type: dtype.id,
            name: nameInput.value.trim(), asset_tag: tagInput.value.trim(),
          });
          this._saveApDeviceType(dtype);
          finish(device);
        } catch (e) {
          showErr(e.message); create.disabled = false;
        }
      };
      const field = (label, control) => Dom.el('div', { class: 'field' },
        [Dom.el('label', {}, label), control]);
      const overlay = Dom.el('div', { class: 'fm-modal', onclick: (e) => { if (e.target === overlay) finish(null); } }, [
        Dom.el('div', { class: 'fm-modal-panel' }, [
          Dom.el('h3', {}, 'Add access point'),
          Dom.el('p', {}, 'Creates a new unracked device in ' + room.location.name
            + ' and places it where you clicked.'),
          field('Device type', combo.el),
          field('Asset tag', tagInput),
          field('Name', nameInput),
          err,
          Dom.el('div', { class: 'fm-modal-actions' }, [
            Dom.el('button', { onclick: () => finish(null) }, 'Cancel'),
            create,
          ]),
        ]),
      ]);
      document.body.append(overlay);
      // Focus the device type, not the prefilled name: it's the field most likely to need
      // changing, and focusing the combo opens its list, so the catalogue is discoverable by eye
      // (this also runs the pre-fill's staleness check above, via the unfiltered focus-open load).
      combo.input.focus();
    });
  }

  /** The persisted last-used AP device type `{id,name}` (UX-1), or `null` if never set, corrupt,
   *  or storage is disabled. Pre-fills `_apModal`'s Combo so a repeat placement doesn't require
   *  searching again. */
  _loadApDeviceType() {
    try {
      const raw = localStorage.getItem(AP_DEVICE_TYPE_KEY);
      const v = raw ? JSON.parse(raw) : null;
      return (v && v.id && v.name) ? v : null;
    } catch (e) { return null; }
  }
  _saveApDeviceType(dtype) {
    try { localStorage.setItem(AP_DEVICE_TYPE_KEY, JSON.stringify({ id: dtype.id, name: dtype.name })); }
    catch (e) { console.warn('ap device type: could not persist preference', e); }
  }
  _clearApDeviceType() {
    try { localStorage.removeItem(AP_DEVICE_TYPE_KEY); } catch (e) {}
  }

  /** Keep `_apModal`'s name field derived from its asset-tag field, for a template that uses
   *  `{asset_tag}` (DEV-6). A no-op for any other template — the overwhelmingly common case pays
   *  nothing and issues exactly the one request it always did.
   *
   *  The re-derive asks the *server* rather than substituting here, because the suggestion is more
   *  than a string swap: the server appends the scoped `-NN` counter and probes the site for a free
   *  name, and both must see the real tag or they vet a name nobody saves.
   *
   *  Two things it must not do. It must not fight the user: once the name has been hand-edited it
   *  stops deriving for the life of the dialog, so a deliberate name is never clobbered by a later
   *  keystroke in the tag field. And it must not let a slow reply overwrite a newer one — replies
   *  can land out of order, so each is stamped and a stale one is dropped. A failed re-derive keeps
   *  the last good name and warns to the console rather than toasting per keystroke: the name is
   *  only a suggestion, and a genuine problem still surfaces loudly on Create. */
  _wireApNameFromTag(tagInput, nameInput, room) {
    if (!this.app.apNameTemplate.includes('{asset_tag}')) return;
    let edited = false;
    nameInput.addEventListener('input', () => { edited = true; });
    let timer = null;
    let seq = 0;
    tagInput.addEventListener('input', () => {
      if (edited) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const mine = ++seq;
        try {
          const r = await this.netbox.suggestDeviceName(room.location.id, tagInput.value);
          if (mine === seq && !edited) nameInput.value = r.name;
        } catch (e) {
          console.warn('Could not re-derive the access point name:', e.message);
        }
      }, 250);
    });
  }

  // ---- NetBox binding panel ----
  async loadNbRooms() {
    const key = Util.floorKey(this.building.dir, this.floor.id);
    if (this.store.nbRoomsByFloor[key]) return this.store.nbRoomsByFloor[key];
    try {
      const res = await this.netbox.rooms(this.building.siteSlug, this.floor.id);
      this.store.nbRoomsByFloor[key] = res;
      return res;
    } catch (e) { Toast.show('NetBox: ' + e.message, true); return { rooms: [] }; }
  }

  async openRoomPanel(room) {
    const panel = Dom.$('#panel'); panel.classList.remove('hidden');
    Dom.$('#panel-title').textContent = room.location ? room.label : 'Bind room';
    const body = Dom.$('#panel-body'); body.innerHTML = '';

    body.append(Dom.el('div', { class: 'field' }, [
      Dom.el('label', {}, 'Selected polygon'),
      Dom.el('div', { class: 'val' }, room.location ? room.location.name : '(unbound)'),
      room.location ? Dom.el('div', {}, Dom.el('a', { href: room.location.url, target: '_blank' }, 'open in NetBox ↗')) : null,
    ]));
    body.append(Dom.el('div', { class: 'row' }, [
      Dom.el('button', { onclick: () => { this.snapshot(); room.location = null; room.label = ''; this.markDirty();
        this.todo && this.todo.syncRooms(this.data().rooms);
        this.render(); this.openRoomPanel(room); } }, 'Unbind'),
      Dom.el('button', { class: 'danger', onclick: () => this.deleteRoom(room) }, 'Delete'),
    ]));

    body.append(Dom.el('button', { class: 'wide', onclick: () => this.duplicateRoom(room),
      html: Icons.dup + '<span>Duplicate as new room</span>' }));

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

    const res = await this.loadNbRooms();
    const rooms = res.rooms || [];
    const boundIds = new Set(this.data().rooms.filter(r => r.location).map(r => r.location.id));
    const bl = this._bindList(body, {
      placeholder: 'Search rooms…', items: rooms, limit: 300,
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
      Dom.el('div', { class: 'nm', html: Icons.plus + '<span>Create new room under “' + floor.name + '”</span>' }),
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

  // ---- rack placement panel (racks mode) ----
  /** List the room's synced racks + unracked devices; click a row to place it
   *  (or remove an already-placed one). */
  openRackPanel(room) {
    // Placing racks is nested in edit, so the room being configured stays the selected
    // (highlighted) room — keeping the toggle-on "keep the room selected" behaviour.
    this.selected = room.id;
    const panel = Dom.$('#panel'); panel.classList.remove('hidden');
    Dom.$('#panel-title').textContent = room.label || 'Racks';
    const body = Dom.$('#panel-body'); body.innerHTML = '';

    if (!room.location) {
      body.append(Dom.el('div', { class: 'hint' }, 'Bind this room to a NetBox Location (in Edit mode) before placing racks.'));
      return;
    }

    const refreshBtn = Dom.el('button', { class: 'wide',
      title: "Pull this room's racks & devices from NetBox" });
    refreshBtn.innerHTML = Icons.rack + '<span>Refresh racks</span>';
    refreshBtn.onclick = async () => {
      const restore = refreshBtn.innerHTML;
      refreshBtn.disabled = true; refreshBtn.innerHTML = '<span>Refreshing…</span>';
      try {
        const inv = await this.store.ensureRacks(this.netbox, room.location.id, true);
        Toast.show('Refreshed ' + (room.label || room.location.name)
          + ' · ' + inv.racks.length + ' racks · ' + inv.devices.length + ' devices');
        this.render();             // restyle stale markers against the fresh inventory
        this.openRackPanel(room);  // re-render the list with fresh inventory
      } catch (e) {
        Toast.show('Refresh failed: ' + e.message, true);
        refreshBtn.disabled = false; refreshBtn.innerHTML = restore;
      }
    };
    body.append(refreshBtn);

    // First open of a room fetches its inventory live; re-render the panel when it
    // lands so the lists populate without a manual Refresh click.
    if (!this.store.rackCache.locations[room.location.id]) {
      body.append(Dom.el('div', { class: 'hint' }, 'Loading racks & devices from NetBox…'));
      this.store.ensureRacks(this.netbox, room.location.id)
        .then(() => { this.render(); if (this.rackRoom === room) this.openRackPanel(room); })
        .catch(e => Toast.show('NetBox: ' + e.message, true));
      return;
    }

    const inv = this.store.racksForLocation(room.location.id);
    const pdata = this.store.placementData(this.building.dir, this.floor.id);
    const mine = () => pdata.placements.filter(p => p.room === room.id);
    const placedKey = new Set(mine().map(p => p.kind + ':' + p.id));

    // Inventory has loaded by now (the not-yet-fetched case returned early above), so an empty
    // inv is genuinely empty. Gear is often modeled at the Site/Rack level, not the room
    // Location, so an honest empty-state beats two silent "None." sections reading as broken.
    if (!inv.racks.length && !inv.devices.length) {
      body.append(Dom.el('div', { class: 'hint' },
        'No racks or devices are assigned to this Location in NetBox — gear is often modeled at '
        + 'the Site or Rack level instead. Assign it here, then Refresh.'));
      // Turn the dead-end empty state into a diagnostic: ask NetBox where this room's gear
      // actually lives (an ancestor Location or the Site) and, if found, show how to reassign it.
      const diag = Dom.el('div', { class: 'hint' }, 'Checking nearby Locations…');
      body.append(diag);
      this.netbox.placementNearby(room.location.id)
        .then(res => { if (this.rackRoom === room) this._renderNearbyDiagnostic(diag, res.nearby); })
        .catch(() => diag.remove());   // degrade quietly — the honest empty hint above still stands
      this._appendStalePlacements(body, room, mine);
      return;
    }

    body.append(Dom.el('div', { class: 'hint' },
      'Click an item to drop it in the room, then drag to place. Click a placed (✓) item to '
      + 'select it, then drag to move it or edit its label. Use ✕ to remove it.'));

    const section = (heading, items, kind) => {
      body.append(Dom.el('div', { class: 'field' }, Dom.el('label', {}, heading + ' (' + items.length + ')')));
      if (!items.length) { body.append(Dom.el('div', { class: 'hint' }, 'None.')); return; }
      items.forEach(it => {
        const placed = placedKey.has(kind + ':' + it.id);
        const main = Dom.el('div', { class: 'ri-main' }, [
          Dom.el('div', { class: 'nm' }, it.name + (placed ? '  ✓' : '')),
          Dom.el('div', { class: 'sl' }, kind === 'rack' ? (it.u_height ? it.u_height + 'U rack' : 'rack') : 'device'),
          // Rack description (optional — absent on devices and on stale/unsynced racks).
          kind === 'rack' && it.description ? Dom.el('div', { class: 'sl' }, it.description) : null,
        ]);
        const row = Dom.el('div', { class: 'room-item' + (placed ? ' bound has-remove' : '') }, [main]);
        // A placed row SELECTS its existing marker (never moves/recreates it); a distinct
        // ✕ control removes it, so a row click is no longer destructive. An unplaced row
        // drops a new marker at the room centroid.
        if (placed) {
          row.onclick = () => this.selectPlacement(mine().find(p => p.kind === kind && p.id === it.id), room);
          row.append(this._removeButton(() => mine().find(p => p.kind === kind && p.id === it.id), room));
        } else {
          row.onclick = () => this.placeItem(room, kind, it);
        }
        body.append(row);
      });
    };
    section('Racks', inv.racks, 'rack');
    section('Unracked devices', inv.devices, 'device');

    this._appendStalePlacements(body, room, mine);
  }

  /** Fill the empty-placement diagnostic (PLACE-2): if gear lives on a nearby Location or the
   *  Site rather than this room's Location, name each such scope with its counts linked into the
   *  matching NetBox list, and tell the user to reassign it here. Empty `nearby` → the room truly
   *  has nothing nearby, so drop the placeholder and let the honest empty hint stand. */
  _renderNearbyDiagnostic(box, nearby) {
    if (!nearby || !nearby.length) { box.remove(); return; }
    box.textContent = '';
    box.append(Dom.el('div', {},
      'Some gear is assigned to nearby Locations. To place it in this room, reassign it to this '
      + "room's Location in NetBox:"));
    const count = (n, noun) => n + ' ' + noun + (n === 1 ? '' : 's');
    nearby.forEach(s => {
      const row = Dom.el('div', { class: 'sl' }, s.name + ': ');
      const links = [];
      if (s.racks) links.push(Dom.el('a', { href: s.racks_url, target: '_blank' }, count(s.racks, 'rack')));
      if (s.devices) links.push(Dom.el('a', { href: s.devices_url, target: '_blank' }, count(s.devices, 'device')));
      links.forEach((a, i) => { if (i) row.append(' · '); row.append(a); });
      box.append(row);
    });
  }

  /** Placed items no longer present in the latest sync — offer removal. Shared by the
   *  empty-state and populated rack-panel paths so stale placements stay visible/removable
   *  even when the Location's live inventory came back empty. */
  _appendStalePlacements(body, room, mine) {
    const stale = mine().filter(p => !this._cacheItem(p));
    if (!stale.length) return;
    body.append(Dom.el('div', { class: 'field' }, Dom.el('label', {}, 'Placed, not in latest sync (' + stale.length + ')')));
    stale.forEach(p => {
      const main = Dom.el('div', { class: 'ri-main' }, [
        Dom.el('div', { class: 'nm' }, (p.label || '?') + '  ✓'),
        Dom.el('div', { class: 'sl' }, p.kind),
      ]);
      const row = Dom.el('div', { class: 'room-item has-remove' }, [main]);
      row.onclick = () => this.selectPlacement(p, room);
      row.append(this._removeButton(() => p, room));
      body.append(row);
    });
  }

  /** A distinct ✕ remove control for a placed-row: stops the row's select click and
   *  removes the placement resolved lazily (`getP`) at click time, so it stays valid
   *  across the panel rebuilds that place/remove trigger. */
  _removeButton(getP, room) {
    const b = Dom.el('button', { class: 'ri-remove', title: 'Remove from room' }, '✕');
    b.onclick = (e) => { e.stopPropagation(); this.removePlacement(getP(), room); };
    return b;
  }

  /** Drop a marker for a rack/device at the room centroid (clamped inside it). */
  placeItem(room, kind, item) {
    const pdata = this.store.placementData(this.building.dir, this.floor.id);
    if (pdata.placements.some(p => p.room === room.id && p.kind === kind && p.id === item.id)) return;
    this.snapshot();
    const [cx, cy] = Geom.clampToPoly(...Geom.centroid(room.polygon), room.polygon);
    const p = { id: item.id, kind, room: room.id, loc: room.location.id,
      x: +cx.toFixed(5), y: +cy.toFixed(5), label: item.name, uid: Util.uid() };
    pdata.placements.push(p);
    this.selectedPlacement = p;   // ready to drag / rotate / resize immediately
    this.markPlacementsDirty(); this.render(); this.openRackPanel(room);
  }

  removePlacement(p, room) {
    if (!p) return;
    this.snapshot();
    const arr = this.store.placementData(this.building.dir, this.floor.id).placements;
    const i = arr.indexOf(p);
    if (i >= 0) arr.splice(i, 1);
    if (this.selectedPlacement === p) this.selectedPlacement = null;
    if (this.editingLabel === p.uid) this.editingLabel = null;
    this.markPlacementsDirty(); this.render();
    // Racks mode returns to the room's inventory list; a plain-edit delete just closes the panel.
    if (this.placingRacks && room) this.openRackPanel(room);
    else this.app.closePanel();
  }

  /** Select an already-placed marker from the sidebar list (no pointer gesture, so no
   *  dragItem is armed): highlight it + open its panel WITHOUT touching x/y. Clicking a
   *  placed row must select the existing marker, never move or recreate it. */
  selectPlacement(p, room) {
    if (!p) return;
    this.selectedPlacement = p; this.editingLabel = null;
    this.render();
    this.openPlacementPanel(p, room);
  }

  /** Side panel for a selected marker: its identity, an Edit-label entry (shared
   *  label engine), delete, and a way back to the room's inventory list. */
  openPlacementPanel(p, room) {
    const panel = Dom.$('#panel'); panel.classList.remove('hidden');
    Dom.$('#panel-title').textContent = p.label || (p.kind === 'rack' ? 'Rack' : 'Device');
    const body = Dom.$('#panel-body'); body.innerHTML = '';

    const item = this._cacheItem(p);
    const type = DeviceShapes.typeFor(p, item);
    body.append(Dom.el('div', { class: 'field' }, [
      Dom.el('label', {}, p.kind === 'rack' ? 'Rack' : 'Device'),
      Dom.el('div', { class: 'val' }, (p.label || '?') + ' · ' + type + (item ? '' : ' (not in latest sync)')),
      // Rack description (optional — racks only, absent on stale/unsynced items).
      p.kind === 'rack' && item && item.description ? Dom.el('div', { class: 'sl' }, item.description) : null,
      item && item.url ? Dom.el('div', {}, Dom.el('a', { href: item.url, target: '_blank' }, 'open in NetBox ↗')) : null,
    ]));

    body.append(Dom.el('div', { class: 'hint' },
      'Drag to move (snaps to grid) · top handle rotates (' + ANGLE_STEP
      + '°) · corner resizes · Alt bypasses snapping.'));

    body.append(Dom.el('button', { class: 'wide', onclick: () => this.editLabel(p, room),
      html: Icons.edit + '<span>Edit label</span>' }));
    body.append(Dom.el('div', { class: 'row' }, [
      Dom.el('button', { class: 'danger', onclick: () => this.removePlacement(p, room) }, 'Delete'),
      // "Back to list" returns to the room's rack inventory — a racks-sub-mode concept. In
      // plain edit there is no list to return to, so the marker is deselected instead.
      this.placingRacks
        ? Dom.el('button', { onclick: () => { this.selectedPlacement = null; this.render(); this.openRackPanel(room); } }, 'Back to list')
        : Dom.el('button', { onclick: () => this.deselect() }, 'Done'),
    ]));
  }

  /** Enter label-edit for a placement: reuse the shared label engine keyed by the
   *  placement uid (lazily back-filled for records that predate it). Done returns to
   *  the marker's panel. */
  editLabel(p, room) {
    p.uid = p.uid || Util.uid();
    this.selectedPlacement = p; this.editingLabel = p.uid;
    this.render();
    this.openLabelPanel(p, () => {
      this.editingLabel = null; this.render(); this.openPlacementPanel(p, room);
    }, p.label || '?');
  }

  /** Delete the selected marker with Delete/Backspace while placing racks; otherwise the
   *  base editor handles the key (draw undo, escape, …). */
  handleKey(e) {
    if (e.key === 'Escape' && this.arranging) { this.arranging = false; this.show(); return; }
    // Selected route arrow (edit mode, not mid-draw): exit label-edit, then delete or
    // deselect it. Delete is suppressed while the label is being edited.
    if (this.editing() && this.selectedArrow && !this.draft) {
      if (e.key === 'Escape' && this.editingLabel) {
        this.editingLabel = null; this.render(); this.openArrowPanel(this.selectedArrow); return; }
      if (!this.editingLabel && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault(); this.deleteArrow(this.selectedArrow); return; }
      if (e.key === 'Escape') {
        this.selectedArrow = null; this.editingLabel = null; this.render(); this.app.closePanel(); return; }
    }
    // Selected text note (edit mode, focus outside the label field — the app-level
    // keydown swallows keys while the textarea has focus, so text editing is unaffected):
    // Delete/Backspace removes the note; Escape closes its editor (dropping it when empty).
    if (this.editing() && this.selectedNote && !this.draft) {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault(); this.deleteNote(this.selectedNote); return; }
      if (e.key === 'Escape') { this.app.closePanel(); return; }
    }
    // Delete a selected marker — in the racks sub-mode or in plain edit (rooms have no
    // delete-by-key, so this can't collide with a room selection). editing() covers both.
    if (this.editing() && this.selectedPlacement
        && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      const p = this.selectedPlacement;
      this.removePlacement(p, this.data().rooms.find(r => r.id === p.room));
      return;
    }
    // Plain-edit rack: Escape exits label-edit first (back to the marker panel), else
    // deselects the marker (racks mode has its own richer Escape below).
    if (e.key === 'Escape' && !this.placingRacks && this.selectedPlacement) {
      if (this.editingLabel) {
        this.editingLabel = null; this.render();
        const p = this.selectedPlacement, room = this.data().rooms.find(r => r.id === p.room);
        if (room) this.openPlacementPanel(p, room);
        return;
      }
      this.deselect(); return;
    }
    if (e.key === 'Escape' && this.placingRacks) {
      // Exit label-edit first (back to the marker panel), then deselect, then close.
      if (this.editingLabel) {
        this.editingLabel = null; this.render();
        const p = this.selectedPlacement, room = p && this.data().rooms.find(r => r.id === p.room);
        if (p && room) this.openPlacementPanel(p, room);
        return;
      }
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
      this.app.setToolbar(this._toolbar()); this.render(); return;
    }
    // A plain-edit rack's panel closed (via the panel's own close, not a background click):
    // deselect the marker so its handles drop.
    if (this.selectedPlacement) { this.selectedPlacement = null; this.editingLabel = null; this.render(); return; }
    // A text note's editor closed: deselect and drop the note if it was left empty
    // (clearing a note's text is how it is deleted).
    if (this.selectedNote) {
      const note = this.selectedNote;
      this.selectedNote = null; this.editingLabel = null;
      this._dropEmptyNote(note);
      this.render(); return;
    }
    if (this.selectedArrow) { this.selectedArrow = null; this.editingLabel = null; this.render(); }
  }
}
