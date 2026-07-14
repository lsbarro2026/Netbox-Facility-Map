'use strict';
/* grid.js — shared snapping grid. One instance lives on App, so the toggle and
   origin persist across navigation. Units are intrinsic image px, giving square,
   resolution-independent cells. The cell size is persisted per scope (each floor,
   and the siteplan, remembers its own) via localStorage, so each is restored the
   next time that view is opened. Editors call setScope() in their show(). */

const GRID_STEP_PREFIX = 'facilitymap:gridStep:';
const GRID_STEP_MIN = 4, GRID_STEP_MAX = 120, GRID_STEP_DEFAULT = 25;

class GridController {
  constructor() {
    this.on = true;             // draw + snap to grid
    this.scope = null;          // localStorage key suffix (floor key or 'siteplan')
    this._step = GRID_STEP_DEFAULT; // cell size, intrinsic image px; real value loaded on setScope
    this.ox = 0;                // origin offset x, intrinsic image px
    this.oy = 0;                // origin offset y, intrinsic image px
    this.adjust = false;        // move/resize interaction mode
  }

  /** Point the grid at a scope (a floor key or the siteplan) and load that
      scope's saved cell size, falling back to the default. */
  setScope(key) {
    this.scope = key;
    this._step = this.loadStep();
  }

  /** Cell size in intrinsic image px. Writing it persists for the current scope. */
  get step() { return this._step; }
  set step(v) {
    this._step = v;
    if (!this.scope) return;
    try { localStorage.setItem(GRID_STEP_PREFIX + this.scope, String(v)); }
    catch (e) { console.warn('grid: could not persist cell size', e); }
  }

  /** Read the current scope's saved cell size, validated to the clamp range. */
  loadStep() {
    let v;
    if (this.scope) {
      try { v = Number(localStorage.getItem(GRID_STEP_PREFIX + this.scope)); }
      catch (e) { console.warn('grid: could not read saved cell size', e); }
    }
    return Number.isFinite(v) && v >= GRID_STEP_MIN && v <= GRID_STEP_MAX ? v : GRID_STEP_DEFAULT;
  }

  /** Snap a value (intrinsic image px) to the nearest grid line given an offset. */
  snap(v, offset) {
    return Math.round((v - offset) / this.step) * this.step + offset;
  }

  /** Append offset-aware grid lines to an svg. dims = [iw, ih] intrinsic px. */
  draw(s, W, H, dims) {
    if (!this.on) return;
    const [iw, ih] = dims, g = this.step;
    for (let x = this.ox % g; x < iw; x += g) {
      if (x < 0) continue;
      const dx = x / iw * W;
      s.append(Dom.svg('line', { x1: dx, y1: 0, x2: dx, y2: H, class: 'grid-line' }));
    }
    for (let y = this.oy % g; y < ih; y += g) {
      if (y < 0) continue;
      const dy = y / ih * H;
      s.append(Dom.svg('line', { x1: 0, y1: dy, x2: W, y2: dy, class: 'grid-line' }));
    }
  }

  /** Resize the grid by a wheel step, clamped. */
  resize(deltaY) {
    this.step = Math.max(GRID_STEP_MIN, Math.min(GRID_STEP_MAX, this.step + (deltaY < 0 ? 1 : -1)));
  }
}
