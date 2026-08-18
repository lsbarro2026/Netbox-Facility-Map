#!/usr/bin/env python3
"""
ocr.py — read the floor code off rendered drawing images so the import wizard can
auto-assign floors. It is the OCR engine behind the wizard's "Automatic" assignment mode.

IMPORTANT — isolation: like `preprocess.py`, this module is **invoked as a standalone
subprocess** by `imports.py` (run by file path, never imported as
`netbox_facilitymap.ocr`), under the same timeout + POSIX resource limits. It must stay
**stdlib + Pillow + numpy + onnxruntime only** and never import Django/NetBox. The OCR
model and its native runtime load only in this short-lived, capped child.

Engine: a **PP-OCRv4 text-recognition** ONNX model (Apache-2.0, vendored under `models/`)
run on `onnxruntime`, with all image preprocessing done in `numpy`/`Pillow`. This is
deliberately **not OpenCV** — OpenCV's desktop build needs X11 system libraries that
headless servers lack, which made the previous rapidocr-based engine fail to import on a
bare box. onnxruntime's wheels are self-contained (only base libc/libstdc++), so a plain
`pip install` works on any environment with no system packages and no network (the model
ships in the wheel, so recognition is fully offline).

Because the user already draws a tight box around the code, we run **recognition only**
(no text-detection model — that's the part that needs OpenCV). A small `numpy` segmenter
handles a box that spans more than one text line: Otsu binarization, ruled-border
suppression, graphic suppression (a logo or emblem is one ink blob tall enough to bridge
two text rows, which fuses them), a row projection thresholded at the lower of a fraction
of its own peak and a fraction of the crop's width, and a per-band resample to the model's
input height.
**The recognizer must only ever see one text line** — hand it a two-line strip and
CTC returns a vertical blend of both, confidently and silently (the `Floor 3` over
`Development  MAY 2025` caption that read back as `Floor DEEODETAAYOOOE`).

Each band is recognized **independently and never joined**: this module returns the
per-line candidates plus a winner, and the *client* decides which candidate names a floor.
That split is deliberate — `ocr.py` holds no floor vocabulary at all, because the wizard's
`ImportBulk.floorFromText` is the one parser both the filename axis and the OCR axis share,
and a copy here would drift from it.

It reads **only already-rendered, trusted PNGs** — the wizard's `.thumbs/*.full.png`
previews that `preprocess.py` produced — and **never opens a PDF**, so it adds no new
untrusted-input parsing path: PDF rasterization stays solely in `preprocess.py`.

One mode:
  ocr   read a job file (a normalized crop region + a list of images), OCR that one region
        on each image, and print `{"results": [...]}` to stdout (the wizard reads this).

Each result entry is
  {"folder": .., "stem": .., "text": .., "confidence": 0..1,
   "lines": [{"text": .., "confidence": 0..1, "min_p": 0..1, "y": 0..1}, ..]}
where `lines` are the plausible per-line candidates (`y` is the band's normalized vertical
centre within the crop, for the client's tie-break) and `text`/`confidence` are the winning
candidate — **not** every line joined, which is what they used to be. A crop nothing
plausible could be read from returns `text: ""` with the best confidence seen, so the
wizard can say "couldn't read" instead of showing a garbage string.

Confidence is the **geometric mean** of a single line's per-character probabilities, so the
weakest glyph dominates and one hopeless character sinks the read. It is aggregated per
band and never across bands — an average over a whole crop measures nothing.

Set `FACILITYMAP_OCR_DEBUG=<dir>` to dump the binarized mask, each band PNG, and the
segmentation decisions for every crop read. It is read once at import, so it is an
operator's flag, never something a request can set.

The job file (working-dir-relative paths, normalized 0..1 region). `region` is the default; an
image may override it with its own `region` (the wizard's per-building `codeRegion`), so one pass
covers buildings whose title blocks sit in different corners:
  {"region": {"x": 0..1, "y": 0..1, "w": 0..1, "h": 0..1},
   "images": [{"folder": "A", "stem": "26024", "image": "uploads/.thumbs/A/26024.full.png",
               "region": {"x": .., "y": .., "w": .., "h": ..}}]}

  python3 ocr.py ocr --base /path/to/workdir --job ocr-job.json
"""

import json
import math
import os
import sys

try:
    from PIL import Image
except ImportError:
    Image = None

try:
    import numpy as np
    import onnxruntime as ort
    _OCR_IMPORT_ERROR = None
except Exception as exc:   # capture the real reason (missing wheel, unloadable native lib, …)
    np = ort = None
    _OCR_IMPORT_ERROR = exc

# The recognition model is vendored next to this file so recognition is fully offline.
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "rec.onnx")

REC_INPUT_H = 48     # PP-OCRv4 rec input height (rec_img_shape = [3, 48, 320])
REC_WIDTH_ANCHOR = 320   # the model's reference width; the real width scales with the crop

