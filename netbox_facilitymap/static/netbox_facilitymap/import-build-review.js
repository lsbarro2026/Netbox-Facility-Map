'use strict';
/* import-build-review.js — ImportBuildReview: the one dialog the import wizard shows before it
   rebuilds a facility that already holds drawn rooms (IMPORT-39).

   It replaces a chain of up to four native `confirm()`s — orphaned rooms, region-split
   reprojections, desynced floors, and the opt-in siteplan hotspot re-fit — fired one after another
   at the single most consequential action in the flow. Four sequential prompts read as four
   unrelated interruptions, and none of them could show the *whole* picture before the user had to
   answer the first. This shows every finding at once, in sections, with one Rebuild and one Cancel:

     rooms removed    orphaned floors — ids that won't survive, so their rooms go
     rooms moved      whole→region splits (FLOOR-5) — remapped into the region each sits in
     re-check         desynced floors — kept, but the drawing under them changed
     re-fit           the one repairable desync (IMPORT-11), as an opt-in checkbox, default OFF

   `ImportBuildReview.open(findings)` resolves the plan `_afterBuild` consumes
   (`{orphaned, reprojections, refit}`) when the user commits, or **null** when they back out —
   the same two signals `_confirmBuild` has always returned, so the build path around it is
   unchanged. It only ever *presents*: every finding is computed by `ImportDiff`, which stays a pure
   reader.

   Built on the shared `Modal` shell (`lib.js`), so it dismisses exactly like every other dialog in
   the app: backdrop, Cancel, or Esc — each exactly once. It is the sibling of `FacilityChangeModal`
   (a transaction dialog too rich for `Modal.confirm`), loaded in the same lazy import bundle.

   Unlike the wizard's other collaborators it holds **no wizard back-ref**: it needs nothing from the
   flow beyond the findings handed to it, and keeping it a pure presenter over its arguments is what
   makes the room-safety copy reviewable in one place. */

class ImportBuildReview {
  /** Show the review for `findings` and resolve the build plan, or null if the user backed out.
   *  `orphaned`/`reprojections`/`desynced` are `ImportDiff`'s three reads (the orphan list already
   *  filtered of reprojected sources by the caller); `refit` is the candidate siteplan re-fit plan
   *  when the desync is the repairable aspect-only case, else null. */
  static open(findings) {
    return new Promise((resolve) => { new ImportBuildReview(findings, resolve)._mount(); });
  }

  constructor({ orphaned = [], reprojections = [], desynced = [], refit = null }, resolve) {
    this.orphaned = orphaned;
    this.reprojections = reprojections;
    this.desynced = desynced;
    this.refit = refit;
    this._resolve = resolve;
    this._plan = null;         // set only by Rebuild; every other dismissal path resolves null
    this._refitBox = null;     // the opt-in re-fit checkbox, when this rebuild can offer one
  }

  /** Take the shell's overlay, dismissal and resolve-once, and keep only what is this dialog's: the
   *  sectioned body and resolving with the plan the user committed to (null if they never did). */
  _mount() {
    this._dlg = Modal.open({
      title: 'Review this rebuild',
      panelClass: 'fm-build-review',
      body: this._body(),
      actions: this._actions(),
      onClose: () => this._resolve(this._plan),
    });
  }

  /** Commit: freeze the plan `_afterBuild` needs, then dismiss. The re-fit rides only when the box
   *  is ticked — the caller passes the *candidate* plan, the user decides whether it applies. */
  _commit() {
    this._plan = {
      orphaned: this.orphaned,
      reprojections: this.reprojections,
      refit: (this._refitBox && this._refitBox.checked) ? this.refit : null,
    };
    this._dlg.close();
  }

  // ---- body ----

