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

test('containedMap punches only children drawn ABOVE their container (ROOM-4 z-order)', () => {
  // The input is in stacking order, bottom→top. Sending the nested room BEHIND its container has
  // to drop the punch, or "send to back" would silently do nothing for the nesting case.
  const outer = { id: 'outer', polygon: UNIT };
  const inner = { id: 'inner', polygon: [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.4]] };
  assert.deepStrictEqual(Geom.containedMap([outer, inner]).get('outer'), [inner.polygon]);
  assert.strictEqual(Geom.containedMap([inner, outer]).size, 0);
});

test('containedMap keeps evenodd parity when a grandchild outranks its parent', () => {
  // Stack: big (bottom), small, mid — so `mid` is above `big` but `small` is BELOW `mid`. `big`
  // must still punch out only its direct child `mid`; listing `small` too (it is geometrically
  // inside `big` and no longer shadowed by an above-`big` child) would add a parity crossing and
  // re-fill `small`'s area. This is why the z gate applies to the pruned direct set, not to the
  // containment test itself.
  const big = { id: 'big', polygon: UNIT };
  const mid = { id: 'mid', polygon: [[0.1, 0.1], [0.7, 0.1], [0.7, 0.7], [0.1, 0.7]] };
  const small = { id: 'small', polygon: [[0.2, 0.2], [0.3, 0.2], [0.3, 0.3], [0.2, 0.3]] };
  const map = Geom.containedMap([big, small, mid]);
  assert.deepStrictEqual(map.get('big'), [mid.polygon]);
  assert.ok(!map.has('mid'));    // its own child `small` sits below it, so nothing is punched out
});

test('containedMap punches a child sharing a wall with its container, whichever wall (ROOM-6)', () => {
  // The common real floor-plan case: an interior room's wall coincides with a wall of the space it
  // was carved out of, so two of its vertices sit exactly ON the container's boundary. The bare
  // ray-cast answers such a vertex asymmetrically — inside on a left/bottom wall, outside on a
  // right/top one — so before the boundary tolerance the punch silently dropped for half of these
  // and the container's fill painted straight over the child. All four walls must behave alike.
  const outer = { id: 'outer', polygon: UNIT };
  const flush = {
    left: [[0, 0.2], [0.3, 0.2], [0.3, 0.8], [0, 0.8]],
    right: [[0.7, 0.2], [1, 0.2], [1, 0.8], [0.7, 0.8]],
    bottom: [[0.2, 0], [0.8, 0], [0.8, 0.3], [0.2, 0.3]],
    top: [[0.2, 0.7], [0.8, 0.7], [0.8, 1], [0.2, 1]],
  };
  for (const [wall, polygon] of Object.entries(flush)) {
    const map = Geom.containedMap([outer, { id: 'child', polygon }]);
    assert.deepStrictEqual(map.get('outer'), [polygon], `child flush against the ${wall} wall`);
  }
});

test('containedMap punches a child that slices its container in two, if its ends are flush', () => {
  // A corridor cutting an open-plan room in half — the case a real floor plan produces and the one
  // reported as "the punch does nothing" (ROOM-7). It is only contained when its ends stop ON the
  // container's side walls; the boundary tolerance is exactly what makes that count, so this pins
  // the same rule as the shared-wall case above with the child spanning edge to edge rather than
  // tucked against one side. The container then draws as two halves either side of the slice.
  const outer = { id: 'outer', polygon: UNIT };
  const slice = [[0, 0.45], [1, 0.45], [1, 0.55], [0, 0.55]];
  assert.deepStrictEqual(Geom.containedMap([outer, { id: 'hall', polygon: slice }]).get('outer'),
    [slice]);
});

test('containedMap leaves a slice that OVERRUNS its container un-punched', () => {
  // The other side of that line, and the reported floor's actual geometry: a corridor drawn as one
  // room running the length of the building passes THROUGH the open-plan room rather than stopping
  // at it, so its ends land outside. That is partial overlap, which needs true polygon clipping and
  // is deliberately not handled (§10 *Partial overlap composites; it is not clipped*) — the two
  // rooms composite instead. Overrun by 0.01, two orders of magnitude past the 1e-4 tolerance.
  const outer = { id: 'outer', polygon: UNIT };
  const through = [[-0.01, 0.45], [1.01, 0.45], [1.01, 0.55], [-0.01, 0.55]];
  assert.strictEqual(Geom.containedMap([outer, { id: 'hall', polygon: through }]).size, 0);
});

