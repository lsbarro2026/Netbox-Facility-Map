'use strict';
/* import-build-review.test.js — ImportBuildReview's two pure decisions.

   The dialog itself is DOM (Modal, Dom.el, a live checkbox) and belongs in a browser, out of this
   tier by design. Two things are not: the row copy that names what happens to a floor, and the
   emphasis rule that decides which footer button carries the weight.

   Both matter more than they look. The copy was carried over verbatim from the four native
   `confirm()`s IMPORT-39 replaced, and it is the only place the user is told a room is about to be
   **dropped** rather than moved — a singular/plural slip or a lost "dropped" clause silently
   downgrades a destructive rebuild's description. And `_destructive` is the sole input to the
   `Modal` button convention's one job: weight the safe exit exactly when the affirmative is
   irreversible. */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadClasses } = require('./load.js');

const { ImportBuildReview } =
  loadClasses(['import-build-review.js'], ['ImportBuildReview']);

const destructive = (over) => {
  const f = Object.assign({ orphaned: [], reprojections: [] }, over);
  return ImportBuildReview._destructive(f.orphaned, f.reprojections);
};

// ---- row copy ----

test('a count agrees with its noun in both directions', () => {
  assert.strictEqual(ImportBuildReview._count(1, 'room'), '1 room');
  assert.strictEqual(ImportBuildReview._count(4, 'room'), '4 rooms');
  // `desyncedFloors` supplies the unit per entry — a floor counts rooms, the siteplan hotspots.
  assert.strictEqual(ImportBuildReview._count(1, 'hotspot'), '1 hotspot');
  assert.strictEqual(ImportBuildReview._count(9, 'hotspot'), '9 hotspots');
});

test('a split that loses nothing says only what moved', () => {
  assert.strictEqual(ImportBuildReview._moveText({ moved: 3, dropped: 0 }), '3 rooms moved');
});

test('a split that strands rooms says so, and says how many', () => {
  assert.strictEqual(ImportBuildReview._moveText({ moved: 5, dropped: 2 }),
    '5 rooms moved, 2 outside every region, dropped');
});

test('one moved room is not "1 rooms"', () => {
  assert.strictEqual(ImportBuildReview._moveText({ moved: 1, dropped: 0 }), '1 room moved');
});

// ---- what counts as losing rooms ----

/* A desync is deliberately not an input here: its rooms are kept and only want re-checking, so a
   rebuild whose *only* finding is a desync has nothing to lose and must still weight Rebuild. */
test('a rebuild that loses no rooms is not destructive', () => {
  assert.strictEqual(destructive({}), false);
});

test('an orphaned floor is destructive — its rooms are removed outright', () => {
  assert.strictEqual(destructive({
    orphaned: [{ key: 'a/b', label: 'Admin / L1', count: 2 }],
  }), true);
});

test('a split that strands rooms is destructive too, even with no orphan', () => {
  assert.strictEqual(destructive({
    reprojections: [{ oldKey: 'a/b', label: 'Admin / L1', moved: 4, dropped: 1 }],
  }), true);
});

test('a split that drops nothing is not — every room survives the move', () => {
  assert.strictEqual(destructive({
    reprojections: [{ oldKey: 'a/b', label: 'Admin / L1', moved: 4, dropped: 0 }],
  }), false);
});
