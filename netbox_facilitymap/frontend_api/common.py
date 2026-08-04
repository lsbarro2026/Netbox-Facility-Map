"""Request/response primitives shared across the `frontend_api` endpoint families.

Everything here is used by at least two of the sibling modules — the row caps the picker reads
share, the `?facility=` parse every facility-scoped endpoint runs, the JSON-body parse every
POST runs, and the per-Site room scope the annotations and to-do reads share. Anything used by
exactly one family lives in that family's module instead.

Kept free of view classes so any sibling can import it without pulling a route in.
"""

import json

from django.db.models import Q
from django.http import HttpResponseBadRequest

from ..storage import valid_facility

# Shared cap for the free-text "picker" reads (`UsersView`, `NbLocationsView`, `NbSitesView`,
# `NbBuildingLocationsView`, `NbDeviceRolesView`, `NbDeviceTypesView`) — each backs a searchable
# combobox that re-queries as you type, so a plain `<select>`-sized payload is all any single
# response ever needs.
NB_LIST_CAP = 200

# The cap for the *other* read shape: one shot, matched against **as a whole** rather than typed
# into (IMPORT-18). The import wizard's split step fetches the facility's buildings once and scores
# every drawing filename against that list client-side (`ImportMatch`), so a building past the cap
# can never be proposed — and a campus can hold far more than 200. Only `NbSitesView` and
# `NbBuildingLocationsView` offer it, and only when the caller asks (`?full=1`): the per-keystroke
# comboboxes those same endpoints back — and every other picker read — keep `NB_LIST_CAP`, where a
# `<select>`-sized page is the point. Still a cap, not "everything": the payload stays bounded and
# `truncated` still tells the truth past it, so the frontend's partial-list fallback is unchanged.
NB_MATCH_CAP = 2000


def _capped(qs, cap):
    """Apply `cap` to `qs`, returning `(rows, truncated)` (TOPO-5). Callers pass `_list_cap(request)`.

    Autocomplete callers never needed to know the cap had bitten — you type more and the list
    narrows. The import wizard's split step does: it pre-fetches the building list **once** and
    matches drawing filenames against it client-side, and a silently clipped list would look
    complete while quietly failing to match anything past the cap. So the flag is reported, and
    the frontend says so rather than pretending. That reporting is **cap-independent** — raising a
    caller's ceiling to `NB_MATCH_CAP` moves the number, never the contract.

    Read by fetching one row **past** the cap rather than by a second `COUNT` query, so telling
    the truth costs the per-keystroke search path nothing."""
    rows = list(qs[:cap + 1])
    return rows[:cap], len(rows) > cap


def _list_cap(request):
    """The row cap one picker read should use: `NB_MATCH_CAP` when the caller asked for the
    match-the-whole-list shape (`?full=1`), else `NB_LIST_CAP` (IMPORT-18). Opt-in, so a
    per-keystroke search never pays for the wizard's one-shot read."""
    return NB_MATCH_CAP if request.GET.get('full') == '1' else NB_LIST_CAP


def _facility(request):
    """The validated `?facility=` slug for a request (default '' = the default facility), or `None`
    when the slug is malformed so the caller can 400. A facility namespaces the editor blob rows
    (MULTI-2); every blob read/write scopes `.filter(facility=…)`."""
    try:
        return valid_facility(request.GET.get('facility') or '')
    except ValueError:
        return None


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


def _scope_rooms(rooms, viewable):
    """Narrow a `Room` queryset to rooms on floors whose Site the viewer may see.

    Deliberately **stricter** than `facilities.facility_floor_scope`, which *unions* the
    `floor_location` FK with the `floor_key` slug prefix to widen a facility's match (BIND-1). A
    union is wrong for a security boundary: a room whose FK names a hidden Site would be let
    through by a stale key prefix naming a viewable one. So the FK, when set, is **authoritative**
    and the key prefix is only the fallback for rooms that have none — rename-proof and
    fail-closed at once.

    Shared by the annotations read (`compose_annotations`) and the facility-wide to-do rollup
    (`FacilityTodosView`), which must withhold exactly the same rooms — a rollup that revealed
    what the per-floor read hides would be the leak this exists to close."""
    if viewable is None:
        return rooms
    if not viewable:
        return rooms.none()
    by_key = Q()
    for slug in viewable:
        by_key |= Q(floor_key__startswith='%s/' % slug)
    return rooms.filter(Q(floor_location__site__slug__in=viewable)
                        | (Q(floor_location__isnull=True) & by_key))
