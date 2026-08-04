'use strict';
/* mobile-todo-page.js — MobileTodoPage: the phone build of the facility-wide to-do page (MOBILE-9).

   A *separate surface*, not a retuned one. `TodoPage` is the desktop `#/todo` page — a toolbar card
   of five counted pills, a "View" popover of two <select>s, a two-level Building → Floor
   collapsible tree, and rows carrying three inline status pills inside a row that is itself
   clickable. That shape answers "configure a view of the whole facility" with a mouse. This class
   answers the questions a phone is actually holding:

     1. "What's open where I'm standing?"   — the floor you were last on is hoisted to the top of
                                               the list (`app.lastFloor`), not buried two levels
                                               down a tree you have to expand.
     2. "I just did this."                  — ONE tap on a 44px circle marks it done, with an Undo
                                               toast, because a mis-tap in a closet with gloves on
                                               is the normal case, not the exceptional one.
     3. "What's slipping?"                  — counted filter chips (Open · Overdue leading) sit in
                                               the first screenful; no popover to open first.
     4. "Log it before I forget."           — one thumb-reachable button opens a capture sheet with
                                               Building/Floor already pre-filled from that same
                                               last floor, so the common case is: type it, tap Add.

   Everything else follows from those: big targets, 16px fields, bottom sheets rather than inline
   density, no hover-dependent affordance anywhere, and a fixed header over a single scrolling list
   so nothing shifts under the thumb mid-scroll.

   **The desktop page is untouched by this file** — it is a sibling, not a subclass, and it owns a
   `.mtodo-*` CSS prefix of its own so no selector here can reach `.todo-*`/`.todo-pg-*`.
   `App.showTodo()` picks between the two at mount (see `_installBreakpointWatch` for what happens
   when the viewport crosses the breakpoint mid-session).

   **What it shares rather than restates** (§10 *To-do* — the ordering and the create form are
   defined once and *hosted*, never re-implemented): `TodoModel` for the status/priority vocabulary,
   overdue/due-label rules, the sort axes and every comparator; `TodoComposer`, unmodified, for the
   create form; and `TodoChips`' **rules** — the room-name fallback, the priority label, the overdue
   tooltip, the avatar cap and its overflow (QUAL-10). It takes those rules and paints its own
   `.mtodo-*` spans rather than calling `TodoChips`' `.todo-*` builders: sharing the rule is what
   stops the two surfaces drifting, while the markup stays this file's, per the prefix rule above.
   The API contract is likewise the desktop page's: `GET /api/todos/all` for the
   `floor_key -> room_id -> [todo]` rollup, `POST /api/todos` to create, `POST /api/todos/<id>` for
   status. Like the desktop page it hosts exactly ONE mutation inline — status — and leaves full
   edit and delete to `FloorTodo`; that boundary is deliberate and must not grow here either. */

//: The filter chips, left to right. Each is both the predicate and the count the chip shows, so a
//: number and the list it filters to can never disagree. Ordered for a phone: "what's open" then
//: "what's late" lead, because those are the two questions someone standing in a building has.
//: Every surface owns its own chip set (FloorTodo's is All/Planned/In progress/Done, TodoPage's
//: leads Open/Planned) — only the status *vocabulary* underneath is shared, via TodoModel.
const MTODO_FILTERS = [
  { key: 'open', label: 'Open', empty: 'open', match: (t) => t.status !== 'completed' },
  { key: 'overdue', label: 'Overdue', empty: 'overdue', match: (t) => TodoModel.isOverdue(t) },
  { key: 'in_progress', label: 'In progress', empty: 'in-progress',
    match: (t) => t.status === 'in_progress' },
  { key: 'planned', label: 'Planned', empty: 'planned', match: (t) => t.status === 'planned' },
  { key: 'completed', label: 'Completed', empty: 'completed',
    match: (t) => t.status === 'completed' },
];

//: The Arrange sheet's group axes. TWO, where the desktop page offers five: a phone list is one
//: level or it is nothing, so the by-assignee/priority/status bucketings — which exist to slice a
//: wide screen — collapse into the sort axis instead (Sort by priority answers "priority" without
//: a second heading level). `location` renders "Building · Floor" as one flat sticky header, never
//: the desktop tree's two.
const MTODO_GROUPS = [
  { key: 'location', label: 'By building & floor' },
  { key: 'none', label: 'One flat list' },
];

//: The phone's own arrangement key, deliberately NOT the desktop page's `facilitymap:todoView`.
//: The two pages offer different vocabularies (two group axes here, five there), and — the real
//: reason — a choice made on a phone must not silently rewrite the view a desktop user set, the
//: same instinct as "a mobile force-collapse must not persist" (§10 *Mobile layout*).
const MTODO_VIEW_KEY = 'facilitymap:todoViewMobile';

