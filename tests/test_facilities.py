"""Tier C — `facilities.py` orphan detection & reassignment (HEALTH-1).

Which facility a Site resolves to is a live function of the install-wide `facility_grouping` setting
and the Site's own SiteGroup/Region. Changing either re-scopes existing data but never re-keys the
rows, so editor blobs strand under the old `facility` key and the map reads as empty though the rows
are intact. These tests cover the detector (`reachable_facilities`/`orphaned_facility_keys`/
`suggested_target`), the recovery (`reassign_facility` — DB re-key + working-dir move), and the
explicit Site→facility assignment layer (FACILITY-IDENTITY Phase 1) that dissolves the trap for
assigned Sites — assignment-first resolution, the assignment-aware inverse/reachable set, and the
`assign_facilities`/`rename_site_assignment` write paths."""

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


_SHARDED = {'annotations', 'placements', 'layouts'}


def _blob(kind, facility, data=None):
    """Create blob row(s) for `kind`, matching production shape. The per-floor kinds
    (annotations/placements/layouts) are sharded one row per floor (`key=floor_key`, CONC-1), so a
    floor-keyed `data` dict is split into per-floor rows; the single-row kinds (siteplan/settings)
    get one `key=''` row. Returns the last row created (or None if a sharded `data` was empty)."""
    data = data or {}
    if kind in _SHARDED:
        row = None
        for floor_key, floor_data in data.items():
            row = FacilityMapBlob.objects.create(kind=kind, facility=facility, key=floor_key, data=floor_data)
        return row
    return FacilityMapBlob.objects.create(kind=kind, facility=facility, key='', data=data)


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
    _blob('placements', '', {'a/f1': {'placements': [{'room': 'r'}]}})
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
    # Source unchanged — the collision refusal happened before any re-key (its per-floor row stays).
    assert FacilityMapBlob.objects.get(facility='', kind='annotations').key == 'a/f1'


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


# --- explicit Site→facility assignment (FACILITY-IDENTITY Phase 1) -------------------------------
#
# `facility_for_site` is assignment-first, derive-on-miss: an explicit `facility_map` entry wins;
# a Site absent from the map derives from its SiteGroup/Region exactly as before, so an install
# with no map resolves byte-identically (the zero-migration guarantee). The inverse mapping
# (`facility_sites`) and the reachable set follow the same rule.

def test_no_assignment_map_resolves_exactly_as_derivation():
    # The zero-migration regression guard: with no facility_map blob, every path derives.
    west = _sitegroup('west')
    a = _site('a')
    b = _site('b', group=west)
    assert facilities.facility_map() == {}
    assert facilities.facility_for_site(a) == ''
    assert facilities.facility_for_site(b) == 'west'
    assert facilities.facility_site_slugs('west') == {'b'}
    assert facilities.facility_site_slugs('') == {'a'}
    assert facilities.reachable_facilities() == {'west', ''}


def test_assignment_wins_over_grouping():
    west = _sitegroup('west')
    b = _site('b', group=west)
    facilities.assign_facilities({'b': 'campus-x'})
    assert facilities.facility_for_site(b) == 'campus-x'
    # The inverse follows: 'b' left its derived facility's site set and joined the assigned one.
    assert facilities.facility_site_slugs('west') == set()
    assert facilities.facility_site_slugs('campus-x') == {'b'}


def test_explicit_default_assignment_wins():
    # An explicit '' assignment pins a grouped Site to the default facility.
    west = _sitegroup('west')
    b = _site('b', group=west)
    facilities.assign_facilities({'b': ''})
    assert facilities.facility_for_site(b) == ''
    assert facilities.facility_site_slugs('') == {'b'}
    assert facilities.facility_site_slugs('west') == set()


def test_unassigned_site_still_derives_beside_an_assigned_one():
    west = _sitegroup('west')
    b = _site('b', group=west)
    c = _site('c', group=west)
    facilities.assign_facilities({'b': 'campus-x'})
    assert facilities.facility_for_site(c) == 'west'
    assert facilities.facility_site_slugs('west') == {'c'}


