"""Tier C — `topology.probe`, the read-only DCIM topology probe (TOPO-2).

The probe answers "what shape is this NetBox, and which plugin settings express it?" so the import
wizard can propose a `{grouping, org_mode, campus_site}` triple instead of asking an operator to
translate their estate into two setting names. The headline test is the shape that motivated the
item — one campus Site whose buildings are top-level Locations — which **must** rank
`{sitegroup, site-as-campus}` first and never `location` grouping, whose reading of that tree is
one facility per building (the TOPO-1 dead end).

The rest pin the parts that would silently rot: the ranking on the other real topologies, the
object-permission scoping every read here owes (§4 — the plugin holds no REST token), the
resolve-from-a-sample contradictions, the two mismatch warnings §7 calls out, and that a probe
writes nothing."""

import pytest
from django.urls import reverse

from netbox_facilitymap import topology
from netbox_facilitymap.models import FacilityMapBlob

pytestmark = pytest.mark.django_db

TOPOLOGY = 'plugins:netbox_facilitymap:api-nb-topology'


def _children(parent_of, site, names, prefix):
    """Create one Location per name under `parent_of` (a Location, or None for top-level)."""
    from dcim.models import Location
    return [Location.objects.create(name='%s %s' % (prefix, n), slug='%s-%s' % (prefix.lower(), n),
                                    site=site, parent=parent_of)
            for n in names]


def _campus_shape():
    """The reporting install, in miniature: one SiteGroup, one campus Site, buildings as top-level
    Locations, floors their children, rooms their grandchildren. L0=3, L1=6, L2=12."""
    from dcim.models import Site, SiteGroup
    group = SiteGroup.objects.create(name='Cal Poly', slug='cal-poly')
    site = Site.objects.create(name='SLO Campus', slug='slo-campus', group=group)
    buildings = _children(None, site, ('a', 'b', 'c'), 'Bldg')
    for building in buildings:
        for floor in _children(building, site, ('1', '2'), 'Floor'):
            _children(floor, site, ('1', '2'), 'Room')
    return group, site, buildings


def _site_as_building_shape():
    """Each building its own Site (the plugin's default reading): floors are the Site's top-level
    Locations, rooms their children. L0=4, L1=8, L2=0."""
    from dcim.models import Site, SiteGroup
    group = SiteGroup.objects.create(name='North', slug='north')
    sites = [Site.objects.create(name='Bldg %s' % n, slug='bldg-%s' % n, group=group)
             for n in ('a', 'b')]
    for site in sites:
        for floor in _children(None, site, ('1', '2'), 'Floor'):
            _children(floor, site, ('1', '2'), 'Room')
    return sites


def _wing_shape():
    """A deeper tree — campus → building → wing → floor → room (MULTI-5). L0=2, L1=4, L2=8, L3=16.
    The rooms sit a level below every supported window, which is what `deeper_tree` reports."""
    from dcim.models import Site, SiteGroup
    group = SiteGroup.objects.create(name='Cal Poly', slug='cal-poly')
    site = Site.objects.create(name='SLO Campus', slug='slo-campus', group=group)
    for building in _children(None, site, ('a', 'b'), 'Bldg'):
        for wing in _children(building, site, ('%s-n' % building.slug, '%s-s' % building.slug),
                              'Wing'):
            for floor in _children(wing, site, ('%s-1' % wing.slug, '%s-2' % wing.slug), 'Floor'):
                _children(floor, site, ('%s-1' % floor.slug, '%s-2' % floor.slug), 'Room')
    return site


def _top(user):
    return topology.probe(user)['candidates'][0]


# --- The headline: the shape TOPO-2 was written for ----------------------------------------------

def test_campus_shape_ranks_sitegroup_site_as_campus_first(superuser):
    # The reporting install: picking `location` grouping here fans one campus into a facility per
    # building (TOPO-1). The probe must propose the campus reading instead, with the real numbers.
    _group, site, _buildings = _campus_shape()

    top = _top(superuser)
    assert top['grouping'] == 'sitegroup'
    assert top['org_mode'] == 'site-as-campus'
    assert top['campus_site'] == site.slug
    assert (top['facilities'], top['buildings'], top['floors'], top['rooms']) == (1, 3, 6, 12)
    assert top['unplaced_locations'] == 0


