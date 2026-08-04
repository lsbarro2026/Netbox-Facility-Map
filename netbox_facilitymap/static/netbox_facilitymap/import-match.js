'use strict';
/* import-match.js — ImportMatch: filename-stem → NetBox **building** matching (TOPO-5).
   A pure static utility (like ImportPreview/Geom/DeviceShapes) with no wizard state — it takes a
   drawing's filename and a list of candidate buildings and returns a ranked proposal:
     - tokenize(stem)               → {words, codes} for a drawing stem
     - candidateKey(cand)           → {words, codes, initials, slug, name} for one NetBox building
     - prepare(candidates)          → an IDF-weighted index over one candidate list
     - bestOf(stem, index)          → {cand, confidence, score, margin} | null
     - bestOfAll(stems, index)      → the same, for a whole pile at once, with the pile's own
                                      collective evidence folded in (IMPORT-21)
     - memoryKey(stem)              → the identity sibling drawings of one building share, or null
     - recall(stem, memory)         → the caller's own earlier answer for such a sibling (IMPORT-22)

   `prepare` is separate from `bestOf` because the caller matches *many* stems against *one*
   candidate list: the index depends only on the candidates, so building it per filename would
   re-tokenize a campus-sized list once per drawing.

   Why it exists: a flat pile of one-file-per-floor drawings has to be split into buildings before
   anything else can happen (`ImportOrganize.open`), and on a campus with a hundred-odd
   buildings that is a hundred-odd hand picks. `ImportBind._confidentMatch` can't help — it is
   exact-slug/exact-name/sole-result and only ever runs on a *folder* name, so a real drawing like
   `001-Admin-FL1.pdf` against `name="Administration", slug="slo-bldg-001"` matches nothing. That
   matcher deliberately stays as it is (IMPORT-20): it binds a folder to an **anchor**, where the
   folder token was authored by the regroup step as a slug, so a fuzzy answer there would
   mis-*anchor* a building rather than mis-*propose* one.

   **How it scores (IMPORT-20).** The shape is Soft-TFIDF / generalized Monge-Elkan: each stem token
   takes its *best* match on the candidate side under a soft character-level similarity, weighted by
   that token's inverse document frequency over the actual candidate list, and the total is
   **divided by the summed weights**. Three properties follow, each fixing a named weakness of the
   integer 3-rung formula this replaced:
     - the result is **0..1 and comparable between filenames**, so a threshold can exist at all — a
       long filename no longer outscores a short precise one;
     - IDF **learns the campus's own noise words**: `hall`, `center`, `north`, `building` demote
       themselves with no stoplist to maintain, and a numeric code carried by eight buildings
       weighs less than one carried by a single building;
     - a stem word the candidate can't explain **costs** score, which is the smooth form of the old
       structural "every stem word explained" rule.
   Ambiguity is then a **margin** between the top two candidates, not an exact-tie test.

   Deliberately distinct from `ImportBulk`'s glob matchers (`globMatcher`/`floorPatternMatcher`/
   `floorNumber`), which map a filename to a **floor**. Same tokenizing idiom, opposite axis: this
   one names the *building*, and the two must not be conflated — a drawing carries both signals.

   Everything here is a **proposal** — a tier, never a decision. What the caller may do with each
   tier is the split step's rule, not this file's: `exact`/`strong` are the bar it prefills at
   (visibly, reversibly — IMPORT-18), `weak` is offered per row and never applied in bulk, because
   a wrong building assignment silently re-anchors a whole building's floor keys (§10
   foundations). Don't lower that bar to `weak` — the margin demotion in `bestOf` is what protects
   it. */

class ImportMatch {
  /** Tokens that name a floor, a level or a sheet rather than a building. Matched against a whole
   *  token, optionally followed by digits — so `L2`/`FL01`/`LVL2`/`SHEET`/`SH3`/`PG4` are floor or
   *  sheet markers. `B2` is read as a *basement*, not "building 2": in a floor-plan filename that
   *  is overwhelmingly the common meaning, and the explicit `BLDG2` spelling below covers the
   *  other. A bare digit run is deliberately NOT here — it is the building-code signal this
   *  matcher exists to read. */
  static FLOOR_TOKEN = /^(?:l|lv|lvl|lev|level|f|fl|flr|floor|b|bsmt|basement|sh|sheet|s|pg|p|page|dwg|rev)\d*$/;
  static SHEET_TOKEN = /^[a-z]{1,2}\d{2,}$/;          // a drawing-sheet number: A101, M203, …
  static BUILDING_TOKEN = /^(?:bldg|bld|blg|building)(\d*)$/;   // an explicit building marker

