'use strict';
/* import-regions.test.js — ImportRegions' page-geometry adapter (IMPORT-51).

   ImportRegions is mostly box-dragging surfaces, which belong in a browser and stay out of this
   tier. Its statics are the exception: `pageGeom`/`shapeDiffers`/`adapt` are pure geometry, and
   they decide where every floor card's close-up crop and every OCR read actually lands.

   What matters here is the *shape* of the decision, not just its arithmetic. The adapter must be a
   strict no-op for everything it cannot reason about — a region marked before this feature existed,
   a raster with no page size, two sheets measured in different units — and, crucially, for the
   overwhelmingly common uniform sheet set, where plain fractions are already exactly right and
   "correcting" them would be the regression. Only a genuinely differently-*shaped* sheet gets
   re-anchored. Each case below pins one of those. */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadClasses } = require('./load.js');

const { ImportRegions } = loadClasses(['import-regions.js'], ['ImportRegions']);

/** A landscape D-size sheet, in points — the sample most facility floor plans arrive as. */
const LANDSCAPE = { w: 2448, h: 1584, unit: 'pt' };
/** A portrait letter sheet, in points — the odd index/detail sheet mixed into the same set. */
const PORTRAIT = { w: 612, h: 792, unit: 'pt' };

/** A marked region over the bottom-right title block of `on` (default LANDSCAPE). */
function marked(box, on = LANDSCAPE) {
  return Object.assign({ x: 0.75, y: 0.86, w: 0.22, h: 0.09, pageSize: on }, box);
}

/** Round a box's four numbers, so an assertion reads as a position rather than float noise. */
function round(b, places = 4) {
  const f = (n) => Number(n.toFixed(places));
  return { x: f(b.x), y: f(b.y), w: f(b.w), h: f(b.h) };
}

// ---- pageGeom: what the scan inventory says a sheet is ----

test('pageGeom reads a single-page drawing’s own size', () => {
  assert.deepStrictEqual(
    ImportRegions.pageGeom({ sizes: [[2448, 1584]], unit: 'pt' }),
    { w: 2448, h: 1584, unit: 'pt' });
});

test('pageGeom indexes an exploded page row by its own 1-based page', () => {
  const p = { sizes: [[120, 160], [200, 160], [120, 300]], unit: 'pt', page: 3 };
  assert.deepStrictEqual(ImportRegions.pageGeom(p), { w: 120, h: 300, unit: 'pt' });
});

test('pageGeom is null for a format with no page size', () => {
  // A raster reports `sizes: null` — its pixels are a scan resolution, not a sheet size.
  assert.strictEqual(ImportRegions.pageGeom({ sizes: null, unit: '' }), null);
  assert.strictEqual(ImportRegions.pageGeom({ sizes: [[100, 0]], unit: 'pt' }), null);
  assert.strictEqual(ImportRegions.pageGeom({ sizes: [[100, 50]], unit: '' }), null);
  assert.strictEqual(ImportRegions.pageGeom(undefined), null);
});

// ---- the no-op paths: everything the adapter cannot or must not reason about ----

test('a region marked before page geometry existed is passed through untouched', () => {
  const legacy = { x: 0.75, y: 0.86, w: 0.22, h: 0.09 };
  assert.deepStrictEqual(ImportRegions.adapt(legacy, PORTRAIT), legacy);
});

test('an unmeasurable target sheet keeps plain fractions', () => {
  const r = marked();
  assert.deepStrictEqual(ImportRegions.adapt(r, null), { x: 0.75, y: 0.86, w: 0.22, h: 0.09 });
});

test('sheets measured in different units are never compared', () => {
  // Points against anything else is not a comparison — falling back is the honest answer.
  const r = marked({}, { w: 2448, h: 1584, unit: 'pt' });
  assert.deepStrictEqual(ImportRegions.adapt(r, { w: 612, h: 792, unit: 'px' }),
    { x: 0.75, y: 0.86, w: 0.22, h: 0.09 });
});

