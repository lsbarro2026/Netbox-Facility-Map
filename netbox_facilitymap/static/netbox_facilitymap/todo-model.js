'use strict';
/* todo-model.js — TodoModel: the to-do domain rules shared by every to-do surface (TASK-3).

   Pure static helpers over the `/api/todos*` record shape (`frontend_api._serialize_todo`):
   `{id, text, status, priority, notes, due, assignees:[{id,username,display,initials}]}`. No DOM, no
   fetching, no state — just the vocabulary and the ordering.

   This class exists so the ordering is defined **once**. It is used by the floor panel
   (`FloorTodo`) and, next, by the facility-wide to-do page (TASK-5) — two surfaces that must agree
   on what "next" means, or the same to-do outranks itself depending on where you look at it. Add a
   rule here, not in a caller.

   Loaded eagerly (index.html) rather than in the lazy floor bundle: two independent surfaces share
   it, and an eagerly-loaded class is the one thing a lazily-bundled one may safely rely on (§10). */

class TodoModel {
  /** The status vocabulary, in **workflow** order (the order the pills read left-to-right), which
   *  is deliberately NOT the sort order below — you walk a to-do planned → in progress → completed,
   *  but you want the in-progress one at the top of the list. Mirrors `RoomTodo.STATUS_CHOICES`. */
  static get STATUSES() {
    return [
      { key: 'planned', label: 'Planned' },
      { key: 'in_progress', label: 'In progress' },
      { key: 'completed', label: 'Completed' },
    ];
  }

  /** The priority vocabulary, highest first. Mirrors `RoomTodo.PRIORITY_CHOICES`; `short` is the
   *  chip label (a dot + "Med" reads fine where "Medium" would crowd the meta row). */
  static get PRIORITIES() {
    return [
      { key: 'high', label: 'High', short: 'High' },
      { key: 'med', label: 'Medium', short: 'Med' },
      { key: 'low', label: 'Low', short: 'Low' },
    ];
  }

  //: Sort rank per status — in-progress work outranks not-yet-started, and completed sinks. Any
  //: unknown status (an older row, a future vocabulary) sorts with the completed tail rather than
  //: jumping the queue on a NaN.
  static STATUS_RANK = { in_progress: 0, planned: 1, completed: 2 };
  static PRIORITY_RANK = { high: 0, med: 1, low: 2 };

  /** Whether `todo` is assigned to user id `userId`. False for a null/absent viewer (standalone,
   *  where window.MAP injects nobody) — an unknown viewer simply owns nothing. */
  static assignedTo(todo, userId) {
    if (!userId) return false;
    return (todo.assignees || []).some(u => u.id === userId);
  }

  /** Whether `todo` is past its due date. Completed work is never overdue — it's done, and flagging
   *  it red would be nagging about nothing. Compares whole days in the **browser's** timezone
   *  against the ISO `YYYY-MM-DD` the server stores (a `DateField`, no time, no zone), so "overdue"
   *  means the same thing the user's own calendar would say. */
  static isOverdue(todo) {
    if (!todo.due || todo.status === 'completed') return false;
    return todo.due < TodoModel.today();
  }

  /** Today as an ISO `YYYY-MM-DD` in local time. Not `toISOString()`, which converts to UTC and so
   *  reports tomorrow's date for anyone east of Greenwich late in the evening — a to-do would read
   *  as overdue a day early. */
  static today() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** A due date as a short human chip label ("Jul 20", or "Jul 20 2027" when it isn't this year —
   *  a bare "Jul 20" on a date 18 months out would badly mislead). Parsed as local time by passing
   *  the parts explicitly: `new Date('2026-07-20')` is parsed as **UTC** midnight and would render
   *  as the 19th for negative-offset timezones. */
  static dueLabel(due) {
    if (!due) return '';
    const [y, m, d] = due.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return y === new Date().getFullYear() ? label : `${label} ${y}`;
  }

