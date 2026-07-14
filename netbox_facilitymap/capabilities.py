"""capabilities.py — the plugin's optional-capability registry (the add-on framework).

Single source of truth for *which* optional features an install has switched on, and *what*
each one contributes to the plugin's registration surfaces. It is the generalization of the
`drawing_formats` registry (PKG-1) past filetypes: "the core detects which add-ons are installed
and lights up their functionality" **is** this registry's `available()` probe, exactly as
`drawing_formats.available()` already gates which import formats are offered.

Everything ships in the one wheel, from the one repo, at one version — a capability can never be
"a version behind" the core because it *is* the core wheel. Adding an add-on is a new `Capability`
subclass plus one `CAPABILITIES` entry; the surfaces below aggregate it automatically, so a
capability never edits a consumer directly (the "gate at the registry, never in each consumer"
rule PKG-1 established). See DESIGN.md §4 and `architecture/09-extending.md`.

**Two gate kinds** (`Capability.available()`), either or both:

  * **Dependency gate** — `requires_module` / `requires_binary`, probed with
    `importlib.util.find_spec` (via `drawing_formats._module_installed`) and `shutil.which`. The
    exact import-safe primitive PKG-1 uses: `find_spec` locates a module's spec **without executing
    it**, so no optional decoder ever loads into the NetBox worker. This is how a capability that
    needs an optional package (a new filetype's decoder) is gated.
  * **Feature-flag gate** — `setting_flag`, a truthy `PLUGINS_CONFIG` key. This is how a *pure
    first-party* capability with no external dependency (e.g. notetaking, NOTE-1) is switched on:
    there is nothing to probe, so the operator enables it in config. Defaults **off**, so the core
    stays barebones until opted into.

**Isolation contract (mirrors `drawing_formats`').** The module top level is **pure stdlib** (plus
the import-safe `drawing_formats`) — no Django, no decoders. `available()` never imports the
optional dependency it probes for; the feature-flag gate **lazy-imports** `get_plugin_config`
*inside* `available()`, so importing this module loads no Django and no native code. Unlike
`drawing_formats`, this module is **never imported by `preprocess.py`** (the render subprocess) —
the format axis the subprocess needs lives entirely in `drawing_formats`, and this registry only
runs in the long-lived worker, so its lazy Django read only ever executes where Django is present.

**No double-gate with `drawing_formats`.** The filetype axis stays authoritative in
`drawing_formats`: `DRAWING_EXTS` is still the single source every consumer (upload sniff, render
dispatch, the frontend accept-list) derives from. The `FormatCapability` entries below *report* the
optional-format extras as capabilities (so the enabled set surfaces to `window.MAP.capabilities`
and any settings UI) by **delegating** their `available()` to the `drawing_formats` registry — they
re-probe nothing and contribute nothing to the backend surfaces, since formats already flow through
`DRAWING_EXTS`. A filetype add-on is thus the special case "a capability that reports one or more
`DrawingFormat`s"; a *feature* add-on (a UI tool, an endpoint) is the general case.
"""

import shutil

from .drawing_formats import FORMATS, _module_installed


