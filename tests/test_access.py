"""Tier C — the optional `require_view_permission` map-read gate (`access.MapReadAccessMixin`).

By default map reads are login-only, so a bare authenticated user (`login_only_user`) reads every
entry point. With `require_view_permission` on, the gate requires `view_facilitymapblob` (or, for
editors, `change_facilitymapblob`): `login_only_user` is shut out with 403, while a viewer and an
editor still read. Writes stay gated on `change_facilitymapblob` regardless, so a viewer reads but
cannot POST. The dcim-page panels degrade to no panel for a shut-out user.

The foot of the file covers the two *object*-scoping layers stacked on that flat gate by
`scope_reads_to_sites`: the pixels + manifest (SEC-1) and the blob geometry, rooms and to-dos
(SEC-2). Both are opt-in, fail-closed, and no-ops with the setting off."""

import json

import pytest
from django.urls import reverse

pytestmark = pytest.mark.django_db

MAP = 'plugins:netbox_facilitymap:map'
MANIFEST = 'plugins:netbox_facilitymap:api-manifest'
MEDIA = 'plugins:netbox_facilitymap:api-media'
ANNOTATIONS = 'plugins:netbox_facilitymap:api-annotations'
SITEPLAN = 'plugins:netbox_facilitymap:api-siteplan'

# The read entry points that MUST honour the gate. `api-media` points at a nonexistent file so a
# permitted user gets 404 (the gate passed, then the missing-file 404), never 200 — while a
# shut-out user gets 403 from the gate before the file is ever looked at.
READ_ROUTES = [
    (MAP, {}),
    (MANIFEST, {}),
    (ANNOTATIONS, {}),
    (SITEPLAN, {}),
    (MEDIA, {'path': 'images/does-not-exist.png'}),
]


def _cfg(monkeypatch, key, value):
    from django.conf import settings
    monkeypatch.setitem(settings.PLUGINS_CONFIG['netbox_facilitymap'], key, value)


def _url(name, kwargs):
    return reverse(name, kwargs=kwargs) if kwargs else reverse(name)


# ---- default (gate off): login-only, unchanged behaviour ----

@pytest.mark.parametrize('name,kwargs', READ_ROUTES)
def test_reads_are_login_only_by_default(client, login_only_user, workdir, name, kwargs):
    # A bare authenticated user reads everything when the gate is off (the shipped default).
    client.force_login(login_only_user)
    assert client.get(_url(name, kwargs)).status_code != 403


# ---- gate on: view_facilitymapblob required for reads ----

@pytest.mark.parametrize('name,kwargs', READ_ROUTES)
def test_gate_blocks_login_only_user(client, login_only_user, workdir, monkeypatch, name, kwargs):
    _cfg(monkeypatch, 'require_view_permission', True)
    client.force_login(login_only_user)
    assert client.get(_url(name, kwargs)).status_code == 403


@pytest.mark.parametrize('name,kwargs', READ_ROUTES)
def test_gate_allows_viewer(client, viewer_user, workdir, monkeypatch, name, kwargs):
    _cfg(monkeypatch, 'require_view_permission', True)
    client.force_login(viewer_user)
    # Viewer holds view_facilitymapblob → passes the gate (a real 200/404, never the 403).
    assert client.get(_url(name, kwargs)).status_code != 403


@pytest.mark.parametrize('name,kwargs', READ_ROUTES)
def test_gate_allows_editor_without_view_perm(client, change_only_user, workdir, monkeypatch, name, kwargs):
    # change_only_user holds change_ but NOT view_ — Django perms are independent, and the gate
    # must still admit editors (has_perm(VIEW) or has_perm(EDIT)).
    _cfg(monkeypatch, 'require_view_permission', True)
    client.force_login(change_only_user)
    assert client.get(_url(name, kwargs)).status_code != 403


def test_anonymous_still_redirected_not_403(client, monkeypatch):
    # With the gate on, an unauthenticated request still hits LoginRequiredMixin's redirect
    # (302 to login), not the 403 — the perm check only fires once authenticated.
    _cfg(monkeypatch, 'require_view_permission', True)
    resp = client.get(reverse(MAP))
    assert resp.status_code == 302


# ---- writes stay gated on change_facilitymapblob regardless of the read gate ----

def test_viewer_can_read_but_not_write(client, viewer_user, workdir, monkeypatch):
    _cfg(monkeypatch, 'require_view_permission', True)
    client.force_login(viewer_user)
    assert client.get(reverse(SITEPLAN)).status_code == 200          # read OK
    post = client.post(reverse(SITEPLAN), data='{"hotspots": []}',
                       content_type='application/json')
    assert post.status_code == 403                                   # write still denied


