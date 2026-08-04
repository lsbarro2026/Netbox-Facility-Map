'use strict';
/* import-flow.js — ImportFlow: the shared base for the in-app "import a facility from PDFs"
   flows. It owns everything both flows share — the step-rendering machinery (upload, bind, floor
   mapping), the building model, draft persistence, floor resolution, and the build — and defers
   only the handful of genuine divergence points to subclass hooks (`_resume`, `_onScanError`,
   `_buildingsActions`).

   The self-contained concerns live in collaborators, each constructed here with a back-ref
   (the ImportUploader pattern) and reachable as a field:
     • uploader  ImportUploader — file ingestion + upload
     • regions   ImportRegions  — the code-crop pick (a section of the Site plan step, plus its
                                  per-building detour) + the region-split editor
     • align     ImportAlign    — the GIS-overlay align editor + its control-point solver
     • bulk      ImportBulk     — bulk floor triage (the building header's cluster)
     • diff      ImportDiff     — the pre-build room-safety diff + its post-build repairs
     • organize  ImportOrganize — the fresh flow's merged Buildings step: organize drawings into
                                  buildings + anchor them to NetBox (IMPORT-3/IMPORT-34)
     • topology  ImportTopology — the facility-layout step (TOPO-3) + the campus step (MODEL-7)
     • binder    ImportBind     — the edit hub's bind screen; the shared anchor picker + facility
                                  assignment surface both flows render (MULTI-6)
     • cards     ImportCards    — the map step's per-building card grid (floor pickers, Replace)
   Image zoom/pan, the box-editor zoom bar, and the lightbox live on the static ImportPreview.

   Two subclasses specialize it (like Editor → FloorEditor/SiteplanEditor):
     • FreshImportFlow  — the linear first-time import: grouping → upload → sites → site plan →
                          map floors → build.
     • EditImportFlow   — the non-linear edit hub for revising an already-built facility
                          (Settings → "Edit buildings & floors").
   App.showImport() picks the subclass by store.hasContent() (a built facility → edit hub).

   Whichever flow drives, the PDFs carry no text layer, so floor identity is assigned here, not
   inferred. Mount-aware: file uploads and thumbnail/PDF previews resolve against window.MAP
   (api/media), and uploads carry the session CSRF token; scan/build/reset ride the shared
   Api.post wrapper (which rebases /api/* and adds CSRF). */

class ImportFlow {
  static HIRES_AT = 260;   // card width (px) at/above which the size slider upgrades to hi-res
  // How a scan waits out a **busy** server (IMPORT-47). `import/scan` doubles as its own status
  // probe: while another import holds the working-dir lock the POST 409s immediately, without
  // spawning a render — so re-sending it is a cheap poll that returns the inventory the moment the
  // lock frees, which no separate status read could. The budget covers a full-length build
  // (`render_timeout_s`, 300s by default) so an honest wait never gives up early, and is bounded so
  // a lock stranded by a crashed render — reclaimed only after 2 × that — still surfaces as an
  // error rather than spinning forever.
  static SCAN_BUSY_POLL_MS = 2000;
  static SCAN_BUSY_BUDGET_MS = 300000;
  // Upload folders reserved by the pipeline, which `PreprocessBase.building_folders` skips by
  // name — so a drawing in either is invisible to `scan`/`build` and never becomes a building.
  // `EXCLUDED_FOLDER` is where the organize step parks a drawing the operator dropped from the
  // import (IMPORT-24). `THUMBS_FOLDER` is the render cache, named here only so the "Add building"
  // field can refuse it: typing it used to move drawings into the cache, where they vanished.
  // Both mirror the Python constants (`preprocess.PreprocessBase`, `render_runner.RenderRunner`).
  static EXCLUDED_FOLDER = '_excluded';
  static THUMBS_FOLDER = '.thumbs';
  // Location fields the floor-label picker may choose between (value -> option text). Matches
  // the fixed set `frontend_api._trim` exposes for a Location, so a floor's label is always one
  // of these three known JSON keys, never an arbitrary attribute.
  static LABEL_FIELDS = [
    ['name', 'Location name'], ['slug', 'Location slug'], ['description', 'Location description'],
  ];
  // Below this OCR confidence a floor code the sweep resolved is routed back to the operator
  // (IMPORT-53): it passes the build gate like any other suggestion, so the only thing between a
  // faint misread and a built map is somebody noticing it. Set where the reader's own scores put
  // a hesitant read — a clean title block reads far above it, a smudged or rotated one below.
  static LOW_OCR_CONF = 0.6;
  // At or above this confidence a floor code that matched a floor **literally** is taken as the
  // answer rather than offered as a suggestion (IMPORT-63) — the one place in the wizard where a
  // read commits on its own. Four guard rails, not the threshold alone, are what make that safe:
  // only the literal rung of `ImportBulk._suggestFrom` may auto-accept (its ordinal and alignment
  // rungs are inferences and stay suggestions), only an `isUnanswered` drawing is ever filled, the
  // card says so in words (`ImportCards._autoAcceptBadge`), and `_undoAutoAccepted` turns the whole
  // set back into suggestions in one action. Well clear of `LOW_OCR_CONF`, which routes a *faint*
  // read to the operator — the two thresholds answer different questions and neither implies the
  // other.
  static AUTO_ACCEPT_OCR_CONF = 0.8;
  // The install-wide facility grouping (MULTI-3/MODEL-8), `[value, title, what it does]`. Mirrors
  // the server's `facilities.GROUPING_CHOICES`; the count beneath each option is live.
  static GROUPING_OPTIONS = [
    ['sitegroup', 'Site Group',
      'Sites grouped organizationally or functionally (dcim.SiteGroup). The default.'],
    ['region', 'Region',
      'Sites grouped geographically by country, campus, or building cluster (dcim.Region).'],
    ['location', 'Building / Location',
      'Splits the install into one facility PER top-level Location (a building or wing) — not a '
      + 'way to say “our buildings are Locations under one Site.” If your whole campus is a '
      + 'single NetBox Site with buildings modelled as Locations beneath it, keep Site Group or '
      + 'Region here and choose “Site = campus” below instead.'],
  ];
  // The per-facility organization mode (MODEL-6), `[value, title, what it means]`. Lockstep with
  // the server's `facilities.ORG_MODE_CHOICES` and the Settings row's own allowlist.
  static ORG_MODE_OPTIONS = [
    ['site-as-building', 'Site = building',
      'Each building is its own NetBox site; its floors are the site’s top-level Locations.'],
    ['site-as-campus', 'Site = campus (buildings are Locations)',
      'One campus site holds every building as a Location; floors are those buildings’ children.'],
  ];

  constructor(app) {
    this.app = app;
    this.inv = null;        // scan inventory { folders:[{folder, pdfs:[...]}] }
    this.buildings = [];    // per-folder editable model (see _modelFromInventory)
    this.site = { folder: '', file: '' };  // chosen siteplan PDF (or empty = none)
    this.thumbWidth = 480;  // map-step card width (px); the size slider drives it (its centred default)
    this._bIdx = 0;         // index of the building currently visible in the map step
    this._autoMapDone = false;  // the building→NetBox auto-match pass runs once per scan
    // The facility's **campus Site** under the declared `site-as-campus` organization mode
    // (MODEL-6/MODEL-7): `{id, slug, name}`, or null when unchosen. One facility-level fact, not a
    // per-building one — every drawing folder then binds to a building **Location** beneath it, so
    // this scopes the bind search and the auto-match. Persisted in the draft; ignored entirely in
    // `site-as-building` mode. `_campusPromptDone` gates the once-per-session detour into
    // `_stepCampus`, so skipping it doesn't loop back on the next bind-step render.
    this.campus = null;
    this._campusPromptDone = false;
    // Floor assignment shows a cropped close-up of each drawing's identifying code so floors
    // are recognizable at a glance. `_codeRegion` is the normalized 0..1 box the user drags
    // over that code on a sample drawing, applied as a crop to every drawing (a building can
    // override it with its own `codeRegion` when its title block sits elsewhere). A null region
    // falls back to full-drawing thumbnails. Persisted in the draft.
    this._codeRegion = null;
    // Whether the **Site plan** step — which picks the site plan (it carries no floor code, so it
    // is chosen apart from floor assignment) and marks that global code region, one step since
    // IMPORT-37 — has been answered. Persisted, and read by `FreshImportFlow._resume` alone, to
    // decide where a restored in-progress import lands: it is NOT a gate on the map step, which
    // always renders the map. `_regionZoom` is the
    // transient zoom factor shared by the box editors (a view aid, not persisted). It is an
    // object, not a number, because `ImportPreview.zoomBar` mutates the holder in place — the
    // same `{deg}` convention `ImportPreview.rotateControls` uses — so the factor survives a step
    // switch without the editors reaching back through the flow to write it.
    this._siteplanStepDone = false;
    this._regionZoom = { z: 1 };
    // Which Location field a Location-mode floor's label is drawn from (see LABEL_FIELDS).
    // Defaults to the server's `floor_label_field` PLUGINS_CONFIG setting; re-validated against
    // the known field set (never trust window.MAP blindly) and persisted in the draft.
    const mapField = window.MAP && window.MAP.floorLabelField;
    this._floorLabelField = ImportFlow.LABEL_FIELDS.some(([f]) => f === mapField)
      ? mapField : 'name';
    // Add-drawings flow: when true the upload step merges new PDFs into the current model
    // (re-applying the saved draft so existing assignments survive) instead of starting fresh.
    this._mergeMode = false;
    // Upload-step controls the in-flight upload guard drives (IMPORT-30): written by `_stepUpload`,
    // read by `_setUploadPhase` as `ImportUploader` changes phase. Null until that step renders.
    this._dropZone = null;
    this._dropLabel = '';
    this._zipLink = null;
    this._uploadBack = null;
    // The upload step's Continue button and the fact it is gated on (IMPORT-32): whether any
    // drawing exists on the server yet. `_setUploadPhase` combines that with the in-flight phase.
    this._continueBtn = null;
    this._continueLabel = '';
    this._uploadHasContent = false;
    // The single-flight scan (IMPORT-47): the promise of the `import/scan` currently in flight, or
    // null when none is. Every scan in the wizard goes through `scan()`, so a second caller joins
    // this one instead of firing a POST the server's render lock would 409. `_scanWaiting` is the
    // narrower state where the scan *did* 409 and is being waited out, which the upload step's
    // Continue button says out loud.
    this._scanFlight = null;
    this._scanWaiting = false;
    // `folder/stem` of every drawing whose bytes were replaced in place this session (REPL-1). A
    // Replace keeps the floor id (so `ImportDiff.orphanedFloors` won't flag it) and usually the same
    // pixel size + aspect ratio (so `ImportDiff.desyncedFloors`' angle/aspect checks won't either), yet a
    // revision with shifted margins/title-block silently misaligns rooms placed against the old
    // drawing — undetectable from manifest metadata (only `w`/`h` + angle are recorded). So a
    // replaced drawing with placed features drives an unconditional desync warning at build time.
    // Cleared after a successful build (the manifest is then rebuilt from the new drawing).
    this._replaced = new Set();
    // Site slug -> that Site's full flat Location list, as last fetched by `_loadFloors`. A
    // session cache for the tree questions the anchor controls ask (which Locations sit under the
    // anchor, what a Location's parent is called) — deliberately on the flow, NOT on a building:
    // `_saveDraft` serializes `this.buildings` whole, so a per-building copy would bloat every
    // draft with the site's Location list. Rewritten on each fetch, so it is as fresh as that
    // building's last floor load; consumers are read-only and degrade to "no tree info". Left alone
    // by `_reset()`, like `organize._assignCands` — it caches NetBox state, not upload state.
    this._siteLocs = new Map();
    // The self-contained concerns, each holding a back-ref to this flow (see the file header).
    // Image zoom/pan + lightbox live in the static ImportPreview, which needs no instance.
    this.uploader = new ImportUploader(this);
    this.regions = new ImportRegions(this);
    this.align = new ImportAlign(this);
    this.bulk = new ImportBulk(this);
    this.diff = new ImportDiff(this);
    this.organize = new ImportOrganize(this);
    this.topology = new ImportTopology(this);
    this.binder = new ImportBind(this);
    this.cards = new ImportCards(this);
    // Constructed after `bulk`: the sweep resolves its reads through it (IMPORT-53).
    this.ocr = new ImportOcrSweep(this);
    // ...and after `ocr`: the overview reports the sweep's coverage per building (IMPORT-63).
    this.overview = new ImportOverview(this);
  }

  // ---- helpers ----
  /** True when `loc` sits anywhere beneath the Location `ancestorId` in `byId` (the site's flat
   *  `id -> Location` map). Walks the plain `parent` edge — NetBox's MPTT `depth`/`level` fields are
   *  unreliable on 4.2+, so the tree is always read through `parent` here. Bounded by the map size,
   *  so a cyclic or truncated list can't loop forever. */
  static _isUnder(loc, ancestorId, byId) {
    let cur = loc, steps = byId.size;
    while (cur && cur.parent != null && steps-- > 0) {
      if (cur.parent === ancestorId) return true;
      cur = byId.get(cur.parent);
    }
    return false;
  }

  /** Which tier of the site's Location tree this building's floors sit in — the number the server's
   *  `truncated_depth` is compared against to decide whether a clipped answer clipped anything that
   *  matters (IMPORT-49). Tier 0 is a root Location, so the answer is the anchor's own tier + 1.
   *
   *  A **Site anchor** (no `buildingSlug`) always answers 1: `_floorsFromLocations` reads the roots
   *  (tier 0) and the building root's children (tier 1), and nothing deeper.
   *
   *  A **Location anchor** is located in the list and its tier counted up the `parent` chain (the
   *  same plain-FK walk `_isUnder` uses, and bounded the same way). `null` when the anchor itself
   *  isn't in the answer — either the Location is gone, or the read was clipped *above* the floors,
   *  and the caller must treat the floor list as incomplete either way. */
  static _floorTier(locs, buildingSlug) {
    if (!buildingSlug) return 1;
    const anchor = locs.find(l => l.slug === buildingSlug);
    if (!anchor) return null;
    const byId = new Map(locs.map(l => [l.id, l]));
    let tier = 0, cur = anchor, steps = byId.size;
    while (cur && cur.parent != null && steps-- > 0) { tier++; cur = byId.get(cur.parent); }
    return tier + 1;
  }

  /** Did the server's row cap clip anything this building's **floor list** depends on?
   *
   *  `truncated` alone used to answer that, and answered it wrong in the common direction: the read
   *  arrives shallowest-first (IMPORT-49), so what a cap clips is the deepest tier — the site's
   *  *rooms*, which the floor list doesn't read. Treating that as a partial floor list is what put
   *  a warning on every building of any real facility and, worse, made `_loadFloors` skip the stale
   *  -token sweep it exists to run.
   *
   *  So compare where the clip landed (`truncated_depth`) against where the floors live
   *  (`_floorTier`): a clip strictly below them leaves the floor list complete. Anything the server
   *  can't answer for — a floor tier that can't be established, or a server too old to send
   *  `truncated_depth` — counts as clipped, so the guard fails safe. */
  static _clippedTheFloors(res, locs, buildingSlug) {
    const floorTier = ImportFlow._floorTier(locs, buildingSlug);
    if (floorTier === null || typeof res.truncated_depth !== 'number') return true;
    return res.truncated_depth <= floorTier;
  }

  /** The display name of an install-wide facility grouping (MULTI-3/MODEL-8). One place, so the
   *  wizard's options, the edit hub's row and any future reader can't drift — and so the third
   *  choice can't be quietly rendered as the first, which is what a two-branch ternary did. */
  static groupingLabel(grouping) {
    const opt = ImportFlow.GROUPING_OPTIONS.find(([value]) => value === grouping);
    return opt ? opt[1] : grouping;
  }

