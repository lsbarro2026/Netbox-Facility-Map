'use strict';
/* import-bulk.test.js — ImportBulk's static matchers: the filename-stem -> FLOOR axis.

   The opposite axis from ImportMatch (which names the *building*). A drawing filename carries
   both signals and the two are easy to conflate, so these fixtures deliberately use floor-shaped
   names only.

   Scope is the pure statics — `floorNumber`, `_globSource`, `globMatcher`, `floorPatternMatcher`,
   `floorFromStem`, `selectionMatcher` — plus `suggestFloors`/`_resolveGuess`, which are instance methods only because
   they read the building model, and touch no DOM. The rest of the class is genuinely wizard-bound:
   it renders controls through `Dom` and toasts — browser-side, out of this tier by design. */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadClasses } = require('./load.js');

const { ImportBulk } = loadClasses(['import-bulk.js'], ['ImportBulk']);

// ---- floorNumber: the fallback rung of cross-building floor resolution ----

test('floorNumber reads the LAST digit run, not the first', () => {
  // The reason this matters: a name carrying both a building number and a floor number must
  // resolve to the floor. First-match would answer 2 here and mis-assign the whole building.
  assert.strictEqual(ImportBulk.floorNumber('Building 2 - Floor 3'), 3);
  assert.strictEqual(ImportBulk.floorNumber('Floor 3'), 3);
  assert.strictEqual(ImportBulk.floorNumber('B2-L14'), 14);
});

test('floorNumber parses a zero-padded number', () => {
  assert.strictEqual(ImportBulk.floorNumber('Level 03'), 3);
});

test('floorNumber is null when the name carries no digits', () => {
  // Null, not 0 — the caller distinguishes "no number here" from "floor zero".
  assert.strictEqual(ImportBulk.floorNumber('Ground'), null);
  assert.strictEqual(ImportBulk.floorNumber(''), null);
  assert.strictEqual(ImportBulk.floorNumber(null), null);
  assert.strictEqual(ImportBulk.floorNumber(undefined), null);
});

// ---- _globSource: escaping happens BEFORE the wildcards are re-opened ----

test('_globSource escapes regex metacharacters so a filename cannot smuggle in a pattern', () => {
  // '.' is the common one in a real filename. If escaping ran after wildcard expansion, a
  // pattern like 'a.b' would match 'axb' too.
  const rx = new RegExp('^' + ImportBulk._globSource('a.b') + '$');
  assert.ok(rx.test('a.b'));
  assert.ok(!rx.test('axb'));
});

test('_globSource is null for an empty or whitespace-only pattern', () => {
  assert.strictEqual(ImportBulk._globSource(''), null);
  assert.strictEqual(ImportBulk._globSource('   '), null);
  assert.strictEqual(ImportBulk._globSource(null), null);
});

// ---- globMatcher: the drawing-name selector ----

test('globMatcher matches * as any run and ? as exactly one character', () => {
  const any = ImportBulk.globMatcher('*-L03-*');
  assert.ok(any('BLDG-L03-PLAN'));
  assert.ok(any('-L03-'));                    // both runs may be empty
  assert.ok(!any('BLDG-L04-PLAN'));

  const one = ImportBulk.globMatcher('A?1');
  assert.ok(one('AB1'));
  assert.ok(!one('AB11'));                    // '?' is one character, not a run
  assert.ok(!one('A1'));
});

test('globMatcher is anchored at both ends', () => {
  const m = ImportBulk.globMatcher('L03');
  assert.ok(m('L03'));
  assert.ok(!m('BLDG-L03'));                  // no implicit leading wildcard
  assert.ok(!m('L03-PLAN'));
});

test('globMatcher is case-insensitive', () => {
  const m = ImportBulk.globMatcher('*-l03-*');
  assert.ok(m('BLDG-L03-PLAN'));
});

test('globMatcher matches the full stem including an exploded page suffix', () => {
  // A multi-page PDF explodes to stems carrying '#pN'; the page-range controls target those, and
  // a name pattern must still see the whole stem.
  assert.ok(ImportBulk.globMatcher('*#p3')('CAMPUS-PLANS#p3'));
});

test('globMatcher is null for an empty pattern', () => {
  assert.strictEqual(ImportBulk.globMatcher(''), null);
  assert.strictEqual(ImportBulk.globMatcher(null), null);
});

// ---- floorPatternMatcher: {n} captures the floor number ----

test('floorPatternMatcher captures the number a matching stem names', () => {
  const m = ImportBulk.floorPatternMatcher('*-L{n}-*');
  assert.strictEqual(m('BLDG-L03-PLAN'), 3);          // zero-padded parses to its int
  assert.strictEqual(m('BLDG-L12-PLAN'), 12);
});

test('floorPatternMatcher returns null for a stem that does not match', () => {
  // A drawing whose name does not match is left alone, never blindly numbered.
  const m = ImportBulk.floorPatternMatcher('*-L{n}-*');
  assert.strictEqual(m('BLDG-ROOF-PLAN'), null);
});

test('floorPatternMatcher is null without {n}, distinguishing a bad pattern from no match', () => {
  // The caller needs to tell "you did not write {n}" from "nothing matched" — one is a user
  // error to report, the other a legitimate empty result.
  assert.strictEqual(ImportBulk.floorPatternMatcher('*-L03-*'), null);
  assert.strictEqual(ImportBulk.floorPatternMatcher(''), null);
  assert.strictEqual(ImportBulk.floorPatternMatcher(null), null);
  assert.notStrictEqual(ImportBulk.floorPatternMatcher('*-L{n}-*'), null);
});

