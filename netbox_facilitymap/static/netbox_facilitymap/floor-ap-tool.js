'use strict';
/* floor-ap-tool.js — FloorApTool: the "Add access point" tool (DEV-1). Creates a real NetBox
   Device and drops a marker for it in one gesture.

   The AP is NOT a new placement kind: it commits an ordinary `kind:'device'` placement, so marker
   drawing, dragging, the label engine, the placement panel and the wayfinding finder all handle it
   unchanged — which is why this owns only the create flow (arm → resolve room → modal → commit)
   and hands the result straight to FloorPlacements.

   Holds an editor back-ref (`this.ed`), the ImportAlign shape. The tool is floor-only by nature (it
   drops a Device in a *room*, and rooms only exist on floors), so it lives here rather than on the
   shared Editor base — not the §10 edit-menu-lockstep drift it might otherwise look like. */

const AP_DEVICE_TYPE_KEY = 'facilitymap:apDeviceType';   // last-used AP device type, {id,name} (UX-1)

const AP_NAME_SUGGEST_DEBOUNCE_MS = 250;   // asset-tag input -> re-derived device-name suggestion delay

class FloorApTool {
  constructor(editor) { this.ed = editor; }

  /** Arm the access-point tool: the next map click inside a room creates an AP there (the base
   *  draft state machine finishes an `ap` draft on its first click, exactly as a note does —
   *  which is also what keeps pan gestures and placement clicks from fighting, for free). */
  begin() {
    this.ed.beginDraw('Click inside a room to add an access point · Esc to cancel', 'ap');
  }

  /** Close the one-point AP draft: resolve the room under the click, create the Device in NetBox,
   *  then commit a device placement at the clicked point.
   *
   *  Nothing is written to the store until the create has actually succeeded — a dead click, a
   *  cancelled modal or a failed POST must leave the document untouched AND unflagged, since a
   *  stray dirty flip falsely fires the unsaved-work nav guard (§10). A click that lands nowhere
   *  useful re-arms the tool rather than dying silently: the user meant to place an AP, and the
   *  miss is theirs to correct. */
  async finish() {
    const [x, y] = this.ed.draft.points[0];
    this.ed.draft = null;
    this.ed.render();
    const room = this.ed.data().rooms.find(r => Geom.pointInPoly(x, y, r.polygon));
    if (!room) { Toast.show('Click inside a room to place an access point.', true); return this.begin(); }
    if (!room.location) {
      Toast.show('That room isn’t bound to a NetBox Location yet — bind it first, then place the access point.', true);
      return this.begin();
    }
    let name = '';
    try {
      name = (await this.ed.netbox.suggestDeviceName(room.location.id)).name;
    } catch (e) {
      Toast.show('NetBox: ' + e.message, true); return;
    }
    // The modal owns the create itself, so a rejected name/asset tag can be corrected in place
    // rather than closing the dialog and losing what was typed. It resolves the created Device,
    // or null when the user backed out.
    const device = await this._apModal(name, room);
    if (!device) return;
    // Force-repull the Location's inventory so _cacheItem resolves the new Device and the marker
    // renders with its real role glyph. Pulling (rather than hand-pushing into store.rackCache)
    // keeps the cache the server's answer, not our guess at it.
    //
    // A failed repull does NOT abort the placement: the Device exists in NetBox by now, so
    // dropping it here would orphan a real record and throw away the gesture. Without the pull
    // _cacheItem just finds nothing and the marker draws as stale — which the placement UI already
    // handles — so committing and warning degrades far better than silently placing nothing.
    let warned = false;
    try {
      await this.ed.store.ensureRacks(this.ed.netbox, room.location.id, true);
    } catch (e) {
      warned = true;
      Toast.show('Created ' + device.name + ', but its details could not be loaded: ' + e.message
        + '. Refresh the room to update the marker.', true);
    }
    this.ed.snapshot();
    const [cx, cy] = Geom.clampToPoly(x, y, room.polygon);
    const p = { id: device.id, kind: 'device', room: room.id, loc: room.location.id,
      x: +cx.toFixed(5), y: +cy.toFixed(5), label: device.name, uid: Util.uid() };
    this.ed.store.placementData(this.ed.building.dir, this.ed.floor.id).placements.push(p);
    this.ed.selectedPlacement = p;   // ready to drag / rotate / resize immediately
    this.ed.markPlacementsDirty(); this.ed.render();
    // The placement panel, not the room's rack list: the user placed one specific device.
    this.ed.placements.openPlacementPanel(p, room);
    // Toast is a single element, so don't clobber the repull warning with the success line.
    if (!warned) Toast.show('Created ' + device.name + '. Save to keep it on the map.');
  }

