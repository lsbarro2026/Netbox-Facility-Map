"""Home-dashboard widgets — embed the facility map SPA in a NetBox dashboard card.

The map is a full-screen single-page app (`MapView` → `index.html`), not a server-rendered
panel, so the widgets surface it the cheap, robust way: an `<iframe>` of the existing view.
Being same-origin, the iframe inherits the user's NetBox session, so the SPA's ORM-backed
auth and authenticated `media_url` images work with no extra plumbing — there is no second
rendering path or API token to maintain. Every widget loads `?embed=1`, which puts the SPA
in its static mode (read by `MapView`): no chrome, no side panel, no in-card breadcrumbs, and
a result click that would drill in instead opens the full map in the **top window** (the
chrome-free card has no breadcrumbs to return through). Three widgets ship:

- `FacilityMapWidget` — the interactive siteplan card. Clicking a building deep-links the full
  map at that building. Two opt-in toggles relax the static default — `&interactive=1` re-enables
  pan/zoom and `&legend=1` shows the "All buildings" list — both off. An optional deep-link hash
  pins a specific building/floor. The iframe is sized to the map's **own aspect ratio** (from the
  rendered manifest's siteplan `w`/`h`) via CSS `aspect-ratio`, so the largest map-shaped box that
  fits the grid-sized card body is shown; before any facility is imported it falls back to a plain
  fill.
- `FacilitySearchWidget` — a search-only card (NAV-15). It loads `&finder=1`, which shows *just* the
  wayfinding search bar (no map, no legend); typing returns the same hits the on-map finder gives
  (buildings + placed rooms/racks/devices + unplaced NetBox inventory), and a hit opens the full map
  in the top window, deep-linked (and framed) at the target. No aspect ratio to honour — a search
  box just fills the card.
- `FacilityTodoWidget` — a to-do card (DASH-1). It loads `#/todo`, embedding the SPA's facility-wide
  to-do rollup (`TodoPage`) so a user sees what work is open across every building/floor on login.
  It mirrors the in-app to-do *page*, not the dev backlog. Like the search card there's no map to
  shape the card to, so the iframe is a plain fill; a to-do row click escapes to the full map in the
  top window (`App.navigateOut`), since the chrome-free card has no breadcrumbs to drill through.
  Gated on the install-wide `todos` add-on toggle (ADDON-4/ADDON-5): off degrades to a message
  instead of iframing `#/todo`, which would otherwise bounce to the bare map.

All three share `_FacilityWidget`: the map-read gate (degrade to a message rather than iframing a
403) and the optional-facility resolution.
"""

from django import forms
from django.urls import reverse
from django.utils.html import format_html

from extras.dashboard.widgets import DashboardWidget, WidgetConfigForm, register_widget

from .access import may_view_map
from .previews import todos_enabled
from .storage import read_manifest, valid_facility


class _FacilityWidget(DashboardWidget):
    """Shared base for the facility dashboard widgets. Not registered itself (no `@register_widget`)
    — only its concrete subclasses are. Holds the two bits every facility card needs: the map-read
    gate and the optional-facility resolution, both of which iframe the same `MapView` in embed mode."""

    def _message(self, text):
        """A plain centred message filling the card, in place of an iframe — shared shape for both
        the permission-denied and feature-disabled degrades."""
        return format_html(
            '<div style="height:100%;display:flex;align-items:center;justify-content:center;'
            'text-align:center;color:var(--tblr-secondary,#6c757d);padding:1rem">{}</div>',
            text)

    def _permission_denied(self):
        """The degrade shown when the user lacks the optional map-read permission: iframing the
        (gated) `MapView` for them would render a raw 403 inside the card, so show a message instead."""
        return self._message('You do not have permission to view the facility map.')

    def _facility(self):
        """The configured facility (a Site Group / Region slug) validated via `valid_facility`, or
        '' when blank/invalid — an invalid slug falls back to the default facility and never leaks
        into the iframe src. The SPA reads it from the leading `#/y/<slug>` hash segment."""
        try:
            return valid_facility((self.config.get('facility') or '').strip())
        except ValueError:
            return ''


