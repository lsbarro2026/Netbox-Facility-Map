'use strict';
/* device-shapes.js — DeviceShapes: schematic, instantly-recognizable glyphs for the
   rack/device markers placed inside rooms. Pure static (no instances, no
   state), in the spirit of Icons/Geom in lib.js; depends only on Dom.svg.

   LOCKSTEP with the server-side port `netbox_facilitymap/device_shapes.py`, which draws these
   same glyphs into the NetBox-page embeds/exports (there is no build step, so the logic is
   duplicated, not shared). The keyword rules (typeFor), per-type footprints (box) and glyph
   geometry (glyph) must stay identical in both files, or an embed and the live map disagree —
   a change here must be mirrored there and vice-versa.

   Every glyph is drawn CENTERED AT THE ORIGIN and sized to a wpx×hpx box — the marker
   <g> in FloorEditor._drawPlacement already carries `translate(centre) rotate(rot)`, so
   shapes need no transform of their own. Primitives are classed (`dev-body` body,
   `dev-line` rails/dividers, `dev-port` ports/outlets, `dev-led` indicator dots) so
   style.css owns the paint and the non-scaling-stroke (zoom-constant) behaviour. */

/* The glyph types that predate the icon library (DEV-8): rendered by their own bespoke
   schematic branches (or the `_lucide` chip table) in `glyph()`. Their library entries below
   carry `paths` for the settings picker ONLY — `_chipPaths` never chip-renders one of these,
   so their markers keep drawing exactly as they always have. Lockstep with the Python
   `_BUILTIN_GLYPH_TYPES`. */
const BUILTIN_GLYPH_TYPES = new Set([
  'rack', 'server', 'router', 'firewall', 'storage', 'ups',
  'switch', 'accessswitch', 'patchpanel', 'pdu', 'outlet', 'ap', 'generic',
]);

/* The admin-pickable device icon library (DEV-8): every glyph type a device-type preset may
   choose, grouped for the settings picker. Each entry is {id, label, paths} — `id` doubles as
   the glyph type a placement's explicit `icon` stores, `paths` are stroke path `d` strings on
   Lucide's native 24×24 viewBox (round-cap, stroke-width 2). Entries WITHOUT `paths` are the
   pre-existing `_lucide` chip types, whose icon the picker reads from that table instead.

   LOCKSTEP with the Python `_LIBRARY` (device_shapes.py) — ids, order, and path data must stay
   identical, or the map and the server-rendered embeds draw a preset's marker differently.
   Lucide-sourced paths are inlined verbatim from the vendored SVGs under `icons/` (see
   icons/NOTICE for the id→source-file map); the rest are bespoke drawings in the same 24×24
   stroke convention. `rack` is deliberately absent — the tool places devices, not racks. */
