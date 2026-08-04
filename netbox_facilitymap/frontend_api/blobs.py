"""Editor document persistence — `siteplan` / `placements` / `layouts` — and the concurrency
machinery every blob write shares.

Two layers live here. The lower one is the persistence + versioning cluster (`_save_blob`,
`merge_settings`, the token helpers, the conflict checks): stateless functions over a
`FacilityMapBlob` row, shared by `BlobView` below, by `annotations.py` (a blob kind whose
rooms happen to live in a table), and by `settings_views.py`. They are grouped here rather
than promoted to a `BlobStore` class deliberately — none of them carries state between calls,
so a class would be a bag of static methods, and consistency with the surrounding
module-function style outranks the nominally tidier shape.

The upper layer is `BlobView` itself plus the per-Site read scoping of the siteplan document
(SEC-2). The geometry half of `scope_reads_to_sites` lives here; the pixels/manifest half is
in `serving.py`.
"""

import json

from django.db import transaction
from django.http import HttpResponseBadRequest, HttpResponseForbidden, JsonResponse
from django.views import View

from dcim.models import Device, Rack

from ..access import EDIT_PERM, MapReadAccessMixin, scope_floor_keys, viewable_site_slugs
from ..models import FacilityMapBlob
from .common import _facility, _parse_json_body
from .serializers import abs_url

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


def merge_settings(values):
    """Merge `values` into the single install-wide `settings` blob and return the saved row.

    The **one** settings write path — every settings surface goes through it: the chrome'd
    `views.SettingsView` (the room-embed controls), `NbFacilitiesView.post` (`facility_grouping`),
    and every `_SettingView` subclass. Each caller passes only the keys it owns and this merges
    them onto a freshly-read document, so sibling keys always survive; the row is addressed by its
    full install-wide key (`facility=''`, `key=''`, MULTI-1), never a loose match.

    The read-modify-write runs under `select_for_update()` inside a transaction, which is the point
    of having one helper: settings writes arrive from several unrelated surfaces at once, and a bare
    read-then-write would let two of them interleave and drop one side's keys. Persistence via
    `_save_blob`, so the AUDIT-1 snapshot-before-overwrite (before/after diff, no-op suppression)
    holds for every settings write.

    Deliberately carries **no** permission check, exactly like `_save_blob`: it is a persistence
    helper, and every caller gates on `IMPORT_PERM` before reaching it (PERM-1)."""
    with transaction.atomic():
        row = FacilityMapBlob.objects.select_for_update().filter(
            kind='settings', facility='', key='').first()
        data = dict(row.data if row else {})
        data.update(values)
        return _save_blob(row, kind='settings', facility='', data=data)


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
            placements.append({**p, 'url': abs_url(obj, request)} if obj else p)
        out[fkey] = {**doc, 'placements': placements}
    return out


# --- per-Site read scoping of the blob geometry (SEC-2) ----------------------------
# The pixels/manifest half of `scope_reads_to_sites` lives in `serving.py`; this is the geometry
# half. The per-floor sharded kinds (`annotations`/`placements`/`layouts`) scope by dropping whole
# rows — a shard key *is* a `floor_key`, whose first segment is its Site slug (`scope_floor_keys`),
# so it costs no query beyond the one viewable-set lookup. `siteplan` is one facility-wide row, so
# it is filtered *within* its JSON instead — and because the editor round-trips that document whole
# (`Store.saveSiteplan` POSTs every hotspot, unlike the sharded saves which send only touched
# floors), the hidden hotspots are merged back in on write so a scoped editor's save can never
# delete what they were never shown. Every helper here is a no-op when `viewable is None`
# (scoping off), so the default read path is byte-identical and query-identical.
# (The `Room`-queryset half of this scoping is `common._scope_rooms`, shared with the to-do reads.)

def _hotspot_site(hotspot):
    """The Site slug a siteplan hotspot sits on: the first segment of its `dir`, which is
    `"<siteSlug>"` or `"<siteSlug>/<buildingSlug>"` (the manifest building key). `None` for a
    free-drawn hotspot bound to no building — not attributable to a Site, so scoping drops it."""
    d = hotspot.get('dir') if isinstance(hotspot, dict) else None
    return d.split('/')[0] if d else None