# ---- segmentation tunables -------------------------------------------------------------------
# Every one of these is a **fraction**, not a pixel count, so a layout segments identically at
# any render scale. That is not a nicety: the reader is handed whatever width `preprocess.py`
# rendered a sheet at, and an absolute threshold silently changes which drawings are readable
# when that width changes.
DARK_CEILING = 200      # Otsu may not pick a split brighter than this. On a caption sitting in a
                        # mostly-blank title block the histogram is near-unimodal and Otsu's
                        # answer is meaningless; this keeps it from calling the paper "ink".
RULE_INK_FRAC = 0.8     # a row/column inked over this fraction of its length is rule-like...
RULE_MAX_THICK = 0.05   # ...and is only cleared when its run is at most this fraction of the
                        # crop's height/width, so a filled swatch or a solid title bar survives.
RULE_MIN_THICK_PX = 4   # ...with a small absolute floor under that fraction. A ruled border is a
                        # hairline in the PDF and renders to a couple of device pixels however
                        # large the sheet, so on a tightly-drawn crop the fraction alone rounds
                        # below the rule and stops seeing it. Nothing solid is 4px thick, and a
                        # text row never reaches RULE_INK_FRAC anyway (inter-character gaps), so
                        # the floor costs no protection.
PROFILE_PEAK_FRAC = 0.05    # a row is text once its ink clears this fraction of the row
                            # profile's own peak. Do NOT raise it: at 0.15 a short line
                            # (`Floor 3`) beside a long one is thresholded against the LONG
                            # line's peak and shatters into its ascender and x-height bands.
MIN_LINE_INK_FRAC = 0.01    # ...but a row also counts as text on its own, once it inks this
                            # fraction of the crop's width, whatever the peak says. A
                            # peak-relative threshold alone measures every line against the
                            # crop's *loudest* one, so a short floor code (`2`, `B3`) beside a
                            # long building name set in big bold type falls under it and is
                            # deleted from the candidate list outright — leaving the building
                            # name as the region's only, and therefore winning, read
                            # (IMPORT-71). A fraction of the width, not a pixel count, so this
                            # stays scale-free like every threshold around it.
MERGE_GAP_FRAC = 0.15   # merge bands closer than this fraction of the median band height
                        # (descenders, not leading)
PAD_FRAC = 0.10         # pad each band by this fraction of the median band height
MIN_BAND_PX = 16        # a band shorter than this had too little ink to be sure of, whatever
                        # CTC says; its confidence is scaled down in proportion.
MAX_BAND_UPSCALE = 6    # never enlarge a band more than this (a 3px band is not 48px of signal)
COL_GAP_FRAC = 1.2      # a band is additionally split at runs of blank columns this many of its
                        # own heights wide, each segment contributing its own candidate. Well
                        # clear of a word space (a fraction of a line height) and well under the
                        # gap between two *fields* of a title block, which is what it looks for.
GRAPHIC_HEIGHT_MULT = 2  # an ink component this many times taller than the crop's typical glyph
                         # is a graphic rather than a letterform — a candidate for suppression,
                         # confirmed only by the split test in `_suppress_graphics`.
GRAPHIC_TEST_LIMIT = 8   # ...and only the tallest this many are tested, so a crop of a busy
                         # *drawing* never pays a caption's segmentation cost. A count of
                         # components, so it stays scale-free like every threshold here.
FLOOR_CODE_DIGITS = 2   # a candidate whose longest digit run is at most this long is preferred as
                        # the winner: a storey's number is one or two digits, where a year or a
                        # sheet number is four. A statement about a string's shape, not about
                        # floors — see `_pick_winner`.
DUST_MARK_PX = 3        # a mark under this tall, or holding fewer inked pixels than this, is
                        # antialiasing speckle and is left out of the typical-glyph measurement.
                        # An absolute floor for the same reason `RULE_MIN_THICK_PX` is one: a
                        # rasterizer's edge artifacts are a pixel or two however large the sheet,
                        # so they do not scale with it and a fraction cannot describe them.

# Characters a Latin drawing caption may plausibly be made of. The vendored charset includes CJK,
# so a crop that decodes mostly outside this set decoded noise.
_PLAUSIBLE_CHARS = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,:/()#-")


def _to_ascii(s):
    """Fold fullwidth Latin/digits/punctuation (U+FF01–FF5E) and the ideographic space back to
    ASCII — the PP-OCR model occasionally emits fullwidth forms (e.g. `（B3）`), which the
    frontend's floor-code parser would otherwise drop along with the digits."""
    out = []
    for ch in s:
        o = ord(ch)
        if 0xFF01 <= o <= 0xFF5E:
            out.append(chr(o - 0xFEE0))
        elif ch == "　":
            out.append(" ")
        else:
            out.append(ch)
    return "".join(out)


# ---- the analysis tier: pure functions over arrays, strings and numbers ------------------------
# Every step of segmentation and scoring lives here rather than on `FloorCodeReader`, because none
# of it needs the model, the session, or a working directory — which is exactly what lets it be
# tested on a machine with no onnxruntime wheel. Segmentation fails *silently* (the recognizer
# reports high confidence on a fused strip), so it has to be assertable on its own.

