'use strict';
/* editor.test.js — the pure statics behind `Editor`'s shared shape editing: `_movedIndex` (ROOM-4:
   bring to front / raise / lower / send to back, scoped to an overlap group by ROOM-5),
   `_placedIndex` (ROOM-8: where a just-created shape lands when it contains existing ones) and
   `_snappedDelta` (FLOOR-9: how a whole-shape or whole-wall drag picks its one rigid translation
   delta).

   Only these statics are in scope. The rest of `Editor` is DOM/SVG rendering, pointer plumbing and a
   constructed store — a browser's job, deliberately out of this tier (see README). All three were
   split out of their callers precisely so the arithmetic could be pinned here: an off-by-one or a
   missing clamp silently reorders the wrong room or throws a shape out of the array, and a lost snap
   priority silently drops a room a few px from where it visibly clicked into place.

   `lib.js` loads first because `_snappedDelta` calls `Geom.projSeg` — dependency order, exactly as
   index.html loads them. */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadClasses } = require('./load.js');

const { Editor } = loadClasses(['lib.js', 'editor.js'], ['Editor']);

// The list is bottom→top, so index 0 is the BACK of the stack and `len - 1` is the FRONT. `group`
// is the ascending list of indices the action may move among — the selected shape's overlap group
// (ROOM-5) — and every answer is an index into the SAME whole array.
const LEN = 5;
const ALL = [0, 1, 2, 3, 4];   // everything overlaps everything: the pre-ROOM-5 whole-array case

test('front and back jump to the ends of the stack, from anywhere', () => {
  for (const i of ALL) {
    assert.strictEqual(Editor._movedIndex(ALL, i, 'front'), LEN - 1);
    assert.strictEqual(Editor._movedIndex(ALL, i, 'back'), 0);
  }
});

test('up and down step exactly one position', () => {
  assert.strictEqual(Editor._movedIndex(ALL, 2, 'up'), 3);
  assert.strictEqual(Editor._movedIndex(ALL, 2, 'down'), 1);
});

test('up and down clamp at the extremes instead of running off the array', () => {
  assert.strictEqual(Editor._movedIndex(ALL, LEN - 1, 'up'), LEN - 1);   // already frontmost
  assert.strictEqual(Editor._movedIndex(ALL, 0, 'down'), 0);             // already backmost
});

test('a shape already at the target index reports no move, so the caller can skip the work', () => {
  // `reorderShape` compares the result against the current index and bails when they match — this
  // is what keeps a click on an already-topmost room from pushing a no-op undo snapshot.
  assert.strictEqual(Editor._movedIndex(ALL, LEN - 1, 'front'), LEN - 1);
  assert.strictEqual(Editor._movedIndex(ALL, 0, 'back'), 0);
});

test('a single-shape list is a fixed point for every action', () => {
  for (const where of ['front', 'back', 'up', 'down'])
    assert.strictEqual(Editor._movedIndex([0], 0, where), 0);
});


/* ---- the overlap-group scoping (ROOM-5) ----
   A shape only stacks against the shapes it actually covers, so the four actions step past GROUP
   MEMBERS and hop whatever non-overlapping shapes lie between them in the array. */

// Shapes 0, 2 and 4 mutually overlap; 1 and 3 sit between them touching nothing.
const GAPPED = [0, 2, 4];

test('up and down land on the next GROUP member, hopping the shapes in between', () => {
  assert.strictEqual(Editor._movedIndex(GAPPED, 0, 'up'), 2);
  assert.strictEqual(Editor._movedIndex(GAPPED, 2, 'up'), 4);
  assert.strictEqual(Editor._movedIndex(GAPPED, 4, 'down'), 2);
  assert.strictEqual(Editor._movedIndex(GAPPED, 2, 'down'), 0);
});

