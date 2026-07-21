'use strict';
/* lib.js — framework-free foundations shared by every module.
   Pure static helper classes (no instances, no state). Loaded first. */

const SVGNS = 'http://www.w3.org/2000/svg';
const CLOSE_PX = 12;   // click-near-first-vertex threshold (displayed px) to close a polygon
const SNAP_PX = 11;    // snap radius (displayed px) for vertices/edges
const ORTHO_DEG = 6;   // angular tolerance (degrees from an axis) for right-angle node snap
const RECT_MIN_PX = 6; // min side (displayed px) for the rectangle tool, so a click-without-drag makes nothing
const EDGE_GRAB_PX = 8; // grab band (displayed px, /scale) to drag a whole polygon edge (both endpoints)
const ANGLE_STEP = 15; // label rotation snaps to this many degrees (Alt to free-rotate)
const LABEL_SIZE_MIN = 6, LABEL_SIZE_MAX = 120;   // label font-size clamp (px)
// Below this map scale the legibility floor has blown labels up enough that they'd pile into an
// unreadable carpet, so the editor culls them (`.labels-lod`); they return as you zoom in (READ-2).
// Absolute (not fit-relative) by design: a small floor never zooms out this far so its labels never
// cull, while a large floor opens below it and shows the plan as a clean overview. Tied to the
// on-screen density, not "am I at the fit view" — the fit scale itself carries no overlap signal.
const LABEL_LOD_SCALE = 0.35;
// Font choices for a label — bundled fonts (Public Sans, IBM Plex Mono) plus generic
// families that use OS fonts, so everything stays offline (no CDN). `css` is the
// value written to labelStyle.font and applied inline; `name` is the dropdown label.
const LABEL_FONTS = [
  { name: 'Public Sans', css: "'Public Sans', sans-serif" },
  { name: 'IBM Plex Mono', css: "'IBM Plex Mono', monospace" },
  { name: 'Sans-serif', css: 'sans-serif' },
  { name: 'Serif', css: 'serif' },
  { name: 'Monospace', css: 'monospace' },
];
// Route arrows (FloorEditor wayfinding): palette of theme colours as literal hex
// (so they can drive an SVG stroke/fill attribute directly); first is the default.
const ARROW_COLORS = ['#066fd1', '#2fa84f', '#e0a93d', '#e0533d'];
// Arrowhead size in LAYOUT px. It scales with the map under zoom (like a room
// fill) rather than counter-scaling — pan/zoom never re-renders, so a JS size
// divided by the zoom scale would be stale (see ARCHITECTURE §6).
const ARROW_HEAD_PX = 15;

/** Small id / key helpers. */
class Util {
  static uid() { return 'r' + Math.random().toString(36).slice(2, 9); }
  static floorKey(dir, fid) { return dir + '/' + fid; }
  static isNumbered(dir) { return /^\d\d-/.test(dir || ''); }
  static code(dir) { return Util.isNumbered(dir) ? dir.slice(0, 2) : dir; }
}

/** DOM construction helpers. */
class Dom {
  static $(sel, root = document) { return root.querySelector(sel); }

  /** el('div', {class, html, onclick, ...attrs}, child|[children]) */
  static el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    for (const c of [].concat(children)) if (c) n.append(c);
    return n;
  }

  /** SVG element with attributes. */
  static svg(tag, attrs = {}) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
}

/** Inline SVG glyphs for toolbar buttons and chrome. Each glyph is drawn with
 *  `currentColor`, so a button's text colour (idle, .active, .primary) recolours
 *  the icon to match.
 *
 *  Glyphs come from the Lucide icon set (ISC-licensed), vendored offline under
 *  `icons/` — see `icons/NOTICE` for the getter→source-file map and `icons/LICENSE`
 *  for the attribution. The path bodies below are inlined verbatim from those files
 *  (so no runtime fetch is needed), which is why `_ico` uses Lucide's native
 *  24×24 viewBox and its round-cap, stroke-width-2 convention. Rendered size is set
 *  by the `.ico` CSS / the `size` arg, not the viewBox. */
