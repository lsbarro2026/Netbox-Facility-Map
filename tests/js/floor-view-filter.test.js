'use strict';
/* floor-view-filter.test.js — the selection model behind the floor toolbar's View filter (VIEW-2).

   `FloorViewFilter.matches` is the single predicate both halves of the render read: whether a
   marker draws, and (via `visibleRoomIds`) whether the room holding it highlights. Getting the two
   from one function is what stops them disagreeing, so this is the piece worth pinning. Its
   room-level sibling `showsRoom` is here for the same reason: `_drawRoom` styles a room from it and
   `_renderStatic` decides from it which rooms may punch a hole in a container's fill (ROOM-7).

   Only the statics are covered. The popover half builds real DOM through `Dom.el`/`Popover`, and
   `visibleRoomIds`/`shows` need a constructed editor with a store behind it — both belong in a
   browser, not this tier (see README.md). `device-shapes.js` is concatenated in because `isAp`
   falls back to `DeviceShapes.typeFor`, exactly as index.html loads the pair. */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadClasses, stubWindow } = require('./load.js');

const { FloorViewFilter } = loadClasses(
  ['device-shapes.js', 'floor-view-filter.js'], ['FloorViewFilter']);

// `DeviceShapes._customRules` reads `window.MAP.roleGlyphs`; the built-in English rules are what
// the AP fallback is tested against here, which is also the shipped default.
stubWindow({ roleGlyphs: [] });

const rack = (label = 'R1') => [{ kind: 'rack', label }, { id: 1, name: label }];
/** A device placement + its cached NetBox item, keyed by role name (slug derived). */
const device = (roleName, name = 'dev-1') => [
  { kind: 'device', label: name },
  { id: 2, name, role: roleName ? { name: roleName, slug: roleName.toLowerCase().replace(/\s+/g, '-') } : null },
];

/** `matches` with no configured AP role, the common install. */
const shows = (sel, [p, item], apRoles = []) => FloorViewFilter.matches(sel, p, item, apRoles);

test('everything() shows every placement and is a fresh object each call', () => {
  const sel = FloorViewFilter.everything();
  assert.equal(sel.all, true);
  assert.equal(shows(sel, rack()), true);
  assert.equal(shows(sel, device('Switch')), true);
  assert.equal(shows(sel, device(null)), true);
  // The roles array is mutated in place by the menu, so two callers must never share one.
  const other = FloorViewFilter.everything();
  assert.notStrictEqual(sel.roles, other.roles);
});

test('all overrides every category, however the rest is set', () => {
  const sel = { all: true, racks: false, aps: false, roles: [{ name: 'Switch', slug: 'switch', on: false }] };
  assert.equal(shows(sel, rack()), true);
  assert.equal(shows(sel, device('Switch')), true);
});

test('nothing checked draws nothing at all', () => {
  const sel = { all: false, racks: false, aps: false, roles: [] };
  assert.equal(FloorViewFilter.anyOn(sel), false);
  assert.equal(shows(sel, rack()), false);
  assert.equal(shows(sel, device('Access Point')), false);
  assert.equal(shows(sel, device('Switch')), false);
});

test('racks answer only to the Racks box', () => {
  const racksOnly = { all: false, racks: true, aps: false, roles: [] };
  assert.equal(shows(racksOnly, rack()), true);
  assert.equal(shows(racksOnly, device('Access Point')), false);
  assert.equal(shows(racksOnly, device('Switch')), false);

  // A rack carries no device role, so no role category — and not the AP box — may ever claim one.
  const noRacks = { all: false, racks: false, aps: true,
    roles: [{ name: 'Rack', slug: 'rack', on: true }] };
  assert.equal(shows(noRacks, rack()), false);
});

test('racks and access points hold at the same time — the reason the filter is multi-select', () => {
  const sel = { all: false, racks: true, aps: true, roles: [] };
  assert.equal(shows(sel, rack()), true);
  assert.equal(shows(sel, device('Access Point')), true);
  assert.equal(shows(sel, device('Core Switch')), false);
});

