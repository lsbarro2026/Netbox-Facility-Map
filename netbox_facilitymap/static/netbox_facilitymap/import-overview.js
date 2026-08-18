'use strict';
/* import-overview.js — ImportOverview: the map step's whole-facility view (IMPORT-63).

   The map step is a carousel: one building's cards at a time, paged with ← Previous / Next → and
   a `<select>` of every building name. That is a fine shape for the eight-building import it was
   built for and a poor one for a hundred and fifty, where three questions have no answer on screen
   at all — how much of this is done, where am I in it, and where is the building I am thinking of.
   A `<select>` of 150 unpaginated options answers none of them: it can be scrolled, not searched,
   and it says nothing about the buildings it is not showing.

   So this is the facility as a whole rather than a building at a time: a progress line, a name
   search, a status filter, and one row per building carrying what that building still wants — a
   floor, a faint read checked, an automatic floor confirmed — plus how far the background
   floor-code sweep has got with it (`ImportOcrSweep.coverage`). Every row is a jump. Collapsed by
   default (`<details>`, the `_anchorDrillControl` precedent), because a small import needs none of
   it and shouldn't have the cards pushed down the page by it.

   Holds a wizard back-ref (`this.w`), the ImportBulk shape. Its own view state — open, the search
   text, the filter — lives on the instance rather than in the DOM it builds, so the state survives
   the map step's frequent full re-renders (every carousel move calls `_stepMap()`), exactly as
   `ImportBulk.all` does for the bulk scope. None of it is persisted: it is a way of looking at the
   import, not part of it.

   **A building the wizard hasn't looked at yet is "not checked yet", never "done" (BUG-3).** The
   per-building counts this panel reads are only meaningful once `_loadFloors` has normalized that
   building against its floor Locations — and that is lazy, per building, on the carousel showing
   it. Before then a building's drawings sit at their blind `Level 1..N` default, which is a real
   `type`, so every count reads zero and the panel used to call a facility nobody had opened
   `82 of 82 done`. `ImportFlow._buildingSettled` is the guard: an unsettled building is bucketed
   apart rather than counted as finished, and it settles by itself as the background floor-code
   sweep loads and reads each building. Which is also why the panel repaints in place
   (`refresh()`) — the numbers move while nobody is touching the carousel. */

class ImportOverview {
  /** The filters, `[value, label, predicate]`. Each predicate reads the flow's existing per-building
   *  counts, so the overview can never disagree with the carousel label or the build gate about
   *  what a building still needs — they are the same numbers, asked once per building here instead
   *  of once for the one on screen. The one thing asked on top of them is
   *  `_buildingSettled` — whether those numbers mean anything for this building yet (BUG-3), which
   *  is a question about the *wizard's* knowledge rather than a fourth count. */
  static FILTERS = [
    ['all', 'All buildings', () => true],
    ['attention', 'Anything still to do', (w, b) => w._attentionCount(b) > 0 || w._autoAcceptedCount(b) > 0],
    ['unassigned', 'Still need a floor', (w, b) => w._unassignedCount(b) > 0],
    ['low', 'Read with low confidence', (w, b) => w._lowConfidenceCount(b) > 0],
    ['auto', 'Floors set automatically', (w, b) => w._autoAcceptedCount(b) > 0],
    ['unread', 'Floor codes not read yet', (w, b) => {
      const s = w.ocr.coverage(b).state;
      return s === 'pending' || s === 'reading' || s === 'no-region';
    }],
    // Every other state here is actionable by clicking a row, and so is this one: the jump loads
    // the building's floor Locations, which is exactly what settles it.
    ['unchecked', 'Not checked yet', (w, b) => !w._buildingSettled(b)],
    ['done', 'Nothing left to do', (w, b) => w._buildingSettled(b)
      && w._attentionCount(b) === 0 && w._autoAcceptedCount(b) === 0],
  ];

  constructor(wizard) {
    this.w = wizard;
    this.open = false;    // whether the panel is expanded (survives a step re-render)
    this.query = '';      // the name search
    this.filter = 'all';
    this._listEl = null;  // the row container, repainted in place so the search keeps focus
    // The other three parts `refresh()` updates in place. Deliberately not the `<details>` itself
    // and not the search field: rebuilding either would close the panel or drop the caret.
    this._summaryEl = null;
    this._barEl = null;
    this._undoEl = null;  // the stable slot the facility-wide undo button is painted into
  }

  /** The panel, or null when the carousel holds too few buildings for any of it to be worth the
   *  space — with two or three buildings the nav bar already *is* the overview. */
  section() {
    const buildings = this.w._mappableBuildings();
    if (buildings.length < 4) return null;
    this._summaryEl = Dom.el('summary', {}, this._summaryText(buildings));
    const details = Dom.el('details', { class: 'imp-overview' }, [
      this._summaryEl,
      this._progressBar(buildings),
      this._tools(buildings),
      this._list(buildings),
    ]);
    if (this.open) details.open = true;
    // Remember the disclosure state across the full `_stepMap()` re-render every carousel move
    // triggers — otherwise the panel closes itself each time it is used to jump somewhere.
    details.addEventListener('toggle', () => { this.open = details.open; });
    return details;
  }

