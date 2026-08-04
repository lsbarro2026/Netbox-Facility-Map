"""Resolve which **facility** a NetBox object belongs to, and enumerate facilities (MULTI-2).

A *facility* namespaces a whole map — its working dir (`storage.work_dir(facility)`), its blob
rows (`FacilityMapBlob.facility`), and its rendered media — so one install can map several
campuses. A facility is identified by a **slug**. Since the facility-identity redesign
(FACILITY-IDENTITY-DESIGN, Phase 1) the slug is resolved **assignment-first**: an explicit
plugin-owned Site→facility map (the install-wide `kind='facility_map'` blob, written by
`assign_facilities`) is consulted first, and only a Site *absent from the map* falls back to the
legacy derivation — its `dcim.SiteGroup` (the default) or `dcim.Region` slug, per the install-wide
`facility_grouping` setting (MULTI-3). An install that never assigns resolves byte-identically to
the pre-redesign behaviour, so there is no data migration; once a Site is assigned, its facility is
explicit plugin state and an org reorg can never re-key it (the HEALTH-1 trap, dissolved for
assigned Sites). The default facility is `''` — the flat working-dir root and every pre-MULTI-2
blob row — so a single-facility install is byte-for-byte unchanged.

A third grouping, **`location`** (MODEL-8), moves the facility axis *below* the Site for installs
whose whole estate lives under one campus Site: each **top-level `dcim.Location`** is its own
facility (slug-identified, its subtree the facility's scope). Resolution then runs through
`facility_for_location`/`facility_for_floor_key` (root-ancestor of a Location / of a floor key's
anchor), room scoping through the subtree rather than the shared campus Site
(`_location_floor_scope`), and the site-level fallback (`facility_for_site`) answers `''`. The
site-keyed assignment map still wins first in every mode — a whole-Site pin remains the escape
hatch — and facility identity in this mode is once again live external state (the Location tree),
so the HEALTH-1 detect+reassign machinery is its safety net: a root *rename* is auto-re-keyed
(`rename_location_facility`, dispatched from `signals`), a re-parent is caught by orphan detection.

The server-rendered Location/Site/device/rack panels resolve *their* facility from the object's
**Location** where it has one (`facility_for_location` — which under the Site-FK groupings is
exactly the Site resolution) or its **Site** (`facility_for_site`); the browser SPA passes it as a
`?facility=` query param. This module is the one place that knows the NetBox-object → facility
mapping, shared by `imports.py`, `frontend_api`, `previews.py`, `template_content.py`, and
`health.py`, so the resolution rule can't drift across them.

**Resolution reads two install-wide rows, and both are read once per request, never cached.** The
`settings` row (via `previews.PluginSettings`, the plugin's one reader for it) supplies the
grouping, the org modes and the default-facility pin; the `facility_map` row (via `facility_map()`)
supplies the assignments. A resolver that calls another therefore threads what it already read: the
settings readers take a `settings=` instance, and every hot resolver takes an `fmap=` dict beside
the `group=` it already took for the prospective-grouping case. That is what keeps a bulk caller —
`suggested_target` over a facility's floor keys, `site_facilities` over a campus Site's roots,
`grouping_change_preview` over the whole estate — at a constant number of row reads instead of one
per item. It is deliberately **threading, not caching**: every settings toggle promises to take
effect without a worker restart (see `PluginSettings`), which only holds while each request reads
the rows afresh.
"""

from django.db import transaction
from django.db.models import Q

from dcim.models import Location, Region, Site, SiteGroup

from .models import FacilityMapBlob, Room, parse_floor_key
from .previews import PluginSettings
from .storage import MANIFEST_NAME, SERVE_ROOTS, move_facility, valid_facility, work_dir

#: Blob kinds that are per-facility *editor documents* (excludes the install-wide `settings` row,
#: which always lives at `facility=''`). These are what a facility "owns" and what the orphan
#: detector / reassignment operate on.
EDITOR_KINDS = ('annotations', 'siteplan', 'placements', 'layouts')

#: the install-wide grouping types a facility slug can name. The first two group whole Sites by an
#: org-model FK; `location` (MODEL-8) instead makes each **top-level `dcim.Location`** under a Site
#: its own facility (its subtree is the facility's scope), for an estate modelled under one campus
#: Site — the one shape a Site-level grouping cannot split.
GROUPING_CHOICES = ('sitegroup', 'region', 'location')
GROUPING_DEFAULT = 'sitegroup'

# grouping type -> (Site FK attribute, grouping model). `Site.group` is the SiteGroup FK,
# `Site.region` the Region FK; both are nullable (an ungrouped site → the default facility).
# `location` deliberately has no entry — it is not a Site FK (the facility sits *below* the Site),
# so every `_GROUPING` consumer branches on it explicitly rather than pretending it fits the shape.
_GROUPING = {
    'sitegroup': ('group', SiteGroup),
    'region': ('region', Region),
}


def _facility_roots(slug=None, site=None):
    """Top-level Locations (`parent IS NULL`) — the objects that *are* facilities under the
    `location` grouping. Reserved slugs (`SERVE_ROOTS`) are excluded here, at the enumeration
    root, because such a slug can never pass `storage.valid_facility` and so can never name a
    working-dir subfolder; NetBox slugs otherwise always satisfy the strict-slug regex. Unscoped
    (facility membership is an install-wide fact, like `reachable_facilities`); callers that owe
    the viewer object-permission scoping apply their own `restrict()`."""
    qs = Location.objects.filter(parent__isnull=True).exclude(slug__in=SERVE_ROOTS)
    if slug is not None:
        qs = qs.filter(slug=slug)
    if site is not None:
        qs = qs.filter(site=site)
    return qs


def grouping(settings=None):
    """The configured grouping type (`'sitegroup'` | `'region'`), from the install-wide `settings`
    blob (`kind='settings', facility='', key=''`), clamped to `GROUPING_CHOICES` (default Site
    Group). MULTI-3 writes `facility_grouping`; an older blob without it falls back exactly like
    the `room_embed_*` defaults do.

    Read through `previews.PluginSettings` — the one reader of that row — so a caller holding an
    instance passes it as `settings` and pays a single row query for this and every other setting
    it reads. The clamp stays here, where `GROUPING_CHOICES` lives."""
    chosen = (settings or PluginSettings()).get('facility_grouping')
    return chosen if chosen in GROUPING_CHOICES else GROUPING_DEFAULT


