"""Server-side port of the frontend `DeviceShapes` glyphs (`static/.../device-shapes.js`).

The native NetBox-page embeds (`template_content.FloorRooms`/`ObjectPlacement` →
`previews.placement_markers` → `inc/placement_markers.html`) draw the same rack/device
markers the live interactive map does. `DeviceShapes` resolves a placement to a glyph type,
a default footprint, and the SVG primitives that make up its schematic glyph — so an access
point shows its broadcast-puck glyph in an embed/export, not an undifferentiated box.

**LOCKSTEP with `static/netbox_facilitymap/device-shapes.js`.** This is a faithful 1:1 mirror
of that class (its `typeFor`/`box`/`glyph`) — the keyword rules, the per-type footprints, and
the glyph geometry must stay identical so an embed and the live map agree. A change to one file
must be made to the other. This mirror carries **geometry + the semantic primitive classes only**
(`dev-body`/`dev-line`/`dev-port`/`dev-led`), exactly like the JS; the server-side paint that maps
those classes to inline styles lives in `previews.placement_markers` (the host page loads no plugin
CSS, so the glyph can't lean on `style.css` the way the frontend does).

Every glyph is drawn **centered at the origin** and sized to a `wpx`×`hpx` box — the marker `<g>`
in the template already carries `translate(centre) rotate(rot)`, so shapes need no transform of
their own. Footprints are in display px, resolution-independent like the frontend (the caller
scales normalized 0..1 placement coords to the combined-canvas `w`×`h`).

The built-in keyword rules are **English**, so a facility that names its device roles in another
language would classify everything as `generic` (INTL-1). `custom_rules` reads the operator's
`PLUGINS_CONFIG role_glyphs` vocabulary and `type_for` tries it **first**, so a French install can
map `commutateur` → `switch` without losing the English defaults. This module is the single place
that validates that setting: `views.MapView` injects `custom_rules()`'s output into
`window.MAP.roleGlyphs` for the JS side, so both halves of the lockstep pair match the same
vocabulary and cannot drift.
"""

import re

# The keyword-classification rules, mirroring `DeviceShapes.typeFor`'s regex list one-for-one
# (`static/.../device-shapes.js`) — same patterns (incl. the `\b…\b` word boundaries for the short
# tokens: fw/tor/gw/asw/ap/wap/rpp/nas/san), same order, so a first match wins identically. Kept in
# lockstep: a rule added/edited in the JS must be mirrored here and vice-versa.
_TYPE_RULES = [
    (re.compile(r'fire ?wall|\bfw\b'),                        'firewall'),
    (re.compile(r'patch|panel'),                              'patchpanel'),
    # Access/edge switch before the generic switch rule so "access switch" wins over the broad
    # `switch` catch-all; can't collide with the `ap` rule (which requires "point").
    (re.compile(r'access ?switch|\basw\b'),                   'accessswitch'),
    (re.compile(r'switch|leaf|spine|\btor\b'),                'switch'),
    (re.compile(r'rout|gateway|\bgw\b'),                      'router'),
    # No existing keyword is a standalone "ap" token, so this can't shadow or be shadowed by
    # another rule; placed ahead of the broad server/storage catch-alls (host, node, disk, array,
    # filer) so e.g. "Wireless Host Controller" resolves here.
    (re.compile(r'wifi|wireless|access ?point|\bap\b|\bwap\b'), 'ap'),
    (re.compile(r'ups|battery'),                              'ups'),
    # Wall outlet/receptacle before pdu, and pdu no longer claims a bare "outlet": a single wall
    # socket reads as `outlet`, a power strip / distribution unit as `pdu`.
    (re.compile(r'wall ?outlet|\boutlet\b|socket|receptacle'), 'outlet'),
    (re.compile(r'pdu|power|\brpp\b|busway'),                 'pdu'),
    (re.compile(r'storage|disk|\bnas\b|\bsan\b|array|filer'), 'storage'),
    (re.compile(r'server|host|compute|blade|node|hypervisor|esxi'), 'server'),
]

# camelCase split (`AccessPoint` → `Access Point`) + separator fold, mirroring JS `_normalize`.
# The camel rule stays deliberately ASCII (a Latin-script naming convention), exactly like the JS.
# The separator fold keeps **unicode** letters/digits and folds everything else (incl. `_`) to a
# single space: it used to be `[^a-z0-9]+`, which deleted every non-ASCII character outright, so a
# Japanese/Greek/Cyrillic role name normalized to the empty string and could never match any rule —
# custom or built-in (INTL-1). `[\W_]` is the Python spelling of the JS `[^\p{L}\p{N}]`.
_CAMEL_RE = re.compile(r'([a-z0-9])([A-Z])')
_SEP_RE = re.compile(r'[\W_]+')

