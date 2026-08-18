'use strict';
/* floor-placements.js — FloorPlacements: the rack/device markers a floor carries, end to end.
   Owns the live NetBox inventory cache behind them, their drawing (glyph + independently
   stylable name label + the rotate/resize handles), their drag/rotate/resize gestures, and the
   two side panels that create, select and remove them — the room's rack inventory list
   (Place-racks sub-mode) and the selected marker's own panel.

   A placement is `{id, kind:'rack'|'device', room, loc, x, y, w?, h?, rot?, label, uid,
   labelStyle?}` in the per-floor placement store, normalized 0..1 over the combined canvas like
   every other shape. It draws only for a room bound to a NetBox Location; a marker whose item is
   absent from the latest sync renders `stale` rather than vanishing. `room` is the polygon the
   marker sits in and stays the drawing/geometry key; the rack panel's *placed-state* is
   Location-scoped instead (`locationRoomIds`), matching the inventory it lists.

   Holds an editor back-ref (`this.ed`), the ImportAlign shape. `selectedPlacement`/`rackRoom`/
   `editingLabel` deliberately stay on FloorEditor — its deselect, handleKey, onPanelClosed,
   _clearTransientState and both render layers all read them. The label de-collide pass is the
   static LabelNudge. */

const MIN_PLACEMENT_PX = 8; // smallest a manually-resized rack/device marker can go (each axis)

//: Auto label defaults for a placement (READ-1). A rack centres its name INSIDE its filled box, so
//: it has a backdrop and needs neither of these; every other device floats its name over the plan
//: raster, where the printed room names live — hence a smaller default and an opaque chip behind
//: the text rather than a halo (a halo lets plan ink bleed through the gaps in the letters).
//: These are the AUTO fallbacks only: a saved `labelStyle.size` always wins, and "Reset to auto"
//: (which deletes `labelStyle`) is what lands a label back here.
const RACK_LABEL_PX = 11;    // a rack's name, on its own box
const DEVICE_LABEL_PX = 9;   // every other marker's name, over the plan — smaller collides less
const CHIP_PAD_X = 3, CHIP_PAD_Y = 1.5;   // chip padding around the text bbox (layout px)

class FloorPlacements {
  constructor(editor) { this.ed = editor; }

  /** Every room id on this floor bound to the same NetBox Location as `room`, `room.id` always
   *  included — the scope the placement panel resolves **placed-state** over (DEV-12).
   *
   *  One physical room is sometimes traced as two polygons bound to one `dcim.Location` (a
   *  supported state; ROOM-9 pins its server-side half). The panel's inventory is already
   *  Location-scoped (`store.racksForLocation`), so scoping placed-state to a single polygon made
   *  a device placed via polygon A read as *unplaced* in polygon B — and slipped past the
   *  duplicate guard, placing it twice. Storage is untouched: a placement still records the
   *  polygon it sits in (`p.room`); only this lookup widens.
   *
   *  Derived from the editor's rooms array, never from a placement's own `p.loc`: `loc` is written
   *  by `placeItem`/`FloorDeviceTool`, but records predating it carry none, and a lookup that
   *  silently misses those is this same bug again. An **unbound** room scopes to itself alone —
   *  two rooms sharing "no Location" share nothing. Per-floor by construction (the caller passes
   *  `data().rooms`), which matches the per-floor placement store. */
  static locationRoomIds(rooms, room) {
    const ids = new Set([room.id]);
    if (!room.location) return ids;
    for (const r of rooms || []) if (r.location && r.location.id === room.location.id) ids.add(r.id);
    return ids;
  }

  /** Live-load inventory for every bound room that has placements on this floor,
   *  so markers render with their real glyphs instead of the stale fallback. Each
   *  Location is fetched once and kept in the in-memory cache; one re-render restyles
   *  the markers when the inventory lands (roadmap §10 risk 3: brief stale flash). */
  async ensureInventory() {
    const pdata = this.ed.store.placementData(this.ed.building.dir, this.ed.floor.id);
    if (!pdata.placements.length) return;
    const roomById = {};
    for (const r of this.ed.data().rooms) roomById[r.id] = r;
    const locIds = new Set();
    for (const p of pdata.placements) {
      const room = roomById[p.room];
      if (room && room.location) locIds.add(room.location.id);
    }
    const pending = [...locIds].filter(id => !this.ed.store.rackCache.locations[id]);
    if (!pending.length) return;
    try {
      await Promise.all(pending.map(id => this.ed.store.ensureRacks(this.ed.netbox, id)));
      if (this.ed.app.current !== this.ed) return;   // navigated away mid-fetch; don't render a torn-down editor
      this.ed.render();
    } catch (e) { Toast.show('NetBox: ' + e.message, true); }
  }

