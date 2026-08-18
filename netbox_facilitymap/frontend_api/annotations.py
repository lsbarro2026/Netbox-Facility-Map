"""The annotations document — the one blob kind whose rooms live in a relational table.

GET composes the whole-document shape (per-floor blob rows + `Room` rows merged back in);
POST decomposes it (rooms → `Room` rows, the rest → the `annotations` blob). The frontend
round-trips it byte-for-byte and is unchanged.

Most of this module is **not** the view: `sync_rooms`, `resolve_floor_location`,
`_split_annotations`, `compose_annotations` and `touch_floor_version` are the `Room`
persistence engine, shared with the REST write path (`api/serializers.py`, `api/views.py`),
the backup restore (`backup.py`) and the `facilitymap_import` command. `sync_rooms` is
authoritative for room geometry, so its deletes are the most safety-critical code in the
package — see the delete-scoping rules in its docstring before touching them.
"""

import json

from django.db import transaction
from django.http import HttpResponseBadRequest, HttpResponseForbidden, JsonResponse
from django.views import View

from dcim.models import Location

from ..access import EDIT_PERM, MapReadAccessMixin, scope_floor_keys, viewable_site_slugs
from ..facilities import facility_floor_scope, facility_for_floor_key
from ..models import FacilityMapBlob, Room, parse_floor_key
from .blobs import (
    VERSION_HEADER, _conflict_response, _delete_blob_shard, _save_blob, _sent_shard_versions,
    _shard_conflicts, _shard_versions,
)
from .common import _facility, _parse_json_body, _scope_rooms
from .serializers import _serialize_room


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


def compose_annotations(blob_data, user, request, facility='', viewable=None):
    """Rebuild the whole-document annotations shape: blob floors with their `Room` rows
    (visible to `user`) merged back in under each floor's `rooms`.

    `viewable` is the per-Site read scope (SEC-2) — `None` (the default, and always so for the
    trusted command paths) leaves the rooms scoped only by `restrict(user, 'view')` as before; a set
    additionally narrows them to floors on Sites the viewer may see, matching the caller's own
    filtering of the blob floors so the composed document is consistently scoped.

    `Room` has no facility column (`floor_key` embeds the globally-unique site slug), so the rows
    are scoped to the requested facility by their floor's site: only rooms whose `floor_key`
    site-prefix belongs to `facility` are surfaced, so a facility-B GET never lists facility-A's
    rooms. The default facility '' resolves to every ungrouped site (all sites on a single-facility
    install), preserving today's whole-document shape."""
    doc = {fkey: dict(floor) for fkey, floor in (blob_data or {}).items()}
    # Ordered by the explicit stacking order (ROOM-4), NOT the alphabetical `Room.Meta.ordering`
    # this queryset would otherwise inherit: the frontend paints and hit-tests each floor's rooms in
    # the order this list arrives in, so the composed array order *is* the z-order the user chose.
    # `room_id` breaks ties deterministically — rooms sharing a `z_order` are only ever rows a REST
    # client created (they keep the `0` default until the next editor save re-indexes the floor).
    rooms = (Room.objects.restrict(user, 'view').select_related('location')
             .order_by('z_order', 'room_id'))
    # The facility→site-slug mapping bounds which floors belong to the facility; it is not itself
    # permission-sensitive (the rooms stay `.restrict(user,'view')`), so resolve it unscoped so an
    # editor lacking Site-view permission still sees their facility's rooms.
    scope = facility_floor_scope(facility)
    rooms = rooms.filter(scope) if scope is not None else rooms.none()
    rooms = _scope_rooms(rooms, viewable)
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


def resolve_floor_location(floor_key):
    """The floor `dcim.Location` a `floor_key` names, or `None` when it can't be resolved today — an
    empty/malformed key, a floor-type floor whose slug has no Location, or a slug that has since
    drifted (renamed). Handles both building-anchor shapes (`parse_floor_key`): a 2-segment
    Site-anchored key resolves the floor by `(site slug, floor slug)`; a 3-segment Location-anchored
    key additionally scopes it **under the building Location** (`parent__slug`), since two buildings
    under one campus can legitimately have floors with the same slug (e.g. both `level-1`). Mirrors
    how `NbRoomsView`/`health` resolve a floor key by its slugs. Used to (re)establish
    `Room.floor_location`, the BIND-1 rename-proof anchor, on save — by `sync_rooms` for an editor
    save, and by `api.serializers.RoomSerializer` for a REST write, so both paths derive the floor
    binding the same way (API-1)."""
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

    A posted floor is authoritative for its **stacking order** too (ROOM-4): each room's `z_order` is
    rewritten from its array position in the posted list, so the order the editor sends is the order
    `compose_annotations` reads back. That makes the posted array the one representation of z-order —
    the wire room object carries no `z` key of its own — and it re-densifies the column on every save,
    so a REST-created row's `0` default is absorbed rather than colliding forever.

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
        floor_loc = resolve_floor_location(fkey)
        floor_defaults = {'floor_location': floor_loc} if floor_loc is not None else {}
        seen = []
        # `z` counts only the rooms actually written, so the stored order stays dense (0..n-1) even
        # when the posted list carries an id-less entry the loop skips.
        z = 0
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
                    # The posted list's **array position** is the room's stacking order (ROOM-4) —
                    # the frontend paints its `rooms` array in order and carries no separate `z`
                    # key, so there is one representation and it cannot disagree with itself.
                    'z_order': z,
                    'location_id': loc_id,
                    **floor_defaults,
                })
            z += 1
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


