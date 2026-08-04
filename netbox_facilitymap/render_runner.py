"""The isolated render subprocess and the working-dir lock that serializes it.

This is the security-critical half of the import pipeline, kept in its own module because it is
the one piece that must be reasoned about on its own: untrusted drawings are parsed **only** here,
in a short-lived child process spawned **by file path** (never `-m`, so the package's
Django/NetBox-importing `__init__` never loads into the child), under a timeout plus POSIX
CPU/address-space rlimits. A PDFium exploit is contained in that capped child — the NetBox worker
never decodes a byte of untrusted input.

The lock is the other half. A working-dir lockfile serializes renders *across worker processes*
(a thread lock could not), with stale-lock recovery, and every non-render working-dir mutation
(`reset`'s wipe, a restore's tree swap) takes it too — otherwise they would yank `uploads/`
/`images/` out from under a live render.
"""

import json
import os
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

from django.http import Http404, JsonResponse

from .import_base import busy_response, cfg
from .previews import render_hq_enabled
from .storage import safe_path, work_dir


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
    # The wizard's park for drawings excluded from the import (mirrors preprocess.py's
    # EXCLUDED_DIRNAME, IMPORT-24). Mirrored here for the same reason THUMBS_DIRNAME is: the Django
    # side needs the reserved names to validate an upload folder against, and importing the
    # subprocess module to read them would breach its isolation.
    EXCLUDED_DIRNAME = '_excluded'
    LOCK_NAME = '.import.lock'
    SCRIPT = 'preprocess.py'
    # The floor-code OCR reader (IMPORT-31), spawned under the *same* isolation contract as the
    # renderer — see `_spawn`. It reads only already-rendered, trusted PNGs and never opens a PDF,
    # so it adds no untrusted-input parsing path; PDF rasterization stays solely in `preprocess.py`.
    OCR_SCRIPT = 'ocr.py'

    # Render-quality multiplier handed to `preprocess.py --scale` when the operator has switched
    # `render_hq` on (READ-1). 1.5 lifts PdfFormat.RENDER_SCALE 2.0 -> 3.0 (~144 -> ~216 DPI), so
    # the room names printed in a plan stay legible when it is displayed below 1:1. It costs
    # roughly the SQUARE of that in pixels — hence the opt-in + the Settings-page warning — but it
    # cannot run the child out of address space: the renderer derives each page's scale from its
    # point size and clamps to PdfFormat.MAX_IMAGE_PX.
    HQ_SCALE = 1.5

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

    def _mem_hint(self):
        """An actionable remedy for an HQ render the render memory budget just defeated, naming the
        **effective** (post-headroom-clamp) ceiling so the operator sees the number actually in
        force, not the raw `render_mem_mb` the auto-clamp may have lowered."""
        eff = self._effective_mem_mb(cfg('render_mem_mb'))
        return ('High-quality rendering was stopped, most likely by exceeding the render memory '
                'budget (render_mem_mb=%s MB in effect). Raise render_mem_mb, or turn off '
                '“High quality floor plans” in Settings, then rebuild.' % eff)

    @staticmethod
    def _parse_summary(stderr):
        """The render diagnostics `preprocess.build` prints as its final `RENDER-SUMMARY {json}`
        line, as a dict — or `{}` when absent (an older child, or a non-build mode) or unparseable.
        Reads the **untruncated** stderr (the summary is the last line, past the 2000-char log cap)
        and scans from the end so only the current build's summary is read."""
        for line in reversed((stderr or '').splitlines()):
            marker = 'RENDER-SUMMARY '
            if line.startswith(marker):
                try:
                    return json.loads(line[len(marker):])
                except json.JSONDecodeError:
                    return {}
        return {}

    def _spawn(self, script_name, argv, label):
        """Spawn one of the plugin's subprocess scripts **by file path** (never `-m`, so the
        package's Django/NetBox-importing `__init__` never loads into the child), under the
        `render_timeout_s` timeout plus the POSIX CPU/address-space rlimits.

        **This is the single place the child-process isolation contract is applied.** Both the
        renderer (`run`) and the OCR reader (`run_ocr`) go through it, so a change to the timeout,
        the rlimits, or the by-file-path invocation can never harden one script and silently miss
        the other. Returns `(proc, None)` for a child that ran to completion — whatever its exit
        status, which the caller shapes — or `(None, error_dict)` when the timeout killed it."""
        base = work_dir(self.facility)
        base.mkdir(parents=True, exist_ok=True)
        script = str(Path(__file__).resolve().parent / script_name)
        timeout = cfg('render_timeout_s')
        kwargs = {}
        if os.name == 'posix':
            kwargs['preexec_fn'] = self._rlimits(
                timeout, self._effective_mem_mb(cfg('render_mem_mb')))
        try:
            proc = subprocess.run(
                [sys.executable, script, *argv],
                capture_output=True, text=True, cwd=str(base), timeout=timeout, **kwargs)
        except subprocess.TimeoutExpired:
            return None, {'ok': False, 'error': '%s timed out after %ss' % (label, timeout)}
        return proc, None

    def run_ocr(self, job_rel):
        """Spawn `ocr.py ocr --base <workdir> --job <job_rel>` and return its
        `{'ok': True, 'results': [...]}` — the floor-code read behind the wizard's "Populate with
        OCR" (IMPORT-31). `job_rel` is a working-dir-relative JSON job written by the caller.

        Isolation is `_spawn`'s, identical to a render's. The OCR child is nonetheless a *lighter*
        risk than the renderer: it opens only already-rendered PNGs the plugin itself produced, so
        untrusted-PDF parsing stays solely in `preprocess.py`. Runs **lock-free**, for
        `ensure_preview`'s reason — it only reads images, so a Populate must never 409 against an
        in-flight scan."""
        proc, timed_out = self._spawn(
            self.OCR_SCRIPT, ['ocr', '--base', str(work_dir(self.facility)), '--job', job_rel],
            'ocr')
        if timed_out is not None:
            return timed_out
        if proc.returncode != 0:
            # `ocr.py` exits with a diagnosable message when its deps or the vendored model are
            # missing — surface that rather than a bare failure, since it names the fix.
            return {'ok': False,
                    'error': (proc.stderr or proc.stdout).strip()[:2000] or 'ocr failed'}
        try:
            return {'ok': True, **json.loads(proc.stdout or '{}')}
        except json.JSONDecodeError:
            return {'ok': False, 'error': (proc.stderr or proc.stdout)[:1000] or 'ocr failed'}

    def run(self, mode, extra=None):
        """Spawn `preprocess.py <mode> --base <workdir> [extra...]` and shape its result. Invoked
        by file path (not `-m`) so the child stays minimal/isolated — no Django in-process. The
        render relies on this isolation: the `render_timeout_s` timeout plus POSIX CPU/address-space
        rlimits cap a runaway or malicious child. `extra` carries mode-specific argv (e.g.
        `--pdf`/`--out` for `preview`). `scan` reads the child's stdout as the JSON inventory;
        every other mode returns stderr as a log.

        A `build` additionally picks up the operator's `render_hq` setting as `--scale`, resolved
        here **once per run** rather than by the callers so no build path can forget it — and
        scoped to `build` because that is the mode whose output the map actually serves. `scan`
        thumbnails and the wizard's on-demand `preview` stay at standard scale on purpose: they
        exist to *identify* a plan, and `preview` is an interactive request that shouldn't spike
        memory."""
        base = work_dir(self.facility)
        # Whether this run is a **build** with high-quality rendering on — resolved **once**, since
        # it both selects `--scale` and decides whether a failure below is worth explaining in terms
        # of the render memory budget (HEALTH-3), and one run must not read the setting twice (nor
        # risk the two reads disagreeing across a concurrent toggle). `scan`/`preview` never carry
        # `--scale`, so a resource failure there isn't an HQ one.
        hq = mode == 'build' and render_hq_enabled()
        if hq:
            extra = [*(extra or []), '--scale', str(self.HQ_SCALE)]
        timeout = cfg('render_timeout_s')
        proc, timed_out = self._spawn(
            self.SCRIPT, [mode, '--base', str(base), *(extra or [])], mode)
        if timed_out is not None:
            result = timed_out
            if hq:
                result['hint'] = ('The render timed out (render_timeout_s=%ss). High-quality '
                                  'rendering is slower and heavier — raise render_timeout_s, or '
                                  'turn off “High quality floor plans” in Settings, then rebuild.'
                                  % timeout)
            return result
        if proc.returncode != 0:
            result = {'ok': False,
                      'error': (proc.stderr or proc.stdout).strip()[:2000] or (mode + ' failed')}
            # A negative return code means the child was killed by signal `-returncode` — an OOM
            # kill, a CPU-rlimit SIGXCPU, or a C-level allocation crash, all consistent with the
            # render outgrowing its limits. When it was an HQ build, say so and point at the fix
            # instead of surfacing a truncated, opaque traceback (HEALTH-3).
            if proc.returncode < 0:
                result['signal'] = -proc.returncode
                if hq:
                    result['hq_mem'] = True
                    result['hint'] = self._mem_hint()
            return result
        if mode == 'scan':
            try:
                return {'ok': True, **json.loads(proc.stdout or '{}')}
            except json.JSONDecodeError:
                return {'ok': False, 'error': (proc.stderr or proc.stdout)[:1000]}
        result = {'ok': True, 'log': proc.stderr.strip()[:2000]}
        # Surface the build's render diagnostics (HEALTH-3): sheets that couldn't render, and HQ
        # sheets the size cap clamped below full quality — a *successful* build that quietly lost
        # content/quality, which the frontend turns into a non-blocking heads-up. Only >0 counts
        # ride along, so an all-clean build's result is byte-identical to before.
        if mode == 'build':
            summary = self._parse_summary(proc.stderr)
            for k in ('hq_clamped', 'unrendered'):
                if summary.get(k):
                    result[k] = summary[k]
        return result

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

    @contextmanager
    def hold_lock(self):
        """Hold the working-dir lockfile for the duration of the block, yielding True when it was
        acquired and False when another import already holds a fresh one (the caller then 409s).

        The lock is not just a render gate: **every** working-dir mutation that isn't a render goes
        through here too — `ResetView`'s wipe and `RestoreArchiveView`'s tree swap would otherwise
        yank `uploads/`/`images/` out from under a live render subprocess. Release tolerates a
        missing lockfile, because a restore's atomic directory swap renames the whole working dir
        (lock included) away while we hold it."""
        lock = self._acquire_lock(cfg('render_timeout_s') * 2)
        if lock is None:
            yield False
            return
        try:
            yield True
        finally:
            try:
                os.unlink(str(lock))
            except FileNotFoundError:
                pass

    def run_locked(self, mode, prepare=None):
        """Run a render under the working-dir lock; 409 if one is already in flight.

        `prepare` (if given) is called **inside** the lock, immediately before the render — for
        `BuildView`'s `import-map.json` write, which must not land outside it: two concurrent builds
        writing the map first would let the winner render the loser's map."""
        with self.hold_lock() as held:
            if not held:
                return busy_response()
            if prepare is not None:
                prepare()
            return JsonResponse(self.run(mode))