  /** Cached inventory entry for a placement, or null if it's no longer in NetBox. */
  cacheItem(p) {
    const loc = this.ed.store.rackCache.locations[p.loc];
    if (!loc) return null;
    return (p.kind === 'rack' ? loc.racks : loc.devices).find(x => x.id === p.id) || null;
  }

  /** Draw a marker per placement. In racks mode markers are draggable (move
   *  clamped to the room polygon) and the selected one gets rotate + resize
   *  handles; in view mode they are read-only links to NetBox, and only the categories the
   *  toolbar's View filter has checked are drawn. Each marker is a
   *  `translate(center) rotate(rot)` group sized to (normalized) w×h. */
  drawPlacements(s, W, H, skipSelected) {
    const pdata = this.ed.store.placementData(this.ed.building.dir, this.ed.floor.id);
    const roomById = {};
    for (const r of this.ed.data().rooms) roomById[r.id] = r;

    // A marker needs a bound room to draw at all; in VIEW mode it must also pass the toolbar's
    // View category filter (VIEW-2). Edit and the racks sub-mode are exempt — a rack you can't see
    // is a rack you can't move, so editing always shows the lot.
    const filtering = !this.ed.editing();
    const visible = pdata.placements.filter(p => {
      const room = roomById[p.room];
      if (!(room && room.location)) return false;
      return !filtering || this.ed.viewFilter.shows(p);
    });
    // In plain edit the selected room is promoted to the active layer; its markers ride that
    // layer too (drawn in _renderActive), so skip them here to avoid a double-draw and let
    // them repaint per frame during a whole-room drag.
    const activeRoom = (this.ed.editing() && !this.ed.placingRacks) ? this.ed.selected : null;
    // The selected marker renders into the active layer (always on top), so no
    // draw-order sort is needed here; skip it so it isn't drawn twice.
    const labels = [];
    for (const p of visible) {
      if (skipSelected && p === this.ed.selectedPlacement) continue;
      if (activeRoom != null && p.room === activeRoom) continue;
      labels.push(this.drawPlacement(s, p, W, H, roomById));
    }
    // Every marker on the floor is drawn by now, so their names can be pushed apart. Runs over the
    // whole layer (not per room) because adjacent rooms' markers collide across the wall between
    // them just as readily as two in one room.
    LabelNudge.run(labels, this.ed.svg);
  }

  /** Draw the selected room's placement markers into `s` (the active layer, in plain edit).
   *  Mirrors drawPlacements' visibility rule (a placement needs a bound Location); markers are
   *  inert here (see drawPlacement's plain-edit branch). Kept separate so the whole-room drag's
   *  renderActive() repaints them in lockstep with the room. */
  drawRoomPlacements(s, room, W, H) {
    if (!room.location) return;
    const roomById = { [room.id]: room };
    const labels = [];
    for (const p of this.ed.store.placementData(this.ed.building.dir, this.ed.floor.id).placements)
      if (p.room === room.id) labels.push(this.drawPlacement(s, p, W, H, roomById));
    // Same de-collide pass as the static layer, so a promoted room's labels don't re-stack the
    // moment it is selected. Scoped to this room's markers — the rest live in the layer below.
    LabelNudge.run(labels, this.ed.svg);
  }

