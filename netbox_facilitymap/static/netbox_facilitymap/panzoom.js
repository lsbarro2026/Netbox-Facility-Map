'use strict';
/* panzoom.js — PanZoom: the map viewport (Google-Maps-style pan + zoom).

   A pure state + math helper, modeled on GridController: it owns the viewport
   transform and applies it as a single CSS `translate(...) scale(...)` on the
   `.map-wrap`, but it wires no DOM events of its own — the Editor drives it from
   the same pointer/keyboard handlers that own drawing and selection.

   Because the transform lives on an ancestor of the SVG overlay, every existing
   coordinate path keeps working unchanged: `Editor.evtNorm` reads
   `getBoundingClientRect()`, which already reflects the transform, so normalized
   0..1 coordinates stay correct at any pan/zoom.

   Model: transform-origin is the wrap's top-left (0 0), so a wrap-local point u
   (px) maps to screen as `screen = base + (tx,ty) + k*u`. All maths below derive
   from live bounding rects, so no layout/margin bookkeeping is needed. */

class PanZoom {
  constructor() {
    this.wrap = null;        // the transformed .map-wrap
    this.container = null;    // the .map-viewport clip box (the viewport)
    this.tx = 0;              // translation x, screen px
    this.ty = 0;              // translation y, screen px
    this.k = 1;               // scale factor
    this.minScale = 0.05;     // zoom floor: 0.85× the whole-wrap fit (set by _setRange)
    this.maxScale = 8;        // zoom ceiling (set with minScale by _setRange)
  }

  get scale() { return this.k; }

  /** Bind to the wrap + its clip container. Does not fit yet. */
  mount(wrap, container) {
    this.wrap = wrap;
    this.container = container;
    wrap.style.transformOrigin = '0 0';
  }

  /** Write the current transform to the wrap. Also publishes the inverse scale
   *  as `--inv-scale` so node markers can counter-scale to a constant on-screen
   *  size in CSS (the radius analogue of `non-scaling-stroke`) without a render. */
  apply() {
    if (!this.wrap) return;
    this.wrap.style.transform =
      `translate(${this.tx}px,${this.ty}px) scale(${this.k})`;
    this.wrap.style.setProperty('--inv-scale', 1 / this.k);
  }

  /** Set the zoom range. Floor = 0.85× the whole-wrap fit: a full zoom-out shows the
   *  entire map plus a small margin and stops there, rather than shrinking the fixed-
   *  resolution raster below the fit into minification blur. Ceiling 8×. */
  _setRange(fit) {
    this.minScale = fit * 0.85;
    this.maxScale = Math.max(fit * 8, 8);
  }

  /** Scale the whole map to fit the viewport and centre it. Sets the zoom range.
   *  Returns true once it has applied a fit; false if it bailed because the wrap or
   *  viewport had no size yet, so a caller (Editor.attach) can retry when laid out. */
  fit() {
    if (!this.wrap || !this.container) return false;
    this.tx = 0; this.ty = 0; this.k = 1; this.apply();
    const w = this.wrap.getBoundingClientRect();
    const c = this.container.getBoundingClientRect();
    if (!w.width || !w.height || !c.width || !c.height) return false;
    const k = Math.min(c.width / w.width, c.height / w.height);
    this._setRange(k);
    this.k = k;
    this.tx = (c.left + (c.width - w.width * k) / 2) - w.left;
    this.ty = (c.top + (c.height - w.height * k) / 2) - w.top;
    this.apply();
    return true;
  }

