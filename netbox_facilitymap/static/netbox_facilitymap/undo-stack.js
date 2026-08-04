'use strict';
/* undo-stack.js — UndoStack: a bounded LIFO of opaque snapshot objects.

   Each editor owns one (see Editor). It knows nothing about what a snapshot
   contains — the editor builds a snapshot (a JSON-serializable clone of its
   mutable data) before a mutation and pushes it here; Ctrl+Z pops the most recent
   and hands it back for the editor to restore (which re-derives the dirty flags from
   the store baselines rather than reading them off the snapshot). The only policy this
   class enforces is a depth cap so a long editing session can't grow the history
   unbounded (oldest entries fall off the bottom). */

class UndoStack {
  constructor(max = 50) {
    this.max = max;
    this._items = [];
  }

  push(snap) {
    this._items.push(snap);
    if (this._items.length > this.max) this._items.shift();
  }

  /** Remove and return the most recent snapshot, or null when empty. */
  pop() { return this._items.length ? this._items.pop() : null; }

  /** The most recent snapshot without removing it, or null when empty. Callers use its
   *  IDENTITY as a token for "the top is still the operation I captured" — the post-delete
   *  Undo toast (Editor._deleteToast) pins it so a later mutation can't make its button revert
   *  the wrong thing. Identity survives the depth cap (which drops from the bottom), where a
   *  size comparison would not. */
  peek() { return this._items.length ? this._items[this._items.length - 1] : null; }

  clear() { this._items.length = 0; }

  get size() { return this._items.length; }
}