@register_widget
class FacilityMapWidget(_FacilityWidget):
    default_title = 'Facility Map'
    description = 'Interactive siteplan → building → floor → room map.'
    width = 12
    height = 10   # gridstack rows; the iframe auto-fits the card, so this just sets the opening size

    class ConfigForm(WidgetConfigForm):
        interactive = forms.BooleanField(
            required=False, initial=False,
            help_text='Allow pan and zoom inside the card (off = a fixed, fitted map).',
        )
        show_legend = forms.BooleanField(
            required=False, initial=False,
            help_text='Show the "All buildings" list beside the siteplan.',
        )
        facility = forms.CharField(
            required=False,
            help_text='Optional facility (Site Group / Region slug) to show. Blank = the default '
                      'facility.',
        )
        link = forms.CharField(
            required=False,
            help_text='Optional deep-link, e.g. #/b/<dir> or #/f/<dir>/<fid>. Blank opens the siteplan.',
        )

    def _siteplan_ratio(self, facility=''):
        """``(w, h)`` of the siteplan from the given facility's rendered manifest, or ``None`` when
        it can't be read. The manifest is a build artifact (absent before the first import,
        regenerated by every ``build``), read via the mtime-memoized `storage.read_manifest`;
        a missing manifest or a malformed siteplan falls back to None."""
        siteplan = (read_manifest(facility) or {}).get('siteplan') or {}
        try:
            w, h = int(siteplan['w']), int(siteplan['h'])
        except (ValueError, TypeError, KeyError):
            return None
        return (w, h) if w > 0 and h > 0 else None

    def render(self, request):
        # Honour the optional map-read gate: iframing the (gated) MapView for a user who lacks the
        # view permission would render a raw 403 inside the card, so degrade to a plain message.
        if not may_view_map(request.user):
            return self._permission_denied()

        config = self.config
        # Always embedded (chrome-free, no navigation); pan/zoom and the building list are opt-in.
        src = reverse('plugins:netbox_facilitymap:map') + '?embed=1'
        if config.get('interactive'):
            src += '&interactive=1'
        if config.get('show_legend'):
            src += '&legend=1'
        # The optional facility (a Site Group / Region slug) the widget shows, validated on read.
        facility = self._facility()
        # The hash fragment must follow the querystring; the SPA router decodes each segment. Build
        # `#/[y/<facility>/][<link path>]` — the facility prefix then the optional deep-link.
        link = (config.get('link') or '').strip().lstrip('#').strip('/')
        segs = (['y', facility] if facility else []) + ([link] if link else [])
        if segs:
            src += '#/' + '/'.join(segs)
        # Size the iframe to the map's aspect ratio so it fills the card with no scroll and
        # minimal dead space: width:100% + aspect-ratio + max-height:100% is the largest
        # map-shaped box that fits the (grid-sized) card body, and the flex wrapper centres it
        # when a dimension is letterboxed. CSS recomputes it on every card resize. With no
        # manifest yet, fall back to a plain fill so the card stays usable.
        ratio = self._siteplan_ratio(facility)
        if ratio:
            box = ('display:block;border:0;width:100%;aspect-ratio:{}/{};'
                   'max-height:100%;margin-inline:auto').format(*ratio)
        else:
            box = 'display:block;border:0;width:100%;height:100%'
        return format_html(
            '<div style="height:100%;display:flex;align-items:center;justify-content:center">'
            '<iframe src="{}" title="Facility Map" loading="lazy" style="{}"></iframe></div>',
            src, box,
        )


