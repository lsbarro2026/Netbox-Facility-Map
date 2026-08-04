'use strict';
/* import-match.test.js — ImportMatch: the filename-stem -> BUILDING scorer.

   Three parts. The first is ordinary unit coverage of the pieces the score is built from
   (tokenize / candidateKey / _jaroWinkler / _wordSim / prepare's IDF / the shortlist / the
   correction memory's memoryKey + recall). The second is the **corpus harness**: every case in
   fixtures/import-match-corpus.json is scored, so a change to the formula is measured against a
   realistic campus instead of eyeballed against whichever example came to mind. The third is the
   **session-replay harness** (IMPORT-22), which expands that same corpus into the flat pile a real
   import arrives as and replays it against a simulated operator — the only way to put a number on a
   feature that learns from *picks*, since a static filename corpus has none.
   See that file's `_readme` and ../README.md for how to read a failure. */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadClasses } = require('./load.js');
const corpus = require('./fixtures/import-match-corpus.json');

const { ImportMatch } = loadClasses(['import-match.js'], ['ImportMatch']);

/** Confidence tiers as an ordered scale, so a case can require "at least this confident".
 *  Mirrors ImportMatch._tier's vocabulary. */
const TIER_RANK = { none: 0, weak: 1, strong: 2, exact: 3 };
const atLeast = (got, want) => TIER_RANK[got] >= TIER_RANK[want];
/** The tiers the split step **prefills** (IMPORT-18) — the ones a wrong answer is dangerous in. */
const PREFILLS = (tier) => tier === 'exact' || tier === 'strong';

/** The candidate list indexed once, exactly as the split step uses it. */
const index = ImportMatch.prepare(corpus.candidates);
const bestOf = (stem) => ImportMatch.bestOf(stem, index);

/** One line describing what the matcher actually returned, for an assertion message. */
const describe = (r) => (r
  ? `${r.cand.slug} @ ${r.confidence} (score ${r.score.toFixed(3)}, margin ${r.margin.toFixed(3)})`
  : 'null');

// ---- tokenize: the stem's two signals ----

test('tokenize splits a stem into words and numeric building codes', () => {
  assert.deepStrictEqual(ImportMatch.tokenize('001-Admin-FL1'),
    { words: ['admin'], codes: [1] });
});

test('tokenize parses a zero-padded code to the same key as its bare form', () => {
  // '001' and '1' must be one key, or a slug-side '1' never meets a filename-side '001'.
  assert.deepStrictEqual(ImportMatch.tokenize('001-x').codes, ImportMatch.tokenize('1-x').codes);
});

test('tokenize drops floor and sheet markers but keeps a bare digit run', () => {
  // A bare number is the building-code signal this matcher exists to read, so it survives;
  // a floor/sheet-PREFIXED number can never name a building and is dropped outright.
  assert.deepStrictEqual(ImportMatch.tokenize('L2-FL01-LVL3-SHEET-PG4-B2'), { words: [], codes: [] });
  assert.deepStrictEqual(ImportMatch.tokenize('A101').codes, []);      // drawing-sheet number
  assert.deepStrictEqual(ImportMatch.tokenize('101').codes, [101]);    // building code
});

test('tokenize reads an explicit BLDG marker as a code, and a bare BLDG as noise', () => {
  assert.deepStrictEqual(ImportMatch.tokenize('BLDG7-L1'), { words: [], codes: [7] });
  assert.deepStrictEqual(ImportMatch.tokenize('Admin-Bldg'), { words: ['admin'], codes: [] });
});

test('tokenize drops stem noise words that would match every candidate equally', () => {
  for (const noise of ['plan', 'plans', 'floorplan', 'floorplans', 'asbuilt', 'dwg'])
    assert.deepStrictEqual(ImportMatch.tokenize(`Library-${noise}`).words, ['library'], noise);
});

test('tokenize is null-safe and case-folding', () => {
  assert.deepStrictEqual(ImportMatch.tokenize(null), { words: [], codes: [] });
  assert.deepStrictEqual(ImportMatch.tokenize(undefined), { words: [], codes: [] });
  assert.deepStrictEqual(ImportMatch.tokenize('LIBRARY').words, ['library']);
});

// ---- the sub-tokenizer: undelimited stems ----

test('tokenize decomposes an undelimited camelCase stem', () => {
  assert.deepStrictEqual(ImportMatch.tokenize('AdminBldg1FL2'), { words: ['admin'], codes: [1] });
  assert.deepStrictEqual(ImportMatch.tokenize('005ArchEnv'),
    { words: ['arch', 'env'], codes: [5] });
});

test('sub-splitting rejoins a digit run to the floor/building marker before it', () => {
  // The trap the rejoin exists for: split naively, `FL2` becomes floor-marker `fl` plus a bare `2`
  // that the classifier then reads as BUILDING 2 — inventing a code out of a floor number.
  assert.deepStrictEqual(ImportMatch.tokenize('AdminBldg1FL2').codes, [1]);
  assert.ok(!ImportMatch.tokenize('AdminBldg1FL2').codes.includes(2));
  // …but only for a marker. `Shop3` must still yield the word AND the code.
  assert.deepStrictEqual(ImportMatch.tokenize('Shop3'), { words: ['shop'], codes: [3] });
});

