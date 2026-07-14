"""In-app PDF import: upload → scan → build, plus authenticated serving of the result.

These endpoints replace the standalone tool's `/api/import/*` routes and its static
serving of `images/` + `manifest.json`. The security posture (the whole reason import was
kept out of NetBox originally) is enforced here:

  * **Isolation** — PDFs are never parsed in this process. `RenderRunner` shells out to
    `preprocess.py` *by file path* (so the package's NetBox-importing `__init__` is not
    loaded into the child), with a timeout and POSIX resource limits. A PDFium exploit is
    contained in a short-lived, capped subprocess.
  * **Authorization** — every import endpoint requires the custom `import_facilitymapblob`
    permission (`PermissionRequiredMixin`), not merely a login, unlike the legacy
    localhost-trust model. This is split off `change_facilitymapblob` (which still gates the
    everyday `frontend_api` map writes) so a rack-placer can edit placements without being able
    to rebuild/wipe the facility (PERM-1). `reset` tightens it one step further — it also
    requires a superuser. The admin backup surface rides the same tiers: **archive export**
    (`create_backup`) is on the import gate (it writes a persisted archive, an operator action);
    **archive restore** (`restore_backup`) is on the reset tier — import + superuser — because a
    whole-archive restore wipes ALL rows *and* the working dir. Manifest/media reads share the
    map's read gate (login-only by default; `view_facilitymapblob` when `require_view_permission`
    is on — see access.py).
  * **Input validation** — uploads must carry an accepted drawing magic (PDF or a raster
    image — see `DRAWING_EXTS`/`_sniff`) within a size cap and a traversal-guarded path; an
    import is rejected past a drawing-count cap. The bytes are only *sniffed* here; the actual
    decode still happens exclusively in the render subprocess.
  * **Serving** — rendered floor plans are streamed from `MEDIA_ROOT` through a login-gated
    view, never exposed at a guessable public static URL. Browser caching is allowed but
    always `private` (immutable when the URL carries the manifest's `?v=<built>` token,
    revalidated otherwise) so shared caches never store the authenticated images.
  * **Concurrency** — a working-dir lockfile serializes renders across worker processes
    (a thread lock could not), with stale-lock recovery.
"""

import hashlib
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile
from pathlib import Path
from urllib.parse import quote

from django.contrib.auth.mixins import PermissionRequiredMixin
from django.http import (FileResponse, Http404, HttpResponse, HttpResponseBadRequest,
                         JsonResponse)
from django.utils.cache import get_conditional_response
from django.utils.http import http_date
from django.views import View

from netbox.plugins import get_plugin_config

from .access import IMPORT_PERM, MapReadAccessMixin, reads_scoped_to_sites
from .backup import create_backup, restore_backup
from .drawing_formats import (COMPANION_EXTS, DRAWING_EXTS, install_hint_for,
                              sniff as _sniff, sniff_companion as _sniff_companion)
from .facilities import facility_site_slugs
from .storage import (EMPTY_MANIFEST, MANIFEST_NAME, SERVE_ROOTS, SITEPLAN_DIRNAME, safe_path,
                      valid_facility, work_dir)

# Importing/rebuilding a facility rewrites the whole map (and `reset` wipes it), so gate it on the
# custom `import_facilitymapblob` permission (`IMPORT_PERM`, shared from access.py) — admin-grantable
# and split off the everyday `change_facilitymapblob` map-write gate (PERM-1). `ResetView` adds a
# superuser requirement on top. Manifest/media serving is a *read*, so it rides `MapReadAccessMixin`.

# Accepted drawing inputs (`DRAWING_EXTS`) and their header magic (`_sniff`) come from the
# `drawing_formats` registry — the one Python source of truth, so adding a format is a single
# handler entry there. The base install carries PDFs plus common raster plan formats (public
# measured-drawing collections — e.g. the Library of Congress HABS/HAER/HALS scans — ship as
# TIFF/JPEG/GIF, never PDF); advanced formats (SVG/DXF/Visio/GIS) are gated behind their pip extra
# or external binary, so `DRAWING_EXTS` here is the *installed* set (PKG-1). An upload of a
# recognized-but-uninstalled format is rejected with `install_hint_for`, naming the extra to add.
# The registry is pure stdlib (its decoders load lazily, only in the render subprocess), so
# importing it here does not pull pypdfium2/Pillow into the worker. Untrusted bytes are still only
# *decoded* in that subprocess — here we cheaply sniff the header and enforce the size/traversal caps.
#
# The upload layer also accepts a drawing's COMPANION siblings (a Shapefile's `.shx/.dbf/.prj/.cpg`)
# so a multi-file set stays together in one folder; those are NOT drawings (kept out of
# DRAWING_EXTS), so the scan/build/mapping layers still see one logical `.shp` drawing.
UPLOAD_EXTS = DRAWING_EXTS + COMPANION_EXTS


