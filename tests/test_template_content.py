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
# `_panel` (which needs the manifest to render) is stubbed to capture what right_page resolves. ----

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

    # Rename the floor Location — the frozen floor_key ('bldg-a/floor-1') no longer matches by slug.
    floor.slug = 'floor-1-renamed'
    floor.save()

    captured = {}

    def fake_panel(self, floor_key, rooms, **kw):
        captured['floor_key'] = floor_key
        captured['rooms'] = list(rooms)
        return 'PANEL'

    monkeypatch.setattr(FloorRooms, '_panel', fake_panel)

    request = RequestFactory().get('/')
    request.user = editor_user
    ext = FloorRooms(context={'object': floor, 'request': request})

    assert ext.right_page() == 'PANEL'
    # Resolved by FK despite the rename; the plan image still keys off the room's floor_key.
    assert [r.room_id for r in captured['rooms']] == ['r1']
    assert captured['floor_key'] == 'bldg-a/floor-1'
