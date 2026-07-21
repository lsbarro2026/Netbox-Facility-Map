"""Tier A — `preprocess.py`, the Django-free render engine.

Two flavours, both honouring the module's hard invariant that it never imports Django/NetBox
(it runs as an isolated subprocess on untrusted PDFs):

  * the CLI is driven as an actual subprocess (`scan`/`build`), the way `imports.py` invokes it;
  * the pure helpers (`floor_label`, `dwg_sort_key`) are loaded straight from the file by path —
    NOT via `import netbox_facilitymap.preprocess`, which would pull in the Django package `__init__`
    — so importing them cannot silently start depending on Django.
"""

import importlib.util
import io
import json
import subprocess
import sys
from pathlib import Path

import pytest

PREPROCESS = Path(__file__).resolve().parent.parent / 'netbox_facilitymap' / 'preprocess.py'
DRAWING_FORMATS = PREPROCESS.parent / 'drawing_formats.py'


def _run(mode, base, *extra):
    """Invoke the preprocess CLI as `imports.py` does: by file path, in its own process."""
    return subprocess.run(
        [sys.executable, str(PREPROCESS), mode, '--base', str(base), *extra],
        capture_output=True, text=True)


def _write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


# Kept as the PDF-flavoured alias the existing tests read by; images use `_write` directly.
_write_pdf = _write


# ---- subprocess (scan / build) ----

def test_scan_emits_inventory(tmp_path, make_pdf):
    _write_pdf(tmp_path / 'uploads' / 'AlphaWing' / '101.pdf', make_pdf())

    proc = _run('scan', tmp_path)

    assert proc.returncode == 0, proc.stderr
    inv = json.loads(proc.stdout)
    assert [f['folder'] for f in inv['folders']] == ['AlphaWing']
    pdf = inv['folders'][0]['pdfs'][0]
    assert pdf['file'] == '101.pdf'
    assert pdf['stem'] == '101'
    assert pdf['pdf'] == 'uploads/AlphaWing/101.pdf'
    # pypdfium2/Pillow are installed in the test venv, so the thumbnail actually renders.
    # Thumb name carries the source extension so `1.pdf`/`1.png` can't collide.
    assert pdf['thumb'] == 'uploads/.thumbs/AlphaWing/101.pdf.png'
    assert (tmp_path / pdf['thumb']).is_file()


def test_build_writes_manifest_and_images(tmp_path, make_pdf):
    _write_pdf(tmp_path / 'uploads' / 'AlphaWing' / 'ground.pdf', make_pdf())
    (tmp_path / 'import-map.json').write_text(json.dumps({
        'buildings': {
            'AlphaWing': {'slug': 'alpha', 'name': 'Alpha Wing', 'abbr': 'AB',
                          'floors': {'ground': 'g'}},
        },
    }))

    proc = _run('build', tmp_path)
    assert proc.returncode == 0, proc.stderr

    manifest = json.loads((tmp_path / 'manifest.json').read_text())
    assert manifest['siteplan'] is None
    # `built` is the media cache-buster MediaView keys immutable caching on.
    assert isinstance(manifest['built'], int) and manifest['built'] > 0
    (building,) = manifest['buildings']
    assert building['dir'] == 'alpha'
    # Source folder is recorded so the wizard's edit hub can match a re-scanned building back
    # to its built binding (BIND-2).
    assert building['folder'] == 'AlphaWing'
    (floor,) = building['floors']
    # floor id = abbr + token; label derived from the token.
    assert floor['id'] == 'ABg'
    assert floor['label'] == 'Ground'
    assert floor['image'] == 'images/alpha/ABg.webp'
    assert floor['w'] > 0 and floor['h'] > 0
    assert floor['pages'][0]['image'] == floor['image']
    # Output is really WebP (RIFF….WEBP container), not a mislabelled PNG.
    raw = (tmp_path / floor['image']).read_bytes()
    assert raw[:4] == b'RIFF' and raw[8:12] == b'WEBP'
    # Card-sized thumbnail for the building-view / Site-page floor grids.
    assert floor['thumb'] == 'images/alpha/ABg.thumb.webp'
    assert (tmp_path / floor['thumb']).is_file()
    # The atomic write leaves no `.part` temp behind after a clean build.
    assert not (tmp_path / 'manifest.json.part').exists()


def test_build_location_anchored_building_nests_dir_and_images(tmp_path, make_pdf):
    """A **Location-anchored** building (Site=campus, building is a Location — MODEL-3) carries a
    `buildingSlug` in its import-map entry. The build then nests the manifest `dir` and the floor
    images one level deeper (`<siteSlug>/<buildingSlug>`), so the floor's `floor_key` (== `dir/id`)
    is the 3-segment Location-anchored shape and two buildings under one campus never collide on
    disk. `siteSlug` stays the **pure** site slug (the SEC-1 media gate keys off it)."""
    _write_pdf(tmp_path / 'uploads' / 'AlphaWing' / 'ground.pdf', make_pdf())
    (tmp_path / 'import-map.json').write_text(json.dumps({
        'buildings': {
            'AlphaWing': {'slug': 'campus', 'buildingSlug': 'alpha-bldg', 'name': 'Alpha Wing',
                          'abbr': 'AB', 'floors': {'ground': 'g'}},
        },
    }))

    proc = _run('build', tmp_path)
    assert proc.returncode == 0, proc.stderr

    (building,) = json.loads((tmp_path / 'manifest.json').read_text())['buildings']
    # `dir` is compound so `<dir>/<floorId>` is the 3-segment key; `siteSlug` stays the pure site slug.
    assert building['dir'] == 'campus/alpha-bldg'
    assert building['siteSlug'] == 'campus'
    assert building['buildingSlug'] == 'alpha-bldg'
    (floor,) = building['floors']
    assert floor['id'] == 'ABg'
    # Images nest under the building so a same-campus sibling building can't clobber them.
    assert floor['image'] == 'images/campus/alpha-bldg/ABg.webp'
    assert (tmp_path / floor['image']).is_file()
    assert floor['thumb'] == 'images/campus/alpha-bldg/ABg.thumb.webp'
    assert (tmp_path / floor['thumb']).is_file()


def test_build_site_anchored_manifest_omits_building_slug(tmp_path, make_pdf):
    """Regression: a Site-anchored build (no `buildingSlug`) is byte-identical to before — a flat
    `dir == siteSlug`, flat `images/<siteSlug>/…`, and NO `buildingSlug` field (readers treat it as
    optional), so existing installs' manifests don't gain a spurious key."""
    _write_pdf(tmp_path / 'uploads' / 'AlphaWing' / 'ground.pdf', make_pdf())
    (tmp_path / 'import-map.json').write_text(json.dumps({
        'buildings': {
            'AlphaWing': {'slug': 'alpha', 'name': 'Alpha Wing', 'abbr': 'AB',
                          'floors': {'ground': 'g'}},
        },
    }))

    proc = _run('build', tmp_path)
    assert proc.returncode == 0, proc.stderr

    (building,) = json.loads((tmp_path / 'manifest.json').read_text())['buildings']
    assert building['dir'] == 'alpha' and building['siteSlug'] == 'alpha'
    assert 'buildingSlug' not in building
    assert building['floors'][0]['image'] == 'images/alpha/ABg.webp'


