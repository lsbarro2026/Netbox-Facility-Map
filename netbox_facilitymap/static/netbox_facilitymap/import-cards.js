'use strict';
/* import-cards.js — ImportCards: the map step's per-building card grid — the building section
   (the name field + binding line, the anchor drill disclosure MULTI-5, the fallback-mode banner,
   IMPORT-50) and one card per drawing: thumbnail / code-crop close-up, straightening rotation,
   in-place Replace (REPL-1), and the floor selector (Location buttons or the floor-type
   vocabulary, region-split summary, "+ Add floor" search).

   Holds a wizard back-ref (`this.w`), the ImportUploader shape. The map-step *shell* — the
   carousel, size slider, build gate, and the scroll-preserving in-place re-renders (IMPORT-2:
   `_rerenderBuildingSection`/`_refreshBuildActions`) — stays on the flow, which reaches this as
   `this.cards.section(b)`; a card's own patches route back through those same flow methods, so
   the IMPORT-2 idiom is unchanged. `ImportRegions`' split editor reuses `_floorButtons` for its
   per-region floor pickers, exactly as it did on the flow. */

class ImportCards {
  constructor(wizard) {
    this.w = wizard;
  }

  /** Boundary validation for a building's editable `name`/`slug`, surfaced inline in the map step
   *  so a problem shows as the user types rather than only as a late build-time toast (the empty-slug
   *  and anchor-collision guards in `_build` remain the hard safety net). Returns an error string, or
   *  null when the field is fine. `name`: required. `slug`: required, a valid slug charset (lenient
   *  enough never to flag a real bound `Location.slug`), matching the bound object's own slug, and
   *  resolving to an **anchor** no other floor-contributing building shares.
   *
   *  **Uniqueness is anchor-level, never slug-level (IMPORT-28).** Under a Location anchor every
   *  building on a campus legitimately carries the *same* campus site slug and is distinguished by
   *  its building Location, so testing the slug alone flagged every building of a correct campus
   *  import as a duplicate. Keying off `ImportFlow.anchorKey` makes this warning exactly the guard
   *  `_buildMap` enforces — never stricter — and lets the message name the real conflict.
   *
   *  Everything here is advisory: it shows a red border and a line, and gates nothing (`_build`'s
   *  guards do). That is what lets the mismatch rung stay a warning rather than a lockout, so an
   *  unbound or hand-typed import keeps its escape hatch. */
  _buildingFieldError(b, key) {
    const v = (b[key] || '').trim();
    if (key === 'name') return v ? null : 'Building name is required.';
    // slug
    if (!v) return 'Site slug is required.';
    if (!/^[-a-zA-Z0-9_]+$/.test(v)) return 'Use letters, numbers, hyphens, and underscores only.';
    // A bound building's slug *is* the bound object's. Typing anything else emits a manifest
    // `siteSlug` no NetBox Site answers to, and `_loadFloors` then quietly finds no floors and falls
    // back to the floor-type vocabulary — a failure with no visible cause, which is why it's called
    // out here rather than left to be discovered after a build.
    if (b.nbSite && b.nbSite.slug && b.nbSite.slug !== v)
      return 'Doesn’t match the bound NetBox site “' + b.nbSite.slug + '”, so this building’s '
        + 'floors won’t resolve. Rebind this folder on the Map-buildings step to change it.';
    const anchor = ImportFlow.anchorKey(b);
    const clash = this.w._floorBuildings()
      .find(o => o !== b && ImportFlow.anchorKey(o) === anchor);
    if (!clash) return null;
    const other = clash.name || clash.folder;
    return b.nbBuilding
      ? '“' + other + '” is bound to the same NetBox building (' + anchor + '). Bind each folder to '
        + 'its own building on the Map-buildings step.'
      : '“' + other + '” is bound to the same NetBox site (' + anchor + ').';
  }

