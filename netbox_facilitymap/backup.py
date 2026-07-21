"""Plugin-scoped backup & restore — an opt-in, self-contained safety net.

The plugin's data is two things: the `FacilityMapBlob` + `Room` rows in the NetBox Postgres
DB, and the working-dir files (images/manifest/uploaded PDFs) under `MEDIA_ROOT`. A standard
whole-NetBox backup (`pg_dump` + a copy of `MEDIA_ROOT`) already captures both — there is no
built-in NetBox backup, so that is the operator's job. This module is the granular,
no-system-deps alternative for sites that don't run one: it writes a single timestamped
`.tar.gz` holding a Django-serialized `db.json` plus a tar of the working dir, FIFO-prunes the
backup dir to a configurable size cap, and restores either part.

**Portable across instances (BAK-1).** `db.json` serializes room→Location foreign keys as raw DB
pks, meaningless on a *different* NetBox instance. So each archive also carries a `bindings.json`
capturing every bound room's Location by a portable natural key (its `site` slug + ancestor-slug
path), and `restore_backup` **re-resolves** those against the target's live Locations instead of
replaying pks — making restore a real migration path, not just a same-instance rollback. Resolution
runs *before* any delete, so an unresolvable restore aborts without wiping the target. The same
`bindings.json` also carries each to-do's `assignees` by **username** (BAK-2), re-resolved to the
target's live users on restore — a username with no match is soft-dropped and reported, never a
failure, since an unassigned to-do is still a valid job.

Everything here is **opt-in and invisible** until sought: nothing runs unless the
`facilitymap_backup` / `facilitymap_restore` management commands are invoked (e.g. from
operator cron — see README). There is no app-ready hook, no UI, no nav item, and no startup
side effect; the backup dir is created lazily on the first backup run.

Backup files are sensitive user data, so the dir is created `0700` and files `0600`, and they
live **outside** the package tree and **outside** the import-managed working dir — a
`pip install --upgrade` / `collectstatic` / import `build` never touches them. The default
location is `<MEDIA_ROOT>/facilitymap-backups`, which also means a whole-NetBox media backup
sweeps the plugin's own backups up for free; set `backup_dir` to relocate them.

Kept to Django + stdlib (no new runtime deps, no Django-less constraint like `preprocess.py`).
"""

import io
import json
import os
import shutil
import tarfile
import tempfile
from pathlib import Path

from django.conf import settings
from django.core import serializers
from django.db import transaction
from django.utils import timezone

from dcim.models import Location, Site

from netbox.plugins import get_plugin_config

from .models import FacilityMapBlob, Room, RoomTodo
from .storage import work_dir

#: Glob for our artifacts; the timestamp makes a lexical sort chronological.
BACKUP_GLOB = 'facilitymap-backup-*.tar.gz'
#: Members inside each archive.
DB_MEMBER = 'db.json'
#: Portable room→Location slug bindings + to-do assignees (by username), alongside `db.json`
#: (BAK-1/BAK-2). Absent in pre-BAK-1 archives; the `todo_assignees` list is absent in BAK-1 ones.
BINDINGS_MEMBER = 'bindings.json'
WORKDIR_PREFIX = 'workdir'
#: Working-dir entries that are regenerable or transient — excluded from backups.
SKIP_WORKDIR = ('.import.lock', '.thumbs')


def backup_dir():
    """Absolute path to the backup dir. `backup_dir` plugin setting, or, unset,
    `<MEDIA_ROOT>/facilitymap-backups`. Created lazily by `create_backup` — readers must not
    assume it exists."""
    configured = get_plugin_config('netbox_facilitymap', 'backup_dir', default=None)
    if configured:
        return Path(configured)
    return Path(settings.MEDIA_ROOT) / 'facilitymap-backups'


def _max_bytes():
    cap_mb = get_plugin_config('netbox_facilitymap', 'backup_max_mb', default=1024)
    return int(cap_mb) * 1024 * 1024