def _upload_ok(rel, head):
    """Cheap upload-acceptance gate for a path + its leading bytes: a companion sibling is sniffed
    by its (weaker) companion signature, any other accepted file by its drawing magic. False for an
    unaccepted extension or a failed sniff. The real decode is still the render subprocess."""
    ext = os.path.splitext(rel)[1].lower()
    if ext in COMPANION_EXTS:
        return _sniff_companion(head, ext)
    return _sniff(head) is not None


def _cfg(key):
    return get_plugin_config('netbox_facilitymap', key)


def _facility(request):
    """The validated `?facility=` slug for a request (default '' = the default facility), raising
    `ValueError` on a bad slug so the caller can 400. A facility namespaces the whole import — its
    working dir, uploads, images, and manifest (MULTI-2)."""
    return valid_facility(request.GET.get('facility') or '')


# --- per-Site read scoping (SEC-1) -------------------------------------------------

def _viewable_site_slugs(request, facility):
    """The Site slugs within `facility` the request's user may view — the per-Site read-scope set.
    `None` when `scope_reads_to_sites` is off (the caller then filters nothing, so the default read
    path is untouched). Otherwise a set (possibly empty → the user may see no building here),
    resolved through `dcim.Site.objects.restrict(user, 'view')` so it honours object permissions."""
    if not reads_scoped_to_sites():
        return None
    return facility_site_slugs(facility, user=request.user)


def _scope_manifest(manifest, viewable):
    """A copy of `manifest` with its `buildings` filtered to those whose `siteSlug` is in `viewable`
    (a floor plan lives at `images/<siteSlug>/…`, so the slug is the Site key). Fail-closed: a
    building whose Site is not viewable — including one whose siteSlug matches no Site at all — is
    dropped. The campus `siteplan` is a facility-wide asset, kept while the user may view any Site
    and dropped when they may view none. `viewable` is never `None` here (the caller guards on the
    scoping flag). The input dict is shared/read-only (`read_manifest`'s memo), so this copies."""
    scoped = dict(manifest)
    scoped['buildings'] = [b for b in manifest.get('buildings', [])
                           if b.get('siteSlug') in viewable]
    if not viewable:
        scoped['siteplan'] = None
    return scoped


def _scope_etag(etag, viewable):
    """Fold a stable digest of the sorted viewable slugs into `etag`, so a permission change (a
    different viewable set for the same unchanged manifest file) busts that user's conditional
    cache. `etag` is the quoted `"mtime-size"` string from `_file_validators`; the digest is spliced
    inside the closing quote. Media stays `private`, so this only guards a user's *own* revalidation
    across a permission change — cross-user leakage is already impossible."""
    digest = hashlib.sha1('\n'.join(sorted(viewable)).encode()).hexdigest()[:12]
    return '%s-%s"' % (etag[:-1], digest)


# --- render subprocess (isolated + resource-limited) -------------------------------

