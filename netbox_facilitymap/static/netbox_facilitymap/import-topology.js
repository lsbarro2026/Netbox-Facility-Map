'use strict';
/* import-topology.js — ImportTopology: the import wizard's "How is your facility organized?"
   concern (TOPO-3) — the layout step that writes both topology settings (the install-wide
   facility grouping, MULTI-3/MODEL-8, and the per-facility organization mode, MODEL-6) through
   one answer, plus the campus-Site step that follows from a `site-as-campus` answer (MODEL-7)
   and the org-mode banners/notes the other steps show (TOPO-4).

   Holds a wizard back-ref (`this.w`), the ImportUploader shape, and no state of its own — the
   topology answer lives in NetBox (written through `App.setGrouping`/`setOrgMode`) and the campus
   pick on the flow (`this.w.campus`, draft-persisted). The flow reaches it through the
   `_stepTopology`/`_stepCampus` delegators (both subclasses route steps through those), and the
   bind step renders its `_orgModeNote`/`_campusRow` banners directly. The subclass divergence
   stays on the flow: `_topologyDefaultRoute()` (which route opens) is read via `this.w`, so
   FreshImportFlow/EditImportFlow keep overriding it there. */

class ImportTopology {
  // The topology step's three routes to the same `{grouping, org_mode, campus_site}` answer
  // (TOPO-3) — `[key, tab label]`, in tab order. Which one opens is `_topologyDefaultRoute()`.
  static TOPOLOGY_ROUTES = [
    ['detect', 'Read my NetBox'],
    ['guided', 'Point at my objects'],
    ['manual', 'Set it up myself'],
  ];
  // The exemplar roles the guided route collects, **outermost first** — the order is load-bearing:
  // it is what "narrower than" means for the scope/clear-below chaining, and it matches the roles
  // `topology._resolve_sample` accepts.
  static TOPOLOGY_ROLES = ['site', 'building', 'floor', 'room'];
  // One guided question per role: `[role, question, the "how to answer it" hint]`.
  static TOPOLOGY_QUESTIONS = [
    ['site', 'Pick one of your NetBox sites',
      'The campus or site this facility lives on. Narrows the searches below.'],
    ['building', 'Pick one of your buildings',
      'Leave blank if a NetBox site is itself one of your buildings.'],
    ['floor', 'Pick one of your floors', 'A floor of the building above.'],
    ['room', 'Pick one of your rooms', 'A room on that floor — the level rooms bind to.'],
  ];

  /** One `topologyObjects` hit as a single picker line — `Combo` renders one line per option, so
   *  where the object sits in the tree rides in the label rather than a second row. */
  static _objectLabel(o) {
    return [o.name, o.parent_name, o.site_name].filter(Boolean).join(' · ');
  }

  constructor(wizard) {
    this.w = wizard;
  }

  /** Ask how this facility is organized — and write **both** settings that answer it (TOPO-3).
   *
   *  The two axes are orthogonal and were previously split across two surfaces: the install-wide
   *  `facility_grouping` (what a *facility* is, MULTI-3 — `dcim.SiteGroup`, `dcim.Region`, or each
   *  top-level `dcim.Location`, MODEL-8) was asked here, while the per-facility organization mode
   *  (what a *building* is — `site-as-building` vs `site-as-campus`, MODEL-6) was only reachable
   *  from the Settings page, i.e. by leaving the wizard mid-import. Since the mode decides which
   *  objects the bind step and the split step search (`netbox.sites` vs `netbox.buildingLocations`),
   *  a wrong mode surfaces two steps later as "the picker didn't populate".
   *
   *  So the step now asks the *question* rather than the settings, three ways — all landing on the
   *  same `{grouping, org_mode, campus_site}` answer and the same `_applyTopology` write:
   *    • **detect**  — the TOPO-2 probe's ranked reading of the live tree, in real numbers;
   *    • **guided**  — point at a site/building/floor/room and let the probe derive it;
   *    • **manual**  — the raw settings, for an operator who knows the model.
   *
   *  `next` is where a committed answer routes (the upload step, or back to the hub). */
  open(next) {
    const view = this.w._stage('How is your facility organized?', 'grouping');
    view.append(Dom.el('p', { class: 'hint' },
      'A “facility” is one campus or site you map on its own. This answer decides what counts as a '
      + 'facility and what counts as a building, which is what the next steps search NetBox for. '
      + 'You don’t have to know the settings — let it read your NetBox, or point at objects you '
      + 'recognize.'));

    let route = this.w._topologyDefaultRoute();
    const body = Dom.el('div', { class: 'imp-topo-body' });
    const tabs = [];
    const paint = () => {
      tabs.forEach(({ btn, key }) => btn.classList.toggle('active', key === route));
      // Each route renders into its **own** pane rather than into `body` directly: the detect and
      // guided routes finish rendering after an await, and switching route in the meantime must not
      // let that late render land in the new route's screen. Clearing `body` orphans the old pane,
      // so a stale render writes into a detached node and is simply never seen.
      body.textContent = '';
      const pane = Dom.el('div', { class: 'imp-topo-pane' });
      body.append(pane);
      if (route === 'detect') this._topologyDetect(pane, next);
      else if (route === 'guided') this._topologyGuided(pane, next);
      else this._topologyManual(pane, next);
    };
    for (const [key, label] of ImportTopology.TOPOLOGY_ROUTES) {
      const btn = Dom.el('button', { class: 'imp-topo-route',
        onclick: () => { route = key; paint(); } }, label);
      tabs.push({ btn, key });
    }
    view.append(Dom.el('div', { class: 'imp-topo-routes' }, tabs.map(t => t.btn)));
    view.append(body);
    paint();

    // Leaving without answering must stay possible: every route commits through its own button, so
    // without this an operator who opened the step to look (typically from the edit hub) would have
    // no way onward that doesn't write a setting. It writes nothing — what is already in force
    // stays in force — so it is named after that, not "cancel".
    view.append(Dom.el('div', { class: 'imp-actions' }, [
      Dom.el('button', { onclick: () => next() },
        'Keep current setup: ' + this.w._currentTopologyLabel()),
    ]));
  }

