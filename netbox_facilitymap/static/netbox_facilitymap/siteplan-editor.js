'use strict';
/* siteplan-editor.js — SiteplanEditor: the siteplan view + an edit mode for
   drawing user building hotspots (e.g. the trailers the source PDF never placed).
   In view mode it renders the PDF hotspots + user hotspots as clickable building
   links. Extends Editor; shapes are buildings rather than rooms. */

class SiteplanEditor extends Editor {
  constructor(app) {
    super(app);
    this._promoted = null;   // id of a PDF hotspot promoted to a user hotspot but not yet edited
  }

  // ---- Editor hooks ----
  editing() { return this.app.siteEdit; }
  _dirty() { return this.store.siteDirty; }
  _setEditing(on) { this.app.siteEdit = on; }
  /** Beyond the base state reset: drop a promoted-but-unedited hotspot so toggling out of
   *  edit never leaves a stray user hotspot behind (or dirties siteplan.json). */
  _onModeSwitch(mode) { this._discardCleanPromotion(); }
  polys() { return this.store.siteHotspots.map(h => ({ id: h.id, polygon: h.poly })); }
  markDirty() {
    // The first real edit commits a promoted hotspot, so it is no longer discarded.
    if (this.selected && this.selected === this._promoted) this._promoted = null;
    this.store.markSiteDirty(); this._setBadge();
  }
  deselect() {
    this._discardCleanPromotion();
    if (this.selected) { this.selected = null; this.editingLabel = null; this.render(); this.app.closePanel(); }
  }

  /** App.closePanel hook: leaving label-edit mode (e.g. via the panel ✕) restores
   *  the normal selected-shape rendering. */
  onPanelClosed() {
    if (this.editingLabel) { this.editingLabel = null; this.render(); }
  }

  openBuilding(dir, name) {
    // Both hotspot clicks and legend rows route through here, so this covers both.
    const b = this.store.building(dir);
    if (!(b && b.floors.length)) {
      // No floor maps to open. The embed's toast is CSS-hidden, so it just does nothing there.
      if (!this.app.embed) Toast.show('No floor maps for ' + (name || dir));
      return;
    }
    const hash = '/b/' + encodeURIComponent(dir);
    // The dashboard-widget embed is chrome-free with no in-card breadcrumbs, so drilling in
    // there would strand the user with no way back. Open the full map in the top window instead,
    // deep-linked at this building: location.pathname is the MapView URL (minus the ?embed=1
    // query) and the widget iframe is same-origin, so window.top is reachable.
    if (this.app.embed) { window.top.location.href = location.pathname + '#' + this.app._hash(hash); return; }
    this.app.go(hash);
  }

  /** PDF hotspots overridden by any user hotspot for the same building, plus all
   *  user hotspots. */
  effectiveHotspots() {
    const sp = this.store.manifest.siteplan;
    const overridden = new Set(this.store.siteHotspots.map(h => h.dir));
    const pdf = sp.hotspots.filter(h => !overridden.has(h.dir))
      .map(h => ({ source: 'pdf', dir: h.dir, name: h.name, code: h.buildingCode, poly: h.poly }));
    const user = this.store.siteHotspots.map(h => ({
      source: 'user', id: h.id, dir: h.dir, name: h.name, ref: h,
      code: Util.code(h.dir || '?'), poly: h.poly,
    }));
    return pdf.concat(user);
  }

  // ---- view assembly ----
  show() {
    const sp = this.store.manifest.siteplan;
    this.draft = null; this.selected = null; this.editingLabel = null; this._promoted = null; this.grid.adjust = false;
    this.grid.setScope('siteplan');
    this.app.crumbs([{ label: 'Siteplan' }]);
    const stage = Dom.$('#stage'); stage.innerHTML = '';
    if (!sp) { this.app.setToolbar([]); stage.append(Dom.el('div', { class: 'empty' }, 'No siteplan image')); return; }
    this.app.setToolbar(this._toolbar());

    const img = Dom.el('img', { src: this.store.mediaUrl(sp.image), alt: 'siteplan' });
    const s = Dom.svg('svg', { preserveAspectRatio: 'none' });
    const wrap = Dom.el('div', { class: 'map-wrap' }, [img, s]);
    const viewport = Dom.el('div', { class: 'map-viewport' }, wrap);
    stage.append(Dom.el('div', { class: 'siteplan-view' }, [viewport, this._legend(s)]));
    this.attach(img, s, [sp.w, sp.h]);
  }

