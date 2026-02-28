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
 *   const client = new ScriptClient('my_scraper', { totalSteps: 100 });
 *   await client.connect();
 *
 *   for (let i = 0; i < items.length; i++) {
 *     await client.checkPause();  // blocks if paused, throws if cancelled
 *     await client.progress(i + 1, items.length, `Processing item ${i + 1}`);
 *     // ... do work ...
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
   */
  constructor(name, options = {}) {
    this.name = name;
    this.totalSteps = options.totalSteps || 0;
    this.port = options.port || DEFAULT_PORT;
    this.metadata = options.metadata || {};

    this.scriptId = null;
    this.ws = null;
    this.connected = false;
    this.errors = 0;

    // Pause/cancel state
    this._paused = false;
    this._cancelled = false;
    this._cancelReason = null;
    this._pauseResolve = null; // resolve() to unblock checkPause

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
    if (!this.scriptId) throw new Error('Not registered');
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
