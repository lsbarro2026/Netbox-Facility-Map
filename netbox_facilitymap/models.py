"""The plugin's persisted data — two models with distinct jobs.

`FacilityMapBlob` stores editor state as whole-document JSON rows (one per `kind`), staying
byte-compatible with the standalone tool's flat JSON files. `Room` is a `NetBoxModel`
holding the authoritative, relational room geometry bound to a `dcim.Location`; the editor's
`sync_rooms` owns its lifecycle and is the only code path allowed to delete `Room` rows,
scoped to the user's own writes. The two models compose: blobs hold free-form editor
state, `Room` holds the geometry NetBox itself needs to resolve.
"""

from django.conf import settings
from django.db import models
from django.urls import reverse

from netbox.models import NetBoxModel
from netbox.models.features import ChangeLoggingMixin


def parse_floor_key(floor_key):
    """Split a `Room.floor_key` into ``(site_slug, building_slug, floor_slug)`` — the one place
    that knows the two building-anchor key shapes (MODEL-3), shared by every backend resolver so the
    convention can't drift.

      * 2-segment ``"<site>/<floor>"``          -> ``(site, '', floor)``  (Site-anchored, today).
      * 3-segment ``"<site>/<building>/<floor>"`` -> ``(site, building, floor)``  (Location-anchored).

    `site_slug` is always the **first** segment and `floor_slug` the **last**; the building slug (if
    any) is the second-to-last. Written that way to *tolerate* an unexpected extra segment (deeper
    nesting is out of scope, but the parser must not choke on it — BUILDING-ANCHOR-DESIGN §8 open-q 2)
    rather than hard-coding "exactly 3". A malformed key (fewer than 2 segments) yields
    ``('', '', '')`` so callers uniformly reject it by an empty `site`/`floor`."""
    parts = floor_key.split('/')
    if len(parts) < 2:
        return ('', '', '')
    site_slug = parts[0]
    floor_slug = parts[-1]
    building_slug = parts[-2] if len(parts) >= 3 else ''
    return (site_slug, building_slug, floor_slug)


