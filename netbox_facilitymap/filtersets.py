"""Filtering for `Room` (Phase 5), shared by the REST viewset and the UI list view."""

import django_filters
from django.db.models import Q

from netbox.filtersets import NetBoxModelFilterSet

from dcim.models import Location

from .models import Room


class RoomFilterSet(NetBoxModelFilterSet):
    location_id = django_filters.ModelMultipleChoiceFilter(
        field_name='location',
        queryset=Location.objects.all(),
        label='Location (ID)')

    class Meta:
        model = Room
        fields = ('id', 'floor_key', 'room_id', 'label')

    def search(self, queryset, name, value):
        # `q` free-text across the human-meaningful identity fields.
        if not value.strip():
            return queryset
        return queryset.filter(
            Q(label__icontains=value)
            | Q(room_id__icontains=value)
            | Q(floor_key__icontains=value))
