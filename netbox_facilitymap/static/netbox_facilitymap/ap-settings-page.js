'use strict';
/* ap-settings-page.js — ApSettingsPage: the access point add-on's own settings page
   (#/settings/access-points).

   The first settings **sub-page** (SET-6). The add-on's on/off switch stays on the main Settings
   page under Add-ons ▸ Write add-ons, beside its inline-room-creation sibling; everything about
   *how* it behaves lives here, reached by the `Configure` companion on that switch's row.

   The split is about room to explain. The name template accepts four placeholders and the counter
   four scopes — a vocabulary that had been crushed into a single hover tooltip, well past the terse
   hint §11 asks for. Here the rows come with a reference under them (`_sections`), which is the whole
   point of the sub-page.

   It subclasses `SettingsPage` rather than reimplementing it: the rows, control types, revert
   contracts, and write-mode gating are the same framework, so only the registry (`_descriptors`),
   the heading (`_title`), and the reference (`_sections`) differ. See settings-page.js's header for
   the descriptor fields. Its descriptors declare no `tab`, so the page renders as one tab and the
   strip omits itself.

   These rows are UI over a server-owned vocabulary. `previews.clean_ap_name_template` /
   `clamp_ap_count_scope` / `clamp_ap_device_role` stay authoritative — a bad template is a 400 that
   reverts the field, not something checked here. */

// The AP name-counter scopes (DEV-3) — a FIXED allowlist, lockstep with the server's
// `previews.AP_COUNT_SCOPES` (a bogus value is server-clamped). 'building' counts within the
// building anchor (MODEL-3); 'site' counts across the whole NetBox **Site** — one building for a
// Site-anchored install, the whole campus for a Site = campus install, never the facility a
// siteplan covers. The scope reference below spells that out; don't relabel without changing both.
const AP_COUNT_SCOPES = [
  ['none', 'No counter'], ['room', 'Per room'], ['floor', 'Per floor'],
  ['building', 'Per building'], ['site', 'Per site / campus'],
];

// The name-template placeholders (DEV-3) — lockstep with the server's `previews.AP_NAME_PLACEHOLDERS`
// and expanded by `previews.expand_ap_name_template`; an unrecognised one is a 400, never a silent
// drop. Rendered as the page's reference, which is what the sub-page bought.
const AP_NAME_PLACEHOLDERS = [
  ['{room}', 'The room’s name, as it reads in NetBox.'],
  ['{room_slug}', 'The room’s NetBox slug — lowercase and hyphenated, where {room} may not be.'],
  ['{role_short}', 'A short code derived from the device role above.'],
  ['{asset_tag}', 'The asset tag typed when placing the access point. Left blank, the placeholder '
    + 'and one adjacent separator drop out, so the name closes up instead of trailing a stray dash.'],
];

// The counter scopes as prose, keyed by the label the `select` shows (not the stored value) so the
// reference reads as what the operator just picked. Beside AP_COUNT_SCOPES above — the two are one
// vocabulary and must not drift.
const AP_COUNT_SCOPE_NOTES = [
  ['No counter', 'Names are left exactly as the template builds them. Use it when the template '
    + 'already yields something unique, such as one carrying {asset_tag}.'],
  ['Per room', 'Counts within the room, so each room’s first access point starts at -01.'],
  ['Per floor', 'Counts across the whole floor.'],
  ['Per building', 'Counts across the whole building, restarting in each one. When a Site holds a '
    + 'single building this matches “Per site / campus”; when a Site is a campus with buildings '
    + 'modelled as Locations, the counter restarts per building.'],
  ['Per site / campus', 'Counts across the whole NetBox Site — one building when the Site is a '
    + 'single building, the entire campus when the Site groups several. Never the whole facility a '
    + 'siteplan covers.'],
];

class ApSettingsPage extends SettingsPage {
  _title() { return 'Access points'; }