class Icons {
  static _ico(body, size = 13) {
    return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" `
      + `fill="none" stroke="currentColor" stroke-width="2" `
      + `stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  }
  static get edit() { return Icons._ico('<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>'); }
  static get draw() { return Icons._ico('<path d="M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z"/><path d="m18 13-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18"/><path d="m2.3 2.3 7.286 7.286"/><circle cx="11" cy="11" r="2"/>'); }
  static get rect() { return Icons._ico('<rect width="18" height="18" x="3" y="3" rx="2"/>'); }
  static get undo() { return Icons._ico('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>'); }
  static get snap() { return Icons._ico('<path d="m12 15 4 4"/><path d="M2.352 10.648a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l6.029-6.029a1 1 0 1 1 3 3l-6.029 6.029a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l6.365-6.367A1 1 0 0 0 8.716 4.282z"/><path d="m5 8 4 4"/>'); }
  static get grid() { return Icons._ico('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>'); }
  static get move() { return Icons._ico('<path d="M12 2v20"/><path d="m15 19-3 3-3-3"/><path d="m19 9 3 3-3 3"/><path d="M2 12h20"/><path d="m5 9-3 3 3 3"/><path d="m9 5 3-3 3 3"/>'); }
  // layout-grid: four separate tiles in a 2×2 — reads as "sheets arranged into grid cells",
  // distinct from `grid` (one subdivided rect) and `move` (crosshair); the Arrange-sheets toggle.
  static get arrange() { return Icons._ico('<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>'); }
  static get dup() { return Icons._ico('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'); }
  static get plus() { return Icons._ico('<path d="M5 12h14"/><path d="M12 5v14"/>'); }
  static get check() { return Icons._ico('<path d="M20 6 9 17l-5-5"/>', 12); }
  // server: stacked rack units — the closest Lucide fit for the rack-placement tool.
  static get rack() { return Icons._ico('<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>'); }
  static get settings() { return Icons._ico('<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>'); }
  // panel-right: a framed panel with its right column split off — reads as "the right-hand
  // side panel", the siteplan buildings-index show/hide toggle (NAV-8).
  static get panelRight() { return Icons._ico('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>'); }
  // triangle-right: a right-angled triangle — the 90°-corner node-snap toggle.
  static get rightangle() { return Icons._ico('<path d="M22 18a2 2 0 0 1-2 2H3c-1.1 0-1.3-.6-.4-1.3L20.4 4.3c.9-.7 1.6-.4 1.6.7Z"/>'); }
  static get arrow() { return Icons._ico('<path d="M7 7h10v10"/><path d="M7 17 17 7"/>'); }
  // type: a capital-T text cursor — the free-standing text-note tool (floor editor).
  static get note() { return Icons._ico('<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>'); }
  static get layers() { return Icons._ico('<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>'); }
  static get link() { return Icons._ico('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'); }
  static get download() { return Icons._ico('<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>'); }
  static get print() { return Icons._ico('<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="14" width="12" height="8" rx="1"/>'); }
  static get info() { return Icons._ico('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'); }
  static get sliders() { return Icons._ico('<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>'); }
  // chevron-right: the to-do panel's Completed-group caret; CSS rotates it when open.
  static get chevron() { return Icons._ico('<path d="m9 18 6-6-6-6"/>', 12); }
  // list-todo: the floor to-do panel's header glyph (ADDON-1).
  static get todo() { return Icons._ico('<rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>'); }
  // wifi: Lucide's own wifi glyph — the access-point placement tool icon (DEV-1).
  static get wifi() { return Icons._ico('<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.859a10 10 0 0 1 14 0"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/>'); }
}

/** Pure geometry helpers (normalized or pixel space, caller-consistent). */
class Geom {
  static centroid(poly) {
    let x = 0, y = 0;
    for (const p of poly) { x += p[0]; y += p[1]; }
    return [x / poly.length, y / poly.length];
  }

  /** Axis-aligned bounding box of a polygon; verts and result in caller's space. */
  static bounds(poly) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of poly) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY,
             cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }

  /** Clamp a normalized focus rect to the canvas. A target near a floor edge simply loses the
   *  padding that ran off the side, so the view lands asymmetric — that is correct, not a bug to
   *  "fix" by letting coordinates leave 0..1. */
  static clampRegion(nx0, ny0, nx1, ny1) {
    return [Math.max(0, nx0), Math.max(0, ny0), Math.min(1, nx1), Math.min(1, ny1)];
  }

  /** The normalized rect framing a room's polygon, padded so the room opens inside a slab of
   *  surrounding floor rather than filling the viewport edge-to-edge. The pad applies to each
   *  side, so the framed region is ~3.4× the room's larger dimension; the constant term keeps a
   *  tiny room from being framed barely larger than itself. `PanZoom.fitRegion` floors the scale at
   *  the whole-wrap fit, so a wide region can never zoom out past the whole floor.
   *
   *  The single source of the focus padding — the `#/r/` deep-link
   *  (`FloorEditor._roomFocusRegion`, the to-do page's door) and the wayfinding search jump
   *  (`SiteplanEditor._gotoTarget`) are two doors onto the same setFocus → fitRegion landing and
   *  must frame a target identically. Change the margin here, never at a call site. */
  static focusRegion(poly) {
    const b = Geom.bounds(poly);
    const pad = Math.max(b.w, b.h) * 1.2 + 0.05;
    return Geom.clampRegion(b.minX - pad, b.minY - pad, b.maxX + pad, b.maxY + pad);
  }

  /** The normalized rect framing a rack/device placement marker — focusRegion's analogue for a
   *  target that is a point, not a polygon. `r` is tuned so a placement lands at about the same
   *  zoom as a small room does through focusRegion; same lockstep rule applies. */
  static pointRegion(x, y, r = 0.14) {
    return Geom.clampRegion(x - r, y - r, x + r, y + r);
  }

  /** Nearest point on segment a-b to p; all args in displayed px. */
  static projSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx, qy = ay + t * dy;
    return { x: qx, y: qy, d: Math.hypot(px - qx, py - qy) };
  }

  /** Ray-casting point-in-polygon; point and poly in the same (normalized) space. */
  static pointInPoly(nx, ny, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > ny) !== (yj > ny)) && (nx < (xj - xi) * (ny - yi) / (yj - yi) + xi))
        inside = !inside;
    }
    return inside;
  }

  /** Triangle for an arrowhead pointing from a→b (tip at b), in the caller's
   *  coordinate space. `sizePx` is the tip-to-base length; the base half-width is
   *  ~0.55× that. Returns [tip, baseLeft, baseRight]; a zero-length a→b degrades to
   *  a horizontal head rather than NaN. */
  static arrowHead(ax, ay, bx, by, sizePx) {
    let dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const cx = bx - dx * sizePx, cy = by - dy * sizePx;   // base centre, behind the tip
    const px = -dy, py = dx, half = sizePx * 0.55;         // unit perpendicular
    return [[bx, by], [cx + px * half, cy + py * half], [cx - px * half, cy - py * half]];
  }

  /** Keep a point inside a polygon: inside → unchanged, else nearest edge point. */
  static clampToPoly(nx, ny, poly) {
    if (Geom.pointInPoly(nx, ny, poly)) return [nx, ny];
    let best = Infinity, bx = nx, by = ny;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const pr = Geom.projSeg(nx, ny, a[0], a[1], b[0], b[1]);
      if (pr.d < best) { best = pr.d; bx = pr.x; by = pr.y; }
    }
    return [bx, by];
  }

  /** Signed distance from a point to `poly`'s boundary — **positive inside**, negative outside;
   *  point and poly in the same space. Read as a field over the shape it answers "how big a disc
   *  can sit here before it touches a wall", which is what `poleOfInaccessibility` maximizes. */
  static polyDist(x, y, poly) {
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const d = Geom.projSeg(x, y, a[0], a[1], b[0], b[1]).d;
      if (d < best) best = d;
    }
    return Geom.pointInPoly(x, y, poly) ? best : -best;
  }

  /** Signed distance from a point to the axis-aligned rect `r` (`{x0,y0,x1,y1}`) — **negative
   *  inside**, matching `polyDist`'s convention in the opposite direction, so the two compose
   *  under `Math.min` into one field where an obstacle reads exactly like a wall. */
  static rectDist(x, y, r) {
    const dx = Math.max(r.x0 - x, 0, x - r.x1), dy = Math.max(r.y0 - y, 0, y - r.y1);
    if (dx || dy) return Math.hypot(dx, dy);
    return -Math.min(x - r.x0, r.x1 - x, y - r.y0, r.y1 - y);   // inside → nearest side, negated
  }

  /** How large a disc centred at the point can grow before it crosses a wall of `poly` or enters
   *  any of the `obstacles` rects; negative outside the polygon or inside an obstacle. One field
   *  over walls **and** obstacles, so a caller never needs a separate pass/fail obstacle test:
   *  `clearance(p) >= radius` IS "this disc fits here, clear of everything". */
  static clearance(x, y, poly, obstacles = []) {
    let d = Geom.polyDist(x, y, poly);
    for (const r of obstacles) d = Math.min(d, Geom.rectDist(x, y, r));
    return d;
  }

  /** **Pole of inaccessibility** — the interior point furthest from every wall of `poly` and from
   *  every rect in `obstacles`: the centre of the largest disc the shape can host. Returns
   *  `{x, y, r}`, `r` being that disc's radius. Unlike a centroid it is always inside the shape
   *  and genuinely central to it, so an L, a corridor and a donut all get a sensible point — and
   *  `r` reports how much room there actually is, letting a caller size to the shape instead of
   *  guessing and retrying.
   *
   *  A hand port of Mapbox's `polylabel` (ISC) — the frontend is vanilla JS with no build step, so
   *  it cannot be a dependency. Cover the bbox in square cells; hold them in a max-heap keyed by
   *  each cell's **upper bound** on the clearance anywhere within it (`d + half·√2` — no point of
   *  a cell is further than its half-diagonal from the centre); repeatedly split the most
   *  promising cell into quarters. A cell whose bound cannot beat the best point already found is
   *  dropped whole, which is both why this beats a fine grid scan and why the answer is provably
   *  within `precision` of the true optimum rather than the best of an arbitrary sample. The one
   *  deviation from the original: cells are scored by `Geom.clearance`, so obstacles live in the
   *  same field as the walls.
   *
   *  Deterministic — same polygon + same obstacles always yields the same point. */
  static poleOfInaccessibility(poly, obstacles = [], precision = 0.5) {
    const b = Geom.bounds(poly);
    const cell = Math.min(b.w, b.h);
    if (!cell) return { x: b.minX, y: b.minY, r: 0 };   // degenerate (zero-area) ring
    const at = (x, y, half) => {
      const d = Geom.clearance(x, y, poly, obstacles);
      return { x, y, half, d, max: d + half * Math.SQRT2 };
    };

    const heap = [], half = cell / 2;
    for (let x = b.minX; x < b.maxX; x += cell)
      for (let y = b.minY; y < b.maxY; y += cell)
        Geom._heapPush(heap, at(x + half, y + half, half));

    let best = at(b.cx, b.cy, 0);   // a seed to prune against, so cell one can already be dropped
    while (heap.length) {
      const c = Geom._heapPop(heap);
      if (c.d > best.d) best = c;
      if (c.max - best.d <= precision) continue;   // nothing meaningfully better hides in this cell
      const q = c.half / 2;
      Geom._heapPush(heap, at(c.x - q, c.y - q, q));
      Geom._heapPush(heap, at(c.x + q, c.y - q, q));
      Geom._heapPush(heap, at(c.x - q, c.y + q, q));
      Geom._heapPush(heap, at(c.x + q, c.y + q, q));
    }
    return { x: best.x, y: best.y, r: best.d };
  }

  /** Binary max-heap over `.max`, the cell queue `poleOfInaccessibility` needs. Scanning an array
   *  for the best cell instead would make that search quadratic in the cell count — thousands on a
   *  large room, and it runs on every room hover. */
  static _heapPush(heap, item) {
    heap.push(item);
    for (let i = heap.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (heap[parent].max >= heap[i].max) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  }

  static _heapPop(heap) {
    const top = heap[0], last = heap.pop();
    if (!heap.length) return top;
    heap[0] = last;
    for (let i = 0;;) {
      const l = 2 * i + 1, r = l + 1;
      let big = i;
      if (l < heap.length && heap[l].max > heap[big].max) big = l;
      if (r < heap.length && heap[r].max > heap[big].max) big = r;
      if (big === i) return top;
      [heap[big], heap[i]] = [heap[i], heap[big]];
      i = big;
    }
  }

  /** Decompose a self-touching "keyhole" ring into its outer + interior-void contours.
   *  A room enclosing a void (courtyard / passthrough) is drawn as a single ring: the outer
   *  boundary, a slit cutting inward, a loop around the void, then a cut back out along the
   *  *same* slit — so a pair of walls lie on top of each other. Those coincident "bridge" edges
   *  are detected (direction-agnostic, within `tol` normalized units) and removed; each maximal
   *  run of surviving edges is one closed contour (its arc ends coincide, since the bridge closed
   *  it), so a keyhole ring splits into [outer, void]. A plain ring (no coincident pair) returns
   *  `[ring]` — the SAME array reference, so callers reproduce today's single-polygon output
   *  exactly. Fed to the fill (evenodd over the raw ring makes the void empty) and, in view mode,
   *  the per-contour outline (so the doubled seam vanishes instead of stabbing into the void). */
  static splitBridges(ring, tol = 1e-4) {
    const n = ring.length;
    if (n < 6) return [ring];   // need outer(≥3)+void(≥3) joined by a bridge; skips plain rooms
    const near = (p, q) => Math.abs(p[0] - q[0]) <= tol && Math.abs(p[1] - q[1]) <= tol;
    // Bridge = the edge indices whose segment coincides with another edge of the same ring.
    // The retraced slit runs opposite (a1≈b2 && a2≈b1); a same-direction match is degenerate
    // but folded in for safety. Edge i is ring[i]→ring[(i+1)%n].
    const bridge = new Set();
    for (let i = 0; i < n; i++) {
      const a1 = ring[i], a2 = ring[(i + 1) % n];
      for (let j = i + 1; j < n; j++) {
        const b1 = ring[j], b2 = ring[(j + 1) % n];
        if ((near(a1, b2) && near(a2, b1)) || (near(a1, b1) && near(a2, b2))) {
          bridge.add(i); bridge.add(j);
        }
      }
    }
    if (!bridge.size) return [ring];
    // Rotate to a vertex that begins a fresh contour (its incoming edge is a bridge), so the
    // walk below never straddles the wrap point mid-contour.
    let start = -1;
    for (let k = 0; k < n; k++) { if (bridge.has((k - 1 + n) % n)) { start = k; break; } }
    if (start < 0) return [ring];
    const contours = [];
    let cur = [];
    for (let s = 0; s < n; s++) {
      const i = (start + s) % n;   // edge from ring[i] to ring[i+1]
      if (bridge.has(i)) {         // a slit edge closes the current contour and is dropped
        if (cur.length >= 3) contours.push(cur);
        cur = [];
        continue;
      }
      if (!cur.length) cur.push(ring[i]);
      cur.push(ring[(i + 1) % n]);
    }
    if (cur.length >= 3) contours.push(cur);
    // Each contour's first/last vertex are the two coincident ends of its arc — drop the
    // duplicate so it's a clean implicitly-closed ring.
    for (const c of contours) if (c.length > 3 && near(c[0], c[c.length - 1])) c.pop();
    return contours.length ? contours : [ring];
  }

  /** Absolute area of a normalized 0..1 polygon `poly` ([[x,y],...]) via the shoelace formula.
   *  Direction-agnostic (`abs`), so it's a pure size measure — used only to pick the *smaller* of
   *  two rooms when deciding which one's area gets punched out of the other (`containedMap`). */
  static polyArea(poly) {
    const n = poly.length;
    if (n < 3) return 0;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % n];
      acc += x1 * y2 - x2 * y1;
    }
    return Math.abs(acc) / 2;
  }

  /** Build an SVG path `d` from one or more normalized 0..1 `rings`, scaled by `w`×`h`.
   *  Each ring becomes a closed subpath (`M x,y L x,y … Z`); concatenated subpaths render under
   *  `fill-rule="evenodd"` as an outer contour with the rest punched out — the idiom the keyhole
   *  fill uses (evenodd over a self-touching ring empties the void), reused so a larger room's
   *  fill excludes any contained smaller room (`containedMap`). A single ring yields a plain
   *  closed path (evenodd ≡ nonzero for one contour), so an un-holed room renders exactly as the
   *  old `<polygon>` did. Rings with < 3 points are skipped; '' when none qualify. Mirrors the
   *  server-side `previews.evenodd_path`. */
  static evenoddPath(rings, w, h) {
    const subs = [];
    for (const ring of rings) {
      if (!ring || ring.length < 3) continue;
      const pts = ring.map(([x, y]) => `${x * w},${y * h}`);
      subs.push('M' + pts[0] + ' L' + pts.slice(1).join(' ') + ' Z');
    }
    return subs.join(' ');
  }

  /** Map each room's `id` → the rings of its **directly** contained smaller rooms, so a larger
   *  room's fill can punch those areas out (via an evenodd `<path>`) instead of double-painting
   *  over them. A render-time, derived relationship — stacking isn't modelled and stored geometry
   *  is untouched; recomputed each render from the other rooms' polygons. Mirrors the server-side
   *  `previews.contained_map` (which the NetBox embeds use), keyed here by the frontend `room.id`.
   *
   *  Containment is **strict**: strictly-smaller area **and** every vertex inside (with a bbox
   *  pre-check), so a room straddling another's boundary is out of scope (partial overlap would
   *  need true polygon clipping). Only **direct** children are returned — a room contained in `A`
   *  but also in another room itself inside `A` is punched out at that intermediate level, keeping
   *  the evenodd parity correct at any nesting depth. `rooms` is any iterable exposing `.id` and
   *  `.polygon` ([[nx,ny],...] 0..1). */
  static containedMap(rooms) {
    // Precompute each room's ring, area and bbox once (O(n·v)); the containment scan is then O(n²).
    const entries = [];
    for (const room of rooms) {
      const ring = room.polygon || [];
      if (ring.length < 3) continue;
      entries.push({ id: room.id, ring, area: Geom.polyArea(ring), b: Geom.bounds(ring) });
    }
    const n = entries.length;
    const isContained = (inner, outer) => {
      if (inner === outer || inner.area >= outer.area) return false;
      if (inner.b.minX < outer.b.minX || inner.b.minY < outer.b.minY
        || inner.b.maxX > outer.b.maxX || inner.b.maxY > outer.b.maxY) return false;
      return inner.ring.every(([x, y]) => Geom.pointInPoly(x, y, outer.ring));
    };
    // contains[i] = indices of the rooms strictly inside entries[i] (all descendants, any depth).
    const contains = entries.map(outer =>
      new Set(entries.map((inner, j) => (isContained(inner, outer) ? j : -1)).filter(j => j >= 0)));
    const result = new Map();
    for (let i = 0; i < n; i++) {
      const children = [...contains[i]];
      // Keep only direct children: drop a descendant `j` that another child `k` of `i` also
      // contains (so `j` is punched out by `k`, one level down, not by `i`).
      const direct = children.filter(j => !children.some(k => k !== j && contains[k].has(j)));
      if (direct.length) result.set(entries[i].id, direct.map(j => entries[j].ring));
    }
    return result;
  }
}

