"""In-app PDF import: the workflow endpoints that drive upload → scan → build, plus the admin
backup surface and the wizard's supporting endpoints (draft, regroup, preview).

This module is one of four the import surface is split across; the security posture (the whole
reason import was kept out of NetBox originally) is enforced across all of them:

  * **Isolation** — PDFs are never parsed in this process. `render_runner.RenderRunner` shells out
    to `preprocess.py` *by file path* (so the package's NetBox-importing `__init__` is not loaded
    into the child), with a timeout and POSIX resource limits. A PDFium exploit is contained in a
    short-lived, capped subprocess.
  * **Authorization** — every import endpoint requires the custom `import_facilitymapblob`
    permission (`import_base.ImportView`), not merely a login, unlike the legacy localhost-trust
    model. This is split off `change_facilitymapblob` (which still gates the everyday
    `frontend_api` map writes) so a rack-placer can edit placements without being able to
    rebuild/wipe the facility (PERM-1). `reset` tightens it one step further — it also requires a
    superuser, as does the full data `wipe` (`WipeView`, DB rows *and* files — the complete version
    of `reset`). The admin backup surface rides the same tiers: **archive export** (`create_backup`)
    is on the import gate (it writes a persisted archive, an operator action); **archive restore**
    (`restore_backup`) is on the reset tier — import + superuser — because a whole-archive restore
    wipes ALL rows *and* the working dir. Manifest/media reads share the map's read gate
    (login-only by default; `view_facilitymapblob` when `require_view_permission` is on — see
    access.py).
  * **Input validation** — uploads must carry an accepted drawing magic (PDF or a raster image)
    within a size cap and a traversal-guarded path (`uploads.py`); an import is rejected past a
    drawing-count cap (`_count_rendered_drawings`, below). The bytes are only *sniffed* there; the
    actual decode still happens exclusively in the render subprocess.
  * **Serving** — rendered floor plans stream through login-gated views (`serving.py`), never at a
    guessable public static URL.
  * **Concurrency** — a working-dir lockfile serializes renders across worker processes (a thread
    lock could not), with stale-lock recovery. See `render_runner.RenderRunner.hold_lock`.

**Where the rest lives.** This file used to carry all of it (~1100 lines); it is now the workflow
half only, and the pieces that stand on their own moved out:

  * `import_base.py` — `cfg`/`request_facility`/`busy_response`/`ImportView`, the shared
    foundation every part of the import surface needs (kept separate to keep the graph acyclic).
  * `render_runner.py` — `RenderRunner`: the isolated render subprocess and the working-dir lock.
  * `uploads.py` — `UploadView`/`UploadZipView` plus the acceptance gate and zip member mapping.
  * `serving.py` — `ManifestView`/`MediaView`: the read-gated manifest/media serving.
"""

import json
import os
import secrets
import shutil
import tarfile
import tempfile
from pathlib import Path

from django.http import FileResponse, Http404, HttpResponseBadRequest, JsonResponse

from .backup import RestoreUnresolvedError, create_backup, restore_backup
from .drawing_formats import COMPANION_EXTS, DRAWING_EXTS
from .facilities import org_mode
from .import_base import ImportView, busy_response, cfg, request_facility
from .render_runner import RenderRunner
from .serving import serve_file
from .storage import MANIFEST_NAME, safe_path, work_dir
from .wipe import WipeBusyError, wipe_data


def _count_rendered_drawings(imap):
    """Count the floors a posted import map will render across every building, plus the siteplan.
    A floor-table entry yields one floor when its value is a scalar token (a bare `stem` or a
    `stem#pN` exploded page), or **several** when it is a `[{token, region}]` region-split list —
    each region becomes its own floor. This is the cap that matters: an exploded multi-page PDF or
    a region-split page multiplies *rendered* floors while staying one uploaded file, so the limit
    is measured on render output, not on files on disk (which the upload/zip endpoints already
    bound)."""
    buildings = imap.get('buildings')
    if not isinstance(buildings, dict):
        buildings = {}
    n = 0
    for b in buildings.values():
        if not isinstance(b, dict):
            continue
        for v in (b.get('floors') or {}).values():
            n += len(v) if isinstance(v, list) else 1
    if imap.get('siteplan'):
        n += 1
    return n


