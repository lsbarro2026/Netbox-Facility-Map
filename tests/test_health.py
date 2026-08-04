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


def test_fk_covered_key_is_still_flagged_when_its_site_segment_died():
    # HEALTH-11: the FK covers only the FLOOR segment. When the key's *Site* segment no longer names a
    # live Site, `SiteFloors` (which matches the manifest on `siteSlug == site.slug`) drops the whole
    # floor-picker panel — damage no per-room FK compensates for — so the key must still be reported.
    from dcim.models import Location, Site
    site = Site.objects.create(name='Renamed', slug='new-site-slug')
    floor = Location.objects.create(name='Floor 1', slug='floor-1', site=site)
    Room.objects.create(floor_key='old-site-slug/floor-1', room_id='r1', floor_location=floor)

    rows = {r.floor_key: r for r in health.run_checks().unresolved_floor_keys}
    assert 'old-site-slug/floor-1' in rows
    assert rows['old-site-slug/floor-1'].reason == 'no such site'


def test_fk_covered_key_is_still_flagged_when_its_building_segment_died():
    # The 3-segment counterpart: `BuildingFloors` matches on `(siteSlug, buildingSlug)`, so a dead
    # building anchor kills that picker the same way — flag it even though the rooms stay FK-bound.
    from dcim.models import Location, Site
    campus = Site.objects.create(name='Campus', slug='campus')
    building = Location.objects.create(name='Alpha', slug='new-bldg-slug', site=campus)
    floor = Location.objects.create(name='Level 1', slug='level-1', site=campus, parent=building)
    Room.objects.create(floor_key='campus/old-bldg-slug/level-1', room_id='r1', floor_location=floor)

    rows = {r.floor_key: r for r in health.run_checks().unresolved_floor_keys}
    assert 'campus/old-bldg-slug/level-1' in rows
    assert rows['campus/old-bldg-slug/level-1'].reason == 'no building Location under site'


def test_fk_covered_key_with_only_floor_segment_drift_stays_unflagged():
    # The complement that keeps the BIND-1 suppression meaningful: both anchor segments are live and
    # only the floor segment drifted. Both pickers still render (a card's link goes dead, no more), so
    # this stays covered by the FK and unreported.
    from dcim.models import Location, Site
    campus = Site.objects.create(name='Campus', slug='campus')
    building = Location.objects.create(name='Alpha', slug='alpha-bldg', site=campus)
    floor = Location.objects.create(name='Level 1', slug='level-1-renamed', site=campus,
                                    parent=building)
    Room.objects.create(floor_key='campus/alpha-bldg/level-1', room_id='r1', floor_location=floor)

    assert health.run_checks().unresolved_floor_keys == []


def test_unresolved_floor_key_from_manifest_only(workdir):
    # A manifest floor with no matching Location and no rooms — surfaced with room_count 0.
    _write_manifest(workdir, 'test-site', 'orphan-floor')
    _site_floor()  # site exists, but 'orphan-floor' Location does not
    rows = {r.floor_key: r for r in health.run_checks().unresolved_floor_keys}
    assert 'test-site/orphan-floor' in rows
    assert rows['test-site/orphan-floor'].room_count == 0
    assert rows['test-site/orphan-floor'].in_manifest is True


def test_three_segment_manifest_key_that_resolves_is_not_flagged(workdir):
    # MODEL-3: a Location-anchored manifest floor (3-segment key "<site>/<building>/<floor>", no
    # rooms so no rename-proof FK) must resolve against the building Location and NOT be reported as
    # unresolved. Without the parent-aware resolution it would false-positive.
    from dcim.models import Location, Site
    campus = Site.objects.create(name='Campus', slug='campus')
    building = Location.objects.create(name='Alpha', slug='alpha-bldg', site=campus)
    Location.objects.create(name='Level 1', slug='level-1', site=campus, parent=building)
    _write_manifest(workdir, 'campus/alpha-bldg', 'level-1')  # compound dir -> 3-segment floor key

    assert health.run_checks().unresolved_floor_keys == []


