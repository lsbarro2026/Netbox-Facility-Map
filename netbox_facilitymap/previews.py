"""Server-side helpers for the native room/Location previews.

`FloorRooms` (`template_content.py`) draws a floor's plan image with room polygons
overlaid, and also the rack/device placement markers the editor stored. `floor_sheets`
resolves the floor's tiled sheet geometry (so the whole multi-sheet plan renders, not just
sheet 1), and `placement_markers`/`room_viewbox` build the marker geometry and room-page
crop box — keeping the templates arithmetic-free. `placement_for_object` is the reverse of
`placement_markers`: it finds *where a given rack/device sits* (floor + room + its own marker
position), powering the device-centred "show on map" panel on `dcim.device`/`dcim.rack` pages.

Markers render each placement's schematic **glyph** (an access point's broadcast puck, a
switch's port row, …) via `device_shapes.DeviceShapes` — the Python mirror of the frontend
`DeviceShapes` — so an embed/export matches the live map instead of drawing every device as
a plain box. `placement_markers` classifies each placement to a glyph type (off its NetBox
role, mirroring `FloorEditor._drawPlacement`) and maps the glyph's semantic primitive classes
to inline paint (the host page loads no plugin CSS). Coordinates are normalized 0..1 over the
floor's *combined* canvas (the tiled grid of sheets); callers scale them by the combined
`w`×`h` that `floor_sheets` returns.
"""

import math
import re

from dcim.models import Device, Rack

from .device_shapes import DeviceShapes
from .models import FacilityMapBlob
from .storage import media_url, read_manifest

# Wayfinding-arrow defaults, mirrored from the editor's JS constants (`lib.js`): the head
# size (`ARROW_HEAD_PX`, lib.js:27) and the first palette colour used when an arrow has no
# `color` (`ARROW_COLORS[0]`, lib.js:23). Server-side rendering of the room-page embed
# (`room_arrows`) reproduces that geometry, so keep these in step with the JS source.
ARROW_HEAD_PX = 15
ARROW_DEFAULT_COLOR = '#066fd1'

# Inline paint for a glyph's semantic primitive classes (the frontend `dev-*` classes live in
# `style.css`, but the NetBox host page loads no plugin CSS, so the embed must inline them). Kept
# in step with `style.css`'s `.rack-marker .dev-*` rules and the theme vars they use: `dev-body`
# fill is `--accent` for a rack, `--text2` for a device; detail lines/ports are white, LEDs
# `--success`. Stroked primitives get `non-scaling-stroke` (a zoom-constant stroke) exactly like
# the frontend, so the glyph reads at a stable weight however the embed SVG is scaled.
_GLYPH_STYLE = {
    'dev-line': 'fill:none;stroke:#fff;stroke-width:1;stroke-linecap:round',
    'dev-port': 'fill:#fff;stroke:none',
    'dev-led': 'fill:#2fa84f;stroke:none',
}
_BODY_STYLE = {
    True:  'fill:#066fd1;stroke:#fff;stroke-width:1.5',   # rack cabinet (--accent)
    False: 'fill:#3d4654;stroke:#fff;stroke-width:1.5',   # device body (--text2)
}

# Room-embed crop zoom (how much surrounding floor the cropped per-room embed pulls in):
# 1.0 = tight pad-only crop, higher = wider. Editable in-app via the Settings page; these
# bound it on both write (the Settings view) and read (`PluginSettings.zoom`), the single source
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

# Device-embed crop span, as a fraction of the crop region (the room's sheet cell, or the whole
# canvas) on each axis. The device/rack page's embed (`template_content.ObjectPlacement`) centres on
# the device's **own marker** — not the room centroid the room-page embed uses — and crops this
# tight: a small, absolute span (a fraction of the region, so it's resolution- **and** room-size-
# independent), so the glyph + its name label read legibly even in a large room where the room-page
# framing would shrink them to nothing (SHOW-3). Capped to the room's own padded bbox so a corner
# device never frames across into a neighbour, and deliberately independent of the room embed's
# `room_embed_zoom` (which stays right for room pages — cranking it would over-zoom those). Fed to
# `room_viewbox` as its `focus`-path span; room-centred embeds (`focus=None`) never use it.
DEVICE_EMBED_CROP_FRAC = 0.25

# Room-embed footprint: how much of its Location-page column the cropped embed occupies, as a
# percent. Independent of zoom (magnification) — it drives a `max-width` on the template wrapper,
# not the viewBox. Bounded on both write (Settings view) and read (`PluginSettings.size`).
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