def _runs(flags):
    """The `[start, end)` runs of consecutive true values in a 1-D boolean sequence."""
    runs, start = [], None
    for i, on in enumerate(flags):
        if on and start is None:
            start = i
        elif not on and start is not None:
            runs.append([start, i])
            start = None
    if start is not None:
        runs.append([start, len(flags)])
    return runs


def _otsu_threshold(gray):
    """The classic between-class-variance split of a uint8 image's histogram: the returned level
    is the **darkest class's last level**, so callers test `gray <= t`. Replaces a fixed luminance
    cutoff, which cannot see the light-grey text CAD title blocks are full of."""
    hist = np.bincount(gray.ravel(), minlength=256).astype(np.float64)
    total = hist.sum()
    if not total:
        return 0
    levels = np.arange(256, dtype=np.float64)
    w0 = np.cumsum(hist)
    w1 = total - w0
    sum0 = np.cumsum(hist * levels)
    valid = (w0 > 0) & (w1 > 0)
    mu0 = sum0 / np.maximum(w0, 1)
    mu1 = (sum0[-1] - sum0) / np.maximum(w1, 1)
    var = np.where(valid, w0 * w1 * (mu0 - mu1) ** 2, -1.0)
    return int(np.argmax(var))


def _binarize(gray):
    """Ink mask for a uint8 grayscale crop. The mask is used **only for analysis** (projection,
    rule detection, bounding boxes) — the recognizer is always handed the original pixels, since
    PP-OCR was trained on anti-aliased images and a hard bitmap throws away signal it uses.

    A crop that comes out more than half ink is white-on-black — a solid title bar — so it is
    inverted and re-thresholded rather than being read as one enormous blob."""
    ink = gray <= min(_otsu_threshold(gray), DARK_CEILING)
    if ink.mean() > 0.5:
        flipped = 255 - gray
        ink = flipped <= min(_otsu_threshold(flipped), DARK_CEILING)
    return ink


def _suppress_rules(ink):
    """Clear a title block's border rules from an ink mask.

    This is the fix for the reported bug. A floor caption sits inside a drawing's title block, so
    a region drawn around one routinely includes the block's **vertical** rules — and a 2px
    vertical line inks every single row, fusing the whole crop into one band. The old code hoped a
    minimum-ink-per-row rule would out-vote them, which held only while
    `rule_px / crop_width < 0.005`; every ordinary title block sits at or over that line, so which
    side of the coincidence a drawing landed on was decided by its render width.

    A rule is a **thin run of rows (or columns) inked almost end to end**. The thickness guard is
    what keeps a filled swatch or a hatched band from being erased wholesale — a 2–3px rule clears
    it by a wide margin, a solid block does not. Both profiles are measured before either axis is
    cleared, so suppressing the rows can't change what the columns look like."""
    out = ink.copy()
    h, w = ink.shape
    rows = [r for r in _runs(ink.sum(axis=1) >= RULE_INK_FRAC * w)
            if r[1] - r[0] <= max(RULE_MIN_THICK_PX, round(RULE_MAX_THICK * h))]
    cols = [r for r in _runs(ink.sum(axis=0) >= RULE_INK_FRAC * h)
            if r[1] - r[0] <= max(RULE_MIN_THICK_PX, round(RULE_MAX_THICK * w))]
    for a, b in rows:
        out[a:b, :] = False
    for a, b in cols:
        out[:, a:b] = False
    return out


def _ink_runs(ink):
    """Every horizontal run of ink in a mask, as an `(n, 3)` array of `(row, x0, x1)` in row order.

    Extracted for the whole mask in one vectorized pass. `_components` below is the only analysis
    step whose cost tracks the crop's *content* rather than its line count, so the half of it that
    numpy can do is done by numpy."""
    height, width = ink.shape
    padded = np.zeros((height, width + 2), dtype=bool)
    padded[:, 1:width + 1] = ink
    flat = padded.ravel()
    # Each row is padded blank at both ends, so a run can never straddle two rows and the edges
    # alternate rise/fall for the whole mask.
    edges = np.flatnonzero(flat[1:] != flat[:-1]) + 1
    if not edges.size:
        return np.empty((0, 3), dtype=np.int64)
    starts, ends = edges[0::2], edges[1::2]
    rows = starts // (width + 2)
    offset = rows * (width + 2) + 1
    return np.stack([rows, starts - offset, ends - offset], axis=1)