  /** Route A — read the live `dcim` tree and propose the settings that express it. The probe is
   *  read-only and proposes only (`topology.py`), so nothing is written until the operator accepts a
   *  reading. A failed probe degrades to a note pointing at the other two routes: this step must
   *  never be un-completable because a read failed. */
  async _topologyDetect(body, next) {
    const status = Dom.el('p', { class: 'imp-progress' }, 'Reading your NetBox…');
    body.append(status);
    let probe;
    try {
      probe = await this.w.app.netbox.topology();
    } catch (e) {
      console.error('topology probe failed', e);
      status.className = 'imp-bind-warn';
      status.textContent = 'Could not read your NetBox layout (' + e.message + '). '
        + 'Use “Point at my objects” or “Set it up myself” instead.';
      return;
    }
    status.remove();
    const candidates = probe.candidates || [];
    if (!candidates.length) {
      body.append(Dom.el('p', { class: 'imp-bind-warn' },
        'Your NetBox doesn’t match any layout this plugin can map yet. Use “Set it up myself”.'));
      return;
    }
    body.append(Dom.el('p', { class: 'hint' }, 'This is how your NetBox reads:'));
    body.append(this._topologyProposal(candidates[0], next, true));
    for (const warning of probe.warnings || []) body.append(this._topologyWarning(warning));
    if (candidates.length > 1) {
      const more = Dom.el('details', { class: 'imp-topo-more' }, [
        Dom.el('summary', {}, 'Other ways to read your NetBox ('
          + (candidates.length - 1) + ')'),
      ]);
      for (const cand of candidates.slice(1)) more.append(this._topologyProposal(cand, next, false));
      body.append(more);
    }
  }

