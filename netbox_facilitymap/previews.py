"""Server-side helpers for the native room/Location previews.

`FloorRooms` (`template_content.py`) draws a floor's plan image with room polygons
overlaid, and also the rack/device placement markers the editor stored. `floor_sheets`
resolves the floor's tiled sheet geometry (so the whole multi-sheet plan renders, not just
sheet 1), and `placement_markers`/`room_viewbox` build the marker geometry and room-page
crop box — keeping the templates arithmetic-free. `placement_for_object` is the reverse of
`placement_markers`: it finds *where a given rack/device sits* (floor + room), powering the
"show on map" panel on `dcim.device`/`dcim.rack` pages.

Markers are an **MVP**: a styled box per placement (rack vs device), mirroring the geometry
of `FloorEditor.drawPlacements` (`static/.../floor-editor.js`) but *not* the schematic
glyphs from `DeviceShapes` — those live only in JS. Coordinates are normalized 0..1 over the
floor's *combined* canvas (the tiled grid of sheets); callers scale them by the combined
`w`×`h` that `floor_sheets` returns.
"""

import math

from dcim.models import Device, Rack

from .models import FacilityMapBlob
from .storage import media_url, read_manifest

# Wayfinding-arrow defaults, mirrored from the editor's JS constants (`lib.js`): the head
# size (`ARROW_HEAD_PX`, lib.js:27) and the first palette colour used when an arrow has no
# `color` (`ARROW_COLORS[0]`, lib.js:23). Server-side rendering of the room-page embed
# (`room_arrows`) reproduces that geometry, so keep these in step with the JS source.
ARROW_HEAD_PX = 15
ARROW_DEFAULT_COLOR = '#066fd1'

# Default marker footprint (display px) when a placement has no user-set w/h. We don't
# resolve the per-type glyph server-side, so two defaults suffice — a tall rack cabinet vs a
# wider device box (mirrors `DeviceShapes.box` 'rack' and the generic device sizes).
_RACK_BOX = (30, 40)
_DEVICE_BOX = (34, 22)

# Room-embed crop zoom (how much surrounding floor the cropped per-room embed pulls in):
# 1.0 = tight pad-only crop, higher = wider. Editable in-app via the Settings page; these
# bound it on both write (the Settings view) and read (`RoomEmbedSettings.zoom`), the single source
# of truth for the range. `room_viewbox`'s own default param mirrors `ZOOM_DEFAULT`.
ZOOM_MIN = 1.0
ZOOM_MAX = 5.0
ZOOM_DEFAULT = 2.0

# Minimum crop span as a fraction of the floor on each axis. The zoom-scaled crop is a
# *proportion* of the room's own bbox, so a tiny room's crop stays absolutely small and its
# surrounding "context" all falls inside a neighbour's blank interior — no neighbouring rooms
# are visible however hard we zoom. This floors the crop to a minimum absolute span so a tiny
# room still pulls real neighbours into view. Derived from the combined-canvas `w`/`h`, so it
# stays resolution-independent and correct on multi-sheet floors. A context floor, not a zoom
# override: rooms whose zoom-scaled crop already exceeds it are untouched.
ROOM_MIN_CROP_FRAC = 0.18

# Room-embed footprint: how much of its Location-page column the cropped embed occupies, as a
# percent. Independent of zoom (magnification) — it drives a `max-width` on the template wrapper,
# not the viewBox. Bounded on both write (Settings view) and read (`RoomEmbedSettings.size`).
SIZE_MIN = 40
SIZE_MAX = 100
SIZE_DEFAULT = 100

# Room-embed orientation → box aspect ratio (width / height). "Fill box with map": `room_viewbox`
# reshapes the crop to this ratio so the oriented container fills with real floor (no letterbox),
# and the same ratio is emitted to the template as the wrapper's CSS `aspect-ratio`, so the two
# never drift. `landscape` is a short/wide box, `vertical` a taller one (~today's shape). Keys are
# the only accepted values; `clamp_orientation` rejects anything else on read/write.
ORIENTATION_ASPECT = {'landscape': 16 / 9, 'vertical': 3 / 4}
ORIENTATION_DEFAULT = 'vertical'

