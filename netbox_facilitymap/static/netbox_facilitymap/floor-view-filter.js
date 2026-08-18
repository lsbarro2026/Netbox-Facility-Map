'use strict';
/* floor-view-filter.js — FloorViewFilter: the floor toolbar's view-mode "View" filter (VIEW-2).
   Owns two halves of one concern:
     1. the SELECTION MODEL — which placement categories the floor is showing — as pure statics
        over the plain object `App.viewCategories` (App owns the value; this owns its meaning), and
     2. the toolbar button + checkbox popover that edits it, including the "+ Add role…" picker
        that appends NetBox device roles as further categories.

   It replaced the single-choice highlight `<select>` (`all` / `placements` / `none`), which could
   only ever answer one question at a time — a floor holding racks *and* access points had no way
   to show just those two.

   Holds an editor back-ref (`this.ed`), the FloorArrange/FloorDeviceTool shape. Floor-only by nature:
   `_viewButtons()` is a FloorEditor hook (SiteplanEditor has no highlight control), so this is not
   the §10 edit-menu-lockstep drift it might otherwise look like.

   The control itself is the building page's View menu reused wholesale — the shared `Popover`
   (which `App._detachCurrent` closes on every route change) inside a `.view-menu-wrap`, painted
   with the same `.view-row`/`.view-sep` rows FloorViewMenu uses.

   Persistence (VIEW-3): the selection survives a page reload via `localStorage`, global across
   buildings/floors — the same scope it already has in-session, so a reload just continues it
   rather than introducing per-building scoping the feature never had. `App`'s constructor can't
   read storage itself: this class rides the lazy floor-editor bundle, loaded after `app.js`, so
   `App.showFloor` calls `load()` once, the first time a floor is shown (see its comment there). */

const FLOOR_VIEW_FILTER_KEY = 'facilitymap:floorViewFilter';
const FLOOR_VIEW_FILTER_SCHEMA_V = 1;

class FloorViewFilter {
  constructor(editor) { this.ed = editor; }

  // ---- the selection model (pure — the half the node test tier covers) ----

  /** The "show everything" selection: `all` on, every category off. The default state on load and
   *  what the export snapshot forces, so an export renders the full unfiltered floor regardless of
   *  what the user has checked (§10 *Rendering / export*). A fresh object each call — the roles
   *  array is mutable, so callers must never share one. */
  static everything() { return { all: true, racks: false, aps: false, roles: [] }; }

  /** Whether `sel` shows anything at all. Nothing checked draws no room highlights and no markers
   *  — a bare floor plan. (The old `none` left every marker drawn, which a per-category filter
   *  can't keep coherent: checking Racks would then show *fewer* markers than checking nothing.) */
  static anyOn(sel) {
    return !!(sel && (sel.all || sel.racks || sel.aps || (sel.roles || []).some(r => r.on)));
  }

  /** Coerce a raw persisted value (parsed JSON, or garbage) into a well-shaped selection, merged
   *  over `everything()`'s defaults so a missing/corrupt field degrades rather than producing a
   *  selection `matches`/`anyOn` would mis-evaluate. Pure — no `localStorage`, no `this`.
   *  A `roles` entry needs a non-empty `name` to be useful (`matches` matches on `slug`/`name`,
   *  `_roleRow` renders `role.name`); a nameless entry is dropped rather than kept as a blank row.
   *  Always returns a fresh `roles` array, matching `everything()`'s own no-aliasing invariant. */
  static sanitize(parsed) {
    const d = FloorViewFilter.everything();
    if (!parsed || typeof parsed !== 'object') return d;
    return {
      all: typeof parsed.all === 'boolean' ? parsed.all : d.all,
      racks: !!parsed.racks,
      aps: !!parsed.aps,
      roles: Array.isArray(parsed.roles)
        ? parsed.roles.filter(r => r && typeof r.name === 'string' && r.name.length > 0)
          .map(r => ({ id: r.id, name: r.name, slug: r.slug, on: !!r.on }))
        : d.roles,
    };
  }

  /** Read the persisted selection (VIEW-3) from `localStorage`. Degrades to `everything()` on any
   *  failure — missing key, corrupt JSON, or `localStorage` being unavailable at all (which throws
   *  a `ReferenceError` this same `try/catch` catches). Called once per page load, from
   *  `App.showFloor`. */
  static load() {
    try {
      const raw = localStorage.getItem(FLOOR_VIEW_FILTER_KEY);
      return raw ? FloorViewFilter.sanitize(JSON.parse(raw)) : FloorViewFilter.everything();
    } catch (e) { return FloorViewFilter.everything(); }
  }

  /** Persist `sel` (VIEW-3), stamping the schema version on every write. Called from `_apply()`
   *  after every user-driven change — never during floor-export's transient show-everything swap,
   *  which reassigns `app.viewCategories` directly rather than going through a mutator here. */
  static save(sel) {
    try {
      localStorage.setItem(FLOOR_VIEW_FILTER_KEY, JSON.stringify({
        all: sel.all, racks: sel.racks, aps: sel.aps, roles: sel.roles, v: FLOOR_VIEW_FILTER_SCHEMA_V,
      }));
    } catch (e) {}
  }