def test_build_ignores_invalid_building_slug(tmp_path, make_pdf):
    """A `buildingSlug` that isn't a strict slug (defense-in-depth: it becomes a directory-name
    segment) is ignored with a warning and the build degrades to Site-anchored — a hostile value
    can never traverse out of `images/`."""
    _write_pdf(tmp_path / 'uploads' / 'AlphaWing' / 'ground.pdf', make_pdf())
    (tmp_path / 'import-map.json').write_text(json.dumps({
        'buildings': {
            'AlphaWing': {'slug': 'campus', 'buildingSlug': '../escape', 'name': 'Alpha',
                          'abbr': 'AB', 'floors': {'ground': 'g'}},
        },
    }))

    proc = _run('build', tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert 'ignoring invalid buildingSlug' in proc.stderr

    (building,) = json.loads((tmp_path / 'manifest.json').read_text())['buildings']
    assert building['dir'] == 'campus' and 'buildingSlug' not in building
    assert building['floors'][0]['image'] == 'images/campus/ABg.webp'


def test_scan_reports_page_count(tmp_path, make_pdf, make_multipage_pdf):
    """A multi-page PDF reports its page count in the scan inventory (the wizard explodes it into
    one card per page); every single-page drawing reports 1."""
    _write_pdf(tmp_path / 'uploads' / 'AlphaWing' / 'set.pdf',
               make_multipage_pdf([(120, 160), (200, 160), (120, 300)]))
    _write_pdf(tmp_path / 'uploads' / 'AlphaWing' / 'single.pdf', make_pdf())

    proc = _run('scan', tmp_path)

    assert proc.returncode == 0, proc.stderr
    by_file = {p['file']: p for p in json.loads(proc.stdout)['folders'][0]['pdfs']}
    assert by_file['set.pdf']['pages'] == 3
    assert by_file['single.pdf']['pages'] == 1


def test_build_explodes_pdf_pages_into_separate_floors(tmp_path, make_multipage_pdf):
    """A multi-page PDF whose pages map to different tokens (`stem#pN`) builds one floor per page,
    each rendering its own page — asserted via their distinct widths."""
    _write_pdf(tmp_path / 'uploads' / 'AlphaWing' / 'set.pdf',
               make_multipage_pdf([(120, 160), (200, 160)]))
    (tmp_path / 'import-map.json').write_text(json.dumps({
        'buildings': {
            'AlphaWing': {'slug': 'alpha', 'name': 'Alpha', 'abbr': 'AB',
                          'floors': {'set#p1': 'g', 'set#p2': 'b1'}},
        },
    }))

    proc = _run('build', tmp_path)
    assert proc.returncode == 0, proc.stderr

    (building,) = json.loads((tmp_path / 'manifest.json').read_text())['buildings']
    floors = {f['id']: f for f in building['floors']}
    assert set(floors) == {'ABg', 'ABb1'}
    # Each page is its own single-sheet floor, and the two pages rendered distinctly (120w vs 200w).
    assert len(floors['ABg']['pages']) == 1 and len(floors['ABb1']['pages']) == 1
    assert floors['ABg']['w'] != floors['ABb1']['w']


def test_build_region_split_fans_one_page_to_several_floors(tmp_path, make_image):
    """A single-page drawing whose `floors` value is a `[{token, region}]` list fans into one floor
    per region — each a distinct `id`/`floorSlug` (own Location), matching the design example of one
    sheet that is level 2 for one wing and level 3 for another (FLOOR-2). FLOOR-3 crops each region
    out of the source page, so every region floor's image is its own sub-rectangle mapped back to a
    fresh 0..1 canvas — its `w`/`h` are the crop's pixel size, not the whole page's. A raster source
    renders at native size (unlike a PDF's render scale), so the crop dimensions are exact."""
    _write(tmp_path / 'uploads' / 'AlphaWing' / 'wing.png', make_image('PNG', 120, 160))
    (tmp_path / 'import-map.json').write_text(json.dumps({
        'buildings': {
            'AlphaWing': {'slug': 'alpha', 'name': 'Alpha', 'abbr': 'AB',
                          'floors': {'wing': [
                              {'token': 'l2', 'region': [0, 0, 0.5, 1]},      # left half: 60x160
                              {'token': 'l3', 'region': [0.5, 0, 0.5, 0.5]},  # top-right quarter: 60x80
                          ]}},
        },
    }))

    proc = _run('build', tmp_path)
    assert proc.returncode == 0, proc.stderr

    (building,) = json.loads((tmp_path / 'manifest.json').read_text())['buildings']
    floors = {f['id']: f for f in building['floors']}
    # One page, two floors — each its own fid/floorSlug (= one Location), single-sheet.
    assert set(floors) == {'ABl2', 'ABl3'}
    assert floors['ABl2']['floorSlug'] == 'ABl2' and floors['ABl3']['floorSlug'] == 'ABl3'
    assert len(floors['ABl2']['pages']) == 1 and len(floors['ABl3']['pages']) == 1
    # Each floor is cropped to its own region: the manifest w/h are the crop's pixel size, and the
    # two asymmetric regions produce different-sized floors (a no-op crop would leave them equal).
    assert (floors['ABl2']['w'], floors['ABl2']['h']) == (60, 160)
    assert (floors['ABl3']['w'], floors['ABl3']['h']) == (60, 80)
    assert floors['ABl2']['pages'][0]['w'] == 60 and floors['ABl3']['pages'][0]['h'] == 80
    # The cropped sub-image is a real WebP (RIFF….WEBP), not a mislabelled passthrough.
    raw = (tmp_path / floors['ABl3']['image']).read_bytes()
    assert raw[:4] == b'RIFF' and raw[8:12] == b'WEBP'


def test_build_region_split_labels_by_compound_key(tmp_path, make_pdf):
    """A region floor's friendly label resolves through the compound `<page key>@rN` key of
    `labels` (list order, 1-based); a region without a labels entry falls back to the token guess."""
    _write_pdf(tmp_path / 'uploads' / 'AlphaWing' / 'wing.pdf', make_pdf())
    (tmp_path / 'import-map.json').write_text(json.dumps({
        'buildings': {
            'AlphaWing': {'slug': 'alpha', 'name': 'Alpha', 'abbr': 'AB',
                          'floors': {'wing': [
                              {'token': 'l2', 'region': [0, 0, 0.5, 1]},
                              {'token': 'l3', 'region': [0.5, 0, 0.5, 1]},
                          ]},
                          'labels': {'wing@r1': 'East Level 2'}},
        },
    }))

    proc = _run('build', tmp_path)
    assert proc.returncode == 0, proc.stderr

    (building,) = json.loads((tmp_path / 'manifest.json').read_text())['buildings']
    floors = {f['id']: f for f in building['floors']}
    assert floors['ABl2']['label'] == 'East Level 2'
    # No `wing@r2` label -> token-guess fallback (`floor_label('l3')` -> 'Level 3').
    assert floors['ABl3']['label'] == 'Level 3'


def test_build_pages_sharing_a_token_group_into_one_floor(tmp_path, make_multipage_pdf):
    """Two pages of one PDF mapped to the SAME token collapse into a single multi-sheet floor
    (`<id>` + `<id>-2` sheets) — the exploded-page path reuses the existing sheet grouping."""
    _write_pdf(tmp_path / 'uploads' / 'AlphaWing' / 'set.pdf',
               make_multipage_pdf([(120, 160), (200, 160)]))
    (tmp_path / 'import-map.json').write_text(json.dumps({
        'buildings': {
            'AlphaWing': {'slug': 'alpha', 'name': 'Alpha', 'abbr': 'AB',
                          'floors': {'set#p1': 'g', 'set#p2': 'g'}},
        },
    }))

    proc = _run('build', tmp_path)
    assert proc.returncode == 0, proc.stderr

    (building,) = json.loads((tmp_path / 'manifest.json').read_text())['buildings']
    (floor,) = building['floors']
    assert floor['id'] == 'ABg'
    assert [pg['image'] for pg in floor['pages']] == [
        'images/alpha/ABg.webp', 'images/alpha/ABg-2.webp']


def test_scan_accepts_raster_images(tmp_path, make_image):
    """A folder of raster plans (PNG + TIFF) scans just like PDFs — the wizard's inventory,
    thumbnails, and the `pdf` source path all resolve for image inputs."""
    _write(tmp_path / 'uploads' / 'AlphaWing' / '101.png', make_image('PNG'))
    _write(tmp_path / 'uploads' / 'AlphaWing' / '102.tif', make_image('TIFF'))

    proc = _run('scan', tmp_path)

    assert proc.returncode == 0, proc.stderr
    pdfs = json.loads(proc.stdout)['folders'][0]['pdfs']
    assert [p['file'] for p in pdfs] == ['101.png', '102.tif']
    for p in pdfs:
        assert p['pdf'] == 'uploads/AlphaWing/' + p['file']
        assert p['thumb'] == 'uploads/.thumbs/AlphaWing/' + p['file'] + '.png'
        assert (tmp_path / p['thumb']).is_file()


def test_build_renders_image_floor(tmp_path, make_image):
    """A raster image maps to a floor and renders into the manifest, indistinguishable
    downstream from a PDF-sourced floor (Pillow decode → re-encoded lossless WebP)."""
    _write(tmp_path / 'uploads' / 'AlphaWing' / 'ground.jpg', make_image('JPEG', 200, 300))
    (tmp_path / 'import-map.json').write_text(json.dumps({
        'buildings': {
            'AlphaWing': {'slug': 'alpha', 'name': 'Alpha Wing', 'abbr': 'AB',
                          'floors': {'ground': 'g'}},
        },
    }))

    proc = _run('build', tmp_path)
    assert proc.returncode == 0, proc.stderr

    (building,) = json.loads((tmp_path / 'manifest.json').read_text())['buildings']
    (floor,) = building['floors']
    assert floor['id'] == 'ABg'
    assert floor['image'] == 'images/alpha/ABg.webp'
    assert floor['w'] == 200 and floor['h'] == 300
    assert (tmp_path / floor['image']).is_file()


def test_build_honours_exif_orientation(tmp_path, make_image):
    """A JPEG with an EXIF orientation tag (orientation=6 → rotate 90°, as phone cameras and
    scanners write) renders upright: a stored 200×300 image lands 300×200 in the manifest, the
    raster analogue of the PDF renderer honouring page rotation."""
    _write(tmp_path / 'uploads' / 'AlphaWing' / 'ground.jpg',
           make_image('JPEG', 200, 300, exif_orientation=6))
    (tmp_path / 'import-map.json').write_text(json.dumps({
        'buildings': {
            'AlphaWing': {'slug': 'alpha', 'name': 'Alpha Wing', 'abbr': 'AB',
                          'floors': {'ground': 'g'}},
        },
    }))

    proc = _run('build', tmp_path)
    assert proc.returncode == 0, proc.stderr

    (building,) = json.loads((tmp_path / 'manifest.json').read_text())['buildings']
    (floor,) = building['floors']
    assert floor['w'] == 300 and floor['h'] == 200


def test_build_rotates_floor_by_angle(tmp_path, make_image):
    """A drawing straightened by the wizard's rotate control carries an `angles` entry in the
    import map; the build reorients it (post-render, `expand=True`) so a 200×300 scan lands 300×200
    at 90°, and the applied angle is recorded on the manifest page so re-import can detect a
    reorientation that would desync existing rooms."""
    _write(tmp_path / 'uploads' / 'AlphaWing' / 'ground.png',
           make_image('PNG', 200, 300))
    (tmp_path / 'import-map.json').write_text(json.dumps({
        'buildings': {
            'AlphaWing': {'slug': 'alpha', 'name': 'Alpha Wing', 'abbr': 'AB',
                          'floors': {'ground': 'g'}, 'angles': {'ground': 90}},
        },
    }))

    proc = _run('build', tmp_path)
    assert proc.returncode == 0, proc.stderr

    (building,) = json.loads((tmp_path / 'manifest.json').read_text())['buildings']
    (floor,) = building['floors']
    assert floor['w'] == 300 and floor['h'] == 200
    assert floor['pages'][0]['angle'] == 90


def test_build_without_angles_omits_angle_field(tmp_path, make_image):
    """A drawing with no rotation (no `angles` entry) renders at its native size and the manifest
    page carries no `angle` key — so older manifests/readers are unaffected."""
    _write(tmp_path / 'uploads' / 'AlphaWing' / 'ground.png',
           make_image('PNG', 200, 300))
    (tmp_path / 'import-map.json').write_text(json.dumps({
        'buildings': {
            'AlphaWing': {'slug': 'alpha', 'name': 'Alpha Wing', 'abbr': 'AB',
                          'floors': {'ground': 'g'}},
        },
    }))

    proc = _run('build', tmp_path)
    assert proc.returncode == 0, proc.stderr

    (building,) = json.loads((tmp_path / 'manifest.json').read_text())['buildings']
    (floor,) = building['floors']
    assert floor['w'] == 200 and floor['h'] == 300
    assert 'angle' not in floor['pages'][0]


def test_build_uses_wizard_label_over_token_guess(tmp_path, make_image):
    """A `labels` entry (the wizard's resolved Location field value, e.g. `description`) wins
    over `floor_label(token)`'s slug-title-case guess — the whole point of this being
    configurable rather than always deriving the label from the Location slug."""
    _write(tmp_path / 'uploads' / 'AlphaWing' / 'ground.png',
           make_image('PNG', 200, 300))
    (tmp_path / 'import-map.json').write_text(json.dumps({
        'buildings': {
            'AlphaWing': {'slug': 'alpha', 'name': 'Alpha Wing', 'abbr': '',
                          'floors': {'ground': 'basement-2'},
                          'labels': {'ground': 'Sub-basement Storage'}},
        },
    }))

    proc = _run('build', tmp_path)
    assert proc.returncode == 0, proc.stderr

    (building,) = json.loads((tmp_path / 'manifest.json').read_text())['buildings']
    (floor,) = building['floors']
    assert floor['label'] == 'Sub-basement Storage'


def test_build_without_labels_falls_back_to_token_guess(tmp_path, make_image):
    """No `labels` key at all (an old import map, or a floor-type token with no bound Location)
    renders exactly as before — `floor_label(token)`'s slug-title-case guess."""
    _write(tmp_path / 'uploads' / 'AlphaWing' / 'ground.png',
           make_image('PNG', 200, 300))
    (tmp_path / 'import-map.json').write_text(json.dumps({
        'buildings': {
            'AlphaWing': {'slug': 'alpha', 'name': 'Alpha Wing', 'abbr': '',
                          'floors': {'ground': 'basement-2'}},
        },
    }))

    proc = _run('build', tmp_path)
    assert proc.returncode == 0, proc.stderr

    (building,) = json.loads((tmp_path / 'manifest.json').read_text())['buildings']
    (floor,) = building['floors']
    assert floor['label'] == 'Basement 2'


def test_build_renders_svg_floor(tmp_path):
    """An SVG vector drawing rasterizes (via CairoSVG) into a floor, indistinguishable downstream
    from a PDF/raster floor: a WebP image whose width is the forced render size. Skipped when the
    optional CairoSVG decoder isn't installed — the render runs in the CLI subprocess, so importing
    it here is the honest availability probe."""
    pytest.importorskip('cairosvg')
    svg = (b'<?xml version="1.0"?>'
           b'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">'
           b'<rect width="400" height="300" fill="white"/>'
           b'<line x1="0" y1="0" x2="400" y2="300" stroke="black"/></svg>')
    _write(tmp_path / 'uploads' / 'AlphaWing' / 'ground.svg', svg)
    (tmp_path / 'import-map.json').write_text(json.dumps({
        'buildings': {
            'AlphaWing': {'slug': 'alpha', 'name': 'Alpha Wing', 'abbr': 'AB',
                          'floors': {'ground': 'g'}},
        },
    }))

    proc = _run('build', tmp_path)
    assert proc.returncode == 0, proc.stderr

    (building,) = json.loads((tmp_path / 'manifest.json').read_text())['buildings']
    (floor,) = building['floors']
    assert floor['id'] == 'ABg'
    assert floor['image'] == 'images/alpha/ABg.webp'
    # SvgFormat forces the longest side to RENDER_PX (2000) for a legible plan; 4:3 → 2000×1500.
    assert floor['w'] == 2000 and floor['h'] == 1500
    raw = (tmp_path / floor['image']).read_bytes()
    assert raw[:4] == b'RIFF' and raw[8:12] == b'WEBP'


def test_build_renders_dxf_floor(tmp_path):
    """A DXF vector CAD drawing rasterizes (ezdxf renders the modelspace to SVG, CairoSVG rasters
    it) into a floor, indistinguishable downstream from a PDF/raster/SVG floor: a WebP whose width
    is the forced render size. Skipped when the optional ezdxf/CairoSVG decoders aren't installed —
    the render runs in the CLI subprocess, so importing them here is the honest availability probe."""
    ezdxf = pytest.importorskip('ezdxf')
    pytest.importorskip('cairosvg')
    dxf_path = tmp_path / 'uploads' / 'AlphaWing' / 'ground.dxf'
    dxf_path.parent.mkdir(parents=True, exist_ok=True)
    doc = ezdxf.new()
    doc.modelspace().add_line((0, 0), (400, 300))
    doc.saveas(str(dxf_path))
    (tmp_path / 'import-map.json').write_text(json.dumps({
        'buildings': {
            'AlphaWing': {'slug': 'alpha', 'name': 'Alpha Wing', 'abbr': 'AB',
                          'floors': {'ground': 'g'}},
        },
    }))

    proc = _run('build', tmp_path)
    assert proc.returncode == 0, proc.stderr

    (building,) = json.loads((tmp_path / 'manifest.json').read_text())['buildings']
    (floor,) = building['floors']
    assert floor['id'] == 'ABg'
    assert floor['image'] == 'images/alpha/ABg.webp'
    # DxfFormat forces the render width to RENDER_PX (2000) via CairoSVG's output_width; the height
    # follows the drawing's own aspect (ezdxf auto-page + margins), so only pin the exact width.
    assert floor['w'] == 2000 and floor['h'] >= 1
    raw = (tmp_path / floor['image']).read_bytes()
    assert raw[:4] == b'RIFF' and raw[8:12] == b'WEBP'


def test_build_without_import_map_fails(tmp_path, make_pdf):
    _write_pdf(tmp_path / 'uploads' / 'AlphaWing' / 'ground.pdf', make_pdf())

    proc = _run('build', tmp_path)

    assert proc.returncode != 0
    assert 'import-map.json' in proc.stderr
    assert not (tmp_path / 'manifest.json').exists()


# ---- pure helpers (loaded by path, no Django) ----

@pytest.fixture(scope='module')
def preprocess_module():
    """Load preprocess.py in isolation from its file path — this must succeed without any Django
    import, which is exactly the isolation invariant we want to keep honest."""
    spec = importlib.util.spec_from_file_location('_facilitymap_preprocess', PREPROCESS)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.mark.parametrize('token,label', [
    ('g', 'Ground'),
    ('r', 'Roof'),
    ('b3', 'Basement 3'),
    ('l1', 'Level 1'),
    ('gl1', 'Ground / Level 1'),
    ('basement-2', 'Basement 2'),      # slug mode (title-cased), not the compact code
    ('storage-b2', 'Storage B2'),      # slug must NOT be parsed as loose g/r letters
])
def test_floor_label(preprocess_module, token, label):
    assert preprocess_module.Preprocessor.floor_label(token) == label


def test_dwg_sort_key_orders_sheets(preprocess_module):
    key = preprocess_module.Preprocessor.dwg_sort_key
    stems = ['101', '100-2', '100', 'building']
    # numeric first (a '-N' second sheet sorts right after its base), non-numeric last.
    assert sorted(stems, key=key) == ['100', '100-2', '101', 'building']


def test_page_entries_splits_bare_and_compound(preprocess_module):
    pe = preprocess_module.Preprocessor._page_entries
    # A bare stem key -> page 0 (the single-page/whole-file case); scalar value -> region None,
    # label_key is the map key itself.
    assert pe('ground', {'ground': 'g'}) == [(0, 'g', None, 'ground')]
    # `stem#pN` keys -> page N-1, returned in page order (the exploded multi-page PDF case).
    assert pe('set', {'set#p2': 'b1', 'set#p1': 'g'}) == [
        (0, 'g', None, 'set#p1'), (1, 'b1', None, 'set#p2')]
    # Keys for other drawings are ignored; an unmapped drawing yields no entries.
    assert pe('other', {'set#p1': 'g'}) == []
    # A blank token contributes nothing (mirrors the bare-key `if not token` skip).
    assert pe('set', {'set#p1': ''}) == []


def test_page_entries_region_split_fans_one_page_to_several(preprocess_module):
    pe = preprocess_module.Preprocessor._page_entries
    # A list value splits one page into several floors: each entry keeps its 0..1 crop box and gets
    # a compound `<map key>@rN` label key in list order (1-based).
    assert pe('wing', {'wing': [
        {'token': '2', 'region': [0, 0, 0.5, 1]},
        {'token': '3', 'region': [0.5, 0, 0.5, 1]},
    ]}) == [
        (0, '2', [0, 0, 0.5, 1], 'wing@r1'),
        (0, '3', [0.5, 0, 0.5, 1], 'wing@r2'),
    ]
    # Region-split composes atop page explosion: an exploded page's value can itself be a list, and
    # the compound key carries the `#pN` page key.
    assert pe('set', {'set#p2': [
        {'token': 'a', 'region': [0, 0, 1, 0.5]},
        {'token': 'b', 'region': [0, 0.5, 1, 0.5]},
    ]}) == [
        (1, 'a', [0, 0, 1, 0.5], 'set#p2@r1'),
        (1, 'b', [0, 0.5, 1, 0.5], 'set#p2@r2'),
    ]
    # A list entry with a blank/absent token is skipped; a missing region is carried as None.
    assert pe('wing', {'wing': [
        {'token': '', 'region': [0, 0, 1, 1]},
        {'token': '2'},
    ]}) == [(0, '2', None, 'wing@r2')]


def _webp_bytes(width, height):
    """Encode a solid RGB image to WebP bytes — a stand-in for a `render_full` page render."""
    from PIL import Image
    buf = io.BytesIO()
    Image.new('RGB', (width, height), 'white').save(buf, 'WEBP')
    return buf.getvalue()


def test_crop_encoded_crops_to_region(preprocess_module):
    """`_crop_encoded` maps a normalized 0..1 `[x, y, w, h]` box to a pixel sub-rectangle of the
    encoded page and re-encodes it — the FLOOR-3 region crop. The result's w/h are the crop's pixel
    size (the derived floor's own 0..1 canvas), and it is a real WebP."""
    crop = preprocess_module.Preprocessor._crop_encoded
    res = crop(_webp_bytes(100, 80), [0.25, 0.5, 0.5, 0.5], 'WEBP')
    assert res is not None
    raw, w, h = res
    assert (w, h) == (50, 40)                       # [0.25..0.75]x[0.5..1.0] of 100x80
    assert raw[:4] == b'RIFF' and raw[8:12] == b'WEBP'


def test_crop_encoded_clamps_out_of_bounds_region(preprocess_module):
    """A box whose right/bottom edge overshoots 1.0 is clamped to the image bounds rather than
    erroring — the crop stops at the page edge."""
    crop = preprocess_module.Preprocessor._crop_encoded
    raw, w, h = crop(_webp_bytes(100, 80), [0.5, 0, 1, 1], 'WEBP')  # right rounds to 150 -> clamp 100
    assert (w, h) == (50, 80)


def test_crop_encoded_rejects_degenerate_region(preprocess_module):
    """A box that rounds to <1px on a side yields None (the build then skips that sheet with the
    existing pageless-floor handling) — a loud degrade, never a crash or a zero-size image."""
    crop = preprocess_module.Preprocessor._crop_encoded
    assert crop(_webp_bytes(100, 80), [0.2, 0.2, 0, 0.5], 'WEBP') is None      # zero width
    assert crop(_webp_bytes(100, 80), [0, 0, 0.001, 0.001], 'WEBP') is None    # rounds to 0x0


def test_write_manifest_is_atomic_on_failure(preprocess_module, tmp_path, monkeypatch):
    """A manifest write killed mid-stream must leave the previous good manifest intact, never a
    truncated file — the data-integrity guarantee that keeps a failed build from stranding the
    facility in a fresh-install-looking empty state (IMPORT-3)."""
    pre = preprocess_module.Preprocessor(str(tmp_path))
    good = {'siteplan': None, 'buildings': [{'dir': 'alpha'}], 'built': 1}
    (tmp_path / 'manifest.json').write_text(json.dumps(good))

    def boom(*_a, **_k):
        raise RuntimeError('render killed mid-write')

    monkeypatch.setattr(preprocess_module.json, 'dump', boom)
    with pytest.raises(RuntimeError):
        pre.write_manifest({'siteplan': None, 'buildings': [], 'built': 2})

    # The previous manifest survives byte-for-byte — the failed write only ever touched the
    # `.part` temp (harmlessly truncated + reused on the next write), never manifest.json itself.
    assert json.loads((tmp_path / 'manifest.json').read_text()) == good


def test_page_count_counts_pdf_pages(preprocess_module, tmp_path, make_pdf, make_multipage_pdf):
    page_count = preprocess_module.Preprocessor.page_count
    (tmp_path / 'set.pdf').write_bytes(make_multipage_pdf([(120, 160)] * 4))
    (tmp_path / 'one.pdf').write_bytes(make_pdf())
    assert page_count(str(tmp_path / 'set.pdf')) == 4
    assert page_count(str(tmp_path / 'one.pdf')) == 1
    # An unknown extension has no handler and counts as a single page.
    assert page_count(str(tmp_path / 'plan.dwg')) == 1


# ---- drawing_formats registry (the single source of truth, loaded by path, no Django) ----

@pytest.fixture(scope='module')
def formats_module():
    """Load drawing_formats.py from its file path — like preprocess.py it must import cleanly
    with no Django, so the render subprocess and the NetBox worker can both read the registry."""
    spec = importlib.util.spec_from_file_location('_facilitymap_drawing_formats', DRAWING_FORMATS)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # exec must not require Django/pypdfium2/Pillow to be importable
    return mod


def test_registry_derives_accepted_extensions(formats_module):
    # The one list every side derives from. As of PKG-1 it narrows to the *installed* formats, so
    # pin the derivation RULE (consistency with whatever's installed here) rather than a fixed list —
    # and assert the always-present base formats (PDF + the six Pillow rasters) lead the tuple.
    m = formats_module
    assert m.DRAWING_EXTS == tuple(e for f in m.FORMATS if f.available() for e in f.exts)
    # Companion siblings are a separate derived list — never folded into DRAWING_EXTS (else the
    # scan/build/mapping layers would treat a `.shx`/`.dbf` as its own drawing) — and only an
    # available format's companions are accepted.
    assert m.COMPANION_EXTS == tuple(e for f in m.FORMATS if f.available() for e in f.companions)
    assert m.DRAWING_EXTS[:9] == (
        '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.tif', '.tiff', '.bmp', '.webp')


# ---- PKG-1: optional-format availability gating (the framework the FMT-* family plugs into) ----

@pytest.fixture
def _bare_install(formats_module, monkeypatch):
    """Simulate a lean default install — only the core modules (pypdfium2/Pillow) importable and no
    `soffice` binary — so every optional format gates OFF. `_module_installed` (find_spec probe) and
    `shutil.which` are the two seams `available()` consults."""
    monkeypatch.setattr(formats_module, '_module_installed', lambda name: name in {'pypdfium2', 'PIL'})
    monkeypatch.setattr('shutil.which', lambda _cmd: None)
    return formats_module


def test_available_gates_on_module_presence(_bare_install):
    m = _bare_install
    # Core formats are always available; the optional ones gate off in a bare install.
    assert m.format_for('a.pdf').available() is True
    assert m.format_for('a.png').available() is True
    assert m.format_for('a.svg').available() is False       # needs cairosvg ([svg])
    assert m.format_for('a.dxf').available() is False        # needs ezdxf + cairosvg ([cad])
    assert m.format_for('a.shp').available() is False        # needs pyshp ([gis])
    assert m.format_for('a.geojson').available() is False    # gates on the [gis] marker (pyshp)
    assert m.format_for('a.kml').available() is False        # gates on the [gis] marker (pyshp)
    assert m.format_for('a.kmz').available() is False        # gates on the [gis] marker (pyshp)
    assert m.format_for('a.vsdx').available() is False       # needs the soffice binary


def test_gis_extra_lights_up_shapefile_and_geojson_together(formats_module, monkeypatch):
    # GeoJSON/KML/KMZ have no decoder of their own, so they ride the [gis] marker (pyshp):
    # installing [gis] makes Shapefile AND every stdlib-parsed geospatial overlay available at once.
    monkeypatch.setattr(formats_module, '_module_installed',
                        lambda name: name in {'pypdfium2', 'PIL', 'shapefile'})
    assert formats_module.format_for('a.shp').available() is True
    assert formats_module.format_for('a.geojson').available() is True
    assert formats_module.format_for('a.kml').available() is True
    assert formats_module.format_for('a.kmz').available() is True
    assert formats_module.format_for('a.svg').available() is False   # [svg] still absent


def test_available_gates_on_binary_presence(formats_module, monkeypatch):
    # Visio has no pip decoder — it gates on the external soffice/libreoffice binary (either name).
    monkeypatch.setattr(formats_module, '_module_installed', lambda _name: True)
    monkeypatch.setattr('shutil.which', lambda _cmd: None)
    assert formats_module.format_for('a.vsdx').available() is False
    monkeypatch.setattr('shutil.which', lambda cmd: '/usr/bin/soffice' if cmd == 'soffice' else None)
    assert formats_module.format_for('a.vsdx').available() is True
    assert formats_module.format_for('a.vsd').available() is True


def test_drawing_exts_narrow_to_installed_formats(_bare_install):
    # The derived ext lists drop an uninstalled format's extensions. DRAWING_EXTS itself is frozen at
    # import, so exercise the derivation RULE live under the simulated bare install.
    m = _bare_install
    exts = tuple(e for f in m.FORMATS if f.available() for e in f.exts)
    comps = tuple(e for f in m.FORMATS if f.available() for e in f.companions)
    assert exts == ('.pdf', '.png', '.jpg', '.jpeg', '.gif', '.tif', '.tiff', '.bmp', '.webp')
    assert comps == ()   # the only companions belong to Shapefile, gated out in a bare install


@pytest.mark.parametrize('path,extra', [
    ('x.svg', 'netbox-facilitymap[svg]'),
    ('x.dxf', 'netbox-facilitymap[cad]'),
    ('x.shp', 'netbox-facilitymap[gis]'),
    ('x.geojson', 'netbox-facilitymap[gis]'),
    ('x.kml', 'netbox-facilitymap[gis]'),
    ('x.kmz', 'netbox-facilitymap[gis]'),
])
def test_install_hint_names_the_pip_extra(formats_module, path, extra):
    assert extra in formats_module.format_for(path).install_hint()


def test_install_hint_visio_names_the_binary(formats_module):
    # Visio has no pip extra — its hint falls back to the human `requires` string (soffice binary).
    hint = formats_module.format_for('x.vsdx').install_hint()
    assert 'soffice' in hint and 'pip install' not in hint


def test_install_hint_for_reports_recognized_but_uninstalled(_bare_install):
    # A recognized-but-uninstalled extension → an actionable install hint; an available or unknown
    # extension → None. format_for still resolves the uninstalled handler so the hint can be built.
    m = _bare_install
    assert 'netbox-facilitymap[svg]' in m.install_hint_for('plans/floor1.svg')
    assert m.install_hint_for('plans/floor1.pdf') is None   # available (core)
    assert m.install_hint_for('notes.txt') is None          # unknown extension
    assert m.format_for('x.svg') is not None
    # A companion sibling of a gated-out format reports its owner's extra too.
    assert 'netbox-facilitymap[gis]' in m.install_hint_for('data/roads.dbf')


@pytest.mark.parametrize('head,name', [
    (b'%PDF-1.7 rest', 'pdf'),
    (b'\x89PNG\r\n\x1a\n....', 'png'),
    (b'\xff\xd8\xff\xe0JFIF', 'jpeg'),
    (b'GIF89a....', 'gif'),
    (b'MM\x00*....', 'tiff'),
    (b'BM....', 'bmp'),
    (b'RIFF\x00\x00\x00\x00WEBPVP8 ', 'webp'),
    # SVG is XML text, not a binary magic: an XML declaration, a bare <svg> root, or a DOCTYPE
    # all sniff as svg, tolerating a leading UTF-8 BOM + whitespace.
    (b'<?xml version="1.0"?>', 'svg'),
    (b'<svg xmlns="http://', 'svg'),
    (b'\xef\xbb\xbf  \n<svg>', 'svg'),
    (b'<!DOCTYPE svg PUBLIC', 'svg'),
    # DXF: binary DXF opens with a 22-byte sentinel (matched by its 16-byte prefix in the sniff
    # window); ASCII DXF has no fixed magic, so a text head carrying the HEADER SECTION marker sniffs
    # as dxf. A NUL after a SECTION-like run marks it binary, not an ASCII DXF (falls through).
    (b'AutoCAD Binary DXF\r\n\x1a\x00', 'dxf'),
    (b'  0\r\nSECTION\r\n  2\r\nHEADER', 'dxf'),
    # VSDX is an OOXML zip package, so its magic is the generic ZIP local-file header; VSD is the
    # legacy OLE2 compound-file binary. Both convert to PDF via soffice downstream.
    (b'PK\x03\x04', 'vsdx'),
    (b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1', 'vsd'),
    # GeoJSON has no binary magic either — it's a JSON object, so a text head opening with `{`
    # (tolerating a UTF-8 BOM + whitespace) sniffs as geojson. The 16-byte window can't see a
    # later `"type":"FeatureCollection"`, so the gate is deliberately lenient — extract_overlay
    # does the real structure validation.
    (b'{"type":"FeatureColl', 'geojson'),
    (b'\xef\xbb\xbf  \n{ "features"', 'geojson'),
])
def test_registry_sniff_names_the_format(formats_module, head, name):
    # `sniff` is a pure magic classifier over the full known registry (availability is enforced by
    # the narrowed extension gate, not here), so every known format's magic is recognized.
    assert formats_module.sniff(head) == name


@pytest.mark.parametrize('path,expect_name', [
    ('a/b/plan.pdf', 'pdf'),
    ('scan.PNG', 'png'),        # extension match is case-insensitive
    ('photo.jpeg', 'jpeg'),
    ('vector.svg', 'svg'),
    ('plan.dxf', 'dxf'),
    ('diagram.vsdx', 'vsdx'),
    ('legacy.VSD', 'vsd'),      # extension match is case-insensitive
    ('drawing.dwg', None),      # unknown extension → no handler
])
def test_registry_format_for_dispatches_by_extension(formats_module, path, expect_name):
    handler = formats_module.format_for(path)
    assert (handler.name if handler else None) == expect_name
    if handler is not None:
        assert handler.role == formats_module.BASE_RASTER


def test_soffice_format_degrades_without_binary(formats_module, tmp_path, monkeypatch):
    # A Visio upload is accepted unconditionally (its extension is in DRAWING_EXTS), so when the
    # optional `soffice` binary is absent the render must fail soft — None/False, never a crash —
    # exactly as SVG degrades without libcairo. `shutil.which` is monkeypatched to simulate that.
    monkeypatch.setattr('shutil.which', lambda _cmd: None)
    handler = formats_module.format_for('diagram.vsdx')
    src = tmp_path / 'diagram.vsdx'
    src.write_bytes(b'PK\x03\x04 not really a visio file')
    assert handler.render_full(str(src)) is None
    assert handler.render_thumb(str(src), str(tmp_path / 'out.png')) is False


def test_dxf_is_a_base_raster_format(formats_module):
    # DXF (FMT-3) is a BASE_RASTER handler decoded via the optional `[dxf]` extra (ezdxf), like a
    # PDF/raster/SVG — not an overlay. Single self-contained file, so no companion siblings.
    dxf = formats_module.format_for('plan.dxf')
    assert dxf.name == 'dxf'
    assert dxf.role == formats_module.BASE_RASTER
    assert dxf.requires == 'ezdxf'
    assert dxf.exts == ('.dxf',)
    assert dxf.companions == ()


def test_dxf_degrades_without_ezdxf(formats_module, tmp_path):
    # Optional dep: absent ezdxf, a `.dxf` render must fail soft (None, never a crash) — the same
    # graceful-degradation contract as SVG without libcairo. Skipped when ezdxf is installed (then
    # the render path is exercised by test_build_renders_dxf_floor instead).
    if _ezdxf_available():
        pytest.skip('ezdxf installed; this asserts the missing-decoder degrade path')
    src = tmp_path / 'plan.dxf'
    src.write_bytes(b'0\r\nSECTION\r\n')   # sniff-plausible, but ezdxf is absent to decode it
    assert formats_module.format_for('plan.dxf').render_full(str(src)) is None
    assert formats_module.format_for('plan.dxf').render_thumb(str(src), str(tmp_path / 'o.png')) is False


def _ezdxf_available():
    try:
        import ezdxf  # noqa: F401
        return True
    except ImportError:
        return False


def test_shapefile_is_the_overlay_format(formats_module):
    # FMT-6 makes Shapefile the first concrete OVERLAY handler (FMT-9 scaffolded the role/contract).
    # It's a multi-file set, so it declares companion siblings that stay out of DRAWING_EXTS.
    # (The full OVERLAY set — shp then geojson — is pinned by test_geojson_is_an_overlay_format.)
    overlays = [f.name for f in formats_module.FORMATS if f.role == formats_module.OVERLAY]
    assert 'shp' in overlays
    shp = formats_module.format_for('x.shp')
    assert shp.role == formats_module.OVERLAY
    assert shp.requires == 'pyshp'
    assert shp.companions == ('.shx', '.dbf', '.prj', '.cpg')


@pytest.mark.parametrize('ext,head,ok', [
    ('.shx', b'\x00\x00\x27\x0a\x00\x00', True),    # index shares the .shp header magic
    ('.shx', b'not a shapefile index', False),
    ('.dbf', b'\x03\x00\x00\x00', True),            # dBASE III version byte
    ('.dbf', b'\xffnope', False),                   # unknown version byte
    ('.prj', b'PROJCS["NAD83"]', True),             # WKT text
    ('.cpg', b'UTF-8', True),                       # encoding name
    ('.prj', b'PROJ\x00CS', False),                 # a NUL byte marks it binary, not text
    ('.pdf', b'anything', False),                   # not a companion extension
])
def test_shapefile_sniff_companion(formats_module, ext, head, ok):
    assert formats_module.sniff_companion(head, ext) is ok


def test_shapefile_sniff_main_header(formats_module):
    shp = formats_module.format_for('x.shp')
    assert shp.sniff(b'\x00\x00\x27\x0a rest of the 100-byte header') is True
    assert shp.sniff(b'%PDF-1.7') is False


def test_shapefile_extract_overlay_without_pyshp(formats_module, tmp_path):
    # Optional dep: absent pyshp degrades to None (the "need pyshp" warning path), never a crash.
    # Simulated by pointing at a path pyshp can't open — Reader raises, handler returns None.
    if _pyshp_available():
        pytest.skip('pyshp installed; this asserts the missing/unreadable-parser degrade path')
    assert formats_module.format_for('x.shp').extract_overlay(str(tmp_path / 'nope.shp')) is None


def test_shapefile_extract_overlay_projects_features(formats_module, tmp_path):
    shapefile = pytest.importorskip('shapefile', reason='pyshp is an optional [shapefile] extra')
    base = tmp_path / 'poly.shp'
    w = shapefile.Writer(str(base))
    w.field('NAME', 'C')
    w.poly([[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]])   # square, north edge at y=10
    w.record('BldgA')
    w.close()
    res = formats_module.format_for(str(base)).extract_overlay(str(base))
    (feat,) = res['features']
    assert feat['type'] == 'polygon'
    assert feat['props'] == {'NAME': 'BldgA'}
    # Fit-to-bounds → 0..1, Y flipped: the north edge (source y=10) lands at the top (ny == 0).
    xs = [c[0] for c in feat['coords']]
    ys = [c[1] for c in feat['coords']]
    assert (min(xs), max(xs)) == (0.0, 1.0)
    assert (min(ys), max(ys)) == (0.0, 1.0)
    north = feat['coords'][1]            # source (0, 10)
    assert north == pytest.approx([0.0, 0.0])
    # No .prj sibling → the CRS family is unknown (treated planar) and, with no align pairs,
    # the placement stays fit-to-bounds — flagged approximate, with the transform recorded.
    assert res['georeferenced'] is False
    assert res['crs'] == 'unknown'
    assert len(res['srcTransform']) == 6


def _pyshp_available():
    try:
        import shapefile  # noqa: F401
        return True
    except ImportError:
        return False


# ---- GeoJSON overlay (FMT-7 — the second OVERLAY consumer; stdlib json, single file) ----

def test_geojson_is_an_overlay_format(formats_module):
    # FMT-7 is the sister GIS overlay to Shapefile, but a single self-contained JSON file parsed
    # with the standard library — no decoder dep (requires == '') and no companion siblings.
    overlays = [f.name for f in formats_module.FORMATS if f.role == formats_module.OVERLAY]
    assert overlays == ['shp', 'geojson', 'kml', 'kmz']
    gj = formats_module.format_for('sensors.geojson')
    assert gj.role == formats_module.OVERLAY
    assert gj.requires == ''            # stdlib json — no decoder to name in the render hint
    assert gj.extra == 'gis'            # but shipped in the [gis] package (gated on its pyshp marker)
    assert gj.exts == ('.geojson',)
    assert gj.companions == ()


@pytest.mark.parametrize('head,ok', [
    (b'{"type":"FeatureCollection"', True),
    (b'\xef\xbb\xbf  \n{ "type"', True),        # UTF-8 BOM + leading whitespace tolerated
    (b'not json at all', False),                # doesn't open with an object
    (b'[1,2,3]', False),                        # a JSON array, not a GeoJSON object
    (b'{\x00binary', False),                    # a NUL marks it binary, not JSON text
])
def test_geojson_sniff(formats_module, head, ok):
    assert formats_module.format_for('x.geojson').sniff(head) is ok


def _write_geojson(path, obj):
    import json
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj), encoding='utf-8')


