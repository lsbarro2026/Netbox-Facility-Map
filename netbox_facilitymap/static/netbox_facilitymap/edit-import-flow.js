'use strict';
/* edit-import-flow.js — EditImportFlow: the non-linear edit hub for revising an already-built
   facility (Settings → "Edit buildings & floors"). Instead of the linear first-time walk it lands
   on `_stepHub`, which jumps straight to the one piece the user wants to change; every jump routes
   through the shared draft-backed step methods on ImportFlow, and the destructive rebuild stays an
   explicit Build action on the map step. It specializes ImportFlow with the three fresh-vs-edit
   hooks plus its own `_stepHub` and a non-linear `_chrome` header (no stepper — editing is
   hub-driven, not a walk). App.showImport() constructs this flow when the store already holds a
   built facility. */

class EditImportFlow extends ImportFlow {
  /** Non-linear chrome: a compact "Editing buildings & floors" header on the sub-step screens the
   *  hub jumps to (a `stepKey` is set), so an edit screen reads as a targeted change rather than a
   *  fresh install — but no stepper (the walk is the hub's job) and none on the hub itself or a
   *  detour (no `stepKey`). */
  _chrome(stepKey) {
    return stepKey
      ? Dom.el('div', { class: 'imp-edit-head' }, 'Editing buildings & floors')
      : null;
  }

  /** A scan on the edit path always finds the built facility's uploads (a normal build never wipes
   *  `uploads/` or the draft): preset the once-per-scan auto-match guard and land on the hub. */
  _resume() {
    this._autoMapDone = true;
    this._stepHub();
  }

  /** A scan failure must NOT fake a fresh install — the built map is still active and unchanged.
   *  Show a reassuring retry instead of dropping the user into a fresh upload. */
  _onScanError(e) {
    console.error('Import scan failed', e);
    const view = this._stage('Edit import');
    view.append(Dom.el('p', { class: 'imp-bind-warn' },
      'Could not load the import. Your facility map is unchanged and still active.'));
    view.append(Dom.el('div', { class: 'imp-actions' }, [
      Dom.el('button', { class: 'primary', onclick: () => this.show() }, 'Retry'),
      Dom.el('button', { onclick: () => this.app.go('#/') }, 'Back to map'),
    ]));
  }

  /** The edit-mode bind-step action row: **Save & back to hub** / **← Back to hub** so a one-off
   *  re-bind returns where it came from. Leaving a building unbound is fine here — the hub surfaces
   *  the ⚠ row. Since the once-per-scan auto-match is suppressed on the edit path (`_resume` presets
   *  `_autoMapDone`), an **Auto-match sites** button is offered on demand while anything is unbound;
   *  re-arming the guard and re-entering the step runs the match (it only fills unbound rows and
   *  flags them `auto`, never clobbering a confirmed binding). */
  _buildingsActions(focusBuilding) {
    const actions = [
      Dom.el('button', { class: 'primary',
        onclick: async () => { await this._saveDraft(); this._stepHub(); } }, 'Save & back to hub'),
      Dom.el('button', { onclick: () => this._stepHub() }, '← Back to hub'),
    ];
    if (!this._allBuildingsBound())
      actions.push(Dom.el('button', {
        onclick: () => { this._autoMapDone = false; this._stepBuildings(focusBuilding); } },
        'Auto-match sites'));
    return Dom.el('div', { class: 'imp-actions' }, actions);
  }

