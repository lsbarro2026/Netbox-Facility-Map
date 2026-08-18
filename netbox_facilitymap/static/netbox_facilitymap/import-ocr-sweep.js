'use strict';
/* import-ocr-sweep.js — ImportOcrSweep: the wizard's background floor-code reader (IMPORT-53).

   Reading a floor code used to be something the operator asked for, one building at a time: mark
   the region, walk into a building, press the button, wait for one synchronous request covering
   the whole bulk scope. On a hundred-building facility that is either a hundred presses or one
   very long blocking call. This inverts it — once a usable region exists, every eligible drawing
   in the facility is read automatically, in small batches, with each batch applied as it lands.
   The operator's job becomes "press *Next needing attention* until it goes quiet".

   **Chunked on the client, not queued on the server.** The unit of work stays one
   `POST /api/import/ocr-read`; this slices the facility into `CHUNK`-sized batches and issues them
   **one at a time**. That is what buys streaming behaviour without a job queue or a new async
   runtime: a single in-flight request never ties up several NetBox workers, and no one request is
   long enough to approach `render_timeout_s`. Untrusted parsing does not move — each batch still
   runs in the isolated `ocr.py` subprocess, exactly as a manual read did.

   **Almost nothing here commits anything.** A resolved read lands as `suggested: true,
   suggestedFrom: 'ocr'` through the same `ImportBulk._suggestFrom` a filename guess goes through.
   The one exception is **auto-accept** (IMPORT-63): a read at or above
   `ImportFlow.AUTO_ACCEPT_OCR_CONF` that matched a floor on `_suggestFrom`'s **literal** rung is
   taken as the answer, marked `autoAccepted` so the card says so, and reversible for the whole
   facility in one action (`ImportFlow._undoAutoAccepted`). The inference rungs — ordinal and
   whole-building alignment — never auto-accept however confident the pixels were, because their
   uncertainty is about a *naming system*, which no recognition score measures.

   Three rules keep a background pass from fighting the operator:
     - **Only unanswered drawings are read** — `ImportFlow.isUnanswered`: an explicit `unassigned`,
       an unconfirmed suggestion, or the blind positional default. A floor the operator picked is
       never read, and never written.
     - **Nothing is read twice** — a drawing carrying an `ocrText` has already been answered by a
       read under the current region, so the sweep is idempotent and terminates. Re-marking a
       region (`regionChanged`) is what makes those drawings readable again.
     - **A landed result never overwrites an answer** — the assignment is re-checked at *apply*
       time, so a floor the operator picked while the batch was in flight wins.

   Holds a wizard back-ref (`this.w`), the ImportBulk shape. Lives on the flow rather than on a
   step so a sweep survives `_stepMap()` re-renders and step navigation. */

class ImportOcrSweep {
  /** Drawings per request. Small enough that a batch returns while the operator is still reading
   *  the previous one's results, and far enough under `max_pdfs` (the server's per-request cap,
   *  400 by default) that the endpoint's own bound is never the thing that fails a sweep. */
  static CHUNK = 12;
  /** Consecutive failed batches before the sweep gives up rather than hammering a server that is
   *  plainly not answering. One failure is a drawing that went missing; two in a row is the
   *  server. */
  static MAX_FAILS = 2;
  /** How close two candidate lines' confidences have to be before `pickLine` stops treating the
   *  difference as meaningful and falls back to position. Recognition scores this near each other
   *  say the same thing about legibility; the operator drawing their box around one of the two
   *  lines does not. */
  static CONF_TIE = 0.05;

  constructor(wizard) {
    this.w = wizard;
    this._queue = [];          // targets not yet sent, in send order
    this._total = 0;           // drawings this sweep set out to read
    this._done = 0;            // ...and how many it has finished with (read or failed)
    this._running = false;
    this._cancelled = false;
    // The operator pressed Cancel, or the sweep gave up: don't auto-restart until something
    // changes the picture (a re-marked region, or an explicit read).
    this._suppressed = false;
    // Drawings whose batch failed, keyed as `_key`. Excluded from `targets` for the rest of the
    // session so a sweep can never loop forever retrying the same unreadable drawing.
    this._failed = new Set();
    this._inflight = [];       // the batch currently out — still "reading" for label purposes
    // Bumped by `regionChanged`. A batch that returns under a different generation was read
    // through a box the operator has since replaced, so its answers are about the wrong pixels.
    this._gen = 0;
    this._rearm = false;       // a region change stopped the sweep; restart it once it unwinds
    this._tally = null;        // {read, filled, aligned, failed} for the running sweep
    this._summary = '';        // the finished sweep's one-line result, shown until dismissed
    this._el = null;           // the status strip (created once, re-appended by `_stepMap`)
  }

