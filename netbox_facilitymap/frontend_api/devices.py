"""Racks and devices — the placement panel's reads, the empty-panel diagnostic, and the
Add-device tool's name suggestion + Device create (DEV-3 / DEV-5, generalized into
device-type presets by DEV-8).

The reads (`NbRacksView`/`NbDevicesView`/`NbPlacementNearbyView`/`NbDeviceRolesView`/
`NbDeviceTypesView`) are ordinary object-permission-scoped queries. The two write-path
endpoints are not: they are the plugin's **second** write into `dcim` core and the name
suggestion that only makes sense to a caller who could use it, so both run
`_device_write_gate` — the device-tool switch, install-wide write mode, and
`dcim.add_device` — then resolve the client's **preset key** against the stored presets
(`_resolve_preset`) before touching anything.
"""

import re

from django.contrib.auth.mixins import LoginRequiredMixin
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Q
from django.http import HttpResponseBadRequest, HttpResponseForbidden, JsonResponse
from django.urls import reverse
from django.views import View

from dcim.models import Device, DeviceRole, DeviceType, Location, Rack

from ..previews import PluginSettings, expand_device_name_template
from .common import NB_LIST_CAP, _parse_json_body
from .serializers import _trim_device, _trim_rack


class NbRacksView(LoginRequiredMixin, View):
    """Racks directly in a Location (the room). ORM equivalent of `NetBoxProxy.racks`."""

    def get(self, request):
        loc = request.GET.get('location', '')
        if not loc:
            return JsonResponse({'racks': []})
        qs = Rack.objects.restrict(request.user, 'view').filter(location_id=loc)
        return JsonResponse({'racks': [_trim_rack(x, request) for x in qs]})


class NbDevicesView(LoginRequiredMixin, View):
    """Devices assigned to a Location but not mounted in any rack (racked devices are
    shown under their rack). ORM equivalent of `NetBoxProxy.unracked_devices`."""

    def get(self, request):
        loc = request.GET.get('location', '')
        if not loc:
            return JsonResponse({'devices': []})
        # `_trim_device` reads the role (glyph keywords + marker colour) and the device type off
        # every row, so pull both in the list query rather than two follow-ups per device.
        qs = Device.objects.restrict(request.user, 'view').select_related(
            'role', 'device_type').filter(location_id=loc, rack__isnull=True)
        return JsonResponse({'devices': [_trim_device(x, request) for x in qs]})


class NbPlacementNearbyView(LoginRequiredMixin, View):
    """Diagnostic gear counts for the room's *nearby* Locations (PLACE-2): when a room's Location
    has no directly-assigned, placeable gear, the placement panel is a dead end — the user can't
    tell whether gear is genuinely absent or just modeled one level up (the floor/building Location
    or the Site). This read-only endpoint answers "where does the gear actually live?" so the panel
    can say "N racks / M devices are assigned to <parent Location / Site> — reassign them to this
    room's Location" with a link into the matching NetBox list.

    **Diagnosis, not auto-broadening.** It only *counts*; it never widens `NbRacksView`/
    `NbDevicesView`'s exact-Location placement query. Gear on a whole-building Location does not
    belong to one room, so dropping it into a room would be wrong — the answer is for a human to
    reassign it in NetBox.

    Scopes, nearest-first: each ancestor Location (`get_ancestors`), then the Site last. Site-level
    counts exclude anything already attributed to an ancestor Location (`location__isnull=True`), so
    a rack on the floor Location is reported once, under the floor — not doubled at the Site. A scope
    with no gear is omitted, so an empty `nearby` means the room truly has nothing nearby to reassign.
    Object-permission-scoped read like its `NbRacksView`/`NbDevicesView` siblings — no write perm."""

    def get(self, request):
        loc = request.GET.get('location', '')
        if not loc:
            return JsonResponse({'nearby': []})
        room = Location.objects.restrict(request.user, 'view').filter(pk=loc).first()
        if room is None:
            return JsonResponse({'nearby': []})

        racks = Rack.objects.restrict(request.user, 'view')
        devices = Device.objects.restrict(request.user, 'view').filter(rack__isnull=True)
        rack_list = request.build_absolute_uri(reverse('dcim:rack_list'))
        device_list = request.build_absolute_uri(reverse('dcim:device_list'))

        def scope(kind, name, rack_qs, device_qs, param, obj_id):
            nr, nd = rack_qs.count(), device_qs.count()
            if not nr and not nd:
                return None
            q = '?%s=%d' % (param, obj_id)
            return {
                'kind': kind, 'name': name, 'racks': nr, 'devices': nd,
                'racks_url': rack_list + q if nr else None,
                'devices_url': device_list + q if nd else None,
            }

        nearby = []
        # Nearest ancestor first (the room's floor, then building, …); the Site is broadest, so last.
        for anc in room.get_ancestors(ascending=True).restrict(request.user, 'view'):
            s = scope('location', anc.name,
                      racks.filter(location_id=anc.pk),
                      devices.filter(location_id=anc.pk),
                      'location_id', anc.pk)
            if s:
                nearby.append(s)
        site = room.site
        if site is not None:
            s = scope('site', site.name,
                      racks.filter(site_id=site.pk, location__isnull=True),
                      devices.filter(site_id=site.pk, location__isnull=True),
                      'site_id', site.pk)
            if s:
                nearby.append(s)
        return JsonResponse({'nearby': nearby})