/** Transient bottom-screen notification. */
class Toast {
  static _timer = null;
  static show(msg, err = false) {
    const t = Dom.$('#toast');
    t.textContent = msg;
    t.className = 'show' + (err ? ' err' : '');
    clearTimeout(Toast._timer);
    Toast._timer = setTimeout(() => { t.className = ''; }, 2200);
  }
}

/** Hover/focus tooltip positioner. A trigger (`.fm-info`, focusable) contains one
 *  `.fm-tooltip[role=tooltip]`; on show we measure both and place the bubble with
 *  `position: fixed` so it escapes any `overflow` scroll container (e.g. `#stage`),
 *  flipping above↔below to stay in the viewport and clamping horizontally. Pure static —
 *  no instances, no class state (the per-trigger `suppressed` flag lives in the attach
 *  closure); call `Tooltip.attach(trigger)` once after building the trigger. */
class Tooltip {
  static GAP = 8;      // px between the trigger and the bubble
  static MARGIN = 8;   // min px kept clear of a viewport edge

  /** Wire hover/focus reveal + Escape-dismiss on one `.fm-info` trigger. No-op if it holds
   *  no `.fm-tooltip` (fail gracefully client-side). */
  static attach(trigger) {
    const tip = Dom.$('.fm-tooltip', trigger);
    if (!tip) return;
    let suppressed = false;   // Escape hides until the pointer/focus leaves and returns
    const show = () => { if (!suppressed) Tooltip._place(trigger, tip); };
    const hide = () => tip.classList.remove('show');
    trigger.addEventListener('mouseenter', () => { suppressed = false; show(); });
    trigger.addEventListener('mouseleave', () => { suppressed = false; hide(); });
    trigger.addEventListener('focus', show);
    trigger.addEventListener('blur', () => { suppressed = false; hide(); });
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && tip.classList.contains('show')) {
        suppressed = true; hide(); e.stopPropagation();   // dismiss but keep focus (ARIA APG)
      }
    });
  }

  /** Position `tip` over `trigger` and reveal it. Coordinates are computed while the bubble is
   *  still `visibility:hidden` (it still has a layout box, so `getBoundingClientRect` is valid),
   *  then `.show` reveals it at the final spot — no first-frame flash. */
  static _place(trigger, tip) {
    const t = trigger.getBoundingClientRect();
    const b = tip.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const cx = t.left + t.width / 2;
    // Prefer above; flip below when placing above would clip the top edge.
    const above = t.top - Tooltip.GAP - b.height >= Tooltip.MARGIN;
    const top = above ? t.top - Tooltip.GAP - b.height : t.bottom + Tooltip.GAP;
    tip.classList.toggle('below', !above);
    // Centre over the trigger, clamped inside the viewport.
    const left = Math.max(Tooltip.MARGIN, Math.min(cx - b.width / 2, vw - Tooltip.MARGIN - b.width));
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(top) + 'px';
    tip.style.setProperty('--arrow-x', Math.round(cx - left) + 'px');   // arrow tracks the icon
    tip.classList.add('show');
  }
}

