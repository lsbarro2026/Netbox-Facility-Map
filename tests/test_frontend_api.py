"""Tier C — `frontend_api.sync_rooms`, with the delete-scoping invariant as the headline.

A POST is authoritative for the whole annotations document, so rooms absent from it are deleted —
but only ones the saving user is permitted to delete (`restrict(user, 'delete')`). A user must
never silently wipe rooms they have no delete permission over (CLAUDE.md §Data safety)."""

import json

import pytest
from django.urls import reverse

from netbox_facilitymap.frontend_api import VERSION_HEADER, sync_rooms
from netbox_facilitymap.models import FacilityMapBlob, Room

pytestmark = pytest.mark.django_db

FLOOR = 'test-site/floor-1'
LOCATIONS = 'plugins:netbox_facilitymap:api-nb-locations'
RACKS = 'plugins:netbox_facilitymap:api-nb-racks'
SITES = 'plugins:netbox_facilitymap:api-nb-sites'


def _floor_location():
    from dcim.models import Location, Site
    site = Site.objects.create(name='Test Site', slug='test-site')
    return site, Location.objects.create(name='Floor 1', slug='floor-1', site=site)


def test_upserts_and_binds_location(editor_user):
    from dcim.models import Location
    site, floor = _floor_location()
    room_loc = Location.objects.create(name='Room 101', slug='room-101', site=site, parent=floor)

    sync_rooms({FLOOR: [
        {'id': 'r1', 'label': 'R1', 'polygon': [[0, 0], [1, 0], [1, 1]],
         'location': {'id': room_loc.pk}},
    ]}, user=editor_user)

    room = Room.objects.get(room_id='r1')
    assert room.floor_key == FLOOR
    assert room.label == 'R1'
    assert room.polygon == [[0, 0], [1, 0], [1, 1]]
    assert room.location_id == room_loc.pk


def test_deletes_absent_rooms_when_user_may(editor_user):
    Room.objects.create(floor_key=FLOOR, room_id='r1', label='R1')
    Room.objects.create(floor_key=FLOOR, room_id='r2', label='R2')

    # editor_user holds Room delete permission → the absent r2 is removed.
    sync_rooms({FLOOR: [{'id': 'r1', 'label': 'R1', 'polygon': [], 'location': None}]},
               user=editor_user)

    assert Room.objects.filter(room_id='r1').exists()
    assert not Room.objects.filter(room_id='r2').exists()


def test_spares_rooms_the_user_cannot_delete(plain_user):
    # The core invariant: plain_user has NO Room delete permission, so restrict(user,'delete')
    # is empty and the absent r2 must survive — even though the upsert of r1 still runs.
    Room.objects.create(floor_key=FLOOR, room_id='r1', label='R1')
    Room.objects.create(floor_key=FLOOR, room_id='r2', label='R2')

    sync_rooms({FLOOR: [{'id': 'r1', 'label': 'R1 edited', 'polygon': [], 'location': None}]},
               user=plain_user)

    assert Room.objects.get(room_id='r1').label == 'R1 edited'
    assert Room.objects.filter(room_id='r2').exists()


def test_whole_floor_absent_is_scoped_too(plain_user):
    # A floor missing entirely from the POST is also delete-scoped: plain_user can't drop it.
    Room.objects.create(floor_key='other-site/floor-9', room_id='rx', label='X')

    sync_rooms({FLOOR: []}, user=plain_user)

    assert Room.objects.filter(room_id='rx').exists()


def test_trusted_import_deletes_unconditionally(editor_user):
    # user=None is the trusted `facilitymap_import` command: full authority, unscoped delete.
    Room.objects.create(floor_key=FLOOR, room_id='r1')
    Room.objects.create(floor_key=FLOOR, room_id='r2')

    sync_rooms({FLOOR: [{'id': 'r1', 'label': '', 'polygon': [], 'location': None}]}, user=None)

    assert not Room.objects.filter(room_id='r2').exists()


def test_unknown_location_id_falls_back_to_null(editor_user):
    _floor_location()
    sync_rooms({FLOOR: [
        {'id': 'r1', 'label': '', 'polygon': [], 'location': {'id': 999999}},
    ]}, user=editor_user)
    assert Room.objects.get(room_id='r1').location_id is None


# --- Rename-proof floor binding (BIND-1): sync_rooms resolves the floor Location from `floor_key`
# and stores it as the stable `floor_location` FK, but only when it resolves — a save arriving after
# a rename (the SPA still POSTs the OLD floor_key) must never null a good FK. --------------------

