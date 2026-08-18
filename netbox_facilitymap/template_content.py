"""Render the facility map natively on NetBox pages via `PluginTemplateExtension`s.

`FloorRooms` injects a floor-plan + room-polygon panel on a `dcim.Location` page (below);
`SiteFloors` injects a floor-picker grid on a `dcim.Site` page (mirroring the SPA's building
view) and `BuildingFloors` injects the same grid on a `dcim.Location` page when that Location is a
building anchor (Site = campus, MODEL-3), the two sharing `_floor_picker_cards`; `ObjectPlacement`
injects the *reverse link* on a `dcim.device`/`dcim.rack` page — the cropped room embed showing
where that object sits on the plan. All read the same runtime render artifacts and degrade to no
panel when absent.

`FloorRooms` and `ObjectPlacement` share the `RoomPanelExtension` base's two renderers —
`_floor_panel` (the whole-floor overlay) and `_room_panel` (the cropped room embed); they differ
only in how they resolve the `(floor_key, rooms)` to draw.

`RoomPanelExtension` / `FloorRooms` — floor plan + room polygons on a NetBox Location page.

A `PluginTemplateExtension` injects a panel onto the `dcim.Location` detail page. When the
Location is a *floor* — i.e. its `floor_key` (`"<site.slug>/<location.slug>"`, or
`"<site.slug>/<building.slug>/<location.slug>"` under a Location-anchored building, MODEL-3)
has a rendered plan — the panel draws that floor's plan image (all sheets, tiled) overlaid
with any room polygons (each linking to its bound room Location). Rooms drive NetBox-native
rendering and are object-permission scoped via `Room.objects.restrict(...)`.

Room geometry is normalized 0..1 over the floor's *combined* canvas; `previews.floor_sheets`
resolves that canvas (tiling every sheet at its grid cell, mirroring the editor) and returns
its combined `w`×`h`, which we scale the polygons/markers by. The panel renders even before
any rooms are drawn, and `floor_sheets(...) is None` is the gate for "this Location has no
rendered plan" (so we emit nothing rather than an empty SVG).
"""

from operator import attrgetter
from urllib.parse import quote

from django.db.models import Count
from django.urls import reverse
from dcim.models import Location, Rack
from netbox.plugins import PluginTemplateExtension

from . import capabilities, health
from .access import may_view_map, may_view_map_for_site
from .facilities import facility_for_location, facility_for_site, site_facilities
from .models import Room
from .previews import (
    ORIENTATION_ASPECT, PluginSettings, contained_map, evenodd_path, floor_sheets,
    placement_for_object, placement_markers, room_arrows, room_viewbox, sheet_bounds_for_rooms,
)
from .storage import media_url, read_manifest


