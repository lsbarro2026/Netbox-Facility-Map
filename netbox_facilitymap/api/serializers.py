"""DRF serializer for the relational `Room` (Phase 5).

This is the *NetBox REST API* surface (mounted under `/api/plugins/facilitymap/`), not
to be confused with the page-mount `frontend_api.py` views that feed the map frontend. It shapes
the same `Room` rows the editor writes through `sync_rooms`, so a room is now reachable
both ways. `polygon` is exposed read/write but is editor-owned geometry (see the roadmap
"last-writer-wins" note); the high-value writable fields here are `label`, `alias` (the NAV-18
printed-name search synonyms), `location`, and the `NetBoxModel` extras (`tags`, `custom_fields`).
`floor_location` (the BIND-1 rename-proof
floor binding) is exposed **read-only** — `sync_rooms` owns it, resolving it from `floor_key`.

**Sweep-on-save caveat — the map editor is authoritative for a floor's room set.** A room you
*create* through this API (a `room_id` the editor never emitted), or geometry you edit on it, is
**removed by the next editor Save of that same floor** — `frontend_api.sync_rooms` treats an
editor POST as the authoritative snapshot of the floor and deletes rooms absent from it (scoped to
`restrict(user, 'delete')`, so only if the saving user may delete that room). This is by design and
not a bug: the editor can't distinguish a REST-authored room from one the user just deleted on the
canvas. Two consequences worth planning around for a pynetbox/automation caller:

- **Durable REST writes target rooms the editor already owns.** Editing `label`/`alias`/`location`/
  `tags`/`custom_fields` on an *existing* (editor-drawn, bound) room survives a resave — the row
  upserts in place (`update_or_create(floor_key, room_id)`) and `sync_rooms` round-trips `alias` like
  `label`, so only the editor-owned `polygon`/`floor_location` are last-writer-wins. Creating
  brand-new rooms via REST is the fragile pattern.
- **A floor the editor never re-saves keeps its REST rooms.** Since CONC-1 an editor POST carries only
  the floors it touched (`sweep_absent=False`), so a REST room on an *untouched* floor is not swept —
  the exposure is a subsequent Save of the *specific* floor the room lives on, not any Save anywhere.
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
            'id', 'url', 'display', 'floor_key', 'room_id', 'label', 'alias', 'polygon',
            'location', 'floor_location', 'tags', 'custom_fields', 'created', 'last_updated',
        )
        brief_fields = ('id', 'url', 'display', 'floor_key', 'room_id', 'label')
