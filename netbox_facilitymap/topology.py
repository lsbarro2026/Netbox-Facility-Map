"""Inspect the live `dcim` tree and propose the plugin settings that express it (TOPO-2).

`facilities.py` owns **resolution** — given a NetBox object, which facility is it in. This module
owns the inverse, **discovery**: given nothing but the install, what *shape* is this NetBox, and
which settings describe that shape? It is what lets the import wizard say "we found 124 buildings"
instead of asking an operator to translate their mental model into two setting names whose
vocabulary doesn't match it.

Everything here is **read-only**. The probe proposes; it never writes a setting. The endpoint that
exposes it (`frontend_api.NbTopologyView`) is a GET, and a probe an operator then ignores leaves no
trace — the same stance `facilities.grouping_change_preview` takes.

**The two axes are orthogonal and are reported as such.** `facility_grouping` is install-wide and
decides what a *facility* is (`facilities.grouping`); `facility_org_modes[facility]` is per-facility
and decides what a *building* is (`facilities.org_mode`). Conflating them is the trap TOPO-1
documents: an operator whose buildings are `dcim.Location`s reads the `location` **grouping** as
"my buildings are Locations" and gets one facility per building instead. So a candidate here is
always a concrete triple — grouping **and** org mode **and**, when the mode is campus-shaped, which
Site is the campus — never a single setting. Under the `location` grouping the org mode is forced to
`site-as-campus` server-side (`facilities.org_mode`), so every candidate reports the **effective**
mode, never a stored one.

**A campus-shaped candidate also names the facility its campus Site belongs to** (`campus_facility`,
IMPORT-17). The probe's counts are install-wide — that is the point, since the grouping axis is
chosen before the facilities it creates exist — but the wizard steps that follow it search only the
*active* facility (FACIL-1). Without this field those two halves could disagree silently: a fresh
SPA sits on the default facility `''`, which under a Site-FK grouping means the **ungrouped**
remainder, so on a fully-grouped install the probe would count 124 buildings and the bind/split steps
would find none. Naming the implied facility lets `ImportFlow._applyTopology` commit to a real one
before anything is searched.

**One level table, five candidates.** Every topology the plugin supports is the same
facility → building → floor → room window slid over the same underlying tree, so the counts and
example names for each level are computed **once** and every candidate indexes into them:

    grouping    org mode           facility    building   floor   room
    sitegroup   site-as-building   SiteGroup   Site       L0      L1
    sitegroup   site-as-campus     SiteGroup   L0         L1      L2
    region      site-as-building   Region      Site       L0      L1
    region      site-as-campus     Region      L0         L1      L2
    location    site-as-campus     L0          L1         L2      L3

That framing is also what makes the ranking honest rather than a bag of weights: a candidate that
maps the tree badly leaves a whole level empty or a whole level unaccounted for, and both are
countable (see `_rank_key`).

**Cost.** A real install is large — the install this was written for has 5773 Locations — so every
number here is an indexed aggregate over an object-permission-scoped queryset and example lists are
capped at `EXAMPLE_CAP`. Nothing walks the tree in Python. Depth is expressed through the plain
`parent` FK chain rather than the MPTT `level` column, which `frontend_api._trim` documents as an
artifact unreliable on NetBox 4.2+.
"""

from django.db.models import Count, Q

from dcim.models import Location, Region, Site, SiteGroup

# `_facility_roots` is imported across the module boundary deliberately: it is the single place that
# knows which top-level Locations may *be* a facility (its `SERVE_ROOTS` exclusion, `facilities.py`),
# and re-deriving that rule here is exactly the drift this module must not introduce.
from .facilities import GROUPING_DEFAULT, _facility_roots, facility_for_site, grouping
from .storage import SERVE_ROOTS

#: How many Location depths the probe measures individually (0..3). Four is precisely what the
#: deepest candidate window needs — under the `location` grouping the facility sits at depth 0 and
#: the room level at depth 3. Anything below that is aggregated into the `deeper` bucket, which is a
#: *signal* (a wing tree, MULTI-5) rather than a level any supported topology maps.
PROBE_DEPTHS = 4

