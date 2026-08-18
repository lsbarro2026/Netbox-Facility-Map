"""Tier A/C — the floor-code OCR reader (IMPORT-31): the `ocr.py` subprocess engine, and the
`api/import/ocr-read` endpoint that drives it.

`ocr.py` is deliberately Django-free (it is spawned by file path, like `preprocess.py`), so the
engine half is loaded straight from its file and exercised with no NetBox on the path. It is
skipped wherever `onnxruntime`/`numpy` or the vendored model are absent — the same condition the
`ocr` capability gates the whole feature on, so a platform without an onnxruntime wheel skips
rather than fails. The endpoint half needs Django and is marked accordingly.

The recognition *quality* assertions are intentionally loose (a code and its floor, not an exact
string): the point is that the pipeline reads real rendered pixels end to end. What is pinned
tightly is everything that decides whether a read is trustworthy — the line splitter, the graceful
degradations, and the endpoint's validation.

**Two skip markers, deliberately.** `needs_engine` gates the cases that must run the model;
`needs_numpy` gates only on numpy + Pillow, and every step of segmentation and scoring is a pure
function so it can sit under the looser one. That is not a convenience — segmentation is the half
of this pipeline that fails *silently* (hand the recognizer a two-line strip and it returns a
confident vertical blend rather than an error), so it has to be assertable on the mask itself,
on any machine, without asking the model's opinion about whether it worked.
"""

import importlib.util
import json
import os

import pytest

PKG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   'netbox_facilitymap')
MODEL = os.path.join(PKG, 'models', 'rec.onnx')


def _load_ocr():
    """Load `ocr.py` by path, the way `RenderRunner` spawns it — never as `netbox_facilitymap.ocr`,
    which would drag the package's NetBox-importing `__init__` in."""
    spec = importlib.util.spec_from_file_location('_fm_ocr', os.path.join(PKG, 'ocr.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _numpy_present():
    try:
        import numpy  # noqa: F401
        from PIL import Image  # noqa: F401
    except Exception:
        return False
    return True


def _deps_present():
    try:
        import onnxruntime  # noqa: F401
    except Exception:
        return False
    return _numpy_present() and os.path.isfile(MODEL)


ocr = _load_ocr()
needs_numpy = pytest.mark.skipif(
    not _numpy_present(), reason='numpy/Pillow are absent')
needs_engine = pytest.mark.skipif(
    not _deps_present(), reason='onnxruntime/numpy or the vendored model are absent')


def _sheet(path, lines, box=True, size=(1600, 1100)):
    """Write a fake drawing PNG with a boxed title block in the bottom-right, and return the
    normalized 0..1 region covering it — the same shape the wizard's code-region picker stores."""
    from PIL import Image, ImageDraw, ImageFont
    w, h = size
    im = Image.new('RGB', (w, h), 'white')
    d = ImageDraw.Draw(im)
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 30)
    except OSError:                                  # no DejaVu on this box
        font = ImageFont.load_default()
    x0, y0, x1, y1 = 1150, 950, 1580, 1060
    if box:
        d.rectangle([x0, y0, x1, y1], outline='black', width=2)
    for i, line in enumerate(lines):
        d.text((x0 + 20, y0 + 25 + 40 * i), line, fill='black', font=font)
    im.save(path)
    return {'x': x0 / w, 'y': y0 / h, 'w': (x1 - x0) / w, 'h': (y1 - y0) / h}


FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
needs_font = pytest.mark.skipif(not os.path.isfile(FONT_PATH), reason='DejaVuSans is absent')


def _blank(width, height):
    import numpy as np
    return np.full((height, width), 255, dtype=np.uint8)


def _text_row(arr, y0, y1, x0, x1, glyph=6, gap=3):
    """Stamp a row of glyph-like ink blocks into a white uint8 array.

    Text rather than a solid bar, on purpose: the inter-character gaps are exactly what keeps a
    genuine line of text from ever reaching the end-to-end ink fraction a border rule does, so a
    solid rectangle would be a proxy that tests the wrong thing. Needs no font, so the geometric
    properties below hold on any machine."""
    x = x0
    while x + glyph <= x1:
        arr[y0:y1, x:x + glyph] = 0
        x += glyph + gap


def _boxed(arr, rule):
    """Draw a title block's ruled border `rule` px thick around a crop."""
    arr[:rule, :] = 0
    arr[-rule:, :] = 0
    arr[:, :rule] = 0
    arr[:, -rule:] = 0
    return arr


def _caption_crop(width, height, rule, lines):
    """The reported caption, rendered as the crop a code region actually holds: a ruled title
    block with two lines of real text in it."""
    from PIL import Image, ImageDraw, ImageFont
    im = Image.new('RGB', (width, height), 'white')
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, width - 1, height - 1], outline='black', width=rule)
    font = ImageFont.truetype(FONT_PATH, max(9, round(height * 0.27)))
    for i, line in enumerate(lines):
        d.text((rule + 5, round(height * (0.08 + 0.44 * i))), line, fill='black', font=font)
    return im


# The reported title block's own geometry, written once against a 560x170 block and scaled from
# there, so the same layout can be rendered at any size. Every case below that needs to know where
# a row physically landed reads it from here rather than repeating a pixel count.
TITLE_BLOCK_BASE = (560, 170)
TITLE_BLOCK_ROWS = {'name': 25, 'sub': 57, 'floor': 100, 'dept': 145}


