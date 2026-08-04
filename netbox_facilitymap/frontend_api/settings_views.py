"""The install-wide settings endpoints the map's own `#/settings` page posts to.

`_SettingView` is the shared base: it owns the `IMPORT_PERM` gate, the JSON parse, and the merge
into the single install-wide (`facility=''`, MULTI-1) `settings` blob via `blobs.merge_settings`.
Each subclass contributes only its own `values()` — which is why they look repetitive and are
deliberately left that way: the base-class seam is already carrying everything that must not drift
between them, and a `values()` one-liner per setting is the whole point of having the seam.

Two endpoints stay outside that base and say why in their own docstrings: `NbFacilitiesView`
(`facility_admin.py` — it has a confirm pre-check and a GET on the same route) and
`OrgModeSettingView` below (per-facility, so it can't use the base's facility-less flat merge).
Both still write through `merge_settings`/`set_org_mode`, so there is still exactly one write path
per setting shape.
"""

from django.contrib.auth.mixins import LoginRequiredMixin
from django.http import HttpResponseBadRequest, HttpResponseForbidden, JsonResponse
from django.views import View

from dcim.models import DeviceRole

from ..access import IMPORT_PERM
from ..facilities import clamp_default_facility, set_org_mode
from ..previews import (
    clamp_ap_count_scope, clamp_ap_device_role, clamp_floor_label_field, clean_ap_name_template,
)
from .blobs import merge_settings
from .common import _parse_json_body


class _SettingView(LoginRequiredMixin, View):
    """Shared base for the small install-wide settings endpoints — inline room creation (SET-5),
    the three access-point ones (DEV-3), and `render_hq` (READ-1).

    Each is admin-tier configuration merged into the single install-wide (`facility=''`, MULTI-1)
    `settings` blob beside `write_mode`/`default_facility`/`floor_label_field`/`facility_grouping`/
    `room_embed_*`, following `WriteModeSettingView`'s shape exactly: gated inline on `IMPORT_PERM`
    (PERM-1), no `?facility=` (the settings are install-wide, living only in the default-facility
    row), and read back through `window.MAP` (stamped by `MapView`) rather than a GET here.

    They share this base only for the parts that must not drift between them — the permission gate,
    the JSON parse, and the **merge**: each subclass returns just the keys it owns from `values()`,
    and the merge goes through `merge_settings` (locked read-modify-write + the shared
    snapshot-before-overwrite upsert) so sibling keys survive and the AUDIT-1 change-log entry
    carries the before/after diff. A subclass raises `ValueError` from `values()` to reject bad
    input as a clean 400.

    A settings endpoint belongs here unless it needs something this `post` can't express — a
    pre-check before the write, or a GET on the same route. Only `NbFacilitiesView` (confirm gate +
    GET) and the chrome'd `views.SettingsView` (an HTML form, not JSON) stay outside it; both still
    write through `merge_settings`."""

    def values(self, payload, request):
        """The `{key: value}` pairs to merge into the settings blob. Raise `ValueError` with a
        user-facing message to reject the payload with a 400."""
        raise NotImplementedError

    def post(self, request):
        if not request.user.has_perm(IMPORT_PERM):
            return HttpResponseForbidden('import permission required')
        payload, error = _parse_json_body(request)
        if error:
            return error
        try:
            values = self.values(payload, request)
        except ValueError as e:
            return JsonResponse({'ok': False, 'error': str(e)}, status=400)
        merge_settings(values)
        return JsonResponse({'ok': True, **values})


