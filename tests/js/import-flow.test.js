'use strict';
/* import-flow.test.js — ImportFlow's pure statics, plus the map step's floor-resolution core.

   ImportFlow is overwhelmingly a wizard: it renders through `Dom`, fetches, toasts, and holds
   step state, all of which belongs in a browser and is out of this tier by design (README.md).
   Its handful of *pure* statics are not, and `anchorFromRow` is the one carrying a decision
   worth pinning down: it is the bridge from a NetBox picker row to a **building anchor**, whose
   slug becomes the first segment(s) of every `Room.floor_key` beneath that building. Getting the
   anchor *kind* wrong there doesn't mis-propose a building — it mis-anchors one.

   The second half covers `_loadFloors` and the helpers it drives. Those are instance methods, but
   they touch no DOM whatsoever — they read a Location list, derive a building's floors, and decide
   whether a stale floor assignment may be swept. So they are exercised on a bare
   `Object.create(ImportFlow.prototype)` receiver carrying only the few fields they read, rather
   than on a constructed wizard (which would drag in every collaborator for nothing). The decision
   worth pinning down here is the sweep guard: `_dropUnanchoredTokens` resets an assignment whose
   Location is absent from the fetched list, so running it against an INCOMPLETE list silently
   discards floors the operator confirmed (IMPORT-29) — and "incomplete" is itself a judgement, since
   the server answers shallowest-first and a clipped tail of rooms says nothing about the floors
   (IMPORT-49). Both directions of that call are covered below. */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadClasses } = require('./load.js');

// `ImportBulk` rides along because `_defaultAssign` genuinely asks it whether a filename names a
// floor — the two halves of "what does this drawing start as" are one decision (IMPORT-63).
const { ImportFlow } = loadClasses(['import-bulk.js', 'import-flow.js'], ['ImportFlow']);

// ---- anchorFromRow: the row's own shape decides the anchor kind (IMPORT-25) ----

// The two row shapes are the server's, verbatim: `serializers._trim_site` for a Site and
// `_trim_building_location` for a building Location. The only structural difference between them —
// and so the only thing the discriminator can key off — is the Location's campus `site_slug`.
const SITE_ROW = { id: 7, name: 'Administration', slug: 'administration', url: '/dcim/sites/7/' };
const LOCATION_ROW = {
  id: 42, name: 'Administration Building', slug: 'admin-bldg',
  site_slug: 'north-campus', site_name: 'North Campus', url: '/dcim/locations/42/',
};

test('a Site row becomes a Site anchor', () => {
  assert.deepStrictEqual(ImportFlow.anchorFromRow(SITE_ROW), {
    kind: 'site',
    site: { id: 7, slug: 'administration', name: 'Administration' },
  });
});

test('a building Location row becomes a Location anchor carrying its campus', () => {
  // Both halves matter downstream: the campus site slug flows on as the manifest `siteSlug`, the
  // Location's own as the `buildingSlug`. The campus id is deliberately null — the row names the
  // campus by slug/name only, which is exactly what `_bindRow`'s own Location branch passes.
  assert.deepStrictEqual(ImportFlow.anchorFromRow(LOCATION_ROW), {
    kind: 'building',
    site: { id: null, slug: 'north-campus', name: 'North Campus' },
    building: { id: 42, slug: 'admin-bldg', name: 'Administration Building' },
  });
});

test('the row decides the kind — a Site row never becomes a Location anchor', () => {
  // The regression this guards: keying the kind off the wizard's ambient organization mode instead
  // of the row. The mode steers what a step *offers*; an answer already given keeps the meaning it
  // was given with, even if the mode is flipped between the organize and bind steps (MODEL-7).
  assert.strictEqual(ImportFlow.anchorFromRow(SITE_ROW).kind, 'site');
  assert.strictEqual(ImportFlow.anchorFromRow(LOCATION_ROW).kind, 'building');
});

test('a destination that is no NetBox object has no anchor', () => {
  // A hand-typed building name and the source upload folder reach the same picker as plain
  // `{folder, label}` options. Null is what keeps them out of the carry, so they still reach the
  // bind step as the genuinely-unanswered rows they are.
  assert.strictEqual(ImportFlow.anchorFromRow(null), null);
  assert.strictEqual(ImportFlow.anchorFromRow(undefined), null);
  assert.strictEqual(ImportFlow.anchorFromRow({}), null);
  assert.strictEqual(ImportFlow.anchorFromRow({ name: 'New Building' }), null);
  assert.strictEqual(ImportFlow.anchorFromRow({ slug: '' }), null);
});

test('a row missing its display name falls back to its slug, never to undefined', () => {
  // The name is rendered straight into the bind row's state line, so an absent one must degrade to
  // something readable rather than putting "undefined" in front of the operator.
  assert.deepStrictEqual(ImportFlow.anchorFromRow({ id: 3, slug: 'annex' }), {
    kind: 'site', site: { id: 3, slug: 'annex', name: 'annex' },
  });
  assert.deepStrictEqual(ImportFlow.anchorFromRow({ slug: 'annex', site_slug: 'main' }), {
    kind: 'building',
    site: { id: null, slug: 'main', name: 'main' },
    building: { id: null, slug: 'annex', name: 'annex' },
  });
});

test('a missing row id normalizes to null rather than undefined', () => {
  // `_bindSite`/`_bindBuilding` copy the id straight onto the model, which the draft serializes as
  // JSON — where `undefined` silently drops the key and `null` round-trips. Nothing downstream
  // reads the id (all logic keys off slug/name), so the point is only that it survives as itself.
  assert.strictEqual(ImportFlow.anchorFromRow({ slug: 'annex', name: 'Annex' }).site.id, null);
});

// ---- the reserved upload folders (IMPORT-24) ----

test('the reserved folder names match the pipeline constants exactly', () => {
  // These are the client half of a two-sided contract with Python: `PreprocessBase.EXCLUDED_DIRNAME`
  // /`THUMBS_DIRNAME` decide which folders `building_folders()` skips, and the organize step writes
  // `EXCLUDED_FOLDER` as a regroup destination expecting exactly that skip. A drift of one
  // character doesn't fail loudly — it files the excluded drawings into a real building instead.
  // Matched by literal, since the JS tier can't read the Python constant.
  assert.strictEqual(ImportFlow.EXCLUDED_FOLDER, '_excluded');
  assert.strictEqual(ImportFlow.THUMBS_FOLDER, '.thumbs');
});