def _title_block_crop(scale=1.0, rule=2):
    """The **reported** crop (OCR-1), as a code region on a real facility's sheet holds it: a logo
    mark beside the building-name row, a second name row under it, a floor row with the print date
    off in the corner, and a solid department bar at the foot.

    Nothing about it is decorative. The logo is a single ink blob spanning both name rows, which is
    what fused them; the date is a digit-bearing distractor on the floor row's own line, which is
    what outscored the code; and the department bar is a filled band that must survive, since
    erasing every large mark wholesale is the obvious wrong fix. `_caption_crop`'s two tidy lines
    are the case this pipeline already handled — a busy block is the one it did not."""
    from PIL import Image, ImageDraw, ImageFont
    w, h = round(TITLE_BLOCK_BASE[0] * scale), round(TITLE_BLOCK_BASE[1] * scale)
    im = Image.new('RGB', (w, h), 'white')
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, w - 1, h - 1], outline='black', width=rule)

    def at(*xs):
        return [round(v * scale) for v in xs]

    def font(px):
        return ImageFont.truetype(FONT_PATH, max(8, round(px * scale)))

    d.ellipse(at(12, 12, 62, 62), fill='black')          # the logo mark...
    d.rectangle(at(20, 66, 56, 74), fill='black')        # ...and its wordmark rule, one blob
    d.text(at(74, 12), 'CAL POLY', fill='black', font=font(26))
    d.text(at(74, 46), 'Cotchett Education Building', fill='black', font=font(22))
    d.text(at(16, 88), 'Floor 3', fill='black', font=font(26))
    d.text(at(430, 92), 'MAY 2025', fill='black', font=font(18))
    d.rectangle([rule, round(132 * scale), w - rule - 1, h - rule - 1], fill=(30, 120, 60))
    d.text(at(16, 138), 'FACILITIES MANAGEMENT', fill='white', font=font(18))
    return im


def _band_at(bands, y):
    """The band covering row `y`, or None — how a case asserts *which* row a band is."""
    for b in bands:
        if b[1] <= y < b[3]:
            return b
    return None


# ---- binarization: seeing the ink at all ----

@needs_numpy
def test_otsu_threshold_splits_a_bimodal_histogram():
    """The fixed 160-luminance cutoff this replaces cannot see the light-grey text CAD title
    blocks are full of. Otsu finds the split wherever the two populations actually are."""
    gray = _blank(40, 40)
    gray[10:20, 5:35] = 190          # light-grey "text" the old fixed cutoff would have missed
    assert 20 <= ocr._otsu_threshold(gray) < 255
    assert ocr._binarize(gray)[15, 10]


@needs_numpy
def test_otsu_is_clamped_so_blank_paper_is_never_called_ink():
    """On a caption sitting in a mostly-blank block the histogram is near-unimodal and Otsu's
    answer is meaningless — left alone it splits the paper itself. `DARK_CEILING` is the guard."""
    gray = _blank(40, 40)
    gray[18:22, 18:22] = 215         # a barely-there smudge, nothing a human would call text
    assert ocr._otsu_threshold(gray) > ocr.DARK_CEILING
    assert not ocr._binarize(gray).any()


@needs_numpy
def test_binarize_flips_polarity_on_white_text_on_a_solid_bar():
    """A white-on-black title bar binarizes to one enormous blob and reads as nothing. Three
    lines of polarity check turn a total failure into an ordinary case."""
    gray = _blank(60, 40)
    _text_row(gray, 14, 26, 5, 55)
    gray = 255 - gray                # ...the same line, as white text on a solid bar
    ink = ocr._binarize(gray)
    assert ink.mean() < 0.5, 'the bar itself must not be read as ink'
    assert ink[20, 24], 'the white glyphs must survive as ink'
    assert not ink[20, 30], 'the gaps between them must not'


# ---- rule suppression: the fix for the reported bug ----

@needs_numpy
def test_suppress_rules_clears_a_title_blocks_border_and_leaves_the_text():
    """The measured cause of `Floor DEEODETAAYOOOE`. A region drawn around a caption inside a
    title block includes the block's **vertical** rules, and a 2px vertical line inks every single
    row — fusing the whole crop into one band, which the recognizer then reads as a confident
    vertical blend of both lines rather than failing.

    Asserted on the **mask**, never on what the recognizer says about it: segmentation fails
    silently, so validating it through the model's output is validating it through the one witness
    that cannot tell you it went wrong."""
    gray = _boxed(_blank(430, 98), 2)
    _text_row(gray, 20, 40, 30, 120)
    _text_row(gray, 60, 80, 30, 400)
    ink = ocr._binarize(gray)
    assert ink.sum(axis=1).min() > 0, 'expected the border rules to ink every row'

    clean = ocr._suppress_rules(ink)
    assert clean.sum(axis=1).min() == 0, 'the rules still ink every row'
    assert clean[30, 32] and clean[70, 32], 'the text was erased along with the rules'
    assert len(ocr._row_bands(clean)) == 2


@needs_numpy
def test_suppress_rules_leaves_a_solid_filled_band_alone():
    """The thickness guard. A rule is a *thin* run inked end to end; a filled swatch or a hatched
    band is inked end to end too, and erasing it wholesale would take real content with it."""
    gray = _blank(200, 120)
    gray[40:80, :] = 0               # a solid band, a third of the crop's height
    clean = ocr._suppress_rules(ocr._binarize(gray))
    assert clean[60].all()


@needs_numpy
def test_suppress_rules_sees_a_rule_on_a_tightly_drawn_crop():
    """A ruled border is a hairline in the PDF and renders to a couple of device pixels however
    large the sheet, so on a small crop the proportional guard alone rounds below it and stops
    seeing it — which puts the top rule back inside the caption's band. `RULE_MIN_THICK_PX`."""
    gray = _boxed(_blank(210, 44), 3)
    _text_row(gray, 12, 24, 10, 90, glyph=4, gap=2)
    clean = ocr._suppress_rules(ocr._binarize(gray))
    assert not clean[0].any() and not clean[:, 0].any()
    assert len(ocr._row_bands(clean)) == 1


# ---- graphic suppression: the fix for OCR-1 ----
#
# Asserted on the **mask**, like every other segmentation case here: hand the recognizer two fused
# rows and it answers confidently, so the model cannot be the witness for whether they were split.


@needs_numpy
def test_components_treats_a_diagonal_stroke_as_one_mark():
    """8-connectivity, which is why it is used: an antialiased stroke steps sideways a pixel at a
    time, and under 4-connectivity it shatters into one component per row — every fragment then
    short enough to look like a glyph, and the tall mark this must find disappears."""
    import numpy as np
    ink = np.zeros((40, 40), dtype=bool)
    for i in range(30):
        ink[5 + i, 5 + i] = True
    runs, labels = ocr._components(ink)
    assert len(runs) == 30
    assert len(set(labels.tolist())) == 1, 'the stroke was split into pieces'
    assert all(r[0] >= 0 and r[2] > r[1] for r in runs.tolist())


