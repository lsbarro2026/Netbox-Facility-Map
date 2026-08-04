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
from the FK alone. So the honest, detectable categories are four: unresolved floor keys (the
rename/orphan case), unbound rooms (the SET_NULL / never-bound case), stale placements (a map
marker whose rack/device PK is gone), and orphaned facilities (data under a facility key no Site
resolves to, HEALTH-1).

**Three of the four are drift; unbound rooms are not (DOC-12).** A room with geometry and no
`location` is a **draw-only room** — a supported, deliberate state, not a fault. Binding a room
requires the deploying org to model one `dcim.Location` per room, parented to the floor Location
(§7), and plenty of installs legitimately don't: they draw the floor plan for wayfinding and bind
only the rooms that hold gear. Counting those rooms as drift made `facilitymap_check` exit non-zero
forever on such an install, which turns the check into noise nobody reads. So `unbound_rooms` is
**reported but not counted**: `run_checks` still enumerates it (permission-scoped like the rest) and
both surfaces still show it, but `has_drift` — and therefore the command's exit code — ignores it.

That is the deliberate **inverse** of HEALTH-11, which forbids the other asymmetry: a category that
counts toward the exit code but prints nothing is a reporting bug, because the operator gets a
failure with nothing to act on. Printed-but-not-counted has no such problem — the information is
right there, it simply isn't an alert. Don't "restore symmetry" by folding `unbound_rooms` back into
`has_drift`; that is the bug this note exists to prevent.
"""

from dataclasses import dataclass, field

from django.db.models import Count
from dcim.models import Device, Location, Rack, Site

from .facilities import (
    EDITOR_KINDS, facility_for_location, imported_facility_slugs, orphaned_facility_keys,
    suggested_target,
)
from .models import FacilityMapBlob, Room, parse_floor_key
from .storage import read_manifest


@dataclass
class UnresolvedFloorKey:
    """A `floor_key` (from a Room row and/or the manifest) whose `<site>/<floor>` slugs no
    longer resolve to a live Site + child Location — the rename/orphan drift."""
    floor_key: str
    room_count: int
    in_manifest: bool
    reason: str   # 'no such site' | 'no building Location under site' | 'no floor Location under site'


@dataclass
class UnboundRoom:
    """A **draw-only** room: geometry with no `location` binding (`location_id IS NULL`) — covers
    both a never-bound room and one whose bound Location was deleted (SET_NULL nulled the FK).

    **Informational, not drift (DOC-12).** Unlike the other three categories this one is a
    supported state rather than a fault, so it is reported but excluded from `has_drift` — see the
    module docstring for why, and why folding it back in would be a regression."""
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
    """The consistency report — four finding lists plus a convenience `has_drift` flag. Both the
    command and the Settings panel render this without re-querying."""
    unresolved_floor_keys: list = field(default_factory=list)
    unbound_rooms: list = field(default_factory=list)
    stale_placements: list = field(default_factory=list)
    orphaned_facilities: list = field(default_factory=list)

    @property
    def has_drift(self):
        """True when the report holds an actual **fault**. `unbound_rooms` is deliberately absent:
        a draw-only room is a supported state, not drift (DOC-12 — see the module docstring). This
        flag drives the command's exit code and the Settings panel's all-clear line, so adding it
        back would make every draw-only install permanently 'unhealthy'."""
        return bool(self.unresolved_floor_keys
                    or self.stale_placements or self.orphaned_facilities)


def _scoped(manager, user):
    """`manager` restricted to what `user` may view, or unrestricted when `user is None`.

    Mirrors the `sync_rooms` idiom (`frontend_api.annotations`): `user=None` is the trusted operator path
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
    # how `template_content.SiteFloors` keys floor Locations by slug under a Site. A second,
    # parent-scoped set resolves **Location-anchored** 3-segment keys (MODEL-3): the floor Location
    # lives under a *building* Location, so it's keyed by (site slug, building slug, floor slug) —
    # two buildings under one campus can share a floor slug, so the plain (site, floor) pair isn't
    # enough to confirm a 3-segment key.
    site_slugs = set(_scoped(Site.objects, user).values_list('slug', flat=True))
    resolved = set(_scoped(Location.objects, user)
                   .filter(site__isnull=False)
                   .values_list('site__slug', 'slug'))
    resolved_nested = set(_scoped(Location.objects, user)
                          .filter(site__isnull=False, parent__isnull=False)
                          .values_list('site__slug', 'parent__slug', 'slug'))
    # Floor keys the BIND-1 rename-proof FK still binds: any room with a non-null `floor_location`
    # resolves its floor Location by FK regardless of the (possibly renamed) slug in `floor_key`, so
    # the key's *rooms* aren't orphaned even when its slugs don't resolve. Skip those below — but
    # only for floor-segment drift; see the anchor check in the loop.
    fk_covered = set(_scoped(Room.objects, user)
                     .filter(floor_location__isnull=False)
                     .values_list('floor_key', flat=True))

    rows = []
    for floor_key in sorted(floor_keys):
        site_slug, building_slug, floor_slug = parse_floor_key(floor_key)
        resolves = ((site_slug, building_slug, floor_slug) in resolved_nested if building_slug
                    else (site_slug, floor_slug) in resolved)
        if resolves:
            continue
        # Does the key's *anchor* — its Site, plus the building Location for a 3-segment key — still
        # resolve? The BIND-1 FK covers only the **floor** segment: it re-binds a floor's rooms, and a
        # floor-segment-only drift leaves both floor pickers rendering (their cards come from the
        # manifest, so only a card's link goes dead). Anchor drift is categorically worse — the
        # pickers match a manifest building by its *live* anchor slugs (`template_content.SiteFloors`
        # on `siteSlug`, `BuildingFloors` on `(siteSlug, buildingSlug)`), so a stale anchor removes
        # the whole floor-picker panel, and no per-room FK can compensate. Report it either way.
        anchor_live = (site_slug in site_slugs
                       and (not building_slug or (site_slug, building_slug) in resolved))
        if anchor_live and floor_key in fk_covered:
            continue
        if site_slug not in site_slugs:
            reason = 'no such site'
        elif building_slug and (site_slug, building_slug) not in resolved:
            reason = 'no building Location under site'
        else:
            reason = 'no floor Location under site'
        rows.append(UnresolvedFloorKey(
            floor_key=floor_key,
            room_count=counts.get(floor_key, 0),
            in_manifest=floor_key in manifest_keys,
            reason=reason,
        ))
    return rows


