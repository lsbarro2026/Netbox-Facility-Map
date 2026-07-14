"""JSON endpoints for the map frontend.

These replace the standalone `server.py` routes. They are plain Django views (not
DRF) mounted *under the plugin's page mount* (`/plugins/facilitymap/api/...`), so they
ride NetBox's session auth and Django's CSRF middleware directly — the frontend posts
its session CSRF token in the `X-CSRFToken` header (see `Api.post` in `lib.js`). The
contract (paths, request/response shapes) is identical to the old server so the
framework-free frontend is reused unchanged.

Three families:
  * Annotations — `AnnotationsView`: room polygons are the relational `Room` model
    (Phase 4), while each floor's `image`/`w`/`h`/`arrows` stay in the `annotations`
    blob. GET composes the whole-document shape (blob floors + `Room` rows merged back
    in); POST decomposes it (rooms → `Room` rows, the rest → the blob). The frontend
    round-trips byte-for-byte and is unchanged.
  * Blob persistence — `siteplan` / `placements` / `layouts`: GET returns the whole
    stored document (or its default), POST upserts it. One `FacilityMapBlob` row per kind.
  * NetBox reads — `netbox/rooms`, `netbox/locations`, `netbox/racks`,
    `netbox/devices`: direct ORM queries over `dcim` models, restricted by the
    requester's object permissions, replacing the token-holding proxy. There is no
    longer a persisted `rackcache` — racks/devices are fetched live per room.
"""

import json

from django.contrib.auth.mixins import LoginRequiredMixin
from django.core.exceptions import ValidationError
from django.db import transaction
from django.http import HttpResponseBadRequest, HttpResponseForbidden, JsonResponse
from django.utils.text import slugify
from django.views import View

from dcim.models import Device, Location, Rack, Site

from . import capabilities
from .access import EDIT_PERM, IMPORT_PERM, MapReadAccessMixin
from .facilities import (
    EDITOR_KINDS, GROUPING_CHOICES, clamp_default_facility, facility_floor_scope, facility_sites,
    grouping, list_facilities,
)
from .models import FacilityMapBlob, Room
from .previews import clamp_floor_label_field
from .storage import valid_facility

# Saving any editor document mutates the shared facility map, so the write endpoints are gated on
# `EDIT_PERM` (`change_facilitymapblob`, admin-grantable) rather than merely "is logged in". Reads
# are login-only by default, with the optional `view_facilitymapblob` gate via `MapReadAccessMixin`
# (see access.py). `EDIT_PERM` is shared from access.py so its string can't drift across modules.

# Optimistic-concurrency token. The frontend GETs a whole document, edits it in memory, and
# POSTs it back — a blind last-write-wins that silently clobbers a concurrent editor's rooms
# (see CONC-1 / ARCHITECTURE §10). To detect that, GET echoes the row's `updated` timestamp
# in this header and POST must send it back; a mismatch means the document moved underneath
# the client, so the write is rejected with 409 (reload + re-apply) instead of overwriting.
# Transported as a header (not a body field) so the byte-for-byte blob shapes are untouched.
VERSION_HEADER = 'X-Facilitymap-Version'


def _facility(request):
    """The validated `?facility=` slug for a request (default '' = the default facility), or `None`
    when the slug is malformed so the caller can 400. A facility namespaces the editor blob rows
    (MULTI-2); every blob read/write scopes `.filter(facility=…)`."""
    try:
        return valid_facility(request.GET.get('facility') or '')
    except ValueError:
        return None


def _blob_version(row):
    """Opaque concurrency token for a blob row: its `updated` timestamp (ISO), or '' when
    the row doesn't exist yet (a first write has nothing to conflict with)."""
    return row.updated.isoformat() if row else ''