def test_campus_shape_never_proposes_location_grouping_first(superuser):
    # `location` grouping reads this tree as facility-per-building: its room level is depth 3, which
    # this tree doesn't reach, so it proposes N facilities holding no rooms. It must rank last on
    # exactly that merit, not be special-cased away.
    _campus_shape()

    candidates = topology.probe(superuser)['candidates']
    assert candidates[0]['grouping'] != 'location'
    location = next(c for c in candidates if c['grouping'] == 'location')
    assert location['rooms'] == 0
    assert candidates.index(location) == len(candidates) - 1


def test_examples_name_real_objects_at_each_level(superuser):
    # Numbers alone can't be checked by the operator; the example names are what let them recognize
    # their own estate ("buildings: Administration, Business, Chase Hall…").
    _campus_shape()

    examples = _top(superuser)['examples']
    assert examples['facilities'] == ['Cal Poly']
    assert examples['buildings'] == ['Bldg a', 'Bldg b', 'Bldg c']
    assert len(examples['floors']) == topology.EXAMPLE_CAP     # capped, not the whole inventory
    assert all(name.startswith('Room ') for name in examples['rooms'])


def test_campus_candidate_names_the_facility_its_campus_belongs_to(superuser):
    # IMPORT-17: the counts above are install-wide, but every wizard step after the layout question
    # searches only the ACTIVE facility (FACIL-1). A fresh SPA sits on the default facility '', which
    # under a Site-FK grouping means the *ungrouped* remainder — empty here, since the campus Site
    # carries a SiteGroup. That divergence is what made the probe report buildings the split step
    # then couldn't find, so a campus-shaped candidate has to name the facility it implies.
    _campus_shape()

    top = _top(superuser)
    assert top['campus_facility'] == 'cal-poly'      # the campus Site's SiteGroup, not ''


def test_campus_facility_follows_the_candidates_own_grouping(superuser):
    # The field is resolved under each candidate's PROSPECTIVE grouping, not the stored one: the
    # region candidate reads the same campus Site through its Region FK (unset here → the default
    # facility), and `location` gets `null` — one campus hosts many top-level Locations, so no
    # single slug describes the facility.
    _campus_shape()

    by_key = {(c['grouping'], c['org_mode']): c for c in topology.probe(superuser)['candidates']}
    assert by_key[('sitegroup', 'site-as-campus')]['campus_facility'] == 'cal-poly'
    assert by_key[('region', 'site-as-campus')]['campus_facility'] == ''
    assert by_key[('location', 'site-as-campus')]['campus_facility'] is None
    # A site-as-building candidate has no campus at all, so there is nothing to resolve.
    assert by_key[('sitegroup', 'site-as-building')]['campus_facility'] is None


def test_campus_facility_is_the_default_facility_for_an_ungrouped_campus(superuser):
    # '' is a real answer, not "unknown": an ungrouped campus Site genuinely belongs to the default
    # facility, and the wizard must be able to tell that apart from the `null` above.
    from dcim.models import Site
    site = Site.objects.create(name='SLO Campus', slug='slo-campus')
    for building in _children(None, site, ('a', 'b'), 'Bldg'):
        for floor in _children(building, site, ('1', '2'), 'Floor'):
            _children(floor, site, ('1', '2'), 'Room')

    top = _top(superuser)
    assert top['org_mode'] == 'site-as-campus'
    assert top['campus_facility'] == ''


def test_effective_org_mode_is_reported_for_location_grouping(superuser):
    # The server forces `site-as-campus` for a Location-subtree facility (`facilities.org_mode`), so
    # the probe must report the EFFECTIVE mode — a `location` candidate proposing `site-as-building`
    # would describe a state the install can never be in.
    _campus_shape()

    modes = {c['org_mode'] for c in topology.probe(superuser)['candidates']
             if c['grouping'] == 'location'}
    assert modes == {'site-as-campus'}


# --- The other real topologies -------------------------------------------------------------------

def test_site_as_building_shape_ranks_site_as_building_first(superuser):
    _site_as_building_shape()

    top = _top(superuser)
    assert (top['grouping'], top['org_mode']) == ('sitegroup', 'site-as-building')
    assert (top['facilities'], top['buildings'], top['floors'], top['rooms']) == (1, 2, 4, 8)
    assert top['campus_site'] is None       # not a campus topology — nothing to scope a search to