class FacilityMapBlob(ChangeLoggingMixin, models.Model):
    """One JSON document of editor state.

    The standalone tool persisted its data as a handful of flat JSON files, and the
    frontend GETs/POSTs each one as a *whole document* (e.g. `Store.saveAnnotations`
    posts the entire annotations dict). So one row per `kind` (with `key=''`) holds
    the complete dict and stays byte-compatible with `siteplan.json` /
    `rackplacements.json` / `pagelayouts.json`.

    Since Phase 4 the `annotations` blob holds only each floor's `image`/`w`/`h`/`arrows`:
    room polygons were promoted to the relational `Room` model below. The
    `AnnotationsView` recomposes the whole-document shape on GET, so the frontend and
    JSON export are unchanged. The `key` column remains reserved for a future per-floor
    shard of the remaining blob state.

    `facility` and `key` are **orthogonal** discriminators, kept separate on purpose
    (MULTI-1). `facility` namespaces a whole document set to one facility/campus (a
    `dcim.Region` or `dcim.SiteGroup` slug — the plugin supports either), so each `kind`
    gets one row *per facility* instead of one global row; the full multi-facility
    feature (per-facility working dir, picker UI) is still unbuilt, but the column is
    reserved now so existing rows aren't stranded as un-namespaced singletons. `''` is
    the default facility — every current row — so single-facility installs and the
    standalone-tool JSON round-trip are unaffected. `key` stays reserved for the *other*
    axis: the per-floor shard of the CONC-1 fix. Don't overload one for the other.

    **Change logging (AUDIT-1).** The blob carries NetBox's `ChangeLoggingMixin` — a
    deliberate *subset* of `NetBoxModel` (change logging only; no object-perms,
    custom-fields, journal or tags), enough for the global `handle_changed_object`
    post_save receiver to record an `ObjectChange` on every write. `Room` already had this
    for free; the mixin closes the gap for the siteplan/arrows/placements/layouts/settings
    documents so "who changed this and when" is answerable in the global Change Log. The
    write views `snapshot()` the row before overwriting so the entry carries the
    before/after diff (and no-op writes are suppressed). Entries are **whole-document** at
    `key=''` granularity — clean for the small blobs (settings/siteplan), coarse for
    placements/annotations — and refine to per-floor automatically if the reserved `key`
    shard is ever built. The mixin adds `created`/`last_updated`; the pre-existing `updated`
    (auto_now) is kept as-is because `frontend_api._blob_version` (the CONC-1 concurrency
    token) reads it — the small overlap with `last_updated` avoids touching that path.
    """

    KIND_CHOICES = (
        ('annotations', 'Room annotations'),
        ('siteplan', 'Siteplan hotspots'),
        ('placements', 'Rack/device placements'),
        ('layouts', 'Sheet layouts'),
        # A single `key=''` row holding the plugin's editable settings (e.g.
        # `room_embed_zoom`), edited in-app via the Settings page. Unlike the editor
        # blobs it isn't a standalone-tool document — just the settings store.
        ('settings', 'Plugin settings'),
        # A single install-wide row (`facility=''`, `key=''`) holding the explicit
        # Site→facility assignment map `{site_slug: facility_slug}` — the plugin-owned
        # facility axis (FACILITY-IDENTITY-DESIGN §4.1). Values are strict slugs
        # (validated by `storage.valid_facility` on write); a Site absent from the map
        # falls back to the SiteGroup/Region derivation. Its own kind on purpose: never
        # smuggled into `key` (the CONC-1 per-floor shard) or `facility` (the namespace
        # itself).
        ('facility_map', 'Facility assignments'),
    )

    kind = models.CharField(max_length=20, choices=KIND_CHOICES)
    # Facility discriminator; '' = the default (single) facility. Holds a `dcim.Region`
    # or `dcim.SiteGroup` slug once multi-facility ships; 120 leaves room for an optional
    # "<type>:<slug>" prefix to disambiguate a Region and SiteGroup sharing a slug.
    facility = models.CharField(max_length=120, blank=True, default='')
    # Per-floor shard discriminator, orthogonal to `facility` (MULTI-1). '' for the facility-wide
    # single-row kinds (`siteplan`/`settings`); the `floor_key` (`"<site.slug>/<floor.id>"`) for the
    # per-floor kinds (`annotations`/`placements`/`layouts`), so a different-floor save conflicts
    # only on its own floor (CONC-1). 120 matches `Room.floor_key`, so any floor_key fits.
    key = models.CharField(max_length=120, blank=True, default='')
    data = models.JSONField(default=dict)
    updated = models.DateTimeField(auto_now=True)

    def serialize_object(self, exclude=None):
        """Also hide the redundant `updated` timestamp from the change-log snapshot.

        NetBox already excludes the mixin's `last_updated` from the serialized pre/post-change
        data (so a bumped timestamp alone doesn't read as a change). Our `updated` column is a
        second `auto_now` mirror of it (kept for the CONC-1 concurrency token), so it must be
        excluded too — otherwise `ObjectChange.has_changes` compares the two snapshots, sees
        `updated` differ on every save, and a data-unchanged write (e.g. a rooms-only annotations
        POST, whose room geometry lives in `Room`) would record a spurious no-op blob entry
        instead of being suppressed."""
        exclude = set(exclude or [])
        exclude.add('updated')
        return super().serialize_object(exclude=exclude)

    class Meta:
        ordering = ['kind', 'facility', 'key']
        unique_together = [('kind', 'facility', 'key')]
        # Custom permission gating the destructive import surface (the import wizard endpoints +
        # the Settings page), split off `change_facilitymapblob` so a rack-placer can edit
        # placements without being able to rebuild/wipe the facility (PERM-1). Reset tightens this
        # further — it also requires a superuser (imports.ResetView). Adding it needs this entry
        # *and* a migration (Django's auto model perms don't cover it) — see migration 0007.
        permissions = [('import_facilitymapblob', 'Can import & reset the facility map')]

    def __str__(self):
        label = f'{self.kind}/{self.key}' if self.key else self.kind
        return f'{self.facility}:{label}' if self.facility else label