# --- endpoints ---------------------------------------------------------------------

class ScanView(ImportView):
    """Render a thumbnail per uploaded PDF and return the folders/drawings inventory."""

    def post(self, request):
        try:
            facility = request_facility(request)
        except ValueError:
            return HttpResponseBadRequest('invalid facility')
        return RenderRunner(facility).run_locked('scan')


class BuildView(ImportView):
    """Persist the wizard's import map, then render images + manifest."""

    def post(self, request):
        try:
            data = json.loads(request.body or b'{}')
        except json.JSONDecodeError:
            return HttpResponseBadRequest('invalid JSON')
        if not isinstance(data, dict):
            return HttpResponseBadRequest('import map must be an object')
        try:
            facility = request_facility(request)
        except ValueError:
            return HttpResponseBadRequest('invalid facility')
        base = work_dir(facility)
        base.mkdir(parents=True, exist_ok=True)
        max_pdfs = cfg('max_pdfs')
        if _count_rendered_drawings(data) > max_pdfs:
            return JsonResponse(
                {'ok': False, 'error': 'too many drawings (limit %d)' % max_pdfs}, status=400)
        # The map write rides `prepare`, so it happens *under* the render lock: written before the
        # lock, a second build starting in the window between the two could render this request's
        # map (or have its own overwritten by ours).
        # Stamp the facility's declared organization mode into the map the build renders (MODEL-6),
        # server-side rather than trusting a wizard-supplied value: the stored setting is the single
        # source of truth, and `preprocess` copies it onto the manifest so a built facility records
        # how it was organized. Written here (not by the client) so a hand-rolled import map can't
        # claim a mode the install never declared.
        data['orgMode'] = org_mode(facility)

        def write_map():
            (base / 'import-map.json').write_text(json.dumps(data))

        return RenderRunner(facility).run_locked('build', prepare=write_map)


class ResetView(ImportView):
    """Clear an import so the user can start over (uploads/images/manifest/map/lock).

    Reset is the one irreversible operation (it wipes the working dir), so on top of the import
    permission it requires a **superuser** — the strongest tier, one step above `import` (PERM-1).
    A non-superuser importer gets the same 403/login handling as any missing-permission caller.

    It runs under the render lock (`hold_lock`, 409 when a render is in flight): deleting
    `uploads/`/`images/` beneath a live render subprocess would leave a half-rendered facility
    behind the wipe. The lockfile itself is therefore no longer deleted here — we *hold* it, and
    `hold_lock` releases it on the way out; a lock stranded by a crashed render is already reclaimed
    by `_acquire_lock`'s stale-lock recovery."""

    def has_permission(self):
        # `super()` enforces IMPORT_PERM; the superuser check is the extra reset-only tier.
        return super().has_permission() and self.request.user.is_superuser

    def post(self, request):
        try:
            facility = request_facility(request)
        except ValueError:
            return HttpResponseBadRequest('invalid facility')
        base = work_dir(facility)
        with RenderRunner(facility).hold_lock() as held:
            if not held:
                return busy_response()
            for d in ('uploads', 'images'):
                shutil.rmtree(base / d, ignore_errors=True)
            for f in (MANIFEST_NAME, 'import-map.json', 'import-map.stub.json',
                      'import-map.draft.json'):
                try:
                    (base / f).unlink()
                except FileNotFoundError:
                    pass
        return JsonResponse({'ok': True})


class ExportArchiveView(ImportView):
    """Download a full self-contained backup archive of all plugin data (DB rows + working dir).

    Wraps `backup.create_backup()` — the same engine the `facilitymap_backup` CLI drives — so the
    admin UI and the operator command produce interchangeable `.tar.gz` files. Gated on the import
    permission (`ImportView`): exporting bundles every blob/room plus the uploaded drawings and
    rendered images, and it *writes* a persisted archive to the backup dir, so it is an
    operator-tier action, not a plain read. `create_backup` FIFO-prunes the backup dir but always
    keeps the newest file — the one we just wrote — so streaming it back is safe. The persisted
    copy is intentional: each in-app export also lands in the operator's backup FIFO."""

    def get(self, request):
        path, _summary = create_backup()
        response = FileResponse(open(path, 'rb'), as_attachment=True, filename=path.name,
                                content_type='application/gzip')
        response['Cache-Control'] = 'no-store'
        return response


