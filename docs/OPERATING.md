# Operating notes

This extends the main [`README.md`](../README.md) with the operational detail of running the plugin
day to day. Install, update, and the base permission model are covered in the README. Start there.

## Security model

Map access is split into permission tiers, enforced server-side:

| To do this | Requires |
|---|---|
| View the map, floor plans, and the manifest | Being signed in (default) |
| Draw and bind room polygons, place and save rack markers, edit the room to-do list | `netbox_facilitymap.change_facilitymapblob` |
| Import or re-render floor-plan drawings, use the Settings page | `netbox_facilitymap.import_facilitymapblob` |
| Reset the map (irreversible wipe of every upload and rendered image) | A **superuser** |

By default, **any signed-in user can see every floor plan**. Reads are not object-permission scoped,
so a user whose object permissions hide a Location still sees every floor-plan pixel. (Room
*markers* are separately scoped to what the viewer's object permissions allow; the background
drawing is not.) Two optional settings tighten this, both off by default:

- **`require_view_permission`** additionally requires the
  `netbox_facilitymap.view_facilitymapblob` permission for all map reads: the map page, the
  authenticated media and manifest, and the panels embedded on `dcim` pages. Editors and importers
  keep read access automatically. This is a flat, model-level gate, granted or denied per user or
  group, not per-object scoping.
- **`scope_reads_to_sites`** layers on top of the gate above and *additionally* filters the
  floor-plan pixels, the manifest, and the underlying map data (room polygons, labels, arrows,
  rack and device markers, to-do lists) to the NetBox **Sites** each user's object permissions allow
  them to view. A hidden Site's floors are simply absent from every response, so there is no route
  to geometry whose pixels are gated. It is fail-closed: a building whose stored Site no longer
  matches a Site the user may view is hidden. Editing under scoping is safe. An editor who can see
  only some Sites can still save without destroying the buildings they were not shown, because the
  server merges those back in.

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

By default the NetBox worker streams each floor-plan image or PDF itself. On a busy instance, many
concurrent image loads (or slow clients) can tie up every worker and surface as intermittent
`502 Bad Gateway` errors while navigating. This is not confined to the map, since the plugin also
renders panels on `dcim` Location, device, rack, and site pages. If you see this, offload the byte
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

Authentication is preserved. The worker still runs the permission and traversal check before handing
off, and the `internal` location is only ever reached via that worker-issued header, so nginx never
serves an image from a request that skipped the worker. After enabling it, requesting the internal
prefix directly in a browser should return `404` (proof the offload did not open a public path),
while loading a `dcim.location` page should return the image quickly.

If floor plans still look soft when zoomed out, the in-app **Settings ▸ Import & data ▸ High
quality floor plans** toggle re-renders at a higher resolution on the next import or rebuild
(existing plans keep serving their current images until re-imported). It costs roughly double the
memory and time per sheet, so it is opt-in rather than a default.

## Backups

You probably do not need this if you already back up the whole NetBox instance, since a database
dump plus a copy of `MEDIA_ROOT` already covers the plugin's data. If you do not, the plugin ships
an opt-in, self-contained backup of just its own data: the `FacilityMapBlob` and `Room` rows, and
the working-dir files.

Run it from the command line:

```bash
python /opt/netbox/netbox/manage.py facilitymap_backup
```

or from the map's **Settings** page, which has **Export archive** and **Restore from archive…**
controls that produce and consume the same archive. Each run writes one timestamped archive to
`backup_dir` (default `<MEDIA_ROOT>/facilitymap-backups`) and prunes the oldest ones once that
directory exceeds `backup_max_mb` (default 1024), always keeping the newest. Nothing is scheduled
automatically; add a cron line if you want it to run nightly.

**Restore is destructive.** It replaces *all* current rooms and working-dir files with the archive's
contents. It is meant for two cases: a same-instance rollback, or migrating a facility to a new
NetBox instance. Rooms are re-linked to their NetBox Location by slug, re-resolved against the
target's live Locations, so recreate the same Sites and Locations (same slugs) on the target first.
If a binding cannot be re-resolved the restore aborts without changing anything and lists what is
missing, so a partial migration never empties the target.

```bash
python /opt/netbox/netbox/manage.py facilitymap_restore --src /path/to/facilitymap-backup-*.tar.gz
sudo systemctl restart netbox netbox-rq
```

