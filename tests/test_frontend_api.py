"""Tier C — `frontend_api.sync_rooms`, with the delete-scoping invariant as the headline.

A POST is authoritative for the whole annotations document, so rooms absent from it are deleted —
but only ones the saving user is permitted to delete (`restrict(user, 'delete')`). A user must
never silently wipe rooms they have no delete permission over."""

import json

import pytest
from django.urls import reverse

from netbox_facilitymap.frontend_api import VERSION_HEADER, sync_rooms
from netbox_facilitymap.models import FacilityMapBlob, Room

pytestmark = pytest.mark.django_db

FLOOR = 'test-site/floor-1'
LOCATIONS = 'plugins:netbox_facilitymap:api-nb-locations'
RACKS = 'plugins:netbox_facilitymap:api-nb-racks'
SITES = 'plugins:netbox_facilitymap:api-nb-sites'


def _floor_location():
    from dcim.models import Location, Site
    site = Site.objects.create(name='Test Site', slug='test-site')
    return site, Location.objects.create(name='Floor 1', slug='floor-1', site=site)


def test_upserts_and_binds_location(editor_user):
    from dcim.models import Location
    site, floor = _floor_location()
    room_loc = Location.objects.create(name='Room 101', slug='room-101', site=site, parent=floor)

    sync_rooms({FLOOR: [
        {'id': 'r1', 'label': 'R1', 'polygon': [[0, 0], [1, 0], [1, 1]],
         'location': {'id': room_loc.pk}},
    ]}, user=editor_user)

    room = Room.objects.get(room_id='r1')
    assert room.floor_key == FLOOR
    assert room.label == 'R1'
    assert room.polygon == [[0, 0], [1, 0], [1, 1]]
    assert room.location_id == room_loc.pk


def test_sync_rooms_round_trips_alias(editor_user):
    # The NAV-18 search-terms field persists through a save like `label`; a room posted with no
    # `alias` key stores the empty default (never NULL), so the finder never sees a stale value.
    sync_rooms({FLOOR: [
        {'id': 'r1', 'label': 'R1', 'alias': '2107, Old Server Room', 'polygon': [], 'location': None},
        {'id': 'r2', 'label': 'R2', 'polygon': [], 'location': None},
    ]}, user=editor_user)
    assert Room.objects.get(room_id='r1').alias == '2107, Old Server Room'
    assert Room.objects.get(room_id='r2').alias == ''


def test_serialize_room_includes_alias(rf, editor_user):
    # `_serialize_room` shapes a Room back into the frontend record; `alias` must ride along so the
    # composed annotations GET round-trips it into `Store.searchTargets` for the placed-search tier.
    from netbox_facilitymap.frontend_api import _serialize_room
    room = Room.objects.create(floor_key=FLOOR, room_id='r1', label='R1', alias='2107')
    req = rf.get('/')
    req.user = editor_user
    assert _serialize_room(room, req)['alias'] == '2107'


def test_deletes_absent_rooms_when_user_may(editor_user):
    Room.objects.create(floor_key=FLOOR, room_id='r1', label='R1')
    Room.objects.create(floor_key=FLOOR, room_id='r2', label='R2')

    # editor_user holds Room delete permission → the absent r2 is removed.
    sync_rooms({FLOOR: [{'id': 'r1', 'label': 'R1', 'polygon': [], 'location': None}]},
               user=editor_user)

    assert Room.objects.filter(room_id='r1').exists()
    assert not Room.objects.filter(room_id='r2').exists()


def test_spares_rooms_the_user_cannot_delete(plain_user):
    # The core invariant: plain_user has NO Room delete permission, so restrict(user,'delete')
    # is empty and the absent r2 must survive — even though the upsert of r1 still runs.
    Room.objects.create(floor_key=FLOOR, room_id='r1', label='R1')
    Room.objects.create(floor_key=FLOOR, room_id='r2', label='R2')

    sync_rooms({FLOOR: [{'id': 'r1', 'label': 'R1 edited', 'polygon': [], 'location': None}]},
               user=plain_user)

    assert Room.objects.get(room_id='r1').label == 'R1 edited'
    assert Room.objects.filter(room_id='r2').exists()


def test_whole_floor_absent_is_scoped_too(plain_user):
    # A floor missing entirely from the POST is also delete-scoped: plain_user can't drop it.
    Room.objects.create(floor_key='other-site/floor-9', room_id='rx', label='X')

    sync_rooms({FLOOR: []}, user=plain_user)

    assert Room.objects.filter(room_id='rx').exists()


def test_trusted_import_deletes_unconditionally(editor_user):
    # user=None is the trusted `facilitymap_import` command: full authority, unscoped delete.
    Room.objects.create(floor_key=FLOOR, room_id='r1')
    Room.objects.create(floor_key=FLOOR, room_id='r2')

    sync_rooms({FLOOR: [{'id': 'r1', 'label': '', 'polygon': [], 'location': None}]}, user=None)

    assert not Room.objects.filter(room_id='r2').exists()


def test_unknown_location_id_falls_back_to_null(editor_user):
    _floor_location()
    sync_rooms({FLOOR: [
        {'id': 'r1', 'label': '', 'polygon': [], 'location': {'id': 999999}},
    ]}, user=editor_user)
    assert Room.objects.get(room_id='r1').location_id is None


# --- Rename-proof floor binding (BIND-1): sync_rooms resolves the floor Location from `floor_key`
# and stores it as the stable `floor_location` FK, but only when it resolves — a save arriving after
# a rename (the SPA still POSTs the OLD floor_key) must never null a good FK. --------------------

def test_sync_sets_floor_location_from_key(editor_user):
    site, floor = _floor_location()
    sync_rooms({FLOOR: [{'id': 'r1', 'label': '', 'polygon': [], 'location': None}]},
               user=editor_user)
    assert Room.objects.get(room_id='r1').floor_location_id == floor.pk


def test_sync_floor_location_null_when_key_unresolvable(editor_user):
    # A floor-type key with no matching floor Location (or a genuinely orphaned key) leaves the FK
    # null — exactly today's behaviour for such keys.
    sync_rooms({'no-such-site/gl1': [{'id': 'r1', 'label': '', 'polygon': [], 'location': None}]},
               user=editor_user)
    assert Room.objects.get(room_id='r1').floor_location_id is None


def test_sync_floor_location_sticky_across_rename(editor_user):
    # First save binds the FK. Then rename the floor Location's slug so the frozen floor_key no
    # longer resolves; a subsequent save with that OLD key must PRESERVE the FK, not null it.
    site, floor = _floor_location()
    sync_rooms({FLOOR: [{'id': 'r1', 'label': 'R1', 'polygon': [], 'location': None}]},
               user=editor_user)
    assert Room.objects.get(room_id='r1').floor_location_id == floor.pk

    floor.slug = 'floor-1-renamed'
    floor.save()

    sync_rooms({FLOOR: [{'id': 'r1', 'label': 'R1 edited', 'polygon': [], 'location': None}]},
               user=editor_user)
    room = Room.objects.get(room_id='r1')
    assert room.label == 'R1 edited'          # the edit still applied
    assert room.floor_location_id == floor.pk  # …but the good FK survived the unresolvable key


# --- Location-anchored floor keys (MODEL-3): a 3-segment key "<site>/<building>/<floor>" resolves
# the floor Location UNDER the building Location, so two buildings under one campus can share a
# floor slug without cross-binding. ------------------------------------------------------------

def _campus_two_buildings_same_floor_slug():
    """A campus Site with two building Locations, each holding a floor Location of the SAME slug
    (`level-1`) — the ambiguity 3-segment keys must resolve by parent."""
    from dcim.models import Location, Site
    campus = Site.objects.create(name='Campus', slug='campus')
    alpha = Location.objects.create(name='Alpha', slug='alpha-bldg', site=campus)
    beta = Location.objects.create(name='Beta', slug='beta-bldg', site=campus)
    a_l1 = Location.objects.create(name='Alpha L1', slug='level-1', site=campus, parent=alpha)
    b_l1 = Location.objects.create(name='Beta L1', slug='level-1', site=campus, parent=beta)
    return campus, alpha, beta, a_l1, b_l1


def test_sync_resolves_three_segment_key_under_its_building(editor_user):
    # Each building's 3-segment key must bind its room to the floor under THAT building — not the
    # same-slug floor under the sibling building.
    campus, alpha, beta, a_l1, b_l1 = _campus_two_buildings_same_floor_slug()

    sync_rooms({
        'campus/alpha-bldg/level-1': [{'id': 'ra', 'label': 'A', 'polygon': [], 'location': None}],
        'campus/beta-bldg/level-1': [{'id': 'rb', 'label': 'B', 'polygon': [], 'location': None}],
    }, user=editor_user)

    assert Room.objects.get(room_id='ra').floor_location_id == a_l1.pk
    assert Room.objects.get(room_id='rb').floor_location_id == b_l1.pk


def test_sync_three_segment_key_unresolvable_when_building_absent(editor_user):
    # A 3-segment key whose building slug matches no Location leaves the FK null (the floor exists
    # under a DIFFERENT parent) — the resolver is scoped by parent, not just (site, floor).
    campus, alpha, beta, a_l1, b_l1 = _campus_two_buildings_same_floor_slug()

    sync_rooms({'campus/ghost-bldg/level-1': [
        {'id': 'r1', 'label': '', 'polygon': [], 'location': None}]}, user=editor_user)

    assert Room.objects.get(room_id='r1').floor_location_id is None


NB_ROOMS = 'plugins:netbox_facilitymap:api-nb-rooms'


def test_nb_rooms_building_param_disambiguates_same_slug_floors(client, superuser):
    # `?building=` scopes the floor lookup under the building Location, so the same `?floor=level-1`
    # resolves to a different floor (and its own rooms) per building. Uses `superuser` because the
    # view reads Locations through `.restrict(user, 'view')` (dcim view is object-perm gated).
    from dcim.models import Location
    campus, alpha, beta, a_l1, b_l1 = _campus_two_buildings_same_floor_slug()
    Location.objects.create(name='Alpha Room', slug='a-room', site=campus, parent=a_l1)
    Location.objects.create(name='Beta Room', slug='b-room', site=campus, parent=b_l1)
    client.force_login(superuser)

    ra = client.get(reverse(NB_ROOMS),
                    {'site': 'campus', 'building': 'alpha-bldg', 'floor': 'level-1'}).json()
    rb = client.get(reverse(NB_ROOMS),
                    {'site': 'campus', 'building': 'beta-bldg', 'floor': 'level-1'}).json()

    assert ra['floor']['id'] == a_l1.pk and [r['slug'] for r in ra['rooms']] == ['a-room']
    assert rb['floor']['id'] == b_l1.pk and [r['slug'] for r in rb['rooms']] == ['b-room']


# --- NbBuildingLocationsView (MODEL-4): the Site = campus sibling of NbSitesView. Returns
# building-anchor Locations — those with child Locations (their floors) OR at the top of the
# Location tree (a building not yet drawn, IMPORT-14) — facility-scoped like the Site search
# (FACIL-1), so the wizard's bind step and split picker can offer a building Location as an anchor. -

BUILDING_LOCATIONS = 'plugins:netbox_facilitymap:api-nb-building-locations'


def test_nb_building_locations_returns_only_building_like_locations(client, superuser):
    # A building anchor is a Location that has child Locations (its floors) or sits at the top of the
    # tree — the structural signal, since NetBox has no LocationType to key off. Here both buildings
    # are top-level AND have floors; the floor Locations beneath them (non-top-level, no children of
    # their own) are not returned.
    campus, alpha, beta, a_l1, b_l1 = _campus_two_buildings_same_floor_slug()
    client.force_login(superuser)

    body = client.get(reverse(BUILDING_LOCATIONS)).json()
    assert {l['slug'] for l in body['locations']} == {'alpha-bldg', 'beta-bldg'}
    # Each hit carries its campus Site, so the frontend records siteSlug alongside buildingSlug.
    alpha_row = next(l for l in body['locations'] if l['slug'] == 'alpha-bldg')
    assert alpha_row['site_slug'] == 'campus' and alpha_row['site_name'] == 'Campus'


def test_nb_building_locations_includes_floorless_top_level_building(client, superuser):
    # IMPORT-14: a building modelled in NetBox but not yet drawn (a top-level Location with no floor
    # children) is offered too, so the split-wizard picker can seed from it — the has-children signal
    # alone would drop it. A leaf floor deeper in the tree (non-top-level, no rooms yet) has neither
    # signal and stays excluded, keeping the picker to plausible buildings.
    from dcim.models import Location, Site
    campus = Site.objects.create(name='Campus', slug='campus')
    drawn = Location.objects.create(name='Drawn Bldg', slug='drawn-bldg', site=campus)
    Location.objects.create(name='Floor 1', slug='floor-1', site=campus, parent=drawn)
    Location.objects.create(name='Floorless Bldg', slug='floorless-bldg', site=campus)
    client.force_login(superuser)

    slugs = {l['slug'] for l in client.get(reverse(BUILDING_LOCATIONS)).json()['locations']}
    assert 'floorless-bldg' in slugs    # top-level, no floors yet → now offered (IMPORT-14)
    assert 'drawn-bldg' in slugs        # top-level with a floor child → still offered
    assert 'floor-1' not in slugs       # a leaf floor (no rooms) → still excluded


