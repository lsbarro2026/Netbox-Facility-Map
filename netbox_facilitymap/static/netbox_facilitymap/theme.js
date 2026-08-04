'use strict';
/* theme.js — follow NetBox's light/dark theme from the plugin's standalone page.

   The map SPA is its own document (`index.html` does not extend NetBox's `base/layout.html`),
   so NetBox's stylesheet and its `colorMode.ts` never load here — there is no `data-bs-theme`
   to inherit and no `--tblr-*` palette to read. We therefore read NetBox's own setting
   ourselves and stamp the same attribute style.css keys its dark token block off.

   NetBox stores the mode in `localStorage['netbox-color-mode']` and stamps
   `data-bs-theme` on <html> from `window.load`. We only ever READ that key: seeding it is
   NetBox's job (it does so once, from `prefers-color-scheme`), and writing it from here could
   pin a mode the user never chose in NetBox itself. When the key is absent we mirror NetBox's
   own fallback — `prefers-color-scheme`, defaulting to light — without persisting the result.

   This runs synchronously from <head> (after the stylesheet link, so CSS still fetches first)
   rather than with the deferred class bundle at the end of <body>: the attribute has to land
   before first paint or a dark install flashes the light palette. */

const THEME_KEY = 'netbox-color-mode';

class Theme {
  /** The mode NetBox is in: 'dark' or 'light'. Read-only — never persists a fallback. */
  static current() {
    let stored = null;
    // Storage access throws outright when cookies/site-data are blocked; degrade to the
    // media-query fallback rather than taking the whole page down from <head>.
    try { stored = window.localStorage.getItem(THEME_KEY); } catch (e) { stored = null; }
    if (stored === 'dark' || stored === 'light') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  /** Stamp the mode where style.css's `[data-bs-theme="dark"]` block can see it. */
  static apply(mode) {
    document.documentElement.setAttribute('data-bs-theme', mode);
  }

  /** Apply the current mode, then track later changes.

      `storage` fires in every OTHER same-origin document when the key changes — never in the
      one that wrote it. That is exactly the dashboard-widget case: the widgets are iframes of
      this page, so toggling the theme in the surrounding NetBox tab repaints them live. */
  static init() {
    Theme.apply(Theme.current());
    window.addEventListener('storage', (e) => {
      if (e.key === THEME_KEY || e.key === null) Theme.apply(Theme.current());
    });
  }
}

Theme.init();
