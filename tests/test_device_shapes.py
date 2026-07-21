"""`DeviceShapes` (the server-side glyph port) + its use in `previews.placement_markers`.

Two tiers: pure-`DeviceShapes` unit tests (no DB) covering the keyword classification, the
per-type footprints, and the glyph primitives; and `django_db` tests that a placement's marker
renders its real glyph in the embed path — an access point as its broadcast puck, a rack as a
plain cabinet box — the SHOW-2 regression (APs used to render as undifferentiated boxes).

The classification rules are a 1:1 lockstep mirror of the frontend `DeviceShapes.typeFor`
(`static/.../device-shapes.js`); these tests pin the JS-faithful behaviour so a divergence in
either file is caught (incl. the `\\b` word-boundary tokens, and that a slug alone that only
matches via the role *name* still resolves).
"""

import pytest

from netbox_facilitymap.device_shapes import DeviceShapes


# ---- type_for (stateless, no DB) ----

def test_type_for_rack_is_always_rack():
    # kind wins outright — a rack never keyword-classifies (even a misleading label).
    assert DeviceShapes.type_for({'kind': 'rack', 'label': 'wifi ap'}) == 'rack'


def test_type_for_ap_matches_on_role_name():
    assert DeviceShapes.type_for({'kind': 'device'}, {'role_name': 'Access Point'}) == 'ap'
    assert DeviceShapes.type_for({'kind': 'device'}, {'role_name': 'Wireless'}) == 'ap'


def test_type_for_ap_word_boundary_tokens():
    # `\bap\b` / `\bwap\b`: a hyphen or space is a word boundary, so these resolve — mirroring
    # the JS regex (a plain substring match would miss the hyphen case).
    assert DeviceShapes.type_for({'kind': 'device', 'label': 'AP-01'}) == 'ap'
    assert DeviceShapes.type_for({'kind': 'device', 'label': 'WAP 5'}) == 'ap'
    # ...but 'ap' embedded in a longer word is NOT a standalone token ('cap' -> not ap).
    assert DeviceShapes.type_for({'kind': 'device', 'label': 'kneecap'}) != 'ap'


def test_type_for_slug_only_access_point_needs_the_name():
    # The 'access-point' slug alone can't match (`access ?point` is defeated by the hyphen and
    # there is no standalone 'ap' substring) — exactly as the JS behaves; the role NAME carries it.
    assert DeviceShapes.type_for({'kind': 'device'}, {'role_slug': 'access-point'}) == 'generic'
    assert DeviceShapes.type_for(
        {'kind': 'device'}, {'role_slug': 'access-point', 'role_name': 'Access Point'}) == 'ap'


def test_type_for_falls_back_to_device_name_then_label():
    assert DeviceShapes.type_for({'kind': 'device'}, {'name': 'core-switch-1'}) == 'switch'
    assert DeviceShapes.type_for({'kind': 'device', 'label': 'Edge Firewall'}) == 'firewall'


def test_type_for_generic_when_nothing_matches():
    assert DeviceShapes.type_for({'kind': 'device', 'label': 'Widget 7'}) == 'generic'
    assert DeviceShapes.type_for({'kind': 'device'}, None) == 'generic'


def test_type_for_rule_order_matches_js():
    # 'ap' is tried before the broad server/storage catch-alls, so a name carrying both a
    # wireless token and 'host' resolves to 'ap', not 'server' (JS comment on that ordering).
    assert DeviceShapes.type_for(
        {'kind': 'device'}, {'name': 'Wireless Host Controller'}) == 'ap'


# ---- box (stateless, no DB) ----

def test_box_known_and_unknown_types():
    assert DeviceShapes.box('ap') == {'w': 16, 'h': 16}
    assert DeviceShapes.box('rack') == {'w': 30, 'h': 40}
    # Unknown type falls back to the generic footprint (mirrors the JS `|| {w:22,h:15}`).
    assert DeviceShapes.box('nope') == {'w': 22, 'h': 15}


# ---- glyph (stateless, no DB) ----

def test_glyph_ap_is_puck_plus_three_rings():
    g = DeviceShapes.glyph('ap', 16, 16)
    assert [p['tag'] for p in g] == ['circle', 'circle', 'circle', 'circle']
    # The puck is a filled body; the three broadcast rings are stroked lines.
    assert g[0]['cls'] == 'dev-body'
    assert all(p['cls'] == 'dev-line' for p in g[1:])


