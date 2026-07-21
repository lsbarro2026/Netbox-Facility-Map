"""Restore a plugin-scoped backup written by `facilitymap_backup`. DESTRUCTIVE.

    python manage.py facilitymap_restore --src /path/to/facilitymap-backup-YYYYMMDD-HHMMSS.tar.gz

Replaces ALL current `FacilityMapBlob` + `Room` rows and the working-dir files with the
archive's contents (`backup.restore_backup`, wrapped in a transaction). Prompts for
confirmation unless `--noinput` is given. Restore re-links rooms to Locations by portable
**slug**, so it targets the **same or a new** NetBox instance (a migration path, BAK-1). If a
binding can't be re-resolved on the target it aborts **without changing anything** and reports
what's missing; `--allow-unresolved` proceeds anyway, leaving those rooms unbound. To-do assignees
re-resolve to the target's users by **username** (BAK-2); one with no match is dropped and reported
(never an abort). (Pre-BAK-1 archives carry no slug bindings and restore same-instance-only, as before.)
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
        parser.add_argument(
            '--allow-unresolved', action='store_true',
            help="Proceed even if some room→Location bindings can't be re-resolved on this "
                 'instance, leaving those rooms unbound (default: abort without changing anything).')

    def handle(self, *args, **opts):
        if not opts['noinput']:
            self.stdout.write(self.style.WARNING(
                'This OVERWRITES all current Facility Map rooms/blobs and working-dir files.'))
            if input('Type "yes" to continue: ').strip().lower() != 'yes':
                raise CommandError('aborted — nothing was changed.')

        try:
            summary = backup.restore_backup(opts['src'], allow_unresolved=opts['allow_unresolved'])
        except (FileNotFoundError, ValueError, tarfile.TarError, OSError) as e:
            # RestoreUnresolvedError (a ValueError) lands here too — its message is the full
            # unresolved-bindings report, and nothing was deleted.
            raise CommandError(str(e))

        wd = 'working dir restored' if summary['workdir'] else 'no working dir in archive'
        self.stdout.write(self.style.SUCCESS(
            f"restored {summary['blobs']} blob(s) + {summary['rooms']} room(s) "
            f"+ {summary['todos']} to-do(s); {wd}"))
        if summary['unresolved']:
            self.stderr.write(self.style.WARNING(
                f"{len(summary['unresolved'])} binding(s) left unbound (--allow-unresolved):"))
            for line in summary['unresolved']:
                self.stderr.write(self.style.WARNING(f'  - {line}'))
        if summary['dropped_assignees']:
            self.stderr.write(self.style.WARNING(
                f"{len(summary['dropped_assignees'])} to-do assignee(s) dropped "
                '(no matching user on this instance):'))
            for line in summary['dropped_assignees']:
                self.stderr.write(self.style.WARNING(f'  - {line}'))
