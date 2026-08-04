"""REST API views for `Room`, plus the two read-only facility endpoints a headless client needs.

`NetBoxModelViewSet` gives `Room` the full CRUD surface plus NetBox's object-permission
restriction, brief mode, and change logging for free. The same `RoomFilterSet` backs both this
viewset and the UI list view, so REST `?site_id=`/`?floor_key=`/`?location_id=` filtering matches
the UI filters.

Two things this viewset adds on top of the stock behaviour, both documented in `serializers.py`:
the floor binding is **derived** from `floor_key` on every write (in the serializer), and every
write **bumps the room's floor concurrency token** (below), so the map editor's authoritative Save
can no longer silently sweep a room this API just created.

`ManifestView` and `PlacementsView` are the read-only counterparts (API-1). They exist because the
page-mount views serving the same data (`serving.ManifestView`, `frontend_api.BlobView`) are plain
Django views behind a session login — reachable from the browser, not from a script holding a
NetBox API token. These are DRF views under the same `plugins-api` mount as `rooms/`, so token auth
applies, and they honour **exactly** the same gates as their page-mount twins: the optional flat
map-read permission (`access.may_view_map`) and the optional per-Site read scoping (SEC-1/SEC-2,
via `access.scope_manifest` / `access.scope_floor_keys`). A tokened read must never become a way
around scoping.
"""

from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import permissions
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from netbox.api.viewsets import NetBoxModelViewSet

from ..access import may_view_map, scope_floor_keys, scope_manifest, viewable_site_slugs
from ..filtersets import RoomFilterSet
from ..frontend_api import touch_floor_version
from ..models import FacilityMapBlob, Room
from ..storage import EMPTY_MANIFEST, read_manifest, valid_facility
from .serializers import RoomSerializer


class RoomViewSet(NetBoxModelViewSet):
    queryset = Room.objects.select_related('location', 'floor_location').prefetch_related('tags')
    serializer_class = RoomSerializer
    filterset_class = RoomFilterSet

    # Every mutation bumps the CONC-1 token of the floor(s) it touched, so an editor holding an
    # older document is told to reload (409) rather than saving over this write. NetBox's bulk
    # update/destroy route through `perform_update`/`perform_destroy` once per object, so the bulk
    # endpoints are covered by the same hooks; a bulk *create* hands `perform_create` a list
    # serializer instead, hence `_instances` normalising `serializer.instance`.

    def perform_create(self, serializer):
        super().perform_create(serializer)
        self._touch_saved(serializer)

    def perform_update(self, serializer):
        # A room can be *moved* between floors, which invalidates both floors' documents: the old
        # one still shows it, the new one doesn't. Read the pre-save keys before saving.
        previous = {room.floor_key for room in self._instances(serializer.instance)}
        super().perform_update(serializer)
        self._touch_saved(serializer, previous)

    def perform_destroy(self, instance):
        floor_key = instance.floor_key
        super().perform_destroy(instance)
        touch_floor_version(floor_key)

    @staticmethod
    def _instances(instance):
        """`serializer.instance` as a list — one object for the ordinary endpoints, a list for the
        bulk ones, nothing at all before a create has saved."""
        if instance is None:
            return []
        return list(instance) if isinstance(instance, (list, tuple)) else [instance]

    def _touch_saved(self, serializer, extra_keys=frozenset()):
        keys = {room.floor_key for room in self._instances(serializer.instance)}
        for floor_key in keys | set(extra_keys):
            touch_floor_version(floor_key)


#: The `?facility=` query parameter, declared for the OpenAPI schema. Both endpoints take it.
FACILITY_PARAM = OpenApiParameter(
    'facility', OpenApiTypes.STR, OpenApiParameter.QUERY, required=False,
    description='Facility (grouping) slug; omit for the default facility.')


class _FacilityReadView(APIView):
    """Shared plumbing for the read-only facility endpoints: the map-read gate and the validated
    `?facility=` slug.

    Each `get` carries an explicit `@extend_schema`: these return whole JSON documents rather than
    serialized model rows, so drf-spectacular has no serializer to introspect and would otherwise
    **drop the endpoint from NetBox's OpenAPI schema entirely** — undocumenting the very surface
    these exist to provide.

    The gate is `access.may_view_map`, the same function the page-mount views' `MapReadAccessMixin`
    calls — login-only by default, `view_facilitymapblob` (or change/import) once the operator turns
    on `require_view_permission`. Deliberately *not* a `Room` object permission: this is map data,
    not room rows, and holding `view_room` says nothing about being allowed to see floor plans."""

    permission_classes = [permissions.IsAuthenticated]

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        if not may_view_map(request.user):
            self.permission_denied(request, message='permission denied')

    def facility(self, request):
        """The validated facility slug, or a 400 via DRF's `ValidationError` on a bad one — the
        REST-shaped equivalent of the page views' `HttpResponseBadRequest('invalid facility')`."""
        try:
            return valid_facility(request.query_params.get('facility') or '')
        except ValueError:
            raise ValidationError({'facility': 'invalid facility'})


class ManifestView(_FacilityReadView):
    """`GET /api/plugins/facilitymap/manifest/` — the rendered facility manifest (buildings →
    floors → sheets), the map's index of what exists and where its images live.

    Serves the empty stub before any facility is imported, and for an unreadable/corrupt manifest,
    matching `serving.ManifestView`: a truncated manifest is indistinguishable from a fresh install
    (§10), so both collapse to the same answer. Per-Site scoping drops whole buildings, fail-closed.
    No conditional-response machinery here — that exists on the page-mount view to keep a *browser*
    revalidating cheaply, and a scripted poller is better served by a plain 200."""

    @extend_schema(parameters=[FACILITY_PARAM], responses={200: OpenApiTypes.OBJECT})
    def get(self, request):
        facility = self.facility(request)
        data = read_manifest(facility)
        if data is None:
            return Response(EMPTY_MANIFEST)
        viewable = viewable_site_slugs(request.user, facility)
        # The memo's dict is shared and read-only; `scope_manifest` copies.
        return Response(scope_manifest(data, viewable) if viewable is not None else data)


class PlacementsView(_FacilityReadView):
    """`GET /api/plugins/facilitymap/placements/` — the rack/device placements document keyed by
    `floor_key`, exactly as the editor stores it (one per-floor shard row per floor, CONC-1).

    Read-only on purpose: placements are editor-owned blob state with no relational model behind
    them, so a write surface here could only be a blind last-write-wins over a whole document.
    Unlike the browser's `frontend_api.BlobView` the payload is the **stored** document — that view
    additionally decorates each placement with a resolved NetBox URL for its search widget, which a
    client holding a token can build from the device/rack IDs itself. Per-Site scoping drops whole
    floors (`scope_floor_keys`), fail-closed."""

    @extend_schema(parameters=[FACILITY_PARAM], responses={200: OpenApiTypes.OBJECT})
    def get(self, request):
        facility = self.facility(request)
        rows = {row.key: row.data for row in FacilityMapBlob.objects.filter(
            kind='placements', facility=facility).exclude(key='')}
        viewable = viewable_site_slugs(request.user, facility)
        return Response({key: rows[key] for key in scope_floor_keys(rows, viewable)})
