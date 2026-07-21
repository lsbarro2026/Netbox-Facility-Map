"""drawing_formats.py — the facility's drawing-input format registry.

Single source of truth for *which* source formats the import pipeline accepts, how each one is
recognized (its extensions + header magic), and how it turns into map content. Both sides of the
import pipeline read this one module, so adding a format is a single new handler entry instead of
edits scattered across `preprocess.py`, `imports.py`, and the frontend:

  * the **NetBox worker** (`imports.py`/`views.py`) imports it for `DRAWING_EXTS` + `sniff`
    (accepted-extension list + cheap header check) — it never renders;
  * the **render subprocess** (`preprocess.py`) imports it for `format_for()` and the actual
    decode.

A handler has one of two **roles** (its `role` attribute):

  * `BASE_RASTER` — the drawing *is* a floor/siteplan image; the handler renders it to a base
    raster background (`render_full`/`render_thumb`). Every format shipped today is this role.
  * `OVERLAY` — the drawing is *data* (geospatial vectors, pinned points) that layers **on top
    of** a base plan rather than being one. The handler parses it into normalized-0..1 features
    (`extract_overlay`); the build threads them into the manifest floor entry, and the frontend
    draws them as a read-only overlay layer. This is the FMT-9 overlay model: `ShapefileFormat`
    (FMT-6), `GeoJsonFormat` (FMT-7), and `KmlFormat`/`KmzFormat` (FMT-8) ship this role today.

Overlay handlers project their source coordinates into the floor's 0..1 frame through the shared
`OverlayProjector` below, so the whole model stays resolution-independent (same convention as
`Room.polygon`). It places a layer one of two ways: **fit-to-bounds** (the `unit_projector`
primitive — the approximate default, flagged `georeferenced: false`) or a **control-point
georeference** (FMT-6) solved from operator-placed source↔plan pairs (the import map's
`overlayAlign`), which flips the flag true. Both tiers are CRS-aware: a geographic (lon/lat)
source is first pressed through a local equirectangular projection so its aspect is metrically
correct — see the class docstring.

**Companion (multi-file) formats.** Most sources are one self-contained file, but a Shapefile is a
*set* — a `.shp` main file plus sibling `.shx`/`.dbf`/`.prj`/`.cpg` that its parser reads by shared
basename. A format declares those siblings in its `companions` tuple. Companions are **not** in
`DRAWING_EXTS`: the scan/build/mapping-grid layers still see one logical drawing (the `.shp`), while
the upload layer (`imports.py`) additionally accepts the companions — gated by `sniff_companion`
and derived `COMPANION_EXTS` — and writes them into the same folder so the parser finds them at
extract time. Companions carry weak/absent magic, so their sniff is only a first-line upload filter;
the real validation is the parser running in the isolated render subprocess, same as every decoder.

Isolation contract (mirrors `preprocess.py`'s): the module top level is **pure stdlib** — no
Django, no pypdfium2/Pillow, no geospatial parsers — so importing it into the long-lived worker
loads no native decoder. Each handler **lazy-imports its decoder/parser inside its render/extract
methods**, which run only in the isolated render subprocess. That is what makes this module safe
to import from package code: `imports.py` may import `drawing_formats`, but must still NOT import
`preprocess` (the engine), which would pull the decoders into the worker.

**Optional-format gating (PKG-1).** The default install carries only the always-present formats
(PDF via pypdfium2, rasters via Pillow); every other format loads only when its **pip extra** —
`[svg]` (cairosvg), `[cad]` (ezdxf + cairosvg), `[gis]` (pyshp) — or, for Visio, its external
`soffice` binary is installed. Each handler declares how to probe that (`requires_module` /
`requires_binary`), and `available()` answers it **without importing the decoder into the worker**:
`importlib.util.find_spec` locates a module's spec without executing it, and `shutil.which` looks
up a binary — both pure stdlib, so the isolation contract above still holds. `DRAWING_EXTS` (the
single source of truth every consumer derives from) narrows to the installed set, so upload
validation, the render engine, and the frontend picker all follow for free. Availability is probed
once at import into the derived constants — installing an extra takes effect on the next worker
restart (the same reload the deployment already requires after any Python change).
"""

import importlib.util
import io
import math
import os
import shutil
import sys

# Handler roles: a format either renders a **base raster** background (`render_full`), or
# contributes a **data overlay** of normalized-0..1 features drawn atop a base (`extract_overlay`).
BASE_RASTER = "raster"
OVERLAY = "overlay"


def _module_installed(name):
    """True if the top-level module `name` is importable, probed WITHOUT importing it — the
    availability primitive that keeps `drawing_formats` import-safe in the NetBox worker.
    `importlib.util.find_spec` locates a module's spec via the import machinery without executing
    the module, so no native decoder loads here. Only ever called with a **top-level** name (a
    dotted name would import the parent package), and any probe error counts as 'not installed'."""
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def unit_projector(points, keep_aspect=True):
    """Build a callable mapping source `(x, y)` coordinates into the floor's normalized 0..1
    frame by fitting the bounding box of `points`. This is the 'fit-to-bounds' primitive —
    `OverlayProjector`'s fallback tier when a layer carries no control-point georeference —
    used to place features on a plan without any alignment input: gather all of an overlay's
    coordinates, build one projector, then map every feature through it so they share a single
    frame.

    `points` is any iterable of `(x, y)` in the source's planar units (already projected from a
    CRS by the caller; lon/lat is accepted as planar for the fit). Returns `project(x, y) ->
    (nx, ny)` in 0..1. With `keep_aspect` (the default) the wider axis fills 0..1 and the shorter
    axis is centered, so features keep their true shape; otherwise each axis stretches
    independently to fill 0..1. A degenerate span on an axis — every point sharing that coordinate
    (a single point, or a perfectly vertical/horizontal line) — centers it at 0.5.

    The Y axis is flipped (source world coordinates are Y-up; the image's 0..1 frame is Y-down),
    so a northern/greater-Y feature lands toward the top of the plan.
    """
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    if not xs:
        return lambda x, y: (0.5, 0.5)
    minx, miny = min(xs), min(ys)
    spanx, spany = max(xs) - minx, max(ys) - miny
    if keep_aspect:
        scalex = scaley = max(spanx, spany)
    else:
        scalex, scaley = spanx, spany

    def _axis(v, lo, span, scale):
        # `scale` is the denominator (== the larger span when keep_aspect); `span` is this axis's
        # own extent. `(scale - span) / 2` centers a shorter axis within the padded 0..1 box.
        if scale <= 0:
            return 0.5
        return ((scale - span) / 2.0 + (v - lo)) / scale

    def project(x, y):
        nx = _axis(x, minx, spanx, scalex)
        ny = _axis(y, miny, spany, scaley)
        return (nx, 1.0 - ny)   # flip Y: source up -> image down

    return project