test('a reserved folder is never a NetBox anchor', () => {
  // An excluded drawing's destination is a folder name, not a building — so it must not be able to
  // reach the bind step as one. `_notePick` is only ever called from the pickers (never from the
  // exclude control), and this is the second line of that defence: even handed in as a row, a
  // reserved name carries no `slug` and so yields no anchor (IMPORT-25's `anchorFromRow` contract).
  assert.strictEqual(ImportFlow.anchorFromRow({ name: ImportFlow.EXCLUDED_FOLDER }), null);
  assert.strictEqual(ImportFlow.anchorFromRow(undefined), null);
});

// ---- resuming a draft written before the Site plan step was merged (IMPORT-37) ----

// `_draftStepDone` is what decides whether a restored import is asked the Site plan step again
// (`FreshImportFlow._resume`). Getting it wrong is silent either way: too eager and an operator who
// never marked a floor-code crop lands on the map with whole-drawing thumbnails and no offer to fix
// it; too shy and a finished import is dragged back through a step it already answered.

test('a current draft is taken at its word — both ways', () => {
  assert.strictEqual(ImportFlow._draftStepDone({ siteplanStepDone: true }), true);
  assert.strictEqual(ImportFlow._draftStepDone({ siteplanStepDone: false }), false);
});

test('a pre-merge draft counts as answered only when BOTH old steps were', () => {
  // The merged step asks what the two old steps asked, so a draft that walked only the first of
  // them has genuinely not answered it.
  assert.strictEqual(
    ImportFlow._draftStepDone({ siteplanDone: true, codeRegionDone: true }), true);
  assert.strictEqual(ImportFlow._draftStepDone({ siteplanDone: true }), false);
  assert.strictEqual(ImportFlow._draftStepDone({ codeRegionDone: true }), false);
});

test('the current flag wins over the old pair, and a draftless resume asks', () => {
  // A draft written by this version carries the new flag; the old keys can only be leftovers of an
  // earlier walk, so they must not out-vote it.
  assert.strictEqual(ImportFlow._draftStepDone(
    { siteplanStepDone: false, siteplanDone: true, codeRegionDone: true }), false);
  assert.strictEqual(ImportFlow._draftStepDone({}), false);
  assert.strictEqual(ImportFlow._draftStepDone(null), false);
});

// ---- the map step's floor load: never sweep assignments against an incomplete list (IMPORT-29) ----

/** A wizard receiver with only what `_loadFloors` reads: the NetBox client, the Location tree
 *  cache, and the bulk collaborator whose suggestion pass it ends with. No DOM, no constructor —
 *  everything else on the flow is irrelevant to this path. `res` is the `/api/netbox/locations`
 *  body to answer with; a thrown `res` simulates the request failing. */
function flowWith(res) {
  const flow = Object.create(ImportFlow.prototype);
  flow._siteLocs = new Map();
  flow.calls = [];
  flow.app = { netbox: { locations: async (slug, q, full) => {
    flow.calls.push({ slug, q, full });
    if (res instanceof Error) throw res;
    return res;
  } } };
  flow.bulk = { suggestFloors() {} };
  return flow;
}

/** A Location-anchored building with two drawings: one assigned to a floor the fetch will report,
 *  one assigned to a floor it won't (because the list was clipped, or the request failed). */
function anchoredBuilding() {
  return {
    folder: 'main', name: 'Main', slug: 'campus',
    nbSite: { slug: 'campus', name: 'Campus' },
    nbBuilding: { id: 1, slug: 'main-bldg', name: 'Main Building' },
    nbFloors: undefined, nbFloorsError: null,
    pdfs: [{ stem: 'sheet-a' }, { stem: 'sheet-b' }],
    assign: {
      'sheet-a': { type: 'level', num: 1, token: 'level-1', label: 'Level 1' },
      'sheet-b': { type: 'level', num: 2, token: 'level-9', label: 'Level 9' },
    },
    regions: { 'sheet-a': [], 'sheet-b': [] },
  };
}

// The list the server would return for that building's campus when it is NOT clipped: the anchor
// plus one of its floors. `level-9` is deliberately absent — it is genuinely not a child of this
// anchor, which is exactly what the sweep exists to catch.
const CAMPUS_LOCS = [
  { id: 1, name: 'Main Building', slug: 'main-bldg', parent: null },
  { id: 2, name: 'Level 1', slug: 'level-1', parent: 1 },
];

test('the floor load reads the site list in one shot, not per keystroke', async () => {
  // Rooms are Locations too, so the per-keystroke cap is exceeded by an ordinary site long before
  // a campus. `_loadFloors` needs the whole tree, so it must opt into the higher one-shot cap.
  const flow = flowWith({ rooms: CAMPUS_LOCS, truncated: false, site_not_found: false });
  await flow._loadFloors(anchoredBuilding());
  assert.deepStrictEqual(flow.calls, [{ slug: 'campus', q: '', full: true }]);
});

test('a complete list still drops an assignment the anchor cannot hold', async () => {
  // The sweep's real job, unchanged: a 3-segment floor key resolves the floor *under* the anchor,
  // so a token that is not one of its children would be dead on arrival at build time. Downgrading
  // to `unassigned` routes it back through the build gate rather than into a silently-wrong floor.
  const flow = flowWith({ rooms: CAMPUS_LOCS, truncated: false, site_not_found: false });
  const b = anchoredBuilding();
  await flow._loadFloors(b);

  assert.strictEqual(b.nbFloorsError, null);
  assert.strictEqual(b.assign['sheet-a'].token, 'level-1');   // a real child survives
  assert.strictEqual(b.assign['sheet-b'].token, null);        // the stranded one is re-asked
  assert.strictEqual(b.assign['sheet-b'].type, 'unassigned');
});