class RenderRunner:
    """Owns the security-critical render isolation: spawn `preprocess.py` **by file path**
    (never `-m`, so the package's Django/NetBox-importing `__init__` never loads into the child),
    under a working-dir lockfile that serializes renders across worker processes, with a timeout
    plus POSIX CPU/address-space rlimits. Every import endpoint drives the render subprocess
    through this class. It holds only the (immutable) target facility — the working dir is read
    fresh from `work_dir(self.facility)` on each call — so instantiate one per request. The
    lockfile lives in the per-facility working dir, so imports into different facilities never
    block each other."""

    # On-demand high-res preview renders are cached under uploads/.thumbs (mirrors preprocess.py's
    # THUMBS_DIRNAME), so `scan` skips it and `reset` wipes it for free.
    THUMBS_DIRNAME = '.thumbs'
    LOCK_NAME = '.import.lock'
    SCRIPT = 'preprocess.py'

    def __init__(self, facility=''):
        self.facility = facility

    # Fraction of detected host memory a single render's RLIMIT_AS may occupy. The rest is left
    # for the co-resident gunicorn workers + Postgres, so a render that overruns fails *inside*
    # the capped child (MemoryError → degrades gracefully) instead of tripping the kernel
    # OOM-killer, which would reap an unrelated worker → intermittent 502s (PERF-2).
    MEM_HEADROOM_FRACTION = 0.5

    @staticmethod
    def _detect_avail_mb():
        """Best-effort total memory available to this process, in MB, or None if undetectable.
        Prefers the cgroup limit (correct inside an LXC/Docker container, where `/proc/meminfo`
        can report the *host*'s RAM, not the container's) and falls back to `/proc/meminfo`
        MemTotal. Reads only stdlib files — no new dependency, and never raises."""
        for path in ('/sys/fs/cgroup/memory.max',                     # cgroup v2
                     '/sys/fs/cgroup/memory/memory.limit_in_bytes'):   # cgroup v1
            try:
                raw = Path(path).read_text().strip()
            except OSError:
                continue
            if not raw or raw == 'max':      # v2 reports the literal 'max' when unlimited
                continue
            try:
                nbytes = int(raw)
            except ValueError:
                continue
            # An unlimited v1 cgroup reports a huge sentinel (~PAGE_SIZE * INT_MAX); treat any
            # absurd value as "no limit" and fall through to MemTotal.
            if 0 < nbytes < (1 << 62):
                return nbytes // (1024 * 1024)
        try:
            for line in Path('/proc/meminfo').read_text().splitlines():
                if line.startswith('MemTotal:'):
                    return int(line.split()[1]) // 1024   # kB → MB
        except (OSError, ValueError, IndexError):
            pass
        return None

    @classmethod
    def _effective_mem_mb(cls, mem_mb):
        """The RLIMIT_AS ceiling (MB) to actually apply for `render_mem_mb` == `mem_mb`.

        Auto-clamps the *packaged default* down to a safe fraction of detected host memory so a
        single pypdfium2/Pillow render can't allocate the whole machine and OOM-kill a worker
        (PERF-2). An operator who tuned `render_mem_mb` away from the default has made an
        informed choice and is honored verbatim — notably, *raising* it is the documented remedy
        when a LibreOffice/Visio (`soffice`) conversion, which reserves a large *virtual* address
        space that RLIMIT_AS caps, is killed by too tight a limit. Returns `mem_mb` unchanged when
        it is falsy (no cap) or host memory can't be detected."""
        if not mem_mb:
            return mem_mb
        from . import FacilityMapConfig
        if mem_mb != FacilityMapConfig.default_settings['render_mem_mb']:
            return mem_mb            # explicit operator override — soffice escape hatch
        avail = cls._detect_avail_mb()
        if not avail:
            return mem_mb
        return max(1, min(mem_mb, int(avail * cls.MEM_HEADROOM_FRACTION)))

    @staticmethod
    def _rlimits(timeout_s, mem_mb):
        """Return a POSIX `preexec_fn` capping the child's CPU time and address space, so a
        runaway or malicious render can't exhaust the host. `mem_mb` is the already-clamped
        ceiling (see `_effective_mem_mb`); this runs post-fork so it stays minimal — just
        `setrlimit`, no file reads or allocation."""
        def apply():
            import resource
            cpu = int(timeout_s) + 5
            resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
            if mem_mb:
                nbytes = int(mem_mb) * 1024 * 1024
                resource.setrlimit(resource.RLIMIT_AS, (nbytes, nbytes))
        return apply

    def run(self, mode, extra=None):
        """Spawn `preprocess.py <mode> --base <workdir> [extra...]` and shape its result. Invoked
        by file path (not `-m`) so the child stays minimal/isolated — no Django in-process. The
        render relies on this isolation: the `render_timeout_s` timeout plus POSIX CPU/address-space
        rlimits cap a runaway or malicious child. `extra` carries mode-specific argv (e.g.
        `--pdf`/`--out` for `preview`). `scan` reads the child's stdout as the JSON inventory;
        every other mode returns stderr as a log."""
        base = work_dir(self.facility)
        base.mkdir(parents=True, exist_ok=True)
        script = str(Path(__file__).resolve().parent / self.SCRIPT)
        timeout = _cfg('render_timeout_s')
        kwargs = {}
        if os.name == 'posix':
            kwargs['preexec_fn'] = self._rlimits(
                timeout, self._effective_mem_mb(_cfg('render_mem_mb')))
        try:
            proc = subprocess.run(
                [sys.executable, script, mode, '--base', str(base), *(extra or [])],
                capture_output=True, text=True, cwd=str(base), timeout=timeout, **kwargs)
        except subprocess.TimeoutExpired:
            return {'ok': False, 'error': '%s timed out after %ss' % (mode, timeout)}
        if proc.returncode != 0:
            return {'ok': False,
                    'error': (proc.stderr or proc.stdout).strip()[:2000] or (mode + ' failed')}
        if mode == 'scan':
            try:
                return {'ok': True, **json.loads(proc.stdout or '{}')}
            except json.JSONDecodeError:
                return {'ok': False, 'error': (proc.stderr or proc.stdout)[:1000]}
        return {'ok': True, 'log': proc.stderr.strip()[:2000]}

    def ensure_preview(self, src_rel, page=0, angle=0):
        """Ensure the full-scale PNG for an uploaded drawing exists (rendering it via
        `preprocess.py` if missing/stale) and return its working-dir-relative cache path. Backs the
        preview endpoint and the wizard's enlarged/cropped mapping cards via the
        `.thumbs/<...>.full.png` cache. `src_rel` is working-dir-relative (`uploads/...`) and may be
        a PDF or a raster image. `page` is the 0-based page index of a multi-page PDF (default the
        first — the whole-file/single-page case). `angle` (clockwise degrees, default 0) previews a
        rotated card the way it will build. Raises `Http404` when the source is absent; returns
        `None` on a render failure. Renders a single file to a distinct cache path **without taking
        the import lock**, so opening a preview never 409s against an in-flight scan."""
        base = work_dir(self.facility).resolve()
        full = safe_path(src_rel, self.facility)
        try:
            inside = full.relative_to(base / 'uploads')
        except ValueError:
            raise Http404
        if not full.is_file():
            raise Http404
        # Key the cache on the full source filename (not the stem), so `1.pdf` and `1.png` sharing a
        # folder render to distinct caches (`1.pdf.full.png` vs `1.png.full.png`) instead of colliding.
        # A page beyond the first gets its own cache suffix (`.p<N>.full.png`, 1-based to match the
        # wizard's `?page=`); page 0 keeps the bare name so single-page previews are unchanged. A
        # non-zero rotation gets its own `.a<deg>` cache too, so an unrotated preview stays
        # byte-identical to before and each orientation caches separately (`reset` wipes `.thumbs`).
        suffix = ('.p%d' % (page + 1) if page else '') + ('.a%g' % angle if angle % 360 else '') \
            + '.full.png'
        cache = base / 'uploads' / self.THUMBS_DIRNAME / inside.parent / (inside.name + suffix)
        cache_rel = cache.relative_to(base).as_posix()
        try:
            fresh = cache.is_file() and cache.stat().st_mtime >= full.stat().st_mtime
        except OSError:
            fresh = False
        if not fresh:
            extra = ['--pdf', full.relative_to(base).as_posix(), '--out', cache_rel]
            if page:
                extra += ['--page', str(page)]
            if angle % 360:
                extra += ['--angle', ('%g' % angle)]
            result = self.run('preview', extra)
            if not result.get('ok') or not cache.is_file():
                return None
        return cache_rel

    def _acquire_lock(self, stale_after):
        """Atomically create the working-dir lockfile. Returns its Path, or None if another
        import holds a still-fresh lock. A lock older than `stale_after` (a crashed render) is
        reclaimed once."""
        base = work_dir(self.facility)
        base.mkdir(parents=True, exist_ok=True)
        lock = base / self.LOCK_NAME
        try:
            fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                age = time.time() - lock.stat().st_mtime
            except FileNotFoundError:
                age = stale_after + 1
            if age <= stale_after:
                return None
            try:
                os.unlink(str(lock))
                fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except (FileExistsError, FileNotFoundError):
                return None
        os.close(fd)
        return lock

    def run_locked(self, mode):
        """Run a render under the working-dir lock; 409 if one is already in flight."""
        lock = self._acquire_lock(_cfg('render_timeout_s') * 2)
        if lock is None:
            return JsonResponse({'ok': False, 'error': 'an import is already running'}, status=409)
        try:
            result = self.run(mode)
        finally:
            try:
                os.unlink(str(lock))
            except FileNotFoundError:
                pass
        return JsonResponse(result)


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


