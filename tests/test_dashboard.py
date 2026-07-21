"""Tier C — the home-dashboard widgets (`dashboard.FacilityMapWidget` + `FacilitySearchWidget` +
`FacilityTodoWidget`). For the map widget: the map-read gate (degrade to a message rather than
iframing a 403), the `?embed=1` src assembly and its opt-in `interactive`/`legend`/facility/deep-link
segments, and the aspect-ratio box `_siteplan_ratio` derives from the rendered manifest (present →
`aspect-ratio`, absent/malformed → a plain fill). For the search-only widget (NAV-15): the shared
gate, the `?embed=1&finder=1` src, the facility hash segment, and its plain fill (no aspect ratio).
For the to-do widget (DASH-1): the shared gate, the `todos` add-on gate (ADDON-5 — off degrades to
a message, same shape as the permission gate), the `?embed=1` src at the `#/todo` route, the
facility hash segment (`#/y/<slug>/todo`), and its plain fill.

Both widgets read `request.user` through `may_view_map`; with the default `require_view_permission`
off, any authenticated user passes, so an `editor_user` + `RequestFactory` drives `render` and an
`AnonymousUser` exercises the gate — no monkeypatching of the access layer needed."""

import json

import pytest
from django.contrib.auth.models import AnonymousUser
from django.test import RequestFactory

pytestmark = pytest.mark.django_db


def _render(user, config=None):
    from netbox_facilitymap.dashboard import FacilityMapWidget
    request = RequestFactory().get('/')
    request.user = user
    widget = FacilityMapWidget(config=config or {})
    return str(widget.render(request))


def _render_search(user, config=None):
    from netbox_facilitymap.dashboard import FacilitySearchWidget
    request = RequestFactory().get('/')
    request.user = user
    widget = FacilitySearchWidget(config=config or {})
    return str(widget.render(request))


def _render_todo(user, config=None):
    from netbox_facilitymap.dashboard import FacilityTodoWidget
    request = RequestFactory().get('/')
    request.user = user
    widget = FacilityTodoWidget(config=config or {})
    return str(widget.render(request))


# ---- the map-read gate ----

def test_render_degrades_to_message_without_view_permission():
    # AnonymousUser isn't authenticated, so `may_view_map` is False — the widget must render a
    # message, never an <iframe> of the (gated) MapView that would 403 inside the card.
    html = _render(AnonymousUser())
    assert 'do not have permission' in html
    assert '<iframe' not in html


def test_render_shows_iframe_for_a_permitted_user(editor_user):
    html = _render(editor_user)
    assert '<iframe' in html
    assert 'title="Facility Map"' in html


# ---- src assembly ----

def test_src_is_embedded_by_default(editor_user):
    # `format_html` escapes the `&` querystring separators to `&amp;`, so assert on the bare
    # `key=1` tokens rather than the literal `&…` the source concatenates.
    html = _render(editor_user)
    assert '?embed=1' in html
    assert 'interactive=1' not in html
    assert 'legend=1' not in html


def test_interactive_and_legend_toggles_are_opt_in(editor_user):
    html = _render(editor_user, {'interactive': True, 'show_legend': True})
    assert 'interactive=1' in html
    assert 'legend=1' in html


def test_facility_and_link_build_the_hash_fragment(editor_user):
    html = _render(editor_user, {'facility': 'west', 'link': '#/b/bldg-1'})
    assert '#/y/west/b/bldg-1' in html


def test_invalid_facility_slug_falls_back_to_default(editor_user):
    # A traversal-shaped facility fails `valid_facility` and is dropped, so no `y/` segment leaks.
    html = _render(editor_user, {'facility': '../evil'})
    assert 'y/' not in html


# ---- aspect-ratio box from the manifest ----

def test_manifest_sizes_the_iframe_to_the_siteplan_ratio(editor_user, workdir):
    (workdir / 'manifest.json').write_text(json.dumps({
        'siteplan': {'w': 1224, 'h': 792}, 'buildings': [],
    }))
    html = _render(editor_user)
    assert 'aspect-ratio:1224/792' in html


def test_missing_manifest_falls_back_to_a_plain_fill(editor_user, workdir):
    # No manifest yet (pre-import): the box degrades to a plain height:100% fill, no aspect-ratio.
    html = _render(editor_user)
    assert 'height:100%' in html
    assert 'aspect-ratio' not in html


def test_malformed_siteplan_dimensions_fall_back_to_a_plain_fill(editor_user, workdir):
    # Non-numeric / non-positive dimensions can't yield a ratio — same plain-fill fallback.
    (workdir / 'manifest.json').write_text(json.dumps({
        'siteplan': {'w': 0, 'h': 'nope'}, 'buildings': [],
    }))
    html = _render(editor_user)
    assert 'aspect-ratio' not in html


# ---- the search-only widget (NAV-15) ----