  /** Route B — the guided questions: point at objects you recognize and let the probe derive the
   *  triple (`topology._resolve_sample`). Each picker is scoped by the one above it (site → its
   *  Locations → that building's children → that floor's children), so a consistent sample is the
   *  easy path; a contradictory one is **explained**, never silently repaired, since only the
   *  operator knows which pick was wrong. Every role is optional — the probe derives what a partial
   *  sample unambiguously can, and a lone room is often enough (its parent is the floor, and whether
   *  *that* has a parent is exactly what tells the two organization modes apart). */
  _topologyGuided(body, next) {
    body.append(Dom.el('p', { class: 'hint' },
      'Point at objects you recognize in NetBox and the layout is worked out from them. Skip any '
      + 'you’re unsure of — one room is often enough. If a NetBox site is itself one of your '
      + 'buildings, leave “building” blank.'));

    const picks = { site: null, building: null, floor: null, room: null };
    const combos = {};
    const result = Dom.el('div', { class: 'imp-topo-result' });
    let token = 0;

    const resolve = async () => {
      const mine = ++token;
      const sample = {};
      for (const role of ImportTopology.TOPOLOGY_ROLES)
        if (picks[role]) sample[role] = picks[role].id;
      result.textContent = '';
      if (!sample.building && !sample.floor && !sample.room) {
        result.append(Dom.el('p', { class: 'hint' },
          'Pick a building, a floor or a room to see the layout they imply.'));
        return;
      }
      result.append(Dom.el('p', { class: 'imp-progress' }, 'Working out your layout…'));
      let probe;
      try {
        probe = await this.w.app.netbox.topology(sample);
      } catch (e) {
        if (mine !== token) return;   // a newer pick superseded this fetch
        result.textContent = '';
        result.append(Dom.el('p', { class: 'imp-bind-warn' },
          'Could not read those objects: ' + e.message));
        return;
      }
      if (mine !== token) return;
      result.textContent = '';
      const problems = (probe.sample && probe.sample.problems) || [];
      for (const problem of problems)
        result.append(Dom.el('p', { class: 'imp-bind-warn' }, '⚠ ' + problem.detail));
      const cand = (probe.candidates || [])[0];
      if (!cand) {
        if (!problems.length) result.append(Dom.el('p', { class: 'imp-bind-warn' },
          'Those picks don’t describe a layout this plugin can map.'));
        return;
      }
      result.append(this._topologyProposal(cand, next, true));
      for (const warning of probe.warnings || []) result.append(this._topologyWarning(warning));
    };

    // A pick invalidates every *narrower* pick below it (they were searched under the old parent),
    // so those are dropped rather than left to contradict the new one. `Combo.reset()` clears the
    // control without re-firing `onPick`, which would recurse through this same handler.
    const clearBelow = (role) => {
      const below = ImportTopology.TOPOLOGY_ROLES.slice(ImportTopology.TOPOLOGY_ROLES.indexOf(role) + 1);
      for (const other of below) { picks[other] = null; combos[other].reset(); }
    };

    // Scope for one role's search: the nearest pick above it. The site picker is unscoped (it is
    // the top of the tree); a Location picker narrows to the picked parent, else to the picked
    // site, else searches the whole install — so skipping a question widens rather than blocks.
    const scopeFor = (role) => {
      const above = ImportTopology.TOPOLOGY_ROLES.slice(0, ImportTopology.TOPOLOGY_ROLES.indexOf(role));
      const parent = above.slice(1).reverse().find(r => picks[r]);
      if (parent) return { parent: picks[parent].id };
      return picks.site ? { site: picks.site.id } : {};
    };

    const rows = Dom.el('div', { class: 'imp-topo-picks' });
    for (const [role, label, hint] of ImportTopology.TOPOLOGY_QUESTIONS) {
      const combo = new Combo({
        placeholder: 'Search NetBox…',
        load: async (q) => {
          const kind = role === 'site' ? 'site' : 'location';
          const res = await this.w.app.netbox.topologyObjects(kind,
            Object.assign({ q }, role === 'site' ? {} : scopeFor(role)));
          return (res.objects || []).map(o => ({ id: o.id, name: ImportTopology._objectLabel(o) }));
        },
        onPick: (opt) => { picks[role] = opt; clearBelow(role); resolve(); },
      });
      combos[role] = combo;
      rows.append(Dom.el('div', { class: 'imp-topo-pick' }, [
        Dom.el('div', { class: 'imp-bind-folder' }, label),
        Dom.el('div', { class: 'imp-hub-meta' }, hint),
        combo.el,
      ]));
    }
    // Deliberately NOT inside an `.imp-bind` card: that card's `input` rule restyles every input
    // under it (full-width, no right padding), which would eat the `Combo`'s own sizing and the
    // room its ✕ needs. `.imp-topo-picks` carries the same card chrome without that rule.
    body.append(rows);
    body.append(result);
    resolve();   // renders the "pick something" prompt
  }