@needs_numpy
def test_suppress_graphics_clears_a_logo_that_fuses_two_text_rows():
    """**The reported bug** (OCR-1). A title block prints its logo beside the building name, and
    that mark is one ink blob tall enough to span the name row *and* the row beneath it. The row
    projection cannot see a blank row between two lines whose gap the logo inks, so both land in
    one band — and the single-line recognizer answers with a confident vertical blend of them
    (`CALPoCothet Eaucatnuid`) rather than an error.

    `_suppress_rules` cannot catch it: a logo is neither thin nor inked end to end, which is
    exactly what that guard exists to spare."""
    gray = _blank(430, 100)
    _text_row(gray, 20, 40, 90, 400)
    _text_row(gray, 60, 80, 90, 300)
    gray[18:82, 20:60] = 0                    # the logo, bridging both rows
    ink = ocr._binarize(gray)
    assert len(ocr._row_bands(ink)) == 1, 'expected the mark to fuse the two rows'

    clean = ocr._suppress_graphics(ink)
    assert len(ocr._row_bands(clean)) == 2, 'the rows are still fused'
    assert clean[30, 100] and clean[70, 100], 'the text was erased along with the mark'
    assert not clean[50, 30], 'the mark survived'


@needs_numpy
def test_suppress_graphics_keeps_a_floor_code_set_in_big_type():
    """The guard that makes the rule safe, and the reason it is a *split* test rather than a test
    of what a mark looks like. A floor code printed large is tall by exactly the same measure a
    logo is — and measured across the fonts a drawing uses, ink-to-box ratio separates them no
    better: a solid logo (0.78) sits inside the range bold capitals already occupy (0.76).

    What it cannot do is bridge two lines. Removing it leaves *fewer* bands across its own rows,
    never more, so the removal is undone and the code stays a candidate."""
    gray = _blank(430, 160)
    _text_row(gray, 10, 26, 20, 400)
    _text_row(gray, 34, 50, 20, 300)
    gray[70:150, 20:70] = 0                   # the code, as tall as a logo, on a line of its own
    ink = ocr._binarize(gray)
    assert (ocr._suppress_graphics(ink) == ink).all(), 'a big floor code was deleted'


@needs_numpy
def test_suppress_graphics_leaves_a_solid_filled_band_alone():
    """The department bar a title block prints at its foot, and the same claim
    `test_suppress_rules_leaves_a_solid_filled_band_alone` makes about the other suppressor: a
    filled swatch is content, and erasing it takes the white type inside it too."""
    gray = _blank(300, 140)
    _text_row(gray, 10, 30, 20, 280)
    gray[60:130, :] = 0
    ink = ocr._binarize(gray)
    assert (ocr._suppress_graphics(ink) == ink).all()


@needs_numpy
def test_suppress_graphics_is_scale_free():
    """The same layout, rendered four times larger, must be cut the same way. Everything here is
    measured against the crop's *own* typical glyph — a median component height — so nothing in it
    is a pixel count that a render width can walk across."""
    import numpy as np
    gray = _blank(430, 100)
    _text_row(gray, 20, 40, 90, 400)
    _text_row(gray, 60, 80, 90, 300)
    gray[18:82, 20:60] = 0
    big = np.repeat(np.repeat(gray, 4, axis=0), 4, axis=1)
    assert len(ocr._row_bands(ocr._suppress_graphics(ocr._binarize(gray)))) == 2
    assert len(ocr._row_bands(ocr._suppress_graphics(ocr._binarize(big)))) == 2


@needs_numpy
@needs_font
@pytest.mark.parametrize('scale', [1.0, 1.5, 2.0, 4.0])
def test_a_busy_title_block_gives_the_floor_row_a_band_of_its_own(scale):
    """The regression, end to end over the segmenter, on the reported layout rather than on a
    tidy two-line caption: logo + two name rows + a floor row + a corner date + a filled footer
    bar. Every row has to come out as its own band — above all the floor row, which is the one the
    client's parser needs and the one the logo used to swallow.

    Needs no model: which rows became bands is the whole claim."""
    crop = _title_block_crop(scale)
    bands = ocr.FloorCodeReader('/nonexistent')._split_lines(crop)
    rows = {name: _band_at(bands, round(y * scale)) for name, y in TITLE_BLOCK_ROWS.items()}
    assert all(rows.values()), (rows, bands)
    assert rows['floor'] is not rows['name'] and rows['floor'] is not rows['sub'], bands
    assert rows['name'] is not rows['sub'], 'the logo still fuses the two name rows'


# ---- the row projection ----

@needs_numpy
def test_row_bands_does_not_shatter_a_short_line_beside_a_long_one():
    """`PROFILE_PEAK_FRAC` must stay low. Raised to 0.15, a short line (`Floor 3`) beside a long
    one is thresholded against the LONG line's peak and breaks into its ascender and x-height
    bands — reading as two fragments of nonsense. Pinned so nobody tidies the constant upward."""
    gray = _blank(430, 98)
    _text_row(gray, 20, 40, 30, 110)          # short line
    _text_row(gray, 60, 80, 30, 420)          # long line, ~4x the ink
    assert len(ocr._row_bands(ocr._binarize(gray))) == 2
    assert ocr.PROFILE_PEAK_FRAC <= 0.05


@needs_numpy
def test_row_bands_keeps_a_short_floor_code_beside_a_big_bold_building_name():
    """The reported bug (IMPORT-71): the sweep answered `Administration` — the *building* name —
    for drawings whose region held a floor code too.

    A purely peak-relative threshold rescales with the loudest line in the crop, so a building
    name set in big bold type across a wide title block lifts the bar above the short code under
    it. The code then never becomes a candidate at all, the building name is the only thing left,
    and it wins by default at high confidence — with the client's floor parser (which correctly
    refuses `Administration`) never given the line that would have parsed.

    `MIN_LINE_INK_FRAC` is the floor under the peak term that keeps the code in the running."""
    gray = _blank(1200, 260)
    _text_row(gray, 30, 94, 40, 1100, glyph=14, gap=6)    # building name: tall, bold, wide
    _text_row(gray, 170, 184, 40, 100, glyph=4, gap=2)    # a bare `2`, ~3% of the name's ink
    bands = ocr._row_bands(ocr._binarize(gray))
    assert len(bands) == 2, bands
    assert bands[1][1] > 150, bands           # ...and the second band IS the code, not a fragment


