'use strict';
/* device-shapes.js — DeviceShapes: schematic, instantly-recognizable glyphs for the
   rack/device markers placed inside rooms. Pure static (no instances, no
   state), in the spirit of Icons/Geom in lib.js; depends only on Dom.svg.

   LOCKSTEP with the server-side port `netbox_facilitymap/device_shapes.py`, which draws these
   same glyphs into the NetBox-page embeds/exports (there is no build step, so the logic is
   duplicated, not shared). The keyword rules (typeFor), per-type footprints (box) and glyph
   geometry (glyph) must stay identical in both files, or an embed and the live map disagree —
   a change here must be mirrored there and vice-versa.

   Every glyph is drawn CENTERED AT THE ORIGIN and sized to a wpx×hpx box — the marker
   <g> in FloorEditor._drawPlacement already carries `translate(centre) rotate(rot)`, so
   shapes need no transform of their own. Primitives are classed (`dev-body` body,
   `dev-line` rails/dividers, `dev-port` ports/outlets, `dev-led` indicator dots) so
   style.css owns the paint and the non-scaling-stroke (zoom-constant) behaviour. */

class DeviceShapes {
  /** Resolve a placement to a glyph type. Racks are always 'rack'; a device is keyed
   *  off its NetBox role (slug/name), then its own name, by case-insensitive keyword —
   *  so it still works when roles are unset (name fallback) and survives unknown role
   *  slugs. Returns one of the keys in `box()`/`glyph()`. */
  static typeFor(p, item) {
    if (p.kind === 'rack') return 'rack';
    const role = (item && item.role) || {};
    const hay = [role.slug, role.name, item && item.name, p.label]
      .filter(Boolean).join(' ').toLowerCase();
    const rules = [
      [/fire ?wall|\bfw\b/,            'firewall'],
      [/patch|panel/,                  'patchpanel'],
      [/switch|leaf|spine|\btor\b/,    'switch'],
      [/rout|gateway|\bgw\b/,          'router'],
      // No existing keyword is a standalone "ap" token, so this can't shadow or be
      // shadowed by another rule; placed ahead of the broad server/storage catch-alls
      // (host, node, disk, array, filer) so e.g. "Wireless Host Controller" resolves here.
      [/wifi|wireless|access ?point|\bap\b|\bwap\b/, 'ap'],
      [/ups|battery/,                  'ups'],
      [/pdu|outlet|power|\brpp\b|busway/, 'pdu'],
      [/storage|disk|\bnas\b|\bsan\b|array|filer/, 'storage'],
      [/server|host|compute|blade|node|hypervisor|esxi/, 'server'],
    ];
    for (const [re, t] of rules) if (re.test(hay)) return t;
    return 'generic';
  }

  /** Default footprint (display px) per type, picked so the shapes read at different
   *  sizes at a glance: a rack is a tall cabinet, a PDU/switch a thin strip, a UPS a
   *  chunky box. A rack is the largest object (a full cabinet); every unracked device
   *  is sized to read as *smaller than a rack* — none is wider than the rack's 30px, so
   *  a lone outlet/switch never out-sizes a cabinet. Used when a placement has no
   *  user-set w/h. */
  static box(type) {
    return ({
      rack:       { w: 30, h: 40 },
      switch:     { w: 30, h: 11 },
      router:     { w: 22, h: 16 },
      server:     { w: 28, h: 14 },
      firewall:   { w: 22, h: 17 },
      ap:         { w: 16, h: 16 },
      ups:        { w: 18, h: 26 },
      pdu:        { w: 26, h: 9 },
      storage:    { w: 24, h: 18 },
      patchpanel: { w: 30, h: 13 },
      generic:    { w: 22, h: 15 },
    })[type] || { w: 22, h: 15 };
  }