def test_geojson_extract_overlay_projects_features(formats_module, tmp_path):
    # A square polygon (north edge at lat=5) fit to bounds → 0..1, Y flipped so north lands at the
    # top (ny == 0), mirroring the Shapefile projection test. Attribute props ride along. The
    # square straddles the equator so the geographic equirectangular pre-scale is exactly 1
    # (cos 0°) and the bounds stay crisp; the off-equator aspect correction has its own test in
    # the OverlayProjector section.
    src = tmp_path / 'poly.geojson'
    _write_geojson(src, {
        'type': 'FeatureCollection',
        'features': [{
            'type': 'Feature',
            'properties': {'NAME': 'BldgA'},
            'geometry': {'type': 'Polygon',
                         'coordinates': [[[0, -5], [0, 5], [10, 5], [10, -5], [0, -5]]]},
        }],
    })
    res = formats_module.format_for(str(src)).extract_overlay(str(src))
    (feat,) = res['features']
    assert feat['type'] == 'polygon'
    assert feat['props'] == {'NAME': 'BldgA'}
    xs = [c[0] for c in feat['coords']]
    ys = [c[1] for c in feat['coords']]
    assert (min(xs), max(xs)) == (0.0, 1.0)
    assert (min(ys), max(ys)) == pytest.approx((0.0, 1.0))
    north = feat['coords'][1]            # source (0, 5)
    assert north == pytest.approx([0.0, 0.0])
    # GeoJSON is WGS84 lon/lat by spec → always the geographic CRS family; still fit-to-bounds
    # (no align pairs), so flagged approximate.
    assert res['crs'] == 'geographic'
    assert res['georeferenced'] is False


