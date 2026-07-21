"""Import a legacy JSON export (from the retired standalone tool) into the plugin's stores.

    python manage.py facilitymap_import --src /path/to/legacy-export

`siteplan` maps to one facility-wide `FacilityMapBlob` row (kind, key=''). `placements` /
`layouts` / `annotations` are **per-floor sharded** (`key=floor_key`, CONC-1): each floor of the
legacy document becomes its own row, exactly what `BlobView`/`AnnotationsView.post` now write, so
a later GET recomposes the original document. `annotations.json` is additionally decomposed
(Phase 4): its room polygons become `Room` rows and the rest (each floor's image/w/h/arrows) is
stored in the per-floor `annotations` blob. `rackcache.json` and `manifest.json` are intentionally
not imported (regenerable / served as static).
"""

import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from netbox_facilitymap.frontend_api import _split_annotations, sync_rooms
from netbox_facilitymap.models import FacilityMapBlob

# tool JSON filename -> blob kind (annotations is handled separately, see handle()). `siteplan` is
# one facility-wide row; `placements`/`layouts` are per-floor sharded (a floor-keyed dict).
FILES = {
    'siteplan.json': ('siteplan', False),
    'rackplacements.json': ('placements', True),
    'pagelayouts.json': ('layouts', True),
}


class Command(BaseCommand):
    help = "Import the standalone tool's JSON files into FacilityMapBlob rows."

    def add_arguments(self, parser):
        parser.add_argument(
            '--src', required=True,
            help='Path to a directory holding the legacy JSON export '
                 '(siteplan/placements/layouts/annotations).')

    def _read(self, src, fname):
        path = src / fname
        if not path.is_file():
            self.stdout.write(self.style.WARNING(f'skip {fname} (absent)'))
            return None
        try:
            return json.loads(path.read_text())
        except json.JSONDecodeError as e:
            raise CommandError(f'{fname}: invalid JSON ({e})')

    def handle(self, *args, **opts):
        src = Path(opts['src'])
        if not src.is_dir():
            raise CommandError(f'--src is not a directory: {src}')

        # annotations: decompose into Room rows + a room-less per-floor blob (Phase 4 + CONC-1).
        doc = self._read(src, 'annotations.json')
        if doc is not None:
            blob, rooms_by_floor = _split_annotations(doc)
            with transaction.atomic():
                sync_rooms(rooms_by_floor)
                for fkey, fdata in blob.items():
                    # One row per floor; skip a floor with no rooms, arrows or notes (nothing to
                    # store — its manifest image/w/h alone doesn't warrant a row), matching what the
                    # editor persists.
                    if rooms_by_floor.get(fkey) or fdata.get('arrows') or fdata.get('notes'):
                        FacilityMapBlob.objects.update_or_create(
                            kind='annotations', key=fkey, defaults={'data': fdata})
            n = sum(len(r) for r in rooms_by_floor.values())
            self.stdout.write(self.style.SUCCESS(
                f'imported annotations.json -> {n} Room rows + per-floor annotations blobs'))

        for fname, (kind, sharded) in FILES.items():
            data = self._read(src, fname)
            if data is None:
                continue
            if sharded:
                # A floor-keyed dict → one row per floor (empty floors carry no row).
                for fkey, fdata in (data or {}).items():
                    if fdata:
                        FacilityMapBlob.objects.update_or_create(
                            kind=kind, key=fkey, defaults={'data': fdata})
            else:
                FacilityMapBlob.objects.update_or_create(
                    kind=kind, key='', defaults={'data': data})
            self.stdout.write(self.style.SUCCESS(f'imported {fname} -> kind={kind}'))