# ---- dcim-page panels degrade to no panel for a shut-out user ----

def test_floor_panel_hidden_for_gated_out_user(rf, login_only_user, monkeypatch):
    from dcim.models import Location, Site
    from netbox_facilitymap.template_content import FloorRooms

    _cfg(monkeypatch, 'require_view_permission', True)
    site = Site.objects.create(name='S', slug='s')
    floor = Location.objects.create(name='F1', slug='f1', site=site)
    request = rf.get('/')
    request.user = login_only_user
    ext = FloorRooms(context={'object': floor, 'request': request})
    assert ext.right_page() == ''


# ---- per-Site read scoping (SEC-1): manifest + floor-plan media filtered by Site view perm ----
#
# A third, independent read layer (`scope_reads_to_sites`) stacked on the flat gate above. With it
# on, the manifest is filtered to the viewer's viewable Sites and a hidden Site's floor-plan pixels
# 404 — driven by `dcim.Site` object permissions, not a flat model perm. Two ungrouped Sites (`a`,
# `b`) live in the default facility; a user constrained to Site `a` must see building `a` + the
# campus siteplan but never building `b`'s manifest entry or `images/b/…` bytes.

PNG = b'\x89PNG\r\n\x1a\n-scoped'


def _seed_two_building_map(workdir):
    """Two ungrouped Sites + a manifest naming both (plus a campus siteplan) + the rendered image
    files. Returns nothing — Sites are looked up by slug. `a`/`b` are ungrouped so both resolve to
    the default facility `''`, matching the flat-root working dir the fixtures point at."""
    from dcim.models import Site

    Site.objects.create(name='A', slug='a')
    Site.objects.create(name='B', slug='b')
    manifest = {
        'siteplan': {'image': 'images/Siteplan/siteplan.png', 'siteSlug': 'a', 'hotspots': []},
        'buildings': [{'siteSlug': 'a', 'dir': 'a', 'floors': []},
                      {'siteSlug': 'b', 'dir': 'b', 'floors': []}],
        'built': 1,
    }
    (workdir / 'manifest.json').write_text(json.dumps(manifest))
    for rel in ('images/a/f.png', 'images/b/f.png', 'images/Siteplan/siteplan.png'):
        p = workdir / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(PNG)


def _site_scoped_user(name, slugs):
    """An authenticated user with a `dcim.Site` view ObjectPermission constrained to `slugs` (an
    empty list → a grant matching no Site, i.e. views nothing). No facility-map permission, so with
    `require_view_permission` off they clear the flat map-read gate on login alone — the per-Site
    layer is what filters them."""
    from dcim.models import Site
    from utilities.testing import create_test_user
    from conftest import grant

    user = create_test_user(name)
    grant(user, Site, ['view'], constraints={'slug__in': list(slugs)})
    return user


def test_scope_off_serves_whole_manifest(client, workdir, monkeypatch):
    # Default (scoping off): even a user who may view only Site `a` gets the whole manifest and
    # every image — proving the new layer is opt-in and the default read path is unchanged.
    _seed_two_building_map(workdir)
    client.force_login(_site_scoped_user('scope_off', ['a']))
    slugs = {b['siteSlug'] for b in client.get(reverse(MANIFEST)).json()['buildings']}
    assert slugs == {'a', 'b'}
    assert client.get(reverse(MEDIA, kwargs={'path': 'images/b/f.png'})).status_code == 200


def test_manifest_filtered_to_viewable_sites(client, workdir, monkeypatch):
    _cfg(monkeypatch, 'scope_reads_to_sites', True)
    _seed_two_building_map(workdir)
    client.force_login(_site_scoped_user('scoped_a', ['a']))
    body = client.get(reverse(MANIFEST)).json()
    assert {b['siteSlug'] for b in body['buildings']} == {'a'}   # building `b` dropped
    assert body['siteplan'] is not None                          # campus map kept (views a Site)


