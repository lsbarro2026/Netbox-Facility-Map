"""Read-only consistency check for the plugin's slug-keyed bindings.

Map geometry is keyed to NetBox by **slug string** at the floor level: a room's `floor_key` is
`"<site.slug>/<floor-location.slug>"` and the rendered floor images live under a working dir keyed
by the same slugs (`preprocess.py` is the external source of truth — DESIGN §9 risk 6). Rename a
Site or a floor Location in NetBox and the slug moves, but the manifest floor keys and the stored
`Room.floor_key` values do **not**, so a floor key can stop matching Locations by slug.

Since BIND-1 a room *also* carries `Room.floor_location`, a rename-proof FK to its floor Location,
so a rename no longer orphans a floor's rooms even when the slug drifts. This check reflects that:
an unresolvable-by-slug `floor_key` whose rooms still carry that FK is **not** reported (the
binding is intact) — only genuinely orphaned keys (manifest-only keys, or rooms with no
`floor_location`) surface as drift.

`run_checks()` surfaces that drift as a structured, **read-only** report — it never writes,
deletes, or re-maps anything (renames are legitimate; the fix is human judgement). Two surfaces
share it: the `facilitymap_check` management command (CI/ops) and the Settings-page panel
(`views.SettingsView`).

The `Room.location` FK is `on_delete=SET_NULL` (`models.py`), so a room whose bound Location was
**deleted** and one that was **never bound** both read as `location IS NULL` — indistinguishable
from the FK alone. So the honest, detectable categories are three: unresolved floor keys (the
rename/orphan case), unbound rooms (the SET_NULL / never-bound case), and stale placements (a map
marker whose rack/device PK is gone).
"""

from dataclasses import dataclass, field

from django.db.models import Count
from dcim.models import Device, Location, Rack, Site

from .facilities import (
    EDITOR_KINDS, imported_facility_slugs, orphaned_facility_keys, suggested_target,
)
from .models import FacilityMapBlob, Room
from .storage import read_manifest


@dataclass
class UnresolvedFloorKey:
    """A `floor_key` (from a Room row and/or the manifest) whose `<site>/<floor>` slugs no
    longer resolve to a live Site + child Location — the rename/orphan drift."""
    floor_key: str
    room_count: int
    in_manifest: bool
    reason: str   # 'no such site' | 'no floor Location under site'


@dataclass
class UnboundRoom:
    """A room with geometry but no `location` binding (`location_id IS NULL`) — covers both a
    never-bound room and one whose bound Location was deleted (SET_NULL nulled the FK)."""
    floor_key: str
    room_id: str
    label: str


@dataclass
class StalePlacement:
    """A rack/device placement on the map whose NetBox object no longer exists (a dead marker)."""
    floor_key: str
    kind: str
    object_id: object
    label: str


@dataclass
class OrphanedFacility:
    """A facility key that holds map data but no current Site resolves to — the drift a
    `facility_grouping` change (or a Site gaining/losing a grouping) leaves behind, stranding the
    editor blobs under a key the app no longer queries. Unlike the other categories this one is
    *recoverable in-app*: the Settings panel reassigns it to a live facility."""
    facility: str
    blob_kinds: list      # the editor `kind`s stored under this facility (annotations/siteplan/…)
    suggested: str        # the facility its own data now points at, preselected in the picker ('' = none)


@dataclass
class HealthReport:
    """The consistency report — four drift lists plus a convenience `has_drift` flag. Both the
    command and the Settings panel render this without re-querying."""
    unresolved_floor_keys: list = field(default_factory=list)
    unbound_rooms: list = field(default_factory=list)
    stale_placements: list = field(default_factory=list)
    orphaned_facilities: list = field(default_factory=list)

    @property
    def has_drift(self):
        return bool(self.unresolved_floor_keys or self.unbound_rooms
                    or self.stale_placements or self.orphaned_facilities)


def _scoped(manager, user):
    """`manager` restricted to what `user` may view, or unrestricted when `user is None`.

    Mirrors the `sync_rooms` idiom (`frontend_api.py`): `user=None` is the trusted operator path
    (the management command, like `facilitymap_import`) and sees everything; a real user (the
    Settings panel) is object-permission scoped. A caveat follows from that scoping — a Location
    or rack the user may not *view* reads as "unresolved"/"stale" for that user; the report never
    leaks such objects, and the command path (`user=None`) is the authoritative-accuracy one."""
    return manager.restrict(user, 'view') if user is not None else manager.all()


def _manifest_floor_keys():
    """The set of floor keys **every** facility's rendered manifest currently lists
    (`<dir>/<floor id>`), unioned across facilities, or an empty set when none are readable. The
    manifest is a runtime render artifact, so an absent one is a normal state, not an error —
    mirrors every other reader (`previews._manifest_pages`, `template_content.SiteFloors`), all
    sharing the mtime-memoized `storage.read_manifest`. Floor keys embed the globally-unique site
    slug, so unioning across facilities never conflates two facilities' floors."""
    keys = set()
    for facility in imported_facility_slugs():
        manifest = read_manifest(facility)
        if manifest is None:
            continue
        keys |= {
            f"{building['dir']}/{floor['id']}"
            for building in manifest.get('buildings', [])
            for floor in building.get('floors', [])
            if building.get('dir') and floor.get('id')
        }
    return keys