def test_nb_building_locations_q_filters_by_name_or_slug(client, superuser):
    campus, alpha, beta, a_l1, b_l1 = _campus_two_buildings_same_floor_slug()
    client.force_login(superuser)

    by_name = client.get(reverse(BUILDING_LOCATIONS), {'q': 'Alpha'}).json()
    assert {l['slug'] for l in by_name['locations']} == {'alpha-bldg'}
    by_slug = client.get(reverse(BUILDING_LOCATIONS), {'q': 'beta-bldg'}).json()
    assert {l['slug'] for l in by_slug['locations']} == {'beta-bldg'}


def test_nb_building_locations_scoped_to_facility(client, superuser):
    # FACIL-1: a building Location under facility A's campus is never offered when binding under
    # facility B — its site slug would become the manifest siteSlug, so an out-of-facility bind would
    # strand the map, exactly as NbSitesView guards for Sites.
    from dcim.models import Location
    sa = _grouped_site('ga', 'campus-a')
    sb = _grouped_site('gb', 'campus-b')
    a_bldg = Location.objects.create(name='A Building', slug='a-bldg', site=sa)
    Location.objects.create(name='A L1', slug='a-l1', site=sa, parent=a_bldg)
    b_bldg = Location.objects.create(name='B Building', slug='b-bldg', site=sb)
    Location.objects.create(name='B L1', slug='b-l1', site=sb, parent=b_bldg)
    client.force_login(superuser)

    body = client.get(reverse(BUILDING_LOCATIONS) + '?facility=ga').json()
    assert {l['slug'] for l in body['locations']} == {'a-bldg'}


def test_nb_building_locations_are_invisible_from_the_default_facility(client, superuser):
    # IMPORT-17, the divergence this endpoint is on the wrong side of by design: the default facility
    # '' means the UNGROUPED remainder, so on a fully-grouped install it holds no Sites and therefore
    # no buildings — while `topology.probe`, which is deliberately facility-agnostic, still counts
    # them all. That is how the wizard's layout step could report N buildings and its split step find
    # none. The scoping is correct and must stay; the fix belongs in the client committing to a real
    # facility (`ImportFlow._reconcileFacility`), so pin this rather than let anyone widen FACIL-1.
    from dcim.models import Location
    campus = _grouped_site('cal-poly', 'slo-campus')
    bldg = Location.objects.create(name='Administration', slug='admin-bldg', site=campus)
    Location.objects.create(name='Floor 1', slug='admin-l1', site=campus, parent=bldg)
    client.force_login(superuser)

    scoped = client.get(reverse(BUILDING_LOCATIONS) + '?facility=cal-poly').json()
    assert {l['slug'] for l in scoped['locations']} == {'admin-bldg'}
    default = client.get(reverse(BUILDING_LOCATIONS) + '?facility=').json()
    assert default['locations'] == []


def test_nb_building_locations_rejects_bad_facility(client, superuser):
    client.force_login(superuser)
    assert client.get(reverse(BUILDING_LOCATIONS) + '?facility=../evil').status_code == 400


def test_nb_building_locations_site_param_narrows_to_one_campus(client, superuser):
    # MODEL-7: a site-as-campus facility picks its campus once, then the per-building search is scoped
    # to that Site via ?site=. Two ungrouped campuses under the default facility; ?site= selects one.
    from dcim.models import Location, Site
    ca = Site.objects.create(name='Campus A', slug='campus-a')
    cb = Site.objects.create(name='Campus B', slug='campus-b')
    a_bldg = Location.objects.create(name='A Building', slug='a-bldg', site=ca)
    Location.objects.create(name='A L1', slug='a-l1', site=ca, parent=a_bldg)
    b_bldg = Location.objects.create(name='B Building', slug='b-bldg', site=cb)
    Location.objects.create(name='B L1', slug='b-l1', site=cb, parent=b_bldg)
    client.force_login(superuser)

    # No ?site= → both campuses' buildings (today's behaviour, unchanged).
    both = client.get(reverse(BUILDING_LOCATIONS)).json()
    assert {l['slug'] for l in both['locations']} == {'a-bldg', 'b-bldg'}
    # ?site= narrows to that one campus.
    scoped = client.get(reverse(BUILDING_LOCATIONS), {'site': 'campus-a'}).json()
    assert {l['slug'] for l in scoped['locations']} == {'a-bldg'}


def test_nb_building_locations_site_param_narrows_within_facility_scope(client, superuser):
    # The narrowing is applied INSIDE the facility scope, never instead of it: a ?site= naming a Site
    # in some OTHER facility selects nothing rather than widening past the facility guard (FACIL-1).
    from dcim.models import Location
    sa = _grouped_site('ga', 'campus-a')
    sb = _grouped_site('gb', 'campus-b')
    a_bldg = Location.objects.create(name='A Building', slug='a-bldg', site=sa)
    Location.objects.create(name='A L1', slug='a-l1', site=sa, parent=a_bldg)
    b_bldg = Location.objects.create(name='B Building', slug='b-bldg', site=sb)
    Location.objects.create(name='B L1', slug='b-l1', site=sb, parent=b_bldg)
    client.force_login(superuser)

    # Facility ga scoped to its own campus → its building.
    own = client.get(reverse(BUILDING_LOCATIONS), {'facility': 'ga', 'site': 'campus-a'}).json()
    assert {l['slug'] for l in own['locations']} == {'a-bldg'}
    # Facility ga but ?site= names facility gb's campus → empty, not gb's building.
    cross = client.get(reverse(BUILDING_LOCATIONS), {'facility': 'ga', 'site': 'campus-b'}).json()
    assert cross['locations'] == []


# --- Optimistic-concurrency guard (CONC-1): the version token echoed on GET must be sent back on
# POST, and a stale token is rejected with 409 so a concurrent editor's work isn't clobbered. The
# per-floor kinds shard by floor, so their token is a `{floor_key: token}` map and a save carries
# only the floors it touched — different-floor saves are genuinely non-conflicting; only a real
# same-floor overlap 409s. Exercised through the real permission-gated views (Django test client). --

ANNOTATIONS = 'plugins:netbox_facilitymap:api-annotations'
SITEPLAN = 'plugins:netbox_facilitymap:api-siteplan'
PLACEMENTS = 'plugins:netbox_facilitymap:api-placements'
LAYOUTS = 'plugins:netbox_facilitymap:api-layouts'
FLOOR2 = 'test-site/floor-2'


def _post_json(client, name, body, version=None):
    headers = {} if version is None else {VERSION_HEADER: version}
    return client.post(reverse(name), data=json.dumps(body),
                       content_type='application/json', headers=headers)


def _versions(resp):
    """The per-floor token map a sharded GET/POST echoes in its header."""
    return json.loads(resp.headers[VERSION_HEADER])


def _room(rid, label='', poly=None):
    return {'id': rid, 'label': label, 'polygon': poly or [], 'location': None}


def test_annotations_version_roundtrips_from_get_to_save(client, editor_user):
    # A first GET on an empty map yields an empty token map; POSTing a floor's first-write token ('')
    # writes and mints a fresh per-floor token that the next GET echoes — the single-editor path.
    client.force_login(editor_user)
    r0 = client.get(reverse(ANNOTATIONS))
    assert _versions(r0) == {}

    r1 = _post_json(client, ANNOTATIONS, {FLOOR: {'rooms': [_room('r1', 'R1')]}},
                    version=json.dumps({FLOOR: ''}))
    assert r1.status_code == 200
    v1 = _versions(r1)
    assert v1[FLOOR] != ''
    assert Room.objects.filter(room_id='r1').exists()

    assert _versions(client.get(reverse(ANNOTATIONS))) == v1


def test_annotations_stale_token_conflicts_and_spares_concurrent_rooms(client, editor_user):
    # The headline same-floor case: editor B holds a token from before editor A added r2, and both
    # edit the SAME floor. B's save (a floor document that never had r2) must be rejected with 409 —
    # otherwise sync_rooms, authoritative for the floor, would delete r2. r2 must survive and B's own
    # r1 edit must NOT be applied.
    client.force_login(editor_user)
    v1 = _post_json(client, ANNOTATIONS,
                    {FLOOR: {'rooms': [_room('r1', 'R1')]}}, version='').headers[VERSION_HEADER]
    # Editor A adds r2, advancing this floor's token past the one B still holds (v1).
    _post_json(client, ANNOTATIONS,
               {FLOOR: {'rooms': [_room('r1', 'R1'), _room('r2', 'R2')]}}, version=v1)

    stale = _post_json(client, ANNOTATIONS,
                       {FLOOR: {'rooms': [_room('r1', 'R1 edited by B')]}}, version=v1)
    assert stale.status_code == 409
    assert Room.objects.filter(room_id='r2').exists()          # not clobbered
    assert Room.objects.get(room_id='r1').label == 'R1'        # B's edit was rejected, not applied


def test_annotations_different_floor_saves_do_not_conflict(client, editor_user):
    # The CONC-1 headline: two editors on DIFFERENT floors never collide. Both load the same
    # two-floor doc (so both hold floor-2's token); editor A saves floor-1 (advancing only floor-1),
    # then editor B saves floor-2 with the token it still holds — this must SUCCEED (not 409), and
    # both floors' rooms must stand. Under the old whole-document token B's save would have 409'd.
    client.force_login(editor_user)
    base = _post_json(client, ANNOTATIONS,
                      {FLOOR: {'rooms': [_room('r1', 'F1')]}, FLOOR2: {'rooms': [_room('r2', 'F2')]}},
                      version=json.dumps({FLOOR: '', FLOOR2: ''}))
    tokens = _versions(base)   # {floor-1: t1, floor-2: t2} — both editors loaded this

    # Editor A edits floor-1 only, advancing floor-1's token; floor-2's token is untouched.
    _post_json(client, ANNOTATIONS, {FLOOR: {'rooms': [_room('r1', 'F1 edited')]}},
               version=json.dumps({FLOOR: tokens[FLOOR]}))

    # Editor B, still holding the original floor-2 token, saves floor-2 — no conflict.
    b = _post_json(client, ANNOTATIONS, {FLOOR2: {'rooms': [_room('r2', 'F2 edited by B')]}},
                   version=json.dumps({FLOOR2: tokens[FLOOR2]}))
    assert b.status_code == 200
    assert Room.objects.get(room_id='r1').label == 'F1 edited'       # A's floor-1 edit stands
    assert Room.objects.get(room_id='r2').label == 'F2 edited by B'  # B's floor-2 edit stands


def test_annotations_per_floor_save_spares_other_floors_rooms(client, editor_user):
    # A per-floor save carries only the floors it touched, so a floor's ABSENCE from the POST means
    # "not edited", never "delete its rooms" (sweep_absent=False). Saving floor-1 alone must leave
    # floor-2's rooms intact.
    client.force_login(editor_user)
    _post_json(client, ANNOTATIONS,
               {FLOOR: {'rooms': [_room('r1')]}, FLOOR2: {'rooms': [_room('r2')]}},
               version=json.dumps({FLOOR: '', FLOOR2: ''}))
    tok = _versions(client.get(reverse(ANNOTATIONS)))

    _post_json(client, ANNOTATIONS, {FLOOR: {'rooms': [_room('r1'), _room('r1b')]}},
               version=json.dumps({FLOOR: tok[FLOOR]}))
    assert Room.objects.filter(room_id='r2').exists()   # floor-2 untouched by a floor-1-only save


def test_annotations_emptied_floor_deletes_its_row_and_rooms(client, editor_user):
    # A floor emptied of rooms/arrows/notes is sent as `{}` and deleted — its blob row and its rooms
    # go, the whole-document prune moved server-side.
    client.force_login(editor_user)
    v = _post_json(client, ANNOTATIONS, {FLOOR: {'rooms': [_room('r1')]}},
                   version=json.dumps({FLOOR: ''}))
    assert FacilityMapBlob.objects.filter(kind='annotations', key=FLOOR).exists()

    _post_json(client, ANNOTATIONS, {FLOOR: {}}, version=json.dumps(_versions(v)))
    assert not FacilityMapBlob.objects.filter(kind='annotations', key=FLOOR).exists()
    assert not Room.objects.filter(room_id='r1').exists()