test('floorPatternMatcher captures digits only, never letters', () => {
  const m = ImportBulk.floorPatternMatcher('L{n}');
  assert.strictEqual(m('L7'), 7);
  assert.strictEqual(m('LG'), null);
});

// ---- floorFromStem: the filename -> floor SUGGESTION (IMPORT-28) ----
//
// The dep-free replacement for the OCR floor-read removed in 1.10.0. Everything it returns is a
// pre-fill the operator confirms, so the interesting cases are the ones where it must stay SILENT:
// a wrong guess that looks authoritative is worse than no guess at all.

test('floorFromStem reads the common level spellings', () => {
  const lvl = (n) => ({ type: 'level', num: n });
  assert.deepStrictEqual(ImportBulk.floorFromStem('HQ-L3'), lvl(3));
  assert.deepStrictEqual(ImportBulk.floorFromStem('HQ-FL03'), lvl(3));
  assert.deepStrictEqual(ImportBulk.floorFromStem('HQ-LVL12'), lvl(12));
  assert.deepStrictEqual(ImportBulk.floorFromStem('HQ LEVEL 4'), lvl(4));
  assert.deepStrictEqual(ImportBulk.floorFromStem('HQ-F2'), lvl(2));
});

test('floorFromStem reads basement, ground and roof as whole words', () => {
  assert.deepStrictEqual(ImportBulk.floorFromStem('HQ-B2'), { type: 'basement', num: 2 });
  assert.deepStrictEqual(ImportBulk.floorFromStem('HQ-BASEMENT'), { type: 'basement', num: 1 });
  assert.deepStrictEqual(ImportBulk.floorFromStem('HQ-GROUND'), { type: 'ground', num: 1 });
  assert.deepStrictEqual(ImportBulk.floorFromStem('HQ-GF'), { type: 'ground', num: 1 });
  assert.deepStrictEqual(ImportBulk.floorFromStem('HQ-ROOF'), { type: 'roof', num: 1 });
  assert.deepStrictEqual(ImportBulk.floorFromStem('HQ-RF'), { type: 'roof', num: 1 });
});

test('floorFromStem reads an ordinal floor', () => {
  // "2ND-FLOOR-PLAN" is a real convention, and the (letters)(digits) scan alone cannot see it —
  // the number leads the word there rather than trailing it.
  assert.deepStrictEqual(ImportBulk.floorFromStem('2ND-FLOOR-PLAN'), { type: 'level', num: 2 });
  assert.deepStrictEqual(ImportBulk.floorFromStem('1st floor'), { type: 'level', num: 1 });
});

test('floorFromStem takes the LAST marker, so a leading building code loses', () => {
  // The reporter's own filename shape: `001` is the BUILDING, `FL1` the floor. Reading the first
  // marker would answer "level 1" for the wrong reason here and "level 5" on `005-Arch-FL2`.
  assert.deepStrictEqual(ImportBulk.floorFromStem('001-Admin-FL1'), { type: 'level', num: 1 });
  assert.deepStrictEqual(ImportBulk.floorFromStem('005-Arch-FL2'), { type: 'level', num: 2 });
});

test('floorFromStem decomposes a run-together stem', () => {
  assert.deepStrictEqual(ImportBulk.floorFromStem('AdminBldg1FL2'), { type: 'level', num: 2 });
});

test('floorFromStem stays silent on a drawing-sheet number', () => {
  // A101/M203/E1 are sheet numbers, not floors. The guard is the word table itself: `a`, `m` and
  // `e` name no floor, so they never reach one.
  assert.strictEqual(ImportBulk.floorFromStem('A101'), null);
  assert.strictEqual(ImportBulk.floorFromStem('M203-MECH'), null);
  assert.strictEqual(ImportBulk.floorFromStem('E1-POWER'), null);
});

test('floorFromStem stays silent on a 3-digit number after a floor word', () => {
  // `L-101` is a landscape sheet series, and `L` *is* in the word table — so the ceiling is what
  // separates it from a storey. No building has a 101st floor in this dataset.
  assert.strictEqual(ImportBulk.floorFromStem('L-101'), null);
  assert.strictEqual(ImportBulk.floorFromStem('L101'), null);
  assert.deepStrictEqual(ImportBulk.floorFromStem('L99'), { type: 'level', num: 99 });
});

test('floorFromStem needs a number before it calls something a level', () => {
  // A bare "FLOOR PLAN" names no storey — every drawing in the set is a floor plan.
  assert.strictEqual(ImportBulk.floorFromStem('HQ-FLOOR-PLAN'), null);
  assert.strictEqual(ImportBulk.floorFromStem('FL'), null);
});

test('floorFromStem stays silent on a bare G or R', () => {
  // Single letters are overwhelmingly a sheet series or a revision marker, not ground/roof — so
  // only the >=2-character spellings are read.
  assert.strictEqual(ImportBulk.floorFromStem('HQ-G'), null);
  assert.strictEqual(ImportBulk.floorFromStem('HQ-R'), null);
});