def test_media_hidden_for_unviewable_site(client, workdir, monkeypatch):
    _cfg(monkeypatch, 'scope_reads_to_sites', True)
    _seed_two_building_map(workdir)
    client.force_login(_site_scoped_user('media_a', ['a']))
    # The viewable Site's pixels + the campus siteplan serve; the hidden Site's 404 (not 403 — the
    # existence of the file is not revealed), exactly like a missing file.
    assert client.get(reverse(MEDIA, kwargs={'path': 'images/a/f.png'})).status_code == 200
    assert client.get(reverse(MEDIA, kwargs={'path': 'images/Siteplan/siteplan.png'})).status_code == 200
    assert client.get(reverse(MEDIA, kwargs={'path': 'images/b/f.png'})).status_code == 404


def test_no_viewable_sites_empties_map(client, workdir, monkeypatch):
    # A user who may view NO Site sees an empty facility: no buildings, no siteplan, every image 404.
    _cfg(monkeypatch, 'scope_reads_to_sites', True)
    _seed_two_building_map(workdir)
    client.force_login(_site_scoped_user('scoped_none', []))
    body = client.get(reverse(MANIFEST)).json()
    assert body['buildings'] == [] and body['siteplan'] is None
    assert client.get(reverse(MEDIA, kwargs={'path': 'images/a/f.png'})).status_code == 404
    assert client.get(reverse(MEDIA, kwargs={'path': 'images/Siteplan/siteplan.png'})).status_code == 404


def test_manifest_etag_varies_with_viewable_set(client, workdir, monkeypatch):
    # The viewable set folds into the ETag, so two users of the same unchanged manifest file get
    # different validators — a permission change can't be masked by a stale 304.
    _cfg(monkeypatch, 'scope_reads_to_sites', True)
    _seed_two_building_map(workdir)
    client.force_login(_site_scoped_user('etag_a', ['a']))
    etag_a = client.get(reverse(MANIFEST))['ETag']
    client.force_login(_site_scoped_user('etag_ab', ['a', 'b']))
    etag_ab = client.get(reverse(MANIFEST))['ETag']
    assert etag_a and etag_ab and etag_a != etag_ab


def test_floor_panel_hidden_for_unviewable_site(rf, workdir, monkeypatch):
    # Under scoping, a user who may view a floor Location but NOT its Site sees no plan panel — the
    # plan is a Site-level asset. `may_view_map_for_site` is the panel-side counterpart to the
    # manifest/media slug filtering.
    from dcim.models import Location, Site
    from netbox_facilitymap.template_content import FloorRooms

    _cfg(monkeypatch, 'scope_reads_to_sites', True)
    _seed_two_building_map(workdir)
    hidden = Site.objects.get(slug='b')
    floor = Location.objects.create(name='F1', slug='f1', site=hidden)
    request = rf.get('/')
    request.user = _site_scoped_user('panel_a', ['a'])   # may view Site a, not b
    ext = FloorRooms(context={'object': floor, 'request': request})
    assert ext.right_page() == ''


# ---- per-Site scoping of the blob geometry (SEC-2) ----
#
# SEC-1 above filtered the rendered pixels + the manifest; SEC-2 extends the *same* viewable-Site
# set to the geometry reads, so a hidden Site leaks neither its plan nor its room polygons, labels,
# markers, hotspots or to-dos. The sharded kinds (`annotations`/`placements`/`layouts`) drop whole
# floors — a shard key *is* a `floor_key`, whose first segment is the Site slug; `siteplan` is one
# facility-wide row, so it is filtered within its JSON and re-merged on write. Everything stays a
# no-op with the flag off.

PLACEMENTS = 'plugins:netbox_facilitymap:api-placements'
LAYOUTS = 'plugins:netbox_facilitymap:api-layouts'
TODOS = 'plugins:netbox_facilitymap:api-todos'
TODOS_ALL = 'plugins:netbox_facilitymap:api-todos-all'

FLOOR_A, FLOOR_B = 'a/level-1', 'b/level-1'