def test_geojson_extract_overlay_all_geometry_types(formats_module, tmp_path):
    # Every concrete geometry type maps to the overlay feature shape: point/multipoint → one point
    # per position, line/multiline → one line each, polygon/multipolygon → one polygon per ring,
    # and a GeometryCollection flattens into its members (carrying the Feature's props).
    src = tmp_path / 'mix.geojson'
    ring = [[0, 0], [0, 1], [1, 1], [0, 0]]
    _write_geojson(src, {
        'type': 'FeatureCollection',
        'features': [
            {'type': 'Feature', 'properties': {'k': 'pt'},
             'geometry': {'type': 'Point', 'coordinates': [1, 2]}},
            {'type': 'Feature', 'properties': {},
             'geometry': {'type': 'MultiPoint', 'coordinates': [[0, 0], [3, 4]]}},
            {'type': 'Feature', 'properties': {},
             'geometry': {'type': 'LineString', 'coordinates': [[0, 0], [5, 5]]}},
            {'type': 'Feature', 'properties': {},
             'geometry': {'type': 'MultiLineString',
                          'coordinates': [[[0, 0], [1, 1]], [[2, 2], [3, 3]]]}},
            {'type': 'Feature', 'properties': {},
             'geometry': {'type': 'Polygon', 'coordinates': [ring, ring]}},   # exterior + a hole ring
            {'type': 'Feature', 'properties': {},
             'geometry': {'type': 'MultiPolygon', 'coordinates': [[ring], [ring]]}},
            {'type': 'Feature', 'properties': {'k': 'gc'},
             'geometry': {'type': 'GeometryCollection', 'geometries': [
                 {'type': 'Point', 'coordinates': [9, 9]},
                 {'type': 'LineString', 'coordinates': [[0, 0], [9, 9]]}]}},
        ],
    })
    feats = formats_module.format_for(str(src)).extract_overlay(str(src))['features']
    kinds = [f['type'] for f in feats]
    assert kinds.count('point') == 1 + 2 + 1        # Point + MultiPoint(2) + GC's Point
    assert kinds.count('line') == 1 + 2 + 1         # LineString + MultiLineString(2) + GC's line
    assert kinds.count('polygon') == 2 + 2          # Polygon(2 rings) + MultiPolygon(2 rings)
    # The Feature's props propagate to the concrete geometries a GeometryCollection flattens into.
    gc_feats = [f for f in feats if f['props'] == {'k': 'gc'}]
    assert len(gc_feats) == 2