class RoomPanelExtension(PluginTemplateExtension):
    """Shared base for the extensions that render the `floor_rooms.html` panel.

    Not registered itself — `models` lives on the concrete subclasses. Holds the two renderers
    they delegate to once they've resolved what to draw: `_floor_panel` (the whole-floor room
    overlay, from `FloorRooms`' floor branch) and `_room_panel` (the cropped room embed, from
    `FloorRooms`' room branch and `ObjectPlacement`). These are genuinely different
    renderings of the same template — markers, spotlight, crop, arrows and image export all belong
    to the embed alone — so each reads end to end rather than branching a mode flag through one
    body. What they *do* share is factored out: `_shared_context` (floor geometry + room shapes)
    and `_render` (the one `floor_rooms.html` call)."""

    def _shared_context(self, floor_key, rooms, all_rooms, facility, cross_link):
        """Resolve the floor geometry and room shapes both panels draw identically, or `None` when
        `floor_key` has no rendered plan (each renderer turns that into '', so a Location with no
        plan shows nothing).

        `rooms` are the rooms to *draw* — the whole floor, or the embedded Location's own room(s).
        `all_rooms` is the candidate pool for the contained-room subtraction below: the floor panel
        passes the same list, while the room embed passes the floor's full set, since it draws only
        its own rooms and would not otherwise know about the siblings sitting inside them.
        `cross_link` links each shape to its own room Location (the floor view); the embed passes
        False, as a self-link on the room's own page would be noise.

        Both room sequences are (re)sorted into **stacking order** here rather than by each caller's
        queryset (ROOM-4). The callers arrive ordered by `Room.Meta.ordering` — alphabetical by
        label — and paint order is a rendering concern, so owning it at the one seam every panel
        passes through keeps this mirror in step with the editor's `_renderStatic` instead of
        depending on three call sites each remembering an `.order_by`. The sorted `rooms` come back
        in the result for the same reason: `_room_panel`'s spotlight walks them again, and it must
        walk the same order rather than re-deriving it."""
        geom = floor_sheets(floor_key, facility)
        if not geom:
            return None
        w, h = geom['w'], geom['h']

        # Bottom→top, `room_id` breaking ties deterministically (rooms sharing a `z_order` are only
        # ever REST-created rows still on the `0` default). Matches `compose_annotations`' ordering,
        # so the embed and the editor agree on which room paints over which.
        by_z = attrgetter('z_order', 'room_id')
        all_rooms = sorted(all_rooms, key=by_z)
        rooms = sorted(rooms, key=by_z)

        # When a smaller room sits fully inside a larger one, punch the smaller room's area out of
        # the larger room's highlight (and its spotlight hole) so it doesn't double-paint over it.
        # The subtraction is render-time and derived; `contained_map` reads the stacking order above
        # to decide it, so only a contained room drawn ABOVE its container is punched out (ROOM-4).
        holes = contained_map(all_rooms)

        shapes = []
        for room in rooms:
            # Outer ring = the room's own polygon; inner rings = any contained smaller rooms,
            # punched out under `fill-rule="evenodd"` in the template.
            path = evenodd_path([room.polygon or []] + holes.get(room.room_id, []), w, h)
            if not path:
                continue
            shapes.append({
                'path': path,
                'label': room.label or room.room_id,
                'url': (room.location.get_absolute_url()
                        if cross_link and room.location_id else ''),
            })
        return {'geom': geom, 'w': w, 'h': h, 'holes': holes, 'shapes': shapes, 'rooms': rooms}

    def _render(self, ctx, *, title, map_url, markers=(), viewbox=None, embed_size=None,
                embed_aspect=None, spotlight=(), arrows=(), export_enabled=False, export_name=''):
        """Render `floor_rooms.html` from a `_shared_context` result plus the per-mode extras.

        Every keyword default is the *whole-floor* value — no crop, no markers, no spotlight, no
        arrows, no export — so `_floor_panel` passes none of them and `_room_panel` passes them
        all. Adding an embed-only feature therefore means adding one keyword here and setting it
        in `_room_panel`; the floor panel opts out by construction rather than by remembering to."""
        return self.render('netbox_facilitymap/floor_rooms.html', extra_context={
            'vw': ctx['w'],
            'vh': ctx['h'],
            'sheets': ctx['geom']['sheets'],
            'shapes': ctx['shapes'],
            'markers': markers,
            'viewbox': viewbox,
            'embed_size': embed_size,
            'embed_aspect': embed_aspect,
            'spotlight': spotlight,
            'arrows': arrows,
            'map_url': map_url,
            'panel_title': title,
            'export_enabled': export_enabled,
            'export_name': export_name,
        })

    def _floor_panel(self, floor_key, rooms, facility=''):
        """Render the whole-floor overlay: every room on the floor drawn over its plan image (all
        sheets, tiled), each cross-linking to its own room Location.

        Deliberately plain — no crop, no rack/device markers, no spotlight, no wayfinding arrows
        and no image export; those belong to `_room_panel`, so this path never reads the embed
        settings either. It also needs no `user`: `rooms` arrives `.restrict(...)`-scoped from the
        caller, and the only thing `user` ever scoped (the markers' detail links) isn't drawn here.
        `facility` (resolved by the caller from the Location's site) scopes the manifest/blob
        reads. Returns '' when `floor_key` has no rendered plan, so non-floor Locations show
        nothing."""
        ctx = self._shared_context(floor_key, rooms, rooms, facility, cross_link=True)
        if ctx is None:
            return ''
        # Deep-link the panel title into the SPA's floor view (see `_deep_link`).
        return self._render(ctx, title='Facility Map — Rooms',
                            map_url=self._deep_link(floor_key, None, facility))

    def _room_panel(self, floor_key, rooms, all_rooms, user, facility='',
                    title='Facility Map — Rooms', focus=None):
        """Render the cropped room embed: `rooms` alone over their floor's plan image, with the SVG
        `viewBox` zoomed to their bounding box, the floor outside them dimmed, their rack/device
        markers and inbound wayfinding arrows drawn, and image export offered.

        `rooms` is normally one `Room`, but a Location can be modelled as **several** — one physical
        room traced as two polygons, both bound to the same `dcim.Location` (ROOM-9) — and they then
        render as one panel: every polygon highlighted, the crop framing their union, the spotlight
        lighting all of them, and the markers/arrows of every `room_id`. They must share `floor_key`
        (one panel draws one floor's plan); the caller filters to that. The device/rack embed passes
        exactly one room, so its framing is untouched by this.

        `all_rooms` is the floor's full (permission-scoped) room set — the embed draws only `rooms`,
        so it needs the siblings to find any contained smaller room to punch out of the highlights
        and spotlight. `user` permission-scopes the markers' rack/device detail links; the markers
        themselves stay bounded by `rooms`, which arrive `.restrict(...)`-scoped. `facility` (the
        object's facility, resolved by the caller from its site) scopes the manifest/blob reads.
        `title` is the card header (defaults to the Location page's wording; the device/rack embed
        passes a plainer "Facility Map"). `focus` (a normalized `(x, y)`, only from the device/rack
        embed, which always passes a single room) reframes the crop on the device's own marker
        instead of the room centroid, cropped tighter for a legible glyph (SHOW-3); the room-page
        embed passes `None` and keeps its room-centred, zoomable crop. Returns '' when `floor_key`
        has no rendered plan."""
        ctx = self._shared_context(floor_key, rooms, all_rooms, facility, cross_link=False)
        if ctx is None:
            return ''
        w, h = ctx['w'], ctx['h']
        # Stacking order, owned by `_shared_context` (ROOM-4) — the spotlight below and the
        # deep-link/export-name pick must read the same order the shapes were built in.
        rooms = ctx['rooms']

        # `inc/placement_markers.html` is a bare loop, so an empty result renders nothing.
        markers = placement_markers(floor_key, w, h, {r.room_id for r in rooms}, user, facility)

        # Dim the floor outside the embedded room(s) (a spotlight mask, drawn in the template) so
        # they read unambiguously even though the zoomed crop pulls neighbouring rooms into the
        # raster image. Scaled by the same combined-canvas w×h as the shapes; only rooms with
        # geometry contribute. Any smaller room contained in one of them is punched out of that
        # room's lit hole (evenodd), so a contained office stays dimmed too — it reads as "not part
        # of this room", matching the highlight subtraction in `_shared_context`.
        # One path PER room rather than one concatenated evenodd path over all of them: the mask
        # unions overlapping black paths, whereas evenodd parity would punch the *intersection* of
        # two polygons back out — a dark hole through the middle of a room traced as two halves that
        # meet with a slight overlap.
        spotlight = [d for d in
                     (evenodd_path([r.polygon] + ctx['holes'].get(r.room_id, []), w, h)
                      for r in rooms if r.polygon) if d]

        # The embed honours the configurable zoom, footprint and orientation. `orientation` picks
        # the box aspect ratio and `room_viewbox` reshapes the crop to match it (fills the box with
        # real floor); `embed_size`/`embed_aspect` drive the template wrapper (footprint width % +
        # CSS aspect-ratio). One `PluginSettings` instance loads the shared `settings` row once;
        # the two property reads hit its cached data, so the embed still costs a single query (not
        # one per value).
        embed = PluginSettings()
        embed_aspect = ORIENTATION_ASPECT[embed.orientation]
        polygons = [r.polygon for r in rooms if r.polygon]
        # On a multi-sheet floor, scope the crop to the room's own sheet cell so the embed doesn't
        # frame against — and reveal — the other page(s). `None` on single-sheet floors — and for
        # rooms spread across sheets, which have to be framed across both — leaves the crop against
        # the whole canvas, unchanged.
        bounds = sheet_bounds_for_rooms(polygons, ctx['geom']['sheets'], w, h)
        # Frame every embedded polygon: `room_viewbox` reads only the bounding box on the
        # room-centred path, so their concatenated vertices crop to their union (one polygon is
        # exactly the single-room crop). `focus` (device/rack embed only, always one room) instead
        # reframes on the device's own marker and crops tighter for a legible glyph; the room embed
        # passes `focus=None` (room-centred, honouring `zoom`). Orientation/footprint apply to both
        # — only the crop centre + span diverge.
        crop_ring = [point for polygon in polygons for point in polygon]
        viewbox = room_viewbox(crop_ring, w, h, zoom=embed.zoom, aspect=embed_aspect,
                               bounds=bounds, focus=focus)

        # Draw the wayfinding arrows whose destination is one of *these* rooms. The editor's fixed
        # head size reads magnified under the zoomed crop, so size the head at ~6% of the viewBox
        # width — a stable on-screen size across zoom levels. (The `room_id`s are already
        # permission-scoped via the `.restrict(...)` query; rooms with no geometry have no viewBox
        # to scale against.)
        arrows = []
        if viewbox:
            head_px = float(viewbox.split()[2]) * 0.06
            arrows = room_arrows(floor_key, {r.room_id for r in rooms}, w, h, head_px=head_px,
                                 facility=facility)

        # Deep-link the panel title into the SPA's room view (see `_deep_link`). `export_name` is
        # the client-side download filename stem (sanitized client-side). Both name the embed's
        # first room in stacking order: rooms sharing a Location share its slug and label, so the
        # pick only has to be deterministic, not meaningful.
        lead = rooms[0]
        return self._render(ctx, title=title,
                            map_url=self._deep_link(floor_key, lead, facility),
                            markers=markers, viewbox=viewbox, embed_size=embed.size,
                            embed_aspect=embed_aspect, spotlight=spotlight, arrows=arrows,
                            export_enabled=True,
                            export_name=lead.label or lead.room_id or 'room')

    @staticmethod
    def _deep_link(floor_key, crop_to, facility=''):
        """Build the SPA hash deep-link for the panel-title link, or '' when `floor_key` is not a
        `<dir>/<fid>` floor key. The whole-floor embed (`crop_to is None`) points at the floor view
        (`#/f/<dir>/<fid>`); the single-room embed points at the room deep-link
        (`#/r/<dir>/<fid>/<slug-or-id>`), which frames + highlights that room — so a Location /
        device / rack page links straight to the framed room. A non-default `facility` is prefixed
        as a `#/y/<slug>/…` segment so the SPA opens *this object's* facility (MULTI-2), matching
        the app.js router. Prefers the bound Location slug (stable, human-readable), falling back to
        the room's uid when unbound. The hash router decodes each segment (`decodeURIComponent` per
        part, app.js), so every part is encoded to match; `partition` guards a stray key with no '/'."""
        dir_part, _, fid_part = floor_key.partition('/')
        if not (dir_part and fid_part):
            return ''
        base = reverse('plugins:netbox_facilitymap:map')
        prefix = f'#/y/{quote(facility, safe="")}' if facility else '#'
        dir_q, fid_q = quote(dir_part, safe=''), quote(fid_part, safe='')
        if crop_to is None:
            return f'{base}{prefix}/f/{dir_q}/{fid_q}'
        seg = crop_to.location.slug if crop_to.location_id else crop_to.room_id
        return f'{base}{prefix}/r/{dir_q}/{fid_q}/{quote(str(seg), safe="")}'

    def _unresolved_panel(self):
        """Render the "floor plan unavailable" explanation shown in place of a silently-blank floor
        panel when the floor's plan key has drifted out of resolution (HEALTH-5). Its caller decides
        *whether* the blank is a drifted floor (via `health.floor_plan_drift`); this just draws the
        message. Self-contained/inline-styled like `floor_rooms.html` — no plugin CSS on dcim pages."""
        return self.render('netbox_facilitymap/floor_unresolved.html')