  /** Words that appear in drawing filenames without saying *which* building — a stem's own noise.
   *  Dropped from the stem only: they'd otherwise match every candidate equally. IDF now demotes
   *  *campus* noise on its own, so this list stays as it is rather than growing — these are words
   *  about the **drawing**, which never appear on the candidate side to have a df at all. */
  static STEM_NOISE = new Set(['plan', 'plans', 'floorplan', 'floorplans', 'asbuilt', 'dwg']);

  /** Generic tails that carry no discriminating signal inside an initialism. "Engineering Science
   *  Building" is written `ESB` about as often as `ES`, so a candidate offers both forms. */
  static GENERIC_TAIL = new Set(['building', 'bldg', 'hall', 'center', 'centre', 'complex', 'annex']);

  // ---- the calibrated band --------------------------------------------------------------------
  // These are the auto-accept thresholds, fitted against `tests/js/fixtures/import-match-corpus.json`
  // — the labelled corpus exists so this band is a measurement rather than a feel. Moving one means
  // re-running that corpus and reading the scorecard's **precision** line, not just its hit rate: a
  // bar that admits three more right answers and one more wrong one is a regression, because a
  // wrong building silently re-anchors every floor key beneath it (§10 foundations).

  /** Below this, a Jaro-Winkler similarity counts as **zero**. The floor is not cosmetic: raw JW
   *  rates `north`/`south` at 0.73, so without it the twin `Residence Hall North`/`South` shape
   *  stops being separable at all. */
  static SIM_FLOOR = 0.88;
  /** The normalized score a proposal must reach before it may prefill. */
  static STRONG_SCORE = 0.82;
  /** …and how far clear of the runner-up it must be. This replaces the old exact-tie test: a
   *  filename two buildings explain nearly equally well genuinely doesn't say which it means. */
  static STRONG_MARGIN = 0.12;
  /** A trigram carried by more than this share of the candidate list is dropped from the shortlist
   *  index — it costs a long posting list and discriminates nothing. */
  static TRIGRAM_DF_MAX = 0.1;
  /** Candidate lists at or below this length are scored **exhaustively**, skipping the shortlist
   *  entirely. The shortlist is an approximation, so the ordinary import pays none of its recall
   *  risk and only a campus-sized list — where scoring everything is what would actually hurt —
   *  does. */
  static EXHAUSTIVE_MAX = 200;
  /** How many shortlisted candidates reach the character-level comparator on a large list. */
  static SHORTLIST_K = 40;

  /** Split a filename stem (extension already off) into the two signals a building match reads.
   *
   *  Tokens are **classified, not stripped**. The obvious-looking approach — strip a leading sheet
   *  number and a trailing floor suffix — can't work, because the same leading number is a sheet
   *  number in one convention and a *building code* in another (`001-Admin-FL1` is the reporter's
   *  real case: `001` is the building). So a bare digit run becomes a `code` candidate that scores
   *  only if some building actually carries that number, and a floor/sheet-*prefixed* number is
   *  dropped outright — it can never name a building. Everything else carrying a letter is a word.
   *
   *  A token matching **none** of those classes is then **sub-split** at its letter↔digit
   *  boundaries and each piece re-classified, so an undelimited stem (`AdminBldg1FL2`,
   *  `005ArchEnv`) decomposes instead of arriving as one unmatchable blob. Classification runs on
   *  the whole token *first*, which is what keeps `A101` a drawing-sheet number rather than letting
   *  it become `a` + building `101`.
   *
   *  Returns `{words: [...], codes: [int, ...]}`; `codes` are parsed so `001` and `1` are one key. */
  static tokenize(stem) {
    const words = [], codes = [];
    // Case survives to `_subSplit` — a camelCase hump is the only boundary an undelimited stem has
    // left once it is lowercased, and it is the one `AdminBldg1FL2` is actually written with.
    for (const raw of String(stem == null ? '' : stem).split(/[^A-Za-z0-9]+/)) {
      if (!raw) continue;
      const lower = raw.toLowerCase();
      if (ImportMatch._classify(lower, codes)) continue;
      // No class fits it whole — try it as a run-together compound before taking it as one word.
      const parts = ImportMatch._subSplit(raw);
      if (parts.length === 1) { words.push(lower); continue; }
      for (const part of parts) {
        const p = part.toLowerCase();
        if (!ImportMatch._classify(p, codes)) words.push(p);
      }
    }
    return { words, codes };
  }

  /** Classify one already-lowercased token: bank it as a `code`, or recognize it as something that
   *  cannot name a building at all. Returns whether the token was consumed — `false` means "this is
   *  an ordinary word", which is `tokenize`'s cue to sub-split it or keep it. */
  static _classify(raw, codes) {
    if (/^\d+$/.test(raw)) { codes.push(parseInt(raw, 10)); return true; }
    // An explicit `BLDG7` marker is a code, not a word — and a bare `BLDG` is pure noise.
    const bldg = ImportMatch.BUILDING_TOKEN.exec(raw);
    if (bldg) { if (bldg[1]) codes.push(parseInt(bldg[1], 10)); return true; }
    if (ImportMatch.FLOOR_TOKEN.test(raw) || ImportMatch.SHEET_TOKEN.test(raw)) return true;
    if (ImportMatch.STEM_NOISE.has(raw)) return true;
    return false;
  }

