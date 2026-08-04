"""Auto-remap slug-keyed floor bindings when a Site or Location is renamed (HEALTH-4).

The map freezes NetBox slugs into four stores at import time: a `Room.floor_key` and the rendered
manifest/disk keys are `"<site.slug>/<floor.slug>"` (2-segment, Site-anchored) or
`"<site.slug>/<building.slug>/<floor.slug>"` (3-segment, Location-anchored — MODEL-3). Rename the
Site or a floor/building Location in NetBox and its slug moves, but those frozen keys do not, so a
floor stops resolving — and an **empty** floor (a rendered plan with no `Room` row to carry the
rename-proof `Room.floor_location` FK, BIND-1) goes blank until re-import.

This module closes that gap **at the source**. A `pre_save`/`post_save` pair on `dcim.Site` and
`dcim.Location` detects a slug change and re-keys, together, every store that froze the old slug:

  1. `Room.floor_key` (the DB rows),
  2. the facility's `manifest.json` (building `dir`/`siteSlug`, floor `id`/`floorSlug`, and — only for
     a directory-segment rename — the image path prefixes),
  3. the wizard's `import-map.json` (a building's `slug`/`buildingSlug`, or a floor `token`),
  4. the on-disk `images/<…>` directory (a Site or building rename moves the folder; a floor rename
     needs no filesystem move — the manifest keeps an explicit `image` path, so leaving the files
     put still serves them, and the next rebuild regenerates canonical filenames).

The DB re-key runs first in a transaction, then the manifest/import-map rewrite, then the directory
move (mirroring `facilities.reassign_facility`'s DB-then-disk order): a mid-remap crash leaves the
authoritative DB consistent and the op safely re-runnable, with `health.run_checks` as the backstop.

**This overturns the previously deliberate stance that a rename-broken binding should surface
loudly rather than be silently prevented** — but only for renames that flow through `save()`.

*Which* renames flow through `save()` is worth stating precisely, because it is broader than it
looks: every first-party NetBox 4.x write path saves per object, so all of them fire these
receivers — bulk edit and bulk rename (`generic/bulk_views.py`, `obj.full_clean(); obj.save()` in a
loop), CSV/bulk import (`BulkImportView.save_object` → `object_form.save()`), and the REST API's
bulk `PUT`/`PATCH` (`api/viewsets/mixins.py`, `perform_update` per object). No shipped NetBox path
re-slugs a Site or Location through `QuerySet.update()`/`bulk_update`, so the ordinary
manage-DCIM-by-CSV workflow is covered, not stranded (HEALTH-11).

What genuinely bypasses these receivers is anything that writes the column without a `save()`:
a user-authored NetBox **script**/plugin calling `QuerySet.update()`/`bulk_update`, a data
migration, or direct SQL — plus, of course, any rename that predates HEALTH-4. That residue is why
`resolve_floor_location`/`health._check_floor_keys` stay as the backstop and why HEALTH-5 (a
user-facing "why is this blank" fallback) is chained after this item rather than replaced by it.
"""

import copy
import functools
import json
import logging
import time

from django.db import transaction
from django.db.models import Value
from django.db.models.functions import Concat, Substr
from django.db.models.signals import post_save, pre_save

from netbox.plugins import get_plugin_config

from dcim.models import Location, Site

from . import storage
from .facilities import (
    facility_for_location, grouping, rename_location_facility, rename_site_assignment,
    site_facilities,
)
from .models import Room, parse_floor_key

logger = logging.getLogger(__name__)

#: instance attribute the pre_save receiver stashes the pre-save slug on, read back in post_save.
_OLD_SLUG_ATTR = '_facilitymap_old_slug'


