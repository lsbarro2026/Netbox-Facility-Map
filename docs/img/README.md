# Project images

Provenance for the plugin's icon: one art, two homes.

## `icon.png`, the plugin icon

A stylized folded floor-plan map: rooms and location markers evoking the siteplan → room map.
A 500×500 square RGBA PNG with a transparent background, which satisfies the certification icon
requirement (square, transparent, recognizable from 48×48 up to 500×500).

The same file serves two roles:

- **Listing / certification icon**, `docs/img/icon.png` (this copy). Everything under `docs/` is
  **docs-only**: `MANIFEST.in` and `package-data` scope the sdist/wheel to `README.md`, `LICENSE`,
  and the package's `templates/` + `static/` trees, so nothing here ships.
- **App favicon (shipped)**, `netbox_facilitymap/static/netbox_facilitymap/icon.png`, the
  browser-tab icon referenced by `templates/netbox_facilitymap/index.html` via `{% static %}`.
  This copy ships with the plugin.

The shipped copy also has small-size derivatives (`icon-16.png`, `icon-32.png`, `icon-180.png`, the
apple-touch-icon), sharpened and resized from this same art so the browser tab renders a legible
mark instead of downscaling the 500×500 original on the fly. They live only under
`static/netbox_facilitymap/`, referenced by `index.html`'s `sizes=`-hinted `<link>` tags. They are
**not** mirrored into `docs/img/`, since this directory's job is the single 500×500
certification/listing asset (recognizable from 48×48 up, per the cert requirement below), not
favicon tab rendering.

### License

- **Author / copyright:** © 2026 Liam Sbarro
- **License:** [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/),
  which permits commercial use with attribution.
- **Attribution line:** *Icon "netbox-facilitymap" © 2026 Liam Sbarro, CC BY 4.0.*