test('a list clipped AT the floors sweeps nothing — that is not evidence a floor is gone', async () => {
  // The regression. A clip that reached the floor tier means a token missing from this answer may
  // sit perfectly well under the anchor in NetBox. Sweeping on it reset a page of confirmed floor
  // picks with no message — and `_mergeAssignedFloors` can't rescue them either, since the token's
  // Location is past the cap too. The anchor is a root, so its floors are tier 1.
  const flow = flowWith({ rooms: CAMPUS_LOCS, truncated: true, truncated_depth: 1,
                          site_not_found: false });
  const b = anchoredBuilding();
  await flow._loadFloors(b);

  assert.strictEqual(b.nbFloorsError, 'truncated');
  assert.strictEqual(b.assign['sheet-a'].token, 'level-1');
  assert.strictEqual(b.assign['sheet-b'].token, 'level-9');   // untouched, not guessed at
  assert.strictEqual(b.assign['sheet-b'].type, 'level');
});

test('a list clipped BELOW the floors is a complete floor list, and does sweep', async () => {
  // IMPORT-49, the other half. The server answers shallowest-first, so what a cap clips is the
  // deepest tier — the site's rooms, which the floor list never reads. Treating that as a partial
  // floor list is what put the warning under every building of any real facility AND stopped the
  // sweep from ever running, so a genuinely stale token survived every reload.
  const flow = flowWith({ rooms: CAMPUS_LOCS, truncated: true, truncated_depth: 2,
                          site_not_found: false });
  const b = anchoredBuilding();
  await flow._loadFloors(b);

  assert.strictEqual(b.nbFloorsError, null);                  // no warning the operator can't act on
  assert.strictEqual(b.assign['sheet-a'].token, 'level-1');
  assert.strictEqual(b.assign['sheet-b'].token, null);        // the stranded one IS re-asked
  assert.strictEqual(b.assign['sheet-b'].type, 'unassigned');
});

test('a clip the server cannot place fails safe — the floor list is treated as partial', async () => {
  // Two ways that happens, and both must land on the cautious side. A server too old to send
  // `truncated_depth` at all:
  const old = flowWith({ rooms: CAMPUS_LOCS, truncated: true, site_not_found: false });
  const b = anchoredBuilding();
  await old._loadFloors(b);
  assert.strictEqual(b.nbFloorsError, 'truncated');
  assert.strictEqual(b.assign['sheet-b'].token, 'level-9');

  // …and a clip so shallow the anchor itself didn't make the answer, which leaves nothing to
  // measure the floors' tier against.
  const above = flowWith({ rooms: [{ id: 9, name: 'Other', slug: 'other-bldg', parent: null }],
                           truncated: true, truncated_depth: 0, site_not_found: false });
  const b2 = anchoredBuilding();
  await above._loadFloors(b2);
  assert.strictEqual(b2.nbFloorsError, 'truncated');
  assert.strictEqual(b2.assign['sheet-b'].token, 'level-9');
});

// ---- _floorTier: where a building's floors sit, so a clip below them can be ignored (IMPORT-49) ----

test('a Site anchor reads its floors from the roots and their children — tier 1', () => {
  // `_floorsFromLocations`' Site-anchor branch never looks deeper than a root's children, so the
  // answer is fixed and needs no anchor to find.
  assert.strictEqual(ImportFlow._floorTier(CAMPUS_LOCS, null), 1);
});

test('a Location anchor is measured up its own parent chain', () => {
  const locs = [
    { id: 1, name: 'Main Building', slug: 'main-bldg', parent: null },
    { id: 2, name: 'East Wing', slug: 'east-wing', parent: 1 },
    { id: 3, name: 'Level 1', slug: 'level-1', parent: 2 },
  ];
  assert.strictEqual(ImportFlow._floorTier(locs, 'main-bldg'), 1);
  // Drilled onto the wing (MULTI-5), the floors sit one tier deeper — so a clip at tier 2 now
  // *does* reach them, where for the building anchor it wouldn't have.
  assert.strictEqual(ImportFlow._floorTier(locs, 'east-wing'), 2);
});

test('an anchor missing from the answer has no measurable tier', () => {
  assert.strictEqual(ImportFlow._floorTier(CAMPUS_LOCS, 'gone-bldg'), null);
});

test('a failed request sweeps nothing and says the fetch failed', async () => {
  const flow = flowWith(new Error('network down'));
  const b = anchoredBuilding();
  await flow._loadFloors(b);

  assert.deepStrictEqual(b.nbFloors, []);
  assert.strictEqual(b.nbFloorsError, 'fetch');
  assert.strictEqual(b.assign['sheet-b'].token, 'level-9');
});

test('a slug no Site answers to reads as a broken binding, not an empty site', async () => {
  // Both come back with no Locations, but only this one means the *binding* is wrong — a Site
  // renamed or deleted in NetBox after the folder was bound. Without the distinction the card fell
  // back to the floor-TYPE vocabulary and built floor ids matching nothing in NetBox.
  const flow = flowWith({ rooms: [], truncated: false, site_not_found: true });
  const b = anchoredBuilding();
  await flow._loadFloors(b);

  assert.strictEqual(b.nbFloorsError, 'site-missing');
  assert.strictEqual(b.assign['sheet-b'].token, 'level-9');   // nothing swept on no evidence

  const empty = flowWith({ rooms: [], truncated: false, site_not_found: false });
  const b2 = anchoredBuilding();
  await empty._loadFloors(b2);
  assert.strictEqual(b2.nbFloorsError, null);                 // a genuinely floorless site
});

test('a building with no slug settles without calling NetBox at all', async () => {
  const flow = flowWith({ rooms: CAMPUS_LOCS, truncated: false, site_not_found: false });
  const b = anchoredBuilding();
  b.slug = '   ';
  await flow._loadFloors(b);

  assert.deepStrictEqual(b.nbFloors, []);
  assert.strictEqual(b.nbFloorsError, null);
  assert.deepStrictEqual(flow.calls, []);
});

// ---- _floorsFromLocations: every organization shape resolves its own floors (IMPORT-29) ----

test('site-as-building: the site-named root is the building, its children are the floors', () => {
  // The Site *is* the building. Its root Location is named after the site; any OTHER root is itself
  // a floor (some sites park a "Roof" at the top level, as a sibling of the building).
  const flow = Object.create(ImportFlow.prototype);
  const locs = [
    { id: 1, name: 'Annex', slug: 'annex-bldg', parent: null },
    { id: 2, name: 'Level 1', slug: 'level-1', parent: 1 },
    { id: 3, name: 'Room 101', slug: 'room-101', parent: 2 },
    { id: 4, name: 'Roof', slug: 'roof', parent: null },
  ];
  const floors = flow._floorsFromLocations(locs, 'Annex', null).map(f => f.slug);
  assert.deepStrictEqual(floors, ['level-1', 'roof']);   // the room is a grandchild, never a floor
});