test('front and back jump to the ends of the GROUP, not of the whole array', () => {
  // Index 4 happens to be the array's last slot here, but 0 is the group's back only because no
  // member sits below it — the answers come from the group, never from `arr.length`.
  assert.strictEqual(Editor._movedIndex([1, 3], 1, 'front'), 3);
  assert.strictEqual(Editor._movedIndex([1, 3], 3, 'back'), 1);
});

test('a shape at either end of its group cannot move that way, even mid-array', () => {
  assert.strictEqual(Editor._movedIndex(GAPPED, 4, 'up'), 4);       // top of the group
  assert.strictEqual(Editor._movedIndex(GAPPED, 0, 'down'), 0);     // bottom of it
  assert.strictEqual(Editor._movedIndex([2], 2, 'front'), 2);       // overlaps nothing at all
  assert.strictEqual(Editor._movedIndex([2], 2, 'back'), 2);
});

test('an index outside its group is a fixed point, so a stale shape cannot be flung anywhere', () => {
  // `layerButtons` hands an empty group for a shape mid-teardown; `reorderShape` reads `i` back as
  // "nothing moved" and bails before snapshotting.
  for (const where of ['front', 'back', 'up', 'down']) {
    assert.strictEqual(Editor._movedIndex([], 2, where), 2);
    assert.strictEqual(Editor._movedIndex(GAPPED, 3, where), 3);
  }
});

/** `reorderShape`'s remove-then-insert pair (editor.js — `arr.splice(i, 1)` then
 *  `arr.splice(to, 0, shape)`), replicated so this tier can pin the ORDER a click produces and not
 *  just the index arithmetic feeding it. Keep the two in step. */
const restack = (arr, i, to) => {
  const out = arr.slice(), [shape] = out.splice(i, 1);
  out.splice(to, 0, shape);
  return out;
};

test('a group move lands the shape beside its group neighbour, past the shapes it hops', () => {
  // The item's acceptance case: A, B and C mutually overlap; X and Y sit between them and overlap
  // nothing. Every action must reorder A/B/C relative to each other and leave X and Y's own
  // relative order alone — the single global array is still the one z-order (ROOM-4).
  const arr = ['A', 'X', 'B', 'Y', 'C'];
  const move = (i, where) => restack(arr, i, Editor._movedIndex(GAPPED, i, where));
  assert.deepStrictEqual(move(2, 'up'), ['A', 'X', 'Y', 'C', 'B']);      // B above C
  assert.deepStrictEqual(move(2, 'down'), ['B', 'A', 'X', 'Y', 'C']);    // B below A
  assert.deepStrictEqual(move(0, 'front'), ['X', 'B', 'Y', 'C', 'A']);   // A above every member
  assert.deepStrictEqual(move(4, 'back'), ['C', 'A', 'X', 'B', 'Y']);    // C below every member
});

/* ---- Editor._placedIndex (ROOM-8) ----
   Where a just-created shape belongs once the shapes it fully contains are known. A new shape is
   appended at the top, so drawing the big open-plan room AFTER the rooms inside it used to bury
   them: the container painted over them, took their clicks, and dropped their punch-out. `inside`
   is the ascending index list from `Geom.containedIndices`. */

test('a new shape drops just below the LOWEST shape it contains', () => {
  // Below every one of them: the rest sit at higher indices and the remove-then-insert pair shifts
  // them up as a block. Pinned through `restack` so it is the resulting ORDER being asserted.
  const arr = ['small', 'other', 'mid', 'BIG'];
  const inside = [0, 2];                                   // BIG contains 'small' and 'mid'
  assert.strictEqual(Editor._placedIndex(inside, 3), 0);
  assert.deepStrictEqual(restack(arr, 3, Editor._placedIndex(inside, 3)),
    ['BIG', 'small', 'other', 'mid']);
});

test('the drop is the MINIMAL one — no lower than the shapes it contains require', () => {
  // A linear z-order cannot also keep the new shape above non-contained shapes interleaved further
  // up, but it must not be buried under the ones below its lowest child either.
  const arr = ['floor', 'a', 'b', 'BIG'];
  assert.strictEqual(Editor._placedIndex([1, 2], 3), 1);
  assert.deepStrictEqual(restack(arr, 3, Editor._placedIndex([1, 2], 3)),
    ['floor', 'BIG', 'a', 'b']);   // still above 'floor', which contains it
});

