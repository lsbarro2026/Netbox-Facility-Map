"""Tier C — the management-command CLI entry points, driven via `call_command`.

The commands are thin wrappers whose real work lives in shared modules (`backup.py`, `wipe.py`,
`frontend_api`), tested there directly. This file covers the CLI plumbing those tests don't: arg
parsing, the confirmation prompt, `CommandError` on bad input, and the success messages. The
remaining command, `facilitymap_check`, is already driven directly in `test_health.py`
(`test_command_exit_{zero_when_clean,one_on_drift}`), so it isn't repeated here."""

import json
from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

pytestmark = pytest.mark.django_db


# ---- facilitymap_backup ----

def test_backup_writes_an_archive_and_reports_the_path(workdir, backupdir):
    from netbox_facilitymap.models import FacilityMapBlob
    FacilityMapBlob.objects.create(kind='siteplan', data={'hotspots': []})

    out = StringIO()
    call_command('facilitymap_backup', stdout=out)

    archives = list(backupdir.glob('facilitymap-backup-*.tar.gz'))
    assert len(archives) == 1
    assert f'wrote {archives[0]}' in out.getvalue()


# ---- facilitymap_import ----

def _legacy_export(tmp_path):
    """A minimal legacy tool export dir: one blob-kind file plus an annotations doc (decomposed
    into a Room row + the room-less annotations blob)."""
    src = tmp_path / 'export'
    src.mkdir()
    (src / 'siteplan.json').write_text(json.dumps({'hotspots': [{'x': 1}]}))
    (src / 'annotations.json').write_text(json.dumps({
        'site-a/floor-1': {'image': 'f.png', 'w': 100, 'h': 100, 'arrows': [],
                           'rooms': [{'id': 'r1', 'label': 'R1', 'points': [[0, 0], [1, 0], [1, 1]]}]},
    }))
    return src


def test_import_creates_blobs_and_rooms_from_a_legacy_export(tmp_path):
    from netbox_facilitymap.models import FacilityMapBlob, Room

    out = StringIO()
    call_command('facilitymap_import', '--src', str(_legacy_export(tmp_path)), stdout=out)

    assert FacilityMapBlob.objects.get(kind='siteplan').data == {'hotspots': [{'x': 1}]}
    assert FacilityMapBlob.objects.filter(kind='annotations').exists()
    assert Room.objects.filter(floor_key='site-a/floor-1', room_id='r1').exists()


def test_import_rejects_a_non_directory_src(tmp_path):
    missing = tmp_path / 'nope'
    with pytest.raises(CommandError, match='not a directory'):
        call_command('facilitymap_import', '--src', str(missing))


def test_import_rejects_invalid_json(tmp_path):
    src = tmp_path / 'export'
    src.mkdir()
    (src / 'siteplan.json').write_text('{not valid json')
    with pytest.raises(CommandError, match='invalid JSON'):
        call_command('facilitymap_import', '--src', str(src))


# ---- facilitymap_restore ----

def test_restore_round_trips_a_backup_with_noinput(workdir, backupdir):
    from netbox_facilitymap.models import FacilityMapBlob, Room

    FacilityMapBlob.objects.create(kind='siteplan', data={'k': 'v'})
    Room.objects.create(floor_key='s/f', room_id='r1', label='R1')
    call_command('facilitymap_backup', stdout=StringIO())
    (archive,) = backupdir.glob('facilitymap-backup-*.tar.gz')

    # Wipe everything the backup should bring back, then restore unattended.
    FacilityMapBlob.objects.all().delete()
    Room.objects.all().delete()

    out = StringIO()
    call_command('facilitymap_restore', '--src', str(archive), '--noinput', stdout=out)

    assert 'restored' in out.getvalue()
    assert FacilityMapBlob.objects.get(kind='siteplan').data == {'k': 'v'}
    assert Room.objects.filter(room_id='r1').exists()


