"""Shared permission constants and the map-read access gate.

Three model permissions govern the plugin. `change_facilitymapblob` (`EDIT_PERM`) guards every
ordinary map **write** — the `frontend_api` blob/annotation saves. The destructive **import**
surface is split off onto the custom `import_facilitymapblob` (`IMPORT_PERM`) — the import wizard
endpoints and the Settings page — so a "rack-placer" role can edit placements without being able
to rebuild or wipe the facility; **reset** (the irreversible working-dir wipe) tightens that one
step further and additionally requires a superuser (enforced in `imports.ResetView`). These are
referenced from `frontend_api`, `imports`, `views`, and `navigation`.
`view_facilitymapblob` (`VIEW_PERM`) is Django's auto-created view permission for the
plain `FacilityMapBlob` model — it has always gated the Map nav item's *visibility*
(`navigation.py`) but, by default, nothing enforces it at the view layer: map **reads** are
login-only, so any authenticated user sees every floor plan (DESIGN §9 item 5).

`MapReadAccessMixin` makes that gate *optional and additive*. With the default
`require_view_permission=False` it is pure `LoginRequiredMixin` — no behaviour change. When an
operator sets `require_view_permission=True` in `PLUGINS_CONFIG`, the map-read entry points
(the map page, the authenticated manifest/media, and the blob JSON) additionally require
`view_facilitymapblob`. Editors (`change_facilitymapblob`) are accepted too — Django perms are
independent, so an editor does not automatically hold the view perm, and must not lose read
access. The dcim-page panels and the dashboard widget consult `may_view_map` directly to degrade
to no-panel / an empty state rather than emitting broken images or a raw 403.

This is a **flat, model-level** gate: `FacilityMapBlob` is not a `NetBoxModel`, so it carries no
per-object constraints (unlike `Room`, which stays `restrict()`-scoped independently).

**Per-Site read scoping (`scope_reads_to_sites`, SEC-1)** is a *third, independent* layer stacked
on the two above. Off by default (no behaviour change). On, the floor-plan **pixels** and the
**manifest** are additionally scoped to the Sites a viewer may see: a building whose Site the
user's object permissions hide is dropped from the manifest and its `images/<siteSlug>/…` media
404s. Unlike the flat `view_facilitymapblob` gate this *is* object-permission scoping — it runs
`dcim.Site.objects.restrict(user, 'view')` (via `facilities.facility_site_slugs`) per read, so it
composes with, rather than replaces, the login/flat-perm layers. `may_view_map_for_site` is the
panel-side check (a Location/device/rack whose Site the user can't view shows no plan). It is
**fail-closed**: a building whose `siteSlug` resolves to no viewable Site is hidden. Scoping the
raw annotation/placement blob geometry is a deeper, still-open follow-up — this layer covers the
rendered pixels + manifest, not the blob JSON.
"""

from django.contrib.auth.mixins import LoginRequiredMixin
from django.core.exceptions import PermissionDenied

from netbox.plugins import get_plugin_config

EDIT_PERM = 'netbox_facilitymap.change_facilitymapblob'
# Custom permission gating the destructive import surface (import wizard + Settings page); see
# `FacilityMapBlob.Meta.permissions`. Reset is stricter still — it also requires a superuser.
IMPORT_PERM = 'netbox_facilitymap.import_facilitymapblob'
VIEW_PERM = 'netbox_facilitymap.view_facilitymapblob'


def map_reads_gated():
    """True when the operator has opted map reads into `view_facilitymapblob` gating."""
    return bool(get_plugin_config('netbox_facilitymap', 'require_view_permission'))


def reads_scoped_to_sites():
    """True when the operator has opted floor-plan/manifest reads into per-Site object-permission
    scoping (`scope_reads_to_sites`, SEC-1). Off by default — the pixels/manifest stay visible to
    anyone who clears the flat map-read gate above; on, they are additionally filtered to the
    viewer's viewable Sites (see `ManifestView`/`MediaView` and `may_view_map_for_site`)."""
    return bool(get_plugin_config('netbox_facilitymap', 'scope_reads_to_sites'))


def may_view_map(user):
    """Whether `user` may read the map. Login-only unless `require_view_permission` is on, in
    which case the user must hold the view permission (or — since editors and importers read too —
    the change or import permission)."""
    return user.is_authenticated and (
        not map_reads_gated()
        or user.has_perm(VIEW_PERM)
        or user.has_perm(EDIT_PERM)
        or user.has_perm(IMPORT_PERM))


def may_view_map_for_site(user, site):
    """Whether `user` may see the floor-plan panel for `site` — `may_view_map` plus, when per-Site
    scoping is on, an object-permission check that `site` itself is viewable. The panel-side
    counterpart to `ManifestView`/`MediaView`'s slug filtering, used where the plan's Site is a
    *related* object (a floor Location, or a device/rack's site) that NetBox's own page permission
    doesn't already imply. **Fail-closed** under scoping: a `None` site (unresolvable) yields
    False. With scoping off this is exactly `may_view_map` — no extra query."""
    if not may_view_map(user):
        return False
    if not reads_scoped_to_sites():
        return True
    from dcim.models import Site
    return site is not None and Site.objects.restrict(user, 'view').filter(pk=site.pk).exists()


class MapReadAccessMixin(LoginRequiredMixin):
    """`LoginRequiredMixin` plus the optional `view_facilitymapblob` gate.

    An anonymous request still falls through to `LoginRequiredMixin`'s login redirect; an
    authenticated request that fails the (config-gated) view check gets a 403 via
    `PermissionDenied`. When gating is off this is exactly `LoginRequiredMixin`."""

    def dispatch(self, request, *args, **kwargs):
        if request.user.is_authenticated and not may_view_map(request.user):
            raise PermissionDenied('You do not have permission to view the facility map.')
        return super().dispatch(request, *args, **kwargs)
