"""Plugin-scoped backup & restore — an opt-in, self-contained safety net.

The plugin's data is two things: the `FacilityMapBlob` + `Room` rows in the NetBox Postgres
DB, and the working-dir files (images/manifest/uploaded PDFs) under `MEDIA_ROOT`. A standard
whole-NetBox backup (`pg_dump` + a copy of `MEDIA_ROOT`) already captures both — there is no
built-in NetBox backup, so that is the operator's job. This module is the granular,
no-system-deps alternative for sites that don't run one: it writes a single timestamped
`.tar.gz` holding a Django-serialized `db.json` plus a tar of the working dir, FIFO-prunes the
backup dir to a configurable size cap, and restores either part.

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
import os
import shutil
import tarfile
import tempfile
from pathlib import Path

from django.conf import settings
from django.core import serializers
from django.db import transaction
from django.utils import timezone

from netbox.plugins import get_plugin_config

from .models import FacilityMapBlob, Room
from .storage import work_dir

#: Glob for our artifacts; the timestamp makes a lexical sort chronological.
BACKUP_GLOB = 'facilitymap-backup-*.tar.gz'
#: Members inside each archive.
DB_MEMBER = 'db.json'
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
    """Serialize the plugin's rows to a JSON string. Equivalent to `dumpdata` for exactly
    `FacilityMapBlob` + `Room`; blobs are emitted first so `Room.location` (a `dcim.Location`
    FK) already exists when the rows are re-saved on restore into the same instance."""
    objs = list(FacilityMapBlob.objects.all()) + list(Room.objects.all())
    return serializers.serialize('json', objs, indent=2)


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


def create_backup(stamp=None):
    """Write one `.tar.gz` (DB rows + working dir) to the backup dir, then prune. Returns
    `(path, prune_summary)`. `stamp` overrides the filename timestamp (testing)."""
    d = _ensure_dir()
    stamp = stamp or timezone.now().strftime('%Y%m%d-%H%M%S')
    path = d / f'facilitymap-backup-{stamp}.tar.gz'

    db_bytes = _dump_db().encode('utf-8')
    wd = work_dir()
    with tarfile.open(path, 'w:gz') as tar:
        info = tarfile.TarInfo(DB_MEMBER)
        info.size = len(db_bytes)
        info.mtime = int(timezone.now().timestamp())
        tar.addfile(info, io.BytesIO(db_bytes))
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


def restore_backup(src):
    """Restore a backup written by `create_backup`. **Destructive**: replaces ALL current
    `FacilityMapBlob` + `Room` rows and the working-dir files with the archive's contents. This
    is the trusted operator path (CLI only, confirmation-gated upstream), so it does a full
    replace rather than the editor's user-scoped `sync_rooms` merge.

    DB rows are restored inside `transaction.atomic()` (delete-all then re-save the serialized
    rows, PKs preserved); the working dir is swapped afterwards. Intended for the **same** NetBox
    instance the backup came from — `Room.location` FKs reference live `dcim.Location` ids.
    Returns `{'blobs': n, 'rooms': n, 'workdir': bool}`. Raises `FileNotFoundError` /
    `ValueError` / `tarfile.TarError` on a missing or malformed/unsafe archive."""
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

        with transaction.atomic():
            Room.objects.all().delete()
            FacilityMapBlob.objects.all().delete()
            blobs = rooms = 0
            for obj in serializers.deserialize('json', db_text):
                obj.save()
                if isinstance(obj.object, Room):
                    rooms += 1
                elif isinstance(obj.object, FacilityMapBlob):
                    blobs += 1
            restored_wd = _restore_workdir(tar, members)

    return {'blobs': blobs, 'rooms': rooms, 'workdir': restored_wd}