  static slugify(s) {
    return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  static prettyName(folder) {
    return folder.replace(/^\d+\s*[-_ ]\s*/, '').replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ').trim() || folder;
  }
  static initials(name) {
    const w = name.split(/\s+/).filter(Boolean);
    return (w.length > 1 ? w.map(x => x[0]).join('') : name.slice(0, 3)).toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  /** Resolve a working-dir-relative asset path (thumbnail / PDF) to its authenticated
   *  media URL, carrying the active facility so it serves from that facility's working dir. */
  static _media(rel) {
    return Api.withFacility((window.MAP ? window.MAP.media : '/') + encodeURI(rel));
  }

  /** One non-siteplan drawing's starting floor assignment: the floor its own filename names when it
   *  names one (`ImportBulk.floorFromStem`, marked `suggested` so `_floorButtons` shows it as a
   *  pre-fill awaiting confirmation), else the positional Level 1..N default this always used.
   *  `i` is the drawing's index within its building.
   *
   *  The positional default carries `autoDefault` (IMPORT-63): it is a *placeholder*, not an answer
   *  — nobody looked at the drawing to produce it — and before this flag nothing could tell it apart
   *  from a Level N the operator picked by hand. That indistinguishability is what made the
   *  floor-code sweep read nothing at all in floor-type fallback mode: `_defaultAssign` leaves no
   *  drawing `unassigned`, so the sweep's "only blanks" rule matched none of them. See
   *  `isUnanswered`. */
  static _defaultAssign(p, i) {
    const g = ImportBulk.floorFromStem(p.stem);
    return g
      ? { type: g.type, num: g.num, token: null, label: '', suggested: true }
      : { type: 'level', num: i + 1, token: null, label: '', autoDefault: true };
  }

  /** Whether an assignment is still **nobody's answer** — the predicate the floor-code sweep reads
   *  and writes through, and the one auto-accept is allowed to fill (IMPORT-63). Three states
   *  qualify, and each is a placeholder the wizard produced rather than a decision the operator
   *  made:
   *    - `type === 'unassigned'` — Location mode's explicit blank (`_normalizeToLocations`);
   *    - `suggested` — a filename or floor-code pre-fill awaiting confirmation (IMPORT-28);
   *    - `autoDefault` — the blind positional Level 1..N of `_defaultAssign`.
   *
   *  Everything else is somebody's answer and is never touched. That boundary is the whole safety
   *  property: an operator pick clears all three markers in one place (`clearUnanswered`), so
   *  widening what OCR may write can never reach a floor a human chose. `type: 'none'` is likewise
   *  a real decision and is deliberately absent from the list. */
  static isUnanswered(a) {
    return !!a && (a.type === 'unassigned' || !!a.suggested || !!a.autoDefault);
  }

  /** Retire every "not yet answered" marker on `a` — what the operator answering looks like in the
   *  model. Called from each place a human commits a floor (`ImportCards._floorButtons`,
   *  `_addFloor`, the re-anchor pick, `ImportBulk._apply`) so the four can't drift apart, which is
   *  exactly how a stale `suggested` badge used to survive a hand-picked floor. */
  static clearUnanswered(a) {
    if (!a) return;
    a.suggested = false;
    delete a.autoDefault;
    delete a.autoAccepted;
  }

  /** A persisted floor `assign` is trustworthy only if it's an object carrying a string `type`
   *  (what `_resolveFloors`/`_cardUnassigned` read). Used to drop a malformed entry on draft
   *  resume so it degrades to the model default instead of throwing mid-render. The optional
   *  `suggested` flag rides along untouched — an older draft simply has none, which reads as
   *  "the operator's own answer", exactly the safe default. */
  static _validAssign(a) {
    return !!a && typeof a === 'object' && typeof a.type === 'string';
  }

  /** A persisted region-split entry is `{ box:{x,y,w,h}, assign }`; validate the box numerics and
   *  the nested assign so a corrupt draft can't strand `ImportRegions.openSplit`/`_resolveFloors`. */
  static _validRegion(r) {
    const box = r && r.box;
    return !!box && ['x', 'y', 'w', 'h'].every(k => typeof box[k] === 'number')
      && ImportFlow._validAssign(r.assign);
  }

  /** A persisted campus pick (MODEL-7) is `{id, slug, name}` with a string `slug` (what
   *  `_campusSlug`/`buildingLocations` key off) — anything else is dropped on resume so a corrupt
   *  draft degrades to "no campus chosen" rather than scoping the search to a bogus slug. */
  static _validCampus(c) {
    return !!c && typeof c === 'object' && typeof c.slug === 'string' && !!c.slug;
  }

  /** A persisted overlay control point (FMT-6) is `{src:[x,y], dst:[nx,ny]}` of finite numbers —
   *  anything else (corrupt draft) is dropped so the layer just falls back to fit-to-bounds.
   *  Mirrors the backend's `OverlayProjector._clean_pairs` gate. */
  static _validAlignPair(p) {
    const pt = (v) => Array.isArray(v) && v.length >= 2
      && typeof v[0] === 'number' && isFinite(v[0])
      && typeof v[1] === 'number' && isFinite(v[1]);
    return !!p && typeof p === 'object' && pt(p.src) && pt(p.dst);
  }

  /** Whether a saved draft says the **Site plan** step has been answered (`_siteplanStepDone`).
   *  A draft written before IMPORT-37 knows nothing of that step — it carries the two flags of the
   *  two steps the merge replaced, so it counts as answered only when **both** were: a draft that
   *  picked a site plan and stopped has genuinely not answered the code-region half, and must be
   *  asked it rather than resumed straight onto the map. */
  static _draftStepDone(draft) {
    if (!draft || typeof draft !== 'object') return false;
    if (draft.siteplanStepDone !== undefined) return !!draft.siteplanStepDone;
    return !!(draft.siteplanDone && draft.codeRegionDone);
  }

  /** Render a fresh `#stage` view with the step title. `stepKey` (one of a flow's linear step
   *  ids, or undefined for a detour/transient screen) is handed to the `_chrome` hook so a flow
   *  can prepend step chrome — a progress stepper (fresh) or a header (edit) — above the title.
   *
   *  The home crumb below is a live link out of the wizard on every screen of both flows. It
   *  carries no guard of its own: it navigates like any other in-app link, so `App._navigate`
   *  refuses it through `navRefusal` while a run is in flight (IMPORT-61), along with the other
   *  ways out the wizard never drew. Its label routes through `homeCrumbLabel()` like every other
   *  home-crumb head, since a fresh import (where this label is seen most) has no siteplan yet
   *  (IMPORT-62). */
  _stage(title, stepKey) {
    this._clearUploadRefs();
    this.app.current = null;
    this.app.crumbs([{ label: this.app.homeCrumbLabel(), hash: '/' }, { label: 'Import' }]);
    this.app.setToolbar([]);
    const stage = Dom.$('#stage'); stage.innerHTML = '';
    const children = [Dom.el('h2', {}, title)];
    const chrome = this._chrome(stepKey);
    if (chrome) children.unshift(chrome);
    const view = Dom.el('div', { class: 'import-view' }, children);
    stage.append(view);
    return view;
  }

  /** Forget the upload step's control refs, because `_stage` is about to wipe `#stage` out from
   *  under them. Every node `_stepUpload` kept is detached from that moment on, so clearing them
   *  here is what makes `_setUploadPhase`'s "is this step on screen" test honest: a scan completing
   *  from somewhere else in the wizard (`_refreshUploadPhase` runs from `scan()`, anywhere) would
   *  otherwise write phase state into a dead step — and, since IMPORT-55, dim the chrome of whatever
   *  step actually is on screen. `_stepUpload` re-seats every one of these as it renders. */
  _clearUploadRefs() {
    this._dropZone = null;
    this._progress = null;
    this._uploadNote = null;
    this._continueBtn = null;
    this._uploadBack = null;
    this._zipLink = null;
  }

  /** Prepend the discoverable top-of-page `.imp-back-top` control every full-stage detour needs
   *  (a screen staged with no `stepKey`, so `_chrome` renders no stepper/header) — named for the
   *  destination it returns to, landing above the title. Bottom action rows (Cancel/Done) are
   *  unchanged; this exists because a tall canvas + list means scrolling all the way down is the
   *  only other way out. */
  _detourBack(view, label, onclick) {
    view.insertBefore(Dom.el('button', { class: 'imp-back-top', onclick }, label), view.firstChild);
  }

  /** Hoist a copy of a step's action row to the **top** of the view, directly under the title
   *  (IMPORT-66) — the row-level sibling of `_detourBack`, and the counterpart to the bottom row's
   *  sticky rule (IMPORT-64). A step whose content runs for pages — the Buildings step's
   *  facility-scale grid, the edit hub's bind list — is one an operator arrives at from the top and
   *  often has nothing left to do on, so the forward action belongs where they already are.
   *
   *  **Under the title, not above the content.** What sits between the two is unbounded: the grouped
   *  Buildings step's preamble alone can carry the campus row, the hoisted facility control and
   *  "Confirm all N". Anchoring to the title is the only placement that is scroll-free on every
   *  presentation.
   *
   *  The caller owns the row and must build it **in the same paint as the bottom one, from the same
   *  gate** — see `ImportOrganize.paintActions`, which fills both from one `continueGate()`. That is
   *  what answers IMPORT-64's objection to a mirrored row: the risk was never the second row, it was
   *  a second *paint path* that could miss a repaint and offer a Continue the real gate has disabled.
   *  Two rows off one call cannot disagree.
   *
   *  Inserting rather than appending is also what keeps the bottom row sticky: the CSS match is
   *  `.import-view > .imp-actions:last-child`, which this copy never is. */
  _actionsTop(view, row) {
    row.classList.add('imp-actions-top');
    // `_stage` builds the only `h2` a step view ever holds, so the title is unambiguous — and
    // anchoring to it rather than to a child index survives the optional `_chrome` above it.
    const title = view.querySelector('h2');
    view.insertBefore(row, title.nextSibling);
    return row;
  }

  // ---- step-chrome hooks (fresh-vs-edit divergence; see FreshImportFlow/EditImportFlow) ----

  /** Optional chrome prepended above a step's title (a stepper for the linear fresh flow, a header
   *  for the edit hub). `stepKey` identifies the current linear step, or is undefined on a
   *  detour/transient screen. The base renders none — a flow overrides to add it, keeping the
   *  divergence in a hook rather than a `store.hasContent()` branch inside a shared step. */
  _chrome(_stepKey) { return null; }

  /** Optional `← Back` control for a linear step's action row (the previous step). The base
   *  returns none; `FreshImportFlow` returns a button so the linear walk is reversible, while the
   *  non-linear edit hub leaves it null (each shared step drops the null child via `Dom.el`). */
  _backButton(_stepKey) { return null; }

  /** Reflect "a run is in flight" onto whatever nav-away the chrome itself offers, so the chrome and
   *  the step's own back button are disabled in step rather than drifting apart (IMPORT-55). Called
   *  by `_setUploadPhase` — the single writer of that state — and only while the upload step is on
   *  screen. The base renders no chrome, so it has none to disable; `FreshImportFlow` overrides for
   *  its stepper, whose done entries jump back to an earlier step, while the edit flow's static
   *  header has nothing to click. */
  _setChromeBusy(_busy) {}

  // ---- the scan (single-flight, busy-tolerant) ----

  /** Whether an `import/scan` is in flight — read by `_setUploadPhase` as the third conjunct of
   *  the Continue gate. */
  get scanBusy() { return !!this._scanFlight; }

  // ---- leaving the wizard (App's stage-page nav guard) ----

  /** Refuse to be navigated **out of the wizard** while an upload run or a scan is in flight
   *  (IMPORT-61) — `App._navRefusal` asks this from the navigation chokepoint, so it answers for
   *  every door the wizard itself didn't draw: the crumb trail's `Siteplan` link (stamped on every
   *  screen by `_stage`, in both flows), browser Back/Forward, the settings gear, the facility
   *  picker. `_goToStep` guards the ways off a *step*; this guards the ways off the *wizard*, and
   *  the hazard is the same one — leaving mid-run detaches the live `_progress` node the runner
   *  narrates into, and leaving mid-scan lets that scan re-stage the wizard on top of wherever the
   *  operator went.
   *
   *  Same `busyGate` decision as every other refusal, so the wording can't say something different
   *  from what the upload step is showing. The refusal is bounded by construction: a run always
   *  ends back at `idle`, and `scan()` clears `_scanFlight` in a `finally` within
   *  `SCAN_BUSY_BUDGET_MS` — an unbounded one would trap the operator in the wizard. Returns the
   *  message to show, or null to allow the navigation. */
  navRefusal() {
    const gate = ImportFlow.busyGate({ phase: this.uploader.phase, scanBusy: this.scanBusy });
    return gate.busy ? gate.message : null;
  }

  /** **Every** `import/scan` in the wizard goes through here (IMPORT-47). Two guarantees:
   *
   *  - **Single-flight.** A scan already in flight is *joined*, not raced. §10 makes the client
   *    responsible for never sending a second scan — the server's render lock is a backstop, and
   *    its 409 is an error the user can do nothing with. A scan fired straight off the Continue
   *    button (`_scanAndMap`) used to sit outside any such coordination, so stepping back to the
   *    upload step and clicking Continue twice put two scans on the wire: the loser toasted `an
   *    import is already running`, then the winner navigated on its own a minute later. That button
   *    is now the wizard's *only* scan trigger (IMPORT-65), which makes this the guarantee the whole
   *    step rests on rather than a second one beside the uploader's.
   *  - **A busy server is waited out, never surfaced raw.** Something else can still hold the lock
   *    (a build in another tab, a `reset`), which no client-side flag can know about. That 409 is
   *    polled through (see `SCAN_BUSY_*`) rather than thrown at a user who was invited to press
   *    the button; only a genuinely stuck lock ends as an error, and it says what it means.
   *
   *  Resolves to the scan's inventory JSON; throws like `Api.post` on a real failure, so every
   *  existing `catch` keeps working unchanged. */
  scan() {
    if (!this._scanFlight) {
      this._scanFlight = this._runScan().finally(() => {
        this._scanFlight = null;
        this._scanWaiting = false;
        this._refreshUploadPhase();
      });
      this._refreshUploadPhase();
    }
    return this._scanFlight;
  }

  /** POST the scan, polling through a busy server. Kept apart from `scan()` so the single-flight
   *  bookkeeping has one exit (`finally`) regardless of how this returns. */
  async _runScan() {
    const deadline = Date.now() + ImportFlow.SCAN_BUSY_BUDGET_MS;
    for (;;) {
      try {
        return await Api.post('/api/import/scan', {});
      } catch (e) {
        // Only the working-dir lock's 409 is worth waiting on; every other failure is the caller's
        // to report (`Api._fail` attaches the status so this needn't re-parse the message).
        if (e.status !== 409 || Date.now() >= deadline) {
          if (e.status === 409) {
            throw new Error('another import has been running for too long — reload the page, and '
              + 'if it persists ask an administrator to check the server');
          }
          throw e;
        }
        if (!this._scanWaiting) { this._scanWaiting = true; this._refreshUploadPhase(); }
        await ImportFlow._sleep(ImportFlow.SCAN_BUSY_POLL_MS);
      }
    }
  }

  /** The busy-poll's delay. Private to the scan loop — the wizard has no other timed wait, so this
   *  stays here rather than becoming a shared `Util` helper on nothing's behalf. */
  static _sleep(ms) { return new Promise(done => setTimeout(done, ms)); }

  /** Re-run the upload step's control gate against the current scan state. A no-op unless that
   *  step is on screen (`_setUploadPhase` is null-guarded throughout), so `scan()` can call it
   *  from anywhere in the wizard. */
  _refreshUploadPhase() {
    this._setUploadPhase(this.uploader.phase);
  }

  async show() {
    // Probe for an in-progress import (existing uploads). The scan also regenerates
    // thumbnails so the map step's cards are ready when we jump straight to it.
    const loadView = this._stage('Import a facility');
    loadView.append(Dom.el('p', { class: 'imp-progress' }, 'Checking for existing uploads…'));
    // The bind step steers off the facility's declared organization mode (MODEL-7), which lives on
    // the facility list. `init()` loads that list fire-and-forget, so await it here rather than
    // letting a slow boot fetch make a `site-as-campus` facility read as the default and get
    // Site-anchored suggestions — the exact by-luck binding this step exists to end.
    await this.app.ensureFacilities();
    let inv;
    try {
      inv = await this.scan();
    } catch (e) {
      // A scan *failure* is NOT the same as "no uploads": swallowing it and falling to a fresh
      // upload would make a built facility look like it vanished. Each flow decides how to
      // degrade — a fresh import falls to upload, an edit shows a retry (never a fake fresh
      // install). See `_onScanError`.
      return this._onScanError(e);
    }
    if (inv.ok && inv.folders?.length) {
      this.inv = inv;
      this._modelFromInventory();
      await this._applyDraft();
      this._reconcileFromManifest();
      return this._resume();   // subclass hook: where an in-progress import lands
    }
    return this._freshStart();
  }

  /** A brand-new import opens with the topology question — what a facility is, and what a building
   *  is (MULTI-3 + MODEL-6, TOPO-3) — before the first upload. Shared by both flows: a fresh open
   *  with no existing uploads starts here regardless of which flow is driving (the edit hub reaches
   *  the same step from its own row instead). */
  _freshStart() {
    this._stepTopology(() => this._stepUpload());
  }

  // ---- subclass hooks (the only fresh-vs-edit divergence; see FreshImportFlow/EditImportFlow) ----

  /** Where `show()` routes when a scan finds existing uploads. */
  _resume() { throw new Error('ImportFlow._resume is abstract'); }
  /** Where `show()` routes when the scan itself throws (degrade without faking a fresh install). */
  _onScanError(_e) { throw new Error('ImportFlow._onScanError is abstract'); }
  /** The bind screen's (`ImportBind.step`) action row. Only the edit hub reaches that screen since
   *  IMPORT-34 (fresh overrides `_stepBuildings` to the merged Buildings step, which builds its own
   *  actions), so `EditImportFlow` is the one live override — kept a hook so the screen itself
   *  stays flow-agnostic. */
  _buildingsActions(_focusBuilding) { throw new Error('ImportFlow._buildingsActions is abstract'); }

  /** Where the Buildings step goes when it is done with the buildings question. The edit hub has no
   *  walk, so the base lands straight on the map; `FreshImportFlow` overrides it with the next step
   *  of its linear walk (IMPORT-37). A hook rather than a `hasContent()` branch inside the shared
   *  step — and the reason the map step needs no gates: forward routing lives with the flow that
   *  owns the step order, not with the step being routed to. */
  _afterBuildings() { return this._stepMap(); }

  // ---- step 1: how is this facility organized? (both settings axes, TOPO-3) ----

  /** Which route the topology step opens on: `'detect'` | `'guided'` | `'manual'`. A subclass hook
   *  rather than a `store.hasContent()` branch inside the shared step (§10 in-app-import): a first
   *  import wants to be *told* what it is looking at, while an already-configured facility should
   *  open on what is currently set rather than be nudged off a working configuration. */
  _topologyDefaultRoute() { return 'detect'; }

  /** Ask how this facility is organized (TOPO-3) — `ImportTopology` owns the step; a thin
   *  delegator, kept on the base because both flows drive it directly (the fresh walk opens on it,
   *  the edit hub's "Facility layout" row re-enters it). `next` is where a committed answer
   *  routes. */
  _stepTopology(next) {
    this.topology.open(next);
  }

  /** The setup in force right now, as one short line for the "keep it" control: the install-wide
   *  grouping and this facility's effective organization mode. */
  _currentTopologyLabel() {
    return ImportFlow.groupingLabel(this.app.grouping) + ' · '
      + (this._isCampusMode() ? 'Site = campus' : 'Site = building');
  }

  // ---- step 1.4: the campus Site (site-as-campus organization mode only) ----

  /** The facility's declared NetBox organization mode (MODEL-6) — `'site-as-building'` (a Site *is*
   *  a building) or `'site-as-campus'` (a Site is a campus whose buildings are Locations). Read
   *  through `App.orgMode()`, the single reader; `show()` awaits the facility list first so this is
   *  never a premature default. */
  _orgMode() {
    return this.app.orgMode();
  }

  /** True when this facility is declared Site = campus, so the wizard should bind drawing folders to
   *  building **Locations** beneath one campus Site rather than to Sites. */
  _isCampusMode() {
    return this._orgMode() === 'site-as-campus';
  }

  /** The Site slug the building search scopes to, or `''` for an unscoped facility-wide search:
   *  the chosen campus in `site-as-campus` mode, nothing otherwise (a `site-as-building` facility
   *  has no campus concept, and a stale `campus` from a mode flip must not narrow its search). */
  _campusSlug() {
    return (this._isCampusMode() && this.campus && this.campus.slug) || '';
  }

  /** The buildings that already carry a NetBox anchor. The population every "changing this setting
   *  is safe" note below is *about* — and the reason those notes test bound buildings rather than
   *  `store.hasContent()`: what an operator stands to lose is an anchor they already confirmed, not
   *  a built manifest, and testing the thing itself keeps the copy honest on a first import that
   *  stepped back to the layout step after binding (§10 in-app-import — no flow-mode fork). */
  _boundBuildings() {
    return this.buildings.filter(b => b.nbSite);
  }

  /** Ask for the facility's campus Site (MODEL-7) — `ImportTopology` owns the step; a thin
   *  delegator, kept on the base because both flows drive it directly (the linear walk visits it
   *  between upload and bind, the edit hub's "Campus site" row re-enters it). `next` is where
   *  Continue/Skip route. */
  _stepCampus(next) {
    this.topology.openCampus(next);
  }

  // ---- step 1: upload ----
  _stepUpload() {
    // A fresh visit: the uploader's "uploaded N drawings so far" total and its overwrite bookkeeping
    // span the successive runs of one visit (IMPORT-65), not the wizard's whole lifetime.
    this.uploader.beginVisit();
    // In merge mode the upload step is a detour off the map (add drawings), not the linear step —
    // no stepper and no linear back-nav (a plain Cancel returns to the map instead).
    const view = this._stage(this._mergeMode ? 'Add drawings' : 'Import a facility',
      this._mergeMode ? undefined : 'upload');

    // Stepping back into this step (or simply revisiting it) after drawings are already uploaded
    // must not look empty — the files are server-side the whole time (`this.inv`, the last scan),
    // so there is nothing to re-upload. Merge mode is exempt: there the existing drawings are
    // *expected* to be there already and the ask is purely additive, so it keeps its plain drop
    // zone rather than a "continue with what's here" summary (IMPORT-16).
    const hasFolders = this.inv && this.inv.folders && this.inv.folders.length > 0;
    const uploaded = !this._mergeMode && hasFolders;
    if (uploaded) view.append(this._uploadSummary(this.inv.folders));

    const folderInput = Dom.el('input', {
      type: 'file', class: 'imp-file', multiple: 'multiple', accept: ImportUploader.EXTS.join(','),
      onchange: (e) => this._ingest(ImportUploader.fromInput(e.target.files)),
    });
    folderInput.setAttribute('webkitdirectory', '');

    // Zip via click needs its OWN input: one <input> can't offer both a folder picker and a file
    // picker in the same dialog, so the webkitdirectory folder input above can never present a
    // zip. Triggered by a separate control below; a drag-dropped zip is handled by the drop
    // handler instead.
    const zipInput = Dom.el('input', {
      type: 'file', class: 'imp-file', accept: '.zip',
      onchange: (e) => { const f = e.target.files[0]; if (f) this.uploader.uploadZip(f); },
    });

    // Demoted (smaller, quieter) once the summary above already says what's there — the drop zone
    // is then "add / replace", not the primary action for the step.
    const dropLabel = uploaded
      ? 'Drop or click to add or replace drawings'
      : 'Drop or click to choose a facility folder';
    const drop = Dom.el('div', { class: 'imp-drop' + (uploaded ? ' imp-drop-secondary' : ''),
      onclick: () => folderInput.click() }, [
      Dom.el('div', { class: 'imp-drop-big' }, dropLabel),
    ]);
    // Kept for `_setUploadPhase`, which swaps the label while a scan is running and restores it.
    this._dropZone = drop;
    this._dropLabel = dropLabel;
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault(); drop.classList.remove('over');
      const z = [...(e.dataTransfer.files || [])].find(f => f.name.toLowerCase().endsWith('.zip'));
      if (z) return this.uploader.uploadZip(z);
      this._ingest(await ImportUploader.fromDrop(e.dataTransfer));
    });
    view.append(drop);
    view.append(folderInput);
    view.append(zipInput);
    // Separate affordance for the zip-via-click path (see zipInput) — kept outside the drop zone's
    // onclick, which fires the folder picker.
    this._zipLink = Dom.el('button', { class: 'imp-link', onclick: () => zipInput.click() },
      'Choose a .zip file');
    view.append(Dom.el('div', { class: 'imp-drop-alt' }, [
      Dom.el('span', { class: 'hint' }, 'Have a .zip of your drawings? '),
      this._zipLink,
    ]));
    this._progress = Dom.el('div', { class: 'imp-progress hidden' });
    view.append(this._progress);
    // Guidance panel, shown by `_ingest` when a selection has no importable drawing but does carry
    // 3D BIM/Revit files (see `_showBimGuidance`).
    this._uploadNote = Dom.el('div', { class: 'imp-bim-note hidden' });
    view.append(this._uploadNote);
    const cont = this._mergeMode
      ? Dom.el('button', { class: 'primary', onclick: () => this._mergeUploads() }, 'Done adding')
      : Dom.el('button', { class: 'primary', onclick: () => this._scanAndMap() },
        uploaded ? 'Continue with these drawings →' : 'Continue to mapping');
    // Whether anything exists on the server to continue with (IMPORT-32). Keyed off `hasFolders`,
    // NOT `uploaded`: merge mode and a step-back-after-upload must both count as "has content" even
    // though `uploaded` is false in the former and true in the latter — the two flags answer
    // different questions (what to render vs. whether anything exists to continue with). An upload
    // landing its first file flips this mid-step (`ImportUploader._markContent`).
    this._continueBtn = cont;
    // Kept for `continueGate`, which swaps the label while a scan runs and restores it after —
    // the same `_dropLabel` convention the drop zone uses.
    this._continueLabel = cont.textContent;
    this._uploadHasContent = hasFolders;
    const back = this._mergeMode
      ? Dom.el('button', { onclick: () => { this._mergeMode = false; this._stepMap(); } }, 'Cancel')
      : this._startOver();
    // Linear back to the grouping step (fresh, non-merge only — null in merge mode / edit).
    const linBack = this._mergeMode ? null : this._backButton('upload');
    // The step's nav-away (Cancel in merge mode, the linear back otherwise): leaving mid-run strands
    // a runner still streaming files into a progress line the navigation has detached. "Start over"
    // is guarded in `_reset` instead, since the same button is built by every step.
    this._uploadBack = this._mergeMode ? back : linBack;
    view.append(Dom.el('div', { class: 'imp-actions' }, [linBack, cont, back]));
    // A re-render can land while something is still running (`_scanAndMap` returns here when a scan
    // finds no drawings), so reflect the uploader's current phase on these fresh controls rather
    // than showing it idle.
    this._setUploadPhase(this.uploader.phase);
  }

