'use strict';
/* import-bind.js — ImportBind: the import wizard's "Map buildings to NetBox" concern — the
   per-building bind screen that anchors each drawing folder to a NetBox Site or building Location
   (MODEL-4/MODEL-7), the once-per-scan building→NetBox auto-match behind it, the organize-step
   provenance line (IMPORT-25), the anchor-confirm surface that answers it — per card and, from two
   guesses up, once for all of them (IMPORT-57) — and the per-Site facility-assignment confirm
   surface (FACILITY-IDENTITY Phase 2, MULTI-6).

   Holds a wizard back-ref (`this.w`), the ImportUploader shape. The step renders through the
   flow's `_stage` and its subclass hooks (`_buildingsActions` — now edit's action row — stays on
   the flow), and it mutates the building model only through the flow's own binding methods
   (`_bindSite`/`_bindBuilding`), so an anchor still moves only through those. The flow reaches it
   through the `_stepBuildings` delegator — since IMPORT-34 that lands here for the **edit hub
   only** (`FreshImportFlow` overrides the delegator to the merged Buildings step,
   `ImportOrganize.step`, whose group headers reuse `_bindRow`/`_autoMapBuildings`/the assignment
   surface from this class, so the anchor picker exists once). It also owns the guard-then-render
   shape both screens' `step()` methods are built from (IMPORT-41): `_guardCampus` (the
   `site-as-campus` detour), `_guardLoad` (one guarded background fetch — auto-match, facility
   assignments, and organize's own candidate fetch, each showing a progress line while it loads),
   and `bindPreamble` (the mode-aware hint + IMPORT-25 carried-picks note + org-mode-note/campus-row
   banner pair + the hoisted facility control) — `ImportOrganize.step`/`_render` call into all three
   rather than keeping its own copies.

   A settled card is **quiet**: since IMPORT-58 `_bindRow`'s anchor search is built hidden behind a
   **Change** button, open up front only for an unbound building or the caller's `openSearch` focus
   target — one option on the one shared row builder, so both screens stop mounting a live search per
   building.

   The facility control renders **once per Site, not once per building** (IMPORT-56): it is keyed on
   `nbSite.slug`, so where every bound building shares one Site — every `site-as-campus` import —
   `sharedFacilitySite` sends it to the preamble and the cards drop it. Buildings that genuinely
   disagree keep the per-card control. */

class ImportBind {
  constructor(wizard) {
    this.w = wizard;
    // The explicit Site→facility assignment map (FACILITY-IDENTITY Phase 2, MULTI-6), fetched once
    // per bind-step entry and refreshed from each write's response. Install-wide server state, so —
    // like the grouping choice — it is NOT part of the draft. `undefined` = not fetched yet (the
    // bind step loads it), `null` = the read failed (the control is hidden rather than guessed at),
    // an object = `{site_slug: facility_slug}`; a Site absent from it still derives its facility.
    this._assignments = undefined;
  }

  /** The organize-step pick a building's **current** anchor still stands on (IMPORT-25), or null —
   *  what lets the bind step say where a binding came from instead of presenting it as its own
   *  auto-match. Re-checked against the live anchor rather than trusted from the map, so an operator
   *  who re-binds the row through its search drops the provenance line along with the binding. */
  _carriedPick(b) {
    const pick = b.nbSite && this.w.organize._organizePicks.get(b.folder);
    if (!pick) return null;
    const anchor = pick.anchor;
    const stands = anchor.kind === 'building'
      ? !!b.nbBuilding && b.nbBuilding.slug === anchor.building.slug
      : !b.nbBuilding && b.nbSite.slug === anchor.site.slug;
    return stands ? pick : null;
  }

  /** The confident match among `cands` for a building folder, or null: an entry whose slug equals the
   *  folder-derived slug, whose name matches it, or a lone result. Shared by both halves of the
   *  auto-match so a Site and a building Location are judged by exactly the same bar. */
  static _confidentMatch(cands, b) {
    const nameLc = b.name.toLowerCase();
    return cands.find(c => c.slug === b.slug)
      || cands.find(c => (c.name || '').toLowerCase() === nameLc)
      || (cands.length === 1 ? cands[0] : null);
  }

