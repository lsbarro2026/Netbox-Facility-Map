'use strict';
/* import-organize.test.js — ImportOrganize's pure statics: the decisions the Buildings step turns
   on, lifted out of the screen so they can be pinned down without a DOM.

   ImportOrganize is overwhelmingly a screen — it renders through `Dom`, fetches, and holds the
   Buildings step's session state, all of which belongs in a browser and is out of this tier by
   design (README.md). What it exposes as pure statics is exactly what a wrong answer would cost
   the operator silently: `regroupPayload` (does Continue regroup or walk on?), `pruneAnswers`
   (which of the operator's answers survive a re-scan, IMPORT-42), `recognizedBannerText`
   (IMPORT-38) and `groupedNeedsAttention`/`regroupReceiptText` (does the regroup landing render at
   all, IMPORT-46 — plus `ImportBind.facilityRowState`, the verdict the predicate reads, and
   `ImportBind.sharedFacilitySite`, whether the facility control is one decision or N, IMPORT-56).
   It also pins what that predicate has to agree with: `ImportFlow.allAnchorsConfirmed`, the second
   half of the fresh Continue gate, and `ImportBind.unconfirmed`, the set the bulk Confirm covers
   (IMPORT-57) — the two gates disagreed about `auto` bindings, which is what let an unreviewed
   guess walk past Continue after the same screen had refused to skip it.

   First up, `regroupPayload`: an **empty** payload is exactly "nothing moves", which is what routes
   Continue forward to floor mapping instead of through the server regroup. A no-op that slips into
   the payload turns every Continue into a spurious regroup (re-scan, model rebuild, draft rewrite);
   a real move that gets dropped silently strands a drawing in the wrong building. The exclusion
   routing matters equally: an excluded drawing must land in the reserved `_excluded` park
   (IMPORT-24), never in whatever destination its row held before. */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadClasses } = require('./load.js');

// import-flow.js rides along for `ImportFlow.EXCLUDED_FOLDER`, and import-bind.js for the
// `ImportBind.facilityRowState` verdict `groupedNeedsAttention` reads (IMPORT-46) — the same
// concatenate-in-dependency-order loading index.html does with its <script> tags.
const { ImportFlow, ImportBind, ImportOrganize } = loadClasses(
  ['import-flow.js', 'import-bind.js', 'import-organize.js'],
  ['ImportFlow', 'ImportBind', 'ImportOrganize']);

test('a drawing staying in its own folder is a no-op and is dropped', () => {
  assert.deepStrictEqual(ImportOrganize.regroupPayload([
    { src: 'Drawings', file: 'a.pdf', dest: 'Drawings', excluded: false },
  ]), {});
});

test('an unanswered drawing (no destination) is dropped, not invented', () => {
  // The old organize step defaulted a blank row to the source folder — the silent mis-assignment
  // IMPORT-18 removed. The builder must never turn "no answer" into a move.
  assert.deepStrictEqual(ImportOrganize.regroupPayload([
    { src: 'Drawings', file: 'a.pdf', dest: null, excluded: false },
    { src: 'Drawings', file: 'b.pdf', dest: undefined, excluded: false },
  ]), {});
});

test('real moves group by destination as <src>/<file> paths, in entry order', () => {
  assert.deepStrictEqual(ImportOrganize.regroupPayload([
    { src: 'Drawings', file: 'ross-1.pdf', dest: 'ross-hall', excluded: false },
    { src: 'Drawings', file: 'ross-2.pdf', dest: 'ross-hall', excluded: false },
    { src: 'Drawings', file: 'annex.pdf', dest: 'annex', excluded: false },
  ]), {
    'ross-hall': ['Drawings/ross-1.pdf', 'Drawings/ross-2.pdf'],
    annex: ['Drawings/annex.pdf'],
  });
});

test('an excluded drawing routes to the reserved park, overriding any destination', () => {
  // Exclusion is the row's answer (IMPORT-24) — a destination left over from before the exclusion
  // must not resurrect as a move.
  assert.deepStrictEqual(ImportOrganize.regroupPayload([
    { src: 'Ross Hall', file: 'legend.pdf', dest: 'annex', excluded: true },
  ]), { [ImportFlow.EXCLUDED_FOLDER]: ['Ross Hall/legend.pdf'] });
});

