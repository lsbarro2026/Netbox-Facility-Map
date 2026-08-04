'use strict';
/* lib.test.js — the pure helper classes in lib.js: `Geom` (the geometry every editor and every
   server-side preview mirror shares) and the stateless half of `Util`.

   Out of this tier by design: `Dom` (builds real elements), `Icons` (markup only), `Toast` /
   `Tooltip` / `Combo` (own DOM nodes and timers), `Api` (fetches), and `Util.phoneMq` (calls
   `window.matchMedia`). `Geom` is the part worth pinning here — it is normalized-0..1 arithmetic
   with a Python mirror in `previews.py`, and a silent sign or ordering change there is invisible
   until a room renders wrong. */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadClasses } = require('./load.js');

const { Util, Geom } = loadClasses(['lib.js'], ['Util', 'Geom']);

/** The unit square, counter-clockwise — the shape most assertions below are stated against. */
const UNIT = [[0, 0], [1, 0], [1, 1], [0, 1]];
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---- Util ----

test('floorKey joins a building dir and floor id', () => {
  assert.strictEqual(Util.floorKey('01-admin', 'l1'), '01-admin/l1');
});

test('isNumbered recognizes the NN- building-slug convention', () => {
  assert.ok(Util.isNumbered('01-admin'));
  assert.ok(Util.isNumbered('99-x'));
  assert.ok(!Util.isNumbered('1-admin'));        // exactly two digits
  assert.ok(!Util.isNumbered('admin'));
  assert.ok(!Util.isNumbered(''));
  assert.ok(!Util.isNumbered(null));             // null-safe: the legend renders before data lands
});

test('initials takes two words, or the first two letters of a single word', () => {
  assert.strictEqual(Util.initials('Central Plant'), 'CP');
  assert.strictEqual(Util.initials('Library'), 'LI');
  assert.strictEqual(Util.initials('Residence Hall North'), 'RH');   // first two words only
  assert.strictEqual(Util.initials('  spaced   out  '), 'SO');       // collapses whitespace
  assert.strictEqual(Util.initials(''), '');
  assert.strictEqual(Util.initials(null), '');
});

test('code prefers a numbered dir and falls back to the name initials', () => {
  // MULTI-6: `NN-` is one recognized convention, not the only one, so a building that does not
  // use it badges from its name rather than leaking a raw slug into a generic UI.
  assert.strictEqual(Util.code({ dir: '01-admin', name: 'Administration' }), '01');
  assert.strictEqual(Util.code({ dir: 'admin', name: 'Central Plant' }), 'CP');
  assert.strictEqual(Util.code(null), '');
});

// ---- Geom: centroid / bounds ----

test('centroid averages the vertices', () => {
  assert.deepStrictEqual(Geom.centroid(UNIT), [0.5, 0.5]);
  assert.deepStrictEqual(Geom.centroid([[0, 0], [2, 0], [1, 3]]), [1, 1]);
});

test('bounds reports the box, its size and its centre together', () => {
  const b = Geom.bounds([[0.2, 0.1], [0.6, 0.1], [0.6, 0.5]]);
  assert.deepStrictEqual(
    { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY },
    { minX: 0.2, minY: 0.1, maxX: 0.6, maxY: 0.5 });
  assert.ok(close(b.w, 0.4) && close(b.h, 0.4));
  assert.ok(close(b.cx, 0.4) && close(b.cy, 0.3));
});

// ---- Geom: focus regions (the deep-link / search-jump landing) ----

test('clampRegion keeps a region inside the 0..1 canvas', () => {
  assert.deepStrictEqual(Geom.clampRegion(-0.3, -0.2, 1.4, 1.1), [0, 0, 1, 1]);
  assert.deepStrictEqual(Geom.clampRegion(0.1, 0.2, 0.3, 0.4), [0.1, 0.2, 0.3, 0.4]);
});

test('focusRegion pads around a room and never leaves the canvas', () => {
  // A target near an edge simply loses the padding that ran off the side — the view lands
  // asymmetric, which is correct, not a bug to "fix" by letting coordinates leave 0..1.
  const [x0, y0, x1, y1] = Geom.focusRegion([[0.4, 0.4], [0.5, 0.4], [0.5, 0.5], [0.4, 0.5]]);
  assert.ok(x0 < 0.4 && y0 < 0.4 && x1 > 0.5 && y1 > 0.5, 'pads on every side');

  const corner = Geom.focusRegion([[0, 0], [0.05, 0], [0.05, 0.05], [0, 0.05]]);
  assert.deepStrictEqual(corner.slice(0, 2), [0, 0]);
  assert.ok(corner.every(v => v >= 0 && v <= 1));
});

test('pointRegion frames a placement marker symmetrically, then clamps', () => {
  assert.deepStrictEqual(Geom.pointRegion(0.5, 0.5, 0.1), [0.4, 0.4, 0.6, 0.6]);
  assert.deepStrictEqual(Geom.pointRegion(0, 0, 0.1), [0, 0, 0.1, 0.1]);
});

// ---- Geom: projSeg ----

test('projSeg returns the nearest point on a segment and its distance', () => {
  const mid = Geom.projSeg(0.5, 1, 0, 0, 1, 0);
  assert.ok(close(mid.x, 0.5) && close(mid.y, 0) && close(mid.d, 1));
});

