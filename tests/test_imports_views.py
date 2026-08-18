"""Tier C — the upload + serving endpoints, exercised through the real permission-gated views
(so no production refactor is needed just to test them). Covers the reachable input-validation
rejects (magic bytes, size cap, drawing-count cap, non-regular zip members, unsupported zip
members), the accepted raster-image inputs, the permission gate, and the manifest/media caching
contract (private-only Cache-Control, ETag/Last-Modified revalidation, the immutable `?v=`
path). The traversal math itself is unit-tested directly in test_storage/test_backup.

`_zip_targets` normalises every member to a `<folder>/<basename>` pair, so a member cannot smuggle
`..` through to `safe_path` — the view's own traversal branch is defence-in-depth and not reachable
from a crafted archive, hence not asserted here."""

import io
import json
import zipfile

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.urls import reverse

pytestmark = pytest.mark.django_db

UPLOAD = 'plugins:netbox_facilitymap:api-import-upload'
UPLOAD_ZIP = 'plugins:netbox_facilitymap:api-import-upload-zip'
PREVIEW = 'plugins:netbox_facilitymap:api-import-preview'
BUILD = 'plugins:netbox_facilitymap:api-import-build'
IMPORT_MAP = 'plugins:netbox_facilitymap:api-import-map'
REBUILD = 'plugins:netbox_facilitymap:api-import-rebuild'
REGROUP = 'plugins:netbox_facilitymap:api-import-regroup'
SCAN = 'plugins:netbox_facilitymap:api-import-scan'


def _cfg(monkeypatch, key, value):
    from django.conf import settings
    monkeypatch.setitem(settings.PLUGINS_CONFIG['netbox_facilitymap'], key, value)


def _zip_bytes(members):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        for name, data in members:
            z.writestr(name, data)
    return buf.getvalue()


def _upload(data, name='x.pdf', content_type='application/pdf'):
    return SimpleUploadedFile(name, data, content_type=content_type)


# ---- single-PDF upload ----

def test_upload_rejects_bad_magic(client, editor_user, workdir):
    client.force_login(editor_user)
    r = client.post(reverse(UPLOAD) + '?path=x.pdf', {'file': _upload(b'NOTAPDF-really')})
    assert r.status_code == 400


def test_upload_rejects_oversize(client, editor_user, workdir, make_pdf, monkeypatch):
    _cfg(monkeypatch, 'max_pdf_mb', 0)  # any non-empty upload now exceeds the cap
    client.force_login(editor_user)
    r = client.post(reverse(UPLOAD) + '?path=x.pdf', {'file': _upload(make_pdf())})
    assert r.status_code == 413


def test_upload_requires_accepted_extension(client, editor_user, workdir, make_pdf):
    client.force_login(editor_user)
    r = client.post(reverse(UPLOAD) + '?path=x.txt', {'file': _upload(make_pdf())})
    assert r.status_code == 400


def test_upload_names_the_extra_for_uninstalled_format(client, editor_user, workdir, monkeypatch):
    # PKG-1: a recognized-but-uninstalled format (SVG without the [svg] extra) is rejected with an
    # actionable "install the extra" message, not a bare "unsupported type". Simulate the extra
    # being absent by gating the SVG handler off and dropping `.svg` from the accepted upload set.
    from netbox_facilitymap import drawing_formats, uploads
    monkeypatch.setattr(drawing_formats.format_for('x.svg'), 'available', lambda: False)
    monkeypatch.setattr(uploads, 'UPLOAD_EXTS',
                        tuple(e for e in uploads.UPLOAD_EXTS if e != '.svg'))
    client.force_login(editor_user)
    r = client.post(reverse(UPLOAD) + '?path=floor.svg',
                    {'file': _upload(b'<svg xmlns="x">', name='floor.svg')})
    assert r.status_code == 400
    assert 'netbox-facilitymap[svg]' in r.content.decode()


def test_upload_stores_valid_pdf(client, editor_user, workdir, make_pdf):
    client.force_login(editor_user)
    r = client.post(reverse(UPLOAD) + '?path=AlphaWing/g.pdf', {'file': _upload(make_pdf())})
    assert r.status_code == 200
    assert (workdir / 'uploads' / 'AlphaWing' / 'g.pdf').is_file()


def test_upload_stores_valid_image(client, editor_user, workdir, make_image):
    client.force_login(editor_user)
    r = client.post(reverse(UPLOAD) + '?path=AlphaWing/g.png',
                    {'file': _upload(make_image('PNG'), name='g.png', content_type='image/png')})
    assert r.status_code == 200
    assert (workdir / 'uploads' / 'AlphaWing' / 'g.png').is_file()


def test_upload_rejects_image_extension_with_wrong_magic(client, editor_user, workdir):
    # An accepted extension is not enough — the header must actually sniff as that (or any
    # accepted) format, so a mislabelled/hostile file is still rejected before it lands.
    client.force_login(editor_user)
    r = client.post(reverse(UPLOAD) + '?path=AlphaWing/g.png',
                    {'file': _upload(b'NOTPNG-really', name='g.png', content_type='image/png')})
    assert r.status_code == 400


def test_upload_stores_shapefile_and_companions(client, editor_user, workdir, all_formats_accepted):
    # A shapefile set uploads one file at a time into the same folder: the `.shp` (drawing) plus its
    # `.dbf`/`.prj` companions, each gated by its own signature (an accepted extension isn't enough).
    client.force_login(editor_user)
    files = {'sensors.shp': b'\x00\x00\x27\x0a' + b'\x00' * 20,   # shapefile main-file header
             'sensors.dbf': b'\x03' + b'\x00' * 20,               # dBASE III version byte
             'sensors.prj': b'PROJCS["NAD83"]'}                   # WKT text
    for name, data in files.items():
        r = client.post(reverse(UPLOAD) + '?path=AlphaWing/' + name, {'file': _upload(data, name=name)})
        assert r.status_code == 200, name
        assert (workdir / 'uploads' / 'AlphaWing' / name).is_file()


def test_upload_rejects_companion_with_bad_magic(client, editor_user, workdir, all_formats_accepted):
    # A companion still needs a plausible signature — a `.dbf` with an impossible version byte is
    # rejected, not blindly written because its extension is on the companion list.
    client.force_login(editor_user)
    r = client.post(reverse(UPLOAD) + '?path=AlphaWing/sensors.dbf',
                    {'file': _upload(b'\xffnope', name='sensors.dbf')})
    assert r.status_code == 400


