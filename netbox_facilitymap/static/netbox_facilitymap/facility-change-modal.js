'use strict';
/* facility-change-modal.js — FacilityChangeModal: the two-stage dialog that owns a *change to the
   install-wide facility grouping* (FACILITY-IDENTITY-DESIGN §4.4, Phase 3).

   It replaces the blanket `window.confirm` the wizard used to show ("your data may disappear"),
   which could neither say what would move nor do anything about it. Since Phase 1 an explicitly
   *assigned* Site is immune to a grouping change, so the real blast radius is computable — and this
   dialog shows it:

     stage 1  preview   — every Site whose facility would change (before → after, with the floors
                          and rooms riding on it) + the facility keys that would be left holding
                          stranded data. Cancel, or commit the change.
     stage 2  reassign  — shown only when the change did strand something: each stranded key with a
                          target picker (preselected to the server's suggestion) that re-keys its
                          blobs and moves its rendered images in place, without a trip to the
                          Settings page.

   `FacilityChangeModal.open(app, next)` resolves **true** once the grouping is `next` (the POST
   succeeded and any reassignment stage was dismissed), **false** if the operator backed out with
   nothing written. The caller therefore never POSTs the grouping itself — the whole transaction,
   including its recovery, belongs to the dialog.

   Built on the shared `Modal` shell (`lib.js`), so it dismisses exactly like every other dialog in
   the app: backdrop, Cancel, or Esc — each exactly once. It stays its own class rather than folding
   into `Modal.confirm` because it is a two-stage transaction, not a prompt. A wizard collaborator
   like ImportUploader/ImportPreview, and loaded in the same lazy import bundle. */

class FacilityChangeModal {
  /** Run the whole grouping change against `app`, targeting grouping `next`. Resolves true when the
   *  grouping was changed (the caller then updates `app.grouping` and moves on), false when it was
   *  not — the only two outcomes, so a caller never has to inspect the dialog's internals. */
  static open(app, next) {
    return new Promise((resolve) => { new FacilityChangeModal(app, next, resolve)._mount(); });
  }

  constructor(app, next, resolve) {
    this.app = app;
    this.next = next;              // the grouping being switched TO
    this._resolve = resolve;
    this._changed = false;         // did the grouping POST actually land?
    this._preview = null;          // the stage-1 payload (also feeds stage 2's target choices)
  }

  // ---- lifecycle ----

  /** Take the shared `Modal` shell — overlay, backdrop/Escape dismissal, resolve-once — and keep
   *  only what is genuinely this dialog's: the staged body, and resolving with whether the grouping
   *  actually changed rather than with how it was dismissed. The shell's live `title`/`actions`
   *  nodes are what let `_render` restage the dialog in place. */
  _mount() {
    this._body = Dom.el('div', { class: 'fm-fc-body' });
    this._dlg = Modal.open({
      title: 'Change how facilities are identified?',
      panelClass: 'fm-facility-change',
      body: [this._body],
      onClose: () => this._resolve(this._changed),
    });
    this._title = this._dlg.title;
    this._actions = this._dlg.actions;
    this._stagePreview();
  }

  /** Dismiss, resolving with whether the grouping ended up changed. Idempotent (the shell's
   *  `close` is) — backdrop, Escape, and every button route here. */
  _close() { this._dlg.close(); }

  /** Swap the dialog's body for `nodes` and its footer for `buttons` — the one place the two
   *  stages (and the loading/error states between them) render through. */
  _render(nodes, buttons) {
    this._body.innerHTML = '';
    this._actions.innerHTML = '';
    this._body.append(...nodes);
    this._actions.append(...buttons);
  }

  static _groupingName(g) {
    return g === 'region' ? 'Region'
      : g === 'location' ? 'Building / Location' : 'Site Group';
  }

