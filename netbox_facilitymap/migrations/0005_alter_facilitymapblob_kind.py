"""Add the `settings` kind to `FacilityMapBlob`.

A choices-only change (no DB schema change): the new `('settings', 'Plugin settings')`
choice backs the in-app Settings page, persisted as a single `key=''` row. Django still
records the `AlterField` so the model and migration history stay in lockstep.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('netbox_facilitymap', '0004_remove_room_datacenter'),
    ]

    operations = [
        migrations.AlterField(
            model_name='facilitymapblob',
            name='kind',
            field=models.CharField(
                choices=[
                    ('annotations', 'Room annotations'),
                    ('siteplan', 'Siteplan hotspots'),
                    ('placements', 'Rack/device placements'),
                    ('layouts', 'Sheet layouts'),
                    ('settings', 'Plugin settings'),
                ],
                max_length=20,
            ),
        ),
    ]