  /** The read-only binding line a bound building shows in place of the old editable slug field
   *  (IMPORT-50): the anchor identity — the thing every uniqueness test actually keys off
   *  (`ImportFlow.anchorKey`, IMPORT-28) — spelled out by `_anchorSummary`, plus an "Edit binding"
   *  jump to the bind step. Binding changes happen there; an editable slug here could only ever
   *  break floor resolution (any value but the bound object's own slug is an error).
   *
   *  Validation still runs over the *stored* slug: a stale draft can carry a slug that no longer
   *  matches the bound object, and two folders can resolve to one anchor — both must stay visible
   *  even with no field to type in, so `_buildingFieldError`'s verdict renders as a static error
   *  line. Bindings only change through a re-bind, which re-renders the section, so render-time
   *  validation is as fresh as the old input listener was. */
  _bindingLine(b) {
    const line = Dom.el('div', { class: 'imp-binding' }, [
      Dom.el('span', { class: 'hint',
        title: 'The NetBox object this folder builds under (' + ImportFlow.anchorKey(b) + '). Two '
          + 'folders may share a campus site slug, but never this whole anchor.' },
        'NetBox anchor: ' + this.w._anchorSummary(b)),
      Dom.el('button', { class: 'imp-link',
        onclick: () => this.w._stepBuildings(b) }, 'Edit binding'),
    ]);
    const msg = this._buildingFieldError(b, 'slug');
    if (msg) line.append(Dom.el('span', { class: 'imp-field-err' }, msg));
    return line;
  }

  /** The floor-source banner for a building on the floor-**type** fallback (IMPORT-50): names the
   *  mode outright — these floors build generic ids, not NetBox Location slugs — and groups the
   *  one setting that only exists in this mode, the floor-id prefix. Before this, the prefix was a
   *  bare conditionally-appearing "Floor prefix" field: a mystery to anyone whose buildings were
   *  bound, since Location mode forces the prefix empty (the floor id must equal the real
   *  `Location.slug`, see `_build`) and so never shows it. `field` is `section`'s plain-field
   *  builder. Not rendered while the floor list is still loading — the mode isn't known yet — nor
   *  when `_floorLoadNote` is about to explain a load failure on every card (the vocabulary is
   *  then a fallback with a named cause, not this building's mode). */
  _fallbackSource(b, field) {
    return Dom.el('div', { class: 'imp-bsource' }, [
      Dom.el('span', { class: 'hint' },
        'This building’s floors aren’t linked to NetBox Locations — they use the generic '
        + 'vocabulary (Basement / Ground / Level N / Roof).'),
      field('Floor prefix', 'abbr', '6em'),
    ]);
  }

  /** The building header + card grid. The header groups its controls by kind (IMPORT-50) instead
   *  of interleaving them: **identity** (the name, and the NetBox binding — a read-only anchor
   *  line once bound, the editable slug escape hatch while not), then the **floor source** (the
   *  fallback-mode banner, or the Location-anchor drill disclosure), then the bulk **floor tools**
   *  (`ImportBulk.controls`, which also houses the floor-code region/OCR row). */
  section(b) {
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
    // ---- identity: the name, and the NetBox binding ----
    // Bound, the binding renders read-only (`_bindingLine`) — typing any slug but the bound
    // object's own is an error, so the field only existed to cause one. Unbound keeps the editable
    // slug: the escape hatch for a hand-typed import with no NetBox to bind to.
    const identity = [vfield('Building name', 'name', '15em')];
    identity.push(b.nbSite ? this._bindingLine(b) : vfield('Site slug', 'slug', '9em'));
    const head = Dom.el('div', { class: 'imp-bhead' },
      [Dom.el('div', { class: 'imp-bidentity' }, identity)]);
    // ---- floor source ----
    const drill = this._anchorDrillControl(b);
    if (drill) head.append(drill);
    if (!(Array.isArray(b.nbFloors) && b.nbFloors.length)
        && b.nbFloors !== 'loading' && !b.nbFloorsError)
      head.append(this._fallbackSource(b, field));
    // ---- floor tools ----
    // If the global code box doesn't fit this building (its title block sits elsewhere), offer a
    // re-mark scoped to just it — overrides the crop region for this folder's cards only. Shown
    // whenever the building has a markable drawing (the same `type !== 'none'` test `_stepRegionPick`
    // uses to find a sample), so it's reachable even when the global region pick was skipped.
    const markable = b.pdfs.some(p => b.assign[p.stem] && b.assign[p.stem].type !== 'none');
    const regionBtn = markable
      ? Dom.el('button', { class: 'imp-floor',
        title: 'Mark where this building’s drawings print their floor code — overrides the '
          + 'facility-wide region for this folder only.',
        onclick: () => this.w._stepRegionPick(b) }, 'Set this building’s floor-code region…')
      : null;
    const bulk = this.w.bulk.controls(b, regionBtn);
    if (bulk) head.append(bulk);
    // A single-drawing building has no bulk block, but the region re-mark must stay reachable.
    else if (regionBtn)
      head.append(Dom.el('div', { class: 'imp-bulk-row' }, [
        Dom.el('span', { class: 'imp-bulk-label' }, 'Floor codes:'), regionBtn]));
    const grid = Dom.el('div', { class: 'imp-grid' });
    for (const p of b.pdfs) grid.append(this._pdfCard(b, p));
    return Dom.el('section', { class: 'imp-building' }, [head, grid]);
  }