def test_geojson_extract_overlay_accepts_bare_feature_and_geometry(formats_module, tmp_path):
    # A top-level bare Feature and a top-level bare Geometry are valid GeoJSON too, not only a
    # FeatureCollection. A bare geometry has no attributes → empty props.
    feat_src = tmp_path / 'feat.geojson'
    _write_geojson(feat_src, {'type': 'Feature', 'properties': {'id': 7},
                              'geometry': {'type': 'Point', 'coordinates': [1, 1]}})
    (feat,) = formats_module.format_for(str(feat_src)).extract_overlay(str(feat_src))['features']
    assert feat['type'] == 'point' and feat['props'] == {'id': 7}

    geom_src = tmp_path / 'geom.geojson'
    _write_geojson(geom_src, {'type': 'LineString', 'coordinates': [[0, 0], [1, 1]]})
    (line,) = formats_module.format_for(str(geom_src)).extract_overlay(str(geom_src))['features']
    assert line['type'] == 'line' and line['props'] == {}


@pytest.mark.parametrize('body', [
    b'{not valid json',                                     # malformed JSON
    b'{"type": "FeatureCollection", "features": []}',       # no features → no geometry
    b'{"type": "Topology", "objects": {}}',                 # not GeoJSON (e.g. TopoJSON)
    b'42',                                                  # valid JSON, but not an object
])
def test_geojson_extract_overlay_invalid_returns_none(formats_module, tmp_path, body):
    # Bad or geometry-less input degrades to None (the "could not read" path), never a crash —
    # the same graceful-degradation contract as a corrupt shapefile.
    src = tmp_path / 'bad.geojson'
    src.write_bytes(body)
    assert formats_module.format_for(str(src)).extract_overlay(str(src)) is None


def test_geojson_extract_overlay_caps_feature_count(formats_module, tmp_path):
    # A layer with more points than MAX_FEATURES is capped (bounds manifest size + frontend cost).
    gj = formats_module.format_for('x.geojson')
    n = gj.MAX_FEATURES + 50
    src = tmp_path / 'many.geojson'
    _write_geojson(src, {
        'type': 'FeatureCollection',
        'features': [{'type': 'Feature', 'properties': {},
                      'geometry': {'type': 'Point', 'coordinates': [i, i]}} for i in range(n)],
    })
    feats = gj.extract_overlay(str(src))['features']
    assert len(feats) == gj.MAX_FEATURES


# ---- KML / KMZ overlay (FMT-8 — the third geospatial OVERLAY, stdlib xml + zipfile) ----

_KML_NS = 'http://www.opengis.net/kml/2.2'


def test_kml_is_an_overlay_format(formats_module):
    # FMT-8 is the third GIS overlay after Shapefile/GeoJSON: KML (XML) + KMZ (zipped KML), both
    # parsed with the standard library — no decoder dep (requires == '') and no companions. KMZ
    # inherits KmlFormat's pipeline, so both share the [gis]-marker gating.
    kml = formats_module.format_for('roads.kml')
    kmz = formats_module.format_for('roads.kmz')
    for fmt in (kml, kmz):
        assert fmt.role == formats_module.OVERLAY
        assert fmt.requires == ''          # stdlib parser — no decoder to name in the render hint
        assert fmt.extra == 'gis'          # shipped in [gis], gated on its pyshp marker
        assert fmt.companions == ()
    assert (kml.name, kml.exts) == ('kml', ('.kml',))
    assert (kmz.name, kmz.exts) == ('kmz', ('.kmz',))


@pytest.mark.parametrize('head,ok', [
    (b'<?xml version="1.0"?>', True),           # XML declaration
    (b'<kml xmlns="http://', True),             # a declaration-less <kml> root
    (b'\xef\xbb\xbf  \n<kml>', True),           # UTF-8 BOM + leading whitespace tolerated
    (b'not xml at all', False),                 # doesn't open with an XML/kml token
    (b'<kml>\x00binary', False),                # a NUL marks it binary, not XML text
])
def test_kml_sniff(formats_module, head, ok):
    assert formats_module.format_for('x.kml').sniff(head) is ok