def test_sync_sets_floor_location_from_key(editor_user):
    site, floor = _floor_location()
    sync_rooms({FLOOR: [{'id': 'r1', 'label': '', 'polygon': [], 'location': None}]},
               user=editor_user)
    assert Room.objects.get(room_id='r1').floor_location_id == floor.pk


def test_sync_floor_location_null_when_key_unresolvable(editor_user):
    # A floor-type key with no matching floor Location (or a genuinely orphaned key) leaves the FK
    # null — exactly today's behaviour for such keys.
    sync_rooms({'no-such-site/gl1': [{'id': 'r1', 'label': '', 'polygon': [], 'location': None}]},
               user=editor_user)
    assert Room.objects.get(room_id='r1').floor_location_id is None


def test_sync_floor_location_sticky_across_rename(editor_user):
    # First save binds the FK. Then rename the floor Location's slug so the frozen floor_key no
    # longer resolves; a subsequent save with that OLD key must PRESERVE the FK, not null it.
    site, floor = _floor_location()
    sync_rooms({FLOOR: [{'id': 'r1', 'label': 'R1', 'polygon': [], 'location': None}]},
               user=editor_user)
    assert Room.objects.get(room_id='r1').floor_location_id == floor.pk

    floor.slug = 'floor-1-renamed'
    floor.save()

    sync_rooms({FLOOR: [{'id': 'r1', 'label': 'R1 edited', 'polygon': [], 'location': None}]},
               user=editor_user)
    room = Room.objects.get(room_id='r1')
    assert room.label == 'R1 edited'          # the edit still applied
    assert room.floor_location_id == floor.pk  # …but the good FK survived the unresolvable key


# --- Optimistic-concurrency guard (CONC-1): the version token echoed on GET must be sent back
# on POST, and a stale token is rejected with 409 so a concurrent editor's rooms aren't
# clobbered. Exercised through the real permission-gated views (Django test client). ----------

ANNOTATIONS = 'plugins:netbox_facilitymap:api-annotations'
SITEPLAN = 'plugins:netbox_facilitymap:api-siteplan'


def _post_json(client, name, body, version=None):
    headers = {} if version is None else {VERSION_HEADER: version}
    return client.post(reverse(name), data=json.dumps(body),
                       content_type='application/json', headers=headers)


def _room(rid, label='', poly=None):
    return {'id': rid, 'label': label, 'polygon': poly or [], 'location': None}


def test_annotations_version_roundtrips_from_get_to_save(client, editor_user):
    # A first GET on an empty map yields the empty token; POSTing it back writes and mints a new,
    # non-empty token that the next GET echoes — the happy path a single editor always takes.
    client.force_login(editor_user)
    r0 = client.get(reverse(ANNOTATIONS))
    assert r0.headers[VERSION_HEADER] == ''

    r1 = _post_json(client, ANNOTATIONS, {FLOOR: {'rooms': [_room('r1', 'R1')]}}, version='')
    assert r1.status_code == 200
    v1 = r1.headers[VERSION_HEADER]
    assert v1 != ''
    assert Room.objects.filter(room_id='r1').exists()

    assert client.get(reverse(ANNOTATIONS)).headers[VERSION_HEADER] == v1


def test_annotations_stale_token_conflicts_and_spares_concurrent_rooms(client, editor_user):
    # The headline: editor B holds a token from before editor A added r2. B's save (a document
    # that never had r2) must be rejected with 409 — otherwise sync_rooms, authoritative for the
    # whole document, would delete r2. r2 must survive and B's own r1 edit must NOT be applied.
    client.force_login(editor_user)
    v1 = _post_json(client, ANNOTATIONS,
                    {FLOOR: {'rooms': [_room('r1', 'R1')]}}, version='').headers[VERSION_HEADER]
    # Editor A adds r2, advancing the version past the token B still holds (v1).
    _post_json(client, ANNOTATIONS,
               {FLOOR: {'rooms': [_room('r1', 'R1'), _room('r2', 'R2')]}}, version=v1)

    stale = _post_json(client, ANNOTATIONS,
                       {FLOOR: {'rooms': [_room('r1', 'R1 edited by B')]}}, version=v1)
    assert stale.status_code == 409
    assert Room.objects.filter(room_id='r2').exists()          # not clobbered
    assert Room.objects.get(room_id='r1').label == 'R1'        # B's edit was rejected, not applied


def test_annotations_missing_header_still_saves(client, editor_user):
    # Opt-in: a caller that sends no version header bypasses the check (backward compatibility
    # for non-versioned callers) rather than being rejected.
    client.force_login(editor_user)
    r = _post_json(client, ANNOTATIONS, {FLOOR: {'rooms': [_room('r1')]}})
    assert r.status_code == 200
    assert Room.objects.filter(room_id='r1').exists()


