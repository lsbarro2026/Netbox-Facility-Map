#!/usr/bin/env python3
"""
preprocess.py — render a facility's floor-plan drawings into the assets the map serves
(images/ + manifest.json). It is the rendering engine behind the in-app import wizard.

IMPORTANT — isolation: this module is **invoked as a standalone subprocess** by
`imports.py` (run by file path, never imported as `netbox_facilitymap.preprocess`), so it
must stay **stdlib + pypdfium2/Pillow/cairosvg only** and never import Django/NetBox. Keeping
the drawing parser (untrusted input) out of the long-lived NetBox worker is the whole point: a
PDFium/Pillow/CairoSVG exploit is contained in a short-lived, resource-limited child process.

The source drawings live under `<work-dir>/uploads/` (one folder per building, uploaded
through the wizard). A drawing is a **PDF** (rendered with PDFium), a **raster image**
(PNG/JPEG/TIFF/GIF/BMP/WEBP, opened with Pillow — public measured-drawing collections such as
the Library of Congress HABS/HAER/HALS ship as scans, never PDF), or an **SVG** vector drawing
(rasterized with CairoSVG). The accepted formats, their magic sniff, and their render live in
the `drawing_formats` registry (one handler per format); rendering here dispatches through it
by extension. Facility drawings
carry no text layer — floor
identity cannot be read from the file — so that mapping is supplied by `import-map.json`:
per building a `slug`/`name`/`abbr` and a `{drawing-stem: floor-token}` table. Floor labels
are derived from the token (`b3` -> "Basement 3", `g` -> "Ground", `l1` -> "Level 1",
`r` -> "Roof"); two drawings sharing a token become one multi-page floor (ordered by
drawing number).

Three modes:
  scan     walk uploads/, render a thumbnail per PDF, and print a JSON inventory of
           folders + drawings to stdout (the wizard's mapping step reads this).
  build    read import-map.json, render every mapped PDF to images/<slug>/<id>[-N].webp
           (lossless, plus a card-sized <id>.thumb.webp per floor), and write manifest.json
           (the default mode).
  preview  render one named PDF at full scale to --out (the wizard's on-demand high-res
           preview, served from a .thumbs cache).

Rendering needs `pypdfium2` + `Pillow`. The working directory is passed explicitly so the
data can live under NetBox's MEDIA_ROOT while this script lives in the package:

  python3 preprocess.py scan  --base /path/to/workdir
  python3 preprocess.py build --base /path/to/workdir
  python3 preprocess.py preview --base /path/to/workdir --pdf uploads/A/1.pdf --out uploads/.thumbs/A/1.full.png
"""

import io
import json
import os
import re
import sys
import time

# This script is run standalone by file path (never `-m`), so `sys.path[0]` is its own
# directory. Add it explicitly (a no-op for the CLI, needed when a test loads this file via
# importlib) and import the sibling registry as a top-level module — this stays Django-free
# (it loads the pure-stdlib `drawing_formats`, not the `netbox_facilitymap` package).
_here = os.path.dirname(os.path.abspath(__file__))
if _here not in sys.path:
    sys.path.insert(0, _here)
import drawing_formats  # noqa: E402


