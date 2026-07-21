"""Shard the per-floor editor documents by floor (CONC-1).

`annotations`/`placements`/`layouts` were each stored as one whole-document row (`key=''`) whose
`data` is a `{floor_key: floor_document}` dict, so the CONC-1 concurrency token (the row's
`updated`) covered every floor at once and any two concurrent saves collided — even across disjoint
floors. This data migration splits each such row into **one row per floor** (`key=floor_key`,
`data=floor_document`), so a save conflict-checks and writes only the floors it touched and
different-floor saves stop colliding. `siteplan` (facility-wide) and `settings` (install-wide) stay
single `key=''` rows and are untouched.

No schema change — `key` (max_length 120, matching `Room.floor_key`) already holds a floor key.
Reversible: recombine each kind's per-floor rows back into one `key=''` whole-document row.
"""

from django.db import migrations

SHARDED_KINDS = ('annotations', 'placements', 'layouts')


def shard(apps, schema_editor):
    Blob = apps.get_model('netbox_facilitymap', 'FacilityMapBlob')
    for row in Blob.objects.filter(kind__in=SHARDED_KINDS, key=''):
        data = row.data
        if not isinstance(data, dict):
            continue   # unexpected shape — leave the row as-is rather than lose it
        for floor_key, floor_data in data.items():
            Blob.objects.update_or_create(
                kind=row.kind, facility=row.facility, key=floor_key,
                defaults={'data': floor_data})
        row.delete()


def unshard(apps, schema_editor):
    Blob = apps.get_model('netbox_facilitymap', 'FacilityMapBlob')
    # Group the per-floor rows by (kind, facility) and fold them back into one whole-document row.
    combined = {}
    per_floor = Blob.objects.filter(kind__in=SHARDED_KINDS).exclude(key='')
    for row in per_floor:
        combined.setdefault((row.kind, row.facility), {})[row.key] = row.data
    for (kind, facility), data in combined.items():
        Blob.objects.update_or_create(
            kind=kind, facility=facility, key='', defaults={'data': data})
    per_floor.delete()


class Migration(migrations.Migration):

    dependencies = [
        ('netbox_facilitymap', '0011_roomtodo_priority_assignees_notes_due'),
    ]

    operations = [
        migrations.RunPython(shard, unshard),
    ]
