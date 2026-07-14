"""The plugin's persisted data — two models with distinct jobs.

`FacilityMapBlob` stores editor state as whole-document JSON rows (one per `kind`), staying
byte-compatible with the standalone tool's flat JSON files. `Room` is a `NetBoxModel`
holding the authoritative, relational room geometry bound to a `dcim.Location`; the editor's
`sync_rooms` owns its lifecycle (see CLAUDE.md §Data safety). See DESIGN.md §3 for how the
two compose.
"""

from django.db import models
from django.urls import reverse

from netbox.models import NetBoxModel
from netbox.models.features import ChangeLoggingMixin


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
    )

    kind = models.CharField(max_length=20, choices=KIND_CHOICES)
    # Facility discriminator; '' = the default (single) facility. Holds a `dcim.Region`
    # or `dcim.SiteGroup` slug once multi-facility ships; 120 leaves room for an optional
    # "<type>:<slug>" prefix to disambiguate a Region and SiteGroup sharing a slug.
    facility = models.CharField(max_length=120, blank=True, default='')
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
    """

    # "<dir>/<floorId>" — the annotations document key (== "<site.slug>/<floorLocation.slug>").
    floor_key = models.CharField(max_length=120)
    # The editor's per-room uid (e.g. "rabc1234"); stable identity for upsert within a floor.
    room_id = models.CharField(max_length=40)
    label = models.CharField(max_length=200, blank=True)
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
