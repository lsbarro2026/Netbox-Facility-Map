'use strict';
/* import-region-editor.js — ImportRegionEditor: the region-split editor's drawing engine
   (FLOOR-6). A minimal Editor subclass hosted inside the import wizard, so the "Split this
   drawing into floors…" screen draws and edits its floor regions through the SAME code the
   map editors use — Editor's draft/rectangle lifecycle and snapping, EditorShapes' draft
   preview and editable vertices, EditorPointer's gesture cascade and drag channels, PanZoom —
   rather than a bespoke box-drag reimplementation.

   A "shape" here is one entry of `b.regions[p.stem]` (the wizard draft model, FLOOR-4):
   `{ id, poly, box, assign }`. `poly` is the user-drawn polygon, normalized 0..1 over the
   STRAIGHTENED drawing (openSplit's space — the build crops after rotating); `box` is kept as
   `poly`'s bounding box on every edit, because the build's crop contract is a rectangle
   (`_resolveFloors` emits `{token, region:{x,y,w,h}}` and the backend crop is FLOOR-2/3, out
   of scope here) — so a non-rectangular region crops its bounding box, which the screen says.
   Old drafts carry only `box`; `materialize` backfills `poly` (and `id`) from it, so they
   round-trip unchanged until re-edited.

   Persistence is the wizard's draft autosave, not the Store: `markDirty()` re-derives every
   region's `box` and schedules a debounced `wizard._saveDraft()` (markDirty fires per drag
   frame; a POST per frame would hammer the server — `flushSave` on leaving the screen closes
   the window). Undo is the base engine's, opted into via `_snapshotState`/`_applySnapshot`
   over the region array — gesture snapshots (vertex/edge/whole-shape drags) come free from
   EditorPointer. There is no side panel: `refreshList` (the openSplit screen's region list
   rebuild) is this editor's `_openShapePanel`. */

class ImportRegionEditor extends Editor {
  /** Debounce for the draft autosave: long enough to coalesce a drag's frames, short enough
   *  that an edit is on the server before the operator could plausibly navigate away. */
  static SAVE_DEBOUNCE_MS = 600;

  constructor(app, wizard, building, p, refreshList) {
    super(app);
    this.w = wizard;
    this.b = building;
    this.p = p;
    this.refreshList = refreshList;   // rebuild the screen's per-region assignment list
    // The wizard has no snapping grid (a drawing's grid scope belongs to its built floor, and
    // the import context has none) — a fresh, off GridController keeps every `grid.on` check in
    // the shared engine false without touching the app-wide grid the map editors share.
    // Vertex/edge snapping between sibling regions still works via `polys()`/`snapPoint`.
    this.grid = new GridController();
    this.grid.on = false;
    this._saveTimer = null;
  }

  /** The live region array. Read through the draft model each time — `_applySnapshot`
   *  replaces the array wholesale, and the wizard's own paths (Unsplit) may too. */
  regions() { return this.b.regions[this.p.stem]; }

  // ---- draft-model normalization (pure helpers, unit-tested) ----
  /** Whether `poly` is a usable polygon off the (user-writable) draft JSON: an array of at
   *  least 3 `[x, y]` pairs, every coordinate a finite number in 0..1. */
  static validPoly(poly) {
    return Array.isArray(poly) && poly.length >= 3 && poly.every(pt =>
      Array.isArray(pt) && pt.length === 2 && pt.every(c =>
        typeof c === 'number' && isFinite(c) && c >= 0 && c <= 1));
  }

  /** A normalized `{x,y,w,h}` box as its 4-corner polygon (clockwise from the top-left),
   *  clamped into 0..1 and rounded to the 5 places every stored coordinate carries — the shape
   *  a pre-FLOOR-6 draft's box-only region materializes as. */
  static polyFromBox(box) {
    const cl = (v) => +Math.max(0, Math.min(1, +v || 0)).toFixed(5);
    const x0 = cl(box.x), y0 = cl(box.y);
    const x1 = cl(box.x + box.w), y1 = cl(box.y + box.h);
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  }

  /** A polygon's bounding box as the normalized `{x,y,w,h}` the build's crop contract wants. */
  static boxFromPoly(poly) {
    const b = Geom.bounds(poly);
    return { x: +b.minX.toFixed(5), y: +b.minY.toFixed(5),
      w: +(b.maxX - b.minX).toFixed(5), h: +(b.maxY - b.minY).toFixed(5) };
  }

  /** Bring a draft's region entries up to this editor's shape: every region gets a stable
   *  `id` (selection/snapping identity, persisted like a room's) and a valid `poly` — kept as
   *  stored when usable, else rebuilt from `box` (a box-only pre-FLOOR-6 draft, or a corrupt
   *  hand-edited one). `box` is then re-derived so the pair can never disagree. In place, so
   *  the draft model stays the single source of truth. */
  static materialize(regions) {
    for (const r of regions) {
      if (!r.id) r.id = Util.uid();
      if (!ImportRegionEditor.validPoly(r.poly)) r.poly = ImportRegionEditor.polyFromBox(r.box || {});
      r.box = ImportRegionEditor.boxFromPoly(r.poly);
    }
    return regions;
  }

  // ---- Editor hooks ----
  editing() { return true; }          // the screen exists only to edit — no view mode
  gridActive() { return false; }      // no grid UI/snap in the wizard (see constructor)
  polys() { return this.regions().map(r => ({ id: r.id, polygon: r.poly })); }