def test_reachable_includes_assignment_only_facility():
    # An assigned facility need not correspond to any grouping object — it is reachable purely by
    # assignment, so data stored under it is never flagged orphaned.
    west = _sitegroup('west')
    _site('b', group=west)
    facilities.assign_facilities({'b': 'campus-x'})
    assert facilities.reachable_facilities() == {'west', 'campus-x'}
    _blob('annotations', 'campus-x', {'b/f1': {}})
    assert facilities.orphaned_facility_keys() == set()


def test_regrouping_an_assigned_site_never_orphans():
    # The HEALTH-1 trap, dissolved for assigned Sites: regroup the Site, its data stays reachable
    # under the assigned key. (test_default_facility_data_orphaned_when_all_sites_grouped pins the
    # legacy behaviour for the unassigned remainder.)
    west = _sitegroup('west')
    east = _sitegroup('east')
    b = _site('b', group=west)
    facilities.assign_facilities({'b': 'west'})
    _blob('annotations', 'west', {'b/f1': {}})
    b.group = east
    b.save()
    assert facilities.facility_for_site(b) == 'west'
    assert facilities.orphaned_facility_keys() == set()


def test_grouping_flip_never_orphans_an_assigned_site():
    # Same trap via the other trigger: flipping the install-wide grouping re-derives every
    # unassigned Site, but an assigned one keeps its explicit facility.
    west = _sitegroup('west')
    b = _site('b', group=west)
    facilities.assign_facilities({'b': 'west'})
    _blob('annotations', 'west', {'b/f1': {}})
    _set_grouping('region')
    assert facilities.facility_for_site(b) == 'west'
    assert facilities.orphaned_facility_keys() == set()


def test_assigning_away_the_last_default_site_orphans_default_data():
    # Assignment is deliberate, so it MAY orphan: assigning the only ''-resolving Site elsewhere
    # makes '' unreachable and its data flags for reassignment — the detector stays honest.
    _sitegroup('west')
    _site('a')
    _blob('annotations', '', {'a/f1': {}})
    facilities.assign_facilities({'a': 'west'})
    assert facilities.orphaned_facility_keys() == {''}


def test_list_facilities_and_choices_include_assignment_only_slug(superuser):
    _sitegroup('west')
    _site('b')
    facilities.assign_facilities({'b': 'campus-x'})
    listed = {f['slug']: f for f in facilities.list_facilities(superuser)['facilities']}
    # No grouping object, so the slug doubles as the display name.
    assert listed['campus-x']['name'] == 'campus-x'
    choices = {c['slug']: c['name'] for c in facilities.reachable_facility_choices()}
    assert choices['campus-x'] == 'campus-x'


def test_assign_validates_slug_site_and_shape():
    _site('a')
    with pytest.raises(ValueError):
        facilities.assign_facilities({'a': '../escape'})     # traversal — valid_facility gate
    with pytest.raises(ValueError):
        facilities.assign_facilities({'a': 'images'})        # reserved working-dir name
    with pytest.raises(ValueError):
        facilities.assign_facilities({'ghost': 'west'})      # unknown Site slug
    with pytest.raises(ValueError):
        facilities.assign_facilities({'a': 3})               # non-string value
    with pytest.raises(ValueError):
        facilities.assign_facilities([])                     # not an object
    with pytest.raises(ValueError):
        facilities.assign_facilities({})                     # empty — nothing to do
    assert not FacilityMapBlob.objects.filter(kind='facility_map').exists()


def test_assign_merges_and_none_removes():
    a, b = _site('a'), _site('b')
    facilities.assign_facilities({'a': 'campus-x'})
    facilities.assign_facilities({'b': 'campus-y'})
    assert facilities.facility_map() == {'a': 'campus-x', 'b': 'campus-y'}
    # None deletes — and needs no live Site, so a since-deleted Site's entry can be cleaned up.
    b.delete()
    facilities.assign_facilities({'b': None})
    assert facilities.facility_map() == {'a': 'campus-x'}
    assert facilities.facility_for_site(a) == 'campus-x'