# ---- regroup: in-wizard building assignment for a flat pile (IMPORT-3) ----

def _regroup(client, groups):
    return client.post(reverse(REGROUP), data=json.dumps({'groups': groups}),
                       content_type='application/json')


def _seed(workdir, rel, data=b'%PDF-1.4 seed'):
    """Write a drawing straight into the working dir's uploads tree (no render needed — regroup only
    moves bytes), returning its path."""
    p = workdir / 'uploads' / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return p


def test_regroup_moves_drawings_into_buildings(client, editor_user, workdir):
    # A flat pile in one folder is split into per-building folders; the emptied source is pruned so
    # it doesn't survive as a phantom (floorless) building at the next scan.
    client.force_login(editor_user)
    _seed(workdir, 'Building/1.pdf')
    _seed(workdir, 'Building/2.pdf')
    r = _regroup(client, {'Alpha': ['Building/1.pdf'], 'Beta': ['Building/2.pdf']})
    assert r.status_code == 200 and r.json()['moved'] == 2
    assert (workdir / 'uploads' / 'Alpha' / '1.pdf').is_file()
    assert (workdir / 'uploads' / 'Beta' / '2.pdf').is_file()
    assert not (workdir / 'uploads' / 'Building').exists()


def test_regroup_leaves_a_folder_that_keeps_drawings(client, editor_user, workdir):
    # Splitting only one drawing out leaves the source folder in place; a drawing whose destination
    # equals its source folder isn't moved (no-op), so the count reflects only the real move.
    client.force_login(editor_user)
    _seed(workdir, 'Building/1.pdf')
    _seed(workdir, 'Building/2.pdf')
    r = _regroup(client, {'Alpha': ['Building/1.pdf'], 'Building': ['Building/2.pdf']})
    assert r.status_code == 200 and r.json()['moved'] == 1
    assert (workdir / 'uploads' / 'Alpha' / '1.pdf').is_file()
    assert (workdir / 'uploads' / 'Building' / '2.pdf').is_file()


def test_regroup_carries_companion_siblings(client, editor_user, workdir, all_formats_accepted):
    # A moved drawing takes its same-stem companions (a Shapefile's .dbf/.prj) into the new folder,
    # so the multi-file set stays together.
    client.force_login(editor_user)
    _seed(workdir, 'Building/sensors.shp', b'\x00\x00\x27\x0a')
    _seed(workdir, 'Building/sensors.dbf', b'\x03')
    _seed(workdir, 'Building/sensors.prj', b'PROJCS[]')
    r = _regroup(client, {'Alpha': ['Building/sensors.shp']})
    assert r.status_code == 200
    for name in ('sensors.shp', 'sensors.dbf', 'sensors.prj'):
        assert (workdir / 'uploads' / 'Alpha' / name).is_file()
        assert not (workdir / 'uploads' / 'Building' / name).exists()


def test_regroup_refuses_a_destination_collision(client, editor_user, workdir):
    # A move whose destination already holds a file is refused before anything is touched.
    client.force_login(editor_user)
    _seed(workdir, 'Building/1.pdf', b'%PDF-src')
    _seed(workdir, 'Alpha/1.pdf', b'%PDF-existing')
    r = _regroup(client, {'Alpha': ['Building/1.pdf']})
    assert r.status_code == 400
    assert (workdir / 'uploads' / 'Building' / '1.pdf').read_bytes() == b'%PDF-src'
    assert (workdir / 'uploads' / 'Alpha' / '1.pdf').read_bytes() == b'%PDF-existing'


def test_regroup_rejects_a_traversing_building_name(client, editor_user, workdir):
    client.force_login(editor_user)
    _seed(workdir, 'Building/1.pdf')
    r = _regroup(client, {'../evil': ['Building/1.pdf']})
    assert r.status_code == 400
    assert (workdir / 'uploads' / 'Building' / '1.pdf').is_file()


def test_regroup_rejects_a_missing_source(client, editor_user, workdir):
    client.force_login(editor_user)
    assert _regroup(client, {'Alpha': ['Building/nope.pdf']}).status_code == 400


def test_regroup_denied_without_import_permission(client, plain_user, workdir):
    # PERM-1: regroup rewrites the on-disk layout, so it rides the import gate like every other
    # import endpoint — a change-only user is refused.
    client.force_login(plain_user)
    assert _regroup(client, {'Alpha': ['Building/1.pdf']}).status_code == 403


def test_regroup_rejects_the_thumbnail_cache_as_a_destination(client, editor_user, workdir):
    # IMPORT-24: `.thumbs` is reserved — `building_folders()` skips it — so a drawing moved there
    # would vanish from the wizard with no way back. Nothing legitimate targets the render cache,
    # so it is refused outright, before any file is touched.
    client.force_login(editor_user)
    _seed(workdir, 'Building/1.pdf')
    r = _regroup(client, {'.thumbs': ['Building/1.pdf']})
    assert r.status_code == 400
    assert (workdir / 'uploads' / 'Building' / '1.pdf').is_file()
    assert not (workdir / 'uploads' / '.thumbs' / '1.pdf').exists()


def test_regroup_accepts_the_excluded_folder_as_a_destination(client, editor_user, workdir):
    # IMPORT-24: the other reserved name is the organize step's exclude control — moving a drawing
    # into it is exactly how a title sheet or legend leaves the import. So unlike `.thumbs` it is
    # deliberately allowed, and the drawing is moved rather than deleted.
    client.force_login(editor_user)
    _seed(workdir, 'Building/1.pdf')
    _seed(workdir, 'Building/2.pdf')
    r = _regroup(client, {'Alpha': ['Building/1.pdf'], '_excluded': ['Building/2.pdf']})
    assert r.status_code == 200 and r.json()['moved'] == 2
    assert (workdir / 'uploads' / 'Alpha' / '1.pdf').is_file()
    assert (workdir / 'uploads' / '_excluded' / '2.pdf').is_file()


def test_regroup_excluding_every_drawing_still_validates_as_a_whole(client, editor_user, workdir):
    # The all-or-nothing property holds across a mixed exclude/assign payload: one bad entry rejects
    # the request before any file moves, so a refused exclusion can't half-empty the pile.
    client.force_login(editor_user)
    _seed(workdir, 'Building/1.pdf')
    _seed(workdir, 'Building/2.pdf')
    r = _regroup(client, {'_excluded': ['Building/1.pdf'], '.thumbs': ['Building/2.pdf']})
    assert r.status_code == 400
    assert (workdir / 'uploads' / 'Building' / '1.pdf').is_file()
    assert (workdir / 'uploads' / 'Building' / '2.pdf').is_file()
    assert not (workdir / 'uploads' / '_excluded').exists()