test('floorFromStem skips an exploded page row outright', () => {
  // A `<file>#pN` stem (_explodePages) names the whole multi-page SET, so one guess from it would
  // smear a single floor across every page — worse than leaving them unassigned.
  assert.strictEqual(ImportBulk.floorFromStem('HQ-L3#p7'), null);
  assert.strictEqual(ImportBulk.floorFromStem('ARCH-SET#p1'), null);
});

test('floorFromStem stays silent on a name that says nothing', () => {
  assert.strictEqual(ImportBulk.floorFromStem('SCHEDULES'), null);
  assert.strictEqual(ImportBulk.floorFromStem(''), null);
  assert.strictEqual(ImportBulk.floorFromStem(null), null);
});

// ---- floorFromText: the same scanner over an OCR-read floor CAPTION (IMPORT-31) ----
//
// `floorFromStem` is now a thin wrapper over `floorFromText`, so filenames and captions resolve
// through one vocabulary and one last-marker rule instead of the two parsers that drifted apart
// before `1.10.0`. What captions add is prose: spelled-out ordinals, and a code buried inside a
// sentence.

test('floorFromText reads the caption shape that defeated the removed engine', () => {
  // The `1.9.0` post-mortem case, verbatim: the code drifts sideways with building-name length, so
  // the region is caption-sized and the parser has to find `(B2)` inside the surrounding words.
  assert.deepStrictEqual(ImportBulk.floorFromText('SECOND BASEMENT LEVEL (B2) PLAN'),
    { type: 'basement', num: 2 });
});

test('floorFromText reads spelled-out ordinals, which captions use and filenames do not', () => {
  assert.deepStrictEqual(ImportBulk.floorFromText('SECOND FLOOR PLAN'), { type: 'level', num: 2 });
  assert.deepStrictEqual(ImportBulk.floorFromText('THIRD FLOOR'), { type: 'level', num: 3 });
  assert.deepStrictEqual(ImportBulk.floorFromText('TWELFTH FLOOR'), { type: 'level', num: 12 });
  assert.deepStrictEqual(ImportBulk.floorFromText('THIRD SUB-BASEMENT'),
    { type: 'basement', num: 3 });
});

test('floorFromText keeps an ordinal number attached to its own floor word', () => {
  // The trap the fold exists for: read as separate signals, the bare word `BASEMENT` defaults to 1
  // and would clobber the ordinal's 2. Folding "second basement" into `basement2` before the scan
  // keeps them one marker, so the number survives.
  assert.deepStrictEqual(ImportBulk.floorFromText('SECOND BASEMENT LEVEL PLAN'),
    { type: 'basement', num: 2 });
  assert.deepStrictEqual(ImportBulk.floorFromText('2ND BASEMENT'), { type: 'basement', num: 2 });
});

test('floorFromText lets an explicit code outrank an ordinal earlier in the caption', () => {
  // Last marker wins, exactly as for a filename — and in a caption the explicit code reads last.
  assert.deepStrictEqual(ImportBulk.floorFromText('THIRD FLOOR — L4 PLAN'),
    { type: 'level', num: 4 });
});

test('floorFromText tolerates the spacing an OCR read loses', () => {
  // Recognition routinely drops the space between a word and what follows it.
  assert.deepStrictEqual(ImportBulk.floorFromText('LEVEL 3PLAN'), { type: 'level', num: 3 });
  assert.deepStrictEqual(ImportBulk.floorFromText('LEVEL(B2)'), { type: 'basement', num: 2 });
});

test('floorFromText stays silent on a caption naming no floor', () => {
  assert.strictEqual(ImportBulk.floorFromText('A101 MECHANICAL'), null);
  assert.strictEqual(ImportBulk.floorFromText('DRAWING SCHEDULE'), null);
  assert.strictEqual(ImportBulk.floorFromText(''), null);
});

test('floorFromText reads an exploded page caption that floorFromStem must refuse', () => {
  // The capability OCR adds over the filename heuristic: one stem names sixty pages, so a *name*
  // guess would smear one floor across all of them — but each page carries its own caption.
  assert.strictEqual(ImportBulk.floorFromStem('ARCH-SET#p4'), null);
  assert.deepStrictEqual(ImportBulk.floorFromText('FOURTH FLOOR PLAN'), { type: 'level', num: 4 });
});

// ---- suggestFloors: the pre-fill pass, and what it must refuse to touch ----
//
// `_resolveGuess`/`suggestFloors` are instance methods but need no DOM — they read the building
// model and write assignments. The rule worth pinning is negative: a suggestion fills a blank and
// nothing else. Overwriting an operator's own answer is the one failure mode that would make this
// feature worse than the manual step it replaces.

/** A building with one drawing per stem, all still `unassigned`. */
function bldg(stems, nbFloors) {
  return {
    pdfs: stems.map(s => ({ stem: s })),
    assign: Object.fromEntries(stems.map(s =>
      [s, { type: 'unassigned', num: 1, token: null, label: '' }])),
    regions: Object.fromEntries(stems.map(s => [s, []])),
    nbFloors,
  };
}

const LOCS = [
  { slug: 'hq-b1', name: 'Basement' },
  { slug: 'hq-l1', name: 'Level 1' },
  { slug: 'hq-l2', name: 'Level 2' },
  { slug: 'hq-roof', name: 'Roof' },
];

