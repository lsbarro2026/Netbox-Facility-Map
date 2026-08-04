'use strict';
/* floor-annotations.js — FloorAnnotations: the floor's two free-standing annotation shapes, which
   sit over the plan alongside the rooms but bind to nothing in NetBox.

     • route arrows — wayfinding polylines whose head auto-binds to the room it lands in
       ({id, points, room, label, color}), and
     • text notes   — a single-point shape whose only content is its label text
       ({id, x, y, labelStyle:{text,font,size,rot,color,x,y}}). The note IS its label: it rides the
       shared label engine (EditorShapes attachLabel/openLabelPanel), and an empty note is never persisted.

   Both live in the per-floor annotations blob (`data().arrows` / `data().notes`) and are remapped
   with the rooms when sheets are rearranged (FloorArrange._remapLayout).

   Holds an editor back-ref (`this.ed`), the ImportAlign shape. `selectedArrow`/`selectedNote`
   deliberately stay on FloorEditor — its deselect, handleKey, onPanelClosed, _clearTransientState
   and both render layers all read them. */

class FloorAnnotations {
  constructor(editor) { this.ed = editor; }

  beginArrow() {
    this.ed.beginDraw('Click points along the route · Enter/double-click to finish at the room · Esc to cancel', 'arrow');
  }

  /** Close the arrow draft into a route. Drops a trailing duplicate point (the click
   *  that precedes a double-click already added it) and needs ≥ 2 points. */
  finishArrow() {
    const dp = this.ed.draft.points;
    const n = dp.length;
    if (n >= 2 && dp[n - 1][0] === dp[n - 2][0] && dp[n - 1][1] === dp[n - 2][1]) dp.pop();
    if (dp.length < 2) { this.ed.draft = null; this.ed.render(); return; }
    this.ed.snapshot();
    const arrow = { id: Util.uid(), points: dp.slice(), room: null, label: '', color: ARROW_COLORS[0] };
    this._bindArrowDest(arrow);
    this.ed.data().arrows.push(arrow);
    this.ed.draft = null; this.ed.selected = null; this.ed.selectedArrow = arrow; this.ed.markDirty();
    this.ed.render(); this.openArrowPanel(arrow);
  }

  /** Auto-bind the arrow's destination to the room its arrowhead (last point) lands
   *  in, or null. Re-run whenever the route is reshaped so the binding stays fresh. */
  _bindArrowDest(arrow) {
    const last = arrow.points[arrow.points.length - 1];
    const hit = this.ed.data().rooms.find(r => Geom.pointInPoly(last[0], last[1], r.polygon));
    arrow.room = hit ? hit.id : null;
  }

  selectArrow(arrow) {
    this.endNoteEdit();   // selecting an arrow ends any in-progress note edit
    this.ed.selected = null; this.ed.selectedPlacement = null; this.ed.editingLabel = null; this.ed.selectedArrow = arrow;
    this.ed.render(); this.openArrowPanel(arrow);
  }

  deleteArrow(arrow) {
    this.ed.snapshot();
    const arr = this.ed.data().arrows;
    const i = arr.indexOf(arrow);
    if (i >= 0) arr.splice(i, 1);
    this.ed.selectedArrow = null; this.ed.editingLabel = null; this.ed.markDirty(); this.ed.render(); this.ed.app.closePanel();
    this.ed._deleteToast('Arrow deleted');
  }

  // ---- free-standing text notes ----
  // A note is a single-point shape whose only content is its label text
  // ({id,x,y,labelStyle:{text,font,size,rot,color,x,y}}). It rides the shared label
  // engine (attachLabel/openLabelPanel) — the note IS its label — and lives in the
  // per-floor `notes` array (annotations blob). An empty note is never persisted.

  /** Arm the text-note tool: the next map click drops a note there and opens its label
   *  editor (the base draft state machine finishes a `note` draft on its first click). */
  beginNote() {
    this.ed.beginDraw('Click on the map to place a text note · Esc to cancel', 'note');
  }

  /** Close the one-point note draft into a note record and open its label editor. */
  finishNote() {
    const [x, y] = this.ed.draft.points[0];
    this.ed.draft = null;
    this.ed.snapshot();
    const note = { id: Util.uid(), x, y };
    this.ed.data().notes.push(note);
    this.ed.markDirty();
    this._editNote(note);
  }

