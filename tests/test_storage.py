"""Tier B — `storage.safe_path`, the traversal guard every file-serving/writing caller goes
through. Needs Django settings (for the plugin config / MEDIA_ROOT) but no database."""

import json

import pytest

from netbox_facilitymap.storage import (
    MANIFEST_NAME, move_facility, read_manifest, safe_path, valid_facility, work_dir)


def test_accepts_path_inside_workdir(workdir):
    assert safe_path('uploads/a.pdf') == workdir.resolve() / 'uploads' / 'a.pdf'


def test_normalises_dotdot_that_stays_inside(workdir):
    # `..` that resolves back within the working dir is fine.
    assert safe_path('uploads/sub/../a.pdf') == workdir.resolve() / 'uploads' / 'a.pdf'


@pytest.mark.parametrize('rel', ['..', '../evil', '../../etc/passwd', 'uploads/../../escape'])
def test_rejects_traversal(workdir, rel):
    with pytest.raises(ValueError):
        safe_path(rel)


def test_rejects_absolute_path(workdir):
    with pytest.raises(ValueError):
        safe_path('/etc/passwd')


def test_rejects_symlink_escape(workdir):
    # A symlink inside the working dir that points outside must be refused: safe_path's
    # resolve() follows the link, so the guard sees the real (escaping) target.
    outside = workdir.parent / 'outside_target'
    outside.mkdir()
    uploads = workdir / 'uploads'
    uploads.mkdir(parents=True)
    (uploads / 'link').symlink_to(outside)
    with pytest.raises(ValueError):
        safe_path('uploads/link/secret.pdf')


# --- read_manifest: the mtime-memoized manifest reader the hot server-rendered panels share ---

def _write_manifest(workdir, payload):
    (workdir / MANIFEST_NAME).write_text(json.dumps(payload))


def test_read_manifest_none_when_missing(workdir):
    # No manifest yet (before the first import) is a normal state, not an error.
    assert read_manifest() is None


def test_read_manifest_none_when_unreadable(workdir):
    (workdir / MANIFEST_NAME).write_text('{ not valid json')
    assert read_manifest() is None


def test_read_manifest_parses_present(workdir):
    _write_manifest(workdir, {'siteplan': {'w': 10, 'h': 20}, 'buildings': []})
    assert read_manifest() == {'siteplan': {'w': 10, 'h': 20}, 'buildings': []}


def test_read_manifest_memoized_returns_same_object(workdir):
    # A second read within the process reuses the parse (same identity) — the whole point of the
    # memo: hot panels don't re-read + re-parse on every render.
    _write_manifest(workdir, {'siteplan': None, 'buildings': [{'dir': 'b'}]})
    first = read_manifest()
    assert read_manifest() is first


def test_read_manifest_busts_on_rewrite(workdir):
    # A rebuild rewrites the file (new mtime/size); the memo self-busts and re-parses. `st_size`
    # differs between the two payloads, so the change is detected even at coarse mtime resolution.
    _write_manifest(workdir, {'buildings': [{'dir': 'one'}]})
    assert read_manifest()['buildings'][0]['dir'] == 'one'
    _write_manifest(workdir, {'buildings': [{'dir': 'two', 'extra': 'padding-so-size-differs'}]})
    assert read_manifest()['buildings'][0]['dir'] == 'two'


# --- per-facility working dir (MULTI-2) --------------------------------------------------

def test_work_dir_default_is_flat_root(workdir):
    # The default facility '' keeps the flat root — single-facility installs are unchanged.
    assert work_dir() == workdir
    assert work_dir('') == workdir


def test_work_dir_nests_per_facility(workdir):
    assert work_dir('west-campus') == workdir / 'west-campus'


@pytest.mark.parametrize('facility', ['', 'a', 'west-campus', 'Campus_2', 'x-9'])
def test_valid_facility_accepts_slugs(facility):
    assert valid_facility(facility) == facility


@pytest.mark.parametrize('facility', ['..', 'a/b', '../evil', 'a b', 'a.b', '/abs', 'x/../y'])
def test_valid_facility_rejects_non_slugs(facility):
    with pytest.raises(ValueError):
        valid_facility(facility)


@pytest.mark.parametrize('facility', ['images', 'uploads'])
def test_valid_facility_rejects_reserved_subdir_names(facility):
    # A facility named after a reserved top-level dir would nest into the default facility's own
    # rendered output — rejected so a `dcim` slug can't corrupt it.
    with pytest.raises(ValueError):
        valid_facility(facility)


def test_work_dir_rejects_traversal_facility(workdir):
    # A hostile ?facility= can never escape the working dir (it becomes a subfolder name).
    with pytest.raises(ValueError):
        work_dir('../escape')


def test_safe_path_confined_to_facility_subdir(workdir):
    assert safe_path('uploads/a.pdf', 'west') == (workdir / 'west').resolve() / 'uploads' / 'a.pdf'
    # Traversal out of the facility subdir is still refused.
    with pytest.raises(ValueError):
        safe_path('../../escape', 'west')


def test_read_manifest_per_facility_isolated(workdir):
    # Each facility reads its own manifest; the memo is keyed by path, so they don't collide.
    (workdir / 'a').mkdir()
    (workdir / 'b').mkdir()
    (workdir / 'a' / MANIFEST_NAME).write_text(json.dumps({'buildings': [{'dir': 'AA'}]}))
    (workdir / 'b' / MANIFEST_NAME).write_text(json.dumps({'buildings': [{'dir': 'BB'}]}))
    assert read_manifest('a')['buildings'][0]['dir'] == 'AA'
    assert read_manifest('b')['buildings'][0]['dir'] == 'BB'
    assert read_manifest() is None   # the default facility has no manifest of its own


# --- move_facility: the working-dir half of the orphan-reassignment recovery (HEALTH-1) ----------

def test_move_facility_moves_rendered_artifacts_from_flat_root(workdir):
    # The default facility's flat-root artifacts move into the target's subfolder.
    (workdir / MANIFEST_NAME).write_text('{}')
    (workdir / 'images').mkdir()
    (workdir / 'images' / 'f.png').write_bytes(b'x')
    (workdir / 'uploads').mkdir()

    moved = move_facility('', 'west')
    assert set(moved) == {MANIFEST_NAME, 'images', 'uploads'}
    assert (workdir / 'west' / MANIFEST_NAME).exists()
    assert (workdir / 'west' / 'images' / 'f.png').read_bytes() == b'x'
    assert not (workdir / MANIFEST_NAME).exists()
    assert not (workdir / 'images').exists()


def test_move_facility_leaves_sibling_facilities_intact(workdir):
    # Moving the flat root's named artifacts must not drag a sibling facility's subfolder along.
    (workdir / MANIFEST_NAME).write_text('{}')
    (workdir / 'east').mkdir()
    (workdir / 'east' / MANIFEST_NAME).write_text('{}')

    move_facility('', 'west')
    assert (workdir / 'east' / MANIFEST_NAME).exists()


def test_move_facility_refuses_populated_destination(workdir):
    (workdir / MANIFEST_NAME).write_text('{}')
    (workdir / 'west').mkdir()
    (workdir / 'west' / MANIFEST_NAME).write_text('{}')
    with pytest.raises(ValueError):
        move_facility('', 'west')


def test_move_facility_skips_missing_artifacts(workdir):
    # Nothing to move → empty result, no error (best-effort per artifact).
    assert move_facility('', 'west') == []