test('suggestFloors resolves a level guess against the building own Locations', () => {
  const b = bldg(['HQ-L2'], LOCS);
  assert.strictEqual(new ImportBulk({}).suggestFloors(b), 1);
  assert.deepStrictEqual(b.assign['HQ-L2'],
    { type: 'level', num: 1, token: 'hq-l2', label: 'Level 2', suggested: true,
      suggestedFrom: 'filename' });
});

test('suggestFloors matches basement and roof by NAME, never by number', () => {
  // `B2` means basement 2. If its digit reached `_resolveFloor`'s number rung it would resolve to
  // "Level 2" — a wrong floor presented as a confident pre-fill.
  const b = bldg(['HQ-B2', 'HQ-ROOF'], LOCS);
  new ImportBulk({}).suggestFloors(b);
  assert.strictEqual(b.assign['HQ-B2'].token, null);          // no "Basement 2" exists -> silent
  assert.strictEqual(b.assign['HQ-B2'].type, 'unassigned');
  assert.strictEqual(b.assign['HQ-ROOF'].token, 'hq-roof');
});

test('suggestFloors falls back to the floor-type vocabulary with no Locations', () => {
  const b = bldg(['HQ-B1'], []);
  assert.strictEqual(new ImportBulk({}).suggestFloors(b), 1);
  assert.deepStrictEqual(b.assign['HQ-B1'],
    { type: 'basement', num: 1, token: null, label: '', suggested: true,
      suggestedFrom: 'filename' });
});

test('suggestFloors records the filename as the suggestion source', () => {
  // `suggestedFrom` is what lets a card say where its pre-fill came from, now that a suggestion
  // can also arrive from an OCR read of the marked code region (IMPORT-31).
  const b = bldg(['HQ-L2'], LOCS);
  new ImportBulk({}).suggestFloors(b);
  assert.strictEqual(b.assign['HQ-L2'].suggestedFrom, 'filename');
});

test('suggestFloors never overwrites an operator assignment', () => {
  const b = bldg(['HQ-L2', 'HQ-L1', 'HQ-ROOF'], LOCS);
  // A hand-picked Location, a deliberate (none), and a floor-type pick made by hand — the last has
  // no token to protect it, which is why the pass tests `unassigned` rather than "has no token".
  b.assign['HQ-L2'] = { type: 'level', num: 1, token: 'hq-l1', label: 'Level 1' };
  b.assign['HQ-L1'] = { type: 'none', num: 1, token: null, label: '' };
  b.assign['HQ-ROOF'] = { type: 'level', num: 5, token: null, label: '' };
  const before = JSON.parse(JSON.stringify(b.assign));
  assert.strictEqual(new ImportBulk({}).suggestFloors(b), 0);
  assert.deepStrictEqual(b.assign, before);
});

test('suggestFloors skips a region-split drawing', () => {
  // One page fanning into several floors (FLOOR-4) — a single stem cannot name them.
  const b = bldg(['HQ-L2'], LOCS);
  b.regions['HQ-L2'] = [{ box: { x: 0, y: 0, w: 1, h: 1 }, assign: { type: 'unassigned' } }];
  assert.strictEqual(new ImportBulk({}).suggestFloors(b), 0);
  assert.strictEqual(b.assign['HQ-L2'].type, 'unassigned');
});

test('suggestFloors leaves a drawing whose name says nothing unassigned', () => {
  // Still gated by the build, exactly as before — a silent guess is what this must not do.
  const b = bldg(['SCHEDULES'], LOCS);
  assert.strictEqual(new ImportBulk({}).suggestFloors(b), 0);
  assert.strictEqual(b.assign['SCHEDULES'].type, 'unassigned');
});

test('floorFromStem is not fooled by an Object.prototype key', () => {
  // The word table is looked up with a token taken straight from a filename, so it is a Map — an
  // object literal would answer `Object` here and hand back a truthy "floor type".
  assert.strictEqual(ImportBulk.floorFromStem('constructor'), null);
  assert.strictEqual(ImportBulk.floorFromStem('HQ-toString2'), null);
});

// ---- ordinal space: reconciling two naming systems (IMPORT-52) ----
//
// A building's captions and its NetBox Location names describe the same ordered set of storeys in
// two different vocabularies. `GROUND` and `Floor 0` share not one character, so no string rung
// can ever bring them together; parsed into a signed storey index they are simply both 0.

test('floorOrdinal puts basements below zero, ground at zero, the roof above everything', () => {
  assert.strictEqual(ImportBulk.floorOrdinal({ type: 'basement', num: 1 }), -1);
  assert.strictEqual(ImportBulk.floorOrdinal({ type: 'basement', num: 3 }), -3);
  assert.strictEqual(ImportBulk.floorOrdinal({ type: 'ground', num: 1 }), 0);
  assert.strictEqual(ImportBulk.floorOrdinal({ type: 'level', num: 7 }), 7);
  assert.strictEqual(ImportBulk.floorOrdinal({ type: 'roof', num: 1 }), ImportBulk.ROOF_ORDINAL);
  assert.strictEqual(ImportBulk.floorOrdinal(null), null);
});

test('the sign is what keeps B2 away from Level 2, in arithmetic rather than by hand', () => {
  // The invariant the name-only rung protects by convention, stated once as a number: basement 2
  // is -2 and level 2 is +2, so the two can never meet however the comparison is done.
  assert.strictEqual(ImportBulk.floorOrdinal({ type: 'basement', num: 2 }), -2);
  assert.strictEqual(ImportBulk.floorOrdinal({ type: 'level', num: 2 }), 2);
});