  /** Route C — the raw settings, for an operator who already knows their model: the three grouping
   *  options (each with its live facility count, TOPO-1) plus the organization mode the wizard used
   *  to punt to Settings for. Under the `location` grouping the mode is forced server-side
   *  (`facilities.org_mode`, MODEL-8), so its control is disabled and explained rather than hidden —
   *  the same stance the Settings row takes (IMPORT-15). */
  _topologyManual(body, next) {
    body.append(Dom.el('p', { class: 'hint' },
      'Which NetBox grouping names a facility (install-wide, drives the facility picker), and how '
      + 'this facility’s buildings are modelled (steers what the next steps search).'));

    let chosen = this.w.app.grouping;
    let mode = this.w.app.orgMode();
    // The mode that will actually apply: `location` grouping forces campus, whatever is stored.
    const effectiveMode = () => (chosen === 'location' ? 'site-as-campus' : mode);

    // A live "here's what this actually does" count, computed from the same preview the change
    // path already uses (`groupingPreview` → `reachable_facility_choices` under a *prospective*
    // grouping) — it doesn't depend on any map data existing, so it's accurate even on a brand-new
    // install (the case that had no warning at all before this). Token-guarded like `openCampus`'s
    // `run()`, since a fast second selection can outrace the first fetch.
    const count = Dom.el('p', { class: 'hint' });
    let countToken = 0;
    const paintCount = async (value) => {
      const mine = ++countToken;
      count.textContent = '';
      let preview;
      try {
        preview = await this.w.app.netbox.groupingPreview(value);
      } catch (e) {
        if (mine === countToken) console.error('grouping preview failed', e);
        return;   // informational only — never block the step on this
      }
      if (mine !== countToken) return;
      const n = (preview.choices || []).length;
      count.textContent = n === 1 ? 'This identifies 1 facility.' : 'This identifies ' + n + ' facilities.';
    };

    const modeCards = [];
    const modeNote = Dom.el('p', { class: 'hint' });
    // What the *currently selected* mode would do to the buildings already bound (TOPO-4). Repainted
    // with the mode note, since the `location` grouping can force the effective mode without the
    // mode radios being touched at all.
    const modeChange = Dom.el('div', {});
    const paintMode = () => {
      const forced = chosen === 'location';
      for (const { card, radio, value } of modeCards) {
        radio.disabled = forced;
        radio.checked = value === effectiveMode();
        card.classList.toggle('selected', value === effectiveMode());
        card.classList.toggle('disabled', forced);
      }
      modeNote.textContent = forced
        ? 'Fixed by the Building / Location grouping — a Location-subtree facility’s buildings are '
          + 'Locations by design.'
        : this._topologySearchSentence(effectiveMode(), this.w.campus && this.w.campus.name);
      modeChange.textContent = '';
      const note = this._orgModeChangeNote(effectiveMode());
      if (note) modeChange.append(note);
    };

    const cards = [];
    for (const [value, title, desc] of ImportFlow.GROUPING_OPTIONS) {
      const radio = Dom.el('input', { type: 'radio', name: 'imp-grouping', value });
      if (value === chosen) radio.checked = true;
      const card = Dom.el('label',
        { class: 'imp-bind imp-grouping-opt' + (value === chosen ? ' selected' : '') }, [
          Dom.el('div', { class: 'imp-bind-head' }, [
            radio, Dom.el('span', { class: 'imp-bind-folder' }, title),
          ]),
          Dom.el('div', { class: 'imp-hub-meta' }, desc),
        ]);
      radio.addEventListener('change', () => {
        chosen = value;
        cards.forEach(c => c.classList.toggle('selected', c === card));
        paintCount(value);
        paintMode();
      });
      cards.push(card);
      body.append(card);
    }
    body.append(count);
    paintCount(chosen);

    body.append(Dom.el('h3', { class: 'imp-substep' }, 'What is a building here?'));
    for (const [value, title, desc] of ImportFlow.ORG_MODE_OPTIONS) {
      const radio = Dom.el('input', { type: 'radio', name: 'imp-org-mode', value });
      const card = Dom.el('label', { class: 'imp-bind imp-grouping-opt' }, [
        Dom.el('div', { class: 'imp-bind-head' }, [
          radio, Dom.el('span', { class: 'imp-bind-folder' }, title),
        ]),
        Dom.el('div', { class: 'imp-hub-meta' }, desc),
      ]);
      radio.addEventListener('change', () => { mode = value; paintMode(); });
      modeCards.push({ card, radio, value });
      body.append(card);
    }
    body.append(modeNote);
    body.append(modeChange);
    paintMode();

    const cont = Dom.el('button', { class: 'primary', onclick: async () => {
      cont.disabled = true;
      const ok = await this._applyTopology(
        { grouping: chosen, org_mode: effectiveMode(), campus_site: null }, next);
      if (!ok) cont.disabled = false;
    } }, 'Continue');
    body.append(Dom.el('div', { class: 'imp-actions' }, [cont]));
  }

  /** One candidate reading of the tree, as a card an operator can check against their own estate:
   *  the headline in their vocabulary, the counts and example objects the probe measured, what it
   *  means for the rest of the wizard, and the button that commits it. `primary` marks the proposed
   *  reading (the top-ranked one, or the one a sample derived) apart from the alternatives. */
  _topologyProposal(cand, next, primary) {
    const accept = Dom.el('button', { class: primary ? 'primary' : '', onclick: async () => {
      accept.disabled = true;
      if (!await this._applyTopology(cand, next)) accept.disabled = false;
    } }, primary ? 'Use this layout' : 'Use this instead');

    const children = [
      Dom.el('div', { class: 'imp-bind-head' }, [
        Dom.el('div', { class: 'imp-bind-folder' }, this._topologyHeadline(cand)),
      ]),
      Dom.el('div', { class: 'imp-topo-counts' }, ImportTopology._topologyCounts(cand)),
    ];
    const chain = ImportTopology._topologyExample(cand);
    if (chain) children.push(Dom.el('div', { class: 'imp-hub-meta' }, 'For example: ' + chain));
    children.push(this._topologyConsequences(cand));
    // On a facility that already has buildings bound, the card's own consequences read as a promise
    // the map will follow. Say what accepting this reading leaves alone (TOPO-4) — only when the
    // reading would actually move the mode, so a first import's card is unchanged.
    const settled = this._orgModeChangeNote(cand.org_mode);
    if (settled) children.push(settled);
    children.push(Dom.el('div', { class: 'imp-hub-acts' }, [accept]));
    return Dom.el('section', { class: 'imp-bind imp-topo-cand' + (primary ? ' selected' : '') },
      children);
  }

  /** The candidate's reading in the operator's words, not in setting names. */
  _topologyHeadline(cand) {
    if (cand.grouping === 'location')
      return 'Each top-level Location is its own facility';
    const by = ImportFlow.groupingLabel(cand.grouping);
    return cand.org_mode === 'site-as-campus'
      ? 'One campus site per facility, with buildings as Locations beneath it (facilities named by '
        + by + ')'
      : 'Each building is its own NetBox site (facilities named by ' + by + ')';
  }

  /** The four level counts as one line — the numbers that let an operator recognize (or reject) a
   *  reading without knowing what either setting means. */
  static _topologyCounts(cand) {
    const n = (v, one, many) => v + ' ' + (v === 1 ? one : many);
    return [n(cand.facilities, 'facility', 'facilities'), n(cand.buildings, 'building', 'buildings'),
      n(cand.floors, 'floor', 'floors'), n(cand.rooms, 'room', 'rooms')].join(' → ');
  }

