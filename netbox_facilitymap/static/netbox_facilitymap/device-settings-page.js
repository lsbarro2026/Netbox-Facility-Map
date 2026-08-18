'use strict';
/* device-settings-page.js — DeviceSettingsPage: the device-placement add-on's own settings page
   (#/settings/devices, SET-6 / DEV-8).

   The add-on's on/off switch stays on the main Settings page under Add-ons ▸ Write add-ons,
   beside its inline-room-creation sibling; everything about *how* it behaves — the device-type
   PRESETS the floor toolbar's Add-device dropdown offers — lives here, reached by the `Configure`
   companion on that switch's row.

   Unlike the row-registry pages this one is a repeatable-list editor: one card per preset (label,
   role, icon from the shipped library, name template + counter scope, prompted fields, enabled,
   order), plus "Add preset". It still subclasses `SettingsPage` for the page shell and the
   individual control builders (`_switch`/`_select`/`_text`/`_searchSelect` with inline
   descriptors — same revert contracts), but `_descriptors()` is empty and the editor renders
   through `_sections()`.

   Persistence is ONE endpoint, whole-list replace (`api/settings/device-presets`): every change
   POSTs the current list and adopts the server's canonical form — assigned keys for new presets,
   clamped fields — so create/edit/delete/reorder all share one write path and the stored order IS
   the toolbar order. A rejected save restores the last-accepted list and repaints, mirroring the
   row controls' revert contract. `previews.clean_device_presets` stays authoritative — a bad
   template is a 400 that reverts, not something checked here.

   `App.showDeviceSettings` ensures `device-shapes.js` before mounting: the icon picker renders
   the shared `DEVICE_ICON_LIBRARY` through `DeviceShapes.iconSvg`, which rides the lazy floor
   bundle. */

// The prompted-field allowlist as the card's checkboxes — lockstep with the server's
// `previews.DEVICE_PRESET_FIELDS`. `name`/`device_type` are required (the create cannot succeed
// without them), so they render as fixed text, not checkboxes; the server forces them into every
// stored list regardless.
const DEVICE_PRESET_OPTIONAL_FIELDS = [
  ['asset_tag', 'Asset tag'], ['serial', 'Serial number'],
  ['description', 'Description'], ['status', 'Status'],
];

// The name-counter scopes (DEV-3) — a FIXED allowlist, lockstep with the server's
// `previews.DEVICE_COUNT_SCOPES` (a bogus value is server-clamped). 'building' counts within the
// building anchor (MODEL-3); 'site' counts across the whole NetBox **Site** — one building for a
// Site-anchored install, the whole campus for a Site = campus install, never the facility a
// siteplan covers. The scope reference below spells that out; don't relabel without changing both.
const DEVICE_COUNT_SCOPES = [
  ['none', 'No counter'], ['room', 'Per room'], ['floor', 'Per floor'],
  ['building', 'Per building'], ['site', 'Per site / campus'],
];

// The name-template placeholders (DEV-3) — lockstep with the server's
// `previews.DEVICE_NAME_PLACEHOLDERS` and expanded by `previews.expand_device_name_template`; an
// unrecognised one is a 400, never a silent drop. Rendered as the page's reference.
const DEVICE_NAME_PLACEHOLDERS = [
  ['{room}', 'The room’s name, as it reads in NetBox.'],
  ['{room_slug}', 'The room’s NetBox slug — lowercase and hyphenated, where {room} may not be.'],
  ['{role_short}', 'A short code derived from the preset’s device role.'],
  ['{asset_tag}', 'The asset tag typed when placing the device. Left blank, the placeholder '
    + 'and one adjacent separator drop out, so the name closes up instead of trailing a stray dash.'],
];

// The counter scopes as prose, keyed by the label the `select` shows (not the stored value) so the
// reference reads as what the operator just picked. Beside DEVICE_COUNT_SCOPES above — the two are
// one vocabulary and must not drift.
const DEVICE_COUNT_SCOPE_NOTES = [
  ['No counter', 'Names are left exactly as the template builds them. Use it when the template '
    + 'already yields something unique, such as one carrying {asset_tag}.'],
  ['Per room', 'Counts within the room, so each room’s first device starts at -01.'],
  ['Per floor', 'Counts across the whole floor.'],
  ['Per building', 'Counts across the whole building, restarting in each one. When a Site holds a '
    + 'single building this matches “Per site / campus”; when a Site is a campus with buildings '
    + 'modelled as Locations, the counter restarts per building.'],
  ['Per site / campus', 'Counts across the whole NetBox Site — one building when the Site is a '
    + 'single building, the entire campus when the Site groups several. Never the whole facility a '
    + 'siteplan covers. The counter only counts devices of the preset’s own role.'],
];

class DeviceSettingsPage extends SettingsPage {
  constructor(app) {
    super(app);
    // The working copy, in window.MAP's stamped shape (stored keys + the resolved `role`
    // {id,name}|null). `_lastGood` is what the server last accepted, for the revert on a failed
    // save. Deep-copied so edits never mutate `app.devicePresets` before the server has agreed.
    this._presets = JSON.parse(JSON.stringify(app.devicePresets || []));
    this._lastGood = JSON.parse(JSON.stringify(this._presets));
  }