  /** Reflect `ImportUploader`'s phase on the upload step's controls (IMPORT-30). While a run is in
   *  flight the controls that would race it are disabled (see `_stepUpload`); while a **scan** is in
   *  flight the queue is sealed too, so the drop zone stops accepting selections and says so
   *  (IMPORT-47 — and since IMPORT-65 a scan is the only thing that seals it, an upload run having
   *  no scan of its own any more). `ImportUploader._submit` refuses a sealed selection regardless,
   *  so this is the visible half of that guard, not the enforcement. It returns early once the step
   *  is off screen (`_stage` clears the refs it writes), so it can be called from anywhere in the
   *  wizard without reaching into a step that has been replaced.
   *
   *  Continue answers to **three** gates and is recomputed here as their conjunction (see
   *  `continueGate`, which holds the decision itself): there must be something on the server to
   *  continue with (IMPORT-32), no upload run in flight to race, and no scan in flight to fire a
   *  second of (IMPORT-47). This is the single place that state is written, so the rules can't
   *  fight over the button. */
  _setUploadPhase(phase) {
    // Not on screen — `_stage` cleared every ref below, so there is nothing to reflect onto.
    const drop = this._dropZone;
    if (!drop) return;
    // A scan in flight is what **seals** the step (IMPORT-47) — `ImportUploader.sealed` reads the
    // same condition. Both halves matter: a selection accepted now starts a run the scan would
    // navigate away from mid-upload, and a nav-away strands a scan that later yanks the operator
    // forward out of whatever step they left for — the unexplained auto-advance that guard is about.
    // An upload *run* seals nothing on its own: it scans nothing and ends back on this step
    // (IMPORT-65), so it only disables the controls that would race it.
    const scanning = this.scanBusy;
    const busy = ImportFlow.busyGate({ phase, scanBusy: scanning }).busy;
    const gate = ImportFlow.continueGate({
      phase, hasContent: this._uploadHasContent, scanBusy: scanning,
      scanWaiting: this._scanWaiting, label: this._continueLabel,
    });
    this._continueBtn.disabled = gate.disabled;
    this._continueBtn.textContent = gate.label;
    // Both nav-aways off this step, disabled together: the step's own back/cancel (null in the edit
    // flow, which offers none) and whatever the chrome above the title offers — the fresh flow's
    // stepper, which used to walk the operator off a live run (IMPORT-55).
    if (this._uploadBack) this._uploadBack.disabled = busy;
    this._setChromeBusy(busy);
    this._zipLink.disabled = scanning;
    drop.classList.toggle('imp-drop-busy', scanning);
    const label = drop.querySelector('.imp-drop-big');
    // The sealed drop zone names what it is waiting on; otherwise it goes back to inviting a
    // selection — including right after a run, which now ends here rather than navigating away.
    if (label) label.textContent = scanning ? 'Scanning your drawings…' : this._dropLabel;
  }

  /** The upload step's Continue gate as a pure decision: `{disabled, label}` from the three rules
   *  that own the button. Extracted from `_setUploadPhase` (still the only *writer*) so the
   *  conjunction the §10 invariant is about can be exercised directly rather than inferred from a
   *  rendered step:
   *
   *  - `hasContent` (IMPORT-32) — nothing on the server means nothing to continue with. This is
   *    the only rule that reads as a plain "not yet", so it keeps the button's own label.
   *  - `phase` (IMPORT-30) — an upload run in flight; Continue would fire a scan racing it. The
   *    step's progress line already narrates the upload, so the label is left alone here too. The
   *    moment the run ends this rule clears and the button goes live *on the step* — since
   *    IMPORT-65 that is the only way onward, so this gate is what the operator is waiting on.
   *  - `scanBusy`/`scanWaiting` (IMPORT-47) — a scan in flight. This one *is* relabelled: the
   *    click that started it navigates nowhere for as long as the scan takes, and a dead button
   *    with no explanation is what made the old double-click look broken. `scanWaiting` narrows
   *    it further, to the case where the server is busy with someone else's import entirely. */
  static continueGate({ phase, hasContent, scanBusy, scanWaiting, label }) {
    if (scanBusy) {
      return { disabled: true,
        label: scanWaiting ? 'Waiting for the running import…' : 'Scanning your drawings…' };
    }
    return { disabled: phase !== 'idle' || !hasContent, label };
  }

  /** Whether an upload run or a scan is in flight, and how to say so — the one decision behind every
   *  "not while this is running" refusal the upload step makes, and the reason its controls can't
   *  drift apart from each other. Pure, beside `continueGate`, so it can be exercised directly
   *  rather than inferred from a rendered step.
   *
   *  It returns the wording rather than a bare boolean because the run and the scan are different
   *  things to be waiting on, and a refusal that names the wrong one reads as a bug. The phase is
   *  checked first so a run narrates as an upload everywhere; since IMPORT-65 the two can no longer
   *  overlap in practice (a run scans nothing, and a scan seals the step against starting one), so
   *  that precedence is defence against an unreachable pairing rather than, as it once was, the
   *  everyday description of a run finishing in its own scan.
   *
   *  Four callers, one rule: `_setUploadPhase` disables the step's nav-aways (its back/cancel and
   *  the chrome's stepper), `FreshImportFlow._goToStep` refuses the jump those controls would make
   *  anyway (the enforcement behind them, IMPORT-55), `navRefusal` refuses to leave the wizard at
   *  all (the crumb trail, browser Back, the gear, the picker — IMPORT-61), and `_reset` refuses to
   *  wipe the working dir out from under the run. */
  static busyGate({ phase, scanBusy }) {
    if (phase !== 'idle') return { busy: true, message: 'An upload is still in progress' };
    if (scanBusy) return { busy: true, message: 'Your drawings are still being scanned' };
    return { busy: false, message: '' };
  }

  /** The "already uploaded" card shown above the drop zone when the working dir already holds
   *  drawings from a prior visit to this step (IMPORT-16): folder names + per-folder drawing
   *  counts, so stepping back from a later step reads as "here's what you have", not "start over".
   *  Reads straight from the last scan (`folders`, i.e. `this.inv.folders`) rather than the
   *  editable `this.buildings` model — it only needs to say what's on disk, not how it's assigned. */
  _uploadSummary(folders) {
    const total = folders.reduce((n, f) => n + f.pdfs.length, 0);
    const rows = folders.map(f => Dom.el('li', { class: 'imp-upload-summary-row' }, [
      Dom.el('span', {}, ImportFlow.prettyName(f.folder)),
      Dom.el('span', { class: 'hint' },
        f.pdfs.length + ' drawing' + (f.pdfs.length === 1 ? '' : 's')),
    ]));
    return Dom.el('section', { class: 'imp-bind imp-upload-summary' }, [
      Dom.el('div', { class: 'imp-bind-head' }, [
        Dom.el('div', { class: 'imp-bind-folder' },
          total + ' drawing' + (total === 1 ? '' : 's') + ' already uploaded'),
      ]),
      Dom.el('ul', { class: 'imp-upload-summary-list' }, rows),
    ]);
  }

  /** Route an ingested `{ items, bim }` selection: upload the importable drawings, or — when there
   *  are none but the selection carried 3D BIM/Revit files — show export guidance instead of the
   *  bare "no drawings found" toast `upload` would otherwise raise. */
  _ingest({ items, bim }) {
    if (!items.length && bim.length) return this._showBimGuidance();
    this.uploader.upload(items);
  }

  /** Replace the silent drop of a 3D BIM/Revit model (IFC/RVT) with actionable guidance: the
   *  wizard imports 2D per-floor plans only, so the user should export each floor to a PDF/image
   *  and import those. UX only — these formats are never decoded (see `ImportUploader.BIM_EXTS`). */
  _showBimGuidance() {
    const note = this._uploadNote;
    if (!note) return;
    note.innerHTML = '';
    note.classList.remove('hidden');
    note.append(
      Dom.el('div', { class: 'imp-bim-head' }, '3D BIM / Revit files can’t be imported'),
      Dom.el('p', {}, 'The wizard imports 2D floor plans — a PDF or image per floor. IFC and Revit '
        + '(RVT) files are 3D building models, not per-floor pages.'),
      Dom.el('p', {}, 'In your BIM/CAD tool (Revit included), export each floor to a PDF or image, '
        + 'then import those here. RVT has no open reader, so export to PDF or IFC from Revit first.'));
  }

  // ---- step 2: map ----
  async _scanAndMap() {
    try {
      const inv = await this.scan();
      if (!inv.ok) throw new Error(inv.error || 'scan failed');
      this.inv = inv;
    } catch (e) { Toast.show('Scan failed: ' + e.message, true); return; }
    if (!this.inv.folders.length) { Toast.show('No drawings uploaded yet', true); return this._stepUpload(); }
    this._modelFromInventory();
    // Re-apply any saved draft so stepping **back** to the upload step and forward again (or
    // dropping more files here) doesn't discard assignments/bindings already made — the model is
    // rebuilt from defaults above, and the draft is the source of truth (mirrors `_mergeUploads`).
    // A no-op on a genuine first import, which has written no draft yet.
    await this._applyDraft();
    this._bIdx = 0;
    this._autoMapDone = false;
    this._stepBuildings();
  }

  /** Add more drawing folders/PDFs to an in-progress or already-built facility without
   *  resetting. Persists the current assignments as a draft first, then routes through the
   *  normal upload step in "merge" mode so the re-scan re-applies that draft — existing drawings
   *  keep their floors and only the newly added ones arrive unassigned. */
  async _addDrawings() {
    // A merge re-scans and rebuilds `this.buildings`, so a sweep still applying reads to the
    // current model would be writing into objects about to be replaced — and racing the draft the
    // merge re-applies (IMPORT-53). Stopped, not suppressed: the new drawings want reading too.
    this.ocr.cancel({ suppress: false });
    await this._saveDraft();
    this._mergeMode = true;
    this._stepUpload();
  }

  /** Finish an add-drawings upload: re-scan, rebuild the model, and re-apply the saved draft so
   *  prior assignments survive (unlike `_scanAndMap`, which starts fresh). New folders surface
   *  unbound in the binding step, which auto-skips back to the map once everything is bound. */
  async _mergeUploads() {
    try {
      const inv = await this.scan();
      if (!inv.ok) throw new Error(inv.error || 'scan failed');
      this.inv = inv;
    } catch (e) { Toast.show('Scan failed: ' + e.message, true); return; }
    this._mergeMode = false;
    if (!this.inv.folders.length) return this._stepMap();
    this._modelFromInventory();
    await this._applyDraft();
    // Re-run the building→NetBox auto-match so a newly added, still-unbound building gets a
    // suggested site (already-bound buildings are skipped, so confirmed bindings are untouched).
    this._autoMapDone = false;
    this._stepBuildings();
  }

  /** Explode a scanned drawing into per-mappable-page rows. A multi-page PDF (`pages > 1`) becomes
   *  one row per page, each keyed by a compound `stem#pN` stem (1-based, matching the backend's
   *  `_page_entries`) so every stem-keyed structure downstream (`assign`, `frame`, `_resolveFloors`,
   *  the build map) treats a page exactly like a standalone drawing. Page rows carry no scan
   *  thumbnail — their card image is the on-demand per-page `preview` render (`p.page` threads into
   *  `previewUrl`). A single-page drawing (any raster/SVG/Visio, or a 1-page PDF) is returned
   *  unchanged, keeping its bare stem and scan thumbnail. */
  static _explodePages(p) {
    const n = p.pages || 1;
    if (n <= 1) return [p];
    // `sizes`/`unit` ride along whole (the row's own `page` indexes them, see
    // `ImportRegions.pageGeom`), so a page row reports its own sheet geometry — pages of one PDF
    // are not required to be the same size.
    return Array.from({ length: n }, (_, i) => ({
      file: p.file, pdf: p.pdf, stem: p.stem + '#p' + (i + 1), page: i + 1, thumb: null,
      sizes: p.sizes, unit: p.unit,
    }));
  }

