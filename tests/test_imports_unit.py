"""Tier B — the pure/isolated helpers in `imports.py`: the zip member→destination mapping and
the subprocess resource-limit builder. Django settings are configured (importing `imports` pulls
in Django) but no database is touched."""

import resource

import pytest

from netbox_facilitymap.imports import RenderRunner, _sniff, _upload_ok, _zip_targets


# ---- _zip_targets: how a zip's members map onto uploads/<folder>/<file> ----

def test_zip_targets_peels_wrapper_and_flags_site_map():
    # A common export: one wrapper dir, per-building subfolders, plus a site map PDF at the root.
    names = ['export/AlphaWing/g.pdf', 'export/AlphaWing/l1.pdf',
             'export/site.pdf', 'export/readme.txt']
    out = _zip_targets(names)
    assert out['export/AlphaWing/g.pdf'] == ('AlphaWing', 'g.pdf')
    assert out['export/AlphaWing/l1.pdf'] == ('AlphaWing', 'l1.pdf')
    # a lone PDF at the (peeled) root alongside subfoldered drawings is treated as the site map
    assert out['export/site.pdf'] == ('Site Plan', 'site.pdf')
    # non-drawing members are ignored
    assert 'export/readme.txt' not in out


def test_zip_targets_ignores_non_drawings_and_dirs():
    out = _zip_targets(['A/g.pdf', 'A/', 'A/notes.txt'])
    assert list(out) == ['A/g.pdf']


def test_zip_targets_accepts_raster_members():
    # Image plans (HABS/HAER scans) map exactly like PDFs; mixed folders work too.
    names = ['export/AlphaWing/g.tif', 'export/AlphaWing/l1.png',
             'export/site.jpg', 'export/thumbs.db']
    out = _zip_targets(names)
    assert out['export/AlphaWing/g.tif'] == ('AlphaWing', 'g.tif')
    assert out['export/AlphaWing/l1.png'] == ('AlphaWing', 'l1.png')
    assert out['export/site.jpg'] == ('Site Plan', 'site.jpg')
    assert 'export/thumbs.db' not in out


def test_zip_targets_keeps_shapefile_companions_with_their_drawing(all_formats_accepted):
    # A shapefile set: the `.shp` is the drawing; its `.shx/.dbf/.prj` siblings ride into the same
    # building folder (pyshp finds them by shared basename). Two buildings so the wrapper peel keeps
    # the building dir — and a companion must land in ITS drawing's building, not the other one.
    names = ['export/AlphaWing/g.pdf',
             'export/AlphaWing/sensors.shp', 'export/AlphaWing/sensors.shx',
             'export/AlphaWing/sensors.dbf', 'export/AlphaWing/sensors.prj',
             'export/BetaWing/l1.pdf', 'export/BetaWing/racks.shp', 'export/BetaWing/racks.dbf']
    out = _zip_targets(names)
    assert out['export/AlphaWing/sensors.shp'] == ('AlphaWing', 'sensors.shp')
    for ext in ('shx', 'dbf', 'prj'):
        assert out['export/AlphaWing/sensors.%s' % ext] == ('AlphaWing', 'sensors.%s' % ext)
    assert out['export/BetaWing/racks.dbf'] == ('BetaWing', 'racks.dbf')   # its own building, not Alpha


def test_zip_targets_drops_orphan_companions(all_formats_accepted):
    # A companion with no same-stem drawing in its directory is junk — dropped, and it doesn't count
    # as a drawing. Two buildings so nothing is peeled down to the generic 'Building' bucket.
    out = _zip_targets(['A/g.pdf', 'A/orphan.dbf', 'A/plan.shp', 'A/plan.shx', 'B/l.pdf'])
    assert out['A/g.pdf'] == ('A', 'g.pdf')
    assert out['A/plan.shp'] == ('A', 'plan.shp')
    assert out['A/plan.shx'] == ('A', 'plan.shx')    # paired to plan.shp
    assert 'A/orphan.dbf' not in out                 # no orphan.shp beside it → dropped


# ---- _sniff: header magic → accepted format (or None) ----

