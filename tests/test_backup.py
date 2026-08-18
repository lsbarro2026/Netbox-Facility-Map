"""Tier C — `backup.create_backup`/`restore_backup`: the create→restore round-trip (DB rows +
working-dir files) and the `_check_safe_members` archive traversal guard.

The traversal-guard tests need neither a database nor a working dir, so they aren't marked
`django_db`; the round-trip is DB-backed and filesystem-backed."""

import io
import tarfile
from datetime import date

import pytest

from netbox_facilitymap.backup import _check_safe_members, create_backup, restore_backup


# ---- archive traversal guard (no DB) ----

def _tar_with(path, *infos):
    """Write a tar holding `infos` (a `TarInfo`, or a `(TarInfo, bytes)` pair) and return its
    members read back — the shape `_check_safe_members` is handed by `restore_backup`."""
    with tarfile.open(path, 'w') as tar:
        for info in infos:
            info, payload = info if isinstance(info, tuple) else (info, b'')
            info.size = len(payload)
            tar.addfile(info, io.BytesIO(payload))
    with tarfile.open(path) as tar:
        return tar.getmembers()


def test_check_safe_members_accepts_a_normal_archive(tmp_path):
    # The positive control the negatives below are only meaningful against: the exact member shape
    # `create_backup` writes passes the guard untouched.
    members = _tar_with(tmp_path / 'ok.tar',
                        (tarfile.TarInfo('db.json'), b'[]'),
                        (tarfile.TarInfo('bindings.json'), b'{}'),
                        (tarfile.TarInfo('workdir/images/s/f.png'), b'PNG'))
    assert _check_safe_members(members) is None


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


def test_check_safe_members_rejects_nested_parent_escape(tmp_path):
    # The escape doesn't have to lead: a `..` anywhere in the path still climbs out of the
    # extraction dir, and a plausible-looking `workdir/` prefix is exactly how it would be hidden.
    members = _tar_with(tmp_path / 'nested.tar', tarfile.TarInfo('workdir/../../evil'))
    with pytest.raises(ValueError, match='unsafe path'):
        _check_safe_members(members)


def test_check_safe_members_rejects_hardlink(tmp_path):
    # A hardlink escapes the same way a symlink does — the guard rejects both link types.
    info = tarfile.TarInfo('evil')
    info.type = tarfile.LNKTYPE
    info.linkname = '/etc/passwd'
    with pytest.raises(ValueError, match='unsafe link'):
        _check_safe_members(_tar_with(tmp_path / 'hard.tar', info))


def test_restore_rejects_a_traversal_archive_before_extracting_anything(tmp_path, workdir):
    # End-to-end, not just the helper: `restore_backup` validates every member up front, so a
    # crafted archive is refused before a single byte is written and the live working dir survives.
    archive = tmp_path / 'evil.tar.gz'
    payload = b'OWNED'
    with tarfile.open(archive, 'w:gz') as tar:
        for name in ('db.json', '../escaped.txt'):
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            tar.addfile(info, io.BytesIO(payload))
    (workdir / 'manifest.json').write_text('{"siteplan": null, "buildings": ["keep"]}')

    with pytest.raises(ValueError, match='unsafe path'):
        restore_backup(archive)

    assert '"keep"' in (workdir / 'manifest.json').read_text()   # the facility is untouched
    assert not (tmp_path / 'escaped.txt').exists()


def test_restore_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        restore_backup(tmp_path / 'nope.tar.gz')


# ---- full round-trip (DB + working dir) ----