#: Example object names returned per level. Enough for an operator to recognize their own data
#: ("buildings: Administration, Business, Chase Hall…") without the probe shipping an inventory.
EXAMPLE_CAP = 3

#: Mean floors-per-building above which a candidate is *smelling* wrong. A building with more than
#: this many floors is nearly always a level misread — the reporting install's `site-as-building`
#: candidate puts all 124 buildings' worth of floors inside its single campus Site. Advisory only:
#: it demotes a candidate in the ranking, it never removes one.
FLOORS_PER_BUILDING_SMELL = 20

#: The Location levels in depth order. `unplaced_locations` is the tail of this list below a
#: candidate's room level — the Locations that topology gives no home.
_LOC_LEVELS = ('L0', 'L1', 'L2', 'L3', 'deeper')

#: `(grouping, org_mode, building_level, floor_level, room_level)` for each candidate, in the fixed
#: order that breaks a total tie in `_rank_key` (so a probe of the same install is reproducible).
#: `location` appears once and only as `site-as-campus`: the server forces that mode for a
#: Location-subtree facility (`facilities.org_mode`), so the other pairing does not exist.
_CANDIDATES = (
    ('sitegroup', 'site-as-campus', 'L0', 'L1', 'L2'),
    ('sitegroup', 'site-as-building', 'site', 'L0', 'L1'),
    ('region', 'site-as-campus', 'L0', 'L1', 'L2'),
    ('region', 'site-as-building', 'site', 'L0', 'L1'),
    ('location', 'site-as-campus', 'L1', 'L2', 'L3'),
)


def _parent_chain(length):
    """The `parent__parent__…` lookup prefix `length` links long (`''` for zero)."""
    return '__'.join(['parent'] * length)


def _depth_q(depth):
    """A `Q` matching Locations exactly `depth` levels below the top of the tree.

    Expressed through the plain `parent` FK chain — an ordinary indexed column, reliable on any
    queryset — rather than the MPTT `level` field, which `frontend_api._trim` documents as an
    artifact that is unreliable on NetBox 4.2+. Each depth costs one more join, and the probe only
    ever asks for `PROBE_DEPTHS` of them. A depth's own chain being non-null is implied by the
    longer chain being null, so the two clauses fully pin the level."""
    q = Q(**{'%s__isnull' % _parent_chain(depth + 1): True})
    if depth:
        q &= Q(**{'%s__isnull' % _parent_chain(depth): False})
    return q


def _level(qs):
    """One level's `{'count': n, 'examples': [name, …]}`. The examples are what turn a bare number
    into something an operator can check against their own estate, so they are ordered by name (a
    stable, human-meaningful order) and capped."""
    return {
        'count': qs.count(),
        'examples': list(qs.order_by('name').values_list('name', flat=True)[:EXAMPLE_CAP]),
    }


def _levels(user):
    """The level table every candidate indexes into: `site` plus `L0`..`L3` and the `deeper`
    remainder. Object-permission scoped — the probe must never report objects the viewer can't
    see (§4: the plugin holds no REST token, so every read is ORM + `restrict`)."""
    locs = Location.objects.restrict(user, 'view')
    levels = {'site': _level(Site.objects.restrict(user, 'view'))}
    for depth in range(PROBE_DEPTHS):
        levels['L%d' % depth] = _level(locs.filter(_depth_q(depth)))
    levels['deeper'] = _level(
        locs.filter(**{'%s__isnull' % _parent_chain(PROBE_DEPTHS): False}))
    return levels