  /** Fit a normalized sub-rectangle [nx0,ny0 … nx1,ny1] of the wrap into the
   *  viewport and centre it. The zoom *floor* is 0.85× the whole-wrap fit (independent
   *  of this framed opening scale), so zooming out reveals everything plus a small margin
   *  and `fit()` stays the full reset. Used to open a multi-sheet floor centred on its
   *  primary sheet, zoomed out to reveal the others (see FloorEditor._peekRegion).
   *  Returns true/false like fit() so the initial framing can be retried before layout. */
  fitRegion(nx0, ny0, nx1, ny1) {
    if (!this.wrap || !this.container) return false;
    this.tx = 0; this.ty = 0; this.k = 1; this.apply();
    const w = this.wrap.getBoundingClientRect();
    const c = this.container.getBoundingClientRect();
    if (!w.width || !w.height || !c.width || !c.height) return false;
    const kFull = Math.min(c.width / w.width, c.height / w.height);
    const maxScale = Math.max(kFull * 8, 8);
    const rw = (nx1 - nx0) * w.width, rh = (ny1 - ny0) * w.height;
    this.k = Math.max(kFull, Math.min(maxScale, Math.min(c.width / rw, c.height / rh)));
    this._setRange(kFull);
    // At identity a wrap-local px u renders at screen w.left+u; with the transform
    // screen = w.left + tx + k*u. Put the region centre at the container centre.
    const ucx = (nx0 + nx1) / 2 * w.width, ucy = (ny0 + ny1) / 2 * w.height;
    this.tx = (c.left + c.width / 2) - w.left - this.k * ucx;
    this.ty = (c.top + c.height / 2) - w.top - this.k * ucy;
    this.apply();
    this.clamp();
    return true;
  }

  /** Zoom to a target scale keeping the screen point `pt` ({x,y}) fixed. */
  zoomAt(pt, target) {
    const k1 = Math.max(this.minScale, Math.min(this.maxScale, target));
    if (k1 === this.k) return;
    const r = this.wrap.getBoundingClientRect();
    const f = 1 - k1 / this.k;
    this.tx += (pt.x - r.left) * f;
    this.ty += (pt.y - r.top) * f;
    this.k = k1;
    this.apply();
    this.clamp();
  }

  /** Multiply the current scale by `factor` about a screen point (default centre). */
  zoomBy(factor, pt) {
    pt = pt || this._centre();
    this.zoomAt(pt, this.k * factor);
  }

  /** Pan by a screen-px delta. */
  panBy(dx, dy) {
    this.tx += dx; this.ty += dy;
    this.apply();
    this.clamp();
  }

  /** Keep the map reachable: it may be panned until an edge/corner reaches the
   *  viewport centre, but never pulled entirely past centre — so any edge can sit at
   *  the middle of the screen while the map never fully leaves the viewport. (A map
   *  smaller than the viewport must straddle the centre line, which is the same rule.) */
  clamp() {
    const r = this.wrap.getBoundingClientRect();
    const c = this.container.getBoundingClientRect();
    const cx = c.left + c.width / 2, cy = c.top + c.height / 2;
    let dx = 0, dy = 0;
    if (r.left > cx) dx = cx - r.left;          // left edge no further right than centre
    else if (r.right < cx) dx = cx - r.right;    // right edge no further left than centre
    if (r.top > cy) dy = cy - r.top;
    else if (r.bottom < cy) dy = cy - r.bottom;
    if (dx || dy) { this.tx += dx; this.ty += dy; this.apply(); }
  }

  /** Viewport resized (window/layout): keep the scale floor and re-clamp. */
  onResize() {
    if (!this.wrap || !this.container) return;
    const w = this.wrap.getBoundingClientRect();
    const c = this.container.getBoundingClientRect();
    if (!w.width || !c.width) return;
    // Recompute the fit floor against the new viewport (w is post-transform, so
    // divide back out the current scale to recover the layout size).
    const fit = Math.min(c.width / (w.width / this.k), c.height / (w.height / this.k));
    this._setRange(fit);
    if (this.k < this.minScale) this.k = this.minScale;
    this.apply();
    this.clamp();
  }

  _centre() {
    const c = this.container.getBoundingClientRect();
    return { x: c.left + c.width / 2, y: c.top + c.height / 2 };
  }
}