  /** Try to auto-match each still-unbound building to a NetBox **anchor** — a Site or a building
   *  Location (Site = campus, MODEL-4) — by name/slug. Runs once per scan (guarded by
   *  `_autoMapDone`), with the same confidence bar either way (`_confidentMatch`).
   *
   *  **Which kind is tried first follows the facility's declared organization mode** (MODEL-7). In
   *  the default `site-as-building` mode a confident Site wins and building Locations are the
   *  fallback — unchanged. In `site-as-campus` mode the order is reversed: building Locations
   *  (scoped to the chosen campus, when there is one) are tried first and a Site is the fallback,
   *  because in that topology a Site match is the campus itself, not the building — accepting it
   *  first is what silently produced Site-anchored bindings for an all-Location org.
   *
   *  Every match is flagged `auto` for the operator to confirm; ambiguous folders stay unbound for
   *  manual binding. Only **unbound** buildings are touched, so a confirmed (or manifest-restored)
   *  anchor is never silently moved — re-anchoring changes every `floor_key` beneath it and stays an
   *  explicit operator action (§10 foundations). */
  async _autoMapBuildings() {
    if (this.w._autoMapDone) return;
    this.w._autoMapDone = true;
    const campusFirst = this.w._isCampusMode();
    for (const b of this.w._floorBuildings()) {
      if (b.nbSite) continue;
      // The endpoint returns only building-like Locations (those with floor children), each carrying
      // its campus site, so a confident hit binds a Location anchor.
      const tryBuilding = async () => {
        let locs = [];
        try {
          locs = (await this.w.app.netbox.buildingLocations(b.name, this.w._campusSlug())).locations || [];
        } catch (_) { return false; }
        const loc = ImportBind._confidentMatch(locs, b);
        if (!loc) return false;
        this.w._bindBuilding(b, { id: null, slug: loc.site_slug, name: loc.site_name }, loc, true);
        return true;
      };
      const trySite = async () => {
        let sites = [];
        try { sites = (await this.w.app.netbox.sites(b.name)).sites || []; } catch (_) { return false; }
        const site = ImportBind._confidentMatch(sites, b);
        if (!site) return false;
        this.w._bindSite(b, site, true);
        return true;
      };
      const [first, second] = campusFirst ? [tryBuilding, trySite] : [trySite, tryBuilding];
      if (await first()) continue;
      await second();
    }
  }

  /** The `site-as-campus` detour guard shared by both bind-style screens (IMPORT-41): the campus
   *  Site the building search scopes to has to be settled before anything below reads it, so this
   *  runs before every other guard on either screen. Routed from here rather than from each caller
   *  so `_scanAndMap`, `_mergeUploads` and both flows' `_resume()` pass through it;
   *  `_campusPromptDone` keeps it once per session, so "Skip for now" doesn't bounce straight back.
   *  `resume` re-enters the calling step, so this fires identically whether called from this class's
   *  own `step()` or (via `this.w.binder`) from `ImportOrganize.step`. Returns whether it
   *  redirected — the caller returns immediately without rendering anything. */
  _guardCampus(resume) {
    if (!this.w._isCampusMode() || this.w.campus || this.w._campusPromptDone) return false;
    this.w._stepCampus(resume);
    return true;
  }

  /** Run one guarded background load if it hasn't completed yet (IMPORT-41): the shared shape
   *  behind the auto-match, facility-assignment, and (from `ImportOrganize`) building-candidate
   *  fetches — each fires once per scan/entry and re-renders the caller when it resolves. `done`
   *  is the caller's own completion flag; when it's false this appends `message` as a progress line
   *  to whatever `getView()` returns (a thunk so each screen controls what chrome the line lands
   *  in — the edit bind screen's already-built preamble view, or the Buildings step's own bare loading
   *  stage), awaits `load`, then calls `resume` to re-enter the caller with the load's result
   *  available. Returns whether the guard fired — the caller should stop rendering and return. */
  async _guardLoad(done, message, load, getView, resume) {
    if (done) return false;
    getView().append(Dom.el('p', { class: 'imp-progress' }, message));
    await load();
    resume();
    return true;
  }