  /** Split the facility three ways — `{done, unchecked, total}` — the one count the summary line and
   *  the bar are both drawn from (BUG-3).
   *
   *  A building only counts as **done** when it needs nothing *and* the wizard is in a position to
   *  know that (`_buildingSettled`). One it hasn't looked at is neither done nor outstanding, and
   *  saying so is the whole fix: its zero counts are an absence of information, not an absence of
   *  work. A building that already needs something is outstanding either way — it can only be
   *  confirmed by settling, never cleared. */
  _tally(buildings) {
    const w = this.w;
    let done = 0, unchecked = 0;
    for (const b of buildings) {
      if (w._attentionCount(b) > 0) continue;
      if (w._buildingSettled(b)) done++; else unchecked++;
    }
    return { done, unchecked, total: buildings.length };
  }

  /** The one line the collapsed panel shows: enough to answer "how much is left" without opening
   *  anything, which is the question a hundred-and-fifty-building walk asks constantly. */
  _summaryText(buildings) {
    const w = this.w;
    const t = this._tally(buildings);
    const bits = [t.done + ' of ' + t.total + ' done'];
    if (t.unchecked) bits.push(t.unchecked + ' not checked yet');
    const needFloor = buildings.reduce((n, b) => n + w._unassignedCount(b), 0);
    if (needFloor) bits.push(needFloor + (needFloor === 1 ? ' drawing needs' : ' drawings need')
      + ' a floor');
    const low = buildings.reduce((n, b) => n + w._lowConfidenceCount(b), 0);
    if (low) bits.push(low + ' read with low confidence');
    const auto = buildings.reduce((n, b) => n + w._autoAcceptedCount(b), 0);
    if (auto) bits.push(auto + ' set automatically');
    return 'All ' + t.total + ' buildings — ' + bits.join(' · ');
  }

  /** How far through the facility the operator is, as a bar — the same three-way split as the
   *  summary, drawn. Width percentages rather than a `<progress>` so it can be styled with the rest
   *  of the wizard's chrome in both themes, and so the not-checked-yet share can sit between the
   *  finished part and the outstanding remainder rather than being folded into either. */
  _progressBar(buildings) {
    this._barEl = Dom.el('div', { class: 'imp-overview-bar' });
    this._paintBar(buildings);
    return this._barEl;
  }

  /** Paint the bar from the current tally, in place — shared by the first render and `refresh()`. */
  _paintBar(buildings) {
    const t = this._tally(buildings);
    const pct = (n) => (t.total ? Math.round(n * 100 / t.total) : 0) + '%';
    const fill = Dom.el('span', { class: 'imp-overview-fill' });
    fill.style.width = pct(t.done);
    const unknown = Dom.el('span', { class: 'imp-overview-fill-unknown' });
    unknown.style.width = pct(t.unchecked);
    this._barEl.textContent = '';
    this._barEl.append(fill, unknown);
    this._barEl.title = t.done + ' of ' + t.total + ' buildings need nothing further.'
      + (t.unchecked ? ' ' + t.unchecked + ' have not been checked yet — their floors load as you '
        + 'open them, and as the floor-code sweep reaches them.' : '');
  }

  /** Search + filter + the facility-wide undo, each labelled in words rather than by a placeholder
   *  or an icon: this panel is the densest control cluster on the step, so it is the one that would
   *  most easily become a row of mystery buttons. */
  _tools(buildings) {
    const search = Dom.el('input', { type: 'text', class: 'imp-overview-find',
      value: this.query, placeholder: 'e.g. Astronomy' });
    search.addEventListener('input', () => {
      this.query = search.value;
      this._repaint();
    });
    const sel = Dom.el('select', {}, ImportOverview.FILTERS.map(([value, label]) =>
      Dom.el('option', { value }, label)));
    sel.value = this.filter;
    sel.addEventListener('change', () => { this.filter = sel.value; this._repaint(); });

    // An empty slot rather than a conditionally-appended button, so `refresh()` can restate the
    // count the sweep keeps moving without rebuilding the search field beside it.
    this._undoEl = Dom.el('span', { class: 'imp-overview-undo' });
    this._paintUndo();
    const row = [
      Dom.el('label', { class: 'imp-field' },
        [Dom.el('span', {}, 'Find a building by name'), search]),
      Dom.el('label', { class: 'imp-field' }, [Dom.el('span', {}, 'Show'), sel]),
      this._undoEl,
    ];
    return Dom.el('div', { class: 'imp-overview-tools' }, [
      Dom.el('div', { class: 'imp-overview-fields' }, row),
      Dom.el('span', { class: 'hint' }, 'Click any building below to open its drawings.'),
    ]);
  }

