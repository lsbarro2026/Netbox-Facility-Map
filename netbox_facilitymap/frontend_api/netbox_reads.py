"""Direct ORM reads over the `dcim` tree — rooms, Locations, Sites, building anchors — plus the
first of the plugin's two writes into NetBox core.

These replace the token-holding `NetBoxProxy`: every query is scoped by the requester's own
object permissions (`.restrict(user, 'view')`), so there is no API token to leak and a user can
never be shown an object NetBox itself would hide from them (§4).

Two scoping stances live side by side here, and the difference is deliberate. `NbRoomsView` /
`NbLocationsView` are **facility-agnostic** — the caller names an explicit `site=`/`location=`,
which already bounds the answer. `NbSitesView` / `NbBuildingLocationsView` are **facility-scoped**
(FACIL-1) because they are the import wizard's binding point: binding a building under facility A
to a Site belonging to facility B would strand its map data, so an out-of-facility bind is made
impossible rather than merely repairable.
"""

from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Case, IntegerField, Q, Value, When
from django.http import HttpResponseBadRequest, HttpResponseForbidden, JsonResponse
from django.contrib.auth.mixins import LoginRequiredMixin
from django.utils.text import slugify
from django.views import View

from dcim.models import Location, Site

from ..facilities import facility_location_pks, facility_sites, grouping
from ..previews import PluginSettings
from .common import _capped, _facility, _list_cap, _parse_json_body
from .serializers import _trim, _trim_building_location, _trim_site


class NbRoomsView(LoginRequiredMixin, View):
    """Rooms = child Locations of the floor Location; falls back to all Locations under
    the site when the floor slug has no Location. ORM equivalent of `NetBoxProxy.rooms`.

    A **Location-anchored** floor (Site=campus, building is a Location — MODEL-3) is disambiguated by
    an optional `?building=<buildingLocation.slug>`: two buildings under one campus can share a floor
    slug (e.g. both `level-1`), so when `building` is given the floor Location is resolved **under**
    that building Location (`parent__slug`). Absent (the Site-anchored case, and every caller today)
    ⇒ the floor is resolved directly under the Site, exactly as before."""

    def get(self, request):
        site_slug = request.GET.get('site', '')
        building_slug = request.GET.get('building', '')
        floor_slug = request.GET.get('floor', '')
        site = Site.objects.filter(slug=site_slug).first()
        if not site:
            return JsonResponse({'error': 'site not found: ' + site_slug, 'rooms': []})
        locs = Location.objects.restrict(request.user, 'view').filter(site=site)
        floor_qs = locs.filter(parent__slug=building_slug) if building_slug else locs
        floor = floor_qs.filter(slug=floor_slug).first() if floor_slug else None
        if floor:
            rooms = list(locs.filter(parent=floor))
            if rooms:
                return JsonResponse({'floor': _trim(floor, request),
                                     'rooms': [_trim(x, request) for x in rooms]})
            return JsonResponse({'floor': _trim(floor, request),
                                 'rooms': [_trim(x, request) for x in locs]})
        return JsonResponse({'floor': None, 'rooms': [_trim(x, request) for x in locs]})


# How many tiers of the Location tree `_capped_locations` distinguishes before lumping the rest
# together. The deepest thing the import wizard reasons about is a room under a floor under a wing
# under a building (campus → building → wing → floor → room, MULTI-5) — tier 4 — so four explicit
# tiers plus an "everything below" bucket orders every supported topology floors-before-rooms.
# Each tier costs one LEFT JOIN back onto `dcim_location`, so it is deliberately not open-ended.
LOCATION_TIER_CAP = 4