  /** Append the bind-screen preamble shared by the edit hub's bind screen and the fresh flow's
   *  Buildings step (grouped presentation, IMPORT-41): the mode-aware hint sentence — extended by
   *  `extraHint`, the Buildings step's own "expand a building…" addendum — the IMPORT-25 carried-picks
   *  note ("N buildings are already bound…", so a screen reached from the organize page reads as
   *  "check the rest" rather than the same question asked twice), the org-mode note, under
   *  `site-as-campus` the campus row (MODEL-7), and — when every bound building shares one Site —
   *  the hoisted facility-assignment control (`_sharedFacilitySection`, IMPORT-56). `resume`
   *  re-enters the calling step, both for the org-mode note's own re-render and as the campus row's
   *  return path. */
  bindPreamble(view, buildings, focusBuilding, resume, extraHint) {
    view.append(Dom.el('p', { class: 'hint' }, (this.w._isCampusMode()
      ? 'Bind each building to its NetBox building Location. Then lock which facility its campus '
        + 'site belongs to.'
      : 'Bind each building to its NetBox site. Then lock which facility that site belongs to.')
      + (extraHint || '')));
    const carried = buildings.filter(b => {
      const pick = this._carriedPick(b);
      return pick && pick.confirmed;
    });
    if (carried.length) view.append(Dom.el('p', { class: 'hint' },
      carried.length + (carried.length === 1 ? ' building is' : ' buildings are')
      + ' already bound to the NetBox building you picked while organizing your drawings. Only the '
      + 'rest below need an answer.'));
    view.append(this.w.topology._orgModeNote(resume));
    if (this.w._isCampusMode()) view.append(this.w.topology._campusRow(focusBuilding));
    // The one facility decision every building would otherwise repeat (IMPORT-56). `view.append`
    // is a plain DOM append, so the "nothing to hoist" null is guarded here rather than filtered
    // the way `Dom.el` filters its children.
    const shared = this._sharedFacilitySection(ImportBind.sharedFacilitySite(buildings));
    if (shared) view.append(shared);
    // Last in the preamble, immediately above the rows it answers (IMPORT-57).
    const bulk = this._confirmAllSection(ImportBind.unconfirmed(buildings));
    if (bulk) view.append(bulk);
  }

  /** The buildings whose anchor is still an unconfirmed guess — what the per-card **Confirm** clears
   *  one at a time and `_confirmAllSection` clears in one click (IMPORT-57). Pure and static, like
   *  `sharedFacilitySite`, so the unit tier can pin what the bulk control claims to cover. */
  static unconfirmed(buildings) {
    return buildings.filter(b => b.nbSite && b.nbSite.auto);
  }

  /** The bulk **Confirm all N** row (IMPORT-57) — one answer for every anchor the wizard guessed,
   *  in the same `.imp-bind.imp-hub-row` chrome as the hoisted facility control and the campus row,
   *  so the preamble's "decide this once for all of them" surfaces read as a set.
   *
   *  Drawn only from **two** guesses up, matching `sharedFacilitySite`'s `bound.length < 2` rule and
   *  for the same reason: a lone guess already carries its own Confirm on its own card, so a second
   *  copy in the preamble is a control with nothing to save. Above that the arithmetic is the point
   *  — an 82-building auto-match is 82 buttons, and the operator's answer to all of them is one.
   *  Confirming leaves each row's provenance line alone (see `_bindRow`) and moves no anchor. */
  _confirmAllSection(pending) {
    if (pending.length < 2) return null;
    return Dom.el('section', { class: 'imp-bind imp-hub-row' }, [
      Dom.el('div', { class: 'imp-bind-head' }, [
        Dom.el('div', { class: 'imp-bind-folder' }, 'Matched for you'),
        Dom.el('span', { class: 'imp-bind-sub' },
          'the wizard picked these ' + pending.length + ' anchors — accept them all here, or change '
          + 'any of them below'),
      ]),
      Dom.el('div', { class: 'imp-bind-confirm' }, [
        Dom.el('span', { class: 'imp-bind-auto' },
          pending.length + ' buildings are still waiting on a look.'),
        Dom.el('button', {
          onclick: () => {
            for (const b of pending) this.w._confirmAnchor(b);
            this.w._stepBuildings();   // via the delegator, as every hosted control here does
          },
        }, 'Confirm all ' + pending.length),
      ]),
    ]);
  }