  /** This page's registry. Both rows carry the same gates as the switch they sit behind on the main
   *  page: `show` on import permission (mirroring the endpoints' IMPORT_PERM gate, so a control that
   *  would only 403 is never offered) and `enabled` on write mode (the master gate). They are NOT
   *  gated on the add-on's own switch — configuring it while it is off is legitimate, and is what the
   *  one-time note invites when it points here. */
  _descriptors() {
    const app = this.app;
    return [
      {
        category: 'Access point creation',
        label: 'Device role',
        tooltip: 'The NetBox device role new access points are created with. Required — the tool stays hidden until one is picked.',
        type: 'search-select',
        // Not a `select`: a NetBox install's role list is unbounded, so options are searched
        // server-side per keystroke rather than rendered as a fixed allowlist.
        show: () => app.canImport,
        enabled: () => app.writeMode,
        get: () => app.apDeviceRole,
        load: (q) => this.app.netbox.deviceRoles(q).then((r) => r.roles || []),
        set: (opt) => this._saveApDeviceRole(opt),
      },
      {
        category: 'Access point creation',
        label: 'Name template',
        tooltip: 'Template for a new access point’s suggested name — see the placeholders below.',
        type: 'text',
        placeholder: '{room}-{role_short}',
        show: () => app.canImport,
        enabled: () => app.writeMode,
        get: () => app.apNameTemplate,
        set: (v) => this._saveApNaming(v, app.apCountScope),
        // The counter is appended by the server's naming logic per this scope — never typed into
        // the template, which is why there's no {count} placeholder. Both save together (one row,
        // one endpoint): a template only means something alongside the counter that suffixes it.
        companion: {
          label: 'Name counter',
          type: 'select',
          options: AP_COUNT_SCOPES,
          get: () => app.apCountScope,
          set: (v) => this._saveApNaming(app.apNameTemplate, v),
        },
      },
    ];
  }

  /** The reference the rows point at: what the template may contain, and how far the counter scopes
   *  before it resets. This is the content that has no home on a one-row-per-setting page — the
   *  tooltips above stay one terse line each precisely because it lives here. */
  _sections() {
    return [
      Dom.el('h3', { class: 'settings-h3' }, 'Name placeholders'),
      Dom.el('p', { class: 'hint' },
        'A name template may mix plain text with any of these. Anything else in { } is rejected '
        + 'when you save, rather than silently dropped.'),
      this._reference(AP_NAME_PLACEHOLDERS, (token) => Dom.el('code', {}, token)),
      Dom.el('h3', { class: 'settings-h3' }, 'Name counter'),
      Dom.el('p', { class: 'hint' },
        'Access points sharing a name get a -01, -02 … suffix. The scope decides what they have to '
        + 'share for the counter to see them, and so where it starts over.'),
      this._reference(AP_COUNT_SCOPE_NOTES),
    ];
  }

  /** A `<dl>` of term → explanation. `term` optionally wraps the left column (a placeholder renders
   *  as `<code>`, a scope name as plain text). */
  _reference(entries, term = (t) => t) {
    const nodes = [];
    for (const [key, text] of entries) {
      nodes.push(Dom.el('dt', {}, term(key)), Dom.el('dd', {}, text));
    }
    return Dom.el('dl', { class: 'settings-ref' }, nodes);
  }

  /** Persist which device role new access points get (DEV-3). `opt` is a `{id,name}` from the role
   *  combobox, or null to clear it (leaving the tool unconfigured, and so hidden). Updates the live
   *  `App` copy on success so a re-mount preselects it; a thrown error propagates to `Combo`, which
   *  reverts the control. */
  async _saveApDeviceRole(opt) {
    await Api.post('/api/settings/ap-device-role', { ap_device_role: opt ? opt.id : null });
    this.app.apDeviceRole = opt;
    Toast.show(opt ? 'Access point role saved.' : 'Access point role cleared.');
  }

  /** Persist the access-point name template + its counter scope (DEV-3) — one endpoint, because
   *  they are one settings row, and a template only means something alongside the counter that
   *  suffixes it. Whichever control changed sends both, so neither can clobber the other's value.
   *  Returns the **server's** stored template so `_text` can adopt it: an empty template resets to
   *  the default server-side, and the field should show that rather than stay blank. A rejected save
   *  (an unknown `{token}`, an over-long template) propagates to `_text`/`_select`, which revert. */
  async _saveApNaming(template, scope) {
    const r = await Api.post('/api/settings/ap-naming',
      { ap_name_template: template, ap_count_scope: scope });
    this.app.apNameTemplate = r.ap_name_template;
    this.app.apCountScope = r.ap_count_scope;
    Toast.show('Access point naming saved.');
    return r.ap_name_template;
  }
}