test('ordinalFromText reads the zero storey that floorFromText deliberately refuses', () => {
  // The refusal is load-bearing on the FILENAME axis — the 1..99 guard is what keeps a drawing
  // sheet number out of the floor vocabulary — so the zero case is read here instead of by
  // loosening it. Both halves of that split are asserted together, on purpose.
  assert.strictEqual(ImportBulk.floorFromText('Floor 0'), null);
  assert.strictEqual(ImportBulk.ordinalFromText('Floor 0'), 0);
  assert.strictEqual(ImportBulk.ordinalFromText('L0'), 0);
  assert.strictEqual(ImportBulk.ordinalFromText('LEVEL 00'), 0);
});

test('ordinalFromText still lets a drawing-sheet number name no storey at all', () => {
  // `L-101` is a landscape sheet series. The zero rung must not become a way back in for it.
  assert.strictEqual(ImportBulk.ordinalFromText('L-101'), null);
  assert.strictEqual(ImportBulk.ordinalFromText('A101 MECHANICAL'), null);
  assert.strictEqual(ImportBulk.ordinalFromText('DRAWING SCHEDULE'), null);
  assert.strictEqual(ImportBulk.ordinalFromText(''), null);
});

test('ordinalFromText agrees across both vocabularies for the same storey', () => {
  for (const [a, b] of [['GROUND', 'Floor 0'], ['SECOND FLOOR', 'Level 2'],
    ['B1', 'Basement'], ['FIRST FLOOR', 'L1'], ['ROOF', 'Rooftop']])
    assert.strictEqual(ImportBulk.ordinalFromText(a), ImportBulk.ordinalFromText(b),
      a + ' and ' + b + ' name the same storey');
});

test('_locOrdinal reads a Location name, falling back to its slug', () => {
  assert.strictEqual(ImportBulk._locOrdinal({ slug: 'hq-x', name: 'Floor 0' }), 0);
  assert.strictEqual(ImportBulk._locOrdinal({ slug: 'hq-l2', name: '' }), 2);
  assert.strictEqual(ImportBulk._locOrdinal({ slug: 'hq-x', name: 'Mechanical' }), null);
});

test('_uniqueByOrdinal refuses to choose when two Locations name the same storey', () => {
  // Ambiguity produces nothing, never whichever happened to be listed first.
  const two = [{ slug: 'a', name: 'Floor 0' }, { slug: 'b', name: 'Lower Ground' }];
  assert.strictEqual(ImportBulk._uniqueByOrdinal(two, 0), null);
  assert.strictEqual(ImportBulk._uniqueByOrdinal([{ slug: 'a', name: 'Floor 0' }], 0).slug, 'a');
  assert.strictEqual(ImportBulk._uniqueByOrdinal(two, null), null);
});

// ---- the reporter's case, and the alignment rung that answers it ----

/** `Floor 0` / `Floor 1` / `Floor 2` — a building whose NetBox names carry no hint of which storey
 *  is the ground one. The reporter's own set. */
const FLOORS_012 = [
  { slug: 'hq-floor-0', name: 'Floor 0' },
  { slug: 'hq-floor-1', name: 'Floor 1' },
  { slug: 'hq-floor-2', name: 'Floor 2' },
];

test('the reporter case resolves end to end: BASEMENT/GROUND/SECOND FLOOR -> Floor 0/1/2', () => {
  // Not a constant ordinal offset (-1->0, 0->1, 2->2 shifts by 1, 1, then 0), which is exactly why
  // sliding one axis along the other cannot fit it and rank alignment can. The literal
  // SECOND FLOOR -> Floor 2 is what vouches for the other two.
  const b = bldg(['BASEMENT', 'GROUND', 'SECOND FLOOR'], FLOORS_012);
  assert.strictEqual(new ImportBulk({}).suggestFloors(b), 3);
  assert.strictEqual(b.assign['BASEMENT'].token, 'hq-floor-0');
  assert.strictEqual(b.assign['GROUND'].token, 'hq-floor-1');
  assert.strictEqual(b.assign['SECOND FLOOR'].token, 'hq-floor-2');
  // ...and each says how it got there: two by order, one by an outright name match.
  assert.strictEqual(b.assign['BASEMENT'].matchedBy, 'aligned');
  assert.strictEqual(b.assign['GROUND'].matchedBy, 'aligned');
  assert.strictEqual(b.assign['SECOND FLOOR'].matchedBy, undefined);
  for (const s of ['BASEMENT', 'GROUND', 'SECOND FLOOR']) {
    assert.strictEqual(b.assign[s].suggested, true);
    assert.strictEqual(b.assign[s].suggestedFrom, 'filename');
  }
});

/** The OCR half of the same pass: captions instead of stems, through the shared `_suggestFrom`.
 *  `_populateOcr` itself is wizard-bound (network, toasts, re-render); this is the logic under it. */
function ocrReads(b, captions) {
  return captions.map(c => ({ a: b.assign[c], guess: ImportBulk.floorFromText(c), done: false }));
}