/** A searchable single-select (combobox): a text input that queries as you type and a popup list
 *  of matches. The framework-free answer to a `<select>` that can't work — a NetBox install's
 *  device-role/device-type lists are unbounded, so the options must be fetched per keystroke rather
 *  than rendered up front.
 *
 *  Lives here, beside the other shared primitives, because a second, unrelated caller is coming:
 *  today the Settings page's access-point role picker (DEV-3), and next the floor editor's
 *  device-type picker (DEV-1). `lib.js` is eagerly loaded, so the lazily-bundled floor editor can
 *  rely on it (§10).
 *
 *  Options are `{id, name}` objects; `value` is one of them or null. Construct it, append `.el`:
 *
 *      const combo = new Combo({
 *        value: app.apDeviceRole,                 // {id,name} | null
 *        load: (q) => netbox.deviceRoles(q).then(r => r.roles),
 *        onPick: (opt) => this._saveRole(opt),    // may return a Promise
 *      });
 *
 *  `onPick` follows the same **revert contract** as the Settings page's `_select`/`_switch`: it may
 *  return a Promise, and a rejection rolls the control back to its previous value, so a failed save
 *  never leaves the UI showing something the server didn't accept. A rejection carrying a message is
 *  toasted; an empty-message rejection (a user who cancelled a confirm) reverts silently. */