class RestoreArchiveView(ImportView):
    """Restore a backup archive, **replacing ALL plugin data** (blobs + rooms + working dir).

    Wraps `backup.restore_backup()` (destructive full replace — rows inside `transaction.atomic()`,
    then the working-dir swap once it commits), the single most destructive operation in the plugin — strictly more so than `reset` (which only
    wipes the working dir). So on top of the import permission it requires a **superuser**, exactly
    the `ResetView` tier. The uploaded archive is untrusted: it is size- and magic-validated here,
    and `restore_backup` traversal-guards every member (`_check_safe_members`) before extracting —
    that guard is not loosened. The archive is streamed to a temp file (no in-memory cap) and
    removed afterwards; the working dir is only touched by `restore_backup`'s post-commit rename
    swap (this view adds no transaction of its own, which is what keeps that swap after the commit).

    Restore re-links rooms to Locations by portable **slug** (BAK-1), so a backup can be restored to
    a *new* instance. This web path is **strict** (no `allow_unresolved`): if a binding can't be
    re-resolved here the restore aborts **without changing anything** and returns the unresolved
    list (400) so the operator can recreate the missing Sites/Locations before retrying."""

    def has_permission(self):
        # `super()` enforces IMPORT_PERM; the superuser check is the extra restore-only tier.
        return super().has_permission() and self.request.user.is_superuser

    def post(self, request):
        up = request.FILES.get('file')
        if up is None:
            return HttpResponseBadRequest('missing file')
        if not (up.name or '').lower().endswith(('.tar.gz', '.tgz', '.gz')):
            return HttpResponseBadRequest('a .tar.gz backup archive is required')
        if up.size > cfg('backup_max_mb') * 1024 * 1024:
            return JsonResponse({'ok': False, 'error': 'archive exceeds size limit'}, status=413)
        if not up.read(2).startswith(b'\x1f\x8b'):  # gzip magic
            return HttpResponseBadRequest('not a gzip archive (bad magic bytes)')
        up.seek(0)

        # Stream to a temp file so restore_backup (which takes a path) never buffers the whole
        # archive in memory, then remove it regardless of outcome.
        with tempfile.NamedTemporaryFile(suffix='.tar.gz', delete=False) as tmp:
            for chunk in up.chunks():
                tmp.write(chunk)
            tmp_path = tmp.name
        try:
            # Under the render lock, like `reset`: `_restore_workdir` swaps the whole working-dir
            # tree, which would strand a live render writing into the tree it renames away. The lock
            # is the **default** facility's, because that is the root `restore_backup` replaces —
            # so a render into some *other* facility's subdir is not serialized against it (a
            # whole-instance restore during another facility's import is out of scope here; the
            # archive replaces every facility either way).
            with RenderRunner().hold_lock() as held:
                if not held:
                    return busy_response()
                # Strict on the web path (no allow_unresolved): the most destructive action in the
                # plugin aborts + reports rather than silently dropping bindings.
                result = restore_backup(tmp_path)
        except RestoreUnresolvedError as e:
            # Bindings didn't resolve on this instance — nothing was changed. Surface the list so
            # the operator sees exactly which Sites/Locations to recreate before retrying.
            return JsonResponse({'ok': False, 'error': str(e), 'unresolved': e.unresolved},
                                status=400)
        except (ValueError, tarfile.TarError, FileNotFoundError) as e:
            return JsonResponse({'ok': False, 'error': str(e)}, status=400)
        finally:
            try:
                os.unlink(tmp_path)
            except FileNotFoundError:
                pass
        return JsonResponse({'ok': True, **result})