def test_blob_stale_token_conflicts_and_leaves_data(client, editor_user):
    # Same guard on the plain blob kinds (siteplan/placements/layouts): a stale token is a 409
    # and the stored document is left untouched.
    client.force_login(editor_user)
    assert client.get(reverse(SITEPLAN)).headers[VERSION_HEADER] == ''
    v1 = _post_json(client, SITEPLAN,
                    {'hotspots': [{'id': 'h1'}]}, version='').headers[VERSION_HEADER]
    assert v1 != ''

    stale = _post_json(client, SITEPLAN, {'hotspots': [{'id': 'h2'}]}, version='')
    assert stale.status_code == 409
    row = FacilityMapBlob.objects.get(kind='siteplan', key='')
    assert row.data == {'hotspots': [{'id': 'h1'}]}           # the stale write did not land


# --- Audit trail (AUDIT-1): blob writes carry NetBox's ChangeLoggingMixin, so each POST records
# an ObjectChange (who/when + whole-document before/after) in the global Change Log. The write
# views snapshot the row before overwriting, so a data-unchanged write is suppressed as a no-op. --


def _blob_changes():
    from core.models import ObjectChange
    return ObjectChange.objects.filter(changed_object_type__model='facilitymapblob')


def test_blob_write_records_audit_entry(client, editor_user):
    # A first siteplan POST creates the row and logs a `create` ObjectChange attributed to the
    # saving user, with the whole document in postchange_data. The redundant `updated` timestamp
    # is kept out of the snapshot by the model's serialize_object override.
    from core.choices import ObjectChangeActionChoices
    client.force_login(editor_user)
    _post_json(client, SITEPLAN, {'hotspots': [{'id': 'h1'}]}, version='')

    oc = _blob_changes().get()
    assert oc.action == ObjectChangeActionChoices.ACTION_CREATE
    assert oc.user_id == editor_user.pk
    assert oc.postchange_data['data'] == {'hotspots': [{'id': 'h1'}]}
    assert 'updated' not in oc.postchange_data


def test_blob_update_records_before_and_after(client, editor_user):
    # The point of snapshotting: an update entry carries both the pre- and post-change document,
    # so "what did this edit change" is answerable from the Change Log.
    from core.choices import ObjectChangeActionChoices
    client.force_login(editor_user)
    v1 = _post_json(client, SITEPLAN,
                    {'hotspots': [{'id': 'h1'}]}, version='').headers[VERSION_HEADER]
    _post_json(client, SITEPLAN, {'hotspots': [{'id': 'h2'}]}, version=v1)

    upd = _blob_changes().get(action=ObjectChangeActionChoices.ACTION_UPDATE)
    assert upd.prechange_data['data'] == {'hotspots': [{'id': 'h1'}]}
    assert upd.postchange_data['data'] == {'hotspots': [{'id': 'h2'}]}


def test_rooms_only_annotations_edit_logs_no_blob_change(client, editor_user):
    # The headline no-op case: an annotations POST whose only change is room geometry (which lives
    # in the `Room` table, logged separately) leaves the annotations blob's own data unchanged. The
    # snapshot makes that a no-op, so NetBox suppresses it — no spurious "annotations updated" entry
    # per room drag. Only the initial create (from the first save) remains.
    client.force_login(editor_user)
    v1 = _post_json(client, ANNOTATIONS,
                    {FLOOR: {'rooms': [_room('r1', 'R1')]}}, version='').headers[VERSION_HEADER]
    assert _blob_changes().count() == 1                        # the create from the first save

    _post_json(client, ANNOTATIONS,
               {FLOOR: {'rooms': [_room('r1', 'R1'), _room('r2', 'R2')]}}, version=v1)
    assert Room.objects.filter(room_id='r2').exists()          # the room write did happen
    assert _blob_changes().count() == 1                        # no-op blob update was suppressed


# --- Multi-facility (MULTI-2): blobs and room deletes are scoped to a facility, resolved from a
# floor's site → its SiteGroup slug. The headline is that a facility-B POST can never delete
# facility-A's rooms (Room has no facility column, so the cross-floor delete is site-scoped). ------

FACILITIES = 'plugins:netbox_facilitymap:api-nb-facilities'
FLOOR_LABEL = 'plugins:netbox_facilitymap:api-settings-floor-label-field'
DEFAULT_FACILITY = 'plugins:netbox_facilitymap:api-settings-default-facility'


def _import_manifest(workdir, slug):
    """Give facility `slug` a rendered manifest in its working dir, so it counts as having
    imported content (`imported_facility_slugs`). `''` writes the root manifest."""
    base = workdir / slug if slug else workdir
    base.mkdir(parents=True, exist_ok=True)
    (base / 'manifest.json').write_text('{"siteplan": null, "buildings": []}')


