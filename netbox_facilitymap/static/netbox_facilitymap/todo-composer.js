'use strict';
/* todo-composer.js — TodoComposer: the to-do form, shared by every to-do surface (TASK-3).

   Room · task · priority · assignees · notes · due date. Owned by a host (the floor panel today,
   the facility-wide to-do page next, TASK-5) that supplies the room list and does the actual POST:
   the composer collects and validates input and hands back a payload — it never talks to the API
   itself, so one form serves surfaces whose create endpoints scope differently.

       const composer = new TodoComposer({
         rooms: [{id, label}, ...],                  // choices for the room select
         loadUsers: (q) => netbox.users(q).then(r => r.users),
         onSubmit: (payload) => this._add(payload),  // -> Promise; rejection keeps the draft
         onCancel: () => this._closeComposer(),
         mode: 'create',                             // or 'edit' — see below
       });
       host.append(composer.el);

   `onSubmit` receives `{room_id, text, priority, assignees:[id], notes, due}` — the `/api/todos`
   POST body minus the `floor_key` the host owns. It may return a Promise: the form stays disabled
   until it settles, then **resets on success and keeps every field on failure**, so a rejected
   write (no permission, a server hiccup) never costs the user what they typed.

   **`mode: 'edit'`** (UX-9) turns the same form into "change this to-do", prefilled through
   `setTodo(todo, roomId)`: one form means editing reaches every field the create form does, and the
   two surfaces can't drift apart (§10 *To-do* — the form is defined once and hosted, never
   re-implemented). Three things differ: the payload omits `room_id`, the room select is shown but
   **disabled** (`/api/todos/<id>` updates a to-do's columns and has no room-move — the field is
   there to say *which* to-do you're editing, not to offer a move it can't do), and a successful
   submit does **not** reset — the host closes the form, and resetting first would flash a blank
   draft on its way out.

   The instance is built once and kept alive across the host's re-renders — a half-written draft
   must survive a background refresh (see `FloorTodo.syncRooms`), which is why the room list is
   swapped through `setRooms` rather than by rebuilding the form. An edit host keeps its own
   instance alive for the same reason. */

class TodoComposer {
  constructor({ rooms = [], loadUsers, onSubmit, onCancel, mode = 'create' }) {
    this.rooms = rooms;
    this.loadUsers = loadUsers;
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;
    this.mode = mode;           // 'create' | 'edit' — see the header
    this.priority = 'med';      // the model's own default (RoomTodo.PRIORITY_MED)
    this.assignees = [];        // [{id,username,display,initials}] — the picked chips
    this.busy = false;
    this._build();
  }

  get _editing() { return this.mode === 'edit'; }

  // ---- construction ----
  _build() {
    this.roomSel = Dom.el('select', { class: 'todo-c-input', 'aria-label': 'Room' });
    if (this._editing) {
      this.roomSel.disabled = true;
      this.roomSel.title = 'A to-do stays in the room it was created in';
    }
    this.roomSel.addEventListener('change', () => this._syncSubmit());
    this._fillRooms();

    this.textInput = Dom.el('input', { class: 'todo-c-input', type: 'text', maxlength: '500',
      placeholder: 'What needs doing?', 'aria-label': 'Task' });
    this.textInput.addEventListener('input', () => this._syncSubmit());

    this.assigneeChips = Dom.el('div', { class: 'todo-c-chips' });
    // A Combo (not a <select>): a NetBox install's user roster is unbounded, so options are queried
    // per keystroke. Each pick is consumed into a chip and the box reset for the next name — that's
    // what `Combo.reset()` exists for, and it's why this is a multi-select without a second widget.
    this.userCombo = new Combo({
      placeholder: 'Search people…',
      allowClear: false,
      load: (q) => this.loadUsers(q).then(users => users.map(u => ({ ...u, name: u.display }))),
      onPick: (opt) => { if (opt) this._addAssignee(opt); this.userCombo.reset(); },
    });

    this.notesInput = Dom.el('textarea', { class: 'todo-c-input todo-c-notes', rows: '2',
      placeholder: 'Optional detail…', 'aria-label': 'Notes' });
    this.dueInput = Dom.el('input', { class: 'todo-c-input', type: 'date',
      'aria-label': 'Due date' });

    this.submitBtn = Dom.el('button', { class: 'primary', type: 'submit' },
      this._editing ? 'Save changes' : 'Add to-do');
    const cancelBtn = Dom.el('button', { type: 'button' }, 'Cancel');
    cancelBtn.addEventListener('click', () => this.onCancel && this.onCancel());

    this.el = Dom.el('form', { class: 'todo-composer' }, [
      this._field('Room', this.roomSel),
      this._field('Task', this.textInput),
      this._field('Priority', this._priorityToggle()),
      this._fieldGroup('Assignees', Dom.el('div', { class: 'todo-c-assignees' },
        [this.assigneeChips, this.userCombo.el])),
      this._field('Notes', this.notesInput),
      this._field('Due', this.dueInput),
      Dom.el('div', { class: 'todo-c-actions' }, [cancelBtn, this.submitBtn]),
    ]);
    this.el.addEventListener('submit', (e) => { e.preventDefault(); this._submit(); });
    this._syncSubmit();
  }