test('access points fall back to the glyph engine, so the filter and the drawn puck agree', () => {
  const sel = { all: false, racks: false, aps: true, roles: [] };
  // Every spelling DeviceShapes.typeFor resolves to 'ap' is an access point here too.
  for (const role of ['Access Point', 'access-point', 'AccessPoint', 'WAP', 'Wireless']) {
    assert.equal(shows(sel, device(role)), true, role);
  }
  assert.equal(shows(sel, device('Patch Panel')), false);
});

test('a preset-configured AP role counts as well as the glyph verdict, never instead of it', () => {
  const sel = { all: false, racks: false, aps: true, roles: [] };
  // The roles of the install's AP-iconed presets (app.apRoles(), DEV-8) — a name saying nothing
  // the keyword rules recognize.
  const apRoles = [{ id: 7, name: 'Meraki Kit' }];
  assert.equal(shows(sel, device('Meraki Kit'), apRoles), true);
  // ...and a legacy device on a differently-named role still draws an AP puck, so it stays in.
  assert.equal(shows(sel, device('Access Point'), apRoles), true);
  assert.equal(shows(sel, device('Core Switch'), apRoles), false);
});

test('any of several preset AP roles matches, case- and whitespace-insensitively', () => {
  const sel = { all: false, racks: false, aps: true, roles: [] };
  const apRoles = [{ id: 7, name: '  Wireless Kit ' }, { id: 9, name: 'Campus Radio' }];
  assert.equal(shows(sel, device('wireless kit'), apRoles), true);
  assert.equal(shows(sel, device('Campus Radio'), apRoles), true);
  assert.equal(shows(sel, device('Core Switch'), apRoles), false);
});

test('a placement carrying an explicit ap icon counts via the glyph verdict', () => {
  // DEV-8: a preset-placed AP stores `icon: 'ap'`; typeFor honours it, so the category holds it
  // with no role bookkeeping at all.
  const sel = { all: false, racks: false, aps: true, roles: [] };
  assert.equal(FloorViewFilter.matches(
    sel, { kind: 'device', icon: 'ap', label: 'PA-01' }, null, []), true);
  assert.equal(FloorViewFilter.matches(
    sel, { kind: 'device', icon: 'speaker', label: 'PA-01' }, null, []), false);
});

test('an added role category matches on slug, then on name', () => {
  const bySlug = { all: false, racks: false, aps: false,
    roles: [{ name: 'Core Switch', slug: 'core-switch', on: true }] };
  assert.equal(shows(bySlug, device('Core Switch')), true);
  assert.equal(shows(bySlug, device('Firewall')), false);

  // A role row carrying only a name (no slug) still matches the device's role name.
  const byName = { all: false, racks: false, aps: false,
    roles: [{ name: 'Firewall', on: true }] };
  assert.equal(shows(byName, device('Firewall')), true);
});

test('an unchecked role row filters nothing', () => {
  const sel = { all: false, racks: false, aps: false,
    roles: [{ name: 'Core Switch', slug: 'core-switch', on: false }] };
  assert.equal(shows(sel, device('Core Switch')), false);
  assert.equal(FloorViewFilter.anyOn(sel), false);
});

test('a device with no role at all matches no category but All', () => {
  const sel = { all: false, racks: false, aps: false,
    roles: [{ name: 'Core Switch', slug: 'core-switch', on: true }] };
  assert.equal(shows(sel, device(null)), false);
  assert.equal(shows({ all: true }, device(null)), true);
});

test('a placement whose inventory has not landed yet still classifies off its own label', () => {
  const sel = { all: false, racks: false, aps: true, roles: [] };
  // `cacheItem` returns null until ensureInventory resolves; typeFor falls back to p.label.
  assert.equal(FloorViewFilter.matches(sel, { kind: 'device', label: 'AP 3F 12' }, null, null), true);
  assert.equal(FloorViewFilter.matches(sel, { kind: 'device', label: 'sw-3f-12' }, null, null), false);
});

test('anyOn reports whether the floor shows anything', () => {
  assert.equal(FloorViewFilter.anyOn({ all: true, racks: false, aps: false, roles: [] }), true);
  assert.equal(FloorViewFilter.anyOn({ all: false, racks: true, aps: false, roles: [] }), true);
  assert.equal(FloorViewFilter.anyOn({ all: false, racks: false, aps: true, roles: [] }), true);
  assert.equal(FloorViewFilter.anyOn({ all: false, racks: false, aps: false,
    roles: [{ name: 'x', on: true }] }), true);
  assert.equal(FloorViewFilter.anyOn({ all: false, racks: false, aps: false,
    roles: [{ name: 'x', on: false }] }), false);
  assert.equal(FloorViewFilter.anyOn(null), false);
});

