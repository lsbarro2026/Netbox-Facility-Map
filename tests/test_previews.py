"""Tier C — the room-embed settings tier of `previews.py`.

Covers the two halves that the `RoomEmbedSettings` refactor centres on: the stateless
write-side `clamp_*` validators (shared by the Settings view and the class, no DB), and the
`RoomEmbedSettings` reader — its defaults, clamping, and the single-query invariant that is the
whole reason the tier is a class (load the `kind='settings'` row once in `__init__`, read all
three properties off the cached dict). The geometry helpers (`floor_sheets`, `room_viewbox`, …)
are exercised through `test_template_content.py` and are unchanged here.
"""

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
