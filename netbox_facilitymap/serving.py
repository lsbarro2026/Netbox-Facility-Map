"""Authenticated serving of the import's output: the manifest and the rendered media.

These are the only **read**-tier endpoints in the import surface. Everything else in it requires
`import_facilitymapblob`; these ride the map's own read gate (`MapReadAccessMixin` — login-only by
default, `view_facilitymapblob` when `require_view_permission` is on). That different permission
tier, plus a concern that is entirely HTTP caching rather than rendering, is why they live apart
from the import workflow.

Rendered floor plans are streamed from `MEDIA_ROOT` through a login-gated view, never exposed at a
guessable public static URL. Browser caching is allowed but always `private` (immutable when the URL
carries the manifest's `?v=<built>` token, revalidated otherwise) so shared caches never store the
authenticated images.

Per-Site read scoping (SEC-1) is the other half of this module. The viewable-Site set
(`access.viewable_site_slugs`) and the manifest filter itself (`access.scope_manifest`, shared with
the tokened REST manifest read in `api/views.py`) both live in `access`; what is left here is the
conditional-response half, which only these page-mount views need.
"""

import hashlib
import mimetypes
from urllib.parse import quote

from django.http import FileResponse, Http404, HttpResponse, HttpResponseBadRequest, JsonResponse
from django.utils.cache import get_conditional_response
from django.utils.http import http_date
from django.views import View

from .access import MapReadAccessMixin, scope_manifest, viewable_site_slugs
from .import_base import cfg, request_facility
from .storage import (EMPTY_MANIFEST, MANIFEST_NAME, SERVE_ROOTS, SITEPLAN_DIRNAME, read_manifest,
                      safe_path, work_dir)


def _scope_etag(etag, viewable):
    """Fold a stable digest of the sorted viewable slugs into `etag`, so a permission change (a
    different viewable set for the same unchanged manifest file) busts that user's conditional
    cache. `etag` is the quoted `"mtime-size"` string from `_file_validators`; the digest is spliced
    inside the closing quote. Media stays `private`, so this only guards a user's *own* revalidation
    across a permission change — cross-user leakage is already impossible."""
    digest = hashlib.sha1('\n'.join(sorted(viewable)).encode()).hexdigest()[:12]
    return '%s-%s"' % (etag[:-1], digest)


def _file_validators(stat):
    """(etag, last_modified) HTTP validators for a working-dir file, derived from its
    stat. mtime+size is a sufficient change signal here: every file under the working dir
    is either rewritten by an import (new mtime) or replaced by an upload."""
    return '"%d-%d"' % (int(stat.st_mtime), stat.st_size), int(stat.st_mtime)


def serve_file(full, parts, facility=''):
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
    if cfg('x_accel_redirect'):
        location = (cfg('x_accel_location') or '/facilitymap-internal/').rstrip('/')
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
    its `built` token), but an unchanged manifest costs only a 304.

    The validators come from a bare `stat()`, so the **conditional response is decided before the
    manifest is read at all** — a revalidating client costs one stat, not a full read + JSON parse
    of every building on the campus. Only a 200 body reads, and it goes through
    `storage.read_manifest`'s (mtime, size)-keyed memo, so repeat 200s across a worker's lifetime
    re-parse only after a rebuild."""

    def get(self, request):
        try:
            facility = request_facility(request)
        except ValueError:
            return HttpResponseBadRequest('invalid facility')
        path = work_dir(facility) / MANIFEST_NAME
        try:
            stat = path.stat()
        except OSError:
            return self._stub()
        etag, last_modified = _file_validators(stat)
        # Per-Site read scoping (SEC-1): filter the buildings to the viewer's viewable Sites so a
        # user whose object permissions hide a Site never even learns that building exists. The
        # viewable set folds into the ETag so a permission change busts the user's own 304. Off by
        # default (`viewable is None`) → the manifest is served whole, exactly as before.
        viewable = viewable_site_slugs(request.user, facility)
        if viewable is not None:
            etag = _scope_etag(etag, viewable)
        not_modified = get_conditional_response(request, etag=etag, last_modified=last_modified)
        if not_modified is not None:
            not_modified['ETag'] = etag
            return not_modified
        # `read_manifest` returns None for an unreadable/corrupt file, which collapses to the same
        # stub the missing-file branch serves (the §10 "a truncated manifest is indistinguishable
        # from a fresh install" invariant — why `preprocess.write_manifest` is atomic). Reaching
        # here with a *matching* validator is not possible for a corrupt file: the client could only
        # hold that ETag from an earlier 200 at the same mtime+size, which parsed.
        data = read_manifest(facility)
        if data is None:
            return self._stub()
        # The memo's dict is shared and read-only; `scope_manifest` copies, and the unscoped path
        # only serializes it.
        if viewable is not None:
            data = scope_manifest(data, viewable)
        response = JsonResponse(data, safe=False)
        response['ETag'] = etag
        response['Last-Modified'] = http_date(last_modified)
        response['Cache-Control'] = 'private, no-cache'
        return response

    def _stub(self):
        """The pre-import (or unreadable-manifest) empty manifest, `no-store` so a later import is
        never masked by a cached "empty facility"."""
        response = JsonResponse(EMPTY_MANIFEST, safe=False)
        response['Cache-Control'] = 'no-store'
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
    setting on, `serve_file` offloads the transfer to nginx (see `serve_file`). The auth +
    traversal + serve-root gate below runs first either way, and the validators/Cache-Control
    are set here in both modes — so revalidation stays worker-authoritative regardless of nginx."""

    def get(self, request, path):
        try:
            facility = request_facility(request)
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
        # runs BEFORE `serve_file`, so the x_accel offload never hands nginx an out-of-scope path.
        viewable = viewable_site_slugs(request.user, facility)
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
        response = serve_file(full, parts, facility)
        response['ETag'] = etag
        response['Last-Modified'] = http_date(last_modified)
        response['Cache-Control'] = ('private, max-age=31536000, immutable'
                                     if 'v' in request.GET else 'private, no-cache')
        return response