def _facility_levels(user):
    """`{grouping: {'count', 'named', 'examples'}}` — the facilities each grouping's partition would
    actually create.

    `count` counts the facilities the estate **populates**, which is the number an operator feels
    (and the one TOPO-1 needs to put in front of them before they commit): one bucket per distinct
    `SiteGroup`/`Region` a Site points at, plus one for the ungrouped remainder that resolves to the
    default facility `''` (`facilities.facility_sites`). A grouping object with no Sites is
    deliberately not counted — the picker lists it, but choosing this grouping doesn't *create*
    anything for it.

    `named` is how many of those buckets a real grouping object names. It separates "1 facility,
    called Cal Poly" from "1 facility, because every Site is ungrouped and collapsed into the
    default" — two very different answers that both count 1, and the tie-break `_rank_key` needs.
    `examples` names only those, for the same reason `count` skips siteless grouping objects: an
    example the operator can't find any of their estate under is worse than one fewer example. A
    `count` above `named` is the unnamed default-facility remainder.

    Under `location` the facilities *are* the top-level Locations, so count and named coincide."""
    sites = Site.objects.restrict(user, 'view')
    out = {}
    for group, attr in (('sitegroup', 'group'), ('region', 'region')):
        named = sites.exclude(**{attr: None}).values(attr).distinct().count()
        ungrouped = sites.filter(**{'%s__isnull' % attr: True}).exists()
        name_field = '%s__name' % attr
        out[group] = {
            'count': named + (1 if ungrouped else 0),
            'named': named,
            'examples': list(sites.exclude(**{attr: None}).order_by(name_field)
                             .values_list(name_field, flat=True).distinct()[:EXAMPLE_CAP]),
        }
    roots = _level(_facility_roots().restrict(user, 'view'))
    out['location'] = {'count': roots['count'], 'named': roots['count'],
                       'examples': roots['examples']}
    return out


def _campus_site(user):
    """`(slug, name, site)` of the Site that is most plausibly *the campus* — the one hosting the
    most top-level Locations — or `(None, None, None)` when no Site hosts any.

    A `site-as-campus` topology needs one Site named before the wizard's per-building search can be
    scoped to it (`NbBuildingLocationsView`'s `?site=`, MODEL-7), and "hosts the most buildings" is
    the only signal the tree offers. Reserved slugs are excluded so the answer can't disagree with
    `_facility_roots` about what counts as a root. One aggregate query, ties broken by name so the
    proposal is reproducible.

    The Site **object** rides along (grouping FKs pre-selected) so `_campus_facility` can resolve
    which facility it belongs to without a second query per candidate."""
    site = (Site.objects.restrict(user, 'view').select_related('group', 'region')
            .annotate(roots=Count('locations', filter=Q(locations__parent__isnull=True)
                                  & ~Q(locations__slug__in=SERVE_ROOTS)))
            .filter(roots__gt=0).order_by('-roots', 'name').first())
    return (site.slug, site.name, site) if site else (None, None, None)


def _campus_facility(site, group):
    """The facility slug the campus Site belongs to **under `group`** — the facility a campus-shaped
    candidate implies (IMPORT-17) — or `None` when there isn't a single answer.

    The probe itself is facility-agnostic by design (the grouping axis is chosen before the
    facilities it creates exist), and that is exactly what let the two halves of the wizard disagree:
    it counted buildings install-wide while the bind/split steps searched only the *active* facility,
    which on a grouped install defaults to `''` — the **ungrouped** remainder, often empty. Naming
    the implied facility here is what lets the wizard commit to a real one before it searches
    anything (`ImportFlow._applyTopology`).

    `''` is a real answer (the default facility). `None` means the question doesn't apply: no campus
    Site, or the `location` grouping, where the facilities *are* the top-level Locations — one campus
    hosts many, so no single slug describes it."""
    if site is None or group == 'location':
        return None
    return facility_for_site(site, group=group)


def _candidate(spec, levels, facility_levels, campus):
    """One candidate topology with the numbers its `{grouping, org_mode, campus_site}` triple
    implies — the counts at each of its four levels, the Locations it leaves unplaced, and a few
    example names per level so the operator can eyeball it rather than trust it."""
    group, mode, b_key, f_key, r_key = spec
    buildings, floors, rooms = levels[b_key], levels[f_key], levels[r_key]
    facilities = facility_levels[group]
    # Everything below the room level: Locations this topology maps nowhere. Under `location` the
    # facility level is L0, which sits *above* the window, so it is never part of the tail.
    tail = _LOC_LEVELS[_LOC_LEVELS.index(r_key) + 1:]
    campus_slug, campus_name, campus_obj = (campus if mode == 'site-as-campus'
                                            else (None, None, None))
    return {
        'grouping': group,
        'org_mode': mode,
        'campus_site': campus_slug,
        'campus_site_name': campus_name,
        'campus_facility': _campus_facility(campus_obj, group),
        'facilities': facilities['count'],
        'named_facilities': facilities['named'],
        'buildings': buildings['count'],
        'floors': floors['count'],
        'rooms': rooms['count'],
        'unplaced_locations': sum(levels[key]['count'] for key in tail),
        # `null` rather than 0 when there are no buildings — "we can't tell" is not "no floors per
        # building", and the ranking treats the two differently.
        'floors_per_building': (round(floors['count'] / buildings['count'], 1)
                                if buildings['count'] else None),
        'examples': {
            'facilities': facilities['examples'],
            'buildings': buildings['examples'],
            'floors': floors['examples'],
            'rooms': rooms['examples'],
        },
    }


