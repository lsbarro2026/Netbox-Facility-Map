# Documentation images

Project assets for the plugin's listing pages (PyPI project icon, plugin catalog entry) and its
certification submission. These are **docs assets only** — they are not part of the installed
plugin, and the public `README.md` does not embed them. `MANIFEST.in` and `package-data` scope the
sdist/wheel to `README.md`, `LICENSE`, and the package's `templates/` + `static/` trees, so
nothing under `docs/` ships in the built package.

## `icon.svg` — plugin icon

The square plugin icon used on the listing pages: a floor plan of rooms with a location pin
marking a room linked to a NetBox Location. Authored as an SVG (`viewBox="0 0 512 512"`,
transparent outside the badge), so it scales losslessly across the certification's
48×48 → 500×500 px range.

- **Author / copyright:** © 2026 Liam Sbarro
- **License:** [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)
  — permits commercial use with attribution. The license and creator are also embedded in the
  SVG's `<metadata>` (Dublin Core + `cc:license`).
- **Attribution line:** *Icon "netbox-facilitymap" © 2026 Liam Sbarro, CC BY 4.0.*