def _ensure_dir():
    """Create the backup dir (restrictive perms) and return it. `0700` because the files hold
    user data; best-effort `chmod` (no-op / harmless on filesystems that ignore POSIX modes)."""
    d = backup_dir()
    d.mkdir(parents=True, exist_ok=True)
    try:
        d.chmod(0o700)
    except OSError:
        pass
    return d


def _dump_db():
    """Serialize the plugin's rows to a JSON string. Equivalent to `dumpdata` for
    `FacilityMapBlob` + `Room` + `RoomTodo`. Order matters for the re-save on restore: blobs
    first so `Room.location` (a `dcim.Location` FK) exists, then rooms, then their to-dos (whose
    `room` FK must resolve to an already-restored `Room`). `RoomTodo` is user data cascaded off
    `Room`, so it must ride the backup or a restore (which deletes rooms → CASCADE) would drop it."""
    objs = (list(FacilityMapBlob.objects.all())
            + list(Room.objects.all())
            + list(RoomTodo.objects.all()))
    return serializers.serialize('json', objs, indent=2)


def _location_portable_key(loc):
    """A `dcim.Location`'s portable natural key: its `site` slug plus the root→leaf list of ancestor
    slugs (`get_ancestors(include_self=True)`, MPTT-ordered). `None` for a null Location. Location
    slugs are unique only per `(site, parent, slug)`, so the *full* path — not the bare slug —
    identifies the Location; `_resolve_location_path` re-resolves it on the target instance."""
    if loc is None:
        return None
    return {'site': loc.site.slug,
            'path': [a.slug for a in loc.get_ancestors(include_self=True)]}


def _dump_todo_assignees():
    """Portable `RoomTodo.assignees` for restore (BAK-2): one entry per to-do that has assignees
    (`todo_id` + the assignees' **usernames**), so restore can re-resolve them to the target
    instance's live users instead of replaying the archive's instance-specific user pks (which
    Django's stock M2M serialization emits — meaningless on a different NetBox). A to-do is keyed by
    its pk, stable across restore (rows re-save with pks preserved). Usernames sort for a stable dump;
    the username is the user model's `USERNAME_FIELD`, never hard-coded (NetBox swaps in `users.User`)."""
    rows = []
    for todo in RoomTodo.objects.prefetch_related('assignees').all():
        usernames = sorted(u.get_username() for u in todo.assignees.all())
        if usernames:
            rows.append({'todo_id': todo.pk, 'usernames': usernames})
    return rows


def _dump_bindings():
    """Portable room→Location bindings + to-do assignees for restore: one `room_locations` entry per
    **bound** room (`floor_key` + `room_id` + the Location's portable key, BAK-1) so restore can
    re-bind by slug instead of replaying the archive's instance-specific pks, and one `todo_assignees`
    entry per to-do with assignees (by username, BAK-2). `Room.floor_location` needs no entry — it
    re-derives from the portable `floor_key`. An absent room is unbound (or its Location vanished
    between query rows); either way it restores unbound."""
    rows = []
    for room in Room.objects.select_related('location', 'location__site').all():
        key = _location_portable_key(room.location) if room.location_id else None
        if key is None:
            continue
        rows.append({'floor_key': room.floor_key, 'room_id': room.room_id, **key})
    return {'version': 2, 'room_locations': rows, 'todo_assignees': _dump_todo_assignees()}


def _workdir_filter(info):
    """`tarfile.add` filter dropping the regenerable/transient working-dir entries (the import
    lock and the on-demand hi-res preview cache) so backups stay lean."""
    rel = info.name[len(WORKDIR_PREFIX) + 1:] if info.name != WORKDIR_PREFIX else ''
    parts = Path(rel).parts
    # The lock sits at the working-dir root (`.import.lock`) but the preview cache is nested
    # (`uploads/.thumbs/…`), so match a skip name anywhere in the path, not just the first part.
    if any(p in SKIP_WORKDIR for p in parts):
        return None
    return info