def test_three_segment_manifest_key_wrong_building_is_flagged(workdir):
    # The same floor slug exists, but under a DIFFERENT building — the 3-segment key names a building
    # with no such child floor, so it IS drift (proving the resolution is parent-scoped, not just
    # (site, floor)).
    from dcim.models import Location, Site
    campus = Site.objects.create(name='Campus', slug='campus')
    other = Location.objects.create(name='Other', slug='other-bldg', site=campus)
    Location.objects.create(name='Level 1', slug='level-1', site=campus, parent=other)
    _write_manifest(workdir, 'campus/alpha-bldg', 'level-1')  # names alpha-bldg, which has no level-1

    rows = {r.floor_key: r for r in health.run_checks().unresolved_floor_keys}
    assert 'campus/alpha-bldg/level-1' in rows
    # The building segment is what's missing here, and the reason says so (HEALTH-11) — 'no floor
    # Location under site' would misdirect an operator to look for the floor.
    assert rows['campus/alpha-bldg/level-1'].reason == 'no building Location under site'


def test_empty_floor_remapped_on_rename_is_not_flagged(workdir, django_capture_on_commit_callbacks):
    # HEALTH-4: an EMPTY floor (rendered plan, no rooms) whose floor Location is renamed through a
    # normal `save()` is auto-remapped by the rename signal — the frozen manifest key is re-keyed to
    # the new slug in place, so it resolves again and health reports NO drift (this used to be the
    # blank-panel residual, now fixed at the source; see test_signals / test_template_content).
    site, floor = _site_floor()                  # 'test-site' / 'floor-1'
    _write_manifest(workdir, 'test-site', 'floor-1')  # manifest frozen at the pre-rename slug
    with django_capture_on_commit_callbacks(execute=True):
        floor.slug = 'floor-1-renamed'
        floor.save()

    assert health.run_checks().unresolved_floor_keys == []


def test_empty_floor_orphaned_by_bulk_rename_is_flagged(workdir):
    # The residue the signal can't cover: a `bulk_update` rename (NetBox CSV import / bulk-edit) fires
    # no save()/post_save, so nothing re-keys the manifest and the empty floor's key stops resolving.
    # health still surfaces it — the backstop HEALTH-5 turns into a user-facing message.
    from dcim.models import Location
    site, floor = _site_floor()                  # 'test-site' / 'floor-1'
    _write_manifest(workdir, 'test-site', 'floor-1')
    Location.objects.filter(pk=floor.pk).update(slug='floor-1-renamed')  # bulk path — no signal

    rows = {r.floor_key: r for r in health.run_checks().unresolved_floor_keys}
    assert 'test-site/floor-1' in rows
    assert rows['test-site/floor-1'].reason == 'no floor Location under site'
    assert rows['test-site/floor-1'].room_count == 0
    assert rows['test-site/floor-1'].in_manifest is True


# --- floor_plan_drift: the per-Location signal that lets FloorRooms explain a *blank* floor panel
# to a regular user (HEALTH-5) only when the floor's plan key drifted — never on a non-floor
# Location. Confident match = a manifest floor whose id still == loc.slug under a dir whose Site slug
# is no longer live (a renamed Site the manifest wasn't re-keyed for). ---------------------------

def test_floor_plan_drift_true_after_bulk_site_rename(workdir):
    # A bulk Site rename (no signal) leaves the manifest frozen under the OLD site slug while the
    # floor Location's own slug is intact — the residue that turns an empty floor blank. Drift = True.
    from dcim.models import Location, Site
    _write_manifest(workdir, 'test-site', 'floor-1')   # manifest dir = the pre-rename site slug
    site, floor = _site_floor()                        # 'test-site' / 'floor-1'
    Site.objects.filter(pk=site.pk).update(slug='test-site-renamed')  # bulk path — no remap
    floor.refresh_from_db()

    assert health.floor_plan_drift(floor) is True


def test_floor_plan_drift_false_for_non_floor_location(workdir):
    # A Location that isn't a floor at all (its slug matches no manifest floor id) must NEVER get the
    # message — the panel stays legitimately blank.
    from dcim.models import Location
    _write_manifest(workdir, 'test-site', 'floor-1')
    site, _floor = _site_floor()
    hallway = Location.objects.create(name='Hallway', slug='hallway', site=site)

    assert health.floor_plan_drift(hallway) is False


