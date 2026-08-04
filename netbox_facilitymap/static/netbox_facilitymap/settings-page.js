'use strict';
/* settings-page.js — SettingsPage: the in-app Settings route (#/settings).

   A small declarative framework: instead of hand-wiring buttons, every setting is
   one descriptor in `_descriptors()`, and a single renderer walks them to build the
   page — grouped into tabs, then categories, each row a label + hover tooltip + a control.

   ── How to add a setting ──────────────────────────────────────────────────────
   Add ONE object to the list returned by `_descriptors()`. Fields:

     tab       (string|omit) Tab it lives under, defaulting to DEFAULT_TAB ('General') when
                          omitted — so a descriptor that forgets it lands somewhere sensible
                          instead of spawning a stray one-row tab. Today: 'General' and
                          'Add-ons'. Tabs render in first-seen order, like categories.
     category  (string)   Section heading it groups under, WITHIN its tab. Reuse an existing one
                          ('Display', 'Import & data', 'Backup & restore', 'Write add-ons') or
                          name a new one — categories render in first-seen order.
     label     (string)   The row's left-hand label.
     tooltip   (string)   One short line shown on hover/focus of the row's ⓘ glyph.
                          Keep it terse (ARCHITECTURE §11) — a hint, not narration.
     type      (string)   'toggle' | 'select' | 'text' | 'search-select' | 'action'
                          (extend `_control` for new types).
     show      (fn|omit)  Optional predicate; the row is omitted when it returns false
                          (used to gate the backup + select rows on canImport / canReset).
     enabled   (fn|omit)  Optional predicate; the row still RENDERS when it returns false, but reads
                          as disabled and its control(s) can't be operated. `show` vs `enabled` is
                          the "can't have it" vs "can't have it YET" distinction: hide a row the user
                          could never use (no permission), disable one whose precondition they can
                          themselves satisfy — the Write add-ons rows are `enabled: () => app.writeMode`,
                          so an operator sees what the section offers and what to switch on to get it
                          (SET-5). Re-evaluated by `_refreshRows()`, not just at mount, so flipping
                          the precondition updates the rows in place.
     companion (desc|omit) Optional SECOND descriptor rendered in the same row's control cell,
                          to the right of the main control. For a setting that is really one
                          decision made with two inputs — the access-point add-on's switch and the
                          `Configure` button opening its sub-page, or (on that sub-page) the AP name
                          template + its counter scope. Only its control is used (its
                          tab/category/label/show are ignored; the row's own `show`/`enabled` gate
                          both), so keep it to a control type. It may carry one field of its own:
       visible (fn|omit)  Optional predicate; the companion's control is hidden when it returns
                          false, and — like `enabled` — re-applied in place by `_refreshRows()`
                          rather than only at mount. One notch past `enabled`'s "can't have it
                          YET": there is nothing to offer *at all* yet, so it isn't shown inert.
                          The `Configure` button is the case — it's meaningless while the add-on it
                          configures is switched off.

   Per type:
     'toggle'  get()      -> current boolean.        Renders a sliding switch.
               set(v)     -> may return a Promise; persist/apply the new boolean. A rejected
                          promise reverts the switch (so a failed save, or a declined confirm,
                          never lies), mirroring the 'select' revert.
     'select'  get()      -> current value (string). Renders a dropdown.
               options    (array) [[value, label], …] — a FIXED public allowlist, never an
                          arbitrary field. Keep in step with the server's matching allowlist.
               set(v)     -> Promise; persist the new value. A rejected promise reverts the
                          dropdown to its previous value (so a failed save never lies).
     'text'    get()      -> current value (string). Renders a text input, saving on blur/Enter.
               placeholder (string|omit) the input's placeholder.
               set(v)     -> Promise; persist the trimmed value. Resolving to a STRING adopts it
                          as the canonical value (so a server that normalises the input — e.g.
                          an empty template resetting to its default — is shown, not the raw
                          text). A rejected promise reverts, like 'select'.
     'search-select'      For an option list too large/unbounded for a `<select>` (a NetBox
                          role/type list). Renders the shared `Combo` (lib.js).
               get()      -> current {id,name} or null.
               load(q)    -> Promise<[{id,name}]>; queried per keystroke, server-side search.
               set(opt)   -> Promise; persist the picked option (null = cleared). Rejection
                          reverts, per Combo's contract.
     'action'  run()       what the button does.     Renders a button.
               button     (string) the button's text.
               variant   (fn|omit) '' | 'primary' | 'danger'.

   A setting can be **runtime-only** (e.g. `siteLabels` — get/set read/write a field on `App`,
   nothing survives a reload) or **persisted**: its `set` POSTs to a backend endpoint that merges
   the value into the `settings` blob, and its `get` reads the value the server seeded onto `App`
   (via `window.MAP`). The floor-label-field `select` is the first persisted descriptor (SET-1),
   riding `api/settings/floor-label-field`; add more the same way.

   ── Sub-pages ─────────────────────────────────────────────────────────────────
   An add-on whose configuration has more to say than a row's one-line tooltip can hold gets a page
   of its own, **subclassing this one** (SET-6) rather than reimplementing the framework: override
   `_descriptors()` with just its rows, `_title()` with its heading, and `_sections()` with any
   reference prose to render under them. `mount()` then builds it with the same rows, controls,
   revert contracts, and gating as the main page — and since a sub-page's descriptors declare no
   `tab`, they land in one tab and the strip omits itself.

   `ApSettingsPage` (ap-settings-page.js, `#/settings/access-points`) is the first: the AP add-on
   keeps its on/off switch here, and its options — device role, name template, name counter — live
   there, reached by the `Configure` companion on that switch's row.
   ─────────────────────────────────────────────────────────────────────────────── */

