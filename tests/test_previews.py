"""Tier C — the settings-reading tier of `previews.py`.

Covers the two halves that the `PluginSettings` refactor centres on: the stateless write-side
`clamp_*` validators (shared by the Settings view and the class, no DB), and the `PluginSettings`
reader — its defaults, clamping, and the single-query invariant that is the whole reason the tier
is a class (load the install-wide `kind='settings'` row once in `__init__`, read every property off
the cached dict). The geometry helpers (`floor_sheets`, `room_viewbox`, …) are exercised through
`test_template_content.py` and are unchanged here.
"""

import json
import math

import pytest

from netbox_facilitymap.previews import (
    FLOOR_LABEL_FIELD_DEFAULT, ORIENTATION_DEFAULT, SIZE_DEFAULT, SIZE_MAX, SIZE_MIN, ZOOM_DEFAULT,
    ZOOM_MAX, ZOOM_MIN, PluginSettings, clamp_embed_size, clamp_floor_label_field,
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


# ---- PluginSettings (DB-backed) ----

@pytest.mark.django_db
def test_room_embed_settings_defaults_when_no_row():
    """No `kind='settings'` blob → every property falls back to its default."""
    embed = PluginSettings()
    assert embed.zoom == ZOOM_DEFAULT
    assert embed.size == SIZE_DEFAULT
    assert embed.orientation == ORIENTATION_DEFAULT


@pytest.mark.django_db
def test_room_embed_settings_floor_label_field_none_when_unset():
    """Unlike the embed settings, `floor_label_field` returns None when unset — the signal that
    `views._floor_label_field` should fall through to the PLUGINS_CONFIG default."""
    assert PluginSettings().floor_label_field is None

    from netbox_facilitymap.models import FacilityMapBlob
    # A settings row that exists but lacks the key still reads as unset (None), not a default.
    FacilityMapBlob.objects.create(kind='settings', key='', data={'room_embed_zoom': 3.0})
    assert PluginSettings().floor_label_field is None


@pytest.mark.django_db
def test_room_embed_settings_floor_label_field_reads_and_clamps():
    """A present value is returned verbatim; a present-but-bogus value clamps to the default (and
    still counts as 'set' — it's not None, so it wins over PLUGINS_CONFIG)."""
    from netbox_facilitymap.models import FacilityMapBlob

    blob = FacilityMapBlob.objects.create(kind='settings', key='', data={'floor_label_field': 'slug'})
    assert PluginSettings().floor_label_field == 'slug'

    blob.data = {'floor_label_field': 'bogus'}
    blob.save(update_fields=['data'])
    assert PluginSettings().floor_label_field == FLOOR_LABEL_FIELD_DEFAULT


@pytest.mark.django_db
def test_todos_enabled_defaults_off_and_reads_the_blob():
    """The to-do feature (ADDON-4) is off unless the settings blob turns it on — the headline
    invariant, so the core ships without it. No settings row and a row missing the key both read
    False; an explicit True/False is honoured. Mirrors `device_tool_enabled`'s default-off shape (and
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
    embed = PluginSettings()
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
    embed = PluginSettings()
    assert embed.zoom == ZOOM_MAX
    assert embed.size == SIZE_DEFAULT
    assert embed.orientation == ORIENTATION_DEFAULT


@pytest.mark.django_db
def test_plugin_settings_reads_all_in_one_query(django_assert_num_queries):
    """The core encapsulation win: one instance + reading **every** property — the room-embed trio,
    floor_label_field, and each add-on switch — hits the shared settings row exactly once, not once
    per value. This is what collapses `MapView`'s per-flag queries into one."""
    from netbox_facilitymap.models import FacilityMapBlob

    FacilityMapBlob.objects.create(kind='settings', key='', data={'room_embed_zoom': 2.5})
    with django_assert_num_queries(1):
        s = PluginSettings()
        _ = (s.zoom, s.size, s.orientation, s.floor_label_field,
             s.write_mode, s.inline_room_creation, s.device_tool, s.todos, s.render_hq,
             s.device_presets)


@pytest.mark.django_db
def test_convenience_wrappers_reuse_a_passed_instance(django_assert_num_queries):
    """Each wrapper takes an optional `PluginSettings`, so a caller already holding one (`MapView`,
    `RenderRunner.run`) reads the row once for all of them instead of once per wrapper call."""
    from netbox_facilitymap.models import FacilityMapBlob
    from netbox_facilitymap.previews import (
        device_presets, device_tool_enabled, inline_room_creation_enabled, render_hq_enabled,
        todos_enabled, write_mode_enabled)

    FacilityMapBlob.objects.create(kind='settings', key='', data={
        'write_mode': True, 'device_tool': True, 'todos': True, 'render_hq': True,
        'inline_room_creation': False, 'device_presets': []})
    with django_assert_num_queries(1):
        s = PluginSettings()
        assert write_mode_enabled(s) is True
        assert inline_room_creation_enabled(s) is False
        assert device_tool_enabled(s) is True
        assert todos_enabled(s) is True
        assert render_hq_enabled(s) is True
        assert device_presets(s) == []
    # Called bare they still read for themselves — no caller has to pass one.
    with django_assert_num_queries(1):
        assert write_mode_enabled() is True


@pytest.mark.django_db
def test_get_returns_the_raw_value_for_the_facilities_owned_keys(django_assert_num_queries):
    """`get` is how `facilities` reads its three settings off the same instance — unclamped, since
    their vocabularies live in that module (importing them here would be a cycle). It must return
    the stored value verbatim, junk included, so the caller's own clamp is the one that decides."""
    from netbox_facilitymap.models import FacilityMapBlob

    FacilityMapBlob.objects.create(kind='settings', key='', data={
        'facility_grouping': 'nonsense', 'default_facility': 'west'})
    with django_assert_num_queries(1):
        s = PluginSettings()
        assert s.get('facility_grouping') == 'nonsense'
        assert s.get('default_facility') == 'west'
        assert s.get('facility_org_modes') is None
        assert s.get('facility_org_modes', {}) == {}



@pytest.mark.django_db
def test_plugin_settings_switch_defaults_off_except_inline_room_creation():
    """Every add-on switch defaults **off** with no settings row — except `inline_room_creation`,
    whose absent key deliberately reads **on** so an install predating the SET-5 split keeps the
    create tile write mode used to imply. Pins the one asymmetry the consolidation could flatten."""
    s = PluginSettings()
    assert (s.write_mode, s.device_tool, s.todos, s.render_hq) == (False, False, False, False)
    assert s.inline_room_creation is True


@pytest.mark.django_db
def test_plugin_settings_reads_only_the_install_wide_row():
    """Settings are install-wide (`facility=''`, MULTI-1). A row parked under another facility key
    — e.g. one orphaned by a grouping change — must not be picked up as the settings document."""
    from netbox_facilitymap.models import FacilityMapBlob

    FacilityMapBlob.objects.create(kind='settings', facility='west', key='',
                                   data={'todos': True, 'room_embed_zoom': 4.0})
    s = PluginSettings()
    assert s.todos is False
    assert s.zoom == ZOOM_DEFAULT

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
    _point_in_ring, _point_ring_dist, _polygon_area, contained_map, evenodd_path,
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


def test_point_ring_dist_is_signed_and_zero_on_the_boundary():
    # Positive inside, negative outside, ~0 exactly on a wall — the magnitude around zero is what
    # lets `_is_contained` put a tolerance on the boundary the bare ray-cast can't answer.
    assert _point_ring_dist([0.5, 0.5], _OUTER) == pytest.approx(0.5)
    assert _point_ring_dist([1.5, 0.5], _OUTER) == pytest.approx(-0.5)
    assert _point_ring_dist([1.0, 0.5], _OUTER) == pytest.approx(0.0)


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


def test_contained_map_punches_only_children_drawn_above_their_container():
    # `rooms` arrives in stacking order, bottom→top (ROOM-4). Sending the nested room BEHIND its
    # container drops the punch, so the container paints and hit-tests over it — without this,
    # "send to back" would silently do nothing for the very case it exists to serve. The JS mirror
    # pins the same pair (`tests/js/lib.test.js`).
    assert contained_map([_room('big', _OUTER), _room('small', _INNER)]) == {'big': [_INNER]}
    assert contained_map([_room('small', _INNER), _room('big', _OUTER)]) == {}


def test_contained_map_keeps_parity_when_a_grandchild_outranks_its_parent():
    # Stack: big (bottom), tiny, small — `small` is above `big`, but `tiny` sits BELOW `small`.
    # `big` must still punch out only its direct child `small`; adding `tiny` (geometrically inside
    # `big`, and no longer shadowed by an above-`big` child) would flip evenodd parity and re-fill
    # tiny's area. Hence the z gate applies to the pruned direct set, never to the containment test.
    tiny = [[0.45, 0.45], [0.55, 0.45], [0.55, 0.55], [0.45, 0.55]]
    holes = contained_map([_room('big', _OUTER), _room('tiny', tiny), _room('small', _INNER)])
    assert holes == {'big': [_INNER]}


def test_contained_map_punches_a_child_sharing_a_wall_with_its_container():
    # The common real floor-plan case (ROOM-6): an interior room's wall coincides with a wall of the
    # space it was carved out of, so two of its vertices sit exactly ON the container's boundary. The
    # bare ray-cast answers such a vertex asymmetrically — inside on a left/bottom wall, outside on a
    # right/top one — so before the boundary tolerance the punch silently dropped for half of these
    # and the container's highlight painted over the child. The JS mirror pins the same four cases.
    for wall, ring in (
        ('left', [[0.0, 0.2], [0.3, 0.2], [0.3, 0.8], [0.0, 0.8]]),
        ('right', [[0.7, 0.2], [1.0, 0.2], [1.0, 0.8], [0.7, 0.8]]),
        ('bottom', [[0.2, 0.0], [0.8, 0.0], [0.8, 0.3], [0.2, 0.3]]),
        ('top', [[0.2, 0.7], [0.8, 0.7], [0.8, 1.0], [0.2, 1.0]]),
    ):
        holes = contained_map([_room('big', _OUTER), _room('child', ring)])
        assert holes == {'big': [ring]}, f'child flush against the {wall} wall'


def test_contained_map_punches_a_child_that_slices_its_container_in_two():
    # A corridor cutting an open-plan room in half — the case a real floor plan produces and the one
    # reported as "the punch does nothing" (ROOM-7). It is only contained when its ends stop ON the
    # container's side walls; the boundary tolerance is what makes that count, so this pins the same
    # rule as the shared-wall case above with the child spanning edge to edge rather than tucked
    # against one side. The container then draws as two halves either side of the slice.
    slice_ring = [[0.0, 0.45], [1.0, 0.45], [1.0, 0.55], [0.0, 0.55]]
    holes = contained_map([_room('big', _OUTER), _room('hall', slice_ring)])
    assert holes == {'big': [slice_ring]}


def test_contained_map_leaves_a_slice_that_overruns_its_container_un_punched():
    # The other side of that line, and the reported floor's actual geometry: a corridor drawn as one
    # room running the length of the building passes THROUGH the open-plan room rather than stopping
    # at it, so its ends land outside. That is partial overlap, which needs true polygon clipping and
    # is deliberately not handled (§10 *Partial overlap composites; it is not clipped*) — the two
    # rooms composite instead. Overrun by 0.01, two orders of magnitude past the 1e-4 tolerance.
    through = [[-0.01, 0.45], [1.01, 0.45], [1.01, 0.55], [-0.01, 0.55]]
    assert contained_map([_room('big', _OUTER), _room('hall', through)]) == {}


def test_contained_map_tolerance_does_not_swallow_a_room_outside_a_concave_container():
    # The tolerance widens containment AT the boundary, never past it. An L-shaped container and a
    # room in the L's notch: the child's bbox is inside the container's, so the cheap pre-check
    # passes and the vertex test is what has to reject it — and it is outside by 0.2, three orders of
    # magnitude beyond the epsilon. Too loose a tolerance would punch a hole here.
    el = [[0.0, 0.0], [1.0, 0.0], [1.0, 0.4], [0.4, 0.4], [0.4, 1.0], [0.0, 1.0]]
    notch = [[0.6, 0.6], [0.9, 0.6], [0.9, 0.9], [0.6, 0.9]]
    assert contained_map([_room('el', el), _room('notch', notch)]) == {}


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


# A Location traced as several rooms crops through the plural `sheet_bounds_for_rooms` (ROOM-9):
# the shared cell when they all sit on one sheet, the whole canvas when they don't.

from netbox_facilitymap.previews import sheet_bounds_for_rooms  # noqa: E402


def test_sheet_bounds_for_rooms_matches_the_singular_form_for_one_polygon():
    # The one-room embed must be unchanged: the plural helper is exactly the singular result.
    for polygon in (_BOTTOM_ROOM, []):
        assert (sheet_bounds_for_rooms([polygon], _STACK, _STACK_W, _STACK_H)
                == sheet_bounds_for_room(polygon, _STACK, _STACK_W, _STACK_H))


def test_sheet_bounds_for_rooms_keeps_the_cell_two_halves_share():
    # Both halves of the room sit on the bottom sheet → the crop stays scoped to that page.
    other_half = [[0.28, 0.73], [0.32, 0.73], [0.32, 0.77], [0.28, 0.77]]
    assert (sheet_bounds_for_rooms([_BOTTOM_ROOM, other_half], _STACK, _STACK_W, _STACK_H)
            == (0.0, 100.0, 100.0, 200.0))


def test_sheet_bounds_for_rooms_falls_back_to_the_canvas_across_sheets():
    # A room genuinely traced across both pages has to be framed across both, so the per-sheet
    # scoping steps aside rather than cropping half the room away.
    top_room = [[0.48, 0.23], [0.52, 0.23], [0.52, 0.27], [0.48, 0.27]]
    assert sheet_bounds_for_rooms([_BOTTOM_ROOM, top_room], _STACK, _STACK_W, _STACK_H) is None


def test_sheet_bounds_for_rooms_none_without_polygons():
    assert sheet_bounds_for_rooms([], _STACK, _STACK_W, _STACK_H) is None


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


def test_room_viewbox_frames_the_union_of_concatenated_polygons():
    # ROOM-9's crop contract: on the room-centred path only the bbox is read, so a caller framing a
    # Location traced as two rooms passes their vertices concatenated and gets the union's crop —
    # here wider than either half alone, and centred between them.
    left = [[0.1, 0.4], [0.2, 0.4], [0.2, 0.6], [0.1, 0.6]]
    right = [[0.8, 0.4], [0.9, 0.4], [0.9, 0.6], [0.8, 0.6]]
    union_x, _, union_w, _ = _vb(room_viewbox(left + right, 1000, 1000, zoom=1))
    left_x, _, left_w, _ = _vb(room_viewbox(left, 1000, 1000, zoom=1))
    assert union_w > left_w
    assert union_x < left_x                                 # starts left of the left half…
    assert union_x + union_w > 900                          # …and reaches past the right half


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


# ---- role_paint: the device-marker colour resolver (DEV-10, stateless — no DB) ----

from netbox_facilitymap.previews import (  # noqa: E402
    DEVICE_FILL, RACK_FILL, ROLE_INK_DARK, ROLE_INK_LIGHT, placement_markers, role_paint,
)


def test_role_paint_returns_a_css_ready_fill():
    # NetBox stores the colour bare; the frontend drops it straight into a CSS custom property,
    # so the '#' is added here rather than string-concatenated in the browser.
    assert role_paint('066fd1')[0] == '#066fd1'


def test_role_paint_tolerates_a_hash_prefixed_value():
    assert role_paint('#066fd1') == role_paint('066fd1')


def test_role_paint_inks_a_dark_role_white():
    # The historical look: white detail over a saturated body. The dark half of NetBox's palette
    # must keep it, or this feature would restyle markers that already read fine.
    for dark in ('066fd1', '2196f3', '4caf50', '9c27b0', 'f44336', '000000'):
        assert role_paint(dark)[1] == ROLE_INK_LIGHT, dark


def test_role_paint_inks_a_pale_role_dark():
    # The reason this helper exists: NetBox's palette includes white, light grey, yellow and
    # amber, over which the white glyph detail would leave an invisible blob.
    for pale in ('ffffff', 'f1f1f1', 'ffeb3b', 'ffc107', 'cddc39'):
        assert role_paint(pale)[1] == ROLE_INK_DARK, pale


def test_role_paint_matches_netbox_on_the_default_role_grey():
    # `9e9e9e` is `ColorChoices.COLOR_GREY`, the default every DeviceRole is born with, and it
    # lands just over the threshold (luminance 158 > 150) — so the commonest role of all inks
    # DARK. Pinned because it is the one value where a threshold tweak would visibly restyle a
    # whole install, and because agreeing with NetBox's own badge here is the point of reusing
    # its weights.
    assert role_paint('9e9e9e')[1] == ROLE_INK_DARK


def test_role_paint_declines_an_unusable_colour():
    # A blank colour, a short/long value or a non-hex one all fall back to the flat device grey
    # rather than emitting a broken `fill:`.
    for bad in (None, '', '   ', 'abc', '1234567', 'ggghhh', '#zzzzzz'):
        assert role_paint(bad) == (None, None), repr(bad)


# ---- placement_markers: the role colour on the server-rendered embed ----

_PLACEMENT_FLOOR = 'test-site/floor-1'


def _placement_floor(role_color='f44336', kind='device'):
    """A one-marker floor: a Site + floor Location, a Device whose role carries `role_color`
    (`''` = a role with no colour set) or a Rack, and the placements blob pointing at it.

    There is deliberately no roleless-Device case: `Device.role` is NOT NULL in NetBox, so the
    `if role`/`if dev.role_id` guards on both serializers are unreachable defence, not a state a
    test can construct. The real fallback path is a role whose colour won't parse."""
    from dcim.models import Device, DeviceRole, DeviceType, Location, Manufacturer, Rack, RackType, Site

    from netbox_facilitymap.models import FacilityMapBlob

    site = Site.objects.create(name='Test Site', slug='test-site')
    Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    mfr = Manufacturer.objects.create(name='M', slug='m')
    if kind == 'rack':
        rtype = RackType.objects.create(manufacturer=mfr, model='RT', slug='rt')
        obj = Rack.objects.create(name='R1', site=site, rack_type=rtype)
    else:
        dtype = DeviceType.objects.create(manufacturer=mfr, model='DT', slug='dt')
        role = DeviceRole.objects.create(name='Role', slug='role', color=role_color)
        obj = Device.objects.create(name='D1', device_type=dtype, role=role, site=site,
                                    status='active')
    FacilityMapBlob.objects.create(kind='placements', facility='', key=_PLACEMENT_FLOOR, data={
        'placements': [{'id': obj.pk, 'kind': kind, 'room': 'r1', 'label': 'M1',
                        'x': 0.5, 'y': 0.5}],
    })
    return obj


def _marker_styles(user):
    """The inline `style` of every glyph primitive on the floor's one marker — flattened, so a
    test asserts on the paint without needing to know which shape the glyph resolved to."""
    markers = placement_markers(_PLACEMENT_FLOOR, 100, 100, {'r1'}, user)
    assert len(markers) == 1
    return [g['style'] for g in markers[0]['glyph']]


@pytest.mark.django_db
def test_placement_markers_paints_a_device_body_in_its_role_colour(superuser):
    _placement_floor('f44336')
    styles = _marker_styles(superuser)
    assert any('fill:#f44336' in s for s in styles)
    assert not any(DEVICE_FILL in s for s in styles)          # the flat grey is gone


@pytest.mark.django_db
def test_placement_markers_flips_glyph_detail_ink_over_a_pale_role(superuser):
    # A pale body must not keep white rails/ports — that is the invisible-blob case.
    _placement_floor('ffeb3b')
    styles = _marker_styles(superuser)
    assert any(f'fill:#ffeb3b;stroke:{ROLE_INK_DARK}' in s for s in styles)
    assert not any(f'stroke:{ROLE_INK_LIGHT}' in s for s in styles)


@pytest.mark.django_db
def test_placement_markers_keeps_white_ink_over_a_dark_role(superuser):
    # The unchanged-from-before path, asserted so a threshold slip can't silently restyle every
    # marker that already read fine.
    _placement_floor('066fd1')
    styles = _marker_styles(superuser)
    assert any(f'fill:#066fd1;stroke:{ROLE_INK_LIGHT}' in s for s in styles)


@pytest.mark.django_db
def test_placement_markers_falls_back_to_grey_for_a_colourless_role(superuser):
    # The pre-DEV-10 look, kept for a role whose colour was cleared.
    _placement_floor('')
    styles = _marker_styles(superuser)
    assert any(f'fill:{DEVICE_FILL};stroke:{ROLE_INK_LIGHT}' in s for s in styles)


@pytest.mark.django_db
def test_placement_markers_leaves_racks_on_the_fixed_cabinet_blue(superuser):
    # A rack has no role to colour by, so DEV-10 must leave it exactly as it was.
    _placement_floor(kind='rack')
    assert _marker_styles(superuser) == [
        f'fill:{RACK_FILL};stroke:{ROLE_INK_LIGHT};stroke-width:1.5']


@pytest.mark.django_db
def test_placement_markers_greys_a_device_the_user_may_not_view(plain_user):
    # An unresolved device classifies off its stored label alone and has no role to read a
    # colour from — it must not leak the colour of a device the caller can't see.
    _placement_floor('f44336')
    styles = _marker_styles(plain_user)
    assert any(f'fill:{DEVICE_FILL}' in s for s in styles)
    assert not any('f44336' in s for s in styles)