class SlugRenameRemapper:
    """Re-keys the four slug-frozen stores of one facility after a Site/floor/building slug change.

    One instance per rename, bound to one facility the renamed object resolves to
    (`facility_for_location` / `site_facilities` — a Site rename fans out to one instance per
    hosted facility under the `location` grouping, MODEL-8). The three public `dispatch_*` entry
    points pick the rename kind by the
    object's structural role; each store operation is an idempotent no-op when nothing matches, so a
    rename of an unrelated object (a region, a room Location, an un-imported Site) touches nothing.
    """

    def __init__(self, facility):
        self.facility = facility

    # -- entry points -----------------------------------------------------------------------------

    def dispatch_site(self, old_slug, new_slug):
        """A Site slug changed — segment 0 of every one of its floors' keys shifts."""
        if self._build_in_progress():
            self._warn_busy('Site', old_slug, new_slug)
            return
        self._remap_dir_segment(
            old_prefix='%s/' % old_slug, new_prefix='%s/' % new_slug,
            mutate_manifest=lambda m: self._manifest_site(m, old_slug, new_slug),
            mutate_map=lambda im: self._map_site(im, old_slug, new_slug),
            old_img_rel=old_slug, new_img_rel=new_slug,
            label='Site %s -> %s' % (old_slug, new_slug))

    def dispatch_location(self, site_slug, parent_slug, old_slug, new_slug):
        """A Location slug changed. It may be a **floor** (its `<site>/[building/]<slug>` names a
        floor key) or a **building** (the parent segment of 3-segment floor keys). Try floor first —
        each attempt no-ops unless it matches a real store — and fall through to building."""
        if self._build_in_progress():
            self._warn_busy('Location', old_slug, new_slug)
            return
        old_key = self._floor_key(site_slug, parent_slug, old_slug)
        new_key = self._floor_key(site_slug, parent_slug, new_slug)
        if self._remap_floor(old_key, new_key):
            return
        self._remap_building(site_slug, old_slug, new_slug)

    # -- rename kinds -----------------------------------------------------------------------------

    def _remap_floor(self, old_key, new_key):
        """Re-key a single floor: the exact `Room.floor_key`, the manifest floor `id`/`floorSlug`, and
        the import-map token. No filesystem move — a floor's image files are addressed by an explicit
        manifest path, not reconstructed from its id, so leaving them put keeps them served."""
        with transaction.atomic():
            rooms = Room.objects.filter(floor_key=old_key).update(floor_key=new_key)
        manifest = self._rewrite_manifest(lambda m: self._manifest_floor(m, old_key, new_key))
        imap = self._rewrite_import_map(lambda im: self._map_floor(im, old_key, new_key))
        changed = bool(rooms or manifest or imap)
        if changed:
            logger.info('facilitymap: remapped floor rename %s -> %s (%d room(s))',
                        old_key, new_key, rooms)
        return changed

    def _remap_building(self, site_slug, old_slug, new_slug):
        """Re-key a building anchor (the middle segment of 3-segment floor keys): every affected
        `Room.floor_key`, the manifest building `dir` + image prefixes, the import-map `buildingSlug`,
        and the on-disk `images/<site>/<building>` directory."""
        old_rel, new_rel = '%s/%s' % (site_slug, old_slug), '%s/%s' % (site_slug, new_slug)
        self._remap_dir_segment(
            old_prefix='%s/' % old_rel, new_prefix='%s/' % new_rel,
            mutate_manifest=lambda m: self._manifest_building(m, site_slug, old_slug, new_slug),
            mutate_map=lambda im: self._map_building(im, site_slug, old_slug, new_slug),
            old_img_rel=old_rel, new_img_rel=new_rel,
            label='building %s -> %s' % (old_rel, new_rel))

    def _remap_dir_segment(self, *, old_prefix, new_prefix, mutate_manifest, mutate_map,
                           old_img_rel, new_img_rel, label):
        """Shared body for the two directory-segment renames (Site, building): swap a `floor_key`
        prefix on every matching `Room`, rewrite the manifest + import-map, then move the image
        directory. `old_prefix`/`new_prefix` end in ``/`` so only whole segments match."""
        with transaction.atomic():
            rooms = (Room.objects.filter(floor_key__startswith=old_prefix)
                     .update(floor_key=Concat(Value(new_prefix),
                                               Substr('floor_key', len(old_prefix) + 1))))
        manifest = self._rewrite_manifest(mutate_manifest)
        imap = self._rewrite_import_map(mutate_map)
        if rooms or manifest or imap:
            try:
                storage.rename_image_subdir(self.facility, old_img_rel, new_img_rel)
            except ValueError as exc:
                logger.warning('facilitymap: could not move images %s -> %s: %s',
                               old_img_rel, new_img_rel, exc)
            logger.info('facilitymap: remapped %s (%d room(s))', label, rooms)

    # -- store mutators (pure dict edits; return True when they changed anything) ------------------

    def _manifest_site(self, manifest, old_slug, new_slug):
        old_img, new_img = 'images/%s/' % old_slug, 'images/%s/' % new_slug
        changed = False
        for building in manifest.get('buildings', []):
            if building.get('siteSlug') != old_slug:
                continue
            building['siteSlug'] = new_slug
            if building.get('dir'):
                building['dir'] = self._swap_first_segment(building['dir'], new_slug)
            self._rewrite_floor_images(building, old_img, new_img)
            changed = True
        return changed

    def _manifest_building(self, manifest, site_slug, old_slug, new_slug):
        old_dir, new_dir = '%s/%s' % (site_slug, old_slug), '%s/%s' % (site_slug, new_slug)
        old_img, new_img = 'images/%s/' % old_dir, 'images/%s/' % new_dir
        changed = False
        for building in manifest.get('buildings', []):
            if building.get('dir') != old_dir:
                continue
            building['dir'] = new_dir  # `siteSlug` stays the pure campus slug — only `dir` moves
            self._rewrite_floor_images(building, old_img, new_img)
            changed = True
        return changed

    def _manifest_floor(self, manifest, old_key, new_key):
        target_dir = old_key.rsplit('/', 1)[0]      # the building `dir` this floor lives under
        _, _, old_slug = parse_floor_key(old_key)
        _, _, new_slug = parse_floor_key(new_key)
        changed = False
        for building in manifest.get('buildings', []):
            if building.get('dir') != target_dir:
                continue
            for floor in building.get('floors', []):
                if floor.get('id') == old_slug:
                    floor['id'] = new_slug
                    floor['floorSlug'] = new_slug     # image paths untouched (see `_remap_floor`)
                    changed = True
        return changed

    def _map_site(self, imap, old_slug, new_slug):
        changed = False
        for entry in (imap.get('buildings') or {}).values():
            if entry.get('slug') == old_slug:
                entry['slug'] = new_slug
                changed = True
        return changed

    def _map_building(self, imap, site_slug, old_slug, new_slug):
        changed = False
        for entry in (imap.get('buildings') or {}).values():
            if entry.get('slug') == site_slug and entry.get('buildingSlug') == old_slug:
                entry['buildingSlug'] = new_slug
                changed = True
        return changed

    def _map_floor(self, imap, old_key, new_key):
        site_slug, building_slug, old_slug = parse_floor_key(old_key)
        _, _, new_slug = parse_floor_key(new_key)
        changed = False
        for entry in (imap.get('buildings') or {}).values():
            if entry.get('slug') != site_slug or (entry.get('buildingSlug') or '') != building_slug:
                continue
            # A floor token is a bare string (whole-page floor) or a list of `{token, region}`
            # (region-split page, FLOOR-2) — re-key both shapes.
            for stem, spec in (entry.get('floors') or {}).items():
                if isinstance(spec, str):
                    if spec == old_slug:
                        entry['floors'][stem] = new_slug
                        changed = True
                elif isinstance(spec, list):
                    for item in spec:
                        if isinstance(item, dict) and item.get('token') == old_slug:
                            item['token'] = new_slug
                            changed = True
        return changed

    # -- helpers ----------------------------------------------------------------------------------

    @staticmethod
    def _floor_key(site_slug, parent_slug, floor_slug):
        """The `floor_key` a floor Location names: 3-segment when it hangs under a building Location
        (`parent_slug` set), 2-segment when it is a Site's top-level floor (`parent_slug` None)."""
        if parent_slug:
            return '%s/%s/%s' % (site_slug, parent_slug, floor_slug)
        return '%s/%s' % (site_slug, floor_slug)

    @staticmethod
    def _swap_first_segment(path, new_first):
        rest = path.split('/', 1)
        return '%s/%s' % (new_first, rest[1]) if len(rest) > 1 else new_first

    @staticmethod
    def _rewrite_floor_images(building, old_prefix, new_prefix):
        """Swap the `images/<dir>/` prefix on every floor image/thumb path in `building`."""
        def swap(path):
            if isinstance(path, str) and path.startswith(old_prefix):
                return new_prefix + path[len(old_prefix):]
            return path
        for floor in building.get('floors', []):
            if floor.get('image'):
                floor['image'] = swap(floor['image'])
            if floor.get('thumb'):
                floor['thumb'] = swap(floor['thumb'])
            for page in floor.get('pages', []):
                if page.get('image'):
                    page['image'] = swap(page['image'])

    def _rewrite_manifest(self, mutate):
        """Load the facility manifest, apply `mutate` to a deep copy (the shared `read_manifest` memo
        is read-only), and write it back atomically only if `mutate` reports a change."""
        manifest = storage.read_manifest(self.facility)
        if manifest is None:
            return False
        data = copy.deepcopy(manifest)
        if not mutate(data):
            return False
        storage.write_manifest(self.facility, data)
        return True

    def _rewrite_import_map(self, mutate):
        """Same shape as `_rewrite_manifest` for the wizard's `import-map.json` (absent on an install
        that imported before the file was retained — a normal state, so a missing file is a no-op)."""
        path = storage.safe_path('import-map.json', self.facility)
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return False
        if not mutate(data):
            return False
        path.write_text(json.dumps(data), encoding='utf-8')
        return True

    def _build_in_progress(self):
        """True when this facility holds a fresh render lock — a rebuild is regenerating the
        manifest/images right now, so a remap would fight it. Skip and let health be the backstop."""
        from .render_runner import RenderRunner  # deferred: only touched on an actual rename
        lock = storage.work_dir(self.facility) / RenderRunner.LOCK_NAME
        try:
            age = time.time() - lock.stat().st_mtime
        except OSError:
            return False
        return age <= get_plugin_config('netbox_facilitymap', 'render_timeout_s') * 2

    @staticmethod
    def _warn_busy(kind, old_slug, new_slug):
        logger.warning('facilitymap: %s rename %s -> %s during an active import — skipped; run '
                       'facilitymap_check afterward', kind, old_slug, new_slug)