def _grouped_site(group_slug, site_slug):
    """A Site under a SiteGroup (the default grouping), so it resolves to facility=`group_slug`."""
    from dcim.models import Site, SiteGroup
    group, _ = SiteGroup.objects.get_or_create(slug=group_slug, defaults={'name': group_slug})
    return Site.objects.create(name=site_slug, slug=site_slug, group=group)


def test_sync_rooms_never_deletes_another_facilitys_rooms(editor_user):
    # The core MULTI-2 invariant: two facilities, each a SiteGroup with a site + a floor. A POST
    # authoritative for facility A must not touch facility B's rooms, even though B's floor is
    # absent from the document.
    _grouped_site('ga', 'sa')
    _grouped_site('gb', 'sb')
    Room.objects.create(floor_key='sa/f1', room_id='ra_old', label='stale A room')
    Room.objects.create(floor_key='sb/f1', room_id='rb', label='B room')

    sync_rooms({'sa/f1': [_room('ra_new', 'A')]}, user=editor_user, facility='ga')

    assert Room.objects.filter(room_id='ra_new').exists()       # A upserted
    assert not Room.objects.filter(room_id='ra_old').exists()   # A's dropped floor cleaned up
    assert Room.objects.filter(room_id='rb').exists()           # B untouched — the invariant


def test_blob_endpoint_isolates_facilities(client, editor_user):
    # A write to facility A's siteplan and a write to facility B's are stored in separate rows and
    # read back independently.
    client.force_login(editor_user)
    url_a = reverse(SITEPLAN) + '?facility=ga'
    url_b = reverse(SITEPLAN) + '?facility=gb'
    client.post(url_a, data=json.dumps({'hotspots': [{'id': 'A'}]}),
                content_type='application/json', headers={VERSION_HEADER: ''})
    client.post(url_b, data=json.dumps({'hotspots': [{'id': 'B'}]}),
                content_type='application/json', headers={VERSION_HEADER: ''})

    assert client.get(url_a).json() == {'hotspots': [{'id': 'A'}]}
    assert client.get(url_b).json() == {'hotspots': [{'id': 'B'}]}
    assert FacilityMapBlob.objects.get(kind='siteplan', facility='ga').data == {'hotspots': [{'id': 'A'}]}
    assert FacilityMapBlob.objects.get(kind='siteplan', facility='gb').data == {'hotspots': [{'id': 'B'}]}
    # The default-facility row is never created by a facility-scoped write.
    assert not FacilityMapBlob.objects.filter(kind='siteplan', facility='').exists()


def test_blob_endpoint_rejects_bad_facility(client, editor_user):
    client.force_login(editor_user)
    assert client.get(reverse(SITEPLAN) + '?facility=../evil').status_code == 400


def test_annotations_get_scoped_to_facility(client, editor_user):
    # A facility-A annotations GET surfaces only A's rooms, never B's (Room has no facility column,
    # so this is proven by the site-scoped compose, not a column filter).
    _grouped_site('ga', 'sa')
    _grouped_site('gb', 'sb')
    Room.objects.create(floor_key='sa/f1', room_id='ra', label='A', polygon=[[0, 0]])
    Room.objects.create(floor_key='sb/f1', room_id='rb', label='B', polygon=[[0, 0]])
    client.force_login(editor_user)

    doc = client.get(reverse(ANNOTATIONS) + '?facility=ga').json()
    room_ids = {r['id'] for floor in doc.values() for r in floor.get('rooms', [])}
    assert room_ids == {'ra'}


def test_facilities_endpoint_lists_groups_with_content_flag(client, superuser, workdir):
    # The picker feed: every SiteGroup the user may view, flagged whether it has an imported map
    # (a manifest in its working dir). Superuser sees all groups.
    _grouped_site('ga', 'sa')
    _grouped_site('gb', 'sb')
    (workdir / 'ga').mkdir()
    (workdir / 'ga' / 'manifest.json').write_text('{"siteplan": null, "buildings": []}')
    client.force_login(superuser)

    body = client.get(reverse(FACILITIES)).json()
    assert body['grouping'] == 'sitegroup'
    by_slug = {f['slug']: f for f in body['facilities']}
    assert by_slug['ga']['has_content'] is True
    assert by_slug['gb']['has_content'] is False
    # Content-having facilities sort first.
    assert body['facilities'][0]['slug'] == 'ga'