test('sub-splitting needs evidence, so a capitalized name is left whole', () => {
  // No digit and no marker piece: `McDonald` is one name, not `mc` + `donald`. Splitting it would
  // stop it matching the building it names.
  assert.deepStrictEqual(ImportMatch.tokenize('McDonald').words, ['mcdonald']);
  assert.deepStrictEqual(ImportMatch.tokenize('PowerPlant').words, ['powerplant']);
});

test('a whole-token class still wins over sub-splitting', () => {
  // `A101` is a drawing-sheet number. Classification runs on the whole token FIRST, which is what
  // keeps it from becoming `a` + building `101`.
  assert.deepStrictEqual(ImportMatch.tokenize('A101'), { words: [], codes: [] });
  assert.deepStrictEqual(ImportMatch.tokenize('BLDG7'), { words: [], codes: [7] });
});

// ---- candidateKey: the building's side ----

test('candidateKey reads both name and slug, deduped', () => {
  const k = ImportMatch.candidateKey({ name: 'Administration', slug: 'bldg-001' });
  assert.deepStrictEqual(k.words, ['administration', 'bldg']);
  assert.deepStrictEqual(k.codes, [1]);
  assert.strictEqual(k.slug, 'bldg-001');
});

test('candidateKey does NOT filter the way a stem is filtered', () => {
  // A building genuinely named "Level Building" must keep those words — they are only noise
  // when they appear in a *filename*.
  const k = ImportMatch.candidateKey({ name: 'Level Building', slug: 'lvl-bldg' });
  assert.ok(k.words.includes('level') && k.words.includes('building'), k.words.join(','));
});

test('candidateKey tolerates a candidate missing either field', () => {
  assert.deepStrictEqual(ImportMatch.candidateKey({ name: 'Library' }).words, ['library']);
  assert.deepStrictEqual(ImportMatch.candidateKey({}).words, []);
});

test('candidateKey offers both acronym forms of a name with a generic tail', () => {
  const k = ImportMatch.candidateKey({ name: 'Engineering Science Building', slug: 'bldg-014' });
  assert.deepStrictEqual(k.initials.sort(), ['es', 'esb']);
});

test('an initialism is built from the name only, never the slug', () => {
  // A slug's `bldg` segment would give every building on the campus an acronym starting with `b`.
  const k = ImportMatch.candidateKey({ name: 'Dining Commons', slug: 'bldg-047' });
  assert.deepStrictEqual(k.initials, ['dc']);
});

test('a one-word name has no initialism worth having', () => {
  assert.deepStrictEqual(ImportMatch.candidateKey({ name: 'Library', slug: 'bldg-002' }).initials, []);
});

// ---- Jaro-Winkler and the similarity floor ----

test('_jaro matches its textbook values', () => {
  assert.strictEqual(ImportMatch._jaro('abc', 'abc'), 1);
  assert.strictEqual(ImportMatch._jaro('abc', 'xyz'), 0);
  assert.strictEqual(ImportMatch._jaro('', 'abc'), 0);
  // The canonical worked example: jaro("martha","marhta") = 0.9444…
  assert.ok(Math.abs(ImportMatch._jaro('martha', 'marhta') - 0.94444) < 0.0005);
});

test('_jaroWinkler adds a shared-prefix bonus, capped at four characters', () => {
  // jw("martha","marhta") = 0.9444 + 3*0.1*(1-0.9444) = 0.9611
  assert.ok(Math.abs(ImportMatch._jaroWinkler('martha', 'marhta') - 0.96111) < 0.0005);
  // The bonus is gated on the pair already being similar: below a Jaro of 0.7 it is not applied at
  // all, however long the shared prefix. Otherwise a two-letter fragment would ride its prefix up.
  const far = 'ab' + 'c'.repeat(30);
  assert.ok(ImportMatch._jaro('ab', far) < 0.7);
  assert.strictEqual(ImportMatch._jaroWinkler('ab', far), ImportMatch._jaro('ab', far));
});

test('_wordSim keeps the abbreviation and containment rungs as floors', () => {
  assert.strictEqual(ImportMatch._wordSim('library', 'library'), 1);
  assert.strictEqual(ImportMatch._wordSim('admin', 'administration'), 0.9);  // prefix >= 3 chars
  assert.strictEqual(ImportMatch._wordSim('side', 'residence'), 0.8);        // re[side]nce
});

