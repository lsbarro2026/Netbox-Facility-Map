"""Tier C — the room-embed settings tier of `previews.py`.

Covers the two halves that the `RoomEmbedSettings` refactor centres on: the stateless
write-side `clamp_*` validators (shared by the Settings view and the class, no DB), and the
`RoomEmbedSettings` reader — its defaults, clamping, and the single-query invariant that is the
whole reason the tier is a class (load the `kind='settings'` row once in `__init__`, read all
three properties off the cached dict). The geometry helpers (`floor_sheets`, `room_viewbox`, …)
are exercised through `test_template_content.py` and are unchanged here.
"""

import json
import math

import pytest

from netbox_facilitymap.previews import (
    FLOOR_LABEL_FIELD_DEFAULT, ORIENTATION_DEFAULT, SIZE_DEFAULT, SIZE_MAX, SIZE_MIN, ZOOM_DEFAULT,
    ZOOM_MAX, ZOOM_MIN, RoomEmbedSettings, clamp_embed_size, clamp_floor_label_field,
    clamp_orientation, clamp_zoom,
)


# ---- clamp_zoom (stateless, no DB) ----

def test_clamp_zoom_passes_in_range():
    assert clamp_zoom(3.0) == 3.0
    assert clamp_zoom('2.5') == 2.5


def test_clamp_zoom_clamps_out_of_range():
    assert clamp_zoom(ZOOM_MAX + 10) == ZOOM_MAX
    assert clamp_zoom(ZOOM_MIN - 10) == ZOOM_MIN


def test_clamp_zoom_defaults_on_non_number():
    assert clamp_zoom(None) == ZOOM_DEFAULT
    assert clamp_zoom('nope') == ZOOM_DEFAULT
    assert clamp_zoom(math.nan) == ZOOM_DEFAULT


# ---- clamp_embed_size (stateless, no DB) ----

def test_clamp_embed_size_passes_in_range():
    assert clamp_embed_size(60) == 60.0
    assert clamp_embed_size('75') == 75.0


def test_clamp_embed_size_clamps_out_of_range():
    assert clamp_embed_size(SIZE_MAX + 50) == SIZE_MAX
    assert clamp_embed_size(SIZE_MIN - 50) == SIZE_MIN


def test_clamp_embed_size_defaults_on_non_number():
    assert clamp_embed_size(None) == SIZE_DEFAULT
    assert clamp_embed_size('nope') == SIZE_DEFAULT
    assert clamp_embed_size(math.nan) == SIZE_DEFAULT


# ---- clamp_orientation (stateless, no DB) ----

def test_clamp_orientation_passes_recognised():
    assert clamp_orientation('landscape') == 'landscape'
    assert clamp_orientation('vertical') == 'vertical'


def test_clamp_orientation_defaults_on_unrecognised():
    assert clamp_orientation('diagonal') == ORIENTATION_DEFAULT
    assert clamp_orientation(None) == ORIENTATION_DEFAULT


# ---- clamp_floor_label_field (stateless, no DB) ----

def test_clamp_floor_label_field_passes_recognised():
    assert clamp_floor_label_field('name') == 'name'
    assert clamp_floor_label_field('slug') == 'slug'
    assert clamp_floor_label_field('description') == 'description'


def test_clamp_floor_label_field_defaults_on_unrecognised():
    assert clamp_floor_label_field('title') == FLOOR_LABEL_FIELD_DEFAULT
    assert clamp_floor_label_field(None) == FLOOR_LABEL_FIELD_DEFAULT


# ---- RoomEmbedSettings (DB-backed) ----

@pytest.mark.django_db
def test_room_embed_settings_defaults_when_no_row():
    """No `kind='settings'` blob → every property falls back to its default."""
    embed = RoomEmbedSettings()
    assert embed.zoom == ZOOM_DEFAULT
    assert embed.size == SIZE_DEFAULT
    assert embed.orientation == ORIENTATION_DEFAULT


@pytest.mark.django_db
def test_room_embed_settings_floor_label_field_none_when_unset():
    """Unlike the embed settings, `floor_label_field` returns None when unset — the signal that
    `views._floor_label_field` should fall through to the PLUGINS_CONFIG default."""
    assert RoomEmbedSettings().floor_label_field is None

    from netbox_facilitymap.models import FacilityMapBlob
    # A settings row that exists but lacks the key still reads as unset (None), not a default.
    FacilityMapBlob.objects.create(kind='settings', key='', data={'room_embed_zoom': 3.0})
    assert RoomEmbedSettings().floor_label_field is None