def _components(ink):
    """Label the 8-connected components of an ink mask. Returns `(runs, labels)` — the runs of
    `_ink_runs` and, per run, the component it belongs to.

    Run-wise union-find rather than a per-pixel label image: a caption crop holds thousands of runs
    where it holds millions of pixels, and the runs are all a caller ever needs again — to measure a
    component, and to erase one from the mask. Rows are merged with a two-pointer sweep, so the
    whole labelling is one pass over the runs rather than one per pair of adjacent rows.

    8-connectivity (a diagonal touch counts) is what keeps an antialiased stroke, whose runs step
    sideways a pixel at a time, from shattering into one component per row."""
    runs = _ink_runs(ink)
    total = len(runs)
    parent = list(range(total))

    def find(a):
        root = a
        while parent[root] != root:
            root = parent[root]
        while parent[a] != root:            # path compression, so a tall blob stays cheap
            parent[a], a = root, parent[a]
        return root

    # Python lists, not numpy scalars: this loop touches each run a handful of times and element
    # access is the whole cost.
    row_of = runs[:, 0].tolist()
    left = runs[:, 1].tolist()
    right = runs[:, 2].tolist()
    prev_start = prev_end = 0
    start = 0
    while start < total:
        end = start
        while end < total and row_of[end] == row_of[start]:
            end += 1
        if prev_end > prev_start and row_of[prev_start] == row_of[start] - 1:
            i, j = prev_start, start
            while i < prev_end and j < end:
                if right[i] < left[j]:      # ends are exclusive, so touching == overlapping here
                    i += 1
                elif right[j] < left[i]:
                    j += 1
                else:
                    a, b = find(i), find(j)
                    if a != b:
                        parent[max(a, b)] = min(a, b)
                    if right[i] < right[j]:
                        i += 1
                    else:
                        j += 1
        prev_start, prev_end = start, end
        start = end
    return runs, np.array([find(i) for i in range(total)], dtype=np.int64)


def _row_bands(ink):
    """Find the text lines in a rule-suppressed ink mask, as `(x0, y0, x1, y1)` boxes in reading
    order — empty when there is no ink at all.

    Two passes: one to find the raw bands and measure their median height, one to merge and pad
    using gaps derived from that height. Deriving them from the content rather than from fixed
    pixel counts is what makes the result identical on a crop and on its 4x upscale.

    Each band is then trimmed to its ink bounding box, so a `Floor 3` at the left of a wide title
    block stops being 80% whitespace and its aspect drops back into the range the model was
    trained on.

    A row clears the threshold two independent ways — `PROFILE_PEAK_FRAC` of the profile's peak,
    **or** `MIN_LINE_INK_FRAC` of the crop's width — and the lower of the two governs. The peak
    term alone is a *relative* test, so it silently rescales with the loudest line in the crop:
    a title block whose building name is set in big bold type raises the bar above a short floor
    code sitting under it, and the code never becomes a candidate at all (IMPORT-71). The width
    term is the floor under that, and it is what keeps a `2` beside `CAL POLY Cotchett Education
    Building` in the running."""
    height, width = ink.shape
    prof = ink.sum(axis=1)
    peak = int(prof.max()) if prof.size else 0
    if not peak:
        return []
    raw = _runs(prof >= max(1, min(PROFILE_PEAK_FRAC * peak, MIN_LINE_INK_FRAC * width)))
    if not raw:
        return []
    h_med = max(1, int(np.median([b - a for a, b in raw])))
    merge_gap = max(1, round(MERGE_GAP_FRAC * h_med))
    pad = max(1, round(PAD_FRAC * h_med))
    merged = []
    for a, b in raw:
        if merged and a - merged[-1][1] <= merge_gap:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    boxes = []
    for a, b in merged:
        cols = ink[a:b].any(axis=0)
        if not cols.any():
            continue
        lit = np.flatnonzero(cols)
        boxes.append((max(0, int(lit[0]) - pad), max(0, a - pad),
                      min(width, int(lit[-1]) + 1 + pad), min(height, b + pad)))
    return boxes


def _spanning_bands(boxes, y0, y1):
    """How many of `boxes` overlap the rows `[y0, y1)`. Scoped to one component's own rows on
    purpose: a band count over the *whole* mask also moves when a removal elsewhere shifts the
    median band height that `_row_bands` derives its merge gap from, and a split won here can then
    be cancelled by an unrelated merge there."""
    return sum(1 for b in boxes if b[1] < y1 and b[3] > y0)