  /** Whether a sweep is currently issuing batches. */
  get running() { return this._running; }

  /** `(folder, stem)` as one string — a stem is unique only within its building, so two buildings'
   *  identically-named sheets would otherwise collide on a facility-wide pass. The separator is an
   *  **escaped** NUL rather than a literal one: it can never occur inside a folder or stem, and
   *  writing it as a byte makes the source file binary to every tool that scans it. */
  static _key(folder, stem) { return folder + '\u0000' + stem; }

  /** Split `list` into `n`-sized batches, in order. */
  static chunk(list, n) {
    const out = [];
    for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
    return out;
  }

  /** Whether the floor-code reader is usable at all: the install ships the `ocr` capability (the
   *  server's registry decides, the same `window.MAP.capabilities` gate `App.hasCapability` reads)
   *  and some drawing has a region to read. */
  available() {
    const caps = (window.MAP && window.MAP.capabilities) || [];
    if (!caps.includes('ocr')) return false;
    if (this.w._codeRegion) return true;
    return this.w.buildings.some(b => b.codeRegion);
  }

  /** The drawings a sweep over `buildings` would read: eligible for a bulk action (not the site
   *  plan, not region-split), still **unanswered**, not already read under the current region, and
   *  not left over from a failed batch. A building with no region — neither its own override nor
   *  the global one — is skipped rather than read against nothing.
   *
   *  "Unanswered" is `ImportFlow.isUnanswered`, not the bare `type === 'unassigned'` this used to
   *  test (IMPORT-63). That narrower rule made the sweep a **Location-mode-only** feature by
   *  accident: only `_normalizeToLocations` writes `unassigned`, while the floor-type fallback seeds
   *  every drawing with a filename guess or a blind positional Level N (`_defaultAssign`) — so a
   *  fallback-mode facility had no targets at all and the background pass silently read nothing,
   *  facility-wide. A pre-fill nobody has confirmed is not an answer; a floor the operator picked
   *  still is, and is still never read.
   *
   *  Each target carries its **own** region, `ImportRegions.adapt`ed to that drawing's sheet
   *  geometry, so one sweep covers a facility whose buildings mark their title blocks in different
   *  corners and whose sheets are shaped differently (IMPORT-51). */
  targets(buildings) {
    const out = [];
    for (const bb of buildings) {
      const region = bb.codeRegion || this.w._codeRegion;
      if (!region) continue;
      for (const p of bb.pdfs) {
        if (!this.w.bulk.eligible(bb, p)) continue;
        const a = bb.assign[p.stem];
        if (!ImportFlow.isUnanswered(a)) continue;
        if (a.ocrText !== undefined && a.ocrText !== null) continue;
        if (this._failed.has(ImportOcrSweep._key(bb.folder, p.stem))) continue;
        out.push({ bb, p, item: { folder: bb.folder, stem: p.stem, path: p.pdf,
          page: p.page || 0, region: ImportRegions.adapt(region, ImportRegions.pageGeom(p)) } });
      }
    }
    return out;
  }

  /** How many of building `b`'s drawings this sweep still owes a read. Drives the "reading…"
   *  marker in the carousel label, so a building the sweep simply hasn't reached yet never reads
   *  as a building OCR found nothing in. */
  queuedCount(b) {
    const mine = (t) => (t.bb === b ? 1 : 0);
    return this._queue.reduce((n, t) => n + mine(t), 0)
      + this._inflight.reduce((n, t) => n + mine(t), 0);
  }

  /** Whether building `b` is still waiting on the sweep. */
  isQueued(b) { return this.queuedCount(b) > 0; }