test('an OCR read of the same three captions resolves identically, and says it came from OCR', () => {
  const b = bldg(['BASEMENT', 'GROUND', 'SECOND FLOOR PLAN'], FLOORS_012);
  const out = new ImportBulk({})._suggestFrom(b, ocrReads(b,
    ['BASEMENT', 'GROUND', 'SECOND FLOOR PLAN']), 'ocr');
  assert.deepStrictEqual(out, { filled: 3, aligned: 2, accepted: 0 });
  assert.strictEqual(b.assign['BASEMENT'].token, 'hq-floor-0');
  assert.strictEqual(b.assign['GROUND'].token, 'hq-floor-1');
  assert.strictEqual(b.assign['SECOND FLOOR PLAN'].token, 'hq-floor-2');
  assert.strictEqual(b.assign['GROUND'].suggestedFrom, 'ocr');
});

test('ONE sheet whose read named no floor costs the whole building its alignment (IMPORT-71)', () => {
  // The coupling behind the second half of the reported bug, and why "matching is broken" was the
  // wrong diagnosis. A read that named no floor is never pushed into `targets` at all, so the counts
  // diverge, `_alignGuesses`' `pool.length !== targets.length` precondition fires, and the building
  // that aligns three-for-three when all three sheets read (above) aligns nothing.
  //
  // What lands instead is the cost, in full: rung 3 takes `GROUND` at its word and answers `Floor
  // 0` — which this building's own scheme contradicts, since here `Floor 0` is the basement. That
  // is precisely the reading whole-building alignment exists to overrule, and losing one read is
  // what takes the overruling away. It stays a *suggestion* the operator confirms (alignment and
  // ordinal rungs never auto-accept), so it is a wrong pre-fill, never a committed wrong floor.
  const b = bldg(['BASEMENT', 'GROUND', 'SECOND FLOOR'], FLOORS_012);
  const out = new ImportBulk({})._suggestFrom(b, ocrReads(b, ['BASEMENT', 'GROUND']), 'ocr');
  assert.deepStrictEqual(out, { filled: 1, aligned: 0, accepted: 0 });
  assert.strictEqual(b.assign['GROUND'].token, 'hq-floor-0');       // the basement, in this scheme
  assert.strictEqual(b.assign['GROUND'].matchedBy, 'ordinal');      // ...and it says it inferred it
  assert.strictEqual(b.assign['GROUND'].suggested, true);
  assert.strictEqual(b.assign['BASEMENT'].type, 'unassigned');
});

test('the same building comes right the moment all three sheets read', () => {
  // The fix for the above is upstream, in `ocr.py`/`pickLine` — nothing here changes. Pinned as the
  // pair to the test above so the dependency is visible: the matching rungs were never the defect.
  const b = bldg(['BASEMENT', 'GROUND', 'SECOND FLOOR'], FLOORS_012);
  const out = new ImportBulk({})._suggestFrom(
    b, ocrReads(b, ['BASEMENT', 'GROUND', 'SECOND FLOOR']), 'ocr');
  assert.deepStrictEqual(out, { filled: 3, aligned: 2, accepted: 0 });
  assert.strictEqual(b.assign['BASEMENT'].token, 'hq-floor-0');
  assert.strictEqual(b.assign['GROUND'].token, 'hq-floor-1');       // NOT Floor 0, as rung 3 had it
  assert.strictEqual(b.assign['SECOND FLOOR'].token, 'hq-floor-2');
});

// ---- the auto-accept hook: which rung may commit, and which may only suggest (IMPORT-63) --------
//
// `_suggestFrom` grew one way to write an answer rather than a suggestion, and the whole safety of
// the feature is *where* that write is allowed. These pin the boundary from the engine side; the
// threshold that drives the hook lives with the sweep.

test('with no accept hook nothing is ever committed — the default is unchanged', () => {
  const b = bldg(['LEVEL 2'], FLOORS_012);
  const out = new ImportBulk({})._suggestFrom(b, ocrReads(b, ['LEVEL 2']), 'ocr');
  assert.strictEqual(out.accepted, 0);
  assert.strictEqual(b.assign['LEVEL 2'].suggested, true);
  assert.strictEqual(b.assign['LEVEL 2'].autoAccepted, undefined);
});

test('a literal match with the hook saying yes is taken as the answer, not a suggestion', () => {
  const b = bldg(['FLOOR 2'], FLOORS_012);
  const out = new ImportBulk({})._suggestFrom(b, ocrReads(b, ['FLOOR 2']), 'ocr',
    { accept: () => true });
  const a = b.assign['FLOOR 2'];
  assert.strictEqual(out.accepted, 1);
  assert.strictEqual(out.filled, 1);           // an accepted read is still a filled drawing
  assert.strictEqual(a.token, 'hq-floor-2');
  assert.strictEqual(a.suggested, false);
  assert.strictEqual(a.autoAccepted, true);
  assert.strictEqual(a.suggestedFrom, 'ocr');  // provenance is kept either way
});

test('the hook is offered each read individually, so a hesitant one stays a suggestion', () => {
  const b = bldg(['FLOOR 1', 'FLOOR 2'], FLOORS_012);
  const reads = ocrReads(b, ['FLOOR 1', 'FLOOR 2']);
  reads[0].conf = 0.4; reads[1].conf = 0.99;
  const out = new ImportBulk({})._suggestFrom(b, reads, 'ocr', { accept: (t) => t.conf >= 0.8 });
  assert.strictEqual(out.accepted, 1);
  assert.strictEqual(b.assign['FLOOR 1'].suggested, true);
  assert.strictEqual(b.assign['FLOOR 1'].autoAccepted, undefined);
  assert.strictEqual(b.assign['FLOOR 2'].autoAccepted, true);
});