test('_wordSim scores a typo through Jaro-Winkler', () => {
  // The rung the old prefix/containment-only formula had no answer for: a single dropped letter is
  // neither a prefix relation nor a containment, so it used to score ZERO and the stem returned
  // nothing at all. Jaro-Winkler is the whole reason this now clears the floor.
  const [a, b] = ['adminstration', 'administration'];
  assert.ok(!b.startsWith(a) && !b.includes(a), 'the structural rungs must not be what rescues it');
  assert.ok(ImportMatch._wordSim(a, b) >= ImportMatch.SIM_FLOOR,
    `expected the typo to clear SIM_FLOOR, got ${ImportMatch._wordSim(a, b)}`);
});

test('_wordSim rejects a merely similar-looking pair', () => {
  // This is the precision guard, not a detail: raw Jaro-Winkler rates north/south at ~0.73, and
  // without the floor the twin `Residence Hall North`/`South` stop being separable at all.
  assert.ok(ImportMatch._jaroWinkler('north', 'south') > 0.7);
  assert.strictEqual(ImportMatch._wordSim('north', 'south'), 0);
  assert.strictEqual(ImportMatch._wordSim('east', 'west'), 0);
});

test('_wordSim enforces the minimum-length floors', () => {
  // A 2-char prefix and a 3-char infix are both below their floor, so neither scores — this is
  // what keeps a short fragment from matching a whole campus.
  assert.strictEqual(ImportMatch._wordSim('ad', 'administration'), 0);
  assert.strictEqual(ImportMatch._wordSim('ide', 'residence'), 0);
  assert.strictEqual(ImportMatch._wordSim('adm', 'administration'), 0.9);   // exactly the floor
});

test('_wordSim is symmetric in its arguments', () => {
  assert.strictEqual(ImportMatch._wordSim('admin', 'administration'),
    ImportMatch._wordSim('administration', 'admin'));
});

// ---- prepare: the IDF index ----

test('prepare weights a rare candidate word above a common one', () => {
  // The whole point of indexing the real candidate list: `hall` names five buildings on this
  // campus and `astronomy` names one, so they must not weigh the same.
  assert.ok(index.wordIdf.get('astronomy') > index.wordIdf.get('hall'),
    `astronomy ${index.wordIdf.get('astronomy')} should outweigh hall ${index.wordIdf.get('hall')}`);
  // A word no building carries is the most informative of all — that is what makes an unexplained
  // stem word cost score rather than merely fail to add any.
  assert.ok(index.maxIdf > index.wordIdf.get('astronomy'));
});

test('prepare keeps the caller shape intact on each entry', () => {
  // The caller's own object rides along on `.cand`, so a Site and a building Location can both
  // be matched by the same call.
  const mine = { name: 'Library', slug: 'bldg-002', myOwnField: 42 };
  const [entry] = ImportMatch.prepare([mine]).entries;
  assert.strictEqual(entry.cand, mine);
  assert.strictEqual(entry.key.slug, 'bldg-002');
});

test('prepare tolerates an empty or absent candidate list', () => {
  for (const arg of [[], null, undefined]) {
    const idx = ImportMatch.prepare(arg);
    assert.strictEqual(idx.n, 0);
    assert.strictEqual(ImportMatch.bestOf('Library-L1', idx), null);
  }
});

// ---- stemOf / bestOf contracts ----

test('stemOf strips only the final extension', () => {
  assert.strictEqual(ImportMatch.stemOf('001-Admin-FL1.pdf'), '001-Admin-FL1');
  assert.strictEqual(ImportMatch.stemOf('plan.v2.dwg'), 'plan.v2');
  assert.strictEqual(ImportMatch.stemOf('noext'), 'noext');
  assert.strictEqual(ImportMatch.stemOf(null), '');
});

test('bestOf returns null for an absent index', () => {
  assert.strictEqual(ImportMatch.bestOf('Library-L1', null), null);
  assert.strictEqual(ImportMatch.bestOf('Library-L1', undefined), null);
});

test('bestOf returns null for a stem carrying no building signal at all', () => {
  assert.strictEqual(bestOf(''), null);
  assert.strictEqual(bestOf(null), null);
});

test('bestOf normalizes its score into 0..1 so filenames are comparable', () => {
  // The property the old additive score could not have, and the reason a threshold can exist:
  // a long filename must not outscore a short precise one just by being long.
  for (const c of corpus.matches) {
    const r = bestOf(c.stem);
    if (!r) continue;
    assert.ok(r.score > 0 && r.score <= 1, `${c.stem} scored ${r.score}`);
    assert.ok(r.margin >= 0 && r.margin <= 1, `${c.stem} margin ${r.margin}`);
  }
});

test('bestOf reports the gap to the runner-up as its margin', () => {
  // A sole scoring candidate has nothing to be confused with, so its margin is its whole score…
  assert.strictEqual(bestOf('Astronomy-Observatory-L1').margin, 1);
  // …while a stem three siblings explain identically has no margin at all, and is demoted for it.
  const twin = bestOf('Residence-Hall-FL3');
  assert.strictEqual(twin.margin, 0);
  assert.strictEqual(twin.confidence, 'weak');
});