test('a shape containing nothing stays exactly where it was drawn', () => {
  // The common case, and the reason the toast only fires on a real move: overlap alone is not
  // containment, and "drawn last is on top" is the right default there.
  for (const i of [0, 3, 7]) assert.strictEqual(Editor._placedIndex([], i), i);
});

test('a shape already below everything it contains does not move', () => {
  // Reached by `duplicateShape`/undo replay rather than a fresh append, but the guard is what makes
  // `_placeNewShape` return 0 instead of claiming a placement it never made.
  assert.strictEqual(Editor._placedIndex([3, 4], 2), 2);
  assert.strictEqual(Editor._placedIndex([2], 2), 2);   // degenerate: cannot insert below itself
});


/* ---- Editor._snappedDelta (FLOOR-9) ----
   A 1000×1000 surface with 1000×1000 intrinsic px, so normalized 0..1 maps to px by ×1000 and an
   assertion can be read straight off the numbers. The snap radius is SNAP_PX at scale 1. */

const CTX = { W: 1000, H: 1000, iw: 1000, ih: 1000 };
const SNAP_PX = 11;

/** A GridController stand-in: only `.snap`/`.ox`/`.oy` are read, and `snap` is copied verbatim from
 *  grid.js. The real one persists to localStorage in its `step` setter, which this tier has no
 *  business faking — the stub keeps the input honest without dragging in a browser. */
const gridOf = (step, ox = 0, oy = 0) =>
  ({ ox, oy, snap: (v, offset) => Math.round((v - offset) / step) * step + offset });

const ctx = (over = {}) => Object.assign({}, CTX, { snapPx: SNAP_PX, grid: null }, over);

/** Deltas come back as raw floats (the callers apply `toFixed(5)` when they write vertices). */
const near = (actual, expected, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < eps, `${actual} !≈ ${expected}`);

test('with no neighbour in reach the delta is still quantized to whole grid cells', () => {
  // The behaviour FLOOR-9 must not regress: a room with no neighbours moves by a whole number of
  // cells, so an on-grid room stays on-grid and undistorted.
  const [dx, dy] = Editor._snappedDelta(
    [[0.2, 0.2], [0.3, 0.2], [0.3, 0.3]], 0.137, -0.052, [], ctx({ grid: gridOf(100) }));
  near(dx, 0.1);
  near(dy, -0.1);
});

test('a neighbouring vertex in reach pulls the shape exactly onto it', () => {
  // The item's core case: two rooms whose shared wall was made by snapping vertex-to-vertex can be
  // re-joined by a whole-shape drag, not just by re-dragging the individual points.
  const pt = [0.5, 0.5];
  const neighbour = [[0.605, 0.503], [0.7, 0.503], [0.7, 0.6]];
  const [dx, dy] = Editor._snappedDelta([pt], 0.1, 0, [neighbour], ctx());
  near(pt[0] + dx, 0.605);
  near(pt[1] + dy, 0.503);
});

test('a vertex outranks an edge, even when the edge is nearer', () => {
  // Same priority as `snapPoint`: a corner is the stronger intent. The vertex here sits 8px away
  // while the wall runs 2px away, and the vertex must still win.
  const pt = [0.5, 0.5];
  const corner = [[0.608, 0.5], [0.608, 0.9], [0.7, 0.9]];   // 8px from the candidate (600,500)
  const wall = [[0.602, 0.0], [0.602, 0.4], [0.65, 0.4]];    // its first edge runs 2px away
  const [dx, dy] = Editor._snappedDelta([pt], 0.1, 0, [corner, wall], ctx());
  near(pt[0] + dx, 0.608);
  near(pt[1] + dy, 0.5);
});