class FloorRooms(RoomPanelExtension):
    # Plural `models` is the NetBox 4.x API (the legacy singular `model` was removed);
    # verify against the pinned minor (4.1.7–4.6.99) — template-extension APIs shift.
    models = ['dcim.location']

    def right_page(self):
        loc = self.context['object']
        request = self.context['request']

        # Honour the map-read gate — and, under per-Site scoping (SEC-1), the object's own Site:
        # a user who may view this Location but NOT its Site sees no plan panel (the plan is a
        # Site-level asset streamed through the now-scoped MediaView, so the panel would only show
        # broken tiles). With scoping off this is exactly `may_view_map`. Room-marker `restrict()`
        # scoping is orthogonal and still applies below.
        if not may_view_map_for_site(request.user, getattr(loc, 'site', None)):
            return ''

        # The facility this Location belongs to — its site's SiteGroup/Region, or under the
        # `location` grouping its subtree's root (MODEL-8) — so the right facility's
        # manifest/blobs are read. A room and its floor share the same subtree and site.
        facility = facility_for_location(loc)

        # This Location *is* a room (bound via Room.location) → show that room, cropped to its
        # geometry. This is the per-room view the user lands on from a room's page. **Every** row
        # bound to the Location is drawn, not just the first: one physical room is sometimes traced
        # as two polygons both bound to the same Location, and binding copies the Location name into
        # every `room.label`, so `Room.Meta.ordering` couldn't even tell them apart — picking one
        # rendered an arbitrary half of the room (ROOM-9).
        rooms = list(Room.objects.restrict(request.user, 'view')
                     .filter(location=loc).select_related('location'))
        if rooms:
            # One panel draws one floor's plan, so rows bound to this Location on *other* floors
            # can't join it. Keep the primary floor — `Room.Meta.ordering` leads with `floor_key`,
            # so this is the same floor the single-room embed has always shown.
            floor_key = rooms[0].floor_key
            rooms = [room for room in rooms if room.floor_key == floor_key]
            # The floor's other rooms (permission-scoped) are the candidate pool for punching a
            # contained smaller room out of these rooms' highlights/spotlight — the embed itself
            # draws only its own rooms, so it wouldn't otherwise know about the siblings sitting
            # inside them.
            floor_rooms = list(Room.objects.restrict(request.user, 'view')
                               .filter(floor_key=floor_key))
            return self._room_panel(floor_key, rooms, floor_rooms, request.user,
                                    facility=facility)

        # Otherwise this Location *is a floor* → show every room on the floor, uncropped, each
        # linking to its own room Location. Rooms are matched by the rename-proof `floor_location`
        # FK (BIND-1), not by reconstructing `f'{site.slug}/{loc.slug}'`, so a renamed Site/floor
        # Location keeps resolving its rooms. The plan image still keys off `floor_key` (the
        # manifest/disk key), taken from a matched room; an empty floor has no room to borrow it
        # from, so it falls back to a reconstructed slug key — preserving today's plan render for a
        # floor with no rooms drawn (a rename can still break that empty-floor panel, but no room
        # data is at risk, and `health` surfaces the drift).
        site = getattr(loc, 'site', None)
        if not site:
            return ''
        rooms = list(
            Room.objects.restrict(request.user, 'view')
            .filter(floor_location=loc).select_related('location'))
        if rooms:
            floor_key = rooms[0].floor_key
        elif loc.parent_id:
            # Location-anchored (Site=campus, MODEL-3): under this topology a floor Location's own
            # parent *is* its building anchor (mirrors how `BuildingFloors`/`resolve_floor_location`
            # key building-anchored floors), so the reconstructed key needs that 3rd segment — a
            # Site-anchored floor has no parent and keeps the plain 2-segment key below.
            floor_key = f'{site.slug}/{loc.parent.slug}/{loc.slug}'
        else:
            floor_key = f'{site.slug}/{loc.slug}'
        # `_floor_panel` returns '' when `floor_key` has no rendered plan — which covers BOTH a Location
        # that isn't a floor at all (legitimately blank) and a floor whose plan key drifted out of
        # resolution (a Site/floor rename a bulk-edit/manual DB write left un-remapped, the residue
        # HEALTH-4's signal can't catch). For the second case, explain the blank to the user rather
        # than showing nothing; `health.floor_plan_drift` distinguishes it from the non-floor case,
        # so the message never lands on a Location that was never a floor.
        panel = self._floor_panel(floor_key, rooms, facility=facility)
        if not panel and health.floor_plan_drift(loc):
            return self._unresolved_panel()
        return panel