# Every glyph type `box`/`glyph` accept — the allow-list `custom_rules` validates against, so a
# typo'd type in `PLUGINS_CONFIG` is dropped loudly rather than silently drawing nothing.
GLYPH_TYPES = frozenset((
    'rack', 'server', 'router', 'firewall', 'storage', 'ups',
    'switch', 'accessswitch', 'patchpanel', 'pdu', 'outlet', 'ap', 'generic',
))

# Memo for `custom_rules`, as `(setting fingerprint, normalized rules)`. `type_for` runs once per
# placement, so the validation is cached — but keyed on the setting's *value* rather than computed
# once, so a test (or a `settings` override) that swaps `PLUGINS_CONFIG` is picked up instead of
# being served a stale table. The key is the `repr` rather than the object itself: holding the dict
# by reference would compare equal to its own in-place mutation and never invalidate.
# `_UNSET` distinguishes "never computed" from a genuine `None` (Django absent / key unset).
_UNSET = object()
_custom_cache = (_UNSET, ())


def _normalize_keyword(text):
    """Fold an operator-supplied keyword the same way `DeviceShapes._normalize` folds the haystack,
    so the two are directly comparable. Returns '' for a keyword that folds away to nothing (e.g.
    all punctuation), which `custom_rules` then drops."""
    return _SEP_RE.sub(' ', _CAMEL_RE.sub(r'\1 \2', str(text)).lower()).strip()


def custom_rules():
    """The operator's `PLUGINS_CONFIG role_glyphs` vocabulary, validated and normalized to an
    ordered ``[(glyph_type, (keyword, ...)), ...]``.

    The setting maps a glyph type to the keywords that should resolve to it::

        'role_glyphs': {
            'switch':   ['commutateur', 'conmutador'],
            'firewall': ['pare-feu', 'cortafuegos'],
        }

    Keywords are **plain phrases, never regexes** — deliberately. A regex from config would have to
    behave identically in Python's `re` and JS's `RegExp` (the lockstep contract) and would hand an
    operator a ReDoS foot-gun in the render path; a phrase matched whole-word is unambiguous in both
    engines. Matching is whole-word over the normalized haystack (`_matches`), so `ap` never fires
    inside `kneecap`, exactly like the built-in `\\bap\\b` rules.

    Invalid input is dropped, not raised: an unknown glyph type, a non-list value, or a keyword that
    normalizes to nothing is skipped, so a malformed setting degrades to the built-in English rules
    instead of breaking every map render. Insertion order is preserved, so an operator can order
    their own rules against each other the way the built-in list is ordered."""
    global _custom_cache
    try:                                  # lazy import: keeps this module importable without Django
        from netbox.plugins import get_plugin_config
        raw = get_plugin_config('netbox_facilitymap', 'role_glyphs')
    except Exception:                     # no Django, or the key predates this release
        raw = None
    fingerprint = repr(raw)
    cached_raw, cached_rules = _custom_cache
    if cached_raw is not _UNSET and fingerprint == cached_raw:
        return cached_rules
    rules = []
    if isinstance(raw, dict):
        for glyph_type, keywords in raw.items():
            if glyph_type not in GLYPH_TYPES or isinstance(keywords, (str, bytes)):
                continue
            try:
                folded = tuple(k for k in (_normalize_keyword(w) for w in keywords) if k)
            except TypeError:             # not iterable
                continue
            if folded:
                rules.append((glyph_type, folded))
    rules = tuple(rules)
    _custom_cache = (fingerprint, rules)
    return rules


def _num(value):
    """Format a coordinate as a compact, deterministic string (trailing zeros trimmed).

    The JS emits raw numbers; here the primitives carry pre-formatted strings so the Django
    template stays arithmetic-free and the rendered SVG is byte-stable for tests."""
    return ('%.2f' % value).rstrip('0').rstrip('.')