def _zip_targets(names):
    """Map a zip's drawing member paths (any accepted format) to `(folder, file)` upload
    destinations, mirroring the wizard's folder-upload split (see `ImportUploader.split`). A
    single directory shared by every drawing — the wrapper folder a zip usually has — is
    stripped first; a drawing then sitting at the root alongside subfoldered drawings is treated
    as the overall site map.

    A drawing's COMPANION siblings (a Shapefile's `.shx/.dbf/.prj/.cpg`) ride along into the same
    `(folder, file)` — routed by the layout of the **primary** drawings, and only when a same-stem
    primary sits in the same zip directory (orphan companions are dropped). The layout decisions
    (wrapper-folder peel, site-map detection) are made on primaries alone, so companions never sway
    them. Count *drawings* off the result with `n.lower().endswith(DRAWING_EXTS)`."""
    def norm(n):
        return [s for s in n.replace('\\', '/').split('/') if s]

    drawings = [n for n in names
                if n.lower().endswith(DRAWING_EXTS) and not n.endswith('/')]
    split = [norm(n) for n in drawings]
    # Peel off any leading directory shared by every drawing (nested wrapper folders). Track how
    # many segments were peeled so a companion's path can be peeled identically.
    peeled = 0
    while split and all(len(s) > 1 for s in split) and len({s[0] for s in split}) == 1:
        split = [s[1:] for s in split]
        peeled += 1
    has_subfolders = any(len(s) >= 2 for s in split)
    out = {}
    for name, segs in zip(drawings, split):
        if not segs:
            continue
        if has_subfolders and len(segs) == 1:
            out[name] = ('Site Plan', segs[-1])
        else:
            out[name] = (segs[-2] if len(segs) > 1 else 'Building', segs[-1])

    # Attach each companion sibling to a primary drawing sharing its directory + stem, landing it in
    # the primary's target folder under its own filename (pyshp finds it by shared basename). The
    # primary index is a snapshot so companion inserts don't mutate what's being scanned.
    primaries = [(norm(pname)[peeled:-1], os.path.splitext(pfile)[0].lower(), folder)
                 for pname, (folder, pfile) in out.items()]
    for name in names:
        if name.endswith('/') or not name.lower().endswith(COMPANION_EXTS):
            continue
        segs = norm(name)[peeled:]
        if not segs:
            continue
        cdir, cfile = segs[:-1], segs[-1]
        stem = os.path.splitext(cfile)[0].lower()
        for pdir, pstem, folder in primaries:
            if pdir == cdir and pstem == stem:
                out[name] = (folder, cfile)
                break
    return out


