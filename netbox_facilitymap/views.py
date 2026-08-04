"""Server-rendered UI pages for the plugin.

`MapView` serves the full-bleed map application shell (the framework-free frontend then
talks back through `frontend_api`); `TodoTabView` and `ImportTabView` are nav-reachable entry
points to two of that shell's SPA routes; `SettingsView` is the permission-gated page for the
editable plugin settings. All are login-gated and read NetBox data straight from the ORM — there
is no API token in play. Room/Location page content lives in `template_content.py`, not here.
"""

import json

from django.apps import apps
from django.contrib import messages
from django.contrib.auth.mixins import LoginRequiredMixin, PermissionRequiredMixin
from django.shortcuts import redirect, render
from django.urls import reverse
from django.views import View
from django.views.generic import TemplateView
from netbox.plugins import get_plugin_config

from dcim.models import DeviceRole

from . import capabilities, facilities, health
from .access import IMPORT_PERM, MapReadAccessMixin
from .device_shapes import custom_rules
from .drawing_formats import COMPANION_EXTS, DRAWING_EXTS, OVERLAY_EXTS
from .frontend_api import merge_settings, serialize_user
from .previews import (
    ORIENTATION_DEFAULT, SIZE_DEFAULT, SIZE_MAX, SIZE_MIN, ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN,
    PluginSettings, clamp_embed_size, clamp_floor_label_field, clamp_orientation, clamp_zoom,
    todos_enabled,
)

# Orientation choices for the Settings <select> (value → human label). The values are the keys
# of `previews.ORIENTATION_ASPECT`; `clamp_orientation` rejects anything else on read/write.
ORIENTATION_CHOICES = [('vertical', 'Vertical (taller)'), ('landscape', 'Landscape (wide)')]


def _floor_label_field(settings=None):
    """The configured Location field for a floor's display label, resolved across three tiers:
    the Settings-page `settings` blob value → the `PLUGINS_CONFIG floor_label_field` default →
    `'name'`. Pass an existing `PluginSettings` to reuse its single settings-row query (both
    `MapView` and the Settings view already have one); otherwise one is loaded. A blob value that is
    present but bogus is clamped by `PluginSettings.floor_label_field` and still wins over
    `PLUGINS_CONFIG`; only a truly unset blob value (its property returns `None`) defers to the
    config default."""
    stored = (settings or PluginSettings()).floor_label_field
    if stored is not None:
        return stored
    return clamp_floor_label_field(get_plugin_config('netbox_facilitymap', 'floor_label_field'))