def test_rename_site_assignment_rekeys_and_guards_collision():
    _site('a')
    _site('b')
    facilities.assign_facilities({'a': 'campus-x'})
    assert facilities.rename_site_assignment('a', 'a2') is True
    assert facilities.facility_map() == {'a2': 'campus-x'}
    assert facilities.rename_site_assignment('ghost', 'g2') is False   # idempotent no-op
    facilities.assign_facilities({'b': 'campus-y'})
    with pytest.raises(ValueError):
        facilities.rename_site_assignment('b', 'a2')                   # collision — left standing
    assert facilities.facility_map() == {'a2': 'campus-x', 'b': 'campus-y'}


def test_facility_floor_scope_matches_three_segment_key():
    # MODEL-3: a Location-anchored 3-segment key "<site>/<building>/<floor>" keeps the site slug as
    # segment 1, so the `startswith '<slug>/'` scoping selects it exactly like a 2-segment key —
    # no change to the MULTI-2 scoping invariant.
    from netbox_facilitymap.models import Room

    group = _sitegroup('ga')
    _site('sa', group=group)                             # facility 'ga' owns site slug 'sa'
    _site('sb')                                          # ungrouped -> a different facility ('')
    in_scope = Room.objects.create(floor_key='sa/alpha-bldg/level-1', room_id='r1')
    out_scope = Room.objects.create(floor_key='sb/beta-bldg/level-1', room_id='r2')

    scope = facilities.facility_floor_scope('ga')
    matched = set(Room.objects.filter(scope).values_list('pk', flat=True))
    assert in_scope.pk in matched and out_scope.pk not in matched


# --- grouping_change_preview (FACILITY-IDENTITY Phase 3 / MULTI-7): the before/after behind the
# wizard's reassignment modal, which replaced a blanket "your data may disappear" confirm. --------

def test_preview_lists_the_unassigned_sites_that_move():
    # The core diff: an unassigned Site derives from its SiteGroup today and its Region afterwards,
    # so flipping the grouping moves it — named, with both facility slugs and display names.
    west = _sitegroup('west')
    north = _region('north')
    _site('b', group=west, region=north)

    preview = facilities.grouping_change_preview('region')
    assert preview['grouping'] == {'from': 'sitegroup', 'to': 'region'}
    assert [(m['site'], m['from'], m['to']) for m in preview['moves']] == [('b', 'west', 'north')]
    assert preview['moves'][0]['from_name'] == 'west' and preview['moves'][0]['to_name'] == 'north'


def test_preview_omits_assigned_sites():
    # Phase 1's payoff, asserted where the operator sees it: an assigned Site cannot be re-keyed by
    # a grouping change, so it never appears as a move — only the unassigned remainder does.
    west = _sitegroup('west')
    north = _region('north')
    _site('locked', group=west, region=north)
    _site('loose', group=west, region=north)
    facilities.assign_facilities({'locked': 'west'})

    preview = facilities.grouping_change_preview('region')
    assert [m['site'] for m in preview['moves']] == ['loose']
    assert preview['assigned'] == 1


def test_preview_of_a_change_that_moves_nothing_is_empty():
    # A Site whose SiteGroup and Region slugs agree resolves the same either way, so the modal can
    # say "nothing moves" rather than warning about a change with no blast radius.
    _site('b', group=_sitegroup('same'), region=_region('same'))
    assert facilities.grouping_change_preview('region')['moves'] == []


def test_preview_counts_the_floors_and_rooms_riding_on_a_move():
    # "What moves" is only useful with weight behind it: the rooms on the Site's floors, and the
    # floors themselves — including a drawn floor that has no rooms yet (an annotations shard).
    from netbox_facilitymap.models import Room

    west = _sitegroup('west')
    north = _region('north')
    _site('b', group=west, region=north)
    Room.objects.create(floor_key='b/f1', room_id='r1')
    Room.objects.create(floor_key='b/f1', room_id='r2')
    _blob('annotations', 'west', {'b/f2': {}})

    move = facilities.grouping_change_preview('region')['moves'][0]
    assert move['rooms'] == 2 and move['floors'] == 2