class OverlayProjector:
    """The source→0..1 projection for one overlay layer — the georeference seam (FMT-6) every
    OVERLAY handler builds once per layer and maps every feature through.

    Places the layer one of two ways:

      * **fit-to-bounds** (the default): the `unit_projector` primitive over the layer's own
        points — lands any dataset on the plan, but only approximately (`georeferenced` False,
        which drives the frontend's approximate-alignment warnings).
      * **control-point georeference**: `align` carries operator-placed pairs
        (`[{"src": [sx, sy], "dst": [nx, ny]}, …]`, the import map's `overlayAlign` entry) tying
        a source coordinate to its true spot on the plan's 0..1 canvas. Two valid pairs solve a
        similarity (rotate / uniform-scale / translate); three or more a least-squares affine
        (`georeferenced` True, suppressing the warnings). Malformed pairs are dropped; fewer
        than two survivors, or a degenerate solve (coincident points), falls back to fit.

    Both tiers are **CRS-aware** via `crs` ("geographic" | "projected" | "unknown"): a
    geographic (lon/lat degrees) source is first pressed through a local equirectangular
    projection — `x' = lon·cos(lat0)`, `lat0` the layer's mid-latitude — so east–west spans
    stop being stretched by 1/cos(lat0). That fixes the fit tier's aspect away from the equator
    and makes the 2-point similarity solve geometrically meaningful; projected/unknown sources
    pass through planar, as before.

    Every path composes to an **affine** raw-source→unit map, exposed by `meta()` as the
    6-coefficient `srcTransform` (`nx = a·x + b·y + c`, `ny = d·x + e·y + f`). The wizard's
    align editor inverts it to recover the raw source coordinate behind a clicked feature
    vertex, and mirrors the solve for its live preview — keep the two implementations in
    lockstep (see architecture §10). Pure stdlib (`math` only), honouring the module isolation
    contract."""

    GEOGRAPHIC = "geographic"

    def __init__(self, all_points, crs="unknown", align=None):
        self.crs = crs
        # cos(mid-latitude) pre-scale for a geographic source (1.0 = planar pass-through).
        self._k = self._equirect_k(all_points) if crs == self.GEOGRAPHIC else 1.0
        pairs = self._clean_pairs(align)
        affine = self._solve_pairs(pairs) if len(pairs) >= 2 else None
        self.georeferenced = affine is not None
        self._affine = affine if affine is not None else self._fit_affine(all_points)

    def project(self, x, y):
        """Map one raw source coordinate into the plan's normalized 0..1 frame."""
        a, b, c, d, e, f = self._affine
        return (a * x + b * y + c, d * x + e * y + f)

    def meta(self):
        """The manifest overlay-entry metadata: the placement tier actually used, the CRS
        family, and the exact raw-source→unit transform for the frontend to invert."""
        return {"georeferenced": self.georeferenced, "crs": self.crs,
                "srcTransform": list(self._affine)}

    # ---- geographic pre-projection ----
    @classmethod
    def _equirect_k(cls, all_points):
        """The local equirectangular x-scale for a lon/lat layer: cos of the layer's
        mid-latitude, clamped away from the poles so a (junk) polar latitude can't collapse
        the x axis to zero. 1.0 for an empty layer."""
        lats = [p[1] for p in all_points]
        if not lats:
            return 1.0
        lat0 = (min(lats) + max(lats)) / 2.0
        return math.cos(math.radians(max(-89.0, min(89.0, lat0))))

    def _pre(self, x, y):
        """The CRS pre-projection into the local working plane (equirectangular x-scale for a
        geographic source; identity otherwise). Y stays raw — and Y-up — here; each tier below
        owns its own Y handling."""
        return (x * self._k, y)

    # ---- the two placement tiers, each expressed as a raw-source→unit affine ----
    def _fit_affine(self, all_points):
        """Fit-to-bounds over the pre-projected points, as a raw-source affine."""
        fit = unit_projector([self._pre(x, y) for x, y in all_points])
        return self._affine_from(lambda x, y: fit(*self._pre(x, y)))

    def _solve_pairs(self, pairs):
        """Solve the control-point tier from >=2 clean pairs, or None when the solve is
        degenerate (coincident/collinear sources — the caller then falls back to fit). Works in
        a Y-**down** pre-projected plane (`v = -y`): the plan frame is Y-down while source
        coordinates are Y-up, and folding that flip into the working plane keeps it out of the
        similarity, which (unlike a full affine) cannot express a reflection and would absorb
        it as a bogus rotation."""
        src = [self._pre(sx, sy) for (sx, sy), _ in pairs]
        uv = [(x, -y) for x, y in src]
        dst = [d for _, d in pairs]
        plane = (self._similarity(uv, dst) if len(pairs) == 2
                 else self._lsq_affine(uv, dst))
        if plane is None or not all(math.isfinite(v) for v in plane):
            return None
        # Compose the working-plane affine with the pre-projection (u = k·x, v = -y).
        p, q, r, s, t, w = plane
        return (p * self._k, -q, r, s * self._k, -t, w)

    @staticmethod
    def _similarity(uv, dst):
        """Exact 2-point similarity in the working plane, via complex arithmetic: find A, B
        with `dst = A·uv + B` (A encodes rotation + uniform scale). None when the two source
        points coincide (no scale is defined)."""
        s0, s1 = (complex(*p) for p in uv)
        d0, d1 = (complex(*p) for p in dst)
        span = s1 - s0
        if abs(span) < 1e-12:
            return None
        a = (d1 - d0) / span
        b = d0 - a * s0
        return (a.real, -a.imag, b.real, a.imag, a.real, b.imag)

    @classmethod
    def _lsq_affine(cls, uv, dst):
        """Least-squares affine (6 dof) in the working plane: two independent 3-unknown
        normal-equation systems (one per output axis) over rows `[u, v, 1]`. None when the
        normal matrix is singular (collinear source points can't pin an affine)."""
        m = [[0.0] * 3 for _ in range(3)]
        rx, ry = [0.0] * 3, [0.0] * 3
        for (u, v), (dx, dy) in zip(uv, dst):
            row = (u, v, 1.0)
            for i in range(3):
                for j in range(3):
                    m[i][j] += row[i] * row[j]
                rx[i] += row[i] * dx
                ry[i] += row[i] * dy
        top = cls._solve3(m, rx)
        bot = cls._solve3(m, ry)
        if top is None or bot is None:
            return None
        return (*top, *bot)

    @staticmethod
    def _solve3(m, rhs):
        """Solve a 3×3 linear system by Gaussian elimination with partial pivoting, or None
        when singular. `m`/`rhs` are left unmodified (worked on copies — `_lsq_affine` reuses
        the normal matrix for both axes)."""
        a = [list(m[i]) + [rhs[i]] for i in range(3)]
        for col in range(3):
            pivot = max(range(col, 3), key=lambda r: abs(a[r][col]))
            if abs(a[pivot][col]) < 1e-12:
                return None
            a[col], a[pivot] = a[pivot], a[col]
            for r in range(3):
                if r != col:
                    factor = a[r][col] / a[col][col]
                    for c in range(col, 4):
                        a[r][c] -= factor * a[col][c]
        return tuple(a[i][3] / a[i][i] for i in range(3))

    # ---- helpers ----
    @staticmethod
    def _affine_from(fn):
        """Recover the 6-tuple of an affine map by evaluating it at the basis points — every
        placement path here is affine, so three evaluations pin it exactly."""
        ox, oy = fn(0.0, 0.0)
        x1, y1 = fn(1.0, 0.0)
        x2, y2 = fn(0.0, 1.0)
        return (x1 - ox, x2 - ox, ox, y1 - oy, y2 - oy, oy)

    @classmethod
    def _clean_pairs(cls, align):
        """The structurally-valid pairs in `align`: each a `{"src": [x, y], "dst": [nx, ny]}`
        of finite numbers. `align` is operator input riding the import map, so anything else —
        wrong container, short lists, NaN/bool — is dropped rather than trusted."""
        if not isinstance(align, list):
            return []
        pairs = []
        for entry in align:
            if not isinstance(entry, dict):
                continue
            src = cls._point(entry.get("src"))
            dst = cls._point(entry.get("dst"))
            if src and dst:
                pairs.append((src, dst))
        return pairs

    @staticmethod
    def _point(v):
        """`v` as a finite `(x, y)` tuple, or None when it isn't a valid numeric pair."""
        if (isinstance(v, (list, tuple)) and len(v) >= 2
                and all(isinstance(c, (int, float)) and not isinstance(c, bool)
                        and math.isfinite(c) for c in v[:2])):
            return (float(v[0]), float(v[1]))
        return None


def _scaled_px(base_px, quality):
    """A vector handler's target pixel size for the operator's render-quality multiplier — the
    `RENDER_PX` analogue of `PdfFormat._render_scale`, shared by the SVG and DXF handlers. A
    falsy/negative multiplier (a malformed `--scale`) falls back to standard rather than rendering
    a degenerate 0-px image."""
    quality = quality if quality and quality > 0 else 1.0
    return max(1, int(base_px * quality))


def save_kwargs(fmt):
    """Pillow save options per OUTPUT format. WebP build artifacts are always lossless — plan
    renders are line work, where compression artifacts would read as drawing content."""
    return {"lossless": True, "method": 6} if fmt == "WEBP" else {}


# Longest side of a raster thumbnail: the wizard's mapping-grid thumbnails and the per-floor card
# thumbnail written into the manifest. Shared by RasterFormat and Preprocessor.write_floor_thumb.
THUMB_MAX_PX = 600


