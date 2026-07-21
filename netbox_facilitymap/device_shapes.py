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
"""

import re

# The keyword-classification rules, mirroring `DeviceShapes.typeFor`'s regex list one-for-one
# (`static/.../device-shapes.js`) — same patterns (incl. the `\b…\b` word boundaries for the short
# tokens: fw/tor/gw/ap/wap/rpp/nas/san), same order, so a first match wins identically. Kept in
# lockstep: a rule added/edited in the JS must be mirrored here and vice-versa.
_TYPE_RULES = [
    (re.compile(r'fire ?wall|\bfw\b'),                        'firewall'),
    (re.compile(r'patch|panel'),                              'patchpanel'),
    (re.compile(r'switch|leaf|spine|\btor\b'),                'switch'),
    (re.compile(r'rout|gateway|\bgw\b'),                      'router'),
    # No existing keyword is a standalone "ap" token, so this can't shadow or be shadowed by
    # another rule; placed ahead of the broad server/storage catch-alls (host, node, disk, array,
    # filer) so e.g. "Wireless Host Controller" resolves here.
    (re.compile(r'wifi|wireless|access ?point|\bap\b|\bwap\b'), 'ap'),
    (re.compile(r'ups|battery'),                              'ups'),
    (re.compile(r'pdu|outlet|power|\brpp\b|busway'),          'pdu'),
    (re.compile(r'storage|disk|\bnas\b|\bsan\b|array|filer'), 'storage'),
    (re.compile(r'server|host|compute|blade|node|hypervisor|esxi'), 'server'),
]


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
        case-insensitive keyword — so it still classifies when the role is unset (name/label
        fallback) and survives unknown role slugs. Returns one of the keys `box`/`glyph` accept.

        `item` mirrors the JS `item`: a mapping exposing ``role_slug``/``role_name``/``name`` for
        the resolved NetBox object, or ``None`` when the object was deleted/forbidden (then only
        the placement's own label drives the guess, exactly like the JS `item=null` path)."""
        if p.get('kind') == 'rack':
            return 'rack'
        item = item or {}
        hay = ' '.join(
            str(v) for v in (item.get('role_slug'), item.get('role_name'),
                             item.get('name'), p.get('label')) if v
        ).lower()
        for pattern, t in _TYPE_RULES:
            if pattern.search(hay):
                return t
        return 'generic'

    @staticmethod
    def box(type):
        """Default footprint (display px) per type, picked so the shapes read at different sizes
        at a glance: a rack is a tall cabinet, a PDU/switch a thin strip, a UPS a chunky box. A
        rack is the largest object; every unracked device is sized to read as *smaller than a
        rack* (none wider than the rack's 30px). Used when a placement has no user-set w/h."""
        return {
            'rack':       {'w': 30, 'h': 40},
            'switch':     {'w': 30, 'h': 11},
            'router':     {'w': 22, 'h': 16},
            'server':     {'w': 28, 'h': 14},
            'firewall':   {'w': 22, 'h': 17},
            'ap':         {'w': 16, 'h': 16},
            'ups':        {'w': 18, 'h': 26},
            'pdu':        {'w': 26, 'h': 9},
            'storage':    {'w': 24, 'h': 18},
            'patchpanel': {'w': 30, 'h': 13},
            'generic':    {'w': 22, 'h': 15},
        }.get(type, {'w': 22, 'h': 15})

    @staticmethod
    def glyph(type, wpx, hpx):
        """Build a type's glyph as a list of primitive dicts, centered at origin, filling a
        `wpx`×`hpx` box. Each primitive is ``{'tag': 'rect'|'line'|'circle'|'path', <coords as
        strings>, 'cls': 'dev-body'|'dev-line'|'dev-port'|'dev-led'}`` — geometry + semantic class
        only (the caller maps `cls` → inline paint). Mirrors `DeviceShapes.glyph` in the JS."""
        hw, hh = wpx / 2, hpx / 2

        def R(x, y, w, h, c='dev-body'):
            return {'tag': 'rect', 'x': _num(x), 'y': _num(y),
                    'w': _num(w), 'h': _num(h), 'cls': c}

        def L(x1, y1, x2, y2, c='dev-line'):
            return {'tag': 'line', 'x1': _num(x1), 'y1': _num(y1),
                    'x2': _num(x2), 'y2': _num(y2), 'cls': c}

        def C(cx, cy, r, c='dev-line'):
            return {'tag': 'circle', 'cx': _num(cx), 'cy': _num(cy), 'r': _num(r), 'cls': c}

        def P(d, c='dev-line'):
            return {'tag': 'path', 'd': d, 'cls': c}

        def body():
            return R(-hw, -hh, wpx, hpx)

        els = []
        if type == 'rack':                       # plain cabinet box — its name rides inside it
            els.append(body())
        elif type == 'switch':                   # one dense row of ports
            els.append(body())
            n = max(3, int((wpx - 6) // 7))
            gap = (wpx - 6) / n
            pw = min(5, gap - 2)
            for i in range(n):
                els.append(R(-hw + 4 + i * gap, -3, pw, 6, 'dev-port'))
        elif type == 'router':                   # routing crosshair in a ring
            els.append(body())
            r = min(hw, hh) * 0.5
            els += [C(0, 0, r), L(-r, 0, r, 0), L(0, -r, 0, r)]
        elif type == 'server':                   # horizontal bays + status LEDs
            els.append(body())
            for k in (1, 2):
                y = -hh + k * hpx / 3
                els.append(L(-hw + 3, y, hw - 3, y))
            els += [C(-hw + 5, -hh + 4, 1.4, 'dev-led'), C(-hw + 9, -hh + 4, 1.4, 'dev-led')]
        elif type == 'firewall':                 # staggered brick courses
            els.append(body())
            rh = hpx / 3
            for r in (1, 2):
                y = -hh + r * rh
                els.append(L(-hw, y, hw, y))
            for r in range(3):
                y0 = -hh + r * rh
                off = wpx / 4 if (r % 2) else wpx / 2
                x = -hw + off
                while x < hw - 0.5:
                    els.append(L(x, y0, x, y0 + rh))
                    x += wpx / 2
        elif type == 'ap':                        # ceiling-mount puck + concentric broadcast rings;
            # fully radial (not a one-sided cone) so it reads the same at any placement rotation
            r = min(hw, hh)
            els.append(C(0, 0, r * 0.3, 'dev-body'))
            for f in (0.55, 0.8, 1.0):
                els.append(C(0, 0, r * f))
        elif type == 'ups':                       # battery body + terminal + bolt
            els += [body(), R(-4, -hh - 3, 8, 3)]
            els.append(P('M 2 %s L -2 0 L 1 0 L -2 %s' % (_num(-hh * 0.4), _num(hh * 0.4))))
        elif type == 'pdu':                       # power strip: row of outlets
            els.append(body())
            n = max(3, int((wpx - 6) // 9))
            gap = (wpx - 6) / n
            r = min(gap * 0.3, hh * 0.5)
            for i in range(n):
                els.append(C(-hw + 4 + gap * (i + 0.5), 0, r, 'dev-port'))
        elif type == 'storage':                   # stacked disk bays, each with an LED
            bh = hpx / 3
            for i in range(3):
                els.append(R(-hw, -hh + i * bh + 0.5, wpx, bh - 1))
                els.append(C(-hw + 5, -hh + i * bh + bh / 2, 1.6, 'dev-led'))
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
