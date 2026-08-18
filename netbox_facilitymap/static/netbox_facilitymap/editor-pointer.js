'use strict';
/* editor-pointer.js — EditorPointer: the Editor base's pointer/gesture/keyboard input, extracted
   as a collaborator holding an editor back-ref (`this.ed`), the FloorArrange shape (QUAL-4).
   `bind()` wires the whole pointer cascade onto the editor's <svg> (click-to-draw, pan, the
   drag channels, grid move, rectangle drag, touch pinch-zoom), and `handleKey` is the shared
   engine's keyboard dispatch (each editor's own `handleKey` falls through to it via `super`).

   The shared drag channels (`pan`/`dragVertex`/`dragItem`/`dragEdge`/`dragSheet`/`gridDrag`/
   `rectDraft`) and the draft stay on the editor — subclasses and the floor collaborators open
   them through `this.ed` — while the gesture-private state (the touch registry, the pinch, the
   drag-threshold origin, the click guard, the pre-drag undo snapshot) is private here. */

// Draft kinds that are a single point rather than a run of them: the first click both places
// and finishes them (see the click handler in bind()). A subclass opts a tool in by
// drafting one of these kinds — FloorEditor's text note and access-point tools do.
const SINGLE_POINT_KINDS = new Set(['note', 'device']);

// A vertex/marker/pan press only becomes a drag once the pointer travels this far (screen px);
// below it the press is a select/inspect click and must not move geometry or the viewport.
const DRAG_THRESHOLD_PX = 4;
// Zoom step for a discrete +/- action (keyboard shortcuts and EditorToolbar's zoom buttons —
// one constant so the two input paths stay in lockstep).
const ZOOM_STEP = 1.3;
// Zoom step for one wheel tick — finer-grained than the discrete step above.
const ZOOM_STEP_WHEEL = 1.15;

class EditorPointer {
  constructor(editor) {
    this.ed = editor;
    this._pointers = new Map();    // active TOUCH pointerId -> { x, y }, tracked for multi-touch pinch-zoom
    this._pinch = null;            // { dist, mx, my } while two fingers pinch-zoom the viewport (view-mode touch)
    this._dragDown = null;         // { x, y, moved } press origin for the vertex/item drag threshold
    this._suppressClick = false;   // swallow the click that ends a left-button pan drag
    this._gestureSnap = null;      // pre-drag snapshot, committed to history only if the drag mutates
    this._forcePan = false;        // Space held: the hand tool, forcing every left press into a pan
  }