test('grouped-mode round: cross-folder moves and stays mix correctly', () => {
  // The grouped presentation spans several source folders (IMPORT-34): each entry moves from its
  // OWN folder, and a same-named file in two folders is two distinct sources.
  assert.deepStrictEqual(ImportOrganize.regroupPayload([
    { src: 'Ross Hall', file: 'fl1.pdf', dest: 'Ross Hall', excluded: false },
    { src: 'Ross Hall', file: 'fl2.pdf', dest: 'Annex', excluded: false },
    { src: 'Annex', file: 'fl1.pdf', dest: 'Annex', excluded: false },
    { src: 'Annex', file: 'title.pdf', dest: null, excluded: true },
  ]), {
    Annex: ['Ross Hall/fl2.pdf'],
    [ImportFlow.EXCLUDED_FOLDER]: ['Annex/title.pdf'],
  });
});

/* The answer store's stale-key pruning (IMPORT-42). Everything the operator answers on the Sites
   step now lives on the ImportOrganize instance so a step away and back doesn't erase it — which
   means the answers can outlive the scan they were made under. `pruneAnswers` is the guard: keys
   are `<folder>\n<file>`, so an answer whose drawing the operator removed upstream has to go, or
   it would survive into the Continue gate's counts and the regroup payload as a move of nothing.
   Adding a file must drop nothing — keeping the rest across that round trip is the point. */

const key = (folder, file) => folder + '\n' + file;

/** An answer store with one of everything, so a prune can be checked container by container. */
const stocked = () => {
  const a = ImportOrganize.emptyAnswers();
  const live = key('Drawings', 'fl1.pdf'), gone = key('Drawings', 'fl2.pdf');
  a.assign[live] = { folder: 'ross-hall', label: 'Ross Hall' };
  a.assign[gone] = { folder: 'annex', label: 'Annex' };
  a.accepted.add(live); a.accepted.add(gone);
  a.learned.set(live, { folder: 'ross-hall', label: 'Ross Hall' });
  a.learned.set(gone, { folder: 'annex', label: 'Annex' });
  a.emptied.add(live); a.emptied.add(gone);
  a.excluded.add(live); a.excluded.add(gone);
  a.frames[live] = { scale: 2, x: 1, y: 1 };
  a.frames[gone] = { scale: 3, x: 2, y: 2 };
  a.created.push({ folder: 'New Hall', label: 'New Hall' });
  a.unansweredFirst = true;
  a.attentionFirst = true;
  return { a, live, gone };
};

test('an empty answer store starts with every container present and empty', () => {
  // The constructor, reset() and _regroup all build the store from here, so a container that
  // went missing would surface as an undefined read deep inside _render rather than here.
  const a = ImportOrganize.emptyAnswers();
  assert.deepStrictEqual(a.assign, {});
  assert.deepStrictEqual(a.frames, {});
  assert.strictEqual(a.accepted.size, 0);
  assert.strictEqual(a.emptied.size, 0);
  assert.strictEqual(a.excluded.size, 0);
  assert.strictEqual(a.learned.size, 0);
  assert.deepStrictEqual(a.created, []);
  assert.strictEqual(a.unansweredFirst, false);
  assert.strictEqual(a.attentionFirst, false);
});

test('a key whose drawing is gone is dropped from every keyed container', () => {
  const { a, live, gone } = stocked();
  ImportOrganize.pruneAnswers(a, [live]);
  assert.deepStrictEqual(Object.keys(a.assign), [live]);
  assert.deepStrictEqual(Object.keys(a.frames), [live]);
  assert.deepStrictEqual([...a.accepted], [live]);
  assert.deepStrictEqual([...a.emptied], [live]);
  assert.deepStrictEqual([...a.excluded], [live]);
  assert.deepStrictEqual([...a.learned.keys()], [live]);
  assert.strictEqual(a.assign[gone], undefined);
});

test('the surviving key keeps its value untouched', () => {
  const { a, live } = stocked();
  ImportOrganize.pruneAnswers(a, [live]);
  assert.deepStrictEqual(a.assign[live], { folder: 'ross-hall', label: 'Ross Hall' });
  assert.deepStrictEqual(a.learned.get(live), { folder: 'ross-hall', label: 'Ross Hall' });
  assert.deepStrictEqual(a.frames[live], { scale: 2, x: 1, y: 1 });
});