def test_regroup_excluded_drawings_disappear_from_the_next_scan(client, editor_user, workdir,
                                                                make_pdf):
    # End-to-end for IMPORT-24: an excluded drawing leaves the import entirely — the re-scan reports
    # neither an `_excluded` building nor the drawing under any other folder — while the file itself
    # is still on disk (nothing is deleted; data-safety standard #5).
    client.force_login(editor_user)
    for name in ('1.pdf', '2.pdf'):
        client.post(reverse(UPLOAD) + '?path=Building/' + name,
                    {'file': _upload(make_pdf(), name=name)})
    assert _regroup(client, {'Alpha': ['Building/1.pdf'],
                             '_excluded': ['Building/2.pdf']}).status_code == 200
    r = client.post(reverse(SCAN), {})
    assert r.status_code == 200
    folders = r.json()['folders']
    assert {f['folder'] for f in folders} == {'Alpha'}
    assert {p['file'] for f in folders for p in f['pdfs']} == {'1.pdf'}
    assert (workdir / 'uploads' / '_excluded' / '2.pdf').is_file()


def test_regroup_restores_a_drawing_out_of_the_excluded_folder(client, editor_user, workdir,
                                                               make_pdf):
    # End-to-end for IMPORT-26 (the reverse of the test above): the reserved park is a legitimate
    # regroup **source**, so the edit hub can move an excluded drawing back into a building. It
    # needs no special case in the view — a source is validated only by `safe_path` + is-a-file —
    # and the emptied park is pruned by the same prune that handles an emptied building folder.
    client.force_login(editor_user)
    for name in ('1.pdf', '2.pdf'):
        client.post(reverse(UPLOAD) + '?path=Building/' + name,
                    {'file': _upload(make_pdf(), name=name)})
    assert _regroup(client, {'Alpha': ['Building/1.pdf'],
                             '_excluded': ['Building/2.pdf']}).status_code == 200
    assert client.post(reverse(SCAN), {}).json()['excluded'][0]['file'] == '2.pdf'

    r = _regroup(client, {'Alpha': ['_excluded/2.pdf']})
    assert r.status_code == 200 and r.json()['moved'] == 1

    assert (workdir / 'uploads' / 'Alpha' / '2.pdf').is_file()
    assert not (workdir / 'uploads' / '_excluded').exists()
    inv = client.post(reverse(SCAN), {}).json()
    assert {p['file'] for f in inv['folders'] for p in f['pdfs']} == {'1.pdf', '2.pdf'}
    assert inv['excluded'] == []


def test_regroup_then_scan_yields_per_building_folders(client, editor_user, workdir, make_pdf):
    # End-to-end: a flat pile uploaded into one folder, regrouped, then re-scanned surfaces the new
    # per-building folders — proving the move keeps the folder-keyed scan pipeline intact (the whole
    # reason the server-move approach was chosen: building identity stays == the physical folder).
    client.force_login(editor_user)
    for name in ('1.pdf', '2.pdf'):
        client.post(reverse(UPLOAD) + '?path=Building/' + name,
                    {'file': _upload(make_pdf(), name=name)})
    assert _regroup(client, {'Alpha': ['Building/1.pdf'],
                             'Beta': ['Building/2.pdf']}).status_code == 200
    r = client.post(reverse(SCAN), {})
    assert r.status_code == 200
    assert {f['folder'] for f in r.json()['folders']} == {'Alpha', 'Beta'}


# ---- zip upload ----

def test_zip_rejects_bad_magic(client, editor_user, workdir):
    client.force_login(editor_user)
    r = client.post(reverse(UPLOAD_ZIP), {'file': _upload(b'NOTAZIP', name='a.zip')})
    assert r.status_code == 400


def test_zip_rejects_non_pdf_member(client, editor_user, workdir):
    client.force_login(editor_user)
    data = _zip_bytes([('AlphaWing/g.pdf', b'NOTPDF-data')])
    r = client.post(reverse(UPLOAD_ZIP), {'file': _upload(data, name='a.zip')})
    assert r.status_code == 400


def test_zip_rejects_symlink_member(client, editor_user, workdir, make_pdf):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        info = zipfile.ZipInfo('AlphaWing/g.pdf')
        info.external_attr = (0o120000 | 0o777) << 16  # S_IFLNK — a symlink member
        z.writestr(info, make_pdf())
    client.force_login(editor_user)
    r = client.post(reverse(UPLOAD_ZIP), {'file': _upload(buf.getvalue(), name='a.zip')})
    assert r.status_code == 400


def test_zip_rejects_too_many_pdfs(client, editor_user, workdir, make_pdf, monkeypatch):
    _cfg(monkeypatch, 'max_pdfs', 1)
    data = _zip_bytes([('AlphaWing/g.pdf', make_pdf()), ('AlphaWing/l1.pdf', make_pdf())])
    client.force_login(editor_user)
    r = client.post(reverse(UPLOAD_ZIP), {'file': _upload(data, name='a.zip')})
    assert r.status_code == 400


def test_zip_rejects_member_over_the_per_file_cap(client, editor_user, workdir, make_pdf,
                                                  monkeypatch):
    """A single oversize member is refused mid-stream (413), and its `.part` scratch file is
    cleaned up rather than left behind as a phantom drawing."""
    _cfg(monkeypatch, 'max_pdf_mb', 0)  # any non-empty member now exceeds the per-file cap
    data = _zip_bytes([('AlphaWing/g.pdf', make_pdf())])
    client.force_login(editor_user)
    r = client.post(reverse(UPLOAD_ZIP), {'file': _upload(data, name='a.zip')})
    assert r.status_code == 413
    assert 'exceeds the size limit' in r.json()['error']
    assert not list((workdir / 'uploads').rglob('*.part'))


