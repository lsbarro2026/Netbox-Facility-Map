# JS unit tests: the DOM-free frontend logic

The frontend is framework-free vanilla JS with **no build step**, and most of it is DOM/SVG
rendering that only a browser can meaningfully exercise. A slice of it, though, is pure logic:
filename scoring, geometry, ordering rules, a bounded stack. That slice is what this tier tests.

Its first reason to exist is measurement. `ImportMatch` scores a drawing filename against a list of
candidate buildings, and "is this scoring change more accurate than the last one?" is not a question
anyone can answer by hand across a realistic set of filenames. `fixtures/import-match-corpus.json`
plus the four corpus tests in `import-match.test.js` turn it into a number, including a precision
bar the suite asserts rather than merely reports.

The same corpus carries a second harness: the **session replay**, which measures the split step's
*correction memory* (the buildings the operator picks by hand, re-applied to sibling drawings within
one import). A static filename corpus can't score a feature that learns from picks, so the replay
expands each case into the three-floors-per-drawing pile a real import arrives as and runs it past a
simulated operator, counting hand-picks with the memory and without. It asserts the two things that
matter (the saving is real, and no recalled building is ever wrong) and prints both, so a change to
the rung is judged the same way a change to the scorer is.

A third harness measures the **collective evidence pass** (what one pile of drawings tells the
matcher about the rest of itself). Its unit is not a filename but a *pile*, so it has its own fixture
section, `groups`, and the same two-sided treatment: rows that the pile should lift into a prefill,
and rows it must be *forbidden* to lift however loudly their siblings agree.

## Running it

```bash
cd tests/js && node --test
```

That is the whole thing: **no npm, no `package.json`, no `node_modules`, no build step**. The
runner is `node:test`, built into Node 18+. The suite also runs automatically as part of the pytest
suite via `tests/test_js_suite.py`, which skips cleanly when node is absent, so one `pytest`
invocation still covers everything and there is no second CI lane.

Run `node --test` **from this directory with no path argument**. Node resolves a bare directory
argument as a *module* path, so `node --test tests/js` fails with `MODULE_NOT_FOUND`; the
no-argument form scans the working directory recursively instead.

## Conventions

**Location.** `netbox-facilitymap/tests/js/`, beside the pytest suite. Note this is *inside* the
published package subtree, so everything here is public: keep it free of facility-specific names.

**File naming.** One `<source-file-stem>.test.js` per class under test, which is one of the patterns
`node --test` discovers (`**/*.test.js`). Helpers (`load.js`) and `fixtures/*.json` match no
discovery glob, so they are never mistaken for test files. Do not name a directory `test/`; node
treats *everything* under such a directory as a test file.

**Loading a class.** The shipped files carry no `export` / `module.exports`: `index.html` loads
them as plain `<script>`s, so every class is a browser global. `load.js` reads a shipped file as
text and evaluates it inside a `new Function`, which is the same scope a `<script>` tag gives it:

```js
const { loadClasses } = require('./load.js');
const { ImportMatch } = loadClasses(['import-match.js'], ['ImportMatch']);
```

The `static/` tree stays **byte-identical**. Do not add `export`/`module.exports` to a shipped file
to make it importable. That is the build-system creep coding-standard #3 exists to prevent, and it
would change how the browser loads the file for the benefit of a test.

**Classes with dependencies.** Concatenate the sources in dependency order, exactly as `index.html`
loads them; a later file then sees the earlier file's classes as ordinary bindings:

```js
const { Geom, Store } = loadClasses(['lib.js', 'store.js'], ['Geom', 'Store']);
```

**Browser globals.** `load.js` exposes `stubWindow(map)`, which installs a plain
`globalThis.window = { MAP: map }` for the handful of classes that read `window.MAP`. That is the
only stubbing this tier does.

**Fixtures.** JSON under `fixtures/`, `require`d directly. Keeping a corpus as data rather than
inline literals is what lets the *same* cases drive both a JS test and a Python one (see the
lockstep note below).

## What belongs here, and what does not

**In scope:** logic that is a pure function of its arguments. Today that is `import-match.js`,
`import-bulk.js`'s static matchers plus its filename→floor guess, `import-cards.js`'s
`_buildingFieldError`, `import-build-review.js`'s row copy + `_destructive`, `lib.js`'s `Geom` and
the stateless half of `Util`, `device-shapes.js`'s classification, `floor-view-filter.js`'s
selection model, `floor-placements.js`'s `locationRoomIds`, `editor-pointer.js`'s press-intent +
gesture-latch half, `editor.js`'s
`Editor._movedIndex` + `Editor._snappedDelta`, `todo-model.js`, `todo-chips.js`'s **rules tier**,
and `undo-stack.js`.

`floor-view-filter.js` is the editor bundle's first entry here, and it earns it the same way
`todo-chips.js` does: its `matches`/`isAp`/`anyOn` statics are a pure function of their arguments,
the *single* predicate that decides both whether a marker draws and whether the room holding it
highlights, so a drift between those two is exactly what a test can catch and a glance can't. The
popover half of the class builds real DOM and stays out, as do `shows`/`visibleRoomIds`, which need
a constructed editor with a store behind it.

