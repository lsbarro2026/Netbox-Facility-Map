'use strict';
/* import-uploader.js — ImportUploader: the import wizard's file-ingestion + upload concern.
   Walks a picked/dropped folder or zip into drawing items (PDFs and/or raster images) and
   streams them to the server. Pure
   ingestion helpers (fromInput/fromDrop → `{ items, bim }`, collect/split) and the shared upload
   primitive (uploadFile) are static; the upload orchestrators need the wizard back-ref (`this.w`)
   for its progress element and the phase reflector that disables the step's racing controls
   (`_setUploadPhase`).

   Uploads are **single-flight**: one run drains a queue of selections, so a folder or zip picked
   while another is still uploading joins that run instead of racing it. See the phase machine
   above `_submit`.

   A finished run goes **nowhere** (IMPORT-65): it leaves the operator on the upload step with a
   summary of what landed, and the step's Continue button is what scans and routes onward. That is
   what lets a facility be uploaded in several passes, one building folder or zip at a time.

   Mount-aware: uploads resolve against window.MAP.api and carry the session CSRF token so the
   session-auth POST isn't rejected; the server streams the multipart body to disk. */

class ImportUploader {
  constructor(wizard) {
    this.w = wizard;
    // Single-flight run state — see the phase machine above `_submit`.
    this._phase = 'idle';
    this._queue = [];
    this._sent = 0;   // files POSTed so far this run
    this._items = 0;  // files accepted across every batch queued this run (the progress total)
    // Per-*visit* state, spanning the successive runs of a multi-pass upload (`beginVisit`).
    this._uploadedDrawings = 0;  // drawings landed on the server this visit (the completion line)
    this._targets = new Set();   // `<folder>/<file>` destinations accepted this visit
  }

  /** Accepted source *drawing* extensions, from `window.MAP.drawingExts` — which the server injects
   *  from its `drawing_formats` registry (the single source of truth) narrowed to the **installed**
   *  formats: the base install carries PDFs + common raster plan formats, and advanced formats
   *  (SVG/DXF/Visio/GIS) appear only when their pip extra / external binary is installed (PKG-1).
   *  The literal is only a fallback for when `window.MAP` is absent (outside the plugin page) — it
   *  lists just the always-present base formats, so it can never advertise an uninstalled one; the
   *  real, gated set always comes from the server. */
  static DRAWING_EXTS = (window.MAP && window.MAP.drawingExts)
    || ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.tif', '.tiff', '.bmp', '.webp'];

  /** Companion sibling extensions (a shapefile's `.shx/.dbf/.prj/.cpg`): uploaded alongside their
   *  drawing so the set stays together, but not themselves drawings. From `window.MAP.companionExts`
   *  (same registry, gated with its owning `[gis]` format). The fallback is empty — companions
   *  belong to an optional format that the base install doesn't carry. */
  static COMPANION_EXTS = (window.MAP && window.MAP.companionExts) || [];

  /** Everything the file inputs accept + `accepts()` admits: drawings plus their companions. */
  static EXTS = [...ImportUploader.DRAWING_EXTS, ...ImportUploader.COMPANION_EXTS];

  /** The OVERLAY-role subset of the accepted drawings (GIS data layers drawn atop a base plan),
   *  from `window.MAP.overlayExts` (same registry gating as DRAWING_EXTS). The wizard keys its
   *  overlay-only affordances — the FMT-6 align editor — off `isOverlay`. Fallback empty: every
   *  overlay format is an optional `[gis]` extra the base install doesn't carry. */
  static OVERLAY_EXTS = (window.MAP && window.MAP.overlayExts) || [];

  static isDrawing(name) {
    const n = (name || '').toLowerCase();
    return ImportUploader.DRAWING_EXTS.some(ext => n.endsWith(ext));
  }

  static isOverlay(name) {
    const n = (name || '').toLowerCase();
    return ImportUploader.OVERLAY_EXTS.some(ext => n.endsWith(ext));
  }