class DrawingFormat:
    """One accepted drawing-input format. Declares its file extensions + magic sniff and knows
    how to turn a source file into map content — a base raster (`BASE_RASTER`) or a set of
    overlay features (`OVERLAY`). Subclasses own their optional decoder/parser dependency and
    lazy-import it inside the render/extract methods (see the module isolation contract).

    A handler implements only the methods for its `role`: BASE_RASTER handlers implement
    `render_full`/`render_thumb`; OVERLAY handlers implement `extract_overlay`. The base
    implementations raise `NotImplementedError`, so the dispatchers in `preprocess.py` (which gate
    on `role`) never call the wrong one.

    Registry schema (class attributes):
      name            short format tag returned by `sniff` (e.g. 'pdf', 'png')
      exts            accepted lowercase extensions, e.g. ('.pdf',)
      role            BASE_RASTER (renders a background image) or OVERLAY (extracts data features)
      requires        human-readable name of the pip package / external binary the render/extract
                      methods need — surfaced in `preprocess.py`'s "could not render (need …)" hint
      requires_module top-level module name(s) whose presence makes this format available, probed
                      import-safely via `find_spec` (available only when **all** are installed).
                      Empty → no pip decoder to gate (a core or binary-only format). See PKG-1.
      requires_binary external executable alternative(s) probed via `shutil.which` (available when
                      **any** is found — e.g. `soffice`/`libreoffice` for Visio). Empty → no binary.
      extra           the pip extra that installs this format (e.g. 'svg'/'cad'/'gis'), used to
                      build `install_hint`. Empty for a core format or a binary-only one.
      companions      sibling extensions that ride along with the primary file (a Shapefile set),
                      NOT themselves drawings — see the module docstring's companion note. Empty for
                      the common self-contained single-file format.
    """

    name = ""
    exts = ()
    role = BASE_RASTER
    requires = ""
    requires_module = ()
    requires_binary = ()
    extra = ""
    companions = ()

    def available(self):
        """True if this format's decoder/binary is installed, so it should be offered for import.
        Probed WITHOUT importing the heavy decoder into the worker (`find_spec`/`which` only — the
        module-isolation contract): available iff **every** `requires_module` is importable and, if
        any `requires_binary` is declared, **at least one** is on PATH. A format declaring neither
        (a core format) is always available."""
        if not all(_module_installed(m) for m in self.requires_module):
            return False
        if self.requires_binary and not any(shutil.which(b) for b in self.requires_binary):
            return False
        return True

    def install_hint(self):
        """A helpful upload-rejection message when this format is recognized but NOT installed —
        naming the pip extra (or external binary) to add, e.g. "SVG support requires
        `pip install netbox-facilitymap[svg]`". Falls back to the human `requires` string for a
        binary-only format (Visio → soffice), then a generic message."""
        label = (self.name or "this format").upper()
        if self.extra:
            return "%s support requires `pip install netbox-facilitymap[%s]`" % (label, self.extra)
        if self.requires:
            return "%s support requires %s" % (label, self.requires)
        return "%s support is not installed" % label

    def sniff(self, head):
        """True if `head` (a file's leading bytes) carries this format's signature."""
        raise NotImplementedError

    def sniff_companion(self, ext, head):
        """True if `head` is plausibly this format's `ext` companion sibling. Companions have
        weak/absent magic and are parsed only in the render subprocess, so this is a lenient
        first-line upload gate, not the real validation (mirrors `sniff`). The base rejects
        everything — a format without `companions` never reaches here."""
        return False

    def render_full(self, path, fmt="WEBP", page=0, quality=1.0):
        """(BASE_RASTER) Render the drawing to encoded `(raw, w, h)` at full scale, or None when
        the decoder is missing or the file can't be decoded. `fmt` is the output encoding (WEBP for
        build artifacts, PNG for the wizard's preview cache). `page` is the 0-based page index for a
        multi-page source (only PDFs have >1 page — see `page_count`); every single-page format
        ignores it.

        `quality` is the operator's render-quality multiplier (1.0 = standard; the `render_hq`
        setting sends 1.5, ~216 vs ~144 DPI — see `imports.RenderRunner`). It only means anything
        for a source the renderer **rasterizes from vectors**, where more pixels resolve more
        detail: a PDF/SVG/DXF honours it, a `RasterFormat` scan has fixed pixels and ignores it.
        Every handler bounds the result by its own `MAX_IMAGE_PX`, so a raised quality can never
        grow a sheet without limit (the render subprocess is address-space-capped — see
        `imports.RenderRunner._effective_mem_mb`)."""
        raise NotImplementedError

    def render_thumb(self, path, out_path):
        """(BASE_RASTER) Render a small PNG thumbnail to `out_path` for the wizard's mapping grid.
        Returns True on success. Only the first page/frame is thumbnailed."""
        raise NotImplementedError

    def extract_overlay(self, path, align=None):
        """(OVERLAY) Parse a data/overlay source into its manifest overlay payload, or None when
        the parser is missing or the file can't be decoded. `align` is the layer's optional
        control-point georeference (the import map's `overlayAlign` pairs); with none the layer
        is placed fit-to-bounds. Returns a dict:

            {"features": [{"type": "point" | "line" | "polygon",
                           "coords": [nx, ny]              # point
                                   | [[nx, ny], ...],      # line / polygon (0..1)
                           "props": { ... }},              # source attributes (hover title)
                          ...],
             "georeferenced": bool,          # control-point tier actually used?
             "crs": "geographic" | "projected" | "unknown",
             "srcTransform": [a, b, c, d, e, f]}   # raw-source→unit affine (see OverlayProjector)

        Features are projected into the floor's normalized 0..1 frame through one shared
        `OverlayProjector`. Lazy-import the parser inside this method (the module isolation
        contract): it runs only in the render subprocess, never in the NetBox worker."""
        raise NotImplementedError

    def page_count(self, path):
        """Number of independently-mappable pages in `path`. 1 for every single-page format;
        only `PdfFormat` overrides this (a multi-page PDF explodes into one floor per page, see
        `preprocess.build_building_from_pdfs`). Never raises — an unreadable source counts as 1."""
        return 1


class PdfFormat(DrawingFormat):
    """PDF floor/siteplan drawings, rendered with PDFium. Facility PDFs carry no text layer, so
    only the raster matters — no text/JS/embedded content is executed. A PDF is the one format
    with >1 mappable page: a multi-page set explodes into one floor per page (see `page_count`
    and `preprocess.build_building_from_pdfs`)."""

    name = "pdf"
    exts = (".pdf",)
    requires = "pypdfium2"
    requires_module = ("pypdfium2",)   # a core dep — always installed, so PDF is always available

    RENDER_SCALE = 2.0   # full floor-plan render scale; coords are normalized 0..1 downstream
    THUMB_SCALE = 0.6    # wizard thumbnail scale (legible enough to identify a plan)
    # Ceiling on a rendered page's longest side, in pixels. A PDF is the one format whose output
    # size is decided purely by a scale factor (a raster's is its own pixels), so without this
    # nothing downstream bounds a sheet: area grows with the SQUARE of the scale, and a big E-size
    # sheet at raised quality would blow past the render subprocess's RLIMIT_AS and surface as a
    # failed import. Enforced by *lowering the scale before rendering* (see `_render_scale`) —
    # downscaling after the fact would already have spent the memory. Sized so standard quality is
    # untouched: the largest common sheet (E-size, 2448x3168pt) renders 4896x6336 at RENDER_SCALE,
    # comfortably under; only a raised `quality` (or a genuinely enormous page) ever clamps.
    MAX_IMAGE_PX = 8000

    def sniff(self, head):
        return head.startswith(b"%PDF-")

    @staticmethod
    def _page(path, page):
        import pypdfium2 as pdfium
        return pdfium.PdfDocument(path)[page]

    def _render_scale(self, page, quality):
        """The PDFium render scale to actually use for `page` at `quality` — `RENDER_SCALE` scaled
        by the operator's multiplier, then lowered just enough to keep the longest side within
        `MAX_IMAGE_PX`.

        Deriving the clamp from the page's own **point size** (rather than capping the pixels after
        the fact) is what makes a raised quality safe: the oversized bitmap is never allocated. It
        also evens out pixel density across sheet sizes — a letter sheet gets the full multiplier
        while a huge E-size sheet, which was already dense in absolute pixels, gives some of it
        back. A page whose size can't be read (a damaged/odd PDF) renders at the unclamped scale and
        is left to the subprocess's rlimits, the same backstop as before."""
        quality = quality if quality and quality > 0 else 1.0
        scale = self.RENDER_SCALE * quality
        try:
            longest_px = max(page.get_size()) * scale
        except Exception:
            return scale
        if longest_px > self.MAX_IMAGE_PX:
            scale *= self.MAX_IMAGE_PX / longest_px
        return scale

    def page_count(self, path):
        try:
            import pypdfium2 as pdfium
            return len(pdfium.PdfDocument(path))
        except Exception:
            return 1

    def render_full(self, path, fmt="WEBP", page=0, quality=1.0):
        try:
            pg = self._page(path, page)
            pil = pg.render(scale=self._render_scale(pg, quality)).to_pil().convert("RGB")
            buf = io.BytesIO()
            pil.save(buf, fmt, **save_kwargs(fmt))
            return buf.getvalue(), pil.width, pil.height
        except Exception:
            return None

    def render_thumb(self, path, out_path):
        try:
            pil = self._page(path, 0).render(scale=self.THUMB_SCALE).to_pil().convert("RGB")
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            pil.save(out_path, "PNG")
            return True
        except Exception as e:
            print("WARN thumb %s: %s" % (path, e), file=sys.stderr)
            return False


