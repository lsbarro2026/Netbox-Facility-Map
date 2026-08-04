'use strict';
/* editor-toolbar.js — EditorToolbar: the shared editor toolbar, its button factories, and the
   shortcuts reference panel — the Editor base's toolbar/DOM-assembly concern, extracted as a
   collaborator holding an editor back-ref (`this.ed`), the FloorArrange shape (QUAL-4).

   `build()` assembles the whole bar for BOTH editors (§10 *Edit-menu lockstep*): the base owns
   the scaffold and the shared buttons here, and a subclass contributes only through the hooks
   that stay on Editor (`_editButtons`/`_alignTools`/`_deviceTools`/`_editExtras`/`_viewButtons`/
   `_showsSave`, the save/badge cluster, and the `_shortcutGroups()` declaration this panel
   renders). Mode/undo/draw state, the grid, and the viewport all live on the editor — every
   factory reads them through `this.ed`, so a rebuilt bar always reflects the editor's state. */

class EditorToolbar {
  constructor(editor) {
    this.ed = editor;
    this._shortcutsOpen = false;   // re-entrancy guard for the shortcuts dialog
  }

  /** Floating zoom controls (+ / − / fit) for the map viewport corner. Built unconditionally on
   *  any interactive map; the phone hides the cluster in CSS (`.zoom-ctl` in the 720px block),
   *  where pinch-zoom already does this job — no JS gate, so a breakpoint crossing needs no
   *  re-render and no fourth `matchMedia`. */
  zoomControls() {
    const btn = (label, title, fn) => Dom.el('button', { title, type: 'button',
      onclick: () => fn() }, label);
    return Dom.el('div', { class: 'zoom-ctl' }, [
      btn('+', 'Zoom in', () => this.ed.viewport.zoomBy(ZOOM_STEP)),
      btn('−', 'Zoom out', () => this.ed.viewport.zoomBy(1 / ZOOM_STEP)),
      btn('⤢', 'Reset to fit', () => this.ed.viewport.fit()),
    ]);
  }

  // ---- shared toolbar buttons ----
  /** A vertical divider that groups related toolbar controls. */
  divider() { return Dom.el('span', { class: 'tb-div' }); }

  undoButton() {
    // Contextual, matching Ctrl+Z: mid-draw it removes the last draft point; otherwise
    // it undoes the last committed mutation.
    return Dom.el('button', { class: 'icononly', title: 'Undo (Ctrl+Z)',
      onclick: () => { this.ed.draft ? this.ed.undoNode() : this.ed.undo(); }, html: Icons.undo + '<span>Undo</span>' });
  }
  // The two shape-drawing tools, shared by both editors (§10 *Edit-menu lockstep*): click
  // points into a polygon, or drag out an axis-aligned box. Only the wording is per-editor,
  // and only through `_shapeTerms` — the behaviour behind them is entirely on the base.
  // Both are `tb-labeled` (icon + text that collapses to icon+tooltip on a narrow bar).
  drawShapeButton() {
    const { noun, drawLabel } = this.ed._shapeTerms();
    return Dom.el('button', { class: 'tb-labeled', title: `Add a ${noun}: click points · Enter/double-click to close`,
      onclick: () => this.ed.beginDraw(
        'Click to add points · Backspace undoes a point · Right-click removes a point · Enter/double-click to close · Esc to cancel'),
      html: Icons.draw + '<span>' + drawLabel + '</span>' });
  }
  rectShapeButton() {
    const { noun } = this.ed._shapeTerms();
    return Dom.el('button', { class: 'tb-labeled', title: `Add a rectangular ${noun}: drag a box`,
      onclick: () => this.ed.beginRect(`Drag a rectangle to make a ${noun} · Esc to cancel`),
      html: Icons.rect + '<span>Add rectangle</span>' });
  }
  /** The shape panel's Duplicate action — copy this shape into a new, unbound one. Lives
   *  here (not in either panel) so both editors offer the same action off the same code. */
  duplicateButton(shape) {
    const { noun } = this.ed._shapeTerms();
    return Dom.el('button', { class: 'wide', title: `Copy this ${noun}’s shape into a new, unbound polygon`,
      onclick: () => this.ed.duplicateShape(shape),
      html: Icons.dup + `<span>Duplicate as new ${noun}</span>` });
  }
  snapButton() {
    const b = Dom.el('button', { class: 'icononly' + (this.ed.snapOn ? ' active' : ''), title: 'Snap to nearby vertices/edges', html: Icons.snap + '<span>Snap</span>' });
    b.onclick = () => { this.ed.snapOn = !this.ed.snapOn; b.classList.toggle('active', this.ed.snapOn); };
    return b;
  }
  orthoButton() {
    const b = Dom.el('button', { class: 'icononly' + (this.ed.orthoOn ? ' active' : ''), title: 'Right-angle snap: align a dragged node to its neighbours (90° corners)', html: Icons.rightangle + '<span>Right angle</span>' });
    b.onclick = () => {
      this.ed.orthoOn = !this.ed.orthoOn;
      b.classList.toggle('active', this.ed.orthoOn);
      try { localStorage.setItem(ORTHO_KEY, this.ed.orthoOn ? '1' : '0'); }
      catch (e) { console.warn('ortho: could not persist toggle', e); }
    };
    return b;
  }
  gridToggleButton() {
    const b = Dom.el('button', { class: 'icononly' + (this.ed.grid.on ? ' active' : ''), title: 'Toggle the alignment grid', html: Icons.grid + '<span>Grid</span>' });
    b.onclick = () => { this.ed.grid.on = !this.ed.grid.on; b.classList.toggle('active', this.ed.grid.on); this.ed.render(); };
    return b;
  }
  gridSizeSelect() {
    const sel = Dom.el('select', { title: 'Grid size (image px)' });
    [4, 8, 12, 25, 50].forEach((v) => {
      const o = Dom.el('option', { value: v }, v + ' px');
      if (v === this.ed.grid.step) o.selected = true;
      sel.append(o);
    });
    sel.onchange = () => { this.ed.grid.step = +sel.value; this.ed.render(); };
    return sel;
  }
  gridMoveButton() {
    const b = Dom.el('button', { class: 'icononly' + (this.ed.grid.adjust ? ' active' : ''), title: 'Drag to move the grid · scroll to resize', html: Icons.move + '<span>Move grid</span>' });
    b.onclick = () => { this.ed.grid.adjust = !this.ed.grid.adjust; b.classList.toggle('active', this.ed.grid.adjust); if (this.ed.grid.adjust) Toast.show('Drag to move the grid · scroll to resize'); };
    return b;
  }