// Per-browser flag recording that this browser's user has seen and accepted the one-time write-mode
// consent modal (LOC-2). Kept in localStorage — like the other per-browser UI prefs (grid step,
// ortho/snap, siteplan legend) — so the modal explaining what write mode writes to NetBox shows once
// per browser, independent of the install-wide `write_mode` setting it gates.
const WRITE_MODE_CONSENT_KEY = 'fm-write-mode-consent';

// Per-browser flag recording that this browser's user has seen the one-time note shown when access
// point creation is switched on (SET-6), pointing them at its configuration page. Keyed like
// WRITE_MODE_CONSENT_KEY above and for the same reason — a note explaining a page is worth showing
// once per person, not once per install — but it records only that the note was *seen*: unlike
// write mode's, this modal is informational and cannot veto the switch.
const AP_CONFIGURE_NOTE_KEY = 'fm-ap-configure-note';

// The tab a descriptor lands in when it declares no `tab` (SET-4). Every pre-tabs setting predates
// the field and belongs here, so defaulting keeps the registry free of boilerplate — only the rows
// that leave General say so.
const DEFAULT_TAB = 'General';

class SettingsPage {
  constructor(app) {
    this.app = app;
    // Rows carrying an `enabled` predicate, as `{d, row, controls}`, so `_refreshRows` can
    // re-apply their disabled state in place when the precondition flips (SET-5).
    this._gated = [];
    // Companion controls carrying a `visible` predicate, as `{d, el}` — the same in-place refresh
    // one notch further along, hiding rather than disabling (SET-6). Kept separate from `_gated`
    // because the two compose independently: the Configure button follows its add-on's switch,
    // while the row's `enabled` follows write mode and reaches every control in the row.
    this._dynamic = [];
    // Combo instances by their element, so `_setDisabled` can reach the widget's own API rather
    // than reaching into its DOM. Every other control type answers to a plain `.disabled`. Dies
    // with this instance — `App.showSettings` builds a fresh SettingsPage per mount.
    this._combos = new Map();
  }

  /** Build the settings view into `stage` (App.showSettings clears it first). Panels are built once
   *  here — the descriptors have already been evaluated — and a tab switch only toggles which panel
   *  is `hidden`, never a re-render (mirroring how `_switch` flips its knob in place). The selected
   *  tab is plain instance state, so a re-mount resets to the first tab; there is no
   *  `#/settings/<tab>` route. A **sub-page** is routed (`#/settings/access-points`, SET-6) where a
   *  tab is not, and the difference is the point: a tab is a view of this same page, so routing it
   *  would mean the re-mount this design avoids; a sub-page is a place of its own. */
  mount(stage) {
    const view = Dom.el('div', { class: 'settings-view' }, [Dom.el('h2', {}, this._title())]);
    const tabs = this._groups();
    this._tab = tabs.keys().next().value;   // first visible tab (undefined only if nothing is visible)
    const panels = new Map();
    for (const [tab, cats] of tabs) panels.set(tab, this._panel(tab, cats));
    // A lone tab is chrome offering no choice, so it renders bare. That's exactly the non-importer's
    // page (every non-General row is `canImport`-gated) — and every sub-page, whose descriptors
    // declare no tab. It reads as it did before tabs existed.
    if (tabs.size > 1) view.append(this._tabStrip([...tabs.keys()], panels));
    for (const panel of panels.values()) view.append(panel);
    view.append(...this._sections());
    stage.append(view);
  }

  /** The page's `<h2>`. A sub-page overrides it (SET-6); the tab strip below names the sections. */
  _title() { return 'Settings'; }

  /** Extra nodes rendered under the panels — a sub-page's reference prose (SET-6). Empty here: the
   *  main page is a registry of rows, and anything it needed to say would belong in a tooltip. */
  _sections() { return []; }

  /** The visible descriptors grouped `tab → category → rows`, each level in first-seen order (the
   *  rule categories already followed; tabs inherit it rather than adding a second ordering rule).
   *  `show` gates here, so a tab whose every descriptor is hidden never gets a key — it renders no
   *  tab button and no panel, rather than an empty one. */
  _groups() {
    const tabs = new Map();
    for (const d of this._descriptors()) {
      if (d.show && !d.show()) continue;
      const tab = d.tab || DEFAULT_TAB;
      if (!tabs.has(tab)) tabs.set(tab, new Map());
      const cats = tabs.get(tab);
      if (!cats.has(d.category)) cats.set(d.category, []);
      cats.get(d.category).push(d);
    }
    return tabs;
  }

  /** One tab's panel: its categories as `<h3>` sections, each followed by its rows. */
  _panel(tab, cats) {
    const panel = Dom.el('div', {
      class: 'settings-panel', role: 'tabpanel', id: this._panelId(tab),
      'aria-labelledby': this._tabId(tab),
    });
    if (tab !== this._tab) panel.hidden = true;
    for (const [category, descs] of cats) {
      panel.append(Dom.el('h3', { class: 'settings-h3' }, category));
      for (const d of descs) panel.append(this._row(d));
    }
    return panel;
  }

