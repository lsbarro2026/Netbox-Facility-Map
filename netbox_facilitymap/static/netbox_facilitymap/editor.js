'use strict';
/* editor.js — Editor: abstract base for the polygon editors.
   Encapsulates the shared engine: an <svg> overlay on an image, normalized
   coordinates, grid + vertex/edge snapping, polygon drawing with a live cursor,
   undo, vertex dragging, and grid move/resize. Subclasses (FloorEditor,
   SiteplanEditor) supply the data + the meaning of a shape. Three self-contained
   concerns live on collaborators holding an editor back-ref (QUAL-4): EditorPointer
   (pointer/gesture/keyboard input), EditorShapes (vertex/label SVG construction + the
   label engine), EditorToolbar (toolbar/button construction + the shortcuts panel).

   The overlay is split into three stacked <g> layers (bottom→top: grid / static /
   active) so a drag redraws only the moving element instead of the whole shape layer.
   A full render() rebuilds all three; per-frame drags call renderActive() (or
   renderGrid()), which rebuild just one layer. See ARCHITECTURE §10.

   Subclasses MUST implement: _renderStatic(s,W,H), _renderActive(s,W,H), polys(),
   editing(), deselect(), markDirty(), and the shape seam below (_newShape,
   _openShapePanel, _shapePoly, _shapeTerms). Coordinates everywhere are
   normalized 0..1 to the image. */

const ORTHO_KEY = 'facilitymap:ortho';   // persisted right-angle-snap toggle (default on)