def test_preview_flags_data_stranded_by_the_change():
    # The orphan half: data under 'west' has no Site pointing at it once the grouping is Region,
    # and it is NOT marked `already` — this change is what strands it.
    west = _sitegroup('west')
    north = _region('north')
    _site('b', group=west, region=north)
    _blob('annotations', 'west', {'b/f1': {}})

    preview = facilities.grouping_change_preview('region')
    orphans = preview['orphans']
    assert [o['facility'] for o in orphans] == ['west']
    assert orphans[0]['kinds'] == ['annotations'] and orphans[0]['already'] is False
    # The suggestion is evaluated under the PROSPECTIVE grouping, so it points where the data's own
    # site will resolve to — the one-click-correct target — and the picker offers the facilities
    # that will exist *after* the change, not the ones that exist now.
    assert orphans[0]['suggested'] == 'north'
    assert {c['slug'] for c in preview['choices']} == {'north'}


def test_preview_marks_pre_existing_orphans_as_already():
    # Drift that predates the change is still worth offering to fix in the same pass, but the modal
    # must not blame this change for it.
    west = _sitegroup('west')
    _region('north')
    _site('b', group=west, region=None)
    _blob('annotations', 'gone', {'b/f1': {}})

    orphans = {o['facility']: o for o in facilities.grouping_change_preview('region')['orphans']}
    assert orphans['gone']['already'] is True


def test_preview_rejects_an_unknown_grouping():
    with pytest.raises(ValueError):
        facilities.grouping_change_preview('campus')


def test_reachable_facilities_honours_a_prospective_grouping():
    # The override the preview is built on: evaluate the reachable set under a grouping that has
    # NOT been written, leaving the live setting untouched.
    west = _sitegroup('west')
    north = _region('north')
    _site('b', group=west, region=north)

    assert facilities.reachable_facilities() == {'west'}
    assert facilities.reachable_facilities(group='region') == {'north'}
    assert facilities.grouping() == 'sitegroup'          # nothing was persisted
    assert {c['slug'] for c in facilities.reachable_facility_choices(group='region')} == {'north'}


# --- organization mode (MODEL-6) -----------------------------------------------------------------

def test_org_mode_defaults_when_never_set():
    assert facilities.org_modes() == {}
    assert facilities.org_mode('west') == facilities.ORG_MODE_DEFAULT == 'site-as-building'
    assert facilities.org_mode('') == 'site-as-building'


def test_set_org_mode_round_trips_per_facility():
    facilities.set_org_mode('west', 'site-as-campus')
    assert facilities.org_mode('west') == 'site-as-campus'
    # A *different* facility is untouched by the write — the mode is per facility, not install-wide.
    assert facilities.org_mode('east') == 'site-as-building'
    assert facilities.org_mode('') == 'site-as-building'


def test_set_org_mode_preserves_sibling_facilities_and_settings_keys():
    # The nested map is why this write can't ride `merge_settings`' flat merge: a second facility's
    # write must not clobber the first, and the unrelated settings keys must survive both.
    FacilityMapBlob.objects.create(kind='settings', facility='', key='',
                                   data={'facility_grouping': 'region', 'room_embed_zoom': 3})
    facilities.set_org_mode('west', 'site-as-campus')
    facilities.set_org_mode('east', 'site-as-campus')
    facilities.set_org_mode('west', 'site-as-building')

    assert facilities.org_modes() == {'west': 'site-as-building', 'east': 'site-as-campus'}
    data = FacilityMapBlob.objects.get(kind='settings', facility='', key='').data
    assert data['facility_grouping'] == 'region'
    assert data['room_embed_zoom'] == 3
    assert facilities.grouping() == 'region'