def test_set_grouping_persists_and_drives_read_path(client, editor_user):
    # MULTI-3: the wizard's grouping POST writes `facility_grouping` into the settings blob so the
    # install-wide read path (facilities.grouping / list_facilities) flips to Region.
    from netbox_facilitymap.facilities import grouping
    client.force_login(editor_user)

    r = client.post(reverse(FACILITIES), data=json.dumps({'grouping': 'region'}),
                    content_type='application/json')
    assert r.status_code == 200 and r.json() == {'ok': True, 'grouping': 'region'}
    assert grouping() == 'region'
    # Stored on the single default-facility settings row, never a facility-scoped one.
    assert FacilityMapBlob.objects.get(
        kind='settings', facility='', key='').data['facility_grouping'] == 'region'
    assert client.get(reverse(FACILITIES)).json()['grouping'] == 'region'


def test_set_grouping_preserves_room_embed_keys(client, editor_user):
    # The write merges onto the existing settings document — the room-embed controls survive.
    FacilityMapBlob.objects.create(kind='settings', facility='', key='',
                                   data={'room_embed_zoom': 3.0})
    client.force_login(editor_user)

    client.post(reverse(FACILITIES), data=json.dumps({'grouping': 'region'}),
                content_type='application/json')
    data = FacilityMapBlob.objects.get(kind='settings', facility='', key='').data
    assert data == {'room_embed_zoom': 3.0, 'facility_grouping': 'region'}


def test_set_grouping_rejects_unknown_value(client, editor_user):
    client.force_login(editor_user)
    r = client.post(reverse(FACILITIES), data=json.dumps({'grouping': 'campus'}),
                    content_type='application/json')
    assert r.status_code == 400
    assert not FacilityMapBlob.objects.filter(kind='settings').exists()


def test_set_grouping_requires_import_permission(client, plain_user):
    # `plain_user` holds change but not import — the everyday map-write gate must not unlock this
    # admin-tier config write.
    client.force_login(plain_user)
    r = client.post(reverse(FACILITIES), data=json.dumps({'grouping': 'region'}),
                    content_type='application/json')
    assert r.status_code == 403
    assert not FacilityMapBlob.objects.filter(kind='settings').exists()


def test_set_grouping_change_blocked_without_confirm_when_populated(client, editor_user):
    # HEALTH-1: a grouping *change* on an install that already holds map data would re-scope Sites
    # and orphan the existing blobs — refused without an explicit confirm, and nothing is persisted.
    from netbox_facilitymap.facilities import grouping
    FacilityMapBlob.objects.create(kind='annotations', facility='', key='', data={'sa/f1': {}})
    client.force_login(editor_user)

    r = client.post(reverse(FACILITIES), data=json.dumps({'grouping': 'region'}),
                    content_type='application/json')
    assert r.status_code == 409
    assert r.json()['error'] == 'confirm_required'
    assert grouping() == 'sitegroup'   # unchanged — no settings row written


def test_set_grouping_change_allowed_with_confirm(client, editor_user):
    from netbox_facilitymap.facilities import grouping
    FacilityMapBlob.objects.create(kind='annotations', facility='', key='', data={'sa/f1': {}})
    client.force_login(editor_user)

    r = client.post(reverse(FACILITIES), data=json.dumps({'grouping': 'region', 'confirm': True}),
                    content_type='application/json')
    assert r.status_code == 200
    assert grouping() == 'region'


def test_set_grouping_noop_allowed_when_populated(client, editor_user):
    # Re-saving the SAME grouping isn't a change, so no confirm is needed even with data present.
    FacilityMapBlob.objects.create(kind='annotations', facility='', key='', data={'sa/f1': {}})
    client.force_login(editor_user)

    r = client.post(reverse(FACILITIES), data=json.dumps({'grouping': 'sitegroup'}),
                    content_type='application/json')
    assert r.status_code == 200


# --- floor_label_field setting (SET-1): moved off the NetBox-chrome'd SettingsView onto the in-app
# #/settings page, persisted here into the same install-wide settings blob. Mirrors the grouping
# endpoint's contract (merge, IMPORT_PERM gate, AUDIT-1 snapshot). ------------------------------


def test_floor_label_field_persists_to_settings_blob(client, editor_user):
    # A POST writes floor_label_field onto the single default-facility settings row (MULTI-1).
    client.force_login(editor_user)
    r = client.post(reverse(FLOOR_LABEL), data=json.dumps({'floor_label_field': 'slug'}),
                    content_type='application/json')
    assert r.status_code == 200 and r.json() == {'ok': True, 'floor_label_field': 'slug'}
    assert FacilityMapBlob.objects.get(
        kind='settings', facility='', key='').data['floor_label_field'] == 'slug'