def _rank_key(candidate, index):
    """Sort key for the ranking — lower is better, so "more is better" components are negated.

    Structural rather than weighted, so the UI can state *why* a candidate won, in order:

    1. **How many of building/floor/room the tree actually populates.** A topology that leaves a
       level empty has misread the tree. This is what sinks `location` grouping on a one-campus
       install: its room level is depth 3, which such a tree doesn't reach, so it proposes 124
       facilities holding no rooms — the TOPO-1 outcome, now ranked last on its own merits.
    2. **Whether real grouping objects name the facilities**, rather than everything collapsing into
       the unnamed default facility because no Site carries that FK. This sits high because an
       unnamed collapse always *looks* tidy — it scores one facility — while telling the operator
       nothing about their estate. It is also what lets `location` win the shape MODEL-8 exists for
       (a deep tree under one Site with no SiteGroups/Regions at all): there the Site-FK candidates
       name nothing and the top-level Locations name everything.
    3. **Fewer facilities.** A facility is an operator-facing partition of the whole map — a separate
       map, separate working dir, separate picker entry. All else equal one is a better answer than
       124, and this is the criterion that stops a *deeper* tree being read as a facility explosion.
    4. **How many Locations it leaves unplaced.** Reading a campus tree as `site-as-building` maps
       buildings→floors and floors→rooms, stranding every real room a level below the window.
       Ranked *below* the facility count on purpose: a campus → building → wing → floor tree leaves
       its rooms unplaced under every sane topology, and the right answer there is one facility plus
       the `deeper_tree` warning telling the operator to anchor on the wing (MULTI-5) — **not** one
       facility per building just because that window happens to reach the bottom of the tree.
    5. **The floors-per-building smell.** 124 floors in one building is a level misread even when
       nothing is left over.
    6. **Fixed `_CANDIDATES` order**, so a total tie still ranks reproducibly."""
    populated = sum(1 for key in ('buildings', 'floors', 'rooms') if candidate[key])
    per_building = candidate['floors_per_building']
    return (
        -populated,
        0 if candidate['named_facilities'] else 1,
        candidate['facilities'],
        candidate['unplaced_locations'],
        1 if (per_building or 0) > FLOORS_PER_BUILDING_SMELL else 0,
        index,
    )


def _tail_examples(levels, room_key):
    """Example names for the Locations a topology leaves unplaced — from the **first non-empty**
    level below its room level. A tree can skip a level (nothing at `L3` but plenty deeper), and an
    unplaced count with no example to show for it is the one thing this warning can't afford."""
    for key in _LOC_LEVELS[_LOC_LEVELS.index(room_key) + 1:]:
        if levels[key]['count']:
            return levels[key]['examples']
    return []