def _save_blob(row, *, kind, facility, data):
    """Upsert one whole-document blob and return the saved row, recording an audit entry.

    `row` is the existing `(kind, facility, key='')` row already fetched under
    `select_for_update()`, or `None` on a first write. Saving that same instance (rather than a
    fresh `update_or_create`) is what lets the change-log receiver see the pre-change snapshot: we
    `snapshot()` before overwriting so the `ObjectChange` carries the before/after diff and an
    unchanged document is suppressed as a no-op (AUDIT-1). A first write is an insert (create
    entry, no prechange). Assumes an open transaction and a caller-verified version token."""
    if row is None:
        return FacilityMapBlob.objects.create(kind=kind, facility=facility, key='', data=data)
    row.snapshot()
    row.data = data
    row.save()
    return row


def _version_conflict(row, request):
    """Return a 409 `JsonResponse` when the client's concurrency token doesn't match `row`'s
    current version, else `None`. Opt-in: a *missing* header skips the check (so non-versioned
    callers keep working), while a *present* token — including '' for the first-write case — is
    enforced. The caller must have `select_for_update()`d `row` inside a transaction so the
    check-then-write can't race."""
    sent = request.headers.get(VERSION_HEADER)
    if sent is None or sent == _blob_version(row):
        return None
    return JsonResponse(
        {'ok': False, 'error': 'conflict',
         'detail': 'The map changed since you loaded it — reload and re-apply your edits.'},
        status=409)


# kind -> the default document the standalone server returned when a file was absent.
# (`annotations` is served by AnnotationsView, not BlobView, so it isn't listed here.)
BLOB_DEFAULTS = {
    'siteplan': lambda: {'hotspots': []},
    'placements': dict,
    'layouts': dict,
}


class BlobView(MapReadAccessMixin, View):
    """GET the stored document for one `kind` (or its default); POST upserts it whole.

    GET rides the shared map-read gate; POST additionally requires `EDIT_PERM` below (a viewer
    reads but cannot write)."""
    kind = None

    def get(self, request):
        facility = _facility(request)
        if facility is None:
            return HttpResponseBadRequest('invalid facility')
        row = FacilityMapBlob.objects.filter(kind=self.kind, facility=facility, key='').first()
        resp = JsonResponse(row.data if row else BLOB_DEFAULTS[self.kind](), safe=False)
        resp[VERSION_HEADER] = _blob_version(row)
        return resp

    def post(self, request):
        if not request.user.has_perm(EDIT_PERM):
            return HttpResponseForbidden('permission denied')
        facility = _facility(request)
        if facility is None:
            return HttpResponseBadRequest('invalid facility')
        try:
            data = json.loads(request.body or b'{}')
        except json.JSONDecodeError:
            return HttpResponseBadRequest('invalid JSON')
        with transaction.atomic():
            row = FacilityMapBlob.objects.select_for_update().filter(
                kind=self.kind, facility=facility, key='').first()
            conflict = _version_conflict(row, request)
            if conflict:
                return conflict
            obj = _save_blob(row, kind=self.kind, facility=facility, data=data)
            obj.refresh_from_db(fields=['updated'])
        resp = JsonResponse({'ok': True})
        resp[VERSION_HEADER] = _blob_version(obj)
        return resp


def _trim(loc, request):
    """Shape a Location for the frontend (mirrors `NetBoxProxy._trim`). `url` is made
    absolute against the current host so a room click opens the Location page."""
    return {
        'id': loc.pk,
        'name': loc.name,
        'slug': loc.slug,
        # Exposed so the import wizard's floor-label picker can offer 'description' as an
        # alternative to 'name'/'slug' (see views._floor_label_field) — a fixed, already-public
        # field, not an arbitrary attribute lookup.
        'description': loc.description,
        'url': request.build_absolute_uri(loc.get_absolute_url()),
        # `parent` (a plain FK column, reliable on any queryset and across MPTT/tree-queries)
        # lets the frontend walk the Location tree; `depth` is left for compatibility but is an
        # MPTT-only `level` artifact and unreliable on NetBox 4.2+.
        'parent': loc.parent_id,
        'depth': getattr(loc, 'level', 0),
    }


# --- Annotations: the relational Room model behind the whole-document blob shape ----