  static isCompanion(name) {
    const n = (name || '').toLowerCase();
    return ImportUploader.COMPANION_EXTS.some(ext => n.endsWith(ext));
  }

  static accepts(name) {
    return ImportUploader.isDrawing(name) || ImportUploader.isCompanion(name);
  }

  /** 3D BIM / native-CAD model extensions we deliberately DON'T import: they're whole-building
   *  models (or a single 3D file), not per-floor pages, and RVT has no open reader. Detected only
   *  so a selection of them yields actionable in-UI guidance (export each floor to a PDF/image,
   *  then import those) instead of a silent drop — they are never decoded. Kept separate from the
   *  drawing/companion registry, which lists only formats the render subprocess can actually parse. */
  static BIM_EXTS = ['.ifc', '.rvt', '.rfa', '.rte'];

  static isBim(name) {
    const n = (name || '').toLowerCase();
    return ImportUploader.BIM_EXTS.some(ext => n.endsWith(ext));
  }

  /** The BIM/CAD-model names in `names` (see `BIM_EXTS`) — a selection carrying these but no
   *  importable drawing gets export guidance rather than a bare "no drawings found". */
  static bimIn(names) {
    return [...names].filter(ImportUploader.isBim);
  }

  /** `<dir>` + lowercased stem of a relative path — the key by which a companion is matched to its
   *  drawing (same folder, same base name). */
  static _dirStem(path) {
    const segs = (path || '').split('/').filter(Boolean);
    const file = segs.length ? segs[segs.length - 1] : '';
    return { dir: segs.slice(0, -1).join('/'),
             stem: file.replace(/\.[^.]*$/, '').toLowerCase() };
  }

  /** Drop companion siblings with no drawing sharing their folder + base name (an orphan `.dbf`
   *  with no `.shp` is junk the server would reject anyway). Drawings pass through untouched. */
  static dropOrphanCompanions(items) {
    const drawings = new Set(items.filter(it => ImportUploader.isDrawing(it.file.name))
      .map(it => { const { dir, stem } = ImportUploader._dirStem(it.path); return dir + '\n' + stem; }));
    return items.filter((it) => {
      if (!ImportUploader.isCompanion(it.file.name)) return true;
      const { dir, stem } = ImportUploader._dirStem(it.path);
      return drawings.has(dir + '\n' + stem);
    });
  }

  /** Ingest a picked selection into `{ items, bim }`: importable drawing items (accept-filtered,
   *  orphan-companion-pruned) plus any 3D BIM/CAD model names found (for guidance). */
  static fromInput(fileList) {
    const files = [...fileList];
    const items = ImportUploader.dropOrphanCompanions(
      files.filter(f => ImportUploader.accepts(f.name))
        .map(f => ({ file: f, path: f.webkitRelativePath || f.name })));
    return { items, bim: ImportUploader.bimIn(files.map(f => f.name)) };
  }

