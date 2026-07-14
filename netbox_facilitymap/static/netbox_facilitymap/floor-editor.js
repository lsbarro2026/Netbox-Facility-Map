'use strict';
/* floor-editor.js — FloorEditor: draw/edit room polygons on a floor image and
   bind each to a NetBox Location. In view mode rooms are invisible clickable
   zones (rooms holding rack/device markers stay highlighted). Extends Editor for
   the shared engine. */

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
    this.arranging = false;          // Arrange mode: drag sheets into grid cells
    this.dragSheetState = null;      // { page, target:[col,row] } during a sheet drag
    this.layout = null;              // display geometry (padded while arranging)
    this.baseLayout = null;          // the floor's true (unpadded) sheet geometry
    this._peeked = false;            // first mount frames sheet 1 (peek), later shows full-fit
    this._focus = null;              // pending focus target { roomId, region } to frame on mount
    this._focusRoomId = null;        // room pulsed by the focus highlight (cleared after ~3.5s)
    this.showOverlays = true;        // read-only data-overlay layer visible by default (FMT-9)
  }

  /** Accept a focus target from App.showFloor (before show()) — a wayfinding-search jump or a
   *  `#/r/` room deep-link. `region` frames the viewport on the room/rack instead of the usual
   *  peek/full-fit; `roomId` is pulsed once the floor renders. */
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
    if (!this.selected && !this.selectedArrow && !this.selectedNote) return;
    if (this.selectedNote) this._dropEmptyNote(this.selectedNote);
    this.selected = null; this.selectedArrow = null; this.selectedNote = null;
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
   *  notes, its rack/device placements, its sheet arrangement — plus the three dirty
   *  flags, captured BEFORE the mutation. Because the flags ride along, undoing back to a
   *  saved state restores clean flags and clears the badge. JSON round-trip clone
   *  (all are plain JSON), matching the codebase's explicit-clone idiom. */
  _snapshotState() {
    const dir = this.building.dir, fid = this.floor.id, key = Util.floorKey(dir, fid);
    const rec = this.data(), pdata = this.store.placementData(dir, fid);
    const layout = this.store.layouts[key];
    const clone = (v) => JSON.parse(JSON.stringify(v));
    return {
      rooms: clone(rec.rooms), arrows: clone(rec.arrows || []), notes: clone(rec.notes || []),
      placements: clone(pdata.placements), layout: layout ? clone(layout) : null,
      dirty: this.store.dirty, layoutDirty: this.store.layoutDirty,
      placementsDirty: this.store.placementsDirty,
    };
  }

  /** Restore a snapshot: write the cloned data back into the store records, restore the
   *  dirty flags, and drop transient selection/drag state (a restored delete may have
   *  removed the selected shape; live drag refs now point at stale arrays). Closes the
   *  panel under the _switchMode guard so it doesn't bounce racks→edit. */
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
    this.store.dirty = snap.dirty;
    this.store.layoutDirty = snap.layoutDirty;
    this.store.placementsDirty = snap.placementsDirty;
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
      { label: 'Siteplan', hash: '/' },
      { label: b.name, hash: '/b/' + encodeURIComponent(b.dir) },
      { label: f.label },
    ]);
    this.app.setToolbar(this._toolbar());

    const stage = Dom.$('#stage'); stage.innerHTML = '';
    const imgs = base.cells.map(c => Dom.el('img', { class: 'sheet', src: this.store.mediaUrl(c.image), alt: f.label,
      style: `left:${c.col * base.cellW}px;top:${c.row * base.cellH}px;width:${base.cellW}px;height:${base.cellH}px` }));
    const s = Dom.svg('svg', { preserveAspectRatio: 'none' });
    const wrap = Dom.el('div', { class: 'map-wrap', id: 'floor-wrap', style: `width:${W}px;height:${H}px` },
      [...imgs, s]);
    // The sheet stamp sits in the viewport (not the wrap), so it stays fixed in
    // the corner instead of panning/zooming with the map.
    stage.append(Dom.el('div', { class: 'map-viewport' }, [wrap, this._sheetMark()]));

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
    if (this.placingRacks || this.app.mode === 'view') this._ensurePlacementInventory();
  }

  /** The normalized rect framing a room's polygon bbox, padded so the room sits in a little
   *  context rather than filling the viewport edge-to-edge. Used by App's `#/r/` room deep-link
   *  to derive a `setFocus` region from the room alone. Coordinates stay 0..1
   *  (resolution-independent); returns null if the room/geometry is gone. */
  _roomFocusRegion(id) {
    const room = this.data().rooms.find(r => r.id === id);
    if (!room || !room.polygon || !room.polygon.length) return null;
    const b = Geom.bounds(room.polygon);
    const pad = Math.max(b.w, b.h) * 0.6 + 0.02;   // context margin, with a floor for tiny rooms
    return [
      Math.max(0, b.minX - pad), Math.max(0, b.minY - pad),
      Math.min(1, b.maxX + pad), Math.min(1, b.maxY + pad),
    ];
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
  // Trailing edit-only tools: Arrange sheets (multi-sheet floors), Copy to floor, the
  // Place-racks sub-mode toggle, and the read-only data overlay (when the floor has one).
  _editExtras() {
    const extra = [];
    if (this.layout && this.layout.cells.length > 1) extra.push(this._arrangeButton(), this.toolDivider());
    const copyBtn = Dom.el('button', { class: 'tb-labeled', title: 'Copy this floor’s rooms onto another floor',
      onclick: () => this.openCopyFloorPanel(), html: Icons.dup + '<span>Copy to floor…</span>' });
    // Place-racks is a sub-mode of edit: an in-place toggle, not a separate mode/toolbar.
    const racksBtn = Dom.el('button', { class: 'icononly' + (this.placingRacks ? ' active' : ''),
      title: 'Place racks/devices in rooms', html: Icons.rack + '<span>Place racks</span>' });
    racksBtn.onclick = () => this._toggleRacks();
    extra.push(copyBtn, racksBtn);
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
    const exportBtn = Dom.el('button', { class: 'tb-labeled', title: 'Download or print this floor',
      onclick: () => this.openExportPanel(), html: Icons.download + '<span>Export</span>' });
    const view = [hlSel];
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
    const b = Dom.el('button', { class: 'icononly' + (this.showOverlays ? ' active' : ''),
      title: 'Show or hide the data overlay', html: Icons.layers + '<span>Overlay</span>' });
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
    this.selectedArrow = null; this.selectedNote = null; this.selectedPlacement = null;
    this.rackRoom = null;
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

  /** Persist all three categories together (not just the current mode's), so a single
   *  click always clears the badge above — matching what the badge now shows. The
   *  try/catch, `history.clear()`, badge refresh and toast are the shared `Editor.save`. */
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
    for (const room of this.data().rooms) {
      // In plain edit the selected room is promoted to the active layer (its editable
      // vertices must never be occluded). While placing racks the room has no vertices,
      // so it stays here in the static layer — drawn BEFORE drawPlacements below, its own
      // rack markers therefore sit above its fill and a marker click isn't swallowed by
      // the room polygon.
      if (editing && !racks && room.id === this.selected) continue;   // selected room → active layer
      this._drawRoom(s, room, W, H, placedRooms, editing, racks);
    }
    if (!racks) this._drawArrows(s, W, H, true);   // non-selected wayfinding routes (edit + view)
    if (racks || this.app.mode === 'view') this.drawPlacements(s, W, H, true);
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

    // Room-geometry editing is a plain-edit affordance only: while placing racks the
    // selected room draws in the static layer (above) with no editable vertices, so its
    // shape can't be reshaped and marker clicks aren't swallowed by a promoted room fill.
    if (editing && !racks && this.selected != null) {
      const room = this.data().rooms.find(r => r.id === this.selected);
      if (room) {
        const placedRooms = new Set(
          this.store.placementData(this.building.dir, this.floor.id).placements.map(p => p.room));
        this._drawRoom(s, room, W, H, placedRooms, editing, racks);
        // No centroid label is drawn (the floor-plan images already carry the printed
        // room names/numbers); the selected room just gets its editable vertices.
        this.drawVertices(s, room.polygon, W, H, room.id, () => this.markDirty());
      }
    }
    if (editing && this.selectedArrow) this._drawArrow(s, this.selectedArrow, W, H, editing);
    // The note being label-edited draws here so its label drag/handles repaint per frame.
    // Like the selected arrow, it shows even in racks mode (only *non-selected* notes are
    // decluttered there); non-edited notes live in the static layer, gated by `!racks`.
    if (editing && this.selectedNote) this._drawNote(s, this.selectedNote, W, H);
    this.drawDraft(s, W, H);
    if (racks && this.selectedPlacement) {
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
  _drawRoom(s, room, W, H, placedRooms, editing, racks) {
    const placed = placedRooms.has(room.id) && !!room.location;
    const focused = room.id === this._focusRoomId;   // focus target (search jump or #/r/ deep-link)
    const pts = room.polygon.map(p => `${p[0] * W},${p[1] * H}`).join(' ');
    // Racks mode draws every room as a clickable target. View mode keeps rooms as
    // invisible click-zones, except those highlighted: 'all' draws every room,
    // 'placements' draws only rooms holding markers. A focus target is always
    // drawn (and pulsed) so the jump lands on a visible room in any highlight mode.
    const showShape = editing || racks || focused || this.app.highlight === 'all'
      || (placed && this.app.highlight === 'placements');
    let cls;
    if (!showShape) cls = 'clickzone';
    else {
      cls = 'room';
      if (placed) cls += ' placed';
      if (editing && room.id === this.selected) cls += ' selected';
      if (editing && !room.location) cls += ' unbound';
      if (focused) cls += ' focus';
    }
    const poly = Dom.svg('polygon', { points: pts, class: cls });
    if (cls === 'clickzone') poly.style.pointerEvents = 'all';
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
      else if (editing) { this.selected = room.id; this.render(); this.openRoomPanel(room); }
      else if (room.location) window.open(room.location.url, '_blank');
    });
    s.append(poly);
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
    // The selected marker renders into the active layer (always on top), so no
    // draw-order sort is needed here; skip it so it isn't drawn twice.
    for (const p of visible) {
      if (skipSelected && p === this.selectedPlacement) continue;
      this._drawPlacement(s, p, W, H, roomById);
    }
  }

  /** Draw one placement marker into `s` (glyph + title; draggable with handles in racks
   *  mode, a NetBox link in view mode) plus its label. Shared by the static loop and the
   *  active-layer draw of the selected marker — `.selected`/handles key off
   *  `this.selectedPlacement`, so they light up only for the selected one either way. */
  _drawPlacement(s, p, W, H, roomById) {
    const draggable = this.placingRacks;
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
    } else if (item && item.url) {
      g.style.cursor = 'pointer';
      g.addEventListener('click', (e) => { e.stopPropagation(); window.open(item.url, '_blank'); });
    }
    s.append(g);

    // The name rides the shared label engine as a separate, stylable label (drawn
    // on the svg, not the rotated marker group, so it keeps its own rotation).
    this._drawPlacementLabel(s, p, hpx, W, H);
  }

  /** Draw a placement's name as an independently movable/stylable label via the shared
   *  Editor label engine. Auto-placed just below the glyph; an optional `labelStyle`
   *  (x/y/rot/size/font/colour/text) overrides. While this placement's label is being
   *  edited it gains move/rotate/resize handles (keyed by the placement uid). */
  _drawPlacementLabel(s, p, hpx, W, H) {
    const ls = p.labelStyle || {};
    // Racks carry their name centered inside the (filled) box; devices sit it just
    // below the glyph. `inside` only holds at the default position — a moved label
    // (custom x/y) reverts to the haloed style so it stays legible over the plan.
    const inside = p.kind === 'rack' && ls.x == null && ls.y == null;
    const lcx = ls.x != null ? ls.x : p.x;
    const lcy = ls.y != null ? ls.y : (inside ? p.y : p.y + (hpx / 2 + 10) / H);
    const sizePx = ls.size || 11;
    const t = Dom.svg('text', { class: 'rack-label' + (inside ? ' inside' : ''),
      'text-anchor': 'middle', 'dominant-baseline': 'central' });
    t.style.fontSize = sizePx + 'px';
    this._setLabelLines(t, (ls.text != null ? ls.text : (p.label || '?')).split('\n'));
    this.attachLabel(s, p, t, lcx, lcy, sizePx, W, H);
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
        let w = Math.max(16, 2 * Math.abs(lx)) / W;
        let h = Math.max(14, 2 * Math.abs(ly)) / H;
        // Quantize the footprint to the grid (offset 0 — this snaps a size, not a
        // position); Alt frees it, and a marker stays at least one cell on a side.
        if (this.grid.on && !(ev && ev.altKey)) {
          const [iw, ih] = this.dims;
          w = Math.max(this.grid.step, this.grid.snap(w * iw, 0)) / iw;
          h = Math.max(this.grid.step, this.grid.snap(h * ih, 0)) / ih;
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
    if (this.draft.kind === 'arrow') return this._finishArrow();
    if (this.draft.kind === 'note') return this._finishNote();
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
    this.selected = null; this.editingLabel = null; this.selectedArrow = arrow;
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
    this.selected = null; this.selectedArrow = null; this.selectedNote = note;
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
    this.render(); this.openRoomPanel(room);
    Toast.show('Duplicated. Drag vertices to reshape (snaps to the original).');
  }

  deleteRoom(room) {
    this.snapshot();
    const rooms = this.data().rooms;
    const i = rooms.indexOf(room);
    if (i >= 0) rooms.splice(i, 1);
    this.selected = null; this.markDirty(); this.render(); this.app.closePanel();
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
      + 'plate/aspect. Copies save with this floor’s next Save (they can’t be undone with Ctrl+Z).'));

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
   *  path (store.dirty) — not captured by this floor's undo stack. */
  copyRoomsToFloor(targetFloor, scope) {
    const rooms = this.data().rooms;
    const src = scope === 'selected' ? rooms.filter(r => r.id === this.selected) : rooms;
    if (!src.length) { Toast.show('Nothing to copy'); return; }
    const dest = this.store.floorData(this.building.dir, targetFloor.id);
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
      Dom.el('button', { onclick: () => { this.snapshot(); room.location = null; room.label = ''; this.markDirty(); this.render(); this.openRoomPanel(room); } }, 'Unbind'),
      Dom.el('button', { class: 'danger', onclick: () => this.deleteRoom(room) }, 'Delete'),
    ]));

    body.append(Dom.el('button', { class: 'wide', onclick: () => this.duplicateRoom(room),
      html: Icons.dup + '<span>Duplicate as new room</span>' }));
    body.append(Dom.el('button', { class: 'wide', onclick: () => this._copyRoomLink(room),
      html: Icons.link + '<span>Copy link to this room</span>' }));
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
        room.label = loc.name; this.markDirty(); this.render(); this.openRoomPanel(room);
      },
    });
    if (res.floor === null) body.insertBefore(
      Dom.el('div', { class: 'hint' }, '⚠ No NetBox Location matches floor slug "' + this.floor.id + '"; showing all site locations.'),
      bl.search);
    if (!rooms.length) bl.list.append(Dom.el('div', { class: 'hint' }, 'No NetBox locations returned.'));
    // Inline Location creation (LOC-1) — an opt-in escape hatch for installs that don't model a
    // Location per room, so a drawn room has nothing to bind to. Gated on BOTH the install-wide
    // capability and this user's dcim.add_location perm (re-checked server-side), and only offered
    // when a floor Location exists to parent the new child under (res.floor).
    if (this.app.hasCapability('location-create') && this.app.canCreateLocation && res.floor)
      this._appendCreateLocation(body, room, res.floor);
  }

  /** Append the "create a NetBox Location under this floor and bind to it" affordance to the bind
   *  panel (LOC-1). Non-intrusive: a short notice explaining that this writes to NetBox and the
   *  guards behind it, a name field (prefilled with the room's label), and one button that creates
   *  the child Location and binds the room to it — no new mode or wizard step. Only called when the
   *  capability + the user's dcim.add_location perm are both present and a floor Location exists. */
  _appendCreateLocation(body, room, floor) {
    body.append(Dom.el('div', { class: 'hint' },
      'No match? Create a new Location under "' + floor.name + '" and bind to it. This writes to '
      + 'NetBox — it adds a child Location under this floor (nothing else is changed) and is '
      + 'available only because an operator enabled it and you hold the add-Location permission. '
      + 'NetBox stays the source of truth, so model Locations there first where you can.'));
    const input = Dom.el('input', { placeholder: 'New Location name…', value: room.label || '' });
    const btn = Dom.el('button', { class: 'wide' }, 'Create Location & bind');
    btn.onclick = async () => {
      const name = input.value.trim();
      if (!name) { Toast.show('Enter a Location name', true); input.focus(); return; }
      btn.disabled = true;
      try {
        const loc = await this.netbox.createLocation(floor.id, name);
        // Add the new Location to the cached bind list so it shows next open, then bind the room to
        // it (mirrors the _bindList pick above).
        const cached = this.store.nbRoomsByFloor[Util.floorKey(this.building.dir, this.floor.id)];
        if (cached && cached.rooms) cached.rooms.push(loc);
        this.snapshot();
        room.location = { id: loc.id, name: loc.name, slug: loc.slug, url: loc.url };
        room.label = loc.name;
        this.markDirty(); this.render(); this.openRoomPanel(room);
        Toast.show('Created "' + loc.name + '" in NetBox and bound the room');
      } catch (e) {
        Toast.show('Create failed: ' + e.message, true);
        btn.disabled = false;
      }
    };
    body.append(Dom.el('div', { class: 'field' }, [input, btn]));
  }

  /** Build and copy a shareable deep-link to `room` (#/r/<dir>/<fid>/<slug-or-id>). Prefers the
   *  bound Location slug (stable, human-readable); falls back to the room's uid when unbound.
   *  Degrades to a toast showing the URL if the clipboard API is unavailable (e.g. non-HTTPS). */
  async _copyRoomLink(room) {
    const seg = (room.location && room.location.slug) ? room.location.slug : room.id;
    const url = location.origin + location.pathname + '#/r/'
      + encodeURIComponent(this.building.dir) + '/'
      + encodeURIComponent(this.floor.id) + '/'
      + encodeURIComponent(seg);
    try {
      await navigator.clipboard.writeText(url);
      Toast.show('Room link copied');
    } catch (e) {
      console.warn('Clipboard unavailable', e);
      Toast.show('Copy failed. Link: ' + url, true);
    }
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
    if (room) this.openRackPanel(room);
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
      Dom.el('button', { onclick: () => { this.selectedPlacement = null; this.render(); this.openRackPanel(room); } }, 'Back to list'),
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
    if (this.placingRacks && this.selectedPlacement
        && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      const p = this.selectedPlacement;
      this.removePlacement(p, this.data().rooms.find(r => r.id === p.room));
      return;
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