  /** "N floors · M rooms", or "no map data yet" — a Site that moves but carries nothing is the
   *  reassuring case, and saying so is more use than rendering two zeroes. */
  static _weight(entry) {
    if (!entry.floors && !entry.rooms) return 'no map data yet';
    const part = (n, one, many) => n + ' ' + (n === 1 ? one : many);
    return part(entry.floors, 'floor', 'floors') + ' · ' + part(entry.rooms, 'room', 'rooms');
  }

  // ---- stage 1: preview ----

  async _stagePreview() {
    this._render([Dom.el('p', { class: 'imp-progress' }, 'Working out what would change…')],
      [Dom.el('button', { onclick: () => this._close() }, 'Cancel')]);
    try {
      this._preview = await this.app.netbox.groupingPreview(this.next);
    } catch (e) {
      // Degrade gracefully rather than either blocking the change or waving it through silently:
      // the operator is told the preview is unavailable and can still proceed deliberately.
      return this._render([
        Dom.el('p', {}, 'Could not work out what this change would move: ' + e.message),
        Dom.el('p', { class: 'hint' },
          'You can still change the grouping, but nothing can be previewed first. Any map data left '
          + 'unreachable afterwards is recoverable from the Settings page.'),
      ], [
        Dom.el('button', { onclick: () => this._close() }, 'Cancel'),
        Dom.el('button', { class: 'primary', onclick: () => this._commit() }, 'Change anyway'),
      ]);
    }
    this._render(this._previewBody(), [
      Dom.el('button', { onclick: () => this._close() }, 'Cancel'),
      Dom.el('button', { class: 'primary', onclick: () => this._commit() },
        'Change to ' + FacilityChangeModal._groupingName(this.next)),
    ]);
  }

  _previewBody() {
    const { moves, orphans, assigned } = this._preview;
    const from = FacilityChangeModal._groupingName(this._preview.grouping.from);
    const to = FacilityChangeModal._groupingName(this.next);
    const nodes = [Dom.el('p', {}, 'A facility would be identified by a ' + to
      + ' instead of a ' + from + '. Here is exactly what that moves.')];

    if (!moves.length) {
      nodes.push(Dom.el('p', { class: 'imp-bind-ok' },
        '✓ No site changes facility — nothing moves.'));
    } else {
      nodes.push(Dom.el('h4', {}, moves.length === 1 ? '1 site changes facility'
        : moves.length + ' sites change facility'));
      const rows = moves.map(m => Dom.el('div', { class: 'fm-fc-row' }, [
        Dom.el('div', { class: 'fm-fc-site' }, [
          Dom.el('span', { class: 'nm' }, m.name),
          Dom.el('span', { class: 'sl' }, FacilityChangeModal._weight(m)),
        ]),
        Dom.el('div', { class: 'fm-fc-move' }, [
          Dom.el('span', { class: 'fm-fc-was' }, m.from_name),
          Dom.el('span', { class: 'fm-fc-arrow' }, '→'),
          Dom.el('span', { class: 'fm-fc-now' }, m.to_name),
        ]),
      ]));
      nodes.push(Dom.el('div', { class: 'fm-fc-list' }, rows));
    }

    // The Phase-1/2 payoff, stated where it pays off: assigned sites simply don't move, so an
    // install that locked its sites in the wizard sees an empty diff and knows why.
    if (assigned)
      nodes.push(Dom.el('p', { class: 'hint' }, assigned === 1
        ? '1 site has a locked facility and is unaffected by this change.'
        : assigned + ' sites have a locked facility and are unaffected by this change.'));

    if (orphans.length)
      nodes.push(Dom.el('p', { class: 'imp-bind-warn' }, orphans.every(o => o.already)
        ? '⚠ Map data is already stranded under ' + orphans.length + ' facility key'
          + (orphans.length === 1 ? '' : 's') + '. You can reassign it after this change.'
        : '⚠ Afterwards, map data under ' + orphans.length + ' facility key'
          + (orphans.length === 1 ? '' : 's') + ' would have no site pointing at it. Nothing is '
          + 'deleted — you can reassign it on the next screen.'));
    return nodes;
  }

