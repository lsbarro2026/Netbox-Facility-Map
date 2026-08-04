'use strict';
/* floor-todo.js — FloorTodo: the floor page's to-do panel (ADDON-1, redesigned in TASK-3).

   A side panel on the floor, resizable/hideable like the siteplan building index (the shared
   `Editor._installPanelResize` chrome). The whole floor's work is **one flat prioritized list**
   ordered by `TodoModel.compare` — your own to-dos first, then in-progress, then priority, then due
   date. It deliberately does *not* fold rooms into per-room folders: a floor carries 60+ rooms and
   most of them have no work, so folders buried the handful of live to-dos under a wall of empty
   ones. Each row names its room instead.

   Completed work collapses into a "Completed" group at the foot, subgrouped by room so it can be
   cleared per-room or floor-wide. It persists there until explicitly cleared — completed to-dos are
   durable user data and are never auto-deleted.

   Instantiated by `FloorEditor` (non-embed only); talks to the `/api/todos` endpoints via the `Api`
   client. The create form is a shared `TodoComposer`, the ordering a shared `TodoModel` and the
   row's chips/pills a shared `TodoChips` (QUAL-10) — all three also serve the facility-wide to-do
   page (TASK-5), so none of them belongs to this class. Editing a row
   (UX-9) opens that same `TodoComposer` in its edit mode, in place of the row: one form, so an edit
   reaches every field creating does. Like the rest
   of the map, edit affordances are shown to everyone and the server enforces the write permission
   (`change_facilitymapblob`): a denied write surfaces the server's message as a toast, exactly as
   the Edit/Save flow does. */

// Persisted panel sizing (mirrors the siteplan legend's keys so the two panels remember
// independently). Prefixed like the other UI prefs so it never collides with them.
const TODO_WIDTH_KEY = 'facilitymap:floorTodoWidth';
const TODO_COLLAPSED_KEY = 'facilitymap:floorTodoCollapsed';
const TODO_MIN_W = 240;
const TODO_COLLAPSE_W = 170;
const TODO_DEFAULT_W = 320;
const TODO_MAX_FRAC = 0.45;

//: The filter pills, left to right. `match` is null for "All" (which shows everything, with the
//: completed items tucked into their collapsed group rather than inline). `empty` is the word the
//: empty state uses — not always the pill's own label, which is squeezed to fit the pill row.
const TODO_FILTERS = [
  { key: 'all', label: 'All', match: null, empty: '' },
  { key: 'planned', label: 'Planned', match: 'planned', empty: 'planned' },
  { key: 'in_progress', label: 'In progress', match: 'in_progress', empty: 'in-progress' },
  { key: 'completed', label: 'Done', match: 'completed', empty: 'completed' },
];

class FloorTodo {
  /** @param app the App; @param floorKey the floor's `"<site>/<floor>"` key;
   *  @param rooms the floor's room records (`{id, label, polygon, location}`). */
  constructor(app, floorKey, rooms) {
    this.app = app;
    this.floorKey = floorKey;
    // A room is listable only if it's drawn (has a polygon) AND assigned (bound to a Location): an
    // unbound scribble isn't a place you'd track work against. Order follows the floor's room order.
    this.rooms = (rooms || []).filter(r => r.location && (r.polygon || []).length);
    this.byRoom = {};          // room_id -> [ {id, text, status, priority, notes, due, assignees}, ... ]
    this.filter = 'all';
    this.doneOpen = false;     // the Completed group's disclosure state
    this.loaded = false;
    this.composer = null;      // built once and kept alive, so a re-render can't eat a draft
    this.editComposer = null;  // the edit-mode form — likewise built once and kept (UX-9)
    this.editTarget = null;    // {todo, room} whose row is open for editing, or null
    this.panel = null;
    this.listEl = null;
  }