def test_kmz_sniff_is_the_zip_magic(formats_module):
    # KMZ is a zip — the generic ZIP local-file header (shared with VSDX; routing is by extension).
    kmz = formats_module.format_for('x.kmz')
    assert kmz.sniff(b'PK\x03\x04rest') is True
    assert kmz.sniff(b'<?xml') is False


def _kml_doc(placemarks):
    return ('<?xml version="1.0" encoding="UTF-8"?>'
            '<kml xmlns="%s"><Document>%s</Document></kml>' % (_KML_NS, placemarks)).encode('utf-8')


def test_kml_extract_overlay_projects_features(formats_module, tmp_path):
    # A square polygon (north edge at lat=5) fit to bounds → 0..1, Y flipped so north lands at the
    # top (ny == 0), mirroring the GeoJSON/Shapefile projection tests. The placemark <name> rides
    # along as a prop. Equator-straddling like the GeoJSON test, so the geographic pre-scale is
    # exactly 1 and the bounds stay crisp.
    src = tmp_path / 'poly.kml'
    src.write_bytes(_kml_doc(
        '<Placemark><name>BldgA</name><Polygon><outerBoundaryIs><LinearRing><coordinates>'
        '0,-5 0,5 10,5 10,-5 0,-5'
        '</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>'))
    res = formats_module.format_for(str(src)).extract_overlay(str(src))
    (feat,) = res['features']
    assert feat['type'] == 'polygon'
    assert feat['props'] == {'name': 'BldgA'}
    xs = [c[0] for c in feat['coords']]
    ys = [c[1] for c in feat['coords']]
    assert (min(xs), max(xs)) == (0.0, 1.0)
    assert (min(ys), max(ys)) == pytest.approx((0.0, 1.0))
    north = feat['coords'][1]            # source (0, 5)
    assert north == pytest.approx([0.0, 0.0])
    assert res['crs'] == 'geographic'    # KML is WGS84 lon/lat by spec
    assert res['georeferenced'] is False


def test_kml_extract_overlay_all_geometry_types(formats_module, tmp_path):
    # Every KML geometry maps to the overlay feature shape: Point → point, LineString → line,
    # LinearRing and each Polygon boundary ring → polygon (one per ring), and MultiGeometry
    # flattens into its members. ExtendedData fields join the placemark's props.
    ring = '0,0 0,1 1,1 0,0'
    src = tmp_path / 'mix.kml'
    src.write_bytes(_kml_doc(
        '<Placemark><name>pt</name><Point><coordinates>1,2</coordinates></Point></Placemark>'
        '<Placemark><LineString><coordinates>0,0 5,5</coordinates></LineString></Placemark>'
        '<Placemark><LinearRing><coordinates>%s</coordinates></LinearRing></Placemark>' % ring +
        '<Placemark><Polygon>'
        '<outerBoundaryIs><LinearRing><coordinates>%s</coordinates></LinearRing></outerBoundaryIs>'
        '<innerBoundaryIs><LinearRing><coordinates>%s</coordinates></LinearRing></innerBoundaryIs>'
        '</Polygon></Placemark>' % (ring, ring) +
        '<Placemark><ExtendedData><Data name="k"><value>gc</value></Data></ExtendedData>'
        '<MultiGeometry>'
        '<Point><coordinates>9,9</coordinates></Point>'
        '<LineString><coordinates>0,0 9,9</coordinates></LineString>'
        '</MultiGeometry></Placemark>'))
    feats = formats_module.format_for(str(src)).extract_overlay(str(src))['features']
    kinds = [f['type'] for f in feats]
    assert kinds.count('point') == 1 + 1            # standalone Point + MultiGeometry's Point
    assert kinds.count('line') == 1 + 1             # LineString + MultiGeometry's LineString
    assert kinds.count('polygon') == 1 + 2          # LinearRing + Polygon(outer + inner rings)
    # The ExtendedData field rides along on both of the MultiGeometry's flattened features.
    gc_feats = [f for f in feats if f['props'] == {'k': 'gc'}]
    assert len(gc_feats) == 2


@pytest.mark.parametrize('body', [
    b'<kml><Document>not closed',                        # malformed XML
    _kml_doc('<Placemark><name>empty</name></Placemark>'),   # a placemark with no geometry
    b'<?xml version="1.0"?><other>nope</other>',         # valid XML, but no KML placemarks
])
def test_kml_extract_overlay_invalid_returns_none(formats_module, tmp_path, body):
    # Bad or geometry-less input degrades to None (the "could not read" path), never a crash —
    # the same graceful-degradation contract as a corrupt shapefile/GeoJSON.
    src = tmp_path / 'bad.kml'
    src.write_bytes(body)
    assert formats_module.format_for(str(src)).extract_overlay(str(src)) is None


def test_kml_extract_overlay_rejects_dtd_xxe(formats_module, tmp_path):
    # XXE hardening: a KML declaring a DOCTYPE is refused outright (_reject_dtd) rather than parsed,
    # so an internal entity-expansion ("billion laughs") payload never expands — it degrades to
    # None, not a crash or a memory blow-up. (External entities are already inert in the stdlib
    # parser; this closes the internal-entity vector at the door.)
    bomb = (b'<?xml version="1.0"?>'
            b'<!DOCTYPE kml [<!ENTITY a "AAAAAAAAAA">'
            b'<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>'
            b'<kml xmlns="%s"><Document><Placemark><name>&b;</name>'
            b'<Point><coordinates>1,2</coordinates></Point>'
            b'</Placemark></Document></kml>' % _KML_NS.encode())
    src = tmp_path / 'bomb.kml'
    src.write_bytes(bomb)
    assert formats_module.format_for(str(src)).extract_overlay(str(src)) is None


def test_kml_extract_overlay_caps_feature_count(formats_module, tmp_path):
    # A layer with more features than MAX_FEATURES is capped (bounds manifest size + frontend cost).
    kml = formats_module.format_for('x.kml')
    n = kml.MAX_FEATURES + 50
    pts = ''.join('<Placemark><Point><coordinates>%d,%d</coordinates></Point></Placemark>'
                  % (i, i) for i in range(n))
    src = tmp_path / 'many.kml'
    src.write_bytes(_kml_doc(pts))
    assert len(kml.extract_overlay(str(src))['features']) == kml.MAX_FEATURES


def _write_kmz(path, members):
    import zipfile
    with zipfile.ZipFile(path, 'w') as zf:
        for name, data in members.items():
            zf.writestr(name, data)


def test_kmz_extract_overlay_reads_root_kml(formats_module, tmp_path):
    # A KMZ is a zipped KML: the root doc.kml is unpacked (in-subprocess) and projected identically
    # to a bare .kml. Assets and a non-root .kml are ignored; doc.kml wins.
    src = tmp_path / 'roads.kmz'
    _write_kmz(src, {
        'doc.kml': _kml_doc('<Placemark><name>Road</name>'
                            '<LineString><coordinates>0,0 10,10</coordinates></LineString>'
                            '</Placemark>'),
        'images/overlay.png': b'\x89PNG\r\n\x1a\n not-a-real-image',
    })
    (feat,) = formats_module.format_for(str(src)).extract_overlay(str(src))['features']
    assert feat['type'] == 'line'
    assert feat['props'] == {'name': 'Road'}


def test_kmz_extract_overlay_first_kml_when_no_doc_kml(formats_module, tmp_path):
    # Without a doc.kml, the first .kml member is the root (the OGC fallback).
    src = tmp_path / 'nodoc.kmz'
    _write_kmz(src, {'layer.kml': _kml_doc(
        '<Placemark><Point><coordinates>3,4</coordinates></Point></Placemark>')})
    feats = formats_module.format_for(str(src)).extract_overlay(str(src))['features']
    assert [f['type'] for f in feats] == ['point']


@pytest.mark.parametrize('members', [
    None,                                       # not a zip at all (written as raw bytes below)
    {'readme.txt': b'no kml here'},             # a valid zip with no .kml member
])
def test_kmz_extract_overlay_invalid_returns_none(formats_module, tmp_path, members):
    src = tmp_path / 'bad.kmz'
    if members is None:
        src.write_bytes(b'not a zip file')
    else:
        _write_kmz(src, members)
    assert formats_module.format_for(str(src)).extract_overlay(str(src)) is None


# ---- overlay projection primitive (unit_projector — pure, the FMT-9 fit-to-bounds seam) ----

def test_unit_projector_fits_square_bounds(formats_module):
    # A square bbox maps corner-to-corner into 0..1, with the Y axis flipped (source Y-up world ->
    # image Y-down), so the min-Y point lands at the bottom and max-Y at the top.
    proj = formats_module.unit_projector([(0, 0), (10, 10)])
    assert proj(0, 0) == pytest.approx((0.0, 1.0))
    assert proj(10, 10) == pytest.approx((1.0, 0.0))
    assert proj(5, 5) == pytest.approx((0.5, 0.5))


def test_unit_projector_centers_shorter_axis(formats_module):
    # A wide bbox (x span 10, y span 2): keep_aspect fills x across 0..1 and centers the shorter y
    # axis (occupying 0.2 of the frame, centered on 0.5 → pre-flip [0.4, 0.6]).
    proj = formats_module.unit_projector([(0, 0), (10, 2)])
    assert proj(0, 0) == pytest.approx((0.0, 0.6))
    assert proj(10, 2) == pytest.approx((1.0, 0.4))


def test_unit_projector_no_aspect_stretches_each_axis(formats_module):
    # Without keep_aspect each axis stretches independently to fill 0..1.
    proj = formats_module.unit_projector([(0, 0), (10, 2)], keep_aspect=False)
    assert proj(0, 0) == pytest.approx((0.0, 1.0))
    assert proj(10, 2) == pytest.approx((1.0, 0.0))


def test_unit_projector_degenerate_spans_center(formats_module):
    # A single point (both spans zero) centers at 0.5; a vertical line (x span zero) centers x and
    # still spreads y.
    assert formats_module.unit_projector([(5, 5)])(5, 5) == pytest.approx((0.5, 0.5))
    proj = formats_module.unit_projector([(3, 0), (3, 10)])
    assert proj(3, 0) == pytest.approx((0.5, 1.0))
    assert proj(3, 10) == pytest.approx((0.5, 0.0))


def test_unit_projector_empty_is_center(formats_module):
    assert formats_module.unit_projector([])(123, 456) == (0.5, 0.5)


# ---- overlay georeference (OverlayProjector — the FMT-6 control-point + CRS seam) ----

def test_overlay_projector_similarity_from_two_pairs(formats_module):
    # Two pairs pin an exact similarity: (0,0)→(0.25,0.75) and (10,0)→(0.75,0.75) put 10 source
    # units across half the plan with no rotation. A third source point rides the same transform,
    # and — the Y-handedness check — a point NORTH of a control point lands ABOVE it (smaller ny),
    # not mirrored below.
    p = formats_module.OverlayProjector(
        [(0, 0), (10, 10)],
        align=[{'src': [0.0, 0.0], 'dst': [0.25, 0.75]},
               {'src': [10.0, 0.0], 'dst': [0.75, 0.75]}])
    assert p.georeferenced is True
    assert p.project(0, 0) == pytest.approx((0.25, 0.75))
    assert p.project(10, 0) == pytest.approx((0.75, 0.75))
    assert p.project(10, 10) == pytest.approx((0.75, 0.25))
    assert p.project(0, 10) == pytest.approx((0.25, 0.25))


