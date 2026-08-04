'use strict';
/* import-bulk.js — ImportBulk: the import wizard's bulk floor-triage concern (IMPORT-9/IMPORT-12).
   A campus import can arrive as hundreds of drawings, most of which are not floor plans at all;
   dispatching them one card at a time is the wizard's worst chore. This owns the affordances that
   move many cards at once — the header control cluster (`controls`), the sweeps and positive
   assigns behind it, and the glob/pattern matchers they select by.

   Two ideas run through it:
     - **Scope** (`_scope`) — every action acts on the visible building alone, or on every building
       in the floor-mapping carousel, per the header's "Apply to" select (`this.all`).
     - **Per-building resolution** (`_resolveFloor`) — a floor picked from one building's vocabulary
       is re-resolved against each other building's own floor Locations (slug, then name, then
       floor number, then **storey ordinal**), because a campus's buildings each have their own
       slugs — and, past the ordinal rung, need not even share a floor-*naming system*. A building
       that resolves to nothing is *reported*, never mis-assigned.

   It also owns the **filename → floor** axis whole (`floorFromStem`/`suggestFloors`/`floorNumber`
   and the glob matchers), deliberately kept in one file: `ImportMatch` owns the opposite axis,
   filename → *building*, and a drawing name carries both signals — splitting either across files is
   how the two get conflated. The per-drawing suggestion pass (IMPORT-28) is the one entry point
   here that isn't user-triggered bulk; it is a pre-fill the operator confirms, never a decision.

   Holds a wizard back-ref (`this.w`), the ImportUploader shape: eligibility keys off the flow's
   siteplan pick + region splits, and every change persists through `_saveDraft` and re-renders
   the visible section in place. */

class ImportBulk {
  constructor(wizard) {
    this.w = wizard;
    // Bulk-triage scope (IMPORT-12): false = the visible building only, true = every building in
    // the floor-mapping carousel, so a campus whose folders share a sheet-naming convention is
    // triaged once instead of once per folder. Transient — a view preference, NOT in the draft.
    this.all = false;
  }

  /** Whether drawing `p` may be swept to "(none)" by a bulk action: not the chosen site plan (a
   *  distinct no-floor state) and not a region-split drawing (whose per-region floors would be
   *  silently discarded — left to the explicit Unsplit). Keeps `_none` and the header controls'
   *  visibility in lockstep. */
  eligible(b, p) {
    return !this.w._isSiteplanPick(b, p) && !(b.regions[p.stem] && b.regions[p.stem].length);
  }

  /** Which buildings a bulk action from building `b`'s header acts on (IMPORT-12): just `b`, or —
   *  when the header's scope select is set to "all" — every building in the floor-mapping carousel
   *  (`_mappableBuildings`, what the operator actually sees and pages through). `b` is always
   *  included even if it has dropped out of the carousel (every card noned), so an action fired
   *  from a header never silently skips that header's own building. */
  _scope(b) {
    if (!this.all) return [b];
    const all = this.w._mappableBuildings();
    return all.includes(b) ? all : [b, ...all];
  }

  /** The engine behind every bulk-triage action (IMPORT-12). Walks `_scope(b)`, and for each
   *  card matching `opts.match(bb, p)` applies the patch `opts.patch(bb, p)` onto its assignment —
   *  `Object.assign`ed **in place**, so fields the patch omits (notably `num`) survive, exactly as
   *  the per-card buttons behave. A patch of `null` means "this building has no such floor" and is
   *  counted as unresolved rather than guessed at (see `_resolveFloor`). Ineligible cards (the
   *  chosen site plan; a region-split drawing) are skipped via `eligible` on **each** building,
   *  so widening the scope never clobbers another building's siteplan pick or split.
   *
   *  On any change: saves the draft and re-renders the visible building's section in place
   *  (preserving scroll and re-running the build gate, IMPORT-2 — never `_stepMap()`). Buildings
   *  outside the visible one have no cards in the DOM, so their edits need no re-render; the
   *  build gate `_refreshBuildActions` re-runs reads all of them. Toasts what happened, naming the
   *  building count for a cross-building action and any unresolved cards. */
  _apply(b, opts) {
    let n = 0, miss = 0;
    const touched = new Set();
    for (const bb of this._scope(b)) {
      for (const p of bb.pdfs) {
        if (!this.eligible(bb, p) || !opts.match(bb, p)) continue;
        const patch = opts.patch(bb, p);
        if (!patch) { miss++; continue; }
        // A bulk action is the operator answering, so it clears every "not yet answered" marker on
        // the card (IMPORT-28/IMPORT-63) — the patches themselves don't carry them, and an
        // `Object.assign` that omitted them would leave a stale "suggested" or "set automatically"
        // badge on a floor the user just chose.
        Object.assign(bb.assign[p.stem], patch);
        ImportFlow.clearUnanswered(bb.assign[p.stem]);
        n++; touched.add(bb);
      }
    }
    const unresolved = miss
      ? ' ' + miss + (miss === 1 ? ' drawing matched' : ' drawings matched') + ' no floor in their building.'
      : '';
    if (!n) { Toast.show(opts.empty + unresolved, !!miss); return 0; }
    this.w._saveDraft();
    this.w._rerenderBuildingSection(b);
    const where = touched.size > 1 ? ' across ' + touched.size + ' buildings' : '';
    Toast.show(opts.done(n) + where + '.' + unresolved, !!miss);
    return n;
  }

  /** Bulk-triage helper: set every card matching `matchFn(bb, p)` to "(none)", the same
   *  `{type:'none', token:null, label:''}` the per-card `(none)` button produces (`_floorButtons`) —
   *  so bulk-none is pure UX ergonomics with no new "ignored" state, and `max_pdfs` is satisfied for
   *  free (a `type:'none'` drawing is dropped from the build, see `_resolveFloors`). `matchFn` takes
   *  the owning building as well as the drawing, since the scope may span several (`_scope`).
   *  The patch never resolves to null, so this path can't report unresolved cards. */
  _none(b, matchFn) {
    this._apply(b, {
      match: matchFn,
      patch: () => ({ type: 'none', token: null, label: '' }),
      done: (n) => 'Set ' + n + (n === 1 ? ' drawing' : ' drawings') + ' to (none)',
      empty: 'No matching drawings to set to (none).',
    });
  }

