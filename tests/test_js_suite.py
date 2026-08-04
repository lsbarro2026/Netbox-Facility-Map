"""Bridge: run the JS unit tier (`tests/js/`) as part of the ordinary pytest run.

The frontend's DOM-free classes are tested with node's **built-in** runner (`node --test`), which
needs no npm, no `package.json` and no build step — see `tests/js/README.md`. This module exists so
there is still **one** command that runs everything: `pytest` shells the JS suite and fails if it
does. No second CI lane, and a machine (or container) without node is not broken by it — the test
skips cleanly instead.

Deliberately one test, not one per JS file: node's runner already reports per-test results, and its
output is attached verbatim to the failure below, so splitting this up would only hide which JS
assertion actually failed behind a pytest parametrize id.
"""

import shutil
import subprocess
from pathlib import Path

import pytest

JS_DIR = Path(__file__).parent / 'js'

# `node:test` shipped as a stable, non-experimental runner in Node 18. Older majors either lack the
# module or print an ExperimentalWarning and take different CLI flags, so they are skipped rather
# than reported as a failure of the code under test.
MIN_NODE_MAJOR = 18

# Long enough for a cold start on a loaded CI runner; short enough that a hung suite fails the build
# instead of stalling it. The whole tier runs in well under a second normally.
TIMEOUT_S = 120


def _node_major(node):
    """The major version of `node`, or None if it can't be determined."""
    try:
        out = subprocess.run([node, '--version'], capture_output=True, text=True,
                             timeout=30, check=True).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    try:
        return int(out.lstrip('v').split('.')[0])
    except ValueError:
        return None


def test_js_unit_suite():
    """Run `node --test` over `tests/js/` and require a clean exit.

    Invoked with **cwd set to the JS directory and no path argument**: node resolves a bare
    directory argument as a *module* path (`node --test tests/js` fails with MODULE_NOT_FOUND), so
    the no-argument form scanning the working directory is the one that discovers `*.test.js`
    recursively while ignoring helpers like `load.js` and the `fixtures/` JSON.
    """
    node = shutil.which('node')
    if node is None:
        pytest.skip('node is not installed — the JS unit tier needs it (see tests/js/README.md)')

    major = _node_major(node)
    if major is None:
        pytest.skip(f'could not determine the version of {node}')
    if major < MIN_NODE_MAJOR:
        pytest.skip(f'node {major} is too old for the built-in test runner '
                    f'(need >= {MIN_NODE_MAJOR})')

    assert JS_DIR.is_dir(), f'the JS test tier is missing: {JS_DIR}'

    proc = subprocess.run([node, '--test'], cwd=JS_DIR, capture_output=True, text=True,
                          timeout=TIMEOUT_S)
    assert proc.returncode == 0, (
        f'the JS unit tier failed (node --test, exit {proc.returncode}).\n'
        f'Reproduce with:  cd {JS_DIR} && node --test\n\n'
        f'{proc.stdout}\n{proc.stderr}')


def test_js_suite_actually_ran_some_tests():
    """Guard the bridge itself: `node --test` exits 0 when it discovers **nothing**, so a renamed
    directory or a change to node's discovery globs would turn this whole tier into a silent no-op
    that still reports green. Assert the TAP summary counts real tests."""
    node = shutil.which('node')
    if node is None or (_node_major(node) or 0) < MIN_NODE_MAJOR:
        pytest.skip('node missing or too old — see test_js_unit_suite')

    proc = subprocess.run([node, '--test'], cwd=JS_DIR, capture_output=True, text=True,
                          timeout=TIMEOUT_S)
    counts = [line for line in proc.stdout.splitlines() if line.startswith('# pass ')]
    assert counts, f'no TAP summary in node --test output:\n{proc.stdout}\n{proc.stderr}'
    passed = int(counts[0].removeprefix('# pass ').strip())
    assert passed > 0, f'the JS tier discovered no tests — it is silently not running:\n{proc.stdout}'
