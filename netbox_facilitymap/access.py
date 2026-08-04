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
**fail-closed**: a building whose `siteSlug` resolves to no viewable Site is hidden.

The layer covers the **blob geometry** too (SEC-2): with scoping on, the annotation/placement/
layout/siteplan documents and the to-do reads are filtered to the same viewable-Site set, so a
hidden Site leaks neither its pixels nor its room polygons, labels, markers or to-dos.
`viewable_site_slugs` resolves that set once per read; `scope_manifest` applies it to the manifest
(dropping whole buildings) and `scope_floor_keys` to the per-floor sharded kinds (a `floor_key`'s
first segment is its Site slug). All three live here, shared by `imports`, `frontend_api` and the
tokened REST reads in `api/views.py`, so the convention can't drift — in particular so a tokened
read is never a way around the scoping the browser is held to.

**The scoping axis is `dcim.Site`, and only `dcim.Site`.** `tenancy.Tenant` is *not* a boundary
here — the plugin never reads it, and a Tenant constraint on a user's object permissions affects
the map only insofar as it already narrows which Sites they may view. Modelling Tenant as a
scoping axis of its own would be a separate design decision, not an extension of this layer.
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


def viewable_site_slugs(user, facility):
    """The Site slugs within `facility` that `user` may view — the per-Site read-scope set shared by
    every scoped read (`imports`' manifest/media and `frontend_api`'s geometry/to-do reads).

    `None` when `scope_reads_to_sites` is off, which every caller treats as "filter nothing", so the
    default read path costs no query and returns byte-identical responses. Otherwise a set (possibly
    empty → the user may see nothing here), resolved through `dcim.Site.objects.restrict(user,
    'view')` so it honours object permissions. One query per scoped read; `facilities` is imported
    lazily to keep this module free of plugin-internal import order concerns."""
    if not reads_scoped_to_sites():
        return None
    from .facilities import facility_site_slugs
    return facility_site_slugs(facility, user=user)


def may_view_site_slug(user, slug):
    """Whether per-Site read scoping admits the Site named by `slug` — the single-slug counterpart
    to `viewable_site_slugs`, for a read that already names exactly one Site (a `floor_key` embeds
    its Site slug, so a per-floor read needs no facility-wide set). `True` with scoping off, and
    with it on **fail-closed**: an empty or unmatched slug is not viewable."""
    if not reads_scoped_to_sites():
        return True
    from dcim.models import Site
    return bool(slug) and Site.objects.restrict(user, 'view').filter(slug=slug).exists()


def scope_manifest(manifest, viewable):
    """A copy of `manifest` with its `buildings` filtered to those whose `siteSlug` is in `viewable`
    (a floor plan lives at `images/<siteSlug>/…`, so the slug is the Site key). Fail-closed: a
    building whose Site is not viewable — including one whose siteSlug matches no Site at all — is
    dropped. The campus `siteplan` is a facility-wide asset, kept while the user may view any Site
    and dropped when they may view none. `viewable` is never `None` here (the caller guards on the
    scoping flag). The input dict is shared/read-only (`read_manifest`'s memo), so this copies.

    Lives here rather than in `imports` because both manifest readers share it: the page-mount
    `serving.ManifestView` and the tokened REST `api.views.ManifestView` (API-1)."""
    scoped = dict(manifest)
    scoped['buildings'] = [b for b in manifest.get('buildings', [])
                           if b.get('siteSlug') in viewable]
    if not viewable:
        scoped['siteplan'] = None
    return scoped


def scope_floor_keys(keys, viewable):
    """The subset of `keys` (per-floor shard keys / `Room.floor_key`s) whose Site the viewer may see.

    A `floor_key`'s **first** segment is always its Site slug — for both the 2-segment Site-anchored
    and 3-segment Location-anchored shapes (`models.parse_floor_key`, MODEL-3) — so the per-floor
    sharded blob kinds are scoped by dropping whole rows, with no extra query. **Fail-closed**, like
    the manifest filter: a malformed key, or one whose slug matches no viewable Site, is dropped.
    `viewable is None` (scoping off) returns `keys` unchanged."""
    if viewable is None:
        return list(keys)
    return [k for k in keys if k.split('/')[0] in viewable]


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
