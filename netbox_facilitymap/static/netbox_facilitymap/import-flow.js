'use strict';
/* import-flow.js — ImportFlow: the shared base for the in-app "import a facility from PDFs"
   flows. It owns everything both flows share — the step-rendering machinery (upload, bind,
   code-region + region-split editors, floor mapping), draft persistence, the pre-build
   room-safety diff, floor resolution, and the build — and defers only the handful of genuine
   divergence points to subclass hooks (`_resume`, `_onScanError`, `_buildingsActions`).

   Two subclasses specialize it (like Editor → FloorEditor/SiteplanEditor):
     • FreshImportFlow  — the linear first-time import: grouping → upload → bind → code-region →
                          siteplan → map floors → build.
     • EditImportFlow   — the non-linear edit hub for revising an already-built facility
                          (Settings → "Edit buildings & floors").
   App.showImport() picks the subclass by store.hasContent() (a built facility → edit hub).

   Whichever flow drives, the PDFs carry no text layer, so floor identity is assigned here, not
   inferred. Mount-aware: file uploads and thumbnail/PDF previews resolve against window.MAP
   (api/media), and uploads carry the session CSRF token; scan/build/reset ride the shared
   Api.post wrapper (which rebases /api/* and adds CSRF). */

class ImportFlow {
  static HIRES_AT = 260;   // card width (px) at/above which the size slider upgrades to hi-res
  // Location fields the floor-label picker may choose between (value -> option text). Matches
  // the fixed set `frontend_api._trim` exposes for a Location, so a floor's label is always one
  // of these three known JSON keys, never an arbitrary attribute.
  static LABEL_FIELDS = [
    ['name', 'Location name'], ['slug', 'Location slug'], ['description', 'Location description'],
  ];

  constructor(app) {
    this.app = app;
    this.inv = null;        // scan inventory { folders:[{folder, pdfs:[...]}] }
    this.buildings = [];    // per-folder editable model (see _modelFromInventory)
    this.site = { folder: '', file: '' };  // chosen siteplan PDF (or empty = none)
    this.thumbWidth = 480;  // map-step card width (px); the size slider drives it (its centred default)
    this._bIdx = 0;         // index of the building currently visible in the map step
    this._autoMapDone = false;  // the building→NetBox auto-match pass runs once per scan
    // Floor assignment shows a cropped close-up of each drawing's identifying code so floors
    // are recognizable at a glance. `_codeRegion` is the normalized 0..1 box the user drags
    // over that code on a sample drawing, applied as a crop to every drawing (a building can
    // override it with its own `codeRegion` when its title block sits elsewhere). A null region
    // falls back to full-drawing thumbnails. `_codeRegionDone` gates the pick step (the user
    // either marks a region or skips it). Both persist in the draft.
    this._codeRegion = null;
    this._codeRegionDone = false;
    // The site plan is chosen in its own step before floor assignment (it has no floor code).
    // `_siteplanDone` gates that step (persisted) so it's shown once; `_regionZoom` is the
    // transient zoom factor for the code region picker (a view aid, not persisted).
    this._siteplanDone = false;
    this._regionZoom = 1;
    // Which Location field a Location-mode floor's label is drawn from (see LABEL_FIELDS).
    // Defaults to the server's `floor_label_field` PLUGINS_CONFIG setting; re-validated against
    // the known field set (never trust window.MAP blindly) and persisted in the draft.
    const mapField = window.MAP && window.MAP.floorLabelField;
    this._floorLabelField = ImportFlow.LABEL_FIELDS.some(([f]) => f === mapField)
      ? mapField : 'name';
    // Add-drawings flow: when true the upload step merges new PDFs into the current model
    // (re-applying the saved draft so existing assignments survive) instead of starting fresh.
    this._mergeMode = false;
    // File ingestion + upload live in ImportUploader (needs a back-ref for progress + the
    // post-upload routing); image zoom/pan + lightbox live in the static ImportPreview.
    this.uploader = new ImportUploader(this);
  }

  // ---- helpers ----
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

  /** A persisted floor `assign` is trustworthy only if it's an object carrying a string `type`
   *  (what `_resolveFloors`/`_cardUnassigned` read). Used to drop a malformed entry on draft
   *  resume so it degrades to the model default instead of throwing mid-render. */
  static _validAssign(a) {
    return !!a && typeof a === 'object' && typeof a.type === 'string';
  }

  /** A persisted region-split entry is `{ box:{x,y,w,h}, assign }`; validate the box numerics and
   *  the nested assign so a corrupt draft can't strand `_stepSplitRegions`/`_resolveFloors`. */
  static _validRegion(r) {
    const box = r && r.box;
    return !!box && ['x', 'y', 'w', 'h'].every(k => typeof box[k] === 'number')
      && ImportFlow._validAssign(r.assign);
  }