def test_zip_rejects_bomb_on_the_cumulative_cap(client, editor_user, workdir, monkeypatch):
    """The zip-bomb guard is **archive-wide**, not per member: two drawings that each clear the
    per-file cap can still blow the decompressed budget together, and the extraction has to stop on
    the one that crosses it. This is the cap that a per-member-only accounting would miss — each
    member here is 0.6 MB against a 1 MB per-file cap, so neither trips on its own; only their
    running total (1.2 MB against the 1 MB archive cap) does."""
    _cfg(monkeypatch, 'max_pdf_mb', 1)
    _cfg(monkeypatch, 'max_zip_uncompressed_mb', 1)
    # Zeros compress to almost nothing, so the *uploaded* archive stays tiny — the whole point of
    # a decompression bomb, and why the cap has to be enforced on the bytes written out.
    big = b'%PDF-1.4\n' + b'\0' * (600 * 1024)
    data = _zip_bytes([('AlphaWing/g.pdf', big), ('AlphaWing/l1.pdf', big)])
    client.force_login(editor_user)
    r = client.post(reverse(UPLOAD_ZIP), {'file': _upload(data, name='a.zip')})
    assert r.status_code == 413
    assert 'decompresses too large' in r.json()['error']
    assert not list((workdir / 'uploads').rglob('*.part'))


def test_zip_stores_valid_members(client, editor_user, workdir, make_pdf):
    data = _zip_bytes([('AlphaWing/g.pdf', make_pdf()), ('AlphaWing/l1.pdf', make_pdf())])
    client.force_login(editor_user)
    r = client.post(reverse(UPLOAD_ZIP), {'file': _upload(data, name='a.zip')})
    assert r.status_code == 200
    assert r.json()['count'] == 2


def test_zip_stores_mixed_pdf_and_image_members(client, editor_user, workdir, make_pdf,
                                                 make_image):
    data = _zip_bytes([('AlphaWing/g.pdf', make_pdf()),
                       ('AlphaWing/l1.png', make_image('PNG')),
                       ('AlphaWing/l2.tif', make_image('TIFF'))])
    client.force_login(editor_user)
    r = client.post(reverse(UPLOAD_ZIP), {'file': _upload(data, name='a.zip')})
    assert r.status_code == 200
    assert r.json()['count'] == 3
    # The shared top folder is peeled as a wrapper (no deeper nesting), so members land in the
    # default `Building` bucket — same mapping as the all-PDF case; here we assert the image
    # members were extracted, not just counted.
    assert (workdir / 'uploads' / 'Building' / 'l1.png').is_file()
    assert (workdir / 'uploads' / 'Building' / 'l2.tif').is_file()


def test_zip_keeps_shapefile_set_together(client, editor_user, workdir, all_formats_accepted):
    # A zipped shapefile set: the `.shp` + siblings extract into the same building folder, but only
    # the `.shp` counts as a drawing. Two buildings so the building dir survives the wrapper peel.
    data = _zip_bytes([
        ('export/AlphaWing/g.pdf', b'%PDF-1.4 minimal'),
        ('export/AlphaWing/sensors.shp', b'\x00\x00\x27\x0a' + b'\x00' * 20),
        ('export/AlphaWing/sensors.dbf', b'\x03' + b'\x00' * 20),
        ('export/AlphaWing/sensors.prj', b'PROJCS["NAD83"]'),
        ('export/BetaWing/l1.pdf', b'%PDF-1.4 minimal'),
    ])
    client.force_login(editor_user)
    r = client.post(reverse(UPLOAD_ZIP), {'file': _upload(data, name='a.zip')})
    assert r.status_code == 200
    assert r.json()['count'] == 3   # two PDFs + the .shp drawing; its .dbf/.prj siblings don't count
    up = workdir / 'uploads' / 'AlphaWing'
    for name in ('sensors.shp', 'sensors.dbf', 'sensors.prj'):
        assert (up / name).is_file(), name


# ---- permission gate ----

RESET = 'plugins:netbox_facilitymap:api-import-reset'
RESTORE = 'plugins:netbox_facilitymap:api-backup-restore'
WIPE = 'plugins:netbox_facilitymap:api-data-wipe'


def test_upload_denied_without_any_permission(client, workdir):
    from utilities.testing import create_test_user
    client.force_login(create_test_user('nobody'))  # authenticated but unprivileged
    r = client.post(reverse(UPLOAD) + '?path=x.pdf', {'file': _upload(b'%PDF-1.4')})
    assert r.status_code == 403


def test_import_denied_with_only_change_permission(client, plain_user, editor_user, workdir):
    """PERM-1: the import surface is gated on `import_facilitymapblob`, split off the everyday
    `change_facilitymapblob`. A rack-placer holding only change (`plain_user`) is refused; the
    importer (`editor_user`, which also holds `import`) is not — proving the split, not a blanket
    login gate."""
    client.force_login(plain_user)
    assert client.post(reverse(SCAN), {}).status_code == 403
    client.force_login(editor_user)
    assert client.post(reverse(SCAN), {}).status_code != 403


def test_reset_requires_superuser(client, editor_user, superuser, workdir):
    """PERM-1: reset (the irreversible wipe) tightens the import gate with a superuser check. An
    importer who isn't a superuser is refused; a superuser succeeds."""
    client.force_login(editor_user)
    assert client.post(reverse(RESET), {}).status_code == 403
    client.force_login(superuser)
    r = client.post(reverse(RESET), {})
    assert r.status_code == 200 and r.json()['ok'] is True


# ---- the render lock covers every working-dir mutation, not just renders (PERF-1) ----

def _hold_lock(workdir):
    """Plant a fresh render lockfile, as an in-flight scan/build subprocess would."""
    from netbox_facilitymap.render_runner import RenderRunner
    workdir.mkdir(parents=True, exist_ok=True)
    lock = workdir / RenderRunner.LOCK_NAME
    lock.write_text('')
    return lock


def test_reset_409s_while_a_render_holds_the_lock(client, superuser, workdir):
    """Reset wipes uploads/ + images/, which would strand a live render mid-write — so it takes the
    same lockfile and 409s instead, leaving the working dir untouched."""
    _hold_lock(workdir)
    (workdir / 'uploads').mkdir()
    (workdir / 'uploads' / 'a.pdf').write_bytes(b'%PDF-1.4')
    (workdir / 'manifest.json').write_text('{"siteplan": null, "buildings": []}')
    client.force_login(superuser)
    r = client.post(reverse(RESET), {})
    assert r.status_code == 409
    assert (workdir / 'uploads' / 'a.pdf').is_file()
    assert (workdir / 'manifest.json').is_file()


