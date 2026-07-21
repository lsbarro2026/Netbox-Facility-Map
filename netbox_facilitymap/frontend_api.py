"""JSON endpoints for the map frontend.

These replace the standalone `server.py` routes. They are plain Django views (not
DRF) mounted *under the plugin's page mount* (`/plugins/facilitymap/api/...`), so they
ride NetBox's session auth and Django's CSRF middleware directly — the frontend posts
its session CSRF token in the `X-CSRFToken` header (see `Api.post` in `lib.js`). The
contract (paths, request/response shapes) is identical to the old server so the
framework-free frontend is reused unchanged.

Six families:
  * Annotations — `AnnotationsView`: room polygons are the relational `Room` model
    (Phase 4), while each floor's `image`/`w`/`h`/`arrows` stay in the `annotations`
    blob. GET composes the whole-document shape (blob floors + `Room` rows merged back
    in); POST decomposes it (rooms → `Room` rows, the rest → the blob). The frontend
    round-trips byte-for-byte and is unchanged. GET rides the map-read gate; POST
    requires `EDIT_PERM`.
  * Blob persistence — `siteplan` / `placements` / `layouts`: GET returns the whole
    stored document (or its default), POST upserts it. One `FacilityMapBlob` row per
    kind. GET rides the map-read gate; POST requires `EDIT_PERM`.
  * Floor to-do list — `TodosView`/`TodoView`/`TodoDeleteView`: a per-room to-do list
    (`RoomTodo`) for tracking floor work. GET lists a floor's to-dos grouped by room;
    POST creates/updates/deletes one. GET rides the map-read gate; POST requires
    `EDIT_PERM`.
  * Users lookup — `UsersView`: a searchable list of active NetBox users, backing the
    to-do assignee picker. Rides the map-read gate only — no `EDIT_PERM`, since a
    viewer must be able to render assignee avatars on existing to-dos without edit
    rights.
  * NetBox reads/writes — `netbox/rooms`, `netbox/locations`, `netbox/sites`,
    `netbox/facilities`, `netbox/racks`, `netbox/devices`, `netbox/device-roles`,
    `netbox/device-types`, `netbox/devices/suggest-name`: direct ORM queries over
    `dcim` models, restricted by the requester's object permissions, replacing the
    token-holding proxy. There is no longer a persisted `rackcache` — racks/devices are
    fetched live per room. Two of these are the plugin's only writes into `dcim` core —
    `netbox/locations/create` and `netbox/devices/create` — each gated by an
    install-wide setting plus the matching `dcim.add_location`/`dcim.add_device` object
    permission, on top of the ordinary login gate the reads use.
  * Settings — `FloorLabelFieldSettingView`, `DefaultFacilitySettingView`,
    `WriteModeSettingView`, `ApToolSettingView`, `ApDeviceRoleSettingView`,
    `ApNamingSettingView`, plus `NbFacilitiesView`'s POST half: install-wide
    configuration posted from the map's own `#/settings` page, merged into the single
    install-wide `settings` blob. Login-gated, and additionally requires
    `IMPORT_PERM` — admin-tier configuration, stricter than a login-only NetBox read.
"""

import json
import re
from datetime import date

from django.contrib.auth import get_user_model
from django.contrib.auth.mixins import LoginRequiredMixin
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Q
from django.http import (
    HttpResponseBadRequest, HttpResponseForbidden, HttpResponseNotFound, JsonResponse,
)
from django.urls import reverse
from django.utils.text import slugify
from django.views import View

from dcim.models import Device, DeviceRole, DeviceType, Location, Rack, Site

from .access import EDIT_PERM, IMPORT_PERM, MapReadAccessMixin
from .facilities import (
    EDITOR_KINDS, GROUPING_CHOICES, clamp_default_facility, facility_floor_scope, facility_sites,
    grouping, list_facilities,
)
from .models import FacilityMapBlob, Room, RoomTodo, parse_floor_key
from .previews import (
    ap_settings, clamp_ap_count_scope, clamp_ap_device_role, clamp_floor_label_field,
    clean_ap_name_template, expand_ap_name_template, inline_room_creation_enabled, todos_enabled,
    write_mode_enabled,
)
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
    """Opaque concurrency token for a single-row blob (`siteplan`/`settings`): its `updated`
    timestamp (ISO), or '' when the row doesn't exist yet (a first write has nothing to conflict
    with). The per-floor sharded kinds carry a *map* of these instead (`_shard_versions`)."""
    return row.updated.isoformat() if row else ''


def _shard_versions(rows_by_key):
    """The per-floor concurrency token map `{floor_key: token}` for a sharded kind — one token
    (the row's `updated`, ISO) per stored floor. Serialized as JSON into the `X-Facilitymap-Version`
    header so a save can prove it holds the current version of *each floor it touches*, which is
    what makes different-floor saves genuinely non-conflicting (CONC-1). `rows_by_key` maps
    `floor_key -> FacilityMapBlob`."""
    return {key: row.updated.isoformat() for key, row in rows_by_key.items()}


