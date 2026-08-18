"""Give `Room` an explicit stacking order (ROOM-4).

Adds `Room.z_order` — the room's paint and hit-test position within its floor, 0 = bottom — and
seeds it so existing floors keep rendering exactly as they do today.

Until now a floor's rooms were painted in whatever order the read path happened to return, which
`Room.Meta.ordering = ['floor_key', 'label']` re-sorted alphabetically on every GET; nothing a user
did to the stacking survived a reload, and SVG painting order *is* hit order, so which room received
a click where two overlap was equally incidental.

Forward: `AddField` (default 0), then backfill each floor's rooms in **descending polygon area**, so
the largest room lands at the bottom and a room nested inside another sits above it. That default is
what preserves the ROOM-1/ROOM-2 contained-room auto-punch, which as of ROOM-4 only punches a
contained child that is drawn *above* its container: left at the uniform `0` default the tiebreak
would order nested pairs arbitrarily and roughly half of them would lose their punch on upgrade — a
visible rendering regression on floors nobody had touched.

Reverse: dropping the column removes the ordering (the backfill has no other side effect), and the
render paths fall back to their previous incidental order. Uses historical models only.
"""

from django.db import migrations, models


def _polygon_area(ring):
    """Unsigned shoelace area of a normalized 0..1 ring. A local copy on purpose: a migration must
    not import `previews.polygon_area` (or any app module), whose behaviour is free to change while
    this migration's meaning is frozen. Degenerate rings (<3 points) area 0, so they sort last."""
    if len(ring) < 3:
        return 0.0
    total = 0.0
    for i, (x, y) in enumerate(ring):
        nx, ny = ring[(i + 1) % len(ring)]
        total += x * ny - nx * y
    return abs(total) / 2.0


def seed_z_order(apps, schema_editor):
    Room = apps.get_model('netbox_facilitymap', 'Room')

    by_floor = {}
    for room in Room.objects.all().iterator():
        by_floor.setdefault(room.floor_key, []).append(room)

    for rooms in by_floor.values():
        # Largest first, then `room_id` so the seeding is deterministic for equal-area rooms
        # (the reverse of the assignment below: index 0 is the bottom of the stack).
        rooms.sort(key=lambda r: (-_polygon_area(r.polygon or []), r.room_id))
        for i, room in enumerate(rooms):
            room.z_order = i
        Room.objects.bulk_update(rooms, ['z_order'])


class Migration(migrations.Migration):

    dependencies = [
        ('netbox_facilitymap', '0014_facilitymapblob_facility_map_kind'),
    ]

    operations = [
        migrations.AddField(
            model_name='room',
            name='z_order',
            field=models.PositiveIntegerField(default=0),
        ),
        migrations.RunPython(seed_z_order, migrations.RunPython.noop),
    ]