  /** Bind every floor-contributing building to a NetBox site — and confirm which facility that site
   *  belongs to (`_facilityRow`, MULTI-6). The edit hub's screen (IMPORT-34 — the fresh flow routes
   *  its `_stepBuildings` to the merged Buildings step instead): when the hub jumps here to fix
   *  one building, `focusBuilding` scrolls that bind row into view and highlights it, so the user
   *  lands on the row they came to change instead of the top of the list. The action row itself is
   *  the `_buildingsActions(focusBuilding)` hook — **Save & back to hub** / **← Back to hub** so a
   *  one-off re-bind returns where it came from.
   *
   *  What each row *offers* follows the facility's declared organization mode (MODEL-7): see
   *  `_bindRow` and `_autoMapBuildings`. Under `site-as-campus` the campus Site is asked for once
   *  here, before the first auto-match, since it scopes both. */
  async step(focusBuilding) {
    const buildings = this.w._floorBuildings();
    if (!buildings.length) return this.w._stepMap();   // siteplan-only import — nothing to bind

    const resume = () => this.step(focusBuilding);
    if (this._guardCampus(resume)) return;

    const view = this.w._stage('Map buildings to NetBox', 'bind');
    this.bindPreamble(view, buildings, focusBuilding, resume);

    // Both guards re-render on the same `view` built above, so the preamble stays visible while
    // either loads (`_guardLoad` documents the shared shape).
    if (await this._guardLoad(this.w._autoMapDone, 'Matching buildings to NetBox…',
        () => this._autoMapBuildings(), () => view, resume)) return;
    if (await this._guardLoad(this._assignments !== undefined, 'Loading facility assignments…',
        () => this._loadAssignments(), () => view, resume)) return;

    // Computed once and passed down rather than re-derived per row: when it is non-null the
    // preamble above already carries the facility control for every one of these rows (IMPORT-56).
    const hoisted = ImportBind.sharedFacilitySite(buildings);

    let focusRow = null;
    for (const b of buildings) {
      // The hub jumps here to change **one** building, so that row opens with its picker already
      // showing rather than behind the Change button every settled card wears (IMPORT-58).
      const row = this._bindRow(b, hoisted, { openSearch: b === focusBuilding });
      if (b === focusBuilding) { row.classList.add('focus'); focusRow = row; }
      view.append(row);
    }
    if (focusRow) focusRow.scrollIntoView({ block: 'center' });

    // The same actions in two places (IMPORT-66): appended last, where the row is sticky to the
    // bottom of the scrollport (IMPORT-64), and hoisted under the title, so a bind list running to
    // one card per building doesn't have to be scrolled to be left. Two calls to the one hook rather
    // than a shared or cloned node — `Dom.el` binds handlers with `addEventListener`, so a row can
    // be neither — and both in this render, off the same `_allBuildingsBound()` instant, so the
    // pair can't disagree about whether **Auto-match buildings** is on offer. Built after the guards
    // above, so a screen that is still loading doesn't grow a way out of itself.
    this.w._actionsTop(view, this.w._buildingsActions(focusBuilding));
    view.append(this.w._buildingsActions(focusBuilding));
  }

