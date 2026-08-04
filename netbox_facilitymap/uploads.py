"""Byte ingestion: the two endpoints that get drawings onto disk, plus the acceptance gate and the
zip member→destination mapping they share.

Nothing here decodes a drawing. Uploads are *sniffed* (header magic) and size/traversal-capped,
then written to the working dir; the actual parse still happens exclusively in the isolated render
subprocess (`render_runner.RenderRunner`), so this module does not breach that isolation.

Accepted drawing inputs (`DRAWING_EXTS`) and their header magic (`sniff`) come from the
`drawing_formats` registry — the one Python source of truth, so adding a format is a single handler
entry there. The base install carries PDFs plus common raster plan formats (public measured-drawing
collections — e.g. the Library of Congress HABS/HAER/HALS scans — ship as TIFF/JPEG/GIF, never
PDF); advanced formats (SVG/DXF/Visio/GIS) are gated behind their pip extra or external binary, so
`DRAWING_EXTS` here is the *installed* set (PKG-1). An upload of a recognized-but-uninstalled
format is rejected with `install_hint_for`, naming the extra to add. The registry is pure stdlib
(its decoders load lazily, only in the render subprocess), so importing it here does not pull
pypdfium2/Pillow into the worker.

The upload layer also accepts a drawing's COMPANION siblings (a Shapefile's `.shx/.dbf/.prj/.cpg`)
so a multi-file set stays together in one folder; those are NOT drawings (kept out of
DRAWING_EXTS), so the scan/build/mapping layers still see one logical `.shp` drawing.
"""

import os
import zipfile

from django.http import HttpResponseBadRequest, JsonResponse

from .drawing_formats import (COMPANION_EXTS, DRAWING_EXTS, install_hint_for,
                              sniff as _sniff, sniff_companion as _sniff_companion)
from .import_base import ImportView, cfg, request_facility
from .storage import safe_path, work_dir

UPLOAD_EXTS = DRAWING_EXTS + COMPANION_EXTS

# Streaming chunk for zip extraction. Also the window the acceptance sniff reads its first bytes
# from, so a member is rejected before more than one chunk is ever written.
CHUNK_BYTES = 1024 * 1024


def _upload_ok(rel, head):
    """Cheap upload-acceptance gate for a path + its leading bytes: a companion sibling is sniffed
    by its (weaker) companion signature, any other accepted file by its drawing magic. False for an
    unaccepted extension or a failed sniff. The real decode is still the render subprocess."""
    ext = os.path.splitext(rel)[1].lower()
    if ext in COMPANION_EXTS:
        return _sniff_companion(head, ext)
    return _sniff(head) is not None


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


class UploadView(ImportView):
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
            facility = request_facility(request)
            target = safe_path('uploads/' + rel, facility)
            parts = target.relative_to(work_dir(facility).resolve()).parts
        except ValueError:
            return HttpResponseBadRequest('invalid path')
        if not parts or parts[0] != 'uploads':
            return HttpResponseBadRequest('invalid path')

        up = request.FILES.get('file')
        if up is None:
            return HttpResponseBadRequest('missing file')
        if up.size > cfg('max_pdf_mb') * 1024 * 1024:
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


class UploadZipView(ImportView):
    """Extract one uploaded `.zip` of building drawings (PDFs and/or raster images) into
    `<workdir>/uploads/...`, mapping members the same way folder uploads are (`_zip_targets`).
    Extraction only writes bytes and sniffs magic — drawings are still parsed solely in the
    isolated render subprocess, so this does not breach that isolation. Guarded against oversize
    archives, zip bombs (per-file + cumulative decompressed caps), path traversal, and
    symlink/special members."""

    @staticmethod
    def _extract_member(zf, info, targets, facility, base, per_file_cap, total_cap, total_so_far):
        """Validate one zip member and stream it to its `uploads/` destination.

        Returns `(error_response, written_bytes)` — `error_response` is None on success, otherwise
        the response the view must return immediately (every guard here is fail-closed, and a
        rejected archive is abandoned mid-extraction by design: a partially-extracted zip is
        recoverable by re-uploading, whereas continuing past a hostile member is not).

        `total_so_far` is the cumulative decompressed byte count of the members already extracted.
        It has to come in rather than be accumulated by the caller alone, because the zip-bomb cap
        trips **mid-file** — a single member can blow the archive-wide budget partway through its
        own stream, and the write has to stop there, not after the member completes."""
        # Refuse symlinks/special files — safe_path's resolve() would follow them.
        mode = (info.external_attr >> 16) & 0o170000
        if mode and mode != 0o100000:
            return HttpResponseBadRequest('zip contains a non-regular file'), 0
        folder, fname = targets[info.filename]
        try:
            target = safe_path('uploads/' + folder + '/' + fname, facility)
            parts = target.relative_to(base.resolve()).parts
        except ValueError:
            return HttpResponseBadRequest('zip entry escapes the working directory'), 0
        if not parts or parts[0] != 'uploads':
            return HttpResponseBadRequest('invalid zip entry path'), 0

        target.parent.mkdir(parents=True, exist_ok=True)
        part = target.with_name(target.name + '.part')
        written = 0
        with zf.open(info) as src, open(part, 'wb') as dst:
            chunk = src.read(CHUNK_BYTES)
            if not _upload_ok(fname, chunk[:16]):
                os.unlink(part)
                return HttpResponseBadRequest(
                    'zip contains an unsupported file (%s)' % fname), 0
            while chunk:
                written += len(chunk)
                if written > per_file_cap:
                    os.unlink(part)
                    return JsonResponse(
                        {'ok': False, 'error': 'a drawing exceeds the size limit'},
                        status=413), written
                if total_so_far + written > total_cap:
                    os.unlink(part)
                    return JsonResponse(
                        {'ok': False, 'error': 'zip decompresses too large'}, status=413), written
                dst.write(chunk)
                chunk = src.read(CHUNK_BYTES)
        os.replace(part, target)
        return None, written

    def post(self, request):
        up = request.FILES.get('file')
        if up is None:
            return HttpResponseBadRequest('missing file')
        if not (up.name or '').lower().endswith('.zip'):
            return HttpResponseBadRequest('a .zip file is required')
        if up.size > cfg('max_zip_mb') * 1024 * 1024:
            return JsonResponse({'ok': False, 'error': 'zip exceeds size limit'}, status=413)
        if not up.read(4).startswith(b'PK\x03\x04'):
            return HttpResponseBadRequest('not a zip (bad magic bytes)')
        up.seek(0)

        try:
            facility = request_facility(request)
        except ValueError:
            return HttpResponseBadRequest('invalid facility')
        max_pdfs = cfg('max_pdfs')
        per_file_cap = cfg('max_pdf_mb') * 1024 * 1024
        total_cap = cfg('max_zip_uncompressed_mb') * 1024 * 1024
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
                    error, written = self._extract_member(
                        zf, info, targets, facility, base, per_file_cap, total_cap, total)
                    total += written
                    if error is not None:
                        return error
                    # report drawings, not companions
                    if targets[info.filename][1].lower().endswith(DRAWING_EXTS):
                        count += 1
        except zipfile.BadZipFile:
            return HttpResponseBadRequest('corrupt zip file')
        return JsonResponse({'ok': True, 'count': count})