class DeviceShapes:
    """Schematic glyphs for rack/device markers — the Python mirror of the JS `DeviceShapes`.

    Pure static (no instances, no state), in the spirit of the frontend class. `type_for`
    classifies a placement, `box` gives its default footprint, `glyph` builds its primitives.
    """

    @staticmethod
    def type_for(p, item=None):
        """Resolve a placement to a glyph type. Racks are always ``'rack'``; a device is keyed
        off its NetBox role (slug/name), then its own name, then the marker label, by
        case-insensitive keyword over a *normalized* haystack (`_normalize` folds camelCase and
        separators to spaces, so 'AccessPoint'/'access-point'/'ACCESS POINT'/'ap' all resolve
        alike) — still classifies when the role is unset (name/label fallback) and survives
        unknown role slugs. Returns one of the keys `box`/`glyph` accept.

        `item` mirrors the JS `item`: a mapping exposing ``role_slug``/``role_name``/``name`` for
        the resolved NetBox object, or ``None`` when the object was deleted/forbidden (then only
        the placement's own label drives the guess, exactly like the JS `item=null` path).

        The operator's `role_glyphs` keywords (`custom_rules`) are tried **before** the built-in
        English rules, so a facility can name a glyph type in its own language without losing the
        defaults — merge, not replace (INTL-1). An install that sets nothing is byte-identical to
        before."""
        if p.get('kind') == 'rack':
            return 'rack'
        hay = DeviceShapes._normalize(p, item)
        for t, keywords in custom_rules():
            if any(DeviceShapes._matches(hay, k) for k in keywords):
                return t
        for pattern, t in _TYPE_RULES:
            if pattern.search(hay):
                return t
        return 'generic'

    @staticmethod
    def _matches(hay, keyword):
        """Whether an already-normalized `keyword` appears in the normalized `hay` as a whole word
        (or whole phrase). Both sides are runs of unicode letters/digits joined by single spaces, so
        padding each with a space makes plain containment an exact word-boundary test — no regex, and
        therefore no Python/JS dialect divergence in the lockstep pair. Mirrors the JS `_matches`."""
        return (' %s ' % keyword) in (' %s ' % hay)

    @staticmethod
    def _normalize(p, item=None):
        """Normalize the role/name/label haystack for keyword matching, mirroring the JS
        `DeviceShapes._normalize`: join the parts, split camelCase (`AccessPoint` → `Access
        Point`), lowercase, then fold every non-alphanumeric run to a single space. So
        'AccessPoint', 'access-point' and 'ACCESS_POINT' all collapse to 'access point'."""
        item = item or {}
        raw = ' '.join(
            str(v) for v in (item.get('role_slug'), item.get('role_name'),
                             item.get('name'), p.get('label')) if v
        )
        raw = _CAMEL_RE.sub(r'\1 \2', raw).lower()
        return _SEP_RE.sub(' ', raw).strip()

    @staticmethod
    def box(type):
        """Default footprint (display px) per type, sized as one cohesive set (mirrors the JS
        `box`). The **rack is the reference and the largest** (a full cabinet, 30px wide); every
        unracked device is narrower than it. Icon-bearing appliances (server/router/firewall/
        storage/ups) are compact square-ish chips; rack-mount strips (switch/accessswitch/
        patchpanel/pdu) are wide and thin; the wall `outlet` is the smallest slice; `ap` a puck.
        Used when a placement has no user-set w/h."""
        return {
            'rack':         {'w': 30, 'h': 40},
            'server':       {'w': 22, 'h': 18},
            'router':       {'w': 20, 'h': 18},
            'firewall':     {'w': 20, 'h': 18},
            'storage':      {'w': 22, 'h': 18},
            'ups':          {'w': 16, 'h': 20},
            'switch':       {'w': 26, 'h': 10},
            'accessswitch': {'w': 24, 'h': 10},
            'patchpanel':   {'w': 26, 'h': 12},
            'pdu':          {'w': 24, 'h': 8},
            'outlet':       {'w': 12, 'h': 7},
            'ap':           {'w': 16, 'h': 16},
            'generic':      {'w': 22, 'h': 15},
        }.get(type, {'w': 22, 'h': 15})

    # Vendored Lucide icons (path `d` strings on Lucide's 24×24 viewBox) for the appliance types
    # that map cleanly to one — mirror of the JS `_lucide`, and of the SVGs under `icons/`.
    _LUCIDE = {
        'server': ['M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z',
                   'M4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z',
                   'M6 6h.01', 'M6 18h.01'],
        'router': ['M4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z',
                   'M6.01 18H6', 'M10.01 18H10', 'M15 10v4',
                   'M17.84 7.17a4 4 0 0 0-5.66 0', 'M20.66 4.34a8 8 0 0 0-11.31 0'],
        'firewall': ['M12 9v1.258', 'M16 3v5.46',
                     'M21 9.118V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5.75',
                     'M22 17.5c0 2.499-1.75 3.749-3.83 4.474a.5.5 0 0 1-.335-.005c-2.085-.72-3.835-1.97-3.835-4.47V14a.5.5 0 0 1 .5-.499c1 0 2.25-.6 3.12-1.36a.6.6 0 0 1 .76-.001c.875.765 2.12 1.36 3.12 1.36a.5.5 0 0 1 .5.5z',
                     'M3 15h7', 'M3 9h12.142', 'M8 15v6', 'M8 3v6'],
        'storage': ['M10 16h.01',
                    'M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
                    'M21.946 12.013H2.054', 'M6 16h.01'],
        'ups': ['m11 7-3 5h4l-3 5', 'M14.856 6H16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.935',
                'M22 14v-4', 'M5.14 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2.936'],
    }

    @staticmethod
    def glyph(type, wpx, hpx):
        """Build a type's glyph as a list of primitive dicts, centered at origin, filling a
        `wpx`×`hpx` box. Each primitive is ``{'tag': 'rect'|'line'|'circle'|'path', <coords as
        strings>, 'cls': 'dev-body'|'dev-line'|'dev-port'|'dev-led'}`` — geometry + semantic class
        only (the caller maps `cls` → inline paint). An embedded Lucide icon's ``path`` primitives
        also carry a ``'transform'`` (the scale+centre that fits the 24×24 icon into the box);
        `placement_markers` passes it straight through and the template renders it. Mirrors
        `DeviceShapes.glyph` in the JS."""
        hw, hh = wpx / 2, hpx / 2

        def R(x, y, w, h, c='dev-body'):
            return {'tag': 'rect', 'x': _num(x), 'y': _num(y),
                    'w': _num(w), 'h': _num(h), 'cls': c}

        def C(cx, cy, r, c='dev-line'):
            return {'tag': 'circle', 'cx': _num(cx), 'cy': _num(cy), 'r': _num(r), 'cls': c}

        def P(d, c='dev-line', t=None):
            prim = {'tag': 'path', 'd': d, 'cls': c}
            if t:
                prim['transform'] = t
            return prim

        def body():
            return R(-hw, -hh, wpx, hpx)

        # Appliance roles with a clean Lucide match: the body chip + that icon, uniformly scaled
        # to fit the smaller box dimension and centred (Lucide's 24×24 viewBox centre is 12,12).
        icon = DeviceShapes._LUCIDE.get(type)
        if icon:
            s = min(wpx, hpx) * 0.82 / 24
            off = _num(-12 * s)
            tf = 'translate(%s,%s) scale(%s)' % (off, off, _num(s))
            return [body()] + [P(d, 'dev-line', tf) for d in icon]

        els = []
        if type == 'rack':                        # plain cabinet box — its name rides inside it
            els.append(body())
        elif type == 'switch':                    # core/aggregation switch: one dense row of ports
            els.append(body())
            n = max(3, int((wpx - 6) // 7))
            gap = (wpx - 6) / n
            pw = min(5, gap - 2)
            for i in range(n):
                els.append(R(-hw + 4 + i * gap, -3, pw, 6, 'dev-port'))
        elif type == 'accessswitch':              # access/edge switch: dense access-port row + uplink
            els.append(body())
            n = max(4, int((wpx - 6) // 5))
            gap = (wpx - 6) / n
            pw = min(3.5, gap - 1.5)
            for i in range(n):
                els.append(R(-hw + 4 + i * gap, hh - 4.5, pw, 3, 'dev-port'))
            els.append(R(hw - 6, -hh + 2, 4, 2.5, 'dev-port'))   # separated uplink SFP, top-right
        elif type == 'ap':                        # ceiling-mount puck + concentric broadcast rings;
            # fully radial (not a one-sided cone) so it reads the same at any placement rotation
            r = min(hw, hh)
            els.append(C(0, 0, r * 0.3, 'dev-body'))
            for f in (0.55, 0.8, 1.0):
                els.append(C(0, 0, r * f))
        elif type == 'pdu':                       # power strip: row of round outlets
            els.append(body())
            n = max(3, int((wpx - 6) // 9))
            gap = (wpx - 6) / n
            r = min(gap * 0.3, hh * 0.5)
            for i in range(n):
                els.append(C(-hw + 4 + gap * (i + 0.5), 0, r, 'dev-port'))
        elif type == 'outlet':                    # top-down wall receptacle: a thin faceplate + two slots
            els.append(body())
            for x in (-2.2, 2.2):
                els.append(R(x - 0.6, -1.6, 1.2, 3.2, 'dev-port'))
        elif type == 'patchpanel':                # two dense rows of ports
            els.append(body())
            n = max(6, int((wpx - 6) // 6))
            gap = (wpx - 6) / n
            pw = min(4, gap - 1)
            for y in (-hh + 3, hh - 6):
                for i in range(n):
                    els.append(R(-hw + 4 + i * gap, y, pw, 3, 'dev-port'))
        else:                                     # generic device: a box with a centre dot
            els += [body(), C(0, 0, 1.6, 'dev-port')]
        return els
