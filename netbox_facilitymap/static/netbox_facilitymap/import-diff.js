'use strict';
/* import-diff.js — ImportDiff: the import wizard's pre-build room-safety concern. Given the
   import-map `_build` is about to POST, it answers "what does this rebuild do to the rooms and
   hotspots the user has already drawn?" — and, for the two cases that can be repaired rather than
   discarded, precomputes the repair:

     - orphanedFloors(map)      floors holding rooms whose id won't survive → their rooms are lost
     - desyncedFloors(map)      floors whose id survives but whose drawing changes shape/bytes →
                                their rooms stay but may no longer line up (the siteplan entry can
                                carry a `refit` plan when the change is a clean aspect swap)
     - resplitReprojections(map) whole→region splits (FLOOR-5) → each room is moved into the region
                                it sits in, with its coordinates remapped
     - applyReprojection(r) / applySiteplanRefit(plan)   the post-build writes for those repairs

   Every read here is a *comparison of the map the build will produce against the live manifest*,
   so the floor-key construction (`<dir>/(abbr+token)`, `dir` per `dirOf`) mirrors
   `preprocess.build` and must stay in step with it. That expansion lives once, in the
   `floorEntries`/`floorKeys` statics the three reads share. The three read methods are async only to
   fetch fresh room counts (never a stale cache) and to measure the new siteplan's aspect.

   The three *reads* hold a wizard back-ref (`this.w`), the ImportUploader shape — they read the
   flow's building model, its replaced-drawing tracker, and the app store. The *statics* deliberately
   do not, because they have a second caller outside the wizard: `SettingsPage`'s rebuild offer
   (IMPORT-74) drives `rerenderOnly` over the on-disk import map, with no flow to hold. Keeping the
   key convention here rather than copying it there is the whole point — one mirror of
   `preprocess.build`, not two. */

class ImportDiff {
  constructor(wizard) {
    this.w = wizard;
  }

  /** The manifest `dir` a built building writes — the prefix its floor keys hang off. A Site anchor
   *  is the bare site slug (`<siteSlug>`, a 2-segment key); a Location anchor nests one level
   *  (`<siteSlug>/<buildingSlug>`, a 3-segment key), matching `preprocess.build_building_from_pdfs`'s
   *  `rel_dir` and the manifest's `dir`. Every floor-key comparison against the live manifest
   *  (`orphanedFloors`/`desyncedFloors`/`resplitReprojections`) keys off this, so a rebuilt
   *  Location-anchored floor matches its manifest entry instead of being falsely orphaned. */
  static dirOf(mb) {
    return mb.buildingSlug ? mb.slug + '/' + mb.buildingSlug : mb.slug;
  }

  /** Every floor a build map yields, as `{key, folder, stem, angle}` — the one expansion of the
   *  polymorphic floor-table value the reads below share. A scalar token is one whole-page floor; a
   *  region-split value (FLOOR-4) is a `[{token, region}]` list, each entry its own floor, and each
   *  taking the page's single straightening angle (a page is rotated once, then cropped). `key` is
   *  the manifest floor key `<dir>/(abbr+token)` (`dir` per `dirOf`), mirroring `preprocess.build`;
   *  `folder`/`stem` identify the drawing it came from, which is what lets a caller ask the flow's
   *  replaced-drawing tracker about it. */
  static floorEntries(map) {
    const out = [];
    for (const folder in (map.buildings || {})) {
      const mb = map.buildings[folder];
      const dir = ImportDiff.dirOf(mb);
      const am = mb.angles || {};
      for (const stem in (mb.floors || {})) {
        const v = mb.floors[stem];
        // A falsy token is an *unmapped* drawing (the stub map seeds every stem with ''), which
        // `preprocess._page_entries` skips — so it yields no floor here either.
        const toks = (Array.isArray(v) ? v.map(e => e.token) : [v]).filter(Boolean);
        for (const t of toks)
          out.push({ key: dir + '/' + (mb.abbr + t), folder, stem, angle: am[stem] || 0 });
      }
    }
    return out;
  }

  /** The set of manifest floor keys a build map will produce. */
  static floorKeys(map) {
    return new Set(ImportDiff.floorEntries(map).map(e => e.key));
  }