def _sent_shard_versions(request):
    """Parse the client's per-floor token map from the request header, or `None` when the header
    is absent. Absent skips the check (opt-in, matching the single-row `_version_conflict`); a
    present-but-malformed header degrades to an empty map (every touched floor then reads as a
    first write, conflicting iff a row already exists) rather than 500ing."""
    sent = request.headers.get(VERSION_HEADER)
    if sent is None:
        return None
    try:
        parsed = json.loads(sent)
    except (json.JSONDecodeError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _save_blob(row, *, kind, facility, key='', data):
    """Upsert one blob row and return the saved row, recording an audit entry.

    `row` is the existing `(kind, facility, key)` row already fetched under `select_for_update()`,
    or `None` on a first write. `key` is `''` for the single-row kinds (`siteplan`/`settings`) and
    the `floor_key` for a per-floor shard (CONC-1). Saving that same instance (rather than a fresh
    `update_or_create`) is what lets the change-log receiver see the pre-change snapshot: we
    `snapshot()` before overwriting so the `ObjectChange` carries the before/after diff and an
    unchanged document is suppressed as a no-op (AUDIT-1). A first write is an insert (create
    entry, no prechange). Assumes an open transaction and a caller-verified version token."""
    if row is None:
        return FacilityMapBlob.objects.create(kind=kind, facility=facility, key=key, data=data)
    row.snapshot()
    row.data = data
    row.save()
    return row


def _delete_blob_shard(row):
    """Delete an emptied per-floor shard row — the floor lost its last room/arrow/note (or
    placement / non-default layout), so it should leave no row behind (mirroring the whole-doc
    prune that used to drop it). A plain delete so NetBox's change log records the removal; a
    `None` row is a no-op (nothing was stored)."""
    if row is not None:
        row.delete()


def _version_conflict(row, request):
    """Return a 409 `JsonResponse` when the client's concurrency token doesn't match `row`'s
    current version, else `None` — the single-row (`siteplan`/`settings`) guard. Opt-in: a
    *missing* header skips the check (so non-versioned callers keep working), while a *present*
    token — including '' for the first-write case — is enforced. The caller must have
    `select_for_update()`d `row` inside a transaction so the check-then-write can't race."""
    sent = request.headers.get(VERSION_HEADER)
    if sent is None or sent == _blob_version(row):
        return None
    return _conflict_response()


def _shard_conflicts(payload_keys, sent_versions, rows_by_key):
    """Floor keys whose sent token doesn't match the stored version — the sharded analogue of
    `_version_conflict`. For each floor the POST touches, its sent token must equal the stored
    row's `updated` (or '' when no row exists yet — a first write). `sent_versions is None`
    (missing header) skips the check entirely (opt-in). Returns the sorted conflicting floor keys
    (empty = clear to write)."""
    if sent_versions is None:
        return []
    conflicts = [key for key in payload_keys
                 if sent_versions.get(key, '')
                 != (rows_by_key[key].updated.isoformat() if key in rows_by_key else '')]
    return sorted(conflicts)


def _conflict_response(conflicts=None):
    """The 409 body for a stale save. `conflicts` (a floor-key list) is included for the sharded
    path so the client can point the user at the specific floors; omitted for the single-row
    kinds. The friendly `detail` is the guidance the client surfaces (see `lib.js` `Api._fail`)."""
    body = {'ok': False, 'error': 'conflict',
            'detail': 'The map changed since you loaded it — reload and re-apply your edits.'}
    if conflicts is not None:
        body['conflicts'] = conflicts
    return JsonResponse(body, status=409)


def _parse_json_body(request):
    """Parse `request.body` as a JSON object for a POST view that immediately indexes into it by
    key. Returns `(payload, None)` on success, `(None, error_response)` on failure — a
    syntactically invalid body and a valid-but-non-object body (e.g. `[]`, `"str"`, `5`) both 400
    rather than letting the caller's `payload.get(...)` 500 with an `AttributeError`."""
    try:
        payload = json.loads(request.body or b'{}')
    except json.JSONDecodeError:
        return None, HttpResponseBadRequest('invalid JSON')
    if not isinstance(payload, dict):
        return None, HttpResponseBadRequest('invalid JSON')
    return payload, None


# kind -> the default document the standalone server returned when a file was absent.
# (`annotations` is served by AnnotationsView, not BlobView, so it isn't listed here.)
BLOB_DEFAULTS = {
    'siteplan': lambda: {'hotspots': []},
    'placements': dict,
    'layouts': dict,
}


# Per-floor sharded kinds keep one row per floor (`key=floor_key`) whose emptiness governs whether
# the row survives a save — the whole-doc prune, moved server-side. A floor is "empty" (delete its
# row) when it carries no meaningful content; `siteplan` is a single facility-wide row and never
# shards. (`annotations` shards too but has its own emptiness rule — no rooms/arrows/notes — in
# `AnnotationsView`, because its rooms live in the `Room` table, not the blob.)
_SHARD_EMPTY = {
    'placements': lambda d: not (d or {}).get('placements'),
    'layouts': lambda d: not (d or {}).get('grid'),
}


def _placements_with_urls(docs, request):
    """Return a copy of a sharded placements document (`{floor_key: {'placements': [...]}}`) with
    each rack/device placement's NetBox detail URL attached as `url`, for the search widget's
    NetBox-target mode (NAV-16 — placed rooms already carry their bound Location's `url` via `_trim`;
    a placement is pure blob, so its object's URL must be surfaced here rather than reconstructed in
    JS from a hardcoded `/dcim/...` path). The URL is derived from the *live* object via
    `get_absolute_url()` and scoped to what the user may view (`.restrict(user,'view')`), so a
    placement whose object was deleted or is hidden simply gets no `url` and the finder falls back to
    the map for it. Read-only: builds a fresh dict, never mutating the stored blob rows."""
    rack_ids, device_ids = set(), set()
    for doc in docs.values():
        if not isinstance(doc, dict):
            continue
        for p in (doc.get('placements') or []):
            pk = p.get('id')
            if pk is None:
                continue
            (device_ids if p.get('kind') == 'device' else rack_ids).add(pk)
    racks = Rack.objects.restrict(request.user, 'view').in_bulk(rack_ids) if rack_ids else {}
    devices = Device.objects.restrict(request.user, 'view').in_bulk(device_ids) if device_ids else {}
    out = {}
    for fkey, doc in docs.items():
        if not isinstance(doc, dict) or 'placements' not in doc:
            out[fkey] = doc
            continue
        placements = []
        for p in (doc.get('placements') or []):
            obj = (devices if p.get('kind') == 'device' else racks).get(p.get('id'))
            placements.append({**p, 'url': request.build_absolute_uri(obj.get_absolute_url())}
                              if obj else p)
        out[fkey] = {**doc, 'placements': placements}
    return out


class BlobView(MapReadAccessMixin, View):
    """GET the stored document for one `kind` (or its default); POST upserts it.

    `siteplan` is one facility-wide row (`sharded=False`). `placements`/`layouts` are **per-floor
    sharded** (`sharded=True`, CONC-1): stored one row per floor (`key=floor_key`), so a POST
    carrying only the floors an editor touched conflict-checks + writes just those — different-floor
    saves never collide. The sharded GET composes every floor row back into the whole-document shape
    the frontend round-trips, and the version header carries a per-floor token *map*.

    GET rides the shared map-read gate; POST additionally requires `EDIT_PERM` below (a viewer
    reads but cannot write)."""
    kind = None
    sharded = False

    def get(self, request):
        facility = _facility(request)
        if facility is None:
            return HttpResponseBadRequest('invalid facility')
        if self.sharded:
            rows = {r.key: r for r in FacilityMapBlob.objects.filter(
                kind=self.kind, facility=facility).exclude(key='')}
            docs = {key: row.data for key, row in rows.items()}
            # Placed racks/devices are pure blob, so surface each one's NetBox URL server-side for
            # the search widget's NetBox-target mode (NAV-16) rather than reconstructing it in JS.
            if self.kind == 'placements':
                docs = _placements_with_urls(docs, request)
            resp = JsonResponse(docs, safe=False)
            resp[VERSION_HEADER] = json.dumps(_shard_versions(rows))
            return resp
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
        data, error = _parse_json_body(request)
        if error:
            return error
        if self.sharded:
            return self._post_sharded(request, facility, data)
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

    def _post_sharded(self, request, facility, data):
        """Upsert a `{floor_key: record}` payload one row per floor. Each floor is conflict-checked
        against its own token; a floor whose record is empty (`_SHARD_EMPTY`) has its row deleted
        (the whole-doc prune). Only the floors in the payload are locked, checked and written, so
        two editors saving different floors don't block or 409 each other."""
        empty = _SHARD_EMPTY[self.kind]
        sent = _sent_shard_versions(request)
        with transaction.atomic():
            keys = list(data.keys())
            rows = {r.key: r for r in FacilityMapBlob.objects.select_for_update().filter(
                kind=self.kind, facility=facility, key__in=keys)}
            conflicts = _shard_conflicts(keys, sent, rows)
            if conflicts:
                return _conflict_response(conflicts)
            written = {}
            for fkey, fdata in data.items():
                if empty(fdata):
                    _delete_blob_shard(rows.get(fkey))
                else:
                    written[fkey] = _save_blob(rows.get(fkey), kind=self.kind,
                                               facility=facility, key=fkey, data=fdata)
            for row in written.values():
                row.refresh_from_db(fields=['updated'])
        resp = JsonResponse({'ok': True})
        resp[VERSION_HEADER] = json.dumps(_shard_versions(written))
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
        'alias': room.alias,
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
    """The floor `dcim.Location` a `floor_key` names, or `None` when it can't be resolved today — an
    empty/malformed key, a floor-type floor whose slug has no Location, or a slug that has since
    drifted (renamed). Handles both building-anchor shapes (`parse_floor_key`): a 2-segment
    Site-anchored key resolves the floor by `(site slug, floor slug)`; a 3-segment Location-anchored
    key additionally scopes it **under the building Location** (`parent__slug`), since two buildings
    under one campus can legitimately have floors with the same slug (e.g. both `level-1`). Mirrors
    how `NbRoomsView`/`health` resolve a floor key by its slugs. Used to (re)establish
    `Room.floor_location`, the BIND-1 rename-proof anchor, on save."""
    site_slug, building_slug, floor_slug = parse_floor_key(floor_key)
    if not (site_slug and floor_slug):
        return None
    qs = Location.objects.filter(site__slug=site_slug, slug=floor_slug)
    if building_slug:
        qs = qs.filter(parent__slug=building_slug)
    return qs.first()


def sync_rooms(rooms_by_floor, user=None, facility='', *, sweep_absent=True):
    """Upsert `Room` rows from a decomposed annotations document and delete the rest.
    Each posted floor is authoritative for *itself*: rooms absent from a posted floor are removed —
    including a room authored out-of-band through the REST API (it carries a `room_id` the editor
    never emitted, so it isn't in `seen`); see the sweep-on-save caveat in `api/serializers.py`.

    `sweep_absent` governs the cross-floor pass. When `True` (the trusted, whole-facility
    `facilitymap_import` command) rooms of the facility's floors that are absent *entirely* from
    the document are also removed — an authoritative-over-the-whole-facility save. When `False`
    (the per-floor editor POST, CONC-1) that sweep is **skipped**: the editor sends only the floors
    it touched, so a floor's mere absence means "not edited", not "delete its rooms" — sweeping
    would wipe other floors' rooms (a per-floor save must scope room sync to its own floors). A
    floor emptied on purpose is still sent (with no rooms), so its per-floor delete below removes
    its rooms; nothing is lost.

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
                    'alias': room.get('alias') or '',
                    'polygon': room.get('polygon') or [],
                    'location_id': loc_id,
                    **floor_defaults,
                })
        del_qs.filter(floor_key=fkey).exclude(room_id__in=seen).delete()
    if not sweep_absent:
        return
    # Remove rooms of the facility's floors that the document dropped entirely. Scope to the
    # facility (Room has no facility column) so other facilities' rooms are never touched; a
    # facility with no sites contributes no scope, so the cross-floor sweep is skipped. The
    # facility→site mapping is resolved unscoped (it bounds which floors are the facility's, not
    # who may see them); `del_qs` already carries the `restrict(user,'delete')` permission scope.
    scope = facility_floor_scope(facility)
    if scope is not None:
        del_qs.filter(scope).exclude(floor_key__in=list(rooms_by_floor.keys())).delete()


class AnnotationsView(MapReadAccessMixin, View):
    """GET composes the whole annotations document (per-floor blob rows + `Room` rows); POST
    decomposes it (rooms → `Room` rows, the rest → the `annotations` blob). Same path and
    request/response *body* shapes as the standalone server, so the frontend is unchanged; the
    version header carries a per-floor token *map* (CONC-1).

    **Per-floor sharded (CONC-1).** Each floor's `image`/`w`/`h`/`arrows`/`notes` is one row
    (`key=floor_key`); a POST carries only the floors an editor touched, conflict-checks + writes
    just those, and never touches other floors' rows or rooms — so two editors on different floors
    don't collide. A floor whose posted record has no rooms, arrows or notes is deleted (row +
    rooms), the whole-doc prune moved server-side.

    GET rides the shared map-read gate; POST additionally requires `EDIT_PERM`."""

    def get(self, request):
        facility = _facility(request)
        if facility is None:
            return HttpResponseBadRequest('invalid facility')
        rows = {r.key: r for r in FacilityMapBlob.objects.filter(
            kind='annotations', facility=facility).exclude(key='')}
        blob_data = {key: row.data for key, row in rows.items()}
        doc = compose_annotations(blob_data, request.user, request, facility)
        # A token per floor in the composed doc: its row's `updated`, or '' for a room-only floor
        # with no blob row yet (its first blob write has nothing to conflict with).
        versions = {fkey: (rows[fkey].updated.isoformat() if fkey in rows else '') for fkey in doc}
        resp = JsonResponse(doc, safe=False)
        resp[VERSION_HEADER] = json.dumps(versions)
        return resp

    def post(self, request):
        if not request.user.has_perm(EDIT_PERM):
            return HttpResponseForbidden('permission denied')
        facility = _facility(request)
        if facility is None:
            return HttpResponseBadRequest('invalid facility')
        doc, error = _parse_json_body(request)
        if error:
            return error
        blob, rooms_by_floor = _split_annotations(doc)
        sent = _sent_shard_versions(request)
        with transaction.atomic():
            keys = list(doc.keys())
            rows = {r.key: r for r in FacilityMapBlob.objects.select_for_update().filter(
                kind='annotations', facility=facility, key__in=keys)}
            conflicts = _shard_conflicts(keys, sent, rows)
            if conflicts:
                return _conflict_response(conflicts)
            # Sync only the posted floors' rooms — sweep_absent=False so a floor's mere absence
            # never deletes its rooms (the editor sends only what it touched; CONC-1 gotcha #3).
            sync_rooms(rooms_by_floor, request.user, facility, sweep_absent=False)
            written = {}
            for fkey in keys:
                fblob = blob.get(fkey) or {}
                # A floor with no rooms, arrows or notes is empty — delete its row (and its rooms,
                # already removed by the sync above). Rooms live in `Room`, not the blob, so
                # emptiness is judged on the split-out rooms, not on `fblob` (which may still carry
                # image/w/h). `_save_blob` snapshots first, so a rooms-only edit whose blob is
                # unchanged is suppressed as a no-op (AUDIT-1) — entries are now per-floor.
                if not (rooms_by_floor.get(fkey) or fblob.get('arrows') or fblob.get('notes')):
                    _delete_blob_shard(rows.get(fkey))
                else:
                    written[fkey] = _save_blob(rows.get(fkey), kind='annotations',
                                               facility=facility, key=fkey, data=fblob)
            for row in written.values():
                row.refresh_from_db(fields=['updated'])
        resp = JsonResponse({'ok': True})
        resp[VERSION_HEADER] = json.dumps(_shard_versions(written))
        return resp


# ---- Floor to-do list (ADDON-1) ----
# A per-room to-do list on the floor page. Reads ride the shared map-read gate (anyone who can see
# the floor sees its to-dos); writes require `EDIT_PERM` like every other map mutation. A to-do is
# addressed only through a room the requester may `view`, so object permissions on a room's
# Location gate its to-dos too. The frontend `Api` client is GET/POST-only, so updates and deletes
# are POSTs (`/api/todos/<id>` and `/api/todos/<id>/delete`) rather than PATCH/DELETE — matching the
# GET/POST-only convention every other endpoint here follows.

_TODO_STATUSES = {c[0] for c in RoomTodo.STATUS_CHOICES}
_TODO_PRIORITIES = {c[0] for c in RoomTodo.PRIORITY_CHOICES}
_TODO_TEXT_MAX = RoomTodo._meta.get_field('text').max_length
#: The updatable columns on the row itself — `assignees` is excluded because it's an M2M write, not
#: a column, and needs no `save()`.
_TODO_COLUMNS = {'text', 'status', 'priority', 'notes', 'due'}


def serialize_user(user):
    """The display shape of a user — id/username/display/initials and nothing else: both to-do
    assignees and the users picker (TASK-2) ride the map-read gate, so this leaks a user's name to
    anyone who can see the floor, and there is no reason to widen that to emails or permission
    flags. `initials` backs the assignee avatar chip: the first letter of each of the display
    name's first two words, or the display's first two characters when it's a single word (the
    common case — no full name set, so `display` is just the username).

    Public (not `_`-prefixed) because `views.MapView` reuses it to stamp the *requesting* user into
    `window.MAP.user` (TASK-3): the to-do surfaces sort a user's own to-dos first, which needs the
    viewer's identity in the same shape an assignee arrives in, so the ids compare directly."""
    display = user.get_full_name() or user.username
    words = display.split()
    initials = ''.join(w[0] for w in words[:2]) if len(words) > 1 else display[:2]
    return {'id': user.id, 'username': user.username, 'display': display,
            'initials': initials.upper()}