  /** Where building `b` stands with the floor-code reader — `{state, read, pending}` (IMPORT-63).
   *  `state` is one of:
   *    - `off`       — the install can't read codes, or nothing is marked anywhere;
   *    - `no-region` — codes are being read elsewhere, but this building has no box to read
   *                    (no override, and no global region), so it is skipped entirely;
   *    - `reading`   — queued or in flight right now;
   *    - `pending`   — eligible drawings remain that this sweep hasn't reached;
   *    - `done`      — nothing left owed, whether that is because everything was read or because
   *                    everything was already answered.
   *
   *  The point is `pending` versus `done`: the operator can otherwise not tell a building the
   *  sweep simply hasn't got to from one it read and found nothing in, and will work through the
   *  apparently-clear ones only to have them fill in behind them. `_buildingNavLabel` says this for
   *  the carousel's current window; this is the same answer for any building, which is what lets
   *  `ImportOverview` show the sweep's coverage across a whole 150-building facility. */
  coverage(b) {
    if (!this.available()) return { state: 'off', read: 0, pending: 0 };
    if (!(b.codeRegion || this.w._codeRegion)) return { state: 'no-region', read: 0, pending: 0 };
    let read = 0, pending = 0;
    for (const p of b.pdfs) {
      if (!this.w.bulk.eligible(b, p)) continue;
      const a = b.assign[p.stem];
      if (!a) continue;
      if (a.ocrText !== undefined && a.ocrText !== null) { read++; continue; }
      if (!ImportFlow.isUnanswered(a)) continue;                      // answered: nothing owed
      if (this._failed.has(ImportOcrSweep._key(b.folder, p.stem))) continue;   // written off
      pending++;
    }
    if (this.isQueued(b)) return { state: 'reading', read, pending };
    return { state: pending ? 'pending' : 'done', read, pending };
  }

  /** Start a facility-wide sweep by itself, if there is one to run. Called on every map-step
   *  render and once each sweep drains, so a region marked mid-session, a building bound later, or
   *  a freshly uploaded drawing is picked up without the operator asking. Silent when it declines:
   *  this is the automatic path, and a toast per render would be noise. */
  autoStart() {
    if (this._running || this._suppressed || !this.available()) return;
    this.start(this.w._mappableBuildings());
  }

  /** Begin (or extend) a sweep over `buildings`. `opts.manual` marks the operator's own "Read
   *  codes now", which reports what it decided rather than staying silent, and — while a sweep is
   *  already running — moves that scope to the front of the queue instead of starting a second
   *  one, so "read the building I'm looking at" is answered next. */
  start(buildings, opts = {}) {
    if (this._running) {
      if (opts.manual) {
        this._prioritize(buildings);
        Toast.show('Already reading floor codes — these drawings are next.');
      }
      return;
    }
    const queue = this.targets(buildings);
    if (!queue.length) {
      if (opts.manual)
        Toast.show('Nothing to read — every drawing in scope already has a floor or a read.', true);
      return;
    }
    this._queue = queue;
    this._total = queue.length;
    this._done = 0;
    this._cancelled = false;
    this._summary = '';
    this._tally = { read: 0, filled: 0, aligned: 0, accepted: 0, noFloor: 0, failed: 0 };
    this._run();      // deliberately not awaited: the whole point is that it runs alongside
  }

  /** Stop after the batch in flight. The operator's own Stop also **suppresses** the automatic
   *  restart — they said stop, so nothing runs again until a region changes or they ask for a read
   *  explicitly. A caller stopping the sweep to get it out of the way of something else (a
   *  rebuild, an add-drawings upload) passes `{suppress: false}`, so the facility keeps being read
   *  once that is done. */
  cancel(opts = {}) {
    if (this._running) { this._cancelled = true; }
    if (opts.suppress !== false) this._suppressed = true;
    this._paint();
  }

  /** Forget everything about this import's reads — for "Start over", which wipes the working dir
   *  the previews were rendered from and rebuilds the model from nothing. */
  reset() {
    this.cancel({ suppress: false });
    this._queue = [];
    this._inflight = [];
    this._failed.clear();
    this._summary = '';
    this._tally = null;
    this._paint();
  }

  /** Move `buildings`' queued targets to the front, preserving order within each half. */
  _prioritize(buildings) {
    const wanted = new Set(buildings);
    const front = [], back = [];
    for (const t of this._queue) (wanted.has(t.bb) ? front : back).push(t);
    this._queue = front.concat(back);
  }