class WipeView(ImportView):
    """Delete the plugin's data — DB rows *and* working-dir files (HEALTH-12). **Irreversible.**

    The complete counterpart to `ResetView`, which clears one facility's working-dir files but
    leaves every `FacilityMapBlob`/`Room` row standing (so "start over" resurrects the old rooms).
    A thin wrap over `wipe.wipe_data` — the same engine the `facilitymap_wipe` command drives, so
    the CLI and the UI wipe identically. POST `{"all": true}` for the blank slate (every row
    including the install-wide settings, every room, the whole working dir) or `{"facility": …}`
    for one facility's map data.

    Destructive, so it sits on the **reset tier** — `IMPORT_PERM` plus a **superuser**, exactly
    `ResetView`/`RestoreArchiveView`. `wipe_data` takes every affected facility's render lock
    itself, so a render in flight surfaces as the shared 409 with nothing changed."""

    def has_permission(self):
        # `super()` enforces IMPORT_PERM; the superuser check is the extra wipe-only tier.
        return super().has_permission() and self.request.user.is_superuser

    def post(self, request):
        try:
            data = json.loads(request.body or b'{}')
        except json.JSONDecodeError:
            return HttpResponseBadRequest('invalid JSON')
        if not isinstance(data, dict):
            return HttpResponseBadRequest('body must be an object')
        # `facility: ''` is the *default facility*, a different request from "wipe everything", so
        # the scope is chosen by an explicit `all` flag rather than by the facility's truthiness.
        if data.get('all'):
            facility = None
        else:
            facility = data.get('facility') or ''
            if not isinstance(facility, str):
                return HttpResponseBadRequest('invalid facility')
        try:
            result = wipe_data(facility)
        except ValueError:
            return HttpResponseBadRequest('invalid facility')
        except WipeBusyError:
            return busy_response()
        return JsonResponse({'ok': True, **result})


class SaveDraftView(ImportView):
    """Persist the wizard's in-progress building/floor assignments for smart resume."""

    def post(self, request):
        try:
            data = json.loads(request.body or b'{}')
        except json.JSONDecodeError:
            return HttpResponseBadRequest('invalid JSON')
        try:
            base = work_dir(request_facility(request))
        except ValueError:
            return HttpResponseBadRequest('invalid facility')
        base.mkdir(parents=True, exist_ok=True)
        (base / 'import-map.draft.json').write_text(json.dumps(data), encoding='utf-8')
        return JsonResponse({'ok': True})


class LoadDraftView(ImportView):
    """Return the saved wizard draft (buildings/site) if one exists."""

    def get(self, request):
        try:
            draft = work_dir(request_facility(request)) / 'import-map.draft.json'
        except ValueError:
            return HttpResponseBadRequest('invalid facility')
        if not draft.is_file():
            return JsonResponse({'ok': False})
        try:
            data = json.loads(draft.read_text(encoding='utf-8'))
        except (json.JSONDecodeError, OSError):
            return JsonResponse({'ok': False})
        return JsonResponse({'ok': True, **data})


