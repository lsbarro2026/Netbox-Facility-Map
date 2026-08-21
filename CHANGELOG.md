# Changelog

Release notes for the public `netbox-facilitymap` distribution. The public version line
is **independent** of the private dev repo's internal build number — it starts at `1.0.0`
and advances on its own SemVer track. **This file is the source of truth for the public
version:** the top `## <x.y.z>` heading is the number `/publish` stamps into the shipped
package and tags as `v<x.y.z>`.

Each entry opens with its release tier — _Major_ (breaking), _Minor_ (new
features/enhancements) or _Patch_ (bug fixes) — followed by the narrative, a
**Breaking Changes** section when applicable, and the issues it resolves.

## 2.2.1 — An install command that works on a stock NetBox, and packaging metadata that survives setuptools
_Patch release — bug fixes._

**The documented install command could not work on a default NetBox install.** Every install and
update command shipped with a `sudo -u netbox` prefix, on the assumption that the plugin should be
installed as the service user that runs NetBox. But a stock NetBox virtualenv is created by
`upgrade.sh` as root, so `/opt/netbox/venv` and its `site-packages` are owned by `root`. Running
pip as `netbox` hit `Defaulting to user installation because normal site-packages is not writeable`
and either failed outright or silently installed the package into `~netbox/.local/`, which a
virtualenv never reads — leaving an admin with a plugin that pip reported as installed and NetBox
could not import. The Install and Update commands now use NetBox's own documented form,
`sudo /opt/netbox/venv/bin/python3 -m pip install …`, and the surrounding text states the actual
reason root is needed: the venv itself is root-owned, and the `netbox` service user only ever needs
write access to `media/`, not to `site-packages`.

**The README now says how to survive a NetBox upgrade.** `upgrade.sh` reinstalls only the plugins
listed in `/opt/netbox/local_requirements.txt`, so a hand-run `pip install` is silently erased by
the next NetBox upgrade — a step the install instructions never mentioned. A new *Surviving NetBox
upgrades* note tells you to add the same install target to that file once.

**Packaging metadata modernized ahead of a setuptools deprecation.** Installing the plugin emitted
`SetuptoolsDeprecationWarning`s: `pyproject.toml` declared its licence as a TOML table
(`license = { text = "MIT" }`) and carried the now-redundant `License :: OSI Approved :: MIT
License` classifier. Both are deprecated by setuptools 77 and later, with a hard cutoff after which
such builds stop working altogether. The licence is now the plain SPDX expression `"MIT"` and the
classifier is gone; a clean wheel build is warning-free and still records the `LICENSE` file in the
built metadata.

_Resolved issues: none tracked (pre-public-repo)._

## 2.2.0 — Explicit room stacking, custom device presets, and a category-based view filter
_Minor release — new features and enhancements._

Where `2.1.0` was about getting a big facility onto the map, this release is about controlling
what you see once it's there and drawing rooms the way a real floor plan actually nests them —
one room carved out of another, a hallway cutting through an open space, a rack room and an
access point sharing a floor without stepping on each other.

**Rooms and building areas get an explicit stacking order.** Overlapping polygons used to draw
and hit-test in whatever order the map happened to load them, re-sorted alphabetically on every
reload. Every shape panel now carries CAD/Illustrator-style **Back / Down / Up / Front** controls
over a "Layer N of M" readout scoped to just the shapes it actually overlaps, so the buttons and
the count mean something. Drawing a container room around rooms you've already placed no longer
buries them: the new room is automatically sent behind whatever it fully contains, with a toast
and a one-click **Keep on top** to undo it. A run of edge cases that made the punch-out (the hole
a container cuts around a room sitting inside it) disappear are fixed too — a shared wall, a room
hidden by the View filter, a NetBox Location traced as two polygons, a device placed in one half
of a two-polygon room — so a room reads and behaves as one room no matter how it was drawn.