def touch_floor_version(floor_key):
    """Bump the CONC-1 concurrency token of one floor, so an editor holding a document loaded
    *before* this call can no longer save over it (API-1).

    The editor's Save is the authoritative snapshot of a floor and sweeps rooms absent from it — a
    correct rule, but one that silently destroyed a room the REST API created after the editor's
    document was fetched, because a `Room` write touches no blob row and so left the floor's token
    unchanged. The token is that floor's `annotations` shard row's `updated`; bumping it here turns
    that silent loss into the ordinary 409 the client already handles ("reload and re-apply"), and
    the reloaded document *contains* the REST room (`compose_annotations` serves `Room` rows
    whether or not the editor drew them), so the next Save preserves it. The sweep itself is
    untouched: a room the user genuinely deletes on the canvas is still absent from the reloaded
    document and still swept.

    The row is **created** (empty) when the floor has none, so a room-only floor gets a real token
    instead of the `''` that reads as "first write, nothing to conflict with" — otherwise exactly
    the floors most likely to be REST-authored would keep the hole. An empty shard is the shape a
    room-only floor already composes to, and the next editor Save either fills it or prunes it.

    An **existing** shard is addressed by its key alone, across facilities: a `floor_key` starts
    with the globally-unique Site slug, so it identifies one floor install-wide, and matching on it
    keeps the bump working even for a row whose facility no longer resolves (an orphaned or
    mid-reassignment facility). Only *creating* a shard needs a facility, resolved from the key
    itself (`facility_for_floor_key` — the Site's facility, or under the `location` grouping the
    key's anchor-Location root) — falling back to the default `''` when nothing resolves, since a
    key naming no live Site belongs to no grouping either. A malformed key with no site segment is
    a no-op. Callers are the REST write paths only: `sync_rooms` must never call this, since
    bumping a token mid-save would conflict with the very request performing it."""
    site_slug = parse_floor_key(floor_key)[0]
    if not site_slug:
        return
    with transaction.atomic():
        rows = list(FacilityMapBlob.objects.select_for_update().filter(
            kind='annotations', key=floor_key))
        if not rows:
            FacilityMapBlob.objects.create(
                kind='annotations', facility=facility_for_floor_key(floor_key), key=floor_key,
                data={})
            return
        for row in rows:
            # `auto_now` on `updated` is what moves the token; the document is unchanged, so the
            # AUDIT-1 snapshot diff suppresses this as a no-op change-log entry (`serialize_object`
            # excludes `updated` precisely so a bumped timestamp alone doesn't read as a change).
            row.snapshot()
            row.save()


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

    GET rides the shared map-read gate; POST additionally requires `EDIT_PERM`. Under
    `scope_reads_to_sites` (SEC-2) GET additionally withholds the floors — and the rooms — of Sites
    the viewer may not see. POST needs no such merge: the editor sends only the floors it touched,
    so a withheld floor is never round-tripped (unlike the whole-document `siteplan`)."""

    def get(self, request):
        facility = _facility(request)
        if facility is None:
            return HttpResponseBadRequest('invalid facility')
        rows = {r.key: r for r in FacilityMapBlob.objects.filter(
            kind='annotations', facility=facility).exclude(key='')}
        # Per-Site read scoping (SEC-2): drop a hidden Site's floors before composing, and pass the
        # same set down so its rooms are withheld too — otherwise a room-only floor (no blob row)
        # would reintroduce the floor the filter above just removed.
        viewable = viewable_site_slugs(request.user, facility)
        rows = {k: rows[k] for k in scope_floor_keys(rows, viewable)}
        blob_data = {key: row.data for key, row in rows.items()}
        doc = compose_annotations(blob_data, request.user, request, facility, viewable)
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