def test_floor_plan_drift_false_when_slug_matches_a_live_building(workdir):
    # A non-floor Location whose slug coincidentally equals a real floor id under a DIFFERENT, still
    # live building is a slug collision, not this Location's orphaned plan — so no message.
    from dcim.models import Location, Site
    _write_manifest(workdir, 'other-site', 'shared-floor')  # a legit floor under a live site
    Site.objects.create(name='Other Site', slug='other-site')
    my_site = Site.objects.create(name='My Site', slug='my-site')
    coincidental = Location.objects.create(name='X', slug='shared-floor', site=my_site)

    assert health.floor_plan_drift(coincidental) is False


def test_floor_plan_drift_false_when_own_site_has_a_live_manifest_building(workdir):
    # Tightest collision case: `loc`'s own Site is a live imported building, and `loc.slug` collides
    # with a floor id stranded under a *dead* dir belonging to some other (renamed-away) Site. Without
    # the "own Site is a live manifest dir" guard this would false-positive; with it, no message —
    # the orphaned floor isn't THIS Location's plan.
    from dcim.models import Location, Site
    # A two-building manifest: a live 'test-site' (floor 'lobby') + an orphaned 'old-site' (floor
    # 'floor-1') left behind by a rename. `loc` is 'floor-1' under the *live* test-site.
    (workdir / 'manifest.json').write_text(json.dumps({'siteplan': None, 'buildings': [
        {'code': 'A', 'dir': 'test-site', 'name': 'A', 'siteSlug': 'test-site',
         'floors': [{'id': 'lobby', 'label': 'L', 'floorSlug': 'lobby', 'image': 'a.png',
                     'w': 100, 'h': 100, 'pages': []}]},
        {'code': 'B', 'dir': 'old-site', 'name': 'B', 'siteSlug': 'old-site',
         'floors': [{'id': 'floor-1', 'label': 'F', 'floorSlug': 'floor-1', 'image': 'b.png',
                     'w': 100, 'h': 100, 'pages': []}]},
    ]}))
    site = Site.objects.create(name='Test Site', slug='test-site')  # live, in the manifest
    loc = Location.objects.create(name='Floor 1', slug='floor-1', site=site)

    assert health.floor_plan_drift(loc) is False


def test_floor_plan_drift_false_for_resolving_floor(workdir):
    # A floor whose current slugs resolve in the manifest (nothing renamed): its plan renders, so
    # there's no drift to explain.
    _write_manifest(workdir, 'test-site', 'floor-1')
    _site, floor = _site_floor()                        # 'test-site' / 'floor-1' matches the manifest

    assert health.floor_plan_drift(floor) is False


def test_floor_plan_drift_false_without_manifest():
    # No rendered manifest at all (a normal pre-import state) — nothing to call drift, so no message.
    _site, floor = _site_floor()
    assert health.floor_plan_drift(floor) is False


def test_unbound_rooms():
    _site_floor()
    Room.objects.create(floor_key='test-site/floor-1', room_id='r1', label='Unbound', location=None)
    rows = health.run_checks().unbound_rooms
    assert len(rows) == 1
    assert rows[0].room_id == 'r1'
    assert rows[0].label == 'Unbound'


def test_unbound_room_is_reported_but_is_not_drift():
    # DOC-12: a draw-only room is a supported state, not a fault. It must still be *reported* (an
    # operator wants to see them, and a deleted Location lands here too), but it must not set
    # `has_drift` — otherwise an install that deliberately doesn't model a Location per room reads
    # as permanently unhealthy and its `facilitymap_check` cron alerts forever.
    # The floor key resolves, so an unbound room is the report's ONLY finding.
    _site_floor()
    Room.objects.create(floor_key='test-site/floor-1', room_id='r1', label='Draw only', location=None)

    report = health.run_checks()
    assert len(report.unbound_rooms) == 1
    assert report.unresolved_floor_keys == []
    assert report.stale_placements == []
    assert report.orphaned_facilities == []
    assert not report.has_drift


