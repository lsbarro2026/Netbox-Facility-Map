'use strict';
/* import-diff.test.js — ImportDiff's pure map↔manifest statics.

   The three read methods are async, fetch fresh room counts and measure a rendered image, so they
   belong in a browser and stay out of this tier. The statics under them do not: they are the one
   mirror of `preprocess.build`'s floor-key construction (`<dir>/(abbr+token)`, `dir` per `dirOf`),
   shared by every read and — since IMPORT-74 — by the Settings page's rebuild gate.

   `rerenderOnly` is why this file exists. It is the whole room-safety guarantee of a rebuild fired
   from outside the import wizard: that page has no review dialog and no `_afterBuild` to reconcile
   rooms with, so it may only rebuild when the answer here is true. A false positive would let a
   rebuild silently orphan, move or desync rooms already drawn, with nothing in front of it. Every
   shape that must answer false is therefore asserted individually, not as one lump. */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadClasses } = require('./load.js');

const { ImportDiff } = loadClasses(['import-diff.js'], ['ImportDiff']);

/** A two-floor Site-anchored building, the plain case: `hq/` → site `hq`, abbr `h`, floors h1/h2. */
const MAP = () => ({
  siteplan: { folder: 'site', pdf: 'campus.pdf', slug: '00-site' },
  buildings: {
    hq: { slug: 'hq', name: 'HQ', abbr: 'h', floors: { 'plan-1': '1', 'plan-2': '2' } },
  },
});

/** The manifest that map built: same two floors, one unrotated sheet each. */
const MANIFEST = () => ({
  siteplan: { image: 'images/site.webp', w: 1000, h: 800, siteSlug: '00-site' },
  buildings: [{
    dir: 'hq', name: 'HQ',
    floors: [{ id: 'h1', label: 'Floor 1', pages: [{ angle: 0 }] },
             { id: 'h2', label: 'Floor 2', pages: [{ angle: 0 }] }],
  }],
});

const keys = (map) => [...ImportDiff.floorKeys(map)].sort();

// ---- the shared floor-key expansion ----

test('a scalar floor token is one floor, keyed <dir>/(abbr+token)', () => {
  assert.deepStrictEqual(keys(MAP()), ['hq/h1', 'hq/h2']);
});

test('a Location anchor nests the building slug into the key prefix', () => {
  const map = MAP();
  map.buildings.hq.slug = 'campus';
  map.buildings.hq.buildingSlug = 'hq-bldg';
  assert.deepStrictEqual(keys(map), ['campus/hq-bldg/h1', 'campus/hq-bldg/h2']);
});

test('a region-split value expands to one floor per region, not one stringified array', () => {
  const map = MAP();
  map.buildings.hq.floors['plan-1'] = [{ token: '1a', region: [0, 0, 0.5, 1] },
                                       { token: '1b', region: [0.5, 0, 0.5, 1] }];
  assert.deepStrictEqual(keys(map), ['hq/h1a', 'hq/h1b', 'hq/h2']);
});

test('an unmapped drawing yields no floor at all', () => {
  // The stub map seeds every stem with '' — `preprocess._page_entries` skips those, so a falsy
  // token must not become the phantom key `hq/h`.
  const map = MAP();
  map.buildings.hq.floors['plan-3'] = '';
  map.buildings.hq.floors['plan-4'] = [{ token: '' }];
  assert.deepStrictEqual(keys(map), ['hq/h1', 'hq/h2']);
});

test('every region floor of a page carries that page\'s single straightening angle', () => {
  const map = MAP();
  map.buildings.hq.floors['plan-1'] = [{ token: '1a' }, { token: '1b' }];
  map.buildings.hq.angles = { 'plan-1': 90 };
  const byKey = Object.fromEntries(
    ImportDiff.floorEntries(map).map(e => [e.key, e.angle]));
  assert.deepStrictEqual(byKey, { 'hq/h1a': 90, 'hq/h1b': 90, 'hq/h2': 0 });
});

test('an entry names the drawing it came from, so a caller can ask about that drawing', () => {
  const e = ImportDiff.floorEntries(MAP()).find(x => x.key === 'hq/h2');
  assert.strictEqual(e.folder, 'hq');
  assert.strictEqual(e.stem, 'plan-2');
});

// ---- rerenderOnly: the rebuild gate ----

test('the map that built the manifest is a pure re-render', () => {
  assert.strictEqual(ImportDiff.rerenderOnly(MAP(), MANIFEST()), true);
});