def _serialize_room(room, request):
    """Shape a `Room` row back into the frontend's room object (the inverse of the
    editor's room record). `location` is re-derived from the FK via `_trim`, so the
    name/slug/url are always current (no stale denormalized snapshot)."""
    return {
        'id': room.room_id,
        'label': room.label,
        'polygon': room.polygon,
        'location': _trim(room.location, request) if room.location_id else None,
    }


def _split_annotations(doc):
    """Pure: separate a whole annotations document into (blob_data, rooms_by_floor).

    `blob_data` keeps each floor's `image`/`w`/`h`/`arrows`/`notes` (everything but `rooms`);
    `rooms_by_floor` maps `floor_key -> [room dict, ...]`. Used by POST and the importer."""
    blob, rooms_by_floor = {}, {}
    for fkey, floor in (doc or {}).items():
        floor = dict(floor or {})
        rooms_by_floor[fkey] = floor.pop('rooms', None) or []
        blob[fkey] = floor
    return blob, rooms_by_floor


def compose_annotations(blob_data, user, request, facility=''):
    """Rebuild the whole-document annotations shape: blob floors with their `Room` rows
    (visible to `user`) merged back in under each floor's `rooms`.

    `Room` has no facility column (`floor_key` embeds the globally-unique site slug), so the rows
    are scoped to the requested facility by their floor's site: only rooms whose `floor_key`
    site-prefix belongs to `facility` are surfaced, so a facility-B GET never lists facility-A's
    rooms. The default facility '' resolves to every ungrouped site (all sites on a single-facility
    install), preserving today's whole-document shape."""
    doc = {fkey: dict(floor) for fkey, floor in (blob_data or {}).items()}
    rooms = Room.objects.restrict(user, 'view').select_related('location')
    # The facility→site-slug mapping bounds which floors belong to the facility; it is not itself
    # permission-sensitive (the rooms stay `.restrict(user,'view')`), so resolve it unscoped so an
    # editor lacking Site-view permission still sees their facility's rooms.
    scope = facility_floor_scope(facility)
    rooms = rooms.filter(scope) if scope is not None else rooms.none()
    by_floor = {}
    for room in rooms:
        by_floor.setdefault(room.floor_key, []).append(room)
    for fkey, rooms in by_floor.items():
        doc.setdefault(fkey, {})
        doc[fkey]['rooms'] = [_serialize_room(r, request) for r in rooms]
    # A blob floor with no rooms still advertises an empty list (matches the legacy shape).
    for floor in doc.values():
        floor.setdefault('rooms', [])
    return doc


def _resolve_floor_location(floor_key):
    """The floor `dcim.Location` a `floor_key` (`"<site.slug>/<floor.slug>"`) names, or `None` when
    it can't be resolved today — an empty/malformed key, a floor-type floor whose slug has no
    Location, or a slug that has since drifted (renamed). Mirrors how `NbRoomsView`/`health` resolve
    a floor key by its two slugs. Used to (re)establish `Room.floor_location`, the BIND-1
    rename-proof anchor, on save."""
    site_slug, sep, floor_slug = floor_key.partition('/')
    if not (sep and site_slug and floor_slug):
        return None
    return Location.objects.filter(site__slug=site_slug, slug=floor_slug).first()