class Preprocessor:
    """Renders uploads/ + import-map.json into images/ and manifest.json, all relative
    to a single working directory (``base_dir``)."""

    THUMBS_DIRNAME = ".thumbs"
    IMAGE_EXT = ".webp"  # build output format: lossless WebP is pixel-identical to PNG at
                         # 40-75% fewer bytes for plan renders (images are the map's heaviest
                         # first-paint asset). Pre-existing .png renders keep serving — the
                         # manifest stores filenames, so the format only changes on rebuild.

    def __init__(self, base_dir):
        self.base_dir = base_dir
        self.source = os.path.join(base_dir, "uploads")
        self.images_dir = os.path.join(base_dir, "images")
        self.manifest_path = os.path.join(base_dir, "manifest.json")
        self.import_map_path = os.path.join(base_dir, "import-map.json")
        self.stub_path = os.path.join(base_dir, "import-map.stub.json")

    # ---- drawing rendering (dispatched through the drawing_formats registry) ----
    @staticmethod
    def render_full(path, fmt="WEBP", page=0, angle=0):
        """Render a drawing to encoded image bytes at full scale — a given 0-based `page` of a PDF
        (default the first) or the first frame of a raster image, via the format registry. `fmt` is
        the output encoding: WEBP for build artifacts, PNG for the wizard's `.full.png` preview
        cache. `angle` is a clockwise straightening rotation in degrees (0 = as-is), applied as a
        post-render step so every format handler stays angle-unaware — a scanned drawing that
        arrived rotated is reoriented here before it becomes floor content. Returns (raw, w, h), or
        None when the format is unknown, the decoder is missing, or the file can't be rendered."""
        handler = drawing_formats.format_for(path)
        if handler is None or handler.role != drawing_formats.BASE_RASTER:
            return None
        res = handler.render_full(path, fmt, page=page)
        if res is None or angle % 360 == 0:
            return res
        return Preprocessor._rotate_encoded(res[0], angle, fmt)

    @staticmethod
    def _rotate_encoded(raw, angle, fmt):
        """Reorient already-encoded image bytes by `angle` clockwise degrees and re-encode as
        `fmt`. `expand=True` grows the canvas so nothing is clipped — for a 90/270 turn that swaps
        width/height, which is the intent: coordinates are normalized 0..1, so the reoriented
        canvas is self-consistent (see ARCHITECTURE §6). PIL rotates counter-clockwise, so the sign
        is flipped; the exposed corners fill white (drawings sit on a white ground). Pillow is
        imported lazily, keeping the module top level decoder-free like the registry handlers.
        Returns (raw, w, h), or None if the bytes can't be reopened."""
        try:
            from PIL import Image
        except ImportError:
            return None
        try:
            im = Image.open(io.BytesIO(raw)).convert("RGB")
            im = im.rotate(-angle, expand=True, fillcolor="white")
            buf = io.BytesIO()
            im.save(buf, fmt, **drawing_formats.save_kwargs(fmt))
        except Exception as e:
            print("WARN rotate %g°: %s" % (angle, e), file=sys.stderr)
            return None
        return buf.getvalue(), im.width, im.height

    @staticmethod
    def _crop_encoded(raw, region, fmt):
        """Crop already-encoded image bytes to `region` (an ``[x, y, w, h]`` box normalized 0..1)
        and re-encode as `fmt` — the region-split (FLOOR-3) counterpart to `_rotate_encoded`, same
        reopen→transform→re-encode shape. The cropped sub-rectangle becomes the derived floor's own
        image, mapped back to a fresh 0..1 canvas (its returned `w`/`h` are the crop's pixel size),
        echoing — inverted — the multi-sheet combined-canvas mapping in `Store.floorLayout`. Applied
        **after** the straightening rotate, so the box is in *straightened-image* space — the same
        space the wizard preview shows it in (crop-after-rotate; see `build_building_from_pdfs`).
        Pillow is imported lazily, keeping the module top level decoder-free like the registry
        handlers. Returns (raw, w, h) of the crop, or None if the bytes can't be reopened or the box
        is degenerate (rounds to <1px on a side)."""
        try:
            from PIL import Image
        except ImportError:
            return None
        x, y, w, h = region
        try:
            im = Image.open(io.BytesIO(raw)).convert("RGB")
            left, top = max(0, round(x * im.width)), max(0, round(y * im.height))
            right = min(im.width, round((x + w) * im.width))
            bottom = min(im.height, round((y + h) * im.height))
            if right - left < 1 or bottom - top < 1:
                raise ValueError("region rounds to empty: %r on %dx%d"
                                 % (region, im.width, im.height))
            im = im.crop((left, top, right, bottom))
            buf = io.BytesIO()
            im.save(buf, fmt, **drawing_formats.save_kwargs(fmt))
        except Exception as e:
            print("WARN crop region %r: %s" % (region, e), file=sys.stderr)
            return None
        return buf.getvalue(), im.width, im.height

    @staticmethod
    def render_thumb(path, out_path):
        """Render a small thumbnail of a drawing to ``out_path`` for the wizard's mapping grid,
        via the format registry. Returns True on success. Only the first page/frame is thumbnailed
        (the wizard shows per-page cards for a multi-page PDF via the on-demand `preview` render).
        Deliberately angle-unaware — the grid thumbnail is the pre-rotation state; once the user
        rotates a card the wizard swaps it for the reoriented `render_full`-based preview."""
        handler = drawing_formats.format_for(path)
        if handler is None or handler.role != drawing_formats.BASE_RASTER:
            return False
        return handler.render_thumb(path, out_path)

    @staticmethod
    def page_count(path):
        """Number of independently-mappable pages in a drawing (via the format registry) — >1 only
        for a multi-page PDF, which the wizard explodes into one floor per page. 1 for an unknown
        format or any single-page source; never raises."""
        handler = drawing_formats.format_for(path)
        return handler.page_count(path) if handler else 1

    @staticmethod
    def _is_overlay(path):
        """True when `path`'s extension is an OVERLAY-role format (data drawn atop a base plan)
        rather than a base raster — used by the build to route a floor's files."""
        handler = drawing_formats.format_for(path)
        return handler is not None and handler.role == drawing_formats.OVERLAY

    @staticmethod
    def extract_overlay(path):
        """Parse an OVERLAY-role data source into normalized-0..1 features via the format registry
        — the counterpart to `render_full` for the overlay tier. Returns the feature list, or None
        when the extension isn't an OVERLAY format, the parser is missing, or the file can't be
        decoded. Runs only here in the render subprocess (the parser is untrusted-input territory,
        like the raster decoders)."""
        handler = drawing_formats.format_for(path)
        if handler is None or handler.role != drawing_formats.OVERLAY:
            return None
        return handler.extract_overlay(path)

    @staticmethod
    def _render_hint(path):
        """A "could not read" reason for a drawing the build couldn't turn into map content. A
        format with an optional decoder names that dep (so a missing extra is diagnosable from the
        log); a dependency-free format (stdlib parser, e.g. GeoJSON) has no phantom decoder to
        name, so its failure is reported as a malformed/empty source instead."""
        handler = drawing_formats.format_for(path)
        if handler is None:
            return "could not render (need pypdfium2 + Pillow)"
        if not handler.requires:
            return "could not read (malformed or empty source)"
        return "could not render (need %s)" % handler.requires

    def preview(self, src_rel, out_rel, page=0, angle=0):
        """Render a single uploaded drawing (a 0-based `page` of a PDF, default the first; or a
        raster first frame) at full scale to ``out_rel`` — the wizard's on-demand high-res preview
        (popup + enlarged/zoomed cards, including the per-page cards of an exploded multi-page PDF).
        `angle` (clockwise degrees, 0 = as-is) reorients it so a rotated card previews the way it
        will build. Both paths are working-dir-relative; the caller (imports.py) has already
        traversal-guarded them. Writes atomically via a ``.part`` temp so concurrent identical
        renders are safe. Returns True on success. Encoded as PNG — the caller's cache path
        and Content-Type are ``.full.png``, and the wizard-only preview isn't worth the
        slower lossless-WebP encode."""
        res = self.render_full(os.path.join(self.base_dir, src_rel), fmt="PNG", page=page, angle=angle)
        if res is None:
            print("WARN preview %s: %s" % (src_rel, self._render_hint(src_rel)), file=sys.stderr)
            return False
        raw = res[0]
        out_path = os.path.join(self.base_dir, out_rel)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        part = out_path + ".part"
        with open(part, "wb") as f:
            f.write(raw)
        os.replace(part, out_path)
        return True

    def write_image(self, rel_dir, floor_id, raw):
        out_dir = os.path.join(self.images_dir, rel_dir)
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, floor_id + self.IMAGE_EXT)
        with open(path, "wb") as f:
            f.write(raw)
        return os.path.relpath(path, self.base_dir).replace(os.sep, "/")

    def write_floor_thumb(self, rel_dir, floor_id, raw):
        """Decode an already-rendered page image and write a card-sized thumbnail
        (``drawing_formats.THUMB_MAX_PX`` longest side) beside it, for the building-view /
        Site-page floor cards — so those grids stop downloading the full-resolution plans.
        Returns the working-dir-relative path, or None when the thumbnail can't be produced
        (the cards then fall back to the full image). Pillow is imported lazily (the module
        top level stays decoder-free, matching the registry handlers)."""
        try:
            from PIL import Image
        except ImportError:
            return None
        try:
            im = Image.open(io.BytesIO(raw)).convert("RGB")
            im.thumbnail((drawing_formats.THUMB_MAX_PX, drawing_formats.THUMB_MAX_PX))
            buf = io.BytesIO()
            im.save(buf, "WEBP", **drawing_formats.save_kwargs("WEBP"))
        except Exception as e:
            print("WARN floor thumb %s/%s: %s" % (rel_dir, floor_id, e), file=sys.stderr)
            return None
        return self.write_image(rel_dir, floor_id + ".thumb", buf.getvalue())

    # ---- floor labels ----
    @staticmethod
    def floor_label(token):
        """Floor token -> human label. A compact floor code from the wizard's
        floor-type mode is expanded segment-by-segment: 'b3' -> 'Basement 3',
        'gl1' -> 'Ground / Level 1', 'g' -> 'Ground', 'r' -> 'Roof'. Any other token
        — notably a NetBox Location slug from the wizard's Location mode — is
        title-cased as-is ('basement-2' -> 'Basement 2'). The compact parse is
        anchored to the WHOLE token; it is no longer scanned for loose 'g'/'r'
        letters, which used to emit phantom 'Ground'/'Roof' segments (a slug like
        'storage-b2' wrongly became 'Roof / Ground / Basement 2')."""
        seg = r"gl\d+|b\d+|l\d+|g|r"
        t = token.lower()
        if not re.fullmatch(r"(?:%s)+" % seg, t):
            return token.replace("-", " ").replace("_", " ").title() or token.upper()
        names = []
        for m in re.findall(seg, t):
            if m == "g":
                names.append("Ground")
            elif m == "r":
                names.append("Roof")
            elif m.startswith("gl"):
                names += ["Ground", "Level " + m[2:]]
            elif m.startswith("b"):
                names.append("Basement " + m[1:])
            elif m.startswith("l"):
                names.append("Level " + m[1:])
        return " / ".join(names)

    # ---- drawing discovery ----
    @staticmethod
    def dwg_sort_key(stem):
        """Order drawings by number, keeping a '-N' second-sheet suffix after its
        base (26024 < 26024-2 < 26025). Non-numeric names sort last by name."""
        base, _, suf = stem.partition("-")
        if not base.isdigit():
            return (10 ** 9, 0, stem)
        return (int(base), int(suf) if suf.isdigit() else 0, "")

    def drawing_files(self, folder):
        """(stem, filename) of every drawing (PDF or accepted raster) in a building folder, in
        drawing order."""
        fdir = os.path.join(self.source, folder)
        items = [(os.path.splitext(f)[0], f)
                 for f in os.listdir(fdir) if f.lower().endswith(drawing_formats.DRAWING_EXTS)]
        return sorted(items, key=lambda it: self.dwg_sort_key(it[0]))

    def building_folders(self):
        """Top-level building folders under uploads/ (skips the thumbnail cache)."""
        if not os.path.isdir(self.source):
            return []
        return sorted(d for d in os.listdir(self.source)
                      if d != self.THUMBS_DIRNAME
                      and os.path.isdir(os.path.join(self.source, d)))

    # ---- import map ----
    def load_import_map(self):
        if not os.path.isfile(self.import_map_path):
            return None
        with open(self.import_map_path, encoding="utf-8") as f:
            return json.load(f)

    @staticmethod
    def building_lookup(imap):
        """Resolve a source folder to its map entry by either its upload folder name
        (the map key) or its slug."""
        out = {}
        for name, entry in (imap or {}).get("buildings", {}).items():
            out[name] = entry
            out[entry["slug"]] = entry
        return out

    @staticmethod
    def _page_entries(stem, fmap):
        """Map entries referencing drawing ``stem`` as ``(page_index, token, region, label_key)``
        tuples in page order. A **bare ``stem``** key is page 0 — the single-page / whole-file case.
        A **``stem#pN``** key is page ``N-1`` — a multi-page PDF whose pages the wizard exploded into
        separate floors (``#pN`` is 1-based, distinct from the ``-N`` filename suffix that groups
        *separate files* into one floor's sheets, so the two schemes never collide).

        Each key's value is **polymorphic** (region-split, FLOOR-2): a **string** token is a
        whole-page floor (``region`` is None, ``label_key`` is the map key); a **list** of
        ``{token, region}`` splits that one page into several floors, each entry becoming its own
        floor (``region`` is the ``[x, y, w, h]`` normalized 0..1 crop box, ``label_key`` is the
        compound ``<map key>@rN`` — 1-based list order — mirroring how ``stem#pN`` extends a stem
        key). Region-split composes atop page explosion, so an exploded page's value can itself be a
        list. An empty list of entries means the drawing is unmapped."""
        out = []

        def expand(page, key, value):
            if isinstance(value, list):
                for i, spec in enumerate(value, start=1):
                    if isinstance(spec, dict) and spec.get("token"):
                        out.append((page, spec["token"], spec.get("region"),
                                    "%s@r%d" % (key, i)))
            elif value:
                out.append((page, value, None, key))

        expand(0, stem, fmap.get(stem))
        prefix = stem + "#p"
        for key, value in fmap.items():
            if key.startswith(prefix):
                suf = key[len(prefix):]
                if suf.isdigit():
                    expand(int(suf) - 1, key, value)
        # Sort by page only: the stable sort preserves each page's region list order, which the
        # ``@rN`` label keys index by. (Sorting the full tuple would also compare None vs list.)
        out.sort(key=lambda e: e[0])
        return out

    # ---- building / siteplan assembly ----
    def build_building_from_pdfs(self, folder, entry):
        """Build one manifest building from its drawing folder + import-map entry. Drawings sharing
        a floor token group into one multi-sheet floor (ordered by drawing number); a multi-page
        PDF additionally contributes one sheet per mapped page (``stem#pN`` keys, resolved by
        `_page_entries`); a region-split page (a list-valued `floors` entry) fans one page into
        several floors, each with its own token → own ``fid``/``floorSlug`` (FLOOR-2). Each sheet is
        a ``(filename, page_index, angle, region)`` tuple, so separate-file sheets, exploded pages,
        and region crops all flow through the same render path. A floor's ``label`` prefers the
        wizard-resolved ``labels`` entry (see `lmap`) over the ``floor_label(token)`` guess.
        Returns (building, unmapped_stems)."""
        slug, abbr = entry["slug"], entry.get("abbr", "")
        fmap = entry.get("floors", {})
        # Straightening rotation per drawing, keyed by *page* (bare `stem`, or `stem#pN` for an
        # exploded page). Absent/0 = render as-is, so an old import map (no `angles`) is unchanged.
        # A page is straightened once, so every region floor split from it shares the page's angle
        # (crop-after-rotate); the key is recoverable from (stem, page) here.
        amap = entry.get("angles", {})
        # Friendly floor labels the wizard resolved from a chosen NetBox Location field (name/
        # slug/description). Keyed by the page key, or the compound `<page key>@rN` for a region
        # floor (`_page_entries` returns that `label_key`). Absent = no override, so `preprocess`
        # falls back to `floor_label(token)` as before — an old import map (no `labels`) or a
        # floor-type token (no bound Location) is unaffected.
        lmap = entry.get("labels", {})
        groups, index, unmapped, flabel = [], {}, [], {}
        for stem, fname in self.drawing_files(folder):
            entries = self._page_entries(stem, fmap)
            if not entries:
                unmapped.append(stem)
                continue
            for page, token, region, label_key in entries:
                fid = abbr + token
                page_key = stem if page == 0 else "%s#p%d" % (stem, page + 1)
                angle = amap.get(page_key, 0)
                if fid not in index:
                    index[fid] = len(groups)
                    groups.append([fid, token, []])
                if fid not in flabel and lmap.get(label_key):
                    flabel[fid] = lmap[label_key]
                # `region` (a normalized 0..1 crop box, or None for a whole-page floor) rides in the
                # sheet tuple to the render call, where a non-None box is cropped out (FLOOR-3).
                groups[index[fid]][2].append((fname, page, angle, region))
        # Whole-page renders shared across the region floors split from one page: keyed by the page's
        # (fname, page, angle), a page fanned into N region floors is rendered once and cropped N
        # times (each region floor lives in its own group, so this spans the groups loop). Only
        # region-split pages populate it — a whole-page floor's key is unique, so caching it would
        # only pin its raster in memory against the child's rlimits for no reuse (see the render loop).
        page_cache = {}
        floors = []
        for fid, token, sheets in groups:
            # A floor's drawings split by handler role: BASE_RASTER files render to page images,
            # OVERLAY files (FMT-9) extract data features drawn atop them. Unknown extensions fall
            # to the base path so they still surface the existing "could not render" warning. Each
            # base sheet is a (filename, page) pair, so a multi-page PDF's exploded pages render
            # here just like separate sheets.
            base_sheets, overlay_fnames = [], []
            for fname, page, angle, region in sheets:
                if self._is_overlay(fname):
                    overlay_fnames.append(fname)
                else:
                    base_sheets.append((fname, page, angle, region))
            pages, p0_raw = [], None
            for n, (fname, page, angle, region) in enumerate(base_sheets, start=1):
                # Render (or reuse) the whole straightened page, then crop to this floor's `region`.
                # A region-split page is cached so its sibling region floors reuse one render; a
                # whole-page floor (region None) renders once and is never cached (see `page_cache`).
                key = (fname, page, angle)
                full = page_cache.get(key)
                if full is None:
                    full = self.render_full(os.path.join(self.source, folder, fname),
                                            page=page, angle=angle)
                    if full is None:
                        print("  WARN %s %s: %s" % (folder, fname, self._render_hint(fname)),
                              file=sys.stderr)
                        continue
                    if region is not None:  # only a region-split page is re-used; cache it once
                        page_cache[key] = full
                if region is None:
                    res = full
                else:
                    res = self._crop_encoded(full[0], region, "WEBP")
                    if res is None:
                        print("  WARN %s %s: could not crop region %r" % (folder, fname, region),
                              file=sys.stderr)
                        continue
                raw, w, h = res
                if not pages:
                    p0_raw = raw   # first *rendered* page backs the floor's card thumbnail
                pid = fid if n == 1 else "%s-%d" % (fid, n)
                sheet = {"image": self.write_image(slug, pid, raw),
                         "w": w, "h": h, "caption": None}
                # Record a non-zero straightening angle so re-opening the wizard can tell a floor
                # was reoriented (the room-desync guard compares against it); omitted when 0 so
                # older manifests/readers are unaffected.
                if angle % 360:
                    sheet["angle"] = angle
                pages.append(sheet)
            # An overlay layers onto a base plan (fit-to-bounds needs the floor's canvas), so a
            # floor with only overlay files and no rendered base page is dropped like any pageless
            # floor — its overlays have nothing to sit on.
            if not pages:
                continue
            p0 = pages[0]
            floor = {
                "id": fid, "label": flabel.get(fid) or self.floor_label(token) or fid,
                "floorSlug": fid, "image": p0["image"], "w": p0["w"], "h": p0["h"],
                "pages": pages,
            }
            thumb = self.write_floor_thumb(slug, fid, p0_raw)
            if thumb:
                floor["thumb"] = thumb
            overlays = []
            for fname in overlay_fnames:
                feats = self.extract_overlay(os.path.join(self.source, folder, fname))
                if feats is None:
                    print("  WARN %s %s: %s" % (folder, fname, self._render_hint(fname)),
                          file=sys.stderr)
                    continue
                overlays.append({"name": os.path.splitext(fname)[0], "features": feats})
            if overlays:
                floor["overlays"] = overlays
            floors.append(floor)
        code = slug[:2] if re.match(r"\d\d", slug) else None
        print("%-26s slug=%-12s floors=%s%s" % (
            folder, slug, ",".join(f["id"] for f in floors) or "(none)",
            "  UNMAPPED: " + ",".join(unmapped) if unmapped else ""), file=sys.stderr)
        return {"code": code, "dir": slug, "name": entry.get("name", folder),
                "folder": folder, "siteSlug": slug, "floors": floors}, unmapped

    def build_siteplan_from_pdf(self, imap):
        """Render the drawing named in import-map.json's `siteplan` block as the siteplan
        background, with no hotspots (drawn in the tool). The `pdf` field carries the source
        filename (a PDF or a raster image); `angle` (clockwise degrees, optional) straightens a
        rotated scan. None when not configured."""
        sp = (imap or {}).get("siteplan")
        if not sp or not sp.get("pdf"):
            return None
        src = os.path.join(self.source, sp.get("folder", ""), sp["pdf"])
        angle = sp.get("angle", 0)
        res = self.render_full(src, angle=angle)
        if res is None:
            print("  WARN could not render siteplan drawing:", src, file=sys.stderr)
            return None
        raw, w, h = res
        image = self.write_image("Siteplan", "siteplan", raw)
        print("siteplan: %dx%d, 0 hotspots (draw building boundaries in the tool)"
              % (w, h), file=sys.stderr)
        out = {"image": image, "w": w, "h": h,
               "siteSlug": sp.get("slug", "00-site"), "hotspots": []}
        # Recorded (non-zero only) so re-import can warn that a reorientation would desync
        # already-drawn hotspots — the siteplan analogue of the floor room-desync guard.
        if angle % 360:
            out["angle"] = angle
        return out

    def write_stub(self, unmapped):
        """Write import-map.stub.json listing drawings with no floor token: one block
        per folder, drawings pre-listed in order with blank tokens to fill in. A blank is a scalar
        (whole-page) token; region-split is opt-in by editing a value into a `[{token, region}]`
        list (the wizard writes that form), so the stub shape is unchanged."""
        stub = {}
        for folder, stems in sorted(unmapped.items()):
            stub[folder] = {"slug": folder, "name": folder, "abbr": "",
                            "floors": {s: "" for s in stems}}
        with open(self.stub_path, "w", encoding="utf-8") as f:
            json.dump({"buildings": stub}, f, indent=2, ensure_ascii=False)
        print("WROTE %s — fill in the floor tokens and merge into import-map.json"
              % os.path.relpath(self.stub_path, self.base_dir), file=sys.stderr)

    # ---- modes ----
    def scan(self):
        """Render a thumbnail per PDF and print a JSON inventory of folders/drawings
        to stdout (consumed by the wizard's mapping step)."""
        folders = []
        for folder in self.building_folders():
            pdfs = []
            for stem, fname in self.drawing_files(folder):
                # Thumbnail key includes the source extension so `1.pdf` and `1.png` in one
                # folder don't overwrite each other's thumbnail.
                thumb_rel = os.path.join("uploads", self.THUMBS_DIRNAME, folder,
                                         fname + ".png")
                full = os.path.join(self.source, folder, fname)
                ok = self.render_thumb(full, os.path.join(self.base_dir, thumb_rel))
                # `pages` is >1 only for a multi-page PDF (the wizard explodes each into a per-page
                # floor card); every other format reports 1. The thumbnail above is always page 1.
                pdfs.append({"file": fname, "stem": stem,
                             "thumb": thumb_rel.replace(os.sep, "/") if ok else None,
                             "pdf": ("uploads/%s/%s" % (folder, fname)),
                             "pages": self.page_count(full)})
            if pdfs:
                folders.append({"folder": folder, "pdfs": pdfs})
            print("scanned %s (%d)" % (folder, len(pdfs)), file=sys.stderr)
        json.dump({"folders": folders}, sys.stdout)

    def build(self):
        """Render every mapped PDF and write manifest.json from import-map.json."""
        imap = self.load_import_map()
        if not imap:
            sys.exit("No import-map.json — nothing to build.")
        lookup = self.building_lookup(imap)
        siteplan = self.build_siteplan_from_pdf(imap)
        buildings, unmapped = [], {}
        for folder in self.building_folders():
            entry = lookup.get(folder)
            if entry:
                b, miss = self.build_building_from_pdfs(folder, entry)
                if b["floors"]:
                    buildings.append(b)
                if miss:
                    unmapped[folder] = miss
        if unmapped:
            self.write_stub(unmapped)
        # `built` is the media cache-buster: MediaView serves `?v=<built>` URLs as
        # immutable, and a rebuild minting a new token is what invalidates them.
        self.write_manifest({"siteplan": siteplan, "buildings": buildings,
                             "built": int(time.time())})
        print("Wrote %s — buildings: %d, floors: %d"
              % (self.manifest_path, len(buildings),
                 sum(len(b["floors"]) for b in buildings)), file=sys.stderr)

    def write_manifest(self, payload):
        """Write manifest.json atomically (`.part` + `os.replace`), like `preview()`. The plain
        `open("w")` this replaced truncated the file up front and streamed in, so a build killed
        mid-write (subprocess timeout, or an OOM/CPU kill under the child's rlimits) left a
        truncated manifest on disk — which `ManifestView` can't distinguish from a fresh install,
        stranding the facility in an empty state until a clean rebuild. The rename is atomic, so a
        kill either leaves the previous good manifest intact or lands the complete new one."""
        part = self.manifest_path + ".part"
        with open(part, "w") as f:
            json.dump(payload, f, indent=2)
        os.replace(part, self.manifest_path)