  resizeOpts() {
    return {
      title: 'Show or hide the floor to-do',
      widthKey: TODO_WIDTH_KEY, collapsedKey: TODO_COLLAPSED_KEY,
      minW: TODO_MIN_W, collapseW: TODO_COLLAPSE_W, defaultW: TODO_DEFAULT_W, maxFrac: TODO_MAX_FRAC,
    };
  }

  /** The viewer's user id, or null when unknown (standalone, no `window.MAP`). Only ever used to
   *  float their own work to the top, so "unknown" degrades to "nothing is mine". */
  _userId() { return (this.app.user && this.app.user.id) || null; }

  // ---- build ----
  /** Build the panel shell and kick off the async load. Returns the `<aside>` immediately (the list
   *  fills in when the fetch lands), so `FloorEditor.show()` is never blocked on it.
   *
   *  `opts.onClose` (optional) wires the header's ✕. It exists for the phone layout, where the panel
   *  covers the stage as its own page (`.mobile-sheet`, NAV-21) and so needs a close of its own; CSS
   *  hides the button everywhere else, since the desktop side column is closed by `#panel-toggle`
   *  and the drag handle. The panel builds the button (its header, its DOM) but the caller supplies
   *  the behaviour — collapsing the panel is `FloorEditor`'s business, not the list's. */
  build({ onClose = null } = {}) {
    this.panel = Dom.el('aside', { class: 'todo-panel' });
    this.panel.append(this._head(onClose), this._filters(), this._composerHost());
    this.listEl = Dom.el('div', { class: 'todo-list' },
      Dom.el('div', { class: 'todo-empty' }, 'Loading…'));
    this.panel.append(this.listEl);
    this.load();
    return this.panel;
  }

  _head(onClose = null) {
    this.openCountEl = Dom.el('span', { class: 'todo-open-count' });
    // The discoverable way to add a to-do. TASK-4's per-room "+" on the floor plan is a hover
    // affordance and so undiscoverable by itself; this button is the one that's always visible.
    const add = Dom.el('button', { class: 'todo-new', title: 'Add a to-do',
      html: Icons.plus + '<span>New</span>' });
    add.addEventListener('click', () => this.openComposer());
    // Mobile-sheet close (NAV-21) — built only when the caller supplied behaviour for it, and shown
    // by CSS only inside `.mobile-sheet`.
    let close = null;
    if (onClose) {
      close = Dom.el('button', { class: 'todo-close', type: 'button', title: 'Close the to-do list',
        'aria-label': 'Close the to-do list' }, '×');
      close.addEventListener('click', onClose);
    }
    return Dom.el('div', { class: 'todo-head' }, [
      Dom.el('span', { class: 'todo-head-ico', html: Icons.todo }),
      Dom.el('span', { class: 'todo-head-title' }, 'Floor to-do'),
      this.openCountEl, add, close,
    ]);
  }

  _filters() {
    this.filterBtns = {};
    const row = Dom.el('div', { class: 'todo-filters', role: 'group', 'aria-label': 'Filter to-dos' });
    for (const f of TODO_FILTERS) {
      const count = Dom.el('span', { class: 'todo-filter-n' });
      const b = Dom.el('button', { class: 'todo-filter' + (this.filter === f.key ? ' active' : ''),
        'aria-pressed': String(this.filter === f.key) }, [Dom.el('span', {}, f.label), count]);
      b.addEventListener('click', () => this._setFilter(f.key));
      this.filterBtns[f.key] = { btn: b, count };
      row.append(b);
    }
    return row;
  }

  _composerHost() {
    this.composerHost = Dom.el('div', { class: 'todo-composer-host' });
    return this.composerHost;
  }

  _setFilter(key) {
    this.filter = key;
    TodoChips.markActive(this.filterBtns, key);
    this._renderList();
  }