  /** The tab strip: one `role="tab"` button per tab, driving which panel is shown. Follows the
   *  standard tablist keyboard pattern — a roving tabindex (only the selected tab is tabbable, so
   *  Tab enters the strip once and moves on to the panel) with Arrow/Home/End moving between tabs,
   *  matching `Combo`'s precedent that a custom widget here is keyboard-navigable, not mouse-only. */
  _tabStrip(names, panels) {
    const buttons = names.map((tab) => Dom.el('button', {
      class: 'settings-tab', role: 'tab', id: this._tabId(tab),
      'aria-controls': this._panelId(tab), 'aria-selected': String(tab === this._tab),
      tabindex: tab === this._tab ? '0' : '-1',
      onclick: () => select(names.indexOf(tab)),
    }, tab));
    const select = (i) => {
      this._tab = names[i];
      names.forEach((tab, j) => {
        buttons[j].setAttribute('aria-selected', String(j === i));
        buttons[j].tabIndex = j === i ? 0 : -1;
        panels.get(tab).hidden = j !== i;
      });
      buttons[i].focus();
    };
    const strip = Dom.el('div', { class: 'settings-tabs', role: 'tablist' }, buttons);
    strip.addEventListener('keydown', (e) => {
      const i = names.indexOf(this._tab);
      const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: names.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      select((to + names.length) % names.length);   // wraps, per the tablist pattern
    });
    return strip;
  }

  /** Stable element ids wiring each tab button to its panel (`aria-controls`/`aria-labelledby`).
   *  Derived from the tab name, which is the registry's own key for it. */
  _tabId(tab) { return 'settings-tab-' + this._slug(tab); }

  _panelId(tab) { return 'settings-panel-' + this._slug(tab); }