  // ---- toolbar hooks (assembled by Editor._toolbar) ----
  // The lone edit-mode tool: Add building area (undo + the right-angle/grid factory row
  // and Save+badge come from the base). The siteplan editor always vertex/edge-snaps, so
  // it uses the base _alignTools (no Snap toggle).
  _editButtons() {
    return [Dom.el('button', { class: 'tb-labeled', title: 'Add a building area: click to outline a building',
      onclick: () => this.beginDraw(
      'Click to outline a building · Backspace undoes a point · Right-click removes a point · Enter/double-click to close'),
      html: Icons.draw + '<span>Add building area</span>' })];
  }
  // Save/badge only in edit mode: in view the siteplan is the app's home screen, kept
  // uncluttered (the wizard entry point + page-wide labels toggle live in Settings).
  _showsSave() { return this.editing(); }

  _legend(s) {
    const legend = Dom.el('aside', { class: 'legend' });
    // Facility-wide wayfinding search sits above the building index. Skipped in the embed,
    // which has no in-app navigation and never loads the floor-level room/rack data.
    if (!this.app.embed) legend.append(this._finder());
    legend.append(Dom.el('div', { class: 'legend-head' }, 'All buildings'));
    const numbered = this.store.manifest.buildings.filter(b => Util.isNumbered(b.dir));
    const trailers = this.store.manifest.buildings.filter(b => !Util.isNumbered(b.dir));
    const onMap = new Set(this.effectiveHotspots().map(h => h.dir));
    const hover = (dir, on) => { const n = s.querySelector(`[data-hs="${CSS.escape(dir)}"]`); if (n) n.classList.toggle('hot', on); };

    const rows = Dom.el('div', { class: 'legend-rows' });
    const addGroup = (title, list, ql) => {
      const matches = list.filter(b => !ql || b.name.toLowerCase().includes(ql)
        || Util.code(b.dir).toLowerCase().includes(ql) || b.dir.toLowerCase().includes(ql));
      if (!matches.length) return;
      if (title) rows.append(Dom.el('div', { class: 'legend-group' }, title));
      for (const b of matches) {
        const has = b.floors.length > 0;
        rows.append(Dom.el('div', {
          class: 'legend-row' + (has ? '' : ' nomap'),
          onclick: () => this.openBuilding(b.dir, b.name),
          onmouseenter: () => hover(b.dir, true),
          onmouseleave: () => hover(b.dir, false),
        }, [
          Dom.el('span', { class: 'lc' }, Util.code(b.dir)),
          Dom.el('span', { class: 'ln' }, b.name + (has ? '' : ' (no map)')),
          onMap.has(b.dir) ? null : Dom.el('span', { class: 'nopin', title: 'Not placed on the map' }, '◌'),
        ]));
      }
    };
    const renderRows = (q) => {
      rows.innerHTML = '';
      const ql = q.trim().toLowerCase();
      addGroup('', numbered, ql);
      addGroup('Trailers', trailers, ql);
      if (!rows.children.length) rows.append(Dom.el('div', { class: 'legend-empty' }, 'No matching buildings'));
    };

    legend.append(Dom.el('input', { class: 'legend-search', type: 'search',
      placeholder: 'Search buildings…', oninput: (e) => renderRows(e.target.value) }));
    legend.append(rows);
    renderRows('');
    return legend;
  }