def _add_bytes(tar, name, data, mtime):
    """Add an in-memory bytes blob as a tar member (the JSON members `db.json`/`bindings.json`)."""
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mtime = mtime
    tar.addfile(info, io.BytesIO(data))


def create_backup(stamp=None):
    """Write one `.tar.gz` (DB rows + portable bindings + working dir) to the backup dir, then
    prune. Returns `(path, prune_summary)`. `stamp` overrides the filename timestamp (testing)."""
    d = _ensure_dir()
    stamp = stamp or timezone.now().strftime('%Y%m%d-%H%M%S')
    path = d / f'facilitymap-backup-{stamp}.tar.gz'

    now = int(timezone.now().timestamp())
    wd = work_dir()
    with tarfile.open(path, 'w:gz') as tar:
        _add_bytes(tar, DB_MEMBER, _dump_db().encode('utf-8'), now)
        _add_bytes(tar, BINDINGS_MEMBER,
                   json.dumps(_dump_bindings(), indent=2).encode('utf-8'), now)
        if wd.is_dir():
            tar.add(str(wd), arcname=WORKDIR_PREFIX, filter=_workdir_filter)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass

    return path, prune_backups()


def prune_backups(cap_bytes=None):
    """FIFO-prune the backup dir to the size cap: delete oldest artifacts first until the total
    is under the cap, but **always keep the newest** even if it alone exceeds the cap. Returns
    `{'removed': [names], 'total_bytes': int, 'over_cap_kept': name|None}` where `over_cap_kept`
    flags that the surviving newest backup is itself larger than the cap."""
    cap = _max_bytes() if cap_bytes is None else cap_bytes
    d = backup_dir()
    if not d.is_dir():
        return {'removed': [], 'total_bytes': 0, 'over_cap_kept': None}
    files = sorted(d.glob(BACKUP_GLOB))  # name-sorted == oldest-first (timestamped filename)
    total = sum(f.stat().st_size for f in files)
    removed = []
    # Stop before the last file so the most recent backup is never pruned away.
    i = 0
    while total > cap and i < len(files) - 1:
        size = files[i].stat().st_size
        files[i].unlink()
        removed.append(files[i].name)
        total -= size
        i += 1
    over = files[-1].name if files and total > cap else None
    return {'removed': removed, 'total_bytes': total, 'over_cap_kept': over}


def _check_safe_members(members):
    """Reject archive entries that would escape the extraction dir (absolute paths, `..`,
    symlinks/hardlinks). The traversal guard for `restore_backup`, mirroring `storage.safe_path`'s
    posture for the import pipeline."""
    for m in members:
        if m.issym() or m.islnk():
            raise ValueError(f'unsafe link in archive: {m.name}')
        if m.name.startswith('/') or '..' in Path(m.name).parts:
            raise ValueError(f'unsafe path in archive: {m.name}')


def _restore_workdir(tar, members):
    """Replace the working dir with the archive's `workdir/` tree. Extracts to a temp dir on the
    same filesystem (so the swap is an atomic rename), then swaps it in and removes the old tree.
    No-op when the archive carried no working dir. Returns True if a working dir was restored."""
    wmembers = [m for m in members
                if m.name == WORKDIR_PREFIX or m.name.startswith(WORKDIR_PREFIX + '/')]
    if not wmembers:
        return False
    wd = work_dir()
    wd.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=str(wd.parent)) as tmp:
        tar.extractall(tmp, members=wmembers)  # members pre-validated by _check_safe_members
        extracted = Path(tmp) / WORKDIR_PREFIX
        if not extracted.exists():
            return False
        old = None
        if wd.exists():
            old = wd.parent / (wd.name + '.restore-old')
            if old.exists():
                shutil.rmtree(old)
            wd.rename(old)
        shutil.move(str(extracted), str(wd))
        if old:
            shutil.rmtree(old)
    return True


