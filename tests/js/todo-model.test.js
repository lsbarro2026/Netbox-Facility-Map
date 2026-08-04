'use strict';
/* todo-model.test.js — TodoModel: the to-do ordering and vocabulary shared by every to-do surface.

   Worth pinning precisely because the class exists to define the ordering ONCE: the floor panel
   and the facility-wide page both sort through it, and if they ever disagree the same to-do
   outranks itself depending on where you look at it. These tests state the precedence rules as
   executable text.

   Dates are always derived from `TodoModel.today()` rather than hard-coded, so no assertion here
   can rot into a false pass (or a 1 January failure). */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadClasses } = require('./load.js');

const { TodoModel } = loadClasses(['todo-model.js'], ['TodoModel']);

/** An ISO date `days` away from today, in the same local-time convention `TodoModel.today()` uses. */
function isoDaysFromToday(days) {
  const [y, m, d] = TodoModel.today().split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

/** A to-do record in the shape `frontend_api._serialize_todo` emits. */
let nextId = 1;
const todo = (over = {}) => Object.assign(
  { id: nextId++, text: 't', status: 'planned', priority: 'med', due: null, assignees: [] }, over);

// ---- vocabulary ----

test('STATUSES reads in workflow order, which is NOT the sort order', () => {
  // You walk a to-do planned -> in progress -> completed, but you want the in-progress one at the
  // top of the list. The two orders are deliberately different.
  assert.deepStrictEqual(TodoModel.STATUSES.map(s => s.key),
    ['planned', 'in_progress', 'completed']);
  assert.deepStrictEqual(
    Object.entries(TodoModel.STATUS_RANK).sort((a, b) => a[1] - b[1]).map(e => e[0]),
    ['in_progress', 'planned', 'completed']);
});

test('PRIORITIES reads highest first and matches PRIORITY_RANK', () => {
  assert.deepStrictEqual(TodoModel.PRIORITIES.map(p => p.key), ['high', 'med', 'low']);
  assert.deepStrictEqual(
    Object.entries(TodoModel.PRIORITY_RANK).sort((a, b) => a[1] - b[1]).map(e => e[0]),
    ['high', 'med', 'low']);
});

// ---- assignedTo ----

test('assignedTo finds the viewer among the assignees', () => {
  const t = todo({ assignees: [{ id: 7 }, { id: 9 }] });
  assert.ok(TodoModel.assignedTo(t, 7));
  assert.ok(!TodoModel.assignedTo(t, 8));
});

test('assignedTo is false for an unknown viewer', () => {
  // Standalone injects nobody; an unknown viewer simply owns nothing.
  assert.ok(!TodoModel.assignedTo(todo({ assignees: [{ id: 7 }] }), null));
  assert.ok(!TodoModel.assignedTo(todo({ assignees: [{ id: 7 }] }), undefined));
});

test('assignedTo tolerates a record with no assignees array', () => {
  assert.ok(!TodoModel.assignedTo({ id: 1 }, 7));
});

// ---- isOverdue ----

test('isOverdue flags a past due date but not today or the future', () => {
  assert.ok(TodoModel.isOverdue(todo({ due: isoDaysFromToday(-1) })));
  assert.ok(!TodoModel.isOverdue(todo({ due: TodoModel.today() })));   // due today is not late yet
  assert.ok(!TodoModel.isOverdue(todo({ due: isoDaysFromToday(1) })));
});

test('completed work is never overdue', () => {
  // It's done; flagging it red would be nagging about nothing.
  assert.ok(!TodoModel.isOverdue(
    todo({ due: isoDaysFromToday(-30), status: 'completed' })));
});

test('a to-do with no due date is never overdue', () => {
  assert.ok(!TodoModel.isOverdue(todo({ due: null })));
});

// ---- compare: the shared precedence ----

test('the viewer\'s own work outranks everything else', () => {
  // An explicit product requirement: your own work first, whatever its status or priority.
  const mine = todo({ status: 'completed', priority: 'low', assignees: [{ id: 7 }] });
  const theirs = todo({ status: 'in_progress', priority: 'high' });
  assert.ok(TodoModel.compare(mine, theirs, 7) < 0);
  // With no viewer, the ordinary rules take over and the in-progress high-priority one wins.
  assert.ok(TodoModel.compare(mine, theirs, null) > 0);
});

test('status outranks priority', () => {
  const inProgLow = todo({ status: 'in_progress', priority: 'low' });
  const plannedHigh = todo({ status: 'planned', priority: 'high' });
  assert.ok(TodoModel.compare(inProgLow, plannedHigh, null) < 0);
});

test('priority outranks the due date', () => {
  const highLate = todo({ priority: 'high', due: isoDaysFromToday(90) });
  const lowSoon = todo({ priority: 'low', due: isoDaysFromToday(1) });
  assert.ok(TodoModel.compare(highLate, lowSoon, null) < 0);
});

test('an undated to-do sorts after every dated one of the same rank', () => {
  // An open-ended task isn't more urgent than one with a deadline, however far off.
  const dated = todo({ due: isoDaysFromToday(3650) });
  const undated = todo({ due: null });
  assert.ok(TodoModel.compare(dated, undated, null) < 0);
});

test('an unknown status sorts with the completed tail rather than jumping the queue', () => {
  const future = todo({ status: 'archived_someday' });
  const planned = todo({ status: 'planned' });
  const completed = todo({ status: 'completed' });
  assert.ok(TodoModel.compare(planned, future, null) < 0);
  assert.ok(TodoModel.compare(completed, future, null) < 0);
});

test('id is the stable tiebreak, so equal-ranking rows keep one fixed order', () => {
  const a = todo({ id: 1 }), b = todo({ id: 2 });
  assert.ok(TodoModel.compare(a, b, null) < 0);
  assert.ok(TodoModel.compare(b, a, null) > 0);
  assert.strictEqual(TodoModel.compare(a, a, null), 0);
});

// ---- sorted / comparator ----

test('sorted returns a copy and leaves the caller\'s array untouched', () => {
  const list = [todo({ id: 20 }), todo({ id: 10 })];
  const before = [...list];
  const out = TodoModel.sorted(list, null);
  assert.notStrictEqual(out, list);
  assert.deepStrictEqual(list, before);
  assert.deepStrictEqual(out.map(t => t.id), [10, 20]);
});

test('comparator offers every advertised sort axis', () => {
  for (const { key } of TodoModel.SORTS)
    assert.strictEqual(typeof TodoModel.comparator(key, null), 'function', key);
});

test('the "created" axis is newest-first', () => {
  // `id` is monotonic with creation, so newest-first is simply descending id.
  const out = [todo({ id: 1 }), todo({ id: 3 }), todo({ id: 2 })]
    .sort(TodoModel.comparator('created', null));
  assert.deepStrictEqual(out.map(t => t.id), [3, 2, 1]);
});

test('single-axis sorts ignore the other axes but keep the id tiebreak', () => {
  const out = [
    todo({ id: 1, priority: 'low', status: 'in_progress' }),
    todo({ id: 2, priority: 'high', status: 'completed' }),
    todo({ id: 3, priority: 'high', status: 'planned' }),
  ].sort(TodoModel.comparator('priority', null));
  assert.deepStrictEqual(out.map(t => t.id), [2, 3, 1]);
});

test('the "due" axis puts undated work last, matching compare', () => {
  const out = [
    todo({ id: 1, due: null }),
    todo({ id: 2, due: isoDaysFromToday(5) }),
    todo({ id: 3, due: isoDaysFromToday(1) }),
  ].sort(TodoModel.comparator('due', null));
  assert.deepStrictEqual(out.map(t => t.id), [3, 2, 1]);
});

test('an unknown sort key degrades to the smart ordering', () => {
  const mine = todo({ status: 'completed', assignees: [{ id: 7 }] });
  const theirs = todo({ status: 'in_progress' });
  assert.ok(TodoModel.comparator('no-such-axis', 7)(mine, theirs) < 0);
});