def sync_rooms(rooms_by_floor, user=None, facility=''):
    """Upsert `Room` rows from a decomposed annotations document and delete the rest.
    The POST is authoritative for its facility, so rooms absent from a posted floor — and
    rooms of the facility's floors absent entirely — are removed.

    When `user` is given (the editor POST), deletes are scoped to rooms that user may
    delete (`restrict(user, 'delete')`), so a save never silently removes rooms the caller
    has no permission over. `user=None` (the trusted `facilitymap_import` command) keeps
    the unrestricted behaviour.

    `Room` has no facility column, so the cross-floor "delete floors absent entirely" pass is
    scoped to the facility's floors (via each floor's site), so a facility-B POST can never delete
    facility-A's rooms. This narrows — never widens — the delete: `restrict(user,'delete')` still
    applies, and the default facility '' resolves to every ungrouped site, so a single-facility
    install keeps today's authoritative-over-everything behaviour."""
    del_qs = Room.objects.restrict(user, 'delete') if user is not None else Room.objects.all()
    for fkey, rooms in rooms_by_floor.items():
        # The floor Location this key binds to (BIND-1). Set the FK **stickily**: apply it only when
        # the key resolves, so a save that arrives after a Site/floor rename — the SPA still POSTs the
        # OLD `floor_key` (frozen manifest), which no longer resolves — leaves the previously-stored,
        # still-correct FK untouched rather than nulling it. Resolved once per floor, not per room.
        floor_loc = _resolve_floor_location(fkey)
        floor_defaults = {'floor_location': floor_loc} if floor_loc is not None else {}
        seen = []
        for room in rooms:
            rid = room.get('id')
            if not rid:
                continue
            seen.append(rid)
            loc = room.get('location') or {}
            loc_id = loc.get('id')
            if loc_id and not Location.objects.filter(pk=loc_id).exists():
                loc_id = None
            Room.objects.update_or_create(
                floor_key=fkey, room_id=rid,
                defaults={
                    'label': room.get('label') or '',
                    'polygon': room.get('polygon') or [],
                    'location_id': loc_id,
                    **floor_defaults,
                })
        del_qs.filter(floor_key=fkey).exclude(room_id__in=seen).delete()
    # Remove rooms of the facility's floors that the document dropped entirely. Scope to the
    # facility (Room has no facility column) so other facilities' rooms are never touched; a
    # facility with no sites contributes no scope, so the cross-floor sweep is skipped. The
    # facility→site mapping is resolved unscoped (it bounds which floors are the facility's, not
    # who may see them); `del_qs` already carries the `restrict(user,'delete')` permission scope.
    scope = facility_floor_scope(facility)
    if scope is not None:
        del_qs.filter(scope).exclude(floor_key__in=list(rooms_by_floor.keys())).delete()


class AnnotationsView(MapReadAccessMixin, View):
    """GET composes the whole annotations document (blob floors + `Room` rows); POST
    decomposes it (rooms → `Room` rows, the rest → the `annotations` blob). Same path
    and request/response shape as the standalone server, so the frontend is unchanged.

    GET rides the shared map-read gate; POST additionally requires `EDIT_PERM`."""

    def get(self, request):
        facility = _facility(request)
        if facility is None:
            return HttpResponseBadRequest('invalid facility')
        row = FacilityMapBlob.objects.filter(kind='annotations', facility=facility, key='').first()
        resp = JsonResponse(
            compose_annotations(row.data if row else {}, request.user, request, facility),
            safe=False)
        resp[VERSION_HEADER] = _blob_version(row)
        return resp

    def post(self, request):
        if not request.user.has_perm(EDIT_PERM):
            return HttpResponseForbidden('permission denied')
        facility = _facility(request)
        if facility is None:
            return HttpResponseBadRequest('invalid facility')
        try:
            doc = json.loads(request.body or b'{}')
        except json.JSONDecodeError:
            return HttpResponseBadRequest('invalid JSON')
        blob, rooms_by_floor = _split_annotations(doc)
        # The token is the annotations blob row's `updated`. Room geometry lives in the `Room`
        # table, not the blob, but every annotations POST writes the blob row in this same
        # transaction (`_save_blob` always calls `.save()`, so `auto_now` bumps `updated` even
        # when `data` is unchanged), so the blob's timestamp faithfully tracks the *whole*
        # document — rooms-only edits included. (The change-log entry, unlike the token, *is*
        # suppressed on that unchanged-data case — see `_save_blob`.)
        with transaction.atomic():
            row = FacilityMapBlob.objects.select_for_update().filter(
                kind='annotations', facility=facility, key='').first()
            conflict = _version_conflict(row, request)
            if conflict:
                return conflict
            sync_rooms(rooms_by_floor, request.user, facility)
            # Rooms are logged individually via the `Room` change log; the blob write here holds
            # only image/w/h/arrows, so a rooms-only edit leaves `blob` unchanged. `_save_blob`
            # snapshots first, so that case is a no-op change and NetBox suppresses it rather than
            # littering the log with an empty "annotations updated" entry per room drag.
            obj = _save_blob(row, kind='annotations', facility=facility, data=blob)
            obj.refresh_from_db(fields=['updated'])
        resp = JsonResponse({'ok': True})
        resp[VERSION_HEADER] = _blob_version(obj)
        return resp


