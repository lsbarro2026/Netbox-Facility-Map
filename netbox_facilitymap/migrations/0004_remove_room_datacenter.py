"""Drop the `Room.datacenter` flag.

The boolean used to gate everything rack-related (only datacenter rooms could hold
racks/devices and pull NetBox inventory). Racks/devices can now be placed on any room
bound to a Location, so the flag is obsolete. Dropping the column is irreversible —
existing per-room datacenter flags are discarded.
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('netbox_facilitymap', '0003_backfill_rooms'),
    ]

    operations = [
        migrations.RemoveField(
            model_name='room',
            name='datacenter',
        ),
    ]