test('an ALIGNED match is never auto-accepted, however confident the read', () => {
  // Rung 2 matches a building's reads to its floors as an ordered SET. Its uncertainty is about
  // the two naming systems, not about the pixels — so a recognition score says nothing about
  // whether it is right, and it must stay a suggestion.
  const b = bldg(['BASEMENT', 'GROUND', 'SECOND FLOOR'], FLOORS_012);
  const out = new ImportBulk({})._suggestFrom(b, ocrReads(b, ['BASEMENT', 'GROUND', 'SECOND FLOOR']),
    'ocr', { accept: () => true });
  assert.strictEqual(out.aligned, 2);
  assert.strictEqual(out.accepted, 1);                      // only the literal SECOND FLOOR
  assert.strictEqual(b.assign['SECOND FLOOR'].autoAccepted, true);
  for (const s of ['BASEMENT', 'GROUND']) {
    assert.strictEqual(b.assign[s].matchedBy, 'aligned');
    assert.strictEqual(b.assign[s].suggested, true);
    assert.strictEqual(b.assign[s].autoAccepted, undefined);
  }
});

test('an ORDINAL match is never auto-accepted either, on the same reasoning', () => {
  // `GROUND` reaching a Location called `Floor 0` is an inference about where this building counts
  // from. With no alignable set to corroborate it, rung 3 offers it — as a suggestion only.
  const b = bldg(['GROUND'], FLOORS_012);
  const out = new ImportBulk({})._suggestFrom(b, ocrReads(b, ['GROUND']), 'ocr',
    { accept: () => true });
  const a = b.assign['GROUND'];
  assert.strictEqual(out.accepted, 0);
  assert.strictEqual(a.matchedBy, 'ordinal');
  assert.strictEqual(a.suggested, true);
  assert.strictEqual(a.autoAccepted, undefined);
});

test('a matched drawing loses the blind positional marker, accepted or merely suggested', () => {
  // `autoDefault` says "nobody has looked at this drawing"; once a read has named its floor that is
  // no longer true, whichever way the answer landed. Leaving it set would keep re-offering the
  // drawing to the sweep it just came back from.
  const b = bldg(['FLOOR 2'], FLOORS_012);
  b.assign['FLOOR 2'].autoDefault = true;
  new ImportBulk({})._suggestFrom(b, ocrReads(b, ['FLOOR 2']), 'ocr');
  assert.strictEqual(b.assign['FLOOR 2'].autoDefault, undefined);
});

test('alignment ignores floors already claimed by a drawing it is not touching', () => {
  // A half-assigned building still aligns on what is left — the operator's Floor 2 is out of the
  // pool, so two reads meet the two remaining floors.
  const b = bldg(['PICKED-BY-HAND', 'BASEMENT', 'GROUND'], FLOORS_012);
  b.assign['PICKED-BY-HAND'] = { type: 'level', num: 1, token: 'hq-floor-2', label: 'Floor 2' };
  new ImportBulk({}).suggestFloors(b);
  assert.strictEqual(b.assign['BASEMENT'].token, 'hq-floor-0');
  assert.strictEqual(b.assign['GROUND'].token, 'hq-floor-1');
  assert.strictEqual(b.assign['PICKED-BY-HAND'].suggested, undefined);   // untouched
});

// ---- what alignment must refuse: an ambiguous set produces NOTHING ----

test('alignment refuses a single read, which carries no relative information at all', () => {
  // One drawing has no order to align. It falls through to the per-caption ordinal rung instead,
  // which CAN answer it — and says so as 'ordinal', not 'aligned'.
  const b = bldg(['GROUND'], FLOORS_012);
  assert.strictEqual(new ImportBulk({}).suggestFloors(b), 1);
  assert.strictEqual(b.assign['GROUND'].token, 'hq-floor-0');
  assert.strictEqual(b.assign['GROUND'].matchedBy, 'ordinal');
});

test('alignment refuses unequal counts, since the run could sit at several offsets', () => {
  // Two reads against three floors. No alignment; the ordinal rung answers GROUND on its own and
  // BASEMENT — which names a storey this building has no Location for — stays blank.
  const b = bldg(['BASEMENT', 'GROUND'], FLOORS_012);
  new ImportBulk({}).suggestFloors(b);
  assert.strictEqual(b.assign['GROUND'].token, 'hq-floor-0');
  assert.strictEqual(b.assign['GROUND'].matchedBy, 'ordinal');
  assert.strictEqual(b.assign['BASEMENT'].type, 'unassigned');
});

test('alignment refuses duplicate read ordinals, which leave the ranking undefined', () => {
  const b = bldg(['BASEMENT', 'B1'], [FLOORS_012[0], FLOORS_012[1]]);
  assert.strictEqual(new ImportBulk({}).suggestFloors(b), 0);
  assert.strictEqual(b.assign['BASEMENT'].type, 'unassigned');
  assert.strictEqual(b.assign['B1'].type, 'unassigned');
});

test('alignment refuses when two Locations parse to the same storey', () => {
  const dup = [{ slug: 'f0', name: 'Floor 0' }, { slug: 'lg', name: 'Lower Ground' },
    { slug: 'f2', name: 'Floor 2' }];
  const b = bldg(['BASEMENT', 'GROUND', 'SECOND FLOOR'], dup);
  new ImportBulk({}).suggestFloors(b);
  assert.strictEqual(b.assign['BASEMENT'].type, 'unassigned');
  assert.strictEqual(b.assign['GROUND'].type, 'unassigned');   // ambiguous at ordinal 0 too
});