@register_widget
class FacilitySearchWidget(_FacilityWidget):
    """A search-only facility card (NAV-15): just the wayfinding search bar, no map or legend.

    Loads the same `MapView` iframe as `FacilityMapWidget`, but with `&finder=1` — the SPA renders
    only the finder (`SiteplanEditor._finder`), which returns the same hits the on-map search gives
    (buildings + placed rooms/racks/devices + unplaced NetBox inventory) and, being chrome-free,
    opens a clicked result in the full map in the top window (deep-linked + framed). There is no map
    to shape the card to, so the iframe is a plain fill rather than aspect-ratio-boxed."""

    default_title = 'Facility Search'
    description = 'Search buildings, rooms, and racks across the facility map — no map, just search.'
    width = 6
    height = 3    # gridstack rows; a search box + a short results list, not a full map

    class ConfigForm(WidgetConfigForm):
        result_target = forms.ChoiceField(
            required=False, initial='map',
            choices=[('map', 'Facility map page'), ('netbox', 'NetBox object page')],
            help_text='Where clicking a result goes: the facility map (deep-linked to the target) '
                      'or the matched object’s NetBox detail page.',
        )
        facility = forms.CharField(
            required=False,
            help_text='Optional facility (Site Group / Region slug) to search. Blank = the default '
                      'facility.',
        )

    def render(self, request):
        if not may_view_map(request.user):
            return self._permission_denied()

        # Embedded (chrome-free, top-window navigation) + search-only presentation (`finder=1`).
        src = reverse('plugins:netbox_facilitymap:map') + '?embed=1&finder=1'
        # A result click deep-links the map by default; `netbox` instead opens the object's NetBox
        # detail page (NAV-16). The flag rides the iframe URL → MapView context → window.MAP → finder.
        if self.config.get('result_target') == 'netbox':
            src += '&target=netbox'
        # Same optional-facility resolution as the map widget; a valid slug rides the `#/y/<slug>`
        # hash segment the SPA router reads (an invalid one is dropped to the default facility).
        facility = self._facility()
        if facility:
            src += '#/y/' + facility
        # No manifest aspect ratio to honour — a search box just fills the card.
        return format_html(
            '<div style="height:100%;display:flex">'
            '<iframe src="{}" title="Facility Search" loading="lazy" '
            'style="display:block;border:0;width:100%;height:100%"></iframe></div>',
            src,
        )


@register_widget
class FacilityTodoWidget(_FacilityWidget):
    """A facility-wide to-do card (DASH-1): the SPA's `#/todo` rollup (`TodoPage`) in a dashboard card,
    so a user sees what work is open across the whole facility on login.

    Loads the same `MapView` iframe as the map/search widgets, at the `#/todo` route — the router
    dispatches `App.showTodo` regardless of embed, and the to-do scripts ship eagerly, so the rollup
    renders chrome-free inside the card exactly as on the plugin's To-do nav tab. This mirrors the
    in-app to-do *page*, deliberately not the dev `TODO.local.md` backlog (an internal tool with no
    user-facing role). There is no map to shape the card to, so the iframe is a plain fill; a to-do
    row click escapes to the full map in the top window (`App.navigateOut`) rather than stranding the
    user on a breadcrumb-free floor view inside the card.

    Gated on the install-wide `todos` add-on toggle (ADDON-4/ADDON-5): when the feature is off,
    `#/todo` itself bounces to the bare map (`TodoView`/`App.showTodo`), so iframing it unconditionally
    would show an empty/wrong map instead of hiding — this degrades to a message instead, mirroring
    `_permission_denied`."""

    default_title = 'Facility To-do'
    description = 'Facility-wide to-do rollup — every building and floor’s open work in one card.'
    width = 6
    height = 8    # gridstack rows; a triage list wants height, but a card the user resizes at will

    class ConfigForm(WidgetConfigForm):
        facility = forms.CharField(
            required=False,
            help_text='Optional facility (Site Group / Region slug) to show to-dos for. Blank = the '
                      'default facility.',
        )

    def render(self, request):
        if not may_view_map(request.user):
            return self._permission_denied()
        if not todos_enabled():
            return self._message('The to-do feature is not enabled.')

        # Embedded (chrome-free, top-window navigation) at the facility-wide to-do route.
        src = reverse('plugins:netbox_facilitymap:map') + '?embed=1'
        # The `#/todo` route, facility-prefixed as `#/y/<slug>/todo` when a valid slug is configured
        # (an invalid one drops to the default facility) — the same `#/y/<slug>` segment the SPA
        # router reads before dispatching the route parts.
        facility = self._facility()
        segs = (['y', facility] if facility else []) + ['todo']
        src += '#/' + '/'.join(segs)
        # No manifest aspect ratio to honour — a to-do list just fills the card.
        return format_html(
            '<div style="height:100%;display:flex">'
            '<iframe src="{}" title="Facility To-do" loading="lazy" '
            'style="display:block;border:0;width:100%;height:100%"></iframe></div>',
            src,
        )
