"""`DeviceShapes` (the server-side glyph port) + its use in `previews.placement_markers`.

Two tiers: pure-`DeviceShapes` unit tests (no DB) covering the keyword classification, the
per-type footprints, and the glyph primitives; and `django_db` tests that a placement's marker
renders its real glyph in the embed path — an access point as its broadcast puck, a rack as a
plain cabinet box — the SHOW-2 regression (APs used to render as undifferentiated boxes).

The classification rules are a 1:1 lockstep mirror of the frontend `DeviceShapes.typeFor`
(`static/.../device-shapes.js`); these tests pin the JS-faithful behaviour so a divergence in
either file is caught (incl. the `\\b` word-boundary tokens, and that a slug alone that only
matches via the role *name* still resolves).

That mirror is also checked from **both** directions: the shared-corpus tests at the bottom of this
file drive `tests/js/fixtures/device-glyph-cases.json` through the Python port, and
`tests/js/device-shapes.test.js` drives the very same cases through the JS one. Before that corpus
existed the lockstep was only ever asserted from this side, so a JS-only drift went unnoticed.
"""

import json
from pathlib import Path

import pytest
from django.conf import settings

from netbox_facilitymap.device_shapes import (
    _BUILTIN_GLYPH_TYPES, _LIB_INDEX, _LIBRARY, GLYPH_TYPES, DeviceShapes, custom_rules,
)


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


def test_type_for_slug_only_access_point_resolves_via_normalization():
    # `_normalize` folds the hyphen to a space, so the 'access-point' slug alone now matches
    # `access ?point` — the deliberate tolerance win over the old hyphen-defeated behaviour.
    assert DeviceShapes.type_for({'kind': 'device'}, {'role_slug': 'access-point'}) == 'ap'
    assert DeviceShapes.type_for(
        {'kind': 'device'}, {'role_slug': 'access-point', 'role_name': 'Access Point'}) == 'ap'


def test_type_for_normalizes_case_camel_and_separators():
    # The same role written every plausible way — spaced, upper, camelCase, hyphen, underscore —
    # all resolve identically (the `_normalize` lockstep with the JS). This is the tolerance the
    # user asked for: a NetBox role could be any of these.
    for value in ('access point', 'ACCESS POINT', 'AccessPoint', 'access-point', 'Access_Point'):
        assert DeviceShapes.type_for({'kind': 'device'}, {'role_name': value}) == 'ap', value


def test_type_for_access_switch_beats_generic_switch():
    # 'access switch' (any spelling) classifies as the distinct access/edge glyph, NOT the broad
    # `switch` — its rule sits ahead of the generic one. A plain 'switch' still falls through.
    for value in ('Access Switch', 'access-switch', 'AccessSwitch', 'ASW-1'):
        assert DeviceShapes.type_for({'kind': 'device'}, {'role_name': value}) == 'accessswitch', value
    assert DeviceShapes.type_for({'kind': 'device'}, {'role_name': 'Core Switch'}) == 'switch'


def test_type_for_outlet_distinct_from_pdu():
    # A wall outlet/receptacle reads as `outlet`; power strips / PDUs stay `pdu`. 'outlet' no
    # longer routes to pdu (the rule moved), so the two are visually distinguishable.
    for value in ('Wall Outlet', 'outlet', 'Socket', 'receptacle'):
        assert DeviceShapes.type_for({'kind': 'device'}, {'role_name': value}) == 'outlet', value
    for value in ('PDU', 'Rack PDU', 'Power Strip'):
        assert DeviceShapes.type_for({'kind': 'device'}, {'role_name': value}) == 'pdu', value


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


# ---- role_glyphs: the operator's own vocabulary (INTL-1) ----

@pytest.fixture
def role_glyphs(monkeypatch):
    """Set `PLUGINS_CONFIG role_glyphs` for one test. `custom_rules` memoizes on the raw setting
    value, so swapping it here is picked up rather than serving a stale cache."""
    def apply(value):
        monkeypatch.setitem(
            settings.PLUGINS_CONFIG['netbox_facilitymap'], 'role_glyphs', value)
    return apply


def test_role_glyphs_unset_leaves_english_rules_untouched():
    # The shipped default is empty, so an install that configures nothing is exactly as before.
    assert custom_rules() == ()
    assert DeviceShapes.type_for({'kind': 'device', 'label': 'Commutateur'}) == 'generic'


