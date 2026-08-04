'use strict';
/* floor-todo-add.js — FloorTodoAdd: the per-room hover "+" that opens the floor to-do panel's
   composer pre-filled for that room (TASK-4, redesigned in UX-5). The map-side companion to
   FloorTodo (the panel itself) — it owns the hover wiring, the placement rule that decides where
   the icon goes inside a room, and the glyph it draws into the active layer.

   Holds an editor back-ref (`this.ed`), the ImportAlign shape. The hovered room is private state
   here: it is transient view-mode chrome with no stored position, and it must never mark the
   document dirty (architecture §10 *To-do*). */

//: The per-room hover "add a to-do" button (TASK-4; redesigned in UX-5). Sizes are **layout px** —
//: the same space `_drawPlacement` measures rack boxes in — so the icon is sized against racks
//: directly. The icon takes `TODO_ADD_REST` where the room affords it and shrinks toward
//: `TODO_ADD_MIN` where it doesn't; a room that cannot host even that gets no icon at all.
const TODO_ADD_REST = 18;    // resting diameter, where the room has room for it
const TODO_ADD_MIN = 12;     // below this it stops reading as a button — show none instead
const TODO_ADD_PAD = 3;      // clearance kept between the icon and a wall or a rack
const TODO_ADD_LATTICE = 24; // search grid over the room bbox, per axis (constant cost)
//: How much roomier than it strictly needs a spot must be to win the corner anchor. Without this
//: bar the corner-most *fitting* point wins, which on an L-shape or a corridor is a thin nook the
//: icon technically fits but visibly jams into; gated, those lose and the icon stays where the
//: room is actually open. Capped by the room's own best clearance, so a tight room still places.
const TODO_ADD_COMFORT = 1.6;
const TODO_ADD_DESIGN = 24;  // the glyph's own design grid (Lucide's); CSS scales it to the fit
//: Whether the device has a real hovering pointer. Held as the live MediaQueryList (its `.matches`
//: tracks a hybrid device that gains/loses a mouse) rather than re-running the query for each of a
//: floor's 60+ rooms on every render.
const TODO_ADD_HOVER_MQ = matchMedia('(hover: hover)');

class FloorTodoAdd {
  constructor(editor) {
    this.ed = editor;
    this.hoverRoom = null;   // room the "+" is showing for; view-mode hover chrome only
  }

  /** Drop the hover. The rooms are about to be rebuilt, so the hovered one's polygon is a dead
   *  element and no `pointerleave` will ever arrive for it. */
  clearHover() { this.hoverRoom = null; }

  /** Whether `room` may show the hover "+": drawn AND assigned (an unbound scribble isn't a place
   *  you'd track work against — the same rule `FloorTodo` filters its room list by), view mode
   *  only, and only where there is a panel to open into. Suppressed in the chrome-free embed
   *  (`this.ed.todo` is null there) and while the copy-link tool is armed, whose own click meaning
   *  owns every room. Hover is a **mouse** idiom: on a touch/no-hover device the icon is never
   *  drawn — a tap-to-reveal would hijack the view-mode room tap that opens the NetBox Location —
   *  and the to-do panel's always-visible "+ New" is the path instead (see `FloorTodo._head`). */
  _todoAddEnabled(room, editing) {
    return !editing && !!this.ed.todo && !this.ed.copyingLink
      && !!room.location && (room.polygon || []).length > 0
      && TODO_ADD_HOVER_MQ.matches;
  }

  /** Show the "+" while the cursor is over `room`. The icon draws in the **active layer**, which
   *  view mode otherwise leaves empty, so a hover repaints via the existing cheap `renderActive()`
   *  and never touches the static layer's 60+ rooms. This is transient chrome with no stored
   *  position: it must never mark the document dirty (see §10 *To-do*).
   *
   *  Enter/leave rather than a global pointermove, so the rack-avoidance search below runs **once
   *  per hovered room** instead of per-room per-render. The `relatedTarget` guard is what keeps the
   *  icon from flickering out from under the cursor: the icon lives in a different layer than the
   *  polygon, so moving onto it fires the room's `pointerleave` — that is a hop *into* the icon,
   *  not a real leave. Moving back out of the icon re-fires the room's `pointerenter`, so the icon
   *  needs no leave handler of its own. */
  wireHover(poly, room, editing) {
    if (!this._todoAddEnabled(room, editing)) return;
    poly.addEventListener('pointerenter', () => this._setTodoHover(room));
    poly.addEventListener('pointerleave', (e) => {
      if (e.relatedTarget && this.ed.activeLayer.contains(e.relatedTarget)) return;   // → onto the icon
      this._setTodoHover(null);
    });
  }