  /** The AP create dialog (device type / optional asset tag / name), resolving the created Device
   *  or null if the user backed out. Too rich for `Modal.confirm` — it is a form that submits and
   *  can fail — so it takes the `Modal.open` shell and keeps its own body and footer. Backdrop,
   *  Escape, and Cancel all resolve `null` through the shell's single `onClose`.
   *
   *  It drives the POST itself and stays open on a 400 — a duplicate name or asset tag is a
   *  correctable mistake, and the server is the only thing that knows about the clash, so bouncing
   *  the user out of the dialog would throw away the rest of what they typed to fix one field. The
   *  Device already exists in NetBox once this resolves; the *placement* is what's still unsaved.
   *
   *  The asset tag sits **above** the name because that is the order it's really filled in: tag
   *  first, then the name settles from it. When the operator's template uses `{asset_tag}` (DEV-6)
   *  editing the tag re-asks the server for the suggestion, so the name is always one the server's
   *  `-NN` counter and free-name probe have actually vetted — see `_wireApNameFromTag`. */
  _apModal(suggestedName, room) {
    return new Promise((resolve) => {
      // Settle first, then close: the shell's onClose resolves `null` as the fallback, and a
      // promise already settled with the created Device ignores it.
      const finish = (device) => { resolve(device); dlg.close(); };
      const stored = this._loadApDeviceType();   // last-used device type, pre-filled below (UX-1)
      let dtype = stored;
      const combo = new Combo({
        value: stored,
        placeholder: 'Search device types…',
        load: (q) => this.ed.netbox.deviceTypes(q).then((r) => {
          const opts = r.device_types.map(t => ({ id: t.id, name: t.manufacturer + ' ' + t.model }));
          // The unfiltered focus-open load (q === '', already fired below via combo.input.focus())
          // doubles as a cheap confirmation of the pre-filled last-used type: if a stale preference
          // (its device type was deleted in NetBox since last use) isn't in it, drop it now rather
          // than let Create fail on a dead id. `dtype === stored` means this only ever fires for the
          // original pre-fill — it self-disarms the moment the user picks anything.
          if (q === '' && stored && dtype === stored && !opts.some(o => o.id === stored.id)) {
            dtype = null;
            combo.reset();
            this._clearApDeviceType();
          }
          return opts;
        }),
        onPick: (opt) => { dtype = opt; },
      });
      const nameInput = Dom.el('input', { class: 'fm-text', value: suggestedName });
      const tagInput = Dom.el('input', { class: 'fm-text', placeholder: 'Optional' });
      this._wireApNameFromTag(tagInput, nameInput, room);
      const err = Dom.el('div', { class: 'fm-modal-error' });
      err.style.display = 'none';
      const showErr = (msg) => { err.textContent = msg; err.style.display = ''; };
      const create = Dom.el('button', { class: 'primary' }, 'Create access point');
      create.onclick = async () => {
        if (!dtype) return showErr('Pick a device type.');
        if (!nameInput.value.trim()) return showErr('A device name is required.');
        create.disabled = true;
        try {
          const device = await this.ed.netbox.createDevice({
            location: room.location.id, device_type: dtype.id,
            name: nameInput.value.trim(), asset_tag: tagInput.value.trim(),
          });
          this._saveApDeviceType(dtype);
          finish(device);
        } catch (e) {
          showErr(e.message); create.disabled = false;
        }
      };
      const field = (label, control) => Dom.el('div', { class: 'field' },
        [Dom.el('label', {}, label), control]);
      const dlg = Modal.open({
        title: 'Add access point',
        body: [
          Dom.el('p', {}, 'Creates a new unracked device in ' + room.location.name
            + ' and places it where you clicked.'),
          field('Device type', combo.el),
          field('Asset tag', tagInput),
          field('Name', nameInput),
          err,
        ],
        actions: [Dom.el('button', { onclick: () => finish(null) }, 'Cancel'), create],
        onClose: () => resolve(null),
      });
      // Focus the device type, not the prefilled name: it's the field most likely to need
      // changing, and focusing the combo opens its list, so the catalogue is discoverable by eye
      // (this also runs the pre-fill's staleness check above, via the unfiltered focus-open load).
      combo.input.focus();
    });
  }

  /** The persisted last-used AP device type `{id,name}` (UX-1), or `null` if never set, corrupt,
   *  or storage is disabled. Pre-fills `_apModal`'s Combo so a repeat placement doesn't require
   *  searching again. */
  _loadApDeviceType() {
    try {
      const raw = localStorage.getItem(AP_DEVICE_TYPE_KEY);
      const v = raw ? JSON.parse(raw) : null;
      return (v && v.id && v.name) ? v : null;
    } catch (e) { return null; }
  }
  _saveApDeviceType(dtype) {
    try { localStorage.setItem(AP_DEVICE_TYPE_KEY, JSON.stringify({ id: dtype.id, name: dtype.name })); }
    catch (e) { console.warn('ap device type: could not persist preference', e); }
  }
  _clearApDeviceType() {
    try { localStorage.removeItem(AP_DEVICE_TYPE_KEY); } catch (e) {}
  }

  /** Keep `_apModal`'s name field derived from its asset-tag field, for a template that uses
   *  `{asset_tag}` (DEV-6). A no-op for any other template — the overwhelmingly common case pays
   *  nothing and issues exactly the one request it always did.
   *
   *  The re-derive asks the *server* rather than substituting here, because the suggestion is more
   *  than a string swap: the server appends the scoped `-NN` counter and probes the site for a free
   *  name, and both must see the real tag or they vet a name nobody saves.
   *
   *  Two things it must not do. It must not fight the user: once the name has been hand-edited it
   *  stops deriving for the life of the dialog, so a deliberate name is never clobbered by a later
   *  keystroke in the tag field. And it must not let a slow reply overwrite a newer one — replies
   *  can land out of order, so each is stamped and a stale one is dropped. A failed re-derive keeps
   *  the last good name and warns to the console rather than toasting per keystroke: the name is
   *  only a suggestion, and a genuine problem still surfaces loudly on Create. */
  _wireApNameFromTag(tagInput, nameInput, room) {
    if (!this.ed.app.apNameTemplate.includes('{asset_tag}')) return;
    let edited = false;
    nameInput.addEventListener('input', () => { edited = true; });
    let timer = null;
    let seq = 0;
    tagInput.addEventListener('input', () => {
      if (edited) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const mine = ++seq;
        try {
          const r = await this.ed.netbox.suggestDeviceName(room.location.id, tagInput.value);
          if (mine === seq && !edited) nameInput.value = r.name;
        } catch (e) {
          console.warn('Could not re-derive the access point name:', e.message);
        }
      }, AP_NAME_SUGGEST_DEBOUNCE_MS);
    });
  }
}