# -- signal receivers ------------------------------------------------------------------------------
#
# Module-level callables because Django wires receivers to a sender at import time; each is a thin
# adapter that captures the rename and delegates the work to `SlugRenameRemapper`. `connect()` (called
# from `FacilityMapConfig.ready()`) is idempotent via `dispatch_uid`.


def _capture_old_slug(sender, instance, **kwargs):
    """pre_save: stash the committed slug so post_save can tell a rename from any other save. A create
    (no pk / no existing row) stashes None, so post_save skips it. Guarded so a failed lookup can never
    abort the user's save — it just leaves the slug uncaptured (post_save then treats it as no-rename)."""
    setattr(instance, _OLD_SLUG_ATTR, None)
    try:
        if instance.pk:
            setattr(instance, _OLD_SLUG_ATTR,
                    sender.objects.filter(pk=instance.pk).values_list('slug', flat=True).first())
    except Exception:   # noqa: BLE001 — a rename must never fail because of our bookkeeping
        logger.exception('facilitymap: could not capture old slug for %s', sender.__name__)


def _renamed_to(instance):
    """The new slug when this save was a genuine slug change, else None."""
    old = getattr(instance, _OLD_SLUG_ATTR, None)
    new = instance.slug
    return new if old and old != new else None


def _guarded(receiver):
    """Wrap a post_save receiver so nothing it does synchronously — the `facility_for_site`/site/parent
    reads before the on_commit hand-off — can bubble into and abort the user's rename `save()`."""
    @functools.wraps(receiver)
    def wrapper(*args, **kwargs):
        try:
            receiver(*args, **kwargs)
        except Exception:   # noqa: BLE001 — a rename must never fail because of our bookkeeping
            logger.exception('facilitymap: slug-rename receiver failed')
    return wrapper


