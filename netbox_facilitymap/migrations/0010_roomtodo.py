"""Add the `RoomTodo` model — the floor to-do list (ADDON-1).

Creates the per-room to-do table: a note plus its Planned/In progress/Completed status, tied to
`Room` by a CASCADE FK. `Room` upserts in place (`sync_rooms.update_or_create`), so the FK is
resync-stable; CASCADE means a to-do is removed only when its room's polygon is genuinely deleted.
`ChangeLoggingMixin` supplies `created`/`last_updated` (and the global-change-log audit), matching
`FacilityMapBlob` (see migration 0008). Reverse simply drops the table.
"""

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('netbox_facilitymap', '0009_room_floor_location'),
    ]

    operations = [
        migrations.CreateModel(
            name='RoomTodo',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('created', models.DateTimeField(auto_now_add=True, blank=True, null=True)),
                ('last_updated', models.DateTimeField(auto_now=True, blank=True, null=True)),
                ('text', models.CharField(max_length=500)),
                ('status', models.CharField(default='planned', max_length=20)),
                ('room', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='todos', to='netbox_facilitymap.room')),
            ],
            options={
                'ordering': ['created', 'id'],
            },
        ),
    ]