  /** Build the editable model with sensible defaults: a folder that looks like a site
   *  plan supplies the siteplan PDF and contributes no floors; every other folder is a
   *  building whose PDFs default to Level 1..N (the user adjusts basements/ground/roof).
   *  A multi-page PDF is exploded into one row per page (`_explodePages`) so each page maps to
   *  its own floor. */
  _modelFromInventory() {
    this.buildings = [];
    this.site = { folder: '', file: '' };
    for (const f of this.inv.folders) {
      const isSite = /site\s*plan/i.test(f.folder);
      if (isSite && f.pdfs.length && !this.site.file) {
        this.site = { folder: f.folder, file: f.pdfs[0].file };
      }
      const pdfs = f.pdfs.flatMap(ImportFlow._explodePages);
      const name = ImportFlow.prettyName(f.folder);
      this.buildings.push({
        folder: f.folder, pdfs,
        name, slug: ImportFlow.slugify(f.folder), abbr: ImportFlow.initials(name),
        // The NetBox Site this building is bound to, chosen in the "Map buildings to NetBox"
        // step: { id, slug, name, auto } (auto = picked by auto-map, awaiting confirmation).
        // null = unbound. Its slug overwrites `slug` so it flows downstream as `siteSlug` — for a
        // Site anchor this Site *is* the building; for a Location anchor it is the campus Site.
        nbSite: null,
        // The building **Location** this building is anchored to when it lives under a campus Site
        // (Site != building — the Site = campus topology, MODEL-4): { id, slug, name }. null for a
        // Site anchor (today's default). Its slug flows downstream as the manifest `buildingSlug`,
        // and the building's floors are this Location's children (see `_loadFloors`). `nbSite` still
        // holds the campus Site (→ `siteSlug`), so a Location-anchored building has both set.
        nbBuilding: null,
        // NetBox floor Locations for the building's bound site, lazily fetched in the map
        // step so floors can be picked as buttons. undefined = not fetched, 'loading' = in
        // flight, array = done (empty array = fall back to the floor-type buttons).
        // Never persisted: `_saveDraft` strips it (it is re-fetched every load, and a site's whole
        // Location list would bloat every draft write).
        nbFloors: undefined,
        // Why `nbFloors` is what it is (see `_loadFloors`): null = a clean, complete read;
        // 'fetch' | 'site-missing' | 'truncated' otherwise. Read by `ImportCards._floorButtons` so a
        // broken binding or a clipped list can't masquerade as "this site has no floors". Transient
        // like `nbFloors`, and stripped from the draft with it.
        nbFloorsError: null,
        // Per-PDF floor assignment. `token` (a NetBox Location slug) takes precedence over
        // `type`/`num`; when set, the build emits the slug verbatim as the floor id (see
        // `_resolveFloors`/`_build`).
        // A drawing whose filename spells its floor takes that (flagged `suggested`, so the card
        // presents it as a pre-fill to confirm — IMPORT-28); the rest keep the blind Level 1..N
        // default. In Location mode `_normalizeToLocations` clears both back to `unassigned` and
        // `ImportBulk.suggestFloors` re-derives against the real Locations, so the guess is made
        // once here for the floor-type fallback and once there for Location mode.
        assign: Object.fromEntries(pdfs.map((p, i) =>
          [p.stem, isSite ? { type: 'none', num: 1, token: null, label: '' }
            : ImportFlow._defaultAssign(p, i)])),
        // Per-card thumbnail framing (zoom/pan) — a viewing aid only, never sent to build.
        frame: Object.fromEntries(pdfs.map(p => [p.stem, { scale: 1, x: 0, y: 0 }])),
        // Per-card straightening rotation ({deg} clockwise, 0 = as-is). Unlike `frame`, this IS
        // sent to build (`_build` → import-map `angles`) so a scanned-rotated drawing renders
        // upright. Mutated in place by `ImportPreview.rotateControls`; merged in `_applyDraft`.
        angle: Object.fromEntries(pdfs.map(p => [p.stem, { deg: 0 }])),
        // Optional per-building override of the global code-crop region (`_codeRegion`), for a
        // building whose title block sits in a different spot. null = use the global region.
        codeRegion: null,
        // Per-drawing region-split (FLOOR-4): a list of `{ box:{x,y,w,h}, assign }` boxes drawn
        // over one plan, each assigned its own floor, so a single page fans into several floors.
        // Empty (the default) = whole-page/scalar mode, so `_resolveFloors` emits the legacy
        // scalar token; a non-empty list emits the `[{token, region}]` shape (FLOOR-2). Each
        // entry's `assign` mirrors the scalar `assign` shape so `_floorButtons` is reused as-is.
        // The box is stored normalized 0..1 in *straightened-image* space (the split editor renders
        // the drawing at its `angle`, matching the backend's crop-after-rotate).
        regions: Object.fromEntries(pdfs.map(p => [p.stem, []])),
        // Per-drawing overlay control points (FMT-6): `[{src:[sx,sy], dst:[nx,ny]}, …]` pairs
        // tying a GIS overlay's raw source coordinates to spots on its floor's 0..1 canvas,
        // captured in the align editor (`ImportAlign.open`). Only OVERLAY-role drawings use
        // theirs; `_build` emits ≥2 pairs as the import-map `overlayAlign`, which georeferences
        // the layer at the next build. Empty (the default) = fit-to-bounds, as before.
        align: Object.fromEntries(pdfs.map(p => [p.stem, []])),
      });
    }
  }

  // ---- step 1.5: bind buildings to NetBox sites ----

  /** Building folders that contribute floors — siteplan-only folders need no NetBox site
   *  (they have no floors and are skipped by the build, see `_build`). */
  _floorBuildings() {
    return this.buildings.filter(b => Object.keys(this._resolveFloors(b)).length > 0);
  }

  /** Buildings shown in the floor-mapping carousel: those with at least one drawing that
   *  still needs (or has) a floor — i.e. a non-`none` drawing. Excludes the dedicated
   *  `Site Plan` folder and any building reduced to all site-plan/`none` drawings, so the
   *  chosen site plan is never presented as a card asking for a floor. Unlike
   *  `_floorBuildings`, this keeps a Location-mode building whose drawings are still
   *  `unassigned` (no resolved floor yet) visible so the user can assign one. `_bIdx`
   *  indexes this filtered list. */
  _mappableBuildings() {
    return this.buildings.filter(b => b.pdfs.some(p => b.assign[p.stem].type !== 'none'));
  }

  /** True once every floor-contributing building is bound to a NetBox site — **bound**, which counts
   *  an unconfirmed auto-match (`nbSite.auto`) as bound. Deliberately unchanged by IMPORT-57: three
   *  of its four callers need exactly this looser question. `FreshImportFlow._resume` uses it to
   *  decide whether a restored draft still owes the Buildings step an *anchor*, and both edit-flow
   *  **Auto-match buildings** buttons (`EditImportFlow._buildingsActions`/`_stepHub`) are offered
   *  while anything is *unbound* — auto-match only ever fills unbound rows, so tightening this would
   *  offer a button that could do nothing. The fourth caller, the fresh Buildings step's Continue,
   *  asks `_allBuildingsConfirmed()` **as well**. */
  _allBuildingsBound() {
    return this._floorBuildings().every(b => b.nbSite);
  }

  /** True once every floor-contributing building carries a **confirmed** anchor — bound, and not
   *  still flagged as the wizard's own guess (IMPORT-57). A second predicate rather than a
   *  tightening of `_allBuildingsBound()`, whose other callers ask a genuinely different question.
   *
   *  This is the bar the fresh Buildings step's Continue now shares with
   *  `ImportOrganize.groupedNeedsAttention`, and the two used to disagree: the grouped screen
   *  refused to auto-skip while any anchor was an unconfirmed guess, then — once it did render —
   *  waved those same guesses through Continue, because the gate only asked `_allBuildingsBound()`.
   *  Re-anchoring changes every `Room.floor_key` beneath a building (§10 foundations), so the review
   *  the row's "Confirm or change" asks for is the last one before those keys are committed.
   *
   *  The two predicates agree on the **binding axis only**. `groupedNeedsAttention` stays
   *  deliberately broader — it also stops on a pending/foreign facility verdict and on `_bindRow`'s
   *  campus-mode Site-anchor advisory. Neither belongs in this gate: the facility lock is optional,
   *  and nothing new is gated on the organization mode (MODEL-7). "Worth rendering the screen" is a
   *  lower bar than "must not proceed"; only the binding axis was ever inconsistent between them. */
  _allBuildingsConfirmed() {
    return ImportFlow.allAnchorsConfirmed(this._floorBuildings());
  }

  /** Whether every building in `buildings` carries a confirmed anchor — the bar `_allBuildingsConfirmed`
   *  applies to `_floorBuildings()`, lifted out pure and static (like `anchorFromRow`,
   *  `ImportBind.facilityRowState`, `ImportOrganize.groupedNeedsAttention`) so the unit tier can pin
   *  it against the auto-skip predicate it is supposed to agree with. */
  static allAnchorsConfirmed(buildings) {
    return buildings.every(b => b.nbSite && !b.nbSite.auto);
  }

  /** The NetBox anchor one candidate row stands for, in the shape `_bindSite`/`_bindBuilding` take —
   *  or null when the row is not a NetBox object at all (a hand-typed building name, an upload
   *  folder). The bridge from a picker row to a binding, used to carry an organize-step pick into
   *  the bind step (IMPORT-25).
   *
   *  **The row's own shape decides the anchor kind, never the ambient organization mode**: a
   *  building Location carries its campus `site_slug`/`site_name` (`serializers._trim_building_
   *  location`) and a Site does not (`_trim_site`). Keying off the row means a pick binds as the
   *  kind it was *made* as even if the mode is flipped between the two steps — the mode steers what
   *  a step offers, never what an answer already given meant (MODEL-7). */
  static anchorFromRow(row) {
    if (!row || !row.slug) return null;
    const id = row.id == null ? null : row.id;
    const name = row.name || row.slug;
    // A Location anchor's `site` is the campus, whose own id is not in this row (only its
    // slug/name) — the same null-id campus record `_bindRow`'s Location branch builds.
    if (row.site_slug)
      return {
        kind: 'building',
        site: { id: null, slug: row.site_slug, name: row.site_name || row.site_slug },
        building: { id, slug: row.slug, name },
      };
    return { kind: 'site', site: { id, slug: row.slug, name } };
  }

  /** The NetBox anchor a building resolves to, as one comparable string: the site slug for a Site
   *  anchor, `siteSlug/buildingSlug` for a Location anchor (MODEL-4). `''` for a building with no
   *  slug yet — the callers' own empty-slug guards own that case.
   *
   *  **This, not the site slug, is the identity that must be unique** across floor-contributing
   *  buildings. Under `site-as-campus` (which the `location` grouping forces server-side) every
   *  building binds beneath one campus Site, so `_bindBuilding` gives them all the *same* `b.slug`
   *  and they are told apart by their building Location alone. A slug-level uniqueness test
   *  therefore rejects a perfectly good campus import wholesale (IMPORT-28) — it is the anchor that
   *  collides or doesn't. Both the boundary guard (`_buildMap`) and the inline warning
   *  (`ImportCards._buildingFieldError`) key off this one helper so the two can never drift. */
  static anchorKey(b) {
    const s = (b.slug || '').trim();
    if (!s) return '';
    return b.nbBuilding ? s + '/' + b.nbBuilding.slug : s;
  }

  /** Bind a building to a NetBox **Site** anchor (the Site *is* the building): store its identity
   *  and prefill name/slug/abbr from it so the slug flows downstream as the manifest `siteSlug`.
   *  Clears any prior Location anchor (`nbBuilding`), so re-binding a building to a Site drops its
   *  `buildingSlug` and its floor keys revert to the 2-segment shape. `auto` flags an unconfirmed
   *  auto-match (the operator reviews it in the step). */
  _bindSite(b, site, auto) {
    b.nbSite = { id: site.id, slug: site.slug, name: site.name, auto: !!auto };
    b.nbBuilding = null;
    b.nbFloors = undefined;   // re-fetch floors for the new anchor
    b.nbFloorsError = null;   // a new anchor's load answers for itself; drop the old verdict
    b.slug = site.slug;
    b.name = site.name;
    b.abbr = ImportFlow.initials(site.name);
  }

  /** Bind a building to a **Location** anchor (Site = campus, the building is a `dcim.Location`
   *  beneath the campus Site, MODEL-4). `site` is the campus (→ `nbSite`, its slug is the manifest
   *  `siteSlug`); `building` is the building Location (→ `nbBuilding`, its slug is the
   *  `buildingSlug`). Name/abbr prefill from the **building** (that's the actual building), while the
   *  downstream `siteSlug` (`b.slug`) stays the campus Site's, keeping `floor_key`'s first segment a
   *  pure site slug (MULTI-2 scoping). `auto` flags an unconfirmed auto-match. */
  _bindBuilding(b, site, building, auto) {
    b.nbSite = { id: site.id, slug: site.slug, name: site.name, auto: !!auto };
    b.nbBuilding = { id: building.id, slug: building.slug, name: building.name };
    b.nbFloors = undefined;   // re-fetch floors (this anchor's are the building Location's children)
    b.nbFloorsError = null;   // a new anchor's load answers for itself; drop the old verdict
    b.slug = site.slug;
    b.name = building.name;
    b.abbr = ImportFlow.initials(building.name);
  }

  /** Accept the anchor a building already has, clearing the unconfirmed-guess flag (IMPORT-57) — the
   *  **Confirm** half of the "Confirm or change" the auto-matched row has always claimed to offer,
   *  where *change* was the row's search box and *confirm* was nothing at all.
   *
   *  Its own method rather than a re-run of `_bindSite`/`_bindBuilding` with `auto = false`, because
   *  **confirming does not move the anchor** and must not run the code path whose job is moving one.
   *  Both binders re-derive `name`/`abbr` from the anchor and clear `nbFloors`; re-binding an
   *  *identical* anchor would therefore revert a building the operator renamed on the map step and,
   *  from the bulk confirm, fire one needless Location-tree refetch per building. The anchor itself
   *  still only ever moves through those two (and `_reanchorBuilding`), so the §10 rule that
   *  re-anchoring — which re-keys every `Room.floor_key` beneath the building — stays an explicit
   *  operator action is untouched: this writes only the review flag, and only on the flow, never
   *  from the screen that renders the button. */
  _confirmAnchor(b) {
    if (!b.nbSite) return;
    b.nbSite.auto = false;
  }

  /** Move a building's **Location anchor** down the Location tree to one of its own children
   *  (MULTI-5) — the fix for a facility modelled campus → building → **wing** → floor, where the
   *  floors are the wing's children, not the anchored building's.
   *
   *  The floor key's middle segment must be the floor's *direct parent* (see
   *  `_floorsFromLocations`), so the supported answer for a deeper tree is to anchor on the wing:
   *  that produces the ordinary 3-segment `site/wing/floor` key every backend resolver already
   *  handles, with no format change. Post-conditions mirror `_bindBuilding` — same anchor identity,
   *  same name/abbr prefill from the anchored Location, and `b.slug` (the campus Site slug, the
   *  manifest `siteSlug`) deliberately untouched. Clearing `nbFloors` re-runs `_loadFloors`, whose
   *  `_dropUnanchoredTokens` pass then resets any assignment the new anchor can't hold. */
  async _reanchorBuilding(b, loc) {
    if (!b.nbSite) return;
    b.nbBuilding = { id: loc.id, slug: loc.slug, name: loc.name };
    b.nbFloors = undefined;
    b.nbFloorsError = null;
    b.name = loc.name;
    b.abbr = ImportFlow.initials(loc.name);
    await this._saveDraft();
    this._rerenderBuildingSection(b);   // re-render in place, preserving scroll (IMPORT-2)
    this._ensureFloors(b);
  }

  /** The anchor's direct child Locations — the candidates `_anchorDrillControl` offers to re-anchor
   *  onto. Read from the `_siteLocs` tree cache, so it is empty until this building's floors have
   *  loaded once (the control simply doesn't render then). */
  _anchorChildren(b) {
    const locs = (b.nbBuilding && this._siteLocs.get((b.slug || '').trim())) || [];
    return locs.filter(l => l.parent === b.nbBuilding.id)
      .sort((x, y) => (x.name || '').localeCompare(y.name || '', undefined, { numeric: true }));
  }

  /** Structural "the anchored Location's children look like wings/zones, not floors" signal: some
   *  **grandchild** of the anchor has children of its own.
   *
   *  A normal building → floor → room tree is two levels deep below the anchor and can never trip
   *  this; a building → wing → floor → room tree is three and always does. It is used **only** to
   *  decide whether to shout — the drill control is offered either way, because a wing whose floors
   *  have no room Locations yet is two levels deep and structurally indistinguishable from a
   *  building. Never used to change *what* is offered: which descendants are floors stays an
   *  explicit operator pick (MULTI-5). */
  _isWingLikeAnchor(b) {
    const locs = (b.nbBuilding && this._siteLocs.get((b.slug || '').trim())) || [];
    if (!locs.length) return false;
    const parents = new Set(locs.map(l => l.parent));
    const childIds = new Set(locs.filter(l => l.parent === b.nbBuilding.id).map(l => l.id));
    return locs.some(l => childIds.has(l.parent) && parents.has(l.id));
  }

  /** One-line summary of a building's current anchor, for the bind-state UI (shared by the bind
   *  step and the edit hub). A Site anchor reads "Name (slug)"; a Location anchor reads
   *  "Building (slug) in Campus" so the operator sees both the building and its campus. */
  _anchorSummary(b) {
    if (b.nbBuilding)
      return b.nbBuilding.name + ' (' + b.nbBuilding.slug + ') in ' + b.nbSite.name;
    return b.nbSite ? b.nbSite.name + ' (' + b.nbSite.slug + ')' : '';
  }

  /** Bind every floor-contributing building to a NetBox anchor (MULTI-6) — a thin delegator, kept
   *  on the base because shared code drives it directly (`_scanAndMap`, `_mergeUploads`, both
   *  `_resume()`s, the campus step's return, the edit hub's per-building "Edit binding"/"Bind to
   *  NetBox" rows, and every re-render inside the hosted controls). The base routes to the edit hub's
   *  per-building bind screen (`ImportBind.step`); `FreshImportFlow` overrides it to the merged
   *  Buildings step (`ImportOrganize.step`, IMPORT-34) — the flows' one step-level divergence, kept a
   *  subclass hook per §10. `focusBuilding` scrolls that building's row/group into view. */
  _stepBuildings(focusBuilding) {
    return this.binder.step(focusBuilding);
  }

  // ---- the box editors (ImportRegions) + overlay align (ImportAlign) ----

  /** Enter the per-building code-region re-mark, a detour off the map step. A thin delegator, kept
   *  on the base because both flows drive it directly — the map step's per-building button and the
   *  edit hub's per-building row — so it stays part of the flow's vocabulary even though
   *  `ImportRegions` owns the editor itself. The **global** pick is a section of the Site plan step
   *  (`ImportRegions.codeSection`), not a screen of its own (IMPORT-37). */
  _stepRegionPick(building) {
    this.regions.openPick(building);
  }

