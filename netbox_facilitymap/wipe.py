"""Full plugin data wipe — the "back to a blank-slate install" reset (HEALTH-12).

The plugin's data is two things (the same two `backup.py` bundles): the `FacilityMapBlob` +
`Room` (+ cascaded `RoomTodo`) rows in NetBox's DB, and the working-dir files under `MEDIA_ROOT`.
`imports.ResetView` already clears *part* of that — one facility's working-dir files — but leaves
every DB row standing, so "start over" still resurrects the old rooms. This module is the
complete version, and like `backup.py` it is a pure engine driven by two callers (the
`facilitymap_wipe` management command and `imports.WipeView`) so the CLI and the UI wipe
identically.

**Two scopes.** `wipe_data()` with no facility is the blank slate: *every* blob row (including the
install-wide `kind='settings'` / `kind='facility_map'` rows), every room, and the whole working-dir
tree. `wipe_data(facility=…)` narrows to one facility's **map data** — its `EDITOR_KINDS` blobs, the
rooms `facility_floor_scope` puts on its floors, and its own working-dir artifacts — deliberately
sparing the install-wide settings rows, which live at `facility=''` but belong to the install, not
to the default facility (the same split `facilities.data_facility_keys` draws).

**What it never touches.** Nothing outside the plugin: no `dcim.Site`/`Location`/`Device` row is
read for deletion, and NetBox's own `ObjectChange` history of our writes is core data, left alone.
Backup archives under `backup_dir` are **explicitly** spared — they live outside the working dir
precisely so a destructive op can't take the safety net with it, and a wipe is the op that most
needs one to still be there afterwards.

**Ordering + safety.** DB deletes run inside `transaction.atomic()` **first**, then the files: a DB
failure changes nothing at all, and a file failure leaves orphaned media that re-running the wipe
clears (the operation is idempotent). Every affected facility's render lock is held for the whole
run (`_hold_locks`) — deleting `uploads/`/`images/` beneath a live render subprocess would strand a
half-rendered facility, the same reason `ResetView` and the archive restore take the lock. This is
one notch stricter than `RestoreArchiveView`, which takes only the default facility's lock.

Kept to Django + stdlib, like `backup.py` (no new runtime deps).
"""

import shutil
from contextlib import ExitStack, contextmanager

from django.db import transaction

from .facilities import EDITOR_KINDS, data_facility_keys, facility_floor_scope, \
    imported_facility_slugs
from .models import FacilityMapBlob, Room, RoomTodo
from .render_runner import RenderRunner
from .storage import MANIFEST_NAME, SERVE_ROOTS, valid_facility, work_dir

#: The default facility's own working-dir files. It maps to the flat **root** (MULTI-2), which also
#: holds every other facility's subfolder — so its wipe removes these by name and never the tree.
#: `SERVE_ROOTS` is `images`/`uploads`; the on-demand preview cache lives under `uploads/.thumbs`,
#: so it goes with them.
DEFAULT_FACILITY_ENTRIES = SERVE_ROOTS + (
    MANIFEST_NAME, 'import-map.json', 'import-map.stub.json', 'import-map.draft.json')


class WipeBusyError(RuntimeError):
    """A render holds a working-dir lock, so the wipe would race it. Nothing was changed."""


@contextmanager
def _hold_locks(slugs):
    """Hold the render lockfile of every facility in `slugs` for the duration of the block.

    An `ExitStack` so the acquired locks unwind in reverse on the way out — including when we bail
    part-way because one was already held, which raises `WipeBusyError` **before** anything is
    deleted. Locks are taken in sorted order so two concurrent wipes queue rather than deadlock."""
    with ExitStack() as stack:
        for slug in sorted(slugs):
            if not stack.enter_context(RenderRunner(slug).hold_lock()):
                raise WipeBusyError(
                    'a render is in flight for %s — nothing was changed'
                    % (repr(slug) if slug else 'the default facility'))
        yield


def _lockable(slug):
    """True if `slug` can name a working dir at all. A `facility` value that isn't a valid slug
    never had a working dir (`work_dir` would have refused to create one), so there is no lock to
    take — but it can still reach us from a hand-edited or REST-written blob row, and letting
    `valid_facility` raise out of the lock loop would fail the whole wipe over a row the unscoped
    delete is about to remove anyway."""
    try:
        return valid_facility(slug) == slug
    except ValueError:
        return False


def _affected_facilities(facility):
    """The facilities a wipe must lock: just `facility` when scoped, else every facility that holds
    data on disk or in the DB, plus the default (whose lockfile is the working-dir root's)."""
    if facility is not None:
        return {facility}
    known = imported_facility_slugs() | data_facility_keys() | {''}
    return {slug for slug in known if _lockable(slug)}


