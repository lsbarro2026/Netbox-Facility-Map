# Changelog

Release notes for the public `netbox-facilitymap` distribution. The public version line
is **independent** of the private dev repo's internal `__version__` — it starts at `1.0.0`
and advances on its own SemVer track (see `VERSIONING.local.md` §3). **This file is the
source of truth for the public version:** the top `## <x.y.z>` heading is the number
`/publish` stamps into the shipped package and tags as `v<x.y.z>`.

Each entry opens with its release tier — _Major_ (breaking), _Minor_ (new
features/enhancements) or _Patch_ (bug fixes) — followed by the narrative, a
**Breaking Changes** section when applicable, and the issues it resolves.

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
