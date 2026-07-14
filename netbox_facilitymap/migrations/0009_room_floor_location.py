"""Give `Room` a stable, rename-proof floor binding (BIND-1).

Adds `Room.floor_location`, an FK to the *floor* `dcim.Location`, and backfills it from the
existing slug-keyed `floor_key`. Until now the floor a room belongs to was bound only by the
`floor_key` string (`"<site.slug>/<floorLocation.slug>"`); renaming the Site or the floor
Location moved the slug but not the frozen `floor_key`, silently orphaning the floor's rooms on
the Location page. The FK is the durable anchor — the NetBox-facing resolvers prefer it, while
`floor_key` stays the manifest/disk key for image lookup.

Forward: `AddField` the nullable FK, then resolve each Room's `floor_key` → `(site slug, floor
slug)` → the child floor Location and set the FK. A `floor_key` that doesn't resolve today (a
floor-type floor with no Location, or an already-orphaned key) leaves the FK NULL — i.e. exactly
today's behaviour, so the backfill can only improve resolution, never break a working map.
Reverse: dropping the column removes the binding (the backfill has no other side effect). Uses
historical models only.
"""

from django.db import migrations, models
import django.db.models.deletion


def backfill_floor_location(apps, schema_editor):
    Room = apps.get_model('netbox_facilitymap', 'Room')
    Location = apps.get_model('dcim', 'Location')

    # (site slug, floor Location slug) -> floor Location pk. One bulk pass over the Locations that
    # sit under a Site, mirroring how `NbRoomsView`/`health` resolve a floor key by its two slugs.
    floor_by_slugs = {}
    for pk, site_slug, slug in (Location.objects
                                .filter(site__isnull=False)
                                .values_list('pk', 'site__slug', 'slug')):
        floor_by_slugs.setdefault((site_slug, slug), pk)

    for room in Room.objects.all().iterator():
        site_slug, sep, floor_slug = room.floor_key.partition('/')
        if not (sep and site_slug and floor_slug):
            continue
        loc_pk = floor_by_slugs.get((site_slug, floor_slug))
        if loc_pk is not None:
            room.floor_location_id = loc_pk
            room.save(update_fields=['floor_location'])


class Migration(migrations.Migration):

    dependencies = [
        ('dcim', '__first__'),
        ('netbox_facilitymap', '0008_facilitymapblob_changelog'),
    ]

    operations = [
        migrations.AddField(
            model_name='room',
            name='floor_location',
            field=models.ForeignKey(
                blank=True, null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='+', to='dcim.location'),
        ),
        migrations.RunPython(backfill_floor_location, migrations.RunPython.noop),
    ]