#: How a facility's DCIM tree is organized (MODEL-6) — a *declaration of intent*, per facility.
#:
#:   * `site-as-building`  each building is its own `dcim.Site`; floors are that Site's top-level
#:                         Locations. Today's default, 2-segment floor keys.
#:   * `site-as-campus`    one Site is the campus; each building is a `dcim.Location` under it and
#:                         floors are that Location's children (BUILDING-ANCHOR-DESIGN §4.1).
#:                         Location-anchored, 3-segment floor keys.
#:
#: Both shapes already *work* — `models.parse_floor_key` and every resolver read either key length.
#: What the mode adds is the operator saying which one this facility uses, so the import wizard can
#: stop inferring the anchor from whichever autocomplete hit was clicked. It is deliberately
#: **advisory, not enforcing**: a facility may legitimately mix anchors (design §8 open-q 3) and the
#: key scheme supports that by construction, so setting the mode never re-keys or invalidates
#: anything already built — it only steers new writes.
ORG_MODE_CHOICES = ('site-as-building', 'site-as-campus')
ORG_MODE_DEFAULT = 'site-as-building'


def org_modes(settings=None):
    """The per-facility organization modes `{facility_slug: mode}`, from the `facility_org_modes` key
    of the install-wide `settings` blob, or `{}` when none has ever been set.

    Per *facility*, but stored in the one install-wide row rather than a per-facility `settings` row:
    `settings` is install-wide by construction (MULTI-1, and `frontend_api.merge_settings` addresses
    it by its full `facility=''` key), so the per-facility axis lives *inside* the document as a map —
    the `facility_map()` idiom. A facility absent from the map is `ORG_MODE_DEFAULT`, so an install
    that never sets a mode reads exactly as before and nothing migrates.

    Entries are validated on write (`set_org_mode`); the reader still drops anything that isn't a
    slug→known-choice pair, so a hand-edited row degrades to "unset" rather than propagating a mode
    no consumer understands — the same defensive stance as `grouping()`'s clamp.

    Takes a `previews.PluginSettings` to read through, like `grouping()`."""
    data = (settings or PluginSettings()).get('facility_org_modes') or {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items()
            if isinstance(k, str) and v in ORG_MODE_CHOICES}


def org_mode(facility='', settings=None):
    """The organization mode one facility is declared to use, defaulting to `ORG_MODE_DEFAULT`.

    Under the `location` grouping (MODEL-8) every facility reads as `site-as-campus`, whatever the
    stored map says: a Location-subtree facility lives under a campus Site by construction, so the
    campus-shaped wizard steering (MODEL-7) is the only one that fits. Still advisory — the override
    steers defaults exactly like a stored mode would; it validates and re-keys nothing — and the
    stored per-facility entries are left untouched, so switching the grouping back restores them.

    Both settings it consults live in the same row, so one instance serves both reads — this costs
    a single query, not the two the separate readers would each issue."""
    settings = settings or PluginSettings()
    if grouping(settings) == 'location':
        return 'site-as-campus'
    return org_modes(settings).get(facility, ORG_MODE_DEFAULT)


def set_org_mode(facility, mode):
    """Record `facility`'s organization mode and return the saved `{facility: mode}` map.

    The **one** write path (the `api/settings/org-mode` endpoint lands here). Validates `mode`
    against `ORG_MODE_CHOICES` and `facility` through `storage.valid_facility` — the same guardrail
    `assign_facilities` applies, since a facility slug names a working-dir subfolder — and raises
    `ValueError` before any write on either failure.

    The read-modify-write runs under `select_for_update()` in a transaction rather than going through
    `merge_settings`: the value is a *nested* map, so a bare merge of the whole dict would clobber
    every other facility's mode written since the read. Persisting via `_save_install_blob` keeps the
    AUDIT-1 snapshot-before-overwrite (before/after diff, no-op suppression) and leaves the sibling
    settings keys (`room_embed_*`, `facility_grouping`, …) untouched."""
    if mode not in ORG_MODE_CHOICES:
        raise ValueError('mode must be one of: %s' % ', '.join(ORG_MODE_CHOICES))
    if not isinstance(facility, str):
        raise ValueError('facility must be a slug string')
    facility = valid_facility(facility)
    with transaction.atomic():
        row = (FacilityMapBlob.objects.select_for_update()
               .filter(kind='settings', facility='', key='').first())
        data = dict((row.data if row else None) or {})
        modes = dict(data.get('facility_org_modes') or {})
        modes[facility] = mode
        data['facility_org_modes'] = modes
        _save_install_blob('settings', row, data)
    return modes


def _save_install_blob(kind, row, data):
    """Persist one of the two install-wide documents this module owns — `kind='settings'` or
    `kind='facility_map'` — through the AUDIT-1 snapshot-before-overwrite path (the
    `frontend_api._save_blob` idiom, inlined here because `frontend_api` imports this module).
    `row` is the existing row fetched under `select_for_update()`, or `None` on first write.

    One helper for both kinds because the dance is identical and only the `kind` literal differed:
    the pre-overwrite `snapshot()` is what makes the write produce a before/after `ObjectChange`
    diff, and having it written once means neither kind can quietly lose it. The row is addressed by
    its **full** install-wide key (`facility=''`, `key=''`, MULTI-1), never a loose `kind` match.

    The settings write this covers is the one this module owns — the nested `facility_org_modes`
    map (and a `default_facility` re-key), which `frontend_api.merge_settings`' flat merge can't
    express safely; every other settings write still goes through that helper."""
    if row is None:
        return FacilityMapBlob.objects.create(kind=kind, facility='', key='', data=data)
    row.snapshot()
    row.data = data
    row.save()
    return row


def facility_map():
    """The explicit Site→facility assignment map `{site_slug: facility_slug}`, from the install-wide
    `facility_map` blob (`kind='facility_map', facility='', key=''`), or `{}` when no assignment has
    ever been made. The plugin-owned half of facility resolution (FACILITY-IDENTITY-DESIGN §4.1):
    `facility_for_site` consults it before falling back to the SiteGroup/Region derivation. Entries
    are validated on write (`assign_facilities`); the reader still clamps to string→string pairs so
    a hand-edited row degrades to "unassigned" rather than propagating garbage — the same defensive
    stance as `grouping()`'s choice clamp.

    The row's reader, and cheap enough to call once — but not once *per resolution*, which is why
    every hot resolver below takes the result as `fmap=` (see `_assignments`) rather than calling
    back here. It stays a plain function returning a plain dict: the document is one flat map with
    one clamp, so an accessor class would wrap a single value and the threading is what actually
    collapses the reads."""
    blob = FacilityMapBlob.objects.filter(kind='facility_map', facility='', key='').first()
    data = (blob.data if blob else None) or {}
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}