class ObjectPlacement(RoomPanelExtension):
    """Reverse-link "show on map" panel on a `dcim.device` / `dcim.rack` page (vs `FloorRooms`).

    From an object's detail page, resolve *where it sits on the plan* and draw the cropped
    single-room embed, **framed on the object's own marker** rather than the room centroid the
    room's Location page uses — so the device reads legibly instead of being lost in a large room
    (SHOW-3). `previews.placement_for_object` does the object → `(floor_key, room_id, focus)` lookup
    (a rack matches its own placement; a racked device resolves via its rack when it has no direct
    placement of its own, framing on the rack); we then resolve that `room_id` back to a `Room`,
    **permission-scoped**, and delegate to the shared `_room_panel` with `focus`. Any miss — unplaced
    object, no such room, room not viewable, or no rendered plan — yields no panel, exactly as the
    sibling extensions degrade.
    """

    # Plural `models` is the NetBox 4.x API (the legacy singular `model` was removed).
    models = ['dcim.device', 'dcim.rack']

    def right_page(self):
        obj = self.context['object']
        request = self.context['request']

        # Same gate as FloorRooms — and, under per-Site scoping (SEC-1), the device/rack's Site:
        # no placement embed for a user who may not view the map, or (when scoped) may not view the
        # object's Site whose plan the embed would draw.
        if not may_view_map_for_site(request.user, getattr(obj, 'site', None)):
            return ''

        # The object's facility scopes which facility's placements blob is searched and which
        # manifest/blobs the panel reads. Resolved through the object's room Location where it has
        # one (a rack's own, or a racked device via its rack) — under the `location` grouping the
        # facility is that Location's subtree root (MODEL-8), which the Site alone can't name; the
        # Site-FK groupings resolve identically either way. A location-less object (a site-level
        # rack) falls back to the site-level answer.
        loc = getattr(obj, 'location', None)
        if loc is None and getattr(obj, 'rack', None) is not None:
            loc = obj.rack.location
        facility = (facility_for_location(loc) if loc is not None
                    else facility_for_site(getattr(obj, 'site', None)))

        # A Rack matches its own placement; a Device prefers a direct placement, else falls back
        # to its rack's (the common case — only the cabinet is drawn on the plan).
        if isinstance(obj, Rack):
            match = placement_for_object('rack', obj.pk, facility=facility)
        else:
            match = placement_for_object('device', obj.pk, rack_pk=obj.rack_id, facility=facility)
        if not match:
            return ''
        # `focus` is the placed object's own normalized marker centre (the rack's, when a racked
        # device resolves via its cabinet) — passed to `_room_panel` so the embed frames on the
        # device itself, cropped tight, rather than the whole room the room-page embed shows
        # (SHOW-3).
        floor_key, room_id, focus = match

        # Resolve the placement's room back to a viewable Room — a miss (deleted room, or one the
        # user may not view) shows nothing rather than leaking a room the caller can't otherwise see.
        room = (Room.objects.restrict(request.user, 'view')
                .filter(floor_key=floor_key, room_id=room_id).select_related('location').first())
        if not room:
            return ''
        # The floor's other rooms (permission-scoped) let `_room_panel` subtract a contained smaller
        # room from this room's highlight/spotlight; the embed itself draws only `room`. Exactly ONE
        # room is passed even where its Location is modelled as several (ROOM-9): this embed frames
        # the object, so it must stay on the polygon actually holding it, not their union.
        floor_rooms = list(Room.objects.restrict(request.user, 'view').filter(floor_key=floor_key))
        return self._room_panel(floor_key, [room], floor_rooms, request.user, facility=facility,
                                title='Facility Map', focus=focus)