def _warnings(user, levels, top, floor_key, room_key):
    """The mismatches that actually make a *later* import fail, evaluated against the top-ranked
    candidate — reported here, where they are cheap to see, rather than discovered at bind time.

    Two of the three are the ones §7 calls out. **Floors with no child Locations** can't have their
    rooms bound at all: a `Room` binds to a child Location of the floor Location, so an install that
    doesn't model a Location per room has nothing to offer the bind picker (DOC-12) — a NetBox
    data-modelling fact, not a plugin defect, which is exactly why saying it early matters. **A
    deeper tree** (campus → building → wing → floor) needs the drawing folder anchored on the
    **wing**, because `models.parse_floor_key` reads segment −2 as the floors' *direct parent*
    (MULTI-5); anchoring on the building can never resolve, since its floors are grandchildren."""
    out = []
    if not levels['L0']['count']:
        out.append({
            'code': 'no_locations',
            'count': 0,
            'examples': [],
            'detail': 'This NetBox has no Locations, so there is nothing for rooms to bind to. '
                      'Rooms can still be drawn — they just stay draw-only.',
        })
        return out
    childless = (Location.objects.restrict(user, 'view')
                 .filter(_depth_q(_LOC_LEVELS.index(floor_key)), children__isnull=True))
    childless_level = _level(childless)
    if childless_level['count']:
        out.append({
            'code': 'floors_without_rooms',
            'count': childless_level['count'],
            'examples': childless_level['examples'],
            'detail': 'These floors have no child Locations, so their rooms cannot be bound — a '
                      'room binds to a child Location of its floor. Their rooms can still be drawn '
                      'as draw-only rooms.',
        })
    if top['unplaced_locations']:
        out.append({
            'code': 'deeper_tree',
            'count': top['unplaced_locations'],
            'examples': _tail_examples(levels, room_key),
            'detail': 'Your Location tree goes deeper than building → floor → room (for example '
                      'campus → building → wing → floor). Anchor each drawing folder on the '
                      "floors' direct parent — the wing, not the building — or those floors will "
                      'not resolve.',
        })
    return out


def _resolve_sample(user, sample):
    """Resolve operator-picked exemplars ("this object is a building, this one is a floor, this one
    is a room") into the topology they imply — the guided half of the probe, backing TOPO-3's
    searchbars for an operator who can point at their data far more reliably than they can pick a
    setting name.

    Returns `(problems, pair, campus)`: a list of inconsistencies, the derived
    `(grouping, org_mode)` or `None`, and the exemplars' `(site_slug, site_name, site)` in the same
    shape `_campus_site` produces, so `_candidate` can resolve either one's facility. A problem is a
    genuine contradiction in the picks — a "room" that is not a child of the picked floor cannot be
    a room in the sense the plugin means — and it is explained rather than silently repaired, since
    the operator is the only one who knows which of the two picks was wrong.

    **A sample never derives the `location` grouping.** Exemplars naming a building Location say
    "my buildings are Locations", and answering that with `location` grouping would make each of
    those buildings its own facility — precisely the misreading TOPO-1 exists to stop. An operator
    who genuinely wants a facility per building reaches it through the ranked candidates or the
    manual escape hatch, deliberately, not as the side effect of pointing at a building.

    Raises `ValueError` for a pk that names nothing the viewer can see, so the endpoint can 400
    (the `NbLocationCreateView` stance — a bad id is a client bug, not an empty result)."""
    # The grouping FKs come along because the exemplars' Site doubles as the campus, whose facility
    # `_candidate` resolves (`_campus_facility`).
    locs = Location.objects.restrict(user, 'view').select_related('site__group', 'site__region')
    picked = {}
    for role in ('building', 'floor', 'room'):
        if sample.get(role) is None:
            continue
        loc = locs.filter(pk=sample[role]).first()
        if loc is None:
            raise ValueError('the picked %s is not a Location you can view' % role)
        picked[role] = loc
    site = None
    if sample.get('site') is not None:
        site = (Site.objects.restrict(user, 'view').select_related('group', 'region')
                .filter(pk=sample['site']).first())
        if site is None:
            raise ValueError('the picked site is not a Site you can view')

    building, floor, room = picked.get('building'), picked.get('floor'), picked.get('room')
    problems = []
    if room is not None and floor is not None and room.parent_id != floor.pk:
        problems.append({'code': 'room_not_child_of_floor',
                         'detail': '%s is not a child of %s, so it cannot be one of its rooms.'
                                   % (room.name, floor.name)})
    if floor is not None and building is not None and floor.parent_id != building.pk:
        problems.append({'code': 'floor_not_child_of_building',
                         'detail': '%s is not a child of %s, so it cannot be one of its floors.'
                                   % (floor.name, building.name)})
    if building is not None and site is not None and building.site_id != site.pk:
        problems.append({'code': 'building_not_in_site',
                         'detail': '%s is not in %s.' % (building.name, site.name)})

    # The floor is what tells the two org modes apart: a floor at the top of the Location tree means
    # its building is the Site itself, a floor with a Location parent means the building is that
    # parent. Fall back to the room's own parent (which *is* the floor) when only a room was picked,
    # then to the building, so a partial sample still derives what it unambiguously can.
    anchor_floor = floor if floor is not None else (room.parent if room is not None else None)
    if anchor_floor is not None:
        mode = 'site-as-campus' if anchor_floor.parent_id else 'site-as-building'
    elif building is not None:
        mode = 'site-as-campus'
    else:
        problems.append({'code': 'not_enough_exemplars',
                         'detail': 'Pick at least a building, a floor or a room so the shape of '
                                   'your tree can be read.'})
        return problems, None, (None, None, None)
    if problems:
        return problems, None, (None, None, None)

    anchor = building or anchor_floor or room
    anchor_site = site or (anchor.site if anchor is not None else None)
    if anchor_site is None:
        return problems, None, (None, None, None)
    if anchor_site.group_id:
        group = 'sitegroup'
    elif anchor_site.region_id:
        group = 'region'
    else:
        group = GROUPING_DEFAULT
    return problems, (group, mode), (anchor_site.slug, anchor_site.name, anchor_site)


