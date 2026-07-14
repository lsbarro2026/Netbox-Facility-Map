'use strict';
/* embed-export.js — EmbedExport: download the server-rendered room-map embed
   (floor_rooms.html) as a standalone PNG or SVG image.

   This runs on a stock NetBox `dcim` page (a Location / device / rack detail page), NOT in the
   SPA — so it depends on no plugin globals (`Dom`/`Util`/`Toast` don't exist here) and degrades
   with a native alert. It is the only plugin JS injected onto a dcim page.

   The embed IS the exact visual: `template_content.RoomPanelExtension._panel` already rendered a
   static, fully inline-styled <svg> (tiled floor sheets + the room polygon + spotlight mask +
   placement markers + wayfinding arrows). So an export is a serialization job — unlike the SPA's
   FloorExport there is no live Editor to snapshot and no CSS classes to mirror. Two details make
   the output standalone:
     - The floor-sheet <image> tiles are served AUTHENTICATED (MediaView), so a raw href renders
       blank in a detached file — each is fetched with the session cookie and inlined as a data:
       URI (which also keeps the PNG canvas un-tainted so toBlob() works).
     - The crop viewBox is a sub-window of the full-floor <image> (which spans the whole canvas),
       so the image always fills the frame — no background rect is needed. */

class EmbedExport {
  /** Wire every export control on the page. A control is a `[data-fm-export]` group whose target
   *  <svg> is the one in the same `.card`; each `[data-fm-fmt]` button triggers that format. */
  static init() {
    for (const group of document.querySelectorAll('[data-fm-export]')) {
      const card = group.closest('.card');
      const svg = card && card.querySelector('svg');
      if (!svg) continue;
      const exporter = new EmbedExport(svg, group.getAttribute('data-fm-name') || 'room');
      for (const btn of group.querySelectorAll('[data-fm-fmt]')) {
        btn.addEventListener('click', () => exporter.run(btn.getAttribute('data-fm-fmt')));
      }
    }
  }

  constructor(svg, name) {
    this.svg = svg;
    // `map-<room>`, sanitized to a safe filename stem.
    this.stem = ('map-' + name).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'map';
  }

  async run(fmt) {
    try {
      const svgStr = await this._standaloneSvg();
      if (fmt === 'svg') {
        this._download(new Blob([svgStr], { type: 'image/svg+xml' }), this.stem + '.svg');
      } else {
        const [w, h] = this._dims();
        this._download(await this._rasterize(svgStr, w, h, 2), this.stem + '.png');
      }
    } catch (e) {
      console.error('Map embed export failed', e);
      window.alert('Map export failed. See the browser console for details.');
    }
  }

  /** Clone the live embed <svg>, inline its authenticated floor tiles as data: URIs, and return a
   *  self-contained SVG string. The body is already inline-styled, so serializing it verbatim
   *  preserves the paint — no computed-style walk (cf. FloorExport). */
  async _standaloneSvg() {
    const clone = this.svg.cloneNode(true);
    const [w, h] = this._dims();
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    clone.setAttribute('width', w);
    clone.setAttribute('height', h);
    await Promise.all([...clone.querySelectorAll('image')].map(img => this._inlineImage(img)));
    return new XMLSerializer().serializeToString(clone);
  }

  /** Replace an <image>'s authenticated href with the raster inlined as a data: URI, so the file
   *  is standalone and (for PNG) the canvas stays un-tainted. */
  async _inlineImage(img) {
    const xlink = 'http://www.w3.org/1999/xlink';
    const url = img.getAttribute('href') || img.getAttributeNS(xlink, 'href');
    if (!url) return;
    const resp = await fetch(url, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error(`fetch ${url} → ${resp.status}`);
    const dataUrl = await this._readAsDataUrl(await resp.blob());
    img.setAttribute('href', dataUrl);
    img.removeAttributeNS(xlink, 'href');
  }

  _readAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  /** The embed's intrinsic size = its viewBox width/height (the room crop, or the full floor). */
  _dims() {
    const vb = (this.svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    return [vb[2] || 0, vb[3] || 0];
  }

  /** Draw the standalone SVG (its images/styles already inlined) into a canvas and export PNG.
   *  `scale` oversamples for a crisp raster. Data-URI images keep the canvas un-tainted. */
  _rasterize(svgStr, w, h, scale) {
    const url = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml' }));
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = w * scale;
          canvas.height = h * scale;
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(b => b ? resolve(b) : reject(new Error('canvas export failed')),
            'image/png');
        } catch (e) { reject(e); } finally { URL.revokeObjectURL(url); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG render failed')); };
      img.src = url;
    });
  }

  _download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
}

// The <script> tag is injected mid-page, so DOMContentLoaded may already have fired.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => EmbedExport.init());
} else {
  EmbedExport.init();
}