It prompts for confirmation unless you pass `--noinput`. `--allow-unresolved` overrides the abort
above, restoring anyway and leaving the unresolvable rooms unbound. The **Settings** page has no
equivalent, so use the command line when you need it.

## Resetting the map

To return the plugin to a blank-slate install, or to clear one facility and re-import it, wipe its
data. This deletes database rows *and* rendered files, and it cannot be undone:

```bash
python /opt/netbox/netbox/manage.py facilitymap_wipe --all              # every facility
python /opt/netbox/netbox/manage.py facilitymap_wipe --facility <slug>  # one facility
python /opt/netbox/netbox/manage.py facilitymap_wipe --facility ""      # the default facility
```

`--all` removes every `FacilityMapBlob` row (the per-facility documents *and* the install-wide
settings), every `Room` with its to-dos, and the whole working directory. `--facility` narrows to one
facility and leaves the install-wide settings and other facilities alone. Exactly one of the two
flags is required, so a bare invocation destroys nothing. The command prompts for confirmation
unless you pass `--noinput`, and `--backup` writes a `facilitymap_backup` archive first.

Nothing outside the plugin is touched: no `dcim` rows, and no backup archive under `backup_dir`. The
in-app equivalent is **Settings ▸ Wipe all data…**, which is restricted to superusers.

## Consistency check

The map binds geometry to NetBox by slug at the floor level. Renaming a Site or floor Location
through the NetBox UI, bulk edit, CSV import, or REST API is handled automatically: the plugin
re-keys itself to follow the rename, with no re-import needed. What is not covered is a rename that
bypasses NetBox's normal object save path entirely, such as a custom script calling `bulk_update()`
directly, or a direct SQL edit. A read-only check surfaces any such drift without changing your
data:

```bash
python /opt/netbox/netbox/manage.py facilitymap_check
```

It reports unresolved floor keys, unbound rooms, stale rack and device placements, and orphaned
facility data, and exits non-zero when it finds any, so it is safe to run from cron or CI for an
alert. The same report also appears in-app on the **Settings** page.

## REST API

The plugin mounts a REST API at `/api/plugins/facilitymap/`, under NetBox's own API, so a NetBox API
token authenticates it and NetBox object permissions apply:

| Endpoint | Methods | Returns |
|---|---|---|
| `rooms/` | Full CRUD, including bulk | Room objects, with NetBox brief mode and change logging |
| `manifest/` | `GET` | The facility manifest: buildings, floors, and their images |
| `placements/` | `GET` | Rack and device placements for the facility |

`rooms/` accepts the same filters as the UI room list: `site`, `site_id`, `location_id`,
`floor_location_id`, `floor_key`, `facility`, `room_id`, `label`, `alias`, and the `q` free-text
search. Prefer `floor_location_id` in a script: it is a foreign key that survives a rename, whereas a
`floor_key` value hardcoded in a script goes stale when the plugin re-keys itself to follow one.

Rooms maintained through the API and rooms drawn in the map editor coexist. A write derives the
room's floor binding from `floor_key`, and it bumps the concurrency token of the floor it touched, so
an editor holding an older copy of that floor is told to reload rather than saving over the API's
write.

The read-only endpoints honour exactly the same gates as the browser: `require_view_permission` and
`scope_reads_to_sites` both apply, so a token never reads past the scoping a session would hit.

## Localizing device glyphs

Racks and devices placed on a floor draw a schematic glyph chosen by keyword-matching the device's
NetBox role, and, as a fallback, its name. The built-in keywords are English, so a facility whose
device roles are named in another language falls back to an undifferentiated generic box. Add your
own keywords with `role_glyphs`:

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

Your keywords are tried before the built-in English ones, so this adds a vocabulary rather than
replacing the defaults, and can override a built-in classification. They match whole words rather
than substrings, and are case, accent, and hyphen insensitive. Restart the NetBox workers after
editing them.

## Format and modeling limits

- **2D plans only.** The importer accepts a PDF or a raster or vector image per floor. 3D
  building-information models (IFC) and native Revit (RVT) files are not accepted directly. Export
  each floor to a PDF or image from the BIM tool first.
- **CAD import is DXF only**, not native DWG. Export to DXF from your CAD tool first.
- **Two building-anchor modes, no deeper nesting.** A building anchors either as its own NetBox
  Site, or as a Location one level beneath a campus Site. A campus hierarchy deeper than that single
  Location layer is not modeled.