class Editor {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.grid = app.grid;          // shared GridController
    // Collaborators — each self-contained concern holds an editor back-ref (the FloorArrange
    // shape, QUAL-4); shared state stays here on the editor, read through `this.ed`.
    this.pointer = new EditorPointer(this);   // pointer/gesture + shared keyboard input
    this.shapes = new EditorShapes(this);     // vertex/label SVG construction + the label engine
    this.toolbar = new EditorToolbar(this);   // toolbar/button + shortcuts-panel construction
    this.viewport = new PanZoom(); // per-view pan/zoom transform on the .map-wrap
    this.snapOn = true;
    this.orthoOn = this._loadOrtho(); // right-angle snap: align a dragged node to its neighbours (default on, persisted)
    this.img = null;               // <img> background
    this.svg = null;               // <svg> overlay
    this.dims = null;              // [iw, ih] intrinsic image px
    this.draft = null;             // { points:[[nx,ny]], cursor:{pt,kind} } while drawing
    this.selected = null;          // selected shape id
    this.editingLabel = null;      // id of the shape whose label is being moved/styled
    this.dragVertex = null;        // { poly, i, exclude, dirty } while dragging
    this.gridDrag = null;          // { x, y, ox, oy } while moving grid
    this.dragItem = null;          // { move(nx,ny) } while dragging a free point (e.g. a rack marker)
    this.dragEdge = null;          // { move(nx,ny,ev) } while dragging a whole polygon edge (both endpoints)
    this.dragSheet = null;         // { move(nx,ny), drop() } while dragging a whole sheet (Arrange mode)
    this.pan = null;               // { x, y, moved, btn } while panning the viewport
    this.initialFocus = null;      // [nx0,ny0,nx1,ny1] to frame on first mount, else full fit
    this.rectMode = false;         // rectangle draw tool armed: drag a box instead of clicking points
    this.rectDraft = null;         // { a:[nx,ny], b:[nx,ny] } while dragging out a rectangle
    this.history = new UndoStack();// per-editor undo stack (Ctrl+Z); opaque snapshots, see _snapshotState
    this._imgsReady = false;       // every sheet <img> has loaded, so the wrap is measurable
    this._fitted = false;          // the initial fit has landed (viewport had a real size)
    this._badge = null;            // the saved/unsaved status badge, (re)built by _badgeEl()
    this._switchingMode = false;   // guards onPanelClosed while _switchMode closes the panel
  }

  // ---- abstract (subclass responsibilities) ----
  // A subclass paints into two layers: _renderStatic draws everything that stays put
  // across a drag (catcher, captions, non-selected shapes + their labels);
  // _renderActive draws the moving element (the draft, the selected shape drawn live
  // with its vertices/handles). `s` is the target <g> for that layer.
  _renderStatic(s, W, H) { throw new Error('_renderStatic() not implemented'); }
  _renderActive(s, W, H) {}
  polys() { return []; }           // [{ id, polygon }] used for snapping
  editing() { return false; }
  // Whether grid drawing + move/resize are available here — edit mode. FloorEditor's
  // rack placement is a sub-mode of edit, so markers snap to the grid there too.
  gridActive() { return this.editing(); }
  // Whether the snapping grid should be drawn in the current sub-mode (FloorEditor
  // suppresses it while arranging sheets). Gated by gridActive() regardless.
  _showGrid() { return true; }
  // ---- the shape seam (what a "shape" means in this editor) ----
  // Both editors create shapes the same way — snapshot, build the record, push it, select it,
  // mark dirty, render, open its panel — and differ only in the record and the collection it
  // lands in. These four hooks are that difference; everything built on them (`finish`, the
  // rectangle tool, duplicate, and the draw/rect toolbar buttons) is shared (§10 *Edit-menu
  // lockstep*).
  /** Build a new shape from a normalized 0..1 polygon, push it onto this editor's collection,
   *  and return it. Always UNBOUND — a fresh shape has no Location/building until the user
   *  binds it in the panel that opens next. */
  _newShape(poly) { throw new Error('_newShape() not implemented'); }
  /** Open the panel for one of this editor's shapes (the room / building-area panel). */
  _openShapePanel(shape) {}
  /** This editor's normalized polygon on a shape record (rooms key it `polygon`, siteplan
   *  hotspots `poly`). */
  _shapePoly(shape) { return shape.polygon; }
  /** Wording for the shared draw tools: `noun` names the thing being drawn ("room"), and
   *  `drawLabel` is the polygon button's own label, which each editor keeps in its own voice
   *  ("Add room area" / "Add building area"). Everything else is derived from `noun`. */
  _shapeTerms() { return { noun: 'shape', drawLabel: 'Add shape' }; }
  /** Anything to re-sync after a shape is added (FloorEditor refreshes the to-do room list).
   *  Runs before the render, so the panel that opens next sees the synced state. */
  _afterShapeAdded() {}

  /** Commit a normalized 0..1 polygon as a new shape: the whole shared create path. The
   *  snapshot is taken BEFORE the shape lands, so Ctrl+Z removes it (§10). */
  _addShape(poly, msg) {
    this.snapshot();
    const shape = this._newShape(poly);
    this.draft = null; this.selected = shape.id; this.markDirty();
    this._afterShapeAdded();
    this.render(); this._openShapePanel(shape);
    if (msg) Toast.show(msg);
    return shape;
  }

  /** Close the current polygon draft into a shape. A draft too short to be an area is
   *  discarded (Enter on an under-full polygon cancels). A subclass with extra draft kinds
   *  branches on them first and then defers here (see FloorEditor). */
  finish() {
    const dp = this.draft.points;
    if (dp.length < 3) { this.draft = null; this.render(); return; }
    this._addShape(dp.slice());
  }

  /** Build off an existing shape: clone its (nudged) polygon as a new, unbound shape. The
   *  nudge offsets it just enough to be grabbable while still snapping to the original. */
  duplicateShape(src) {
    const off = 0.01;
    const poly = this._shapePoly(src).map(p => [+Math.min(1, p[0] + off).toFixed(5), +Math.min(1, p[1] + off).toFixed(5)]);
    this._addShape(poly, 'Duplicated. Drag vertices to reshape (snaps to the original).');
  }

  // Drop the current selection and close its panel. Both concrete editors implement it, and the
  // base Escape ladder's last rung calls it — so an editor that leaves it a no-op has an Escape
  // that can't deselect.
  deselect() {}
  markDirty() {}

  // ---- undo (Ctrl+Z) ----
  // A subclass opts into undo by implementing `_snapshotState()` + `_applySnapshot()`.
  // `_snapshotState()` returns a JSON-serializable clone of everything a mutation could change
  // (its shapes/data), or null to opt out (the base default — undo is then a no-op).
  // `_applySnapshot(snap)` writes such a snapshot back onto the store and RE-DERIVES the dirty
  // flags from the store baselines; the shared restore tail below refreshes the badge. Snapshots
  // are taken BEFORE a mutation; the flags are re-derived rather than stored, because history now
  // survives a Save (SAVE-6) — a save advances the baselines, so a flag captured before the
  // mutation would be stale after the save, whereas re-deriving from last-saved content is always
  // correct (undoing back across a save re-marks the badge dirty so the restored state can be
  // re-saved).
  _snapshotState() { return null; }

  /** Write a snapshot back onto the store and re-derive the dirty flags from its baselines
   *  (`recomputeFloorDirty`/`recomputeSiteDirty`). Also the place to re-sync anything DERIVED from
   *  the restored data — a restore is a mutation like any other, merely running backwards, so a
   *  consumer the forward path notifies (e.g. the to-do panel's room list) must be notified here
   *  too. Base no-op: an editor that hasn't opted into undo never reaches this. */
  _applySnapshot(snap) {}

  /** Transient per-selection state an undo must drop, because a restored delete may have removed
   *  the selected shape and live drag refs now point at stale arrays. The base covers the state
   *  every editor has; a subclass with more selection channels extends it (see FloorEditor). */
  _clearTransientState() {
    this.selected = null; this.editingLabel = null; this.draft = null;
  }

  /** The `Store.onDirty` scopes an undo on this editor can affect, so the restore tail can notify
   *  them without knowing which store shards the subclass touched. */
  _dirtyScopes() { return []; }

  /** Restore a snapshot. The subclass supplies only the data write-back (`_applySnapshot`) and its
   *  extra selection channels (`_clearTransientState`); everything after that is identical in both
   *  editors and lives here — drop transient state, notify the dirty scopes, refresh the badge, and
   *  close the panel under the `_switchingMode` guard so it doesn't bounce through onPanelClosed. */
  _restoreState(snap) {
    this._applySnapshot(snap);
    this._clearTransientState();
    if (this.store.onDirty) for (const scope of this._dirtyScopes()) this.store.onDirty(scope);
    this._setBadge();
    this._switchingMode = true; this.app.closePanel(); this._switchingMode = false;
  }

  /** Deep-clone a snapshot payload. Everything an editor snapshots is plain JSON, so the round-trip
   *  is both the clone and the "is it really serializable" check. */
  _clone(v) { return JSON.parse(JSON.stringify(v)); }

  /** Capture the current state onto the undo stack, before a mutating operation. */
  snapshot() { const s = this._snapshotState(); if (s) this.history.push(s); }
  /** Undo the most recent captured mutation, if any. */
  undo() {
    const snap = this.history.pop();
    if (!snap) return;
    this._restoreState(snap);
    this.render();
  }

  /** Post-delete notice carrying an Undo button (UX-17). Every delete in both editors fires
   *  immediately with no confirmation, and undo — though it has covered them all along — was
   *  reachable only by a user who already knew about Ctrl+Z. This surfaces it at the one moment
   *  it is needed, so an instant delete stops being a one-way door.
   *
   *  Call it AFTER the mutation, from a delete that has already `snapshot()`ed: the button pops
   *  that snapshot through the normal `undo()` path, so the restore re-derives the dirty flags
   *  from the store baselines like any other undo (SAVE-6) rather than needing its own bookkeeping.
   *
   *  The button is pinned to the snapshot this delete pushed, by identity. The toast outlives its
   *  delete by several seconds, and a mutation landing in that window would make the pop revert the
   *  WRONG operation — so a stale button refuses instead of silently undoing something the user
   *  never asked about. Identity, not stack depth: the history is depth-capped and drops from the
   *  bottom, so a full stack keeps the same `size` across a push and a size check would miss it.
   *  An editor that hasn't opted into undo (`_snapshotState` → null, so nothing was pushed) has
   *  nothing to pin and just gets the plain notice. */
  _deleteToast(msg) {
    const pinned = this.history.peek();
    if (!pinned) { Toast.show(msg); return; }
    Toast.action(msg, 'Undo', () => {
      if (this.history.peek() !== pinned) { Toast.show('Too late to undo that — newer changes came first', true); return; }
      this.undo();
    });
  }

  /** Commit a finished rectangle (a 4-point normalized polygon) into a shape — the same
   *  create path a drawn polygon takes, differing only in where the points came from. */
  _commitRect(poly) { this._addShape(poly); }

  // A subclass may draw a read-only data overlay (FMT-9) atop the base plan by implementing
  // _renderOverlays. It sits below the interactive shapes and is pointer-transparent (see
  // .overlay-layer in style.css), so it never intercepts a room click or marks the store dirty.
  _renderOverlays(s, W, H) {}

  // ---- four-layer rendering ----
  /** Create the grid/overlay/static/active <g> layers once per <svg> mount (show() builds a
   *  fresh <svg> each time, so re-create when the current one lacks them). The overlay layer sits
   *  above the grid and below the interactive shapes. */
  _ensureLayers() {
    if (this.gridLayer && this.gridLayer.parentNode === this.svg) return;
    this.svg.innerHTML = '';
    this.gridLayer = Dom.svg('g', { class: 'grid-layer' });
    this.overlayLayer = Dom.svg('g', { class: 'overlay-layer' });
    this.staticLayer = Dom.svg('g', { class: 'static-layer' });
    this.activeLayer = Dom.svg('g', { class: 'active-layer' });
    this.svg.append(this.gridLayer, this.overlayLayer, this.staticLayer, this.activeLayer);
  }

  /** Full rebuild of every layer — the structural path (selection change, finish/deselect,
   *  add/delete, mode switch, data load). Per-frame drags call the cheaper
   *  renderActive()/renderGrid() instead. */
  render() {
    const s = this.svg; if (!s) return;
    const [W, H] = this.dispSize(); if (!W) return;
    this._ensureLayers();
    s.classList.toggle('draw-active', !!this.draft || this.rectMode);
    s.classList.toggle('grid-adjust', this.gridActive() && this.grid.adjust);
    this.renderGrid();
    this.renderOverlays();
    this.staticLayer.innerHTML = '';
    this._renderStatic(this.staticLayer, W, H);
    this.renderActive();
    this._setModeBanner(this._armedModeText());
  }

  /** Text for the persistent "armed sub-mode" banner (UX-16), or null when no such sub-mode
   *  is active. Base no-op — SiteplanEditor has no toggle sub-mode that hijacks room clicks;
   *  FloorEditor overrides this for Place-racks/Copy-link. Read on every render(), so every
   *  path that flips the underlying flag (a toggle, Escape, a mode switch) picks it up for
   *  free without needing its own call site. */
  _armedModeText() { return null; }

  /** Build the banner element once per show() (spliced into `.map-viewport` alongside
   *  `.sheet-mark`, so it stays pinned regardless of pan/zoom). Hidden until `render()` gives
   *  it text. A subclass with no armed sub-mode simply never gets non-null text, so the
   *  element stays hidden forever — cheap to include unconditionally. */
  _modeBanner() {
    this._bannerEl = Dom.el('div', { class: 'mode-banner', hidden: '' });
    return this._bannerEl;
  }
  _setModeBanner(text) {
    if (!this._bannerEl) return;
    this._bannerEl.textContent = text || '';
    this._bannerEl.hidden = !text;
  }

  /** Rebuild just the overlay layer (the read-only data overlay + its visibility toggle).
   *  Cheap enough to call on a toggle without a full render(). */
  renderOverlays() {
    if (!this.overlayLayer) return;
    const [W, H] = this.dispSize(); if (!W) return;
    this.overlayLayer.innerHTML = '';
    this._renderOverlays(this.overlayLayer, W, H);
  }

  /** Rebuild just the top (active) layer: the draft + the selected shape drawn live.
   *  Called on every drag frame so the static shapes below are left untouched. */
  renderActive() {
    if (!this.activeLayer) return;
    const [W, H] = this.dispSize(); if (!W) return;
    this.activeLayer.innerHTML = '';
    this._renderActive(this.activeLayer, W, H);
  }

  /** Rebuild just the grid layer (grid move/resize/toggle). grid.draw() no-ops when
   *  the grid is off, so the gridActive()/_showGrid() gate is all that's needed. */
  renderGrid() {
    if (!this.gridLayer) return;
    const [W, H] = this.dispSize(); if (!W) return;
    this.gridLayer.innerHTML = '';
    if (this.gridActive() && this._showGrid()) this.grid.draw(this.gridLayer, W, H, this.dims);
  }

  // ---- geometry / coordinates ----
  // The displayed (unscaled layout px) size of the whole drawing surface. Reads
  // the .map-wrap, not a single <img>, so it spans every stacked sheet of a
  // multi-page floor. clientWidth/Height ignore the pan/zoom transform (keep it —
  // getBoundingClientRect would fold the scale in).
  dispSize() { return [this.wrap.clientWidth, this.wrap.clientHeight]; }
  evtNorm(e) {
    const r = this.svg.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  }

  /** Snap a normalized point. Priority: existing vertex > existing edge > grid.
   *  `exclude` ignores a shape's own geometry (the one being dragged). */
  snapPoint(nx, ny, exclude) {
    const [W, H] = this.dispSize(), [iw, ih] = this.dims;
    const px = nx * W, py = ny * H;
    const polys = this.polys();
    // Distances below are in layout px; divide the visual threshold by the zoom
    // scale so snapping feels the same at any zoom level.
    const snapPx = SNAP_PX / this.viewport.scale;
    let kind = null, out = [nx, ny];
    if (this.snapOn) {
      let best = snapPx, bv = null;
      for (const r of polys) {
        if (r.id === exclude) continue;
        for (const v of r.polygon) {
          const d = Math.hypot(px - v[0] * W, py - v[1] * H);
          if (d < best) { best = d; bv = v; }
        }
      }
      if (bv) return { pt: [bv[0], bv[1]], kind: 'vertex' };
      let beste = snapPx, be = null, beSeg = null;
      for (const r of polys) {
        if (r.id === exclude) continue;
        const pl = r.polygon;
        for (let i = 0; i < pl.length; i++) {
          const a = pl[i], b = pl[(i + 1) % pl.length];
          const ax = a[0] * W, ay = a[1] * H, bx = b[0] * W, by = b[1] * H;
          const pr = Geom.projSeg(px, py, ax, ay, bx, by);
          if (pr.d < beste) { beste = pr.d; be = [pr.x / W, pr.y / H]; beSeg = [ax, ay, bx, by]; }
        }
      }
      if (be) { out = be; kind = 'edge'; }
      // Keep an edge-snapped node ON the wall but quantize its position ALONG the
      // wall to the grid: snap the projected point to the grid, then re-project that
      // grid point back onto the winning segment. Otherwise the node slides freely
      // along the wall and yields uneven geometry.
      if (kind === 'edge' && this.grid.on) {
        const gx = this.grid.snap(out[0] * iw, this.grid.ox) / iw * W;
        const gy = this.grid.snap(out[1] * ih, this.grid.oy) / ih * H;
        const pr = Geom.projSeg(gx, gy, beSeg[0], beSeg[1], beSeg[2], beSeg[3]);
        out = [pr.x / W, pr.y / H];
      }
    }
    if (kind === null && this.grid.on) {
      out = [this.grid.snap(out[0] * iw, this.grid.ox) / iw,
             this.grid.snap(out[1] * ih, this.grid.oy) / ih];
      kind = 'grid';
    }
    return { pt: [+out[0].toFixed(5), +out[1].toFixed(5)], kind };
  }

  /** Right-angle ("ortho") constraint for a point being placed/dragged, relative to
   *  its `neighbours` (the points it will connect to: a dragged vertex's two adjacent
   *  nodes, or while drawing the previous point — and the first point, for closing). If
   *  the edge from a neighbour to the pointer is within ORTHO_DEG of an axis, lock that
   *  axis to the neighbour's coordinate (so the two edges meet at 90°); the un-locked
   *  axis still snaps to the grid. An *angular* tolerance (not a fixed perpendicular px
   *  band) widens with edge length, so a long wall stays locked even as the cursor drifts
   *  — and it's zoom-invariant, so no viewport-scale division. Returns the constrained
   *  point plus `engaged` = `{x,y}` naming the neighbour each axis locked to (for the
   *  on-screen indicator), or null when nothing locked. */
  orthoSnap(nx, ny, neighbours) {
    const [W, H] = this.dispSize(), [iw, ih] = this.dims;
    let x = nx, y = ny, ex = null, ey = null;
    // Measure the edge angle in DISPLAYED px (multiply by W/H): the normalized 0..1 space
    // is non-uniform (iw≠ih) and would skew the angle (ARCHITECTURE §10). atan2(dx,dy) is
    // the edge's deviation from vertical; atan2(dy,dx) its deviation from horizontal.
    for (const nb of neighbours) {
      const dx = Math.abs((nx - nb[0]) * W), dy = Math.abs((ny - nb[1]) * H);
      if (Math.atan2(dx, dy) * 180 / Math.PI < ORTHO_DEG) { x = nb[0]; ex = nb; break; }
    }
    for (const nb of neighbours) {
      if (nb === ex) continue;   // don't lock both axes to one neighbour (would collapse the point onto it)
      const dx = Math.abs((nx - nb[0]) * W), dy = Math.abs((ny - nb[1]) * H);
      if (Math.atan2(dy, dx) * 180 / Math.PI < ORTHO_DEG) { y = nb[1]; ey = nb; break; }
    }
    if (this.grid.on) {
      if (ex === null) x = this.grid.snap(x * iw, this.grid.ox) / iw;
      if (ey === null) y = this.grid.snap(y * ih, this.grid.oy) / ih;
    }
    return { pt: [+x.toFixed(5), +y.toFixed(5)], engaged: (ex || ey) ? { x: ex, y: ey } : null };
  }

  /** Snap a point being placed or dragged. A vertex/edge snap to ANOTHER shape is the
   *  strongest intent and wins; otherwise, when right-angle snap is on and the point
   *  has `neighbours`, align it to a right angle (`orthoSnap`); else fall back to the
   *  plain vertex/edge/grid result. Returns `{ pt, kind, ortho }` (`ortho` = the
   *  engaged indicator info, or null). Shared by drawing and vertex dragging. */
  _placePoint(nx, ny, neighbours, exclude) {
    const snap = this.snapPoint(nx, ny, exclude);
    if (this.orthoOn && neighbours.length && snap.kind !== 'vertex' && snap.kind !== 'edge') {
      const o = this.orthoSnap(nx, ny, neighbours);
      return { pt: o.pt, kind: snap.kind, ortho: o.engaged };
    }
    return { pt: snap.pt, kind: snap.kind, ortho: null };
  }

  /** The points a draft's next/closing point should right-angle-align to: the last
   *  placed point (the edge being drawn) and the first point (to square up on close). */
  _draftNeighbours() {
    const dp = this.draft.points, nb = [];
    if (dp.length) nb.push(dp[dp.length - 1]);
    if (dp.length > 1) nb.push(dp[0]);
    return nb;
  }

  // ---- drawing lifecycle ----
  // `kind` is 'poly' (a closed polygon: rooms, hotspots), 'arrow' (an open
  // polyline: wayfinding routes), or 'note' (a single-point free-standing text
  // annotation). It changes how a click finishes the draft (polygons close near the
  // first point; arrows never do; a note finishes on its first click) and how it renders.
  beginDraw(msg, kind = 'poly') { this.draft = { points: [], cursor: null, kind }; this.selected = null; this.rectMode = false; if (msg) Toast.show(msg); this.render(); }
  undoNode() { if (this.draft && this.draft.points.length) { this.draft.points.pop(); this.draft.cursor = null; this.render(); } }

  /** Arm the rectangle tool: the next background drag lays out an axis-aligned box
   *  (instead of clicking points one at a time). Clears any draft/selection so the two
   *  drawing modes don't overlap. */
  beginRect(msg) { this.rectMode = true; this.rectDraft = null; this.draft = null; this.selected = null; if (msg) Toast.show(msg); this.render(); }

  /** Close a rectangle drag into a 4-point axis-aligned polygon and hand it to the
   *  subclass. Corners are already snapped (vertex/edge/grid) via snapPoint; a drag too
   *  small to be a real room is dropped. Leaves rect mode after one rectangle (like a
   *  drawn polygon opening its panel on finish). */
  _finishRect() {
    const d = this.rectDraft; this.rectDraft = null; this.rectMode = false;
    if (!d) { this.render(); return; }
    const x0 = Math.min(d.a[0], d.b[0]), x1 = Math.max(d.a[0], d.b[0]);
    const y0 = Math.min(d.a[1], d.b[1]), y1 = Math.max(d.a[1], d.b[1]);
    const [W, H] = this.dispSize();
    // Minimum footprint in layout px, so a stray click-without-drag makes nothing.
    if ((x1 - x0) * W < RECT_MIN_PX || (y1 - y0) * H < RECT_MIN_PX) { this.render(); return; }
    this._commitRect([[+x0.toFixed(5), +y0.toFixed(5)], [+x1.toFixed(5), +y0.toFixed(5)],
      [+x1.toFixed(5), +y1.toFixed(5)], [+x0.toFixed(5), +y1.toFixed(5)]]);
  }

  /** Wire pointer/keyboard interactions onto the svg. Called once per mount.
   *  The svg lives in `.map-wrap` (the transformed element) inside `.map-viewport`
   *  (the clip box / pan viewport). */
  attach(img, svgEl, dims) {
    this.img = img; this.svg = svgEl; this.dims = dims;
    this._imgsReady = false; this._fitted = false;   // a re-mount (arrange/edit toggle) re-fits from scratch
    this.detach();   // drop any observer from a prior mount before creating this one (BUG-2)
    // A non-interactive embed (dashboard widget, pan/zoom off) skips all interaction wiring and
    // the floating zoom controls — the map is still fitted (below) and re-fits on resize.
    if (this.app.interactive) this.pointer.bind();
    const wrap = svgEl.parentNode, container = wrap.parentNode;
    this.wrap = wrap;
    this.viewport.mount(wrap, container);
    // Cull the legibility-floored labels once the viewport is zoomed out to ~the overview,
    // where they'd otherwise pile into an unreadable carpet (READ-2). Fires only on a real
    // zoom change, so pans don't touch the class.
    this.viewport.onScale = (k) => this._applyLabelLod(k);
    if (this.app.interactive) container.append(this.toolbar.zoomControls());
    // Fit once the wrap has real dimensions. A floor can tile several sheets, so
    // wait for every <img> to settle (load or error) before measuring (each one grows the
    // wrap). A settled-but-broken sheet (HEALTH-9: a 404'd plan image) still counts — otherwise
    // a single missing sheet on a multi-sheet floor would starve _imgsReady forever and leave
    // the whole floor, not just that sheet, stuck unfitted. A multi-sheet floor frames its
    // primary sheet (this.initialFocus); else full fit. The fit still bails if the viewport
    // itself hasn't been laid out yet (a fit against a zero-size box is what leaves the map
    // stuck zoomed-in at the top-left); in that case _fitted stays false and the ResizeObserver
    // below retries once the container has a real size. After the first successful fit the
    // observer reverts to clamp-only, so a later window resize never resets the user's pan/zoom.
    const fit = () => {
      this.render();
      const ok = this.initialFocus ? this.viewport.fitRegion(...this.initialFocus) : this.viewport.fit();
      if (ok) this._fitted = true;
    };
    const imgs = [...wrap.querySelectorAll('img')];
    let pending = imgs.filter(im => !im.complete).length;
    const ready = () => { this._imgsReady = true; fit(); };
    const settle = () => { if (--pending === 0) ready(); };
    pending ? imgs.forEach(im => { if (im.complete) return;
      im.addEventListener('load', settle); im.addEventListener('error', settle); }) : ready();
    this._resizeObserver = new ResizeObserver(() => {
      if (this._imgsReady && !this._fitted) return fit();   // retry a fit that measured a not-yet-sized viewport
      this.render(); this.viewport.onResize();
    });
    this._resizeObserver.observe(container);
  }

  /** Disconnect the container `ResizeObserver` from `attach()`. Called at the top of `attach()`
   *  on a re-mount (arrange/edit toggle) and by `App` before replacing this editor on navigation,
   *  so the observer never accumulates across toggles and never outlives a torn-down editor
   *  (BUG-2 — an unreleased observer keeps the whole editor, and its container, reachable). */
  detach() {
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
  }

  /** Toggle the zoomed-out label cull (READ-2). Below `LABEL_LOD_SCALE` the CSS legibility floor
   *  has blown labels up enough that they'd overlap into a carpet, so `.labels-lod` hides them
   *  (the label being edited stays via `.lod-keep`); above it they draw normally and the floor
   *  keeps them readable. Driven by `PanZoom.onScale`, so it only runs on a real zoom change.
   *
   *  **Uncalling re-renders once (READ-5).** The cull hides labels with `display:none`, so while it
   *  is on `getBBox` reads no geometry: any render performed at overview zoom produces labels with
   *  no chip backdrop and no anti-overlap nudge (both skip an unmeasurable box). Pan/zoom never
   *  re-renders, so that degraded layout used to survive zooming back in — permanently, until some
   *  unrelated render replaced it. Repainting on the culled→visible edge fixes that, and is what
   *  lets `FloorEditor._nudgeLabels` skip its whole pass while the cull is on. One render per
   *  threshold crossing, keyed off the class alone — no store, no `labelStyle`, no geometry. */
  _applyLabelLod(k) {
    if (!this.svg) return;
    const culled = k < LABEL_LOD_SCALE;
    const was = this.svg.classList.contains('labels-lod');
    this.svg.classList.toggle('labels-lod', culled);
    if (was && !culled) this.render();
  }

  /** Make a side panel drag-resizable and collapsible, persisting its width + collapsed state to
   *  localStorage. Shared by both editors (the shared-base / Edit-menu-lockstep rule): the
   *  siteplan building index (`SiteplanEditor`) and the floor to-do list (`FloorEditor`) are the
   *  same interaction, so it lives here once rather than copy-pasted into each. The panel sits in a
   *  flex row beside the `flex:1 1 auto` `.map-viewport`, so changing only the panel width reflows
   *  the map, and that reflow trips the viewport's ResizeObserver (see `attach`), which re-clamps
   *  pan/zoom — keeping normalized 0..1 coordinates correct after a resize.
   *
   *  `opts = { view, panel, handle, title, widthKey, collapsedKey, minW, collapseW, defaultW,
   *  maxFrac }`: `view` is the flex-row container, `panel`/`handle` the elements to size/drag,
   *  `title` the tooltip the shared `#panel-toggle` wears while this editor owns it (the one button
   *  serves both panels, so it must name whichever it currently opens), and the remaining keys the
   *  panel's own localStorage keys + sizing, so the two panels persist and clamp independently.
   *  Non-embed only (the chrome-free dashboard embed keeps a plain fixed panel). */
  _installPanelResize(opts) {
    const { view, panel, handle, title, widthKey, collapsedKey, minW, collapseW, defaultW, maxFrac } = opts;
    // The single show/hide control is the shared top-bar toggle (NAV-8), a persistent `#topbar`
    // button. Only one editor is shown at a time, so both panels reuse this one button: reveal it
    // on this non-embed path (App.router re-hides it on leaving) and mirror the panel's visibility
    // as its `.active` state. Reassigned (not addEventListener) each show, so re-entering a view
    // never stacks handlers on the persistent button.
    const toggle = Dom.$('#panel-toggle');
    toggle.hidden = false;
    if (title) toggle.title = title;

    const maxW = () => Math.max(minW, Math.round(view.clientWidth * maxFrac));
    const applyWidth = (w) => {
      panel.style.width = Math.round(Math.min(maxW(), Math.max(minW, w))) + 'px';
    };
    const setCollapsed = (on, persist = true) => {
      panel.hidden = on; handle.hidden = on;
      toggle.classList.toggle('active', !on);   // pressed when the panel is showing
      toggle.setAttribute('aria-pressed', String(!on));
      if (persist) { try { localStorage.setItem(collapsedKey, on ? '1' : '0'); } catch (e) {} }
    };

    // Restore persisted state. Width is applied even while collapsed so a later expand returns to
    // the remembered size.
    const saved = this._loadPanelWidth(widthKey);
    applyWidth(saved != null ? saved : defaultW);
    setCollapsed(this._loadPanelCollapsed(collapsedKey), false);
    // Published so a subclass can open its own panel programmatically — the floor's per-room "+"
    // reveals the to-do panel before pre-filling the composer. Kept as the one writer of the
    // collapsed state (toggle `.active`, persistence) so no caller can half-set it by hand.
    this._setPanelCollapsed = setCollapsed;
    this._panelCollapsed = () => panel.hidden;

    toggle.onclick = () => setCollapsed(!panel.hidden);
    handle.addEventListener('dblclick', () => setCollapsed(true));

    let startX = 0, startW = 0, willCollapse = false;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      startX = e.clientX; startW = panel.offsetWidth; willCollapse = false;
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
    });
    handle.addEventListener('pointermove', (e) => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      const desired = startW + (startX - e.clientX);   // drag left → widen, right → narrow
      willCollapse = desired < collapseW;
      handle.classList.toggle('will-collapse', willCollapse);
      applyWidth(desired);
    });
    const end = (e) => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      handle.releasePointerCapture(e.pointerId);
      handle.classList.remove('dragging', 'will-collapse');
      if (willCollapse) { setCollapsed(true); return; }   // released past the min → collapse
      try { localStorage.setItem(widthKey, String(panel.offsetWidth)); } catch (e2) {}
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  /** Persisted panel width (px) for `key`, or null when unset/invalid. */
  _loadPanelWidth(key) {
    try { const v = Number(localStorage.getItem(key)); return v > 0 ? v : null; }
    catch (e) { return null; }
  }
  /** Whether the panel under `key` was left collapsed; defaults to expanded when unset. */
  _loadPanelCollapsed(key) {
    try { return localStorage.getItem(key) === '1'; }
    catch (e) { return false; }
  }

  // Keyboard dispatch seam: the shared engine's bindings live on EditorPointer.handleKey;
  // each subclass overrides this with its own rungs and falls through via `super.handleKey(e)`.
  handleKey(e) { this.pointer.handleKey(e); }

  /** Escape's first rung in both editors: leaving label-edit backs out to the shape's OWN panel
   *  rather than dropping the selection, so a label edit is one Escape from the thing it belongs to
   *  and two from nothing. `reopen` re-opens that panel — it runs after `editingLabel` is cleared
   *  and the label has re-rendered without its handles, so the panel it opens is the plain one.
   *  Returns whether the rung fired, so a caller can fall through to its next rung.
   *
   *  Every Escape ladder rung of this shape goes through here (siteplan hotspot, floor route arrow,
   *  floor rack/device marker in both plain-edit and Place-racks) — it is the same interaction, so
   *  it is one implementation on the base (§10 *Edit-menu lockstep*). Capture whatever the reopen
   *  needs BEFORE calling: `editingLabel` is gone by the time the callback runs. */
  _exitLabelEdit(reopen) {
    if (!this.editingLabel) return false;
    this.editingLabel = null;
    this.render();
    if (reopen) reopen();
    return true;
  }

  // ---- label-engine hooks (the engine itself lives on EditorShapes) ----
  // Identity + dirty hooks so the label engine serves more than one shape kind.
  // Base = a shape keyed by `id`, dirtying the room/hotspot store. FloorEditor
  // overrides these for placements (keyed by `uid`, dirtying the placement store).
  _labelKey(shape) { return shape.id; }
  _labelDirty(shape) { this.markDirty(); }

  // ---- toolbar support (the bar itself is built by EditorToolbar) ----

  /** innerHTML for a saved/unsaved status badge (green check when saved). */
  badgeHtml(dirty) { return dirty ? '<span>● unsaved</span>' : Icons.check + '<span>saved</span>'; }

  /** The persisted right-angle-snap toggle; defaults to on when unset. */
  _loadOrtho() {
    try { const v = localStorage.getItem(ORTHO_KEY); return v === null ? true : v === '1'; }
    catch (e) { return true; }
  }

  // ---- shortcuts declaration (UX-17, shared by both editors; rendered by EditorToolbar) ----
  /** What this editor binds, as DATA — `[{ title, rows: [[keys, what]] }]`, where `keys` is a
   *  display string whose `+` and `/` separators the renderer splits into `<kbd>`s.
   *
   *  Driving the panel from a per-editor declaration rather than one hardcoded list is the point:
   *  the two editors bind overlapping-but-different keys, and a panel that promised the union
   *  would be wrong in both. The base declares the shared engine; a subclass returns
   *  `super._shortcutGroups()` plus its own. **A new key binding must arrive with its row here**
   *  — a shortcut the panel doesn't list is undiscoverable again, which is the bug this exists to
   *  fix (see architecture §10). */
  _shortcutGroups() {
    return [
      { title: 'View', rows: [
        ['+ / −', 'Zoom in / out'],
        ['0', 'Reset the zoom to fit'],
        ['Scroll', 'Zoom at the pointer'],
        ['Drag background', 'Pan the map'],
        ['?', 'Open this list'],
      ] },
      { title: 'Drawing', rows: [
        ['Click', 'Place the next point'],
        ['Enter', 'Close the shape being drawn'],
        ['Double-click', 'Close the shape being drawn'],
        ['Backspace', 'Remove the last point placed'],
        ['Right-click a point', 'Remove that point'],
        ['Esc', 'Cancel what is being drawn'],
      ] },
      { title: 'Editing a shape', rows: [
        ['Drag a vertex', 'Reshape the outline'],
        ['Drag a midpoint', 'Insert a new vertex on that edge'],
        ['Right-click a vertex', 'Remove that vertex'],
        ['Alt', 'Hold to ignore the grid while dragging'],
        ['Ctrl + Z', 'Undo the last change'],
        ['Esc', 'Deselect the current shape'],
      ] },
    ];
  }

  // Toolbar hooks (assembled by EditorToolbar.build) — a subclass overrides only what it needs. `_editButtons` are the
  // mode-specific draw/add tools: BOTH editors get the polygon + rectangle pair from the
  // base (undo is appended by it too), and a subclass with more tools appends them
  // (FloorEditor's arrow/note) rather than replacing the pair. `_alignTools` is the
  // snap/right-angle/grid factory row; `_deviceTools` are the device-placement tools
  // (AP/rack); `_editExtras` are the trailing edit-only tools (arrange/copy/overlay);
  // `_viewButtons` are the view-mode tools; `_showsSave` gates the Save+badge cluster
  // (SiteplanEditor hides it in view — its home screen stays uncluttered).
  _editButtons() { return [this.toolbar.drawShapeButton(), this.toolbar.rectShapeButton()]; }
  _alignTools() { return [this.toolbar.snapButton(), this.toolbar.orthoButton(), this.toolbar.gridToggleButton(), this.toolbar.gridSizeSelect(), this.toolbar.gridMoveButton()]; }
  _deviceTools() { return []; }
  _editExtras() { return []; }
  _viewButtons() { return []; }
  _showsSave() { return true; }
  _saveLabel() { return 'Save'; }

  /** Gate the edit ⇄ view toggle on unsaved work. Leaving edit mode (`view`) with a dirty
   *  editor prompts Save / Leave / Cancel before dispatching; entering edit, or leaving a
   *  clean editor, switches immediately. The gate sits here — at `EditorToolbar._modeButton`'s onclick,
   *  BEFORE `_switchMode` — so it covers both editors and `FloorEditor`'s Arrange sub-mode
   *  override (which early-returns without calling the base `_switchMode`). Save awaits the
   *  persist and only exits on success; Leave discards the in-memory edits via `store.discard`
   *  (re-fetching authoritative server state, mirroring the page-nav guard) so view mode shows
   *  reverted data with a clean badge; Cancel stays in edit. */
  async _requestModeSwitch(mode) {
    if (mode === 'view' && this._dirty()) {
      const choice = await this._confirmLeaveEdit();
      if (choice === 'cancel') return;
      if (choice === 'save') { if (!await this.save()) return; }
      else {
        try { await this.store.discard(); }
        catch (e) { Toast.show('Could not discard unsaved changes: ' + e.message, true); return; }
      }
    }
    this._switchMode(mode);
  }

  /** Unsaved-work prompt shown when leaving edit mode, resolving `'save'` / `'exit'` /
   *  `'cancel'`; backdrop, Escape, Cancel, or a resolved choice each dismiss it exactly once.
   *  Three-way rather than the two-way `App._confirmLeavePage`, so Save — not Cancel — is the
   *  emphasized recommendation, while the discard path wears the same `.danger` it does there. */
  _confirmLeaveEdit() {
    return Modal.choose({
      title: 'Unsaved changes',
      body: 'You have unsaved changes. Leaving edit mode without saving will discard them.',
      dismiss: 'cancel',
      choices: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Leave without saving', value: 'exit', class: 'danger' },
        { label: 'Save', value: 'save', class: 'primary' },
      ],
    });
  }

  /** Toggle edit ⇄ view in place — rebuild the toolbar and re-`render()` against the
   *  existing `.map-wrap` rather than calling `show()`, so the live PanZoom (the user's
   *  zoom/pan) survives the toggle (ARCHITECTURE §10). Resets the common editing state;
   *  `_setEditing` writes the subclass editing flag and `_onModeSwitch` does any
   *  subclass-specific reset/side-effect. The panel close is guarded by `_switchingMode`
   *  so a sub-mode's `onPanelClosed` doesn't fight the change. FloorEditor overrides this
   *  for the one sub-mode (Arrange) whose padded canvas needs a full `show()` relayout. */
  _switchMode(mode) {
    this._setEditing(mode === 'edit');
    this.draft = null; this.selected = null; this.editingLabel = null;
    this.rectMode = false; this.rectDraft = null; this.grid.adjust = false;
    this._onModeSwitch(mode);
    this._switchingMode = true;
    this.app.closePanel();
    this._switchingMode = false;
    this.app.setToolbar(this.toolbar.build());   // rebuild: the badge/_dirty() meaning is per-mode
    this.render();
  }
  _setEditing(on) {}                 // subclass writes its editing flag (app.mode / app.siteEdit)
  _onModeSwitch(mode) {}             // subclass extra resets / side-effects on a mode change

  // ---- shared Save button + dirty badge ----
  /** Whether this editor has unsaved work (drives the badge). Base default false; a
   *  subclass that persists overrides it (e.g. the siteplan dirty flag, or the floor's
   *  three-category union). */
  _dirty() { return false; }
  /** Persist this editor's work, then refresh the badge and toast. History is deliberately
   *  KEPT across a save so a just-saved mistake stays undoable (SAVE-6) — the save advances the
   *  store baselines, and an undo restore re-derives the dirty flags from those baselines
   *  (`recomputeFloorDirty`/`recomputeSiteDirty`), so undoing back across the save re-marks the
   *  badge dirty against the now-saved data rather than restoring a stale clean flag.
   *  The whole scaffold — the try/catch and the shared failure toast — lives here so the
   *  two editors can't drift; a subclass supplies only the store writes (`_persist`) and,
   *  if different, the success message (`_savedMessage`). Returns `true` on success, `false` on
   *  failure, so a caller (the leave-edit guard) can gate the exit on the save landing. */
  async save() {
    try {
      await this._persist();
      this._setBadge();
      Toast.show(this._savedMessage());
      return true;
    } catch (e) {
      // A version conflict (409, `Api.postV` flags `e.conflict`) already carries the friendly
      // "the map changed — reload and re-apply" guidance as its message; show it verbatim rather
      // than burying it under a generic "Save failed:" prefix. The edits stay in memory (the save
      // threw before clearing the dirty flag), so the user can reload and re-apply (CONC-1).
      if (e.conflict) { Toast.show(e.message, true); return false; }
      // Any other failure — a session/CSRF expiry (403) after a long edit, a transient network or
      // server error — keeps the edits in memory AND in the local crash-recovery draft (SAVE-5), so
      // nothing is lost. Offer an actionable Retry via a modal rather than a toast that auto-dismisses.
      const choice = await this._saveFailedDialog(e);
      if (choice === 'retry') return this.save();
      if (choice === 'reload') { location.reload(); return false; }
      return false;
    }
  }

  /** Save-failure prompt (non-conflict). It surfaces the error and offers Retry: the edits are kept
   *  in memory and mirrored to a local draft (SAVE-5), so a failed save never silently loses work. A
   *  likely session/CSRF expiry (403, `Api.postV` flags `e.authExpired`) also offers Reload, whose
   *  re-auth + on-load draft-restore prompt brings the work back. Resolves
   *  `'retry' | 'reload' | 'dismiss'`; backdrop, Escape, or Dismiss resolves `'dismiss'`. Nothing
   *  here is destructive — the work survives every choice — so Retry simply takes the emphasis. */
  _saveFailedDialog(e) {
    const choices = [{ label: 'Dismiss', value: 'dismiss' }];
    if (e.authExpired) choices.push({ label: 'Reload page', value: 'reload' });
    choices.push({ label: 'Retry', value: 'retry', class: 'primary' });
    return Modal.choose({
      title: 'Save failed',
      body: e.authExpired
        ? 'Your session may have expired, so the save was rejected. Your changes are kept and saved '
          + 'as a local draft, so they will not be lost — reload to sign back in (your draft is offered '
          + 'on load), or retry now.'
        : 'The save could not be completed: ' + e.message + ' Your changes are kept and saved as a '
          + 'local draft, so they will not be lost.',
      dismiss: 'dismiss',
      choices,
    });
  }
  /** The actual store writes for this editor. Subclass responsibility. */
  _persist() {}
  /** Toast shown on a successful save. */
  _savedMessage() { return 'Saved'; }
  /** The primary Save button. */
  _saveButton() { return Dom.el('button', { class: 'primary', onclick: () => this.save() }, this._saveLabel()); }
  /** (Re)build the saved/unsaved status badge, stashing it on `_badge` so `_setBadge` can
   *  refresh it in place as edits land. */
  _badgeEl() {
    const dirty = this._dirty();
    this._badge = Dom.el('span', { class: 'badge' + (dirty ? ' dirty' : ''), html: this.badgeHtml(dirty) });
    return this._badge;
  }
  /** Refresh the current badge to match `_dirty()` (after an edit or a save). */
  _setBadge() {
    if (!this._badge) return;
    const dirty = this._dirty();
    this._badge.innerHTML = this.badgeHtml(dirty);
    this._badge.classList.toggle('dirty', dirty);
  }

  // ---- shared searchable bind-list panel (both editors' detail panels) ----
  /** A searchable bind-list: a `#room-search` input over a filtered list of `.room-item`
   *  rows (`.nm` primary + `.sl` sub, `.bound` when selected). Shared by the floor
   *  room→Location panel and the siteplan area→building panel. `opts`:
   *  `{ items, placeholder, filter(item, ql)→bool, row(item)→{nm, sl, bound}, pick(item),
   *  limit?, footer? }`. `limit` truncates the rendered rows and (UX-16) appends a "Showing N of
   *  M — type to narrow" hint whenever the untruncated match count exceeds it, so hitting the cap
   *  never silently reads as "that's everything" — the floor panel's NetBox-Location list is the
   *  one caller large enough to hit it. `footer(list, matches, ql)` (optional) is invoked after the
   *  rows on every keystroke so a caller can append a match-count-aware affordance into the results
   *  — the floor panel uses it for the contextual "create new room" tile (LOC-2); the siteplan
   *  panel passes none, so it is unaffected. Appends the input + list into `body`, auto-focuses,
   *  and returns `{ search, list, renderList }` so a caller can splice extra hints around them. */
  _bindList(body, opts) {
    const search = Dom.el('input', { id: 'room-search', placeholder: opts.placeholder });
    body.append(search);
    const list = Dom.el('div', {}); body.append(list);
    const renderList = (q) => {
      list.innerHTML = '';
      const ql = q.toLowerCase();
      let matches = opts.items.filter((it) => opts.filter(it, ql));
      const total = matches.length;
      if (opts.limit) matches = matches.slice(0, opts.limit);
      for (const it of matches) {
        const r = opts.row(it);
        const item = Dom.el('div', { class: 'room-item' + (r.bound ? ' bound' : '') }, [
          Dom.el('div', { class: 'nm' }, r.nm),
          Dom.el('div', { class: 'sl' }, r.sl),
        ]);
        item.onclick = () => opts.pick(it);
        list.append(item);
      }
      // The list silently dropped everything past `limit` (UX-16) — flag it so a search that
      // still hits the cap reads as "narrow your query", not as "that's everything".
      if (opts.limit && total > opts.limit) list.append(Dom.el('div', { class: 'hint bindlist-limit' },
        'Showing ' + opts.limit + ' of ' + total + ' — type to narrow'));
      if (opts.footer) opts.footer(list, matches, ql);
    };
    search.addEventListener('input', () => renderList(search.value));
    renderList(''); search.focus();
    return { search, list, renderList };
  }
}