test('a same-shaped sheet at another print scale keeps plain fractions', () => {
  // A half-size print scales its title block down with the sheet, so fractions are already exact
  // and preserving the box's physical size would be the bug.
  const r = marked();
  const half = { w: 1224, h: 792, unit: 'pt' };
  assert.deepStrictEqual(ImportRegions.adapt(r, half), { x: 0.75, y: 0.86, w: 0.22, h: 0.09 });
});

test('adapt always returns a fresh plain box, never the stored region', () => {
  const r = marked();
  const out = ImportRegions.adapt(r, LANDSCAPE);
  assert.notStrictEqual(out, r);
  assert.deepStrictEqual(Object.keys(out).sort(), ['h', 'w', 'x', 'y']);
  assert.strictEqual(out.pageSize, undefined);   // must not reach the OCR endpoint
});

test('adapt tolerates a null region', () => {
  assert.strictEqual(ImportRegions.adapt(null, PORTRAIT), null);
});

// ---- the re-anchor: a differently-shaped sheet ----

test('a bottom-right title block stays bottom-right at its physical size', () => {
  const out = round(ImportRegions.adapt(marked(), PORTRAIT));
  // The box is 0.22*2448 = 538.6pt wide, 0.09*1584 = 142.6pt tall, sitting 73.4pt from the right
  // edge and 79.2pt from the bottom. On a 612x792 sheet that is 0.88 x 0.18, still in the corner —
  // then widened by 10% per side and clipped to the page.
  assert.ok(out.w > 0.8 && out.w <= 1, 'keeps its physical width: ' + out.w);
  assert.ok(out.h > 0.15 && out.h < 0.3, 'keeps its physical height: ' + out.h);
  assert.ok(out.x + out.w > 0.95, 'still against the right edge');
  assert.ok(out.y + out.h > 0.85, 'still against the bottom edge');
});

test('a top-left block is re-anchored to the top-left, not stretched', () => {
  const out = round(ImportRegions.adapt(marked({ x: 0.02, y: 0.03, w: 0.2, h: 0.06 }), PORTRAIT));
  assert.ok(out.x < 0.09, 'still against the left edge: ' + out.x);
  assert.ok(out.y < 0.06, 'still against the top edge: ' + out.y);
});

test('a centred strip stays centred rather than being pulled to a corner', () => {
  // Bottom-centre caption: its horizontal midpoint is 0.5, so neither vertical edge is "nearest"
  // and the box must keep its centre instead of picking one arbitrarily.
  const out = ImportRegions.adapt(marked({ x: 0.35, y: 0.9, w: 0.3, h: 0.05 }), PORTRAIT);
  assert.ok(Math.abs((out.x + out.w / 2) - 0.5) < 1e-9, 'horizontal centre preserved');
  assert.ok(out.y + out.h > 0.9, 'still against the bottom edge');
});

test('a box wider than the target sheet collapses onto the axis, never overflows it', () => {
  // Physically 2203pt wide on a 612pt-wide page: it cannot fit, so it takes the whole width and
  // stays a valid 0..1 box (the OCR endpoint rejects anything outside that).
  const out = ImportRegions.adapt(marked({ x: 0.05, y: 0.9, w: 0.9, h: 0.05 }), PORTRAIT);
  assert.strictEqual(out.x, 0);
  assert.strictEqual(out.w, 1);
  assert.ok(out.y >= 0 && out.y + out.h <= 1);
});

test('a re-anchored box is widened by the adapt margin', () => {
  // Same shape change, small central box: the only difference from the raw re-anchor is the
  // deliberate margin, so it is measurable here.
  const r = marked({ x: 0.4, y: 0.45, w: 0.1, h: 0.06 });
  const out = ImportRegions.adapt(r, PORTRAIT);
  const bare = { w: 0.1 * LANDSCAPE.w / PORTRAIT.w, h: 0.06 * LANDSCAPE.h / PORTRAIT.h };
  assert.ok(Math.abs(out.w - bare.w * 1.2) < 1e-9, 'widened 10% per side: ' + out.w);
  assert.ok(Math.abs(out.h - bare.h * 1.2) < 1e-9, 'heightened 10% per side: ' + out.h);
});