@needs_numpy
def test_row_bands_still_rejects_a_speck_as_a_line():
    """The other side of `MIN_LINE_INK_FRAC`: it lowers the bar, so it has to stay high enough
    that a stray mark in the crop is not promoted to a text line. A few pixels of ink never
    reaches a hundredth of the crop's width."""
    gray = _blank(1200, 260)
    _text_row(gray, 30, 94, 40, 1100, glyph=14, gap=6)
    gray[170:172, 40:44] = 0                  # a 4x2 speck — dust, a leader dot, a rule's stub
    assert len(ocr._row_bands(ocr._binarize(gray))) == 1


@needs_numpy
def test_row_bands_is_scale_free():
    """Every threshold is relative and every resample is per band, so a layout segments the same
    way however large the sheet was rendered. Without this the same title block reads correctly on
    one drawing and garbles on the next purely because of its render width."""
    from PIL import Image
    import numpy as np
    gray = _boxed(_blank(300, 80), 2)
    _text_row(gray, 16, 32, 20, 130)
    _text_row(gray, 48, 64, 20, 280)
    big = np.asarray(Image.fromarray(gray).resize((1200, 320), Image.LANCZOS))

    small_boxes = ocr._row_bands(ocr._suppress_rules(ocr._binarize(gray)))
    big_boxes = ocr._row_bands(ocr._suppress_rules(ocr._binarize(big)))
    assert len(small_boxes) == len(big_boxes) == 2
    for small, large in zip(small_boxes, big_boxes):
        for a, b in zip(small, large):
            assert abs(a * 4 - b) <= 8, (small_boxes, big_boxes)


@needs_numpy
@needs_font
@pytest.mark.parametrize('size', [(430, 98), (330, 74), (260, 58), (210, 44)])
@pytest.mark.parametrize('rule', [1, 2, 3])
def test_the_reported_caption_segments_into_exactly_two_bands(size, rule):
    """The regression table, as a test. `Floor 3` over `Development        MAY 2025` in a ruled
    title block used to segment into ONE band for most crop-width/rule-width combinations — the
    exceptions being coincidences where the rules' ink happened to fall a pixel under the old
    minimum-ink threshold. Which side of that coincidence a drawing landed on was decided by its
    render width, which is why the same block read correctly on one sheet and garbled on the next.

    Needs no model: two bands is the whole claim."""
    crop = _caption_crop(size[0], size[1], rule, ['Floor 3', 'Development        MAY 2025'])
    bands = ocr.FloorCodeReader('/nonexistent')._split_lines(crop)
    assert len(bands) == 2, bands


@needs_numpy
def test_split_lines_returns_one_band_for_a_single_line():
    gray = _blank(300, 60)
    _text_row(gray, 20, 40, 20, 200)
    from PIL import Image
    crop = Image.fromarray(gray).convert('RGB')
    assert len(ocr.FloorCodeReader('/nonexistent')._split_lines(crop)) == 1


@needs_numpy
def test_split_lines_falls_back_to_the_whole_crop_when_there_is_no_ink():
    """A blank region must degrade to one band that recognizes as nothing, not to zero bands —
    the caller distinguishes "read, found nothing" from "not read", and only the first terminates
    the wizard's sweep."""
    from PIL import Image
    crop = Image.fromarray(_blank(120, 40)).convert('RGB')
    assert ocr.FloorCodeReader('/nonexistent')._split_lines(crop) == [(0, 0, 120, 40)]


# ---- scoring: what makes a confidence mean something ----

@needs_numpy
def test_geomean_is_dominated_by_the_weakest_character():
    """One hopeless glyph should sink the read. An arithmetic mean lets a long confident run carry
    it, which is how a misread stayed above the auto-accept bar."""
    probs = [0.99] * 9 + [0.01]
    assert ocr._geomean(probs) < 0.65
    assert sum(probs) / len(probs) > 0.85           # ...where the old aggregation did not,
    assert ocr._geomean(probs) < sum(probs) / len(probs) - 0.2      # by a wide margin
    assert ocr._geomean([]) == 0.0
    assert abs(ocr._geomean([0.5, 0.5]) - 0.5) < 1e-9


@pytest.mark.parametrize('text, conf, ok', [
    ('B3', 0.95, True),                 # a short code, read clearly
    ('LEVEL 2', 0.7, True),
    ('GROUND FLOOR PLAN', 0.8, True),
    ('B3    PLAN', 0.9, True),          # four spaces is a field gap, not a blend artifact
    ('', 0.99, False),                  # nothing at all
    ('B3', 0.5, False),                 # too short to trust at that confidence
    ('FLOOOOR', 0.99, False),           # the vertical-blend signature
    ('第三层平面图', 0.99, False),          # the vendored charset includes CJK; a caption is Latin
])
def test_plausible_screens_each_rejection_case_on_its_own(text, conf, ok):
    """Applied before scoring, so a confident-looking blend artifact never reaches the wizard.
    Every rule is about the *shape* of the string — this module holds no floor vocabulary."""
    assert ocr._plausible(text, conf) is ok


def test_the_winner_prefers_a_digit_but_knows_nothing_about_floors():
    """The server's winner rule is vocabulary-free by decision: the wizard's `floorFromText` is
    the one parser both the filename axis and the OCR axis share, and a copy here would drift from
    it. So this may prefer a digit — a floor code almost always has one — and how *long* a run of
    them a candidate carries (the case below), and no more than that."""
    def c(text, conf):
        return {'text': text, 'confidence': conf, 'min_p': conf, 'y': 0.5}

    assert ocr._pick_winner([c('MAY', 0.99), c('B3', 0.6)])['text'] == 'B3'
    assert ocr._pick_winner([c('LEVEL 1', 0.7), c('LEVEL 2', 0.9)])['text'] == 'LEVEL 2'
    # No digit anywhere: the most confident wins outright, floor-ness notwithstanding.
    assert ocr._pick_winner([c('FLOOR', 0.6), c('DEVELOPMENT', 0.9)])['text'] == 'DEVELOPMENT'
    assert ocr._pick_winner([]) is None


@pytest.mark.parametrize('text, longest', [
    ('Floor 3', 1), ('LEVEL 12', 2), ('B3', 1), ('MAY 2025', 4), ('MAY2025', 4),
    ('Floor 3MAY2025', 4), ('GROUND FLOOR', 0), ('A1-2026-07', 4),
])
def test_digit_run_measures_the_longest_run_not_the_count(text, longest):
    assert ocr._digit_run(text) == longest