def _floor_picker_cards(buildings, floor_locs, facility, built, user):
    """The floor-picker cards shared by `SiteFloors` (dcim.site, Site-anchored) and `BuildingFloors`
    (dcim.location, Location-anchored): one card per rendered floor — thumbnail, label, a room-count
    badge and a sheet-count badge — each linking to that floor's own NetBox Location page.

    `buildings` are the manifest building entries for the anchor; `floor_locs` maps a floor id
    (== the floor Location's `slug`) to that `dcim.Location` for the card link. Room counts come from
    ONE grouped, `.restrict(user,'view')`-scoped query rather than a COUNT per card, keyed off
    `building['dir']` — which is `<siteSlug>` for a Site-anchored building and
    `<siteSlug>/<buildingSlug>` for a Location-anchored one, so the count is correct for both the
    2-segment and 3-segment `floor_key` shapes (MODEL-3). Floors with no rooms simply don't appear
    in the grouped result and fall back to 0."""
    floor_keys = [f"{building['dir']}/{floor['id']}"
                  for building in buildings
                  for floor in building.get('floors', [])]
    room_counts = {r['floor_key']: r['n'] for r in
                   Room.objects.restrict(user, 'view')
                   .filter(floor_key__in=floor_keys)
                   .values('floor_key').annotate(n=Count('id'))}

    cards = []
    for building in buildings:
        for floor in building.get('floors', []):
            loc = floor_locs.get(floor['id'])
            cards.append({
                # Card-sized `thumb` when the manifest has one (builds since 1.44.0);
                # fall back to the full-res plan for older manifests.
                'image': media_url(floor.get('thumb') or floor.get('image'), facility, built),
                'label': floor.get('label') or floor['id'],
                'url': loc.get_absolute_url() if loc else '',
                'rooms': room_counts.get(f"{building['dir']}/{floor['id']}", 0),
                'sheets': len(floor.get('pages') or []),
            })
    return cards