@pytest.mark.parametrize('head,fmt', [
    (b'%PDF-1.7 rest', 'pdf'),
    (b'\x89PNG\r\n\x1a\n....', 'png'),
    (b'\xff\xd8\xff\xe0JFIF', 'jpeg'),
    (b'GIF89a....', 'gif'),
    (b'II*\x00....', 'tiff'),
    (b'MM\x00*....', 'tiff'),
    (b'BM....', 'bmp'),
    (b'RIFF\x00\x00\x00\x00WEBPVP8 ', 'webp'),
    (b'PK\x03\x04', 'vsdx'),                          # VSDX is an OOXML zip package
    (b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1', 'vsd'),     # VSD is the legacy OLE2 binary
])
def test_sniff_recognizes_accepted_magic(head, fmt):
    assert _sniff(head) == fmt


@pytest.mark.parametrize('head', [b'', b'NOTAFILE', b'RIFF\x00\x00\x00\x00AVI '])
def test_sniff_rejects_unknown_magic(head):
    assert _sniff(head) is None


# ---- _upload_ok: accept a drawing by its magic, or a companion sibling by its (weaker) signature ----

@pytest.mark.parametrize('rel,head,ok', [
    ('uploads/A/plan.pdf', b'%PDF-1.7', True),          # drawing: real magic
    ('uploads/A/plan.pdf', b'garbage!!', False),        # drawing: wrong magic
    ('uploads/A/sensors.shp', b'\x00\x00\x27\x0a', True),   # shapefile main-file header
    ('uploads/A/sensors.shx', b'\x00\x00\x27\x0a', True),   # companion: index shares the magic
    ('uploads/A/sensors.dbf', b'\x03\x00\x00', True),       # companion: dBASE version byte
    ('uploads/A/sensors.prj', b'PROJCS["x"]', True),        # companion: WKT text
    ('uploads/A/sensors.dbf', b'\xffnope', False),          # companion: bad version byte
    ('uploads/A/notes.txt', b'anything', False),            # unaccepted extension
])
def test_upload_ok_gates_drawings_and_companions(all_formats_accepted, rel, head, ok):
    assert _upload_ok(rel, head) is ok


# ---- RenderRunner._rlimits: POSIX preexec_fn capping the render child ----

def test_rlimits_caps_cpu_and_address_space(monkeypatch):
    calls = {}
    monkeypatch.setattr(resource, 'setrlimit',
                        lambda which, limits: calls.__setitem__(which, limits))
    RenderRunner._rlimits(30, 512)()  # build then invoke the returned preexec_fn
    assert calls[resource.RLIMIT_CPU] == (35, 35)            # timeout + 5s grace
    assert calls[resource.RLIMIT_AS] == (512 * 1024 * 1024,) * 2


def test_rlimits_skips_memory_cap_when_unset(monkeypatch):
    calls = {}
    monkeypatch.setattr(resource, 'setrlimit',
                        lambda which, limits: calls.__setitem__(which, limits))
    RenderRunner._rlimits(10, None)()
    assert resource.RLIMIT_CPU in calls
    assert resource.RLIMIT_AS not in calls          # no mem_mb → no address-space limit


# ---- _detect_avail_mb: cgroup-first host-memory detection (PERF-2) ----

def _fake_fs(files, monkeypatch):
    """Monkeypatch pathlib.Path.read_text so only `files` (path str → contents) exist."""
    import pathlib

    def read_text(self, *a, **k):
        try:
            return files[str(self)]
        except KeyError:
            raise FileNotFoundError(str(self))
    monkeypatch.setattr(pathlib.Path, 'read_text', read_text)


def test_detect_avail_mb_prefers_cgroup_v2(monkeypatch):
    _fake_fs({'/sys/fs/cgroup/memory.max': str(2048 * 1024 * 1024),      # 2 GiB
              '/proc/meminfo': 'MemTotal:       8388608 kB\n'}, monkeypatch)  # host 8 GiB
    assert RenderRunner._detect_avail_mb() == 2048       # cgroup wins over the host MemTotal


def test_detect_avail_mb_skips_unlimited_cgroup_and_uses_meminfo(monkeypatch):
    _fake_fs({'/sys/fs/cgroup/memory.max': 'max',                        # v2 unlimited sentinel
              '/proc/meminfo': 'MemFree: 10 kB\nMemTotal:       4194304 kB\n'}, monkeypatch)
    assert RenderRunner._detect_avail_mb() == 4096       # falls through to MemTotal (4 GiB)


def test_detect_avail_mb_skips_absurd_v1_sentinel(monkeypatch):
    _fake_fs({'/sys/fs/cgroup/memory/memory.limit_in_bytes': str(1 << 63),
              '/proc/meminfo': 'MemTotal:       2097152 kB\n'}, monkeypatch)
    assert RenderRunner._detect_avail_mb() == 2048       # huge "no limit" value ignored


def test_detect_avail_mb_none_when_nothing_readable(monkeypatch):
    _fake_fs({}, monkeypatch)
    assert RenderRunner._detect_avail_mb() is None


# ---- _effective_mem_mb: clamp the default, honor an explicit override (PERF-2) ----

def test_effective_mem_mb_clamps_packaged_default(monkeypatch):
    from netbox_facilitymap import FacilityMapConfig
    default = FacilityMapConfig.default_settings['render_mem_mb']
    monkeypatch.setattr(RenderRunner, '_detect_avail_mb', staticmethod(lambda: 2048))
    # Small host: the untouched default is clamped to 0.5 × detected RAM.
    assert RenderRunner._effective_mem_mb(default) == 1024


def test_effective_mem_mb_honors_explicit_override(monkeypatch):
    from netbox_facilitymap import FacilityMapConfig
    default = FacilityMapConfig.default_settings['render_mem_mb']
    monkeypatch.setattr(RenderRunner, '_detect_avail_mb', staticmethod(lambda: 2048))
    # An operator who raised the value (e.g. for a Visio/soffice conversion) is honored verbatim.
    raised = default + 4096
    assert RenderRunner._effective_mem_mb(raised) == raised


def test_effective_mem_mb_unchanged_when_host_undetectable(monkeypatch):
    from netbox_facilitymap import FacilityMapConfig
    default = FacilityMapConfig.default_settings['render_mem_mb']
    monkeypatch.setattr(RenderRunner, '_detect_avail_mb', staticmethod(lambda: None))
    assert RenderRunner._effective_mem_mb(default) == default


def test_effective_mem_mb_passes_through_falsy():
    assert RenderRunner._effective_mem_mb(None) is None
    assert RenderRunner._effective_mem_mb(0) == 0