  /** A real building → floor → room chain from the probe's example names, or `''` when the tree
   *  doesn't populate all three levels (in which case the counts already say so). */
  static _topologyExample(cand) {
    const ex = cand.examples || {};
    const chain = ['buildings', 'floors', 'rooms'].map(k => (ex[k] || [])[0]);
    return chain.every(Boolean) ? chain.join(' → ') : '';
  }

  /** Which objects the bind step and the "Split into buildings" step will search under `mode` —
   *  the consequence an operator actually feels, since a wrong mode reads as "the picker didn't
   *  populate" two steps later. Shared by the proposal card and the manual route. */
  _topologySearchSentence(mode, campusName) {
    return mode === 'site-as-campus'
      ? 'Binding a drawing folder to a building will search the Locations under '
        + (campusName ? '“' + campusName + '”' : 'your campus site') + ', not your NetBox sites.'
      : 'Binding a drawing folder to a building will search your NetBox sites.';
  }

  /** What accepting this reading means for the rest of the import, in the operator's terms: how
   *  many facilities it creates, which object type the next steps search, and the shape of the floor
   *  keys the build will write (2 segments for a Site anchor, 3 for a Location anchor — MODEL-3). */
  _topologyConsequences(cand) {
    const items = [];
    const named = (cand.examples && cand.examples.facilities) || [];
    items.push(cand.facilities === 1
      ? 'This install is one facility — one map, one picker entry.'
      : 'This install becomes ' + cand.facilities + ' separate facilities — a separate map each.'
        + (named.length ? ' For example: ' + named.join(', ') + '.' : ''));
    items.push(this._topologySearchSentence(cand.org_mode, cand.campus_site_name));
    items.push('Rooms will be keyed as ' + (cand.org_mode === 'site-as-campus'
      ? '“site/building/floor”' : '“site/floor”') + '.');
    return Dom.el('ul', { class: 'imp-topo-conseq' },
      items.map(text => Dom.el('li', {}, text)));
  }

  /** One probe warning — the mismatches that make an import fail *later* (floors with no child
   *  Locations to bind rooms to, a tree deeper than building → floor → room). Advisory: the server
   *  worded them, so they are shown verbatim rather than re-interpreted here. */
  _topologyWarning(warning) {
    const examples = (warning.examples || []).join(', ');
    return Dom.el('p', { class: 'imp-bind-warn' },
      '⚠ ' + warning.detail + (warning.count ? ' (' + warning.count + ')' : '')
      + (examples ? ' For example: ' + examples + '.' : ''));
  }

  /** Commit an answer — **both** axes plus the campus, in the one order that is safe — and route to
   *  `next`. Resolves `true` when the answer was written (or was already in force), `false` when the
   *  operator backed out or a write failed, so the caller can re-enable its button and stay put.
   *
   *  The grouping goes first: it is install-wide, and under `location` it *forces* the organization
   *  mode server-side, so writing the mode first could write a value the grouping then overrides.
   *  Changing the grouping on a populated install re-scopes which facility each *unassigned* Site
   *  resolves to and can strand existing map data (HEALTH-1), so that case hands the whole
   *  transaction to `FacilityChangeModal` (MULTI-7) — which previews exactly what moves, POSTs the
   *  grouping itself, and offers inline reassignment for anything stranded.
   *
   *  The **facility** is reconciled next, between the two writes, and that position is load-bearing
   *  in both directions (IMPORT-17): the grouping decides what a facility *is*, so it has to be
   *  saved before the answer can name one — and the organization mode is stored **per facility**, so
   *  the facility has to be right before `setOrgMode` picks the key it writes under. Nothing else in
   *  the wizard ever sets the facility: `App.init` resolves it from the hash or the pinned default
   *  and it stays put, so a fresh SPA imports into the default facility `''`, which under a Site-FK
   *  grouping means the *ungrouped* remainder — empty on a fully-grouped install. That is how the
   *  probe could report 124 buildings while the bind and split steps, which search only the active
   *  facility (FACIL-1), found none. See `_reconcileFacility`.
   *
   *  The mode is written only when it actually differs, and never under the `location` grouping
   *  (nothing to store — the server answers `site-as-campus` regardless). It stays **advisory**
   *  (MODEL-7): it steers this wizard's defaults and ordering, gates nothing, and re-anchors no
   *  building — `_autoMapBuildings` still touches unbound buildings only, so no `Room.floor_key`
   *  moves as a side effect of an answer here.
   *
   *  A campus-shaped answer also seeds `this.w.campus` from the candidate's own campus Site, so the
   *  campus question is already answered by the time the bind step scopes its search — but **only
   *  when unset**, so an operator's explicit `openCampus` pick is never overwritten by a probe
   *  guess. */
  async _applyTopology(cand, next) {
    const chosen = cand.grouping;
    const changing = chosen !== this.w.app.grouping;
    if (changing && this.w.app.store.hasContent()) {
      if (!await FacilityChangeModal.open(this.w.app, chosen)) return false;
      this.w.app.grouping = chosen;
    } else {
      try {
        await this.w.app.netbox.setGrouping(chosen, changing);
        this.w.app.grouping = chosen;
      } catch (e) {
        // `hasContent()` above is only a fast-path guess — this session's in-memory store, not
        // every facility. The server's `confirm_required` 409 is the authoritative check (any
        // FacilityMapBlob existing anywhere), so a miss here still needs the same modal rather than
        // surfacing its raw interlock message as a toast.
        if (!(changing && e.status === 409)) {
          Toast.show('Could not save grouping: ' + e.message, true);
          return false;
        }
        if (!await FacilityChangeModal.open(this.w.app, chosen)) return false;
        this.w.app.grouping = chosen;
      }
    }

    await this._reconcileFacility(cand);

    if (chosen !== 'location' && cand.org_mode && cand.org_mode !== this.w.app.orgMode()) {
      try {
        await this.w.app.setOrgMode(cand.org_mode);
      } catch (e) {
        Toast.show('Could not save the NetBox organization: ' + e.message, true);
        return false;
      }
    }

    if (this.w._isCampusMode() && !this.w.campus && cand.campus_site) {
      // No `id`: the probe names the campus by slug, and `id` is unread — `_campusSlug`/
      // `_validCampus` key off `slug`, and `openCampus` overwrites the whole record on a re-pick.
      this.w.campus = { id: null, slug: cand.campus_site,
        name: cand.campus_site_name || cand.campus_site };
      if (this.w.buildings.length) await this.w._saveDraft();
    }

    next();
    return true;
  }

