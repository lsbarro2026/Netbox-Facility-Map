"""Facility Map — NetBox plugin.

A self-contained NetBox 4.x plugin: import a facility's floor-plan PDFs in-app, draw and
bind room polygons, and render the same map natively inside NetBox. The framework-free
frontend lives under `static/`; editor JSON state becomes `FacilityMapBlob` rows and room
polygons the relational `Room` model; NetBox data is read straight from the ORM. PDF
import (`preprocess.py` + the `api/import/*` endpoints) rasterizes uploads into floor
images under `MEDIA_ROOT`, served back through authenticated views. See DESIGN.md for the
full design.
"""

# Single source of truth for the plugin version. `pyproject.toml` reads this at build time
# (`[tool.setuptools.dynamic]` → `attr = "netbox_facilitymap.__version__"`), and
# `FacilityMapConfig.version` below is set from it — so a release bumps exactly this one line.
# Keep it a plain string literal: setuptools resolves it via AST without importing this module
# (which would fail at build time, before NetBox is present).
__version__ = "1.0.0"

from netbox.plugins import PluginConfig

from . import capabilities


class FacilityMapConfig(PluginConfig):
    name = 'netbox_facilitymap'
    verbose_name = 'Facility Map'
    description = 'Navigable siteplan → building → floor → room map linked to NetBox Locations'
    version = __version__
    author = 'Liam Sbarro'
    author_email = 'ljs.social2005@gmail.com'
    base_url = 'facilitymap'
    # Supported NetBox range. Plugin/menu/restrict()/template-extension APIs shift between
    # 4.x minors, so keep this pinned to the tested span and re-verify when widening it.
    min_version = '4.1.7'
    max_version = '4.6.99'  # whole 4.6.x patch line; only minors shift the APIs we depend on
    # Import/render guardrails (all overridable in PLUGINS_CONFIG). `work_dir=None` means
    # "<MEDIA_ROOT>/netbox_facilitymap" (resolved in storage.py); the caps bound the
    # untrusted-PDF attack surface.
    default_settings = {
        # Optional read gate. Off by default → map reads are login-only (any authenticated user
        # sees every floor plan). On → the map page, authenticated manifest/media, and blob JSON
        # additionally require `view_facilitymapblob` (editors, who hold `change_`, keep read
        # access). See access.py and the README security model.
        'require_view_permission': False,
        # Optional per-Site read scoping (SEC-1), independent of and additive to the flat gate
        # above. Off by default → floor plans/manifest are visible to anyone who clears the
        # map-read gate. On → the manifest and floor-plan media (`images/<siteSlug>/…`) are
        # additionally filtered to the Sites a viewer may see (dcim.Site object permissions, via
        # `Site.objects.restrict(user,'view')`), so a user whose object permissions hide a Site no
        # longer sees that building's floor-plan pixels. Fail-closed: a building whose siteSlug
        # matches no viewable Site is hidden. See access.py and the OPERATING security model.
        'scope_reads_to_sites': False,
        # Which NetBox Location field supplies a Location-mode floor's display label on the
        # building's floor cards ('name' / 'slug' / 'description'). The import wizard's own
        # per-import picker (window.MAP.floorLabelField, see MapView) overrides this without
        # editing config; an invalid value here falls back to 'name'.
        'floor_label_field': 'name',
        'work_dir': None,        # writable dir for uploads/images/manifest (None → MEDIA_ROOT)
        'max_pdf_mb': 50,        # reject a single uploaded PDF larger than this
        'max_pdfs': 400,         # reject an import with more PDFs than this
        'max_zip_mb': 200,       # reject a single uploaded .zip larger than this
        'max_zip_uncompressed_mb': 2048,  # cumulative decompressed cap (zip-bomb guard)
        'render_timeout_s': 300,  # kill the render subprocess after this many seconds
        # RLIMIT_AS for the render subprocess (POSIX). This default is auto-clamped down to a
        # safe fraction of detected host memory (RenderRunner._effective_mem_mb) so a render
        # can't allocate the whole machine and OOM-kill a worker on a small host; an explicit
        # override here opts out of the clamp (the remedy when a Visio/soffice conversion, which
        # reserves a large virtual address space, is killed by too tight a limit).
        'render_mem_mb': 2048,
        # Optional nginx offload for the authenticated media served by MediaView (floor plans,
        # uploads, on-demand previews). Off by default → the worker streams via FileResponse,
        # unchanged. When on, MediaView returns an empty `X-Accel-Redirect` response so nginx
        # streams the bytes and the gunicorn worker is freed after only the auth + traversal
        # check — the fix for worker exhaustion (slow/many concurrent image loads → 502).
        # Requires a matching nginx `internal` location: its prefix must equal `x_accel_location`
        # (below) and its `alias` must point at the resolved work_dir. The permission + traversal
        # check stays in the worker, so media is never exposed at a public URL — verify by hitting
        # the internal prefix directly (must 404). See README "Troubleshooting: intermittent 502s"
        # for the copy-paste snippet, path-resolution rules, and the verify steps.
        'x_accel_redirect': False,
        'x_accel_location': '/facilitymap-internal/',
        # Opt-in backups (run `facilitymap_backup`/`facilitymap_restore`; nothing runs on its
        # own). `backup_dir=None` means "<MEDIA_ROOT>/facilitymap-backups" (resolved in
        # backup.py); `backup_max_mb` caps the dir, FIFO-pruned oldest-first on every backup.
        'backup_dir': None,      # writable dir for backup .tar.gz files (None → MEDIA_ROOT sibling)
        'backup_max_mb': 1024,   # prune oldest backups once the dir exceeds this (newest always kept)
        # Optional-capability defaults (the add-on framework, ADDON-2): every KNOWN capability's
        # own settings — chiefly its feature flag, defaulted off so the core stays barebones —
        # merged in so an operator can flip one on. See capabilities.all_default_settings; today
        # this registers `allow_location_create` (LOC-1, defaulted off) — the format-extra
        # capabilities contribute nothing.
        **capabilities.all_default_settings(),
    }

    def ready(self):
        # NetBox auto-discovers navigation/template_content but NOT dashboard widgets, so
        # import the module here to run its `@register_widget` decorator at app-ready.
        super().ready()
        from . import dashboard  # noqa: F401
        # Register any dashboard widgets contributed by an enabled capability (same manual step —
        # NetBox doesn't auto-discover widgets). Empty until a capability ships one (ADDON-2 seam).
        from extras.dashboard.widgets import register_widget
        for widget in capabilities.all_dashboard_widgets():
            register_widget(widget)


config = FacilityMapConfig