def _resolve_location_path(site_slug, path):
    """Re-resolve a Location from its portable natural key (`_location_portable_key`) against this
    instance's **live** Locations: find the `Site` by slug, then walk the ancestor-slug `path`
    top-down, matching `(site, parent, slug)` at each level (the tuple Location slugs are unique on).
    Returns the leaf Location, or `None` if the site or any path segment is missing on the target."""
    if not site_slug or not path:
        return None
    site = Site.objects.filter(slug=site_slug).first()
    if site is None:
        return None
    parent = None
    loc = None
    for slug in path:
        loc = Location.objects.filter(site=site, parent=parent, slug=slug).first()
        if loc is None:
            return None
        parent = loc
    return loc


class RestoreUnresolvedError(ValueError):
    """Restore was aborted because bindings in the archive don't re-resolve on this instance — the
    migration-safety guard (BAK-1). Carries `.unresolved` (human-readable lines) and stringifies to a
    full report. Subclasses `ValueError` so the existing restore error handling (CLI `CommandError`,
    `RestoreArchiveView` JSON) surfaces it — and it is raised **before** any row is deleted, so an
    unresolvable restore changes nothing."""

    def __init__(self, unresolved):
        self.unresolved = list(unresolved)
        detail = '\n'.join(f'  - {u}' for u in self.unresolved)
        super().__init__(
            f'restore aborted: {len(self.unresolved)} room binding(s) do not resolve on this '
            f'NetBox instance — no data was changed. Re-create the missing Sites/Locations with '
            f'matching slugs and retry, or restore with allow_unresolved to proceed and leave '
            f'those rooms unbound:\n{detail}')


def _resolve_room_bindings(deserialized, room_locations):
    """Compute each restored `Room`'s target-instance FK ids from portable slug keys, and list the
    bindings that don't resolve. `deserialized` is the materialized `db.json` objects;
    `room_locations` is `bindings.json`'s list. Returns `(rebind, unresolved)` where `rebind` maps
    `id(deserialized_obj) -> (location_id, floor_location_id)` and `unresolved` is a list of report
    strings. A binding is *unresolved* only when it existed in the archive (the Room carried a
    non-null FK) but can't be recreated here — a room unbound in the backup stays unbound, never a
    failure."""
    # Lazy import: keep this engine's module load free of the view layer (frontend_api).
    from .frontend_api import _resolve_floor_location

    loc_key = {(e.get('floor_key'), e.get('room_id')): e for e in room_locations}
    rebind, unresolved = {}, []
    for dobj in deserialized:
        room = dobj.object
        if not isinstance(room, Room):
            continue
        # Floor binding: re-derive the sticky FK from the portable floor_key (matches sync_rooms).
        floor_loc = _resolve_floor_location(room.floor_key)
        floor_loc_id = floor_loc.pk if floor_loc is not None else None
        if room.floor_location_id is not None and floor_loc_id is None:
            unresolved.append(f"room '{room.floor_key}/{room.room_id}': floor "
                              f"'{room.floor_key}' has no matching Site + Location")
        # Room binding: re-resolve the portable ancestor-slug path.
        entry = loc_key.get((room.floor_key, room.room_id))
        resolved = _resolve_location_path(entry.get('site'), entry.get('path') or []) if entry else None
        loc_id = resolved.pk if resolved is not None else None
        if room.location_id is not None and loc_id is None:
            where = '/'.join([entry.get('site', '')] + (entry.get('path') or [])) if entry else '?'
            unresolved.append(f"room '{room.floor_key}/{room.room_id}': bound Location "
                              f"'{where}' has no match on this instance")
        rebind[id(dobj)] = (loc_id, floor_loc_id)
    return rebind, unresolved