  /** A code region was just (re-)marked: drop the reads it invalidates so they are taken again,
   *  and re-arm the automatic sweep. `building` scopes it to that building's own override; null is
   *  the global region, which reaches every building that hasn't overridden it. Only *unanswered*
   *  drawings are cleared — a read sitting beside a floor the operator chose is a record of what
   *  the region said, and re-reading it would tell them nothing new. */
  regionChanged(building) {
    const scope = building ? [building]
      : this.w._mappableBuildings().filter(bb => !bb.codeRegion);
    for (const bb of scope) {
      for (const p of bb.pdfs) {
        const a = bb.assign[p.stem];
        if (!ImportFlow.isUnanswered(a)) continue;
        delete a.ocrText;
        delete a.ocrConf;
        delete a.ocrNoFloor;
        this._failed.delete(ImportOcrSweep._key(bb.folder, p.stem));
      }
    }
    this._suppressed = false;
    // A sweep already under way is reading through the old box, so stop it and start again over
    // freshly derived targets. The generation bump is what disowns the batch already in flight.
    this._gen++;
    if (this._running) { this._cancelled = true; this._rearm = true; }
  }

  /** The batch loop: take a batch, read it, apply it, repeat until the queue drains or the
   *  operator cancels. A batch that fails is recorded and skipped rather than sinking the sweep;
   *  `MAX_FAILS` consecutive failures stop it and say why. */
  async _run() {
    this._running = true;
    let fails = 0;
    this._paint();
    while (this._queue.length && !this._cancelled) {
      const batch = this._queue.splice(0, ImportOcrSweep.CHUNK);
      this._inflight = batch;
      const gen = this._gen;
      let res;
      try {
        res = await Api.post('/api/import/ocr-read',
          { region: batch[0].item.region, items: batch.map(t => t.item) });
      } catch (e) {
        console.error('Floor-code read failed for a batch of drawings', e);
        this._giveUp(batch);
        this._done += batch.length;
        this._inflight = [];
        if (++fails >= ImportOcrSweep.MAX_FAILS) {
          this._suppressed = true;
          Toast.show('Stopped reading floor codes: ' + ((e && e.message) || e)
            + ' Use “Read codes now” to try again.', true);
          break;
        }
        this._paint();
        continue;
      }
      fails = 0;
      if (gen !== this._gen) break;   // read through a region the operator has since re-marked
      // `_suggestFrom` resolves against the building's floor Locations, so a building the operator
      // has never opened must have them loaded before its reads are applied (idempotent + cached).
      await this.w.bulk.ensureFloorsFor(batch.map(t => t.bb));
      // Not gated on `_cancelled`: these reads are already paid for, and dropping them would lose
      // work the operator would only have to re-request. Cancel stops the *next* request.
      const out = this.applyResults(batch, res && res.results);
      this._done += batch.length;
      this._tally.read += out.read;
      this._tally.filled += out.filled;
      this._tally.aligned += out.aligned;
      this._tally.accepted += out.accepted;
      this._tally.noFloor += out.noFloor;
      // Anything the server didn't answer for stays blank, which would make it a target again on
      // the next pass — and a sweep that keeps re-queueing the same drawing never terminates.
      this._giveUp(batch.filter(t => {
        const a = t.bb.assign[t.p.stem];
        return !a || a.ocrText === undefined || a.ocrText === null;
      }));
      this._inflight = [];
      await this.w._saveDraft();
      this._repaint(out.touched);
    }
    this._running = false;
    this._queue = [];
    this._inflight = [];
    this._summary = this._summaryLine();
    this._paint();
    // Pick up whatever became eligible while this pass ran (a building bound to NetBox), and
    // restart outright when a region change stopped it (`_rearm`) — that is the one cancel the
    // sweep does resume from, since the operator re-marked a box precisely to have it read. Each
    // pass strictly consumes targets — a read one is never a target again — so this converges
    // rather than looping.
    const rearm = this._rearm;
    this._rearm = false;
    if (!this._cancelled || rearm) this.autoStart();
  }

  /** Write off `batch`'s drawings for this session: counted as finished, and never re-queued. */
  _giveUp(batch) {
    for (const t of batch) this._failed.add(ImportOcrSweep._key(t.item.folder, t.item.stem));
    if (this._tally) this._tally.failed += batch.length;
  }

