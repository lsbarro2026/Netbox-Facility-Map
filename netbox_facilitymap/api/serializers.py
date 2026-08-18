"""DRF serializer for the relational `Room` (Phase 5).

This is the *NetBox REST API* surface (mounted under `/api/plugins/facilitymap/`), not
to be confused with the page-mount `frontend_api` views that feed the map frontend. It shapes
the same `Room` rows the editor writes through `sync_rooms`, so a room is now reachable
both ways. `polygon` is exposed read/write but is editor-owned geometry (see the roadmap
"last-writer-wins" note), and `z_order` (the room's stacking order within its floor, ROOM-4) sits on
that same editor-owned side: the editor rewrites every room's `z_order` from its own array order on
each Save, so a value set here lasts only until the floor is next saved on the canvas. The
high-value writable fields here are `label`, `alias` (the NAV-18
printed-name search synonyms), `location`, and the `NetBoxModel` extras (`tags`, `custom_fields`).
`floor_location` (the BIND-1 rename-proof floor binding) is exposed **read-only** because it is
*derived*, not independent: it is the floor Location a `floor_key` names. A REST client sets a
room's floor by setting `floor_key`, and this serializer resolves the FK from it on every write
(`validate`), through the same `frontend_api.resolve_floor_location` `sync_rooms` uses — so REST
and editor writes produce the same binding, and a REST-created room resolves on its floor's
Location page like any other (API-1). Accepting the FK directly would create a second source of
truth for one fact and be overwritten by the next editor Save anyway.

**Sweep-on-save — the map editor stays authoritative for a floor's room set.**
`frontend_api.sync_rooms` treats an editor POST as the authoritative snapshot of the floor and
deletes rooms absent from it (scoped to `restrict(user, 'delete')`, so only if the saving user may
delete that room). That rule is by design and unchanged: the editor can't distinguish a
REST-authored room from one the user just deleted on the canvas, and a room the user *does* delete
must actually go away.

What changed (API-1) is that the rule no longer costs you data. Every write through this API bumps
the CONC-1 concurrency token of the room's floor (`frontend_api.touch_floor_version`), so an editor
holding a document fetched *before* that write gets the ordinary 409 on Save instead of silently
sweeping. On reload the document *contains* the REST room — `compose_annotations` serves `Room`
rows whether or not the editor drew them — so the next Save preserves it. Three consequences worth
knowing for a pynetbox/automation caller:

- **REST-created rooms survive.** A room you create here appears in the editor and is kept by
  subsequent Saves. It is removed only if a user genuinely deletes it on the canvas, or if a client
  saves **without** the version header at all — the token check is opt-in by design, so a
  non-versioned writer still last-writer-wins.
- **Durable REST writes target rooms the editor already owns.** Editing `label`/`alias`/`location`/
  `tags`/`custom_fields` on an *existing* (editor-drawn, bound) room survives a resave — the row
  upserts in place (`update_or_create(floor_key, room_id)`) and `sync_rooms` round-trips `alias` like
  `label`, so only the editor-owned `polygon` is last-writer-wins.
- **A floor the editor never re-saves keeps its REST rooms regardless.** Since CONC-1 an editor POST
  carries only the floors it touched (`sweep_absent=False`), so a Save of one floor never touches
  another's rooms.
"""

from rest_framework import serializers

from netbox.api.serializers import NetBoxModelSerializer
# 4.x "brief-nested" convention: one serializer renders the nested form via `nested=True`.
# Verify the import path against the pinned NetBox minor (it has moved between 3.x/4.x).
from dcim.api.serializers import LocationSerializer

from ..frontend_api import resolve_floor_location
from ..models import Room


class RoomSerializer(NetBoxModelSerializer):
    url = serializers.HyperlinkedIdentityField(
        view_name='plugins-api:netbox_facilitymap-api:room-detail')
    location = LocationSerializer(nested=True, required=False, allow_null=True)
    # Read-only because it is derived: `validate` resolves it from `floor_key` on every write, the
    # same way `sync_rooms` does. A client sets the floor by setting `floor_key`.
    floor_location = LocationSerializer(nested=True, read_only=True)

    def validate(self, data):
        """Derive `floor_location` from the room's `floor_key` (API-1).

        **Sticky, exactly like `sync_rooms`**: applied only when the key resolves to a live floor
        Location, so a write against a key whose Site or floor was renamed leaves the
        previously-stored — still correct — FK alone rather than nulling it. On a PATCH that omits
        `floor_key` the instance's own key is used, so re-resolving is idempotent."""
        data = super().validate(data)
        floor_key = data.get('floor_key') or getattr(self.instance, 'floor_key', '')
        floor_loc = resolve_floor_location(floor_key) if floor_key else None
        if floor_loc is not None:
            data['floor_location'] = floor_loc
        return data

    class Meta:
        model = Room
        fields = (
            'id', 'url', 'display', 'floor_key', 'room_id', 'label', 'alias', 'polygon',
            'z_order', 'location', 'floor_location', 'tags', 'custom_fields',
            'created', 'last_updated',
        )
        brief_fields = ('id', 'url', 'display', 'floor_key', 'room_id', 'label')
