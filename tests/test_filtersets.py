"""Tier C — `filtersets.RoomFilterSet` driven directly. The `floor_key`/`location_id` filters are
exercised end-to-end through the REST viewset in `test_api.py`; this file covers what that doesn't:
the `q` free-text `search()` method, the plain `label`/`room_id`/`id` field filters, and the
facility-shaped `site`/`site_id`/`facility`/`floor_location_id` filters (API-1).

Those last ones are where the interesting behaviour is: `Room` has no Site column, so they resolve
through `facilities.site_floor_scope`, which unions the rename-proof `floor_location` FK with the
`floor_key` site-slug prefix (BIND-1). The tests below pin both halves of that union — a room whose
Site was renamed (stale key, live FK) and a room with no FK at all (live key) — plus the
fail-closed empty case."""

import pytest

pytestmark = pytest.mark.django_db


def _filter(params):
    from netbox_facilitymap.filtersets import RoomFilterSet
    from netbox_facilitymap.models import Room
    return RoomFilterSet(params, queryset=Room.objects.all()).qs


# ---- q free-text search ----

def test_search_matches_label_room_id_and_floor_key():
    from netbox_facilitymap.models import Room
    Room.objects.create(floor_key='site-a/f1', room_id='r1', label='Server Room')
    Room.objects.create(floor_key='site-b/lab', room_id='needle', label='Lab')
    Room.objects.create(floor_key='site-c/f3', room_id='r3', label='Office')

    assert {r.room_id for r in _filter({'q': 'server'})} == {'r1'}   # label icontains
    assert {r.room_id for r in _filter({'q': 'needle'})} == {'needle'}  # room_id icontains
    assert {r.room_id for r in _filter({'q': 'site-c'})} == {'r3'}   # floor_key icontains


def test_search_matches_alias():
    # The NAV-18 printed-name synonyms are searchable via `q` too, so a room bound to a differently
    # named Location is still found by the number printed on the plan.
    from netbox_facilitymap.models import Room
    Room.objects.create(floor_key='s/f', room_id='idf', label='IDF-2A', alias='2107, Old Server Room')
    assert {r.room_id for r in _filter({'q': '2107'})} == {'idf'}


def test_search_is_case_insensitive():
    from netbox_facilitymap.models import Room
    Room.objects.create(floor_key='s/f', room_id='r1', label='Mechanical')
    assert {r.room_id for r in _filter({'q': 'MECH'})} == {'r1'}


def test_blank_search_returns_all_rooms():
    from netbox_facilitymap.models import Room
    Room.objects.create(floor_key='s/f', room_id='r1')
    Room.objects.create(floor_key='s/f', room_id='r2')
    assert _filter({'q': '   '}).count() == 2   # whitespace-only short-circuits to the full qs


# ---- plain field filters ----
# The `id`/`label`/`room_id` fields resolve to NetBox multi-value filters, so each param is a
# list (exactly what the QueryDict the REST viewset builds hands them) — a bare string would be
# iterated character-by-character and an int isn't iterable at all.

def test_filter_by_label():
    from netbox_facilitymap.models import Room
    Room.objects.create(floor_key='s/f', room_id='r1', label='Alpha')
    Room.objects.create(floor_key='s/f', room_id='r2', label='Beta')
    assert {r.room_id for r in _filter({'label': ['Alpha']})} == {'r1'}


def test_filter_by_room_id():
    from netbox_facilitymap.models import Room
    Room.objects.create(floor_key='s/f', room_id='keep')
    Room.objects.create(floor_key='s/f', room_id='drop')
    assert {r.room_id for r in _filter({'room_id': ['keep']})} == {'keep'}


def test_filter_by_id():
    from netbox_facilitymap.models import Room
    keep = Room.objects.create(floor_key='s/f', room_id='r1')
    Room.objects.create(floor_key='s/f', room_id='r2')
    assert [r.pk for r in _filter({'id': [keep.pk]})] == [keep.pk]


# ---- facility-shaped filters (API-1) ----

def _site_with_floor(name, slug, group=None):
    from dcim.models import Location, Site
    site = Site.objects.create(name=name, slug=slug, group=group)
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    return site, floor


def test_filter_by_site_slug_and_site_id():
    from netbox_facilitymap.models import Room
    site_a, floor_a = _site_with_floor('A', 'site-a')
    site_b, floor_b = _site_with_floor('B', 'site-b')
    Room.objects.create(floor_key='site-a/floor-1', room_id='a1', floor_location=floor_a)
    Room.objects.create(floor_key='site-b/floor-1', room_id='b1', floor_location=floor_b)

    assert {r.room_id for r in _filter({'site': ['site-a']})} == {'a1'}
    assert {r.room_id for r in _filter({'site_id': [site_b.pk]})} == {'b1'}
    assert {r.room_id for r in _filter({'site_id': [site_a.pk, site_b.pk]})} == {'a1', 'b1'}


def test_site_filter_matches_a_room_whose_site_was_renamed():
    # The BIND-1 half of the union: the room's `floor_key` still carries the *old* site slug (it is
    # frozen in the manifest), but its `floor_location` FK points at the live, renamed Site — so the
    # room still answers "which rooms are at this Site?".
    from netbox_facilitymap.models import Room
    site, floor = _site_with_floor('Renamed', 'site-new')
    Room.objects.create(floor_key='site-old/floor-1', room_id='moved', floor_location=floor)

    assert {r.room_id for r in _filter({'site': ['site-new']})} == {'moved'}
    assert {r.room_id for r in _filter({'site_id': [site.pk]})} == {'moved'}