const DEVICE_ICON_LIBRARY = [
  { group: 'Network', icons: [
    { id: 'ap', label: 'Wireless access point', paths: [
      'M12 20h.01', 'M2 8.82a15 15 0 0 1 20 0', 'M5 12.859a10 10 0 0 1 14 0',
      'M8.5 16.429a5 5 0 0 1 7 0'] },
    { id: 'switch', label: 'Switch', paths: [
      'M4 7h16a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z',
      'M6 12h.01', 'M10 12h.01', 'M14 12h.01', 'M18 12h.01'] },
    { id: 'accessswitch', label: 'Access switch', paths: [
      'M4 7h16a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z',
      'M6 13h.01', 'M10 13h.01', 'M14 13h.01', 'M18 10h.01'] },
    { id: 'patchpanel', label: 'Patch panel', paths: [
      'M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
      'M7 10h.01', 'M12 10h.01', 'M17 10h.01', 'M7 14h.01', 'M12 14h.01', 'M17 14h.01'] },
    { id: 'router', label: 'Router' },
    { id: 'firewall', label: 'Firewall' },
    { id: 'server', label: 'Server' },
    { id: 'storage', label: 'Storage' },
    { id: 'ups', label: 'UPS' },
    { id: 'pdu', label: 'PDU / power strip', paths: [
      'M3.5 9h17a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 13.5v-3A1.5 1.5 0 0 1 3.5 9z',
      'M6 12h.01', 'M10 12h.01', 'M14 12h.01', 'M18 12h.01'] },
    { id: 'outlet', label: 'Power outlet', paths: [
      'M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
      'M10 9v3', 'M14 9v3', 'M12 16h.01'] },
    { id: 'jack', label: 'Network jack', paths: [
      'M10 8v1', 'M14 8v1', 'M18 8v1',
      'M19 17a2 2 0 00-1.765 1.059l-.47.882A2 2 0 0115 20H9a2 2 0 01-1.765-1.059l-.47-.882A2 2 0 005 17H4a2 2 0 01-2-2V6a2 2 0 012-2h16a2 2 0 012 2v9a2 2 0 01-2 2z',
      'M6 8v1'] },
    { id: 'antenna', label: 'Antenna / DAS', paths: [
      'M2 12 7 2', 'm7 12 5-10', 'm12 12 5-10', 'm17 12 5-10', 'M4.5 7h15', 'M12 16v6'] },
    { id: 'beacon', label: 'BLE beacon', paths: ['m7 7 10 10-5 5V2l5 5L7 17'] },
  ] },
  { group: 'AV', icons: [
    { id: 'speaker', label: 'Speaker / PA', paths: [
      'M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z',
      'M16 9a5 5 0 0 1 0 6', 'M19.364 18.364a9 9 0 0 0 0-12.728'] },
    { id: 'mic', label: 'Microphone', paths: [
      'M12 19v3', 'M19 10v2a7 7 0 0 1-14 0v-2',
      'M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z'] },
    { id: 'intercom', label: 'Intercom / call box', paths: [
      'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z',
      'M9 7h6', 'M9 10h6', 'M10.5 16a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0'] },
    { id: 'projector', label: 'Projector', paths: [
      'M5 7 3 5', 'M9 6V3', 'm13 7 2-2', 'M6 13a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
      'M11.83 12H20a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h2.17',
      'M16 16h2'] },
    { id: 'display', label: 'Display / TV', paths: [
      'm17 2-5 5-5-5',
      'M4 7h16a2 2 0 0 1 2 2v11a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2z'] },
    { id: 'signage', label: 'Digital signage', paths: [
      'M2 3h20', 'M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3', 'm7 21 5-5 5 5'] },
    { id: 'whiteboard', label: 'Interactive whiteboard', paths: [
      'M4 3h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
      'M6 10c2-3 4 3 6 0s4-3 6 0', 'm7 21 2-5', 'm17 21-2-5'] },
    { id: 'deskphone', label: 'Desk phone', paths: [
      'M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384'] },
  ] },
  { group: 'Safety & security', icons: [
    { id: 'camera-dome', label: 'Camera (dome)', paths: [
      'M3 5h18', 'M6 5a6 6 0 0 0 12 0', 'M10.5 8a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0'] },
    { id: 'camera-bullet', label: 'Camera (bullet)', paths: [
      'M16.75 12h3.632a1 1 0 0 1 .894 1.447l-2.034 4.069a1 1 0 0 1-1.708.134l-2.124-2.97',
      'M17.106 9.053a1 1 0 0 1 .447 1.341l-3.106 6.211a1 1 0 0 1-1.342.447L3.61 12.3a2.92 2.92 0 0 1-1.3-3.91L3.69 5.6a2.92 2.92 0 0 1 3.92-1.3z',
      'M2 19h3.76a2 2 0 0 0 1.8-1.1L9 15', 'M2 21v-4', 'M7 9h.01'] },
    { id: 'card-reader', label: 'Card reader', paths: [
      'M9 2h6a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z',
      'M10 7h4', 'M12 11h.01', 'M10.5 15h.01', 'M13.5 15h.01'] },
    { id: 'door-strike', label: 'Door strike', paths: [
      'M10 12h.01', 'M18 20V6a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v14', 'M2 20h20'] },
    { id: 'motion-sensor', label: 'Motion / occupancy sensor', paths: [
      'M19.07 4.93A10 10 0 0 0 6.99 3.34', 'M4 6h.01', 'M2.29 9.62A10 10 0 1 0 21.31 8.35',
      'M16.24 7.76A6 6 0 1 0 8.23 16.67', 'M12 18h.01', 'M17.99 11.66A6 6 0 0 1 15.77 16.67',
      'M10 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'm13.41 10.59 5.66-5.66'] },
    { id: 'smoke-detector', label: 'Smoke detector', paths: [
      'M11 21c0-2.5 2-2.5 2-5', 'M16 21c0-2.5 2-2.5 2-5',
      'm19 8-.8 3a1.25 1.25 0 0 1-1.2 1H7a1.25 1.25 0 0 1-1.2-1L5 8',
      'M21 3a1 1 0 0 1 1 1v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a1 1 0 0 1 1-1z',
      'M6 21c0-2.5 2-2.5 2-5'] },
    { id: 'pull-station', label: 'Fire-alarm pull station', paths: [
      'M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
      'M9 8h6a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z', 'M12 13v5'] },
    { id: 'fire-strobe', label: 'Fire strobe / horn', paths: [
      'M7 18v-6a5 5 0 1 1 10 0v6',
      'M5 21a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2z',
      'M21 12h1', 'M18.5 4.5 18 5', 'M2 12h1', 'M12 2v1', 'm4.929 4.929.707.707', 'M12 12v6'] },
    { id: 'emergency-phone', label: 'Emergency phone', paths: [
      'M13 2a9 9 0 0 1 9 9', 'M13 6a5 5 0 0 1 5 5',
      'M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384'] },
    { id: 'aed', label: 'AED cabinet', paths: [
      'M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5',
      'M3.22 13H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27'] },
    { id: 'leak-sensor', label: 'Water / leak sensor', paths: [
      'M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z'] },
  ] },
  { group: 'Building & facilities', icons: [
    { id: 'clock', label: 'Clock', paths: [
      'M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0', 'M12 6v6l4 2'] },
    { id: 'time-clock', label: 'Time clock', paths: [
      'M4 13a8 8 0 1 0 16 0a8 8 0 1 0 -16 0', 'M12 9v4l2 2', 'M5 3 2 6', 'm22 6-3-3',
      'M6.38 18.7 4 21', 'M17.64 18.67 20 21'] },
    { id: 'thermostat', label: 'Thermostat', paths: [
      'M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z'] },
    { id: 'hvac', label: 'HVAC unit', paths: [
      'M10.827 16.379a6.082 6.082 0 0 1-8.618-7.002l5.412 1.45a6.082 6.082 0 0 1 7.002-8.618l-1.45 5.412a6.082 6.082 0 0 1 8.618 7.002l-5.412-1.45a6.082 6.082 0 0 1-7.002 8.618l1.45-5.412Z',
      'M12 12v.01'] },
    { id: 'light', label: 'Light fixture', paths: [
      'M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5',
      'M9 18h6', 'M10 22h4'] },
    { id: 'light-control', label: 'Lighting controller', paths: [
      'M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0', 'M12 4h.01', 'M20 12h.01', 'M12 20h.01',
      'M4 12h.01', 'M17.657 6.343h.01', 'M17.657 17.657h.01', 'M6.343 17.657h.01',
      'M6.343 6.343h.01'] },
    { id: 'electric-panel', label: 'Electrical panel', paths: [
      'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z',
      'm13 6.5-3 5h4l-3 5'] },
    { id: 'generator', label: 'Generator', paths: [
      'M4 8h16a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z',
      'm11 9.5-2 3.5h4l-2 3.5', 'M16 11v4', 'M19 11v4', 'M6 21v-3', 'M18 21v-3'] },
    { id: 'env-sensor', label: 'Environmental sensor', paths: [
      'm12 14 4-4', 'M3.34 19a10 10 0 1 1 17.32 0'] },
    { id: 'printer', label: 'Printer / MFP', paths: [
      'M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2',
      'M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6',
      'M7 14h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z'] },
    { id: 'kiosk', label: 'Kiosk', paths: [
      'M8 2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z',
      'M12 11v10', 'M8 21h8'] },
  ] },
  { group: 'Other', icons: [
    { id: 'generic', label: 'Generic device', paths: [
      'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
      'M12 12h.01'] },
  ] },
];

class DeviceShapes {
  /** Resolve a placement to a glyph type. Racks are always 'rack'. A placement carrying an
   *  explicit `icon` (stamped by the Add-device tool from its preset, DEV-8) resolves to that
   *  icon outright — the admin chose the glyph, so no keyword rule may second-guess it (an
   *  unknown/stale icon id falls through to inference). Everything else is keyed off its NetBox
   *  role (slug/name), then its own name, then the marker label, by case-insensitive keyword
   *  over a *normalized* haystack (`_normalize` folds camelCase and separators to spaces) — so
   *  'AccessPoint', 'access-point', 'ACCESS POINT' and 'ap' all resolve alike. Still works when
   *  the role is unset (name/label fallback) and survives unknown role slugs. Returns one of
   *  the keys in `box()`/`glyph()`.
   *
   *  The operator's `role_glyphs` keywords (window.MAP.roleGlyphs, validated server-side by
   *  `device_shapes.custom_rules`) are tried BEFORE the built-in English rules, so a facility that
   *  names its roles in another language keeps working without losing the defaults — merge, not
   *  replace (INTL-1). An install that sets nothing behaves exactly as before. */
  static typeFor(p, item) {
    if (p.kind === 'rack') return 'rack';
    if (p.icon && DeviceShapes.isType(p.icon)) return p.icon;
    const hay = DeviceShapes._normalize(p, item);
    for (const [type, keywords] of DeviceShapes._customRules())
      if (keywords.some(k => DeviceShapes._matches(hay, k))) return type;
    const rules = [
      [/fire ?wall|\bfw\b/,                       'firewall'],
      [/patch|panel/,                             'patchpanel'],
      // Access/edge switch before the generic switch rule so "access switch" wins over the
      // broad `switch` catch-all; can't collide with the `ap` rule (which requires "point").
      [/access ?switch|\basw\b/,                  'accessswitch'],
      [/switch|leaf|spine|\btor\b/,               'switch'],
      [/rout|gateway|\bgw\b/,                     'router'],
      // No existing keyword is a standalone "ap" token, so this can't shadow or be
      // shadowed by another rule; placed ahead of the broad server/storage catch-alls
      // (host, node, disk, array, filer) so e.g. "Wireless Host Controller" resolves here.
      [/wifi|wireless|access ?point|\bap\b|\bwap\b/, 'ap'],
      [/ups|battery/,                             'ups'],
      // Wall outlet/receptacle before pdu, and pdu no longer claims a bare "outlet": a single
      // wall socket reads as `outlet`, a power strip / distribution unit as `pdu`.
      [/wall ?outlet|\boutlet\b|socket|receptacle/, 'outlet'],
      [/pdu|power|\brpp\b|busway/,                'pdu'],
      [/storage|disk|\bnas\b|\bsan\b|array|filer/, 'storage'],
      [/server|host|compute|blade|node|hypervisor|esxi/, 'server'],
    ];
    for (const [re, t] of rules) if (re.test(hay)) return t;
    return 'generic';
  }

  /** The library index, `id -> entry`, memoized on first use (the library is a module
   *  constant, so the memo can never go stale). Mirrors the Python `_LIB_INDEX`. */
  static _libIndex() {
    if (!DeviceShapes._libIdx) {
      DeviceShapes._libIdx = new Map();
      for (const g of DEVICE_ICON_LIBRARY)
        for (const icon of g.icons) DeviceShapes._libIdx.set(icon.id, icon);
    }
    return DeviceShapes._libIdx;
  }

  /** Whether `t` names a known glyph type — a library id or the rack. The JS spelling of the
   *  Python `GLYPH_TYPES` membership test, and what `typeFor` vets an explicit placement `icon`
   *  against (a stale id from a since-changed library must fall back to inference, not draw
   *  nothing). */
  static isType(t) {
    return t === 'rack' || DeviceShapes._libIndex().has(t);
  }

  /** The stroke paths `glyph()` chip-renders for a library type, or undefined for the built-in
   *  types (whose bespoke schematic/`_lucide` branches must keep winning — their library `paths`
   *  serve only the settings picker). Mirrors the Python `_chip_paths`. */
  static _chipPaths(type) {
    if (BUILTIN_GLYPH_TYPES.has(type)) return undefined;
    const entry = DeviceShapes._libIndex().get(type);
    return entry && entry.paths;
  }

  /** A library icon as an inline `<svg>` HTML string for chrome (the preset picker and the
   *  Add-device dropdown), drawn with `currentColor` exactly like `Icons._ico`. Falls back to
   *  the `_lucide` table for the chip types whose entries carry no `paths`; '' for an unknown
   *  id, so a stale preset renders labelless-iconless rather than crashing the toolbar.
   *  Deliberately JS-only (no Python mirror): the lockstep contract covers marker GEOMETRY —
   *  `typeFor`/`box`/`glyph` — and this is pure browser chrome, like `_customRules` reading
   *  `window.MAP`. */
  static iconSvg(id, size = 13) {
    const entry = DeviceShapes._libIndex().get(id);
    const paths = (entry && entry.paths) || DeviceShapes._lucide(id);
    if (!paths) return '';
    return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" `
      + `fill="none" stroke="currentColor" stroke-width="2" `
      + `stroke-linecap="round" stroke-linejoin="round">`
      + paths.map((d) => `<path d="${d}"/>`).join('') + '</svg>';
  }

  /** The operator's validated `role_glyphs` vocabulary as ordered [type, [keyword, …]] pairs.
   *  Validation/normalization happens ONCE, server-side (`device_shapes.custom_rules`), and rides
   *  `window.MAP.roleGlyphs` — so the lockstep pair can't disagree about what the setting means.
   *  Empty on a non-plugin page or an install that configures nothing, which is the built-in
   *  English behaviour. Mirrors the Python `custom_rules`. */
  static _customRules() {
    return (window.MAP && window.MAP.roleGlyphs) || [];
  }

  /** Whether an already-normalized `keyword` appears in the normalized `hay` as a whole word (or
   *  whole phrase). Both are runs of unicode letters/digits joined by single spaces, so padding
   *  each with a space makes plain containment an exact word-boundary test — no RegExp, and so no
   *  JS/Python dialect divergence in the lockstep pair. Mirrors the Python `_matches`. */
  static _matches(hay, keyword) {
    return ` ${hay} `.includes(` ${keyword} `);
  }

  /** Normalize the role/name/label haystack for keyword matching: join the parts, split
   *  camelCase (`AccessPoint` → `Access Point`), lowercase, then fold every non-alphanumeric
   *  run (hyphen, underscore, dot, slash, extra spaces) to a single space. So 'AccessPoint',
   *  'access-point' and 'ACCESS_POINT' all collapse to 'access point' and match one rule —
   *  the tolerance real-world NetBox role names need.
   *
   *  The fold keeps UNICODE letters/digits (`\p{L}\p{N}`). It used to be `[^a-z0-9]+`, which
   *  deleted every non-ASCII character outright — a Japanese/Greek/Cyrillic role name normalized
   *  to the empty string and could never match any rule, custom or built-in (INTL-1). The camelCase
   *  split stays deliberately ASCII (a Latin-script convention), as does the Python mirror. */
  static _normalize(p, item) {
    const role = (item && item.role) || {};
    return [role.slug, role.name, item && item.name, p && p.label]
      .filter(Boolean).join(' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  /** Default footprint (display px) per type, sized as one cohesive set so every object reads
   *  at a sensible relative scale. The **rack is the reference and the largest** (a full
   *  cabinet, 30px wide); every unracked device is narrower than it, so a lone device never
   *  out-sizes a cabinet. Two families: icon-bearing *appliances* (server/router/firewall/
   *  storage/ups) are compact square-ish chips holding a Lucide glyph; rack-mount *strips*
   *  (switch/accessswitch/patchpanel/pdu) are wide and thin; the wall `outlet` is the smallest,
   *  a thin slice; `ap` a small puck; a UPS a chunky box that reads bigger than a thin PDU.
   *  Library chip types (DEV-8) share one compact square footprint, sized between the wall
   *  outlet and the appliance chips. Used when a placement has no user-set w/h. */
  static box(type) {
    return ({
      rack:         { w: 30, h: 40 },
      server:       { w: 22, h: 18 },
      router:       { w: 20, h: 18 },
      firewall:     { w: 20, h: 18 },
      storage:      { w: 22, h: 18 },
      ups:          { w: 16, h: 20 },
      switch:       { w: 26, h: 10 },
      accessswitch: { w: 24, h: 10 },
      patchpanel:   { w: 26, h: 12 },
      pdu:          { w: 24, h: 8 },
      outlet:       { w: 12, h: 7 },
      ap:           { w: 16, h: 16 },
      generic:      { w: 22, h: 15 },
    })[type] || (DeviceShapes._chipPaths(type) ? { w: 18, h: 18 } : { w: 22, h: 15 });
  }

  /** The vendored Lucide icon for a device type that maps cleanly to one — an array of path
   *  `d` strings on Lucide's native 24×24 viewBox (server, router, firewall = brick-wall-shield,
   *  storage = hard-drive, ups = battery-charging). `undefined` for types drawn as bespoke
   *  schematics (rack/switch/accessswitch/ap/pdu/outlet/patchpanel/generic), where a
   *  purpose-built glyph reads better than any Lucide icon. Lockstep with the Python mirror and
   *  the vendored SVGs under `icons/` (see this file's header). */
  static _lucide(type) {
    return ({
      server:   ['M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z',
                 'M4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z',
                 'M6 6h.01', 'M6 18h.01'],
      router:   ['M4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z',
                 'M6.01 18H6', 'M10.01 18H10', 'M15 10v4',
                 'M17.84 7.17a4 4 0 0 0-5.66 0', 'M20.66 4.34a8 8 0 0 0-11.31 0'],
      firewall: ['M12 9v1.258', 'M16 3v5.46',
                 'M21 9.118V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5.75',
                 'M22 17.5c0 2.499-1.75 3.749-3.83 4.474a.5.5 0 0 1-.335-.005c-2.085-.72-3.835-1.97-3.835-4.47V14a.5.5 0 0 1 .5-.499c1 0 2.25-.6 3.12-1.36a.6.6 0 0 1 .76-.001c.875.765 2.12 1.36 3.12 1.36a.5.5 0 0 1 .5.5z',
                 'M3 15h7', 'M3 9h12.142', 'M8 15v6', 'M8 3v6'],
      storage:  ['M10 16h.01',
                 'M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
                 'M21.946 12.013H2.054', 'M6 16h.01'],
      ups:      ['m11 7-3 5h4l-3 5', 'M14.856 6H16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.935',
                 'M22 14v-4', 'M5.14 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2.936'],
    })[type];
  }

  /** Build the glyph for a type as an array of SVG children, centered at origin and
   *  filling a wpx×hpx box. Caller appends them to the (already transformed) marker. */
  static glyph(type, wpx, hpx) {
    const hw = wpx / 2, hh = hpx / 2;
    const R = (x, y, w, h, c = 'dev-body') => Dom.svg('rect', { x, y, width: w, height: h, rx: 2, class: c });
    const C = (cx, cy, r, c = 'dev-line') => Dom.svg('circle', { cx, cy, r, class: c });
    const P = (d, c = 'dev-line', t) => Dom.svg('path', t ? { d, fill: 'none', class: c, transform: t } : { d, fill: 'none', class: c });
    const body = () => R(-hw, -hh, wpx, hpx);
    const els = [];

    // Appliance roles with a clean Lucide match, and the library chip types (DEV-8): the body
    // chip + the icon, uniformly scaled to fit the smaller box dimension and centred (the icons
    // share Lucide's 24×24 viewBox, centre 12,12).
    const icon = DeviceShapes._lucide(type) || DeviceShapes._chipPaths(type);
    if (icon) {
      els.push(body());
      const s = Math.min(wpx, hpx) * 0.82 / 24, off = (-12 * s).toFixed(3);
      const tf = `translate(${off},${off}) scale(${s.toFixed(4)})`;
      for (const d of icon) els.push(P(d, 'dev-line', tf));
      return els;
    }

    switch (type) {
      case 'rack': {                       // plain cabinet box — its name rides inside it
        els.push(body());
        break;
      }
      case 'switch': {                     // core/aggregation switch: one dense row of ports
        els.push(body());
        const n = Math.max(3, Math.floor((wpx - 6) / 7)), gap = (wpx - 6) / n, pw = Math.min(5, gap - 2);
        for (let i = 0; i < n; i++) els.push(R(-hw + 4 + i * gap, -3, pw, 6, 'dev-port'));
        break;
      }
      case 'accessswitch': {               // access/edge switch: dense access-port row + uplink
        els.push(body());
        const n = Math.max(4, Math.floor((wpx - 6) / 5)), gap = (wpx - 6) / n, pw = Math.min(3.5, gap - 1.5);
        for (let i = 0; i < n; i++) els.push(R(-hw + 4 + i * gap, hh - 4.5, pw, 3, 'dev-port'));
        els.push(R(hw - 6, -hh + 2, 4, 2.5, 'dev-port'));   // separated uplink SFP, top-right
        break;
      }
      case 'ap': {                         // ceiling-mount puck + concentric broadcast rings;
                                            // fully radial (not a one-sided cone) so it reads
                                            // the same at any placement rotation
        const r = Math.min(hw, hh);
        els.push(C(0, 0, r * 0.3, 'dev-body'));
        for (const f of [0.55, 0.8, 1.0]) els.push(C(0, 0, r * f));
        break;
      }
      case 'pdu': {                        // power strip: row of round outlets
        els.push(body());
        const n = Math.max(3, Math.floor((wpx - 6) / 9)), gap = (wpx - 6) / n, r = Math.min(gap * 0.3, hh * 0.5);
        for (let i = 0; i < n; i++) els.push(C(-hw + 4 + gap * (i + 0.5), 0, r, 'dev-port'));
        break;
      }
      case 'outlet': {                     // top-down wall receptacle: a thin faceplate + two slots
        els.push(body());
        for (const x of [-2.2, 2.2]) els.push(R(x - 0.6, -1.6, 1.2, 3.2, 'dev-port'));
        break;
      }
      case 'patchpanel': {                 // two dense rows of ports
        els.push(body());
        const n = Math.max(6, Math.floor((wpx - 6) / 6)), gap = (wpx - 6) / n, pw = Math.min(4, gap - 1);
        for (const y of [-hh + 3, hh - 6]) for (let i = 0; i < n; i++) els.push(R(-hw + 4 + i * gap, y, pw, 3, 'dev-port'));
        break;
      }
      default:                             // generic device: a box with a centre dot
        els.push(body(), C(0, 0, 1.6, 'dev-port'));
    }
    return els;
  }
}