def _capped_locations(qs, cap):
    """`_capped` for the Location **tree** read: apply `cap` shallowest-first, returning
    `(rows, truncated, truncated_depth)` (IMPORT-49).

    `Location.objects` is MPTT-managed, so it arrives ordered `tree_id, lft` — a **depth-first**
    walk. That is the worst possible order for a caller that wants floors: the walk descends into
    each floor's rooms before reaching the next floor, so `BUILDING, Floor 1, <400 rooms>, Floor 2,
    …` exhausts even `NB_MATCH_CAP` after a handful of floors. The map step's floor list was being
    clipped to ~6 floors per building on any real facility, and the operator was told only that the
    site "has more locations than can be listed at once".

    Ordering **breadth-first** inverts that: every root, then every root's children, and so on, so
    the tiers a floor can live in are always complete before a single room is emitted. A site would
    need more than `cap` buildings-plus-floors before a floor could be dropped.

    The tier is computed from the plain `parent` FK chain, never MPTT's `level` — same reason
    `_trim` exposes `parent` rather than `depth` (§4): `level` is an MPTT-only artifact and
    unreliable on NetBox 4.2+, and this ordering is precisely where a stale value would silently
    reintroduce the bug it exists to fix.

    `truncated_depth` is the tier the clip landed in — every row **shallower** than it is
    guaranteed complete — so a caller can tell "clipped, but not where my floors live" from
    "clipped where it matters" instead of distrusting the whole answer. `None` when nothing was
    clipped. Rows at or past `LOCATION_TIER_CAP` all report that tier."""
    ordered = qs.annotate(_tier=Case(
        When(parent__isnull=True, then=Value(0)),
        When(parent__parent__isnull=True, then=Value(1)),
        When(parent__parent__parent__isnull=True, then=Value(2)),
        When(parent__parent__parent__parent__isnull=True, then=Value(3)),
        default=Value(LOCATION_TIER_CAP), output_field=IntegerField(),
    # `pk` breaks ties so a page boundary can't shuffle between two identically-named siblings,
    # which would make `truncated_depth` non-deterministic for the same data.
    )).order_by('_tier', 'name', 'pk')
    # One row past the cap, exactly as `_capped` — reading the truth still costs no second query.
    rows = list(ordered[:cap + 1])
    if len(rows) <= cap:
        return rows, False, None
    return rows[:cap], True, rows[cap]._tier


class NbLocationsView(LoginRequiredMixin, View):
    """Free-text Location search within a site. ORM equivalent of `NetBoxProxy.locations`.

    Two callers with opposite needs share this endpoint, so it carries the same cap contract its
    `NbSitesView`/`NbBuildingLocationsView` siblings do (TOPO-5 / IMPORT-18):

      * the map step's **"+ Add floor"** search types into the result list, so the per-keystroke
        `NB_LIST_CAP` is the point;
      * `ImportFlow._loadFloors` reads the site's Location list **as a whole**, once, and derives the
        building's floor buttons, the anchor tree cache, and — critically — the set it sweeps stale
        floor assignments against. A silently clipped list there does not merely hide floors: it makes
        `_dropUnanchoredTokens` reset assignments whose Location happens to sit past the cap. Rooms are
        Locations too, so an ordinary site (5 floors x 40 rooms) already exceeds 200. That caller
        passes `?full=1` for the higher `NB_MATCH_CAP`.

    **The rows come back shallowest-first, not in MPTT tree order** (`_capped_locations`, IMPORT-49):
    a depth-first walk interleaves each floor's rooms between the floors, so the cap used to bite
    after a handful of floors on any site with real rooms in it. Breadth-first, a floor can only be
    dropped once the site's buildings and floors *alone* outnumber the cap.

    **`truncated`** reports whether the cap clipped the list either way, so the whole-list caller can
    refuse to sweep against a partial answer instead of trusting it (see `_capped`).
    **`truncated_depth`** says *where* it clipped — the tier of the first dropped row, everything
    shallower being complete — so a caller whose floors sit above the cut can carry on rather than
    treating a clipped tail of rooms as a reason to distrust the floor list.

    **`site_not_found`** distinguishes "this site has no Locations you may see" from "no Site answers
    to that slug" — an empty `rooms` list alone reads as the former, and the wizard would quietly fall
    back to its floor-type vocabulary and build floor ids that match nothing in NetBox. The flag lets
    the map step name the real problem (a bound Site renamed or deleted in NetBox) instead. `rooms`
    stays `[]` in that case, so callers that ignore the flag behave exactly as before."""

    def get(self, request):
        site_slug = request.GET.get('site', '')
        q = request.GET.get('q', '')
        site = Site.objects.filter(slug=site_slug).first()
        if not site:
            return JsonResponse({'rooms': [], 'truncated': False, 'truncated_depth': None,
                                 'site_not_found': True})
        qs = Location.objects.restrict(request.user, 'view').filter(site=site)
        if q:
            qs = qs.filter(name__icontains=q)
        rows, truncated, truncated_depth = _capped_locations(qs, _list_cap(request))
        return JsonResponse({'truncated': truncated, 'truncated_depth': truncated_depth,
                             'site_not_found': False,
                             'rooms': [_trim(x, request) for x in rows]})


