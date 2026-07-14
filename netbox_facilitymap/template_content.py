"""Render the facility map natively on NetBox pages via `PluginTemplateExtension`s.

`FloorRooms` injects a floor-plan + room-polygon panel on a `dcim.Location` page (below);
`SiteFloors` injects a floor-picker grid on a `dcim.Site` page (mirroring the SPA's building
view); `ObjectPlacement` injects the *reverse link* on a `dcim.device`/`dcim.rack` page — the
cropped room embed showing where that object sits on the plan. All read the same runtime render
artifacts and degrade to no panel when absent.

`FloorRooms` and `ObjectPlacement` share the `RoomPanelExtension` base's `_panel` renderer; they
differ only in how they resolve the `(floor_key, room)` to draw.

`RoomPanelExtension` / `FloorRooms` — floor plan + room polygons on a NetBox Location page.

A `PluginTemplateExtension` injects a panel onto the `dcim.Location` detail page. When the
Location is a *floor* — i.e. `floor_key == "<site.slug>/<location.slug>"` has a rendered
plan — the panel draws that floor's plan image (all sheets, tiled) overlaid with any room
polygons (each linking to its bound room Location). Rooms drive NetBox-native rendering and
are object-permission scoped via `Room.objects.restrict(...)`.

Room geometry is normalized 0..1 over the floor's *combined* canvas; `previews.floor_sheets`
resolves that canvas (tiling every sheet at its grid cell, mirroring the editor) and returns
its combined `w`×`h`, which we scale the polygons/markers by. The panel renders even before
any rooms are drawn, and `floor_sheets(...) is None` is the gate for "this Location has no
rendered plan" (so we emit nothing rather than an empty SVG).
"""

from urllib.parse import quote

from django.db.models import Count
from django.urls import reverse
from dcim.models import Location, Rack
from netbox.plugins import PluginTemplateExtension

from . import capabilities
from .access import may_view_map, may_view_map_for_site
from .facilities import facility_for_site
from .models import Room
from .previews import (
    ORIENTATION_ASPECT, RoomEmbedSettings, floor_sheets, placement_for_object, placement_markers,
    room_arrows, room_viewbox,
)
from .storage import media_url, read_manifest