def _resolve_todo_assignees(deserialized, todo_assignees):
    """Re-resolve each restored `RoomTodo`'s assignees from portable usernames (BAK-2) to this
    instance's live user pks, **rewriting** each to-do's serialized `assignees` M2M in place so the
    stock `dobj.save()` restore replays the *resolved* pks — never the archive's instance-specific
    ones, which Django's serializer emits and which point at the wrong users (or none) on a different
    NetBox. `todo_assignees` is `bindings.json`'s list (keyed by the to-do's stable pk). A username
    with no matching user on the target is **soft-dropped** and reported (an unassigned to-do is still
    a valid job) — never an abort, unlike an unresolved room binding. Returns the `dropped` report
    list. Mutates `deserialized`'s `m2m_data`."""
    # Lazy import: this engine's module load stays free of anything heavier than models/storage.
    from django.contrib.auth import get_user_model

    User = get_user_model()
    uname_field = User.USERNAME_FIELD
    by_todo = {e.get('todo_id'): (e.get('usernames') or []) for e in todo_assignees}
    # One query resolves every referenced username to its pk on this instance.
    wanted = {name for names in by_todo.values() for name in names}
    user_pks = (dict(User.objects.filter(**{f'{uname_field}__in': wanted})
                     .values_list(uname_field, 'pk'))
                if wanted else {})

    dropped = []
    for dobj in deserialized:
        todo = dobj.object
        if not isinstance(todo, RoomTodo):
            continue
        resolved = []
        for name in by_todo.get(todo.pk, []):
            pk = user_pks.get(name)
            if pk is not None:
                resolved.append(pk)
            else:
                dropped.append(f"to-do #{todo.pk} ('{todo.text}'): assignee '{name}' dropped "
                               f"— no matching user on this instance")
        # Overwrite the stale archived pks so save_m2m replays the resolved ones (or none).
        dobj.m2m_data['assignees'] = resolved
    return dropped