@pytest.mark.django_db
def test_room_embed_settings_floor_label_field_reads_and_clamps():
    """A present value is returned verbatim; a present-but-bogus value clamps to the default (and
    still counts as 'set' — it's not None, so it wins over PLUGINS_CONFIG)."""
    from netbox_facilitymap.models import FacilityMapBlob

    blob = FacilityMapBlob.objects.create(kind='settings', key='', data={'floor_label_field': 'slug'})
    assert RoomEmbedSettings().floor_label_field == 'slug'

    blob.data = {'floor_label_field': 'bogus'}
    blob.save(update_fields=['data'])
    assert RoomEmbedSettings().floor_label_field == FLOOR_LABEL_FIELD_DEFAULT


@pytest.mark.django_db
def test_todos_enabled_defaults_off_and_reads_the_blob():
    """The to-do feature (ADDON-4) is off unless the settings blob turns it on — the headline
    invariant, so the core ships without it. No settings row and a row missing the key both read
    False; an explicit True/False is honoured. Mirrors `ap_tool_enabled`'s default-off shape (and
    deliberately not `inline_room_creation_enabled`'s default-on back-compat asymmetry)."""
    from netbox_facilitymap.models import FacilityMapBlob
    from netbox_facilitymap.previews import todos_enabled

    assert todos_enabled() is False   # no settings row at all

    blob = FacilityMapBlob.objects.create(kind='settings', key='', data={'room_embed_zoom': 3.0})
    assert todos_enabled() is False   # row exists but the key is absent

    blob.data = {'todos': True}
    blob.save(update_fields=['data'])
    assert todos_enabled() is True

    blob.data = {'todos': False}
    blob.save(update_fields=['data'])
    assert todos_enabled() is False


@pytest.mark.django_db
def test_room_embed_settings_reads_stored_values():
    from netbox_facilitymap.models import FacilityMapBlob

    FacilityMapBlob.objects.create(kind='settings', key='', data={
        'room_embed_zoom': 3.5,
        'room_embed_size': 60,
        'room_embed_orientation': 'landscape',
    })
    embed = RoomEmbedSettings()
    assert embed.zoom == 3.5
    assert embed.size == 60.0
    assert embed.orientation == 'landscape'


@pytest.mark.django_db
def test_room_embed_settings_clamps_and_defaults_bogus_values():
    from netbox_facilitymap.models import FacilityMapBlob

    FacilityMapBlob.objects.create(kind='settings', key='', data={
        'room_embed_zoom': ZOOM_MAX + 100,     # out of range → clamped to max
        'room_embed_size': 'not-a-number',     # unparseable → default
        'room_embed_orientation': 'sideways',  # unrecognised → default
    })
    embed = RoomEmbedSettings()
    assert embed.zoom == ZOOM_MAX
    assert embed.size == SIZE_DEFAULT
    assert embed.orientation == ORIENTATION_DEFAULT


@pytest.mark.django_db
def test_room_embed_settings_reads_all_in_one_query(django_assert_num_queries):
    """The core encapsulation win: one instance + reading every property (all three embed settings
    plus floor_label_field) hits the shared settings row exactly once, not once per value."""
    from netbox_facilitymap.models import FacilityMapBlob

    FacilityMapBlob.objects.create(kind='settings', key='', data={'room_embed_zoom': 2.5})
    with django_assert_num_queries(1):
        embed = RoomEmbedSettings()
        _ = (embed.zoom, embed.size, embed.orientation, embed.floor_label_field)


# ---- floor_sheets keys off the manifest floor-key string, never a live Location slug (HEALTH-4) --

def _write_manifest(workdir, building_dir, floor_id):
    """A one-floor manifest at `<workdir>/manifest.json` (the default facility), keyed by the
    frozen `<building_dir>/<floor_id>` slugs — mirrors `test_health._write_manifest`."""
    (workdir / 'manifest.json').write_text(json.dumps({
        'siteplan': None,
        'buildings': [{'code': 'B', 'dir': building_dir, 'name': 'B', 'siteSlug': building_dir,
                       'floors': [{'id': floor_id, 'label': 'F', 'floorSlug': floor_id,
                                   'image': 'x.png', 'w': 100, 'h': 100, 'pages': []}]}],
    }))