def _serialize_todo(todo):
    """Shape a `RoomTodo` row for the frontend to-do panel. `due` goes out as an ISO date string
    (or null); `assignees` is prefetched by the callers that list many to-dos at once."""
    return {
        'id': todo.id,
        'text': todo.text,
        'status': todo.status,
        'priority': todo.priority,
        'notes': todo.notes,
        'due': todo.due.isoformat() if todo.due else None,
        'assignees': [serialize_user(u) for u in todo.assignees.all()],
    }


def _resolve_assignees(raw):
    """Validate a client-supplied assignee list into `User` rows, or raise `ValueError`.

    Never trusts the posted PKs: an id that isn't an active user is a hard 400 rather than a silent
    drop, so a typo'd assignment fails loudly instead of quietly creating a to-do nobody owns."""
    if not isinstance(raw, list):
        raise ValueError('assignees must be a list of user ids')
    try:
        ids = {int(i) for i in raw}
    except (TypeError, ValueError):
        raise ValueError('assignees must be a list of user ids')
    users = list(get_user_model().objects.filter(pk__in=ids, is_active=True))
    if len(users) != len(ids):
        raise ValueError('unknown or inactive assignee')
    return users


def _apply_todo_fields(payload, todo):
    """Apply the optional `status`/`priority`/`notes`/`due` fields present in `payload` to `todo`
    (unsaved), validating each at the boundary. Returns the parsed assignee list, or `None` when the
    payload doesn't mention assignees — the M2M needs a PK, so the caller sets it after `save()`.
    Raises `ValueError` with a client-safe message. Shared by the create and update paths so both
    enforce one rule set."""
    if 'status' in payload:
        if payload.get('status') not in _TODO_STATUSES:
            raise ValueError('invalid status')
        todo.status = payload['status']
    if 'priority' in payload:
        if payload.get('priority') not in _TODO_PRIORITIES:
            raise ValueError('invalid priority')
        todo.priority = payload['priority']
    if 'notes' in payload:
        todo.notes = (payload.get('notes') or '').strip()
    if 'due' in payload:
        due = payload.get('due')
        # An explicit null/empty string clears the date — that's how the UI unsets it.
        if due in (None, ''):
            todo.due = None
        else:
            try:
                todo.due = date.fromisoformat(due)
            except (TypeError, ValueError):
                raise ValueError('due must be an ISO date (YYYY-MM-DD)')
    return _resolve_assignees(payload['assignees']) if 'assignees' in payload else None


def _todos_for(rooms):
    """Every `RoomTodo` of `rooms`, ready to serialize. `assignees` is prefetched and `room`
    selected because the callers list a whole floor's — or a whole facility's — to-dos at once, and
    walking the M2M per row would be an N+1 that grows with the map. The query count is constant
    either way, which is what lets the facility-wide read reuse this unchanged."""
    return (RoomTodo.objects.filter(room__in=rooms)
            .select_related('room').prefetch_related('assignees'))