test('hand-added building names and the ordering toggles are not keyed by file, so they survive', () => {
  // Adding one drawing to the upload and coming back must not lose the buildings named by hand —
  // none of these is an answer *about* a drawing, so no scan can invalidate them. That covers both
  // orderings: the pile's row-level one (IMPORT-33) and the grouped card-level one (IMPORT-58).
  const { a } = stocked();
  ImportOrganize.pruneAnswers(a, []);
  assert.deepStrictEqual(a.created, [{ folder: 'New Hall', label: 'New Hall' }]);
  assert.strictEqual(a.unansweredFirst, true);
  assert.strictEqual(a.attentionFirst, true);
});

test('adding a drawing drops nothing — that round trip is what the store exists for', () => {
  const { a, live, gone } = stocked();
  const added = key('Drawings', 'fl3.pdf');
  ImportOrganize.pruneAnswers(a, [live, gone, added]);
  assert.deepStrictEqual(Object.keys(a.assign).sort(), [live, gone].sort());
  assert.strictEqual(a.excluded.size, 2);
  assert.strictEqual(a.assign[added], undefined);   // nothing invented for the new drawing
});

test('a scan with no drawings left clears every keyed container', () => {
  const { a } = stocked();
  const same = ImportOrganize.pruneAnswers(a, []);
  assert.strictEqual(same, a);   // mutates in place: _render's containers are the live ones
  assert.deepStrictEqual(a.assign, {});
  assert.deepStrictEqual(a.frames, {});
  assert.strictEqual(a.accepted.size, 0);
  assert.strictEqual(a.emptied.size, 0);
  assert.strictEqual(a.excluded.size, 0);
  assert.strictEqual(a.learned.size, 0);
});

test('a same-named drawing in another folder is a distinct answer', () => {
  // The keys carry the folder for exactly this reason (the grouped presentation spans buildings) —
  // pruning one folder's copy must not take the other's answer with it.
  const a = ImportOrganize.emptyAnswers();
  const ross = key('Ross Hall', 'fl1.pdf'), annex = key('Annex', 'fl1.pdf');
  a.excluded.add(ross); a.excluded.add(annex);
  ImportOrganize.pruneAnswers(a, [annex]);
  assert.deepStrictEqual([...a.excluded], [annex]);
});

/* The Buildings step's "what did the upload recognize" banner (IMPORT-38). Pure text over the counts
   `_render` already has to hand, so the pile/grouped wording and the singular/plural + siteplan
   branches are pinned down without a DOM. */

test('grouped: names the building count, pluralized', () => {
  assert.strictEqual(ImportOrganize.recognizedBannerText(3, true, 11, false),
    'Read your upload as 3 buildings.');
  assert.strictEqual(ImportOrganize.recognizedBannerText(1, true, 4, false),
    'Read your upload as 1 building.');
});

test('pile: names the drawing count, pluralized, not the building count', () => {
  assert.strictEqual(ImportOrganize.recognizedBannerText(1, false, 7, false),
    'Read your upload as one unsorted folder of 7 drawings.');
  assert.strictEqual(ImportOrganize.recognizedBannerText(1, false, 1, false),
    'Read your upload as one unsorted folder of 1 drawing.');
});

test('a recognized site plan is appended to either presentation', () => {
  assert.strictEqual(ImportOrganize.recognizedBannerText(2, true, 9, true),
    'Read your upload as 2 buildings, plus a site plan.');
  assert.strictEqual(ImportOrganize.recognizedBannerText(1, false, 5, true),
    'Read your upload as one unsorted folder of 5 drawings, plus a site plan.');
});

/* The regroup landing's auto-advance predicate (IMPORT-46). This is the judgement a *skipped
   screen* turns on, so it is the one thing in this file where a wrong answer costs the operator
   something they can't get back by clicking: too lenient and the wizard walks past an unconfirmed
   auto-match or a pending facility lock they would never see again on the linear walk; too strict
   and the redundant screen this removes comes back. The bar is "confirmed", not "bound" —
   `_allBuildingsBound()` counts an `auto` binding as bound and is deliberately NOT this. */

const FAC = 'main';                       // the active facility slug
const site = (slug, auto) => ({ nbSite: { slug, auto }, nbBuilding: null });
const loc = (slug, auto) => ({ nbSite: { slug, auto }, nbBuilding: { slug: 'bldg-' + slug } });
/** Everything answered: two confirmed Site anchors, both facilities already locked. */
const settled = () => [site('ross-hall', false), site('annex', false)];
const locked = { 'ross-hall': FAC, annex: FAC };
const attention = (buildings, assignments = locked, grouping = 'sitegroup', campusMode = false) =>
  ImportOrganize.groupedNeedsAttention(buildings, assignments, FAC, grouping, campusMode);