class FloorLabelFieldSettingView(_SettingView):
    """POST the install-wide `floor_label_field` setting from the in-app Settings page (SET-1).

    Which NetBox Location field (`name`/`slug`/`description`) seeds a floor's display label when a
    floor is picked from a Location during import. This setting used to live on the NetBox-chrome'd
    `views.SettingsView`; the split now puts NetBox-interaction settings (the `room_embed_*` embed
    controls, `facility_grouping`) on that page and everything else on the map's own `#/settings`
    page — this is the first move. Admin-tier configuration, so gated inline on `IMPORT_PERM` (the
    same gate the old SettingsView and the import wizard use, PERM-1), unlike the login-only NetBox
    reads. The value is clamped to the `FLOOR_LABEL_FIELDS` allowlist and merged into the single
    install-wide (`facility=''`, MULTI-1) `settings` blob so the `room_embed_*`/`facility_grouping`
    keys are preserved — see `_SettingView`. It does not carry a `?facility=` — the setting is
    install-wide, so it lives only in the default-facility settings row.

    A truly-unset value still defers to the `PLUGINS_CONFIG floor_label_field` default then `'name'`
    (`views._floor_label_field`); saving here pins the effective value into the blob, which then wins
    over config. Read-back happens through `window.MAP.floorLabelField` (stamped by `MapView`), so
    there is no GET here."""

    def values(self, payload, request):
        # Enum-safe: a bogus value clamps to FLOOR_LABEL_FIELD_DEFAULT rather than 400ing, mirroring
        # how the old SettingsView.post treated this string-valued setting.
        return {'floor_label_field': clamp_floor_label_field(payload.get('floor_label_field'))}


class DefaultFacilitySettingView(_SettingView):
    """POST the install-wide `default_facility` setting from the in-app Settings page (SET-2).

    Which facility the SPA boots into when the URL hash names none (`App.init`). An install whose
    default facility `''` is empty sends every plain visit to the import wizard; letting an operator
    pin an already-imported facility as the boot default resolves that whole class of nag. Stored as
    the `default_facility` key in the single install-wide (`facility=''`, MULTI-1) `settings` blob
    beside `floor_label_field`/`facility_grouping`/`room_embed_*`, merged so those sibling keys
    survive — see `_SettingView`. It carries no `?facility=` — the setting is install-wide, living
    only in the default-facility settings row. Admin-tier configuration, gated inline on IMPORT_PERM
    (PERM-1), like the setting it sits beside.

    The submitted slug is clamped to a reachable, content-having facility (or `''`) before storing — a
    bogus, empty, or stale value coerces to `''` rather than 400ing, matching how `default_facility()`
    degrades a pin that later goes stale (HEALTH-1). Read-back is through `window.MAP.defaultFacility`
    (stamped by `MapView` via `facilities.default_facility`), so there is no GET."""

    def values(self, payload, request):
        return {'default_facility': clamp_default_facility(payload.get('default_facility') or '')}


class WriteModeSettingView(_SettingView):
    """POST the install-wide `write_mode` setting from the in-app Settings page (LOC-2).

    Write mode is the runtime, admin-controlled replacement for the old redeploy-time
    `allow_location_create` `PLUGINS_CONFIG` flag. Since SET-5 it is a **pure master gate**: it says
    whether this install may write to NetBox core at all, and each write add-on carries its own switch
    on top (`inline_room_creation`, `ap_tool`). Stored as the `write_mode` boolean in the single
    install-wide (`facility=''`, MULTI-1) `settings` blob beside `default_facility`/
    `floor_label_field`/`room_embed_*`, merged so those sibling keys survive — see `_SettingView`. It
    carries no `?facility=` — the setting is install-wide, living only in the default-facility
    settings row.

    Turning it **off leaves every add-on's stored value untouched** — they simply go inert behind the
    closed gate, and come back as they were when it reopens. That's why this endpoint never cascades
    into the add-on keys: an operator closing the gate for an afternoon shouldn't have to reconfigure
    the AP tool afterwards.

    This toggle is only an *install-wide* gate; `NbLocationCreateView` still enforces the per-user
    `dcim.add_location` object permission server-side, so flipping write mode on does not grant anyone
    the ability to create who couldn't already. Admin-tier configuration, gated inline on IMPORT_PERM
    (PERM-1), like the settings it sits beside. Read-back is through `window.MAP.writeMode` (stamped by
    `MapView` via `previews.write_mode_enabled`), so there is no GET."""

    def values(self, payload, request):
        return {'write_mode': bool(payload.get('write_mode'))}