class RegroupView(ImportView):
    """Relocate uploaded drawings into per-building folders — the server half of the wizard's
    in-app building assignment for an unsorted pile of drawings (IMPORT-3).

    A flat pile of drawings all lands in one `uploads/<folder>/` bucket, but the whole pipeline
    keys **building identity off that physical folder** (scan, the draft, the manifest, the build
    map, `preprocess.build`'s folder walk). Rather than decouple identity from the folder, the
    wizard lets the user assign each drawing to a named building and this endpoint physically moves
    the files so the folder stays truthful, leaving every downstream stage unchanged.

    POST JSON `{"groups": {"<destFolder>": ["<uploads-relative src>", ...], ...}}`. Each source is
    moved to `uploads/<destFolder>/<basename>`, carrying its same-stem COMPANION siblings (a
    Shapefile's `.shx/.dbf/.prj/.cpg`) into the same folder so the multi-file set stays together.
    Every path is traversal-guarded via `safe_path` and confined to `uploads/`, a destination
    collision is refused, and only *bytes* are moved — the untrusted decode still happens solely in
    the render subprocess, so this doesn't breach that isolation. A source folder left empty by the
    moves is pruned so it doesn't linger as a phantom (floorless) building at the next scan. No
    render, so — like `UploadView` — it takes no import lock; the wizard re-scans afterwards.

    **The two reserved folder names are handled asymmetrically** (IMPORT-24). `building_folders()`
    skips both, so a drawing in either is invisible to `scan` and `build`. `THUMBS_DIRNAME` is
    therefore **refused** as a destination — nothing legitimate moves a drawing into the thumbnail
    cache, and one that landed there would silently disappear from the wizard. `EXCLUDED_DIRNAME`
    is **accepted**, because moving a drawing there is exactly how the organize step drops it from
    the import; that is the same act however the request was built, so it needs no second signal.

    `EXCLUDED_DIRNAME` is equally legitimate as a **source**: that is how the edit hub's restore
    (IMPORT-26) brings an excluded drawing back into a building. It needs no special case here —
    a source is validated only by `safe_path` + "is a file", the companion-sibling sweep carries a
    multi-file set back with it, and the prune below removes the park once it empties."""

    def post(self, request):
        try:
            data = json.loads(request.body or b'{}')
        except json.JSONDecodeError:
            return HttpResponseBadRequest('invalid JSON')
        groups = data.get('groups') if isinstance(data, dict) else None
        if not isinstance(groups, dict):
            return HttpResponseBadRequest('groups must be an object')
        try:
            facility = request_facility(request)
        except ValueError:
            return HttpResponseBadRequest('invalid facility')
        uploads = work_dir(facility).resolve() / 'uploads'

        # Resolve + validate every move first, so a bad entry rejects before any file is touched.
        moves = []          # (src, dst) pairs, including companion siblings
        src_dirs = set()    # source folders to prune if the moves empty them
        seen_dst = set()

        def _under_uploads(p):
            return p == uploads or uploads in p.parents

        def _plan(src, dst):
            """Validate one src→dst move and enqueue it. Returns an error string or None."""
            if not (_under_uploads(src) and _under_uploads(dst)):
                return 'path outside uploads'
            if dst == src:
                return None            # already where it belongs
            if dst in seen_dst or dst.exists():
                return 'destination already exists: ' + dst.name
            seen_dst.add(dst)
            moves.append((src, dst))
            return None

        for dest, files in groups.items():
            # A building folder is a single path segment; reject traversal/separators (safe_path is
            # the backstop, but keep the folder flat so `building_folders()` sees it).
            if not isinstance(dest, str) or not dest or dest in ('.', '..') \
                    or '/' in dest or '\\' in dest:
                return HttpResponseBadRequest('invalid building folder name')
            # The thumbnail cache is reserved and is never a legitimate destination: `scan` skips it
            # by name, so a drawing moved there would vanish from the wizard with no way back.
            # `EXCLUDED_DIRNAME` is reserved too but IS a legitimate destination — it is how the
            # organize step drops a drawing from the import (IMPORT-24) — so only the cache is
            # refused here; the client keeps both out of its "Add building" field.
            if dest == RenderRunner.THUMBS_DIRNAME:
                return HttpResponseBadRequest('reserved building folder name')
            if not isinstance(files, list):
                return HttpResponseBadRequest('each group must be a list of paths')
            for rel in files:
                if not isinstance(rel, str) or not rel:
                    return HttpResponseBadRequest('invalid drawing path')
                try:
                    src = safe_path('uploads/' + rel, facility)
                    dst = safe_path('uploads/' + dest + '/' + src.name, facility)
                except ValueError:
                    return HttpResponseBadRequest('invalid path')
                if not src.is_file():
                    return HttpResponseBadRequest('no such drawing: ' + rel)
                err = _plan(src, dst)
                if err:
                    return HttpResponseBadRequest(err)
                if src.parent != dst.parent:
                    src_dirs.add(src.parent)
                    # Carry same-stem companion siblings (kept in the same folder — a Shapefile set
                    # is opened by shared basename at render time) into the destination folder.
                    stem = os.path.splitext(src.name)[0].lower()
                    for sib in sorted(src.parent.iterdir()):
                        if sib == src or not sib.is_file():
                            continue
                        if sib.suffix.lower() in COMPANION_EXTS \
                                and os.path.splitext(sib.name)[0].lower() == stem:
                            err = _plan(sib, dst.parent / sib.name)
                            if err:
                                return HttpResponseBadRequest(err)

        moved = 0
        for src, dst in moves:
            dst.parent.mkdir(parents=True, exist_ok=True)
            os.replace(src, dst)
            moved += 1
        # Prune source folders emptied by the moves so an emptied bucket doesn't survive as a
        # phantom (floorless) building at the next scan — and, when the source was the excluded
        # park, so a fully-restored facility doesn't leave an empty park behind (IMPORT-26; the
        # scan reports `excluded: []` either way). Never the uploads root or the thumb cache.
        for d in src_dirs:
            if d == uploads or d.name == RenderRunner.THUMBS_DIRNAME:
                continue
            try:
                d.rmdir()
            except OSError:
                pass            # not empty (some drawings stayed) or already gone
        return JsonResponse({'ok': True, 'moved': moved})