def _suppress_graphics(ink):
    """Clear a title block's **graphics** — a logo, an emblem, a thick divider — from an ink mask,
    but only where one of them is what is holding two text lines together.

    This is the second half of the reported bug (OCR-1). A facility's title block prints its logo
    beside the building name, and that mark is a single ink blob tall enough to span the name row
    *and* the row under it. A row projection cannot see a blank row between two lines whose gap the
    logo inks, so both rows land in one band and the single-line recognizer returns a confident
    vertical blend of them (`CAL POLY` over `Cotchett Education Building` read back as
    `CALPoCothet Eaucatnuid`). `_suppress_rules` does not catch it: a logo is neither thin nor
    inked end to end, which is exactly what that guard is written to spare.

    Nothing here asks what a component *looks* like, because that question has no answer — measured
    across the fonts a drawing uses, the ink-to-box ratio of a solid logo (0.78) sits inside the
    range bold capitals already occupy (up to 0.76), and a hollow logo outline (0.14) sits below
    every glyph. So the test is the **harm**, not the shape: a component far taller than the crop's
    typical glyph is removed only if removing it leaves *more* bands across its own rows than
    before. A logo bridging two lines passes that test; a floor code set in big type — the thing
    this must never delete — cannot, because removing it leaves fewer bands, not more. A filled
    swatch or a solid title bar is spared for the same reason, which is the guard `_suppress_rules`
    states in its own terms.

    The typical glyph is measured as the **median** component height, over components past
    `DUST_MARK_PX`: one logo is one vote among a caption's glyphs, where any ink-weighted measure
    would let a single large blob describe the crop's text scale."""
    runs, labels = _components(ink)
    if not len(runs):
        return ink
    index = np.unique(labels, return_inverse=True)[1]
    # Runs arrive in row order, so a component's first and last run bound it vertically.
    first = np.unique(index, return_index=True)[1]
    last = len(index) - 1 - np.unique(index[::-1], return_index=True)[1]
    heights = runs[last, 0] - runs[first, 0] + 1
    areas = np.bincount(index, weights=(runs[:, 2] - runs[:, 1]).astype(np.float64))
    solid = (heights >= DUST_MARK_PX) & (areas >= DUST_MARK_PX)
    if not solid.any():
        return ink
    limit = GRAPHIC_HEIGHT_MULT * float(np.median(heights[solid]))
    tall = np.flatnonzero(heights > limit)
    if not len(tall):
        return ink
    tall = tall[np.argsort(-heights[tall])][:GRAPHIC_TEST_LIMIT]
    work = ink.copy()
    bands = _row_bands(work)
    for comp in tall:
        rows = runs[index == comp]
        top, bottom = int(runs[first[comp], 0]), int(runs[last[comp], 0]) + 1
        for y, x0, x1 in rows:
            work[y, x0:x1] = False
        split = _row_bands(work)
        if _spanning_bands(split, top, bottom) > _spanning_bands(bands, top, bottom):
            bands = split
        else:
            for y, x0, x1 in rows:          # it was holding nothing apart — it is content
                work[y, x0:x1] = True
    return work


def _column_segments(ink, min_gap):
    """Split a band at runs of at least `min_gap` blank columns, returning the inked `(x0, x1)`
    segments in the band's own coordinates — or `[]` when there is no such gap to split on.

    Only ever a candidate *generator*: the whole-band read is always kept too, so a caption like
    `THIRD FLOOR PLAN` can never be cut in a way that loses the ordinal-to-word adjacency the
    client's parser depends on."""
    cols = ink.any(axis=0)
    if not cols.any():
        return []
    gaps = [g for g in _runs(~cols) if g[1] - g[0] >= min_gap]
    inner = [g for g in gaps if g[0] > 0 and g[1] < len(cols)]
    if not inner:
        return []
    segments, edge = [], 0
    for a, b in inner:
        if a > edge:
            segments.append((edge, a))
        edge = b
    if edge < len(cols):
        segments.append((edge, len(cols)))
    return segments


def _geomean(probs):
    """The geometric mean of a line's per-character probabilities. Dominated by the weakest
    character, which is the behaviour wanted — one hopeless glyph should sink the read, where an
    arithmetic mean lets a long confident run carry it."""
    if not probs:
        return 0.0
    return float(math.exp(sum(math.log(max(p, 1e-9)) for p in probs) / len(probs)))


def _plausible(text, conf):
    """Could this candidate be a real caption at all? Applied before scoring, so the wizard is
    never offered a confident-looking blend artifact. Deliberately few rules, each independent —
    and every one of them is about the *shape* of the string, never about floors: this module
    holds no floor vocabulary (see the module docstring)."""
    if not text:
        return False
    if len(text) <= 2 and conf < 0.9:
        return False
    run = 1
    for prev, ch in zip(text, text[1:]):
        # Whitespace is exempt: CTC collapses repeats, so four identical *letters* is the vertical
        # blend signature, while four spaces is just a wide gap between two real fields.
        run = run + 1 if (ch == prev and not ch.isspace()) else 1
        if run >= 4:
            return False
    odd = sum(1 for ch in text if ch not in _PLAUSIBLE_CHARS)
    return odd <= 0.4 * len(text)


def _digit_run(text):
    """The longest run of consecutive digits in `text`."""
    longest = run = 0
    for ch in text:
        run = run + 1 if ch in "0123456789" else 0
        longest = max(longest, run)
    return longest


