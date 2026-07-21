"""Unit tests for the optional-capability registry (`capabilities.py`) — the add-on framework
(ADDON-2).

Exercises both gate kinds (dependency + feature-flag), the surface aggregators, and the
**no-double-gate** delegation of the format-extra capabilities to `drawing_formats`, using
**synthetic** capabilities so the framework is proven independently of any shipped feature. These
run settings-only (no DB): they import the package (Django is configured by pytest-django) but touch
no models.
"""

import ast
import pathlib

from netbox_facilitymap import capabilities as cap
from netbox_facilitymap import drawing_formats as df
from netbox_facilitymap.capabilities import Capability


# ---- Dependency gate (requires_module / requires_binary) --------------------------------------

class _ModuleCap(Capability):
    key = "mod"
    requires_module = ("some_optional_pkg",)


def test_dependency_gate_probes_module(monkeypatch):
    c = _ModuleCap()
    monkeypatch.setattr(cap, "_module_installed", lambda name: False)
    assert c.available() is False
    # Available only when the declared module is importable (probed via find_spec, not imported).
    monkeypatch.setattr(cap, "_module_installed", lambda name: name == "some_optional_pkg")
    assert c.available() is True


class _BinaryCap(Capability):
    key = "bin"
    requires_binary = ("mytool", "mytool2")


def test_binary_gate_probes_path(monkeypatch):
    c = _BinaryCap()
    monkeypatch.setattr("shutil.which", lambda _cmd: None)
    assert c.available() is False
    # Available when ANY declared binary is on PATH (either name).
    monkeypatch.setattr("shutil.which", lambda cmd: "/usr/bin/mytool2" if cmd == "mytool2" else None)
    assert c.available() is True


def test_capability_with_no_gates_is_always_available():
    assert Capability().available() is True


# ---- Feature-flag gate (setting_flag, via lazy get_plugin_config) ------------------------------

class _FlagCap(Capability):
    key = "flag"
    setting_flag = "enable_synthetic"

    def default_settings(self):
        return {"enable_synthetic": False}


def test_flag_enabled_reads_plugin_config(monkeypatch):
    import netbox.plugins as np
    monkeypatch.setattr(np, "get_plugin_config", lambda _app, _key: True)
    assert Capability._flag_enabled("whatever") is True
    monkeypatch.setattr(np, "get_plugin_config", lambda _app, _key: False)
    assert Capability._flag_enabled("whatever") is False


def test_flag_enabled_unregistered_key_is_off(monkeypatch):
    # An unregistered key makes get_plugin_config raise; the guard degrades that to 'off', which is
    # why a flag-gated capability must register its default in default_settings.
    import netbox.plugins as np

    def boom(_app, key):
        raise KeyError(key)

    monkeypatch.setattr(np, "get_plugin_config", boom)
    assert Capability._flag_enabled("nope") is False


def test_flag_gate_combines_into_available(monkeypatch):
    import netbox.plugins as np
    c = _FlagCap()
    monkeypatch.setattr(np, "get_plugin_config", lambda _app, _key: False)
    assert c.available() is False
    monkeypatch.setattr(np, "get_plugin_config", lambda _app, _key: True)
    assert c.available() is True


# ---- default_settings merges ALL capabilities (so a flag is registerable even while off) --------

def test_all_default_settings_registers_disabled_flag_default(monkeypatch):
    monkeypatch.setattr(cap, "CAPABILITIES", cap.CAPABILITIES + (_FlagCap(),))
    merged = cap.all_default_settings()
    # The flag default is present (so an operator CAN flip it on) even though it defaults off and the
    # capability is therefore not currently enabled.
    assert merged["enable_synthetic"] is False


# ---- Surface aggregators fold in ENABLED capabilities' contributions ---------------------------

class _ContribCap(Capability):
    key = "contrib"

    def __init__(self, on):
        self._on = on

    def available(self):
        return self._on

    def url_patterns(self):
        return ["URL"]

    def nav_items(self):
        return ["NAV"]

    def template_extensions(self):
        return ["TPL"]

    def dashboard_widgets(self):
        return ["WIDGET"]


def test_aggregators_include_enabled_capability(monkeypatch):
    monkeypatch.setattr(cap, "CAPABILITIES", (_ContribCap(on=True),))
    assert cap.all_url_patterns() == ["URL"]
    assert cap.all_nav_items() == ["NAV"]
    assert cap.all_template_extensions() == ["TPL"]
    assert cap.all_dashboard_widgets() == ["WIDGET"]
    assert cap.enabled_keys() == ["contrib"]


def test_aggregators_skip_disabled_capability(monkeypatch):
    monkeypatch.setattr(cap, "CAPABILITIES", (_ContribCap(on=False),))
    assert cap.all_url_patterns() == []
    assert cap.all_nav_items() == []
    assert cap.all_template_extensions() == []
    assert cap.all_dashboard_widgets() == []
    assert cap.enabled_keys() == []


# ---- Format capabilities delegate to drawing_formats — the no-double-gate contract -------------

def test_format_capabilities_delegate_to_drawing_formats(monkeypatch):
    by_key = {c.key: c for c in cap.CAPABILITIES}
    # Bare install: only the core modules importable and no soffice binary → every optional-format
    # capability gates OFF, read straight from the drawing_formats registry (not a second probe).
    monkeypatch.setattr(df, "_module_installed", lambda name: name in {"pypdfium2", "PIL"})
    monkeypatch.setattr("shutil.which", lambda _cmd: None)
    assert by_key["svg"].available() is False
    assert by_key["cad"].available() is False
    assert by_key["gis"].available() is False
    assert by_key["visio"].available() is False
    # Installing the [gis] marker (pyshp) lights up the gis capability — because the underlying
    # formats light up. svg stays off (its [svg] decoder is still absent).
    monkeypatch.setattr(df, "_module_installed",
                        lambda name: name in {"pypdfium2", "PIL", "shapefile"})
    assert by_key["gis"].available() is True
    assert by_key["svg"].available() is False
    # And the visio capability follows its external binary, again via drawing_formats.
    monkeypatch.setattr("shutil.which", lambda cmd: "/usr/bin/soffice" if cmd == "soffice" else None)
    assert by_key["visio"].available() is True


def test_enabled_keys_are_a_subset_of_known_keys():
    known = {c.key for c in cap.CAPABILITIES}
    assert set(cap.enabled_keys()) <= known


# ---- Isolation contract: no Django / decoder import at module scope ----------------------------

def test_module_top_level_is_import_safe():
    """capabilities.py's module top level must be pure stdlib + the import-safe drawing_formats — no
    Django, no optional decoder — so importing it loads no native code and it never drags Django into
    a caller. The feature-flag gate's `get_plugin_config` must be lazy-imported inside a method, so it
    must NOT appear among the module-scope imports."""
    tree = ast.parse(pathlib.Path(cap.__file__).read_text())
    top_level = []
    for node in tree.body:
        if isinstance(node, ast.Import):
            top_level += [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom):
            top_level.append(node.module or "")
    forbidden = {"netbox", "django", "cairosvg", "ezdxf", "shapefile", "PIL", "pypdfium2"}
    offenders = [imp for imp in top_level
                 if any(imp == f or imp.startswith(f + ".") for f in forbidden)]
    assert offenders == [], f"module-scope import breaches isolation: {offenders}"