test('a code-only hit can never reach the prefill bar', () => {
  // It normalizes to a perfect 1.0 — the guard is structural, not a threshold, because a bare
  // number in a filename is as often a sheet number as a building code.
  const r = bestOf('BLDG14-L2');
  assert.strictEqual(r.score, 1);
  assert.strictEqual(r.confidence, 'weak');
});

test('the exact rung is exempt from the margin demotion', () => {
  // "Business Administration Building" scores as highly on the one-word stem `Administration`,
  // leaving no margin — but the literal answer is not made worse by a candidate that merely
  // CONTAINS it, so `exact` stands.
  const r = bestOf('Administration-L1');
  assert.strictEqual(r.margin, 0);
  assert.strictEqual(r.confidence, 'exact');
  assert.strictEqual(r.cand.slug, 'bldg-001');
});

// ---- the shortlist: large-candidate-list behaviour ----

test('a large candidate list finds the same winner an exhaustive scan does', () => {
  // Past EXHAUSTIVE_MAX, bestOf narrows by inverted index before running the character-level
  // comparator. Pad the corpus past that bound with filler and assert the shortlist still
  // surfaces the same answers — an approximation that loses the winner would be silent.
  const filler = [];
  for (let i = 0; filler.length + corpus.candidates.length <= ImportMatch.EXHAUSTIVE_MAX * 2; i++)
    filler.push({ name: `Storage Unit ${i}`, slug: `filler-${900 + i}` });
  const big = ImportMatch.prepare([...corpus.candidates, ...filler]);
  assert.ok(big.n > ImportMatch.EXHAUSTIVE_MAX);
  for (const c of corpus.matches) {
    if (c.knownGap) continue;
    const r = ImportMatch.bestOf(c.stem, big);
    assert.ok(r && r.cand.slug === c.want,
      `${c.stem}: shortlisted scan got ${describe(r)}, wanted ${c.want}`);
  }
});

test('the shortlist path still refuses an ambiguous stem', () => {
  const filler = [];
  for (let i = 0; i <= ImportMatch.EXHAUSTIVE_MAX; i++)
    filler.push({ name: `Storage Unit ${i}`, slug: `filler-${900 + i}` });
  const big = ImportMatch.prepare([...corpus.candidates, ...filler]);
  for (const c of corpus.ambiguous) {
    const r = ImportMatch.bestOf(c.stem, big);
    assert.ok(r === null || !PREFILLS(r.confidence),
      `"${c.stem}" reached ${describe(r)} on the shortlist path`);
  }
});

// ---- the correction memory: memoryKey / recall (IMPORT-22) ----

test('sibling drawings of one building share a memory key', () => {
  // The shape the memory exists for: a flat pile is one file per FLOOR, and the floor marker is
  // already dropped by `tokenize`, so every floor of one building arrives as the same key.
  const k = ImportMatch.memoryKey('001-Admin-FL1');
  assert.strictEqual(ImportMatch.memoryKey('001-Admin-FL2'), k);
  assert.strictEqual(ImportMatch.memoryKey('001-Admin-Basement'), k);
  assert.strictEqual(ImportMatch.memoryKey('A101-001-Admin-L7'), k);   // sheet number drops too
});

test('a memory key ignores case, punctuation and token order', () => {
  // None of these distinguish two drawings of one building, and treating any of them as a
  // difference would split that building's pile into keys that never meet.
  const k = ImportMatch.memoryKey('Health-Center-L1');
  assert.strictEqual(ImportMatch.memoryKey('health center l2'), k);
  assert.strictEqual(ImportMatch.memoryKey('CENTER_HEALTH.L3'), k);
  assert.strictEqual(ImportMatch.memoryKey('Health  Health Center FL4'), k);   // a repeat is one word
});

test('a differing code or word yields a DIFFERENT memory key', () => {
  // The precision guard, and the reason the rung is identical-key only: `Shop 3` and `Shop 5` are
  // two buildings, and so are `Residence Hall North` and `South`. A looser rung — containment,
  // "similar enough" — would let one hand-pick answer for the other, which is exactly the silent
  // re-anchor this must never do.
  assert.notStrictEqual(ImportMatch.memoryKey('Shop-3-FL1'), ImportMatch.memoryKey('Shop-5-FL1'));
  assert.notStrictEqual(ImportMatch.memoryKey('Residence-Hall-North-FL1'),
    ImportMatch.memoryKey('Residence-Hall-South-FL1'));
  // A stem that says strictly LESS is still a different key — it has not said the same thing.
  assert.notStrictEqual(ImportMatch.memoryKey('001-Admin-FL1'), ImportMatch.memoryKey('Admin-FL1'));
});

test('a stem with no signal has no memory key, and never recalls', () => {
  // An unreadable filename must not recall anything — and must not become a key that every other
  // unreadable filename collides with.
  for (const stem of ['', 'FL1', '---', null, undefined])
    assert.strictEqual(ImportMatch.memoryKey(stem), null, `"${stem}" produced a key`);
  const memory = new Map([[null, { folder: 'x', label: 'X' }]]);
  assert.strictEqual(ImportMatch.recall('FL1', memory), null);
});