class ApToolSettingView(_SettingView):
    """POST the install-wide `ap_tool` on/off setting from the in-app Settings page (DEV-3).

    The access-point tool's own feature switch, stored **separately from write mode** by design: it
    answers "is this feature in play?", where write mode answers "may this install write to NetBox at
    all?" (the same master-gate-plus-feature-switch pair `inline_room_creation` follows, SET-5).
    Creating an AP needs both gates plus `dcim.add_device`, all re-checked server-side (DEV-5) — so
    switching this on grants nobody the ability to create who couldn't already.

    The endpoint accepts a flip either way regardless of write-mode state, deliberately: it is the
    Settings *page* that keeps this in step with the gate (the row is disabled while write mode is
    off, SET-5), and the write path re-checks both switches itself. Refusing here would add a rule the
    write path doesn't need, and would strand a value an operator had already stored."""

    def values(self, payload, request):
        return {'ap_tool': bool(payload.get('ap_tool'))}


class TodosSettingView(_SettingView):
    """POST the install-wide `todos` on/off setting from the in-app Settings page (ADDON-4).

    The to-do feature's master switch, grouped with the pure first-party **non-write** add-ons: it
    gates the whole in-app to-do surface (both to-do pages, the compose icon, the `api/todos*`
    endpoints) and — unlike the `write_mode` family — writes nothing into NetBox core, so it carries
    no dependency on write mode. Read back through `window.MAP.todos` (stamped by `MapView`) rather
    than a GET, like the rest of the family; the endpoints re-check it via `TodoFeatureGateMixin`.

    A plain boolean by design (ADDON-4): a future setup-wizard add-ons page can set it exactly the
    way this endpoint does, with no to-do-specific persistence to special-case."""

    def values(self, payload, request):
        return {'todos': bool(payload.get('todos'))}


class InlineRoomCreationSettingView(_SettingView):
    """POST the install-wide `inline_room_creation` setting from the in-app Settings page (SET-5).

    The **inline room creation** write add-on's own switch: with it on (and write mode on), a user
    holding `dcim.add_location` may create a room's NetBox Location from the floor bind panel. Split
    out of `write_mode` by SET-5, which left write mode a pure master gate — before it, write-mode-on
    silently meant this feature was on too, with no way to have one without the other.

    Read-back is through `window.MAP.inlineRoomCreation` (stamped by `MapView` via
    `previews.inline_room_creation_enabled`) rather than a GET, like the rest of the family.

    Note the **absent key reads as on** (`inline_room_creation_enabled`), so an install that predates
    SET-5 keeps the create tile write mode used to give it; this endpoint only ever writes the key
    explicitly, so a stored `False` is never mistaken for "not configured"."""

    def values(self, payload, request):
        return {'inline_room_creation': bool(payload.get('inline_room_creation'))}


class RenderHqSettingView(_SettingView):
    """POST the install-wide `render_hq` on/off setting from the in-app Settings page (READ-1).

    Renders floor plans from vector sources at ~216 DPI instead of ~144, so the room names printed
    in the plan stay legible when zoomed out (worst on multi-sheet floors, where each sheet lands at
    roughly half screen size). It costs memory and time in the render subprocess, which is why it is
    opt-in and the page carries a warning — but it cannot run the host out of memory: the renderer
    derives its scale from each page's point size and clamps to `PdfFormat.MAX_IMAGE_PX`
    (`drawing_formats._render_scale`), so a huge sheet gives density back rather than growing
    unbounded.

    Takes effect on the **next import/rebuild** only — existing renders keep serving until then."""

    def values(self, payload, request):
        return {'render_hq': bool(payload.get('render_hq'))}