# Location fields a Location-mode floor's card label may be drawn from — the allowlist for the
# `floor_label_field` setting (Settings page → the `settings` blob, falling back to the
# `PLUGINS_CONFIG floor_label_field` default; see `views._floor_label_field`). Kept in step with
# the Location fields `frontend_api._trim` exposes, so the wizard's floor-label picker can only
# ever name a fixed, already-public JSON key — never an arbitrary attribute lookup. The canonical
# allowlist lives here (next to its clamp) so `previews.py` never has to import `views.py`.
FLOOR_LABEL_FIELDS = ('name', 'slug', 'description')
FLOOR_LABEL_FIELD_DEFAULT = 'name'


def clamp_zoom(value):
    """Coerce `value` to a float within `[ZOOM_MIN, ZOOM_MAX]`, or `ZOOM_DEFAULT` if it
    isn't a finite number. Shared by the Settings view (write) and `RoomEmbedSettings.zoom`
    (read) so a stored value is sane even if edited outside the form (admin/REST)."""
    try:
        z = float(value)
    except (TypeError, ValueError):
        return ZOOM_DEFAULT
    if z != z:  # NaN
        return ZOOM_DEFAULT
    return min(max(z, ZOOM_MIN), ZOOM_MAX)


def clamp_embed_size(value):
    """Coerce `value` to a float within `[SIZE_MIN, SIZE_MAX]`, or `SIZE_DEFAULT` if it isn't a
    finite number. Shared by the Settings view (write) and `RoomEmbedSettings.size` (read) so a
    stored value is sane even if edited outside the form (admin/REST)."""
    try:
        s = float(value)
    except (TypeError, ValueError):
        return SIZE_DEFAULT
    if s != s:  # NaN
        return SIZE_DEFAULT
    return min(max(s, SIZE_MIN), SIZE_MAX)


def clamp_orientation(value):
    """`value` if it's a recognised orientation, else `ORIENTATION_DEFAULT`. Enum-safe on both
    write and read, mirroring `clamp_zoom`/`clamp_embed_size` for the string-valued setting."""
    return value if value in ORIENTATION_ASPECT else ORIENTATION_DEFAULT


def clamp_floor_label_field(value):
    """`value` if it's a recognised floor-label field, else `FLOOR_LABEL_FIELD_DEFAULT`. Enum-safe
    on both write (the Settings view) and read, mirroring `clamp_orientation` for this string-valued
    setting; `views._floor_label_field` uses it for the `PLUGINS_CONFIG` fallback too."""
    return value if value in FLOOR_LABEL_FIELDS else FLOOR_LABEL_FIELD_DEFAULT