def test_wing_tree_stays_one_facility_and_warns_instead_of_exploding(superuser):
    # campus → building → wing → floor → room. `location` grouping's window reaches the bottom of
    # this tree, but reading it that way means one facility per building. The right answer is one
    # facility plus the MULTI-5 warning: anchor the drawing folder on the wing, not the building.
    _wing_shape()

    result = topology.probe(superuser)
    top = result['candidates'][0]
    assert (top['grouping'], top['org_mode']) == ('sitegroup', 'site-as-campus')
    assert top['facilities'] == 1
    deeper = next(w for w in result['warnings'] if w['code'] == 'deeper_tree')
    assert deeper['count'] == 16 and deeper['examples']


def test_deep_tree_without_grouping_objects_ranks_location_first(superuser):
    # The shape MODEL-8 exists for: a deep estate under one Site with no SiteGroup/Region at all.
    # The Site-FK candidates name nothing (everything collapses into the unnamed default facility)
    # while the top-level Locations name every facility, so `location` is the honest answer.
    from dcim.models import Site
    site = Site.objects.create(name='Campus', slug='campus')
    for root in _children(None, site, ('north', 'south'), 'Zone'):
        for building in _children(root, site, ('%s-a' % root.slug, '%s-b' % root.slug), 'Bldg'):
            for floor in _children(building, site, ('%s-1' % building.slug,), 'Floor'):
                _children(floor, site, ('%s-1' % floor.slug, '%s-2' % floor.slug), 'Room')

    top = _top(superuser)
    assert top['grouping'] == 'location'
    assert (top['facilities'], top['buildings'], top['floors'], top['rooms']) == (2, 4, 4, 8)


def test_inventory_counts_the_tree_by_depth(superuser):
    _campus_shape()

    inventory = topology.probe(superuser)['inventory']
    assert inventory['site_groups'] == 1 and inventory['sites'] == 1 and inventory['regions'] == 0
    assert inventory['locations']['total'] == 21
    assert inventory['locations']['by_depth'] == [3, 6, 12, 0]
    assert inventory['locations']['deeper'] == 0
    assert inventory['locations']['max_depth'] == 2


# --- Scoping, gating, and read-only-ness ---------------------------------------------------------

def test_counts_are_object_permission_scoped(db):
    # §4: the plugin holds no REST token, so every read is ORM + `.restrict(user,'view')`. A probe
    # that counted objects the viewer can't see would leak the estate's shape past that boundary.
    from conftest import grant
    from dcim.models import Location, Site
    from utilities.testing import create_test_user

    _group, _site, buildings = _campus_shape()
    user = create_test_user('scoped')
    grant(user, FacilityMapBlob, ['view', 'change', 'import'])
    grant(user, Site, ['view'])
    # Only one of the three buildings (and none of its subtree) is visible to this user.
    grant(user, Location, ['view'], constraints={'slug': buildings[0].slug})

    result = topology.probe(user)
    assert result['inventory']['locations']['total'] == 1
    assert result['inventory']['locations']['by_depth'] == [1, 0, 0, 0]
    campus = next(c for c in result['candidates']
                  if (c['grouping'], c['org_mode']) == ('sitegroup', 'site-as-campus'))
    assert (campus['buildings'], campus['floors'], campus['rooms']) == (1, 0, 0)


def test_endpoint_requires_import_permission(client, plain_user):
    # Gated like `NbFacilityGroupingPreviewView` beside it — it fronts the same admin-tier decision.
    client.force_login(plain_user)
    assert client.get(reverse(TOPOLOGY)).status_code == 403


def test_endpoint_returns_the_probe_for_an_importer(client, superuser):
    _campus_shape()
    client.force_login(superuser)

    body = client.get(reverse(TOPOLOGY)).json()
    assert body['current']['grouping'] == 'sitegroup'   # the live setting, unchanged by probing
    assert body['candidates'][0]['org_mode'] == 'site-as-campus'
    assert 'sample' not in body      # only present when exemplars were passed


def test_probing_writes_nothing(client, superuser):
    # It proposes; it never sets. A probe an operator then ignores must leave no trace.
    _campus_shape()
    client.force_login(superuser)

    client.get(reverse(TOPOLOGY))
    assert not FacilityMapBlob.objects.exists()


# --- Resolve-from-a-sample -----------------------------------------------------------------------