def test_set_org_mode_rejects_an_unknown_mode_and_a_bad_facility():
    with pytest.raises(ValueError):
        facilities.set_org_mode('west', 'site-as-anything')
    with pytest.raises(ValueError):
        facilities.set_org_mode('../escape', 'site-as-campus')
    # Nothing was written by either refusal.
    assert facilities.org_modes() == {}


def test_org_modes_drops_a_hand_edited_garbage_entry():
    FacilityMapBlob.objects.create(
        kind='settings', facility='', key='',
        data={'facility_org_modes': {'west': 'nonsense', 'east': 'site-as-campus', 7: 'x'}})
    assert facilities.org_modes() == {'east': 'site-as-campus'}
    assert facilities.org_mode('west') == 'site-as-building'


def test_list_facilities_stamps_the_org_mode_on_every_record(superuser):
    _sitegroup('west')
    _sitegroup('east')
    facilities.set_org_mode('west', 'site-as-campus')

    listed = {f['slug']: f for f in facilities.list_facilities(superuser)['facilities']}
    assert listed['west']['org_mode'] == 'site-as-campus'
    assert listed['east']['org_mode'] == 'site-as-building'


# --- the `location` grouping (MODEL-8): a facility = a top-level Location subtree ----------------
#
# Under `facility_grouping = 'location'` each top-level `dcim.Location` under a Site is its own
# facility (slug-identified, its subtree the scope) — the shape a Site-level grouping cannot split.
# Resolution runs below the Site (`facility_for_location`/`facility_for_floor_key`), room scoping by
# subtree rather than the shared campus Site, and the site-level derivation answers ''.

def _location(site, slug, parent=None):
    from dcim.models import Location
    return Location.objects.create(name=slug, slug=slug, site=site, parent=parent)


def _campus_tree():
    """One campus Site hosting two building facilities, each with one floor: the canonical
    location-grouping fixture. Returns (site, bldg_a, bldg_b, floor_a, floor_b)."""
    _set_grouping('location')
    site = _site('campus')
    a = _location(site, 'bldg-a')
    b = _location(site, 'bldg-b')
    fa = _location(site, 'a-l1', parent=a)
    fb = _location(site, 'b-l1', parent=b)
    return site, a, b, fa, fb


def test_reachable_under_location_grouping():
    _, _a, _b, _fa, _fb = _campus_tree()
    _site('lonely')                       # no top-level Location -> resolves to ''
    assert facilities.reachable_facilities() == {'bldg-a', 'bldg-b', ''}


def test_reachable_location_excludes_default_when_every_site_hosts_a_root():
    _campus_tree()
    assert facilities.reachable_facilities() == {'bldg-a', 'bldg-b'}


def test_facility_sites_under_location_grouping():
    site, *_ = _campus_tree()
    _site('lonely')
    # Both facilities are hosted by the one campus Site; '' is the root-less remainder ONLY —
    # never the campus, whose rooms belong to its subtree facilities.
    assert facilities.facility_site_slugs('bldg-a') == {'campus'}
    assert facilities.facility_site_slugs('bldg-b') == {'campus'}
    assert facilities.facility_site_slugs('') == {'lonely'}


def test_facility_for_location_walks_to_the_root():
    site, a, _b, fa, _fb = _campus_tree()
    room = _location(site, 'a-101', parent=fa)
    assert facilities.facility_for_location(a) == 'bldg-a'
    assert facilities.facility_for_location(fa) == 'bldg-a'
    assert facilities.facility_for_location(room) == 'bldg-a'


def test_facility_for_location_delegates_to_site_outside_location_grouping():
    group = _sitegroup('west')
    site = _site('sa', group=group)
    floor = _location(site, 'f1')
    assert facilities.facility_for_location(floor) == 'west'


def test_facility_for_location_honours_a_site_assignment():
    site, a, _b, _fa, _fb = _campus_tree()
    facilities.assign_facilities({'campus': 'pinned'})
    # Assignment-first everywhere: a whole-Site pin overrides the tree derivation.
    assert facilities.facility_for_location(a) == 'pinned'