  // ---- the composer ----
  /** Open the create form, optionally with `roomId` already chosen (TASK-4's per-room "+" opens the
   *  panel straight into a pre-filled draft). Built on first use and kept thereafter: a live room
   *  refresh swaps its options rather than rebuilding it, so a half-written draft survives. */
  openComposer(roomId) {
    if (!this.composer) {
      this.composer = new TodoComposer({
        rooms: this._roomChoices(),
        loadUsers: (q) => this.app.netbox.users(q).then(r => r.users),
        onSubmit: (payload) => this._add(payload),
        onCancel: () => this.closeComposer(),
      });
    }
    if (!this.composer.el.isConnected) this.composerHost.append(this.composer.el);
    this.composer.focusRoom(roomId);
  }

  closeComposer() {
    if (this.composer) this.composer.reset();
    this.composerHost.textContent = '';
  }

  // ---- the edit form (UX-9) ----
  /** Open one to-do's row for editing: the row is replaced **in place** by an edit-mode
   *  `TodoComposer` prefilled from the record, so the form appears where the to-do is. Reusing the
   *  composer is what makes every field editable — text, priority, assignees, notes, due — and keeps
   *  the create and edit surfaces from drifting (§10 *To-do*: the form is defined once and hosted).
   *
   *  Built on first use and kept alive thereafter, like the create composer. `_item` re-appends this
   *  same live element on every render, so a background `syncRooms` **moves** an open form rather
   *  than rebuilding it and an edit in progress survives, exactly as a draft does. The submit
   *  closure is fixed at build time, so the target is read from `this.editTarget`, not captured.
   *
   *  One form, so reaching for another row's pencil moves it there and re-prefills — the same
   *  single-editor bargain the panel's one composer already makes. That's visible (the form leaves
   *  the row you were on), and it can't misfire on the row being edited: that row *is* the form, so
   *  its pencil isn't there to click. */
  openEdit(todo, room) {
    if (!this.editComposer) {
      this.editComposer = new TodoComposer({
        mode: 'edit',
        rooms: this._roomChoices(),
        loadUsers: (q) => this.app.netbox.users(q).then(r => r.users),
        onSubmit: (payload) => this._edit(payload),
        onCancel: () => { this._endEdit(); this._renderList(); },
      });
    }
    this.editTarget = { todo, room };
    // Render first: `setTodo` focuses the task box, and focusing a detached element does nothing.
    this._renderList();
    this.editComposer.setTodo(todo, room.id);
  }

  /** Leave edit mode. Deliberately doesn't render — every caller either renders straight after or is
   *  already inside a mutation that renders once at the end. */
  _endEdit() { this.editTarget = null; }

  _roomChoices() {
    return this.rooms.map(r => ({ id: r.id, label: TodoChips.roomName(r) }));
  }

  // ---- data ----
  async load() {
    try {
      this.byRoom = await Api.get('/api/todos?floor_key=' + encodeURIComponent(this.floorKey));
      this.loaded = true;
    } catch (e) {
      this.listEl.textContent = '';
      this.listEl.append(Dom.el('div', { class: 'todo-empty' }, 'Could not load to-dos: ' + e.message));
      return;
    }
    this._renderList();
  }

  /** Every to-do on the floor as `{todo, room}` entries. Driven by `this.rooms` (the drawn+assigned
   *  set), so a to-do whose room was just unbound drops out of the list while its record stays in
   *  `byRoom` — a re-bind brings it back without a refetch. The entries pair each record with its
   *  room rather than merging the two, so `_setStatus` can mutate the record in place and the next
   *  render sees it. */
  _entries() {
    const out = [];
    for (const room of this.rooms) {
      for (const todo of (this.byRoom[room.id] || [])) out.push({ todo, room });
    }
    return out;
  }

  _sorted(entries) {
    const uid = this._userId();
    return [...entries].sort((a, b) => TodoModel.compare(a.todo, b.todo, uid));
  }