test('every adapted box stays inside 0..1', () => {
  const sheets = [PORTRAIT, { w: 3168, h: 2448, unit: 'pt' }, { w: 300, h: 2000, unit: 'pt' }];
  const boxes = [[0, 0, 0.3, 0.1], [0.7, 0.9, 0.29, 0.09], [0.45, 0.02, 0.1, 0.05],
    [0.98, 0.98, 0.02, 0.02]];
  for (const s of sheets) {
    for (const [x, y, w, h] of boxes) {
      const out = ImportRegions.adapt(marked({ x, y, w, h }), s);
      assert.ok(out.x >= 0 && out.y >= 0 && out.w > 0 && out.h > 0
        && out.x + out.w <= 1 + 1e-9 && out.y + out.h <= 1 + 1e-9,
      `${JSON.stringify(out)} out of range for ${JSON.stringify(s)}`);
    }
  }
});

// ---- the operator-facing signal ----

test('shapeDiffers is false whenever the two sheets cannot be compared', () => {
  assert.strictEqual(ImportRegions.shapeDiffers(LANDSCAPE, null), false);
  assert.strictEqual(ImportRegions.shapeDiffers(null, PORTRAIT), false);
  assert.strictEqual(ImportRegions.shapeDiffers(LANDSCAPE, { w: 612, h: 792, unit: 'px' }), false);
  assert.strictEqual(ImportRegions.shapeDiffers({ w: 0, h: 0, unit: 'pt' }, PORTRAIT), false);
});

test('shapeDiffers ignores rounding but catches a real template change', () => {
  assert.strictEqual(ImportRegions.shapeDiffers(LANDSCAPE, { w: 2448.4, h: 1584, unit: 'pt' }),
    false);
  assert.strictEqual(ImportRegions.shapeDiffers(LANDSCAPE, PORTRAIT), true);
});

test('geomOutliers counts only the drawings shaped unlike the sample', () => {
  const row = (g) => ({ sizes: [[g.w, g.h]], unit: g.unit });
  const sample = row(LANDSCAPE);
  const rows = [sample, row(LANDSCAPE), row(PORTRAIT), row(PORTRAIT),
    { sizes: null, unit: '' }];   // a raster says nothing either way
  assert.strictEqual(ImportRegions.geomOutliers(sample, rows), 2);
  assert.strictEqual(ImportRegions.geomOutliers({ sizes: null, unit: '' }, rows), 0);
});

// ---- the shared adaptation corpus, also run by tests/test_ocr.py (IMPORT-63) --------------------
//
// The JS half asserts the geometry; the Python half renders a sheet of each case's target shape,
// draws the caption where the block physically lands (`anchored`), and asserts that OCR handed
// `adapted` still reads it. Neither half alone covers the path a mixed-template facility takes.

const ADAPT_CASES = require('./fixtures/region-adapt-cases.json').cases;

for (const c of ADAPT_CASES) {
  test('adapt corpus — ' + c.name, () => {
    const out = ImportRegions.adapt(c.region, c.target);
    for (const k of ['x', 'y', 'w', 'h'])
      assert.ok(Math.abs(out[k] - c.adapted[k]) < 1e-9,
        `${k}: ${out[k]} != ${c.adapted[k]} — ${c.why}`);
    // The stored `pageSize` is the box's own history; what goes to the endpoint must be a plain
    // box, or the region validator sees a key it doesn't know.
    assert.deepStrictEqual(Object.keys(out).sort(), ['h', 'w', 'x', 'y']);
  });
}

test('adapt corpus — the widened cases really are wider than the re-anchored box', () => {
  // The Python half draws inside `anchored` and reads with `adapted`, so a corpus where the two
  // were equal would quietly stop testing the margin at all.
  for (const c of ADAPT_CASES) {
    const grew = c.adapted.w > c.anchored.w + 1e-9 || c.adapted.h > c.anchored.h + 1e-9;
    assert.strictEqual(grew, c.widened, c.name);
  }
});

// ---- the drag gesture's arithmetic, without a pointer ----

