'use strict';
/* import-overview.test.js — ImportOverview's counting half: what the whole-facility view says is
   done (IMPORT-63, BUG-3).

   The panel is mostly DOM — a `<details>`, a search field, a row per building — and that half is
   out of this tier by design (README.md). What is testable here is the half that decides what the
   numbers *are*, and it is the half worth pinning down, because the panel's whole job is to be the
   one place an operator can trust about a facility they cannot see. It got that wrong in exactly
   the way a progress display must not: a building the wizard had never loaded reported no
   outstanding work — because nothing had been loaded *to* be outstanding — so an 82-building import
   opened reading "82 of 82 done" and corrected itself to "44 of 82" on the operator's first Next
   click (BUG-3). `_tally`, `_summaryText`, `stateText` and `matching` are free of DOM, so the
   distinction that fixes it is asserted directly.

   `ImportFlow`, `ImportBulk` and `ImportOcrSweep` load alongside because the panel genuinely
   delegates every count to them, and `_buildingSettled` genuinely asks the sweep where it has got
   to — stubbing either would test a fake instead of the wiring. The wizard is a bare
   `Object.create(ImportFlow.prototype)` carrying only the fields those methods read, the
   `import-flow.test.js` idiom: constructing a real wizard would drag in every collaborator and a
   browser for nothing. */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadClasses, stubWindow } = require('./load.js');

const { ImportBulk, ImportFlow, ImportOcrSweep, ImportOverview } = loadClasses(
  ['import-regions.js', 'import-bulk.js', 'import-ocr-sweep.js', 'import-overview.js',
    'import-flow.js'],
  ['ImportBulk', 'ImportFlow', 'ImportOcrSweep', 'ImportOverview']);

const REGION = { x: 0.1, y: 0.8, w: 0.3, h: 0.1 };

/** One building of `n` whole-page drawings. `nbFloors` is left **undefined** by default — that is
 *  the state every building is in when the map step first paints, since `_saveDraft` strips it and
 *  only the visible building's `_ensureFloors` fills it in. `extra` overrides it (and anything
 *  else) for the settled cases. */
function building(folder, n, extra = {}) {
  const b = { folder, name: folder, pdfs: [], assign: {}, regions: {}, ...extra };
  for (let i = 1; i <= n; i++) {
    const stem = folder + '-' + i;
    b.pdfs.push({ stem, file: stem + '.pdf', pdf: 'uploads/' + folder + '/' + stem + '.pdf' });
    // The blind positional default of `_defaultAssign` — a real `type`, which is the whole trap:
    // no count flags it, so an unvisited building reads as needing nothing.
    b.assign[stem] = { type: 'level', num: i, token: null, label: '', autoDefault: true };
    b.regions[stem] = [];
  }
  return b;
}

/** The floor Locations a loaded building carries — `[]` is just as settled an answer (an unbound
 *  building, or a site with no floor Locations, falls back to the floor-type vocabulary). */
const FLOORS = [{ slug: 'l1', name: 'Level 1' }, { slug: 'l2', name: 'Level 2' }];

/** A wizard carrying only what the panel and its counts read, on the real prototype so
 *  `_attentionCount`, `_unassignedCount`, `_buildingSettled` and friends are the shipped ones. */
function wizard(buildings, codeRegion = REGION) {
  const w = Object.create(ImportFlow.prototype);
  w.buildings = buildings;
  w._codeRegion = codeRegion;
  w.site = { folder: '', file: '' };
  w._bIdx = 0;
  w.bulk = new ImportBulk(w);
  w.ocr = new ImportOcrSweep(w);
  w.overview = Object.create(ImportOverview.prototype);
  w.overview.w = w;
  w.overview.query = '';
  w.overview.filter = 'all';
  return w;
}

// ---- _buildingSettled: whether a zero count means anything yet ----

test('a building whose floors have never been loaded is not settled', () => {
  stubWindow({ capabilities: [] });
  const w = wizard([building('admin', 2)]);
  assert.strictEqual(w._buildingSettled(w.buildings[0]), false);
});

test('loading the floors settles a building the reader has nothing to say about', () => {
  // No `ocr` capability: coverage is `off`, so the floor load is the only thing outstanding.
  stubWindow({ capabilities: [] });
  const w = wizard([building('admin', 2, { nbFloors: FLOORS })]);
  assert.strictEqual(w._buildingSettled(w.buildings[0]), true);
  // An empty list is a real answer too — the floor-type fallback, not a missing read.
  const bare = wizard([building('annex', 1, { nbFloors: [] })]);
  assert.strictEqual(bare._buildingSettled(bare.buildings[0]), true);
});

