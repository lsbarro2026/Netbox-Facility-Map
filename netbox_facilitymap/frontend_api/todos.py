"""Floor to-do list (ADDON-1) + the active-user lookup its assignee picker rides on (TASK-2).

A per-room to-do list on the floor page. Reads ride the shared map-read gate (anyone who can see
the floor sees its to-dos); writes require `EDIT_PERM` like every other map mutation. A to-do is
addressed only through a room the requester may `view`, so object permissions on a room's
Location gate its to-dos too. The frontend `Api` client is GET/POST-only, so updates and deletes
are POSTs (`/api/todos/<id>` and `/api/todos/<id>/delete`) rather than PATCH/DELETE — matching the
GET/POST-only convention every other endpoint here follows.

`UsersView` sits here rather than with the NetBox reads because it exists solely for this
feature's assignee picker, and shares the map-read gate (not `EDIT_PERM`) for the reason its
docstring gives: a viewer must be able to render assignee avatars on to-dos they cannot edit.
"""

from datetime import date

from django.contrib.auth import get_user_model
from django.db.models import Q
from django.http import (
    HttpResponseBadRequest, HttpResponseForbidden, HttpResponseNotFound, JsonResponse,
)
from django.views import View

from ..access import EDIT_PERM, MapReadAccessMixin, may_view_site_slug, viewable_site_slugs
from ..facilities import facility_floor_scope
from ..models import Room, RoomTodo, parse_floor_key
from ..previews import todos_enabled
from .common import NB_LIST_CAP, _facility, _parse_json_body, _scope_rooms
from .serializers import _serialize_todo, serialize_user

_TODO_STATUSES = {c[0] for c in RoomTodo.STATUS_CHOICES}
_TODO_PRIORITIES = {c[0] for c in RoomTodo.PRIORITY_CHOICES}
_TODO_TEXT_MAX = RoomTodo._meta.get_field('text').max_length
#: The updatable columns on the row itself — `assignees` is excluded because it's an M2M write, not
#: a column, and needs no `save()`.
_TODO_COLUMNS = {'text', 'status', 'priority', 'notes', 'due'}


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
    facility-wide rollup, which has no floor to imply a facility, is `FacilityTodosView`. That same
    embedded slug is what per-Site read scoping checks (SEC-2): under it, a floor whose Site the
    viewer may not see reports no to-dos."""

    def get(self, request):
        floor_key = request.GET.get('floor_key', '')
        if not floor_key:
            return HttpResponseBadRequest('floor_key required')
        # A floor on a Site the viewer may not see has no visible to-dos (SEC-2). The key names one
        # Site outright, so this is a single slug check rather than the facility-wide scope set.
        if not may_view_site_slug(request.user, parse_floor_key(floor_key)[0]):
            return JsonResponse({})
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
    `facility_floor_scope` Q that `compose_annotations`/`sync_rooms` use: the facility's site
    slugs (or, under the `location` grouping, its Location subtree — MODEL-8), unioned with the
    rename-proof `floor_location` FK (BIND-1). The scope is resolved unscoped by
    design (it bounds which floors are the facility's, not who may see them) — the rooms
    themselves stay `.restrict(user, 'view')`, so object permissions on a room's Location still
    gate its to-dos exactly as they do per-floor. Under `scope_reads_to_sites` (SEC-2) they are
    additionally narrowed to the viewer's Sites, so this rollup can't reveal to-dos the per-floor
    read withholds."""

    def get(self, request):
        facility = _facility(request)
        if facility is None:
            return HttpResponseBadRequest('invalid facility')
        scope = facility_floor_scope(facility)
        # A facility with no sites owns no floors, so it owns no to-dos. Empty, not an error: an
        # install mid-import legitimately has a facility whose Sites aren't bound yet.
        if scope is None:
            return JsonResponse({})
        # Per-Site read scoping (SEC-2): a hidden Site's floors contribute no to-dos, matching what
        # the annotations read withholds — the rollup must not reveal what the floor read hides.
        rooms = _scope_rooms(Room.objects.restrict(request.user, 'view').filter(scope),
                             viewable_site_slugs(request.user, facility))
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

    LIMIT = NB_LIST_CAP

    def get(self, request):
        q = request.GET.get('q', '').strip()
        qs = get_user_model().objects.filter(is_active=True).order_by('username')
        if q:
            qs = qs.filter(Q(username__icontains=q) | Q(first_name__icontains=q)
                            | Q(last_name__icontains=q))
        return JsonResponse({'users': [serialize_user(u) for u in qs[:self.LIMIT]]})