class Combo {
  static DEBOUNCE_MS = 180;   // keystroke → query delay; a burst of typing costs one request

  constructor({ value = null, placeholder = 'Search…', load, onPick, allowClear = true }) {
    this.value = value;
    this.load = load;
    this.onPick = onPick;
    this.options = [];
    this.active = -1;    // keyboard-highlighted row, -1 = none
    this._timer = null;
    this._seq = 0;       // request generation — a slow reply from an older query is dropped
    this.input = Dom.el('input', {
      class: 'fm-combo-input', placeholder, autocomplete: 'off',
      role: 'combobox', 'aria-expanded': 'false', 'aria-autocomplete': 'list',
    });
    this.input.value = value ? value.name : '';
    this.list = Dom.el('div', { class: 'fm-combo-list', role: 'listbox' });
    this.clear = Dom.el('button', { class: 'fm-combo-clear', title: 'Clear', tabindex: '-1' }, '✕');
    this.el = Dom.el('div', { class: 'fm-combo' },
      allowClear ? [this.input, this.clear, this.list] : [this.input, this.list]);
    this.clear.style.display = value && allowClear ? '' : 'none';
    this._bind(allowClear);
  }

  _bind(allowClear) {
    this.input.addEventListener('input', () => this._schedule(this.input.value));
    // Opening on focus shows the unfiltered list, so the control is discoverable by clicking —
    // a user who doesn't know what to type still sees what's on offer.
    this.input.addEventListener('focus', () => this._schedule('', 0));
    this.input.addEventListener('keydown', (e) => this._key(e));
    // Close on blur and restore the input text to the committed value: a half-typed query the user
    // clicked away from is not a selection, and leaving it in the box would imply it was.
    this.input.addEventListener('blur', () => { this._close(); this._syncText(); });
    // Keep the press from blurring the input before `click` lands — the blur handler would close
    // the list out from under the pointer and the pick would never fire.
    this.list.addEventListener('mousedown', (e) => e.preventDefault());
    if (allowClear) this.clear.onclick = () => { this._pick(null); this.input.focus(); };
  }

