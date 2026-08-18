'use strict';
/* import-region-editor.test.js — ImportRegionEditor's draft-model normalization (FLOOR-6).

   The editor itself is a browser class (an Editor subclass — SVG, pointers, PanZoom) and stays
   out of this tier. Its statics are the exception: they are the seam between the wizard draft's
   region records and the editor's polygon shapes, and they carry the two contracts worth pinning
   without a browser —

   - **Old drafts keep working.** A pre-FLOOR-6 region is `{box, assign}` only; `materialize`
     must give it a polygon (the box's own corners) and an id without changing what it crops.
   - **`box` never disagrees with `poly`.** The build's crop contract is the rectangle
     (`_resolveFloors` emits `region: box`), so whatever the polygon says, `box` must be exactly
     its bounding box — including after a corrupt hand-edited draft is repaired. */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadClasses } = require('./load.js');

const { ImportRegionEditor } = loadClasses(
  ['lib.js', 'editor.js', 'import-region-editor.js'], ['ImportRegionEditor']);

// ---- validPoly: what counts as a usable polygon off user-writable draft JSON ----

test('validPoly accepts a normalized triangle', () => {
  assert.strictEqual(ImportRegionEditor.validPoly([[0, 0], [1, 0], [0.5, 1]]), true);
});

test('validPoly rejects everything that is not ≥3 in-range [x,y] pairs', () => {
  assert.strictEqual(ImportRegionEditor.validPoly(null), false);
  assert.strictEqual(ImportRegionEditor.validPoly([]), false);
  assert.strictEqual(ImportRegionEditor.validPoly([[0, 0], [1, 1]]), false);          // too short
  assert.strictEqual(ImportRegionEditor.validPoly([[0, 0], [1, 0], [0.5]]), false);   // not a pair
  assert.strictEqual(ImportRegionEditor.validPoly([[0, 0], [1, 0], [0.5, 1.2]]), false);   // out of range
  assert.strictEqual(ImportRegionEditor.validPoly([[0, 0], [1, 0], [0.5, NaN]]), false);
  assert.strictEqual(ImportRegionEditor.validPoly([[0, 0], [1, 0], ['0.5', 1]]), false);   // stringly JSON
});

// ---- polyFromBox / boxFromPoly: the box ⇄ polygon seam ----

test('polyFromBox is the box’s four corners, clockwise from the top-left', () => {
  assert.deepStrictEqual(
    ImportRegionEditor.polyFromBox({ x: 0.1, y: 0.2, w: 0.5, h: 0.25 }),
    [[0.1, 0.2], [0.6, 0.2], [0.6, 0.45], [0.1, 0.45]]);
});

test('polyFromBox clamps a box that leaks outside the page', () => {
  assert.deepStrictEqual(
    ImportRegionEditor.polyFromBox({ x: 0.8, y: -0.1, w: 0.5, h: 0.4 }),
    [[0.8, 0], [1, 0], [1, 0.3], [0.8, 0.3]]);
});

test('boxFromPoly is the polygon’s bounding box', () => {
  assert.deepStrictEqual(
    ImportRegionEditor.boxFromPoly([[0.2, 0.5], [0.7, 0.1], [0.4, 0.9]]),
    { x: 0.2, y: 0.1, w: 0.5, h: 0.8 });
});

test('a box round-trips through its polygon unchanged', () => {
  const box = { x: 0.25, y: 0.3, w: 0.4, h: 0.2 };
  assert.deepStrictEqual(
    ImportRegionEditor.boxFromPoly(ImportRegionEditor.polyFromBox(box)), box);
});

// ---- materialize: bringing a draft's regions up to the editor's shape, in place ----

test('materialize backfills a pre-FLOOR-6 box-only region without changing its crop', () => {
  const r = { box: { x: 0.1, y: 0.1, w: 0.3, h: 0.4 },
    assign: { type: 'unassigned', num: 1, token: null, label: '' } };
  const out = ImportRegionEditor.materialize([r]);
  assert.strictEqual(out[0], r);                       // in place — the draft model stays the truth
  assert.ok(r.id);                                     // gained a stable identity
  assert.deepStrictEqual(r.poly,
    [[0.1, 0.1], [0.4, 0.1], [0.4, 0.5], [0.1, 0.5]]); // the box's own corners
  assert.deepStrictEqual(r.box, { x: 0.1, y: 0.1, w: 0.3, h: 0.4 });   // crop unchanged
});

test('materialize keeps a stored polygon and re-derives box from it (poly wins over a stale box)', () => {
  const poly = [[0.2, 0.2], [0.8, 0.2], [0.5, 0.7]];
  const r = { id: 'r1', poly, box: { x: 0, y: 0, w: 1, h: 1 }, assign: {} };
  ImportRegionEditor.materialize([r]);
  assert.strictEqual(r.id, 'r1');                      // an existing id is never reissued
  assert.deepStrictEqual(r.poly, poly);
  assert.deepStrictEqual(r.box, { x: 0.2, y: 0.2, w: 0.6, h: 0.5 });
});

test('materialize rebuilds a corrupt polygon from the box', () => {
  const r = { poly: [[0.2, 0.2], [3, 'x']], box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, assign: {} };
  ImportRegionEditor.materialize([r]);
  assert.deepStrictEqual(r.poly,
    [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3], [0.1, 0.3]]);
  assert.deepStrictEqual(r.box, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
});
