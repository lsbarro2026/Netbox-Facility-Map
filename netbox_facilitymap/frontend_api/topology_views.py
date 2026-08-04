"""The DCIM topology probe and its object-search sibling (TOPO-2 / TOPO-3).

The read-only half of the facility-identity story: `facilities.py` *resolves* a facility from the
configured grouping, and these *survey* the live `dcim` tree to work out which grouping would
express this install in the first place. Both front the same admin-tier configuration decision, so
both are `IMPORT_PERM` despite being reads, and both are deliberately **install-wide** — the
facility axis is exactly what is being chosen, so scoping them to a facility would answer with the
ungrouped remainder and come up empty on precisely the campus install they exist to configure.

Named `topology_views` rather than `topology` so it can't be misread as the top-level
`..topology` module (`probe()`) whose output it serves.
"""

from django.contrib.auth.mixins import LoginRequiredMixin
from django.http import HttpResponseBadRequest, HttpResponseForbidden, JsonResponse
from django.views import View

from dcim.models import Location, Site

from ..access import IMPORT_PERM
from ..topology import probe
from .common import NB_LIST_CAP


class NbTopologyView(LoginRequiredMixin, View):
    """What shape is this NetBox, and which settings express it — `topology.probe()` verbatim (TOPO-2).

    A read-only survey of the live `dcim` tree that returns ranked candidate
    `{grouping, org_mode, campus_site}` triples with the numbers each implies, so the import wizard
    can say "we found 124 buildings" instead of asking an operator to translate their mental model
    into two setting names. It **proposes only** — nothing here writes a setting, and a probe the
    operator ignores leaves no trace.

    Optional exemplar pks — `?site=&building=&floor=&room=` — switch it to resolve-from-a-sample:
    the operator points at real objects and the response carries the topology they imply, or names
    the pick that contradicts the others (a "room" that isn't a child of the picked floor). Same
    envelope either way, so one client renders both. An id naming nothing the caller may view is a
    400, like `NbLocationCreateView`'s missing parent — a bad id is a client bug, not an empty result.

    Gated on `IMPORT_PERM` despite being a read, like `NbFacilityGroupingPreviewView` beside it: it
    exists to front an admin-tier configuration decision, so its audience is exactly the grouping
    POST's. It **does not** inherit that view's deliberate lack of object-permission scoping —
    the preview is unscoped because understating a *blast radius* risks data loss, whereas this is a
    survey that proposes a setting, so it takes the plugin's ordinary read stance and scopes every
    query with `.restrict(user, 'view')` (§4: there is no REST token; the probe must never report
    objects the viewer can't see).

    **Facility-agnostic** — no `?facility=`, and not in `FACILITY_PREFIXES`. The grouping axis it
    surveys is install-wide, and is chosen *before* the facilities it creates exist. That is also why
    a campus-shaped candidate carries **`campus_facility`** (IMPORT-17): every wizard step *after*
    this one searches only the active facility (`NbSitesView`/`NbBuildingLocationsView`, FACIL-1), so
    without a facility named here the install-wide counts and the facility-scoped searches can
    disagree — the probe finds 124 buildings while a client still on the default facility `''` (the
    *ungrouped* remainder) finds none. `''` is a real value; `null` means the question doesn't apply
    (no campus Site, or the `location` grouping, where one campus hosts many facilities)."""

    #: The exemplar roles resolve-from-a-sample accepts, each an object pk in the query string.
    SAMPLE_ROLES = ('site', 'building', 'floor', 'room')

    def get(self, request):
        if not request.user.has_perm(IMPORT_PERM):
            return HttpResponseForbidden('import permission required')
        sample = {}
        for role in self.SAMPLE_ROLES:
            raw = request.GET.get(role)
            if raw in (None, ''):
                continue
            if not raw.isdigit():
                return HttpResponseBadRequest('%s must be an object id' % role)
            sample[role] = int(raw)
        try:
            return JsonResponse(probe(request.user, sample or None))
        except ValueError as exc:
            return HttpResponseBadRequest(str(exc))


class NbTopologyObjectsView(LoginRequiredMixin, View):
    """The **search** sibling of the probe above (TOPO-3): find the real Sites/Locations an operator
    points at when answering "which of these is a building, a floor, a room?".

    The wizard's topology step feeds those picks back to `NbTopologyView`'s resolve-from-a-sample
    mode as exemplar pks, so this exists purely to *name* them. It cannot reuse `NbSitesView` or
    `NbBuildingLocationsView`: both are deliberately facility-scoped (FACIL-1), and at this step the
    facility axis is exactly what is being decided — the grouping isn't settled, so `facility_sites`
    would answer with the ungrouped remainder and the picker would come up empty on precisely the
    campus install this step exists to configure. `NbLocationsView` is keyed by a Site *slug* the
    operator hasn't picked yet, and caps its results to one Site.

    So the scope here is the whole install, exactly like the probe it feeds — and, exactly like the
    probe, that scope is `.restrict(user, 'view')` on every queryset (§4: the plugin holds no REST
    token, so a picker must never name an object the viewer can't see) and gated on `IMPORT_PERM`,
    since it fronts the same admin-tier configuration decision. **Facility-agnostic** — no
    `?facility=`, and not in `FACILITY_PREFIXES`.

    `?kind=site|location` selects the model; `?q=` is the free-text name filter the combobox types
    into. For Locations, `?site=<pk>` narrows to one Site and `?parent=<pk>` to one Location's
    **direct children** — what turns the guided questions into a drill-down (site → building → floor
    → room) whose exemplars are consistent with each other by construction, rather than four
    independent searches the probe then has to report contradictions between. Each hit carries its
    `site_name`/`parent_name` so the picker can show where in the tree it sits; a bad `kind` or a
    non-numeric pk is a 400, the `NbTopologyView` stance (a bad input is a client bug, not an empty
    result). Read-only."""

    KINDS = ('site', 'location')

    def get(self, request):
        if not request.user.has_perm(IMPORT_PERM):
            return HttpResponseForbidden('import permission required')
        kind = request.GET.get('kind', '')
        if kind not in self.KINDS:
            return HttpResponseBadRequest('kind must be one of: %s' % ', '.join(self.KINDS))
        q = request.GET.get('q', '')
        if kind == 'site':
            qs = Site.objects.restrict(request.user, 'view')
            if q:
                qs = qs.filter(name__icontains=q)
            return JsonResponse({'objects': [{
                'id': s.pk, 'name': s.name, 'slug': s.slug,
                'site_name': None, 'parent_name': None,
            } for s in qs.order_by('name')[:NB_LIST_CAP]]})

        qs = Location.objects.restrict(request.user, 'view').select_related('site', 'parent')
        for param, field in (('site', 'site_id'), ('parent', 'parent_id')):
            raw = request.GET.get(param)
            if raw in (None, ''):
                continue
            if not raw.isdigit():
                return HttpResponseBadRequest('%s must be an object id' % param)
            qs = qs.filter(**{field: int(raw)})
        if q:
            qs = qs.filter(name__icontains=q)
        return JsonResponse({'objects': [{
            'id': loc.pk, 'name': loc.name, 'slug': loc.slug,
            'site_name': loc.site.name if loc.site_id else None,
            'parent_name': loc.parent.name if loc.parent_id else None,
        } for loc in qs.order_by('name')[:NB_LIST_CAP]]})