class SiteFloors(PluginTemplateExtension):
    """Embed a building's floor picker on its NetBox `dcim.Site` page (the Site-anchored surface).

    Here a Site *is* one building, so this mirrors the SPA's building view
    (`App.renderBuilding`): a grid of floor cards — thumbnail, label, a room-count badge and a
    sheet-count badge — one per rendered floor of the building(s) whose manifest `siteSlug`
    matches `site.slug`. Each card links to that floor's NetBox Location page (the Location
    whose `slug` is the floor id), keeping the user in NetBox where `FloorRooms` then draws the
    plan. The manifest is a runtime render artifact, so a missing/unreadable manifest (or a
    Site with no matching rendered building) yields no panel rather than an empty grid.

    The Location-anchored counterpart (Site = campus, building is a `dcim.Location`) is
    `BuildingFloors`, which sits on the `dcim.location` page; both build their cards through the
    shared `_floor_picker_cards`.
    """

    models = ['dcim.site']

    def full_width_page(self):
        site = self.context['object']
        request = self.context['request']

        # Same map-read gate as the room panels — no floor-picker grid (its thumbnails stream
        # through the gated MediaView) for a user who may not view the map. Plain `may_view_map`
        # suffices here (no per-Site check like the sibling panels): the Site *is* this page's
        # object, so NetBox already `.restrict()`-ed it — reaching this page means the Site is
        # viewable. Its floor thumbnails live at `images/<this-site-slug>/…`, in-scope by construction.
        if not may_view_map(request.user):
            return ''

        # The facility (or facilities) whose manifests may name this Site. One under the Site-FK
        # groupings; under the `location` grouping a campus Site hosts a facility per top-level
        # Location (MODEL-8), so every rooted facility's manifest is scanned and the cards
        # concatenate — the campus page stays the whole-Site floor overview.
        floor_locs = None
        cards = []
        for facility in sorted(site_facilities(site)):
            manifest = read_manifest(facility)
            if manifest is None:
                continue
            # `siteSlug` could in principle repeat across `dir`s, so filter rather than assume one.
            buildings = [b for b in manifest.get('buildings', [])
                         if b.get('siteSlug') == site.slug]
            if not buildings:
                continue
            if floor_locs is None:
                # Floor Locations under this Site, keyed by slug (== floor id), for the card links.
                floor_locs = {l.slug: l for l in
                              Location.objects.restrict(request.user, 'view').filter(site=site)}
            cards += _floor_picker_cards(buildings, floor_locs, facility,
                                         manifest.get('built'), request.user)
        if not cards:
            return ''

        return self.render('netbox_facilitymap/site_floors.html',
                           extra_context={'cards': cards})


