'use strict';
/* floor-arrange.js — FloorArrange: the multi-sheet floor's sheet arrangement (some floors split a
   single level across several plan sheets, tiled into a grid that shares one normalized coordinate
   space). Owns the Arrange sub-mode end to end — its toolbar toggle, the sheet-grid overlay and
   tile drag, the commit that re-tiles the layout, and the re-projection that keeps every room,
   arrow, note and marker on its own sheet afterwards — plus the per-sheet captions the static
   layer draws outside the sub-mode.

   Holds an editor back-ref (`this.ed`), the ImportAlign shape. `arranging` itself stays on
   FloorEditor: show(), _switchMode, _toggleRacks, _showGrid, both render layers and handleKey all
   gate on it (architecture §10 *Multi-sheet floors*). The in-flight tile drag is private here. */

const CAPTION_INSET_FACTOR = 0.02;   // per-sheet caption padding, as a fraction of the sheet's cell width

class FloorArrange {
  constructor(editor) {
    this.ed = editor;
    this.dragState = null;   // { page, target:[col,row] } during a sheet drag
  }

  /** Drop any in-flight tile drag. Called from FloorEditor.show(), which re-mounts the stage —
   *  including the arrange re-mount a drop itself triggers. */
  reset() { this.dragState = null; }

  /** Toggle Arrange mode (drag sheets into grid cells). Edit-mode, multi-sheet only. */
  button() {
    const b = Dom.el('button', { class: 'icononly' + (this.ed.arranging ? ' active' : ''),
      title: 'Drag sheets to arrange them in a grid', html: Icons.arrange + '<span>Arrange sheets</span>' });
    b.onclick = () => {
      this.ed.arranging = !this.ed.arranging;
      if (this.ed.arranging) {
        // Arrange supersedes rack placement (mutually-exclusive edit sub-modes); clear it
        // before closePanel so onPanelClosed's placing-racks branch stays a no-op.
        this.ed.annotations.endNoteEdit();   // entering arrange ends any in-progress note edit
        this.ed.placingRacks = false; this.ed.rackRoom = null; this.ed.selectedPlacement = null;
        this.ed.selected = null; this.ed.editingLabel = null; this.ed.draft = null;
        this.ed.app.closePanel();
        Toast.show('Drag a sheet to a cell to move it · drop on another to swap · Esc to exit');
      }
      this.ed.show();
    };
    return b;
  }

  /** Caption each sheet of a multi-sheet floor at its cell's top-left (mirrors the
   *  PDF's per-sheet label). Drawn as inert SVG text, so it costs no layout height
   *  and does not shift the shared coordinate space. */
  drawCaptions(s, W, H) {
    const lay = this.ed.layout; if (!lay || lay.cells.length < 2) return;
    const inset = CAPTION_INSET_FACTOR * lay.cellW;
    for (const c of lay.cells) {
      if (!c.caption) continue;
      const t = Dom.svg('text', { x: c.col * lay.cellW + inset, y: c.row * lay.cellH + inset * 1.4,
        'dominant-baseline': 'hanging', class: 'page-caption' });
      t.textContent = c.caption;
      s.append(t);
    }
  }