class MobileTodoPage {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.byFloor = {};        // floor_key -> { room_id: [todo, ...] }, straight from /api/todos/all
    this.filter = 'open';     // "what's left" is the question this page exists to answer
    this.query = '';
    this.loaded = false;
    this.composer = null;     // built once and kept alive, so re-opening the sheet can't eat a draft
    this._sheet = null;       // the one open bottom sheet, if any
    const view = this._loadView();
    this.group = view.group;
    this.sort = view.sort;
  }

  /** The persisted arrangement (`{group, sort}`), each validated against its own vocabulary so a
   *  stale or corrupt stored value degrades to the default rather than rendering an unknown mode.
   *  The page is re-instantiated on every `#/todo` visit, so this — not instance state — is what
   *  makes the choice stick. */
  _loadView() {
    const def = { group: 'location', sort: 'smart' };
    try {
      const raw = localStorage.getItem(MTODO_VIEW_KEY);
      const o = raw ? JSON.parse(raw) : {};
      return {
        group: MTODO_GROUPS.some(g => g.key === o.group) ? o.group : def.group,
        sort: TodoModel.SORTS.some(s => s.key === o.sort) ? o.sort : def.sort,
      };
    } catch (e) { return def; }
  }

  _saveView() {
    try {
      localStorage.setItem(MTODO_VIEW_KEY, JSON.stringify({ group: this.group, sort: this.sort }));
    } catch (e) {}
  }

  /** The viewer's user id, or null when unknown. Only ever used to float their own work, so
   *  "unknown" degrades to "nothing is mine". */
  _userId() { return (this.app.user && this.app.user.id) || null; }

  // ---- build ----
  /** Paint the shell and kick off the load. Returns immediately (the list fills in when the fetch
   *  lands) so the router is never blocked on it. */
  mount(host) {
    this.el = Dom.el('div', { class: 'mtodo' });
    // A generic plugin install has no facility until one is imported, and this page is reachable
    // from the nav on day one. Say so plainly rather than rendering an empty scaffold.
    if (!this.store.hasContent()) {
      this.el.append(Dom.el('div', { class: 'mtodo-blank' }, [
        Dom.el('h2', {}, 'No facility map yet'),
        Dom.el('p', {},
          'To-dos are tracked against rooms, so there is nothing to show until a facility map '
          + 'has been imported.'),
      ]));
      host.append(this.el);
      this._installBreakpointWatch();
      return this.el;
    }
    this.listEl = Dom.el('div', { class: 'mtodo-list' },
      Dom.el('div', { class: 'mtodo-empty' }, 'Loading…'));
    this.el.append(this._head(), this.listEl, this._fab());
    host.append(this.el);
    this._installBreakpointWatch();
    this._load();
    return this.el;
  }

  /** Re-mount through `App.showTodo()` when the viewport crosses the app's one phone breakpoint,
   *  so a rotation to landscape lands on the class that fits the width it landed at.
   *
   *  **Self-retiring rather than detach-driven, and that is the point.** These page classes are not
   *  `Editor`s — `App._detachCurrent()` only detaches `Editor` instances, and `showTodo` clears
   *  `#stage` wholesale — so there is no `detach()` hook to hang a teardown on, and a plain
   *  listener would be exactly the leak §10 *Mobile layout* warns about. The handler therefore
   *  removes itself the first time it fires, whether or not the page is still mounted: if it is,
   *  the re-mounted page installs a fresh one; if it isn't, the listener simply goes. Nothing is
   *  left observing on behalf of a page that is gone.
   *
   *  `TodoPage` deliberately gets no equivalent — it must not change — so the behaviour is
   *  asymmetric by design: a *desktop* window narrowed past the breakpoint keeps the desktop page
   *  until the next navigation, exactly as it always has. */
  _installBreakpointWatch() {
    this._mq = Util.phoneMq();
    this._onBreakpoint = () => {
      this._mq.removeEventListener('change', this._onBreakpoint);
      if (this.el.isConnected) this.app.showTodo();
    };
    this._mq.addEventListener('change', this._onBreakpoint);
  }

  /** The fixed header: one search field, the Arrange trigger beside it, and the counted filter
   *  chips on a line of their own. The chips **scroll horizontally** rather than wrapping — five
   *  finger-sized chips wrap into three ragged rows on a phone and eat the screen before a single
   *  to-do shows, and a one-line rail that slides under the thumb is the idiom a phone user already
   *  knows. It is the only horizontal scroller on the page; `<body>` itself never scrolls sideways
   *  (§10 *Mobile layout*). */
  _head() {
    this.searchInput = Dom.el('input', { class: 'mtodo-search', type: 'search',
      enterkeyhint: 'search', autocomplete: 'off',
      placeholder: 'Search to-dos, rooms, floors…', 'aria-label': 'Search to-dos' });
    this.searchInput.addEventListener('input', () => {
      this.query = this.searchInput.value.trim();
      this._renderList();
    });
    const arrange = Dom.el('button', { class: 'mtodo-arrange', type: 'button',
      title: 'Sort and group', 'aria-label': 'Sort and group', html: Icons.sliders });
    arrange.addEventListener('click', () => this._openArrange(arrange));

    this.chipEls = {};
    this.chipRow = Dom.el('div', { class: 'mtodo-chips', role: 'group',
      'aria-label': 'Filter to-dos' });
    for (const f of MTODO_FILTERS) {
      const count = Dom.el('span', { class: 'mtodo-chip-n' }, '—');
      const b = Dom.el('button', {
        class: 'mtodo-chip chip-' + f.key + (this.filter === f.key ? ' active' : ''),
        type: 'button', 'aria-pressed': String(this.filter === f.key),
      }, [Dom.el('span', {}, f.label), count]);
      b.addEventListener('click', () => this._setFilter(f.key));
      this.chipEls[f.key] = { btn: b, count };
      this.chipRow.append(b);
    }
    return Dom.el('div', { class: 'mtodo-head' }, [
      Dom.el('div', { class: 'mtodo-search-row' }, [this.searchInput, arrange]),
      this.chipRow,
    ]);
  }

  /** The capture button: bottom-anchored and right-aligned, i.e. inside the thumb arc of a hand
   *  already holding the phone — the whole reason "add a to-do on the spot" is a one-hand action
   *  here and a trip to a toolbar on the desktop page. */
  _fab() {
    const b = Dom.el('button', { class: 'mtodo-fab', type: 'button', title: 'Add a to-do',
      html: Icons.plus + '<span>New to-do</span>' });
    b.addEventListener('click', () => this._openCompose(b));
    return b;
  }

  _setFilter(key) {
    this.filter = key;
    TodoChips.markActive(this.chipEls, key);
    // Re-reading a rail the user has scrolled sideways is disorienting; snap the chosen chip back
    // into view so the active filter is always visible after the tap that set it.
    this.chipEls[key].btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this._renderList();
  }

  // ---- data ----
  /** Both loads run together: the to-dos and the rooms they name are independent fetches, and the
   *  page can't render without either. A failure of either degrades to an inline message rather
   *  than a blank stage — the same shape `TodoPage._load` and `FloorTodo.load` use. */
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
      this.listEl.append(Dom.el('div', { class: 'mtodo-empty' },
        'Could not load to-dos: ' + e.message));
      return;
    }
    this._render();
  }

  /** Every floor in the facility, in manifest order, as `{building, floor, key, rooms, entries}`.
   *
   *  A room is listable only if it's **drawn AND assigned** (a polygon *and* a bound Location) —
   *  the same rule every to-do surface applies (§10 *To-do*). Entries are driven by that room set,
   *  so a to-do whose room was unbound drops out of the list while its record waits in `byFloor`
   *  for a re-bind. Each entry pairs the to-do with the room/floor/building it belongs to, which is
   *  what lets a facility-wide sort still render a card that knows where it lives. */
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

  /** Whether an entry survives the active chip + search box. The search spans the fields a person
   *  would actually recall — what the job was, and where it is. Case folding happens **here**, not
   *  where `query` is set, so a match rule never silently requires a pre-lowercased caller. */
  _matches(e) {
    const f = MTODO_FILTERS.find(x => x.key === this.filter);
    if (f && !f.match(e.todo)) return false;
    if (!this.query) return true;
    const q = this.query.toLowerCase();
    return [e.todo.text, TodoChips.roomName(e.room), e.building.name, e.floor.label]
      .some(s => (s || '').toLowerCase().includes(q));
  }

  /** Is `fl` the floor this session was last on (`App.lastFloor`)? Drives the hoist below. `null`
   *  (a cold entry to `#/todo`) hoists nothing, which is correct: there is no "here" yet. */
  _isCurrentFloor(fl) {
    const last = this.app.lastFloor;
    return !!(last && last.dir === fl.building.dir && last.fid === fl.floor.id);
  }

  // ---- render ----
  _render() {
    this._renderCounts();
    this._renderList();
  }

  /** The per-chip counts, over the **whole** facility — deliberately unfiltered by the search box,
   *  so they stay a fixed reading of the facility's health rather than a restatement of whatever is
   *  typed. A count that moved when you typed would be lying. `zero` keeps the semantic colours
   *  honest: an Overdue chip reading 0 has nothing to warn about, so it goes quiet. */
  _renderCounts() {
    const todos = this._floors().flatMap(fl => fl.entries.map(e => e.todo));
    for (const f of MTODO_FILTERS) {
      const n = todos.filter(f.match).length;
      this.chipEls[f.key].count.textContent = String(n);
      this.chipEls[f.key].count.classList.toggle('zero', n === 0);
    }
  }

  _renderList() {
    if (!this.loaded) return;
    this.listEl.textContent = '';
    const matched = this._floors().flatMap(fl => fl.entries).filter(e => this._matches(e));
    if (!matched.length) return this._renderEmpty();
    for (const sec of this._sections(matched)) this.listEl.append(this._section(sec));
  }

  _renderEmpty() {
    const f = MTODO_FILTERS.find(x => x.key === this.filter);
    const msg = this.query
      ? 'No to-dos match “' + this.query + '”.'
      : 'No ' + f.empty + ' to-dos anywhere in this facility.';
    this.listEl.append(Dom.el('div', { class: 'mtodo-empty' }, msg));
  }

  /** `entries` sorted by the active sort axis — a copy, so the cached `byFloor`-derived arrays are
   *  never reordered underneath. The comparator is the shared `TodoModel.comparator`, handed the
   *  `.todo` off each entry so a card keeps the room/floor it came from. */
  _sortEntries(entries) {
    const cmp = TodoModel.comparator(this.sort, this._userId());
    return [...entries].sort((a, b) => cmp(a.todo, b.todo));
  }

  /** Bucket the matched entries into the list's sections — **one level, always**.
   *
   *  `none` is a single unlabelled section (the flat list). `location` buckets by floor and labels
   *  each "Building · Floor" on one line, where the desktop page nests a floor group inside a
   *  building group; two levels of heading on a 390px screen is chrome, not structure. Sections
   *  keep **manifest order** (not the sort axis, which orders *within* a section) so the list reads
   *  as a walk through the facility — except for the one hoist below.
   *
   *  **The floor you were last on comes first.** That is the whole "standing in the closet" case:
   *  the work where you are should not be something you scroll to find. It's a presentation hoist
   *  only — `App.lastFloor` stays UI-only (§10 *To-do*) and nothing routes off it. */
  _sections(entries) {
    if (this.group === 'none') {
      return [{ key: null, label: null, entries: this._sortEntries(entries) }];
    }
    const by = new Map();
    for (const e of entries) {
      if (!by.has(e.key)) by.set(e.key, []);
      by.get(e.key).push(e);
    }
    const secs = [];
    for (const fl of this._floors()) {
      const list = by.get(fl.key);
      if (!list || !list.length) continue;
      secs.push({
        key: fl.key, label: fl.building.name + ' · ' + fl.floor.label,
        building: fl.building, floor: fl.floor, entries: this._sortEntries(list),
        current: this._isCurrentFloor(fl),
      });
    }
    const here = secs.findIndex(s => s.current);
    if (here > 0) secs.unshift(secs.splice(here, 1)[0]);
    return secs;
  }

  /** One section: a sticky one-line header, then its cards. The header carries a **Plan →** button
   *  (the same door out the desktop page's floor header offers) as a real target of its own rather
   *  than making the whole sticky header tappable — a header that slides under a scrolling thumb
   *  must not be armed. `none` passes a null label and renders bare cards. */
  _section(sec) {
    const cards = sec.entries.map(e => this._card(e));
    if (!sec.label) return Dom.el('div', { class: 'mtodo-flat' }, cards);

    const name = Dom.el('span', { class: 'mtodo-sec-name', title: sec.label }, sec.label);
    const plan = Dom.el('button', { class: 'mtodo-sec-plan', type: 'button',
      title: 'Open the ' + sec.floor.label + ' floor plan' }, 'Plan →');
    plan.addEventListener('click', () => this._openFloor(sec.building, sec.floor));
    const parts = [name];
    // Where the desktop page marks the last-viewed floor with a quiet visual anchor, the phone says
    // it: this section has been moved out of manifest order, and an unexplained reorder reads as a
    // bug. `aria-current` carries the same meaning to a screen reader.
    if (sec.current) parts.push(Dom.el('span', { class: 'mtodo-sec-here' }, 'You were here'));
    parts.push(plan);
    const head = Dom.el('div', {
      class: 'mtodo-sec-head' + (sec.current ? ' current' : ''),
      ...(sec.current ? { 'aria-current': 'location' } : {}),
    }, parts);
    return Dom.el('div', { class: 'mtodo-sec' },
      [head, Dom.el('div', { class: 'mtodo-sec-body' }, cards)]);
  }

  // ---- one card ----
  /** A card is two targets and nothing else: the **tick** (done / not done, the one action this
   *  page exists to make instant) and the **body** (everything else, in a sheet). That is the
   *  deliberate split from the desktop row, which packs three status pills *and* a navigation
   *  target into a single line — three small adjacent hit areas inside a fourth is precisely the
   *  pattern that misfires under a thumb.
   *
   *  The body is a focusable `role=button` div rather than a real `<button>` because its content is
   *  block-level and a `<button>` may only contain phrasing content — the same reason
   *  `TodoPage._item` does it. The tick, a real `<button>` nested inside it, therefore stops both
   *  `click` **and** `keydown`: a native button fires the Enter/Space `keydown` up through the DOM
   *  *before* the browser synthesizes the resulting `click`, so a click-only guard would still let
   *  the body's own handler open the sheet on a keyboard activation (§10 *To-do*). */
  _card(entry) {
    const { todo, room, building, floor } = entry;
    const done = todo.status === 'completed';
    const mine = TodoModel.assignedTo(todo, this._userId());

    const tick = Dom.el('button', {
      class: 'mtodo-tick' + (done ? ' done' : ''), type: 'button',
      'aria-pressed': String(done),
      'aria-label': (done ? 'Reopen: ' : 'Mark completed: ') + todo.text,
      title: done ? 'Mark planned' : 'Mark completed',
      html: Icons.check,
    });
    tick.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this._toggleDone(todo);
    });
    tick.addEventListener('keydown', (ev) => ev.stopPropagation());

    const body = Dom.el('div', {
      class: 'mtodo-body', role: 'button', tabindex: '0',
      'aria-label': 'Details: ' + todo.text,
    }, [
      Dom.el('div', { class: 'mtodo-text' }, todo.text),
      this._meta(todo, room, { building, floor }),
    ]);
    const open = () => this._openDetail(entry, body);
    body.addEventListener('click', open);
    body.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
    });

    return Dom.el('div', {
      class: 'mtodo-card prio-' + todo.priority + ' status-' + todo.status + (mine ? ' mine' : ''),
    }, [tick, body]);
  }

  /** The card's second line: where the work is, and the two facts that change what you do about it
   *  (due date, and high priority). Medium/low priority is carried by the card's coloured left edge
   *  instead of a chip — at arm's length a colour reads faster than a word, and three priority
   *  chips on every card is noise on a narrow screen. The place chip appears only in the flat view;
   *  under `location` grouping it would just repeat the section header above it. */
  _meta(todo, room, place) {
    const chips = [Dom.el('span', { class: 'mtodo-tag mtodo-room' }, TodoChips.roomName(room))];
    if (this.group !== 'location') {
      chips.unshift(Dom.el('span', { class: 'mtodo-tag mtodo-place' },
        place.building.name + ' · ' + place.floor.label));
    }
    if (todo.due) {
      const overdue = TodoModel.isOverdue(todo);
      chips.push(Dom.el('span', { class: 'mtodo-tag mtodo-due' + (overdue ? ' overdue' : ''),
        title: TodoChips.dueTitle(todo) },
        (overdue ? 'Overdue · ' : '') + TodoModel.dueLabel(todo.due)));
    }
    if (todo.priority === 'high') {
      chips.push(Dom.el('span', { class: 'mtodo-tag mtodo-high' }, 'High'));
    }
    const who = this._avatars(todo);
    if (who) chips.push(who);
    return Dom.el('div', { class: 'mtodo-meta' }, chips);
  }

  /** The assignee shoulder. The cap-and-overflow *rule* is `TodoChips.avatarSplit` — shared, so a
   *  to-do folds the same names away on every surface — but the spans are this page's own
   *  `.mtodo-av*`, since the phone build owns its prefix and reaches no `.todo-*` selector. */
  _avatars(todo) {
    const split = TodoChips.avatarSplit(todo);
    if (!split) return null;
    const els = split.shown.map(
      u => Dom.el('span', { class: 'mtodo-av', title: u.display }, u.initials));
    if (split.rest.length) {
      els.push(Dom.el('span', { class: 'mtodo-av mtodo-av-more', title: split.moreTitle },
        '+' + split.rest.length));
    }
    return Dom.el('span', { class: 'mtodo-avs' }, els);
  }

  // ---- the bottom sheets ----
  /** One sheet mechanism, three uses (detail / arrange / capture). A sheet is `position: fixed` and
   *  out of flow (§10 *Mobile layout*: a full-screen mobile surface is never an in-flow sibling),
   *  rides above a scrim that dismisses it, closes on Escape, and returns focus to whatever opened
   *  it. Only one is ever open — opening a second closes the first — so the scrim can never be left
   *  orphaned under a sheet that has gone.
   *
   *  Not `.fm-modal`: that is a centred desktop dialog. A sheet enters from the edge the thumb is
   *  already at, which is why its actions sit at the bottom rather than the top. */
  _openSheet({ title, body, className = '', opener = null }) {
    this._closeSheet();
    const close = Dom.el('button', { class: 'mtodo-sheet-x', type: 'button',
      title: 'Close', 'aria-label': 'Close' }, '✕');
    const panel = Dom.el('div', {
      class: 'mtodo-sheet ' + className, role: 'dialog', 'aria-modal': 'true',
      'aria-label': title, tabindex: '-1',
    }, [
      Dom.el('div', { class: 'mtodo-grip' }),
      Dom.el('div', { class: 'mtodo-sheet-head' },
        [Dom.el('h2', { class: 'mtodo-sheet-title' }, title), close]),
      Dom.el('div', { class: 'mtodo-sheet-body' }, body),
    ]);
    const scrim = Dom.el('div', { class: 'mtodo-scrim' }, panel);
    // Self-retiring, for the same reason `_installBreakpointWatch`'s listener is: a route change
    // clears `#stage` wholesale and nothing calls a teardown on this page, so a document-level
    // handler that only unbound via `_closeSheet` would outlive a sheet navigated away from.
    const onKey = (ev) => {
      if (!scrim.isConnected) { document.removeEventListener('keydown', onKey); return; }
      if (ev.key === 'Escape') { ev.stopPropagation(); this._closeSheet(); }
    };
    close.addEventListener('click', () => this._closeSheet());
    // Only a press on the scrim ITSELF dismisses — the panel is its child, so without this test a
    // tap anywhere inside the sheet would close it.
    scrim.addEventListener('click', (ev) => { if (ev.target === scrim) this._closeSheet(); });
    document.addEventListener('keydown', onKey);

    this._sheet = { scrim, onKey, opener };
    this.el.append(scrim);
    panel.focus();
    return panel;
  }

  _closeSheet() {
    if (!this._sheet) return;
    const { scrim, onKey, opener } = this._sheet;
    this._sheet = null;
    document.removeEventListener('keydown', onKey);
    scrim.remove();
    // Returning focus is what keeps the keyboard path coherent — without it focus falls back to
    // <body> and the next Tab restarts at the top of the page.
    if (opener && opener.isConnected) opener.focus();
  }

  /** The detail sheet: the whole to-do, plus the two things you might do about it from here —
   *  change its status, or go stand in front of it. Everything else (text, priority, notes,
   *  assignees, due, delete) stays on `FloorTodo`, exactly as on the desktop page: this surface is
   *  for triage and navigation, and letting the sheet grow into a second full edit path is the
   *  boundary §10 *To-do* asks not to cross. */
  _openDetail(entry, opener) {
    const { todo, room, building, floor } = entry;
    const body = [Dom.el('p', { class: 'mtodo-d-text' }, todo.text)];
    if (todo.notes) body.push(Dom.el('p', { class: 'mtodo-d-notes' }, todo.notes));
    body.push(Dom.el('p', { class: 'mtodo-d-place' },
      building.name + ' · ' + floor.label + ' · ' + TodoChips.roomName(room)));

    const facts = [];
    facts.push(Dom.el('span', { class: 'mtodo-tag mtodo-prio prio-' + todo.priority },
      TodoChips.priorityLabel(todo) + ' priority'));
    if (todo.due) {
      const overdue = TodoModel.isOverdue(todo);
      facts.push(Dom.el('span', { class: 'mtodo-tag mtodo-due' + (overdue ? ' overdue' : '') },
        (overdue ? 'Overdue — due ' : 'Due ') + TodoModel.dueLabel(todo.due)));
    }
    for (const u of (todo.assignees || [])) {
      facts.push(Dom.el('span', { class: 'mtodo-tag' }, u.display));
    }
    body.push(Dom.el('div', { class: 'mtodo-d-facts' }, facts));

    // The 3-way status control, read from the shared vocabulary so it can't drift from the pills on
    // the other two surfaces. Full-width thirds: a segmented control is legible and hittable in a
    // way three inline pills on a card are not.
    body.push(Dom.el('span', { class: 'mtodo-d-label' }, 'Status'));
    const seg = Dom.el('div', { class: 'mtodo-seg', role: 'group', 'aria-label': 'Status' });
    for (const s of TodoModel.STATUSES) {
      const b = Dom.el('button', {
        class: 'mtodo-seg-b' + (todo.status === s.key ? ' active' : ''), type: 'button',
        'aria-pressed': String(todo.status === s.key),
      }, s.label);
      if (todo.status !== s.key) {
        b.addEventListener('click', () => { this._closeSheet(); this._setStatus(todo, s.key); });
      }
      seg.append(b);
    }
    body.push(seg);

    const go = Dom.el('button', { class: 'mtodo-d-go primary', type: 'button' },
      'Open on floor plan →');
    go.addEventListener('click', () => {
      this._closeSheet();
      this.app.navOrigin = 'todo';   // breadcrumb the way back to this list (App.rootCrumbs)
      // `navigateOut`, not `go`: in the dashboard-widget embed the chrome-free card has no
      // breadcrumbs to drill through, so this escapes to the full map in the top window (§10).
      this.app.navigateOut('/r/' + encodeURIComponent(building.dir)
        + '/' + encodeURIComponent(floor.id) + '/' + encodeURIComponent(room.id));
    });
    body.push(go);

    this._openSheet({ title: 'To-do', body, className: 'mtodo-detail', opener });
  }

  /** The Arrange sheet: sort axis + group axis, applied live so the list behind reflects each tap
   *  before the sheet is dismissed. Both are `radiogroup`s — one-of-many is exactly what they are,
   *  and the role gives arrow-key traversal to a screen reader for free. */
  _openArrange(opener) {
    const body = [
      this._radioGroup('Sort', TodoModel.SORTS.map(s => [s.key, s.label]), this.sort,
        (v) => { this.sort = v; this._saveView(); this._renderList(); }),
      this._radioGroup('Group', MTODO_GROUPS.map(g => [g.key, g.label]), this.group,
        (v) => { this.group = v; this._saveView(); this._renderList(); }),
    ];
    const done = Dom.el('button', { class: 'mtodo-d-go primary', type: 'button' }, 'Done');
    done.addEventListener('click', () => this._closeSheet());
    body.push(done);
    this._openSheet({ title: 'Arrange', body, className: 'mtodo-arrange-sheet', opener });
  }

  _radioGroup(label, options, value, onPick) {
    const rows = options.map(([v, l]) => {
      const row = Dom.el('button', {
        class: 'mtodo-radio' + (v === value ? ' active' : ''), type: 'button',
        role: 'radio', 'aria-checked': String(v === value),
      }, [Dom.el('span', { class: 'mtodo-radio-dot' }), Dom.el('span', {}, l)]);
      row.addEventListener('click', () => {
        for (const r of rows) {
          const on = r === row;
          r.classList.toggle('active', on);
          r.setAttribute('aria-checked', String(on));
        }
        onPick(v);
      });
      return row;
    });
    return Dom.el('div', { class: 'mtodo-group' }, [
      Dom.el('span', { class: 'mtodo-d-label' }, label),
      Dom.el('div', { class: 'mtodo-radios', role: 'radiogroup', 'aria-label': label }, rows),
    ]);
  }

  // ---- the capture sheet ----
  /** Open the create form. `TodoComposer` owns room · task · priority · assignees · notes · due —
   *  hosted **unmodified**, not re-implemented and not subclassed (§10 *To-do*), so a to-do created
   *  on a phone is the same act as one created anywhere else. The Building + Floor selects above it
   *  are this page's addition, for the same reason the desktop page adds them: a facility-wide form
   *  has no floor implied by context the way the floor panel's does.
   *
   *  Built on first use and kept alive thereafter (§10) — the sheet's elements are *moved* back
   *  into each new sheet rather than rebuilt, so closing and reopening can't eat a half-written
   *  draft. The scope is pre-filled from `app.lastFloor` on that first build: the phone case is
   *  "log what I just found, here", and two selects the user has to set every time is exactly the
   *  typing this surface exists to avoid. */
  _openCompose(opener) {
    if (!this.composer) {
      this.bldSel = Dom.el('select', { class: 'todo-c-input', 'aria-label': 'Building' });
      this.floorSel = Dom.el('select', { class: 'todo-c-input', 'aria-label': 'Floor' });
      this.bldSel.addEventListener('change', () => { this._fillFloors(); this._syncRooms(); });
      this.floorSel.addEventListener('change', () => this._syncRooms());
      this._fillBuildings();
      this._prefillScope();
      this._fillFloors();
      this._prefillFloor();
      this.composer = new TodoComposer({
        rooms: this._composerRooms(),
        loadUsers: (q) => this.app.netbox.users(q).then(r => r.users),
        onSubmit: (payload) => this._add(payload),
        onCancel: () => this._closeSheet(),
      });
      this.composeEl = Dom.el('div', { class: 'mtodo-compose-form' }, [
        Dom.el('label', { class: 'todo-c-field' },
          [Dom.el('span', { class: 'todo-c-label' }, 'Building'), this.bldSel]),
        Dom.el('label', { class: 'todo-c-field' },
          [Dom.el('span', { class: 'todo-c-label' }, 'Floor'), this.floorSel]),
        this.composer.el,
      ]);
    }
    this._openSheet({ title: 'New to-do', body: this.composeEl, className: 'mtodo-compose',
      opener });
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

  /** Point the Building select at the floor this session was last on, when that floor is one the
   *  composer can actually target. A no-op on a cold entry or an unlistable floor — the selects
   *  simply keep their first option, which is what they'd have shown anyway. */
  _prefillScope() {
    const last = this.app.lastFloor;
    if (!last) return;
    const fl = this._floors().find(
      f => f.building.dir === last.dir && f.floor.id === last.fid && f.rooms.length);
    if (fl) this.bldSel.value = fl.building.dir;
  }

  /** The Floor half of the same prefill, run after `_fillFloors` has put the options there. */
  _prefillFloor() {
    const last = this.app.lastFloor;
    if (!last || this.bldSel.value !== last.dir) return;
    if ([...this.floorSel.options].some(o => o.value === last.fid)) this.floorSel.value = last.fid;
  }

  /** The floor the composer is currently pointed at, or null when the selects can't name one. */
  _composerFloor() {
    return this._floors().find(fl => fl.building.dir === this.bldSel.value
      && fl.floor.id === this.floorSel.value) || null;
  }

  _composerRooms() {
    const fl = this._composerFloor();
    return fl ? fl.rooms.map(r => ({ id: r.id, label: TodoChips.roomName(r) })) : [];
  }

  /** Re-point the composer's room options at the chosen floor. `setRooms` keeps the draft (that's
   *  what it exists for), so switching floors mid-draft costs the user only the room. */
  _syncRooms() {
    if (this.composer) this.composer.setRooms(this._composerRooms());
  }

  // ---- mutations (server-enforced; a denied write toasts the server's message) ----
  /** Create from the composer's payload, scoped to the floor its selects name. Rethrows on failure
   *  so `TodoComposer` keeps the draft instead of resetting a form whose to-do was never saved.
   *
   *  On success the sheet closes and a toast confirms — the desktop page can leave its composer
   *  open beside the list because there is room for both, but a sheet covering the screen must get
   *  out of the way, and a capture that vanishes without a word reads as a failure. */
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
      this._closeSheet();
      this._render();
      Toast.show('To-do added.');
    } catch (e) {
      Toast.show('Could not add to-do: ' + e.message, true);
      throw e;
    }
  }

  /** The tick's one job: done ⟷ not done. Reopening goes back to `planned` rather than to whatever
   *  the to-do was before, because the tick is a two-state control and inventing a third answer
   *  from history would make the same tap mean different things on different cards.
   *
   *  It offers **Undo**, which the desktop pills don't need: a pill says which state it sets and is
   *  clicked with a mouse, while this is a single circle hit with a thumb, often with gloves on,
   *  and the row it belongs to usually vanishes from the active filter the moment it lands. */
  _toggleDone(todo) {
    const from = todo.status;
    const to = from === 'completed' ? 'planned' : 'completed';
    this._setStatus(todo, to, () => {
      Toast.action(to === 'completed' ? 'Marked completed.' : 'Reopened.',
        'Undo', () => this._setStatus(todo, from));
    });
  }

  /** Set a to-do's status. Mirrors `TodoPage._setStatus` — and calls the full `_render()`, not just
   *  `_renderList()`, because a status change moves the per-chip counts as well as which filter
   *  bucket the card belongs to, so both must catch up. `after` runs only on success. */
  async _setStatus(todo, status, after) {
    try {
      const updated = await Api.post('/api/todos/' + todo.id, { status });
      todo.status = updated.status;
      this._render();
      if (after) after();
    } catch (e) {
      Toast.show('Could not update to-do: ' + e.message, true);
    }
  }

  /** The floor-plan door out of a section header. Sets the origin crumb and escapes the embed for
   *  the same reasons the detail sheet's **Open on floor plan** does. */
  _openFloor(building, floor) {
    this.app.navOrigin = 'todo';
    this.app.navigateOut('/f/' + encodeURIComponent(building.dir)
      + '/' + encodeURIComponent(floor.id));
  }
}