class Capability:
    """One optional capability. Declares how to detect whether it is installed/enabled (the two
    gate kinds above) and what it contributes to each registration surface. Subclasses override
    only the attributes that gate them and only the contribution hooks for the surfaces they touch;
    every hook defaults to an empty contribution, so a capability is a small declarative object.

    Registry schema (class attributes):
      key             stable slug, e.g. 'gis', 'notes' — surfaced in `window.MAP.capabilities`
      verbose_name    human label for a settings / capability listing
      requires_module top-level module name(s) whose presence makes this capability available,
                      probed import-safely via `find_spec` (available only when **all** are
                      installed). Empty → no pip dependency to gate.
      requires_binary external executable alternative(s) probed via `shutil.which` (available when
                      **any** is found). Empty → no binary to gate.
      extra           the pip extra that installs this capability (for an "install the extra" hint /
                      display). Empty for a flag-gated or core capability.
      setting_flag    a `PLUGINS_CONFIG` key that must be truthy for this capability (the
                      feature-flag gate). None → not flag-gated. Its default belongs in
                      `default_settings()` so the operator can flip it on; default it off.
    """

    key = ""
    verbose_name = ""
    requires_module = ()
    requires_binary = ()
    extra = ""
    setting_flag = None

    def available(self):
        """True if this capability's gates all pass, so the core should light up its contributions.
        Probed WITHOUT importing the optional dependency (the module-isolation contract): available
        iff **every** `requires_module` is importable, **at least one** `requires_binary` (if any)
        is on PATH, and — when `setting_flag` is set — that flag is truthy. A capability declaring
        none of the three is always available."""
        if not all(_module_installed(m) for m in self.requires_module):
            return False
        if self.requires_binary and not any(shutil.which(b) for b in self.requires_binary):
            return False
        if self.setting_flag is not None and not self._flag_enabled(self.setting_flag):
            return False
        return True

    @staticmethod
    def _flag_enabled(key):
        """Whether the `PLUGINS_CONFIG` feature flag `key` is truthy. Lazy-imports
        `get_plugin_config` **inside** the method (the isolation contract): this module's top level
        stays Django-free, and the read only ever runs in the worker (this registry is never
        imported by the render subprocess). A key with no registered default — the reason to declare
        it in `default_settings()` — makes `get_plugin_config` raise; that counts as 'off'."""
        from netbox.plugins import get_plugin_config
        try:
            return bool(get_plugin_config('netbox_facilitymap', key))
        except Exception:
            return False

    # ---- Declarative contribution hooks. Each returns an empty contribution by default; a
    # capability overrides only the surfaces it touches. The aggregators below fold the ENABLED
    # capabilities' contributions into each surface (except default_settings — see that aggregator).

    def default_settings(self):
        """`PLUGINS_CONFIG` defaults this capability adds (its own `setting_flag`, plus any tunables),
        merged into `PluginConfig.default_settings`. Keys must not shadow a core setting."""
        return {}

    def url_patterns(self):
        """Django `path()` entries appended to `urls.urlpatterns` (writes gate on
        `change_facilitymapblob`, reads on login, ORM-scoped — no token proxy)."""
        return []

    def nav_items(self):
        """`PluginMenuItem` entries appended into the plugin's `PluginMenu` group
        (permission-gate them like the existing items)."""
        return []

    def template_extensions(self):
        """`PluginTemplateExtension` subclasses concatenated onto `template_content.template_extensions`."""
        return []

    def dashboard_widgets(self):
        """Dashboard-widget classes registered from `AppConfig.ready()` (NetBox does **not**
        auto-discover widgets — the manual-registration gotcha)."""
        return []


class FormatCapability(Capability):
    """A capability that *reports* one or more optional import formats (a pip extra, or Visio's
    external binary). Its availability **delegates** to the authoritative `drawing_formats`
    registry — it re-probes nothing, so there is no second gate that could disagree — and it
    contributes nothing to the backend surfaces, because formats already flow through
    `DRAWING_EXTS`. Its whole job is to make the optional-format extras part of the unified enabled
    set (so `window.MAP.capabilities` / a settings UI can reflect "GIS import is on"), which is the
    filetype slice of the general add-on mechanism.

    `format_names` are the `DrawingFormat.name`s this capability represents; it is available iff any
    of them is available in `drawing_formats` — so a `[gis]` capability lights up exactly when the
    GIS formats do, and Visio lights up exactly when its `soffice` binary is present."""

    format_names = ()

    def available(self):
        names = set(self.format_names)
        return any(f.name in names and f.available() for f in FORMATS)


class LocationCreateCapability(Capability):
    """Inline creation of a room's NetBox Location from the floor bind panel (LOC-1) — the first
    *feature* add-on (the `FormatCapability`s above only *report* optional filetypes; this one lights
    up real behaviour). Pure first-party code with no external dependency, so it is switched on by
    the **feature-flag gate** (`setting_flag`), defaulted **off**: NetBox stays the source of truth
    for Locations, and installs that model devices against Racks/Sites rather than a Location-per-room
    opt in to letting a permitted user create the child Location without leaving the map.

    This flag is only the *install-wide* gate. The create endpoint is stricter still — it also
    enforces the `dcim.add_location` object permission **per user**, server-side (see
    `frontend_api.NbLocationCreateView`), because this is the plugin's one write into `dcim` core.
    The two are orthogonal: this flag lights the feature up for the install; the object permission
    decides which users may actually create."""

    key = "location-create"
    verbose_name = "Inline NetBox Location creation from the bind panel"
    setting_flag = "allow_location_create"

    def default_settings(self):
        return {"allow_location_create": False}


