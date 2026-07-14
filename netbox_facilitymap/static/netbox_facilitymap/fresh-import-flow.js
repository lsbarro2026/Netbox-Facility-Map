'use strict';
/* fresh-import-flow.js — FreshImportFlow: the linear first-time import.
   The process a brand-new install walks once (grouping → upload → bind buildings → siteplan →
   code-region → map floors → build). It specializes ImportFlow with the three fresh-vs-edit hooks
   plus the linear-walk chrome (`_chrome` renders the step-progress stepper, `_backButton` the
   per-step back-nav, both driven by the `STEPS` order it owns); every step method itself lives on
   the base and is shared with EditImportFlow.
   App.showImport() constructs this flow when the store has no built facility yet. */

class FreshImportFlow extends ImportFlow {
  // The linear step order (the runtime order `_stepMap` gates through: siteplan before code-region),
  // used to render the stepper and to resolve a step's previous step for the back-nav. `key` matches
  // the `stepKey` each step method hands to `_stage`.
  static STEPS = [
    { key: 'grouping', label: 'Grouping' },
    { key: 'upload', label: 'Upload' },
    { key: 'bind', label: 'Sites' },
    { key: 'siteplan', label: 'Siteplan' },
    { key: 'coderegion', label: 'Code crop' },
    { key: 'map', label: 'Map & build' },
  ];

  /** A scan that found existing (not-yet-built) uploads resumes the linear walk: straight to floor
   *  mapping when every floor-contributing building is already bound (from the restored draft),
   *  otherwise the binding step. */
  _resume() {
    if (this._allBuildingsBound()) { this._autoMapDone = true; this._stepMap(); }
    else this._stepBuildings();
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
    const steps = FreshImportFlow.STEPS;
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
        const go = () => this._goToStep(s.key);
        li.addEventListener('click', go);
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
        });
      }
      ol.append(li);
    });
    return ol;
  }

  /** The `← Back` control for a linear step's action row: navigates to the previous step. Null on
   *  the first step (grouping), so a shared step drops the null child via `Dom.el`. */
  _backButton(stepKey) {
    const i = FreshImportFlow.STEPS.findIndex(s => s.key === stepKey);
    if (i <= 0) return null;
    const prev = FreshImportFlow.STEPS[i - 1];
    return Dom.el('button', { class: 'imp-back', onclick: () => this._goToStep(prev.key) }, '← Back');
  }

  /** Navigate to a linear step (from the stepper or a back button), persisting any in-progress
   *  edits first so nothing typed on the current step is lost. Routes through the same shared step
   *  methods a forward move uses. */
  async _goToStep(key) {
    if (this.buildings.length) await this._saveDraft();
    switch (key) {
      case 'grouping': return this._stepGrouping(() => this._stepUpload());
      case 'upload': return this._stepUpload();
      case 'bind': return this._stepBuildings();
      case 'siteplan': return this._stepSiteplan();
      case 'coderegion': return this._stepRegionPick();
      case 'map': return this._stepMap();
    }
  }

  /** The linear bind-step action row: **← Back** (to upload) + **Continue to floor mapping →**
   *  (gated until every building is bound) plus the destructive **Start over**. So a first import
   *  can't reach the build with a building unbound. */
  _buildingsActions(_focusBuilding) {
    const bound = this._allBuildingsBound();
    const cont = Dom.el('button', { class: 'primary',
      onclick: async () => { await this._saveDraft(); this._stepMap(); } },
      'Continue to floor mapping →');
    cont.disabled = !bound;
    const actions = [this._backButton('bind'), cont, this._startOver()];
    if (!bound) actions.push(Dom.el('span', { class: 'hint' },
      'Bind every building to a NetBox site first.'));
    return Dom.el('div', { class: 'imp-actions' }, actions);
  }
}