def test_placements_different_floor_saves_do_not_conflict(client, editor_user):
    # The same non-conflict guarantee on a plain sharded kind (placements): A saves floor-1's
    # placements, B saves floor-2's with the token it still holds — no 409, both stored in their own
    # rows.
    client.force_login(editor_user)
    base = _post_json(client, PLACEMENTS,
                      {FLOOR: {'placements': [{'room': 'r1'}]}, FLOOR2: {'placements': [{'room': 'r2'}]}},
                      version=json.dumps({FLOOR: '', FLOOR2: ''}))
    tokens = _versions(base)

    _post_json(client, PLACEMENTS, {FLOOR: {'placements': [{'room': 'r1', 'id': 9}]}},
               version=json.dumps({FLOOR: tokens[FLOOR]}))
    b = _post_json(client, PLACEMENTS, {FLOOR2: {'placements': [{'room': 'r2', 'id': 8}]}},
                   version=json.dumps({FLOOR2: tokens[FLOOR2]}))
    assert b.status_code == 200
    assert FacilityMapBlob.objects.get(kind='placements', key=FLOOR).data['placements'][0]['id'] == 9
    assert FacilityMapBlob.objects.get(kind='placements', key=FLOOR2).data['placements'][0]['id'] == 8


# --- Query-cost regression for the composed annotations GET, the map's hottest read: it is issued
# on every page load and composes every floor's rooms, so an N+1 there scales with the whole
# facility. The count must stay flat as the room count grows. Mirrors the same guard on the
# floor-rooms panel in `test_template_content.py` (PERF-2).

def test_annotations_get_query_count_is_flat_across_room_count(client, editor_user):
    from django.db import connection
    from django.test.utils import CaptureQueriesContext
    from dcim.models import Location

    site, floor = _floor_location()

    def _set_room_count(n):
        Room.objects.all().delete()
        Location.objects.filter(parent=floor).delete()
        for i in range(n):
            room_loc = Location.objects.create(name=f'Room {i}', slug=f'room-{i}',
                                               site=site, parent=floor)
            Room.objects.create(floor_key=FLOOR, room_id=f'r{i}', label=f'R{i}',
                                floor_location=floor, location=room_loc,
                                polygon=[[0, 0], [1, 0], [1, 1]])

    def _measure():
        # A *fresh* login each time: NetBox caches the resolved object-permission set on the user
        # instance, so a reused session would make the second measurement artificially cheap.
        client.logout()
        client.force_login(type(editor_user).objects.get(pk=editor_user.pk))
        with CaptureQueriesContext(connection) as ctx:
            r = client.get(reverse(ANNOTATIONS))
            assert r.status_code == 200
        return len(ctx.captured_queries)

    _set_room_count(1)
    one_room = _measure()
    _set_room_count(5)
    assert _measure() == one_room


def test_placements_emptied_floor_deletes_its_row(client, editor_user):
    # An emptied placements floor (`{'placements': []}`) deletes its row (_SHARD_EMPTY).
    client.force_login(editor_user)
    v = _post_json(client, PLACEMENTS, {FLOOR: {'placements': [{'room': 'r1'}]}},
                   version=json.dumps({FLOOR: ''}))
    assert FacilityMapBlob.objects.filter(kind='placements', key=FLOOR).exists()
    _post_json(client, PLACEMENTS, {FLOOR: {'placements': []}}, version=json.dumps(_versions(v)))
    assert not FacilityMapBlob.objects.filter(kind='placements', key=FLOOR).exists()


def test_sharded_get_composes_every_floor_row(client, editor_user):
    # A sharded GET reads all per-floor rows back into the whole-document shape the frontend expects.
    client.force_login(editor_user)
    _post_json(client, PLACEMENTS,
               {FLOOR: {'placements': [{'room': 'r1'}]}, FLOOR2: {'placements': [{'room': 'r2'}]}},
               version=json.dumps({FLOOR: '', FLOOR2: ''}))
    doc = client.get(reverse(PLACEMENTS)).json()
    assert set(doc) == {FLOOR, FLOOR2}
    assert doc[FLOOR]['placements'] == [{'room': 'r1'}]


def test_placements_get_enriches_netbox_urls(client, superuser):
    # The sharded placements GET surfaces each rack/device placement's NetBox detail URL (NAV-16), so
    # the search widget's NetBox-target mode can open the object's own page without reconstructing a
    # /dcim/... path in JS. A placement whose object doesn't exist gets no url (finder falls to map).
    from dcim.models import Device, DeviceRole, DeviceType, Manufacturer, Rack, Site
    site = Site.objects.create(name='PS', slug='ps-site')
    rack = Rack.objects.create(name='RK', site=site, status='active')
    mfr = Manufacturer.objects.create(name='M', slug='m-ps')
    dtype = DeviceType.objects.create(manufacturer=mfr, model='DT', slug='dt-ps')
    role = DeviceRole.objects.create(name='Role', slug='role-ps')
    device = Device.objects.create(name='DV', device_type=dtype, role=role, site=site, status='active')
    client.force_login(superuser)

    _post_json(client, PLACEMENTS, {FLOOR: {'placements': [
        {'room': 'r1', 'kind': 'rack', 'id': rack.pk},
        {'room': 'r1', 'kind': 'device', 'id': device.pk},
        {'room': 'r1', 'kind': 'rack', 'id': 999999},   # no such object → no url
    ]}}, version=json.dumps({FLOOR: ''}))

    # Key by (kind, id): Rack and Device are separate tables, so their pks can collide (both 5 here).
    placements = client.get(reverse(PLACEMENTS)).json()[FLOOR]['placements']
    by_key = {(p['kind'], p['id']): p for p in placements}
    assert by_key[('rack', rack.pk)]['url'].endswith(rack.get_absolute_url())
    assert by_key[('device', device.pk)]['url'].endswith(device.get_absolute_url())
    assert 'url' not in by_key[('rack', 999999)]


def test_annotations_missing_header_still_saves(client, editor_user):
    # Opt-in: a caller that sends no version header bypasses the check (backward compatibility
    # for non-versioned callers) rather than being rejected.
    client.force_login(editor_user)
    r = _post_json(client, ANNOTATIONS, {FLOOR: {'rooms': [_room('r1')]}})
    assert r.status_code == 200
    assert Room.objects.filter(room_id='r1').exists()


def test_annotations_write_rejects_a_non_object_body(client, editor_user):
    # A syntactically valid JSON body that isn't an object (BUG-1) is a 400, not a 500 — the view
    # immediately calls `.get(...)` on the decoded payload.
    client.force_login(editor_user)
    assert _post_json(client, ANNOTATIONS, ['not', 'an', 'object']).status_code == 400


def test_blob_stale_token_conflicts_and_leaves_data(client, editor_user):
    # The single-row (non-sharded) guard: siteplan is one facility-wide document, so its token stays
    # a scalar and a stale token is a 409 leaving the stored document untouched. (The sharded kinds'
    # per-floor conflict behaviour is covered by the annotations/placements tests above.)
    client.force_login(editor_user)
    assert client.get(reverse(SITEPLAN)).headers[VERSION_HEADER] == ''
    v1 = _post_json(client, SITEPLAN,
                    {'hotspots': [{'id': 'h1'}]}, version='').headers[VERSION_HEADER]
    assert v1 != ''

    stale = _post_json(client, SITEPLAN, {'hotspots': [{'id': 'h2'}]}, version='')
    assert stale.status_code == 409
    row = FacilityMapBlob.objects.get(kind='siteplan', key='')
    assert row.data == {'hotspots': [{'id': 'h1'}]}           # the stale write did not land


# --- Audit trail (AUDIT-1): blob writes carry NetBox's ChangeLoggingMixin, so each POST records
# an ObjectChange (who/when + whole-document before/after) in the global Change Log. The write
# views snapshot the row before overwriting, so a data-unchanged write is suppressed as a no-op. --


def _blob_changes():
    from core.models import ObjectChange
    return ObjectChange.objects.filter(changed_object_type__model='facilitymapblob')


def test_blob_write_records_audit_entry(client, editor_user):
    # A first siteplan POST creates the row and logs a `create` ObjectChange attributed to the
    # saving user, with the whole document in postchange_data. The redundant `updated` timestamp
    # is kept out of the snapshot by the model's serialize_object override.
    from core.choices import ObjectChangeActionChoices
    client.force_login(editor_user)
    _post_json(client, SITEPLAN, {'hotspots': [{'id': 'h1'}]}, version='')

    oc = _blob_changes().get()
    assert oc.action == ObjectChangeActionChoices.ACTION_CREATE
    assert oc.user_id == editor_user.pk
    assert oc.postchange_data['data'] == {'hotspots': [{'id': 'h1'}]}
    assert 'updated' not in oc.postchange_data


def test_blob_update_records_before_and_after(client, editor_user):
    # The point of snapshotting: an update entry carries both the pre- and post-change document,
    # so "what did this edit change" is answerable from the Change Log.
    from core.choices import ObjectChangeActionChoices
    client.force_login(editor_user)
    v1 = _post_json(client, SITEPLAN,
                    {'hotspots': [{'id': 'h1'}]}, version='').headers[VERSION_HEADER]
    _post_json(client, SITEPLAN, {'hotspots': [{'id': 'h2'}]}, version=v1)

    upd = _blob_changes().get(action=ObjectChangeActionChoices.ACTION_UPDATE)
    assert upd.prechange_data['data'] == {'hotspots': [{'id': 'h1'}]}
    assert upd.postchange_data['data'] == {'hotspots': [{'id': 'h2'}]}


def test_rooms_only_annotations_edit_logs_no_blob_change(client, editor_user):
    # The headline no-op case: an annotations POST whose only change is room geometry (which lives
    # in the `Room` table, logged separately) leaves the annotations blob's own data unchanged. The
    # snapshot makes that a no-op, so NetBox suppresses it — no spurious "annotations updated" entry
    # per room drag. Only the initial create (from the first save) remains.
    client.force_login(editor_user)
    v1 = _post_json(client, ANNOTATIONS,
                    {FLOOR: {'rooms': [_room('r1', 'R1')]}}, version='').headers[VERSION_HEADER]
    assert _blob_changes().count() == 1                        # the create from the first save

    _post_json(client, ANNOTATIONS,
               {FLOOR: {'rooms': [_room('r1', 'R1'), _room('r2', 'R2')]}}, version=v1)
    assert Room.objects.filter(room_id='r2').exists()          # the room write did happen
    assert _blob_changes().count() == 1                        # no-op blob update was suppressed


# --- Multi-facility (MULTI-2): blobs and room deletes are scoped to a facility, resolved from a
# floor's site → its SiteGroup slug. The headline is that a facility-B POST can never delete
# facility-A's rooms (Room has no facility column, so the cross-floor delete is site-scoped). ------

FACILITIES = 'plugins:netbox_facilitymap:api-nb-facilities'
FLOOR_LABEL = 'plugins:netbox_facilitymap:api-settings-floor-label-field'
DEFAULT_FACILITY = 'plugins:netbox_facilitymap:api-settings-default-facility'
WRITE_MODE = 'plugins:netbox_facilitymap:api-settings-write-mode'
INLINE_ROOM_CREATION = 'plugins:netbox_facilitymap:api-settings-inline-room-creation'
ORG_MODE = 'plugins:netbox_facilitymap:api-settings-org-mode'


def _import_manifest(workdir, slug):
    """Give facility `slug` a rendered manifest in its working dir, so it counts as having
    imported content (`imported_facility_slugs`). `''` writes the root manifest."""
    base = workdir / slug if slug else workdir
    base.mkdir(parents=True, exist_ok=True)
    (base / 'manifest.json').write_text('{"siteplan": null, "buildings": []}')


def _grouped_site(group_slug, site_slug):
    """A Site under a SiteGroup (the default grouping), so it resolves to facility=`group_slug`."""
    from dcim.models import Site, SiteGroup
    group, _ = SiteGroup.objects.get_or_create(slug=group_slug, defaults={'name': group_slug})
    return Site.objects.create(name=site_slug, slug=site_slug, group=group)


def test_sync_rooms_never_deletes_another_facilitys_rooms(editor_user):
    # The core MULTI-2 invariant: two facilities, each a SiteGroup with a site + a floor. A POST
    # authoritative for facility A must not touch facility B's rooms, even though B's floor is
    # absent from the document.
    _grouped_site('ga', 'sa')
    _grouped_site('gb', 'sb')
    Room.objects.create(floor_key='sa/f1', room_id='ra_old', label='stale A room')
    Room.objects.create(floor_key='sb/f1', room_id='rb', label='B room')

    sync_rooms({'sa/f1': [_room('ra_new', 'A')]}, user=editor_user, facility='ga')

    assert Room.objects.filter(room_id='ra_new').exists()       # A upserted
    assert not Room.objects.filter(room_id='ra_old').exists()   # A's dropped floor cleaned up
    assert Room.objects.filter(room_id='rb').exists()           # B untouched — the invariant