test('an edge snap corrects perpendicular to the wall only, leaving the along-wall position alone', () => {
  // Butting a room flat against a neighbour's wall must not also slide it up or down the wall.
  const pt = [0.5, 0.5];
  const wall = [[0.62, 0.0], [0.62, 1.0]];   // a vertical wall, its vertices far from the candidate
  const [dx, dy] = Editor._snappedDelta([pt], 0.115, 0.043, [wall], ctx());
  near(pt[0] + dx, 0.62);      // perpendicular axis snapped onto the wall
  near(dy, 0.043);             // parallel axis untouched
});

test('with the grid on, an edge snap also quantizes where the shape sits ALONG the wall', () => {
  // `snapPoint` does exactly this for a single node (grid-snap the contact point, re-project onto
  // the segment) so an edge-snapped point cannot slide freely; a body drag must match.
  const pt = [0.5, 0.5];
  const wall = [[0.62, 0.0], [0.62, 1.0]];
  const [dx, dy] = Editor._snappedDelta([pt], 0.115, 0.043, [wall], ctx({ grid: gridOf(100) }));
  near(pt[0] + dx, 0.62);   // still flush against the wall
  near(pt[1] + dy, 0.5);    // and quantized along it (543px → the 500px grid line)
});

test('the snap toggle off falls straight through to the grid, ignoring a neighbour underfoot', () => {
  const pt = [0.5, 0.5];
  const neighbour = [[0.605, 0.503], [0.7, 0.503], [0.7, 0.6]];
  const [dx, dy] = Editor._snappedDelta(
    [pt], 0.137, -0.052, [neighbour], ctx({ snapPx: 0, grid: gridOf(100) }));
  near(dx, 0.1);
  near(dy, -0.1);
});

test('both snaps off returns the raw delta untouched — this is what Alt gives you', () => {
  const pt = [0.5, 0.5];
  const neighbour = [[0.605, 0.503], [0.7, 0.503], [0.7, 0.6]];
  const [dx, dy] = Editor._snappedDelta([pt], 0.137, -0.052, [neighbour], ctx({ snapPx: 0 }));
  near(dx, 0.137);
  near(dy, -0.052);
});

test('one shared delta moves every point, so the shape translates rigidly', () => {
  // The contract `_startShapeDrag`'s `onDelta` hook depends on: whichever point wins the snap, all
  // the others shift by the SAME offset, so the shape never distorts and satellite geometry
  // (rack/device markers) can ride along on that one delta.
  const shape = [[0.20, 0.20], [0.40, 0.20], [0.40, 0.35], [0.20, 0.35]];
  const neighbour = [[0.505, 0.204], [0.60, 0.204], [0.60, 0.30]];   // in reach of the moved corner
  const [dx, dy] = Editor._snappedDelta(shape, 0.1, 0, [neighbour], ctx({ grid: gridOf(100) }));
  const moved = shape.map(([x, y]) => [x + dx, y + dy]);
  near(moved[1][0], 0.505);   // the top-right corner landed on the neighbour's vertex...
  near(moved[1][1], 0.204);
  for (let i = 0; i < shape.length; i++) {       // ...and every side kept its exact length
    const j = (i + 1) % shape.length;
    near(Math.hypot(moved[j][0] - moved[i][0], moved[j][1] - moved[i][1]),
         Math.hypot(shape[j][0] - shape[i][0], shape[j][1] - shape[i][1]));
  }
});

test('a shape is never snapped to itself — the dragged polygon is excluded by the caller', () => {
  // `_snapDelta` filters the dragged array out by identity before calling this; with an empty
  // `others` the only remaining pull is the grid, so a lone shape drags cleanly.
  const shape = [[0.2, 0.2], [0.4, 0.2], [0.4, 0.35]];
  const [dx, dy] = Editor._snappedDelta(shape, 0.008, 0.008, [], ctx());
  near(dx, 0.008);
  near(dy, 0.008);
});
