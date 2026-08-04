'use strict';
/* import-preview.js — ImportPreview: the import wizard's image-viewing helpers.
   A pure static utility (like Geom/Icons/DeviceShapes), with no wizard state — it operates
   only on passed-in DOM elements, a `frame` view-state object, and callbacks:
     - previewUrl(pdfRel, page, angle)      → the on-demand hi-res render URL for a drawing
     - attachZoomPan(box, img, frame, opts) → cursor-anchored wheel-zoom + drag-pan on an image
     - rotateControls(holder, onChange)     → ⟲/⟳ 90° straightening toolbar bound to a {deg} holder
     - zoomBar(canvas, zoom) / applyZoom(canvas, zoom)
                                            → −/Fit/+ widen-the-canvas zoom for the box editors
     - lightbox(p)                          → full-window preview popup for a drawing
   Shared by the mapping cards, the preview popup, and the box editors (ImportRegions/ImportAlign). */

class ImportPreview {
  /** On-demand high-res render URL for an uploaded drawing (`p.pdf`). The server renders it at
   *  full scale and caches the PNG, so this stays crisp when enlarged or zoomed — unlike the
   *  small scan thumbnail. Used by the preview popup and the lazy card upgrade. `page` (1-based)
   *  selects a page of a multi-page PDF that was exploded into per-page cards; it's only appended
   *  past page 1, so a single-page drawing keeps the bare URL (and shares the server cache).
   *  `angle` (clockwise degrees) straightens a rotated scan; like `page` it's only appended when
   *  non-zero, so an unrotated drawing keeps the bare URL and its shared server cache. */
  static previewUrl(pdfRel, page, angle) {
    const api = window.MAP ? window.MAP.api : '/api/';
    let url = api + 'import/preview?path=' + encodeURIComponent(pdfRel);
    if (page > 1) url += '&page=' + page;
    if (angle % 360) url += '&angle=' + angle;
    return Api.withFacility(url);   // serve from the active facility's working dir (MULTI-2)
  }

  /** A close-up of just the normalized 0..1 `region` of the image at `src`, as a CSS crop: the
   *  <img> is widened to `1/region.w` of its box and translated by `-region.x`/`-region.y` of its
   *  own size, so the region exactly fills an overflow-clipped box. Those are percentages, so the
   *  crop rescales for free with the box; only the aspect ratio needs the render's intrinsic size,
   *  set once on load.
   *
   *  Shared (IMPORT-63) by the map card's code-crop thumbnail (`ImportCards._codeCropThumb`) and by
   *  the region picker's live preview, which exist precisely to show the same thing: "the region I
   *  marked" and "the region OCR reads" diverging invisibly is the bug this closes, and two
   *  independent crop implementations would be a standing invitation for them to diverge again.
   *  A degenerate box is floored rather than dividing by zero — the drag gesture already refuses
   *  one, so this is a guard against a corrupt draft, not a real case. */
  static cropBox(src, region, opts = {}) {
    const w = Math.max(region.w, 1e-6), h = Math.max(region.h, 1e-6);
    const img = Dom.el('img', { class: 'imp-crop-img', src, loading: 'lazy' });
    img.style.width = (100 / w) + '%';
    img.style.transform = 'translate(' + (-region.x * 100) + '%,' + (-region.y * 100) + '%)';
    const attrs = { class: 'imp-thumb imp-codecrop' };
    if (opts.title) attrs.title = opts.title;
    if (opts.onClick) attrs.onclick = opts.onClick;
    const box = Dom.el('div', attrs, [img]);
    const fit = () => {
      const iw = img.naturalWidth, ih = img.naturalHeight;
      if (iw && ih) box.style.aspectRatio = (w * iw) + ' / ' + (h * ih);
    };
    if (img.complete) fit(); else img.addEventListener('load', fit);
    return box;
  }