class RasterFormat(DrawingFormat):
    """Base for Pillow-decoded raster plans (public measured-drawing scans ship as TIFF/JPEG/GIF,
    never PDF). Shared render behaviour; each concrete subtype only differs in name/exts/magic.
    Pillow's default decompression-bomb guard is left on, so an oversized/malicious raster fails
    the render (None) rather than exhausting the child.

    The size-cap + encode / thumbnail pipeline below is shared through the `_load` seam: a
    subtype that decodes a *non-raster* source (e.g. SVG rasterized via CairoSVG) overrides
    `_load` to return an upright RGB PIL image and inherits the rest unchanged. `_load` is also
    where the render-quality multiplier lands: a true raster ignores it (see `_load` below), while
    a vector subtype scales its target size by it."""

    requires = "Pillow"
    requires_module = ("PIL",)   # Pillow's import name; a core dep — rasters are always available
    MAX_IMAGE_PX = 4000  # cap the longest side of a rendered raster (downscale only)

    def _load(self, path, quality=1.0):
        """Return an upright, RGB-flattened PIL image for `path`, or raise. EXIF transpose is the
        raster analogue of the PDF renderer honoring page rotation, so camera/scanner JPEGs land
        upright (no-op without the tag). Subtypes decoding a non-raster source override this.

        `quality` is **deliberately ignored here**: a scan's detail is fixed at its own pixel grid,
        so re-rendering it "higher quality" would only upsample — more bytes, no more legibility.
        The parameter exists for the vector subtypes below (SVG/DXF), which rasterize from source
        geometry and genuinely resolve more at a larger target size."""
        from PIL import Image, ImageOps
        with Image.open(path) as im:
            return ImageOps.exif_transpose(im).convert("RGB")

    @staticmethod
    def _svg_to_rgb(width, *, url=None, bytestring=None):
        """Rasterize an SVG — a file `url` or an in-memory `bytestring` — to an upright RGB PIL
        image `width` px wide, transparency flattened onto white (matching paper). Shared by the SVG
        handler (from a file) and any handler that renders to SVG first (DXF, via ezdxf). Rendered
        with `unsafe=False` — CairoSVG's default — which refuses external/file resource references
        and never executes embedded scripts, belt-and-suspenders atop the render subprocess's
        rlimits. Lazy-imports CairoSVG inside the render path (module isolation contract) — it loads
        only in the render subprocess, never in the NetBox worker."""
        import cairosvg
        from PIL import Image
        png = cairosvg.svg2png(url=url, bytestring=bytestring, output_width=width,
                               background_color="white", unsafe=False)
        return Image.open(io.BytesIO(png)).convert("RGB")

    def render_full(self, path, fmt="WEBP", page=0, quality=1.0):
        # A raster is a single frame — `page` is accepted for a uniform render interface but ignored.
        # `quality` reaches the `_load` seam, where a true raster drops it and a vector subtype
        # (SVG/DXF) scales its target size by it; MAX_IMAGE_PX below bounds either way.
        try:
            im = self._load(path, quality)
            if max(im.size) > self.MAX_IMAGE_PX:
                im.thumbnail((self.MAX_IMAGE_PX, self.MAX_IMAGE_PX))
            buf = io.BytesIO()
            im.save(buf, fmt, **save_kwargs(fmt))
            return buf.getvalue(), im.width, im.height
        except Exception:
            return None

    def render_thumb(self, path, out_path):
        try:
            im = self._load(path)
            im.thumbnail((THUMB_MAX_PX, THUMB_MAX_PX))
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            im.save(out_path, "PNG")
            return True
        except Exception as e:
            print("WARN thumb %s: %s" % (path, e), file=sys.stderr)
            return False


class PngFormat(RasterFormat):
    name = "png"
    exts = (".png",)

    def sniff(self, head):
        return head.startswith(b"\x89PNG\r\n\x1a\n")


class JpegFormat(RasterFormat):
    name = "jpeg"
    exts = (".jpg", ".jpeg")

    def sniff(self, head):
        return head.startswith(b"\xff\xd8\xff")


class GifFormat(RasterFormat):
    name = "gif"
    exts = (".gif",)

    def sniff(self, head):
        return head[:6] in (b"GIF87a", b"GIF89a")


class TiffFormat(RasterFormat):
    name = "tiff"
    exts = (".tif", ".tiff")

    def sniff(self, head):
        return head[:4] in (b"II*\x00", b"MM\x00*")


class BmpFormat(RasterFormat):
    name = "bmp"
    exts = (".bmp",)

    def sniff(self, head):
        return head[:2] == b"BM"


class WebpFormat(RasterFormat):
    name = "webp"
    exts = (".webp",)

    def sniff(self, head):
        # Read at least 12 bytes so the RIFF....WEBP pair can be checked.
        return head[:4] == b"RIFF" and head[8:12] == b"WEBP"


class SvgFormat(RasterFormat):
    """SVG vector drawings, rasterized to a base raster with CairoSVG, then flowed through the
    shared raster encode/thumbnail path (a floor plan is a single 2D page). The CairoSVG call —
    including the `unsafe=False` hardening — lives in the shared `_svg_to_rgb` seam."""

    name = "svg"
    exts = (".svg",)
    requires = "cairosvg"
    requires_module = ("cairosvg",)   # the optional `[svg]` extra (PIL is core, always present)
    extra = "svg"
    RENDER_PX = 2000   # target longest side; SVG intrinsic sizes are unreliable for a floor plan

    def sniff(self, head):
        # SVG has no binary magic — it's XML text. Accept a leading XML declaration, a bare <svg>
        # root, or a DOCTYPE, tolerating a UTF-8 BOM + leading whitespace. This is only the cheap
        # upload gate; the real validation is CairoSVG rasterizing the file downstream.
        s = head.lstrip(b"\xef\xbb\xbf").lstrip().lower()
        return s.startswith((b"<?xml", b"<svg", b"<!doctype"))

    def _load(self, path, quality=1.0):
        # Force a legible width (SVG declared units are unreliable for a floor plan); the shared
        # seam does the CairoSVG rasterize + white flatten (and lazy-imports the decoder). An SVG
        # rasterizes from vectors, so `quality` genuinely buys detail here — it scales the target
        # width, and RasterFormat.render_full's MAX_IMAGE_PX still bounds the result.
        return self._svg_to_rgb(_scaled_px(self.RENDER_PX, quality), url=path)


class DxfFormat(RasterFormat):
    """AutoCAD DXF 2D vector CAD drawings. `ezdxf` (pure-Python, no Matplotlib) renders the
    modelspace to an SVG string via its native drawing add-on SVG backend; that SVG is then
    rasterized through the shared CairoSVG seam (a floor plan is one 2D page), inheriting the raster
    size-cap / encode / thumbnail pipeline. Because it needs both decoders, DXF is the optional
    `[cad]` extra — which bundles `ezdxf` **and** `cairosvg` — and each is lazy-imported in the
    render path (module isolation contract). The registry gates `.dxf` off entirely unless both are
    installed (`requires_module = ('ezdxf', 'cairosvg')`); if the format is offered but `libcairo`
    is missing at render time, the render degrades to None (inherited from RasterFormat)."""

    name = "dxf"
    exts = (".dxf",)
    requires = "ezdxf"
    # The optional `[cad]` extra installs BOTH: ezdxf renders the modelspace to an SVG which
    # cairosvg then rasterizes, so DXF is available only when both modules are present.
    requires_module = ("ezdxf", "cairosvg")
    extra = "cad"
    RENDER_PX = 2000   # target longest side; CAD is real-world units at arbitrary scale

    # Binary DXF opens with the 22-byte sentinel `AutoCAD Binary DXF\r\n\x1a\x00`; the upload sniff
    # window is only 16 bytes, so match its 16-byte prefix (distinctive enough — no real non-DXF
    # file opens with this).
    _BINARY_PREFIX = b"AutoCAD Binary D"

    def sniff(self, head):
        if head.startswith(self._BINARY_PREFIX):
            return True
        # ASCII DXF has no fixed magic — it's a group-code text stream that opens with the HEADER
        # SECTION. Accept a text head carrying the SECTION marker (tolerating a leading BOM); a NUL
        # means the bytes are binary, not an ASCII DXF. Cheap upload gate; the real validation is
        # ezdxf decoding the file downstream.
        s = head.lstrip(b"\xef\xbb\xbf")
        return b"SECTION" in s and b"\x00" not in s

    def _load(self, path, quality=1.0):
        # Lazy-import ezdxf inside the render path (module isolation contract): it loads only in the
        # render subprocess, never in the NetBox worker. Render the modelspace (the plan) to an SVG
        # string with ezdxf's native SVG backend (NOT the Matplotlib one), fit to a single auto-sized
        # page, then hand it to the shared CairoSVG seam at a `quality`-scaled target size (CAD is
        # vectors, so the extra pixels resolve real detail — same reasoning as SvgFormat).
        import ezdxf
        from ezdxf.addons.drawing import Frontend, RenderContext, layout, svg
        doc = ezdxf.readfile(path)
        backend = svg.SVGBackend()
        Frontend(RenderContext(doc), backend).draw_layout(doc.modelspace())
        svg_str = backend.get_string(layout.Page(0, 0))   # 0, 0 -> auto-fit to content extents
        return self._svg_to_rgb(_scaled_px(self.RENDER_PX, quality),
                                bytestring=svg_str.encode("utf-8"))