def restore_backup(src, *, allow_unresolved=False):
    """Restore a backup written by `create_backup`. **Destructive**: replaces ALL current
    `FacilityMapBlob` + `Room` (+ cascaded `RoomTodo`) rows and the working-dir files with the
    archive's contents. Trusted operator path (CLI / superuser-gated view), so a full replace rather
    than the editor's user-scoped `sync_rooms` merge.

    **Portable bindings + migration safety (BAK-1).** `db.json` serializes `Room.location` /
    `Room.floor_location` as raw DB pks, meaningless on a *different* NetBox instance. A new-format
    archive carries `bindings.json` (portable room→Location slug keys), and restore **re-resolves**
    every binding against this instance's live `dcim.Location` rows: the floor from the portable
    `floor_key` (via `frontend_api._resolve_floor_location`, the same sticky FK `sync_rooms` sets),
    the room from its ancestor-slug path (`_resolve_location_path`). This makes restore a real
    migration path *and* keeps same-instance restore working (slugs are stable within an instance).
    Resolution runs **before** any delete: if a binding that existed in the backup can't be recreated
    here and `allow_unresolved` is False, restore raises `RestoreUnresolvedError` and **changes
    nothing** — never a half-migrated / emptied instance. `allow_unresolved=True` proceeds anyway,
    leaving unresolvable rooms unbound (reported in the result's `unresolved`).

    **Portable to-do assignees (BAK-2).** `db.json`'s M2M serialization emits `RoomTodo.assignees` as
    raw user pks, equally instance-specific. A new-format archive also lists each to-do's assignees by
    **username** in `bindings.json` (`todo_assignees`), and restore re-resolves them to the target's
    live users (`_resolve_todo_assignees`), overwriting the stale pks before the rows are saved. Unlike
    a room binding, an assignee that doesn't resolve is **soft-dropped** and reported (result's
    `dropped_assignees`), never an abort — a to-do missing one assignee is still a valid job. A BAK-1
    archive (no `todo_assignees` key) keeps the pk-replay for assignees, same-instance only, as before.

    Restoring a backup on the *same* instance after a Site/floor **rename** resolves by the current
    slugs; if a slug drifted since the backup that binding reports as unresolved (re-create the
    matching slug, or re-import) — it fails safe rather than mis-binding.

    **Legacy archives (no `bindings.json`).** Pre-BAK-1 archives carry no portable keys, so they
    restore via the original pk-replay path — **same instance only**, exactly as before.

    DB rows restore inside `transaction.atomic()` (PKs preserved); the working dir swaps afterwards.
    A backup taken **before** the CONC-1 per-floor shard (whole-document `key=''` rows) restored into
    a post-shard install reinstates those rows, which the per-floor readers ignore; restore into a
    matching version, or re-import. Returns
    `{'blobs','rooms','todos','workdir','unresolved','dropped_assignees'}`. Raises
    `FileNotFoundError` / `ValueError` (incl. `RestoreUnresolvedError`) / `tarfile.TarError` on a
    missing, malformed, unsafe, or unresolvable archive."""
    src = Path(src)
    if not src.is_file():
        raise FileNotFoundError(f'no such backup file: {src}')

    with tarfile.open(src, 'r:gz') as tar:
        members = tar.getmembers()
        _check_safe_members(members)

        db_member = next((m for m in members if m.name == DB_MEMBER), None)
        if db_member is None:
            raise ValueError(f'archive has no {DB_MEMBER}: {src}')
        db_text = tar.extractfile(db_member).read().decode('utf-8')
        deserialized = list(serializers.deserialize('json', db_text))

        # Re-resolve bindings by slug *before* any delete, so an unresolvable restore can abort
        # without wiping. Legacy archives (no bindings.json) keep the pk-replay path (rebind=None).
        bind_member = next((m for m in members if m.name == BINDINGS_MEMBER), None)
        rebind, unresolved, dropped_assignees = None, [], []
        if bind_member is not None:
            bindings = json.loads(tar.extractfile(bind_member).read().decode('utf-8'))
            rebind, unresolved = _resolve_room_bindings(
                deserialized, bindings.get('room_locations') or [])
            if unresolved and not allow_unresolved:
                raise RestoreUnresolvedError(unresolved)
            # Re-resolve assignees by username (BAK-2) only for a new-format archive that carries the
            # list; a BAK-1 archive (no `todo_assignees` key) keeps the pk-replay via db.json's M2M,
            # matching how it was written. Runs after the abort check so an aborting restore does
            # nothing. Soft-drop only — never aborts, so it needs no `allow_unresolved` gate.
            if 'todo_assignees' in bindings:
                dropped_assignees = _resolve_todo_assignees(
                    deserialized, bindings.get('todo_assignees') or [])

        with transaction.atomic():
            # Deleting Room cascades to RoomTodo; deserialize re-creates both from the archive
            # (rooms before their to-dos, per `_dump_db`'s emit order), so pre-todo archives simply
            # restore no to-dos.
            Room.objects.all().delete()
            FacilityMapBlob.objects.all().delete()
            blobs = rooms = todos = 0
            for dobj in deserialized:
                obj = dobj.object
                if rebind is not None and isinstance(obj, Room):
                    # Overwrite the archive's instance-specific pks with the re-resolved ids so a
                    # stale pk never reaches the DB; legacy archives (rebind is None) replay pks.
                    obj.location_id, obj.floor_location_id = rebind[id(dobj)]
                # `DeserializedObject.save()` defaults `save_m2m=True` and — since this dump uses
                # no natural keys, so `m2m_data` is populated immediately rather than deferred —
                # restores `RoomTodo.assignees` (an M2M) with this one call; no separate `save_m2m()`
                # is needed (audited in SAVE-2). For a new-format archive `_resolve_todo_assignees`
                # has already overwritten `m2m_data['assignees']` with pks re-resolved from portable
                # usernames (BAK-2), so this replays the *target*'s user pks, not the archive's.
                dobj.save()
                if isinstance(obj, RoomTodo):
                    todos += 1
                elif isinstance(obj, Room):
                    rooms += 1
                elif isinstance(obj, FacilityMapBlob):
                    blobs += 1
            restored_wd = _restore_workdir(tar, members)

    return {'blobs': blobs, 'rooms': rooms, 'todos': todos, 'workdir': restored_wd,
            'unresolved': unresolved, 'dropped_assignees': dropped_assignees}
