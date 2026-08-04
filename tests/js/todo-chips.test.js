'use strict';
/* todo-chips.test.js — TodoChips: the labelling rules every to-do surface reads.

   Worth pinning for the same reason `todo-model.test.js` is: the class exists to define these
   ONCE. Three surfaces (the floor panel, the facility-wide page, its phone build) render the same
   record, and before QUAL-10 each carried its own copy of the room-name fallback, the priority
   label, the overdue tooltip and the avatar cap. If any of them drift again, the same to-do
   describes itself differently depending on where you look at it.

   Only the **DOM-free** tier is covered here, which is the line `README.md` draws for this suite:
   `roomChip`/`priorityChip`/`dueChip`/`avatars`/`pills`/`markActive` build or mutate elements and
   belong in a browser. They are thin wrappers over exactly the rules below, which is the point of
   splitting the class that way.

   Dates are derived from `TodoModel.today()` rather than hard-coded, so no assertion here can rot
   into a false pass (or a 1 January failure). */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadClasses } = require('./load.js');

// `todo-chips.js` reads TodoModel inside its method bodies, so the two load in index.html's order.
const { TodoChips } = loadClasses(['todo-model.js', 'todo-chips.js'], ['TodoChips']);

/** An ISO date `days` away from today, in the same local-time convention `TodoModel.today()` uses. */
function isoDaysFromToday(days) {
  const now = new Date();
  const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

/** `n` assignees in the `/api/todos` serialized shape. */
function assignees(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1, username: `u${i + 1}`, display: `User ${i + 1}`, initials: `U${i + 1}`,
  }));
}

// ---- roomName ----

test('roomName prefers the room’s own label', () => {
  const room = { id: 'r1', label: 'B14', location: { name: 'Basement 14' } };
  assert.equal(TodoChips.roomName(room), 'B14');
});

test('roomName falls back to the bound Location’s name when there is no label', () => {
  assert.equal(TodoChips.roomName({ id: 'r1', label: '', location: { name: 'Basement 14' } }),
    'Basement 14');
});

test('roomName falls back to the room uid when neither a label nor a Location names it', () => {
  // The uid rather than an empty string: a row that named nothing would be unidentifiable even
  // though its link still works.
  assert.equal(TodoChips.roomName({ id: 'r1', label: '', location: null }), 'r1');
  assert.equal(TodoChips.roomName({ id: 'r1' }), 'r1');
});

// ---- priorityLabel ----

test('priorityLabel resolves each key to its TodoModel label', () => {
  assert.equal(TodoChips.priorityLabel({ priority: 'high' }), 'High');
  assert.equal(TodoChips.priorityLabel({ priority: 'med' }), 'Medium');
  assert.equal(TodoChips.priorityLabel({ priority: 'low' }), 'Low');
});

test('priorityLabel falls back to the raw key for a priority outside the vocabulary', () => {
  // An older row or a future vocabulary must stay legible rather than rendering "undefined".
  assert.equal(TodoChips.priorityLabel({ priority: 'urgent' }), 'urgent');
});

// ---- dueTitle ----

test('dueTitle carries the stored ISO date, not the short chip label', () => {
  // The chip shows `TodoModel.dueLabel`; the tooltip is where the unambiguous date lives.
  const due = isoDaysFromToday(30);
  assert.equal(TodoChips.dueTitle({ due, status: 'planned' }), 'Due ' + due);
});

test('dueTitle flags a past due date as overdue', () => {
  const due = isoDaysFromToday(-1);
  assert.equal(TodoChips.dueTitle({ due, status: 'planned' }), 'Overdue — due ' + due);
});

test('dueTitle never calls completed work overdue', () => {
  // Mirrors TodoModel.isOverdue — finished work is done, and nagging about it would be noise.
  const due = isoDaysFromToday(-30);
  assert.equal(TodoChips.dueTitle({ due, status: 'completed' }), 'Due ' + due);
});

test('dueTitle treats today as not yet overdue', () => {
  const due = isoDaysFromToday(0);
  assert.equal(TodoChips.dueTitle({ due, status: 'planned' }), 'Due ' + due);
});

// ---- avatarSplit ----

test('avatarSplit returns null when nobody is assigned', () => {
  // Null rather than an empty split: no surface renders an empty avatar row.
  assert.equal(TodoChips.avatarSplit({ assignees: [] }), null);
  assert.equal(TodoChips.avatarSplit({}), null);
});

test('avatarSplit shows everyone when the list fits within the cap', () => {
  const split = TodoChips.avatarSplit({ assignees: assignees(TodoChips.AVATAR_MAX) });
  assert.equal(split.shown.length, TodoChips.AVATAR_MAX);
  assert.deepEqual(split.rest, []);
  assert.equal(split.moreTitle, '');
});

test('avatarSplit caps the shown avatars and folds the remainder into rest', () => {
  const split = TodoChips.avatarSplit({ assignees: assignees(5) });
  assert.equal(split.shown.length, TodoChips.AVATAR_MAX);
  assert.equal(split.rest.length, 5 - TodoChips.AVATAR_MAX);
  // The split is a prefix/suffix of the record's order — the first N shown, the rest folded.
  assert.deepEqual(split.shown.map(u => u.id), [1, 2]);
  assert.deepEqual(split.rest.map(u => u.id), [3, 4, 5]);
});

test('avatarSplit names everyone who did not fit, so the overflow loses nothing', () => {
  const split = TodoChips.avatarSplit({ assignees: assignees(5) });
  assert.equal(split.moreTitle, 'User 3, User 4, User 5');
});

test('avatarSplit does not mutate the record’s assignee list', () => {
  const todo = { assignees: assignees(5) };
  TodoChips.avatarSplit(todo);
  assert.equal(todo.assignees.length, 5);
});