class TodoFeatureGateMixin:
    """Refuses every request while the to-do add-on is switched off (ADDON-4) — the server-side half
    of the feature gate whose UX mirror hides the to-do pages, the floor panel, and the compose icon
    (`window.MAP.todos`). Mixed in **ahead of** `MapReadAccessMixin` on each `api/todos*` view, so a
    disabled feature 404s before the read gate even runs.

    A 404 (not a 403) is the honest status: when the operator hasn't switched the feature on, the
    to-do endpoints are not a resource this install exposes at all, exactly as they wouldn't be if
    the routes were absent — the client, mirroring the same setting, never calls them. The setting is
    install-wide, read live from the settings blob, so flipping the toggle closes/opens these without
    a worker restart, like `write_mode` re-checks in its write endpoints."""

    def dispatch(self, request, *args, **kwargs):
        if not todos_enabled():
            return HttpResponseNotFound('the to-do feature is not enabled')
        return super().dispatch(request, *args, **kwargs)


class TodosView(TodoFeatureGateMixin, MapReadAccessMixin, View):
    """GET lists a floor's to-dos grouped by `room_id`; POST creates one. GET rides the shared
    map-read gate; POST additionally requires `EDIT_PERM`.

    A floor is named by its `floor_key` (`"<site.slug>/<floor.slug>"`), which embeds the
    globally-unique site slug, so a single floor already belongs to exactly one facility — no
    separate `?facility=` scoping is needed here (unlike the whole-document blob reads). The
    facility-wide rollup, which has no floor to imply a facility, is `FacilityTodosView`."""

    def get(self, request):
        floor_key = request.GET.get('floor_key', '')
        if not floor_key:
            return HttpResponseBadRequest('floor_key required')
        rooms = Room.objects.restrict(request.user, 'view').filter(floor_key=floor_key)
        by_room = {}
        for todo in _todos_for(rooms):
            by_room.setdefault(todo.room.room_id, []).append(_serialize_todo(todo))
        return JsonResponse(by_room)

    def post(self, request):
        if not request.user.has_perm(EDIT_PERM):
            return HttpResponseForbidden('permission denied')
        payload, error = _parse_json_body(request)
        if error:
            return error
        floor_key = (payload.get('floor_key') or '').strip()
        room_id = (payload.get('room_id') or '').strip()
        text = (payload.get('text') or '').strip()
        if not (floor_key and room_id and text):
            return HttpResponseBadRequest('floor_key, room_id and text are required')
        if len(text) > _TODO_TEXT_MAX:
            return HttpResponseBadRequest('to-do text is too long')
        # Only a room the requester may view is a valid target, so a user can't seed to-dos on a
        # room hidden from them by object permission. `(floor_key, room_id)` is the room's stable
        # identity (the `sync_rooms` upsert key), so the FK survives a later resync.
        room = (Room.objects.restrict(request.user, 'view')
                .filter(floor_key=floor_key, room_id=room_id).first())
        if room is None:
            return HttpResponseBadRequest('unknown room')
        todo = RoomTodo(room=room, text=text)
        try:
            assignees = _apply_todo_fields(payload, todo)
        except ValueError as e:
            return HttpResponseBadRequest(str(e))
        todo.save()
        if assignees is not None:
            todo.assignees.set(assignees)
        return JsonResponse(_serialize_todo(todo), status=201)


class TodoView(TodoFeatureGateMixin, MapReadAccessMixin, View):
    """POST updates a single to-do's `text`, `status`, `priority`, `notes`, `due` and/or
    `assignees` — each optional, applied only when the key is present. Requires `EDIT_PERM`."""

    def _visible(self, request, pk):
        # Addressable only via a room the requester may view — the write mirror of the read scope.
        return (RoomTodo.objects
                .filter(pk=pk, room__in=Room.objects.restrict(request.user, 'view'))
                .first())

    def post(self, request, pk):
        if not request.user.has_perm(EDIT_PERM):
            return HttpResponseForbidden('permission denied')
        payload, error = _parse_json_body(request)
        if error:
            return error
        todo = self._visible(request, pk)
        if todo is None:
            return JsonResponse({'error': 'not found'}, status=404)
        if 'text' in payload:
            text = (payload.get('text') or '').strip()
            if not text:
                return HttpResponseBadRequest('to-do text cannot be empty')
            if len(text) > _TODO_TEXT_MAX:
                return HttpResponseBadRequest('to-do text is too long')
            todo.text = text
        try:
            assignees = _apply_todo_fields(payload, todo)
        except ValueError as e:
            return HttpResponseBadRequest(str(e))
        # Only touch the row when the payload actually carried a column — an assignees-only edit is
        # a pure M2M write and shouldn't bump `last_updated` or log an empty column change.
        if _TODO_COLUMNS & payload.keys():
            todo.save()
        if assignees is not None:
            todo.assignees.set(assignees)
        return JsonResponse(_serialize_todo(todo))


class TodoDeleteView(TodoFeatureGateMixin, MapReadAccessMixin, View):
    """POST permanently removes a single to-do (the "clear" action on a completed item).
    Requires `EDIT_PERM`."""

    def post(self, request, pk):
        if not request.user.has_perm(EDIT_PERM):
            return HttpResponseForbidden('permission denied')
        todo = (RoomTodo.objects
                .filter(pk=pk, room__in=Room.objects.restrict(request.user, 'view'))
                .first())
        if todo is None:
            return JsonResponse({'error': 'not found'}, status=404)
        todo.delete()
        return JsonResponse({'ok': True})


class FacilityTodosView(TodoFeatureGateMixin, MapReadAccessMixin, View):
    """GET every to-do in a facility, grouped `floor_key -> room_id -> [todo]` — the read behind the
    facility-wide to-do page (`TodoPage`, TASK-5). Rides the same map-read gate as `TodosView`.

    A **sibling** of `TodosView` rather than a `?floor_key`-less mode of it, because the shape
    genuinely differs: `room_id` is unique only *within* a floor (`(floor_key, room_id)` is the
    `sync_rooms` upsert key), so a cross-floor response must nest by `floor_key` — and one URL
    returning two shapes depending on which query param arrived is worse than one more view. The
    per-room grouping inside each floor matches `TodosView`'s payload exactly, so the frontend
    reasons about one shape.

    **Facility scoping is explicit here (MULTI-2).** `TodosView` gets it for free — a `floor_key`
    embeds the globally-unique site slug, so naming a floor already names a facility. This view
    names no floor, so it must scope itself, and it does so through the same
    `facility_floor_scope` Q that `compose_annotations`/`sync_rooms` use: a facility's site slugs,
    unioned with the rename-proof `floor_location` FK (BIND-1). The scope is resolved unscoped by
    design (it bounds which floors are the facility's, not who may see them) — the rooms
    themselves stay `.restrict(user, 'view')`, so object permissions on a room's Location still
    gate its to-dos exactly as they do per-floor."""

    def get(self, request):
        facility = _facility(request)
        if facility is None:
            return HttpResponseBadRequest('invalid facility')
        scope = facility_floor_scope(facility)
        # A facility with no sites owns no floors, so it owns no to-dos. Empty, not an error: an
        # install mid-import legitimately has a facility whose Sites aren't bound yet.
        if scope is None:
            return JsonResponse({})
        rooms = Room.objects.restrict(request.user, 'view').filter(scope)
        by_floor = {}
        for todo in _todos_for(rooms):
            room = todo.room
            by_floor.setdefault(room.floor_key, {}).setdefault(room.room_id, []) \
                .append(_serialize_todo(todo))
        return JsonResponse(by_floor)


class UsersView(MapReadAccessMixin, View):
    """GET a searchable list of active NetBox users, for the to-do assignee picker (TASK-2).

    Rides the map-read gate, **not** `EDIT_PERM` — a viewer must be able to render the assignee
    avatars on existing to-dos even without edit rights, matching `TodosView`'s read gate. `?q=`
    substring-filters username/first/last name, mirroring `NbLocationsView`'s free-text search, so
    the picker can search rather than dumping the whole roster; capped like the other picker reads
    (`NbLocationsView`/`NbDeviceRolesView`/`NbDeviceTypesView`)."""

    LIMIT = 200

    def get(self, request):
        q = request.GET.get('q', '').strip()
        qs = get_user_model().objects.filter(is_active=True).order_by('username')
        if q:
            qs = qs.filter(Q(username__icontains=q) | Q(first_name__icontains=q)
                            | Q(last_name__icontains=q))
        return JsonResponse({'users': [serialize_user(u) for u in qs[:self.LIMIT]]})