  /** Render a fresh `#stage` view with the step title. `stepKey` (one of a flow's linear step
   *  ids, or undefined for a detour/transient screen) is handed to the `_chrome` hook so a flow
   *  can prepend step chrome — a progress stepper (fresh) or a header (edit) — above the title. */
  _stage(title, stepKey) {
    this.app.current = null;
    this.app.crumbs([{ label: 'Siteplan', hash: '/' }, { label: 'Import' }]);
    this.app.setToolbar([]);
    const stage = Dom.$('#stage'); stage.innerHTML = '';
    const children = [Dom.el('h2', {}, title)];
    const chrome = this._chrome(stepKey);
    if (chrome) children.unshift(chrome);
    const view = Dom.el('div', { class: 'import-view' }, children);
    stage.append(view);
    return view;
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

  async show() {
    // Probe for an in-progress import (existing uploads). The scan also regenerates
    // thumbnails so the map step's cards are ready when we jump straight to it.
    const loadView = this._stage('Import a facility');
    loadView.append(Dom.el('p', { class: 'imp-progress' }, 'Checking for existing uploads…'));
    let inv;
    try {
      inv = await Api.post('/api/import/scan', {});
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

  /** A brand-new import opens with the install-wide grouping question (Site Group vs Region,
   *  MULTI-3) before the first upload. Shared by both flows: a fresh open with no existing
   *  uploads starts here regardless of which flow is driving (the edit hub reaches grouping from
   *  its own row instead). */
  _freshStart() {
    this._stepGrouping(() => this._stepUpload());
  }

  // ---- subclass hooks (the only fresh-vs-edit divergence; see FreshImportFlow/EditImportFlow) ----

  /** Where `show()` routes when a scan finds existing uploads. */
  _resume() { throw new Error('ImportFlow._resume is abstract'); }
  /** Where `show()` routes when the scan itself throws (degrade without faking a fresh install). */
  _onScanError(_e) { throw new Error('ImportFlow._onScanError is abstract'); }
  /** The bind step's (`_stepBuildings`) action row — fresh keeps the linear "Continue to floor
   *  mapping"; edit offers "Save & back to hub". */
  _buildingsActions(_focusBuilding) { throw new Error('ImportFlow._buildingsActions is abstract'); }

  /** Ask which NetBox grouping identifies a *facility* (MULTI-3) — an install-wide choice the
   *  facility picker resolves against: a `dcim.SiteGroup` (the default) or a `dcim.Region`. Shown
   *  as the first step of a fresh import and re-editable from the hub; `next` is where Continue
   *  routes (the upload step, or back to the hub). Persists via the import-gated facilities POST
   *  and updates the live `app.grouping` so the picker reflects it without a reload. */
  _stepGrouping(next) {
    const view = this._stage('How is your facility organized?', 'grouping');
    view.append(Dom.el('p', { class: 'hint' },
      'A “facility” is one campus or site you map on its own. Pick which NetBox grouping names a '
      + 'facility. The choice applies to the whole install and drives the facility picker. Most '
      + 'installs use Site Group.'));

    let chosen = this.app.grouping;
    const cards = [];
    const opts = [
      ['sitegroup', 'Site Group',
        'Sites grouped organizationally or functionally (dcim.SiteGroup). The default.'],
      ['region', 'Region',
        'Sites grouped geographically by country, campus, or building cluster (dcim.Region).'],
    ];
    for (const [value, title, desc] of opts) {
      const radio = Dom.el('input', { type: 'radio', name: 'imp-grouping', value });
      if (value === chosen) radio.checked = true;
      const card = Dom.el('label',
        { class: 'imp-bind imp-grouping-opt' + (value === chosen ? ' selected' : '') }, [
          Dom.el('div', { class: 'imp-bind-head' }, [
            radio, Dom.el('span', { class: 'imp-bind-folder' }, title),
          ]),
          Dom.el('div', { class: 'imp-hub-meta' }, desc),
        ]);
      radio.addEventListener('change', () => {
        chosen = value;
        cards.forEach(c => c.classList.toggle('selected', c === card));
      });
      cards.push(card);
      view.append(card);
    }

    const cont = Dom.el('button', { class: 'primary', onclick: async () => {
      // Changing the grouping on a populated install re-scopes which facility each Site resolves to,
      // so existing map data can end up orphaned under the old key (HEALTH-1). Warn + confirm before
      // the change (the server enforces the same gate via a 409 unless `confirm` is passed), and
      // point at the Settings reassignment that recovers anything that does get stranded.
      const changing = chosen !== this.app.grouping;
      if (changing && this.app.store.hasContent() && !window.confirm(
        'Changing the facility grouping re-scopes your existing map data. Floors, rooms, and '
        + 'placements may become unassigned and disappear from the map until you reassign them '
        + 'from the Settings page. Change the grouping anyway?')) {
        return;
      }
      cont.disabled = true;
      try {
        await this.app.netbox.setGrouping(chosen, changing);
        this.app.grouping = chosen;
      } catch (e) {
        cont.disabled = false;
        return Toast.show('Could not save grouping: ' + e.message, true);
      }
      next();
    } }, 'Continue');
    view.append(Dom.el('div', { class: 'imp-actions' }, [cont]));
  }

  // ---- step 1: upload ----
  _stepUpload() {
    // In merge mode the upload step is a detour off the map (add drawings), not the linear step —
    // no stepper and no linear back-nav (a plain Cancel returns to the map instead).
    const view = this._stage(this._mergeMode ? 'Add drawings' : 'Import a facility',
      this._mergeMode ? undefined : 'upload');

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

    const drop = Dom.el('div', { class: 'imp-drop', onclick: () => folderInput.click() }, [
      Dom.el('div', { class: 'imp-drop-big' }, 'Drop or click to choose a facility folder'),
    ]);
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
    view.append(Dom.el('div', { class: 'imp-drop-alt' }, [
      Dom.el('span', { class: 'hint' }, 'Have a .zip of your drawings? '),
      Dom.el('button', { class: 'imp-link', onclick: () => zipInput.click() }, 'Choose a .zip file'),
    ]));
    this._progress = Dom.el('div', { class: 'imp-progress hidden' });
    view.append(this._progress);
    // Guidance panel, shown by `_ingest` when a selection has no importable drawing but does carry
    // 3D BIM/Revit files (see `_showBimGuidance`).
    this._uploadNote = Dom.el('div', { class: 'imp-bim-note hidden' });
    view.append(this._uploadNote);
    const cont = this._mergeMode
      ? Dom.el('button', { class: 'primary', onclick: () => this._mergeUploads() }, 'Done adding')
      : Dom.el('button', { class: 'primary', onclick: () => this._scanAndMap() }, 'Continue to mapping');
    const back = this._mergeMode
      ? Dom.el('button', { onclick: () => { this._mergeMode = false; this._stepMap(); } }, 'Cancel')
      : this._startOver();
    // Linear back to the grouping step (fresh, non-merge only — null in merge mode / edit).
    const linBack = this._mergeMode ? null : this._backButton('upload');
    view.append(Dom.el('div', { class: 'imp-actions' }, [linBack, cont, back]));
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
      const inv = await Api.post('/api/import/scan', {});
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
    await this._saveDraft();
    this._mergeMode = true;
    this._stepUpload();
  }

  /** Finish an add-drawings upload: re-scan, rebuild the model, and re-apply the saved draft so
   *  prior assignments survive (unlike `_scanAndMap`, which starts fresh). New folders surface
   *  unbound in the binding step, which auto-skips back to the map once everything is bound. */
  async _mergeUploads() {
    try {
      const inv = await Api.post('/api/import/scan', {});
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
    return Array.from({ length: n }, (_, i) => ({
      file: p.file, pdf: p.pdf, stem: p.stem + '#p' + (i + 1), page: i + 1, thumb: null,
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
        // null = unbound. Its slug overwrites `slug` so it flows downstream as `siteSlug`.
        nbSite: null,
        // NetBox floor Locations for the building's bound site, lazily fetched in the map
        // step so floors can be picked as buttons. undefined = not fetched, 'loading' = in
        // flight, array = done (empty array = fall back to the floor-type buttons).
        nbFloors: undefined,
        // Per-PDF floor assignment. `token` (a NetBox Location slug) takes precedence over
        // `type`/`num`; when set, the build emits the slug verbatim as the floor id (see
        // `_resolveFloors`/`_build`).
        assign: Object.fromEntries(pdfs.map((p, i) =>
          [p.stem, isSite ? { type: 'none', num: 1, token: null, label: '' }
            : { type: 'level', num: i + 1, token: null, label: '' }])),
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

  /** True once every floor-contributing building is bound to a NetBox site. */
  _allBuildingsBound() {
    return this._floorBuildings().every(b => b.nbSite);
  }

  /** True when every uploaded drawing sits in a single building folder — the shape a flat,
   *  unsorted pile of drawings lands in (one `uploads/<folder>/` bucket, since `ImportUploader.split`
   *  routes an unsubfoldered selection into one building). The signal for offering the in-wizard
   *  building split (`_stepAssignBuildings`) on the bind step. */
  _isSingleBuildingImport() {
    return this.buildings.length === 1;
  }

  /** Bind a building to a NetBox site: store its identity and prefill name/slug/abbr from it
   *  so the slug flows downstream as the manifest `siteSlug`. `auto` flags an unconfirmed
   *  auto-match (the operator reviews it in the step). */
  _bindSite(b, site, auto) {
    b.nbSite = { id: site.id, slug: site.slug, name: site.name, auto: !!auto };
    b.slug = site.slug;
    b.name = site.name;
    b.abbr = ImportFlow.initials(site.name);
  }

  /** Try to auto-match each still-unbound building to a NetBox site by name/slug. Runs once
   *  per scan (guarded by `_autoMapDone`). Accept only a confident match — a site whose slug
   *  equals the folder-derived slug, or whose name matches, or a lone search result — and
   *  flag it `auto` so the operator confirms it. Ambiguous folders stay unbound for manual
   *  binding. */
  async _autoMapBuildings() {
    if (this._autoMapDone) return;
    this._autoMapDone = true;
    for (const b of this._floorBuildings()) {
      if (b.nbSite) continue;
      let res;
      try { res = await this.app.netbox.sites(b.name); } catch (_) { continue; }
      const sites = res.sites || [];
      const nameLc = b.name.toLowerCase();
      const match = sites.find(s => s.slug === b.slug)
        || sites.find(s => s.name.toLowerCase() === nameLc)
        || (sites.length === 1 ? sites[0] : null);
      if (match) this._bindSite(b, match, true);
    }
  }

  /** Bind every floor-contributing building to a NetBox site. When the edit hub jumps here to fix
   *  one building, `focusBuilding` scrolls that bind row into view and highlights it, so the user
   *  lands on the row they came to change instead of the top of the list. The action row itself is
   *  the `_buildingsActions(focusBuilding)` hook — fresh keeps the linear **Continue to floor
   *  mapping →** (gated on every building being bound) + **Start over**; edit offers **Save & back
   *  to hub** / **← Back to hub** so a one-off re-bind returns where it came from. */
  async _stepBuildings(focusBuilding) {
    const buildings = this._floorBuildings();
    if (!buildings.length) return this._stepMap();   // siteplan-only import — nothing to bind

    const view = this._stage('Map buildings to NetBox', 'bind');
    view.append(Dom.el('p', { class: 'hint' }, 'Bind each building to its NetBox site.'));

    if (!this._autoMapDone) {
      view.append(Dom.el('p', { class: 'imp-progress' }, 'Matching buildings to NetBox…'));
      await this._autoMapBuildings();
      return this._stepBuildings(focusBuilding);   // re-render with the auto-match results
    }

    // A flat, unsorted pile of drawings all lands in one building folder. Offer to split it into
    // several buildings — the user assigns each drawing and the files are physically regrouped
    // (IMPORT-3), the in-app path for an import that wasn't organized one-subfolder-per-building.
    // Placed before binding, since regrouping re-identifies the buildings (and discards bindings).
    if (this._isSingleBuildingImport())
      view.append(Dom.el('section', { class: 'imp-split-note' }, [
        Dom.el('span', { class: 'hint' },
          'All your drawings are in one building. If they belong to different buildings, split '
          + 'them so each maps to its own NetBox site.'),
        Dom.el('button', { onclick: () => this._stepAssignBuildings() }, 'Split into buildings'),
      ]));

    let focusRow = null;
    for (const b of buildings) {
      const row = this._bindRow(b);
      if (b === focusBuilding) { row.classList.add('focus'); focusRow = row; }
      view.append(row);
    }
    if (focusRow) focusRow.scrollIntoView({ block: 'center' });

    view.append(this._buildingsActions(focusBuilding));
  }

  /** One building's bind control: its current state plus a site-search autocomplete. */
  _bindRow(b) {
    const state = Dom.el('div', { class: 'imp-bind-state' });
    if (b.nbSite && b.nbSite.auto)
      state.append(Dom.el('span', { class: 'imp-bind-auto' },
        '✓ auto-matched → ' + b.nbSite.name + ' (' + b.nbSite.slug + '). Confirm or change.'));
    else if (b.nbSite)
      state.append(Dom.el('span', { class: 'imp-bind-ok' },
        '✓ ' + b.nbSite.name + ' (' + b.nbSite.slug + ')'));
    else
      state.append(Dom.el('span', { class: 'imp-bind-warn' },
        '⚠ not bound: pick a NetBox site'));

    const search = Dom.el('input', { placeholder: 'Search NetBox sites…' });
    const list = Dom.el('div', { class: 'imp-bind-list' });
    let token = 0;
    const run = async (q) => {
      const mine = ++token;
      let res;
      try { res = await this.app.netbox.sites(q); } catch (_) { return; }
      if (mine !== token) return;   // a newer keystroke superseded this fetch
      list.innerHTML = '';
      const sites = res.sites || [];
      if (!sites.length) { list.append(Dom.el('div', { class: 'hint' }, 'No sites found.')); return; }
      for (const s of sites) {
        const isThis = b.nbSite && b.nbSite.slug === s.slug;
        const item = Dom.el('div', { class: 'room-item' + (isThis ? ' bound' : '') }, [
          Dom.el('div', { class: 'nm' }, s.name + (isThis ? '  ✓' : '')),
          Dom.el('div', { class: 'sl' }, s.slug),
        ]);
        item.onclick = () => { this._bindSite(b, s, false); this._stepBuildings(); };
        list.append(item);
      }
    };
    search.addEventListener('input', () => run(search.value));

    return Dom.el('section', { class: 'imp-bind' }, [
      Dom.el('div', { class: 'imp-bind-head' }, [
        Dom.el('div', { class: 'imp-bind-folder' }, b.folder), state,
      ]),
      search, list,
    ]);
  }

  // ---- step 1.4: split a flat pile of drawings into buildings ----

  /** Assign each drawing of a single, unsorted building folder to a building of its own, then
   *  physically regroup the files server-side (IMPORT-3). Reached from `_stepBuildings` when the
   *  whole import landed in one folder (a flat pile). The user names buildings and picks one per
   *  drawing; **Continue** moves the files into per-building folders (`_regroup`) and returns to the
   *  bind step, where each new building binds to its own NetBox site. Assignment is per **physical
   *  file** — a multi-page PDF is several page rows in `pdfs` but one file on disk, so it moves as a
   *  unit. Assignments are ephemeral (nothing is written until Continue; the folder-keyed model is
   *  rebuilt from the re-scan afterwards). */
  _stepAssignBuildings() {
    const source = this.buildings[0];
    if (!source) return this._stepBuildings();
    // One assignable entry per physical file (dedupe the exploded per-page rows), keeping the
    // first row of each for a representative thumbnail.
    const files = [], rowFor = {};
    for (const p of source.pdfs)
      if (!(p.file in rowFor)) { rowFor[p.file] = p; files.push(p.file); }
    // Buildings default to the current folder verbatim, so "keep them all in one building" is a
    // no-op move (source folder == destination). `assign` maps each file to a building index.
    const groups = [source.folder];
    const assign = Object.fromEntries(files.map(f => [f, 0]));

    const view = this._stage('Organize drawings into buildings');
    view.append(Dom.el('p', { class: 'hint' },
      'These drawings are all in one building. Add a building for each one you want to split out, '
      + 'then assign every drawing to a building. Leave them together if they belong to one.'));

    const grid = Dom.el('div', { class: 'imp-assign-grid' });
    const render = () => { grid.innerHTML = ''; files.forEach(f => grid.append(row(f))); };

    // Building-name manager: a text field + Add. Each name is a destination folder, so reject the
    // path separators `safe_path` would otherwise have to (the server re-checks).
    const nameInput = Dom.el('input', { placeholder: 'New building name' });
    const add = () => {
      const name = nameInput.value.trim();
      if (!name) return;
      if (/[\/\\]/.test(name)) return Toast.show('A building name can’t contain / or \\', true);
      if (groups.includes(name)) return Toast.show('That building already exists', true);
      groups.push(name); nameInput.value = ''; nameInput.focus(); render();
    };
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); add(); } });
    view.append(Dom.el('div', { class: 'imp-assign-add' }, [
      nameInput, Dom.el('button', { onclick: add }, 'Add building'),
    ]));

    const row = (file) => {
      const p = rowFor[file];
      // A single-page drawing has a scan thumbnail; an exploded page row doesn't, so fall back to
      // its on-demand per-page preview (same choice `_pdfCard` makes).
      const src = p.thumb ? ImportFlow._media(p.thumb) : ImportPreview.previewUrl(p.pdf, p.page);
      const thumb = Dom.el('div', { class: 'imp-thumb imp-assign-thumb' },
        [Dom.el('img', { src, loading: 'lazy' })]);
      const sel = Dom.el('select', { onchange: (e) => { assign[file] = parseInt(e.target.value, 10); } },
        groups.map((g, i) => {
          const o = Dom.el('option', { value: String(i) }, g);
          if (assign[file] === i) o.selected = true;
          return o;
        }));
      return Dom.el('div', { class: 'imp-assign-row' }, [
        thumb, Dom.el('span', { class: 'imp-assign-name' }, file), sel,
      ]);
    };
    render();
    view.append(grid);

    const cont = Dom.el('button', { class: 'primary', onclick: () => {
      // Group each building's assigned files into `{ destFolder: [uploads-relative src, ...] }`,
      // dropping empty buildings. Files whose destination equals the source folder don't move.
      const payload = {};
      groups.forEach((name, i) => {
        const picked = files.filter(f => assign[f] === i);
        if (picked.length) payload[name] = picked.map(f => source.folder + '/' + f);
      });
      const dests = Object.keys(payload);
      if (dests.length <= 1 && dests[0] === source.folder) return this._stepBuildings();  // unchanged
      this._regroup(payload);
    } }, 'Continue');
    view.append(Dom.el('div', { class: 'imp-actions' }, [
      cont,
      Dom.el('button', { onclick: () => this._stepBuildings() }, 'Cancel'),
      this._startOver(),
    ]));
  }

  /** Move the assigned drawings into their per-building folders on the server, then re-scan and
   *  rebuild the folder-keyed model. `groups` is `{ destFolder: [uploads-relative src, ...] }`. The
   *  endpoint validates every move before touching a file, so a rejected regroup leaves the pile
   *  intact; on any failure the assignment step is re-shown with the cause toasted. */
  async _regroup(groups) {
    const view = this._stage('Organizing drawings…');
    view.append(Dom.el('p', { class: 'imp-progress' }, 'Moving drawings into buildings…'));
    try {
      await Api.post('/api/import/regroup', { groups });
      const inv = await Api.post('/api/import/scan', {});
      if (!inv.ok) throw new Error(inv.error || 'scan failed');
      this.inv = inv;
    } catch (e) {
      Toast.show('Could not organize drawings: ' + e.message, true);
      return this._stepAssignBuildings();
    }
    this._modelFromInventory();
    this._bIdx = 0;
    this._autoMapDone = false;
    this._stepBuildings();
  }

  // ---- step 2a: mark where each drawing's identifying code sits ----

  /** Before the mapping grid, the user marks the spot on a sample drawing where the
   *  floor-identifying code/caption sits, dragging one box stored normalized 0..1 so it maps
   *  onto every drawing's render. Each floor card then shows a close-up crop of just that spot
   *  (see `_codeCropThumb`), so floors are recognizable at a glance without opening each drawing.
   *  Passing a `building` re-marks just that one — its own `codeRegion` override for an outlier
   *  whose title block sits elsewhere than the global sample. The step is skippable (fall back to
   *  full-drawing thumbnails). */
  _stepRegionPick(building) {
    const scoped = !!building;
    // Sample on a real floor drawing, never the site plan (it's `type:'none'` and has no code).
    const real = (x, pp) => x.assign[pp.stem] && x.assign[pp.stem].type !== 'none';
    const b = building || this.buildings.find(x => x.pdfs && x.pdfs.some(pp => real(x, pp)));
    const p = b && b.pdfs.find(pp => real(b, pp));
    if (!p) {   // no floor drawing to sample
      if (scoped) { Toast.show('No drawing to re-mark in ' + (b.name || b.folder), true); return this._stepMap(); }
      this._codeRegionDone = true; return this._stepMap();   // siteplan-only import: nothing to crop
    }

    const view = this._stage(scoped ? 'Mark ' + (b.name || b.folder) + '’s code' : 'Mark the drawing code',
      scoped ? undefined : 'coderegion');
    view.append(Dom.el('p', { class: 'hint' },
      'Drag a box around the code or caption that identifies each drawing, the part that names '
      + 'the floor (e.g. “SECOND BASEMENT LEVEL (B2)”). Each floor card then shows a close-up of '
      + 'just that spot, so you can tell the floors apart at a glance. Zoom in if it’s small; '
      + 'scroll to pan.'));

    // Zoom widens the canvas inside a scrollable viewport (scroll to pan); the image fills the
    // canvas and the overlay is positioned by % of it, so the box tracks the image at any zoom.
    const img = Dom.el('img', { class: 'imp-region-img', src: ImportPreview.previewUrl(p.pdf, p.page) });
    const sel = Dom.el('div', { class: 'imp-region-sel hidden' });
    const canvas = Dom.el('div', { class: 'imp-region-canvas' }, [img, sel]);
    const viewport = Dom.el('div', { class: 'imp-region-view' }, [canvas]);
    this._attachRegionDrag(img, sel, building);
    view.append(this._regionZoomBar(canvas));
    view.append(viewport);
    this._applyRegionZoom(canvas);

    const use = async () => {
      if (scoped) this._bIdx = Math.max(0, this._mappableBuildings().indexOf(b));   // land back on it
      else this._codeRegionDone = true;
      await this._saveDraft();
      this._stepMap();
    };
    const go = Dom.el('button', { class: 'primary', onclick: use }, 'Use this region');
    go.disabled = !(scoped ? building.codeRegion : this._codeRegion);
    this._regionGo = go;
    // Linear back to the siteplan step (fresh, unscoped only); a scoped re-mark is a detour with
    // its own Cancel, so it gets no linear back.
    const actions = scoped ? [go] : [this._backButton('coderegion'), go];
    if (scoped) {
      // A scoped re-mark refines one building; offer to drop the override — back to the global
      // region when one exists, else to full-drawing thumbnails — and a plain Cancel back to the map.
      if (building.codeRegion)
        actions.push(Dom.el('button', { onclick: async () => {
          building.codeRegion = null; await this._saveDraft(); this._stepMap(); } },
          this._codeRegion ? 'Use the global region' : 'Clear (show full drawing)'));
      actions.push(Dom.el('button', { onclick: () => this._stepMap() }, 'Cancel'));
    } else {
      actions.push(Dom.el('button', { onclick: async () => {
        this._codeRegion = null; this._codeRegionDone = true; await this._saveDraft(); this._stepMap();
      } }, 'Skip (show full drawings)'));
      actions.push(this._startOver());
    }
    view.append(Dom.el('div', { class: 'imp-actions' }, actions));
  }

  /** Drag a selection box over the sample image, storing it normalized 0..1 — on the building's
   *  own `codeRegion` when `building` is given (the per-building override), else the global
   *  `_codeRegion`. The overlay shares the <img>'s box (the image fills it, no letterboxing), so
   *  pointer positions map straight to image space via `getBoundingClientRect()`. */
  _attachRegionDrag(img, sel, building) {
    const get = () => (building ? building.codeRegion : this._codeRegion);
    const set = (r) => { if (building) building.codeRegion = r; else this._codeRegion = r; };
    const draw = (r) => {
      sel.classList.remove('hidden');
      sel.style.left = (r.x * 100) + '%'; sel.style.top = (r.y * 100) + '%';
      sel.style.width = (r.w * 100) + '%'; sel.style.height = (r.h * 100) + '%';
    };
    const cur = get();
    if (cur) draw(cur);
    img.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const rect = img.getBoundingClientRect();
      const nx = (c) => Math.max(0, Math.min(1, (c - rect.left) / rect.width));
      const ny = (c) => Math.max(0, Math.min(1, (c - rect.top) / rect.height));
      const x0 = nx(e.clientX), y0 = ny(e.clientY);
      let pending = null;
      try { img.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      const move = (ev) => {
        const x1 = nx(ev.clientX), y1 = ny(ev.clientY);
        pending = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
        draw(pending);
      };
      const up = () => {
        img.removeEventListener('pointermove', move);
        img.removeEventListener('pointerup', up);
        if (pending && pending.w > 0.005 && pending.h > 0.005) {
          set(pending);
          if (this._regionGo) this._regionGo.disabled = false;
        }
      };
      img.addEventListener('pointermove', move);
      img.addEventListener('pointerup', up);
    });
  }

  /** −/Fit/+ zoom controls for the region picker, so a small floor code can be boxed
   *  accurately. "Fit" resets to fill the viewport width; ± steps the zoom (1×–6×). */
  _regionZoomBar(canvas) {
    const step = (f) => () => {
      this._regionZoom = Math.max(1, Math.min(6, Math.round((this._regionZoom + f) * 10) / 10));
      this._applyRegionZoom(canvas);
    };
    return Dom.el('div', { class: 'imp-region-zoom' }, [
      Dom.el('button', { title: 'Zoom out', onclick: step(-0.5) }, '−'),
      Dom.el('button', { title: 'Fit to width',
        onclick: () => { this._regionZoom = 1; this._applyRegionZoom(canvas); } }, 'Fit'),
      Dom.el('button', { title: 'Zoom in', onclick: step(0.5) }, '+'),
    ]);
  }

  /** Apply the current zoom by widening the canvas; the scrollable viewport handles panning. */
  _applyRegionZoom(canvas) {
    canvas.style.width = (this._regionZoom * 100) + '%';
  }

  // ---- step 2b: split one plan into several floors by region (FLOOR-4) ----

  /** Region-split editor: draw one or more boxes over a single drawing and give each its own
   *  floor, so the page fans into several floors at build (`_resolveFloors` emits the
   *  `[{token, region}]` shape `preprocess._page_entries` consumes). Follows the `_stepRegionPick`
   *  precedent — the drawing sits in a scrollable, zoomable viewport — but supports *several* boxes,
   *  each a floor. The image renders at the card's straightening `angle`, so a box is marked in the
   *  same straightened space the backend crops (crop-after-rotate). Boxes + per-region assignments
   *  live on `b.regions[p.stem]` and persist in the draft. Reached from a card's "Split into
   *  floors…" button; empty the list (Clear all / removing every region) to fall back to one
   *  whole-page floor. */
  _stepSplitRegions(b, p) {
    const view = this._stage('Split ' + p.file + ' into floors');
    view.append(Dom.el('p', { class: 'hint' },
      'Drag a box around each part of this drawing that is its own floor, then assign a floor to '
      + 'each box below. One plan can map to several floors this way (e.g. a split-level sheet). '
      + 'Zoom in if the drawing is dense; scroll to pan.'));

    const deg = (b.angle[p.stem] && b.angle[p.stem].deg) || 0;
    const img = Dom.el('img', { class: 'imp-region-img', src: ImportPreview.previewUrl(p.pdf, p.page, deg) });
    const overlay = Dom.el('div', { class: 'imp-region-overlay' });
    const canvas = Dom.el('div', { class: 'imp-region-canvas' }, [img, overlay]);
    const viewport = Dom.el('div', { class: 'imp-region-view' }, [canvas]);
    const list = Dom.el('div', { class: 'imp-region-list' });

    // Repaint the numbered box overlay + the per-region floor-assignment list from the current
    // model, without rebuilding the image — so an add / remove / floor pick never disturbs the
    // zoom or scroll position.
    const redraw = () => {
      const regions = b.regions[p.stem];
      overlay.innerHTML = '';
      regions.forEach((r, i) => {
        const boxEl = Dom.el('div', { class: 'imp-region-box' }, String(i + 1));
        boxEl.style.left = (r.box.x * 100) + '%'; boxEl.style.top = (r.box.y * 100) + '%';
        boxEl.style.width = (r.box.w * 100) + '%'; boxEl.style.height = (r.box.h * 100) + '%';
        overlay.append(boxEl);
      });
      list.innerHTML = '';
      if (!regions.length) {
        list.append(Dom.el('p', { class: 'hint' }, 'No regions yet — drag a box on the drawing above.'));
        return;
      }
      regions.forEach((r, i) => {
        list.append(Dom.el('div', { class: 'imp-region-row' }, [
          Dom.el('span', { class: 'imp-region-rownum' }, 'Region ' + (i + 1)),
          this._floorButtons(b, r.assign, () => { this._saveDraft(); redraw(); }),
          Dom.el('button', { class: 'imp-floor', onclick: () => {
            regions.splice(i, 1); this._saveDraft(); redraw();
          } }, 'Remove'),
        ]));
      });
    };

    this._attachRegionAdd(img, b, p, redraw);
    view.append(this._regionZoomBar(canvas));
    view.append(viewport);
    view.append(list);
    this._applyRegionZoom(canvas);
    redraw();

    view.append(Dom.el('div', { class: 'imp-actions' }, [
      Dom.el('button', { class: 'primary',
        onclick: async () => { await this._saveDraft(); this._stepMap(); } }, 'Done'),
      Dom.el('button', { onclick: async () => {
        if (b.regions[p.stem].length && !confirm('Remove all regions from this drawing?')) return;
        b.regions[p.stem] = []; await this._saveDraft(); this._stepMap();
      } }, 'Clear all'),
      Dom.el('button', { onclick: () => this._stepMap() }, 'Cancel'),
    ]));
  }

  /** Drag on the split editor's canvas to add a region box (FLOOR-4): a press-drag-release marks a
   *  new normalized 0..1 box, appended to `b.regions[p.stem]` as a fresh `unassigned` floor. Mirrors
   *  `_attachRegionDrag` (the code-crop picker) — a live preview box tracks the drag, and the overlay
   *  shares the <img>'s box so pointer coords map straight to image space via
   *  `getBoundingClientRect()` at any zoom. Too-small drags are ignored so a stray click adds
   *  nothing. `onAdd` repaints the overlay + region list. */
  _attachRegionAdd(img, b, p, onAdd) {
    const preview = Dom.el('div', { class: 'imp-region-sel hidden' });
    img.parentElement.append(preview);
    const draw = (r) => {
      preview.classList.remove('hidden');
      preview.style.left = (r.x * 100) + '%'; preview.style.top = (r.y * 100) + '%';
      preview.style.width = (r.w * 100) + '%'; preview.style.height = (r.h * 100) + '%';
    };
    img.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const rect = img.getBoundingClientRect();
      const nx = (c) => Math.max(0, Math.min(1, (c - rect.left) / rect.width));
      const ny = (c) => Math.max(0, Math.min(1, (c - rect.top) / rect.height));
      const x0 = nx(e.clientX), y0 = ny(e.clientY);
      let pending = null;
      try { img.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      const move = (ev) => {
        const x1 = nx(ev.clientX), y1 = ny(ev.clientY);
        pending = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
        draw(pending);
      };
      const up = () => {
        img.removeEventListener('pointermove', move);
        img.removeEventListener('pointerup', up);
        preview.classList.add('hidden');
        if (pending && pending.w > 0.005 && pending.h > 0.005) {
          b.regions[p.stem].push(
            { box: pending, assign: { type: 'unassigned', num: 1, token: null, label: '' } });
          this._saveDraft();
          onAdd();
        }
      };
      img.addEventListener('pointermove', move);
      img.addEventListener('pointerup', up);
    });
  }

  _stepMap() {
    // Order of the assign phase: pick the site plan first (it has no floor code), then mark the
    // code region (skippable) so the cards can show a close-up crop of each drawing's code.
    if (!this._siteplanDone) return this._stepSiteplan();
    if (!this._codeRegionDone) return this._stepRegionPick();

    const view = this._stage('Map drawings to floors', 'map');
    this._mapView = view;
    this._cards = [];   // {upgrade()} per card — lets the size slider swap in hi-res renders
    // Captured so a floor edit can patch just the touched node in place, rather than re-running
    // `_stepMap()` (which wipes `#stage` and resets the page scroll — IMPORT-2). Cleared here so a
    // siteplan-only render, or one before the section is appended, leaves no stale reference.
    this._buildingSectionEl = null;
    view.append(Dom.el('p', { class: 'hint' }, 'Assign every drawing to a floor.'));

    view.append(this._sizer());
    this._applyThumbSize();
    view.append(this._floorLabelFieldControl());
    view.append(this._siteplanSummary());

    // The carousel pages over floor-mapping buildings only (`_mappableBuildings`), so the
    // chosen site plan / a `Site Plan` folder is never shown as a card asking for a floor.
    // A siteplan-only import has none — the step is just the summary + build actions.
    const buildings = this._mappableBuildings();
    if (buildings.length) {
      this._bIdx = Math.max(0, Math.min(this._bIdx, buildings.length - 1));
      if (buildings.length > 1) view.append(this._buildingNav(buildings));
      const b = buildings[this._bIdx];
      this._ensureFloors(b);   // kick off the NetBox Location fetch for this building (cached)
      this._buildingSectionEl = this._buildingSection(b);
      view.append(this._buildingSectionEl);
      this._applyThumbSize();   // re-apply now cards exist, so a large size upgrades them to hi-res

      // A second nav at the bottom so the user isn't forced back to the top after assigning a
      // building's drawings. Re-rendering rebuilds both bars each switch, keeping them in sync.
      if (buildings.length > 1) view.append(this._buildingNav(buildings));
    }

    this._buildActionsRow = this._buildActions();
    view.append(this._buildActionsRow);
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
   *  for a floor edit that touches the whole building — `_autoNumber` (rewrites every card's
   *  assignment) and `_addFloor` (mutates the shared `nbFloors`, so every sibling card's floor
   *  row must refresh). Swapping only the section leaves the header/summary/nav — and the page
   *  scroll — intact, unlike a full `_stepMap()` (IMPORT-2). `this._cards` is reset since the
   *  rebuilt section re-pushes every current card's hi-res upgrader; `_applyThumbSize` then
   *  re-applies the size / hi-res state and `_refreshBuildActions` re-evaluates the gate. Falls
   *  back to a full render if the section hasn't been captured (defensive — both callers only
   *  fire from within the map step). */
  _rerenderBuildingSection(b) {
    if (!this._buildingSectionEl) return this._stepMap();
    this._cards = [];
    const fresh = this._buildingSection(b);
    this._buildingSectionEl.replaceWith(fresh);
    this._buildingSectionEl = fresh;
    this._applyThumbSize();
    this._refreshBuildActions();
  }

  /** The Build / Add-drawings / Start-over action row. Build is gated until every drawing is
   *  assigned to a floor (no building left with an `unassigned` drawing) and a site-plan image is
   *  chosen; while gated it shows a disabled button + a hint naming what's missing, so the button
   *  never silently vanishes. "Add drawings" (additive upload) and "Start over" stay available
   *  regardless. The label tracks whether this is a fresh import or a re-edit: a facility already
   *  in the store (`hasContent()`, the live store-state that also picks EditImportFlow in
   *  `App.showImport`) means the action regenerates an existing map, so the button reads **Rebuild
   *  map** rather than the from-scratch **Build facility map** — the rebuild itself is identical
   *  either way. */
  _buildActions() {
    const unassigned = this._unassignedBuildings();
    const needSiteplan = !this.site.file;
    const label = this.app.store.hasContent() ? 'Rebuild map' : 'Build facility map';
    // Linear back to the code-region step (fresh only; null in edit → dropped by `Dom.el`).
    const actions = [this._backButton('map')];
    if (unassigned.length || needSiteplan) {
      const blocked = Dom.el('button', { class: 'primary' }, label);
      blocked.disabled = true;
      actions.push(blocked);
      const reasons = [];
      // Name the offending buildings when there are few; a long list is just noise, so past a
      // handful collapse it to a count.
      if (unassigned.length)
        reasons.push(unassigned.length <= 5
          ? 'Unassigned drawings in: ' + unassigned.join(', ') + '.'
          : unassigned.length + ' buildings have unassigned drawings.');
      if (needSiteplan) reasons.push('Pick a siteplan (use “Change” above).');
      actions.push(Dom.el('span', { class: 'hint' }, reasons.join(' ')));
    } else {
      actions.push(Dom.el('button', { class: 'primary', onclick: () => this._build() }, label));
    }
    actions.push(Dom.el('button', { onclick: () => this._addDrawings() }, '+ Add drawings'));
    actions.push(this._startOver());
    return Dom.el('div', { class: 'imp-actions' }, actions);
  }

  /** Building paging: ← Previous / Next → with a building dropdown that jumps straight to any
   *  building (in place of a "Building N of M" label). Navigating — via the buttons or the
   *  select — saves the draft, sets `_bIdx`, and re-renders. `buildings` is the filtered carousel
   *  list (`_mappableBuildings`) that `_bIdx` indexes, so the option values and bounds exclude the
   *  site plan. Factored into a helper so it can be reused. */
  _buildingNav(buildings) {
    const nav = Dom.el('div', { class: 'imp-nav' });
    const prev = Dom.el('button', { onclick: async () => { await this._saveDraft(); this._bIdx--; this._stepMap(); } }, '← Previous');
    const next = Dom.el('button', { onclick: async () => { await this._saveDraft(); this._bIdx++; this._stepMap(); } }, 'Next →');
    prev.disabled = this._bIdx === 0;
    next.disabled = this._bIdx === buildings.length - 1;
    const sel = Dom.el('select', { class: 'imp-nav-select', onchange: async (e) => {
      await this._saveDraft(); this._bIdx = parseInt(e.target.value, 10); this._stepMap();
    } }, buildings.map((b, i) => Dom.el('option', { value: String(i) }, b.name || b.folder)));
    sel.value = String(this._bIdx);   // mark the current building once the options are attached
    nav.append(prev, sel, next);
    return nav;
  }

  /** Lazily fetch a building's NetBox floor Locations so the per-card floor selector can offer
   *  them as buttons. Cached on `b.nbFloors`; on completion the map step re-renders if this
   *  building is still the visible one. A blank slug or empty result leaves `b.nbFloors = []`,
   *  which drives the floor-type fallback. */
  _ensureFloors(b) {
    if (b.nbFloors !== undefined) return;
    this._loadFloors(b).then(() => {
      if (this._mapView && this._mappableBuildings()[this._bIdx] === b) this._stepMap();
    });
  }

  /** Fetch and cache a building's NetBox floor Locations (idempotent). Resolves once
   *  `b.nbFloors` is settled to an array — empty when unbound or the site has none (driving the
   *  floor-type fallback). Driven by the lazy per-building load (`_ensureFloors`) when the map
   *  step shows the building. */
  async _loadFloors(b) {
    if (Array.isArray(b.nbFloors)) return;   // already loaded
    const slug = (b.slug || '').trim();
    if (!slug) { b.nbFloors = []; return; }
    b.nbFloors = 'loading';
    // The building Location is named after the bound NetBox site, so match on that (not the
    // user-editable `b.name`); fall back to `b.name` when unbound.
    const siteName = (b.nbSite && b.nbSite.name) || b.name;
    let floors = [];
    try {
      const res = await this.app.netbox.locations(slug);
      const locs = res.rooms || [];
      floors = this._mergeAssignedFloors(b, this._floorsFromLocations(locs, siteName), locs);
    } catch (_) { floors = []; }
    b.nbFloors = floors;
    if (floors.length) this._normalizeToLocations(b);
  }

  /** Re-include any Location a drawing is already assigned to (`assign[*].token`) that the floor
   *  heuristic didn't surface — i.e. a floor the user added via `_addFloor`'s Location search in a
   *  prior session. Assignments persist in the draft but `nbFloors` is rebuilt each load, so
   *  without this an added floor would lose its button (and its sibling drawings couldn't pick it).
   *  Looks the token up in the full site Location list so the button reappears with its real
   *  name/slug; a token whose Location no longer exists is left out (the user redoes it). Keeps the
   *  natural sort order. */
  _mergeAssignedFloors(b, floors, locs) {
    const have = new Set(floors.map(f => f.slug));
    const bySlug = new Map(locs.map(l => [l.slug, l]));
    for (const p of b.pdfs) {
      const tok = b.assign[p.stem] && b.assign[p.stem].token;
      if (!tok || have.has(tok)) continue;
      const loc = bySlug.get(tok);
      if (!loc) continue;
      have.add(tok); floors.push(loc);
    }
    return floors.sort((x, y) => (x.name || '').localeCompare(y.name || '', undefined, { numeric: true }));
  }

  /** Pick the floor Locations out of a site's flat Location list using the parent tree. The
   *  building Location is the root named after the bound site (e.g. "MAIN BUILDING"); its
   *  children are floors. Any OTHER root is itself a floor — some sites park a floor like
   *  "Roof" or "Level B2" at the top level, as a sibling of the building. When no root matches
   *  the site name the site has no building wrapper and the roots themselves are the floors
   *  (e.g. ANNEX). Identifying the building by name — not by tree shape — works even when the
   *  floors have no rooms under them yet; `depth`/`level` is avoided (MPTT-only, unreliable on
   *  NetBox 4.2+). Floors are sorted by name for a stable, natural order (B1, B2, G, …, Roof). */
  _floorsFromLocations(locs, siteName) {
    const ids = new Set(locs.map(l => l.id));
    const roots = locs.filter(l => l.parent == null || !ids.has(l.parent));
    const nameLc = (siteName || '').trim().toLowerCase();
    const building = nameLc
      ? roots.find(r => (r.name || '').trim().toLowerCase() === nameLc) : null;
    const floors = roots.filter(r => r !== building);
    if (building) for (const l of locs) if (l.parent === building.id) floors.push(l);
    return floors.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }));
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

