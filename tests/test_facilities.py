"""Tier C — `facilities.py` orphan detection & reassignment (HEALTH-1).

Which facility a Site resolves to is a live function of the install-wide `facility_grouping` setting
and the Site's own SiteGroup/Region. Changing either re-scopes existing data but never re-keys the
rows, so editor blobs strand under the old `facility` key and the map reads as empty though the rows
are intact. These tests cover the detector (`reachable_facilities`/`orphaned_facility_keys`/
`suggested_target`) and the recovery (`reassign_facility` — DB re-key + working-dir move)."""

import pytest

from netbox_facilitymap import facilities
from netbox_facilitymap.models import FacilityMapBlob

pytestmark = pytest.mark.django_db


def _sitegroup(slug):
    from dcim.models import SiteGroup
    return SiteGroup.objects.create(name=slug, slug=slug)


def _region(slug):
    from dcim.models import Region
    return Region.objects.create(name=slug, slug=slug)


def _site(slug, group=None, region=None):
    from dcim.models import Site
    return Site.objects.create(name=slug, slug=slug, group=group, region=region)


def _set_grouping(value):
    FacilityMapBlob.objects.update_or_create(
        kind='settings', facility='', key='', defaults={'data': {'facility_grouping': value}})


def _blob(kind, facility, data=None):
    return FacilityMapBlob.objects.create(kind=kind, facility=facility, key='', data=data or {})


# --- reachable_facilities ------------------------------------------------------------------------

def test_reachable_sitegroup_includes_groups_and_default_for_ungrouped():
    west = _sitegroup('west')
    _site('a')                # ungrouped -> resolves to the default facility ''
    _site('b', group=west)    # -> 'west'
    assert facilities.reachable_facilities() == {'west', ''}


def test_reachable_excludes_default_when_no_site_is_ungrouped():
    west = _sitegroup('west')
    _site('b', group=west)
    assert facilities.reachable_facilities() == {'west'}


def test_reachable_under_region_grouping():
    _set_grouping('region')
    north = _region('north')
    _site('a')                  # no region -> ''
    _site('b', region=north)    # -> 'north'
    assert facilities.reachable_facilities() == {'north', ''}


# --- facility_sites / facility_site_slugs (the building→Site binding scope, FACIL-1) -------------

def test_facility_sites_scopes_to_its_group():
    west = _sitegroup('west')
    east = _sitegroup('east')
    _site('a')                 # ungrouped -> the default facility ''
    _site('b', group=west)
    _site('c', group=east)
    assert facilities.facility_site_slugs('west') == {'b'}
    assert facilities.facility_site_slugs('east') == {'c'}


def test_facility_sites_default_facility_is_the_ungrouped_remainder():
    west = _sitegroup('west')
    _site('a')                 # ungrouped
    _site('b', group=west)
    # '' resolves to the ungrouped remainder only — never a grouped site.
    assert facilities.facility_site_slugs('') == {'a'}


def test_facility_sites_default_is_all_sites_when_none_grouped():
    _site('a')
    _site('b')
    # Single-facility install (no grouping): '' == every site, preserving global semantics.
    assert facilities.facility_site_slugs('') == {'a', 'b'}


def test_facility_sites_under_region_grouping():
    _set_grouping('region')
    north = _region('north')
    _site('a')                    # no region -> ''
    _site('b', region=north)      # -> 'north'
    assert facilities.facility_site_slugs('north') == {'b'}
    assert facilities.facility_site_slugs('') == {'a'}


def test_facility_sites_object_permission_scoped(login_only_user):
    west = _sitegroup('west')
    _site('b', group=west)
    # A user without dcim view permission sees none of the facility's sites — the queryset is
    # restrict(user,'view')-scoped, so NbSitesView never leaks a Site the operator can't see.
    assert facilities.facility_site_slugs('west', user=login_only_user) == set()


# --- orphan detection ----------------------------------------------------------------------------

def test_default_facility_data_orphaned_when_all_sites_grouped():
    # Data under '' but every Site now has a group, so nothing resolves to '' — the "Sites newly
    # grouped" trigger. Its own site resolves to 'west', so that's the suggested target.
    west = _sitegroup('west')
    _site('a', group=west)
    _blob('annotations', '', {'a/floor-1': {'image': 'x.png'}})
    assert facilities.orphaned_facility_keys() == {''}
    assert facilities.suggested_target('') == 'west'


def test_foreign_grouping_slug_orphaned_after_flip_to_region():
    # Data keyed by a SiteGroup slug, then the grouping flips to Region — no Site resolves to the
    # SiteGroup slug anymore, so it's orphaned. Its site (no region) now resolves to the default ''.
    west = _sitegroup('west')
    _site('a', group=west)
    _blob('annotations', 'west', {'a/floor-1': {}})
    _set_grouping('region')
    assert facilities.orphaned_facility_keys() == {'west'}
    assert facilities.suggested_target('west') == ''