test('every building confirmed and locked: nothing to ask, so the landing advances', () => {
  assert.strictEqual(attention(settled()), false);
});

test('an unbound building stops the landing', () => {
  // A hand-typed "New building name" creation arrives with no anchor — the case the existing
  // "Bind every building to NetBox first." gate already refuses to walk past.
  assert.strictEqual(attention([...settled(), { nbSite: null, nbBuilding: null }]), true);
});

test('an auto-bound building stops the landing, though _allBuildingsBound would wave it through', () => {
  // The whole point of the predicate: `auto` is an unconfirmed filename prefill or auto-match, and
  // its header's "Confirm or change" review is exactly what must not be skipped.
  const bs = [site('ross-hall', false), site('annex', true)];
  assert.strictEqual(bs.every(b => b.nbSite), true);   // _allBuildingsBound()'s test — passes
  assert.strictEqual(attention(bs), true);             // ...and is not enough
});

test('a pending facility confirm stops the landing — this screen is its only home', () => {
  // MULTI-6: `_facilityRow` renders nowhere else in the fresh flow, so walking past the
  // "Lock to <facility>" suggestion would strand it for the rest of the import.
  assert.strictEqual(attention(settled(), { 'ross-hall': FAC }), true);
});

test('a site assigned to another facility stops the landing', () => {
  assert.strictEqual(attention(settled(), { 'ross-hall': FAC, annex: 'other-campus' }), true);
});

test('an unreadable assignment map does not stop the landing', () => {
  // A failed load hides the control on every row and has already toasted (`_loadAssignments`);
  // there is nothing on screen to strand, so it must not hold the operator on an empty page.
  assert.strictEqual(attention(settled(), null), false);
});

test('the location grouping offers no facility suggestion, so it never stops the landing', () => {
  // MODEL-8: several facilities share the campus Site, so no lock is suggested at all.
  assert.strictEqual(attention(settled(), {}, 'location'), false);
});

test('campus mode: a Site anchor stops the landing, a building Location does not', () => {
  // `_bindRow`'s advisory — under "Site = campus" a Site anchor means the campus's own Locations,
  // rarely what was meant. Advisory or not, a rendered warning nobody sees breaks the contract.
  assert.strictEqual(attention([loc('campus', false)], { campus: FAC }, 'sitegroup', true), false);
  assert.strictEqual(attention([site('campus', false)], { campus: FAC }, 'sitegroup', true), true);
});

test('two buildings on one campus Site share its single locked assignment', () => {
  // Keyed on the Site (`nbSite.slug`), which for a Location anchor is the campus — one entry
  // answers for both buildings, and neither should read as pending.
  assert.strictEqual(
    attention([loc('campus', false), loc('campus', false)], { campus: FAC }, 'sitegroup', true),
    false);
});

/* `ImportBind.facilityRowState` directly — the verdict the row renders from and the predicate
   above reads, checked once at the source so the two can't be right about different things. */

test('facilityRowState: unbound or unreadable is no control at all', () => {
  assert.strictEqual(ImportBind.facilityRowState(null, locked, FAC, 'sitegroup'), 'none');
  assert.strictEqual(ImportBind.facilityRowState('ross-hall', null, FAC, 'sitegroup'), 'none');
});

test('facilityRowState: assigned here is locked, assigned elsewhere is other, absent suggests', () => {
  assert.strictEqual(ImportBind.facilityRowState('ross-hall', locked, FAC, 'sitegroup'), 'locked');
  assert.strictEqual(
    ImportBind.facilityRowState('ross-hall', { 'ross-hall': 'elsewhere' }, FAC, 'sitegroup'),
    'other');
  assert.strictEqual(ImportBind.facilityRowState('ross-hall', {}, FAC, 'sitegroup'), 'suggest');
});

test('facilityRowState: an explicit assignment still shows under the location grouping', () => {
  // Only the *suggestion* is withheld (MODEL-8) — an assignment that already exists stays visible
  // and revertible.
  assert.strictEqual(ImportBind.facilityRowState('ross-hall', {}, FAC, 'location'), 'none');
  assert.strictEqual(ImportBind.facilityRowState('ross-hall', locked, FAC, 'location'), 'locked');
});

