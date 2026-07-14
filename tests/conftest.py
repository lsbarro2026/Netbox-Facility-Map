"""Shared pytest fixtures for the plugin test suite.

The tests live outside the `netbox_facilitymap` package (so they aren't shipped in the wheel)
and hook NetBox's Django settings via pytest-django — see the repo README's "Running the tests"
for the run recipe (it passes the machine-specific PYTHONPATH on the CLI).

Fixtures here fall into two groups:
  * `make_pdf` / `workdir` / `backupdir` — filesystem/config plumbing, no DB needed.
  * `editor_user` / `plain_user` — NetBox users with (and without) object permissions, for the
    DB-backed tier that exercises `sync_rooms` delete-scoping and the permission-gated endpoints.
"""

import io

import pytest


def grant(user, model, actions, constraints=None):
    """Give `user` a NetBox `ObjectPermission` for `actions` on `model`. NetBox's auth backend
    resolves both `has_perm('<app>.<action>_<model>')` and `.restrict(user, action)` through these
    rows, not Django's model permissions. `constraints` (a dict/list of ORM filters, e.g.
    `{'slug': 'a'}`) narrows which objects the permission covers — `.restrict(user, action)` then
    returns only the matching rows, which is how SEC-1's per-Site read scoping is exercised; the
    default `None` covers every object (an unconstrained grant)."""
    from core.models import ObjectType
    from users.models import ObjectPermission

    op = ObjectPermission.objects.create(
        name=f'{model.__name__}:{",".join(actions)}', actions=list(actions),
        constraints=constraints)
    # `object_types` is a M2M to NetBox's `ObjectType` (a proxy of `ContentType`). On 4.1.x the
    # relation rejects a plain `ContentType`, so add the `ObjectType`; being a `ContentType`
    # subclass it is also accepted by the looser 4.6.x relation — one call works on both.
    op.object_types.add(ObjectType.objects.get_for_model(model))
    op.users.add(user)
    return op


@pytest.fixture
def make_pdf():
    """Return a builder for a tiny but valid single-page PDF (bytes). Pillow — already a runtime
    dependency — emits a real PDF, so no binary fixture needs to be committed."""
    from PIL import Image

    def _make(width=120, height=160, color='white'):
        buf = io.BytesIO()
        Image.new('RGB', (width, height), color).save(buf, 'PDF')
        return buf.getvalue()

    return _make


@pytest.fixture
def make_multipage_pdf():
    """Return a builder for a multi-page PDF (bytes) whose pages have distinct sizes, so a test
    can tell which page rendered from the manifest's per-floor w/h. `sizes` is a list of
    (width, height) — one page each. Pillow (a runtime dep) emits a real multi-page PDF via
    `save_all`, so no binary fixture is committed. Counterpart to `make_pdf` for the
    multi-page-explosion path (IMPORT-1)."""
    from PIL import Image

    def _make(sizes=((120, 160), (200, 160), (120, 300))):
        pages = [Image.new('RGB', (w, h), 'white') for (w, h) in sizes]
        buf = io.BytesIO()
        pages[0].save(buf, 'PDF', save_all=True, append_images=pages[1:])
        return buf.getvalue()

    return _make


@pytest.fixture
def make_image():
    """Return a builder for a tiny but valid raster image (bytes) in a given format — the
    counterpart to `make_pdf` for the image-input path. Pillow (already a runtime dependency)
    emits real PNG/JPEG/TIFF/GIF/BMP/WEBP, so no binary fixtures need to be committed."""
    from PIL import Image

    def _make(fmt='PNG', width=120, height=160, color='white', exif_orientation=None):
        buf = io.BytesIO()
        kwargs = {}
        if exif_orientation is not None:
            exif = Image.Exif()
            exif[0x0112] = exif_orientation  # EXIF Orientation tag (274)
            kwargs['exif'] = exif
        Image.new('RGB', (width, height), color).save(buf, fmt, **kwargs)
        return buf.getvalue()

    return _make