  /** The map step **always renders the map** (IMPORT-37). It used to open with two hidden gates —
   *  unset `_siteplanDone`/`_codeRegionDone` bounced the caller into the preparatory steps — which
   *  meant any jump here (the stepper's own *Map & build*, the edit hub's "Review & build →", a
   *  per-building "Edit floors →") could silently land somewhere else. Where those steps sit in the
   *  walk is the walk's business: `FreshImportFlow` sequences them through `STEPS`/`_goToStep`, and
   *  routes into them from `_afterBuildings`/`_resume`. */
  _stepMap() {
    const view = this._stage('Map drawings to floors', 'map');
    this._mapView = view;
    this._cards = [];   // {upgrade()} per card — lets the size slider swap in hi-res renders
    // Captured so a floor edit can patch just the touched node in place, rather than re-running
    // `_stepMap()` (which wipes `#stage` and resets the page scroll — IMPORT-2). Cleared here so a
    // siteplan-only render, or one before the section is appended, leaves no stale reference.
    this._buildingSectionEl = null;
    // The carousel nav bars, so the background OCR sweep can refresh their per-building counts in
    // place as reads land (`_refreshBuildingNavs`) — the `_buildActionsRow` idiom (IMPORT-53).
    this._navRows = [];
    view.append(Dom.el('p', { class: 'hint' }, 'Assign every drawing to a floor.'));

    // Step-wide context + the one view preference share a single compact row (IMPORT-50). The
    // floor-label pick — a build-time setting, not a mapping action — rides the build row instead
    // (`_buildActions`).
    view.append(Dom.el('div', { class: 'imp-maptools' },
      [this._siteplanSummary(), this._sizer()]));
    // The background floor-code sweep's own strip, directly under the step's context row: it
    // reports on the whole facility, not on the building in view, and it is the only place a
    // running sweep can be stopped (IMPORT-53). Hidden while idle.
    view.append(this.ocr.statusEl());
    // Why nothing is being read, when the install could read but nothing is marked (IMPORT-63).
    // `ImportOcrSweep.autoStart` declines silently by design, so without this the operator's only
    // evidence of the feature is its absence.
    const idle = this._ocrIdleNotice();
    if (idle) view.append(idle);
    this._applyThumbSize();

    // The carousel pages over floor-mapping buildings only (`_mappableBuildings`), so the
    // chosen site plan / a `Site Plan` folder is never shown as a card asking for a floor.
    // A siteplan-only import has none — the step is just the summary + build actions.
    const buildings = this._mappableBuildings();
    if (buildings.length) {
      this._bIdx = Math.max(0, Math.min(this._bIdx, buildings.length - 1));
      // The whole-facility view (IMPORT-63), above the carousel it is the alternative to: progress,
      // a name search, a status filter, and the sweep's coverage across every building. Null for a
      // handful of buildings, where the nav bar already answers everything it would.
      const overview = this.overview.section();
      if (overview) view.append(overview);
      if (buildings.length > 1) view.append(this._addBuildingNav(buildings));
      const b = buildings[this._bIdx];
      this._ensureFloors(b);   // kick off the NetBox Location fetch for this building (cached)
      this._buildingSectionEl = this.cards.section(b);
      view.append(this._buildingSectionEl);
      this._applyThumbSize();   // re-apply now cards exist, so a large size upgrades them to hi-res

      // A second nav at the bottom so the user isn't forced back to the top after assigning a
      // building's drawings. Re-rendering rebuilds both bars each switch, keeping them in sync.
      if (buildings.length > 1) view.append(this._addBuildingNav(buildings));
    }

    this._buildActionsRow = this._buildActions();
    view.append(this._buildActionsRow);

    // Read the facility's floor codes in the background, if there is a region to read them
    // through and anything left to read (IMPORT-53). Declines silently otherwise — this is the
    // automatic path, and it must never be the reason arriving at this step says something.
    this.ocr.autoStart();
  }

  /** One `_buildingNav` bar, remembered so `_refreshBuildingNavs` can swap it in place. */
  _addBuildingNav(buildings) {
    const nav = this._buildingNav(buildings);
    this._navRows.push(nav);
    return nav;
  }

  /** Rebuild the carousel nav bars in place, for a change that alters what their per-building
   *  labels say without touching the visible building's cards — a background OCR batch landing on
   *  some other building (IMPORT-53). Skips a bar that has left the DOM (an earlier render's), and
   *  is a no-op before the map step has drawn any. */
  _refreshBuildingNavs() {
    if (!this._navRows || !this._navRows.length) return;
    const buildings = this._mappableBuildings();
    this._navRows = this._navRows.map(old => {
      if (!old.isConnected) return old;
      const fresh = this._buildingNav(buildings);
      old.replaceWith(fresh);
      return fresh;
    });
  }

  /** Swap in a fresh build-action row in place, preserving page scroll. Assigning the last
   *  unassigned drawing opens the build gate, so a floor edit must refresh this row without the
   *  full-stage `_stepMap()` re-render (IMPORT-2). No-op before the map step has rendered it. */
  _refreshBuildActions() {
    if (!this._buildActionsRow) return;
    const fresh = this._buildActions();
    this._buildActionsRow.replaceWith(fresh);
    this._buildActionsRow = fresh;
  }

  /** Scroll-preserving re-render of just the visible building's section (card grid + header),
   *  for a floor edit that touches the whole building — a bulk action (`ImportBulk._apply`) and
   *  `_addFloor` (mutates the shared `nbFloors`, so every sibling card's floor
   *  row must refresh). Swapping only the section leaves the header/summary/nav — and the page
   *  scroll — intact, unlike a full `_stepMap()` (IMPORT-2). `this._cards` is reset since the
   *  rebuilt section re-pushes every current card's hi-res upgrader; `_applyThumbSize` then
   *  re-applies the size / hi-res state and `_refreshBuildActions` re-evaluates the gate. Falls
   *  back to a full render if the section hasn't been captured (defensive — the callers only
   *  fire from within the map step). */
  _rerenderBuildingSection(b) {
    if (!this._buildingSectionEl) return this._stepMap();
    this._cards = [];
    const fresh = this.cards.section(b);
    this._buildingSectionEl.replaceWith(fresh);
    this._buildingSectionEl = fresh;
    this._applyThumbSize();
    this._refreshBuildActions();
  }

  /** The Build / Add-drawings / Start-over action row. Build is gated until every drawing is
   *  assigned to a floor (no building left with an `unassigned` drawing); while gated it shows a
   *  disabled button + a hint naming what's missing, so the button never silently vanishes. The
   *  siteplan is optional (IMPORT-8) — a facility with no overall site plan (a single building, or a
   *  site with no campus map) builds fine with `site.file` unset, so it is NOT part of the gate.
   *  "Add drawings" (additive upload) and "Start over" stay available regardless. The label tracks
   *  whether this is a fresh import or a re-edit: a facility already in the store (`hasContent()`,
   *  the live store-state that also picks EditImportFlow in `App.showImport`) means the action
   *  regenerates an existing map, so the button reads **Rebuild map** rather than the from-scratch
   *  **Build facility map** — the rebuild itself is identical either way. */
  _buildActions() {
    const unassigned = this._unassignedBuildings();
    const label = this.app.store.hasContent() ? 'Rebuild map' : 'Build facility map';
    // Linear back to the site-plan step (fresh only; null in edit → dropped by `Dom.el`).
    const actions = [this._backButton('map')];
    if (unassigned.length) {
      const blocked = Dom.el('button', { class: 'primary' }, label);
      blocked.disabled = true;
      actions.push(blocked);
      // Name the offending buildings when there are few, each one clickable straight into the
      // carousel; a long list is just noise, so past a handful collapse it to a count instead.
      actions.push(unassigned.length <= 5
        ? this._unassignedHint(unassigned) : Dom.el('span', { class: 'hint' },
          unassigned.length + ' buildings have unassigned drawings.'));
    } else {
      actions.push(Dom.el('button', { class: 'primary', onclick: () => this._build() }, label));
      // Filename-suggested floors pass the gate (they're real assignments), so the only thing
      // standing between a bad guess and a built map is the operator noticing it. Say how many are
      // still unconfirmed right where they're about to press Build (IMPORT-28).
      const n = this._suggestedCount();
      if (n) {
        // A faint read that still resolved is the one suggestion most likely to be wrong, so its
        // count rides the same sentence rather than a second line (IMPORT-53).
        const low = this._mappableBuildings()
          .reduce((t, b) => t + this._lowConfidenceCount(b), 0);
        actions.push(Dom.el('span', { class: 'hint' },
          n + (n === 1 ? ' floor was' : ' floors were') + ' suggested from drawing names or floor '
          + 'codes — worth a check before building.'
          + (low ? ' ' + low + ' of them ' + (low === 1 ? 'was' : 'were')
            + ' read with low confidence.' : '')));
      }
      // Floors the sweep committed on the operator's behalf (IMPORT-63). They pass the gate like
      // any other assignment, so — exactly as with the suggestion count above — the count sits
      // where Build is pressed, with the one action that reverses the whole set beside it.
      const auto = this._autoAcceptedTotal();
      if (auto) {
        actions.push(Dom.el('span', { class: 'hint' },
          auto + (auto === 1 ? ' floor was' : ' floors were') + ' set automatically from a '
          + 'confident floor code. They’re marked on their cards.'));
        actions.push(Dom.el('button', {
          title: 'Turn every automatically-set floor back into a suggestion to confirm. The floors '
            + 'themselves are kept.',
          onclick: () => this._undoAutoAccepted() }, 'Undo automatic floors'));
      }
      // A building with no NetBox anchor still builds — its floors just carry a `siteSlug` no Site
      // answers to, so nothing drawn on them can ever bind to a Location. The linear fresh walk
      // can't reach Build in that state (`FreshImportFlow._buildingsActions` gates on
      // `_allBuildingsBound`), but the edit hub jumps straight here, and an unbound building's
      // drawings keep their Level 1..N defaults — never `unassigned` — so the gate above waves them
      // through (IMPORT-29). **Warn, don't block:** a rebuild is the recovery path when a Site is
      // renamed or removed in NetBox, and blocking it would strand the facility.
      const unbound = this._unboundBuildings();
      if (unbound.length)
        actions.push(Dom.el('span', { class: 'imp-floor-warn' },
          '⚠ ' + (unbound.length <= 5
            ? 'Not bound to NetBox: ' + unbound.join(', ') + '.'
            : unbound.length + ' buildings are not bound to NetBox.')
          + ' Their floors will build, but nothing drawn on them can bind to a NetBox location.'
          + ' Use “Edit binding” to bind them first.'));
    }
    // The floor-label pick sits with the action it parameterizes (IMPORT-50): the label string is
    // resolved fresh in `_build()`, so this is a build-time setting, not part of the mapping work.
    actions.push(this._floorLabelFieldControl());
    actions.push(Dom.el('button', { onclick: () => this._addDrawings() }, '+ Add drawings'));
    actions.push(this._startOver());
    return Dom.el('div', { class: 'imp-actions' }, actions);
  }

  /** Jump the carousel straight to building `b`, saving the current draft first — the same
   *  contract `_buildingNav`'s Previous/Next/select follow. Used by the build gate's clickable
   *  unassigned-building names and by "Next needing attention" (IMPORT-40). No-op if `b` has
   *  fallen out of the mappable set (defensive; can't happen for a caller passing a building
   *  drawn from `_unassignedBuildings`/`_mappableBuildings` themselves). */
  async _jumpToBuilding(b) {
    const idx = this._mappableBuildings().indexOf(b);
    if (idx < 0) return;
    await this._saveDraft();
    this._bIdx = idx;
    this._stepMap();
  }

  /** The build gate's "Unassigned drawings in: …" line (`_buildActions`, `unassigned.length <= 5`)
   *  with each building name a jump straight to it in the carousel, so the operator doesn't have
   *  to page around to find what's blocking Build (IMPORT-40). */
  _unassignedHint(unassigned) {
    const hint = Dom.el('span', { class: 'hint' }, 'Unassigned drawings in: ');
    unassigned.forEach((b, i) => {
      hint.append(Dom.el('button', { class: 'imp-link',
        onclick: () => this._jumpToBuilding(b) }, b.name || b.folder));
      hint.append(i < unassigned.length - 1 ? ', ' : '.');
    });
    return hint;
  }

  /** How many drawings across the whole import still carry an unconfirmed filename suggestion
   *  (IMPORT-28) — counted over `_mappableBuildings`, the same population the carousel pages, so the
   *  number matches what the operator can actually page to and check. */
  _suggestedCount() {
    return this._mappableBuildings()
      .reduce((n, b) => n + b.pdfs.filter(p => b.assign[p.stem] && b.assign[p.stem].suggested).length, 0);
  }

  /** Building paging: ← Previous / Next → with a building dropdown that jumps straight to any
   *  building (in place of a "Building N of M" label), plus "Next needing attention →" that skips
   *  straight to the next building still holding an unassigned drawing (IMPORT-40) — on a
   *  many-building import that's a real jump, not just a page-flip. Navigating — via the buttons,
   *  the select, or the attention jump — saves the draft, sets `_bIdx`, and re-renders. `buildings`
   *  is the filtered carousel list (`_mappableBuildings`) that `_bIdx` indexes, so the option
   *  values and bounds exclude the site plan. Factored into a helper so it can be reused. */
  _buildingNav(buildings) {
    const nav = Dom.el('div', { class: 'imp-nav' });
    const prev = Dom.el('button', { onclick: async () => { await this._saveDraft(); this._bIdx--; this._stepMap(); } }, '← Previous');
    const next = Dom.el('button', { onclick: async () => { await this._saveDraft(); this._bIdx++; this._stepMap(); } }, 'Next →');
    prev.disabled = this._bIdx === 0;
    next.disabled = this._bIdx === buildings.length - 1;
    const sel = Dom.el('select', { class: 'imp-nav-select', onchange: async (e) => {
      await this._saveDraft(); this._bIdx = parseInt(e.target.value, 10); this._stepMap();
    } }, buildings.map((b, i) => Dom.el('option', { value: String(i) }, this._buildingNavLabel(b))));
    sel.value = String(this._bIdx);   // mark the current building once the options are attached
    const attnIdx = this._nextNeedingAttention(buildings);
    const attn = Dom.el('button', {
      title: 'Skip to the next building still holding a drawing with no floor, or a floor '
        + 'suggested from a faint code read.' }, 'Next needing attention →');
    attn.addEventListener('click', async () => {
      await this._saveDraft(); this._bIdx = attnIdx; this._stepMap();
    });
    attn.disabled = attnIdx == null;
    // Where in the walk this building sits. The `<select>` replaced the old "Building N of M"
    // label outright, which cost the one number a long carousel most needs (IMPORT-63); the
    // dropdown's own purpose is likewise named rather than left to be discovered by clicking.
    nav.append(prev, Dom.el('span', { class: 'imp-nav-pos' },
      'Building ' + (this._bIdx + 1) + ' of ' + buildings.length), next);
    nav.append(Dom.el('label', { class: 'imp-field' },
      [Dom.el('span', {}, 'Jump to'), sel]), attn);
    return nav;
  }

  /** One `_buildingNav` select option's text: the building's name/folder plus what it still wants
   *  looking at, so the operator can see where to go without opening every card (IMPORT-40) —
   *  "Admin — 3 unassigned, 2 low-confidence" or, once clear, "Library ✓".
   *
   *  A building the background sweep hasn't reached yet says so (IMPORT-53). Without that, a
   *  building queued behind a hundred others is indistinguishable from one OCR read and found
   *  nothing in — and the operator would work through the "clear" ones only to have them fill in
   *  behind them. */
  _buildingNavLabel(b) {
    const name = b.name || b.folder;
    const bits = [];
    const n = this._unassignedCount(b);
    if (n) bits.push(n + ' unassigned');
    const low = this._lowConfidenceCount(b);
    if (low) bits.push(low + ' low-confidence');
    if (this.ocr && this.ocr.isQueued(b)) bits.push('reading…');
    return bits.length ? name + ' — ' + bits.join(', ') : name + ' ✓';
  }

  /** How many of building `b`'s drawings carry an OCR suggestion the reader wasn't confident about
   *  (below `LOW_OCR_CONF`, IMPORT-53). These pass the build gate — they are real assignments — so
   *  they are exactly the outcome a facility-wide sweep produces that nothing else routes back to
   *  the operator. */
  _lowConfidenceCount(b) {
    return b.pdfs.filter(p => {
      const a = b.assign[p.stem];
      return a && a.suggested && a.suggestedFrom === 'ocr'
        && (a.ocrConf || 0) < ImportFlow.LOW_OCR_CONF;
    }).length;
  }

  /** What building `b` still wants the operator's eyes on: a drawing with no floor, or a floor
   *  suggested from a faint read (IMPORT-53). Deliberately **not** the build gate — a low-confidence
   *  suggestion is a real assignment and must not disable Build (that stays `_unassignedBuildings`);
   *  this is the softer "worth a look" the carousel routes by.
   *
   *  An **auto-accepted** floor is deliberately absent (IMPORT-63). Routing every one of them here
   *  would put the whole facility back in the queue and undo the point of accepting them; they are
   *  surfaced instead by their own count, their card badge, and the overview panel's filter, which
   *  is review on request rather than review demanded. */
  _attentionCount(b) {
    return this._unassignedCount(b) + this._lowConfidenceCount(b);
  }

  /** How many of building `b`'s floors the sweep set by itself and nobody has confirmed since
   *  (IMPORT-63) — what the card badge, the overview's filter, and the build row's undo offer all
   *  count. Any operator pick clears the marker (`clearUnanswered`), so this shrinks as the facility
   *  is reviewed rather than standing at whatever the sweep landed. */
  _autoAcceptedCount(b) {
    return b.pdfs.filter(p => {
      const a = b.assign[p.stem];
      return !!a && !!a.autoAccepted;
    }).length;
  }

  /** The same count across the whole floor-mapping carousel. */
  _autoAcceptedTotal() {
    return this._mappableBuildings().reduce((n, b) => n + this._autoAcceptedCount(b), 0);
  }

  /** Turn every auto-accepted floor back into a suggestion awaiting confirmation (IMPORT-63) — the
   *  one action that reverses the whole set, and the reason accepting on the operator's behalf is
   *  defensible at all. It restores exactly the state each drawing would have been in had
   *  auto-accept never run: the same floor, now flagged `suggested` from the same source, so the
   *  card badge, `_suggestedCount` and the build row's "worth a check" line all pick it up. The
   *  match itself is deliberately kept — the read was real, and discarding it would just make the
   *  operator re-derive it. */
  async _undoAutoAccepted() {
    const n = this._autoAcceptedTotal();
    if (!n) return;
    if (!confirm('Turn ' + n + (n === 1 ? ' automatically-set floor' : ' automatically-set floors')
      + ' back into suggestions to confirm? The floors themselves are kept.')) return;
    for (const b of this._mappableBuildings())
      for (const p of b.pdfs) {
        const a = b.assign[p.stem];
        if (!a || !a.autoAccepted) continue;
        delete a.autoAccepted;
        a.suggested = true;
        a.suggestedFrom = a.suggestedFrom || 'ocr';
      }
    await this._saveDraft();
    Toast.show(n + (n === 1 ? ' floor is' : ' floors are') + ' back to suggestions — confirm or '
      + 'change them on their cards.');
    this._stepMap();
  }