class NbRoomsView(LoginRequiredMixin, View):
    """Rooms = child Locations of the floor Location; falls back to all Locations under
    the site when the floor slug has no Location. ORM equivalent of `NetBoxProxy.rooms`."""

    def get(self, request):
        site_slug = request.GET.get('site', '')
        floor_slug = request.GET.get('floor', '')
        site = Site.objects.filter(slug=site_slug).first()
        if not site:
            return JsonResponse({'error': 'site not found: ' + site_slug, 'rooms': []})
        locs = Location.objects.restrict(request.user, 'view').filter(site=site)
        floor = locs.filter(slug=floor_slug).first() if floor_slug else None
        if floor:
            rooms = list(locs.filter(parent=floor))
            if rooms:
                return JsonResponse({'floor': _trim(floor, request),
                                     'rooms': [_trim(x, request) for x in rooms]})
            return JsonResponse({'floor': _trim(floor, request),
                                 'rooms': [_trim(x, request) for x in locs]})
        return JsonResponse({'floor': None, 'rooms': [_trim(x, request) for x in locs]})


class NbLocationsView(LoginRequiredMixin, View):
    """Free-text Location search within a site. ORM equivalent of `NetBoxProxy.locations`."""

    def get(self, request):
        site_slug = request.GET.get('site', '')
        q = request.GET.get('q', '')
        site = Site.objects.filter(slug=site_slug).first()
        if not site:
            return JsonResponse({'rooms': []})
        qs = Location.objects.restrict(request.user, 'view').filter(site=site)
        if q:
            qs = qs.filter(name__icontains=q)
        return JsonResponse({'rooms': [_trim(x, request) for x in qs[:200]]})


class NbLocationCreateView(LoginRequiredMixin, View):
    """POST: create a child `dcim.Location` under a floor Location, so a permitted user can bind a
    drawn room to a fresh Location without leaving the map (LOC-1).

    This is the plugin's **only** write into `dcim` core — every other NetBox interaction is a
    `.restrict(user, 'view')` read — so it is gated stricter than the reads, three ways, all
    enforced here (never login-only, never on the frontend alone):

      * the install-wide `allow_location_create` capability flag must be on (off by default, so
        NetBox stays the Location source of truth) — else 403;
      * the user must hold the `dcim.add_location` object permission (the NetBox auth backend, not a
        login check) — the model-level `has_perm` gives a fast 403, and a post-save
        `restrict(user, 'add')` re-check honours any object-level constraints on that permission
        (the check must run on a *saved* pk — an object-level `has_perm` on an unsaved instance
        filters on `pk=None` and always fails);
      * the parent floor Location must already exist and be visible to the user
        (`restrict(user, 'view')`) — this endpoint never creates the floor, only a room under it.

    The child slug is `slugify(name)`, matching how NetBox's own Location form derives it, so
    `NbRoomsView` lists the new child under the floor and room→Location binding resolves (§7). A
    duplicate name/slug or otherwise invalid Location surfaces as a clean 400 via `full_clean()`."""

    def post(self, request):
        if not capabilities.is_enabled('location-create'):
            return HttpResponseForbidden('inline Location creation is not enabled')
        if not request.user.has_perm('dcim.add_location'):
            return HttpResponseForbidden('permission denied')
        try:
            payload = json.loads(request.body or b'{}')
        except json.JSONDecodeError:
            return HttpResponseBadRequest('invalid JSON')
        name = (payload.get('name') or '').strip()
        if not name:
            return HttpResponseBadRequest('a Location name is required')
        # The parent floor Location must be one the user may see; a bad/hidden id is a 400, not a
        # silent create at the site root (a room Location must nest under its floor, §7).
        parent = Location.objects.restrict(request.user, 'view').filter(
            pk=payload.get('parent')).first()
        if parent is None:
            return HttpResponseBadRequest('parent floor Location not found')
        loc = Location(name=name, slug=slugify(name), site=parent.site, parent=parent)
        denied = False
        try:
            with transaction.atomic():
                loc.full_clean()
                loc.save()
                # Honour object-level constraints on the add permission the way NetBox's own create
                # path does: verify the saved row falls within the user's add-scoped queryset, else
                # roll back. Runs on a real pk, so (unlike an unsaved-instance has_perm) it can't
                # false-negative.
                if not Location.objects.restrict(request.user, 'add').filter(pk=loc.pk).exists():
                    denied = True
                    transaction.set_rollback(True)
        except ValidationError as e:
            return JsonResponse({'ok': False, 'error': '; '.join(e.messages)}, status=400)
        if denied:
            return HttpResponseForbidden('permission denied')
        return JsonResponse(_trim(loc, request), status=201)