  _field(label, control) {
    return Dom.el('label', { class: 'todo-c-field' },
      [Dom.el('span', { class: 'todo-c-label' }, label), control]);
  }

  /** Like `_field`, but for a composite control with independently-clickable children of its own
   *  (the assignees chips + combo dropdown) — a `<label>` wrapper would forward a click on any of
   *  its non-interactive descendants (e.g. a combo dropdown row) to the label's first labelable
   *  descendant, per HTML's implicit label-activation behaviour. Once a chip renders, its remove
   *  button becomes that first descendant, so picking a user was silently undone by that same
   *  click re-triggering the newest chip's removal. `.todo-c-field` is class-styled, not
   *  tag-scoped, so a plain `<div>` keeps the same layout without the forwarding hazard. */
  _fieldGroup(label, control) {
    return Dom.el('div', { class: 'todo-c-field' },
      [Dom.el('span', { class: 'todo-c-label' }, label), control]);
  }

  _priorityToggle() {
    this.priorityBtns = TodoModel.PRIORITIES.map(p => {
      const b = Dom.el('button', { class: 'todo-c-prio prio-' + p.key, type: 'button',
        'aria-pressed': String(this.priority === p.key) }, p.label);
      b.addEventListener('click', () => this._setPriority(p.key));
      return b;
    });
    return Dom.el('div', { class: 'todo-c-prios', role: 'group' }, this.priorityBtns);
  }

  _setPriority(key) {
    this.priority = key;
    TodoModel.PRIORITIES.forEach((p, i) => {
      const on = p.key === key;
      this.priorityBtns[i].classList.toggle('active', on);
      this.priorityBtns[i].setAttribute('aria-pressed', String(on));
    });
  }

  /** Rebuild the room `<option>`s, preserving the current selection when that room is still on
   *  offer — a background room refresh must not silently re-point a half-written draft at a
   *  different room (or clear a pre-filled one). */
  _fillRooms() {
    const keep = this.roomSel.value;
    this.roomSel.textContent = '';
    this.roomSel.append(Dom.el('option', { value: '' }, 'Select a room…'));
    for (const r of this.rooms) this.roomSel.append(Dom.el('option', { value: r.id }, r.label));
    if (keep && this.rooms.some(r => r.id === keep)) this.roomSel.value = keep;
  }

  // ---- host API ----
  /** Swap the room choices (the host's assigned-room set changed under us — a live bind/unbind).
   *  Keeps the draft intact; see `_fillRooms`. */
  setRooms(rooms) {
    this.rooms = rooms || [];
    this._fillRooms();
    this._syncSubmit();
  }

  /** Point the form at `roomId` and focus the task box — the entry point for "add a to-do to *this*
   *  room" (TASK-4's per-room + icon on the floor plan). An unknown id selects nothing rather than
   *  throwing, leaving the user on the placeholder with the select still to make. */
  focusRoom(roomId) {
    if (roomId && this.rooms.some(r => r.id === roomId)) this.roomSel.value = roomId;
    this._syncSubmit();
    this.textInput.focus();
  }