test('site-as-campus: two buildings under one campus keep their own floors apart', () => {
  // The floors are strictly the anchored building Location's CHILDREN, so a campus whose buildings
  // both have a "Level 1" never cross-contaminates — the anchor is what tells them apart (MODEL-4).
  const flow = Object.create(ImportFlow.prototype);
  const locs = [
    { id: 1, name: 'Building A', slug: 'bldg-a', parent: null },
    { id: 2, name: 'Building B', slug: 'bldg-b', parent: null },
    { id: 3, name: 'Level 1', slug: 'a-level-1', parent: 1 },
    { id: 4, name: 'Level 1', slug: 'b-level-1', parent: 2 },
  ];
  assert.deepStrictEqual(
    flow._floorsFromLocations(locs, 'Campus', 'bldg-a').map(f => f.slug), ['a-level-1']);
  assert.deepStrictEqual(
    flow._floorsFromLocations(locs, 'Campus', 'bldg-b').map(f => f.slug), ['b-level-1']);
});

test('campus → building → wing → floor: only the WING anchor surfaces the real floors', () => {
  // Anchoring on the building surfaces the wings and hides the floors — which is why the operator
  // is offered the drill control (MULTI-5). Children, never descendants: the floor key writes the
  // anchor's slug in its middle segment, so a grandchild would emit a key that can never resolve.
  const flow = Object.create(ImportFlow.prototype);
  const locs = [
    { id: 1, name: 'Main', slug: 'main', parent: null },
    { id: 2, name: 'North Wing', slug: 'north', parent: 1 },
    { id: 3, name: 'Level 1', slug: 'n-level-1', parent: 2 },
  ];
  assert.deepStrictEqual(
    flow._floorsFromLocations(locs, 'Campus', 'main').map(f => f.slug), ['north']);
  assert.deepStrictEqual(
    flow._floorsFromLocations(locs, 'Campus', 'north').map(f => f.slug), ['n-level-1']);
});

test('an anchor slug matching no Location yields no floors rather than guessing', () => {
  const flow = Object.create(ImportFlow.prototype);
  assert.deepStrictEqual(flow._floorsFromLocations(
    [{ id: 1, name: 'Main', slug: 'main', parent: null }], 'Campus', 'vanished'), []);
});

// ---- the build row's unbound-buildings warning (IMPORT-29) ----

test('only floor-contributing buildings with no anchor are named as unbound', () => {
  // The linear fresh walk gates on `_allBuildingsBound`, but the edit hub jumps straight to the map
  // step — where an unbound building's drawings keep their Level 1..N defaults (never `unassigned`)
  // and so sail through the build gate. It builds floors whose `siteSlug` answers to no Site.
  const flow = Object.create(ImportFlow.prototype);
  const withFloor = (folder, name, nbSite) => ({
    folder, name, nbSite,
    pdfs: [{ stem: folder + '-1' }],
    assign: { [folder + '-1']: { type: 'level', num: 1, token: null, label: '' } },
    regions: { [folder + '-1']: [] },
  });
  const siteplanOnly = {
    folder: 'siteplan', name: 'Site Plan', nbSite: null,
    pdfs: [{ stem: 'sp-1' }],
    assign: { 'sp-1': { type: 'none', num: 1, token: null, label: '' } },
    regions: { 'sp-1': [] },
  };
  flow.buildings = [
    withFloor('bound', 'Bound Building', { slug: 'bound', name: 'Bound' }),
    withFloor('loose', 'Loose Building', null),
    siteplanOnly,   // contributes no floor, so it needs no anchor and must stay silent
  ];

  assert.deepStrictEqual(flow._unboundBuildings(), ['Loose Building']);
});

// ---- carousel/build-gate per-building attention state (IMPORT-40) ----

/** A building with one whole-page drawing carrying `type` — enough for `_cardUnassigned` /
 *  `_unassignedCount` to read, without a region split. */
function singlePdfBuilding(folder, type) {
  return {
    folder, name: folder,
    pdfs: [{ stem: folder + '-1' }],
    assign: { [folder + '-1']: { type, num: 1, token: null, label: '' } },
    regions: { [folder + '-1']: [] },
  };
}

test('_unassignedCount counts whole-page drawings and unassigned regions alike', () => {
  const flow = Object.create(ImportFlow.prototype);
  const b = {
    folder: 'admin', name: 'Admin',
    pdfs: [{ stem: 'admin-1' }, { stem: 'admin-2' }, { stem: 'admin-3' }],
    assign: {
      'admin-1': { type: 'unassigned', num: 1, token: null, label: '' },
      'admin-2': { type: 'level', num: 1, token: null, label: '' },
      'admin-3': { type: 'level', num: 1, token: null, label: '' },
    },
    regions: {
      'admin-1': [], 'admin-2': [],
      // admin-3 is region-split: one region still needs a floor, one already has one.
      'admin-3': [
        { box: { x: 0, y: 0, w: 1, h: 1 }, assign: { type: 'unassigned' } },
        { box: { x: 0, y: 0, w: 1, h: 1 }, assign: { type: 'level', num: 1 } },
      ],
    },
  };
  assert.strictEqual(flow._unassignedCount(b), 2);   // admin-1 + admin-3 (region-split)
});

test('_unassignedBuildings returns the building objects themselves, so the build gate can jump to one', () => {
  // Returning objects (not names) is what lets `_unassignedHint` wire each one straight to
  // `_jumpToBuilding(b)` — see `_buildActions`.
  const flow = Object.create(ImportFlow.prototype);
  const clear = singlePdfBuilding('lib', 'level');
  const stuck = singlePdfBuilding('admin', 'unassigned');
  flow.buildings = [clear, stuck];
  assert.deepStrictEqual(flow._unassignedBuildings(), [stuck]);
});

test('_buildingNavLabel shows the unassigned count, or a checkmark once the building is clear', () => {
  const flow = Object.create(ImportFlow.prototype);
  assert.strictEqual(flow._buildingNavLabel(singlePdfBuilding('Admin', 'unassigned')), 'Admin — 1 unassigned');
  assert.strictEqual(flow._buildingNavLabel(singlePdfBuilding('Library', 'level')), 'Library ✓');
});