  _slug(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-'); }

  /** The setting registry — rebuilt per mount so `show`/`get` reflect live App state. */
  _descriptors() {
    const app = this.app;
    return [
      {
        category: 'Display',
        label: 'Building labels',
        tooltip: 'Show building name labels on the siteplan. Applies the next time the siteplan opens.',
        type: 'toggle',
        get: () => app.siteLabels,
        set: (v) => { app.siteLabels = v; },
      },
      {
        category: 'Display',
        label: 'Default facility',
        tooltip: 'Which facility opens when you launch the map without a direct link. Only imported facilities can be pinned.',
        type: 'select',
        // Options come from the picker's facility list (netbox.facilities(), loaded at boot into
        // app.facilities): '' (the default facility, i.e. no pin) plus every OTHER facility that has
        // an imported map — an empty one can't be a useful default (it would just re-open the import
        // wizard). A bogus/stale slug is server-clamped to '' (facilities.clamp_default_facility).
        options: this._facilityOptions(),
        // Import-gated like the endpoint's IMPORT_PERM gate; hidden until the facility list loads
        // (a failed load leaves app.facilities null and there'd be nothing to choose).
        show: () => app.canImport && !!app.facilities,
        get: () => app.defaultFacility,
        set: (v) => this._saveDefaultFacility(v),
      },
      {
        category: 'Import & data',
        label: 'Edit buildings & floors',
        tooltip: 'Render floor-plan PDFs into the map. Re-open it to add, replace, or reassign drawings without starting over.',
        type: 'action',
        button: 'Open editor',
        variant: () => 'primary',
        run: () => app.go('/import'),
      },
      {
        category: 'Import & data',
        label: 'Floor label field',
        tooltip: 'Which Location field seeds a floor’s label at import. Changing it applies to future imports and Location previews; re-import a floor to relabel it.',
        type: 'select',
        // Fixed public allowlist — lockstep with the server's previews.FLOOR_LABEL_FIELDS and the
        // import wizard's LABEL_FIELDS. Never an arbitrary attribute; a bogus value is server-clamped.
        options: [['name', 'Name'], ['slug', 'Slug'], ['description', 'Description']],
        // Gated on import permission, mirroring the endpoint's IMPORT_PERM gate (a non-importer would
        // only get a 403), like the backup rows.
        show: () => app.canImport,
        get: () => app.floorLabelField,
        set: (v) => this._saveFloorLabelField(v),
      },
      {
        category: 'Import & data',
        label: 'NetBox organization',
        tooltip: 'How this facility is modelled in NetBox: one Site per building, or one campus Site whose buildings are Locations. Applies to the active facility and steers future imports; nothing already imported changes. Fixed to campus mode under the Building / Location grouping, since buildings are Locations by design.',
        type: 'select',
        // Fixed public allowlist — lockstep with the server's facilities.ORG_MODE_CHOICES.
        options: [['site-as-building', 'Site = building'],
                  ['site-as-campus', 'Site = campus (buildings are Locations)']],
        // Per-facility, unlike every other persisted row here: it reads and writes the ACTIVE
        // facility's mode. Import-gated like the endpoint's IMPORT_PERM gate, and hidden until the
        // facility list loads — that list is where the current mode is read from. `enabled`, not
        // `show`, under the Location grouping (MODEL-8): a Location-subtree facility is
        // campus-shaped by construction (the server's org_mode() override), so there is nothing
        // to CHOOSE — but the row stays visible, disabled, with the tooltip explaining why, rather
        // than silently vanishing (IMPORT-15). The import wizard's own note (`_orgModeNote`) no
        // longer links here at all in this case, for the same reason.
        show: () => app.canImport && !!app.facilities,
        enabled: () => app.grouping !== 'location',
        get: () => this._orgMode(),
        set: (v) => this._saveOrgMode(v),
      },
      // Write mode heads Add-ons ▸ Write add-ons (SET-5) — first in registry order, so first-seen
      // ordering renders it above the add-ons it gates. It is a pure gate: it says whether this
      // install may write to NetBox core at all, and each row below carries its own switch on top.
      // It is the one row in the section NOT `enabled`-gated: it *is* the gate.
      {
        category: 'Import & data',
        label: 'High quality floor plans',
        tooltip: 'Render floor plans at ~216 DPI instead of ~144 so the room names printed in the plan stay readable when zoomed out. Uses roughly twice the memory and time per sheet during import — on a small host a very large sheet may fail to render, which the import reports; raise render_mem_mb if that happens. Applies to the next import or rebuild; existing floor plans keep their current renders until re-imported.',
        type: 'toggle',
        // Import-gated like the endpoint's IMPORT_PERM gate, matching the rows around it. Sits in
        // 'Import & data' rather than with the add-on switches because it tunes the import's render
        // step — it enables no feature and changes nothing in the browser.
        show: () => app.canImport,
        get: () => app.renderHq,
        set: (v) => this._saveRenderHq(v),
      },
      {
        tab: 'Add-ons',
        category: 'Write add-ons',
        label: 'Write mode',
        tooltip: 'Master switch for everything this map writes into NetBox. Off by default; NetBox stays the source of truth. The add-ons below stay switched off until it is on.',
        type: 'toggle',
        // Install-wide, admin-tier: gated on import permission, mirroring the endpoint's IMPORT_PERM
        // gate like the other persisted settings. Enabling it shows a one-time consent modal first.
        show: () => app.canImport,
        get: () => app.writeMode,
        set: (v) => this._saveWriteMode(v),
      },
      {
        tab: 'Add-ons',
        category: 'Write add-ons',
        label: 'Inline room creation',
        tooltip: 'Let users who hold the add-Location permission create a room’s NetBox Location from the floor bind panel, when the search finds little to bind to.',
        type: 'toggle',
        // Split out of write mode by SET-5: before it, write-mode-on silently meant this was on too.
        // Admin-tier like its siblings; the per-user dcim.add_location permission is a separate,
        // orthogonal gate the server enforces (an operator without it still configures this).
        show: () => app.canImport,
        enabled: () => app.writeMode,
        get: () => app.inlineRoomCreation,
        set: (v) => this._saveInlineRoomCreation(v),
      },
      // Access point creation sits under Add-ons ▸ Write add-ons (SET-4): it is an add-on that
      // creates real NetBox Device records, which is what that section collects. Since SET-6 it is
      // **one switch** here, like its inline-room-creation sibling above — its options (device role,
      // name template, name counter) had more to say than a row's tooltip could hold, so they live
      // on ApSettingsPage, reached by the Configure companion. A general (non-writing) add-ons
      // section joins this one later.
      {
        tab: 'Add-ons',
        category: 'Write add-ons',
        label: 'Access point creation',
        tooltip: 'Add a floor-editor tool that creates an unracked access point in NetBox where you click. Also needs the add-Device permission.',
        type: 'toggle',
        // Install-wide, admin-tier: gated on import permission like the other persisted settings.
        // Stored separately from write mode, but only reachable behind it (SET-5) — so the tool can
        // no longer be switched on into a state where it silently wouldn't appear.
        show: () => app.canImport,
        enabled: () => app.writeMode,
        get: () => app.apTool,
        set: (v) => this._saveApTool(v),
        // The way to the add-on's own page. A companion rather than a row of its own: switching the
        // add-on on and saying how it behaves are one decision, made with two inputs — which is
        // exactly what a companion is for. Shown only while the add-on is on (there is nothing to
        // configure for a feature that isn't in play), and inert with the rest of the row when write
        // mode is off.
        companion: {
          type: 'action',
          button: 'Configure',
          visible: () => app.apTool,
          run: () => app.go('/settings/access-points'),
        },
      },
      // A general (non-writing) add-ons section (ADDON-4), separate from Write add-ons above: these
      // features add in-app surfaces without writing into NetBox core, so they carry no dependency
      // on write mode (no `enabled: () => app.writeMode` gate). The to-do lists are the first.
      {
        tab: 'Add-ons',
        category: 'General add-ons',
        label: 'To-do lists',
        tooltip: 'Track work against rooms: a to-do panel on each floor, a facility-wide roll-up page, and an add-to-do control on a room. On by nobody until you switch it on here; it writes nothing into NetBox.',
        type: 'toggle',
        // Install-wide, admin-tier: gated on import permission like the other persisted settings.
        // Not `enabled`-gated on write mode — the feature is non-writing, so it stands on its own.
        show: () => app.canImport,
        get: () => app.todos,
        set: (v) => this._saveTodos(v),
      },
      {
        category: 'Backup & restore',
        label: 'Export archive',
        tooltip: 'Download every map (buildings, floors, rooms, rack placements, and rendered images) as one .tar.gz.',
        type: 'action',
        button: 'Export archive',
        show: () => app.canImport,
        run: () => this._exportArchive(),
      },
      {
        category: 'Backup & restore',
        label: 'Restore from archive',
        tooltip: 'Replace the entire facility map with a backup .tar.gz. This permanently overwrites all current map data.',
        type: 'action',
        button: 'Restore from archive…',
        variant: () => 'danger',
        show: () => app.canReset,
        run: () => this._restoreArchive(),
      },
      {
        category: 'Backup & restore',
        label: 'Wipe all data',
        tooltip: 'Delete every map, room, rack placement, rendered image and plugin setting, returning the plugin to a blank-slate install. Nothing else in NetBox is touched.',
        type: 'action',
        button: 'Wipe all data…',
        variant: () => 'danger',
        show: () => app.canReset,
        run: () => this._confirmWipe(),
      },
    ];
  }

  /** One label ⟷ control row: label + hover-tooltip ⓘ on the left, the control on the right. */
  _row(d) {
    const info = Dom.el('span', { class: 'fm-info', tabindex: '0', html: Icons.info }, [
      Dom.el('span', { class: 'fm-tooltip', role: 'tooltip' }, d.tooltip),
    ]);
    Tooltip.attach(info);   // fixed-position hover/focus reveal with viewport flip/clamp
    // A `companion` descriptor puts a second control in the same cell, to its right — the row
    // stays one label ⟷ one decision, even when that decision takes two inputs.
    const companion = d.companion ? this._control(d.companion) : null;
    const controls = [this._control(d), companion]
      .filter(Boolean);   // an unknown type renders nothing (_control returns null)
    const row = Dom.el('div', { class: 'settings-row' }, [
      Dom.el('div', { class: 'settings-label' }, [Dom.el('span', {}, d.label), info]),
      Dom.el('div', { class: 'settings-control' }, controls),
    ]);
    // A companion's own `visible` hides just that control, leaving the rest of the row alone — the
    // one thing a companion may decide for itself, because it's about whether it has anything to
    // offer, not about whether the row's decision is available.
    if (companion && d.companion.visible) {
      const entry = { d: d.companion, el: companion };
      this._dynamic.push(entry);
      this._applyVisible(entry);   // so it starts hidden, not just after the first refresh
    }
    // The row's own `enabled` gates BOTH controls, exactly as its own `show` does — a companion is
    // half of one decision, so it can't be separately operable.
    if (d.enabled) {
      const entry = { d, row, controls };
      this._gated.push(entry);
      this._applyEnabled(entry);   // so a row starts disabled, not just after the first refresh
    }
    return row;
  }

  /** Re-evaluate every `enabled` and `visible` predicate and update the rows in place — no
   *  re-render, mirroring `_switch`'s flip-in-place. Called when a setting flips a precondition of
   *  another row (write mode, SET-5) or of its own row's companion (access point creation, SET-6).
   *  It must not go through `App.showSettings()`: that builds a *fresh* SettingsPage, whose `mount`
   *  resets the selected tab to the first one — so re-mounting would kick the operator from the
   *  Add-ons tab back to General at the very moment they flipped the switch. */
  _refreshRows() {
    for (const g of this._gated) this._applyEnabled(g);
    for (const v of this._dynamic) this._applyVisible(v);
  }

  /** Apply one companion's current visibility. `hidden` alone wouldn't do it — every control type
   *  here sets its own `display` (`button` is `inline-flex`), which beats the UA's `[hidden]` rule;
   *  `.settings-control > [hidden]` in the stylesheet is what actually pulls it out of the flex
   *  row, the same explicit opt-in `#panel-toggle[hidden]` needs. */
  _applyVisible(v) {
    v.el.hidden = !v.d.visible();
  }

  /** Apply one gated row's current enabled state: the row reads as disabled and its controls stop
   *  being operable. Purely presentational — the stored value is untouched, so an add-on switched on
   *  before the gate closed stays on and simply goes inert (its endpoint re-checks the gate anyway). */
  _applyEnabled(g) {
    const on = !!g.d.enabled();
    g.row.classList.toggle('is-disabled', !on);
    for (const el of g.controls) this._setDisabled(el, !on);
  }

  /** Disable/enable one control element. `Combo` is a composite widget, so it answers through its
   *  own API (looked up by element); every other control type is a native input/select/button that
   *  takes a plain `.disabled`. */
  _setDisabled(el, disabled) {
    const combo = this._combos.get(el);
    if (combo) combo.setDisabled(disabled);
    else el.disabled = disabled;
  }

  /** Render a descriptor's control by type. */
  _control(d) {
    if (d.type === 'toggle') return this._switch(d);
    if (d.type === 'select') return this._select(d);
    if (d.type === 'text') return this._text(d);
    if (d.type === 'search-select') return this._searchSelect(d);
    if (d.type === 'action') {
      return Dom.el('button', { class: (d.variant && d.variant()) || '', onclick: d.run }, d.button);
    }
    return null;   // unknown type: render nothing rather than throw (fail gracefully client-side)
  }

  /** A text input bound to a `text` descriptor, saving on blur (Enter blurs, so there is one commit
   *  path). Mirrors `_select`'s revert contract — a rejected save restores the last committed text,
   *  so a failed write never leaves the box showing a value the server didn't take. A `set` that
   *  resolves to a string adopts it as the committed value, letting the server's normalisation (an
   *  empty template resetting to its default) show up in the field rather than the raw input. */
  _text(d) {
    const input = Dom.el('input',
      { class: 'fm-text', value: d.get() || '', placeholder: d.placeholder || '' });
    let prev = input.value;
    input.addEventListener('blur', () => {
      const next = input.value.trim();
      if (next === prev) { input.value = prev; return; }   // no-op (or whitespace-only) edit
      Promise.resolve(d.set(next))
        .then((stored) => { prev = typeof stored === 'string' ? stored : next; input.value = prev; })
        .catch((e) => {
          input.value = prev;
          if (e && e.message) Toast.show('Could not save setting: ' + e.message, true);
        });
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    return input;
  }

  /** The shared `Combo` (lib.js) bound to a `search-select` descriptor: an input that queries
   *  `load(q)` server-side per keystroke. `Combo` owns the revert-on-rejected-save contract. */
  _searchSelect(d) {
    const combo = new Combo({
      value: d.get(), placeholder: d.placeholder || 'Search…',
      load: d.load, onPick: d.set,
    });
    this._combos.set(combo.el, combo);   // `_setDisabled` needs the widget, not just its element
    return combo.el;
  }

  /** A dropdown bound to a `select` descriptor's allowlist. Preselects `get()`; on change it calls
   *  `set()` (which persists) and, on a rejected save, reverts the control to its previous value so
   *  a failed write never leaves the UI showing a value the server didn't accept. */
  _select(d) {
    const current = d.get();
    const sel = Dom.el('select', { class: 'fm-select' }, d.options.map(([value, text]) => {
      const o = Dom.el('option', { value }, text);
      if (value === current) o.selected = true;
      return o;
    }));
    let prev = current;
    sel.onchange = () => {
      const next = sel.value;
      Promise.resolve(d.set(next))
        .then(() => { prev = next; })
        .catch((e) => { sel.value = prev; Toast.show('Could not save setting: ' + e.message, true); });
    };
    return sel;
  }

  /** `[value, label]` options for the Default-facility select (SET-2): '' ("Default facility", the
   *  no-pin choice) first, then every OTHER facility from the picker list that has an imported map —
   *  an empty facility can't be a useful boot default. Labels mirror the picker's. Built at mount
   *  from the live `app.facilities` (loaded once at boot); an unloaded list yields just the '' row,
   *  though `show` hides the whole descriptor until it loads. */
  _facilityOptions() {
    const opts = [['', 'Default facility']];
    for (const f of (this.app.facilities || [])) {
      if (f.slug && f.has_content) opts.push([f.slug, f.name]);
    }
    return opts;
  }

  /** Persist the default facility to the install-wide settings blob (SET-2). Updates the live `App`
   *  copy on success so a re-mount preselects it; a thrown error propagates to `_select`, which
   *  reverts the dropdown. The server clamps a stale/bogus slug to '', so a save always resolves to a
   *  pinnable value. */
  async _saveDefaultFacility(slug) {
    await Api.post('/api/settings/default-facility', { default_facility: slug });
    this.app.defaultFacility = slug;
    Toast.show('Default facility saved.');
  }

  /** The active facility's organization mode (MODEL-6) — `App.orgMode()`, the single reader of that
   *  per-facility fact (the import wizard steers its bind step off the same call). The row is
   *  `!!app.facilities`-gated above, so the list is loaded by the time this renders. */
  _orgMode() {
    return this.app.orgMode();
  }

  /** Persist the active facility's organization mode (MODEL-6) through `App.setOrgMode()`, the
   *  client's one write path (also used by the import wizard's inline "Switch to…" control) — this
   *  wrapper only adds the row's own toast; a thrown error propagates to `_select`, which reverts
   *  the dropdown. */
  async _saveOrgMode(mode) {
    await this.app.setOrgMode(mode);
    Toast.show('NetBox organization saved.');
  }

  /** Persist the floor-label field to the install-wide settings blob (SET-1). Updates the live
   *  `App` copy on success so a re-mount preselects it; a thrown error propagates to `_select`,
   *  which reverts the dropdown. */
  async _saveFloorLabelField(field) {
    await Api.post('/api/settings/floor-label-field', { floor_label_field: field });
    this.app.floorLabelField = field;
    Toast.show('Floor label field saved.');
  }

  /** Persist install-wide write mode to the settings blob (LOC-2) — the master gate on everything
   *  the map writes into NetBox. Enabling it shows a one-time (per-browser) consent modal explaining
   *  that; a decline rejects with an empty message so `_switch` reverts the knob silently, and the
   *  setting is left off. On accept (or when already consented) it POSTs, updates the live `App`
   *  copy so the write add-ons apply without a reload, and records consent. Disabling needs no
   *  confirm. A failed POST propagates to `_switch`, which reverts.
   *
   *  Flipping this gate changes whether every OTHER Write add-ons row is operable, so a successful
   *  save refreshes them in place (SET-5). Their stored values are deliberately left alone: closing
   *  the gate makes them inert, not forgotten, so reopening it restores the configuration an
   *  operator already had rather than making them set it up again. */
  async _saveWriteMode(enabled) {
    if (enabled && localStorage.getItem(WRITE_MODE_CONSENT_KEY) !== '1') {
      if (!await this._confirmWriteMode()) throw new Error('');   // declined — revert silently
      localStorage.setItem(WRITE_MODE_CONSENT_KEY, '1');
    }
    await Api.post('/api/settings/write-mode', { write_mode: enabled });
    this.app.writeMode = enabled;
    this._refreshRows();
    Toast.show(enabled ? 'Write mode enabled.' : 'Write mode disabled.');
  }

  /** Persist the high-quality floor-plan rendering switch (READ-1). Nothing re-renders on save —
   *  the setting is read by the import subprocess when a build next runs — so the toast says so
   *  rather than implying the plans just got sharper. */
  async _saveRenderHq(enabled) {
    await Api.post('/api/settings/render-hq', { render_hq: enabled });
    this.app.renderHq = enabled;
    Toast.show(enabled
      ? 'High quality rendering on — applies to the next import or rebuild.'
      : 'High quality rendering off — applies to the next import or rebuild.');
  }

  /** Persist the to-do feature's on/off switch (ADDON-4) — a general (non-writing) add-on, so it is
   *  not `enabled`-gated on write mode like the write add-ons. Updates the live `App` copy so the
   *  #/todo page, the per-floor panel, and the room compose "+" appear/disappear without a reload;
   *  the endpoints re-check the setting server-side. A failed POST propagates to `_switch`, which
   *  reverts. Nothing else in the page depends on this row, so no `_refreshRows`. */
  async _saveTodos(enabled) {
    await Api.post('/api/settings/todos', { todos: enabled });
    this.app.todos = enabled;
    Toast.show(enabled ? 'To-do lists enabled.' : 'To-do lists disabled.');
  }

  /** Persist the inline-room-creation add-on's on/off switch (SET-5) — whether the floor bind panel
   *  may offer its create tile. Split out of write mode, which used to imply this feature; the row is
   *  `enabled`-gated on write mode, so this only ever saves with the master gate already open. The
   *  per-user `dcim.add_location` permission is orthogonal and enforced server-side, so an operator
   *  who cannot create Locations themselves can still configure this for those who can. A failed POST
   *  propagates to `_switch`, which reverts. */
  async _saveInlineRoomCreation(enabled) {
    await Api.post('/api/settings/inline-room-creation', { inline_room_creation: enabled });
    this.app.inlineRoomCreation = enabled;
    Toast.show(enabled ? 'Inline room creation enabled.' : 'Inline room creation disabled.');
  }

  /** Persist the access-point creation add-on's on/off switch (DEV-3). The feature's own install-wide
   *  switch, stored separately from write mode — it answers "is this feature in play?", not "may this
   *  install write to NetBox at all?". Since SET-5 the row is `enabled`-gated on write mode, so unlike
   *  its DEV-3 self this can no longer be switched on into a state where the tool would be inertly
   *  absent (which is what the old write-mode nudge existed to explain). A failed POST propagates to
   *  `_switch`, which reverts.
   *
   *  Flipping it changes its own row: the `Configure` companion is `visible` only while the add-on is
   *  on, so a successful save refreshes in place (SET-6). Switching it **on** for the first time in
   *  this browser then shows the one-time note pointing at that page — after the save, never before,
   *  because unlike `_saveWriteMode`'s consent modal this one is informational and must not be able to
   *  veto the switch. Its answer only decides whether we navigate there now; either way the add-on
   *  stays on. Awaiting it is safe: `_switch` has already flipped the knob and only `.catch`es, so a
   *  promise left pending on an open modal neither reverts nor lies. */
  async _saveApTool(enabled) {
    await Api.post('/api/settings/ap-tool', { ap_tool: enabled });
    this.app.apTool = enabled;
    this._refreshRows();
    Toast.show(enabled ? 'Access point creation enabled.' : 'Access point creation disabled.');
    if (enabled && localStorage.getItem(AP_CONFIGURE_NOTE_KEY) !== '1') {
      localStorage.setItem(AP_CONFIGURE_NOTE_KEY, '1');
      if (await this._noteApConfigure()) this.app.go('/settings/access-points');
    }
  }

  /** The one-time note shown when access point creation is first switched on in this browser
   *  (SET-6), resolving `true` to open its configuration page / `false` to stay. It is
   *  **informational, not consent**: there is no Cancel, because there is nothing to cancel — the
   *  add-on is already on and stays on however this is dismissed. It exists because the tool needs a
   *  device role before it will appear, so switching the add-on on and stopping there looks like
   *  nothing happened. Backdrop, Escape, or "Not now" resolves `false`. */
  _noteApConfigure() {
    return Modal.confirm({
      title: 'Access point creation is on',
      body: 'Before the tool appears in the floor editor, it needs a NetBox device role to create '
        + 'access points with. You can also set how their suggested names are built.',
      hint: 'Everything is on the access points page, reachable any time from Configure on this row.',
      cancelLabel: 'Not now',
      confirmLabel: 'Configure access points',
    });
  }

  /** One-time consent modal for enabling write mode (LOC-2), resolving `true` to proceed / `false`
   *  to cancel. Informational rather than a warning — it spells out that write mode is the master
   *  gate on everything the map writes into NetBox core, that each add-on behind it is switched on
   *  separately, and that NetBox stays the source of truth. Backdrop, Escape, or Cancel resolves
   *  `false`, and `_saveWriteMode` turns that into the rejection `_switch` reverts on. */
  _confirmWriteMode() {
    return Modal.confirm({
      title: 'Enable write mode',
      body: 'Write mode is the master switch for everything this map writes into NetBox core — '
        + 'creating room Locations from the bind panel, and creating access point Devices. '
        + 'Nothing is written until you also switch on the individual add-on that does it.',
      hint: 'NetBox stays the source of truth. Model Locations there first where you can. This is an '
        + 'install-wide setting; individual users still need the matching add permission '
        + '(add-Location, add-Device) before they can create anything.',
      confirmLabel: 'Enable write mode',
    });
  }

  /** A sliding on/off switch (reusable across every `toggle` descriptor). Flips in place so
   *  the knob animates via CSS — no re-render — then applies the change through `set`. Mirrors
   *  `_select`'s revert contract: `set` may return a Promise, and a rejection flips the knob back so
   *  a failed save (or a declined confirm) never lies. A rejection carrying a message is toasted; an
   *  empty-message rejection (e.g. a user who cancelled a confirm modal) reverts silently. A
   *  runtime-only toggle whose `set` returns nothing just resolves and keeps the new state. */
  _switch(d) {
    const sw = Dom.el('button', {
      class: 'fm-switch', role: 'switch',
      'aria-checked': String(!!d.get()), 'aria-label': d.label,
    }, [Dom.el('span', { class: 'fm-switch-knob' })]);
    sw.onclick = () => {
      const next = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(next));
      Promise.resolve(d.set(next)).catch((e) => {
        sw.setAttribute('aria-checked', String(!next));
        if (e && e.message) Toast.show('Could not save setting: ' + e.message, true);
      });
    };
    return sw;
  }

  // ---- Backup & restore workflow (settings-only; moved here from App) ----

  /** Stream the export endpoint to a download without leaving the SPA. The response carries
   *  `Content-Disposition: attachment`, so a plain authenticated GET via a hidden link downloads
   *  in place (no Blob buffering of a potentially large archive). */
  _exportArchive() {
    const base = window.MAP ? window.MAP.api : '/api/';
    const a = Dom.el('a', { href: base + 'backup/export', download: '' });
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    Toast.show('Preparing archive…');
  }

  /** Pick a backup archive, then confirm the destructive restore. */
  _restoreArchive() {
    const input = Dom.el('input',
      { type: 'file', accept: '.gz,.tgz,.tar.gz,application/gzip' });
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.remove();
      if (file) this._confirmRestore(file);
    });
    document.body.append(input);
    input.click();
  }

