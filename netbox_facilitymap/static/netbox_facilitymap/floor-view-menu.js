'use strict';
/* floor-view-menu.js — FloorViewMenu: the "View" control on the building floor-selection
   page (the `#/b/<dir>` grid of floor cards). It owns three things end to end:
     1. the per-browser display preferences (previews / card size / layout / sort / badges),
     2. the toolbar button + popover that edits them, and
     3. rendering the `.floor-grid` from the effective settings.
   The building view is rendered by the top-level `App` (not an `Editor`), so this deliberately
   does NOT route through the shared `Editor` edit-menu — App.renderBuilding builds one of these,
   hands `button()` to `App.setToolbar`, and calls `render(stage)` (NAV-9).

   Preferences are client-side only (there is no server-side per-user UI store); they follow the
   existing per-browser `localStorage` idiom used for grid step, ortho-snap, and the siteplan
   legend state. Two scopes: a GLOBAL set applied to every building, and an optional PER-BUILDING
   override keyed by the building `dir`. The "Only this building" toggle gates which scope is read
   and written — the override exists exactly when its key is present. */

/* Above this many floors, previews default OFF (a long list stays scannable); at or below, ON.
   Only the *default* is threshold-driven — an explicit user choice (stored `previews`) wins. */
const FLOOR_PREVIEW_THRESHOLD = 15;

/* The "Card size" slider is a 0..100 value that sizes the floor *preview* (the card's centerpiece).
   It interpolates two grid custom properties between the small (0) and extra-large (100) endpoints:
   `--floor-card-min` (the auto-fit column floor → card/preview *width*) and `--floor-card-height`
   (the preview *band/row height* — the vertical hero's band height, or the horizontal card's row
   height; CSS caps it in the deliberately-compact grid·horizontal mode). Both grow together, so a
   higher slider enlarges the preview in both dimensions.
   NAV-17 doubled the reach: the endpoints below were widened so the *old* maximum (700/360px) now
   sits at the slider's **midpoint** (t=0.5) and t=1.0 goes ~2× beyond it. The default is 25 — new
   t=0.25 reproduces the *old* default on-screen size (480/240px) exactly, so a fresh browser looks
   unchanged while the whole upper half of the slider is new, larger-than-ever headroom. */
const FLOOR_VIEW_SIZE_MAX = 100;
const FLOOR_VIEW_SIZE_DEFAULT = 25;
const FLOOR_VIEW_SIZE_RANGE = { minPx: [260, 1140], heightPx: [120, 600] };
/* Persisted-settings schema version. Bumped to 2 by NAV-17's slider rescale so a stored *numeric*
   size from a pre-v2 build (the old 0..100 scale, where 100 = the old max) can be migrated exactly
   once, in `_read`, by halving it — old 100 → new 50 (its on-screen size is the new midpoint), old
   50 → 25, old 0 → 0 — preserving every existing user's card size rather than silently doubling it.
   Any write stamps `v`, so a migrated value is never halved twice. */
const FLOOR_VIEW_SCHEMA_V = 2;
/* Legacy `size` values (the pre-slider `sm|md|lg` presets) mapped straight onto the *current* 0..100
   scale, so stored preferences from a very old build coerce gracefully in `_read`. Remapped by
   NAV-17 to preserve each preset's on-screen size under the widened range: `lg` was the old maximum
   (now the 50% midpoint's *half*, 25), `md` its midpoint. A string size is unambiguously legacy, so
   it needs no version flag. */
const FLOOR_VIEW_SIZE_LEGACY = { sm: 0, md: 12, lg: 25 };

/* Card orientation is *orthogonal* to layout (NAV-14): it governs how each card arranges its
   preview relative to its text, while `layout` governs how the cards tile the page. The four
   combinations each earn a distinct purpose (NAV-17), all keyed in CSS:
     grid·vertical    — poster wall: many hero cards, big top preview; browse by sight (default).
     list·vertical    — showcase: one full-width preview per row; the single largest look at a plan.
     grid·horizontal  — compact cards: short landscape cards, multi-column; most floors on screen.
     list·horizontal  — scan rows: large preview left + compact label right; scroll a long list.
   `'vertical'` = the NAV-13 hero (full-width preview band on top, caption below);
   `'horizontal'` = preview left, caption right. */
