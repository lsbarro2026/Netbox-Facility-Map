"""Add the `facility_map` kind to `FacilityMapBlob`.

A choices-only change (no DB schema change): the new `('facility_map', 'Facility assignments')`
choice backs the explicit Site→facility assignment map (FACILITY-IDENTITY Phase 1) — a single
install-wide row (`facility=''`, `key=''`) holding `{site_slug: facility_slug}`. Django still
records the `AlterField` so the model and migration history stay in lockstep.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('netbox_facilitymap', '0013_room_alias'),
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
                    ('facility_map', 'Facility assignments'),
                ],
                max_length=20,
            ),
        ),
    ]