@pytest.mark.django_db
def test_floor_sheets_keys_off_frozen_manifest_key_not_live_slugs(workdir):
    """The plan image is looked up purely by the `floor_key` string present in the manifest, wholly
    independent of any live Location slug — `floor_sheets` neither knows nor cares what a Location is
    now named. After a rename it is the *rename signal* (HEALTH-4) that re-keys the manifest so the
    new reconstructed key is present; here we pin the lookup itself: a key in the manifest resolves, a
    key absent from it (e.g. the pre-remap residue of a `bulk_update` rename) does not."""
    from netbox_facilitymap.previews import floor_sheets

    _write_manifest(workdir, 'bldg-a', 'floor-1')
    # The frozen manifest key resolves regardless of what the Location's slug now is.
    frozen = floor_sheets('bldg-a/floor-1')
    assert frozen is not None
    assert any('x.png' in sheet['url'] for sheet in frozen['sheets'])
    # The post-rename reconstructed key (new slugs) is absent from the frozen manifest → no plan.
    assert floor_sheets('bldg-a-renamed/floor-1-renamed') is None


# ---- Contained-room subtraction geometry (ROOM-1) — pure, no DB ----
# `contained_map`/`evenodd_path` power the embed highlight punching a smaller room out of a larger
# one it sits inside. All pure functions over normalized 0..1 rings, so no manifest/DB is needed.

from types import SimpleNamespace  # noqa: E402

from netbox_facilitymap.previews import (  # noqa: E402
    _point_in_ring, _polygon_area, contained_map, evenodd_path,
)


def _room(room_id, ring):
    """Minimal stand-in for a `Room` — `contained_map` only reads `.room_id` and `.polygon`."""
    return SimpleNamespace(room_id=room_id, polygon=ring)


# A big outer square [0,1]² and a small square fully inside it.
_OUTER = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]
_INNER = [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]]


def test_polygon_area_shoelace():
    assert _polygon_area(_OUTER) == pytest.approx(1.0)
    assert _polygon_area(_INNER) == pytest.approx(0.04)
    # Reversed winding gives the same absolute area (direction-agnostic).
    assert _polygon_area(list(reversed(_OUTER))) == pytest.approx(1.0)
    assert _polygon_area([[0, 0], [1, 1]]) == 0.0  # degenerate (<3 pts)


def test_point_in_ring_inside_and_outside():
    assert _point_in_ring([0.5, 0.5], _OUTER) is True
    assert _point_in_ring([1.5, 0.5], _OUTER) is False


def test_contained_map_punches_smaller_room_out_of_larger():
    holes = contained_map([_room('big', _OUTER), _room('small', _INNER)])
    # The larger room lists the smaller room's ring as a hole; the smaller lists nothing.
    assert holes == {'big': [_INNER]}


def test_contained_map_punches_only_direct_children_when_nested():
    # tiny ⊂ small ⊂ big: `big` punches out only `small` (its direct child), NOT `tiny` — `tiny`
    # is handled one level down by `small`. Listing `tiny` as a hole of `big` too would, under
    # evenodd parity, re-fill tiny's area inside big. So big→[small], small→[tiny], tiny→(none).
    tiny = [[0.45, 0.45], [0.55, 0.45], [0.55, 0.55], [0.45, 0.55]]
    holes = contained_map([_room('big', _OUTER), _room('small', _INNER), _room('tiny', tiny)])
    assert holes == {'big': [_INNER], 'small': [tiny]}


def test_contained_map_ignores_non_contained_overlap():
    # A room straddling the outer's edge (not fully inside) is NOT punched — containment only.
    straddle = [[0.8, 0.4], [1.4, 0.4], [1.4, 0.6], [0.8, 0.6]]
    holes = contained_map([_room('big', _OUTER), _room('straddle', straddle)])
    assert holes == {}


def test_contained_map_equal_size_rooms_do_not_punch_each_other():
    # Two identical rings: neither is *strictly smaller*, so neither punches the other (no mutual
    # subtraction that would render both empty).
    holes = contained_map([_room('a', _OUTER), _room('b', list(_OUTER))])
    assert holes == {}