def test_reset_keeps_the_lockfile_it_holds(client, superuser, workdir):
    """Reset no longer deletes the lockfile: it *holds* it for the wipe and releases it on the way
    out, so the file is gone afterwards but was never yanked out from under a running render (a
    lock stranded by a crashed render is reclaimed by `_acquire_lock`'s staleness check instead)."""
    from netbox_facilitymap.render_runner import RenderRunner
    (workdir / 'uploads').mkdir(parents=True)
    (workdir / 'uploads' / 'a.pdf').write_bytes(b'%PDF-1.4')
    client.force_login(superuser)
    r = client.post(reverse(RESET), {})
    assert r.status_code == 200 and r.json()['ok'] is True
    assert not (workdir / 'uploads').exists()
    assert not (workdir / RenderRunner.LOCK_NAME).exists()


# ---- the full data wipe (HEALTH-12) ----

def test_wipe_requires_superuser(client, editor_user, superuser, workdir):
    """The wipe is `reset`'s complete counterpart (DB rows *and* files), so it sits on the same
    reset tier: import permission alone is not enough (PERM-1)."""
    client.force_login(editor_user)
    assert client.post(reverse(WIPE), '{"all": true}',
                       content_type='application/json').status_code == 403
    client.force_login(superuser)
    r = client.post(reverse(WIPE), '{"all": true}', content_type='application/json')
    assert r.status_code == 200 and r.json()['ok'] is True


def test_wipe_all_removes_rows_the_reset_endpoint_leaves_behind(client, superuser, workdir):
    """The reason the endpoint exists: `reset` clears the working dir but leaves every row, so a
    "start over" resurrects the old rooms. The wipe takes both."""
    from netbox_facilitymap.models import FacilityMapBlob, Room
    FacilityMapBlob.objects.create(kind='siteplan', data={'hotspots': []})
    Room.objects.create(floor_key='s/f', room_id='r1', label='R1',
                        polygon=[[0, 0], [1, 0], [1, 1]])
    (workdir / 'images').mkdir(parents=True)
    (workdir / 'images' / 'f.png').write_bytes(b'PNG')

    client.force_login(superuser)
    r = client.post(reverse(WIPE), '{"all": true}', content_type='application/json')

    assert r.status_code == 200 and r.json()['rooms'] == 1
    assert not FacilityMapBlob.objects.exists() and not Room.objects.exists()
    assert not (workdir / 'images').exists()


def test_wipe_409s_while_a_render_holds_the_lock(client, superuser, workdir):
    """Same working-dir-lock rule as reset and the archive restore: a wipe under a live render
    would strand a half-rendered facility, so it 409s with nothing changed."""
    _hold_lock(workdir)
    (workdir / 'manifest.json').write_text('{"siteplan": null, "buildings": []}')
    client.force_login(superuser)
    r = client.post(reverse(WIPE), '{"all": true}', content_type='application/json')
    assert r.status_code == 409
    assert (workdir / 'manifest.json').is_file()


def test_wipe_rejects_an_invalid_facility(client, superuser, workdir):
    """A hostile facility would become a directory name; `valid_facility` refuses it at the
    boundary rather than letting a wipe escape the working dir."""
    client.force_login(superuser)
    r = client.post(reverse(WIPE), '{"facility": "../etc"}', content_type='application/json')
    assert r.status_code == 400


def test_build_writes_the_import_map_only_under_the_lock(client, editor_user, workdir):
    """The posted import map is persisted *inside* the lock: a build that can't take the lock must
    not leave its map behind, or the render already in flight would pick it up."""
    _hold_lock(workdir)
    client.force_login(editor_user)
    r = client.post(reverse(BUILD), data=json.dumps({'buildings': []}),
                    content_type='application/json')
    assert r.status_code == 409
    assert not (workdir / 'import-map.json').exists()


def test_restore_409s_while_a_render_holds_the_lock(client, superuser, workdir):
    """Restore swaps the whole working-dir tree, so it is serialized against renders too — and
    refuses before the archive is ever opened, leaving the current facility intact."""
    _hold_lock(workdir)
    (workdir / 'manifest.json').write_text('{"siteplan": null, "buildings": ["keep"]}')
    client.force_login(superuser)
    archive = SimpleUploadedFile('b.tar.gz', b'\x1f\x8b\x08\x00padding', content_type='application/gzip')
    r = client.post(reverse(RESTORE), {'file': archive})
    assert r.status_code == 409
    assert json.loads((workdir / 'manifest.json').read_text())['buildings'] == ['keep']


# ---- rebuild in place: read the live import map, re-render from it (IMPORT-74) ----

LIVE_MAP = {'buildings': {'hq': {'slug': 'hq', 'name': 'HQ', 'abbr': 'h',
                                 'floors': {'plan-1': '1'}}}}


def _save_map(workdir, data=None):
    workdir.mkdir(parents=True, exist_ok=True)
    path = workdir / 'import-map.json'
    path.write_text(json.dumps(LIVE_MAP if data is None else data), encoding='utf-8')
    return path


@pytest.fixture
def spawned(monkeypatch):
    """Capture the argv `RenderRunner.run` would spawn, without running a render (the
    test_render_quality fixture of the same name, kept local so neither file imports the other)."""
    calls = []

    class _Proc:
        returncode = 0
        stdout = ''
        stderr = ''

    def fake_run(argv, **kwargs):
        calls.append(argv)
        return _Proc()

    monkeypatch.setattr('netbox_facilitymap.render_runner.subprocess.run', fake_run)
    return calls


def test_import_map_returns_the_saved_map(client, editor_user, workdir):
    _save_map(workdir)
    client.force_login(editor_user)
    r = client.get(reverse(IMPORT_MAP))
    assert r.status_code == 200
    assert r.json() == {'ok': True, 'map': LIVE_MAP}


def test_import_map_reports_absence_without_erroring(client, editor_user, workdir):
    """A facility imported before the map was retained simply has none — a branch for the caller
    (which then offers the import editor instead), not an error to surface."""
    client.force_login(editor_user)
    r = client.get(reverse(IMPORT_MAP))
    assert r.status_code == 200 and r.json() == {'ok': False}


def test_import_map_reports_an_unreadable_map_the_same_way(client, editor_user, workdir):
    _save_map(workdir)
    (workdir / 'import-map.json').write_text('{ not json', encoding='utf-8')
    client.force_login(editor_user)
    assert client.get(reverse(IMPORT_MAP)).json() == {'ok': False}


def test_rebuild_refuses_when_there_is_no_saved_map(client, editor_user, workdir):
    client.force_login(editor_user)
    r = client.post(reverse(REBUILD), data='{}', content_type='application/json')
    assert r.status_code == 400 and r.json()['reason'] == 'no-map'