def _parse_args(argv):
    """Tiny argv parser (argparse-free to keep the child minimal): a bare
    `scan`/`build`/`preview` mode plus an optional `--base <dir>` (falls back to
    $FACILITYMAP_WORKDIR, then the script's own directory). `preview` also takes
    `--pdf <uploads-relative.pdf>`, `--out <base-relative.png>`, an optional
    `--page <0-based-index>` (default the first page, for a multi-page PDF), and an optional
    `--angle <clockwise-degrees>` (default 0, straightens a rotated scan)."""
    mode = "build"
    base = os.environ.get("FACILITYMAP_WORKDIR")
    opts = {}
    i = 0
    while i < len(argv):
        if argv[i] in ("--base", "--pdf", "--out", "--page", "--angle") and i + 1 < len(argv):
            key = argv[i][2:]
            if key == "base":
                base = argv[i + 1]
            else:
                opts[key] = argv[i + 1]
            i += 2
        else:
            mode = argv[i]
            i += 1
    if not base:
        base = os.path.dirname(os.path.abspath(__file__))
    return mode, base, opts


if __name__ == "__main__":
    mode, base, opts = _parse_args(sys.argv[1:])
    pre = Preprocessor(base)
    if mode == "scan":
        pre.scan()
    elif mode == "build":
        pre.build()
    elif mode == "preview":
        if not opts.get("pdf") or not opts.get("out"):
            sys.exit("preview needs --pdf and --out")
        try:
            page = int(opts.get("page", 0))
        except ValueError:
            page = 0
        try:
            angle = float(opts.get("angle", 0))
        except ValueError:
            angle = 0
        if not pre.preview(opts["pdf"], opts["out"], page=max(0, page), angle=angle):
            sys.exit("preview render failed")
    else:
        sys.exit("usage: preprocess.py [scan|build|preview] [--base DIR]")
