'use strict';
/* import-ocr-sweep.test.js — ImportOcrSweep's model half: which drawings a sweep reads, and what
   it does with what comes back (IMPORT-53).

   The class is half wizard — the batch loop fetches, toasts and repaints, and the status strip is
   DOM — and that half belongs in a browser, out of this tier by design (README.md). What is
   testable here is exactly the half that decides *correctness of the model*, and it is the half
   worth pinning down, because a background pass gets three chances to quietly corrupt an import:
   by reading a drawing it shouldn't, by reading one twice forever, or by overwriting an answer the
   operator gave while a batch was in flight. `targets` and `applyResults` are deliberately free of
   DOM and persistence so those three can be asserted directly.

   `ImportBulk`, `ImportRegions` and `ImportFlow` load alongside because the sweep genuinely
   delegates to them (eligibility, region adaptation, the whole suggestion engine, and the
   "is this anybody's answer yet" predicate) — stubbing any of them would test a fake instead of
   the wiring. */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadClasses, stubWindow } = require('./load.js');

const { ImportBulk, ImportFlow, ImportOcrSweep } = loadClasses(
  ['import-regions.js', 'import-bulk.js', 'import-ocr-sweep.js', 'import-flow.js'],
  ['ImportBulk', 'ImportFlow', 'ImportOcrSweep']);

const REGION = { x: 0.1, y: 0.8, w: 0.3, h: 0.1 };

/** One building of `n` whole-page drawings, all `unassigned`, with two floor Locations to resolve
 *  against. `folder` doubles as the stem prefix, so keys are unique across buildings. */
function building(folder, n, extra = {}) {
  const b = {
    folder, name: folder, pdfs: [], assign: {}, regions: {},
    nbFloors: [{ slug: folder + '-l1', name: 'Level 1' }, { slug: folder + '-l2', name: 'Level 2' }],
    ...extra,
  };
  for (let i = 1; i <= n; i++) {
    const stem = folder + '-' + i;
    b.pdfs.push({ stem, file: stem + '.pdf', pdf: 'uploads/' + folder + '/' + stem + '.pdf' });
    b.assign[stem] = { type: 'unassigned', num: 1, token: null, label: '' };
    b.regions[stem] = [];
  }
  return b;
}

/** A wizard carrying only what the sweep and `ImportBulk` actually read. */
function wizard(buildings, codeRegion = REGION) {
  const w = {
    buildings,
    _codeRegion: codeRegion,
    site: { folder: '', file: '' },
    _mappableBuildings: () => buildings,
    _isSiteplanPick: (b, p) => w.site.folder === b.folder && w.site.file === p.file,
    _loadFloors: async () => {},
    _saveDraft: async () => {},
  };
  w.bulk = new ImportBulk(w);
  w.ocr = new ImportOcrSweep(w);
  return w;
}

/** The server's answer for `batch`, one result per target. The default confidence is deliberately
 *  between `LOW_OCR_CONF` and `AUTO_ACCEPT_OCR_CONF` — a read clear enough not to be flagged as
 *  faint, and not clear enough to be taken outright — so a test that says nothing about confidence
 *  exercises the ordinary suggestion path (IMPORT-63). */
function results(batch, text, confidence = 0.7) {
  return batch.map(t => ({ folder: t.item.folder, stem: t.item.stem, text, confidence }));
}

// ---- chunk: the whole reason the operator isn't blocked ----

