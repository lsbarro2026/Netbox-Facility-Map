'use strict';
/* label-nudge.js — LabelNudge: the anti-overlap pass that pushes auto-placed map labels apart
   (READ-1, widened in READ-5). Static-only, like ImportPreview: it holds no state between calls
   and reaches nothing on the editor — it is handed the drawn labels and the svg they live on.

   Its one consumer is FloorPlacements (the rack/device marker labels), called once per drawn
   layer; the collision index is local to a call, so the static and active layers never see each
   other's boxes. */

//: The anti-overlap nudge (READ-1, widened in READ-5). There is no general label-placement engine:
//: every label draws at its anchor, so a room dense with APs stacks their names on top of each
//: other. `run` is a deliberately small greedy pass over a candidate lattice — the anchor,
//: then whole rows below/above it, then whole columns beside it — taking the first clear slot.
//: The lattice steps by the label's OWN box, not a fixed pixel crawl, so every candidate is a
//: genuinely distinct slot: the ±24px/2px-step ladder this replaced could seat only ~3 labels at
//: one anchor (a 14px-tall label), which silently stacked the 4th AP onward. Rows are tried before
//: columns so a name stays under its own glyph whenever that is possible, and both counts bound how
//: far a label may drift from the glyph it names; a label with nowhere to go in the whole lattice
//: stays at its anchor (overlapping is better than pointing at the wrong marker).
const LABEL_NUDGE_ROWS = 3;   // rows tried each way, stepped by the label's height
const LABEL_NUDGE_COLS = 1;   // columns tried each way, stepped by the label's width
const LABEL_NUDGE_PAD = 1;    // px of clear air kept between two labels
// Uniform-grid cell for the collision index (layout px, several label-widths). A settled label is
// only ever tested against boxes in the cells it actually spans, so the pass costs local density
// rather than total floor size — the flat list it replaced made a 2400-label floor a 49ms render
// (1200 labels: 9.9ms → 2.4ms; 2400: 49ms → 7.4ms). The index is a deliberate trade, not a free
// win: below ~700 labels the flat scan was marginally cheaper (600 labels: 0.3ms → 1.1ms, the
// Map lookups themselves), which is far below one frame and well under the per-label `getBBox`
// flush in the same render. Sized so a label spans one or two cells.
const LABEL_NUDGE_CELL = 128;
// Cell-key stride. The index keys cells arithmetically (`col * SPAN + row`) rather than by a
// `"col,row"` string: the key is built once per candidate slot per label, and string building cost
// more than the Map lookup it fed. Injective for any floor under half a span of cells on a side —
// orders of magnitude beyond a plan raster.
const LABEL_NUDGE_KEY_SPAN = 65536;

class LabelNudge {
  /** Push auto-placed labels apart so a room dense with APs doesn't stack their names on top of
   *  each other. Greedy and order-dependent by design: each label in draw order takes the first
   *  free slot in the lattice around its anchor (`_findLabelSlot`), and becomes an obstacle for
   *  the rest via the collision index.
   *
   *  This is a **render-time layout pass, not an edit**: it rewrites the group's transform and
   *  never touches `labelStyle`, so it cannot dirty the placement store, can't desync its
   *  optimistic-concurrency version, and can't leak into the normalized-0..1 geometry. A label the
   *  user has positioned (`movable` false) is an immovable obstacle — the others move around it.
   *
   *  `svg` is the layer the labels were drawn into; it is read only for the zoomed-out cull below. */
  static run(labels, svg) {
    // Every floating label is hidden while the zoomed-out cull is on (`.labels-lod`, READ-2), so
    // there is nothing to de-collide and `getBBox` reads no geometry anyway. `Editor._applyLabelLod`
    // re-renders when the cull clears, which is what makes skipping here safe.
    if (svg && svg.classList.contains('labels-lod')) return;
    const index = new Map();
    for (const L of labels) {
      if (!L.bb) continue;   // unmeasurable (empty label / hidden svg) — nothing to place
      const box = { x: L.x + L.bb.x - LABEL_NUDGE_PAD, y: L.y + L.bb.y - LABEL_NUDGE_PAD,
                    w: L.bb.width + LABEL_NUDGE_PAD * 2, h: L.bb.height + LABEL_NUDGE_PAD * 2 };
      if (!L.movable) { LabelNudge._indexBox(index, box); continue; }
      // Nowhere clear in the whole lattice: leave it at its anchor. A label flung far from its
      // glyph reads as naming a *different* marker, which is worse than an overlap. `null` says
      // so explicitly — the old `find(…) || 0` couldn't tell that from a fit at the anchor.
      const slot = LabelNudge._findLabelSlot(box, index);
      const { dx, dy } = slot || { dx: 0, dy: 0 };
      if (dx || dy) L.g.setAttribute('transform', `translate(${L.x + dx},${L.y + dy})`);
      LabelNudge._indexBox(index, { ...box, x: box.x + dx, y: box.y + dy });
    }
  }