  /** The pre-flight "export what you're about to lose" button both destructive dialogs carry. It
   *  is body content, not a footer action: taking it is a detour that leaves the dialog open, and
   *  it self-disables once used so a second click can't queue a duplicate download. */
  _backupFirstButton() {
    const btn = Dom.el('button', {
      onclick: () => { this._exportArchive(); btn.textContent = '✓ Backup downloaded'; btn.disabled = true; },
    }, 'Download a backup of the current map first');
    return btn;
  }

  /** Destructive-restore confirmation. A single native confirm() (the reset idiom) can't carry
   *  the pre-restore "download a backup first" safety net, so this is a `Modal.open` shell rather
   *  than a plain `Modal.confirm`: it informs that restoring replaces everything, offers a
   *  one-click current-state export, and only then proceeds. Backdrop, Escape, or Cancel dismisses
   *  it — and per the §11 convention the irreversible action wears `.danger` while Cancel takes the
   *  `.primary` emphasis. */
  _confirmRestore(file) {
    const dlg = Modal.open({
      title: 'Restore from archive',
      body: [
        'This permanently replaces ALL facility-map data (every building, floor, room, and '
        + 'rack placement, plus the rendered floor images) with the contents of “' + file.name
        + '”. This cannot be undone.',
        Dom.el('p', { class: 'hint' },
          'Rooms are re-linked to Locations by slug, so a backup can be restored to a new NetBox '
          + 'instance. If any Location can’t be matched, the restore is aborted without '
          + 'changing anything and lists what’s missing. Rendered images are rebuilt from the '
          + 'archive; if any look stale, re-run the import to regenerate them.'),
        this._backupFirstButton(),
      ],
      actions: [
        Dom.el('button', { class: 'primary', onclick: () => dlg.close() }, 'Cancel'),
        Dom.el('button', { class: 'danger', onclick: () => { dlg.close(); this._doRestore(file); } },
          'Replace all data & restore'),
      ],
    });
  }