  /** key → its sorted sheet-angle signature, for one side of a comparison. Sorted so a multi-sheet
   *  floor matches order-independently and a single-sheet floor matches exactly — the same signature
   *  `desyncedFloors` compares. */
  static _angleSig(pairs) {
    const sig = new Map();
    for (const [key, angle] of pairs) {
      if (!sig.has(key)) sig.set(key, []);
      sig.get(key).push(angle);
    }
    for (const [key, arr] of sig) sig.set(key, JSON.stringify(arr.sort((x, y) => x - y)));
    return sig;
  }

  /** Whether building `map` would **re-render the live manifest and change nothing else** — same
   *  floors, same orientations, same site plan. The gate for a rebuild fired from outside the wizard
   *  (`SettingsPage`, IMPORT-74), where there is no review dialog and no `_afterBuild` to reconcile
   *  rooms with: if this is true the rebuild cannot orphan a room (no id moves), cannot need a
   *  region reprojection (no split appears) and cannot desync one (no rotation, no site-plan swap),
   *  so the only thing that changes is the rendered pixel scale — and geometry is normalized 0..1.
   *
   *  Stricter than the three reads below by design. They answer "what would this rebuild cost you?"
   *  so the user can consent; this answers "is there anything to consent to at all?", and a caller
   *  with no way to apply the consequences must refuse rather than ask. Every finding that costs a
   *  **room** trips it.
   *
   *  Purely structural, and one hotspot-only case is out of its reach because of that: the manifest
   *  records no site-plan *source*, so swapping the site drawing for a different one at the same
   *  angle and slug is invisible here, where `desyncedFloors` would still catch a shape change by
   *  measuring a preview render. It needs a *previously failed* build to arise at all (only a build
   *  writes the map, and a successful one also writes the manifest), and it is the mildest finding
   *  class — hotspots are kept, just worth re-checking — so this stays synchronous rather than
   *  putting a full-scale render in front of every rebuild offer. */
  static rerenderOnly(map, manifest) {
    if (!map || !manifest) return false;
    const next = ImportDiff._angleSig(ImportDiff.floorEntries(map).map(e => [e.key, e.angle]));
    // The manifest's own side of the same signature: one entry per rendered sheet. A floor always
    // renders at least one page (`preprocess` drops a pageless floor), so a missing/empty `pages`
    // reads as the single unrotated sheet a scalar map value would produce.
    const livePairs = [];
    for (const b of (manifest.buildings || [])) {
      for (const f of (b.floors || [])) {
        const angles = (f.pages || []).map(pg => pg.angle || 0);
        for (const a of (angles.length ? angles : [0])) livePairs.push([b.dir + '/' + f.id, a]);
      }
    }
    const live = ImportDiff._angleSig(livePairs);
    if (next.size !== live.size) return false;
    for (const [key, s] of next) if (live.get(key) !== s) return false;
    // The site plan keeps a fixed id, so it never shows up as a floor key — but its hotspots are
    // drawn against its orientation and shape, so a rebuild that adds, drops or rotates it is not a
    // re-render either.
    const sp = manifest.siteplan;
    if (!sp !== !map.siteplan) return false;
    if (!sp) return true;
    return (sp.angle || 0) === (map.siteplan.angle || 0)
      && sp.siteSlug === (map.siteplan.slug || '00-site');
  }

  /** Room geometry as the DB currently holds it, fetched fresh so counts never reflect a stale
   *  cache; falls back to the store's cache when the read fails. Shared by the three read methods. */
  async _freshAnnotations() {
    const store = this.w.app.store;
    try { return await Api.get('/api/annotations'); }
    catch (_) { return store.annotations || {}; }
  }

