"""Reserve a per-facility discriminator on `FacilityMapBlob` (MULTI-1).

Adds the `facility` column and extends the uniqueness to `(kind, facility, key)`, so each
`kind` can hold one document *per facility* instead of one global row. `facility` defaults
to `''` (the single/default facility), so every existing row adopts it with **no backfill**
and all current `key=''` call sites keep resolving the same row — back-compat by
construction. The full multi-facility feature (per-facility working dir, picker UI) is
still unbuilt; this only reserves the storage so future rows aren't stranded as singletons.
Reversible: dropping the column restores the `(kind, key)` uniqueness.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('netbox_facilitymap', '0005_alter_facilitymapblob_kind'),
    ]

    operations = [
        # Drop the old constraint before adding the field, then re-add the widened one —
        # keeps the intermediate state valid on backends that check unique_together eagerly.
        migrations.AlterUniqueTogether(
            name='facilitymapblob',
            unique_together=set(),
        ),
        migrations.AddField(
            model_name='facilitymapblob',
            name='facility',
            field=models.CharField(blank=True, default='', max_length=120),
        ),
        migrations.AlterModelOptions(
            name='facilitymapblob',
            options={'ordering': ['kind', 'facility', 'key']},
        ),
        migrations.AlterUniqueTogether(
            name='facilitymapblob',
            unique_together={('kind', 'facility', 'key')},
        ),
    ]