class Room(NetBoxModel):
    """A floor-plan room polygon, promoted out of the `annotations` blob (Phase 4).

    Each row is one room the editor drew on a floor: its normalized polygon plus the
    `dcim.Location` it is bound to. Promoting the polygon to a first-class
    `NetBoxModel` (rather than leaving it in the JSON blob) is what lets NetBox render
    rooms on a Location page, query them relationally, and — via `.restrict()` — scope
    them by object permission. Arrows / hotspots / placements / layouts stay blobs
    (editor-internal, low query value).

    `Room` is the source of truth for room geometry: `AnnotationsView` composes these
    rows back into the whole-document annotations shape on GET and decomposes a POSTed
    document into rows, so the framework-free frontend round-trips byte-for-byte.

    `Room` is also exposed over the NetBox REST API (`api/`), but the **map editor stays
    authoritative for a floor's room set**: a row *created* through REST is swept by the next
    editor Save of that floor (`frontend_api.sync_rooms`, `restrict(user,'delete')`-scoped), since
    that POST is the floor's authoritative snapshot and the editor can't tell a REST-authored room
    from one the user deleted. REST writes are durable when they edit `label`/`location`/`tags` on
    rooms the editor already owns — see the sweep-on-save caveat in `api/serializers.py`.
    """

    # "<dir>/<floorId>" — the annotations document key. Two shapes (building anchor, MODEL-3),
    # told apart by segment count via `parse_floor_key`:
    #   * Site-anchored (the building *is* a Site):     "<site.slug>/<floorLocation.slug>" — 2 segments.
    #   * Location-anchored (Site=campus, building is a  "<site.slug>/<buildingLocation.slug>/<floorLocation.slug>"
    #     Location under it):                            — 3 segments, only ever written by a fresh
    #                                                      Site=campus import.
    # `<site.slug>` is always segment 1, so `facilities.facility_floor_scope`'s startswith-prefix
    # scoping and the SEC-1 media gate stay correct for both. Older installs keep their exact
    # 2-segment keys untouched — the scheme is additive, no data migration (see BUILDING-ANCHOR-DESIGN).
    floor_key = models.CharField(max_length=120)
    # The editor's per-room uid (e.g. "rabc1234"); stable identity for upsert within a floor.
    room_id = models.CharField(max_length=40)
    label = models.CharField(max_length=200, blank=True)
    # Free-text search synonyms so wayfinding search matches what's *printed on the floor plan* (a
    # room number `2107`) even when the bound Location uses a different scheme (`IDF-2A`) — NAV-18.
    # Comma/newline-separated; a **search aid only**, never drawn (floor rooms stay unlabelled, §10),
    # so it's distinct from `label` (the on-plan label). Both finder tiers match it: the client-side
    # placed index (`Store.searchTargets`) and the server `NbInventoryView` unplaced search.
    alias = models.TextField(blank=True, default='')
    polygon = models.JSONField(default=list)  # [[nx, ny], ...] normalized 0..1
    # The bound *room* Location (a child of the floor Location). Null = unbound.
    location = models.ForeignKey(
        'dcim.Location', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='+')
    # The *floor* Location this room's floor is bound to (parent of `location`). A stable,
    # rename-proof anchor for the floor binding (BIND-1): unlike `floor_key` — which embeds the
    # floor Location's *slug*, frozen in the manifest — this FK survives renaming the Site or the
    # floor Location in NetBox, so the floor's rooms keep resolving on the Location page. Null =
    # the floor key never resolved to a live floor Location (a floor-type floor with no Location,
    # or an already-orphaned key). Set stickily by `frontend_api.sync_rooms` and backfilled by
    # migration 0009; `floor_key` stays the manifest/disk key (image lookup keys off it).
    floor_location = models.ForeignKey(
        'dcim.Location', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='+')

    class Meta:
        ordering = ['floor_key', 'label']
        unique_together = [('floor_key', 'room_id')]

    def __str__(self):
        return self.label or self.room_id

    def get_absolute_url(self):
        # Rooms have no standalone page — the bound NetBox Location is their home, and the
        # map editor owns the geometry. The REST API's `display_url`, the changelog, and
        # admin all call this, so it must resolve. Fall back to the map app when unbound.
        if self.location_id:
            return self.location.get_absolute_url()
        return reverse('plugins:netbox_facilitymap:map')


