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

  /** An already-built facility opens the topology step on **manual** (TOPO-3): it is configured and
   *  working, so the honest opening is what *is* set — the detect route's proposal, arriving
   *  unbidden, reads as a recommendation to change it. Both other routes stay one click away. */
  _topologyDefaultRoute() { return 'manual'; }

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
   *  `_autoMapDone`), an **Auto-match buildings** button is offered on demand while anything is unbound;
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
        'Auto-match buildings'));
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

    // The topology answer (TOPO-3): the install-wide facility grouping (MULTI-3) plus this
    // facility's organization mode (MODEL-6), both set by the one step. Re-editable here (the
    // wizard's post-import edit surface); returns to the hub. The value is rendered through
    // `ImportFlow.groupingLabel` so the `location` grouping reads as itself rather than as the
    // first branch of a two-way ternary.
    //
    // On a built facility the row carries what changing it *would* do (TOPO-4): every other hub row
    // edits this facility's own content, so a settings row among them reads as one more thing the
    // rebuild will apply. Saying up front that it steers the next binding — and moves nothing
    // already bound — is what makes the row safe to open, which is the whole point of surfacing it
    // here rather than leaving "wipe and re-import" as the recovery path for a wrong answer.
    view.append(Dom.el('section', { class: 'imp-bind imp-hub-row' }, [
      Dom.el('div', { class: 'imp-bind-head' }, [
        Dom.el('div', { class: 'imp-bind-folder' }, 'Facility layout'),
        Dom.el('span', { class: 'imp-hub-meta' }, this._currentTopologyLabel()),
      ]),
      Dom.el('p', { class: 'hint' }, 'What counts as a facility here, and what counts as a '
        + 'building. Changing it steers what the next binding searches — buildings you have already '
        + 'bound keep their NetBox anchor and their rooms.'),
      Dom.el('div', { class: 'imp-hub-acts' }, [
        Dom.el('button', { onclick: () => this._stepTopology(() => this._stepHub()) },
          'Edit layout'),
      ]),
    ]));

    // Campus site (site-as-campus mode only, MODEL-7): the one Site the per-building bind search is
    // scoped to. Re-enterable here so the non-linear hub can change it without a linear walk
    // (gotcha (a) — the choice must not be a one-shot wizard page); returns to the hub.
    if (this._isCampusMode())
      view.append(Dom.el('section', { class: 'imp-bind imp-hub-row' }, [
        Dom.el('div', { class: 'imp-bind-head' }, [
          Dom.el('div', { class: 'imp-bind-folder' }, 'Campus site'),
          this.campus
            ? Dom.el('span', { class: 'imp-hub-meta' }, this.campus.name + ' (' + this.campus.slug + ')')
            : Dom.el('span', { class: 'imp-hub-meta warn' }, 'not chosen'),
        ]),
        Dom.el('div', { class: 'imp-hub-acts' }, [
          Dom.el('button', { onclick: () => this._stepCampus(() => this._stepHub()) },
            'Edit campus'),
        ]),
      ]));

    // The site-wide pieces (the rarer edits): the chosen site plan and the global floor-code crop.
    // One row with one button, because both are asked on one step since IMPORT-37 — two buttons
    // opening the same screen would just be two names for the same edit.
    const siteplanLabel = this.site.file ? (this.site.folder + ' / ' + this.site.file) : '(none)';
    view.append(Dom.el('section', { class: 'imp-bind imp-hub-row' }, [
      Dom.el('div', { class: 'imp-bind-head' }, [
        Dom.el('div', { class: 'imp-bind-folder' }, 'Site plan & floor code'),
        Dom.el('span', { class: 'imp-hub-meta' }, siteplanLabel),
        Dom.el('span', { class: 'imp-hub-meta' },
          this._codeRegion ? 'floor-code crop marked' : 'no floor-code crop'),
      ]),
      Dom.el('div', { class: 'imp-hub-acts' }, [
        Dom.el('button', { onclick: () => this._stepSiteplan() }, 'Edit site plan & code crop'),
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
        ? Dom.el('span', { class: 'imp-bind-ok' }, '✓ ' + this._anchorSummary(b))
        : Dom.el('span', { class: 'imp-bind-warn' }, '⚠ not bound to NetBox');
      const floors = Dom.el('span', { class: 'imp-hub-meta' + (unassigned ? ' warn' : '') },
        drawings.length + (drawings.length === 1 ? ' drawing' : ' drawings')
        + (unassigned ? ' · ' + unassigned + ' unassigned' : ''));

      const acts = [];
      if (b.nbSite) {
        acts.push(Dom.el('button', { class: 'primary', onclick: async () => {
          this._bIdx = idx; await this._saveDraft(); this._stepMap();
        } }, 'Edit floors →'));
        acts.push(Dom.el('button', { onclick: () => this._stepBuildings(b) }, 'Edit binding'));
        acts.push(Dom.el('button', { onclick: () => this._stepRegionPick(b) },
          'Set floor-code region…'));
      } else {
        // Floor mapping needs the building bound first (its NetBox floor Locations are fetched by
        // slug), so route to the bind step rather than landing the user in a broken floor step.
        acts.push(Dom.el('button', { class: 'primary', onclick: () => this._stepBuildings(b) },
          'Bind to NetBox →'));
      }

      view.append(Dom.el('section', { class: 'imp-bind imp-hub-row' }, [
        Dom.el('div', { class: 'imp-bind-head' }, [
          Dom.el('div', { class: 'imp-bind-folder' }, b.name || b.folder), state, floors,
        ]),
        Dom.el('div', { class: 'imp-hub-acts' }, acts),
      ]));
    }

    // Drawings the organize step left out of the map (IMPORT-24). They live in the reserved
    // `_excluded` folder, which `building_folders()` skips — so they are invisible to every other
    // surface, and exclusion was one-way once Continue was pressed. `scan` reports the park under
    // its own key purely so this row can exist (IMPORT-26): the undeleted bytes are otherwise
    // unreachable without re-importing the whole facility.
    const excluded = this.inv?.excluded || [];
    if (excluded.length)
      view.append(Dom.el('section', { class: 'imp-bind imp-hub-row' }, [
        Dom.el('div', { class: 'imp-bind-head' }, [
          Dom.el('div', { class: 'imp-bind-folder' }, 'Excluded drawings'),
          Dom.el('span', { class: 'imp-hub-meta' },
            excluded.length + (excluded.length === 1 ? ' drawing' : ' drawings')
            + ' left out of this import'),
        ]),
        Dom.el('p', { class: 'hint' }, 'Drawings set aside during import — a title sheet, a legend, '
          + 'a stray revision. Nothing was deleted, so any of them can be put back into a building.'),
        Dom.el('div', { class: 'imp-hub-acts' }, [
          Dom.el('button', { onclick: () => this._stepExcluded() }, 'Restore drawings…'),
        ]),
      ]));

    const hubActions = [
      Dom.el('button', { class: 'primary', onclick: () => this._stepMap() }, 'Review & build →'),
      Dom.el('button', { onclick: () => this._addDrawings() }, '+ Add drawings'),
    ];
    // Guess NetBox sites for every unbound building in one click: re-arm the once-guard and drop into
    // the binding step, which then shows the "Matching…" progress and the auto-matched rows to
    // confirm (the same on-demand path the step's own "Auto-match buildings" button uses).
    if (!this._allBuildingsBound())
      hubActions.push(Dom.el('button', {
        onclick: () => { this._autoMapDone = false; this._stepBuildings(); } }, 'Auto-match buildings'));
    view.append(Dom.el('div', { class: 'imp-actions' }, hubActions));
  }

  /** Put drawings excluded during the import's Buildings step (IMPORT-24) back into a building — the
   *  undo that exclusion deliberately lacked while the import was still a linear walk (IMPORT-26).
   *
   *  Lives here rather than on that step because it belongs to the fresh flow — the edit hub is
   *  what an operator has once the import is built, which is exactly when the mistake is noticed.
   *  A **detour** (no `stepKey`, so `_chrome` renders nothing) with a discoverable top-of-page
   *  back control.
   *
   *  The destination is one of this facility's **existing** folders. "Put it back where it came
   *  from" isn't generally available — the regroup prunes a source folder it empties — and an
   *  existing building is already bound to NetBox, so a restored drawing is floor-mappable straight
   *  away instead of dragging the operator back through the bind step. */
  _stepExcluded() {
    const drawings = this.inv?.excluded || [];
    if (!drawings.length) return this._stepHub();

    const view = this._stage('Restore excluded drawings');
    this._detourBack(view, '← Back to hub', () => this._stepHub());
    view.append(Dom.el('p', { class: 'hint' },
      'These drawings were left out of the map during import. Nothing was deleted — pick a '
      + 'building for any you want back, and leave the rest as they are. A restored drawing '
      + 'arrives unassigned, so give it a floor before you rebuild.'));

    // Destinations are the scanned upload folders as they stand now. Empty only in the degenerate
    // case of a facility whose every building was regrouped away, which leaves nothing to restore
    // *into* — say so rather than showing a picker with one useless option.
    if (!this.buildings.length) {
      view.append(Dom.el('p', { class: 'imp-bind-warn' },
        'There are no buildings to restore into. Add drawings first, then come back.'));
      view.append(Dom.el('div', { class: 'imp-actions' },
        [Dom.el('button', { onclick: () => this._stepHub() }, '← Back to hub')]));
      return;
    }

    // file → destination folder, for the rows the operator picked one for. A row absent from the
    // map keeps its exclusion — the default, so Restore is opt-in per drawing.
    const dest = new Map();
    const restore = Dom.el('button', { class: 'primary', onclick: () => {
      if (!dest.size) return Toast.show('Pick a building for at least one drawing.', true);
      // `{ destFolder: [uploads-relative src, ...] }` — the same payload the organize step's
      // Continue posts, with the reserved park as the *source* this time. The server validates
      // every move before touching a file, so a name collision in the destination rejects the
      // whole restore and leaves the park exactly as it was.
      const groups = {};
      for (const [file, folder] of dest)
        (groups[folder] || (groups[folder] = [])).push(ImportFlow.EXCLUDED_FOLDER + '/' + file);
      this._restoreExcluded(groups, dest.size);
    } }, 'Restore');
    const paintCount = () => {
      restore.textContent = dest.size
        ? 'Restore ' + dest.size + (dest.size === 1 ? ' drawing' : ' drawings')
        : 'Restore';
    };

    const grid = Dom.el('div', { class: 'imp-assign-grid' });
    for (const p of drawings) {
      // Same thumbnail affordance as an organize row (IMPORT-23): the scan thumbnail (always page
      // 1), falling back to the on-demand preview when it failed to render, with wheel-zoom /
      // drag-pan and click-to-lightbox. Looking at the drawing is what decides whether it belongs
      // after all, so it has to be inspectable here and not just named.
      const img = Dom.el('img', {
        src: p.thumb ? ImportFlow._media(p.thumb) : ImportPreview.previewUrl(p.pdf),
        loading: 'lazy', title: 'Click to see the whole drawing',
      });
      const thumb = Dom.el('div', { class: 'imp-thumb imp-assign-thumb' }, [img]);
      // Zoom upgrades a scan thumbnail to the full-scale preview once; a row whose thumbnail
      // failed is already showing it. This screen renders once (no repaint on pick), so the frame
      // needs no home on the model.
      let hires = !p.thumb;
      ImportPreview.attachZoomPan(thumb, img, { scale: 1, x: 0, y: 0 }, {
        onClick: () => ImportPreview.lightbox(p),
        onZoom: () => { if (!hires) { hires = true; img.src = ImportPreview.previewUrl(p.pdf); } },
      });

      const picker = Dom.el('select', {
        onchange: (e) => {
          if (e.target.value) dest.set(p.file, e.target.value);
          else dest.delete(p.file);
          paintCount();
        },
      }, [Dom.el('option', { value: '' }, '— keep excluded —')]);
      for (const b of this.buildings)
        picker.append(Dom.el('option', { value: b.folder }, b.name || b.folder));

      grid.append(Dom.el('div', { class: 'imp-assign-row' }, [
        thumb,
        Dom.el('span', { class: 'imp-assign-name', title: p.file }, p.file),
        Dom.el('span', { class: 'imp-assign-suggest' },
          Dom.el('span', { class: 'imp-assign-cand' }, 'Restore into:')),
        picker,
      ]));
    }
    view.append(grid);

    paintCount();
    view.append(Dom.el('div', { class: 'imp-actions' }, [
      restore,
      Dom.el('button', { onclick: () => this._stepHub() }, '← Back to hub'),
    ]));
  }

  /** Move the picked drawings out of the reserved park into their chosen buildings, then rebuild
   *  the folder-keyed model from a fresh scan and return to the hub. `groups` is the regroup
   *  payload; `count` is how many drawings it moves (for the confirmation).
   *
   *  The rebuild is `show()`'s sequence, not `_regroup`'s: `_modelFromInventory` resets every
   *  building, so the draft and the built manifest are what put the other buildings' floors and
   *  bindings back. It skips `_regroup`'s `_bindFromOrganizePicks` — that carries the *organize
   *  step's* NetBox picks, which a restore never makes — and lands on the hub rather than the bind
   *  step, since nothing here can leave a building unbound. */
  async _restoreExcluded(groups, count) {
    const view = this._stage('Restoring drawings…');
    view.append(Dom.el('p', { class: 'imp-progress' }, 'Moving drawings back into buildings…'));
    try {
      await Api.post('/api/import/regroup', { groups });
      const inv = await this.scan();
      if (!inv.ok) throw new Error(inv.error || 'scan failed');
      this.inv = inv;
    } catch (e) {
      Toast.show('Could not restore drawings: ' + e.message, true);
      return this._stepExcluded();
    }
    this._modelFromInventory();
    await this._applyDraft();
    this._reconcileFromManifest();
    // The restored drawing is now part of the model with `_modelFromInventory`'s default floor —
    // persist that alongside everything the draft just restored, so a reload doesn't land the
    // operator back on a facility that has forgotten the move happened.
    await this._saveDraft();
    Toast.show(count + (count === 1 ? ' drawing is' : ' drawings are')
      + ' back in the map — give them a floor, then rebuild.');
    this._stepHub();
  }
}