  /** First clear slot for `box` against the settled boxes in `index`, as `{dx,dy}` in layout px,
   *  or **null** when the whole lattice is occupied (the caller's leave-it-at-the-anchor case).
   *
   *  Candidates are ordered by how well they keep the label reading as *this* marker's name: the
   *  anchor, then rows below/above stepped by the label's own height, then — only once the vertical
   *  ladder is full — the same ladder shifted a label-width to either side. Stepping by the box
   *  itself is what makes each candidate a distinct seat rather than a re-test of the same overlap. */
  static _findLabelSlot(box, index) {
    const rows = [0];
    for (let k = 1; k <= LABEL_NUDGE_ROWS; k++) rows.push(k * box.h, -k * box.h);   // below, then above
    for (let j = 0; j <= LABEL_NUDGE_COLS; j++) {
      const cols = j === 0 ? [0] : [j * box.w, -j * box.w];
      for (const dy of rows)
        for (const dx of cols)
          if (!LabelNudge._boxCollides(index, box, dx, dy)) return { dx, dy };
    }
    return null;
  }

  /** Add a settled label box to the uniform-grid collision index (a `Map` of cell key → boxes),
   *  under every cell it spans. Paired with `_boxCollides`; the two exist so a label is only ever
   *  compared with its neighbours instead of every box on the floor (READ-5). */
  static _indexBox(index, box) {
    const c1 = Math.floor((box.x + box.w) / LABEL_NUDGE_CELL), r1 = Math.floor((box.y + box.h) / LABEL_NUDGE_CELL);
    for (let c = Math.floor(box.x / LABEL_NUDGE_CELL); c <= c1; c++)
      for (let r = Math.floor(box.y / LABEL_NUDGE_CELL); r <= r1; r++) {
        const key = c * LABEL_NUDGE_KEY_SPAN + r;
        const cell = index.get(key);
        if (cell) cell.push(box); else index.set(key, [box]);
      }
  }

  /** Does `box`, shifted by `dx`/`dy`, overlap any settled box in `index`? Only the cells it spans
   *  are consulted, and the scan returns at the first hit. This is the hot path of the whole pass —
   *  one call per candidate slot per label — which is why it carries its own copy of the cell-range
   *  arithmetic instead of sharing a walker with `_indexBox`: a callback allocated a closure per
   *  candidate and cost more than the lookup it wrapped. For the same reason it neither allocates a
   *  hit list nor de-duplicates a box listed under several cells; seeing one twice merely re-runs a
   *  cheap AABB test that already returned false. */
  static _boxCollides(index, box, dx, dy) {
    const x = box.x + dx, y = box.y + dy;
    const c1 = Math.floor((x + box.w) / LABEL_NUDGE_CELL), r1 = Math.floor((y + box.h) / LABEL_NUDGE_CELL);
    for (let c = Math.floor(x / LABEL_NUDGE_CELL); c <= c1; c++)
      for (let r = Math.floor(y / LABEL_NUDGE_CELL); r <= r1; r++) {
        const cell = index.get(c * LABEL_NUDGE_KEY_SPAN + r);
        if (cell) for (const b of cell) if (LabelNudge._boxesOverlap(b, box, dx, dy)) return true;
      }
    return false;
  }

  /** Axis-aligned overlap test between a settled label box `a` and candidate box `b` shifted by
   *  `dx`/`dy`. Touching edges don't count as overlapping (the boxes already carry their padding). */
  static _boxesOverlap(a, b, dx = 0, dy = 0) {
    const bx = b.x + dx, by = b.y + dy;
    return a.x < bx + b.w && bx < a.x + a.w && a.y < by + b.h && by < a.y + a.h;
  }
}