def probe(user, sample=None):
    """Survey the install's `dcim` tree and return the candidate topologies it supports, best first.

    `sample` — `{'site'|'building'|'floor'|'room': pk}`, any subset — switches to resolve-from-a-
    sample: the same envelope, with `candidates` narrowed to the one the exemplars imply (empty when
    they contradict each other) and a `sample` key carrying the explanation. Both modes return the
    same shape on purpose, so the wizard renders one thing.

    Returns `{'current', 'inventory', 'candidates', 'warnings'}` (+ `'sample'` in sample mode).
    Read-only. Raises `ValueError` on an exemplar pk the viewer can't resolve."""
    levels = _levels(user)
    facility_levels = _facility_levels(user)
    campus = _campus_site(user)

    problems, pair, sample_campus = ([], None, (None, None, None))
    if sample:
        problems, pair, sample_campus = _resolve_sample(user, sample)

    specs = _CANDIDATES
    if sample:
        # The exemplars' own Site is the campus, not the estate-wide guess: the operator pointed at
        # it, which is better evidence than "hosts the most top-level Locations".
        campus = sample_campus if sample_campus[0] else campus
        specs = tuple(s for s in _CANDIDATES if pair and (s[0], s[1]) == pair)

    candidates = [_candidate(spec, levels, facility_levels, campus) for spec in specs]
    ranked = sorted(range(len(candidates)), key=lambda i: _rank_key(candidates[i], i))
    candidates = [candidates[i] for i in ranked]

    warnings = []
    if candidates:
        # The winning spec's own floor/room level keys — an implementation detail of the window that
        # the warnings need and no client should key off, so they are passed rather than serialized.
        _g, _m, _b, floor_key, room_key = specs[ranked[0]]
        warnings = _warnings(user, levels, candidates[0], floor_key, room_key)

    result = {
        'current': {'grouping': grouping()},
        'inventory': {
            'regions': Region.objects.restrict(user, 'view').count(),
            'site_groups': SiteGroup.objects.restrict(user, 'view').count(),
            'sites': levels['site']['count'],
            'locations': {
                'total': Location.objects.restrict(user, 'view').count(),
                'by_depth': [levels['L%d' % d]['count'] for d in range(PROBE_DEPTHS)],
                'deeper': levels['deeper']['count'],
                # The deepest *probed* depth that holds Locations. When `deeper` is non-zero the
                # real tree runs at least one level further than this — the probe measures the
                # levels a topology can map and counts the rest in one bucket.
                'max_depth': max((d for d in range(PROBE_DEPTHS)
                                  if levels['L%d' % d]['count']), default=0),
            },
        },
        'candidates': candidates,
        'warnings': warnings,
    }
    if sample:
        result['sample'] = {'ok': not problems and pair is not None, 'problems': problems}
    return result
