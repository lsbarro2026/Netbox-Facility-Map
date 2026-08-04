# netbox-facilitymap

A NetBox 4.x plugin that adds a navigable siteplan → building → floor → room map of a
facility, with every room linked to a NetBox **Location**. Import your floor-plan drawings
from inside NetBox, draw and bind room polygons, and the same map renders natively on NetBox
Location pages, alongside a per-room to-do list for tracking work through Planned, In progress,
and Completed.

## Compatibility

| Plugin version | NetBox versions |
|---|---|
| `1.x` | `4.1.7` to `4.6.x` |

## Requirements

Rooms bind to NetBox **Locations**, so your facility lives in NetBox's DCIM tree. Each building
maps in one of two ways: as its **own Site**, where the Site *is* the building (the common case),
or, when a whole **campus is one Site**, as a **building Location beneath that campus Site**. Floors
are the anchor's child Locations and rooms bind to those. The importer auto-suggests a match and
lets you pick either kind, so you can keep your existing NetBox topology. These two anchor modes
are the only supported nesting — a campus hierarchy deeper than one building-Location layer under
its Site isn't modeled.

## Install

Install into NetBox's virtualenv as the `netbox` service user so files stay owned by it:

```bash
sudo -u netbox /opt/netbox/venv/bin/pip install "git+https://github.com/lsbarro2026/Netbox-Facility-Map.git"
```

This installs the latest release. To pin a specific version, append `@<tag>` (for example
`...netbox-facilitymap.git@vX.Y.Z`).

Enable the plugin in `/opt/netbox/netbox/netbox/configuration.py`:

```python
PLUGINS = ["netbox_facilitymap"]
```

Apply the database and static changes, then restart:

```bash
python /opt/netbox/netbox/manage.py migrate
python /opt/netbox/netbox/manage.py collectstatic --no-input
sudo systemctl restart netbox netbox-rq
```

Then open NetBox → **Facility Map** (its own sidebar section, or `/plugins/facilitymap/`) and
import your drawings.

## Update

Re-run the install command with `--upgrade` to move to the latest release, then re-apply the
database and static changes:

```bash
sudo -u netbox /opt/netbox/venv/bin/pip install --upgrade "git+https://github.com/lsbarro2026/Netbox-Facility-Map.git"
python /opt/netbox/netbox/manage.py migrate
python /opt/netbox/netbox/manage.py collectstatic --no-input
sudo systemctl restart netbox netbox-rq
```

Then hard-refresh the map page in your browser (not just reload) to pick up the new frontend
assets.

## Permissions

By default any signed-in NetBox user can **view** the map; editing and importing are gated on
NetBox model permissions, so a viewer without them sees a read-only map.

| To… | Grant this permission on **FacilityMap Blob** |
|---|---|
| Draw and bind room polygons, place and save rack markers, edit the room to-do list | `netbox_facilitymap.change_facilitymapblob` |
| Import or re-render floor-plan drawings, use the Settings page | `netbox_facilitymap.import_facilitymapblob` |

Resetting the map (an irreversible wipe of every upload and rendered image) additionally requires
a **superuser**.

Grant these under **Admin → Permissions**: create a permission with the relevant action on the
**FacilityMap Blob** object type and assign it to the user or group.

## Operating notes

Beyond install and permissions, a few things are worth knowing before you run this in
production — each is covered in full in [`docs/OPERATING.md`](docs/OPERATING.md):

- **Locking down who can view the map.** By default any signed-in user can see every floor plan.
  Two optional, off-by-default settings tighten that: a flat login-plus-permission read gate, and
  a per-Site scoping layer that filters plans/manifest/map data to each user's viewable Sites.
- **Busy instance serving floor-plan images.** If you see intermittent `502`s under load, an
  optional nginx media-offload setting frees the NetBox worker after only the auth check.
- **Backups.** An opt-in `facilitymap_backup`/`facilitymap_restore` management-command pair (or
  the in-app Settings **Export archive** / **Restore from archive…** controls) captures and
  restores just this plugin's data — useful if your NetBox backup doesn't already cover it, or to
  migrate a facility to a new instance.
- **Starting over.** A `facilitymap_wipe` command (or the in-app Settings **Wipe all data…**
  control) deletes this plugin's data — database rows *and* rendered files, all facilities or one —
  returning it to a blank-slate install. Superuser-only, and it never touches the rest of NetBox or
  your backup archives.
- **Consistency check.** A read-only `facilitymap_check` command flags drift that can't self-heal
  (unresolved floor keys, stale placements, orphaned facilities) — safe to run from cron. Draw-only
  rooms are listed too, but never make it exit non-zero.
- **Rooms don't have to exist in NetBox.** Binding a drawn room to a `dcim.Location` unlocks the
  NetBox-integrated half of the plugin — rack and access-point placement, to-dos, and the room
  showing up on its Location page — and the bind picker offers the **child Locations of that
  floor's Location**, so it needs one Location per room. If your NetBox doesn't model rooms that
  way, leave them **draw-only**: they still render, can be named, and are searchable. The map can
  also create the Location for you, if you opt into letting it write to NetBox. See
  `OPERATING.md`.
- **Scripting against the map.** A REST API at `/api/plugins/facilitymap/` covers rooms (full CRUD,
  filterable by site or floor) plus read-only manifest and placement documents, so an external
  system can read or maintain room data without the browser. Rooms edited there and in the map
  editor coexist; `OPERATING.md` explains how the two settle.
- **Localizing device glyphs.** Rack/device glyphs are chosen by matching NetBox device-role
  keywords, which are English by default; a `role_glyphs` setting adds keywords for other
  languages.

## Add-ons

The base install renders the common plan formats: **PDF** and raster images
(`.png/.jpg/.tif/.gif/.bmp/.webp`), and includes **offline floor-code OCR** — after you mark where a
drawing says which floor it is, **Populate with OCR** reads that spot on every drawing and pre-fills
the floor assignments for you to confirm. It runs entirely on your own server, with the recognition
model bundled in the package, so nothing is downloaded or sent anywhere and an **air-gapped install
works out of the box**. Advanced formats are optional add-ons you install on top.
The import picker only offers the formats you have installed, and uploading one whose package
is missing tells you which add-on to add.

| Add-on | Formats | Install |
|---|---|---|
| SVG | SVG vector plans (`.svg`) | `pip install 'netbox-facilitymap[svg]'` |
| CAD | AutoCAD DXF drawings (`.dxf`) | `pip install 'netbox-facilitymap[cad]'` |
| GIS | GIS overlays: Shapefile (`.shp`), GeoJSON (`.geojson`), KML/KMZ (`.kml/.kmz`) | `pip install 'netbox-facilitymap[gis]'` |
| All | every optional format above | `pip install 'netbox-facilitymap[all]'` |
| Visio | Visio diagrams (`.vsdx/.vsd`) | No pip add-on. Install LibreOffice so the `soffice` binary is on `PATH`. |

Combine extras in a single install by comma-separating them, for example
`pip install 'netbox-facilitymap[svg,cad]'`; `[all]` is the shorthand for every optional format.

**Format limits.** Plans must be **2D** — 3D BIM/CAD models (IFC, Revit RVT) aren't imported
directly; export each floor to a PDF or image from the BIM tool first. The CAD add-on reads
**AutoCAD DXF only**, not native DWG — export to DXF first if your drawings are DWG.

## License

Released under the MIT License. See [LICENSE](LICENSE).