class MapView(MapReadAccessMixin, TemplateView):
    """The full-bleed map application.

    Renders a minimal standalone template (it deliberately does *not* extend
    `base/layout.html`) so the SVG canvas gets the whole viewport, matching the
    standalone tool. Reached via the plugin nav item under NetBox's authenticated
    mount. Login-gated, plus the optional `view_facilitymapblob` read gate
    (`MapReadAccessMixin`); the JSON endpoints in `frontend_api` carry the data access.
    """
    template_name = 'netbox_facilitymap/index.html'

    def get_context_data(self, **kwargs):
        # `?embed=1` (set by the dashboard widget's iframe) drops the SPA chrome and navigation
        # so the map sits cleanly inside a card; `interactive`/`legend` are opt-in relaxations
        # of that static default. See `index.html` and `dashboard.py`.
        context = super().get_context_data(**kwargs)
        context['embed'] = 'embed' in self.request.GET
        context['interactive'] = 'interactive' in self.request.GET
        context['legend'] = 'legend' in self.request.GET
        # `?finder=1` (set by FacilitySearchWidget's iframe) is a search-only embed: the SPA shows
        # just the wayfinding finder — no map, no legend. Only meaningful alongside `embed`.
        context['finder'] = 'finder' in self.request.GET
        # `?target=netbox` (FacilitySearchWidget's result-target option, NAV-16) makes a result click
        # open the object's NetBox detail page instead of deep-linking the map; anything else (the
        # default) keeps map navigation. Whitelisted to the two known modes.
        context['result_target'] = 'netbox' if self.request.GET.get('target') == 'netbox' else 'map'
        # The import wizard's accepted-extension list is derived from the server's format
        # registry (`drawing_formats`) and injected into `window.MAP.drawingExts`, so the
        # frontend doesn't hand-mirror it. `companion_exts` are a drawing's sibling files (a
        # shapefile set) — accepted for upload but not themselves drawings.
        context['drawing_exts'] = json.dumps(list(DRAWING_EXTS))
        context['companion_exts'] = json.dumps(list(COMPANION_EXTS))
        # `overlay_exts` is the OVERLAY-role subset of the accepted drawings — the wizard keys
        # overlay-only affordances (the FMT-6 align editor) off it, again without hand-mirroring.
        context['overlay_exts'] = json.dumps(list(OVERLAY_EXTS))
        # The enabled optional capabilities (the add-on framework, ADDON-2), injected into
        # `window.MAP.capabilities` so the frontend can lazy-load + gate a capability's tool on its
        # presence (App.hasCapability) — the same detect-and-enable model as `drawing_exts`. Today
        # this lists the installed optional-format extras (svg/cad/gis/visio); a feature capability
        # (e.g. NOTE-1) would appear here too.
        context['capabilities'] = json.dumps(capabilities.enabled_keys())
        # The operator's extra device-role → glyph keywords (INTL-1), injected into
        # `window.MAP.roleGlyphs`. Validated + normalized once here on the server
        # (`device_shapes.custom_rules`) rather than in the browser, so the lockstep pair
        # (`device_shapes.py` / `device-shapes.js`) classifies against the identical vocabulary —
        # the server-side embeds read the same function directly. A fixed vocabulary like
        # `capabilities`/`drawing_exts`, so it rides `json.dumps` + `|safe`, not `|escapejs`.
        context['role_glyphs'] = json.dumps([[t, list(k)] for t, k in custom_rules()])
        # Stamp the plugin version into window.MAP so App.ensureScripts can cache-bust the
        # lazily-loaded editor/import bundles per deploy (a browser-cached stale bundle run
        # against fresh core scripts is what broke the floor editor). Sourced from the running
        # PluginConfig so it stays in lockstep with __init__.py / pyproject.toml.
        context['version'] = apps.get_app_config('netbox_facilitymap').version
        # Import/reset are gated server-side (imports.py); these flags let the frontend avoid
        # dropping a non-importer into a wizard whose every call would 403, and hide the
        # reset ("Start over") control from a non-superuser importer. Purely UX — the endpoints
        # remain the security boundary. `can_reset` mirrors ResetView's superuser tier.
        context['can_import'] = self.request.user.has_perm(IMPORT_PERM)
        context['can_reset'] = self.request.user.is_superuser
        # Whether THIS user may create a NetBox Location inline from the bind panel (LOC-1/LOC-2). The
        # install-wide on/off is now the runtime `write_mode` setting (below); this per-user flag adds
        # the `dcim.add_location` object permission so the affordance is only offered to users who
        # could actually create. Both are re-checked server-side in `NbLocationCreateView` — this is
        # purely UX, like `can_import`/`can_reset`.
        context['can_create_location'] = self.request.user.has_perm('dcim.add_location')
        # One `PluginSettings` instance serves every settings-derived flag below — including
        # `_floor_label_field` and `facilities.default_facility`, whose settings live in the same
        # row — so this render reads the shared settings row **once** instead of issuing a query
        # per flag.
        settings = PluginSettings()
        # Install-wide write mode (LOC-2): the runtime, admin-controlled **master gate** on
        # everything the plugin writes into NetBox core, replacing the old redeploy-time
        # `allow_location_create` capability flag. Flipped on the in-app Settings page
        # (SettingsPage), read back here so the write add-ons apply without a worker restart.
        # Server-enforced at each write endpoint; this is the UX mirror.
        context['write_mode'] = settings.write_mode
        # The inline-room-creation add-on's own switch (SET-5), sitting on top of that gate: it, write
        # mode, and `can_create_location` must all be true before the bind panel offers the create
        # tile. Server-enforced in `NbLocationCreateView`; UX mirror, like `write_mode` above.
        context['inline_room_creation'] = settings.inline_room_creation
        # High-quality rendering (READ-1), mirrored so the Settings page can show its current state.
        # Unlike the switches around it this one steers no browser behaviour at all — the render it
        # controls happens in the import subprocess — so this is purely the toggle's initial value.
        context['render_hq'] = settings.render_hq
        # The to-do feature's install-wide switch (ADDON-4) — a general (non-write) add-on. Mirrored
        # to the browser so the SPA hides the to-do pages, the floor panel, and the compose icon when
        # off; every to-do endpoint re-checks it server-side (frontend_api.TodoFeatureGateMixin), so
        # this is the UX mirror, like write_mode/ap_tool above.
        context['todos'] = settings.todos
        # Access-point tool configuration (DEV-3), mirrored to the browser so the Settings page can
        # render its current state and the floor editor can decide whether to offer the tool. Every
        # value is re-read/re-enforced server-side; this is the UX mirror, like `write_mode` above.
        # `can_create_device` is the per-user half (`dcim.add_device`), the exact analogue of
        # `can_create_location` — the AP tool's install-wide halves are `ap_tool` AND `write_mode`.
        ap = settings.ap
        context['ap_tool'] = ap['enabled']
        context['ap_name_template'] = ap['name_template']
        context['ap_count_scope'] = ap['count_scope']
        context['can_create_device'] = self.request.user.has_perm('dcim.add_device')
        # Resolve the configured role id to {id,name} so the Settings combobox shows its label
        # without a round-trip. A role that has since been deleted — or that this user may not see —
        # resolves to None, i.e. "unconfigured": the picker opens empty and the tool stays hidden,
        # which is the honest reading. `clamp_ap_device_role` deliberately doesn't check existence
        # (a clamp can't ask the ORM); this is where that question gets answered.
        #
        # Passed as a dict, NOT pre-serialised with json.dumps + |safe like `capabilities`/
        # `drawing_exts` above: those are fixed server-side vocabularies, whereas a role name (and
        # `ap_name_template`) is operator-typed free text. JSON escaping does not escape `/`, so a
        # name containing `</script>` would break out of the inline <script> block. The template
        # renders both through `|escapejs`, which is the correct escaping for a JS string context.
        role = (DeviceRole.objects.restrict(self.request.user, 'view')
                .filter(pk=ap['device_role']).first() if ap['device_role'] else None)
        context['ap_device_role'] = {'id': role.pk, 'name': role.name} if role else None
        # Default Location field the import wizard's floor-label picker starts on; the wizard
        # lets the user override it per import without editing PLUGINS_CONFIG.
        context['floor_label_field'] = _floor_label_field(settings)
        # The operator-pinned default facility (SET-2): which facility the SPA boots into when the
        # URL hash names none. '' unless one is pinned on the in-app Settings page; a pin that no
        # longer resolves to a reachable, content-having facility degrades to '' here (HEALTH-1), so
        # the frontend never boots into a dead or empty facility. See facilities.default_facility.
        context['default_facility'] = facilities.default_facility(settings)
        # A read-only pointer banner (HEALTH-1): flag when the install holds map data parked under a
        # facility no current Site resolves to, so a viewer sees "the map looks empty because a
        # grouping change orphaned it" rather than a silently blank map. Surfaced to EVERY map viewer
        # (HEALTH-6), not just importers — the template shows the actionable "reassign it in Settings"
        # link only to `can_import` users, since the reassignment itself is the IMPORT_PERM-gated
        # Settings action; other viewers are told an admin must reassign it. Purely informational.
        # The grouping is resolved off the same `settings` instance as everything above, so the
        # banner costs a data scan and not a second read of the settings row.
        context['has_orphaned_data'] = bool(
            facilities.orphaned_facility_keys(group=facilities.grouping(settings)))
        # Who is looking at the map (TASK-3). The to-do surfaces sort a user's own to-dos above
        # everyone else's, so they need the viewer's identity client-side; it is stamped here rather
        # than fetched because it can't change within a page load, and a round-trip to learn it would
        # gate the panel's first sort on a request. `serialize_user` is reused verbatim so the viewer
        # arrives in the exact shape a to-do's `assignees` do and the ids compare directly. This page
        # is login-gated (`MapReadAccessMixin`), so there is always a real user here.
        context['map_user'] = serialize_user(self.request.user)
        return context