def test_floor_label_field_preserves_other_settings_keys(client, editor_user):
    # The write merges onto the existing settings document — the room-embed / grouping keys survive.
    FacilityMapBlob.objects.create(kind='settings', facility='', key='',
                                   data={'room_embed_zoom': 3.0, 'facility_grouping': 'region'})
    client.force_login(editor_user)

    client.post(reverse(FLOOR_LABEL), data=json.dumps({'floor_label_field': 'description'}),
                content_type='application/json')
    data = FacilityMapBlob.objects.get(kind='settings', facility='', key='').data
    assert data == {'room_embed_zoom': 3.0, 'facility_grouping': 'region',
                    'floor_label_field': 'description'}


def test_floor_label_field_clamps_unknown_value(client, editor_user):
    # Enum-safe: a value outside the allowlist clamps to the default rather than being stored raw.
    client.force_login(editor_user)
    r = client.post(reverse(FLOOR_LABEL), data=json.dumps({'floor_label_field': 'bogus'}),
                    content_type='application/json')
    assert r.status_code == 200 and r.json()['floor_label_field'] == 'name'
    assert FacilityMapBlob.objects.get(
        kind='settings', facility='', key='').data['floor_label_field'] == 'name'


def test_floor_label_field_requires_import_permission(client, plain_user):
    # `plain_user` holds change but not import — the everyday map-write gate must not unlock this
    # admin-tier config write (PERM-1).
    client.force_login(plain_user)
    r = client.post(reverse(FLOOR_LABEL), data=json.dumps({'floor_label_field': 'slug'}),
                    content_type='application/json')
    assert r.status_code == 403
    assert not FacilityMapBlob.objects.filter(kind='settings').exists()


def test_floor_label_field_records_audit_entry(client, editor_user):
    # AUDIT-1: the endpoint goes through the shared snapshot-before-overwrite upsert, so a second
    # save logs one ObjectChange carrying the before/after value.
    from core.choices import ObjectChangeActionChoices
    from core.models import ObjectChange
    client.force_login(editor_user)

    client.post(reverse(FLOOR_LABEL), data=json.dumps({'floor_label_field': 'name'}),
                content_type='application/json')
    client.post(reverse(FLOOR_LABEL), data=json.dumps({'floor_label_field': 'slug'}),
                content_type='application/json')

    changes = ObjectChange.objects.filter(changed_object_type__model='facilitymapblob')
    upd = changes.get(action=ObjectChangeActionChoices.ACTION_UPDATE)
    assert upd.user_id == editor_user.pk
    assert upd.prechange_data['data']['floor_label_field'] == 'name'
    assert upd.postchange_data['data']['floor_label_field'] == 'slug'


# --- default_facility setting (SET-2): pin which facility the SPA boots into when the URL hash names
# none. Persisted into the same install-wide settings blob; a submitted slug is clamped to a
# reachable, content-having facility (or '') so a stale/empty pin never boots into a dead map. -----


def test_default_facility_persists_when_reachable_and_imported(client, editor_user, workdir):
    # A pinned facility that both resolves under the live grouping (a SiteGroup with a site) and has
    # a rendered manifest is stored on the single default-facility settings row (MULTI-1).
    _grouped_site('ga', 'sa')
    _import_manifest(workdir, 'ga')
    client.force_login(editor_user)
    r = client.post(reverse(DEFAULT_FACILITY), data=json.dumps({'default_facility': 'ga'}),
                    content_type='application/json')
    assert r.status_code == 200 and r.json() == {'ok': True, 'default_facility': 'ga'}
    assert FacilityMapBlob.objects.get(
        kind='settings', facility='', key='').data['default_facility'] == 'ga'


def test_default_facility_preserves_other_settings_keys(client, editor_user, workdir):
    # The write merges onto the existing settings document — the floor-label / room-embed keys survive.
    _grouped_site('ga', 'sa')
    _import_manifest(workdir, 'ga')
    FacilityMapBlob.objects.create(kind='settings', facility='', key='',
                                   data={'room_embed_zoom': 3.0, 'floor_label_field': 'slug'})
    client.force_login(editor_user)

    client.post(reverse(DEFAULT_FACILITY), data=json.dumps({'default_facility': 'ga'}),
                content_type='application/json')
    data = FacilityMapBlob.objects.get(kind='settings', facility='', key='').data
    assert data == {'room_embed_zoom': 3.0, 'floor_label_field': 'slug', 'default_facility': 'ga'}