test('projSeg clamps to the segment endpoints rather than the infinite line', () => {
  const past = Geom.projSeg(5, 0, 0, 0, 1, 0);
  assert.ok(close(past.x, 1) && close(past.d, 4));
  const before = Geom.projSeg(-5, 0, 0, 0, 1, 0);
  assert.ok(close(before.x, 0) && close(before.d, 5));
});

test('projSeg degrades to the endpoint for a zero-length segment, not NaN', () => {
  const p = Geom.projSeg(3, 4, 1, 1, 1, 1);
  assert.ok(close(p.x, 1) && close(p.y, 1) && close(p.d, Math.hypot(2, 3)));
});

// ---- Geom: pointInPoly ----

test('pointInPoly answers for a convex polygon', () => {
  assert.ok(Geom.pointInPoly(0.5, 0.5, UNIT));
  assert.ok(!Geom.pointInPoly(1.5, 0.5, UNIT));
  assert.ok(!Geom.pointInPoly(0.5, -0.5, UNIT));
});

test('pointInPoly answers for a concave polygon', () => {
  // An L-shape: the notch is outside even though it sits inside the bounding box.
  const L = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
  assert.ok(Geom.pointInPoly(0.5, 1.5, L));
  assert.ok(!Geom.pointInPoly(1.5, 1.5, L));       // inside the bbox, outside the shape
});

test('pointInPoly gives opposite answers either side of an edge', () => {
  // Ray casting is half-open by construction; what matters to a caller is that the two sides
  // disagree, so a point can never read as inside two adjacent rooms at once.
  assert.notStrictEqual(Geom.pointInPoly(0.5, 0.001, UNIT), Geom.pointInPoly(0.5, -0.001, UNIT));
});

// ---- Geom: polyArea ----

test('polyArea is unsigned, so winding order does not matter', () => {
  assert.ok(close(Geom.polyArea(UNIT), 1));
  assert.ok(close(Geom.polyArea([...UNIT].reverse()), 1));
});

test('polyArea is zero for a degenerate ring', () => {
  assert.strictEqual(Geom.polyArea([[0, 0], [1, 1]]), 0);
  assert.strictEqual(Geom.polyArea([]), 0);
});

// ---- Geom: clampToPoly ----

test('clampToPoly leaves an inside point alone and pulls an outside one to the nearest edge', () => {
  assert.deepStrictEqual(Geom.clampToPoly(0.5, 0.5, UNIT), [0.5, 0.5]);
  const [x, y] = Geom.clampToPoly(2, 0.5, UNIT);
  assert.ok(close(x, 1) && close(y, 0.5));
});

// ---- Geom: arrowHead ----

test('arrowHead puts the tip at b and the base behind it', () => {
  const [tip, left, right] = Geom.arrowHead(0, 0, 10, 0, 4);
  assert.deepStrictEqual(tip, [10, 0]);
  assert.ok(close(left[0], 6) && close(right[0], 6), 'base sits sizePx behind the tip');
  assert.ok(close(left[1], -right[1]), 'base is symmetric about the axis');
});

test('arrowHead degrades to a horizontal head for a zero-length direction, not NaN', () => {
  const pts = Geom.arrowHead(3, 3, 3, 3, 4);
  assert.ok(pts.flat().every(Number.isFinite));
});

// ---- Geom: evenoddPath / containedMap (the room-fill hole punching) ----

test('evenoddPath scales normalized rings and closes each subpath', () => {
  assert.strictEqual(Geom.evenoddPath([[[0, 0], [1, 0], [1, 1]]], 100, 200),
    'M0,0 L100,0 100,200 Z');
});

test('evenoddPath skips rings with fewer than three points', () => {
  assert.strictEqual(Geom.evenoddPath([[[0, 0], [1, 1]]], 10, 10), '');
  assert.strictEqual(Geom.evenoddPath([], 10, 10), '');
});

test('containedMap reports a strictly smaller room inside a larger one', () => {
  const outer = { id: 'outer', polygon: UNIT };
  const inner = { id: 'inner', polygon: [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.4]] };
  const map = Geom.containedMap([outer, inner]);
  assert.deepStrictEqual(map.get('outer'), [inner.polygon]);
  assert.ok(!map.has('inner'));
});

test('containedMap ignores a merely overlapping room', () => {
  // Containment is strict — every vertex inside. A room straddling a boundary is out of scope
  // (true polygon clipping would be a different feature).
  const map = Geom.containedMap([
    { id: 'a', polygon: UNIT },
    { id: 'b', polygon: [[0.8, 0.8], [1.6, 0.8], [1.6, 1.6], [0.8, 1.6]] },
  ]);
  assert.strictEqual(map.size, 0);
});

test('containedMap keeps only DIRECT children, so evenodd parity survives nesting', () => {
  // A inside B inside C: C must punch out B only. Listing A at C's level too would flip the
  // parity back and re-fill the innermost room.
  const c = { id: 'c', polygon: UNIT };
  const b = { id: 'b', polygon: [[0.1, 0.1], [0.7, 0.1], [0.7, 0.7], [0.1, 0.7]] };
  const a = { id: 'a', polygon: [[0.2, 0.2], [0.3, 0.2], [0.3, 0.3], [0.2, 0.3]] };
  const map = Geom.containedMap([c, b, a]);
  assert.deepStrictEqual(map.get('c'), [b.polygon]);
  assert.deepStrictEqual(map.get('b'), [a.polygon]);
});