  _setTodoHover(room) {
    if ((this.hoverRoom && this.hoverRoom.id) === (room && room.id)) return;
    this.hoverRoom = room;
    this.ed.renderActive();
  }

  /** Every rack/device box in `room` as an axis-aligned rect in layout px. A rotated marker is
   *  tested as the AABB of its rotated corners — conservative (it over-reserves at 45°), which is
   *  the right way to err: the icon keeps clear of a rack it might only have clipped. Mirrors
   *  `_drawPlacement`'s own sizing (per-marker `p.w/p.h`, else the type's default box) so the two
   *  can't drift. The rects are **unpadded**: `_todoAddSpot` applies `TODO_ADD_PAD` once, to walls
   *  and racks alike, so padding here as well would silently double it around racks. */
  _todoRackRects(room, W, H) {
    const rects = [];
    for (const p of this.ed.store.placementData(this.ed.building.dir, this.ed.floor.id).placements) {
      if (p.room !== room.id) continue;
      const box = DeviceShapes.box(DeviceShapes.typeFor(p, this.ed.placements.cacheItem(p)));
      const w = (p.w != null ? p.w * W : box.w), h = (p.h != null ? p.h * H : box.h);
      const rad = (p.rot || 0) * Math.PI / 180;
      const cs = Math.abs(Math.cos(rad)), si = Math.abs(Math.sin(rad));
      const ew = (w * cs + h * si) / 2, eh = (w * si + h * cs) / 2;   // half-extents of the rotated AABB
      rects.push({ x0: p.x * W - ew, x1: p.x * W + ew, y0: p.y * H - eh, y1: p.y * H + eh });
    }
    return rects;
  }

  /** Where the "+" goes for `room`, as `{ x, y, size }` in layout px — **the placement rule**
   *  (§10 *To-do*) — or `null` for a room with nowhere to put it. Deterministic by construction:
   *  same room + same racks always yields the same spot, and it is computed at the **reference
   *  (unzoomed) layout scale**, so the icon never drifts as the user zooms. (The icon *renders*
   *  screen-constant via `--inv-scale`; the two are deliberately decoupled — sizing the search to
   *  the on-screen size would slide the icon around under zoom. The cost is that zoomed far out the
   *  icon's apparent footprint outgrows the one it was placed against and can clip a rack; zoomed
   *  in it only ever gets tighter.)
   *
   *  Walls and racks are one `Geom.clearance` field, and the icon is a **disc**, so
   *  `clearance(p) >= radius` is an exact "the icon fits here, clear of everything" — no separate
   *  corner-in-polygon tests, no box-vs-rack overlap pass.
   *
   *  1. **Size from the room, not a retry ladder.** `Geom.poleOfInaccessibility` returns the
   *     room's most open interior point and, in `r`, how open it is. Too tight for
   *     `TODO_ADD_MIN` → `null`. Otherwise the icon takes `TODO_ADD_REST`, or as much of it as `r`
   *     affords.
   *  2. **Comfort-gated corner anchor.** The floor images print each room's name/number, almost
   *     always dead-centre — exactly where the most open point is — so the icon is pulled to the
   *     room's **top-right**, the side the to-do panel it opens lives on. The anchor is a *target*,
   *     never a position: candidates are the lattice plus the pole itself, only those with
   *     `TODO_ADD_COMFORT` headroom may compete, and the corner-most survivor wins (strict `<`, so
   *     ties keep scan order). On an L whose top-right lies outside the room, the winner is simply
   *     the point in the arm reaching toward it; a *thin* arm fails the comfort bar and the icon
   *     stays where the room is open. The pole always qualifies (`comfort` is capped by `r`), so
   *     the search cannot come up empty and a tight room falls back to it.
   *
   *  Returning `null` — a rack-packed closet, or a room smaller than the icon — is deliberate: the
   *  "+" is a redundant pointer shortcut, and `FloorTodo`'s always-visible, focusable "+ New" is
   *  the path for those rooms, exactly as it already is for every touch user. */
  _todoAddSpot(room, W, H) {
    const poly = room.polygon.map(([x, y]) => [x * W, y * H]);
    const racks = this._todoRackRects(room, W, H);
    const pole = Geom.poleOfInaccessibility(poly, racks);
    if (pole.r < TODO_ADD_MIN / 2 + TODO_ADD_PAD) return null;

    const radius = Math.min(TODO_ADD_REST / 2, pole.r - TODO_ADD_PAD);
    const comfort = Math.min(pole.r, (radius + TODO_ADD_PAD) * TODO_ADD_COMFORT);
    const b = Geom.bounds(poly);
    const toAnchor = (x, y) => Math.hypot(x - b.maxX, y - b.minY);   // the bbox's top-right

    let best = pole, bestD = toAnchor(pole.x, pole.y);
    for (let i = 0; i <= TODO_ADD_LATTICE; i++) {
      for (let j = 0; j <= TODO_ADD_LATTICE; j++) {
        const x = b.minX + (b.w * i) / TODO_ADD_LATTICE, y = b.minY + (b.h * j) / TODO_ADD_LATTICE;
        if (Geom.clearance(x, y, poly, racks) < comfort) continue;
        const d = toAnchor(x, y);
        if (d < bestD) { bestD = d; best = { x, y }; }   // strict <: ties keep the earlier scan order
      }
    }
    return { x: best.x, y: best.y, size: radius * 2 };
  }