test('_nextNeedingAttention pages forward to the next building still needing a floor', () => {
  const flow = Object.create(ImportFlow.prototype);
  const buildings = [singlePdfBuilding('a', 'level'), singlePdfBuilding('b', 'unassigned'), singlePdfBuilding('c', 'level')];
  flow._bIdx = 0;
  assert.strictEqual(flow._nextNeedingAttention(buildings), 1);
});

test('_nextNeedingAttention wraps around past the end of the list', () => {
  const flow = Object.create(ImportFlow.prototype);
  const buildings = [singlePdfBuilding('a', 'unassigned'), singlePdfBuilding('b', 'level'), singlePdfBuilding('c', 'level')];
  flow._bIdx = 2;   // sitting on the last building; the only offender is the first
  assert.strictEqual(flow._nextNeedingAttention(buildings), 0);
});

test('_nextNeedingAttention wraps onto the current index when it is the only one left needing attention', () => {
  const flow = Object.create(ImportFlow.prototype);
  const buildings = [singlePdfBuilding('a', 'unassigned'), singlePdfBuilding('b', 'level'), singlePdfBuilding('c', 'level')];
  flow._bIdx = 0;   // already sitting on the sole offender
  assert.strictEqual(flow._nextNeedingAttention(buildings), 0);
});

test('_nextNeedingAttention returns null once no building needs attention', () => {
  const flow = Object.create(ImportFlow.prototype);
  const buildings = [singlePdfBuilding('a', 'level'), singlePdfBuilding('b', 'level')];
  flow._bIdx = 0;
  assert.strictEqual(flow._nextNeedingAttention(buildings), null);
});

// ---- a faint OCR read is an outcome the carousel must route to (IMPORT-53) ----

/** `singlePdfBuilding` whose one drawing carries an OCR suggestion read at `conf`. Assigned — so
 *  it passes the build gate — which is exactly why the softer attention rule has to catch it. */
function ocrSuggestedBuilding(folder, conf) {
  const b = singlePdfBuilding(folder, 'level');
  Object.assign(b.assign[folder + '-1'],
    { suggested: true, suggestedFrom: 'ocr', ocrText: 'L1', ocrConf: conf });
  return b;
}

test('_lowConfidenceCount counts only OCR suggestions below the threshold', () => {
  const flow = Object.create(ImportFlow.prototype);
  assert.strictEqual(flow._lowConfidenceCount(ocrSuggestedBuilding('faint', 0.2)), 1);
  assert.strictEqual(flow._lowConfidenceCount(ocrSuggestedBuilding('clear', 0.95)), 0);
  // A filename suggestion carries no read at all, so it can't be low-confidence — its own
  // "suggested" count (IMPORT-28) is what flags it.
  const byName = singlePdfBuilding('named', 'level');
  Object.assign(byName.assign['named-1'], { suggested: true, suggestedFrom: 'filename' });
  assert.strictEqual(flow._lowConfidenceCount(byName), 0);
  // A faint read the operator has since answered is no longer a suggestion, so it drops out.
  const answered = ocrSuggestedBuilding('answered', 0.2);
  answered.assign['answered-1'].suggested = false;
  assert.strictEqual(flow._lowConfidenceCount(answered), 0);
});

test('_attentionCount adds low-confidence reads to the unassigned count', () => {
  const flow = Object.create(ImportFlow.prototype);
  assert.strictEqual(flow._attentionCount(singlePdfBuilding('stuck', 'unassigned')), 1);
  assert.strictEqual(flow._attentionCount(ocrSuggestedBuilding('faint', 0.2)), 1);
  assert.strictEqual(flow._attentionCount(ocrSuggestedBuilding('clear', 0.95)), 0);
});

test('_attentionCount is NOT the build gate — a faint read never blocks Build', () => {
  // The two say different things and only one of them may disable the button: a low-confidence
  // suggestion is a real assignment, so `_unassignedBuildings` must stay blind to it.
  const flow = Object.create(ImportFlow.prototype);
  flow.buildings = [ocrSuggestedBuilding('faint', 0.2)];
  assert.deepStrictEqual(flow._unassignedBuildings(), []);
});

test('_nextNeedingAttention routes to a building whose only problem is a faint read', () => {
  const flow = Object.create(ImportFlow.prototype);
  const buildings = [singlePdfBuilding('a', 'level'), ocrSuggestedBuilding('b', 0.3)];
  flow._bIdx = 0;
  assert.strictEqual(flow._nextNeedingAttention(buildings), 1);
});

test('_buildingNavLabel names each outstanding state, and says when the sweep still owes a read', () => {
  const flow = Object.create(ImportFlow.prototype);
  assert.strictEqual(flow._buildingNavLabel(ocrSuggestedBuilding('Admin', 0.2)),
    'Admin — 1 low-confidence');
  // A building the sweep hasn't reached is not a building OCR found nothing in — without this it
  // would read as finished ("✓") and the operator would work past it.
  flow.ocr = { isQueued: () => true };
  assert.strictEqual(flow._buildingNavLabel(singlePdfBuilding('Library', 'level')),
    'Library — reading…');
  assert.strictEqual(flow._buildingNavLabel(singlePdfBuilding('Admin', 'unassigned')),
    'Admin — 1 unassigned, reading…');
});

// ---- the draft carries the operator's answers, never the fetched NetBox state (IMPORT-29) ----

test('the draft strips the fetched Location list but keeps everything answered', () => {
  // `_applyDraft` never reads `nbFloors` back — it is re-fetched each session, so a Location renamed
  // in NetBox can't be resurrected from a stale draft. Persisting it is therefore pure weight, and
  // the draft is rewritten on every carousel click; the one-shot read makes that list far larger.
  const flow = Object.create(ImportFlow.prototype);
  flow.buildings = [{
    folder: 'main', name: 'Main', slug: 'campus', abbr: 'm',
    nbSite: { slug: 'campus' }, nbBuilding: { slug: 'main-bldg' },
    nbFloors: [{ id: 2, slug: 'level-1' }], nbFloorsError: 'truncated',
    assign: { 'sheet-a': { type: 'level', num: 1 } },
  }];

  const [saved] = flow._draftBuildings();
  assert.ok(!('nbFloors' in saved) && !('nbFloorsError' in saved));
  assert.deepStrictEqual(saved.nbSite, { slug: 'campus' });
  assert.deepStrictEqual(saved.nbBuilding, { slug: 'main-bldg' });
  assert.deepStrictEqual(saved.assign, { 'sheet-a': { type: 'level', num: 1 } });
  assert.strictEqual(saved.abbr, 'm');
  // The live model keeps its fetched state — the strip is for the wire only.
  assert.strictEqual(flow.buildings[0].nbFloorsError, 'truncated');
});