  /** Move the import to the facility the accepted answer implies, when that isn't where we already
   *  are (IMPORT-17). Never fails the commit — a facility we couldn't move to is a warning, not a
   *  reason to reject an answer the operator gave correctly.
   *
   *  `campus_facility` is the probe's answer to "which facility does this campus Site belong to,
   *  under the grouping you just chose" — a derivation, not a guess, so acting on it is a visible
   *  consequence of the answer rather than a hijack (it is announced, and the facility picker
   *  overrides it). It is `null` when the question has no single answer: a `site-as-building`
   *  candidate has no campus, and under the `location` grouping one campus hosts many facilities.
   *
   *  The switch only runs while there is nothing to strand — no built map in this facility and
   *  nothing uploaded in this walk — which is exactly the layout step of a fresh import, and which
   *  also makes it inert in `EditImportFlow` (a built facility's identity is already settled). Past
   *  that point the working dir holds this facility's PDFs, so moving would orphan them; warn
   *  instead, and let the operator switch deliberately. A mismatch is also legitimate on a facility
   *  that mixes Site- and Location-anchored buildings (MODEL-7), which is why neither branch
   *  blocks. */
  async _reconcileFacility(cand) {
    const target = cand.campus_facility;
    if (target === null || target === undefined || target === this.w.app.facility) return;
    const here = this.w.app.facilityName();
    const there = this.w.app.facilityName(target);
    if (this.w.app.store.hasContent() || this.w.inv || this.w.buildings.length) {
      Toast.show('“' + (cand.campus_site_name || cand.campus_site) + '” belongs to the ' + there
        + ' facility, but this import is filling ' + here + '. Switch with the facility picker if '
        + 'that is wrong.', true);
      return;
    }
    if (await this.w.app.setFacility(target))
      Toast.show('Now importing into ' + there + ' — the facility your campus site belongs to.');
  }

  /** What flipping the organization mode to `nextMode` would — and would **not** — do to a facility
   *  that already has buildings bound (TOPO-4), or `null` when there is nothing to reassure about
   *  (the mode isn't actually changing, or nothing is bound yet).
   *
   *  The mode is advisory (MODEL-6/7): it steers which objects the *next* bind searches and gates
   *  nothing, so `_autoMapBuildings` skips bound buildings and no `Room.floor_key` moves as a side
   *  effect of an answer here. That guarantee is exactly what an operator revisiting the answer on a
   *  built facility cannot see — the honest read of "Site = campus" is "my map is about to follow" —
   *  so it is stated rather than implied, together with the explicit action that *does* move an
   *  anchor (a re-bind or the anchor drill control, which routes room removal through `sync_rooms`
   *  and warns first). Shared by all three mode-writing surfaces: the manual route's radios, an
   *  accepted proposal card, and `_orgModeNote`'s inline switch. */
  _orgModeChangeNote(nextMode) {
    // A probe candidate may name no mode at all (`_applyTopology` then writes none), which is "no
    // change", not the default mode — so an unknown value must fall out here rather than render the
    // `site-as-building` copy by default.
    const known = ImportFlow.ORG_MODE_OPTIONS.some(([value]) => value === nextMode);
    const bound = this.w._boundBuildings();
    if (!known || nextMode === this.w._orgMode() || !bound.length) return null;
    const names = bound.slice(0, 3).map(b => b.name || b.folder).join(', ')
      + (bound.length > 3 ? ' and ' + (bound.length - 3) + ' more' : '');
    // Deliberately not the search sentence again: two of the three callers print it immediately
    // above, so the useful thing to add is the *scope* of the change — which is also the half TOPO-4
    // is about (future bindings only).
    return Dom.el('ul', { class: 'imp-topo-conseq' }, [
      Dom.el('li', {}, 'Applies to bindings you make from here on — it changes which NetBox objects '
        + 'the building search offers, and nothing else.'),
      Dom.el('li', {}, (bound.length === 1
        ? 'The building already bound keeps its'
        : 'The ' + bound.length + ' buildings already bound keep their')
        + ' current NetBox anchor — ' + names + '. Nothing is re-bound and no room moves.'),
      Dom.el('li', {}, 'To actually move a building onto a different site or Location, re-bind that '
        + 'building itself (its “Edit binding” control, or the anchor control on its floors). That is '
        + 'the only action that re-keys its rooms, and it warns before discarding any.'),
    ]);
  }

