"""REST API viewset for `Room` (Phase 5).

`NetBoxModelViewSet` gives the full CRUD surface plus NetBox's object-permission
restriction, brief mode, and change logging for free. The same `RoomFilterSet` backs both
this viewset and the UI list view, so REST `?floor_key=`/`?location_id=`
filtering matches the UI filters.
"""

from netbox.api.viewsets import NetBoxModelViewSet

from ..filtersets import RoomFilterSet
from ..models import Room
from .serializers import RoomSerializer


class RoomViewSet(NetBoxModelViewSet):
    queryset = Room.objects.prefetch_related('location', 'tags')
    serializer_class = RoomSerializer
    filterset_class = RoomFilterSet