# --- endpoints ---------------------------------------------------------------------

class _ImportView(PermissionRequiredMixin, View):
    """Base for the import-gated endpoints (mostly POST; the export download is a GET):
    unauthenticated → login redirect; authenticated without the import permission → 403
    (PermissionRequiredMixin default)."""
    permission_required = IMPORT_PERM


class UploadView(_ImportView):
    """Store one uploaded drawing (PDF or a raster image) under
    `<workdir>/uploads/<folder>/<file>`. The file rides a multipart form (`file` field) so
    Django streams it to disk rather than buffering the whole body in memory."""

    def post(self, request):
        rel = (request.GET.get('path') or '').lstrip('/')
        if not rel.lower().endswith(UPLOAD_EXTS):
            # A recognized-but-uninstalled format (e.g. .svg without the [svg] extra) gets an
            # actionable "install the extra" message; anything else, the generic installed-set list.
            hint = install_hint_for(rel)
            if hint:
                return HttpResponseBadRequest(hint)
            return HttpResponseBadRequest('an accepted drawing path is required (installed '
                                          'formats: %s)' % ', '.join(DRAWING_EXTS))
        try:
            facility = _facility(request)
            target = safe_path('uploads/' + rel, facility)
            parts = target.relative_to(work_dir(facility).resolve()).parts
        except ValueError:
            return HttpResponseBadRequest('invalid path')
        if not parts or parts[0] != 'uploads':
            return HttpResponseBadRequest('invalid path')

        up = request.FILES.get('file')
        if up is None:
            return HttpResponseBadRequest('missing file')
        if up.size > _cfg('max_pdf_mb') * 1024 * 1024:
            return JsonResponse({'ok': False, 'error': 'file exceeds size limit'}, status=413)
        if not _upload_ok(rel, up.read(16)):
            return HttpResponseBadRequest('unsupported file type (bad magic bytes)')

        target.parent.mkdir(parents=True, exist_ok=True)
        part = target.with_name(target.name + '.part')
        up.seek(0)
        with open(part, 'wb') as f:
            for chunk in up.chunks():
                f.write(chunk)
        os.replace(part, target)
        return JsonResponse({'ok': True, 'bytes': up.size})


class UploadZipView(_ImportView):
    """Extract one uploaded `.zip` of building drawings (PDFs and/or raster images) into
    `<workdir>/uploads/...`, mapping members the same way folder uploads are (`_zip_targets`).
    Extraction only writes bytes and sniffs magic — drawings are still parsed solely in the
    isolated render subprocess, so this does not breach that isolation. Guarded against oversize
    archives, zip bombs (per-file + cumulative decompressed caps), path traversal, and
    symlink/special members."""

    def post(self, request):
        up = request.FILES.get('file')
        if up is None:
            return HttpResponseBadRequest('missing file')
        if not (up.name or '').lower().endswith('.zip'):
            return HttpResponseBadRequest('a .zip file is required')
        if up.size > _cfg('max_zip_mb') * 1024 * 1024:
            return JsonResponse({'ok': False, 'error': 'zip exceeds size limit'}, status=413)
        if not up.read(4).startswith(b'PK\x03\x04'):
            return HttpResponseBadRequest('not a zip (bad magic bytes)')
        up.seek(0)

        try:
            facility = _facility(request)
        except ValueError:
            return HttpResponseBadRequest('invalid facility')
        max_pdfs = _cfg('max_pdfs')
        per_file_cap = _cfg('max_pdf_mb') * 1024 * 1024
        total_cap = _cfg('max_zip_uncompressed_mb') * 1024 * 1024
        base = work_dir(facility)
        base.mkdir(parents=True, exist_ok=True)

        count, total = 0, 0
        try:
            with zipfile.ZipFile(up) as zf:
                targets = _zip_targets(zf.namelist())
                # The cap counts *drawings*, not companion siblings (which don't render).
                drawings = sum(1 for n in targets if n.lower().endswith(DRAWING_EXTS))
                if not drawings:
                    return JsonResponse(
                        {'ok': False, 'error': 'no drawings in the zip'}, status=400)
                if drawings > max_pdfs:
                    return JsonResponse(
                        {'ok': False, 'error': 'too many drawings (limit %d)' % max_pdfs},
                        status=400)
                for info in zf.infolist():
                    if info.filename not in targets or info.is_dir():
                        continue
                    # Refuse symlinks/special files — safe_path's resolve() would follow them.
                    mode = (info.external_attr >> 16) & 0o170000
                    if mode and mode != 0o100000:
                        return HttpResponseBadRequest('zip contains a non-regular file')
                    folder, fname = targets[info.filename]
                    try:
                        target = safe_path('uploads/' + folder + '/' + fname, facility)
                        parts = target.relative_to(base.resolve()).parts
                    except ValueError:
                        return HttpResponseBadRequest('zip entry escapes the working directory')
                    if not parts or parts[0] != 'uploads':
                        return HttpResponseBadRequest('invalid zip entry path')

                    target.parent.mkdir(parents=True, exist_ok=True)
                    part = target.with_name(target.name + '.part')
                    written = 0
                    with zf.open(info) as src, open(part, 'wb') as dst:
                        chunk = src.read(1024 * 1024)
                        if not _upload_ok(fname, chunk[:16]):
                            os.unlink(part)
                            return HttpResponseBadRequest(
                                'zip contains an unsupported file (%s)' % fname)
                        while chunk:
                            written += len(chunk)
                            total += len(chunk)
                            if written > per_file_cap:
                                os.unlink(part)
                                return JsonResponse(
                                    {'ok': False, 'error': 'a drawing exceeds the size limit'},
                                    status=413)
                            if total > total_cap:
                                os.unlink(part)
                                return JsonResponse(
                                    {'ok': False, 'error': 'zip decompresses too large'}, status=413)
                            dst.write(chunk)
                            chunk = src.read(1024 * 1024)
                    os.replace(part, target)
                    if fname.lower().endswith(DRAWING_EXTS):   # report drawings, not companions
                        count += 1
        except zipfile.BadZipFile:
            return HttpResponseBadRequest('corrupt zip file')
        return JsonResponse({'ok': True, 'count': count})


