# Changelog

Release notes for the public `netbox-facilitymap` distribution. The public version line
is **independent** of the private dev repo's internal `__version__` — it starts at `1.0.0`
and advances on its own SemVer track (see `VERSIONING.local.md` §3). **This file is the
source of truth for the public version:** the top `## <x.y.z>` heading is the number
`/publish` stamps into the shipped package and tags as `v<x.y.z>`.

Each entry opens with its release tier — _Major_ (breaking), _Minor_ (new
features/enhancements) or _Patch_ (bug fixes) — followed by the narrative, a
**Breaking Changes** section when applicable, and the issues it resolves.

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