class RoomEmbedSettings:
    """The per-room-embed controls from the single `kind='settings'` blob, loaded once.

    Instantiate once per render — the per-room embed reads all three of `.zoom`/`.size`/
    `.orientation`, and `__init__` queries the shared settings row a single time, so the three
    reads never re-query it (the behaviour the old free-function + threaded-dict dance had to
    arrange by hand). Each property re-clamps its stored value and falls back to the matching
    default when the row, the key, or a sane value is absent — so a blob written before a setting
    existed, or edited outside the form (admin/REST), still reads sane.
    """

    def __init__(self):
        blob = FacilityMapBlob.objects.filter(kind='settings', key='').first()
        self._data = (blob.data if blob else None) or {}

    @property
    def zoom(self):
        """The configured crop zoom, clamped to `[ZOOM_MIN, ZOOM_MAX]` (default `ZOOM_DEFAULT`)."""
        raw = self._data.get('room_embed_zoom')
        return clamp_zoom(raw) if raw is not None else ZOOM_DEFAULT

    @property
    def size(self):
        """The configured footprint percent, clamped to `[SIZE_MIN, SIZE_MAX]` (default `SIZE_DEFAULT`)."""
        raw = self._data.get('room_embed_size')
        return clamp_embed_size(raw) if raw is not None else SIZE_DEFAULT

    @property
    def orientation(self):
        """The configured orientation, one of `ORIENTATION_ASPECT`'s keys (default `ORIENTATION_DEFAULT`)."""
        raw = self._data.get('room_embed_orientation')
        return clamp_orientation(raw) if raw is not None else ORIENTATION_DEFAULT

    @property
    def floor_label_field(self):
        """The configured floor-label Location field, or `None` when this setting is unset.

        Unlike the other three properties, this one returns `None` (not a baked-in default) when the
        key is absent, because `floor_label_field` has a **third** precedence tier below the blob:
        `views._floor_label_field` falls the `None` through to the `PLUGINS_CONFIG floor_label_field`
        default (and only then to `'name'`). A present-but-bogus stored value is still re-clamped to
        `FLOOR_LABEL_FIELD_DEFAULT` here — a value *is* set, so it wins over `PLUGINS_CONFIG`; only a
        truly absent key defers to config."""
        raw = self._data.get('floor_label_field')
        return clamp_floor_label_field(raw) if raw is not None else None


def _manifest_pages(floor_key, facility=''):
    """`([{image, w, h}, ...], built)` — the sheets (one per page, page order) for
    `floor_key` plus the manifest's `built` cache token, or `([], None)` if the rendered
    manifest is missing/unreadable or has no such floor. Reads the given facility's manifest
    (default '' = the default facility). Single-sheet floors still return one page; the
    floor-level `image/w/h` mirror `pages[0]`. Reads the mtime-memoized manifest
    (`storage.read_manifest`) — a rebuild busts the memo, so this stays a runtime render
    artifact without re-parsing the file on every Location page render."""
    manifest = read_manifest(facility)
    if manifest is None:
        return [], None
    built = manifest.get('built')
    for building in manifest.get('buildings', []):
        for floor in building.get('floors', []):
            if f"{building['dir']}/{floor['id']}" == floor_key:
                pages = floor.get('pages') or []
                if pages:
                    return pages, built
                if floor.get('image'):
                    return [{'image': floor['image'],
                             'w': floor.get('w') or 1000, 'h': floor.get('h') or 1000}], built
                return [], built
    return [], None


def floor_sheets(floor_key, facility=''):
    """Tiled sheet geometry for a floor, or `None` when it has no rendered plan.

    Mirrors the frontend `Store.floorLayout` (store.js) + `FloorEditor`'s per-sheet image
    placement (floor-editor.js): each sheet sits in one cell of a uniform grid (cell = max
    sheet `w`×`h`); the saved `layouts` blob gives `[col, row]` per page (default = vertical
    stack), and sheets are drawn at `(col*cellW, row*cellH)` sized `cellW`×`cellH`. Returns
    ``{'sheets': [{'url', 'x', 'y', 'w', 'h'}, ...], 'w': W, 'h': H}`` where `W`×`H` is the
    combined canvas the room/placement coords are normalized over (so callers scale by it,
    not by sheet-1 dims). Sheet `url`s go through `media_url` (authenticated, never public).

    `None` is the "is this Location actually a floor?" gate — callers render nothing rather
    than an empty SVG. Falls back to the `annotations` blob's single page-1 image when the
    manifest is unavailable, preserving the pre-tiling behavior for single-sheet floors.
    """
    pages, built = _manifest_pages(floor_key, facility)
    if not pages:
        blob = FacilityMapBlob.objects.filter(kind='annotations', facility=facility, key='').first()
        floor = ((blob.data or {}).get(floor_key) if blob else None) or {}
        if not floor.get('image'):
            return None
        w, h = floor.get('w') or 1000, floor.get('h') or 1000
        return {'sheets': [{'url': media_url(floor['image'], facility),
                            'x': '0.0', 'y': '0.0', 'w': f'{w:.1f}', 'h': f'{h:.1f}'}],
                'w': w, 'h': h}

    cell_w = max(p['w'] for p in pages)
    cell_h = max(p['h'] for p in pages)
    blob = FacilityMapBlob.objects.filter(kind='layouts', facility=facility, key='').first()
    saved = ((blob.data or {}).get(floor_key) if blob else None) or {}
    grid = saved.get('grid')
    if not (isinstance(grid, list) and len(grid) == len(pages)):
        grid = [[0, i] for i in range(len(pages))]   # default: vertical stack

    sheets, cols, rows = [], 0, 0
    for page, (col, row) in zip(pages, grid):
        cols, rows = max(cols, col + 1), max(rows, row + 1)
        sheets.append({
            'url': media_url(page['image'], facility, built),
            'x': f'{col * cell_w:.1f}',
            'y': f'{row * cell_h:.1f}',
            'w': f'{cell_w:.1f}',
            'h': f'{cell_h:.1f}',
        })
    return {'sheets': sheets, 'w': cols * cell_w, 'h': rows * cell_h}