**The floor toolbar's "Add access point" button is now a general device tool**, driven by
admin-defined presets: pick an icon from a roughly 45-glyph library, a NetBox device role, a name
template and numbering scope, and which fields the placement dialog should ask for. The toolbar
shows every enabled preset in one **Add device** menu, and existing access-point installs keep
working with no manual step. Device markers are now filled with their NetBox device role's own
color instead of one flat gray, so a floor full of markers reads at a glance instead of by label,
with contrasting glyph detail on pale roles so they don't wash out. (The speaker icon was also
redrawn — it now reads as a PA horn rather than a music speaker.)

**The floor's view-mode highlight control is now a multi-select View filter.** Instead of one
all-or-nothing dropdown, check any combination of Racks, Access points, and NetBox device roles
and the map shows only the rooms and markers matching what's checked — and the selection now
survives a page reload instead of resetting to "All" every time.

**Dragging is more forgiving.** Moving a whole room or a wall now snaps against neighbouring
rooms, not just the grid, matching how single-vertex drags already worked — so two rooms whose
shared wall was hand-snapped together can actually be rejoined by dragging one of them. The map
now pans from anywhere (previously only empty background could be grabbed), Space is a dedicated
hand tool, and the rectangle tool can now start a box on top of an existing room. The import
wizard's "split this drawing into floors" screen was also rebuilt on the same drawing engine the
room and building editors use — freeform polygon regions, snapping, undo, and pan/zoom, instead
of a separate box-only gesture.

**Import wizard refinements.** A building with exactly one drawing and exactly one NetBox floor
now matches them automatically even when their captions disagree (a `Floor 1` drawing against a
`Floor 0` Location, say). Toggling "High quality floor plans" in Settings now offers to rebuild
the map on the spot instead of leaving you to find the rebuild button yourself. The floor-code
reader is more accurate against busy title blocks — it no longer blends a facility's logo into
the text above a floor code, or reads a nearby print date instead of the actual floor number. And
the import overview's progress panel no longer reports a facility as finished before it has
actually been reviewed.

**Documentation.** The public README gained the sections the certification checklist expects — a
dependency table, a support/feedback route, the certification attribution — and a general
editorial pass.

_Resolved issues: none tracked (pre-public-repo)._

## 2.1.0 — Importing a whole campus, floor codes read off the drawings, and a map that works on a phone
_Minor release — new features and enhancements._

Where `2.0.0` grew the map into something you work on, this release is about getting a **large,
real facility into it** — and then reaching it from wherever you are. The import flow was rebuilt
around campus-scale estates of eighty-plus buildings, the plugin now reads floor codes off the
drawings themselves instead of asking you to type them, how your NetBox is organized is something
you declare rather than something the plugin guesses, and every surface follows NetBox's theme and
fits a phone screen.

**An import flow built for a campus, not a building.** Hand the wizard a facility one folder at a
time and each drop joins the upload instead of racing it. Drawings are matched to buildings as a
**batch**, so the pile settles what no single filename can, and the matcher learns from the
buildings you pick as you go. The buildings step is workable at eighty-odd buildings: a searchable,
filterable list rather than a one-at-a-time carousel, with a **show the ones needing attention
first** toggle, per-building progress in the map step, and facility-wide questions asked once
instead of once per building. Buildings missing from NetBox can be created inline from the picker,
and a drawing that doesn't belong on the map can be left out — and put back later.

**Floor codes are read off the drawing.** Mark the region of a sheet where the floor code is
printed, and the plugin reads it for every building in the background, in streaming batches that
never block you. Reads are matched to a building's real floors by **storey ordinal** rather than by
spelling, so `Basement`/`Ground Floor`/`Second Floor` line up with `B1`/`L1`/`L3` without a lookup
table; a marked region re-anchors itself onto a differently-shaped sheet; a boxed multi-line caption
is no longer fused into one unreadable band; and a read the plugin is confident about is applied for
you rather than waiting on a click. Every result remains a **suggestion** on a field you can
overwrite — your answers always win.

