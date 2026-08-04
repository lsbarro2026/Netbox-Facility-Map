"""Facility identity management — the picker feed, the Site→facility assignment map, and the
grouping-change preview/recovery pair.

The four endpoints here answer "which facility does this data belong to", which is the axis
every other endpoint scopes by (MULTI-2). Only the facilities GET and the assignments GET are
login-only; everything that *changes* the answer — the grouping POST, the assignment merge, the
preview it fronts, and the re-key that repairs what it strands — is `IMPORT_PERM`, one tier above
the ordinary map write, because a wrong answer here strands a whole facility's map data (HEALTH-1).
"""

from django.contrib.auth.mixins import LoginRequiredMixin
from django.http import HttpResponseBadRequest, HttpResponseForbidden, JsonResponse
from django.views import View

from ..access import IMPORT_PERM
from ..facilities import (
    EDITOR_KINDS, GROUPING_CHOICES, assign_facilities, facility_map, grouping,
    grouping_change_preview, list_facilities, reassign_facility,
)
from ..models import FacilityMapBlob
from .blobs import merge_settings
from .common import _parse_json_body


class NbFacilitiesView(LoginRequiredMixin, View):
    """Enumerate the facilities the SPA picker offers (MULTI-2).

    A facility = a `dcim.SiteGroup`/`Region` slug — or, under the `location` grouping, a top-level
    `dcim.Location` slug (MODEL-8) — per the install-wide grouping setting; the default facility is
    ''. Returns every grouping object the user may view — each flagged whether it already has an
    imported map — plus the default facility when it has content, so an empty one can be picked to
    import a *new* facility. Login-only (the objects are ordinary NetBox organizational data,
    already object-permission scoped in `facilities.list_facilities`).

    POST sets the install-wide `facility_grouping` (`'sitegroup'|'region'|'location'`) the picker resolves
    against (MULTI-3) — since FACILITY-IDENTITY Phase 1 the **seed default** for Sites without an
    explicit assignment (`NbFacilityAssignmentsView`), no longer authoritative for assigned Sites.
    The 409 `confirm_required` gate below survived Phase 3 (MULTI-7) as a **non-UI interlock**: the
    browser now never trips it, because the wizard shows `NbFacilityGroupingPreviewView`'s concrete
    before/after modal first and only then POSTs `confirm`, but an unattended API client still
    can't re-scope a populated install in one unacknowledged call. It's
    admin-tier configuration, so — unlike the login-only GET —
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
        # which facility an *unassigned* Site resolves to, so an install that already holds map data
        # can have its blobs stranded under the old key. Refuse a *change* on a populated install
        # unless the caller explicitly confirms. First-time setup (no editor content) and a no-op
        # re-save are unaffected. The browser path sends `confirm: true` only after the wizard's
        # preview modal has shown exactly what moves (`NbFacilityGroupingPreviewView`) and offered
        # inline reassignment, so this branch is now purely the guard for a *non-browser* caller —
        # which is told where the preview lives rather than being handed a blanket warning.
        if chosen != grouping() and not payload.get('confirm') \
                and FacilityMapBlob.objects.filter(kind__in=EDITOR_KINDS).exists():
            return JsonResponse(
                {'ok': False, 'error': 'confirm_required',
                 'detail': 'Changing the facility grouping re-scopes the map data of Sites with no '
                           'explicit facility assignment. GET api/netbox/facility-grouping-preview'
                           '?grouping=%s for exactly what would move, then repeat this call with '
                           '"confirm": true.' % chosen},
                status=409)
        # Merge onto the existing settings document so the room-embed controls survive (see
        # `merge_settings`). This view keeps its own `post` rather than subclassing `_SettingView`
        # because of the confirm pre-check above and the GET it shares the route with.
        merge_settings({'facility_grouping': chosen})
        return JsonResponse({'ok': True, 'grouping': chosen})


class NbFacilityAssignmentsView(LoginRequiredMixin, View):
    """Read/write the explicit Site→facility assignment map (FACILITY-IDENTITY Phase 1).

    GET returns `{'assignments': {site_slug: facility_slug}}` — the plugin-owned map
    `facility_for_site` consults before the SiteGroup/Region derivation. Login-only, like the
    facilities GET beside it (slugs of ordinary organizational objects).

    POST merges `{'assignments': {site_slug: facility_slug | null}}` via
    `facilities.assign_facilities` (`null` reverts a Site to the derivation). Admin-tier
    configuration like the grouping POST, so it's gated inline on `IMPORT_PERM`; validation —
    strict slugs via `storage.valid_facility`, live-Site keys — lives in `assign_facilities`, the
    one write path.

    The UI is the import wizard's bind step (Phase 2, MULTI-6): `ImportFlow._facilityRow` reads the
    map over the GET to render each bound Site's state, and its confirm/revert control POSTs a
    single entry here. The suggestion it confirms is the *active* facility — sound because the bind
    search is already facility-scoped (FACIL-1), so an offered Site either is assigned to it or
    derives to it."""

    def get(self, request):
        return JsonResponse({'assignments': facility_map()})

    def post(self, request):
        if not request.user.has_perm(IMPORT_PERM):
            return HttpResponseForbidden('import permission required')
        payload, error = _parse_json_body(request)
        if error:
            return error
        try:
            saved = assign_facilities(payload.get('assignments'))
        except ValueError as exc:
            return HttpResponseBadRequest(str(exc))
        return JsonResponse({'ok': True, 'assignments': saved})


class NbFacilityGroupingPreviewView(LoginRequiredMixin, View):
    """What a pending `facility_grouping` change would actually move (FACILITY-IDENTITY Phase 3,
    MULTI-7) — `facilities.grouping_change_preview(?grouping=<sitegroup|region>)` verbatim.

    This is what retired the wizard's `window.confirm`: instead of "your data may disappear", the
    modal it feeds names each Site whose facility would change (with its floor/room counts, before →
    after), the facility keys that would be left holding stranded data, and the targets an inline
    reassignment may move them to. **Read-only** — previewing a change the operator then cancels
    writes nothing.

    Gated on `IMPORT_PERM` despite being a read, unlike the login-only facilities/assignments GETs
    beside it: it exists only to front an admin-tier action (and enumerates install-wide data
    topology), so its audience is exactly the grouping POST's. That gate is also what lets the
    preview itself stay object-permission **unscoped** — a diff narrowed to the Sites this operator
    may view would understate what the change moves, which is the one thing this screen must not
    do (see `grouping_change_preview`)."""

    def get(self, request):
        if not request.user.has_perm(IMPORT_PERM):
            return HttpResponseForbidden('import permission required')
        try:
            return JsonResponse(grouping_change_preview(request.GET.get('grouping', '')))
        except ValueError as exc:
            return HttpResponseBadRequest(str(exc))


class NbFacilityReassignView(LoginRequiredMixin, View):
    """Re-key one facility's stranded map data to a live facility — the SPA half of the HEALTH-1
    recovery (`facilities.reassign_facility`: blobs re-keyed under the collision guard, rendered
    artifacts moved by `storage.move_facility`).

    POST `{'old': <slug>, 'new': <slug>}` → `{'ok': True, 'kinds': [...]}`, or 400 with the
    validation message (unreachable target, no data under the source, a collision that would
    overwrite the target's data or images). `IMPORT_PERM`, the same gate the server-rendered
    equivalent carries.

    It does **not** replace `views.SettingsView._reassign`: that panel stays the recovery surface for
    drift discovered outside the wizard (it's where the HEALTH-6 viewer banner points). This endpoint
    exists so the Phase-3 modal can offer the same fix *inline*, in the same breath as the grouping
    change that stranded the data — one write path, two entry points."""

    def post(self, request):
        if not request.user.has_perm(IMPORT_PERM):
            return HttpResponseForbidden('import permission required')
        payload, error = _parse_json_body(request)
        if error:
            return error
        try:
            kinds = reassign_facility(payload.get('old', ''), payload.get('new', ''))
        except ValueError as exc:
            return HttpResponseBadRequest(str(exc))
        return JsonResponse({'ok': True, 'kinds': kinds})