  /** Re-sync the assigned-room set after a live bind/unbind/delete/create (called by FloorEditor at
   *  each mutation point — never from render(), which fires every drag frame and would thrash the
   *  panel). No-ops when the drawn-and-assigned room id+label set is unchanged (e.g. a newly drawn
   *  or duplicated room is still unbound), so most calls touch nothing. `byRoom` is keyed by room id and
   *  untouched here, so records survive a real refresh; the composer is likewise kept (only its room
   *  options are swapped), so a refresh landing mid-draft doesn't discard what the user typed. */
  syncRooms(rooms) {
    const next = (rooms || []).filter(r => r.location && (r.polygon || []).length);
    const sig = (list) => list.map(r => r.id + ':' + (r.label || '')).join('|');
    if (sig(next) === sig(this.rooms)) return;
    this.rooms = next;
    if (this.composer) this.composer.setRooms(this._roomChoices());
    if (this.editComposer) this.editComposer.setRooms(this._roomChoices());
    this._renderList();
  }

  // ---- render ----
  _renderList() {
    if (!this.loaded) return;
    const entries = this._entries();
    this._renderCounts(entries);
    this.listEl.textContent = '';

    if (!this.rooms.length) {
      this.listEl.append(Dom.el('div', { class: 'todo-empty' },
        'No assigned rooms on this floor yet. Bind a room to a Location to track to-dos.'));
      return;
    }

    const done = entries.filter(e => e.todo.status === 'completed');
    // "Done" is the one filter that shows completed work directly — everywhere else it lives in the
    // collapsed group below, so the active list stays about what is still to do.
    if (this.filter === 'completed') {
      if (!done.length) return this._renderEmpty();
      for (const group of this._byRoom(done)) this.listEl.append(this._roomGroup(group));
      return;
    }

    const active = this._sorted(entries.filter(e => e.todo.status !== 'completed'
      && (this.filter === 'all' || e.todo.status === this.filter)));
    if (!active.length && !(this.filter === 'all' && done.length)) return this._renderEmpty();
    for (const e of active) this.listEl.append(this._item(e));
    if (this.filter === 'all' && done.length) this.listEl.append(this._doneGroup(done));
  }

  _renderEmpty() {
    const msg = this.filter === 'all'
      ? 'Nothing to do on this floor. Use “New” to add a to-do.'
      : 'No ' + TODO_FILTERS.find(f => f.key === this.filter).empty + ' to-dos on this floor.';
    this.listEl.append(Dom.el('div', { class: 'todo-empty' }, msg));
  }

  /** Header "N open" + the per-filter pill counts. "Open" is anything not completed — the number a
   *  user actually cares about, and the same reading TASK-5's stat tiles will use. */
  _renderCounts(entries) {
    const n = (key) => entries.filter(e => !key || e.todo.status === key).length;
    const open = entries.filter(e => e.todo.status !== 'completed').length;
    this.openCountEl.textContent = open ? open + ' open' : '';
    for (const f of TODO_FILTERS) this.filterBtns[f.key].count.textContent = String(n(f.match));
  }

  // ---- one row ----
  /** One to-do's row — or, when this is the to-do being edited, the live edit form standing in for
   *  it. Both list paths (the flat active list and `_roomGroup`) come through here, so the swap
   *  covers a completed to-do inside the Completed group too. */
  _item({ todo, room }) {
    if (this.editTarget && this.editTarget.todo === todo) {
      return Dom.el('div', { class: 'todo-edit-host' }, [this.editComposer.el]);
    }
    const mine = TodoModel.assignedTo(todo, this._userId());
    const text = Dom.el('div', { class: 'todo-item-text' }, todo.text);
    // A small, unobtrusive ✕ — the row's only destructive control, kept visually quiet so it reads
    // as an afterthought next to the status pills (the control you actually reach for).
    const del = Dom.el('button', { class: 'todo-del', title: 'Delete this to-do',
      'aria-label': 'Delete ' + todo.text }, '✕');
    del.addEventListener('click', () => this._delete(todo, room));
    // Beside the ✕ rather than stacked under it, so the pair's height never exceeds the row's
    // single-line title.
    const edit = Dom.el('button', { class: 'todo-edit', title: 'Edit this to-do',
      'aria-label': 'Edit ' + todo.text, html: Icons.edit });
    edit.addEventListener('click', () => this.openEdit(todo, room));

    const parts = [
      Dom.el('div', { class: 'todo-item-top' },
        [text, Dom.el('div', { class: 'todo-item-acts' }, [del, edit])]),
      this._meta(todo, room),
    ];
    if (todo.notes) parts.push(Dom.el('div', { class: 'todo-notes', title: todo.notes }, todo.notes));
    parts.push(TodoChips.pills(todo, (status) => this._setStatus(todo, room, status)));
    return Dom.el('div', { class: 'todo-item status-' + todo.status + (mine ? ' mine' : '') }, parts);
  }