  /** Facility-wide wayfinding search: find a room or rack/device by name anywhere in the
   *  facility, then jump to its floor and highlight it. The index is built client-side from
   *  the already-loaded room + placement blobs (Store.searchTargets) — no server round-trip,
   *  no new endpoint. Empty query shows nothing (the building index below is the browse view);
   *  a match jumps via App.focusRoom. */
  _finder() {
    const box = Dom.el('div', { class: 'finder' });
    const input = Dom.el('input', { class: 'legend-search', type: 'search',
      placeholder: 'Find a room or rack…', 'aria-label': 'Find a room or rack' });
    const results = Dom.el('div', { class: 'finder-results' });
    box.append(input, results);

    let q = '';
    const render = () => {
      results.innerHTML = '';
      const ql = q.trim().toLowerCase();
      if (!ql) return;
      const targets = this.store.searchTargets();
      if (!targets.length) { results.append(Dom.el('div', { class: 'finder-empty' }, 'Loading room data…')); return; }
      const scored = [];
      for (const t of targets) {
        const label = t.label.toLowerCase();
        const locName = (t.location && t.location.name || '').toLowerCase();
        const locSlug = (t.location && t.location.slug || '').toLowerCase();
        // Rank a leading match on the name first, then any substring hit, then a hit on the
        // bound Location's name/slug — so "218" surfaces room 218 ahead of incidental matches.
        let rank = -1;
        if (label.startsWith(ql)) rank = 0;
        else if (label.includes(ql)) rank = 1;
        else if (locName.includes(ql) || locSlug.includes(ql)) rank = 2;
        if (rank >= 0) scored.push({ t, rank });
      }
      scored.sort((a, b) => a.rank - b.rank);
      if (!scored.length) { results.append(Dom.el('div', { class: 'finder-empty' }, 'No matching rooms or racks')); return; }
      for (const { t } of scored.slice(0, 40)) results.append(this._finderRow(t));
    };
    input.addEventListener('input', () => { q = input.value; render(); });
    // The room/rack index lives in the deferred floor-data bundle (warmed after the siteplan
    // paints). Ensure it has landed, then re-run whatever the user has already typed.
    this.app.ensureFloorData().then(render).catch(() => {});
    return box;
  }

  /** One search result row: a kind tag (Room/Rack/Device) + the target name and its
   *  building · floor (and bound Location, for a room whose label differs from it). */
  _finderRow(t) {
    const primary = t.label || (t.location && t.location.name) || '(unbound room)';
    const tag = t.kind === 'room' ? 'Room' : (t.kind === 'device' ? 'Device' : 'Rack');
    const locName = t.kind === 'room' && t.location && t.location.name;
    const sub = t.building + ' · ' + t.floor + (locName && locName !== primary ? ' · ' + locName : '');
    return Dom.el('div', { class: 'finder-row', onclick: () => this._gotoTarget(t) }, [
      Dom.el('span', { class: 'finder-tag ' + t.kind }, tag),
      Dom.el('div', { class: 'finder-main' }, [
        Dom.el('div', { class: 'finder-nm' }, primary),
        Dom.el('div', { class: 'finder-sl' }, sub),
      ]),
    ]);
  }

  /** Route to a result's floor and frame it: a room is framed on its polygon bbox (padded
   *  for context); a rack/device is framed on a small box around its placement point and
   *  pulses its containing room. Coordinates are normalized over the whole (possibly
   *  multi-sheet) canvas, so a single rect frames the target regardless of sheet. */
  _gotoTarget(t) {
    let region;
    if (t.kind === 'room' && t.polygon && t.polygon.length) {
      const b = Geom.bounds(t.polygon);
      const padX = b.w * 0.6 + 0.03, padY = b.h * 0.6 + 0.03;
      region = [Math.max(0, b.minX - padX), Math.max(0, b.minY - padY),
        Math.min(1, b.maxX + padX), Math.min(1, b.maxY + padY)];
    } else {
      const x = t.x != null ? t.x : 0.5, y = t.y != null ? t.y : 0.5, r = 0.09;
      region = [Math.max(0, x - r), Math.max(0, y - r), Math.min(1, x + r), Math.min(1, y + r)];
    }
    this.app.focusRoom(t.dir, t.fid, t.roomId, region);
  }

