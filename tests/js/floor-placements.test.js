'use strict';
/* floor-placements.test.js — the room scope the rack panel resolves placed-state over (DEV-12).

   `FloorPlacements.locationRoomIds` answers one question: which room polygons count as "this
   room" when the panel decides whether an item is already placed. It matters because the panel's
   *inventory* is Location-scoped (`store.racksForLocation`) while its placed-state used to be
   polygon-scoped — so a room traced as two polygons listed the same devices twice over and let the
   same device be placed in both. The ✓, the select-vs-place row behaviour, the ✕, the stale list
   and `placeItem`'s duplicate guard now all read this one set, which is exactly why it is worth
   pinning: a drift here silently re-opens the double-placement, it doesn't throw.

   Only this static is covered. Everything else on the class builds real SVG/DOM through
   `Dom`/`DeviceShapes` or needs a constructed editor with a store behind it, and belongs in a
   browser rather than this tier (see README.md). The class loads bare — its module-level consts
   are literals and every global it touches is reached inside a method body. */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadClasses } = require('./load.js');

const { FloorPlacements } = loadClasses(['floor-placements.js'], ['FloorPlacements']);

/** A room as the floor blob carries it — only the two fields the scope reads. */
const room = (id, locId) => ({ id, location: locId == null ? null : { id: locId } });

const ids = (rooms, r) => [...FloorPlacements.locationRoomIds(rooms, r)].sort();

test('a room that is the only polygon on its Location scopes to itself', () => {
  const a = room('r1', 10), b = room('r2', 11), c = room('r3', 12);
  assert.deepStrictEqual(ids([a, b, c], a), ['r1']);
});

test('two polygons bound to one Location scope to both, from either side', () => {
  const a = room('r1', 10), b = room('r2', 10);
  assert.deepStrictEqual(ids([a, b], a), ['r1', 'r2']);
  assert.deepStrictEqual(ids([a, b], b), ['r1', 'r2']);
});

test('rooms on other Locations are excluded', () => {
  const a = room('r1', 10), b = room('r2', 10), other = room('r3', 11);
  assert.deepStrictEqual(ids([a, b, other], a), ['r1', 'r2']);
});

test('three polygons on one Location all scope together', () => {
  const rooms = [room('r1', 10), room('r2', 10), room('r3', 10), room('r4', 99)];
  assert.deepStrictEqual(ids(rooms, rooms[1]), ['r1', 'r2', 'r3']);
});

// The one that would quietly merge unrelated rooms: "no Location" is not a Location two rooms can
// share. An unbound room never reaches the panel (openRackPanel returns early), so this is the
// defensive branch — and the wrong answer here would pool every unbound room on the floor.
test('an unbound room scopes to itself, never to other unbound rooms', () => {
  const a = room('r1', null), b = room('r2', null), bound = room('r3', 10);
  assert.deepStrictEqual(ids([a, b, bound], a), ['r1']);
});

test('a bound room does not pick up unbound rooms', () => {
  const a = room('r1', 10), loose = room('r2', null);
  assert.deepStrictEqual(ids([a, loose], a), ['r1']);
});

test('the room itself is always in scope, even if it is not in the array', () => {
  const a = room('r1', 10);
  assert.deepStrictEqual(ids([room('r2', 11)], a), ['r1']);
  assert.deepStrictEqual(ids([], a), ['r1']);
  assert.deepStrictEqual(ids(undefined, a), ['r1']);
});

test('Location ids match exactly — a different id is a different room', () => {
  const a = room('r1', 10);
  assert.deepStrictEqual(ids([a, room('r2', 100), room('r3', 1)], a), ['r1']);
});