def test_blob_endpoint_isolates_facilities(client, editor_user):
    # A write to facility A's siteplan and a write to facility B's are stored in separate rows and
    # read back independently.
    client.force_login(editor_user)
    url_a = reverse(SITEPLAN) + '?facility=ga'
    url_b = reverse(SITEPLAN) + '?facility=gb'
    client.post(url_a, data=json.dumps({'hotspots': [{'id': 'A'}]}),
                content_type='application/json', headers={VERSION_HEADER: ''})
    client.post(url_b, data=json.dumps({'hotspots': [{'id': 'B'}]}),
                content_type='application/json', headers={VERSION_HEADER: ''})

    assert client.get(url_a).json() == {'hotspots': [{'id': 'A'}]}
    assert client.get(url_b).json() == {'hotspots': [{'id': 'B'}]}
    assert FacilityMapBlob.objects.get(kind='siteplan', facility='ga').data == {'hotspots': [{'id': 'A'}]}
    assert FacilityMapBlob.objects.get(kind='siteplan', facility='gb').data == {'hotspots': [{'id': 'B'}]}
    # The default-facility row is never created by a facility-scoped write.
    assert not FacilityMapBlob.objects.filter(kind='siteplan', facility='').exists()


def test_blob_endpoint_rejects_bad_facility(client, editor_user):
    client.force_login(editor_user)
    assert client.get(reverse(SITEPLAN) + '?facility=../evil').status_code == 400


def test_blob_write_rejects_a_non_object_body(client, editor_user):
    # A syntactically valid JSON body that isn't an object (BUG-1) is a 400, not a 500.
    client.force_login(editor_user)
    assert _post_json(client, SITEPLAN, 'just a string').status_code == 400


def test_annotations_get_scoped_to_facility(client, editor_user):
    # A facility-A annotations GET surfaces only A's rooms, never B's (Room has no facility column,
    # so this is proven by the site-scoped compose, not a column filter).
    _grouped_site('ga', 'sa')
    _grouped_site('gb', 'sb')
    Room.objects.create(floor_key='sa/f1', room_id='ra', label='A', polygon=[[0, 0]])
    Room.objects.create(floor_key='sb/f1', room_id='rb', label='B', polygon=[[0, 0]])
    client.force_login(editor_user)

    doc = client.get(reverse(ANNOTATIONS) + '?facility=ga').json()
    room_ids = {r['id'] for floor in doc.values() for r in floor.get('rooms', [])}
    assert room_ids == {'ra'}


def test_facilities_endpoint_lists_groups_with_content_flag(client, superuser, workdir):
    # The picker feed: every SiteGroup the user may view, flagged whether it has an imported map
    # (a manifest in its working dir). Superuser sees all groups.
    _grouped_site('ga', 'sa')
    _grouped_site('gb', 'sb')
    (workdir / 'ga').mkdir()
    (workdir / 'ga' / 'manifest.json').write_text('{"siteplan": null, "buildings": []}')
    client.force_login(superuser)

    body = client.get(reverse(FACILITIES)).json()
    assert body['grouping'] == 'sitegroup'
    by_slug = {f['slug']: f for f in body['facilities']}
    assert by_slug['ga']['has_content'] is True
    assert by_slug['gb']['has_content'] is False
    # Content-having facilities sort first.
    assert body['facilities'][0]['slug'] == 'ga'


def test_set_grouping_persists_and_drives_read_path(client, editor_user):
    # MULTI-3: the wizard's grouping POST writes `facility_grouping` into the settings blob so the
    # install-wide read path (facilities.grouping / list_facilities) flips to Region.
    from netbox_facilitymap.facilities import grouping
    client.force_login(editor_user)

    r = client.post(reverse(FACILITIES), data=json.dumps({'grouping': 'region'}),
                    content_type='application/json')
    assert r.status_code == 200 and r.json() == {'ok': True, 'grouping': 'region'}
    assert grouping() == 'region'
    # Stored on the single default-facility settings row, never a facility-scoped one.
    assert FacilityMapBlob.objects.get(
        kind='settings', facility='', key='').data['facility_grouping'] == 'region'
    assert client.get(reverse(FACILITIES)).json()['grouping'] == 'region'


def test_set_grouping_preserves_room_embed_keys(client, editor_user):
    # The write merges onto the existing settings document — the room-embed controls survive.
    FacilityMapBlob.objects.create(kind='settings', facility='', key='',
                                   data={'room_embed_zoom': 3.0})
    client.force_login(editor_user)

    client.post(reverse(FACILITIES), data=json.dumps({'grouping': 'region'}),
                content_type='application/json')
    data = FacilityMapBlob.objects.get(kind='settings', facility='', key='').data
    assert data == {'room_embed_zoom': 3.0, 'facility_grouping': 'region'}


def test_set_grouping_rejects_unknown_value(client, editor_user):
    client.force_login(editor_user)
    r = client.post(reverse(FACILITIES), data=json.dumps({'grouping': 'campus'}),
                    content_type='application/json')
    assert r.status_code == 400
    assert not FacilityMapBlob.objects.filter(kind='settings').exists()


def test_set_grouping_rejects_a_non_object_body(client, editor_user):
    # A syntactically valid JSON body that isn't an object (BUG-1) is a 400, not a 500.
    client.force_login(editor_user)
    r = client.post(reverse(FACILITIES), data=json.dumps([1, 2, 3]), content_type='application/json')
    assert r.status_code == 400


def test_set_grouping_requires_import_permission(client, plain_user):
    # `plain_user` holds change but not import — the everyday map-write gate must not unlock this
    # admin-tier config write.
    client.force_login(plain_user)
    r = client.post(reverse(FACILITIES), data=json.dumps({'grouping': 'region'}),
                    content_type='application/json')
    assert r.status_code == 403
    assert not FacilityMapBlob.objects.filter(kind='settings').exists()


def test_set_grouping_change_blocked_without_confirm_when_populated(client, editor_user):
    # HEALTH-1: a grouping *change* on an install that already holds map data would re-scope Sites
    # and orphan the existing blobs — refused without an explicit confirm, and nothing is persisted.
    from netbox_facilitymap.facilities import grouping
    FacilityMapBlob.objects.create(kind='annotations', facility='', key='', data={'sa/f1': {}})
    client.force_login(editor_user)

    r = client.post(reverse(FACILITIES), data=json.dumps({'grouping': 'region'}),
                    content_type='application/json')
    assert r.status_code == 409
    assert r.json()['error'] == 'confirm_required'
    assert grouping() == 'sitegroup'   # unchanged — no settings row written


def test_set_grouping_change_allowed_with_confirm(client, editor_user):
    from netbox_facilitymap.facilities import grouping
    FacilityMapBlob.objects.create(kind='annotations', facility='', key='', data={'sa/f1': {}})
    client.force_login(editor_user)

    r = client.post(reverse(FACILITIES), data=json.dumps({'grouping': 'region', 'confirm': True}),
                    content_type='application/json')
    assert r.status_code == 200
    assert grouping() == 'region'


def test_set_grouping_noop_allowed_when_populated(client, editor_user):
    # Re-saving the SAME grouping isn't a change, so no confirm is needed even with data present.
    FacilityMapBlob.objects.create(kind='annotations', facility='', key='', data={'sa/f1': {}})
    client.force_login(editor_user)

    r = client.post(reverse(FACILITIES), data=json.dumps({'grouping': 'sitegroup'}),
                    content_type='application/json')
    assert r.status_code == 200


# --- the Site→facility assignment endpoint (FACILITY-IDENTITY Phase 1): the write surface the
# Phase-2 wizard assignment step lands on — GET is login-only like the facilities GET beside it,
# POST is IMPORT_PERM-gated admin config, validation lives in `facilities.assign_facilities`. ------

ASSIGNMENTS = 'plugins:netbox_facilitymap:api-nb-facility-assignments'


def test_assignments_round_trip(client, editor_user):
    from dcim.models import Site
    from netbox_facilitymap.facilities import facility_for_site
    site = Site.objects.create(name='SA', slug='sa')
    client.force_login(editor_user)

    r = client.post(reverse(ASSIGNMENTS),
                    data=json.dumps({'assignments': {'sa': 'campus-x'}}),
                    content_type='application/json')
    assert r.status_code == 200
    assert r.json() == {'ok': True, 'assignments': {'sa': 'campus-x'}}
    assert facility_for_site(site) == 'campus-x'
    assert client.get(reverse(ASSIGNMENTS)).json() == {'assignments': {'sa': 'campus-x'}}
    # Stored on the single install-wide facility_map row.
    assert FacilityMapBlob.objects.get(
        kind='facility_map', facility='', key='').data == {'sa': 'campus-x'}

    # null reverts the Site to the grouping derivation.
    r = client.post(reverse(ASSIGNMENTS),
                    data=json.dumps({'assignments': {'sa': None}}),
                    content_type='application/json')
    assert r.status_code == 200
    assert facility_for_site(site) == ''


def test_assignments_post_rejects_invalid_payloads(client, editor_user):
    from dcim.models import Site
    Site.objects.create(name='SA', slug='sa')
    client.force_login(editor_user)
    for body in ({'assignments': {'sa': '../escape'}},   # traversal — the valid_facility gate
                 {'assignments': {'ghost': 'x'}},        # unknown Site slug
                 {'assignments': {}},                    # empty merge
                 {}):                                    # missing key
        r = client.post(reverse(ASSIGNMENTS), data=json.dumps(body),
                        content_type='application/json')
        assert r.status_code == 400
    assert not FacilityMapBlob.objects.filter(kind='facility_map').exists()


def test_assignments_post_requires_import_permission(client, plain_user):
    # `plain_user` holds change but not import — same admin-tier gate as the grouping POST.
    client.force_login(plain_user)
    r = client.post(reverse(ASSIGNMENTS), data=json.dumps({'assignments': {'sa': 'x'}}),
                    content_type='application/json')
    assert r.status_code == 403
    assert not FacilityMapBlob.objects.filter(kind='facility_map').exists()


# --- the Phase-3 reassignment modal's two endpoints (MULTI-7): the read-only preview that replaced
# the wizard's blanket `window.confirm`, and the inline re-key that recovers whatever a grouping
# change strands. Both IMPORT_PERM — the preview fronts an admin-tier action, so it shares its
# audience rather than the login-only facilities/assignments GETs. -------------------------------

PREVIEW = 'plugins:netbox_facilitymap:api-nb-facility-grouping-preview'
REASSIGN = 'plugins:netbox_facilitymap:api-nb-facility-reassign'


def test_grouping_preview_reports_moves_and_orphans(client, editor_user):
    from dcim.models import Region, Site, SiteGroup
    from netbox_facilitymap.facilities import facility_for_site
    site = Site.objects.create(name='SA', slug='sa',
                               group=SiteGroup.objects.create(name='ga', slug='ga'),
                               region=Region.objects.create(name='rn', slug='rn'))
    FacilityMapBlob.objects.create(kind='annotations', facility='ga', key='sa/f1', data={})
    Room.objects.create(floor_key='sa/f1', room_id='r1')
    client.force_login(editor_user)

    body = client.get(reverse(PREVIEW) + '?grouping=region').json()
    assert body['grouping'] == {'from': 'sitegroup', 'to': 'region'}
    assert [(m['site'], m['from'], m['to'], m['rooms']) for m in body['moves']] \
        == [('sa', 'ga', 'rn', 1)]
    assert [o['facility'] for o in body['orphans']] == ['ga']
    assert {c['slug'] for c in body['choices']} == {'rn'}
    # Read-only: previewing never writes the grouping it previews.
    assert not FacilityMapBlob.objects.filter(kind='settings').exists()
    assert facility_for_site(site) == 'ga'


def test_grouping_preview_rejects_an_unknown_grouping(client, editor_user):
    client.force_login(editor_user)
    assert client.get(reverse(PREVIEW) + '?grouping=campus').status_code == 400
    assert client.get(reverse(PREVIEW)).status_code == 400


def test_grouping_preview_requires_import_permission(client, plain_user):
    client.force_login(plain_user)
    assert client.get(reverse(PREVIEW) + '?grouping=region').status_code == 403


def test_reassign_endpoint_rekeys_stranded_data(client, editor_user, workdir):
    # The inline recovery the modal offers, through the same one write path the Settings panel uses.
    _grouped_site('gb', 'sb')
    FacilityMapBlob.objects.create(kind='annotations', facility='gone', key='sb/f1', data={})
    client.force_login(editor_user)

    r = client.post(reverse(REASSIGN), data=json.dumps({'old': 'gone', 'new': 'gb'}),
                    content_type='application/json')
    assert r.status_code == 200 and r.json() == {'ok': True, 'kinds': ['annotations']}
    assert FacilityMapBlob.objects.get(kind='annotations', key='sb/f1').facility == 'gb'


def test_reassign_endpoint_surfaces_validation_failures(client, editor_user, workdir):
    # An unreachable target and a source holding nothing are both 400s carrying the server's own
    # message, so the modal can show it on the failing row and leave the others usable.
    _grouped_site('gb', 'sb')
    FacilityMapBlob.objects.create(kind='annotations', facility='gone', key='sb/f1', data={})
    client.force_login(editor_user)
    for body in ({'old': 'gone', 'new': 'nowhere'},   # target not reachable
                 {'old': 'empty', 'new': 'gb'},       # nothing stored under the source
                 {'old': 'gb', 'new': 'gb'}):         # same source and target
        r = client.post(reverse(REASSIGN), data=json.dumps(body),
                        content_type='application/json')
        assert r.status_code == 400
    assert FacilityMapBlob.objects.get(kind='annotations', key='sb/f1').facility == 'gone'


