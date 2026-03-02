/**
 * V8 Inspector Protocol Client
 *
 * Connects to a Node.js process via --inspect and provides
 * debugger control: breakpoints, stepping, evaluation, call stacks.
 *
 * Usage:
 *   const inspector = new InspectorClient(wsUrl);
 *   await inspector.connect();
 *   await inspector.enable();
 *   await inspector.setBreakpoint(scriptUrl, lineNumber);
 *   inspector.onPaused((data) => { ... });
 *   await inspector.resume();
 */

import WebSocket from 'ws';

export class InspectorClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this._msgId = 0;
    this._pending = new Map();   // id → { resolve, reject, timer }
    this._paused = false;
    this._pauseCallbacks = [];
    this._resumedCallbacks = [];
    this._scriptParsedCallbacks = [];
    this._scripts = new Map();   // V8 scriptId → { url, source }
    this._breakpoints = new Map(); // our id → V8 breakpointId
    this._callFrames = [];       // current call frames when paused
    this._pausedLine = null;
    this._pausedFile = null;
    this._connected = false;
  }

  /**
   * Connect to the V8 inspector WebSocket
   */
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => {
        reject(new Error('Inspector connection timed out'));
      }, 10000);

      this.ws.on('open', () => {
        clearTimeout(timer);
        this._connected = true;
        console.log(`[Inspector] Connected: ${this.wsUrl}`);
        resolve();
      });

      this.ws.on('message', (raw) => {
        this._handleMessage(JSON.parse(raw.toString()));
      });

      this.ws.on('close', () => {
        this._connected = false;
        this._rejectAll('Inspector disconnected');
      });

      this.ws.on('error', (err) => {
        clearTimeout(timer);
        this._connected = false;
        reject(err);
      });
    });
  }

  /**
   * Enable the debugger and runtime domains
   */
  async enable() {
    await this._send('Debugger.enable', {});
    await this._send('Runtime.enable', {});
    // Don't pause on exceptions by default
    await this._send('Debugger.setPauseOnExceptions', { state: 'none' });
  }

  /**
   * Wait for the debugger to enter paused state (e.g., after --inspect-brk).
   * @param {number} timeout - Max ms to wait (default 5000)
   */
  waitForPause(timeout = 5000) {
    if (this._paused) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for debugger pause'));
      }, timeout);
      const cb = () => {
        clearTimeout(timer);
        // Remove this one-shot callback
        this._pauseCallbacks = this._pauseCallbacks.filter(c => c !== cb);
        resolve();
      };
      this._pauseCallbacks.push(cb);
    });
  }

  /**
   * Set a breakpoint by file URL and line number (0-indexed internally, 1-indexed API)
   * @param {string} url - File URL (e.g., 'file:///path/to/script.mjs')
   * @param {number} line - 1-indexed line number (as shown in editor)
   * @returns {{ breakpointId: string, actualLine: number }}
   */
  async setBreakpoint(url, line) {
    const result = await this._send('Debugger.setBreakpointByUrl', {
      lineNumber: line - 1,  // V8 uses 0-indexed
      url,
    });
    const actualLine = (result.locations?.[0]?.lineNumber ?? (line - 1)) + 1;
    return { breakpointId: result.breakpointId, actualLine };
  }

  /**
   * Remove a breakpoint by V8 breakpoint ID
   */
  async removeBreakpoint(breakpointId) {
    await this._send('Debugger.removeBreakpoint', { breakpointId });
  }

  /**
   * Resume execution (Continue — runs to next breakpoint)
   */
  async resume() {
    await this._send('Debugger.resume', {});
  }

  /**
   * Resume a process that was started with --inspect-brk.
   * This is different from resume() — it unblocks the initial wait-for-debugger state.
   */
  async runIfWaitingForDebugger() {
    await this._send('Runtime.runIfWaitingForDebugger', {});
  }

  /**
   * Step Over — execute current line, pause at next line
   */
  async stepOver() {
    await this._send('Debugger.stepOver', {});
  }

  /**
   * Step Into — step into function call on current line
   */
  async stepInto() {
    await this._send('Debugger.stepInto', {});
  }

  /**
   * Step Out — run until current function returns
   */
  async stepOut() {
    await this._send('Debugger.stepOut', {});
  }

  /**
   * Restart the given call frame (go back to function start)
   * @param {string} callFrameId - From callFrames array
   */
  async restartFrame(callFrameId) {
    return this._send('Debugger.restartFrame', { callFrameId });
  }

  /**
   * Evaluate an expression. If paused, evaluates in the top frame context.
   * @param {string} expression
   * @param {string} [callFrameId] - Specific frame (default: top frame if paused)
   * @returns {{ type, value, description }}
   */
  async evaluate(expression, callFrameId) {
    if (callFrameId || (this._paused && this._callFrames.length > 0)) {
      const frameId = callFrameId || this._callFrames[0].callFrameId;
      const result = await this._send('Debugger.evaluateOnCallFrame', {
        callFrameId: frameId,
        expression,
        returnByValue: true,
      });
      return this._formatResult(result.result, result.exceptionDetails);
    }
    const result = await this._send('Runtime.evaluate', {
      expression,
      returnByValue: true,
    });
    return this._formatResult(result.result, result.exceptionDetails);
  }

  /**
   * Get scope variables for a call frame
   * @param {number} [frameIndex=0] - Index into callFrames array
   * @returns {Array<{ name, value, type }>}
   */
  async getScopeVariables(frameIndex = 0) {
    if (!this._paused || !this._callFrames[frameIndex]) return [];

    const frame = this._callFrames[frameIndex];
    const variables = [];

    for (const scope of frame.scopeChain) {
      if (scope.type === 'global') continue; // skip global scope (too large)

      if (scope.object?.objectId) {
        try {
          const result = await this._send('Runtime.getProperties', {
            objectId: scope.object.objectId,
            ownProperties: true,
          });
          for (const prop of result.result || []) {
            if (prop.name === '__proto__') continue;
            variables.push({
              name: prop.name,
              type: prop.value?.type || 'undefined',
              value: prop.value?.value ?? prop.value?.description ?? '...',
              scope: scope.type,
            });
          }
        } catch { /* scope might not be accessible */ }
      }
    }

    return variables;
  }

  /**
   * Get current call stack (only valid when paused)
   * @returns {Array<{ functionName, file, line, column }>}
   */
  getCallStack() {
    return this._callFrames.map(f => {
      let file = f.url || null;
      if (!file && f.location?.scriptId) {
        const info = this._scripts.get(f.location.scriptId);
        if (info?.url) file = info.url;
      }
      return {
        callFrameId: f.callFrameId,
        functionName: f.functionName || '(anonymous)',
        file: file || f.location?.scriptId,
        line: (f.location?.lineNumber ?? 0) + 1,
        column: (f.location?.columnNumber ?? 0) + 1,
      };
    });
  }

  /** Current paused state */
  get isPaused() { return this._paused; }
  get pausedLine() { return this._pausedLine; }
  get pausedFile() { return this._pausedFile; }
  get isConnected() { return this._connected; }

  /**
   * Register callback for Debugger.paused events
   * @param {function} cb - ({ line, file, callFrames, reason }) => void
   */
  onPaused(cb) { this._pauseCallbacks.push(cb); }

  /**
   * Register callback for Debugger.resumed events
   */
  onResumed(cb) { this._resumedCallbacks.push(cb); }

  /**
   * Disconnect from the inspector
   */
  disconnect() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this._connected = false;
    this._rejectAll('Disconnected');
  }

  // ─── Internal ─────────────────────────────────────────────

  _send(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Inspector not connected'));
        return;
      }
      const id = ++this._msgId;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Inspector timeout: ${method}`));
      }, 10000);

      this._pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  _handleMessage(msg) {
    // Response to a command
    if (msg.id && this._pending.has(msg.id)) {
      const { resolve, reject, timer } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) {
        reject(new Error(msg.error.message));
      } else {
        resolve(msg.result || {});
      }
      return;
    }

    // Events
    if (msg.method === 'Debugger.paused') {
      this._handlePaused(msg.params);
    } else if (msg.method === 'Debugger.resumed') {
      this._paused = false;
      this._callFrames = [];
      this._pausedLine = null;
      this._pausedFile = null;
      for (const cb of this._resumedCallbacks) {
        try { cb(); } catch {}
      }
    } else if (msg.method === 'Debugger.scriptParsed') {
      this._scripts.set(msg.params.scriptId, {
        url: msg.params.url,
        sourceMapURL: msg.params.sourceMapURL,
      });
    }
  }

  _handlePaused(params) {
    this._paused = true;
    this._callFrames = params.callFrames || [];

    const topFrame = this._callFrames[0];
    this._pausedLine = topFrame ? (topFrame.location.lineNumber + 1) : null; // 1-indexed
    // Resolve file URL: prefer frame url, fall back to scriptParsed url
    let file = topFrame?.url || null;
    if (!file && topFrame?.location?.scriptId) {
      const scriptInfo = this._scripts.get(topFrame.location.scriptId);
      if (scriptInfo?.url) file = scriptInfo.url;
    }
    this._pausedFile = file;

    const data = {
      reason: params.reason,
      line: this._pausedLine,
      file: this._pausedFile,
      column: topFrame ? (topFrame.location.columnNumber + 1) : null,
      callFrames: this.getCallStack(),
    };

    for (const cb of this._pauseCallbacks) {
      try { cb(data); } catch (err) {
        console.error('[Inspector] Pause callback error:', err);
      }
    }
  }

  _formatResult(result, exceptionDetails) {
    if (exceptionDetails) {
      return {
        error: true,
        message: exceptionDetails.exception?.description || exceptionDetails.text,
      };
    }
    return {
      type: result.type,
      value: result.value,
      description: result.description,
    };
  }

  _rejectAll(reason) {
    for (const [id, { reject, timer }] of this._pending) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    this._pending.clear();
  }
}

/**
 * Parse the V8 inspector WebSocket URL from Node.js stderr output.
 * Node.js prints: "Debugger listening on ws://127.0.0.1:PORT/UUID"
 * @param {string} line - A line from stderr
 * @returns {string|null} WebSocket URL or null
 */
export function parseInspectorUrl(line) {
  const match = line.match(/Debugger listening on (ws:\/\/\S+)/);
  return match ? match[1] : null;
}