  // ---- rendering ----
  /** Static layer: the catcher and every non-selected hotspot with its label (shown
   *  only when the page-wide toggle is on or the building opted in). The selected
   *  hotspot + draft render live in the active layer. Grid rides the base grid layer. */
  _renderStatic(s, W, H) {
    this.addCatcher(s, W, H);
    const byDir = Object.fromEntries(this.store.manifest.buildings.map(b => [b.dir, b]));
    for (const hs of this.effectiveHotspots()) {
      if (hs.source === 'user' && hs.id === this.selected) continue;   // selected → active layer
      this._drawHotspot(s, hs, W, H, byDir);
      // A non-selected hotspot's label shows when the page-wide toggle is on
      // (app.siteLabels) or this building opted in (hs.ref.showLabel).
      if (this.app.siteLabels || (hs.ref && hs.ref.showLabel)) this._drawLabel(s, hs, W, H);
    }
  }

  /** Active layer: the selected hotspot drawn live (reshaping polygon + editable
   *  vertices, or its label with handles while the label is being edited) plus the
   *  draft. Rebuilt on every drag frame so the static hotspots below are untouched. */
  _renderActive(s, W, H) {
    const editing = this.editing();
    const hs = editing && this.selected != null
      ? this.effectiveHotspots().find(h => h.source === 'user' && h.id === this.selected) : null;
    if (hs) {
      const byDir = Object.fromEntries(this.store.manifest.buildings.map(b => [b.dir, b]));
      this._drawHotspot(s, hs, W, H, byDir);
      // While editing the polygon the label is hidden so it doesn't obscure the
      // vertices; when the label itself is being edited, show it (with its handles).
      if (this.editingLabel === hs.id) this._drawLabel(s, hs, W, H);
      else this.drawVertices(s, hs.poly, W, H, hs.id, () => this.markDirty());
    }
    this.drawDraft(s, W, H);
  }