def _assignments(fmap=None):
    """The assignment map a resolver should use: `fmap` when the caller already read it, else a
    fresh read. Every `fmap=`-taking resolver starts here.

    Tests `is None` rather than truthiness on purpose — `{}` is a perfectly valid map (an install
    that has never assigned a Site), and treating it as "not supplied" would re-query the row at
    every hop of exactly the un-assigned install the threading is meant to keep cheap."""
    return facility_map() if fmap is None else fmap


def assign_facilities(updates):
    """Merge `updates` — `{site_slug: facility_slug | None}` — into the assignment map and return
    the saved map. `None` removes a Site's entry (it reverts to the grouping derivation); `''`
    explicitly assigns the default facility. The **one** write path for facility assignments
    (Phase 2's wizard surface and the `NbFacilityAssignmentsView` endpoint both land here).

    Every assigned value passes `storage.valid_facility` before it can later name a working-dir
    subfolder (FACILITY-IDENTITY-DESIGN guardrail 2), and every *assigning* key must be a live
    `Site.slug` — but a `None` (removal) key is not liveness-checked, so a stale entry for a
    since-deleted Site can always be cleaned up. The read-modify-write runs under
    `select_for_update()` in a transaction (the `merge_settings` idiom) so concurrent writers can't
    drop each other's entries. Raises `ValueError` on any validation failure, before any write."""
    if not isinstance(updates, dict) or not updates:
        raise ValueError('assignments must be a non-empty object of {site_slug: facility_slug}')
    cleaned = {}
    for site_slug, value in updates.items():
        if not isinstance(site_slug, str) or not site_slug:
            raise ValueError('site slug must be a non-empty string')
        if value is not None and not isinstance(value, str):
            raise ValueError('facility must be a slug string or null')
        cleaned[site_slug] = value if value is None else valid_facility(value)
    assigning = [s for s, v in cleaned.items() if v is not None]
    live = set(Site.objects.filter(slug__in=assigning).values_list('slug', flat=True))
    unknown = sorted(set(assigning) - live)
    if unknown:
        raise ValueError('unknown site slug(s): %s' % ', '.join(unknown))
    with transaction.atomic():
        row = (FacilityMapBlob.objects.select_for_update()
               .filter(kind='facility_map', facility='', key='').first())
        data = dict((row.data if row else None) or {})
        for site_slug, value in cleaned.items():
            if value is None:
                data.pop(site_slug, None)
            else:
                data[site_slug] = value
        _save_install_blob('facility_map', row, data)
    return data


def rename_site_assignment(old_slug, new_slug):
    """Re-key the assignment map entry for a Site whose slug changed — the map's half of the
    HEALTH-4 rename remap (`signals._on_site_saved` dispatches it beside the manifest/floor-key
    remap). Returns True when an entry moved, False when the old slug held none (the idempotent
    no-op every remap store operation shares). Raises `ValueError` when the new slug already holds
    an assignment — a collision is left for the operator, mirroring `storage.rename_image_subdir`."""
    with transaction.atomic():
        row = (FacilityMapBlob.objects.select_for_update()
               .filter(kind='facility_map', facility='', key='').first())
        data = dict((row.data if row else None) or {})
        if old_slug not in data:
            return False
        if new_slug in data:
            raise ValueError('an assignment for %r already exists' % new_slug)
        data[new_slug] = data.pop(old_slug)
        _save_install_blob('facility_map', row, data)
    return True


def clamp_default_facility(slug):
    """`slug` if it is currently a valid boot default — a non-empty facility that is both **reachable**
    (some Site resolves to it under the live grouping) and has **imported content** (a rendered
    manifest) — else `''` (the built-in default facility, i.e. no pin). Shared by the write path
    (`frontend_api.DefaultFacilitySettingView`, to clamp a submitted value) and the read path
    (`default_facility`, to degrade a pin that later went stale). The content gate keeps a pin from
    ever booting into an empty facility — which would just re-open the import wizard, the very nag
    SET-2 removes; the reachability gate drops a pin orphaned by a grouping change (HEALTH-1)."""
    return slug if slug and slug in reachable_facilities() and slug in imported_facility_slugs() else ''


def default_facility(settings=None):
    """The facility the SPA boots into when the URL hash names none (`App.init`), from the install-wide
    `settings` blob (`kind='settings', facility='', key=''`, the `default_facility` key). `''` — the
    default facility, i.e. today's behaviour — when unset, or when the pinned slug no longer clamps to
    a reachable, content-having facility (see `clamp_default_facility`). Injected into `window.MAP` by
    `MapView`; the in-app Settings `select` reads/persists it (SET-2). `MapView` already holds a
    `PluginSettings` for its own flags and passes it here, so the pin costs no extra row query."""
    return clamp_default_facility((settings or PluginSettings()).get('default_facility'))


def _derive_from_grouping(site, group=None):
    """The legacy derivation — the Site's `SiteGroup`/`Region` slug per `group` (the live grouping
    when omitted), `''` when it is ungrouped. Since the facility-identity redesign this is only the
    **seed** `facility_for_site` falls back to on an assignment-map miss (§4.2), never the source of
    truth for an assigned Site. Factored out so the grouping-change preview can evaluate it under a
    *prospective* grouping without restating the rule this module exists to own.

    Under the `location` grouping a Site has no single derived facility — one campus Site hosts a
    facility per top-level Location — so the site-level derivation is always `''`. The real
    resolution runs below the Site, through `facility_for_location`/`facility_for_floor_key`; this
    fallback answers only the site-shaped questions (a siteless panel, a 2-segment legacy key)."""
    group = group or grouping()
    if group == 'location':
        return ''
    attr, _model = _GROUPING[group]
    grouped = getattr(site, attr, None)
    return grouped.slug if grouped else ''


def facility_for_site(site, group=None, fmap=None):
    """The facility slug a Site belongs to — **assignment-first, derive-on-miss**
    (FACILITY-IDENTITY-DESIGN §4.2). An explicit entry in the assignment map wins (including an
    explicit `''`); a Site absent from the map derives its `SiteGroup`/`Region` slug per the
    configured grouping, `''` when ungrouped or `None`. With no map at all every Site derives, so
    an un-migrated install resolves byte-identically to the pre-redesign behaviour. The resolution
    point for every server-rendered panel (a Location/device/rack resolves via its site).

    `fmap` passes in an already-read assignment map — the resolution point being on every panel
    render is exactly why a caller resolving *several* objects must read the row once and thread it
    (`site_facilities`, `suggested_target`, `grouping_change_preview` all do)."""
    if site is None:
        return ''
    assigned = _assignments(fmap).get(site.slug)
    if assigned is not None:
        return assigned
    return _derive_from_grouping(site, group)