  /** Whether the install can read floor codes but has **nowhere to read them** — the `ocr`
   *  capability is present and not one region is marked, globally or per building (IMPORT-63).
   *
   *  This is the state that made the whole feature look broken: `ImportOcrSweep.available()`
   *  declines silently by design (it runs on every render, so a toast per render would be noise),
   *  which left an operator who skipped the Site-plan step's second half with no OCR at all and
   *  nothing on screen saying why. The map step answers it with a visible row rather than silence —
   *  see `_ocrIdleNotice`. */
  _ocrNeedsRegion() {
    const caps = (window.MAP && window.MAP.capabilities) || [];
    if (!caps.includes('ocr')) return false;
    if (this._codeRegion) return false;
    return !this.buildings.some(b => b.codeRegion);
  }

  /** The map step's "OCR is idle, and here is why" row (IMPORT-63) — null unless
   *  `_ocrNeedsRegion()`. Says what isn't happening, why, and offers the one action that fixes it:
   *  the global floor-code region picker, which returns here. */
  _ocrIdleNotice() {
    if (!this._ocrNeedsRegion()) return null;
    return Dom.el('div', { class: 'imp-ocr-idle' }, [
      Dom.el('span', {}, 'Floor codes aren’t being read: no floor-code region is marked, so the '
        + 'reader has nowhere to look. Mark the spot where a drawing says which floor it is and '
        + 'every drawing in the facility is read in the background.'),
      Dom.el('button', { class: 'imp-floor',
        onclick: () => this.regions.openPick(null, { back: () => this._stepMap() }) },
        'Set the floor-code region…'),
    ]);
  }

  /** Index (into `buildings`) of the next building after the current one that needs attention,
   *  wrapping around — the target of "Next needing attention →". Starts the search *after* `_bIdx`
   *  so repeated clicks page forward through every offender in turn; only wraps back onto the
   *  current index itself when it's the sole building left needing attention. null when nothing in
   *  `buildings` needs attention (disables the button). */
  _nextNeedingAttention(buildings) {
    for (let i = 1; i <= buildings.length; i++) {
      const idx = (this._bIdx + i) % buildings.length;
      if (this._attentionCount(buildings[idx]) > 0) return idx;
    }
    return null;
  }

  /** Picker for which Location field a Location-mode floor's card label is drawn from (see
   *  `LABEL_FIELDS`). Applies to the whole import, not per-building, and lives on the build row
   *  (IMPORT-50) — the label string is resolved fresh at `_build()` time and nothing on the map
   *  step renders it, so changing it only saves the draft (no re-render), and switching it after
   *  floors are already assigned needs no re-clicking. A no-op for a building using the
   *  floor-type fallback (no bound Locations), so it's shown unconditionally rather than only
   *  when a building happens to be in Location mode. */
  _floorLabelFieldControl() {
    const sel = Dom.el('select', {
      onchange: async (e) => {
        this._floorLabelField = e.target.value;
        await this._saveDraft();
      },
    }, ImportFlow.LABEL_FIELDS.map(([value, text]) => {
      const o = Dom.el('option', { value }, text);
      if (value === this._floorLabelField) o.selected = true;
      return o;
    }));
    return Dom.el('div', { class: 'imp-label-field' }, [
      Dom.el('span', {}, 'Floor label from'), sel,
    ]);
  }

  /** Global thumbnail-size slider — resizes every card at once (the alternative to opening
   *  each one). Lives on the wizard so the choice survives step re-renders. */
  _sizer() {
    return Dom.el('div', { class: 'imp-sizer' }, [
      Dom.el('span', {}, 'Thumbnail size'),
      Dom.el('input', { type: 'range', min: '150', max: '810', step: '10',
        value: String(this.thumbWidth),
        oninput: (e) => { this.thumbWidth = parseInt(e.target.value, 10); this._applyThumbSize(); } }),
    ]);
  }

  /** Push the current size onto the map view as CSS vars the grid/cards read. Past a width
   *  threshold a small scan thumbnail can't stay legible when stretched, so upgrade every
   *  card to its on-demand hi-res render (lazy-loaded + server-cached, so only on-screen
   *  large cards actually fetch). */
  _applyThumbSize() {
    if (!this._mapView) return;
    this._mapView.style.setProperty('--imp-card-w', this.thumbWidth + 'px');
    this._mapView.style.setProperty('--imp-thumb-h', Math.round(this.thumbWidth * 110 / 150) + 'px');
    if (this.thumbWidth >= ImportFlow.HIRES_AT && this._cards)
      for (const c of this._cards) c.upgrade();
  }

  /** The last step before floor assignment, asking the two facility-wide questions the drawings
   *  themselves can't answer: **which drawing is the site plan** (the overall map of where the
   *  buildings sit — it carries no floor code, so it is chosen apart from floor assignment) and
   *  **where a drawing says which floor it is** (the code region every card is cropped to).
   *
   *  One step, not two (IMPORT-37, the IMPORT-34 precedent): both were full screens, sequenced by
   *  hidden gates in `_stepMap`, and the first is usually a non-question — the site plan is
   *  auto-detected from a `Site Plan` folder, so its half opens already answered and collapsed.
   *  Neither half gates Continue: the site plan is optional (IMPORT-8) and the crop is skippable. */
  _stepSiteplan() {
    const view = this._stage('Site plan & floor codes', 'siteplan');
    view.append(Dom.el('h3', { class: 'imp-substep' }, 'Which drawing is the site plan?'));
    view.append(Dom.el('p', { class: 'hint' },
      'The site plan is the overall map of the site: the drawing that shows where the buildings '
      + 'sit. It has no floor code, so it’s left out of floor assignment. '
      + 'It’s optional — if your facility has no overall site plan (a single building, or a site '
      + 'with no campus map), leave this as (none) and continue.'));
    view.append(this._siteplanPicker());
    // Null for a siteplan-only import: no floor drawing means nothing to crop, so the step is
    // just its first half rather than a screen apologizing for an empty second one.
    const codes = this.regions.codeSection();
    if (codes) view.append(codes);
    view.append(Dom.el('div', { class: 'imp-actions' }, [
      this._backButton('siteplan'),
      Dom.el('button', { class: 'primary', onclick: async () => {
        this._siteplanStepDone = true; await this._saveDraft(); this._stepMap();
      } }, 'Continue'),
      this._startOver(),
    ]));
  }

  /** The site-plan half of that step: which drawing is the site plan, with a look at it. Two
   *  presentations of the controls:
   *    - **answered** — a pick is already in force, normally auto-detected from a `Site Plan`
   *      folder (`_modelFromInventory`), so the question opens collapsed to its answer + Change;
   *    - **choosing** — the `<select>` of every uploaded drawing, opened by Change or shown
   *      straight away when nothing was detected.
   *  Either way it carries a thumbnail of the current pick — this was the wizard's one drawing
   *  picker with no visual preview, and "is that the site plan?" is a question about the drawing.
   *
   *  The thumbnail and the controls repaint **separately, in place**: picking from the `<select>`
   *  refreshes only the thumbnail, so the picker itself keeps focus (and the code sample below
   *  keeps its zoom/scroll, which a step re-render would reset — IMPORT-2). */
  _siteplanPicker() {
    const thumb = Dom.el('div', { class: 'imp-siteplan-slot' });
    const controls = Dom.el('div', { class: 'imp-siteplan-ctl' });
    const paintThumb = () => {
      thumb.innerHTML = '';
      const picked = this._siteplanDrawing();
      thumb.append(picked ? this._siteplanThumb(picked)
        : Dom.el('span', { class: 'hint' },
          this.site.file ? 'Preview unavailable.' : 'No site plan chosen.'));
    };
    const paintControls = (choosing) => {
      controls.innerHTML = '';
      if (choosing)
        controls.append(Dom.el('label', {}, 'Site plan'), this._siteplanSelect(paintThumb));
      else
        controls.append(
          Dom.el('strong', {}, this.site.folder + ' / ' + this.site.file),
          Dom.el('button', { class: 'imp-link',
            onclick: () => paintControls(true) }, 'Change'));
    };
    paintThumb();
    paintControls(!this.site.file);
    return Dom.el('div', { class: 'imp-siteplan' }, [thumb, controls]);
  }

  /** The scanned drawing `this.site` names, or null when none is chosen (or the pick no longer
   *  exists — a folder can be regrouped away between sessions). Read from the scan inventory, not
   *  the building model, so the site plan is found in a dedicated `Site Plan` folder too. */
  _siteplanDrawing() {
    if (!this.site.file) return null;
    const f = (this.inv?.folders || []).find(x => x.folder === this.site.folder);
    return (f && f.pdfs.find(p => p.file === this.site.file)) || null;
  }

  /** A look at one scanned drawing — the organize-row thumbnail idiom (IMPORT-23): the scan
   *  thumbnail (always page 1), falling back to the on-demand preview when it failed to render,
   *  with wheel-zoom / drag-pan and click-to-lightbox. */
  _siteplanThumb(p) {
    const img = Dom.el('img', {
      src: p.thumb ? ImportFlow._media(p.thumb) : ImportPreview.previewUrl(p.pdf),
      loading: 'lazy', title: 'Click to see the whole drawing',
    });
    const thumb = Dom.el('div', { class: 'imp-thumb imp-siteplan-thumb' }, [img]);
    let hires = !p.thumb;
    ImportPreview.attachZoomPan(thumb, img, { scale: 1, x: 0, y: 0 }, {
      onClick: () => ImportPreview.lightbox(p),
      onZoom: () => { if (!hires) { hires = true; img.src = ImportPreview.previewUrl(p.pdf); } },
    });
    return thumb;
  }

  /** The folder/file `<select>` of every uploaded drawing, used by the site-plan step. Choosing
   *  an option routes through `_setSiteplan`, which also excludes the picked drawing from floor
   *  assignment, then `onPick` repaints the row around it (the thumbnail tracks the choice). */
  _siteplanSelect(onPick) {
    const sel = Dom.el('select', {
      onchange: (e) => {
        const v = e.target.value;
        if (v) { const [folder, file] = JSON.parse(v); this._setSiteplan(folder, file); }
        else this._setSiteplan('', '');
        onPick();
      },
    });
    sel.append(Dom.el('option', { value: '' }, '(none)'));
    for (const f of this.inv.folders)
      for (const p of f.pdfs) {
        const v = JSON.stringify([f.folder, p.file]);
        const o = Dom.el('option', { value: v }, f.folder + ' / ' + p.file);
        if (this.site.folder === f.folder && this.site.file === p.file) o.selected = true;
        sel.append(o);
      }
    return sel;
  }

  /** Compact, read-only site-plan line shown atop the map step (selection happens in the Site plan
   *  step). "Change" jumps to that step — a plain step call, like every other navigation in the
   *  wizard; it used to un-set the step's done-flag and re-enter `_stepMap` to be bounced back
   *  there, which was a third way to navigate and the reason those gates existed (IMPORT-37). */
  _siteplanSummary() {
    const label = this.site.file ? (this.site.folder + ' / ' + this.site.file) : '(none)';
    return Dom.el('div', { class: 'imp-siteplan' }, [
      Dom.el('span', {}, 'Siteplan: '), Dom.el('strong', {}, label),
      Dom.el('button', { class: 'imp-link', onclick: () => this._stepSiteplan() }, 'Change'),
    ]);
  }

  /** Choose (or clear, with empty args) the site-plan drawing. The chosen drawing has no floor,
   *  so it's marked `type:'none'` — excluded from floor assignment and the code-region sample; a
   *  building drawing previously picked reverts to `unassigned` so the user gives it a real floor. */
  _setSiteplan(folder, file) {
    this._setAssignNone(this.site.folder, this.site.file, false);   // revert the prior pick
    this.site = (folder && file) ? { folder, file } : { folder: '', file: '' };
    this._setAssignNone(this.site.folder, this.site.file, true);    // exclude the new pick
  }

  /** Toggle one drawing between "no floor" (`type:'none'`) and "needs a floor"
   *  (`type:'unassigned'`). No-ops when the folder/file isn't one of a building's drawings. A
   *  dedicated site-plan folder's drawing is never un-noned — that folder contributes no floor. */
  _setAssignNone(folder, file, none) {
    if (!folder || !file) return;
    const b = this.buildings.find(x => x.folder === folder);
    if (!b) return;
    const p = b.pdfs.find(x => x.file === file);
    if (!p || !(p.stem in b.assign)) return;
    const a = b.assign[p.stem];
    if (none) { a.type = 'none'; a.token = null; a.label = ''; }
    else if (a.type === 'none' && !/site\s*plan/i.test(folder)) {
      a.type = 'unassigned'; a.token = null; a.label = '';
    }
  }

  /** True when drawing `p` is this building's chosen site plan — the card that carries no floor and
   *  shows a badge instead of the floor selector (`_pdfCard`). Keyed on the `this.site` match, not
   *  merely `type:'none'`, so a card manually set to "(none)" is NOT the siteplan. The siteplan
   *  renders page 1 of its file, so for a multi-page PDF only the first page row is the site plan —
   *  pages 2..N are ordinary floor cards. Shared by `_pdfCard` and the bulk-triage actions, which
   *  must never clobber the siteplan pick. */
  _isSiteplanPick(b, p) {
    return this.site.folder === b.folder && this.site.file === p.file && (!p.page || p.page === 1);
  }

  /** The buildings as the draft stores them: everything except the **fetched** NetBox state
   *  (`nbFloors` + its `nbFloorsError` verdict). `_applyDraft` deliberately never reads those back —
   *  they are re-fetched per session by `_loadFloors`, since a Location renamed in NetBox must not be
   *  resurrected from a stale draft — so persisting them is pure weight, and the draft is rewritten
   *  on *every* carousel click. A site's whole Location list is now read in one shot, which would
   *  multiply that weight by the row cap. A shallow per-building copy is enough: nothing else on a
   *  building is mutated by serializing it. */
  _draftBuildings() {
    return this.buildings.map(({ nbFloors, nbFloorsError, ...rest }) => rest);
  }

  /** POST the current building model to the server as a draft so it can be restored on next
   *  open. Silent on failure — a missing draft just means the user starts fresh. */
  async _saveDraft() {
    try {
      const apiBase = window.MAP ? window.MAP.api : '/api/';
      const headers = { 'Content-Type': 'application/json' };
      if (window.MAP && window.MAP.csrf) headers['X-CSRFToken'] = window.MAP.csrf;
      await fetch(Api.withFacility(apiBase + 'import/save-draft'), {
        method: 'POST', headers,
        body: JSON.stringify({ buildings: this._draftBuildings(), site: this.site,
          codeRegion: this._codeRegion, bIdx: this._bIdx,
          siteplanStepDone: this._siteplanStepDone, floorLabelField: this._floorLabelField,
          campus: this.campus, campusPromptDone: this._campusPromptDone }),
      });
    } catch (e) { console.warn('Draft save failed:', e); }
  }

  /** Fetch a saved draft and merge it into `this.buildings` / `this.site`. New folders (not
   *  in the draft) keep their `_modelFromInventory` defaults; removed stems are ignored. */
  async _applyDraft() {
    try {
      const apiBase = window.MAP ? window.MAP.api : '/api/';
      const r = await fetch(Api.withFacility(apiBase + 'import/load-draft'));
      if (!r.ok) return;
      const draft = await r.json();
      if (!draft.ok) return;
      const byFolder = new Map((draft.buildings || []).map(b => [b.folder, b]));
      for (const b of this.buildings) {
        const d = byFolder.get(b.folder);
        if (!d) continue;
        if (d.name != null) b.name = d.name;
        if (d.slug != null) b.slug = d.slug;
        if (d.abbr != null) b.abbr = d.abbr;
        if (d.nbSite !== undefined) b.nbSite = d.nbSite;
        if (d.nbBuilding !== undefined) b.nbBuilding = d.nbBuilding;
        if (d.codeRegion !== undefined) b.codeRegion = d.codeRegion;
        // A restored `assign`/`regions` entry drives `_resolveFloors`/`_cardUnassigned`/the split
        // editor, so a malformed one (corrupt draft) is dropped rather than trusted — the stem
        // keeps its `_modelFromInventory` default instead of throwing mid-render.
        for (const [stem, a] of Object.entries(d.assign || {}))
          if (stem in b.assign && ImportFlow._validAssign(a)) b.assign[stem] = a;
        for (const [stem, f] of Object.entries(d.frame || {}))
          if (stem in b.frame) b.frame[stem] = f;
        for (const [stem, a] of Object.entries(d.angle || {}))
          if (stem in b.angle) b.angle[stem] = a;
        for (const [stem, r] of Object.entries(d.regions || {}))
          if (stem in b.regions && Array.isArray(r)) b.regions[stem] = r.filter(ImportFlow._validRegion);
        for (const [stem, a] of Object.entries(d.align || {}))
          if (stem in b.align && Array.isArray(a)) b.align[stem] = a.filter(ImportFlow._validAlignPair);
      }
      if (draft.site?.file) this.site = draft.site;
      if (draft.codeRegion) this._codeRegion = draft.codeRegion;
      if (ImportFlow._draftStepDone(draft)) this._siteplanStepDone = true;
      // The campus pick (site-as-campus mode) and its once-per-session prompt guard. Validated like
      // any other draft field — a corrupt entry falls back to "unchosen", never throws.
      if (ImportFlow._validCampus(draft.campus)) this.campus = draft.campus;
      if (draft.campusPromptDone) this._campusPromptDone = true;
      if (ImportFlow.LABEL_FIELDS.some(([f]) => f === draft.floorLabelField))
        this._floorLabelField = draft.floorLabelField;
      // Resume on the building the user last viewed. Clamp to the floor-mapping carousel
      // (`_mappableBuildings`, which `_bIdx` indexes) — folders can be added/removed between
      // sessions. `_stepMap` re-clamps too, so this is a defensive belt-and-suspenders.
      const mappable = this._mappableBuildings();
      if (mappable.length) {
        const n = Number.isInteger(draft.bIdx) ? draft.bIdx : 0;
        this._bIdx = Math.max(0, Math.min(n, mappable.length - 1));
      }
    } catch (e) { console.warn('Draft load failed:', e); }
  }

  // ---- floor resolution: NetBox floor Locations -> the import-map floor table ----
  // One section for the whole theme: loading a building's floor Locations (and keeping stale
  // tokens out), restoring bindings from the built manifest, and resolving the per-drawing
  // assignment controls into the floor tokens `_buildMap` emits.