  // ---- shortcuts / legend panel (UX-17, shared by both editors) ----
  // The declaration this panel renders — `_shortcutGroups()` — stays on Editor: it is the
  // per-editor binding contract each subclass extends via `super._shortcutGroups()` (§10).

  /** Toolbar toggle for the shortcuts panel. `icononly` — it is a utility/modifier, not a
   *  create-or-file action, so it never carries a visible label (§10 Responsive tool labels).
   *
   *  Also `tb-desktop-only`: a button whose entire subject is keyboard and mouse has nothing to
   *  say on a touch device, and on a phone-width bar it was buying that nothing with width the
   *  real tools needed — pushing them into the "…" menu (NAV-23). `App._fitToolbar` therefore
   *  leaves it out of the bar below the app's 720px breakpoint. The FEATURE is untouched: the
   *  panel, `_shortcutGroups()`, and the `?` binding all remain, so a narrow window on a desktop
   *  that has a keyboard can still reach the list the key it documents actually works on. */
  shortcutsButton() {
    return Dom.el('button', { class: 'icononly tb-desktop-only', title: 'Keyboard & mouse shortcuts (?)',
      onclick: () => this.openShortcuts(), html: Icons.help + '<span>Shortcuts</span>' });
  }

  /** Render the editor's `_shortcutGroups()` into a `Modal` reference dialog — a listing rather
   *  than a prompt, hence the wider `fm-shortcuts` panel. Modal rather than the side `#panel`,
   *  which is owned by the selected shape's detail form: opening the reference must not evict what
   *  the user is editing. Backdrop, Close, and Escape each dismiss it exactly once (the shell owns
   *  all three, including tearing the Escape listener down so it can never outlive the dialog and
   *  swallow the editor's own Escape ladder). Re-entrant-safe: a second open while one is up is a
   *  no-op, which is why the flag is cleared from `onClose` — the one hook every dismissal path
   *  runs through. */
  openShortcuts() {
    if (this._shortcutsOpen) return;
    this._shortcutsOpen = true;
    const body = [];
    this.ed._shortcutGroups().forEach((g) => {
      body.push(Dom.el('h4', {}, g.title));
      const dl = Dom.el('dl', {});
      g.rows.forEach(([keys, what]) => {
        dl.append(Dom.el('dt', {}, this._keyCaps(keys)), Dom.el('dd', {}, what));
      });
      body.push(dl);
    });
    const dlg = Modal.open({
      title: 'Keyboard & mouse shortcuts',
      panelClass: 'fm-shortcuts',
      body,
      actions: [Dom.el('button', { class: 'primary', onclick: () => dlg.close() }, 'Close')],
      onClose: () => { this._shortcutsOpen = false; },
    });
  }