// ---- the upload step's Continue gate: three rules, one button (IMPORT-32 / -30 / -47) ----

/* `_setUploadPhase` is the single writer of Continue's `.disabled` (§10 *The upload step's Continue
   gate…*), which is precisely why the *decision* it writes is worth pinning down apart from the
   rendering. The regression these guard is the one IMPORT-47 fixed: a scan fired straight off
   Continue left the button live, so a second click put two `import/scan` POSTs on the wire and the
   loser surfaced as a raw `an import is already running` toast. */

const IDLE = { phase: 'idle', hasContent: true, scanBusy: false, scanWaiting: false,
               label: 'Continue with these drawings →' };

test('Continue is live once drawings exist and nothing is running', () => {
  assert.deepStrictEqual(ImportFlow.continueGate(IDLE),
    { disabled: false, label: 'Continue with these drawings →' });
});

test('Continue stays disabled until something is on the server (IMPORT-32)', () => {
  // Keyed off `hasContent`, never the render-only `uploaded` flag — merge mode needs the button
  // enabled with `uploaded` false, so the two can't share a source.
  const gate = ImportFlow.continueGate({ ...IDLE, hasContent: false });
  assert.strictEqual(gate.disabled, true);
  // No relabel: "nothing uploaded yet" is what the empty step already says.
  assert.strictEqual(gate.label, IDLE.label);
});

test('an upload run in flight disables Continue, which would race it with a scan (IMPORT-30)', () => {
  assert.strictEqual(ImportFlow.continueGate({ ...IDLE, phase: 'uploading' }).disabled, true);
});

test('a finished upload leaves Continue live on the step, not navigated away (IMPORT-65)', () => {
  // The whole item: a completed run returns to `idle` **here**, and Continue — enabled by the
  // content the run just uploaded — becomes the only way onward. Before, a full success scanned and
  // routed on its own, so this state was unreachable and a multi-pass upload got cut short after
  // its first folder. Same `IDLE` inputs as the first test; what changed is that a run now ends in
  // them rather than in a navigation.
  assert.deepStrictEqual(ImportFlow.continueGate({ ...IDLE, phase: 'idle', hasContent: true }),
    { disabled: false, label: IDLE.label });
});

test('a scan in flight disables Continue and says so (IMPORT-47)', () => {
  // The relabel is the point. A click that starts a minutes-long scan navigates nowhere until it
  // returns, and a dead button with no explanation is what made the double-click read as broken.
  assert.deepStrictEqual(ImportFlow.continueGate({ ...IDLE, scanBusy: true }),
    { disabled: true, label: 'Scanning your drawings…' });
});

test('waiting out a busy server is named apart from scanning (IMPORT-47)', () => {
  // Distinct states, distinct copy: `scanWaiting` is someone *else's* import holding the
  // working-dir lock, which is not something this operator's click caused.
  assert.deepStrictEqual(
    ImportFlow.continueGate({ ...IDLE, scanBusy: true, scanWaiting: true }),
    { disabled: true, label: 'Waiting for the running import…' });
});

test('the scan gate outranks the content gate — a scan is in flight for content that exists', () => {
  // `show()` scans before anything is uploaded, so this pairing is reachable. It must read as
  // "scanning", not as the silent "nothing here yet" disable.
  assert.deepStrictEqual(
    ImportFlow.continueGate({ ...IDLE, hasContent: false, scanBusy: true }),
    { disabled: true, label: 'Scanning your drawings…' });
});

// ---- the nav-away / Start-over gate: one decision, three controls (IMPORT-30 / -47 / -55) ----

/* Leaving the upload step mid-run is the *other* half of the same invariant: the runner keeps
   streaming files into a progress line the navigation detaches, and the scan behind it later yanks
   the operator forward out of whatever step they left for. `busyGate` is what the step's `← Back`,
   the fresh flow's stepper (`_goToStep`) and *Start over* (`_reset`) all read — three controls that
   used to answer to two hand-written conditions and one nothing at all, which is how the stepper
   came to offer a jump the back button beside it refused. */

test('nothing running: every nav-away off the upload step is allowed', () => {
  assert.deepStrictEqual(ImportFlow.busyGate({ phase: 'idle', scanBusy: false }),
    { busy: false, message: '' });
});

test('an upload run in flight blocks the nav-away, and says it is the upload (IMPORT-30)', () => {
  assert.deepStrictEqual(ImportFlow.busyGate({ phase: 'uploading', scanBusy: false }),
    { busy: true, message: 'An upload is still in progress' });
});

test('a scan in flight blocks the nav-away too (IMPORT-47)', () => {
  // The Continue-fired scan (`_scanAndMap`), which runs at phase `idle` — so a guard written
  // against the uploader's phase alone would wave it through, and the scan's completion would
  // navigate the operator forward from somewhere they had walked off to.
  assert.deepStrictEqual(ImportFlow.busyGate({ phase: 'idle', scanBusy: true }),
    { busy: true, message: 'Your drawings are still being scanned' });
});

test('a run outranks a scan, so a moment is never narrated as two things', () => {
  // The precedence is defence, not an everyday case: since IMPORT-65 a run scans nothing, and a scan
  // seals the step against starting a run, so the pairing should not arise. Pinned anyway — the
  // ordering is what kept the refusal and the drop zone's label from naming different things back
  // when a run ended in its own scan, and a re-added scan-from-a-run must not silently invert it.
  assert.strictEqual(ImportFlow.busyGate({ phase: 'uploading', scanBusy: true }).message,
    'An upload is still in progress');
});

// ---- navRefusal: the same decision, for leaving the wizard entirely (IMPORT-61) ----