test('recall returns the caller\'s own opaque value, and null on a miss', () => {
  // The destination is never inspected here, which is what lets a HAND-ADDED building — one with no
  // NetBox row, so one the filename matcher can never propose — recall exactly like an existing one.
  const dest = { folder: 'old-gym', label: 'Old Gym' };
  const memory = new Map([[ImportMatch.memoryKey('OldGym-FL1'), dest]]);
  assert.strictEqual(ImportMatch.recall('OldGym-FL2', memory), dest);
  assert.strictEqual(ImportMatch.recall('Library-FL2', memory), null);
});

test('recall is null-safe on an absent or empty memory', () => {
  for (const memory of [null, undefined, new Map()])
    assert.strictEqual(ImportMatch.recall('Library-L1', memory), null);
});

test('a remembered pick answers for a stem the filename scorer is confident about', () => {
  // The correction case, from the matcher's side: `Library-Floor2` is an `exact` filename match, and
  // the operator has nonetheless said this pile belongs to the Health Center. The split step prefers
  // the recall precisely BECAUSE the scorer was confident — a confident pass gets a whole building's
  // floors wrong together, and having to say so once per floor is the chore this closes.
  const dest = { folder: 'bldg-008', label: 'Health Center' };
  const memory = new Map([[ImportMatch.memoryKey('Library-Floor1'), dest]]);
  assert.strictEqual(bestOf('Library-Floor2').confidence, 'exact');
  assert.strictEqual(ImportMatch.recall('Library-Floor2', memory), dest);
});

// ---- the corpus harness ----

test('corpus: every case with one right answer resolves to it', () => {
  const failures = [];
  for (const c of corpus.matches) {
    if (c.knownGap) continue;                       // inventoried separately, below
    const r = bestOf(c.stem);
    if (!r || r.cand.slug !== c.want || !atLeast(r.confidence, c.minTier))
      failures.push(`  ${c.stem}\n      want ${c.want} @ >=${c.minTier}\n      got  ${describe(r)}\n      (${c.note})`);
  }
  assert.strictEqual(failures.length, 0,
    `${failures.length} corpus case(s) regressed:\n${failures.join('\n')}`);
});

test('corpus: an ambiguous stem never reaches the bulk-prefill bar', () => {
  // The split step prefills `exact`/`strong` and never `weak`. A stem that genuinely does not say
  // which building it means must therefore come back null or weak — mis-assigning a building
  // silently re-anchors every floor key beneath it (§10 foundations).
  for (const c of corpus.ambiguous) {
    const r = bestOf(c.stem);
    assert.ok(r === null || !PREFILLS(r.confidence),
      `"${c.stem}" reached ${describe(r)} — it must stay out of the automatic path.\n  (${c.note})`);
  }
});

test('corpus: known gaps are still gaps', () => {
  // The wish list, asserted from the other side. When a scoring change CLOSES one of these, this
  // test fails on purpose — that failure is the measurement. Drop `knownGap` from the case (and
  // tighten its `minTier` to what the matcher now achieves) to bank the improvement.
  const closed = [];
  for (const c of corpus.matches.filter(x => x.knownGap)) {
    const r = bestOf(c.stem);
    if (r && r.cand.slug === c.want && atLeast(r.confidence, c.minTier))
      closed.push(`  ${c.stem} -> ${describe(r)}  (wanted ${c.want} @ >=${c.minTier})`);
  }
  assert.strictEqual(closed.length, 0,
    `${closed.length} known gap(s) now MATCH — this is good news, not a bug.\n`
    + `Remove "knownGap": true from these cases in fixtures/import-match-corpus.json:\n`
    + closed.join('\n'));
});