  _title() { return 'Device placement'; }

  /** No row registry — the whole page is the preset editor in `_sections()`. */
  _descriptors() { return []; }

  _sections() {
    const app = this.app;
    // A typed URL without import permission lands on an empty page rather than controls that
    // would only 403 (the Configure button that leads here is canImport-gated).
    if (!app.canImport) return [];
    const out = [Dom.el('p', { class: 'hint' },
      'Each preset becomes an entry in the floor editor’s “Add device” menu: it fixes the NetBox '
      + 'device role and map icon, suggests names from the template, and asks only for the fields '
      + 'picked below.')];
    if (!app.writeMode) {
      out.push(Dom.el('p', { class: 'hint' },
        'Write mode is off, so the tool is inactive — switch it on under Add-ons to place devices. '
        + 'Presets can still be configured meanwhile.'));
    }
    this._list = Dom.el('div', { class: 'preset-list' });
    this._paint();
    out.push(this._list);
    const add = Dom.el('button', { class: 'primary', onclick: () => this._addPreset() },
      'Add preset');
    out.push(Dom.el('div', { class: 'preset-add-row' }, [add]));
    out.push(
      Dom.el('h3', { class: 'settings-h3' }, 'Name placeholders'),
      Dom.el('p', { class: 'hint' },
        'A name template may mix plain text with any of these. Anything else in { } is rejected '
        + 'when you save, rather than silently dropped.'),
      this._reference(DEVICE_NAME_PLACEHOLDERS, (token) => Dom.el('code', {}, token)),
      Dom.el('h3', { class: 'settings-h3' }, 'Name counter'),
      Dom.el('p', { class: 'hint' },
        'Devices sharing a name get a -01, -02 … suffix. The scope decides what they have to '
        + 'share for the counter to see them, and so where it starts over.'),
      this._reference(DEVICE_COUNT_SCOPE_NOTES),
    );
    return out;
  }

  /** (Re)build the card list from the working copy — called on mount and after any change that
   *  alters which cards exist or their order (add/delete/reorder/revert). Value-only edits
   *  (label, template) keep their own controls and never repaint under the user's cursor. */
  _paint() {
    this._list.innerHTML = '';
    if (!this._presets.length) {
      this._list.append(Dom.el('p', { class: 'hint' },
        'No presets yet — add one to put the “Add device” tool in the floor editor.'));
    }
    this._presets.forEach((p, i) => this._list.append(this._card(p, i)));
  }

  /** One preset's card. Every control is an inline descriptor over the working copy driven
   *  through the base builders, so the revert-on-rejected-save contracts hold; each `set`
   *  mutates the working entry then `_save()`s the whole list (one endpoint, one write path). */
  _card(p, i) {
    const roleCombo = this._searchSelect({
      get: () => p.role,
      placeholder: 'Search device roles…',
      load: (q) => this.app.netbox.deviceRoles(q).then((r) => r.roles || []),
      set: (opt) => {
        p.role = opt ? { id: opt.id, name: opt.name } : null;
        p.device_role = opt ? opt.id : null;
        return this._save();
      },
    });
    const iconBtn = Dom.el('button', { class: 'preset-icon-btn', type: 'button',
      title: 'Choose this preset’s map icon', html: DeviceShapes.iconSvg(p.icon, 20) });
    iconBtn.onclick = () => this._pickIcon(p);
    const labelInput = this._text({
      get: () => p.label, placeholder: 'Preset name',
      set: (v) => { p.label = v; return this._save().then(() => p.label); },
    });
    const enabled = this._switch({
      label: 'Offer this preset in the floor editor',
      get: () => p.enabled !== false,
      set: (v) => { p.enabled = v; return this._save(); },
    });
    const naming = Dom.el('div', { class: 'preset-naming' }, [
      this._text({
        get: () => p.name_template, placeholder: '{room}-{role_short}',
        set: (v) => {
          p.name_template = v;
          // Adopt the server's stored template (an empty one resets to the default there).
          return this._save().then(() => p.name_template);
        },
      }),
      this._select({
        get: () => p.count_scope || 'none', options: DEVICE_COUNT_SCOPES,
        set: (v) => { p.count_scope = v; return this._save(); },
      }),
    ]);
    const fields = Dom.el('div', { class: 'preset-fields' },
      [Dom.el('span', { class: 'preset-fields-fixed' }, 'Device type, Name')]);
    for (const [key, label] of DEVICE_PRESET_OPTIONAL_FIELDS) {
      const box = Dom.el('input', { type: 'checkbox' });
      box.checked = (p.fields || []).includes(key);
      box.onchange = () => {
        const set = new Set(p.fields || []);
        box.checked ? set.add(key) : set.delete(key);
        p.fields = [...set];
        this._save().catch(() => {});   // _save already toasts + repaints on failure
      };
      fields.append(Dom.el('label', { class: 'preset-field' }, [box, label]));
    }
    const up = Dom.el('button', { class: 'preset-move', type: 'button', title: 'Move up',
      onclick: () => this._move(i, -1) }, '↑');
    up.disabled = i === 0;
    const down = Dom.el('button', { class: 'preset-move', type: 'button', title: 'Move down',
      onclick: () => this._move(i, 1) }, '↓');
    down.disabled = i === this._presets.length - 1;
    const del = Dom.el('button', { class: 'preset-delete', type: 'button',
      title: 'Delete this preset', onclick: () => this._deletePreset(p) }, '✕');
    const row = (label, control) => Dom.el('div', { class: 'settings-row preset-row' }, [
      Dom.el('div', { class: 'settings-label' }, [Dom.el('span', {}, label)]),
      Dom.el('div', { class: 'settings-control' }, [].concat(control)),
    ]);
    // A fieldset so write-mode-off disables every control natively, matching the main page's
    // enabled-gating of the write add-on rows — configuring resumes the moment the gate opens.
    const card = Dom.el('fieldset', { class: 'preset-card' }, [
      Dom.el('div', { class: 'preset-head' }, [iconBtn, labelInput, up, down, del]),
      row('Device role', roleCombo),
      row('Name template', naming),
      row('Dialog asks for', fields),
      row('Enabled', enabled),
    ]);
    if (!this.app.writeMode) card.disabled = true;
    return card;
  }