  /** The meta chip row: room · priority · assignees · due — every chip from the shared `TodoChips`
   *  vocabulary, so a to-do reads the same here as it does on the facility-wide page. */
  _meta(todo, room) {
    const chips = [TodoChips.roomChip(room), TodoChips.priorityChip(todo)];
    const avatars = TodoChips.avatars(todo);
    if (avatars) chips.push(avatars);
    if (todo.due) chips.push(TodoChips.dueChip(todo));
    return Dom.el('div', { class: 'todo-meta' }, chips);
  }

  // ---- the completed group ----
  /** Group entries by room, in the floor's room order, dropping rooms with none. */
  _byRoom(entries) {
    const groups = [];
    for (const room of this.rooms) {
      const items = entries.filter(e => e.room.id === room.id);
      if (items.length) groups.push({ room, items: this._sorted(items) });
    }
    return groups;
  }

  /** The collapsed "Completed" group: the floor's finished work, subgrouped by room. The active list
   *  above is deliberately flat, but completed work is an archive you clear rather than read — and
   *  grouping it by room is what gives the per-room "Clear" a home now that folders are gone. */
  _doneGroup(done) {
    const caret = Dom.el('span', { class: 'todo-caret', html: Icons.chevron });
    const clear = Dom.el('button', { class: 'todo-clear-all',
      title: 'Delete every completed to-do on this floor' }, 'Clear completed');
    // The header toggles the group, so the button inside it must not also toggle on its way through.
    clear.addEventListener('click', (e) => { e.stopPropagation(); this._clearCompleted(null); });
    const head = Dom.el('div', { class: 'todo-done-head' + (this.doneOpen ? ' open' : '') }, [
      caret, Dom.el('span', { class: 'todo-done-title' }, 'Completed'),
      Dom.el('span', { class: 'todo-count' }, String(done.length)), clear,
    ]);
    const body = Dom.el('div', { class: 'todo-done-body' });
    body.hidden = !this.doneOpen;
    for (const group of this._byRoom(done)) body.append(this._roomGroup(group));
    head.addEventListener('click', () => {
      this.doneOpen = !this.doneOpen;
      head.classList.toggle('open', this.doneOpen);
      body.hidden = !this.doneOpen;
    });
    return Dom.el('div', { class: 'todo-done' }, [head, body]);
  }

  /** One room's completed items, under a subheading carrying that room's own "Clear". */
  _roomGroup({ room, items }) {
    const clear = Dom.el('button', { class: 'todo-clear-room',
      title: 'Delete this room’s completed to-dos' }, 'Clear');
    clear.addEventListener('click', () => this._clearCompleted(room.id));
    const head = Dom.el('div', { class: 'todo-group-head' }, [
      Dom.el('span', { class: 'todo-group-name', title: TodoChips.roomName(room) },
        TodoChips.roomName(room)),
      Dom.el('span', { class: 'todo-count' }, String(items.length)), clear,
    ]);
    return Dom.el('div', { class: 'todo-group' }, [head, ...items.map(e => this._item(e))]);
  }

