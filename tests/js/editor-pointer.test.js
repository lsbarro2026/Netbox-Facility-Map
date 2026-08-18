'use strict';
/* editor-pointer.test.js — the DOM-free half of EditorPointer: what a press arms, and the two
   latches that decide whether a press was a click or a drag.

   `bind()`'s pointer cascade needs a browser and stays out of this tier (see README.md). What is
   in scope is the logic that cascade *consults*: `pressIntent` (a pure static), and the
   `gestureClick` / `_pastDragThreshold` / hand-tool state machine, which reads nothing but its own
   fields and a back-ref that a three-line stub satisfies.

   These pin FLOOR-7's central bargain — a left press arms a pan wherever it lands, and it is the
   drag threshold, not the hit test, that keeps a room's click working. */

const test = require('node:test');
const assert = require('node:assert');
const { loadClasses } = require('./load.js');

const { EditorPointer, DRAG_THRESHOLD_PX } = loadClasses(
  ['editor-pointer.js'], ['EditorPointer', 'DRAG_THRESHOLD_PX']);

/** A press description with view-mode defaults; each test overrides only what it is about. */
const press = (over = {}) => Object.assign(
  { button: 0, onBackground: false, rectMode: false, editing: false, gridAdjust: false }, over);

/** The minimum back-ref the hand tool touches: an svg whose class list it toggles. */
function stubEditor() {
  const classes = new Set();
  return { svg: { classList: {
    toggle: (name, on) => { on ? classes.add(name) : classes.delete(name); },
    has: (name) => classes.has(name),
  } } };
}

test('a left press on a shape arms a pan — with its capture deferred', () => {
  // The FLOOR-7 fix itself: on a floor whose rooms tile the whole view there is no background
  // left to grab, so the press must still pan. Deferred, because taking pointer capture here
  // would retarget the trailing `click` to the svg and break every room/hotspot click.
  assert.strictEqual(EditorPointer.pressIntent(press()), 'pan-deferred');
});

test('a left press on the background still arms a pan, capturing immediately', () => {
  assert.strictEqual(EditorPointer.pressIntent(press({ onBackground: true })), 'pan');
});

test('the middle button pans from anywhere, capturing immediately', () => {
  assert.strictEqual(EditorPointer.pressIntent(press({ button: 1 })), 'pan');
  assert.strictEqual(EditorPointer.pressIntent(press({ button: 1, onBackground: true })), 'pan');
});

test('the right button arms nothing', () => {
  // Right-click belongs to the vertex-removal context menu; arming a pan under it would fight it.
  assert.strictEqual(EditorPointer.pressIntent(press({ button: 2 })), null);
  assert.strictEqual(EditorPointer.pressIntent(press({ button: 2, onBackground: true })), null);
});

test('the rectangle tool also takes a press on a shape (FLOOR-8)', () => {
  const rect = { rectMode: true, editing: true };
  assert.strictEqual(EditorPointer.pressIntent(press({ ...rect, onBackground: true })), 'rect');
  // On a shape it now also arms a box — a floor whose rooms tile the view would otherwise
  // leave no background for the tool to grab, same reasoning as the pan rule above.
  assert.strictEqual(EditorPointer.pressIntent(press(rect)), 'rect');
  // View mode, or mid grid-adjust, are not box-drawing states.
  assert.strictEqual(
    EditorPointer.pressIntent(press({ rectMode: true, onBackground: true })), 'pan');
  assert.strictEqual(
    EditorPointer.pressIntent(press({ ...rect, onBackground: true, gridAdjust: true })), 'pan');
});

test('gestureClick consumes exactly one armed click', () => {
  const p = new EditorPointer(stubEditor());
  // Nothing armed: a plain press on a room reaches its own click handler, which navigates.
  assert.strictEqual(p.gestureClick(), false);
  p._suppressClick = true;                      // a pan that moved arms it on pointerup
  assert.strictEqual(p.gestureClick(), true);   // ...and the room's handler bails
  assert.strictEqual(p.gestureClick(), false);  // one click only; the next tap is genuine
});

test('the drag threshold latches, and not before it is crossed', () => {
  const p = new EditorPointer(stubEditor());
  p._dragDown = { x: 100, y: 100, moved: false };
  const at = (x, y) => p._pastDragThreshold({ clientX: x, clientY: y });
  assert.strictEqual(at(100 + DRAG_THRESHOLD_PX - 0.001, 100), false, 'just under is still a click');
  assert.strictEqual(p._dragDown.moved, false);
  assert.strictEqual(at(100 + DRAG_THRESHOLD_PX, 100), true, 'at the threshold it is a drag');
  // Latched: coming back inside the radius mid-drag does not turn the drag back into a click.
  assert.strictEqual(at(100, 100), true);
});

test('Space engages the hand tool, releasing it puts it away', () => {
  const ed = stubEditor();
  const p = new EditorPointer(ed);
  let prevented = 0;
  const key = (target = null) => ({ key: ' ', target, preventDefault: () => { prevented++; } });

  p.handleKey(key());
  assert.strictEqual(p._forcePan, true);
  assert.strictEqual(prevented, 1, 'Space is the page scroll key — it must be swallowed');
  assert.ok(ed.svg.classList.has('force-pan'), 'the cursor advertises the mode');

  p.handleKey(key());   // auto-repeat while held is a no-op, not a toggle
  assert.strictEqual(p._forcePan, true);

  p.handleKeyUp({ key: ' ' });
  assert.strictEqual(p._forcePan, false);
  assert.ok(!ed.svg.classList.has('force-pan'));
});

test('Space over a focused control is left to that control', () => {
  // App's document keydown filters only input/textarea/select, so a focused toolbar button still
  // reaches us — and Space is how a keyboard user presses it.
  const p = new EditorPointer(stubEditor());
  let prevented = 0;
  const button = { closest: (sel) => (sel.includes('button') ? {} : null) };
  p.handleKey({ key: ' ', target: button, preventDefault: () => { prevented++; } });
  assert.strictEqual(p._forcePan, false);
  assert.strictEqual(prevented, 0);
});

test('losing window focus releases the hand tool', () => {
  // The keyup after an alt-tab is delivered elsewhere and never arrives, and a hand tool stuck on
  // would swallow every click on the map.
  const ed = stubEditor();
  const p = new EditorPointer(ed);
  p.handleKey({ key: ' ', target: null, preventDefault: () => {} });
  p.cancelHeldKeys();
  assert.strictEqual(p._forcePan, false);
  assert.ok(!ed.svg.classList.has('force-pan'));
});