  /** Does `p` (a placement, with its cached NetBox `item` or null) pass the selection?
   *  `apRoles` is the list of access-point roles the install's device presets configure
   *  (`app.apRoles()`, each `{id,name}`) — possibly empty. Pure in its arguments — no `this`, no
   *  DOM, no app reach — so the whole filter decision is one testable function shared by the
   *  marker draw and the room-highlight pass, which is what keeps "this room highlights" and
   *  "this marker draws" from ever disagreeing.
   *
   *  A rack answers ONLY to the Racks box: racks are `dcim.Rack` and carry no device role, so no
   *  role category could match one and the AP test is meaningless for it. */
  static matches(sel, p, item, apRoles) {
    if (!sel || sel.all) return true;
    if (p.kind === 'rack') return !!sel.racks;
    if (sel.aps && FloorViewFilter.isAp(p, item, apRoles)) return true;
    const role = (item && item.role) || null;
    for (const r of (sel.roles || [])) {
      if (!r.on || !role) continue;
      if (r.slug && role.slug && r.slug === role.slug) return true;
      if (r.name && role.name && FloorViewFilter._sameName(r.name, role.name)) return true;
    }
    return false;
  }

  /** Whether a device placement counts as an access point. Two signals, OR'd:
   *
   *  · the roles the install's AP-iconed device presets configure (`app.apRoles()` — what the
   *    Add-device tool stamps on the Devices those presets create), authoritative even when a
   *    role's name says nothing the keyword rules recognize;
   *  · `DeviceShapes.typeFor`'s `'ap'` verdict — the SAME classification that drew the marker's
   *    puck glyph. A preset-placed AP carries an explicit `icon: 'ap'` that typeFor honours, so
   *    this signal covers those without any role bookkeeping.
   *
   *  Both, rather than the configured roles alone, precisely so the filter and the drawn glyph
   *  never disagree: an install that configures `Wireless AP` for new APs still has legacy devices
   *  on an `Access Point` role, and those already draw an AP puck. Dropping them from the Access
   *  points category would leave AP glyphs on screen that checking the AP box hides. */
  static isAp(p, item, apRoles) {
    if (p.kind === 'rack') return false;
    const role = (item && item.role) || null;
    if (role && role.name && (apRoles || []).some(
      r => r && r.name && FloorViewFilter._sameName(role.name, r.name))) return true;
    return DeviceShapes.typeFor(p, item) === 'ap';
  }

  /** Case/whitespace-insensitive role-name compare. Names come from two different places (the
   *  device serializer and `window.MAP.devicePresets`), so compare them the forgiving way rather
   *  than trusting them to be byte-identical. */
  static _sameName(a, b) {
    return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  }

  /** Does a room draw as a **visible shape** at all, rather than view mode's invisible
   *  `.clickzone`? The room-level counterpart to `matches` above, and pure for the same reason:
   *  two places need this answer and they must never disagree. `FloorEditor._drawRoom` asks it to
   *  pick the room's class, and `_renderStatic` asks it of every room to decide which ones may
   *  punch a hole in a container's fill (ROOM-2) — a room the user filtered out must not leave a
   *  room-shaped gap behind in the room that contains it.
   *
   *  Edit and the racks sub-mode draw every room (geometry can't be edited if it isn't drawn), so
   *  they short-circuit true and the filter never applies there. In view mode a room draws when
   *  `all` is checked, when it holds a marker the filter still draws (`placed`, the room-level half
   *  `visibleRoomIds` computes), or when it is the focus target of a search jump / `#/r/` deep-link
   *  — which is always drawn so the jump lands on something visible whatever is filtered out. */
  static showsRoom(sel, { editing, racks, focused, placed }) {
    return !!(editing || racks || focused || (sel && sel.all) || placed);
  }

  // ---- the live decision, against this editor's floor ----

  /** The current selection (`App.viewCategories`). */
  get selection() { return this.ed.app.viewCategories; }

  /** Whether this placement's marker draws. View-mode only — edit and the racks sub-mode always
   *  show every marker, since a filtered-out rack you can't see is a rack you can't move. */
  shows(p) {
    return FloorViewFilter.matches(this.selection, p, this.ed.placements.cacheItem(p),
      this.ed.app.apRoles());
  }

  /** Ids of the rooms holding at least one *visible* placement — the room-level half of the same
   *  decision, so a room highlights exactly when something inside it is drawn. */
  visibleRoomIds() {
    const ids = new Set();
    for (const p of this.ed.store.placementData(this.ed.building.dir, this.ed.floor.id).placements)
      if (this.shows(p)) ids.add(p.room);
    return ids;
  }

  // ---- the toolbar control ----