class NbSitesView(LoginRequiredMixin, View):
    """Free-text Site search, **scoped to the active facility** (FACIL-1). The import wizard binds
    each uploaded building folder to a NetBox Site (a "building"), so its slug — which becomes the
    manifest `siteSlug` — matches a real Site and later room/location lookups resolve.

    Unlike the other `/api/netbox/*` reads (facility-agnostic — scoped by an explicit `site=`/
    `location=`), this one *is* the facility-binding point: binding a building under facility A to a
    Site whose grouping slug is B would land the images/manifest/blobs under A while
    `facility_site_slugs('A')` never includes that Site, silently stranding its rooms. So the search
    is restricted to the requested `?facility=`'s own Sites (via `facility_sites`) — ungrouped Sites
    for the default facility '', a group's Sites otherwise — making an out-of-facility bind
    impossible rather than merely repairable after the fact. `lib.js` threads `?facility=` here by
    listing `/api/netbox/sites` in `FACILITY_PREFIXES`."""

    def get(self, request):
        facility = _facility(request)
        if facility is None:
            return HttpResponseBadRequest('invalid facility')
        q = request.GET.get('q', '')
        qs = facility_sites(facility, user=request.user)
        if q:
            qs = qs.filter(name__icontains=q)
        return JsonResponse({'sites': [{
            'id': s.pk,
            'name': s.name,
            'slug': s.slug,
            'url': request.build_absolute_uri(s.get_absolute_url()),
        } for s in qs[:200]]})


class NbFacilitiesView(LoginRequiredMixin, View):
    """Enumerate the facilities the SPA picker offers (MULTI-2).

    A facility = a `dcim.SiteGroup`/`Region` slug (per the install-wide grouping setting); the
    default facility is ''. Returns every grouping object the user may view — each flagged whether
    it already has an imported map — plus the default facility when it has content, so an empty one
    can be picked to import a *new* facility. Login-only (the objects are ordinary NetBox
    organizational data, already object-permission scoped in `facilities.list_facilities`).

    POST sets the install-wide `facility_grouping` (`'sitegroup'|'region'`) the whole picker
    resolves against (MULTI-3). It's admin-tier configuration, so — unlike the login-only GET —
    it's gated inline on `IMPORT_PERM` (the same gate as the import wizard that fronts it and the
    `SettingsView`), and merged into the single `settings` blob so the `room_embed_*` keys are
    preserved. The value is install-wide, so it lives only in the default-facility (`facility=''`)
    settings row and this endpoint carries no `?facility=`."""

    def get(self, request):
        return JsonResponse(list_facilities(request.user))

    def post(self, request):
        if not request.user.has_perm(IMPORT_PERM):
            return HttpResponseForbidden('import permission required')
        try:
            payload = json.loads(request.body or b'{}')
        except json.JSONDecodeError:
            return HttpResponseBadRequest('invalid JSON')
        chosen = payload.get('grouping')
        if chosen not in GROUPING_CHOICES:
            return HttpResponseBadRequest(
                'grouping must be one of: %s' % ', '.join(GROUPING_CHOICES))
        # Belt-and-suspenders against silent orphaning (HEALTH-1): changing the grouping re-scopes
        # which facility every Site resolves to, so an install that already holds map data can have
        # its blobs stranded under the old key. Refuse a *change* on a populated install unless the
        # caller explicitly confirms — so an accidental save (or an unattended API client) can't wipe
        # the map from view. First-time setup (no editor content) and a no-op re-save are unaffected;
        # the wizard sends `confirm: true` after warning the user, and the Settings page reassigns
        # anything that does get orphaned.
        if chosen != grouping() and not payload.get('confirm') \
                and FacilityMapBlob.objects.filter(kind__in=EDITOR_KINDS).exists():
            return JsonResponse(
                {'ok': False, 'error': 'confirm_required',
                 'detail': 'Changing the facility grouping re-scopes existing map data — some may '
                           'become unassigned. Reassign it afterward from the Settings page.'},
                status=409)
        # Merge onto the existing settings document so the room-embed controls survive, going
        # through the shared snapshot-before-overwrite upsert so the AUDIT-1 change-log entry
        # carries the before/after diff and an unchanged save is suppressed (mirrors
        # SettingsView.post; see _save_blob).
        with transaction.atomic():
            row = FacilityMapBlob.objects.select_for_update().filter(
                kind='settings', facility='', key='').first()
            data = dict(row.data if row else {})
            data['facility_grouping'] = chosen
            _save_blob(row, kind='settings', facility='', data=data)
        return JsonResponse({'ok': True, 'grouping': chosen})