class NbRoomsView(LoginRequiredMixin, View):
    """Rooms = child Locations of the floor Location; falls back to all Locations under
    the site when the floor slug has no Location. ORM equivalent of `NetBoxProxy.rooms`.

    A **Location-anchored** floor (Site=campus, building is a Location — MODEL-3) is disambiguated by
    an optional `?building=<buildingLocation.slug>`: two buildings under one campus can share a floor
    slug (e.g. both `level-1`), so when `building` is given the floor Location is resolved **under**
    that building Location (`parent__slug`). Absent (the Site-anchored case, and every caller today)
    ⇒ the floor is resolved directly under the Site, exactly as before."""

    def get(self, request):
        site_slug = request.GET.get('site', '')
        building_slug = request.GET.get('building', '')
        floor_slug = request.GET.get('floor', '')
        site = Site.objects.filter(slug=site_slug).first()
        if not site:
            return JsonResponse({'error': 'site not found: ' + site_slug, 'rooms': []})
        locs = Location.objects.restrict(request.user, 'view').filter(site=site)
        floor_qs = locs.filter(parent__slug=building_slug) if building_slug else locs
        floor = floor_qs.filter(slug=floor_slug).first() if floor_slug else None
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

      * install-wide **write mode** must be on — the master gate on everything the plugin writes into
        NetBox core, an operator flips it on the Settings page (off by default, so NetBox stays the
        Location source of truth), read server-side via `previews.write_mode_enabled` (LOC-2,
        replacing the old redeploy-time `allow_location_create` capability flag) — else 403;
      * the **inline room creation** add-on must be on — this feature's own switch, split out of write
        mode by SET-5 so an operator can allow the AP tool's writes while keeping Location creation in
        NetBox's hands (or the reverse), read via `previews.inline_room_creation_enabled` — else 403.
        The same two-switch shape the AP write answers to (`_ap_write_gate`): one master gate, one
        per-feature switch;
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
        if not write_mode_enabled():
            return HttpResponseForbidden('write mode is not enabled')
        if not inline_room_creation_enabled():
            return HttpResponseForbidden('inline room creation is not enabled')
        if not request.user.has_perm('dcim.add_location'):
            return HttpResponseForbidden('permission denied')
        payload, error = _parse_json_body(request)
        if error:
            return error
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


class NbBuildingLocationsView(LoginRequiredMixin, View):
    """Free-text search for **building-anchor Locations**, the sibling of `NbSitesView` (MODEL-4).

    Under the Site = campus topology a building is a `dcim.Location` beneath the campus Site, not a
    Site of its own (BUILDING-ANCHOR-DESIGN §4.1). The import wizard's bind step lets an operator
    anchor a drawing folder to such a building Location; this endpoint backs both the auto-suggest
    pass and the manual override, returning candidate building Locations within the active facility.

    **Facility-scoped exactly like `NbSitesView` (FACIL-1):** results are restricted to Locations
    whose `site` belongs to the requested `?facility=` (`facility_sites`), so an operator can no more
    bind a building Location out-of-facility than a Site — the anchor's site slug still becomes the
    manifest `siteSlug`, and a mismatched grouping would strand the map the same way. `lib.js` threads
    `?facility=` here by listing `/api/netbox/building-locations` in `FACILITY_PREFIXES`.

    **"Building-like" = a Location that has child Locations.** NetBox 4.x has no `LocationType`
    concept to key off (design §8 open-q 1), so the structural signal is the one the wizard already
    reads: a building's children are its floors. Leaf Locations (rooms, or floors with no rooms yet)
    are therefore never offered as anchors, keeping the picker to plausible buildings. `site_slug`/
    `site_name` accompany each hit so the frontend records the campus Site (→ `siteSlug`) alongside
    the building slug (→ `buildingSlug`)."""

    def get(self, request):
        facility = _facility(request)
        if facility is None:
            return HttpResponseBadRequest('invalid facility')
        q = request.GET.get('q', '')
        sites = facility_sites(facility, user=request.user)
        qs = Location.objects.restrict(request.user, 'view').filter(site__in=sites)
        # Building-like: the Location is itself the parent of at least one other Location (its
        # candidate floors). Keyed off the plain `parent` FK column — reliable on any queryset,
        # unlike the MPTT `level`/`depth` artifacts (§_trim), and independent of whether the floors
        # have rooms yet.
        parents = Location.objects.filter(site__in=sites).exclude(parent=None).values('parent')
        qs = qs.filter(pk__in=parents)
        if q:
            qs = qs.filter(Q(name__icontains=q) | Q(slug__icontains=q))
        qs = qs.select_related('site').order_by('name')
        return JsonResponse({'locations': [{
            'id': loc.pk,
            'name': loc.name,
            'slug': loc.slug,
            'site_slug': loc.site.slug,
            'site_name': loc.site.name,
            'url': request.build_absolute_uri(loc.get_absolute_url()),
        } for loc in qs[:200]]})


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
        payload, error = _parse_json_body(request)
        if error:
            return error
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
        payload, error = _parse_json_body(request)
        if error:
            return error
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
        payload, error = _parse_json_body(request)
        if error:
            return error
        slug = clamp_default_facility(payload.get('default_facility') or '')
        with transaction.atomic():
            row = FacilityMapBlob.objects.select_for_update().filter(
                kind='settings', facility='', key='').first()
            data = dict(row.data if row else {})
            data['default_facility'] = slug
            _save_blob(row, kind='settings', facility='', data=data)
        return JsonResponse({'ok': True, 'default_facility': slug})


class WriteModeSettingView(LoginRequiredMixin, View):
    """POST the install-wide `write_mode` setting from the in-app Settings page (LOC-2).

    Write mode is the runtime, admin-controlled replacement for the old redeploy-time
    `allow_location_create` `PLUGINS_CONFIG` flag. Since SET-5 it is a **pure master gate**: it says
    whether this install may write to NetBox core at all, and each write add-on carries its own switch
    on top (`inline_room_creation`, `ap_tool`). Stored as the `write_mode` boolean in the single
    install-wide (`facility=''`, MULTI-1) `settings` blob beside `default_facility`/
    `floor_label_field`/`room_embed_*`, merged through the shared snapshot-before-overwrite upsert so
    those sibling keys survive and the AUDIT-1 change-log entry carries the before/after diff (mirrors
    `DefaultFacilitySettingView`; see `_save_blob`). It carries no `?facility=` — the setting is
    install-wide, living only in the default-facility settings row.

    Turning it **off leaves every add-on's stored value untouched** — they simply go inert behind the
    closed gate, and come back as they were when it reopens. That's why this endpoint never cascades
    into the add-on keys: an operator closing the gate for an afternoon shouldn't have to reconfigure
    the AP tool afterwards.

    This toggle is only an *install-wide* gate; `NbLocationCreateView` still enforces the per-user
    `dcim.add_location` object permission server-side, so flipping write mode on does not grant anyone
    the ability to create who couldn't already. Admin-tier configuration, gated inline on IMPORT_PERM
    (PERM-1), like the settings it sits beside. Read-back is through `window.MAP.writeMode` (stamped by
    `MapView` via `previews.write_mode_enabled`), so there is no GET."""

    def post(self, request):
        if not request.user.has_perm(IMPORT_PERM):
            return HttpResponseForbidden('import permission required')
        payload, error = _parse_json_body(request)
        if error:
            return error
        enabled = bool(payload.get('write_mode'))
        with transaction.atomic():
            row = FacilityMapBlob.objects.select_for_update().filter(
                kind='settings', facility='', key='').first()
            data = dict(row.data if row else {})
            data['write_mode'] = enabled
            _save_blob(row, kind='settings', facility='', data=data)
        return JsonResponse({'ok': True, 'write_mode': enabled})


class _SettingView(LoginRequiredMixin, View):
    """Shared base for the small install-wide settings endpoints — inline room creation (SET-5),
    the three access-point ones (DEV-3), and `render_hq` (READ-1).

    Each is admin-tier configuration merged into the single install-wide (`facility=''`, MULTI-1)
    `settings` blob beside `write_mode`/`default_facility`/`floor_label_field`/`facility_grouping`/
    `room_embed_*`, following `WriteModeSettingView`'s shape exactly: gated inline on `IMPORT_PERM`
    (PERM-1), no `?facility=` (the settings are install-wide, living only in the default-facility
    row), and read back through `window.MAP` (stamped by `MapView`) rather than a GET here.

    They share this base only for the parts that must not drift between them — the permission gate,
    the JSON parse, and the **merge**: each subclass returns just the keys it owns from `values()`,
    and the merge goes through the shared snapshot-before-overwrite upsert so sibling keys survive
    and the AUDIT-1 change-log entry carries the before/after diff. A subclass raises `ValueError`
    from `values()` to reject bad input as a clean 400."""

    def values(self, payload, request):
        """The `{key: value}` pairs to merge into the settings blob. Raise `ValueError` with a
        user-facing message to reject the payload with a 400."""
        raise NotImplementedError

    def post(self, request):
        if not request.user.has_perm(IMPORT_PERM):
            return HttpResponseForbidden('import permission required')
        payload, error = _parse_json_body(request)
        if error:
            return error
        try:
            values = self.values(payload, request)
        except ValueError as e:
            return JsonResponse({'ok': False, 'error': str(e)}, status=400)
        with transaction.atomic():
            row = FacilityMapBlob.objects.select_for_update().filter(
                kind='settings', facility='', key='').first()
            data = dict(row.data if row else {})
            data.update(values)
            _save_blob(row, kind='settings', facility='', data=data)
        return JsonResponse({'ok': True, **values})


