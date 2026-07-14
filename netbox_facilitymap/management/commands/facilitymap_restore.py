"""Restore a plugin-scoped backup written by `facilitymap_backup`. DESTRUCTIVE.

    python manage.py facilitymap_restore --src /path/to/facilitymap-backup-YYYYMMDD-HHMMSS.tar.gz

Replaces ALL current `FacilityMapBlob` + `Room` rows and the working-dir files with the
archive's contents (`backup.restore_backup`, wrapped in a transaction). Prompts for
confirmation unless `--noinput` is given. Intended for the same NetBox instance the backup
came from — `Room.location` FKs reference live `dcim.Location` ids.
"""

import tarfile

from django.core.management.base import BaseCommand, CommandError

from netbox_facilitymap import backup


class Command(BaseCommand):
    help = "Restore the Facility Map plugin's data from a backup .tar.gz (destructive)."

    def add_arguments(self, parser):
        parser.add_argument(
            '--src', required=True,
            help='Path to a facilitymap-backup-*.tar.gz written by facilitymap_backup.')
        parser.add_argument(
            '--noinput', action='store_true',
            help='Skip the confirmation prompt (for unattended use).')

    def handle(self, *args, **opts):
        if not opts['noinput']:
            self.stdout.write(self.style.WARNING(
                'This OVERWRITES all current Facility Map rooms/blobs and working-dir files.'))
            if input('Type "yes" to continue: ').strip().lower() != 'yes':
                raise CommandError('aborted — nothing was changed.')

        try:
            summary = backup.restore_backup(opts['src'])
        except (FileNotFoundError, ValueError, tarfile.TarError, OSError) as e:
            raise CommandError(str(e))

        wd = 'working dir restored' if summary['workdir'] else 'no working dir in archive'
        self.stdout.write(self.style.SUCCESS(
            f"restored {summary['blobs']} blob(s) + {summary['rooms']} room(s); {wd}"))