  /** One building's bind control: its current state, the facility-assignment control for the Site
   *  it's bound to (`_facilityRow`), plus an anchor-search autocomplete. The search returns both
   *  **Sites** (Site = building) and building **Locations** (Site = campus, MODEL-4), so the
   *  operator can confirm or override to either anchor kind in the same row.
   *
   *  `hoisted` is the caller's `sharedFacilitySite` verdict (IMPORT-56): non-null means every bound
   *  building on this screen shares one Site, the preamble already carries that single decision, and
   *  this row omits its own copy. Passed in rather than re-derived here — the row is handed one
   *  building and can't see the set — and passed rather than stashed on the instance, so nothing
   *  depends on the preamble having rendered first.
   *
   *  **Which kind leads follows the declared organization mode** (MODEL-7). `site-as-building`
   *  renders exactly as before: Sites, then building Locations, unlabelled. `site-as-campus` puts
   *  the campus's building Locations first under their own heading — the search itself scoped to
   *  the chosen campus — and **demotes** Sites to a labelled "bind as a site instead" group below.
   *  Demoted, not removed: one facility may legitimately mix anchors (BUILDING-ANCHOR-DESIGN §8
   *  open-q 3), and the mode is advisory, so the other anchor kind always stays one click away.
   *
   *  **A bound row's search is collapsed behind a Change button** (IMPORT-58). Both screens draw one
   *  of these cards per building, so an 82-building facility mounted 82 live search inputs at once —
   *  every one of them the answer to a question that was already settled, and the loudest thing on a
   *  card whose state line says "✓ bound". The picker is now built but hidden, and **Change** is the
   *  *change* half the auto-matched state line has always named (IMPORT-57 made *confirm* real; this
   *  makes its sibling a control too). Three cases open it up front, with no button at all — each
   *  one a card whose own state line is already pointing at the search:
   *    • an **unbound** building — the ask *is* to bind it, and hiding the only control that can is
   *      the opposite of what the ⚠ line above it says;
   *    • the **campus-mode Site-anchor advisory** — "Pick a building below if its floors live under
   *      one" has to have a below;
   *    • `opts.openSearch` — the caller's focus target. Both screens jump to one building by folder
   *      (`focusBuilding`), which means the operator came here to change *that* row.
   *  An option on the one shared row builder rather than a fork (§10 *One anchor picker*): the edit
   *  hub renders the same wall from the same buildings, so it takes the same quieting. */
  _bindRow(b, hoisted, opts) {
    const campusMode = this.w._isCampusMode();
    const search = Dom.el('input', { placeholder: campusMode
      ? 'Search NetBox buildings…' : 'Search NetBox sites or buildings…' });
    const list = Dom.el('div', { class: 'imp-bind-list' });
    // Built either way, shown only when this row is the one being answered (IMPORT-58) — see the
    // header comment for which two cases those are. Building it hidden rather than deferring its
    // construction keeps one code path: `run` and its handlers below are wired identically whether
    // the picker is on screen yet or not.
    const openSearch = !b.nbSite || (campusMode && !b.nbBuilding) || !!(opts && opts.openSearch);
    const picker = Dom.el('div', { class: 'imp-bind-picker' + (openSearch ? '' : ' hidden') },
      [search, list]);
    // One-way: once the operator asks for the picker it stays up for the life of this render, which
    // any bind (or Confirm) rebuilds anyway. A second click to put it away would be a control for a
    // state nobody is in — they opened it to change something.
    const change = openSearch ? null : Dom.el('button', {
      class: 'imp-link imp-bind-change',
      title: 'Search for a different NetBox anchor for this folder.',
      onclick: () => {
        change.classList.add('hidden');
        picker.classList.remove('hidden');
        search.focus();
      },
    }, 'Change');

    const state = Dom.el('div', { class: 'imp-bind-state' });
    // A binding carried from the organize step says so (IMPORT-25) — "you already answered this"
    // and "the wizard guessed this" are different claims, and the row that made the claim is the
    // one the operator would go back to.
    const carried = this._carriedPick(b);
    if (b.nbSite && b.nbSite.auto)
      // "Confirm or change" now names two controls that both exist (IMPORT-57): *change* is the
      // search below — since IMPORT-58 reached through the Change button beside this one, when the
      // picker is collapsed — and *confirm* is this button. The provenance half of the sentence is
      // untouched — confirming settles whether the guess was reviewed, not where it came from.
      state.append(Dom.el('div', { class: 'imp-bind-confirm' }, [
        // Titled so the claim explains itself without leaving the row (IMPORT-59) — the same
        // standard the pile's confidence chips carry (see `ImportOrganize`'s `suggestion` cell).
        Dom.el('span', { class: 'imp-bind-auto', title: carried
            ? 'Its drawing filenames were scored against your facility’s NetBox buildings while '
              + 'organizing, and this one won with enough confidence to carry forward — still '
              + 'yours to confirm or change.'
            : 'This building’s name matched a NetBox site or building by name or slug — '
              + 'confident enough to fill in, but still yours to confirm or change.' },
          (carried ? '✓ matched from the drawing filenames → ' : '✓ auto-matched → ')
          + this.w._anchorSummary(b) + '. Confirm or change.'),
        Dom.el('button', {
          title: 'Keep this anchor — it stops being flagged as a guess.',
          // Through the flow, then through the delegator: the anchor model is the flow's to write
          // (`_confirmAnchor`), and the repaint has to route to whichever screen hosts this row
          // (IMPORT-34) — the same shape as the search results below.
          onclick: () => { this.w._confirmAnchor(b); this.w._stepBuildings(); },
        }, 'Confirm'),
        change,
      ]));
    else if (b.nbSite)
      // The settled state wears the same `.imp-bind-confirm` line as the unconfirmed one above, so
      // its Change button sits exactly where the other card's does rather than inventing a second
      // place to put the row's one remaining control (IMPORT-58).
      state.append(Dom.el('div', { class: 'imp-bind-confirm' }, [
        Dom.el('span', { class: 'imp-bind-ok' }, '✓ ' + this.w._anchorSummary(b)
          + (carried ? ' — the building you picked while organizing.' : '')),
        change,
      ]));
    else
      // No Change button here: `openSearch` is true for an unbound building, so the picker this
      // line points at is already on screen. Names the consequence, not just the fact (IMPORT-59)
      // — an unbound folder's floors are the ones `_allBuildingsBound()` gates Continue on.
      state.append(Dom.el('span', { class: 'imp-bind-warn' }, campusMode
        ? '⚠ not bound: pick the NetBox building for this folder — its floors can’t be imported '
          + 'until it is'
        : '⚠ not bound: pick a NetBox site or building — its floors can’t be imported until it is'));
    // Advisory only (the mode never enforces): a Site anchor under a Site = campus facility means
    // this folder's floors are the *campus's* own Locations, which is rarely what was intended —
    // said in as many words here (IMPORT-59), not just flagged.
    if (campusMode && b.nbSite && !b.nbBuilding)
      state.append(Dom.el('span', { class: 'imp-bind-auto' },
        'This folder is bound to a site, but the facility is set up as “Site = campus” — left '
        + 'this way, its floors land under the campus itself rather than a specific building. '
        + 'Pick a building below if its floors live under one.'));

    // Campus mode scopes the building search to the chosen campus. `wide` is the per-row escape
    // hatch (the "search every building" link below) for a facility whose buildings span more than
    // one campus Site — it widens this row's search only, and never changes the campus itself.
    let wide = false;
    let token = 0;
    const run = async (q) => {
      const mine = ++token;
      // Fetch Sites and building Locations together; either may error independently (fall back to
      // whatever came back), and a stale keystroke's results are dropped.
      const [sr, lr] = await Promise.all([
        this.w.app.netbox.sites(q).catch(() => ({ sites: [] })),
        this.w.app.netbox.buildingLocations(q, wide ? '' : this.w._campusSlug())
          .catch(() => ({ locations: [] })),
      ]);
      if (mine !== token) return;   // a newer keystroke superseded this fetch
      list.innerHTML = '';
      const sites = sr.sites || [], locs = lr.locations || [];
      if (!sites.length && !locs.length) {
        // Both searches are facility-scoped (FACIL-1), so an empty result is as often the wrong
        // facility as a genuinely missing object — name the one being searched (IMPORT-17).
        list.append(Dom.el('div', { class: 'hint' },
          'No sites or buildings found in the ' + this.w.app.facilityName() + ' facility.'));
        return;
      }
      // Each result is labelled so the two anchor kinds are distinguishable. A row is marked bound
      // when it matches the current anchor — for a Location that means both its site slug and its
      // own slug.
      const siteItems = () => sites.map(s => {
        const isThis = !b.nbBuilding && b.nbSite && b.nbSite.slug === s.slug;
        const item = Dom.el('div', { class: 'room-item' + (isThis ? ' bound' : '') }, [
          Dom.el('div', { class: 'nm' }, s.name + (isThis ? '  ✓' : '')),
          Dom.el('div', { class: 'sl' }, 'Site · ' + s.slug),
        ]);
        // Re-render through the flow's delegator, not `this.step()`: since IMPORT-34 this row is
        // hosted by the edit bind screen AND the fresh Buildings step's group headers, and the
        // delegator is what routes to whichever of the two is on screen.
        item.onclick = () => { this.w._bindSite(b, s, false); this.w._stepBuildings(); };
        return item;
      });
      const locItems = () => locs.map(l => {
        const isThis = b.nbBuilding && b.nbBuilding.slug === l.slug && b.nbSite.slug === l.site_slug;
        const item = Dom.el('div', { class: 'room-item' + (isThis ? ' bound' : '') }, [
          Dom.el('div', { class: 'nm' }, l.name + (isThis ? '  ✓' : '')),
          Dom.el('div', { class: 'sl' }, 'Building in ' + l.site_name + ' · ' + l.slug),
        ]);
        item.onclick = () => {
          this.w._bindBuilding(b, { id: null, slug: l.site_slug, name: l.site_name }, l, false);
          this.w._stepBuildings();   // via the delegator — see the Site branch above
        };
        return item;
      });

      if (!campusMode) {
        // Site = building: Sites first, then building Locations — unchanged, unheadered.
        list.append(...siteItems(), ...locItems());
        return;
      }
      const scope = (!wide && this.w.campus) ? 'in ' + this.w.campus.name : 'in this facility';
      if (locs.length) {
        list.append(Dom.el('div', { class: 'hint' }, 'Buildings ' + scope));
        list.append(...locItems());
      }
      if (!wide && this.w.campus)
        list.append(Dom.el('button', { class: 'imp-link',
          onclick: () => { wide = true; run(search.value); } },
        'Search every building in this facility'));
      if (sites.length) {
        list.append(Dom.el('div', { class: 'hint' },
          'Or bind this folder to a site itself (Site = building)'));
        list.append(...siteItems());
      }
    };
    search.addEventListener('input', () => run(search.value));

    return Dom.el('section', { class: 'imp-bind' }, [
      Dom.el('div', { class: 'imp-bind-head' }, [
        // Name first, upload folder beside it (IMPORT-25): after an organize-step split the folder
        // is the NetBox slug the operator's own pick supplied, so the *name* is the half they
        // recognize — while the folder is what the whole pipeline keys a building off, so it stays
        // on the line rather than being replaced. Dropped when the two would read the same.
        Dom.el('div', { class: 'imp-bind-folder' }, b.name || b.folder),
        b.name && b.name !== b.folder
          ? Dom.el('span', { class: 'imp-bind-sub', title: 'The upload folder for this '
              + 'building’s drawings — since organizing, this is also its NetBox slug.' },
            b.folder) : null,
        state,
      ]),
      hoisted ? null : this._facilityRow(b.nbSite && b.nbSite.slug), picker,
    ]);
  }

