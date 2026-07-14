'use strict';
/* editor.js — Editor: abstract base for the polygon editors.
   Encapsulates the shared engine: an <svg> overlay on an image, normalized
   coordinates, grid + vertex/edge snapping, polygon drawing with a live cursor,
   undo, vertex dragging, and grid move/resize. Subclasses (FloorEditor,
   SiteplanEditor) supply the data + the meaning of a shape.

   The overlay is split into three stacked <g> layers (bottom→top: grid / static /
   active) so a drag redraws only the moving element instead of the whole shape layer.
   A full render() rebuilds all three; per-frame drags call renderActive() (or
   renderGrid()), which rebuild just one layer. See ARCHITECTURE §10.

   Subclasses MUST implement: _renderStatic(s,W,H), _renderActive(s,W,H), polys(),
   editing(), finish(), deselect(), markDirty(). Coordinates everywhere are
   normalized 0..1 to the image. */

const ORTHO_KEY = 'facilitymap:ortho';   // persisted right-angle-snap toggle (default on)

class Editor {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.grid = app.grid;          // shared GridController
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
    this.dragSheet = null;         // { move(nx,ny), drop() } while dragging a whole sheet (Arrange mode)
    this.pan = null;               // { x, y, moved, btn } while panning the viewport
    this._pointers = new Map();    // active TOUCH pointerId -> { x, y }, tracked for multi-touch pinch-zoom
    this._pinch = null;            // { dist, mx, my } while two fingers pinch-zoom the viewport (view-mode touch)
    this._dragDown = null;         // { x, y, moved } press origin for the vertex/item drag threshold
    this._suppressClick = false;   // swallow the click that ends a left-button pan drag
    this.initialFocus = null;      // [nx0,ny0,nx1,ny1] to frame on first mount, else full fit
    this.rectMode = false;         // rectangle draw tool armed: drag a box instead of clicking points
    this.rectDraft = null;         // { a:[nx,ny], b:[nx,ny] } while dragging out a rectangle
    this.history = new UndoStack();// per-editor undo stack (Ctrl+Z); opaque snapshots, see _snapshotState
    this._gestureSnap = null;      // pre-drag snapshot, committed to history only if the drag mutates
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
  finish() {}                      // close the current draft into a shape
  deselect() {}
  markDirty() {}

  // ---- undo (Ctrl+Z) ----
  // A subclass opts into undo by implementing this pair. `_snapshotState()` returns a
  // JSON-serializable clone of everything a mutation could change (its shapes + the
  // store dirty flags), or null to opt out (the base default — undo is then a no-op).
  // `_restoreState(snap)` applies such a snapshot back onto the store and refreshes the
  // badge. Snapshots are taken BEFORE a mutation (and before markDirty), so restoring
  // one also restores the pre-edit dirty state — undoing back to a saved state clears
  // the badge for free.
  _snapshotState() { return null; }
  _restoreState(snap) {}

  /** Capture the current state onto the undo stack, before a mutating operation. */
  snapshot() { const s = this._snapshotState(); if (s) this.history.push(s); }
  /** Undo the most recent captured mutation, if any. */
  undo() {
    const snap = this.history.pop();
    if (!snap) return;
    this._restoreState(snap);
    this.render();
  }

