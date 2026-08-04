"""The finder's facility-wide inventory search (NAV-3) — the *unplaced* half of the siteplan
wayfinding search.

One endpoint. The finder's *placed* index is built client-side from the loaded annotation and
placement blobs (`Store.searchTargets`); this is the other half, surfacing rooms/racks/devices
that exist in NetBox but were never drawn or placed on the map.

Its result shaping (`_inv_room`/`_inv_placement`/`_inv_racked_device`) lives in `serializers.py`
with every other row shaper.
"""

from django.contrib.auth.mixins import LoginRequiredMixin
from django.db.models import Q
from django.http import HttpResponseBadRequest, JsonResponse
from django.views import View

from dcim.models import Device, Location, Rack

from ..facilities import facility_location_pks, facility_sites, grouping
from ..models import Room
from .common import _facility
from .serializers import _inv_placement, _inv_racked_device, _inv_room


class NbInventoryView(LoginRequiredMixin, View):
    """Facility-wide free-text search over NetBox rooms (child Locations), racks, and devices, for
    the siteplan wayfinding finder's *unplaced* results (NAV-3). Rooms match on the Location `name`
    **or** the printed-name synonyms on the bound `Room.alias` (NAV-18); racks/devices match on name.

    The finder's placed index is built client-side from the loaded annotation/placement blobs
    (`Store.searchTargets`); this endpoint is the other half — it surfaces rooms/racks/devices that
    exist in NetBox but were never drawn/placed on the map, so the finder can jump to their building/
    floor (or, when that floor isn't mapped, list them disabled). Search-as-you-type: the frontend
    debounces per keystroke, so each query stays bounded (a `MIN_Q` minimum + a per-kind `LIMIT`)
    rather than shipping the whole facility inventory up front — a large facility's device list is
    big.

    Facility-scoped like `NbSitesView` (FACIL-1): results are restricted to the requested
    `?facility=`'s own Sites (`facilities.facility_sites`), so one facility's finder never lists
    another's inventory; a malformed slug 400s. Login-only + object-permission scoped
    (`.restrict(user,'view')`) like the sibling `/api/netbox/*` reads. Only rooms *under a floor
    Location* (and racks/devices in such a room) are returned (`parent__isnull=False`) — a floor or
    site-root Location is not itself a finder target and has no map floor to resolve.

    Rack-mounted devices are searchable too, but in their own `racked_devices` key (NAV-19): they are
    not placeable markers, so `devices` stays *unracked*-only (mirroring `NbDevicesView`, which feeds
    the placement panel) while `racked_devices` carries the containing rack (`rack_id`/`rack_name`)
    for the finder to navigate to the rack's placement instead."""

    MIN_Q = 2
    LIMIT = 50

    def get(self, request):
        facility = _facility(request)
        if facility is None:
            return HttpResponseBadRequest('invalid facility')
        q = request.GET.get('q', '').strip()
        if len(q) < self.MIN_Q:
            return JsonResponse({'rooms': [], 'racks': [], 'devices': [], 'racked_devices': []})
        sites = facility_sites(facility, user=request.user)
        # Under the `location` grouping the campus Site is shared with sibling facilities
        # (MODEL-8), so the Site bound alone would list the whole campus — additionally narrow
        # every result to this facility's own subtree Locations. `None` = the Site-FK groupings,
        # where the Site bound *is* the facility bound and nothing extra is filtered.
        loc_pks = (facility_location_pks(facility)
                   if grouping() == 'location' and facility else None)

        def _in_facility(qs, field):
            return qs if loc_pks is None else qs.filter(**{'%s__in' % field: loc_pks})

        # A room matches on its Location `name` OR the printed-name synonyms on its bound `Room.alias`
        # (NAV-18) — so a technician searching the number on the hallway sign finds a room whose
        # NetBox Location is named differently. The alias lives on our `Room`, keyed to a room
        # Location by its FK; collect the matching Locations' ids (object-perm scoped) and widen the
        # filter. `site__in=sites` still bounds the result to this facility (FACIL-1), so an alias
        # from another facility can't leak in.
        alias_loc_ids = list(Room.objects.restrict(request.user, 'view')
                             .filter(alias__icontains=q, location__isnull=False)
                             .values_list('location_id', flat=True))
        rooms = (_in_facility(Location.objects.restrict(request.user, 'view')
                              .filter(site__in=sites, parent__isnull=False)
                              .filter(Q(name__icontains=q) | Q(pk__in=alias_loc_ids)), 'pk')
                 .select_related('site', 'parent')[:self.LIMIT])
        racks = (_in_facility(Rack.objects.restrict(request.user, 'view')
                              .filter(location__site__in=sites, location__parent__isnull=False,
                                      name__icontains=q), 'location__pk')
                 .select_related('location__site', 'location__parent')[:self.LIMIT])
        devices = (_in_facility(Device.objects.restrict(request.user, 'view')
                                .filter(location__site__in=sites, location__parent__isnull=False,
                                        rack__isnull=True, name__icontains=q), 'location__pk')
                   .select_related('location__site', 'location__parent')[:self.LIMIT])
        # A rack-mounted device is found by its own name but navigated to via its rack (NAV-19), so
        # the facility/floor scope is joined through `rack__location` — the rack's room is what sits
        # on a map floor. A device whose rack has no room Location (site-level rack) resolves to no
        # floor and is filtered out here, same as an unracked device outside a room.
        racked = (_in_facility(Device.objects.restrict(request.user, 'view')
                               .filter(rack__isnull=False, rack__location__site__in=sites,
                                       rack__location__parent__isnull=False, name__icontains=q),
                               'rack__location__pk')
                  .select_related('rack__location__site', 'rack__location__parent')[:self.LIMIT])
        return JsonResponse({
            'rooms': [_inv_room(x, request) for x in rooms],
            'racks': [_inv_placement(x, 'rack', request) for x in racks],
            'devices': [_inv_placement(x, 'device', request) for x in devices],
            'racked_devices': [_inv_racked_device(x, request) for x in racked],
        })