  /** Decompose a run-together token — `AdminBldg1FL2`, `005ArchEnv` — into the pieces the
   *  classifier can read, or return it unsplit. Three steps, and each earns its place:
   *
   *  1. **Split** at camelCase humps and letter↔digit boundaries.
   *  2. **Re-attach** a digit run to the marker word before it. Splitting is what breaks `FL2` into
   *     floor-marker `fl` and a bare `2` — which the classifier would then read as *building 2*,
   *     inventing a building code out of a floor number. So a digit run rejoins the preceding run
   *     when that run is itself a floor or building marker, and only then: `Shop3` must still yield
   *     the word `shop` and the code `3`.
   *  3. **Only decompose on evidence** that this is a compound rather than one capitalized name —
   *     a digit somewhere, or a piece that is a marker in its own right. Without this,
   *     `McDonald` becomes `mc` + `donald` and stops matching the building it names. */
  static _subSplit(raw) {
    const runs = raw.match(/[A-Z]+(?![a-z])|[A-Z][a-z]*|[a-z]+|\d+/g);
    if (!runs || runs.length < 2) return [raw];
    const parts = [];
    for (const run of runs) {
      const prev = parts[parts.length - 1];
      if (/^\d/.test(run) && prev && ImportMatch._isMarkerWord(prev.toLowerCase()))
        parts[parts.length - 1] = prev + run;
      else parts.push(run);
    }
    if (parts.length < 2) return [raw];
    return /\d/.test(raw) || parts.some(p => ImportMatch._isMarkerWord(p.toLowerCase()))
      ? parts : [raw];
  }

  /** Whether a bare (digit-free) token is a floor or building marker — `fl`, `lvl`, `bldg`. Used
   *  only by `_subSplit`, to decide what a digit run beside it belongs to. */
  static _isMarkerWord(token) {
    return ImportMatch.FLOOR_TOKEN.test(token) || ImportMatch.BUILDING_TOKEN.test(token);
  }

  /** The same decomposition for one NetBox building `{name, slug}` — both fields, since either may
   *  carry the human signal (`name="Administration"`) or the numeric one (`slug="slo-bldg-001"`).
   *
   *  Unlike a drawing stem, a candidate's tokens are not filtered: a building legitimately named
   *  "Level Building" or "Shop 3" must keep those words, and its digit runs are all code
   *  candidates. `slug`/`name` are kept whole as well, for the exact-match rung.
   *
   *  `initials` are the acronyms this building is plausibly written as (`_initialisms`). They are
   *  matched by **equality only**, never through `_wordSim`: a soft-matched three-letter acronym
   *  would match half a campus, and a false positive here re-anchors a building. */
  static candidateKey(cand) {
    const name = String(cand.name || '');
    const slug = String(cand.slug || '');
    const words = [], codes = [];
    for (const raw of (name + ' ' + slug).toLowerCase().split(/[^a-z0-9]+/)) {
      if (!raw) continue;
      if (/^\d+$/.test(raw)) codes.push(parseInt(raw, 10));
      else words.push(raw);
    }
    return {
      words: [...new Set(words)], codes: [...new Set(codes)],
      initials: ImportMatch._initialisms(name), name, slug,
    };
  }

  /** The initialisms one building name is plausibly abbreviated to: the initials of its name words,
   *  plus the same with a generic tail dropped — "Engineering Science Building" is written both
   *  `ESB` and `ES`. Built from the **name** only, because a slug's `bldg` segment would poison
   *  every acronym on the campus with the same letter. Two letters or more; a one-word name has no
   *  initialism worth having. */
  static _initialisms(name) {
    const words = name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
    if (words.length < 2) return [];
    const initials = (ws) => ws.map(w => w[0]).join('');
    const out = new Set([initials(words)]);
    const tail = ImportMatch.GENERIC_TAIL.has(words[words.length - 1]);
    if (tail && words.length > 2) out.add(initials(words.slice(0, -1)));
    return [...out].filter(s => s.length >= 2);
  }

  /** The Jaro similarity of two strings, 0..1. Hand-written: vanilla JS, no dependency and no build
   *  step (coding standard 3). */
  static _jaro(a, b) {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;
    const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
    const aHit = new Array(a.length).fill(false), bHit = new Array(b.length).fill(false);
    let matches = 0;
    for (let i = 0; i < a.length; i++) {
      const from = Math.max(0, i - window), to = Math.min(i + window + 1, b.length);
      for (let j = from; j < to; j++) {
        if (bHit[j] || a[i] !== b[j]) continue;
        aHit[i] = bHit[j] = true; matches++; break;
      }
    }
    if (!matches) return 0;
    // Half-transpositions: matched characters that arrived out of order relative to each other.
    let half = 0;
    for (let i = 0, j = 0; i < a.length; i++) {
      if (!aHit[i]) continue;
      while (!bHit[j]) j++;
      if (a[i] !== b[j]) half++;
      j++;
    }
    return (matches / a.length + matches / b.length + (matches - half / 2) / matches) / 3;
  }

