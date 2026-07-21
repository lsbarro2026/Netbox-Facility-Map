'use strict';
/* import-uploader.js — ImportUploader: the import wizard's file-ingestion + upload concern.
   Walks a picked/dropped folder or zip into drawing items (PDFs and/or raster images) and
   streams them to the server. Pure
   ingestion helpers (fromInput/fromDrop → `{ items, bim }`, collect/split) and the shared upload
   primitive (uploadFile) are static; the upload orchestrators need the wizard back-ref (`this.w`)
   for its progress element, merge-mode flag, and the post-upload routing (`_scanAndMap`/`_mergeUploads`).

   Mount-aware: uploads resolve against window.MAP.api and carry the session CSRF token so the
   session-auth POST isn't rejected; the server streams the multipart body to disk. */

class ImportUploader {
  constructor(wizard) {
    this.w = wizard;
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

  async upload(items) {
    // A drawing's companion siblings ride along in the same folder but aren't counted as drawings.
    const nDrawings = items.filter(it => ImportUploader.isDrawing(it.file.name)).length;
    if (!nDrawings) { Toast.show('No drawings found in that selection', true); return; }
    const progress = this.w._progress;
    progress.classList.remove('hidden');
    const hasSubfolders = items.some(it => it.path.split('/').filter(Boolean).length >= 3);
    let done = 0;
    for (const it of items) {
      const { folder, file } = ImportUploader.split(it.path, hasSubfolders);
      progress.textContent = `Uploading ${++done} / ${items.length}…`;
      try {
        await ImportUploader.uploadFile(folder + '/' + file, it.file, file);
      } catch (e) { Toast.show('Upload failed: ' + e.message, true); return; }
    }
    progress.textContent = `Uploaded ${nDrawings} drawings. Rendering previews…`;
    if (this.w._mergeMode) this.w._mergeUploads(); else this.w._scanAndMap();
  }

  /** Upload a single `.zip`; the server extracts its PDFs (stripping any wrapper folder)
   *  into the same `uploads/<building>/<file>` layout a folder upload produces. */
  async uploadZip(file) {
    const progress = this.w._progress;
    progress.classList.remove('hidden');
    progress.textContent = `Uploading ${file.name}…`;
    const apiBase = window.MAP ? window.MAP.api : '/api/';
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const headers = {};
      if (window.MAP && window.MAP.csrf) headers['X-CSRFToken'] = window.MAP.csrf;
      const r = await fetch(Api.withFacility(apiBase + 'import/upload-zip'),
        { method: 'POST', headers, body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || 'HTTP ' + r.status);
      progress.textContent = `Extracted ${j.count} drawings. Rendering previews…`;
    } catch (e) { Toast.show('Zip upload failed: ' + e.message, true); return; }
    if (this.w._mergeMode) this.w._mergeUploads(); else this.w._scanAndMap();
  }
}