class ApToolSettingView(_SettingView):
    """POST the install-wide `ap_tool` on/off setting from the in-app Settings page (DEV-3).

    The access-point tool's own feature switch, stored **separately from write mode** by design: it
    answers "is this feature in play?", where write mode answers "may this install write to NetBox at
    all?" (the same master-gate-plus-feature-switch pair `inline_room_creation` follows, SET-5).
    Creating an AP needs both gates plus `dcim.add_device`, all re-checked server-side (DEV-5) — so
    switching this on grants nobody the ability to create who couldn't already.

    The endpoint accepts a flip either way regardless of write-mode state, deliberately: it is the
    Settings *page* that keeps this in step with the gate (the row is disabled while write mode is
    off, SET-5), and the write path re-checks both switches itself. Refusing here would add a rule the
    write path doesn't need, and would strand a value an operator had already stored."""

    def values(self, payload, request):
        return {'ap_tool': bool(payload.get('ap_tool'))}


class TodosSettingView(_SettingView):
    """POST the install-wide `todos` on/off setting from the in-app Settings page (ADDON-4).

    The to-do feature's master switch, grouped with the pure first-party **non-write** add-ons: it
    gates the whole in-app to-do surface (both to-do pages, the compose icon, the `api/todos*`
    endpoints) and — unlike the `write_mode` family — writes nothing into NetBox core, so it carries
    no dependency on write mode. Read back through `window.MAP.todos` (stamped by `MapView`) rather
    than a GET, like the rest of the family; the endpoints re-check it via `TodoFeatureGateMixin`.

    A plain boolean by design (ADDON-4): a future setup-wizard add-ons page can set it exactly the
    way this endpoint does, with no to-do-specific persistence to special-case."""

    def values(self, payload, request):
        return {'todos': bool(payload.get('todos'))}


class InlineRoomCreationSettingView(_SettingView):
    """POST the install-wide `inline_room_creation` setting from the in-app Settings page (SET-5).

    The **inline room creation** write add-on's own switch: with it on (and write mode on), a user
    holding `dcim.add_location` may create a room's NetBox Location from the floor bind panel. Split
    out of `write_mode` by SET-5, which left write mode a pure master gate — before it, write-mode-on
    silently meant this feature was on too, with no way to have one without the other.

    Read-back is through `window.MAP.inlineRoomCreation` (stamped by `MapView` via
    `previews.inline_room_creation_enabled`) rather than a GET, like the rest of the family.

    Note the **absent key reads as on** (`inline_room_creation_enabled`), so an install that predates
    SET-5 keeps the create tile write mode used to give it; this endpoint only ever writes the key
    explicitly, so a stored `False` is never mistaken for "not configured"."""

    def values(self, payload, request):
        return {'inline_room_creation': bool(payload.get('inline_room_creation'))}


class RenderHqSettingView(_SettingView):
    """POST the install-wide `render_hq` on/off setting from the in-app Settings page (READ-1).

    Renders floor plans from vector sources at ~216 DPI instead of ~144, so the room names printed
    in the plan stay legible when zoomed out (worst on multi-sheet floors, where each sheet lands at
    roughly half screen size). It costs memory and time in the render subprocess, which is why it is
    opt-in and the page carries a warning — but it cannot run the host out of memory: the renderer
    derives its scale from each page's point size and clamps to `PdfFormat.MAX_IMAGE_PX`
    (`drawing_formats._render_scale`), so a huge sheet gives density back rather than growing
    unbounded.

    Takes effect on the **next import/rebuild** only — existing renders keep serving until then."""

    def values(self, payload, request):
        return {'render_hq': bool(payload.get('render_hq'))}


class ApDeviceRoleSettingView(_SettingView):
    """POST the install-wide `ap_device_role` setting from the in-app Settings page (DEV-3).

    Which `dcim.DeviceRole` new access points are created with. Stored as the role's numeric id (or
    `None` to clear it, leaving the tool unconfigured and hidden). A non-null id must resolve to a
    role the *saving operator* can see (`restrict(user, 'view')`) — a bogus or hidden id is a clean
    400 rather than a silently-stored dangling reference that would only surface much later, as a
    500 from the Device-create path."""

    def values(self, payload, request):
        raw = payload.get('ap_device_role')
        if raw in (None, ''):
            return {'ap_device_role': None}
        role = clamp_ap_device_role(raw)
        if role is None:
            raise ValueError('device role must be a numeric id')
        if not DeviceRole.objects.restrict(request.user, 'view').filter(pk=role).exists():
            raise ValueError('device role not found')
        return {'ap_device_role': role}


class ApNamingSettingView(_SettingView):
    """POST the install-wide `ap_name_template` + `ap_count_scope` settings from the in-app Settings
    page (DEV-3).

    One endpoint for both because they are one Settings *row* — a free-text template plus the count
    dropdown to its right — and a template is only meaningful alongside the counter scope that
    suffixes it. The template accepts only the `{room}`/`{role_short}` placeholders; anything else is
    a 400 from `clean_ap_name_template` (a typo'd `{rack}` must not slip through as a literal and
    quietly land in every device name). The scope is enum-clamped like the other string settings. The
    counter itself is appended by the name-suggestion logic (DEV-5), never typed into the template —
    which is why there is no `{count}` placeholder."""

    def values(self, payload, request):
        return {
            'ap_name_template': clean_ap_name_template(payload.get('ap_name_template')),
            'ap_count_scope': clamp_ap_count_scope(payload.get('ap_count_scope')),
        }


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


class NbPlacementNearbyView(LoginRequiredMixin, View):
    """Diagnostic gear counts for the room's *nearby* Locations (PLACE-2): when a room's Location
    has no directly-assigned, placeable gear, the placement panel is a dead end — the user can't
    tell whether gear is genuinely absent or just modeled one level up (the floor/building Location
    or the Site). This read-only endpoint answers "where does the gear actually live?" so the panel
    can say "N racks / M devices are assigned to <parent Location / Site> — reassign them to this
    room's Location" with a link into the matching NetBox list.

    **Diagnosis, not auto-broadening.** It only *counts*; it never widens `NbRacksView`/
    `NbDevicesView`'s exact-Location placement query. Gear on a whole-building Location does not
    belong to one room, so dropping it into a room would be wrong — the answer is for a human to
    reassign it in NetBox.

    Scopes, nearest-first: each ancestor Location (`get_ancestors`), then the Site last. Site-level
    counts exclude anything already attributed to an ancestor Location (`location__isnull=True`), so
    a rack on the floor Location is reported once, under the floor — not doubled at the Site. A scope
    with no gear is omitted, so an empty `nearby` means the room truly has nothing nearby to reassign.
    Object-permission-scoped read like its `NbRacksView`/`NbDevicesView` siblings — no write perm."""

    def get(self, request):
        loc = request.GET.get('location', '')
        if not loc:
            return JsonResponse({'nearby': []})
        room = Location.objects.restrict(request.user, 'view').filter(pk=loc).first()
        if room is None:
            return JsonResponse({'nearby': []})

        racks = Rack.objects.restrict(request.user, 'view')
        devices = Device.objects.restrict(request.user, 'view').filter(rack__isnull=True)
        rack_list = request.build_absolute_uri(reverse('dcim:rack_list'))
        device_list = request.build_absolute_uri(reverse('dcim:device_list'))

        def scope(kind, name, rack_qs, device_qs, param, obj_id):
            nr, nd = rack_qs.count(), device_qs.count()
            if not nr and not nd:
                return None
            q = '?%s=%d' % (param, obj_id)
            return {
                'kind': kind, 'name': name, 'racks': nr, 'devices': nd,
                'racks_url': rack_list + q if nr else None,
                'devices_url': device_list + q if nd else None,
            }

        nearby = []
        # Nearest ancestor first (the room's floor, then building, …); the Site is broadest, so last.
        for anc in room.get_ancestors(ascending=True).restrict(request.user, 'view'):
            s = scope('location', anc.name,
                      racks.filter(location_id=anc.pk),
                      devices.filter(location_id=anc.pk),
                      'location_id', anc.pk)
            if s:
                nearby.append(s)
        site = room.site
        if site is not None:
            s = scope('site', site.name,
                      racks.filter(site_id=site.pk, location__isnull=True),
                      devices.filter(site_id=site.pk, location__isnull=True),
                      'site_id', site.pk)
            if s:
                nearby.append(s)
        return JsonResponse({'nearby': nearby})