def _remap_site_rename(facilities, old, new):
    """A Site rename re-keys two independent stores: the slug-frozen floor bindings of every
    facility whose manifest may name the Site (the remapper — one facility under the Site-FK
    groupings, one per hosted top-level Location under the `location` grouping, MODEL-8) and the
    install-wide Site→facility assignment map, whose keys are Site slugs
    (`facilities.rename_site_assignment`). The map re-key is collision-guarded — an existing
    assignment under the new slug is left for the operator, logged loudly like
    `rename_image_subdir`'s stance in `_remap_dir_segment`. Each facility's remap is an idempotent
    no-op when its stores never froze the old slug."""
    for facility in sorted(facilities):
        SlugRenameRemapper(facility).dispatch_site(old, new)
    try:
        if rename_site_assignment(old, new):
            logger.info('facilitymap: re-keyed facility assignment %s -> %s', old, new)
    except ValueError as exc:
        logger.warning('facilitymap: could not re-key facility assignment %s -> %s: %s',
                       old, new, exc)


def _remap_location_rename(facility, site_slug, parent_slug, old, new, facility_rename):
    """A Location rename's post-commit work. Ordinarily just the floor/building remap within the
    Location's facility. When the renamed Location is a facility itself — top-level under the
    `location` grouping (MODEL-8) — its facility *key* moves first
    (`facilities.rename_location_facility`: blobs re-keyed, working dir moved, facility-named
    settings followed), and the anchor remap then runs under the **new** key, since a root that
    directly parents floors is also those floors' anchor segment. A re-key collision (renamed onto
    a sibling facility's slug) is logged and left parked for the HEALTH-1 reassignment surface —
    never clobbered — and the anchor remap still runs under the old key so the stranded data's own
    floor keys stay internally consistent for `suggested_target`."""
    if facility_rename:
        try:
            if rename_location_facility(old, new):
                logger.info('facilitymap: re-keyed facility %s -> %s', old, new)
            facility = new
        except ValueError as exc:
            logger.warning(
                'facilitymap: could not re-key facility %s -> %s: %s — the data stays under the '
                'old key; reassign it from the Settings page', old, new, exc)
            facility = old
    SlugRenameRemapper(facility).dispatch_location(site_slug, parent_slug, old, new)