def test_role_glyphs_classifies_a_non_english_role(role_glyphs):
    role_glyphs({'switch': ['commutateur'], 'firewall': ['pare-feu']})
    assert DeviceShapes.type_for({'kind': 'device'}, {'role_name': 'Commutateur'}) == 'switch'
    # The keyword is folded like the haystack is, so the hyphen in 'pare-feu' matches 'Pare Feu'.
    assert DeviceShapes.type_for({'kind': 'device'}, {'role_name': 'Pare-Feu'}) == 'firewall'
    assert DeviceShapes.type_for({'kind': 'device'}, {'role_slug': 'pare-feu'}) == 'firewall'


def test_role_glyphs_merges_rather_than_replaces(role_glyphs):
    # Adding a French vocabulary must not cost the English one — merge, not replace.
    role_glyphs({'switch': ['commutateur']})
    assert DeviceShapes.type_for({'kind': 'device', 'label': 'Core Switch'}) == 'switch'
    assert DeviceShapes.type_for({'kind': 'device', 'label': 'AP-01'}) == 'ap'


def test_role_glyphs_win_over_a_conflicting_builtin_rule(role_glyphs):
    # Custom rules are tried first, so an operator can override a built-in classification: 'panel'
    # normally resolves to patchpanel, and here it is claimed for 'outlet' instead.
    role_glyphs({'outlet': ['panel']})
    assert DeviceShapes.type_for({'kind': 'device', 'label': 'Panel'}) == 'outlet'


def test_role_glyphs_match_whole_words_only(role_glyphs):
    # Same boundary semantics as the built-in `\bap\b` tokens — a keyword never fires mid-word.
    role_glyphs({'switch': ['sw']})
    assert DeviceShapes.type_for({'kind': 'device', 'label': 'SW 3'}) == 'switch'
    assert DeviceShapes.type_for({'kind': 'device', 'label': 'Sweater'}) == 'generic'


def test_role_glyphs_match_multi_word_phrases(role_glyphs):
    role_glyphs({'ap': ['punto de acceso']})
    assert DeviceShapes.type_for({'kind': 'device'}, {'role_name': 'Punto de Acceso'}) == 'ap'
    # The phrase must appear contiguously; the words alone are not enough.
    assert DeviceShapes.type_for({'kind': 'device', 'label': 'punto final'}) == 'generic'


def test_role_glyphs_support_non_latin_scripts(role_glyphs):
    # The regression the normalizer widening fixes: `[^a-z0-9]` used to delete these characters
    # outright, leaving an empty haystack that no keyword could ever match.
    role_glyphs({'patchpanel': ['パッチパネル'], 'firewall': ['экран']})
    assert DeviceShapes.type_for({'kind': 'device'}, {'role_name': 'パッチパネル'}) == 'patchpanel'
    assert DeviceShapes.type_for({'kind': 'device'}, {'role_name': 'Пожарный экран'}) == 'firewall'


def test_normalize_keeps_unicode_letters_and_digits():
    assert DeviceShapes._normalize({'label': 'Pare-Feu #2'}, None) == 'pare feu 2'
    assert DeviceShapes._normalize({'label': 'パッチパネル'}, None) == 'パッチパネル'
    # ASCII behaviour is unchanged, incl. the camelCase split and the separator fold.
    assert DeviceShapes._normalize({'label': 'AccessPoint_01'}, None) == 'access point 01'


def test_role_glyphs_rejects_malformed_config_without_raising(role_glyphs):
    # A bad setting must degrade to the built-in rules, never break every map render.
    role_glyphs({'not-a-glyph-type': ['x'],      # unknown type → dropped
                 'switch': 'commutateur',        # bare string, not a list → dropped
                 'router': [],                   # no keywords → dropped
                 'ups': ['---'],                 # folds away to nothing → dropped
                 'storage': ['almacenamiento']})  # the one valid entry survives
    assert custom_rules() == (('storage', ('almacenamiento',)),)
    assert DeviceShapes.type_for({'kind': 'device', 'label': 'Almacenamiento'}) == 'storage'
    assert DeviceShapes.type_for({'kind': 'device', 'label': 'Commutateur'}) == 'generic'
    role_glyphs(['not', 'a', 'dict'])
    assert custom_rules() == ()


