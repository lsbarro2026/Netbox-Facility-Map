"""Tier C — `backup.create_backup`/`restore_backup`: the create→restore round-trip (DB rows +
working-dir files) and the `_check_safe_members` archive traversal guard.

The traversal-guard tests need neither a database nor a working dir, so they aren't marked
`django_db`; the round-trip is DB-backed and filesystem-backed."""

import io
import tarfile

import pytest

from netbox_facilitymap.backup import _check_safe_members, create_backup, restore_backup


# ---- archive traversal guard (no DB) ----

def test_check_safe_members_rejects_parent_escape(tmp_path):
    path = tmp_path / 'bad.tar'
    with tarfile.open(path, 'w') as tar:
        info = tarfile.TarInfo('../evil')
        info.size = 0
        tar.addfile(info, io.BytesIO(b''))
    with tarfile.open(path) as tar:
        with pytest.raises(ValueError, match='unsafe path'):
            _check_safe_members(tar.getmembers())


def test_check_safe_members_rejects_absolute(tmp_path):
    path = tmp_path / 'abs.tar'
    with tarfile.open(path, 'w') as tar:
        info = tarfile.TarInfo('/etc/passwd')
        info.size = 0
        tar.addfile(info, io.BytesIO(b''))
    with tarfile.open(path) as tar:
        with pytest.raises(ValueError, match='unsafe path'):
            _check_safe_members(tar.getmembers())


def test_check_safe_members_rejects_symlink(tmp_path):
    path = tmp_path / 'link.tar'
    with tarfile.open(path, 'w') as tar:
        info = tarfile.TarInfo('evil')
        info.type = tarfile.SYMTYPE
        info.linkname = '/etc/passwd'
        tar.addfile(info)
    with tarfile.open(path) as tar:
        with pytest.raises(ValueError, match='unsafe link'):
            _check_safe_members(tar.getmembers())


def test_restore_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        restore_backup(tmp_path / 'nope.tar.gz')


# ---- full round-trip (DB + working dir) ----

@pytest.mark.django_db
def test_create_restore_roundtrip(workdir, backupdir):
    from dcim.models import Location, Site
    from netbox_facilitymap.models import FacilityMapBlob, Room

    site = Site.objects.create(name='S', slug='s')
    floor = Location.objects.create(name='F', slug='f', site=site)
    room_loc = Location.objects.create(name='R', slug='r', site=site, parent=floor)
    Room.objects.create(floor_key='s/f', room_id='r1', label='R1', location=room_loc)
    FacilityMapBlob.objects.create(kind='siteplan', data={'hotspots': [{'x': 1}]})

    img = workdir / 'images' / 's' / 'Ff.png'
    img.parent.mkdir(parents=True)
    img.write_bytes(b'PNGDATA')

    path, _ = create_backup(stamp='20200101-000000')
    assert path.name == 'facilitymap-backup-20200101-000000.tar.gz'
    assert path.is_file()

    # Destroy everything the backup should be able to bring back.
    Room.objects.all().delete()
    FacilityMapBlob.objects.all().delete()
    img.unlink()

    result = restore_backup(path)

    assert result == {'blobs': 1, 'rooms': 1, 'workdir': True}
    assert Room.objects.get(room_id='r1').location_id == room_loc.pk
    assert FacilityMapBlob.objects.get(kind='siteplan').data == {'hotspots': [{'x': 1}]}
    assert img.read_bytes() == b'PNGDATA'


@pytest.mark.django_db
def test_backup_skips_transient_workdir_entries(workdir, backupdir):
    # The import lock and preview cache are regenerable — they must not be archived.
    (workdir / 'uploads' / '.thumbs' / 'A').mkdir(parents=True)
    (workdir / 'uploads' / '.thumbs' / 'A' / 'g.full.png').write_bytes(b'CACHE')
    (workdir / '.import.lock').write_bytes(b'')
    (workdir / 'images').mkdir()
    (workdir / 'images' / 'keep.png').write_bytes(b'KEEP')

    path, _ = create_backup(stamp='20200101-000001')

    with tarfile.open(path) as tar:
        names = tar.getnames()
    assert 'workdir/images/keep.png' in names
    assert not any('.thumbs' in n for n in names)
    assert not any(n.endswith('.import.lock') for n in names)