  // ---- facility assignment (FACILITY-IDENTITY Phase 2, MULTI-6) ----

  /** Load the Site→facility assignment map into `_assignments`. A failure degrades to `null` — the
   *  bind rows then omit the facility control entirely rather than presenting a guessed state, since
   *  "unassigned" and "unreadable" would otherwise look identical and invite a wrong confirm. */
  async _loadAssignments() {
    try {
      this._assignments = (await this.w.app.netbox.facilityAssignments()).assignments || {};
    } catch (e) {
      console.error('Could not load facility assignments', e);
      this._assignments = null;
      Toast.show('Could not load facility assignments — skipping that step.', true);
    }
  }

  /** A facility's display name: the picker's own name for it, "Default facility" for `''`, else the
   *  slug (a facility that exists only as an assigned value has no grouping object to name it, the
   *  same fallback `facilities.list_facilities` makes server-side). */
  _facilityName(slug) {
    const known = (this.w.app.facilities || []).find(f => f.slug === slug);
    if (known) return known.name;
    return slug || 'Default facility';
  }

  /** Which of `_facilityRow`'s four outcomes one building's Site resolves to, as a bare verdict:
   *  `'none'` (no control at all — unbound, the map unreadable, or the Location grouping with
   *  nothing already assigned), `'other'` (the ⚠ "assigned to another facility" notice),
   *  `'locked'` (✓ already confirmed) or `'suggest'` (the pending "Lock to …" confirm).
   *
   *  Split out of the render so the Buildings step's auto-advance predicate
   *  (`ImportOrganize.groupedNeedsAttention`, IMPORT-46) reads exactly what the row *would* draw
   *  rather than a second copy of the branching — the grouped presentation is the only place this
   *  control renders in the fresh flow, so a verdict that drifts from the row would silently strand
   *  an unconfirmed assignment. Pure and static, like `_confidentMatch`, so the unit tier pins it. */
  static facilityRowState(siteSlug, assignments, active, grouping) {
    if (!siteSlug || !assignments) return 'none';
    const assigned = assignments[siteSlug];
    if (assigned !== undefined && assigned !== active) return 'other';
    if (assigned === active) return 'locked';
    // Under the Location grouping (MODEL-8) no suggestion is offered — see `_facilityRow`.
    if (grouping === 'location') return 'none';
    return 'suggest';
  }

