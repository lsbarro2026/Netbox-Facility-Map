'use strict';
/* todo-chips.js — TodoChips: how one to-do reads, defined once (QUAL-10).

   `TodoModel` answers "which to-do comes first"; this answers "what does it say". Every to-do
   surface — the floor panel (`FloorTodo`), the facility-wide page (`TodoPage`) and its phone build
   (`MobileTodoPage`) — renders the same record, and before this class each carried its own copy of
   the labelling rules: what a room is called, what a priority chip says, what an overdue tooltip
   reads, how many assignee avatars show before the rest fold into a "+N". Three copies of the
   avatar cap, each commented "matches the other's cap", is what a rule looks like when it has no
   home. It has one now: a change to how an overdue to-do reads happens here.

   The boundary is deliberate and is the whole reason this isn't simply "the shared to-do renderer":
   the **chip/label/status vocabulary** is common to every surface, the **list layout** is not. A row,
   a group heading, an empty state and a filter set are each surface's own answer to its own
   question, and they diverge on purpose. Nothing that lays out a list belongs here.

   Two tiers, in this order:

     1. **The rules** — pure, DOM-free, and used by all three surfaces *including* the phone page.
     2. **The desktop chip DOM** (`.todo-*`) — used by `FloorTodo` and `TodoPage` only.

   `MobileTodoPage` takes tier 1 and builds its own `.mtodo-*` spans on top, which is not an
   oversight: MOBILE-9 made the phone page a sibling that owns its own prefix, and §10 *To-do* pins
   that "a phone fix that edits a `.todo-*` rule is in the wrong file". Its chips are genuinely
   different objects too — priority rides the card's coloured left edge rather than a chip. Sharing
   the *rules* is what keeps the two surfaces honest; sharing the markup by threading a class-name
   prefix through every builder is the parameterization that makes a shared renderer rot.

   Lives beside `TodoModel` rather than on it because these build DOM and that class is pure by
   contract. Loaded **eagerly** (`index.html`) for `TodoModel`'s own reason: `floor-todo.js` is in
   the lazy floor bundle, and a lazy bundle may only depend on an eagerly-loaded class (§10). */

class TodoChips {
  //: Avatars shown inline on a row before the rest collapse into a "+N" chip. Two is what fits
  //: beside the other meta chips at the floor panel's default width without wrapping the row; the
  //: other surfaces match it so a shoulder of initials reads the same wherever you meet the to-do.
  static AVATAR_MAX = 2;

  // ---- the rules (no DOM — every surface, phone included) ----

  /** What a room is called: its own label, else the bound Location's name, else the bare uid. The
   *  uid is the last resort rather than an empty string — a row that named nothing would be
   *  unclickable in the user's head even though the link still works. */
  static roomName(room) {
    return room.label || (room.location && room.location.name) || room.id;
  }

  /** A priority's human label, falling back to the raw stored key. The fallback is what keeps an
   *  older row (or a future vocabulary) legible instead of rendering "undefined". */
  static priorityLabel(todo) {
    const p = TodoModel.PRIORITIES.find(x => x.key === todo.priority);
    return p ? p.label : todo.priority;
  }

  /** The due chip's tooltip: the **stored ISO date**, prefixed by whether it has passed. The chip
   *  itself shows the short `TodoModel.dueLabel`, so the tooltip is where the unambiguous date
   *  lives — that division is the point, and why this is a title string and not display copy. */
  static dueTitle(todo) {
    return (TodoModel.isOverdue(todo) ? 'Overdue — due ' : 'Due ') + todo.due;
  }

  /** The assignee cap + overflow rule, as data: `{shown, rest, moreTitle}`, or **null** when nobody
   *  is assigned (there is no empty avatar row on any surface). `moreTitle` names everyone who
   *  didn't fit, so folding the overflow never actually loses the information.
   *
   *  Returns the split rather than the markup precisely so the phone page can share the rule while
   *  painting its own `.mtodo-av*` spans. */
  static avatarSplit(todo) {
    const users = todo.assignees || [];
    if (!users.length) return null;
    const rest = users.slice(TodoChips.AVATAR_MAX);
    return {
      shown: users.slice(0, TodoChips.AVATAR_MAX),
      rest,
      moreTitle: rest.map(u => u.display).join(', '),
    };
  }