test('alignment is abandoned whole when it contradicts a literal match', () => {
  // FIRST FLOOR matched `Floor 1` outright. Rank alignment would have to move it to `Floor 2` to
  // fit GROUND underneath it — so the set disagrees with itself and NOTHING is aligned. The
  // literal answer stands and GROUND is left for the operator.
  const b = bldg(['GROUND', 'FIRST FLOOR'],
    [{ slug: 'f1', name: 'Floor 1' }, { slug: 'f2', name: 'Floor 2' }]);
  new ImportBulk({}).suggestFloors(b);
  assert.strictEqual(b.assign['FIRST FLOOR'].token, 'f1');
  assert.strictEqual(b.assign['FIRST FLOOR'].matchedBy, undefined);
  assert.strictEqual(b.assign['GROUND'].type, 'unassigned');
});

test('a read naming no floor is not part of the ordered set, and does not block it', () => {
  // SCHEDULES never becomes a target (it names no storey), so the remaining three still align.
  const b = bldg(['SCHEDULES', 'BASEMENT', 'GROUND', 'SECOND FLOOR'], FLOORS_012);
  assert.strictEqual(new ImportBulk({}).suggestFloors(b), 3);
  assert.strictEqual(b.assign['SCHEDULES'].type, 'unassigned');
  assert.strictEqual(b.assign['GROUND'].token, 'hq-floor-1');
});

// ---- the widened per-caption rungs on _resolveFloor ----

test('_resolveFloor matches a name across punctuation and case, but not across floors', () => {
  const bb = { nbFloors: [{ slug: 'x', name: 'Floor 1' }] };
  const r = new ImportBulk({})._resolveFloor(bb, { kind: 'loc', slug: 'other-l1', name: 'FLOOR-1' });
  assert.strictEqual(r.token, 'x');
  assert.strictEqual(r.matchedBy, undefined);          // a normalized name is still a name match
  assert.strictEqual(
    new ImportBulk({})._resolveFloor(bb, { kind: 'loc', slug: 'other-l2', name: 'Floor 2' }), null);
});

test('_resolveFloor carries a cross-building pick over a different naming system', () => {
  // The bulk "Apply to: all buildings" case: `Ground` picked in one building, resolved against
  // another whose floors are numbered from zero. Reported as an ordinal match, not a name one.
  const bb = { nbFloors: FLOORS_012 };
  const r = new ImportBulk({})._resolveFloor(bb, { kind: 'loc', slug: 'annex-gf', name: 'Ground' });
  assert.strictEqual(r.token, 'hq-floor-0');
  assert.strictEqual(r.matchedBy, 'ordinal');
});

test('_resolveFloor still reports a building with no matching floor as unresolved', () => {
  const bb = { nbFloors: [{ slug: 'r', name: 'Roof' }] };
  assert.strictEqual(
    new ImportBulk({})._resolveFloor(bb, { kind: 'loc', slug: 'x', name: 'Basement' }), null);
});

// ---- selectionMatcher: the unified assign row's "for ⟨selection⟩" vocabulary (IMPORT-50) ----

test('selectionMatcher("all") matches every drawing', () => {
  const m = ImportBulk.selectionMatcher('all');
  assert.ok(m({ assign: {} }, { stem: 'anything' }));
});

test('selectionMatcher("unassigned") matches exactly the type === "unassigned" cards', () => {
  // `unassigned` is the wizard's one "no answer yet" marker; a deliberate (none) is an answer
  // and must never be re-swept by the unassigned selection.
  const bb = { assign: { a: { type: 'unassigned' }, b: { type: 'none' }, c: { type: 'level' } } };
  const m = ImportBulk.selectionMatcher('unassigned');
  assert.ok(m(bb, { stem: 'a' }));
  assert.ok(!m(bb, { stem: 'b' }));
  assert.ok(!m(bb, { stem: 'c' }));
});

test('selectionMatcher("pages") matches the inclusive range, and never a page-less drawing', () => {
  const m = ImportBulk.selectionMatcher('pages', [2, 4]);
  assert.ok(!m({}, { stem: 'x', page: 1 }));
  assert.ok(m({}, { stem: 'x', page: 2 }));
  assert.ok(m({}, { stem: 'x', page: 4 }));
  assert.ok(!m({}, { stem: 'x', page: 5 }));
  // A whole-file drawing has no page number at all — no range may claim it.
  assert.ok(!m({}, { stem: 'x' }));
});

test('selectionMatcher("names") compiles the glob against the stem', () => {
  const m = ImportBulk.selectionMatcher('names', '*-L03-*');
  assert.ok(m({}, { stem: 'HQ-L03-PLAN' }));
  assert.ok(!m({}, { stem: 'HQ-L04-PLAN' }));
});

test('selectionMatcher("names") is null for an empty glob, so the caller can toast', () => {
  assert.strictEqual(ImportBulk.selectionMatcher('names', ''), null);
  assert.strictEqual(ImportBulk.selectionMatcher('names', '   '), null);
});

test('selectionMatcher is null for an unknown kind rather than matching nothing silently', () => {
  assert.strictEqual(ImportBulk.selectionMatcher('bogus'), null);
});