class SofficeFormat(DrawingFormat):
    """Base for drawing formats that have no Python renderer but that LibreOffice headless
    (`soffice`) can convert to PDF — the converted PDF is then handed to the existing hardened
    `PdfFormat` renderer. Unlike every other handler its `requires` is not a pip decoder but an
    **optional external binary**: if `soffice` isn't on PATH the render degrades gracefully
    (returns None + the usual "could not render" hint), exactly as SVG degrades without libcairo.

    Isolation is preserved: the conversion runs only inside `render_*`, i.e. only in the
    `preprocess.py` render subprocess, so its timeout + CPU/address-space rlimits bound `soffice`
    too. The source is never unpacked here — `soffice` parses it (a VSDX is itself a zip) inside
    that sandbox, so its zip-bomb/traversal surface is capped the same way an untrusted PDF is."""

    _pdf = PdfFormat()          # delegate render/thumb to the hardened PDF path after conversion
    SOFFICE_TIMEOUT_S = 120     # inner cap; the subprocess's render_timeout_s/RLIMIT_CPU is the backstop
    requires = "the 'soffice' (LibreOffice) binary on PATH"
    # Visio has no pip decoder — availability gates on the external LibreOffice binary (either
    # name), so `extra` stays empty and `install_hint` falls back to the `requires` string above.
    requires_binary = ("soffice", "libreoffice")

    def _convert(self, path, out_dir):
        """Convert `path` to a PDF inside `out_dir` with LibreOffice headless; return the produced
        PDF path, or None when `soffice` is absent or the conversion fails/times out (never
        raises, so the caller degrades gracefully). A per-run `-env:UserInstallation` profile
        keeps a concurrent desktop LibreOffice's profile lock from failing the conversion."""
        import glob
        import shutil
        import subprocess
        soffice = shutil.which("soffice") or shutil.which("libreoffice")
        if not soffice:
            return None
        profile = os.path.join(out_dir, "profile")
        try:
            subprocess.run(
                [soffice, "-env:UserInstallation=file://%s" % profile,
                 "--headless", "--convert-to", "pdf", "--outdir", out_dir, path],
                capture_output=True, timeout=self.SOFFICE_TIMEOUT_S, check=True)
        except (subprocess.SubprocessError, OSError):
            return None
        pdfs = glob.glob(os.path.join(out_dir, "*.pdf"))
        return pdfs[0] if pdfs else None

    def render_full(self, path, fmt="WEBP", page=0, quality=1.0):
        # Visio converts to PDF, so `quality` rides through to the hardened PDF renderer — and with
        # it that renderer's point-size-derived MAX_IMAGE_PX clamp.
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            pdf = self._convert(path, tmp)
            return self._pdf.render_full(pdf, fmt, page, quality) if pdf else None

    def render_thumb(self, path, out_path):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            pdf = self._convert(path, tmp)
            return self._pdf.render_thumb(pdf, out_path) if pdf else False


class VsdxFormat(SofficeFormat):
    """Modern Visio diagrams (OOXML zip package), converted to PDF via `soffice`."""

    name = "vsdx"
    exts = (".vsdx",)

    def sniff(self, head):
        # VSDX is a zip, so the magic is the generic ZIP local-file header — a cheap upload gate
        # only. The extension gate and the `soffice` decode downstream are the real filters.
        return head.startswith(b"PK\x03\x04")


class VsdFormat(SofficeFormat):
    """Legacy Visio diagrams (OLE compound binary), converted to PDF via `soffice`."""

    name = "vsd"
    exts = (".vsd",)

    def sniff(self, head):
        # OLE2 / Compound File Binary Format magic (also shared by legacy .doc/.xls, none of which
        # are accepted extensions); the `soffice` decode downstream rejects a non-Visio file.
        return head.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")


# dBASE version flags (byte 0 of a `.dbf`) accepted for a Shapefile's attribute companion. The
# low nibble is the dBASE level (III/IV/5) and the high bits flag a memo/DBT; this is the common
# real-world set. A lenient upload gate only — pyshp does the real parse in the subprocess.
_DBF_VERSIONS = frozenset(
    {0x02, 0x03, 0x04, 0x05, 0x30, 0x31, 0x32, 0x43, 0x63, 0x83, 0x8B, 0x8E, 0xCB, 0xF5, 0xFB})


class ShapefileFormat(DrawingFormat):
    """ESRI Shapefile GIS vectors, imported as a read-only **data overlay** (the FMT-9 OVERLAY
    role) rather than a base plan. A Shapefile is a multi-file *set* — the `.shp` geometry plus
    sibling `.shx` (index), `.dbf` (attributes), and optional `.prj` (CRS) / `.cpg` (encoding),
    declared as `companions` so the upload layer keeps the set together (see the module docstring).

    Coordinates are projected into the floor's 0..1 frame through the shared `OverlayProjector`
    (fit-to-bounds by default; a control-point georeference when the import map carries
    `overlayAlign` pairs, FMT-6). The `.prj` sibling is consulted only for its CRS *family*
    (`_crs_kind`: geographic lon/lat vs projected planar — driving the projector's
    equirectangular pre-scale), never for a full CRS reprojection, which would need a heavy GIS
    runtime. pyshp is pure-Python (no GDAL/native deps); like every decoder it is lazy-imported
    inside `extract_overlay`, so it loads only in the render subprocess."""

    name = "shp"
    exts = (".shp",)
    role = OVERLAY
    requires = "pyshp"
    requires_module = ("shapefile",)   # pyshp's import name; the optional `[gis]` extra
    extra = "gis"
    companions = (".shx", ".dbf", ".prj", ".cpg")

    MAX_FEATURES = 5000   # cap features flowed into the manifest/overlay (bounds size + frontend cost)
    _MAGIC = b"\x00\x00\x27\x0a"   # shapefile main/index header: file code 9994, big-endian

    def sniff(self, head):
        return head[:4] == self._MAGIC

    def sniff_companion(self, ext, head):
        if ext == ".shx":
            return head[:4] == self._MAGIC        # the index file shares the .shp header magic
        if ext == ".dbf":
            return bool(head) and head[0] in _DBF_VERSIONS
        # .prj (WKT) and .cpg (encoding name) are short text with no reliable magic; accept any
        # non-empty file that isn't binary — the parser downstream is the real check.
        return bool(head) and b"\x00" not in head

    def extract_overlay(self, path, align=None):
        # Lazy-import the parser inside the extract path (module isolation contract): pyshp loads
        # only in the render subprocess, never in the NetBox worker.
        try:
            import shapefile   # pyshp
        except ImportError:
            return None
        try:
            reader = shapefile.Reader(path)   # pyshp opens the .shx/.dbf siblings by shared basename
            shapes = reader.shapes()
        except Exception:
            return None
        # One projector shared by every feature, built from all points at once, so the whole
        # layer lands in a single frame (see OverlayProjector). Y is flipped there.
        all_points = [pt for shp in shapes for pt in (shp.points or ())]
        if not all_points:
            return None
        proj = OverlayProjector(all_points, crs=self._crs_kind(path), align=align)
        feats = []
        for i, shp in enumerate(shapes):
            if len(feats) >= self.MAX_FEATURES:
                break
            props = self._record_props(reader, i)
            for feat in self._shape_features(shp, proj.project):
                feat["props"] = props
                feats.append(feat)
                if len(feats) >= self.MAX_FEATURES:
                    break
        if not feats:
            return None
        return {"features": feats, **proj.meta()}

    @staticmethod
    def _crs_kind(path):
        """The layer's CRS *family* from its sibling `.prj` — "geographic" (lon/lat degrees,
        gets the equirectangular pre-scale) vs "projected" (planar units), read off the WKT
        root keyword only (`GEOGCS`/`GEOGCRS` vs `PROJCS`/`PROJCRS`, WKT1 and WKT2 spellings).
        "unknown" — treated planar — when the `.prj` is absent or unrecognized: guessing
        geographic from coordinate ranges would misread a small local planar grid, and the
        cost of "unknown" is only the pre-1.x planar behaviour."""
        base = os.path.splitext(path)[0]
        for ext in (".prj", ".PRJ"):
            try:
                with open(base + ext, encoding="utf-8", errors="replace") as fh:
                    head = fh.read(64)
            except OSError:
                continue
            token = head.lstrip("\ufeff").lstrip()
            token = token.split("[", 1)[0].split("(", 1)[0].strip().upper()
            if token in ("GEOGCS", "GEOGCRS"):
                return OverlayProjector.GEOGRAPHIC
            if token in ("PROJCS", "PROJCRS"):
                return "projected"
            return "unknown"
        return "unknown"

    @staticmethod
    def _record_props(reader, i):
        """The i-th feature's attribute record as a flat dict, or {} when the `.dbf` is absent or
        unreadable (geometry still imports without attributes)."""
        try:
            return dict(reader.record(i).as_dict())
        except Exception:
            return {}

    def _shape_features(self, shp, project):
        """Split one pyshp shape into normalized-0..1 overlay features. A point/multipoint yields
        one `point` per coordinate; a polyline/polygon yields one `line`/`polygon` per part (ring).
        Null/empty shapes and empty parts yield nothing. `props` is attached by the caller."""
        stype = getattr(shp, "shapeType", 0)
        pts = shp.points or []
        if not pts:
            return
        # pyshp shapeType families: 1/11/21 point, 8/18/28 multipoint, 3/13/23 polyline,
        # 5/15/25 polygon. Reduce Z/M variants to the base family via mod 10.
        base = stype % 10
        if base == 1 or base == 8:            # point / multipoint
            for x, y in pts:
                yield {"type": "point", "coords": list(project(x, y))}
            return
        if base == 3 or base == 5:            # polyline / polygon
            kind = "line" if base == 3 else "polygon"
            for part in self._parts(shp, pts):
                if len(part) >= 2:
                    yield {"type": kind, "coords": [list(project(x, y)) for x, y in part]}

    @staticmethod
    def _parts(shp, pts):
        """Yield each part (ring/segment) of a multi-part shape as its own point list, using
        pyshp's `parts` start-index array. A single-part shape yields the whole point list."""
        starts = list(getattr(shp, "parts", None) or [0])
        bounds = starts + [len(pts)]
        for a, b in zip(bounds, bounds[1:]):
            yield pts[a:b]