  /** A small ⟲/⟳ toolbar that straightens a rotated scan in 90° steps. State lives on the passed
   *  `holder` ({deg}) — the wizard model, mutated in place like `attachZoomPan`'s `frame` — so the
   *  angle survives step switches and is emitted at build. `onChange()` fires after each turn (to
   *  re-render the card at the new orientation + persist the draft). `deg` is kept clockwise and
   *  normalized to [0,360). Deliberately narrow (two buttons); a future fine-deskew slider is a
   *  pure add here — it just sets `holder.deg` and calls `onChange`, no signature change. */
  static rotateControls(holder, onChange) {
    const turn = (delta) => { holder.deg = (((holder.deg || 0) + delta) % 360 + 360) % 360; onChange(); };
    const btn = (glyph, title, delta) => Dom.el('button',
      { class: 'imp-rotate-btn', title, onclick: (e) => { e.stopPropagation(); turn(delta); } }, glyph);
    // Swallow pointerdown so a button press never starts the thumb's drag-pan (which would
    // otherwise fire its click-to-lightbox on release).
    // The word "Straighten" rides the toolbar rather than living only in the buttons' tooltips
    // (IMPORT-63): two bare glyphs on a thumbnail are exactly the sort of control a first-time
    // operator has to click to find out about.
    return Dom.el('div', { class: 'imp-rotate', onpointerdown: (e) => e.stopPropagation() }, [
      Dom.el('span', { class: 'imp-rotate-label' }, 'Straighten'),
      btn('⟲', 'Rotate 90° counter-clockwise', -90),
      btn('⟳', 'Rotate 90° clockwise', 90),
    ]);
  }

  /** −/Fit/+ zoom controls for the box editors (the code-region picker, the region split, the
   *  overlay align), so a small floor code or a dense drawing can be marked accurately. Zoom
   *  widens the canvas inside its scrollable viewport rather than transforming it, so the boxes —
   *  positioned by % of the canvas — track the drawing at any zoom and panning is plain scrolling.
   *  "Fit" resets to fill the viewport width; ± steps the zoom (1×–6×). State lives on the passed
   *  `zoom` ({z}) holder, mutated in place like `rotateControls`' `{deg}` — the wizard keeps it so
   *  the factor survives a step switch (a view aid only, never persisted in the draft). */
  static zoomBar(canvas, zoom) {
    const step = (f) => () => {
      zoom.z = Math.max(1, Math.min(6, Math.round((zoom.z + f) * 10) / 10));
      ImportPreview.applyZoom(canvas, zoom);
    };
    return Dom.el('div', { class: 'imp-region-zoom' }, [
      Dom.el('button', { title: 'Zoom out', onclick: step(-0.5) }, '−'),
      Dom.el('button', { title: 'Fit to width',
        onclick: () => { zoom.z = 1; ImportPreview.applyZoom(canvas, zoom); } }, 'Fit'),
      Dom.el('button', { title: 'Zoom in', onclick: step(0.5) }, '+'),
    ]);
  }

  /** Apply the current zoom by widening the canvas; the scrollable viewport handles panning. */
  static applyZoom(canvas, zoom) {
    canvas.style.width = (zoom.z * 100) + '%';
  }