def test_facility_for_floor_key_resolves_via_the_anchor_root():
    site, _a, _b, _fa, _fb = _campus_tree()
    # A wing tree: the anchor (the floors' direct parent, MULTI-5) sits INSIDE the facility
    # subtree — resolution must walk to the root, not stop at the anchor.
    wing = _location(site, 'west-wing')
    deep = _location(site, 'ww-bldg', parent=wing)
    _location(site, 'ww-l1', parent=deep)
    assert facilities.facility_for_floor_key('campus/bldg-a/a-l1') == 'bldg-a'
    assert facilities.facility_for_floor_key('campus/ww-bldg/ww-l1') == 'west-wing'


def test_facility_for_floor_key_falls_back_to_the_site():
    _campus_tree()
    _site('lonely')
    # A 2-segment key has no anchor segment, and a dead anchor resolves nothing — both fall back
    # to the site-level answer ('' for an unassigned site under this grouping).
    assert facilities.facility_for_floor_key('lonely/f1') == ''
    assert facilities.facility_for_floor_key('campus/gone-bldg/l1') == ''


def test_location_floor_scope_isolates_sibling_facilities():
    # THE data-safety property of the mode: two facilities share the campus Site, so facility A's
    # scope (the Q behind sync_rooms' authoritative cross-floor delete) must never match facility
    # B's rooms — by FK or by key prefix.
    from netbox_facilitymap.models import Room

    _site_, _a, _b, fa, fb = _campus_tree()
    room_a = Room.objects.create(floor_key='campus/bldg-a/a-l1', room_id='ra', floor_location=fa)
    room_b = Room.objects.create(floor_key='campus/bldg-b/b-l1', room_id='rb', floor_location=fb)
    # A room with no FK (unbound/renamed) still scopes by its site-qualified key prefix.
    room_a_keyed = Room.objects.create(floor_key='campus/bldg-a/a-l2', room_id='rk')

    scope = facilities.facility_floor_scope('bldg-a')
    matched = set(Room.objects.filter(scope).values_list('pk', flat=True))
    assert matched == {room_a.pk, room_a_keyed.pk}
    assert room_b.pk not in matched


def test_location_floor_scope_covers_an_assigned_site_wholesale():
    from netbox_facilitymap.models import Room

    _campus_tree()
    _site('annex')
    facilities.assign_facilities({'annex': 'bldg-a'})
    annex_room = Room.objects.create(floor_key='annex/f1', room_id='r1')
    scope = facilities.facility_floor_scope('bldg-a')
    assert Room.objects.filter(scope).filter(pk=annex_room.pk).exists()


def test_location_floor_scope_none_for_an_unknown_facility():
    _campus_tree()
    assert facilities.facility_floor_scope('no-such') is None


def test_org_mode_reads_campus_under_location_grouping():
    _set_grouping('location')
    facilities.set_org_mode('bldg-a', 'site-as-building')   # stored entry survives untouched...
    assert facilities.org_mode('bldg-a') == 'site-as-campus'  # ...but the read is campus-shaped
    assert facilities.org_modes()['bldg-a'] == 'site-as-building'


def test_list_facilities_enumerates_top_level_locations(superuser):
    site, _a, _b, _fa, _fb = _campus_tree()
    listed = facilities.list_facilities(superuser)
    assert listed['grouping'] == 'location'
    by_slug = {f['slug']: f for f in listed['facilities']}
    assert set(by_slug) == {'bldg-a', 'bldg-b'}
    # Every record reads campus-shaped under this grouping (the org_mode() override, in bulk).
    assert all(f['org_mode'] == 'site-as-campus' for f in by_slug.values())


def test_suggested_target_resolves_by_anchor_under_location_grouping():
    # Data stranded under an old sitegroup key: its own 3-segment floor keys point at bldg-a's
    # subtree, so the prospective-location suggestion is the one-click-correct target.
    _site_, _a, _b, _fa, _fb = _campus_tree()
    _set_grouping('sitegroup')                 # live grouping is still sitegroup...
    _blob('annotations', 'old-west', {'campus/bldg-a/a-l1': {}})
    assert facilities.suggested_target('old-west', group='location') == 'bldg-a'


