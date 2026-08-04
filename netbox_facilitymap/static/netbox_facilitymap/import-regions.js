'use strict';
/* import-regions.js — ImportRegions: the import wizard's box-drawing surfaces, which share a
   viewport, a zoom bar, and the drag-a-normalized-box gesture:
     - codeSection()       the GLOBAL code region as a SUMMARY, in the merged Site plan step
                           (IMPORT-37): the current box shown as the crop it produces, plus a way
                           into the editor below. That one box is applied as a crop to every floor
                           card (`_codeCropThumb`) so floors are recognizable at a glance, and is
                           the only place the floor-code reader looks.
     - openPick(b, opts)   the code-region EDITOR, for one outlier building's `codeRegion` override
                           or — with a null building — for the global region itself (IMPORT-63).
                           A detour off whichever step called it.
     - openSplit(b, p)     mark SEVERAL boxes on one drawing (FLOOR-4), each its own
                           floor, so a split-level sheet fans into several floors at build.

   Holds a wizard back-ref (`this.w`), the ImportUploader shape: the editors render through the
   flow's `_stage`, persist through `_saveDraft`, and return to `_stepMap`. Boxes are stored
   normalized 0..1 over the drawing image, the same convention as everything else in the map
   (architecture §10 coordinates) — the overlay shares the <img>'s box, so pointer positions map
   straight to image space via `getBoundingClientRect()` at any zoom. The shared −/Fit/+ zoom bar
   lives on `ImportPreview` (it also serves the align editor).

   A code-crop box also records the **page geometry of the sheet it was marked on** (`pageSize`), so
   `adapt` can re-anchor it onto a differently-shaped sheet instead of stretching fractions across a
   page of another shape (IMPORT-51). */

class ImportRegions {
  /** Aspect ratios closer than this (as a ratio of ratios) count as the *same sheet shape*. Two
   *  same-shaped sheets are a template printed at two scales — the title block scales with the
   *  sheet, so plain fractions are exactly right and re-anchoring would be actively wrong. Only a
   *  genuinely differently-shaped sheet is a different template, where the title block instead
   *  keeps its physical size. Loose enough to absorb a point-rounded page box, tight enough that a
   *  D-vs-E sheet (3:2 vs 4:3) is never mistaken for the same shape. */
  static ASPECT_TOLERANCE = 1.02;

  /** A box whose centre sits inside this band of an axis is treated as *centred* on that axis
   *  rather than anchored to either edge — a bottom-centre title strip must not be dragged to a
   *  corner just because one is marginally nearer. */
  static CENTRE_BAND = [0.4, 0.6];

  /** Extra margin added per side when a box is re-anchored, as a fraction of the box itself. The
   *  re-anchor is a geometric estimate, not a reading of the sheet, so it absorbs the residual
   *  drift: a slightly larger crop costs OCR nothing, a miss costs the operator a manual pass. */
  static ADAPT_MARGIN = 0.1;

  constructor(wizard) {
    this.w = wizard;
  }

  /** The page geometry of one card row's sheet — `{w, h, unit}` in the format's own unit (a PDF's
   *  points), or null when the format has none (every raster: its pixels are a scan resolution, not
   *  a sheet size). Read from the scan inventory's per-drawing `sizes`/`unit`, indexed by the row's
   *  1-based `page` so an exploded `#pN` row gets its *own* page's size. */
  static pageGeom(p) {
    const sizes = p && p.sizes;
    if (!Array.isArray(sizes) || !sizes.length || !p.unit) return null;
    const s = sizes[Math.max(0, (p.page || 1) - 1)] || sizes[0];
    if (!Array.isArray(s) || !(s[0] > 0) || !(s[1] > 0)) return null;
    return { w: s[0], h: s[1], unit: p.unit };
  }

  /** True when two page geometries describe differently-*shaped* sheets — comparable (both known,
   *  same unit) but more than `ASPECT_TOLERANCE` apart in aspect ratio. False whenever the two
   *  can't be compared at all, so an unknown geometry never counts as a mismatch. */
  static shapeDiffers(a, b) {
    if (!a || !b || !a.unit || a.unit !== b.unit) return false;
    // A `pageSize` restored from a draft is unvalidated user-writable JSON, so re-check the
    // dimensions here rather than trusting `pageGeom`'s guard to have run on both sides.
    if (!(a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0)) return false;
    const ratio = (a.w / a.h) / (b.w / b.h);
    return Math.max(ratio, 1 / ratio) > ImportRegions.ASPECT_TOLERANCE;
  }