def test_default_facility_clamps_reachable_but_empty_facility(client, editor_user, workdir):
    # A facility that resolves under the grouping but has NO imported map can't be a useful boot
    # default (it would just re-open the wizard) — the content gate coerces it to '' rather than 400.
    _grouped_site('ga', 'sa')   # reachable, but no manifest written
    client.force_login(editor_user)
    r = client.post(reverse(DEFAULT_FACILITY), data=json.dumps({'default_facility': 'ga'}),
                    content_type='application/json')
    assert r.status_code == 200 and r.json()['default_facility'] == ''
    assert FacilityMapBlob.objects.get(
        kind='settings', facility='', key='').data['default_facility'] == ''


def test_default_facility_clamps_unknown_slug(client, editor_user, workdir):
    # A slug no Site resolves to (not reachable) clamps to '' too.
    client.force_login(editor_user)
    r = client.post(reverse(DEFAULT_FACILITY), data=json.dumps({'default_facility': 'ghost'}),
                    content_type='application/json')
    assert r.status_code == 200 and r.json()['default_facility'] == ''


def test_default_facility_requires_import_permission(client, plain_user):
    # `plain_user` holds change but not import — the everyday map-write gate must not unlock this
    # admin-tier config write (PERM-1).
    client.force_login(plain_user)
    r = client.post(reverse(DEFAULT_FACILITY), data=json.dumps({'default_facility': 'ga'}),
                    content_type='application/json')
    assert r.status_code == 403
    assert not FacilityMapBlob.objects.filter(kind='settings').exists()


def test_default_facility_reader_degrades_stale_pin(workdir):
    # The read path (facilities.default_facility, injected into window.MAP by MapView): a stored pin
    # is honoured only while it stays reachable + content-having, else it degrades to '' (HEALTH-1) so
    # a grouping change or a wiped import never boots into a dead facility.
    from netbox_facilitymap import facilities
    _grouped_site('ga', 'sa')
    _import_manifest(workdir, 'ga')
    FacilityMapBlob.objects.create(kind='settings', facility='', key='',
                                   data={'default_facility': 'ga'})
    assert facilities.default_facility() == 'ga'

    # Drop the rendered manifest → the pin no longer has content → the reader falls back to ''.
    (workdir / 'ga' / 'manifest.json').unlink()
    assert facilities.default_facility() == ''


def test_nb_locations_exposes_description(client, editor_user):
    # `_trim` gained `description` so the import wizard's floor-label picker can offer it as an
    # alternative to `name`/`slug` (see views._floor_label_field).
    from conftest import grant
    from dcim.models import Location

    site, floor = _floor_location()
    floor.description = 'Sub-basement Storage'
    floor.save()
    grant(editor_user, Location, ['view'])
    client.force_login(editor_user)

    r = client.get(reverse(LOCATIONS) + '?site=test-site')
    assert r.status_code == 200
    (loc,) = r.json()['rooms']
    assert loc['description'] == 'Sub-basement Storage'


# --- Inline Location creation (LOC-1): the plugin's one write into dcim core, gated on the
# off-by-default `allow_location_create` capability flag + the `dcim.add_location` permission. ----

LOCATION_CREATE = 'plugins:netbox_facilitymap:api-nb-location-create'


@pytest.fixture
def location_create_on(monkeypatch):
    """Switch the install-wide `allow_location_create` capability flag on for a test (it defaults
    off). `capabilities.is_enabled` reads it live via `get_plugin_config`, so setting the key is
    enough — no restart needed."""
    from django.conf import settings
    monkeypatch.setitem(
        settings.PLUGINS_CONFIG['netbox_facilitymap'], 'allow_location_create', True)


def _location_creator(user):
    """Grant `user` the view+add Location object permissions the create endpoint requires (view to
    resolve the parent floor, add to create + pass the post-save restrict('add') check)."""
    from conftest import grant
    from dcim.models import Location
    grant(user, Location, ['view', 'add'])


def test_create_location_disabled_returns_403(client, editor_user, location_create_on, monkeypatch):
    # Even with the perm, the write is refused when the operator hasn't switched the feature on —
    # NetBox stays the source of truth by default.
    from django.conf import settings
    monkeypatch.setitem(
        settings.PLUGINS_CONFIG['netbox_facilitymap'], 'allow_location_create', False)
    site, floor = _floor_location()
    _location_creator(editor_user)
    client.force_login(editor_user)

    r = _post_json(client, LOCATION_CREATE, {'parent': floor.pk, 'name': 'Room 9'})
    assert r.status_code == 403
    from dcim.models import Location
    assert not Location.objects.filter(name='Room 9').exists()


def test_create_location_without_permission_returns_403(client, editor_user, location_create_on):
    # Flag on, but editor_user holds no dcim.add_location permission → the per-user gate refuses it.
    site, floor = _floor_location()
    client.force_login(editor_user)

    r = _post_json(client, LOCATION_CREATE, {'parent': floor.pk, 'name': 'Room 9'})
    assert r.status_code == 403
    from dcim.models import Location
    assert not Location.objects.filter(name='Room 9').exists()