class FloorLabelFieldSettingView(LoginRequiredMixin, View):
    """POST the install-wide `floor_label_field` setting from the in-app Settings page (SET-1).

    Which NetBox Location field (`name`/`slug`/`description`) seeds a floor's display label when a
    floor is picked from a Location during import. This setting used to live on the NetBox-chrome'd
    `views.SettingsView`; the split now puts NetBox-interaction settings (the `room_embed_*` embed
    controls, `facility_grouping`) on that page and everything else on the map's own `#/settings`
    page — this is the first move. Admin-tier configuration, so gated inline on `IMPORT_PERM` (the
    same gate the old SettingsView and the import wizard use, PERM-1), unlike the login-only NetBox
    reads. The value is clamped to the `FLOOR_LABEL_FIELDS` allowlist and merged into the single
    install-wide (`facility=''`, MULTI-1) `settings` blob so the `room_embed_*`/`facility_grouping`
    keys are preserved — through the shared snapshot-before-overwrite upsert so the AUDIT-1
    change-log entry carries the before/after diff and an unchanged save is suppressed (mirrors
    `NbFacilitiesView.post`; see `_save_blob`). It does not carry a `?facility=` — the setting is
    install-wide, so it lives only in the default-facility settings row.

    A truly-unset value still defers to the `PLUGINS_CONFIG floor_label_field` default then `'name'`
    (`views._floor_label_field`); saving here pins the effective value into the blob, which then wins
    over config. Read-back happens through `window.MAP.floorLabelField` (stamped by `MapView`), so
    there is no GET here."""

    def post(self, request):
        if not request.user.has_perm(IMPORT_PERM):
            return HttpResponseForbidden('import permission required')
        try:
            payload = json.loads(request.body or b'{}')
        except json.JSONDecodeError:
            return HttpResponseBadRequest('invalid JSON')
        # Enum-safe: a bogus value clamps to FLOOR_LABEL_FIELD_DEFAULT rather than 400ing, mirroring
        # how the old SettingsView.post treated this string-valued setting.
        field = clamp_floor_label_field(payload.get('floor_label_field'))
        with transaction.atomic():
            row = FacilityMapBlob.objects.select_for_update().filter(
                kind='settings', facility='', key='').first()
            data = dict(row.data if row else {})
            data['floor_label_field'] = field
            _save_blob(row, kind='settings', facility='', data=data)
        return JsonResponse({'ok': True, 'floor_label_field': field})