def facility_for_location(loc, group=None, fmap=None):
    """The facility slug a `dcim.Location` belongs to — the below-Site resolver the `location`
    grouping needs (MODEL-8), safe to call under any grouping.

    Assignment-first like `facility_for_site` (an explicit Site→facility entry pins the whole Site,
    the escape hatch the map has always been); on a miss, under the `location` grouping the
    facility is the slug of `loc`'s **root ancestor** (the top-level Location whose subtree it sits
    in — `loc` itself when it is top-level), `''` when that slug is reserved and can't name a
    facility. Under the Site-FK groupings this is exactly `facility_for_site(loc.site)`, so callers
    that hold a Location (the Location-page panels, `health.floor_plan_drift`) can resolve through
    here unconditionally without a mode branch of their own.

    `fmap` threads an already-read assignment map, like `facility_for_site`."""
    if loc is None:
        return ''
    group = group or grouping()
    fmap = _assignments(fmap)
    if group != 'location':
        return facility_for_site(getattr(loc, 'site', None), group, fmap)
    site = getattr(loc, 'site', None)
    assigned = fmap.get(site.slug) if site is not None else None
    if assigned is not None:
        return assigned
    root = loc if not loc.parent_id else loc.get_ancestors().first()
    try:
        return valid_facility(root.slug)
    except ValueError:
        return ''


def facility_for_floor_key(floor_key, group=None, fmap=None):
    """The facility slug a `floor_key` belongs to — the key-shaped resolver (MODEL-8), safe under
    any grouping.

    A 3-segment key names its anchor Location (`parse_floor_key` segment −2, always the floor's
    direct parent — MULTI-5), so under the `location` grouping the key's facility is that anchor's
    root ancestor via `facility_for_location` — correct for a wing tree, where the anchor sits
    *inside* the facility subtree rather than being its root. A 2-segment key, an anchor that no
    longer resolves, or a Site-FK grouping all fall back to the site-level resolution
    (`facility_for_site` on the key's first segment, `''` when that Site is gone). Used where a
    store row is addressed by its floor key alone (`frontend_api.touch_floor_version`) and by
    `suggested_target`, so orphaned data points at the facility its keys resolve to under the mode
    being evaluated. `fmap` threads an already-read assignment map, like the two resolvers it
    delegates to — which matters here more than anywhere: this is the per-key resolver bulk callers
    loop over.

    Note the answer depends on the key's **first two** segments only, never the floor segment, so a
    caller resolving many keys can collapse them to their distinct `(site, building)` prefixes first
    — what `suggested_target` does."""
    group = group or grouping()
    fmap = _assignments(fmap)
    site_slug, building_slug, _floor_slug = parse_floor_key(floor_key)
    if group == 'location' and building_slug:
        anchor = Location.objects.filter(site__slug=site_slug, slug=building_slug).first()
        if anchor is not None:
            return facility_for_location(anchor, group, fmap)
    site = Site.objects.filter(slug=site_slug).first() if site_slug else None
    return facility_for_site(site, group, fmap)


def site_facilities(site, group=None, fmap=None):
    """Every facility slug whose stores may hold `site`'s content — the multi-valued sibling of
    `facility_for_site` the `location` grouping makes necessary (MODEL-8). Under the Site-FK
    groupings this is just `{facility_for_site(site)}`; under `location` it adds one facility per
    top-level Location the Site hosts (via `facility_for_location`, so a whole-Site assignment
    still collapses them to the pinned value). Shared by the Site-page floor picker
    (`template_content.SiteFloors`) and the Site-rename remap dispatch (`signals`), both of which
    must reach every manifest that names this Site rather than a single site-resolved one.

    The assignment map is read **once** for the whole fan-out — a campus Site with twenty top-level
    Locations resolves them all against one read, not twenty."""
    group = group or grouping()
    fmap = _assignments(fmap)
    slugs = {facility_for_site(site, group, fmap)}
    if group == 'location' and site is not None:
        for root in _facility_roots(site=site):
            slugs.add(facility_for_location(root, group, fmap))
    return slugs


def facility_sites(facility, group=None, user=None, fmap=None):
    """The `Site` queryset belonging to `facility`.

    A non-empty facility → sites whose grouping FK slug equals it; the **default** facility `''` →
    sites whose grouping FK is **null** (the ungrouped remainder). That default makes a
    single-facility install (no grouping configured, so every site is ungrouped) resolve `''` to
    *all* sites — preserving today's global semantics. Object-permission scoped when `user` is given
    (else unrestricted, for the trusted command/health paths). The single source of truth for the
    facility→Site mapping: `facility_site_slugs` reduces it to slugs, and `frontend_api.NbSitesView`
    scopes the import wizard's building→Site search to it so an operator can't bind out-of-facility
    (FACIL-1).

    Assignment-aware, the inverse of `facility_for_site`: a Site explicitly assigned to `facility`
    always matches; a Site assigned *elsewhere* never matches (even when its grouping derives here);
    an unassigned Site matches by the derivation above. With no assignment map this reduces exactly
    to the derivation filter, preserving the single-facility "`''` = all ungrouped sites"
    semantics.

    Under the `location` grouping a non-empty facility's Sites are those **hosting** a top-level
    Location with its slug (usually exactly one campus Site — the set the import wizard's bind
    search must offer, FACIL-1); "ungrouped" means *no top-level Locations at all*, so `''` is the
    Sites the tree gives no facility. That is deliberately narrower than `facility_for_site`'s
    site-level fallback (which answers `''` for every unassigned Site, campus Sites included): a
    campus Site *hosts* several facilities without *belonging* to `''`, and letting `''` claim it
    would hand the default facility's floor scope another facility's rooms."""
    group = group or grouping()
    qs = Site.objects.restrict(user, 'view') if user is not None else Site.objects.all()
    if group == 'location':
        hosting = _facility_roots(slug=facility or None).values('site')
        derived = Q(pk__in=hosting) if facility else ~Q(pk__in=hosting)
    else:
        attr, _model = _GROUPING[group]
        derived = Q(**{'%s__isnull' % attr: True} if not facility else {'%s__slug' % attr: facility})
    fmap = _assignments(fmap)
    if not fmap:
        return qs.filter(derived)
    assigned_here = [s for s, f in fmap.items() if f == facility]
    return qs.filter(Q(slug__in=assigned_here) | (derived & ~Q(slug__in=list(fmap))))