  /** Choose which line of one drawing's read actually named a floor, as
   *  `{text, confidence, guess, noFloor}` (`guess` null when none of them did).
   *
   *  The reader returns the marked region's text lines **separately** rather than joined, because
   *  a region drawn around a floor code routinely catches a neighbouring row of the title block
   *  too ("Floor 3" over "Development   MAY 2025"), and one joined string is both unparseable and
   *  scored on characters that had nothing to do with the code. So the vocabulary question is
   *  answered here, over every candidate: `ImportBulk.floorFromText` is the same parser the
   *  filename axis uses, and it stays the *only* one — the server deliberately knows nothing
   *  about floors, which is what keeps the two from drifting apart.
   *
   *  Among the lines that parse, the most confident wins; within `CONF_TIE` of each other the
   *  more **centred** one does, since the operator drew their box around the code they wanted.
   *  With nothing parsing, the server's own best candidate is reported, so the card's chip still
   *  says what the region held — and an empty read stays an empty string, which is what tells the
   *  sweep this drawing has been read and must not be queued again.
   *
   *  A result carrying no `lines` at all is treated as a single candidate. That branch is
   *  permanent, not a migration step: a drawing whose every line was rejected as implausible
   *  legitimately comes back with an empty `text` and no lines.
   *
   *  **`noFloor` separates the two ways a read fails** (IMPORT-71). "The region held nothing
   *  legible" and "the region held text, and none of it named a floor" look identical on the card
   *  today, and the second is the one that means something: it is what a code region sitting over
   *  the *building name* — not the floor caption — produces, at high confidence, on every drawing
   *  in a building at once. Reported as a flag rather than by blanking the text, because the text
   *  is the evidence: seeing `Administration` is what tells the operator where the box landed. */
  static pickLine(r) {
    const cands = (r.lines && r.lines.length)
      ? r.lines : [{ text: r.text, confidence: r.confidence, y: 0.5 }];
    let best = null;
    for (const c of cands) {
      const guess = ImportBulk.floorFromText(c.text);
      if (!guess) continue;
      const cand = { text: c.text || '', confidence: c.confidence || 0,
        y: typeof c.y === 'number' ? c.y : 0.5, guess };
      if (!best) { best = cand; continue; }
      const tied = Math.abs(cand.confidence - best.confidence) <= ImportOcrSweep.CONF_TIE;
      if (tied ? Math.abs(cand.y - 0.5) < Math.abs(best.y - 0.5)
        : cand.confidence > best.confidence) best = cand;
    }
    if (best) return Object.assign(best, { noFloor: false });
    return { text: r.text || '', confidence: r.confidence || 0, guess: null,
      // Only text that was actually read counts as "named no floor" — an empty crop stays the
      // plain "couldn't read" it has always been.
      noFloor: cands.some(c => (c.text || '').trim() !== '') };
  }

  /** Shortest normalized string `isOwnName` will match a building name on, from either side.
   *  Containment makes a short read match almost anything — `ad` sits inside `administration` — and
   *  a chip asserting "that's the building's name" has to be right. */
  static MIN_NAME_MATCH = 4;

  /** Whether `text` is just the name building `bb` is already known by — its folder, the name the
   *  operator gave it, or the NetBox Site/Location it is bound to (IMPORT-71).
   *
   *  Not part of choosing a line: a building name never parses as a floor, so it can never win the
   *  guess, and blanking it would throw away the evidence. This is the *diagnosis* — a `noFloor`
   *  read that turns out to be the building's own name is the signature of a code region marked on
   *  one sheet whose floor caption sits elsewhere on the rest (the `1.9.0` region-drift finding),
   *  and it is the one failure a per-building `codeRegion` override fixes outright.
   *
   *  Matched on `ImportBulk._normName`'s comparable core — the same case/punctuation fold the floor
   *  rungs use — and by containment either way, since a title block prints `CAL POLY Cotchett
   *  Education Building` where NetBox holds `Cotchett Education Building`. */
  static isOwnName(text, bb) {
    const t = ImportBulk._normName(text);
    if (t.length < ImportOcrSweep.MIN_NAME_MATCH || !bb) return false;
    const names = [bb.folder, bb.name, bb.nbSite && bb.nbSite.name,
      bb.nbBuilding && bb.nbBuilding.name];
    return names.some(raw => {
      const n = ImportBulk._normName(raw);
      return n.length >= ImportOcrSweep.MIN_NAME_MATCH
        && (n.indexOf(t) !== -1 || t.indexOf(n) !== -1);
    });
  }