class PreviewView(ImportView):
    """Render one uploaded drawing (PDF or raster image) at full scale on demand and stream the
    PNG back — the wizard's high-res preview for the popup and for enlarged/zoomed mapping cards.
    Permission-gated + isolated like the other render endpoints, but it renders a single file to
    a cache without taking the import lock, so opening a preview never 409s against an in-flight
    scan.

    GET ?path=uploads/<folder>/<file>[&page=<1-based page of a multi-page PDF>][&angle=<deg>]"""

    def get(self, request):
        rel = (request.GET.get('path') or '').lstrip('/')
        if not rel.lower().endswith(DRAWING_EXTS):
            return HttpResponseBadRequest('an accepted drawing path is required')
        # `page` is 1-based in the URL (page 1 = the first page, the default); convert to the
        # 0-based render index. A missing/invalid/≤1 value is the first page.
        try:
            page = max(0, int(request.GET.get('page') or 1) - 1)
        except ValueError:
            page = 0
        # `angle` is a clockwise straightening rotation in degrees (default/invalid = 0, unrotated).
        try:
            angle = float(request.GET.get('angle') or 0)
        except ValueError:
            angle = 0
        try:
            facility = request_facility(request)
            cache_rel = RenderRunner(facility).ensure_preview(rel, page=page, angle=angle)
        except ValueError:
            raise Http404
        if cache_rel is None:
            return JsonResponse({'ok': False, 'error': 'preview render failed'}, status=500)
        # The cached preview lives under `uploads/.thumbs` in the working dir; serve it through
        # the shared helper so it honours the same optional nginx offload as MediaView.
        return serve_file(work_dir(facility) / cache_rel, Path(cache_rel).parts, facility)


def _valid_region(raw):
    """A posted normalized-0..1 crop box as a plain `{x, y, w, h}` dict, or None when it isn't one.
    Allows a hair over 1 on the far edges so a box dragged to the very edge isn't rejected by
    float rounding (the wizard clamps to 0..1, but the round-trip through JSON need not be exact)."""
    if not isinstance(raw, dict):
        return None
    try:
        x, y, w, h = (float(raw[k]) for k in ('x', 'y', 'w', 'h'))
    except (KeyError, TypeError, ValueError):
        return None
    if not (x >= 0 and y >= 0 and w > 0 and h > 0 and x + w <= 1.001 and y + h <= 1.001):
        return None
    return {'x': x, 'y': y, 'w': w, 'h': h}