def facility_site_slugs(facility, group=None, user=None, fmap=None):
    """The set of `Site.slug` belonging to `facility` (see `facility_sites` for the scoping rule).
    Used by `facility_floor_scope` to bound which floors — and so which `Room`/annotation rows —
    belong to a facility, for the facility-scoped room deletes in `frontend_api.sync_rooms`."""
    return set(facility_sites(facility, group=group, user=user, fmap=fmap)
               .values_list('slug', flat=True))


def site_floor_scope(slugs):
    """A `Q` matching `Room` rows whose floor belongs to one of `slugs` (a set of `Site.slug`), or
    `None` for an empty set. The one place that knows *how* a room maps back to its **Site**, shared
    by `facility_floor_scope` below and the `RoomFilterSet` site filters (API-1) so the two can't
    drift. Since MODEL-8 the Site is no longer always the facility axis — a `location`-grouping
    facility scopes by subtree (`_location_floor_scope`), not by Site — so this answers "this
    Site's rooms", never "this facility's rooms"; only `facility_floor_scope` knows which of the
    two axes a facility scopes by.

    `floor_key`'s **first** segment is always the site slug — for both the 2-segment Site-anchored
    `"<site.slug>/<floor.slug>"` and the 3-segment Location-anchored
    `"<site.slug>/<building.slug>/<floor.slug>"` shapes (MODEL-3) — so the base match is an OR of
    `floor_key__startswith '<slug>/'`, correct for either shape. It also unions the rename-proof
    `floor_location` FK (`floor_location__site__slug in <slugs>`, BIND-1) so a room whose Site was
    renamed — its frozen `floor_key` slug no longer matches, but its FK's site does — still
    matches. The union strictly *widens* the match, and null-FK rooms are still caught by the
    `floor_key` prefix.

    **Not a security boundary.** Because it is a union, a stale key prefix naming an in-scope Site
    admits a room whose FK names an out-of-scope one. That is the right trade for "show me this
    Site's rooms" but wrong for read scoping — `frontend_api._scope_rooms` deliberately makes the
    FK authoritative instead."""
    if not slugs:
        return None
    q = Q(floor_location__site__slug__in=slugs)
    for slug in slugs:
        q |= Q(floor_key__startswith='%s/' % slug)
    return q


def _subtree_pairs(facility):
    """`[(pk, site_slug, slug), …]` for every Location in `facility`'s subtree(s) under the
    `location` grouping — root(s) included, one MPTT descendants query per root. The raw material
    both the floor scope (FK ids + key prefixes) and `facility_location_pks` reduce."""
    pairs = []
    for root in _facility_roots(slug=facility):
        pairs += list(root.get_descendants(include_self=True)
                      .values_list('pk', 'site__slug', 'slug'))
    return pairs


def facility_location_pks(facility):
    """The `dcim.Location` pks inside a `location`-grouping facility's subtree(s) — the
    facility-membership bound the wizard's building search and the finder's unplaced-inventory
    search narrow by (`frontend_api.NbBuildingLocationsView`/`NbInventoryView`). Facility
    membership only, never a permission scope: callers keep their own `restrict()`."""
    return {pk for pk, _site, _slug in _subtree_pairs(facility)}


def _location_floor_scope(facility, fmap=None):
    """The `location`-grouping half of `facility_floor_scope`: a `Q` matching `Room` rows of a
    non-empty facility, or `None` when it scopes nothing.

    Three unioned matches, mirroring `site_floor_scope`'s FK∪prefix stance one level down: the
    rename-proof `floor_location` FK against the subtree's Locations; a `floor_key` prefix
    `"<site>/<loc>/"` per subtree Location (segment −2 is always the floor's *direct parent* —
    MULTI-5 — so any subtree Location may be an anchor, and the prefix is site-qualified so a
    same-slug Location under another Site never matches); plus the whole-Site scope of any Site
    explicitly *assigned* to this facility. Deliberately **never** the facility's own hosting
    Site's slugs — that is the shortcut this mode exists to retire: several facilities share the
    campus Site, and a site-wide Q would hand one facility's `sync_rooms` sweep its siblings'
    rooms. Like `site_floor_scope`, a widening union — not a security boundary."""
    pairs = _subtree_pairs(facility)
    assigned = {s for s, f in _assignments(fmap).items() if f == facility}
    q = site_floor_scope(assigned)
    if pairs:
        sub = Q(floor_location_id__in=[pk for pk, _site, _slug in pairs])
        for _pk, site_slug, slug in pairs:
            sub |= Q(floor_key__startswith='%s/%s/' % (site_slug, slug))
        q = sub if q is None else q | sub
    return q


