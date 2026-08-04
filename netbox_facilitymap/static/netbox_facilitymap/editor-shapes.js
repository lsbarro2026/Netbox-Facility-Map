'use strict';
/* editor-shapes.js — EditorShapes: the Editor base's vertex/label SVG construction, extracted as
   a collaborator holding an editor back-ref (`this.ed`), the FloorArrange shape (QUAL-4). The
   shared render helpers both subclasses call inside `_renderStatic`/`_renderActive` (catcher,
   editable vertices, the draft preview) and the shared label engine (attachLabel/handles/panel).

   All drawing state stays on the editor and is read through `this.ed`: the drag channels
   (`dragVertex`/`dragItem`), the draft, `editingLabel`, the grid and viewport. The label engine
   is shape-kind agnostic via two hooks that stay on Editor (`_labelKey`/`_labelDirty` — FloorEditor
   overrides them for placements), and `Editor._exitLabelEdit` remains the shared Escape rung. */

class EditorShapes {
  constructor(editor) {
    this.ed = editor;
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
    const dv = this.ed.dragVertex;
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
        this.ed.dragVertex = { poly, i: i + 1, point: [+mx.toFixed(5), +my.toFixed(5)],
          pending: true, exclude: excludeId, dirty: dirtyFn, closed };
        this.ed.svg.setPointerCapture(e.pointerId);   // capture on the stable <svg>, not the layer <g>
      });
      s.append(m);
    }
    poly.forEach((p, i) => {
      const v = Dom.svg('circle', { cx: p[0] * W, cy: p[1] * H, r: 5, class: 'vertex' });
      v.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        this.ed.dragVertex = { poly, i, exclude: excludeId, dirty: dirtyFn, closed };
        this.ed.svg.setPointerCapture(e.pointerId);
      });
      v.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (poly.length <= minPts) { Toast.show('Needs at least ' + minPts + ' points'); return; }
        this.ed.snapshot();   // no-op for editors that don't opt into undo
        poly.splice(i, 1); dirtyFn(); this.ed.render();
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
      const d = 11 / this.ed.viewport.scale;
      const sx = ortho.y[0] * W >= x ? 1 : -1;   // toward the horizontal-edge neighbour
      const sy = ortho.x[1] * H >= y ? 1 : -1;   // toward the vertical-edge neighbour
      s.append(Dom.svg('path', { class: 'ortho-corner', fill: 'none',
        d: `M ${x + sx * d} ${y} L ${x + sx * d} ${y + sy * d} L ${x} ${y + sy * d}` }));
    }
  }

  drawDraft(s, W, H) {
    // Rectangle tool: preview the axis-aligned box being dragged out (same dashed
    // `.draft` styling as a polygon draft).
    if (this.ed.rectDraft) {
      const { a, b } = this.ed.rectDraft;
      const x = Math.min(a[0], b[0]) * W, y = Math.min(a[1], b[1]) * H;
      const w = Math.abs(a[0] - b[0]) * W, h = Math.abs(a[1] - b[1]) * H;
      s.append(Dom.svg('rect', { x, y, width: w, height: h, class: 'draft' }));
      return;
    }
    const draft = this.ed.draft;
    if (!draft || !draft.points.length) return;
    const dp = draft.points, cur = draft.cursor;
    const arrow = draft.kind === 'arrow';
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
        draft.points.splice(i, 1); draft.cursor = null; this.ed.render();
      });
      s.append(v);
    });
    if (cur && cur.ortho) this._drawOrthoGuide(s, cur.pt, cur.ortho, W, H);
    if (cur) s.append(Dom.svg('circle', { cx: cur.pt[0] * W, cy: cur.pt[1] * H, r: cur.kind === 'vertex' ? 7 : 5, class: 'snap-cursor' + (cur.kind ? ' k-' + cur.kind : '') }));
  }

  // ---- the shared label engine (both editors) ----
  // A shape (siteplan hotspot / floor room) carries an optional `labelStyle`
  // `{x,y,rot,size,font,color}`; absent fields fall back to the auto-placed label.
  // While `ed.editingLabel === ed._labelKey(shape)` the label is draggable and grows rotate +
  // resize handles. Geometry mirrors FloorEditor._placementHandles.

  /** Lazily create the shape's labelStyle so a control/handle can write to it. */
  _labelStyle(shape) { return shape.labelStyle || (shape.labelStyle = {}); }

  /** Set centered, vertically-balanced lines on a label `<text>` (origin x:0). One
   *  line is plain text; several become tspans so a user can hand-break the label. */
  setLabelLines(t, lines) {
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

  /** A label's laid-out text box, or null when it can't be measured — an empty label, or an svg
   *  that isn't displayed (`getBBox` throws on a hidden tree, and reads no geometry while the
   *  zoomed-out cull hides labels). Every consumer treats null as "skip", so none of them depends
   *  on the label being on screen: the placement chip and the anti-overlap nudge omit themselves
   *  (FloorEditor), the siteplan's auto-fit falls back to its minimum size, and the edit handles
   *  below draw at the origin rather than aborting the render. */
  labelBox(t) {
    let bb;
    try { bb = t.getBBox(); } catch (e) { return null; }
    return bb.width && bb.height ? bb : null;
  }

  /** Wrap a centered `<text>` (content + font-size already set) in a
   *  `translate(cx,cy) rotate(rot)` group, apply the labelStyle font/colour, and —
   *  when this shape's label is being edited — make it draggable and add handles.
   *  `cx,cy` are the label-centre in normalized coords; `sizePx` is the text's
   *  current font-size (used to map a resize drag back to a font-size). */
  attachLabel(s, shape, textEl, cx, cy, sizePx, W, H) {
    const ed = this.ed;
    const ls = shape.labelStyle || {};
    if (ls.font) textEl.style.fontFamily = ls.font;
    if (ls.color) textEl.style.fill = ls.color;
    // The label being edited stays visible through the zoomed-out LOD cull (.lod-keep), so
    // its move/rotate/resize handles never vanish mid-edit.
    const editing = ed.editingLabel === ed._labelKey(shape);
    const g = Dom.svg('g', { class: 'label-grp' + (editing ? ' lod-keep' : ''),
      transform: `translate(${cx * W},${cy * H}) rotate(${ls.rot || 0})` });
    // Inner counter-scale group: it (and, for placements, the chip inserted into it) is what
    // the CSS legibility floor scales — as one unit, about its own centre — so a zoomed-out
    // label holds a readable on-screen size (`.label-scale` reads `--label-base` + `--inv-scale`,
    // READ-2). `--label-base` is unitless so the CSS `calc()` yields a plain number for `scale()`.
    // Handles are appended to `g`, outside this group, so they don't counter-scale.
    const gScale = Dom.svg('g', { class: 'label-scale' });
    gScale.style.setProperty('--label-base', String(sizePx));
    gScale.append(textEl);
    g.append(gScale);
    s.append(g);
    if (!editing) return g;

    // Drag the label to move it (snaps to the grid; Alt frees it). Keep the grab
    // offset so it doesn't jump its centre under the cursor.
    textEl.style.pointerEvents = 'auto';
    textEl.style.cursor = 'move';
    textEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const [sx, sy] = ed.evtNorm(e), offx = cx - sx, offy = cy - sy;
      ed.dragItem = { move: (nx, ny, ev) => {
        let x = nx + offx, y = ny + offy;
        if (ed.grid.on && !(ev && ev.altKey)) {
          const [iw, ih] = ed.dims;
          x = ed.grid.snap(x * iw, ed.grid.ox) / iw;
          y = ed.grid.snap(y * ih, ed.grid.oy) / ih;
        }
        const st = this._labelStyle(shape);
        st.x = +Math.max(0, Math.min(1, x)).toFixed(5);
        st.y = +Math.max(0, Math.min(1, y)).toFixed(5);
        ed._labelDirty(shape); ed.renderActive();
      } };
      ed.svg.setPointerCapture(e.pointerId);
    });

    // Measured through the guarded `labelBox`: an unmeasurable label (empty text, or an svg that
    // isn't displayed) gives a zero-extent handle cluster at the label origin instead of throwing
    // out of the middle of a render.
    const bb = this.labelBox(textEl) || { width: 0, height: 0 };
    this._drawLabelHandles(s, shape, g, cx, cy, bb.width / 2, bb.height / 2, sizePx, W, H);
    return g;
  }

  /** Rotate handle (above the text) + resize handle (bottom-right corner) for the
   *  label being edited. Rotation snaps to ANGLE_STEP°, resize maps the un-rotated
   *  vertical extent back to a font-size; Alt frees the rotation snap. Both ride the
   *  shared `dragItem` channel. */
  _drawLabelHandles(s, shape, g, cx, cy, halfW, halfH, sizePx, W, H) {
    const ed = this.ed;
    const ry = -halfH - 16;
    g.append(Dom.svg('line', { x1: 0, y1: -halfH, x2: 0, y2: ry, class: 'label-stem' }));
    const rot = Dom.svg('circle', { cx: 0, cy: ry, r: 5, class: 'label-handle' });
    rot.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      ed.dragItem = { move: (nx, ny, ev) => {
        const dx = (nx - cx) * W, dy = (ny - cy) * H;
        let deg = Math.atan2(dy, dx) * 180 / Math.PI + 90;
        if (!(ev && ev.altKey)) deg = Math.round(deg / ANGLE_STEP) * ANGLE_STEP;
        this._labelStyle(shape).rot = ((Math.round(deg) % 360) + 360) % 360;
        ed._labelDirty(shape); ed.renderActive();
      } };
      ed.svg.setPointerCapture(e.pointerId);
    });
    g.append(rot);

    const size = Dom.svg('rect', { x: halfW + 2, y: halfH + 2, width: 9, height: 9, class: 'label-handle' });
    size.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const rad = (shape.labelStyle && shape.labelStyle.rot || 0) * Math.PI / 180;
      const cs = Math.cos(rad), si = Math.sin(rad);
      ed.dragItem = { move: (nx, ny) => {
        const ex = (nx - cx) * W, ey = (ny - cy) * H;
        const ly = -ex * si + ey * cs;                  // un-rotate into the label frame
        const next = halfH ? Math.abs(ly) / halfH * sizePx : sizePx;
        this._labelStyle(shape).size = +Math.max(LABEL_SIZE_MIN, Math.min(LABEL_SIZE_MAX, next)).toFixed(1);
        ed._labelDirty(shape); ed.renderActive();
      } };
      ed.svg.setPointerCapture(e.pointerId);
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
    const ed = this.ed;
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
      ed._labelDirty(shape); ed.render();
    };
    body.append(field('Label text (display only; Enter adds a line break)', textArea));

    const fontSel = Dom.el('select', { class: 'label-ctl' });
    LABEL_FONTS.forEach(f => {
      const o = Dom.el('option', { value: f.css }, f.name);
      if (shape.labelStyle && shape.labelStyle.font === f.css) o.selected = true;
      fontSel.append(o);
    });
    fontSel.onchange = () => { this._labelStyle(shape).font = fontSel.value; ed._labelDirty(shape); ed.render(); };
    body.append(field('Font', fontSel));

    const sizeInp = Dom.el('input', { type: 'number', min: LABEL_SIZE_MIN, max: LABEL_SIZE_MAX, step: 1, class: 'label-ctl', placeholder: 'auto' });
    if (shape.labelStyle && shape.labelStyle.size != null) sizeInp.value = Math.round(shape.labelStyle.size);
    sizeInp.oninput = () => { const v = +sizeInp.value; if (v) { this._labelStyle(shape).size = v; ed._labelDirty(shape); ed.render(); } };
    body.append(field('Size (px)', sizeInp));

    const rotInp = Dom.el('input', { type: 'number', step: ANGLE_STEP, class: 'label-ctl' });
    rotInp.value = (shape.labelStyle && shape.labelStyle.rot) || 0;
    rotInp.oninput = () => { this._labelStyle(shape).rot = ((+rotInp.value % 360) + 360) % 360; ed._labelDirty(shape); ed.render(); };
    body.append(field('Rotation (°)', rotInp));

    const colInp = Dom.el('input', { type: 'color', class: 'label-ctl color' });
    colInp.value = (shape.labelStyle && shape.labelStyle.color) || '#ffffff';
    colInp.oninput = () => { this._labelStyle(shape).color = colInp.value; ed._labelDirty(shape); ed.render(); };
    body.append(field('Color', colInp));

    body.append(Dom.el('button', { class: 'wide', onclick: () => {
      // A note's text is its only content, so keep it and reset just the styling;
      // every other shape falls back to its auto label, so clear the whole override.
      const keep = opts.keepText && shape.labelStyle && shape.labelStyle.text;
      delete shape.labelStyle;
      if (keep) this._labelStyle(shape).text = keep;
      ed._labelDirty(shape); ed.render(); onDone();
    } }, 'Reset to auto'));
    if (opts.onDelete)
      body.append(Dom.el('button', { class: 'wide danger', onclick: opts.onDelete }, 'Delete note'));
    body.append(Dom.el('button', { class: 'wide primary', onclick: onDone }, 'Done'));
  }
}