@pytest.mark.django_db
def test_create_restore_roundtrip(workdir, backupdir):
    from dcim.models import Location, Site
    from netbox_facilitymap.models import FacilityMapBlob, Room, RoomTodo

    site = Site.objects.create(name='S', slug='s')
    floor = Location.objects.create(name='F', slug='f', site=site)
    room_loc = Location.objects.create(name='R', slug='r', site=site, parent=floor)
    room = Room.objects.create(floor_key='s/f', room_id='r1', label='R1', location=room_loc)
    todo = RoomTodo.objects.create(room=room, text='fix the rack', status='in_progress',
                                   priority='high', notes='after hours', due=date(2026, 8, 1))
    # A to-do's assignees ride the archive as an M2M — Django's serializer carries the through-table
    # rows, so the restore must bring the assignment back, not just the row it hangs off.
    from utilities.testing import create_test_user
    todo.assignees.set([create_test_user('backup-alice')])
    FacilityMapBlob.objects.create(kind='siteplan', data={'hotspots': [{'x': 1}]})

    img = workdir / 'images' / 's' / 'Ff.png'
    img.parent.mkdir(parents=True)
    img.write_bytes(b'PNGDATA')

    path, _ = create_backup(stamp='20200101-000000')
    assert path.name == 'facilitymap-backup-20200101-000000.tar.gz'
    assert path.is_file()

    # Destroy everything the backup should be able to bring back (deleting rooms also cascades the
    # to-do away, so the restore must re-create it from the archive).
    Room.objects.all().delete()
    FacilityMapBlob.objects.all().delete()
    img.unlink()

    result = restore_backup(path)

    assert result == {'blobs': 1, 'rooms': 1, 'todos': 1, 'workdir': True, 'unresolved': [],
                      'dropped_assignees': []}
    assert Room.objects.get(room_id='r1').location_id == room_loc.pk
    restored_todo = RoomTodo.objects.get()
    assert restored_todo.text == 'fix the rack'
    assert restored_todo.priority == 'high'
    assert restored_todo.due == date(2026, 8, 1)
    assert list(restored_todo.assignees.values_list('username', flat=True)) == ['backup-alice']
    assert FacilityMapBlob.objects.get(kind='siteplan').data == {'hotspots': [{'x': 1}]}
    assert img.read_bytes() == b'PNGDATA'


@pytest.mark.django_db
def test_create_restore_roundtrip_covers_every_blob_kind(workdir, backupdir):
    """`_dump_db()` dumps `FacilityMapBlob.objects.all()` with no `kind` filter, so every kind
    should already round-trip; `test_create_restore_roundtrip` above only ever exercised a
    single `siteplan` blob. This is the regression test that actually proves the rest (BAK-3)."""
    from netbox_facilitymap.models import FacilityMapBlob

    payloads = {
        'annotations': {'image': 'floor.png', 'w': 1000, 'h': 800,
                        'arrows': [{'x1': 0.1, 'y1': 0.2, 'x2': 0.3, 'y2': 0.4, 'color': '#066fd1'}]},
        'siteplan': {'hotspots': [{'x': 0.5, 'y': 0.5, 'building': 'b1'}]},
        'placements': {'placements': [{'id': 'p1', 'kind': 'device', 'x': 0.2, 'y': 0.3, 'role': 'ap'}]},
        'layouts': {'sheets': [{'w': 1000, 'h': 800, 'cols': 2, 'rows': 1}]},
        'settings': {'device_presets': [{
            'key': 'access-point', 'label': 'Access point', 'device_role': 5, 'icon': 'ap',
            'name_template': '{room}-{role_short}-{asset_tag}', 'count_scope': 'floor',
            'enabled': True, 'fields': ['asset_tag'],
        }]},
        'facility_map': {'site-a': 'campus-x', 'site-b': 'campus-y'},
    }
    # Keeps this test honest if a kind is ever added to KIND_CHOICES without updating it here.
    assert set(payloads) == {kind for kind, _ in FacilityMapBlob.KIND_CHOICES}

    for kind, data in payloads.items():
        FacilityMapBlob.objects.create(kind=kind, data=data)

    path, _ = create_backup(stamp='20200101-000030')
    FacilityMapBlob.objects.all().delete()

    result = restore_backup(path)

    assert result['blobs'] == len(payloads)
    for kind, data in payloads.items():
        assert FacilityMapBlob.objects.get(kind=kind).data == data


@pytest.mark.django_db
def test_restore_swaps_the_working_dir_after_the_transaction(workdir, backupdir, monkeypatch):
    """The swap deletes the previous working dir irreversibly, so it must run **outside**
    `restore_backup`'s transaction (QUAL-5): inside it, a rollback would restore the rows while the
    files stayed the archive's, with the old tree already gone. `connection.in_atomic_block` can't
    express that here — a `django_db` test is itself wrapped in a transaction, so it reads True
    either way. Savepoint *depth* can: `restore_backup`'s own `atomic()` pushes one savepoint, so a
    swap left inside it records depth + 1 rather than the depth measured around the call."""
    from django.db import connection
    from netbox_facilitymap import backup as backup_module
    from netbox_facilitymap.models import FacilityMapBlob

    FacilityMapBlob.objects.create(kind='siteplan', data={'hotspots': []})
    (workdir / 'images').mkdir()
    (workdir / 'images' / 'f.png').write_bytes(b'PNGDATA')
    path, _ = create_backup(stamp='20200101-000001')

    real_swap = backup_module._restore_workdir
    depth_at_swap = []

    def probe(tar, members):
        depth_at_swap.append(len(connection.savepoint_ids))
        return real_swap(tar, members)

    monkeypatch.setattr(backup_module, '_restore_workdir', probe)
    depth_outside_the_transaction = len(connection.savepoint_ids)

    assert restore_backup(path)['workdir'] is True
    assert depth_at_swap == [depth_outside_the_transaction]