def test_glyph_rack_is_a_single_centered_body_box():
    g = DeviceShapes.glyph('rack', 30, 40)
    assert g == [{'tag': 'rect', 'x': '-15', 'y': '-20', 'w': '30', 'h': '40', 'cls': 'dev-body'}]


def test_glyph_generic_is_box_with_centre_dot():
    g = DeviceShapes.glyph('generic', 22, 15)
    assert [p['tag'] for p in g] == ['rect', 'circle']
    assert g[0]['cls'] == 'dev-body' and g[1]['cls'] == 'dev-port'


def test_glyph_coords_are_trimmed_strings():
    # Whole numbers render without a trailing '.0'; fractions keep up to 2 places.
    body = DeviceShapes.glyph('rack', 30, 40)[0]
    assert body['w'] == '30' and body['x'] == '-15'


# ---- placement_markers integration (DB) ----

def _floor_scaffold(slug='b1'):
    """A building Site + manufacturer/device-type for building Devices/Racks under it."""
    from dcim.models import DeviceType, Manufacturer, Site
    site = Site.objects.create(name=slug.upper(), slug=slug)
    mfr = Manufacturer.objects.create(name='Acme', slug='acme')
    dtype = DeviceType.objects.create(model='Model', slug='model', manufacturer=mfr)
    return site, dtype


@pytest.mark.django_db
def test_placement_markers_ap_renders_puck_rack_renders_box(admin_user):
    """SHOW-2: an access-point placement draws its broadcast-puck glyph (circles), a rack a
    plain cabinet box — the two are now visually distinct in the embed, not identical boxes."""
    from dcim.models import Device, DeviceRole, Rack
    from netbox_facilitymap.models import FacilityMapBlob
    from netbox_facilitymap.previews import placement_markers

    site, dtype = _floor_scaffold()
    ap_role = DeviceRole.objects.create(name='Access Point', slug='access-point')
    ap = Device.objects.create(name='ap-1', role=ap_role, site=site, device_type=dtype)
    rack = Rack.objects.create(name='rack-1', site=site)

    FacilityMapBlob.objects.create(kind='placements', facility='', key='b1/1', data={'placements': [
        {'kind': 'device', 'id': ap.pk, 'room': 'r1', 'x': 0.5, 'y': 0.5},
        {'kind': 'rack', 'id': rack.pk, 'room': 'r1', 'x': 0.2, 'y': 0.2},
    ]})

    markers = placement_markers('b1/1', 1000, 1000, {'r1'}, admin_user)
    assert len(markers) == 2
    ap_marker, rack_marker = markers  # blob order preserved

    # AP: only circles (puck + 3 rings); rack: one rect.
    assert {p['tag'] for p in ap_marker['glyph']} == {'circle'} and len(ap_marker['glyph']) == 4
    assert [p['tag'] for p in rack_marker['glyph']] == ['rect']

    # Body fills differ by kind (rack --accent, device --text2), so an embed matches the live map.
    assert 'fill:#066fd1' in rack_marker['glyph'][0]['style']       # rack cabinet
    assert 'fill:#3d4654' in ap_marker['glyph'][0]['style']         # device puck body

    # Links stay permission-scoped (admin can view both).
    assert ap_marker['url'] == ap.get_absolute_url()
    assert rack_marker['url'] == rack.get_absolute_url()


@pytest.mark.django_db
def test_placement_markers_unresolved_device_classifies_off_label(admin_user):
    """A placement whose Device is gone (or the user can't view) still classifies off its stored
    label and renders that glyph, with no link — mirroring the JS `item=null` fallback."""
    from netbox_facilitymap.models import FacilityMapBlob
    from netbox_facilitymap.previews import placement_markers

    _floor_scaffold()
    FacilityMapBlob.objects.create(kind='placements', facility='', key='b1/1', data={'placements': [
        {'kind': 'device', 'id': 999999, 'room': 'r1', 'x': 0.5, 'y': 0.5, 'label': 'Aggr Switch'},
    ]})

    markers = placement_markers('b1/1', 1000, 1000, {'r1'}, admin_user)
    assert len(markers) == 1
    marker = markers[0]
    assert marker['url'] == ''                                   # unresolved -> no dead link
    # 'switch' label -> a body box plus a port row (rects), not the generic box+dot.
    tags = [p['tag'] for p in marker['glyph']]
    assert tags[0] == 'rect' and tags.count('rect') > 1          # body + ≥1 port