  /** Let the operator move a Location-anchored building's anchor **down** to one of its child
   *  Locations — the wing/zone level (MULTI-5). Null (not rendered) for a Site-anchored building,
   *  or before this building's Location tree has loaded.
   *
   *  The floor buttons only ever offer the anchor's *direct children*, because that is what the
   *  floor key can resolve (`_floorsFromLocations`). So for a campus → building → wing → floor
   *  facility, anchoring on the building surfaces the **wings** as floors and hides the real ones —
   *  silently, before this control existed. Here the operator sees the anchor spelled out and can
   *  re-point the folder at the wing that actually holds its floors.
   *
   *  Shown for every Location anchor, not just when `_isWingLikeAnchor` fires: the heuristic can't
   *  see a wing whose floors have no room Locations yet, and the pick must stay explicit either
   *  way. When it *does* fire, the hint escalates to a warning naming what's wrong. A parent
   *  Location gets an "up" button so an over-drilled anchor is recoverable without returning to the
   *  bind step (the anchor's *Site* is not offered — that's a different anchor kind, and switching
   *  to it belongs in `_stepBuildings`).
   *
   *  Rendered as a closed `<details>` disclosure (IMPORT-50): re-anchoring is a repair, not part
   *  of the assign-every-drawing walk, so it shouldn't hold a permanent row of buttons in every
   *  building's header. It opens itself exactly when the repair is likely needed — the wing-like
   *  warning — and stays one click away otherwise, its summary naming the current anchor so the
   *  collapsed state still answers "what am I anchored on". */
  _anchorDrillControl(b) {
    if (!b.nbBuilding) return null;
    const children = this.w._anchorChildren(b);
    // The anchor's own parent, resolved through the live tree — `nbBuilding` records only
    // id/slug/name (matching `_bindBuilding`), so the edge comes from the fetched Location list.
    const locs = this.w._siteLocs.get((b.slug || '').trim()) || [];
    const anchor = locs.find(l => l.id === b.nbBuilding.id);
    const parent = anchor ? locs.find(l => l.id === anchor.parent) : null;
    if (!children.length && !parent) return null;
    const wingLike = this.w._isWingLikeAnchor(b);
    const note = wingLike
      ? Dom.el('span', { class: 'imp-anchor-warn' },
        '⚠ The Locations under ' + b.nbBuilding.name + ' have floors of their own, so they look '
        + 'like wings or zones rather than floors. Pick the one holding this folder’s floors — or '
        + 'split the drawings so each wing gets its own folder.')
      : Dom.el('span', { class: 'hint' },
        'Floors listed below wrong? Point this folder at a Location further down the tree.');
    const row = Dom.el('div', { class: 'imp-anchor-row' });
    if (parent)
      row.append(Dom.el('button', { class: 'imp-floor',
        title: 'Anchor this folder on ' + parent.name + ' instead.',
        onclick: () => this.w._reanchorBuilding(b, parent) }, '↑ ' + parent.name));
    for (const c of children)
      row.append(Dom.el('button', { class: 'imp-floor',
        title: 'Anchor this folder on ' + c.name + ' — its children become the floors.',
        onclick: () => this.w._reanchorBuilding(b, c) }, c.name));
    // The drill candidates come from `_siteLocs`, the same one-shot Location read `_loadFloors`
    // made — so when that read was clipped this row is showing *some* of the anchor's children, not
    // all of them. Say so rather than letting a short list read as the whole tree (IMPORT-29). The
    // flag now only fires when the clip reached this building's own level (IMPORT-49), so the note
    // stays rare rather than sitting under every building on the step.
    const partial = b.nbFloorsError === 'truncated'
      ? Dom.el('span', { class: 'hint' },
        'This site holds more locations than one list can hold, so some may be missing here.')
      : null;
    const attrs = { class: 'imp-anchor-drill' };
    if (wingLike) attrs.open = '';
    return Dom.el('details', attrs, [
      Dom.el('summary', { class: 'imp-anchor-label' },
        'Anchored on ' + this.w._anchorSummary(b) + (wingLike ? ' ⚠' : '')
        + ' — change which Location holds this folder’s floors'),
      note, row, partial,
    ]);
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
    const region = b.codeRegion || this.w._codeRegion;
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
      this.w._cards.push({ upgrade });
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
        this.w._saveDraft();
      }));
    }
    // The chosen site plan carries no floor — show a badge instead of the floor selector so it
    // isn't presented as a card asking for a floor. Keyed on the `this.w.site` match, not merely
    // `type:'none'`, so a card manually set to "— none —" keeps its floor buttons.
    const isSite = this.w._isSiteplanPick(b, p);
    // A plain floor click only touches this drawing's assignment, so it patches just this card in
    // place (+ the build gate) rather than re-running `_stepMap()`, which would reset the page
    // scroll (IMPORT-2). Same in-place swap the rotate control uses above; `card` is the `let card`
    // assigned below, so this closure resolves it at click time.
    const isOverlay = ImportUploader.isOverlay(p.file);
    // Snapshot the resolved floor at render time so the rerender callback below can tell a real
    // floor *change* from a same-floor click (it fires on every assignment button press).
    const tokenAtRender = this.w._assignToken(a, null);
    const rerenderCard = () => {
      // Re-assigning an overlay's floor invalidates its control-point alignment — the dst
      // points are 0..1 of the OLD floor's canvas — so clear it, mirroring how a rotation
      // clears region-split boxes (FMT-6).
      if (isOverlay && (b.align[p.stem] || []).length
          && this.w._assignToken(a, null) !== tokenAtRender) {
        b.align[p.stem] = [];
        Toast.show('Alignment cleared — this overlay was aligned on its previous floor. '
          + 'Use “Align on plan…” to re-align it.');
      }
      card.replaceWith(card = this._pdfCard(b, p));
      this.w._applyThumbSize();      // keep the hi-res upgrade state at large thumbnail sizes
      this.w._refreshBuildActions(); // assigning the last unassigned drawing opens the gate
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
      // A GIS overlay card grows the align affordance (FMT-6): its placement state plus the
      // jump into the align editor. Base drawings are untouched.
      isOverlay && !isSite ? this.w.align.row(b, p) : null,
    ]);
    // Flag a still-unassigned drawing so it stands out in the grid (and in the gated build hint) —
    // region-aware, so a region-split card with an unassigned region is flagged too (FLOOR-4).
    const cls = 'imp-card' + (this.w._cardUnassigned(b, p) ? ' unassigned' : '');
    card = Dom.el('div', { class: cls }, [thumb, body]);
    return card;
  }

  /** A card thumbnail cropped to just the marked code `region` (normalized 0..1) of the drawing's
   *  full-scale render, built by the shared `ImportPreview.cropBox` — the very same crop the region
   *  picker previews, deliberately one implementation so "the box I marked" and "the box OCR reads"
   *  cannot drift apart again (IMPORT-63). Clicking opens the full drawing in the lightbox — the
   *  escape hatch for an outlier whose code sits outside the marked spot.
   *
   *  The region is `adapt`ed to *this* drawing's sheet first (IMPORT-51): a box marked on a
   *  landscape sheet is re-anchored, not stretched, when the card's own sheet is shaped differently.
   *  A no-op for the usual uniform set. */
  _codeCropThumb(p, marked) {
    const region = ImportRegions.adapt(marked, ImportRegions.pageGeom(p));
    return ImportPreview.cropBox(
      ImportPreview.previewUrl(p.pdf, p.page) + (p._rev ? '&v=' + p._rev : ''), region,
      { title: 'Click to see the whole drawing', onClick: () => ImportPreview.lightbox(p) });
  }

  /** How a floor suggestion reached its Location, when that took more than matching the name
   *  (IMPORT-52) — empty for a plain literal match, which is every pre-IMPORT-52 draft and still
   *  the common case.
   *
   *  Worth saying out loud precisely because those two rungs reconcile *different naming systems*:
   *  "by floor level" means a caption reading `GROUND` was matched to a Location called `Floor 0`
   *  because both name storey zero, and "by floor order" means the building's reads were matched to
   *  its floors as an ordered set rather than one by one. Both are sound inferences and both are
   *  the kind an operator should sanity-check before confirming — which is the entire point of
   *  these landing as suggestions. Read only while `suggested` is set, exactly like
   *  `suggestedFrom`, so it needs no clearing when the operator answers.
   *
   *  "the building's only floor" (IMPORT-72) is the third, and says the least about the drawing:
   *  this building has one drawing and one floor Location, so they were paired on that alone and
   *  the floor code itself was not what matched. Worth naming for the same reason as the other two
   *  — an operator who sees the codes disagree should know the pairing never claimed they didn't. */
  static _matchNote(a) {
    if (a.matchedBy === 'aligned') return ' (matched by floor order)';
    if (a.matchedBy === 'ordinal') return ' (matched by floor level)';
    if (a.matchedBy === 'sole') return ' (the building’s only floor)';
    return '';
  }

  /** The badge on a floor the sweep set by itself (IMPORT-63). Deliberately worded as a statement
   *  of what happened plus what to do about it — "set automatically … check it" — rather than a
   *  bare tick: an operator scanning a grid of cards has to be able to tell, without hovering
   *  anything, which floors a human chose and which a reader did. Picking any floor button clears
   *  the marker and the badge with it (`ImportFlow.clearUnanswered`). */
  static _autoAcceptBadge() {
    return Dom.el('span', { class: 'hint imp-ocr-auto',
      title: 'The floor code read clearly and named this floor exactly, so it was set for you. '
        + 'Pick any floor to change it, or use “Undo automatic floors” on the build row to turn '
        + 'every automatically-set floor back into a suggestion.' },
    '✓ set automatically from the floor code — check it');
  }

  /** The OCR read-out chip for one assignment (IMPORT-31), or null when OCR never read this
   *  drawing. Reports the recognized text and its confidence — `Read “L1” · 47%` — so a drawing
   *  the pass left alone explains itself instead of just staying blank. A read that returned
   *  nothing still gets a chip (`Read (nothing) · 0%`): "the region was read and held no text" is
   *  a different, and more actionable, answer than "OCR never ran here".
   *
   *  A read the reader **wasn't confident about** that nonetheless produced a suggestion is called
   *  out (IMPORT-53): it passes the build gate like any other assignment, so it is the one outcome
   *  of a facility-wide sweep that needs the operator's eye. The carousel routes to it by the same
   *  rule (`ImportFlow._lowConfidenceCount`) — keep the two on the one `LOW_OCR_CONF` threshold.
   *
   *  A read that was perfectly legible and simply **named no floor** (`ocrNoFloor`, IMPORT-71) is
   *  the other outcome worth an operator's eye, and the one that used to be invisible: a confident
   *  `Read “Administration” · 96%` beside a blank floor reads as "OCR worked, this sheet has no
   *  floor", when what it actually means is that the marked region is not over the floor caption on
   *  this sheet. Where that text is the building's **own name** (`ImportOcrSweep.isOwnName`) the
   *  chip says so outright — that is the region-drift signature, and the per-building code region
   *  is its fix. Derived here rather than stored, so the draft carries one boolean and not a
   *  second copy of the building's name. */
  _ocrChip(b, a) {
    if (a.ocrText === undefined || a.ocrText === null) return null;
    const conf = a.ocrConf || 0;
    const pct = Math.round(conf * 100);
    const low = a.suggested && a.suggestedFrom === 'ocr' && conf < ImportFlow.LOW_OCR_CONF;
    const noFloor = !!a.ocrNoFloor;
    const named = noFloor && ImportOcrSweep.isOwnName(a.ocrText, b);
    // Rides the shared `hint` style rather than a class of its own: it is exactly the small
    // informational annotation `hint` already means, and inventing a one-off class would put a
    // new rule in the shared stylesheet for no visual difference. The low-confidence modifier is
    // the one exception, and it earns its rule by changing the colour — and "named no floor"
    // borrows it, since it asks the operator for exactly the same thing: a look.
    return Dom.el('span', { class: low || noFloor ? 'hint imp-ocr-low' : 'hint',
      title: ImportCards._ocrChipTitle(low, noFloor, named) },
      (low || noFloor ? '⚠ Read ' : 'Read ')
      + (a.ocrText ? '“' + a.ocrText + '”' : '(nothing)') + ' · ' + pct + '%'
      + (named ? ' — the building’s own name, not a floor'
        : noFloor ? ' — names no floor' : ''));
  }

  /** The `_ocrChip` tooltip for one read's outcome. Each branch names the *fix*, not just the
   *  symptom, because the three failures are undone in three different places: a faint read is
   *  checked against the drawing, a read that named no floor means the box is in the wrong place,
   *  and a read that came back as the building's own name says where the box actually landed. */
  static _ocrChipTitle(low, noFloor, named) {
    if (low)
      return 'The floor-code OCR read this, but wasn’t confident. The floor below is a suggestion '
        + 'from a faint read — check it against the drawing before building.';
    if (named)
      return 'The floor-code OCR read this building’s own name, not a floor — so the marked region '
        + 'is sitting over the wrong part of the title block on this sheet. Re-mark the code '
        + 'region over the floor caption, or give this building its own region.';
    if (noFloor)
      return 'The floor-code OCR read this clearly, but nothing in it names a floor. Check the '
        + 'marked region is over this sheet’s floor caption.';
    return 'What the floor-code OCR read in the marked region, and how confident it was.';
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
      onclick: () => input.click() }, 'Replace this drawing…');
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
      // The one scan that deliberately does NOT go through `ImportFlow.scan()` (IMPORT-47): this
      // is a best-effort thumbnail refresh whose failure is already swallowed below, so waiting
      // out a busy server for minutes would be strictly worse than skipping it until the next
      // scan. Nothing races it either — it follows an upload the operator just made.
      try { const inv = await Api.post('/api/import/scan', {}); if (inv.ok) this.w.inv = inv; }
      catch (_) { /* the existing thumbnail stays until the next scan */ }
      p._rev = (p._rev || 0) + 1;
      // Remember that this drawing's bytes changed, so the pre-build desync guard warns that any
      // rooms/hotspots placed on it may no longer line up (REPL-1) — a margin/crop shift keeps the
      // id, pixel size, and aspect ratio, so nothing else would flag it.
      this.w._replaced.add(b.folder + '/' + p.stem);
      Toast.show('Replaced ' + p.file);
      this.w._stepMap();
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
      onclick: () => this.w.regions.openSplit(b, p) }, '⧉ Split this drawing into floors…');
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
      Dom.el('button', { class: 'imp-floor', onclick: () => this.w.regions.openSplit(b, p) }, 'Edit regions'),
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
    this.w._saveDraft();
    this.w._rerenderBuildingSection(b);
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
    const loadNote = this._floorLoadNote(b);
    if (loadNote) row.append(loadNote);
    if (a.type === 'unassigned')
      row.append(Dom.el('span', { class: 'imp-floor-warn' }, '⚠ pick a floor'));
    // A filename-derived pre-fill (IMPORT-28) looks identical to a chosen floor once it's applied —
    // the active button is active either way — so say so in words. Suggestions deliberately don't
    // gate the build (that would be worse than the unassigned state they replace); this badge plus
    // the build row's running count is how they stay visible instead.
    else if (a.suggested)
      row.append(Dom.el('span', { class: 'hint' }, '✎ suggested from '
        + (a.suggestedFrom === 'ocr' ? 'the floor code' : 'the filename')
        + ImportCards._matchNote(a) + ' — confirm or change'));
    // The one floor nobody chose that is nonetheless committed (IMPORT-63). It has to say so on the
    // card, in words, or it is indistinguishable from a floor the operator picked — which is
    // precisely the failure the `1.10.0` engine is remembered for. The `_ocrChip` beside it carries
    // the text and confidence the decision was made on.
    else if (a.autoAccepted) row.append(ImportCards._autoAcceptBadge());
    // What OCR actually read, whenever it read this drawing (IMPORT-31, the `1.8.0` shape). Shown
    // independently of the assignment — including on a card that stayed unassigned, which is
    // precisely the case that used to go blank with no hint of why. Seeing the text and its
    // confidence is what separates a faint scan from a confident misread.
    const chip = this._ocrChip(b, a);
    if (chip) row.append(chip);
    // Any pick here is the operator answering, so it retires every "not yet answered" marker —
    // the suggestion flag, the blind positional default, and an auto-accepted read (IMPORT-63).
    const btn = (label, active, onClick) =>
      Dom.el('button', { class: 'imp-floor' + (active ? ' active' : ''),
        onclick: () => { ImportFlow.clearUnanswered(a); onClick(); } }, label);
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

  /** The line a card shows when this building's floor Locations didn't load cleanly
   *  (`b.nbFloorsError`, set by `ImportFlow._loadFloors`) — null on a clean, complete read.
   *
   *  Without it all three failure modes render as the ordinary floor-**type** vocabulary, which is
   *  also what a site with genuinely no floor Locations shows. That collision is the bug: an
   *  operator whose bound Site was renamed in NetBox, or whose request simply failed, sees a normal
   *  screen, assigns Basement/Ground/Level N, and builds floor ids that resolve to nothing
   *  (IMPORT-29). Each case therefore says what is actually wrong and what to do about it. The
   *  fallback buttons still render underneath for the two "no usable list" cases, so an operator who
   *  can't fix NetBox right now keeps an escape hatch. */
  _floorLoadNote(b) {
    // Its own class rather than the inline `.imp-floor-warn` the short "⚠ pick a floor" flag uses:
    // these are full sentences, so they take their own line in the wrapping button row.
    const warn = (text) => Dom.el('span', { class: 'imp-floor-warn imp-floor-loadwarn' }, text);
    if (b.nbFloorsError === 'site-missing')
      return warn('⚠ No NetBox site answers to “' + (b.slug || '').trim() + '”, so this building’s '
        + 'floors can’t be listed. Rebind this folder on the Map-buildings step, or fix the site '
        + 'slug above. The floor names below are a fallback and won’t match NetBox locations.');
    if (b.nbFloorsError === 'fetch')
      return warn('⚠ Couldn’t load this site’s floors from NetBox. Reload the page to try again — '
        + 'the floor names below are a fallback and won’t match NetBox locations.');
    if (b.nbFloorsError === 'truncated')
      return warn('⚠ Some of this building’s floors are missing from the list below — this site '
        + 'holds more locations than one list can hold. Use “+ Add floor” to search NetBox for the '
        + 'floor you need. Your existing floor assignments are untouched.');
    return null;
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
      try { res = await this.w.app.netbox.locations(b.slug, q); } catch (_) { return; }
      if (mine !== seq) return;   // a newer keystroke superseded this fetch
      const have = new Set(b.nbFloors.map(f => f.slug));
      // A Location anchor's floors must be children of its building Location, or the 3-segment key
      // (`site/building/floor`) wouldn't resolve — so restrict the site-wide search to that
      // building's direct children. A Site anchor searches the whole site, as before.
      const bId = b.nbBuilding && b.nbBuilding.id;
      const pool = (res.rooms || []).filter(l => !have.has(l.slug));
      const hits = pool.filter(l => !bId || l.parent === bId);
      // Deeper matches under the same anchor (MULTI-5): a hit that *is* under this building but not
      // directly beneath it means the floors live a level down — a wing/zone. Rather than drop it
      // (which is how the wing case used to fail silently), offer it in its own group; picking one
      // re-anchors the folder onto its parent, which is exactly the key shape that resolves.
      const byId = new Map((this.w._siteLocs.get((b.slug || '').trim()) || []).map(l => [l.id, l]));
      const deeper = bId
        ? pool.filter(l => l.parent !== bId && ImportFlow._isUnder(l, bId, byId)) : [];
      list.innerHTML = '';
      if (!hits.length && !deeper.length) {
        list.append(Dom.el('div', { class: 'hint' }, 'No other locations found.'));
        return;
      }
      for (const loc of hits) {
        const item = Dom.el('div', { class: 'room-item' }, [
          Dom.el('div', { class: 'nm' }, loc.name),
          Dom.el('div', { class: 'sl' }, loc.slug),
        ]);
        item.onclick = async () => { await this._addFloor(b, a, loc); };
        list.append(item);
      }
      if (!deeper.length) return;
      list.append(Dom.el('div', { class: 'hint' },
        'Deeper under ' + b.nbBuilding.name + ' — picking one re-anchors this folder on its parent, '
        + 'so that parent’s Locations become the floors:'));
      for (const loc of deeper) {
        const par = byId.get(loc.parent);
        if (!par) continue;
        const item = Dom.el('div', { class: 'room-item' }, [
          Dom.el('div', { class: 'nm' }, loc.name),
          Dom.el('div', { class: 'sl' }, loc.slug + ' · in ' + par.name),
        ]);
        // Assign first, re-anchor second: `_reanchorBuilding` saves the draft and re-runs
        // `_loadFloors`, whose `_mergeAssignedFloors` then re-adds this Location as a floor of the
        // new anchor. Doing it the other way round would race the anchor's floor re-fetch.
        item.onclick = async () => {
          a.token = loc.slug; a.label = loc.name; a.type = 'level';
          ImportFlow.clearUnanswered(a);
          await this.w._reanchorBuilding(b, par);
        };
        list.append(item);
      }
    };
    input.addEventListener('input', () => run(input.value));
    const toggle = Dom.el('button', { class: 'imp-floor imp-floor-add', onclick: () => {
      const hidden = adder.classList.toggle('hidden');
      if (hidden) return;
      input.focus();
      if (!loaded) { loaded = true; run(''); }   // show the site's locations on first open
    } }, '+ Add a floor from NetBox…');
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
    ImportFlow.clearUnanswered(a);
    await this.w._saveDraft();
    // Adds a floor to the whole building's shared `nbFloors`, so re-render the building section
    // (every sibling card gains the new button) in place, preserving scroll (IMPORT-2).
    this.w._rerenderBuildingSection(b);
  }

}