/* `busyGate` above answers for the ways off a *step*. The ways off the *wizard* — the `Siteplan`
   crumb `_stage` stamps on every screen of both flows, browser Back, the settings gear, the facility
   picker — are drawn by `App`, not by the wizard, and were unguarded: taking one mid-run detaches
   the live `_progress` node and the post-upload scan then re-stages the wizard over whatever page
   the operator navigated to. `App._navigate` asks the active stage page through `navRefusal`, whose
   whole job is to answer from `busyGate` rather than from a second hand-written condition — so what
   these pin down is that it stays a *delegation*: same wording as the step is showing, null (not
   `{busy:false}`) when nothing is running, and the run-outranks-the-scan precedence intact.

   It reads only `uploader.phase` and `_scanFlight`, so it runs on a bare prototype receiver like
   `_loadFloors` above — `scanBusy` is a prototype getter, so it comes along. */
function flowRunning({ phase = 'idle', scanning = false } = {}) {
  const flow = Object.create(ImportFlow.prototype);
  flow.uploader = { phase };
  flow._scanFlight = scanning ? Promise.resolve() : null;
  return flow;
}

test('nothing running: the wizard does not refuse the crumb trail (or Back, or the gear)', () => {
  // null, not a message — `App._navRefusal` treats anything truthy as a refusal, so a gate object
  // handed back verbatim would wedge every navigation out of the wizard, forever.
  assert.strictEqual(flowRunning().navRefusal(), null);
});

test('an upload run in flight refuses the way out of the wizard (IMPORT-61)', () => {
  assert.strictEqual(flowRunning({ phase: 'uploading' }).navRefusal(),
    'An upload is still in progress');
});

test('a scan in flight refuses it too, at phase idle', () => {
  // The Continue-fired scan (`_scanAndMap`) — the case a phase-only guard waves through, and the
  // one whose completion produces the unexplained auto-advance out of wherever the operator went.
  assert.strictEqual(flowRunning({ scanning: true }).navRefusal(),
    'Your drawings are still being scanned');
});

test('the refusal says exactly what the upload step is saying', () => {
  // Delegation, not a second condition: whatever `busyGate` decides for a given pairing — including
  // the defensive run-and-scan one above — this must answer with, or the refusal and the step's own
  // controls can drift into naming different things.
  assert.strictEqual(flowRunning({ phase: 'uploading', scanning: true }).navRefusal(),
    ImportFlow.busyGate({ phase: 'uploading', scanBusy: true }).message);
});

// ---- the confirmed-anchor bar the fresh Continue gate stands on (IMPORT-57) ----

/** `allAnchorsConfirmed` is the *stricter* of the two binding predicates: `_allBuildingsBound()`
 *  counts an `auto` binding as bound (three of its callers need that), while this one is what the
 *  fresh Buildings step's Continue asks in addition. The distinction is the whole item — the gate
 *  used to ask only the loose question, so an anchor nobody had reviewed walked straight through to
 *  floor mapping, committing every `Room.floor_key` beneath it. */

const CONFIRMED = { nbSite: { slug: 'main', name: 'Main', auto: false } };
const GUESSED = { nbSite: { slug: 'main', name: 'Main', auto: true } };
const UNBOUND = { nbSite: null };

test('an unconfirmed auto-match is not a confirmed anchor', () => {
  assert.strictEqual(ImportFlow.allAnchorsConfirmed([GUESSED]), false);
  assert.strictEqual(ImportFlow.allAnchorsConfirmed([CONFIRMED, GUESSED]), false);
});

test('an unbound building is not confirmed either — the bar is strictly above "bound"', () => {
  assert.strictEqual(ImportFlow.allAnchorsConfirmed([UNBOUND]), false);
  assert.strictEqual(ImportFlow.allAnchorsConfirmed([CONFIRMED, UNBOUND]), false);
});

test('a confirmed binding passes, whether the flag is false or was never written', () => {
  // `_confirmAnchor` writes `false`; a manifest-restored binding (`_reconcileFromManifest`) goes
  // through `_bindSite(…, false)`, which writes `auto: false` too. A record from some older draft
  // with no flag at all must not read as an unreviewed guess and re-gate a finished import.
  assert.strictEqual(ImportFlow.allAnchorsConfirmed([CONFIRMED]), true);
  assert.strictEqual(ImportFlow.allAnchorsConfirmed([{ nbSite: { slug: 'main' } }]), true);
  assert.strictEqual(ImportFlow.allAnchorsConfirmed([CONFIRMED, CONFIRMED]), true);
});

test('no floor-contributing buildings is vacuously confirmed, not a stuck gate', () => {
  // A siteplan-only import has nothing to bind; gating Continue on an empty set would strand it.
  assert.strictEqual(ImportFlow.allAnchorsConfirmed([]), true);
});

test('confirming clears the guess flag without moving the anchor', () => {
  // The reason `_confirmAnchor` exists rather than a re-run of `_bindSite(b, b.nbSite, false)`:
  // both binders re-derive `name`/`abbr` from the anchor and clear `nbFloors`, so re-binding an
  // identical anchor would revert an operator's rename and force a needless floor refetch.
  // Confirming reviews a binding; it does not re-anchor one (§10 — an anchor moves only through an
  // explicit operator action, since it re-keys every `Room.floor_key` beneath the building).
  const flow = Object.create(ImportFlow.prototype);
  const b = {
    nbSite: { id: 7, slug: 'main', name: 'Main Site', auto: true },
    nbBuilding: { id: 3, slug: 'annex', name: 'Annex' },
    name: 'Renamed By Hand', abbr: 'RBH', slug: 'main', nbFloors: { 'level-1': {} },
  };
  flow._confirmAnchor(b);
  assert.strictEqual(b.nbSite.auto, false);
  assert.deepStrictEqual(b.nbSite, { id: 7, slug: 'main', name: 'Main Site', auto: false });
  assert.deepStrictEqual(b.nbBuilding, { id: 3, slug: 'annex', name: 'Annex' });
  assert.strictEqual(b.name, 'Renamed By Hand');
  assert.strictEqual(b.abbr, 'RBH');
  assert.deepStrictEqual(b.nbFloors, { 'level-1': {} });
  assert.strictEqual(ImportFlow.allAnchorsConfirmed([b]), true);
});

