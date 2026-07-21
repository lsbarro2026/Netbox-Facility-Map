'use strict';
/* todo-page.js — TodoPage: the facility-wide to-do page (TASK-5).

   The rollup surface: every building's and floor's work in one prioritized command centre, reached
   from the plugin nav (via `views.TodoTabView`) or `#/todo`. Where `FloorTodo` answers "what's left
   on this floor?", this answers "what's left anywhere, and where do I go to do it?".

   Mounted by `App.showTodo` into `#stage` — not an Editor, so it has no map, no toolbar and no
   panel; it owns its whole stage like `SettingsPage` does.

   Reads `/api/todos/all` (the facility-scoped `floor_key -> room_id -> [todo]` rollup) plus
   `store.annotations` for the rooms each to-do names. It **shares** the two things every to-do
   surface must agree on rather than restating them: the ordering is `TodoModel.compare` and the
   create form is a `TodoComposer` (see `foundations.md` §3). Two surfaces that disagreed on either
   would rank or create the same to-do differently depending on where you looked at it. The
   reference mockup duplicates its composer per surface; that is prototype expedience, not a
   pattern to copy.

   Rows are clickable — a click opens the room on its floor plan (the existing `#/r/` deep-link
   route) — and, since TASK-6, carry their own status pills, so the one status change a triage pass
   needs most doesn't require leaving this page. Full edit (text/priority/notes/assignees/due) and
   delete still live only on `FloorTodo`; this page is for triage and navigation, not the place work
   gets fully edited. */

//: The filter pills, left to right: each is both the predicate and the count the toolbar reads.
//: One definition, so the number on a pill and the list it filters to can never disagree. This set
//: is the page's own — `FloorTodo`'s pills are All/Planned/In progress/Done, because a floor panel
//: is a working list where this is a triage view (hence Open and Overdue leading). The status
//: *vocabulary* both read from is still TodoModel's.
const TODO_PG_FILTERS = [
  { key: 'open', label: 'Open', empty: 'open', match: (t) => t.status !== 'completed' },
  { key: 'planned', label: 'Planned', empty: 'planned', match: (t) => t.status === 'planned' },
  { key: 'in_progress', label: 'In progress', empty: 'in-progress',
    match: (t) => t.status === 'in_progress' },
  { key: 'overdue', label: 'Overdue', empty: 'overdue', match: (t) => TodoModel.isOverdue(t) },
  { key: 'completed', label: 'Completed', empty: 'completed',
    match: (t) => t.status === 'completed' },
];

//: Matches `FloorTodo`'s cap, so an assignee row reads identically on both surfaces.
const TODO_PG_AVATAR_MAX = 2;

//: The Display menu's group axes (TASK-7). `location` is the historical Building → Floor tree and
//: stays two-level; the rest bucket the flat entry list into a single level. "Building" is a
//: frontend-derived concept (manifest order), not a record field, so these axes live on the page —
//: `TodoModel` knows only the to-do record shape. The *ordering within* every bucket is still
//: `TodoModel`'s (the shared-ordering invariant); only the bucketing is the page's.
const TODO_PG_GROUPS = [
  { key: 'location', label: 'Building & floor' },
  { key: 'none', label: 'None (flat list)' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'priority', label: 'Priority' },
  { key: 'status', label: 'Status' },
];

//: One key holds both axes, persisted per-browser like every other UI pref (grid step, floor view).
const TODO_PG_VIEW_KEY = 'facilitymap:todoView';

