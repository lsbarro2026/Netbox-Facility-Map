"""Row → JSON-safe dict shaping for every `frontend_api` endpoint.

One module for all of it, because the alternative is what this replaced: three independent
"strip a DB row into a dict" families scattered across 2300 lines, each re-deriving the same
absolute URL / display name / floor hierarchy. Collected here they can be read side by side,
so a change to one shape is an obvious prompt to check its siblings.

The three primitives at the top are the parts that were genuinely duplicated — an absolute
detail-page URL (written out at eight call sites), the name-or-`str()` fallback (three), and
the room→floor hierarchy quad (three, verbatim). Everything below them is a distinct response
contract with its own frontend consumer, and they are deliberately **not** merged: `_trim`
answers "which Location is this room bound to" (slug/description/parent for the tree walk)
while `_inv_room` answers "where on the map does this live" (site/floor slugs for navigation).
Collapsing those behind a flag would be worse than the overlap.

Nothing here queries or writes — pure shaping over an already-fetched row, so the callers stay
in charge of scoping (`.restrict(user, …)`) and prefetching.
"""


def abs_url(obj, request):
    """The object's NetBox detail page, absolute against the current host.

    Absolute (not the bare `get_absolute_url()`) because these payloads are consumed by a
    frontend that opens them directly — a relative path would resolve against the SPA's own
    mount, not NetBox's."""
    return request.build_absolute_uri(obj.get_absolute_url())


def display_name(obj):
    """A name that is always renderable: the row's own `name`, or its `str()` when that is
    blank. `dcim.Device.name` is nullable (an unnamed device is identified by its type +
    position), so the fallback is what keeps an unnamed device from rendering as an empty
    string in a picker or search hit."""
    return obj.name or str(obj)


def floor_ref(room_loc):
    """The site/floor hierarchy of a **room** Location — the four keys every finder result
    carries so the frontend can navigate to the right map floor.

    `room_loc.parent` is the floor Location; the callers all filter `parent__isnull=False`
    (a floor or site-root Location is not a finder target and has no map floor to resolve),
    so both hops are guaranteed to resolve here. `(site_slug, floor_slug)` is a manifest
    building/floor `(dir, fid)` pair; the display names accompany them so a row whose floor
    isn't on the map can still be labelled."""
    return {
        'site_slug': room_loc.site.slug,
        'site_name': room_loc.site.name,
        'floor_slug': room_loc.parent.slug,
        'floor_name': room_loc.parent.name,
    }


# --- Locations, and the rooms bound to them ----------------------------------------

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
        'url': abs_url(loc, request),
        # `parent` (a plain FK column, reliable on any queryset and across MPTT/tree-queries)
        # lets the frontend walk the Location tree; `depth` is left for compatibility but is an
        # MPTT-only `level` artifact and unreliable on NetBox 4.2+.
        'parent': loc.parent_id,
        'depth': getattr(loc, 'level', 0),
    }


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


# --- The import wizard's bind targets ----------------------------------------------

def _trim_site(site, request):
    """Shape a Site for the wizard's building-bind picker (`NbSitesView`). Narrower than
    `_trim`'s Location shape: a Site is bound whole, so there is no tree to walk."""
    return {
        'id': site.pk,
        'name': site.name,
        'slug': site.slug,
        'url': abs_url(site, request),
    }


def _trim_building_location(loc, request):
    """Shape a building-anchor Location for `NbBuildingLocationsView` (MODEL-4). Carries its
    campus `site_slug`/`site_name` alongside the building's own slug, because the frontend
    records both — the Site slug becomes the manifest `siteSlug`, the Location slug the
    `buildingSlug`."""
    return {
        'id': loc.pk,
        'name': loc.name,
        'slug': loc.slug,
        'site_slug': loc.site.slug,
        'site_name': loc.site.name,
        'url': abs_url(loc, request),
    }


# --- Racks and devices (the placement panel) ---------------------------------------

def _trim_rack(rack, request):
    """Shape a Rack for the frontend (mirrors `NetBoxProxy._trim_rack`)."""
    return {
        'id': rack.pk,
        'name': rack.name,
        'url': abs_url(rack, request),
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
        'name': display_name(device),
        'url': abs_url(device, request),
        'role': {'slug': role.slug, 'name': role.name} if role else None,
        'device_type': {'model': dtype.model, 'u_height': dtype.u_height} if dtype else None,
    }


# --- Users and to-dos (ADDON-1 / TASK-2) -------------------------------------------

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


# --- The finder's facility-wide inventory search (NAV-3) ---------------------------

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
        **floor_ref(loc),
        'url': abs_url(loc, request),
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
        'name': display_name(obj),
        'room_id': loc.pk,
        **floor_ref(loc),
        'url': abs_url(obj, request),
    }


def _inv_racked_device(dev, request):
    """Shape a rack-mounted Device for the finder inventory search (NAV-19). A racked device is never
    drawn on the map — its rack is one opaque icon — so navigation targets the **rack**: the floor
    hierarchy here is resolved through `dev.rack.location` (the rack's room), not `dev.location`, and
    `rack_id`/`rack_name` let the frontend reuse the rack's own placement (or fall back to the rack's
    floor when the rack isn't placed either). `url` stays the *device's* NetBox page — in the search
    widget's NetBox-target mode (NAV-16) the device itself is what the searcher wanted."""
    loc = dev.rack.location
    return {
        'kind': 'device',
        'id': dev.pk,
        'name': display_name(dev),
        'rack_id': dev.rack_id,
        'rack_name': dev.rack.name,
        'room_id': loc.pk,
        **floor_ref(loc),
        'url': abs_url(dev, request),
    }