  // ---- Arrange mode: drag sheets into a grid ----
  /** Draw the sheet grid: cell outlines, a drop-target highlight, and a draggable
   *  tile per sheet. Only the tiles are interactive; the rest of the canvas keeps
   *  panning. */
  draw(s, W, H) {
    const lay = this.ed.layout, { cellW, cellH, cols, rows } = lay;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        s.append(Dom.svg('rect', { x: c * cellW, y: r * cellH, width: cellW, height: cellH, class: 'sheet-grid' }));

    if (this.dragState && this.dragState.target) {
      const [tc, tr] = this.dragState.target;
      s.append(Dom.svg('rect', { x: tc * cellW, y: tr * cellH, width: cellW, height: cellH, class: 'sheet-drop' }));
    }

    for (const cell of lay.cells) {
      const x = cell.col * cellW, y = cell.row * cellH;
      const dragging = this.dragState && this.dragState.page === cell.page;
      const tile = Dom.svg('rect', { x, y, width: cellW, height: cellH, rx: 8,
        class: 'sheet-tile' + (dragging ? ' dragging' : '') });
      tile.addEventListener('pointerdown', (e) => this._startSheetDrag(e, cell));
      s.append(tile);
      const label = Dom.svg('text', { x: x + cellW / 2, y: y + cellH / 2,
        'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'sheet-tile-label' });
      label.textContent = cell.caption || ('Sheet ' + (cell.page + 1));
      label.style.pointerEvents = 'none';
      s.append(label);
    }
  }

  /** Begin dragging a sheet tile; the target cell follows the pointer (clamped one
   *  cell beyond the current grid so you can extend it), and drop commits the move. */
  _startSheetDrag(e, cell) {
    if (e.button !== 0) return;
    e.stopPropagation();
    this.dragState = { page: cell.page, target: [cell.col, cell.row] };
    this.ed.dragSheet = {
      move: (nx, ny) => {
        const lay = this.ed.layout;
        const c = Math.max(0, Math.min(this.ed.baseLayout.cols, Math.floor(nx * lay.W / lay.cellW)));
        const r = Math.max(0, Math.min(this.ed.baseLayout.rows, Math.floor(ny * lay.H / lay.cellH)));
        this.dragState.target = [c, r];
        this.ed.render();
      },
      drop: () => this._commitSheetMove(),
    };
    this.ed.svg.setPointerCapture(e.pointerId);
    this.ed.render();
  }

  /** Place the dragged sheet in the target cell (swap if occupied), trim the grid to
   *  the origin, remap any rooms/racks to follow their sheet, and re-lay-out. */
  _commitSheetMove() {
    const st = this.dragState; this.dragState = null;
    if (!st) { this.ed.render(); return; }
    const oldGeom = this.ed.store.floorLayout(this.ed.building.dir, this.ed.floor.id);
    const cells = oldGeom.cells.map(c => [c.col, c.row]);   // [col,row] per page index
    const from = cells[st.page], [tc, tr] = st.target;
    if (tc === from[0] && tr === from[1]) { this.ed.render(); return; }   // no-op
    const occ = cells.findIndex(([c, r], i) => i !== st.page && c === tc && r === tr);
    if (occ >= 0) cells[occ] = [from[0], from[1]];   // swap
    cells[st.page] = [tc, tr];
    const minC = Math.min(...cells.map(c => c[0])), minR = Math.min(...cells.map(c => c[1]));
    const grid = cells.map(([c, r]) => [c - minC, r - minR]);
    this.ed.snapshot();   // before setLayout + the room/arrow/placement remap
    this.ed.store.setLayout(this.ed.building.dir, this.ed.floor.id, grid);
    this._remapLayout(oldGeom, this.ed.store.floorLayout(this.ed.building.dir, this.ed.floor.id));
    this.ed.show();   // relayout (still arranging → re-padded)
  }

  /** Re-project every room point / placement from the old tiling to the new one so
   *  each shape stays on its own sheet: locate its old cell, take its within-cell
   *  fraction, and map that into the sheet's new cell. Pure arithmetic on the stored
   *  combined-normalized coords — no schema or engine change. */
  _remapLayout(oldG, newG) {
    if (oldG.W === newG.W && oldG.H === newG.H
        && oldG.cells.every((c, i) => c.col === newG.cells[i].col && c.row === newG.cells[i].row)) return;
    const map = (nx, ny) => {
      const px = nx * oldG.W, py = ny * oldG.H;
      const cell = oldG.cells.find(c => px >= c.col * oldG.cellW && px < (c.col + 1) * oldG.cellW
        && py >= c.row * oldG.cellH && py < (c.row + 1) * oldG.cellH) || oldG.cells[0];
      const lx = (px - cell.col * oldG.cellW) / oldG.cellW, ly = (py - cell.row * oldG.cellH) / oldG.cellH;
      const nc = newG.cells[cell.page];
      return [+(((nc.col + lx) * newG.cellW) / newG.W).toFixed(5),
              +(((nc.row + ly) * newG.cellH) / newG.H).toFixed(5)];
    };
    const fdata = this.ed.store.floorData(this.ed.building.dir, this.ed.floor.id);
    const rooms = fdata.rooms;
    for (const room of rooms) {
      room.polygon = room.polygon.map(p => map(p[0], p[1]));
    }
    // Route arrows live in the same combined-normalized space → remap with the rooms
    // so each route stays on its own sheet. Their `room` binding is an id, untouched.
    const arrows = fdata.arrows;
    for (const a of arrows) a.points = a.points.map(p => map(p[0], p[1]));
    // Free-standing notes are floor-space too → remap their anchor (and any dragged
    // label override) so each note stays on its own sheet.
    const notes = fdata.notes || [];
    for (const nt of notes) {
      [nt.x, nt.y] = map(nt.x, nt.y);
      if (nt.labelStyle && nt.labelStyle.x != null)
        [nt.labelStyle.x, nt.labelStyle.y] = map(nt.labelStyle.x, nt.labelStyle.y);
    }
    const placements = this.ed.store.placementData(this.ed.building.dir, this.ed.floor.id).placements;
    for (const p of placements) {
      const [x, y] = map(p.x, p.y); p.x = x; p.y = y;
      if (p.w != null) p.w = +(p.w * oldG.W / newG.W).toFixed(5);
      if (p.h != null) p.h = +(p.h * oldG.H / newG.H).toFixed(5);
    }
    if (rooms.length || arrows.length || notes.length) this.ed.store.markDirty();
    if (placements.length) this.ed.store.markPlacementsDirty();
  }
}
