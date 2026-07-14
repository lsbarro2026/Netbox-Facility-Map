"""Where the PDF-import pipeline keeps its files, and how to read them back safely.

The import wizard uploads PDFs and the render subprocess writes `images/` + `manifest.json`
into a single **working directory**. Unlike the package's `static/` tree (read-only at
runtime), this dir must be writable, so it lives under NetBox's `MEDIA_ROOT` by default —
`<MEDIA_ROOT>/netbox_facilitymap/` — overridable via the `work_dir` plugin setting.

`safe_path()` is the one traversal guard every file-serving / file-writing caller goes
through: it resolves a caller-supplied relative path *inside* the working dir and refuses
anything that escapes it (symlinks included, via `resolve()`).
"""

import json
import re
import shutil
from pathlib import Path

from django.conf import settings
from django.urls import reverse

from netbox.plugins import get_plugin_config

#: filename of the rendered manifest within the working dir.
MANIFEST_NAME = 'manifest.json'
#: the manifest served before any facility has been imported.
EMPTY_MANIFEST = {'siteplan': None, 'buildings': []}
#: top-level subdirs of the working dir that MediaView is allowed to serve from.
SERVE_ROOTS = ('images', 'uploads')
#: the `images/` subfolder holding the campus siteplan (vs a per-building `images/<siteSlug>/`).
#: Under per-Site read scoping (SEC-1) this is the one image dir NOT keyed by a Site slug, so it is
#: gated as a facility-wide asset. MUST match the literal `preprocess.py` writes the siteplan under
#: (`write_image("Siteplan", …)`) — preprocess is Django-free and can't import this constant.
SITEPLAN_DIRNAME = 'Siteplan'

#: a facility is a `dcim.SiteGroup`/`Region` slug used as a working-dir subfolder name; the
#: default facility is '' (the flat root — a single-facility install is byte-for-byte unchanged).
#: Slugs are `[-\w]+`; anything else is rejected before it becomes a directory name (the facility
#: rides an attacker-controllable query param — see MediaView/frontend_api).
_FACILITY_RE = re.compile(r'^[-\w]+$')


def valid_facility(facility):
    """Return `facility` if it's the default '' or a strict slug; raise `ValueError` otherwise.

    The one gate every facility-taking caller (work_dir, the import/blob views) passes an
    externally-supplied facility through before it namespaces a working-dir subfolder or a blob
    row. Rejects traversal (`..`, `/`), so a hostile `?facility=` can never escape the working dir.
    Also rejects the reserved names a facility subfolder would collide with — the default facility's
    own top-level `images/`/`uploads/` dirs — so a `dcim` slug like ``images`` can't nest into and
    corrupt the default facility's rendered output."""
    if facility and (not _FACILITY_RE.match(facility) or facility in SERVE_ROOTS):
        raise ValueError('invalid facility slug')
    return facility


def work_dir(facility=''):
    """Absolute path to the import working dir (created lazily by callers that write).

    Nested per facility: `<base>/<facility>` for a non-empty (validated) facility, the flat
    `<base>` for the default facility '' — so single-facility installs are untouched (MULTI-2)."""
    configured = get_plugin_config('netbox_facilitymap', 'work_dir')
    base = Path(configured) if configured else Path(settings.MEDIA_ROOT) / 'netbox_facilitymap'
    return base / valid_facility(facility) if facility else base


# Per-process memo of the parsed manifest, keyed by the file's (mtime_ns, size). The manifest
# is a build artifact rewritten by every `build` (new mtime/size), so a rebuild changes the key
# and the memo self-busts — preserving the "read fresh" *semantics* while sparing the hot
# server-rendered panels a re-read + re-parse on every Location/Site/Device/Rack page render.
_manifest_memo = {}  # {path_str: ((mtime_ns, size), parsed_dict)}