class SvgCapability(FormatCapability):
    key = "svg"
    verbose_name = "SVG vector plans"
    extra = "svg"
    format_names = ("svg",)


class CadCapability(FormatCapability):
    key = "cad"
    verbose_name = "AutoCAD DXF import"
    extra = "cad"
    format_names = ("dxf",)


class GisCapability(FormatCapability):
    key = "gis"
    verbose_name = "GIS overlays (Shapefile / GeoJSON / KML)"
    extra = "gis"
    format_names = ("shp", "geojson", "kml", "kmz")


class VisioCapability(FormatCapability):
    # No pip extra — the `.vsdx/.vsd` formats gate on the external `soffice` binary in
    # `drawing_formats`; this capability delegates to that, so it reports Visio as enabled exactly
    # when LibreOffice is on PATH.
    key = "visio"
    verbose_name = "Visio import (needs the soffice binary)"
    format_names = ("vsdx", "vsd")


# The registry: one entry per KNOWN capability (installed/enabled or not). Adding an add-on is a new
# Capability subclass plus one entry here — the aggregators below wire its contributions into every
# surface, so nothing else in the package changes. The shipped set is the optional-format extras
# (the filetype axis, delegating to drawing_formats) plus `location-create`, the first flag-gated
# *feature* add-on — the pattern any future first-party feature (e.g. notetaking) plugs into.
CAPABILITIES = (
    LocationCreateCapability(),
    SvgCapability(), CadCapability(), GisCapability(), VisioCapability(),
)


def enabled():
    """The subset of `CAPABILITIES` whose gates pass — the "installed add-ons" the core lights up.
    Evaluated on demand (availability can change with a worker restart, the same activation model
    `drawing_formats` uses); the aggregators below call this once per surface."""
    return tuple(c for c in CAPABILITIES if c.available())


def enabled_keys():
    """The enabled capabilities' `key`s, injected into `window.MAP.capabilities` so the frontend can
    lazy-load + gate a capability's tool on its presence (see `App.hasCapability`)."""
    return [c.key for c in enabled()]


def is_enabled(key):
    """True when the capability with `key` is currently enabled (its gates all pass). Lets a backend
    consumer gate a feature endpoint on an install-wide capability flag — the server-side mirror of
    the frontend's `App.hasCapability(key)` — without re-deriving the probe (e.g. the
    `location-create` create endpoint refuses the write when the operator hasn't switched it on)."""
    return key in enabled_keys()


def all_default_settings():
    """Every KNOWN capability's `default_settings()` merged (not just `enabled()`): a flag-gated
    capability's own `setting_flag` default must always be registered, else the operator could never
    flip it on (`get_plugin_config` would raise on an unregistered key, gating the capability off
    forever). Flags default off, so registering them keeps the core barebones. A capability must not
    shadow a core setting key."""
    merged = {}
    for c in CAPABILITIES:
        merged.update(c.default_settings())
    return merged


def all_url_patterns():
    """The enabled capabilities' `url_patterns()`, concatenated for `urls.urlpatterns`."""
    patterns = []
    for c in enabled():
        patterns.extend(c.url_patterns())
    return patterns


def all_nav_items():
    """The enabled capabilities' `nav_items()`, concatenated for the plugin `PluginMenu` group."""
    items = []
    for c in enabled():
        items.extend(c.nav_items())
    return items


def all_template_extensions():
    """The enabled capabilities' `template_extensions()`, concatenated for
    `template_content.template_extensions`."""
    exts = []
    for c in enabled():
        exts.extend(c.template_extensions())
    return exts


def all_dashboard_widgets():
    """The enabled capabilities' `dashboard_widgets()`, concatenated for registration in
    `AppConfig.ready()` (NetBox doesn't auto-discover widgets)."""
    widgets = []
    for c in enabled():
        widgets.extend(c.dashboard_widgets())
    return widgets