# ---- portable slug bindings + migration safety (BAK-1) ----

@pytest.mark.django_db
def test_restore_rebinds_by_slug_onto_new_location_pks(workdir, backupdir):
    """Migration: an archive restores onto Locations that share the backup's slugs but have brand-new
    DB pks — the room must re-bind by slug, never by the (now-stale) stored pk."""
    from dcim.models import Location, Site
    from netbox_facilitymap.models import FacilityMapBlob, Room

    site = Site.objects.create(name='S', slug='s')
    floor = Location.objects.create(name='F', slug='f', site=site)
    room_loc = Location.objects.create(name='R', slug='r', site=site, parent=floor)
    Room.objects.create(floor_key='s/f', room_id='r1', label='R1',
                        location=room_loc, floor_location=floor)

    path, _ = create_backup(stamp='20200101-000010')
    old_floor_pk, old_room_pk = floor.pk, room_loc.pk

    # Simulate a migration target: same slugs, fresh Location pks (delete child before parent).
    Room.objects.all().delete()
    FacilityMapBlob.objects.all().delete()
    room_loc.delete()
    floor.delete()
    new_floor = Location.objects.create(name='F', slug='f', site=site)
    new_room_loc = Location.objects.create(name='R', slug='r', site=site, parent=new_floor)
    assert new_floor.pk != old_floor_pk and new_room_loc.pk != old_room_pk

    result = restore_backup(path)

    assert result['unresolved'] == []
    r = Room.objects.get(room_id='r1')
    assert r.location_id == new_room_loc.pk       # rebound to the new pk, not the archived one
    assert r.floor_location_id == new_floor.pk


@pytest.mark.django_db
def test_restore_rebinds_by_full_ancestor_path_not_bare_slug(workdir, backupdir):
    """Location slugs are unique only per `(site, parent, slug)`, so two floors can each hold a room
    Location called `r`. The whole reason `_location_portable_key` stores the ancestor *path* is that
    a bare-slug lookup would silently bind the room to the wrong floor's namesake."""
    from dcim.models import Location, Site
    from netbox_facilitymap.models import FacilityMapBlob, Room

    site = Site.objects.create(name='S', slug='s')
    floor1 = Location.objects.create(name='F1', slug='f1', site=site)
    floor2 = Location.objects.create(name='F2', slug='f2', site=site)
    Location.objects.create(name='R', slug='r', site=site, parent=floor1)
    room_loc2 = Location.objects.create(name='R', slug='r', site=site, parent=floor2)
    Room.objects.create(floor_key='s/f2', room_id='r1', label='R1',
                        location=room_loc2, floor_location=floor2)

    path, _ = create_backup(stamp='20200101-000020')

    # Rebuild the same tree with fresh pks so a pk replay can't accidentally pass, and re-create
    # floor1's namesake FIRST — a bare-slug lookup would return that one.
    Room.objects.all().delete()
    FacilityMapBlob.objects.all().delete()
    Location.objects.filter(parent__isnull=False).delete()
    floor1.delete()
    floor2.delete()
    new_floor1 = Location.objects.create(name='F1', slug='f1', site=site)
    decoy = Location.objects.create(name='R', slug='r', site=site, parent=new_floor1)
    new_floor2 = Location.objects.create(name='F2', slug='f2', site=site)
    new_room_loc2 = Location.objects.create(name='R', slug='r', site=site, parent=new_floor2)

    result = restore_backup(path)

    assert result['unresolved'] == []
    r = Room.objects.get(room_id='r1')
    assert r.location_id == new_room_loc2.pk    # the path resolved to floor2's `r`…
    assert r.location_id != decoy.pk            # …not floor1's identically-slugged one
    assert r.floor_location_id == new_floor2.pk