  /** Debounced query. `delay = 0` runs on the next tick (the focus-open path, where the user is
   *  waiting on a list, not still typing). */
  _schedule(q, delay = Combo.DEBOUNCE_MS) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._query(q), delay);
  }

  async _query(q) {
    const seq = ++this._seq;
    let options;
    try {
      options = await this.load(q);
    } catch (e) {
      // Degrade gracefully client-side: an empty list + a toast beats a dead control.
      if (seq === this._seq) { this.options = []; this._render(); Toast.show('Search failed: ' + e.message, true); }
      return;
    }
    if (seq !== this._seq) return;   // a newer keystroke already fired; this reply is stale
    this.options = options || [];
    this.active = -1;
    this._render();
  }

  _render() {
    this.list.textContent = '';
    if (!this.options.length) {
      this.list.append(Dom.el('div', { class: 'fm-combo-empty' }, 'No matches'));
    }
    this.options.forEach((opt, i) => {
      const row = Dom.el('div', {
        class: 'fm-combo-opt' + (i === this.active ? ' active' : '')
          + (this.value && this.value.id === opt.id ? ' picked' : ''),
        role: 'option', 'aria-selected': String(!!(this.value && this.value.id === opt.id)),
      }, opt.name);
      row.onclick = () => this._pick(opt);
      this.list.append(row);
    });
    this.list.classList.add('open');
    this.input.setAttribute('aria-expanded', 'true');
  }

  _close() {
    clearTimeout(this._timer);
    this._seq++;   // invalidate any in-flight query, so it can't re-open the list after we closed
    this.list.classList.remove('open');
    this.input.setAttribute('aria-expanded', 'false');
  }

  _syncText() { this.input.value = this.value ? this.value.name : ''; }

  /** Drop the committed value and empty the input, **without** firing `onPick`.
   *
   *  For a **multi-select host**: a picker that consumes each pick into its own chip list (the
   *  to-do assignee field, TASK-3) wants the box empty and ready for the next name, not showing the
   *  last one as though it were still the control's value. `onPick` is deliberately not re-fired —
   *  the host already handled the pick, and a clear here means "consumed", not "cleared to null",
   *  which for a single-select host is a real edit worth saving. */
  reset() {
    this.value = null;
    this._syncText();
    this.clear.style.display = 'none';
  }

  /** Make the control inoperable (or operable again) — the composite equivalent of a native input's
   *  `.disabled`, which a host can't set on `el` because that is the wrapper, not a form control.
   *  Used by a host whose precondition for the setting isn't met yet (the Settings page's write
   *  add-ons behind write mode, SET-5).
   *
   *  Disabling **closes an open list**: the disable may arrive while the user has one dropped down,
   *  and a list left open over a dead input would still commit picks. The committed value and the
   *  clear button's value-driven visibility are untouched — this is presentational, so re-enabling
   *  restores exactly what was there. */
  setDisabled(disabled) {
    this.input.disabled = disabled;
    this.clear.disabled = disabled;
    if (disabled) { this._close(); this._syncText(); }
  }

  _key(e) {
    const open = this.list.classList.contains('open');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return this._schedule(this.input.value, 0);
      if (!this.options.length) return;   // nothing to highlight; leave `active` at -1
      const d = e.key === 'ArrowDown' ? 1 : -1;
      this.active = (this.active + d + this.options.length) % this.options.length;
      this._render();
    } else if (e.key === 'Enter') {
      // `active < 0` covers the empty list too, so Enter over "No matches" can never commit an
      // undefined option — which would read as a *clear*, silently wiping a configured value.
      if (!open || this.active < 0) return;
      e.preventDefault();   // don't submit a surrounding form / trigger a sibling default
      this._pick(this.options[this.active]);
    } else if (e.key === 'Escape') {
      if (!open) return;
      e.stopPropagation();   // dismiss the list only — don't also close a host modal (ARIA APG)
      this._close(); this._syncText();
    }
  }

  /** Commit a pick (`null` clears). Applies optimistically, then rolls back if `onPick` rejects —
   *  the `_select`/`_switch` revert contract. */
  _pick(opt) {
    const prev = this.value;
    this.value = opt;
    this._syncText();
    this._close();
    this.clear.style.display = opt ? '' : 'none';
    Promise.resolve(this.onPick(opt)).catch((e) => {
      this.value = prev;
      this._syncText();
      this.clear.style.display = prev ? '' : 'none';
      if (e && e.message) Toast.show('Could not save setting: ' + e.message, true);
    });
  }
}

