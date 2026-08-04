"""Unit tests for the panel-title deep-link (`RoomPanelExtension._deep_link`).

No DB needed: `_deep_link` is a pure string builder over `reverse(...)` plus a room-like object,
so a `SimpleNamespace` stub stands in for a `Room`. Covers the whole-floor floor link, the
single-room room link (slug + uid fallback), URL-encoding, and the non-floor-key guard.
"""
from types import SimpleNamespace

from django.urls import reverse

from netbox_facilitymap.template_content import RoomPanelExtension


def _map():
    return reverse('plugins:netbox_facilitymap:map')


def _room(slug=None, room_id='rABC123'):
    """A stand-in for a `Room`: bound (location with a slug) or unbound (location_id falsy)."""
    location = SimpleNamespace(slug=slug) if slug else None
    return SimpleNamespace(location_id=(1 if slug else None), location=location, room_id=room_id)


def test_whole_floor_embed_links_to_floor_view():
    assert RoomPanelExtension._deep_link('bldg-a/floor-1', None) == _map() + '#/f/bldg-a/floor-1'


def test_bound_room_embed_links_to_room_deep_link_by_slug():
    url = RoomPanelExtension._deep_link('bldg-a/floor-1', _room(slug='room-101'))
    assert url == _map() + '#/r/bldg-a/floor-1/room-101'


def test_unbound_room_embed_falls_back_to_room_uid():
    url = RoomPanelExtension._deep_link('bldg-a/floor-1', _room(slug=None, room_id='rXYZ789'))
    assert url == _map() + '#/r/bldg-a/floor-1/rXYZ789'


def test_segments_are_url_encoded_to_match_the_hash_router():
    # The router decodes each segment per-part; a slash or space in a part must be encoded so it
    # doesn't split into a new segment (dir/fid come from the floor_key's first '/', so encode the
    # remainder). A space in the slug must survive as %20.
    url = RoomPanelExtension._deep_link('dir a/fid', _room(slug='room 1'))
    assert '#/r/dir%20a/fid/room%201' in url


def test_non_floor_key_yields_no_link():
    assert RoomPanelExtension._deep_link('not-a-floor-key', _room(slug='x')) == ''
    assert RoomPanelExtension._deep_link('', None) == ''


# --- facility-prefixed deep-links (MULTI-2): a non-default facility prefixes `#/y/<slug>` so the
# SPA opens the object's own facility. The default facility '' keeps the bare link. ----------------

def test_facility_prefixes_floor_link():
    assert (RoomPanelExtension._deep_link('bldg-a/floor-1', None, facility='west')
            == _map() + '#/y/west/f/bldg-a/floor-1')


def test_facility_prefixes_room_link():
    assert (RoomPanelExtension._deep_link('bldg-a/floor-1', _room(slug='room-101'), facility='west')
            == _map() + '#/y/west/r/bldg-a/floor-1/room-101')


def test_default_facility_keeps_bare_link():
    assert (RoomPanelExtension._deep_link('bldg-a/floor-1', None, facility='')
            == _map() + '#/f/bldg-a/floor-1')


# --- FloorRooms resolves a floor Location's rooms by the rename-proof `floor_location` FK (BIND-1),
# not by reconstructing `"<site.slug>/<floor.slug>"` — so a renamed floor Location keeps its rooms.
# `_floor_panel` (which needs the manifest to render) is stubbed to capture what right_page
# resolves. ----

import pytest  # noqa: E402