class ScanView(_ImportView):
    """Render a thumbnail per uploaded PDF and return the folders/drawings inventory."""

    def post(self, request):
        try:
            facility = _facility(request)
        except ValueError:
            return HttpResponseBadRequest('invalid facility')
        return RenderRunner(facility).run_locked('scan')


class BuildView(_ImportView):
    """Persist the wizard's import map, then render images + manifest."""

    def post(self, request):
        try:
            data = json.loads(request.body or b'{}')
        except json.JSONDecodeError:
            return HttpResponseBadRequest('invalid JSON')
        if not isinstance(data, dict):
            return HttpResponseBadRequest('import map must be an object')
        try:
            facility = _facility(request)
        except ValueError:
            return HttpResponseBadRequest('invalid facility')
        base = work_dir(facility)
        base.mkdir(parents=True, exist_ok=True)
        max_pdfs = _cfg('max_pdfs')
        if _count_rendered_drawings(data) > max_pdfs:
            return JsonResponse(
                {'ok': False, 'error': 'too many drawings (limit %d)' % max_pdfs}, status=400)
        (base / 'import-map.json').write_text(json.dumps(data))
        return RenderRunner(facility).run_locked('build')


class ResetView(_ImportView):
    """Clear an import so the user can start over (uploads/images/manifest/map/lock).

    Reset is the one irreversible operation (it wipes the working dir), so on top of the import
    permission it requires a **superuser** — the strongest tier, one step above `import` (PERM-1).
    A non-superuser importer gets the same 403/login handling as any missing-permission caller."""

    def has_permission(self):
        # `super()` enforces IMPORT_PERM; the superuser check is the extra reset-only tier.
        return super().has_permission() and self.request.user.is_superuser

    def post(self, request):
        try:
            base = work_dir(_facility(request))
        except ValueError:
            return HttpResponseBadRequest('invalid facility')
        for d in ('uploads', 'images'):
            shutil.rmtree(base / d, ignore_errors=True)
        for f in (MANIFEST_NAME, 'import-map.json', 'import-map.stub.json',
                  'import-map.draft.json', RenderRunner.LOCK_NAME):
            try:
                (base / f).unlink()
            except FileNotFoundError:
                pass
        return JsonResponse({'ok': True})


class ExportArchiveView(_ImportView):
    """Download a full self-contained backup archive of all plugin data (DB rows + working dir).

    Wraps `backup.create_backup()` — the same engine the `facilitymap_backup` CLI drives — so the
    admin UI and the operator command produce interchangeable `.tar.gz` files. Gated on the import
    permission (`_ImportView`): exporting bundles every blob/room plus the uploaded drawings and
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


class RestoreArchiveView(_ImportView):
    """Restore a backup archive, **replacing ALL plugin data** (blobs + rooms + working dir).

    Wraps `backup.restore_backup()` (destructive full replace inside `transaction.atomic()`), the
    single most destructive operation in the plugin — strictly more so than `reset` (which only
    wipes the working dir). So on top of the import permission it requires a **superuser**, exactly
    the `ResetView` tier. The uploaded archive is untrusted: it is size- and magic-validated here,
    and `restore_backup` traversal-guards every member (`_check_safe_members`) before extracting —
    that guard is not loosened. The archive is streamed to a temp file (no in-memory cap) and
    removed afterwards; the working dir is only touched by `restore_backup`'s atomic swap."""

    def has_permission(self):
        # `super()` enforces IMPORT_PERM; the superuser check is the extra restore-only tier.
        return super().has_permission() and self.request.user.is_superuser

    def post(self, request):
        up = request.FILES.get('file')
        if up is None:
            return HttpResponseBadRequest('missing file')
        if not (up.name or '').lower().endswith(('.tar.gz', '.tgz', '.gz')):
            return HttpResponseBadRequest('a .tar.gz backup archive is required')
        if up.size > _cfg('backup_max_mb') * 1024 * 1024:
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
            result = restore_backup(tmp_path)
        except (ValueError, tarfile.TarError, FileNotFoundError) as e:
            return JsonResponse({'ok': False, 'error': str(e)}, status=400)
        finally:
            try:
                os.unlink(tmp_path)
            except FileNotFoundError:
                pass
        return JsonResponse({'ok': True, **result})


