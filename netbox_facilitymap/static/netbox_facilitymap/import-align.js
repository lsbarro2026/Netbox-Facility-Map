'use strict';
/* import-align.js — ImportAlign: the import wizard's GIS-overlay georeferencing concern (FMT-6).
   Owns the align editor — the card row that reports a layer's placement state, the full-canvas
   pin editor, and its pointer wiring — plus the control-point solver the editor previews with.

   Holds a wizard back-ref (`this.w`), the ImportUploader shape: the editor renders through the
   flow's `_stage`, persists through `_saveDraft`, and returns to `_stepMap`.

   The solver statics are pure and deliberately live here, next to their only consumer: they are
   the JS mirror of the backend's `OverlayProjector` and the two must be kept in LOCKSTEP
   (architecture §10) — `solve` ↔ `_solve_pairs`, `_similarity` ↔ `_similarity`, `_lsqAffine` ↔
   `_lsq_affine`. A change to one is a change to both. */

class ImportAlign {
  constructor(wizard) {
    this.w = wizard;
  }

  /** The overlay card's alignment row: the layer's placement state (approximate fit vs aligned
   *  with N control points) and the jump into the align editor. Overlay cards only. */
  row(b, p) {
    const pairs = ((b.align && b.align[p.stem]) || []).filter(ImportFlow._validAlignPair);
    const aligned = pairs.length >= 2;
    const state = Dom.el('span', { class: 'imp-align-state' + (aligned ? ' ok' : '') },
      aligned ? '⌖ aligned (' + pairs.length + ' points)' : 'placed by approximate fit');
    return Dom.el('div', { class: 'imp-align-row' }, [
      state,
      Dom.el('button', { class: 'imp-floor',
        title: 'Pin points on this data layer to their true spots on the floor plan (georeference)',
        onclick: () => this.open(b, p) }, '⌖ Align on plan…'),
    ]);
  }

  /** The built manifest's overlay entry for drawing stem `stem` of building model `b` — with its
   *  floor + manifest building — or null when the facility hasn't been built with this overlay
   *  mapped yet. Matched by the manifest `folder` (the same key the edit hub's binding recovery
   *  uses) and the overlay `name` (the drawing stem `preprocess` writes). */
  _manifestOverlay(b, stem) {
    const manifest = this.w.app.store.manifest;
    for (const mb of (manifest && manifest.buildings) || []) {
      if (mb.folder !== b.folder) continue;
      for (const floor of mb.floors || [])
        for (const ov of floor.overlays || [])
          if (ov.name === stem) return { building: mb, floor, overlay: ov };
    }
    return null;
  }