  /** The facility-wide undo, painted into its slot — nothing at all when the sweep has accepted
   *  nothing. Its count moves as batches land, so it is repainted rather than built once. */
  _paintUndo() {
    if (!this._undoEl) return;
    this._undoEl.textContent = '';
    const auto = this.w._autoAcceptedTotal();
    if (!auto) return;
    this._undoEl.append(Dom.el('button', {
      title: 'Turn every automatically-set floor back into a suggestion to confirm. The floors '
        + 'themselves are kept.',
      onclick: () => this.w._undoAutoAccepted() },
    'Undo ' + auto + (auto === 1 ? ' automatic floor' : ' automatic floors')));
  }

  /** Restate the whole panel from the current model, in place (BUG-3). The facility's numbers move
   *  without anyone touching the carousel — the background floor-code sweep loads a building's
   *  floors, reads its drawings and lands suggestions — and the panel used to learn about none of
   *  it until the next full `_stepMap()`, i.e. until the operator happened to click Next. Every
   *  in-place map-step refresh routes through `ImportFlow._refreshBuildActions`, which calls this.
   *
   *  Deliberately cheap and non-disruptive, in the spirit of `ImportOcrSweep._repaint`: the
   *  `<details>` and the search field are left alone (so the panel neither closes itself nor drops
   *  the caret mid-word), and only the four things that carry a count are restated. A no-op once
   *  the panel has left the DOM — a step change while a sweep is still landing results. */
  refresh() {
    if (!this._summaryEl || !this._summaryEl.isConnected) return;
    const buildings = this.w._mappableBuildings();
    this._summaryEl.textContent = this._summaryText(buildings);
    this._paintBar(buildings);
    this._paintUndo();
    this._repaint();
  }

  /** The row list, remembered so a keystroke repaints only it — rebuilding the whole panel would
   *  take the focus out of the search field on every character. */
  _list(buildings) {
    this._listEl = Dom.el('div', { class: 'imp-overview-list' });
    this._paintRows(buildings);
    return this._listEl;
  }

  /** Repaint the rows from the current search/filter, in place. A no-op once the panel has left the
   *  DOM (a step change while a sweep was still landing results into it). */
  _repaint() {
    if (!this._listEl || !this._listEl.isConnected) return;
    this._paintRows(this.w._mappableBuildings());
  }

  _paintRows(buildings) {
    const w = this.w;
    const rows = this.matching(buildings);
    this._listEl.textContent = '';
    if (!rows.length) {
      this._listEl.append(Dom.el('p', { class: 'hint' },
        'No building matches that name and filter.'));
      return;
    }
    for (const b of rows) {
      const idx = buildings.indexOf(b);
      const row = Dom.el('button', {
        class: 'imp-overview-row' + (idx === w._bIdx ? ' current' : ''),
        onclick: () => w._jumpToBuilding(b) }, [
        Dom.el('span', { class: 'imp-overview-name' }, b.name || b.folder),
        Dom.el('span', { class: 'imp-overview-state' }, this.stateText(b)),
      ]);
      this._listEl.append(row);
    }
  }

  /** The buildings the current search and filter select, in carousel order — pulled out of the
   *  rendering so the selection rule is one readable expression. The search is a plain
   *  case-insensitive substring over the name and the upload folder (an operator who knows the
   *  folder shouldn't have to translate it into the display name). */
  matching(buildings) {
    const q = this.query.trim().toLowerCase();
    const entry = ImportOverview.FILTERS.find(([v]) => v === this.filter);
    const pred = entry ? entry[2] : () => true;
    return buildings.filter(b => {
      if (q && ((b.name || '') + ' ' + b.folder).toLowerCase().indexOf(q) === -1) return false;
      return pred(this.w, b);
    });
  }

  /** One building's status, as the short phrase its row shows: what it still wants, then where the
   *  floor-code sweep has got with it. "✓ done" only when there is genuinely nothing left — an
   *  automatic floor nobody has confirmed is *not* done, even though it passes the build gate, and
   *  neither is a building the wizard hasn't looked at (BUG-3), whose empty counts say only that
   *  nothing has been loaded or read for it yet. With the sweep running that already reads as
   *  "floor codes not read yet" via `COVERAGE_TEXT`; the closing branch covers the rest — an
   *  install that can't read codes, or one with nothing marked to read them through. */
  stateText(b) {
    const w = this.w;
    const bits = [];
    const n = w._unassignedCount(b);
    if (n) bits.push(n + ' need a floor');
    const low = w._lowConfidenceCount(b);
    if (low) bits.push(low + ' low-confidence');
    const auto = w._autoAcceptedCount(b);
    if (auto) bits.push(auto + ' set automatically');
    const cov = w.ocr.coverage(b);
    const codes = ImportOverview.COVERAGE_TEXT[cov.state];
    if (codes) bits.push(codes);
    if (bits.length) return bits.join(' · ');
    return w._buildingSettled(b) ? '✓ done' : 'not checked yet';
  }

  /** What each `ImportOcrSweep.coverage` state says on a row. `off` and `done` say nothing: an
   *  install that doesn't read codes shouldn't mention them on 150 rows, and neither should a
   *  building the sweep has finished with — the absence of "not read yet" is the message. */
  static COVERAGE_TEXT = {
    off: '',
    done: '',
    'no-region': 'no floor-code region',
    reading: 'reading floor codes…',
    pending: 'floor codes not read yet',
  };
}