def test_the_winner_prefers_a_short_digit_run_over_a_date():
    """**The reported bug's scoring half** (OCR-1). A title block's `MAY 2025` reads at 0.999
    against a `Floor 3` at 0.998 — a date set alone in a clean corner is easier pixels than a code
    printed beside other type — so "prefer a digit, then the most confident" hands the read to the
    date every time, on every drawing in the facility at once.

    A storey's number is one or two digits where a year's is four, and that is a claim about the
    *shape* of a string: still no word list, still nothing here that could drift from
    `ImportBulk.floorFromText`."""
    def c(text, conf):
        return {'text': text, 'confidence': conf, 'min_p': conf, 'y': 0.5}

    assert ocr._pick_winner([c('MAY 2025', 0.999), c('Floor 3', 0.998)])['text'] == 'Floor 3'
    assert ocr._pick_winner([c('Floor 3MAY2025', 0.99), c('Floor 3', 0.9)])['text'] == 'Floor 3'
    # Every tier is a preference and never a filter: a crop holding nothing but long numbers still
    # answers with its most confident line rather than with nothing.
    assert ocr._pick_winner([c('MAY 2025', 0.9), c('SHEET 1024', 0.95)])['text'] == 'SHEET 1024'
    assert ocr._pick_winner([c('2025', 0.99), c('LOBBY', 0.5)])['text'] == '2025'


# ---- reading real pixels, end to end ----

@needs_engine
@pytest.mark.parametrize('lines, expected, boxed', [
    (['LEVEL 3 PLAN'], 'LEVEL 3', False),
    (['(B3)'], 'B3', True),
    (['GROUND FLOOR PLAN'], 'GROUND', False),
    (['SECOND BASEMENT', 'LEVEL (B2) PLAN'], 'B2', True),
])
def test_read_region_reads_a_rendered_caption(tmp_path, lines, expected, boxed):
    """The whole point: a marked region on a rendered drawing comes back as text. The boxed
    two-line case is the `1.9.0` caption that the removed engine got wrong. The winner is now one
    candidate rather than every line joined, so the code has to be found in some *single* line —
    a stricter assertion than the join it replaces."""
    region = _sheet(str(tmp_path / 'sheet.png'), lines, box=boxed)
    text, conf, cands = ocr.FloorCodeReader(str(tmp_path)).read_region('sheet.png', region)
    flat = [c['text'].upper().replace(' ', '') for c in cands]
    assert expected.replace(' ', '') in text.upper().replace(' ', '') or \
        any(expected.replace(' ', '') in f for f in flat), (text, flat)
    assert conf > 0.5
    assert all(0.0 <= c['confidence'] <= 1.0 and 0.0 <= c['y'] <= 1.0 for c in cands)


@needs_engine
@needs_font
def test_a_floor_code_above_an_unrelated_row_is_read_as_its_own_line():
    """**The reported bug** (IMPORT-68/69/70). A crop holding `Floor 3` on one line and
    `Development        MAY 2025` on the next read back as `Floor DEEODETAAYOOOE` — the title
    block's border rules fused the two rows into one band, and a single-line CTC recognizer
    handed a two-line strip returns a confident vertical blend rather than an error.

    Both halves are asserted: the floor code survives as a candidate *of its own*, and the date
    row is a separate candidate rather than smeared into it."""
    import tempfile
    from PIL import Image
    work = tempfile.mkdtemp()
    crop = _caption_crop(430, 98, 2, ['Floor 3', 'Development        MAY 2025'])
    sheet = Image.new('RGB', (1600, 1100), 'white')
    sheet.paste(crop, (1100, 900))
    sheet.save(os.path.join(work, 'sheet.png'))
    region = {'x': 1100 / 1600, 'y': 900 / 1100, 'w': 430 / 1600, 'h': 98 / 1100}

    text, conf, cands = ocr.FloorCodeReader(work).read_region('sheet.png', region)
    flat = [c['text'].upper().replace(' ', '') for c in cands]
    floor = [f for f in flat if f.startswith('FLOOR') and '3' in f]
    assert floor, flat
    assert 'MAY' not in floor[0], 'the two rows are still fused: %r' % (floor[0],)
    assert any('MAY' in f for f in flat), 'the date row went missing entirely: %s' % (flat,)
    assert (text or '') != '', 'a legible caption must not come back as unreadable'
    assert conf > 0.5


@needs_engine
@needs_font
def test_a_busy_title_block_reads_the_floor_row_and_not_the_date():
    """**The reported bug** (OCR-1), read off real pixels. The same crop was answering with the
    building name (`CAL POLY Administration`, 0.86), with a vertical blend of the two name rows
    (`CALPoCothet Eaucatnuid`, 0.72), or with the print date (`MAY2025`, 0.99) — three symptoms of
    two causes: the logo fused the name rows, and a four-digit year outscored the code.

    Both halves are asserted. The floor code has to survive as a candidate **of its own** rather
    than smeared into the corner date, the name rows have to come back as real text rather than a
    blend, and the winner has to be the floor row — which is what the card shows when the client's
    parser finds nothing to parse."""
    import tempfile
    from PIL import Image
    work = tempfile.mkdtemp()
    crop = _title_block_crop(1.5)
    sheet = Image.new('RGB', (1600, 1100), 'white')
    sheet.paste(crop, (300, 500))
    sheet.save(os.path.join(work, 'sheet.png'))
    region = {'x': 300 / 1600, 'y': 500 / 1100,
              'w': crop.width / 1600, 'h': crop.height / 1100}

    text, conf, cands = ocr.FloorCodeReader(work).read_region('sheet.png', region)
    flat = [c['text'].upper().replace(' ', '') for c in cands]
    assert 'FLOOR3' in text.upper().replace(' ', ''), (text, flat)
    assert conf > 0.5
    # ...and as a line of its own, with the corner date not smeared into it
    assert any(f == 'FLOOR3' for f in flat), flat
    assert any('MAY' in f for f in flat), 'the date row went missing entirely: %s' % (flat,)
    # The name rows are two readable lines, not one confident blend of both.
    assert any('CALPOLY' in f for f in flat), flat
    assert any('BUILDING' in f for f in flat), flat


