"""Resolve which **facility** a NetBox object belongs to, and enumerate facilities (MULTI-2).

A *facility* namespaces a whole map — its working dir (`storage.work_dir(facility)`), its blob
rows (`FacilityMapBlob.facility`), and its rendered media — so one install can map several
campuses. A facility is identified by a grouping **slug**: a `dcim.SiteGroup` (the default) or a
`dcim.Region`, chosen install-wide by the `facility_grouping` setting (MULTI-3 adds the wizard step;
until then it defaults to Site Group). The default facility is `''` — the flat working-dir root and
every pre-MULTI-2 blob row — so a single-facility install is byte-for-byte unchanged.

The server-rendered Location/Site/device/rack panels resolve *their* facility from the object's
**Site** (`facility_for_site`); the browser SPA passes it as a `?facility=` query param. This module
is the one place that knows the Site → facility mapping, shared by `imports.py`, `frontend_api.py`,
`previews.py`, `template_content.py`, and `health.py`, so the grouping rule can't drift across them.
"""

from django.db import transaction
from django.db.models import Q

from dcim.models import Region, Site, SiteGroup

from .models import FacilityMapBlob
from .storage import MANIFEST_NAME, move_facility, valid_facility, work_dir

#: Blob kinds that are per-facility *editor documents* (excludes the install-wide `settings` row,
#: which always lives at `facility=''`). These are what a facility "owns" and what the orphan
#: detector / reassignment operate on.
EDITOR_KINDS = ('annotations', 'siteplan', 'placements', 'layouts')

#: the install-wide grouping types a facility slug can name.
GROUPING_CHOICES = ('sitegroup', 'region')
GROUPING_DEFAULT = 'sitegroup'

# grouping type -> (Site FK attribute, grouping model). `Site.group` is the SiteGroup FK,
# `Site.region` the Region FK; both are nullable (an ungrouped site → the default facility).
_GROUPING = {
    'sitegroup': ('group', SiteGroup),
    'region': ('region', Region),
}


def grouping():
    """The configured grouping type (`'sitegroup'` | `'region'`), from the install-wide `settings`
    blob (`kind='settings', facility='', key=''`), clamped to `GROUPING_CHOICES` (default Site
    Group). MULTI-3 writes `facility_grouping`; an older blob without it falls back exactly like
    the `room_embed_*` defaults do."""
    blob = FacilityMapBlob.objects.filter(kind='settings', facility='', key='').first()
    value = (blob.data if blob else None) or {}
    chosen = value.get('facility_grouping')
    return chosen if chosen in GROUPING_CHOICES else GROUPING_DEFAULT


def clamp_default_facility(slug):
    """`slug` if it is currently a valid boot default — a non-empty facility that is both **reachable**
    (some Site resolves to it under the live grouping) and has **imported content** (a rendered
    manifest) — else `''` (the built-in default facility, i.e. no pin). Shared by the write path
    (`frontend_api.DefaultFacilitySettingView`, to clamp a submitted value) and the read path
    (`default_facility`, to degrade a pin that later went stale). The content gate keeps a pin from
    ever booting into an empty facility — which would just re-open the import wizard, the very nag
    SET-2 removes; the reachability gate drops a pin orphaned by a grouping change (HEALTH-1)."""
    return slug if slug and slug in reachable_facilities() and slug in imported_facility_slugs() else ''


def default_facility():
    """The facility the SPA boots into when the URL hash names none (`App.init`), from the install-wide
    `settings` blob (`kind='settings', facility='', key=''`, the `default_facility` key). `''` — the
    default facility, i.e. today's behaviour — when unset, or when the pinned slug no longer clamps to
    a reachable, content-having facility (see `clamp_default_facility`). Injected into `window.MAP` by
    `MapView`; the in-app Settings `select` reads/persists it (SET-2)."""
    blob = FacilityMapBlob.objects.filter(kind='settings', facility='', key='').first()
    value = (blob.data if blob else None) or {}
    return clamp_default_facility(value.get('default_facility'))


def facility_for_site(site, group=None):
    """The facility slug a Site belongs to — its `SiteGroup`/`Region` slug per the configured
    grouping — or `''` when the site is ungrouped or `None`. The resolution point for every
    server-rendered panel (a Location/device/rack resolves via its site)."""
    if site is None:
        return ''
    attr, _model = _GROUPING[group or grouping()]
    grouped = getattr(site, attr, None)
    return grouped.slug if grouped else ''