test('corpus: scorecard', () => {
  // Not a pass/fail bar — printed accuracy numbers, so a scoring rework can be compared before and
  // after on the same corpus rather than argued about. Run with `node --test` to see it.
  //
  // **Precision is the number that matters**, and it is reported separately for exactly that
  // reason: a formula that matches three more filenames and prefills one wrong building is a
  // REGRESSION, because a wrong building silently re-anchors every floor key beneath it.
  const total = corpus.matches.length;
  const hits = corpus.matches.filter(c => {
    const r = bestOf(c.stem);
    return r && r.cand.slug === c.want && atLeast(r.confidence, c.minTier);
  }).length;
  const gaps = corpus.matches.filter(c => c.knownGap).length;

  // Precision at the auto-accept tier, over the whole corpus: of everything the split step would
  // prefill without being asked, how much of it is right?
  let prefilled = 0, prefilledRight = 0;
  for (const c of corpus.matches) {
    const r = bestOf(c.stem);
    if (r && PREFILLS(r.confidence)) { prefilled++; if (r.cand.slug === c.want) prefilledRight++; }
  }
  // An `ambiguous` case has no right answer at all, so anything prefilled from one is wrong.
  for (const c of corpus.ambiguous) {
    const r = bestOf(c.stem);
    if (r && PREFILLS(r.confidence)) prefilled++;
  }
  const byTier = {};
  for (const c of corpus.matches) {
    const r = bestOf(c.stem);
    byTier[r ? r.confidence : 'none'] = (byTier[r ? r.confidence : 'none'] || 0) + 1;
  }
  const pct = (a, b) => (b ? (100 * a / b).toFixed(0) : '—') + '%';
  console.log(`    ImportMatch scorecard over ${corpus.candidates.length} candidates: `
    + `${hits}/${total} matched (${pct(hits, total)}), ${gaps} known gap(s); `
    + `tiers ${JSON.stringify(byTier)}`);
  console.log(`      auto-accept precision ${prefilledRight}/${prefilled} (${pct(prefilledRight, prefilled)}), `
    + `coverage ${prefilled}/${total + corpus.ambiguous.length} stems prefilled`);

  // Precision at the prefill tier is the one property this corpus exists to hold at 100%.
  assert.strictEqual(prefilledRight, prefilled,
    'a prefilled proposal was wrong — that is the failure mode this corpus exists to catch');
  // The corpus must stay honest: the hit count and the gap count account for every case.
  assert.strictEqual(hits + gaps, total,
    'a case is neither matching nor marked knownGap — the corpus has drifted from reality');
});

// ---- the collective evidence pass: bestOfAll (IMPORT-21) ----

test('bestOfAll answers every stem exactly as bestOf does when the pile says nothing', () => {
  // The floor under the whole batch pass: a pile with no collective evidence to offer must return
  // precisely what scoring one filename at a time returns. The corpus's `ambiguous` stems are in
  // here too, so this also asserts the batch never *creates* a confident answer out of company.
  const stems = [...corpus.matches.map(c => c.stem), ...corpus.ambiguous.map(c => c.stem)];
  const batch = ImportMatch.bestOfAll(stems, index);
  for (const stem of stems) {
    const alone = bestOf(stem), together = batch.get(stem);
    if (!alone || !together) {
      assert.strictEqual(!!together, !!alone, `"${stem}": batch ${describe(together)} vs ${describe(alone)}`);
      continue;
    }
    assert.strictEqual(together.cand.slug, alone.cand.slug, `"${stem}" changed building in a batch`);
    assert.strictEqual(together.confidence, alone.confidence,
      `"${stem}" changed tier in a batch: ${describe(together)} vs ${describe(alone)}`);
  }
});

test('bestOfAll is null-safe on an empty pile, an empty index and junk stems', () => {
  assert.strictEqual(ImportMatch.bestOfAll([], index).size, 0);
  assert.strictEqual(ImportMatch.bestOfAll(null, index).size, 0);
  for (const idx of [null, undefined, ImportMatch.prepare([])])
    assert.strictEqual(ImportMatch.bestOfAll(['Library-L1'], idx).get('Library-L1'), null);
  const junk = ImportMatch.bestOfAll([null, undefined, '', 'FL2'], index);
  for (const [, r] of junk) assert.strictEqual(r, null);
});

test('bestOfAll dedupes a repeated stem rather than counting it twice as evidence', () => {
  // Two files can share a stem, and the answer is a property of the stem. It matters beyond tidiness:
  // the corroboration quorum counts stems, so one filename listed twice must not reach it alone.
  const once = ImportMatch.bestOfAll(['001-Admin-FL1', '001-A101'], index);
  const twice = ImportMatch.bestOfAll(['001-Admin-FL1', '001-Admin-FL1', '001-A101'], index);
  assert.strictEqual(twice.size, 2);
  assert.strictEqual(twice.get('001-A101').confidence, once.get('001-A101').confidence);
});

/** Score one fixture group as the split step would — the whole pile in one call. */
const runGroup = (g) => ImportMatch.bestOfAll(g.stems.map(s => s.stem), index);

test('groups: every pile resolves the way its rows say it should', () => {
  const failures = [];
  for (const g of corpus.groups) {
    const got = runGroup(g);
    for (const s of g.stems) {
      const r = got.get(s.stem);
      const bad = s.want === null
        ? (r && PREFILLS(r.confidence) && 'must not prefill')
        : (!r || r.cand.slug !== s.want ? `want ${s.want}` : null)
          || (!atLeast(r.confidence, s.minTier) ? `want >=${s.minTier}` : null)
          || (s.maxTier && TIER_RANK[r.confidence] > TIER_RANK[s.maxTier] ? `want <=${s.maxTier}` : null);
      if (bad) failures.push(`  [${g.name}] ${s.stem}\n      ${bad}\n      got  ${describe(r)}`);
    }
  }
  assert.strictEqual(failures.length, 0,
    `${failures.length} group case(s) failed:\n${failures.join('\n')}`);

  // What the pass is worth, printed rather than asserted — the same way the scorecard and the
  // session replay are, so a change to the evidence rules is compared instead of argued about.
  let rows = 0, lifted = 0, held = 0;
  for (const g of corpus.groups) {
    const got = runGroup(g);
    for (const s of g.stems) {
      rows++;
      const alone = bestOf(s.stem), r = got.get(s.stem);
      if (r && PREFILLS(r.confidence) && !(alone && PREFILLS(alone.confidence))) lifted++;
      else if (s.want === null) held++;
    }
  }
  console.log(`    collective evidence over ${corpus.groups.length} pile(s), ${rows} rows: `
    + `${lifted} row(s) lifted into a prefill by their pile, ${held} held back from one`);
});