  /** The grouped icon picker over the shared library (`DEVICE_ICON_LIBRARY`, device-shapes.js) —
   *  the same ids the marker glyphs and the server-side embeds render, so what is picked here is
   *  exactly what draws on the map. */
  _pickIcon(p) {
    const body = [];
    for (const group of DEVICE_ICON_LIBRARY) {
      body.push(Dom.el('h3', { class: 'settings-h3' }, group.group));
      const grid = Dom.el('div', { class: 'icon-grid' });
      for (const icon of group.icons) {
        const b = Dom.el('button', {
          class: 'icon-cell' + (icon.id === p.icon ? ' selected' : ''), type: 'button',
          title: icon.label, html: DeviceShapes.iconSvg(icon.id, 22),
        });
        b.onclick = () => {
          p.icon = icon.id;
          this._save().then(() => this._paint()).catch(() => {});
          dlg.close();
        };
        grid.append(b);
      }
      body.push(grid);
    }
    const dlg = Modal.open({
      title: 'Choose an icon',
      panelClass: 'fm-icon-picker',
      body,
      actions: [Dom.el('button', { onclick: () => dlg.close() }, 'Cancel')],
    });
  }

  _move(i, delta) {
    const [p] = this._presets.splice(i, 1);
    this._presets.splice(i + delta, 0, p);
    this._paint();
    this._save().catch(() => {});
  }

  _addPreset() {
    // Saved immediately so the server mints the stable key; the operator then fills it in.
    this._presets.push({
      key: null, label: 'New preset', device_role: null, role: null, icon: 'generic',
      name_template: '', count_scope: 'none', enabled: true,
      fields: ['name', 'device_type'],
    });
    this._save().then(() => this._paint()).catch(() => {});
  }

  _deletePreset(p) {
    Modal.confirm({
      title: 'Delete preset',
      body: 'Delete “' + p.label + '”? Devices already placed through it keep their markers and '
        + 'icons — only the Add-device menu entry goes away.',
      confirmLabel: 'Delete preset',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      this._presets = this._presets.filter((x) => x !== p);
      this._paint();
      this._save().catch(() => {});
    });
  }

  /** POST the whole working list and adopt the server's canonical form: assigned keys and
   *  clamped fields come back by index (the server preserves order), the resolved `role` objects
   *  are ours to keep (the server stores only the id). On success the live `App` copy is swapped
   *  so the floor toolbar's dropdown reflects the change without a reload; on failure the last
   *  accepted list is restored and repainted, then the error rethrown so the base controls'
   *  revert contracts also fire. */
  async _save() {
    const payload = this._presets.map((p) => ({
      key: p.key || undefined, label: p.label, device_role: p.role ? p.role.id : null,
      icon: p.icon, name_template: p.name_template || '', count_scope: p.count_scope || 'none',
      enabled: p.enabled !== false, fields: p.fields || [],
    }));
    try {
      const r = await Api.post('/api/settings/device-presets', { device_presets: payload });
      r.device_presets.forEach((stored, i) => {
        const p = this._presets[i];
        Object.assign(p, stored, { role: p.role });
      });
      this._lastGood = JSON.parse(JSON.stringify(this._presets));
      this.app.devicePresets = this._presets;
      Toast.show('Device presets saved.');
    } catch (e) {
      this._presets = JSON.parse(JSON.stringify(this._lastGood));
      this._paint();
      throw e;
    }
  }

  /** A `<dl>` of term → explanation. `term` optionally wraps the left column (a placeholder
   *  renders as `<code>`, a scope name as plain text). */
  _reference(entries, term = (t) => t) {
    const nodes = [];
    for (const [key, text] of entries) {
      nodes.push(Dom.el('dt', {}, term(key)), Dom.el('dd', {}, text));
    }
    return Dom.el('dl', { class: 'settings-ref' }, nodes);
  }
}