def facility_sites(facility, group=None, user=None):
    """The `Site` queryset belonging to `facility`.

    A non-empty facility → sites whose grouping FK slug equals it; the **default** facility `''` →
    sites whose grouping FK is **null** (the ungrouped remainder). That default makes a
    single-facility install (no grouping configured, so every site is ungrouped) resolve `''` to
    *all* sites — preserving today's global semantics. Object-permission scoped when `user` is given
    (else unrestricted, for the trusted command/health paths). The single source of truth for the
    facility→Site mapping: `facility_site_slugs` reduces it to slugs, and `frontend_api.NbSitesView`
    scopes the import wizard's building→Site search to it so an operator can't bind out-of-facility
    (FACIL-1)."""
    attr, _model = _GROUPING[group or grouping()]
    qs = Site.objects.restrict(user, 'view') if user is not None else Site.objects.all()
    return qs.filter(**{'%s__isnull' % attr: True} if not facility else {'%s__slug' % attr: facility})


def facility_site_slugs(facility, group=None, user=None):
    """The set of `Site.slug` belonging to `facility` (see `facility_sites` for the scoping rule).
    Used by `facility_floor_scope` to bound which floors — and so which `Room`/annotation rows —
    belong to a facility, for the facility-scoped room deletes in `frontend_api.sync_rooms`."""
    return set(facility_sites(facility, group=group, user=user).values_list('slug', flat=True))


def facility_floor_scope(facility, group=None, user=None):
    """A `Q` matching `Room` rows whose floor belongs to `facility`, or `None` when the facility has
    no sites. `floor_key` is `"<site.slug>/<floor.slug>"`, so the base match is an OR of
    `floor_key__startswith '<slug>/'` over the facility's site slugs — the scoping both
    `sync_rooms`' cross-floor delete and `compose_annotations` use to stay per-facility (Room has no
    facility column by design). It also unions the rename-proof `floor_location` FK
    (`floor_location__site__slug in <facility slugs>`, BIND-1) so a room whose Site was renamed —
    its frozen `floor_key` slug no longer matches, but its FK's site does — stays in its facility's
    scope. The union strictly *widens* the match and can't cross facilities (a Site belongs to one),
    so it never pulls another facility's rooms in, and null-FK rooms are still caught by the
    `floor_key` prefix."""
    slugs = facility_site_slugs(facility, group=group, user=user)
    if not slugs:
        return None
    q = Q(floor_location__site__slug__in=slugs)
    for slug in slugs:
        q |= Q(floor_key__startswith='%s/' % slug)
    return q


def imported_facility_slugs():
    """Slugs of facilities that have an imported map (a `manifest.json` in their working dir),
    including `''` for the default facility. A filesystem scan of the working-dir subfolders — the
    source of truth for "which facilities exist on disk", used by the picker and the health
    aggregation. Never raises (a missing/empty working dir yields the empty/default set)."""
    slugs = set()
    root = work_dir()
    if (root / MANIFEST_NAME).is_file():
        slugs.add('')
    try:
        children = list(root.iterdir())
    except OSError:
        return slugs
    for child in children:
        if child.is_dir() and (child / MANIFEST_NAME).is_file():
            slugs.add(child.name)
    return slugs


def list_facilities(user):
    """`{'grouping': <type>, 'facilities': [{slug, name, has_content}, …]}` for the SPA picker.

    Enumerates every grouping object the user may view (so an empty one can be picked to import a
    *new* facility), plus the default facility `''` ("Default facility") **only when it already has
    content**. `has_content` is whether that facility's working dir holds a rendered manifest.
    Content-having facilities sort first, then alphabetically — so a returning user lands among
    mapped facilities and a new one is still reachable below."""
    group = grouping()
    _attr, model = _GROUPING[group]
    imported = imported_facility_slugs()
    facilities = [{
        'slug': obj.slug,
        'name': obj.name,
        'has_content': obj.slug in imported,
    } for obj in model.objects.restrict(user, 'view')]
    if '' in imported:
        facilities.append({'slug': '', 'name': 'Default facility', 'has_content': True})
    facilities.sort(key=lambda f: (not f['has_content'], f['name'].lower()))
    return {'grouping': group, 'facilities': facilities}


# --- Orphaned-data detection & recovery (HEALTH-1) ------------------------------------------------
#
# Which facility a Site resolves to is a *live* function of the install-wide `facility_grouping`
# setting and the Site's own SiteGroup/Region — but nothing re-keys existing blob rows when that
# resolution changes. Flip the grouping, or give an ungrouped Site a group, and its editor blobs stay
# parked under the OLD `facility` key while the app now queries the NEW one, so the map reads as empty
# though the rows are intact (the data-safety invariant, CLAUDE.md §Data safety). These helpers detect
# that drift and re-key the stranded rows to a facility the operator chooses. `Room` has no facility
# column — its scoping is derived from its floor's site slug (`facility_floor_scope`), so a re-key of
# the blobs is enough; the rooms reappear under the target facility automatically (nothing to move).