def test_site_filter_matches_a_room_with_no_floor_location_via_its_key_prefix():
    # The other half: a room whose floor key never resolved to a Location (null FK) is still found
    # by its key's site-slug prefix, for both the 2- and 3-segment key shapes (MODEL-3).
    from netbox_facilitymap.models import Room
    _site_with_floor('A', 'site-a')
    Room.objects.create(floor_key='site-a/floor-9', room_id='flat')
    Room.objects.create(floor_key='site-a/bldg/floor-9', room_id='nested')
    Room.objects.create(floor_key='site-z/floor-9', room_id='other')

    assert {r.room_id for r in _filter({'site': ['site-a']})} == {'flat', 'nested'}


def test_site_filter_rejects_an_unknown_site_at_the_form_layer():
    # A `ModelMultipleChoiceFilter` resolves the slug to a `Site` *before* our method runs, so an
    # unknown slug is a form error rather than a query returning nothing. That is what makes the
    # REST surface answer 400 (`test_api.py`) instead of silently listing every room; driving the
    # filterset directly, django-filter drops the invalid field and leaves the queryset alone.
    from netbox_facilitymap.filtersets import RoomFilterSet
    from netbox_facilitymap.models import Room
    _site_with_floor('A', 'site-a')
    Room.objects.create(floor_key='site-a/floor-1', room_id='a1')

    fs = RoomFilterSet({'site': ['nope']}, queryset=Room.objects.all())
    assert not fs.is_valid()
    assert 'site' in fs.errors


def test_filter_by_facility_groups_sites():
    # `facility` delegates to `facilities.facility_site_slugs`, so it follows the install-wide
    # grouping: a SiteGroup slug selects that group's sites and nothing else.
    from dcim.models import SiteGroup
    from netbox_facilitymap.models import Room
    campus = SiteGroup.objects.create(name='Campus', slug='campus')
    _site_with_floor('Grouped', 'site-in', group=campus)
    _site_with_floor('Ungrouped', 'site-out')
    Room.objects.create(floor_key='site-in/floor-1', room_id='inside')
    Room.objects.create(floor_key='site-out/floor-1', room_id='outside')

    assert {r.room_id for r in _filter({'facility': 'campus'})} == {'inside'}


def test_an_empty_facility_param_filters_nothing():
    # django-filter treats an empty value as "param not supplied" and never calls the filter, so
    # `?facility=` is a no-op rather than a way to ask for the default facility's ungrouped
    # remainder. Standard framework behaviour, pinned here because '' *is* a meaningful facility
    # slug elsewhere in the plugin — name the Sites directly if you need that set.
    from dcim.models import SiteGroup
    from netbox_facilitymap.models import Room
    campus = SiteGroup.objects.create(name='Campus', slug='campus')
    _site_with_floor('Grouped', 'site-in', group=campus)
    _site_with_floor('Ungrouped', 'site-out')
    Room.objects.create(floor_key='site-in/floor-1', room_id='inside')
    Room.objects.create(floor_key='site-out/floor-1', room_id='outside')

    assert {r.room_id for r in _filter({'facility': ''})} == {'inside', 'outside'}


def test_filter_by_facility_is_fail_closed_for_an_unknown_facility():
    from netbox_facilitymap.models import Room
    _site_with_floor('A', 'site-a')
    Room.objects.create(floor_key='site-a/floor-1', room_id='a1')

    assert _filter({'facility': 'no-such-campus'}).count() == 0


def test_filter_by_floor_location_id():
    # The rename-proof way to ask for one floor's rooms: the FK, not the frozen `floor_key` slug.
    from netbox_facilitymap.models import Room
    _site, floor_a = _site_with_floor('A', 'site-a')
    _site_b, floor_b = _site_with_floor('B', 'site-b')
    Room.objects.create(floor_key='old-slug/floor-1', room_id='a1', floor_location=floor_a)
    Room.objects.create(floor_key='site-b/floor-1', room_id='b1', floor_location=floor_b)

    assert {r.room_id for r in _filter({'floor_location_id': [floor_a.pk]})} == {'a1'}


# ---- the facility filter under the `location` grouping (MODEL-8) ----

def test_facility_filter_scopes_to_the_location_subtree():
    # Two location-grouping facilities share one campus Site, so the facility filter must resolve
    # by subtree (facility_floor_scope), not by Site slug — a Site-wide match would return the
    # sibling facility's rooms too.
    from dcim.models import Location, Site
    from netbox_facilitymap.models import FacilityMapBlob, Room

    FacilityMapBlob.objects.update_or_create(
        kind='settings', facility='', key='', defaults={'data': {'facility_grouping': 'location'}})
    site = Site.objects.create(name='Campus', slug='campus')
    a = Location.objects.create(name='Building A', slug='bldg-a', site=site)
    b = Location.objects.create(name='Building B', slug='bldg-b', site=site)
    fa = Location.objects.create(name='A L1', slug='a-l1', site=site, parent=a)
    fb = Location.objects.create(name='B L1', slug='b-l1', site=site, parent=b)
    Room.objects.create(floor_key='campus/bldg-a/a-l1', room_id='ra', floor_location=fa)
    Room.objects.create(floor_key='campus/bldg-b/b-l1', room_id='rb', floor_location=fb)

    assert {r.room_id for r in _filter({'facility': 'bldg-a'})} == {'ra'}
    assert {r.room_id for r in _filter({'facility': 'bldg-b'})} == {'rb'}
    # Fail-closed like the Site filters: an unknown facility matches nothing, not everything.
    assert _filter({'facility': 'no-such'}).count() == 0