# Access-point tool settings (DEV-3), all keys of the single install-wide `settings` blob.
#
# `ap_name_template` is expanded into a suggested `dcim.Device` name when an AP is placed. Only
# these four placeholders are recognised, and the save path rejects any other `{token}` outright
# (`AP_TEMPLATE_TOKEN_RE`) rather than letting it through as a literal — a template is operator
# input that must fail loudly, not silently produce `{typo}` in every device name:
#   {room}        the room Location's name
#   {room_slug}   the same room Location's native `slug` (URL-safe, unlike the free-text name)
#   {role_short}  the configured AP role's slug, uppercased — its hyphen-separated initials
#                 for a multi-word slug ('access-point' -> 'AP'), the whole word for a
#                 single-word one ('ap' -> 'AP', never 'A')
#   {asset_tag}   the asset tag typed into the AP dialog (DEV-6). Unlike the others this is
#                 not knowable from the room alone — the user types it *after* the suggestion is
#                 first fetched — so it arrives as `NbDeviceSuggestNameView`'s optional
#                 `asset_tag=` param and the browser re-asks as the field changes. The column is
#                 optional (blank stores NULL), so a blank tag drops the token *and one adjacent
#                 separator* rather than expanding to '' and leaving `AP--01` (see
#                 `expand_ap_name_template`).
# There is deliberately no `{count}` token: an AP is never racked and the counter is scoped, so
# the count is appended by the naming logic (DEV-5) per `ap_count_scope`, not typed by the user.
AP_NAME_PLACEHOLDERS = ('room', 'room_slug', 'role_short', 'asset_tag')
AP_NAME_TEMPLATE_DEFAULT = '{room}-{role_short}'
# `dcim.Device.name` is 64 chars; a template longer than that can only ever expand to a name
# `full_clean()` rejects, so refuse it at the source where the message can name the field.
AP_NAME_TEMPLATE_MAX = 64

# How far the suggested name's `-NN` counter is scoped before it resets. The two building-anchor
# scopes are distinct concepts (MODEL-3, BUILDING-ANCHOR-DESIGN §4.3): 'building' counts within the
# building anchor's Location descendants (degenerating to the Site when the building *is* the Site);
# 'site' counts across the whole `dcim.Site` — one building for a Site-anchored install, the whole
# campus for a Site = campus install. Neither is facility-wide (the SiteGroup/Region a siteplan
# covers). The free-name probe stays Site-wide regardless (that is the domain `dcim.Device`'s
# uniqueness constraint spans); don't conflate the counter scope with the probe scope.
AP_COUNT_SCOPES = ('none', 'room', 'floor', 'building', 'site')
AP_COUNT_SCOPE_DEFAULT = 'none'