  /** Align-overlay editor (FMT-6): the floor's combined canvas with the overlay drawn on top;
   *  clicking a feature vertex drops a control-point pin whose head is then dragged to the same
   *  physical spot on the plan. Each pin is a `{src, dst}` pair — `src` the vertex's RAW source
   *  coordinate (recovered by inverting the manifest's `srcTransform`), `dst` a 0..1 point on the
   *  floor canvas — stored on `b.align[p.stem]` (draft-persisted) and emitted at build as the
   *  import-map `overlayAlign`, which georeferences the layer server-side. With ≥2 pins the
   *  editor re-solves the transform locally (`ImportAlign.solve`, the JS mirror of the backend's
   *  OverlayProjector) so the preview tracks live; the authoritative solve still happens at
   *  rebuild. Needs a built manifest carrying this overlay — the deliberate flow is build once
   *  (approximate fit), then align, then rebuild. Follows the `ImportRegions.openSplit`
   *  viewport/zoom precedent. */
  open(b, p) {
    const w = this.w;
    const view = w._stage('Align ' + p.file + ' on the plan');
    w._detourBack(view, '← Back to floor mapping', () => w._stepMap());
    const found = this._manifestOverlay(b, p.stem);
    const unproject = found && Array.isArray(found.overlay.srcTransform)
      ? ImportAlign.invertAffine(found.overlay.srcTransform) : null;
    if (!unproject) {
      view.append(Dom.el('p', { class: 'hint' },
        'This overlay isn’t part of the built facility yet (or was built by an older version). '
        + 'Assign it a floor and run Review & build once — it imports with an approximate fit — '
        + 'then come back here to pin it to the plan.'));
      view.append(Dom.el('div', { class: 'imp-actions' },
        [Dom.el('button', { class: 'primary', onclick: () => w._stepMap() }, '← Back')]));
      return;
    }
    const { building, floor, overlay } = found;

    // Every feature vertex back in RAW source coordinates, so the live preview can re-place the
    // whole layer through a freshly solved transform (and a clicked vertex knows its `src`).
    const rawFeats = (overlay.features || []).map((feat) => ({
      type: feat.type,
      raw: feat.type === 'point'
        ? [unproject(feat.coords[0], feat.coords[1])]
        : feat.coords.map((c) => unproject(c[0], c[1])),
    }));
    const rawPoints = [];
    for (const f of rawFeats) for (const pt of f.raw) rawPoints.push(pt);

    view.append(Dom.el('p', { class: 'hint' },
      'Click a recognizable point on the data layer (a corner, a junction), then drag the pin to '
      + 'the same physical spot on the floor plan. Two pins align the layer (scale + rotation); '
      + 'a third refines it with a best fit. The preview updates live — the alignment is applied '
      + 'to the facility when you rebuild (Review & build).'));

    // One SVG in layout-px units: sheet images tiled per the floor's combined canvas (honoring a
    // saved arrangement — the same `floorLayout` geometry the map renders), the overlay features,
    // and the control-point pins. Normalized 0..1 coords scale by the layout size, exactly the
    // floor editor's convention, and the <svg> keeps the viewBox aspect so pointer→0..1 mapping
    // is a plain getBoundingClientRect division (the `ImportRegions._attachAdd` technique).
    const g = w.app.store.floorLayout(building.dir, floor.id);
    const svg = Dom.svg('svg', { viewBox: '0 0 ' + g.W + ' ' + g.H, class: 'imp-align-svg' });
    for (const cell of g.cells)
      svg.append(Dom.svg('image', { href: w.app.store.mediaUrl(cell.image),
        x: cell.col * g.cellW, y: cell.row * g.cellH, width: cell.w, height: cell.h }));
    const featLayer = Dom.svg('g');
    const pinLayer = Dom.svg('g');
    svg.append(featLayer);
    svg.append(pinLayer);
    const canvas = Dom.el('div', { class: 'imp-region-canvas imp-align-canvas' }, [svg]);
    const viewport = Dom.el('div', { class: 'imp-region-view' }, [canvas]);
    const status = Dom.el('p', { class: 'imp-align-status' });
    const list = Dom.el('div', { class: 'imp-region-list' });
    // Marker geometry in layout units (the canvas can be thousands of px wide, so fixed pixel
    // radii would vanish); ~0.5% of a sheet reads well at fit-to-width and while zoomed.
    const unit = Math.max(g.cellW, g.cellH) / 200;

    const snapshot = JSON.stringify(b.align[p.stem] || []);
    const pairs = () => b.align[p.stem];
    const validPairs = () => pairs().filter(ImportFlow._validAlignPair);
    // The transform the preview draws with: a live local solve once ≥2 pins exist, else the
    // manifest's as-built placement.
    const displayTransform = () => {
      const clean = validPairs();
      if (clean.length >= 2) {
        const t = ImportAlign.solve(clean, overlay.crs, rawPoints);
        if (t) return t;
      }
      return overlay.srcTransform;
    };

    const redraw = () => {
      const t = displayTransform();
      featLayer.innerHTML = '';
      pinLayer.innerHTML = '';
      for (const f of rawFeats) {
        const pts = f.raw.map((pt) => ImportAlign.applyAffine(t, pt[0], pt[1]));
        if (f.type === 'point') {
          featLayer.append(Dom.svg('circle', { cx: pts[0][0] * g.W, cy: pts[0][1] * g.H,
            r: unit, class: 'imp-align-feat' }));
        } else {
          featLayer.append(Dom.svg(f.type === 'polygon' ? 'polygon' : 'polyline', {
            points: pts.map((pt) => (pt[0] * g.W) + ',' + (pt[1] * g.H)).join(' '),
            'stroke-width': unit / 2, class: 'imp-align-feat' }));
        }
      }
      pairs().forEach((pr, i) => {
        const s = ImportAlign.applyAffine(t, pr.src[0], pr.src[1]);
        const d = pr.dst;
        // Tail (where the source point currently sits) → head (its true spot). With ≥2 pins the
        // solve interpolates the anchors exactly, so an anchored pin's tail collapses onto its
        // head — visually confirming the fit.
        pinLayer.append(Dom.svg('line', { x1: s[0] * g.W, y1: s[1] * g.H,
          x2: d[0] * g.W, y2: d[1] * g.H, 'stroke-width': unit / 3, class: 'imp-align-link' }));
        pinLayer.append(Dom.svg('circle', { cx: s[0] * g.W, cy: s[1] * g.H, r: unit * 0.8,
          class: 'imp-align-tail' }));
        const head = Dom.svg('circle', { cx: d[0] * g.W, cy: d[1] * g.H, r: unit * 1.4,
          class: 'imp-align-head', 'data-pin': String(i) });
        pinLayer.append(head);
        const label = Dom.svg('text', { x: d[0] * g.W, y: d[1] * g.H - unit * 1.8,
          'font-size': unit * 2.2, 'text-anchor': 'middle', class: 'imp-align-num' });
        label.textContent = String(i + 1);
        pinLayer.append(label);
      });
      const n = validPairs().length;
      status.textContent =
        n >= 3 ? n + ' pins — aligned (best-fit). Rebuild to apply.'
          : n === 2 ? '2 pins — aligned (scaled + rotated to fit). Rebuild to apply.'
            : n === 1 ? '1 pin — add at least one more to align the layer.'
              : 'No pins yet.';
      status.className = 'imp-align-status' + (n >= 2 ? ' ok' : '');
      list.innerHTML = '';
      pairs().forEach((pr, i) => {
        list.append(Dom.el('div', { class: 'imp-region-row' }, [
          Dom.el('span', { class: 'imp-region-rownum' }, 'Pin ' + (i + 1)),
          Dom.el('button', { class: 'imp-floor', onclick: () => {
            pairs().splice(i, 1); w._saveDraft(); redraw();
          } }, 'Remove'),
        ]));
      });
    };

    this._attachDrag(svg, { pairs, validPairs, displayTransform, rawFeats, redraw });

    view.append(ImportPreview.zoomBar(canvas, w._regionZoom));
    view.append(viewport);
    view.append(status);
    view.append(list);
    ImportPreview.applyZoom(canvas, w._regionZoom);
    redraw();

    view.append(Dom.el('div', { class: 'imp-actions' }, [
      Dom.el('button', { class: 'primary',
        onclick: async () => { await w._saveDraft(); w._stepMap(); } }, 'Done'),
      Dom.el('button', { onclick: async () => {
        if (pairs().length && !confirm('Remove all alignment pins from this overlay?')) return;
        b.align[p.stem] = []; await w._saveDraft(); redraw();
      } }, 'Clear alignment'),
      Dom.el('button', { onclick: () => {
        b.align[p.stem] = JSON.parse(snapshot); w._stepMap();
      } }, 'Cancel'),
    ]));
  }