class NbLocationCreateView(LoginRequiredMixin, View):
    """POST: create a child `dcim.Location` under a floor Location, so a permitted user can bind a
    drawn room to a fresh Location without leaving the map (LOC-1).

    This is the plugin's **only** write into `dcim` core — every other NetBox interaction is a
    `.restrict(user, 'view')` read — so it is gated stricter than the reads, three ways, all
    enforced here (never login-only, never on the frontend alone):

      * install-wide **write mode** must be on — the master gate on everything the plugin writes into
        NetBox core, an operator flips it on the Settings page (off by default, so NetBox stays the
        Location source of truth), read server-side via `previews.write_mode_enabled` (LOC-2,
        replacing the old redeploy-time `allow_location_create` capability flag) — else 403;
      * the **inline room creation** add-on must be on — this feature's own switch, split out of write
        mode by SET-5 so an operator can allow the AP tool's writes while keeping Location creation in
        NetBox's hands (or the reverse), read via `previews.inline_room_creation_enabled` — else 403.
        The same two-switch shape the AP write answers to (`_ap_write_gate`): one master gate, one
        per-feature switch;
      * the user must hold the `dcim.add_location` object permission (the NetBox auth backend, not a
        login check) — the model-level `has_perm` gives a fast 403, and a post-save
        `restrict(user, 'add')` re-check honours any object-level constraints on that permission
        (the check must run on a *saved* pk — an object-level `has_perm` on an unsaved instance
        filters on `pk=None` and always fails);
      * the parent floor Location must already exist and be visible to the user
        (`restrict(user, 'view')`) — this endpoint never creates the floor, only a room under it.

    The child slug is `slugify(name)`, matching how NetBox's own Location form derives it, so
    `NbRoomsView` lists the new child under the floor and room→Location binding resolves (§7). A
    duplicate name/slug or otherwise invalid Location surfaces as a clean 400 via `full_clean()`."""

    def post(self, request):
        # Both gates off one settings-row read (see `PluginSettings`).
        settings = PluginSettings()
        if not settings.write_mode:
            return HttpResponseForbidden('write mode is not enabled')
        if not settings.inline_room_creation:
            return HttpResponseForbidden('inline room creation is not enabled')
        if not request.user.has_perm('dcim.add_location'):
            return HttpResponseForbidden('permission denied')
        payload, error = _parse_json_body(request)
        if error:
            return error
        name = (payload.get('name') or '').strip()
        if not name:
            return HttpResponseBadRequest('a Location name is required')
        # The parent floor Location must be one the user may see; a bad/hidden id is a 400, not a
        # silent create at the site root (a room Location must nest under its floor, §7).
        parent = Location.objects.restrict(request.user, 'view').filter(
            pk=payload.get('parent')).first()
        if parent is None:
            return HttpResponseBadRequest('parent floor Location not found')
        loc = Location(name=name, slug=slugify(name), site=parent.site, parent=parent)
        denied = False
        try:
            with transaction.atomic():
                loc.full_clean()
                loc.save()
                # Honour object-level constraints on the add permission the way NetBox's own create
                # path does: verify the saved row falls within the user's add-scoped queryset, else
                # roll back. Runs on a real pk, so (unlike an unsaved-instance has_perm) it can't
                # false-negative.
                if not Location.objects.restrict(request.user, 'add').filter(pk=loc.pk).exists():
                    denied = True
                    transaction.set_rollback(True)
        except ValidationError as e:
            return JsonResponse({'ok': False, 'error': '; '.join(e.messages)}, status=400)
        if denied:
            return HttpResponseForbidden('permission denied')
        return JsonResponse(_trim(loc, request), status=201)


class NbSitesView(LoginRequiredMixin, View):
    """Free-text Site search, **scoped to the active facility** (FACIL-1). The import wizard binds
    each uploaded building folder to a NetBox Site (a "building"), so its slug — which becomes the
    manifest `siteSlug` — matches a real Site and later room/location lookups resolve.

    Unlike the other `/api/netbox/*` reads (facility-agnostic — scoped by an explicit `site=`/
    `location=`), this one *is* the facility-binding point: binding a building under facility A to a
    Site whose grouping slug is B would land the images/manifest/blobs under A while
    `facility_site_slugs('A')` never includes that Site, silently stranding its rooms. So the search
    is restricted to the requested `?facility=`'s own Sites (via `facility_sites`) — ungrouped Sites
    for the default facility '', a group's Sites otherwise — making an out-of-facility bind
    impossible rather than merely repairable after the fact. `lib.js` threads `?facility=` here by
    listing `/api/netbox/sites` in `FACILITY_PREFIXES`.

    **`truncated`** reports whether the row cap clipped the results (TOPO-5) — see `_capped`.
    **`?full=1`** raises that cap to `NB_MATCH_CAP` for the wizard's one-shot, match-the-whole-list
    read (IMPORT-18); without it the per-keystroke `NB_LIST_CAP` applies."""

    def get(self, request):
        facility = _facility(request)
        if facility is None:
            return HttpResponseBadRequest('invalid facility')
        q = request.GET.get('q', '')
        qs = facility_sites(facility, user=request.user)
        if q:
            qs = qs.filter(name__icontains=q)
        rows, truncated = _capped(qs, _list_cap(request))
        return JsonResponse({'truncated': truncated,
                             'sites': [_trim_site(s, request) for s in rows]})