/* `ImportBind.sharedFacilitySite` — whether the facility control is one decision or N (IMPORT-56).
   Wrong in one direction it strands the control on cards that all say the same thing (the 82
   identical blocks this removes); wrong in the other it hoists a single answer over buildings that
   genuinely sit on different Sites, where one click would then silently speak for all of them. */

const named = (slug) => ({ nbSite: { slug, name: slug.toUpperCase() }, nbBuilding: null });

test('sharedFacilitySite: every bound building on one Site hoists, and counts them', () => {
  assert.deepStrictEqual(ImportBind.sharedFacilitySite([named('campus'), named('campus')]),
    { slug: 'campus', name: 'CAMPUS', count: 2 });
  // The campus case proper: under Site = campus every *Location* anchor still keys on the one
  // campus Site above it, which is the whole reason 82 buildings drew 82 identical controls.
  // A nameless record (restored from a draft or a manifest) falls back to the slug, since the
  // hoisted row names the Site out loud — the same `name || slug` `anchorFromRow` resolves.
  assert.deepStrictEqual(
    ImportBind.sharedFacilitySite([loc('campus', false), loc('campus', false), loc('campus', false)]),
    { slug: 'campus', name: 'campus', count: 3 });
});

test('sharedFacilitySite: buildings on different Sites keep their own controls', () => {
  // A facility mixing anchor kinds, or site-as-building folders on separate Sites — each row is
  // then its own question and there is nothing to hoist.
  assert.strictEqual(ImportBind.sharedFacilitySite([named('ross-hall'), named('annex')]), null);
  assert.strictEqual(
    ImportBind.sharedFacilitySite([named('campus'), named('campus'), named('annex')]), null);
});

test('sharedFacilitySite: fewer than two bound buildings is not a hoist', () => {
  // No duplication to remove — a lone control belongs beside the anchor that produced it.
  assert.strictEqual(ImportBind.sharedFacilitySite([]), null);
  assert.strictEqual(ImportBind.sharedFacilitySite([named('ross-hall')]), null);
});

test('sharedFacilitySite: unbound buildings are skipped, never a disagreement', () => {
  // An unbound building shows no facility control at all (`facilityRowState` → 'none'), so it has
  // no copy to hoist — and must not veto the hoist for the buildings that do.
  const unbound = { nbSite: null, nbBuilding: null };
  assert.deepStrictEqual(
    ImportBind.sharedFacilitySite([named('campus'), unbound, named('campus')]),
    { slug: 'campus', name: 'CAMPUS', count: 2 });
  // ...and two unbound buildings around one bound one is still a lone control.
  assert.strictEqual(ImportBind.sharedFacilitySite([unbound, named('campus'), unbound]), null);
});

/* The receipt a skipped screen leaves behind — the operator's only confirmation the regroup did
   what they asked, so it has to name the count and read correctly for one building. */

test('the regroup receipt names the building count, pluralized', () => {
  assert.strictEqual(ImportOrganize.regroupReceiptText(3),
    'Sorted your drawings into 3 buildings, already bound to NetBox. Nothing left to confirm.');
  assert.strictEqual(ImportOrganize.regroupReceiptText(1),
    'Sorted your drawings into 1 building, already bound to NetBox. Nothing left to confirm.');
});

/* One bar, applied to both gates (IMPORT-57). The auto-skip predicate above and the fresh
   Buildings step's Continue used to disagree about exactly one thing: `groupedNeedsAttention`
   stops on an `auto` binding, while Continue asked `_allBuildingsBound()`, which does not. So the
   screen refused to *skip* past an unconfirmed guess and then, once rendered, waved that same
   guess through — the last review point before a whole building's floor keys are committed.
   `ImportFlow.allAnchorsConfirmed` is now the second half of that gate, and these pin the
   relationship in the direction that broke: anything Continue refuses, the landing also refuses. */

const confirmedBar = ImportFlow.allAnchorsConfirmed;

test('anything the Continue gate refuses, the landing also refuses to skip', () => {
  // The implication that was false before this item. Not the converse — see the next test.
  for (const bs of [
    [site('ross-hall', true)],
    [site('ross-hall', false), site('annex', true)],
    [...settled(), { nbSite: null, nbBuilding: null }],
    [loc('campus', true)],
  ]) {
    assert.strictEqual(confirmedBar(bs), false, JSON.stringify(bs));
    assert.strictEqual(attention(bs), true, JSON.stringify(bs));
  }
});