@pytest.mark.django_db
def test_floor_rooms_found_by_fk_after_floor_rename(editor_user, monkeypatch):
    from django.test import RequestFactory
    from dcim.models import Location, Site
    from netbox_facilitymap.models import Room
    from netbox_facilitymap.template_content import FloorRooms

    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    # A room bound to the floor by the FK, keyed by the ORIGINAL manifest slug.
    Room.objects.create(floor_key='bldg-a/floor-1', room_id='r1', floor_location=floor)

    # Rename via `bulk_update` (NetBox CSV import / bulk-edit) — this bypasses the HEALTH-4 rename
    # signal, so the frozen floor_key ('bldg-a/floor-1') stays stale and no longer matches by slug.
    # The FK is the backstop that keeps the floor's rooms resolving for exactly this residue.
    Location.objects.filter(pk=floor.pk).update(slug='floor-1-renamed')
    floor.refresh_from_db()

    captured = {}

    def fake_panel(self, floor_key, rooms, **kw):
        captured['floor_key'] = floor_key
        captured['rooms'] = list(rooms)
        return 'PANEL'

    monkeypatch.setattr(FloorRooms, '_floor_panel', fake_panel)

    request = RequestFactory().get('/')
    request.user = editor_user
    ext = FloorRooms(context={'object': floor, 'request': request})

    assert ext.right_page() == 'PANEL'
    # Resolved by FK despite the rename; the plan image still keys off the room's floor_key.
    assert [r.room_id for r in captured['rooms']] == ['r1']
    assert captured['floor_key'] == 'bldg-a/floor-1'


# --- End-to-end rename behaviour of the Location-page plan panel (HEALTH-4). A normal `save()`
# rename of a Site/floor auto-remaps the manifest, so BOTH a populated *and* an empty floor keep
# rendering their plan afterward. Only a `bulk_update` rename (which bypasses the signal) still leaves
# an empty floor blank — the residue. These drive the real `_floor_panel` (not the stub above), so a
# manifest under the frozen slug is written; the renames fire `on_commit` so the remap actually runs.

import json  # noqa: E402
import re  # noqa: E402


def _write_floor_manifest(workdir, building_dir, floor_id):
    """A one-floor manifest at `<workdir>/manifest.json` (default facility), keyed by the frozen
    `<building_dir>/<floor_id>` slugs — mirrors `test_health`/`test_previews`."""
    (workdir / 'manifest.json').write_text(json.dumps({
        'siteplan': None,
        'buildings': [{'code': 'B', 'dir': building_dir, 'name': 'B', 'siteSlug': building_dir,
                       'floors': [{'id': floor_id, 'label': 'F', 'floorSlug': floor_id,
                                   'image': 'x.png', 'w': 100, 'h': 100, 'pages': []}]}],
    }))


def _floor_rooms_html(loc, user):
    from django.test import RequestFactory
    from netbox_facilitymap.template_content import FloorRooms
    request = RequestFactory().get('/')
    request.user = user
    return FloorRooms(context={'object': loc, 'request': request}).right_page()


@pytest.mark.django_db
def test_populated_floor_panel_renders_plan_after_rename(editor_user, workdir,
                                                         django_capture_on_commit_callbacks):
    # A floor WITH a room: after renaming both the Site and the floor Location, the panel still
    # renders the plan image. The rename signal re-keys the manifest (and the room's floor_key) in
    # lockstep, so the lookup keeps resolving — no 404, no blank.
    from dcim.models import Location, Site
    from netbox_facilitymap.models import Room

    _write_floor_manifest(workdir, 'bldg-a', 'floor-1')
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    Room.objects.create(floor_key='bldg-a/floor-1', room_id='r1', floor_location=floor)

    with django_capture_on_commit_callbacks(execute=True):
        site.slug = 'bldg-a-renamed'
        site.save()
    with django_capture_on_commit_callbacks(execute=True):
        floor.slug = 'floor-1-renamed'
        floor.save()

    html = _floor_rooms_html(floor, editor_user)
    assert html  # a real panel, not the empty-string "no plan" sentinel
    assert 'x.png' in html  # the manifest image resolved through the re-keyed manifest


