"""Add the custom `import_facilitymapblob` permission (PERM-1).

Splits the destructive import surface (the import wizard endpoints + the Settings page) off the
everyday `change_facilitymapblob` write permission onto a distinct, higher-privilege gate, so a
"rack-placer" role can edit placements without being able to rebuild or wipe the facility. This
only records the option in migration state; the `auth_permission` row itself is created by
Django's `create_permissions` post_migrate signal reading `FacilityMapBlob.Meta.permissions`.
Reversible: dropping the permission from the options restores the auto-only permission set.
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('netbox_facilitymap', '0006_facilitymapblob_facility'),
    ]

    operations = [
        migrations.AlterModelOptions(
            name='facilitymapblob',
            options={
                'ordering': ['kind', 'facility', 'key'],
                'permissions': [('import_facilitymapblob', 'Can import & reset the facility map')],
            },
        ),
    ]