  /** Picker for which Location field a Location-mode floor's card label is drawn from (see
   *  `LABEL_FIELDS`). Applies to the whole import, not per-building — changing it just
   *  re-renders the map step; the actual label string is resolved fresh at `_build()` time, so
   *  switching this after floors are already assigned needs no re-clicking. A no-op for a
   *  building using the floor-type fallback (no bound Locations), so it's shown unconditionally
   *  rather than only when a building happens to be in Location mode. */
  _floorLabelFieldControl() {
    const sel = Dom.el('select', {
      onchange: async (e) => {
        this._floorLabelField = e.target.value;
        await this._saveDraft();
        this._stepMap();
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

  /** Its own first step in the assign phase: pick which drawing is the site plan. The site plan
   *  is the overall map of where the buildings sit — it carries no floor code, so it's chosen
   *  here, before the code-region pick and floor assignment. */
  _stepSiteplan() {
    const view = this._stage('Select the siteplan', 'siteplan');
    view.append(Dom.el('p', { class: 'hint' },
      'The siteplan is the overall map of the site: the drawing that shows where the buildings '
      + 'sit. It has no floor code, so choose it here first; it’s left out of floor assignment.'));
    view.append(Dom.el('div', { class: 'imp-siteplan' }, [
      Dom.el('label', {}, 'Siteplan image'), this._siteplanSelect(),
    ]));
    view.append(Dom.el('div', { class: 'imp-actions' }, [
      this._backButton('siteplan'),
      Dom.el('button', { class: 'primary', onclick: async () => {
        this._siteplanDone = true; await this._saveDraft(); this._stepMap();
      } }, 'Continue'),
      this._startOver(),
    ]));
  }

  /** The folder/file `<select>` of every uploaded drawing, used by the site-plan step. Choosing
   *  an option routes through `_setSiteplan`, which also excludes the picked drawing from floor
   *  assignment. */
  _siteplanSelect() {
    const sel = Dom.el('select', {
      onchange: (e) => {
        const v = e.target.value;
        if (!v) return this._setSiteplan('', '');
        const [folder, file] = JSON.parse(v); this._setSiteplan(folder, file);
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

  /** Compact, read-only site-plan line shown atop the map step (selection now happens in its own
   *  step). "Change" jumps back to that step. */
  _siteplanSummary() {
    const label = this.site.file ? (this.site.folder + ' / ' + this.site.file) : '(none)';
    return Dom.el('div', { class: 'imp-siteplan' }, [
      Dom.el('span', {}, 'Siteplan: '), Dom.el('strong', {}, label),
      Dom.el('button', { class: 'imp-link', onclick: async () => {
        this._siteplanDone = false; await this._saveDraft(); this._stepMap();
      } }, 'Change'),
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

  /** Boundary validation for a building's editable `name`/`slug`, surfaced inline in the map step
   *  so a problem shows as the user types rather than only as a late build-time toast (the empty-slug
   *  and duplicate-slug guards in `_build` remain the hard safety net). Returns an error string, or
   *  null when the field is fine. `name`: required. `slug`: required, a valid slug charset (lenient
   *  enough never to flag a real bound `Location.slug`), and unique across floor-contributing
   *  buildings (the collision `_build` rejects, caught earlier here). */
  _buildingFieldError(b, key) {
    const v = (b[key] || '').trim();
    if (key === 'name') return v ? null : 'Building name is required.';
    // slug
    if (!v) return 'Site slug is required.';
    if (!/^[-a-zA-Z0-9_]+$/.test(v)) return 'Use letters, numbers, hyphens, and underscores only.';
    if (this._floorBuildings().some(o => o !== b && (o.slug || '').trim() === v))
      return 'Another building already uses this slug.';
    return null;
  }

  _buildingSection(b) {
    const field = (label, key, w) => Dom.el('label', { class: 'imp-field' }, [
      Dom.el('span', {}, label),
      Dom.el('input', { value: b[key], style: 'width:' + w,
        oninput: (e) => { b[key] = e.target.value; } }),
    ]);
    // A validated field (name/slug): the input plus an inline error line that updates as the user
    // types, with the input flagged `.invalid` while a problem stands (see `_buildingFieldError`).
    const vfield = (label, key, w) => {
      const input = Dom.el('input', { value: b[key], style: 'width:' + w });
      const err = Dom.el('span', { class: 'imp-field-err' });
      const validate = () => {
        const msg = this._buildingFieldError(b, key);
        err.textContent = msg || '';
        input.classList.toggle('invalid', !!msg);
      };
      input.addEventListener('input', () => { b[key] = input.value; validate(); });
      validate();
      return Dom.el('label', { class: 'imp-field' }, [Dom.el('span', {}, label), input, err]);
    };
    const fields = [
      vfield('Building name', 'name', '15em'),
      vfield('Site slug', 'slug', '9em'),
    ];
    // In Location mode the floor id must equal the real Location slug, so the floor prefix is
    // forced empty (see `_build`) and the prefix + auto-number controls are hidden; they only
    // apply to the floor-type fallback.
    if (!(Array.isArray(b.nbFloors) && b.nbFloors.length)) {
      fields.push(field('Floor prefix', 'abbr', '6em'));
      fields.push(Dom.el('button', { class: 'imp-auto',
        onclick: () => this._autoNumber(b) }, 'Number floors 1…N'));
    }
    // If the global code box doesn't fit this building (its title block sits elsewhere), offer a
    // re-mark scoped to just it — overrides the crop region for this folder's cards only. Shown
    // whenever the building has a markable drawing (the same `type !== 'none'` test `_stepRegionPick`
    // uses to find a sample), so it's reachable even when the global region pick was skipped.
    const markable = b.pdfs.some(p => b.assign[p.stem] && b.assign[p.stem].type !== 'none');
    if (markable)
      fields.push(Dom.el('button', { class: 'imp-auto',
        onclick: () => this._stepRegionPick(b) }, 'Set this building’s code region'));
    const head = Dom.el('div', { class: 'imp-bhead' }, fields);
    const grid = Dom.el('div', { class: 'imp-grid' });
    for (const p of b.pdfs) grid.append(this._pdfCard(b, p));
    return Dom.el('section', { class: 'imp-building' }, [head, grid]);
  }

  _pdfCard(b, p) {
    const a = b.assign[p.stem];
    // Straightening rotation for this card ({deg} clockwise, mutated in place by the rotate
    // toolbar and read live by the src/lightbox closures below).
    const holder = b.angle[p.stem] || { deg: 0 };
    const deg = holder.deg || 0;
    // A replaced drawing's image is regenerated at the same path, so bust the browser cache
    // (`?v=` for a plain media thumb, `&v=` on a preview URL that already carries a query).
    const rev = (sep) => (p._rev ? sep + 'v=' + p._rev : '');
    const preview = () => ImportPreview.previewUrl(p.pdf, p.page, holder.deg) + rev('&');
    // A code region (global or this building's override) crops every card to a close-up of the
    // drawing's identifying code; without one, fall back to the full-drawing thumbnail. A page row
    // of an exploded multi-page PDF has no scan thumbnail (`p.thumb == null`) — its card image is
    // the per-page `preview` render, so it takes the same paths as a scanned drawing. A **rotated**
    // card skips the crop: the code region was marked on the unrotated drawing, so crop + rotate
    // don't compose — show the full reoriented preview (what the user needs to judge it anyway).
    const region = b.codeRegion || this._codeRegion;
    const hasImage = p.thumb || p.page;
    let card;   // captured so a rotation can re-render just this card (crop↔full, new aspect)
    let thumb;
    if (hasImage && region && !deg) {
      thumb = this._codeCropThumb(p, region);
    } else if (hasImage) {
      // When rotated (or a page row with no scan thumbnail) start on the full preview; otherwise
      // the small scan thumbnail, upgraded to the full render on zoom / when the size slider grows.
      const src = (deg || !p.thumb) ? preview() : ImportFlow._media(p.thumb) + rev('?');
      const img = Dom.el('img', { src, loading: 'lazy' });
      thumb = Dom.el('div', { class: 'imp-thumb' }, [img]);
      let hires = !!deg || !p.thumb;
      const upgrade = () => { if (!hires) { hires = true; img.src = preview(); } };
      this._cards.push({ upgrade });
      ImportPreview.attachZoomPan(thumb, img, b.frame[p.stem],
        { onClick: () => ImportPreview.lightbox(p, holder.deg), onZoom: upgrade });
    } else {
      thumb = Dom.el('div', { class: 'imp-thumb imp-nothumb' }, p.file);
    }
    // Straighten a scanned-rotated drawing before build. Rotating re-renders just this card (its
    // aspect ratio and crop-vs-full choice both change), resets its framing, and saves the draft.
    if (hasImage) {
      thumb.append(ImportPreview.rotateControls(holder, () => {
        // Region-split boxes are marked in the drawing's straightened space (FLOOR-4), so a
        // rotation invalidates them (like it resets the framing below) — clear them, so the
        // natural order is straighten first, then split.
        if (b.regions[p.stem] && b.regions[p.stem].length) b.regions[p.stem] = [];
        b.frame[p.stem] = { scale: 1, x: 0, y: 0 };
        card.replaceWith(card = this._pdfCard(b, p));
        this._saveDraft();
      }));
    }
    // The chosen site plan carries no floor — show a badge instead of the floor selector so it
    // isn't presented as a card asking for a floor. Keyed on the `this.site` match, not merely
    // `type:'none'`, so a card manually set to "— none —" keeps its floor buttons. The siteplan
    // renders page 1 of its file, so for a multi-page PDF only the first page row is the site plan
    // — pages 2..N keep their floor buttons.
    const isSite = this.site.folder === b.folder && this.site.file === p.file
      && (!p.page || p.page === 1);
    // A plain floor click only touches this drawing's assignment, so it patches just this card in
    // place (+ the build gate) rather than re-running `_stepMap()`, which would reset the page
    // scroll (IMPORT-2). Same in-place swap the rotate control uses above; `card` is the `let card`
    // assigned below, so this closure resolves it at click time.
    const rerenderCard = () => {
      card.replaceWith(card = this._pdfCard(b, p));
      this._applyThumbSize();      // keep the hi-res upgrade state at large thumbnail sizes
      this._refreshBuildActions(); // assigning the last unassigned drawing opens the gate
    };
    const floorRow = isSite
      ? Dom.el('div', { class: 'imp-floors' }, Dom.el('span', { class: 'hint' }, 'Siteplan (no floor needed)'))
      : this._floorRow(b, p, a, rerenderCard);
    // A page row of an exploded multi-page PDF shows its page number so several cards from one PDF
    // are distinguishable at a glance.
    const fileParts = [Dom.el('span', { class: 'imp-cardname' }, p.file)];
    if (p.page) fileParts.push(Dom.el('span', { class: 'imp-cardpage' }, 'page ' + p.page));
    fileParts.push(this._replaceControl(b, p));
    const body = Dom.el('div', { class: 'imp-cardbody' }, [
      Dom.el('div', { class: 'imp-cardfile' }, fileParts),
      floorRow,
    ]);
    // Flag a still-unassigned drawing so it stands out in the grid (and in the gated build hint) —
    // region-aware, so a region-split card with an unassigned region is flagged too (FLOOR-4).
    const cls = 'imp-card' + (this._cardUnassigned(b, p) ? ' unassigned' : '');
    card = Dom.el('div', { class: cls }, [thumb, body]);
    return card;
  }

  /** A card thumbnail cropped to just the marked code `region` (normalized 0..1) of the drawing's
   *  full-scale render. The crop is pure CSS: the hi-res preview <img> is widened to `1/region.w`
   *  of the box and translated by `-region.x/-region.y` of its own size, so the region exactly
   *  fills an overflow-clipped box. Those are percentages, so the crop rescales for free when the
   *  size slider changes the card width — only the box's aspect ratio needs the render's intrinsic
   *  size, set once on load. Clicking opens the full drawing in the lightbox — the escape hatch
   *  for an outlier whose code sits outside the marked spot. */
  _codeCropThumb(p, region) {
    const img = Dom.el('img', { class: 'imp-crop-img',
      src: ImportPreview.previewUrl(p.pdf, p.page) + (p._rev ? '&v=' + p._rev : ''), loading: 'lazy' });
    img.style.width = (100 / region.w) + '%';
    img.style.transform = 'translate(' + (-region.x * 100) + '%,' + (-region.y * 100) + '%)';
    const box = Dom.el('div', { class: 'imp-thumb imp-codecrop', title: 'Click to see the whole drawing',
      onclick: () => ImportPreview.lightbox(p) }, [img]);
    const fit = () => {
      const iw = img.naturalWidth, ih = img.naturalHeight;
      if (iw && ih) box.style.aspectRatio = (region.w * iw) + ' / ' + (region.h * ih);
    };
    if (img.complete) fit(); else img.addEventListener('load', fit);
    return box;
  }

  /** Per-drawing "Replace" control: upload a newer drawing for this floor in place. The new bytes
   *  are written to the EXISTING upload path (same folder + filename), so the drawing's stem — and
   *  therefore its floor id and any rooms already drawn on that floor — are preserved. The picker
   *  is pinned to the existing file's extension: the fixed filename keeps the on-disk extension,
   *  and the render dispatches by extension, so a same-format replacement can't desync the two. */
  _replaceControl(b, p) {
    const sameExt = '.' + (p.file.split('.').pop() || '').toLowerCase();
    const input = Dom.el('input', { type: 'file', accept: sameExt, style: 'display:none',
      onchange: (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this._replacePdf(b, p, f); } });
    const btn = Dom.el('button', { class: 'imp-replace',
      title: 'Upload a newer drawing for this floor. Keeps the same floor assignment, so rooms '
        + 'already drawn on it stay.',
      onclick: () => input.click() }, 'Replace');
    return Dom.el('span', { class: 'imp-replace-wrap' }, [btn, input]);
  }

  /** Overwrite one drawing's PDF in place, then re-scan to refresh its thumbnail. The upload path
   *  is fixed to the existing filename (regardless of the picked file's name) so the floor id is
   *  unchanged — id-preserving, so rooms drawn on that floor survive the next build. */
  async _replacePdf(b, p, file) {
    try {
      // Fixed to the existing filename (`p.file`) regardless of the picked file's name, so the
      // stem — and therefore the floor id — is unchanged.
      await ImportUploader.uploadFile(b.folder + '/' + p.file, file, p.file);
      try { const inv = await Api.post('/api/import/scan', {}); if (inv.ok) this.inv = inv; }
      catch (_) { /* the existing thumbnail stays until the next scan */ }
      p._rev = (p._rev || 0) + 1;
      Toast.show('Replaced ' + p.file);
      this._stepMap();
    } catch (e) { Toast.show('Replace failed: ' + e.message, true); }
  }

  /** A non-siteplan card's floor-assignment area. When the drawing is region-split (FLOOR-4) it's a
   *  read-only summary (`_regionSummary`); otherwise the whole-page floor buttons plus an opt-in
   *  "Split into floors…" affordance that opens the split editor. Splitting is per card, so the
   *  common single-floor card is unchanged (just floor buttons + the split link). */
  _floorRow(b, p, a, rerenderCard) {
    if (b.regions[p.stem] && b.regions[p.stem].length) return this._regionSummary(b, p);
    const split = Dom.el('button', { class: 'imp-floor imp-floor-split',
      title: 'Split this one plan into several floors by drawing a box around each',
      onclick: () => this._stepSplitRegions(b, p) }, '⧉ Split into floors…');
    return Dom.el('div', { class: 'imp-floor-row' }, [this._floorButtons(b, a, rerenderCard), split]);
  }

  /** Read-only card summary for a region-split drawing (FLOOR-4): how many floor regions are
   *  defined (flagging any still unassigned), with an Edit-regions jump into the split editor and an
   *  Unsplit that drops back to one whole-page floor. */
  _regionSummary(b, p) {
    const regions = b.regions[p.stem];
    const unassigned = regions.filter(r => r.assign.type === 'unassigned').length;
    const text = regions.length + (regions.length === 1 ? ' floor region' : ' floor regions')
      + (unassigned ? ' · ' + unassigned + ' unassigned' : '');
    return Dom.el('div', { class: 'imp-floors imp-region-summary' }, [
      Dom.el('span', { class: 'imp-region-count' + (unassigned ? ' warn' : '') }, text),
      Dom.el('button', { class: 'imp-floor', onclick: () => this._stepSplitRegions(b, p) }, 'Edit regions'),
      Dom.el('button', { class: 'imp-floor', onclick: () => this._unsplit(b, p) }, 'Unsplit'),
    ]);
  }

  /** Drop a drawing's region-split back to a single whole-page floor (FLOOR-4): clear its region
   *  list so `_resolveFloors` re-emits the scalar token from `assign`. Confirmed first — it discards
   *  the per-region floor assignments. Re-renders the section in place (preserving scroll). */
  _unsplit(b, p) {
    if (b.regions[p.stem].length
        && !confirm('Remove the region split and treat this drawing as one whole-page floor?'))
      return;
    b.regions[p.stem] = [];
    this._saveDraft();
    this._rerenderBuildingSection(b);
  }

  /** Floor selector for one drawing, as a row of buttons. In Location mode (the building's
   *  bound site has floor Locations) it offers one button per Location — clicking writes the
   *  Location slug as the assignment token so the build's floor id equals the real
   *  `Location.slug`. Otherwise it falls back to the floor-type vocabulary
   *  (none/basement/ground/level N/roof). A drawing left `unassigned` (Location mode, no token
   *  yet) is flagged so it stands out and gates the build until the user picks a floor. */
  _floorButtons(b, a, rerender) {
    const row = Dom.el('div', { class: 'imp-floors' });
    if (b.nbFloors === 'loading') {
      row.append(Dom.el('span', { class: 'hint' }, 'Loading floors…'));
      return row;
    }
    if (a.type === 'unassigned')
      row.append(Dom.el('span', { class: 'imp-floor-warn' }, '⚠ pick a floor'));
    const btn = (label, active, onClick) =>
      Dom.el('button', { class: 'imp-floor' + (active ? ' active' : ''), onclick: onClick }, label);
    // "(none)" excludes a drawing from the floor set in either mode.
    row.append(btn('(none)', a.type === 'none' && !a.token, () => {
      a.token = null; a.label = ''; a.type = 'none'; rerender();
    }));
    if (Array.isArray(b.nbFloors) && b.nbFloors.length) {
      for (const loc of b.nbFloors)
        row.append(btn(loc.name, a.token === loc.slug, () => {
          a.token = loc.slug; a.label = loc.name; a.type = 'level'; rerender();
        }));
      // Location mode only: an escape hatch for a floor the auto-detect heuristic missed —
      // search the bound site's Locations and pull one in (see `_floorAddControl`).
      const { toggle, adder } = this._floorAddControl(b, a);
      row.append(toggle);
      return Dom.el('div', { class: 'imp-floor-sel' }, [row, adder]);
    }
    const set = (type, num) => () => {
      a.token = null; a.label = ''; a.type = type; a.num = num; rerender();
    };
    row.append(btn('Basement', a.type === 'basement', set('basement', 1)));
    row.append(btn('Ground', a.type === 'ground', set('ground', 1)));
    for (let i = 1; i <= b.pdfs.length; i++)
      row.append(btn('Level ' + i, a.type === 'level' && a.num === i, set('level', i)));
    row.append(btn('Roof', a.type === 'roof', set('roof', 1)));
    return row;
  }

  /** The "+ Add floor" affordance for Location mode: a toggle button (placed in the floor row)
   *  and the collapsible search panel it reveals. Returns both so `_floorButtons` can put the
   *  button in the row and the panel below it. The panel searches the building's bound site for
   *  Locations (`netbox.locations`, free-text), excluding ones already offered as a floor button,
   *  and reuses the `.room-item` autocomplete markup from `_bindRow`. Picking a result routes
   *  through `_addFloor`. The first time the panel opens it loads the site's full Location list
   *  (so the user can browse) — lazily, so an unopened panel never fetches. */
  _floorAddControl(b, a) {
    const input = Dom.el('input', { placeholder: 'Search NetBox locations…' });
    const list = Dom.el('div', { class: 'imp-bind-list' });
    const adder = Dom.el('div', { class: 'imp-floor-adder hidden' }, [input, list]);
    let seq = 0, loaded = false;
    const run = async (q) => {
      const mine = ++seq;
      let res;
      try { res = await this.app.netbox.locations(b.slug, q); } catch (_) { return; }
      if (mine !== seq) return;   // a newer keystroke superseded this fetch
      const have = new Set(b.nbFloors.map(f => f.slug));
      const hits = (res.rooms || []).filter(l => !have.has(l.slug));
      list.innerHTML = '';
      if (!hits.length) { list.append(Dom.el('div', { class: 'hint' }, 'No other locations found.')); return; }
      for (const loc of hits) {
        const item = Dom.el('div', { class: 'room-item' }, [
          Dom.el('div', { class: 'nm' }, loc.name),
          Dom.el('div', { class: 'sl' }, loc.slug),
        ]);
        item.onclick = async () => { await this._addFloor(b, a, loc); };
        list.append(item);
      }
    };
    input.addEventListener('input', () => run(input.value));
    const toggle = Dom.el('button', { class: 'imp-floor imp-floor-add', onclick: () => {
      const hidden = adder.classList.toggle('hidden');
      if (hidden) return;
      input.focus();
      if (!loaded) { loaded = true; run(''); }   // show the site's locations on first open
    } }, '+ Add floor');
    return { toggle, adder };
  }

  /** Pull a searched Location into the building's floor list and assign this drawing to it.
   *  Dedupes by slug and re-sorts (natural order, matching `_floorsFromLocations`) so it lands
   *  beside the auto-detected floors; the writes to `a` mirror clicking a normal Location button.
   *  Once a drawing references the token it survives a resume — `_loadFloors` rebuilds `nbFloors`
   *  each load but `_mergeAssignedFloors` re-adds floors referenced by a persisted assignment. */
  async _addFloor(b, a, loc) {
    if (!b.nbFloors.some(f => f.slug === loc.slug)) {
      b.nbFloors.push({
        id: loc.id, name: loc.name, slug: loc.slug, description: loc.description,
        parent: loc.parent,
      });
      b.nbFloors.sort((x, y) => (x.name || '').localeCompare(y.name || '', undefined, { numeric: true }));
    }
    a.token = loc.slug; a.label = loc.name; a.type = 'level';
    await this._saveDraft();
    // Adds a floor to the whole building's shared `nbFloors`, so re-render the building section
    // (every sibling card gains the new button) in place, preserving scroll (IMPORT-2).
    this._rerenderBuildingSection(b);
  }

  _autoNumber(b) {
    b.pdfs.forEach((p, i) => { b.assign[p.stem] = { type: 'level', num: i + 1, token: null, label: '' }; });
    // Renumbers every drawing in the building, so re-render the section in place (IMPORT-2).
    this._rerenderBuildingSection(b);
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
        body: JSON.stringify({ buildings: this.buildings, site: this.site,
          codeRegion: this._codeRegion, codeRegionDone: this._codeRegionDone, bIdx: this._bIdx,
          siteplanDone: this._siteplanDone, floorLabelField: this._floorLabelField }),
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
      }
      if (draft.site?.file) this.site = draft.site;
      if (draft.codeRegion) this._codeRegion = draft.codeRegion;
      if (draft.codeRegionDone) this._codeRegionDone = true;
      if (draft.siteplanDone) this._siteplanDone = true;
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

  /** Fill each still-unbound building's NetBox binding from the last-built manifest. The edit
   *  hub derives "bound?" from `b.nbSite`, but only `_applyDraft` repopulates it — a fresh import
   *  that went straight to Build writes no draft, so on reopen every building reads as unbound even
   *  though the manifest (and the read-only map) hold the real binding. Match the scan model to the
   *  manifest by `folder` and synthesize `nbSite` from the persisted `siteSlug`/`name` for any
   *  building the draft left null, so the hub reflects the built state. Runs after `_applyDraft`
   *  and only touches nulls, so an in-progress draft binding still wins; a no-op when nothing is
   *  built yet (empty manifest) or on a manifest built before `folder` was emitted — those correct
   *  on the next rebuild. `nbSite.id` is unused downstream (all logic keys off `slug`/`name`), so a
   *  null id is fine. */
  _reconcileFromManifest() {
    const manifest = this.app.store.manifest;
    if (!manifest || !manifest.buildings) return;
    const byFolder = new Map(manifest.buildings
      .filter(m => m.folder && m.siteSlug).map(m => [m.folder, m]));
    for (const b of this.buildings) {
      if (b.nbSite) continue;
      const m = byFolder.get(b.folder);
      if (m) this._bindSite(b, { id: null, slug: m.siteSlug, name: m.name || b.name }, false);
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

  /** Names of buildings that still hold an `unassigned` drawing (Location mode, untouched —
   *  see `_normalizeToLocations`). The build gate lists these so the user knows where to look.
   *  A cheap synchronous pass over the in-memory model — `_stepMap` recomputes it every render.
   *  Buildings the user hasn't visited keep their `_modelFromInventory` level defaults (never
   *  `unassigned`), so they don't gate the build; only visited Location-mode buildings can. */
  _unassignedBuildings() {
    return this.buildings
      .filter(b => b.pdfs.some(p => this._cardUnassigned(b, p)))
      .map(b => b.name || b.folder);
  }

  /** Whether one drawing still needs a floor (gates the build). A region-split drawing (FLOOR-4)
   *  is unassigned while any of its regions is — a fresh region defaults to `unassigned` until the
   *  user picks its floor; a whole-page drawing keys off its own `assign`. */
  _cardUnassigned(b, p) {
    const regions = b.regions[p.stem];
    if (regions && regions.length) return regions.some(r => r.assign.type === 'unassigned');
    return b.assign[p.stem].type === 'unassigned';
  }

  /** Floors that currently hold rooms but whose id won't exist after this build — i.e. the
   *  rebuild would orphan their rooms. Compares the keys the build will produce
   *  (`siteSlug/(abbr+token)`, mirroring `preprocess.build`) against the live manifest's floors
   *  and their room counts. Returns `[{ key, label, count }]`; empty when nothing is at risk
   *  (e.g. a pure PDF replacement, where the id is unchanged). */
  async _orphanedFloors(map) {
    const store = this.app.store;
    if (!store || !store.manifest) return [];
    const newKeys = new Set();
    for (const folder in map.buildings) {
      const mb = map.buildings[folder];
      // A region-split floor value is a `[{token, region}]` list (FLOOR-4), not a scalar token —
      // expand it so each region floor's real key is compared, not a stringified array (which would
      // falsely orphan every real floor when rebuilding a region-split facility). A whole→region
      // split that would strand rooms is caught earlier by `_resplitReprojections` (FLOOR-5) and
      // reprojected, not discarded; `_build` excludes those keys before warning here.
      for (const stem in mb.floors) {
        const v = mb.floors[stem];
        const toks = Array.isArray(v) ? v.map(e => e.token) : [v];
        for (const t of toks) newKeys.add(mb.slug + '/' + (mb.abbr + t));
      }
    }
    // Fetch annotations fresh so the room counts reflect the current DB, not a stale cache.
    let anns = store.annotations || {};
    try { anns = await Api.get('/api/annotations'); } catch (_) { /* fall back to the cache */ }
    const out = [];
    for (const b of store.manifest.buildings) {
      for (const f of b.floors) {
        const key = b.dir + '/' + f.id;
        const n = (anns[key] && anns[key].rooms && anns[key].rooms.length) || 0;
        if (n && !newKeys.has(key)) out.push({ key, label: b.name + ' / ' + f.label, count: n });
      }
    }
    return out;
  }

  /** Built floors (and the siteplan) whose id survives this rebuild but whose orientation changes,
   *  so the rooms/hotspots already drawn on them would be misaligned. Compares the sorted set of
   *  sheet angles the build will produce against the ones baked into the live manifest
   *  (`pages[].angle`, default 0). Floors whose id vanishes are left to `_orphanedFloors`. Returns
   *  `[{ key, label, count, unit, hotspots? }]`; empty when nothing at risk (a plain unrotated
   *  rebuild or replacement). Async only to fetch fresh room counts, mirroring `_orphanedFloors`. */
  async _desyncedFloors(map) {
    const store = this.app.store;
    if (!store || !store.manifest) return [];
    // Angles the build will render, per surviving floor key (`siteSlug/(abbr+token)`). Compared as
    // a sorted signature so a single-sheet floor matches exactly and a multi-sheet floor matches
    // order-independently.
    const newAngles = new Map();
    for (const folder in map.buildings) {
      const mb = map.buildings[folder];
      const am = mb.angles || {};
      for (const stem in mb.floors) {
        const v = mb.floors[stem];
        const toks = Array.isArray(v) ? v.map(e => e.token) : [v];
        // A page's straightening angle is page-keyed and shared across every region floor split
        // from it (FLOOR-4), so each expanded key takes the same `am[stem]`.
        for (const t of toks) {
          const key = mb.slug + '/' + (mb.abbr + t);
          if (!newAngles.has(key)) newAngles.set(key, []);
          newAngles.get(key).push(am[stem] || 0);
        }
      }
    }
    const sig = (arr) => JSON.stringify(arr.slice().sort((x, y) => x - y));
    let anns = store.annotations || {};
    try { anns = await Api.get('/api/annotations'); } catch (_) { /* fall back to the cache */ }
    const out = [];
    for (const b of store.manifest.buildings) {
      for (const f of b.floors) {
        const key = b.dir + '/' + f.id;
        const n = (anns[key] && anns[key].rooms && anns[key].rooms.length) || 0;
        const next = newAngles.get(key);
        if (!n || !next) continue;   // no rooms, or id vanishing (→ `_orphanedFloors`)
        const cur = (f.pages || []).map(pg => pg.angle || 0);
        if (sig(cur) !== sig(next))
          out.push({ key, label: b.name + ' / ' + f.label, count: n, unit: 'room' });
      }
    }
    // The siteplan keeps a fixed id but its hotspots are drawn against its orientation too.
    const sp = store.manifest.siteplan;
    const hs = (sp && sp.hotspots && sp.hotspots.length) || 0;
    if (hs && map.siteplan && (sp.angle || 0) !== (map.siteplan.angle || 0))
      out.push({ key: 'siteplan', label: 'Siteplan', count: hs, unit: 'hotspot', hotspots: true });
    return out;
  }

  // ---- region-split room reprojection (FLOOR-5) ----

  /** The centroid (mean vertex) of a normalized polygon / point list, or the origin when empty. */
  _centroid(pts) {
    if (!pts || !pts.length) return [0, 0];
    let sx = 0, sy = 0;
    for (const [x, y] of pts) { sx += x; sy += y; }
    return [sx / pts.length, sy / pts.length];
  }

  /** The first region whose `[x, y, w, h]` box contains `pt` (assign-by-centroid), or null. */
  _regionFor(pt, regions) {
    const [px, py] = pt;
    return regions.find(r => {
      const [x, y, w, h] = r.box;
      return px >= x && px < x + w && py >= y && py < y + h;
    }) || null;
  }

  /** Remap a whole-page 0..1 point into a region's local 0..1 space: `(p - box) / box`, rounded
   *  to 5 dp like `FloorEditor._remapLayout`. Points outside the box get out-of-range coords that
   *  simply clip visually — the same tolerance the editor already has for stray coords. */
  _remapPt(pt, box) {
    const [px, py] = pt, [x, y, w, h] = box;
    return [+((px - x) / w).toFixed(5), +((py - y) / h).toFixed(5)];
  }

  /** Reproject plan for floors a whole→region split (FLOOR-5) would strand. When a previously-whole
   *  floor holding rooms is split into region crops, its rooms/arrows/notes are in whole-page 0..1
   *  space but each region floor renders a *crop*, so the coordinates — and, when a region takes a
   *  new token, the floor id — no longer fit. For each such source floor this assigns every shape to
   *  the region **containing its centroid**, remapping its coordinates into that region's local 0..1
   *  space, and drops shapes outside every region. Arrows follow their bound room's region (centroid
   *  fallback); rack/device placements (a separate blob) are deliberately left in place. Returns one
   *  entry per source with the precomputed destination writes — `_build` warns from the counts and
   *  `_applyReprojection` writes them after the build (through the authoritative `sync_rooms`).
   *
   *  Skipped (→ the plain `_orphanedFloors`/`_desyncedFloors` warnings) when the split also rotates
   *  the page (the room coords would be in the pre-rotation space) or when the old whole-page key
   *  can't be resolved / holds nothing — an already-split plan among them, whose old region boxes
   *  aren't retained, so its rooms can't be remapped. Async only to fetch fresh room geometry,
   *  mirroring the sibling guards. */
  async _resplitReprojections(map) {
    const store = this.app.store;
    if (!store || !store.manifest) return [];
    let anns = store.annotations || {};
    try { anns = await Api.get('/api/annotations'); } catch (_) { /* fall back to the cache */ }
    const liveFloor = (dir, fid) => {
      const mb = store.manifest.buildings.find(x => x.dir === dir);
      return mb && mb.floors.find(f => f.id === fid);
    };
    const out = [];
    for (const b of this.buildings) {
      const mb = map.buildings[b.folder];
      if (!mb) continue;
      // Whole-page token per drawing (resolve `b.assign` ignoring regions, chaining `last` for the
      // `same` case) — the floor id the drawing produced before it was split.
      const whole = {}; let last = null;
      for (const p of b.pdfs) {
        const t = this._assignToken(b.assign[p.stem], last);
        if (t) { whole[p.stem] = t; last = t; }
      }
      for (const p of b.pdfs) {
        const entry = mb.floors[p.stem];
        if (!Array.isArray(entry)) continue;   // not region-split
        const wtok = whole[p.stem];
        if (!wtok) continue;                   // no derivable whole-page id
        const oldFid = mb.abbr + wtok, oldKey = mb.slug + '/' + oldFid;
        const lf = liveFloor(mb.slug, oldFid);
        const newDeg = (b.angle[p.stem] && b.angle[p.stem].deg) || 0;
        const curDeg = (lf && lf.pages && lf.pages[0] && lf.pages[0].angle) || 0;
        if (lf && newDeg !== curDeg) continue; // split + rotate → leave to orphan/desync
        const rec = anns[oldKey];
        if (!rec) continue;
        const rooms = rec.rooms || [], arrows = rec.arrows || [], notes = rec.notes || [];
        if (!rooms.length && !arrows.length && !notes.length) continue;
        const regions = entry
          .filter(e => Array.isArray(e.region) && e.region.length === 4 && e.region[2] > 0 && e.region[3] > 0)
          .map(e => ({ box: e.region, fid: mb.abbr + e.token, key: mb.slug + '/' + (mb.abbr + e.token) }));
        if (!regions.length) continue;
        const dests = new Map();
        const dest = (r) => {
          if (!dests.has(r.key)) dests.set(r.key, { dir: mb.slug, fid: r.fid, rooms: [], arrows: [], notes: [] });
          return dests.get(r.key);
        };
        let moved = 0, dropped = 0;
        const landedIn = new Map();   // room id → region it landed in, so arrows can follow it
        for (const room of rooms) {
          const r = this._regionFor(this._centroid(room.polygon), regions);
          if (!r) { dropped++; continue; }
          landedIn.set(room.id, r);
          room.polygon = (room.polygon || []).map(pt => this._remapPt(pt, r.box));
          dest(r).rooms.push(room); moved++;
        }
        for (const a of arrows) {
          let r = a.room != null ? landedIn.get(a.room) : null;
          if (!r) r = this._regionFor(this._centroid(a.points), regions);
          if (!r) { dropped++; continue; }
          a.points = (a.points || []).map(pt => this._remapPt(pt, r.box));
          dest(r).arrows.push(a);
        }
        for (const nt of notes) {
          const r = this._regionFor([nt.x, nt.y], regions);
          if (!r) { dropped++; continue; }
          [nt.x, nt.y] = this._remapPt([nt.x, nt.y], r.box);
          if (nt.labelStyle && nt.labelStyle.x != null)
            [nt.labelStyle.x, nt.labelStyle.y] = this._remapPt([nt.labelStyle.x, nt.labelStyle.y], r.box);
          dest(r).notes.push(nt);
        }
        if (dests.size)
          out.push({ oldKey, label: (b.name || b.folder) + ' / ' + (lf ? lf.label : oldFid),
            moved, dropped, dests });
      }
    }
    return out;
  }

  /** Write a `_resplitReprojections` plan into the freshly-loaded store: clear the source floor's
   *  migrated shapes (it may itself be a destination when a region reuses the whole-page token) and
   *  push each remapped shape onto its region floor's record (created from the new manifest via
   *  `store.floorData`). The caller's one `saveAnnotations` routes the moves/deletes through the
   *  authoritative, permission-scoped `sync_rooms`. */
  _applyReprojection(r) {
    const store = this.app.store;
    const src = store.annotations[r.oldKey];
    if (src) { src.rooms = []; src.arrows = []; src.notes = []; }
    for (const d of r.dests.values()) {
      const rec = store.floorData(d.dir, d.fid);
      if (d.rooms.length) rec.rooms.push(...d.rooms);
      if (d.arrows.length) { rec.arrows = rec.arrows || []; rec.arrows.push(...d.arrows); }
      if (d.notes.length) { rec.notes = rec.notes || []; rec.notes.push(...d.notes); }
    }
  }

  // ---- step 3: build ----
  async _build() {
    const map = { siteplan: this.site.file
      ? { folder: this.site.folder, pdf: this.site.file, slug: '00-site' } : null, buildings: {} };
    // Two floor-contributing buildings bound to the SAME site slug would produce colliding floor
    // keys (`siteSlug/(abbr+token)`, see `preprocess.build`) and silently clobber each other's
    // floors (and rooms). Reject at the boundary before any render — the per-building empty-slug
    // guard below still catches a blank slug.
    const bySlug = {};
    for (const b of this._floorBuildings()) {
      const s = b.slug.trim();
      if (s) (bySlug[s] = bySlug[s] || []).push(b.name || b.folder);
    }
    const collision = Object.entries(bySlug).find(([, names]) => names.length > 1);
    if (collision) {
      Toast.show('Two buildings share the site slug “' + collision[0] + '” ('
        + collision[1].join(', ') + '). Bind each building to its own NetBox site.', true);
      return;
    }
    for (const b of this.buildings) {
      if (!b.slug.trim()) { Toast.show('Every building needs a site slug (' + b.folder + ')', true); return; }
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
      const labels = {};
      for (const p of b.pdfs) {
        const f = floors[p.stem];
        if (Array.isArray(f)) {
          f.forEach((e, i) => { const l = labelFor(e.token); if (l) labels[p.stem + '@r' + (i + 1)] = l; });
        } else if (f) {
          const a = b.assign[p.stem];
          if (a.token) { const l = labelFor(a.token); if (l) labels[p.stem] = l; }
        }
      }
      map.buildings[b.folder] = { slug: b.slug.trim(), name: b.name.trim() || b.folder,
        abbr: usesTokens ? '' : b.abbr.trim(), floors,
        ...(Object.keys(angles).length ? { angles } : {}),
        ...(Object.keys(labels).length ? { labels } : {}) };
    }
    if (!Object.keys(map.buildings).length) { Toast.show('Assign at least one floor', true); return; }
    // Carry the site drawing's own straightening angle into the siteplan block.
    if (map.siteplan) {
      const sb = this.buildings.find(x => x.folder === this.site.folder);
      const sp = sb && sb.pdfs.find(p => p.file === this.site.file && (!p.page || p.page === 1));
      const sdeg = sp && sb.angle[sp.stem] && sb.angle[sp.stem].deg;
      if (sdeg) map.siteplan.angle = sdeg;
    }

    // A whole→region split (FLOOR-5) changes a floor's id *and* coordinate space. Rather than orphan
    // its rooms, remap each into the region it sits in; compute that plan first so the orphan warning
    // below can exclude these sources — their rooms are moved, not discarded.
    const reprojections = await this._resplitReprojections(map);
    const reprojectedKeys = new Set(reprojections.map(r => r.oldKey));

    // Re-assigning a drawing's floor or re-binding a building changes the floor id; rooms drawn
    // on the old id are no longer in the rebuilt manifest. Warn before discarding them (excluding
    // the whole→region splits above, whose rooms are reprojected onto their new region floors).
    const orphaned = (await this._orphanedFloors(map)).filter(o => !reprojectedKeys.has(o.key));
    if (orphaned.length) {
      const lines = orphaned.map(o => '  • ' + o.label + '  ('
        + o.count + (o.count === 1 ? ' room' : ' rooms') + ')');
      if (!confirm('This rebuild changes these floors’ ids, so the rooms drawn on them will be '
          + 'removed:\n\n' + lines.join('\n') + '\n\nContinue and discard those rooms?'))
        return this._stepMap();
    }

    // A whole→region split keeps the user's rooms but moves each into the region it sits in,
    // remapping its coordinates; a room outside every region is dropped. Warn+confirm, mirroring
    // the orphan/desync pattern above.
    if (reprojections.length) {
      const lines = reprojections.map(r => {
        const parts = [r.moved + (r.moved === 1 ? ' room moved' : ' rooms moved')];
        if (r.dropped) parts.push(r.dropped + ' outside every region, dropped');
        return '  • ' + r.label + '  (' + parts.join(', ') + ')';
      });
      if (!confirm('Splitting these floors into regions moves each room into the region it sits '
          + 'in, remapping its coordinates:\n\n' + lines.join('\n') + '\n\nContinue and remap them?'))
        return this._stepMap();
    }

    // Reorienting a floor keeps its id (so `_orphanedFloors` won't catch it) but changes how the
    // drawing sits, desyncing rooms/hotspots already placed against the old orientation. Warn, but
    // keep them — rotation is reversible, so we never silently delete the user's work.
    const desynced = await this._desyncedFloors(map);
    if (desynced.length) {
      const lines = desynced.map(o => '  • ' + o.label + '  ('
        + o.count + ' ' + (o.count === 1 ? o.unit : o.unit + 's') + ')');
      if (!confirm('Reorienting these changes how their drawing sits, so the '
          + (desynced.some(o => o.hotspots) ? 'features' : 'rooms') + ' already drawn on them will '
          + 'no longer line up and need repositioning:\n\n' + lines.join('\n')
          + '\n\nContinue and keep them?'))
        return this._stepMap();
    }

    const view = this._stage('Building facility map…');
    view.append(Dom.el('div', { class: 'imp-spinner' },
      'Rendering ' + Object.keys(map.buildings).length + ' buildings. This can take a minute.'));
    try {
      const r = await Api.post('/api/import/build', map);
      if (!r.ok) throw new Error(r.error || 'build failed');
      await this.app.store.load();
      // Persist the room bookkeeping the rebuild implied in one save through the authoritative,
      // permission-scoped `sync_rooms` (no new endpoint, no loosened scoping): discard the floors
      // the user agreed to orphan, and remap the rooms of each whole→region split onto their new
      // region floors (FLOOR-5). A reprojection's cleared source key is pruned by `saveAnnotations`,
      // so its old rows are swept by `sync_rooms`' facility-scoped cross-floor delete; the moved
      // rooms keep their id and Location binding, upserted under the region floor's key.
      if (orphaned.length || reprojections.length) {
        for (const o of orphaned) delete this.app.store.annotations[o.key];
        for (const r of reprojections) this._applyReprojection(r);
        try { await this.app.store.saveAnnotations(); } catch (_) { /* best effort cleanup */ }
      }
      Toast.show('Facility imported');
      this.app.go('#/');
    } catch (e) {
      // A failed build never deletes anything: `build()` overwrites the manifest only on success
      // (and atomically), and we never reached `store.load()`, so the store still holds the
      // last-good map. Reassure the user rather than toasting a raw render traceback that reads as
      // "everything was wiped", and keep them on the review step to fix a drawing and retry.
      console.error('Facility rebuild failed', e);
      Toast.show('Rebuild failed. Your existing map is unchanged and still active. '
        + 'Nothing was lost.', true);
      this._stepMap();
    }
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
    if (!confirm('Clear the uploaded drawings and start the import over?')) return;
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
    this._codeRegion = null;
    this._codeRegionDone = false;
    this._siteplanDone = false;
    this._regionZoom = 1;
    this._mergeMode = false;
    this._stepUpload();
  }
}
