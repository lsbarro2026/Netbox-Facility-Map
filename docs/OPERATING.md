# Operating notes

This extends the main [`README.md`](../README.md) with the operational details of running the
plugin day to day: locking down read access, serving floor-plan images at scale, backups, the
consistency check, and localizing device glyphs. Install, update, and the base permission model
are covered in the README — start there first.

## Security model

Map access is split into permission tiers, enforced server-side:

| To… | Requires |
|---|---|
| View the map, floor plans, and the manifest | Being signed in (default) |
| Draw and bind room polygons, place and save rack markers, edit the room to-do list | `netbox_facilitymap.change_facilitymapblob` |
| Import or re-render floor-plan drawings, use the Settings page | `netbox_facilitymap.import_facilitymapblob` |
| Reset the map (irreversible wipe of every upload and rendered image) | A **superuser** |

By default, **any signed-in user can see every floor plan** — reads are not object-permission
scoped, so a user whose object permissions hide a Location still sees every floor-plan pixel.
(Room *markers* are separately scoped to what the viewer's object permissions allow; the
background drawing is not.) Two optional settings tighten this, both off by default:

- **`require_view_permission`** — additionally requires the
  `netbox_facilitymap.view_facilitymapblob` permission for all map reads (the map page, the
  authenticated media/manifest, and the panels embedded on `dcim` pages). Editors and importers
  keep read access automatically. This is a flat, model-level gate — grant or deny per user or
  group — not per-object scoping.
- **`scope_reads_to_sites`** — layers on top of the gate above and *additionally* filters the
  floor-plan pixels, the manifest, and the underlying map data (room polygons, labels, arrows,
  rack/device markers, to-do lists) to the NetBox **Sites** each user's object permissions allow
  them to view. A hidden Site's floors are simply absent from every response, so there's no
  route to geometry whose pixels are gated. It's fail-closed: a building whose stored Site no
  longer matches a Site the user may view is hidden. Editing under scoping is safe — an editor
  who can see only some Sites can still save without destroying the buildings they weren't shown;
  the server merges those back in.

Set either in `PLUGINS_CONFIG`:

```python
PLUGINS_CONFIG = {
    "netbox_facilitymap": {
        "require_view_permission": True,  # gate all map reads on view_facilitymapblob
        "scope_reads_to_sites": True,     # additionally filter reads to viewable dcim.Sites
    },
}
```

Both take effect on the next worker restart.

## Serving floor-plan images at scale

By default the NetBox worker streams each floor-plan image/PDF itself. On a busy instance, many
concurrent image loads (or slow clients) can tie up every worker and surface as intermittent
`502 Bad Gateway` errors while navigating — not just on the map, since the plugin also renders
panels on `dcim` Location/device/rack/site pages. If you see this, offload the actual byte
transfer to nginx via `X-Accel-Redirect`:

```python
PLUGINS_CONFIG = {
    "netbox_facilitymap": {
        "x_accel_redirect": True,
        "x_accel_location": "/facilitymap-internal/",  # must match the nginx location below
    },
}
```

```nginx
# In the NetBox server block. `alias` must point at the plugin's working directory
# (default <MEDIA_ROOT>/netbox_facilitymap, or your configured work_dir).
location /facilitymap-internal/ {
    internal;
    alias /opt/netbox/netbox/media/netbox_facilitymap/;
}
```

Authentication is preserved: the worker still runs the permission and traversal check before
handing off, and the `internal` location is only ever reached via that worker-issued header —
nginx never serves an image from a request that skipped the worker. After enabling it, requesting
the internal prefix directly in a browser should return `404` (proof the offload didn't open a
public path), while loading a `dcim.location` page should return the image quickly.

If floor plans still look soft when zoomed out, the in-app **Settings ▸ Import & data ▸ High
quality floor plans** toggle re-renders at a higher resolution on the next import/rebuild (existing
plans keep serving their current images until re-imported); it costs roughly double the memory and
time per sheet, so it's opt-in rather than a default.

## Backups

You probably don't need this if you already back up the whole NetBox instance (a database dump
plus a copy of `MEDIA_ROOT` already covers the plugin's data). If you don't, the plugin ships an
opt-in, self-contained backup of just its own data — the `FacilityMapBlob`/`Room` rows and the
working-dir files.

Run it from the command line:

```bash
python /opt/netbox/netbox/manage.py facilitymap_backup
```

or from the map's **Settings** page, which has **Export archive** / **Restore from archive…**
controls that produce and consume the same archive. Each backup run writes one timestamped
archive to a configurable directory and prunes the oldest ones once that directory exceeds a
configurable size cap, always keeping the newest. Nothing is scheduled automatically — add a cron
line if you want it to run nightly.

**Restore is destructive** — it replaces *all* current rooms and working-dir files with the
archive's contents. It's meant for two cases: a same-instance rollback, or migrating a facility to
a new NetBox instance. Rooms are re-linked to their NetBox Location by slug, re-resolved against
the target's live Locations, so recreate the same Sites/Locations (same slugs) on the target
first. If a binding can't be re-resolved the restore aborts without changing anything and lists
what's missing, so a partial migration never empties the target.

## Consistency check

The map binds geometry to NetBox by slug at the floor level. Renaming a Site or floor Location
through the NetBox UI, bulk edit, CSV import, or REST API is handled automatically — the plugin
re-keys itself to follow the rename, no re-import needed. What isn't covered is a rename that
bypasses NetBox's normal object save path entirely (a custom script calling `bulk_update()`
directly, or a direct SQL edit). A read-only check surfaces any such drift without changing your
data:

```bash
python /opt/netbox/netbox/manage.py facilitymap_check
```

It reports unresolved floor keys, unbound rooms, stale rack/device placements, and orphaned
facility data, and exits non-zero when it finds any — safe to run from cron or CI for an alert.
The same report also appears in-app on the **Settings** page.

## Localizing device glyphs

Racks and devices placed on a floor draw a schematic glyph chosen by keyword-matching the
device's NetBox role (and, as a fallback, its name). The built-in keywords are English, so a
facility whose device roles are named in another language falls back to an undifferentiated
generic box. Add your own keywords with `role_glyphs`:

```python
PLUGINS_CONFIG = {
    "netbox_facilitymap": {
        "role_glyphs": {
            "switch":   ["commutateur", "conmutador"],
            "firewall": ["pare-feu", "cortafuegos"],
            "ap":       ["borne wifi", "punto de acceso"],
        },
    },
}
```

Your keywords are tried before the built-in English ones (so this adds a vocabulary rather than
replacing the defaults, and can override a built-in classification), match whole words rather than
substrings, and are case/accent/hyphen-insensitive. Restart the NetBox workers after editing it.

## Format & modeling limits

- **2D plans only.** The importer accepts a PDF or a raster/vector image per floor. 3D
  building-information models (IFC) and native Revit (RVT) files aren't accepted directly —
  export each floor to a PDF or image from the BIM tool first.
- **CAD import is DXF only**, not native DWG. Export to DXF from your CAD tool first.
- **Two building-anchor modes, no deeper nesting.** A building anchors either as its own NetBox
  Site, or as a Location one level beneath a campus Site. A campus hierarchy deeper than that
  single Location layer isn't modeled.