def test_role_glyphs_preserve_configured_order(role_glyphs):
    # Two custom rules matching the same haystack resolve in insertion order, so an operator can
    # order their own vocabulary the way the built-in list is ordered.
    role_glyphs({'ap': ['borne'], 'switch': ['borne']})
    assert DeviceShapes.type_for({'kind': 'device', 'label': 'Borne'}) == 'ap'


def test_role_glyphs_never_override_a_rack(role_glyphs):
    # `kind` still wins outright — a rack is a rack whatever the vocabulary says.
    role_glyphs({'ap': ['armoire']})
    assert DeviceShapes.type_for({'kind': 'rack', 'label': 'Armoire 3'}) == 'rack'


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


def test_glyph_lucide_type_is_body_chip_plus_transformed_icon_paths():
    # An appliance type (server) renders the body chip + its vendored Lucide icon: every icon
    # element is a `path` carrying the scale+centre `transform` that fits the 24×24 glyph into
    # the box, all in `dev-line`. This is the embed side of the "pull from Lucide" work.
    g = DeviceShapes.glyph('server', 22, 18)
    assert g[0]['tag'] == 'rect' and g[0]['cls'] == 'dev-body'          # the chip
    icon = g[1:]
    assert len(icon) == len(DeviceShapes._LUCIDE['server'])
    assert all(p['tag'] == 'path' and p['cls'] == 'dev-line' for p in icon)
    assert all('transform' in p and p['transform'].startswith('translate(') for p in icon)
    # Non-icon (bespoke) glyphs never carry a transform.
    assert all('transform' not in p for p in DeviceShapes.glyph('ap', 16, 16))


def test_glyph_outlet_is_faceplate_plus_two_slots():
    # A wall outlet is a thin body chip with two receptacle slots (dev-port rects) — distinct
    # from the generic box+dot and from the PDU's row of round outlets.
    g = DeviceShapes.glyph('outlet', 12, 7)
    assert g[0]['cls'] == 'dev-body'
    ports = [p for p in g[1:] if p['tag'] == 'rect' and p['cls'] == 'dev-port']
    assert len(ports) == 2


def test_glyph_accessswitch_has_port_row_and_uplink():
    # The access switch reads as a switch (body + several ports) but adds a separated uplink
    # port, so it's distinguishable from the core `switch` glyph.
    g = DeviceShapes.glyph('accessswitch', 24, 10)
    ports = [p for p in g if p['tag'] == 'rect' and p['cls'] == 'dev-port']
    assert len(ports) >= 3          # dense access-port row + the uplink SFP


def test_box_new_types_are_all_narrower_than_the_rack():
    # The cohesion invariant: the rack is the reference and the widest object; every device
    # default (including the new accessswitch/outlet) is narrower than the rack's 30px.
    rack_w = DeviceShapes.box('rack')['w']
    for t in ('server', 'router', 'firewall', 'storage', 'ups', 'switch',
              'accessswitch', 'patchpanel', 'pdu', 'outlet', 'ap', 'generic'):
        assert DeviceShapes.box(t)['w'] < rack_w, t


# ---- the shared JS/Python lockstep corpus ----

_CORPUS = json.loads(
    (Path(__file__).parent / 'js' / 'fixtures' / 'device-glyph-cases.json').read_text('utf-8'))


def _args_for(case):
    """Split a shape-neutral corpus case into this port's `(placement, item)` pair.

    The corpus stores the classification *facts* flat, because the two ports take different item
    shapes: Python reads `role_slug`/`role_name`/`name` off a flat mapping, while the JS reads a
    nested `item.role.slug`/`item.role.name`. `tests/js/device-shapes.test.js` has the mirror of
    this adapter. Keys the case omits stay absent on both sides."""
    placement = {'kind': case.get('kind', 'device')}
    if 'label' in case:
        placement['label'] = case['label']
    if 'icon' in case:
        placement['icon'] = case['icon']   # the explicit preset icon (DEV-8)
    item = {k: case[k] for k in ('role_slug', 'role_name', 'name') if k in case}
    return placement, (item or None)


def _label(case):
    """A readable id for a corpus case, so a failure names the input rather than an index."""
    return json.dumps({k: v for k, v in case.items() if k not in ('note', 'want')},
                      ensure_ascii=False, sort_keys=True)