class RoomTodo(ChangeLoggingMixin, models.Model):
    """One to-do item attached to a floor-plan room (the floor to-do list feature).

    The floor page carries a per-room to-do list: a note the user can walk through the
    Planned → In progress → Completed workflow. Each note is one of these rows, tied to the
    `Room` it belongs to. The frontend `FloorTodo` panel groups them by room and buckets the
    completed ones into a per-room "Completed" subfolder; a completed item is *kept* (not
    deleted) until the user explicitly clears it, so this is durable user data.

    **Resync-safety (the reason it's an FK to `Room`, not a loose `(floor_key, room_id)`).**
    `frontend_api.sync_rooms` is authoritative for room geometry, but it **upserts** rows with
    `update_or_create(floor_key, room_id)`, so a room's PK is stable across every editor save —
    the FK below survives a resync untouched. `on_delete=CASCADE` means a to-do disappears only
    when its room is *genuinely* removed from the floor (its polygon deleted), which is the
    correct lifecycle: a note for a room that no longer exists has no home. `sync_rooms` scopes
    its deletes with `.restrict(user, 'delete')`, so only rooms the caller may delete — and thus
    only their to-dos — are ever removed.

    Besides the `text` and its workflow `status`, a to-do carries the scheduling detail the panel
    shows: a `priority`, free-text `notes`, a `due` date, and its `assignees`. Assignment is
    **many-to-many** — a job is routinely shared — so `assignees` points at NetBox's user model via
    `settings.AUTH_USER_MODEL` (NetBox swaps in its own `users.User`; never hard-code `auth.User`).
    The M2M is an assignment record and nothing more: it uses `related_name='+'` because no code
    walks from a user back to their to-dos, and deleting a user drops their through-table rows while
    the to-do itself survives — an unassigned to-do is still a job that needs doing.

    Like `FacilityMapBlob`, it carries `ChangeLoggingMixin` (change logging only, not the full
    `NetBoxModel` stack) so every to-do write lands in the global Change Log; the mixin also
    supplies the `created`/`last_updated` timestamps the ordering and the API serialization use.
    To-dos are edited only through the plugin's own permission-gated JSON endpoints (writes gate
    on `change_facilitymapblob`), never a generic NetBox object UI, so they need no nav/table/REST
    surface of their own.
    """

    STATUS_PLANNED = 'planned'
    STATUS_IN_PROGRESS = 'in_progress'
    STATUS_COMPLETED = 'completed'
    STATUS_CHOICES = (
        (STATUS_PLANNED, 'Planned'),
        (STATUS_IN_PROGRESS, 'In progress'),
        (STATUS_COMPLETED, 'Completed'),
    )

    PRIORITY_HIGH = 'high'
    PRIORITY_MED = 'med'
    PRIORITY_LOW = 'low'
    PRIORITY_CHOICES = (
        (PRIORITY_HIGH, 'High'),
        (PRIORITY_MED, 'Medium'),
        (PRIORITY_LOW, 'Low'),
    )

    room = models.ForeignKey('Room', on_delete=models.CASCADE, related_name='todos')
    text = models.CharField(max_length=500)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_PLANNED)
    priority = models.CharField(max_length=20, choices=PRIORITY_CHOICES, default=PRIORITY_MED)
    assignees = models.ManyToManyField(settings.AUTH_USER_MODEL, blank=True, related_name='+')
    notes = models.TextField(blank=True, default='')
    due = models.DateField(null=True, blank=True)

    class Meta:
        # Oldest-first within a room (a to-do list reads top-down in creation order); the `id`
        # tiebreak keeps items added in the same second stably ordered.
        ordering = ['created', 'id']

    def __str__(self):
        return self.text
