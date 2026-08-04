"""Delete the Facility Map plugin's data — DB rows *and* working-dir files. DESTRUCTIVE.

    python manage.py facilitymap_wipe --all                  # back to a blank-slate install
    python manage.py facilitymap_wipe --facility <slug>      # one facility's map data only
    python manage.py facilitymap_wipe --facility ""          # the default facility

`--all` removes every `FacilityMapBlob` row (the per-facility documents *and* the install-wide
settings), every `Room` (+ its to-dos), and the whole working dir; `--facility` narrows to one
facility and spares the install-wide settings. Nothing outside the plugin is touched — no `dcim`
rows, and no backup archive under `backup_dir`. Exactly one of the two flags is required, so a bare
invocation destroys nothing. Prompts for confirmation unless `--noinput`; `--backup` writes a
`facilitymap_backup` archive first, since this is irreversible. The work lives in `wipe.py` so this
command and `imports.WipeView` share one code path.
"""

from django.core.management.base import BaseCommand, CommandError

from netbox_facilitymap import backup, wipe


class Command(BaseCommand):
    help = "Delete the Facility Map plugin's data (DB rows + working-dir files). Destructive."

    def add_arguments(self, parser):
        scope = parser.add_mutually_exclusive_group(required=True)
        scope.add_argument(
            '--all', action='store_true',
            help='Wipe EVERYTHING — all facilities, all rooms, the install-wide settings, and the '
                 'entire working dir (a blank-slate install).')
        scope.add_argument(
            '--facility',
            help="Wipe only this facility's map data and working-dir files (\"\" = the default "
                 'facility). Install-wide settings and other facilities are left alone.')
        parser.add_argument(
            '--backup', action='store_true',
            help='Write a backup archive (as facilitymap_backup does) before wiping.')
        parser.add_argument(
            '--noinput', action='store_true',
            help='Skip the confirmation prompt (for unattended use).')

    def handle(self, *args, **opts):
        # `--facility ""` is the default facility and must stay distinguishable from "flag absent",
        # so test against None rather than truthiness.
        facility = None if opts['all'] else opts['facility']
        scope = ('ALL plugin data (every facility, every room, the install-wide settings, and the '
                 'whole working dir)' if facility is None
                 else 'the %s facility\'s map data and files'
                      % (repr(facility) if facility else 'default'))

        if not opts['noinput']:
            self.stdout.write(self.style.WARNING(
                'This permanently deletes %s. It cannot be undone — run facilitymap_backup (or '
                'pass --backup) first if you might want it back.' % scope))
            if input('Type "yes" to continue: ').strip().lower() != 'yes':
                raise CommandError('aborted — nothing was changed.')

        if opts['backup']:
            path, _pruned = backup.create_backup()
            self.stdout.write(self.style.SUCCESS(f'wrote backup {path}'))

        try:
            summary = wipe.wipe_data(facility)
        except (ValueError, wipe.WipeBusyError, OSError) as e:
            raise CommandError(str(e))

        wd = 'working dir cleared' if summary['workdir'] else 'no working dir to clear'
        self.stdout.write(self.style.SUCCESS(
            f"wiped {summary['blobs']} blob(s) + {summary['rooms']} room(s) "
            f"+ {summary['todos']} to-do(s); {wd}"))