  /** Jaro-Winkler: Jaro plus a bonus for a shared prefix (scale 0.1, at most 4 characters), applied
   *  only to an already-similar pair. Prefix-favouring is exactly the property a building name
   *  wants — `adminstration` is a typo of `administration`, `sciences` a plural of `science` — and
   *  it is cheaper than an edit distance. */
  static _jaroWinkler(a, b) {
    const jaro = ImportMatch._jaro(a, b);
    if (jaro < 0.7) return jaro;
    let prefix = 0;
    while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    return jaro + prefix * 0.1 * (1 - jaro);
  }

  /** How strongly one stem word backs one candidate word, as a 0..1 similarity.
   *
   *  The two structural rungs the old integer formula had are kept as **floors**, because each
   *  encodes a relation Jaro-Winkler under-rates: `admin` → `administration` is a deliberate
   *  abbreviation (JW alone scores it 0.87, right at the noise floor), `side` → `residence` a real
   *  containment. Jaro-Winkler sits between them, gated by `SIM_FLOOR` so a merely similar-looking
   *  pair scores nothing at all. The length floors on the two rungs are what keep a two-letter
   *  fragment from matching half the campus. */
  static _wordSim(a, b) {
    if (a === b) return 1;
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    if (short.length >= 3 && long.startsWith(short)) return 0.9;
    const jw = ImportMatch._jaroWinkler(a, b);
    if (jw >= ImportMatch.SIM_FLOOR) return jw;
    if (short.length >= 4 && long.includes(short)) return 0.8;
    return 0;
  }

  /** Decompose a candidate list **once**, for a caller about to match many stems against it
   *  (IMPORT-18). Returns the index `bestOf` reads:
   *    `{entries: [{cand, key}], n, wordIdf, codeIdf, initialIdf, maxIdf, postings}`
   *
   *  The index is where this matcher learns *the campus it is actually looking at*. Document
   *  frequency over the real candidate list is what tells it that `hall` names eight buildings and
   *  `astronomy` names one — discrimination a hand-maintained stoplist can only approximate, and it
   *  applies to numeric codes the same way.
   *
   *  `postings` is the shortlist index: an inverted map from a cheap key (a word, its 3- and
   *  4-character prefixes, its character trigrams, a code, an initialism) to the candidates
   *  carrying it. It exists so a campus-sized list can be narrowed by integer bookkeeping *before*
   *  any character-level comparator runs — the layered retrieve-then-compare shape, without which
   *  the split step would stall painting on a large import (IMPORT-18 raised the candidate cap). */
  static prepare(candidates) {
    const entries = (candidates || []).map(cand => ({ cand, key: ImportMatch.candidateKey(cand) }));
    const n = entries.length;
    const wordDf = new Map(), codeDf = new Map(), initialDf = new Map(), postings = new Map();
    const bump = (map, k) => map.set(k, (map.get(k) || 0) + 1);
    const post = (k, i) => {
      let list = postings.get(k);
      if (!list) postings.set(k, list = []);
      if (list[list.length - 1] !== i) list.push(i);   // candidates arrive in order, so this dedupes
    };
    entries.forEach(({ key }, i) => {
      for (const w of key.words) {
        bump(wordDf, w);
        post('w:' + w, i);
        for (const len of [3, 4]) if (w.length >= len) post('p:' + w.slice(0, len), i);
        for (const g of ImportMatch._trigrams(w)) post('g:' + g, i);
      }
      for (const c of key.codes) { bump(codeDf, c); post('c:' + c, i); }
      for (const s of key.initials) { bump(initialDf, s); post('i:' + s, i); }
    });
    // A trigram most of the campus shares is a long posting list that narrows nothing — drop it.
    const gramCap = Math.max(1, Math.floor(n * ImportMatch.TRIGRAM_DF_MAX));
    for (const [k, list] of postings)
      if (k.startsWith('g:') && list.length > gramCap) postings.delete(k);
    const idfOf = (df) => Math.log((n + 1) / (df + 1)) + 1;   // smoothed, so it is always positive
    const table = (dfMap) => {
      const out = new Map();
      for (const [k, df] of dfMap) out.set(k, idfOf(df));
      return out;
    };
    return {
      entries, n, postings,
      wordIdf: table(wordDf), codeIdf: table(codeDf), initialIdf: table(initialDf),
      // What an *unexplained* stem token weighs: a token no building carries is maximally
      // informative, and weighting it this way is what makes it cost score rather than merely
      // fail to add any.
      maxIdf: idfOf(0),
    };
  }