def test_reassign_endpoint_requires_import_permission(client, plain_user):
    client.force_login(plain_user)
    r = client.post(reverse(REASSIGN), data=json.dumps({'old': 'a', 'new': 'b'}),
                    content_type='application/json')
    assert r.status_code == 403


# --- floor_label_field setting (SET-1): moved off the NetBox-chrome'd SettingsView onto the in-app
# #/settings page, persisted here into the same install-wide settings blob. Mirrors the grouping
# endpoint's contract (merge, IMPORT_PERM gate, AUDIT-1 snapshot). ------------------------------


def test_floor_label_field_persists_to_settings_blob(client, editor_user):
    # A POST writes floor_label_field onto the single default-facility settings row (MULTI-1).
    client.force_login(editor_user)
    r = client.post(reverse(FLOOR_LABEL), data=json.dumps({'floor_label_field': 'slug'}),
                    content_type='application/json')
    assert r.status_code == 200 and r.json() == {'ok': True, 'floor_label_field': 'slug'}
    assert FacilityMapBlob.objects.get(
        kind='settings', facility='', key='').data['floor_label_field'] == 'slug'


def test_floor_label_field_preserves_other_settings_keys(client, editor_user):
    # The write merges onto the existing settings document — the room-embed / grouping keys survive.
    FacilityMapBlob.objects.create(kind='settings', facility='', key='',
                                   data={'room_embed_zoom': 3.0, 'facility_grouping': 'region'})
    client.force_login(editor_user)

    client.post(reverse(FLOOR_LABEL), data=json.dumps({'floor_label_field': 'description'}),
                content_type='application/json')
    data = FacilityMapBlob.objects.get(kind='settings', facility='', key='').data
    assert data == {'room_embed_zoom': 3.0, 'facility_grouping': 'region',
                    'floor_label_field': 'description'}


def test_floor_label_field_clamps_unknown_value(client, editor_user):
    # Enum-safe: a value outside the allowlist clamps to the default rather than being stored raw.
    client.force_login(editor_user)
    r = client.post(reverse(FLOOR_LABEL), data=json.dumps({'floor_label_field': 'bogus'}),
                    content_type='application/json')
    assert r.status_code == 200 and r.json()['floor_label_field'] == 'name'
    assert FacilityMapBlob.objects.get(
        kind='settings', facility='', key='').data['floor_label_field'] == 'name'


def test_floor_label_field_rejects_a_non_object_body(client, editor_user):
    # A syntactically valid JSON body that isn't an object (BUG-1) is a 400, not a 500.
    client.force_login(editor_user)
    r = client.post(reverse(FLOOR_LABEL), data=json.dumps(5), content_type='application/json')
    assert r.status_code == 400


def test_floor_label_field_requires_import_permission(client, plain_user):
    # `plain_user` holds change but not import — the everyday map-write gate must not unlock this
    # admin-tier config write (PERM-1).
    client.force_login(plain_user)
    r = client.post(reverse(FLOOR_LABEL), data=json.dumps({'floor_label_field': 'slug'}),
                    content_type='application/json')
    assert r.status_code == 403
    assert not FacilityMapBlob.objects.filter(kind='settings').exists()


def test_floor_label_field_records_audit_entry(client, editor_user):
    # AUDIT-1: the endpoint goes through the shared snapshot-before-overwrite upsert, so a second
    # save logs one ObjectChange carrying the before/after value.
    from core.choices import ObjectChangeActionChoices
    from core.models import ObjectChange
    client.force_login(editor_user)

    client.post(reverse(FLOOR_LABEL), data=json.dumps({'floor_label_field': 'name'}),
                content_type='application/json')
    client.post(reverse(FLOOR_LABEL), data=json.dumps({'floor_label_field': 'slug'}),
                content_type='application/json')

    changes = ObjectChange.objects.filter(changed_object_type__model='facilitymapblob')
    upd = changes.get(action=ObjectChangeActionChoices.ACTION_UPDATE)
    assert upd.user_id == editor_user.pk
    assert upd.prechange_data['data']['floor_label_field'] == 'name'
    assert upd.postchange_data['data']['floor_label_field'] == 'slug'


# --- default_facility setting (SET-2): pin which facility the SPA boots into when the URL hash names
# none. Persisted into the same install-wide settings blob; a submitted slug is clamped to a
# reachable, content-having facility (or '') so a stale/empty pin never boots into a dead map. -----


def test_default_facility_persists_when_reachable_and_imported(client, editor_user, workdir):
    # A pinned facility that both resolves under the live grouping (a SiteGroup with a site) and has
    # a rendered manifest is stored on the single default-facility settings row (MULTI-1).
    _grouped_site('ga', 'sa')
    _import_manifest(workdir, 'ga')
    client.force_login(editor_user)
    r = client.post(reverse(DEFAULT_FACILITY), data=json.dumps({'default_facility': 'ga'}),
                    content_type='application/json')
    assert r.status_code == 200 and r.json() == {'ok': True, 'default_facility': 'ga'}
    assert FacilityMapBlob.objects.get(
        kind='settings', facility='', key='').data['default_facility'] == 'ga'


def test_default_facility_preserves_other_settings_keys(client, editor_user, workdir):
    # The write merges onto the existing settings document — the floor-label / room-embed keys survive.
    _grouped_site('ga', 'sa')
    _import_manifest(workdir, 'ga')
    FacilityMapBlob.objects.create(kind='settings', facility='', key='',
                                   data={'room_embed_zoom': 3.0, 'floor_label_field': 'slug'})
    client.force_login(editor_user)

    client.post(reverse(DEFAULT_FACILITY), data=json.dumps({'default_facility': 'ga'}),
                content_type='application/json')
    data = FacilityMapBlob.objects.get(kind='settings', facility='', key='').data
    assert data == {'room_embed_zoom': 3.0, 'floor_label_field': 'slug', 'default_facility': 'ga'}


def test_default_facility_clamps_reachable_but_empty_facility(client, editor_user, workdir):
    # A facility that resolves under the grouping but has NO imported map can't be a useful boot
    # default (it would just re-open the wizard) — the content gate coerces it to '' rather than 400.
    _grouped_site('ga', 'sa')   # reachable, but no manifest written
    client.force_login(editor_user)
    r = client.post(reverse(DEFAULT_FACILITY), data=json.dumps({'default_facility': 'ga'}),
                    content_type='application/json')
    assert r.status_code == 200 and r.json()['default_facility'] == ''
    assert FacilityMapBlob.objects.get(
        kind='settings', facility='', key='').data['default_facility'] == ''


def test_default_facility_clamps_unknown_slug(client, editor_user, workdir):
    # A slug no Site resolves to (not reachable) clamps to '' too.
    client.force_login(editor_user)
    r = client.post(reverse(DEFAULT_FACILITY), data=json.dumps({'default_facility': 'ghost'}),
                    content_type='application/json')
    assert r.status_code == 200 and r.json()['default_facility'] == ''


def test_default_facility_rejects_a_non_object_body(client, editor_user):
    # A syntactically valid JSON body that isn't an object (BUG-1) is a 400, not a 500.
    client.force_login(editor_user)
    r = client.post(reverse(DEFAULT_FACILITY), data=json.dumps(['nope']),
                    content_type='application/json')
    assert r.status_code == 400


def test_default_facility_requires_import_permission(client, plain_user):
    # `plain_user` holds change but not import — the everyday map-write gate must not unlock this
    # admin-tier config write (PERM-1).
    client.force_login(plain_user)
    r = client.post(reverse(DEFAULT_FACILITY), data=json.dumps({'default_facility': 'ga'}),
                    content_type='application/json')
    assert r.status_code == 403
    assert not FacilityMapBlob.objects.filter(kind='settings').exists()


def test_default_facility_reader_degrades_stale_pin(workdir):
    # The read path (facilities.default_facility, injected into window.MAP by MapView): a stored pin
    # is honoured only while it stays reachable + content-having, else it degrades to '' (HEALTH-1) so
    # a grouping change or a wiped import never boots into a dead facility.
    from netbox_facilitymap import facilities
    _grouped_site('ga', 'sa')
    _import_manifest(workdir, 'ga')
    FacilityMapBlob.objects.create(kind='settings', facility='', key='',
                                   data={'default_facility': 'ga'})
    assert facilities.default_facility() == 'ga'

    # Drop the rendered manifest → the pin no longer has content → the reader falls back to ''.
    (workdir / 'ga' / 'manifest.json').unlink()
    assert facilities.default_facility() == ''


# --- write_mode setting (LOC-2): the runtime, admin-controlled replacement for the redeploy-time
# `allow_location_create` capability flag. Persisted into the same install-wide settings blob;
# read back by MapView (window.MAP.writeMode) and enforced by NbLocationCreateView. --------------


def test_write_mode_persists_to_settings_blob(client, editor_user):
    # A POST writes the write_mode boolean onto the single default-facility settings row (MULTI-1).
    client.force_login(editor_user)
    r = client.post(reverse(WRITE_MODE), data=json.dumps({'write_mode': True}),
                    content_type='application/json')
    assert r.status_code == 200 and r.json() == {'ok': True, 'write_mode': True}
    assert FacilityMapBlob.objects.get(
        kind='settings', facility='', key='').data['write_mode'] is True


def test_write_mode_toggle_off_persists_false(client, editor_user):
    # Disabling is a plain POST of False — no confirm on the server side (the consent gate is UX).
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={'write_mode': True})
    client.force_login(editor_user)
    r = client.post(reverse(WRITE_MODE), data=json.dumps({'write_mode': False}),
                    content_type='application/json')
    assert r.status_code == 200 and r.json()['write_mode'] is False
    assert FacilityMapBlob.objects.get(
        kind='settings', facility='', key='').data['write_mode'] is False


def test_write_mode_rejects_a_non_object_body(client, editor_user):
    # A syntactically valid JSON body that isn't an object (BUG-1) is a 400, not a 500.
    client.force_login(editor_user)
    r = client.post(reverse(WRITE_MODE), data=json.dumps('nope'), content_type='application/json')
    assert r.status_code == 400


def test_write_mode_preserves_other_settings_keys(client, editor_user):
    # The write merges onto the existing settings document — sibling keys survive.
    FacilityMapBlob.objects.create(kind='settings', facility='', key='',
                                   data={'room_embed_zoom': 3.0, 'floor_label_field': 'slug'})
    client.force_login(editor_user)

    client.post(reverse(WRITE_MODE), data=json.dumps({'write_mode': True}),
                content_type='application/json')
    data = FacilityMapBlob.objects.get(kind='settings', facility='', key='').data
    assert data == {'room_embed_zoom': 3.0, 'floor_label_field': 'slug', 'write_mode': True}


def test_write_mode_requires_import_permission(client, plain_user):
    # `plain_user` holds change but not import — the everyday map-write gate must not unlock this
    # admin-tier config write (PERM-1). Flipping write mode is IMPORT_PERM, like the settings beside it.
    client.force_login(plain_user)
    r = client.post(reverse(WRITE_MODE), data=json.dumps({'write_mode': True}),
                    content_type='application/json')
    assert r.status_code == 403
    assert not FacilityMapBlob.objects.filter(kind='settings').exists()


def test_write_mode_enabled_resolver_reads_blob(db):
    # previews.write_mode_enabled is the shared server-side gate (MapView context + create endpoint).
    from netbox_facilitymap.previews import write_mode_enabled
    assert write_mode_enabled() is False   # no settings row → off
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={'write_mode': True})
    assert write_mode_enabled() is True


# --- inline_room_creation setting (SET-5): the write add-on switch split out of write mode, which
# is now a pure master gate. Same blob, same IMPORT_PERM tier as its siblings — but it DEFAULTS ON
# when absent, so an install predating the split keeps the create tile write mode used to imply. ---


def test_inline_room_creation_persists_to_settings_blob(client, editor_user):
    # A POST writes the boolean onto the single default-facility settings row (MULTI-1).
    client.force_login(editor_user)
    r = client.post(reverse(INLINE_ROOM_CREATION), data=json.dumps({'inline_room_creation': False}),
                    content_type='application/json')
    assert r.status_code == 200 and r.json() == {'ok': True, 'inline_room_creation': False}
    assert FacilityMapBlob.objects.get(
        kind='settings', facility='', key='').data['inline_room_creation'] is False


def test_inline_room_creation_preserves_other_settings_keys(client, editor_user):
    # The write merges onto the existing settings document — sibling keys survive. Write mode in
    # particular: the two are separate switches now, so saving one must never disturb the other.
    FacilityMapBlob.objects.create(kind='settings', facility='', key='',
                                   data={'write_mode': True, 'ap_tool': True})
    client.force_login(editor_user)

    client.post(reverse(INLINE_ROOM_CREATION), data=json.dumps({'inline_room_creation': False}),
                content_type='application/json')
    data = FacilityMapBlob.objects.get(kind='settings', facility='', key='').data
    assert data == {'write_mode': True, 'ap_tool': True, 'inline_room_creation': False}


