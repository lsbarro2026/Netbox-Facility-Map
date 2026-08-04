"""Filtering for `Room` (Phase 5), shared by the REST viewset and the UI list view.

Beyond the plain column filters, this carries the **facility-shaped** filters a headless
integrator needs (API-1): `Room` has no Site or facility column — its floor is a `floor_key`
string plus the rename-proof `floor_location` FK — so "every room at this Site" is a query only
`facilities.site_floor_scope` knows how to build. Every filter below reduces to a set of
`Site.slug` and hands it to that single helper, so the Site→room convention lives in one place.

Prefer the **Site** filters over `facility`: a facility is an install-configuration concept (a
`SiteGroup`/`Region` slug, an explicit assignment, or — under the `location` grouping — a top-level
Location subtree, MODEL-8), whereas a Site is stable. The `facility` filter is provided for
completeness and delegates to `facilities.facility_floor_scope` — the same mode-aware Q the
editor's own facility scoping uses — so the facility axis lives in one module rather than here.
"""

import django_filters
from django.db.models import Q
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema_field

from netbox.filtersets import NetBoxModelFilterSet

from dcim.models import Location, Site

from .facilities import facility_floor_scope, site_floor_scope
from .models import Room


class RoomFilterSet(NetBoxModelFilterSet):
    location_id = django_filters.ModelMultipleChoiceFilter(
        field_name='location',
        queryset=Location.objects.all(),
        label='Location (ID)')
    # The rename-proof floor binding (BIND-1). `floor_key` embeds the floor Location's *slug*,
    # frozen in the manifest at import time, so it goes stale on a rename; this FK does not — it is
    # the durable way for a script to ask "every room on this floor".
    floor_location_id = django_filters.ModelMultipleChoiceFilter(
        field_name='floor_location',
        queryset=Location.objects.all(),
        label='Floor location (ID)')
    # `extend_schema_field` because these resolve through a `method=` rather than a model field, so
    # drf-spectacular can't infer their type for the OpenAPI schema (it would default both to
    # string and warn). The FK-backed filters above need no hint — they resolve via the model.
    site_id = extend_schema_field(OpenApiTypes.INT)(django_filters.ModelMultipleChoiceFilter(
        queryset=Site.objects.all(), method='filter_site', label='Site (ID)'))
    site = extend_schema_field(OpenApiTypes.STR)(django_filters.ModelMultipleChoiceFilter(
        queryset=Site.objects.all(), to_field_name='slug', method='filter_site',
        label='Site (slug)'))
    facility = django_filters.CharFilter(
        method='filter_facility', label='Facility (grouping slug)')

    class Meta:
        model = Room
        fields = ('id', 'floor_key', 'room_id', 'label', 'alias')

    def search(self, queryset, name, value):
        # `q` free-text across the human-meaningful identity fields (incl. the NAV-18 search aliases).
        if not value.strip():
            return queryset
        return queryset.filter(
            Q(label__icontains=value)
            | Q(alias__icontains=value)
            | Q(room_id__icontains=value)
            | Q(floor_key__icontains=value))

    def _by_site_slugs(self, queryset, slugs):
        """Narrow `queryset` to rooms whose floor belongs to one of `slugs`. Fail-closed on an empty
        set (`site_floor_scope` returns `None`): a filter naming no resolvable Site matches nothing,
        rather than silently degrading to "every room"."""
        scope = site_floor_scope(set(slugs))
        return queryset.filter(scope) if scope is not None else queryset.none()

    def filter_site(self, queryset, name, value):
        """Both `site_id` and `site` land here — a `ModelMultipleChoiceFilter` resolves either form
        to `Site` instances, so the only difference is which column the caller names them by."""
        if not value:
            return queryset
        return self._by_site_slugs(queryset, [site.slug for site in value])

    def filter_facility(self, queryset, name, value):
        # Never called with an empty value — django-filter treats `?facility=` as "not supplied" —
        # so the default facility `''` (the ungrouped remainder) is not expressible here; name its
        # Sites directly instead. Resolved unscoped: this bounds which floors are the facility's,
        # not who may see them, and the queryset is already `restrict()`ed by the caller. Goes
        # through `facility_floor_scope` (not the site-slug reduction) because under the `location`
        # grouping a facility is a Location subtree sharing its Site with siblings (MODEL-8) — the
        # facility module owns which axis applies. Fail-closed like the Site filters: a facility
        # that scopes nothing matches nothing.
        scope = facility_floor_scope(value)
        return queryset.filter(scope) if scope is not None else queryset.none()