test('a building the floor-code sweep still owes reads is not settled, loaded or not', () => {
  stubWindow({ capabilities: ['ocr'] });
  const w = wizard([building('admin', 2, { nbFloors: FLOORS })]);
  const b = w.buildings[0];
  assert.strictEqual(w.ocr.coverage(b).state, 'pending');
  assert.strictEqual(w._buildingSettled(b), false);
  // ...and settles once the reads land, without anyone touching the carousel.
  const batch = w.ocr.targets(w.buildings);
  w.ocr.applyResults(batch, batch.map(t =>
    ({ folder: t.item.folder, stem: t.item.stem, text: 'LEVEL 1', confidence: 0.7 })));
  assert.strictEqual(w.ocr.coverage(b).state, 'done');
  assert.strictEqual(w._buildingSettled(b), true);
});

test('a building with no region to read through is settled once its floors are loaded', () => {
  // `no-region` means nothing more is coming for this building, which is an answer — unlike
  // `pending`, which means the answer is still on its way.
  stubWindow({ capabilities: ['ocr'] });
  const w = wizard([building('own', 1, { codeRegion: REGION, nbFloors: FLOORS }),
    building('bare', 1, { nbFloors: FLOORS })], null);
  assert.strictEqual(w.ocr.coverage(w.buildings[1]).state, 'no-region');
  assert.strictEqual(w._buildingSettled(w.buildings[1]), true);
});

// ---- the summary line: the number the operator reads before opening anything ----

test('the facility nobody has opened is not reported as finished (BUG-3)', () => {
  // The reported case, in miniature: every building unloaded and unread, every count zero.
  stubWindow({ capabilities: ['ocr'] });
  const buildings = ['admin', 'library', 'annex', 'shops'].map(f => building(f, 2));
  const w = wizard(buildings);
  const text = w.overview._summaryText(buildings);
  assert.strictEqual(w.overview._tally(buildings).done, 0);
  assert.strictEqual(w.overview._tally(buildings).unchecked, 4);
  assert.match(text, /0 of 4 done/);
  assert.match(text, /4 not checked yet/);
});

test('a settled, clear building counts as done and says nothing about being checked', () => {
  stubWindow({ capabilities: [] });
  const buildings = ['admin', 'library', 'annex', 'shops']
    .map(f => building(f, 1, { nbFloors: FLOORS }));
  const w = wizard(buildings);
  const text = w.overview._summaryText(buildings);
  assert.match(text, /4 of 4 done/);
  assert.doesNotMatch(text, /not checked yet/);
});

test('a building that already needs work is outstanding, settled or not', () => {
  // Being unsettled can only ever *withhold* a done verdict — it never reclassifies a building the
  // wizard already knows needs a floor, which would double-count it.
  stubWindow({ capabilities: [] });
  const buildings = ['admin', 'library', 'annex', 'shops'].map(f => building(f, 1));
  buildings[0].assign['admin-1'] = { type: 'unassigned', num: 1, token: null, label: '' };
  const w = wizard(buildings);
  const t = w.overview._tally(buildings);
  assert.deepStrictEqual(t, { done: 0, unchecked: 3, total: 4 });
  assert.match(w.overview._summaryText(buildings), /1 drawing needs a floor/);
});

// ---- the row phrase, and finding the rows it belongs to ----

test('an unchecked building’s row says so rather than “✓ done”', () => {
  stubWindow({ capabilities: [] });
  const w = wizard([building('admin', 1)]);
  assert.strictEqual(w.overview.stateText(w.buildings[0]), 'not checked yet');
  w.buildings[0].nbFloors = FLOORS;
  assert.strictEqual(w.overview.stateText(w.buildings[0]), '✓ done');
});

test('a sweep still owing reads keeps its own wording, not the generic one', () => {
  // `COVERAGE_TEXT` is more specific than "not checked yet" wherever it applies, so it wins.
  stubWindow({ capabilities: ['ocr'] });
  const w = wizard([building('admin', 1, { nbFloors: FLOORS })]);
  assert.strictEqual(w.overview.stateText(w.buildings[0]), 'floor codes not read yet');
});

test('the “not checked yet” filter selects exactly the buildings “done” withholds', () => {
  stubWindow({ capabilities: [] });
  const loaded = building('admin', 1, { nbFloors: FLOORS });
  const fresh = building('library', 1);
  const w = wizard([loaded, fresh]);
  w.overview.filter = 'unchecked';
  assert.deepStrictEqual(w.overview.matching(w.buildings), [fresh]);
  w.overview.filter = 'done';
  assert.deepStrictEqual(w.overview.matching(w.buildings), [loaded]);
});