  /** Enter label-edit for a note via the shared label engine (keyed by the note id) and
   *  focus the text field. The panel carries a "Delete note" button and a note-aware
   *  "Reset to auto" (keeps the text, resets only the styling). Closing the panel
   *  (Done / Esc / ✕) still drops the note when it was left with no text. */
  _editNote(note) {
    this.endNoteEdit();   // drop a previous, still-empty note when switching between notes
    this.ed.selected = null; this.ed.selectedArrow = null; this.ed.selectedPlacement = null; this.ed.selectedNote = note;
    this.ed.editingLabel = note.id;
    this.ed.render();
    this.ed.shapes.openLabelPanel(note, () => this.ed.app.closePanel(), '',
      { keepText: true, onDelete: () => this.deleteNote(note) });
    const ta = Dom.$('#panel-body .label-ctl.text');
    if (ta) ta.focus();
  }

  /** Delete a note outright (explicit button / Delete key), independent of whether it has
   *  text — modelled on `deleteArrow`. Clearing `selectedNote` first makes the following
   *  `closePanel` → `onPanelClosed` a no-op rather than a second drop attempt. */
  deleteNote(note) {
    this.ed.snapshot();
    const notes = this.ed.data().notes;
    const i = notes.indexOf(note);
    if (i >= 0) notes.splice(i, 1);
    this.ed.selectedNote = null; this.ed.editingLabel = null; this.ed.markDirty(); this.ed.render(); this.ed.app.closePanel();
    this.ed._deleteToast('Note deleted');
  }

  /** End any in-progress note edit before a *different* shape takes the selection: drop the
   *  note if it was left empty, and clear its edit state. The caller opens its own panel, so
   *  this neither renders nor closes the panel. */
  endNoteEdit() {
    if (!this.ed.selectedNote) return;
    const note = this.ed.selectedNote;
    this.ed.selectedNote = null;
    if (this.ed.editingLabel === note.id) this.ed.editingLabel = null;
    this.dropEmptyNote(note);
  }

  /** True when a note carries no visible text (an empty note is nothing). */
  _noteEmpty(note) { return !(note.labelStyle && note.labelStyle.text && note.labelStyle.text.trim()); }

  /** Remove a note from the floor if it has no text (marking the store dirty). Pure —
   *  the caller re-renders / closes the panel. */
  dropEmptyNote(note) {
    if (!this._noteEmpty(note)) return;
    const notes = this.ed.data().notes;
    const i = notes.indexOf(note);
    if (i >= 0) { notes.splice(i, 1); this.ed.markDirty(); }
  }

  /** Draw every note into the static layer, skipping the one being edited (it renders in
   *  the active layer so its label drag/handles repaint per frame). */
  drawNotes(s, W, H, skipSelected) {
    for (const note of this.ed.data().notes) {
      if (skipSelected && note === this.ed.selectedNote) continue;
      this.drawNote(s, note, W, H);
    }
  }