  /** The character trigrams of a token, space-padded so a short word still yields boundary grams. */
  static _trigrams(word) {
    const padded = ' ' + word + ' ';
    const out = [];
    for (let i = 0; i + 3 <= padded.length; i++) out.push(padded.slice(i, i + 3));
    return out;
  }

  /** Score one candidate against a tokenized stem, as an IDF-weighted generalized Monge-Elkan.
   *
   *  Every stem token contributes `weight × bestSimilarity` to a numerator and `weight` to a
   *  denominator; the score is their ratio, so it lands in 0..1 and is comparable between
   *  filenames. A word's weight is the IDF of the candidate token it best matched — or `maxIdf`
   *  when it matched nothing, which is how an unexplained word costs score. Codes work identically
   *  and are matched exactly: a building code is a key, not a name.
   *
   *  Returns `{score, word}` — the normalized score, plus whether the **word/acronym** signal
   *  contributed anything at all. `_tier` needs that flag separately from the score, because a
   *  code-only hit normalizes to a perfect 1.0 and must never reach the prefill bar. */
  static score(stemKey, candKey, index) {
    let num = 0, den = 0, word = false;
    for (const w of stemKey.words) {
      let best = 0, weight = index.maxIdf;
      for (const c of candKey.words) {
        const sim = ImportMatch._wordSim(w, c);
        if (sim > best) { best = sim; weight = index.wordIdf.get(c) || index.maxIdf; }
      }
      // An acronym reaches its building through the initialism list, by equality only.
      if (best < 1 && candKey.initials.includes(w)) {
        best = 1; weight = index.initialIdf.get(w) || index.maxIdf;
      }
      if (best > 0) word = true;
      num += weight * best; den += weight;
    }
    for (const c of stemKey.codes) {
      const hit = candKey.codes.includes(c);
      // A code the candidate doesn't carry still weighs — at `maxIdf` — so a wrong number costs
      // score rather than being quietly ignored (`Shop-5` must not resolve to Shop 3 or Shop 7).
      const weight = (hit && index.codeIdf.get(c)) || index.maxIdf;
      if (hit) num += weight;
      den += weight;
    }
    return { score: den ? num / den : 0, word };
  }

