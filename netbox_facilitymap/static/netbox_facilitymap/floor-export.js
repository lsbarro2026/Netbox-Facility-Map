'use strict';
/* floor-export.js — FloorExport: serialize a FloorEditor's annotated floor into a
   self-contained file for printing/sharing (work orders, evacuation postings,
   "tape it to the wall"). One instance per export action; no persistent state.

   The live floor is already a single overlay <svg> (room polygons + placement markers +
   wayfinding arrows/labels) layered over the tiled floor <img.sheet> images, so an export
   is a serialization job. Two details make it standalone:
     - The rendered sheets are served AUTHENTICATED (MediaView), so each is fetched with the
       session cookie and inlined as a data: URI — which also keeps the PNG canvas un-tainted
       so toBlob() works.
     - Room polygons + sheet captions get their paint from style.css CLASS rules (arrows
       already carry inline styles); a detached SVG has no stylesheet, so we snapshot the
       annotations into a throwaway <g> and walk it copying computed styles inline (no CSS
       mirror to drift). See ARCHITECTURE.md §10. */

class FloorExport {
  // Presentation properties copied from getComputedStyle onto each snapshot node so the
  // standalone SVG paints without style.css. Structural/layout props are excluded.
  static STYLE_PROPS = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
    'stroke-opacity', 'stroke-linejoin', 'stroke-linecap', 'stroke-dasharray', 'opacity',
    'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor',
    'dominant-baseline', 'letter-spacing'];

  constructor(editor) { this.editor = editor; }

  async downloadSvg() {
    if (!this._ready()) return;
    try {
      const svg = await this._annotatedSvg();
      this._download(new Blob([svg], { type: 'image/svg+xml' }), this._filename('svg'));
    } catch (e) { this._fail(e); }
  }

  /** Rasterize the standalone SVG to PNG. `scale` oversamples for crisp print output. */
  async downloadPng(scale = 2) {
    if (!this._ready()) return;
    try {
      const [W, H] = this.editor.dims;
      const svg = await this._annotatedSvg();
      const blob = await this._rasterize(svg, W, H, scale);
      this._download(blob, this._filename('png'));
    } catch (e) { this._fail(e); }
  }

  /** Arrange mode pads the canvas geometry (spare column + row), so the layout no longer
   *  matches the sheets — refuse to export from it rather than emit a mis-tiled floor. */
  _ready() {
    if (this.editor.arranging) {
      Toast.show('Finish arranging sheets before exporting', true);
      return false;
    }
    return true;
  }

  /** Build a standalone SVG string: the tiled sheets inlined as <image> data URIs plus a
   *  clean annotation layer (every room highlighted + all arrows/labels + placement
   *  markers), rendered independently of the user's current selection/mode so the live
   *  view is never disturbed. */
  async _annotatedSvg() {
    const ed = this.editor;
    const [W, H] = ed.dims;
    const base = ed.baseLayout;

    const overlay = this._snapshotAnnotations(W, H);
    const images = await Promise.all(base.cells.map(c => this._sheetImage(c, base)));

    const parts = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" `
        + `width="${W}" height="${H}">`,
      ...images,
      new XMLSerializer().serializeToString(overlay),   // drops JS event handlers
      '</svg>',
    ];
    return parts.join('');
  }

  /** Render the annotations into a throwaway <g> under the live overlay <svg> (so
   *  getComputedStyle resolves), copy the class-driven styles inline, then detach.
   *  The temp group is added and removed within one synchronous task, so the browser
   *  never paints it and the user's live view is untouched. */
  _snapshotAnnotations(W, H) {
    const ed = this.editor, app = ed.app;
    const g = Dom.svg('g');
    ed.svg.append(g);
    const saved = { mode: app.mode, viewCategories: app.viewCategories, selected: ed.selected,
      selectedArrow: ed.selectedArrow, selectedNote: ed.selectedNote,
      selectedPlacement: ed.selectedPlacement, draft: ed.draft, placingRacks: ed.placingRacks };
    try {
      // Force the neutral annotated view (all rooms shown, nothing selected) regardless of
      // the mode the user is actually in. `placingRacks` is cleared too — it (not `app.mode`)
      // gates the racks render path, and while set it would suppress wayfinding arrows/notes.
      // The View filter is swapped for a fresh show-everything selection (never mutated in place —
      // `saved` still holds the user's own object), so an export renders the FULL floor however the
      // user has the toolbar filtered (VIEW-2).
      app.mode = 'view'; app.viewCategories = FloorViewFilter.everything(); ed.placingRacks = false;
      ed.selected = null; ed.selectedArrow = null; ed.selectedNote = null;
      ed.selectedPlacement = null; ed.draft = null;
      // Overlays render beneath the annotations in the live view (grid < overlay < static),
      // so draw them first; `_renderOverlays` no-ops when the layer is hidden or absent.
      ed._renderOverlays(g, W, H);
      ed._renderStatic(g, W, H);
      this._inlineStyles(g);
      return g.cloneNode(true);
    } finally {
      Object.assign(app, { mode: saved.mode, viewCategories: saved.viewCategories });
      ed.selected = saved.selected; ed.selectedArrow = saved.selectedArrow;
      ed.selectedNote = saved.selectedNote;
      ed.selectedPlacement = saved.selectedPlacement; ed.draft = saved.draft;
      ed.placingRacks = saved.placingRacks;
      g.remove();
    }
  }

  /** Copy the whitelisted computed presentation styles onto every element in `g`, so the
   *  serialized SVG keeps its class-driven paint with no stylesheet attached. */
  _inlineStyles(g) {
    for (const el of g.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      let inline = '';
      for (const prop of FloorExport.STYLE_PROPS) {
        const v = cs.getPropertyValue(prop);
        if (v) inline += `${prop}:${v};`;
      }
      el.setAttribute('style', inline);
      el.removeAttribute('class');   // classes are meaningless without the stylesheet
    }
  }

  /** One tiled sheet as an <image>, its authenticated raster inlined as a data URI. */
  async _sheetImage(cell, base) {
    const href = await this._dataUrl(this.editor.store.mediaUrl(cell.image));
    const x = cell.col * base.cellW, y = cell.row * base.cellH;
    return `<image href="${href}" x="${x}" y="${y}" `
      + `width="${base.cellW}" height="${base.cellH}"/>`;
  }

  /** Fetch an authenticated media URL (session cookie) and return it as a data: URI. */
  async _dataUrl(url) {
    const resp = await fetch(url, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error(`fetch ${url} → ${resp.status}`);
    const blob = await resp.blob();
    return await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  /** Draw the standalone SVG (which carries its own inlined images/styles) into a canvas
   *  and export PNG. Data-URI images keep the canvas un-tainted, so toBlob succeeds. */
  _rasterize(svgStr, W, H, scale) {
    const url = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml' }));
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = Dom.el('canvas');
          canvas.width = W * scale; canvas.height = H * scale;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(b => b ? resolve(b) : reject(new Error('canvas export failed')),
            'image/png');
        } catch (e) { reject(e); } finally { URL.revokeObjectURL(url); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG render failed')); };
      img.src = url;
    });
  }

  _filename(ext) {
    const b = this.editor.building, f = this.editor.floor;
    const stem = (Util.code(b) + '-' + f.id).trim().replace(/\s+/g, '-');
    return `floor-${stem}.${ext}`;
  }

  _download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = Dom.el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  _fail(e) {
    console.error('Floor export failed', e);
    Toast.show('Export failed. See the browser console for details.', true);
  }
}