  /** Split a declared key string into `<kbd>` caps around its `+`/`/` separators, so
   *  "Ctrl + Z" renders as two caps joined by a muted `+` rather than one wide cap. A phrase
   *  with no separator (e.g. "Drag a vertex") becomes a single cap.
   *
   *  A separator must have whitespace on BOTH sides, which is what keeps the literal `+` KEY
   *  readable: in "+ / −" the leading `+` has no space before it, so it stays a cap and only the
   *  `/` splits. Declare a chord as "Ctrl + Z", alternatives as "+ / −" — never unspaced. */
  _keyCaps(keys) {
    const out = [];
    keys.split(/\s+([+/])\s+/).forEach((part) => {
      if (part === '+' || part === '/') out.push(Dom.el('span', { class: 'k-sep' }, part));
      else if (part) out.push(Dom.el('kbd', {}, part));
    });
    return out;
  }

  // ---- the shared edit-menu toolbar (both editors) ----
  /** The edit-menu toolbar shared by both editors. This assembles the common bones —
   *  the mode-toggle button, the undo + right-angle/grid factory row (edit mode), and the
   *  Save button + dirty badge — and each subclass supplies only its mode-specific buttons
   *  through the hooks on Editor. Rebuilt on every mode/sub-mode change (App.setToolbar). */
  build() {
    const ed = this.ed, tb = [];
    if (ed.editing()) {
      const draw = ed._editButtons();
      if (draw.length) tb.push(...draw, this.divider());
      tb.push(this.undoButton(), this.divider(), ...ed._alignTools());
      const devices = ed._deviceTools();
      if (devices.length) tb.push(this.divider(), ...devices);
      const extra = ed._editExtras();
      if (extra.length) tb.push(this.divider(), ...extra);
    } else {
      tb.push(...ed._viewButtons());
    }
    if (ed._showsSave()) tb.push(this.divider(), ed._saveButton(), ed._badgeEl());
    // Shortcuts sit in BOTH modes for BOTH editors (the view-mode keys — zoom, fit, Esc — are
    // just as undiscoverable as the editing ones), immediately left of the mode toggle. Skipped in
    // the non-interactive embed, which ignores keydown entirely (App._bindGlobal), so advertising
    // shortcuts there would promise keys that do nothing. Appended unconditionally otherwise: the
    // phone-width omission is `tb-desktop-only`, applied by App._fitToolbar at render time rather
    // than baked in here, so a breakpoint crossing needs no toolbar rebuild (NAV-23).
    if (ed.app.interactive) {
      if (tb.length) tb.push(this.divider());
      tb.push(this.shortcutsButton());
    }
    // The mode toggle is always the LAST element so its right edge stays anchored against
    // the toolbar's right edge (the facility picker): entering edit mode prepends buttons to
    // its left instead of shoving it around, so Done lands on the exact spot Edit occupied
    // (NAV-1). A leading divider only when something precedes it.
    if (tb.length) tb.push(this.divider());
    tb.push(this._modeButton());
    return tb;
  }

  /** The mode-toggle button: an edit ⇄ done switch shared by both editors. `Icons.edit`
   *  + label (`Edit` while viewing, `Done` while editing), `.active` in edit mode; routes
   *  through `Editor._requestModeSwitch` (the unsaved-work gate), which dispatches `_switchMode`.
   *
   *  **The `Edit` face is `tb-desktop-only`; the `Done` face never is (MOBILE-1).** Editing is
   *  desktop/mouse-only by design — there is no touch equivalent for drawing polygons or dragging
   *  vertices — so on a phone-width bar `App._fitToolbar` leaves the *entry* out entirely, and
   *  since this is the sole caller of `_requestModeSwitch` that closes every door into edit mode.
   *  The asymmetry is what makes it safe: an editor that is ALREADY editing (a desktop session
   *  that entered siteplan edit and then resized narrow — `app.siteEdit` is not reset per show)
   *  keeps its `Done`, so suppressing the toggle can never strand the app in a mode it offers no
   *  way out of. Same input-device question as `shortcutsButton`, and made once here so both
   *  editors stay in lockstep. */
  _modeButton() {
    const editing = this.ed.editing();
    const b = Dom.el('button', { class: 'mode' + (editing ? ' active' : ' tb-desktop-only'),
      title: editing ? 'Exit edit mode' : 'Enter edit mode',
      html: Icons.edit + '<span>' + (editing ? 'Done' : 'Edit') + '</span>' });
    b.onclick = () => this.ed._requestModeSwitch(editing ? 'view' : 'edit');
    return b;
  }
}