  /** Fold one batch's results into the model, and report `{read, filled, aligned, accepted,
   *  noFloor, touched}`. Model-only: no DOM, no persistence, no toast — the caller owns those,
   *  which is what
   *  keeps this half unit-testable.
   *
   *  The **raw read is recorded on every drawing that came back** (`ocrText`/`ocrConf`, the `1.8.0`
   *  shape), including one the operator answered mid-flight: the card chip is a record of what the
   *  region said, and a faint read is diagnosable only if it is kept. The **suggestion**, though,
   *  is offered only where the drawing is *still* unanswered at this moment — that re-check is
   *  the anti-clobber rule, and it is why this reads the live assignment rather than the one
   *  `targets` captured. Reads are then resolved a **building at a time**, because
   *  `_suggestFrom`'s alignment rung matches a building's reads as a set (IMPORT-52).
   *
   *  **Auto-accept (IMPORT-63)** rides that same pass rather than being a second one: each target
   *  carries its own read confidence, and `_suggestFrom`'s `accept` hook takes the answer outright —
   *  no `suggested` flag, an `autoAccepted` marker instead — for a read at or above
   *  `ImportFlow.AUTO_ACCEPT_OCR_CONF` that matched a floor on the **literal** rung. The hook is
   *  consulted only there by construction, so the ordinal and alignment rungs, which are inferences
   *  about a naming system rather than a reading of the sheet, stay suggestions however confident
   *  the pixels were.
   *
   *  Which of a result's **candidate lines** drives all of that is `pickLine`'s decision, and it
   *  is what the drawing's `ocrText`/`ocrConf` record — the line that named the floor, not a
   *  transcript of the whole region.
   *
   *  A read that found text naming no floor also records `ocrNoFloor` (IMPORT-71). One extra
   *  boolean, on the drawings it applies to — deliberately not the full `lines` array, which
   *  `_saveDraft` would then carry per drawing across a facility of thousands. Whether that text
   *  is the building's *own name* is re-derived at render time from `isOwnName` rather than stored
   *  a second time. */
  applyResults(batch, results) {
    const byKey = new Map();
    for (const r of (results || []))
      byKey.set(ImportOcrSweep._key(r.folder, r.stem), r);
    const perBuilding = new Map();
    const touched = new Set();
    let read = 0, noFloor = 0;
    for (const t of batch) {
      const r = byKey.get(ImportOcrSweep._key(t.item.folder, t.item.stem));
      if (!r) continue;
      const a = t.bb.assign[t.p.stem];
      if (!a) continue;
      const pick = ImportOcrSweep.pickLine(r);
      a.ocrText = pick.text || '';
      a.ocrConf = pick.confidence || 0;
      if (pick.noFloor) { a.ocrNoFloor = true; noFloor++; } else delete a.ocrNoFloor;
      read++;
      touched.add(t.bb);
      if (!pick.guess || !ImportFlow.isUnanswered(a)) continue;
      if (!perBuilding.has(t.bb)) perBuilding.set(t.bb, []);
      perBuilding.get(t.bb).push({ a, guess: pick.guess, done: false, conf: a.ocrConf });
    }
    let filled = 0, aligned = 0, accepted = 0;
    for (const [bb, reads] of perBuilding) {
      const out = this.w.bulk._suggestFrom(bb, reads, 'ocr',
        { accept: (t) => t.conf >= ImportFlow.AUTO_ACCEPT_OCR_CONF });
      filled += out.filled;
      aligned += out.aligned;
      accepted += out.accepted;
    }
    return { read, filled, aligned, accepted, noFloor, touched };
  }