class NbDeviceRolesView(LoginRequiredMixin, View):
    """Free-text `dcim.DeviceRole` search, backing the Settings page's access-point role picker
    (DEV-3). An ordinary object-permission-scoped read like its `NbRacksView`/`NbDevicesView`
    siblings, capped at 200 — a plain `<select>` can't carry a role list of realistic size, so the
    picker is a searchable combobox (`Combo`) that re-queries as you type.

    Facility-agnostic: device roles are global in NetBox (they hang off no Site), and the setting
    they configure is itself install-wide — so unlike `NbSitesView` there is nothing to scope to a
    `?facility=`."""

    def get(self, request):
        q = request.GET.get('q', '')
        qs = DeviceRole.objects.restrict(request.user, 'view').all()
        if q:
            qs = qs.filter(name__icontains=q)
        return JsonResponse({'roles': [{'id': r.pk, 'name': r.name, 'slug': r.slug}
                                       for r in qs[:NB_LIST_CAP]]})


class NbDeviceTypesView(LoginRequiredMixin, View):
    """Free-text `dcim.DeviceType` search, backing the AP tool's model picker (DEV-5). An ordinary
    object-permission-scoped read like its `NbDeviceRolesView`/`NbRacksView` siblings, capped at 200
    — the searchable combobox re-queries as you type, so a realistic catalogue never has to fit in
    one payload. Searches the model name and its manufacturer's, since operators think in both
    ("Meraki" as readily as "MR46").

    Facility-agnostic for the same reason as `NbDeviceRolesView`: device types are global in NetBox,
    hanging off no Site."""

    def get(self, request):
        q = request.GET.get('q', '')
        qs = DeviceType.objects.restrict(request.user, 'view').select_related('manufacturer')
        if q:
            qs = qs.filter(Q(model__icontains=q) | Q(manufacturer__name__icontains=q))
        return JsonResponse({'device_types': [
            {'id': t.pk, 'model': t.model, 'manufacturer': t.manufacturer.name} for t in qs[:NB_LIST_CAP]]})