  /** Floors that currently hold rooms but whose id won't exist after this build — i.e. the
   *  rebuild would orphan their rooms. Compares the keys the build will produce
   *  (`<dir>/(abbr+token)`, mirroring `preprocess.build` — `dir` per `dirOf`) against the live
   *  manifest's floors and their room counts. Returns `[{ key, label, count }]`; empty when nothing
   *  is at risk (e.g. a pure PDF replacement, where the id is unchanged). */
  async orphanedFloors(map) {
    const store = this.w.app.store;
    if (!store || !store.manifest) return [];
    // A region-split floor value is a `[{token, region}]` list (FLOOR-4), not a scalar token, so
    // each region floor's real key is compared, not a stringified array (which would falsely orphan
    // every real floor when rebuilding a region-split facility) — `floorKeys` owns that expansion.
    // A whole→region split that would strand rooms is caught earlier by `resplitReprojections`
    // (FLOOR-5) and reprojected, not discarded; `_build` excludes those keys before warning here.
    const newKeys = ImportDiff.floorKeys(map);
    const anns = await this._freshAnnotations();
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

  /** Built floors (and the siteplan) whose id survives this rebuild but whose drawing changes shape
   *  (or is replaced in place), so the rooms/hotspots already drawn on them would be misaligned. A
   *  floor is flagged when either its sorted set of sheet angles differs from the live manifest's
   *  (`pages[].angle`, default 0) OR its drawing's bytes were replaced this session (REPL-1) — a
   *  Replace keeps the id/pixel-size/aspect but a margin or crop shift, undetectable from manifest
   *  metadata, still desyncs its rooms, so a replaced-with-rooms floor warns unconditionally. For
   *  the siteplan, aspect ratio is additionally compared (via `_siteplanAspectChanged`) — the
   *  overlay stretches hotspots `preserveAspectRatio:'none'`, so a new drawing of a different aspect
   *  skews them even with no rotation — and a replaced siteplan drawing flags the same way. Floors
   *  whose id vanishes are left to `orphanedFloors`. Returns `[{ key, label, count, unit,
   *  hotspots? }]`; empty when nothing at risk (a plain rebuild or an untouched, same-shape floor).
   *  Async to fetch fresh room counts (mirroring `orphanedFloors`) and to measure the new
   *  siteplan's rendered aspect. */
  async desyncedFloors(map) {
    const store = this.w.app.store;
    if (!store || !store.manifest) return [];
    // Angles the build will render, per surviving floor key (`<dir>/(abbr+token)`, `dir` per
    // `dirOf`). Compared as
    // a sorted signature so a single-sheet floor matches exactly and a multi-sheet floor matches
    // order-independently. `replacedKeys` collects the surviving keys whose drawing was replaced
    // this session (REPL-1), an unconditional desync trigger alongside the angle diff. `floorEntries`
    // carries each floor's page angle and originating drawing, so both fall out of one walk — a
    // page's straightening angle is page-keyed and shared across every region floor split from it
    // (FLOOR-4), and likewise a replaced page desyncs every region floor split from it.
    const newAngles = new Map();
    const replacedKeys = new Set();
    for (const e of ImportDiff.floorEntries(map)) {
      if (!newAngles.has(e.key)) newAngles.set(e.key, []);
      newAngles.get(e.key).push(e.angle);
      if (this.w._replaced.has(e.folder + '/' + e.stem)) replacedKeys.add(e.key);
    }
    const sig = (arr) => JSON.stringify(arr.slice().sort((x, y) => x - y));
    const anns = await this._freshAnnotations();
    const out = [];
    for (const b of store.manifest.buildings) {
      for (const f of b.floors) {
        const key = b.dir + '/' + f.id;
        const n = (anns[key] && anns[key].rooms && anns[key].rooms.length) || 0;
        const next = newAngles.get(key);
        if (!n || !next) continue;   // no rooms, or id vanishing (→ `orphanedFloors`)
        const cur = (f.pages || []).map(pg => pg.angle || 0);
        if (sig(cur) !== sig(next) || replacedKeys.has(key))
          out.push({ key, label: b.name + ' / ' + f.label, count: n, unit: 'room' });
      }
    }
    // The siteplan keeps a fixed id but its hotspots are drawn against its orientation *and* its
    // aspect ratio (the overlay stretches them `preserveAspectRatio:'none'`, SiteplanEditor). Count
    // from the DB blob (`store.siteHotspots`) — the manifest's `siteplan.hotspots` is a permanent
    // `[]` placeholder (preprocess.build_siteplan_from_pdf), so it never reflects real hotspots.
    const sp = store.manifest.siteplan;
    const hs = (store.siteHotspots || []).length;
    if (hs && map.siteplan) {
      const angleChanged = (sp.angle || 0) !== (map.siteplan.angle || 0);
      const newAspect = await this._siteplanAspectChanged(map.siteplan, sp);
      // The site drawing lives in a building folder; resolve its stem the way `_build` does to see
      // whether its bytes were replaced this session (REPL-1) — a same-aspect margin shift wouldn't
      // trip the angle/aspect checks yet still skews the hotspots.
      const sb = this.w.buildings.find(x => x.folder === map.siteplan.folder);
      const spd = sb && sb.pdfs.find(p => p.file === map.siteplan.pdf);
      const replaced = !!(spd && this.w._replaced.has(map.siteplan.folder + '/' + spd.stem));
      if (angleChanged || newAspect || replaced) {
        // An aspect-only change is the one desync we can offer to correct: the skew is a known
        // axis stretch, so the hotspots can be re-fitted through `_containFit`. A rotation or an
        // in-place replace moves content in ways contain-fit can't model, so those stay
        // warn-and-keep — `refit` is attached only for the clean case (IMPORT-11).
        const refit = (newAspect && !angleChanged && !replaced)
          ? { from: sp.w / sp.h, to: newAspect } : null;
        out.push({ key: 'siteplan', label: 'Siteplan', count: hs, unit: 'hotspot', hotspots: true,
          ...(refit ? { refit } : {}) });
      }
    }
    return out;
  }

  /** The aspect ratio the newly-chosen siteplan drawing `next` (`{folder, pdf, angle?}` from the
   *  build map) will render to, when it differs from the live siteplan image `live`
   *  (`manifest.siteplan`, with `w`/`h`) — else `null`. Because the overlay stretches hotspots
   *  `preserveAspectRatio:'none'`, a same-aspect swap (any pixel size) keeps them aligned but a
   *  different-aspect swap silently skews them — this drives the desync warning, and the measured
   *  aspect additionally seeds the opt-in re-fit offer (`_containFit`). The build's dims
   *  aren't known until it runs, so measure them pre-build off the drawing's **full-scale preview**
   *  render (`preprocess.preview` → `render_full`, same pipeline/angle as the build, so the same
   *  aspect). Degrades to `null` — no false alarm — when the live dims are missing or the preview
   *  can't be loaded. The drift is relative (a ratio of ratios) against the shared
   *  `ASPECT_MISMATCH_TOLERANCE`, so one threshold covers both this and the floor-plate check. */
  async _siteplanAspectChanged(next, live) {
    if (!live || !live.w || !live.h) return null;
    const rel = 'uploads/' + next.folder + '/' + next.pdf;
    const dims = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth && img.naturalHeight
        ? { w: img.naturalWidth, h: img.naturalHeight } : null);
      img.onerror = () => resolve(null);
      img.src = ImportPreview.previewUrl(rel, 1, next.angle || 0);
    });
    if (!dims) return null;
    const aspect = dims.w / dims.h;
    return Math.abs(aspect / (live.w / live.h) - 1) > ASPECT_MISMATCH_TOLERANCE ? aspect : null;
  }

  /** The normalized-space affine that re-fits geometry drawn against an image of aspect `a0` onto
   *  one of aspect `a1`, assuming the replacement drawing shows the **same area** — the old content
   *  uniformly scaled and centred inside the new frame ("contain"). With `s = min(a1/a0, 1)` and
   *  `k = a0·s/a1` that is `[x, y] → [x·k + (1−k)/2, y·s + (1−s)/2]`: a wider new frame pillarboxes
   *  (x compresses, y untouched), a narrower one letterboxes. Uniform in the drawing's *physical*
   *  space — it reads as a single-axis scale in normalized coordinates only because the two
   *  normalized spaces have different aspects — and always contracting, so every re-fitted point
   *  stays inside 0..1. Returned as the 6-coefficient `[a,b,c,d,e,f]` `ImportAlign.applyAffine`
   *  takes; `null` when either aspect is unusable or the fit is a no-op. */
  static _containFit(a0, a1) {
    if (!isFinite(a0) || !isFinite(a1) || a0 <= 0 || a1 <= 0) return null;
    const s = Math.min(a1 / a0, 1);
    const k = (a0 * s) / a1;
    if (Math.abs(k - 1) < 1e-9 && Math.abs(s - 1) < 1e-9) return null;
    return [k, 0, (1 - k) / 2, 0, s, (1 - s) / 2];
  }

  // ---- region-split room reprojection (FLOOR-5) ----

  /** The centroid (mean vertex) of a normalized polygon / point list, or the origin when empty. */
  static _centroid(pts) {
    if (!pts || !pts.length) return [0, 0];
    let sx = 0, sy = 0;
    for (const [x, y] of pts) { sx += x; sy += y; }
    return [sx / pts.length, sy / pts.length];
  }

  /** The first region whose `[x, y, w, h]` box contains `pt` (assign-by-centroid), or null. */
  static _regionFor(pt, regions) {
    const [px, py] = pt;
    return regions.find(r => {
      const [x, y, w, h] = r.box;
      return px >= x && px < x + w && py >= y && py < y + h;
    }) || null;
  }

  /** Remap a whole-page 0..1 point into a region's local 0..1 space: `(p - box) / box`, rounded
   *  to 5 dp like `FloorEditor._remapLayout`. Points outside the box get out-of-range coords that
   *  simply clip visually — the same tolerance the editor already has for stray coords. */
  static _remapPt(pt, box) {
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
   *  `applyReprojection` writes them after the build (through the authoritative `sync_rooms`).
   *
   *  Skipped (→ the plain `orphanedFloors`/`desyncedFloors` warnings) when the split also rotates
   *  the page (the room coords would be in the pre-rotation space) or when the old whole-page key
   *  can't be resolved / holds nothing — an already-split plan among them, whose old region boxes
   *  aren't retained, so its rooms can't be remapped. Async only to fetch fresh room geometry,
   *  mirroring the sibling guards. */
  async resplitReprojections(map) {
    const store = this.w.app.store;
    if (!store || !store.manifest) return [];
    const anns = await this._freshAnnotations();
    const liveFloor = (dir, fid) => {
      const mb = store.manifest.buildings.find(x => x.dir === dir);
      return mb && mb.floors.find(f => f.id === fid);
    };
    const out = [];
    for (const b of this.w.buildings) {
      const mb = map.buildings[b.folder];
      if (!mb) continue;
      const dir = ImportDiff.dirOf(mb);   // 2- or 3-segment key prefix (Location anchor nests, MODEL-4)
      // Whole-page token per drawing (resolve `b.assign` ignoring regions, chaining `last` for the
      // `same` case) — the floor id the drawing produced before it was split.
      const whole = {}; let last = null;
      for (const p of b.pdfs) {
        const t = this.w._assignToken(b.assign[p.stem], last);
        if (t) { whole[p.stem] = t; last = t; }
      }
      for (const p of b.pdfs) {
        const entry = mb.floors[p.stem];
        if (!Array.isArray(entry)) continue;   // not region-split
        const wtok = whole[p.stem];
        if (!wtok) continue;                   // no derivable whole-page id
        const oldFid = mb.abbr + wtok, oldKey = dir + '/' + oldFid;
        const lf = liveFloor(dir, oldFid);
        const newDeg = (b.angle[p.stem] && b.angle[p.stem].deg) || 0;
        const curDeg = (lf && lf.pages && lf.pages[0] && lf.pages[0].angle) || 0;
        if (lf && newDeg !== curDeg) continue; // split + rotate → leave to orphan/desync
        const rec = anns[oldKey];
        if (!rec) continue;
        const rooms = rec.rooms || [], arrows = rec.arrows || [], notes = rec.notes || [];
        if (!rooms.length && !arrows.length && !notes.length) continue;
        const regions = entry
          .filter(e => Array.isArray(e.region) && e.region.length === 4 && e.region[2] > 0 && e.region[3] > 0)
          .map(e => ({ box: e.region, fid: mb.abbr + e.token, key: dir + '/' + (mb.abbr + e.token) }));
        if (!regions.length) continue;
        const dests = new Map();
        const dest = (r) => {
          if (!dests.has(r.key)) dests.set(r.key, { dir, fid: r.fid, rooms: [], arrows: [], notes: [] });
          return dests.get(r.key);
        };
        let moved = 0, dropped = 0;
        const landedIn = new Map();   // room id → region it landed in, so arrows can follow it
        for (const room of rooms) {
          const r = ImportDiff._regionFor(ImportDiff._centroid(room.polygon), regions);
          if (!r) { dropped++; continue; }
          landedIn.set(room.id, r);
          room.polygon = (room.polygon || []).map(pt => ImportDiff._remapPt(pt, r.box));
          dest(r).rooms.push(room); moved++;
        }
        for (const a of arrows) {
          let r = a.room != null ? landedIn.get(a.room) : null;
          if (!r) r = ImportDiff._regionFor(ImportDiff._centroid(a.points), regions);
          if (!r) { dropped++; continue; }
          a.points = (a.points || []).map(pt => ImportDiff._remapPt(pt, r.box));
          dest(r).arrows.push(a);
        }
        for (const nt of notes) {
          const r = ImportDiff._regionFor([nt.x, nt.y], regions);
          if (!r) { dropped++; continue; }
          [nt.x, nt.y] = ImportDiff._remapPt([nt.x, nt.y], r.box);
          if (nt.labelStyle && nt.labelStyle.x != null)
            [nt.labelStyle.x, nt.labelStyle.y] = ImportDiff._remapPt([nt.labelStyle.x, nt.labelStyle.y], r.box);
          dest(r).notes.push(nt);
        }
        if (dests.size)
          out.push({ oldKey, label: (b.name || b.folder) + ' / ' + (lf ? lf.label : oldFid),
            moved, dropped, dests });
      }
    }
    return out;
  }

  /** Write a `resplitReprojections` plan into the freshly-loaded store: clear the source floor's
   *  migrated shapes (it may itself be a destination when a region reuses the whole-page token) and
   *  push each remapped shape onto its region floor's record (created from the new manifest via
   *  `store.floorData`). The caller's one `saveAnnotations` routes the moves/deletes through the
   *  authoritative, permission-scoped `sync_rooms`. */
  applyReprojection(r) {
    const store = this.w.app.store;
    const src = store.annotations[r.oldKey];
    if (src) { src.rooms = []; src.arrows = []; src.notes = []; }
    for (const d of r.dests.values()) {
      const rec = store.floorData(d.dir, d.fid);
      if (d.rooms.length) rec.rooms.push(...d.rooms);
      if (d.arrows.length) { rec.arrows = rec.arrows || []; rec.arrows.push(...d.arrows); }
      if (d.notes.length) { rec.notes = rec.notes || []; rec.notes.push(...d.notes); }
    }
  }

  /** Apply the opted-into siteplan hotspot re-fit (IMPORT-11) to the freshly-loaded store and
   *  persist it through the normal `saveSiteplan`. `plan` is the `{from, to}` the pre-build offer
   *  measured; the *new* aspect is re-read from the rebuilt manifest (the real rendered `w`/`h`,
   *  authoritative over the preview estimate) and only falls back to `plan.to` when the manifest
   *  lost its siteplan block. Returns `{ note, undo }` — a sentence for the caller's single build
   *  toast and, on success, the callback restoring + re-saving the pre-re-fit hotspots — or `null`
   *  when there was nothing to re-fit (degenerate aspects, or no hotspots left). A failed save
   *  reports `note` with no `undo`, so the caller never shows a dead Undo button. Everything is
   *  folded into that one toast because `Toast` reuses a single element (a second call clobbers
   *  the first). */
  async applySiteplanRefit(plan) {
    const store = this.w.app.store;
    const sp = store.manifest && store.manifest.siteplan;
    const to = (sp && sp.w && sp.h) ? sp.w / sp.h : plan.to;
    const t = ImportDiff._containFit(plan.from, to);
    const before = store.siteHotspots || [];
    if (!t || !before.length) return null;
    const snapshot = JSON.parse(JSON.stringify(before));
    for (const h of before) {
      h.poly = (h.poly || []).map(([x, y]) => {
        const p = ImportAlign.applyAffine(t, x, y);
        return [+p[0].toFixed(5), +p[1].toFixed(5)];   // 5 dp, matching `_remapPt`
      });
    }
    try { await store.saveSiteplan(); }
    catch (e) {
      // Leave nothing half-applied: put the originals back in memory so the map still matches the
      // DB, and report it rather than offering an Undo for a write that never happened.
      store.siteHotspots = snapshot;
      store.recomputeSiteDirty();
      console.error('Siteplan hotspot re-fit failed', e);
      return { note: ' The siteplan hotspots could not be re-fitted (' + e.message
        + ') — they are unchanged and may no longer line up.' };
    }
    return {
      note: ' Siteplan hotspots were re-fitted to the new plan’s proportions.',
      undo: async () => {
        store.siteHotspots = snapshot;
        try { await store.saveSiteplan(); }
        catch (e) { Toast.show('Could not undo the re-fit: ' + e.message, true); return; }
        this.w.app.router();
      },
    };
  }
}
