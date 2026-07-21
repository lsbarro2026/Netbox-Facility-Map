"""`NbInventoryView` — the facility-wide room/rack/device search backing the siteplan finder's
*unplaced* results (NAV-3).

The endpoint enumerates NetBox rooms (child Locations), racks, and devices matching a query, so the
finder can surface items that exist in NetBox but were never drawn/placed on the map. The properties
under test: it matches by name and returns each item's floor hierarchy + display names; it is
facility-scoped like `NbSitesView` (FACIL-1) so one facility never lists another's inventory; it is
object-permission scoped (`.restrict(user,'view')`); and it returns only rooms *under a floor*
(never a floor/site-root Location) and only *unracked* devices.
"""

import json

import pytest
from django.urls import reverse

pytestmark = pytest.mark.django_db

INVENTORY = 'plugins:netbox_facilitymap:api-nb-inventory'


def _tree(group_slug, site_slug, *, room_name):
    """Build a Site→floor→room tree under a SiteGroup (the default grouping, so the Site resolves to
    facility=`group_slug`). Returns `(site, floor, room)`. Floor and room names embed a distinct
    token so a query can target one level."""
    from dcim.models import Location, Site, SiteGroup
    group, _ = SiteGroup.objects.get_or_create(slug=group_slug, defaults={'name': group_slug})
    site = Site.objects.create(name=site_slug, slug=site_slug, group=group)
    floor = Location.objects.create(name=f'{site_slug} Floor', slug=f'{site_slug}-floor', site=site)
    room = Location.objects.create(name=room_name, slug=f'{site_slug}-room', site=site, parent=floor)
    return site, floor, room


def _rack(site, room, name):
    from dcim.models import Rack
    return Rack.objects.create(name=name, site=site, location=room, status='active')


def _device(site, room, name, *, rack=None):
    from dcim.models import Device, DeviceRole, DeviceType, Manufacturer
    mfr, _ = Manufacturer.objects.get_or_create(name='M', slug='m')
    dtype, _ = DeviceType.objects.get_or_create(manufacturer=mfr, model='DT', slug='dt')
    role, _ = DeviceRole.objects.get_or_create(name='Role', slug='role')
    return Device.objects.create(name=name, device_type=dtype, role=role, site=site,
                                 location=room, rack=rack, status='active')


def _get(client, facility=None, q=None):
    url = reverse(INVENTORY)
    params = []
    if facility is not None:
        params.append('facility=' + facility)
    if q is not None:
        params.append('q=' + q)
    if params:
        url += '?' + '&'.join(params)
    return client.get(url)


def test_inventory_matches_room_rack_device_by_name(client, superuser):
    # One shared token ("Alpha") across a room, a rack, and an unracked device, so a single query
    # returns all three — and each result carries its floor hierarchy (site/floor slug == a manifest
    # dir/fid) plus display names for a disabled row.
    site, floor, room = _tree('ga', 'bldg-a', room_name='Alpha Room')
    _rack(site, room, 'Alpha Rack')
    _device(site, room, 'Alpha Server')
    client.force_login(superuser)

    body = _get(client, facility='ga', q='Alpha').json()
    (r,) = body['rooms']
    assert r['kind'] == 'room' and r['id'] == room.pk and r['name'] == 'Alpha Room'
    assert (r['site_slug'], r['floor_slug']) == ('bldg-a', 'bldg-a-floor')
    assert r['site_name'] == 'bldg-a' and r['floor_name'] == 'bldg-a Floor'
    (rk,) = body['racks']
    assert rk['kind'] == 'rack' and rk['name'] == 'Alpha Rack'
    assert (rk['site_slug'], rk['floor_slug'], rk['room_id']) == ('bldg-a', 'bldg-a-floor', room.pk)
    (d,) = body['devices']
    assert d['kind'] == 'device' and d['name'] == 'Alpha Server'
    assert (d['site_slug'], d['floor_slug'], d['room_id']) == ('bldg-a', 'bldg-a-floor', room.pk)


def test_inventory_matches_room_by_alias(client, superuser):
    # A room whose bound Location is named "IDF-2A" but whose *printed* number is "2107": searching the
    # printed number surfaces it via `Room.alias` (NAV-18), even though the Location name doesn't match.
    from netbox_facilitymap.models import Room
    site, floor, room = _tree('ga', 'bldg-a', room_name='IDF-2A')
    Room.objects.create(floor_key='bldg-a/bldg-a-floor', room_id='r1',
                        location=room, alias='2107, Old Server Room')
    client.force_login(superuser)

    (r,) = _get(client, facility='ga', q='2107').json()['rooms']
    assert r['id'] == room.pk and r['name'] == 'IDF-2A'
    # A query matching neither the Location name nor the alias returns nothing.
    assert _get(client, facility='ga', q='zzzz').json()['rooms'] == []


