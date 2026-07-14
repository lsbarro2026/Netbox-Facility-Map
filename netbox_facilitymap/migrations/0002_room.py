"""Create the relational Room model (Phase 4).

Authored to NetBox 4.x conventions (the `NetBoxModel` base contributes `created`,
`last_updated`, `custom_field_data`, and the `tags` M2M). Generate/verify this against
the exact NetBox minor you pin (`makemigrations netbox_facilitymap`): the base-field set
and the `dcim`/`extras` migration graph can shift between 4.x minors, and the generated
file should win if it differs.
"""

import django.db.models.deletion
import taggit.managers
import utilities.json
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('dcim', '__first__'),
        ('extras', '__first__'),
        ('netbox_facilitymap', '0001_initial'),
    ]

    operations = [
        migrations.CreateModel(
            name='Room',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ('created', models.DateTimeField(auto_now_add=True, null=True)),
                ('last_updated', models.DateTimeField(auto_now=True, null=True)),
                ('custom_field_data', models.JSONField(blank=True, default=dict, encoder=utilities.json.CustomFieldJSONEncoder)),
                ('floor_key', models.CharField(max_length=120)),
                ('room_id', models.CharField(max_length=40)),
                ('label', models.CharField(blank=True, max_length=200)),
                ('polygon', models.JSONField(default=list)),
                ('datacenter', models.BooleanField(default=False)),
                ('location', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to='dcim.location')),
                ('tags', taggit.managers.TaggableManager(through='extras.TaggedItem', to='extras.Tag')),
            ],
            options={
                'ordering': ['floor_key', 'label'],
                'unique_together': {('floor_key', 'room_id')},
            },
        ),
    ]