test('the landing stays strictly the broader bar — Continue does not inherit its other stops', () => {
  // Deliberately NOT symmetric. `groupedNeedsAttention` also stops on a pending/foreign facility
  // verdict and on the campus-mode Site-anchor advisory; neither belongs in a hard Continue gate —
  // the facility lock is optional, and nothing new is gated on the organization mode (MODEL-7).
  // "Worth rendering the screen" is a lower bar than "must not proceed".
  const pendingFacility = settled();
  assert.strictEqual(attention(pendingFacility, { 'ross-hall': FAC }), true);
  assert.strictEqual(confirmedBar(pendingFacility), true);

  const siteUnderCampus = [site('ross-hall', false)];
  assert.strictEqual(attention(siteUnderCampus, { 'ross-hall': FAC }, 'sitegroup', true), true);
  assert.strictEqual(confirmedBar(siteUnderCampus), true);
});

test('a fully confirmed set clears both gates together', () => {
  assert.strictEqual(confirmedBar(settled()), true);
  assert.strictEqual(attention(settled()), false);
});

/* What the bulk "Confirm all N" claims to cover (IMPORT-57) — the same `auto` rows the per-card
   Confirm clears one at a time, and exactly the set that holds the Continue gate. */

test('the bulk confirm covers precisely the unconfirmed anchors', () => {
  const guess = site('annex', true);
  const bs = [site('ross-hall', false), guess, { nbSite: null, nbBuilding: null }];
  // An unbound building is NOT in the set: it has no anchor to accept, and its fix is the search.
  assert.deepStrictEqual(ImportBind.unconfirmed(bs), [guess]);
  assert.deepStrictEqual(ImportBind.unconfirmed(settled()), []);
});

test('confirming everything the bulk control names clears the Continue gate', () => {
  // The claim the button makes: one click, and the gate it was holding opens.
  const flow = Object.create(ImportFlow.prototype);
  const bs = [site('ross-hall', true), loc('campus', true), site('annex', false)];
  assert.strictEqual(confirmedBar(bs), false);
  for (const b of ImportBind.unconfirmed(bs)) flow._confirmAnchor(b);
  assert.strictEqual(confirmedBar(bs), true);
});

/* Working an 82-building grouped list (IMPORT-58). Three surfaces, and the one thing that keeps
   them honest is that they all read the same per-building predicate the auto-advance judges by.
   `buildingNeedsAttention` is that predicate, with the single parameter the two callers disagree
   about — whether the facility control was hoisted out of the cards (IMPORT-56). The disagreement is
   deliberate and load-bearing in both directions: `groupedNeedsAttention` must keep asking with
   `null` (a hoisted control is still the screen asking, so a pending lock still stops a skip), while
   the ordering must ask with the hoist (otherwise one pending lock on a shared campus Site marks all
   82 cards as needing attention, and the toggle has no partition left to make). */

const needsAttention = (b, hoisted, assignments = locked, grouping = 'sitegroup', campusMode = false) =>
  ImportOrganize.buildingNeedsAttention(b, assignments, FAC, grouping, campusMode, hoisted);
const HOIST = { slug: 'campus', name: 'CAMPUS', count: 2 };

test('the anchor stops hold whether or not the facility control was hoisted', () => {
  // Unbound, an unreviewed guess, and the campus-mode Site-anchor advisory are all drawn on the
  // card itself, so hoisting the facility control can never quiet them.
  for (const hoisted of [null, HOIST]) {
    assert.strictEqual(needsAttention({ nbSite: null, nbBuilding: null }, hoisted), true);
    assert.strictEqual(needsAttention(site('annex', true), hoisted), true);
    assert.strictEqual(
      needsAttention(site('campus', false), hoisted, { campus: FAC }, 'sitegroup', true), true);
  }
});

test('the facility stop belongs to the card, so the hoist takes it off the card', () => {
  // The card no longer draws that control (IMPORT-56) — there is nothing on it to answer, and the
  // one answer that does exist lives in the preamble above every card equally.
  const b = site('ross-hall', false);
  for (const assignments of [{}, { 'ross-hall': 'elsewhere' }]) {
    assert.strictEqual(needsAttention(b, null, assignments), true);
    assert.strictEqual(needsAttention(b, HOIST, assignments), false);
  }
  // A settled card is settled either way.
  assert.strictEqual(needsAttention(b, null), false);
  assert.strictEqual(needsAttention(b, HOIST), false);
});