@needs_engine
@needs_font
def test_read_region_scores_each_line_on_its_own():
    """Confidence is aggregated per band and never across bands. An average over a whole crop is
    a number about characters that had nothing to do with the floor code, and it was that number
    the auto-accept threshold was being compared against."""
    import tempfile
    from PIL import Image
    work = tempfile.mkdtemp()
    sheet = Image.new('RGB', (1600, 1100), 'white')
    sheet.paste(_caption_crop(430, 98, 2, ['LEVEL 4', 'ISSUED FOR CONSTRUCTION']), (1100, 900))
    sheet.save(os.path.join(work, 'sheet.png'))
    _, conf, cands = ocr.FloorCodeReader(work).read_region(
        'sheet.png', {'x': 1100 / 1600, 'y': 900 / 1100, 'w': 430 / 1600, 'h': 98 / 1100})
    assert len(cands) >= 2
    assert all({'text', 'confidence', 'min_p', 'y'} == set(c) for c in cands)
    assert conf in [c['confidence'] for c in cands], 'the winner must BE one of the candidates'
    # Vertically ordered, so the client's centre tie-break means something.
    assert [c['y'] for c in cands] == sorted(c['y'] for c in cands)


# ---- degradations: one bad drawing must never sink a batch ----

@needs_engine
def test_read_region_degrades_on_a_missing_image(tmp_path):
    assert ocr.FloorCodeReader(str(tmp_path)).read_region(
        'nope.png', {'x': 0, 'y': 0, 'w': 1, 'h': 1}) == ('', 0.0, [])


@needs_engine
def test_read_region_degrades_on_a_region_that_rounds_to_empty(tmp_path):
    _sheet(str(tmp_path / 'sheet.png'), ['LEVEL 3'])
    assert ocr.FloorCodeReader(str(tmp_path)).read_region(
        'sheet.png', {'x': 0.5, 'y': 0.5, 'w': 0.0000001, 'h': 0.0000001}) == ('', 0.0, [])


@needs_engine
def test_an_unreadable_region_comes_back_empty_rather_than_as_garbage(tmp_path):
    """A blank corner of a sheet must read as "found nothing", not as whatever the recognizer
    hallucinated out of the paper texture. The wizard shows the text on the card, so a garbage
    string there is worse than an honest blank — and `lines` being empty is what tells it so."""
    _sheet(str(tmp_path / 'sheet.png'), ['LEVEL 3'])
    text, conf, cands = ocr.FloorCodeReader(str(tmp_path)).read_region(
        'sheet.png', {'x': 0.02, 'y': 0.02, 'w': 0.2, 'h': 0.08})
    assert (text, cands) == ('', [])
    assert 0.0 <= conf <= 1.0


@needs_engine
def test_run_honours_a_per_image_region_override(tmp_path):
    """A per-image `region` beats the job default — the mechanism behind the wizard's per-building
    `codeRegion`, which is how a building whose title block sits elsewhere is read in the SAME
    pass rather than needing its own round trip."""
    good = _sheet(str(tmp_path / 'a.png'), ['LEVEL 7 PLAN'], box=False)
    blank = {'x': 0.01, 'y': 0.01, 'w': 0.05, 'h': 0.05}      # empty corner of the sheet
    job = {'region': blank,
           'images': [{'folder': 'A', 'stem': 'a', 'image': 'a.png', 'region': good},
                      {'folder': 'A', 'stem': 'b', 'image': 'a.png'}]}
    (tmp_path / 'job.json').write_text(json.dumps(job))

    import io
    import sys
    buf = io.StringIO()
    real, sys.stdout = sys.stdout, buf
    try:
        ocr.FloorCodeReader(str(tmp_path)).run('job.json')
    finally:
        sys.stdout = real
    results = {r['stem']: r for r in json.loads(buf.getvalue())['results']}
    assert '7' in results['a']['text']          # override -> read the caption
    assert results['b']['text'] == ''           # default   -> read the blank corner


# ---- the adapted region actually reaching the crop (IMPORT-63) ----
#
# The wizard marks ONE box on a sample sheet and applies it to every drawing. When a drawing's
# sheet is a different *shape*, `ImportRegions.adapt` re-anchors that box from the nearest page
# edge and grows it 10% a side — a geometric estimate the operator never saw and, per the reporter,
# the one mechanism in the whole pipeline that can make OCR read text outside the marked box.
#
# Both halves of that path were tested, and only apart: the JS side asserted the geometry, while
# every Python case here was handed a box written by hand. So nothing covered an adapt()-widened
# region arriving at `read_region` — exactly what a facility mixing sheet templates does on every
# single read. `tests/js/fixtures/region-adapt-cases.json` is now the corpus BOTH ports run, in the
# `device-glyph-cases.json` pattern: the JS test asserts `adapt` yields each case's `adapted` box,
# and these render a sheet of the case's target shape with the caption drawn where the block
# physically lands (`anchored`), then read it back through `adapted`.

ADAPT_CASES = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           'js', 'fixtures', 'region-adapt-cases.json')


def _adapt_cases():
    with open(ADAPT_CASES) as fh:
        return json.load(fh)['cases']


def _sheet_at(path, size, box, lines):
    """Write a sheet `size` pixels big with `lines` drawn inside the normalized 0..1 `box`. Unlike
    `_sheet` (fixed geometry, fixed corner) this puts the caption exactly where a case says the
    marked block lands on the target sheet, which is the thing under test."""
    from PIL import Image, ImageDraw, ImageFont
    w, h = size
    im = Image.new('RGB', (w, h), 'white')
    d = ImageDraw.Draw(im)
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 30)
    except OSError:                                  # no DejaVu on this box
        font = ImageFont.load_default()
    x0, y0 = round(box['x'] * w), round(box['y'] * h)
    x1, y1 = round((box['x'] + box['w']) * w), round((box['y'] + box['h']) * h)
    d.rectangle([x0, y0, x1 - 1, y1 - 1], outline='black', width=2)
    for i, line in enumerate(lines):
        d.text((x0 + 14, y0 + 18 + 40 * i), line, fill='black', font=font)
    im.save(path)