def test_siteless_valid_group_with_data_not_orphaned():
    # A group that exists but has no Sites yet (import-in-progress) is a valid current facility, so
    # its data must NOT be mis-flagged.
    _sitegroup('newcampus')
    _blob('annotations', 'newcampus', {'x/floor-1': {}})
    assert facilities.orphaned_facility_keys() == set()


def test_settings_row_is_not_a_data_facility_key():
    _set_grouping('sitegroup')  # writes a settings row at facility='' — not editor data
    assert facilities.data_facility_keys() == set()
    assert facilities.orphaned_facility_keys() == set()


def test_suggested_target_ambiguous_when_sites_disagree():
    # Two floors whose sites resolve to different facilities → no single suggestion.
    a_grp, b_grp = _sitegroup('ga'), _sitegroup('gb')
    _site('sa', group=a_grp)
    _site('sb', group=b_grp)
    _blob('annotations', '', {'sa/f1': {}, 'sb/f1': {}})
    assert facilities.suggested_target('') == ''


# --- reassign_facility ---------------------------------------------------------------------------

def test_reassign_rekeys_editor_blobs_and_preserves_settings(workdir):
    west = _sitegroup('west')
    _site('a', group=west)
    _blob('annotations', '', {'a/f1': {}})
    _blob('siteplan', '', {'hotspots': []})
    _blob('placements', '', {})
    _set_grouping('sitegroup')  # settings row at '' — must NOT move

    kinds = facilities.reassign_facility('', 'west')
    assert kinds == ['annotations', 'placements', 'siteplan']
    assert set(FacilityMapBlob.objects.filter(facility='west').values_list('kind', flat=True)) \
        == {'annotations', 'placements', 'siteplan'}
    assert FacilityMapBlob.objects.filter(facility='', kind='settings').exists()
    assert not FacilityMapBlob.objects.filter(facility='').exclude(kind='settings').exists()


def test_reassign_refuses_when_target_holds_same_kind(workdir):
    west = _sitegroup('west')
    _site('a', group=west)
    _blob('annotations', '', {'a/f1': {}})
    _blob('annotations', 'west', {'b/f1': {}})   # collision — must not clobber
    with pytest.raises(ValueError):
        facilities.reassign_facility('', 'west')
    assert FacilityMapBlob.objects.get(facility='', kind='annotations').data == {'a/f1': {}}


def test_reassign_refuses_when_target_has_rendered_content(workdir):
    # The target has rendered images (a manifest) but no editor blobs yet — refused before any
    # mutation, so the source data stays put (no DB re-key stranding the images).
    from netbox_facilitymap.storage import MANIFEST_NAME, work_dir
    west = _sitegroup('west')
    _site('a', group=west)
    _blob('annotations', '', {'a/f1': {}})
    target = work_dir('west')
    target.mkdir(parents=True)
    (target / MANIFEST_NAME).write_text('{}')

    with pytest.raises(ValueError):
        facilities.reassign_facility('', 'west')
    assert FacilityMapBlob.objects.get(kind='annotations').facility == ''


def test_reassign_rejects_non_reachable_target(workdir):
    west = _sitegroup('west')
    _site('a', group=west)
    _blob('annotations', '', {'a/f1': {}})
    with pytest.raises(ValueError):
        facilities.reassign_facility('', 'nonexistent')


def test_reassign_rejects_same_source_and_target(workdir):
    west = _sitegroup('west')
    _site('a', group=west)
    _blob('annotations', 'west', {'a/f1': {}})
    with pytest.raises(ValueError):
        facilities.reassign_facility('west', 'west')


def test_reassign_rejects_when_no_data_under_source(workdir):
    west = _sitegroup('west')
    _site('a', group=west)
    _site('b')  # ungrouped, so '' is a reachable target
    with pytest.raises(ValueError):
        facilities.reassign_facility('west', '')


def test_facility_floor_scope_matches_renamed_site_room_via_fk():
    # BIND-1: a room whose Site was renamed has a frozen floor_key with the OLD slug (so the
    # startswith clause misses it), but its `floor_location` FK's site carries the CURRENT slug —
    # the unioned FK clause keeps it inside its facility's scope.
    from dcim.models import Location
    from netbox_facilitymap.models import Room

    group = _sitegroup('ga')
    site = _site('sa', group=group)                      # facility 'ga', current site slug 'sa'
    floor = Location.objects.create(name='F1', slug='f1', site=site)
    room = Room.objects.create(
        floor_key='sa-old/f1', room_id='r1', floor_location=floor)  # frozen OLD-slug key

    scope = facilities.facility_floor_scope('ga')
    assert not room.floor_key.startswith('sa/')          # the slug clause genuinely can't match
    assert Room.objects.filter(scope).filter(pk=room.pk).exists()