test('confirming an unbound building is a no-op, never a synthesized binding', () => {
  const flow = Object.create(ImportFlow.prototype);
  const b = { nbSite: null };
  flow._confirmAnchor(b);
  assert.strictEqual(b.nbSite, null);
});

// ---- the unanswered-assignment model (IMPORT-63) ------------------------------------------------
//
// One predicate decides what the floor-code sweep may read, what it may write, and what auto-accept
// may fill; one function retires it when the operator answers. Everything downstream — the sweep's
// targets, the anti-clobber rule, the auto-accept guard — is stated in terms of these two, so the
// boundary they draw is the boundary. The rule: a placeholder the *wizard* produced is fair game, a
// decision the *operator* made never is.

test('the three placeholder states are unanswered, and nothing else is', () => {
  assert.strictEqual(ImportFlow.isUnanswered({ type: 'unassigned' }), true);
  assert.strictEqual(ImportFlow.isUnanswered({ type: 'level', num: 2, suggested: true }), true);
  assert.strictEqual(ImportFlow.isUnanswered({ type: 'level', num: 2, autoDefault: true }), true);
  // An operator's floor, a deliberate "(none)", and an auto-accepted floor are all answers — the
  // last one because a sweep must never read over a floor a previous batch already committed, or
  // the pass would never converge.
  assert.strictEqual(ImportFlow.isUnanswered({ type: 'level', num: 2, token: 'l2' }), false);
  assert.strictEqual(ImportFlow.isUnanswered({ type: 'none' }), false);
  assert.strictEqual(ImportFlow.isUnanswered({ type: 'level', num: 2, autoAccepted: true }), false);
  assert.strictEqual(ImportFlow.isUnanswered(null), false);
});

test('an operator answering retires every placeholder marker at once', () => {
  // Four call sites clear these (the card buttons, "+ Add floor", the re-anchor pick, bulk apply).
  // They go through one function precisely so a new marker can't be forgotten by three of them.
  const a = { type: 'level', num: 2, suggested: true, suggestedFrom: 'ocr',
    autoDefault: true, autoAccepted: true };
  ImportFlow.clearUnanswered(a);
  assert.strictEqual(a.suggested, false);
  assert.strictEqual(a.autoDefault, undefined);
  assert.strictEqual(a.autoAccepted, undefined);
  assert.strictEqual(ImportFlow.isUnanswered(a), false);
  assert.strictEqual(a.suggestedFrom, 'ocr');   // provenance is a record, not a marker
});

test('the blind positional default is marked as one, so OCR can tell it from a real answer', () => {
  // The bug: `Level 3` produced by counting drawings and `Level 3` chosen by a human were the same
  // object, so the sweep — which must never overwrite the second — could not read the first, and
  // read nothing at all in floor-type fallback mode.
  const blind = ImportFlow._defaultAssign({ stem: 'ARCH-PLAN' }, 2);
  assert.strictEqual(blind.type, 'level');
  assert.strictEqual(blind.num, 3);
  assert.strictEqual(blind.autoDefault, true);
  assert.strictEqual(ImportFlow.isUnanswered(blind), true);
  // A filename that genuinely names a floor is a suggestion instead — already unanswered, and
  // already flagged, so it takes no second marker.
  const named = ImportFlow._defaultAssign({ stem: 'HQ-L2' }, 0);
  assert.strictEqual(named.suggested, true);
  assert.strictEqual(named.autoDefault, undefined);
  assert.strictEqual(ImportFlow.isUnanswered(named), true);
});

// ---- the auto-accepted set: counted, and reversible in one action -------------------------------

/** A flow receiver with two buildings, carrying only what the auto-accept counts and the undo
 *  read: the mappable list and each building's assignments. */
function flowWithAuto() {
  const flow = Object.create(ImportFlow.prototype);
  const mk = (folder, assign) => ({
    folder, name: folder, pdfs: Object.keys(assign).map(stem => ({ stem })), assign,
  });
  flow.buildings = [
    mk('admin', {
      'a-1': { type: 'level', num: 1, token: 'l1', label: 'L1', autoAccepted: true,
        suggestedFrom: 'ocr', ocrText: 'LEVEL 1', ocrConf: 0.94 },
      'a-2': { type: 'level', num: 2, token: 'l2', label: 'L2' },
    }),
    mk('lib', {
      'l-1': { type: 'level', num: 1, token: 'l1', label: 'L1', autoAccepted: true,
        suggestedFrom: 'ocr', ocrText: 'LEVEL 1', ocrConf: 0.91 },
    }),
  ];
  flow._mappableBuildings = () => flow.buildings;
  return flow;
}

test('the automatic floors are counted per building and across the facility', () => {
  const flow = flowWithAuto();
  assert.strictEqual(flow._autoAcceptedCount(flow.buildings[0]), 1);
  assert.strictEqual(flow._autoAcceptedTotal(), 2);
});

test('undo turns every automatic floor back into a suggestion, keeping the floor itself', () => {
  // This is what makes accepting on the operator's behalf defensible: one action returns the whole
  // facility to exactly the state it would have been in had auto-accept never run. Discarding the
  // matches instead would just make them re-derive work a real read already did.
  const flow = flowWithAuto();
  flow._saveDraft = async () => {};
  flow._stepMap = () => {};
  globalThis.confirm = () => true;
  globalThis.Toast = { show() {} };
  return flow._undoAutoAccepted().then(() => {
    const a = flow.buildings[0].assign['a-1'];
    assert.strictEqual(a.autoAccepted, undefined);
    assert.strictEqual(a.suggested, true);
    assert.strictEqual(a.suggestedFrom, 'ocr');
    assert.strictEqual(a.token, 'l1');                    // the match is kept
    assert.strictEqual(ImportFlow.isUnanswered(a), true); // ...and is somebody's job again
    assert.strictEqual(flow._autoAcceptedTotal(), 0);
    // A floor the operator picked is untouched by the undo, as by everything else here.
    assert.strictEqual(flow.buildings[0].assign['a-2'].suggested, undefined);
  });
});

test('declining the confirmation changes nothing', () => {
  const flow = flowWithAuto();
  flow._saveDraft = async () => { throw new Error('must not save'); };
  globalThis.confirm = () => false;
  return flow._undoAutoAccepted().then(() => {
    assert.strictEqual(flow._autoAcceptedTotal(), 2);
  });
});