  /** Ask for the facility's **campus Site**, once, before the per-building bind step (MODEL-7).
   *
   *  Under `site-as-campus` the campus is a single facility-level fact — every building is a
   *  Location beneath it — so picking it per building folder (as the merged bind autocomplete
   *  effectively did) is both repetitive and the wrong shape. The pick scopes the bind step's
   *  building search (`netbox.buildingLocations(q, campusSlug)`) and its auto-match.
   *
   *  Shared by both flows: the linear walk visits it between upload and bind, and the edit hub's
   *  "Campus site" row re-enters it (the hub is non-linear, so this is never a one-shot page).
   *  `next` is where Continue routes. **Skip** is deliberate and non-destructive — it records
   *  `_campusPromptDone` and leaves `campus` null, which simply falls back to the facility-wide,
   *  unscoped building search. Nothing here is enforcing: the mode is advisory (a facility may
   *  legitimately mix anchors), so no binding is rewritten by choosing or changing a campus. */
  openCampus(next) {
    const view = this.w._stage('Which NetBox site is this campus?', 'campus');
    view.append(Dom.el('p', { class: 'hint' },
      'This facility is set up as “Site = campus”, so your buildings are NetBox Locations beneath '
      + 'one campus site. Pick that site once and the next step binds each drawing folder to a '
      + 'building under it.'));
    view.append(this._orgModeNote(() => this.openCampus(next)));
    // Re-entered from the edit hub, this step is a *change* to a facility whose buildings are
    // already anchored — and the campus is the first segment of every floor key beneath them, so
    // "am I about to re-key my rooms?" is the obvious fear (TOPO-4). The pick only scopes the search
    // the bind step offers; an anchor still moves only through an explicit re-bind.
    const anchored = this.w._boundBuildings();
    if (anchored.length)
      view.append(Dom.el('p', { class: 'hint' }, 'Changing the campus only changes which building '
        + 'Locations the search below offers. ' + (anchored.length === 1
          ? 'The building already bound keeps its'
          : 'The ' + anchored.length + ' buildings already bound keep their')
        + ' current Location, campus and rooms.'));

    const state = Dom.el('div', { class: 'imp-bind-state' });
    const paint = () => {
      state.innerHTML = '';
      state.append(this.w.campus
        ? Dom.el('span', { class: 'imp-bind-ok' },
          '✓ ' + this.w.campus.name + ' (' + this.w.campus.slug + ')')
        : Dom.el('span', { class: 'imp-bind-warn' }, '⚠ no campus site chosen yet'));
    };
    paint();

    const search = Dom.el('input', { placeholder: 'Search NetBox sites…' });
    const list = Dom.el('div', { class: 'imp-bind-list' });
    let token = 0;
    const run = async (q) => {
      const mine = ++token;
      let sites = [];
      try { sites = (await this.w.app.netbox.sites(q)).sites || []; }
      catch (e) { if (mine === token) list.innerHTML = ''; return Toast.show('Site search failed: ' + e.message, true); }
      if (mine !== token) return;   // a newer keystroke superseded this fetch
      list.innerHTML = '';
      if (!sites.length) return list.append(Dom.el('div', { class: 'hint' }, 'No sites found.'));
      for (const s of sites) {
        const isThis = this.w.campus && this.w.campus.slug === s.slug;
        const item = Dom.el('div', { class: 'room-item' + (isThis ? ' bound' : '') }, [
          Dom.el('div', { class: 'nm' }, s.name + (isThis ? '  ✓' : '')),
          Dom.el('div', { class: 'sl' }, 'Site · ' + s.slug),
        ]);
        item.onclick = () => {
          this.w.campus = { id: s.id, slug: s.slug, name: s.name };
          run(search.value);   // re-render the list so the new pick shows as bound
          paint();
        };
        list.append(item);
      }
    };
    search.addEventListener('input', () => run(search.value));
    run('');   // the facility's sites are few — open with the full list rather than a blank box

    view.append(Dom.el('section', { class: 'imp-bind' }, [
      Dom.el('div', { class: 'imp-bind-head' }, [
        Dom.el('div', { class: 'imp-bind-folder' }, 'Campus site'), state,
      ]),
      search, list,
    ]));

    const cont = Dom.el('button', { class: 'primary', onclick: async () => {
      this.w._campusPromptDone = true;
      await this.w._saveDraft();
      next();
    } }, 'Continue');
    cont.disabled = !this.w.campus;
    view.append(Dom.el('div', { class: 'imp-actions' }, [
      this.w._backButton('campus'), cont,
      Dom.el('button', { onclick: () => { this.w._campusPromptDone = true; next(); } },
        'Skip for now'),
    ]));
  }