  /** The ordering every to-do surface sorts by — "what should I work on next?", top-down. Pass the
   *  viewer's user id (null when unknown) to float their own work; returns a negative/0/positive
   *  number for `Array.prototype.sort`.
   *
   *  The rules, in strict precedence:
   *    1. **assigned to the viewer** — an explicit product requirement: every to-do surface shows a
   *       user their own work first, whatever its status or priority.
   *    2. **status** — in progress → planned → completed (see STATUS_RANK).
   *    3. **priority** — high → med → low.
   *    4. **due date** — soonest first, and a to-do with *no* due date sorts after every dated one
   *       (an open-ended task isn't more urgent than one with a deadline, however far off).
   *    5. **id** — the creation-order tiebreak, so the list is stable: equal-ranking to-dos keep one
   *       fixed order across re-renders instead of shuffling on every repaint. (`id` stands in for
   *       `created` — it's monotonic and, unlike `created`, the API already serializes it.) */
  static compare(a, b, userId) {
    const mine = (t) => (TodoModel.assignedTo(t, userId) ? 0 : 1);
    const rank = (map, key) => (map[key] !== undefined ? map[key] : 99);
    return mine(a) - mine(b)
      || rank(TodoModel.STATUS_RANK, a.status) - rank(TodoModel.STATUS_RANK, b.status)
      || rank(TodoModel.PRIORITY_RANK, a.priority) - rank(TodoModel.PRIORITY_RANK, b.priority)
      // An absent due date sorts last within its rank — `￿` is above every digit a date can
      // start with, so the string compare puts undated work at the tail without a special case.
      || (a.due || '￿').localeCompare(b.due || '￿')
      || a.id - b.id;
  }

  /** `list` sorted by `compare` — a copy, so a caller's array (e.g. the panel's cached `byRoom`
   *  entries) is never reordered underneath it. */
  static sorted(list, userId) {
    return [...list].sort((a, b) => TodoModel.compare(a, b, userId));
  }

  /** The selectable sort axes for the facility-wide page's Display menu (TASK-7). `smart` is the
   *  default `compare` ordering (mine → status → priority → due → id); the rest are single-axis.
   *  They live here, beside `compare`, so a surface offering a choice of orderings still draws every
   *  one from the shared vocabulary rather than inventing its own (the shared-ordering invariant). */
  static get SORTS() {
    return [
      { key: 'smart', label: 'Smart' },
      { key: 'priority', label: 'Priority' },
      { key: 'due', label: 'Due date' },
      { key: 'created', label: 'Recently added' },
    ];
  }

  /** A `(a, b)` comparator for the sort axis `key`, for `Array.prototype.sort`. `smart` delegates to
   *  `compare` (so the viewer's own work still floats to the top); each single-axis sort falls back
   *  to `id` so equal-ranking rows keep one fixed order across re-renders. An unknown key degrades to
   *  `smart`. Each single-axis sort fixes its own sensible direction — priority high→low, due
   *  soonest-first, recently-added newest-first — and the page deliberately exposes no
   *  ascending/descending flip. */
  static comparator(key, userId) {
    const rank = (map, k) => (map[k] !== undefined ? map[k] : 99);
    switch (key) {
      case 'priority':
        return (a, b) => rank(TodoModel.PRIORITY_RANK, a.priority)
          - rank(TodoModel.PRIORITY_RANK, b.priority) || a.id - b.id;
      case 'due':
        // Undated work sorts last, exactly as in `compare`: `￿` outranks any date's leading digit.
        return (a, b) => (a.due || '￿').localeCompare(b.due || '￿') || a.id - b.id;
      case 'created':
        // `id` is monotonic with creation, so newest-first is simply descending id.
        return (a, b) => b.id - a.id;
      case 'smart':
      default:
        return (a, b) => TodoModel.compare(a, b, userId);
    }
  }
}