def facility_floor_scope(facility, group=None, user=None, fmap=None):
    """A `Q` matching `Room` rows whose floor belongs to `facility`, or `None` when the facility
    scopes nothing. The scoping both `sync_rooms`' cross-floor delete and `compose_annotations` use
    to stay per-facility (Room has no facility column by design), and the `RoomFilterSet` facility
    filter (API-1). Under the Site-FK groupings the match is the facility's site slugs
    (`site_floor_scope`); under the `location` grouping a non-empty facility matches by **subtree**
    instead (`_location_floor_scope`) — its hosting Site is shared with sibling facilities, so a
    Site-slug match would pull their rooms in (and let one facility's authoritative save delete
    another's). The default facility `''` scopes by its (root-less) sites in every mode."""
    group = group or grouping()
    fmap = _assignments(fmap)
    if group == 'location' and facility:
        return _location_floor_scope(facility, fmap)
    return site_floor_scope(facility_site_slugs(facility, group=group, user=user, fmap=fmap))


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
    """`{'grouping': <type>, 'facilities': [{slug, name, has_content, org_mode}, …]}` for the SPA
    picker.

    Enumerates every grouping object the user may view (so an empty one can be picked to import a
    *new* facility), every facility that exists **only as an assigned value** (no grouping object —
    it has no display name of its own, so its slug doubles as the name), plus the default facility
    `''` ("Default facility") **only when it already has content**. `has_content` is whether that
    facility's working dir holds a rendered manifest. Content-having facilities sort first, then
    alphabetically — so a returning user lands among mapped facilities and a new one is still
    reachable below.

    `org_mode` (MODEL-6) rides each record rather than getting a GET of its own: the mode is
    per-facility, and this list is the one place the SPA already learns per-facility facts (the
    Settings page reads the active facility's entry). Unset facilities report `ORG_MODE_DEFAULT`, so
    every record carries a concrete mode and no caller has to know the default.

    Under the `location` grouping the enumeration is the top-level Locations (MODEL-8) — two
    same-slug roots under different Sites are one facility, so the first keeps the name (the
    `_facility_names` stance) — and every record's mode is the `site-as-campus` this grouping
    implies (the `org_mode()` override, restated here because this reads the raw map in bulk).

    Both settings it reads come off one `PluginSettings`, and the assignment map is read once for
    the whole listing — three row reads collapsed to two."""
    settings = PluginSettings()
    group = grouping(settings)
    imported = imported_facility_slugs()
    modes = org_modes(settings)
    fmap = facility_map()

    def _mode(slug):
        return 'site-as-campus' if group == 'location' else modes.get(slug, ORG_MODE_DEFAULT)

    if group == 'location':
        by_slug = {}
        for loc in _facility_roots().restrict(user, 'view'):
            by_slug.setdefault(loc.slug, {
                'slug': loc.slug, 'name': loc.name,
                'has_content': loc.slug in imported, 'org_mode': _mode(loc.slug)})
        facilities = list(by_slug.values())
    else:
        _attr, model = _GROUPING[group]
        facilities = [{
            'slug': obj.slug,
            'name': obj.name,
            'has_content': obj.slug in imported,
            'org_mode': _mode(obj.slug),
        } for obj in model.objects.restrict(user, 'view')]
    known = {f['slug'] for f in facilities}
    facilities += [{'slug': slug, 'name': slug, 'has_content': slug in imported,
                    'org_mode': _mode(slug)}
                   for slug in set(fmap.values()) if slug and slug not in known]
    if '' in imported:
        facilities.append({'slug': '', 'name': 'Default facility', 'has_content': True,
                           'org_mode': _mode('')})
    facilities.sort(key=lambda f: (not f['has_content'], f['name'].lower()))
    return {'grouping': group, 'facilities': facilities}


# --- Orphaned-data detection & recovery (HEALTH-1) ------------------------------------------------
#
# For a Site **absent from the assignment map**, which facility it resolves to is still a *live*
# function of the install-wide `facility_grouping` setting and the Site's own SiteGroup/Region — but
# nothing re-keys existing blob rows when that resolution changes. Flip the grouping, or give an
# ungrouped-and-unassigned Site a group, and its editor blobs stay parked under the OLD `facility`
# key while the app now queries the NEW one, so the map reads as empty though the rows are intact —
# the data is never lost, just stranded under a stale key. An **assigned** Site is immune (its
# facility is explicit plugin state; only a deliberate reassignment moves it), so this machinery is
# the safety net for the un-assigned remainder and for operator-initiated reassignments, shrinking
# toward rarely-needed as Phase 2 assigns Sites. These helpers detect that drift and re-key the
# stranded rows to a facility the operator chooses. `Room` has no facility column — its scoping is
# derived from its floor's site slug (`facility_floor_scope`), so a re-key of the blobs is enough;
# the rooms reappear under the target facility automatically (nothing to move).


def reachable_facilities(user=None, group=None, fmap=None):
    """The set of facility slugs some current Site resolves to under the live `grouping()`.

    Every Site resolves into this set: it's the slugs of the current grouping model (SiteGroup or
    Region), plus `''` when any Site is ungrouped (those resolve to the default facility). A
    siteless-but-existing grouping object is included, so a facility whose import is in progress
    (blobs written, sites not yet assigned) is never mis-flagged as orphaned. Unscoped by default —
    orphan detection is an authoritative, install-wide check (like the `facilitymap_check` path), so
    it must see every grouping object regardless of the viewer's object permissions.

    Assignment-aware (FACILITY-IDENTITY-DESIGN §4.3): every distinct **assigned** value is
    reachable (an assigned facility need not correspond to any grouping object), and `''` is
    reachable when any Site *resolves* to it — explicitly assigned `''`, or unassigned and
    ungrouped. Keeping this definition in step with `facility_for_site`'s inputs is what keeps
    `orphaned_facility_keys` honest (the HEALTH-1 caveat), and it makes orphaning for an assigned
    Site possible only through a deliberate reassignment, never an org reorg.

    `group` overrides the live grouping — the same override `facility_for_site`/`facility_sites`
    take — so a *prospective* grouping can be evaluated without writing it. That is what lets
    `grouping_change_preview` say which data a pending change would strand **before** it is made
    (MULTI-7); every other caller leaves it `None` and reads the live setting.

    Under the `location` grouping the grouping objects are the top-level Locations
    (`_facility_roots`), and `''` is reachable when some unassigned Site hosts **no** top-level
    Location — the `facility_sites('')` definition, kept in step so the detector and the inverse
    can't disagree about who the default facility's Sites are.

    `fmap` threads an already-read assignment map — `grouping_change_preview` calls this twice
    (live and prospective) and `suggested_target` intersects against it, so the row is read once
    for the whole preview rather than per call."""
    group = group or grouping()
    fmap = _assignments(fmap)
    sites = Site.objects.restrict(user, 'view') if user is not None else Site.objects.all()
    if group == 'location':
        # One queryset for both uses: the slug list is evaluated, the `.values('site')` form is
        # inlined as a subquery into the `exclude` (it never round-trips on its own).
        roots = _facility_roots()
        reachable = set(roots.values_list('slug', flat=True)) | set(fmap.values())
        ungrouped = sites.exclude(pk__in=roots.values('site'))
    else:
        attr, model = _GROUPING[group]
        reachable = set(model.objects.values_list('slug', flat=True)) | set(fmap.values())
        ungrouped = sites.filter(**{'%s__isnull' % attr: True})
    if ungrouped.exclude(slug__in=list(fmap)).exists():
        reachable.add('')
    return reachable


def data_facility_keys():
    """Distinct `facility` values carrying an editor document — the facilities that hold map data.
    Excludes the install-wide `settings` row (always `facility=''`, not per-facility data)."""
    return set(FacilityMapBlob.objects.filter(kind__in=EDITOR_KINDS)
               .values_list('facility', flat=True).distinct())


def orphaned_facility_keys(group=None, fmap=None):
    """Facility keys that hold map data but no current Site resolves to — the drift a grouping change
    (or a Site newly gaining/losing a grouping) leaves behind. `''` is flagged only when no Site is
    ungrouped (i.e. the default facility's data is now unreachable).

    `group`/`fmap` forward to `reachable_facilities`: a caller that already resolved the grouping
    off its own `PluginSettings` (`views.MapView`, which stamps the orphan banner on every map
    render) passes it rather than making this re-read the settings row."""
    return data_facility_keys() - reachable_facilities(group=group, fmap=fmap)