`floor-placements.js` earns its one entry the same way, and it is the narrowest here:
`locationRoomIds` alone. That static decides which room polygons count as "this room" when the rack
panel resolves placed-state: the set the ✓, the select-vs-place row behaviour, the ✕, the stale
list and `placeItem`'s duplicate guard all share (DEV-12). It is worth pinning because its failure
is silent rather than loud: get the scope wrong and a device already on the floor is offered for
placing a second time, which is the bug that motivated extracting it. Everything else on the class
draws SVG or needs a constructed editor, and stays out.

`editor-pointer.js` is that bundle's second entry, and it draws the line mid-class the way
`import-cards.js` does. `EditorPointer.pressIntent` is a pure static (it decides what a
`pointerdown` arms from five booleans and nothing else), while `gestureClick`,
`_pastDragThreshold` and the Space hand-tool flag read only their own fields plus a back-ref whose
whole surface here is one `classList.toggle`. That is where the interesting rule lives: a left
press arms a pan *wherever* it lands, so the drag threshold and the click guard are the only
things standing between panning the map and clicking the room under the cursor, and a drift there
is exactly what a browser check performed once would stop catching. `bind()`'s pointer cascade
around them is DOM and stays out: exercising press→move→release for real means a browser driver,
which this tier deliberately does not have.

`editor.js` is the bundle's third entry, and the narrowest: only its two pure statics.
`Editor._movedIndex` is the index arithmetic behind the shape-layering actions (ROOM-4:
front/back/up/down, scoped by ROOM-5 to the shape's **overlap group**, so it takes that group's
index list rather than an array length and steps *between its members*, hopping non-overlapping
shapes); `Editor._snappedDelta` is how a whole-shape or whole-wall drag picks
its one rigid translation delta (FLOOR-9: neighbouring vertex → neighbouring edge → grid multiple).
Both were split out of their callers precisely so they could be pinned here without a constructed
editor, because the failures they guard against are silent: an off-by-one or a missing clamp
restacks the wrong room rather than throwing, and a dropped snap priority leaves a room a few px
from where it visibly clicked into place. The `_movedIndex` block also replicates `reorderShape`'s
two-splice pair in four lines, so the *order* a click produces is pinned and not just the index
feeding it. That is the one bit of mirrored logic here, and it must be kept in step with
`editor.js`. The geometry that builds the group (`Geom.polysOverlap`/`overlapGroup`) is pinned next
door in `lib.test.js`, where the cases that matter are the flush ones snapping makes routine.

`_snappedDelta` takes its whole world as arguments (the
surface size, the neighbouring polygons, a snap radius, and a grid stand-in whose only method is the
`snap` copied verbatim from `grid.js`), so the test stubs *inputs*, never a DOM (the real
`GridController` persists to `localStorage`, which this tier has no business faking). It is also the
one test here that loads two sources, `lib.js` before `editor.js`, because it calls `Geom.projSeg`.
Everything else on `Editor` stays out: rendering, pointer plumbing and a live store are a browser's
job, and so is the pointer wiring that feeds `_snappedDelta` its per-frame delta.

`import-ocr-sweep.js`'s **model half** (`targets`, `applyResults`, `pickLine`, `coverage`) is in for
`ImportBulk.suggestFloors`'s reason: it reads and writes the building model and touches no DOM,
while the batch loop, the toasts and the status strip around it are out. That half is where a
background pass can quietly corrupt an import, so it is the half worth pinning: reading a drawing
it shouldn't, reading one forever, overwriting an answer given mid-flight, or, since IMPORT-70,
picking the wrong line of a multi-line caption as the floor code.

`import-cards.js` shows where the line falls inside one class rather than between classes: almost
all of it renders cards through `Dom` and is out of scope, but `_buildingFieldError` decides. It
reads a plain building object and a `_floorBuildings()` list off a stub back-ref, and returns a
string. `ImportBulk.suggestFloors` is in for the same reason despite being an instance method: it
reads and writes the building model and touches no DOM. **The test for "does this belong here" is
whether it needs a browser, not whether it happens to be `static`.**

`todo-chips.js` is the illustrative half-and-half case: its rules (`roomName`, `priorityLabel`,
`dueTitle`, `avatarSplit`, `AVATAR_MAX`) are pure and covered here, while its chip *builders* call
`Dom.el` and are not. Loading it works because the file touches `Dom` only inside method bodies, never
at class-definition time, which is the line drawn just below.

**Out of scope, deliberately:** the ~16,000 lines of DOM/SVG rendering, meaning the editors,
`app.js`, and the import flow's render paths. Testing those means a browser driver such as
Playwright: a heavy real dependency with genuine maintenance cost, and its own decision to make, not
something to smuggle in here. **Do not add one to this tier.** The value of this tier comes from it
staying cheap.