def test_overlay_projector_similarity_carries_rotation(formats_module):
    # (0,0)→(0.5,0.5), (10,0)→(0.5,0.9): source-east points down the plan — a 90° clockwise
    # rotation, which the similarity expresses. Source-north then lands to the plan's east.
    p = formats_module.OverlayProjector(
        [(0, 0), (10, 10)],
        align=[{'src': [0.0, 0.0], 'dst': [0.5, 0.5]},
               {'src': [10.0, 0.0], 'dst': [0.5, 0.9]}])
    assert p.georeferenced is True
    assert p.project(0, 10) == pytest.approx((0.9, 0.5))


def test_overlay_projector_affine_from_three_pairs(formats_module):
    # Three pairs solve a full affine — here with anisotropic scale (x squeezed 2× more than y),
    # which a similarity cannot express. Exactly interpolating pairs reproduce, and a fourth
    # point follows the affine.
    p = formats_module.OverlayProjector(
        [(0, 0), (10, 10)],
        align=[{'src': [0.0, 0.0], 'dst': [0.0, 1.0]},
               {'src': [10.0, 0.0], 'dst': [1.0, 1.0]},
               {'src': [0.0, 10.0], 'dst': [0.0, 0.5]}])
    assert p.georeferenced is True
    assert p.project(0, 0) == pytest.approx((0.0, 1.0))
    assert p.project(10, 0) == pytest.approx((1.0, 1.0))
    assert p.project(0, 10) == pytest.approx((0.0, 0.5))
    assert p.project(10, 10) == pytest.approx((1.0, 0.5))


@pytest.mark.parametrize('align', [
    None,                                                        # no pairs at all
    [],                                                          # empty list
    [{'src': [0.0, 0.0], 'dst': [0.2, 0.2]}],                    # only one pair
    [{'src': [5.0, 5.0], 'dst': [0.2, 0.2]},                     # coincident sources — no scale
     {'src': [5.0, 5.0], 'dst': [0.8, 0.8]}],
    [{'src': 'nope', 'dst': [0.1, 0.1]},                         # malformed pairs all dropped
     {'src': [1.0, 'x'], 'dst': [0.1, 0.1]},
     'junk',
     {'src': [0.0, 0.0]},
     {'src': [float('nan'), 0.0], 'dst': [0.1, 0.1]},
     {'src': [True, False], 'dst': [0.1, 0.1]}],
])
def test_overlay_projector_falls_back_to_fit(formats_module, align):
    # Anything short of two clean, solvable pairs degrades to plain fit-to-bounds — flagged
    # approximate, identical to the no-alignment placement.
    p = formats_module.OverlayProjector([(0, 0), (10, 10)], align=align)
    assert p.georeferenced is False
    assert p.project(0, 0) == pytest.approx((0.0, 1.0))
    assert p.project(10, 10) == pytest.approx((1.0, 0.0))


def test_overlay_projector_geographic_corrects_aspect(formats_module):
    import math
    # A lon/lat layer away from the equator: 10° of longitude at lat 50 spans only cos(50°) of
    # 10° of latitude, so the equirectangular pre-scale narrows x and the fit centers it —
    # instead of the old planar treatment that stretched the layer square.
    p = formats_module.OverlayProjector([(0, 45), (10, 55)], crs='geographic')
    k = math.cos(math.radians(50))
    off = (10 - 10 * k) / 2 / 10
    assert p.crs == 'geographic'
    assert p.project(0, 45) == pytest.approx((off, 1.0))
    assert p.project(10, 55) == pytest.approx((1.0 - off, 0.0))


def test_overlay_projector_meta_transform_matches_project(formats_module):
    # `srcTransform` is the exact raw-source→unit affine behind `project` — the frontend inverts
    # it to recover source coordinates, so the two must agree on every path (fit + geographic
    # here, control-point + geographic below).
    for p in (
        formats_module.OverlayProjector([(0, 45), (10, 55)], crs='geographic'),
        formats_module.OverlayProjector(
            [(0, 45), (10, 55)], crs='geographic',
            align=[{'src': [0.0, 45.0], 'dst': [0.1, 0.9]},
                   {'src': [10.0, 55.0], 'dst': [0.9, 0.1]}]),
    ):
        meta = p.meta()
        a, b, c, d, e, f = meta['srcTransform']
        for x, y in ((0, 45), (10, 55), (3.7, 51.2)):
            nx, ny = p.project(x, y)
            assert (a * x + b * y + c, d * x + e * y + f) == pytest.approx((nx, ny))
        assert meta['georeferenced'] is p.georeferenced
        assert meta['crs'] == 'geographic'


@pytest.mark.parametrize('wkt,kind', [
    ('GEOGCS["WGS 84",DATUM["WGS_1984"]]', 'geographic'),
    ('PROJCS["NAD83 / UTM zone 10N",GEOGCS["NAD83"]]', 'projected'),
    ('GEOGCRS["WGS 84",ENSEMBLE["..."]]', 'geographic'),          # WKT2 spelling
    ('\ufeff  PROJCRS("ETRS89")', 'projected'),               # BOM + whitespace + parens
    ('LOCAL_CS["Nonearth"]', 'unknown'),                          # recognized-but-other WKT
    ('complete garbage', 'unknown'),
])
def test_shapefile_crs_kind_from_prj(formats_module, tmp_path, wkt, kind):
    (tmp_path / 'layer.prj').write_text(wkt, encoding='utf-8')
    assert formats_module.ShapefileFormat._crs_kind(str(tmp_path / 'layer.shp')) == kind


def test_shapefile_crs_kind_without_prj(formats_module, tmp_path):
    # No .prj → unknown (treated planar): guessing geographic from coordinate ranges would
    # misread a small local planar grid.
    assert formats_module.ShapefileFormat._crs_kind(str(tmp_path / 'bare.shp')) == 'unknown'


def test_geojson_extract_overlay_applies_align_pairs(formats_module, tmp_path):
    # End-to-end through a real handler: `overlayAlign` pairs georeference the layer — the two
    # anchored corners land exactly on their dst, the rest of the square follows the similarity,
    # and the manifest metadata flips to georeferenced.
    src = tmp_path / 'poly.geojson'
    _write_geojson(src, {
        'type': 'Feature', 'properties': {},
        'geometry': {'type': 'Polygon',
                     'coordinates': [[[0, -5], [0, 5], [10, 5], [10, -5], [0, -5]]]},
    })
    res = formats_module.format_for(str(src)).extract_overlay(
        str(src),
        align=[{'src': [0.0, -5.0], 'dst': [0.25, 0.75]},
               {'src': [10.0, -5.0], 'dst': [0.75, 0.75]}])
    assert res['georeferenced'] is True
    (feat,) = res['features']
    expected = [[0.25, 0.75], [0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]]
    for got, want in zip(feat['coords'], expected):
        assert got == pytest.approx(want)


# ---- overlay dispatch + build wiring (Preprocessor, loaded by path) ----

def test_extract_overlay_dispatch_guards(preprocess_module):
    # The dispatcher only fires for OVERLAY-role handlers: a base-raster format and an
    # unknown/unshipped extension are not classified as overlays and return None.
    P = preprocess_module.Preprocessor
    assert P._is_overlay('plan.pdf') is False
    assert P.extract_overlay('plan.pdf') is None
    assert P._is_overlay('data.unknownfmt') is False   # no handler at all
    assert P.extract_overlay('data.unknownfmt') is None
    # A shipped OVERLAY format (GeoJSON, FMT-7) IS classified as one; extract still returns None
    # for a missing/unreadable file (the parse fails soft).
    assert P._is_overlay('data.geojson') is True
    assert P.extract_overlay('data.geojson') is None   # nonexistent path → None, not a crash


def test_build_attaches_overlay_to_floor(preprocess_module, tmp_path, make_pdf, monkeypatch):
    """The build threads an OVERLAY-role file mapped to a floor into that floor's manifest
    `overlays`, alongside the base raster page. A neutral OVERLAY stub is injected into the registry
    so this exercises the build wiring independent of any real parser (Shapefile/GeoJSON/…)."""
    fm = preprocess_module.drawing_formats

    class _StubOverlay:
        name, exts, role, requires = 'stubov', ('.ovtest',), fm.OVERLAY, 'stub'

        def extract_overlay(self, path, align=None):
            return {'features': [{'type': 'point', 'coords': [0.5, 0.5],
                                  'props': {'id': 'sensor-1'}}],
                    'georeferenced': False, 'crs': 'unknown',
                    'srcTransform': [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]}

    stub = _StubOverlay()
    real_format_for = fm.format_for
    monkeypatch.setattr(fm, 'DRAWING_EXTS', fm.DRAWING_EXTS + ('.ovtest',))
    monkeypatch.setattr(fm, 'format_for',
                        lambda p: stub if p.lower().endswith('.ovtest') else real_format_for(p))

    _write_pdf(tmp_path / 'uploads' / 'AlphaWing' / 'ground.pdf', make_pdf())
    _write(tmp_path / 'uploads' / 'AlphaWing' / 'sensors.ovtest', b'{"stub": true}')
    entry = {'slug': 'alpha', 'name': 'Alpha Wing', 'abbr': 'AB',
             'floors': {'ground': 'g', 'sensors': 'g'}}   # both drawings share floor token 'g'

    building, unmapped = preprocess_module.Preprocessor(str(tmp_path)).build_building_from_pdfs(
        'AlphaWing', entry)

    assert unmapped == []
    (floor,) = building['floors']
    assert floor['id'] == 'ABg'
    assert floor['image'] == 'images/alpha/ABg.webp'   # base raster page still rendered
    (overlay,) = floor['overlays']
    assert overlay['name'] == 'sensors'                # source stem, extension stripped
    assert overlay['features'] == [
        {'type': 'point', 'coords': [0.5, 0.5], 'props': {'id': 'sensor-1'}}]
    # The handler's placement metadata rides into the manifest entry: fit-to-bounds is never a
    # true georeference, so the flag stays approximate (drives the frontend's warning) and the
    # recorded raw-source→unit transform is what the align editor inverts.
    assert overlay['georeferenced'] is False
    assert overlay['crs'] == 'unknown'
    assert overlay['srcTransform'] == [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]


def test_build_passes_overlay_align_pairs(preprocess_module, tmp_path, make_pdf, monkeypatch):
    """The build routes the import map's `overlayAlign` pairs (keyed by drawing stem, FMT-6) into
    the matching overlay file's extract — and the extract's `georeferenced` verdict lands in the
    manifest. A recording stub keeps this a pure wiring test (the solve itself is covered in the
    OverlayProjector section)."""
    fm = preprocess_module.drawing_formats
    seen = {}

    class _StubOverlay:
        name, exts, role, requires = 'stubov', ('.ovtest',), fm.OVERLAY, 'stub'

        def extract_overlay(self, path, align=None):
            seen['align'] = align
            return {'features': [{'type': 'point', 'coords': [0.1, 0.2], 'props': {}}],
                    'georeferenced': align is not None, 'crs': 'unknown',
                    'srcTransform': [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]}

    stub = _StubOverlay()
    real_format_for = fm.format_for
    monkeypatch.setattr(fm, 'DRAWING_EXTS', fm.DRAWING_EXTS + ('.ovtest',))
    monkeypatch.setattr(fm, 'format_for',
                        lambda p: stub if p.lower().endswith('.ovtest') else real_format_for(p))

    _write_pdf(tmp_path / 'uploads' / 'AlphaWing' / 'ground.pdf', make_pdf())
    _write(tmp_path / 'uploads' / 'AlphaWing' / 'sensors.ovtest', b'{"stub": true}')
    pairs = [{'src': [0.0, 0.0], 'dst': [0.25, 0.75]},
             {'src': [10.0, 0.0], 'dst': [0.75, 0.75]}]
    entry = {'slug': 'alpha', 'name': 'Alpha Wing', 'abbr': 'AB',
             'floors': {'ground': 'g', 'sensors': 'g'},
             'overlayAlign': {'sensors': pairs}}

    building, _ = preprocess_module.Preprocessor(str(tmp_path)).build_building_from_pdfs(
        'AlphaWing', entry)

    assert seen['align'] == pairs
    (floor,) = building['floors']
    (overlay,) = floor['overlays']
    assert overlay['georeferenced'] is True

    # A malformed (non-dict) overlayAlign is ignored — the overlay falls back to no pairs.
    entry['overlayAlign'] = ['not', 'a', 'dict']
    building, _ = preprocess_module.Preprocessor(str(tmp_path)).build_building_from_pdfs(
        'AlphaWing', entry)
    assert seen['align'] is None
    assert building['floors'][0]['overlays'][0]['georeferenced'] is False


