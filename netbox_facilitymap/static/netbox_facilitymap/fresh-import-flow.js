'use strict';
/* fresh-import-flow.js — FreshImportFlow: the linear first-time import.
   The process a brand-new install walks once (grouping → upload → buildings → site plan →
   map floors → build). It specializes ImportFlow with the fresh-vs-edit hooks
   plus the linear-walk chrome (`_chrome` renders the step-progress stepper, `_backButton` the
   per-step back-nav, both driven by the `STEPS` order it owns); the step methods live on the base
   and are shared with EditImportFlow — except the Buildings step, where the flows genuinely diverge
   (IMPORT-34): fresh overrides `_stepBuildings` to the merged organize+bind step
   (`ImportOrganize.step`), while edit keeps the base's per-building bind screen.
   App.showImport() constructs this flow when the store has no built facility yet. */

class FreshImportFlow extends ImportFlow {
  // The linear step order — the walk's single source of truth since IMPORT-37, rather than a
  // display of an order `_stepMap` re-implemented as hidden gates. It renders the stepper, resolves
  // a step's previous step for the back-nav, and is what `_afterBuildings`/`_resume` route into.
  // `key` matches the `stepKey` each step method hands to `_stage`.
  static STEPS = [
    { key: 'grouping', label: 'Layout' },
    { key: 'upload', label: 'Upload' },
    { key: 'sites', label: 'Buildings' },
    { key: 'siteplan', label: 'Site plan' },
    { key: 'map', label: 'Map & build' },
  ];

  /** The live step list for this import. The static `STEPS` above, plus — only when the facility is
   *  declared `site-as-campus` (MODEL-7) — a **Campus** step between upload and buildings, where the
   *  operator picks the one campus Site the buildings step then scopes to. Computed rather than static
   *  so the stepper/back-nav track the mode without a `hasContent()`-style branch in each consumer. */
  _steps() {
    const steps = FreshImportFlow.STEPS;
    if (!this._isCampusMode()) return steps;
    const at = steps.findIndex(s => s.key === 'sites');
    return [...steps.slice(0, at), { key: 'campus', label: 'Campus' }, ...steps.slice(at)];
  }

  /** The fresh flow's Buildings step is the merged organize+bind screen (IMPORT-34): grouping drawings
   *  into buildings and anchoring those buildings to NetBox are one question asked once, on one
   *  stepper entry — `ImportOrganize.step` owns both entry modes (per-drawing pile, folder groups).
   *  The base delegator keeps routing the edit hub to the per-building bind screen, so every shared
   *  caller stays a plain `_stepBuildings()` call. */
  _stepBuildings(focusBuilding) {
    return this.organize.step(focusBuilding);
  }

  /** A first import opens the topology step on **detect** (TOPO-3): an operator setting the plugin
   *  up for the first time is exactly the one who can't yet name their own topology in the plugin's
   *  vocabulary, so being *told* what their NetBox looks like — in its own object names — beats
   *  being asked. (The edit flow overrides this; the answer must not be a `hasContent()` branch
   *  inside the shared step, §10.) */
  _topologyDefaultRoute() { return 'detect'; }

  /** The next step of the walk once the Buildings step is done with the buildings question — the
   *  facility-wide Site plan step, which every fresh import passes through on its way to floor
   *  mapping (see `STEPS`). The base lands the hub straight on the map instead. */
  _afterBuildings() { return this._stepSiteplan(); }

  /** A scan that found existing (not-yet-built) uploads resumes the linear walk where it stopped:
   *  the binding step while any floor-contributing building is unbound (from the restored draft),
   *  then the Site plan step until it has been answered, then floor mapping. Resuming is exactly
   *  the "where does this land" question a hook is for — the map step itself never redirects. */
  _resume() {
    if (!this._allBuildingsBound()) return this._stepBuildings();
    this._autoMapDone = true;
    return this._siteplanStepDone ? this._stepMap() : this._stepSiteplan();
  }

  /** A scan failure on a fresh import is genuinely indistinguishable from "nothing uploaded yet",
   *  so degrade to the normal fresh start — but surface the error rather than swallowing it. */
  _onScanError(e) {
    Toast.show('Could not check for existing uploads: ' + e.message, true);
    this._freshStart();
  }

