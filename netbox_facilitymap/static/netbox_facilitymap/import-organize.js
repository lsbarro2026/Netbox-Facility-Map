'use strict';
/* import-organize.js — ImportOrganize: the import wizard's **Buildings step** (IMPORT-34) — the one
   screen of the fresh flow where drawings are organized into buildings AND those buildings are
   anchored to NetBox. It merges the old "Organize drawings into buildings" detour (IMPORT-3) with
   the old fresh-flow bind step, so a flat upload no longer answers the same question on two
   screens in a row. The step has two entry modes, decided by `_isPile`:

     • **pile** — a one-folder upload the wizard can't read as a building: one row per drawing
       with the filename proposals (IMPORT-18/IMPORT-21), the operator-pick correction memory
       (IMPORT-22), the exclude control (IMPORT-24) and the unanswered-first toggle (IMPORT-33).
     • **grouped** — a foldered upload (or a one-folder upload that IS a building): one collapsed
       group per folder, the NetBox anchor control (`ImportBind._bindRow` — the same one the edit
       hub renders, so the picker exists once) on each group's header, and the per-drawing rows
       behind an expander so a misfiled drawing can be moved without re-uploading. Sized for the
       campus case (IMPORT-58): a progress line and a needs-attention-first toggle over the cards,
       each card's anchor search collapsed behind **Change**.

   Continue routes every pending move through the same server regroup either way; a pile's
   Continue lands back here in the grouped presentation, carrying the picks as bindings
   (IMPORT-25) — the same stepper entry, never a second screen re-asking. When those carried
   bindings leave the landing with nothing at all to ask, it isn't shown: the step hands straight on
   with a receipt toast (IMPORT-46, `groupedNeedsAttention`), the regroup landing being the one
   entry allowed to do that.

   Holds a wizard back-ref (`this.w`), the ImportUploader shape: it renders through the flow's
   `_stage` (stepKey `'sites'`), routes through `_stepCampus`/`_stepMap`, and mutates the building
   model only through the flow's own binding methods (`_bindSite`/`_bindBuilding`). The flow
   reaches it as `this.organize` — `FreshImportFlow._stepBuildings` routes here (`step()`),
   `ImportBind._carriedPick` reads `_organizePicks`, and `_reset()` clears the session state via
   `reset()`. `step()`'s guard chain and `_render`'s grouped preamble call into `ImportBind`'s
   shared `_guardCampus`/`_guardLoad`/`bindPreamble` (IMPORT-41) rather than keeping their own
   copies of the campus detour, the guard-then-re-render loading passes, and the hint/carried-note/
   org-mode-note/campus-row preamble — this screen's own extra candidate-fetch guard and its pile
   presentation are what remain unique to it. */

class ImportOrganize {
  constructor(wizard) {
    this.w = wizard;
    // What the operator has already told the pile presentation, keyed by `ImportMatch.memoryKey`
    // (IMPORT-22): `Map<stem key, {folder, label}>`. Every hand-pick is a free labelled example,
    // and a flat pile repeats the same question once per floor — this is where the answer is kept
    // so a sibling drawing doesn't have to ask it again.
    //
    // **Scoped to this import session, deliberately.** It lives on the wizard instance and nowhere
    // else: not in the draft, not in storage, cleared by the flow's `_reset()` (via `reset()`). A
    // correction carried over from a previous import would be a confident answer about a
    // *different* facility's buildings, which is worse than no signal at all. Persisting it is a
    // decision to take on its own evidence, not a default to drift into.
    this._assignMemory = new Map();
    // Everything the operator has answered on this step's rows, keyed the same `<folder>\n<file>`
    // way `_render` keys its files (IMPORT-42): the destination each drawing is assigned to, which
    // of those the wizard filled in (`accepted`) and which of *those* came from the correction
    // memory rather than a filename (`learned`), the rows deliberately emptied, the drawings left
    // out of the map (`excluded`), the building names typed by hand (`created`), each row's
    // pan/zoom framing (`frames`), and the two view orderings — the pile's unanswered-first
    // (`unansweredFirst`) and the grouped presentation's needs-attention-first (`attentionFirst`).
    //
    // **On the instance because navigation must not be an eraser.** All of it used to be `const`s
    // inside `_render`, so any path that re-entered the step — the stepper's Back, the campus-row
    // detour, a return from Upload — rebuilt it empty: exclusions came back, a deliberate **Undo N
    // prefilled** was silently re-prefilled, hand-added names vanished from every picker. Since the
    // containers are mutated in place, `_render` destructures this object and every existing write
    // lands here.
    //
    // **Session-scoped, like `_assignMemory` and for the same reason** (IMPORT-22): these are
    // answers about *these* drawings, and what has to survive a reload is what they produce — the
    // regrouped folders and the bindings — which already does. Cleared by `reset()`, and by
    // `_regroup`, whose re-scan renames the folders the keys are built from.
    this._answers = ImportOrganize.emptyAnswers();
    // Which NetBox object each destination folder was picked from (IMPORT-25):
    // `Map<folder, {anchor, confirmed}>`. The pickers offer real NetBox buildings, but a
    // destination is stored as a bare `{folder, label}` — so the fact that the operator *chose one*
    // used to die at the regroup, and the binding was re-derived by name search and handed back as
    // a guess to confirm. This is that fact, kept: `anchor` is the row in the shape
    // `_bindSite`/`_bindBuilding` take, `confirmed` whether an operator action stands behind it (a
    // hand-pick or a **Use**) rather than a filename prefill.
    //
    // **Session-scoped, and deliberately not in the draft.** What has to survive a reload is the
    // *binding* this produces, and that already does — `_bindFromOrganizePicks` writes it to
    // `nbSite`/`nbBuilding`, which the draft persists. Storing the provenance too would be a second
    // copy of the same answer, free to drift from it. Cleared by `reset()`, like `_assignMemory`.
    this._organizePicks = new Map();
    // The facility's candidate buildings the filename matcher scores against and the per-drawing
    // pickers offer, fetched once per entry to the step (`_loadBuildingCandidates` documents the
    // `{rows, complete, empty}` shape). `undefined` = not fetched yet; invalidated by `_regroup`,
    // which re-identifies the buildings.
    this._assignCands = undefined;
    // Per-folder expansion overrides for the grouped presentation (IMPORT-34): `Map<folder, bool>`,
    // consulted before the per-render defaults (a lone group and a `focusBuilding` target open
    // expanded, a pending new group too, everything else collapsed). View state and nothing else —
    // no assignment or binding moves with it — kept on the instance because the step fully
    // re-renders on every bind pick, and session-only: cleared by `reset()` and by `_regroup`,
    // whose re-scan renames the folders it is keyed by.
    this._expanded = new Map();
    // Whether the organize question has been answered for this upload — a regroup ran, or the
    // operator deliberately kept a one-folder pile together. Once true the step opens grouped:
    // re-showing the pile would re-ask what was just answered, which is the two-screens bug this
    // step exists to remove (IMPORT-34). Session-only (the regrouped folders themselves are what
    // survive a reload — a re-scan of them never reads as a pile again); cleared by `reset()`.
    this._organized = false;
  }

  /** The regroup payload for one round of destinations: `{ destFolder: [<src>/<file>, …] }` with
   *  an excluded drawing routed to the reserved `ImportFlow.EXCLUDED_FOLDER` (IMPORT-24) and every
   *  no-op — a drawing staying in its own folder, or one with no destination at all — dropped, so
   *  an **empty** result is exactly "nothing moves". Each entry is
   *  `{src, file, dest, excluded}`: the drawing's current folder, its filename, the destination
   *  folder picked for it (falsy = unanswered), and whether it was excluded. Pure and static so the
   *  move/no-move partition — what decides whether Continue regroups or walks forward — is
   *  pinned down by the unit tier. */
  static regroupPayload(entries) {
    const payload = {};
    for (const e of entries) {
      const dest = e.excluded ? ImportFlow.EXCLUDED_FOLDER : e.dest;
      if (!dest || dest === e.src) continue;
      (payload[dest] || (payload[dest] = [])).push(e.src + '/' + e.file);
    }
    return payload;
  }

  /** The Buildings step's one-line "what did the upload+scan recognize" banner text (IMPORT-38) — a
   *  pure function of the counts `_render` already has to hand, so the unit tier can pin the
   *  wording down without a DOM. Answers exactly the question the pile/grouped divergence raises
   *  and otherwise never explains: a foldered upload became `buildingCount` buildings, or a flat
   *  pile stayed one folder of `fileCount` drawings still needing to be sorted — plus whether a
   *  loose top-level drawing was also recognized as the site plan (`hasSiteplan`, `this.w.site.file`
   *  in the caller). */
  static recognizedBannerText(buildingCount, grouped, fileCount, hasSiteplan) {
    const base = grouped
      ? 'Read your upload as ' + buildingCount + ' building' + (buildingCount === 1 ? '' : 's')
      : 'Read your upload as one unsorted folder of ' + fileCount + ' drawing'
        + (fileCount === 1 ? '' : 's');
    return base + (hasSiteplan ? ', plus a site plan.' : '.');
  }

  /** A fresh, empty answer store (IMPORT-42) — the shape `this._answers` holds and `_render`
   *  destructures. Built here rather than inline in two places so the constructor, `reset()` and
   *  `_regroup` can't drift apart on which containers exist. */
  static emptyAnswers() {
    return {
      assign: {},              // file → {folder, label}; absent = unassigned
      accepted: new Set(),     // files the wizard filled in (prefill or recall), not the operator
      learned: new Map(),      // file → dest, of the accepted ones that came from `_assignMemory`
      emptied: new Set(),      // files the operator deliberately cleared back to blank
      excluded: new Set(),     // files left out of the map entirely (IMPORT-24)
      created: [],             // {folder, label} building names typed by hand
      frames: {},              // file → {scale, x, y} thumbnail pan/zoom
      unansweredFirst: false,  // the pile's unanswered-first ordering (IMPORT-33)
      attentionFirst: false,   // the grouped presentation's needs-attention-first ordering (IMPORT-58)
    };
  }

  /** Drop every answer whose drawing the current scan no longer has, and hand the store back.
   *
   *  The keys are `<folder>\n<file>`, so they only mean anything against the scan they were made
   *  under. A step back to **Upload** that removes a drawing (or replaces the upload) leaves this
   *  store holding answers about files that are gone — harmless in the pickers, but they would
   *  survive into the Continue gate's counts and the regroup payload as moves of nothing. Adding a
   *  file is deliberately **not** a reason to drop anything: keeping the other answers across that
   *  round trip is the whole point of the store (IMPORT-42).
   *
   *  Mutates in place (the caller's containers are the live ones every control writes through) and
   *  leaves `created`/`unansweredFirst`/`attentionFirst` alone — none is keyed by file. Pure apart
   *  from that, so the unit tier can pin the pruning rule down. */
  static pruneAnswers(answers, files) {
    const live = new Set(files);
    for (const k of Object.keys(answers.assign)) if (!live.has(k)) delete answers.assign[k];
    for (const k of Object.keys(answers.frames)) if (!live.has(k)) delete answers.frames[k];
    for (const set of [answers.accepted, answers.emptied, answers.excluded])
      for (const k of [...set]) if (!live.has(k)) set.delete(k);
    for (const k of [...answers.learned.keys()]) if (!live.has(k)) answers.learned.delete(k);
    return answers;
  }