class DefaultFacilitySettingView(LoginRequiredMixin, View):
    """POST the install-wide `default_facility` setting from the in-app Settings page (SET-2).

    Which facility the SPA boots into when the URL hash names none (`App.init`). An install whose
    default facility `''` is empty sends every plain visit to the import wizard; letting an operator
    pin an already-imported facility as the boot default resolves that whole class of nag. Stored as
    the `default_facility` key in the single install-wide (`facility=''`, MULTI-1) `settings` blob
    beside `floor_label_field`/`facility_grouping`/`room_embed_*`, merged through the shared
    snapshot-before-overwrite upsert so those sibling keys survive and the AUDIT-1 change-log entry
    carries the before/after diff (mirrors `FloorLabelFieldSettingView`; see `_save_blob`). It carries
    no `?facility=` — the setting is install-wide, living only in the default-facility settings row.
    Admin-tier configuration, gated inline on IMPORT_PERM (PERM-1), like the setting it sits beside.

    The submitted slug is clamped to a reachable, content-having facility (or `''`) before storing — a
    bogus, empty, or stale value coerces to `''` rather than 400ing, matching how `default_facility()`
    degrades a pin that later goes stale (HEALTH-1). Read-back is through `window.MAP.defaultFacility`
    (stamped by `MapView` via `facilities.default_facility`), so there is no GET."""

    def post(self, request):
        if not request.user.has_perm(IMPORT_PERM):
            return HttpResponseForbidden('import permission required')
        try:
            payload = json.loads(request.body or b'{}')
        except json.JSONDecodeError:
            return HttpResponseBadRequest('invalid JSON')
        slug = clamp_default_facility(payload.get('default_facility') or '')
        with transaction.atomic():
            row = FacilityMapBlob.objects.select_for_update().filter(
                kind='settings', facility='', key='').first()
            data = dict(row.data if row else {})
            data['default_facility'] = slug
            _save_blob(row, kind='settings', facility='', data=data)
        return JsonResponse({'ok': True, 'default_facility': slug})


def _trim_rack(rack, request):
    """Shape a Rack for the frontend (mirrors `NetBoxProxy._trim_rack`)."""
    return {
        'id': rack.pk,
        'name': rack.name,
        'url': request.build_absolute_uri(rack.get_absolute_url()),
        'u_height': rack.u_height,
        # Mirrors `_trim`'s exposure of `description` — surfaced on the rack card so a
        # location note (e.g. "east wall") is visible without opening NetBox.
        'description': rack.description,
    }


def _trim_device(device, request):
    """Shape a Device for the frontend (mirrors `NetBoxProxy._trim_device`). The
    marker glyph is keyed off `role.slug`/`name` (device-name fallback), so keep role
    populated; a device without a role degrades gracefully to the name heuristic."""
    role = device.role
    dtype = device.device_type
    return {
        'id': device.pk,
        'name': device.name or str(device),
        'url': request.build_absolute_uri(device.get_absolute_url()),
        'role': {'slug': role.slug, 'name': role.name} if role else None,
        'device_type': {'model': dtype.model, 'u_height': dtype.u_height} if dtype else None,
    }


class NbRacksView(LoginRequiredMixin, View):
    """Racks directly in a Location (the room). ORM equivalent of `NetBoxProxy.racks`."""

    def get(self, request):
        loc = request.GET.get('location', '')
        if not loc:
            return JsonResponse({'racks': []})
        qs = Rack.objects.restrict(request.user, 'view').filter(location_id=loc)
        return JsonResponse({'racks': [_trim_rack(x, request) for x in qs]})


class NbDevicesView(LoginRequiredMixin, View):
    """Devices assigned to a Location but not mounted in any rack (racked devices are
    shown under their rack). ORM equivalent of `NetBoxProxy.unracked_devices`."""

    def get(self, request):
        loc = request.GET.get('location', '')
        if not loc:
            return JsonResponse({'devices': []})
        qs = Device.objects.restrict(request.user, 'view').filter(
            location_id=loc, rack__isnull=True)
        return JsonResponse({'devices': [_trim_device(x, request) for x in qs]})