  /** Cursor-anchored scroll-to-zoom + drag-to-pan on an image inside a clipped box —
   *  shared by the mapping cards and the preview popup. `frame` ({scale,x,y}) holds the view
   *  state; for a card it lives on the wizard model so the framing survives step switches (a
   *  viewing aid only, never sent to the build). Panning is clamped to the rendered
   *  (object-fit contained) image so a drag can't slide into the letterbox margins.
   *  `opts.onClick` fires when a press doesn't travel (a click, not a drag); `opts.onZoom`
   *  fires the first time the user zooms in (used to swap in the hi-res render). Double-click
   *  resets the view. */
  static attachZoomPan(box, img, frame, opts = {}) {
    const apply = () => { img.style.transform = `translate(${frame.x}px, ${frame.y}px) scale(${frame.scale})`; };
    const clamp = () => {
      const bw = box.clientWidth, bh = box.clientHeight;
      const nw = img.naturalWidth || bw, nh = img.naturalHeight || bh;
      const fit = Math.min(bw / nw, bh / nh) || 1;      // object-fit: contain ratio
      const mx = Math.max(0, (frame.scale * nw * fit - bw) / 2);
      const my = Math.max(0, (frame.scale * nh * fit - bh) / 2);
      frame.x = Math.max(-mx, Math.min(mx, frame.x));
      frame.y = Math.max(-my, Math.min(my, frame.y));
    };
    apply();
    box.addEventListener('wheel', (e) => {
      e.preventDefault();
      const prev = frame.scale;
      const next = Math.min(8, Math.max(1, prev * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      if (next === prev) return;
      // Keep the point under the cursor fixed across the zoom (transform-origin is centre).
      const r = box.getBoundingClientRect();
      const cx = e.clientX - (r.left + r.width / 2), cy = e.clientY - (r.top + r.height / 2);
      frame.x = cx - (cx - frame.x) * (next / prev);
      frame.y = cy - (cy - frame.y) * (next / prev);
      frame.scale = next;
      if (frame.scale === 1) { frame.x = 0; frame.y = 0; } else clamp();
      apply();
      if (next > prev && opts.onZoom) opts.onZoom();
    }, { passive: false });
    box.addEventListener('dblclick', () => { frame.scale = 1; frame.x = 0; frame.y = 0; apply(); });
    box.addEventListener('pointerdown', (e) => {
      const sx = e.clientX, sy = e.clientY, ox = frame.x, oy = frame.y;
      let moved = 0;
      try { box.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      const move = (ev) => {
        moved += Math.abs(ev.movementX) + Math.abs(ev.movementY);
        if (frame.scale > 1) {
          frame.x = ox + (ev.clientX - sx); frame.y = oy + (ev.clientY - sy);
          clamp(); apply();
        }
      };
      const up = () => {
        box.removeEventListener('pointermove', move);
        box.removeEventListener('pointerup', up);
        if (moved < 4 && opts.onClick) opts.onClick();
      };
      box.addEventListener('pointermove', move);
      box.addEventListener('pointerup', up);
    });
  }

  /** Full-window preview of a drawing. Renders the PDF on demand at full scale (not the small
   *  scan thumbnail), so it stays sharp under wheel-zoom + drag-pan (scroll to zoom at the
   *  cursor, drag to pan, double-click to reset). A PNG always renders inline — no browser
   *  "download PDFs" detour or X-Frame-Options blank. `angle` (clockwise degrees, optional)
   *  shows the drawing straightened, matching a rotated card. Dismissed by the backdrop, ✕, Esc. */
  static lightbox(p, angle) {
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const close = () => { document.removeEventListener('keydown', onKey); box.remove(); };
    const img = Dom.el('img', { class: 'imp-lightbox-img', src: ImportPreview.previewUrl(p.pdf, p.page, angle) });
    const spin = Dom.el('div', { class: 'imp-lightbox-spin' }, 'Rendering preview…');
    img.addEventListener('load', () => spin.remove());
    img.addEventListener('error', () => { spin.remove(); Toast.show('Preview failed to render', true); });
    const body = Dom.el('div', { class: 'imp-lightbox-body' }, [img, spin]);
    const panel = Dom.el('div', { class: 'imp-lightbox-panel' }, [
      Dom.el('div', { class: 'imp-lightbox-head' }, [
        Dom.el('span', {}, p.file),
        Dom.el('button', { class: 'imp-lightbox-x', title: 'Close', onclick: close }, '✕'),
      ]),
      body,
    ]);
    const box = Dom.el('div', { class: 'imp-lightbox' }, [panel]);
    box.addEventListener('click', (e) => { if (e.target === box) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(box);
    ImportPreview.attachZoomPan(body, img, { scale: 1, x: 0, y: 0 });
  }
}
