"""Tier C — `health.run_checks` and the `facilitymap_check` command.

The health check is a read-only diagnostic for the plugin's slug-keyed bindings: a floor key is
`"<site.slug>/<floor-location.slug>"`, so renaming a Site/Location in NetBox silently orphans
floors and rooms. These tests exercise each drift category, the clean case, the object-permission
scoping, and the command's non-zero exit on drift."""

import json

import pytest

from netbox_facilitymap import health
from netbox_facilitymap.models import FacilityMapBlob, Room

pytestmark = pytest.mark.django_db


def _site_floor():
    from dcim.models import Location, Site
    site = Site.objects.create(name='Test Site', slug='test-site')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    return site, floor


def _write_manifest(workdir, building_dir, floor_id):
    (workdir / 'manifest.json').write_text(json.dumps({
        'siteplan': None,
        'buildings': [{'code': 'B', 'dir': building_dir, 'name': 'B', 'siteSlug': building_dir,
                       'floors': [{'id': floor_id, 'label': 'F', 'floorSlug': floor_id,
                                   'image': 'x.png', 'w': 100, 'h': 100, 'pages': []}]}],
    }))


def test_clean_report_has_no_drift():
    site, floor = _site_floor()
    from dcim.models import Location
    room_loc = Location.objects.create(name='Room 101', slug='room-101', site=site, parent=floor)
    Room.objects.create(floor_key='test-site/floor-1', room_id='r1', location=room_loc)

    report = health.run_checks()
    assert not report.has_drift
    assert report.unresolved_floor_keys == []
    assert report.unbound_rooms == []
    assert report.stale_placements == []


def test_resolved_floor_key_is_not_flagged():
    _site_floor()
    from dcim.models import Location, Site
    site = Site.objects.get(slug='test-site')
    room_loc = Location.objects.create(name='Room', slug='room-9', site=site,
                                       parent=Location.objects.get(slug='floor-1'))
    Room.objects.create(floor_key='test-site/floor-1', room_id='r1', location=room_loc)

    assert health.run_checks().unresolved_floor_keys == []


def test_unresolved_floor_key_no_such_site():
    # A room on a floor key whose site slug doesn't exist at all.
    Room.objects.create(floor_key='gone-site/floor-x', room_id='r1', label='R1')
    rows = health.run_checks().unresolved_floor_keys
    assert len(rows) == 1
    assert rows[0].floor_key == 'gone-site/floor-x'
    assert rows[0].reason == 'no such site'
    assert rows[0].room_count == 1
    assert rows[0].in_manifest is False


def test_unresolved_floor_key_site_exists_but_no_floor_location():
    # The rename case with NO rename-proof FK (floor_location null): genuinely orphaned, so flagged.
    _site_floor()
    Room.objects.create(floor_key='test-site/renamed-floor', room_id='r1',
                        location=None, floor_location=None)
    rows = health.run_checks().unresolved_floor_keys
    keys = {r.floor_key: r for r in rows}
    assert 'test-site/renamed-floor' in keys
    assert keys['test-site/renamed-floor'].reason == 'no floor Location under site'


def test_fk_covered_floor_key_not_flagged_after_rename():
    # BIND-1: the same rename case but the room still carries a `floor_location` FK — the binding is
    # intact, so the (now slug-unresolvable) floor_key must NOT be reported as drift.
    site, floor = _site_floor()
    Room.objects.create(floor_key='test-site/old-floor-slug', room_id='r1', floor_location=floor)
    assert health.run_checks().unresolved_floor_keys == []


def test_unresolved_floor_key_from_manifest_only(workdir):
    # A manifest floor with no matching Location and no rooms — surfaced with room_count 0.
    _write_manifest(workdir, 'test-site', 'orphan-floor')
    _site_floor()  # site exists, but 'orphan-floor' Location does not
    rows = {r.floor_key: r for r in health.run_checks().unresolved_floor_keys}
    assert 'test-site/orphan-floor' in rows
    assert rows['test-site/orphan-floor'].room_count == 0
    assert rows['test-site/orphan-floor'].in_manifest is True


def test_unbound_rooms():
    _site_floor()
    Room.objects.create(floor_key='test-site/floor-1', room_id='r1', label='Unbound', location=None)
    rows = health.run_checks().unbound_rooms
    assert len(rows) == 1
    assert rows[0].room_id == 'r1'
    assert rows[0].label == 'Unbound'


