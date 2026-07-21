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
lets you pick either kind, so you can keep your existing NetBox topology.

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

## Add-ons

The base install renders the common plan formats: **PDF** and raster images
(`.png/.jpg/.tif/.gif/.bmp/.webp`). Advanced formats are optional add-ons you install on top.
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

## License

Released under the MIT License. See [LICENSE](LICENSE).