def placement_markers(floor_key, w, h, room_ids, user, facility=''):
    """Marker dicts for the placements on `floor_key` whose room is in `room_ids`.

    `room_ids` (a set/iterable of `Room.room_id` strings) both selects which rooms' markers
    to draw and object-permission-scopes the result — callers pass only rooms the user may
    view. Each returned dict is pre-computed for direct template rendering: a `transform`
    that centers + rotates the marker, the centered rect attrs, the label, a baseline `y`
    for the label below the box, and a `url` linking to the rack/device's NetBox detail page.

    The `url` is itself permission-scoped to `user`: each placement stores the NetBox PK
    (`id`) and `kind` of the rack/device it represents, so we bulk-resolve those PKs through
    `Rack/Device.objects.restrict(user, 'view')` and take each object's `get_absolute_url()`
    (which sidesteps url-name drift across the supported NetBox span). A placement whose
    object was deleted since the last sync, or which the user may not view, gets `url=''` —
    rendered as a plain box, not a dead link.
    """
    room_ids = set(room_ids)
    if not room_ids:
        return []
    blob = FacilityMapBlob.objects.filter(kind='placements', facility=facility, key='').first()
    placements = (((blob.data or {}).get(floor_key) if blob else None) or {}).get('placements') or []

    selected = [p for p in placements if p.get('room') in room_ids]

    # Bulk-resolve a permission-scoped detail URL per referenced rack/device (two queries,
    # not one per marker). A PK missing from the map (deleted/forbidden) yields no link.
    rack_ids = {p['id'] for p in selected if p.get('kind') == 'rack' and p.get('id') is not None}
    device_ids = {p['id'] for p in selected if p.get('kind') != 'rack' and p.get('id') is not None}
    rack_urls = {r.pk: r.get_absolute_url()
                 for r in Rack.objects.restrict(user, 'view').filter(pk__in=rack_ids)} if rack_ids else {}
    device_urls = {d.pk: d.get_absolute_url()
                   for d in Device.objects.restrict(user, 'view').filter(pk__in=device_ids)} if device_ids else {}

    markers = []
    for p in selected:
        is_rack = p.get('kind') == 'rack'
        dw, dh = _RACK_BOX if is_rack else _DEVICE_BOX
        wpx = p['w'] * w if p.get('w') is not None else dw
        hpx = p['h'] * h if p.get('h') is not None else dh
        markers.append({
            'transform': f"translate({p.get('x', 0) * w:.1f},{p.get('y', 0) * h:.1f}) "
                         f"rotate({p.get('rot') or 0})",
            'x': f'{-wpx / 2:.1f}',
            'y': f'{-hpx / 2:.1f}',
            'w': f'{wpx:.1f}',
            'h': f'{hpx:.1f}',
            'label': p.get('label') or '',
            'label_y': f'{hpx / 2 + 12:.1f}',
            'is_rack': is_rack,
            'url': (rack_urls if is_rack else device_urls).get(p.get('id'), ''),
        })
    return markers


