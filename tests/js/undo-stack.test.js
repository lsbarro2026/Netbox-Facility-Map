'use strict';
/* undo-stack.test.js — UndoStack: the bounded LIFO of opaque editor snapshots.

   Small enough to read in one sitting, but two of its properties are load-bearing and easy to
   break by "tidying": the cap drops from the BOTTOM (so the newest history survives), and `peek()`
   returns the snapshot by IDENTITY (the post-delete Undo toast pins that identity so a later
   mutation can't make its button revert the wrong thing). */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadClasses } = require('./load.js');

const { UndoStack } = loadClasses(['undo-stack.js'], ['UndoStack']);

test('pops in last-in-first-out order', () => {
  const s = new UndoStack();
  s.push('a'); s.push('b'); s.push('c');
  assert.strictEqual(s.pop(), 'c');
  assert.strictEqual(s.pop(), 'b');
  assert.strictEqual(s.pop(), 'a');
});

test('pop and peek return null when empty, never undefined', () => {
  const s = new UndoStack();
  assert.strictEqual(s.pop(), null);
  assert.strictEqual(s.peek(), null);
  assert.strictEqual(s.size, 0);
});

test('peek returns the top without removing it', () => {
  const s = new UndoStack();
  s.push('a'); s.push('b');
  assert.strictEqual(s.peek(), 'b');
  assert.strictEqual(s.size, 2);
  assert.strictEqual(s.peek(), s.pop());
});

test('the depth cap drops the OLDEST entries, keeping recent history', () => {
  const s = new UndoStack(3);
  for (const v of ['a', 'b', 'c', 'd', 'e']) s.push(v);
  assert.strictEqual(s.size, 3);
  assert.deepStrictEqual([s.pop(), s.pop(), s.pop()], ['e', 'd', 'c']);
});

test('a snapshot\'s identity survives the depth cap', () => {
  // The post-delete Undo toast pins `peek()` as a token for "the top is still the operation I
  // captured". Dropping from the bottom must not disturb that object, where a size comparison
  // would give the wrong answer entirely.
  const s = new UndoStack(2);
  const pinned = { rooms: [] };
  s.push({ first: true });
  s.push(pinned);
  assert.strictEqual(s.peek(), pinned);
  s.push({ later: true });                 // evicts the oldest, not the pinned one
  assert.notStrictEqual(s.peek(), pinned);
  assert.strictEqual(s.pop().later, true);
  assert.strictEqual(s.peek(), pinned);    // still the same object, not a copy
});

test('the stack is opaque — it never inspects or clones a snapshot', () => {
  const s = new UndoStack();
  const snap = { rooms: [{ id: 'r1' }], nested: { deep: true } };
  s.push(snap);
  assert.strictEqual(s.pop(), snap);
});

test('clear empties the stack', () => {
  const s = new UndoStack();
  s.push('a'); s.push('b');
  s.clear();
  assert.strictEqual(s.size, 0);
  assert.strictEqual(s.pop(), null);
});

test('size tracks pushes and pops', () => {
  const s = new UndoStack();
  assert.strictEqual(s.size, 0);
  s.push('a');
  assert.strictEqual(s.size, 1);
  s.push('b');
  assert.strictEqual(s.size, 2);
  s.pop();
  assert.strictEqual(s.size, 1);
});

test('the default cap is 50', () => {
  const s = new UndoStack();
  for (let i = 0; i < 60; i++) s.push(i);
  assert.strictEqual(s.size, 50);
  assert.strictEqual(s.peek(), 59);
});