@needs_engine
@pytest.mark.parametrize('case', _adapt_cases(), ids=lambda c: c['name'])
def test_an_adapted_region_still_lands_on_the_caption(tmp_path, case):
    _sheet_at(str(tmp_path / 'sheet.png'), case['renderPx'], case['anchored'], case['caption'])
    text, conf, cands = ocr.FloorCodeReader(str(tmp_path)).read_region(
        'sheet.png', case['adapted'])
    want = case['expect'].replace(' ', '')
    flat = [c['text'].upper().replace(' ', '') for c in cands]
    assert want in text.upper().replace(' ', '') or any(want in f for f in flat), \
        '%s: adapted %r read %r %s' % (case['name'], case['adapted'], text, flat)
    assert conf > 0.5


@pytest.mark.parametrize('case', _adapt_cases(), ids=lambda c: c['name'])
def test_the_adapted_region_is_a_valid_normalized_box(case):
    """What the JS sends must satisfy the endpoint's own validator, or a mixed-template facility
    would fail its reads at the boundary rather than in the reader. Needs no engine."""
    a = case['adapted']
    assert 0 <= a['x'] and 0 <= a['y']
    assert a['w'] > 0 and a['h'] > 0
    assert a['x'] + a['w'] <= 1 + 1e-9 and a['y'] + a['h'] <= 1 + 1e-9
    # `anchored` is where the caption physically is; `adapted` is what OCR gets. The second must
    # contain the first, or the margin is trimming the block instead of absorbing drift.
    b = case['anchored']
    assert a['x'] <= b['x'] + 1e-9 and a['y'] <= b['y'] + 1e-9
    assert a['x'] + a['w'] >= b['x'] + b['w'] - 1e-9
    assert a['y'] + a['h'] >= b['y'] + b['h'] - 1e-9


# ---- the debug dump: how the next segmentation bug gets diagnosed ----

@needs_numpy
def test_the_debug_dump_is_off_unless_the_operator_turns_it_on(monkeypatch):
    """It is gated on an environment variable the **subprocess inherits from the server**, so it
    is an operator's flag and nothing a request can reach. Off, it costs nothing."""
    monkeypatch.delenv('FACILITYMAP_OCR_DEBUG', raising=False)
    assert not ocr.FloorCodeReader('/nonexistent').debug


@needs_numpy
def test_a_debug_dump_that_cannot_be_written_disables_itself(monkeypatch, tmp_path):
    """A diagnostic may never be the thing that breaks a read."""
    blocker = tmp_path / 'not-a-dir'
    blocker.write_text('')
    monkeypatch.setenv('FACILITYMAP_OCR_DEBUG', str(blocker / 'sub'))
    reader = ocr.FloorCodeReader(str(tmp_path))
    reader.debug.start('sheet.png')          # must not raise...
    assert not reader.debug                  # ...and must switch itself off
    reader.debug.note('still safe %d', 1)
    reader.debug.save('x', None)


@needs_engine
def test_the_debug_dump_records_the_mask_and_every_band(monkeypatch, tmp_path):
    """Segmentation is the half of this pipeline that fails silently, so being able to look at
    what it actually cut is how the reported bug was found. Exercised end to end because the dump
    is threaded through `read_region` — a typo in a call site is otherwise invisible."""
    out = tmp_path / 'dbg'
    monkeypatch.setenv('FACILITYMAP_OCR_DEBUG', str(out))
    region = _sheet(str(tmp_path / 'sheet.png'), ['SECOND BASEMENT', 'LEVEL (B2) PLAN'], box=True)
    text, _, cands = ocr.FloorCodeReader(str(tmp_path)).read_region('sheet.png', region)
    assert text and cands                    # the read itself is unaffected
    dumped = sorted(p.name for p in out.iterdir())
    assert any(n.endswith('-ink.png') for n in dumped), dumped
    # One PNG per band the segmenter cut — a two-line caption dumps both, which is exactly the
    # evidence that told IMPORT-69 the rules had fused them.
    assert sum(1 for n in dumped if '-band-' in n) >= 2, dumped


# ---- text folding ----

def test_to_ascii_folds_fullwidth_forms():
    """PP-OCR occasionally emits fullwidth punctuation/digits. Left alone, the floor parser drops
    them along with the digits, so a perfectly good read scores as "nothing matched"."""
    assert ocr._to_ascii('（B3）') == '(B3)'
    assert ocr._to_ascii('Ｌ２') == 'L2'
    assert ocr._to_ascii('A　B') == 'A B'


# ---- the endpoint ----

pytest_plugins = ()