def clamp_zoom(value):
    """Coerce `value` to a float within `[ZOOM_MIN, ZOOM_MAX]`, or `ZOOM_DEFAULT` if it
    isn't a finite number. Shared by the Settings view (write) and `PluginSettings.zoom`
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
    finite number. Shared by the Settings view (write) and `PluginSettings.size` (read) so a
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


def write_mode_enabled(settings=None):
    """True when the operator has switched **write mode** on (LOC-2) — the runtime replacement for
    the old install-wide `allow_location_create` `PLUGINS_CONFIG` flag. Read from the single
    `kind='settings'` blob's `write_mode` key (default `False` when the row or key is absent), so the
    Settings-page toggle takes effect without a worker restart.

    Write mode is the install-wide **master gate on everything this plugin writes into NetBox core**
    and nothing more (SET-5): every write path checks it *plus* its own feature switch *plus* the
    matching per-user `dcim.add_*` permission. Inline Location creation answers to
    `inline_room_creation_enabled()` below (`frontend_api.NbLocationCreateView`), the AP tool to
    `ap_tool_enabled()` (`frontend_api._ap_write_gate`). The browser mirrors this via
    `window.MAP.writeMode`, which is UX only — each endpoint re-checks it here.

    Lives beside the other settings-blob resolvers (both `views` and `frontend_api` import
    `previews`, avoiding a view↔api import cycle). A convenience wrapper for callers that need
    this one setting; pass an existing `PluginSettings` to reuse its single settings-row query,
    and a caller reading several settings should build one instance and thread it through these
    wrappers rather than letting each issue its own query."""
    return (settings or PluginSettings()).write_mode


def inline_room_creation_enabled(settings=None):
    """True when the **inline room creation** write add-on is switched on (SET-5) — the feature
    switch that lets a permitted user create a room's NetBox Location from the floor bind panel.
    Read from the single `kind='settings'` blob's `inline_room_creation` key, so the Settings-page
    toggle takes effect without a worker restart.

    Alone it grants nothing: `NbLocationCreateView` checks this **and** `write_mode_enabled()` (the
    master gate) **and** the per-user `dcim.add_location` permission. The browser mirrors it via
    `window.MAP.inlineRoomCreation`.

    **Defaults to on when the key is absent**, unlike its `write_mode`/`ap_tool` siblings, and that
    asymmetry is deliberate. Before SET-5 write mode *was* this switch, so an install upgrading with
    write mode on would silently lose its create tile if a missing key read as off. Defaulting on
    makes the pre-SET-5 behaviour the exact behaviour an upgrader keeps — and it exposes nothing new,
    because write mode is itself off by default and gates this. A fresh install therefore reaches the
    same place as before: turn write mode on, and inline creation is available to users holding
    `dcim.add_location`.

    Takes an optional `PluginSettings` to reuse, like every wrapper here."""
    return (settings or PluginSettings()).inline_room_creation


def clamp_ap_count_scope(value):
    """`value` if it's a recognised AP name-counter scope, else `AP_COUNT_SCOPE_DEFAULT`. Enum-safe
    on both write (the Settings view) and read, mirroring `clamp_floor_label_field`."""
    return value if value in AP_COUNT_SCOPES else AP_COUNT_SCOPE_DEFAULT


def clamp_ap_device_role(value):
    """The configured AP `dcim.DeviceRole` id as an int, or `None` when unset/unusable. Enum-safe
    on read like the sibling clamps: a blob hand-edited (admin/REST) to a non-numeric or negative
    role id reads back as "unconfigured" — which the callers already handle — rather than blowing
    up a page render. It does **not** check that the role still exists: a deleted role is a live
    ORM question for the caller, not something a clamp can settle."""
    try:
        role = int(value)
    except (TypeError, ValueError):
        return None
    return role if role > 0 else None


# Any `{...}` run in a name template. Used to pick out the placeholders an operator actually typed
# so an unrecognised one can be refused, and (via `.sub`) to spot stray unbalanced braces.
AP_TEMPLATE_TOKEN_RE = re.compile(r'\{([^{}]*)\}')


def clean_ap_name_template(value):
    """Validate an operator-supplied AP name template, returning it stripped (an empty one resets to
    `AP_NAME_TEMPLATE_DEFAULT`). Raises `ValueError` carrying a user-facing message when the template
    is too long, names a placeholder outside `AP_NAME_PLACEHOLDERS`, or has unbalanced braces.

    Unlike its sibling `clamp_*` helpers this **raises rather than clamps**, because there is no
    sensible "nearest valid value" for a typo'd template: silently dropping `{rack}` (or clamping to
    the default) would quietly rename every AP an operator subsequently creates, and the mistake
    would only surface as wrong data in NetBox. So the write path 400s with the reason, and the
    read path (`ap_settings`) falls back to the default only for a *stored* value that somehow got
    past it (hand-edited blob), where raising would break an unrelated page render."""
    template = (value or '').strip()
    if not template:
        return AP_NAME_TEMPLATE_DEFAULT
    if len(template) > AP_NAME_TEMPLATE_MAX:
        raise ValueError('a name template may be at most %d characters (dcim.Device.name’s limit)'
                         % AP_NAME_TEMPLATE_MAX)
    unknown = [t for t in AP_TEMPLATE_TOKEN_RE.findall(template)
               if t not in AP_NAME_PLACEHOLDERS]
    if unknown:
        raise ValueError('unknown placeholder%s %s — this template accepts only %s'
                         % ('' if len(unknown) == 1 else 's',
                            ', '.join('{%s}' % t for t in unknown),
                            ', '.join('{%s}' % p for p in AP_NAME_PLACEHOLDERS)))
    residue = AP_TEMPLATE_TOKEN_RE.sub('', template)
    if '{' in residue or '}' in residue:
        raise ValueError('unbalanced { } in the name template')
    return template


# `{asset_tag}` plus one adjacent separator, preferring the one *before* it and falling back to the
# one after, so the token closes up cleanly wherever it sits in a template. Only used for a blank
# tag — see `expand_ap_name_template`.
_AP_ASSET_TAG_BLANK_RE = re.compile(r'[-_. ]\{asset_tag\}|\{asset_tag\}[-_. ]?')


def expand_ap_name_template(template, room_name, room_slug, role_short, asset_tag=''):
    """Expand a validated AP name template into the suggested `dcim.Device` name's **base** — what
    `NbDeviceSuggestNameView` then suffixes with its scoped `-NN` counter.

    Lives here, beside the placeholder list it expands and the validator that guards it, so the two
    halves of the contract can't drift apart (`frontend_api` imports `previews`, never the reverse).

    A blank `asset_tag` **drops the token together with one adjacent separator** instead of
    expanding to `''`: the column is optional, and an empty expansion would leave a dangling
    separator (`Room 101-AP--01`) on every AP an operator declines to tag. `{asset_tag}` is
    substituted **last** so an operator-typed tag value that happens to contain `{room}` is treated
    as the literal text it is, never re-expanded."""
    tag = (asset_tag or '').strip()
    if not tag:
        template = _AP_ASSET_TAG_BLANK_RE.sub('', template)
    return (template.replace('{room}', room_name)
                    .replace('{room_slug}', room_slug)
                    .replace('{role_short}', role_short)
                    .replace('{asset_tag}', tag))


def ap_tool_enabled(settings=None):
    """True when the operator has switched the **access-point tool** on (DEV-3). Read from the single
    `kind='settings'` blob's `ap_tool` key (default `False` when the row or key is absent), so the
    Settings-page toggle takes effect without a worker restart.

    This is the AP feature's *own* install-wide switch, stored **separately from write mode**: it
    answers "is this feature in play?", where write mode answers "may this install write to NetBox at
    all?". Both gates must pass for an AP to be created — the Device-create endpoint (DEV-5) checks
    this **and** `write_mode_enabled()` **and** the per-user `dcim.add_device` permission — and the
    browser mirrors this one via `window.MAP.apTool`. Sits beside `write_mode_enabled`/
    `inline_room_creation_enabled`, the write add-on switches whose shape it follows (SET-5; the
    Settings page disables all three add-on rows while the master gate is off, so this value only
    ever changes with write mode already on — but it is stored, and re-checked, independently).

    Takes an optional `PluginSettings` to reuse, like every wrapper here."""
    return (settings or PluginSettings()).ap_tool


def todos_enabled(settings=None):
    """True when the operator has switched the **to-do feature** on (ADDON-4). Read from the single
    `kind='settings'` blob's `todos` key (default `False` when the row or key is absent), so the
    Settings-page toggle takes effect without a worker restart. Sits beside `ap_tool_enabled`, whose
    shape it follows.

    This is the install-wide master gate on the whole in-app to-do feature — the facility-wide and
    per-floor to-do pages, the add-to-do compose icon, and the `api/todos*` read/write endpoints —
    grouped with pure first-party **non-write** add-ons (it writes nothing into NetBox core, unlike
    the `write_mode` family). The browser mirrors it via `window.MAP.todos`; every to-do endpoint
    re-checks it server-side (`frontend_api.TodoFeatureGateMixin`), so the client hide is UX only.

    Defaults **off** like `ap_tool`/`write_mode` (not on like `inline_room_creation_enabled`, whose
    asymmetry is a deliberate back-compat exception this must not copy) — the core ships without the
    feature and the operator, or a future setup wizard, turns it on. Being a plain install-wide
    boolean in the settings blob is what keeps it wizard-settable the same way the toggle sets it.

    Takes an optional `PluginSettings` to reuse, like every wrapper here."""
    return (settings or PluginSettings()).todos


def render_hq_enabled(settings=None):
    """True when the operator has switched **high-quality floor-plan rendering** on (READ-1). Read
    from the single `kind='settings'` blob's `render_hq` key (default `False` when the row or key is
    absent), so the Settings-page toggle takes effect without a worker restart. Sits beside
    `ap_tool_enabled`, whose shape it follows.

    Unlike the other switches this one changes nothing until the **next import/rebuild**: it is read
    by `imports.RenderRunner` when it spawns a build, and already-rendered floor images keep serving
    (the manifest stores filenames + per-sheet pixel dims, so only a rebuild re-renders).

    Takes an optional `PluginSettings` to reuse, like every wrapper here — and `RenderRunner.run`
    resolves it **once** per run rather than per decision that depends on it."""
    return (settings or PluginSettings()).render_hq


def ap_settings(settings=None):
    """The access-point tool's configuration from the single `kind='settings'` blob, resolved and
    clamped in one read: `{'enabled': bool, 'device_role': int|None, 'name_template': str,
    'count_scope': str}`.

    Every value is clamped on the way out, so a key missing from an older blob (back-compatible
    exactly like `room_embed_*`/`facility_grouping` were) or hand-edited outside the Settings page
    still resolves to something usable. Callers: `views.MapView` (stamping `window.MAP`) and
    `frontend_api._ap_write_gate`, which passes it on to the name-suggestion/Device-create endpoints
    it guards (DEV-5) so they gate and expand a name off a single settings read.

    Takes an optional `PluginSettings` to reuse, like every wrapper here."""
    return (settings or PluginSettings()).ap


class PluginSettings:
    """Every value in the single install-wide `settings` blob, read in one query.

    The **one** place that knows how the settings row is fetched and how each stored value is
    clamped on the way out. Instantiate once per render and read as many properties as you need —
    `__init__` queries the row a single time, so a caller reading five settings costs one query
    instead of five (the behaviour the old free-function + threaded-dict dance had to arrange by
    hand). Each property re-clamps its stored value and falls back to the matching default when the
    row, the key, or a sane value is absent — so a blob written before a setting existed, or edited
    outside the form (admin/REST), still reads sane.

    The convenience wrappers below/above (`write_mode_enabled`, `todos_enabled`, `ap_settings`, …)
    each delegate to one property here and document what the setting *means*; this class documents
    only how it is stored and defaulted. Each of them takes an optional instance, so a caller
    holding one threads it through rather than paying a query per wrapper call — the shape
    `views.MapView.get_context_data` and `RenderRunner.run` use.

    It is the settings-row reader for the **whole** plugin, `facilities` included: that module's
    three settings (`facility_grouping`, `facility_org_modes`, `default_facility`) read through
    `get` below and clamp on their own side, since their vocabularies live there.

    **Deliberately not cached across requests.** Every one of those wrappers promises its toggle
    "takes effect without a worker restart" — which holds only if the gunicorn workers, the
    `netbox-rq` workers and the render subprocess all see a write immediately. A process-local
    cache would break that silently (the write lands in worker A while worker B keeps serving the
    old value), and NetBox's `CACHES` backend isn't guaranteed to be shared, so the failure would
    be invisible. Loading once per *instance* collapses the N+1 without any staleness surface;
    don't "optimise" it into a cache.

    The row is install-wide (MULTI-1), so it is addressed by its full key — `facility=''` included,
    matching `facilities.grouping`/`default_facility` — never by a loose `kind`/`key` match.
    """

    def __init__(self):
        blob = FacilityMapBlob.objects.filter(kind='settings', facility='', key='').first()
        self._data = (blob.data if blob else None) or {}

    def get(self, key, default=None):
        """One **raw** stored value, unclamped — the escape hatch for the three settings whose
        clamp cannot live in this class: `facility_grouping`, `facility_org_modes` and
        `default_facility` are clamped against vocabularies (`GROUPING_CHOICES`,
        `ORG_MODE_CHOICES`) and a reachability check that live in `facilities`, which imports
        *this* module — so moving those clamps here would be an import cycle. `facilities.grouping`
        /`org_modes`/`default_facility` therefore keep their own clamps and take an instance of this
        class to read through, which is what makes the settings row a single query per request
        across both modules. Every setting whose clamp *can* live here gets a property instead;
        don't reach for this to bypass one."""
        return self._data.get(key, default)

    @property
    def write_mode(self):
        """True when write mode — the master gate on NetBox core writes — is on (`write_mode_enabled`)."""
        return bool(self._data.get('write_mode'))

    @property
    def inline_room_creation(self):
        """True when the inline room-creation add-on is on (`inline_room_creation_enabled`).

        Absent reads as **on**, unlike its `write_mode`/`ap_tool` siblings — the deliberate
        pre-SET-5 back-compat exception documented on the wrapper. A stored `False` is never
        mistaken for "not configured", since the endpoint only ever writes the key explicitly."""
        return bool(self._data.get('inline_room_creation', True))

    @property
    def ap_tool(self):
        """True when the access-point tool's own feature switch is on (`ap_tool_enabled`)."""
        return bool(self._data.get('ap_tool'))

    @property
    def todos(self):
        """True when the to-do feature is on (`todos_enabled`)."""
        return bool(self._data.get('todos'))

    @property
    def render_hq(self):
        """True when high-quality floor-plan rendering is on (`render_hq_enabled`)."""
        return bool(self._data.get('render_hq'))

    @property
    def ap(self):
        """The access-point tool's resolved configuration dict (`ap_settings`)."""
        try:
            template = clean_ap_name_template(self._data.get('ap_name_template'))
        except ValueError:
            # Only reachable for a value written outside the Settings page (admin/REST/fixture); the
            # POST path refuses these. Fall back rather than raise — this runs during a page render.
            template = AP_NAME_TEMPLATE_DEFAULT
        return {
            'enabled': self.ap_tool,
            'device_role': clamp_ap_device_role(self._data.get('ap_device_role')),
            'name_template': template,
            'count_scope': clamp_ap_count_scope(self._data.get('ap_count_scope')),
        }

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