def test_contained_map_skips_degenerate_rings():
    holes = contained_map([_room('big', _OUTER), _room('line', [[0.1, 0.1], [0.2, 0.2]])])
    assert holes == {}


def test_evenodd_path_single_ring_is_one_closed_contour():
    d = evenodd_path([_INNER], 100, 100)
    # One subpath: M<first> L<rest> Z, scaled by w×h.
    assert d == 'M40.0,40.0 L60.0,40.0 60.0,60.0 40.0,60.0 Z'


def test_evenodd_path_multi_ring_concatenates_subpaths():
    d = evenodd_path([_OUTER, _INNER], 100, 100)
    # Outer then inner, each its own M…Z subpath — evenodd punches the inner contour.
    assert d.count('M') == 2 and d.count('Z') == 2
    assert d.startswith('M0.0,0.0 L')


def test_evenodd_path_empty_when_no_valid_ring():
    assert evenodd_path([[[0, 0], [1, 1]]], 100, 100) == ''


# ---- Per-sheet room crop (SHOW-1) — pure, no DB ----
# On a multi-sheet floor the room embed must crop to the room's own sheet cell, not the whole
# combined canvas (which would reveal both pages). `sheet_bounds_for_room` picks the cell and
# `room_viewbox`'s `bounds` scopes the crop to it. Both pure over the combined-canvas geometry.

from netbox_facilitymap.previews import room_viewbox, sheet_bounds_for_room  # noqa: E402

# A 2-sheet vertical stack: two 100×100 pages → combined canvas 100 wide × 200 tall. Sheet cell
# rects come pre-formatted as strings (as `floor_sheets` emits them).
_STACK = [{'x': '0.0', 'y': '0.0', 'w': '100.0', 'h': '100.0'},
          {'x': '0.0', 'y': '100.0', 'w': '100.0', 'h': '100.0'}]
_STACK_W, _STACK_H = 100, 200

# A tiny room whose centroid sits on the *bottom* sheet (normalized y ≈ 0.75 → canvas y ≈ 150).
_BOTTOM_ROOM = [[0.48, 0.73], [0.52, 0.73], [0.52, 0.77], [0.48, 0.77]]


def test_sheet_bounds_none_for_single_sheet_floor():
    # <2 sheets: nothing to scope, so the caller keeps the whole-canvas crop unchanged.
    assert sheet_bounds_for_room(_BOTTOM_ROOM, _STACK[:1], _STACK_W, _STACK_H) is None


def test_sheet_bounds_none_for_empty_polygon():
    assert sheet_bounds_for_room([], _STACK, _STACK_W, _STACK_H) is None


def test_sheet_bounds_picks_the_cell_holding_the_centroid():
    # Bottom-sheet room → the bottom cell rect (y 100..200); a top-sheet room → the top cell.
    assert sheet_bounds_for_room(_BOTTOM_ROOM, _STACK, _STACK_W, _STACK_H) == (0.0, 100.0, 100.0, 200.0)
    top_room = [[0.48, 0.23], [0.52, 0.23], [0.52, 0.27], [0.48, 0.27]]
    assert sheet_bounds_for_room(top_room, _STACK, _STACK_W, _STACK_H) == (0.0, 0.0, 100.0, 100.0)


def test_sheet_bounds_none_when_centroid_in_no_cell():
    # Two cells with a horizontal gap between them; a centroid landing in the gap matches neither,
    # so we defer to the whole canvas rather than guess.
    gapped = [{'x': '0.0', 'y': '0.0', 'w': '100.0', 'h': '100.0'},
              {'x': '200.0', 'y': '0.0', 'w': '100.0', 'h': '100.0'}]
    mid = [[0.49, 0.4], [0.51, 0.4], [0.51, 0.6], [0.49, 0.6]]  # centroid cx = 150 → in the gap
    assert sheet_bounds_for_room(mid, gapped, 300, 100) is None


def test_room_viewbox_bounds_none_matches_explicit_full_canvas():
    # The default (whole-canvas) path is byte-for-byte identical to passing the full extent as
    # bounds — so single-sheet floors are provably unchanged. Also pins the concrete output.
    default = room_viewbox(_INNER, 100, 100, zoom=2)
    explicit = room_viewbox(_INNER, 100, 100, zoom=2, bounds=(0.0, 0.0, 100, 100))
    assert default == explicit == '14.0 14.0 72.0 72.0'


