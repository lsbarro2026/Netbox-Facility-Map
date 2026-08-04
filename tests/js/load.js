'use strict';
/* load.js — the one way this tier gets a shipped frontend class into Node.

   The frontend has no module system: `templates/.../index.html` loads each file as a plain
   <script>, so every class is a browser **global** and the files carry no `export` /
   `module.exports`. Adding one purely to make them importable would be the build-system creep
   coding-standard #3 exists to prevent, so instead the shipped file is read as text and its
   classes are evaluated inside a `new Function` body, which is exactly the scope a <script> tag
   gives them. The `static/` tree stays byte-identical — this tier can never be the reason a
   shipped file changed shape.

   Dependencies between classes are handled the same way index.html handles them: **concatenate
   the sources in dependency order** into one `new Function`, so a later file sees the earlier
   file's classes as ordinary lexical bindings. There is no resolver and no stubbing of one class
   for another.

   Browser globals (`window`) are stubbed only where a class genuinely reads one, and only as a
   plain object — this tier does NOT stub the DOM. A class that touches `document` at all belongs
   in a browser, not here; see README.md for where that line sits. */

const fs = require('node:fs');
const path = require('node:path');

/** The shipped frontend tree, as loaded by index.html. */
const SRC_DIR = path.join(
  __dirname, '..', '..', 'netbox_facilitymap', 'static', 'netbox_facilitymap');

/** Read one shipped source file's text. Throws a useful message if the file was renamed — a
 *  silent empty string would surface much later as "class is not defined". */
function readSource(file) {
  const full = path.join(SRC_DIR, file);
  if (!fs.existsSync(full))
    throw new Error(`no such frontend source: ${file} (looked in ${SRC_DIR})`);
  return fs.readFileSync(full, 'utf8');
}

/** Evaluate `files` (in dependency order, exactly as index.html loads them) and return the
 *  named classes as `{Name: class}`.
 *
 *  Each file's own `'use strict'` prologue rides along in the concatenated body, so the classes
 *  run under the same strictness they do in the browser. `;` separators guard against a source
 *  file that happens to end without one. */
function loadClasses(files, names) {
  const body = files.map(readSource).join('\n;\n')
    + `\n; return { ${names.join(', ')} };`;
  return new Function(body)();
}

/** Install a minimal `window` global for classes that read `window.MAP` — the object
 *  `index.html` injects (`api`/`media`/`static`/`csrf`, plus `roleGlyphs`). Returns the stub so a
 *  test can set the one key it cares about; call it again to reset between tests.
 *
 *  Deliberately NOT a DOM: `window.document`, `matchMedia`, `localStorage` and friends are absent
 *  on purpose, so a class that needs them fails loudly here rather than being quietly propped up
 *  by a fake browser this tier has no business maintaining. */
function stubWindow(map = {}) {
  globalThis.window = { MAP: map };
  return globalThis.window;
}

module.exports = { SRC_DIR, readSource, loadClasses, stubWindow };