  /** How many of `rows` sit on a sheet shaped unlike `sample`'s — the count behind the pick
   *  screens' mixed-geometry note. */
  static geomOutliers(sample, rows) {
    const g = ImportRegions.pageGeom(sample);
    if (!g) return 0;
    return rows.filter(p => ImportRegions.shapeDiffers(g, ImportRegions.pageGeom(p))).length;
  }

  /** A marked code region (`{x, y, w, h}` plus the `pageSize` of the sheet it was marked on) mapped
   *  onto a `target` sheet's geometry. Always returns a **fresh** plain `{x, y, w, h}`, so callers
   *  can hand it straight to the OCR endpoint without leaking `pageSize` or aliasing the stored box.
   *
   *  Pure fractions already survive a different *render* — the box is normalized against the image
   *  and every consumer re-derives pixels from that image's own size. What they don't survive is a
   *  different sheet *shape*: a box over the title block of a 34x22 landscape sheet, as fractions,
   *  lands on a geometrically different patch of an 8.5x11 portrait one (IMPORT-51). So when the
   *  two sheets are comparable and differently shaped, each axis is re-anchored to the page edge the
   *  box was nearest and given back its **physical** size, then widened by `ADAPT_MARGIN`.
   *
   *  Everything else falls back to today's plain fractions, deliberately: a legacy box with no
   *  `pageSize`, a target of unknown geometry, two sheets measured in different units (a PDF's
   *  points against nothing comparable), and — the common case — two same-shaped sheets, which are
   *  one template at two print scales and need no correction at all. This stays **geometry-only**:
   *  it never looks at what the sheet says (§10 in-app-import — region correctness remains the
   *  operator's call, with the per-building `codeRegion` override as the escape hatch). */
  static adapt(region, target) {
    if (!region) return region;
    const box = { x: region.x, y: region.y, w: region.w, h: region.h };
    const src = region.pageSize;
    if (!ImportRegions.shapeDiffers(src, target)) return box;
    const [x, w] = ImportRegions._axis(box.x, box.w, src.w, target.w);
    const [y, h] = ImportRegions._axis(box.y, box.h, src.h, target.h);
    return ImportRegions._widen({ x, y, w, h }, ImportRegions.ADAPT_MARGIN);
  }

  /** One axis of `adapt`: re-express a `pos`/`len` fraction of a `src`-long page as a fraction of a
   *  `dst`-long one, keeping the box's physical length and its distance from whichever page edge it
   *  was nearest (or its centre, inside `CENTRE_BAND`). Returns `[pos, len]` clamped into 0..1 — a
   *  box longer than the target page collapses onto the whole axis rather than overflowing it. */
  static _axis(pos, len, src, dst) {
    const size = Math.min(len * src / dst, 1);
    const mid = pos + len / 2;
    const [lo, hi] = ImportRegions.CENTRE_BAND;
    let start;
    if (mid < lo) start = pos * src / dst;                          // anchored to the low edge
    else if (mid > hi) start = 1 - (1 - pos - len) * src / dst - size;   // to the high edge
    else start = mid - size / 2;                                    // centred on this axis
    return [Math.max(0, Math.min(1 - size, start)), size];
  }

  /** The **pending-box state** of a code-region pick, as a plain object with no DOM in it
   *  (IMPORT-63). A pick used to write `building.codeRegion` on pointer-*up*, while the screen was
   *  still offering a "Cancel" that only skipped the draft save — so the box the operator thought
   *  they had backed out of stayed live in the session model and went on driving the card crops and
   *  the background sweep. Holding the drag here instead means the model is written **once**, by the
   *  confirm button, and Cancel is simply the absence of that write.
   *
   *  `result()` is what confirming commits: the last box dragged, or — when nothing was dragged —
   *  the region the pick opened on, so confirming an untouched screen is a no-op rather than a
   *  clear. Split out of the editor precisely so this semantics can be asserted without a browser. */
  static pickState(initial) {
    return {
      original: initial || null,
      pending: null,
      set(box) { this.pending = box; },
      dirty() { return this.pending !== null; },
      result() { return this.pending || this.original; },
    };
  }