def test_inline_room_creation_rejects_a_non_object_body(client, editor_user):
    # A syntactically valid JSON body that isn't an object (BUG-1) is a 400, not a 500.
    client.force_login(editor_user)
    r = client.post(reverse(INLINE_ROOM_CREATION), data=json.dumps('nope'),
                    content_type='application/json')
    assert r.status_code == 400


def test_inline_room_creation_requires_import_permission(client, plain_user):
    # `plain_user` holds change but not import — the everyday map-write gate must not unlock this
    # admin-tier config write (PERM-1), exactly as for write mode beside it.
    client.force_login(plain_user)
    r = client.post(reverse(INLINE_ROOM_CREATION), data=json.dumps({'inline_room_creation': False}),
                    content_type='application/json')
    assert r.status_code == 403
    assert not FacilityMapBlob.objects.filter(kind='settings').exists()


def test_inline_room_creation_enabled_defaults_on_when_unset(db):
    # The upgrade-safety default (SET-5): before the split, write-mode-on meant inline creation was
    # on. A missing row, or a row predating the key, must therefore read as ON — else an upgrader
    # with write mode on would silently lose the create tile. This exposes nothing new: write mode
    # is off by default and gates this.
    from netbox_facilitymap.previews import inline_room_creation_enabled
    assert inline_room_creation_enabled() is True                      # no settings row at all
    row = FacilityMapBlob.objects.create(kind='settings', facility='', key='',
                                         data={'write_mode': True})    # pre-SET-5 blob
    assert inline_room_creation_enabled() is True
    # Only an explicit stored False turns it off — "not configured" is never mistaken for "off".
    row.data = {'write_mode': True, 'inline_room_creation': False}
    row.save()
    assert inline_room_creation_enabled() is False
    row.data = {'write_mode': True, 'inline_room_creation': True}
    row.save()
    assert inline_room_creation_enabled() is True


def test_nb_locations_exposes_description(client, editor_user):
    # `_trim` gained `description` so the import wizard's floor-label picker can offer it as an
    # alternative to `name`/`slug` (see views._floor_label_field).
    from conftest import grant
    from dcim.models import Location

    site, floor = _floor_location()
    floor.description = 'Sub-basement Storage'
    floor.save()
    grant(editor_user, Location, ['view'])
    client.force_login(editor_user)

    r = client.get(reverse(LOCATIONS) + '?site=test-site')
    assert r.status_code == 200
    (loc,) = r.json()['rooms']
    assert loc['description'] == 'Sub-basement Storage'


# --- Inline Location creation (LOC-1/LOC-2): the plugin's one write into dcim core, gated on the
# off-by-default runtime `write_mode` master gate + the `inline_room_creation` add-on switch
# (SET-5) + the `dcim.add_location` permission. -------------------------------------------------

LOCATION_CREATE = 'plugins:netbox_facilitymap:api-nb-location-create'


def _set_setting(key, value):
    """Merge one key into the single install-wide settings blob, creating the row if needed. The
    runtime gates read it live, so writing the row is all a test needs — no restart, no endpoint."""
    row = FacilityMapBlob.objects.filter(kind='settings', facility='', key='').first()
    data = dict(row.data if row else {})
    data[key] = value
    if row is None:
        FacilityMapBlob.objects.create(kind='settings', facility='', key='', data=data)
    else:
        row.data = data
        row.save()


def _set_write_mode(enabled):
    """Set install-wide write mode — the master gate `previews.write_mode_enabled` reads, and so
    every write endpoint."""
    _set_setting('write_mode', enabled)


def _set_inline_room_creation(enabled):
    """Set the inline-room-creation add-on switch (SET-5) — the second gate, beyond write mode, that
    `NbLocationCreateView` checks. Only needed to turn it OFF: it defaults on when the key is absent."""
    _set_setting('inline_room_creation', enabled)


@pytest.fixture
def location_create_on(db):
    """Switch install-wide write mode on for a test (it defaults off). The create endpoint reads it
    live from the settings blob via `previews.write_mode_enabled`, so writing the row is enough.

    Write mode alone is enough to open the create path: the `inline_room_creation` add-on switch it
    also answers to (SET-5) defaults on when unset, so leaving that key absent is the ordinary
    "operator turned write mode on" state."""
    _set_write_mode(True)


def _location_creator(user):
    """Grant `user` the view+add Location object permissions the create endpoint requires (view to
    resolve the parent floor, add to create + pass the post-save restrict('add') check)."""
    from conftest import grant
    from dcim.models import Location
    grant(user, Location, ['view', 'add'])


def test_create_location_disabled_returns_403(client, editor_user):
    # Even with the perm, the write is refused when write mode is off (the default) — NetBox stays
    # the source of truth until an operator switches it on.
    _set_write_mode(False)
    site, floor = _floor_location()
    _location_creator(editor_user)
    client.force_login(editor_user)

    r = _post_json(client, LOCATION_CREATE, {'parent': floor.pk, 'name': 'Room 9'})
    assert r.status_code == 403
    from dcim.models import Location
    assert not Location.objects.filter(name='Room 9').exists()


def test_create_location_with_the_add_on_off_returns_403(client, editor_user, location_create_on):
    # Write mode on and the perm held, but the inline-room-creation add-on switched off (SET-5) →
    # refused. The two switches are independent: an operator can allow the map's other NetBox writes
    # while keeping Location creation in NetBox's hands.
    _set_inline_room_creation(False)
    site, floor = _floor_location()
    _location_creator(editor_user)
    client.force_login(editor_user)

    r = _post_json(client, LOCATION_CREATE, {'parent': floor.pk, 'name': 'Room 9'})
    assert r.status_code == 403
    from dcim.models import Location
    assert not Location.objects.filter(name='Room 9').exists()


def test_create_location_without_permission_returns_403(client, editor_user, location_create_on):
    # Flag on, but editor_user holds no dcim.add_location permission → the per-user gate refuses it.
    site, floor = _floor_location()
    client.force_login(editor_user)

    r = _post_json(client, LOCATION_CREATE, {'parent': floor.pk, 'name': 'Room 9'})
    assert r.status_code == 403
    from dcim.models import Location
    assert not Location.objects.filter(name='Room 9').exists()


def test_create_location_success(client, editor_user, location_create_on):
    from dcim.models import Location
    site, floor = _floor_location()
    _location_creator(editor_user)
    client.force_login(editor_user)

    r = _post_json(client, LOCATION_CREATE, {'parent': floor.pk, 'name': 'Room 9'})
    assert r.status_code == 201
    loc = Location.objects.get(name='Room 9')
    # Created as a child of the floor, under the floor's site, with a name-derived slug — so
    # NbRoomsView lists it and room→Location binding resolves (§7).
    assert loc.parent_id == floor.pk
    assert loc.site_id == site.pk
    assert loc.slug == 'room-9'
    body = r.json()
    assert body['id'] == loc.pk and body['slug'] == 'room-9' and body['parent'] == floor.pk


def test_create_location_duplicate_returns_400(client, editor_user, location_create_on):
    from dcim.models import Location
    site, floor = _floor_location()
    Location.objects.create(name='Room 9', slug='room-9', site=site, parent=floor)
    _location_creator(editor_user)
    client.force_login(editor_user)

    # A second Room 9 under the same floor collides on NetBox's uniqueness constraint → a clean 400
    # from full_clean(), not a 500.
    r = _post_json(client, LOCATION_CREATE, {'parent': floor.pk, 'name': 'Room 9'})
    assert r.status_code == 400
    assert Location.objects.filter(name='Room 9').count() == 1


def test_create_location_missing_parent_returns_400(client, editor_user, location_create_on):
    _floor_location()
    _location_creator(editor_user)
    client.force_login(editor_user)

    r = _post_json(client, LOCATION_CREATE, {'parent': 999999, 'name': 'Room 9'})
    assert r.status_code == 400


def test_create_location_blank_name_returns_400(client, editor_user, location_create_on):
    site, floor = _floor_location()
    _location_creator(editor_user)
    client.force_login(editor_user)

    r = _post_json(client, LOCATION_CREATE, {'parent': floor.pk, 'name': '   '})
    assert r.status_code == 400


def test_create_location_rejects_a_non_object_body(client, editor_user, location_create_on):
    # A syntactically valid JSON body that isn't an object (BUG-1) is a 400, not a 500.
    _location_creator(editor_user)
    client.force_login(editor_user)

    r = _post_json(client, LOCATION_CREATE, [1, 2])
    assert r.status_code == 400


def test_nb_racks_exposes_description(client, editor_user):
    # `_trim_rack` gained `description` (RACK-2) so the rack card in the edit → rack sub-mode
    # sidebar can show a location note (e.g. "east wall") without opening NetBox.
    from conftest import grant
    from dcim.models import Rack

    site, floor = _floor_location()
    Rack.objects.create(name='Rack A', site=site, location=floor,
                        description='East wall', status='active')
    grant(editor_user, Rack, ['view'])
    client.force_login(editor_user)

    r = client.get(reverse(RACKS) + f'?location={floor.pk}')
    assert r.status_code == 200
    (rack,) = r.json()['racks']
    assert rack['description'] == 'East wall'


# --- NbSitesView facility scoping (FACIL-1) ------------------------------------------------------
# The import wizard's building→Site search must return only the active facility's Sites, so an
# operator importing under one facility can't bind a building to another facility's Site — which
# would land the images/manifest/blobs under this facility while the Site's rooms strand elsewhere.
# `superuser` bypasses object-perm scoping, isolating the facility filter under test.

def _sitegroup(slug):
    from dcim.models import SiteGroup
    return SiteGroup.objects.create(name=slug, slug=slug)


def test_nb_sites_scoped_to_active_facility(client, superuser):
    from dcim.models import Site
    west = _sitegroup('west')
    Site.objects.create(name='West Alpha', slug='west-alpha', group=west)
    Site.objects.create(name='Ungrouped One', slug='ungrouped-one')
    client.force_login(superuser)

    r = client.get(reverse(SITES) + '?facility=west')
    assert r.status_code == 200
    assert {s['slug'] for s in r.json()['sites']} == {'west-alpha'}


def test_nb_sites_default_facility_returns_only_ungrouped(client, superuser):
    from dcim.models import Site
    west = _sitegroup('west')
    Site.objects.create(name='West Alpha', slug='west-alpha', group=west)
    Site.objects.create(name='Ungrouped One', slug='ungrouped-one')
    client.force_login(superuser)

    r = client.get(reverse(SITES))   # no ?facility= -> the default facility '' (ungrouped only)
    assert r.status_code == 200
    assert {s['slug'] for s in r.json()['sites']} == {'ungrouped-one'}


def test_nb_sites_rejects_bad_facility(client, superuser):
    client.force_login(superuser)
    r = client.get(reverse(SITES) + '?facility=bad.slug')   # '.' fails the ^[-\w]+$ slug rule
    assert r.status_code == 400


# --- `truncated` (TOPO-5): the list cap is reported, not silent. The split step pre-fetches the
# building list ONCE and matches drawing filenames against it client-side, so a clipped list that
# looked complete would quietly fail to match everything past the cap. -------------------------
#
# The caps are patched on `frontend_api.common`, the module that DEFINES them, not on the
# `frontend_api` package that re-exports them: `_list_cap` reads its own module's globals, so a
# patch on the facade would rebind a name nothing reads and the cap would silently stay at 200.

def test_nb_sites_reports_truncation_at_the_list_cap(client, superuser, monkeypatch):
    from dcim.models import Site
    from netbox_facilitymap.frontend_api import common as fa_common
    monkeypatch.setattr(fa_common, 'NB_LIST_CAP', 2)
    for i in range(2):
        Site.objects.create(name=f'Site {i}', slug=f'site-{i}')
    client.force_login(superuser)

    # Exactly at the cap is NOT truncated — the extra probe row simply isn't there.
    body = client.get(reverse(SITES)).json()
    assert len(body['sites']) == 2 and body['truncated'] is False

    Site.objects.create(name='Site 2', slug='site-2')
    body = client.get(reverse(SITES)).json()
    assert len(body['sites']) == 2 and body['truncated'] is True   # capped, and says so


def test_nb_building_locations_reports_truncation_at_the_list_cap(client, superuser, monkeypatch):
    from dcim.models import Location, Site
    from netbox_facilitymap.frontend_api import common as fa_common
    monkeypatch.setattr(fa_common, 'NB_LIST_CAP', 2)
    campus = Site.objects.create(name='Campus', slug='campus')
    for i in range(2):
        Location.objects.create(name=f'Bldg {i}', slug=f'bldg-{i}', site=campus)
    client.force_login(superuser)

    body = client.get(reverse(BUILDING_LOCATIONS)).json()
    assert len(body['locations']) == 2 and body['truncated'] is False

    Location.objects.create(name='Bldg 2', slug='bldg-2', site=campus)
    body = client.get(reverse(BUILDING_LOCATIONS)).json()
    assert len(body['locations']) == 2 and body['truncated'] is True


