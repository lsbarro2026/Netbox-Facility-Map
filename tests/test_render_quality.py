"""High-quality floor-plan rendering (READ-1).

The install-wide `render_hq` switch and the one thing it actually does: hand `preprocess.py` a
`--scale` when a **build** spawns. The scale math itself (how a multiplier becomes a per-page
PDFium scale, and the point-size-derived clamp that keeps a big sheet from blowing the render
child's address space) is Tier A and lives in `test_preprocess.py`; this file covers the Django
half.

Three things carry the weight here:
  * the setting merges into the ONE install-wide settings blob without clobbering its siblings
    (MULTI-1 + AUDIT-1's before/after diff depend on it);
  * the switch is admin-tier — gated on the import permission, like every other Settings write;
  * `--scale` reaches a `build` and **only** a build: `scan` thumbnails and the wizard's
    interactive `preview` must not silently start spending high-quality memory.
"""

import json
import subprocess

import pytest
from django.urls import reverse

from netbox_facilitymap import previews
from netbox_facilitymap.render_runner import RenderRunner
from netbox_facilitymap.models import FacilityMapBlob

RENDER_HQ = 'plugins:netbox_facilitymap:api-settings-render-hq'


def _post(client, payload):
    return client.post(reverse(RENDER_HQ), data=json.dumps(payload),
                       content_type='application/json')


def _settings():
    return FacilityMapBlob.objects.get(kind='settings', facility='', key='').data


# ---- previews.render_hq_enabled (the reader) ----

def test_render_hq_enabled_defaults_false(db):
    # No blob at all, then a blob with no render_hq key — both read False, so an existing install
    # keeps rendering exactly as it did until someone opts in.
    assert previews.render_hq_enabled() is False
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={'write_mode': True})
    assert previews.render_hq_enabled() is False


def test_render_hq_enabled_reads_a_stored_true(db):
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={'render_hq': True})
    assert previews.render_hq_enabled() is True


@pytest.mark.parametrize('stored', ['yes', 1, {}, None])
def test_render_hq_enabled_coerces_a_hand_edited_blob(db, stored):
    # Written outside the Settings page (admin/REST/fixture), so it never went through the POST's
    # bool(). It must still resolve to a usable bool rather than reaching argv as junk.
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={'render_hq': stored})
    assert previews.render_hq_enabled() is bool(stored)


# ---- the endpoint ----

def test_render_hq_persists_to_settings_blob(client, editor_user):
    client.force_login(editor_user)
    r = _post(client, {'render_hq': True})
    assert r.status_code == 200 and r.json() == {'ok': True, 'render_hq': True}
    assert _settings()['render_hq'] is True
    assert previews.render_hq_enabled() is True


def test_render_hq_turns_back_off(client, editor_user):
    client.force_login(editor_user)
    _post(client, {'render_hq': True})
    assert _post(client, {'render_hq': False}).json() == {'ok': True, 'render_hq': False}
    assert previews.render_hq_enabled() is False


def test_render_hq_merges_without_clobbering_siblings(client, editor_user):
    # The install-wide blob is shared by every setting; a save must be a merge, never an overwrite.
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={
        'write_mode': True, 'ap_tool': True, 'floor_label_field': 'slug'})
    client.force_login(editor_user)
    assert _post(client, {'render_hq': True}).status_code == 200
    data = _settings()
    assert data == {'write_mode': True, 'ap_tool': True, 'floor_label_field': 'slug',
                    'render_hq': True}


def test_render_hq_requires_import_permission(client, plain_user):
    # Admin-tier configuration: a user without the import permission gets a 403 and changes nothing.
    client.force_login(plain_user)
    assert _post(client, {'render_hq': True}).status_code == 403
    assert previews.render_hq_enabled() is False


def test_render_hq_requires_login(client, db):
    assert _post(client, {'render_hq': True}).status_code in (302, 403)


@pytest.mark.parametrize('payload,stored', [
    ({'render_hq': 'yes'}, True),     # truthy junk from a hand-rolled client
    ({'render_hq': 0}, False),
    ({}, False),                      # absent key reads as off, not a 500
])
def test_render_hq_coerces_its_payload(client, editor_user, payload, stored):
    client.force_login(editor_user)
    r = _post(client, payload)
    assert r.status_code == 200 and r.json() == {'ok': True, 'render_hq': stored}
    assert _settings()['render_hq'] is stored


# ---- the wiring: RenderRunner -> preprocess.py --scale ----

@pytest.fixture
def spawned(monkeypatch):
    """Capture the argv `RenderRunner.run` would spawn, without running a render."""
    calls = []

    class _Proc:
        returncode = 0
        stdout = '{"folders": []}'
        stderr = ''

    def fake_run(argv, **kwargs):
        calls.append(argv)
        return _Proc()

    monkeypatch.setattr('netbox_facilitymap.render_runner.subprocess.run', fake_run)
    return calls


def _argv(spawned):
    assert len(spawned) == 1
    return spawned[0]


def test_build_passes_scale_when_render_hq_is_on(db, spawned, workdir):
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={'render_hq': True})
    RenderRunner().run('build')
    argv = _argv(spawned)
    assert '--scale' in argv
    assert argv[argv.index('--scale') + 1] == str(RenderRunner.HQ_SCALE)


def test_build_omits_scale_when_render_hq_is_off(db, spawned, workdir):
    RenderRunner().run('build')
    assert '--scale' not in _argv(spawned)