class BuildingFloors(PluginTemplateExtension):
    """Embed a building's floor picker on its NetBox `dcim.Location` page (the Location-anchored
    surface — MODEL-3 / BUILDING-ANCHOR-DESIGN §4.5).

    Under Site = campus a building is a `dcim.Location`, not a Site, so its home page is the
    Location page and its floors are that Location's **child** Locations. This mirrors `SiteFloors`
    — the same card grid, via the shared `_floor_picker_cards` — but matches the manifest building
    whose `(siteSlug, buildingSlug)` anchor is this Location, keys off the 3-segment `floor_key`,
    and links each card to the floor Location beneath the building. A Site-anchored building never
    carries a `buildingSlug`, so it never matches here and stays on `SiteFloors`. A missing/
    unreadable manifest, or a Location that is not a building anchor, yields no panel.
    """

    models = ['dcim.location']

    def full_width_page(self):
        loc = self.context['object']
        request = self.context['request']

        # Same gate as FloorRooms, NOT SiteFloors' plain `may_view_map`: the page object here is the
        # building Location, so its Site is not implicitly `.restrict()`-ed by reaching this page,
        # and the floor thumbnails stream through the SEC-1 per-Site media gate
        # (`images/<siteSlug>/<buildingSlug>/…`). A user who may see this Location but not its Site
        # gets no grid rather than broken tiles.
        site = getattr(loc, 'site', None)
        if not may_view_map_for_site(request.user, site):
            return ''
        if site is None:
            return ''

        # This building's facility — its Site's SiteGroup/Region, or under the `location` grouping
        # its own subtree's root (MODEL-8) — scopes the manifest + media.
        facility = facility_for_location(loc)
        manifest = read_manifest(facility)
        if manifest is None:
            return ''

        # A manifest building is anchored to THIS Location iff its (optional) `buildingSlug` is this
        # Location's slug AND its pure `siteSlug` is this Location's Site — `buildingSlug` is
        # namespaced under the Site, so both must agree. Site-anchored buildings have no
        # `buildingSlug` and so never match, keeping this surface Location-anchored only.
        buildings = [b for b in manifest.get('buildings', [])
                     if b.get('buildingSlug') == loc.slug and b.get('siteSlug') == site.slug]
        if not buildings:
            return ''

        # Floors are this building Location's child Locations, keyed by slug (== floor id). Two
        # buildings under one campus can share a floor slug, so scoping to `parent=loc` (not
        # `site=site`) is what picks *this* building's floors for the card links.
        floor_locs = {l.slug: l for l in
                      Location.objects.restrict(request.user, 'view').filter(parent=loc)}
        cards = _floor_picker_cards(buildings, floor_locs, facility,
                                    manifest.get('built'), request.user)
        if not cards:
            return ''

        return self.render('netbox_facilitymap/site_floors.html',
                           extra_context={'cards': cards})


# The core extensions, plus any contributed by an enabled optional capability (the add-on
# framework, ADDON-2): a capability that overlays its own panel on a NetBox page adds its
# `PluginTemplateExtension`s via `template_extensions()` rather than editing this list. Empty until
# a feature capability ships one.
template_extensions = ([FloorRooms, SiteFloors, BuildingFloors, ObjectPlacement]
                       + capabilities.all_template_extensions())