  // ---- mutations (server-enforced; a denied write toasts the server's message) ----
  /** Create from the composer's payload. Rethrows on failure so `TodoComposer` keeps the draft
   *  instead of resetting a form whose to-do was never saved. */
  async _add(payload) {
    try {
      const todo = await Api.post('/api/todos', { floor_key: this.floorKey, ...payload });
      (this.byRoom[payload.room_id] = this.byRoom[payload.room_id] || []).push(todo);
      this._renderList();
    } catch (e) {
      Toast.show('Could not add to-do: ' + e.message, true);
      throw e;
    }
  }

  /** Save the open edit (UX-9). Mirrors `_add`: the record is updated from the **server's** row
   *  rather than from what was typed, and a failure rethrows so the composer keeps the edit instead
   *  of closing over a change that never saved. The target comes from `this.editTarget` because the
   *  composer's submit closure is fixed when it's built, not per edit. */
  async _edit(payload) {
    const { todo } = this.editTarget;
    try {
      Object.assign(todo, await Api.post('/api/todos/' + todo.id, payload));
      this._endEdit();
      this._renderList();
    } catch (e) {
      Toast.show('Could not update to-do: ' + e.message, true);
      throw e;
    }
  }

  async _setStatus(todo, room, status) {
    try {
      const updated = await Api.post('/api/todos/' + todo.id, { status });
      todo.status = updated.status;
      this._renderList();
    } catch (e) {
      Toast.show('Could not update to-do: ' + e.message, true);
    }
  }

  /** Delete one to-do. A **completed** item goes straight through — that's the old "clear", and the
   *  work is done. Anything else asks first: to-dos are durable user data with no undo, and an
   *  unfinished one is exactly what a stray click must not silently destroy. */
  async _delete(todo, room) {
    if (todo.status !== 'completed' && !confirm('Delete “' + todo.text + '”?\n\n'
      + 'This to-do isn’t completed, and deleting it can’t be undone.')) return;
    try {
      await Api.post('/api/todos/' + todo.id + '/delete', {});
      this._drop(todo, room.id);
      this._renderList();
    } catch (e) {
      Toast.show('Could not delete to-do: ' + e.message, true);
    }
  }

  /** Hard-delete every completed to-do on the floor, or in one room when `roomId` is given. Always
   *  confirms: this is the one control that destroys many records at once. The deletes are issued
   *  together and reconciled per-result, so a partial failure drops exactly the rows that really
   *  went and reports the rest, rather than desyncing the panel from the server. */
  async _clearCompleted(roomId) {
    const targets = this._entries()
      .filter(e => e.todo.status === 'completed' && (!roomId || e.room.id === roomId));
    if (!targets.length) return;
    const scope = roomId ? 'in this room' : 'on this floor';
    const plural = targets.length === 1 ? 'to-do' : 'to-dos';
    if (!confirm('Delete ' + targets.length + ' completed ' + plural + ' ' + scope
      + '?\n\nThis can’t be undone.')) return;
    const results = await Promise.allSettled(
      targets.map(e => Api.post('/api/todos/' + e.todo.id + '/delete', {})));
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') this._drop(targets[i].todo, targets[i].room.id);
    });
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) {
      Toast.show('Could not clear ' + failed.length + ' of ' + targets.length + ' to-dos: '
        + failed[0].reason.message, true);
    }
    this._renderList();
  }

  /** Drop a record from the in-memory cache (the server already has). The single choke point for
   *  removal, which is why an open edit on the departing to-do is closed here — `_delete` and
   *  `_clearCompleted` both land on it, and an edit left pointing at a deleted record would never
   *  render again. */
  _drop(todo, roomId) {
    if (this.editTarget && this.editTarget.todo === todo) this._endEdit();
    const list = this.byRoom[roomId] || [];
    const i = list.indexOf(todo);
    if (i >= 0) list.splice(i, 1);
  }
}