If a class is *almost* pure but touches `document` at class-definition or call time, leave it out
rather than building a fake DOM to prop it up. `DeviceShapes.glyph()` is the worked example: it
builds real SVG elements, so only its classification half is tested here and the Python mirror
covers the glyph geometry. `store.js` is the other: its class body loads fine, but every useful
method needs a constructed `Store`, whose constructor reads `window.MAP` and `localStorage`. It is a
reasonable future candidate if those seams are ever separated, not a reason to stub a browser now.

## The two-way lockstep with Python

`device-shapes.js` and `netbox_facilitymap/device_shapes.py` are a hand-maintained 1:1 mirror (no
build step, so the rules are duplicated rather than shared). That mirror used to be asserted only
from the Python side, which catches a Python-side drift but never a JS-side one.

`fixtures/device-glyph-cases.json` is now the single corpus **both** sides run:

- JS: `device-shapes.test.js`
- Python: `tests/test_device_shapes.py::test_shared_corpus_*`

Cases are stored shape-neutrally (flat `role_slug` / `role_name` / `name` / `label` / `kind`),
because the two ports take different item shapes; each side has a small adapter, and each adapter
names the other in a comment. **Add a classification rule to one port and you must add it to the
other**: the corpus is what makes forgetting fail loudly, in whichever direction it happened.

## The `ImportMatch` corpus, and how to read a failure

`fixtures/import-match-corpus.json` holds one plausible campus's buildings plus the filename cases.
Each case records `want`, the building a **human** says the filename means, and `minTier`, the
weakest confidence that is acceptable. Four tests read those filename cases:

| Test | Meaning of a failure |
|---|---|
| *every case with one right answer resolves to it* | A real regression. The formula got worse. |
| *an ambiguous stem never reaches the bulk-prefill bar* | A real regression, and the dangerous kind: a stem that does not say which building it means is now confident enough to be applied in bulk, and a wrong building silently re-anchors every floor key beneath it. |
| *known gaps are still gaps* | **Good news.** A case marked `knownGap` now matches. Drop `knownGap` from it (and tighten its `minTier` to what the matcher now achieves) to bank the improvement. |
| *scorecard*, the precision assertion | Something the split step would **prefill unasked** points at the wrong building. This is the failure mode the whole corpus exists to catch. |

A third *case* shape sits beside `matches` and `ambiguous`: **`groups`**, for the collective evidence
pass (`bestOfAll`), read by five tests of its own. A group
is a *pile* (stems that arrive at the split step together and are scored in one call) because the
effect under test is cross-file and cannot be seen a filename at a time. Its rows carry the same
`want` / `minTier`, plus `maxTier` for "the right answer, but it must stay out of the automatic path"
and `want: null` for "must never prefill, whatever the rest of the pile scores". **Do not flatten a
group into `matches`**: the rows are only meaningful together, and half of them are stating what the
pass is forbidden to do:

| Test | Meaning of a failure |
|---|---|
| *every pile resolves the way its rows say it should* | The evidence rules changed what a pile concludes. |
| *nothing a pile prefills points at the wrong building* | The precision bar, restated for the batch, and the one that matters most, since this pass exists to prefill *more*. |
| *a pile only ever raises confidence…* | The step's answers now depend on which drawings happened to be uploaded together. |
| *…never redirects a confident row* / *a row the pile lifted says so* | A confident answer moved in company, or `corroborated` stopped tracking what the pass actually did. |

The `scorecard` test also *prints* two numbers rather than asserting them, so two formulas can be
compared on the same corpus instead of argued about:

```
ImportMatch scorecard over 32 candidates: 26/27 matched (96%), 1 known gap(s); tiers {...}
  auto-accept precision 22/22 (100%), coverage 22/40 stems prefilled
collective evidence over 5 pile(s), 17 rows: 2 row(s) lifted into a prefill by their pile, 3 held back from one
```

Read those last two together, in that order. "Lifted" is the pass earning its keep; "held back" is it
staying honest, and a change that grows the first while shrinking the second is the regression to
watch for.

**Read precision before coverage.** A formula that matches three more filenames and prefills one
wrong building is a *regression*, not an improvement: recall is a convenience here and precision is
a correctness property. Coverage is the number to optimize only once precision is pinned at 100%.

The candidate list is deliberately **large and repetitive**: several `Hall`s, four `Center`s, a
North/South/East sibling set, two `Shop N`s. The scorer weights every token by its inverse document
frequency over that list, so a corpus of eight unique names would measure nothing about what
actually goes wrong on a real campus: that `hall` and `center` are near-useless discriminators while
`astronomy` is decisive. **Adding a candidate changes existing results by design.** `Admin-FL2` is
the worked example: it is `weak` here purely because `Business Administration Building` exists, and
was `strong` under the eight-name corpus this replaced. That is the matcher being honest, not drift.

When changing the scorer, **add the filenames that motivated the change to the corpus first**, as
`knownGap` cases if they do not match yet. The gaps are a wish list as much as an inventory.

One thing to keep straight: `ImportMatch` maps a filename to a **building**, while `ImportBulk`'s
matchers map one to a **floor**. A drawing filename carries both signals and the two are easy to
conflate. Keep floor-axis cases in `import-bulk.test.js`.