  /** Upload the archive to the restore endpoint (multipart + CSRF, mirroring ImportUploader),
   *  then hard-reload — the cleanest way to re-hydrate the SPA after a wholesale data swap. */
  async _doRestore(file) {
    Toast.show('Restoring… this may take a moment');
    const base = window.MAP ? window.MAP.api : '/api/';
    const fd = new FormData();
    fd.append('file', file, file.name);
    const headers = {};
    if (window.MAP && window.MAP.csrf) headers['X-CSRFToken'] = window.MAP.csrf;
    try {
      const r = await fetch(base + 'backup/restore', { method: 'POST', headers, body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        // A binding-resolution abort (BAK-1) returns the specific rooms that couldn't be
        // re-linked; log the full list and point the toast at it. Nothing was changed.
        if (Array.isArray(j.unresolved) && j.unresolved.length) {
          console.warn('Restore aborted — unresolved bindings:', j.unresolved);
          Toast.show('Restore aborted: ' + j.unresolved.length
            + ' room binding(s) not found on this instance (nothing changed; see console).', true);
          return;
        }
        throw new Error(j.error || 'HTTP ' + r.status);
      }
    } catch (e) {
      Toast.show('Restore failed: ' + e.message, true);
      return;
    }
    Toast.show('Facility map restored. Reloading…');
    window.location.reload();
  }

  // ---- Full data wipe (HEALTH-12) ----

  /** Blank-slate confirmation. Same modal idiom as `_confirmRestore` — and the same pre-flight
   *  export button, since a wipe is the one action with no archive arriving to replace what it
   *  removes. Deliberately whole-install only: the SPA has an active facility, so a per-facility
   *  button here would read ambiguously ("all data" vs "this facility's"); the narrower scope is
   *  the `facilitymap_wipe --facility` CLI's. */
  _confirmWipe() {
    const dlg = Modal.open({
      title: 'Wipe all data',
      body: [
        'This permanently deletes ALL facility-map data — every facility, building, floor, room, '
        + 'to-do and rack placement, every uploaded drawing and rendered image, and the plugin’s '
        + 'own settings. The plugin is left as a blank-slate install. This cannot be undone.',
        Dom.el('p', { class: 'hint' },
          'Nothing else in NetBox is touched: your sites, locations, racks and devices are left '
          + 'exactly as they are, and backup archives are kept — so you can restore one afterwards '
          + 'or re-import from scratch.'),
        this._backupFirstButton(),
      ],
      actions: [
        Dom.el('button', { class: 'primary', onclick: () => dlg.close() }, 'Cancel'),
        Dom.el('button', { class: 'danger', onclick: () => { dlg.close(); this._doWipe(); } },
          'Delete everything'),
      ],
    });
  }

  /** POST the wipe, then hard-reload — after a wholesale delete every cached store document,
   *  manifest and facility list is stale, exactly as after a restore. */
  async _doWipe() {
    Toast.show('Wiping… this may take a moment');
    const base = window.MAP ? window.MAP.api : '/api/';
    const headers = { 'Content-Type': 'application/json' };
    if (window.MAP && window.MAP.csrf) headers['X-CSRFToken'] = window.MAP.csrf;
    try {
      const r = await fetch(base + 'data/wipe',
        { method: 'POST', headers, body: JSON.stringify({ all: true }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || 'HTTP ' + r.status);
    } catch (e) {
      Toast.show('Wipe failed: ' + e.message, true);
      return;
    }
    Toast.show('All facility-map data deleted. Reloading…');
    window.location.reload();
  }
}