  /** Whether the **grouped** presentation would actually ask the operator anything (IMPORT-46) —
   *  the predicate behind the regroup landing's auto-advance, and the reason it is safe. A regroup
   *  that lands with every building already answered draws N collapsed, already-confirmed cards
   *  above an enabled Continue: a screen whose only content is a button, which is the ceremony the
   *  pile's picks were carried forward (IMPORT-25) to remove. One building needing anything at all
   *  puts the screen back.
   *
   *  `buildings` is `_floorBuildings()`; the rest is the state the group headers render from —
   *  `ImportBind._assignments`, the active facility slug, the install's grouping, and whether the
   *  facility is declared `site-as-campus`. True when **any** building would show something to
   *  answer or heed:
   *    • **unbound** — a hand-typed "New building name" creation arrives with no anchor, which is
   *      what "Bind every building to NetBox first." already gates Continue on;
   *    • **`auto`-bound** — the storage form of *unconfirmed*: `_bindFromOrganizePicks` binds an
   *      operator's own pick `auto: false` and a filename prefill they never touched `auto: true`,
   *      as does every `_autoMapBuildings` hit, and the header's "Confirm or change" review is
   *      exactly what must not be skipped. (`_allBuildingsBound()` only checks `nbSite`, so it is
   *      **not** this predicate.)
   *    • a **pending or foreign facility assignment** (MULTI-6) — the grouped presentation is the
   *      only place `ImportBind._facilityRow` renders in the fresh flow, so walking past a
   *      `'suggest'` confirm would strand it and past an `'other'` warning would hide it. Asked
   *      **per building** even though the control may be hoisted into one preamble row (IMPORT-56):
   *      the hoist only fires when every bound building shares one Site, so each yields that Site's
   *      one verdict and the question this asks is unchanged by where the answer is drawn;
   *    • a **campus-mode Site anchor** — `_bindRow`'s advisory that a folder bound to a Site under a
   *      "Site = campus" facility probably wanted a building Location. Advisory, and near
   *      unreachable here (campus mode's candidates are Locations, so a carried pick binds
   *      `nbBuilding`) — but the contract this function states is "the screen shows nothing worth a
   *      look", and a rendered warning nobody sees would break it.
   *
   *  Pure and static, like `regroupPayload`/`recognizedBannerText`, so the unit tier pins down the
   *  one judgement a skipped screen turns on. */
  static groupedNeedsAttention(buildings, assignments, active, grouping, campusMode) {
    // `hoisted` null on purpose: this asks whether the *screen* would ask anything, and a facility
    // control hoisted into the preamble is still the screen asking (see `buildingNeedsAttention`).
    return buildings.some(b => ImportOrganize.buildingNeedsAttention(
      b, assignments, active, grouping, campusMode, null));
  }

  /** Whether **one** building would show something to answer or heed — the four stops
   *  `groupedNeedsAttention` is the `some()` over, lifted out so the needs-attention-first ordering
   *  (IMPORT-58) partitions on exactly the predicate the auto-skip judges by, rather than a second
   *  copy free to drift from it.
   *
   *  `hoisted` is the caller's `ImportBind.sharedFacilitySite` verdict — the one thing the two
   *  callers disagree about. When it is truthy the facility control was hoisted into the preamble
   *  (IMPORT-56) and this building's **card** no longer draws it, so the facility stop doesn't
   *  belong to the card; the ordering passes it for that reason. `groupedNeedsAttention` passes
   *  `null` and keeps asking per building, which is what its own contract says: the hoist only fires
   *  when every bound building shares one Site, so each yields that Site's one verdict and the
   *  question is unchanged by where the answer is drawn. Passing the hoist there would be a real
   *  behaviour change — one pending facility lock would stop being a reason to render the screen.
   *
   *  It is also why the ordering needs the parameter at all: under the hoist every building yields
   *  the same `'suggest'`, so an unhoisted predicate would mark all 82 as needing attention and the
   *  toggle would never have a partition to make. */
  static buildingNeedsAttention(b, assignments, active, grouping, campusMode, hoisted) {
    if (!b.nbSite || b.nbSite.auto) return true;
    if (campusMode && !b.nbBuilding) return true;
    if (hoisted) return false;
    const facility = ImportBind.facilityRowState(b.nbSite.slug, assignments, active, grouping);
    return facility === 'suggest' || facility === 'other';
  }

  /** A **stable partition** of `items`: everything `needs` is true of first, in its original
   *  relative order, then everything else in theirs. The one reordering primitive both presentations
   *  use — the pile's unanswered-first rows (IMPORT-33) and the grouped presentation's
   *  needs-attention-first cards (IMPORT-58) — because the hazard they share is the same one, and it
   *  is not the ordering: **omitting** an item is what neither may do. Both callers keep an
   *  element map (`rowEls`, `focusSec`) built during the render pass, so an item that was never
   *  built would leave a stale entry and throw on the next interaction. A partition can only
   *  reorder, which is the property worth having in one tested place rather than written out twice.
   *
   *  Recompute it per render rather than freezing it at the toggle, so the front of the list keeps
   *  meaning "still needs you". */
  static orderByAttention(items, needs) {
    return [...items.filter(needs), ...items.filter(x => !needs(x))];
  }

  /** The grouped presentation's progress line (IMPORT-58): how much of the binding question is
   *  actually settled, in one sentence over three mutually exclusive buckets that account for every
   *  building — **confirmed** (an anchor an operator action stands behind), an unreviewed **guess**
   *  (`nbSite.auto` — a filename prefill or an auto-match), and **unbound**.
   *
   *  At 82 buildings the screen is a wall of near-identical cards and nothing on it said how much
   *  was left; "82 collapsed cards" and "82 collapsed cards with two still unbound" looked the same.
   *  The zero clauses are dropped so a finished list reads as finished ("82 of 82 buildings
   *  confirmed.") rather than trailing two zeroes. Pure text over the buildings the caller already
   *  holds, like `recognizedBannerText`, so the unit tier pins the wording and the counts. */
  static bindProgressText(buildings) {
    const total = buildings.length;
    const guesses = buildings.filter(b => b.nbSite && b.nbSite.auto).length;
    const unbound = buildings.filter(b => !b.nbSite).length;
    const parts = [(total - guesses - unbound) + ' of ' + total + ' building'
      + (total === 1 ? '' : 's') + ' confirmed'];
    if (guesses) parts.push(guesses + ' matched for you, waiting on a look');
    if (unbound) parts.push(unbound + (unbound === 1 ? ' still needs' : ' still need') + ' a building');
    return parts.join('; ') + '.';
  }

  /** The receipt a skipped grouped pass leaves behind (IMPORT-46). The screen it replaces was the
   *  operator's only confirmation that the regroup did what they asked, so advancing silently would
   *  read as the wizard having jumped a step — this says what it found instead. Pure text over a
   *  count the caller already has, like `recognizedBannerText`. */
  static regroupReceiptText(buildingCount) {
    return 'Sorted your drawings into ' + buildingCount + ' building'
      + (buildingCount === 1 ? '' : 's') + ', already bound to NetBox. Nothing left to confirm.';
  }

  /** Whether the step opens in the per-drawing **pile** presentation rather than folder groups
   *  (IMPORT-34). Only a one-folder import can be a pile, and even then only when nothing says
   *  that folder IS a building — never `buildings.length === 1` alone, which also fires for a
   *  legitimate single-building facility:
   *    • the literal `'Building'` bucket (`ImportUploader.split`'s no-subfolders fallback for
   *      loose files) carries no folder intent, so it is always a pile;
   *    • a named folder is a pile only while it is **unbound** — the auto-match has already run
   *      (`step` guards on `_autoMapDone` first), so a folder that confidently names a NetBox
   *      anchor, or arrived bound from the draft/manifest, presents as a single bound group;
   *    • once the organize question is answered (`_organized`) the step stays grouped. */
  _isPile(buildings) {
    if (buildings.length !== 1 || this._organized) return false;
    const b = buildings[0];
    if (b.folder === 'Building') return true;
    return !b.nbSite;
  }

  /** The Buildings step (IMPORT-34): organize the drawings into buildings and anchor those buildings
   *  to NetBox, on one stepper entry. Guards run in dependency order, each on the
   *  guard-then-re-render pattern the old bind step used, so the step is drawn once with real
   *  state: the campus detour first (it scopes everything below, MODEL-7), then the candidate
   *  fetch (the pile's matcher and every drawing picker read it), then the once-per-scan
   *  auto-match (the grouped headers *and* the single-folder entry-mode signal need its verdict),
   *  then — grouped only — the facility assignments its headers render (MULTI-6).
   *
   *  What each presentation does is documented on `_render`; which one opens on `_isPile`.
   *  `focusBuilding` (the campus row's return path, `_stepCampus` → here) expands and highlights
   *  that building's group.
   *
   *  `fromRegroup` marks the one entry `_regroup` makes on its way back in (IMPORT-46) — the only
   *  entry allowed to walk straight past a grouped screen that would ask nothing. Every other way in
   *  (an ordinary `_stepBuildings()`, the stepper's Back, a resume, the campus row's return) renders
   *  as it always has, so back-navigation still lands where the operator aimed it. */
  async step(focusBuilding, fromRegroup) {
    const buildings = this.w._floorBuildings();
    // Siteplan-only import — nothing to bind, so hand straight on to whatever follows this step
    // (the walk's Site plan step for a fresh import: the one question such an import *does* have).
    if (!buildings.length) return this.w._afterBuildings();

    // The loading guards below re-enter the step to finish rendering it, so they carry
    // `fromRegroup` with them — the auto-match verdict and the assignment map they fetch are two of
    // the things the auto-advance predicate reads, and the decision can only be made once they are
    // in. The campus detour deliberately does NOT (`campusResume`): coming back from it is the
    // operator navigating, and a navigation must land on the step it names.
    const resume = () => this.step(focusBuilding, fromRegroup);
    const campusResume = () => this.step(focusBuilding);
    // The campus detour runs BEFORE the fetch/match guards below, which scope their searches to
    // the campus (shared with the edit hub's bind screen, IMPORT-41 — see `ImportBind._guardCampus`).
    if (this.w.binder._guardCampus(campusResume)) return;

    // Each loading pass below renders a bare stage (title + progress line only) — unlike the edit
    // bind screen, whose preamble is already on screen by the time its own guards run, this step's
    // preamble is deferred to `_render` (below), which runs once every guard has cleared.
    const loadingView = () => this.w._stage('Map buildings to NetBox', 'sites');

    // The candidate buildings are fetched **once** and matched/picked client-side (TOPO-5).
    if (await this.w.binder._guardLoad(this._assignCands !== undefined, 'Looking up buildings…',
        () => this._loadBuildingCandidates(), loadingView, resume)) return;

    // The once-per-scan building→NetBox auto-match (`_autoMapDone` guards it, as ever). Run
    // before the entry-mode decision: a one-folder upload whose folder confidently names a NetBox
    // anchor is a *building*, not a pile, and the match verdict is that signal (`_isPile`).
    if (await this.w.binder._guardLoad(this.w._autoMapDone, 'Matching buildings to NetBox…',
        () => this.w.binder._autoMapBuildings(), loadingView, resume)) return;

    if (this._isPile(buildings)) return this._render(buildings, false, focusBuilding);

    // The facility assignments the confirm control renders from (MULTI-6) — only the grouped
    // presentation shows `_facilityRow` (on its group headers, or hoisted into the preamble when
    // every bound building shares one Site, IMPORT-56), so only it pays for the load.
    if (await this.w.binder._guardLoad(this.w.binder._assignments !== undefined,
        'Loading facility assignments…', () => this.w.binder._loadAssignments(), loadingView,
        resume)) return;

    // The regroup landing with nothing left to ask walks on rather than drawing a screen whose only
    // content is its Continue button (IMPORT-46). Evaluated here, last, because every input the
    // predicate reads — the auto-match verdict, the facility assignments — is only settled once the
    // guards above have cleared. No `_saveDraft()`: `_regroup` already saved the carried bindings,
    // and nothing since could have changed the model without failing the predicate (a fresh
    // auto-match binding is `auto`).
    if (fromRegroup && !ImportOrganize.groupedNeedsAttention(buildings, this.w.binder._assignments,
        this.w.app.facility, this.w.app.grouping, this.w._isCampusMode())) {
      Toast.show(ImportOrganize.regroupReceiptText(buildings.length));
      return this.w._afterBuildings();
    }
    return this._render(buildings, true, focusBuilding);
  }