@pytest.fixture
def all_formats_accepted(monkeypatch):
    """Force every known format into the accepted-upload set, so the acceptance-LAYER logic
    (magic sniff, zip member mapping, upload store) can be exercised for the optional formats
    (Shapefile/Visio/…) regardless of which extras this environment carries. PKG-1 narrows the
    derived ext lists to the *installed* formats and they're frozen at import, so a test that
    asserts acceptance of an optional format must simulate its extra being present. No decoder is
    needed here — acceptance only sniffs magic and stores bytes; the decode is the render
    subprocess's job."""
    from netbox_facilitymap import drawing_formats as df, imports

    full_exts = tuple(e for f in df.FORMATS for e in f.exts)
    full_comps = tuple(e for f in df.FORMATS for e in f.companions)
    monkeypatch.setattr(imports, 'DRAWING_EXTS', full_exts)
    monkeypatch.setattr(imports, 'COMPANION_EXTS', full_comps)
    monkeypatch.setattr(imports, 'UPLOAD_EXTS', full_exts + full_comps)
    return None


@pytest.fixture
def workdir(tmp_path, monkeypatch):
    """Point the plugin's `work_dir` at a throwaway tmp dir for the duration of a test, so nothing
    touches the real MEDIA_ROOT. `storage.work_dir()` re-reads the plugin config on every call, so
    mutating `PLUGINS_CONFIG` is enough."""
    from django.conf import settings

    monkeypatch.setitem(settings.PLUGINS_CONFIG['netbox_facilitymap'], 'work_dir', str(tmp_path))
    return tmp_path


@pytest.fixture
def backupdir(tmp_path_factory, monkeypatch):
    """Point the plugin's `backup_dir` at a throwaway tmp dir (see `workdir`). Uses its own
    unique dir — NOT a child of `workdir` — so `create_backup` never tars its own output."""
    from django.conf import settings

    d = tmp_path_factory.mktemp('facilitymap-backups')
    monkeypatch.setitem(settings.PLUGINS_CONFIG['netbox_facilitymap'], 'backup_dir', str(d))
    return d


@pytest.fixture
def editor_user(db):
    """A non-superuser who may change the map, import, and delete rooms — the full editor. Holds
    `change_facilitymapblob` (annotation writes), the custom `import_facilitymapblob` (import
    endpoints + Settings, split off in PERM-1) via the `import` action, and a Room `delete`
    ObjectPermission so `restrict(user, 'delete')` returns every room. Not a superuser, so it
    still can't `reset` (imports.ResetView requires superuser)."""
    from utilities.testing import create_test_user
    from netbox_facilitymap.models import FacilityMapBlob, Room

    user = create_test_user('editor')
    # NetBox resolves the custom `import_facilitymapblob` codename from an ObjectPermission whose
    # `actions` contains 'import' (it splits the codename on the last '_'), so 'import' grants it.
    grant(user, FacilityMapBlob, ['view', 'add', 'change', 'delete', 'import'])
    grant(user, Room, ['view', 'add', 'change', 'delete'])
    return user


@pytest.fixture
def superuser(db):
    """A superuser — passes every permission check, so it clears both the import gate and the
    extra superuser tier that `reset` requires (imports.ResetView)."""
    from utilities.testing import create_test_user

    user = create_test_user('super')
    user.is_superuser = True
    user.save()
    return user


@pytest.fixture
def plain_user(db):
    """A non-superuser who may change the map but has NO Room `delete` permission, so
    `restrict(user, 'delete')` returns nothing — used to prove the delete-scoping guard."""
    from utilities.testing import create_test_user
    from netbox_facilitymap.models import FacilityMapBlob

    user = create_test_user('plain')
    grant(user, FacilityMapBlob, ['view', 'add', 'change'])
    return user


@pytest.fixture
def viewer_user(db):
    """A non-superuser holding only `view_facilitymapblob` (no change/add/delete). Used to prove
    the optional `require_view_permission` read gate lets viewers read but not write."""
    from utilities.testing import create_test_user
    from netbox_facilitymap.models import FacilityMapBlob

    user = create_test_user('viewer')
    grant(user, FacilityMapBlob, ['view'])
    return user


@pytest.fixture
def change_only_user(db):
    """A non-superuser holding only `change_facilitymapblob` (NO `view_`). Django perms are
    independent, so this proves an editor keeps map-read access under the view gate via the
    `has_perm(EDIT)` branch — not because they happen to also hold `view_`."""
    from utilities.testing import create_test_user
    from netbox_facilitymap.models import FacilityMapBlob

    user = create_test_user('changeonly')
    grant(user, FacilityMapBlob, ['change'])
    return user


@pytest.fixture
def login_only_user(db):
    """A bare authenticated user with NO facility-map permissions at all — the contractor who
    should be shut out once `require_view_permission` is on, but sees everything while it's off."""
    from utilities.testing import create_test_user

    return create_test_user('loginonly')