  // ---- the filename -> floor guess (IMPORT-28) -------------------------------------------------
  // A drawing's own name usually spells its floor (`001-Admin-FL1`, `HQ-B2`, `Annex-Roof`), and
  // before this the operator re-typed that fact once per card. Floor PDFs carry no text layer, so
  // reading it off the *drawing* would mean an OCR runtime dependency — declined outright (coding
  // standard #3), leaving the filename as the dep-free signal that covers most real sets.
  //
  // Everything below is a **suggestion**, never a decision: it only ever fills a drawing the
  // operator hasn't answered, and every write is flagged `suggested` so the card can say so.

  /** Filename tokens that name a floor, as `word -> floor type`. Digits following the word are read
   *  separately, so `L3`/`FL03`/`B2` all decompose. Deliberately **not** a superset of the obvious
   *  spellings: a bare `G` or `R` is far more often a sheet series or a revision marker than a
   *  ground floor or a roof, so only the ≥2-character forms of those are listed. The one-letter
   *  entries that do appear (`l`, `f`, `b`) are exactly the ones a required digit disambiguates —
   *  `L3` and `B2` say something, a bare `L` does not. Words absent here
   *  are what keeps a drawing-sheet number out — `A101`/`M203` never reach a floor at all.
   *
   *  A `Map`, not an object literal: this is looked up by a token taken straight from a filename, and
   *  an object would answer `Object.prototype`'s own keys for one (`constructor` is truthy). */
  static FLOOR_WORD = new Map([
    ['l', 'level'], ['lv', 'level'], ['lvl', 'level'], ['lev', 'level'], ['level', 'level'],
    ['f', 'level'], ['fl', 'level'], ['flr', 'level'], ['floor', 'level'],
    ['storey', 'level'], ['story', 'level'],
    ['b', 'basement'], ['bsmt', 'basement'], ['bsm', 'basement'], ['basement', 'basement'],
    ['gf', 'ground'], ['grd', 'ground'], ['grnd', 'ground'], ['ground', 'ground'],
    ['rf', 'roof'], ['roof', 'roof'], ['rooftop', 'roof'],
  ]);

  /** A floor number this large is a drawing-sheet number, not a storey — `L-101` is a landscape
   *  sheet series, `L1`..`L99` are floors. Two digits is the honest ceiling for a real building. */
  static MAX_FLOOR_NUM = 99;

  /** Guess a drawing's floor from its filename stem: `{type, num}` (the floor-type vocabulary
   *  `_floorButtons` writes), or null when the name says nothing definite.
   *
   *  **The stem only — never the folder.** A folder names the *building* (that is
   *  `_modelFromInventory`'s and `ImportMatch`'s axis), so folding it in would stamp one floor onto
   *  every drawing inside it.
   *
   *  **An exploded page row is skipped outright.** Its stem is `<file>#pN` (`_explodePages`), where
   *  the file part names the whole multi-page set — guessing from it would smear a single floor
   *  across all sixty pages, which is worse than leaving them unassigned.
   *
   *  Reads the **last** marker in the name, on the same reasoning as `floorNumber`: a leading number
   *  is a building code (`001-Admin-FL1` is the reporter's own case, where `001` is the building and
   *  `FL1` the floor). Scanning `(letters)(digits)` pairs across the whole lowercased stem means a
   *  run-together name (`AdminBldg1FL2`) decomposes exactly like a delimited one. */
  static floorFromStem(stem) {
    const s = String(stem == null ? '' : stem);
    if (s.indexOf('#p') !== -1) return null;       // an exploded page row — see above
    return ImportBulk.floorFromText(s);
  }

  /** Spelled-out ordinals, for the `<ordinal> <floor word>` captions drawings print
   *  ("SECOND BASEMENT LEVEL", "THIRD FLOOR PLAN"). Filenames overwhelmingly use codes (`L2`,
   *  `B3`), which is why the stem heuristic never needed these; a **caption** read by OCR is where
   *  they turn up, and sharing one parser means the filename path gets them for free. */
  static ORDINAL_WORD = new Map([
    ['first', 1], ['second', 2], ['third', 3], ['fourth', 4], ['fifth', 5], ['sixth', 6],
    ['seventh', 7], ['eighth', 8], ['ninth', 9], ['tenth', 10], ['eleventh', 11], ['twelfth', 12],
  ]);

  /** Rewrite `<ordinal> <floor word>` into the plain `<word><digits>` form the scanner already
   *  understands — "second basement" → `basement2`, "2ND FLOOR" → `level2` — so ordinals need no
   *  second code path and, crucially, no second chance to *overwrite* a better marker.
   *
   *  Normalizing rather than adding a parallel pass is what preserves the **last-marker** rule.
   *  Read left to right, "SECOND BASEMENT LEVEL (B2) PLAN" carries the ordinal *before* the
   *  explicit code; a separate ordinal pass would have to fight the main scan for precedence, and
   *  a bare `basement` (which defaults to 1) would clobber the ordinal's own number. Folded into
   *  the same token stream, all three markers simply compete on position, and the rightmost — the
   *  explicit `(B2)` — wins, exactly as it does for a filename.
   *
   *  The canonical word, not the matched one, is emitted (`storey`/`story`/`flr` all collapse to
   *  `level`), so the result is always a `FLOOR_WORD` key. */
  static _foldOrdinals(lower) {
    const words = [...ImportBulk.ORDINAL_WORD.keys()].join('|');
    const re = new RegExp(
      '\\b(?:(' + words + ')|(\\d{1,2})(?:st|nd|rd|th))[\\s._-]+(?:sub[\\s._-]?)?'
      + '(basement|bsmt|floor|level|storey|story|lvl|flr|fl)\\b', 'g');
    return lower.replace(re, (_m, word, digits, kind) => {
      const n = word ? ImportBulk.ORDINAL_WORD.get(word) : parseInt(digits, 10);
      return (kind.indexOf('b') === 0 ? 'basement' : 'level') + n;
    });
  }