@pytest.mark.parametrize('case', _CORPUS['typeFor'], ids=_label)
def test_shared_corpus_type_for_matches_the_js_tier(case):
    """Every shared case classifies identically here and in `tests/js/device-shapes.test.js`.
    A failure here with the JS tier green means `device_shapes.py` has drifted out of lockstep
    (and vice-versa) — the rules are duplicated by hand, with no build step to share them."""
    placement, item = _args_for(case)
    assert DeviceShapes.type_for(placement, item) == case['want'], case.get('note', '')


@pytest.mark.parametrize('case', _CORPUS['box'], ids=lambda c: c['type'])
def test_shared_corpus_box_matches_the_js_tier(case):
    assert DeviceShapes.box(case['type']) == {'w': case['w'], 'h': case['h']}


@pytest.mark.parametrize('case', _CORPUS['normalize'], ids=_label)
def test_shared_corpus_normalize_matches_the_js_tier(case):
    placement, item = _args_for(case)
    assert DeviceShapes._normalize(placement, item) == case['want'], case.get('note', '')


def test_shared_corpus_is_not_silently_empty():
    """Guard the harness itself: a renamed/moved fixture that parsed to an empty list would make
    every parametrized test above vacuously pass, and the lockstep would quietly stop being
    checked at all."""
    assert len(_CORPUS['typeFor']) > 20
    assert len(_CORPUS['box']) > 10
    assert _CORPUS['normalize']


# ---- the device icon library (DEV-8) ----

def test_library_ids_are_glyph_types_and_rack_stays_unpickable():
    ids = [icon['id'] for group in _LIBRARY for icon in group['icons']]
    assert len(set(ids)) == len(ids)
    assert GLYPH_TYPES == set(ids) | {'rack'}
    assert 'rack' not in ids            # the tool places devices, never racks


def test_library_matches_the_js_side():
    """The library halves of the lockstep pair, checked structurally: every id/paths pair in the
    Python `_LIBRARY` must appear byte-identically in device-shapes.js's `DEVICE_ICON_LIBRARY`
    (path data is compared as exact strings — a re-drawn icon on one side must land on both)."""
    js = (Path(__file__).parent.parent / 'netbox_facilitymap' / 'static'
          / 'netbox_facilitymap' / 'device-shapes.js').read_text('utf-8')
    for group in _LIBRARY:
        for icon in group['icons']:
            assert "id: '%s'" % icon['id'] in js, icon['id']
            for d in icon.get('paths', ()):
                assert "'%s'" % d in js, '%s: path drifted from the JS side: %s' % (icon['id'], d)


def test_type_for_explicit_icon_beats_custom_rules(role_glyphs):
    # The precedence contract: explicit icon > operator role_glyphs > built-in keywords. The
    # corpus covers icon-vs-built-in; the operator vocabulary needs per-test config, so it lives
    # here (the corpus README's scope rule).
    role_glyphs({'switch': ['speaker']})
    assert DeviceShapes.type_for(
        {'kind': 'device', 'icon': 'speaker', 'label': 'Speaker'}) == 'speaker'


def test_builtin_types_never_chip_render_off_their_picker_paths():
    # The invariant that keeps every pre-DEV-8 marker byte-identical: `_chip_paths` refuses the
    # built-in set, so the ap keeps its bespoke puck even though its entry carries picker paths.
    for t in _BUILTIN_GLYPH_TYPES:
        assert DeviceShapes._chip_paths(t) is None, t
    assert DeviceShapes._chip_paths('speaker')


def test_glyph_library_type_is_chip_plus_transformed_paths():
    # A new library type renders exactly like the `_LUCIDE` appliances: body chip + the icon's
    # stroke paths, scaled+centred by a transform — so embeds draw preset icons too.
    g = DeviceShapes.glyph('speaker', 18, 18)
    assert g[0]['tag'] == 'rect' and g[0]['cls'] == 'dev-body'
    icon = g[1:]
    assert len(icon) == len(_LIB_INDEX['speaker']['paths'])
    assert all(p['tag'] == 'path' and 'transform' in p for p in icon)


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

    # Body fills differ by kind, so an embed matches the live map: a rack is always --accent,
    # while a device wears its role's colour (DEV-10) — here the `9e9e9e` grey every DeviceRole
    # is created with, since this role sets none explicitly.
    assert 'fill:#066fd1' in rack_marker['glyph'][0]['style']       # rack cabinet
    assert 'fill:#9e9e9e' in ap_marker['glyph'][0]['style']         # device puck body

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