@pytest.mark.django_db
def test_empty_floor_panel_renders_plan_after_rename(editor_user, workdir,
                                                     django_capture_on_commit_callbacks):
    # HEALTH-4: an EMPTY floor (rendered plan, no rooms drawn) now KEEPS rendering after a Site/floor
    # rename. It has no room to borrow a frozen floor_key from, so FloorRooms reconstructs
    # "<live-site>/<live-floor>" — but the rename signal re-keyed the manifest to those very slugs, so
    # the reconstructed key matches again. This is the empty-floor breakage fixed at the source.
    from dcim.models import Location, Site

    _write_floor_manifest(workdir, 'bldg-a', 'floor-1')
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)

    # Before the rename the reconstructed live-slug key matches the frozen manifest → plan renders.
    assert 'x.png' in _floor_rooms_html(floor, editor_user)

    with django_capture_on_commit_callbacks(execute=True):
        site.slug = 'bldg-a-renamed'
        site.save()
    with django_capture_on_commit_callbacks(execute=True):
        floor.slug = 'floor-1-renamed'
        floor.save()

    # After the rename the reconstructed key ('bldg-a-renamed/floor-1-renamed') resolves because the
    # manifest was re-keyed to match — the plan still renders.
    assert 'x.png' in _floor_rooms_html(floor, editor_user)


@pytest.mark.django_db
def test_empty_floor_panel_explains_blank_after_bulk_site_rename(editor_user, workdir):
    # The residue HEALTH-5 targets: a `bulk_update` Site rename bypasses the signal, so the manifest
    # stays frozen at the old site slug while the floor's own slug is intact. The empty floor's
    # reconstructed live-slug key no longer matches (blank), but `floor_plan_drift` recognises it as a
    # drifted floor → the user sees an explanation instead of nothing.
    from dcim.models import Location, Site

    _write_floor_manifest(workdir, 'bldg-a', 'floor-1')
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    assert 'x.png' in _floor_rooms_html(floor, editor_user)  # resolves before the rename

    Site.objects.filter(pk=site.pk).update(slug='bldg-a-renamed')  # bulk path — no remap signal
    floor.refresh_from_db()

    html = _floor_rooms_html(floor, editor_user)
    assert 'x.png' not in html                     # the plan no longer resolves
    assert 'Floor plan unavailable' in html        # …but the blank is now explained
    assert 'may have been renamed' in html


@pytest.mark.django_db
def test_empty_3segment_floor_resolves_its_plan(editor_user, workdir):
    # HEALTH-10: an empty (no rooms) floor under a Location-anchored building (Site=campus,
    # MODEL-3) has no room to borrow a floor_key from, so FloorRooms must reconstruct the
    # 3-segment "<site>/<building>/<floor>" key from the floor Location's own parent (the building
    # anchor) — the naive 2-segment "<site>/<floor>" guess never matches this manifest shape, so the
    # panel used to stay silently blank even though a plan is genuinely rendered for this floor.
    from dcim.models import Location, Site

    _write_campus_manifest(workdir, 'campus', 'building-a', 'floor-1')
    campus = Site.objects.create(name='Campus', slug='campus')
    building = Location.objects.create(name='Building A', slug='building-a', site=campus)
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=campus, parent=building)

    html = _floor_rooms_html(floor, editor_user)
    assert 'x.png' in html


@pytest.mark.django_db
def test_non_floor_location_stays_blank_not_explained(editor_user, workdir):
    # A Location that isn't a floor at all (its slug matches no manifest floor) must render NOTHING —
    # the explanation must never land on a non-floor Location, even when a manifest exists.
    from dcim.models import Location, Site

    _write_floor_manifest(workdir, 'bldg-a', 'floor-1')
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    hallway = Location.objects.create(name='Hallway', slug='hallway', site=site)

    assert _floor_rooms_html(hallway, editor_user) == ''