@pytest.mark.django_db
class TestOcrReadView:
    """`api/import/ocr-read` — validation and the permission gate. These need no engine: every case
    here is rejected before a subprocess is ever spawned."""

    URL = 'plugins:netbox_facilitymap:api-import-ocr-read'

    def _post(self, client, body):
        from django.urls import reverse
        return client.post(reverse(self.URL), data=json.dumps(body),
                           content_type='application/json')

    def test_requires_the_import_permission(self, client, viewer_user, workdir):
        client.force_login(viewer_user)
        r = self._post(client, {'region': {'x': 0, 'y': 0, 'w': 1, 'h': 1}, 'items': []})
        assert r.status_code == 403

    def test_rejects_a_region_outside_0_1(self, client, editor_user, workdir):
        client.force_login(editor_user)
        r = self._post(client, {'region': {'x': 0.5, 'y': 0, 'w': 0.9, 'h': 1},
                                'items': [{'folder': 'A', 'stem': 'a', 'path': 'uploads/A/a.pdf'}]})
        assert r.status_code == 400

    def test_rejects_a_degenerate_region(self, client, editor_user, workdir):
        client.force_login(editor_user)
        r = self._post(client, {'region': {'x': 0, 'y': 0, 'w': 0, 'h': 1},
                                'items': [{'folder': 'A', 'stem': 'a', 'path': 'uploads/A/a.pdf'}]})
        assert r.status_code == 400

    def test_rejects_an_empty_item_list(self, client, editor_user, workdir):
        client.force_login(editor_user)
        r = self._post(client, {'region': {'x': 0, 'y': 0, 'w': 1, 'h': 1}, 'items': []})
        assert r.status_code == 400

    def test_rejects_more_items_than_the_drawing_cap(self, client, editor_user, workdir,
                                                    monkeypatch):
        from django.conf import settings
        monkeypatch.setitem(settings.PLUGINS_CONFIG['netbox_facilitymap'], 'max_pdfs', 2)
        client.force_login(editor_user)
        items = [{'folder': 'A', 'stem': str(i), 'path': 'uploads/A/%d.pdf' % i} for i in range(3)]
        r = self._post(client, {'region': {'x': 0, 'y': 0, 'w': 1, 'h': 1}, 'items': items})
        assert r.status_code == 400

    def test_rejects_a_non_drawing_path(self, client, editor_user, workdir):
        client.force_login(editor_user)
        r = self._post(client, {'region': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
                                'items': [{'folder': 'A', 'stem': 'a',
                                           'path': 'uploads/A/secrets.txt'}]})
        assert r.status_code == 400

    def test_rejects_a_path_escaping_the_uploads_dir(self, client, editor_user, workdir):
        """Traversal is guarded by `ensure_preview`'s `safe_path` + uploads containment, so a
        crafted `path` can't reach a drawing-suffixed file elsewhere on disk."""
        client.force_login(editor_user)
        r = self._post(client, {'region': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
                                'items': [{'folder': 'A', 'stem': 'a',
                                           'path': '../../../../etc/passwd.pdf'}]})
        assert r.status_code == 400

    @needs_engine
    def test_reads_an_uploaded_drawing_end_to_end(self, client, editor_user, workdir, make_pdf):
        """The full path a Populate takes: upload → preview render → crop → recognize. The caption
        is rendered large across the whole page so the region can be the entire sheet."""
        from PIL import Image, ImageDraw, ImageFont
        import io as _io
        im = Image.new('RGB', (600, 200), 'white')
        d = ImageDraw.Draw(im)
        try:
            font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 60)
        except OSError:
            font = ImageFont.load_default()
        d.text((40, 60), 'LEVEL 5 PLAN', fill='black', font=font)
        buf = _io.BytesIO()
        im.save(buf, 'PDF')
        (workdir / 'uploads' / 'AlphaWing').mkdir(parents=True)
        (workdir / 'uploads' / 'AlphaWing' / 'plan.pdf').write_bytes(buf.getvalue())

        client.force_login(editor_user)
        r = self._post(client, {
            'region': {'x': 0.0, 'y': 0.2, 'w': 0.99, 'h': 0.6},
            'items': [{'folder': 'AlphaWing', 'stem': 'plan',
                       'path': 'uploads/AlphaWing/plan.pdf'}]})
        assert r.status_code == 200, r.content
        payload = r.json()
        assert payload['ok'] is True
        result = payload['results'][0]
        assert '5' in result['text']
        # The per-line candidates ride the wire: the wizard runs its own floor parser over them,
        # because this side deliberately knows nothing about floors.
        assert isinstance(result['lines'], list) and result['lines']
        assert {'text', 'confidence', 'min_p', 'y'} == set(result['lines'][0])
        assert any('5' in line['text'] for line in result['lines'])


@pytest.mark.django_db
class TestOcrJobFile:
    """The work list each read hands its subprocess. The background sweep (IMPORT-53) slices a
    facility into many small reads, so two can be in flight at once across worker processes — the
    fixed `ocr-job.json` this used to write would have the second overwrite the first's work list
    between the write and the spawn, and the first would then read the *second's* drawings.

    Neither the renderer nor the OCR engine is needed to pin that down: both are stubbed, which is
    also what keeps this in the no-engine tier."""

    URL = 'plugins:netbox_facilitymap:api-import-ocr-read'

    def _stub_and_post(self, client, monkeypatch, workdir, on_job, stem='plan'):
        """POST one read with the render + OCR subprocesses stubbed out, calling `on_job(name)`
        while the child would be running. Returns the response."""
        from django.urls import reverse
        from netbox_facilitymap.render_runner import RenderRunner

        monkeypatch.setattr(RenderRunner, 'ensure_preview',
                            lambda self, rel, page=0, angle=0: 'uploads/.thumbs/%s.png' % stem)
        monkeypatch.setattr(RenderRunner, 'run_ocr',
                            lambda self, job_rel: on_job(job_rel) or {'ok': True, 'results': []})
        return client.post(
            reverse(self.URL),
            data=json.dumps({'region': {'x': 0, 'y': 0, 'w': 1, 'h': 1},
                             'items': [{'folder': 'A', 'stem': stem,
                                        'path': 'uploads/A/%s.pdf' % stem}]}),
            content_type='application/json')

    def test_each_read_gets_its_own_job_file_and_cleans_it_up(self, client, editor_user, workdir,
                                                              monkeypatch):
        client.force_login(editor_user)
        seen = {}

        def on_job(job_rel):
            seen['name'] = job_rel
            seen['body'] = json.loads((workdir / job_rel).read_text())

        r = self._stub_and_post(client, monkeypatch, workdir, on_job)
        assert r.status_code == 200, r.content
        # The name is per-request, and the file really is there while the child runs...
        assert seen['name'] != 'ocr-job.json'
        assert seen['name'].startswith('ocr-job-') and seen['name'].endswith('.json')
        assert seen['body']['region'] == {'x': 0, 'y': 0, 'w': 1, 'h': 1}
        assert [i['folder'] for i in seen['body']['images']] == ['A']
        # ...and gone afterwards, so a facility-wide sweep doesn't leave a job file per batch behind
        # in the working dir.
        assert list(workdir.glob('ocr-job*.json')) == []

    def test_two_reads_never_share_a_job_file(self, client, editor_user, workdir, monkeypatch):
        """The property the sweep depends on: whatever a read wrote is still what its own child
        reads, even with another read overlapping it."""
        client.force_login(editor_user)
        names = []
        self._stub_and_post(client, monkeypatch, workdir, names.append, stem='one')
        self._stub_and_post(client, monkeypatch, workdir, names.append, stem='two')
        assert len(names) == 2 and names[0] != names[1]

    def test_the_job_file_is_removed_even_when_the_read_fails(self, client, editor_user, workdir,
                                                              monkeypatch):
        client.force_login(editor_user)

        def boom(job_rel):
            raise RuntimeError('subprocess exploded')

        with pytest.raises(RuntimeError):
            self._stub_and_post(client, monkeypatch, workdir, boom)
        assert list(workdir.glob('ocr-job*.json')) == []