def test_rebuild_refuses_a_map_that_assigns_no_floors(client, editor_user, workdir):
    """Rendering a map with nothing in it would replace a working manifest with an empty one, so
    completeness is checked before the render rather than discovered after it."""
    _save_map(workdir, {'buildings': {'hq': {'slug': 'hq', 'floors': {}}}})
    client.force_login(editor_user)
    r = client.post(reverse(REBUILD), data='{}', content_type='application/json')
    assert r.status_code == 400 and r.json()['reason'] == 'incomplete'


def test_rebuild_enforces_the_same_drawing_cap_as_a_build(client, editor_user, workdir,
                                                          monkeypatch):
    _cfg(monkeypatch, 'max_pdfs', 0)
    _save_map(workdir)
    client.force_login(editor_user)
    r = client.post(reverse(REBUILD), data='{}', content_type='application/json')
    assert r.status_code == 400 and 'too many drawings' in r.json()['error']


def test_rebuild_409s_while_a_render_holds_the_lock(client, editor_user, workdir):
    """It renders, so it takes the same working-dir lock every render does — an in-flight
    scan/build/reset/restore is reported as busy, not as a failure."""
    _save_map(workdir)
    _hold_lock(workdir)
    client.force_login(editor_user)
    r = client.post(reverse(REBUILD), data='{}', content_type='application/json')
    assert r.status_code == 409


def test_rebuild_renders_the_saved_map_without_rewriting_it(client, editor_user, workdir, spawned):
    """The point of this endpoint: it re-renders the live map and writes nothing. Unlike `build` it
    passes no `prepare`, so the map on disk is byte-identical afterwards — in particular it is NOT
    re-stamped with the facility's current `orgMode`, which would let a rebuild fired to change
    render quality silently adopt an organization-mode change that was never rebuilt for."""
    path = _save_map(workdir)
    before = path.read_text(encoding='utf-8')
    client.force_login(editor_user)
    r = client.post(reverse(REBUILD), data='{}', content_type='application/json')
    assert r.status_code == 200 and r.json()['ok'] is True
    assert len(spawned) == 1 and 'build' in spawned[0]
    assert path.read_text(encoding='utf-8') == before
    assert 'orgMode' not in json.loads(before)


def test_rebuild_denied_without_import_permission(client, plain_user, workdir):
    _save_map(workdir)
    client.force_login(plain_user)
    assert client.post(reverse(REBUILD), data='{}',
                       content_type='application/json').status_code == 403
    assert client.get(reverse(IMPORT_MAP)).status_code == 403


# ---- manifest / media caching ----

MANIFEST = 'plugins:netbox_facilitymap:api-manifest'
MEDIA = 'plugins:netbox_facilitymap:api-media'


def _media_file(workdir, rel='images/alpha/g.png', data=b'\x89PNG\r\n\x1a\n-test-bytes'):
    path = workdir / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def test_media_unversioned_revalidates(client, plain_user, workdir):
    _media_file(workdir)
    client.force_login(plain_user)
    r = client.get(reverse(MEDIA, kwargs={'path': 'images/alpha/g.png'}))
    assert r.status_code == 200
    # Never `public`: the images are authenticated by design and a shared cache must not
    # store them. Without a `?v=` token the browser has to revalidate.
    assert r['Cache-Control'] == 'private, no-cache'
    assert r['ETag'] and r['Last-Modified']


def test_media_versioned_caches_immutably(client, plain_user, workdir):
    _media_file(workdir)
    client.force_login(plain_user)
    r = client.get(reverse(MEDIA, kwargs={'path': 'images/alpha/g.png'}) + '?v=1234')
    assert r.status_code == 200
    assert r['Cache-Control'] == 'private, max-age=31536000, immutable'


def test_media_conditional_request_returns_304(client, plain_user, workdir):
    _media_file(workdir)
    client.force_login(plain_user)
    url = reverse(MEDIA, kwargs={'path': 'images/alpha/g.png'})
    first = client.get(url)
    r = client.get(url, HTTP_IF_NONE_MATCH=first['ETag'])
    assert r.status_code == 304
    assert r['ETag'] == first['ETag']
    r = client.get(url, HTTP_IF_MODIFIED_SINCE=first['Last-Modified'])
    assert r.status_code == 304


# ---- optional nginx X-Accel-Redirect offload for authenticated media (HEALTH-3) ----

def test_media_streams_from_worker_by_default(client, plain_user, workdir):
    # Setting off (default): the worker streams the bytes via FileResponse, no offload header.
    data = b'\x89PNG\r\n\x1a\n-body'
    _media_file(workdir, data=data)
    client.force_login(plain_user)
    r = client.get(reverse(MEDIA, kwargs={'path': 'images/alpha/g.png'}))
    assert r.status_code == 200
    assert 'X-Accel-Redirect' not in r
    assert b''.join(r.streaming_content) == data


def test_media_x_accel_offloads_to_nginx(client, plain_user, workdir, monkeypatch):
    # Setting on: an empty response hands nginx the internal path; the worker never streams the
    # bytes, but still sets the validators + Cache-Control so revalidation stays worker-driven.
    _cfg(monkeypatch, 'x_accel_redirect', True)
    _media_file(workdir)
    client.force_login(plain_user)
    r = client.get(reverse(MEDIA, kwargs={'path': 'images/alpha/g.png'}) + '?v=9')
    assert r.status_code == 200
    assert r['X-Accel-Redirect'] == '/facilitymap-internal/images/alpha/g.png'
    assert r.content == b''
    assert r['Cache-Control'] == 'private, max-age=31536000, immutable'
    assert r['ETag'] and r['Last-Modified']


def test_media_x_accel_honours_configured_location_and_encodes(client, plain_user, workdir,
                                                               monkeypatch):
    # A custom `internal` location prefix is honoured, and each path segment is URL-encoded for
    # the header (a space → %20) so nginx resolves the same file under its alias.
    _cfg(monkeypatch, 'x_accel_redirect', True)
    _cfg(monkeypatch, 'x_accel_location', '/nginx-internal')  # no trailing slash → still one join
    _media_file(workdir, rel='images/alpha/g 1.png')
    client.force_login(plain_user)
    r = client.get(reverse(MEDIA, kwargs={'path': 'images/alpha/g 1.png'}))
    assert r.status_code == 200
    assert r['X-Accel-Redirect'] == '/nginx-internal/images/alpha/g%201.png'


