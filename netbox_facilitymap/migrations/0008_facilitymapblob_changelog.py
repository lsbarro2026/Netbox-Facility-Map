"""Give `FacilityMapBlob` a change-logging audit trail (AUDIT-1).

Applies NetBox's `ChangeLoggingMixin` to the blob model, which adds the `created` and
`last_updated` columns the mixin defines. Once the model has `to_objectchange` (via the mixin)
the global `handle_changed_object` post_save receiver records an `ObjectChange` on every blob
write, so edits to the siteplan/arrows/placements/layouts/settings documents show up in the
global Change Log — closing the gap with `Room`, which already logged for free as a
`NetBoxModel`.

Both columns are nullable (matching the mixin's field definitions), so existing rows adopt them
with **no backfill** — `created` is simply NULL on rows that predate this migration. The
pre-existing `updated` column is left untouched (the CONC-1 concurrency token reads it).
Reversible: dropping the two columns restores the plain model.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('netbox_facilitymap', '0007_facilitymapblob_import_permission'),
    ]

    operations = [
        migrations.AddField(
            model_name='facilitymapblob',
            name='created',
            field=models.DateTimeField(auto_now_add=True, blank=True, null=True),
        ),
        migrations.AddField(
            model_name='facilitymapblob',
            name='last_updated',
            field=models.DateTimeField(auto_now=True, blank=True, null=True),
        ),
    ]