  // ---- the change itself ----

  /** POST the grouping, then either hand off to the reassign stage or finish. `confirm` is always
   *  true here: this dialog *is* the acknowledgement the server's 409 interlock asks for. */
  async _commit() {
    this._render([Dom.el('p', { class: 'imp-progress' }, 'Changing the facility grouping…')], []);
    try {
      await this.app.netbox.setGrouping(this.next, true);
    } catch (e) {
      return this._render([Dom.el('p', { class: 'fm-modal-error' },
        'Could not change the grouping: ' + e.message)],
      [Dom.el('button', { class: 'primary', onclick: () => this._close() }, 'Close')]);
    }
    this._changed = true;
    const orphans = (this._preview && this._preview.orphans) || [];
    if (!orphans.length) return this._close();
    this._stageReassign(orphans);
  }

  // ---- stage 2: inline reassignment ----

  /** One row per stranded facility key: what it holds, where to send it, and a button that performs
   *  the same re-key the Settings panel does. Rows resolve independently — one failure (a collision
   *  with the target's own data) leaves the others usable — and the dialog stays open until the
   *  operator dismisses it, since choosing to leave data stranded is legitimate. */
  _stageReassign(orphans) {
    this._title.textContent = 'Reassign map data with no site';
    const rows = orphans.map(o => this._orphanRow(o));
    this._render([
      Dom.el('p', {}, 'The grouping changed. This map data is stored under a facility no site '
        + 'points at any more, so it will not appear on the map until it is moved. Nothing has '
        + 'been deleted.'),
      Dom.el('div', { class: 'fm-fc-list' }, rows),
      Dom.el('p', { class: 'hint' },
        'You can also do this later from the Settings page — it is the same operation.'),
    ], [Dom.el('button', { class: 'primary', onclick: () => this._close() }, 'Done')]);
  }

  _orphanRow(orphan) {
    const status = Dom.el('div', { class: 'fm-fc-status' });
    return Dom.el('div', { class: 'fm-fc-row' }, [
      Dom.el('div', { class: 'fm-fc-site' }, [
        Dom.el('span', { class: 'nm' }, orphan.name),
        Dom.el('span', { class: 'sl' }, orphan.kinds.join(', ') || 'map data'),
      ]),
      this._orphanControl(orphan, status),
      status,
    ]);
  }

  /** The target picker + Move button for one stranded key, or a plain note when there is nowhere to
   *  move it (a single-facility install that stranded its only key — the honest state, rather than
   *  an empty picker that fails on submit). */
  _orphanControl(orphan, status) {
    const choices = this._preview.choices || [];
    if (!choices.length)
      return Dom.el('div', { class: 'fm-fc-move hint' }, 'No other facility to move it to.');

    const select = Dom.el('select', {});
    for (const c of choices) {
      const opt = Dom.el('option', { value: c.slug }, c.name);
      if (c.slug === orphan.suggested) opt.selected = true;
      select.append(opt);
    }
    const go = Dom.el('button', { onclick: async () => {
      const target = select.options[select.selectedIndex].text;
      go.disabled = select.disabled = true;
      status.className = 'fm-fc-status';
      status.textContent = 'Moving…';
      try {
        await this.app.netbox.reassignFacility(orphan.facility, select.value);
      } catch (e) {
        // Re-armed, not dismissed: a collision with the target's own data is fixed by picking a
        // different target, so the row must stay usable.
        go.disabled = select.disabled = false;
        status.className = 'fm-fc-status fm-modal-error';
        status.textContent = e.message;
        return;
      }
      status.className = 'fm-fc-status imp-bind-ok';
      status.textContent = '✓ Moved to ' + target;
    } }, 'Move');
    return Dom.el('div', { class: 'fm-fc-move' }, [select, go]);
  }
}