test('containedMap tolerance does not swallow a room outside a concave container', () => {
  // The tolerance widens containment AT the boundary, never past it. An L-shaped container and a
  // room sitting in the L's notch: the child's bbox is inside the container's, so the cheap
  // pre-check passes and the vertex test is what has to reject it — and it is outside by 0.2, three
  // orders of magnitude beyond the epsilon. Too loose a tolerance would punch a hole here.
  const el = { id: 'el', polygon: [[0, 0], [1, 0], [1, 0.4], [0.4, 0.4], [0.4, 1], [0, 1]] };
  const notch = { id: 'notch', polygon: [[0.6, 0.6], [0.9, 0.6], [0.9, 0.9], [0.6, 0.9]] };
  assert.strictEqual(Geom.containedMap([el, notch]).size, 0);
});

/* ---- Geom: containedIndices (where a newly drawn shape belongs in the z-order, ROOM-8) ----
   The one-vs-rest half of the same containment test, feeding `Editor._placedIndex`. It shares
   `containedMap`'s predicate and tolerance — so the cases above already pin the geometry — and the
   cases worth pinning here are the two places it deliberately DIVERGES: no z-order gate (it decides
   the order, so it can't read it) and no direct-child pruning (a grandchild lower in the array must
   not be missed, or it would end up above the new shape). */

const SMALL_A = [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.2]];
const SMALL_B = [[0.6, 0.6], [0.8, 0.6], [0.8, 0.8], [0.6, 0.8]];

test('containedIndices reports every contained ring, in ascending order', () => {
  assert.deepStrictEqual(Geom.containedIndices([SMALL_A, SMALL_B, UNIT], 2), [0, 1]);
});

test('containedIndices never reports the ring itself, nor an equal or larger one', () => {
  // Containment is strictly-smaller-area, so a coincident duplicate is not contained either way —
  // a re-traced room must not shove itself under its twin.
  assert.deepStrictEqual(Geom.containedIndices([UNIT, UNIT.slice(), SMALL_A], 0), [2]);
  assert.deepStrictEqual(Geom.containedIndices([UNIT, SMALL_A], 1), []);
});

test('containedIndices ignores partial overlap — only containment moves a new shape', () => {
  // Two shapes that merely cross have no correct order, and "drawn last is on top" stays right
  // there. Same line `containedMap` draws (§10 *Partial overlap composites; it is not clipped*).
  const straddle = [[0.8, 0.8], [1.6, 0.8], [1.6, 1.6], [0.8, 1.6]];
  assert.deepStrictEqual(Geom.containedIndices([straddle, UNIT], 1), []);
});

test('containedIndices reports descendants at ANY depth, unlike containedMap', () => {
  // `containedMap` prunes to direct children to keep evenodd parity; this must NOT. A grandchild
  // sitting lower in the array than its parent is the whole reason: pruning would report only the
  // parent, the new shape would be placed above the grandchild, and it would paint over and swallow
  // the clicks of exactly the room the placement exists to protect.
  const mid = [[0.05, 0.05], [0.5, 0.05], [0.5, 0.5], [0.05, 0.5]];
  assert.deepStrictEqual(Geom.containedIndices([SMALL_A, mid, UNIT], 2), [0, 1]);
});

test('containedIndices applies no z-order gate — a ring below the target still counts', () => {
  // `containedMap` punches only children drawn ABOVE their container (the `j > i` gate). Here the
  // target IS the newly appended shape at the top, so every ring it contains is below it and a gate
  // would reject all of them, leaving the new shape stranded on top — the ROOM-8 bug itself.
  assert.deepStrictEqual(Geom.containedIndices([SMALL_A, UNIT], 1), [0]);
});

test('containedIndices counts a child sharing a wall, and skips degenerate rings', () => {
  // Boundary-inclusive within the same tolerance as the punch, so the two always agree about which
  // rooms are "inside" (ROOM-6). A < 3-point ring is simply never contained, and a degenerate
  // target contains nothing rather than throwing.
  const flush = [[0, 0.2], [0.3, 0.2], [0.3, 0.8], [0, 0.8]];
  assert.deepStrictEqual(Geom.containedIndices([flush, [[0.5, 0.5], [0.6, 0.6]], UNIT], 2), [0]);
  assert.deepStrictEqual(Geom.containedIndices([SMALL_A, [[0.5, 0.5]]], 1), []);
});

/* ---- Geom: segsIntersect / polysOverlap / overlapGroup (the layering overlap group, ROOM-5) ----
   The predicate that scopes a shape's Back/Down/Up/Front controls to the shapes it actually covers.
   Its whole difficulty is that vertex/edge snapping makes rooms share their boundaries EXACTLY, so
   the cases worth pinning are the flush ones: a shared wall must not count as an overlap, and a
   shared boundary *line* between two rooms that do overlap must not stop counting as one. */

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

test('segsIntersect reports a proper crossing', () => {
  assert.ok(Geom.segsIntersect([0, 0], [1, 1], [0, 1], [1, 0]));
});

test('segsIntersect refuses a segment that merely ENDS on the other', () => {
  // A T-junction, which is what a room wall snapped onto a neighbour's wall looks like.
  assert.ok(!Geom.segsIntersect([0, 0], [1, 0], [0.5, 0], [0.5, 1]));
});