def test_inventory_alias_match_stays_facility_scoped(client, superuser):
    # An alias in another facility must never leak: the alias-widened room query is still bounded by
    # `site__in=sites`, so facility `gb`'s "2107" is invisible to a facility `ga` search (FACIL-1).
    from netbox_facilitymap.models import Room
    _tree('ga', 'bldg-a', room_name='IDF-2A')
    _, _, room_b = _tree('gb', 'bldg-b', room_name='IDF-2B')
    Room.objects.create(floor_key='bldg-b/bldg-b-floor', room_id='r1', location=room_b, alias='2107')
    client.force_login(superuser)

    assert _get(client, facility='ga', q='2107').json()['rooms'] == []
    assert len(_get(client, facility='gb', q='2107').json()['rooms']) == 1


def test_inventory_carries_netbox_url(client, superuser):
    # Each result carries its object's NetBox detail URL (absolute), for the search widget's
    # NetBox-target mode (NAV-16). It must match the object's own get_absolute_url().
    site, floor, room = _tree('ga', 'bldg-a', room_name='Alpha Room')
    rack = _rack(site, room, 'Alpha Rack')
    device = _device(site, room, 'Alpha Server')
    client.force_login(superuser)

    body = _get(client, facility='ga', q='Alpha').json()
    assert body['rooms'][0]['url'].endswith(room.get_absolute_url())
    assert body['racks'][0]['url'].endswith(rack.get_absolute_url())
    assert body['devices'][0]['url'].endswith(device.get_absolute_url())
    # Absolute (built against the request host), like the room-Location URLs the finder already uses.
    assert body['rooms'][0]['url'].startswith('http')


def test_inventory_short_or_empty_query_returns_empty(client, superuser):
    site, floor, room = _tree('ga', 'bldg-a', room_name='Alpha Room')
    client.force_login(superuser)

    for q in ('', 'A'):   # below the MIN_Q=2 floor
        body = _get(client, facility='ga', q=q).json()
        assert body == {'rooms': [], 'racks': [], 'devices': []}


def test_inventory_scoped_to_active_facility(client, superuser):
    # Two facilities, each with a same-named room; a query must only ever see the requested one's.
    _tree('ga', 'bldg-a', room_name='Shared Room')
    _tree('gb', 'bldg-b', room_name='Shared Room')
    client.force_login(superuser)

    a = _get(client, facility='ga', q='Shared').json()['rooms']
    b = _get(client, facility='gb', q='Shared').json()['rooms']
    assert {r['site_slug'] for r in a} == {'bldg-a'}
    assert {r['site_slug'] for r in b} == {'bldg-b'}


def test_inventory_excludes_floor_and_site_root_locations(client, superuser):
    # A room is a child of a floor Location; the floor itself (parent is null) must never be returned
    # as a finder target — its name matches "Floor", but it has no floor to navigate to.
    _tree('ga', 'bldg-a', room_name='Alpha Room')
    client.force_login(superuser)

    body = _get(client, facility='ga', q='Floor').json()
    assert body['rooms'] == []


def test_inventory_excludes_racked_device(client, superuser):
    # A device mounted in a rack shows under its rack on the map, not as its own marker — mirror
    # NbDevicesView and leave it out of the inventory search.
    site, floor, room = _tree('ga', 'bldg-a', room_name='Alpha Room')
    rack = _rack(site, room, 'Host Rack')
    _device(site, room, 'Racked Node', rack=rack)
    client.force_login(superuser)

    assert _get(client, facility='ga', q='Racked').json()['devices'] == []


def test_inventory_is_object_permission_scoped(client, login_only_user):
    # A bare authenticated user with no dcim view permission sees nothing, even where a query would
    # otherwise match — the finder never leaks inventory the user can't view.
    site, floor, room = _tree('ga', 'bldg-a', room_name='Alpha Room')
    _rack(site, room, 'Alpha Rack')
    _device(site, room, 'Alpha Server')
    client.force_login(login_only_user)

    body = _get(client, facility='ga', q='Alpha').json()
    assert body == {'rooms': [], 'racks': [], 'devices': []}


def test_inventory_rejects_bad_facility(client, superuser):
    client.force_login(superuser)
    assert _get(client, facility='bad.slug', q='Alpha').status_code == 400