  /** The one-line "here's how this facility is modelled in NetBox" note the campus and bind steps
   *  both show (MODEL-6). Informational: the mode steers defaults, and changing it never rewrites
   *  an existing binding (`facilities.py`'s advisory-only guarantee) — safe to flip mid-wizard.
   *
   *  Under the `location` grouping (MODEL-8) the mode is *forced* server-side to `site-as-campus`
   *  (a Location-subtree facility is campus-shaped by construction) — `App.orgMode()` mirrors that
   *  force, so `_isCampusMode()` is always right here. There is genuinely nothing to choose in that
   *  case, so the note explains why rather than linking anywhere (IMPORT-15 — the old link went to
   *  a Settings row that grouping now disables). Otherwise the note offers an inline switch: no
   *  more leaving the wizard for Settings. `rerender` is the caller's own re-render closure (the
   *  same self-re-invoke pattern `_stepBuildings`'s auto-map/assignment loads already use below),
   *  called after a successful `App.setOrgMode()` so the step redraws under the new mode.
   *
   *  Where the switch is offered *and* buildings are already bound, clicking it first confirms
   *  (`Modal.confirm`, IMPORT-60) with the TOPO-4 consequence note as the dialog body — this is a
   *  one-click, install-wide write, so what it leaves alone must be answerable *on* the click path,
   *  not behind an optional disclosure the operator has to think to open first. `danger: false`:
   *  MODEL-7 makes the mode advisory, never enforced, so the confirm must not read as irreversible.
   *  The note's own `null` case (nothing bound yet, or the mode isn't actually changing) is the
   *  confirm's gate too — a first import keeps the old single-click behavior. Recomputed inside the
   *  click handler, not memoized from render time, so a bind made earlier in the same render is
   *  reflected. */
  _orgModeNote(rerender) {
    const campusMode = this.w._isCampusMode();
    const label = campusMode ? 'Site = campus (buildings are Locations)' : 'Site = building';
    const children = [Dom.el('span', {}, 'NetBox organization: ' + label + '. ')];
    if (this.w.app.grouping === 'location') {
      children.push(Dom.el('span', {},
        'Fixed by the Building / Location grouping — buildings are Locations by design.'));
    } else {
      const otherMode = campusMode ? 'site-as-building' : 'site-as-campus';
      const otherLabel = campusMode ? 'Site = building' : 'Site = campus (buildings are Locations)';
      const btn = Dom.el('button', { class: 'imp-link', onclick: async () => {
        const note = this._orgModeChangeNote(otherMode);
        if (note && !await Modal.confirm({
          title: 'Switch to ' + otherLabel + '?',
          body: [note],
          confirmLabel: 'Switch organization',
        })) return;
        btn.disabled = true;
        try { await this.w.app.setOrgMode(otherMode); }
        catch (e) {
          btn.disabled = false;
          return Toast.show('Could not change organization: ' + e.message, true);
        }
        Toast.show('NetBox organization saved.');
        rerender();
      } }, 'Switch to ' + otherLabel);
      children.push(btn);
    }
    return Dom.el('div', { class: 'imp-org-mode' }, [Dom.el('p', { class: 'hint' }, children)]);
  }

  /** The bind step's campus banner (`site-as-campus` only): which campus Site the building search is
   *  scoped to, and the way back into `openCampus` to change it. An unchosen campus (the operator
   *  skipped the step) reads as a prompt — the search then covers the whole facility, which still
   *  works, just with more to sift through. `returnTo` is the bind row to re-focus on the way back.
   *  Its `.imp-bind.imp-hub-row` chrome is shared with the hoisted facility control that follows it
   *  in the preamble (`ImportBind._sharedFacilitySection`, IMPORT-56) — the two name the same Site
   *  from different angles, so they read as a pair. */
  _campusRow(returnTo) {
    const state = this.w.campus
      ? Dom.el('span', { class: 'imp-bind-ok' },
        '✓ ' + this.w.campus.name + ' (' + this.w.campus.slug + ')')
      : Dom.el('span', { class: 'imp-bind-auto' },
        'No campus chosen — searching every building in this facility.');
    return Dom.el('section', { class: 'imp-bind imp-hub-row' }, [
      Dom.el('div', { class: 'imp-bind-head' }, [
        Dom.el('div', { class: 'imp-bind-folder' }, 'Campus site'), state,
      ]),
      Dom.el('div', { class: 'imp-hub-acts' }, [
        Dom.el('button', { onclick: () => this.openCampus(() => this.w._stepBuildings(returnTo)) },
          this.w.campus ? 'Change campus' : 'Choose campus'),
      ]),
    ]);
  }
}
