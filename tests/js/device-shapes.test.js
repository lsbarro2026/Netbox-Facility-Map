'use strict';
/* device-shapes.test.js — the JS half of the DeviceShapes lockstep.

   `device_shapes.py` is a hand-maintained 1:1 mirror of this class (no build step, so the rules
   are duplicated rather than shared). Until now that mirror was only ever checked from the Python
   side, which catches a Python-side drift but not a JS-side one. Both sides now run the SAME
   corpus — fixtures/device-glyph-cases.json — so an edit to either file that is not mirrored fails
   on whichever side drifted.

   `glyph()` is deliberately absent: it builds real SVG elements through `Dom.svg`, so it needs a
   document and belongs in a browser, not this tier. The Python mirror covers the glyph geometry. */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadClasses, stubWindow } = require('./load.js');
const cases = require('./fixtures/device-glyph-cases.json');

const { DeviceShapes } = loadClasses(['device-shapes.js'], ['DeviceShapes']);

// `_customRules` reads `window.MAP.roleGlyphs`. The shared corpus covers the BUILT-IN English
// rules, so the vocabulary stays empty here — which is also the shipped default.
stubWindow({ roleGlyphs: [] });

/** Split a shape-neutral corpus case into this port's `(placement, item)` argument pair.
 *  Python's mirror reads flat `role_slug`/`role_name`/`name`; the JS reads a nested `role` object
 *  and a sibling `name`. Same facts, two shapes — the corpus stores the facts. */
function argsFor(c) {
  const placement = { kind: c.kind || 'device' };
  if (c.label !== undefined) placement.label = c.label;

  const role = {};
  if (c.role_slug !== undefined) role.slug = c.role_slug;
  if (c.role_name !== undefined) role.name = c.role_name;
  const item = {};
  if (Object.keys(role).length) item.role = role;
  if (c.name !== undefined) item.name = c.name;

  return [placement, Object.keys(item).length ? item : null];
}

/** A readable label for a corpus case, so a failure names the input rather than an index. */
const label = (c) => JSON.stringify(
  Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'note' && k !== 'want')));

// ---- the shared corpus ----

test('shared corpus: typeFor classifies every case as the corpus says', () => {
  const failures = [];
  for (const c of cases.typeFor) {
    const got = DeviceShapes.typeFor(...argsFor(c));
    if (got !== c.want)
      failures.push(`  ${label(c)}\n      want ${c.want}, got ${got}`
        + (c.note ? `\n      (${c.note})` : ''));
  }
  assert.strictEqual(failures.length, 0,
    `${failures.length} shared-corpus case(s) failed on the JS side.\n`
    + `If the Python mirror passes these, device-shapes.js has drifted out of lockstep.\n`
    + failures.join('\n'));
});

test('shared corpus: box returns the footprint the corpus records', () => {
  for (const c of cases.box)
    assert.deepStrictEqual(DeviceShapes.box(c.type), { w: c.w, h: c.h }, c.type);
});

test('shared corpus: _normalize folds a haystack as the corpus says', () => {
  for (const c of cases.normalize) {
    const [placement, item] = argsFor(c);
    assert.strictEqual(DeviceShapes._normalize(placement, item), c.want, label(c));
  }
});

// ---- properties the corpus cannot state ----

test('the rack is the reference footprint and every device is narrower', () => {
  // The cohesion invariant: a lone device must never out-size a cabinet.
  const rackW = DeviceShapes.box('rack').w;
  for (const c of cases.box)
    if (c.type !== 'rack') assert.ok(c.w < rackW, `${c.type} (${c.w}) should be < ${rackW}`);
});

test('every type the corpus classifies to has a footprint', () => {
  // A rule that resolves to a type `box()` does not know about would silently draw at the
  // generic fallback size.
  const boxed = new Set(cases.box.map(c => c.type));
  for (const c of cases.typeFor)
    assert.ok(boxed.has(c.want), `type "${c.want}" is classified to but has no box() case`);
});

// ---- role_glyphs: the operator's own vocabulary (INTL-1) ----

test('role_glyphs are tried before the built-in rules', () => {
  // Custom rules win, so an operator can override a built-in classification: 'panel' normally
  // resolves to patchpanel.
  stubWindow({ roleGlyphs: [['outlet', ['panel']]] });
  assert.strictEqual(DeviceShapes.typeFor({ kind: 'device', label: 'Panel' }), 'outlet');
  stubWindow({ roleGlyphs: [] });
});

test('role_glyphs merge with the English rules rather than replacing them', () => {
  stubWindow({ roleGlyphs: [['switch', ['commutateur']]] });
  assert.strictEqual(DeviceShapes.typeFor({ kind: 'device' }, { role: { name: 'Commutateur' } }), 'switch');
  assert.strictEqual(DeviceShapes.typeFor({ kind: 'device', label: 'Core Switch' }), 'switch');
  assert.strictEqual(DeviceShapes.typeFor({ kind: 'device', label: 'AP-01' }), 'ap');
  stubWindow({ roleGlyphs: [] });
});

test('a role_glyphs keyword matches whole words only', () => {
  // Same boundary semantics as the built-in `\bap\b` tokens — a keyword never fires mid-word.
  stubWindow({ roleGlyphs: [['switch', ['sw']]] });
  assert.strictEqual(DeviceShapes.typeFor({ kind: 'device', label: 'SW 3' }), 'switch');
  assert.strictEqual(DeviceShapes.typeFor({ kind: 'device', label: 'Sweater' }), 'generic');
  stubWindow({ roleGlyphs: [] });
});

test('role_glyphs never override a rack', () => {
  stubWindow({ roleGlyphs: [['ap', ['armoire']]] });
  assert.strictEqual(DeviceShapes.typeFor({ kind: 'rack', label: 'Armoire 3' }), 'rack');
  stubWindow({ roleGlyphs: [] });
});

test('an absent window.MAP degrades to the built-in rules', () => {
  // A non-plugin page injects nothing; classification must still work.
  stubWindow(undefined);
  assert.strictEqual(DeviceShapes.typeFor({ kind: 'device', label: 'Core Switch' }), 'switch');
  stubWindow({ roleGlyphs: [] });
});

// ---- _matches ----

test('_matches treats a normalized keyword as a whole word or phrase', () => {
  assert.ok(DeviceShapes._matches('access point 01', 'access point'));
  assert.ok(DeviceShapes._matches('ap 1', 'ap'));
  assert.ok(!DeviceShapes._matches('kneecap', 'ap'));
  assert.ok(!DeviceShapes._matches('punto final', 'punto de acceso'));
});
