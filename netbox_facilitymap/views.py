"""Server-rendered UI pages for the plugin.

`MapView` serves the full-bleed map application shell (the framework-free frontend then
talks back through `frontend_api`); `SettingsView` is the permission-gated page for the
editable plugin settings. Both are login-gated and read NetBox data straight from the ORM —
there is no API token in play. Room/Location page content lives in `template_content.py`,
not here.
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

from . import capabilities, facilities, health
from .access import IMPORT_PERM, MapReadAccessMixin
from .drawing_formats import COMPANION_EXTS, DRAWING_EXTS
from .models import FacilityMapBlob
from .previews import (
    ORIENTATION_DEFAULT, SIZE_DEFAULT, SIZE_MAX, SIZE_MIN, ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN,
    RoomEmbedSettings, clamp_embed_size, clamp_floor_label_field, clamp_orientation, clamp_zoom,
)

# Orientation choices for the Settings <select> (value → human label). The values are the keys
# of `previews.ORIENTATION_ASPECT`; `clamp_orientation` rejects anything else on read/write.
ORIENTATION_CHOICES = [('vertical', 'Vertical (taller)'), ('landscape', 'Landscape (wide)')]


def _floor_label_field(embed=None):
    """The configured Location field for a floor's display label, resolved across three tiers:
    the Settings-page `settings` blob value → the `PLUGINS_CONFIG floor_label_field` default →
    `'name'`. Pass an existing `RoomEmbedSettings` to reuse its single settings-row query (the
    Settings view already has one); otherwise one is loaded. A blob value that is present but bogus
    is clamped by `RoomEmbedSettings.floor_label_field` and still wins over `PLUGINS_CONFIG`; only a
    truly unset blob value (its property returns `None`) defers to the config default."""
    stored = (embed or RoomEmbedSettings()).floor_label_field
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
        # The import wizard's accepted-extension list is derived from the server's format
        # registry (`drawing_formats`) and injected into `window.MAP.drawingExts`, so the
        # frontend doesn't hand-mirror it. `companion_exts` are a drawing's sibling files (a
        # shapefile set) — accepted for upload but not themselves drawings.
        context['drawing_exts'] = json.dumps(list(DRAWING_EXTS))
        context['companion_exts'] = json.dumps(list(COMPANION_EXTS))
        # The enabled optional capabilities (the add-on framework, ADDON-2), injected into
        # `window.MAP.capabilities` so the frontend can lazy-load + gate a capability's tool on its
        # presence (App.hasCapability) — the same detect-and-enable model as `drawing_exts`. Today
        # this lists the installed optional-format extras (svg/cad/gis/visio); a feature capability
        # (e.g. NOTE-1) would appear here too.
        context['capabilities'] = json.dumps(capabilities.enabled_keys())
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
        # Whether THIS user may create a NetBox Location inline from the bind panel (LOC-1). The
        # install-wide on/off is the `location-create` capability (in `capabilities` above); this
        # per-user flag adds the `dcim.add_location` object permission so the affordance is only
        # offered to users who could actually create. Both are re-checked server-side in
        # `NbLocationCreateView` — this is purely UX, like `can_import`/`can_reset`.
        context['can_create_location'] = self.request.user.has_perm('dcim.add_location')
        # Default Location field the import wizard's floor-label picker starts on; the wizard
        # lets the user override it per import without editing PLUGINS_CONFIG.
        context['floor_label_field'] = _floor_label_field()
        # The operator-pinned default facility (SET-2): which facility the SPA boots into when the
        # URL hash names none. '' unless one is pinned on the in-app Settings page; a pin that no
        # longer resolves to a reachable, content-having facility degrades to '' here (HEALTH-1), so
        # the frontend never boots into a dead or empty facility. See facilities.default_facility.
        context['default_facility'] = facilities.default_facility()
        # A read-only pointer banner (HEALTH-1): flag when the install holds map data parked under a
        # facility no current Site resolves to, so an importer sees "your data looks empty because a
        # grouping change orphaned it — reassign it in Settings" rather than a silently blank map.
        # Purely informational; the reassignment itself is the IMPORT_PERM-gated Settings action.
        context['has_orphaned_data'] = bool(facilities.orphaned_facility_keys())
        return context


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
    is re-clamped on read by the matching `previews.RoomEmbedSettings` property.

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
        embed = RoomEmbedSettings()
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
        # Merge onto the existing settings document (other keys preserved), then persist as a
        # single write so the audit trail gets exactly one entry (AUDIT-1). Snapshot the row
        # before overwriting so the change-log entry carries the before/after diff and an
        # unchanged save is suppressed as a no-op; a first-ever save is a plain insert with no
        # prechange state. (Unlike the editor blobs this isn't on the optimistic-concurrency
        # path, so there's no version token / select_for_update here.)
        blob = FacilityMapBlob.objects.filter(kind='settings', key='').first()
        data = dict(blob.data if blob else {})
        data['room_embed_zoom'] = zoom
        data['room_embed_size'] = size
        data['room_embed_orientation'] = orientation
        if blob is None:
            FacilityMapBlob.objects.create(kind='settings', key='', data=data)
        else:
            blob.snapshot()
            blob.data = data
            blob.save(update_fields=['data', 'updated', 'last_updated'])

        messages.success(
            request,
            f'Settings saved: room embed zoom {zoom:g}, size {size:g}%, {orientation}.',
        )
        return redirect(reverse('plugins:netbox_facilitymap:settings'))