def _pick_winner(candidates):
    """The best of a crop's plausible candidates, or None. **Vocabulary-free by decision**: prefer
    a candidate carrying a *short* run of digits, then any digit at all, and take the most
    confident within the first group that has anyone in it. Which candidate names a floor is the
    client's question, and it answers it over the full `lines` list.

    The short-run tier is what stops a print date winning (OCR-1): a title block's `MAY 2025` reads
    at 0.999 against a `Floor 3` at 0.998, because a date set alone in a clean corner is easier
    pixels than a code beside other type — so on a digit-and-confidence rule the date wins every
    time. `FLOOR_CODE_DIGITS` is still a statement about the *shape* of a string and not about
    floors: no word list, no vocabulary, nothing this module could drift from
    `ImportBulk.floorFromText` — only that a storey's number is short where a year's is not.
    Each tier is a preference, never a filter, so a crop holding nothing but long numbers still
    returns its most confident line rather than nothing."""
    if not candidates:
        return None
    scored = [(c, _digit_run(c["text"])) for c in candidates]
    short = [c for c, run in scored if 1 <= run <= FLOOR_CODE_DIGITS]
    digits = [c for c, run in scored if run]
    return max(short or digits or candidates, key=lambda c: c["confidence"])


class _Debug:
    """The per-crop dump behind `FACILITYMAP_OCR_DEBUG=<dir>`: the binarized mask, each band, and
    every segmentation decision. Segmentation is the part of this pipeline that fails silently, so
    being able to look at what it actually cut is how this bug was found and how the next one will
    be. The directory is read **once, from the environment** — the subprocess inherits the server's
    env, so this is an operator's flag and no request can reach it. Costs nothing when unset."""

    def __init__(self):
        self.dir = os.environ.get("FACILITYMAP_OCR_DEBUG") or ""
        self.tag = ""
        self.seq = 0

    def __bool__(self):
        return bool(self.dir)

    def start(self, image_rel):
        if not self.dir:
            return
        self.seq += 1
        self.tag = "%03d-%s" % (self.seq, os.path.basename(image_rel).replace(".", "_"))
        try:
            os.makedirs(self.dir, exist_ok=True)
        except OSError as e:      # an undumpable directory disables the dump, never the read
            print("WARN ocr debug dir %s: %s" % (self.dir, e), file=sys.stderr)
            self.dir = ""

    def note(self, fmt, *args):
        if self.dir:
            print("OCR-DEBUG %s %s" % (self.tag, fmt % args), file=sys.stderr)

    def save(self, name, img):
        if not self.dir:
            return
        try:
            img.save(os.path.join(self.dir, "%s-%s.png" % (self.tag, name)))
        except Exception as e:   # a debug dump may never break a read
            print("WARN ocr debug save: %s" % (e,), file=sys.stderr)

    def mask(self, name, ink):
        if self.dir:
            self.save(name, Image.fromarray((~ink).astype("uint8") * 255))


def _prepare_band(band):
    """Resample one band so its text lands near the model's input height, with LANCZOS.

    Keyed on the band's own height rather than on the crop's short edge, which is what makes it
    scale-free — and unlike the crop-level upscale it replaces, mild **downscaling** is allowed
    too: `_Recognizer._norm` would otherwise reach height 48 by bilinear decimation, which
    aliases a tall caption."""
    w, h = band.size
    if not w or not h:
        return band
    factor = min(MAX_BAND_UPSCALE, REC_INPUT_H / float(h))
    if 0.95 <= factor <= 1.05:
        return band
    return band.resize((max(1, round(w * factor)), max(1, round(h * factor))), Image.LANCZOS)


class _Recognizer:
    """Thin wrapper over the PP-OCRv4 recognition ONNX model: preprocess a single text-line
    image the way PaddleOCR does, run the net, and CTC-greedy-decode the output to text."""

    def __init__(self, model_path):
        opts = ort.SessionOptions()
        opts.log_severity_level = 3   # keep onnxruntime quiet; stdout carries only our JSON
        self.sess = ort.InferenceSession(model_path, sess_options=opts,
                                         providers=["CPUExecutionProvider"])
        self.input_name = self.sess.get_inputs()[0].name
        meta = self.sess.get_modelmeta().custom_metadata_map
        chars = meta["character"].splitlines() if "character" in meta else []
        # PaddleOCR CTC label set: blank at index 0, the model's charset, then a trailing space.
        self.labels = ["<blank>"] + chars + [" "]

    def _norm(self, pil_line, max_wh_ratio):
        """Resize a line crop to height 48 (keeping aspect), normalize to [-1, 1] in BGR, and
        right-pad to the batch width — mirrors PaddleOCR/rapidocr `resize_norm_img`."""
        bgr = np.asarray(pil_line.convert("RGB"))[:, :, ::-1]   # PaddleOCR trained on cv2 BGR
        h, w = bgr.shape[:2]
        target_w = int(REC_INPUT_H * max_wh_ratio)
        ratio = w / float(h)
        resized_w = (target_w if math.ceil(REC_INPUT_H * ratio) > target_w
                     else int(math.ceil(REC_INPUT_H * ratio)))
        resized_w = max(1, resized_w)
        small = Image.fromarray(bgr.astype(np.uint8)).resize((resized_w, REC_INPUT_H), Image.BILINEAR)
        arr = np.asarray(small).astype(np.float32).transpose(2, 0, 1) / 255.0
        arr -= 0.5
        arr /= 0.5
        pad = np.zeros((3, REC_INPUT_H, target_w), dtype=np.float32)
        pad[:, :, :resized_w] = arr
        return pad

    def read_line(self, pil_line):
        """Recognize **one** text-line image. Returns ``(text, [char_probs])``; the caller
        aggregates those probabilities into this line's own confidence and never across lines.
        Handing this a strip holding two lines does not fail — it returns a confident vertical
        blend of both, which is why segmentation is validated on its own (see `_row_bands`)."""
        w, h = pil_line.size
        if not w or not h:
            return "", []
        max_wh_ratio = max(REC_WIDTH_ANCHOR / REC_INPUT_H, w / float(h))
        batch = self._norm(pil_line, max_wh_ratio)[np.newaxis, :]
        preds = self.sess.run(None, {self.input_name: batch})[0][0]   # [T, num_labels]
        idx = preds.argmax(axis=1)
        prob = preds.max(axis=1)
        keep = np.ones(len(idx), dtype=bool)
        keep[1:] = idx[1:] != idx[:-1]   # collapse CTC repeats
        keep &= idx != 0                 # drop the blank label
        text = "".join(self.labels[i] for i in idx[keep])
        return text, prob[keep].tolist()


