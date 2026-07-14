"""DRF serializer for the relational `Room` (Phase 5).

This is the *NetBox REST API* surface (mounted under `/api/plugins/facilitymap/`), not
to be confused with the page-mount `frontend_api.py` views that feed the map frontend. It shapes
the same `Room` rows the editor writes through `sync_rooms`, so a room is now reachable
both ways. `polygon` is exposed read/write but is editor-owned geometry (see the roadmap
"last-writer-wins" note); the high-value writable fields here are `label`, `location`,
and the `NetBoxModel` extras (`tags`, `custom_fields`). `floor_location` (the BIND-1 rename-proof
floor binding) is exposed **read-only** — `sync_rooms` owns it, resolving it from `floor_key`.
"""

from rest_framework import serializers

from netbox.api.serializers import NetBoxModelSerializer
# 4.x "brief-nested" convention: one serializer renders the nested form via `nested=True`.
# Verify the import path against the pinned NetBox minor (it has moved between 3.x/4.x).
from dcim.api.serializers import LocationSerializer

from ..models import Room


class RoomSerializer(NetBoxModelSerializer):
    url = serializers.HyperlinkedIdentityField(
        view_name='plugins-api:netbox_facilitymap-api:room-detail')
    location = LocationSerializer(nested=True, required=False, allow_null=True)
    # Read-only: the floor binding is derived from `floor_key` by `sync_rooms`, not set via REST.
    floor_location = LocationSerializer(nested=True, read_only=True)

    class Meta:
        model = Room
        fields = (
            'id', 'url', 'display', 'floor_key', 'room_id', 'label', 'polygon',
            'location', 'floor_location', 'tags', 'custom_fields', 'created', 'last_updated',
        )
        brief_fields = ('id', 'url', 'display', 'floor_key', 'room_id', 'label')