test('a box is built the same whichever way the drag ran', () => {
  const want = { x: 0.2, y: 0.3, w: 0.4, h: 0.2 };
  const same = (got, label) => {
    for (const k of ['x', 'y', 'w', 'h'])
      assert.ok(Math.abs(got[k] - want[k]) < 1e-9, `${label} ${k}: ${got[k]}`);
  };
  same(ImportRegions.boxFrom(0.2, 0.3, 0.6, 0.5), 'top-left first');
  same(ImportRegions.boxFrom(0.6, 0.5, 0.2, 0.3), 'bottom-right first');
  same(ImportRegions.boxFrom(0.6, 0.3, 0.2, 0.5), 'top-right first');
  same(ImportRegions.boxFrom(0.2, 0.5, 0.6, 0.3), 'bottom-left first');
});

test('a stray click marks nothing', () => {
  // Without the floor, a click that travelled a pixel would replace a good region with a sliver —
  // and the sliver would then be what OCR reads, facility-wide.
  assert.strictEqual(ImportRegions.isUsableBox({ x: 0.5, y: 0.5, w: 0, h: 0 }), false);
  assert.strictEqual(ImportRegions.isUsableBox({ x: 0.5, y: 0.5, w: 0.004, h: 0.5 }), false);
  assert.strictEqual(ImportRegions.isUsableBox({ x: 0.5, y: 0.5, w: 0.5, h: 0.004 }), false);
  assert.strictEqual(ImportRegions.isUsableBox({ x: 0.5, y: 0.5, w: 0.006, h: 0.006 }), true);
  assert.strictEqual(ImportRegions.isUsableBox(null), false);
});

// ---- the pick's commit semantics: the reported "Cancel is a lie" bug ----

test('a pick holds the dragged box rather than writing it, so Cancel can mean it', () => {
  const original = { x: 0.7, y: 0.9, w: 0.2, h: 0.05 };
  const s = ImportRegions.pickState(original);
  assert.strictEqual(s.dirty(), false);
  assert.strictEqual(s.result(), original);
  s.set({ x: 0.1, y: 0.1, w: 0.3, h: 0.1 });
  assert.strictEqual(s.dirty(), true);
  assert.deepStrictEqual(s.result(), { x: 0.1, y: 0.1, w: 0.3, h: 0.1 });
  // Nothing here reaches the model: the caller writes `result()` only when the operator confirms,
  // and abandoning the state IS the cancel. Before this, the drag mutated `building.codeRegion`
  // on pointer-up and the screen's own Cancel button only skipped the draft save.
  assert.strictEqual(original.x, 0.7);
});

test('confirming an untouched pick keeps the region exactly as it was stored', () => {
  // Including its `pageSize`: the geometry a box was measured against is the whole basis of its
  // adaptation, and re-stamping it from whatever sample the screen happened to open on would
  // silently re-base a region nobody re-drew.
  const original = { x: 0.7, y: 0.9, w: 0.2, h: 0.05, pageSize: { w: 2448, h: 1584, unit: 'pt' } };
  const s = ImportRegions.pickState(original);
  assert.strictEqual(s.result(), original);
});

test('a pick opened with no region yet has nothing to confirm', () => {
  const s = ImportRegions.pickState(null);
  assert.strictEqual(s.result(), null);
  s.set({ x: 0, y: 0, w: 0.2, h: 0.2 });
  assert.deepStrictEqual(s.result(), { x: 0, y: 0, w: 0.2, h: 0.2 });
});

test('a new box records the sheet it was measured on; an unmeasurable one records nothing', () => {
  const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.1 };
  const geom = { w: 2448, h: 1584, unit: 'pt' };
  assert.deepStrictEqual(ImportRegions.stamp(box, geom), { ...box, pageSize: geom });
  // A raster's pixels are a scan resolution, not a sheet size, so `pageGeom` reports null and the
  // box takes the pre-IMPORT-51 plain-fractions path — the same one an old draft takes.
  assert.strictEqual(ImportRegions.stamp(box, null), box);
  assert.strictEqual(ImportRegions.stamp(null, geom), null);
});