const FLOOR_VIEW_ORIENTATIONS = ['vertical', 'horizontal'];

/* Effective settings when a scope has nothing stored. `previews: null` means "auto" — decide per
   building by FLOOR_PREVIEW_THRESHOLD; an explicit `true`/`false` overrides that globally.
   `size` defaults to 25 (reproduces the old default on-screen size on the widened NAV-17 scale).
   `orientation` defaults to `'vertical'`, so a fresh browser keeps the NAV-13 hero look. */
const FLOOR_VIEW_DEFAULTS = { previews: null, size: FLOOR_VIEW_SIZE_DEFAULT, orientation: 'vertical', layout: 'grid', sort: 'floor-asc', badges: true };

const FLOOR_VIEW_GLOBAL_KEY = 'facilitymap:floorView';

class FloorViewMenu {
  constructor(app, dir, building) {
    this.app = app;
    this.dir = dir;
    this.b = building;
    this.floorCount = building.floors.length;
    this._stage = null;   // set by render(); a preference change re-renders just the grid into it
  }

  // ---- preference scopes (localStorage) ----
  _bldgKey() { return FLOOR_VIEW_GLOBAL_KEY + ':' + this.dir; }
  /** The per-building override is active exactly when its key exists. */
  _override() {
    try { return localStorage.getItem(this._bldgKey()) !== null; }
    catch (e) { return false; }
  }
  _activeKey() { return this._override() ? this._bldgKey() : FLOOR_VIEW_GLOBAL_KEY; }