class SaveDraftView(_ImportView):
    """Persist the wizard's in-progress building/floor assignments for smart resume."""

    def post(self, request):
        try:
            data = json.loads(request.body or b'{}')
        except json.JSONDecodeError:
            return HttpResponseBadRequest('invalid JSON')
        try:
            base = work_dir(_facility(request))
        except ValueError:
            return HttpResponseBadRequest('invalid facility')
        base.mkdir(parents=True, exist_ok=True)
        (base / 'import-map.draft.json').write_text(json.dumps(data), encoding='utf-8')
        return JsonResponse({'ok': True})


class LoadDraftView(_ImportView):
    """Return the saved wizard draft (buildings/site) if one exists."""

    def get(self, request):
        try:
            draft = work_dir(_facility(request)) / 'import-map.draft.json'
        except ValueError:
            return HttpResponseBadRequest('invalid facility')
        if not draft.is_file():
            return JsonResponse({'ok': False})
        try:
            data = json.loads(draft.read_text(encoding='utf-8'))
        except (json.JSONDecodeError, OSError):
            return JsonResponse({'ok': False})
        return JsonResponse({'ok': True, **data})


class RegroupView(_ImportView):
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
    render, so — like `UploadView` — it takes no import lock; the wizard re-scans afterwards."""

    def post(self, request):
        try:
            data = json.loads(request.body or b'{}')
        except json.JSONDecodeError:
            return HttpResponseBadRequest('invalid JSON')
        groups = data.get('groups') if isinstance(data, dict) else None
        if not isinstance(groups, dict):
            return HttpResponseBadRequest('groups must be an object')
        try:
            facility = _facility(request)
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
        # phantom (floorless) building at the next scan. Never the uploads root or the thumb cache.
        for d in src_dirs:
            if d == uploads or d.name == RenderRunner.THUMBS_DIRNAME:
                continue
            try:
                d.rmdir()
            except OSError:
                pass            # not empty (some drawings stayed) or already gone
        return JsonResponse({'ok': True, 'moved': moved})


class PreviewView(_ImportView):
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
            facility = _facility(request)
            cache_rel = RenderRunner(facility).ensure_preview(rel, page=page, angle=angle)
        except ValueError:
            raise Http404
        if cache_rel is None:
            return JsonResponse({'ok': False, 'error': 'preview render failed'}, status=500)
        # The cached preview lives under `uploads/.thumbs` in the working dir; serve it through
        # the shared helper so it honours the same optional nginx offload as MediaView.
        return _serve_file(work_dir(facility) / cache_rel, Path(cache_rel).parts, facility)


def _file_validators(stat):
    """(etag, last_modified) HTTP validators for a working-dir file, derived from its
    stat. mtime+size is a sufficient change signal here: every file under the working dir
    is either rewritten by an import (new mtime) or replaced by an upload."""
    return '"%d-%d"' % (int(stat.st_mtime), stat.st_size), int(stat.st_mtime)


def _serve_file(full, parts, facility=''):
    """Response body for the working-dir file at `full` (whose traversal-validated per-facility
    working-dir-relative path is `parts`), letting the caller set the caching/validator headers.

    By default the file is streamed from this worker via `FileResponse`. When the
    `x_accel_redirect` setting is on, instead return an empty response carrying an
    `X-Accel-Redirect` header pointing at `<x_accel_location>/<facility>/<parts>`, so a cooperating
    nginx `internal` location streams the bytes and the gunicorn worker is freed immediately — the
    fix for worker exhaustion under slow/many concurrent media loads. The nginx `internal` alias
    points at the working-dir **root**, but `parts` is relative to the *per-facility* subdir, so the
    facility slug is prefixed back on to form the root-relative path. Callers MUST run the auth +
    traversal + serve-root gate *before* calling this: nginx only ever receives an internal path
    it can't be reached at directly, so the media stays authenticated exactly as when streamed."""
    ctype = mimetypes.guess_type(str(full))[0] or 'application/octet-stream'
    if _cfg('x_accel_redirect'):
        location = (_cfg('x_accel_location') or '/facilitymap-internal/').rstrip('/')
        response = HttpResponse(content_type=ctype)
        # `parts` is already confined to the facility's working dir; prefix the facility (so the
        # path is relative to the working-dir root nginx aliases) and encode each segment for the
        # header URI (quote keeps '/'), so nginx resolves the same path under its `internal` alias.
        rel = ((facility + '/') if facility else '') + '/'.join(parts)
        response['X-Accel-Redirect'] = location + '/' + quote(rel)
        return response
    return FileResponse(open(full, 'rb'), content_type=ctype)