def placement_for_object(obj_kind, obj_pk, rack_pk=None, facility=''):
    """The `(floor_key, room_id)` of the placement representing a rack/device, or `None`.

    The reverse of `placement_markers`: given a NetBox object (from its detail page), find where
    it sits on the map. Loads the single `kind='placements'` blob once and scans every floor's
    `placements[]` in memory (one blob holds all floors — mirroring `placement_markers`; never
    re-query per floor). Only placements that carry a `room` are eligible — a roomless placement
    can't drive the cropped room embed.

    - `obj_kind == 'rack'`: match `kind == 'rack'` and `id == obj_pk`.
    - otherwise (a device): **prefer** a *direct* device placement (`kind != 'rack'` and
      `id == obj_pk`); failing that, when `rack_pk` is given (the device is racked), fall back to
      its rack's placement (`kind == 'rack'` and `id == rack_pk`) — the common DC case where only
      the cabinet is placed on the plan.

    First match wins (the data model allows an object in several placements). Returns the winning
    placement's `floor_key` and frontend `room_id` (verbatim as `Room.room_id`), for the caller to
    resolve + permission-scope into a `Room`; `None` when the object isn't placed anywhere. The
    object's own facility (resolved by the caller from its site) scopes which placements blob is
    searched.
    """
    blob = FacilityMapBlob.objects.filter(kind='placements', facility=facility, key='').first()
    data = (blob.data if blob else None) or {}

    rack_fallback = None
    for floor_key, floor in data.items():
        for p in ((floor or {}).get('placements') or []):
            room = p.get('room')
            if not room:
                continue
            kind, pid = p.get('kind'), p.get('id')
            if obj_kind == 'rack':
                if kind == 'rack' and pid == obj_pk:
                    return floor_key, room
            else:
                if kind != 'rack' and pid == obj_pk:
                    return floor_key, room   # direct device placement — preferred
                if (rack_fallback is None and rack_pk is not None
                        and kind == 'rack' and pid == rack_pk):
                    rack_fallback = (floor_key, room)
    return rack_fallback


def room_viewbox(polygon, w, h, pad=0.08, zoom=ZOOM_DEFAULT, aspect=None):
    """SVG `viewBox` string cropping a single room's polygon, or None if it has no points.

    Bounding box of the normalized polygon scaled by `w`×`h`, padded by `pad` of the larger
    side (with a small px floor so a tiny room still gets margin), then the whole box is
    scaled about the room's centre by `zoom` to pull surrounding floor into view — `zoom=1`
    is the tight pad-only crop; the default `2` doubles each visible side (~4× the area). The
    zoom-scaled box is a *proportion* of the room, so it's floored to `ROOM_MIN_CROP_FRAC` of
    the floor on each axis: a tiny room's crop would otherwise stay absolutely small and show
    only blank floor, never a neighbouring room.

    When `aspect` (a width/height ratio, e.g. from the embed's orientation setting) is given,
    the box is then reshaped to that ratio by *growing* its shorter axis — never shrinking, so
    the room's padded bbox always stays inside the box (fully visible). This lets the template's
    fixed-aspect container fill with real floor under `preserveAspectRatio="…meet"` instead of
    letterboxing. Zoom is unaffected: it still sets the base span; aspect only reshapes it.

    The box is finally clamped to the floor's `0..w`×`0..h` extent so a room near an edge shows
    real floor rather than blank space past the image (a box larger than the floor on an axis
    just falls back to that axis's full extent — which, at the extreme, can leave the container
    a slight `meet` letterbox when the floor itself can't supply the requested aspect). Returned
    as "minx miny width height"; the caller falls back to the full floor view on None.
    """
    if not polygon:
        return None
    xs = [x * w for x, _ in polygon]
    ys = [y * h for _, y in polygon]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    margin = max(max((maxx - minx), (maxy - miny)) * pad, 8)
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
    # Zoom-scale about the centre, floor to a minimum absolute span (so tiny rooms show
    # context), then clamp to the floor's extent.
    bw = min(max(((maxx - minx) + 2 * margin) * zoom, w * ROOM_MIN_CROP_FRAC), w)
    bh = min(max(((maxy - miny) + 2 * margin) * zoom, h * ROOM_MIN_CROP_FRAC), h)
    # Grow the shorter axis to the target orientation aspect (never shrink), then re-clamp to
    # the floor so the reshape can't push the box past the image.
    if aspect:
        if bw / bh < aspect:
            bw = min(bh * aspect, w)
        else:
            bh = min(bw / aspect, h)
    bx = min(max(cx - bw / 2, 0), w - bw)
    by = min(max(cy - bh / 2, 0), h - bh)
    return f'{bx:.1f} {by:.1f} {bw:.1f} {bh:.1f}'