def test_sample_derives_the_topology_its_exemplars_imply(client, superuser):
    from dcim.models import Location
    _group, site, buildings = _campus_shape()
    floor = Location.objects.filter(parent=buildings[0]).first()
    room = Location.objects.filter(parent=floor).first()
    client.force_login(superuser)

    body = client.get(reverse(TOPOLOGY), {'site': site.pk, 'building': buildings[0].pk,
                                          'floor': floor.pk, 'room': room.pk}).json()
    assert body['sample'] == {'ok': True, 'problems': []}
    assert len(body['candidates']) == 1
    assert (body['candidates'][0]['grouping'], body['candidates'][0]['org_mode']) \
        == ('sitegroup', 'site-as-campus')
    assert body['candidates'][0]['campus_site'] == site.slug
    # The exemplars' own Site is the campus here, so the facility it implies rides along too
    # (IMPORT-17) — the sample path produces that tuple separately from the estate-wide guess.
    assert body['candidates'][0]['campus_facility'] == 'cal-poly'


def test_sample_derives_site_as_building_from_a_top_level_floor(client, superuser):
    from dcim.models import Location
    sites = _site_as_building_shape()
    floor = Location.objects.filter(site=sites[0], parent__isnull=True).first()
    room = Location.objects.filter(parent=floor).first()
    client.force_login(superuser)

    body = client.get(reverse(TOPOLOGY), {'floor': floor.pk, 'room': room.pk}).json()
    assert body['sample']['ok'] is True
    assert body['candidates'][0]['org_mode'] == 'site-as-building'


def test_sample_explains_a_room_that_is_not_under_the_picked_floor(client, superuser):
    # The contradiction is reported, never silently repaired: only the operator knows which of the
    # two picks was the wrong one.
    from dcim.models import Location
    _group, _site, buildings = _campus_shape()
    floor = Location.objects.filter(parent=buildings[0]).first()
    other_room = Location.objects.filter(parent__parent=buildings[1]).first()
    client.force_login(superuser)

    body = client.get(reverse(TOPOLOGY), {'floor': floor.pk, 'room': other_room.pk}).json()
    assert body['sample']['ok'] is False
    assert [p['code'] for p in body['sample']['problems']] == ['room_not_child_of_floor']
    assert body['candidates'] == []


def test_sample_explains_a_floor_that_is_not_under_the_picked_building(client, superuser):
    from dcim.models import Location
    _group, _site, buildings = _campus_shape()
    other_floor = Location.objects.filter(parent=buildings[1]).first()
    client.force_login(superuser)

    body = client.get(reverse(TOPOLOGY), {'building': buildings[0].pk,
                                          'floor': other_floor.pk}).json()
    assert [p['code'] for p in body['sample']['problems']] == ['floor_not_child_of_building']


def test_sample_never_derives_location_grouping(client, superuser):
    # Pointing at a building Location says "my buildings are Locations" — answering that with
    # `location` grouping would make each of them its own facility, the exact TOPO-1 misreading.
    from dcim.models import Location
    _group, _site, buildings = _campus_shape()
    floor = Location.objects.filter(parent=buildings[0]).first()
    client.force_login(superuser)

    body = client.get(reverse(TOPOLOGY), {'building': buildings[0].pk, 'floor': floor.pk}).json()
    assert body['candidates'][0]['grouping'] == 'sitegroup'


def test_sample_rejects_an_id_the_caller_cannot_view(client, superuser):
    client.force_login(superuser)
    assert client.get(reverse(TOPOLOGY), {'room': 999999}).status_code == 400
    assert client.get(reverse(TOPOLOGY), {'room': 'abc'}).status_code == 400


# --- Warnings ------------------------------------------------------------------------------------

def test_floors_without_rooms_are_reported(superuser):
    # A Room binds to a child Location of its floor (DOC-12), so a floor with no children has
    # nothing to offer the bind picker — worth saying now rather than at bind time.
    from dcim.models import Location
    _group, site, buildings = _campus_shape()
    bare = Location.objects.create(name='Bldg d', slug='bldg-d', site=site)
    Location.objects.create(name='Floor bare', slug='floor-bare', site=site, parent=bare)

    warning = next(w for w in topology.probe(superuser)['warnings']
                   if w['code'] == 'floors_without_rooms')
    assert warning['count'] == 1 and warning['examples'] == ['Floor bare']