@pytest.mark.django_db
def test_empty_floor_stays_blank_after_bulk_floor_rename(editor_user, workdir):
    # Boundary: when the FLOOR Location's own slug is bulk-renamed, the manifest floor id no longer
    # equals loc.slug, so the empty floor has no reliable link back to its plan — HEALTH-5 leaves it
    # silently blank rather than guessing (accepted degradation; HEALTH-4 covers the normal save path).
    from dcim.models import Location, Site

    _write_floor_manifest(workdir, 'bldg-a', 'floor-1')
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    assert 'x.png' in _floor_rooms_html(floor, editor_user)

    Location.objects.filter(pk=floor.pk).update(slug='floor-1-renamed')  # bulk path — no remap
    floor.refresh_from_db()

    assert _floor_rooms_html(floor, editor_user) == ''


# --- Query-cost regression (PERF-2). `_shared_context`'s per-room `.location` dereference (building
# each room's cross-link URL) only ever runs against the `rooms` list it draws, which the
# whole-floor caller has already `.select_related('location')`'d — never against the unoptimized
# `all_rooms` pool it also takes (that one is only used for the contained-room polygon math, no
# `.location` access). So the query count for the whole-floor view must stay flat as the room count
# grows; this pins that down against a future regression (e.g. someone re-pointing the URL-building
# loop at `all_rooms`).

from django.db import connection  # noqa: E402
from django.test.utils import CaptureQueriesContext  # noqa: E402

_QUERY_COST_RING = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]


@pytest.mark.django_db
def test_floor_rooms_panel_query_count_is_flat_across_room_count(editor_user, workdir):
    from dcim.models import Location, Site
    from netbox_facilitymap.models import Room

    _write_floor_manifest(workdir, 'bldg-a', 'floor-1')
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)

    def _set_room_count(n):
        Room.objects.all().delete()
        Location.objects.filter(parent=floor).delete()
        for i in range(n):
            room_loc = Location.objects.create(name=f'Room {i}', slug=f'room-{i}',
                                               site=site, parent=floor)
            Room.objects.create(floor_key='bldg-a/floor-1', room_id=f'r{i}', floor_location=floor,
                                location=room_loc, polygon=_QUERY_COST_RING)

    def _measure():
        # A *fresh* user instance each time: NetBox's `.restrict(user, ...)` caches the resolved
        # object-permission set on the user instance, so reusing one `User` object across
        # measurements would make the second call artificially cheap regardless of room count.
        fresh_user = type(editor_user).objects.get(pk=editor_user.pk)
        with CaptureQueriesContext(connection) as ctx:
            assert 'x.png' in _floor_rooms_html(floor, fresh_user)
        return len(ctx.captured_queries)

    _set_room_count(1)
    one_room = _measure()

    _set_room_count(5)
    five_rooms = _measure()

    assert five_rooms == one_room


# --- Contained-room subtraction in the embed highlight (ROOM-1). A smaller room drawn fully inside
# a larger one is punched out of the larger room's highlight (whole-floor view) and its spotlight
# hole (single-room embed) via an evenodd `<path>`, so the larger room's fill no longer covers it.

_BIG_RING = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]
_SMALL_RING = [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]]


@pytest.mark.django_db
def test_whole_floor_highlight_punches_contained_room(editor_user, workdir):
    # Whole-floor view: the big room's highlight `<path>` is a two-contour evenodd path (outer +
    # the contained small room punched out); the small room's is a single contour.
    from dcim.models import Location, Site
    from netbox_facilitymap.models import Room

    _write_floor_manifest(workdir, 'bldg-a', 'floor-1')
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    Room.objects.create(floor_key='bldg-a/floor-1', room_id='big',
                        floor_location=floor, polygon=_BIG_RING)
    Room.objects.create(floor_key='bldg-a/floor-1', room_id='small',
                        floor_location=floor, polygon=_SMALL_RING)

    html = _floor_rooms_html(floor, editor_user)
    paths = re.findall(r'<path d="([^"]+)"\s+fill="#2fa84f22"', html)
    assert len(paths) == 2
    holed = [p for p in paths if p.count('M') == 2]
    plain = [p for p in paths if p.count('M') == 1]
    # Exactly one room (the big one) carries the punched-out inner contour.
    assert len(holed) == 1 and len(plain) == 1
    # The inner contour is the small room's scaled ring (manifest is 100×100).
    assert '40.0,40.0' in holed[0]