  /** The lead paragraph plus one section per non-empty finding group, in the order they matter:
   *  what is lost, what moves, what merely needs re-checking, and finally the one thing the wizard
   *  can offer to repair. A group with no findings renders nothing at all. */
  _body() {
    const { _row: row, _count: count, _moveText: moveText, _heading: heading } = ImportBuildReview;
    const nodes = [Dom.el('p', {}, 'This rebuild affects rooms and hotspots you have already drawn. '
      + 'Here is everything it does before anything is written.')];

    if (this.orphaned.length)
      nodes.push(...this._section(
        heading(this.orphaned.length, 'floor loses its rooms', 'floors lose their rooms'),
        'These floors’ ids change with this rebuild, so the rooms drawn on them are removed.',
        this.orphaned.map(o => row(o.label, count(o.count, 'room'))),
        true));

    if (this.reprojections.length)
      nodes.push(...this._section(
        heading(this.reprojections.length, 'floor is split into regions',
          'floors are split into regions'),
        'Each room moves into the region it sits in and has its coordinates remapped. A room outside '
        + 'every region is dropped.',
        this.reprojections.map(r => row(r.label, moveText(r)))));

    if (this.desynced.length)
      nodes.push(...this._section(
        heading(this.desynced.length, 'drawing to re-check afterwards',
          'drawings to re-check afterwards'),
        'The drawing under these changes (a different orientation or shape, or a replaced plan), so '
        + 'what is already drawn on them may no longer line up. Nothing is deleted — you can move '
        + 'them back into place.',
        this.desynced.map(o => row(o.label, count(o.count, o.unit)))));

    if (this.refit) nodes.push(this._refitRow());
    return nodes;
  }

  /** One `<h4>` + lead-in + row list. `warn` colours the lead-in for the only group whose findings
   *  are irreversible, so the destructive section is distinguishable at a glance. */
  _section(heading, lead, rows, warn = false) {
    return [
      Dom.el('h4', {}, heading),
      Dom.el('p', { class: warn ? 'imp-bind-warn' : 'hint' }, lead),
      Dom.el('div', { class: 'fm-br-list' }, rows),
    ];
  }

  /** A floor's name over what happens to it — the same two-line shape the facility-change dialog's
   *  rows use, so the two read as one family. */
  static _row(label, detail) {
    return Dom.el('div', { class: 'fm-br-row' }, [
      Dom.el('span', { class: 'nm' }, label),
      Dom.el('span', { class: 'sl' }, detail),
    ]);
  }

  static _count(n, unit) { return n + ' ' + (n === 1 ? unit : unit + 's'); }

  /** A section heading that counts its findings — "1 floor loses its rooms" / "3 floors lose their
   *  rooms". Both wordings are spelled out rather than suffixed, since the verb inflects too. */
  static _heading(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  static _moveText(r) {
    const parts = [ImportBuildReview._count(r.moved, 'room') + ' moved'];
    if (r.dropped) parts.push(r.dropped + ' outside every region, dropped');
    return parts.join(', ');
  }

  /** The opt-in siteplan re-fit (IMPORT-11). Deliberately **unchecked** by default: the fit assumes
   *  the new drawing covers the same area, and a wrong automatic transform is worse than a skew the
   *  user can see and correct. Undoable from the completion toast either way. */
  _refitRow() {
    this._refitBox = Dom.el('input', { type: 'checkbox' });
    const n = (this.desynced.find(o => o.refit) || {}).count || 0;
    return Dom.el('div', { class: 'fm-br-check' }, [
      Dom.el('label', {}, [this._refitBox,
        Dom.el('span', {}, 'Re-fit the ' + ImportBuildReview._count(n, 'siteplan hotspot')
          + ' to the new plan’s proportions')]),
      Dom.el('p', { class: 'hint' }, 'The new drawing is a different shape, so the hotspots stretch. '
        + 'Re-fitting scales and centres them to match — right if the new plan covers the same area, '
        + 'wrong if it shows a different extent. You can undo it right after the rebuild.'),
    ]);
  }

  // ---- footer ----

  /** Does committing this rebuild actually *lose* rooms? True for an orphaned floor (its rooms are
   *  removed outright) and for a split that strands rooms outside every region; a desync loses
   *  nothing (the rooms stay, they just want re-checking) and a clean split only moves them. This is
   *  the whole input to the emphasis rule below, so it is named rather than inlined. */
  static _destructive(orphaned, reprojections) {
    return !!orphaned.length || reprojections.some(r => r.dropped);
  }

  /** Cancel left, Rebuild right, exactly one of them weighted — the `Modal` button convention, whose
   *  emphasis depends on whether the affirmative is irreversible. So the weight sits on the safe
   *  exit exactly when this rebuild discards rooms. */
  _actions() {
    const destructive = ImportBuildReview._destructive(this.orphaned, this.reprojections);
    return [
      Dom.el('button', { class: destructive ? 'primary' : '', onclick: () => this._dlg.close() },
        'Cancel'),
      Dom.el('button', { class: destructive ? 'danger' : 'primary', onclick: () => this._commit() },
        'Rebuild'),
    ];
  }
}
