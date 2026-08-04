'use strict';
/* import-cards.test.js — ImportCards' boundary validation for a building's name/slug.

   ImportCards is overwhelmingly a renderer (cards, thumbnails, floor buttons) and that belongs in a
   browser, out of this tier by design. `_buildingFieldError` is the exception: it is pure decision,
   it needs nothing but a `_floorBuildings()` list off its wizard back-ref, and it is the check that
   IMPORT-28 got wrong — it rejected every building of a correct campus import as a duplicate.

   What these fixtures pin down is that the inline warning is **exactly** `_buildMap`'s anchor guard
   and never stricter. Being stricter is not a cosmetic bug: it tells an operator whose upload is
   fine to go and "fix" slugs that were already right. */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadClasses } = require('./load.js');

// import-cards.js reads `ImportFlow.anchorKey`, so the flow rides along in dependency order —
// exactly as index.html loads them.
const { ImportFlow, ImportCards } =
  loadClasses(['import-flow.js', 'import-cards.js'], ['ImportFlow', 'ImportCards']);

/** A floor-contributing building, in the shape `_modelFromInventory` builds. */
function building(over) {
  return Object.assign({
    folder: 'Admin', name: 'Administration', slug: 'administration',
    nbSite: null, nbBuilding: null, pdfs: [], assign: {}, regions: {},
  }, over);
}

/** ImportCards over a stub wizard whose `_floorBuildings()` is the given list — the only thing
 *  `_buildingFieldError` reaches through the back-ref. */
function cards(buildings) {
  return new ImportCards({ _floorBuildings: () => buildings });
}

// ---- anchorKey: the identity both guards key off ----

test('anchorKey is the site slug alone for a Site anchor', () => {
  const b = building({ nbSite: { slug: 'administration', name: 'Administration' } });
  assert.strictEqual(ImportFlow.anchorKey(b), 'administration');
});

test('anchorKey is site/building for a Location anchor', () => {
  const b = building({
    slug: 'north-campus',
    nbSite: { slug: 'north-campus', name: 'North Campus' },
    nbBuilding: { slug: 'admin-bldg', name: 'Administration Building' },
  });
  assert.strictEqual(ImportFlow.anchorKey(b), 'north-campus/admin-bldg');
});

test('anchorKey is empty for a building with no slug, so the empty-slug guard owns that case', () => {
  assert.strictEqual(ImportFlow.anchorKey(building({ slug: '' })), '');
  assert.strictEqual(ImportFlow.anchorKey(building({ slug: '   ' })), '');
});

// ---- the campus regression: a shared site slug is CORRECT under a Location anchor ----

test('two buildings under one campus Site do not collide (IMPORT-28)', () => {
  // The reported bug, exactly: under `site-as-campus` every building binds beneath one campus Site,
  // so `_bindBuilding` gives them all the same `b.slug` by design. Flagging that as a duplicate
  // condemned every building of a legitimate upload.
  const campus = { slug: 'north-campus', name: 'North Campus' };
  const admin = building({
    folder: 'Admin', slug: 'north-campus', nbSite: campus,
    nbBuilding: { slug: 'admin-bldg', name: 'Administration Building' },
  });
  const library = building({
    folder: 'Library', name: 'Library', slug: 'north-campus', nbSite: campus,
    nbBuilding: { slug: 'library-bldg', name: 'Library Building' },
  });
  const c = cards([admin, library]);
  assert.strictEqual(c._buildingFieldError(admin, 'slug'), null);
  assert.strictEqual(c._buildingFieldError(library, 'slug'), null);
});

test('two folders bound to the SAME building Location still collide', () => {
  // The other half: sharing the campus slug is fine, sharing the whole anchor is not — it would
  // silently clobber one building's floors with the other's.
  const campus = { slug: 'north-campus', name: 'North Campus' };
  const anchor = { slug: 'admin-bldg', name: 'Administration Building' };
  const a = building({ folder: 'Admin-A', slug: 'north-campus', nbSite: campus, nbBuilding: anchor });
  const b = building({
    folder: 'Admin-B', name: 'Admin Annex', slug: 'north-campus', nbSite: campus, nbBuilding: anchor,
  });
  const msg = cards([a, b])._buildingFieldError(a, 'slug');
  assert.match(msg, /same NetBox building/);
  assert.match(msg, /north-campus\/admin-bldg/);   // names the actual conflict, not "this slug"
});

test('two Site-anchored buildings sharing a site slug still collide', () => {
  // `site-as-building` is unchanged by IMPORT-28: there the site slug IS the anchor.
  const site = { slug: 'administration', name: 'Administration' };
  const a = building({ folder: 'Admin-A', nbSite: site });
  const b = building({ folder: 'Admin-B', name: 'Admin Annex', nbSite: site });
  const msg = cards([a, b])._buildingFieldError(a, 'slug');
  assert.match(msg, /same NetBox site/);
});

test('a Site anchor and a Location anchor sharing a slug do not collide', () => {
  // Their anchors are `north-campus` and `north-campus/admin-bldg` — distinct, and `_buildMap`
  // lets this through, so the inline warning must too.
  const a = building({ folder: 'Campus', slug: 'north-campus',
    nbSite: { slug: 'north-campus', name: 'North Campus' } });
  const b = building({ folder: 'Admin', slug: 'north-campus',
    nbSite: { slug: 'north-campus', name: 'North Campus' },
    nbBuilding: { slug: 'admin-bldg', name: 'Administration Building' } });
  const c = cards([a, b]);
  assert.strictEqual(c._buildingFieldError(a, 'slug'), null);
  assert.strictEqual(c._buildingFieldError(b, 'slug'), null);
});

// ---- the rungs that guard a single building ----

test('a blank or badly-charactered slug is still rejected', () => {
  const c = (b) => cards([b])._buildingFieldError(b, 'slug');
  assert.match(c(building({ slug: '' })), /required/);
  assert.match(c(building({ slug: 'north campus!' })), /letters, numbers/);
});

test('a real bound Location slug is never flagged by the charset rung', () => {
  // The charset stays lenient on purpose — a NetBox slug carrying digits, hyphens or underscores
  // is ordinary, and flagging one would be a false alarm on correct data.
  const b = building({ slug: 'slo_bldg-001', nbSite: { slug: 'slo_bldg-001', name: 'B1' } });
  assert.strictEqual(cards([b])._buildingFieldError(b, 'slug'), null);
});

test('a slug edited away from its bound NetBox site is flagged', () => {
  // Silent failure otherwise: the manifest gets a `siteSlug` no Site answers to, `_loadFloors`
  // finds nothing, and the building quietly drops to the floor-type fallback with no stated cause.
  const b = building({ slug: 'typo-slug', nbSite: { slug: 'administration', name: 'Administration' } });
  const msg = cards([b])._buildingFieldError(b, 'slug');
  assert.match(msg, /administration/);
  assert.match(msg, /won’t resolve/);
});

test('an unbound building may carry any well-formed slug', () => {
  // The hand-typed escape hatch: no binding means nothing to contradict.
  const b = building({ slug: 'hand-typed', nbSite: null });
  assert.strictEqual(cards([b])._buildingFieldError(b, 'slug'), null);
});

test('the name rung only requires a name', () => {
  const b = building({ name: '' });
  assert.match(cards([b])._buildingFieldError(b, 'name'), /required/);
  assert.strictEqual(cards([b])._buildingFieldError(building({}), 'name'), null);
});