  /** The floor scanner itself, over ANY text — a filename stem (`floorFromStem`) or a floor
   *  caption an OCR pass read off the marked code region (IMPORT-31). Both axes resolve a floor
   *  from a short string with the same vocabulary and the same last-marker rule, so they share one
   *  parser rather than drifting apart as the two separate ones did before `1.10.0`. */
  static floorFromText(text) {
    const lower = ImportBulk._foldOrdinals(String(text == null ? '' : text).toLowerCase());
    let found = null;
    // A *bare* digit ordinal, with no floor word after it for `_foldOrdinals` to attach it to
    // ("HQ-2ND"). It runs first because the `(letters)(digits)` scan below reads a leading number
    // as part of no word at all and would miss it — and because, as the weakest of the three
    // signals, it should lose to anything the scan does find.
    for (const m of lower.matchAll(/(\d+)(?:st|nd|rd|th)\b/g)) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= ImportBulk.MAX_FLOOR_NUM) found = { type: 'level', num: n };
    }
    // A short separator between the word and its number is allowed ("LEVEL 4", "FL-3") but kept to
    // two characters, so the number has to actually belong to the word rather than being the next
    // field along.
    for (const m of lower.matchAll(/([a-z]+)[\s._-]{0,2}(\d*)/g)) {
      const type = ImportBulk.FLOOR_WORD.get(m[1]);
      if (!type) continue;
      const digits = m[2];
      const n = digits ? parseInt(digits, 10) : null;
      // A level needs its number spelled out — a bare `FL`/`FLOOR` names no storey. Basement,
      // ground and roof are complete words on their own and default to 1.
      if (type === 'level' && n === null) continue;
      if (n !== null && (n < 1 || n > ImportBulk.MAX_FLOOR_NUM)) continue;
      found = { type, num: n === null ? 1 : n };
    }
    return found;
  }

  // ---- ordinal space: the one axis both naming systems reduce to (IMPORT-52) -------------------
  // A building's drawing captions and its NetBox floor Location names are two different naming
  // systems describing the same ordered set of storeys, and no amount of string comparison brings
  // them together: `GROUND` and `Floor 0` share not one character. Parsed into a signed storey
  // index they are simply both 0. Everything below exists to put both sides on that axis.

  /** Where a roof sits in ordinal space: above every real storey, and equal only to another roof.
   *  A sentinel rather than a computed "top of this building" because the two sides are parsed
   *  independently — a caption reading ROOF and a Location named "Roof" have to meet without
   *  either one knowing how tall the building is. Far above `MAX_FLOOR_NUM`, so no level can
   *  collide with it. */
  static ROOF_ORDINAL = 900;

  /** A floor guess (`{type, num}`) as a signed storey index: basements below zero, ground at zero,
   *  a level at its own number, the roof at its sentinel. Null for a null guess.
   *
   *  The sign is what keeps `B2` honest. Basement 2 is −2 and "Level 2" is +2, so the two can
   *  never meet however the comparison is done — the same invariant `_resolveGuess`'s name-only
   *  rung protects by hand, now expressed once in the arithmetic. */
  static floorOrdinal(g) {
    if (!g) return null;
    if (g.type === 'basement') return -g.num;
    if (g.type === 'ground') return 0;
    if (g.type === 'roof') return ImportBulk.ROOF_ORDINAL;
    if (g.type === 'level') return g.num;
    return null;
  }

  /** Any floor-naming text as an ordinal — `floorOrdinal ∘ floorFromText`, plus the one form
   *  `floorFromText` deliberately refuses: an explicit **zero** storey (`Floor 0`, `L0`).
   *
   *  That refusal is load-bearing on the filename axis. `floorFromText`'s `1..MAX_FLOOR_NUM` guard
   *  is what keeps a drawing-sheet number out of the floor vocabulary, so the zero case is read
   *  *here* instead of loosening it. The two parsers see different populations, which is what makes
   *  the split safe: this one runs only over text already claiming to name a floor — a Location's
   *  own name, or a caption being compared against one — where a literal `0` means storey zero and
   *  nothing else. `floorFromText` runs over raw filenames, where it does not. */
  static ordinalFromText(text) {
    const ord = ImportBulk.floorOrdinal(ImportBulk.floorFromText(text));
    if (ord !== null) return ord;
    const lower = String(text == null ? '' : text).toLowerCase();
    return /\b(?:l|lv|lvl|lev|level|f|fl|flr|floor|storey|story)[\s._-]{0,2}0+\b/.test(lower)
      ? 0 : null;
  }

  /** One NetBox floor Location as an ordinal, read from its display name and falling back to its
   *  slug. The same parser the caption side uses — that sameness is the point, since a rung that
   *  parsed the two sides differently would just be a new way for them to drift. */
  static _locOrdinal(loc) {
    if (!loc) return null;
    const byName = ImportBulk.ordinalFromText(loc.name);
    return byName === null ? ImportBulk.ordinalFromText(loc.slug) : byName;
  }

  /** A floor name reduced to its comparable core — lowercase, alphanumerics only — so `Floor-1`,
   *  `FLOOR 1` and `floor1` meet. Deliberately not an edit distance: what this erases is
   *  punctuation and case, never a character that could name a different floor, so it can widen
   *  the exact-name rung without turning it into a guess. */
  static _normName(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  /** The building's one floor Location sitting at ordinal `ord`, or null when none does — or when
   *  **several** do. Uniqueness is the safety property: a building carrying both a "Floor 2" and a
   *  "Second Floor" makes the read genuinely ambiguous, and an ambiguous read is reported
   *  unresolved rather than resolved to whichever happened to be listed first. */
  static _uniqueByOrdinal(floors, ord) {
    if (ord === null || !Array.isArray(floors)) return null;
    const hits = floors.filter(x => ImportBulk._locOrdinal(x) === ord);
    return hits.length === 1 ? hits[0] : null;
  }

  /** Resolve a `floorFromStem` guess into an assignment patch for building `b`, or null when the
   *  building has no such floor. The suggestion counterpart to `_resolveFloor`.
   *
   *  Floor-type mode takes the guess verbatim. Location mode has to find a real Location, and the
   *  two halves resolve differently on purpose: a **level** goes through `_resolveFloor`, whose
   *  number and ordinal rungs read an absolute storey the caption states outright (`L2` is storey
   *  2 in anyone's scheme), while basement/ground/roof match by **name** and never by number —
   *  `B2` means *basement 2*, and letting its digit reach `floorNumber` would cheerfully resolve it
   *  to a Location called "Level 2".
   *
   *  That asymmetry is why this is only the **first** rung of `_suggestFrom`'s three (IMPORT-52),
   *  not the whole story. A level names a storey absolutely; ground and basement carry an *origin*
   *  question no single caption can answer — whether this building calls its ground storey `Floor
   *  0` or `Floor 1` — so they deliberately fall through to the whole-building alignment before
   *  any absolute ordinal claim is made on their behalf. */
  _resolveGuess(b, g) {
    if (!(Array.isArray(b.nbFloors) && b.nbFloors.length))
      return { type: g.type, num: g.num, token: null, label: '' };
    if (g.type === 'level') return this._resolveFloor(b, { kind: 'num', n: g.num });
    const f = b.nbFloors.find(x => {
      const name = (x.name || '').trim().toLowerCase();
      if (name.indexOf(g.type) !== 0) return false;
      const n = ImportBulk.floorNumber(x.name);
      return g.num === 1 ? (n === null || n === 1) : n === g.num;
    });
    return f ? { type: 'level', token: f.slug, label: f.name } : null;
  }

  /** Fill in filename-derived floor suggestions for a building, returning how many landed.
   *
   *  **Only ever fills a genuine blank — `type === 'unassigned'`, and nothing else.** That state is
   *  the wizard's one "no answer yet" marker (`_normalizeToLocations`/`_dropUnanchoredTokens` write
   *  it); every other assignment is somebody's answer. Testing it — rather than the looser "has no
   *  token" — is what stops a re-bind from re-running this over a floor the operator picked by hand
   *  from the floor-type vocabulary, which has no token to protect it. A deliberate `(none)` and a
   *  region-split drawing (one page, several floors — no single stem names them) are skipped for the
   *  same reason. Every write is flagged `suggested` so `_floorButtons` can present it as a pre-fill
   *  awaiting confirmation rather than a decision.
   *
   *  Called from `_loadFloors` right after `_normalizeToLocations`, which is the case that matters:
   *  entering Location mode leaves every untouched drawing `unassigned`, and this is what turns that
   *  wall of "⚠ pick a floor" into a reviewable page. */
  suggestFloors(b) {
    const targets = [];
    for (const p of b.pdfs) {
      const a = b.assign[p.stem];
      if (!a || a.type !== 'unassigned') continue;
      if (b.regions[p.stem] && b.regions[p.stem].length) continue;
      const g = ImportBulk.floorFromStem(p.stem);
      if (!g) continue;
      targets.push({ a, guess: g, done: false });
    }
    return this._suggestFrom(b, targets, 'filename').filled;
  }

  /** Turn one building's parsed floor reads into suggestions, through three rungs in the order
   *  that keeps the strongest evidence on top (IMPORT-52). Shared by both producers — the filename
   *  pass (`suggestFloors`) and the OCR sweep (`ImportOcrSweep.applyResults`) — so a caption and a
   *  stem resolve identically. `targets` is `[{a, guess, done}]`; returns `{filled, aligned}`.
   *
   *  1. **Per-caption resolution** (`_resolveGuess`) — the literal rungs: an exact slug, an exact
   *     or normalized name, a trailing floor number, and for a level the absolute ordinal it
   *     states outright.
   *  2. **Whole-building alignment** (`_alignGuesses`) — the reads matched *as a set*, by order.
   *  3. **The absolute ordinal**, per caption, for whatever is still blank — `GROUND` reaching a
   *     Location called `Floor 0` when there was no alignable set to say otherwise.
   *
   *  Rung 2 outranks rung 3 on purpose, and the reporter's own set is why. Three drawings reading
   *  BASEMENT / GROUND / SECOND FLOOR against `Floor 0` / `Floor 1` / `Floor 2`: rung 3 would take
   *  `GROUND` at its word and answer `Floor 0`, which this building's own scheme contradicts —
   *  there, `Floor 0` is the basement. Whole-building evidence that is self-consistent *and*
   *  corroborated by a literal match beats one caption's absolute claim about an origin it cannot
   *  actually know.
   *
   *  Every write here lands on a still-unanswered drawing, and every write but one is a `suggested`
   *  pre-fill: this is smarter *matching*, and it decides nothing the operator can't see.
   *
   *  The exception is `opts.accept` (IMPORT-63), the hook the floor-code sweep passes to take a
   *  confident read outright. It is offered **only on rung 1, and only when that rung matched
   *  literally** — `_resolveFloor`'s own trailing-ordinal fallback stamps `matchedBy`, and a patch
   *  carrying one is an inference like rungs 2 and 3, so it stays a suggestion no matter how
   *  confident the read was. That asymmetry is the point: a recognition score measures how clearly
   *  the pixels said `LEVEL 2`, and says nothing at all about whether this building's `Floor 1` is
   *  its ground storey. Returns `{filled, aligned, accepted}`; `accepted` counts toward `filled`,
   *  since both are drawings this pass gave a floor. */
  _suggestFrom(b, targets, from, opts = {}) {
    let filled = 0, accepted = 0;
    const fill = (t, patch) => {
      Object.assign(t.a, patch, { suggested: true, suggestedFrom: from });
      delete t.a.autoDefault;      // it has a real match now; the blind placeholder is spent
      delete t.a.autoAccepted;
      t.done = true;
      filled++;
    };
    // The one committing write: no `suggested` flag, an `autoAccepted` marker the card renders and
    // `_undoAutoAccepted` reverses, and `suggestedFrom` kept as provenance for both.
    const take = (t, patch) => {
      Object.assign(t.a, patch,
        { suggested: false, suggestedFrom: from, autoAccepted: true });
      delete t.a.autoDefault;
      t.done = true;
      filled++;
      accepted++;
    };
    for (const t of targets) {
      const patch = this._resolveGuess(b, t.guess);
      if (!patch) continue;
      if (!patch.matchedBy && opts.accept && opts.accept(t)) take(t, patch);
      else fill(t, patch);
    }
    const aligned = this._alignGuesses(b, targets, from);
    filled += aligned;
    for (const t of targets) {
      if (t.done) continue;
      const loc = ImportBulk._uniqueByOrdinal(b.nbFloors, ImportBulk.floorOrdinal(t.guess));
      if (loc) fill(t, { type: 'level', token: loc.slug, label: loc.name, matchedBy: 'ordinal' });
    }
    return { filled, aligned, accepted };
  }

  /** Match a building's floor reads against its floor Locations **as a set**, by rank: sort both
   *  sides by ordinal and pair them off (IMPORT-52). Returns how many new suggestions landed.
   *
   *  This is the rung that answers what no per-caption rule can. Two naming systems can each be
   *  internally consistent and still share no origin, and the reporter's set is exactly that:
   *  BASEMENT / GROUND / SECOND FLOOR against `Floor 0` / `Floor 1` / `Floor 2` is not a constant
   *  ordinal offset (−1→0, 0→1, 2→2 shifts by 1, 1, then 0), so no amount of sliding one axis along
   *  the other fits it. What the two sides *do* agree on is **order**, so order is what gets
   *  matched.
   *
   *  Every precondition below exists so that an ambiguous set produces **nothing** rather than a
   *  confident wrong answer — the one failure mode this feature is forbidden to reintroduce:
   *   - **Location mode, and two or more reads.** A single drawing carries no *relative*
   *     information at all; "aligning" it would just be guessing with extra steps.
   *   - **Both sides fully parsed, with no duplicate ordinals.** A read naming no storey, or two
   *     naming the same one, leaves the ranking undefined.
   *   - **Equal counts.** Fewer reads than Locations means the run could sit at any of several
   *     offsets and nothing here can say which. Locations already claimed by a drawing *outside*
   *     this pass are removed first, so a partly-assigned building still aligns on what remains.
   *   - **Corroboration.** The pairing has to agree with every literal match rung 1 already made.
   *     One disagreement abandons the whole alignment, so this can only ever *add* to a literal
   *     reading and never overrule one. In the reporter's set the literal `SECOND FLOOR` → `Floor
   *     2` is precisely what vouches for the other two. */
  _alignGuesses(b, targets, from) {
    if (!(Array.isArray(b.nbFloors) && b.nbFloors.length) || targets.length < 2) return 0;
    const ords = targets.map(t => ImportBulk.floorOrdinal(t.guess));
    if (ords.some(o => o === null) || new Set(ords).size !== ords.length) return 0;
    // Floors already spoken for by a drawing this pass isn't touching are out of the running —
    // that is what lets a half-assigned building still align on the floors that are left.
    const taken = new Set();
    for (const p of b.pdfs) {
      const a = b.assign[p.stem];
      if (a && a.token && !targets.some(t => t.a === a)) taken.add(a.token);
    }
    const pool = b.nbFloors.filter(x => !taken.has(x.slug));
    if (pool.length !== targets.length) return 0;
    const locOrds = pool.map(x => ImportBulk._locOrdinal(x));
    if (locOrds.some(o => o === null) || new Set(locOrds).size !== locOrds.length) return 0;
    const reads = targets.map((t, i) => ({ t, ord: ords[i] })).sort((p, q) => p.ord - q.ord);
    const locs = pool.map((x, i) => ({ x, ord: locOrds[i] })).sort((p, q) => p.ord - q.ord);
    for (let i = 0; i < reads.length; i++)
      if (reads[i].t.done && reads[i].t.a.token !== locs[i].x.slug) return 0;
    let n = 0;
    for (let i = 0; i < reads.length; i++) {
      const t = reads[i].t;
      if (t.done) continue;                       // already resolved literally — leave it alone
      Object.assign(t.a, { type: 'level', token: locs[i].x.slug, label: locs[i].x.name,
        matchedBy: 'aligned', suggested: true, suggestedFrom: from });
      delete t.a.autoDefault;      // matched now, so the blind positional placeholder is spent
      delete t.a.autoAccepted;
      t.done = true;
      n++;
    }
    return n;
  }

  /** The first integer a floor name/slug ends with — the fallback rung of cross-building floor
   *  resolution (`_resolveFloor`) and the target of a `{n}` name pattern. Reads the **last**
   *  digit run so a name that also carries a building number ("Building 2 — Floor 3") resolves to
   *  the floor, not the building. Null when the name carries no digits. */
  static floorNumber(s) {
    const m = String(s == null ? '' : s).match(/(\d+)(?!.*\d)/);
    return m ? parseInt(m[1], 10) : null;
  }

  /** Resolve a bulk floor pick into an assignment patch for building `bb`, or null when `bb` has no
   *  such floor (the caller counts that as unresolved rather than inventing an assignment).
   *
   *  A `spec` is either the floor-type vocabulary (`{kind:'type', type, num}`), a NetBox Location
   *  (`{kind:'loc', slug, name}`), or a bare number captured from a name pattern
   *  (`{kind:'num', n}`). Same-building Location picks hit the exact slug on the first rung.
   *
   *  Cross-building is where this earns its keep: the floor options come from the building whose
   *  header was used, but a campus's other buildings have their **own** floor Locations with their
   *  own slugs. So a Location pick falls back to an exact (case-insensitive) **name** match and
   *  then to a **number** match (`floorNumber`) — which is precisely the shared-naming convention
   *  ("Floor 3" in every building) that makes an all-buildings sweep worth doing. A building whose
   *  floors follow no such convention resolves to null and is reported, never mis-assigned.
   *
   *  Two rungs below those widen the reach without loosening any of them (IMPORT-52). A
   *  **normalized-name** match lets `Floor-1` meet `FLOOR 1` (punctuation and case only — nothing
   *  that could name a different floor). Then an **ordinal** match puts both names on the signed
   *  storey axis, which is the only rung that crosses two different naming *systems*: it is what
   *  carries a `Ground` pick from one building onto another's `Floor 0`. It commits only when
   *  exactly one Location sits at that storey (`_uniqueByOrdinal`), so a building naming the same
   *  floor twice stays unresolved rather than resolving arbitrarily. */
  _resolveFloor(bb, spec) {
    const locMode = Array.isArray(bb.nbFloors) && bb.nbFloors.length;
    const wantNum = spec.kind === 'num' ? spec.n : ImportBulk.floorNumber(spec.name);
    if (!locMode) {
      // Floor-type fallback: a level number is expressible, a foreign Location slug is not.
      if (spec.kind === 'type') return { type: spec.type, num: spec.num, token: null, label: '' };
      return wantNum ? { type: 'level', num: wantNum, token: null, label: '' } : null;
    }
    if (spec.kind === 'type') return null;   // no floor-type vocabulary in Location mode
    const slug = (spec.slug || '').toLowerCase();
    const name = (spec.name || '').trim().toLowerCase();
    const norm = ImportBulk._normName(spec.name);
    const f = (slug && bb.nbFloors.find(x => (x.slug || '').toLowerCase() === slug))
      || (name && bb.nbFloors.find(x => (x.name || '').trim().toLowerCase() === name))
      || (norm && bb.nbFloors.find(x => ImportBulk._normName(x.name) === norm))
      || (wantNum !== null && bb.nbFloors.find(x => ImportBulk.floorNumber(x.name) === wantNum))
      || null;
    if (f) return { type: 'level', token: f.slug, label: f.name };
    // A bare number IS its own ordinal; a Location pick has to be re-read off its name.
    const ord = spec.kind === 'num' ? spec.n : ImportBulk._locOrdinal(spec);
    const byOrd = ImportBulk._uniqueByOrdinal(bb.nbFloors, ord);
    return byOrd
      ? { type: 'level', token: byOrd.slug, label: byOrd.name, matchedBy: 'ordinal' }
      : null;
  }

  /** Compile a drawing-name glob to regex source. `*` = any run, `?` = one character, `{n}` = a
   *  capturing run of digits; everything else is literal. Escaping happens first and the three
   *  wildcards are re-opened afterwards, so a pattern carrying regex metacharacters (`.` in a
   *  filename is the common one) can never smuggle in a pattern of its own. Null for an empty
   *  pattern. */
  static _globSource(pattern) {
    const pat = String(pattern == null ? '' : pattern).trim();
    if (!pat) return null;
    return pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .split('\\{n\\}').join('(\\d+)')
      .split('\\*').join('.*')
      .split('\\?').join('.');
  }

  /** A `stem -> boolean` matcher from a glob (see `_globSource`), anchored and case-insensitive.
   *  Null when the pattern is empty or won't compile. Matched against the **full** stem, including
   *  the `#pN` suffix an exploded multi-page PDF carries (`_explodePages`) — so a per-page set is
   *  targeted by the page-range controls, and name patterns target the one-file-per-floor sets they
   *  were meant for. */
  static globMatcher(pattern) {
    const src = ImportBulk._globSource(pattern);
    if (src === null) return null;
    let rx;
    try { rx = new RegExp('^' + src + '$', 'i'); } catch (e) { return null; }
    return (s) => rx.test(String(s));
  }

  /** A `stem -> floor number | null` matcher from a glob that must contain `{n}` — the auto-assign
   *  pattern ("everything matching `*-L{n}-*` is floor {n}"). Null when `{n}` is absent or the
   *  pattern won't compile, so the caller can tell "bad pattern" from "matched nothing". */
  static floorPatternMatcher(pattern) {
    if (String(pattern == null ? '' : pattern).indexOf('{n}') === -1) return null;
    const src = ImportBulk._globSource(pattern);
    if (src === null) return null;
    let rx;
    try { rx = new RegExp('^' + src + '$', 'i'); } catch (e) { return null; }
    return (s) => {
      const m = rx.exec(String(s));
      return m && m[1] ? parseInt(m[1], 10) : null;
    };
  }

  /** A `(bb, p) -> boolean` card matcher for one of the unified assign row's selection kinds
   *  (IMPORT-50) — the one place the row's "for ⟨selection⟩" vocabulary is defined:
   *   - `'all'` — every drawing in scope;
   *   - `'unassigned'` — drawings still `type === 'unassigned'` (the wizard's one "no answer yet"
   *     marker, so a deliberate `(none)` is never re-swept);
   *   - `'pages'` — `arg` is an inclusive `[lo, hi]` page range, matched against `p.page` (only an
   *     exploded multi-page set carries one);
   *   - `'names'` — `arg` is a drawing-name glob, compiled by `globMatcher`.
   *  Null for a `'names'` glob that is empty/won't compile (the caller toasts rather than matching
   *  nothing silently) and for an unknown kind. Eligibility (`eligible`) is NOT folded in here —
   *  `_apply` already tests it per card, and doubling it up would let the two drift. */
  static selectionMatcher(kind, arg) {
    if (kind === 'all') return () => true;
    if (kind === 'unassigned') return (bb, p) => bb.assign[p.stem].type === 'unassigned';
    if (kind === 'pages') {
      const [lo, hi] = arg;
      return (bb, p) => !!p.page && p.page >= lo && p.page <= hi;
    }
    if (kind === 'names') {
      const m = ImportBulk.globMatcher(arg);
      return m ? (bb, p) => m(p.stem) : null;
    }
    return null;
  }

  /** Make sure every building in the current bulk scope has its floor Locations loaded before a
   *  positive assign resolves against them. Only the visible building is loaded eagerly
   *  (`_ensureFloors`), so an all-buildings assign would otherwise resolve against `undefined` and
   *  report every other building as unresolved. `_loadFloors` is idempotent and cached. */
  async _ensureScopeFloors(b) {
    await this.ensureFloorsFor(this._scope(b));
  }

  /** `_ensureScopeFloors` for an arbitrary building list — what the background OCR sweep needs
   *  (IMPORT-53), whose batch spans whatever buildings its slice of the queue happened to cover
   *  rather than a bulk scope. `_loadFloors` is idempotent and cached, so a building already
   *  loaded costs nothing. */
  async ensureFloorsFor(buildings) {
    const pending = [...new Set(buildings)].filter(bb => !Array.isArray(bb.nbFloors));
    if (pending.length) await Promise.all(pending.map(bb => this.w._loadFloors(bb)));
  }

  /** Bulk **positive** assign (IMPORT-12): give every card matching `matchFn(bb, p)` the floor
   *  `spec` names, resolved per building by `_resolveFloor`. The counterpart to `_none` —
   *  before this, every bulk path could only set "(none)", so the real floors were still clicked
   *  one at a time. */
  async _assignFloor(b, matchFn, spec) {
    await this._ensureScopeFloors(b);
    this._apply(b, {
      match: matchFn,
      patch: (bb) => this._resolveFloor(bb, spec),
      done: (n) => 'Assigned ' + n + (n === 1 ? ' drawing' : ' drawings'),
      empty: 'No matching drawings to assign.',
    });
  }

  /** Bulk positive assign driven by a `{n}` name pattern: each matching drawing takes the floor its
   *  own captured number names, so a regularly-named set (`BLDG-L{n}-PLAN`) maps in one gesture
   *  instead of one click per floor. Unlike blind positional numbering (the removed "Number floors
   *  1…N", which was wrong the moment non-floor sheets were interleaved) a drawing whose name
   *  doesn't match is simply left alone. */
  async _assignByPattern(b, matchNum) {
    await this._ensureScopeFloors(b);
    this._apply(b, {
      match: (bb, p) => matchNum(p.stem) !== null,
      patch: (bb, p) => this._resolveFloor(bb, { kind: 'num', n: matchNum(p.stem) }),
      done: (n) => 'Assigned ' + n + (n === 1 ? ' drawing' : ' drawings') + ' by name pattern',
      empty: 'No drawing name matched that pattern.',
    });
  }

  /** Bulk floor-triage for the building header (IMPORT-50): a `.imp-bulk` block of at most two
   *  `.imp-bulk-row`s. Returns null for a trivial single-drawing building, where per-card triage
   *  is already quick — the caller then places `regionBtn` itself.
   *
   *  **Row A — one parameterized assign**: `Set ⟨floor⟩ for ⟨selection⟩ · Apply`. This one
   *  interaction replaces the five separate clusters that had accumulated here (the three (none)
   *  sweeps of IMPORT-9; the positive assign row and the `{n}` auto-assign row of IMPORT-12):
   *   - the **floor** is "(none)" (routing through `_none`), one entry of this building's own
   *     vocabulary (`_floorOptions` — across buildings it re-resolves per building, `_resolveFloor`),
   *     or "floor {n} from name" (`_assignByPattern`: each matching drawing takes the floor its
   *     captured number names, with a live match count so a bulk write is never a surprise);
   *   - the **selection** is every drawing / drawings still unassigned / a page range (exploded
   *     multi-page sets only) / a name glob — each compiled by `selectionMatcher`.
   *   - **Apply to** — the scope select (`_scopeSelect`), shown once the carousel holds more than
   *     one building. Governs every action here, exactly as it always has.
   *
   *  **Row B — floor codes** (`_codesRow`): the per-building region re-mark beside the OCR read,
   *  so the mark-then-read order is visible (IMPORT-31). */
  controls(b, regionBtn) {
    if (b.pdfs.length <= 1) return null;
    // Widgets whose match count depends on the scope, refreshed when the scope select changes.
    const recounts = [];
    // Page numbers are per building, but the scope can span the carousel, so the inputs' ceiling
    // comes from every building a bulk action could reach — never blocking a legal page number.
    const pagesOf = (bb) => bb.pdfs.map(p => p.page || 0).filter(n => n > 0);
    const ownPages = pagesOf(b);
    const scopeMax = Math.max(1, ...this.w._mappableBuildings().flatMap(pagesOf), ...ownPages);
    const num = (val) => Dom.el('input', { type: 'number', class: 'imp-bulk-num',
      min: '1', max: String(scopeMax), value: String(val) });
    // Read an inclusive page range from a pair of inputs, tolerating a reversed one. Null (after
    // toasting) when either side isn't a number, so a caller can just bail.
    const range = (from, to) => {
      let lo = parseInt(from.value, 10);
      let hi = parseInt(to.value, 10);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) { Toast.show('Enter a page range.', true); return null; }
      if (lo > hi) { const t = lo; lo = hi; hi = t; }
      return [lo, hi];
    };

    // ---- the floor half: (none), the building's own vocabulary, or the {n} name pattern ----
    const floorOpts = [{ label: '(none)', kind: 'none' }];
    for (const o of this._floorOptions(b)) floorOpts.push({ label: o.label, kind: 'floor', spec: o.spec });
    floorOpts.push({ label: 'floor {n} from name', kind: 'pattern' });
    const floorSel = Dom.el('select', { class: 'imp-bulk-sel',
      title: 'What to set. (none) leaves a drawing out of the floor set; a floor is re-resolved '
        + 'per building across the scope by slug, then name, then floor number; “floor {n} from '
        + 'name” gives each matching drawing the floor its own captured number names.' },
      floorOpts.map((o, i) => Dom.el('option', { value: String(i) }, o.label)));

    // ---- the selection half ----
    const kinds = [['all', 'every drawing'], ['unassigned', 'drawings still unassigned']];
    if (ownPages.length) kinds.push(['pages', 'pages']);
    kinds.push(['names', 'names matching']);
    const kindSel = Dom.el('select', { class: 'imp-bulk-sel' },
      kinds.map(([v, label]) => Dom.el('option', { value: v }, label)));
    const from = num(1);
    const to = num(ownPages.length ? Math.max(...ownPages) : 1);
    const pageBox = Dom.el('span', { class: 'imp-bulk-range' },
      [from, Dom.el('span', {}, '–'), to]);
    const glob = Dom.el('input', { type: 'text', class: 'imp-bulk-pat',
      placeholder: '*-L03-*', title: 'Drawing-name glob: * matches any run, ? one character.' });
    // The {n} pattern's own input + live match count, swapped in for the selection half while
    // "floor {n} from name" is the chosen floor (its selection IS the pattern).
    const pat = Dom.el('input', { type: 'text', class: 'imp-bulk-pat', placeholder: '*-L{n}-*',
      title: 'Drawing-name glob where {n} captures the floor number: * matches any run, ? one '
        + 'character. Drawings that don’t match are left alone.' });
    const count = Dom.el('span', { class: 'imp-bulk-count' });
    const recount = () => {
      const m = ImportBulk.floorPatternMatcher(pat.value);
      if (!m) { count.textContent = ''; return; }
      let n = 0;
      for (const bb of this._scope(b))
        for (const p of bb.pdfs)
          if (this.eligible(bb, p) && m(p.stem) !== null) n++;
      count.textContent = n + (n === 1 ? ' drawing matches' : ' drawings match');
    };
    pat.addEventListener('input', recount);
    recounts.push(recount);
    const patBox = Dom.el('span', { class: 'imp-bulk-range' }, [pat, count]);

    // One visibility rule: the pattern floor swaps the whole selection half for its {n} input;
    // otherwise the page range / glob follow the selection kind.
    const sync = () => {
      const isPat = (floorOpts[parseInt(floorSel.value, 10)] || {}).kind === 'pattern';
      kindSel.classList.toggle('hidden', isPat);
      patBox.classList.toggle('hidden', !isPat);
      pageBox.classList.toggle('hidden', isPat || kindSel.value !== 'pages');
      glob.classList.toggle('hidden', isPat || kindSel.value !== 'names');
    };
    floorSel.addEventListener('change', sync);
    kindSel.addEventListener('change', sync);
    sync();

    const apply = Dom.el('button', { class: 'imp-floor', onclick: () => {
      const f = floorOpts[parseInt(floorSel.value, 10)];
      if (!f) return;
      if (f.kind === 'pattern') {
        const m = ImportBulk.floorPatternMatcher(pat.value);
        if (!m) { Toast.show('Enter a pattern containing {n}, e.g. *-L{n}-*.', true); return; }
        this._assignByPattern(b, m);
        return;
      }
      let match;
      if (kindSel.value === 'pages') {
        const r = range(from, to);
        if (!r) return;
        match = ImportBulk.selectionMatcher('pages', r);
      } else if (kindSel.value === 'names') {
        match = ImportBulk.selectionMatcher('names', glob.value);
        if (!match) { Toast.show('Enter a drawing-name pattern, e.g. *-L03-*.', true); return; }
      } else {
        match = ImportBulk.selectionMatcher(kindSel.value);
      }
      if (f.kind === 'none') this._none(b, match);
      else this._assignFloor(b, match, f.spec);
    } }, 'Apply');

    const rowA = [Dom.el('span', { class: 'imp-bulk-label' }, 'Set'),
      floorSel, Dom.el('span', { class: 'imp-bulk-word' }, 'for'),
      kindSel, pageBox, glob, patBox, apply];
    const scope = this._scopeSelect(() => recounts.forEach(f => f()));
    if (scope) rowA.push(scope);
    const rows = [Dom.el('div', { class: 'imp-bulk-row' }, rowA)];

    // ---- row B: the floor-code pipeline — mark the region, then read it (IMPORT-31) ----
    const codes = this._codesRow(b, regionBtn);
    if (codes) rows.push(codes);

    return Dom.el('div', { class: 'imp-bulk' }, rows);
  }

  /** The floor-codes row (IMPORT-50): the caller's "Set floor-code region" button (present when
   *  the building has a markable drawing) beside the OCR "Read codes now" — one row, so the
   *  mark-then-read order is visible. Null when neither half applies.
   *
   *  The OCR half needs the install's `ocr` capability and a marked region somewhere in scope —
   *  gating on a marked region (rather than offering it and failing) keeps the same natural order:
   *  mark the code, then read it. It lives among the bulk controls so it inherits the **Apply to**
   *  scope select for free.
   *
   *  Since IMPORT-53 the reading itself belongs to `ImportOcrSweep`, which starts by itself once a
   *  region exists; this button is the operator's way to say **now**, and while a sweep is running
   *  it simply moves this scope to the front of the queue. Stopping lives on the sweep's own
   *  progress strip, which — unlike this row — is on screen for every building. */
  _codesRow(b, regionBtn) {
    const sweep = this.w.ocr;
    const canOcr = sweep.available()
      && this._scope(b).some(bb => bb.codeRegion || this.w._codeRegion);
    if (!regionBtn && !canOcr) return null;
    const children = [Dom.el('span', { class: 'imp-bulk-label' }, 'Floor codes:')];
    if (regionBtn) children.push(regionBtn);
    if (canOcr) {
      const go = Dom.el('button', { class: 'imp-floor',
        title: 'Read the marked code region now on the drawings in scope that still need a floor. '
          + 'This happens on its own in the background — use this to jump the queue.' },
      'Read floor codes now');
      go.addEventListener('click', () => sweep.start(this._scope(b), { manual: true }));
      children.push(go);
    }
    const row = [Dom.el('div', { class: 'imp-bulk-row' }, children)];
    // What this row is for, in words beside it rather than only inside the buttons' tooltips
    // (IMPORT-63): "Set floor-code region" and "Read floor codes now" are two halves of one
    // sequence, and which one to press first is not guessable from either label.
    if (canOcr)
      row.push(Dom.el('div', { class: 'imp-bulk-row hint' },
        'Mark where a drawing prints its floor code, and every drawing is read in the background. '
        + 'A code that reads clearly and names a floor exactly is set for you and marked on its '
        + 'card; anything less certain is offered as a suggestion to confirm.'));
    else if (regionBtn)
      row.push(Dom.el('div', { class: 'imp-bulk-row hint' },
        'Mark where this building’s drawings print their floor code, so its cards show a close-up '
        + 'of just that spot instead of the whole sheet.'));
    return Dom.el('div', { class: 'imp-bulk-codes' }, row);
  }

  /** The bulk-scope select ("Apply to: this building / all N buildings", IMPORT-12). Null until the
   *  floor-mapping carousel holds more than one building, where the choice would be meaningless.
   *  Writes `this.all` and calls `onChange` so scope-dependent match counts stay honest. */
  _scopeSelect(onChange) {
    const n = this.w._mappableBuildings().length;
    if (n <= 1) return null;
    const sel = Dom.el('select', { class: 'imp-bulk-sel',
      title: 'Whether the bulk controls act on this building alone or on every building in the '
        + 'floor-mapping carousel.',
      onchange: (e) => { this.all = e.target.value === 'all'; onChange(); } }, [
      Dom.el('option', { value: 'this' }, 'This building'),
      Dom.el('option', { value: 'all' }, 'All ' + n + ' buildings'),
    ]);
    sel.value = this.all ? 'all' : 'this';   // mark the current scope once options are attached
    return Dom.el('span', { class: 'imp-bulk-scope' },
      [Dom.el('span', { class: 'imp-bulk-word' }, 'Apply to'), sel]);
  }

  /** The floor vocabulary the bulk assign offers, mirroring `_floorButtons` exactly: one entry per
   *  NetBox floor Location in Location mode, else the floor-type fallback (basement / ground /
   *  level 1..N / roof). Each entry pairs its button label with the `spec` `_resolveFloor`
   *  resolves per building. "(none)" is deliberately absent — `controls` prepends it to the
   *  unified row itself, routing it through `_none` rather than a resolve. */
  _floorOptions(b) {
    if (Array.isArray(b.nbFloors) && b.nbFloors.length)
      return b.nbFloors.map(f => ({ label: f.name, spec: { kind: 'loc', slug: f.slug, name: f.name } }));
    if (b.nbFloors === 'loading') return [];
    const out = [
      { label: 'Basement', spec: { kind: 'type', type: 'basement', num: 1 } },
      { label: 'Ground', spec: { kind: 'type', type: 'ground', num: 1 } },
    ];
    for (let i = 1; i <= b.pdfs.length; i++)
      out.push({ label: 'Level ' + i, spec: { kind: 'type', type: 'level', num: i } });
    out.push({ label: 'Roof', spec: { kind: 'type', type: 'roof', num: 1 } });
    return out;
  }
}