  /** Walk a dropped selection (folders + loose files) into every file it contains, as
   *  `{ file, path }` items — BEFORE any accept-filtering, so a single walk feeds both the drawing
   *  list and rejected-input detection (`fromDrop`). */
  static async collect(dt) {
    const roots = [...dt.items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    const out = [];
    const walk = (entry, prefix) => new Promise((res) => {
      if (entry.isFile) return entry.file(f => { out.push({ file: f, path: prefix + entry.name }); res(); });
      if (!entry.isDirectory) return res();
      const reader = entry.createReader();
      const readAll = () => reader.readEntries(async (ents) => {
        if (!ents.length) return res();
        for (const e of ents) await walk(e, prefix + entry.name + '/');
        readAll();
      });
      readAll();
    });
    for (const r of roots) await walk(r, '');
    return out;
  }

  /** Ingest a drop into `{ items, bim }` (same shape as `fromInput`): one walk yields both the
   *  importable drawings and any BIM/CAD-model names to give guidance on. */
  static async fromDrop(dt) {
    const walked = await ImportUploader.collect(dt);
    const items = ImportUploader.dropOrphanCompanions(
      walked.filter(x => ImportUploader.accepts(x.file.name)));
    return { items, bim: ImportUploader.bimIn(walked.map(x => x.file.name)) };
  }

  /** Building folder + filename from a relative path `<root>/<building>/<file>.pdf`. A PDF
   *  sitting directly under the dropped root (`<root>/<file>.pdf`, two segments) is the
   *  overall site map, so route it into the reserved `Site Plan` bucket — but only when the
   *  drop also has subfoldered drawings (`hasSubfolders`), else a single flat building folder
   *  would be mistaken for the siteplan. The `Site Plan` name reuses the existing siteplan
   *  auto-detect/build path unchanged. */
  static split(relPath, hasSubfolders) {
    const segs = relPath.split('/').filter(Boolean);
    if (hasSubfolders && segs.length === 2) return { folder: 'Site Plan', file: segs[1] };
    return { folder: segs.length > 1 ? segs[segs.length - 2] : 'Building', file: segs[segs.length - 1] };
  }

  /** POST one file to the working-dir path `<folder>/<file>` under `import/upload`. Multipart so
   *  the server streams to disk (no in-memory body cap); CSRF header so the session-auth POST
   *  isn't rejected. Throws on a non-OK response. Shared by the folder upload and the per-card
   *  Replace control. */
  static async uploadFile(path, file, name) {
    const apiBase = window.MAP ? window.MAP.api : '/api/';
    const fd = new FormData();
    fd.append('file', file, name);
    const headers = {};
    if (window.MAP && window.MAP.csrf) headers['X-CSRFToken'] = window.MAP.csrf;
    const r = await fetch(
      Api.withFacility(apiBase + 'import/upload?path=' + encodeURIComponent(path)),
      { method: 'POST', headers, body: fd });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  }

  /** Queue a picked/dropped folder selection.
   *
   *  `hasSubfolders` is computed **per selection**, not over the combined queue: queueing
   *  serializes two independent selections, so each is classified exactly as it would have been
   *  had the user waited for the first to finish (§10 *A loose top-level drawing is the site
   *  map*). Re-deriving the flag over the merged list would retroactively reclassify files
   *  already written to disk under the other reading. */
  async upload(items) {
    // A drawing's companion siblings ride along in the same folder but aren't counted as drawings.
    const drawings = items.filter(it => ImportUploader.isDrawing(it.file.name)).length;
    if (!drawings) { Toast.show('No drawings found in that selection', true); return; }
    const hasSubfolders = items.some(it => it.path.split('/').filter(Boolean).length >= 3);
    return this._submit({ items, hasSubfolders, drawings });
  }

  /** Queue a single `.zip`; the server extracts its PDFs (stripping any wrapper folder)
   *  into the same `uploads/<building>/<file>` layout a folder upload produces. */
  async uploadZip(file) {
    return this._submit({ zip: file });
  }

  /** A wizard scan is in flight, so the queue is sealed and a new selection is refused: the scan's
   *  completion navigates away, and a selection accepted under it would start a run the scan
   *  abandons mid-upload. Since IMPORT-65 a run no longer scans on its own — the only scan that can
   *  be running while this step is up is the one Continue fired — so `scanBusy` is the whole
   *  condition. */
  get sealed() { return this.w.scanBusy; }

  get phase() { return this._phase; }

  /* ---- single-flight uploads (IMPORT-30) ----
     A selection picked or dropped while a batch is still uploading is **queued onto** that batch —
     one progress line, one completion — rather than starting a second run beside it. Two concurrent
     runs used to interleave their counts on the shared progress element, scan a half-uploaded
     working dir (yanking the user to the mapping step while files still streamed), read
     `_mergeMode` after the other run had already cleared it, and fire two `import/scan` POSTs at a
     server that serializes them under one render lock (the loser surfacing as an uninterpretable
     "Scan failed"). The run is a two-phase machine:

       'idle'      — nothing in flight; a selection starts a run.
       'uploading' — the runner is draining `_queue`; a new selection joins it.

     A finished run returns to `idle` **on the step** (IMPORT-65): it no longer scans, so there is no
     third "the post-upload scan is in flight" phase to sit in — the queue is sealed only while the
     scan Continue fires is running (`sealed`), and a further selection simply starts a fresh run.

     The server tolerates parallel uploads by design — `UploadView` deliberately takes no import
     lock — so this coordination belongs here, on the client that owns the step's state. */

  /** Accept one job onto the run, starting a runner if none is draining. Refused once the queue is
   *  sealed: the step has already blocked its drop zone, so this is the backstop for a file picker
   *  opened just before the block landed. */
  async _submit(job) {
    if (this.sealed) {
      Toast.show('Your drawings are still being scanned — try again in a moment', true);
      return;
    }
    this._warnOverwrites(job);
    if (job.items) this._items += job.items.length;
    this._queue.push(job);
    if (this._phase === 'uploading') {
      Toast.show(job.zip
        ? `${job.zip.name} added to the upload in progress`
        : `${job.drawings} more drawing${job.drawings === 1 ? '' : 's'} added to the upload `
          + 'in progress');
      return;
    }
    return this._run();
  }

  /** Two selections can carry the same `<folder>/<file>` destination, where the later upload
   *  silently replaces the earlier one's bytes. Surface that rather than merging quietly. Compares
   *  full destinations, not folder names, so genuinely additive floors dropped into an existing
   *  building folder don't false-alarm. A zip contributes nothing: the server names its members, so
   *  its destinations aren't known here.
   *
   *  Scoped to the **visit**, not the run (IMPORT-65): uploading a facility one folder at a time is
   *  now the sanctioned workflow, so pass 2 replacing a file pass 1 wrote is exactly the collision
   *  worth naming — and it only became reachable once a finished run stopped navigating away. */
  _warnOverwrites(job) {
    if (!job.items) return;
    const targets = job.items.map((it) => {
      const { folder, file } = ImportUploader.split(it.path, job.hasSubfolders);
      return folder + '/' + file;
    });
    const clashes = targets.filter(t => this._targets.has(t)).length;
    if (clashes) {
      Toast.show(`${clashes} file${clashes === 1 ? '' : 's'} in this selection replace`
        + `${clashes === 1 ? 's' : ''} one already uploaded`, true);
    }
    targets.forEach(t => this._targets.add(t));
  }

  /** Drain the queue, then stop — on the step, back at `idle` (IMPORT-65).
   *
   *  A finished run deliberately routes **nowhere**: it used to scan and navigate to the mapping
   *  step, which cut short an operator uploading a facility in several passes (one building folder
   *  or zip at a time) and could build a facility from part of its drawings. Continue is now the
   *  only thing that scans, so success lands in the same "still here, controls live" state the
   *  failure path already produced — the two differ only in what the progress line says.
   *
   *  Nothing here reads `this.w._mergeMode` any more: Continue in merge mode wires straight to
   *  `_mergeUploads`, which is also the only thing that clears the flag, so the stale-read bug that
   *  sent a merge-mode batch down the fresh-import path has no way back in. */
  async _run() {
    this._phase = 'uploading';
    this.w._setUploadPhase(this._phase);
    if (this.w._progress) this.w._progress.classList.remove('hidden');
    let drawings = 0;
    let job = null;
    try {
      // `_queue` grows while this drains — that join is what keeps a second selection on one run.
      while (this._queue.length) {
        job = this._queue.shift();
        drawings += job.zip ? await this._sendZip(job.zip) : await this._sendItems(job);
      }
    } catch (e) {
      // Fail the whole run: drop whatever is still queued and stay on the upload step. Continuing
      // from a half-uploaded working dir is what builds a facility from half its drawings — and the
      // batches that *did* land still count toward the visit's total, so the operator can see what
      // survived before deciding to retry or continue.
      const zipped = !!(job && job.zip);
      this._uploadedDrawings += drawings;
      this._idle();
      this._setProgress('Upload stopped.');
      Toast.show((zipped ? 'Zip upload failed: ' : 'Upload failed: ') + e.message, true);
      return;
    }
    this._uploadedDrawings += drawings;
    this._idle();
    this._setProgress(this._uploadedLine());
  }

  /** The line a completed run leaves behind: what has landed this visit, and that the next move is
   *  the operator's (IMPORT-65). It is deliberately the count-bearing surface here — the step's
   *  `_uploadSummary` card reads the last *scan*, which an in-place upload doesn't refresh, so
   *  saying it here is what keeps the step from under-reporting what was just uploaded without
   *  re-rendering (or scanning) to refresh that card. Names no button: Continue reads
   *  "Done adding" in merge mode. */
  _uploadedLine() {
    const n = this._uploadedDrawings;
    return `Uploaded ${n} drawing${n === 1 ? '' : 's'}. Add more, or continue when you’re ready.`;
  }

  /** POST one queued folder batch, item by item. This runner is the **only** writer of the
   *  progress line, so its count can't jump between two batches' totals; the total grows as
   *  further selections queue onto the run. Returns the batch's drawing count. */
  async _sendItems(job) {
    for (const it of job.items) {
      const { folder, file } = ImportUploader.split(it.path, job.hasSubfolders);
      this._setProgress(`Uploading ${++this._sent} / ${this._items}…`);
      await ImportUploader.uploadFile(folder + '/' + file, it.file, file);
      this._markContent();
    }
    return job.drawings;
  }

  /** Record that real drawings now exist on the server, and let the step re-evaluate its Continue
   *  gate. That gate is the **conjunction** of two rules: IMPORT-32 keeps Continue disabled until
   *  something is actually uploaded, and IMPORT-30 keeps it disabled while a run is in flight. So
   *  this never enables the button mid-run — it is what makes the button live once the run ends,
   *  whichever way it ended: a failed run leaves the operator on the step with real drawings already
   *  on the server, and since IMPORT-65 a successful one does too, waiting to be clicked. */
  _markContent() {
    this.w._uploadHasContent = true;
    this.w._setUploadPhase(this._phase);
  }

  /** POST one queued `.zip` whole, for server-side extraction. Returns how many drawings it
   *  extracted, so the run's completion line counts them alongside any folder batches. */
  async _sendZip(file) {
    this._setProgress(`Uploading ${file.name}…`);
    const apiBase = window.MAP ? window.MAP.api : '/api/';
    const fd = new FormData();
    fd.append('file', file, file.name);
    const headers = {};
    if (window.MAP && window.MAP.csrf) headers['X-CSRFToken'] = window.MAP.csrf;
    const r = await fetch(Api.withFacility(apiBase + 'import/upload-zip'),
      { method: 'POST', headers, body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || 'HTTP ' + r.status);
    if (j.count) this._markContent();
    return j.count || 0;
  }

  /** The one writer of the step's progress line (see `_run`). */
  _setProgress(text) {
    if (this.w._progress) this.w._progress.textContent = text;
  }

  /** End the run: back to `idle` with its **per-run** bookkeeping cleared, so the next selection
   *  starts a fresh run and the step re-enables its controls. The per-visit counters
   *  (`_uploadedDrawings`, `_targets`) deliberately survive — they span the successive runs of a
   *  multi-pass upload, which is what `beginVisit` resets instead. */
  _idle() {
    this._phase = 'idle';
    this._queue = [];
    this._sent = 0;
    this._items = 0;
    this.w._setUploadPhase(this._phase);
  }

  /** Start a fresh **visit** to the upload step: forget what earlier visits uploaded. Called by
   *  `ImportFlow._stepUpload` as the step renders (so a *Start over*, a step-back, or entering merge
   *  mode all start the count at zero), and kept apart from `_idle` because the whole point of
   *  IMPORT-65 is that one visit can hold several runs. */
  beginVisit() {
    this._uploadedDrawings = 0;
    this._targets.clear();
  }
}