@pytest.mark.parametrize('mode', ['scan', 'preview'])
def test_only_a_build_gets_the_high_quality_scale(db, spawned, workdir, mode):
    # Deliberate: `scan` thumbnails exist to identify a plan, and `preview` is an interactive
    # request. Neither should start spending build-sized memory because the operator opted into
    # sharper *floor plans*.
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={'render_hq': True})
    RenderRunner().run(mode)
    assert '--scale' not in _argv(spawned)


def test_build_scale_rides_alongside_mode_specific_argv(db, spawned, workdir):
    # `extra` is how modes pass their own argv; appending the scale must not drop it.
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={'render_hq': True})
    RenderRunner().run('build', ['--pdf', 'uploads/A/1.pdf'])
    argv = _argv(spawned)
    assert '--pdf' in argv and 'uploads/A/1.pdf' in argv and '--scale' in argv


# ---- RenderRunner.run: HEALTH-3 memory-constraint diagnostics ----

@pytest.fixture
def fake_proc(monkeypatch):
    """Install a fake `subprocess.run` returning a proc with the given returncode/stdout/stderr, so
    `RenderRunner.run`'s result-shaping is exercised without spawning a render subprocess."""
    def install(returncode=0, stdout='', stderr=''):
        proc = type('_Proc', (), {'returncode': returncode, 'stdout': stdout, 'stderr': stderr})()
        monkeypatch.setattr('netbox_facilitymap.render_runner.subprocess.run',
                            lambda argv, **kw: proc)
    return install


def _hq_on():
    FacilityMapBlob.objects.create(kind='settings', facility='', key='', data={'render_hq': True})


def test_signal_killed_hq_build_reports_a_memory_hint(db, workdir, fake_proc):
    # A child killed by a signal (negative returncode) during an HQ build is almost certainly the
    # render outgrowing its rlimits; the user gets the actionable remedy, not an opaque traceback.
    _hq_on()
    fake_proc(returncode=-9)
    result = RenderRunner().run('build')
    assert result['ok'] is False
    assert result['signal'] == 9
    assert result['hq_mem'] is True
    assert 'render_mem_mb' in result['hint']


def test_signal_killed_build_without_hq_has_no_hint(db, workdir, fake_proc):
    # Same kill, HQ off: not attributable to the high-quality memory budget, so no hint is invented.
    fake_proc(returncode=-9, stderr='boom')
    result = RenderRunner().run('build')
    assert result['ok'] is False and result['signal'] == 9
    assert 'hint' not in result and 'hq_mem' not in result


def test_plain_nonzero_exit_is_not_treated_as_a_signal_kill(db, workdir, fake_proc):
    # A positive exit code is an ordinary render error, not a resource kill — no signal field and no
    # memory hint, even with HQ on.
    _hq_on()
    fake_proc(returncode=1, stderr='bad pdf')
    result = RenderRunner().run('build')
    assert result['ok'] is False
    assert 'signal' not in result and 'hq_mem' not in result and 'hint' not in result


def test_hq_timeout_points_at_the_timeout_setting(db, workdir, monkeypatch):
    _hq_on()
    def timeout(argv, **kw):
        raise subprocess.TimeoutExpired(argv, 1)
    monkeypatch.setattr('netbox_facilitymap.render_runner.subprocess.run', timeout)
    result = RenderRunner().run('build')
    assert result['ok'] is False and 'render_timeout_s' in result['hint']


def test_build_surfaces_render_summary_counts(db, workdir, fake_proc):
    # A *successful* build that quietly dropped a sheet / clamped an HQ sheet reports the counts so
    # the frontend can warn; the summary is the last stderr line, read past the log truncation.
    fake_proc(stderr='some log line\nRENDER-SUMMARY {"hq": true, "unrendered": 2, "hq_clamped": 1}')
    result = RenderRunner().run('build')
    assert result['ok'] is True
    assert result['unrendered'] == 2 and result['hq_clamped'] == 1


def test_build_summary_omits_zero_counts(db, workdir, fake_proc):
    # An all-clean build stays byte-identical to before — no unrendered/hq_clamped keys ride along.
    fake_proc(stderr='RENDER-SUMMARY {"hq": false, "unrendered": 0, "hq_clamped": 0}')
    result = RenderRunner().run('build')
    assert 'unrendered' not in result and 'hq_clamped' not in result


def test_scan_ignores_a_render_summary_line(db, workdir, fake_proc):
    # Summary parsing is build-only; a scan's result is its stdout inventory, untouched.
    fake_proc(stdout='{"folders": []}', stderr='RENDER-SUMMARY {"unrendered": 3}')
    result = RenderRunner().run('scan')
    assert result == {'ok': True, 'folders': []}


def test_a_run_reads_the_render_hq_setting_once(db, workdir, fake_proc, monkeypatch):
    """One run, one settings read (QUAL-7). The flag both selects `--scale` and decides whether a
    resource failure is worth explaining as an HQ one, and it used to be read separately for each —
    two queries for one boolean, with the standing risk of the two disagreeing across a concurrent
    toggle. Exercised on the signal-kill path, which is where both uses meet."""
    _hq_on()
    reads = []
    real = previews.render_hq_enabled
    monkeypatch.setattr('netbox_facilitymap.render_runner.render_hq_enabled',
                        lambda *a, **kw: (reads.append(1), real(*a, **kw))[1])
    fake_proc(returncode=-9)
    result = RenderRunner().run('build')
    assert result['hq_mem'] is True     # the flag still reached the diagnostic…
    assert reads == [1]                 # …off a single read