def _floor_shard(kind, facility, floor_key):
    """One floor's stored editor document, or `{}` when absent. The per-floor kinds
    (`annotations`/`placements`/`layouts`) are sharded one row per floor (`key=floor_key`, CONC-1),
    so a single-floor server-rendered preview reads exactly its own row rather than loading the
    whole facility's document and indexing into it."""
    blob = FacilityMapBlob.objects.filter(kind=kind, facility=facility, key=floor_key).first()
    return (blob.data if blob else None) or {}


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
        floor = _floor_shard('annotations', facility, floor_key)
        if not floor.get('image'):
            return None
        w, h = floor.get('w') or 1000, floor.get('h') or 1000
        return {'sheets': [{'url': media_url(floor['image'], facility),
                            'x': '0.0', 'y': '0.0', 'w': f'{w:.1f}', 'h': f'{h:.1f}'}],
                'w': w, 'h': h}

    cell_w = max(p['w'] for p in pages)
    cell_h = max(p['h'] for p in pages)
    saved = _floor_shard('layouts', facility, floor_key)
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
    that centers + rotates the marker, a `glyph` list of styled SVG primitives (the device's
    schematic shape from `DeviceShapes`), the label, a baseline `y` for the label below the
    glyph, and a `url` linking to the rack/device's NetBox detail page.

    The glyph type is keyed off the referenced object like the live map (`DeviceShapes.type_for`):
    a rack is always the cabinet glyph; a device is classified off its NetBox role (name/label
    fallback), so an access point draws its broadcast puck, a switch its port row, etc. The
    `DeviceShapes` primitives carry only their semantic class; the per-class inline paint
    (`_GLYPH_STYLE`/`_BODY_STYLE`) is applied here since the host page loads no plugin CSS.

    The `url` is itself permission-scoped to `user`: each placement stores the NetBox PK
    (`id`) and `kind` of the rack/device it represents, so we bulk-resolve those PKs through
    `Rack/Device.objects.restrict(user, 'view')` and take each object's `get_absolute_url()`
    (which sidesteps url-name drift across the supported NetBox span). The same scoped Device
    rows supply the role/name the glyph classifies on. A placement whose object was deleted
    since the last sync, or which the user may not view, gets `url=''` and is classified off
    its stored label alone — rendered as an unlinked glyph, not a dead link.
    """
    room_ids = set(room_ids)
    if not room_ids:
        return []
    placements = _floor_shard('placements', facility, floor_key).get('placements') or []

    selected = [p for p in placements if p.get('room') in room_ids]

    # Bulk-resolve a permission-scoped rack/device per referenced PK (two queries, not one per
    # marker). Racks only need a detail URL; devices also carry the role/name the glyph classifies
    # on (`select_related('role')`, so no per-device role query). A PK missing from the map
    # (deleted/forbidden) yields no link and classifies off the placement's own label.
    rack_ids = {p['id'] for p in selected if p.get('kind') == 'rack' and p.get('id') is not None}
    device_ids = {p['id'] for p in selected if p.get('kind') != 'rack' and p.get('id') is not None}
    rack_urls = {r.pk: r.get_absolute_url()
                 for r in Rack.objects.restrict(user, 'view').filter(pk__in=rack_ids)} if rack_ids else {}
    devices = {d.pk: d for d in Device.objects.restrict(user, 'view')
               .select_related('role').filter(pk__in=device_ids)} if device_ids else {}

    markers = []
    for p in selected:
        is_rack = p.get('kind') == 'rack'
        if is_rack:
            item, url = None, rack_urls.get(p.get('id'), '')
        else:
            dev = devices.get(p.get('id'))
            item = ({'role_slug': dev.role.slug if dev.role_id else None,
                     'role_name': dev.role.name if dev.role_id else None,
                     'name': dev.name} if dev else None)
            url = dev.get_absolute_url() if dev else ''

        gtype = DeviceShapes.type_for(p, item)
        box = DeviceShapes.box(gtype)
        wpx = p['w'] * w if p.get('w') is not None else box['w']
        hpx = p['h'] * h if p.get('h') is not None else box['h']

        # Map each primitive's semantic class to inline paint (body fill differs rack vs device).
        glyph = []
        for prim in DeviceShapes.glyph(gtype, wpx, hpx):
            style = _BODY_STYLE[is_rack] if prim['cls'] == 'dev-body' else _GLYPH_STYLE[prim['cls']]
            glyph.append({k: v for k, v in prim.items() if k != 'cls'} | {'style': style})

        markers.append({
            'transform': f"translate({p.get('x', 0) * w:.1f},{p.get('y', 0) * h:.1f}) "
                         f"rotate({p.get('rot') or 0})",
            'glyph': glyph,
            'label': p.get('label') or '',
            'label_y': f'{hpx / 2 + 12:.1f}',
            'url': url,
        })
    return markers


def _placement_focus(p):
    """The placement's normalized `(x, y)` marker centre, or `None` when either coord is absent.

    Feeds the device/rack embed's device-centred crop (`room_viewbox`'s `focus`): a placement is
    normally placed on the map so both coords are present, but a hand-edited/legacy row missing
    either falls back to `None` — the caller then frames the room-centred crop as before, never
    crashing on a partial placement."""
    x, y = p.get('x'), p.get('y')
    return (x, y) if x is not None and y is not None else None


def placement_for_object(obj_kind, obj_pk, rack_pk=None, facility=''):
    """The `(floor_key, room_id, focus)` of the placement representing a rack/device, or `None`.

    The reverse of `placement_markers`: given a NetBox object (from its detail page), find where
    it sits on the map. Scans every floor's `placements[]` in memory — one placement row per floor
    now (`key=floor_key`, CONC-1), so it reads the facility's placement rows in one query and walks
    each. Only placements that carry a `room` are eligible — a roomless placement can't drive the
    cropped room embed.

    - `obj_kind == 'rack'`: match `kind == 'rack'` and `id == obj_pk`.
    - otherwise (a device): **prefer** a *direct* device placement (`kind != 'rack'` and
      `id == obj_pk`); failing that, when `rack_pk` is given (the device is racked), fall back to
      its rack's placement (`kind == 'rack'` and `id == rack_pk`) — the common DC case where only
      the cabinet is placed on the plan.

    First match wins (the data model allows an object in several placements). Returns the winning
    placement's `floor_key`, frontend `room_id` (verbatim as `Room.room_id`), and `focus` — the
    placement's own normalized `(x, y)` marker centre (the rack's, when a racked device resolves via
    its cabinet), or `None` for a placement missing either coord. The caller resolves + permission-
    scopes the `room_id` into a `Room` and passes `focus` to `room_viewbox` so the device/rack embed
    frames on the device itself rather than the room centroid (SHOW-3). `None` (the whole result)
    when the object isn't placed anywhere. The object's own facility (resolved by the caller from its
    site) scopes which placements blob is searched.
    """
    rows = FacilityMapBlob.objects.filter(kind='placements', facility=facility).exclude(key='')

    rack_fallback = None
    for blob in rows:
        floor_key = blob.key
        for p in ((blob.data or {}).get('placements') or []):
            room = p.get('room')
            if not room:
                continue
            kind, pid = p.get('kind'), p.get('id')
            if obj_kind == 'rack':
                if kind == 'rack' and pid == obj_pk:
                    return floor_key, room, _placement_focus(p)
            else:
                if kind != 'rack' and pid == obj_pk:
                    return floor_key, room, _placement_focus(p)   # direct device placement — preferred
                if (rack_fallback is None and rack_pk is not None
                        and kind == 'rack' and pid == rack_pk):
                    rack_fallback = (floor_key, room, _placement_focus(p))
    return rack_fallback


def sheet_bounds_for_room(polygon, sheets, w, h):
    """The cell rect `(x0, y0, x1, y1)` (combined-canvas units) of the sheet a room sits on,
    or `None` to fall back to the whole canvas.

    A multi-sheet floor tiles its pages into one combined canvas (`floor_sheets`); a room lives
    on exactly one of those cells. The per-room embed crop must stay inside that cell so a
    two-page floor doesn't frame against — and reveal — both pages. The `Room` model carries no
    sheet field, so the sheet is recovered geometrically: the room polygon's centroid (vertex
    mean, scaled to canvas units) is tested against each sheet cell rect. A room straddling a
    boundary resolves to whichever cell holds its centroid — a reasonable tie-breaker.

    Returns `None` for a single-sheet floor (`len(sheets) < 2` — nothing to scope, so the caller
    keeps the whole-canvas behaviour byte-for-byte) or an empty polygon, and also when the
    centroid lands in no cell (degenerate) — again deferring to the full canvas. `sheets` are
    `floor_sheets(...)['sheets']`, whose `x/y/w/h` are pre-formatted strings, so they're cast to
    float here.
    """
    if not polygon or len(sheets) < 2:
        return None
    cx = (sum(x for x, _ in polygon) / len(polygon)) * w
    cy = (sum(y for _, y in polygon) / len(polygon)) * h
    for s in sheets:
        sx, sy, sw, sh = float(s['x']), float(s['y']), float(s['w']), float(s['h'])
        if sx <= cx < sx + sw and sy <= cy < sy + sh:
            return sx, sy, sx + sw, sy + sh
    return None


def room_viewbox(polygon, w, h, pad=0.08, zoom=ZOOM_DEFAULT, aspect=None, bounds=None, focus=None):
    """SVG `viewBox` string cropping a single room's polygon, or None if it has no points.

    Bounding box of the normalized polygon scaled by `w`×`h`, padded by `pad` of the larger
    side (with a small px floor so a tiny room still gets margin), then the whole box is
    scaled about the room's centre by `zoom` to pull surrounding floor into view — `zoom=1`
    is the tight pad-only crop; the default `2` doubles each visible side (~4× the area). The
    zoom-scaled box is a *proportion* of the room, so it's floored to `ROOM_MIN_CROP_FRAC` of
    the crop region on each axis: a tiny room's crop would otherwise stay absolutely small and
    show only blank floor, never a neighbouring room.

    When `focus` (a normalized `(x, y)`, e.g. a device's own marker centre) is given the crop
    switches to the **device-centred** framing the device/rack embed wants (SHOW-3): it centres on
    `focus` rather than the room centroid and spans a tight `DEVICE_EMBED_CROP_FRAC` of the crop
    region — a small, absolute, room-size-independent span so the glyph + label read legibly even in
    a large room — capped to the room's own padded bbox (so a corner device can't frame across into a
    neighbour). `zoom` and `ROOM_MIN_CROP_FRAC` do not apply on this path; the room's own page keeps
    passing `focus=None` for its unchanged room-centred, zoomable crop.

    When `aspect` (a width/height ratio, e.g. from the embed's orientation setting) is given,
    the box is then reshaped to that ratio by *growing* its shorter axis — never shrinking, so
    the room's padded bbox always stays inside the box (fully visible). This lets the template's
    fixed-aspect container fill with real floor under `preserveAspectRatio="…meet"` instead of
    letterboxing. Zoom is unaffected: it still sets the base span; aspect only reshapes it.

    The box is finally clamped to the crop region so a room near its edge shows real floor rather
    than blank space past the image (a box larger than the region on an axis just falls back to
    that axis's full extent — which, at the extreme, can leave the container a slight `meet`
    letterbox when the region can't supply the requested aspect). The crop region is `bounds`
    `(x0, y0, x1, y1)` when given — the cell rect of the room's own sheet on a multi-sheet floor
    (`sheet_bounds_for_room`), so the crop can't span both pages — otherwise the whole
    `0..w`×`0..h` canvas (single-sheet floors, unchanged); on the `focus` path it's further
    tightened to the room's own padded bbox. Returned as "minx miny width height"; the caller falls
    back to the full floor view on None.
    """
    if not polygon:
        return None
    x0, y0, x1, y1 = bounds if bounds else (0.0, 0.0, w, h)
    region_w, region_h = x1 - x0, y1 - y0
    bw_max, bh_max = region_w, region_h
    xs = [x * w for x, _ in polygon]
    ys = [y * h for _, y in polygon]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    margin = max(max((maxx - minx), (maxy - miny)) * pad, 8)
    if focus is None:
        cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
        # Zoom-scale about the centre, floor to a minimum absolute span (so tiny rooms show
        # context), then clamp to the crop region's extent (the room's own sheet, or the canvas).
        bw = min(max(((maxx - minx) + 2 * margin) * zoom, bw_max * ROOM_MIN_CROP_FRAC), bw_max)
        bh = min(max(((maxy - miny) + 2 * margin) * zoom, bh_max * ROOM_MIN_CROP_FRAC), bh_max)
    else:
        # Device-centred: frame on the device's own marker and crop tight. Tighten the clamp region
        # to the room's own padded bbox (∩ the sheet bounds already in x0..y1) so a corner device
        # can't frame across into a neighbour; span a small, absolute fraction of the *region* (not
        # the room), capped to that tightened bbox, so the glyph reads at a legible size regardless
        # of room size.
        cx, cy = focus[0] * w, focus[1] * h
        x0, y0 = max(x0, minx - margin), max(y0, miny - margin)
        x1, y1 = min(x1, maxx + margin), min(y1, maxy + margin)
        bw_max, bh_max = x1 - x0, y1 - y0
        bw = min(region_w * DEVICE_EMBED_CROP_FRAC, bw_max)
        bh = min(region_h * DEVICE_EMBED_CROP_FRAC, bh_max)
    # Grow the shorter axis to the target orientation aspect (never shrink), then re-clamp to
    # the region so the reshape can't push the box past it.
    if aspect:
        if bw / bh < aspect:
            bw = min(bh * aspect, bw_max)
        else:
            bh = min(bw / aspect, bh_max)
    bx = min(max(cx - bw / 2, x0), x1 - bw)
    by = min(max(cy - bh / 2, y0), y1 - bh)
    return f'{bx:.1f} {by:.1f} {bw:.1f} {bh:.1f}'


def _polygon_area(ring):
    """Absolute area of a normalized 0..1 polygon `ring` ([[x,y],...]) via the shoelace formula.

    Direction-agnostic (`abs`), so it's a pure size measure — used only to pick the *smaller* of
    two rooms when deciding which one's area gets punched out of the other (`contained_map`)."""
    n = len(ring)
    if n < 3:
        return 0.0
    acc = 0.0
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        acc += x1 * y2 - x2 * y1
    return abs(acc) / 2.0


def _point_in_ring(pt, ring):
    """Ray-casting (even-odd) point-in-polygon test for a normalized 0..1 `ring`.

    Returns True when `pt` (an [x, y]) lies inside the implicitly-closed polygon. Boundary points
    are treated as either side (not distinguished) — good enough for the containment test in
    `contained_map`, which asks whether one room's vertices fall inside another's."""
    x, y = pt
    n = len(ring)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def _is_contained(inner, outer):
    """True when room `inner` sits fully inside room `outer` (both precomputed entry dicts).

    Contained = **strictly smaller by area** and **every vertex of `inner` lies inside `outer`**,
    with a bounding-box pre-check to skip the obvious non-overlaps first. Containment only — a
    room straddling `outer`'s boundary fails the all-vertices-inside test (partial overlap is out
    of scope; it would need true polygon clipping)."""
    if inner is outer or inner['area'] >= outer['area']:
        return False
    ominx, ominy, omaxx, omaxy = outer['bbox']
    iminx, iminy, imaxx, imaxy = inner['bbox']
    if iminx < ominx or iminy < ominy or imaxx > omaxx or imaxy > omaxy:
        return False
    return all(_point_in_ring(pt, outer['ring']) for pt in inner['ring'])


def contained_map(rooms):
    """Map each room's `room_id` → the polygons of its **directly** contained smaller rooms.

    When a smaller room is drawn fully inside a larger one, the caller punches the smaller room's
    area out of the larger room's highlight via an evenodd `<path>` (`evenodd_path`), so the larger
    room's fill/spotlight no longer double-paints over it. This is a **render-time, derived**
    relationship — stacking isn't modelled anywhere (no z-index/overlap field) and stored geometry
    is untouched; it's recomputed each render from the other rooms' polygons.

    Only **direct children** are returned — a room contained in `A` but *also* contained in another
    room that is itself inside `A` is punched out at that intermediate level, not by `A`. This keeps
    the evenodd subtraction correct at any nesting depth: were `A` to also list a grandchild ring,
    the extra parity crossing would re-fill the grandchild's area inside `A`. For the common
    single-level case (a room directly inside another) the direct set is just the full contained set.

    `rooms` is any iterable of objects exposing `.room_id` and `.polygon` ([[nx,ny],...] 0..1).
    Containment is **strict** (see `_is_contained`); partial edge-crossing overlap is not handled."""
    # Precompute each room's ring, area and bbox once (O(n·v)); the containment scan is then O(n²).
    entries = []
    for room in rooms:
        ring = room.polygon or []
        if len(ring) < 3:
            continue
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        entries.append({
            'id': room.room_id,
            'ring': ring,
            'area': _polygon_area(ring),
            'bbox': (min(xs), min(ys), max(xs), max(ys)),
        })

    n = len(entries)
    # contains[i] = indices of the rooms strictly inside entries[i] (all descendants, any depth).
    contains = [
        {j for j in range(n) if _is_contained(entries[j], entries[i])}
        for i in range(n)
    ]

    result = {}
    for i in range(n):
        children = contains[i]
        # Keep only direct children: drop a descendant `j` that another child `k` of `i` also
        # contains (so `j` is punched out by `k`, one level down, not by `i`).
        direct = [j for j in children
                  if not any(k != j and j in contains[k] for k in children)]
        if direct:
            result[entries[i]['id']] = [entries[j]['ring'] for j in direct]
    return result


def evenodd_path(rings, w, h):
    """Build an SVG path `d` string from one or more normalized 0..1 `rings`, scaled by `w`×`h`.

    Each ring becomes a closed subpath (`M x,y L x,y … Z`); concatenated subpaths render under
    `fill-rule="evenodd"` as an outer contour with the rest punched out — the idiom the floor
    editor uses for keyhole rooms (`floor-editor.js:_drawRoom` + `lib.js:Geom.splitBridges`),
    reused here at render time so a larger room's highlight excludes any contained smaller room
    (`contained_map`). A single ring yields a plain closed path (evenodd ≡ nonzero for one
    contour), so an un-holed room renders exactly as the old `<polygon>` did. Returns '' when no
    ring has ≥3 points, so the caller can skip an empty shape."""
    subpaths = []
    for ring in rings:
        if len(ring) < 3:
            continue
        pts = [f'{x * w:.1f},{y * h:.1f}' for x, y in ring]
        subpaths.append('M' + pts[0] + ' L' + ' '.join(pts[1:]) + ' Z')
    return ' '.join(subpaths)


def room_arrows(floor_key, room_id, w, h, head_px=ARROW_HEAD_PX, facility=''):
    """Render-ready geometry for the wayfinding arrows whose destination is `room_id`.

    Reads the floor's `kind='annotations'` shard row (`key=floor_key`, CONC-1) `['arrows']` and keeps
    only the arrows the editor auto-bound to this room (`a['room'] == room_id`, the frontend room id
    persisted verbatim as `Room.room_id`). For the per-room embed only — the caller passes the
    embedded room's `room_id`, so the result is already permission-scoped to a room the user may view.

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
    floor = _floor_shard('annotations', facility, floor_key)
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