def test_create_location_success(client, editor_user, location_create_on):
    from dcim.models import Location
    site, floor = _floor_location()
    _location_creator(editor_user)
    client.force_login(editor_user)

    r = _post_json(client, LOCATION_CREATE, {'parent': floor.pk, 'name': 'Room 9'})
    assert r.status_code == 201
    loc = Location.objects.get(name='Room 9')
    # Created as a child of the floor, under the floor's site, with a name-derived slug — so
    # NbRoomsView lists it and room→Location binding resolves (§7).
    assert loc.parent_id == floor.pk
    assert loc.site_id == site.pk
    assert loc.slug == 'room-9'
    body = r.json()
    assert body['id'] == loc.pk and body['slug'] == 'room-9' and body['parent'] == floor.pk


def test_create_location_duplicate_returns_400(client, editor_user, location_create_on):
    from dcim.models import Location
    site, floor = _floor_location()
    Location.objects.create(name='Room 9', slug='room-9', site=site, parent=floor)
    _location_creator(editor_user)
    client.force_login(editor_user)

    # A second Room 9 under the same floor collides on NetBox's uniqueness constraint → a clean 400
    # from full_clean(), not a 500.
    r = _post_json(client, LOCATION_CREATE, {'parent': floor.pk, 'name': 'Room 9'})
    assert r.status_code == 400
    assert Location.objects.filter(name='Room 9').count() == 1


def test_create_location_missing_parent_returns_400(client, editor_user, location_create_on):
    _floor_location()
    _location_creator(editor_user)
    client.force_login(editor_user)

    r = _post_json(client, LOCATION_CREATE, {'parent': 999999, 'name': 'Room 9'})
    assert r.status_code == 400


def test_create_location_blank_name_returns_400(client, editor_user, location_create_on):
    site, floor = _floor_location()
    _location_creator(editor_user)
    client.force_login(editor_user)

    r = _post_json(client, LOCATION_CREATE, {'parent': floor.pk, 'name': '   '})
    assert r.status_code == 400


def test_nb_racks_exposes_description(client, editor_user):
    # `_trim_rack` gained `description` (RACK-2) so the rack card in the edit → rack sub-mode
    # sidebar can show a location note (e.g. "east wall") without opening NetBox.
    from conftest import grant
    from dcim.models import Rack

    site, floor = _floor_location()
    Rack.objects.create(name='Rack A', site=site, location=floor,
                        description='East wall', status='active')
    grant(editor_user, Rack, ['view'])
    client.force_login(editor_user)

    r = client.get(reverse(RACKS) + f'?location={floor.pk}')
    assert r.status_code == 200
    (rack,) = r.json()['racks']
    assert rack['description'] == 'East wall'


# --- NbSitesView facility scoping (FACIL-1) ------------------------------------------------------
# The import wizard's building→Site search must return only the active facility's Sites, so an
# operator importing under one facility can't bind a building to another facility's Site — which
# would land the images/manifest/blobs under this facility while the Site's rooms strand elsewhere.
# `superuser` bypasses object-perm scoping, isolating the facility filter under test.

def _sitegroup(slug):
    from dcim.models import SiteGroup
    return SiteGroup.objects.create(name=slug, slug=slug)


def test_nb_sites_scoped_to_active_facility(client, superuser):
    from dcim.models import Site
    west = _sitegroup('west')
    Site.objects.create(name='West Alpha', slug='west-alpha', group=west)
    Site.objects.create(name='Ungrouped One', slug='ungrouped-one')
    client.force_login(superuser)

    r = client.get(reverse(SITES) + '?facility=west')
    assert r.status_code == 200
    assert {s['slug'] for s in r.json()['sites']} == {'west-alpha'}


def test_nb_sites_default_facility_returns_only_ungrouped(client, superuser):
    from dcim.models import Site
    west = _sitegroup('west')
    Site.objects.create(name='West Alpha', slug='west-alpha', group=west)
    Site.objects.create(name='Ungrouped One', slug='ungrouped-one')
    client.force_login(superuser)

    r = client.get(reverse(SITES))   # no ?facility= -> the default facility '' (ungrouped only)
    assert r.status_code == 200
    assert {s['slug'] for s in r.json()['sites']} == {'ungrouped-one'}


def test_nb_sites_rejects_bad_facility(client, superuser):
    client.force_login(superuser)
    r = client.get(reverse(SITES) + '?facility=bad.slug')   # '.' fails the ^[-\w]+$ slug rule
    assert r.status_code == 400