test('chunk splits in order and keeps the short tail', () => {
  assert.deepStrictEqual(ImportOcrSweep.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepStrictEqual(ImportOcrSweep.chunk([], 3), []);
  assert.deepStrictEqual(ImportOcrSweep.chunk([1, 2], 5), [[1, 2]]);
});

test('the batch size stays under the server’s per-request drawing cap', () => {
  // `OcrReadView` rejects a batch larger than `max_pdfs` (400 by default). A chunk size that
  // crept past it would fail every batch of a large sweep with a 400, not a partial read.
  assert.ok(ImportOcrSweep.CHUNK > 0 && ImportOcrSweep.CHUNK < 400);
});

// ---- targets: what a sweep will and will not read ----

test('a sweep reads every unassigned drawing across the buildings it is given', () => {
  const w = wizard([building('admin', 2), building('lib', 1)]);
  const got = w.ocr.targets(w.buildings).map(t => t.item.stem);
  assert.deepStrictEqual(got, ['admin-1', 'admin-2', 'lib-1']);
});

test('an answered drawing is never read — only unanswered ones are', () => {
  // An operator's own floor, and a deliberate `(none)`, are decisions; a background pass that
  // re-read them would be proposing to overwrite them.
  const b = building('admin', 3);
  b.assign['admin-2'] = { type: 'level', num: 1, token: 'admin-l1', label: 'Level 1' };
  b.assign['admin-3'] = { type: 'none', num: 1, token: null, label: '' };
  const w = wizard([b]);
  assert.deepStrictEqual(w.ocr.targets(w.buildings).map(t => t.item.stem), ['admin-1']);
});

test('an unconfirmed pre-fill IS read — the sweep is not Location-mode-only (IMPORT-63)', () => {
  // The bug this fixes: `_defaultAssign` leaves no drawing `unassigned` in floor-type fallback
  // mode — each gets a filename guess or a blind positional Level N — so a sweep that only read
  // `unassigned` read *nothing at all* across a whole facility, silently.
  const b = building('admin', 3);
  b.assign['admin-1'] = { type: 'level', num: 3, token: null, label: '', suggested: true };
  b.assign['admin-2'] = { type: 'level', num: 2, token: null, label: '', autoDefault: true };
  b.assign['admin-3'] = { type: 'level', num: 1, token: 'admin-l1', label: 'Level 1' };
  const w = wizard([b]);
  assert.deepStrictEqual(w.ocr.targets(w.buildings).map(t => t.item.stem),
    ['admin-1', 'admin-2']);          // ...and never the one the operator answered
});

test('the widened target set still shrinks to nothing, so the sweep terminates', () => {
  // `autoStart` re-runs on every map-step render. Widening what counts as readable must not touch
  // the clause that actually bounds the pass: a drawing carrying an `ocrText` is never a target
  // again, whatever state its assignment is in.
  const b = building('admin', 2);
  b.assign['admin-1'] = { type: 'level', num: 1, token: null, label: '', suggested: true };
  b.assign['admin-2'] = { type: 'level', num: 2, token: null, label: '', autoDefault: true };
  const w = wizard([b]);
  const batch = w.ocr.targets(w.buildings);
  assert.strictEqual(batch.length, 2);
  w.ocr.applyResults(batch, results(batch, 'MEZZANINE'));   // legible, names no floor here
  assert.deepStrictEqual(w.ocr.targets(w.buildings), []);
});

test('a drawing already read is never read again, so the sweep terminates', () => {
  // This is what makes a facility-wide sweep idempotent: `autoStart` re-runs on every map-step
  // render, and without this each render would re-read the whole facility.
  const b = building('admin', 2);
  b.assign['admin-1'].ocrText = '';       // read, and the region held nothing
  b.assign['admin-2'].ocrText = 'L2';     // read, but named no floor this building has
  const w = wizard([b]);
  assert.deepStrictEqual(w.ocr.targets(w.buildings), []);
});

test('the site plan and a region-split drawing are skipped, as for any bulk action', () => {
  const b = building('admin', 3);
  b.regions['admin-2'] = [{ box: REGION, assign: { type: 'unassigned' } }];
  const w = wizard([b]);
  w.site = { folder: 'admin', file: 'admin-3.pdf' };
  assert.deepStrictEqual(w.ocr.targets(w.buildings).map(t => t.item.stem), ['admin-1']);
});

test('a building with no region at all is skipped rather than read against nothing', () => {
  const withOwn = building('own', 1, { codeRegion: { x: 0, y: 0, w: 0.5, h: 0.5 } });
  const w = wizard([building('plain', 1), withOwn], null);   // no global region
  assert.deepStrictEqual(w.ocr.targets(w.buildings).map(t => t.item.stem), ['own-1']);
});

test('each target carries its own building’s region', () => {
  const own = { x: 0.5, y: 0.5, w: 0.2, h: 0.2 };
  const w = wizard([building('plain', 1), building('own', 1, { codeRegion: own })]);
  const [a, b] = w.ocr.targets(w.buildings);
  assert.deepStrictEqual(a.item.region, REGION);
  assert.deepStrictEqual(b.item.region, own);
});

test('a drawing whose batch failed is not queued again', () => {
  // Otherwise a drawing the server can't answer for is re-queued by every pass, and the sweep
  // never drains.
  const w = wizard([building('admin', 2)]);
  const batch = w.ocr.targets(w.buildings);
  w.ocr._giveUp([batch[0]]);
  assert.deepStrictEqual(w.ocr.targets(w.buildings).map(t => t.item.stem), ['admin-2']);
});

// ---- applyResults: the raw read is kept, the suggestion is offered only into a blank ----

test('a resolved read lands as a suggestion unless it clears the auto-accept bar', () => {
  const w = wizard([building('admin', 1)]);
  const batch = w.ocr.targets(w.buildings);
  const out = w.ocr.applyResults(batch, results(batch, 'LEVEL 2'));
  const a = w.buildings[0].assign['admin-1'];
  assert.strictEqual(out.filled, 1);
  assert.strictEqual(a.token, 'admin-l2');
  assert.strictEqual(a.suggested, true);
  assert.strictEqual(a.suggestedFrom, 'ocr');
});

test('the raw read is recorded on every drawing that came back, resolvable or not', () => {
  // A read that named no floor is the diagnosable case: the card can say what the region held,
  // which is what distinguishes a faint read from a confident misread.
  const w = wizard([building('admin', 2)]);
  const batch = w.ocr.targets(w.buildings);
  w.ocr.applyResults(batch, [
    { folder: 'admin', stem: 'admin-1', text: 'MEZZANINE', confidence: 0.44 },
    { folder: 'admin', stem: 'admin-2', text: '', confidence: 0 },
  ]);
  const assign = w.buildings[0].assign;
  assert.strictEqual(assign['admin-1'].ocrText, 'MEZZANINE');
  assert.strictEqual(assign['admin-1'].ocrConf, 0.44);
  assert.strictEqual(assign['admin-1'].type, 'unassigned');   // legible, but names no floor here
  assert.strictEqual(assign['admin-2'].ocrText, '');
  assert.strictEqual(assign['admin-2'].type, 'unassigned');
});

test('a floor the operator picked while the batch was in flight is never overwritten', () => {
  // The anti-clobber rule: the assignment is re-checked at APPLY time, not at queue time. Without
  // it, a sweep issued before the operator answered would land on top of their answer.
  const w = wizard([building('admin', 1)]);
  const batch = w.ocr.targets(w.buildings);
  const a = w.buildings[0].assign['admin-1'];
  Object.assign(a, { type: 'level', num: 2, token: 'admin-l2', label: 'Level 2', suggested: false });
  const out = w.ocr.applyResults(batch, results(batch, 'LEVEL 1'));
  assert.strictEqual(out.filled, 0);
  assert.strictEqual(a.token, 'admin-l2');      // their answer stands
  assert.strictEqual(a.suggested, false);
  assert.strictEqual(a.ocrText, 'LEVEL 1');     // ...and the read is still on record
});

test('a result for a drawing the batch never asked about is ignored', () => {
  const w = wizard([building('admin', 1)]);
  const batch = w.ocr.targets(w.buildings);
  const out = w.ocr.applyResults(batch,
    [{ folder: 'lib', stem: 'lib-1', text: 'LEVEL 1', confidence: 0.9 }]);
  assert.strictEqual(out.read, 0);
  assert.strictEqual(w.buildings[0].assign['admin-1'].ocrText, undefined);
});

test('reads resolve a building at a time, so two buildings’ sheets never cross', () => {
  // A stem is unique only within its building, and `_suggestFrom`'s alignment rung matches a
  // building's reads AS A SET — bucketing wrong would both mis-key results and mis-align them.
  const w = wizard([building('admin', 1), building('lib', 1)]);
  const batch = w.ocr.targets(w.buildings);
  const out = w.ocr.applyResults(batch, [
    { folder: 'admin', stem: 'admin-1', text: 'LEVEL 1', confidence: 0.9 },
    { folder: 'lib', stem: 'lib-1', text: 'LEVEL 2', confidence: 0.9 },
  ]);
  assert.strictEqual(out.filled, 2);
  assert.strictEqual(w.buildings[0].assign['admin-1'].token, 'admin-l1');
  assert.strictEqual(w.buildings[1].assign['lib-1'].token, 'lib-l2');
  assert.strictEqual(out.touched.size, 2);
});

// ---- candidate lines: which row of the marked region actually named the floor ----
//
// The reader returns the region's text lines separately instead of joined, because a box drawn
// around a floor code catches a neighbouring row of the title block too. Everything above still
// exercises the single-`text` fallback (`results()` sends no `lines`), which is why those tests
// are unchanged; these cover the walk.

/** One result carrying explicit candidate lines. `y` is each line's normalized centre in the crop. */
function lines(batch, cands, text = '', confidence = 0) {
  return batch.map(t => ({ folder: t.item.folder, stem: t.item.stem, text, confidence,
    lines: cands }));
}

test('the line that names a floor wins over a more confident line that does not', () => {
  // The reported bug's shape: `Floor 3` above `Development   MAY 2025`. The date line reads more
  // cleanly — it is longer and better spaced — and the server, which knows nothing about floors,
  // reports it as its own best candidate. Only the client can tell which one is a floor code.
  const w = wizard([building('admin', 1)]);
  const batch = w.ocr.targets(w.buildings);
  const out = w.ocr.applyResults(batch, lines(batch, [
    { text: 'Level 2', confidence: 0.75, y: 0.25 },
    { text: 'Development   MAY 2025', confidence: 0.94, y: 0.75 },
  ], 'Development   MAY 2025', 0.94));
  const a = w.buildings[0].assign['admin-1'];
  assert.strictEqual(out.filled, 1);
  assert.strictEqual(a.token, 'admin-l2');
  assert.strictEqual(a.ocrText, 'Level 2');      // the chip records what drove the suggestion…
  assert.strictEqual(a.ocrConf, 0.75);           // …and its own confidence, not the crop's
});

test('a garbage line beside a good one never becomes the suggestion', () => {
  // Before per-line candidates the two were fused into one string (`Floor DEEODETAAYOOOE`), which
  // parsed to nothing and left the drawing blank at a confidence that meant nothing either.
  const w = wizard([building('admin', 1)]);
  const batch = w.ocr.targets(w.buildings);
  const out = w.ocr.applyResults(batch, lines(batch, [
    { text: 'DEEODETAAYOOOE', confidence: 0.31, y: 0.7 },
    { text: 'LEVEL 1', confidence: 0.88, y: 0.3 },
  ]));
  const a = w.buildings[0].assign['admin-1'];
  assert.strictEqual(out.filled, 1);
  assert.strictEqual(a.token, 'admin-l1');
  assert.strictEqual(a.ocrText, 'LEVEL 1');
});

test('two parsing lines of equal confidence resolve toward the centre of the box', () => {
  // The operator drew the box around the code they wanted; when recognition can't separate the
  // candidates, where they aimed is the better signal than which line the reader listed first.
  const w = wizard([building('admin', 1)]);
  const batch = w.ocr.targets(w.buildings);
  w.ocr.applyResults(batch, lines(batch, [
    { text: 'LEVEL 1', confidence: 0.9, y: 0.05 },
    { text: 'LEVEL 2', confidence: 0.88, y: 0.5 },
  ]));
  assert.strictEqual(w.buildings[0].assign['admin-1'].ocrText, 'LEVEL 2');
});

test('auto-accept fires on the WINNING line’s confidence, not the crop’s average', () => {
  // This is the point of aggregating per line: averaged with the junk line, a clear `LEVEL 2`
  // lands at 0.57 and is offered as something to confirm. On its own it is 0.95 and is taken.
  const w = wizard([building('admin', 1)]);
  const batch = w.ocr.targets(w.buildings);
  const out = w.ocr.applyResults(batch, lines(batch, [
    { text: 'LEVEL 2', confidence: 0.95, y: 0.3 },
    { text: '::.,/', confidence: 0.2, y: 0.7 },
  ]));
  const a = w.buildings[0].assign['admin-1'];
  assert.strictEqual(out.accepted, 1);
  assert.strictEqual(a.token, 'admin-l2');
  assert.strictEqual(a.autoAccepted, true);
  assert.strictEqual(a.ocrConf, 0.95);
});

test('no line naming a floor falls back to the server’s own best candidate', () => {
  const w = wizard([building('admin', 1)]);
  const batch = w.ocr.targets(w.buildings);
  const out = w.ocr.applyResults(batch, lines(batch, [
    { text: 'MEZZANINE', confidence: 0.8, y: 0.5 },
  ], 'MEZZANINE', 0.8));
  const a = w.buildings[0].assign['admin-1'];
  assert.strictEqual(out.filled, 0);
  assert.strictEqual(a.ocrText, 'MEZZANINE');    // legible, names no floor — and diagnosable
  assert.strictEqual(a.ocrConf, 0.8);
});

// ---- "named no floor" vs "couldn't read": the region-drift signal (IMPORT-71) -------------------
//
// The reported failure: a code region marked on one sheet lands on the *building name* on others,
// so a whole facility comes back with confident, legible text and no floors. Both outcomes used to
// render the same confident `Read “…”` chip, which reads as "OCR worked, this sheet has no floor" —
// so the one thing the operator needed to know (the box is over the wrong text) was never said.

test('a legible read that names no floor is flagged apart from an unreadable one', () => {
  const w = wizard([building('admin', 1)]);
  const batch = w.ocr.targets(w.buildings);
  const out = w.ocr.applyResults(batch, lines(batch, [
    { text: 'Administration', confidence: 0.96, y: 0.5 },
  ], 'Administration', 0.96));
  const a = w.buildings[0].assign['admin-1'];
  assert.strictEqual(out.noFloor, 1);
  assert.strictEqual(a.ocrNoFloor, true);
  assert.strictEqual(a.ocrText, 'Administration');   // the evidence is kept, not blanked
});

test('an empty read is NOT flagged as naming no floor — that is the other failure', () => {
  // "The region held nothing legible" is a recognition problem; "the region held text that names no
  // floor" is a placement problem. Conflating them would send the operator to re-mark a box that is
  // in exactly the right place.
  const w = wizard([building('admin', 1)]);
  const batch = w.ocr.targets(w.buildings);
  const out = w.ocr.applyResults(batch, lines(batch, [], '', 0.42));
  assert.strictEqual(out.noFloor, 0);
  assert.strictEqual(w.buildings[0].assign['admin-1'].ocrNoFloor, undefined);
});

test('a read that DID name a floor carries no such flag', () => {
  const w = wizard([building('admin', 1)]);
  const batch = w.ocr.targets(w.buildings);
  const out = w.ocr.applyResults(batch, lines(batch, [
    { text: 'LEVEL 2', confidence: 0.7, y: 0.5 },
  ]));
  assert.strictEqual(out.noFloor, 0);
  assert.strictEqual(w.buildings[0].assign['admin-1'].ocrNoFloor, undefined);
});

test('re-marking the region clears the flag along with the read it belonged to', () => {
  // `ocrNoFloor` is a statement about one box's pixels. Left behind after a re-mark it would keep
  // warning about a region that no longer exists.
  const w = wizard([building('admin', 1)]);
  const batch = w.ocr.targets(w.buildings);
  w.ocr.applyResults(batch, lines(batch, [{ text: 'Administration', confidence: 0.96, y: 0.5 }],
    'Administration', 0.96));
  w.ocr.regionChanged(null);
  const a = w.buildings[0].assign['admin-1'];
  assert.strictEqual(a.ocrNoFloor, undefined);
  assert.strictEqual(a.ocrText, undefined);
});

test('isOwnName recognizes the building however the operator or NetBox spells it', () => {
  const b = { folder: '001-ADMIN', name: 'Administration',
    nbSite: { name: 'Cal Poly' }, nbBuilding: { name: 'Cotchett Education Building' } };
  assert.strictEqual(ImportOcrSweep.isOwnName('Administration', b), true);
  assert.strictEqual(ImportOcrSweep.isOwnName('ADMINISTRATION', b), true);   // case/punctuation fold
  assert.strictEqual(ImportOcrSweep.isOwnName('001 admin', b), true);
  // Containment both ways: a title block prints more than NetBox stores, and less.
  assert.strictEqual(
    ImportOcrSweep.isOwnName('CAL POLY Cotchett Education Building', b), true);
  assert.strictEqual(ImportOcrSweep.isOwnName('Cotchett', b), true);
  assert.strictEqual(ImportOcrSweep.isOwnName('Development   MAY 2025', b), false);
});

test('isOwnName refuses to match on a scrap too short to be evidence', () => {
  // Containment makes a short read match almost anything — `ad` sits inside `Administration`. A
  // chip claiming "that's the building's name" has to be right, so the floor is on both sides.
  const b = { folder: 'admin', name: 'Administration', nbSite: null, nbBuilding: null };
  assert.strictEqual(ImportOcrSweep.isOwnName('ad', b), false);
  assert.strictEqual(ImportOcrSweep.isOwnName('A1', b), false);
  assert.strictEqual(ImportOcrSweep.isOwnName('', b), false);
  assert.strictEqual(ImportOcrSweep.isOwnName('Administration', null), false);
  assert.ok(ImportOcrSweep.MIN_NAME_MATCH >= 3);
});

test('the summary counts reads that named no floor, and says what to do about them', () => {
  const w = wizard([building('admin', 3)]);
  w.ocr._tally = { read: 3, filled: 0, aligned: 0, accepted: 0, noFloor: 3, failed: 0 };
  const line = w.ocr._summaryLine();
  assert.ok(line.includes('3 read text that named no floor'), line);
  assert.ok(line.includes('re-mark'), line);
});

test('a sweep that DID match floors keeps the ordinary closing advice', () => {
  // The re-mark advice belongs to a pass that matched nothing. A pass that mostly worked, with one
  // odd sheet, must not tell the operator their region is wrong.
  const w = wizard([building('admin', 1)]);
  w.ocr._tally = { read: 4, filled: 3, aligned: 1, accepted: 0, noFloor: 1, failed: 0 };
  const line = w.ocr._summaryLine();
  assert.ok(line.includes('1 read text that named no floor'), line);
  assert.ok(line.includes('Every suggestion is yours to confirm.'), line);
});

test('a read that found nothing plausible still counts as read, so the sweep terminates', () => {
  // The reader answers an unreadable region with an empty `text` AND an empty `lines`. That must
  // stay "read, found nothing" — a drawing left with no `ocrText` becomes a target again on the
  // next pass, and `autoStart` re-runs on every render.
  const w = wizard([building('admin', 1)]);
  const batch = w.ocr.targets(w.buildings);
  const out = w.ocr.applyResults(batch, lines(batch, [], '', 0.42));
  assert.strictEqual(out.read, 1);
  assert.strictEqual(w.buildings[0].assign['admin-1'].ocrText, '');
  assert.deepStrictEqual(w.ocr.targets(w.buildings), []);
});

// ---- auto-accept: the one thing a read may decide, and everything it may not (IMPORT-63) -------
//
// This reverses the rule the sweep shipped with, on an explicit decision, so the guard rails are
// what these tests exist to hold: high confidence AND a literal match AND a drawing nobody has
// answered. Take away any one of the three and a wrong floor lands unasked, which is the failure
// the removed `1.10.0` engine is remembered for.

test('a confident literal read is taken as the answer, not offered as a suggestion', () => {
  const w = wizard([building('admin', 1)]);
  const batch = w.ocr.targets(w.buildings);
  const out = w.ocr.applyResults(batch, results(batch, 'LEVEL 2', 0.95));
  const a = w.buildings[0].assign['admin-1'];
  assert.strictEqual(out.accepted, 1);
  assert.strictEqual(a.token, 'admin-l2');
  assert.strictEqual(a.autoAccepted, true);
  assert.strictEqual(a.suggested, false);
});

test('the same read below the threshold stays a suggestion', () => {
  const w = wizard([building('admin', 1)]);
  const batch = w.ocr.targets(w.buildings);
  const conf = ImportFlow.AUTO_ACCEPT_OCR_CONF - 0.01;
  const out = w.ocr.applyResults(batch, results(batch, 'LEVEL 2', conf));
  const a = w.buildings[0].assign['admin-1'];
  assert.strictEqual(out.accepted, 0);
  assert.strictEqual(a.token, 'admin-l2');       // the match still stands…
  assert.strictEqual(a.suggested, true);         // …as something to confirm
  assert.strictEqual(a.autoAccepted, undefined);
});

test('the threshold is inclusive, and sits clear of the low-confidence flag', () => {
  const w = wizard([building('admin', 1)]);
  const batch = w.ocr.targets(w.buildings);
  w.ocr.applyResults(batch, results(batch, 'LEVEL 2', ImportFlow.AUTO_ACCEPT_OCR_CONF));
  assert.strictEqual(w.buildings[0].assign['admin-1'].autoAccepted, true);
  // A read confident enough to commit must never also be faint enough to be flagged for review;
  // the two thresholds answer different questions and crossing them would be incoherent.
  assert.ok(ImportFlow.AUTO_ACCEPT_OCR_CONF > ImportFlow.LOW_OCR_CONF);
});

test('a floor reached by ALIGNMENT is never auto-accepted, however clear the read', () => {
  // The read said BASEMENT perfectly; which of this building's floors that *is* was decided by
  // matching its reads as an ordered set, and no recognition score speaks to that.
  const w = wizard([building('admin', 2)]);
  const batch = w.ocr.targets(w.buildings);
  const out = w.ocr.applyResults(batch, [
    { folder: 'admin', stem: 'admin-1', text: 'BASEMENT', confidence: 1 },
    { folder: 'admin', stem: 'admin-2', text: 'LEVEL 2', confidence: 1 },
  ]);
  const assign = w.buildings[0].assign;
  assert.strictEqual(out.accepted, 1);                       // the literal LEVEL 2 only
  assert.strictEqual(assign['admin-2'].autoAccepted, true);
  assert.strictEqual(assign['admin-1'].matchedBy, 'aligned');
  assert.strictEqual(assign['admin-1'].suggested, true);
  assert.strictEqual(assign['admin-1'].autoAccepted, undefined);
});

test('auto-accept fills an unconfirmed pre-fill but never an operator’s own floor', () => {
  const b = building('admin', 2);
  b.assign['admin-1'] = { type: 'level', num: 9, token: null, label: '', autoDefault: true };
  const w = wizard([b]);
  const batch = w.ocr.targets(w.buildings);
  // The operator answers admin-2 while the batch is out — the anti-clobber rule, unchanged.
  Object.assign(b.assign['admin-2'],
    { type: 'level', num: 1, token: 'admin-l1', label: 'Level 1', suggested: false });
  const out = w.ocr.applyResults(batch, results(batch, 'LEVEL 2', 0.99));
  assert.strictEqual(out.accepted, 1);
  assert.strictEqual(b.assign['admin-1'].autoAccepted, true);      // the blind default gave way
  assert.strictEqual(b.assign['admin-2'].token, 'admin-l1');       // their answer stands
  assert.strictEqual(b.assign['admin-2'].autoAccepted, undefined);
});

test('an operator pick retires the automatic marker, so the count is real', () => {
  const w = wizard([building('admin', 1)]);
  const batch = w.ocr.targets(w.buildings);
  w.ocr.applyResults(batch, results(batch, 'LEVEL 2', 0.99));
  const a = w.buildings[0].assign['admin-1'];
  ImportFlow.clearUnanswered(a);
  assert.strictEqual(a.autoAccepted, undefined);
  assert.strictEqual(ImportFlow.isUnanswered(a), false);
});

// ---- coverage: what the overview shows for a building the operator can't see ----

test('coverage separates “not reached yet” from “read and found nothing”', () => {
  // The distinction the whole facility view rests on: without it the operator works through the
  // apparently-clear buildings and has them fill in behind them.
  stubWindow({ capabilities: ['ocr'] });
  const b = building('admin', 2);
  const w = wizard([b]);
  assert.strictEqual(w.ocr.coverage(b).state, 'pending');
  const batch = w.ocr.targets(w.buildings);
  w.ocr.applyResults(batch, results(batch, 'MEZZANINE'));
  assert.strictEqual(w.ocr.coverage(b).state, 'done');
  assert.strictEqual(w.ocr.coverage(b).read, 2);
});

test('coverage calls out a building with no region of its own to read', () => {
  stubWindow({ capabilities: ['ocr'] });
  const own = building('own', 1, { codeRegion: REGION });
  const bare = building('bare', 1);
  const w = wizard([own, bare], null);          // no global region; only `own` has one
  assert.strictEqual(w.ocr.coverage(bare).state, 'no-region');
  assert.strictEqual(w.ocr.coverage(own).state, 'pending');
});

test('coverage says nothing at all when the install can’t read codes', () => {
  stubWindow({ capabilities: [] });
  const w = wizard([building('admin', 1)]);
  assert.strictEqual(w.ocr.coverage(w.buildings[0]).state, 'off');
});

// ---- re-marking a region is what makes a re-read possible ----

test('re-marking the global region clears the reads it invalidated, but not answers', () => {
  const b = building('admin', 2);
  b.assign['admin-1'].ocrText = 'L9';
  Object.assign(b.assign['admin-2'],
    { type: 'level', num: 1, token: 'admin-l1', label: 'Level 1', ocrText: 'L1', ocrConf: 0.9 });
  const w = wizard([b]);
  w.ocr.regionChanged(null);
  assert.strictEqual(b.assign['admin-1'].ocrText, undefined);   // re-readable under the new box
  assert.strictEqual(b.assign['admin-2'].ocrText, 'L1');        // answered: the read stays a record
  assert.deepStrictEqual(w.ocr.targets(w.buildings).map(t => t.item.stem), ['admin-1']);
});

test('re-marking one building’s region leaves the rest of the facility alone', () => {
  const own = building('own', 1, { codeRegion: { x: 0, y: 0, w: 0.4, h: 0.4 } });
  const other = building('other', 1);
  own.assign['own-1'].ocrText = 'L9';
  other.assign['other-1'].ocrText = 'L9';
  const w = wizard([own, other]);
  w.ocr.regionChanged(own);
  assert.strictEqual(own.assign['own-1'].ocrText, undefined);
  assert.strictEqual(other.assign['other-1'].ocrText, 'L9');
});

test('a global re-mark skips buildings that have their own region', () => {
  const own = building('own', 1, { codeRegion: { x: 0, y: 0, w: 0.4, h: 0.4 } });
  own.assign['own-1'].ocrText = 'L9';
  const w = wizard([own]);
  w.ocr.regionChanged(null);
  assert.strictEqual(own.assign['own-1'].ocrText, 'L9');   // the global box isn't its box
});

// ---- the automatic pass declines rather than failing ----

test('the sweep is unavailable without the install’s ocr capability, however many regions exist', () => {
  const w = wizard([building('admin', 1)]);
  stubWindow({ capabilities: [] });
  assert.strictEqual(w.ocr.available(), false);
  stubWindow({ capabilities: ['ocr'] });
  assert.strictEqual(w.ocr.available(), true);
});

test('the sweep is unavailable until some region is marked', () => {
  stubWindow({ capabilities: ['ocr'] });
  const w = wizard([building('admin', 1)], null);
  assert.strictEqual(w.ocr.available(), false);
  w.buildings[0].codeRegion = REGION;   // one building's own override is enough to start
  assert.strictEqual(w.ocr.available(), true);
});