def test_stale_placement_flagged_when_object_gone():
    from dcim.models import Manufacturer, Rack, RackType
    site, _ = _site_floor()
    mfr = Manufacturer.objects.create(name='M', slug='m')
    rtype = RackType.objects.create(manufacturer=mfr, model='RT', slug='rt')
    live_rack = Rack.objects.create(name='R', site=site, rack_type=rtype)

    FacilityMapBlob.objects.create(kind='placements', key='test-site/floor-1', data={'placements': [
        {'id': live_rack.pk, 'kind': 'rack', 'room': 'r1', 'label': 'live'},
        {'id': 9999999, 'kind': 'rack', 'room': 'r1', 'label': 'ghost'},
    ]})

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
    FacilityMapBlob.objects.create(kind='placements', facility='west', key='west-site/floor-1',
                                   data={'placements': [
                                       {'id': 8888888, 'kind': 'rack', 'room': 'r1', 'label': 'west ghost'},
                                   ]})
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
    FacilityMapBlob.objects.create(kind='annotations', key='a/floor-1', facility='', data={})

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
    FacilityMapBlob.objects.create(kind='annotations', key='a/floor-1', facility='', data={})
    assert health.run_checks().orphaned_facilities == []


def test_command_exit_zero_when_clean():
    from django.core.management import call_command
    # No data at all → clean.
    call_command('facilitymap_check')  # does not raise


def test_command_exit_one_on_drift(capsys):
    from django.core.management import call_command
    # This room is unbound AND sits on an unresolvable floor key. Since DOC-12 only the latter is
    # drift, so assert the exit is driven by the floor key — otherwise this test would keep passing
    # for the wrong reason if the unbound-room demotion were ever reverted.
    Room.objects.create(floor_key='gone-site/floor-x', room_id='r1', location=None)
    with pytest.raises(SystemExit) as exc:
        call_command('facilitymap_check')
    assert exc.value.code == 1
    out = capsys.readouterr()
    assert 'Unresolved floor keys' in out.out
    assert '1 issue(s) found.' in out.err   # the draw-only room is NOT counted


def test_command_exits_zero_when_only_draw_only_rooms(capsys):
    # DOC-12: the whole point of the demotion — a draw-only install must exit 0 so a cron job
    # doesn't alert forever, while still *printing* the rooms so the operator can see them.
    from django.core.management import call_command
    _site_floor()
    Room.objects.create(floor_key='test-site/floor-1', room_id='r1', label='Draw only', location=None)

    call_command('facilitymap_check')   # must not raise SystemExit
    out = capsys.readouterr()
    assert 'Draw-only rooms' in out.out
    assert 'Draw only' in out.out
    assert 'No consistency issues found.' in out.out


def test_command_reports_orphaned_facilities(capsys):
    # HEALTH-11: `has_drift` counts orphaned facilities, so the command must PRINT them too. It used
    # to report only the other three classes — an install whose sole drift was an orphaned facility
    # got three green OK lines, "0 issue(s) found." and a bare exit 1, with nothing to act on.
    from django.core.management import call_command
    from dcim.models import Site, SiteGroup
    west = SiteGroup.objects.create(name='West', slug='west')
    Site.objects.create(name='A', slug='a', group=west)
    FacilityMapBlob.objects.create(kind='annotations', key='a/floor-1', facility='', data={})

    with pytest.raises(SystemExit) as exc:
        call_command('facilitymap_check')
    assert exc.value.code == 1
    out = capsys.readouterr()
    assert 'Orphaned facilities' in out.out
    assert 'annotations' in out.out
    assert 'reassign to west' in out.out
    assert '1 issue(s) found.' in out.err   # counted, not just flagged


# --- orphan detection under the `location` grouping (MODEL-8) ------------------------------------

def test_location_facility_data_not_orphaned_while_its_root_lives():
    from dcim.models import Location, Site

    FacilityMapBlob.objects.update_or_create(
        kind='settings', facility='', key='', defaults={'data': {'facility_grouping': 'location'}})
    site = Site.objects.create(name='Campus', slug='campus')
    root = Location.objects.create(name='Building A', slug='bldg-a', site=site)
    Location.objects.create(name='A L1', slug='a-l1', site=site, parent=root)
    FacilityMapBlob.objects.create(kind='annotations', facility='bldg-a',
                                   key='campus/bldg-a/a-l1', data={})

    assert health.run_checks().orphaned_facilities == []

    # Deleting the root (the org edit the mode is sensitive to) strands the facility's data —
    # the HEALTH-1 detector must flag it so the reassignment surface can recover it.
    root.delete()
    report = health.run_checks()
    assert [o.facility for o in report.orphaned_facilities] == ['bldg-a']