  /** Pointer wiring for the align editor: press on a pin head drags it; press near a displayed
   *  feature vertex drops a NEW pin there (src = that vertex's raw coordinate) and immediately
   *  drags its head, so pinning is one gesture — press the layer point, drag to its true spot.
   *  A press on empty plan does nothing (no accidental pins). Coordinates map pointer→0..1 via
   *  the svg's live `getBoundingClientRect` (the `ImportRegions._attachAdd` technique — the svg
   *  keeps the viewBox aspect, so there is no letterboxing to correct for). */
  _attachDrag(svg, ed) {
    svg.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const norm = (ev) => [
        Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)),
        Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height)),
      ];
      const [nx, ny] = norm(e);
      // Screen-space hit radius (12px) converted to normalized units so snapping feels the same
      // at any zoom. The canvas keeps the viewBox aspect, so one axis conversion suffices.
      const hit = 12 / rect.width;
      let pair = null;
      const headEl = e.target.closest ? e.target.closest('.imp-align-head') : null;
      if (headEl) {
        pair = ed.pairs()[Number(headEl.getAttribute('data-pin'))] || null;
      } else {
        // Snap to the nearest displayed feature vertex within the hit radius.
        const t = ed.displayTransform();
        let best = null, bestD = hit * hit;
        for (const f of ed.rawFeats) {
          for (const pt of f.raw) {
            const dpt = ImportAlign.applyAffine(t, pt[0], pt[1]);
            const dx = dpt[0] - nx, dy = (dpt[1] - ny) * (rect.height / rect.width);
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD) { bestD = d2; best = pt; }
          }
        }
        if (best) {
          const start = ImportAlign.applyAffine(t, best[0], best[1]);
          pair = { src: [best[0], best[1]], dst: [start[0], start[1]] };
          ed.pairs().push(pair);
        }
      }
      if (!pair) return;
      try { svg.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      const move = (ev) => { pair.dst = norm(ev); ed.redraw(); };
      const up = () => {
        svg.removeEventListener('pointermove', move);
        svg.removeEventListener('pointerup', up);
        this.w._saveDraft();
        ed.redraw();
      };
      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerup', up);
      ed.redraw();
    });
  }

  // ---- the control-point solver (mirror of the backend OverlayProjector — keep in LOCKSTEP) ----

  /** Apply a 6-coefficient affine `[a,b,c,d,e,f]`: `(x, y) → [a·x + b·y + c, d·x + e·y + f]`. */
  static applyAffine(t, x, y) {
    return [t[0] * x + t[1] * y + t[2], t[3] * x + t[4] * y + t[5]];
  }

  /** Invert a 6-coefficient affine, or null when (near-)singular. The align editor uses it to
   *  recover the raw source coordinate behind a manifest overlay vertex from `srcTransform`. */
  static invertAffine(t) {
    const a = t[0], bb = t[1], c = t[2], d = t[3], e = t[4], f = t[5];
    const det = a * e - bb * d;
    if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
    return (nx, ny) => [
      (e * (nx - c) - bb * (ny - f)) / det,
      (a * (ny - f) - d * (nx - c)) / det,
    ];
  }

  /** Solve the control-point transform from ≥2 clean pairs — the JS mirror of the backend's
   *  `OverlayProjector._solve_pairs` (keep the two in LOCKSTEP, architecture §10): two pairs →
   *  exact similarity, three+ → least-squares affine, both solved in a Y-down pre-projected
   *  working plane (`u = k·x, v = −y`; `k` = cos of the layer's clamped mid-latitude for a
   *  geographic CRS, else 1 — `rawPoints` supplies the latitudes exactly as the backend derives
   *  them from the layer's own points). Returns the raw-source→unit `[a,b,c,d,e,f]`, or null
   *  when degenerate (the preview then keeps the as-built placement). */
  static solve(pairs, crs, rawPoints) {
    let k = 1;
    if (crs === 'geographic' && rawPoints.length) {
      let lo = Infinity, hi = -Infinity;
      for (const pt of rawPoints) { if (pt[1] < lo) lo = pt[1]; if (pt[1] > hi) hi = pt[1]; }
      const lat0 = Math.max(-89, Math.min(89, (lo + hi) / 2));
      k = Math.cos(lat0 * Math.PI / 180);
    }
    const uv = pairs.map((pr) => [pr.src[0] * k, -pr.src[1]]);
    const dst = pairs.map((pr) => pr.dst);
    const plane = pairs.length === 2
      ? ImportAlign._similarity(uv, dst) : ImportAlign._lsqAffine(uv, dst);
    if (!plane || !plane.every(isFinite)) return null;
    return [plane[0] * k, -plane[1], plane[2], plane[3] * k, -plane[4], plane[5]];
  }

  /** Exact 2-point similarity in the working plane (complex `dst = A·src + B` via real
   *  arithmetic), or null when the source points coincide. Mirrors `OverlayProjector._similarity`. */
  static _similarity(uv, dst) {
    const su = uv[1][0] - uv[0][0], sv = uv[1][1] - uv[0][1];
    const den = su * su + sv * sv;
    if (den < 1e-24) return null;
    const dx = dst[1][0] - dst[0][0], dy = dst[1][1] - dst[0][1];
    const ar = (dx * su + dy * sv) / den;    // A = (d1 − d0) / (s1 − s0)
    const ai = (dy * su - dx * sv) / den;
    const br = dst[0][0] - (ar * uv[0][0] - ai * uv[0][1]);   // B = d0 − A·s0
    const bi = dst[0][1] - (ai * uv[0][0] + ar * uv[0][1]);
    return [ar, -ai, br, ai, ar, bi];
  }

  /** Least-squares affine in the working plane: two 3-unknown normal-equation systems over rows
   *  `[u, v, 1]`, or null when singular (collinear sources). Mirrors `OverlayProjector._lsq_affine`. */
  static _lsqAffine(uv, dst) {
    const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const rx = [0, 0, 0], ry = [0, 0, 0];
    for (let n = 0; n < uv.length; n++) {
      const row = [uv[n][0], uv[n][1], 1];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) m[i][j] += row[i] * row[j];
        rx[i] += row[i] * dst[n][0];
        ry[i] += row[i] * dst[n][1];
      }
    }
    const top = ImportAlign._solve3(m, rx), bot = ImportAlign._solve3(m, ry);
    return top && bot ? [top[0], top[1], top[2], bot[0], bot[1], bot[2]] : null;
  }

  /** 3×3 Gaussian elimination with partial pivoting, or null when singular. Left side `m` and
   *  `rhs` are not modified (worked on copies — `_lsqAffine` reuses `m` for both axes). */
  static _solve3(m, rhs) {
    const a = m.map((row, i) => [row[0], row[1], row[2], rhs[i]]);
    for (let col = 0; col < 3; col++) {
      let piv = col;
      for (let r = col + 1; r < 3; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
      if (Math.abs(a[piv][col]) < 1e-12) return null;
      const tmp = a[col]; a[col] = a[piv]; a[piv] = tmp;
      for (let r = 0; r < 3; r++) {
        if (r === col) continue;
        const factor = a[r][col] / a[col][col];
        for (let c = col; c < 4; c++) a[r][c] -= factor * a[col][c];
      }
    }
    return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
  }
}