def _seed_geometry():
    """One floor of geometry per Site (`a` and `b`) across every kind: an annotations shard with a
    note, a placement, a layout, a bound `Room`, and one siteplan hotspot each. Assumes
    `_seed_two_building_map` already created the Sites."""
    from dcim.models import Location, Site
    from netbox_facilitymap.models import FacilityMapBlob, Room

    for fkey in (FLOOR_A, FLOOR_B):
        site_slug = fkey.split('/')[0]
        site = Site.objects.get(slug=site_slug)
        floor = Location.objects.create(name='L1 %s' % site_slug, slug='level-1-%s' % site_slug,
                                        site=site)
        room_loc = Location.objects.create(name='R1 %s' % site_slug, slug='r1-%s' % site_slug,
                                           site=site, parent=floor)
        FacilityMapBlob.objects.create(
            kind='annotations', facility='', key=fkey,
            data={'image': 'x.png', 'notes': [{'id': 'n-%s' % site_slug}]})
        FacilityMapBlob.objects.create(
            kind='placements', facility='', key=fkey,
            data={'placements': [{'id': 1, 'kind': 'rack', 'x': 0.5, 'y': 0.5}]})
        FacilityMapBlob.objects.create(
            kind='layouts', facility='', key=fkey, data={'grid': [[0]]})
        Room.objects.create(floor_key=fkey, room_id='r-%s' % site_slug,
                            label='Room %s' % site_slug, polygon=[[0, 0], [1, 0], [1, 1]],
                            location=room_loc, floor_location=floor)
    FacilityMapBlob.objects.create(
        kind='siteplan', facility='', key='',
        data={'hotspots': [{'id': 'h-a', 'dir': 'a', 'name': 'Building A', 'poly': [[0, 0]]},
                           {'id': 'h-b', 'dir': 'b', 'name': 'Building B', 'poly': [[1, 1]]}]})


def _room_viewer(name, slugs):
    """`_site_scoped_user` plus an *unconstrained* `Room` view grant. `Room` is a `NetBoxModel` with
    its own object permissions, orthogonal to Site scoping — without this grant its rows are
    invisible for a reason that has nothing to do with SEC-2, and a "hidden Site's rooms are
    withheld" assertion would pass vacuously. Granting it unconstrained is what makes the Site scope
    the only thing left doing the filtering."""
    from netbox_facilitymap.models import Room
    from conftest import grant

    user = _site_scoped_user(name, slugs)
    grant(user, Room, ['view'])
    return user


def _geometry_reads(client):
    """`{route: parsed body}` for every geometry read, as the logged-in `client` sees them."""
    return {name: client.get(reverse(name)).json()
            for name in (ANNOTATIONS, PLACEMENTS, LAYOUTS, SITEPLAN)}


def test_scope_off_serves_whole_geometry(client, workdir, monkeypatch):
    # Default (scoping off): a Site-`a`-only user still reads every floor's geometry and both
    # hotspots — the SEC-2 layer is opt-in and the default read path is untouched.
    _seed_two_building_map(workdir)
    _seed_geometry()
    client.force_login(_site_scoped_user('geo_off', ['a']))
    body = _geometry_reads(client)
    for name in (ANNOTATIONS, PLACEMENTS, LAYOUTS):
        assert set(body[name]) == {FLOOR_A, FLOOR_B}, name
    assert {h['id'] for h in body[SITEPLAN]['hotspots']} == {'h-a', 'h-b'}


def test_geometry_filtered_to_viewable_sites(client, workdir, monkeypatch):
    # On: the hidden Site's floors vanish from all three sharded kinds and its hotspot from the
    # siteplan — while the viewable Site's geometry is served in full.
    _cfg(monkeypatch, 'scope_reads_to_sites', True)
    _seed_two_building_map(workdir)
    _seed_geometry()
    client.force_login(_site_scoped_user('geo_a', ['a']))
    body = _geometry_reads(client)
    for name in (ANNOTATIONS, PLACEMENTS, LAYOUTS):
        assert set(body[name]) == {FLOOR_A}, name
    assert [h['id'] for h in body[SITEPLAN]['hotspots']] == ['h-a']
    # Building B's *name* is withheld too, not just its outline.
    assert 'Building B' not in json.dumps(body)


def test_room_geometry_filtered_to_viewable_sites(client, workdir, monkeypatch):
    # The rooms composed into the annotations document are scoped by the same set — the polygon and
    # label of a room on a hidden Site must not survive the floor filter.
    _cfg(monkeypatch, 'scope_reads_to_sites', True)
    _seed_two_building_map(workdir)
    _seed_geometry()
    client.force_login(_room_viewer('rooms_a', ['a']))
    doc = client.get(reverse(ANNOTATIONS)).json()
    assert [r['label'] for r in doc[FLOOR_A]['rooms']] == ['Room a']
    assert FLOOR_B not in doc


def test_room_only_floor_of_hidden_site_is_not_reintroduced(client, workdir, monkeypatch):
    # A floor with rooms but no blob row is composed from the `Room` rows alone. Scoping the shard
    # rows is therefore not enough on its own — the room scope must withhold it too, or the floor
    # the row filter just dropped reappears.
    from netbox_facilitymap.models import FacilityMapBlob

    _cfg(monkeypatch, 'scope_reads_to_sites', True)
    _seed_two_building_map(workdir)
    _seed_geometry()
    FacilityMapBlob.objects.filter(kind='annotations', key=FLOOR_B).delete()
    client.force_login(_room_viewer('roomonly_a', ['a']))
    assert FLOOR_B not in client.get(reverse(ANNOTATIONS)).json()


