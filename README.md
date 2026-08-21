<img src="https://raw.githubusercontent.com/lsbarro2026/Netbox-Facility-Map/main/docs/img/icon.png" alt="netbox-facilitymap icon" width="96" align="right">

# netbox-facilitymap

**See every room in your facility on its own floor plan, linked to what NetBox knows about it.**

A NetBox 4.x plugin that adds a navigable siteplan → building → floor → room map, with every room
linked to a NetBox **Location**. Import your floor-plan drawings from inside NetBox, draw and bind
room polygons, and the same map renders on NetBox Location pages alongside a per-room to-do list
that tracks work through Planned, In progress, and Completed.

## Compatibility

| Plugin version | NetBox versions |
|---|---|
| `1.x` | `4.1.7` to `4.6.x` |

## Dependencies

`pip` installs these with the plugin. They are self-contained wheels: no system packages, and no
network access at install or run time.

| Package | Versions | Used for |
|---|---|---|
| [pypdfium2](https://pypi.org/project/pypdfium2/) | `>=4.0.0` | Rendering PDF plans to floor images |
| [Pillow](https://pypi.org/project/Pillow/) | `>=10.0.0` | Raster image decoding and resizing |
| [onnxruntime](https://pypi.org/project/onnxruntime/) | `>=1.17` | Offline floor-code OCR |
| [numpy](https://pypi.org/project/numpy/) | `>=1.24` | Offline floor-code OCR |

Other NetBox plugins: none. External services: none. Optional [add-ons](#add-ons) for advanced
drawing formats pull further packages, and some also need system software (`libcairo`, or
LibreOffice for Visio).

## How your facility maps to NetBox

Rooms bind to NetBox **Locations**, so your facility lives in NetBox's DCIM tree. Each building
anchors in one of two ways: as its own **Site**, where the Site *is* the building (the common case),
or, when a whole campus is a single Site, as a **building Location beneath that campus Site**.
Floors are the anchor's child Locations, and rooms bind to those. The importer suggests a match and
lets you pick either kind, so your existing NetBox topology stays as it is. These two anchor modes
are the only supported nesting; see
[Format and modeling limits](https://github.com/lsbarro2026/Netbox-Facility-Map/blob/main/docs/OPERATING.md#format-and-modeling-limits).

Rooms do not have to exist in NetBox. Binding a drawn room to a `dcim.Location` unlocks the
NetBox-integrated half of the plugin (rack and device placement, to-dos, and the room
appearing on its Location page), and the bind picker offers the child Locations of that floor's
Location, so it needs one Location per room. If your NetBox does not model rooms that way, leave
them **draw-only**: they still render, can be named, and are searchable. The map can also create
the Location for you if you opt into letting it write to NetBox.

## Install

Install into NetBox's virtualenv as root. A stock install's venv is root-owned (`upgrade.sh`
creates it that way), so pip needs root to write there — the `netbox` service user only needs
write access to `media/`, not `site-packages`:

```bash
sudo /opt/netbox/venv/bin/python3 -m pip install "git+https://github.com/lsbarro2026/Netbox-Facility-Map.git"
```

This installs the latest release. To pin a specific version, append `@<tag>` (for example
`...Netbox-Facility-Map.git@vX.Y.Z`).

> **Surviving NetBox upgrades.** `upgrade.sh` reinstalls only the plugins listed in
> `/opt/netbox/local_requirements.txt`. Add the same install target there once so it isn't dropped
> on a NetBox upgrade:
> `echo 'git+https://github.com/lsbarro2026/Netbox-Facility-Map.git' | sudo tee -a /opt/netbox/local_requirements.txt`

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

Re-run the install command with `--upgrade`, then re-apply the database and static changes:

```bash
sudo /opt/netbox/venv/bin/python3 -m pip install --upgrade "git+https://github.com/lsbarro2026/Netbox-Facility-Map.git"
python /opt/netbox/netbox/manage.py migrate
python /opt/netbox/netbox/manage.py collectstatic --no-input
sudo systemctl restart netbox netbox-rq
```

Then hard-refresh the map page in your browser, rather than a plain reload, to pick up the new
frontend assets.

## Permissions

Any signed-in NetBox user can **view** the map by default. Editing and importing are gated on NetBox
model permissions, so a viewer without them sees a read-only map.

| To do this | Grant this permission on **FacilityMap Blob** |
|---|---|
| Draw and bind room polygons, place and save rack markers, edit the room to-do list | `netbox_facilitymap.change_facilitymapblob` |
| Import or re-render floor-plan drawings, use the Settings page | `netbox_facilitymap.import_facilitymapblob` |

Resetting the map, an irreversible wipe of every upload and rendered image, additionally requires a
**superuser**.

Grant these under **Admin → Permissions**: create a permission with the relevant action on the
**FacilityMap Blob** object type and assign it to the user or group.

## Operating notes

A few things are worth knowing before you run this in production. Each is covered in full in
[`docs/OPERATING.md`](https://github.com/lsbarro2026/Netbox-Facility-Map/blob/main/docs/OPERATING.md).

- **[Locking down who can view the map.](https://github.com/lsbarro2026/Netbox-Facility-Map/blob/main/docs/OPERATING.md#security-model)**
  Every signed-in user sees every floor plan by default. Two optional settings tighten that: a flat
  read gate on a view permission, and per-Site scoping that filters plans, manifest, and map data to
  each user's viewable Sites.
- **[Serving floor-plan images at scale.](https://github.com/lsbarro2026/Netbox-Facility-Map/blob/main/docs/OPERATING.md#serving-floor-plan-images-at-scale)**
  If a busy instance shows intermittent `502`s, an optional nginx offload frees the NetBox worker
  after the auth check instead of streaming each image itself.
- **[Backups.](https://github.com/lsbarro2026/Netbox-Facility-Map/blob/main/docs/OPERATING.md#backups)**
  An opt-in command pair, mirrored by in-app Settings controls, captures and restores just this
  plugin's data. Useful if your NetBox backup does not already cover it, or to migrate a facility to
  another instance.
- **[Resetting the map.](https://github.com/lsbarro2026/Netbox-Facility-Map/blob/main/docs/OPERATING.md#resetting-the-map)**
  A superuser-only wipe returns one facility, or the whole install, to a blank slate. It never
  touches anything outside the plugin.
- **[Consistency check.](https://github.com/lsbarro2026/Netbox-Facility-Map/blob/main/docs/OPERATING.md#consistency-check)**
  A read-only command flags drift the plugin cannot self-heal, such as unresolved floor keys, stale
  placements, and orphaned facilities. Safe to run from cron.
- **[Scripting against the map.](https://github.com/lsbarro2026/Netbox-Facility-Map/blob/main/docs/OPERATING.md#rest-api)**
  A REST API at `/api/plugins/facilitymap/` covers rooms with full CRUD, plus read-only manifest and
  placement documents, so an external system can maintain room data without the browser.
- **[Localizing device glyphs.](https://github.com/lsbarro2026/Netbox-Facility-Map/blob/main/docs/OPERATING.md#localizing-device-glyphs)**
  Rack and device glyphs are chosen by matching NetBox device-role keywords, which are English by
  default. A `role_glyphs` setting adds keywords for other languages.

## Add-ons

The base install renders **PDF** and raster images (`.png`, `.jpg`, `.tif`, `.gif`, `.bmp`,
`.webp`), and includes **offline floor-code OCR**: mark where a drawing states which floor it is,
and **Populate with OCR** reads that spot on every drawing to pre-fill the floor assignments for you
to confirm. The recognition model is bundled in the package and runs on your own server, so an
air-gapped install works out of the box.

Advanced formats are optional add-ons installed on top. The import picker offers only the formats
you have installed, and uploading a file whose package is missing names the add-on to add.

| Add-on | Formats | Install | Also needs |
|---|---|---|---|
| SVG | SVG vector plans (`.svg`) | `pip install 'netbox-facilitymap[svg]'` | System `libcairo`, for example `apt install libcairo2` |
| CAD | AutoCAD DXF drawings (`.dxf`) | `pip install 'netbox-facilitymap[cad]'` | System `libcairo` |
| GIS | Shapefile (`.shp`), GeoJSON (`.geojson`), KML/KMZ (`.kml`, `.kmz`) | `pip install 'netbox-facilitymap[gis]'` | Nothing |
| All | Every optional format above | `pip install 'netbox-facilitymap[all]'` | System `libcairo` |
| Visio | Visio diagrams (`.vsdx`, `.vsd`) | No pip add-on | LibreOffice, so the `soffice` binary is on `PATH` |

Combine extras in a single install by comma-separating them, for example
`pip install 'netbox-facilitymap[svg,cad]'`. Without `libcairo` the pip install still succeeds; SVG
and CAD then degrade at render time rather than failing the install.

**Format limits.** Plans must be 2D, and CAD import reads AutoCAD DXF rather than native DWG. See
[Format and modeling limits](https://github.com/lsbarro2026/Netbox-Facility-Map/blob/main/docs/OPERATING.md#format-and-modeling-limits).

## Support and feedback

| For | Go to |
|---|---|
| Bug reports, feature requests, documentation requests | [GitHub issues](https://github.com/lsbarro2026/Netbox-Facility-Map/issues) |
| Questions, install help, and usage discussion | [GitHub discussions](https://github.com/lsbarro2026/Netbox-Facility-Map/discussions) |

When reporting a bug, include your NetBox version, the installed plugin version
(`pip show netbox-facilitymap`), and any relevant lines from the NetBox log.

## License

Released under the MIT License. See
[LICENSE](https://github.com/lsbarro2026/Netbox-Facility-Map/blob/main/LICENSE).

The icon above is © 2026 Liam Sbarro, licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