def reachable_facilities(user=None):
    """The set of facility slugs some current Site resolves to under the live `grouping()`.

    Every Site resolves into this set: it's the slugs of the current grouping model (SiteGroup or
    Region), plus `''` when any Site is ungrouped (those resolve to the default facility). A
    siteless-but-existing grouping object is included, so a facility whose import is in progress
    (blobs written, sites not yet assigned) is never mis-flagged as orphaned. Unscoped by default —
    orphan detection is an authoritative, install-wide check (like the `facilitymap_check` path), so
    it must see every grouping object regardless of the viewer's object permissions."""
    attr, model = _GROUPING[grouping()]
    reachable = set(model.objects.values_list('slug', flat=True))
    sites = Site.objects.restrict(user, 'view') if user is not None else Site.objects.all()
    if sites.filter(**{'%s__isnull' % attr: True}).exists():
        reachable.add('')
    return reachable


def data_facility_keys():
    """Distinct `facility` values carrying an editor document — the facilities that hold map data.
    Excludes the install-wide `settings` row (always `facility=''`, not per-facility data)."""
    return set(FacilityMapBlob.objects.filter(kind__in=EDITOR_KINDS)
               .values_list('facility', flat=True).distinct())


def orphaned_facility_keys():
    """Facility keys that hold map data but no current Site resolves to — the drift a grouping change
    (or a Site newly gaining/losing a grouping) leaves behind. `''` is flagged only when no Site is
    ungrouped (i.e. the default facility's data is now unreachable)."""
    return data_facility_keys() - reachable_facilities()


def suggested_target(key):
    """The facility an orphaned `key`'s own data now points at, or `''` when it can't be inferred
    unambiguously — used to preselect the one-click-correct choice in the reassignment picker.

    Reads the key's `annotations`/`placements` floor keys (`"<site>/<floor>"`), resolves each site's
    *current* facility (`facility_for_site`), and returns it when the data's sites all agree on a
    single reachable target. Ambiguous (mixed sites) or unresolvable (sites gone) → `''`, leaving the
    operator to choose."""
    site_slugs = set()
    for blob in FacilityMapBlob.objects.filter(facility=key, kind__in=('annotations', 'placements')):
        for floor_key in (blob.data or {}):
            site_slug = floor_key.split('/', 1)[0]
            if site_slug:
                site_slugs.add(site_slug)
    if not site_slugs:
        return ''
    targets = {facility_for_site(s) for s in Site.objects.filter(slug__in=site_slugs)}
    targets &= reachable_facilities()
    return next(iter(targets)) if len(targets) == 1 else ''


def reachable_facility_choices():
    """`[{slug, name}, …]` of the facilities an operator may reassign orphaned data *to* — the
    reachable facilities, with display names, sorted by name. `''` renders as "Default facility".
    Feeds the Settings-page reassignment `<select>`."""
    _attr, model = _GROUPING[grouping()]
    reachable = reachable_facilities()
    choices = [{'slug': obj.slug, 'name': obj.name}
               for obj in model.objects.all() if obj.slug in reachable]
    if '' in reachable:
        choices.append({'slug': '', 'name': 'Default facility'})
    choices.sort(key=lambda c: c['name'].lower())
    return choices


def reassign_facility(old, new):
    """Re-key the editor blobs parked under orphaned facility `old` to reachable facility `new`, and
    move `old`'s rendered working-dir artifacts to `new`. The recovery path for the orphaning above.

    Validates that `new` is a current (reachable) facility and differs from `old`, that `old`
    actually holds map data, and — a **collision guard** — that `new` doesn't already hold a blob of
    any kind `old` carries (a re-key would violate the `(kind, facility, key)` uniqueness and clobber
    the target's data). The DB re-key runs in a transaction; the filesystem move
    (`storage.move_facility`) follows once the re-key is durable, so a mid-move failure leaves the
    authoritative DB state consistent and the operation safely re-runnable. `Room` rows are untouched
    (no facility column — they follow their floor's site slug). Returns the sorted list of re-keyed
    kinds. Raises `ValueError` on any validation failure."""
    old = valid_facility(old)
    new = valid_facility(new)
    if old == new:
        raise ValueError('source and target facility are the same')
    if new not in reachable_facilities():
        raise ValueError('target is not a current facility')
    moving = FacilityMapBlob.objects.filter(facility=old, kind__in=EDITOR_KINDS)
    kinds = set(moving.values_list('kind', flat=True))
    if not kinds:
        raise ValueError('no map data is stored under that facility')
    if FacilityMapBlob.objects.filter(facility=new, kind__in=kinds).exists():
        raise ValueError('the target facility already has map data — reassignment would overwrite it')
    # Pre-check the filesystem collision too (the target could have rendered images but no editor
    # data yet — an imported-but-undrawn facility). Checked *before* the DB re-key so both the DB and
    # working-dir mutations only proceed when both destinations are clear; otherwise the re-key would
    # commit and the move would then raise, stranding the images. `move_facility` keeps its own guard
    # for direct callers.
    if (work_dir(new) / MANIFEST_NAME).exists():
        raise ValueError('the target facility already has rendered content — reassignment would '
                         'overwrite it')
    with transaction.atomic():
        moving.update(facility=new)
    move_facility(old, new)
    return sorted(kinds)
