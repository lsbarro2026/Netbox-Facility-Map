"""Shared foundation for the import surface: the plugin-config reader, the request→facility
resolver, the shared "busy" response, and the permission-gated view base.

This module exists to keep the import surface **acyclic**. The import endpoints were split out of
a single 1100-line `imports.py` into `render_runner.py` (the isolated render subprocess),
`uploads.py` (byte ingestion), `serving.py` (authenticated manifest/media reads) and `imports.py`
(the remaining workflow endpoints). Every one of those needs `cfg`/`request_facility`, and three of
them need `ImportView`/`busy_response` — so leaving those helpers in `imports.py` would have made
`imports.py` both the top of the dependency graph and a dependency of its own parts. They live
here instead: this module imports only Django, NetBox, `access` and `storage`, so nothing in the
import surface ever has to import a sibling that imports it back.

Nothing here makes a policy decision of its own — the permission tier is `access.IMPORT_PERM` and
the slug validation is `storage.valid_facility`; this is the thin request-facing layer over them.
"""

from django.contrib.auth.mixins import PermissionRequiredMixin
from django.http import JsonResponse
from django.views import View

from netbox.plugins import get_plugin_config

from .access import IMPORT_PERM
from .storage import valid_facility


def cfg(key):
    return get_plugin_config('netbox_facilitymap', key)


def request_facility(request):
    """The validated `?facility=` slug for a request (default '' = the default facility), raising
    `ValueError` on a bad slug so the caller can 400. A facility namespaces the whole import — its
    working dir, uploads, images, and manifest (MULTI-2)."""
    return valid_facility(request.GET.get('facility') or '')


def busy_response():
    """The shared 409 for every endpoint that needs the working-dir lock and didn't get it — the
    render itself (`RenderRunner.run_locked`) and the non-render mutations (reset, restore) alike,
    so the wizard sees one "busy" shape whatever it collided with."""
    return JsonResponse({'ok': False, 'error': 'an import is already running'}, status=409)


class ImportView(PermissionRequiredMixin, View):
    """Base for the import-gated endpoints (mostly POST; the export download is a GET):
    unauthenticated → login redirect; authenticated without the import permission → 403
    (PermissionRequiredMixin default)."""
    permission_required = IMPORT_PERM