class GeoJsonFormat(DrawingFormat):
    """GeoJSON GIS vectors (RFC 7946), imported as a read-only **data overlay** (the FMT-9 OVERLAY
    role) rather than a base plan — the sister format to `ShapefileFormat` and a **single
    self-contained JSON file** parsed with the standard library `json`, so it needs **no decoder of
    its own**. It is nonetheless a geospatial import, so PKG-1 ships it as part of the optional
    `[gis]` package alongside Shapefile rather than in the lean default set. Having no decoder to
    probe, it gates on the `[gis]` **marker** — pyshp (import name `shapefile`) — so Shapefile and
    GeoJSON light up together when `[gis]` is installed. (`requires` stays empty: a *reachable*
    GeoJSON is already installed, so a parse failure is a malformed source, not a missing dep — see
    `preprocess._render_hint`.)

    Coordinates are GeoJSON positions `[lon, lat]` — WGS84 by spec (RFC 7946), so the layer is
    always CRS-family **geographic** — projected into the floor's 0..1 frame through the shared
    `OverlayProjector` (equirectangular pre-scale + fit-to-bounds by default; a control-point
    georeference when the import map carries `overlayAlign` pairs, FMT-6 — same convention as
    Shapefile). `json` is lazy-imported inside `extract_overlay` (module isolation contract), so
    it loads only in the render subprocess."""

    name = "geojson"
    exts = (".geojson",)
    role = OVERLAY
    requires_module = ("shapefile",)   # gates on the `[gis]` marker (pyshp); no decoder of its own
    extra = "gis"
    companions = ()

    MAX_FEATURES = 5000   # cap features flowed into the manifest/overlay (bounds size + frontend cost)

    # The concrete geometry types that carry `coordinates`; `FeatureCollection`/`Feature`/
    # `GeometryCollection` are containers flattened away in `_iter_geoms`.
    _GEOM_TYPES = frozenset(
        {"Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"})

    def sniff(self, head):
        # GeoJSON has no binary magic — it's a JSON object (always `{...}`). Accept a text head
        # opening with `{`, tolerating a UTF-8 BOM + leading whitespace; a NUL means binary, not
        # JSON. This is only the cheap upload gate (the 16-byte window can't see a later
        # `"type":"FeatureCollection"`); the real validation is `json.load` + the structure check
        # in `extract_overlay` downstream.
        s = head.lstrip(b"\xef\xbb\xbf").lstrip()
        return s.startswith(b"{") and b"\x00" not in head

    def extract_overlay(self, path, align=None):
        # Lazy-import inside the extract path (module isolation contract); stdlib, but kept off the
        # module top level so this module stays import-safe for the worker like every handler.
        import json
        try:
            with open(path, encoding="utf-8-sig") as fh:
                data = json.load(fh)
        except (OSError, ValueError, UnicodeDecodeError):
            return None
        geoms = list(self._iter_geoms(data, {}))
        # One projector shared by every feature, built from all points at once, so the whole
        # layer lands in a single frame (see OverlayProjector). Y is flipped there.
        all_points = [pt for geom, _ in geoms for pt in self._positions(geom.get("coordinates"))]
        if not all_points:
            return None
        proj = OverlayProjector(all_points, crs=OverlayProjector.GEOGRAPHIC, align=align)
        feats = []
        for geom, props in geoms:
            for feat in self._geom_features(geom, proj.project):
                feat["props"] = props
                feats.append(feat)
                if len(feats) >= self.MAX_FEATURES:
                    return {"features": feats, **proj.meta()}
        if not feats:
            return None
        return {"features": feats, **proj.meta()}

    def _iter_geoms(self, node, props):
        """Flatten a GeoJSON tree into `(geometry, props)` pairs of concrete geometries. Descends
        `FeatureCollection` → `Feature` → its geometry and `GeometryCollection` → its members,
        carrying each Feature's `properties` down to the concrete geometries it contains. A bare
        top-level `Feature` or `Geometry` is accepted too. Non-dict / unknown nodes yield nothing."""
        if not isinstance(node, dict):
            return
        gtype = node.get("type")
        if gtype == "FeatureCollection":
            for feat in node.get("features") or ():
                yield from self._iter_geoms(feat, props)
        elif gtype == "Feature":
            fp = node.get("properties")
            fp = fp if isinstance(fp, dict) else {}
            yield from self._iter_geoms(node.get("geometry"), fp)
        elif gtype == "GeometryCollection":
            for geom in node.get("geometries") or ():
                yield from self._iter_geoms(geom, props)
        elif gtype in self._GEOM_TYPES:
            yield (node, props)

    @classmethod
    def _positions(cls, coords):
        """Yield every `(x, y)` leaf position under a geometry's nested `coordinates` array,
        regardless of nesting depth (Point is one position, MultiPolygon is four levels deep). A
        position is a list whose first two elements are numbers; extra elements (elevation) are
        ignored."""
        if not isinstance(coords, list) or not coords:
            return
        if cls._is_number(coords[0]):
            if len(coords) >= 2 and cls._is_number(coords[1]):
                yield (coords[0], coords[1])
            return
        for child in coords:
            yield from cls._positions(child)

    def _geom_features(self, geom, project):
        """Split one concrete GeoJSON geometry into normalized-0..1 overlay features via `project`.
        A point/multipoint yields one `point` per position; a line/multiline yields one `line` per
        LineString; a polygon/multipolygon yields one `polygon` per ring (mirroring how
        `ShapefileFormat` splits a multi-part shape into a feature per part). Invalid/empty
        coordinates yield nothing. `props` is attached by the caller."""
        gtype = geom.get("type")
        coords = geom.get("coordinates")
        if not isinstance(coords, list):
            return
        if gtype == "Point":
            pt = self._position(coords, project)
            if pt is not None:
                yield {"type": "point", "coords": pt}
        elif gtype == "MultiPoint":
            for pos in coords:
                pt = self._position(pos, project)
                if pt is not None:
                    yield {"type": "point", "coords": pt}
        elif gtype == "LineString":
            yield from self._line("line", coords, project)
        elif gtype == "MultiLineString":
            for line in coords:
                yield from self._line("line", line, project)
        elif gtype == "Polygon":
            for ring in coords:
                yield from self._line("polygon", ring, project)
        elif gtype == "MultiPolygon":
            for polygon in coords:
                if isinstance(polygon, list):
                    for ring in polygon:
                        yield from self._line("polygon", ring, project)

    @classmethod
    def _position(cls, pos, project):
        """A single position `[x, y, …]` projected into 0..1, or None when it isn't a valid
        numeric position."""
        if isinstance(pos, list) and len(pos) >= 2 and cls._is_number(pos[0]) and cls._is_number(pos[1]):
            return list(project(pos[0], pos[1]))
        return None

    @classmethod
    def _line(cls, kind, positions, project):
        """Yield one `kind` (`line`/`polygon`) feature from a list of positions, projected into
        0..1. Positions that aren't valid numeric pairs are skipped; fewer than two survivors yield
        nothing (a line/ring needs at least two points)."""
        if not isinstance(positions, list):
            return
        pts = [cls._position(p, project) for p in positions]
        pts = [p for p in pts if p is not None]
        if len(pts) >= 2:
            yield {"type": kind, "coords": pts}

    @staticmethod
    def _is_number(v):
        # JSON numbers are int/float; reject bool (a JSON `true`/`false`, an int subclass in Python).
        return isinstance(v, (int, float)) and not isinstance(v, bool)