**Declare how your NetBox is organized.** How a facility maps onto NetBox's org models is now an
explicit, per-facility declaration instead of an inference. A third grouping — **Location subtree** —
supports the common estate that models an entire campus as one Site with a building per Location,
and a facility that runs campus → building → **wing/zone** → floor now imports without breaking
floor detection. Which facility a Site belongs to can be assigned outright rather than derived, so a
site's identity survives a rename or a re-key. Changing a grouping previews exactly what it moves
and offers to fix anything it strands, instead of warning that your data may disappear.

**The map on a phone.** Below 720px the plugin lays out search-first and full-width: the siteplan
buildings index reflows, the top toolbar folds its overflow into a menu instead of running off the
edge, the search bar is pinned and no longer crushed or zoomed into by iOS Safari, a floor's to-do
list gets its own page rather than squeezing the map, and the facility-wide to-do rollup was rebuilt
for a thumb.

**Light and dark, following NetBox.** Every plugin surface now tracks NetBox's own theme rather than
rendering a fixed light palette. Rendered floor plans and siteplans are light-background documents,
so they are **framed** in dark mode rather than inverted, while the embedded panels on `dcim` pages
theme with the page around them.

**Device glyphs that speak your facility's language.** Unracked device markers read distinctly by
role and are sized as one cohesive set, drawn from vendored Lucide icons; role matching tolerates how
a role is actually written; and an operator-supplied keyword vocabulary means role names don't have to
be English for a glyph to be chosen. Searching a rack-mounted device by name now finds it and takes
you to its rack. Dense floors stop stacking their device labels, and label layout no longer slows down
as a floor fills up.

**A REST API you can drive headlessly.** Rooms can be bound to a floor by a rename-proof
`floor_location` and filtered by where they are, two read-only documents (`manifest/` and
`placements/`) tell a script what buildings, floors and placements exist, and a room created over
REST is no longer swept out from under you by the next editor save.

**Operating, recovering, and staying honest.** A `facilitymap_wipe` management command resets the
plugin to a blank slate without touching anything outside it. Per-Site read scoping now covers the
map data, not just the images. A failed restore can no longer destroy the working directory it was
replacing. Assets are cache-busted on the plugin version, and a stale `collectstatic` copy fails at
boot with an actionable message instead of misbehaving silently.

**Editing, undo, and drawing parity.** A `?` panel puts the whole keyboard and mouse vocabulary one
click away; deleting a room, arrow, note, building area or device marker offers an Undo. The siteplan
now draws building areas with the same toolkit floors use for rooms. Bulk triage in the floor-mapping
step can assign a real floor — including auto-assign by name pattern, scoped to one building or all of
them — instead of only clearing assignments. Swapping the siteplan for a differently-shaped drawing
offers to re-fit its hotspots. And a room with **no** NetBox Location bound is now a supported,
first-class state rather than something the consistency check flags as a problem.

**Install note — offline OCR ships in the base install.** Reading floor codes requires no second
install step and no network: `onnxruntime` and `numpy` are now base runtime dependencies alongside
`pypdfium2` and `Pillow`, and the recognition model is vendored in the package. Both are
self-contained wheels needing no system libraries. A platform without an `onnxruntime` wheel
degrades — the runtime capability gate hides the feature — rather than failing to install.

_Resolved issues: none tracked (pre-public-repo)._

## 2.0.0 — Campus topology, task tracking, and a real in-map editor
_Major release — new features and enhancements._

The first major release since the initial public launch. It grows the plugin from a map you
navigate into a surface you work on: a facility-wide task tracker, placement of real NetBox
devices onto floor plans, campus-scale building topology, CAD-style room editing, and a
backup/restore path that survives a move between NetBox instances.

**Campus topology — anchor a map to a Site or to a building Location.** An install that models a
whole campus as one Site with a building per `dcim.Location` can now be imported end to end: the
import flow binds drawings to either anchor, and the building's own NetBox page gains a floor
picker and an access-point counter scoped to that building.