test('a dropped floor is not a re-render (its rooms would be orphaned)', () => {
  const map = MAP();
  delete map.buildings.hq.floors['plan-2'];
  assert.strictEqual(ImportDiff.rerenderOnly(map, MANIFEST()), false);
});

test('an added floor is not a re-render', () => {
  const map = MAP();
  map.buildings.hq.floors['plan-3'] = '3';
  assert.strictEqual(ImportDiff.rerenderOnly(map, MANIFEST()), false);
});

test('a re-assigned floor token is not a re-render (the id moves)', () => {
  const map = MAP();
  map.buildings.hq.floors['plan-2'] = '3';
  assert.strictEqual(ImportDiff.rerenderOnly(map, MANIFEST()), false);
});

test('a re-bound building is not a re-render (the whole key prefix moves)', () => {
  const map = MAP();
  map.buildings.hq.slug = 'annex';
  assert.strictEqual(ImportDiff.rerenderOnly(map, MANIFEST()), false);
});

test('a whole→region split is not a re-render (rooms need reprojecting)', () => {
  const map = MAP();
  map.buildings.hq.floors['plan-1'] = [{ token: '1', region: [0, 0, 0.5, 1] },
                                       { token: '1b', region: [0.5, 0, 0.5, 1] }];
  assert.strictEqual(ImportDiff.rerenderOnly(map, MANIFEST()), false);
});

test('a newly straightened drawing is not a re-render (its rooms would desync)', () => {
  const map = MAP();
  map.buildings.hq.angles = { 'plan-2': 90 };
  assert.strictEqual(ImportDiff.rerenderOnly(map, MANIFEST()), false);
});

test('an already-straightened floor still matches its manifest angle', () => {
  const map = MAP();
  map.buildings.hq.angles = { 'plan-2': 90 };
  const manifest = MANIFEST();
  manifest.buildings[0].floors[1].pages = [{ angle: 90 }];
  assert.strictEqual(ImportDiff.rerenderOnly(map, manifest), true);
});

test('a multi-sheet floor matches order-independently but counts its sheets', () => {
  const map = MAP();
  map.buildings.hq.floors = { 'plan-1a': '1', 'plan-1b': '1' };
  map.buildings.hq.angles = { 'plan-1a': 0, 'plan-1b': 90 };
  const manifest = MANIFEST();
  manifest.buildings[0].floors = [
    { id: 'h1', label: 'Floor 1', pages: [{ angle: 90 }, { angle: 0 }] }];
  assert.strictEqual(ImportDiff.rerenderOnly(map, manifest), true);
  // Losing one of the two sheets changes what renders, even though the floor id survives.
  delete map.buildings.hq.floors['plan-1b'];
  assert.strictEqual(ImportDiff.rerenderOnly(map, manifest), false);
});

test('a manifest floor with no pages block reads as one unrotated sheet', () => {
  const manifest = MANIFEST();
  delete manifest.buildings[0].floors[0].pages;
  assert.strictEqual(ImportDiff.rerenderOnly(MAP(), manifest), true);
});

test('adding, dropping or rotating the site plan is not a re-render (hotspots skew)', () => {
  const dropped = MAP();
  dropped.siteplan = null;
  assert.strictEqual(ImportDiff.rerenderOnly(dropped, MANIFEST()), false);

  const manifest = MANIFEST();
  manifest.siteplan = null;
  assert.strictEqual(ImportDiff.rerenderOnly(MAP(), manifest), false);

  const rotated = MAP();
  rotated.siteplan.angle = 180;
  assert.strictEqual(ImportDiff.rerenderOnly(rotated, MANIFEST()), false);

  const reslugged = MAP();
  reslugged.siteplan.slug = 'campus-plan';
  assert.strictEqual(ImportDiff.rerenderOnly(reslugged, MANIFEST()), false);
});

test('a site plan with no explicit slug is the default one', () => {
  const map = MAP();
  delete map.siteplan.slug;   // `preprocess` defaults the block to '00-site'
  assert.strictEqual(ImportDiff.rerenderOnly(map, MANIFEST()), true);
});

test('a facility with no site plan on either side is still a re-render', () => {
  const map = MAP(); map.siteplan = null;
  const manifest = MANIFEST(); manifest.siteplan = null;
  assert.strictEqual(ImportDiff.rerenderOnly(map, manifest), true);
});

test('a missing map or manifest is never a re-render', () => {
  assert.strictEqual(ImportDiff.rerenderOnly(null, MANIFEST()), false);
  assert.strictEqual(ImportDiff.rerenderOnly(MAP(), null), false);
});