  /** The "View" button + its (initially closed) popover, wrapped so the pair rides in the toolbar
   *  as one node — `App._fitToolbar`'s overflow fold moves only `button, select`, so a
   *  `.view-menu-wrap` div stays in the bar rather than folding into the "…" menu. */
  button() {
    this._btn = Dom.el('button', { class: 'tb-labeled', title: 'Choose what this floor shows',
      html: Icons.sliders + '<span>View</span>' });
    this._pop = Dom.el('div', { class: 'view-menu view-filter' });
    this._wrap = Dom.el('div', { class: 'view-menu-wrap' }, [this._btn, this._pop]);
    this._paint();
    new Popover({ trigger: this._btn, panel: this._pop, align: 'right' });
    return this._wrap;
  }

  /** (Re)fill the popover from the current selection. Called on build, and again whenever a change
   *  alters which rows exist (a role added or removed) or what another row should read. */
  _paint() {
    if (!this._pop) return;
    const sel = this.selection;
    this._pop.innerHTML = '';
    const rows = [
      this._check('All', sel.all, v => this._setAll(v)),
      Dom.el('div', { class: 'view-sep' }),
      this._check('Racks', sel.racks, v => this._setCategory('racks', v)),
      this._check('Access points', sel.aps, v => this._setCategory('aps', v)),
    ];
    for (const r of sel.roles) rows.push(this._roleRow(r));
    rows.push(Dom.el('div', { class: 'view-sep' }), this._addRoleRow());
    rows.forEach(r => this._pop.append(r));
  }

  /** Apply a selection change, persist it (VIEW-3), and repaint the floor. The popover keeps its
   *  own node (only the map re-renders), so it stays open under the pointer for the next box. */
  _apply() { FloorViewFilter.save(this.selection); this.ed.render(); }

  /** "All" and the individual categories are mutually exclusive, so exactly the checked boxes are
   *  what the floor shows — never a checked-but-inert row. Checking All clears the categories
   *  (added roles stay in the list, just unchecked); checking any category drops All. Unchecking
   *  All on its own leaves nothing checked, which is the bare-plan state. */
  _setAll(on) {
    const sel = this.selection;
    sel.all = on;
    if (on) {
      sel.racks = sel.aps = false;
      for (const r of sel.roles) r.on = false;
    }
    this._paint();
    this._apply();
  }

  _setCategory(key, on) {
    const sel = this.selection;
    sel[key] = on;
    if (on) sel.all = false;
    this._paint();
    this._apply();
  }

  _setRole(role, on) {
    role.on = on;
    if (on) this.selection.all = false;
    this._paint();
    this._apply();
  }

  /** An added role's row: its own checkbox plus a ✕ that drops the category again — a list you can
   *  only ever grow is a trap.
   *
   *  Unlike the fixed rows this is a `<div>` wrapping a `<label>`, NOT one `<label>` around
   *  everything: a button inside a label activates that label, so a ✕ in there would toggle the
   *  very checkbox it is about to remove. The label covers exactly the name + checkbox, so
   *  clicking the name still ticks the box. */
  _roleRow(role) {
    const input = Dom.el('input', { type: 'checkbox' });
    input.checked = !!role.on;
    input.onchange = () => this._setRole(role, input.checked);
    const remove = Dom.el('button', { class: 'view-role-remove', type: 'button',
      title: 'Remove this role from the list' }, '✕');
    remove.onclick = () => this._removeRole(role);
    const label = Dom.el('label', { class: 'view-role-label' },
      [Dom.el('span', {}, role.name), input]);
    return Dom.el('div', { class: 'view-row' }, [label, remove]);
  }

  _removeRole(role) {
    const sel = this.selection;
    const i = sel.roles.indexOf(role);
    if (i >= 0) sel.roles.splice(i, 1);
    this._paint();
    this._apply();
  }

  /** The "+ Add role…" picker: the shared searchable `Combo` over `dcim.DeviceRole`, since a
   *  NetBox install's role list is unbounded and can't fit a plain `<select>`. Picking a role
   *  appends it as a further (already-checked) category; picking one that's already listed just
   *  re-checks it rather than duplicating the row. */
  _addRoleRow() {
    const combo = new Combo({
      placeholder: '+ Add role…',
      load: (q) => this.ed.netbox.deviceRoles(q).then(r => r.roles || []),
      onPick: (opt) => { if (opt) this._addRole(opt); },
      allowClear: false,
    });
    return Dom.el('div', { class: 'view-row view-filter-add' }, [combo.el]);
  }

  _addRole(opt) {
    const sel = this.selection;
    const existing = sel.roles.find(r => (opt.slug && r.slug === opt.slug)
      || FloorViewFilter._sameName(r.name, opt.name));
    if (existing) this._setRole(existing, true);
    else {
      sel.roles.push({ id: opt.id, name: opt.name, slug: opt.slug, on: true });
      sel.all = false;
      this._paint();
      this._apply();
    }
  }

  _check(labelText, checked, onChange) {
    const input = Dom.el('input', { type: 'checkbox' });
    input.checked = checked;
    input.onchange = () => onChange(input.checked);
    return Dom.el('label', { class: 'view-row' }, [Dom.el('span', {}, labelText), input]);
  }
}
