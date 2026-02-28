/**
 * Reactive state store for the dashboard.
 * DashState extends EventTarget — panels subscribe via addEventListener('change', ...).
 * Each set() dispatches a CustomEvent with { key, value, old }.
 */

export class DashState extends EventTarget {
  constructor(initial = {}) {
    super();
    this._state = {
      bridgeConnected: false,
      sessions: [],
      activeSessionId: null,
      commandFeed: [],
      feedFilters: { type: null, session: null, status: null, source: null, text: '', timeRange: null },
      snapshots: [],
      activeSnapshotIndex: -1,
      diffMode: false,
      diffSlotA: null,
      diffSlotB: null,
      reasoningTraces: [],
      activeTraceIndex: -1,
      ...initial,
    };
  }

  get(key) {
    return this._state[key];
  }

  set(key, value) {
    const old = this._state[key];
    this._state[key] = value;
    this.dispatchEvent(new CustomEvent('change', { detail: { key, value, old } }));
  }

  /** Push an item onto an array key, enforcing a max ring-buffer length. */
  push(key, item, maxLen = 50) {
    const arr = [...(this._state[key] || []), item];
    if (arr.length > maxLen) arr.splice(0, arr.length - maxLen);
    this.set(key, arr);
  }

  /** Update an item in an array key matching a predicate. */
  updateItem(key, predicate, updater) {
    const arr = this._state[key];
    if (!Array.isArray(arr)) return;
    const idx = arr.findIndex(predicate);
    if (idx < 0) return;
    const copy = [...arr];
    copy[idx] = updater(copy[idx]);
    this.set(key, copy);
  }

  /** Merge partial values into an object key (e.g. feedFilters). */
  merge(key, partial) {
    const current = this._state[key] || {};
    this.set(key, { ...current, ...partial });
  }

  /** Get entire state snapshot (read-only). */
  snapshot() {
    return { ...this._state };
  }
}