def read_manifest(facility=''):
    """Parsed ``manifest.json`` as a dict, or ``None`` when it's missing/unreadable.

    Reads the given facility's working dir (default '' = the flat root). Memoized on the file's
    (mtime, size) within the worker process; a rebuild changes the file and busts the memo. The
    memo is keyed by the (per-facility) path string, so each facility's manifest memoizes
    independently. Best-effort per worker (plain dict under the GIL — a rare race just re-parses,
    no lock needed; the render lockfile in ``imports.py`` is a separate concern) and per-process
    (each worker re-reads once after a rebuild — no cross-process coherence needed).

    Callers MUST treat the result as **read-only** — it is shared. Never raises: any OS/JSON
    error returns ``None``, so the server-rendered panels degrade to "no panel" exactly as the
    old inline reads did."""
    path = work_dir(facility) / MANIFEST_NAME
    try:
        st = path.stat()
    except OSError:
        return None
    key = (st.st_mtime_ns, st.st_size)
    memo = _manifest_memo.get(str(path))
    if memo and memo[0] == key:
        return memo[1]
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    _manifest_memo[str(path)] = (key, data)
    return data


def move_facility(old, new):
    """Move a facility's rendered artifacts (``manifest.json`` + ``images/`` + ``uploads/``) from
    ``old``'s working dir into ``new``'s, and return the list of names actually moved.

    The filesystem half of the orphan-reassignment recovery (`facilities.reassign_facility`), run
    **after** the blob rows have been re-keyed in the DB, so the rendered floor images/manifest
    follow the data to its new facility instead of being stranded under the old key. Moving the
    **named** artifacts one by one — rather than renaming the directory — is what makes the default
    facility's flat root (``old=''``) safe: that root also holds *other* facilities' subfolders, so a
    directory rename would drag them along; moving only ``manifest.json``/``images``/``uploads``
    touches exactly this facility's output. Refuses when the destination already holds a rendered
    manifest (mirrors the DB collision guard in `facilities.reassign_facility`). Best-effort per
    artifact: a source that doesn't exist is skipped. Transient files (the import lock) are left
    behind. Raises ``ValueError`` on an invalid slug or a populated destination."""
    old = valid_facility(old)
    new = valid_facility(new)
    if old == new:
        return []
    src = work_dir(old)
    dst = work_dir(new)
    if (dst / MANIFEST_NAME).exists():
        raise ValueError('target facility already has rendered content')
    dst.mkdir(parents=True, exist_ok=True)
    moved = []
    for name in (MANIFEST_NAME,) + SERVE_ROOTS:
        source = src / name
        if not source.exists():
            continue
        shutil.move(str(source), str(dst / name))
        moved.append(name)
    return moved


def safe_path(rel, facility=''):
    """Resolve ``rel`` inside the given facility's working dir, rejecting traversal. Raises
    ValueError if the resolved path escapes it (or the facility slug is invalid). Returns an
    absolute ``Path`` (which may not exist yet — callers check)."""
    base = work_dir(facility).resolve()
    full = (base / rel).resolve()
    if full != base and base not in full.parents:
        raise ValueError('path escapes the working directory')
    return full


def media_url(image, facility='', version=None):
    """Authenticated URL for a working-dir-relative image path (e.g. the manifest's
    ``images/<slug>/<id>.png``). Empty string when there is no image. Used by the
    server-rendered Location pages; the SPA builds the same URL from ``window.MAP.media``.

    The reversed ``api-media`` path stays the working-dir-relative ``images/…``; a non-default
    ``facility`` travels as a ``?facility=<slug>`` query param (MediaView resolves the per-facility
    working dir from it). Pass ``version`` (the manifest's ``built`` token) for rendered build
    artifacts: the ``v=`` suffix lets MediaView mark them immutably cacheable, and a rebuild busts
    the cache by minting a new token. Omit it for files that change between imports."""
    if not image:
        return ''
    url = reverse('plugins:netbox_facilitymap:api-media', kwargs={'path': image})
    params = []
    if facility:
        params.append('facility=%s' % facility)
    if version:
        params.append('v=%s' % version)
    return '%s?%s' % (url, '&'.join(params)) if params else url