class OrgModeSettingView(LoginRequiredMixin, View):
    """POST one facility's **organization mode** from the in-app Settings page (MODEL-6).

    Which DCIM shape this facility is modelled in — `site-as-building` (each building is its own
    Site; today's default) or `site-as-campus` (one campus Site, buildings are Locations under it;
    BUILDING-ANCHOR-DESIGN §4.1). Both shapes already resolve; the mode is the operator *declaring*
    which one they use, so the import wizard can stop inferring the building anchor from whichever
    autocomplete hit was clicked.

    Body is `{'facility': <slug>, 'org_mode': <choice>}` and the write goes through
    `facilities.set_org_mode`, the one write path (validation — the choice allowlist and
    `storage.valid_facility` — lives there). Unlike every `_SettingView` sibling it stays outside
    that base twice over: the setting is **per facility**, so it can't use the base's facility-less
    flat merge, and the facility rides the **body** rather than a `?facility=` query param — the
    `/api/settings` prefix is install-wide in `Api.FACILITY_PREFIXES`, and adding it there would
    thread a facility onto the install-wide settings endpoints too.

    Admin-tier configuration like the settings it sits beside, so gated inline on `IMPORT_PERM`
    (PERM-1). Read-back is through the facility list (`facilities.list_facilities` stamps `org_mode`
    on every record), so there is no GET here.

    **Advisory, never enforcing:** setting a mode re-keys nothing and invalidates nothing already
    built — a facility may legitimately mix anchors (design §8 open-q 3). It steers new writes only."""

    def post(self, request):
        if not request.user.has_perm(IMPORT_PERM):
            return HttpResponseForbidden('import permission required')
        payload, error = _parse_json_body(request)
        if error:
            return error
        try:
            saved = set_org_mode(payload.get('facility') or '', payload.get('org_mode'))
        except ValueError as exc:
            return HttpResponseBadRequest(str(exc))
        return JsonResponse({'ok': True, 'org_modes': saved})


class ApDeviceRoleSettingView(_SettingView):
    """POST the install-wide `ap_device_role` setting from the in-app Settings page (DEV-3).

    Which `dcim.DeviceRole` new access points are created with. Stored as the role's numeric id (or
    `None` to clear it, leaving the tool unconfigured and hidden). A non-null id must resolve to a
    role the *saving operator* can see (`restrict(user, 'view')`) — a bogus or hidden id is a clean
    400 rather than a silently-stored dangling reference that would only surface much later, as a
    500 from the Device-create path."""

    def values(self, payload, request):
        raw = payload.get('ap_device_role')
        if raw in (None, ''):
            return {'ap_device_role': None}
        role = clamp_ap_device_role(raw)
        if role is None:
            raise ValueError('device role must be a numeric id')
        if not DeviceRole.objects.restrict(request.user, 'view').filter(pk=role).exists():
            raise ValueError('device role not found')
        return {'ap_device_role': role}


class ApNamingSettingView(_SettingView):
    """POST the install-wide `ap_name_template` + `ap_count_scope` settings from the in-app Settings
    page (DEV-3).

    One endpoint for both because they are one Settings *row* — a free-text template plus the count
    dropdown to its right — and a template is only meaningful alongside the counter scope that
    suffixes it. The template accepts only the `{room}`/`{role_short}` placeholders; anything else is
    a 400 from `clean_ap_name_template` (a typo'd `{rack}` must not slip through as a literal and
    quietly land in every device name). The scope is enum-clamped like the other string settings. The
    counter itself is appended by the name-suggestion logic (DEV-5), never typed into the template —
    which is why there is no `{count}` placeholder."""

    def values(self, payload, request):
        return {
            'ap_name_template': clean_ap_name_template(payload.get('ap_name_template')),
            'ap_count_scope': clamp_ap_count_scope(payload.get('ap_count_scope')),
        }