class RoomPanelExtension(PluginTemplateExtension):
    """Shared base for the extensions that render the `floor_rooms.html` panel.

    Not registered itself — `models` lives on the concrete subclasses. Holds `_panel`, the
    single renderer both `FloorRooms` (Location pages) and `ObjectPlacement` (device/rack pages)
    delegate to once they've resolved which floor + rooms to draw."""

    def _panel(self, floor_key, rooms, crop_to, user, title='Facility Map — Rooms', facility=''):
        """Render the panel for `rooms` over their floor's plan image (all sheets, tiled).
        `crop_to` (a single Room) zooms the SVG `viewBox` to that room's bounding box, drops
        the per-room cross-links and draws the rack/device markers; `None` keeps the
        whole-floor view and omits the markers. `rooms` is already `.restrict(...)`-scoped, so
        its room_ids keep the markers permission-bounded; `user` further permission-scopes the
        markers' rack/device detail links. `title` is the card header (defaults to the Location
        page's wording; the device/rack embed passes a plainer "Facility Map"). `facility` (the
        object's facility, resolved by the caller from its site) scopes the manifest/blob reads.
        Returns '' when `floor_key` has no rendered plan, so non-floor Locations show nothing."""
        geom = floor_sheets(floor_key, facility)
        if not geom:
            return ''
        w, h = geom['w'], geom['h']

        shapes = []
        for room in rooms:
            pts = ' '.join(f'{x * w:.1f},{y * h:.1f}' for x, y in (room.polygon or []))
            if not pts:
                continue
            shapes.append({
                'points': pts,
                'label': room.label or room.room_id,
                # Cross-link to the room's Location only on the floor view; on the room's own
                # page a self-link would be noise.
                'url': '' if crop_to else (room.location.get_absolute_url() if room.location_id else ''),
            })

        # Rack/device markers only on the cropped single-room embed; the whole-floor view
        # (crop_to=None) omits them so the floor panel stays a clean plan + room-polygon
        # overlay. `inc/placement_markers.html` is a bare loop, so [] renders nothing.
        markers = placement_markers(floor_key, w, h, {r.room_id for r in rooms}, user, facility) if crop_to else []

        # On the cropped single-room embed, dim the floor outside the room's own polygon
        # (a spotlight mask, drawn in the template) so the room reads unambiguously even
        # though the zoomed crop pulls neighbouring rooms into the raster image. Scaled by
        # the same combined-canvas w×h as the shapes; only set when cropping to a room with
        # geometry — the whole-floor view never dims.
        spotlight = ''
        if crop_to and crop_to.polygon:
            spotlight = ' '.join(f'{x * w:.1f},{y * h:.1f}' for x, y in crop_to.polygon)

        # Deep-link the panel title into the SPA (see `_deep_link`).
        map_url = self._deep_link(floor_key, crop_to, facility)

        # The cropped room embed honours the configurable zoom, footprint and orientation; the
        # whole-floor view (crop_to=None) passes none of them, so the settings never affect floor
        # views. `orientation` picks the box aspect ratio and `room_viewbox` reshapes the crop to
        # match it (fills the box with real floor); `embed_size`/`embed_aspect` drive the template
        # wrapper (footprint width % + CSS aspect-ratio).
        embed_size = embed_aspect = None
        if crop_to:
            # One `RoomEmbedSettings` instance loads the shared `settings` row once; the three
            # property reads hit its cached data, so the embed still costs a single query (not
            # one per value).
            embed = RoomEmbedSettings()
            embed_aspect = ORIENTATION_ASPECT[embed.orientation]
            embed_size = embed.size
            viewbox = room_viewbox(crop_to.polygon, w, h, zoom=embed.zoom, aspect=embed_aspect)
        else:
            viewbox = None

        # Draw the wayfinding arrows whose destination is *this* room, on the per-room embed
        # only. The editor's fixed head size reads magnified under the zoomed crop, so size
        # the head at ~6% of the viewBox width — a stable on-screen size across zoom levels.
        # (`crop_to.room_id` is already permission-scoped via the `.restrict(...)` query.)
        arrows = []
        if crop_to and viewbox:
            head_px = float(viewbox.split()[2]) * 0.06
            arrows = room_arrows(floor_key, crop_to.room_id, w, h, head_px=head_px, facility=facility)

        # Client-side image export (PNG/SVG) is offered only on the cropped single-room embed
        # (this Location page + the device/rack placement panel), never the whole-floor view —
        # both room callers pass `crop_to`, the floor caller passes `None`. `export_name` is the
        # download filename stem (sanitized client-side).
        export_enabled = bool(crop_to)
        export_name = (crop_to.label or crop_to.room_id or 'room') if crop_to else ''

        return self.render('netbox_facilitymap/floor_rooms.html', extra_context={
            'vw': w,
            'vh': h,
            'sheets': geom['sheets'],
            'shapes': shapes,
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

        # The facility this Location belongs to (its site's SiteGroup/Region), so the right
        # facility's manifest/blobs are read. A room and its floor share the same site.
        facility = facility_for_site(getattr(loc, 'site', None))

        # This Location *is* a room (bound via Room.location) → show just that room, cropped
        # to its geometry. This is the per-room view the user lands on from a room's page.
        room = (Room.objects.restrict(request.user, 'view')
                .filter(location=loc).select_related('location').first())
        if room:
            return self._panel(room.floor_key, [room], crop_to=room, user=request.user,
                               facility=facility)

        # Otherwise this Location *is a floor* → show every room on the floor, uncropped, each
        # linking to its own room Location. Rooms are matched by the rename-proof `floor_location`
        # FK (BIND-1), not by reconstructing `f'{site.slug}/{loc.slug}'`, so a renamed Site/floor
        # Location keeps resolving its rooms. The plan image still keys off `floor_key` (the
        # manifest/disk key), taken from a matched room; an empty floor has no room to borrow it
        # from, so it falls back to the slug key — preserving today's plan render for a floor with
        # no rooms drawn (a rename can still break that empty-floor panel, but no room data is at
        # risk, and `health` surfaces the drift).
        site = getattr(loc, 'site', None)
        if not site:
            return ''
        rooms = list(
            Room.objects.restrict(request.user, 'view')
            .filter(floor_location=loc).select_related('location'))
        floor_key = rooms[0].floor_key if rooms else f'{site.slug}/{loc.slug}'
        # `_panel` returns '' when `floor_key` has no rendered plan (i.e. not a floor at all).
        return self._panel(floor_key, rooms, crop_to=None, user=request.user, facility=facility)


class ObjectPlacement(RoomPanelExtension):
    """Reverse-link "show on map" panel on a `dcim.device` / `dcim.rack` page (vs `FloorRooms`).

    From an object's detail page, resolve *where it sits on the plan* and draw the same cropped
    single-room embed the room's Location page shows. `previews.placement_for_object` does the
    object → `(floor_key, room_id)` lookup (a rack matches its own placement; a racked device
    resolves via its rack when it has no direct placement of its own); we then resolve that
    `room_id` back to a `Room`, **permission-scoped**, and delegate to the shared `_panel`. Any
    miss — unplaced object, no such room, room not viewable, or no rendered plan — yields no panel,
    exactly as the sibling extensions degrade.
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

        # The object's facility (its site's SiteGroup/Region) scopes which facility's placements
        # blob is searched and which manifest/blobs the panel reads.
        facility = facility_for_site(getattr(obj, 'site', None))

        # A Rack matches its own placement; a Device prefers a direct placement, else falls back
        # to its rack's (the common case — only the cabinet is drawn on the plan).
        if isinstance(obj, Rack):
            match = placement_for_object('rack', obj.pk, facility=facility)
        else:
            match = placement_for_object('device', obj.pk, rack_pk=obj.rack_id, facility=facility)
        if not match:
            return ''
        floor_key, room_id = match

        # Resolve the placement's room back to a viewable Room — a miss (deleted room, or one the
        # user may not view) shows nothing rather than leaking a room the caller can't otherwise see.
        room = (Room.objects.restrict(request.user, 'view')
                .filter(floor_key=floor_key, room_id=room_id).select_related('location').first())
        if not room:
            return ''
        return self._panel(floor_key, [room], crop_to=room, user=request.user, title='Facility Map',
                           facility=facility)


class SiteFloors(PluginTemplateExtension):
    """Embed a building's floor picker on its NetBox `dcim.Site` page.

    Here a Site *is* one building, so this mirrors the SPA's building view
    (`App.renderBuilding`): a grid of floor cards — thumbnail, label, a room-count badge and a
    sheet-count badge — one per rendered floor of the building(s) whose manifest `siteSlug`
    matches `site.slug`. Each card links to that floor's NetBox Location page (the Location
    whose `slug` is the floor id), keeping the user in NetBox where `FloorRooms` then draws the
    plan. The manifest is a runtime render artifact, so a missing/unreadable manifest (or a
    Site with no matching rendered building) yields no panel rather than an empty grid.
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

        # This Site's facility (its SiteGroup/Region) scopes the manifest + media it reads.
        facility = facility_for_site(site)
        manifest = read_manifest(facility)
        if manifest is None:
            return ''

        # `siteSlug` could in principle repeat across `dir`s, so filter rather than assume one.
        buildings = [b for b in manifest.get('buildings', [])
                     if b.get('siteSlug') == site.slug]
        if not buildings:
            return ''

        # Floor Locations under this Site, keyed by slug (== floor id), for the card links.
        locs = {l.slug: l for l in
                Location.objects.restrict(request.user, 'view').filter(site=site)}

        # Room counts for every floor card in ONE grouped query rather than a COUNT per card
        # (F floors → F queries on every Site page load). `.restrict(user,'view')` keeps the
        # counts object-permission scoped, exactly as the old per-card count did; floors with
        # no rooms simply don't appear in the result and fall back to 0 below.
        floor_keys = [f"{site.slug}/{floor['id']}"
                      for building in buildings
                      for floor in building.get('floors', [])]
        room_counts = {r['floor_key']: r['n'] for r in
                       Room.objects.restrict(request.user, 'view')
                       .filter(floor_key__in=floor_keys)
                       .values('floor_key').annotate(n=Count('id'))}

        built = manifest.get('built')
        cards = []
        for building in buildings:
            for floor in building.get('floors', []):
                loc = locs.get(floor['id'])
                rooms = room_counts.get(f"{site.slug}/{floor['id']}", 0)
                cards.append({
                    # Card-sized `thumb` when the manifest has one (builds since 1.44.0);
                    # fall back to the full-res plan for older manifests.
                    'image': media_url(floor.get('thumb') or floor.get('image'), facility, built),
                    'label': floor.get('label') or floor['id'],
                    'url': loc.get_absolute_url() if loc else '',
                    'rooms': rooms,
                    'sheets': len(floor.get('pages') or []),
                })
        if not cards:
            return ''

        return self.render('netbox_facilitymap/site_floors.html',
                           extra_context={'cards': cards})


# The core extensions, plus any contributed by an enabled optional capability (the add-on
# framework, ADDON-2): a capability that overlays its own panel on a NetBox page adds its
# `PluginTemplateExtension`s via `template_extensions()` rather than editing this list. Empty until
# a feature capability ships one.
template_extensions = [FloorRooms, SiteFloors, ObjectPlacement] + capabilities.all_template_extensions()