def test_no_viewable_sites_empties_geometry(client, workdir, monkeypatch):
    # A user who may view no Site reads no geometry at all — fail-closed, like the manifest.
    _cfg(monkeypatch, 'scope_reads_to_sites', True)
    _seed_two_building_map(workdir)
    _seed_geometry()
    client.force_login(_site_scoped_user('geo_none', []))
    body = _geometry_reads(client)
    for name in (ANNOTATIONS, PLACEMENTS, LAYOUTS):
        assert body[name] == {}, name
    assert body[SITEPLAN]['hotspots'] == []


def test_unbound_hotspot_dropped_under_scoping(client, workdir, monkeypatch):
    # A free-drawn hotspot (`dir: null`) belongs to no Site, so it can't be shown to a
    # Site-constrained viewer — fail-closed, the same rule the manifest filter applies.
    from netbox_facilitymap.models import FacilityMapBlob

    _cfg(monkeypatch, 'scope_reads_to_sites', True)
    _seed_two_building_map(workdir)
    _seed_geometry()
    row = FacilityMapBlob.objects.get(kind='siteplan', key='')
    row.data['hotspots'].append({'id': 'h-free', 'dir': None, 'name': '', 'poly': [[2, 2]]})
    row.save()
    client.force_login(_site_scoped_user('free_a', ['a']))
    assert [h['id'] for h in client.get(reverse(SITEPLAN)).json()['hotspots']] == ['h-a']


def test_siteplan_save_preserves_hidden_hotspots(client, workdir, monkeypatch):
    # The data-loss guard. The siteplan is round-tripped as a WHOLE document, so a scoped editor
    # POSTs back only the hotspots they were shown. Without the server-side merge that would delete
    # every hidden Site's hotspot; with it, `h-b` survives and the editor's own edit still lands.
    from netbox_facilitymap.models import FacilityMapBlob
    from conftest import grant

    _cfg(monkeypatch, 'scope_reads_to_sites', True)
    _seed_two_building_map(workdir)
    _seed_geometry()
    editor = _site_scoped_user('editor_a', ['a'])
    grant(editor, FacilityMapBlob, ['view', 'change'])
    client.force_login(editor)

    seen = client.get(reverse(SITEPLAN)).json()['hotspots']
    assert [h['id'] for h in seen] == ['h-a']          # b is withheld on read
    seen.append({'id': 'h-a2', 'dir': 'a', 'name': 'Annex', 'poly': [[3, 3]]})
    resp = client.post(reverse(SITEPLAN), data=json.dumps({'hotspots': seen}),
                       content_type='application/json')
    assert resp.status_code == 200

    stored = {h['id'] for h in FacilityMapBlob.objects.get(kind='siteplan', key='').data['hotspots']}
    assert stored == {'h-a', 'h-a2', 'h-b'}            # the hidden hotspot was NOT clobbered
    # …and the editor still isn't shown it back.
    assert {h['id'] for h in client.get(reverse(SITEPLAN)).json()['hotspots']} == {'h-a', 'h-a2'}


def test_todos_filtered_to_viewable_sites(client, workdir, monkeypatch):
    # To-do text rides room geometry, so it needs the same scope on both reads: the per-floor one
    # (which names its Site in the floor_key) and the facility-wide rollup.
    from netbox_facilitymap.models import FacilityMapBlob, Room, RoomTodo

    _cfg(monkeypatch, 'scope_reads_to_sites', True)
    _seed_two_building_map(workdir)
    _seed_geometry()
    FacilityMapBlob.objects.update_or_create(kind='settings', facility='', key='',
                                             defaults={'data': {'todos': True}})
    for fkey in (FLOOR_A, FLOOR_B):
        RoomTodo.objects.create(room=Room.objects.get(floor_key=fkey), text='fix %s' % fkey)
    client.force_login(_room_viewer('todo_a', ['a']))

    assert client.get(reverse(TODOS), {'floor_key': FLOOR_A}).json() != {}
    assert client.get(reverse(TODOS), {'floor_key': FLOOR_B}).json() == {}   # hidden Site's floor
    assert set(client.get(reverse(TODOS_ALL)).json()) == {FLOOR_A}