/** Thin fetch wrapper. Throws on non-2xx so callers can try/catch.
 *  Mount-aware: when running inside NetBox (`window.MAP` injected by the template),
 *  logical `/api/*` paths are rebased onto the plugin's API mount and POSTs carry the
 *  session CSRF token. Standalone (`window.MAP` absent) it is a no-op passthrough. */
class Api {
  /** Rebase a logical `/api/<rest>` path onto window.MAP.api; pass everything else
   *  (absolute static URLs, full URLs) through unchanged. When a non-default facility is active
   *  (`Api.facility`, set by App), the per-facility endpoints (manifest / the editor blobs /
   *  import) carry it as `?facility=<slug>`; the facility-agnostic ones (`/api/netbox/*`,
   *  `/api/backup/*`, `/api/settings`) are left untouched (MULTI-2). */
  static _url(path) {
    if (!(window.MAP && window.MAP.api && path.startsWith('/api/'))) return path;
    let url = window.MAP.api + path.slice('/api/'.length);
    if (Api.facility && Api._perFacility(path)) {
      url += (url.includes('?') ? '&' : '?') + 'facility=' + encodeURIComponent(Api.facility);
    }
    return url;
  }
  /** Whether a logical `/api/*` path is scoped to a facility (so `?facility=` is appended). */
  static _perFacility(path) {
    return Api.FACILITY_PREFIXES.some(p => path === p || path.startsWith(p + '/')
      || path.startsWith(p + '?'));
  }

