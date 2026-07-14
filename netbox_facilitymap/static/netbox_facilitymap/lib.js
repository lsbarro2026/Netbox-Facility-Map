'use strict';
/* lib.js — framework-free foundations shared by every module.
   Pure static helper classes (no instances, no state). Loaded first. */

const SVGNS = 'http://www.w3.org/2000/svg';
const CLOSE_PX = 12;   // click-near-first-vertex threshold (displayed px) to close a polygon
const SNAP_PX = 11;    // snap radius (displayed px) for vertices/edges
const ORTHO_DEG = 6;   // angular tolerance (degrees from an axis) for right-angle node snap
const RECT_MIN_PX = 6; // min side (displayed px) for the rectangle tool, so a click-without-drag makes nothing
const ANGLE_STEP = 15; // label rotation snaps to this many degrees (Alt to free-rotate)
const LABEL_SIZE_MIN = 6, LABEL_SIZE_MAX = 120;   // label font-size clamp (px)
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
  static get check() { return Icons._ico('<path d="M20 6 9 17l-5-5"/>', 12); }
  // server: stacked rack units — the closest Lucide fit for the rack-placement tool.
  static get rack() { return Icons._ico('<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>'); }
  static get settings() { return Icons._ico('<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>'); }
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
      if (t) { try { msg = JSON.parse(t).error || msg; } catch (_) { msg = t.slice(0, 300); } }
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
   *  as `err.conflict` so callers can keep the edits and prompt a reload instead of clobbering. */
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
// import pipeline, and `/api/netbox/sites`. The other `/api/netbox/*` reads (scoped by an explicit
// `site=`/`location=`), `/api/backup/*` (whole-install), and `/api/settings` (install-wide) are
// deliberately absent — they never carry a facility. `/api/netbox/sites` is the exception because
// it *is* the facility-binding point: the import wizard's building→Site search must return only the
// active facility's Sites, or an operator could bind out-of-facility and strand the data (FACIL-1).
Api.FACILITY_PREFIXES = ['/api/manifest', '/api/annotations', '/api/siteplan',
  '/api/rackplacements', '/api/pagelayouts', '/api/import', '/api/netbox/sites'];