class OcrReadView(ImportView):
    """Read the floor code out of a marked region on each drawing, so the wizard can pre-fill floor
    assignments (IMPORT-31). The user has already dragged one box over the spot that identifies a
    floor; this reads that same normalized region on every drawing in scope and returns the
    recognized text + confidence per drawing. The wizard turns text into a *suggestion* the
    operator confirms — this endpoint never assigns anything.

    **The caller supplies the work list.** Unlike the endpoint removed in `1.10.0`, which
    re-enumerated `uploads/` and understood only first-page PDFs, the wizard knows things the
    filesystem does not: exploded `#pN` page rows, excluded drawings, region-split cards, the
    chosen siteplan, and the current bulk scope. So it posts exactly which drawings to read, and
    this view validates them. A per-item `region` overrides the default, which is what lets one
    pass cover a building whose title block sits in a different corner (`building.codeRegion`).

    Each drawing is read at **angle 0**, from the same full-scale preview render the wizard's
    code-crop thumbnails use: the region was marked on the *unrotated* drawing, so cropping a
    straightened render would read the wrong pixels (the reason `_codeCropThumb` also drops its
    crop on a rotated card).

    Isolated + permission-gated like every import endpoint, but lock-free like `PreviewView` — it
    only reads images, so a Populate never 409s against an in-flight scan. OCR itself runs in the
    `ocr.py` subprocess over already-rendered, trusted PNGs; no PDF is opened here.

    **One request, one job file.** The wizard's background sweep (IMPORT-53) slices a facility into
    many small reads, so two of them can be in flight at once across worker processes — a sweep
    chunk overlapping the manual re-read, most obviously. A fixed `ocr-job.json` would have the
    second request overwrite the first's work list between its write and its subprocess spawn, so
    the name carries a random token and is removed once the child has run.

    **Per-line candidates, not one joined string.** The reader returns each text line it found in
    the region as its own candidate, because the recognizer can only read one line at a time and
    joining them produced both an unparseable string and a confidence averaged over characters
    that had nothing to do with the floor code. `text`/`confidence` are the reader's best single
    candidate — vocabulary-free, since `ocr.py` knows nothing about floors — and `lines` carries
    them all, for the wizard to run its own floor parser over. A region nothing plausible could be
    read from comes back with an empty `text` and an empty `lines`: read, found nothing.

    POST {"region": {"x","y","w","h"},                     (0..1, the default)
          "items": [{"folder", "stem", "path", "page"?, "region"?}]}
    → {"ok": true, "results": [{"folder", "stem", "text", "confidence",
                                "lines": [{"text", "confidence", "min_p", "y"}]}]}"""

    def post(self, request):
        try:
            data = json.loads(request.body or b'{}')
        except json.JSONDecodeError:
            return HttpResponseBadRequest('invalid JSON')
        region = _valid_region(data.get('region'))
        if region is None:
            return HttpResponseBadRequest('region needs numeric x/y/w/h within 0..1')
        items = data.get('items')
        if not isinstance(items, list) or not items:
            return HttpResponseBadRequest('items must be a non-empty list')
        # Bound the work the same way an import is bounded. This is the cap that matters here:
        # each item costs a preview render plus a model inference, so an unbounded list would be
        # an easy way to tie up a worker and the render budget.
        max_pdfs = cfg('max_pdfs')
        if len(items) > max_pdfs:
            return HttpResponseBadRequest('too many drawings to read (limit %d)' % max_pdfs)

        try:
            facility = request_facility(request)
        except ValueError:
            raise Http404
        runner = RenderRunner(facility)
        images = []
        for item in items:
            if not isinstance(item, dict):
                return HttpResponseBadRequest('each item must be an object')
            rel = (item.get('path') or '').lstrip('/')
            if not rel.lower().endswith(DRAWING_EXTS):
                return HttpResponseBadRequest('an accepted drawing path is required')
            try:
                page = max(0, int(item.get('page') or 1) - 1)
            except (TypeError, ValueError):
                page = 0
            # `ensure_preview` is the traversal guard as well as the renderer. It rejects a path in
            # two different ways — `safe_path` raises **ValueError** when the path escapes the
            # working dir, and `ensure_preview` itself raises **Http404** when it lands outside
            # `uploads/` or names no file — so both must be caught, or a crafted `path` would 500
            # instead of 400.
            try:
                cache_rel = runner.ensure_preview(rel, page=page)
            except (Http404, ValueError):
                return HttpResponseBadRequest('unknown drawing: %s' % rel)
            if not cache_rel:
                continue        # this drawing's render failed — skip it, don't sink the batch
            entry = {'folder': item.get('folder'), 'stem': item.get('stem'), 'image': cache_rel}
            own = _valid_region(item.get('region'))
            if own:
                entry['region'] = own
            images.append(entry)
        if not images:
            return JsonResponse({'ok': False, 'error': 'nothing could be read'}, status=400)

        base = work_dir(facility)
        base.mkdir(parents=True, exist_ok=True)
        job_name = 'ocr-job-%s.json' % secrets.token_hex(8)
        (base / job_name).write_text(
            json.dumps({'region': region, 'images': images}), encoding='utf-8')
        try:
            result = runner.run_ocr(job_name)
        finally:
            (base / job_name).unlink(missing_ok=True)
        return JsonResponse(result, status=200 if result.get('ok') else 500)