def test_preview_to_location_strands_and_offers_location_choices():
    # Switching a populated sitegroup install to the location grouping: the unassigned Site's
    # derivation drops to '' (the facilities live below the Site), the old key is stranded, and
    # the reassignment picker offers the top-level Locations that exist afterwards.
    west = _sitegroup('west')
    site = _site('campus', group=west)
    a = _location(site, 'bldg-a')
    _location(site, 'a-l1', parent=a)
    _blob('annotations', 'west', {'campus/bldg-a/a-l1': {}})

    preview = facilities.grouping_change_preview('location')
    assert [(m['site'], m['from'], m['to']) for m in preview['moves']] == [('campus', 'west', '')]
    orphans = {o['facility']: o for o in preview['orphans']}
    assert orphans['west']['already'] is False
    assert orphans['west']['suggested'] == 'bldg-a'
    assert {c['slug'] for c in preview['choices']} == {'bldg-a'}


def test_rename_location_facility_moves_blobs_and_settings(workdir):
    _set_grouping('location')
    _blob('annotations', 'bldg-a', {'campus/bldg-a/a-l1': {}})
    facilities.set_org_mode('bldg-a', 'site-as-campus')
    (workdir / 'bldg-a').mkdir()
    (workdir / 'bldg-a' / 'manifest.json').write_text('{}')

    assert facilities.rename_location_facility('bldg-a', 'tower-a') is True
    assert FacilityMapBlob.objects.filter(kind='annotations', facility='tower-a').exists()
    assert not FacilityMapBlob.objects.filter(kind='annotations', facility='bldg-a').exists()
    assert (workdir / 'tower-a' / 'manifest.json').is_file()
    assert facilities.org_modes() == {'tower-a': 'site-as-campus'}


def test_rename_location_facility_noop_when_nothing_stored(workdir):
    assert facilities.rename_location_facility('bldg-a', 'tower-a') is False


def test_rename_location_facility_never_clobbers_a_sibling(workdir):
    _blob('annotations', 'bldg-a', {'campus/bldg-a/a-l1': {}})
    _blob('annotations', 'bldg-b', {'campus/bldg-b/b-l1': {}})
    with pytest.raises(ValueError):
        facilities.rename_location_facility('bldg-a', 'bldg-b')
    # Nothing moved: the data stays parked for the reassignment surface.
    assert FacilityMapBlob.objects.filter(kind='annotations', facility='bldg-a').exists()


# --- request-scoped row reads (QUAL-7) ------------------------------------------------------------
#
# Both install-wide rows are read once per request and threaded, never cached: the `settings` row
# through a `previews.PluginSettings` instance, the `facility_map` row through the `fmap=` parameter
# every hot resolver takes. These pin the two properties that keeps honest — threading a value in
# costs no query, and a bulk resolution stays bounded by its distinct anchors rather than by how
# much data the facility holds.

def _query_count(fn):
    """How many queries `fn` issues. `django_assert_num_queries` asserts a fixed number; this is for
    the assertions that compare two runs instead of naming a magic count."""
    from django.db import connection
    from django.test.utils import CaptureQueriesContext
    with CaptureQueriesContext(connection) as ctx:
        fn()
    return len(ctx)


def test_org_mode_reads_the_settings_row_once(django_assert_num_queries):
    # Both settings it consults (`facility_grouping` and `facility_org_modes`) live in the same row,
    # so one `PluginSettings` serves both reads — two queries collapsed to one.
    with django_assert_num_queries(1):
        assert facilities.org_mode('west') == 'site-as-building'