  /** Draw the hovered room's "+" into the active layer, as **three nested groups** — each carries
   *  one transform, and they cannot be collapsed:
   *    - outer — the *position*, as a transform **attribute**, plus the fade-in animation (opacity
   *      doesn't collide with the attribute). A CSS `transform` here would clobber the translate:
   *      the property and the attribute are the same property.
   *    - `.todo-add` — `scale(--inv-scale)` (PanZoom.apply), holding a constant on-screen size.
   *    - `.todo-add-glyph` — the fit-to-`spot.size` scale and the grow-on-hover. Separate from the
   *      `--inv-scale` group precisely so its transition can't chase a zoom: zoom moves the
   *      *parent's* transform, leaving this one still.
   *  The glyph is drawn on a fixed `TODO_ADD_DESIGN` grid centred on (0,0) — sizing is `--todo-fit`
   *  alone, so no geometry is recomputed per size and the scale works about the icon's middle.
   *
   *  `aria-hidden` is deliberate, not an oversight: this is a redundant pointer shortcut for the
   *  to-do panel's own "+ New" button, which is always visible and properly focusable. A hover-only
   *  control that can never receive focus has no business in the tab order. */
  draw(s, W, H) {
    const room = this.hoverRoom;
    if (!room || !this._todoAddEnabled(room, this.ed.editing())) return;
    // Re-read the room from the store: a hover held across a live refresh may name a room whose
    // geometry or binding has since changed (or gone).
    const live = this.ed.data().rooms.find(r => r.id === room.id);
    if (!live || !live.location || !(live.polygon || []).length) return;

    const spot = this._todoAddSpot(live, W, H);
    if (!spot) return;   // nowhere it fits — the panel's "+ New" is the path for this room
    const outer = Dom.svg('g', { transform: `translate(${spot.x},${spot.y})`, class: 'todo-add-anchor' });
    const g = Dom.svg('g', { class: 'todo-add', 'aria-hidden': 'true' });
    const glyph = Dom.svg('g', { class: 'todo-add-glyph', style: `--todo-fit:${spot.size / TODO_ADD_DESIGN}` });
    const arm = TODO_ADD_DESIGN * (7 / 24);   // the Lucide plus's 14/24 bar, on its own design grid
    glyph.append(Dom.svg('circle', { cx: 0, cy: 0, r: TODO_ADD_DESIGN / 2, class: 'todo-add-disc' }));
    glyph.append(Dom.svg('line', { x1: -arm, y1: 0, x2: arm, y2: 0, class: 'todo-add-bar' }));
    glyph.append(Dom.svg('line', { x1: 0, y1: -arm, x2: 0, y2: arm, class: 'todo-add-bar' }));
    const title = Dom.svg('title');
    title.textContent = 'Add a to-do for ' + (live.label || live.location.name);
    glyph.append(title);
    // The room beneath opens its NetBox Location on click — this must not reach it.
    g.addEventListener('click', (e) => { e.stopPropagation(); this._openTodoFor(live); });
    g.append(glyph);
    outer.append(g);
    s.append(outer);
  }

  /** Open the to-do panel on `room` — revealing it first if the user has it collapsed, since the
   *  pre-filled composer is useless behind a hidden panel. */
  _openTodoFor(room) {
    if (this.ed._panelCollapsed && this.ed._panelCollapsed()) this.ed._setPanelCollapsed(false);
    this.ed.todo.openComposer(room.id);
  }
}