class NbBuildingLocationsView(LoginRequiredMixin, View):
    """Free-text search for **building-anchor Locations**, the sibling of `NbSitesView` (MODEL-4).

    Under the Site = campus topology a building is a `dcim.Location` beneath the campus Site, not a
    Site of its own (BUILDING-ANCHOR-DESIGN §4.1). The import wizard's bind step lets an operator
    anchor a drawing folder to such a building Location; this endpoint backs both the auto-suggest
    pass and the manual override, returning candidate building Locations within the active facility.

    **Facility-scoped exactly like `NbSitesView` (FACIL-1):** results are restricted to Locations
    whose `site` belongs to the requested `?facility=` (`facility_sites`), so an operator can no more
    bind a building Location out-of-facility than a Site — the anchor's site slug still becomes the
    manifest `siteSlug`, and a mismatched grouping would strand the map the same way. `lib.js` threads
    `?facility=` here by listing `/api/netbox/building-locations` in `FACILITY_PREFIXES`.

    **"Building anchor" = a Location that has child Locations *or* sits at the top of the Location
    tree (`parent IS NULL`).** NetBox has no `LocationType` concept to key off (design §8 open-q 1;
    still absent in 4.6), so *position* is the only structural signal — and both halves of it are
    depth-agnostic, so a wing/campus tree of any depth resolves without a hard-coded building level.
    The has-children half admits an already-drawn building (its children are its floors); the
    top-level half additionally admits a building **modelled in NetBox but not yet drawn** (no floor
    children), which the has-children signal alone would drop — the IMPORT-14 gap the split-wizard
    building picker needs closed. Deeper **leaf** Locations (rooms, or floors with no rooms yet) have
    neither signal and are still excluded, keeping the picker to plausible buildings. `site_slug`/
    `site_name` accompany each hit so the frontend records the campus Site (→ `siteSlug`) alongside
    the building slug (→ `buildingSlug`).

    **Optional `?site=<slug>` narrows the search to one campus Site** (MODEL-7). A facility declared
    `site-as-campus` picks its campus once in the wizard and then binds each drawing folder to a
    building beneath *that* Site, so the per-building search is scoped to it. The narrowing applies
    **inside** the facility scope, never instead of it — an out-of-facility slug selects nothing
    rather than widening the results (FACIL-1).

    **`truncated`** reports whether the row cap clipped the results (TOPO-5) — see `_capped`.
    **`?full=1`** raises that cap to `NB_MATCH_CAP` for the split step's one-shot, match-the-whole-
    list read (IMPORT-18) — the case this endpoint's 200-row default actually bit, since a campus
    holds far more buildings than a `<select>`-sized page. Without it the per-keystroke
    `NB_LIST_CAP` applies, so the row picker's live search is unaffected."""

    def get(self, request):
        facility = _facility(request)
        if facility is None:
            return HttpResponseBadRequest('invalid facility')
        q = request.GET.get('q', '')
        sites = facility_sites(facility, user=request.user)
        site_slug = request.GET.get('site', '')
        if site_slug:
            sites = sites.filter(slug=site_slug)
        qs = Location.objects.restrict(request.user, 'view').filter(site__in=sites)
        # Building anchor: the Location is itself the parent of at least one other Location (its
        # candidate floors) OR sits at the top of the Location tree (`parent IS NULL`, a building not
        # yet drawn — IMPORT-14). Keyed off the plain `parent` FK column — reliable on any queryset,
        # unlike the MPTT `level`/`depth` artifacts (§_trim), and independent of whether the floors
        # have rooms yet. A deeper leaf (a room) has neither signal and is excluded.
        parents = Location.objects.filter(site__in=sites).exclude(parent=None).values('parent')
        qs = qs.filter(Q(pk__in=parents) | Q(parent__isnull=True))
        # Under the `location` grouping the facility is itself a Location subtree (MODEL-8), so the
        # Site scope above is shared with sibling facilities — narrow the anchors to *this*
        # facility's subtree, or an operator could bind a drawing to a sibling facility's building
        # (the same out-of-facility bind FACIL-1 exists to prevent).
        if grouping() == 'location' and facility:
            qs = qs.filter(pk__in=facility_location_pks(facility))
        if q:
            qs = qs.filter(Q(name__icontains=q) | Q(slug__icontains=q))
        qs = qs.select_related('site').order_by('name')
        rows, truncated = _capped(qs, _list_cap(request))
        return JsonResponse({'truncated': truncated,
                             'locations': [_trim_building_location(loc, request) for loc in rows]})
