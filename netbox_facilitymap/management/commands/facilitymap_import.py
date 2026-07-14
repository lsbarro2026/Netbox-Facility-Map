"""Import a legacy JSON export (from the retired standalone tool) into the plugin's stores.

    python manage.py facilitymap_import --src /path/to/legacy-export

`siteplan` / `placements` / `layouts` each map to one `FacilityMapBlob` row (kind,
key=''), round-tripping losslessly. `annotations.json` is decomposed (Phase 4): its room
polygons become `Room` rows and the rest (each floor's image/w/h/arrows) is stored in the
`annotations` blob — exactly what `AnnotationsView.post` does, so a later GET recomposes
the original document. `rackcache.json` and `manifest.json` are intentionally not imported
(regenerable / served as static).
"""

import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from netbox_facilitymap.frontend_api import _split_annotations, sync_rooms
from netbox_facilitymap.models import FacilityMapBlob

# tool JSON filename -> blob kind (annotations is handled separately, see handle()).
FILES = {
    'siteplan.json': 'siteplan',
    'rackplacements.json': 'placements',
    'pagelayouts.json': 'layouts',
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

        # annotations: decompose into Room rows + a room-less blob (Phase 4).
        doc = self._read(src, 'annotations.json')
        if doc is not None:
            blob, rooms_by_floor = _split_annotations(doc)
            with transaction.atomic():
                sync_rooms(rooms_by_floor)
                FacilityMapBlob.objects.update_or_create(
                    kind='annotations', key='', defaults={'data': blob})
            n = sum(len(r) for r in rooms_by_floor.values())
            self.stdout.write(self.style.SUCCESS(
                f'imported annotations.json -> {n} Room rows + annotations blob'))

        for fname, kind in FILES.items():
            data = self._read(src, fname)
            if data is None:
                continue
            FacilityMapBlob.objects.update_or_create(
                kind=kind, key='', defaults={'data': data})
            self.stdout.write(self.style.SUCCESS(f'imported {fname} -> kind={kind}'))