  /** Build the glyph for a type as an array of SVG children, centered at origin and
   *  filling a wpx×hpx box. Caller appends them to the (already transformed) marker. */
  static glyph(type, wpx, hpx) {
    const hw = wpx / 2, hh = hpx / 2;
    const R = (x, y, w, h, c = 'dev-body') => Dom.svg('rect', { x, y, width: w, height: h, rx: 2, class: c });
    const L = (x1, y1, x2, y2, c = 'dev-line') => Dom.svg('line', { x1, y1, x2, y2, class: c });
    const C = (cx, cy, r, c = 'dev-line') => Dom.svg('circle', { cx, cy, r, class: c });
    const P = (d, c = 'dev-line') => Dom.svg('path', { d, fill: 'none', class: c });
    const body = () => R(-hw, -hh, wpx, hpx);
    const els = [];

    switch (type) {
      case 'rack': {                       // plain cabinet box — its name rides inside it
        els.push(body());
        break;
      }
      case 'switch': {                     // one dense row of ports
        els.push(body());
        const n = Math.max(3, Math.floor((wpx - 6) / 7)), gap = (wpx - 6) / n, pw = Math.min(5, gap - 2);
        for (let i = 0; i < n; i++) els.push(R(-hw + 4 + i * gap, -3, pw, 6, 'dev-port'));
        break;
      }
      case 'router': {                     // routing crosshair in a ring
        els.push(body());
        const r = Math.min(hw, hh) * 0.5;
        els.push(C(0, 0, r), L(-r, 0, r, 0), L(0, -r, 0, r));
        break;
      }
      case 'server': {                     // horizontal bays + status LEDs
        els.push(body());
        for (let k = 1; k <= 2; k++) { const y = -hh + k * hpx / 3; els.push(L(-hw + 3, y, hw - 3, y)); }
        els.push(C(-hw + 5, -hh + 4, 1.4, 'dev-led'), C(-hw + 9, -hh + 4, 1.4, 'dev-led'));
        break;
      }
      case 'firewall': {                   // staggered brick courses
        els.push(body());
        const rh = hpx / 3;
        for (let r = 1; r <= 2; r++) { const y = -hh + r * rh; els.push(L(-hw, y, hw, y)); }
        for (let r = 0; r < 3; r++) {
          const y0 = -hh + r * rh, off = (r % 2) ? wpx / 4 : wpx / 2;
          for (let x = -hw + off; x < hw - 0.5; x += wpx / 2) els.push(L(x, y0, x, y0 + rh));
        }
        break;
      }
      case 'ap': {                         // ceiling-mount puck + concentric broadcast rings;
                                            // fully radial (not a one-sided cone) so it reads
                                            // the same at any placement rotation
        const r = Math.min(hw, hh);
        els.push(C(0, 0, r * 0.3, 'dev-body'));
        for (const f of [0.55, 0.8, 1.0]) els.push(C(0, 0, r * f));
        break;
      }
      case 'ups': {                        // battery body + terminal + bolt
        els.push(body(), R(-4, -hh - 3, 8, 3));
        els.push(P(`M 2 ${(-hh * 0.4).toFixed(1)} L -2 0 L 1 0 L -2 ${(hh * 0.4).toFixed(1)}`));
        break;
      }
      case 'pdu': {                        // power strip: row of outlets
        els.push(body());
        const n = Math.max(3, Math.floor((wpx - 6) / 9)), gap = (wpx - 6) / n, r = Math.min(gap * 0.3, hh * 0.5);
        for (let i = 0; i < n; i++) els.push(C(-hw + 4 + gap * (i + 0.5), 0, r, 'dev-port'));
        break;
      }
      case 'storage': {                    // stacked disk bays, each with an LED
        const bh = hpx / 3;
        for (let i = 0; i < 3; i++) {
          els.push(R(-hw, -hh + i * bh + 0.5, wpx, bh - 1));
          els.push(C(-hw + 5, -hh + i * bh + bh / 2, 1.6, 'dev-led'));
        }
        break;
      }
      case 'patchpanel': {                 // two dense rows of ports
        els.push(body());
        const n = Math.max(6, Math.floor((wpx - 6) / 6)), gap = (wpx - 6) / n, pw = Math.min(4, gap - 1);
        for (const y of [-hh + 3, hh - 6]) for (let i = 0; i < n; i++) els.push(R(-hw + 4 + i * gap, y, pw, 3, 'dev-port'));
        break;
      }
      default:                             // generic device: a box with a centre dot
        els.push(body(), C(0, 0, 1.6, 'dev-port'));
    }
    return els;
  }
}