# --- `?full=1` (IMPORT-18): the split step matches the building list as a whole rather than typing
# into it, so it opts into the higher `NB_MATCH_CAP`. The per-keystroke default is unchanged, and
# the `truncated` contract above holds at whichever cap applies. ---------------------------------

def test_nb_building_locations_full_raises_the_cap_but_keeps_reporting_truncation(
        client, superuser, monkeypatch):
    from dcim.models import Location, Site
    from netbox_facilitymap.frontend_api import common as fa_common
    monkeypatch.setattr(fa_common, 'NB_LIST_CAP', 2)
    monkeypatch.setattr(fa_common, 'NB_MATCH_CAP', 4)
    campus = Site.objects.create(name='Campus', slug='campus')
    for i in range(4):
        Location.objects.create(name=f'Bldg {i}', slug=f'bldg-{i}', site=campus)
    client.force_login(superuser)

    # Past the per-keystroke cap, the default read clips and says so — the bug: buildings past it
    # could never be proposed to a drawing.
    body = client.get(reverse(BUILDING_LOCATIONS)).json()
    assert len(body['locations']) == 2 and body['truncated'] is True

    # `?full=1` reaches all four, and reports the whole list as whole.
    body = client.get(reverse(BUILDING_LOCATIONS), {'full': '1'}).json()
    assert len(body['locations']) == 4 and body['truncated'] is False

    # Past the *higher* cap it still clips honestly — raising the ceiling moved the number, not the
    # contract the frontend's partial-list fallback rides on.
    Location.objects.create(name='Bldg 4', slug='bldg-4', site=campus)
    body = client.get(reverse(BUILDING_LOCATIONS), {'full': '1'}).json()
    assert len(body['locations']) == 4 and body['truncated'] is True


def test_nb_sites_full_raises_the_cap(client, superuser, monkeypatch):
    from dcim.models import Site
    from netbox_facilitymap.frontend_api import common as fa_common
    monkeypatch.setattr(fa_common, 'NB_LIST_CAP', 2)
    monkeypatch.setattr(fa_common, 'NB_MATCH_CAP', 4)
    for i in range(4):
        Site.objects.create(name=f'Site {i}', slug=f'site-{i}')
    client.force_login(superuser)

    body = client.get(reverse(SITES)).json()
    assert len(body['sites']) == 2 and body['truncated'] is True

    body = client.get(reverse(SITES), {'full': '1'}).json()
    assert len(body['sites']) == 4 and body['truncated'] is False


def test_full_is_opt_in_only_for_the_match_read(client, superuser, monkeypatch):
    """Anything other than an explicit `full=1` keeps the per-keystroke cap — a stray `full=0`/
    `full=yes` must not silently widen a picker query."""
    from dcim.models import Site
    from netbox_facilitymap.frontend_api import common as fa_common
    monkeypatch.setattr(fa_common, 'NB_LIST_CAP', 2)
    monkeypatch.setattr(fa_common, 'NB_MATCH_CAP', 4)
    for i in range(4):
        Site.objects.create(name=f'Site {i}', slug=f'site-{i}')
    client.force_login(superuser)

    for value in ('0', 'yes', 'true', ''):
        body = client.get(reverse(SITES), {'full': value}).json()
        assert len(body['sites']) == 2 and body['truncated'] is True, value


# --- NbLocationsView shares that cap contract (IMPORT-29). Two callers with opposite needs use it:
# the map step's "+ Add floor" search types into the results (per-keystroke cap, the point), while
# `ImportFlow._loadFloors` reads a site's Location list as a WHOLE — it derives the floor buttons,
# the anchor tree, and the set stale floor assignments are swept against. Rooms are Locations too,
# so an ordinary site exceeds 200 long before a campus does, and a silently clipped answer there
# didn't merely hide floors: it made the client reset assignments whose Location sat past the cap.
# So this endpoint reports `truncated` and honours `?full=1` like its siblings. ------------------

def test_nb_locations_reports_truncation_at_the_list_cap(client, superuser, monkeypatch):
    from dcim.models import Location, Site
    from netbox_facilitymap.frontend_api import common as fa_common
    monkeypatch.setattr(fa_common, 'NB_LIST_CAP', 2)
    site = Site.objects.create(name='Site', slug='site')
    for i in range(2):
        Location.objects.create(name=f'Floor {i}', slug=f'floor-{i}', site=site)
    client.force_login(superuser)

    body = client.get(reverse(LOCATIONS), {'site': 'site'}).json()
    assert len(body['rooms']) == 2 and body['truncated'] is False

    Location.objects.create(name='Floor 2', slug='floor-2', site=site)
    body = client.get(reverse(LOCATIONS), {'site': 'site'}).json()
    assert len(body['rooms']) == 2 and body['truncated'] is True


def test_nb_locations_full_raises_the_cap_for_the_whole_list_read(client, superuser, monkeypatch):
    """`_loadFloors` passes `?full=1`; the per-keystroke "+ Add floor" search does not."""
    from dcim.models import Location, Site
    from netbox_facilitymap.frontend_api import common as fa_common
    monkeypatch.setattr(fa_common, 'NB_LIST_CAP', 2)
    monkeypatch.setattr(fa_common, 'NB_MATCH_CAP', 4)
    site = Site.objects.create(name='Site', slug='site')
    for i in range(4):
        Location.objects.create(name=f'Floor {i}', slug=f'floor-{i}', site=site)
    client.force_login(superuser)

    body = client.get(reverse(LOCATIONS), {'site': 'site'}).json()
    assert len(body['rooms']) == 2 and body['truncated'] is True

    body = client.get(reverse(LOCATIONS), {'site': 'site', 'full': '1'}).json()
    assert len(body['rooms']) == 4 and body['truncated'] is False

    # Past the higher cap it still clips honestly — the client refuses to sweep assignments against
    # a `truncated` answer, so the flag has to keep telling the truth at either ceiling.
    Location.objects.create(name='Floor 4', slug='floor-4', site=site)
    body = client.get(reverse(LOCATIONS), {'site': 'site', 'full': '1'}).json()
    assert len(body['rooms']) == 4 and body['truncated'] is True


def test_nb_locations_orders_shallowest_first_so_a_cap_never_clips_a_floor(client, superuser,
                                                                          monkeypatch):
    """The regression IMPORT-49 fixed: rooms crowding floors out of the answer.

    `Location.objects` is MPTT-managed, so it arrives in `tree_id, lft` order — a **depth-first**
    walk that descends into each floor's rooms before reaching the next floor. With the cap at 8 the
    old order returned `MAIN BUILDING, Level 1, its 3 rooms, Level 2, its 3 rooms` and stopped: two
    floors out of six, and the operator was told only that the site had "more locations than can be
    listed at once". Breadth-first, the six floors are emitted before a single room."""
    from dcim.models import Location, Site
    from netbox_facilitymap.frontend_api import common as fa_common
    monkeypatch.setattr(fa_common, 'NB_MATCH_CAP', 8)
    site = Site.objects.create(name='Main', slug='main')
    building = Location.objects.create(name='MAIN BUILDING', slug='main-building', site=site)
    for f in range(6):
        floor = Location.objects.create(name=f'Level {f}', slug=f'level-{f}', site=site,
                                        parent=building)
        for r in range(3):
            Location.objects.create(name=f'Room {f}0{r}', slug=f'room-{f}0{r}', site=site,
                                    parent=floor)
    client.force_login(superuser)

    body = client.get(reverse(LOCATIONS), {'site': 'main', 'full': '1'}).json()
    slugs = {r['slug'] for r in body['rooms']}
    assert 'main-building' in slugs
    assert {f'level-{f}' for f in range(6)} <= slugs, 'a floor was clipped'
    # Something *was* dropped — the rooms, which the floor list never reads — and the answer says
    # so, and says at which tier, so the client can tell this from a clip that reached the floors.
    assert body['truncated'] is True and body['truncated_depth'] == 2


def test_nb_locations_reports_the_tier_a_clip_landed_in(client, superuser, monkeypatch):
    """`truncated_depth` is the contract that lets a caller keep a clipped answer: everything
    shallower than it is complete. `None` when nothing was clipped at all."""
    from dcim.models import Location, Site
    from netbox_facilitymap.frontend_api import common as fa_common
    site = Site.objects.create(name='Campus', slug='campus')
    for i in range(3):
        Location.objects.create(name=f'Building {i}', slug=f'building-{i}', site=site)
    client.force_login(superuser)

    body = client.get(reverse(LOCATIONS), {'site': 'campus', 'full': '1'}).json()
    assert body['truncated'] is False and body['truncated_depth'] is None

    # Clipped among the roots themselves — the buildings — so a caller whose floors sit *below*
    # them has to distrust the answer, exactly as it always did.
    monkeypatch.setattr(fa_common, 'NB_MATCH_CAP', 2)
    body = client.get(reverse(LOCATIONS), {'site': 'campus', 'full': '1'}).json()
    assert body['truncated'] is True and body['truncated_depth'] == 0


def test_nb_locations_flags_a_slug_no_site_answers_to(client, superuser):
    """"No such Site" must not read as "this site has no floors" (IMPORT-29).

    Both return an empty `rooms`, but only the first means the *binding* is broken — a Site renamed
    or deleted in NetBox after the folder was bound. Without the flag the wizard quietly fell back
    to its floor-**type** vocabulary and built floor ids matching nothing in NetBox."""
    from dcim.models import Site
    Site.objects.create(name='Real', slug='real')
    client.force_login(superuser)

    body = client.get(reverse(LOCATIONS), {'site': 'gone'}).json()
    assert body['rooms'] == [] and body['site_not_found'] is True

    # A site that exists but holds no Locations is the *other* case, and says so.
    body = client.get(reverse(LOCATIONS), {'site': 'real'}).json()
    assert body['rooms'] == [] and body['site_not_found'] is False


# --- The map step's floor read across every organization shape (IMPORT-29). The client derives a
# building's floors from the site's flat Location list (`ImportFlow._floorsFromLocations`, covered in
# the JS tier), so what this endpoint owes it is the WHOLE tree — including rooms, which is precisely
# what makes an ordinary site outgrow the per-keystroke cap. ---------------------------------------

def test_nb_locations_returns_the_whole_tree_for_a_site_per_building_facility(client, superuser):
    """`site-as-building`: the Site *is* the building; floors are its top-level Locations."""
    from dcim.models import Location, Site
    site = Site.objects.create(name='Annex', slug='annex')
    l1 = Location.objects.create(name='Level 1', slug='level-1', site=site)
    Location.objects.create(name='Room 101', slug='room-101', site=site, parent=l1)
    Location.objects.create(name='Roof', slug='roof', site=site)
    client.force_login(superuser)

    rooms = client.get(reverse(LOCATIONS), {'site': 'annex', 'full': '1'}).json()['rooms']
    by_slug = {r['slug']: r for r in rooms}
    assert set(by_slug) == {'level-1', 'room-101', 'roof'}
    # The `parent` edge is what the client walks (MPTT depth/level is unreliable on 4.2+), so it has
    # to survive the trim.
    assert by_slug['room-101']['parent'] == l1.pk and by_slug['level-1']['parent'] is None


def test_nb_locations_returns_the_whole_tree_for_a_campus_facility(client, superuser):
    """`site-as-campus` (MODEL-4): one Site holds every building as a Location, floors are those
    buildings' children — and two buildings under one campus may share a floor slug."""
    from dcim.models import Location, Site
    campus = Site.objects.create(name='Campus', slug='campus')
    a = Location.objects.create(name='Building A', slug='bldg-a', site=campus)
    b = Location.objects.create(name='Building B', slug='bldg-b', site=campus)
    Location.objects.create(name='Level 1', slug='a-level-1', site=campus, parent=a)
    Location.objects.create(name='Level 1', slug='b-level-1', site=campus, parent=b)
    client.force_login(superuser)

    rooms = client.get(reverse(LOCATIONS), {'site': 'campus', 'full': '1'}).json()['rooms']
    by_slug = {r['slug']: r for r in rooms}
    assert set(by_slug) == {'bldg-a', 'bldg-b', 'a-level-1', 'b-level-1'}
    # Each floor hangs off its own building, which is what keeps the two apart client-side.
    assert by_slug['a-level-1']['parent'] == a.pk
    assert by_slug['b-level-1']['parent'] == b.pk


def test_nb_locations_returns_the_whole_tree_for_a_wing_facility(client, superuser):
    """campus → building → wing → floor (MULTI-5): the client re-anchors onto the wing, so the
    grandchild level has to reach it rather than being pruned server-side."""
    from dcim.models import Location, Site
    campus = Site.objects.create(name='Campus', slug='campus')
    bldg = Location.objects.create(name='Main', slug='main', site=campus)
    wing = Location.objects.create(name='North Wing', slug='north', site=campus, parent=bldg)
    floor = Location.objects.create(name='Level 1', slug='n-level-1', site=campus, parent=wing)
    Location.objects.create(name='Room 1', slug='n-room-1', site=campus, parent=floor)
    client.force_login(superuser)

    rooms = client.get(reverse(LOCATIONS), {'site': 'campus', 'full': '1'}).json()['rooms']
    by_slug = {r['slug']: r for r in rooms}
    assert set(by_slug) == {'main', 'north', 'n-level-1', 'n-room-1'}
    assert by_slug['north']['parent'] == bldg.pk and by_slug['n-level-1']['parent'] == wing.pk