class ManifestView(MapReadAccessMixin, View):
    """Serve the rendered manifest, or the empty stub before any facility is imported.
    Read-gated (same access as the map — login-only by default), not a public static file. Cached
    `private, no-cache`: the browser must revalidate (a rebuild changes the manifest and
    its `built` token), but an unchanged manifest costs only a 304."""

    def get(self, request):
        try:
            facility = _facility(request)
        except ValueError:
            return HttpResponseBadRequest('invalid facility')
        path = work_dir(facility) / MANIFEST_NAME
        try:
            stat = path.stat()
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            response = JsonResponse(EMPTY_MANIFEST, safe=False)
            response['Cache-Control'] = 'no-store'
            return response
        etag, last_modified = _file_validators(stat)
        # Per-Site read scoping (SEC-1): filter the buildings to the viewer's viewable Sites so a
        # user whose object permissions hide a Site never even learns that building exists. The
        # viewable set folds into the ETag so a permission change busts the user's own 304. Off by
        # default (`viewable is None`) → the manifest is served whole, exactly as before.
        viewable = _viewable_site_slugs(request, facility)
        if viewable is not None:
            data = _scope_manifest(data, viewable)
            etag = _scope_etag(etag, viewable)
        not_modified = get_conditional_response(request, etag=etag, last_modified=last_modified)
        if not_modified is not None:
            not_modified['ETag'] = etag
            return not_modified
        response = JsonResponse(data, safe=False)
        response['ETag'] = etag
        response['Last-Modified'] = http_date(last_modified)
        response['Cache-Control'] = 'private, no-cache'
        return response


class MediaView(MapReadAccessMixin, View):
    """Stream a rendered image / thumbnail / uploaded PDF from the working dir. Read-gated
    (`MapReadAccessMixin`) + traversal-guarded + confined to the `images`/`uploads` subtrees, so
    floor plans are not exposed at a guessable public URL. The view-perm gate is *additive* — the
    traversal guard, `SERVE_ROOTS` confinement, and `private` caching below all still apply.

    Caching is always **private** (the images are deliberately authenticated — never let a
    shared cache store them). Requests carrying the manifest's `?v=<built>` token cache
    immutably for a year — a rebuild writes a new token into the manifest, so stale entries
    are simply never requested again. Unversioned requests (wizard thumbnails, uploads)
    revalidate via ETag/Last-Modified and cost a 304 when unchanged.

    The bytes stream from this worker via `FileResponse` by default; with the `x_accel_redirect`
    setting on, `_serve_file` offloads the transfer to nginx (see `_serve_file`). The auth +
    traversal + serve-root gate below runs first either way, and the validators/Cache-Control
    are set here in both modes — so revalidation stays worker-authoritative regardless of nginx."""

    def get(self, request, path):
        try:
            facility = _facility(request)
            full = safe_path(path, facility)
            parts = full.relative_to(work_dir(facility).resolve()).parts
        except ValueError:
            raise Http404
        if not parts or parts[0] not in SERVE_ROOTS or not full.is_file():
            raise Http404
        # Per-Site read scoping (SEC-1): a floor plan lives at `images/<siteSlug>/…`, so gate that
        # segment on the viewer's viewable Sites — a hidden Site's pixels 404 (not 403: don't reveal
        # the file exists). The campus siteplan (`images/Siteplan/…`) is a facility-wide asset, shown
        # when the user may view any Site and hidden when none. `uploads/` is import-only (importers
        # hold IMPORT_PERM and legitimately see every source), so it stays on the flat gate. This
        # runs BEFORE `_serve_file`, so the x_accel offload never hands nginx an out-of-scope path.
        viewable = _viewable_site_slugs(request, facility)
        if viewable is not None and parts[0] == 'images':
            seg = parts[1] if len(parts) > 1 else None
            allowed = bool(viewable) if seg == SITEPLAN_DIRNAME else (seg in viewable)
            if not allowed:
                raise Http404
        etag, last_modified = _file_validators(full.stat())
        not_modified = get_conditional_response(request, etag=etag, last_modified=last_modified)
        if not_modified is not None:
            not_modified['ETag'] = etag
            return not_modified
        response = _serve_file(full, parts, facility)
        response['ETag'] = etag
        response['Last-Modified'] = http_date(last_modified)
        response['Cache-Control'] = ('private, max-age=31536000, immutable'
                                     if 'v' in request.GET else 'private, no-cache')
        return response
