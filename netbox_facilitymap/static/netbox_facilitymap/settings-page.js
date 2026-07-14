'use strict';
/* settings-page.js — SettingsPage: the in-app Settings route (#/settings).

   A small declarative framework: instead of hand-wiring buttons, every setting is
   one descriptor in `_descriptors()`, and a single renderer walks them to build the
   page — grouped into categories, each row a label + hover tooltip + a control.

   ── How to add a setting ──────────────────────────────────────────────────────
   Add ONE object to the list returned by `_descriptors()`. Fields:

     category  (string)   Section heading it groups under. Reuse an existing one
                          ('Display', 'Import & data', 'Backup & restore') or name a
                          new one — categories render in first-seen order.
     label     (string)   The row's left-hand label.
     tooltip   (string)   One short line shown on hover/focus of the row's ⓘ glyph.
                          Keep it terse (ARCHITECTURE §11) — a hint, not narration.
     type      (string)   'toggle' | 'select' | 'action' (extend the renderer for new types).
     show      (fn|omit)  Optional predicate; the row is omitted when it returns false
                          (used to gate the backup + select rows on canImport / canReset).

   Per type:
     'toggle'  get()      -> current boolean.        Renders a sliding switch.
               set(v)       persist/apply the new boolean.
     'select'  get()      -> current value (string). Renders a dropdown.
               options    (array) [[value, label], …] — a FIXED public allowlist, never an
                          arbitrary field. Keep in step with the server's matching allowlist.
               set(v)     -> Promise; persist the new value. A rejected promise reverts the
                          dropdown to its previous value (so a failed save never lies).
     'action'  run()       what the button does.     Renders a button.
               button     (string) the button's text.
               variant   (fn|omit) '' | 'primary' | 'danger'.

   A setting can be **runtime-only** (e.g. `siteLabels` — get/set read/write a field on `App`,
   nothing survives a reload) or **persisted**: its `set` POSTs to a backend endpoint that merges
   the value into the `settings` blob, and its `get` reads the value the server seeded onto `App`
   (via `window.MAP`). The floor-label-field `select` is the first persisted descriptor (SET-1),
   riding `api/settings/floor-label-field`; add more the same way.
   ─────────────────────────────────────────────────────────────────────────────── */

class SettingsPage {
  constructor(app) { this.app = app; }

  /** Build the settings view into `stage` (App.showSettings clears it first). */
  mount(stage) {
    const view = Dom.el('div', { class: 'settings-view' }, [Dom.el('h2', {}, 'Settings')]);
    // Group the visible descriptors by category, preserving first-seen order.
    const groups = new Map();
    for (const d of this._descriptors()) {
      if (d.show && !d.show()) continue;
      if (!groups.has(d.category)) groups.set(d.category, []);
      groups.get(d.category).push(d);
    }
    for (const [category, descs] of groups) {
      view.append(Dom.el('h3', { class: 'settings-h3' }, category));
      for (const d of descs) view.append(this._row(d));
    }
    stage.append(view);
  }

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
    ];
  }

  /** One label ⟷ control row: label + hover-tooltip ⓘ on the left, the control on the right. */
  _row(d) {
    const info = Dom.el('span', { class: 'fm-info', tabindex: '0', html: Icons.info }, [
      Dom.el('span', { class: 'fm-tooltip', role: 'tooltip' }, d.tooltip),
    ]);
    Tooltip.attach(info);   // fixed-position hover/focus reveal with viewport flip/clamp
    return Dom.el('div', { class: 'settings-row' }, [
      Dom.el('div', { class: 'settings-label' }, [Dom.el('span', {}, d.label), info]),
      Dom.el('div', { class: 'settings-control' }, this._control(d)),
    ]);
  }

  /** Render a descriptor's control by type. */
  _control(d) {
    if (d.type === 'toggle') return this._switch(d);
    if (d.type === 'select') return this._select(d);
    if (d.type === 'action') {
      return Dom.el('button', { class: (d.variant && d.variant()) || '', onclick: d.run }, d.button);
    }
    return null;   // unknown type: render nothing rather than throw (fail gracefully client-side)
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

  /** Persist the floor-label field to the install-wide settings blob (SET-1). Updates the live
   *  `App` copy on success so a re-mount preselects it; a thrown error propagates to `_select`,
   *  which reverts the dropdown. */
  async _saveFloorLabelField(field) {
    await Api.post('/api/settings/floor-label-field', { floor_label_field: field });
    this.app.floorLabelField = field;
    Toast.show('Floor label field saved.');
  }

  /** A sliding on/off switch (reusable across every `toggle` descriptor). Flips in place so
   *  the knob animates via CSS — no re-render — then applies the change through `set`. */
  _switch(d) {
    const sw = Dom.el('button', {
      class: 'fm-switch', role: 'switch',
      'aria-checked': String(!!d.get()), 'aria-label': d.label,
    }, [Dom.el('span', { class: 'fm-switch-knob' })]);
    sw.onclick = () => {
      const next = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(next));
      d.set(next);
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

  /** Destructive-restore confirmation. A single native confirm() (the reset idiom) can't carry
   *  the pre-restore "download a backup first" safety net, so this is a small modal: it informs
   *  that restoring replaces everything, offers a one-click current-state export, and only then
   *  proceeds. Backdrop or Cancel dismisses it. */
  _confirmRestore(file) {
    const close = () => overlay.remove();
    const backupBtn = Dom.el('button', {
      onclick: () => { this._exportArchive(); backupBtn.textContent = '✓ Backup downloaded'; backupBtn.disabled = true; },
    }, 'Download a backup of the current map first');
    const overlay = Dom.el('div', { class: 'fm-modal', onclick: (e) => { if (e.target === overlay) close(); } }, [
      Dom.el('div', { class: 'fm-modal-panel' }, [
        Dom.el('h3', {}, 'Restore from archive'),
        Dom.el('p', {},
          'This permanently replaces ALL facility-map data (every building, floor, room, and '
          + 'rack placement, plus the rendered floor images) with the contents of “' + file.name
          + '”. This cannot be undone.'),
        Dom.el('p', { class: 'hint' },
          'Restore into the NetBox instance the backup came from; room links reference live '
          + 'Location ids. Rendered images are rebuilt from the archive; if any look stale, '
          + 're-run the import to regenerate them.'),
        backupBtn,
        Dom.el('div', { class: 'fm-modal-actions' }, [
          Dom.el('button', { onclick: close }, 'Cancel'),
          Dom.el('button', { class: 'danger', onclick: () => { close(); this._doRestore(file); } },
            'Replace all data & restore'),
        ]),
      ]),
    ]);
    document.body.append(overlay);
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
      if (!r.ok || !j.ok) throw new Error(j.error || 'HTTP ' + r.status);
    } catch (e) {
      Toast.show('Restore failed: ' + e.message, true);
      return;
    }
    Toast.show('Facility map restored. Reloading…');
    window.location.reload();
  }
}