  // ---- the desktop chip DOM (`.todo-*` — FloorTodo + TodoPage) ----

  /** The room chip: a dot plus the room's name, tooltipped in full since the chip truncates. */
  static roomChip(room) {
    const name = TodoChips.roomName(room);
    return Dom.el('span', { class: 'todo-chip todo-room-chip', title: name },
      [Dom.el('span', { class: 'todo-room-dot' }), Dom.el('span', {}, name)]);
  }

  /** The priority chip — a coloured dot plus the *short* label (a dot + "Med" reads fine where
   *  "Medium" would crowd the meta row); the tooltip carries the full word. */
  static priorityChip(todo) {
    const p = TodoModel.PRIORITIES.find(x => x.key === todo.priority);
    return Dom.el('span', { class: 'todo-prio prio-' + todo.priority,
      title: TodoChips.priorityLabel(todo) + ' priority' },
      [Dom.el('span', { class: 'todo-prio-dot' }), Dom.el('span', {}, p ? p.short : todo.priority)]);
  }

  /** Initials avatars, capped at `AVATAR_MAX` with a "+N" overflow chip. Null when unassigned, so a
   *  caller appends it conditionally rather than testing the record itself. */
  static avatars(todo) {
    const split = TodoChips.avatarSplit(todo);
    if (!split) return null;
    const els = split.shown.map(
      u => Dom.el('span', { class: 'todo-avatar', title: u.display }, u.initials));
    if (split.rest.length) {
      els.push(Dom.el('span', { class: 'todo-avatar todo-avatar-more', title: split.moreTitle },
        '+' + split.rest.length));
    }
    return Dom.el('span', { class: 'todo-avatars' }, els);
  }

  /** The due chip, red once overdue. */
  static dueChip(todo) {
    return Dom.el('span', { class: 'todo-chip todo-due' + (TodoModel.isOverdue(todo) ? ' overdue' : ''),
      title: TodoChips.dueTitle(todo) }, TodoModel.dueLabel(todo.due));
  }

  /** The three status pills, in `TodoModel.STATUSES` (workflow) order. `onPick(statusKey)` fires on
   *  a click, and only on a pill that isn't already active — the current status is a state readout,
   *  not a button that re-posts what the server already believes.
   *
   *  Returns the wrapping `<div>` so a host whose row is itself clickable can stop propagation on
   *  it (`TodoPage`; see §10 *To-do*). That guard stays with the surface that needs it rather than
   *  being an option here — the floor panel's row isn't clickable and must not pay for it. */
  static pills(todo, onPick) {
    return Dom.el('div', { class: 'todo-pills' }, TodoModel.STATUSES.map(s => {
      const b = Dom.el('button', {
        class: 'todo-pill' + (todo.status === s.key ? ' active' : ''),
        title: 'Mark ' + s.label.toLowerCase(),
      }, s.label);
      if (todo.status !== s.key) b.addEventListener('click', () => onPick(s.key));
      return b;
    }));
  }

  /** Mark one filter pill/chip active across a `{key: {btn, count}}` map, clearing the rest. Every
   *  surface builds that same map (with its own filter set and its own classes), and every one has
   *  to keep the visual state and `aria-pressed` in lockstep — a pill that looked active while
   *  reporting `aria-pressed="false"` would lie to a screen reader only. Iterates the map itself,
   *  not a filter list, so a caller's vocabulary is none of this method's business. */
  static markActive(btns, key) {
    for (const k of Object.keys(btns)) {
      const on = k === key;
      btns[k].btn.classList.toggle('active', on);
      btns[k].btn.setAttribute('aria-pressed', String(on));
    }
  }
}