**Facility-wide task tracking.** Rooms carry to-dos with priority, notes, due dates, and multiple
assignees. Add one from a room on the floor plan, edit it in place, flip its status inline, and
roll everything up into a groupable, sortable facility-wide page reachable from the siteplan or a
home-dashboard widget. The whole feature is an opt-in add-on, off by default.

**Access-point placement.** Arm the access-point tool, click a room, and the plugin creates a real
NetBox device there — with a templated, auto-suggested name that can carry the room's slug or the
asset tag, a remembered device type, and a per-building numbering scope. It is a single switch in
Settings with a configuration page of its own.

**CAD-style room and rack editing.** Drag a whole room to reposition it, grab an edge to resize it,
snap to the grid, and draw rooms enclosing an interior void such as a courtyard or passthrough.
Racks and devices are visible and draggable in plain edit mode and travel with the room they sit
in; nested rooms no longer paint over each other's highlight.

**Search that finds anything.** One search bar spans buildings, placed rooms, racks, and devices
*and* NetBox inventory that was never placed on the map. Room search aliases bridge the names
printed on a plan and the names used in NetBox, and any result can open its NetBox page instead of
the map. A standalone search widget is available for the dashboard.

**Safer saves and recoverable edits.** Saves are sharded per floor, so edits to different floors
no longer conflict. Undo survives a save and now covers the siteplan editor, an autosave draft
protects unsaved work from a crash or a failed save, and leaving edit mode with unsaved changes
prompts first.

**Backup, restore, and rename-safety.** Backup/restore is a genuine cross-instance migration path,
re-linking rooms and to-do assignees by portable slug and username rather than by raw database ID.
Renaming a Site or a floor Location no longer breaks the map, and a floor whose plan cannot be
resolved now explains why instead of rendering blank.

**Sharper plans, readable labels, georeferenced overlays.** Floor plans can render at high quality,
with clear diagnostics when a render hits its memory budget instead of failing opaquely. Labels
stay legible as you zoom out, device glyphs on NetBox page embeds match the live map, and imported
GIS overlays can be placed precisely with control points rather than an approximate fit-to-frame.

**A floor picker you can tune.** The building floor-selection page gained a View menu: toggle
previews, size cards on a slider, switch between grid and list, choose card orientation, sort, and
show or hide badges — with per-building overrides.

**Breaking Changes**
- Inline NetBox Location creation is no longer gated by the `allow_location_create`
  `PLUGINS_CONFIG` setting, which is now ignored. It is a runtime **Write mode** toggle on the
  in-app Settings page instead, applying immediately with no worker restart. An install that
  enabled the old flag must re-enable the feature from Settings → Write mode after upgrading. The
  per-user `dcim.add_location` object permission is unchanged and still enforced server-side.

_Resolved issues: none tracked (pre-public-repo)._

## 1.0.0 — Initial public release
_Minor release — new feature._

First public release of **netbox-facilitymap**, a NetBox 4.x plugin that adds a navigable
**siteplan → building → floor → room** map of a facility, with every room linked to a NetBox
**Location**.

**Facility map.** A single installable plugin renders a zoomable siteplan down through building
floors to individual rooms; room polygons are stored resolution-independently (normalized 0..1)
and bound to `dcim.Location`, so the same map renders natively on NetBox Location pages.

**In-app PDF import.** The plugin ships generic with no facility content — import your own
floor-plan drawings from inside NetBox through a guided flow that rasterizes PDFs to floor
images and a manifest. Untrusted files are parsed only in an isolated render subprocess.

**Location-linked rooms.** A relational `Room` model ties map geometry to NetBox Locations, with
a REST API and native rendering on Location detail pages.

**Format add-ons.** The base install renders PDF and common raster formats; optional extras add
SVG, DXF/CAD, and GIS overlays, offered only when their decoder is installed.

_Resolved issues: none tracked (pre-public-repo)._
