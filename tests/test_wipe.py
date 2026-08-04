"""Tier C — `wipe.wipe_data`: the full plugin data wipe (HEALTH-12).

A wipe is irreversible, so what it *doesn't* delete matters as much as what it does. These tests
pin both halves: the blank-slate wipe really clears DB rows + working dir, the scoped wipe stays
inside its facility (most importantly, wiping the **default** facility must not take the sibling
facility subfolders that share its flat root), and neither one touches NetBox's own data or the
backup archives that are the only way back.
"""

import pytest

from netbox_facilitymap import wipe
from netbox_facilitymap.models import FacilityMapBlob, Room, RoomTodo
from netbox_facilitymap.render_runner import RenderRunner


def _sitegroup(slug):
    from dcim.models import SiteGroup
    return SiteGroup.objects.create(name=slug, slug=slug)


def _site(slug, group=None):
    from dcim.models import Site
    return Site.objects.create(name=slug, slug=slug, group=group)


def _floor_files(base):
    """Write the artifacts a rendered facility leaves in `base` (a working dir or a subfolder)."""
    base.mkdir(parents=True, exist_ok=True)
    (base / 'manifest.json').write_text('{"siteplan": null, "buildings": []}')
    (base / 'import-map.json').write_text('{}')
    for sub in ('images', 'uploads'):
        (base / sub).mkdir(exist_ok=True)
        (base / sub / 'f.png').write_bytes(b'PNG')


def _room(floor_key='s/f', room_id='r1'):
    return Room.objects.create(floor_key=floor_key, room_id=room_id, label=room_id,
                               polygon=[[0, 0], [1, 0], [1, 1]])


# ---- the blank slate (`facility=None`) ----

@pytest.mark.django_db
def test_wipe_all_clears_rows_and_the_working_dir(workdir):
    _site('s')
    FacilityMapBlob.objects.create(kind='annotations', facility='', key='s/f', data={'a': 1})
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={'room_embed_zoom': 3})
    room = _room()
    RoomTodo.objects.create(room=room, text='fix it')
    _floor_files(workdir)

    summary = wipe.wipe_data()

    assert not FacilityMapBlob.objects.exists()
    assert not Room.objects.exists()
    assert not RoomTodo.objects.exists()
    assert not (workdir / 'manifest.json').exists()
    assert not (workdir / 'images').exists()
    assert not (workdir / 'uploads').exists()
    assert summary['blobs'] == 2 and summary['rooms'] == 1 and summary['todos'] == 1
    assert summary['workdir'] is True


@pytest.mark.django_db
def test_wipe_all_removes_the_install_wide_settings_row(workdir):
    # The blank slate is literal: the install-wide `settings`/`facility_map` rows go too, so a
    # wiped install reads exactly like a fresh one rather than a re-configured one.
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={'todos': True})
    FacilityMapBlob.objects.create(kind='facility_map', facility='', key='', data={'s': 'west'})

    wipe.wipe_data()

    assert not FacilityMapBlob.objects.exists()


@pytest.mark.django_db
def test_wipe_all_clears_every_facility_subfolder(workdir):
    # The root holds the default facility's files *and* every other facility's subfolder (MULTI-2);
    # the unscoped wipe takes the lot.
    _floor_files(workdir)
    _floor_files(workdir / 'west')
    _floor_files(workdir / 'east')

    wipe.wipe_data()

    assert not (workdir / 'west').exists()
    assert not (workdir / 'east').exists()
    assert not (workdir / 'manifest.json').exists()


@pytest.mark.django_db
def test_wipe_all_leaves_netbox_data_alone(workdir):
    # The whole point of the feature: plugin data only. A wipe that cascaded into dcim would be
    # catastrophic and silent.
    from dcim.models import Location, Site
    site = _site('s')
    floor = Location.objects.create(name='F', slug='f', site=site)
    room_loc = Location.objects.create(name='R', slug='r', site=site, parent=floor)
    Room.objects.create(floor_key='s/f', room_id='r1', label='R1', location=room_loc,
                        polygon=[[0, 0], [1, 0], [1, 1]])

    wipe.wipe_data()

    assert not Room.objects.exists()
    assert Site.objects.filter(slug='s').exists()
    assert Location.objects.filter(slug='f').exists()
    assert Location.objects.filter(slug='r').exists()


@pytest.mark.django_db
def test_wipe_keeps_backup_archives(workdir, backupdir):
    # The archives live outside the working dir precisely so a destructive op can't take the safety
    # net with it — and a wipe is the op that most needs one to survive.
    from netbox_facilitymap.backup import create_backup
    FacilityMapBlob.objects.create(kind='annotations', facility='', key='s/f', data={'a': 1})
    _floor_files(workdir)
    archive, _ = create_backup()

    wipe.wipe_data()

    assert archive.is_file()
    assert not FacilityMapBlob.objects.exists()