def test_search_widget_degrades_without_view_permission():
    # Shares the map-read gate — an unpermitted user gets the message, never an <iframe>.
    html = _render_search(AnonymousUser())
    assert 'do not have permission' in html
    assert '<iframe' not in html


def test_search_widget_shows_a_finder_iframe_for_a_permitted_user(editor_user):
    # `?embed=1&finder=1` = the search-only embed (just the finder, no map/legend). `&` is escaped
    # to `&amp;`, so assert on the bare `key=1` tokens.
    html = _render_search(editor_user)
    assert '<iframe' in html
    assert 'title="Facility Search"' in html
    assert '?embed=1' in html
    assert 'finder=1' in html


def test_search_widget_is_a_plain_fill_never_aspect_ratio(editor_user, workdir):
    # A search box has no map to shape it to, so it always fills — even with a manifest present.
    (workdir / 'manifest.json').write_text(json.dumps({
        'siteplan': {'w': 1224, 'h': 792}, 'buildings': [],
    }))
    html = _render_search(editor_user)
    assert 'height:100%' in html
    assert 'aspect-ratio' not in html


def test_search_widget_result_target_defaults_to_map(editor_user):
    # No `result_target` (or the default 'map') never appends the netbox flag — a hit deep-links the
    # map, today's behavior (NAV-16).
    assert 'target=netbox' not in _render_search(editor_user)
    assert 'target=netbox' not in _render_search(editor_user, {'result_target': 'map'})


def test_search_widget_result_target_netbox_appends_flag(editor_user):
    # The NetBox-target option appends `&target=netbox`, which MapView reads into window.MAP (NAV-16).
    html = _render_search(editor_user, {'result_target': 'netbox'})
    assert 'target=netbox' in html


def test_search_widget_facility_builds_the_hash_segment(editor_user):
    html = _render_search(editor_user, {'facility': 'west'})
    assert '#/y/west' in html


def test_search_widget_invalid_facility_falls_back_to_default(editor_user):
    # A traversal-shaped slug fails `valid_facility` and is dropped — no `y/` segment leaks.
    html = _render_search(editor_user, {'facility': '../evil'})
    assert 'y/' not in html


# ---- the to-do widget (DASH-1), gated on the `todos` add-on (ADDON-4/ADDON-5) ----

def _set_todos(enabled):
    """Flip the install-wide to-do feature switch (ADDON-4), which the widget now gates on
    (ADDON-5). Mirrors `test_todos._set_todos`."""
    from netbox_facilitymap.models import FacilityMapBlob
    FacilityMapBlob.objects.update_or_create(
        kind='settings', facility='', key='', defaults={'data': {'todos': enabled}})


def test_todo_widget_degrades_without_view_permission():
    # Shares the map-read gate — an unpermitted user gets the message, never an <iframe>.
    html = _render_todo(AnonymousUser())
    assert 'do not have permission' in html
    assert '<iframe' not in html


def test_todo_widget_degrades_when_the_todos_addon_is_off(editor_user):
    # The `todos` add-on defaults off (ADDON-4) — iframing `#/todo` while off would just show the
    # bare-map bounce (`TodoView`), so the widget must degrade to a message instead of an <iframe>.
    html = _render_todo(editor_user)
    assert 'not enabled' in html
    assert '<iframe' not in html


def test_todo_widget_shows_a_todo_iframe_for_a_permitted_user(editor_user):
    # `?embed=1` at the `#/todo` route = the facility-wide to-do rollup, chrome-free in the card.
    _set_todos(True)
    html = _render_todo(editor_user)
    assert '<iframe' in html
    assert 'title="Facility To-do"' in html
    assert '?embed=1' in html
    assert '#/todo' in html


def test_todo_widget_is_a_plain_fill_never_aspect_ratio(editor_user, workdir):
    # A to-do list has no map to shape it to, so it always fills — even with a manifest present.
    _set_todos(True)
    (workdir / 'manifest.json').write_text(json.dumps({
        'siteplan': {'w': 1224, 'h': 792}, 'buildings': [],
    }))
    html = _render_todo(editor_user)
    assert 'height:100%' in html
    assert 'aspect-ratio' not in html


def test_todo_widget_facility_builds_the_hash_segment(editor_user):
    # The facility slug prefixes the route as `#/y/<slug>/todo`, the segment the SPA router reads.
    _set_todos(True)
    html = _render_todo(editor_user, {'facility': 'west'})
    assert '#/y/west/todo' in html


def test_todo_widget_invalid_facility_falls_back_to_default(editor_user):
    # A traversal-shaped slug fails `valid_facility` and is dropped — the bare `#/todo` remains.
    _set_todos(True)
    html = _render_todo(editor_user, {'facility': '../evil'})
    assert 'y/' not in html
    assert '#/todo' in html