test('segsIntersect refuses collinear and disjoint segments', () => {
  assert.ok(!Geom.segsIntersect([0, 0], [1, 0], [0.5, 0], [1.5, 0]));   // overlapping, collinear
  assert.ok(!Geom.segsIntersect([0, 0], [1, 0], [0, 1], [1, 1]));       // parallel, apart
});

test('polysOverlap catches partial, edge-crossing overlap', () => {
  // The case `containedMap` deliberately does not handle: neither room contains the other.
  assert.ok(Geom.polysOverlap(UNIT, rect(0.5, 0.5, 1.5, 1.5)));
});

test('polysOverlap catches full containment, whichever way round it is asked', () => {
  const inner = rect(0.2, 0.2, 0.4, 0.4);
  assert.ok(Geom.polysOverlap(UNIT, inner));
  assert.ok(Geom.polysOverlap(inner, UNIT));
});

test('polysOverlap catches two rooms of equal height overlapping side by side', () => {
  // The case corners alone miss: every vertex of each room sits exactly ON the other's boundary
  // and no edge properly crosses, yet half of each room is buried under the other. Grid snapping
  // makes this alignment the norm, not a curiosity — hence the edge-midpoint probes.
  assert.ok(Geom.polysOverlap(UNIT, rect(0.5, 0, 1.5, 1)));
});

test('polysOverlap catches a room nested flush against its container’s walls', () => {
  // Same shape of problem: the lower half of the unit square, sharing three of its four walls.
  assert.ok(Geom.polysOverlap(UNIT, rect(0, 0, 1, 0.5)));
});

test('polysOverlap catches exactly coincident rooms', () => {
  // Nothing crosses and nothing is strictly interior — the all-vertices-inside-or-on fallback is
  // the only thing standing between a duplicated room and an unrestackable "Layer 1 of 1".
  assert.ok(Geom.polysOverlap(UNIT, UNIT.map(p => p.slice())));
});

test('polysOverlap does NOT count a shared wall — the case that would ruin the feature', () => {
  // Two rooms snapped flush along a common wall touch but share no area. Counting this would fold
  // every adjacent room on a snapped floor plan into one giant "overlapping" group.
  assert.ok(!Geom.polysOverlap(UNIT, rect(1, 0, 2, 1)));       // side by side
  assert.ok(!Geom.polysOverlap(UNIT, rect(0, 1, 1, 2)));       // stacked
  assert.ok(!Geom.polysOverlap(UNIT, rect(1, 0.5, 2, 1.5)));   // sharing only part of the wall
});

test('polysOverlap does not count a room merely wrapped around another', () => {
  // An L hugging two of the unit square's walls: their bounding boxes overlap heavily, every
  // contact is boundary-on-boundary, and the two still share no area.
  const wrap = [[1, 0], [2, 0], [2, 2], [0, 2], [0, 1], [1, 1]];
  assert.ok(!Geom.polysOverlap(UNIT, wrap));
});

test('polysOverlap rejects a touched corner, a disjoint room and a degenerate ring', () => {
  assert.ok(!Geom.polysOverlap(UNIT, rect(1, 1, 2, 2)));        // corner to corner
  assert.ok(!Geom.polysOverlap(UNIT, rect(2, 2, 3, 3)));        // nowhere near
  assert.ok(!Geom.polysOverlap(UNIT, [[0.2, 0.2], [0.4, 0.4]])); // fewer than three points
});

/* The chain used below: A–B overlap, B–C overlap, A–C do not. `far` touches nothing. */
const A = rect(0, 0, 0.3, 0.4), B = rect(0.2, 0.1, 0.5, 0.5), C = rect(0.4, 0.2, 0.7, 0.6);
const FAR = rect(0.8, 0.8, 0.95, 0.95);

test('overlapGroup always contains the shape itself, even when it overlaps nothing', () => {
  // "Layer 1 of 1", every button dead — the readout a non-overlapping room must show.
  assert.deepStrictEqual(Geom.overlapGroup([FAR, A], 0), [0]);
});

test('overlapGroup returns array order and skips the shapes in between', () => {
  assert.deepStrictEqual(Geom.overlapGroup([A, FAR, B], 0), [0, 2]);
});

test('overlapGroup is DIRECT, not transitive — a chain does not merge into one group', () => {
  // A overlaps B and B overlaps C, but A and C are apart. Asked about A the answer is {A, B};
  // asked about B, who really does cover both, it is all three. The group is relative to the
  // selected shape, which is exactly the question the panel asks.
  assert.deepStrictEqual(Geom.overlapGroup([A, B, C], 0), [0, 1]);
  assert.deepStrictEqual(Geom.overlapGroup([A, B, C], 1), [0, 1, 2]);
  assert.deepStrictEqual(Geom.overlapGroup([A, B, C], 2), [1, 2]);
});