  /** The one NetBox Site every bound building anchors to — `{slug, name, count}` — or null when
   *  they span more than one Site or fewer than two are bound (IMPORT-56).
   *
   *  The facility control is keyed on the **Site**, so under `site-as-campus` — where every
   *  building's anchor resolves to the same campus — one decision was being drawn once per
   *  building: an 82-building import rendered 82 identical "Lock it so reorganizing your NetBox
   *  groups can't move this site's map" blocks, any one of which answered all 82. When this returns
   *  a Site the control is hoisted into `bindPreamble` and every row drops its copy; when it
   *  returns null the rows keep it, because the buildings genuinely disagree (a facility mixing
   *  anchor kinds, or `site-as-building` folders on separate Sites) and each row is then its own
   *  question. **Fewer than two bound buildings is also null**: there is no duplication to remove,
   *  and a lone control belongs beside the anchor that produced it.
   *
   *  Unbound buildings are skipped rather than disqualifying — they show no facility control at all
   *  (`facilityRowState` → `'none'`), so they have no copy to hoist and nothing to disagree with.
   *  Pure and static, like `_confidentMatch`/`facilityRowState`, so the unit tier pins it. */
  static sharedFacilitySite(buildings) {
    const bound = buildings.filter(b => b.nbSite && b.nbSite.slug);
    if (bound.length < 2) return null;
    const first = bound[0].nbSite;
    if (!bound.every(b => b.nbSite.slug === first.slug)) return null;
    // `name || slug`, as `ImportFlow.anchorFromRow` resolves an anchor's display name — a record
    // restored from a draft or a manifest may carry only the slug, and the hoisted row names the
    // Site out loud.
    return { slug: first.slug, name: first.name || first.slug, count: bound.length };
  }

