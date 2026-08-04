"""Report broken slug/Location bindings in the Facility Map plugin's data.

    python manage.py facilitymap_check

A read-only consistency check (never writes/deletes/re-maps). It runs unrestricted (operator
shell = trusted, like `facilitymap_import`) and prints a section per finding class. **Exits 1 when
any drift is found**, 0 when clean — so cron/CI can alert. The report is always printed either
way. The actual checks live in `health.py` so this command and the Settings-page panel share one
code path. See README's "Consistency check".

**Draw-only rooms are reported but never alert (DOC-12).** Three of the four classes are drift; a
room with geometry and no Location binding is a supported state (an install that doesn't model a
Location per room), so it prints as an informational section and is excluded from both the issue
count and the exit code. Counting it made the command exit 1 forever on such an install. See
`health.HealthReport.has_drift` for why the asymmetry is deliberate.
"""

from django.core.management.base import BaseCommand

from netbox_facilitymap import health


class Command(BaseCommand):
    help = "Check the Facility Map plugin's data for broken slug/Location bindings (read-only)."

    def handle(self, *args, **opts):
        report = health.run_checks(user=None)

        self._section(
            'Unresolved floor keys (floor no longer matches a Site + Location)',
            report.unresolved_floor_keys,
            lambda r: (f'{r.floor_key} — {r.reason}; {r.room_count} room(s)'
                       f"{'' if r.in_manifest else '; not in manifest'}"),
        )
        self._info_section(
            'Draw-only rooms (geometry with no Location binding)',
            report.unbound_rooms,
            lambda r: f'{r.floor_key} / {r.room_id} — {r.label or "(unnamed)"}',
        )
        self._section(
            'Stale placements (map marker whose rack/device no longer exists)',
            report.stale_placements,
            lambda r: f'{r.floor_key} — {r.kind} #{r.object_id} — {r.label or "(no label)"}',
        )
        self._section(
            'Orphaned facilities (map data under a key no Site resolves to)',
            report.orphaned_facilities,
            lambda r: (f'{r.facility or "(default)"} — {", ".join(r.blob_kinds) or "no editor data"}'
                       f'{f"; reassign to {r.suggested}" if r.suggested else ""}'),
        )

        if report.has_drift:
            # Draw-only rooms are deliberately absent from this count, exactly as they are from
            # `has_drift` — the number must name what the non-zero exit is about (DOC-12).
            n = (len(report.unresolved_floor_keys)
                 + len(report.stale_placements) + len(report.orphaned_facilities))
            self.stderr.write(self.style.ERROR(f'{n} issue(s) found.'))
            raise SystemExit(1)
        self.stdout.write(self.style.SUCCESS('No consistency issues found.'))

    def _section(self, title, rows, fmt):
        """Print one drift category: a green all-clear line, or the title plus a warning per row."""
        if not rows:
            self.stdout.write(self.style.SUCCESS(f'OK  {title}'))
            return
        self.stdout.write(self.style.WARNING(f'{title} — {len(rows)}:'))
        for row in rows:
            self.stdout.write(self.style.WARNING(f'  - {fmt(row)}'))

    def _info_section(self, title, rows, fmt):
        """Print one **informational** category — a finding that is a supported state, not a fault
        (draw-only rooms, DOC-12). Deliberately unstyled rather than `WARNING`, and silent when
        empty: an operator scanning for problems should see nothing that reads as one, and the
        green `OK` lines are reserved for categories whose emptiness actually means "clean"."""
        if not rows:
            return
        self.stdout.write(f'{title} — {len(rows)}:')
        for row in rows:
            self.stdout.write(f'  - {fmt(row)}')