def _device_write_gate(request):
    """The gate every Add-device **write-path** endpoint runs before it touches anything, returned
    as an error response (or `None` to proceed). Shared so the two endpoints can't drift apart —
    the Device-create path is the plugin's second write into `dcim` core (§10) and the suggest-name
    path is only meaningful to a caller who could use the name, so both answer to the same three
    gates:

      * the **device-placement tool** must be switched on (DEV-3's install-wide feature switch,
        the `device_tool` key — falling back to the legacy `ap_tool`, DEV-8);
      * install-wide **write mode** must be on (LOC-2) — the tool switch is orthogonal to it;
      * the user must hold `dcim.add_device` (the NetBox auth backend, not a login check).

    Returns the `PluginSettings` instance alongside, since every caller then resolves the request's
    preset off it (`_resolve_preset`) — both gates and the presets come off **one** instance, so
    this is a single settings-blob query, not one per gate.

    Gating the *read* half this way is deliberately stricter than a plain `.restrict(user,'view')`
    listing: suggesting a name to someone who cannot create the device is pointless, it mirrors the
    frontend's own tool gating exactly (`window.MAP.deviceTool`/`writeMode`/`canCreateDevice`), and
    it keeps the unrestricted role read behind `{role_short}` (below) in front of callers who are
    already cleared to create devices."""
    settings = PluginSettings()
    if not settings.device_tool:
        return HttpResponseForbidden('the device-placement tool is not enabled'), settings
    if not settings.write_mode:
        return HttpResponseForbidden('write mode is not enabled'), settings
    if not request.user.has_perm('dcim.add_device'):
        return HttpResponseForbidden('permission denied'), settings
    return None, settings


def _resolve_preset(settings, key):
    """The **enabled** stored preset for a client-sent key, or `None`. The preset is the write
    contract's server half (DEV-8): the client names a key, and the role, name template, counter
    scope, and promptable fields all come from what the operator stored under it — never from the
    request. A disabled or unknown key resolves to nothing, so a stale toolbar can't create
    through a preset the operator has since switched off."""
    for preset in settings.device_presets:
        if preset['key'] == key and preset['enabled']:
            return preset
    return None


def _role_short(role):
    """The `{role_short}` expansion for a `dcim.DeviceRole`: its slug's word initials, uppercased —
    `access-point` → `AP`, `wireless-access-point` → `WAP`. A **single-word** slug is used whole
    (`ap` → `AP`), never initialled: an operator whose role is plain "AP" means `AP`, and `A` would
    be a baffling name for every access point in the facility."""
    words = [w for w in re.split(r'[-_\s]+', role.slug) if w]
    if len(words) == 1:
        return words[0].upper()
    return ''.join(w[0] for w in words).upper()


def _device_count_qs(room, scope):
    """The `dcim.Device` queryset the suggested name's `-NN` counter counts, per the preset's
    `count_scope` (DEV-3). `room` is the room Location:

      * `room`     — devices in this room only, so the counter restarts in each room;
      * `floor`    — the room's parent floor Location and everything under it (`get_descendants`),
        so the counter climbs across the floor's rooms;
      * `building` — the **building anchor** and everything under it, so the counter restarts in
        each building. Under Site = campus the anchor is the room's floor's parent Location (the
        building Location); for a Site-anchored install there is no building Location, so it
        degenerates to the whole `dcim.Site` — identical to the `site` scope there (MODEL-3,
        BUILDING-ANCHOR-DESIGN §4.3);
      * `site`     — the whole `dcim.Site`: one building for a Site-anchored install, the whole
        campus for a Site = campus install. Deliberately NOT facility-wide.

    Caller filters by role. `none` never reaches here (no counter at all)."""
    if scope == 'room':
        return Device.objects.filter(location=room)
    if scope == 'floor':
        floor = room.parent or room
        return Device.objects.filter(location__in=floor.get_descendants(include_self=True))
    if scope == 'building':
        # The building anchor is the floor's parent Location (Site = campus); absent it (Site
        # anchor — floors sit at the Site root), the building *is* the Site, so fall through.
        floor = room.parent or room
        building = floor.parent
        if building is not None:
            return Device.objects.filter(
                location__in=building.get_descendants(include_self=True))
    return Device.objects.filter(site=room.site)