def test_build_drops_overlay_only_floor(preprocess_module, tmp_path, monkeypatch):
    """An overlay must layer onto a base plan (fit-to-bounds needs the floor canvas), so a floor
    with only overlay files and no rendered base page is dropped like any pageless floor."""
    fm = preprocess_module.drawing_formats

    class _StubOverlay:
        name, exts, role, requires = 'stubov', ('.ovtest',), fm.OVERLAY, 'stub'

        def extract_overlay(self, path, align=None):
            return {'features': [{'type': 'point', 'coords': [0.5, 0.5], 'props': {}}],
                    'georeferenced': False, 'crs': 'unknown',
                    'srcTransform': [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]}

    stub = _StubOverlay()
    real_format_for = fm.format_for
    monkeypatch.setattr(fm, 'DRAWING_EXTS', fm.DRAWING_EXTS + ('.ovtest',))
    monkeypatch.setattr(fm, 'format_for',
                        lambda p: stub if p.lower().endswith('.ovtest') else real_format_for(p))

    _write(tmp_path / 'uploads' / 'AlphaWing' / 'sensors.ovtest', b'{"stub": true}')
    entry = {'slug': 'alpha', 'name': 'Alpha Wing', 'abbr': 'AB', 'floors': {'sensors': 'g'}}

    building, _ = preprocess_module.Preprocessor(str(tmp_path)).build_building_from_pdfs(
        'AlphaWing', entry)

    assert building['floors'] == []


# ---- render quality (READ-1) ----

class _FakePage:
    """Stand-in for a pypdfium2 page — `_render_scale` only ever asks for its point size."""

    def __init__(self, w, h):
        self._size = (w, h)

    def get_size(self):
        return self._size


LETTER = (612, 792)        # the common sheet
E_SIZE = (2448, 3168)      # the big one the item's complaint is really about


def test_render_scale_standard_quality_is_unchanged(formats_module):
    # The whole point of deriving the clamp from point size: an operator who never touches the
    # setting must get byte-identical renders to before. Both common sheets stay at RENDER_SCALE.
    pdf = formats_module.PdfFormat()
    for size in (LETTER, E_SIZE):
        assert pdf._render_scale(_FakePage(*size), 1.0) == pdf.RENDER_SCALE


def test_render_scale_high_quality_lifts_a_normal_sheet(formats_module):
    # A letter sheet has pixels to spare, so it gets the multiplier in full: 2.0 -> 3.0 (~216 DPI).
    pdf = formats_module.PdfFormat()
    assert pdf._render_scale(_FakePage(*LETTER), 1.5) == pdf.RENDER_SCALE * 1.5


def test_render_scale_clamps_an_oversized_sheet_to_the_pixel_cap(formats_module):
    # The gotcha this guards: raster area grows with the SQUARE of the scale, and the render
    # subprocess is address-space-capped. An E-size sheet at 1.5x would reach 9504px on its long
    # side; it must give density back instead, landing exactly on the cap rather than being killed.
    pdf = formats_module.PdfFormat()
    scale = pdf._render_scale(_FakePage(*E_SIZE), 1.5)
    assert max(E_SIZE) * scale == pytest.approx(pdf.MAX_IMAGE_PX)
    # Clamped, but still sharper than standard — the operator gets *some* of what they asked for.
    assert pdf.RENDER_SCALE < scale < pdf.RENDER_SCALE * 1.5


def test_render_scale_never_exceeds_the_cap(formats_module):
    # The invariant that actually protects the child, across sheet sizes and quality settings.
    pdf = formats_module.PdfFormat()
    for size in (LETTER, E_SIZE, (5000, 7000)):
        for quality in (1.0, 1.5, 4.0):
            longest = max(size) * pdf._render_scale(_FakePage(*size), quality)
            assert longest <= pdf.MAX_IMAGE_PX + 1e-6


@pytest.mark.parametrize('quality', [0, -1, None])
def test_render_scale_falls_back_to_standard_for_a_bogus_quality(formats_module, quality):
    # A malformed --scale must not render a degenerate 0-px image; standard is the safe reading.
    pdf = formats_module.PdfFormat()
    assert pdf._render_scale(_FakePage(*LETTER), quality) == pdf.RENDER_SCALE


def test_render_scale_survives_a_page_whose_size_cannot_be_read(formats_module):
    # A damaged PDF still renders (at the unclamped scale) and is left to the subprocess rlimits —
    # the same backstop as before this cap existed. It must not raise.
    class Broken:
        def get_size(self):
            raise RuntimeError('damaged')

    pdf = formats_module.PdfFormat()
    assert pdf._render_scale(Broken(), 1.5) == pdf.RENDER_SCALE * 1.5


def test_scaled_px_scales_a_vector_target(formats_module):
    # The RENDER_PX analogue used by the SVG/DXF handlers.
    assert formats_module._scaled_px(2000, 1.5) == 3000
    assert formats_module._scaled_px(2000, 1.0) == 2000
    for bogus in (0, -1, None):
        assert formats_module._scaled_px(2000, bogus) == 2000


# ---- _hq_constrained: the "HQ couldn't be delivered" signal (HEALTH-3) ----

def test_hq_constrained_flags_a_clamped_pdf(preprocess_module, formats_module):
    # HQ on and the rendered longest side reached the PDF pixel cap == the sheet was clamped below
    # full quality. A sheet comfortably under the cap got its full quality, so it's not constrained.
    pdf = formats_module.PdfFormat()
    hq = preprocess_module.Preprocessor._hq_constrained
    assert hq(pdf, 1.5, pdf.MAX_IMAGE_PX, 5000) is True
    assert hq(pdf, 1.5, pdf.MAX_IMAGE_PX - 1, 5000) is True     # rounding tolerance
    assert hq(pdf, 1.5, 4000, 3000) is False


@pytest.mark.parametrize('quality', [1.0, 0, -1, None])
def test_hq_constrained_ignores_non_high_quality(preprocess_module, formats_module, quality):
    # At standard (or bogus) quality nothing is an HQ constraint, even a sheet sitting on the cap.
    pdf = formats_module.PdfFormat()
    hq = preprocess_module.Preprocessor._hq_constrained
    assert hq(pdf, quality, pdf.MAX_IMAGE_PX, pdf.MAX_IMAGE_PX) is False


def test_hq_constrained_skips_a_raster_at_its_cap(preprocess_module, formats_module):
    # A raster ignores quality (no more detail to extract from a scan), so reaching its own
    # downscale cap is not an HQ constraint. The RENDER_SCALE gate (PdfFormat-only) excludes it.
    raster = formats_module.RasterFormat()
    hq = preprocess_module.Preprocessor._hq_constrained
    assert not hasattr(raster, 'RENDER_SCALE')
    assert hq(raster, 1.5, raster.MAX_IMAGE_PX, raster.MAX_IMAGE_PX) is False


def test_build_scale_renders_more_pixels(tmp_path, make_pdf):
    # End-to-end through the CLI the way imports.py drives it: the same source, built twice, must
    # differ only in pixel dimensions — and the coordinate model is normalized 0..1, so nothing
    # else in the manifest may move.
    def build(base, *extra):
        _write_pdf(base / 'uploads' / 'AlphaWing' / 'ground.pdf', make_pdf(120, 160))
        (base / 'import-map.json').write_text(json.dumps({'buildings': {'AlphaWing': {
            'slug': 'alpha', 'name': 'Alpha', 'abbr': 'A', 'floors': {'ground': 'g'}}}}))
        assert _run('build', base, *extra).returncode == 0
        return json.loads((base / 'manifest.json').read_text())['buildings'][0]['floors'][0]

    std = build(tmp_path / 'std')
    hq = build(tmp_path / 'hq', '--scale', '1.5')

    assert (hq['w'], hq['h']) == (int(std['w'] * 1.5), int(std['h'] * 1.5))
    # Same floor identity/geometry contract either way — the scale must not leak past the pixels.
    assert (hq['id'], hq['label'], hq['floorSlug']) == (std['id'], std['label'], std['floorSlug'])


def _render_summary(stderr):
    """The RENDER-SUMMARY {json} dict from a build's stderr (HEALTH-3), or None if absent."""
    for line in reversed(stderr.splitlines()):
        if line.startswith('RENDER-SUMMARY '):
            return json.loads(line[len('RENDER-SUMMARY '):])
    return None


def test_build_emits_a_render_summary(tmp_path, make_pdf):
    # End-to-end: a clean small build reports zero problems, and the `hq` flag tracks --scale — the
    # machine-readable line imports.RenderRunner parses to surface HQ memory constraints.
    _write_pdf(tmp_path / 'uploads' / 'AlphaWing' / 'ground.pdf', make_pdf(120, 160))
    (tmp_path / 'import-map.json').write_text(json.dumps({'buildings': {'AlphaWing': {
        'slug': 'alpha', 'name': 'Alpha', 'abbr': 'A', 'floors': {'ground': 'g'}}}}))

    std = _run('build', tmp_path)
    assert std.returncode == 0
    assert _render_summary(std.stderr) == {'hq': False, 'unrendered': 0, 'hq_clamped': 0}

    hq = _run('build', tmp_path, '--scale', '1.5')
    # A small sheet has pixels to spare, so HQ is delivered in full — flagged on, nothing clamped.
    assert _render_summary(hq.stderr) == {'hq': True, 'unrendered': 0, 'hq_clamped': 0}


def test_build_summary_counts_an_unrenderable_drawing(tmp_path):
    # A drawing that can't be decoded is dropped (graceful) and tallied as unrendered, so a build
    # that silently lost content can say so rather than reporting a spurious success.
    _write(tmp_path / 'uploads' / 'AlphaWing' / 'ground.pdf', b'%PDF-not-really-a-pdf')
    (tmp_path / 'import-map.json').write_text(json.dumps({'buildings': {'AlphaWing': {
        'slug': 'alpha', 'name': 'Alpha', 'abbr': 'A', 'floors': {'ground': 'g'}}}}))

    res = _run('build', tmp_path)
    assert res.returncode == 0                       # graceful: the build still completes
    assert _render_summary(res.stderr)['unrendered'] == 1


def test_build_bogus_scale_falls_back_to_standard(tmp_path, make_pdf):
    # An unparseable --scale must not lose the whole build.
    def build(base, *extra):
        _write_pdf(base / 'uploads' / 'AlphaWing' / 'ground.pdf', make_pdf(120, 160))
        (base / 'import-map.json').write_text(json.dumps({'buildings': {'AlphaWing': {
            'slug': 'alpha', 'name': 'Alpha', 'abbr': 'A', 'floors': {'ground': 'g'}}}}))
        assert _run('build', base, *extra).returncode == 0
        return json.loads((base / 'manifest.json').read_text())['buildings'][0]['floors'][0]

    assert build(tmp_path / 'bogus', '--scale', 'abc') == build(tmp_path / 'std')