def test_restore_rejects_a_missing_archive(tmp_path):
    with pytest.raises(CommandError):
        call_command('facilitymap_restore', '--src', str(tmp_path / 'nope.tar.gz'), '--noinput')


def test_restore_aborts_when_the_prompt_is_declined(workdir, backupdir, monkeypatch):
    from netbox_facilitymap.models import FacilityMapBlob

    FacilityMapBlob.objects.create(kind='siteplan', data={'k': 'v'})
    call_command('facilitymap_backup', stdout=StringIO())
    (archive,) = backupdir.glob('facilitymap-backup-*.tar.gz')

    # Without --noinput the command prompts; a non-"yes" answer aborts before touching anything.
    monkeypatch.setattr('builtins.input', lambda *a: 'no')
    with pytest.raises(CommandError, match='aborted'):
        call_command('facilitymap_restore', '--src', str(archive), stdout=StringIO())

    assert FacilityMapBlob.objects.filter(kind='siteplan').exists()   # nothing was wiped


# ---- facilitymap_wipe ----

def test_wipe_all_reports_what_it_deleted(workdir):
    from netbox_facilitymap.models import FacilityMapBlob
    FacilityMapBlob.objects.create(kind='siteplan', data={'hotspots': []})
    (workdir / 'images').mkdir(parents=True)

    out = StringIO()
    call_command('facilitymap_wipe', '--all', '--noinput', stdout=out)

    assert not FacilityMapBlob.objects.exists()
    assert 'wiped 1 blob(s)' in out.getvalue()
    assert 'working dir cleared' in out.getvalue()


def test_wipe_requires_a_scope_flag(workdir):
    """Neither `--all` nor `--facility` means the operator hasn't said what to destroy — argparse's
    required mutually-exclusive group refuses rather than picking a default."""
    from netbox_facilitymap.models import FacilityMapBlob
    FacilityMapBlob.objects.create(kind='siteplan', data={'k': 'v'})

    with pytest.raises(CommandError):
        call_command('facilitymap_wipe', '--noinput', stdout=StringIO())

    assert FacilityMapBlob.objects.exists()


def test_wipe_scoped_to_the_default_facility_is_distinct_from_all(workdir):
    """`--facility ""` is a real scope (the default facility), not an absent flag — so it must
    leave the install-wide settings row that `--all` removes."""
    from netbox_facilitymap.models import FacilityMapBlob
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={'todos': True})
    FacilityMapBlob.objects.create(kind='siteplan', facility='', key='', data={'hotspots': []})

    call_command('facilitymap_wipe', '--facility', '', '--noinput', stdout=StringIO())

    assert FacilityMapBlob.objects.filter(kind='settings').exists()
    assert not FacilityMapBlob.objects.filter(kind='siteplan').exists()


def test_wipe_aborts_when_the_prompt_is_declined(workdir, monkeypatch):
    from netbox_facilitymap.models import FacilityMapBlob
    FacilityMapBlob.objects.create(kind='siteplan', data={'k': 'v'})

    monkeypatch.setattr('builtins.input', lambda *a: 'no')
    with pytest.raises(CommandError, match='aborted'):
        call_command('facilitymap_wipe', '--all', stdout=StringIO())

    assert FacilityMapBlob.objects.filter(kind='siteplan').exists()


def test_wipe_can_take_a_backup_first(workdir, backupdir):
    """`--backup` is the mitigation for an irreversible op: the archive is written *before* the
    delete, and survives it (backups live outside the working dir)."""
    from netbox_facilitymap.models import FacilityMapBlob
    FacilityMapBlob.objects.create(kind='siteplan', data={'hotspots': []})

    call_command('facilitymap_wipe', '--all', '--backup', '--noinput', stdout=StringIO())

    (archive,) = backupdir.glob('facilitymap-backup-*.tar.gz')
    assert archive.is_file()
    assert not FacilityMapBlob.objects.exists()