def test_threading_the_assignment_map_costs_no_query(django_assert_num_queries):
    west = _sitegroup('west')
    site = _site('a', group=west)
    facilities.assign_facilities({'a': 'pinned'})
    fmap = facilities.facility_map()
    with django_assert_num_queries(0):
        assert facilities.facility_for_site(site, group='sitegroup', fmap=fmap) == 'pinned'
    # …and without it, the same call re-reads the row.
    with django_assert_num_queries(1):
        assert facilities.facility_for_site(site, group='sitegroup') == 'pinned'


def test_an_empty_assignment_map_threads_as_supplied(django_assert_num_queries):
    """`{}` is a real map — an install that has never assigned a Site — not "nothing was passed".
    Threading it must skip the read, or the un-assigned install the threading exists to keep cheap
    would re-query at every hop (`_assignments` tests `is None`, never truthiness)."""
    site = _site('a')   # ungrouped: the derivation answers '' off the null FK, without a query
    with django_assert_num_queries(0):
        assert facilities.facility_for_site(site, group='sitegroup', fmap={}) == ''


def test_suggested_target_is_bounded_by_anchors_not_floor_count():
    """The N+1 this refactor removes: `suggested_target` used to resolve every floor-key row
    separately, each re-reading the assignment map and re-querying the key's Site. Its answer
    depends only on a key's first two segments, so the keys collapse to their distinct anchors —
    a facility with 40 drawn floors under one Site costs exactly what 2 floors cost."""
    west = _sitegroup('west')
    _site('a', group=west)

    _blob('annotations', '', {'a/f%d' % i: {} for i in range(2)})
    small = _query_count(lambda: facilities.suggested_target(''))
    assert facilities.suggested_target('') == 'west'

    FacilityMapBlob.objects.filter(kind='annotations', facility='').delete()
    _blob('annotations', '', {'a/f%d' % i: {} for i in range(40)})
    large = _query_count(lambda: facilities.suggested_target(''))

    assert facilities.suggested_target('') == 'west'      # same answer…
    assert large == small                                 # …at the same cost


def test_suggested_target_still_distinguishes_anchors_after_collapsing():
    """Collapsing keys to their `(site, building)` prefixes must not merge keys that resolve
    differently — the ambiguity guard has to survive the optimisation."""
    a_grp, b_grp = _sitegroup('ga'), _sitegroup('gb')
    _site('sa', group=a_grp)
    _site('sb', group=b_grp)
    # Many floors per site, two sites: still ambiguous, exactly as one floor each would be.
    _blob('annotations', '', {'sa/f%d' % i: {} for i in range(5)})
    _blob('annotations', '', {'sb/f%d' % i: {} for i in range(5)})
    assert facilities.suggested_target('') == ''


@pytest.mark.parametrize('kind', ['settings', 'facility_map'])
def test_save_install_blob_snapshots_before_overwriting(kind):
    """AUDIT-1 survives the `_save_settings`/`_save_facility_map` unification: an overwrite still
    snapshots the row **before** replacing its data, which is what makes the write produce a
    before/after `ObjectChange` diff rather than a bare "changed". Asserted on the snapshot the
    helper takes rather than on an emitted `ObjectChange`, because NetBox only materialises the
    latter inside a request's changelog context — the endpoint tests cover that half."""
    row = FacilityMapBlob.objects.create(kind=kind, facility='', key='', data={'a': 1})
    saved = facilities._save_install_blob(kind, row, {'a': 2})
    assert saved._prechange_snapshot['data'] == {'a': 1}
    assert saved.data == {'a': 2}
    saved.refresh_from_db()
    assert saved.data == {'a': 2}


@pytest.mark.parametrize('kind', ['settings', 'facility_map'])
def test_save_install_blob_creates_at_the_full_install_wide_key(kind):
    """First write creates rather than snapshotting, and addresses the row by its **full**
    install-wide key (MULTI-1) — a loose `kind` match would collide with the per-facility rows."""
    created = facilities._save_install_blob(kind, None, {'a': 1})
    assert (created.kind, created.facility, created.key) == (kind, '', '')
    assert FacilityMapBlob.objects.filter(kind=kind, facility='', key='').count() == 1