def suggested_target(key, group=None, fmap=None):
    """The facility an orphaned `key`'s own data now points at, or `''` when it can't be inferred
    unambiguously — used to preselect the one-click-correct choice in the reassignment picker.

    Reads the key's `annotations`/`placements` floor keys, resolves each one's *current* facility
    (`facility_for_floor_key` — under the `location` grouping that is the key's anchor Location's
    root, so campus data suggests its own building/wing facility rather than a site-level answer),
    and returns it when the data's keys all agree on a single reachable target. Ambiguous (mixed
    targets) or unresolvable (sites/anchors gone) → `''`, leaving the operator to choose. Those
    kinds are sharded one row per floor (`key=floor_key`, CONC-1), so each row's `key` is a floor
    key directly. `group` evaluates both halves under a *prospective* grouping, so the wizard
    modal's preselection matches the state the operator is about to be in (MULTI-7); omitted, it
    reads the live one.

    **Bounded by the facility's distinct anchors, not by its floor count.** A drawn facility can
    hold hundreds of floor-key rows, and resolving each one separately meant a per-floor assignment
    -map read plus a per-floor `Site`/`Location` lookup. `facility_for_floor_key` reads only a key's
    first two segments, so the keys are collapsed to their distinct `(site, building)` prefixes and
    one representative of each is resolved — a facility of 200 floors under one building resolves
    once. The assignment map is read once for the whole call (and threaded on from `fmap` when a
    caller like `grouping_change_preview` already holds it)."""
    group = group or grouping()
    fmap = _assignments(fmap)
    prefixes = {parse_floor_key(floor_key)[:2] for floor_key
                in (FacilityMapBlob.objects
                    .filter(facility=key, kind__in=('annotations', 'placements'))
                    .exclude(key='').values_list('key', flat=True))}
    targets = set()
    for site_slug, building_slug in prefixes:
        # Rebuild a key from the two segments that decide the answer; the floor segment is
        # deliberately a placeholder, since `facility_for_floor_key` never reads it.
        floor_key = '/'.join(s for s in (site_slug, building_slug, '_') if s)
        target = facility_for_floor_key(floor_key, group=group, fmap=fmap)
        if target:
            targets.add(target)
    targets &= reachable_facilities(group=group, fmap=fmap)
    return next(iter(targets)) if len(targets) == 1 else ''


def reachable_facility_choices(group=None, fmap=None):
    """`[{slug, name}, …]` of the facilities an operator may reassign orphaned data *to* — the
    reachable facilities, with display names, sorted by name. `''` renders as "Default facility";
    an assignment-only facility (no grouping object) renders by its slug, like `list_facilities`.
    Feeds the Settings-page reassignment `<select>` and the wizard modal's inline one (MULTI-7),
    which passes the **prospective** `group` so its picker offers the targets that will be reachable
    once the pending grouping change lands. `fmap` threads an already-read assignment map."""
    group = group or grouping()
    reachable = reachable_facilities(group=group, fmap=fmap)
    if group == 'location':
        by_slug = {}
        for slug, name in _facility_roots().values_list('slug', 'name'):
            if slug in reachable:
                by_slug.setdefault(slug, name)
        choices = [{'slug': slug, 'name': name} for slug, name in by_slug.items()]
    else:
        _attr, model = _GROUPING[group]
        choices = [{'slug': obj.slug, 'name': obj.name}
                   for obj in model.objects.all() if obj.slug in reachable]
    known = {c['slug'] for c in choices}
    choices += [{'slug': slug, 'name': slug} for slug in reachable if slug and slug not in known]
    if '' in reachable:
        choices.append({'slug': '', 'name': 'Default facility'})
    choices.sort(key=lambda c: c['name'].lower())
    return choices


def _facility_names():
    """`{slug: display name}` across **every** grouping's naming objects — the two Site-FK models
    plus the top-level Locations (MODEL-8). A grouping-change preview spans groupings (a facility
    named by a SiteGroup before, by a building Location after), so naming from only the live one
    would render half the diff as bare slugs. A slug present more than once keeps the first name —
    an ambiguity no display can resolve, and the slug itself is shown alongside."""
    names = {}
    for _attr, model in _GROUPING.values():
        for slug, name in model.objects.values_list('slug', 'name'):
            names.setdefault(slug, name)
    for slug, name in _facility_roots().values_list('slug', 'name'):
        names.setdefault(slug, name)
    return names


def _facility_display(slug, names):
    """One facility's display name: its grouping object's name, "Default facility" for `''`, else
    the slug itself (an assignment-only facility has no grouping object to name it — the same
    fallback `list_facilities` / `reachable_facility_choices` make)."""
    return names.get(slug) or slug or 'Default facility'


def _site_data_counts(site_slugs):
    """`{site_slug: {'floors': n, 'rooms': n}}` — how much map data each of `site_slugs` carries, so
    a preview can say what a move actually affects rather than just naming the Site.

    Rooms are counted through `site_floor_scope` (the one place that knows how a room maps back to
    its Site, so the FK-vs-`floor_key` union is not restated here); floors are the distinct floor
    keys those rooms sit on, unioned with the `annotations`/`placements` **shard** keys (CONC-1 —
    each such row's `key` *is* a floor key), so a drawn-but-roomless floor still counts. The shard
    scan is install-wide across facilities, which is safe because a floor key's first segment is the
    globally-unique Site slug (the same argument `health._manifest_floor_keys` makes). Two queries
    regardless of how many Sites are passed."""
    if not site_slugs:
        return {}
    counts = {slug: {'floors': set(), 'rooms': 0} for slug in site_slugs}
    for floor_key, fk_site in (Room.objects.filter(site_floor_scope(set(site_slugs)))
                               .values_list('floor_key', 'floor_location__site__slug')):
        # The rename-proof FK wins when it names a Site in scope; a room without one (or whose FK
        # points outside) falls back to the key prefix, exactly the precedence `site_floor_scope`
        # unions on.
        entry = counts.get(fk_site) or counts.get((floor_key or '').split('/', 1)[0])
        if entry is None:
            continue
        entry['rooms'] += 1
        if floor_key:
            entry['floors'].add(floor_key)
    for key in (FacilityMapBlob.objects.filter(kind__in=('annotations', 'placements'))
                .exclude(key='').values_list('key', flat=True)):
        entry = counts.get(key.split('/', 1)[0])
        if entry is not None:
            entry['floors'].add(key)
    return {slug: {'floors': len(v['floors']), 'rooms': v['rooms']} for slug, v in counts.items()}