class NbDeviceRolesView(LoginRequiredMixin, View):
    """Free-text `dcim.DeviceRole` search, backing the Settings page's access-point role picker
    (DEV-3). An ordinary object-permission-scoped read like its `NbRacksView`/`NbDevicesView`
    siblings, capped at 200 — a plain `<select>` can't carry a role list of realistic size, so the
    picker is a searchable combobox (`Combo`) that re-queries as you type.

    Facility-agnostic: device roles are global in NetBox (they hang off no Site), and the setting
    they configure is itself install-wide — so unlike `NbSitesView` there is nothing to scope to a
    `?facility=`."""

    def get(self, request):
        q = request.GET.get('q', '')
        qs = DeviceRole.objects.restrict(request.user, 'view').all()
        if q:
            qs = qs.filter(name__icontains=q)
        return JsonResponse({'roles': [{'id': r.pk, 'name': r.name, 'slug': r.slug}
                                       for r in qs[:200]]})


class NbDeviceTypesView(LoginRequiredMixin, View):
    """Free-text `dcim.DeviceType` search, backing the AP tool's model picker (DEV-5). An ordinary
    object-permission-scoped read like its `NbDeviceRolesView`/`NbRacksView` siblings, capped at 200
    — the searchable combobox re-queries as you type, so a realistic catalogue never has to fit in
    one payload. Searches the model name and its manufacturer's, since operators think in both
    ("Meraki" as readily as "MR46").

    Facility-agnostic for the same reason as `NbDeviceRolesView`: device types are global in NetBox,
    hanging off no Site."""

    def get(self, request):
        q = request.GET.get('q', '')
        qs = DeviceType.objects.restrict(request.user, 'view').select_related('manufacturer')
        if q:
            qs = qs.filter(Q(model__icontains=q) | Q(manufacturer__name__icontains=q))
        return JsonResponse({'device_types': [
            {'id': t.pk, 'model': t.model, 'manufacturer': t.manufacturer.name} for t in qs[:200]]})


def _ap_write_gate(request):
    """The gate every AP **write-path** endpoint runs before it touches anything, returned as an
    error response (or `None` to proceed). Shared so the two endpoints can't drift apart — the
    Device-create path is the plugin's second write into `dcim` core (§10) and the suggest-name path
    is only meaningful to a caller who could use the name, so both answer to the same three gates:

      * the **access-point tool** must be switched on (DEV-3's install-wide feature switch);
      * install-wide **write mode** must be on (LOC-2) — the AP tool is orthogonal to it, so both;
      * the user must hold `dcim.add_device` (the NetBox auth backend, not a login check).

    Returns the resolved `ap_settings()` alongside, since every caller needs the role/template/scope
    it already read — one settings-blob query, not one per gate.

    Gating the *read* half this way is deliberately stricter than a plain `.restrict(user,'view')`
    listing: suggesting a name to someone who cannot create the device is pointless, it mirrors the
    frontend's own tool gating exactly (`window.MAP.apTool`/`writeMode`/`canCreateDevice`), and it
    keeps the unrestricted role read behind `{role_short}` (below) in front of callers who are
    already cleared to create APs."""
    ap = ap_settings()
    if not ap['enabled']:
        return HttpResponseForbidden('the access-point tool is not enabled'), ap
    if not write_mode_enabled():
        return HttpResponseForbidden('write mode is not enabled'), ap
    if not request.user.has_perm('dcim.add_device'):
        return HttpResponseForbidden('permission denied'), ap
    return None, ap


def _role_short(role):
    """The `{role_short}` expansion for a `dcim.DeviceRole`: its slug's word initials, uppercased —
    `access-point` → `AP`, `wireless-access-point` → `WAP`. A **single-word** slug is used whole
    (`ap` → `AP`), never initialled: an operator whose role is plain "AP" means `AP`, and `A` would
    be a baffling name for every access point in the facility."""
    words = [w for w in re.split(r'[-_\s]+', role.slug) if w]
    if len(words) == 1:
        return words[0].upper()
    return ''.join(w[0] for w in words).upper()


def _ap_count_qs(room, scope):
    """The `dcim.Device` queryset the suggested name's `-NN` counter counts, per `ap_count_scope`
    (DEV-3). `room` is the room Location:

      * `room`     — devices in this room only, so the counter restarts in each room;
      * `floor`    — the room's parent floor Location and everything under it (`get_descendants`),
        so the counter climbs across the floor's rooms;
      * `building` — the **building anchor** and everything under it, so the counter restarts in
        each building. Under Site = campus the anchor is the room's floor's parent Location (the
        building Location); for a Site-anchored install there is no building Location, so it
        degenerates to the whole `dcim.Site` — identical to the `site` scope there (MODEL-3,
        BUILDING-ANCHOR-DESIGN §4.3);
      * `site`     — the whole `dcim.Site`: one building for a Site-anchored install, the whole
        campus for a Site = campus install. Deliberately NOT facility-wide.

    Caller filters by role. `none` never reaches here (no counter at all)."""
    if scope == 'room':
        return Device.objects.filter(location=room)
    if scope == 'floor':
        floor = room.parent or room
        return Device.objects.filter(location__in=floor.get_descendants(include_self=True))
    if scope == 'building':
        # The building anchor is the floor's parent Location (Site = campus); absent it (Site
        # anchor — floors sit at the Site root), the building *is* the Site, so fall through.
        floor = room.parent or room
        building = floor.parent
        if building is not None:
            return Device.objects.filter(
                location__in=building.get_descendants(include_self=True))
    return Device.objects.filter(site=room.site)


class NbDeviceSuggestNameView(LoginRequiredMixin, View):
    """GET `api/netbox/devices/suggest-name?location=<roomLocId>[&asset_tag=<tag>]` → `{name}`: the
    name the AP tool pre-fills when an access point is dropped in a room (DEV-5).

    Server-side rather than in the browser because both halves live here anyway — the template and
    counter scope are in the settings blob, and the count is an ORM question. Expands DEV-3's
    `ap_name_template` via `previews.expand_ap_name_template` (`{room}` → the room Location's name,
    `{room_slug}` → that same Location's native `slug`, `{role_short}` → `_role_short` of the
    configured role, `{asset_tag}` → the optional param), then appends a zero-padded `-NN` unless
    `ap_count_scope` is `none`.

    `asset_tag` is a **param** rather than something derived here because it is the one placeholder
    the room can't answer: the user types it into the AP dialog *after* this endpoint has already
    been asked once, so the browser re-asks (debounced) as that field changes (DEV-6). Expanding it
    here rather than letting the browser patch it into the response is what keeps the counter and
    the probe below honest — both must run against the name that will actually be saved, not one
    with a placeholder still in it. It is a naming input only: `NbDeviceCreateView` remains the sole
    validator of the tag itself (including the blank → NULL rule).

    **The count and the free-name probe run unrestricted** (no `.restrict(user,'view')`), which is a
    deliberate exception to this module's read posture, not an oversight. A restricted count would
    silently *undercount* — skipping the devices this user can't see — and hand back a suggestion
    that then collides on save, turning a permission boundary into a mystery 400 on a name the
    server itself proposed. It leaks only an integer (how many APs exist in a scope) to a caller who
    already holds `dcim.add_device`.

    Two scopes are in play at once and they are **not** the same scope, which is the subtle part:
    the *counter* spans `ap_count_scope`, but the *free-name probe* must span the **site**, because
    that is the domain `dcim.Device`'s uniqueness constraint actually covers (`Lower(name)` + `site`,
    case-insensitively). So a `room`- or `building`-scoped counter still bumps past a clash elsewhere
    in the same Site — otherwise the suggestion 400s the moment the counter's scope is narrower
    than the constraint's. The bump also steps over gaps a deletion left behind, so a freed name
    isn't handed out only to fail some other check."""

    def get(self, request):
        gate, ap = _ap_write_gate(request)
        if gate is not None:
            return gate
        room = Location.objects.restrict(request.user, 'view').filter(
            pk=request.GET.get('location')).first()
        if room is None:
            return HttpResponseBadRequest('room Location not found')
        # Read unrestricted: the role is server-set policy, not this user's choice, so a user who
        # may add devices but not view roles still gets the configured name (see the class docstring
        # on why the tool's gate, not a role read, is the boundary here).
        role = DeviceRole.objects.filter(pk=ap['device_role']).first() if ap['device_role'] else None
        if role is None:
            return HttpResponseBadRequest('no access-point device role is configured')
        base = expand_ap_name_template(
            ap['name_template'], room.name, room.slug, _role_short(role),
            request.GET.get('asset_tag', ''))
        if ap['count_scope'] == 'none':
            return JsonResponse({'name': base})
        n = _ap_count_qs(room, ap['count_scope']).filter(role=role).count() + 1
        taken = Device.objects.filter(site=room.site)
        while taken.filter(name__iexact='%s-%02d' % (base, n)).exists():
            n += 1
        return JsonResponse({'name': '%s-%02d' % (base, n)})


