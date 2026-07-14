"""Backfill Room rows from the existing `annotations` blob, and strip the now-promoted
`rooms` out of that blob (Phase 4 cutover).

Forward: read the whole annotations document, create one Room per floor/room (resolving
the bound Location by its stored id), then re-save the blob with `rooms` removed so the
two stores don't double-hold / drift. Reverse: re-inject `rooms` from the Room rows back
into the blob and delete the rows, so `migrate netbox_facilitymap zero` (uninstall) is
clean. Uses historical models only.
"""

from django.db import migrations


def backfill(apps, schema_editor):
    Blob = apps.get_model('netbox_facilitymap', 'FacilityMapBlob')
    Room = apps.get_model('netbox_facilitymap', 'Room')
    Location = apps.get_model('dcim', 'Location')

    row = Blob.objects.filter(kind='annotations', key='').first()
    if not row:
        return
    doc = row.data or {}
    valid_locs = set(Location.objects.values_list('pk', flat=True))
    changed = False
    for fkey, floor in doc.items():
        rooms = (floor or {}).pop('rooms', None)
        if rooms is None:
            continue
        changed = True
        for room in rooms:
            rid = room.get('id')
            if not rid:
                continue
            loc = room.get('location') or {}
            loc_id = loc.get('id')
            if loc_id not in valid_locs:
                loc_id = None
            Room.objects.update_or_create(
                floor_key=fkey, room_id=rid,
                defaults={
                    'label': room.get('label') or '',
                    'polygon': room.get('polygon') or [],
                    'datacenter': bool(room.get('datacenter')),
                    'location_id': loc_id,
                })
    if changed:
        row.data = doc
        row.save()


def unbackfill(apps, schema_editor):
    Blob = apps.get_model('netbox_facilitymap', 'FacilityMapBlob')
    Room = apps.get_model('netbox_facilitymap', 'Room')
    Location = apps.get_model('dcim', 'Location')

    row, _ = Blob.objects.get_or_create(kind='annotations', key='', defaults={'data': {}})
    doc = row.data or {}
    locs = {loc.pk: loc for loc in Location.objects.all()}
    by_floor = {}
    for room in Room.objects.all():
        loc = locs.get(room.location_id)
        snapshot = {'id': loc.pk, 'name': loc.name, 'slug': loc.slug} if loc else None
        by_floor.setdefault(room.floor_key, []).append({
            'id': room.room_id,
            'label': room.label,
            'polygon': room.polygon,
            'datacenter': room.datacenter,
            'location': snapshot,
        })
    for fkey, rooms in by_floor.items():
        doc.setdefault(fkey, {})['rooms'] = rooms
    row.data = doc
    row.save()
    Room.objects.all().delete()


class Migration(migrations.Migration):

    dependencies = [
        ('dcim', '__first__'),
        ('netbox_facilitymap', '0002_room'),
    ]

    operations = [
        migrations.RunPython(backfill, unbackfill),
    ]