def grouping_change_preview(new_group):
    """What changing the install-wide grouping to `new_group` would actually do — the data behind
    the wizard's reassignment modal (FACILITY-IDENTITY §4.4, MULTI-7), which replaced a blanket
    "your data may disappear" warning with this concrete before/after.

    Returns `{'grouping': {'from', 'to'}, 'moves': [...], 'orphans': [...], 'choices': [...],
    'assigned': n}`:

    - **`moves`** — one entry per Site whose facility would change: `{site, name, from, from_name,
      to, to_name, floors, rooms}`. Only **unassigned** Sites can appear: an assigned Site's
      facility is explicit plugin state that no grouping change can re-key (§4.2), which is the
      whole point of Phase 1 — so the modal shows the shrinking remainder still at risk, and an
      install that assigned everything correctly sees an empty list.
    - **`orphans`** — data-bearing facility keys unreachable **after** the change, each `{facility,
      name, kinds, suggested, already}`; `already` marks a key that is orphaned *today* too (the
      change didn't strand it), so the modal can offer to fix pre-existing drift in the same pass
      without blaming this change for it.
    - **`choices`** — `reachable_facility_choices` under the **prospective** grouping, the targets
      the modal's inline reassignment `<select>` offers once the change lands.

    A transition **to `location`** reads the same way: every unassigned grouped Site "moves" to the
    default facility (the site-level derivation is `''` in that mode — the facilities live below the
    Site), and the real story is `orphans` + `choices` — each stranded key's `suggested` target is
    already location-aware (`suggested_target` resolves the key's own floor keys through their
    anchor Locations), so campus data preselects the building/wing facility it belongs to.

    Read-only: nothing here writes, so a preview of a change the operator then cancels leaves no
    trace. Raises `ValueError` on an unknown grouping.

    **Deliberately unscoped by object permissions**, like `reachable_facilities` and for the same
    reason: the grouping is install-wide, so a diff filtered to the Sites *this* operator may view
    would understate the blast radius — the one error a "here is what this moves" screen must never
    make. The endpoint gates on `IMPORT_PERM` instead, which is who may make the change at all."""
    if new_group not in GROUPING_CHOICES:
        raise ValueError('grouping must be one of: %s' % ', '.join(GROUPING_CHOICES))
    current = grouping()
    names = _facility_names()
    fmap = facility_map()

    moves = []
    for site in Site.objects.select_related(*(attr for attr, _m in _GROUPING.values())):
        if site.slug in fmap:
            continue    # explicitly assigned — immune to the grouping by construction (§4.2)
        before = _derive_from_grouping(site, current)
        after = _derive_from_grouping(site, new_group)
        if before != after:
            moves.append({'site': site.slug, 'name': site.name, 'from': before, 'to': after,
                          'from_name': _facility_display(before, names),
                          'to_name': _facility_display(after, names)})
    counts = _site_data_counts([m['site'] for m in moves])
    for move in moves:
        move.update(counts.get(move['site'], {'floors': 0, 'rooms': 0}))
    moves.sort(key=lambda m: m['name'].lower())

    reachable_now = reachable_facilities(fmap=fmap)
    stranded = data_facility_keys() - reachable_facilities(group=new_group, fmap=fmap)
    orphans = [{
        'facility': key,
        'name': _facility_display(key, names),
        'kinds': sorted(set(FacilityMapBlob.objects.filter(facility=key, kind__in=EDITOR_KINDS)
                            .values_list('kind', flat=True))),
        'suggested': suggested_target(key, group=new_group, fmap=fmap),
        'already': key not in reachable_now,
    } for key in sorted(stranded)]

    return {
        'grouping': {'from': current, 'to': new_group},
        'moves': moves,
        'orphans': orphans,
        'choices': reachable_facility_choices(group=new_group, fmap=fmap),
        'assigned': len(fmap),
    }


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


def rename_location_facility(old_slug, new_slug):
    """Re-key one facility after its top-level Location's slug changed under the `location`
    grouping — the facility-identity half of the HEALTH-4 rename remap for MODEL-8 (`signals`
    dispatches it; `SlugRenameRemapper` separately re-keys any floor bindings the same rename
    shifts). Moves the editor blobs (`update(facility=new)`) and the rendered working-dir
    artifacts (`storage.move_facility`), and follows the slug through the two settings that name
    facilities — the `facility_org_modes` entry and a `default_facility` pin.

    Returns True when anything moved, False when `old_slug` held nothing (the idempotent no-op
    every remap store operation shares — a rename of an un-imported root touches nothing). Unlike
    `reassign_facility` there is no reachability check (`new_slug` *is* the renamed root, reachable
    by construction) and a blob-less facility with only rendered content still moves. Collisions —
    the new slug already holding blobs or a rendered manifest, e.g. a rename onto a sibling root's
    slug — raise `ValueError` for the caller to log; the data stays parked under the old key, where
    the HEALTH-1 orphan detection and reassignment surface recover it, mirroring
    `rename_site_assignment`'s never-clobber stance."""
    old = valid_facility(old_slug)
    new = valid_facility(new_slug)
    if old == new or not old or not new:
        return False
    moving = FacilityMapBlob.objects.filter(facility=old, kind__in=EDITOR_KINDS)
    kinds = set(moving.values_list('kind', flat=True))
    had_disk = (work_dir(old) / MANIFEST_NAME).exists()
    if not kinds and not had_disk:
        return False
    if kinds and FacilityMapBlob.objects.filter(facility=new, kind__in=kinds).exists():
        raise ValueError('the new slug already has map data')
    if (work_dir(new) / MANIFEST_NAME).exists():
        raise ValueError('the new slug already has rendered content')
    with transaction.atomic():
        moving.update(facility=new)
    move_facility(old, new)
    # Follow the rename through the facility-named settings, the same read-modify-write path
    # `set_org_mode` uses so concurrent settings writes can't be clobbered. Best-effort ordering:
    # run after the data move so a failure here strands only display state, never map data.
    with transaction.atomic():
        row = (FacilityMapBlob.objects.select_for_update()
               .filter(kind='settings', facility='', key='').first())
        data = dict((row.data if row else None) or {})
        changed = False
        modes = dict(data.get('facility_org_modes') or {})
        if old in modes and new not in modes:
            modes[new] = modes.pop(old)
            data['facility_org_modes'] = modes
            changed = True
        if data.get('default_facility') == old:
            data['default_facility'] = new
            changed = True
        if changed:
            _save_install_blob('settings', row, data)
    return True