@_guarded
def _on_site_saved(sender, instance, created, **kwargs):
    if created:
        return
    new = _renamed_to(instance)
    if new is None:
        return
    old = getattr(instance, _OLD_SLUG_ATTR)
    facilities = site_facilities(instance)
    transaction.on_commit(lambda: _safely(
        lambda: _remap_site_rename(facilities, old, new)))


@_guarded
def _on_location_saved(sender, instance, created, **kwargs):
    if created:
        return
    new = _renamed_to(instance)
    if new is None:
        return
    site = instance.site
    if site is None:   # a Location always has a Site in NetBox, but never assume — no site, no key
        return
    old = getattr(instance, _OLD_SLUG_ATTR)
    # Resolved via the Location's own ancestry so the `location` grouping reaches the right
    # facility (MODEL-8); under the Site-FK groupings this is exactly the Site's facility. The
    # instance already carries the NEW slug here, which for a top-level rename in that grouping
    # *is* the new facility key — `_remap_location_rename` handles the old→new move itself.
    facility = facility_for_location(instance)
    site_slug = site.slug
    parent_slug = instance.parent.slug if instance.parent_id else None
    # A facility rename only when the facility actually *derives from* this root — an
    # assignment-pinned Site resolves to its pinned value (`facility != new`), and that key
    # doesn't move on a root rename.
    facility_rename = (instance.parent_id is None and grouping() == 'location'
                       and facility == new)
    transaction.on_commit(lambda: _safely(
        lambda: _remap_location_rename(facility, site_slug, parent_slug, old, new,
                                       facility_rename)))


def _safely(fn):
    """Run a remap so it can never abort the user's legitimate rename `save()`: any failure is logged
    loudly server-side (health.run_checks remains the backstop), not raised."""
    try:
        fn()
    except Exception:   # noqa: BLE001 — a remap must never surface into the caller's transaction
        logger.exception('facilitymap: slug-rename remap failed')


def connect():
    """Wire the receivers to `dcim.Site`/`dcim.Location`. Called once from `FacilityMapConfig.ready()`;
    `dispatch_uid` keeps it idempotent if `ready()` ever runs twice."""
    pre_save.connect(_capture_old_slug, sender=Site, dispatch_uid='facilitymap_site_pre_slug')
    post_save.connect(_on_site_saved, sender=Site, dispatch_uid='facilitymap_site_post_slug')
    pre_save.connect(_capture_old_slug, sender=Location, dispatch_uid='facilitymap_loc_pre_slug')
    post_save.connect(_on_location_saved, sender=Location, dispatch_uid='facilitymap_loc_post_slug')