@pytest.mark.django_db
def test_single_room_embed_spotlight_punches_contained_room(editor_user, workdir):
    # Single-room embed of the *larger* room: its spotlight hole is an evenodd `<path>` with the
    # contained small room punched out, so that area stays dimmed rather than reading as lit floor.
    from dcim.models import Location, Site
    from netbox_facilitymap.models import Room

    _write_floor_manifest(workdir, 'bldg-a', 'floor-1')
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    bigloc = Location.objects.create(name='Big', slug='big', site=site, parent=floor)
    Room.objects.create(floor_key='bldg-a/floor-1', room_id='big', floor_location=floor,
                        location=bigloc, polygon=_BIG_RING)
    Room.objects.create(floor_key='bldg-a/floor-1', room_id='small',
                        floor_location=floor, polygon=_SMALL_RING)

    # Render the big room's own Location page → cropped single-room embed with a spotlight.
    html = _floor_rooms_html(bigloc, editor_user)
    spot = re.search(r'<path d="([^"]+)" fill="#000" fill-rule="evenodd"/>', html)
    assert spot is not None
    # Two contours: the room outline plus the contained small room punched out of the lit hole.
    assert spot.group(1).count('M') == 2
    assert '40.0,40.0' in spot.group(1)


# --- BuildingFloors: the Location-anchored floor picker (MODEL-5). Under Site = campus the building
# is a `dcim.Location`, so the picker lives on the Location page, keys off the 3-segment `floor_key`,
# and links to the floor Locations *beneath* the building. Its Site-anchored sibling is SiteFloors.

def _write_campus_manifest(workdir, site_slug, building_slug, floor_id):
    """A one-floor manifest for a Location-anchored (Site = campus) building: `buildingSlug` set and
    the compound `dir` = `<site>/<building>`, so its floor key is the 3-segment shape (MODEL-3)."""
    (workdir / 'manifest.json').write_text(json.dumps({
        'siteplan': None,
        'buildings': [{'code': 'B', 'dir': f'{site_slug}/{building_slug}', 'name': 'B',
                       'siteSlug': site_slug, 'buildingSlug': building_slug,
                       'floors': [{'id': floor_id, 'label': 'F', 'floorSlug': floor_id,
                                   'image': 'x.png', 'w': 100, 'h': 100, 'pages': []}]}],
    }))


def _building_floors_html(loc, user):
    from django.test import RequestFactory
    from netbox_facilitymap.template_content import BuildingFloors
    request = RequestFactory().get('/')
    request.user = user
    return BuildingFloors(context={'object': loc, 'request': request}).full_width_page()


@pytest.mark.django_db
def test_building_floors_renders_for_a_location_anchored_building(editor_user, workdir):
    # The building Location page shows a floor card per rendered floor: the thumbnail resolves
    # through the 3-segment key, the room-count badge counts rooms under that 3-segment key (where
    # SiteFloors' 2-segment reconstruction would undercount), and the card links to the floor
    # Location beneath the building.
    from dcim.models import Location, Site
    from netbox_facilitymap.models import Room

    from conftest import grant

    _write_campus_manifest(workdir, 'campus', 'building-a', 'floor-1')
    campus = Site.objects.create(name='Campus', slug='campus')
    building = Location.objects.create(name='Building A', slug='building-a', site=campus)
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=campus, parent=building)
    Room.objects.create(floor_key='campus/building-a/floor-1', room_id='r1', floor_location=floor)
    # The card link is a floor-Location URL, resolved through `.restrict(user,'view')` like
    # SiteFloors' — so the editor needs Location view for the link to appear (Room view alone,
    # granted by the fixture, only covers the count).
    grant(editor_user, Location, ['view'])

    html = _building_floors_html(building, editor_user)
    assert html
    assert 'x.png' in html                    # thumbnail resolved through the 3-segment key
    assert floor.get_absolute_url() in html   # card links to the floor Location beneath the building
    assert '1 room' in html                   # counted off the 3-segment key, not undercounted