def _check_floor_keys(user):
    """Floor keys (Room rows ∪ manifest) that don't resolve to a live Site + child Location."""
    rooms = _scoped(Room.objects, user)
    counts = {r['floor_key']: r['n']
              for r in rooms.values('floor_key').annotate(n=Count('id'))}
    manifest_keys = _manifest_floor_keys()
    floor_keys = set(counts) | manifest_keys
    if not floor_keys:
        return []

    # Bulk resolution sets: the (site slug, floor Location slug) pairs that exist, and the set of
    # live site slugs (to tell "no such site" from "site exists, floor Location gone"). Mirrors
    # how `template_content.SiteFloors` keys floor Locations by slug under a Site.
    site_slugs = set(_scoped(Site.objects, user).values_list('slug', flat=True))
    resolved = set(_scoped(Location.objects, user)
                   .filter(site__isnull=False)
                   .values_list('site__slug', 'slug'))
    # Floor keys the BIND-1 rename-proof FK still binds: any room with a non-null `floor_location`
    # resolves its floor Location by FK regardless of the (possibly renamed) slug in `floor_key`, so
    # the key isn't actually orphaned even when its slugs don't resolve. Skip those below.
    fk_covered = set(_scoped(Room.objects, user)
                     .filter(floor_location__isnull=False)
                     .values_list('floor_key', flat=True))

    rows = []
    for floor_key in sorted(floor_keys):
        site_slug, _, floor_slug = floor_key.partition('/')
        if (site_slug, floor_slug) in resolved or floor_key in fk_covered:
            continue
        reason = 'no such site' if site_slug not in site_slugs else 'no floor Location under site'
        rows.append(UnresolvedFloorKey(
            floor_key=floor_key,
            room_count=counts.get(floor_key, 0),
            in_manifest=floor_key in manifest_keys,
            reason=reason,
        ))
    return rows


def _check_unbound_rooms(user):
    """Rooms with geometry but no `location` binding (`location_id IS NULL`)."""
    rows = _scoped(Room.objects, user).filter(location__isnull=True).order_by('floor_key', 'room_id')
    return [UnboundRoom(floor_key=r.floor_key, room_id=r.room_id, label=r.label) for r in rows]


def _check_stale_placements(user):
    """Placements on the map whose referenced rack/device PK is no longer in NetBox.

    Scans **every** facility's `kind='placements'` blob (all facilities share the global rack/device
    namespace, so a single bulk PK resolution covers them all) and every floor's `placements[]`
    (mirroring `previews.placement_markers` / `placement_for_object`), then bulk-resolves which
    referenced PKs still exist. A placement with no `id` is malformed rather than stale, so it's
    skipped here (out of scope for this check)."""
    entries = []          # (floor_key, kind, id, label) for every placement carrying an id
    rack_ids, device_ids = set(), set()
    for blob in FacilityMapBlob.objects.filter(kind='placements'):
        for floor_key, floor in (blob.data or {}).items():
            for p in ((floor or {}).get('placements') or []):
                pid = p.get('id')
                if pid is None:
                    continue
                kind = 'rack' if p.get('kind') == 'rack' else 'device'
                entries.append((floor_key, kind, pid, p.get('label') or ''))
                (rack_ids if kind == 'rack' else device_ids).add(pid)

    present_racks = set(_scoped(Rack.objects, user).filter(pk__in=rack_ids)
                        .values_list('pk', flat=True)) if rack_ids else set()
    present_devices = set(_scoped(Device.objects, user).filter(pk__in=device_ids)
                          .values_list('pk', flat=True)) if device_ids else set()

    rows = []
    for floor_key, kind, pid, label in entries:
        present = present_racks if kind == 'rack' else present_devices
        if pid not in present:
            rows.append(StalePlacement(floor_key=floor_key, kind=kind, object_id=pid, label=label))
    return rows


def _check_orphaned_facilities():
    """Facility keys holding map data that no current Site resolves to (the grouping-drift orphan).

    Authoritative and unscoped — unlike the other checks it takes no `user`: which facilities are
    *reachable* is an install-wide fact (`facilities.reachable_facilities`), and mis-scoping it by a
    viewer's permissions could wrongly flag a facility as orphaned. Each row carries the editor
    `kind`s stored under the key and the target its own data now points at (`suggested_target`)."""
    rows = []
    for key in sorted(orphaned_facility_keys()):
        kinds = sorted(FacilityMapBlob.objects.filter(facility=key, kind__in=EDITOR_KINDS)
                       .values_list('kind', flat=True).distinct())
        rows.append(OrphanedFacility(facility=key, blob_kinds=kinds, suggested=suggested_target(key)))
    return rows


def run_checks(user=None):
    """Run every consistency check and return a `HealthReport`.

    `user=None` (the management command) sees all data; a real `user` (the Settings panel) is
    scoped to what they may view — see `_scoped`. The orphaned-facility check is the exception: it's
    unscoped/authoritative (see `_check_orphaned_facilities`). Purely read-only: no row is written,
    deleted, or re-mapped."""
    return HealthReport(
        unresolved_floor_keys=_check_floor_keys(user),
        unbound_rooms=_check_unbound_rooms(user),
        stale_placements=_check_stale_placements(user),
        orphaned_facilities=_check_orphaned_facilities(),
    )