  /** Append the active `?facility=<slug>` to an already-built URL (merging with any existing
   *  query). For the raw `fetch`/`<img>` call sites the import flow builds directly (uploads,
   *  drafts, preview, wizard thumbnails), which don't pass through `_url`. No-op for the default
   *  facility, so single-facility installs and standalone are unchanged. */
  static withFacility(url) {
    if (!Api.facility) return url;
    return url + (url.includes('?') ? '&' : '?') + 'facility=' + encodeURIComponent(Api.facility);
  }
  /** Turn a non-OK response into an Error carrying the server's own message. These endpoints
   *  fail in two shapes: a JSON body `{ok:false, error}` (e.g. a 500 from the render subprocess)
   *  or a plain-text `HttpResponseBadRequest`. Surfacing the real text — not a bare
   *  "HTTP 500" — is what tells the user the actual cause (a missing dep, a bad input), and
   *  makes clear these are local NetBox calls, not the internet. */
  static async _fail(r) {
    let msg = 'HTTP ' + r.status;
    try {
      const t = (await r.text()).trim();
      // Prefer the human-readable `detail` (a 409 conflict carries the reload-and-re-apply
      // guidance there; `error` is the terse machine code, e.g. 'conflict'), then `error`.
      if (t) { try { const j = JSON.parse(t); msg = j.detail || j.error || msg; } catch (_) { msg = t.slice(0, 300); } }
    } catch (_) { /* keep the status-code fallback */ }
    return new Error(msg);
  }
  static async get(path) {
    const r = await fetch(Api._url(path));
    if (!r.ok) throw await Api._fail(r);
    return r.json();
  }
  static async post(path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (window.MAP && window.MAP.csrf) headers['X-CSRFToken'] = window.MAP.csrf;
    const r = await fetch(Api._url(path), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!r.ok) throw await Api._fail(r);
    return r.json();
  }

  /** Optimistic-concurrency variants for the whole-document editor blobs. GET returns
   *  `{ data, version }`, echoing the server's version token so a later save can prove it
   *  edited the current document (see frontend_api VERSION_HEADER / CONC-1). POST sends that
   *  token back and returns the new one; a 409 (the document moved underneath us) is flagged
   *  as `err.conflict` so callers can keep the edits and prompt a reload instead of clobbering, and
   *  a 403 (likely a session/CSRF expiry mid-edit) as `err.authExpired` (SAVE-5). */
  static async getV(path) {
    const r = await fetch(Api._url(path));
    if (!r.ok) throw await Api._fail(r);
    return { data: await r.json(), version: r.headers.get(Api.VERSION_HEADER) };
  }
  static async postV(path, body, version) {
    const headers = { 'Content-Type': 'application/json' };
    if (window.MAP && window.MAP.csrf) headers['X-CSRFToken'] = window.MAP.csrf;
    if (version != null) headers[Api.VERSION_HEADER] = version;
    const r = await fetch(Api._url(path), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const e = await Api._fail(r);
      if (r.status === 409) e.conflict = true;
      // A 403 on a write is almost always a session/CSRF expiry after a long edit — flag it so the
      // save-failure dialog (Editor._saveFailedDialog, SAVE-5) can offer Reload-to-reauthenticate.
      else if (r.status === 403) e.authExpired = true;
      throw e;
    }
    return { data: await r.json(), version: r.headers.get(Api.VERSION_HEADER) };
  }
}
Api.VERSION_HEADER = 'X-Facilitymap-Version';
// The active facility ('' = default), set by App on boot / picker change. Threaded onto the
// per-facility endpoints below so one Api layer serves every facility (MULTI-2).
Api.facility = '';
// Logical `/api/*` paths that are facility-scoped: the manifest, the editor blob documents, the
// import pipeline, `/api/netbox/sites`, `/api/netbox/building-locations`, and `/api/netbox/inventory`.
// The other `/api/netbox/*` reads
// (scoped by an explicit `site=`/`location=`), `/api/backup/*` (whole-install), and `/api/settings`
// (install-wide) are deliberately absent — they never carry a facility. The `/api/netbox/*`
// exceptions are the facility-wide ones: `/api/netbox/sites` is the facility-binding point (the
// import wizard's building→Site search must return only the active facility's Sites, or an operator
// could bind out-of-facility and strand the data, FACIL-1), `/api/netbox/building-locations` is its
// Site = campus sibling (the same building→anchor search over Locations, so it scopes identically,
// MODEL-4), and `/api/netbox/inventory` is the
// finder's facility-wide room/rack/device search (NAV-3) — all must scope to the active facility.
// `/api/todos/all` (the facility-wide rollup, TASK-5) is listed by its EXACT path, not as a
// `/api/todos` prefix: the match below also fires on `<prefix>/…` and `<prefix>?…`, so the shorter
// form would start threading `?facility=` onto the per-floor read and every to-do write — none of
// which want it (a `floor_key` already names exactly one facility).
Api.FACILITY_PREFIXES = ['/api/manifest', '/api/annotations', '/api/siteplan',
  '/api/rackplacements', '/api/pagelayouts', '/api/import', '/api/netbox/sites',
  '/api/netbox/building-locations', '/api/netbox/inventory', '/api/todos/all'];