def _scope_siteplan(data, viewable):
    """A copy of the siteplan document whose `hotspots` are filtered to the viewer's Sites.
    **Fail-closed**: a hotspot whose slug matches no viewable Site — including an unbound one — is
    dropped, so a hidden building leaks neither its outline nor its name. Copies rather than
    mutating, since `data` is the stored row's JSON."""
    if viewable is None:
        return data
    hotspots = [h for h in ((data or {}).get('hotspots') or []) if _hotspot_site(h) in viewable]
    return {**(data or {}), 'hotspots': hotspots}


def _merge_hidden_hotspots(stored, incoming, viewable):
    """The siteplan document to persist for a scoped editor: the hotspots they could **not** see,
    re-injected ahead of the ones they posted.

    Without this, read scoping would silently destroy data — the editor GETs a filtered document
    and POSTs the whole array back, so every hidden Site's hotspot would vanish on the next save.
    The hidden ones lead so their relative order is stable across repeated saves (an unchanged
    document must still diff as a no-op, AUDIT-1). A viewer of every Site merges nothing."""
    if viewable is None:
        return incoming
    hidden = [h for h in ((stored or {}).get('hotspots') or []) if _hotspot_site(h) not in viewable]
    return {**incoming, 'hotspots': hidden + list(incoming.get('hotspots') or [])}


class BlobView(MapReadAccessMixin, View):
    """GET the stored document for one `kind` (or its default); POST upserts it.

    `siteplan` is one facility-wide row (`sharded=False`). `placements`/`layouts` are **per-floor
    sharded** (`sharded=True`, CONC-1): stored one row per floor (`key=floor_key`), so a POST
    carrying only the floors an editor touched conflict-checks + writes just those — different-floor
    saves never collide. The sharded GET composes every floor row back into the whole-document shape
    the frontend round-trips, and the version header carries a per-floor token *map*.

    GET rides the shared map-read gate; POST additionally requires `EDIT_PERM` below (a viewer
    reads but cannot write). Under `scope_reads_to_sites` (SEC-2) GET is additionally filtered to
    the viewer's Sites — sharded kinds by dropping floors, `siteplan` within its JSON — and the
    `siteplan` POST re-merges what the read withheld so the round-trip stays lossless."""
    kind = None
    sharded = False

    def get(self, request):
        facility = _facility(request)
        if facility is None:
            return HttpResponseBadRequest('invalid facility')
        # Per-Site read scoping (SEC-2): one lookup, reused for both branches below.
        viewable = viewable_site_slugs(request.user, facility)
        if self.sharded:
            rows = {r.key: r for r in FacilityMapBlob.objects.filter(
                kind=self.kind, facility=facility).exclude(key='')}
            # A hidden Site's floors drop out whole — shard key == floor_key, so no extra query.
            # The version-token map is built from the filtered rows, so a scoped client is never
            # handed a token for a floor it can't see.
            rows = {k: rows[k] for k in scope_floor_keys(rows, viewable)}
            docs = {key: row.data for key, row in rows.items()}
            # Placed racks/devices are pure blob, so surface each one's NetBox URL server-side for
            # the search widget's NetBox-target mode (NAV-16) rather than reconstructing it in JS.
            if self.kind == 'placements':
                docs = _placements_with_urls(docs, request)
            resp = JsonResponse(docs, safe=False)
            resp[VERSION_HEADER] = json.dumps(_shard_versions(rows))
            return resp
        row = FacilityMapBlob.objects.filter(kind=self.kind, facility=facility, key='').first()
        data = row.data if row else BLOB_DEFAULTS[self.kind]()
        if self.kind == 'siteplan':
            # The one facility-wide row: filtered within its JSON rather than dropped (SEC-2). The
            # token still describes the whole row, so a save round-trips normally — `post` re-merges
            # the hotspots this response withheld.
            data = _scope_siteplan(data, viewable)
        resp = JsonResponse(data, safe=False)
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
            if self.kind == 'siteplan':
                # Re-inject the hotspots read scoping withheld from this caller (SEC-2), inside the
                # same transaction as the `select_for_update()`d read so nothing can slip in between
                # the merge and the write.
                data = _merge_hidden_hotspots(row.data if row else None, data,
                                              viewable_site_slugs(request.user, facility))
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