class KmlFormat(DrawingFormat):
    """KML (Google Earth geospatial XML, OGC 2.2), imported as a read-only **data overlay** (the
    FMT-9 OVERLAY role) — the third geospatial sibling to `ShapefileFormat` and `GeoJsonFormat`.
    Like GeoJSON it needs **no decoder of its own** (parsed with the standard-library `xml`), so it
    ships in the optional `[gis]` package and gates on that extra's marker — pyshp (import name
    `shapefile`) — rather than a decoder of its own, so Shapefile/GeoJSON/KML light up together when
    `[gis]` is installed. (`requires` stays empty: a *reachable* KML is already installed, so a
    parse failure is a malformed source, not a missing dep — see `preprocess._render_hint`.)

    A `<Placemark>`'s `<Point>`/`<LineString>`/`<LinearRing>`/`<Polygon>`/`<MultiGeometry>` is split
    into point/line/polygon features (one polygon per boundary ring, mirroring how the Shapefile /
    GeoJSON handlers split a multipart geometry). Coordinates are KML `lon,lat[,alt]` tuples —
    WGS84 by spec, so the layer is always CRS-family **geographic** — projected into the floor's
    0..1 frame through the shared `OverlayProjector` (equirectangular pre-scale + fit-to-bounds by
    default; a control-point georeference when the import map carries `overlayAlign` pairs, FMT-6 —
    same convention as Shapefile/GeoJSON). Namespaces are ignored by matching each tag's
    local name (KML tags are namespaced, e.g. `{http://www.opengis.net/kml/2.2}Placemark`).

    **Untrusted-XML safety.** KML is the first *real* XML the plugin parses itself (SVG is handled
    by CairoSVG). The stdlib parser (expat via ElementTree) resolves **no** external entities — the
    file-read/SSRF XXE vector is closed by stdlib — and the render subprocess's rlimits/timeout
    bound an internal entity-expansion ("billion laughs") bomb like every other decode; on top of
    that `_reject_dtd` refuses a DOCTYPE outright (belt-and-suspenders, like CairoSVG's
    `unsafe=False`). `xml` is lazy-imported inside `extract_overlay` (module isolation contract), so
    it loads only in the render subprocess."""

    name = "kml"
    exts = (".kml",)
    role = OVERLAY
    requires_module = ("shapefile",)   # gates on the `[gis]` marker (pyshp); stdlib parser, no dep
    extra = "gis"
    companions = ()

    MAX_FEATURES = 5000   # cap features flowed into the manifest/overlay (bounds size + frontend cost)

    def sniff(self, head):
        # KML has no binary magic — it's XML text opening with an XML declaration or a bare <kml>
        # root, tolerating a UTF-8 BOM + leading whitespace; a NUL means binary, not XML. Only the
        # cheap upload gate: a `<?xml…` head is claimed by the earlier SvgFormat in the registry
        # search (harmless — routing is by extension), so this mainly catches a declaration-less
        # `<kml>`; the real validation is the parse in extract_overlay downstream.
        s = head.lstrip(b"\xef\xbb\xbf").lstrip().lower()
        return s.startswith((b"<?xml", b"<kml")) and b"\x00" not in head

    def extract_overlay(self, path, align=None):
        try:
            with open(path, "rb") as fh:
                data = fh.read()
        except OSError:
            return None
        return self._features_from_kml(data, align)

    @staticmethod
    def _reject_dtd(data):
        """Refuse a DOCTYPE/DTD in untrusted KML before parsing — a DTD is the entry point for
        internal entity-expansion ("billion laughs") attacks. The stdlib parser already resolves NO
        external entities (an external SYSTEM entity errors as undefined) and the render subprocess's
        rlimits/timeout bound an expansion bomb, but rejecting a DTD outright closes the vector at
        the door (belt-and-suspenders, like CairoSVG's `unsafe=False`). A DOCTYPE, if present, must
        sit in the XML prolog — before the root element — so only the prolog is scanned; a literal
        `<!DOCTYPE` inside document text/CDATA (after the root start-tag) is content, not a
        declaration. Raises ValueError on a DTD; returns on reaching the root element start-tag."""
        i, n = 0, len(data)
        while i < n:
            while i < n and data[i] in b" \t\r\n":      # inter-markup whitespace
                i += 1
            if i >= n or data[i] != 0x3C:               # not '<' -> no more prolog markup
                return
            if data.startswith(b"<!DOCTYPE", i):
                raise ValueError("DOCTYPE/DTD not allowed in KML")
            if data.startswith(b"<?", i):               # XML declaration / processing instruction
                end, step = data.find(b"?>", i), 2
            elif data.startswith(b"<!--", i):           # comment
                end, step = data.find(b"-->", i), 3
            else:
                return                                  # root element start-tag: prolog is over
            if end < 0:
                return                                  # unterminated prolog token -> let ET report it
            i = end + step

    def _features_from_kml(self, data, align=None):
        # Lazy-import inside the extract path (module isolation contract); stdlib, but kept off the
        # module top level so this module stays import-safe for the worker like every handler.
        import xml.etree.ElementTree as ET
        try:
            self._reject_dtd(data)
            root = ET.fromstring(data)
        except Exception:
            # Untrusted XML: a malformed document raises ParseError, the DTD guard raises ValueError,
            # and a pathological one could raise otherwise — any parse failure degrades to None (the
            # "could not read" path), never a crash, like the other overlay decoders.
            return None
        # Collect (kind, raw_pts, props) across every placemark first, so one projector spans
        # the whole layer (see OverlayProjector); pts are source (lon, lat).
        items = []
        for pm in root.iter():
            if self._local(pm.tag) != "Placemark":
                continue
            props = self._placemark_props(pm)
            for kind, pts in self._geometries(pm):
                items.append((kind, pts, props))
        all_points = [pt for _, pts, _ in items for pt in pts]
        if not all_points:
            return None
        proj = OverlayProjector(all_points, crs=OverlayProjector.GEOGRAPHIC, align=align)
        feats = []
        for kind, pts, props in items:
            if kind == "point":
                feat = {"type": "point", "coords": list(proj.project(*pts[0]))}
            else:
                feat = {"type": kind, "coords": [list(proj.project(x, y)) for x, y in pts]}
            feat["props"] = props
            feats.append(feat)
            if len(feats) >= self.MAX_FEATURES:
                break
        if not feats:
            return None
        return {"features": feats, **proj.meta()}

    @staticmethod
    def _local(tag):
        """An element's local name with any `{namespace}` prefix stripped — KML tags are namespaced
        (`{http://www.opengis.net/kml/2.2}Placemark`), and the KML version namespace varies, so the
        whole handler matches on local names."""
        return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""

    def _geometries(self, elem):
        """Yield `(kind, raw_pts)` for each geometry under a placemark (or nested MultiGeometry),
        `raw_pts` a list of source `(lon, lat)` tuples. A Point yields one `point` (a single-element
        list); a LineString a `line`; a LinearRing and each of a Polygon's boundary rings a
        `polygon` (one feature per ring, like the Shapefile/GeoJSON multipart split); a
        MultiGeometry recurses. Empty/degenerate geometries yield nothing; non-geometry children
        (name, description, Style, …) are ignored."""
        for child in elem:
            name = self._local(child.tag)
            if name == "Point":
                pts = self._coords(child)
                if pts:
                    yield ("point", pts[:1])
            elif name == "LineString":
                pts = self._coords(child)
                if len(pts) >= 2:
                    yield ("line", pts)
            elif name == "LinearRing":
                pts = self._coords(child)
                if len(pts) >= 2:
                    yield ("polygon", pts)
            elif name == "Polygon":
                # outer + inner boundary rings live under <outerBoundaryIs>/<innerBoundaryIs>
                # wrappers, so gather every descendant LinearRing rather than direct children.
                for ring in child.iter():
                    if self._local(ring.tag) == "LinearRing":
                        pts = self._coords(ring)
                        if len(pts) >= 2:
                            yield ("polygon", pts)
            elif name == "MultiGeometry":
                yield from self._geometries(child)

    def _coords(self, geom):
        """Parse a geometry's direct `<coordinates>` child into source `(lon, lat)` tuples, or []
        when it has none. KML coordinate text is whitespace-separated `lon,lat[,alt]` tuples."""
        for child in geom:
            if self._local(child.tag) == "coordinates":
                return self._parse_coords(child.text)
        return []

    @staticmethod
    def _parse_coords(text):
        """KML `<coordinates>` text → list of `(lon, lat)` floats. Tuples are whitespace-separated;
        within a tuple the fields are comma-separated `lon,lat[,alt]` (altitude ignored). Malformed
        tuples are skipped."""
        if not text:
            return []
        pts = []
        for tok in text.split():
            parts = tok.split(",")
            if len(parts) >= 2:
                try:
                    pts.append((float(parts[0]), float(parts[1])))
                except ValueError:
                    continue
        return pts

    def _placemark_props(self, pm):
        """A placemark's attribute bag for the frontend hover title: its `<name>`/`<description>`
        text plus any `<ExtendedData>` fields (`<Data name><value>` and schema `<SimpleData name>`).
        Empty values are dropped; the geometry still imports without them."""
        props = {}
        for child in pm:
            name = self._local(child.tag)
            if name in ("name", "description"):
                text = (child.text or "").strip()
                if text:
                    props[name] = text
            elif name == "ExtendedData":
                for el in child.iter():
                    tag = self._local(el.tag)
                    if tag == "Data":
                        val = next((v.text for v in el
                                    if self._local(v.tag) == "value"), None)
                        self._put(props, el.get("name"), val)
                    elif tag == "SimpleData":
                        self._put(props, el.get("name"), el.text)
        return props

    @staticmethod
    def _put(props, key, value):
        """Store a stripped `key: value` in `props` when both are non-empty (a helper for the
        ExtendedData fields, whose name/value may be missing)."""
        value = (value or "").strip()
        if key and value:
            props[key] = value