def test_stale_placement_flagged_when_object_gone():
    from dcim.models import Manufacturer, Rack, RackType
    site, _ = _site_floor()
    mfr = Manufacturer.objects.create(name='M', slug='m')
    rtype = RackType.objects.create(manufacturer=mfr, model='RT', slug='rt')
    live_rack = Rack.objects.create(name='R', site=site, rack_type=rtype)

    FacilityMapBlob.objects.create(kind='placements', key='', data={
        'test-site/floor-1': {'placements': [
            {'id': live_rack.pk, 'kind': 'rack', 'room': 'r1', 'label': 'live'},
            {'id': 9999999, 'kind': 'rack', 'room': 'r1', 'label': 'ghost'},
        ]},
    })

    rows = health.run_checks().stale_placements
    assert len(rows) == 1
    assert rows[0].object_id == 9999999
    assert rows[0].label == 'ghost'
    assert rows[0].kind == 'rack'


def test_scoping_hides_rooms_the_user_cannot_view(plain_user):
    # plain_user has no Room view permission, so a scoped run sees no rooms at all — the
    # unbound-room drift is invisible to them (never leaked), unlike the unrestricted run.
    _site_floor()
    Room.objects.create(floor_key='test-site/floor-1', room_id='r1', location=None)

    assert health.run_checks(user=plain_user).unbound_rooms == []
    assert len(health.run_checks(user=None).unbound_rooms) == 1


# --- multi-facility aggregation (MULTI-2): the diagnostic spans every facility's placements blob
# and manifest, so drift in a non-default facility is surfaced too. ------------------------------

def test_stale_placements_aggregate_across_facilities():
    # A ghost placement in a NON-default facility's placements blob must still be flagged — the
    # check iterates all facilities' rows, not just the default `facility=''`.
    FacilityMapBlob.objects.create(kind='placements', facility='west', key='', data={
        'west-site/floor-1': {'placements': [
            {'id': 8888888, 'kind': 'rack', 'room': 'r1', 'label': 'west ghost'},
        ]},
    })
    rows = health.run_checks().stale_placements
    assert [r.label for r in rows] == ['west ghost']


def test_manifest_floor_keys_union_across_facilities(workdir):
    # A floor key present only in a non-default facility's manifest, with no matching Site, is
    # surfaced as an unresolved floor key — proving the manifest union spans facilities.
    (workdir / 'west').mkdir()
    _write_manifest(workdir / 'west', 'ghost-bldg', 'floor-9')
    report = health.run_checks()
    assert any(k.floor_key == 'ghost-bldg/floor-9' for k in report.unresolved_floor_keys)


# --- orphaned facilities (HEALTH-1): data under a facility key no current Site resolves to --------

def test_orphaned_facility_surfaced_in_report():
    # Data under the default facility '' but every Site is now grouped, so nothing resolves to '' —
    # the grouping-drift orphan. The row carries its kinds and the target its own site now points at.
    from dcim.models import Site, SiteGroup
    west = SiteGroup.objects.create(name='West', slug='west')
    Site.objects.create(name='A', slug='a', group=west)
    FacilityMapBlob.objects.create(kind='annotations', key='', facility='', data={'a/floor-1': {}})

    report = health.run_checks()
    assert report.has_drift
    assert [o.facility for o in report.orphaned_facilities] == ['']
    orphan = report.orphaned_facilities[0]
    assert orphan.blob_kinds == ['annotations']
    assert orphan.suggested == 'west'


def test_no_orphan_when_sites_resolve_to_the_data_key():
    # An ungrouped Site resolves to '' — the default-facility data is reachable, not orphaned.
    from dcim.models import Site
    Site.objects.create(name='A', slug='a')
    FacilityMapBlob.objects.create(kind='annotations', key='', facility='', data={'a/floor-1': {}})
    assert health.run_checks().orphaned_facilities == []


def test_command_exit_zero_when_clean():
    from django.core.management import call_command
    # No data at all → clean.
    call_command('facilitymap_check')  # does not raise


def test_command_exit_one_on_drift():
    from django.core.management import call_command
    Room.objects.create(floor_key='gone-site/floor-x', room_id='r1', location=None)
    with pytest.raises(SystemExit) as exc:
        call_command('facilitymap_check')
    assert exc.value.code == 1
