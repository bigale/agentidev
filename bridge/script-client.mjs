/**
 * Script Client SDK for Bridge Server
 *
 * Lightweight WebSocket client for automation scripts.
 * Scripts register, report progress, and can be paused/resumed/cancelled
 * from the Chrome extension UI.
 *
 * Usage:
 *   import { ScriptClient } from './script-client.mjs';
 *
 *   const client = new ScriptClient('my_scraper', {
 *     totalSteps: 100,
 *     checkpoints: ['race_start', 'after_navigate'],
 *   });
 *   await client.connect();
 *
 *   for (let i = 0; i < items.length; i++) {
 *     await client.checkpoint('loop_start', { step: i, total: items.length });
 *     await client.progress(i + 1, items.length, `Processing item ${i + 1}`);
 *     // ... do work ...
 *     await client.sleep(2000);  // interruptible sleep
 *   }
 *
 *   await client.complete({ itemsProcessed: items.length });
 */

import WebSocket from 'ws';

const DEFAULT_PORT = 9876;

let _msgCounter = 0;

function buildMessage(type, payload) {
  return {
    id: `script_${Date.now()}_${++_msgCounter}`,
    type,
    source: 'script',
    timestamp: Date.now(),
    payload,
  };
}

export class ScriptClient {
  /**
   * @param {string} name - Script name (shown in UI)
   * @param {object} [options]
   * @param {number} [options.totalSteps] - Total expected steps
   * @param {number} [options.port] - Bridge server port (default 9876)
   * @param {object} [options.metadata] - Arbitrary metadata
   * @param {string[]} [options.checkpoints] - Named checkpoint identifiers for debugger UI
   */
  constructor(name, options = {}) {
    this.name = name;
    this.totalSteps = options.totalSteps || 0;
    this.port = options.port || DEFAULT_PORT;
    this.metadata = options.metadata || {};
    this._checkpointNames = options.checkpoints || [];

    this.scriptId = null;
    this.ws = null;
    this.connected = false;
    this.errors = 0;
    this.label = '';

    // Pause/cancel state
    this._paused = false;
    this._cancelled = false;
    this._cancelReason = null;
    this._pauseResolve = null; // resolve() to unblock checkPause
    this._sleepReject = null;  // reject() to interrupt sleep on cancel

    // Request/response pending
    this._pending = new Map();
  }

  /**
   * Connect to bridge server and register this script.
   * @returns {Promise<{ scriptId: string }>}
   */
  async connect() {
    await this._connect();
    const result = await this._register();
    this.scriptId = result.scriptId;
    return { scriptId: this.scriptId };
  }

  /**
   * Report progress. Lightweight — no response expected.
   * @param {number} step - Current step
   * @param {number} [total] - Total steps (updates if provided)
   * @param {string} [label] - Current step label
   */
  async progress(step, total, label) {
    if (!this.scriptId) return; // not registered — no-op (bridge unavailable)
    this.label = label || this.label;
    this._send(buildMessage('BRIDGE_SCRIPT_PROGRESS', {
      scriptId: this.scriptId,
      step,
      total: total ?? this.totalSteps,
      label: label || '',
      errors: this.errors,
    }));
  }

  /**
   * Increment error count and report progress.
   * @param {string} [label] - Error description
   */
  async reportError(label) {
    this.errors++;
    if (this.scriptId) {
      this._send(buildMessage('BRIDGE_SCRIPT_PROGRESS', {
        scriptId: this.scriptId,
        step: undefined,
        total: this.totalSteps,
        label: label || 'Error',
        errors: this.errors,
      }));
    }
  }

  /**
   * Check if paused — blocks until resumed. Throws if cancelled.
   * Call this in your main loop before each step.
   * @returns {Promise<void>}
   * @throws {Error} If script was cancelled
   */
  async checkPause() {
    if (this._cancelled) {
      throw new ScriptCancelledError(this._cancelReason);
    }
    if (this._paused) {
      // Block until resumed
      await new Promise((resolve) => {
        this._pauseResolve = resolve;
      });
      this._pauseResolve = null;
      // Check cancel again after resume
      if (this._cancelled) {
        throw new ScriptCancelledError(this._cancelReason);
      }
    }
  }