  /** Wire pointer interactions onto the editor's svg. Called once per mount (Editor.attach). */
  bind() {
    const ed = this.ed, s = ed.svg;
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
      // Disarm the click guard at the start of a clean single-pointer gesture (MOBILE-2). The
      // flag is normally consumed by the trailing click a mouse gesture always produces, but a
      // touch gesture (pan, pinch) frequently ends with NO click at all — leaving it armed to
      // swallow the next legitimate tap. Safe to clear here because the order is fixed:
      // pointerup -> click -> the next pointerdown, so a click that is owed the flag has already
      // consumed it. Not cleared while a second finger lands, which is the pinch we are arming.
      if (this._pointers.size < 2) this._suppressClick = false;
      this._dragDown = { x: e.clientX, y: e.clientY, moved: false };
      this._gestureSnap = ed._snapshotState();
      // The Space-held hand tool takes the press outright: while it is on, a left press pans
      // whatever it landed on. This lives in the CAPTURE listener precisely so it can stop the
      // event ahead of every shape's own pointerdown (vertex, midpoint, marker, selected-room
      // body, sheet tile) — one touchpoint instead of a `_forcePan` check re-derived on each of
      // them. It must be stopIMMEDIATEPropagation, not stopPropagation: a press on the empty
      // background targets the svg itself, where the plain-arm listener below is a same-node
      // listener that would otherwise still run and re-arm the pan without `forced`.
      // preventDefault suppresses the text/image drag a press over a shape would start.
      if (this._forcePan && e.button === 0) {
        e.preventDefault(); e.stopImmediatePropagation();
        this._armPan(e, true).forced = true;
      }
    }, true);
    s.addEventListener('click', (e) => {
      if (this.gestureClick()) return;
      if (!ed.editing() || ed.grid.adjust) return;
      if (ed.draft) {
        const snapped = ed._placePoint(...ed.evtNorm(e), ed._draftNeighbours()).pt;
        const dp = ed.draft.points;
        // A single-point shape (a text note, an access point): the first click places it
        // and finishes — there is no second point to wait for.
        if (SINGLE_POINT_KINDS.has(ed.draft.kind)) { dp.push(snapped); return ed.finish(); }
        // Polygons close when you click near the first point; an open arrow never does.
        if (ed.draft.kind !== 'arrow' && dp.length >= 3) {
          const [W, H] = ed.dispSize();
          const d = Math.hypot((snapped[0] - dp[0][0]) * W, (snapped[1] - dp[0][1]) * H);
          if (d < CLOSE_PX / ed.viewport.scale) return ed.finish();
        }
        dp.push(snapped); ed.draft.cursor = null; ed.render();
      } else { ed.deselect(); }
    });
    s.addEventListener('dblclick', (e) => { e.preventDefault(); if (ed.draft) ed.finish(); });
    s.addEventListener('pointerdown', (e) => {
      if (ed.grid.adjust && ed.gridActive()) {
        ed.gridDrag = { x: e.clientX, y: e.clientY, ox: ed.grid.ox, oy: ed.grid.oy };
        s.setPointerCapture(e.pointerId); return;
      }
      // The map background is the svg itself or the transparent catcher; anything else the
      // press can land on is a shape (a room/hotspot fill, a vertex, a marker).
      const onBackground = e.target === s || e.target.classList.contains('catcher');
      const intent = EditorPointer.pressIntent({ button: e.button, onBackground,
        rectMode: ed.rectMode, editing: ed.editing(), gridAdjust: ed.grid.adjust });
      // Rectangle tool: a left-button press begins a box drag wherever it lands, on
      // background or on top of a shape (takes the gesture that would otherwise pan).
      if (intent === 'rect') {
        const start = ed.snapPoint(...ed.evtNorm(e)).pt;
        ed.rectDraft = { a: start, b: start };
        s.setPointerCapture(e.pointerId);
        return;
      }
      if (intent) this._armPan(e, intent === 'pan');
    });
    s.addEventListener('pointermove', (e) => {
      if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pinch) { this._updatePinch(); return; }
      if (ed.pan) {
        const dx = e.clientX - ed.pan.x, dy = e.clientY - ed.pan.y;
        if (!ed.pan.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        // The press has just become a real pan, so a shape-origin pan takes its deferred
        // pointer capture now (see `_armPan`): from here the drag must keep tracking after the
        // pointer leaves the shape it started on — or the svg entirely.
        if (ed.pan.grab != null) { s.setPointerCapture(ed.pan.grab); ed.pan.grab = null; }
        ed.pan.moved = true; ed.pan.x = e.clientX; ed.pan.y = e.clientY;
        s.classList.add('panning'); ed.viewport.panBy(dx, dy); return;
      }
      if (ed.gridDrag) {
        const [W, H] = ed.dispSize(), [iw, ih] = ed.dims, k = ed.viewport.scale;
        ed.grid.ox = ed.gridDrag.ox + (e.clientX - ed.gridDrag.x) / k / W * iw;
        ed.grid.oy = ed.gridDrag.oy + (e.clientY - ed.gridDrag.y) / k / H * ih;
        ed.renderGrid(); return;
      }
      if (ed.rectDraft) { ed.rectDraft.b = ed.snapPoint(...ed.evtNorm(e)).pt; ed.renderActive(); return; }
      if (ed.dragSheet) { ed.dragSheet.move(...ed.evtNorm(e)); return; }
      // A vertex/marker press only becomes an edit once the pointer travels past a
      // small threshold; below it the press is a select/inspect click and must not
      // move geometry or mark the store dirty (else a stray click looks like an edit).
      if ((ed.dragItem || ed.dragVertex || ed.dragEdge) && !this._pastDragThreshold(e)) return;
      if (ed.dragItem) { ed.dragItem.move(...ed.evtNorm(e), e); return; }
      if (ed.dragEdge) { ed.dragEdge.move(...ed.evtNorm(e), e); return; }
      if (ed.dragVertex) {
        // A midpoint press defers inserting its node until the drag really starts, so
        // clicking a midpoint without dragging adds nothing (and stays clean).
        if (ed.dragVertex.pending) {
          ed.dragVertex.poly.splice(ed.dragVertex.i, 0, ed.dragVertex.point);
          ed.dragVertex.pending = false;
        }
        const { poly, i, exclude, dirty, closed } = ed.dragVertex;
        const n = poly.length;
        // Right-angle neighbours are the adjacent nodes. A closed polygon wraps; an
        // open path (arrow) has none past its two ends, so don't wrap across them.
        const nbs = closed === false
          ? [i > 0 ? poly[i - 1] : null, i < n - 1 ? poly[i + 1] : null].filter(Boolean)
          : [poly[(i - 1 + n) % n], poly[(i + 1) % n]];
        const r = ed._placePoint(...ed.evtNorm(e), nbs, exclude);
        poly[i] = [Math.max(0, Math.min(1, r.pt[0])), Math.max(0, Math.min(1, r.pt[1]))];
        ed.dragVertex.ortho = r.ortho;
        dirty(); ed.renderActive(); return;
      }
      if (ed.draft) {
        const r = ed._placePoint(...ed.evtNorm(e), ed._draftNeighbours());
        ed.draft.cursor = { pt: r.pt, kind: r.kind, ortho: r.ortho };
        ed.renderActive();
      }
    });
    s.addEventListener('pointerup', (e) => {
      // A finger lifting out of a pinch ends (or, with one finger left, resumes a pan);
      // skip the normal single-pointer teardown below, which would null the resumed pan.
      // Arm the click guard on the way out, like every other gesture-end branch below: a pinch
      // whose last finger lifts over a hotspot/room still synthesizes a tap, which would
      // otherwise open that building (MOBILE-2).
      if (this._pointers.delete(e.pointerId) && this._pinch) {
        this._suppressClick = true;
        if (this._pointers.size < 2) this._endPinch();
        return;
      }
      // A rectangle drag ends here: build the box and commit it as a shape (its own
      // undo snapshot is taken inside _commitRect). Swallow the trailing click.
      if (ed.rectDraft) { this._suppressClick = true; ed._finishRect(); return; }
      // A sheet drag ends here: commit the move (which re-renders) and swallow the
      // trailing click so it doesn't deselect/draw.
      if (ed.dragSheet) { this._suppressClick = true; const d = ed.dragSheet; ed.dragSheet = null; d.drop(); return; }
      // A left-button pan is followed by a click event — swallow that one click. A *forced*
      // (Space-held) pan swallows it even when the press never moved: the hand tool exists to
      // click through nothing, so it must not select a shape or place a draft point either.
      if (ed.pan && ed.pan.btn === 0 && (ed.pan.moved || ed.pan.forced)) this._suppressClick = true;
      // A vertex/handle/edge press or drag also ends with a synthetic click on the svg;
      // swallow it so it doesn't fall through to the background-click deselect,
      // keeping the shape selected for the next node edit.
      if (ed.dragVertex || ed.dragItem || ed.dragEdge) this._suppressClick = true;
      // A vertex/marker/edge drag that actually moved geometry commits its pre-drag snapshot
      // to the undo history (captured on pointerdown). A press that never passed the
      // drag threshold — a plain select/inspect click — mutated nothing, so discard it.
      if ((ed.dragVertex || ed.dragItem || ed.dragEdge) && this._dragDown && this._dragDown.moved
          && this._gestureSnap) ed.history.push(this._gestureSnap);
      this._gestureSnap = null;
      const hadVertex = !!ed.dragVertex;
      ed.pan = null; s.classList.remove('panning');
      ed.dragVertex = null; ed.gridDrag = null; ed.dragItem = null; ed.dragEdge = null;
      if (hadVertex) ed.renderActive();   // drop the transient right-angle guide
    });
    s.addEventListener('pointerleave', () => {
      if (ed.draft && ed.draft.cursor) { ed.draft.cursor = null; ed.render(); }
      // A pan still holding a *deferred* capture (a shape-origin press that hasn't passed the
      // drag threshold) can no longer be tracked once the pointer leaves the svg — its
      // pointerup lands on some other element and never reaches us, leaving the channel armed
      // to pan on a later button-less hover. Drop it; the gesture panned nothing anyway. A pan
      // that already took its capture never sees pointerleave, so this only ever catches that.
      if (ed.pan && ed.pan.grab != null) ed.pan = null;
    });
    // A cancelled pointer (the browser reclaimed the gesture) never fires pointerup —
    // forget it and unwind any pinch/pan so the next touch starts clean.
    s.addEventListener('pointercancel', (e) => {
      this._pointers.delete(e.pointerId);
      // Same click guard as the pinch branch of pointerup: a reclaimed gesture must not leave a
      // trailing tap behind either (MOBILE-2).
      if (this._pinch) this._suppressClick = true;
      if (this._pinch && this._pointers.size < 2) this._endPinch();
      ed.pan = null; s.classList.remove('panning');
    });
    s.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (ed.grid.adjust && ed.gridActive()) { ed.grid.resize(e.deltaY); ed.render(); return; }
      ed.viewport.zoomBy(e.deltaY < 0 ? ZOOM_STEP_WHEEL : 1 / ZOOM_STEP_WHEEL, { x: e.clientX, y: e.clientY });
    }, { passive: false });
  }

  /** What a `pointerdown` on the map arms, decided from the press alone. Pure and static so the
   *  one rule that used to be spelled inline in `bind()` can be unit-tested (`bind()` itself is
   *  all DOM and can't be). `onBackground` is true for the svg or the transparent `.catcher`,
   *  false for any shape the press landed on.
   *
   *  - `'rect'`         — the rectangle tool lays out a box; wins **wherever the press lands**
   *                       (FLOOR-8 — same reasoning as the pan rule below: `beginRect` always
   *                       clears the selection, so no shape owns a competing `pointerdown` while
   *                       the tool is armed), taking precedence over the pan.
   *  - `'pan'`          — pan the viewport, taking pointer capture immediately.
   *  - `'pan-deferred'` — pan the viewport, but WITHOUT capturing yet (see `_armPan`).
   *  - `null`           — nothing; the press belongs to whatever it landed on.
   *
   *  A left press arms a pan **wherever it lands**, including on top of a room or hotspot
   *  (FLOOR-7): on a floor whose polygons tile the whole view there is otherwise no background
   *  left to grab, and the map can't be dragged at all. What keeps that from eating the shape's
   *  click is the drag threshold, not the hit test — below `DRAG_THRESHOLD_PX` the press stays a
   *  plain click. Shapes owning a left-drag of their own (vertex, midpoint, marker, the selected
   *  room's body, a sheet tile) `stopPropagation()` on `pointerdown`, so those gestures never
   *  reach the listener that calls this. */
  static pressIntent({ button, onBackground, rectMode, editing, gridAdjust }) {
    if (rectMode && button === 0 && editing && !gridAdjust) return 'rect';
    if (button === 1) return 'pan';
    if (button === 0) return onBackground ? 'pan' : 'pan-deferred';
    return null;
  }

  /** Open the pan channel for this press, and return the record so a caller can flag it.
   *
   *  `capture` decides WHEN the svg takes the pointer, which is the whole reason a press that
   *  started on a shape can still be a click: pointer capture retargets the trailing `click` to
   *  the capture element (Pointer Events L3 — it is why a vertex drag "ends with a synthetic
   *  click on the svg", see pointerup). Capturing here for a shape-origin press would therefore
   *  steal every room/hotspot click and break navigation. So the capture is **deferred** to the
   *  moment `pointermove` crosses the drag threshold and the press becomes a genuine pan;
   *  a background or middle-button press has no shape click to protect and captures at once. */
  _armPan(e, capture) {
    const ed = this.ed;
    ed.pan = { x: e.clientX, y: e.clientY, moved: false, btn: e.button };
    if (capture) ed.svg.setPointerCapture(e.pointerId);
    else ed.pan.grab = e.pointerId;
    return ed.pan;
  }

  /** True when this click is the tail of a gesture that already did its job — a pan, a pinch, or
   *  a vertex/marker/sheet/rectangle drag — and so must not also select. Consumes the flag, so
   *  exactly one click is swallowed per armed gesture.
   *
   *  Every tap-to-select handler on a *shape* must call this first (MOBILE-2). Those handlers
   *  `stopPropagation()`, so the svg-level `click` listener that would otherwise apply the guard
   *  never runs for them — which is how a two-finger pinch ending over a building hotspot used to
   *  open that building. One implementation here rather than a re-derived check per surface. */
  gestureClick() {
    if (!this._suppressClick) return false;
    this._suppressClick = false;
    return true;
  }

  /** True once a vertex/marker press has travelled far enough to count as a drag
   *  (latched, like the pan threshold). Below it the press is a select/inspect click. */
  _pastDragThreshold(e) {
    const d = this._dragDown;
    if (!d || d.moved) return true;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD_PX) return false;
    d.moved = true; return true;
  }

  /** Index of the polygon edge the press `e` lies on (within a zoom-invariant grab band),
   *  or -1 when the press is in the interior. `poly` is normalized; the band mirrors
   *  snapPoint's SNAP_PX/scale so it feels the same at any zoom, and the projection is done
   *  in displayed px (via W/H) so the non-uniform 0..1 space doesn't skew the distance.
   *  A general hit-test for edge dragging: a caller wires it on a selected shape's own body
   *  press, where the vertex/midpoint circles' stopPropagation has already excluded node
   *  presses, so a positive hit is an edge grab and a -1 falls through to a whole-shape move. */
  edgeHit(e, poly) {
    const ed = this.ed;
    const [W, H] = ed.dispSize(); if (!W) return -1;
    const [nx, ny] = ed.evtNorm(e);
    const px = nx * W, py = ny * H;
    let best = EDGE_GRAB_PX / ed.viewport.scale, hit = -1;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const pr = Geom.projSeg(px, py, a[0] * W, a[1] * H, b[0] * W, b[1] * H);
      if (pr.d < best) { best = pr.d; hit = i; }
    }
    return hit;
  }

  /** CAD-style resize cursor for hovering polygon edge `i` (a companion to `edgeHit`): the
   *  double-arrow aligned with the edge's *perpendicular*, i.e. the axis a wall drag moves
   *  along. The edge angle is taken in displayed px (via W/H, like `edgeHit`) so the
   *  non-uniform 0..1 space doesn't skew it, then rotated 90° and bucketed to the nearest 45°.
   *  Axis-aligned rooms — the common case — resolve exactly (horizontal edge -> `ns-resize`,
   *  vertical -> `ew-resize`); diagonals get the matching diagonal resize cursor. */
  edgeCursor(poly, i) {
    const [W, H] = this.ed.dispSize();
    const a = poly[i], b = poly[(i + 1) % poly.length];
    let deg = Math.atan2((b[1] - a[1]) * H, (b[0] - a[0]) * W) * 180 / Math.PI + 90;
    deg = ((deg % 180) + 180) % 180;   // motion axis in [0,180)
    if (deg < 22.5 || deg >= 157.5) return 'ew-resize';
    if (deg < 67.5) return 'nwse-resize';
    if (deg < 112.5) return 'ns-resize';
    return 'nesw-resize';
  }

  // ---- multi-touch pinch-zoom (view-mode touch; MOBILE-1) ----
  // Two fingers zoom the viewport. Zoom is safe in every mode, but a pinch never
  // hijacks an in-progress edit gesture (vertex/marker/sheet/grid/rect/draft), so
  // edit-mode interactions — which stay desktop/mouse-only by design — are untouched.

  /** A second finger landed: begin a pinch. Converts any in-progress background pan
   *  into the pinch and seeds the initial finger distance + midpoint. */
  _beginPinch() {
    const ed = this.ed;
    if (ed.dragVertex || ed.dragItem || ed.dragEdge || ed.dragSheet || ed.gridDrag
        || ed.rectDraft || ed.draft) return;
    const [a, b] = [...this._pointers.values()];
    this._pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y),
      mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    ed.pan = null; ed.svg.classList.remove('panning');
  }

  /** Per-move pinch update: scale about the finger midpoint by the distance ratio,
   *  and pan by how far that midpoint travelled (so a two-finger drag also translates). */
  _updatePinch() {
    if (this._pointers.size < 2) return;
    const [a, b] = [...this._pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (this._pinch.dist > 0) this.ed.viewport.zoomBy(dist / this._pinch.dist, mid);
    this.ed.viewport.panBy(mid.x - this._pinch.mx, mid.y - this._pinch.my);
    this._pinch = { dist, mx: mid.x, my: mid.y };
  }

  /** A finger lifted, ending the pinch. If exactly one finger remains, flow straight
   *  into a one-finger pan from it so lifting one finger doesn't strand the map. */
  _endPinch() {
    this._pinch = null;
    if (this._pointers.size !== 1) return;
    const [id] = [...this._pointers.keys()], p = this._pointers.get(id);
    this.ed.pan = { x: p.x, y: p.y, moved: true, btn: 0 };
    try { this.ed.svg.setPointerCapture(id); } catch (e) { /* pointer already gone */ }
  }

  /** The shared engine's keyboard bindings. Reached through `Editor.handleKey` — the dispatch
   *  seam each subclass overrides with its own rungs before falling through via `super`. */
  handleKey(e) {
    const ed = this.ed;
    if (e.key === 'Enter' && ed.draft) { ed.finish(); return; }
    // '?' opens the shortcuts reference — the conventional binding, and the one the panel
    // itself advertises. Checked on `key` (not the shifted-'/' physical key) so it works on any
    // layout that can produce the character at all.
    if (e.key === '?') { e.preventDefault(); ed.toolbar.openShortcuts(); return; }
    // Ctrl/Cmd-Z: mid-draw it pops the last draft point; otherwise it undoes the last
    // committed mutation off the per-editor history stack.
    if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); ed.draft ? ed.undoNode() : ed.undo(); return;
    }
    if (e.key === 'Backspace' && ed.draft) { e.preventDefault(); ed.undoNode(); return; }
    // Hold Space for the hand tool (the Figma/CAD convention): while held, a left press pans
    // whatever it lands on. The escape hatch for the places the pointer alone can't reach the
    // map — the selected room's body, which owns its press to drag the room — and the one that
    // is discoverable, unlike the middle button no trackpad has. Released in `handleKeyUp`.
    if (e.key === ' ') {
      if (EditorPointer._isControlTarget(e.target)) return;   // Space is that control's own activation key
      e.preventDefault();                                     // ...and the page's scroll key everywhere else
      this._setForcePan(true); return;
    }
    if (e.key === '+' || e.key === '=') { ed.viewport.zoomBy(ZOOM_STEP); return; }
    if (e.key === '-' || e.key === '_') { ed.viewport.zoomBy(1 / ZOOM_STEP); return; }
    if (e.key === '0') { ed.viewport.fit(); return; }
    if (e.key === 'Escape') {
      if (ed.rectMode) { ed.rectMode = false; ed.rectDraft = null; ed.render(); }
      else if (ed.draft) { ed.draft = null; ed.render(); }
      // The last rung is the editor's own `deselect()`, so Escape and a background click drop a
      // selection through exactly one implementation (the siteplan's clean-promotion discard, the
      // floor's extra selection channels) instead of each editor re-deriving it in `handleKey`.
      else if (ed.selected) ed.deselect();
    }
  }

  /** The keyup half of the dispatch above (reached through `Editor.handleKeyUp`), for the one
   *  binding that is *held* rather than pressed: releasing Space puts the hand tool away. */
  handleKeyUp(e) { if (e.key === ' ') this._setForcePan(false); }

  /** Drop any held-key gesture state. Called when the window loses focus: the keyup that would
   *  release the hand tool is delivered to whatever took focus and never arrives here, and a
   *  hand tool stuck on would swallow every subsequent click on the map. */
  cancelHeldKeys() { this._setForcePan(false); }

  /** Engage/disengage the hand tool, mirroring it onto the svg as `.force-pan` so the cursor can
   *  advertise it (style.css). Idempotent — Space auto-repeats while held. */
  _setForcePan(on) {
    if (this._forcePan === on) return;
    this._forcePan = on;
    if (this.ed.svg) this.ed.svg.classList.toggle('force-pan', on);
  }

  /** True when a key event landed on a control that owns Space as its activation key. `App`'s
   *  document-level keydown only filters `input, textarea, select`, so a focused toolbar button
   *  still reaches us — and swallowing its Space would leave it unusable from the keyboard. */
  static _isControlTarget(t) {
    return !!(t && t.closest && t.closest('button, a[href], summary, [role="button"], [contenteditable]'));
  }
}