  /** Commit a finished rectangle (a 4-point normalized polygon) into a shape. Base
   *  no-op; FloorEditor turns it into a room. */
  _commitRect(poly) {}

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
    // A non-interactive embed (dashboard widget, pan/zoom off) skips all interaction wiring and
    // the floating zoom controls — the map is still fitted (below) and re-fits on resize.
    if (this.app.interactive) this._bindPointer();
    const wrap = svgEl.parentNode, container = wrap.parentNode;
    this.wrap = wrap;
    this.viewport.mount(wrap, container);
    if (this.app.interactive) container.append(this._zoomControls());
    // Fit once the wrap has real dimensions. A floor can tile several sheets, so
    // wait for every <img> to load before measuring (each one grows the wrap). A
    // multi-sheet floor frames its primary sheet (this.initialFocus); else full fit.
    // The fit still bails if the viewport itself hasn't been laid out yet (a fit
    // against a zero-size box is what leaves the map stuck zoomed-in at the top-left);
    // in that case _fitted stays false and the ResizeObserver below retries once the
    // container has a real size. After the first successful fit the observer reverts
    // to clamp-only, so a later window resize never resets the user's pan/zoom.
    const fit = () => {
      this.render();
      const ok = this.initialFocus ? this.viewport.fitRegion(...this.initialFocus) : this.viewport.fit();
      if (ok) this._fitted = true;
    };
    const imgs = [...wrap.querySelectorAll('img')];
    let pending = imgs.filter(im => !im.complete).length;
    const ready = () => { this._imgsReady = true; fit(); };
    pending ? imgs.forEach(im => im.complete || im.addEventListener('load',
      () => { if (--pending === 0) ready(); })) : ready();
    new ResizeObserver(() => {
      if (this._imgsReady && !this._fitted) return fit();   // retry a fit that measured a not-yet-sized viewport
      this.render(); this.viewport.onResize();
    }).observe(container);
  }

  _bindPointer() {
    const s = this.svg;
    // Claim touch gestures so the browser doesn't hijack them (page scroll / native
    // pinch-zoom) — without this it steals the sequence and fires pointercancel instead
    // of delivering our pointermove, breaking touch pan. Set here (not in CSS) so it
    // stays gated to interactive maps: a non-interactive embed never binds pointers and
    // keeps normal page scrolling over the card.
    s.style.touchAction = 'none';
    // Record the press origin for the vertex/item drag threshold. Capture phase so it
    // fires before a vertex/marker handler's stopPropagation hides the event from us.
    // Snapshot the pre-drag state here too (still cheap, JSON clone): a vertex/marker
    // drag mutates in place across pointermove frames, so this is the only moment we can
    // capture the "before". It is committed to the undo history on pointerup ONLY if the
    // gesture actually moved geometry — a pan or a sub-threshold click discards it.
    // Track active TOUCH pointers here too so a second finger can start a pinch-zoom.
    // Touch-only by design: pinch is a touch gesture, and keeping mouse/pen out of the
    // registry avoids a stale entry (a button released off-svg) ever faking a pinch.
    s.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pointers.size === 2) this._beginPinch();
      this._dragDown = { x: e.clientX, y: e.clientY, moved: false };
      this._gestureSnap = this._snapshotState();
    }, true);
    s.addEventListener('click', (e) => {
      if (this._suppressClick) { this._suppressClick = false; return; }
      if (!this.editing() || this.grid.adjust) return;
      if (this.draft) {
        const snapped = this._placePoint(...this.evtNorm(e), this._draftNeighbours()).pt;
        const dp = this.draft.points;
        // A text note is a single-point shape: the first click places it and finishes.
        if (this.draft.kind === 'note') { dp.push(snapped); return this.finish(); }
        // Polygons close when you click near the first point; an open arrow never does.
        if (this.draft.kind !== 'arrow' && dp.length >= 3) {
          const [W, H] = this.dispSize();
          const d = Math.hypot((snapped[0] - dp[0][0]) * W, (snapped[1] - dp[0][1]) * H);
          if (d < CLOSE_PX / this.viewport.scale) return this.finish();
        }
        dp.push(snapped); this.draft.cursor = null; this.render();
      } else { this.deselect(); }
    });
    s.addEventListener('dblclick', (e) => { e.preventDefault(); if (this.draft) this.finish(); });
    s.addEventListener('pointerdown', (e) => {
      if (this.grid.adjust && this.gridActive()) {
        this.gridDrag = { x: e.clientX, y: e.clientY, ox: this.grid.ox, oy: this.grid.oy };
        s.setPointerCapture(e.pointerId); return;
      }
      // Pan: middle button anywhere, or left button on empty map background
      // (the svg itself or the transparent catcher — never a shape or vertex).
      const onBackground = e.target === s || e.target.classList.contains('catcher');
      // Rectangle tool: a left-button background press begins a box drag (takes the
      // background gesture that would otherwise pan).
      if (this.rectMode && e.button === 0 && onBackground && this.editing() && !this.grid.adjust) {
        const start = this.snapPoint(...this.evtNorm(e)).pt;
        this.rectDraft = { a: start, b: start };
        s.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button === 1 || (e.button === 0 && onBackground)) {
        this.pan = { x: e.clientX, y: e.clientY, moved: false, btn: e.button };
        s.setPointerCapture(e.pointerId);
      }
    });
    s.addEventListener('pointermove', (e) => {
      if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pinch) { this._updatePinch(); return; }
      if (this.pan) {
        const dx = e.clientX - this.pan.x, dy = e.clientY - this.pan.y;
        if (!this.pan.moved && Math.hypot(dx, dy) < 4) return;
        this.pan.moved = true; this.pan.x = e.clientX; this.pan.y = e.clientY;
        s.classList.add('panning'); this.viewport.panBy(dx, dy); return;
      }
      if (this.gridDrag) {
        const [W, H] = this.dispSize(), [iw, ih] = this.dims, k = this.viewport.scale;
        this.grid.ox = this.gridDrag.ox + (e.clientX - this.gridDrag.x) / k / W * iw;
        this.grid.oy = this.gridDrag.oy + (e.clientY - this.gridDrag.y) / k / H * ih;
        this.renderGrid(); return;
      }
      if (this.rectDraft) { this.rectDraft.b = this.snapPoint(...this.evtNorm(e)).pt; this.renderActive(); return; }
      if (this.dragSheet) { this.dragSheet.move(...this.evtNorm(e)); return; }
      // A vertex/marker press only becomes an edit once the pointer travels past a
      // small threshold; below it the press is a select/inspect click and must not
      // move geometry or mark the store dirty (else a stray click looks like an edit).
      if ((this.dragItem || this.dragVertex) && !this._pastDragThreshold(e)) return;
      if (this.dragItem) { this.dragItem.move(...this.evtNorm(e), e); return; }
      if (this.dragVertex) {
        // A midpoint press defers inserting its node until the drag really starts, so
        // clicking a midpoint without dragging adds nothing (and stays clean).
        if (this.dragVertex.pending) {
          this.dragVertex.poly.splice(this.dragVertex.i, 0, this.dragVertex.point);
          this.dragVertex.pending = false;
        }
        const { poly, i, exclude, dirty, closed } = this.dragVertex;
        const n = poly.length;
        // Right-angle neighbours are the adjacent nodes. A closed polygon wraps; an
        // open path (arrow) has none past its two ends, so don't wrap across them.
        const nbs = closed === false
          ? [i > 0 ? poly[i - 1] : null, i < n - 1 ? poly[i + 1] : null].filter(Boolean)
          : [poly[(i - 1 + n) % n], poly[(i + 1) % n]];
        const r = this._placePoint(...this.evtNorm(e), nbs, exclude);
        poly[i] = [Math.max(0, Math.min(1, r.pt[0])), Math.max(0, Math.min(1, r.pt[1]))];
        this.dragVertex.ortho = r.ortho;
        dirty(); this.renderActive(); return;
      }
      if (this.draft) {
        const r = this._placePoint(...this.evtNorm(e), this._draftNeighbours());
        this.draft.cursor = { pt: r.pt, kind: r.kind, ortho: r.ortho };
        this.renderActive();
      }
    });
    s.addEventListener('pointerup', (e) => {
      // A finger lifting out of a pinch ends (or, with one finger left, resumes a pan);
      // skip the normal single-pointer teardown below, which would null the resumed pan.
      if (this._pointers.delete(e.pointerId) && this._pinch) {
        if (this._pointers.size < 2) this._endPinch();
        return;
      }
      // A rectangle drag ends here: build the box and commit it as a shape (its own
      // undo snapshot is taken inside _commitRect). Swallow the trailing click.
      if (this.rectDraft) { this._suppressClick = true; this._finishRect(); return; }
      // A sheet drag ends here: commit the move (which re-renders) and swallow the
      // trailing click so it doesn't deselect/draw.
      if (this.dragSheet) { this._suppressClick = true; const d = this.dragSheet; this.dragSheet = null; d.drop(); return; }
      // A left-button pan is followed by a click event — swallow that one click.
      if (this.pan && this.pan.moved && this.pan.btn === 0) this._suppressClick = true;
      // A vertex/handle press or drag also ends with a synthetic click on the svg;
      // swallow it so it doesn't fall through to the background-click deselect,
      // keeping the shape selected for the next node edit.
      if (this.dragVertex || this.dragItem) this._suppressClick = true;
      // A vertex/marker drag that actually moved geometry commits its pre-drag snapshot
      // to the undo history (captured on pointerdown). A press that never passed the
      // drag threshold — a plain select/inspect click — mutated nothing, so discard it.
      if ((this.dragVertex || this.dragItem) && this._dragDown && this._dragDown.moved
          && this._gestureSnap) this.history.push(this._gestureSnap);
      this._gestureSnap = null;
      const hadVertex = !!this.dragVertex;
      this.pan = null; s.classList.remove('panning');
      this.dragVertex = null; this.gridDrag = null; this.dragItem = null;
      if (hadVertex) this.renderActive();   // drop the transient right-angle guide
    });
    s.addEventListener('pointerleave', () => {
      if (this.draft && this.draft.cursor) { this.draft.cursor = null; this.render(); }
    });
    // A cancelled pointer (the browser reclaimed the gesture) never fires pointerup —
    // forget it and unwind any pinch/pan so the next touch starts clean.
    s.addEventListener('pointercancel', (e) => {
      this._pointers.delete(e.pointerId);
      if (this._pinch && this._pointers.size < 2) this._endPinch();
      this.pan = null; s.classList.remove('panning');
    });
    s.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.grid.adjust && this.gridActive()) { this.grid.resize(e.deltaY); this.render(); return; }
      this.viewport.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, { x: e.clientX, y: e.clientY });
    }, { passive: false });
  }

  /** True once a vertex/marker press has travelled far enough to count as a drag
   *  (latched, like the pan threshold). Below it the press is a select/inspect click. */
  _pastDragThreshold(e) {
    const d = this._dragDown;
    if (!d || d.moved) return true;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return false;
    d.moved = true; return true;
  }

  // ---- multi-touch pinch-zoom (view-mode touch; MOBILE-1) ----
  // Two fingers zoom the viewport. Zoom is safe in every mode, but a pinch never
  // hijacks an in-progress edit gesture (vertex/marker/sheet/grid/rect/draft), so
  // edit-mode interactions — which stay desktop/mouse-only by design — are untouched.

  /** A second finger landed: begin a pinch. Converts any in-progress background pan
   *  into the pinch and seeds the initial finger distance + midpoint. */
  _beginPinch() {
    if (this.dragVertex || this.dragItem || this.dragSheet || this.gridDrag
        || this.rectDraft || this.draft) return;
    const [a, b] = [...this._pointers.values()];
    this._pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y),
      mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    this.pan = null; this.svg.classList.remove('panning');
  }

  /** Per-move pinch update: scale about the finger midpoint by the distance ratio,
   *  and pan by how far that midpoint travelled (so a two-finger drag also translates). */
  _updatePinch() {
    if (this._pointers.size < 2) return;
    const [a, b] = [...this._pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (this._pinch.dist > 0) this.viewport.zoomBy(dist / this._pinch.dist, mid);
    this.viewport.panBy(mid.x - this._pinch.mx, mid.y - this._pinch.my);
    this._pinch = { dist, mx: mid.x, my: mid.y };
  }

  /** A finger lifted, ending the pinch. If exactly one finger remains, flow straight
   *  into a one-finger pan from it so lifting one finger doesn't strand the map. */
  _endPinch() {
    this._pinch = null;
    if (this._pointers.size !== 1) return;
    const [id] = [...this._pointers.keys()], p = this._pointers.get(id);
    this.pan = { x: p.x, y: p.y, moved: true, btn: 0 };
    try { this.svg.setPointerCapture(id); } catch (e) { /* pointer already gone */ }
  }

  handleKey(e) {
    if (e.key === 'Enter' && this.draft) { this.finish(); return; }
    // Ctrl/Cmd-Z: mid-draw it pops the last draft point; otherwise it undoes the last
    // committed mutation off the per-editor history stack.
    if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); this.draft ? this.undoNode() : this.undo(); return;
    }
    if (e.key === 'Backspace' && this.draft) { e.preventDefault(); this.undoNode(); return; }
    if (e.key === '+' || e.key === '=') { this.viewport.zoomBy(1.3); return; }
    if (e.key === '-' || e.key === '_') { this.viewport.zoomBy(1 / 1.3); return; }
    if (e.key === '0') { this.viewport.fit(); return; }
    if (e.key === 'Escape') {
      if (this.rectMode) { this.rectMode = false; this.rectDraft = null; this.render(); }
      else if (this.draft) { this.draft = null; this.render(); }
      else if (this.selected) { this.selected = null; this.render(); this.app.closePanel(); }
    }
  }

  // ---- shared render helpers (subclasses call these inside _renderStatic/_renderActive) ----
  addCatcher(s, W, H) {
    // Always catches background pointer events (for panning and, in edit mode,
    // for drawing). Shapes are drawn on top, so their clicks still take priority.
    const c = Dom.svg('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent', class: 'catcher' });
    c.style.pointerEvents = 'all';
    s.append(c);
  }
  /** Editable vertices for the selected shape: drag a vertex to reshape, drag a
   *  midpoint handle to insert a node on that edge, right-click a vertex to remove
   *  it (kept at >= `minPts` points). Midpoints are drawn first so the draggable
   *  vertices sit on top. Insert/remove reuse the `dragVertex` channel (capture is on
   *  the svg, so it survives the render() that rebuilds the handles).
   *  `opts.closed` (default true) treats `poly` as a closed polygon (rooms, hotspots);
   *  false treats it as an open polyline (arrows) — no midpoint/ortho on the phantom
   *  edge from the last point back to the first. `opts.minPts` is the removal floor. */
  drawVertices(s, poly, W, H, excludeId, dirtyFn, opts = {}) {
    const { closed = true, minPts = 3 } = opts;
    const dv = this.dragVertex;
    if (dv && dv.poly === poly && dv.ortho) this._drawOrthoGuide(s, poly[dv.i], dv.ortho, W, H);
    const segs = closed ? poly.length : poly.length - 1;
    for (let i = 0; i < segs; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const m = Dom.svg('circle', { cx: mx * W, cy: my * H, r: 4, class: 'vertex midpoint' });
      m.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        // Defer the insert until the drag passes the threshold (see pointermove), so a
        // click on a midpoint that never drags adds no node and leaves the shape clean.
        this.dragVertex = { poly, i: i + 1, point: [+mx.toFixed(5), +my.toFixed(5)],
          pending: true, exclude: excludeId, dirty: dirtyFn, closed };
        this.svg.setPointerCapture(e.pointerId);   // capture on the stable <svg>, not the layer <g>
      });
      s.append(m);
    }
    poly.forEach((p, i) => {
      const v = Dom.svg('circle', { cx: p[0] * W, cy: p[1] * H, r: 5, class: 'vertex' });
      v.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        this.dragVertex = { poly, i, exclude: excludeId, dirty: dirtyFn, closed };
        this.svg.setPointerCapture(e.pointerId);
      });
      v.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (poly.length <= minPts) { Toast.show('Needs at least ' + minPts + ' points'); return; }
        this.snapshot();   // no-op for editors that don't opt into undo
        poly.splice(i, 1); dirtyFn(); this.render();
      });
      s.append(v);
    });
  }
  /** Indicator for an in-progress right-angle snap: draw each locked edge as an
   *  accent guide to its neighbour, and a small square corner glyph at the `node`
   *  (normalized) when both axes lock (a true 90° corner). `ortho` is
   *  `Editor.orthoSnap`'s `engaged`. Used for a dragged vertex and the draft cursor. */
  _drawOrthoGuide(s, node, ortho, W, H) {
    const x = node[0] * W, y = node[1] * H;
    const guide = (nb) => s.append(Dom.svg('line',
      { x1: x, y1: y, x2: nb[0] * W, y2: nb[1] * H, class: 'ortho-guide' }));
    if (ortho.x) guide(ortho.x);
    if (ortho.y) guide(ortho.y);
    if (ortho.x && ortho.y) {
      const d = 11 / this.viewport.scale;
      const sx = ortho.y[0] * W >= x ? 1 : -1;   // toward the horizontal-edge neighbour
      const sy = ortho.x[1] * H >= y ? 1 : -1;   // toward the vertical-edge neighbour
      s.append(Dom.svg('path', { class: 'ortho-corner', fill: 'none',
        d: `M ${x + sx * d} ${y} L ${x + sx * d} ${y + sy * d} L ${x} ${y + sy * d}` }));
    }
  }

  drawDraft(s, W, H) {
    // Rectangle tool: preview the axis-aligned box being dragged out (same dashed
    // `.draft` styling as a polygon draft).
    if (this.rectDraft) {
      const { a, b } = this.rectDraft;
      const x = Math.min(a[0], b[0]) * W, y = Math.min(a[1], b[1]) * H;
      const w = Math.abs(a[0] - b[0]) * W, h = Math.abs(a[1] - b[1]) * H;
      s.append(Dom.svg('rect', { x, y, width: w, height: h, class: 'draft' }));
      return;
    }
    if (!this.draft || !this.draft.points.length) return;
    const dp = this.draft.points, cur = this.draft.cursor;
    const arrow = this.draft.kind === 'arrow';
    const chain = cur ? dp.concat([cur.pt]) : dp;
    // An arrow draft is an open route — no area fill (the `.draft` class fills the
    // implied closed shape for polygons, which would shade the arrow like a room).
    s.append(Dom.svg('polyline', { points: chain.map(p => `${p[0] * W},${p[1] * H}`).join(' '),
      class: 'draft' + (arrow ? ' open' : ''), fill: 'none' }));
    // An arrow draft previews its head at the leading end so the direction is clear;
    // its first point gets no 'first' emphasis (there is nothing to close onto).
    if (arrow && chain.length >= 2) {
      const a = chain[chain.length - 2], b = chain[chain.length - 1];
      const tri = Geom.arrowHead(a[0] * W, a[1] * H, b[0] * W, b[1] * H, ARROW_HEAD_PX);
      s.append(Dom.svg('polygon', { points: tri.map(p => p.join(',')).join(' '), class: 'draft-head' }));
    }
    dp.forEach((p, i) => {
      const v = Dom.svg('circle', { cx: p[0] * W, cy: p[1] * H, r: 5, class: 'vertex' + (!arrow && i === 0 ? ' first' : '') });
      // Right-click removes this node mid-draft (like drawVertices for committed shapes).
      // No minPts floor: the draft isn't closed yet, so dropping below 3/2 is fine.
      // stopPropagation keeps the press from also reaching the background click/pan handlers.
      v.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        this.draft.points.splice(i, 1); this.draft.cursor = null; this.render();
      });
      s.append(v);
    });
    if (cur && cur.ortho) this._drawOrthoGuide(s, cur.pt, cur.ortho, W, H);
    if (cur) s.append(Dom.svg('circle', { cx: cur.pt[0] * W, cy: cur.pt[1] * H, r: cur.kind === 'vertex' ? 7 : 5, class: 'snap-cursor' + (cur.kind ? ' k-' + cur.kind : '') }));
  }

  // ---- label editing (shared by both editors) ----
  // A shape (siteplan hotspot / floor room) carries an optional `labelStyle`
  // `{x,y,rot,size,font,color}`; absent fields fall back to the auto-placed label.
  // While `editingLabel === shape.id` the label is draggable and grows rotate +
  // resize handles. Geometry mirrors FloorEditor._placementHandles.

  /** Lazily create the shape's labelStyle so a control/handle can write to it. */
  _labelStyle(shape) { return shape.labelStyle || (shape.labelStyle = {}); }

  // Identity + dirty hooks so the label engine serves more than one shape kind.
  // Base = a shape keyed by `id`, dirtying the room/hotspot store. FloorEditor
  // overrides these for placements (keyed by `uid`, dirtying the placement store).
  _labelKey(shape) { return shape.id; }
  _labelDirty(shape) { this.markDirty(); }

  /** Set centered, vertically-balanced lines on a label `<text>` (origin x:0). One
   *  line is plain text; several become tspans so a user can hand-break the label. */
  _setLabelLines(t, lines) {
    t.textContent = '';
    if (lines.length <= 1) { t.textContent = lines[0] || ''; return; }
    const lh = 1.2;   // em line-height (matches the old 2-line layout: -0.6 / +1.2)
    lines.forEach((ln, i) => {
      const span = Dom.svg('tspan', { x: 0,
        dy: i === 0 ? (-(lines.length - 1) / 2 * lh).toFixed(3) + 'em' : lh + 'em' });
      span.textContent = ln === '' ? ' ' : ln;   // keep a blank line from collapsing
      t.append(span);
    });
  }

  /** Wrap a centered `<text>` (content + font-size already set) in a
   *  `translate(cx,cy) rotate(rot)` group, apply the labelStyle font/colour, and —
   *  when this shape's label is being edited — make it draggable and add handles.
   *  `cx,cy` are the label-centre in normalized coords; `sizePx` is the text's
   *  current font-size (used to map a resize drag back to a font-size). */
  attachLabel(s, shape, textEl, cx, cy, sizePx, W, H) {
    const ls = shape.labelStyle || {};
    if (ls.font) textEl.style.fontFamily = ls.font;
    if (ls.color) textEl.style.fill = ls.color;
    const g = Dom.svg('g', { class: 'label-grp',
      transform: `translate(${cx * W},${cy * H}) rotate(${ls.rot || 0})` });
    g.append(textEl);
    s.append(g);
    if (this.editingLabel !== this._labelKey(shape)) return g;

    // Drag the label to move it (snaps to the grid; Alt frees it). Keep the grab
    // offset so it doesn't jump its centre under the cursor.
    textEl.style.pointerEvents = 'auto';
    textEl.style.cursor = 'move';
    textEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const [sx, sy] = this.evtNorm(e), offx = cx - sx, offy = cy - sy;
      this.dragItem = { move: (nx, ny, ev) => {
        let x = nx + offx, y = ny + offy;
        if (this.grid.on && !(ev && ev.altKey)) {
          const [iw, ih] = this.dims;
          x = this.grid.snap(x * iw, this.grid.ox) / iw;
          y = this.grid.snap(y * ih, this.grid.oy) / ih;
        }
        const st = this._labelStyle(shape);
        st.x = +Math.max(0, Math.min(1, x)).toFixed(5);
        st.y = +Math.max(0, Math.min(1, y)).toFixed(5);
        this._labelDirty(shape); this.renderActive();
      } };
      this.svg.setPointerCapture(e.pointerId);
    });

    const bb = textEl.getBBox();
    this._drawLabelHandles(s, shape, g, cx, cy, bb.width / 2, bb.height / 2, sizePx, W, H);
    return g;
  }

  /** Rotate handle (above the text) + resize handle (bottom-right corner) for the
   *  label being edited. Rotation snaps to ANGLE_STEP°, resize maps the un-rotated
   *  vertical extent back to a font-size; Alt frees the rotation snap. Both ride the
   *  shared `dragItem` channel. */
  _drawLabelHandles(s, shape, g, cx, cy, halfW, halfH, sizePx, W, H) {
    const ry = -halfH - 16;
    g.append(Dom.svg('line', { x1: 0, y1: -halfH, x2: 0, y2: ry, class: 'label-stem' }));
    const rot = Dom.svg('circle', { cx: 0, cy: ry, r: 5, class: 'label-handle' });
    rot.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      this.dragItem = { move: (nx, ny, ev) => {
        const dx = (nx - cx) * W, dy = (ny - cy) * H;
        let deg = Math.atan2(dy, dx) * 180 / Math.PI + 90;
        if (!(ev && ev.altKey)) deg = Math.round(deg / ANGLE_STEP) * ANGLE_STEP;
        this._labelStyle(shape).rot = ((Math.round(deg) % 360) + 360) % 360;
        this._labelDirty(shape); this.renderActive();
      } };
      this.svg.setPointerCapture(e.pointerId);
    });
    g.append(rot);

    const size = Dom.svg('rect', { x: halfW + 2, y: halfH + 2, width: 9, height: 9, class: 'label-handle' });
    size.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const rad = (shape.labelStyle && shape.labelStyle.rot || 0) * Math.PI / 180;
      const cs = Math.cos(rad), si = Math.sin(rad);
      this.dragItem = { move: (nx, ny) => {
        const ex = (nx - cx) * W, ey = (ny - cy) * H;
        const ly = -ex * si + ey * cs;                  // un-rotate into the label frame
        const next = halfH ? Math.abs(ly) / halfH * sizePx : sizePx;
        this._labelStyle(shape).size = +Math.max(LABEL_SIZE_MIN, Math.min(LABEL_SIZE_MAX, next)).toFixed(1);
        this._labelDirty(shape); this.renderActive();
      } };
      this.svg.setPointerCapture(e.pointerId);
    });
    g.append(size);
  }

  /** Open the side panel with controls for the shape's label (display text / font /
   *  size / rotation / colour / reset). Editing the text is **purely visual** — it
   *  overrides only how the label is drawn (spacing, hand-inserted line breaks), never
   *  the shape's bound name. `defaultText` is the auto label to fall back to; `onDone`
   *  returns to the shape's normal panel. `opts` adapts the panel for a free-standing
   *  text note (whose text *is* its content, with no auto label to fall back to):
   *  `keepText` makes "Reset to auto" reset styling only and keep the text; `onDelete`
   *  adds an explicit delete button. */
  openLabelPanel(shape, onDone, defaultText = '', opts = {}) {
    const panel = Dom.$('#panel'); panel.classList.remove('hidden');
    Dom.$('#panel-title').textContent = 'Edit label';
    const body = Dom.$('#panel-body'); body.innerHTML = '';

    body.append(Dom.el('div', { class: 'hint' },
      'Drag to move (snaps to grid) · top handle rotates (' + ANGLE_STEP
      + '°) · corner resizes · Alt bypasses snapping.'));

    const field = (label, ctl) => Dom.el('div', { class: 'field' }, [Dom.el('label', {}, label), ctl]);

    // Display text only — line breaks control wrapping; the bound name is unchanged.
    const textArea = Dom.el('textarea', { class: 'label-ctl text', rows: 2, placeholder: defaultText });
    textArea.value = (shape.labelStyle && shape.labelStyle.text != null) ? shape.labelStyle.text : defaultText;
    textArea.oninput = () => {
      const v = textArea.value, st = this._labelStyle(shape);
      if (v.trim() === '' || v === defaultText) delete st.text;   // revert to the auto label
      else st.text = v;
      this._labelDirty(shape); this.render();
    };
    body.append(field('Label text (display only; Enter adds a line break)', textArea));

    const fontSel = Dom.el('select', { class: 'label-ctl' });
    LABEL_FONTS.forEach(f => {
      const o = Dom.el('option', { value: f.css }, f.name);
      if (shape.labelStyle && shape.labelStyle.font === f.css) o.selected = true;
      fontSel.append(o);
    });
    fontSel.onchange = () => { this._labelStyle(shape).font = fontSel.value; this._labelDirty(shape); this.render(); };
    body.append(field('Font', fontSel));

    const sizeInp = Dom.el('input', { type: 'number', min: LABEL_SIZE_MIN, max: LABEL_SIZE_MAX, step: 1, class: 'label-ctl', placeholder: 'auto' });
    if (shape.labelStyle && shape.labelStyle.size != null) sizeInp.value = Math.round(shape.labelStyle.size);
    sizeInp.oninput = () => { const v = +sizeInp.value; if (v) { this._labelStyle(shape).size = v; this._labelDirty(shape); this.render(); } };
    body.append(field('Size (px)', sizeInp));

    const rotInp = Dom.el('input', { type: 'number', step: ANGLE_STEP, class: 'label-ctl' });
    rotInp.value = (shape.labelStyle && shape.labelStyle.rot) || 0;
    rotInp.oninput = () => { this._labelStyle(shape).rot = ((+rotInp.value % 360) + 360) % 360; this._labelDirty(shape); this.render(); };
    body.append(field('Rotation (°)', rotInp));

    const colInp = Dom.el('input', { type: 'color', class: 'label-ctl color' });
    colInp.value = (shape.labelStyle && shape.labelStyle.color) || '#ffffff';
    colInp.oninput = () => { this._labelStyle(shape).color = colInp.value; this._labelDirty(shape); this.render(); };
    body.append(field('Color', colInp));

    body.append(Dom.el('button', { class: 'wide', onclick: () => {
      // A note's text is its only content, so keep it and reset just the styling;
      // every other shape falls back to its auto label, so clear the whole override.
      const keep = opts.keepText && shape.labelStyle && shape.labelStyle.text;
      delete shape.labelStyle;
      if (keep) this._labelStyle(shape).text = keep;
      this._labelDirty(shape); this.render(); onDone();
    } }, 'Reset to auto'));
    if (opts.onDelete)
      body.append(Dom.el('button', { class: 'wide danger', onclick: opts.onDelete }, 'Delete note'));
    body.append(Dom.el('button', { class: 'wide primary', onclick: onDone }, 'Done'));
  }

  /** Floating zoom controls (+ / − / fit) for the map viewport corner. */
  _zoomControls() {
    const btn = (label, title, fn) => Dom.el('button', { title, type: 'button',
      onclick: () => fn() }, label);
    return Dom.el('div', { class: 'zoom-ctl' }, [
      btn('+', 'Zoom in', () => this.viewport.zoomBy(1.3)),
      btn('−', 'Zoom out', () => this.viewport.zoomBy(1 / 1.3)),
      btn('⤢', 'Reset to fit', () => this.viewport.fit()),
    ]);
  }

  // ---- shared toolbar buttons ----
  /** A vertical divider that groups related toolbar controls. */
  toolDivider() { return Dom.el('span', { class: 'tb-div' }); }

  /** innerHTML for a saved/unsaved status badge (green check when saved). */
  badgeHtml(dirty) { return dirty ? '<span>● unsaved</span>' : Icons.check + '<span>saved</span>'; }

  undoButton() {
    // Contextual, matching Ctrl+Z: mid-draw it removes the last draft point; otherwise
    // it undoes the last committed mutation.
    return Dom.el('button', { class: 'icononly', title: 'Undo (Ctrl+Z)',
      onclick: () => { this.draft ? this.undoNode() : this.undo(); }, html: Icons.undo + '<span>Undo</span>' });
  }
  snapButton() {
    const b = Dom.el('button', { class: 'icononly' + (this.snapOn ? ' active' : ''), title: 'Snap to nearby vertices/edges', html: Icons.snap + '<span>Snap</span>' });
    b.onclick = () => { this.snapOn = !this.snapOn; b.classList.toggle('active', this.snapOn); };
    return b;
  }
  orthoButton() {
    const b = Dom.el('button', { class: 'icononly' + (this.orthoOn ? ' active' : ''), title: 'Right-angle snap: align a dragged node to its neighbours (90° corners)', html: Icons.rightangle + '<span>Right angle</span>' });
    b.onclick = () => {
      this.orthoOn = !this.orthoOn;
      b.classList.toggle('active', this.orthoOn);
      try { localStorage.setItem(ORTHO_KEY, this.orthoOn ? '1' : '0'); }
      catch (e) { console.warn('ortho: could not persist toggle', e); }
    };
    return b;
  }
  /** The persisted right-angle-snap toggle; defaults to on when unset. */
  _loadOrtho() {
    try { const v = localStorage.getItem(ORTHO_KEY); return v === null ? true : v === '1'; }
    catch (e) { return true; }
  }
  gridToggleButton() {
    const b = Dom.el('button', { class: 'icononly' + (this.grid.on ? ' active' : ''), title: 'Toggle the alignment grid', html: Icons.grid + '<span>Grid</span>' });
    b.onclick = () => { this.grid.on = !this.grid.on; b.classList.toggle('active', this.grid.on); this.render(); };
    return b;
  }
  gridSizeSelect() {
    const sel = Dom.el('select', { title: 'Grid size (image px)' });
    [4, 8, 12, 25, 50].forEach((v) => {
      const o = Dom.el('option', { value: v }, v + ' px');
      if (v === this.grid.step) o.selected = true;
      sel.append(o);
    });
    sel.onchange = () => { this.grid.step = +sel.value; this.render(); };
    return sel;
  }
  gridMoveButton() {
    const b = Dom.el('button', { class: 'icononly' + (this.grid.adjust ? ' active' : ''), title: 'Drag to move the grid · scroll to resize', html: Icons.move + '<span>Move grid</span>' });
    b.onclick = () => { this.grid.adjust = !this.grid.adjust; b.classList.toggle('active', this.grid.adjust); if (this.grid.adjust) Toast.show('Drag to move the grid · scroll to resize'); };
    return b;
  }

  // ---- shared edit-menu toolbar (both editors) ----
  /** The edit-menu toolbar shared by both editors. The base assembles the common bones —
   *  the mode-toggle button, the undo + right-angle/grid factory row (edit mode), and the
   *  Save button + dirty badge — and each subclass supplies only its mode-specific buttons
   *  through the hooks below. Rebuilt on every mode/sub-mode change (App.setToolbar). */
  _toolbar() {
    const tb = [];
    if (this.editing()) {
      const draw = this._editButtons();
      if (draw.length) tb.push(...draw, this.toolDivider());
      tb.push(this.undoButton(), this.toolDivider(), ...this._alignTools());
      const extra = this._editExtras();
      if (extra.length) tb.push(this.toolDivider(), ...extra);
    } else {
      tb.push(...this._viewButtons());
    }
    if (this._showsSave()) tb.push(this.toolDivider(), this._saveButton(), this._badgeEl());
    // The mode toggle is always the LAST element so its right edge stays anchored against
    // the toolbar's right edge (the facility picker): entering edit mode prepends buttons to
    // its left instead of shoving it around, so Done lands on the exact spot Edit occupied
    // (NAV-1). A leading divider only when something precedes it.
    if (tb.length) tb.push(this.toolDivider());
    tb.push(this._modeButton());
    return tb;
  }

  // Toolbar hooks — a subclass overrides only what it needs. `_editButtons` are the
  // mode-specific draw/add tools (undo is appended by the base); `_alignTools` is the
  // right-angle/grid factory row (FloorEditor prepends its Snap toggle); `_editExtras`
  // are the trailing edit-only tools (copy/racks/arrange/overlay); `_viewButtons` are the
  // view-mode tools; `_showsSave` gates the Save+badge cluster (SiteplanEditor hides it in
  // view — its home screen stays uncluttered).
  _editButtons() { return []; }
  _alignTools() { return [this.orthoButton(), this.gridToggleButton(), this.gridSizeSelect(), this.gridMoveButton()]; }
  _editExtras() { return []; }
  _viewButtons() { return []; }
  _showsSave() { return true; }
  _saveLabel() { return 'Save'; }

  /** The mode-toggle button: an edit ⇄ done switch shared by both editors. `Icons.edit`
   *  + label (`Edit` while viewing, `Done` while editing), `.active` in edit mode; routes
   *  through `_switchMode`. */
  _modeButton() {
    const editing = this.editing();
    const b = Dom.el('button', { class: 'mode' + (editing ? ' active' : ''),
      html: Icons.edit + '<span>' + (editing ? 'Done' : 'Edit') + '</span>' });
    b.onclick = () => this._switchMode(editing ? 'view' : 'edit');
    return b;
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
    this.app.setToolbar(this._toolbar());   // rebuild: the badge/_dirty() meaning is per-mode
    this.render();
  }
  _setEditing(on) {}                 // subclass writes its editing flag (app.mode / app.siteEdit)
  _onModeSwitch(mode) {}             // subclass extra resets / side-effects on a mode change

  // ---- shared Save button + dirty badge ----
  /** Whether this editor has unsaved work (drives the badge). Base default false; a
   *  subclass that persists overrides it (e.g. the siteplan dirty flag, or the floor's
   *  three-category union). */
  _dirty() { return false; }
  /** Persist this editor's work, then clear undo history (undoing across a save would
   *  restore stale dirty flags against now-saved data), refresh the badge, and toast.
   *  The whole scaffold — the try/catch and the shared failure toast — lives here so the
   *  two editors can't drift; a subclass supplies only the store writes (`_persist`) and,
   *  if different, the success message (`_savedMessage`). Clearing an empty history (the
   *  siteplan opts out of undo) is a harmless no-op. */
  async save() {
    try {
      await this._persist();
      this.history.clear();
      this._setBadge();
      Toast.show(this._savedMessage());
    } catch (e) { Toast.show('Save failed: ' + e.message, true); }
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
   *  limit? }`. Appends the input + list into `body`, auto-focuses, and returns
   *  `{ search, list, renderList }` so a caller can splice extra hints around them. */
  _bindList(body, opts) {
    const search = Dom.el('input', { id: 'room-search', placeholder: opts.placeholder });
    body.append(search);
    const list = Dom.el('div', {}); body.append(list);
    const renderList = (q) => {
      list.innerHTML = '';
      const ql = q.toLowerCase();
      let matches = opts.items.filter((it) => opts.filter(it, ql));
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
    };
    search.addEventListener('input', () => renderList(search.value));
    renderList(''); search.focus();
    return { search, list, renderList };
  }
}