  /** Draw one note as haloed text via the shared label engine. An empty note is invisible
   *  except while being edited (a muted placeholder then marks the spot so the drop and its
   *  handles are visible). In edit mode a note that isn't being edited is click-to-edit; in
   *  view mode notes are inert. */
  drawNote(s, note, W, H) {
    const ls = note.labelStyle || {};
    const raw = ls.text != null ? ls.text : '';
    const editingThis = this.ed.editingLabel === note.id;
    if (raw.trim() === '' && !editingThis) return;
    const placeholder = raw.trim() === '' && editingThis;
    const sizePx = ls.size || 14;
    const lcx = ls.x != null ? ls.x : note.x;
    const lcy = ls.y != null ? ls.y : note.y;
    const t = Dom.svg('text', { class: 'note-label' + (placeholder ? ' placeholder' : ''),
      'text-anchor': 'middle', 'dominant-baseline': 'central' });
    t.style.fontSize = sizePx + 'px';
    this.ed.shapes.setLabelLines(t, (placeholder ? 'New note' : raw).split('\n'));
    this.ed.shapes.attachLabel(s, note, t, lcx, lcy, sizePx, W, H);
    if (this.ed.editing() && !this.ed.placingRacks && !editingThis) {
      t.style.pointerEvents = 'auto'; t.style.cursor = 'pointer';
      t.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.ed.pointer.gestureClick()) return;   // pan/pinch tail, not a tap (MOBILE-2)
        if (!this.ed.draft) this._editNote(note);
      });
    }
  }

  /** Draw each route: a fat transparent hit line (edit only), the coloured polyline,
   *  an arrowhead at the destination end, and an optional note at the start. The
   *  selected arrow grows editable nodes. View-mode arrows are inert overlays. */
  drawArrows(s, W, H, skipSelected) {
    const editing = this.ed.editing();
    for (const a of this.ed.data().arrows) {
      if (skipSelected && a === this.ed.selectedArrow) continue;   // selected arrow → active layer
      this.drawArrow(s, a, W, H, editing);
    }
  }

  /** Draw one route into `s`. Shared by the static loop and the active-layer draw of
   *  the selected arrow — the `.selected` styling + editable nodes key off
   *  `this.ed.selectedArrow`, so they appear only for the selected route either way. */
  drawArrow(s, a, W, H, editing) {
    if (!a.points || a.points.length < 2) return;
    const color = a.color || ARROW_COLORS[0];
    const pts = a.points.map(p => `${p[0] * W},${p[1] * H}`).join(' ');

    if (editing) {
      const hit = Dom.svg('polyline', { points: pts, class: 'arrow-hit', fill: 'none' });
      hit.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.ed.pointer.gestureClick()) return;   // pan/pinch tail, not a tap (MOBILE-2)
        if (!this.ed.draft) this.selectArrow(a);
      });
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
      class: 'arrow' + (editing && a === this.ed.selectedArrow ? ' selected' : '') });
    line.style.stroke = color;
    line.style.pointerEvents = 'none';   // all hit-testing goes through .arrow-hit (edit only)
    s.append(line);

    const tri = Geom.arrowHead(p0[0] * W, p0[1] * H, p1[0] * W, p1[1] * H, ARROW_HEAD_PX);
    const head = Dom.svg('polygon', { points: tri.map(p => p.join(',')).join(' '), class: 'arrow-head' });
    head.style.fill = color; head.style.pointerEvents = 'none';
    s.append(head);

    this._drawArrowLabel(s, a, W, H);

    // Suppress the editable nodes while this arrow's label is being moved/styled.
    if (editing && a === this.ed.selectedArrow && this.ed.editingLabel !== this.ed._labelKey(a))
      this.ed.shapes.drawVertices(s, a.points, W, H, a.id,
        () => { this._bindArrowDest(a); this.ed.markDirty(); }, { closed: false, minPts: 2 });
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
    this.ed.shapes.setLabelLines(t, (ls.text != null ? ls.text : a.label).split('\n'));
    this.ed.shapes.attachLabel(s, a, t, lcx, lcy, sizePx, W, H);
  }

  /** Side panel for a selected route: its auto-detected destination, an editable
   *  note, a colour swatch row, and delete. */
  openArrowPanel(arrow) {
    const panel = Dom.$('#panel'); panel.classList.remove('hidden');
    Dom.$('#panel-title').textContent = 'Route arrow';
    const body = Dom.$('#panel-body'); body.innerHTML = '';

    const dest = arrow.room && this.ed.data().rooms.find(r => r.id === arrow.room);
    body.append(Dom.el('div', { class: 'field' }, [
      Dom.el('label', {}, 'Destination (at the arrowhead)'),
      Dom.el('div', { class: 'val' }, dest ? (dest.label || '(unbound room)') : '(arrowhead is not over a room)'),
    ]));

    const note = Dom.el('input', { placeholder: 'e.g. Enter from the north stairwell' });
    note.value = arrow.label || '';
    note.oninput = () => { arrow.label = note.value; this.ed.markDirty(); this.ed.render(); };
    body.append(Dom.el('div', { class: 'field' }, [Dom.el('label', {}, 'Note (shown at the start)'), note]));

    const swatches = Dom.el('div', { class: 'swatch-row' }, ARROW_COLORS.map(c => {
      const sw = Dom.el('button', { class: 'swatch' + (c === (arrow.color || ARROW_COLORS[0]) ? ' on' : ''),
        title: c }); sw.style.background = c;
      sw.onclick = () => { arrow.color = c; this.ed.markDirty(); this.ed.render(); this.openArrowPanel(arrow); };
      return sw;
    }));
    body.append(Dom.el('div', { class: 'field' }, [Dom.el('label', {}, 'Colour'), swatches]));

    // Always offered: even a note-less arrow can carry a display-only label via
    // labelStyle.text (openLabelPanel), matching how rooms/placements behave.
    body.append(Dom.el('button', { class: 'wide', title: 'Style, resize, or reposition this arrow’s label', onclick: () => this.editArrowLabel(arrow),
      html: Icons.edit + '<span>Edit label</span>' }));

    body.append(Dom.el('div', { class: 'hint' },
      'Drag a node to bend · midpoint adds a turn · right-click removes.'));
    body.append(Dom.el('button', { class: 'wide danger', onclick: () => this.deleteArrow(arrow) }, 'Delete arrow'));
  }

  /** Enter label-edit for a route: the note grows move/rotate/resize handles and the
   *  shared style panel opens. Done/Escape return to the arrow panel. */
  editArrowLabel(arrow) {
    this.ed.selectedArrow = arrow; this.ed.editingLabel = this.ed._labelKey(arrow);
    this.ed.render();
    this.ed.shapes.openLabelPanel(arrow, () => this.ed._exitLabelEdit(() => this.openArrowPanel(arrow)),
      arrow.label || '');
  }
}