class FloorCodeReader:
    """OCR a single normalized region out of each rendered drawing PNG, relative to a working
    directory (``base_dir``). Coordinates are normalized 0..1 so the same region maps onto
    every drawing's render regardless of size."""

    def __init__(self, base_dir):
        self.base_dir = base_dir
        self._engine = None
        self.debug = _Debug()

    def engine(self):
        """Load the recognizer lazily (model init is the expensive part) and reuse it across
        every image in the batch."""
        if self._engine is None:
            self._engine = _Recognizer(MODEL_PATH)
        return self._engine

    def _split_lines(self, crop):
        """The text lines in `crop`, as `(x0, y0, x1, y1)` boxes into it — binarize, suppress the
        title block's border rules, suppress the graphics that bridge its rows, project, merge,
        pad, trim to ink. The model recognizes one line at a time, so a box spanning several must
        be cut first; a single-line crop yields one band, and a crop with no ink at all falls back
        to the whole crop rather than reading nothing.

        Runs at the crop's **native** scale, on purpose: with every threshold relative and every
        resample done per band (`_prepare_band`), a layout segments identically however large the
        sheet was rendered."""
        ink = _suppress_rules(_binarize(np.asarray(crop.convert("L"))))
        if self.debug:
            self.debug.mask("ink", ink)
        ink = _suppress_graphics(ink)
        if self.debug:
            # Dumped as its own mask rather than as a note: what `_suppress_graphics` took out is
            # the difference between the two PNGs, which is the evidence a fusion bug is read from.
            self.debug.mask("text", ink)
        return _row_bands(ink) or [(0, 0, crop.width, crop.height)]

    def _read_band(self, rec, band, y, raw_h):
        """Recognize one band and score it on its own. A band too short to hold a legible glyph
        has its confidence scaled down in proportion — CTC will happily report near-certainty on
        four pixels of ink, and that number would otherwise be auto-accepted downstream."""
        text, probs = rec.read_line(_prepare_band(band))
        text = _to_ascii(text).strip()
        conf = _geomean(probs)
        if raw_h < MIN_BAND_PX:
            conf *= max(0.0, raw_h / float(MIN_BAND_PX))
        return {"text": text, "confidence": conf,
                "min_p": float(min(probs)) if probs else 0.0, "y": y}

    def _candidates(self, rec, crop):
        """One candidate per text band, plus a segment candidate per wide column gap within a band.
        Splitting only ever *adds* candidates — the whole-band read is always kept, so a caption can
        never be cut in a way that loses it.

        A band is split on the **gap**, not on how wide it happens to be. The width gate this
        replaces (`> 25:1` before a band was even looked at) is what left the reported
        `Floor 3` beside a corner `MAY 2025` fused into `Floor3MAY2025`: at 24:1 that band was one
        pixel of render scale away from being examined, and which side of that it landed on decided
        whether the drawing read. A gap of `COL_GAP_FRAC` band heights is a title block's gap
        between two *fields*, measured well clear of the word spaces inside one."""
        boxes = self._split_lines(crop)
        height = max(1, crop.height)
        cands = []
        for x0, y0, x1, y1 in boxes:
            band = crop.crop((x0, y0, x1, y1))
            y = (y0 + y1) / (2.0 * height)
            cands.append(self._read_band(rec, band, y, y1 - y0))
            if self.debug:
                self.debug.save("band-%d" % len(cands), band)
                self.debug.note("band %s text=%r conf=%.3f",
                                (x0, y0, x1, y1), cands[-1]["text"], cands[-1]["confidence"])
            if not band.height or not band.width:
                continue
            band_ink = _binarize(np.asarray(band.convert("L")))
            for sx0, sx1 in _column_segments(band_ink, max(1, round(COL_GAP_FRAC * band.height))):
                cands.append(self._read_band(
                    rec, band.crop((sx0, 0, sx1, band.height)), y, y1 - y0))
        return cands

    def read_region(self, image_rel, region):
        """Crop ``image_rel`` to the normalized ``region`` and OCR it. Returns
        ``(text, confidence, lines)`` — the winning candidate, its confidence, and every plausible
        per-line candidate. A missing/unreadable image or an empty region degrades to
        ``("", 0.0, [])`` so one bad PNG never sinks the batch.

        Lines are **never joined**. Joining is what turned a two-line caption into one unparseable
        string, and it is also what made the confidence meaningless — an average over every
        character in a crop says nothing about the line that actually named the floor. When
        nothing plausible was read the text is empty and the best confidence seen rides along for
        diagnosis, so the wizard shows "couldn't read" rather than a garbage string."""
        path = os.path.join(self.base_dir, image_rel)
        try:
            img = Image.open(path).convert("RGB")
        except Exception as e:
            print("WARN ocr open %s: %s" % (image_rel, e), file=sys.stderr)
            return "", 0.0, []
        w, h = img.size
        x1 = max(0, min(w, round(region["x"] * w)))
        y1 = max(0, min(h, round(region["y"] * h)))
        x2 = max(0, min(w, round((region["x"] + region["w"]) * w)))
        y2 = max(0, min(h, round((region["y"] + region["h"]) * h)))
        if x2 <= x1 or y2 <= y1:
            return "", 0.0, []
        self.debug.start(image_rel)
        crop = img.crop((x1, y1, x2, y2))
        try:
            cands = self._candidates(self.engine(), crop)
        except Exception as e:
            print("WARN ocr read %s: %s" % (image_rel, e), file=sys.stderr)
            return "", 0.0, []
        plausible = [c for c in cands if _plausible(c["text"], c["confidence"])]
        winner = _pick_winner(plausible)
        if self.debug:
            self.debug.note("candidates=%d plausible=%d winner=%r",
                            len(cands), len(plausible), winner and winner["text"])
        if winner is None:
            return "", max([c["confidence"] for c in cands] or [0.0]), []
        lines = [{"text": c["text"], "confidence": round(c["confidence"], 4),
                  "min_p": round(c["min_p"], 4), "y": round(c["y"], 4)} for c in plausible]
        # Rounded to match, so the winner reported here *is* one of the candidates reported in
        # `lines` — a client that compares the two must not find them a hair apart.
        return winner["text"], round(winner["confidence"], 4), lines

    def run(self, job_rel):
        """Read the job, OCR every listed image's region, and print the results as JSON.

        An image may carry its **own** ``region``, overriding the job-level default. That is what
        lets one pass cover a building whose title block sits in a different corner than the
        global sample (the wizard's per-building ``codeRegion`` override): the caller resolves
        which box belongs to which drawing, so a mixed batch is still a single subprocess."""
        if Image is None:
            sys.exit("Pillow is required for OCR")
        if np is None or ort is None:
            msg = "onnxruntime and numpy are required for OCR"
            if _OCR_IMPORT_ERROR is not None:
                msg += " — import failed: %s" % (_OCR_IMPORT_ERROR,)
            sys.exit(msg)
        if not os.path.isfile(MODEL_PATH):
            sys.exit("OCR model missing at %s (it should ship in the wheel under models/)" % MODEL_PATH)
        with open(os.path.join(self.base_dir, job_rel), encoding="utf-8") as f:
            job = json.load(f)
        default_region = job["region"]
        # Keep any library chatter off stdout — that channel carries only our JSON result.
        real_stdout = sys.stdout
        sys.stdout = sys.stderr
        try:
            results = []
            for item in job.get("images", []):
                text, conf, lines = self.read_region(
                    item["image"], item.get("region") or default_region)
                results.append({"folder": item.get("folder"), "stem": item.get("stem"),
                                "text": text, "confidence": round(conf, 4), "lines": lines})
        finally:
            sys.stdout = real_stdout
        json.dump({"results": results}, sys.stdout)


def _parse_args(argv):
    """Tiny argv parser (argparse-free, mirroring preprocess.py): a bare `ocr` mode plus
    `--base <dir>` (falls back to $FACILITYMAP_WORKDIR, then the script's own directory) and
    `--job <base-relative.json>`."""
    mode = "ocr"
    base = os.environ.get("FACILITYMAP_WORKDIR")
    opts = {}
    i = 0
    while i < len(argv):
        if argv[i] in ("--base", "--job") and i + 1 < len(argv):
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
    if mode != "ocr":
        sys.exit("usage: ocr.py ocr --base DIR --job ocr-job.json")
    if not opts.get("job"):
        sys.exit("ocr needs --job")
    FloorCodeReader(base).run(opts["job"])