  /** The non-linear edit hub — the landing when re-editing an already-built facility (see
   *  `show()`/`_resume`). Instead of forcing the linear upload→bind→map→build walk, it lists each
   *  piece assigned during import with its current value inline and a direct affordance that jumps
   *  to the matching existing step. Every jump routes through the draft-backed step methods (each
   *  saves the draft and returns to the map), so nothing here writes or rebuilds — the destructive
   *  rebuild stays an explicit action on the map step. */
  _stepHub() {
    const view = this._stage('Edit import');
    view.append(Dom.el('p', { class: 'hint' },
      'Jump straight to the piece you want to change. Each edit returns to the map, where you '
      + 'rebuild the facility once everything looks right.'));

    // Install-wide facility grouping (MULTI-3): the NetBox grouping the facility picker resolves
    // against. Re-editable here (the wizard's post-import edit surface); returns to the hub.
    view.append(Dom.el('section', { class: 'imp-bind imp-hub-row' }, [
      Dom.el('div', { class: 'imp-bind-head' }, [
        Dom.el('div', { class: 'imp-bind-folder' }, 'Facility grouping'),
        Dom.el('span', { class: 'imp-hub-meta' },
          this.app.grouping === 'region' ? 'Region' : 'Site Group'),
      ]),
      Dom.el('div', { class: 'imp-hub-acts' }, [
        Dom.el('button', { onclick: () => this._stepGrouping(() => this._stepHub()) },
          'Edit grouping'),
      ]),
    ]));

    // Site-wide pieces (the rarer edits): the chosen site plan and the global drawing-code crop.
    const siteplanLabel = this.site.file ? (this.site.folder + ' / ' + this.site.file) : '(none)';
    view.append(Dom.el('section', { class: 'imp-bind imp-hub-row' }, [
      Dom.el('div', { class: 'imp-bind-head' }, [
        Dom.el('div', { class: 'imp-bind-folder' }, 'Siteplan'),
        Dom.el('span', { class: 'imp-hub-meta' }, siteplanLabel),
      ]),
      Dom.el('div', { class: 'imp-hub-acts' }, [
        Dom.el('button', { onclick: () => this._stepSiteplan() }, 'Edit siteplan'),
        Dom.el('button', { onclick: () => this._stepRegionPick() }, 'Edit drawing-code crop'),
      ]),
    ]));

    // Per-building pieces (the common edits): bound NetBox site + floor assignment. The carousel
    // set (`_mappableBuildings`) is exactly the buildings the map/bind steps page over, so the hub
    // degrades the same way the linear steps do for a siteplan-only import — an empty list leaves
    // just the site-plan row above.
    const buildings = this._mappableBuildings();
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i], idx = i;
      const drawings = b.pdfs.filter(p => b.assign[p.stem].type !== 'none');
      const unassigned = drawings.filter(p => this._cardUnassigned(b, p)).length;

      const state = b.nbSite
        ? Dom.el('span', { class: 'imp-bind-ok' }, '✓ ' + b.nbSite.name + ' (' + b.nbSite.slug + ')')
        : Dom.el('span', { class: 'imp-bind-warn' }, '⚠ not bound to a NetBox site');
      const floors = Dom.el('span', { class: 'imp-hub-meta' + (unassigned ? ' warn' : '') },
        drawings.length + (drawings.length === 1 ? ' drawing' : ' drawings')
        + (unassigned ? ' · ' + unassigned + ' unassigned' : ''));

      const acts = [];
      if (b.nbSite) {
        acts.push(Dom.el('button', { class: 'primary', onclick: async () => {
          this._bIdx = idx; await this._saveDraft(); this._stepMap();
        } }, 'Edit floors →'));
        acts.push(Dom.el('button', { onclick: () => this._stepBuildings(b) }, 'Edit site'));
        acts.push(Dom.el('button', { onclick: () => this._stepRegionPick(b) }, 'Code crop'));
      } else {
        // Floor mapping needs the building bound first (its NetBox floor Locations are fetched by
        // slug), so route to the bind step rather than landing the user in a broken floor step.
        acts.push(Dom.el('button', { class: 'primary', onclick: () => this._stepBuildings(b) },
          'Bind site →'));
      }

      view.append(Dom.el('section', { class: 'imp-bind imp-hub-row' }, [
        Dom.el('div', { class: 'imp-bind-head' }, [
          Dom.el('div', { class: 'imp-bind-folder' }, b.name || b.folder), state, floors,
        ]),
        Dom.el('div', { class: 'imp-hub-acts' }, acts),
      ]));
    }

    const hubActions = [
      Dom.el('button', { class: 'primary', onclick: () => this._stepMap() }, 'Review & build →'),
      Dom.el('button', { onclick: () => this._addDrawings() }, '+ Add drawings'),
    ];
    // Guess NetBox sites for every unbound building in one click: re-arm the once-guard and drop into
    // the binding step, which then shows the "Matching…" progress and the auto-matched rows to
    // confirm (the same on-demand path the step's own "Auto-match sites" button uses).
    if (!this._allBuildingsBound())
      hubActions.push(Dom.el('button', {
        onclick: () => { this._autoMapDone = false; this._stepBuildings(); } }, 'Auto-match sites'));
    view.append(Dom.el('div', { class: 'imp-actions' }, hubActions));
  }
}