class KmzFormat(KmlFormat):
    """KMZ — a zipped KML (+ assets), Google Earth's packaged form. Inherits the whole KML
    XML→features pipeline; only the source bytes and the magic sniff differ: the root KML member is
    read out of the zip and handed to `_features_from_kml`.

    **The inner zip is unpacked in the render subprocess, never the worker** (this `extract_overlay`
    runs only in `preprocess.py`), preserving the "untrusted drawings are parsed only in the
    subprocess" invariant — the same posture as a VSDX's inner zip. The KML member is read into
    memory under a decompressed-size cap (bounding a zip bomb the streaming way `UploadZipView`
    does), and only its **bytes** are read — no member is written to disk, so there is no
    path-traversal surface. The subprocess's rlimits/timeout remain the backstop."""

    name = "kmz"
    exts = (".kmz",)

    MAX_KML_BYTES = 64 * 1024 * 1024   # cap the decompressed root KML (belt to the subprocess rlimits)

    def sniff(self, head):
        # KMZ is a zip, so the magic is the generic ZIP local-file header — a cheap upload gate only
        # (shared with VSDX; routing is by extension). The real validation is the unzip + KML parse.
        return head.startswith(b"PK\x03\x04")

    def extract_overlay(self, path, align=None):
        data = self._read_kml_from_kmz(path)
        return self._features_from_kml(data, align) if data is not None else None

    def _read_kml_from_kmz(self, path):
        """Return the root KML member's bytes from a `.kmz`, or None when the archive is
        unreadable, holds no `.kml`, or that member exceeds `MAX_KML_BYTES`. The root is a top-level
        `doc.kml` by convention, else the first `.kml` member. Reads bytes only — nothing is
        extracted to disk. Lazy-imports `zipfile` (module isolation contract)."""
        import zipfile
        try:
            with zipfile.ZipFile(path) as zf:
                info = self._root_kml_member(zf.infolist())
                if info is None:
                    return None
                # Read one byte past the cap so an oversize member is detected without materializing
                # it; zipfile decompresses lazily, so this bounds the decompression too.
                with zf.open(info) as fh:
                    data = fh.read(self.MAX_KML_BYTES + 1)
                return None if len(data) > self.MAX_KML_BYTES else data
        except Exception:
            # Broad by design: the archive is untrusted (a corrupt/encrypted/odd zip raises a range
            # of errors — BadZipFile, OSError, RuntimeError for encryption, …); any failure degrades
            # to None, the same graceful contract as a corrupt shapefile.
            return None

    @staticmethod
    def _root_kml_member(infos):
        """Pick the root KML `ZipInfo` from an archive's members: a top-level `doc.kml` (the OGC
        convention) if present, else the first non-directory `.kml` member; None when there is
        none."""
        kmls = [i for i in infos if not i.is_dir() and i.filename.lower().endswith(".kml")]
        for i in kmls:
            if i.filename.lower() == "doc.kml":
                return i
        return kmls[0] if kmls else None


# The registry: one entry per KNOWN format (installed or not). Order defines DRAWING_EXTS and is
# the sniff search order (magics are disjoint, so it only fixes the tuple's order). Adding a format
# is a new handler class plus one entry here — nothing else on the Python side changes. FORMATS is
# the *full* known set; the derived ext lists below narrow it to the *installed* set (PKG-1).
FORMATS = (PdfFormat(), PngFormat(), JpegFormat(), GifFormat(),
           TiffFormat(), BmpFormat(), WebpFormat(), SvgFormat(), DxfFormat(),
           VsdxFormat(), VsdFormat(), ShapefileFormat(), GeoJsonFormat(),
           KmlFormat(), KmzFormat())

# Accepted source extensions, derived from the registry (was hand-duplicated in preprocess.py,
# imports.py, and import-uploader.js). Only *available* formats contribute (an uninstalled extra's
# format is recognized by `format_for`/`install_hint_for` for a helpful upload error, but is not
# offered — see PKG-1). Probed once at import; a newly-installed extra takes effect on worker
# restart. `endswith` accepts this tuple directly.
DRAWING_EXTS = tuple(ext for fmt in FORMATS if fmt.available() for ext in fmt.exts)

# Companion sibling extensions (a Shapefile's `.shx/.dbf/.prj/.cpg`) — accepted by the upload layer
# so a multi-file set stays together, but kept OUT of DRAWING_EXTS so scan/build/mapping see only
# the primary drawing. Only an *available* format's companions are accepted. Not a source of
# drawings — never fold this into DRAWING_EXTS.
COMPANION_EXTS = tuple(ext for fmt in FORMATS if fmt.available() for ext in fmt.companions)

# The OVERLAY-role subset of DRAWING_EXTS — injected into `window.MAP.overlayExts` so the wizard
# can offer overlay-only affordances (the FMT-6 align editor) without hand-mirroring the registry.
OVERLAY_EXTS = tuple(ext for fmt in FORMATS
                     if fmt.available() and fmt.role == OVERLAY for ext in fmt.exts)


def companion_owner(ext):
    """The format that treats `ext` as a companion sibling, or None. Searches the full known
    registry (installed or not), so a caller can still identify an uninstalled format's companion."""
    ext = ext.lower()
    for fmt in FORMATS:
        if ext in fmt.companions:
            return fmt
    return None


def install_hint_for(path):
    """If `path`'s extension belongs to a KNOWN but currently-UNAVAILABLE format — its pip extra or
    external binary isn't installed — return that format's `install_hint()` (e.g. "SVG support
    requires `pip install netbox-facilitymap[svg]`"); else None. Lets the upload endpoints turn a
    rejected `.svg`/`.dxf`/… into an actionable message instead of a bare "unsupported type".
    Checks the primary-drawing extension first, then a companion sibling's owner."""
    fmt = format_for(path)
    if fmt is not None:
        return fmt.install_hint() if not fmt.available() else None
    owner = companion_owner(os.path.splitext(path)[1])
    if owner is not None and not owner.available():
        return owner.install_hint()
    return None


def sniff_companion(head, ext):
    """True if `head` is a plausible companion sibling for `ext` (a lenient upload gate; the real
    validation is the parser in the render subprocess). False for a non-companion extension."""
    fmt = companion_owner(ext)
    return fmt is not None and fmt.sniff_companion(ext.lower(), head)


def sniff(head):
    """Return a short format name if `head` (a file's leading bytes) matches a known drawing
    signature, else None. A cheap first-line filter for the upload endpoints; the real decode
    happens in the render subprocess. This is a pure magic *classifier* over the full known
    registry — availability is enforced one level up by the narrowed extension gate (`DRAWING_EXTS`
    + `install_hint_for`), which an uninstalled format never gets past, so `sniff` need not (and
    does not) re-gate."""
    for fmt in FORMATS:
        if fmt.sniff(head):
            return fmt.name
    return None


def format_for(path):
    """The handler for `path`'s extension, or None when the extension isn't a known format.
    Searches the full known registry (installed or not) so callers can identify — and surface an
    install hint for — a recognized-but-uninstalled format; check `.available()` to gate."""
    ext = os.path.splitext(path)[1].lower()
    for fmt in FORMATS:
        if ext in fmt.exts:
            return fmt
    return None