@pytest.mark.django_db
def test_building_floors_blank_for_a_non_anchor_location(editor_user, workdir):
    # A Location that no manifest building's `buildingSlug` matches gets no picker — here the floor
    # Location beneath the anchor (its slug is a floor id, not a building slug), so the panel is blank
    # and only the actual building Location renders the grid.
    from dcim.models import Location, Site

    _write_campus_manifest(workdir, 'campus', 'building-a', 'floor-1')
    campus = Site.objects.create(name='Campus', slug='campus')
    building = Location.objects.create(name='Building A', slug='building-a', site=campus)
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=campus, parent=building)

    assert _building_floors_html(floor, editor_user) == ''


# --- the `location` grouping (MODEL-8): the panels resolve their facility below the Site ---------

def _location_grouping():
    from netbox_facilitymap.models import FacilityMapBlob
    FacilityMapBlob.objects.update_or_create(
        kind='settings', facility='', key='', defaults={'data': {'facility_grouping': 'location'}})


def _write_facility_manifest(workdir, facility, site_slug, building_slug, floor_id, image):
    """A one-floor Location-anchored manifest nested under `facility`'s own working dir, the
    MULTI-2 layout a location-grouping facility renders into."""
    d = workdir / facility
    d.mkdir(exist_ok=True)
    (d / 'manifest.json').write_text(json.dumps({
        'siteplan': None,
        'buildings': [{'code': 'B', 'dir': f'{site_slug}/{building_slug}', 'name': building_slug,
                       'siteSlug': site_slug, 'buildingSlug': building_slug,
                       'floors': [{'id': floor_id, 'label': 'F', 'floorSlug': floor_id,
                                   'image': image, 'w': 100, 'h': 100, 'pages': []}]}],
    }))


@pytest.mark.django_db
def test_building_floors_reads_the_location_facility_manifest(editor_user, workdir):
    # Under the location grouping the building Location IS the facility, so its floor picker must
    # read the manifest nested under that facility's own working dir — the site-level resolution
    # (facility '') holds no manifest at all here.
    from dcim.models import Location, Site

    _location_grouping()
    _write_facility_manifest(workdir, 'building-a', 'campus', 'building-a', 'floor-1', 'a.png')
    campus = Site.objects.create(name='Campus', slug='campus')
    building = Location.objects.create(name='Building A', slug='building-a', site=campus)
    Location.objects.create(name='Floor 1', slug='floor-1', site=campus, parent=building)

    html = _building_floors_html(building, editor_user)
    assert html and 'a.png' in html


@pytest.mark.django_db
def test_site_floors_unions_the_hosted_location_facilities(superuser, workdir):
    # The campus Site page stays the whole-Site floor overview: one campus hosts several
    # location-grouping facilities, and its floor grid concatenates the cards of every hosted
    # facility's manifest rather than reading a single site-resolved one.
    from django.test import RequestFactory
    from dcim.models import Location, Site
    from netbox_facilitymap.template_content import SiteFloors

    _location_grouping()
    _write_facility_manifest(workdir, 'bldg-a', 'campus', 'bldg-a', 'a-l1', 'a.png')
    _write_facility_manifest(workdir, 'bldg-b', 'campus', 'bldg-b', 'b-l1', 'b.png')
    campus = Site.objects.create(name='Campus', slug='campus')
    a = Location.objects.create(name='Building A', slug='bldg-a', site=campus)
    b = Location.objects.create(name='Building B', slug='bldg-b', site=campus)
    Location.objects.create(name='A L1', slug='a-l1', site=campus, parent=a)
    Location.objects.create(name='B L1', slug='b-l1', site=campus, parent=b)

    request = RequestFactory().get('/')
    request.user = superuser
    html = SiteFloors(context={'object': campus, 'request': request}).full_width_page()
    assert 'a.png' in html and 'b.png' in html