def _check_unbound_rooms(user):
    """Draw-only rooms: geometry with no `location` binding (`location_id IS NULL`).

    Informational — enumerated and reported, but excluded from `has_drift` (DOC-12)."""
    rows = _scoped(Room.objects, user).filter(location__isnull=True).order_by('floor_key', 'room_id')
    return [UnboundRoom(floor_key=r.floor_key, room_id=r.room_id, label=r.label) for r in rows]


def _check_stale_placements(user):
    """Placements on the map whose referenced rack/device PK is no longer in NetBox.

    Scans **every** facility's `kind='placements'` rows (all facilities share the global rack/device
    namespace, so a single bulk PK resolution covers them all). Placements are sharded one row per
    floor (`key=floor_key`, CONC-1), so each row *is* a floor's `placements[]` (mirroring
    `previews.placement_markers` / `placement_for_object`); then bulk-resolve which referenced PKs
    still exist. A placement with no `id` is malformed rather than stale, so it's skipped here (out
    of scope for this check)."""
    entries = []          # (floor_key, kind, id, label) for every placement carrying an id
    rack_ids, device_ids = set(), set()
    for blob in FacilityMapBlob.objects.filter(kind='placements').exclude(key=''):
        floor_key = blob.key
        for p in ((blob.data or {}).get('placements') or []):
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


def floor_plan_drift(loc):
    """True when `loc` is a floor whose rendered plan is in the manifest under a key that no
    longer resolves — the rename/bulk-edit drift HEALTH-4's `post_save` remap can't catch (a
    pre-HEALTH-4 rename, a `bulk_update` CSV import/bulk-edit that fires no signal, or a manual DB
    edit). Lets `template_content.FloorRooms` explain a *blank* floor panel to a regular user
    (HEALTH-5) instead of leaving it silent — the graceful-degradation backstop for the residue
    `signals.py` leaves behind.

    Conservative by construction so it never fires on a Location that simply *isn't* a floor (the
    many non-floor Locations that also hit `FloorRooms`' empty-floor branch): drift is reported only
    on a confident positive match — a manifest floor whose own `id` still equals `loc.slug` (the
    floor's own slug intact) sitting under a `dir` whose Site slug is **no longer live** (its
    ancestor drifted). That is exactly a renamed Site whose manifest wasn't re-keyed. A renamed floor
    *Location* (its own slug changed, so `floor.id != loc.slug`) or a 3-segment building-anchored
    floor leaves an empty floor with no reliable link to its manifest entry, so it stays blank —
    accepted degradation, since HEALTH-4 already covers the normal `save()` path for both.

    Read-only, like the rest of this module. Cheap on the hot Location-page render: it reads the
    mtime-memoized manifest and only issues the single live-Site-slug query when a same-slug manifest
    floor actually exists, so a genuine non-floor Location costs one memoized read and no query."""
    site = getattr(loc, 'site', None)
    if site is None:
        return False
    # Resolved through the Location itself so the right facility's manifest is read under the
    # `location` grouping too (MODEL-8); identical to the site resolution in the Site-FK groupings.
    manifest = read_manifest(facility_for_location(loc))
    if manifest is None:
        return False
    buildings = manifest.get('buildings', [])
    # The `dir`s of every manifest floor whose own id still matches this Location's slug. If `loc`
    # is a floor whose Site was renamed, its plan lives here under the *old* site slug.
    same_slug_dirs = {b['dir'] for b in buildings
                      for floor in b.get('floors', [])
                      if b.get('dir') and floor.get('id') == loc.slug}
    if not same_slug_dirs:
        return False
    # First collision guard: if `loc`'s *current* Site slug is itself a live manifest `dir`, that Site
    # has its own rendered building — so a same-slug floor is a legitimate floor of some building that
    # merely shares this slug, not `loc`'s orphaned plan. (A renamed Site's new slug never appears as a
    # frozen manifest dir, so this excludes only genuine collisions, never a real drift.)
    dir_site_slugs = {b['dir'].split('/', 1)[0] for b in buildings if b.get('dir')}
    if site.slug in dir_site_slugs:
        return False
    # Second collision guard: the same-slug floor must sit under a dir whose leading Site slug is no
    # longer live. A dir whose Site slug *is* live is another building's real floor that happens to
    # share this slug — so it never triggers the message. Drift = a same-slug floor stranded under a
    # dead (renamed-away) Site.
    live_site_slugs = set(Site.objects.values_list('slug', flat=True))
    return any(d.split('/', 1)[0] not in live_site_slugs for d in same_slug_dirs)


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
