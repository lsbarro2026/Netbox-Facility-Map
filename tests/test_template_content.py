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


def _write_floor_manifest(workdir, building_dir, floor_id, size=100):
    """A one-floor manifest at `<workdir>/manifest.json` (default facility), keyed by the frozen
    `<building_dir>/<floor_id>` slugs — mirrors `test_health`/`test_previews`. `size` is the plan's
    pixel extent (the canvas normalized coords scale by); the default keeps a 1:1 percent↔pixel
    mapping, so a test asserting on scaled ring coordinates reads them straight off the ring."""
    (workdir / 'manifest.json').write_text(json.dumps({
        'siteplan': None,
        'buildings': [{'code': 'B', 'dir': building_dir, 'name': 'B', 'siteSlug': building_dir,
                       'floors': [{'id': floor_id, 'label': 'F', 'floorSlug': floor_id,
                                   'image': 'x.png', 'w': size, 'h': size, 'pages': []}]}],
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
    # Explicit stacking (ROOM-4): the small room sits ABOVE the big one, which is what makes the
    # big one punch it out. Stated rather than left to the `z_order` tiebreak, so the test asserts
    # the intended arrangement instead of passing on an alphabetical accident.
    Room.objects.create(floor_key='bldg-a/floor-1', room_id='big',
                        floor_location=floor, polygon=_BIG_RING, z_order=0)
    Room.objects.create(floor_key='bldg-a/floor-1', room_id='small',
                        floor_location=floor, polygon=_SMALL_RING, z_order=1)

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
def test_whole_floor_highlight_respects_stacking_order(editor_user, workdir):
    # ROOM-4: the embed mirrors the editor's paint order. With the small room sent BEHIND the big
    # one, the big room no longer punches it out (it paints over it instead), and the rooms are
    # emitted bottom→top so the browser composites them in the order the user chose.
    from dcim.models import Location, Site
    from netbox_facilitymap.models import Room

    _write_floor_manifest(workdir, 'bldg-a', 'floor-1')
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    Room.objects.create(floor_key='bldg-a/floor-1', room_id='small',
                        floor_location=floor, polygon=_SMALL_RING, z_order=0)
    Room.objects.create(floor_key='bldg-a/floor-1', room_id='big',
                        floor_location=floor, polygon=_BIG_RING, z_order=1)

    html = _floor_rooms_html(floor, editor_user)
    paths = re.findall(r'<path d="([^"]+)"\s+fill="#2fa84f22"', html)
    assert len(paths) == 2
    # No punch-out anywhere: every shape is a single contour.
    assert all(p.count('M') == 1 for p in paths)
    # Painted bottom→top — the small room first, the big one over it.
    assert '40.0,40.0' in paths[0] and '100.0,100.0' in paths[1]


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
                        location=bigloc, polygon=_BIG_RING, z_order=0)
    Room.objects.create(floor_key='bldg-a/floor-1', room_id='small',
                        floor_location=floor, polygon=_SMALL_RING, z_order=1)

    # Render the big room's own Location page → cropped single-room embed with a spotlight.
    html = _floor_rooms_html(bigloc, editor_user)
    spot = re.search(r'<path d="([^"]+)" fill="#000" fill-rule="evenodd"/>', html)
    assert spot is not None
    # Two contours: the room outline plus the contained small room punched out of the lit hole.
    assert spot.group(1).count('M') == 2
    assert '40.0,40.0' in spot.group(1)


# A corridor slicing the big room in half. Contained only because its ends stop ON the big room's
# side walls — containment is boundary-inclusive (ROOM-6). `_THROUGH_RING` is the same corridor
# drawn as one room running past the big room, which is partial overlap and never punched (ROOM-7).
_SLICE_RING = [[0.0, 0.45], [1.0, 0.45], [1.0, 0.55], [0.0, 0.55]]
_THROUGH_RING = [[-0.01, 0.45], [1.01, 0.45], [1.01, 0.55], [-0.01, 0.55]]


@pytest.mark.django_db
@pytest.mark.parametrize('hall_ring, contours', [(_SLICE_RING, 2), (_THROUGH_RING, 1)])
def test_whole_floor_highlight_punches_a_hallway_only_when_it_stops_at_the_walls(
        editor_user, workdir, hall_ring, contours):
    # ROOM-7, end to end through the embed: a hallway cutting an open-plan room in half punches out
    # of it when its ends are flush with that room's walls, and does NOT when the hallway is drawn
    # running past them. The second is partial overlap — deliberately composited rather than clipped
    # (§10 *Partial overlap composites; it is not clipped*) — and is the shape a real floor plan
    # produces when one corridor room spans the whole building.
    from dcim.models import Location, Site
    from netbox_facilitymap.models import Room

    _write_floor_manifest(workdir, 'bldg-a', 'floor-1')
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    Room.objects.create(floor_key='bldg-a/floor-1', room_id='big',
                        floor_location=floor, polygon=_BIG_RING, z_order=0)
    Room.objects.create(floor_key='bldg-a/floor-1', room_id='hall',
                        floor_location=floor, polygon=hall_ring, z_order=1)

    html = _floor_rooms_html(floor, editor_user)
    paths = re.findall(r'<path d="([^"]+)"\s+fill="#2fa84f22"', html)
    assert len(paths) == 2
    big = next(p for p in paths if '100.0,0.0' in p)
    assert big.count('M') == contours


# --- A Location modelled as SEVERAL rooms (ROOM-9). One physical room traced as two polygons, both
# bound to the same `dcim.Location`, is a supported state — and binding copies the Location name into
# every row's label, so `Room.Meta.ordering` can't even tell the rows apart. The embed must therefore
# render them ALL: every polygon highlighted, the crop over their union, the spotlight over all of
# them, and the markers/arrows of every `room_id`.

_LEFT_RING = [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3], [0.1, 0.3]]
_RIGHT_RING = [[0.7, 0.7], [0.9, 0.7], [0.9, 0.9], [0.7, 0.9]]


def _bind_room(floor, room_loc, room_id, ring):
    from netbox_facilitymap.models import Room
    return Room.objects.create(floor_key='bldg-a/floor-1', room_id=room_id, floor_location=floor,
                               location=room_loc, label='Hall', polygon=ring)


def _two_polygon_location(workdir, size=100):
    """A floor whose 'Hall' Location is bound to TWO rooms — the left and right polygons — as the
    two halves of one physical room. Returns `(site, floor, room_loc)`."""
    from dcim.models import Location, Site

    _write_floor_manifest(workdir, 'bldg-a', 'floor-1', size=size)
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    room_loc = Location.objects.create(name='Hall', slug='hall', site=site, parent=floor)
    _bind_room(floor, room_loc, 'left', _LEFT_RING)
    _bind_room(floor, room_loc, 'right', _RIGHT_RING)
    return site, floor, room_loc


def _highlights(html):
    return re.findall(r'<path d="([^"]+)"\s+fill="#2fa84f22"', html)


def _spotlight_holes(html):
    return re.findall(r'<path d="([^"]+)" fill="#000" fill-rule="evenodd"/>', html)


def _viewbox(html):
    return [float(v) for v in re.search(r'<svg viewBox="([^"]+)"', html).group(1).split()]


@pytest.mark.django_db
def test_room_embed_draws_every_room_bound_to_the_location(editor_user, workdir):
    # Both halves are highlighted — before ROOM-9 only one arbitrary row was resolved and drawn.
    _, _, room_loc = _two_polygon_location(workdir)

    paths = _highlights(_floor_rooms_html(room_loc, editor_user))
    assert len(paths) == 2
    # The manifest floor is 100×100, so the rings scale straight to their percentages.
    assert any('10.0,10.0' in p for p in paths) and any('70.0,70.0' in p for p in paths)


@pytest.mark.django_db
def test_room_embed_spotlight_lights_every_bound_room(editor_user, workdir):
    # One lit hole per bound room (the mask unions them), not one arbitrary half lit and the rest
    # of the room dimmed as if it were somebody else's floor.
    _, _, room_loc = _two_polygon_location(workdir)

    holes = _spotlight_holes(_floor_rooms_html(room_loc, editor_user))
    assert len(holes) == 2
    assert any('10.0,10.0' in d for d in holes) and any('70.0,70.0' in d for d in holes)


@pytest.mark.django_db
def test_room_embed_crop_frames_the_union_of_its_rooms(editor_user, workdir):
    # The crop has to reach both halves. Compared against the same floor with only the left half
    # bound, whose crop stops well short of the right one. On a plan big enough that the zoomed
    # crop isn't simply clamped to the whole page — which is what a 100px plan would give either
    # way, hiding the difference this pins.
    from netbox_facilitymap.models import Room

    _, _, room_loc = _two_polygon_location(workdir, size=1000)
    _, union_y, _, union_h = _viewbox(_floor_rooms_html(room_loc, editor_user))
    assert union_y + union_h >= 900                    # reaches the right half (rings end at 900)

    Room.objects.filter(room_id='right').delete()
    _, left_y, _, left_h = _viewbox(_floor_rooms_html(room_loc, editor_user))
    assert left_y + left_h < 900                       # the left half alone stops short of it


@pytest.mark.django_db
def test_room_embed_draws_markers_and_arrows_for_every_bound_room(editor_user, workdir):
    # Markers and wayfinding arrows are selected by `room_id`, so both halves' must appear — a
    # rack in the far half is exactly what someone opens this panel to find.
    from dcim.models import Manufacturer, Rack, RackType
    from netbox_facilitymap.models import FacilityMapBlob

    site, _, room_loc = _two_polygon_location(workdir)
    mfr = Manufacturer.objects.create(name='M', slug='m')
    rtype = RackType.objects.create(manufacturer=mfr, model='RT', slug='rt')
    racks = [Rack.objects.create(name=f'R{i}', site=site, rack_type=rtype) for i in (1, 2)]
    FacilityMapBlob.objects.create(kind='placements', facility='', key='bldg-a/floor-1', data={
        'placements': [
            {'id': racks[0].pk, 'kind': 'rack', 'room': 'left', 'label': 'RACK-L',
             'x': 0.2, 'y': 0.2},
            {'id': racks[1].pk, 'kind': 'rack', 'room': 'right', 'label': 'RACK-R',
             'x': 0.8, 'y': 0.8},
        ],
    })
    FacilityMapBlob.objects.create(kind='annotations', facility='', key='bldg-a/floor-1', data={
        'arrows': [{'points': [[0.5, 0.0], [0.2, 0.2]], 'room': 'left', 'color': '#ff0000'},
                   {'points': [[0.5, 1.0], [0.8, 0.8]], 'room': 'right', 'color': '#00ff00'}],
    })

    html = _floor_rooms_html(room_loc, editor_user)
    assert 'RACK-L' in html and 'RACK-R' in html
    assert html.count('<polyline points=') == 2


@pytest.mark.django_db
def test_room_embed_stays_on_the_primary_floor(editor_user, workdir):
    # A Location bound to rooms on two different floors can't render both in one panel (one panel
    # draws one plan), so it keeps the primary floor — the same one the pre-ROOM-9 `.first()` chose.
    from dcim.models import Location, Site
    from netbox_facilitymap.models import Room

    (workdir / 'manifest.json').write_text(json.dumps({
        'siteplan': None,
        'buildings': [{'code': 'B', 'dir': 'bldg-a', 'name': 'B', 'siteSlug': 'bldg-a', 'floors': [
            {'id': 'floor-1', 'label': 'F1', 'floorSlug': 'floor-1',
             'image': 'one.png', 'w': 100, 'h': 100, 'pages': []},
            {'id': 'floor-2', 'label': 'F2', 'floorSlug': 'floor-2',
             'image': 'two.png', 'w': 100, 'h': 100, 'pages': []},
        ]}],
    }))
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor1 = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    floor2 = Location.objects.create(name='Floor 2', slug='floor-2', site=site)
    room_loc = Location.objects.create(name='Hall', slug='hall', site=site, parent=floor1)
    _bind_room(floor1, room_loc, 'left', _LEFT_RING)
    Room.objects.create(floor_key='bldg-a/floor-2', room_id='upstairs', floor_location=floor2,
                        location=room_loc, label='Hall', polygon=_RIGHT_RING)

    html = _floor_rooms_html(room_loc, editor_user)
    assert 'one.png' in html and 'two.png' not in html
    assert len(_highlights(html)) == 1


@pytest.mark.django_db
def test_single_room_embed_is_unchanged_by_the_plural_path(editor_user, workdir):
    # The one-room case must render exactly as before: one highlight, one spotlight hole whose `d`
    # is the room's own scaled ring, and the crop of that ring alone.
    from dcim.models import Location, Site

    _write_floor_manifest(workdir, 'bldg-a', 'floor-1')
    site = Site.objects.create(name='Bldg A', slug='bldg-a')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    room_loc = Location.objects.create(name='Hall', slug='hall', site=site, parent=floor)
    _bind_room(floor, room_loc, 'left', _LEFT_RING)

    html = _floor_rooms_html(room_loc, editor_user)
    assert len(_highlights(html)) == 1
    assert _spotlight_holes(html) == ['M10.0,10.0 L30.0,10.0 30.0,30.0 10.0,30.0 Z']


@pytest.mark.django_db
def test_object_placement_embed_frames_only_the_polygon_holding_the_object(editor_user, workdir):
    # The device/rack embed must NOT widen to the Location's other polygons: it frames the object,
    # so it stays on the half the object actually sits in (SHOW-3), cropped tight around it.
    from dcim.models import Device, DeviceRole, DeviceType, Manufacturer
    from netbox_facilitymap.models import FacilityMapBlob
    from netbox_facilitymap.template_content import ObjectPlacement

    site, _, _ = _two_polygon_location(workdir)
    mfr = Manufacturer.objects.create(name='M', slug='m')
    dtype = DeviceType.objects.create(manufacturer=mfr, model='DT', slug='dt')
    role = DeviceRole.objects.create(name='Role', slug='role', color='f44336')
    device = Device.objects.create(name='D1', device_type=dtype, role=role, site=site,
                                   status='active')
    FacilityMapBlob.objects.create(kind='placements', facility='', key='bldg-a/floor-1', data={
        'placements': [{'id': device.pk, 'kind': 'device', 'room': 'right', 'label': 'D1',
                        'x': 0.8, 'y': 0.8}],
    })

    from django.test import RequestFactory
    request = RequestFactory().get('/')
    request.user = editor_user
    html = ObjectPlacement(context={'object': device, 'request': request}).right_page()

    assert len(_highlights(html)) == 1                 # only the polygon holding the device
    bx, by, _, _ = _viewbox(html)
    assert bx > 30 and by > 30                         # never frames across into the left half


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