class TodoTabView(MapReadAccessMixin, View):
    """The **To-do** nav entry (TASK-5) — a redirect to the map shell's `#/todo` SPA route.

    The facility-wide to-do page is a client-side route inside `MapView`'s single-page shell, but a
    `PluginMenuItem` links by reversible URL *name* and cannot carry a fragment, so the nav needs a
    real URL to point at. This is it: the one job is to send the browser to the map with the hash
    that selects the page. (`SettingsView` is not the analogue — that's a genuinely separate
    server-rendered page, not a route into the shell.)

    A **bare** `#/todo` is deliberate: `App.init` applies the operator-pinned default facility to a
    hash that names none, preserving the route while it rewrites to `#/y/<slug>/todo` (NAV-10). A
    facility hard-coded here would instead override that pin. Carries the same read gate as the map
    it lands on.

    When the to-do add-on is switched off (ADDON-4) this lands on the bare map instead of `#/todo`.
    The nav item stays statically registered (NetBox caches the plugin menu at worker start, so it
    can't be hidden live), so a viewer may still click it while the feature is off — a graceful
    bounce to the map is the honest destination, mirrored client-side by `App.showTodo`. The
    `api/todos*` data endpoints refuse loudly (404) instead; this is chrome, not an API."""

    def get(self, request):
        target = reverse('plugins:netbox_facilitymap:map')
        if todos_enabled():
            target += '#/todo'
        return redirect(target)