def test_room_viewbox_bounds_keeps_crop_within_the_rooms_sheet():
    # A high-zoom crop of the bottom-sheet room. Scoped to its cell (y 100..200) the box stays on
    # that page; against the whole canvas it would spill up past y=100 and reveal the top page.
    bounds = sheet_bounds_for_room(_BOTTOM_ROOM, _STACK, _STACK_W, _STACK_H)
    scoped = room_viewbox(_BOTTOM_ROOM, _STACK_W, _STACK_H, zoom=5, bounds=bounds)
    by, bh = float(scoped.split()[1]), float(scoped.split()[3])
    assert by >= 100.0 and by + bh <= 200.0                       # never crosses onto sheet 1

    unscoped = room_viewbox(_BOTTOM_ROOM, _STACK_W, _STACK_H, zoom=5)
    assert float(unscoped.split()[1]) < 100.0                     # the pre-fix bug: spills up


# ---- Device-centred crop (SHOW-3) — pure, no DB ----
# The device/rack embed passes `focus` (the device's own normalized marker centre) so the crop
# frames on the device, cropped tight, instead of the whole room. All pure geometry.

from netbox_facilitymap.previews import DEVICE_EMBED_CROP_FRAC  # noqa: E402


def _vb(s):
    return [float(v) for v in s.split()]


def test_room_viewbox_focus_centres_on_the_device():
    # A large room over a 1000×1000 canvas; device off-centre at (0.7, 0.3). The crop centres on
    # the device (not the room centroid) and spans DEVICE_EMBED_CROP_FRAC of the region on each axis.
    bx, by, bw, bh = _vb(room_viewbox(_OUTER, 1000, 1000, focus=(0.7, 0.3)))
    assert bx + bw / 2 == pytest.approx(700.0)                    # centred on the device x
    assert by + bh / 2 == pytest.approx(300.0)                    # centred on the device y
    assert bw == pytest.approx(1000 * DEVICE_EMBED_CROP_FRAC)     # tight, region-fraction span
    assert bh == pytest.approx(1000 * DEVICE_EMBED_CROP_FRAC)


def test_room_viewbox_focus_is_tighter_than_room_centred_in_a_large_room():
    # The reported pain point: in a large room the room-centred crop shows the whole room, shrinking
    # the device to nothing. The device-centred crop is strictly tighter (a bigger, legible glyph).
    _, _, room_bw, _ = _vb(room_viewbox(_OUTER, 1000, 1000, zoom=2))       # room embed
    _, _, dev_bw, _ = _vb(room_viewbox(_OUTER, 1000, 1000, focus=(0.5, 0.5)))  # device embed
    assert dev_bw < room_bw


def test_room_viewbox_focus_clamps_a_corner_device_inside_the_room():
    # A small room in the middle of a big canvas, device hard against the room's left edge. The crop
    # must stay inside the room's own padded bbox — never frame across into a neighbouring room.
    room = [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]]        # 400..600 px, margin 16 → 384..616
    bx, by, bw, bh = _vb(room_viewbox(room, 1000, 1000, focus=(0.4, 0.5)))
    assert bx >= 384.0 - 0.05 and bx + bw <= 616.0 + 0.05          # x within the padded room bbox
    assert by >= 384.0 - 0.05 and by + bh <= 616.0 + 0.05          # y within the padded room bbox


def test_room_viewbox_focus_stays_within_the_rooms_sheet():
    # On a multi-sheet floor the device crop must also stay on the room's own sheet cell (y 100..200
    # for the bottom sheet), exactly like the room-centred crop does via `bounds`.
    bounds = sheet_bounds_for_room(_BOTTOM_ROOM, _STACK, _STACK_W, _STACK_H)
    _, by, _, bh = _vb(room_viewbox(_BOTTOM_ROOM, _STACK_W, _STACK_H, bounds=bounds, focus=(0.5, 0.75)))
    assert by >= 100.0 and by + bh <= 200.0                       # never crosses onto sheet 1


def test_room_viewbox_focus_none_is_the_room_centred_path():
    # Passing focus=None explicitly is identical to omitting it — the room embed is unaffected.
    assert (room_viewbox(_INNER, 100, 100, zoom=2, focus=None)
            == room_viewbox(_INNER, 100, 100, zoom=2))