test('groups: nothing a pile prefills points at the wrong building', () => {
  // The corpus's precision bar, restated for the batch. It is the bar that matters most here: the
  // collective pass exists to prefill MORE, and a wrong building silently re-anchors every floor key
  // beneath it (§10 foundations).
  for (const g of corpus.groups) {
    const got = runGroup(g);
    for (const s of g.stems) {
      const r = got.get(s.stem);
      if (!r || !PREFILLS(r.confidence)) continue;
      assert.ok(s.want !== null && r.cand.slug === s.want,
        `[${g.name}] "${s.stem}" prefilled ${describe(r)}, wanted ${s.want}\n  (${s.note || g.note})`);
    }
  }
});

test('groups: a pile only ever raises confidence, and never redirects a confident row', () => {
  // Scoring in company must be an addition of evidence, so a tier may never fall: the step's answers
  // must not depend on which drawings happened to be uploaded together.
  //
  // The building may only move for a row that was **weak** alone — and there it genuinely can, which
  // is worth knowing rather than asserting away. Each stem word is weighted by the IDF of the
  // candidate token it matched, so a shared unexplained cost is not a shared *factor*: dropping it
  // re-ranks near-tied candidates (`Building 000-0_Center` leads with `Central Plant` alone, whose
  // rare `central` partly absorbs that cost, and lands on the tied literal `Center`s once it is
  // waived). Both readings are weak, which is the point — nothing the step acts on moved.
  for (const g of corpus.groups) {
    const got = runGroup(g);
    for (const s of g.stems) {
      const alone = bestOf(s.stem), r = got.get(s.stem);
      if (!alone) continue;
      assert.ok(TIER_RANK[r.confidence] >= TIER_RANK[alone.confidence],
        `[${g.name}] "${s.stem}" was downgraded in company: ${describe(r)} vs ${describe(alone)}`);
      if (PREFILLS(alone.confidence))
        assert.strictEqual(r.cand.slug, alone.cand.slug,
          `[${g.name}] "${s.stem}" redirected a CONFIDENT row: ${describe(r)} vs ${describe(alone)}`);
    }
  }
});

test('groups: a row the pile lifted says so, and one it did not stays quiet', () => {
  // `corroborated` is what lets the row tell the operator that the BATCH is why it was filled in —
  // so it has to be on exactly the rows the fixture marks, and on no others.
  for (const g of corpus.groups) {
    const got = runGroup(g);
    for (const s of g.stems)
      assert.strictEqual(!!(got.get(s.stem) || {}).corroborated, !!s.corroborated,
        `[${g.name}] "${s.stem}": corroborated flag disagrees with the fixture`);
  }
});

test('groups: the collective pass survives the shortlist path', () => {
  // Past EXHAUSTIVE_MAX the winner is found through the inverted index rather than an exhaustive
  // scan, and the batch re-resolves through that same path. An approximation that lost a pile's
  // evidence would be silent.
  const filler = [];
  for (let i = 0; i <= ImportMatch.EXHAUSTIVE_MAX; i++)
    filler.push({ name: `Storage Unit ${i}`, slug: `filler-${900 + i}` });
  const big = ImportMatch.prepare([...corpus.candidates, ...filler]);
  assert.ok(big.n > ImportMatch.EXHAUSTIVE_MAX);
  for (const g of corpus.groups) {
    const got = ImportMatch.bestOfAll(g.stems.map(s => s.stem), big);
    for (const s of g.stems) {
      const r = got.get(s.stem);
      if (s.want === null) {
        assert.ok(!r || !PREFILLS(r.confidence),
          `[${g.name}] "${s.stem}" reached ${describe(r)} on the shortlist path`);
      } else {
        assert.ok(r && r.cand.slug === s.want,
          `[${g.name}] "${s.stem}": shortlisted batch got ${describe(r)}, wanted ${s.want}`);
      }
    }
  }
});

test('a weak row is never read as evidence about the pile', () => {
  // The quorum counts CONFIDENT stems only. Letting a weak one vote would let a pile talk itself into
  // an answer: the rows being decided would be the rows doing the deciding.
  const weakOnly = ImportMatch.bestOfAll(['Shop-5-L1', 'Shop-5-L2', 'Shop-5-L3'], index);
  for (const [, r] of weakOnly) assert.ok(!PREFILLS(r.confidence), describe(r));
});