  /** Every geometry edit lands here (drag frames included): keep each region's crop `box` in
   *  lockstep with its polygon, and autosave the draft — debounced, so a drag saves once. */
  markDirty() {
    for (const r of this.regions()) r.box = ImportRegionEditor.boxFromPoly(r.poly);
    this._scheduleSave();
  }

  deselect() {
    if (this.selected == null) return;
    this.selected = null;
    this.render();
    this.refreshList();
  }

  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.w._saveDraft(); },
      ImportRegionEditor.SAVE_DEBOUNCE_MS);
  }

  /** Push any pending debounced save out now — the leave funnel awaits this so no edit is
   *  still sitting in the debounce window when the screen is torn down. */
  flushSave() {
    if (this._saveTimer === null) return Promise.resolve();
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    return this.w._saveDraft();
  }

  // ---- the shape seam ----
  _newShape(poly) {
    const r = { id: Util.uid(), poly, box: ImportRegionEditor.boxFromPoly(poly),
      assign: { type: 'unassigned', num: 1, token: null, label: '' } };
    this.regions().push(r);
    return r;
  }
  /** No side panel in the wizard — "the shape's panel" is its row in the assignment list. */
  _openShapePanel(r) { this.refreshList(); }
  _shapePoly(r) { return r.poly; }
  _shapeTerms() { return { noun: 'floor region', drawLabel: 'Add floor region' }; }

  // ---- undo (the base engine, over the draft model) ----
  /** Everything an edit here can change: the whole region array (geometry AND floor
   *  assignments, so Ctrl+Z covers an assignment pick too). Plain JSON, cloned via `_clone`.
   *  Non-null, so vertex/edge/whole-shape drags get their pre-drag gesture snapshot free. */
  _snapshotState() { return this._clone({ regions: this.regions() }); }

  /** Write a snapshot back and re-sync everything derived from it: the assignment list
   *  rebuilds, and the restored state autosaves like any other edit (a restore is a mutation
   *  running backwards). The shared restore tail (transient state, badge no-op, panel close)
   *  is the base's. */
  _applySnapshot(snap) {
    this.b.regions[this.p.stem] = snap.regions;
    this._scheduleSave();
    this.refreshList();
  }

  // ---- rendering ----
  /** Static layer: the catcher, then every non-selected region as a numbered polygon. The
   *  selected region renders in the active layer so drag frames don't rebuild this one. */
  _renderStatic(s, W, H) {
    this.shapes.addCatcher(s, W, H);
    this.regions().forEach((r, i) => {
      if (r.id === this.selected) return;
      this._drawRegion(s, r, i, W, H);
    });
  }

  /** Active layer: the selected region (with its editable vertices — the shared vertex-drag /
   *  midpoint-insert / right-click-remove engine) and the in-progress draft/rectangle. */
  _renderActive(s, W, H) {
    const idx = this.regions().findIndex(r => r.id === this.selected);
    if (idx >= 0) {
      const r = this.regions()[idx];
      this._drawRegion(s, r, idx, W, H);
      this.shapes.drawVertices(s, r.poly, W, H, r.id, () => this.markDirty());
    }
    this.shapes.drawDraft(s, W, H);
  }

  /** One region polygon + its 1-based number at the polygon's bbox centre. Selection and the
   *  CAD-style body drags mirror the floor editor's room wiring: click selects; on the
   *  selected region, hover differentiates the cursor (resize over a side, move deeper in)
   *  and a press within the edge grab band drags that wall while a deeper press translates
   *  the whole region — both via the shared base starters, so the drag threshold, grid-off
   *  behaviour, and undo-on-drop are identical to a room's. */
  _drawRegion(s, r, i, W, H) {
    const selected = r.id === this.selected;
    const el = Dom.svg('polygon', {
      points: r.poly.map(p => `${p[0] * W},${p[1] * H}`).join(' '),
      class: 'imp-region-shape' + (selected ? ' selected' : ''),
    });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      // stopPropagation hides this click from the svg-level guard, so consult the shared
      // flag here — the tail of a pan/drag gesture must not also select (MOBILE-2).
      if (this.pointer.gestureClick()) return;
      if (this.draft || this.rectMode) return;
      if (this.selected === r.id) return;
      this.selected = r.id;
      this.render();
      this._openShapePanel(r);
    });
    if (selected) {
      el.style.cursor = 'move';
      el.addEventListener('pointermove', (e) => {
        const hit = this.pointer.edgeHit(e, r.poly);
        el.style.cursor = hit >= 0 ? this.pointer.edgeCursor(r.poly, hit) : 'move';
      });
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || this.draft) return;
        const hit = this.pointer.edgeHit(e, r.poly);
        if (hit >= 0) this._startEdgeDrag(e, r.poly, hit, () => this.markDirty());
        else this._startShapeDrag(e, r.poly, () => this.markDirty());
      });
    }
    s.append(el);
    const b = Geom.bounds(r.poly);
    const num = Dom.svg('text', { x: b.cx * W, y: b.cy * H, 'text-anchor': 'middle',
      'dominant-baseline': 'central', class: 'imp-region-shape-num' });
    num.textContent = String(i + 1);
    s.append(num);
  }
}