  /** Render the Buildings step in one of its two presentations (IMPORT-34).
   *
   *  **Pile** (`grouped` false — one unbound folder, see `_isPile`): assign each drawing of the
   *  single unsorted folder to a building of its own, then physically regroup the files
   *  server-side (IMPORT-3). The user names buildings and picks one per drawing; **Continue**
   *  moves the files into per-building folders (`_regroup`) and lands back in this step's grouped
   *  presentation, where each new building arrives already bound to the pick that created it
   *  (IMPORT-25) — never a second screen re-asking. Assignment is per **physical file** — a
   *  multi-page PDF is several page rows in `pdfs` but one file on disk, so it moves as a unit.
   *  Assignments are ephemeral (nothing is written until Continue; the folder-keyed model is
   *  rebuilt from the re-scan afterwards).
   *
   *  **The pile proposes an assignment per drawing (TOPO-5)** rather than starting every picker
   *  empty — a flat pile from a campus is one file per floor across a hundred-odd buildings, and
   *  hand-picking each is the chore this step exists to shorten. The candidate buildings are
   *  fetched **once** (`_loadBuildingCandidates`, at the raised one-shot cap) and every filename
   *  scored against them locally by `ImportMatch.bestOfAll` — the **whole pile in one call**
   *  (IMPORT-21), which rates each winner `exact`/`strong`/`weak`. Scoring the pile together is
   *  what lets the confidently-matched drawings settle its numbering convention for the rest: a
   *  filename alone can never say whether its `005` is a building code or a sheet number, and the
   *  batch can. It resolves that numeric doubt only — never which building a *word* means.
   *
   *  **`exact`/`strong` prefill themselves; `weak` never does (IMPORT-18).** The confident tiers
   *  are exactly the set the old summary bar applied in one click, so prefilling them commits
   *  nothing the operator wasn't already one button from — but it is visible (the row is flagged
   *  `auto` and reads "prefilled") and reversible (per row through its `Combo`'s clear, or in bulk
   *  through **Undo N prefilled**). `weak` — ambiguous, code-only, or a winner a runner-up tied
   *  with — keeps its per-row **Use** and is still never swept in bulk, because the destination
   *  folder becomes the building, whose anchor keys every `Room.floor_key` below it. A hand-pick
   *  through a row's `Combo` always wins.
   *
   *  **An unmatched drawing starts blank**, not defaulted to the source folder (IMPORT-18): a row
   *  the matcher couldn't answer for has to *look* unanswered, since the old prefill was
   *  indistinguishable from a real proposal and quietly shipped a whole pile into one building.
   *  Continue refuses to submit while any row is blank, and the summary bar offers the old default
   *  as an explicit one-click "leave the rest together" — taking it (and continuing with nothing
   *  to move) is the operator saying the pile IS one building, so the step re-opens grouped for
   *  that building to be bound (`_organized`).
   *
   *  **The pile learns from the operator's own picks, within this import (IMPORT-22).** A flat
   *  pile is one file per *floor*, so it asks the same question once per floor:
   *  `001-Admin-FL1/-FL2/-FL3` name one building, and `ImportMatch.tokenize` drops the floor
   *  marker, so all three share a `memoryKey`. Every hand-pick and every **Use** click is
   *  therefore banked in `this._assignMemory` and re-applied to that drawing's identical-key
   *  siblings — filling a blank one, and *replacing* a filename prefill the operator has just
   *  shown to be wrong. Only operator actions teach it; an automatic prefill never does, or a
   *  wrong guess would propagate itself. The rung is identical-key only and the memory dies with
   *  the wizard — see `ImportMatch.memoryKey` and the constructor for why each of those is
   *  deliberate.
   *
   *  **A drawing can be left out of the map entirely (IMPORT-24).** Not every page in a pile is a
   *  floor plan — a title sheet, a legend, a stray revision, another discipline's drawing — and
   *  before this the only way past the Continue gate was to file the junk under some building.
   *  Each row carries a **Not included** button; an excluded row is a *fourth* state, distinct
   *  from blank, and counts as **answered** (Continue passes) without contributing a building. On
   *  Continue those drawings are moved to the reserved `ImportFlow.EXCLUDED_FOLDER` in the same
   *  regroup call, where `PreprocessBase.building_folders` skips them — so they leave the import
   *  without being deleted and without appearing as a building. Excluding **never** propagates to
   *  a drawing's siblings, unlike a building pick: it is a per-sheet judgement (see `setExcluded`).
   *  It is freely undoable here and **one-way after Continue** — the wizard can no longer see the
   *  reserved folder — which the summary bar says in as many words.
   *
   *  **The outstanding rows can be pulled to the top (IMPORT-33).** The prefill pass answers most
   *  of the list, which leaves what it couldn't answer scattered through a hundred-plus rows — so
   *  the summary bar offers a **Show the N unanswered first** toggle beside its bulk buttons. It
   *  is a **view-level reordering and nothing else**: no assignment, prefill flag, memory entry or
   *  Continue gate moves with it, and an excluded drawing counts as answered here exactly as it
   *  does for the gate. It reorders rather than filters — see `ordered()` for why every row must
   *  still be built.
   *
   *  **Grouped** (`grouped` true — a foldered upload, or a one-folder upload that IS a building):
   *  one group per floor-contributing building, each the `imp-bind` card the old bind step drew —
   *  header (name, folder, bind state), the NetBox anchor search and, unless it was hoisted into the
   *  preamble (IMPORT-56), the facility-assignment row (MULTI-6) are
   *  `ImportBind._bindRow(b, hoistedFacility, …)` verbatim, so the anchor picker exists **once**,
   *  shared with the edit hub — plus a group chrome of its own: a drawing-count **expander**.
   *  Collapsed by default (a foldered upload declared its grouping; binding is the ask); a lone
   *  group, a pending new group and the `focusBuilding` target open expanded. Expanding reveals
   *  the same per-drawing rows the pile draws — thumbnail, filename, destination picker, **Not
   *  included** — so a misfiled drawing is moved by picking another building (an existing group, a
   *  NetBox building, or a name added above), which surfaces as a pending "(new)" group until
   *  **Continue** routes the moves through the same `_regroup`. No filename-prefill or correction
   *  memory runs here — the folders are the operator's own grouping, and second-guessing it per
   *  drawing is the pile's job — but a pick that names a NetBox building still records its anchor
   *  (`_notePick`, IMPORT-25) so the new folder binds after the regroup. With nothing to move,
   *  Continue is the old bind gate: forward to floor mapping once every building is bound.
   *
   *  **The grouped list is workable at 80-odd buildings** (IMPORT-58). A campus upload draws a wall
   *  of near-identical cards, and until this it said nothing about itself and offered no way to work
   *  through it. Three things, each the grouped counterpart of something the pile already had rather
   *  than a new idiom: the summary bar leads with a **progress line** (`bindProgressText` —
   *  confirmed / matched-for-you / unbound, so "how much is left" is answerable without counting
   *  cards); beside it sits a **Show the N needing attention first** toggle, the pile's IMPORT-33
   *  control one level up, reordering cards through the same `orderByAttention` partition and
   *  answering the same `needsAttention` predicate the count is taken from; and each card's anchor
   *  search is collapsed behind **Change** (`ImportBind._bindRow`, applied on both bind-style
   *  screens), so a settled card is quiet and 82 live search inputs aren't all mounted at once. All
   *  three are view-level: no binding, assignment, exclusion or gate moves with any of them, and the
   *  ordering reorders without ever dropping a card — the `focusBuilding` target included. */
  _render(buildings, grouped, focusBuilding) {
    const source = buildings[0];   // the pile's one folder (the grouped presentation ignores it)
    const cands = this._assignCands.rows, complete = this._assignCands.complete;
    const emptyWhy = this._assignCands.empty;

    // One assignable entry per physical file (dedupe the exploded per-page rows), keeping the
    // first row of each for a representative thumbnail. Keys are `<folder>\n<file>` — the grouped
    // presentation spans every building, and two folders may hold a same-named drawing.
    // `stems` is each file's match key, computed once: both the filename scorer and the correction
    // memory read it, and the memory re-reads it on every operator pick. `srcOf` is the folder the
    // file physically sits in — what the regroup payload moves it *from*.
    const files = [], rowFor = {}, stems = {}, srcOf = {};
    for (const b of buildings)
      for (const p of b.pdfs) {
        const key = b.folder + '\n' + p.file;
        if (key in rowFor) continue;
        rowFor[key] = p; files.push(key);
        stems[key] = ImportMatch.stemOf(p.file);
        srcOf[key] = b.folder;
      }
    // Every answer on this screen lives on the instance, not here (IMPORT-42) — the containers are
    // the same objects across re-entries, so the controls below write through to them unchanged and
    // a step away and back finds what the operator already said. Pruned against the scan first: a
    // key names a drawing, and a drawing the operator removed upstream must not answer for itself.
    // Each container below is taken from it by name, keeping its own account of what it holds.
    const st = ImportOrganize.pruneAnswers(this._answers, files);

    // Each file's destination is a `{folder, label}`: `folder` is the path-safe folder name the
    // regroup writes (an existing building's **slug** — path-safe and round-tripping through
    // `slugify`, so the later auto-match still binds it — an existing group's folder, or a
    // hand-typed name), `label` what the picker shows. A file **absent** from the map is
    // unassigned — in the pile, the starting state for anything the matcher couldn't answer for
    // (IMPORT-18), so an unmatched drawing reads as unmatched instead of silently inheriting the
    // source folder; in the grouped presentation every file starts assigned to its own folder and
    // goes blank only through an explicit clear.
    const sourceDest = { folder: source.folder, label: source.folder };
    // The grouped presentation's own-folder default is seeded below, once the sets that override
    // it exist.
    const assign = st.assign;
    // Buildings the operator names by hand that don't exist in NetBox yet — merged into every
    // picker's results alongside the live building search below.
    const created = st.created;

    // The filename→building **proposal** for each drawing, and which of them are currently taken
    // from that proposal. Pile only — a foldered upload's grouping is the operator's own answer,
    // not something to second-guess per drawing. `exact`/`strong` prefill (IMPORT-18) — the same
    // set the bulk button used to apply in one click, now applied up front, flagged, and
    // reversible. `weak` stays a suggestion only: an ambiguous or code-only match is offered per
    // row and never swept in bulk, because a wrong building assignment silently re-anchors every
    // floor key beneath that building (§10 foundations).
    const proposal = {}, accepted = st.accepted;
    // The rows filled in from the **correction memory** rather than from their filename (IMPORT-22),
    // `file → {folder, label}`. Kept apart from `proposal` because the two make different claims to
    // the operator — "your earlier pick" against "what this filename looks like" — and the row's
    // chip, the summary copy and the undo bulk each have to tell them apart.
    const learned = st.learned;
    // Rows the operator explicitly emptied: through a row's `Combo` clear, or through **Undo N
    // prefilled**. Blank is a real answer here ("not this, and don't guess again"), so the recall
    // pass leaves them alone — re-filling a row someone just cleared is the silent mis-assignment
    // IMPORT-18 removed.
    const emptied = st.emptied;
    // Drawings the operator dropped from the import entirely (IMPORT-24) — a title sheet, a legend
    // page, a stray revision, another discipline's drawing. A **fourth** row state, not a variant of
    // blank: blank means "still needs a building", excluded means "there is no building, and that is
    // the answer". Every partition below therefore has to see it exactly once — the Continue gate
    // and the summary's blank/filled counts skip it, and the payload builder routes it to
    // `EXCLUDED_FOLDER` instead of a building. Kept as its own set rather than a sentinel in
    // `assign` so no code path can mistake it for a destination the operator picked.
    const excluded = st.excluded;

    // The grouped presentation's own-folder default — every file starts assigned to the folder it
    // sits in — applied only where the operator has said nothing (IMPORT-42). A row they cleared
    // has to stay blank and an excluded one has to stay excluded, or a step away and back would
    // quietly hand a building back to a drawing that was deliberately dropped. A restored entry
    // that IS the source folder is re-seeded rather than kept, so its label can't outlive a rename
    // of the building it names.
    if (grouped)
      for (const f of files) {
        if (emptied.has(f) || excluded.has(f)) continue;
        if (assign[f] && assign[f].folder !== srcOf[f]) continue;   // a pending move — leave it
        const b = buildings.find(x => x.folder === srcOf[f]);
        assign[f] = { folder: srcOf[f], label: (b && b.name) || srcOf[f] };
      }

    // Pan/zoom framing per drawing, keyed by file — must outlive a repaint. render()/repropose()
    // rebuild every row's DOM on any pick (IMPORT-22), so this can't live inside row() itself or
    // every reproposal would silently reset the operator's zoom (mirrors `_pdfCard`'s `b.frame`).
    const frames = st.frames;
    // Whether the pile list is currently reordered to put the rows that still need a building
    // first (IMPORT-33) — `st.unansweredFirst`, and a scalar rather than a container, so the reads
    // and the toggle below go through `st` directly. Held out of render() and paintSummary() for
    // the same reason as `frames`: both wipe and rebuild their own DOM, so anything that has to
    // outlive a bulk button or a reproposal cannot live inside them or it would silently reset.
    const counts = { exact: 0, strong: 0, weak: 0 };
    const applyProposal = (f) => {
      const m = proposal[f];
      assign[f] = { folder: m.cand.slug, label: m.cand.name };
      accepted.add(f);
      learned.delete(f);
      // A proposal points at a real candidate row, so the binding can be taken straight from here
      // rather than searched for again (IMPORT-25) — unconfirmed, since a prefill is the wizard's
      // answer and not yet the operator's.
      this._notePick(m.cand.slug, m.cand, false);
    };
    // Take the operator's own earlier answer for a drawing whose filename tokenizes identically.
    // Flagged `accepted` like a filename prefill, so it reads as wizard-applied: visibly filled in,
    // and reversible per row or in bulk.
    const applyRecall = (f, dest) => {
      assign[f] = dest;
      accepted.add(f);
      learned.set(f, dest);
    };
    // A row the operator answered on an earlier visit to this step is **theirs**, and the prefill
    // pass below must not run over it (IMPORT-42): re-filling a row they emptied is the silent
    // mis-assignment IMPORT-18 removed, overwriting a hand-pick discards a deliberate answer, and
    // giving an excluded drawing a destination breaks the rule that an exclusion holds none
    // (IMPORT-24). A *prefilled* row is deliberately not answered — re-running the pass reproduces
    // it exactly, and the recall pass below then re-applies any correction that outranked it
    // (IMPORT-22), so a learned row survives the round trip as learned. On a first render every
    // container is empty and this is false throughout.
    const answered = (f) => excluded.has(f) || emptied.has(f) || (assign[f] && !accepted.has(f));
    if (!grouped) {
      // Index the candidate list once for the whole pass. `prepare` both decomposes each building
      // and learns the list's own inverse document frequencies — which words on *this* campus
      // actually discriminate — so it has to see the whole list, and re-deriving it per drawing
      // would be pure waste at the thousands of rows this now runs to (IMPORT-18/IMPORT-20).
      // Scored as a **pile**, not one drawing at a time (IMPORT-21). The extra thing a batch call
      // knows is this pile's own numbering convention: which of its numbers name buildings and
      // which are sheet or discipline indices, learned from the drawings that matched confidently
      // on their words. A proposal the pile is what settles carries `corroborated`, so the row can
      // say so.
      const prepared = ImportMatch.prepare(cands);
      const proposals = ImportMatch.bestOfAll(files.map(f => stems[f]), prepared);
      for (const f of files) {
        const m = proposals.get(stems[f]);
        if (!m) continue;
        proposal[f] = m;
        counts[m.confidence]++;
        if (m.confidence !== 'weak' && !answered(f)) applyProposal(f);
      }
    }
    const confident = new Set(files.filter(f => proposal[f] && proposal[f].confidence !== 'weak'));

    // Which rows the wizard owns and may therefore still fill or re-fill: a blank one, or one it
    // filled itself from a filename match or an earlier recall. A row the operator touched — picked
    // through its `Combo`, took with **Use**, or deliberately emptied — is theirs, and is never
    // rewritten underneath them. In the grouped presentation every row starts assigned (its own
    // folder) and un-accepted, so nothing there is wizard-owned and the recall pass is inert.
    // An exclusion is an operator answer too, so it locks the row exactly as `emptied` does — an
    // excluded row holds no `assign` entry, and without this the recall pass would read it as blank
    // and quietly fill in a building for a drawing that was just dropped.
    const wizardOwned = (f) => !emptied.has(f) && !excluded.has(f)
      && (!assign[f] || (accepted.has(f) && (confident.has(f) || learned.has(f))));

    // Fill one row from what the operator has already said about a drawing whose filename tokenizes
    // identically (IMPORT-22). **The memory outranks the filename proposal, including a confident
    // one**: an entry exists only because the operator picked a building for a drawing this one is
    // indistinguishable from, and when that pick *overrode* a confident match, propagating the
    // override is the whole point — the up-front pass gets a building's floors wrong together, and
    // saying so once should be enough. Returns whether anything actually changed.
    const recallInto = (f) => {
      if (!wizardOwned(f)) return false;
      const dest = ImportMatch.recall(stems[f], this._assignMemory);
      if (!dest || (assign[f] && assign[f].folder === dest.folder)) return false;
      applyRecall(f, dest);
      return true;
    };
    // The memory outlives one visit to this step, so it applies on arrival and not only after a
    // pick (pile only — the grouped rows are never wizard-owned).
    if (!grouped) for (const f of files) recallInto(f);

    // The prefilled rows *as they stand* — a hand-pick or a clear drops one out, so this is
    // recomputed rather than frozen at the passes above. A **Use** click is deliberately not counted:
    // taking a suggestion is the operator's own action, not something the wizard filled in for them.
    // Both partitions skip an excluded row (IMPORT-24), and for the same reason: each backs a bulk
    // button — "Undo N prefilled" and "Leave the remaining N out" — that would otherwise
    // hand a building back to a drawing the operator has just dropped.
    const prefilled = () => files.filter(f =>
      !excluded.has(f) && accepted.has(f) && (confident.has(f) || learned.has(f)));
    // The one test for "this row is still unanswered", named because three things ask it: the
    // summary's count, the Continue gate, and the unanswered-first ordering (IMPORT-33). Sharing it
    // is what stops the toggle's set from drifting from the count that labels it. An **excluded**
    // drawing is answered (IMPORT-24) — there is no building, and that is the answer — so it sits
    // outside this set exactly as it sits outside the gate.
    const needsBuilding = (f) => !assign[f] && !excluded.has(f);
    const unassigned = () => files.filter(needsBuilding);

    const view = this.w._stage(
      grouped ? 'Map buildings to NetBox' : 'Organize drawings into buildings', 'sites');
    // What the upload+scan recognized (IMPORT-38): a first upload auto-routes straight from
    // Upload into this step (`_scanAndMap`), so this banner is the operator's first look at
    // whether their drop read as a pile or as N buildings — and, since it costs no extra click,
    // it stays up on every re-entry rather than only the first.
    view.append(Dom.el('p', { class: 'imp-recognized-banner' }, ImportOrganize.recognizedBannerText(
      buildings.length, grouped, files.length, !!(this.w.site && this.w.site.file))));
    if (grouped) {
      // Shared with the edit hub's bind screen (IMPORT-41) — see `ImportBind.bindPreamble`.
      this.w.binder.bindPreamble(view, buildings, focusBuilding, () => this.step(focusBuilding),
        ' Expand a building to see its drawings, and move a misfiled one into another building. '
        + 'The move happens when you Continue.');
    } else {
      // The prefill sentence is only true when there was something to match against — with no
      // candidates the summary bar's own note (`_noCandidatesNote`) says why every row is blank.
      view.append(Dom.el('p', { class: 'hint' },
        'These drawings are all in one folder. '
        + (cands.length ? 'We’ve filled in confident filename matches for you to review. '
          + 'Assign what’s left to a building, or add a new one above. '
          : 'Assign each one to a building. Add one above if it isn’t in NetBox yet. ')
        + 'Leave out anything that isn’t a floor drawing, such as a title sheet or legend.'));
      // Only when the *cap* clipped a real list — a failed fetch leaves no rows and has already
      // toasted, so this would just be a second, more confusing way of saying the same thing.
      if (!complete && cands.length) view.append(Dom.el('p', { class: 'hint imp-assign-capped' },
        'Your facility has more buildings than this page can match against at once, so filename '
        + 'matching only considered the first ' + cands.length + '. Any building is still reachable '
        + 'from a row’s own search box.'));
    }

    // The candidate row behind each destination folder, as the pickers surface them — what
    // `_notePick` needs to carry a pick's NetBox identity into the binding (IMPORT-25). Indexed
    // here because `optionsFor` below is the one place holding the rows themselves, whichever of
    // its two sources they came from; the `Combo` hands its `onPick` back only the folder and the
    // label.
    const rowFolder = new Map();
    // The destinations that already exist in this import — the pile's source folder, or every
    // group — plus any hand-added name. Local in the `isLocal` sense below: picking one moves a
    // drawing without naming a *new* NetBox object.
    const localDests = () => (grouped
      ? buildings.map(b => ({ folder: b.folder, label: b.name || b.folder }))
      : [sourceDest]).concat(created);
    // Destinations that carry no NetBox pick of their own: an existing folder (whatever anchor it
    // has, it already has it), and any name typed by hand. A typed name may collide with a real
    // slug, and `optionsFor`'s dedupe deliberately lets the local label win — so the same rule has
    // to decide identity, or a typed name would silently inherit that building's anchor.
    const isLocal = (folder) => localDests().some(o => o.folder === folder);

    // Validate and register a new local building destination (IMPORT-43) — the one path behind
    // both the top "Add building" field and a row's inline "Add building "<q>"" pick. Each name is
    // a folder, so reject the path separators `safe_path` would otherwise have to (the server
    // re-checks). Toasts the specific reason and returns `null` on refusal; on success pushes onto
    // `created` (surfacing in every picker's results via `optionsFor` on next open, no full
    // re-render needed) and returns the new `{folder, label}` destination.
    const createBuilding = (name) => {
      name = (name || '').trim();
      if (!name) return null;
      if (/[\/\\]/.test(name)) { Toast.show('A building name can’t contain / or \\', true); return null; }
      // Both reserved folder names are refused here (IMPORT-24). The pipeline skips them by name,
      // so a building called either would take its drawings out of the import silently — which is
      // the deliberate act the exclude control performs, and must never be something you can walk
      // into by typing a name. (The server refuses `.thumbs` as a destination as well; it has to
      // keep accepting `_excluded`, since that is how the exclude control does its work.)
      if (name === ImportFlow.EXCLUDED_FOLDER || name === ImportFlow.THUMBS_FOLDER) {
        Toast.show('“' + name + '” is reserved by the importer. Pick another name. To '
          + 'leave a drawing out of the map, use its “Not included” button instead.', true);
        return null;
      }
      if (isLocal(name)) { Toast.show('That building already exists', true); return null; }
      const dest = { folder: name, label: name };
      created.push(dest);
      return dest;
    };

    // The searchable options for one drawing's picker, filtered by `q`: the facility's existing
    // buildings (Sites for site-as-building, building-anchor Locations for site-as-campus,
    // MODEL-4/IMPORT-14), plus the local destinations above.
    //
    // The pre-fetched list the matcher scored (above) doubles as the picker's option source when it
    // is **complete**, so a keystroke costs nothing. When it isn't — the server capped it, or the
    // fetch failed — the list can't answer for the buildings it's missing, so the picker falls back
    // to the live per-keystroke search, which is exactly the case that made it a live search.
    const optionsFor = async (q) => {
      const ql = q.toLowerCase();
      let rows = [];
      if (complete) {
        rows = ql ? cands.filter(r => (r.name || '').toLowerCase().includes(ql)
          || (r.slug || '').toLowerCase().includes(ql)) : cands;
      } else {
        try {
          rows = this.w._isCampusMode()
            ? (await this.w.app.netbox.buildingLocations(q, this.w._campusSlug())).locations || []
            : (await this.w.app.netbox.sites(q)).sites || [];
        } catch (e) {
          Toast.show('Could not search buildings: ' + e.message, true);
        }
      }
      for (const r of rows) if (r.slug) rowFolder.set(r.slug, r);
      const existing = rows.map(r => ({ folder: r.slug, label: r.name }));
      const local = localDests().filter(o => !ql || o.label.toLowerCase().includes(ql)
        || o.folder.toLowerCase().includes(ql));
      // Dedupe by destination folder — a hand-added name matching an existing slug, or an existing
      // folder re-surfacing from the search; local entries come first so their label wins.
      const seen = new Set(), out = [];
      for (const o of [...local, ...existing])
        if (!seen.has(o.folder)) { seen.add(o.folder); out.push(o); }
      const mapped = out.map(o => ({ id: o.folder, name: o.label }));
      // A trailing "Add building "<q>"" row (IMPORT-43) — collapses naming a building that isn't
      // in NetBox yet into the same gesture as picking one, instead of a detour through the top
      // field. Offered only for a real typed query with no exact match already in the list above;
      // `createName` is read by `onPick` below and means nothing to `Combo` itself.
      const typed = q.trim();
      const typedLower = typed.toLowerCase();
      if (typed && !out.some(o => o.folder.toLowerCase() === typedLower
        || o.label.toLowerCase() === typedLower))
        mapped.push({ id: '__create__:' + typed, name: 'Add building “' + typed + '”',
          cls: 'fm-combo-create', createName: typed });
      return mapped;
    };

    const grid = Dom.el('div', { class: grouped ? 'imp-groups' : 'imp-assign-grid' });
    const rowEls = {};   // file → its rendered row, so one pile Use click repaints just that row
    /** The order the pile's rows render in: the upload order, or the ones that still need a
     *  building pulled to the front (IMPORT-33). `orderByAttention` is the shared stable partition
     *  — each row appears in exactly one half and the two halves keep their original relative order
     *  — so this reorders and never omits. Omitting is the thing it must not do: `repaint(f)` swaps
     *  `rowEls[f]` in place, so a row that was never built would leave that entry stale and throw
     *  on the next **Use** click, correction recall or reproposal. Recomputed per render rather
     *  than frozen at the toggle, so the front of the list keeps meaning "still unanswered" — and
     *  rows only ever move on a render that was rebuilding the whole grid anyway, never under the
     *  cheap single-row `repaint` that follows an ordinary pick. */
    const ordered = () => (st.unansweredFirst
      ? ImportOrganize.orderByAttention(files, needsBuilding) : files);

    // Where a drawing currently *shows* in the grouped presentation: its destination when it has
    // one, else the folder it physically sits in — an excluded or cleared row stays visible in its
    // own group rather than vanishing.
    const shownIn = (f) => (!excluded.has(f) && assign[f]) ? assign[f].folder : srcOf[f];
    // Destinations that exist as no folder yet — a NetBox building or hand-added name some drawing
    // was just moved to. Each renders as a pending "(new)" group until Continue creates it.
    const pendingGroups = () => {
      const known = new Set(buildings.map(b => b.folder));
      const out = new Map();
      for (const f of files) {
        const a = assign[f];
        if (a && !excluded.has(f) && !known.has(a.folder) && !out.has(a.folder))
          out.set(a.folder, a.label);
      }
      return out;
    };
    // A group's expansion: the operator's own toggle wins; otherwise a pending new group, a lone
    // group and the focus target open expanded, everything else collapsed.
    const isExpanded = (folder) => {
      if (this._expanded.has(folder)) return this._expanded.get(folder);
      if (!buildings.some(b => b.folder === folder)) return true;
      return buildings.length === 1 || !!(focusBuilding && focusBuilding.folder === folder);
    };

    // Non-null when every bound building shares one Site, in which case `bindPreamble` above has
    // already drawn the single facility control and the group headers omit theirs (IMPORT-56).
    // Computed here, beside the headers that consume it, from the same `buildings` the preamble saw.
    const hoistedFacility = ImportBind.sharedFacilitySite(buildings);
    /** Whether one building's card is still showing something to answer or heed (IMPORT-58) — the
     *  one test behind both the needs-attention-first ordering and the count that labels its toggle,
     *  so the set the operator is sent to can't drift from the number they were promised. The same
     *  predicate the regroup landing's auto-skip judges by (`groupedNeedsAttention`), asked with the
     *  hoist this screen actually rendered: a facility question drawn once in the preamble is not
     *  work waiting on any particular card. */
    const needsAttention = (b) => ImportOrganize.buildingNeedsAttention(b,
      this.w.binder._assignments, this.w.app.facility, this.w.app.grouping,
      this.w._isCampusMode(), hoistedFacility);

    let focusSec = null;
    /** The expanded member list shared by a bound building's group and a pending destination's
     *  (IMPORT-59): a leading visible hint, so the move affordance (each drawing's own search box
     *  below) is stated once it's actually on screen rather than living only in the toggle's hover
     *  title — worded differently from the page-top preamble hint so the two don't just repeat. */
    const memberBody = (members) => Dom.el('div', { class: 'imp-assign-grid imp-group-body' }, [
      Dom.el('p', { class: 'hint' },
        'Search below to move any of these into a different building. Nothing changes until '
        + 'you Continue.'),
      ...members.map(f => (rowEls[f] = row(f))),
    ]);
    /** One building's group (grouped presentation): the `ImportBind._bindRow` card — the same
     *  anchor picker the edit hub renders, so it exists once — with the group chrome added around
     *  it: the drawing-count expander on its head, and the member rows beneath when expanded. */
    const groupSection = (b) => {
      const members = files.filter(f => shownIn(f) === b.folder);
      const open = isExpanded(b.folder);
      // The focus target is the building the operator came here to fix (the campus row's return
      // path), so its anchor search opens with the card rather than behind Change (IMPORT-58).
      const sec = this.w.binder._bindRow(b, hoistedFacility,
        { openSearch: b === focusBuilding });
      sec.classList.add('imp-group');
      if (b === focusBuilding) { sec.classList.add('focus'); focusSec = sec; }
      const head = sec.querySelector('.imp-bind-head');
      if (head) head.append(Dom.el('button', {
        class: 'imp-link imp-group-toggle',
        'aria-expanded': String(open),
        title: open ? 'Hide this building’s drawings'
          : 'Show this building’s drawings. A misfiled one can be moved into another building',
        onclick: () => { this._expanded.set(b.folder, !open); render(); },
      }, (open ? '▾ ' : '▸ ') + members.length + (members.length === 1 ? ' drawing' : ' drawings')));
      if (open && members.length) sec.append(memberBody(members));
      return sec;
    };

    /** A pending destination's group: drawings were just moved to a folder that doesn't exist
     *  until Continue regroups. A NetBox pick already carries its anchor (`_organizePicks`), so
     *  the head can say what the new building will bind to; a hand-typed name has none and says
     *  the binding comes after the move. */
    const pendingSection = (folder, label) => {
      const members = files.filter(f => shownIn(f) === folder);
      const open = isExpanded(folder);
      const pick = this._organizePicks.get(folder);
      const head = Dom.el('div', { class: 'imp-bind-head' }, [
        Dom.el('div', { class: 'imp-bind-folder' }, label || folder),
        Dom.el('span', { class: 'imp-bind-sub' }, 'new building, created when you Continue'),
        pick
          ? Dom.el('span', { class: 'imp-bind-ok' }, '✓ will be bound to '
            + (pick.anchor.kind === 'building'
              ? pick.anchor.building.name + ' in ' + pick.anchor.site.name
              : pick.anchor.site.name))
          : Dom.el('span', { class: 'imp-bind-auto' },
            'not in NetBox. Bind it here after you Continue'),
        Dom.el('button', {
          class: 'imp-link imp-group-toggle', 'aria-expanded': String(open),
          onclick: () => { this._expanded.set(folder, !open); render(); },
        }, (open ? '▾ ' : '▸ ') + members.length
          + (members.length === 1 ? ' drawing' : ' drawings')),
      ]);
      const sec = Dom.el('section', { class: 'imp-bind imp-group imp-group-new' }, [head]);
      if (open && members.length) sec.append(memberBody(members));
      return sec;
    };

    const render = () => {
      grid.innerHTML = '';
      if (!grouped) {
        for (const f of ordered()) grid.append(rowEls[f] = row(f));
        return;
      }
      // Reordered, never filtered (IMPORT-58) — every building still gets a card, so `focusSec` and
      // the member rows built inside `groupSection` are always there to be found. Pending groups
      // stay at the end either way: a folder that doesn't exist yet is the operator's own pending
      // move, not part of the bound/unbound question the toggle sorts.
      const cards = st.attentionFirst
        ? ImportOrganize.orderByAttention(buildings, needsAttention) : buildings;
      for (const b of cards) grid.append(groupSection(b));
      for (const [folder, label] of pendingGroups()) grid.append(pendingSection(folder, label));
    };
    const repaint = (f) => { const el = row(f); rowEls[f].replaceWith(el); rowEls[f] = el; };

    // What the filename pass did and what is still outstanding, plus the bulk affordances that
    // answer them: undo the prefill, or leave out whatever is still blank (IMPORT-54 — there is no
    // bulk way to keep them). Repainted rather than re-rendered from scratch, since re-entering
    // the step would discard the assignments made so far. The grouped presentation has no matcher
    // pass to report — its bar is the binding progress line, the pending-move count, the excluded
    // note and its own ordering toggle (IMPORT-58), and is always shown for the progress line's sake.
    const summary = Dom.el('div', { class: 'imp-assign-summary' });
    const paintSummary = () => {
      summary.innerHTML = '';
      const filled = prefilled(), blank = unassigned();
      if (grouped) {
        // How much of the binding question is settled (IMPORT-58). Leads the bar, and is why the
        // grouped bar is now always shown: at 82 cards the one thing the screen never said was how
        // many of them were still waiting on the operator.
        summary.append(Dom.el('span', {}, ImportOrganize.bindProgressText(buildings)));
        const moved = files.filter(f => !excluded.has(f) && assign[f]
          && assign[f].folder !== srcOf[f]).length;
        if (moved) summary.append(Dom.el('span', {},
          moved + (moved === 1 ? ' drawing moves' : ' drawings move')
          + ' to another building when you Continue.'));
        if (excluded.size) summary.append(excludedNote());
        // Pull the cards that still want an answer to the top — the pile's own IMPORT-33 control,
        // one level up (cards rather than rows) and in the same pressed idiom, rather than a second
        // way of saying "show me what's left". Offered on the same terms: with every card settled or
        // every card outstanding the reorder is a no-op and the button would be noise.
        const pending = buildings.filter(needsAttention).length;
        if (pending && pending < buildings.length) {
          const actions = Dom.el('div', { class: 'imp-assign-actions' });
          actions.append(Dom.el('button', {
            class: st.attentionFirst ? 'active' : '',
            'aria-pressed': String(st.attentionFirst),
            title: 'Reorders this list only. No binding, move or exclusion changes.',
            onclick: () => { st.attentionFirst = !st.attentionFirst; render(); paintSummary(); },
          }, st.attentionFirst ? 'Back to the original order'
            : 'Show the ' + pending + ' needing attention first'));
          summary.append(actions);
        }
        return;
      }
      // With no candidates there is nothing to report a match rate for — but the bulk action below
      // still matters, and more so: every row is blank, so the "leave them out" button is the
      // only bulk way out of the step short of picking a hand-added building per drawing (IMPORT-18).
      if (!cands.length) {
        summary.append(...this._noCandidatesNote(emptyWhy));
      } else {
        const parts = [filled.filter(f => !learned.has(f)).length + ' of ' + files.length
          + ' drawings filled in from their filenames'];
        if (learned.size) parts.push(learned.size + ' more from buildings you picked yourself');
        if (counts.weak) parts.push(counts.weak + ' are uncertain, so check those individually');
        if (blank.length) parts.push(blank.length + ' still need a building');
        if (excluded.size) parts.push(excluded.size + ' left out of the map');
        summary.append(Dom.el('span', {}, parts.join('; ') + '.'));
      }
      if (excluded.size) summary.append(excludedNote());
      const actions = Dom.el('div', { class: 'imp-assign-actions' });
      // Pull the rows that still need an answer to the top (IMPORT-33). After the prefill pass what
      // is left is scattered through a list a campus pile runs to a hundred-plus rows of, so finding
      // the outstanding ones means scrolling past every row already done — and they are exactly what
      // stands between the operator and Continue. A **view-level reordering and nothing else**: no
      // assignment, prefill flag, memory entry or gate moves with it.
      //
      // Offered only when some rows are answered and some aren't: with every row blank (the
      // no-candidates screen) or none blank, reordering is a no-op and the control would be noise.
      // The count is the same `blank` the summary line above reports, so the label can't drift from
      // it. Worded "unanswered" rather than "unmatched" deliberately — a `weak` row is blank but
      // does carry an offered match, and it belongs in this set.
      if (blank.length && blank.length < files.length)
        actions.append(Dom.el('button', {
          class: st.unansweredFirst ? 'active' : '',
          'aria-pressed': String(st.unansweredFirst),
          title: 'Reorders this list only. Nothing you have already picked or left out changes.',
          onclick: () => { st.unansweredFirst = !st.unansweredFirst; render(); paintSummary(); },
        }, st.unansweredFirst ? 'Back to the original order'
          : 'Show the ' + blank.length + ' unanswered first'));
      // Undoing clears the prefilled rows back to blank rather than to the source folder: the
      // prefill is the only thing being taken back, and blank is what those rows would have shown
      // had the matcher not answered.
      if (filled.length)
        actions.append(Dom.el('button', { onclick: () => {
          // Emptying these is an answer, not just an absence — the recall pass must not quietly
          // fill them again on the operator's next pick.
          for (const f of filled) {
            delete assign[f]; accepted.delete(f); learned.delete(f); emptied.add(f);
          }
          render(); paintSummary(); paintActions();
        } }, 'Undo ' + filled.length + ' prefilled'));
      // The one bulk answer left for whatever is still blank: leave them all out. There is no bulk
      // "put them all in this building" — that would silently re-instate the source-folder default
      // IMPORT-18 removed, and a blank pile is not plausibly all one building (IMPORT-54); a
      // drawing that does belong somewhere has to be answered by hand. This still gives the
      // leftovers (title sheets, legends, index pages) a real bulk way out instead of one
      // "Not included" click per row.
      if (blank.length) {
        actions.append(Dom.el('button', { onclick: () => {
          // Mirrors `setExcluded(file, true)` inline rather than calling it per file, so this
          // repaints once instead of once per drawing.
          for (const f of blank) {
            excluded.add(f); delete assign[f]; accepted.delete(f); learned.delete(f);
          }
          render(); paintSummary(); paintActions();
        } }, (blank.length === files.length ? 'Leave all ' : 'Leave the remaining ')
          + blank.length + ' out'));
      }
      if (actions.children.length) summary.append(actions);
    };
    // Say plainly what excluding does and where it stops being undoable *here* (IMPORT-24): the
    // files are moved into a folder the import ignores, so this step can't offer them back
    // afterwards — while nothing is deleted. Since IMPORT-26 the edit hub can, so the copy names
    // that route rather than implying a re-import is the only way back. Shown only once
    // something is actually excluded, so the step doesn't lead with a caveat about a control
    // nobody used. Three short declarative sentences, and no em dash or decorative quoting
    // (IMPORT-64) — a `.hint` is at most one short line (§11), and the aside-heavy version this
    // replaced buried the one-way warning in the middle of its own parentheses.
    const excludedNote = () => Dom.el('span', { class: 'hint imp-assign-excluded-note' },
      excluded.size + ' drawing' + (excluded.size === 1 ? '' : 's')
      + ' will be left out of the map. Nothing is deleted and the file'
      + (excluded.size === 1 ? ' stays' : 's stay') + ' on the server. Once you Continue, taking '
      + (excluded.size === 1 ? 'it' : 'them') + ' back moves to the Excluded drawings row on the '
      + 'edit screen.');

    // Fold what the operator just told us into every row the wizard still owns (IMPORT-22). A flat
    // pile asks the same question once per floor, so one answer should settle its siblings — and when
    // the answer was a *correction*, it should un-do the same wrong prefill everywhere it landed.
    // Repaints the whole grid rather than one row, since a single pick can change many; returns how
    // many rows moved, so the caller can fall back to its cheaper single-row repaint when none did.
    const repropose = () => {
      let n = 0;
      for (const f of files) if (recallInto(f)) n++;
      if (n) { render(); paintSummary(); }
      return n;
    };

    /** The one post-change repaint policy, so every control agrees on it: the grouped presentation
     *  always re-renders the whole grid (a pick moves a row between groups, which an in-place swap
     *  can't express); the pile keeps its cheap single-row repaint unless the correction recall
     *  moved siblings (in which case `repropose` already re-rendered). Summary and actions repaint
     *  either way — both carry counts and gates a single pick can change. */
    const refresh = (file) => {
      if (grouped) render();
      else if (!repropose()) repaint(file);
      paintSummary(); paintActions();
    };

    // Building-name manager: a text field + Add for a destination building not yet in NetBox —
    // still here alongside the row-level inline create (IMPORT-43) since it serves naming several
    // buildings up front, before touching any row. New names surface in every picker's results
    // (via `optionsFor`) on the next open, so no full re-render is needed.
    const nameInput = Dom.el('input', { placeholder: 'New building name' });
    const add = () => {
      const dest = createBuilding(nameInput.value);
      if (!dest) return;
      nameInput.value = ''; nameInput.focus();
      Toast.show('Added “' + dest.label + '”. Pick it for your drawings.');
    };
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); add(); } });
    view.append(Dom.el('div', { class: 'imp-assign-add' }, [
      nameInput, Dom.el('button', { onclick: add }, 'Add building'),
    ]));

    /** Drop one drawing from the import, or take it back (IMPORT-24).
     *
     *  **Excluding never propagates to the drawing's siblings**, and deliberately so — unlike a
     *  building pick, which teaches `_assignMemory` precisely because a flat pile asks the same
     *  building question once per floor (IMPORT-22). Exclusion asks a different question, one
     *  answered per *sheet*: a title page, a legend or a stray revision is exactly the one page of
     *  a set that doesn't belong, so spreading it would drop the drawings the operator wants. For
     *  the same reason it leaves an existing memory entry alone — "this sheet isn't in the map" is
     *  not "that building was wrong for its siblings".
     *
     *  **Taking a drawing back returns the row to unanswered** in the pile (the pre-exclusion pick
     *  isn't tracked, and blank-with-its-suggestion-still-offered is the honest state to hand
     *  back), and to its own folder in the grouped presentation — where "its folder" is what
     *  unanswered means. */
    const setExcluded = (file, off) => {
      if (off) {
        excluded.add(file);
        delete assign[file];
        accepted.delete(file);
        learned.delete(file);
      } else {
        excluded.delete(file);
        if (grouped) {
          const b = buildings.find(x => x.folder === srcOf[file]);
          assign[file] = { folder: srcOf[file], label: (b && b.name) || srcOf[file] };
        }
      }
      refresh(file);
    };

    const row = (file) => {
      const p = rowFor[file];
      // A single-page drawing has a scan thumbnail; an exploded page row doesn't, so fall back to
      // its on-demand per-page preview (same choice `_pdfCard` makes).
      const src = p.thumb ? ImportFlow._media(p.thumb) : ImportPreview.previewUrl(p.pdf, p.page);
      const img = Dom.el('img', { src, loading: 'lazy', title: 'Click to see the whole drawing' });
      const thumb = Dom.el('div', { class: 'imp-thumb imp-assign-thumb' }, [img]);
      // Zoom upgrades a scan thumbnail to the full-scale preview once (same choice `_pdfCard`
      // makes); a page row with no scan thumbnail is already showing the full preview.
      let hires = !p.thumb;
      const upgrade = () => { if (!hires) { hires = true; img.src = ImportPreview.previewUrl(p.pdf, p.page); } };
      frames[file] = frames[file] || { scale: 1, x: 0, y: 0 };
      ImportPreview.attachZoomPan(thumb, img, frames[file],
        { onClick: () => ImportPreview.lightbox(p), onZoom: upgrade });
      const name = Dom.el('span', { class: 'imp-assign-name', title: p.file }, p.file);
      // An excluded row keeps its thumbnail — being able to look at the drawing is what decides
      // whether it belongs at all — but drops the picker outright rather than disabling it: a
      // greyed-out search box invites a pick that has nowhere to land. What the row needs instead
      // is the one control that takes the exclusion back (IMPORT-24).
      if (excluded.has(file))
        return Dom.el('div', { class: 'imp-assign-row excluded' }, [
          thumb, name,
          Dom.el('button', { class: 'imp-link imp-assign-exclude',
            title: 'Put this drawing back. It will need a building again.',
            onclick: () => setExcluded(file, false) }, 'Include'),
          Dom.el('span', { class: 'imp-assign-suggest imp-assign-dropped' },
            'Not included in the map'),
        ]);
      const cur = assign[file];
      // A searchable single-select over the buildings, replacing the long `<select>` (IMPORT-14).
      // **Clearable** since IMPORT-18: blank is a real state (the pile's starting one), so clearing
      // is the per-row undo for a prefill — or, in the grouped presentation, for a move — the
      // operator disagrees with.
      const combo = new Combo({
        value: cur ? { id: cur.folder, name: cur.label } : null,
        placeholder: 'Search buildings…',
        load: optionsFor,
        onPick: (opt) => {
          // The row's own "Add building "<q>"" footer pick (IMPORT-43): create it through the same
          // validation `add()` uses, then fall through the ordinary pick path below with the real
          // destination. A refusal has already been toasted by `createBuilding`, so reject with no
          // message — Combo reverts the input without a second toast.
          if (opt && opt.createName != null) {
            const dest = createBuilding(opt.createName);
            if (!dest) return Promise.reject(new Error());
            opt = { id: dest.folder, name: dest.label };
          }
          if (opt) {
            assign[file] = { folder: opt.id, label: opt.name };
            emptied.delete(file);
            // A hand-pick is a free labelled example (IMPORT-22): remember it, so this drawing's
            // siblings — the same filename bar the floor marker — aren't asked about one at a
            // time. Pile only: in the grouped presentation a move is a per-sheet judgement, like
            // exclusion, and must not drag same-stem siblings out of their folder.
            if (!grouped) this._rememberAssign(stems[file], assign[file]);
            // And when it names a NetBox building, it is also the binding that folder gets after
            // the regroup (IMPORT-25) — carry it as confirmed.
            if (!isLocal(opt.id)) this._notePick(opt.id, rowFolder.get(opt.id), true);
          } else {
            delete assign[file];
            emptied.add(file);
            if (!grouped) this._forgetAssign(stems[file]);
          }
          // A hand-pick supersedes the proposal — drop the accepted flag so the row stops claiming
          // this assignment came from the filename match, and re-offers the suggestion.
          accepted.delete(file);
          learned.delete(file);
          refresh(file);
          // Tells Combo to adopt the resolved destination as its displayed value — a no-op for an
          // ordinary pick (the same object Combo already holds), the swap that replaces the footer
          // row's placeholder text with the real building name for a create.
          return opt;
        },
      });
      const state = accepted.has(file) ? ' auto' : (assign[file] ? '' : ' unassigned');
      return Dom.el('div', { class: 'imp-assign-row' + state }, [
        thumb, name,
        Dom.el('button', { class: 'imp-link imp-assign-exclude',
          title: 'Leave this drawing out of the map: a title sheet, a legend, or anything '
            + 'that isn’t a floor plan. You can put it back until you press Continue.',
          onclick: () => setExcluded(file, true) }, 'Not included'),
        suggestion(file), combo.el,
      ]);
    };

    /** The proposal cell for one drawing: its confidence and the building it points at, plus —
     *  when the proposal isn't the row's current assignment — a **Use** button to take it. A
     *  prefilled row says so instead, so "the wizard filled this in" never reads as "you chose
     *  this" (IMPORT-18). An empty cell when nothing matched — or in the grouped presentation,
     *  where no proposal pass runs — so an unmatched row reads as unmatched rather than as a
     *  rejected suggestion, and the grid keeps its column alignment either way. */
    const suggestion = (file) => {
      const cell = Dom.el('span', { class: 'imp-assign-suggest' });
      // A learned row says so in its own words (IMPORT-22). It must never read as a filename match:
      // what stands behind it is the operator's own pick for a drawing this one is indistinguishable
      // from, which is a different — and better — claim than a score.
      const recalled = learned.get(file);
      if (recalled) {
        cell.append(Dom.el('span', { class: 'imp-conf imp-conf-learned',
          title: 'Filled in from the building you picked for another drawing whose filename matches '
            + 'this one apart from its floor. Still yours to change or clear.',
        }, '↩ your earlier pick'));
        cell.append(Dom.el('span', { class: 'imp-assign-cand', title: recalled.label }, recalled.label));
        cell.append(Dom.el('span', { class: 'imp-assign-prefilled' }, 'prefilled'));
        return cell;
      }
      const m = proposal[file];
      if (!m) return cell;
      const taken = accepted.has(file) && assign[file].folder === m.cand.slug;
      cell.append(Dom.el('span', {
        class: 'imp-conf imp-conf-' + m.confidence,
        title: 'Matched from the filename. ' + (m.confidence === 'weak'
          ? 'Too ambiguous to fill in for you; confirm it yourself.'
          : 'Confident enough to fill in, but still yours to change or clear.')
          // What the pile settled, say the pile settled it (IMPORT-21): on its own this filename's
          // number could as easily have been a sheet number, and the operator should know that the
          // rest of the batch is what ruled that out.
          + (m.corroborated ? ' The other drawings in this batch number their buildings the same '
            + 'way, which is what settled this one.' : ''),
      }, { exact: '✓ exact match', strong: '≈ likely match', weak: '? uncertain' }[m.confidence]));
      cell.append(Dom.el('span', { class: 'imp-assign-cand', title: m.cand.name }, m.cand.name));
      if (taken) cell.append(Dom.el('span', { class: 'imp-assign-prefilled' }, 'prefilled'));
      else cell.append(Dom.el('button', { class: 'imp-link', onclick: () => {
        applyProposal(file);
        emptied.delete(file);
        // Taking a suggestion is as much the operator's answer as typing one, so it teaches the
        // same lesson to this drawing's siblings — and confirms the bind it carries (IMPORT-25),
        // upgrading the unconfirmed note `applyProposal` just made.
        this._rememberAssign(stems[file], assign[file]);
        this._notePick(m.cand.slug, m.cand, true);
        refresh(file);
      } }, 'Use'));
      return cell;
    };

    /** The step's Continue and its gates, painted in place (like the summary bar) because a single
     *  pick can change what the button means: with moves or exclusions pending it reads
     *  **Continue** and routes them through `_regroup`; with nothing to move it is the old bind
     *  gate — **Continue to the site plan →**, disabled (grouped) until every building is bound
     *  **and** every anchor confirmed (`_allBuildingsBound()` + `_allBuildingsConfirmed()`,
     *  IMPORT-57 — the same binding bar `groupedNeedsAttention` applies to the auto-skip, which
     *  this gate used to disagree with).
     *  A pile that continues with nothing to move has been deliberately left together
     *  ("leave the rest" + Continue), so it flips to the grouped presentation for its one building
     *  to be bound (`_organized`) rather than re-asking the pile question.
     *
     *  The step's Continue lives in **two** places, and `paintActions` writes both from one call: the
     *  row appended last to the view — sticky to the bottom of the scrollport (IMPORT-64,
     *  `style.css`'s `.import-view > .imp-actions:last-child`) — and a copy hoisted under the step
     *  title by `ImportFlow._actionsTop` (IMPORT-66), so an operator who arrives at the top of a
     *  facility-scale grid with nothing left to answer never scrolls it to leave. The gate is
     *  computed **once** per paint (`continueGate`) and rendered twice (`continueControls`), which is
     *  what keeps the copy honest: the hazard a mirrored row poses is a second *paint path* that can
     *  miss a repaint and offer a Continue the real gate has disabled, and there is only one here. */
    const actionsRow = Dom.el('div', { class: 'imp-actions' });
    const topRow = this.w._actionsTop(view, Dom.el('div', { class: 'imp-actions' }));
    const buildPayload = () => ImportOrganize.regroupPayload(files.map(f => ({
      src: srcOf[f], file: rowFor[f].file,
      dest: assign[f] && assign[f].folder, excluded: excluded.has(f),
    })));
    const advance = async () => {
      // Excluding every drawing would regroup the import into nothing: the folders empty and are
      // pruned, and the wizard comes back from the re-scan with no buildings at all. That is
      // never what the operator means, and "start over" is the control for it (IMPORT-24).
      if (excluded.size === files.length) return Toast.show('Every drawing is left out, so there '
        + 'would be nothing to import. Include at least one, or start over to upload different '
        + 'drawings.', true);
      const payload = buildPayload();
      if (Object.keys(payload).length) return this._regroup(payload);
      if (!grouped) {
        // Nothing moves — every drawing was deliberately left in the one folder, which is the
        // operator saying the pile IS that building. Re-open grouped so it can be bound.
        this._organized = true;
        return this.step();
      }
      await this.w._saveDraft();
      this.w._afterBuildings();
    };
    /** What Continue means right now: whether it commits moves (which changes its label), and the
     *  hint of whichever gate is holding it — `null` when none is.
     *
     *  A blank row has no destination folder to write, and inventing one — the old source-folder
     *  default — is exactly the silent mis-assignment IMPORT-18 removed. So Continue is gated
     *  while any row is blank; there is no bulk way to take that default anymore (IMPORT-54) — a
     *  blank row has to be answered by hand or covered by the summary bar's "Leave the remaining
     *  N out" button. The two bind gates below it are grouped only (the pile always has something
     *  to answer first): a first import can't reach floor mapping with a building unbound, nor
     *  with one anchored on a guess nobody looked at. All three gates share the disabled-primary +
     *  inline-hint shape the build gate uses (`ImportFlow._buildActions`) — one idiom for "you
     *  can't proceed yet" — and each names its own fix, since the fixes differ.
     *
     *  Returned as data rather than written straight into buttons because two rows render it, and a
     *  gate the operator can see from the top is worth nothing if the row up there can disagree
     *  with the one at the bottom about which fix is outstanding. */
    const continueGate = () => {
      const moves = Object.keys(buildPayload()).length > 0;
      const blank = unassigned();
      if (blank.length) return { moves, hint:
        blank.length + (blank.length === 1 ? ' drawing still needs' : ' drawings still need')
        + ' a building. ' + (grouped ? 'Pick one for each.'
          : 'Pick one for each, or leave them out with the button above the list.') };
      if (grouped && !moves && !this.w._allBuildingsBound())
        return { moves, hint: 'Bind every building to NetBox first.' };
      if (grouped && !moves && !this.w._allBuildingsConfirmed()) {
        // Every building is bound, but some anchor is still the wizard's own guess (IMPORT-57).
        // Its own branch, and its own sentence: an unbound building and an unreviewed guess are
        // different problems with different fixes, and the hint is the only thing telling the
        // operator which one is holding Continue. Before this the gate asked `_allBuildingsBound()`
        // alone, so the screen refused to *auto-skip* past an unconfirmed guess
        // (`groupedNeedsAttention`) and then let Continue wave the same guess through — one bar now
        // covers both, and `bindPreamble`'s "Confirm all N" answers it in a single click.
        const pending = ImportBind.unconfirmed(buildings).length;
        return { moves, hint:
          'Confirm the ' + pending + (pending === 1 ? ' building the wizard matched'
            : ' buildings the wizard matched') + ' above, or change '
          + (pending === 1 ? 'it.' : 'them.') };
      }
      return { moves, hint: null };
    };
    /** One gate verdict as controls — a **fresh** button and hint per call, since `Dom.el` binds its
     *  handlers with `addEventListener` (so a node can be neither shared between the two rows nor
     *  cloned into the second). Same verdict in, same controls out. */
    const continueControls = (gate) => {
      const cont = Dom.el('button', { class: 'primary', onclick: advance },
        gate.moves ? 'Continue' : 'Continue to the site plan →');
      cont.disabled = !!gate.hint;
      return [cont, gate.hint ? Dom.el('span', { class: 'hint' }, gate.hint) : null];
    };
    const paintActions = () => {
      const gate = continueGate();
      topRow.innerHTML = '';
      // `_startOver` is null for a non-superuser, as is `_backButton` off the linear flow (a raw
      // append would throw where `Dom.el` drops). The top copy carries the forward action and its
      // hint only: Back and Start over are the step's escapes, and the bottom row — sticky, so
      // always on screen once the grid scrolls — is where they stay.
      topRow.append(...continueControls(gate).filter(Boolean));
      actionsRow.innerHTML = '';
      actionsRow.append(...[this.w._backButton('sites'), ...continueControls(gate),
        this.w._startOver()].filter(Boolean));
    };

    paintSummary();
    view.append(summary);
    render();
    view.append(grid);
    paintActions();
    view.append(actionsRow);
    if (focusSec) focusSec.scrollIntoView({ block: 'center' });
  }

  /** Remember the building the operator chose for one drawing, so a **sibling** drawing — the same
   *  filename bar the floor or sheet marker `ImportMatch.tokenize` drops — can be filled in from it
   *  rather than asked about again (IMPORT-22). Keyed by the stem's canonical identity, last write
   *  wins: a re-pick is a correction, and the newer answer is the one the operator means.
   *
   *  Called **only** for an operator action in the pile — a pick through a row's `Combo`, or a
   *  **Use** click on a suggestion. An automatic prefill must never land here: a memory fed by the
   *  wizard's own guesses would spread a wrong one across a whole building instead of leaving it
   *  to be caught. */
  _rememberAssign(stem, dest) {
    const key = ImportMatch.memoryKey(stem);
    if (key !== null) this._assignMemory.set(key, dest);
  }

  /** Forget what a stem taught, when the operator clears the row that taught it. Rows already filled
   *  from it keep their assignment — those are visible and reversible, and yanking them back would be
   *  churn nobody asked for — but the key stops answering for anything new. */
  _forgetAssign(stem) {
    const key = ImportMatch.memoryKey(stem);
    if (key !== null) this._assignMemory.delete(key);
  }

  /** Record which NetBox object one destination folder stands for (IMPORT-25), so the binding can
   *  be carried forward instead of re-derived by name search. `row` is the candidate row behind
   *  the destination; a destination that is no NetBox object (a hand-typed building, an existing
   *  folder) has none and is ignored.
   *
   *  `confirmed` separates an operator action — a pick through a row's `Combo`, or a **Use** click —
   *  from a filename prefill the wizard applied itself. It only ever ratchets **up**: several
   *  drawings share a destination, and one explicit pick for any of them is the operator saying this
   *  folder is that building, which a sibling's later prefill doesn't take back.
   *
   *  A **recalled** row (IMPORT-22) needs no call of its own: its destination comes from
   *  `_assignMemory`, which only operator actions write, so the folder was already noted confirmed
   *  by the pick that taught it. */
  _notePick(folder, row, confirmed) {
    const anchor = ImportFlow.anchorFromRow(row);
    if (!anchor) return;
    const prev = this._organizePicks.get(folder);
    this._organizePicks.set(folder,
      { anchor, confirmed: !!confirmed || !!(prev && prev.confirmed) });
  }

  /** Bind each building the regroup just created to the NetBox object its destination was picked
   *  from (IMPORT-25), before the auto-match ever sees it. The destination folder *is* that
   *  object's slug (`_regroup` writes `uploads/<slug>/` verbatim and the scan reports the
   *  directory name back verbatim), so the folder is already an exact key — no second identity
   *  token, and `folder == building` stays true everywhere (§10 *In-app import*).
   *
   *  An operator's own pick binds **confirmed**: they chose that building from a live NetBox list
   *  moments ago, and asking them to confirm it again is the re-work this removes. A filename
   *  prefill they never touched binds `auto`, keeping the group header's "Confirm or change"
   *  exactly where a machine guess stands behind the destination — it still skips the redundant
   *  per-building search, and lands the row the pile actually proposed rather than whatever a
   *  second search would find.
   *
   *  **Only unbound buildings are touched**, mirroring `_autoMapBuildings`: an anchor is the first
   *  segment(s) of every `Room.floor_key` beneath it, so it moves only through an explicit operator
   *  action (§10 foundations). Returns how many were bound. */
  _bindFromOrganizePicks() {
    let n = 0;
    for (const b of this.w._floorBuildings()) {
      if (b.nbSite) continue;
      const pick = this._organizePicks.get(b.folder);
      if (!pick) continue;
      const anchor = pick.anchor;
      if (anchor.kind === 'building')
        this.w._bindBuilding(b, anchor.site, anchor.building, !pick.confirmed);
      else this.w._bindSite(b, anchor.site, !pick.confirmed);
      n++;
    }
    return n;
  }

  /** Move the assigned drawings into their per-building folders on the server, then re-scan and
   *  rebuild the folder-keyed model. `groups` is `{ destFolder: [uploads-relative src, ...] }`.
   *  The endpoint validates every move before touching a file, so a rejected regroup leaves the
   *  files intact; on any failure the step is re-shown with the cause toasted. Lands back in this
   *  step (grouped — `_organized`), where the carried bindings read as answered and only the rest
   *  ask (IMPORT-34: the same stepper entry, never a second screen) — or, when nothing is left to
   *  ask at all, straight on to the next step with a receipt (IMPORT-46,
   *  `groupedNeedsAttention`). Re-enters `step()` directly rather than through the
   *  `_stepBuildings` delegator, which has no way to carry the landing flag; this class is
   *  fresh-flow-only by construction (§10 hooks-not-forks), so the delegator's routing job is moot
   *  here. */
  async _regroup(groups) {
    const view = this.w._stage('Organizing drawings…');
    view.append(Dom.el('p', { class: 'imp-progress' }, 'Moving drawings into buildings…'));
    try {
      await Api.post('/api/import/regroup', { groups });
      const inv = await this.w.scan();
      if (!inv.ok) throw new Error(inv.error || 'scan failed');
      this.w.inv = inv;
    } catch (e) {
      Toast.show('Could not organize drawings: ' + e.message, true);
      return this.step();
    }
    this.w._modelFromInventory();
    // Re-apply the saved draft before the carried binds: `_modelFromInventory` reset every
    // building, and — now that the step is on the linear walk (IMPORT-34) — a regroup can run
    // *after* floors were assigned (the operator stepped back to move one misfiled drawing), so
    // the folders that didn't move must get their assignments and bindings back rather than
    // reverting to defaults. Restore is by folder key, so a renamed (regrouped) folder simply
    // keeps its fresh defaults, exactly as before.
    await this.w._applyDraft();
    // Bind what the operator already answered on the presentation they are leaving, before the
    // auto-match runs and re-asks it (IMPORT-25). After the draft restore, so an already-bound
    // (unmoved) building is never touched.
    this._bindFromOrganizePicks();
    this.w._bIdx = 0;
    this.w._autoMapDone = false;
    this._assignCands = undefined;   // a regroup re-identifies the buildings — re-fetch on re-entry
    this._expanded.clear();          // ...and renames the folders the expansion state is keyed by
    // ...and the folders half of every `<folder>\n<file>` answer key with them, so the whole
    // answer store goes rather than being pruned to nothing one stale key at a time (IMPORT-42).
    // Nothing is lost: the assignments this round produced are the moves that just ran, and the
    // picks behind them are already carried in `_organizePicks`/`_assignMemory`, which survive.
    this._answers = ImportOrganize.emptyAnswers();
    this._organized = true;          // the organize question is answered — the step re-opens grouped
    // Persist those bindings now rather than at the next Continue: they are the one thing this
    // move produced that a reload in between would otherwise lose (`_organizePicks` is
    // session-only by design, so the draft is where the answer has to land).
    await this.w._saveDraft();
    this.step(undefined, true);
  }

  /** Fetch the facility's candidate buildings **once**, for the step to match drawing filenames
   *  against locally (TOPO-5) and for the per-drawing pickers to offer. Which objects are
   *  buildings follows the declared organization mode, exactly like the anchor search:
   *  building-anchor Locations beneath the chosen campus under `site-as-campus`, Sites otherwise
   *  (MODEL-4).
   *
   *  The read asks for the **one-shot cap** (`full`, IMPORT-18): this is the caller that matches
   *  against the list as a whole rather than typing into it, and at the per-keystroke cap of 200 a
   *  campus's buildings past the first couple hundred could never be proposed at all. The row
   *  picker's own live search keeps the smaller cap.
   *
   *  Caches `{rows, complete, empty}` on `this._assignCands`. **`complete`** means the list is the
   *  whole set, so it can also back the per-row picker; it is false both when the server's row cap
   *  clipped the results and when the fetch failed outright, and in either case the picker falls
   *  back to a live per-keystroke search rather than pretending a partial list is authoritative.
   *  Raising the cap moved that threshold without touching the contract — a facility past the
   *  higher cap still reports `truncated` and still falls back.
   *  A failed fetch caches an empty list rather than retrying on every re-render — the step still
   *  works, it just has nothing to propose.
   *
   *  **`empty`** is *why* there are no rows, for the step to explain rather than shrug at
   *  (IMPORT-17): `'error'` (the fetch failed — already toasted), `'no-campus'` (campus mode with no
   *  campus Site chosen, so `?site=` can't scope the search), or `'scope'` (the query ran and this
   *  facility genuinely holds no buildings). Distinguishing them matters because the third is nearly
   *  always the import sitting in the wrong facility, which looks identical to "you have no
   *  buildings" from here — the failure this item was reported for. `null` when there are rows.
   *
   *  Invalidated by `_regroup` (which re-identifies every building). A building created in NetBox
   *  in another tab mid-session won't appear until then — acceptable, since the per-row picker
   *  always resolves an override against live data when the list isn't complete, and a fresh entry
   *  after a regroup re-fetches. */
  async _loadBuildingCandidates() {
    const campus = this.w._isCampusMode();
    if (campus && !this.w._campusSlug()) {
      this._assignCands = { rows: [], complete: false, empty: 'no-campus' };
      return;
    }
    try {
      const res = campus
        ? await this.w.app.netbox.buildingLocations('', this.w._campusSlug(), true)
        : await this.w.app.netbox.sites('', true);
      const rows = res.locations || res.sites || [];
      this._assignCands = { rows, complete: !res.truncated, empty: rows.length ? null : 'scope' };
    } catch (e) {
      Toast.show('Could not load the building list: ' + e.message, true);
      this._assignCands = { rows: [], complete: false, empty: 'error' };
    }
  }

  /** The pile's empty-candidate note — the elements that replace its summary bar when there is
   *  nothing to match filenames against (IMPORT-17).
   *
   *  The old copy ("name them above, then pick one per drawing") read as a statement of fact about
   *  the operator's NetBox, and was a dead end whenever it wasn't one: the same screen appears when
   *  the import is simply pointed at the wrong facility, and the layout step two steps earlier has
   *  usually just told them how many buildings exist. So each reason says which question came back
   *  empty and offers the way out of it, and the `'scope'` case names the facility being searched —
   *  the one thing that distinguishes "you have no buildings" from "you are looking in the wrong
   *  place". It also says what state that leaves the rows in, since a screen full of blank pickers
   *  otherwise reads as a broken step rather than an unanswerable question. */
  _noCandidatesNote(why) {
    const hint = (text) => Dom.el('span', { class: 'hint' }, text);
    // Shared tail: with nothing to match against, every row below is blank (IMPORT-18) — say so,
    // and name the one-click way to leave them out (IMPORT-48/54).
    const defaulted = ' Every drawing below is unassigned. Name a building above and pick it for '
      + 'each, or use the button below to leave them out.';
    // A retry/re-scope has to drop the cache, or the step re-renders the same empty list.
    const again = () => { this._assignCands = undefined; this.step(); };
    if (why === 'error') {
      return [
        hint('The building list could not be loaded, so no filename was matched against it.'
          + defaulted),
        Dom.el('button', { onclick: again }, 'Try again'),
      ];
    }
    if (why === 'no-campus') {
      return [
        hint('No campus site has been chosen yet, so there is nowhere to search for buildings. '
          + 'This facility is set up as “Site = campus”, where buildings are Locations beneath one '
          + 'site.' + defaulted),
        Dom.el('button', { onclick: () => this.w._stepCampus(again) }, 'Choose the campus site'),
      ];
    }
    const where = this.w._isCampusMode() && this.w.campus
      ? 'buildings under “' + this.w.campus.name + '”' : 'sites';
    return [hint('The ' + this.w.app.facilityName() + ' facility holds no ' + where + ', so there was '
      + 'nothing to match filenames against.' + defaulted + ' If your buildings belong to a '
      + 'different facility, switch to it with the facility picker at the top. Otherwise name each '
      + 'building here.')];
  }


  /** Drop every session answer. Called by the flow's `_reset()`: a reset replaces the drawings
   *  entirely, so what the operator said about the old ones is no longer evidence about anything
   *  (IMPORT-22) — nor is which building they sorted them into (IMPORT-25), since the folders
   *  those answers named are gone with them; the expansion state and the answered-organize flag
   *  (IMPORT-34) name those same folders, so they go too, as does the whole answer store
   *  (IMPORT-42) — its keys name the very drawings being replaced. `_assignCands` is left alone,
   *  matching the pre-merge behaviour — it caches NetBox state, not upload state, and `_regroup` is
   *  its invalidator. */
  reset() {
    this._assignMemory.clear();
    this._organizePicks.clear();
    this._expanded.clear();
    this._organized = false;
    this._answers = ImportOrganize.emptyAnswers();
  }
}