def _remove_entries(base, names):
    """Remove `names` from `base`, dirs and files alike, tolerating what is already gone."""
    for name in names:
        entry = base / name
        if entry.is_dir():
            shutil.rmtree(entry, ignore_errors=True)
        else:
            try:
                entry.unlink()
            except OSError:
                pass


def _remove_workdir_files(facility):
    """Delete the facility's working-dir artifacts. True if there was a working dir to clear.

    A **named** facility owns its whole subfolder, so the subfolder goes wholesale. The **default**
    facility maps to the flat root, which also holds every *other* facility's subfolder — so its
    wipe removes only `DEFAULT_FACILITY_ENTRIES`, by name, exactly as `ResetView` and
    `storage.move_facility` do. Getting that wrong would take every facility down with the default
    one.

    `facility=None` (the all-wipe) clears the root by entry too, sparing the root's own
    `.import.lock`: that is the lock this wipe holds, and unlinking it would let a concurrent render
    claim the root while we are still deleting. The *subfolder* locks we hold do go with their
    subfolders — `hold_lock` tolerates that (it is how the archive restore's tree swap already
    behaves), leaving only a sub-millisecond tail window where a render could re-claim a facility we
    have already finished clearing."""
    if facility:
        base = work_dir(facility)
        existed = base.exists()
        shutil.rmtree(base, ignore_errors=True)
        return existed

    base = work_dir()
    if not base.exists():
        return False
    if facility == '':
        _remove_entries(base, DEFAULT_FACILITY_ENTRIES)
        return True
    try:
        names = [c.name for c in base.iterdir() if c.name != RenderRunner.LOCK_NAME]
    except OSError:
        return False
    _remove_entries(base, names)
    return True


def _delete_rows(facility):
    """Delete the in-scope DB rows inside one transaction; return `(blobs, rooms, todos)` counts.

    Rooms are counted (with their to-dos, which CASCADE off `Room`) before the delete, since a
    queryset `delete()` reports a per-model dict we would have to unpack anyway. This is the
    trusted-operator full delete, **not** the editor's `sync_rooms` path — no `restrict(user,
    'delete')` scoping, deliberately (a superuser blank-slate is exactly the documented exception
    to that invariant, the same standing `backup.restore_backup` has)."""
    if facility is None:
        blob_qs, room_qs = FacilityMapBlob.objects.all(), Room.objects.all()
    else:
        blob_qs = FacilityMapBlob.objects.filter(facility=facility, kind__in=EDITOR_KINDS)
        scope = facility_floor_scope(facility)
        room_qs = Room.objects.filter(scope) if scope is not None else Room.objects.none()

    with transaction.atomic():
        blobs = blob_qs.count()
        rooms = room_qs.count()
        todos = RoomTodo.objects.filter(room__in=room_qs).count()
        room_qs.delete()
        blob_qs.delete()
    return blobs, rooms, todos


def wipe_data(facility=None):
    """Delete the plugin's data. **Irreversible** — take a `create_backup()` first.

    `facility=None` (the default) is the blank slate: every `FacilityMapBlob` row — the per-facility
    editor documents *and* the install-wide `settings`/`facility_map` rows — every `Room` (+ its
    to-dos), and the entire working-dir tree. Afterwards the install reads exactly as a fresh one:
    every settings reader (`previews.PluginSettings`, `facilities.grouping`/`facility_map`, …) falls
    back to its own default when the row is absent, so nothing has to be re-created for the plugin
    to work — only re-configured.

    A `facility` string (`''` for the default facility, a validated slug otherwise) narrows to that
    facility's map data and leaves the install-wide settings rows and every *other* facility alone.
    Its room scope is `facility_floor_scope`, i.e. the floors currently resolving to it — a facility
    whose Sites were deleted or re-grouped may strand rooms the scope no longer matches; the
    unscoped wipe is the way to guarantee nothing is left.

    Never touches anything outside the plugin (no `dcim` rows, no NetBox change log) and never the
    backup archives under `backup_dir`. Raises `ValueError` on an invalid facility slug and
    `WipeBusyError` when a render holds a working-dir lock — in both cases before any delete.
    Returns `{'blobs','rooms','todos','facilities','workdir'}`, where `facilities` is the sorted
    list of facilities whose files were cleared."""
    if facility is not None:
        valid_facility(facility)

    affected = _affected_facilities(facility)
    with _hold_locks(affected):
        blobs, rooms, todos = _delete_rows(facility)
        # One pass either way: the all-wipe clears the shared root (every facility's subfolder with
        # it), so there is no per-slug loop to run over `affected`.
        workdir = _remove_workdir_files(facility)

    return {'blobs': blobs, 'rooms': rooms, 'todos': todos,
            'facilities': sorted(affected), 'workdir': workdir}