class ImportTabView(MapReadAccessMixin, View):
    """Nav entry that lands directly on the in-app import/edit flow (`#/import`), HEALTH-8.

    Mirrors `TodoTabView`'s shape exactly, for the same reason: a `PluginMenuItem` links by
    reversible URL *name* and can't carry a fragment, so this supplies the real URL the nav item
    points at. Gated only on `MapReadAccessMixin` (the plain map-read check) — deliberately
    **not** `IMPORT_PERM` — so every change-only editor (holds `change_facilitymapblob` but not
    `import_facilitymapblob`) can reach it, not just importers (PERM-1, HEALTH-8). The permission
    split happens at the destination instead: `App.showImport()` already checks `app.canImport`
    and falls back to `App.showNoImport()`'s "ask an administrator" signpost for anyone who lacks
    it — this view doesn't duplicate that gate, just like `TodoTabView` doesn't duplicate the
    to-do add-on's own gating.

    The nav item that links here (`navigation.py`) is gated on `change_facilitymapblob`, so an
    importer sees this alongside `Settings`' own "Edit buildings & floors" button — a small,
    deliberate duplication (TASK-5's `To-do` item duplicates map access the same way)."""

    def get(self, request):
        return redirect(reverse('plugins:netbox_facilitymap:map') + '#/import')


