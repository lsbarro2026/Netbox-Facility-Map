"""Report broken slug/Location bindings in the Facility Map plugin's data.

    python manage.py facilitymap_check

A read-only consistency check (never writes/deletes/re-maps). It runs unrestricted (operator
shell = trusted, like `facilitymap_import`) and prints a section per drift class. **Exits 1 when
any drift is found**, 0 when clean — so cron/CI can alert. The report is always printed either
way. The actual checks live in `health.py` so this command and the Settings-page panel share one
code path. See README's "Consistency check".
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
        self._section(
            'Unbound rooms (geometry with no Location binding)',
            report.unbound_rooms,
            lambda r: f'{r.floor_key} / {r.room_id} — {r.label or "(no label)"}',
        )
        self._section(
            'Stale placements (map marker whose rack/device no longer exists)',
            report.stale_placements,
            lambda r: f'{r.floor_key} — {r.kind} #{r.object_id} — {r.label or "(no label)"}',
        )

        if report.has_drift:
            n = (len(report.unresolved_floor_keys) + len(report.unbound_rooms)
                 + len(report.stale_placements))
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