  /** The finished sweep's one line, honest about every outcome: what was read, what that set
   *  outright, what it merely suggested, and what could not be read at all. The auto-accepted count
   *  is named separately from the suggested one because the two ask different things of the
   *  operator — one is a floor already committed on their behalf and worth spot-checking, the other
   *  is still waiting on them (IMPORT-63).
   *
   *  "Named no floor" is counted apart from "could not be read" (IMPORT-71), and when it dominates
   *  the pass it takes over the closing advice. A whole facility coming back with legible text that
   *  names no floor is not a recognition problem at all — it is a code region marked over the wrong
   *  part of the title block, which no amount of re-running fixes and which the operator can only
   *  act on if the sweep says so. */
  _summaryLine() {
    const t = this._tally || { read: 0, filled: 0, aligned: 0, accepted: 0, noFloor: 0,
      failed: 0 };
    const bits = ['Read ' + t.read + (t.read === 1 ? ' drawing' : ' drawings')];
    if (t.accepted)
      bits.push(t.accepted + (t.accepted === 1 ? ' floor set automatically' : ' floors set automatically')
        + ' from a confident code');
    if (t.filled)
      bits.push(t.filled + (t.filled === 1 ? ' floor suggested' : ' floors suggested')
        + (t.aligned ? ' (' + t.aligned + ' by floor order)' : ''));
    if (!t.accepted && !t.filled) bits.push('no floors matched');
    if (t.noFloor) bits.push(t.noFloor + ' read text that named no floor');
    if (t.failed) bits.push(t.failed + ' could not be read');
    return bits.join(' · ') + (this._cancelled ? ' · stopped' : '') + '. '
      + ImportOcrSweep._closingAdvice(t);
  }

  /** The one sentence the summary closes on: the single thing this pass most needs the operator to
   *  do. Ordered by how much it costs to get wrong — a floor committed on their behalf outranks a
   *  misplaced region, which outranks the standing "confirm the suggestions". */
  static _closingAdvice(t) {
    if (t.accepted)
      return 'Automatic floors are marked on their cards — use “Undo automatic floors” to turn '
        + 'them back into suggestions.';
    if (t.noFloor && !t.filled)
      return 'Text that names no floor usually means the marked region sits over the wrong part of '
        + 'the title block on these sheets — check a card’s read, then re-mark the code region over '
        + 'the floor caption, or give that building its own region.';
    return 'Every suggestion is yours to confirm.';
  }

  // ---- the status strip ----

  /** The map step's sweep strip — progress + Cancel while running, the last sweep's summary
   *  afterwards, nothing at all when idle. One node, created once and re-appended by every
   *  `_stepMap()` render, so its state survives a re-render without being rebuilt from it. */
  statusEl() {
    if (!this._el) this._el = Dom.el('div', { class: 'imp-ocr-sweep' });
    this._paint();
    return this._el;
  }

  /** Repaint the strip from the sweep's own state. Safe before the strip exists (a sweep can be
   *  running while the operator is on another step). */
  _paint() {
    const el = this._el;
    if (!el) return;
    el.textContent = '';
    el.classList.toggle('hidden', !this._running && !this._summary);
    if (this._running) {
      el.append(Dom.el('span', { class: 'imp-ocr-progress' },
        'Reading floor codes — ' + this._done + ' of ' + this._total + ' drawings…'));
      el.append(Dom.el('button', { class: 'imp-link',
        onclick: () => this.cancel() }, 'Stop'));
      return;
    }
    if (this._summary) {
      el.append(Dom.el('span', {}, this._summary));
      el.append(Dom.el('button', { class: 'imp-link', title: 'Dismiss this summary.',
        onclick: () => { this._summary = ''; this._paint(); } }, 'Dismiss'));
    }
  }

  /** Fold a landed batch into the map step: the visible building's cards, the build gate (which
   *  carries the overview panel's facility-wide counts with it — `_refreshBuildActions`, BUG-3),
   *  the carousel labels, and the strip. The card grid is rebuilt **only when this batch changed it**
   *  — re-rendering under the operator every few seconds would be exactly the interruption a
   *  background sweep exists to avoid. A no-op away from the map step (the sweep keeps running;
   *  there is simply nothing of it on screen), which also keeps `_rerenderBuildingSection`'s
   *  full-render fallback from yanking the operator back here. */
  _repaint(touched) {
    const w = this.w;
    if (!(w._mapView && w._mapView.isConnected)) return;
    const visible = w._mappableBuildings()[w._bIdx];
    if (visible && touched.has(visible)) w._rerenderBuildingSection(visible);
    else w._refreshBuildActions();
    w._refreshBuildingNavs();
    this._paint();
  }
}