  /** Draw one placement marker into `s` (glyph + title; draggable with handles in racks
   *  mode, a NetBox link in view mode) plus its label. Shared by the static loop and the
   *  active-layer draw of the selected marker — `.selected`/handles key off
   *  `this.ed.selectedPlacement`, so they light up only for the selected one either way. */
  drawPlacement(s, p, W, H, roomById) {
    // Markers are interactive throughout edit — the "Place racks" sub-mode AND plain edit —
    // so a rack can be grabbed/rotated/resized without entering the sub-mode. In plain edit a
    // marker press falls on the marker (it's drawn above the room fill + vertices), while a
    // press elsewhere still reaches the room polygon beneath; in view it stays a read-only link.
    const draggable = this.ed.editing();
    const room = roomById[p.room];
    const item = this.cacheItem(p);
    const stale = !item;
    const selected = draggable && p === this.ed.selectedPlacement;
    // The glyph type is keyed off the NetBox role (device-name fallback); its size
    // defaults per type unless the user has resized this marker (p.w/p.h).
    const type = DeviceShapes.typeFor(p, item);
    const box = DeviceShapes.box(type);
    const wpx = p.w != null ? p.w * W : box.w;
    const hpx = p.h != null ? p.h * H : box.h;
    const isDevice = p.kind === 'device';
    const g = Dom.svg('g', {
      class: 'rack-marker' + (isDevice ? ' device' : '')
        + (stale ? ' stale' : '') + (selected ? ' selected' : ''),
      transform: `translate(${p.x * W},${p.y * H}) rotate(${p.rot || 0})`,
    });
    // The role picks the marker's colour as well as its shape (DEV-10). It's a per-marker datum,
    // so it rides inline custom properties the `.rack-marker.device` rules read — the same
    // inline-paint route the wayfinding arrows and label colours take, not a generated per-role
    // class. Left unset (stylesheet grey) for a rack, a roleless device, or a stale marker whose
    // NetBox row didn't resolve; `ink` is the server's contrast answer, never recomputed here.
    const role = isDevice && item ? item.role : null;
    if (role && role.color) {
      g.style.setProperty('--role-color', role.color);
      g.style.setProperty('--role-ink', role.ink);
    }
    for (const el of DeviceShapes.glyph(type, wpx, hpx)) g.append(el);
    const title = Dom.svg('title');
    title.textContent = (p.kind === 'rack' ? 'Rack: ' : 'Device: ') + (p.label || '?')
      + (stale ? ' (not in latest sync)' : '');
    g.append(title);

    if (draggable) {
      g.style.cursor = 'grab';
      g.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.ed.selectedPlacement = p; this.ed.editingLabel = null;
        // In plain edit, selecting a rack is exclusive of every other selection (like the
        // room/arrow/note selectors clear the others): dropping `this.ed.selected` un-promotes the
        // room so the render collapses to the racks-mode topology (no active-layer room; the
        // selected marker draws via _renderActive's selected-placement path), and clearing the
        // arrow/note keeps one selection at a time (so e.g. handleKey's Delete is unambiguous).
        // Racks mode keeps its room highlighted (rackRoom).
        if (!this.ed.placingRacks) { this.ed.selected = null; this.ed.selectedArrow = null; this.ed.annotations.endNoteEdit(); }
        this.ed.dragItem = { move: (nx, ny, ev) => {
          let x = nx, y = ny;
          // Snap the centre to the grid (Alt frees it), then keep it in the room.
          if (this.ed.grid.on && !(ev && ev.altKey)) {
            const [iw, ih] = this.ed.dims;
            x = this.ed.grid.snap(x * iw, this.ed.grid.ox) / iw;
            y = this.ed.grid.snap(y * ih, this.ed.grid.oy) / ih;
          }
          const [cx, cy] = Geom.clampToPoly(x, y, room.polygon);
          p.x = +cx.toFixed(5); p.y = +cy.toFixed(5);
          this.ed.markPlacementsDirty(); this.ed.renderActive();
        } };
        this.ed.svg.setPointerCapture(e.pointerId);
        this.ed.render(); this.openPlacementPanel(p, room);   // selection change → full render
      });
      // Hide the marker's move/rotate/resize handles while its label is being edited
      // (the label grows its own handles — two overlapping sets would collide).
      if (selected && this.ed.editingLabel !== p.uid) this._placementHandles(g, s, p, W, H, wpx, hpx);
    } else if (this.ed.copyingLink) {
      // Copy-link tool (view mode): copy this marker's deep-link. Independent of a cached
      // `item.url` — the link resolves from the placement's own kind+id, so it works even for a
      // marker whose live NetBox item hasn't been fetched.
      g.style.cursor = 'copy';
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.ed.pointer.gestureClick()) return;   // pan/pinch tail, not a tap (MOBILE-2)
        this.ed._copyTargetLink(p.kind, p);
      });
    } else if (item && item.url) {
      g.style.cursor = 'pointer';
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.ed.pointer.gestureClick()) return;   // pan/pinch tail, not a tap (MOBILE-2)
        window.open(item.url, '_blank');
      });
    }
    s.append(g);

    // The name rides the shared label engine as a separate, stylable label (drawn
    // on the svg, not the rotated marker group, so it keeps its own rotation). The returned
    // record feeds the caller's `LabelNudge.run` pass, which needs every label drawn first.
    return this._drawPlacementLabel(s, p, hpx, W, H);
  }

  /** Draw a placement's name as an independently movable/stylable label via the shared
   *  Editor label engine. Auto-placed just below the glyph; an optional `labelStyle`
   *  (x/y/rot/size/font/colour/text) overrides. While this placement's label is being
   *  edited it gains move/rotate/resize handles (keyed by the placement uid).
   *
   *  Returns a record for the caller's `LabelNudge.run` pass. `movable` marks a label still sitting
   *  where we put it — no `labelStyle` x/y/rot — so nudging it only refines our own guess and never
   *  overrides a position the user chose. An immovable label still rides along: it can't be pushed,
   *  but the pass routes the others around it. */
  _drawPlacementLabel(s, p, hpx, W, H) {
    const ls = p.labelStyle || {};
    // Racks carry their name centered inside the (filled) box; devices sit it just
    // below the glyph. `inside` only holds at the default position — a moved label
    // (custom x/y) reverts to the haloed style so it stays legible over the plan.
    const inside = p.kind === 'rack' && ls.x == null && ls.y == null;
    const lcx = ls.x != null ? ls.x : p.x;
    const lcy = ls.y != null ? ls.y : (inside ? p.y : p.y + (hpx / 2 + 10) / H);
    const sizePx = ls.size || (p.kind === 'rack' ? RACK_LABEL_PX : DEVICE_LABEL_PX);
    // A device's name floats over the plan raster with nothing behind it, so it gets an opaque
    // chip; a rack's sits on its own filled box and keeps the established treatment.
    const chip = p.kind !== 'rack';
    const t = Dom.svg('text', { class: 'rack-label' + (inside ? ' inside' : '') + (chip ? ' chip' : ''),
      'text-anchor': 'middle', 'dominant-baseline': 'central' });
    t.style.fontSize = sizePx + 'px';
    this.ed.shapes.setLabelLines(t, (ls.text != null ? ls.text : (p.label || '?')).split('\n'));
    const g = this.ed.shapes.attachLabel(s, p, t, lcx, lcy, sizePx, W, H);
    // A rack's `inside` name is bound to its (shrinking) box, so opt it out of the zoomed-out
    // legibility floor — flooring it would overflow the box. A moved rack label drops `.inside`,
    // floats over the plan, and floors like every other label. (`t.parentNode` is the scale group.)
    if (inside) t.parentNode.style.setProperty('--label-floor', '0');
    // Measure ONCE and hand the box to both consumers. `getBBox` forces an SVG layout flush, and
    // these run interleaved with the DOM writes above — so a second read per label would double
    // the thrash on a floor full of markers, and `drawRoomPlacements` repeats this per drag frame.
    const bb = this.ed.shapes.labelBox(t);
    if (chip) this._chipBackdrop(t, bb);
    // An `inside` label is anchored to its rack's own box, so it can never be pushed — but it is
    // still real ink a device's name must not land on, so it rides along as an obstacle.
    return { g, bb, x: lcx * W, y: lcy * H,
             movable: !inside && ls.x == null && ls.y == null && !ls.rot };
  }

  /** Insert an opaque rounded chip behind a label's text, sized to the text's own `bb`. This is
   *  what stops a device name from colliding with the room name printed in the plan underneath:
   *  the halo it replaces only outlines the glyphs, so plan ink still shows through between them.
   *  Inserted before the text within the text's `.label-scale` group (so it paints behind the text
   *  and counter-scales with it); edit handles live on the outer group and still paint on top. */
  _chipBackdrop(t, bb) {
    if (!bb) return;
    // Insert into the text's own parent (the `.label-scale` group) so the chip counter-scales with
    // the text under the legibility floor — the two stay locked at every zoom without a re-measure.
    t.parentNode.insertBefore(Dom.svg('rect', {
      x: +(bb.x - CHIP_PAD_X).toFixed(2), y: +(bb.y - CHIP_PAD_Y).toFixed(2),
      width: +(bb.width + CHIP_PAD_X * 2).toFixed(2),
      height: +(bb.height + CHIP_PAD_Y * 2).toFixed(2),
      rx: 2.5, class: 'label-chip',
    }), t);
  }

  /** Rotate handle (above the top edge) + resize handle (bottom-right corner) for
   *  the selected marker. Both reuse the Editor `dragItem` channel; their geometry
   *  is local to the rotated group, but the math works in display px around the
   *  marker centre so it is rotation-correct. */
  _placementHandles(g, s, p, W, H, wpx, hpx) {
    const ry = -hpx / 2 - 16;
    g.append(Dom.svg('line', { x1: 0, y1: -hpx / 2, x2: 0, y2: ry, class: 'rack-stem' }));
    const rot = Dom.svg('circle', { cx: 0, cy: ry, r: 5, class: 'rack-handle' });
    rot.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.ed.dragItem = { move: (nx, ny, ev) => {
        const dx = (nx - p.x) * W, dy = (ny - p.y) * H;
        let deg = Math.atan2(dy, dx) * 180 / Math.PI + 90;
        if (!(ev && ev.altKey)) deg = Math.round(deg / ANGLE_STEP) * ANGLE_STEP;   // Alt frees rotation
        p.rot = ((Math.round(deg) % 360) + 360) % 360;
        this.ed.markPlacementsDirty(); this.ed.renderActive();
      } };
      this.ed.svg.setPointerCapture(e.pointerId);
    });
    g.append(rot);

    const size = Dom.svg('rect', { x: wpx / 2 - 4, y: hpx / 2 - 4, width: 8, height: 8, class: 'rack-handle' });
    size.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const rad = (p.rot || 0) * Math.PI / 180, cs = Math.cos(rad), si = Math.sin(rad);
      this.ed.dragItem = { move: (nx, ny, ev) => {
        const ex = (nx - p.x) * W, ey = (ny - p.y) * H;          // pointer rel. to centre (px)
        const lx = ex * cs + ey * si, ly = -ex * si + ey * cs;   // un-rotate into the marker's frame
        let w = Math.max(MIN_PLACEMENT_PX, 2 * Math.abs(lx)) / W;
        let h = Math.max(MIN_PLACEMENT_PX, 2 * Math.abs(ly)) / H;
        // Quantize the footprint to the grid (offset 0 — this snaps a size, not a
        // position); Alt frees it. Floored at MIN_PLACEMENT_PX, not a whole grid cell,
        // so a marker can still shrink well below one cell on a large-step grid.
        if (this.ed.grid.on && !(ev && ev.altKey)) {
          const [iw, ih] = this.ed.dims;
          w = Math.max(MIN_PLACEMENT_PX, this.ed.grid.snap(w * iw, 0)) / iw;
          h = Math.max(MIN_PLACEMENT_PX, this.ed.grid.snap(h * ih, 0)) / ih;
        }
        p.w = +w.toFixed(5); p.h = +h.toFixed(5);
        this.ed.markPlacementsDirty(); this.ed.renderActive();
      } };
      this.ed.svg.setPointerCapture(e.pointerId);
    });
    g.append(size);
  }

  /** List the room's synced racks + unracked devices; click a row to place it
   *  (or remove an already-placed one). Both halves are scoped to the bound **Location** — the
   *  inventory by `racksForLocation`, the placed-state by `locationRoomIds` — so the two agree
   *  even when the room is traced as several polygons (DEV-12). */
  openRackPanel(room) {
    // Placing racks is nested in edit, so the room being configured stays the selected
    // (highlighted) room — keeping the toggle-on "keep the room selected" behaviour.
    this.ed.selected = room.id;
    const panel = Dom.$('#panel'); panel.classList.remove('hidden');
    Dom.$('#panel-title').textContent = room.label || 'Racks';
    const body = Dom.$('#panel-body'); body.innerHTML = '';

    if (!room.location) {
      body.append(Dom.el('div', { class: 'hint' }, 'Bind this room to a NetBox Location (in Edit mode) before placing racks.'));
      return;
    }

    const refreshBtn = Dom.el('button', { class: 'wide',
      title: "Pull this room's racks & devices from NetBox" });
    refreshBtn.innerHTML = Icons.rack + '<span>Refresh from NetBox</span>';
    refreshBtn.onclick = async () => {
      const restore = refreshBtn.innerHTML;
      refreshBtn.disabled = true; refreshBtn.innerHTML = '<span>Refreshing…</span>';
      try {
        const inv = await this.ed.store.ensureRacks(this.ed.netbox, room.location.id, true);
        Toast.show('Refreshed ' + (room.label || room.location.name)
          + ' · ' + inv.racks.length + ' racks · ' + inv.devices.length + ' devices');
        this.ed.render();             // restyle stale markers against the fresh inventory
        this.openRackPanel(room);  // re-render the list with fresh inventory
      } catch (e) {
        Toast.show('Refresh failed: ' + e.message, true);
        refreshBtn.disabled = false; refreshBtn.innerHTML = restore;
      }
    };
    body.append(refreshBtn);

    // First open of a room fetches its inventory live; re-render the panel when it
    // lands so the lists populate without a manual Refresh click.
    if (!this.ed.store.rackCache.locations[room.location.id]) {
      body.append(Dom.el('div', { class: 'hint' }, 'Loading racks & devices from NetBox…'));
      this.ed.store.ensureRacks(this.ed.netbox, room.location.id)
        .then(() => { this.ed.render(); if (this.ed.rackRoom === room) this.openRackPanel(room); })
        .catch(e => Toast.show('NetBox: ' + e.message, true));
      return;
    }

    const inv = this.ed.store.racksForLocation(room.location.id);
    const pdata = this.ed.store.placementData(this.ed.building.dir, this.ed.floor.id);
    // Placed-state spans every polygon on this Location, matching the Location-scoped inventory
    // above — a device placed via a sibling polygon of the same room is placed, not missing.
    const scope = FloorPlacements.locationRoomIds(this.ed.data().rooms, room);
    const mine = () => pdata.placements.filter(p => scope.has(p.room));
    const placedKey = new Set(mine().map(p => p.kind + ':' + p.id));

    // Inventory has loaded by now (the not-yet-fetched case returned early above), so an empty
    // inv is genuinely empty. Gear is often modeled at the Site/Rack level, not the room
    // Location, so an honest empty-state beats two silent "None." sections reading as broken.
    if (!inv.racks.length && !inv.devices.length) {
      body.append(Dom.el('div', { class: 'hint' },
        'No racks or devices are assigned to this Location in NetBox — gear is often modeled at '
        + 'the Site or Rack level instead. Assign it here, then Refresh.'));
      // Turn the dead-end empty state into a diagnostic: ask NetBox where this room's gear
      // actually lives (an ancestor Location or the Site) and, if found, show how to reassign it.
      const diag = Dom.el('div', { class: 'hint' }, 'Checking nearby Locations…');
      body.append(diag);
      this.ed.netbox.placementNearby(room.location.id)
        .then(res => { if (this.ed.rackRoom === room) this._renderNearbyDiagnostic(diag, res.nearby); })
        .catch(() => diag.remove());   // degrade quietly — the honest empty hint above still stands
      this._appendStalePlacements(body, room, mine);
      return;
    }

    body.append(Dom.el('div', { class: 'hint' },
      'Click an item to drop it in the room, then drag to place. Click a placed (✓) item to '
      + 'select it, then drag to move it or edit its label. Use ✕ to remove it.'));

    // The marker a placed row acts on. Prefers THIS polygon's own marker over a sibling's, which
    // only bites on duplicates predating the Location-scoped guard in `placeItem` (both can exist
    // there): the row then stays on the marker the user is looking at, and repeat ✕ clears the
    // duplicate. With the guard fixed there is exactly one hit.
    const pick = (kind, id) => {
      const hits = mine().filter(p => p.kind === kind && p.id === id);
      return hits.find(p => p.room === room.id) || hits[0];
    };

    const section = (heading, items, kind) => {
      body.append(Dom.el('div', { class: 'field' }, Dom.el('label', {}, heading + ' (' + items.length + ')')));
      if (!items.length) { body.append(Dom.el('div', { class: 'hint' }, 'None.')); return; }
      items.forEach(it => {
        const placed = placedKey.has(kind + ':' + it.id);
        const main = Dom.el('div', { class: 'ri-main' }, [
          Dom.el('div', { class: 'nm' }, it.name + (placed ? '  ✓' : '')),
          Dom.el('div', { class: 'sl' }, kind === 'rack' ? (it.u_height ? it.u_height + 'U rack' : 'rack') : 'device'),
          // Rack description (optional — absent on devices and on stale/unsynced racks).
          kind === 'rack' && it.description ? Dom.el('div', { class: 'sl' }, it.description) : null,
        ]);
        const row = Dom.el('div', { class: 'room-item' + (placed ? ' bound has-remove' : '') }, [main]);
        // A placed row SELECTS its existing marker (never moves/recreates it); a distinct
        // ✕ control removes it, so a row click is no longer destructive. An unplaced row
        // drops a new marker at the room centroid. Both act on the marker wherever it sits —
        // including a sibling polygon of this same room, which is the same room to the user.
        if (placed) {
          row.onclick = () => this.selectPlacement(pick(kind, it.id), room);
          row.append(this._removeButton(() => pick(kind, it.id), room));
        } else {
          row.onclick = () => this.placeItem(room, kind, it);
        }
        body.append(row);
      });
    };
    section('Racks', inv.racks, 'rack');
    section('Unracked devices', inv.devices, 'device');

    this._appendStalePlacements(body, room, mine);
  }

  /** Fill the empty-placement diagnostic (PLACE-2): if gear lives on a nearby Location or the
   *  Site rather than this room's Location, name each such scope with its counts linked into the
   *  matching NetBox list, and tell the user to reassign it here. Empty `nearby` → the room truly
   *  has nothing nearby, so drop the placeholder and let the honest empty hint stand. */
  _renderNearbyDiagnostic(box, nearby) {
    if (!nearby || !nearby.length) { box.remove(); return; }
    box.textContent = '';
    box.append(Dom.el('div', {},
      'Some gear is assigned to nearby Locations. To place it in this room, reassign it to this '
      + "room's Location in NetBox:"));
    const count = (n, noun) => n + ' ' + noun + (n === 1 ? '' : 's');
    nearby.forEach(s => {
      const row = Dom.el('div', { class: 'sl' }, s.name + ': ');
      const links = [];
      if (s.racks) links.push(Dom.el('a', { href: s.racks_url, target: '_blank' }, count(s.racks, 'rack')));
      if (s.devices) links.push(Dom.el('a', { href: s.devices_url, target: '_blank' }, count(s.devices, 'device')));
      links.forEach((a, i) => { if (i) row.append(' · '); row.append(a); });
      box.append(row);
    });
  }

  /** Placed items no longer present in the latest sync — offer removal. Shared by the
   *  empty-state and populated rack-panel paths so stale placements stay visible/removable
   *  even when the Location's live inventory came back empty. `mine` is the caller's
   *  Location-scoped closure, so the list covers every polygon of the room, not just this one. */
  _appendStalePlacements(body, room, mine) {
    const stale = mine().filter(p => !this.cacheItem(p));
    if (!stale.length) return;
    body.append(Dom.el('div', { class: 'field' }, Dom.el('label', {}, 'Placed, not in latest sync (' + stale.length + ')')));
    stale.forEach(p => {
      const main = Dom.el('div', { class: 'ri-main' }, [
        Dom.el('div', { class: 'nm' }, (p.label || '?') + '  ✓'),
        Dom.el('div', { class: 'sl' }, p.kind),
      ]);
      const row = Dom.el('div', { class: 'room-item has-remove' }, [main]);
      row.onclick = () => this.selectPlacement(p, room);
      row.append(this._removeButton(() => p, room));
      body.append(row);
    });
  }

  /** A distinct ✕ remove control for a placed-row: stops the row's select click and
   *  removes the placement resolved lazily (`getP`) at click time, so it stays valid
   *  across the panel rebuilds that place/remove trigger. */
  _removeButton(getP, room) {
    const b = Dom.el('button', { class: 'ri-remove', title: 'Remove from room' }, '✕');
    b.onclick = (e) => { e.stopPropagation(); this.removePlacement(getP(), room); };
    return b;
  }

  /** Drop a marker for a rack/device at the room centroid (clamped inside it). */
  placeItem(room, kind, item) {
    const pdata = this.ed.store.placementData(this.ed.building.dir, this.ed.floor.id);
    // Guarded across every polygon on this Location, not just this one: one item is placed once
    // per room, however many polygons that room is traced as (DEV-12).
    const scope = FloorPlacements.locationRoomIds(this.ed.data().rooms, room);
    if (pdata.placements.some(p => scope.has(p.room) && p.kind === kind && p.id === item.id)) return;
    this.ed.snapshot();
    const [cx, cy] = Geom.clampToPoly(...Geom.centroid(room.polygon), room.polygon);
    const p = { id: item.id, kind, room: room.id, loc: room.location.id,
      x: +cx.toFixed(5), y: +cy.toFixed(5), label: item.name, uid: Util.uid() };
    pdata.placements.push(p);
    this.ed.selectedPlacement = p;   // ready to drag / rotate / resize immediately
    this.ed.markPlacementsDirty(); this.ed.render(); this.openRackPanel(room);
  }

  removePlacement(p, room) {
    if (!p) return;
    this.ed.snapshot();
    const arr = this.ed.store.placementData(this.ed.building.dir, this.ed.floor.id).placements;
    const i = arr.indexOf(p);
    if (i >= 0) arr.splice(i, 1);
    if (this.ed.selectedPlacement === p) this.ed.selectedPlacement = null;
    if (this.ed.editingLabel === p.uid) this.ed.editingLabel = null;
    this.ed.markPlacementsDirty(); this.ed.render();
    // Racks mode returns to the room's inventory list; a plain-edit delete just closes the panel.
    if (this.ed.placingRacks && room) this.openRackPanel(room);
    else this.ed.app.closePanel();
    this.ed._deleteToast('Removed from room');
  }

  /** Select an already-placed marker from the sidebar list (no pointer gesture, so no
   *  dragItem is armed): highlight it + open its panel WITHOUT touching x/y. Clicking a
   *  placed row must select the existing marker, never move or recreate it. */
  selectPlacement(p, room) {
    if (!p) return;
    this.ed.selectedPlacement = p; this.ed.editingLabel = null;
    this.ed.render();
    this.openPlacementPanel(p, room);
  }

  /** Side panel for a selected marker: its identity, an Edit-label entry (shared
   *  label engine), delete, and a way back to the room's inventory list. */
  openPlacementPanel(p, room) {
    const panel = Dom.$('#panel'); panel.classList.remove('hidden');
    Dom.$('#panel-title').textContent = p.label || (p.kind === 'rack' ? 'Rack' : 'Device');
    const body = Dom.$('#panel-body'); body.innerHTML = '';

    const item = this.cacheItem(p);
    const type = DeviceShapes.typeFor(p, item);
    body.append(Dom.el('div', { class: 'field' }, [
      Dom.el('label', {}, p.kind === 'rack' ? 'Rack' : 'Device'),
      Dom.el('div', { class: 'val' }, (p.label || '?') + ' · ' + type + (item ? '' : ' (not in latest sync)')),
      // Rack description (optional — racks only, absent on stale/unsynced items).
      p.kind === 'rack' && item && item.description ? Dom.el('div', { class: 'sl' }, item.description) : null,
      item && item.url ? Dom.el('div', {}, Dom.el('a', { href: item.url, target: '_blank' }, 'open in NetBox ↗')) : null,
    ]));

    body.append(Dom.el('div', { class: 'hint' },
      'Drag to move (snaps to grid) · top handle rotates (' + ANGLE_STEP
      + '°) · corner resizes · Alt bypasses snapping.'));

    body.append(Dom.el('button', { class: 'wide', title: 'Style, resize, or reposition this label', onclick: () => this.editLabel(p, room),
      html: Icons.edit + '<span>Edit label</span>' }));
    body.append(Dom.el('div', { class: 'row' }, [
      Dom.el('button', { class: 'danger', onclick: () => this.removePlacement(p, room) }, 'Delete'),
      // "Back to list" returns to the room's rack inventory — a racks-sub-mode concept. In
      // plain edit there is no list to return to, so the marker is deselected instead.
      this.ed.placingRacks
        ? Dom.el('button', { onclick: () => { this.ed.selectedPlacement = null; this.ed.render(); this.openRackPanel(room); } }, 'Back to list')
        : Dom.el('button', { onclick: () => this.ed.deselect() }, 'Done'),
    ]));
  }

  /** Enter label-edit for a placement: reuse the shared label engine keyed by the
   *  placement uid (lazily back-filled for records that predate it). Done returns to
   *  the marker's panel. */
  editLabel(p, room) {
    p.uid = p.uid || Util.uid();
    this.ed.selectedPlacement = p; this.ed.editingLabel = p.uid;
    this.ed.render();
    this.ed.shapes.openLabelPanel(p, () => this.ed._exitLabelEdit(() => this.openPlacementPanel(p, room)),
      p.label || '?');
  }

  /** The shared Escape label-edit rung (`Editor._exitLabelEdit`) aimed at the selected marker's own
   *  panel. Both marker ladders — plain edit and Place-racks — back out to the same place, so they
   *  call this rather than each spelling the lookup out. */
  exitLabelEditToPlacement() {
    const p = this.ed.selectedPlacement;
    const room = p && this.ed.data().rooms.find(r => r.id === p.room);
    return this.ed._exitLabelEdit(() => { if (p && room) this.openPlacementPanel(p, room); });
  }
}