class SettingsView(LoginRequiredMixin, PermissionRequiredMixin, View):
    """In-app plugin settings (NetBox → Plugins → Facility Map → Settings).

    Persists the editable settings to the single `kind='settings'` blob row. Gated on the
    `import_facilitymapblob` permission — the Settings page is admin-tier configuration, on the
    same gate as the import surface (PERM-1), not the everyday `change_facilitymapblob` map-write
    that a rack-placer holds. Reads of the settings happen server-side in `template_content`,
    never through this page. The settings govern the
    per-room map embed: `room_embed_zoom` (magnification), `room_embed_size` (footprint —
    the box's width as a percent of its column) and `room_embed_orientation` (box shape).
    Each is validated/clamped at this boundary; a value edited outside this form (admin/REST)
    is re-clamped on read by the matching `previews.PluginSettings` property.

    This page owns only the settings about how the plugin *interacts with NetBox* — the per-room
    embed here and `facility_grouping` (set via `frontend_api.NbFacilitiesView`). Everything else
    lives on the map's own in-app `#/settings` page (`SettingsPage`); `floor_label_field` moved
    there in SET-1 (persisted via `frontend_api.FloorLabelFieldSettingView`), though its 3-tier
    resolver `_floor_label_field` (blob → `PLUGINS_CONFIG` → `'name'`) still lives here for `MapView`.

    The page also renders the read-only consistency report (`health.run_checks`, scoped to the
    requester) so an admin can spot broken slug/Location bindings in-app; the same report is the
    `facilitymap_check` management command's output.
    """
    permission_required = IMPORT_PERM
    template_name = 'netbox_facilitymap/settings.html'

    def _context(self, request):
        # One instance reads all three current values off a single settings-row query.
        embed = PluginSettings()
        return {
            'room_embed_zoom': embed.zoom,
            'zoom_min': ZOOM_MIN,
            'zoom_max': ZOOM_MAX,
            'zoom_default': ZOOM_DEFAULT,
            'room_embed_size': embed.size,
            'size_min': SIZE_MIN,
            'size_max': SIZE_MAX,
            'size_default': SIZE_DEFAULT,
            'room_embed_orientation': embed.orientation,
            'orientation_default': ORIENTATION_DEFAULT,
            'orientations': ORIENTATION_CHOICES,
            # Read-only diagnostic, scoped to what this user may view (see health._scoped).
            'health': health.run_checks(request.user),
            # Facilities an operator may reassign orphaned data *to* (the reachable ones), feeding the
            # per-orphan reassignment <select> in the health panel (HEALTH-1).
            'reassign_targets': facilities.reachable_facility_choices(),
        }

    def get(self, request):
        return render(request, self.template_name, self._context(request))

    def _reassign(self, request):
        """Re-key map data orphaned by a grouping change to the operator-chosen facility (HEALTH-1).

        The recovery action behind the health panel's "Unassigned map data" section. Already on the
        IMPORT_PERM gate (the Settings page is `PermissionRequiredMixin`), so this is admin-tier like
        the grouping change that caused the orphaning. `reassign_facility` validates and does the
        DB re-key + working-dir move atomically-then-durably; any failure is a `ValueError` we surface
        as a form error rather than a 500."""
        try:
            kinds = facilities.reassign_facility(request.POST.get('old', ''),
                                                 request.POST.get('new', ''))
        except ValueError as exc:
            messages.error(request, 'Could not reassign map data: %s' % exc)
            return render(request, self.template_name, self._context(request))
        target = request.POST.get('new', '') or 'the default facility'
        messages.success(request, 'Reassigned map data (%s) to %s.' % (', '.join(kinds), target))
        return redirect(reverse('plugins:netbox_facilitymap:settings'))

    def post(self, request):
        if request.POST.get('action') == 'reassign':
            return self._reassign(request)
        # Both numeric fields must parse as numbers before we clamp; orientation is enum-safe
        # (clamp_orientation falls back to the default for anything unrecognised) so it needs
        # no separate error path.
        raw_zoom = request.POST.get('room_embed_zoom')
        raw_size = request.POST.get('room_embed_size')
        try:
            float(raw_zoom)
        except (TypeError, ValueError):
            messages.error(request, 'Room embed zoom must be a number.')
            return render(request, self.template_name, self._context(request))
        try:
            float(raw_size)
        except (TypeError, ValueError):
            messages.error(request, 'Room embed size must be a number.')
            return render(request, self.template_name, self._context(request))

        zoom = clamp_zoom(raw_zoom)
        size = clamp_embed_size(raw_size)
        orientation = clamp_orientation(request.POST.get('room_embed_orientation'))
        # Merge onto the existing settings document through the one shared settings upsert, so the
        # other keys survive, the audit trail gets exactly one entry with a before/after diff and an
        # unchanged save is suppressed as a no-op (AUDIT-1), and — the part this page used to be
        # missing — the read-modify-write happens under `select_for_update()` inside a transaction.
        # Without that row lock a concurrent save from the in-app Settings page could interleave
        # between this page's read and its write and lose one side's keys. (This page is still not
        # on the optimistic-concurrency path: a stale *form* is a person re-submitting values they
        # can see, not a blind document overwrite, so there's no version token — only the row lock.)
        merge_settings({
            'room_embed_zoom': zoom,
            'room_embed_size': size,
            'room_embed_orientation': orientation,
        })

        messages.success(
            request,
            f'Settings saved: room embed zoom {zoom:g}, size {size:g}%, {orientation}.',
        )
        return redirect(reverse('plugins:netbox_facilitymap:settings'))