@pytest.mark.django_db
def test_restore_does_not_bind_a_matching_path_under_a_different_site(workdir, backupdir):
    """The portable key is site-anchored: an identical ancestor path living under some *other* Site
    is not a match. It reports unresolved rather than binding a room into the wrong facility."""
    from dcim.models import Location, Site
    from netbox_facilitymap.backup import RestoreUnresolvedError
    from netbox_facilitymap.models import FacilityMapBlob, Room

    site = Site.objects.create(name='S', slug='s')
    floor = Location.objects.create(name='F', slug='f', site=site)
    room_loc = Location.objects.create(name='R', slug='r', site=site, parent=floor)
    Room.objects.create(floor_key='s/f', room_id='r1', label='R1',
                        location=room_loc, floor_location=floor)

    path, _ = create_backup(stamp='20200101-000021')

    # Drop only the room Location, and stand up an identically-slugged `f/r` under a *different*
    # Site. The floor still resolves under `s`, so the sole unresolved binding below is the room's —
    # proving the decoy was rejected on its Site, not merely missed for some other reason.
    Room.objects.all().delete()
    FacilityMapBlob.objects.all().delete()
    room_loc.delete()
    other = Site.objects.create(name='Other', slug='other')
    other_floor = Location.objects.create(name='F', slug='f', site=other)
    Location.objects.create(name='R', slug='r', site=other, parent=other_floor)

    with pytest.raises(RestoreUnresolvedError) as exc:
        restore_backup(path)
    assert exc.value.unresolved == [
        "room 's/f/r1': bound Location 's/f/r' has no match on this instance"]
    assert not Room.objects.exists()   # aborted before any write, as always


@pytest.mark.django_db
def test_restore_aborts_when_the_floor_binding_cannot_resolve(workdir, backupdir):
    """The other half of `_resolve_room_bindings`: `floor_location` re-derives from the portable
    `floor_key`, so a floor Location missing on the target aborts too — even for a room that was
    never bound to a room Location at all."""
    from dcim.models import Location, Site
    from netbox_facilitymap.backup import RestoreUnresolvedError
    from netbox_facilitymap.models import FacilityMapBlob, Room

    site = Site.objects.create(name='S', slug='s')
    floor = Location.objects.create(name='F', slug='f', site=site)
    Room.objects.create(floor_key='s/f', room_id='r1', label='R1', floor_location=floor)

    path, _ = create_backup(stamp='20200101-000022')

    Room.objects.all().delete()
    FacilityMapBlob.objects.all().delete()
    floor.delete()

    with pytest.raises(RestoreUnresolvedError) as exc:
        restore_backup(path)
    assert "floor 's/f' has no matching Site + Location" in str(exc.value)


@pytest.mark.django_db
def test_restore_aborts_without_wiping_when_binding_unresolved(workdir, backupdir):
    """Safety: a binding that can't be re-resolved on the target aborts the restore *before* any
    delete — pre-existing data must survive untouched."""
    from dcim.models import Location, Site
    from netbox_facilitymap.backup import RestoreUnresolvedError
    from netbox_facilitymap.models import FacilityMapBlob, Room

    site = Site.objects.create(name='S', slug='s')
    floor = Location.objects.create(name='F', slug='f', site=site)
    room_loc = Location.objects.create(name='R', slug='r', site=site, parent=floor)
    Room.objects.create(floor_key='s/f', room_id='r1', label='R1',
                        location=room_loc, floor_location=floor)

    path, _ = create_backup(stamp='20200101-000011')

    # Drop the room Location so its slug path no longer resolves, and seed *different* live data the
    # abort must leave in place.
    Room.objects.all().delete()
    FacilityMapBlob.objects.all().delete()
    room_loc.delete()
    survivor_room = Room.objects.create(floor_key='s/f', room_id='keep', label='KEEP')
    survivor_blob = FacilityMapBlob.objects.create(kind='siteplan', data={'x': 1})

    with pytest.raises(RestoreUnresolvedError) as exc:
        restore_backup(path)
    assert 's/f/r1' in str(exc.value)
    # Nothing was deleted — the pre-existing rows survive.
    assert Room.objects.filter(pk=survivor_room.pk).exists()
    assert FacilityMapBlob.objects.filter(pk=survivor_blob.pk).exists()