test('the auto-skip predicate never hoists — a pending lock still stops the landing', () => {
  // The shape that would break if `groupedNeedsAttention` started passing the hoist: every building
  // on one campus Site, its facility unassigned. The control is hoisted, so no *card* asks — but the
  // screen does, and skipping it would strand the lock for the rest of the import (MULTI-6).
  const shared = [loc('campus', false), loc('campus', false)];
  assert.deepStrictEqual(ImportBind.sharedFacilitySite(shared),
    { slug: 'campus', name: 'campus', count: 2 });
  assert.strictEqual(attention(shared, {}, 'sitegroup', true), true);
  // ...and every card of that same set is quiet, which is exactly what lets the toggle partition.
  assert.strictEqual(shared.every(b => !needsAttention(b, HOIST, {}, 'sitegroup', true)), true);
});

/* `orderByAttention` — the one reordering primitive both presentations use. What it must never do is
   omit: each caller keeps an element map built during the render pass (`rowEls`, `focusSec`), so an
   item that was never built leaves a stale entry and throws on the next interaction. */

test('the partition keeps every item, exactly once', () => {
  const items = ['a', 'b', 'c', 'd'];
  const out = ImportOrganize.orderByAttention(items, (x) => x === 'c');
  assert.deepStrictEqual(out.slice().sort(), items.slice().sort());
  assert.strictEqual(out.length, items.length);
});

test('the partition is stable — each half keeps its original relative order', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  assert.deepStrictEqual(
    ImportOrganize.orderByAttention(items, (x) => x === 'b' || x === 'd'),
    ['b', 'd', 'a', 'c', 'e']);
});

test('an all-true or all-false predicate leaves the order untouched', () => {
  // The no-op cases the toggle is deliberately not offered for — but the partition still has to be
  // an identity rather than a reversal, since a render can run either way.
  const items = ['a', 'b', 'c'];
  assert.deepStrictEqual(ImportOrganize.orderByAttention(items, () => true), items);
  assert.deepStrictEqual(ImportOrganize.orderByAttention(items, () => false), items);
});

test('the partition returns a new array and leaves the caller\'s list alone', () => {
  // `files`/`buildings` are the render pass's own lists — reordering them in place would make the
  // "original order" the toggle promises to come back to unrecoverable.
  const items = ['a', 'b', 'c'];
  const out = ImportOrganize.orderByAttention(items, (x) => x === 'c');
  assert.notStrictEqual(out, items);
  assert.deepStrictEqual(items, ['a', 'b', 'c']);
});

/* The grouped progress line — the answer to "how much of this is left", which a wall of collapsed
   cards otherwise only gives up by counting. Three buckets that account for every building, with the
   empty ones dropped so a finished list reads as finished. */

test('the progress line splits the set into confirmed, guessed and unbound', () => {
  assert.strictEqual(
    ImportOrganize.bindProgressText([site('a', false), site('b', true), site('c', true),
      { nbSite: null, nbBuilding: null }]),
    '1 of 4 buildings confirmed; 2 matched for you, waiting on a look; 1 still needs a building.');
});

test('a finished list says only that, and one building reads singular', () => {
  assert.strictEqual(ImportOrganize.bindProgressText(settled()), '2 of 2 buildings confirmed.');
  assert.strictEqual(ImportOrganize.bindProgressText([site('a', false)]),
    '1 of 1 building confirmed.');
});

test('the unbound clause pluralizes on its own count, not the total', () => {
  assert.strictEqual(
    ImportOrganize.bindProgressText([{ nbSite: null }, { nbSite: null }, site('a', false)]),
    '1 of 3 buildings confirmed; 2 still need a building.');
});

test('a Location anchor counts as confirmed like a Site one — the bucket is the guess flag', () => {
  // Which anchor *kind* a building took is not what this line reports; whether anyone looked at it
  // is. A campus import is all Locations and must not read as nothing confirmed.
  assert.strictEqual(ImportOrganize.bindProgressText([loc('campus', false), loc('campus', true)]),
    '1 of 2 buildings confirmed; 1 matched for you, waiting on a look.');
});