  /** Whether a stem's words, slugified, *are* this candidate's slug or its slugified name — the
   *  structural certainty rung, `ImportBind._confidentMatch`'s bar applied to a drawing stem. */
  static _isExact(stemSlug, candKey) {
    return !!stemSlug && (stemSlug === candKey.slug
      || stemSlug === candKey.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
  }

  /** The confidence tier for the winning candidate.
   *
   *  `exact`  — the stem *is* the building's slug or name (`_isExact`), and it is the only candidate
   *             that can say so. A structural certainty, so it is exempt from the margin rule below:
   *             a candidate that merely *contains* the name ("Library Annex" beside "Library")
   *             scores as highly on a one-word stem, and demoting the literal answer because of it
   *             would be strictly wrong. Two candidates both claiming it is genuine ambiguity.
   *  `strong` — a calibrated band rather than a shape: the normalized score clears `STRONG_SCORE`,
   *             it clears the runner-up by `STRONG_MARGIN`, and at least one **word or acronym**
   *             matched. That last clause stays structural on purpose — a bare number in a filename
   *             is as often a sheet number as a building code, so a **code-only** hit normalizes to
   *             a perfect 1.0 and still must not prefill.
   *  `weak`   — any other positive score: below the band, or too close to its runner-up to say.
   *  `none`   — nothing matched. */
  static _tier(s, margin, exactHits) {
    if (!s.score) return 'none';
    if (exactHits === 1) return 'exact';
    if (!exactHits && s.word && s.score >= ImportMatch.STRONG_SCORE
      && margin >= ImportMatch.STRONG_MARGIN) return 'strong';
    return 'weak';
  }

  /** The candidates worth running the character-level comparator against, as indices into
   *  `index.entries` — or `null` meaning "score every candidate".
   *
   *  Cheap integer bookkeeping over the inverted index: each stem key contributes its posting list,
   *  candidates accumulate the summed weight of the keys they were found by, and the top
   *  `SHORTLIST_K` survive. A **small list is scored exhaustively instead** (`EXHAUSTIVE_MAX`),
   *  because the shortlist is an approximation — a candidate reachable only through a
   *  transposition-heavy Jaro-Winkler match shares no trigram or prefix with the stem and would be
   *  missed. The ordinary import never pays that risk; only a campus-sized one, where scoring
   *  everything is what would actually hurt. */
  static _shortlist(stemKey, index) {
    if (index.n <= ImportMatch.EXHAUSTIVE_MAX) return null;
    const keys = [];
    for (const w of stemKey.words) {
      keys.push(['w:' + w, index.wordIdf.get(w) || index.maxIdf]);
      keys.push(['i:' + w, index.initialIdf.get(w) || index.maxIdf]);
      for (const len of [3, 4]) if (w.length >= len) keys.push(['p:' + w.slice(0, len), 1]);
      for (const g of ImportMatch._trigrams(w)) keys.push(['g:' + g, 0.5]);
    }
    for (const c of stemKey.codes) keys.push(['c:' + c, index.codeIdf.get(c) || index.maxIdf]);
    const hits = new Map();
    for (const [k, weight] of keys) {
      const list = index.postings.get(k);
      if (!list) continue;
      for (const i of list) hits.set(i, (hits.get(i) || 0) + weight);
    }
    return [...hits.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, ImportMatch.SHORTLIST_K)
      .map(([i]) => i);
  }

  /** The best building for a drawing stem among **prepared** candidates (`prepare`), or null when
   *  nothing scored. The caller's own candidate shape rides along untouched on `.cand`, so a Site
   *  and a building Location can both be matched by the same call.
   *
   *  Returns `{cand, confidence, score, margin}` — `score` normalized 0..1 and `margin` the gap to
   *  the runner-up, both comparable across filenames.
   *
   *  **A thin margin demotes to `weak`.** If a second candidate scores nearly as highly, the stem
   *  genuinely doesn't say which building it means, and only the operator can. Since the split step
   *  prefills `exact`/`strong` and never `weak`, this is what keeps an ambiguous filename out of
   *  the automatic path — mis-assigning a building re-anchors every floor key beneath it. It
   *  generalizes the exact-tie test it replaced: a near-tie is the far more common shape, and a
   *  test that only caught the arithmetic dead heat let them all through. */
  static bestOf(stem, index) {
    if (!index || !index.entries || !index.entries.length) return null;
    const stemKey = ImportMatch.tokenize(stem);
    if (!stemKey.words.length && !stemKey.codes.length) return null;
    return ImportMatch._resolve(stemKey, index);
  }

  /** Rank one **already-tokenized** stem against the index — the body of `bestOf`, split out so the
   *  batch pass can re-run it on a key the pile's own evidence has amended (`bestOfAll`) without
   *  re-tokenizing or duplicating the scan. Callers guarantee the key carries at least one signal
   *  and the index at least one candidate. */
  static _resolve(stemKey, index) {
    const stemSlug = stemKey.words.join('-');
    const shortlist = ImportMatch._shortlist(stemKey, index);
    let top = null, runnerUp = 0, exactHits = 0;
    for (const i of shortlist === null ? index.entries.keys() : shortlist) {
      const { cand, key: candKey } = index.entries[i];
      const s = ImportMatch.score(stemKey, candKey, index);
      if (!s.score) continue;
      const isExact = ImportMatch._isExact(stemSlug, candKey);
      if (isExact) exactHits++;
      // An exact hit outranks any merely-scored one, whatever the arithmetic says.
      const better = !top || (isExact && !top.isExact)
        || (isExact === top.isExact && s.score > top.s.score);
      if (better) {
        if (top) runnerUp = Math.max(runnerUp, top.s.score);
        top = { cand, candKey, s, isExact };
      } else {
        runnerUp = Math.max(runnerUp, s.score);
      }
    }
    if (!top) return null;
    // A sole scoring candidate has nothing to be confused with, so its margin is its whole score.
    const margin = top.s.score - runnerUp;
    return {
      cand: top.cand,
      confidence: ImportMatch._tier(top.s, margin, top.isExact ? exactHits : 0),
      score: top.s.score,
      margin,
    };
  }

  /** A drawing's filename minus its extension — what `bestOf()` matches on. Kept here beside the
   *  tokenizer so the two agree on what "the stem" means. */
  static stemOf(filename) {
    return String(filename == null ? '' : filename).replace(/\.[^.]+$/, '');
  }

  // ---- the collective evidence pass (IMPORT-21) -------------------------------------------------
  // `bestOf` scores each drawing **in isolation**, which leaves one class of doubt permanently
  // unresolvable: a filename cannot say whether its `005` is a building code or a sheet number, and
  // no amount of looking harder at that one filename ever will. The *pile* can say. Drawings arriving
  // together were named by one convention, so what the confidently-matched ones demonstrate about
  // that convention is real evidence about the rest.
  //
  // **The line this pass does not cross**: it resolves doubt about the pile's **numeric convention**
  // — which numbers name buildings and which are sheet or discipline indices — and never doubt about
  // which building a **word** means. A stem carrying no code is therefore untouchable here, whatever
  // its siblings say. That is deliberate and structural, not a tuning choice: `Residence-Hall-FL3` is
  // ambiguous *because* three siblings explain it, and a pile full of `Residence-Hall-North-*` is not
  // evidence that the unlabelled one is North — it is exactly as consistent with a South drawing
  // whose other floors weren't included. Word ambiguity has an owner already (the operator, through
  // the correction memory below); numeric convention has none, which is why this pass exists.

  /** How many confidently-matched stems must agree before the pile may say anything about one of its
   *  numbers. Two is the smallest count that is a *pattern* rather than a coincidence, and the bar is
   *  low on purpose — the agreeing stems each had to clear the prefill bar on their own word
   *  evidence first, so this counts corroborations, not guesses. */
  static PILE_MIN_AGREE = 2;

  /** Score a whole pile of drawing stems against one prepared index, folding in what the pile says
   *  about itself. Returns a `Map` from stem to the same `{cand, confidence, score, margin}` shape
   *  `bestOf` returns (or `null`), plus `corroborated: true` on any answer the collective pass
   *  improved — so a caller can say *why* a row was filled in.
   *
   *  Keyed by stem rather than returned in input order because two files can share a stem and the
   *  answer is a property of the stem; the caller (`ImportOrganize.open`) looks each
   *  drawing's stem up anyway.
   *
   *  Two passes. The first is exactly `bestOf` per stem — nothing is skipped or approximated, so a
   *  pile with no collective evidence returns precisely what scoring one at a time returns. The
   *  second re-resolves **only** the stems the first pass left `weak` or unanswered, which is both
   *  the cheap half and the only half a pile can help. */
  static bestOfAll(stems, index) {
    const out = new Map(), keys = new Map();
    const usable = !!(index && index.entries && index.entries.length);
    for (const raw of stems || []) {
      const stem = String(raw == null ? '' : raw);
      if (keys.has(stem)) continue;
      const stemKey = ImportMatch.tokenize(stem);
      keys.set(stem, stemKey);
      const signal = stemKey.words.length || stemKey.codes.length;
      out.set(stem, usable && signal ? ImportMatch._resolve(stemKey, index) : null);
    }
    const pile = usable ? ImportMatch._pileEvidence(keys, out, index) : null;
    if (!pile) return out;
    for (const [stem, stemKey] of keys) {
      const was = out.get(stem);
      if (was && was.confidence !== 'weak') continue;   // already confident — the pile adds nothing
      const now = ImportMatch._reresolve(stemKey, was, pile, index);
      if (now) out.set(stem, now);
    }
    return out;
  }

  /** What the pile's **confident** answers demonstrate about its numbering, or `null` when they
   *  demonstrate nothing. Only `exact`/`strong` results are read: a `weak` one is the very thing
   *  being decided, and letting it vote would let the pile talk itself into an answer.
   *
   *  Two findings, and each is the other's mirror:
   *    - **`noiseCodes`** — a number that ≥`PILE_MIN_AGREE` confident stems carry while their
   *      *different* winning buildings carry none of it. A building code identifies one building; a
   *      number riding along on two buildings' drawings is this convention's sheet, discipline or
   *      revision index. Its cost is waived for the whole pile, which is what stops a trailing `-0`
   *      from reading as a rival building code on every filename at once.
   *    - **`codeOwner`** — the converse: a number ≥`PILE_MIN_AGREE` confident stems carry that its
   *      one winning building *does* carry. Here the pile has demonstrated the number really is a
   *      building code, which is the doubt `_tier`'s code-only guard exists for.
   *
   *  **Noise beats ownership** where a number lands in both buckets (`001-1_Admin` makes `1` a
   *  building code and a sheet index in one filename, since `001` and `1` parse to one key): a number
   *  shown to be a sheet index somewhere can't be trusted as a key anywhere. */
  static _pileEvidence(keys, results, index) {
    const keyOf = new Map(index.entries.map(e => [e.cand, e.key]));
    const unexplained = new Map(), explained = new Map();
    const note = (bucket, code, cand) => {
      let e = bucket.get(code);
      if (!e) bucket.set(code, e = { cands: new Set(), cand, stems: 0 });
      e.cands.add(cand); e.stems++;
    };
    for (const [stem, r] of results) {
      if (!r || r.confidence === 'weak') continue;
      const candKey = keyOf.get(r.cand);
      if (!candKey) continue;
      for (const c of new Set(keys.get(stem).codes))
        note(candKey.codes.includes(c) ? explained : unexplained, c, r.cand);
    }
    const noiseCodes = new Set();
    for (const [c, e] of unexplained)
      if (e.cands.size >= ImportMatch.PILE_MIN_AGREE) noiseCodes.add(c);
    const codeOwner = new Map();
    for (const [c, e] of explained)
      if (!noiseCodes.has(c) && e.cands.size === 1 && e.stems >= ImportMatch.PILE_MIN_AGREE)
        codeOwner.set(c, e.cand);
    return noiseCodes.size || codeOwner.size ? { noiseCodes, codeOwner } : null;
  }

  /** Re-answer one unresolved stem with the pile's evidence in hand, or `null` to leave the isolated
   *  answer standing. Two things can change, in this order:
   *
   *  1. **The pile's sheet numbers stop costing.** Re-scored without them, a stem whose only fault
   *     was a suffix no building could explain can reach the prefill bar honestly — the unexplained
   *     term was never evidence against the winner, it was the convention. Note this **can reorder
   *     the candidates**, not merely rescale them: each stem word is weighted by the IDF of the
   *     candidate token it matched, so the denominator differs per candidate and a shared cost is
   *     not a shared factor (`Center` alone leads with `Central Plant`, whose rare word partly
   *     offsets that cost, and with the cost gone the four literal `Center`s win it back — and tie).
   *     What makes the re-score safe is not order preservation but that the tier is recomputed from
   *     scratch, so every ordinary guard — margin, code-only, exact — is applied afresh to it.
   *  2. **A corroborated code answers a code-only stem.** `_tier` refuses to prefill a code-only hit
   *     because a bare number is as often a sheet number as a building code — and here the pile has
   *     answered exactly that, ≥`PILE_MIN_AGREE` times, unanimously, on stems that cleared the bar on
   *     their own words. The promotion is confined to a stem with **no words at all**: a stem that
   *     says anything in words keeps its say, so `001-Hall-FL1` is never lifted past the fact that
   *     `hall` names a building the winner isn't. The proposal itself never moves — only its tier. */
  static _reresolve(stemKey, was, pile, index) {
    const codes = stemKey.codes.filter(c => !pile.noiseCodes.has(c));
    let now = was;
    if (codes.length !== stemKey.codes.length) {
      if (!codes.length && !stemKey.words.length) return null;   // nothing left to match on
      const cleaned = ImportMatch._resolve({ words: stemKey.words, codes }, index);
      if (cleaned) now = cleaned;
    }
    if (now && now.confidence === 'weak' && !stemKey.words.length && codes.length === 1
      && pile.codeOwner.get(codes[0]) === now.cand)
      now = { ...now, confidence: 'strong' };
    if (!now || now === was) return null;
    // The flag claims *the pile* is why this row may be filled in, so it belongs only on an answer
    // the collective pass actually lifted into a prefilling tier — not on one merely re-scored.
    const lifted = now.confidence !== 'weak' && (!was || was.confidence === 'weak');
    return lifted ? { ...now, corroborated: true } : now;
  }

  // ---- the correction memory (IMPORT-22) --------------------------------------------------------
  // Every hand-pick an operator makes in the split step is a free labelled example, and on the shape
  // that step exists for — a flat pile of one-file-per-floor drawings — it is a *repeated* one:
  // `001-Admin-FL1`, `-FL2`, `-FL3` name one building, and `tokenize` already drops the floor marker,
  // so all three arrive here as the same key. These two statics let the caller recall its own earlier
  // answer for such a sibling instead of asking again.
  //
  // **The memory is not stored here.** `ImportMatch` is a pure static utility (coding standard 1);
  // the memory belongs to `ImportFlow`, whose session it is scoped to, and is passed IN.
  //
  // **The rung is identical-key only, deliberately.** Nothing looser — no subset rung, no "similar
  // stem" similarity — because a looser rung would answer the very stems that genuinely have no
  // answer: `Residence-Hall-FL3` is ambiguous precisely because `Residence Hall North`/`South`/`East`
  // all explain it, and a containment rung would let one hand-pick guess the other two. Two stems
  // with the same key are, to any matcher, the same filename, so the operator's own answer for one is
  // the strongest evidence that exists for the other. That is the whole claim, and it is worth
  // exactly as much as it says.

  /** The canonical, order-insensitive identity of a stem — what two *sibling* drawings of one
   *  building share once floor and sheet markers are gone. Deduped and sorted on both signals, so
   *  case, punctuation, token order and a repeated word can't split one building's drawings into two
   *  keys. Returns `null` for a stem carrying no signal at all: an unreadable filename must never
   *  recall anything, and must never become a key other unreadable filenames collide with. */
  static memoryKey(stem) {
    const { words, codes } = ImportMatch.tokenize(stem);
    if (!words.length && !codes.length) return null;
    return [...new Set(words)].sort().join(' ')
      + '#' + [...new Set(codes)].sort((a, b) => a - b).join(',');
  }

  /** The caller's own earlier answer for a stem that tokenizes identically to this one, or `null`.
   *  `memory` is a `Map` from `memoryKey` to whatever the caller stored — an opaque value here, so a
   *  building the operator typed by hand (which has no NetBox row and can therefore never be
   *  *proposed*) recalls exactly like an existing one. */
  static recall(stem, memory) {
    if (!memory || !memory.size) return null;
    const key = ImportMatch.memoryKey(stem);
    return key === null ? null : (memory.get(key) || null);
  }
}
