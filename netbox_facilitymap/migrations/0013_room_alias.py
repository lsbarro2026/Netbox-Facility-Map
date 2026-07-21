from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('netbox_facilitymap', '0012_shard_editor_blobs_by_floor'),
    ]

    operations = [
        migrations.AddField(
            model_name='room',
            name='alias',
            field=models.TextField(blank=True, default=''),
        ),
    ]