class NbDeviceCreateView(LoginRequiredMixin, View):
    """POST `api/netbox/devices/create`: create an unracked `dcim.Device` — an access point — in a
    room, so a permitted user can place an AP on the floor plan without leaving the map (DEV-5).

    This is the plugin's **second** (and only other) write into `dcim` core, alongside
    `NbLocationCreateView` (LOC-1/LOC-2). Both follow one gate shape, and this one adds nothing
    weaker: the install-wide switches plus the per-user `dcim.add_device` permission (all in
    `_ap_write_gate`), then — because the model-level `has_perm` above cannot see object-level
    constraints — a **post-save** `restrict(user,'add')` re-check inside `transaction.atomic()`,
    rolled back when it fails. That re-check must run on a **saved pk**: an object-level `has_perm`
    on an unsaved instance filters on `pk=None` and always fails.

    Body is `{location, device_type, name, asset_tag}`. What the client does **not** get to send is
    as much of the contract as what it does:

      * the **role** is read from the settings blob server-side and never accepted from the body —
        the AP tool creates access points, so an operator's role choice is policy, and honouring a
        client-supplied role would let any `dcim.add_device` holder mint a device of any role
        through a tool that advertises one;
      * `rack` is always null (an AP hangs in the room, not in a rack) and `site` is taken from the
        room Location, so neither can be pointed elsewhere;
      * `status` falls to the model's own `active` default.

    An empty `asset_tag` is stored as **None**, not `''`: the column is globally unique *and*
    nullable, so a second blank-tagged device would collide with the first on `''` — a 400 that
    would look like a bug in the map rather than in the payload. A duplicate name or asset tag
    otherwise surfaces as a clean 400 from `full_clean()`, mirroring `NbLocationCreateView`."""

    def post(self, request):
        gate, ap = _ap_write_gate(request)
        if gate is not None:
            return gate
        payload, error = _parse_json_body(request)
        if error:
            return error
        # Unconfigured (or since-deleted) role is a 400, not a 500 on a null FK: the tool is
        # switched on but not finished being set up, which is an operator's answer to give.
        role = DeviceRole.objects.filter(pk=ap['device_role']).first() if ap['device_role'] else None
        if role is None:
            return HttpResponseBadRequest('no access-point device role is configured')
        # The room must be one the user may see; a bad/hidden id is a 400, never a silent create
        # somewhere else in the tree (mirrors NbLocationCreateView's parent resolution).
        room = Location.objects.restrict(request.user, 'view').filter(
            pk=payload.get('location')).first()
        if room is None:
            return HttpResponseBadRequest('room Location not found')
        dtype = DeviceType.objects.restrict(request.user, 'view').filter(
            pk=payload.get('device_type')).first()
        if dtype is None:
            return HttpResponseBadRequest('device type not found')
        name = (payload.get('name') or '').strip()
        if not name:
            return HttpResponseBadRequest('a device name is required')
        device = Device(name=name, device_type=dtype, role=role, site=room.site, location=room,
                        rack=None, asset_tag=(payload.get('asset_tag') or '').strip() or None)
        denied = False
        try:
            with transaction.atomic():
                device.full_clean()
                device.save()
                if not Device.objects.restrict(request.user, 'add').filter(pk=device.pk).exists():
                    denied = True
                    transaction.set_rollback(True)
        except ValidationError as e:
            return JsonResponse({'ok': False, 'error': '; '.join(e.messages)}, status=400)
        if denied:
            return HttpResponseForbidden('permission denied')
        return JsonResponse(_trim_device(device, request), status=201)


def _inv_room(loc, request):
    """Shape a room `dcim.Location` for the finder's facility-wide inventory search (NAV-3). Carries
    the room's own id/name plus its floor Location's `(site_slug, floor_slug)` — a manifest building/
    floor `(dir, fid)` — and the site/floor display names (so the finder can label a row whose floor
    isn't on the map). `parent` is the floor Location (the query filters `parent__isnull=False`).
    `url` is the room's NetBox detail page (absolute), for the search widget's NetBox-target mode
    (NAV-16); the finder uses it only in that mode and otherwise navigates the map."""
    return {
        'kind': 'room',
        'id': loc.pk,
        'name': loc.name,
        'site_slug': loc.site.slug,
        'site_name': loc.site.name,
        'floor_slug': loc.parent.slug,
        'floor_name': loc.parent.name,
        'url': request.build_absolute_uri(loc.get_absolute_url()),
    }


def _inv_placement(obj, kind, request):
    """Shape a Rack/Device for the finder inventory search (NAV-3). Navigation targets the item's
    *room's* floor: `obj.location` is the room Location, its `parent` the floor (the query filters
    `location__parent__isnull=False`, so both resolve). `room_id` is the room Location id — the key
    the frontend dedups against a placed marker (placements carry the NetBox id, see
    `Store.searchTargets`). `url` is the object's NetBox detail page (absolute), for the search
    widget's NetBox-target mode (NAV-16)."""
    loc = obj.location
    return {
        'kind': kind,
        'id': obj.pk,
        'name': obj.name or str(obj),
        'room_id': loc.pk,
        'site_slug': loc.site.slug,
        'site_name': loc.site.name,
        'floor_slug': loc.parent.slug,
        'floor_name': loc.parent.name,
        'url': request.build_absolute_uri(obj.get_absolute_url()),
    }


class NbInventoryView(LoginRequiredMixin, View):
    """Facility-wide free-text search over NetBox rooms (child Locations), racks, and devices, for
    the siteplan wayfinding finder's *unplaced* results (NAV-3). Rooms match on the Location `name`
    **or** the printed-name synonyms on the bound `Room.alias` (NAV-18); racks/devices match on name.

    The finder's placed index is built client-side from the loaded annotation/placement blobs
    (`Store.searchTargets`); this endpoint is the other half — it surfaces rooms/racks/devices that
    exist in NetBox but were never drawn/placed on the map, so the finder can jump to their building/
    floor (or, when that floor isn't mapped, list them disabled). Search-as-you-type: the frontend
    debounces per keystroke, so each query stays bounded (a `MIN_Q` minimum + a per-kind `LIMIT`)
    rather than shipping the whole facility inventory up front — a large facility's device list is
    big.

    Facility-scoped like `NbSitesView` (FACIL-1): results are restricted to the requested
    `?facility=`'s own Sites (`facilities.facility_sites`), so one facility's finder never lists
    another's inventory; a malformed slug 400s. Login-only + object-permission scoped
    (`.restrict(user,'view')`) like the sibling `/api/netbox/*` reads. Only rooms *under a floor
    Location* (and racks/devices in such a room) are returned (`parent__isnull=False`) — a floor or
    site-root Location is not itself a finder target and has no map floor to resolve. Racked devices
    are excluded (they show under their rack, mirroring `NbDevicesView`)."""

    MIN_Q = 2
    LIMIT = 50

    def get(self, request):
        facility = _facility(request)
        if facility is None:
            return HttpResponseBadRequest('invalid facility')
        q = request.GET.get('q', '').strip()
        if len(q) < self.MIN_Q:
            return JsonResponse({'rooms': [], 'racks': [], 'devices': []})
        sites = facility_sites(facility, user=request.user)
        # A room matches on its Location `name` OR the printed-name synonyms on its bound `Room.alias`
        # (NAV-18) — so a technician searching the number on the hallway sign finds a room whose
        # NetBox Location is named differently. The alias lives on our `Room`, keyed to a room
        # Location by its FK; collect the matching Locations' ids (object-perm scoped) and widen the
        # filter. `site__in=sites` still bounds the result to this facility (FACIL-1), so an alias
        # from another facility can't leak in.
        alias_loc_ids = list(Room.objects.restrict(request.user, 'view')
                             .filter(alias__icontains=q, location__isnull=False)
                             .values_list('location_id', flat=True))
        rooms = (Location.objects.restrict(request.user, 'view')
                 .filter(site__in=sites, parent__isnull=False)
                 .filter(Q(name__icontains=q) | Q(pk__in=alias_loc_ids))
                 .select_related('site', 'parent')[:self.LIMIT])
        racks = (Rack.objects.restrict(request.user, 'view')
                 .filter(location__site__in=sites, location__parent__isnull=False,
                         name__icontains=q)
                 .select_related('location__site', 'location__parent')[:self.LIMIT])
        devices = (Device.objects.restrict(request.user, 'view')
                   .filter(location__site__in=sites, location__parent__isnull=False,
                           rack__isnull=True, name__icontains=q)
                   .select_related('location__site', 'location__parent')[:self.LIMIT])
        return JsonResponse({
            'rooms': [_inv_room(x, request) for x in rooms],
            'racks': [_inv_placement(x, 'rack', request) for x in racks],
            'devices': [_inv_placement(x, 'device', request) for x in devices],
        })