  /** Stored settings for a scope, merged over the defaults (a missing/corrupt value degrades to
   *  the defaults rather than throwing). Always returns a full settings object. */
  _read(key) {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : {};
      const obj = (parsed && typeof parsed === 'object') ? parsed : {};
      const s = Object.assign({}, FLOOR_VIEW_DEFAULTS, obj);
      // A pre-v2 object stored its numeric `size` on the old (half-width) scale, where 100 was the
      // max; halve it once so its on-screen size survives the NAV-17 range widening. The check reads
      // the *raw* stored object (defaults carry no `v`), so it fires only for un-migrated numbers —
      // legacy 'sm'|'md'|'lg' strings go through the legacy map instead and never need this.
      const preV2Numeric = obj.v == null && typeof obj.size === 'number';
      s.size = this._coerceSize(s.size, preV2Numeric);
      s.orientation = this._coerceOrientation(s.orientation);   // guard a corrupt stored value
      return s;
    } catch (e) { return Object.assign({}, FLOOR_VIEW_DEFAULTS); }
  }
  /** Coerce a stored `size` onto the 0..FLOOR_VIEW_SIZE_MAX slider scale: a number is (optionally
   *  halved for the pre-v2 → v2 rescale, then) clamped, a legacy 'sm'|'md'|'lg' string is remapped,
   *  anything else falls back to the default. */
  _coerceSize(v, halve) {
    if (typeof v === 'number' && isFinite(v)) {
      return Math.max(0, Math.min(FLOOR_VIEW_SIZE_MAX, Math.round(halve ? v / 2 : v)));
    }
    if (typeof v === 'string' && v in FLOOR_VIEW_SIZE_LEGACY) return FLOOR_VIEW_SIZE_LEGACY[v];
    return FLOOR_VIEW_SIZE_DEFAULT;
  }
  /** Coerce a stored `orientation` to one of the two allowed values, falling back to the default so
   *  a corrupt value emits the default CSS class rather than a bogus `orient-<garbage>`. */
  _coerceOrientation(v) {
    return FLOOR_VIEW_ORIENTATIONS.includes(v) ? v : FLOOR_VIEW_DEFAULTS.orientation;
  }
  /** Effective settings for this building (the active scope). */
  _effective() { return this._read(this._activeKey()); }
  /** Whether previews resolve ON for this building — the stored value, or the threshold default. */
  _previewsOn(s) { return s.previews === null ? this.floorCount <= FLOOR_PREVIEW_THRESHOLD : s.previews; }

  /** Apply a partial settings change to the active scope and re-render the grid. */
  _apply(patch) {
    const key = this._activeKey();
    // `_read` returns the (already-migrated) settings; stamp the schema version on every write so a
    // pre-v2 numeric size is halved exactly once and later reads leave it alone.
    const next = Object.assign(this._read(key), patch, { v: FLOOR_VIEW_SCHEMA_V });
    try { localStorage.setItem(key, JSON.stringify(next)); } catch (e) {}
    this.render(this._stage);
  }
  /** Turn the per-building override on (seeding it from the current global settings so the switch
   *  is a no-op until changed) or off (dropping back to the shared global set). */
  _setOverride(on) {
    if (on === this._override()) return;
    try {
      if (on) localStorage.setItem(this._bldgKey(), JSON.stringify(Object.assign(this._read(FLOOR_VIEW_GLOBAL_KEY), { v: FLOOR_VIEW_SCHEMA_V })));
      else localStorage.removeItem(this._bldgKey());
    } catch (e) {}
    this._paint();            // every control may now read a different scope
    this.render(this._stage);
  }
  /** Reset the active scope to defaults, without changing which scope is active: an active override
   *  is reset in place (its key stays, so "Only this building" stays on); otherwise the global key
   *  is cleared. */
  _reset() {
    try {
      if (this._override()) localStorage.setItem(this._bldgKey(), JSON.stringify({}));
      else localStorage.removeItem(FLOOR_VIEW_GLOBAL_KEY);
    } catch (e) {}
    this._paint();
    this.render(this._stage);
  }

  // ---- the toolbar control ----
  /** The "View" button + its (initially closed) popover, wrapped so the popover can position
   *  absolutely against the button. Handed to App.setToolbar. */
  button() {
    this._btn = Dom.el('button', { class: 'tb-labeled', title: 'Display options for the floor list',
      html: Icons.sliders + '<span>View</span>' });
    this._pop = Dom.el('div', { class: 'view-menu' });
    this._wrap = Dom.el('div', { class: 'view-menu-wrap' }, [this._btn, this._pop]);
    this._paint();
    // stopPropagation so the just-opened popover isn't immediately closed by the document handler.
    this._btn.onclick = (e) => { e.stopPropagation(); this._toggle(); };
    return this._wrap;
  }

  /** (Re)fill the popover from the current effective settings + override state. Called on build and
   *  whenever a change alters what other controls should read (override toggle, reset). */
  _paint() {
    const s = this._effective();
    this._pop.innerHTML = '';
    const rows = [
      // Toggling previews also re-paints the popover, since it adds/removes the size slider row.
      this._check('Floor previews', this._previewsOn(s), v => { this._apply({ previews: v }); this._paint(); }),
    ];
    // The size slider sizes the *preview*, so it only makes sense while previews are on — with them
    // off the card shrinks to its text and there is nothing for the slider to act on, so hide it.
    if (this._previewsOn(s)) {
      rows.push(this._slider('Card size', FLOOR_VIEW_SIZE_MAX, s.size, v => this._apply({ size: v })));
      // Orientation is orthogonal to layout (NAV-14) but only meaningful with a preview to arrange,
      // so it rides inside the previews-on block alongside the size slider.
      rows.push(this._select('Orientation', [['vertical', 'Vertical'], ['horizontal', 'Horizontal']], s.orientation, v => this._apply({ orientation: v })));
    }
    rows.push(
      this._select('Layout', [['grid', 'Grid'], ['list', 'List']], s.layout, v => this._apply({ layout: v })),
      this._select('Sort', [['floor-asc', 'Floor ↑'], ['floor-desc', 'Floor ↓'], ['rooms-desc', 'Most rooms']], s.sort, v => this._apply({ sort: v })),
      this._check('Show badges', s.badges, v => this._apply({ badges: v })),
      Dom.el('div', { class: 'view-sep' }),
      this._check('Only this building', this._override(), v => this._setOverride(v)),
      this._resetRow(),
    );
    rows.forEach(r => this._pop.append(r));
  }

  _row(labelText, control) {
    return Dom.el('label', { class: 'view-row' }, [Dom.el('span', {}, labelText), control]);
  }
  _check(labelText, checked, onChange) {
    const input = Dom.el('input', { type: 'checkbox' });
    input.checked = checked;
    input.onchange = () => onChange(input.checked);
    return this._row(labelText, input);
  }
  _select(labelText, options, value, onChange) {
    const sel = Dom.el('select', {});
    options.forEach(([v, l]) => {
      const o = Dom.el('option', { value: v }, l);
      if (v === value) o.selected = true;
      sel.append(o);
    });
    sel.onchange = () => onChange(sel.value);
    return this._row(labelText, sel);
  }
  /** A 0..max range slider with a live percent readout. `oninput` fires while dragging so the grid
   *  resizes live; `onChange` receives the numeric value. */
  _slider(labelText, max, value, onChange) {
    const input = Dom.el('input', { type: 'range', class: 'view-slider', min: '0', max: String(max), step: '1' });
    input.value = String(value);
    const out = Dom.el('output', { class: 'view-slider-val' }, value + '%');
    input.oninput = () => { out.textContent = input.value + '%'; onChange(Number(input.value)); };
    return this._row(labelText, Dom.el('div', { class: 'view-slider-wrap' }, [input, out]));
  }
  _resetRow() {
    const btn = Dom.el('button', { class: 'view-reset', type: 'button' }, 'Reset to defaults');
    btn.onclick = () => this._reset();
    return Dom.el('div', { class: 'view-row view-row-action' }, btn);
  }

  _toggle() { this._pop.classList.contains('open') ? this._close() : this._open(); }
  _open() {
    // The popover is `position: fixed` (see CSS) to escape the toolbar's overflow clip, so anchor
    // it to the button's current viewport rect — just under it, right edges aligned.
    const r = this._btn.getBoundingClientRect();
    this._pop.style.top = Math.round(r.bottom + 6) + 'px';
    this._pop.style.right = Math.round(window.innerWidth - r.right) + 'px';
    this._pop.classList.add('open');
    this._btn.classList.add('active');
    // Close on any outside click or Escape; both handlers are removed again on close, and a click
    // on a floor card (outside the wrap) closes it before navigating.
    this._onDoc = (e) => { if (!this._wrap.contains(e.target)) this._close(); };
    this._onKey = (e) => { if (e.key === 'Escape') this._close(); };
    document.addEventListener('click', this._onDoc);
    document.addEventListener('keydown', this._onKey);
  }
  _close() {
    this._pop.classList.remove('open');
    this._btn.classList.remove('active');
    if (this._onDoc) document.removeEventListener('click', this._onDoc);
    if (this._onKey) document.removeEventListener('keydown', this._onKey);
    this._onDoc = this._onKey = null;
  }

  // ---- the grid ----
  /** Linear-interpolate a rounded value across `[lo, hi]` at fraction `t` (0..1). */
  _lerp([lo, hi], t) { return Math.round(lo + (hi - lo) * t); }
  /** Room count for a floor, from the deferred annotations load (0 when unmapped/not yet loaded). */
  _roomCount(f) {
    const rec = this.app.store.annotations[Util.floorKey(this.dir, f.id)];
    return (rec && rec.rooms.length) || 0;
  }
  /** Floors in the chosen order. The manifest order is the natural floor order, so `floor-asc` is
   *  as-is and `floor-desc` its reverse; `rooms-desc` sorts by mapped-room count. */
  _sorted(sort) {
    const arr = this.b.floors.slice();
    if (sort === 'floor-desc') arr.reverse();
    else if (sort === 'rooms-desc') arr.sort((a, b) => this._roomCount(b) - this._roomCount(a));
    return arr;
  }

  /** Build the `.floor-grid` from the effective settings and drop it into `stage`, replacing any
   *  grid a prior render left there (so a preference change repaints only the grid, not the
   *  toolbar or the open popover). */
  render(stage) {
    if (!stage) return;
    this._stage = stage;
    const existing = stage.querySelector('.floor-grid');
    if (existing) existing.remove();

    const s = this._effective();
    const previewsOn = this._previewsOn(s);
    // `no-previews` swaps the grid to a wrap of text-sized cards (CSS); with previews on, the size
    // slider interpolates the two tunable dimensions below.
    const grid = Dom.el('div', { class: 'floor-grid layout-' + s.layout + ' orient-' + s.orientation + (previewsOn ? '' : ' no-previews') });
    // The grid fills a share of the page width (`--floor-grid-fill`, centered in CSS) so it doesn't
    // leave a wide screen sparse; the floor count (`--n`) still caps the total via a per-card
    // ceiling so a few floors don't balloon to absurd widths. The size slider (0..MAX) interpolates
    // the two tunable dimensions the size seam (NAV-6) exposed across FLOOR_VIEW_SIZE_RANGE, with no
    // relayout logic (CSS carries matching fallbacks): `--floor-card-min` (card/preview width) and
    // `--floor-card-height` (the preview band/row height — see `orient-*` in CSS). With previews off the card sizes to its
    // text, so these don't apply. Always ≥2 floors here — one-floor buildings redirect straight.
    grid.style.setProperty('--n', this.floorCount);
    grid.style.setProperty('--floor-grid-fill', '70%');
    if (previewsOn) {
      const t = s.size / FLOOR_VIEW_SIZE_MAX;
      grid.style.setProperty('--floor-card-min', this._lerp(FLOOR_VIEW_SIZE_RANGE.minPx, t) + 'px');
      grid.style.setProperty('--floor-card-height', this._lerp(FLOOR_VIEW_SIZE_RANGE.heightPx, t) + 'px');
    }

    for (const f of this._sorted(s.sort)) {
      const n = this._roomCount(f);
      const children = [];
      // Card-sized `thumb` when the manifest has one (builds since 1.44.0); full-res plan as the
      // fallback for older manifests. Omitted entirely when previews are off.
      if (previewsOn) children.push(Dom.el('img', { src: this.app.store.mediaUrl(f.thumb || f.image), loading: 'lazy' }));
      const cap = [Dom.el('b', {}, f.label)];
      if (s.badges) {
        cap.push(Dom.el('div', { class: 'badges' }, [
          Dom.el('span', { class: 'cnt ' + (n ? 'mapped' : 'unmapped') }, n ? n + ' rooms' : 'unmapped'),
          ...(f.pages && f.pages.length > 1 ? [Dom.el('span', { class: 'cnt sheets' }, f.pages.length + ' sheets')] : []),
        ]));
      }
      children.push(Dom.el('div', { class: 'cap' }, cap));
      const card = Dom.el('div', {
        class: 'floor-card' + (previewsOn ? '' : ' no-preview'),
        onclick: () => this.app.go('/f/' + encodeURIComponent(this.dir) + '/' + encodeURIComponent(f.id)),
      }, children);
      // The thumbnail preserves the page aspect (`f.w/f.h`); both orientations render it with
      // `object-fit: contain`, so the whole plan shows, never cropped. Older manifests without w/h
      // fall back in CSS (the aspect only tunes the horizontal thumb width).
      if (previewsOn && f.w && f.h) card.style.setProperty('--preview-aspect', (f.w / f.h).toFixed(4));
      grid.append(card);
    }
    stage.append(grid);
  }
}