@pytest.mark.django_db
def test_restore_allow_unresolved_leaves_room_unbound(workdir, backupdir):
    """`allow_unresolved=True` proceeds despite an unresolvable binding, restoring the room unbound
    and reporting it — the escape hatch for an intentional restructure."""
    from dcim.models import Location, Site
    from netbox_facilitymap.models import FacilityMapBlob, Room

    site = Site.objects.create(name='S', slug='s')
    floor = Location.objects.create(name='F', slug='f', site=site)
    room_loc = Location.objects.create(name='R', slug='r', site=site, parent=floor)
    Room.objects.create(floor_key='s/f', room_id='r1', label='R1',
                        location=room_loc, floor_location=floor)

    path, _ = create_backup(stamp='20200101-000012')
    Room.objects.all().delete()
    FacilityMapBlob.objects.all().delete()
    room_loc.delete()

    result = restore_backup(path, allow_unresolved=True)

    assert result['rooms'] == 1
    assert len(result['unresolved']) == 1
    r = Room.objects.get(room_id='r1')
    assert r.location_id is None            # left unbound (its Location was gone)
    assert r.floor_location_id == floor.pk  # floor still resolved


@pytest.mark.django_db
def test_restore_reresolves_assignees_by_username_across_instances(workdir, backupdir):
    """Migration (BAK-2): a to-do's assignees restore onto users that share the backup's usernames but
    have brand-new DB pks — resolved by username, never the stale archived pk — and an assignee whose
    username has no match on the target is soft-dropped and reported, not aborted."""
    from dcim.models import Location, Site
    from utilities.testing import create_test_user
    from netbox_facilitymap.models import FacilityMapBlob, Room, RoomTodo

    site = Site.objects.create(name='S', slug='s')
    floor = Location.objects.create(name='F', slug='f', site=site)
    room_loc = Location.objects.create(name='R', slug='r', site=site, parent=floor)
    room = Room.objects.create(floor_key='s/f', room_id='r1', label='R1',
                               location=room_loc, floor_location=floor)
    todo = RoomTodo.objects.create(room=room, text='fix the rack')
    alice = create_test_user('alice')
    bob = create_test_user('bob')
    todo.assignees.set([alice, bob])
    old_alice_pk = alice.pk

    path, _ = create_backup(stamp='20200101-000013')

    # Simulate a migration target: same room Locations (so the room binding resolves), but 'alice' is
    # recreated with a fresh pk and 'bob' is gone entirely.
    Room.objects.all().delete()
    FacilityMapBlob.objects.all().delete()
    alice.delete()
    bob.delete()
    new_alice = create_test_user('alice')
    assert new_alice.pk != old_alice_pk

    result = restore_backup(path)

    assert result['unresolved'] == []
    restored = RoomTodo.objects.get()
    # Re-bound to the *new* alice pk by username; bob (no match) soft-dropped, never replayed by pk.
    assert list(restored.assignees.values_list('pk', flat=True)) == [new_alice.pk]
    assert len(result['dropped_assignees']) == 1
    assert "'bob'" in result['dropped_assignees'][0]


@pytest.mark.django_db
def test_restore_legacy_archive_without_bindings_replays_pks(workdir, backupdir, tmp_path):
    """A pre-BAK-1 archive (db.json only, no bindings.json) restores via the legacy pk-replay path —
    same-instance, exactly as before the portable-bindings change."""
    from django.core import serializers
    from dcim.models import Location, Site
    from netbox_facilitymap.models import FacilityMapBlob, Room

    site = Site.objects.create(name='S', slug='s')
    floor = Location.objects.create(name='F', slug='f', site=site)
    room_loc = Location.objects.create(name='R', slug='r', site=site, parent=floor)
    Room.objects.create(floor_key='s/f', room_id='r1', label='R1',
                        location=room_loc, floor_location=floor)

    db_bytes = serializers.serialize(
        'json', list(FacilityMapBlob.objects.all()) + list(Room.objects.all())).encode('utf-8')
    legacy = tmp_path / 'legacy.tar.gz'
    with tarfile.open(legacy, 'w:gz') as tar:
        info = tarfile.TarInfo('db.json')
        info.size = len(db_bytes)
        tar.addfile(info, io.BytesIO(db_bytes))

    Room.objects.all().delete()

    result = restore_backup(legacy)

    assert result['unresolved'] == []
    assert Room.objects.get(room_id='r1').location_id == room_loc.pk  # stored pk replayed verbatim


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
