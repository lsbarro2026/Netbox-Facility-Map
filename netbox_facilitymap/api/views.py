"""REST API viewset for `Room` (Phase 5).

`NetBoxModelViewSet` gives the full CRUD surface plus NetBox's object-permission
restriction, brief mode, and change logging for free. The same `RoomFilterSet` backs both
this viewset and the UI list view, so REST `?floor_key=`/`?location_id=`
filtering matches the UI filters.

Read the **Sweep-on-save caveat** in `serializers.py` before scripting room *creates* here: the
map editor is authoritative for a floor's room set, so a REST-created room is removed by the next
editor Save of that floor. REST writes are durable when they edit `label`/`location`/`tags` on rooms
the editor already owns.
"""

from netbox.api.viewsets import NetBoxModelViewSet

from ..filtersets import RoomFilterSet
from ..models import Room
from .serializers import RoomSerializer


class RoomViewSet(NetBoxModelViewSet):
    queryset = Room.objects.prefetch_related('location', 'tags')
    serializer_class = RoomSerializer
    filterset_class = RoomFilterSet