// `sanitize` is the pure coercion half of persistence (VIEW-3) — `load`/`save` themselves touch
// `localStorage`, which this DOM-free tier deliberately has none of (see README.md).
test('sanitize degrades missing/corrupt input to everything()', () => {
  assert.deepEqual(FloorViewFilter.sanitize(null), FloorViewFilter.everything());
  assert.deepEqual(FloorViewFilter.sanitize(undefined), FloorViewFilter.everything());
  assert.deepEqual(FloorViewFilter.sanitize('garbage'), FloorViewFilter.everything());
  assert.deepEqual(FloorViewFilter.sanitize(42), FloorViewFilter.everything());
});

test('sanitize coerces non-boolean category fields to the defaults', () => {
  const sel = FloorViewFilter.sanitize({ all: 'yes', racks: 1, aps: 0, roles: [] });
  assert.equal(sel.all, true);   // not a boolean -> falls back to everything()'s default (true)
  assert.equal(sel.racks, true); // truthy coerced
  assert.equal(sel.aps, false);  // falsy coerced
});

test('sanitize drops a roles entry with no name and coerces the rest', () => {
  const sel = FloorViewFilter.sanitize({ all: false, racks: false, aps: false, roles: [
    { id: 1, name: 'Switch', slug: 'switch', on: 'yes' },
    { id: 2, name: '', slug: 'blank' },
    { id: 3, slug: 'no-name' },
    null,
  ] });
  assert.equal(sel.roles.length, 1);
  assert.equal(sel.roles[0].name, 'Switch');
  assert.equal(sel.roles[0].on, true);
});

test('sanitize returns a fresh roles array, never aliasing the input', () => {
  const roles = [{ name: 'Switch', on: true }];
  const sel = FloorViewFilter.sanitize({ all: false, racks: false, aps: false, roles });
  assert.notStrictEqual(sel.roles, roles);
});

// ---- showsRoom: which rooms draw as visible shapes (and so may punch a container's fill) ----

/** The selection that hides everything not explicitly matched — `all` off, no category on. */
const NOTHING = { all: false, racks: false, aps: false, roles: [] };
/** `showsRoom` against a room that is plain and unfiltered unless the case says otherwise. */
const drawsRoom = (sel, over = {}) => FloorViewFilter.showsRoom(
  sel, { editing: false, racks: false, focused: false, placed: false, ...over });

test('showsRoom draws every room in edit and in the racks sub-mode', () => {
  // Geometry can't be reshaped, and a rack can't be placed into, a room that isn't drawn — so
  // neither mode consults the filter at all. This is also what keeps the ROOM-2 punch-out
  // unchanged there: every room paints, so every contained room is still punched out.
  assert.equal(drawsRoom(NOTHING, { editing: true }), true);
  assert.equal(drawsRoom(NOTHING, { racks: true }), true);
});

test('showsRoom draws every room in view mode when `all` is checked (the default)', () => {
  assert.equal(drawsRoom(FloorViewFilter.everything()), true);
});

test('showsRoom hides an unmatched room in view mode, drawing only the ones holding a marker', () => {
  // `placed` is the room-level half `visibleRoomIds` computes: the room holds a marker the filter
  // still draws. Everything else falls back to an invisible click-zone — and, per ROOM-7, stops
  // punching a hole in whatever room contains it, which would leave a gap shaped like a room the
  // user asked not to see.
  assert.equal(drawsRoom(NOTHING), false);
  assert.equal(drawsRoom(NOTHING, { placed: true }), true);
});

test('showsRoom always draws the focus target, whatever is filtered out', () => {
  // A search jump / `#/r/` deep-link has to land on a room the user can see (VIEW-2).
  assert.equal(drawsRoom(NOTHING, { focused: true }), true);
});

test('showsRoom treats a missing selection as hiding, never as a crash', () => {
  assert.equal(drawsRoom(null), false);
  assert.equal(drawsRoom(undefined, { placed: true }), true);
});