def test_an_install_with_no_locations_is_reported_as_unbindable(superuser):
    from dcim.models import Site
    Site.objects.create(name='Empty', slug='empty')

    codes = [w['code'] for w in topology.probe(superuser)['warnings']]
    assert codes == ['no_locations']


# --- The exemplar search behind the guided questions (TOPO-3) -------------------------------------

OBJECTS = 'plugins:netbox_facilitymap:api-nb-topology-objects'


def test_objects_requires_import_permission(client, plain_user):
    # Gated like the probe it feeds — it fronts the same admin-tier decision.
    client.force_login(plain_user)
    assert client.get(reverse(OBJECTS), {'kind': 'site'}).status_code == 403


def test_objects_rejects_an_unknown_kind_and_a_non_numeric_scope(client, superuser):
    # A bad input is a client bug, not an empty result (`NbTopologyView`'s stance).
    client.force_login(superuser)
    assert client.get(reverse(OBJECTS)).status_code == 400
    assert client.get(reverse(OBJECTS), {'kind': 'rack'}).status_code == 400
    assert client.get(reverse(OBJECTS), {'kind': 'location', 'parent': 'abc'}).status_code == 400
    assert client.get(reverse(OBJECTS), {'kind': 'location', 'site': 'abc'}).status_code == 400


def test_objects_finds_a_site_the_active_facility_does_not_contain(client, superuser):
    # The property the whole step rests on. `NbSitesView` is facility-scoped (FACIL-1), and here the
    # facility axis is what's being decided: under the default facility '' a grouped Site is NOT in
    # scope, so a facility-scoped picker would come up empty on exactly the campus install being
    # configured. This search is install-wide, like the probe it feeds.
    from netbox_facilitymap.facilities import facility_sites

    _group, site, _buildings = _campus_shape()
    assert site not in facility_sites('', user=superuser)   # the facility-scoped read finds nothing

    client.force_login(superuser)
    body = client.get(reverse(OBJECTS), {'kind': 'site'}).json()
    assert [o['slug'] for o in body['objects']] == [site.slug]


def test_objects_narrows_locations_by_site_and_by_parent(client, superuser):
    from dcim.models import Location, Site

    _group, site, buildings = _campus_shape()
    other = Site.objects.create(name='Other', slug='other')
    Location.objects.create(name='Elsewhere', slug='elsewhere', site=other)
    client.force_login(superuser)

    scoped = client.get(reverse(OBJECTS), {'kind': 'location', 'site': site.pk}).json()
    assert 'Elsewhere' not in [o['name'] for o in scoped['objects']]

    # `?parent=` is what chains the questions into a drill-down: a building's own floors, only.
    floors = client.get(reverse(OBJECTS),
                        {'kind': 'location', 'parent': buildings[0].pk}).json()
    assert sorted(o['name'] for o in floors['objects']) == ['Floor 1', 'Floor 2']
    assert all(o['parent_name'] == buildings[0].name and o['site_name'] == site.name
               for o in floors['objects'])


def test_objects_filters_by_name(client, superuser):
    _group, _site, _buildings = _campus_shape()
    client.force_login(superuser)

    body = client.get(reverse(OBJECTS), {'kind': 'location', 'q': 'Room'}).json()
    assert body['objects'] and all(o['name'].startswith('Room') for o in body['objects'])


def test_objects_are_object_permission_scoped(client, db):
    # Same stance as the probe: a picker must never name an object the viewer can't see.
    from conftest import grant
    from dcim.models import Location, Site
    from utilities.testing import create_test_user

    _group, _site, buildings = _campus_shape()
    user = create_test_user('picker')
    grant(user, FacilityMapBlob, ['view', 'change', 'import'])
    grant(user, Site, ['view'])
    grant(user, Location, ['view'], constraints={'slug': buildings[0].slug})
    client.force_login(user)

    body = client.get(reverse(OBJECTS), {'kind': 'location'}).json()
    assert [o['slug'] for o in body['objects']] == [buildings[0].slug]


def test_searching_for_objects_writes_nothing(client, superuser):
    _campus_shape()
    client.force_login(superuser)

    client.get(reverse(OBJECTS), {'kind': 'site'})
    client.get(reverse(OBJECTS), {'kind': 'location'})
    assert not FacilityMapBlob.objects.exists()