def test_media_x_accel_does_not_bypass_auth(client, workdir, monkeypatch):
    # The offload only ever fires after the login gate: an unauthenticated request is redirected
    # to login, never handed an X-Accel-Redirect header (media stays authenticated).
    _cfg(monkeypatch, 'x_accel_redirect', True)
    _media_file(workdir)
    r = client.get(reverse(MEDIA, kwargs={'path': 'images/alpha/g.png'}))
    assert r.status_code in (302, 403)
    assert 'X-Accel-Redirect' not in r


def test_manifest_revalidates_with_etag(client, plain_user, workdir):
    (workdir / 'manifest.json').write_text('{"siteplan": null, "buildings": [], "built": 1}')
    client.force_login(plain_user)
    url = reverse(MANIFEST)
    first = client.get(url)
    assert first.status_code == 200
    assert first['Cache-Control'] == 'private, no-cache'
    assert first.json()['built'] == 1
    r = client.get(url, HTTP_IF_NONE_MATCH=first['ETag'])
    assert r.status_code == 304


def test_manifest_fallback_is_uncached(client, plain_user, workdir):
    # No manifest.json in the workdir → the empty stub, marked no-store so a later import
    # isn't masked by a cached "empty facility".
    client.force_login(plain_user)
    r = client.get(reverse(MANIFEST))
    assert r.status_code == 200
    assert r.json() == {'siteplan': None, 'buildings': []}
    assert r['Cache-Control'] == 'no-store'


def test_manifest_304_does_not_read_the_file(client, plain_user, workdir, monkeypatch):
    """PERF-1: the validators come from a bare stat(), so a revalidating client never pays the
    read + JSON parse — the manifest is only read for a 200 body, and then through
    `storage.read_manifest`'s memo rather than an inline `json.loads`."""
    from netbox_facilitymap import serving
    (workdir / 'manifest.json').write_text('{"siteplan": null, "buildings": [], "built": 7}')
    reads = []
    real = serving.read_manifest
    monkeypatch.setattr(serving, 'read_manifest',
                        lambda facility='': (reads.append(facility), real(facility))[1])
    client.force_login(plain_user)
    url = reverse(MANIFEST)
    first = client.get(url)
    assert first.status_code == 200 and first.json()['built'] == 7
    assert len(reads) == 1
    r = client.get(url, HTTP_IF_NONE_MATCH=first['ETag'])
    assert r.status_code == 304
    assert len(reads) == 1  # the 304 read nothing


def _rewrite_newer(path, text):
    """Rewrite a file and push its mtime forward, the way a rebuild does. The bump is explicit
    because a same-length rewrite within the filesystem's timestamp resolution would otherwise be
    indistinguishable from the original to a `stat()`-derived validator."""
    import os
    stamp = path.stat().st_mtime + 2
    path.write_text(text)
    os.utime(path, (stamp, stamp))


def test_manifest_etag_changes_when_the_manifest_is_rebuilt(client, plain_user, workdir):
    """The flip side of the cheap 304: because the validators come from a `stat()` rather than the
    body, they must still move when a rebuild rewrites the file — otherwise a client holding the old
    ETag would keep revalidating into a 304 and never see the new campus."""
    (workdir / 'manifest.json').write_text('{"siteplan": null, "buildings": [], "built": 1}')
    client.force_login(plain_user)
    url = reverse(MANIFEST)
    first = client.get(url)
    assert first.status_code == 200

    _rewrite_newer(workdir / 'manifest.json',
                   '{"siteplan": null, "buildings": [], "built": 2}')

    revalidated = client.get(url, HTTP_IF_NONE_MATCH=first['ETag'])
    assert revalidated.status_code == 200            # not a 304 — the validator moved
    assert revalidated.json()['built'] == 2
    assert revalidated['ETag'] != first['ETag']


def test_manifest_unreadable_falls_back_to_the_stub(client, plain_user, workdir):
    """A manifest that stats but won't parse is indistinguishable from a fresh install (§10) — it
    still collapses to the `no-store` empty stub now that the read happens after the conditional."""
    (workdir / 'manifest.json').write_text('{"buildings": [truncated')
    client.force_login(plain_user)
    r = client.get(reverse(MANIFEST))
    assert r.status_code == 200
    assert r.json() == {'siteplan': None, 'buildings': []}
    assert r['Cache-Control'] == 'no-store'


# ---- per-facility import + serving (MULTI-2) ----

def test_upload_lands_under_facility_subdir(client, editor_user, workdir, make_pdf):
    # A ?facility=slug upload nests under <workdir>/<slug>/uploads, never the flat root.
    client.force_login(editor_user)
    r = client.post(reverse(UPLOAD) + '?path=Alpha/g.pdf&facility=west',
                    {'file': _upload(make_pdf())})
    assert r.status_code == 200
    assert (workdir / 'west' / 'uploads' / 'Alpha' / 'g.pdf').is_file()
    assert not (workdir / 'uploads').exists()   # the default facility is untouched


def test_manifest_and_media_scoped_to_facility(client, plain_user, workdir):
    # The per-facility manifest + media are served from that facility's subdir; the default
    # facility's manifest is independent.
    (workdir / 'west').mkdir()
    (workdir / 'west' / 'manifest.json').write_text('{"siteplan": null, "buildings": ["W"]}')
    (workdir / 'manifest.json').write_text('{"siteplan": null, "buildings": ["default"]}')
    _media_file(workdir / 'west', rel='images/w/p.png', data=b'\x89PNG\r\n\x1a\n-west')
    client.force_login(plain_user)

    assert client.get(reverse(MANIFEST) + '?facility=west').json()['buildings'] == ['W']
    assert client.get(reverse(MANIFEST)).json()['buildings'] == ['default']
    r = client.get(reverse(MEDIA, kwargs={'path': 'images/w/p.png'}) + '?facility=west')
    assert r.status_code == 200
    # The same path without the facility 404s — it lives only under the facility subdir.
    assert client.get(reverse(MEDIA, kwargs={'path': 'images/w/p.png'})).status_code == 404


def test_media_x_accel_prefixes_facility(client, plain_user, workdir, monkeypatch):
    # The nginx internal alias points at the working-dir root, so the facility is prefixed back
    # onto the offload path (parts are relative to the per-facility subdir).
    _cfg(monkeypatch, 'x_accel_redirect', True)
    _media_file(workdir / 'west', rel='images/w/p.png')
    client.force_login(plain_user)
    r = client.get(reverse(MEDIA, kwargs={'path': 'images/w/p.png'}) + '?facility=west')
    assert r['X-Accel-Redirect'] == '/facilitymap-internal/west/images/w/p.png'