  /**
   * Named breakpoint. Zero-cost if breakpoint not toggled active in UI.
   * Blocks if user toggled it on — shows context in debugger panel.
   * Throws ScriptCancelledError if cancelled while blocked.
   *
   * @param {string} name - Checkpoint name (e.g. 'race_start', 'after_navigate')
   * @param {object} [context] - Context shown in UI when paused { key: value }
   * @returns {Promise<void>}
   * @throws {ScriptCancelledError} If cancelled at checkpoint
   */
  async checkpoint(name, context = {}) {
    if (this._cancelled) throw new ScriptCancelledError(this._cancelReason);
    if (!this.scriptId) {
      // Bridge not available — just check cancelled, no blocking
      return;
    }
    // Server replies immediately if breakpoint not active; blocks if active.
    // Timeout is 10 minutes — long enough for debugging sessions.
    const result = await this._sendRequest('BRIDGE_SCRIPT_CHECKPOINT', {
      scriptId: this.scriptId,
      name,
      context,
      timestamp: Date.now(),
    }, 600000);

    if (result.cancelled) {
      throw new ScriptCancelledError('Cancelled at checkpoint');
    }
  }

  /**
   * Async sleep — interruptible by cancel (throws ScriptCancelledError).
   * Replaces execSync(`sleep N`) throughout automation scripts.
   *
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   * @throws {ScriptCancelledError} If cancelled during sleep
   */
  async sleep(ms) {
    if (this._cancelled) throw new ScriptCancelledError(this._cancelReason);

    await new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        done = true;
        this._sleepReject = null;
        resolve();
      }, ms);

      this._sleepReject = (err) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          this._sleepReject = null;
          reject(err);
        }
      };
    });

    if (this._cancelled) throw new ScriptCancelledError(this._cancelReason);
  }

  /**
   * Real-time activity label — shown in UI while script is running.
   * Fire-and-forget (no response expected).
   *
   * @param {string} label - Current activity description
   */
  setActivity(label) {
    if (!this.scriptId) return;
    this._send(buildMessage('BRIDGE_SCRIPT_PROGRESS', {
      scriptId: this.scriptId,
      step: undefined,
      total: this.totalSteps,
      label: this.label,
      errors: this.errors,
      activity: label,
    }));
  }

  /**
   * Auth pre-flight — verify a Playwright session is logged in before work starts.
   * Prevents running 1000+ steps against an unauthenticated session.
   *
   * @param {string} sessionId - PlaywrightSession ID or name
   * @param {object} checks
   * @param {string} [checks.urlContains] - Current URL must contain this string
   * @param {string[]} [checks.snapshotContains] - Snapshot must contain at least one of these strings
   * @returns {Promise<{ ok: boolean, reason?: string }>}
   */
  async verifySession(sessionId, checks = {}) {
    if (!this.scriptId) {
      return { ok: true, reason: 'Bridge not available (skipped)' };
    }
    return this._sendRequest('BRIDGE_SCRIPT_VERIFY_SESSION', {
      scriptId: this.scriptId,
      sessionId,
      checks,
    }, 30000);
  }

  /**
   * Dynamically declare a checkpoint after registration.
   * Used by playwright-shim when new pages are created (page IDs aren't known at registration time).
   * The bridge appends to script.checkpoints and broadcasts the update so UIs show the new toggle.
   *
   * @param {string} name - Checkpoint name (e.g. 'p1:navigate')
   * @returns {Promise<void>}
   */
  async declareCheckpoint(name) {
    if (!this.scriptId) return;
    await this._sendRequest('BRIDGE_SCRIPT_DECLARE_CHECKPOINT', {
      scriptId: this.scriptId,
      name,
    });
  }

  /**
   * Report a page's current URL and title so the UI can label intercept toggles.
   * Fire-and-forget (no response expected).
   *
   * @param {string} pageId - Page identifier (e.g. 'p1', 'p2')
   * @param {string} url - Current page URL
   * @param {string} [title] - Page title (optional)
   */
  reportPage(pageId, url, title = '') {
    if (!this.scriptId) return;
    this._send(buildMessage('BRIDGE_SCRIPT_PAGE_STATUS', {
      scriptId: this.scriptId,
      pageId,
      url,
      title,
    }));
  }

  /**
   * Auth pre-flight guard — verify session is logged in, report error and exit if not.
   * Replaces ~17 lines of boilerplate in every script that needs auth checks.
   *
   * @param {string} sessionId - PlaywrightSession ID or name
   * @param {object} checks
   * @param {string} [checks.urlContains] - Current URL must contain this string
   * @param {string[]} [checks.snapshotContains] - Snapshot must contain at least one
   * @param {object} [options]
   * @param {function} [options.onFail] - Cleanup callback on auth failure (e.g. close DB)
   * @param {string} [options.activity] - Activity label while checking (default: 'Verifying session...')
   * @returns {Promise<void>} Resolves if auth passed; calls complete+disconnect+exit on failure
   */
  async authGuard(sessionId, checks, options = {}) {
    const activity = options.activity || 'Verifying session...';
    this.setActivity(activity);

    const result = await this.verifySession(sessionId, checks);
    if (result.ok) {
      this.setActivity('');
      return;
    }

    // Auth failed — report error, clean up, and exit
    const reason = result.reason || 'Session verification failed';
    console.error(`[Script:${this.name}] Auth guard failed: ${reason}`);
    await this.reportError(reason);

    if (options.onFail) {
      try { await options.onFail(); } catch { /* best-effort cleanup */ }
    }

    await this.complete({ error: reason, authFailed: true });
    this.disconnect();
    process.exit(1);
  }

  /**
   * Mark script as complete.
   * @param {object} [results] - Final results to report
   * @returns {Promise<void>}
   */
  async complete(results = {}) {
    if (!this.scriptId) throw new Error('Not registered');
    await this._sendRequest('BRIDGE_SCRIPT_COMPLETE', {
      scriptId: this.scriptId,
      results,
      errors: this.errors,
      duration: Date.now() - this._startedAt,
    });
  }

  /**
   * Disconnect from the bridge server.
   */
  disconnect() {
    if (this.ws) {
      this.ws.close(1000, 'Script done');
      this.ws = null;
    }
    this.connected = false;
  }

  // ---- Internal ----

  _connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://localhost:${this.port}`);

      this.ws.on('open', () => {
        this.connected = true;
        this._startedAt = Date.now();
        // Identify as script
        this._send(buildMessage('BRIDGE_IDENTIFY', { role: 'script' }));
        resolve();
      });

      this.ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        this._handleMessage(msg);
      });

      this.ws.on('close', () => {
        this.connected = false;
      });

      this.ws.on('error', (err) => {
        if (!this.connected) reject(err);
      });
    });
  }

  _register() {
    return this._sendRequest('BRIDGE_SCRIPT_REGISTER', {
      name: this.name,
      totalSteps: this.totalSteps,
      metadata: this.metadata,
      pid: process.pid,
      checkpoints: this._checkpointNames,
    });
  }

  _handleMessage(msg) {
    // Handle replies to pending requests
    if (msg.replyTo && this._pending.has(msg.replyTo)) {
      const { resolve, reject, timer } = this._pending.get(msg.replyTo);
      this._pending.delete(msg.replyTo);
      clearTimeout(timer);
      if (msg.type === 'BRIDGE_ERROR') {
        reject(new Error(msg.payload?.error || 'Bridge error'));
      } else {
        resolve(msg.payload);
      }
      return;
    }

    // Handle server-initiated messages (pause/resume/cancel)
    switch (msg.type) {
      case 'BRIDGE_SCRIPT_PAUSE':
        this._paused = true;
        console.log(`[Script:${this.name}] Paused by extension`);
        break;

      case 'BRIDGE_SCRIPT_RESUME':
        this._paused = false;
        console.log(`[Script:${this.name}] Resumed`);
        if (this._pauseResolve) this._pauseResolve();
        break;

      case 'BRIDGE_SCRIPT_CANCEL':
        this._cancelled = true;
        this._cancelReason = msg.payload?.reason || 'Cancelled by extension';
        console.log(`[Script:${this.name}] Cancelled: ${this._cancelReason}`);
        // Unblock checkPause if waiting
        if (this._pauseResolve) this._pauseResolve();
        // Interrupt sleep if sleeping
        if (this._sleepReject) this._sleepReject(new ScriptCancelledError(this._cancelReason));
        break;
    }
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  _sendRequest(type, payload, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const msg = buildMessage(type, payload);
      const timer = setTimeout(() => {
        this._pending.delete(msg.id);
        reject(new Error(`Request timed out: ${type}`));
      }, timeout);
      this._pending.set(msg.id, { resolve, reject, timer });
      this._send(msg);
    });
  }
}

/**
 * Error thrown when a script is cancelled via the extension UI.
 */
export class ScriptCancelledError extends Error {
  constructor(reason) {
    super(`Script cancelled: ${reason}`);
    this.name = 'ScriptCancelledError';
    this.reason = reason;
  }
}