  /** Lazily fetch a building's NetBox floor Locations so the per-card floor selector can offer
   *  them as buttons. Cached on `b.nbFloors`; on completion the map step re-renders if this
   *  building is still the visible one. A blank slug or empty result leaves `b.nbFloors = []`,
   *  which drives the floor-type fallback.
   *
   *  The re-render is the **in-place section swap**, not a full `_stepMap()` (IMPORT-2): floors land
   *  asynchronously, so re-rendering the whole stage yanked the page back to the top under an
   *  operator who had already scrolled into the grid. The floor arrival only changes this building's
   *  header + cards, which is exactly what `_rerenderBuildingSection` replaces (re-running
   *  `_applyThumbSize` and `_refreshBuildActions` with it). `_stepMap` assigns
   *  `_buildingSectionEl` synchronously, before this promise can settle, so the section is always
   *  captured by the time we get here — and `_rerenderBuildingSection` falls back to a full render
   *  if it somehow isn't. */
  _ensureFloors(b) {
    if (b.nbFloors !== undefined) return;
    this._loadFloors(b).then(() => {
      if (this._mapView && this._mappableBuildings()[this._bIdx] === b)
        this._rerenderBuildingSection(b);
    });
  }

  /** Fetch and cache a building's NetBox floor Locations (idempotent). Resolves once
   *  `b.nbFloors` is settled to an array — empty when unbound or the site has none (driving the
   *  floor-type fallback). Driven by the lazy per-building load (`_ensureFloors`) when the map
   *  step shows the building.
   *
   *  **Why the list is what it is is recorded alongside it, in `b.nbFloorsError`** (null = a clean,
   *  complete read): `'fetch'` the request threw, `'site-missing'` no NetBox Site answers to
   *  `b.slug`, `'truncated'` the server's row cap clipped the list **where the floors live**. All
   *  three used to land as a bare empty/partial array, indistinguishable from "this site genuinely
   *  has no floor Locations" — so a broken binding or a network blip quietly demoted the building to
   *  the floor-**type** vocabulary and built floor ids that match nothing in NetBox.
   *  `ImportCards._floorButtons` names the real cause instead.
   *
   *  The whole site Location list is read in ONE shot (`full`), not per keystroke: rooms are
   *  Locations too, so the per-keystroke cap is exceeded by an ordinary site long before a campus
   *  (IMPORT-29). Those rooms are also why `'truncated'` is not simply `res.truncated`: the answer
   *  comes back shallowest-first, so a cap clips rooms long before floors, and only
   *  `_clippedTheFloors` can say whether this building's floors were actually affected
   *  (IMPORT-49). */
  async _loadFloors(b) {
    if (Array.isArray(b.nbFloors)) return;   // already loaded
    const slug = (b.slug || '').trim();
    if (!slug) { b.nbFloors = []; b.nbFloorsError = null; return; }
    b.nbFloors = 'loading';
    b.nbFloorsError = null;
    // For a Site anchor the building Location is named after the bound NetBox site, so match on that
    // (not the user-editable `b.name`); fall back to `b.name` when unbound. For a Location anchor the
    // building Location is known by slug (`nbBuilding`), so its children are the floors directly.
    const siteName = (b.nbSite && b.nbSite.name) || b.name;
    const buildingSlug = b.nbBuilding && b.nbBuilding.slug;
    let floors = [], complete = false, error = null;
    try {
      const res = await this.app.netbox.locations(slug, '', true);
      const locs = res.rooms || [];
      this._siteLocs.set(slug, locs);   // tree cache for the anchor controls (see the constructor)
      floors = this._mergeAssignedFloors(b, this._floorsFromLocations(locs, siteName, buildingSlug),
                                         locs, buildingSlug);
      // A slug naming no Site is a broken binding, not an empty site — say which.
      if (res.site_not_found) error = 'site-missing';
      else if (res.truncated && ImportFlow._clippedTheFloors(res, locs, buildingSlug))
        error = 'truncated';
      complete = !error;
    } catch (_) { floors = []; error = 'fetch'; }
    b.nbFloors = floors;
    b.nbFloorsError = error;
    // **Only sweep against a list we know is complete.** A failed request yields an empty list and a
    // floor-clipping read a partial one; sweeping on either discards assignments whose Location is
    // merely absent from *this answer*, not from NetBox — a transient blip silently resetting a page
    // of confirmed floor picks (IMPORT-29). What "complete" means is the whole point of
    // `_clippedTheFloors`: before IMPORT-49 any clipped tail of *rooms* counted, so on a real
    // facility the sweep never ran at all and a genuinely stale token survived every reload.
    if (complete && buildingSlug) this._dropUnanchoredTokens(b, floors);
    if (floors.length) this._normalizeToLocations(b);
    // Order matters: the two passes above are what *blank* an assignment (entering Location mode, or
    // an anchor change stranding a token), and this fills those blanks back in from each drawing's
    // filename (IMPORT-28). Running it last means a re-anchor re-suggests against the new anchor's
    // Locations rather than leaving a page of "⚠ pick a floor", and — because it only ever writes to
    // a blank — an assignment the operator made still wins.
    this.bulk.suggestFloors(b);
  }

  /** Location anchor only: reset any assignment whose Location token isn't one of the anchor's
   *  floors, so the wizard can never emit a `floor_key` that won't resolve.
   *
   *  A 3-segment key is `"<site>/<anchor>/<floor>"` and the backend resolves the floor **under the
   *  anchor** (`parent__slug`, `frontend_api.resolve_floor_location`), so a token that isn't a child
   *  of the current anchor is dead on arrival. Tokens can go stale two ways: re-binding the folder to
   *  a different building Location, and `_reanchorBuilding` drilling the anchor down to a wing. Both
   *  land here via the `nbFloors = undefined` re-fetch. Downgrading to `unassigned` (never to a
   *  silently-wrong floor) routes the drawing into the existing build gate, so the user re-picks
   *  rather than discovering a dead floor after the build. A deliberate `— none —` is left alone.
   *  Region-split boxes (FLOOR-4) carry the same `assign` shape and the same key, so they are swept
   *  alongside the scalar assignment. */
  _dropUnanchoredTokens(b, floors) {
    const valid = new Set(floors.map(f => f.slug));
    const drop = (a) => {
      if (!a || !a.token || valid.has(a.token)) return;
      a.token = null; a.label = ''; a.type = 'unassigned';
    };
    for (const p of b.pdfs) {
      drop(b.assign[p.stem]);
      for (const r of (b.regions[p.stem] || [])) drop(r.assign);
    }
  }

  /** Re-include any Location a drawing is already assigned to (`assign[*].token`) that the floor
   *  heuristic didn't surface — i.e. a floor the user added via `_addFloor`'s Location search in a
   *  prior session. Assignments persist in the draft but `nbFloors` is rebuilt each load, so
   *  without this an added floor would lose its button (and its sibling drawings couldn't pick it).
   *  Looks the token up in the full site Location list so the button reappears with its real
   *  name/slug; a token whose Location no longer exists is left out (the user redoes it). Keeps the
   *  natural sort order.
   *
   *  **Scoped to the anchor's children for a Location anchor** (`buildingSlug` given): a 3-segment
   *  key resolves the floor *under* the anchor, so re-adding a Location from anywhere else in the
   *  site would restore a button whose key can never resolve. `_dropUnanchoredTokens` then clears
   *  the assignment that pointed at it. A Site anchor is unscoped, as before — its whole-site search
   *  is the deliberate escape hatch for a floor parked outside the building root. */
  _mergeAssignedFloors(b, floors, locs, buildingSlug) {
    const have = new Set(floors.map(f => f.slug));
    const anchorId = buildingSlug
      ? (locs.find(l => l.slug === buildingSlug) || {}).id : null;
    const bySlug = new Map(locs.map(l => [l.slug, l]));
    for (const p of b.pdfs) {
      const tok = b.assign[p.stem] && b.assign[p.stem].token;
      if (!tok || have.has(tok)) continue;
      const loc = bySlug.get(tok);
      if (!loc) continue;
      if (buildingSlug && loc.parent !== anchorId) continue;
      have.add(tok); floors.push(loc);
    }
    return floors.sort((x, y) => (x.name || '').localeCompare(y.name || '', undefined, { numeric: true }));
  }