def test_import_endpoints_reject_bad_facility(client, editor_user, workdir):
    client.force_login(editor_user)
    assert client.get(reverse(MANIFEST) + '?facility=../evil').status_code == 400


# ---- multi-page PDF: page-parametrized preview + rendered-drawing cap (IMPORT-1) ----

def test_preview_renders_the_requested_page(client, editor_user, workdir, make_multipage_pdf):
    """`?page=N` selects a page of a multi-page PDF — asserted via the pages' distinct widths,
    since page 1 is 120pt wide and page 2 is 200pt wide."""
    from PIL import Image
    (workdir / 'uploads' / 'AlphaWing').mkdir(parents=True)
    (workdir / 'uploads' / 'AlphaWing' / 'set.pdf').write_bytes(
        make_multipage_pdf([(120, 160), (200, 160)]))
    client.force_login(editor_user)
    url = reverse(PREVIEW) + '?path=uploads/AlphaWing/set.pdf'

    r1 = client.get(url)
    assert r1.status_code == 200
    w1 = Image.open(io.BytesIO(b''.join(r1.streaming_content))).width

    r2 = client.get(url + '&page=2')
    assert r2.status_code == 200
    w2 = Image.open(io.BytesIO(b''.join(r2.streaming_content))).width

    assert w2 > w1


def test_build_caps_on_rendered_drawings_not_files(client, editor_user, workdir, monkeypatch):
    """The build cap counts import-map floor entries (rendered drawings), so an exploded
    multi-page PDF is bounded on pages rendered even though it is a single uploaded file."""
    _cfg(monkeypatch, 'max_pdfs', 1)
    client.force_login(editor_user)
    body = json.dumps({'buildings': {'AlphaWing': {
        'slug': 'alpha', 'name': 'Alpha', 'abbr': 'AB',
        'floors': {'set#p1': 'g', 'set#p2': 'b1'}}}})
    r = client.post(reverse(BUILD), body, content_type='application/json')
    assert r.status_code == 400
    assert 'too many drawings' in r.json()['error']


def test_build_cap_counts_region_split_floors(client, editor_user, workdir, monkeypatch):
    """A region-split page (a `[{token, region}]` list value) renders one floor per region, so the
    cap counts each region — a single drawing whose value fans into two floors trips a cap of 1."""
    _cfg(monkeypatch, 'max_pdfs', 1)
    client.force_login(editor_user)
    body = json.dumps({'buildings': {'AlphaWing': {
        'slug': 'alpha', 'name': 'Alpha', 'abbr': 'AB',
        'floors': {'wing': [{'token': 'l2', 'region': [0, 0, 0.5, 1]},
                            {'token': 'l3', 'region': [0.5, 0, 0.5, 1]}]}}}})
    r = client.post(reverse(BUILD), body, content_type='application/json')
    assert r.status_code == 400
    assert 'too many drawings' in r.json()['error']


# ---- backup archive export / restore (BACKUP-1) ----

EXPORT = 'plugins:netbox_facilitymap:api-backup-export'


def test_export_streams_archive_with_data(client, editor_user, workdir, backupdir):
    """Export (import-gated) streams a .tar.gz attachment carrying the DB dump; a seeded blob
    round-trips into it."""
    import tarfile
    from netbox_facilitymap.models import FacilityMapBlob
    FacilityMapBlob.objects.create(kind='siteplan', data={'hotspots': [{'x': 1}]})

    client.force_login(editor_user)
    r = client.get(reverse(EXPORT))
    assert r.status_code == 200
    assert r['Content-Disposition'].startswith('attachment')
    with tarfile.open(fileobj=io.BytesIO(b''.join(r.streaming_content))) as tar:
        db = tar.extractfile('db.json').read().decode('utf-8')
    assert 'siteplan' in db and 'hotspots' in db


def test_export_denied_with_only_change_permission(client, plain_user, workdir, backupdir):
    """Export rides the import gate, not the everyday change gate."""
    client.force_login(plain_user)
    assert client.get(reverse(EXPORT)).status_code == 403


def test_restore_requires_superuser(client, editor_user, superuser, workdir, backupdir):
    """Restore is the reset tier: import permission is not enough, a superuser is required."""
    from netbox_facilitymap.backup import create_backup
    path, _ = create_backup(stamp='20200101-000000')
    archive = path.read_bytes()

    client.force_login(editor_user)
    r = client.post(reverse(RESTORE),
                    {'file': _upload(archive, name='b.tar.gz', content_type='application/gzip')})
    assert r.status_code == 403

    client.force_login(superuser)
    r = client.post(reverse(RESTORE),
                    {'file': _upload(archive, name='b.tar.gz', content_type='application/gzip')})
    assert r.status_code == 200
    assert r.json()['ok'] is True


def test_restore_replaces_all_data(client, superuser, workdir, backupdir):
    """A superuser restore is a destructive full replace: rows present at backup time come back,
    rows added afterwards are wiped."""
    from netbox_facilitymap.backup import create_backup
    from netbox_facilitymap.models import FacilityMapBlob

    FacilityMapBlob.objects.create(kind='siteplan', data={'v': 1})
    path, _ = create_backup(stamp='20200101-000001')
    # Mutate after the backup — the restore must discard this.
    FacilityMapBlob.objects.create(kind='layouts', data={'v': 2})

    client.force_login(superuser)
    r = client.post(reverse(RESTORE),
                    {'file': _upload(path.read_bytes(), name='b.tar.gz',
                                     content_type='application/gzip')})
    assert r.status_code == 200
    assert FacilityMapBlob.objects.filter(kind='siteplan').exists()
    assert not FacilityMapBlob.objects.filter(kind='layouts').exists()


def test_restore_rejects_bad_magic(client, superuser, workdir):
    client.force_login(superuser)
    r = client.post(reverse(RESTORE),
                    {'file': _upload(b'not-a-gzip-archive', name='b.tar.gz')})
    assert r.status_code == 400


def test_restore_rejects_oversize(client, superuser, workdir, monkeypatch):
    _cfg(monkeypatch, 'backup_max_mb', 0)  # any non-empty archive now exceeds the cap
    client.force_login(superuser)
    r = client.post(reverse(RESTORE),
                    {'file': _upload(b'\x1f\x8b' + b'x' * 32, name='b.tar.gz')})
    assert r.status_code == 413
