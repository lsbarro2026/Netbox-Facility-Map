from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name='FacilityMapBlob',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('kind', models.CharField(choices=[('annotations', 'Room annotations'), ('siteplan', 'Siteplan hotspots'), ('placements', 'Rack/device placements'), ('layouts', 'Sheet layouts')], max_length=20)),
                ('key', models.CharField(blank=True, default='', max_length=120)),
                ('data', models.JSONField(default=dict)),
                ('updated', models.DateTimeField(auto_now=True)),
            ],
            options={
                'ordering': ['kind', 'key'],
                'unique_together': {('kind', 'key')},
            },
        ),
    ]