  /** Point an **edit-mode** form at an existing to-do: prefill every field from the record and focus
   *  the task box. `roomId` names the to-do's room (the record carries only its own fields), and is
   *  only ever displayed — see the header on why the room select is disabled here. The assignees
   *  arrive in the same `{id,display,initials}` shape a `Combo` pick does, so the chips and the
   *  payload consume them unchanged. Copied rather than aliased: the chips are edited in place, and
   *  a cancelled edit must not have mutated the caller's record. */
  setTodo(todo, roomId) {
    this.roomSel.value = roomId;
    this.textInput.value = todo.text;
    this.notesInput.value = todo.notes || '';
    this.dueInput.value = todo.due || '';
    this.assignees = (todo.assignees || []).map(u => ({ ...u }));
    this._renderChips();
    this._setPriority(todo.priority);
    this.userCombo.reset();
    this._syncSubmit();
    this.textInput.focus();
  }

  /** Clear every field back to a fresh draft. */
  reset() {
    this.roomSel.value = '';
    this.textInput.value = '';
    this.notesInput.value = '';
    this.dueInput.value = '';
    this.assignees = [];
    this._renderChips();
    this._setPriority('med');
    this.userCombo.reset();
    this._syncSubmit();
  }

  // ---- assignees ----
  _addAssignee(user) {
    if (this.assignees.some(u => u.id === user.id)) return;   // picking the same person twice is a no-op
    this.assignees.push(user);
    this._renderChips();
  }

  _removeAssignee(id) {
    this.assignees = this.assignees.filter(u => u.id !== id);
    this._renderChips();
  }

  _renderChips() {
    this.assigneeChips.textContent = '';
    for (const u of this.assignees) {
      const x = Dom.el('button', { class: 'todo-c-chip-x', type: 'button',
        title: 'Remove ' + u.display, 'aria-label': 'Remove ' + u.display }, '✕');
      x.addEventListener('click', () => this._removeAssignee(u.id));
      this.assigneeChips.append(Dom.el('span', { class: 'todo-c-chip' },
        [Dom.el('span', {}, u.display), x]));
    }
  }

  // ---- submit ----
  /** Room + task are the only required fields (they're what `/api/todos` itself requires); the rest
   *  are optional detail. An edit needs only the task: its room is fixed and already chosen, and
   *  `/api/todos/<id>` likewise rejects only empty text. Also disabled mid-flight, so an impatient
   *  double-click can't post twice. */
  _syncSubmit() {
    const ready = !!this.textInput.value.trim() && (this._editing || !!this.roomSel.value);
    this.submitBtn.disabled = this.busy || !ready;
  }

  /** The host's POST body. An edit omits `room_id` — `/api/todos/<id>` has no room-move, and posting
   *  a key the endpoint silently ignores would read as though it did. Every other field goes every
   *  time, so an edit that empties Notes or clears Due actually clears it (the endpoint applies the
   *  keys the payload carries). */
  _payload() {
    const payload = {
      text: this.textInput.value.trim(),
      priority: this.priority,
      assignees: this.assignees.map(u => u.id),
      notes: this.notesInput.value.trim(),
      due: this.dueInput.value || null,
    };
    return this._editing ? payload : { room_id: this.roomSel.value, ...payload };
  }

  async _submit() {
    if (this.submitBtn.disabled) return;
    this.busy = true;
    this._syncSubmit();
    try {
      await this.onSubmit(this._payload());
      // An edit's host closes the form on success; resetting it here would blank the fields for the
      // frame before it goes. A create's host keeps its form open for the next to-do, so it resets.
      if (!this._editing) this.reset();
    } catch (e) {
      // The host has already toasted the reason. Keep the draft: re-typing a lost to-do is a worse
      // outcome than a form that stayed open.
    } finally {
      this.busy = false;
      this._syncSubmit();
    }
  }
}