@pytest.mark.django_db
def test_wipe_all_on_an_empty_install_is_a_no_op(workdir):
    # Idempotent: re-running after a wipe (or running on a fresh install) reports nothing and
    # raises nothing.
    summary = wipe.wipe_data()
    assert summary['blobs'] == 0 and summary['rooms'] == 0 and summary['todos'] == 0


# ---- the scoped wipe (`facility=<slug>`) ----

@pytest.mark.django_db
def test_wipe_default_facility_keeps_sibling_facility_subfolders(workdir):
    # THE trap: the default facility's work_dir IS the flat root that holds every other facility's
    # subfolder, so its wipe must remove its own artifacts *by name* and never the tree.
    _floor_files(workdir)
    _floor_files(workdir / 'west')

    wipe.wipe_data('')

    assert not (workdir / 'manifest.json').exists()
    assert not (workdir / 'images').exists()
    assert (workdir / 'west' / 'manifest.json').exists()
    assert (workdir / 'west' / 'images' / 'f.png').exists()


@pytest.mark.django_db
def test_wipe_named_facility_takes_only_its_own_subfolder(workdir):
    _floor_files(workdir)
    _floor_files(workdir / 'west')
    _floor_files(workdir / 'east')

    wipe.wipe_data('west')

    assert not (workdir / 'west').exists()
    assert (workdir / 'east' / 'manifest.json').exists()
    assert (workdir / 'manifest.json').exists()


@pytest.mark.django_db
def test_wipe_facility_keeps_other_facilities_rows_and_install_settings(workdir):
    west, east = _sitegroup('west'), _sitegroup('east')
    _site('w', group=west)
    _site('e', group=east)
    FacilityMapBlob.objects.create(kind='annotations', facility='west', key='w/f', data={'a': 1})
    FacilityMapBlob.objects.create(kind='annotations', facility='east', key='e/f', data={'a': 2})
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={'todos': True})
    _room(floor_key='w/f', room_id='rw')
    _room(floor_key='e/f', room_id='re')

    summary = wipe.wipe_data('west')

    assert not FacilityMapBlob.objects.filter(facility='west').exists()
    assert FacilityMapBlob.objects.filter(facility='east').exists()
    # The install-wide settings row lives at facility='' but belongs to the install, not to any one
    # facility — only the unscoped wipe removes it.
    assert FacilityMapBlob.objects.filter(kind='settings').exists()
    assert not Room.objects.filter(room_id='rw').exists()
    assert Room.objects.filter(room_id='re').exists()
    assert summary['blobs'] == 1 and summary['rooms'] == 1


@pytest.mark.django_db
def test_wipe_rejects_a_traversal_facility(workdir):
    # `valid_facility` is the one gate between an externally-supplied slug and a directory name;
    # a wipe is the last place to let one through.
    with pytest.raises(ValueError):
        wipe.wipe_data('../../etc')
    assert workdir.exists()


# ---- the render lock ----

@pytest.mark.django_db
def test_wipe_refuses_while_a_render_holds_the_lock(workdir):
    # Deleting uploads/images beneath a live render subprocess strands a half-rendered facility, so
    # the wipe takes every affected facility's lock — and changes nothing when it can't.
    FacilityMapBlob.objects.create(kind='annotations', facility='', key='s/f', data={'a': 1})
    _floor_files(workdir)
    (workdir / RenderRunner.LOCK_NAME).touch()

    with pytest.raises(wipe.WipeBusyError):
        wipe.wipe_data()

    assert FacilityMapBlob.objects.exists()
    assert (workdir / 'manifest.json').exists()


@pytest.mark.django_db
def test_wipe_releases_locks_it_acquired_when_another_is_busy(workdir):
    # A partial acquire must unwind: the default facility's lock is taken first (sorted order), so
    # a busy 'west' has to leave the root lock released, not stranded for the stale-lock timeout.
    _floor_files(workdir)
    _floor_files(workdir / 'west')
    (workdir / 'west' / RenderRunner.LOCK_NAME).touch()

    with pytest.raises(wipe.WipeBusyError):
        wipe.wipe_data()

    assert not (workdir / RenderRunner.LOCK_NAME).exists()


@pytest.mark.django_db
def test_wipe_keeps_the_lockfile_it_holds(workdir):
    # Mirrors the reset invariant: the wipe *holds* the root lock rather than deleting it as a
    # cleanup step, and `hold_lock` releases it on the way out.
    _floor_files(workdir)

    wipe.wipe_data()

    assert not (workdir / RenderRunner.LOCK_NAME).exists()
    assert not (workdir / 'images').exists()


@pytest.mark.django_db
def test_wipe_all_survives_a_blob_row_with_a_bogus_facility(workdir):
    # `facility` reaching us from a hand-edited / REST-written row need not be a valid slug. Such a
    # row never had a working dir, so there is no lock to take — but raising out of the lock loop
    # would fail the whole wipe over a row the unscoped delete is about to remove anyway.
    FacilityMapBlob.objects.create(kind='annotations', facility='../evil', key='s/f', data={})
    _floor_files(workdir)

    wipe.wipe_data()

    assert not FacilityMapBlob.objects.exists()
    assert not (workdir / 'images').exists()