  /** Pick the floor Locations out of a site's flat Location list using the parent tree.
   *
   *  **Location anchor (Site = campus, `buildingSlug` given — MODEL-4):** the building Location is
   *  known exactly, so the floors are strictly its **children** (`l.parent === building.id`) — no
   *  root/sibling guessing, and two buildings under one campus stay separated. An unknown slug (the
   *  Location vanished) yields no floors, driving the floor-type fallback.
   *
   *  **Site anchor (no `buildingSlug`):** the building Location is the root named after the bound
   *  site (e.g. "MAIN BUILDING"); its children are floors. Any OTHER root is itself a floor — some
   *  sites park a floor like "Roof" or "Level B2" at the top level, as a sibling of the building.
   *  When no root matches the site name the site has no building wrapper and the roots themselves are
   *  the floors (e.g. ANNEX). Identifying the building by name — not by tree shape — works even when
   *  the floors have no rooms under them yet.
   *
   *  **Children, never descendants — the anchor is the floors' *direct parent* (MULTI-5).** A
   *  3-segment key writes the anchor's slug in the middle and the backend resolves the floor with
   *  `parent__slug=<anchor>`, so offering a grandchild here would emit a key that can never resolve.
   *  A deeper tree (campus → building → wing → floor) is therefore handled by anchoring the folder
   *  on the **wing** — which yields the ordinary, already-working `site/wing/floor` key — not by
   *  widening this scan. `_anchorDrillControl` is the affordance that lets the operator drill the
   *  anchor down to it; see architecture §7.
   *
   *  Either way `depth`/`level` is avoided (MPTT-only, unreliable on NetBox 4.2+). Floors are sorted
   *  by name for a stable, natural order (B1, B2, G, …, Roof). */
  _floorsFromLocations(locs, siteName, buildingSlug) {
    const sortByName = (arr) =>
      arr.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }));
    if (buildingSlug) {
      const building = locs.find(l => l.slug === buildingSlug);
      return sortByName(building ? locs.filter(l => l.parent === building.id) : []);
    }
    const ids = new Set(locs.map(l => l.id));
    const roots = locs.filter(l => l.parent == null || !ids.has(l.parent));
    const nameLc = (siteName || '').trim().toLowerCase();
    const building = nameLc
      ? roots.find(r => (r.name || '').trim().toLowerCase() === nameLc) : null;
    const floors = roots.filter(r => r !== building);
    if (building) for (const l of locs) if (l.parent === building.id) floors.push(l);
    return sortByName(floors);
  }

  /** Entering Location mode: a drawing with no Location token yet is marked `unassigned` so it
   *  contributes no floor and gates the build until the user picks a Location button — the auto
   *  Level 1..N defaults only apply to the floor-type fallback. `unassigned` is distinct from a
   *  deliberate `— none —` (`type:'none'`), which is a real choice and passes the build gate
   *  (see `_unassignedBuildings`). */
  _normalizeToLocations(b) {
    for (const p of b.pdfs) {
      const a = b.assign[p.stem];
      if (!a.token && a.type !== 'none') a.type = 'unassigned';   // keep a deliberate — none — (e.g. the site plan)
    }
  }

  /** Fill each still-unbound building's NetBox binding from the last-built manifest. The edit
   *  hub derives "bound?" from `b.nbSite`, but only `_applyDraft` repopulates it — a fresh import
   *  that went straight to Build writes no draft, so on reopen every building reads as unbound even
   *  though the manifest (and the read-only map) hold the real binding. Match the scan model to the
   *  manifest by `folder` and synthesize `nbSite` from the persisted `siteSlug`/`name` for any
   *  building the draft left null, so the hub reflects the built state. Runs after `_applyDraft`
   *  and only touches nulls, so an in-progress draft binding still wins; a no-op when nothing is
   *  built yet (empty manifest) or on a manifest built before `folder` was emitted — those correct
   *  on the next rebuild. A Location-anchored manifest building (a `buildingSlug`, MODEL-4) restores
   *  the Location anchor: `siteSlug` is the campus (no site *name* is stored, so the slug stands in —
   *  only cosmetic, since a Location anchor's floors load by `buildingSlug`, not the site name), and
   *  `buildingSlug`/`name` are the building Location. The `id`s are unused downstream (all logic keys
   *  off `slug`/`name`), so null ids are fine. */
  _reconcileFromManifest() {
    const manifest = this.app.store.manifest;
    if (!manifest || !manifest.buildings) return;
    const byFolder = new Map(manifest.buildings
      .filter(m => m.folder && m.siteSlug).map(m => [m.folder, m]));
    for (const b of this.buildings) {
      if (b.nbSite) continue;
      const m = byFolder.get(b.folder);
      if (!m) continue;
      if (m.buildingSlug)
        this._bindBuilding(b, { id: null, slug: m.siteSlug, name: m.siteSlug },
          { id: null, slug: m.buildingSlug, name: m.name || b.name }, false);
      else
        this._bindSite(b, { id: null, slug: m.siteSlug, name: m.name || b.name }, false);
    }
    // Seed the campus (site-as-campus mode) from the built manifest so a re-opened facility shows
    // its campus rather than re-prompting: the first Location-anchored building's `siteSlug` is the
    // campus (every building under one campus shares it). Only fills an unset campus, so a draft's
    // in-progress pick still wins; no site *name* is stored, so the slug stands in (cosmetic — the
    // scoping keys off the slug). Also marks the prompt done, since a built facility already chose.
    if (this._isCampusMode() && !this.campus) {
      const anchored = manifest.buildings.find(m => m.siteSlug && m.buildingSlug);
      if (anchored) {
        this.campus = { id: null, slug: anchored.siteSlug, name: anchored.siteSlug };
        this._campusPromptDone = true;
      }
    }
  }

  /** Resolve one drawing's floor-assignment controls (`assign`) to an import-map floor token: a
   *  direct NetBox Location slug (Location mode) takes precedence, else the floor-type vocabulary
   *  (basement/ground/level N/roof); legacy `same` reuses the previous token. null = no floor.
   *  Shared by the scalar path and the per-region path (FLOOR-4). */
  _assignToken(a, last) {
    if (a.token) return a.token;   // direct NetBox Location slug (Location mode)
    if (a.type === 'basement') return 'b' + (a.num || 1);
    if (a.type === 'ground') return 'g';
    if (a.type === 'level') return 'l' + (a.num || 1);
    if (a.type === 'roof') return 'r';
    if (a.type === 'same') return last;
    return null;
  }

  /** Resolve a building's per-PDF controls into the import-map `floors` table. A drawing with no
   *  region-split (the common case) emits a **scalar** token; a region-split drawing (`regions[stem]`
   *  non-empty, FLOOR-4) emits the `[{token, region}]` **list** `preprocess._page_entries` fans into
   *  one floor per region (`region` = `[x, y, w, h]` normalized 0..1). Only token-bearing regions are
   *  emitted, so the list is gap-free and its 1-based order lines up with the `<stem>@rN` label keys
   *  `_build` writes (matching `_page_entries`' enumeration). */
  _resolveFloors(b) {
    const floors = {}; let last = null;
    for (const p of b.pdfs) {
      const regions = b.regions[p.stem];
      if (regions && regions.length) {
        const list = [];
        for (const r of regions) {
          const tok = this._assignToken(r.assign, last);
          if (tok) { list.push({ token: tok, region: [r.box.x, r.box.y, r.box.w, r.box.h] }); last = tok; }
        }
        if (list.length) floors[p.stem] = list;
        continue;
      }
      const tok = this._assignToken(b.assign[p.stem], last);
      if (tok) { floors[p.stem] = tok; last = tok; }
    }
    return floors;
  }

  /** Buildings that still hold an `unassigned` drawing (Location mode, untouched — see
   *  `_normalizeToLocations`). The build gate lists these so the user knows where to look, and
   *  (IMPORT-40) links each one straight back into the carousel — returning the building objects
   *  rather than names keeps that jump a plain `_jumpToBuilding(b)` at the call site. A cheap
   *  synchronous pass over the in-memory model — `_stepMap` recomputes it every render. Buildings
   *  the user hasn't visited keep their `_modelFromInventory` level defaults (never `unassigned`),
   *  so they don't gate the build; only visited Location-mode buildings can. */
  _unassignedBuildings() {
    return this.buildings.filter(b => this._unassignedCount(b) > 0);
  }

  /** How many of building `b`'s drawings still need a floor (Location mode `unassigned`, or a
   *  region-split drawing with an unassigned region) — the count `_buildingNavLabel` and
   *  `_unassignedBuildings` both key off (IMPORT-40). */
  _unassignedCount(b) {
    return b.pdfs.filter(p => this._cardUnassigned(b, p)).length;
  }

  /** Names of floor-contributing buildings with no NetBox anchor — the build row warns about these
   *  (IMPORT-29). Keyed off `_floorBuildings()`, so a folder that resolves no floor at all (a
   *  siteplan-only folder) is correctly silent: it needs no anchor because it emits nothing to bind.
   *  Advisory only — unlike `_unassignedBuildings` this never disables Build; see `_buildActions`. */
  _unboundBuildings() {
    return this._floorBuildings().filter(b => !b.nbSite).map(b => b.name || b.folder);
  }

  /** Whether one drawing still needs a floor (gates the build). A region-split drawing (FLOOR-4)
   *  is unassigned while any of its regions is — a fresh region defaults to `unassigned` until the
   *  user picks its floor; a whole-page drawing keys off its own `assign`. */
  _cardUnassigned(b, p) {
    const regions = b.regions[p.stem];
    if (regions && regions.length) return regions.some(r => r.assign.type === 'unassigned');
    return b.assign[p.stem].type === 'unassigned';
  }

  // ---- step 3: build ----

  /** Render the facility from the current model (step 3), in three stages: assemble the
   *  import-map (`_buildMap`), get the user's consent for whatever the rebuild does to rooms they
   *  have already drawn (`_confirmBuild`), then POST it and settle up (`_afterBuild`). Split that
   *  way because the three have genuinely different jobs — a pure model->JSON transform, one review
   *  dialog over `ImportDiff`'s findings, and the post-success bookkeeping — and the middle one is
   *  the only part that can send the user back to the map step. */
  async _build() {
    // Stop the background floor-code sweep first (IMPORT-53). It reads the rendered previews of
    // the same uploads a rebuild re-renders, and it applies its results to a model the build has
    // already snapshotted — so letting it run into a build buys nothing and races the working dir.
    // OCR itself stays lock-free (§10 in-app-import); this is the client end of that bargain.
    // Not suppressed: a build the operator backs out of, or one that fails, leaves them on the map
    // step, where the facility should carry on being read.
    this.ocr.cancel({ suppress: false });
    const map = await this._buildMap();
    if (!map) return;              // a boundary rejection (anchor collision, blank slug, no floors)
    const plan = await this._confirmBuild(map);
    if (!plan) return this._stepMap();   // the user declined one of the room-safety warnings

    const view = this._stage('Building facility map…');
    view.append(Dom.el('div', { class: 'imp-spinner' },
      'Rendering ' + Object.keys(map.buildings).length + ' buildings. This can take a minute.'));
    try {
      const r = await Api.post('/api/import/build', map);
      // Carry the server's actionable hint (e.g. an HQ render that outran render_mem_mb, HEALTH-3)
      // onto the Error so the catch can add it to the otherwise-reassuring failure toast.
      if (!r.ok) { const err = new Error(r.error || 'build failed'); err.hint = r.hint; throw err; }
      await this._afterBuild(r, plan);
    } catch (e) {
      // A failed build never deletes anything: `build()` overwrites the manifest only on success
      // (and atomically), and we never reached `store.load()`, so the store still holds the
      // last-good map. Reassure the user rather than toasting a raw render traceback that reads as
      // "everything was wiped", and keep them on the review step to fix a drawing and retry.
      console.error('Facility rebuild failed', e);
      // Keep the reassuring "nothing was lost" lead, then append the server's actionable hint when
      // it named one (an HQ render that outgrew its memory/time budget, HEALTH-3) so the fix is in
      // front of the user instead of buried in the console.
      let msg = 'Rebuild failed. Your existing map is unchanged and still active. Nothing was lost.';
      if (e && e.hint) msg += ' ' + e.hint;
      Toast.show(msg, true);
      this._stepMap();
    }
  }

  /** Assemble the import-map `/api/import/build` consumes from the current building model — the
   *  pure model->JSON half of the build. Returns null (after toasting) for the three boundary
   *  rejections that must never reach a render: two buildings resolving to the same NetBox anchor,
   *  a building with a blank site slug, and a model that contributes no floor at all. */
  async _buildMap() {
    const map = { siteplan: this.site.file
      ? { folder: this.site.folder, pdf: this.site.file, slug: '00-site' } : null, buildings: {} };
    // Two floor-contributing buildings that resolve to the SAME **anchor** would produce colliding
    // floor keys (`<dir>/(abbr+token)`, see `preprocess.build`) and silently clobber each other's
    // floors (and rooms). The anchor identity is `ImportFlow.anchorKey` — so two buildings may share
    // a site slug iff they anchor to *distinct* building Locations (the Site = campus case). Reject
    // at the boundary before any render — the per-building empty-slug guard below still catches a
    // blank slug (`anchorKey` returns '' for one, which is skipped here).
    const byAnchor = {};
    for (const b of this._floorBuildings()) {
      const anchor = ImportFlow.anchorKey(b);
      if (!anchor) continue;
      (byAnchor[anchor] = byAnchor[anchor] || []).push(b.name || b.folder);
    }
    const collision = Object.entries(byAnchor).find(([, names]) => names.length > 1);
    if (collision) {
      Toast.show('Two buildings resolve to the same NetBox anchor “' + collision[0] + '” ('
        + collision[1].join(', ') + '). Bind each to its own site or building.', true);
      return null;
    }
    for (const b of this.buildings) {
      if (!b.slug.trim()) { Toast.show('Every building needs a site slug (' + b.folder + ')', true); return null; }
      const floors = this._resolveFloors(b);
      if (!Object.keys(floors).length) continue;   // a siteplan-only folder, etc.
      // Floor tokens that are real Location slugs must not be re-prefixed: `preprocess.py`
      // builds the floor id as `abbr + token`, and that id is later matched against
      // `Location.slug`, so force an empty prefix whenever a direct token is in play — including a
      // Location token assigned to a region-split box (FLOOR-4), not just the scalar assignment.
      const usesTokens = b.pdfs.some(p => {
        const regions = b.regions[p.stem];
        return (regions && regions.length)
          ? regions.some(r => r.assign.token) : b.assign[p.stem].token;
      });
      // Straightening angle per mapped drawing, keyed identically to `floors`. Only non-zero
      // entries are emitted (a parallel `angles` map, omitted entirely when nothing is rotated) so
      // an unrotated import writes the same map as before.
      const angles = {};
      for (const p of b.pdfs) {
        const deg = b.angle[p.stem] && b.angle[p.stem].deg;
        if (deg && floors[p.stem]) angles[p.stem] = deg;
      }
      // Friendly floor labels for Location-mode floors, keyed identically to `floors` (a parallel
      // `labels` map, omitted entirely when no floor resolves one — mirrors `angles`, so a
      // floor-type-only import writes the same map as before). `_loadFloors` is awaited (not just
      // `_ensureFloors`'d) so a building the user configured in an earlier session but hasn't
      // revisited this one still has `nbFloors` populated to read the label from — it's cached and
      // idempotent, so this is a no-op for a building already visited. `preprocess.py` falls back
      // to its own slug-derived guess for any stem missing here.
      await this._loadFloors(b);
      const labelFor = (token) => {
        const loc = (b.nbFloors || []).find(f => f.slug === token);
        return loc && (loc[this._floorLabelField] || loc.name);
      };
      // Key labels off the *resolved* `floors` table (not the raw assignments) so a region floor's
      // `<stem>@rN` index matches the list entry `_page_entries` emits (FLOOR-4). A non-Location
      // token resolves no label — the backend falls back to `floor_label(token)`, as before.
      // Alongside `labels`, `locationTokens` marks the same keys `true` whenever the origin is a
      // direct Location slug (`assign.token`) — independent of whether a friendly label text
      // resolved (INTL-2). `preprocess.py`'s `floor_label` uses it to skip the compact floor-code
      // grammar for a Location slug that happens to collide with it (e.g. a Spanish "Bloque 1"
      // slugged `b1`, with no label text chosen, must not become "Basement 1"). Only the *anchor*
      // sheet of a `same`-chained multi-sheet floor has `assign.token` set, but that's enough —
      // `preprocess.py` tracks the marker per floor id, scanning every contributing sheet.
      const labels = {};
      const locationTokens = {};
      for (const p of b.pdfs) {
        const f = floors[p.stem];
        if (Array.isArray(f)) {
          const regions = b.regions[p.stem] || [];
          f.forEach((e, i) => {
            const r = regions[i];
            if (!r || !r.assign.token) return;
            locationTokens[p.stem + '@r' + (i + 1)] = true;
            const l = labelFor(e.token); if (l) labels[p.stem + '@r' + (i + 1)] = l;
          });
        } else if (f) {
          const a = b.assign[p.stem];
          if (a.token) {
            locationTokens[p.stem] = true;
            const l = labelFor(a.token); if (l) labels[p.stem] = l;
          }
        }
      }
      // Overlay control points (FMT-6), keyed by stem like `angles`: only a mapped OVERLAY
      // drawing with enough clean pairs to solve (≥2) is emitted — the backend georeferences
      // that layer — so an unaligned import writes the same map as before.
      const overlayAlign = {};
      for (const p of b.pdfs) {
        const pairs = ((b.align && b.align[p.stem]) || []).filter(ImportFlow._validAlignPair);
        if (pairs.length >= 2 && floors[p.stem] && ImportUploader.isOverlay(p.file))
          overlayAlign[p.stem] = pairs;
      }
      map.buildings[b.folder] = { slug: b.slug.trim(), name: b.name.trim() || b.folder,
        abbr: usesTokens ? '' : b.abbr.trim(), floors,
        // A Location anchor (Site = campus, MODEL-4) emits its building Location slug, which
        // `preprocess.build_building_from_pdfs` nests into `dir` (→ 3-segment floor keys + nested
        // image paths). Omitted for a Site anchor, so a Site-anchored import-map stays byte-identical.
        ...(b.nbBuilding ? { buildingSlug: b.nbBuilding.slug } : {}),
        ...(Object.keys(angles).length ? { angles } : {}),
        ...(Object.keys(labels).length ? { labels } : {}),
        ...(Object.keys(locationTokens).length ? { locationTokens } : {}),
        ...(Object.keys(overlayAlign).length ? { overlayAlign } : {}) };
    }
    if (!Object.keys(map.buildings).length) { Toast.show('Assign at least one floor', true); return null; }
    // Carry the site drawing's own straightening angle into the siteplan block.
    if (map.siteplan) {
      const sb = this.buildings.find(x => x.folder === this.site.folder);
      const sp = sb && sb.pdfs.find(p => p.file === this.site.file && (!p.page || p.page === 1));
      const sdeg = sp && sb.angle[sp.stem] && sb.angle[sp.stem].deg;
      if (sdeg) map.siteplan.angle = sdeg;
    }
    return map;
  }

  /** Ask the user about everything this rebuild would do to rooms and hotspots they have already
   *  drawn, from `ImportDiff`'s three reads. Returns the plan `_afterBuild` needs
   *  (`{orphaned, reprojections, refit}`), or null when the user backed out — the caller then
   *  returns them to the map step, having written nothing.
   *
   *  The three reads run in a deliberate order: reprojections are computed first so the orphan list
   *  can exclude the floors whose rooms are being *moved* rather than discarded. Presenting them is
   *  `ImportBuildReview`'s job (IMPORT-39) — one dialog showing every finding at once, rather than
   *  the chain of up to four native `confirm()`s this used to fire at the flow's most consequential
   *  action. A rebuild with nothing at risk still asks nothing at all. */
  async _confirmBuild(map) {
    // A whole→region split (FLOOR-5) changes a floor's id *and* coordinate space. Rather than orphan
    // its rooms, remap each into the region it sits in; compute that plan first so the orphan list
    // below can exclude these sources — their rooms are moved, not discarded.
    const reprojections = await this.diff.resplitReprojections(map);
    const reprojectedKeys = new Set(reprojections.map(r => r.oldKey));

    // Re-assigning a drawing's floor or re-binding a building changes the floor id; rooms drawn
    // on the old id are no longer in the rebuilt manifest — they are discarded (excluding the
    // whole→region splits above, whose rooms are reprojected onto their new region floors).
    const orphaned = (await this.diff.orphanedFloors(map)).filter(o => !reprojectedKeys.has(o.key));

    // Rebuilding a floor (or the siteplan) can keep its id (so `ImportDiff.orphanedFloors` won't
    // catch it) but change the underlying drawing — a different orientation, a different (siteplan)
    // aspect ratio, or a drawing replaced in place (REPL-1, where even a same-size margin/crop shift
    // is undetectable from manifest metadata) — desyncing rooms/hotspots already placed against the
    // old drawing. Non-destructive: they are kept, just worth re-checking.
    const desynced = await this.diff.desyncedFloors(map);

    if (!orphaned.length && !reprojections.length && !desynced.length)
      return { orphaned, reprojections, refit: null };   // nothing at risk — don't interrupt at all

    // An aspect-only siteplan swap skews the hotspots by a known amount, so beyond listing the
    // desync we can offer to correct it (IMPORT-11). The dialog carries it as an opt-in checkbox,
    // default off — the fit assumes the new drawing shows the same area, and a wrong automatic
    // transform is worse than a skew the user can see — and it stays undoable from the completion
    // toast. The transform itself is applied after the build, against the rebuilt manifest's real
    // dimensions.
    const spRefit = desynced.find(o => o.refit);
    return ImportBuildReview.open({ orphaned, reprojections, desynced,
      refit: spRefit ? spRefit.refit : null });
  }

  /** Settle up after a successful render: reload the store from the new manifest, persist the room
   *  bookkeeping the rebuild implied, apply an opted-into hotspot re-fit, and land the user on the
   *  siteplan with one toast folding in every notice. `plan` is `_confirmBuild`'s return; `r` is
   *  the build response, whose render diagnostics ride that same toast. */
  async _afterBuild(r, plan) {
    const { orphaned, reprojections, refit } = plan;
      await this.app.store.load();
      // The manifest is now rebuilt from the current drawings, so any replace this session is
      // reconciled — clear the tracker so a later no-op rebuild doesn't re-warn (REPL-1).
      this._replaced.clear();
      // Persist the room bookkeeping the rebuild implied in one save through the authoritative,
      // permission-scoped `sync_rooms` (no new endpoint, no loosened scoping): discard the floors
      // the user agreed to orphan, and remap the rooms of each whole→region split onto their new
      // region floors (FLOOR-5). A reprojection's cleared source key is pruned by `saveAnnotations`,
      // so its old rows are swept by `sync_rooms`' facility-scoped cross-floor delete; the moved
      // rooms keep their id and Location binding, upserted under the region floor's key.
      if (orphaned.length || reprojections.length) {
        for (const o of orphaned) delete this.app.store.annotations[o.key];
        for (const rp of reprojections) this.diff.applyReprojection(rp);
        try { await this.app.store.saveAnnotations(); } catch (_) { /* best effort cleanup */ }
      }
      // Re-fit the siteplan hotspots the user opted into (IMPORT-11), now that the rebuilt manifest
      // carries the new image's real dimensions — more authoritative than the pre-build preview
      // measurement, which is kept only as the fallback.
      const refitted = refit ? await this.diff.applySiteplanRefit(refit) : null;
      // Warn when any imported data overlay is still placed by the approximate fit-to-bounds
      // default rather than a control-point georeference (FMT-6): a transient heads-up pointing
      // at the align editor, not a blocking confirm (the overlay is wanted either way). Drives
      // off the manifest `georeferenced` flag (`!== true`, so a manifest predating the field
      // reads as approximate); an all-aligned rebuild suppresses it with no extra logic.
      const approxOverlays = (this.app.store.manifest.buildings || []).some(
        b => (b.floors || []).some(f => (f.overlays || []).some(ov => ov.georeferenced !== true)));
      // Placement panels only show gear NetBox has assigned to a room's own Location, but most
      // installs model racks/devices a level up (Site/building/floor) — so a fresh import's
      // panels read as empty until the user learns this, one room at a time, from the per-room
      // empty-state hint (`FloorEditor.openRackPanel`). Say it once, here, up front. Phrasing
      // mirrors that hint's "Bind this room to a NetBox Location (in Edit mode)" so the two read
      // as one consistent story; this only points forward to the edit-mode workflow — binding
      // isn't possible from inside the wizard itself.
      let msg = 'Facility imported. Bind each room to a NetBox Location (in Edit mode), then '
        + 'assign racks/devices to that Location in NetBox before placing them.';
      if (approxOverlays) {
        msg += ' Data overlays are placed by an approximate fit — to georeference one, open its '
          + 'drawing card in Edit buildings & floors and use “Align on plan…”.';
      }
      // Fold in the build's render diagnostics (HEALTH-3). `unrendered` is a real problem — a
      // dropped drawing, possibly memory on a small host — so it flips the toast to its warning
      // style; `hq_clamped` is informational (a large plan capped just below full high quality by
      // the fixed size limit — raising render_mem_mb won't lift it, and the plan still rendered).
      // Single toast: `Toast.show` reuses one element, so a second call would clobber this one.
      const n = r.unrendered || 0;
      if (n) {
        msg += ' ' + n + (n === 1 ? ' drawing' : ' drawings') + " couldn't be rendered and "
          + (n === 1 ? 'was' : 'were') + ' skipped — check the source file'
          + (n === 1 ? '' : 's') + ', and on a low-memory host raising render_mem_mb may help.';
      }
      const c = r.hq_clamped || 0;
      if (c) {
        msg += ' ' + c + (c === 1 ? ' large plan' : ' large plans') + ' rendered just below full '
          + 'high quality (reached the built-in size cap).';
      }
      // A completed re-fit moved user geometry, so its notice carries an Undo button — the UX-17
      // idiom `Editor._deleteToast` uses for the app's other instant-but-reversible writes. The
      // wizard lands on the siteplan itself, so the user is looking at the re-fitted hotspots while
      // the button is up. The action toast replaces the plain one (a second call would clobber it),
      // winning over the `err` styling of a render diagnostic — the reversible data change is the
      // more urgent thing to surface, and every diagnostic is folded into `msg` either way.
      if (refitted) msg += refitted.note;
      if (refitted && refitted.undo) Toast.action(msg, 'Undo re-fit', refitted.undo);
      else Toast.show(msg, n > 0 || !!refitted);
      this.app.go('#/');
  }

  /** The destructive "Start over" (reset) button, or `null` when the user may not reset — reset
   *  is superuser-only and server-enforced (imports.ResetView / `App.canReset`). Callers drop it
   *  into an `imp-actions` row, whose `Dom.el` render skips a null child, so no reset control
   *  appears for a non-superuser importer. */
  _startOver() {
    return this.app.canReset
      ? Dom.el('button', { onclick: () => this._reset() }, 'Start over')
      : null;
  }

  async _reset() {
    // Wiping the working dir out from under a live upload strands a half-written tree (and
    // `ResetView` holds the render lock, so it would fail anyway) — IMPORT-30. A scan in flight is
    // the same hazard from the other side (IMPORT-47): `ResetView` takes the very lock the scan
    // holds, so this would 409 with the server's raw wording on a button the user was invited to
    // press. "Start over" is built by every step, so it is guarded here rather than in
    // `_setUploadPhase` — through the same `busyGate` decision those disabled controls read, so the
    // refusal can't say something different from what the upload step is showing.
    const gate = ImportFlow.busyGate({ phase: this.uploader.phase, scanBusy: this.scanBusy });
    if (gate.busy) { Toast.show(gate.message, true); return; }
    if (!confirm('Clear the uploaded drawings and start the import over? This does not change the '
      + 'facility grouping or NetBox organization settings — those are install-wide and survive a '
      + 'reset; change them from the Facility layout step (or Settings) if needed.')) return;
    try {
      await Api.post('/api/import/reset', {});
    } catch (e) {
      // Reset is superuser-only; surface a refusal (or any failure) instead of wiping the
      // local wizard state as if it had succeeded.
      Toast.show('Could not reset the import: ' + e.message, true);
      return;
    }
    this.inv = null; this.buildings = []; this.site = { folder: '', file: '' };
    this._bIdx = 0;
    this._autoMapDone = false;
    this.organize.reset();
    this.ocr.reset();     // the previews its reads came from are gone with the working dir
    this._codeRegion = null;
    this._siteplanStepDone = false;
    this._regionZoom.z = 1;
    this._mergeMode = false;
    // The old drawings are gone, so a replace tracked against their bytes is no longer evidence of
    // anything (IMPORT-36) — same rationale as `organize.reset()` above. The campus pick is
    // per-facility draft state that `ResetView` just deleted along with the draft/manifest it would
    // otherwise be restored from, so it goes too (unlike the install-wide grouping/org settings the
    // confirm copy above promises survive).
    this._replaced.clear();
    this.campus = null;
    this._campusPromptDone = false;
    this._stepUpload();
  }
}
