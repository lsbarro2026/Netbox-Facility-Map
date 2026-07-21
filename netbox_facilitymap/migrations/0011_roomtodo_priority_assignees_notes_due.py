"""Grow `RoomTodo` to the fields the redesigned to-do panel needs (TASK-1).

Purely additive — every column lands with a default or is nullable, so existing rows survive
untouched: `priority` backfills to `med`, `notes` to `''`, `due` to NULL, and `assignees` to the
empty set (a new through table, so no row is rewritten). No data migration is needed and nothing is
dropped; reverse simply removes the four fields.

`assignees` targets `settings.AUTH_USER_MODEL` — NetBox swaps in its own `users.User`, so this
carries the matching `swappable_dependency` and must never be pinned to `auth.User`.
"""

from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('netbox_facilitymap', '0010_roomtodo'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name='roomtodo',
            name='assignees',
            field=models.ManyToManyField(blank=True, related_name='+', to=settings.AUTH_USER_MODEL),
        ),
        migrations.AddField(
            model_name='roomtodo',
            name='due',
            field=models.DateField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='roomtodo',
            name='notes',
            field=models.TextField(blank=True, default=''),
        ),
        migrations.AddField(
            model_name='roomtodo',
            name='priority',
            field=models.CharField(default='med', max_length=20),
        ),
    ]