  /** Draw one hotspot polygon into `s`, styled per mode (view = invisible click zone;
   *  edit = ref outline for PDF, editable for user). Shared by the static loop and the
   *  active-layer draw of the selected hotspot — the `.selected` class keys off
   *  `this.selected`, so it lights up only for the selected hotspot either way. */
  _drawHotspot(s, hs, W, H, byDir) {
    const editing = this.editing();
    const b = byDir[hs.dir];
    const has = !!(b && b.floors.length);
    const pts = hs.poly.map(p => `${p[0] * W},${p[1] * H}`).join(' ');
    let cls = 'hotspot ' + hs.source;
    if (!editing) cls += ' view';
    if (editing && hs.source === 'pdf') cls += ' ref';
    if (hs.source === 'user' && hs.id === this.selected) cls += ' selected';
    const poly = Dom.svg('polygon', { points: pts, class: cls });
    if (hs.dir) poly.setAttribute('data-hs', hs.dir);
    if (!has && !editing) { poly.style.opacity = .4; poly.style.cursor = 'default'; }
    poly.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.draft) return;
      if (editing && hs.source === 'user') {
        if (this._promoted && this._promoted !== hs.id) this._discardCleanPromotion();
        this.selected = hs.id; this.render(); this.openHotspotPanel(hs.ref);
      } else if (editing) { this._discardCleanPromotion(); this.promoteHotspot(hs); }
      else if (!editing) this.openBuilding(hs.dir, hs.name);
    });
    const title = Dom.svg('title');
    title.textContent = (hs.name || hs.dir || 'unassigned') + (has ? '' : ' (no map)');
    poly.append(title);
    s.append(poly);
  }

  /** Centered building-name label. By default it is auto-placed on the polygon
   *  bbox and auto-sized to fit (long names wrap to two lines in roughly-square
   *  areas; tiny areas fall back to the short code). A user `labelStyle` overrides
   *  the centre (`x,y`), `size`, `rot`, `font`, `color`, and the **display `text`**
   *  (visual only — its line breaks are honoured and it is fit to the box, but it
   *  never changes the building name). The text is centred at the group origin so
   *  attachLabel can translate+rotate it (and add edit handles). */
  _drawLabel(s, hs, W, H) {
    const REF = 100, FILL = 0.82, MIN = 7, MAX = 22;
    const shape = hs.ref || hs;        // the persistent store hotspot carries labelStyle
    const ls = shape.labelStyle || {};
    const name = (hs.name && hs.name.trim()) || hs.code || hs.dir || '';
    const custom = ls.text != null ? ls.text : null;
    if (!name && custom == null) return;

    const b = Geom.bounds(hs.poly);
    let cx, cy;
    if (ls.x != null && ls.y != null) { cx = ls.x; cy = ls.y; }   // explicit placement is respected as-is
    else { cx = b.cx; cy = b.cy; if (!Geom.pointInPoly(cx, cy, hs.poly)) [cx, cy] = Geom.clampToPoly(cx, cy, hs.poly); }

    const t = Dom.svg('text', { x: 0, y: 0, 'text-anchor': 'middle',
      'dominant-baseline': 'central', class: 'hotspot-label' });
    const availW = b.w * W * FILL, availH = b.h * H * FILL;
    // Measure once at a reference size then scale analytically
    // (preserveAspectRatio:none → 1 unit == 1 displayed px). The text must be in
    // the DOM to measure; attachLabel re-parents it into the rotatable group.
    const measure = () => {
      const bb = t.getBBox();
      return (bb.width && bb.height) ? Math.min(availW / bb.width, availH / bb.height) : 0;
    };

    let size;
    if (custom != null) {
      // User display text: honour its explicit line breaks; fit it to the box (or to
      // an explicit size). Never auto-wraps or falls back to the code.
      this._setLabelLines(t, custom.split('\n'));
      if (ls.size != null) size = ls.size;
      else {
        if (availW <= 0 || availH <= 0) return;
        t.style.fontSize = REF + 'px'; s.append(t);
        size = Math.max(MIN, Math.min(MAX, REF * measure())); s.removeChild(t);
      }
    } else if (ls.size != null) {
      this._setLabelLines(t, [name]); size = ls.size;
    } else {
      if (availW <= 0 || availH <= 0) return;
      t.style.fontSize = REF + 'px';
      this._setLabelLines(t, [name]); s.append(t);
      let scale = measure();
      const ar = (b.h * H) ? (b.w * W) / (b.h * H) : 1;
      if (name.split(/\s+/).length >= 2 && ar > 0.6 && ar < 1.7 && REF * scale < 11) {
        const wrapped = this._wrapLines(name);
        if (wrapped.length === 2) {
          this._setLabelLines(t, wrapped);
          const wScale = measure();
          if (wScale > scale) scale = wScale; else this._setLabelLines(t, [name]); // keep the bigger fit
        }
      }
      if (REF * scale < MIN && hs.code && name !== hs.code) { this._setLabelLines(t, [hs.code]); scale = measure(); }
      size = Math.max(MIN, Math.min(MAX, REF * scale));
      s.removeChild(t);
    }
    t.style.fontSize = size + 'px'; // inline style — a CSS font-size rule would win over an attribute
    t.style.strokeWidth = (size / 6).toFixed(2) + 'px'; // keep the halo proportional to the text
    this.attachLabel(s, shape, t, cx, cy, size, W, H);
  }

  /** Split a name into two character-balanced lines (greedy on word boundaries). */
  _wrapLines(name) {
    const words = name.trim().split(/\s+/);
    if (words.length < 2) return [name];
    const half = name.length / 2;
    let i = 1, line1 = words[0];
    while (i < words.length && line1.length + 1 + words[i].length <= half) { line1 += ' ' + words[i]; i++; }
    if (i >= words.length) { i = words.length - 1; line1 = words.slice(0, i).join(' '); }
    return [line1, words.slice(i).join(' ')];
  }

  /** Promote a PDF/source hotspot into an editable user hotspot. The new user
   *  hotspot overrides the PDF one for the same `dir` (via effectiveHotspots), so
   *  there is no duplicate. Not marked dirty: an inspect-click that never edits the
   *  shape is discarded again by _discardCleanPromotion (see markDirty/deselect). */
  promoteHotspot(pdfHs) {
    const hs = { id: Util.uid(), dir: pdfHs.dir, name: pdfHs.name,
      poly: pdfHs.poly.map(p => p.slice()) };   // deep copy — never mutate the manifest poly
    this.store.siteHotspots.push(hs);
    this.selected = hs.id; this._promoted = hs.id;
    this.render(); this.openHotspotPanel(hs);
  }

  /** Drop a promoted-but-unedited hotspot so a stray click never dirties the file. */
  _discardCleanPromotion() {
    if (!this._promoted) return;
    const i = this.store.siteHotspots.findIndex(h => h.id === this._promoted);
    if (i >= 0) this.store.siteHotspots.splice(i, 1);
    if (this.selected === this._promoted) this.selected = null;
    this._promoted = null;
  }

  handleKey(e) {
    // Escape out of label-edit mode first (back to the hotspot panel), then out of
    // selection.
    if (e.key === 'Escape' && this.editingLabel && !this.draft) {
      const hs = this.store.siteHotspots.find(h => h.id === this.editingLabel);
      this.editingLabel = null; this.render();
      if (hs) this.openHotspotPanel(hs);
      return;
    }
    if (e.key === 'Escape' && this.selected && !this.draft) {
      this._discardCleanPromotion();
      this.selected = null; this.render(); this.app.closePanel();
      return;
    }
    super.handleKey(e);
  }

  // ---- drawing actions ----
  finish() {
    const dp = this.draft.points;
    if (dp.length < 3) { this.draft = null; this.render(); return; }
    const hs = { id: Util.uid(), dir: null, name: '', poly: dp.slice() };
    this.store.siteHotspots.push(hs);
    this.draft = null; this.selected = hs.id; this.markDirty();
    this.render(); this.openHotspotPanel(hs);
  }

  _persist() { return this.store.saveSiteplan(); }
  _savedMessage() { return 'Siteplan saved'; }

  openHotspotPanel(hs) {
    const panel = Dom.$('#panel'); panel.classList.remove('hidden');
    Dom.$('#panel-title').textContent = hs.dir ? (hs.name || hs.dir) : 'Bind area';
    const body = Dom.$('#panel-body'); body.innerHTML = '';

    body.append(Dom.el('div', { class: 'field' }, [
      Dom.el('label', {}, 'Assigned building'),
      Dom.el('div', { class: 'val' }, hs.dir ? (hs.name || hs.dir) : '(unassigned)'),
    ]));
    body.append(Dom.el('button', { class: 'wide', html: Icons.edit + '<span>Edit label</span>',
      onclick: () => {
        this.editingLabel = hs.id; this.render();
        const dn = (hs.name && hs.name.trim()) || (hs.dir ? Util.code(hs.dir) : '') || '';
        this.openLabelPanel(hs, () => { this.editingLabel = null; this.render(); this.openHotspotPanel(hs); }, dn);
      } }));
    // Per-building label visibility — opts this one building's label in even when the
    // page-wide toggle is off. Persisted on the store hotspot (separate from labelStyle
    // so "Reset to auto" never wipes it); Save siteplan writes it.
    body.append(Dom.el('button', { class: 'wide',
      html: Icons.edit + '<span>' + (hs.showLabel ? 'Hide label' : 'Show label') + '</span>',
      onclick: () => { hs.showLabel = !hs.showLabel; this.markDirty(); this.render(); this.openHotspotPanel(hs); } }));
    body.append(Dom.el('button', { class: 'danger wide', onclick: () => {
      this.snapshot();   // no-op until the siteplan editor opts into undo, but keeps deletes on the pattern
      const i = this.store.siteHotspots.indexOf(hs);
      if (i >= 0) this.store.siteHotspots.splice(i, 1);
      this.selected = null; this.editingLabel = null; this.markDirty(); this.render(); this.app.closePanel();
    } }, 'Delete area'));
    body.append(Dom.el('div', { class: 'hint' }, 'Assign this area to a building:'));
    this._bindList(body, {
      placeholder: 'Search buildings…', items: this.store.manifest.buildings,
      filter: (b, ql) => !ql || b.name.toLowerCase().includes(ql) || b.dir.toLowerCase().includes(ql),
      row: (b) => ({
        nm: Util.code(b.dir) + ' · ' + b.name + (hs.dir === b.dir ? '  ✓' : ''),
        sl: b.floors.length ? b.floors.length + ' floors' : 'no map',
        bound: hs.dir === b.dir,
      }),
      pick: (b) => { hs.dir = b.dir; hs.name = b.name; this.markDirty(); this.render(); this.openHotspotPanel(hs); },
    });
  }
}
