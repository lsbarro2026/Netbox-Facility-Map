"""Write a plugin-scoped backup (DB rows + working dir) to the configured backup dir.

    python manage.py facilitymap_backup

Opt-in: run it from operator cron for nightly backups (see README). Each run writes one
timestamped `.tar.gz` and FIFO-prunes the dir to `backup_max_mb`. The actual work lives in
`backup.py` so this command and any other caller share one code path.
"""

from django.core.management.base import BaseCommand

from netbox_facilitymap import backup


class Command(BaseCommand):
    help = "Back up the Facility Map plugin's data (DB rows + working dir) to a .tar.gz."

    def handle(self, *args, **opts):
        path, pruned = backup.create_backup()
        self.stdout.write(self.style.SUCCESS(f'wrote {path}'))
        for name in pruned['removed']:
            self.stdout.write(f'pruned {name}')
        if pruned['over_cap_kept']:
            self.stderr.write(self.style.WARNING(
                f"newest backup {pruned['over_cap_kept']} exceeds backup_max_mb on its own "
                f"— kept anyway (raise backup_max_mb or relocate backup_dir)"))