  /** One bound building's **facility assignment** control — the auto-suggest→confirm surface that
   *  freezes which facility its NetBox Site belongs to (FACILITY-IDENTITY §4.1/§6, MULTI-6).
   *
   *  The suggestion needs no lookup: the bind search is already scoped to the active facility
   *  (FACIL-1 — `NbSitesView` → `facility_sites`), so a Site offered here either is *already*
   *  assigned to it or is unassigned and *derives* to it. Confirming writes that same slug
   *  explicitly, after which an org reorg can no longer re-key the Site's facility (the HEALTH-1
   *  trap) — the derivation stays only as the seed. Reverting drops the entry, restoring the
   *  derive-on-miss default, so an install that never confirms is byte-identically unchanged.
   *
   *  Takes the **Site slug** rather than a building (IMPORT-56) — for a Location anchor that's the
   *  campus, which is the level the facility axis lives at, and it is the whole of what this control
   *  reads. Taking the slug is what lets one caller be a building's card and another the hoisted
   *  preamble row. Returns null when there is no Site (an unbound building) or the map couldn't be
   *  read. A Site assigned to some *other* facility is reported but not editable here: moving one
   *  site's *assignment* is a data reassignment of its own, still the Settings page's job —
   *  `FacilityChangeModal` covers the grouping-change case, not this one. */
  _facilityRow(slug) {
    const active = this.w.app.facility;
    // What this row resolves to lives in `facilityRowState` (IMPORT-46), so the Buildings step's
    // auto-advance predicate can ask the same question without re-deriving the branching here.
    const state = ImportBind.facilityRowState(slug, this._assignments, active, this.w.app.grouping);
    // `'none'` is both "nothing to assign" (unbound, or the map couldn't be read) and the Location
    // grouping's deliberate silence (MODEL-8): there the facility follows the Location tree *below*
    // the Site and several facilities share the campus Site, so locking the whole Site to the active
    // facility would capture its siblings' data too. An assignment that already exists still renders
    // through the two branches below, so it stays visible and revertible.
    if (state === 'none') return null;
    const name = this._facilityName(active);

    if (state === 'other')
      return Dom.el('div', { class: 'imp-bind-facility' }, [
        Dom.el('span', { class: 'imp-bind-warn' },
          '⚠ This site is assigned to facility “' + this._facilityName(this._assignments[slug])
          + '”. Its map data stays there; reassign it from the Settings page.'),
      ]);

    if (state === 'locked')
      return Dom.el('div', { class: 'imp-bind-facility' }, [
        Dom.el('span', { class: 'imp-bind-ok' }, '✓ Facility: ' + name + ' (locked to this site)'),
        Dom.el('button', { onclick: () => this._setAssignment(slug, null) }, 'Use automatic'),
      ]);

    const from = this.w.app.grouping === 'region' ? 'Region' : 'Site Group';
    return Dom.el('div', { class: 'imp-bind-facility' }, [
      Dom.el('span', { class: 'imp-bind-auto' },
        'Facility: ' + name + ' — suggested from this site’s ' + from + '. Lock it so reorganizing '
        + 'your NetBox groups can’t move this site’s map.'),
      Dom.el('button', { onclick: () => this._setAssignment(slug, active) }, 'Lock to ' + name),
    ]);
  }

  /** The facility control hoisted out of the cards (IMPORT-56) — `_facilityRow` for the one Site
   *  `sharedFacilitySite` found, wrapped in the same `.imp-bind.imp-hub-row` chrome
   *  `ImportTopology._campusRow` uses so the two preamble rows read as a pair. The head names the
   *  Site and how many buildings ride on it: under `site-as-building` no campus row precedes this,
   *  so naming it here is what keeps "this site's map" unambiguous.
   *
   *  Returns null when there is nothing to hoist — no shared Site, or a Site whose row would draw
   *  nothing anyway (unreadable map, or the Location grouping's deliberate silence, MODEL-8). The
   *  `'other'` state hoists as it renders, a notice with no button: one warning instead of N, never
   *  a bulk reassignment. */
  _sharedFacilitySection(site) {
    const row = site && this._facilityRow(site.slug);
    if (!row) return null;
    return Dom.el('section', { class: 'imp-bind imp-hub-row' }, [
      Dom.el('div', { class: 'imp-bind-head' }, [
        Dom.el('div', { class: 'imp-bind-folder' }, 'Facility'),
        Dom.el('span', { class: 'imp-bind-sub' },
          'all ' + site.count + ' bound buildings are under ' + site.name
          + ' — one answer covers them all'),
      ]),
      row,
    ]);
  }

  /** Write one Site's facility assignment (`null` reverts it to the derivation) and re-render the
   *  hosting step (via the delegator — this control renders on both flows' screens, IMPORT-34, on a
   *  card or hoisted into the preamble, IMPORT-56) from the map the server echoes back. Install-wide
   *  state written immediately, like the grouping choice — not deferred to the draft or the build. */
  async _setAssignment(slug, facility) {
    try {
      const res = await this.w.app.netbox.assignFacility(slug, facility);
      this._assignments = res.assignments || {};
    } catch (e) {
      return Toast.show('Could not save the facility assignment: ' + e.message, true);
    }
    this.w._stepBuildings();
  }
}