class NbDeviceSuggestNameView(LoginRequiredMixin, View):
    """GET `api/netbox/devices/suggest-name?location=<roomLocId>&preset=<key>[&asset_tag=<tag>]`
    → `{name}`: the name the Add-device tool pre-fills when a device is dropped in a room (DEV-5,
    per-preset since DEV-8).

    Server-side rather than in the browser because both halves live here anyway — the template and
    counter scope are on the stored preset, and the count is an ORM question. Expands the preset's
    `name_template` via `previews.expand_device_name_template` (`{room}` → the room Location's
    name, `{room_slug}` → that same Location's native `slug`, `{role_short}` → `_role_short` of
    the preset's role, `{asset_tag}` → the optional param), then appends a zero-padded `-NN`
    unless the preset's `count_scope` is `none`.

    `asset_tag` is a **param** rather than something derived here because it is the one placeholder
    the room can't answer: the user types it into the create dialog *after* this endpoint has
    already been asked once, so the browser re-asks (debounced) as that field changes (DEV-6).
    Expanding it here rather than letting the browser patch it into the response is what keeps the
    counter and the probe below honest — both must run against the name that will actually be
    saved, not one with a placeholder still in it. It is a naming input only: `NbDeviceCreateView`
    remains the sole validator of the tag itself (including the blank → NULL rule).

    **The count and the free-name probe run unrestricted** (no `.restrict(user,'view')`), which is a
    deliberate exception to this module's read posture, not an oversight. A restricted count would
    silently *undercount* — skipping the devices this user can't see — and hand back a suggestion
    that then collides on save, turning a permission boundary into a mystery 400 on a name the
    server itself proposed. It leaks only an integer (how many same-role devices exist in a scope)
    to a caller who already holds `dcim.add_device`.

    Two scopes are in play at once and they are **not** the same scope, which is the subtle part:
    the *counter* spans the preset's `count_scope`, but the *free-name probe* must span the
    **site**, because that is the domain `dcim.Device`'s uniqueness constraint actually covers
    (`Lower(name)` + `site`, case-insensitively). So a `room`- or `building`-scoped counter still
    bumps past a clash elsewhere in the same Site — otherwise the suggestion 400s the moment the
    counter's scope is narrower than the constraint's. The bump also steps over gaps a deletion
    left behind, so a freed name isn't handed out only to fail some other check."""

    def get(self, request):
        gate, settings = _device_write_gate(request)
        if gate is not None:
            return gate
        preset = _resolve_preset(settings, request.GET.get('preset'))
        if preset is None:
            return HttpResponseBadRequest('no such device preset')
        room = Location.objects.restrict(request.user, 'view').filter(
            pk=request.GET.get('location')).first()
        if room is None:
            return HttpResponseBadRequest('room Location not found')
        # Read unrestricted: the role is server-set policy, not this user's choice, so a user who
        # may add devices but not view roles still gets the configured name (see the class docstring
        # on why the tool's gate, not a role read, is the boundary here).
        role = (DeviceRole.objects.filter(pk=preset['device_role']).first()
                if preset['device_role'] else None)
        if role is None:
            return HttpResponseBadRequest('the preset has no device role configured')
        base = expand_device_name_template(
            preset['name_template'], room.name, room.slug, _role_short(role),
            request.GET.get('asset_tag', ''))
        if preset['count_scope'] == 'none':
            return JsonResponse({'name': base})
        n = _device_count_qs(room, preset['count_scope']).filter(role=role).count() + 1
        taken = Device.objects.filter(site=room.site)
        while taken.filter(name__iexact='%s-%02d' % (base, n)).exists():
            n += 1
        return JsonResponse({'name': '%s-%02d' % (base, n)})