def room_arrows(floor_key, room_id, w, h, head_px=ARROW_HEAD_PX, facility=''):
    """Render-ready geometry for the wayfinding arrows whose destination is `room_id`.

    Reads the given facility's `kind='annotations'` blob `data[floor_key]['arrows']` and keeps only the
    arrows the editor auto-bound to this room (`a['room'] == room_id`, the frontend room id
    persisted verbatim as `Room.room_id`). For the per-room embed only — the caller passes
    `crop_to.room_id`, so the result is already permission-scoped to a room the user may view.

    Each returned dict — `{'line', 'head', 'color'}` — mirrors `FloorEditor._drawArrows`
    (`static/.../floor-editor.js`) over the combined-canvas `w`×`h` (so it lines up with the
    rooms/spotlight): the visible polyline is pulled back `head_px` from the last point toward
    the previous one (round cap can't poke past the tip), and the head is the same triangle as
    `Geom.arrowHead` (`lib.js:127`, base centre behind the tip, half-width `head_px*0.55`).

    `head_px` is a size in the *combined-canvas* units the coords scale to. The editor's fixed
    `ARROW_HEAD_PX` reads magnified under the zoomed room crop, so the caller sizes the head
    relative to the crop's viewBox to keep it a stable on-screen size across `room_embed_zoom`.
    Arrows with fewer than 2 points are skipped (matches `_drawArrows`).
    """
    blob = FacilityMapBlob.objects.filter(kind='annotations', facility=facility, key='').first()
    floor = ((blob.data or {}).get(floor_key) if blob else None) or {}
    arrows = []
    for a in (floor.get('arrows') or []):
        if a.get('room') != room_id:
            continue
        pts = a.get('points') or []
        if len(pts) < 2:
            continue
        scaled = [(x * w, y * h) for x, y in pts]
        (p0x, p0y), (p1x, p1y) = scaled[-2], scaled[-1]
        dx, dy = p1x - p0x, p1y - p0y
        length = math.hypot(dx, dy) or 1
        ux, uy = dx / length, dy / length

        # Line ends at the head's base centre (pulled back along the final segment, clamped
        # so a short last hop can't flip the end past the previous point).
        pull = min(head_px, length)
        end = (p1x - ux * pull, p1y - uy * pull)
        line_pts = scaled[:-1] + [end]

        # Arrowhead triangle: tip at the last point, base centre `head_px` behind it.
        bcx, bcy = p1x - ux * head_px, p1y - uy * head_px
        px, py = -uy, ux
        half = head_px * 0.55
        head = [(p1x, p1y), (bcx + px * half, bcy + py * half), (bcx - px * half, bcy - py * half)]

        arrows.append({
            'line': ' '.join(f'{x:.1f},{y:.1f}' for x, y in line_pts),
            'head': ' '.join(f'{x:.1f},{y:.1f}' for x, y in head),
            'color': a.get('color') or ARROW_DEFAULT_COLOR,
        })
    return arrows