class TodoPage {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.byFloor = {};        // floor_key -> { room_id: [todo, ...] }, straight from /api/todos/all
    this.filter = 'open';     // "what's left" is the question this page exists to answer
    this.query = '';
    this.loaded = false;
    this.collapsed = {};      // floor_key -> true once the user collapses it (default expanded)
    this.composer = null;     // built once and kept alive, so a re-render can't eat a draft
    const view = this._loadView();
    this.group = view.group;  // how the list is bucketed (TODO_PG_GROUPS); 'location' = the default tree
    this.sort = view.sort;    // the order within each bucket (TodoModel.SORTS); 'smart' = the default
  }

  /** The persisted Display choice (`{group, sort}`), each validated against its vocabulary so a stale
   *  or corrupt stored value degrades to the default rather than rendering an unknown mode. The page
   *  is re-instantiated on every `#/todo` visit, so this — not page state — is what makes the choice
   *  stick between visits. */
  _loadView() {
    const def = { group: 'location', sort: 'smart' };
    try {
      const raw = localStorage.getItem(TODO_PG_VIEW_KEY);
      const o = raw ? JSON.parse(raw) : {};
      return {
        group: TODO_PG_GROUPS.some(g => g.key === o.group) ? o.group : def.group,
        sort: TodoModel.SORTS.some(s => s.key === o.sort) ? o.sort : def.sort,
      };
    } catch (e) { return def; }
  }

  _saveView() {
    try {
      localStorage.setItem(TODO_PG_VIEW_KEY, JSON.stringify({ group: this.group, sort: this.sort }));
    } catch (e) {}
  }

  /** The viewer's user id, or null when unknown (standalone, no `window.MAP`). Only ever used to
   *  float their own work to the top, so "unknown" degrades to "nothing is mine". */
  _userId() { return (this.app.user && this.app.user.id) || null; }

  // ---- build ----
  /** Paint the shell and kick off the load. Returns immediately (the list fills in when the fetch
   *  lands) so the router is never blocked on it. */
  mount(host) {
    this.el = Dom.el('div', { class: 'todo-page' });
    // A generic plugin install has no facility until one is imported, and this page is reachable
    // from the nav on day one. Say so plainly rather than rendering an empty scaffold.
    if (!this.store.hasContent()) {
      this.el.append(Dom.el('div', { class: 'todo-pg-blank' }, [
        Dom.el('h2', {}, 'No facility map yet'),
        Dom.el('p', { class: 'hint' },
          'To-dos are tracked against rooms, so there is nothing to show until a facility map '
          + 'has been imported.'),
      ]));
      host.append(this.el);
      return this.el;
    }
    this.el.append(this._toolbar(), this._composerHost());
    this.listEl = Dom.el('div', { class: 'todo-pg-list' },
      Dom.el('div', { class: 'todo-empty' }, 'Loading…'));
    this.el.append(this.listEl);
    host.append(this.el);
    this._load();
    return this.el;
  }

  /** The page's whole control surface: the counted filter pills, the search box and New to-do, on
   *  one card. Deliberately **one** row-group and not the head + stat tiles + controls stack it
   *  replaced (UX-6): the tiles were a subset of these pills by key, counted from the same
   *  predicates, and each was likewise a button applying its own filter — so the block stated every
   *  number twice. A pill already is the tile, minus the empty box around it. The page title went
   *  with them: the surrounding NetBox page chrome already says where you are. */
  _toolbar() {
    this.filterBtns = {};
    const pills = Dom.el('div', { class: 'todo-filters', role: 'group',
      'aria-label': 'Filter to-dos' });
    for (const f of TODO_PG_FILTERS) {
      const count = Dom.el('span', { class: 'todo-filter-n' }, '—');
      // `todo-pg-pill pill-<key>` is the page's own hook, carried alongside the shared
      // `.todo-filter`: it's what lets the count take the tiles' one real contribution — the
      // semantic colour — without retuning the shared rule the floor panel reads (§10 *To-do*).
      const b = Dom.el('button', {
        class: 'todo-filter todo-pg-pill pill-' + f.key + (this.filter === f.key ? ' active' : ''),
        title: 'Show ' + f.label.toLowerCase() + ' to-dos',
        'aria-pressed': String(this.filter === f.key) }, [Dom.el('span', {}, f.label), count]);
      b.addEventListener('click', () => this._setFilter(f.key));
      this.filterBtns[f.key] = { btn: b, count };
      pills.append(b);
    }
    this.searchInput = Dom.el('input', { class: 'todo-pg-search', type: 'search',
      placeholder: 'Search to-dos, rooms, floors…', 'aria-label': 'Search to-dos' });
    this.searchInput.addEventListener('input', () => {
      this.query = this.searchInput.value.trim();
      this._renderList();
    });
    const add = Dom.el('button', { class: 'todo-new primary', title: 'Add a to-do',
      html: Icons.plus + '<span>New to-do</span>' });
    add.addEventListener('click', () => this.openComposer());
    // View + search + New to-do are wrapped as one group so the toolbar can only ever break *between*
    // the pills and the tools — never leaving a control stranded on a line of its own.
    const tools = Dom.el('div', { class: 'todo-pg-tools' },
      [this._viewControl(), this.searchInput, add]);
    return Dom.el('div', { class: 'todo-pg-toolbar' }, [pills, tools]);
  }

  // ---- the Display menu (TASK-7): group by / sort by ----
  /** The Display popover: one button opening a menu of Group-by / Sort-by selects. Built in the same
   *  shape as the building page's `FloorViewMenu` and reusing its `.view-menu*` styling and open/close
   *  mechanics — the two are kept as independent standalone popovers rather than a shared class, the
   *  same call `FloorViewMenu` already makes. Held on `this` so `_toggleView` can anchor and fill it. */
  _viewControl() {
    this._viewBtn = Dom.el('button', { class: 'tb-labeled todo-pg-view',
      title: 'Group and sort the to-do list', html: Icons.sliders + '<span>View</span>' });
    this._viewPop = Dom.el('div', { class: 'view-menu' });
    this._viewWrap = Dom.el('div', { class: 'view-menu-wrap' }, [this._viewBtn, this._viewPop]);
    this._paintView();
    // stopPropagation so the just-opened popover isn't immediately closed by the document handler.
    this._viewBtn.addEventListener('click', (e) => { e.stopPropagation(); this._toggleView(); });
    return this._viewWrap;
  }

  /** (Re)fill the popover from the current axes — called on build and after a Reset (which changes
   *  what the selects should show). A single-select change repaints only the list, not the popover. */
  _paintView() {
    this._viewPop.textContent = '';
    this._viewPop.append(
      this._vSelect('Group by', TODO_PG_GROUPS.map(g => [g.key, g.label]), this.group,
        (v) => this._setGroup(v)),
      this._vSelect('Sort by', TodoModel.SORTS.map(s => [s.key, s.label]), this.sort,
        (v) => this._setSort(v)),
      Dom.el('div', { class: 'view-sep' }),
      this._vResetRow());
  }

  _vRow(labelText, control) {
    return Dom.el('label', { class: 'view-row' }, [Dom.el('span', {}, labelText), control]);
  }

  _vSelect(labelText, options, value, onChange) {
    const sel = Dom.el('select', {});
    for (const [v, l] of options) {
      const o = Dom.el('option', { value: v }, l);
      if (v === value) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener('change', () => onChange(sel.value));
    return this._vRow(labelText, sel);
  }

  _vResetRow() {
    const btn = Dom.el('button', { class: 'view-reset', type: 'button' }, 'Reset to defaults');
    btn.addEventListener('click', () => {
      this.group = 'location';
      this.sort = 'smart';
      this._saveView();
      this._paintView();
      this._renderList();
    });
    return Dom.el('div', { class: 'view-row view-row-action' }, btn);
  }

  /** Group/sort changes only re-order and re-bucket what's already shown — the per-pill counts are
   *  facility-wide and independent of the view — so a change repaints the list, not the whole page. */
  _setGroup(group) { this.group = group; this._saveView(); this._renderList(); }
  _setSort(sort) { this.sort = sort; this._saveView(); this._renderList(); }

  _toggleView() {
    this._viewPop.classList.contains('open') ? this._closeView() : this._openView();
  }

  _openView() {
    // The popover is `position: fixed` (shared `.view-menu` CSS) to escape any overflow clip, so
    // anchor it to the button's current viewport rect — just under it, right edges aligned.
    const r = this._viewBtn.getBoundingClientRect();
    this._viewPop.style.top = Math.round(r.bottom + 6) + 'px';
    this._viewPop.style.right = Math.round(window.innerWidth - r.right) + 'px';
    this._viewPop.classList.add('open');
    this._viewBtn.classList.add('active');
    // Close on any outside click or Escape; both handlers are removed again on close.
    this._onViewDoc = (e) => { if (!this._viewWrap.contains(e.target)) this._closeView(); };
    this._onViewKey = (e) => { if (e.key === 'Escape') this._closeView(); };
    document.addEventListener('click', this._onViewDoc);
    document.addEventListener('keydown', this._onViewKey);
  }

  _closeView() {
    this._viewPop.classList.remove('open');
    this._viewBtn.classList.remove('active');
    if (this._onViewDoc) document.removeEventListener('click', this._onViewDoc);
    if (this._onViewKey) document.removeEventListener('keydown', this._onViewKey);
    this._onViewDoc = this._onViewKey = null;
  }

  _composerHost() {
    this.composerHost = Dom.el('div', { class: 'todo-pg-composer-host' });
    return this.composerHost;
  }

  _setFilter(key) {
    this.filter = key;
    for (const f of TODO_PG_FILTERS) {
      const on = f.key === key;
      this.filterBtns[f.key].btn.classList.toggle('active', on);
      this.filterBtns[f.key].btn.setAttribute('aria-pressed', String(on));
    }
    this._renderList();
  }

  // ---- data ----
  /** Both loads run together: the to-dos and the rooms they name are independent fetches, and the
   *  page can't render without either. A failure of either degrades to an inline message (the same
   *  shape `FloorTodo.load` uses) rather than a blank stage. */
  async _load() {
    try {
      const [byFloor] = await Promise.all([
        Api.get('/api/todos/all'),
        this.app.ensureFloorData(),
      ]);
      this.byFloor = byFloor;
      this.loaded = true;
    } catch (e) {
      this.listEl.textContent = '';
      this.listEl.append(Dom.el('div', { class: 'todo-empty' },
        'Could not load to-dos: ' + e.message));
      return;
    }
    this._render();
  }

  /** Every floor in the facility, in manifest order, as
   *  `{building, floor, key, rooms, entries}`.
   *
   *  A room is listable only if it's **drawn AND assigned** (a polygon *and* a bound Location) —
   *  the same rule every to-do surface applies (§10 *To-do*): an unbound scribble isn't a place
   *  you'd track work against. Entries are driven by that room set, so a to-do whose room was
   *  unbound drops out of the list while its record waits in `byFloor` for a re-bind. Each entry
   *  pairs the to-do with the room/floor/building it belongs to, which is what lets a flat sort
   *  across the whole facility still render a row that knows where it lives. */
  _floors() {
    const out = [];
    for (const b of this.store.manifest.buildings) {
      for (const f of b.floors) {
        const key = Util.floorKey(b.dir, f.id);
        const rec = this.store.annotations[key];
        const rooms = ((rec && rec.rooms) || []).filter(r => r.location && (r.polygon || []).length);
        const byRoom = this.byFloor[key] || {};
        const entries = [];
        for (const room of rooms) {
          for (const todo of (byRoom[room.id] || [])) {
            entries.push({ todo, room, building: b, floor: f, key });
          }
        }
        out.push({ building: b, floor: f, key, rooms, entries });
      }
    }
    return out;
  }

  _roomName(room) {
    return room.label || (room.location && room.location.name) || room.id;
  }

  /** Whether an entry survives the active filter + search box. The search spans the fields a person
   *  would actually recall — what the job was, and where it is. Case folding happens **here**, not
   *  where `query` is set: a match rule that silently required its caller to pre-lowercase would
   *  break the first time anything else set the query. */
  _matches(e) {
    const f = TODO_PG_FILTERS.find(x => x.key === this.filter);
    if (f && !f.match(e.todo)) return false;
    if (!this.query) return true;
    const q = this.query.toLowerCase();
    return [e.todo.text, this._roomName(e.room), e.building.name, e.floor.label]
      .some(s => (s || '').toLowerCase().includes(q));
  }

  // ---- render ----
  _render() {
    this._renderCounts();
    this._renderList();
  }

  /** The per-pill counts, over the **whole** facility — deliberately unfiltered by the search box,
   *  so they stay a fixed reading of the facility's health rather than a restatement of whatever is
   *  typed. A count that moved when you typed would be lying.
   *
   *  `zero` is what keeps the semantic colours honest: an Overdue pill reading 0 has nothing to
   *  warn about, so it goes quiet instead of shouting red at a facility that is fine. */
  _renderCounts() {
    const todos = this._floors().flatMap(fl => fl.entries.map(e => e.todo));
    for (const f of TODO_PG_FILTERS) {
      const n = todos.filter(f.match).length;
      this.filterBtns[f.key].count.textContent = String(n);
      this.filterBtns[f.key].count.classList.toggle('zero', n === 0);
    }
  }

  /** Paint the list in the active view (TASK-7): the `location` group axis renders the historical
   *  Building → Floor tree; every other axis renders one filtered, sorted entry list bucketed by that
   *  axis into a single level. The rows are the same `_item`s either way — only the wrapping differs. */
  _renderList() {
    if (!this.loaded) return;
    this.listEl.textContent = '';
    if (this.group === 'location') return this._renderLocation();
    const entries = this._sortEntries(
      this._floors().flatMap(fl => fl.entries).filter(e => this._matches(e)));
    if (!entries.length) return this._renderEmpty();
    for (const g of this._groups(entries)) this.listEl.append(this._genericGroup(g));
  }

  /** The historical Building → Floor tree (the `location` axis; the default). Only floors with
   *  matching work render, and only buildings with such a floor — a facility has far more floors than
   *  floors-with-to-dos, and listing the empty ones would bury the handful that matter (the same
   *  reasoning that made FloorTodo's list flat). */
  _renderLocation() {
    const all = this._floors();
    const groups = [];
    for (const b of this.store.manifest.buildings) {
      const floors = all.filter(
        fl => fl.building.dir === b.dir && fl.entries.some(e => this._matches(e)));
      if (floors.length) groups.push(this._buildingGroup(b, floors));
    }
    if (!groups.length) return this._renderEmpty();
    for (const g of groups) this.listEl.append(g);
  }

  /** `entries` sorted by the active sort axis — a copy, so the cached `byFloor`-derived arrays are
   *  never reordered underneath. `comparator` is handed the `.todo` off each entry, so a row keeps
   *  the room/floor/building it came from. Same shared vocabulary every to-do surface sorts by. */
  _sortEntries(entries) {
    const cmp = TodoModel.comparator(this.sort, this._userId());
    return [...entries].sort((a, b) => cmp(a.todo, b.todo));
  }

  /** Bucket the already-sorted `entries` by the active non-`location` group axis, as
   *  `[{label, entries}]` with the empties dropped; this only partitions and never re-sorts. `none`
   *  is a single unlabelled bucket — the flat list. `assignee` buckets by the viewer's relationship
   *  to the work (Mine / Others / Unassigned), not per-user: that answers "what am I responsible
   *  for?" and lands a multi-assignee to-do in exactly one bucket instead of duplicating it under
   *  every assignee. `priority`/`status` read their labels from the shared `TodoModel` vocabularies,
   *  so a heading matches the chips beneath it. */
  _groups(entries) {
    if (this.group === 'none') return [{ label: null, entries }];
    if (this.group === 'assignee') {
      const uid = this._userId();
      return this._bucketize(entries, [
        { label: 'Assigned to me', match: (t) => TodoModel.assignedTo(t, uid) },
        { label: 'Assigned to others',
          match: (t) => (t.assignees || []).length && !TodoModel.assignedTo(t, uid) },
        { label: 'Unassigned', match: (t) => !(t.assignees || []).length },
      ]);
    }
    if (this.group === 'priority') {
      return this._bucketize(entries, TodoModel.PRIORITIES.map(
        p => ({ label: p.label + ' priority', match: (t) => t.priority === p.key })));
    }
    return this._bucketize(entries, TodoModel.STATUSES.map(
      s => ({ label: s.label, match: (t) => t.status === s.key })));
  }

  /** Partition `entries` into the ordered `buckets` by each bucket's `match(todo)`, dropping the
   *  empties. The axes above are mutually exclusive, so an entry lands in at most one bucket and no
   *  row is duplicated. */
  _bucketize(entries, buckets) {
    return buckets
      .map(b => ({ label: b.label, entries: entries.filter(e => b.match(e.todo)) }))
      .filter(b => b.entries.length);
  }

  /** One bucket in a non-`location` view: an optional heading (label + how many rows it holds) then
   *  its rows. `none` passes a null label — the flat list, no heading. The count is the bucket's
   *  displayed size, not a facility-wide "open" tally: these buckets are dynamic partitions of the
   *  current filter, so the honest number is simply what's in them (the per-filter facility totals
   *  stay on the toolbar pills, which never move). */
  _genericGroup(g) {
    const rows = g.entries.map(e => this._item(e));
    if (!g.label) return Dom.el('div', { class: 'todo-pg-flat' }, rows);
    const head = Dom.el('div', { class: 'todo-pg-group-head' }, [
      Dom.el('span', { class: 'todo-pg-group-name', title: g.label }, g.label),
      Dom.el('span', { class: 'todo-count' }, String(g.entries.length)),
    ]);
    return Dom.el('div', { class: 'todo-pg-group' },
      [head, Dom.el('div', { class: 'todo-pg-group-body' }, rows)]);
  }

  _renderEmpty() {
    const f = TODO_PG_FILTERS.find(x => x.key === this.filter);
    const msg = this.query
      ? 'No to-dos match “' + this.query + '”.'
      : 'No ' + f.empty + ' to-dos anywhere in this facility.';
    this.listEl.append(Dom.el('div', { class: 'todo-empty' }, msg));
  }

  _buildingGroup(building, floors) {
    const open = floors.reduce(
      (n, fl) => n + fl.entries.filter(e => e.todo.status !== 'completed').length, 0);
    const head = Dom.el('div', { class: 'todo-pg-bld-head' }, [
      Dom.el('span', { class: 'todo-pg-bld-name', title: building.name }, building.name),
      Dom.el('span', { class: 'todo-count' }, open ? open + ' open' : 'none open'),
    ]);
    return Dom.el('div', { class: 'todo-pg-bld' },
      [head, ...floors.map(fl => this._floorGroup(fl))]);
  }

  /** One floor: a header of at-a-glance state, then its matching to-dos. The header's numbers
   *  describe the **floor**, not the filtered view — a progress bar that moved when you typed in
   *  the search box would be lying about the floor. */
  _floorGroup(fl) {
    const collapsed = !!this.collapsed[fl.key];
    // Sort the entries, not the bare to-dos: each row needs the room/floor it came from, and the
    // comparator is handed the `.todo` off each one. Same active sort axis as the flat views.
    const items = this._sortEntries(fl.entries.filter(e => this._matches(e)));
    const body = Dom.el('div', { class: 'todo-pg-floor-body' }, items.map(e => this._item(e)));
    body.hidden = collapsed;

    const caret = Dom.el('span', { class: 'todo-caret', html: Icons.chevron });
    // The floor this session was last on (TASK-5) gets a quiet "you were here" anchor on its header
    // (a soft accent, styled in CSS) rather than a loud "Current" badge — inherently understood
    // without reading a label. The tooltip + `aria-current` keep the meaning discoverable and
    // accessible. Nothing is marked on a cold entry to #/todo (`lastFloor` null).
    const current = this._isCurrentFloor(fl);
    const head = Dom.el('div', {
      class: 'todo-pg-floor-head' + (collapsed ? '' : ' open') + (current ? ' current' : ''),
      ...(current ? { 'aria-current': 'location', title: 'The floor you were last viewing' } : {}),
    }, [caret, ...this._floorMeta(fl)]);
    head.addEventListener('click', () => {
      this.collapsed[fl.key] = !this.collapsed[fl.key];
      head.classList.toggle('open', !this.collapsed[fl.key]);
      body.hidden = !!this.collapsed[fl.key];
    });
    return Dom.el('div', { class: 'todo-pg-floor' }, [head, body]);
  }

  /** Is `fl` the floor this session was last on (App.lastFloor)? Drives the header's quiet
   *  "you were here" anchor in `_floorGroup`. `null` (a cold entry to #/todo) marks nothing. */
  _isCurrentFloor(fl) {
    const last = this.app.lastFloor;
    return !!(last && last.dir === fl.building.dir && last.fid === fl.floor.id);
  }

  _floorMeta(fl) {
    const total = fl.entries.length;
    const done = fl.entries.filter(e => e.todo.status === 'completed').length;
    const open = total - done;
    const overdue = fl.entries.filter(e => TodoModel.isOverdue(e.todo)).length;

    const out = [Dom.el('span', { class: 'todo-pg-floor-name', title: fl.floor.label },
      fl.floor.label)];
    out.push(Dom.el('span', { class: 'todo-count' }, open + ' open'));
    if (overdue) {
      out.push(Dom.el('span', { class: 'todo-pg-overdue', title: overdue + ' overdue' },
        overdue + ' overdue'));
    }
    const open_ = Dom.el('button', { class: 'todo-pg-open', title: 'Open this floor plan' },
      'Open plan →');
    // The header itself toggles the group, so this must not also collapse it on the way through.
    open_.addEventListener('click', (e) => {
      e.stopPropagation();
      this.app.navOrigin = 'todo';   // breadcrumb the way back to this list (App.rootCrumbs)
      // `navigateOut`, not `go`: in the dashboard-widget embed the chrome-free card has no
      // breadcrumbs to drill through, so this escapes to the full map in the top window (§10).
      this.app.navigateOut('/f/' + encodeURIComponent(fl.building.dir) + '/'
        + encodeURIComponent(fl.floor.id));
    });
    out.push(open_);
    return out;
  }

  // ---- one row ----
  /** Clicking the row opens the room on its floor plan; the status pills (TASK-6) are the one
   *  mutation this page hosts inline — full edit and delete still live only on `FloorTodo`. Reuses
   *  the shared chip classes so a to-do reads the same here as it does in the floor panel. */
  _item({ todo, room, building, floor }) {
    const mine = TodoModel.assignedTo(todo, this._userId());
    const parts = [Dom.el('div', { class: 'todo-item-text' }, todo.text),
      this._meta(todo, room, { building, floor })];
    if (todo.notes) {
      parts.push(Dom.el('div', { class: 'todo-notes', title: todo.notes }, todo.notes));
    }
    parts.push(this._pills(todo, room));
    // `role=button` on a div rather than a real <button>: the row's content is block-level (text,
    // chip row, notes) and a <button> may only contain phrasing content. Focusable and
    // Enter/Space-activated so it stays reachable without a pointer.
    const row = Dom.el('div', {
      class: 'todo-item todo-pg-item status-' + todo.status + (mine ? ' mine' : ''),
      role: 'button', tabindex: '0',
      title: 'Show ' + this._roomName(room) + ' on the ' + floor.label + ' plan',
    }, parts);
    // The room's own uid, not its Location slug: both resolve (`FloorEditor._resolveFocusSeg`), but
    // the uid is unique per floor by construction and needs no binding to still be addressable.
    const open = () => {
      this.app.navOrigin = 'todo';   // breadcrumb the way back to this list (App.rootCrumbs)
      // `navigateOut`, not `go`: the embed escapes a drill-in to the full map in the top window,
      // since the chrome-free card has no breadcrumbs to return through (§10).
      this.app.navigateOut('/r/' + encodeURIComponent(building.dir)
        + '/' + encodeURIComponent(floor.id) + '/' + encodeURIComponent(room.id));
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    return row;
  }

  /** The status pills (TASK-6), ported from `FloorTodo._pills` so the two surfaces render the same
   *  vocabulary the same way. Unlike the floor panel's row, this page's row is itself a clickable
   *  `role=button` that opens the deep link — so, unlike `FloorTodo._pills`, this wrapper must stop
   *  both `click` and `keydown` from reaching it. `keydown` needs its own guard: a native `<button>`
   *  fires the Enter/Space `keydown` up through the DOM before the browser synthesizes the resulting
   *  `click`, so a click-only guard would still let the row's own keydown handler navigate away on a
   *  keyboard activation. Stopping propagation once on the wrapping `<div>`, rather than per button,
   *  also covers a bare click on the already-active pill (which has no `_setStatus` listener of its
   *  own to stop it). */
  _pills(todo, room) {
    const div = Dom.el('div', { class: 'todo-pills' }, TodoModel.STATUSES.map(s => {
      const b = Dom.el('button', {
        class: 'todo-pill' + (todo.status === s.key ? ' active' : ''),
        title: 'Mark ' + s.label.toLowerCase(),
      }, s.label);
      if (todo.status !== s.key) b.addEventListener('click', () => this._setStatus(todo, room, s.key));
      return b;
    }));
    div.addEventListener('click', (e) => e.stopPropagation());
    div.addEventListener('keydown', (e) => e.stopPropagation());
    return div;
  }

  /** The meta chip row: [building · floor ·] room · priority · assignees · due. Carries the place as
   *  well as the room — the whole point of this surface is that a row can come from anywhere. */
  _meta(todo, room, place) {
    const chips = [
      Dom.el('span', { class: 'todo-chip todo-room-chip', title: this._roomName(room) },
        [Dom.el('span', { class: 'todo-room-dot' }), Dom.el('span', {}, this._roomName(room))]),
      this._priorityChip(todo),
    ];
    // Under `location` grouping the building/floor is the group heading above the row, so a place
    // chip would just repeat it; in every flat/grouped view the row must name where it lives itself.
    if (place && this.group !== 'location') chips.unshift(this._placeChip(place));
    const avatars = this._avatars(todo);
    if (avatars) chips.push(avatars);
    if (todo.due) chips.push(this._dueChip(todo));
    return Dom.el('div', { class: 'todo-meta' }, chips);
  }

  /** A "Building · Floor" chip, shown leading a row when the list isn't grouped by location so a flat
   *  or by-assignee/priority/status row still says where the work is. */
  _placeChip({ building, floor }) {
    const label = building.name + ' · ' + floor.label;
    return Dom.el('span', { class: 'todo-chip todo-pg-place', title: label }, label);
  }

  _priorityChip(todo) {
    const p = TodoModel.PRIORITIES.find(x => x.key === todo.priority);
    return Dom.el('span', { class: 'todo-prio prio-' + todo.priority,
      title: (p ? p.label : todo.priority) + ' priority' },
      [Dom.el('span', { class: 'todo-prio-dot' }), Dom.el('span', {}, p ? p.short : todo.priority)]);
  }

  _avatars(todo) {
    const users = todo.assignees || [];
    if (!users.length) return null;
    const shown = users.slice(0, TODO_PG_AVATAR_MAX);
    const rest = users.slice(TODO_PG_AVATAR_MAX);
    const els = shown.map(u => Dom.el('span', { class: 'todo-avatar', title: u.display }, u.initials));
    if (rest.length) {
      els.push(Dom.el('span', { class: 'todo-avatar todo-avatar-more',
        title: rest.map(u => u.display).join(', ') }, '+' + rest.length));
    }
    return Dom.el('span', { class: 'todo-avatars' }, els);
  }

  _dueChip(todo) {
    const overdue = TodoModel.isOverdue(todo);
    return Dom.el('span', { class: 'todo-chip todo-due' + (overdue ? ' overdue' : ''),
      title: (overdue ? 'Overdue — due ' : 'Due ') + todo.due }, TodoModel.dueLabel(todo.due));
  }

  // ---- the composer ----
  /** Open the create form. `TodoComposer` owns room · task · priority · assignees · notes · due; the
   *  Building + Floor selects above it are this page's addition, because a facility-wide form has no
   *  floor implied by context the way the floor panel's does. Built on first use and kept alive
   *  thereafter (§10): a re-render must not eat a half-written draft. */
  openComposer() {
    if (!this.composer) {
      this.bldSel = Dom.el('select', { class: 'todo-c-input', 'aria-label': 'Building' });
      this.floorSel = Dom.el('select', { class: 'todo-c-input', 'aria-label': 'Floor' });
      this.bldSel.addEventListener('change', () => { this._fillFloors(); this._syncRooms(); });
      this.floorSel.addEventListener('change', () => this._syncRooms());
      this._fillBuildings();
      this._fillFloors();
      this.composer = new TodoComposer({
        rooms: this._composerRooms(),
        loadUsers: (q) => this.app.netbox.users(q).then(r => r.users),
        onSubmit: (payload) => this._add(payload),
        onCancel: () => this.closeComposer(),
      });
      this.scopeEl = Dom.el('div', { class: 'todo-pg-scope' }, [
        Dom.el('label', { class: 'todo-c-field' },
          [Dom.el('span', { class: 'todo-c-label' }, 'Building'), this.bldSel]),
        Dom.el('label', { class: 'todo-c-field' },
          [Dom.el('span', { class: 'todo-c-label' }, 'Floor'), this.floorSel]),
      ]);
    }
    if (!this.composer.el.isConnected) {
      this.composerHost.append(this.scopeEl, this.composer.el);
    }
    this.composer.focusRoom();
  }

  closeComposer() {
    if (this.composer) this.composer.reset();
    this.composerHost.textContent = '';
  }

  _fillBuildings() {
    // Only buildings that actually have a floor with a to-do-able room can host a to-do; offering
    // the rest would lead to a Floor select with nothing in it.
    const all = this._floors();
    const bldgs = this.store.manifest.buildings.filter(
      b => all.some(fl => fl.building.dir === b.dir && fl.rooms.length));
    this.bldSel.textContent = '';
    for (const b of bldgs) this.bldSel.append(Dom.el('option', { value: b.dir }, b.name));
    if (!bldgs.length) this.bldSel.append(Dom.el('option', { value: '' }, 'No buildings'));
  }

  _fillFloors() {
    const keep = this.floorSel.value;
    const floors = this._floors().filter(
      fl => fl.building.dir === this.bldSel.value && fl.rooms.length);
    this.floorSel.textContent = '';
    for (const fl of floors) {
      this.floorSel.append(Dom.el('option', { value: fl.floor.id }, fl.floor.label));
    }
    if (keep && floors.some(fl => fl.floor.id === keep)) this.floorSel.value = keep;
  }

  /** The floor the composer is currently pointed at, or null when the selects can't name one. */
  _composerFloor() {
    return this._floors().find(fl => fl.building.dir === this.bldSel.value
      && fl.floor.id === this.floorSel.value) || null;
  }

  _composerRooms() {
    const fl = this._composerFloor();
    return fl ? fl.rooms.map(r => ({ id: r.id, label: this._roomName(r) })) : [];
  }

  /** Re-point the composer's room options at the chosen floor. `setRooms` keeps the draft (that's
   *  what it exists for), so switching floors mid-draft costs the user only the room. */
  _syncRooms() {
    if (this.composer) this.composer.setRooms(this._composerRooms());
  }

  // ---- mutations (server-enforced; a denied write toasts the server's message) ----
  /** Create from the composer's payload, scoped to the floor its selects name. Rethrows on failure
   *  so `TodoComposer` keeps the draft instead of resetting a form whose to-do was never saved. */
  async _add(payload) {
    const fl = this._composerFloor();
    if (!fl) {
      Toast.show('Pick a building and floor first.', true);
      throw new Error('no floor selected');
    }
    try {
      const todo = await Api.post('/api/todos', { floor_key: fl.key, ...payload });
      const byRoom = this.byFloor[fl.key] = this.byFloor[fl.key] || {};
      (byRoom[payload.room_id] = byRoom[payload.room_id] || []).push(todo);
      this._render();
    } catch (e) {
      Toast.show('Could not add to-do: ' + e.message, true);
      throw e;
    }
  }

  /** Set a to-do's status from its inline pills (TASK-6). Mirrors `FloorTodo._setStatus`. Calls the
   *  full `_render()`, not just `_renderList()` — a status change can move the per-pill counts
   *  (`_renderCounts`) as well as which filter bucket the row belongs to, so both must catch up. */
  async _setStatus(todo, room, status) {
    try {
      const updated = await Api.post('/api/todos/' + todo.id, { status });
      todo.status = updated.status;
      this._render();
    } catch (e) {
      Toast.show('Could not update to-do: ' + e.message, true);
    }
  }
}