class NbDeviceCreateView(LoginRequiredMixin, View):
    """POST `api/netbox/devices/create`: create an unracked `dcim.Device` in a room through a
    device-type preset, so a permitted user can place a device on the floor plan without leaving
    the map (DEV-5, generalized by DEV-8).

    This is the plugin's **second** (and only other) write into `dcim` core, alongside
    `NbLocationCreateView` (LOC-1/LOC-2). Both follow one gate shape, and this one adds nothing
    weaker: the install-wide switches plus the per-user `dcim.add_device` permission (all in
    `_device_write_gate`), then — because the model-level `has_perm` above cannot see object-level
    constraints — a **post-save** `restrict(user,'add')` re-check inside `transaction.atomic()`,
    rolled back when it fails. That re-check must run on a **saved pk**: an object-level `has_perm`
    on an unsaved instance filters on `pk=None` and always fails.

    Body is `{preset, location, device_type, name, ...}`. What the client does **not** get to send
    is as much of the contract as what it does:

      * the **role** is read from the stored preset server-side and never accepted from the body —
        an operator's role choice is policy, and honouring a client-supplied role would let any
        `dcim.add_device` holder mint a device of an arbitrary role through a tool that
        advertises specific kinds;
      * only the **preset's prompted fields** are read at all: of the fixed allowlist
        (`previews.DEVICE_PRESET_FIELDS`), a field the preset doesn't prompt for is simply never
        read off the payload — the same ignore-unknown-keys idiom the body parser already has —
        so the dialog's field selection is server-enforced, not a UI courtesy;
      * `rack` is always null (a placed device hangs in the room, not in a rack) and `site` is
        taken from the room Location, so neither can be pointed elsewhere;
      * `status`, when the preset doesn't prompt for it, falls to the model's own `active`
        default; when it does, `full_clean()` validates the sent choice.

    An empty `asset_tag` is stored as **None**, not `''`: the column is globally unique *and*
    nullable, so a second blank-tagged device would collide with the first on `''` — a 400 that
    would look like a bug in the map rather than in the payload. A duplicate name or asset tag
    otherwise surfaces as a clean 400 from `full_clean()`, mirroring `NbLocationCreateView`."""

    def post(self, request):
        gate, settings = _device_write_gate(request)
        if gate is not None:
            return gate
        payload, error = _parse_json_body(request)
        if error:
            return error
        preset = _resolve_preset(settings, payload.get('preset'))
        if preset is None:
            return HttpResponseBadRequest('no such device preset')
        # Unconfigured (or since-deleted) role is a 400, not a 500 on a null FK: the preset is
        # stored but not finished being set up, which is an operator's answer to give.
        role = (DeviceRole.objects.filter(pk=preset['device_role']).first()
                if preset['device_role'] else None)
        if role is None:
            return HttpResponseBadRequest('the preset has no device role configured')
        # The room must be one the user may see; a bad/hidden id is a 400, never a silent create
        # somewhere else in the tree (mirrors NbLocationCreateView's parent resolution).
        room = Location.objects.restrict(request.user, 'view').filter(
            pk=payload.get('location')).first()
        if room is None:
            return HttpResponseBadRequest('room Location not found')
        dtype = DeviceType.objects.restrict(request.user, 'view').filter(
            pk=payload.get('device_type')).first()
        if dtype is None:
            return HttpResponseBadRequest('device type not found')
        name = (payload.get('name') or '').strip()
        if not name:
            return HttpResponseBadRequest('a device name is required')
        fields = preset['fields']
        device = Device(name=name, device_type=dtype, role=role, site=room.site, location=room,
                        rack=None)
        if 'asset_tag' in fields:
            device.asset_tag = (payload.get('asset_tag') or '').strip() or None
        if 'serial' in fields:
            device.serial = (payload.get('serial') or '').strip()
        if 'description' in fields:
            device.description = (payload.get('description') or '').strip()
        if 'status' in fields and payload.get('status'):
            device.status = payload['status']
        denied = False
        try:
            with transaction.atomic():
                device.full_clean()
                device.save()
                if not Device.objects.restrict(request.user, 'add').filter(pk=device.pk).exists():
                    denied = True
                    transaction.set_rollback(True)
        except ValidationError as e:
            return JsonResponse({'ok': False, 'error': '; '.join(e.messages)}, status=400)
        if denied:
            return HttpResponseForbidden('permission denied')
        return JsonResponse(_trim_device(device, request), status=201)