test('the pile\'s sheet numbers stop costing, without rescuing an unexplained WORD', () => {
  // The two halves of the waiver, side by side. `0` is demonstrably a sheet index here, so it stops
  // costing — but `annex` names a building that is not in NetBox, and no amount of company explains
  // that away. An unexplained word is a real objection; an unexplained convention number is not.
  const got = ImportMatch.bestOfAll([
    'Building 001-0_Administration', 'Building 002-0_Library', 'Building 005-0_Admin-Annex',
  ], index);
  assert.ok(!PREFILLS(got.get('Building 005-0_Admin-Annex').confidence),
    `the annex prefilled: ${describe(got.get('Building 005-0_Admin-Annex'))}`);
});

// ---- the session-replay harness (IMPORT-22) ----

/** One import session's worth of rows, in the order the split step lists them: each corpus case
 *  expanded into the **three floor variants** a real flat pile arrives as. That expansion is the
 *  whole point — a pile is one file per floor, so the same question is asked once per floor, and
 *  what the memory is worth is exactly how many of those repeats it answers.
 *
 *  `matches` carry their own truth. An `ambiguous` case has none by construction, so it gets a fixed
 *  synthetic one: the claim being measured there isn't *which* building is right (nothing can say),
 *  only that one operator answer settles its two siblings. */
const SESSION = (() => {
  const cases = [
    ...corpus.matches.map(c => ({ stem: c.stem, truth: c.want })),
    ...corpus.ambiguous.map((c, i) =>
      ({ stem: c.stem, truth: corpus.candidates[i % corpus.candidates.length].slug })),
  ];
  const rows = [];
  for (const c of cases)              // siblings adjacent, as a filename-sorted pile lists them
    for (const floor of ['FL1', 'FL2', 'FL3']) rows.push({ stem: `${c.stem}-${floor}`, truth: c.truth });
  return rows;
})();

/** Replay a session against a simulated operator, and count what it cost them.
 *
 *  The rules mirror `ImportFlow._stepAssignBuildings` exactly: the memory outranks the filename
 *  proposal; a confident filename match is accepted when right and corrected when wrong; anything
 *  else is a hand-pick. **Only the operator's own answers are learned** — an automatic prefill
 *  teaches nothing, which is what stops a wrong guess propagating itself across a building. */
const replay = (useMemory) => {
  const memory = new Map();
  let picks = 0, recalled = 0, recalledWrong = 0;
  for (const row of SESSION) {
    const hit = useMemory ? ImportMatch.recall(row.stem, memory) : null;
    if (hit) { recalled++; if (hit.slug !== row.truth) recalledWrong++; continue; }
    const m = bestOf(row.stem);
    if (m && PREFILLS(m.confidence) && m.cand.slug === row.truth) continue;   // prefilled, and right
    picks++;                                                                 // the operator answers
    if (useMemory) memory.set(ImportMatch.memoryKey(row.stem), { slug: row.truth });
  }
  return { picks, recalled, recalledWrong };
};

test('session replay: learning from picks cuts the operator\'s work, and stays right', () => {
  // The offline measurement this feature needed before it could be built: a filename corpus can't
  // score a memory, but a *session* over one can — replay the same pile twice and count hand-picks.
  const without = replay(false), withMemory = replay(true);
  const saved = without.picks - withMemory.picks;
  // The harness's own floor, reported so the saving reads honestly: a stem carrying no signal at all
  // (a bare sheet number, a bare floor marker) has no key, so it can never be learned OR recalled —
  // those rows stay hand-picks in both arms by design, and are not a shortfall to go chasing.
  const unlearnable = SESSION.filter(r => ImportMatch.memoryKey(r.stem) === null).length;
  const pct = (a, b) => (b ? (100 * a / b).toFixed(0) : '—') + '%';
  console.log(`    correction-memory replay over ${SESSION.length} rows `
    + `(${SESSION.length / 3} drawings x 3 floors): ${without.picks} hand-picks without memory, `
    + `${withMemory.picks} with (${saved} saved, ${pct(saved, without.picks)});`);
  console.log(`      ${withMemory.recalled} rows filled from an earlier pick, `
    + `${withMemory.recalledWrong} of them wrong; ${unlearnable} row(s) have no key to learn from`);

  // Precision first: a recalled building is prefilled, and a wrong one silently re-anchors every
  // `Room.floor_key` beneath it (§10 foundations). This is the bar, not the saving.
  assert.strictEqual(withMemory.recalledWrong, 0,
    'a recalled building was wrong — the identical-key rung is supposed to make that impossible');
  // …and the saving has to be real, or the feature is only risk.
  assert.ok(saved > 0,
    `the memory saved no hand-picks (${without.picks} -> ${withMemory.picks})`);
  // The memory never *adds* work: it only ever answers a question the operator would have been asked.
  assert.ok(withMemory.picks <= without.picks);
});