  /** The step-progress stepper prepended above each linear step's title. Steps before the current
   *  one are done (✓) and clickable to jump back (`_goToStep`); the current is highlighted; later
   *  steps are upcoming. A detour/transient screen passes no `stepKey` (not in `STEPS`) → no
   *  stepper. */
  _chrome(stepKey) {
    const steps = this._steps();
    // Re-seated on every render (including the detour case below, which renders no stepper at all),
    // so `_setChromeBusy` can only ever reach entries that are actually on screen.
    this._stepperItems = [];
    const cur = steps.findIndex(s => s.key === stepKey);
    if (cur < 0) return null;
    const ol = Dom.el('ol', { class: 'imp-steps' });
    steps.forEach((s, i) => {
      const state = i < cur ? 'done' : (i === cur ? 'current' : 'todo');
      const li = Dom.el('li', { class: 'imp-step imp-step-' + state }, [
        Dom.el('span', { class: 'imp-step-num' }, i < cur ? '✓' : String(i + 1)),
        Dom.el('span', { class: 'imp-step-label' }, s.label),
      ]);
      if (i === cur) li.setAttribute('aria-current', 'step');
      if (state === 'done') {
        li.classList.add('clickable');
        li.setAttribute('role', 'button');
        li.setAttribute('tabindex', '0');
        li.setAttribute('title', 'Go back to ' + s.label);
        const go = () => this._goToStep(s.key, stepKey);
        li.addEventListener('click', go);
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
        });
        this._stepperItems.push(li);
      }
      ol.append(li);
    });
    return ol;
  }

  /** Disable the stepper's jump-back entries while an upload run or scan is in flight (IMPORT-55).
   *  The upload step already disables its own `← Back` for this reason, but the stepper offered the
   *  identical jump unguarded: taking it mid-run detaches the live progress line the runner is
   *  narrating into, so returning showed a faithfully-restored busy label over an empty,
   *  freshly-rendered one — a label with no count.
   *  `_goToStep` refuses the jump regardless — that is the enforcement, which also covers a click
   *  landing just before this does; this is the visible half, so an entry doesn't invite a click it
   *  will not honour. */
  _setChromeBusy(busy) {
    for (const li of this._stepperItems) {
      li.setAttribute('aria-disabled', busy ? 'true' : 'false');
      li.setAttribute('tabindex', busy ? '-1' : '0');
    }
  }

  /** The `← Back` control for a linear step's action row: navigates to the previous step. Null on
   *  the first step (grouping), so a shared step drops the null child via `Dom.el`. */
  _backButton(stepKey) {
    const steps = this._steps();
    const i = steps.findIndex(s => s.key === stepKey);
    if (i <= 0) return null;
    const prev = steps[i - 1];
    return Dom.el('button',
      { class: 'imp-back', onclick: () => this._goToStep(prev.key, stepKey) }, '← Back');
  }

  /** Navigate to a linear step (from the stepper or a back button), persisting any in-progress
   *  edits first so nothing typed on the current step is lost. Routes through the same shared step
   *  methods a forward move uses. `from` is the step being left — grouping is the one step whose
   *  Continue doesn't have a fixed next step (unlike every other case here), so it needs to know
   *  where to return the user to rather than always resuming the first-run walk at Upload. */
  async _goToStep(key, from) {
    // An upload run or scan in flight owns the step it was started from: leaving strands a runner
    // still streaming files into a progress line this navigation detaches, and the scan that follows
    // yanks the operator forward out of wherever they went (§10 in-app-import). Both nav-aways —
    // the stepper's done entries and the step's own `← Back` — route through here, so the refusal
    // lives here once rather than on each control; the disabled control is only its visible half.
    const gate = ImportFlow.busyGate({ phase: this.uploader.phase, scanBusy: this.scanBusy });
    if (gate.busy) { Toast.show(gate.message, true); return; }
    if (this.buildings.length) await this._saveDraft();
    switch (key) {
      case 'grouping': return this._stepTopology(() => this._goToStep(from || 'upload'));
      case 'upload': return this._stepUpload();
      case 'campus': return this._stepCampus(() => this._stepBuildings());
      case 'sites': return this._stepBuildings();
      case 'siteplan': return this._stepSiteplan();
      case 'map': return this._stepMap();
    }
  }
}