# --- NbPlacementNearbyView (PLACE-2): diagnostic gear counts for the *empty* placement panel. When a
# room's Location has no directly-assigned placeable gear, this read-only endpoint reports where the
# gear actually lives — an ancestor Location or the Site — so the user can reassign it to this room.
# It never broadens the exact-Location placement query; it only counts. ---

PLACEMENT_NEARBY = 'plugins:netbox_facilitymap:api-nb-placement-nearby'


def _room_hierarchy():
    """Campus Site › building Location › floor Location › room Location (the room we diagnose)."""
    from dcim.models import Location, Site
    site = Site.objects.create(name='Campus', slug='campus')
    bldg = Location.objects.create(name='Building A', slug='bldg-a', site=site)
    floor = Location.objects.create(name='Floor 2', slug='floor-2', site=site, parent=bldg)
    room = Location.objects.create(name='Room 210', slug='room-210', site=site, parent=floor)
    return site, bldg, floor, room


def _rack(site, name, location=None):
    from dcim.models import Rack
    return Rack.objects.create(name=name, site=site, location=location, status='active')


def _unracked_device(site, name, location=None):
    from dcim.models import Device, DeviceRole, DeviceType, Manufacturer
    mfr, _ = Manufacturer.objects.get_or_create(name='M', slug='m')
    dtype, _ = DeviceType.objects.get_or_create(manufacturer=mfr, model='DT', slug='dt')
    role, _ = DeviceRole.objects.get_or_create(name='Role', slug='role')
    return Device.objects.create(name=name, device_type=dtype, role=role, site=site,
                                 location=location, status='active')


def test_placement_nearby_reports_ancestors_and_site(client, superuser):
    site, bldg, floor, room = _room_hierarchy()
    _rack(site, 'FloorRack', location=floor)             # on the floor (ancestor) Location
    _unracked_device(site, 'BldgDev', location=bldg)     # on the building (ancestor) Location
    _rack(site, 'SiteRack')                              # site-level, no Location
    client.force_login(superuser)

    body = client.get(reverse(PLACEMENT_NEARBY), {'location': room.pk}).json()
    scopes = {s['name']: s for s in body['nearby']}
    assert set(scopes) == {'Floor 2', 'Building A', 'Campus'}
    assert scopes['Floor 2']['racks'] == 1 and scopes['Floor 2']['devices'] == 0
    assert scopes['Building A']['devices'] == 1 and scopes['Building A']['racks'] == 0
    assert scopes['Campus']['kind'] == 'site' and scopes['Campus']['racks'] == 1
    # Nearest ancestor first, Site (broadest) last.
    assert [s['name'] for s in body['nearby']] == ['Floor 2', 'Building A', 'Campus']
    # A non-zero count links to its NetBox filtered list; a zero count carries no link.
    assert 'location_id=%d' % floor.pk in scopes['Floor 2']['racks_url']
    assert scopes['Floor 2']['devices_url'] is None
    assert 'site_id=%d' % site.pk in scopes['Campus']['racks_url']


def test_placement_nearby_site_scope_excludes_ancestor_located_gear(client, superuser):
    # A rack on an ancestor Location is reported under that Location, never doubled at the Site
    # (site-level counts require location IS NULL), so with no true site-level gear the Site scope is
    # omitted entirely.
    site, bldg, floor, room = _room_hierarchy()
    _rack(site, 'FloorRack', location=floor)
    client.force_login(superuser)

    scopes = {s['name']: s for s in
              client.get(reverse(PLACEMENT_NEARBY), {'location': room.pk}).json()['nearby']}
    assert 'Campus' not in scopes
    assert scopes['Floor 2']['racks'] == 1


def test_placement_nearby_excludes_rooms_own_gear(client, superuser):
    # Gear ON the room's own Location is placeable directly (the panel would not be empty), so it is
    # not a "nearby" scope — only ancestors + the Site are diagnosed.
    site, bldg, floor, room = _room_hierarchy()
    _rack(site, 'RoomRack', location=room)
    client.force_login(superuser)
    assert client.get(reverse(PLACEMENT_NEARBY), {'location': room.pk}).json()['nearby'] == []


def test_placement_nearby_empty_when_nothing_nearby(client, superuser):
    _, _, _, room = _room_hierarchy()
    client.force_login(superuser)
    assert client.get(reverse(PLACEMENT_NEARBY), {'location': room.pk}).json()['nearby'] == []


def test_placement_nearby_blank_or_unknown_location(client, superuser):
    client.force_login(superuser)
    assert client.get(reverse(PLACEMENT_NEARBY)).json()['nearby'] == []
    assert client.get(reverse(PLACEMENT_NEARBY), {'location': 999999}).json()['nearby'] == []


# ---- the floor-key anchor rule: segment -2 is the floor's DIRECT parent (MULTI-5) ----

def _wing_hierarchy():
    """Site -> building Location -> wing Location -> floor Location — the four-level tree the
    building-anchor design left out of scope, and the shape the import wizard's anchor drill-down
    now steers an operator through."""
    from dcim.models import Location, Site
    site = Site.objects.create(name='Campus', slug='campus')
    bldg = Location.objects.create(name='Building A', slug='building-a', site=site)
    wing = Location.objects.create(name='Wing North', slug='wing-north', site=site, parent=bldg)
    floor = Location.objects.create(name='Level 1', slug='level-1', site=site, parent=wing)
    return site, bldg, wing, floor


def test_resolve_floor_location_anchors_on_the_floors_direct_parent():
    # Anchoring the import folder on the WING resolves — the ordinary 3-segment key, no format
    # change. This is why `_floorsFromLocations` offers the anchor's children and never its
    # grandchildren: the middle segment is matched as the floor's `parent__slug`.
    from netbox_facilitymap.frontend_api import resolve_floor_location
    _, _, _, floor = _wing_hierarchy()
    assert resolve_floor_location('campus/wing-north/level-1') == floor


def test_resolve_floor_location_rejects_a_grandparent_anchor():
    # Anchoring on the BUILDING while the floor is a grandchild cannot resolve, so the wizard must
    # never emit such a key (`_dropUnanchoredTokens` downgrades any assignment that would).
    from netbox_facilitymap.frontend_api import resolve_floor_location
    _wing_hierarchy()
    assert resolve_floor_location('campus/building-a/level-1') is None


def test_resolve_floor_location_tolerates_a_deeper_key():
    # `parse_floor_key` reads segment -2, so even a hypothetical 4-segment key resolves by the
    # floor's direct parent rather than choking (BUILDING-ANCHOR-DESIGN §8 open-q 2).
    from netbox_facilitymap.frontend_api import resolve_floor_location
    _, _, _, floor = _wing_hierarchy()
    assert resolve_floor_location('campus/building-a/wing-north/level-1') == floor


# --- org_mode setting (MODEL-6): the one PER-FACILITY settings endpoint. Same IMPORT_PERM tier as
# its install-wide siblings, but the facility rides the body and the value lands in a nested
# `facility_org_modes` map, so two facilities' modes never clobber each other. -------------------

def test_org_mode_post_persists_for_the_named_facility(client, editor_user):
    client.force_login(editor_user)
    r = client.post(reverse(ORG_MODE),
                    data=json.dumps({'facility': 'ga', 'org_mode': 'site-as-campus'}),
                    content_type='application/json')
    assert r.status_code == 200 and r.json() == {'ok': True, 'org_modes': {'ga': 'site-as-campus'}}
    assert FacilityMapBlob.objects.get(kind='settings', facility='', key='').data \
        == {'facility_org_modes': {'ga': 'site-as-campus'}}


def test_org_mode_post_defaults_to_the_default_facility(client, editor_user):
    # An omitted facility is the default facility '' — not an error, matching `_facility`'s default.
    client.force_login(editor_user)
    r = client.post(reverse(ORG_MODE), data=json.dumps({'org_mode': 'site-as-campus'}),
                    content_type='application/json')
    assert r.status_code == 200 and r.json()['org_modes'] == {'': 'site-as-campus'}


def test_org_mode_post_rejects_an_unknown_mode_and_a_bad_facility(client, editor_user):
    client.force_login(editor_user)
    bad_mode = client.post(reverse(ORG_MODE),
                           data=json.dumps({'facility': 'ga', 'org_mode': 'site-as-anything'}),
                           content_type='application/json')
    bad_facility = client.post(reverse(ORG_MODE),
                               data=json.dumps({'facility': '../evil',
                                                'org_mode': 'site-as-campus'}),
                               content_type='application/json')
    assert bad_mode.status_code == 400 and bad_facility.status_code == 400
    assert not FacilityMapBlob.objects.filter(kind='settings').exists()


def test_org_mode_requires_import_permission(client, plain_user):
    # Admin-tier config like every setting beside it (PERM-1) — the everyday map-write gate is not
    # enough, and the refusal writes nothing.
    client.force_login(plain_user)
    r = client.post(reverse(ORG_MODE),
                    data=json.dumps({'facility': 'ga', 'org_mode': 'site-as-campus'}),
                    content_type='application/json')
    assert r.status_code == 403
    assert not FacilityMapBlob.objects.filter(kind='settings').exists()


def test_org_mode_reads_back_through_the_facilities_list(client, superuser, workdir):
    # The read-back channel: no GET of its own — the mode rides each facility record the SPA already
    # loads, and an unset facility reports the default. Listed as a superuser because the facility
    # list is object-permission scoped to the SiteGroups the caller may view.
    _grouped_site('ga', 'sa')
    _grouped_site('gb', 'sb')
    client.force_login(superuser)
    client.post(reverse(ORG_MODE),
                data=json.dumps({'facility': 'ga', 'org_mode': 'site-as-campus'}),
                content_type='application/json')

    listed = {f['slug']: f for f in client.get(reverse(FACILITIES)).json()['facilities']}
    assert listed['ga']['org_mode'] == 'site-as-campus'
    assert listed['gb']['org_mode'] == 'site-as-building'


# --- the `location` grouping (MODEL-8): sweep isolation + subtree-scoped anchor search -----------

def _location_grouping():
    FacilityMapBlob.objects.update_or_create(
        kind='settings', facility='', key='', defaults={'data': {'facility_grouping': 'location'}})


def _campus_two_facilities():
    """One campus Site hosting two location-grouping facilities: bldg-a (floors a-l1, a-l2) and
    bldg-b (floor b-l1). Returns (site, bldg_a, bldg_b)."""
    from dcim.models import Location, Site
    _location_grouping()
    site = Site.objects.create(name='Campus', slug='campus')
    a = Location.objects.create(name='Building A', slug='bldg-a', site=site)
    b = Location.objects.create(name='Building B', slug='bldg-b', site=site)
    Location.objects.create(name='A L1', slug='a-l1', site=site, parent=a)
    Location.objects.create(name='A L2', slug='a-l2', site=site, parent=a)
    Location.objects.create(name='B L1', slug='b-l1', site=site, parent=b)
    return site, a, b


def test_sync_rooms_sweep_never_crosses_a_location_facility():
    # THE MODEL-8 data-safety property: two facilities share one campus Site, so facility A's
    # authoritative whole-facility save (sweep_absent=True) must sweep only A's own floors — a
    # Site-slug scope would hand it B's rooms too, and this save would silently delete them.
    _campus_two_facilities()
    Room.objects.create(floor_key='campus/bldg-a/a-l1', room_id='keep-a')
    Room.objects.create(floor_key='campus/bldg-a/a-l2', room_id='sweep-a')
    Room.objects.create(floor_key='campus/bldg-b/b-l1', room_id='keep-b')

    # A's save posts only floor a-l1: a-l2's room is absent from the whole-facility document and is
    # swept; B's room is outside facility A entirely and must survive.
    sync_rooms({'campus/bldg-a/a-l1': [
        {'id': 'keep-a', 'label': '', 'polygon': [], 'location': None},
    ]}, user=None, facility='bldg-a', sweep_absent=True)

    keys = set(Room.objects.values_list('room_id', flat=True))
    assert keys == {'keep-a', 'keep-b'}


def test_nb_building_locations_scoped_to_the_location_facility_subtree(client, superuser):
    # Both facilities live under the one campus Site, so the Site scope alone can't split them —
    # the anchor search must offer only the requested facility's own subtree (FACIL-1 one level
    # down), or an operator could bind a drawing into a sibling facility.
    _campus_two_facilities()
    client.force_login(superuser)

    body = client.get(reverse(BUILDING_LOCATIONS) + '?facility=bldg-a').json()
    assert {l['slug'] for l in body['locations']} == {'bldg-a'}