  /** A freshly-dragged box plus the `pageSize` of the sheet it was measured against — the stored
   *  shape `adapt` re-anchors from. The key is omitted when the sample's format has no page size (a
   *  raster's pixels are a scan resolution, not a sheet), which is exactly the pre-IMPORT-51 shape,
   *  so an unmeasurable sample and an old draft take the same plain-fractions path. Only ever
   *  applied to a **new** box: a region the operator didn't re-drag keeps the geometry it was
   *  originally measured against, which is the whole basis of its adaptation. */
  static stamp(box, pageSize) {
    return (box && pageSize) ? { ...box, pageSize } : box;
  }

  /** The normalized 0..1 box between two already-normalized corner points, in any drag direction.
   *  Split out of `_onBoxDrag` so the gesture's arithmetic is testable without a pointer or a DOM. */
  static boxFrom(x0, y0, x1, y1) {
    return { x: Math.min(x0, x1), y: Math.min(y0, y1),
      w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  }

  /** Whether a dragged box is big enough to mean anything — under half a percent on either axis it
   *  is a stray click, not a mark, and committing it would replace a good region with a sliver. */
  static isUsableBox(b) {
    return !!b && b.w > 0.005 && b.h > 0.005;
  }

  /** Grow a normalized box by `m` of its own size on each side, clipped to the page. */
  static _widen(b, m) {
    const x = Math.max(0, b.x - b.w * m), y = Math.max(0, b.y - b.h * m);
    return { x, y,
      w: Math.min(1, b.x + b.w * (1 + m)) - x,
      h: Math.min(1, b.y + b.h * (1 + m)) - y };
  }

  /** The **global** code-crop question, as the second half of the merged Site plan step
   *  (IMPORT-37): where on a drawing the floor-identifying code/caption sits, stored as one box
   *  normalized 0..1 so it maps onto every drawing's render. Each floor card then shows a close-up
   *  crop of just that spot (see `_codeCropThumb`), and the floor-code reader reads exactly it.
   *
   *  This is the question's **summary**, not its editor (IMPORT-63): the current answer as the crop
   *  it produces, plus a button into `openPick`. It used to carry an inline drag surface of its
   *  own, which made the global box the one region with no proper picker screen — no crop preview,
   *  no confirm step — while the *per-building* override got one. An operator who never found this
   *  half of the step also got no OCR at all, silently, so the map step now links here too
   *  (`ImportFlow._ocrIdleNotice`), and both routes land on the same editor.
   *
   *  A section rather than a screen of its own, so the step owning it can ask both of its
   *  questions at once and commit them with one Continue. Marking is optional — leaving the box
   *  unmarked falls back to full-drawing thumbnails, which is why the section carries no gate of
   *  its own. Returns `null` when there is no floor drawing to sample (a siteplan-only import has
   *  nothing to crop), so the host step renders just its site-plan half. */
  codeSection() {
    const w = this.w;
    const p = this._sample();
    if (!p) return null;
    const marked = w._codeRegion;

    const body = [
      Dom.el('h3', { class: 'imp-substep' }, 'Where does a drawing say which floor it is?'),
      Dom.el('p', { class: 'hint' },
        'Mark the part of the drawing that says which floor it is (e.g. “SECOND BASEMENT LEVEL '
        + '(B2)”). Each floor card then shows a close-up of just that spot, so you can tell the '
        + 'floors apart at a glance — and, if this install reads floor codes, it is the only place '
        + 'the reader looks. Optional: leave it unmarked to see the whole drawing on each card and '
        + 'read no codes.'),
      Dom.el('span', { class: 'hint' }, marked
        ? 'Marked — this is the close-up every floor card shows:'
        : 'Not marked — floor cards show the whole drawing.'),
    ];
    // Show the marked box as what it actually crops, not as a rectangle on a shrunken sheet: the
    // crop is the thing the operator is deciding about (IMPORT-63).
    if (marked)
      body.push(Dom.el('div', { class: 'imp-region-crops' }, [
        ImportPreview.cropBox(ImportPreview.previewUrl(p.pdf, p.page),
          ImportRegions.adapt(marked, ImportRegions.pageGeom(p)))]));
    const actions = [Dom.el('button', {
      onclick: () => this.openPick(null, { back: () => w._stepSiteplan() }) },
      marked ? 'Change the floor-code region…' : 'Set the floor-code region…')];
    if (marked)
      actions.push(Dom.el('button', { onclick: async () => {
        w._codeRegion = null;
        w.ocr.regionChanged(null);       // its reads were taken through the box just removed
        await w._saveDraft();
        w._stepSiteplan();
      } }, 'Clear the region (show whole drawings)'));
    body.push(Dom.el('div', { class: 'imp-region-state' }, actions));
    return Dom.el('section', {}, body);
  }

  /** The floor-code region editor, for **one building's** `codeRegion` override (`building` given)
   *  or for the **global** region every other building falls back to (`building` null, IMPORT-63).
   *  One screen for both: they ask the identical question of the identical picture, and keeping two
   *  surfaces is what left the global box with no crop preview and no confirm step. Reached from the
   *  map step's per-building button, the edit hub's per-building row, the Site plan step's summary
   *  (`codeSection`), and the map step's "OCR has nowhere to look" notice.
   *
   *  A **detour** (no `stepKey`, so no step chrome): it refines a setting rather than advancing the
   *  walk. `opts.back` is where Cancel and confirm return to — the map step by default, the Site
   *  plan step when that is where the operator came from.
   *
   *  **The model is written once, by "Use this region"** — never by the drag. Everything the screen
   *  shows in the meantime comes off a `pickState`, so Cancel genuinely cancels; before this the
   *  drag committed on pointer-up and Cancel only skipped the draft save, leaving a box the
   *  operator had backed out of driving the card crops and the background sweep.
   *
   *  Two previews sit beside the drag surface, and the second is the point: a box is re-anchored
   *  and **widened** when it lands on a differently-shaped sheet (`adapt`), which is a geometric
   *  estimate the operator never got to see — and the reason a read could pick up text nobody
   *  boxed. So the screen shows both the crop as marked and the crop as OCR will actually take it
   *  on an outlier sheet. */
  openPick(building, opts = {}) {
    const w = this.w;
    const back = opts.back || (() => w._stepMap());
    const p = this._sample(building);
    if (!p) {   // no floor drawing to sample
      Toast.show(building
        ? 'No drawing to re-mark in ' + (building.name || building.folder)
        : 'No floor drawing to mark a region on.', true);
      return back();
    }
    const who = building ? (building.name || building.folder) : null;
    const scope = building ? [building] : w.buildings;

    const view = w._stage(who ? 'Set ' + who + '’s floor-code region'
      : 'Set the floor-code region');
    w._detourBack(view, '← Back without changing it', () => back());
    view.append(Dom.el('p', { class: 'hint' },
      'Drag a box around the part of the drawing that says which floor it is '
      + '(e.g. “SECOND BASEMENT LEVEL (B2)”). ' + (who
        ? 'It replaces the region marked for the rest of the facility, for this building only. '
        : 'It applies to every building that hasn’t been given its own region. ')
      + 'Zoom in if it’s small; scroll to pan. Nothing changes until you press “Use this region”.'));
    // Which image this is: the code pickers deliberately draw on the UNROTATED render, because the
    // reader crops at angle 0, while the split editor draws on the straightened one. Two editors
    // that look alike and differ in their coordinate space have to say so (IMPORT-63).
    view.append(Dom.el('p', { class: 'hint' },
      'This is the drawing as uploaded, unrotated — the floor-code reader crops it in exactly this '
      + 'orientation, so a card you straightened is still marked here as it came in.'));
    const note = this._shapeNote(p, scope, who
      ? 'If one lands wrong, re-mark it on a drawing shaped like the rest of them.'
      : 'If one lands wrong, give that building its own region from its floor cards.');
    if (note) view.append(note);

    const { img, sel, els } = this._sampleView(p);
    view.append(...els);

    const state = ImportRegions.pickState(building ? building.codeRegion : w._codeRegion);
    const pageSize = ImportRegions.pageGeom(p);
    const crops = Dom.el('div', { class: 'imp-region-crops' });
    const cropNote = Dom.el('p', { class: 'hint' });
    const go = Dom.el('button', { class: 'primary' }, 'Use this region');
    // What confirming would store: a box just dragged, stamped with THIS sheet's geometry — or, if
    // nothing was dragged, the region exactly as it was already stored, geometry included.
    const resolved = () => (state.dirty()
      ? ImportRegions.stamp(state.pending, pageSize) : state.original);
    const paint = () => {
      const box = resolved();
      go.disabled = !box;
      crops.textContent = '';
      cropNote.textContent = '';
      if (!box) return;
      // Shown only on a sheet whose shape actually triggers the re-anchor. Absent for the common
      // uniform set, where `adapt` is a no-op and there is nothing to preview.
      const outlier = this._outlierSample(p, scope);
      if (!outlier) return;
      const n = ImportRegions.geomOutliers(p, scope.flatMap(b => ImportRegions._floorDrawings(b)));
      crops.append(this._cropFigure('What OCR reads on a differently-shaped sheet',
        outlier, box, ImportRegions.pageGeom(outlier)));
      cropNote.textContent = n + (n === 1 ? ' drawing uses' : ' drawings use')
        + ' a differently-shaped sheet. There the box can’t be the same fractions of the page, so '
        + 'it is re-anchored from the page edge it sat nearest, kept at its physical size, and '
        + 'grown '
        + Math.round(ImportRegions.ADAPT_MARGIN * 100) + '% a side to absorb the estimate — which '
        + 'is why that crop is wider than the box you dragged.';
    };
    ImportRegions._onBoxDrag(img,
      (r) => this._drawSel(sel, r),
      (box) => { state.set(box); paint(); });
    if (state.result()) this._drawSel(sel, state.result());
    paint();
    view.append(crops, cropNote);

    go.addEventListener('click', async () => {
      const box = resolved();
      if (!box) return;
      if (building) building.codeRegion = box; else w._codeRegion = box;
      // Re-marking invalidates every read taken through the old box and re-arms the background
      // sweep so the new one is actually read (IMPORT-53) — but ONLY when the box actually changed.
      // Confirming an untouched pick is a no-op, and firing this for it would discard every
      // unanswered drawing's read and re-sweep the whole facility for nothing.
      if (state.dirty()) w.ocr.regionChanged(building);
      if (building)
        w._bIdx = Math.max(0, w._mappableBuildings().indexOf(building));   // land back on it
      await w._saveDraft();
      back();
    });

    const actions = [go];
    // Offer to drop the region — a building's override falls back to the global one when there is
    // one, the global region falls back to full-drawing thumbnails and no reading at all.
    const current = building ? building.codeRegion : w._codeRegion;
    if (current)
      actions.push(Dom.el('button', { onclick: async () => {
        if (building) building.codeRegion = null; else w._codeRegion = null;
        w.ocr.regionChanged(building);   // its reads were taken through the box it just lost
        await w._saveDraft(); back(); } },
      building && w._codeRegion ? 'Use the facility-wide region instead'
        : 'Clear the region (show whole drawings)'));
    actions.push(Dom.el('button', { onclick: () => back() }, 'Cancel'));
    view.append(Dom.el('div', { class: 'imp-actions' }, actions));
  }

  /** One captioned crop preview for the picker: what `region` (a stored box, `pageSize` and all)
   *  crops out of drawing `p`, after `adapt`ing it to `p`'s own sheet `geom`. Captioned so the
   *  operator can tell which sheet it came off, since it is only shown at all when that sheet's
   *  shape differs from the one the box was drawn on. */
  _cropFigure(caption, p, region, geom) {
    return Dom.el('figure', { class: 'imp-region-crop' }, [
      ImportPreview.cropBox(ImportPreview.previewUrl(p.pdf, p.page),
        ImportRegions.adapt(region, geom)),
      Dom.el('figcaption', { class: 'hint' }, caption),
    ]);
  }

  /** A drawing in `scope` whose sheet is shaped unlike `sample`'s — the one worth previewing the
   *  adapted box on, since it is where `adapt` actually does something. Null when every comparable
   *  sheet matches, which is the common case. */
  _outlierSample(sample, scope) {
    const g = ImportRegions.pageGeom(sample);
    if (!g) return null;
    for (const b of scope)
      for (const row of ImportRegions._floorDrawings(b))
        if (ImportRegions.shapeDiffers(g, ImportRegions.pageGeom(row))) return row;
    return null;
  }

  /** Position the overlay rectangle over the sample image from a normalized 0..1 box. */
  _drawSel(sel, r) {
    sel.classList.remove('hidden');
    sel.style.left = (r.x * 100) + '%'; sel.style.top = (r.y * 100) + '%';
    sel.style.width = (r.w * 100) + '%'; sel.style.height = (r.h * 100) + '%';
  }

  /** The drawings a code-crop pick applies to: those that actually carry a floor code — never the
   *  site plan (`type:'none'`, it has none). */
  static _floorDrawings(b) {
    return (b.pdfs || []).filter(pp => b.assign[pp.stem] && b.assign[pp.stem].type !== 'none');
  }

  /** The drawing a code-crop pick is marked on: the first drawing that actually carries a floor
   *  code. Scoped to `building` when given (the per-building override), else the first floor
   *  drawing anywhere in the import. Null when the import has none at all. */
  _sample(building) {
    const b = building
      || this.w.buildings.find(x => ImportRegions._floorDrawings(x).length);
    return (b && ImportRegions._floorDrawings(b)[0]) || null;
  }

  /** A one-line warning when the drawings this pick applies to are not all the same *shape* of
   *  sheet as the sample (IMPORT-51) — a box marked on a landscape sheet is re-anchored from the
   *  page edge it sat nearest when it reaches a portrait one, which usually lands but is an
   *  estimate. Null when every comparable sheet matches (the common case), so a uniform set says
   *  nothing. `scope` is the buildings the pick covers: the whole import for the global pick, one
   *  building for its override. */
  _shapeNote(sample, scope, tail) {
    const rows = scope.flatMap(b => ImportRegions._floorDrawings(b));
    const n = ImportRegions.geomOutliers(sample, rows);
    if (!n) return null;
    return Dom.el('p', { class: 'hint' },
      n + (n === 1 ? ' drawing uses' : ' drawings use') + ' a differently-shaped sheet than this '
      + 'one. The box is re-anchored from the nearest page edge for those, and widened a little. '
      + tail);
  }

  /** The sample drawing in a scrollable, zoomable canvas, shared by both code-crop surfaces. Zoom
   *  widens the canvas inside the viewport (scroll to pan); the image fills the canvas and the
   *  overlay is positioned by % of it, so the box tracks the image at any zoom. Returns the image
   *  + overlay (for the drag binding) and the `[zoom bar, viewport]` pair the caller appends. */
  _sampleView(p) {
    const img = Dom.el('img', { class: 'imp-region-img', src: ImportPreview.previewUrl(p.pdf, p.page) });
    const sel = Dom.el('div', { class: 'imp-region-sel hidden' });
    const canvas = Dom.el('div', { class: 'imp-region-canvas' }, [img, sel]);
    const viewport = Dom.el('div', { class: 'imp-region-view' }, [canvas]);
    ImportPreview.applyZoom(canvas, this.w._regionZoom);
    return { img, sel, els: [ImportPreview.zoomBar(canvas, this.w._regionZoom), viewport] };
  }

  /** Region-split editor: draw one or more boxes over a single drawing and give each its own
   *  floor, so the page fans into several floors at build (`_resolveFloors` emits the
   *  `[{token, region}]` shape `preprocess._page_entries` consumes). Follows the `openPick`
   *  precedent — the drawing sits in a scrollable, zoomable viewport — but supports *several* boxes,
   *  each a floor. The image renders at the card's straightening `angle`, so a box is marked in the
   *  same straightened space the backend crops (crop-after-rotate). Boxes + per-region assignments
   *  live on `b.regions[p.stem]` and persist in the draft. Reached from a card's "Split into
   *  floors…" button; empty the list (Clear all / removing every region) to fall back to one
   *  whole-page floor. */
  openSplit(b, p) {
    const w = this.w;
    const view = w._stage('Split ' + p.file + ' into floors');
    w._detourBack(view, '← Back to floor mapping', () => w._stepMap());
    view.append(Dom.el('p', { class: 'hint' },
      'Drag a box around each part of this drawing that is its own floor, then assign a floor to '
      + 'each box below. One plan can map to several floors this way (e.g. a split-level sheet). '
      + 'Zoom in if the drawing is dense; scroll to pan. Each box is added as soon as you release '
      + 'the mouse; remove one with its Remove button.'));
    // The counterpart of the code picker's own orientation note (IMPORT-63). These two editors look
    // alike and are NOT in the same space: this one draws on the STRAIGHTENED drawing, because the
    // build crops after rotating, while the code pickers draw on the unrotated render the reader
    // crops. Only shown once there is a rotation to be confused by.
    if ((b.angle[p.stem] && b.angle[p.stem].deg) || 0)
      view.append(Dom.el('p', { class: 'hint' },
        'This is the drawing straightened by the rotation you set on its card — boxes here are '
        + 'marked in that upright orientation, unlike the floor-code region, which is marked on '
        + 'the drawing as uploaded.'));

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
          w.cards._floorButtons(b, r.assign, () => { w._saveDraft(); redraw(); }),
          Dom.el('button', { class: 'imp-floor', onclick: () => {
            regions.splice(i, 1); w._saveDraft(); redraw();
          } }, 'Remove'),
        ]));
      });
    };

    this._attachAdd(img, b, p, redraw);
    view.append(ImportPreview.zoomBar(canvas, w._regionZoom));
    view.append(viewport);
    view.append(list);
    ImportPreview.applyZoom(canvas, w._regionZoom);
    redraw();

    view.append(Dom.el('div', { class: 'imp-actions' }, [
      Dom.el('button', { class: 'primary',
        onclick: async () => { await w._saveDraft(); w._stepMap(); } }, 'Done'),
      Dom.el('button', { onclick: async () => {
        if (b.regions[p.stem].length && !confirm('Remove all regions from this drawing?')) return;
        b.regions[p.stem] = []; await w._saveDraft(); w._stepMap();
      } }, 'Clear all'),
      Dom.el('button', { onclick: () => w._stepMap() }, 'Cancel'),
    ]));
  }

  /** Drag on the split editor's canvas to add a region box (FLOOR-4): a press-drag-release marks a
   *  new normalized 0..1 box, appended to `b.regions[p.stem]` as a fresh `unassigned` floor. Shares
   *  the `_onBoxDrag` gesture with the code-crop picker, drawing into its own preview element that
   *  is cleared on release (the committed box is repainted by `onAdd`, which also refreshes the
   *  region list). */
  _attachAdd(img, b, p, onAdd) {
    const preview = Dom.el('div', { class: 'imp-region-sel hidden' });
    img.parentElement.append(preview);
    const draw = (r) => {
      preview.classList.remove('hidden');
      preview.style.left = (r.x * 100) + '%'; preview.style.top = (r.y * 100) + '%';
      preview.style.width = (r.w * 100) + '%'; preview.style.height = (r.h * 100) + '%';
    };
    ImportRegions._onBoxDrag(img, draw, (box) => {
      b.regions[p.stem].push(
        { box, assign: { type: 'unassigned', num: 1, token: null, label: '' } });
      this.w._saveDraft();
      onAdd();
    }, () => preview.classList.add('hidden'));
  }

  /** The shared press-drag-release gesture behind both editors: track a normalized 0..1 box over
   *  `img`, calling `draw(box)` live, and `commit(box)` on release. Pointer coordinates map
   *  straight to image space via the image's live `getBoundingClientRect()`, so the box is correct
   *  at any zoom, and are clamped to 0..1 so a drag off the edge still yields a valid box. A
   *  too-small drag (< 0.5% on either axis) is ignored, so a stray click marks nothing. `onEnd`
   *  (optional) runs on every release, committed or not — the split editor hides its live preview. */
  static _onBoxDrag(img, draw, commit, onEnd) {
    img.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const rect = img.getBoundingClientRect();
      const nx = (c) => Math.max(0, Math.min(1, (c - rect.left) / rect.width));
      const ny = (c) => Math.max(0, Math.min(1, (c - rect.top) / rect.height));
      const x0 = nx(e.clientX), y0 = ny(e.clientY);
      let pending = null;
      try { img.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      const move = (ev) => {
        pending = ImportRegions.boxFrom(x0, y0, nx(ev.clientX), ny(ev.clientY));
        draw(pending);
      };
      const up = () => {
        img.removeEventListener('pointermove', move);
        img.removeEventListener('pointerup', up);
        if (onEnd) onEnd();
        if (ImportRegions.isUsableBox(pending)) commit(pending);
      };
      img.addEventListener('pointermove', move);
      img.addEventListener('pointerup', up);
    });
  }
}
