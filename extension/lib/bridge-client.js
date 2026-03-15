/**
 * Bridge Client for Chrome Extension
 *
 * WebSocket client that runs in the background service worker.
 * Connects to bridge server on localhost:9876 for playwright-cli automation.
 * Auto-reconnects with exponential backoff.
 * Request/response matching via message ID + pending Map.
 */

const DEFAULT_PORT = 9876;
const MAX_RECONNECT_DELAY = 30000;
const INITIAL_RECONNECT_DELAY = 1000;

let ws = null;
let port = DEFAULT_PORT;
let reconnectDelay = INITIAL_RECONNECT_DELAY;
let reconnectTimer = null;
let intentionalClose = false;
let bridgeShimPath = null;
let bridgeScriptsDir = null;

// Pending request/response map: id -> { resolve, reject, timer }
const pending = new Map();

// Event callbacks
const callbacks = {
  onSnapshotReceived: [],
  onStatusChange: [],
  onError: [],
  onConnectionChange: [],
  onSearchRequest: [],
  onScriptUpdate: [],
  onFileChanged: [],
  onDbgPaused: [],
  onDbgResumed: [],
  onScheduleUpdate: [],
};

/**
 * Connect to the bridge server
 * @param {number} [serverPort=9876] - Server port
 * @returns {Promise<boolean>} True if connected
 */
export function connectToBridge(serverPort = DEFAULT_PORT) {
  port = serverPort;
  intentionalClose = false;

  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      resolve(true);
      return;
    }

    try {
      ws = new WebSocket(`ws://localhost:${port}`);
    } catch (err) {
      reject(err);
      return;
    }

    ws.onopen = () => {
      console.log('[BridgeClient] Connected to bridge server');
      reconnectDelay = INITIAL_RECONNECT_DELAY;

      // Identify as extension
      const identifyMsg = _buildMessage('BRIDGE_IDENTIFY', { role: 'extension' });
      ws.send(JSON.stringify(identifyMsg));

      _fireCallbacks('onConnectionChange', { connected: true });
      resolve(true);
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        console.error('[BridgeClient] Invalid JSON received');
        return;
      }

      // Check if this is a reply to a pending request
      if (msg.replyTo && pending.has(msg.replyTo)) {
        const { resolve: res, reject: rej, timer } = pending.get(msg.replyTo);
        pending.delete(msg.replyTo);
        clearTimeout(timer);

        if (msg.type === 'BRIDGE_ERROR') {
          rej(new Error(msg.payload?.error || 'Unknown bridge error'));
        } else {
          res(msg.payload);
        }
        return;
      }

      // Handle broadcast messages
      _handleBroadcast(msg);
    };

    ws.onclose = () => {
      console.log('[BridgeClient] Disconnected from bridge server');
      _fireCallbacks('onConnectionChange', { connected: false });

      // Reject all pending requests
      for (const [id, { reject: rej, timer }] of pending) {
        clearTimeout(timer);
        rej(new Error('Connection closed'));
      }
      pending.clear();

      // Auto-reconnect unless intentionally closed
      if (!intentionalClose) {
        _scheduleReconnect();
      }
    };

    ws.onerror = (err) => {
      console.error('[BridgeClient] WebSocket error');
      _fireCallbacks('onError', { error: 'Connection error' });
      // onclose will fire after this
      reject(new Error('WebSocket connection failed'));
    };
  });
}

/**
 * Disconnect from the bridge server
 */
export function disconnectFromBridge() {
  intentionalClose = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close(1000, 'Client disconnect');
    ws = null;
  }
  _fireCallbacks('onConnectionChange', { connected: false });
}

/**
 * Check if connected to bridge
 * @returns {boolean}
 */
export function isConnected() {
  return ws && ws.readyState === WebSocket.OPEN;
}

// --- Session Management ---

/**
 * Create a new playwright session
 * @param {string} name - Session name
 * @param {object} [opts] - Options (authPath, timeout)
 * @returns {Promise<object>} Session info
 */
export function createSession(name, opts = {}) {
  return _sendRequest('BRIDGE_SESSION_CREATE', { name, ...opts });
}

/**
 * Destroy a session
 * @param {string} sessionId
 * @returns {Promise<object>}
 */
export function destroySession(sessionId) {
  return _sendRequest('BRIDGE_SESSION_DESTROY', { sessionId });
}

/**
 * List all active sessions
 * @returns {Promise<object>} { sessions: [...] }
 */
export function listSessions() {
  return _sendRequest('BRIDGE_SESSION_LIST', {});
}

// --- Commands ---

/**
 * Send a generic command to a session
 * @param {string} sessionId
 * @param {string} command
 * @returns {Promise<object>}
 */
export function sendCommand(sessionId, command) {
  return _sendRequest('BRIDGE_COMMAND', { sessionId, command });
}

/**
 * Take a snapshot of a session
 * @param {string} sessionId
 * @returns {Promise<object>} { yaml, url, lines, timestamp }
 */
export function takeSnapshot(sessionId) {
  return _sendRequest('BRIDGE_SNAPSHOT', { sessionId });
}

/**
 * Navigate a session to a URL
 * @param {string} sessionId
 * @param {string} url
 * @returns {Promise<object>}
 */
export function navigateSession(sessionId, url) {
  return _sendRequest('BRIDGE_NAVIGATE', { sessionId, url });
}

/**
 * Click an element by ref in a session
 * @param {string} sessionId
 * @param {string} ref
 * @returns {Promise<object>}
 */
export function clickRef(sessionId, ref) {
  return _sendRequest('BRIDGE_CLICK', { sessionId, ref });
}

/**
 * Fill an element with a value in a session
 * @param {string} sessionId
 * @param {string} ref
 * @param {string} value
 * @returns {Promise<object>}
 */
export function fillRef(sessionId, ref, value) {
  return _sendRequest('BRIDGE_FILL', { sessionId, ref, value });
}

/**
 * Evaluate JavaScript in a session
 * @param {string} sessionId
 * @param {string} expr
 * @returns {Promise<object>}
 */
export function evalInSession(sessionId, expr) {
  return _sendRequest('BRIDGE_EVAL', { sessionId, expr });
}

// --- Script Management ---

/**
 * List all registered scripts
 * @returns {Promise<object>} { scripts: [...] }
 */
export function listScripts() {
  return _sendRequest('BRIDGE_SCRIPT_LIST', {});
}

/**
 * Launch a script by path (bridge spawns node <path>)
 * @param {string} scriptPath - Absolute path to .mjs or .js script
 * @param {string[]} [args] - Optional CLI args
 */
export function launchScript(scriptPath, args = [], breakpoints = [], lineBreakpoints = [], debug = false, sessionId = null, originalPath = null, preActions = null, postActions = null) {
  const payload = { path: scriptPath, args };
  if (breakpoints.length > 0) payload.breakpoints = breakpoints;
  if (lineBreakpoints.length > 0) payload.lineBreakpoints = lineBreakpoints;
  if (debug) payload.debug = true;
  if (sessionId) payload.sessionId = sessionId;
  if (originalPath) payload.originalPath = originalPath;
  if (preActions && preActions.length > 0) payload.preActions = preActions;
  if (postActions && postActions.length > 0) payload.postActions = postActions;
  return _sendRequest('BRIDGE_SCRIPT_LAUNCH', payload);
}

/**
 * Pause a running script
 * @param {string} scriptId
 * @param {string} [reason]
 * @returns {Promise<object>}
 */
export function pauseScript(scriptId, reason) {
  return _sendRequest('BRIDGE_SCRIPT_PAUSE', { scriptId, reason });
}

/**
 * Resume a paused script
 * @param {string} scriptId
 * @returns {Promise<object>}
 */
export function resumeScript(scriptId) {
  return _sendRequest('BRIDGE_SCRIPT_RESUME', { scriptId });
}

/**
 * Cancel a script
 * @param {string} scriptId
 * @param {string} [reason]
 * @param {boolean} [force] - If true, sends SIGTERM then SIGKILL (PID-based, instant)
 * @returns {Promise<object>}
 */
export function cancelScript(scriptId, reason, force = false) {
  return _sendRequest('BRIDGE_SCRIPT_CANCEL', { scriptId, reason, force });
}

/**
 * Step past a named checkpoint (unblock script paused at debugger).
 * @param {string} scriptId
 * @param {boolean} [clearAll] - If true, clears all breakpoints before stepping (Continue mode)
 * @returns {Promise<object>}
 */
export function stepScript(scriptId, clearAll = false) {
  return _sendRequest('BRIDGE_SCRIPT_STEP', { scriptId, clearAll });
}

/**
 * Toggle a named breakpoint on a script.
 * @param {string} scriptId
 * @param {string} name - Checkpoint name
 * @param {boolean} active - True to activate, false to deactivate
 * @returns {Promise<object>}
 */
export function setBreakpoint(scriptId, name, active) {
  return _sendRequest('BRIDGE_SCRIPT_SET_BREAKPOINT', { scriptId, name, active });
}

/**
 * Load a script's source file via the bridge server.
 * @param {string} scriptPath - Absolute path to the script file
 * @returns {Promise<{ source: string, path: string }>}
 */
export function getScriptSource(scriptPath) {
  return _sendRequest('BRIDGE_SCRIPT_SOURCE', { scriptPath });
}

/**
 * Save a script's source to disk via the bridge server.
 * @param {string} name - Script name (without extension)
 * @param {string} source - Full script source code
 * @returns {Promise<{ success: boolean, path: string }>}
 */
export function saveScript(name, source) {
  return _sendRequest('BRIDGE_SCRIPT_SAVE', { name, source });
}

// ---- V8 Inspector debugging (line-level) ----

export function dbgStepOver(scriptId, pid) {
  return _sendRequest('BRIDGE_DBG_STEP_OVER', { scriptId, pid });
}
export function dbgStepInto(scriptId, pid) {
  return _sendRequest('BRIDGE_DBG_STEP_INTO', { scriptId, pid });
}
export function dbgStepOut(scriptId, pid) {
  return _sendRequest('BRIDGE_DBG_STEP_OUT', { scriptId, pid });
}
export function dbgContinue(scriptId, pid) {
  return _sendRequest('BRIDGE_DBG_CONTINUE', { scriptId, pid });
}
export function dbgSetBreakpoint(scriptId, pid, file, line) {
  return _sendRequest('BRIDGE_DBG_SET_BREAKPOINT', { scriptId, pid, file, line });
}
export function dbgRemoveBreakpoint(scriptId, pid, breakpointId) {
  return _sendRequest('BRIDGE_DBG_REMOVE_BREAKPOINT', { scriptId, pid, breakpointId });
}
export function dbgEvaluate(scriptId, pid, expression, callFrameId) {
  return _sendRequest('BRIDGE_DBG_EVALUATE', { scriptId, pid, expression, callFrameId });
}
export function dbgRestartFrame(scriptId, pid, callFrameId) {
  return _sendRequest('BRIDGE_DBG_RESTART_FRAME', { scriptId, pid, callFrameId });
}

// ---- Auth capture ----

/**
 * Start an auth capture session: opens a browser to the given URL for manual login.
 * @param {string} scriptName - Script name (used to key the auth file)
 * @param {string} url - URL to navigate to for login
 * @returns {Promise<{ sessionId: string, sessionName: string }>}
 */
export function startAuthCapture(scriptName, url) {
  return _sendRequest('BRIDGE_AUTH_CAPTURE', { scriptName, url });
}

/**
 * Save auth state from the capture session and close it.
 * @param {string} sessionId - The auth session to save from
 * @param {string} scriptName - Script name (determines output file name)
 * @returns {Promise<{ success: boolean, path: string }>}
 */
export function saveAuthState(sessionId, scriptName) {
  return _sendRequest('BRIDGE_AUTH_SAVE', { sessionId, scriptName });
}

/**
 * Check if auth state file exists for a script.
 * @param {string} scriptName - Script name to check
 * @returns {Promise<{ exists: boolean, path: string }>}
 */
export function checkAuthState(scriptName) {
  return _sendRequest('BRIDGE_AUTH_CHECK', { scriptName });
}

// ---- Scheduling ----

export function createSchedule(payload) {
  return _sendRequest('BRIDGE_SCHEDULE_CREATE', payload);
}
export function updateSchedule(scheduleId, updates) {
  return _sendRequest('BRIDGE_SCHEDULE_UPDATE', { scheduleId, ...updates });
}
export function deleteSchedule(scheduleId) {
  return _sendRequest('BRIDGE_SCHEDULE_DELETE', { scheduleId });
}
export function listSchedules() {
  return _sendRequest('BRIDGE_SCHEDULE_LIST', {});
}
export function triggerSchedule(scheduleId) {
  return _sendRequest('BRIDGE_SCHEDULE_TRIGGER', { scheduleId });
}

export function onScheduleUpdate(cb) {
  callbacks.onScheduleUpdate.push(cb);
}

// ---- SmartClient AI ----

/**
 * Generate SmartClient UI config via Claude Code (bridge spawns claude -p).
 * @param {string} prompt - Natural language UI description
 * @returns {Promise<{ success: boolean, config?: object, error?: string }>}
 */
export function generateSmartClientUI(prompt) {
  return _sendRequest('BRIDGE_SC_GENERATE_UI', { prompt }, 60000);
}

// ---- System process management ----

export function getSystemProcesses() {
  return _sendRequest('BRIDGE_SYSTEM_PROCESSES', {});
}
export function killProcess(pid) {
  return _sendRequest('BRIDGE_KILL_PROCESS', { pid });
}

/**
 * Get the shim path provided by the bridge server at connect time.
 * @returns {string|null}
 */
export function getShimPath() {
  return bridgeShimPath;
}

/**
 * Get the scripts directory path provided by the bridge server.
 * @returns {string|null}
 */
export function getScriptsDir() {
  return bridgeScriptsDir;
}

// --- Event Callbacks ---

/**
 * Register callback for snapshot events
 * @param {function} cb - Callback({ sessionId, url, yaml, lines, timestamp })
 */
export function onSnapshotReceived(cb) {
  callbacks.onSnapshotReceived.push(cb);
}

/**
 * Register callback for status changes
 * @param {function} cb - Callback({ sessionId, state, ... })
 */
export function onStatusChange(cb) {
  callbacks.onStatusChange.push(cb);
}

/**
 * Register callback for errors
 * @param {function} cb - Callback({ error })
 */
export function onError(cb) {
  callbacks.onError.push(cb);
}

/**
 * Register callback for connection state changes
 * @param {function} cb - Callback({ connected })
 */
export function onConnectionChange(cb) {
  callbacks.onConnectionChange.push(cb);
}

/**
 * Register callback for script progress updates
 * @param {function} cb - Callback({ scriptId, name, state, step, total, label, errors, ... })
 */
export function onScriptUpdate(cb) {
  callbacks.onScriptUpdate.push(cb);
}

/**
 * Register callback for file changes on disk (reverse sync from bridge file watcher).
 * @param {function} cb - Callback({ name, source, path, size, modifiedAt, deleted })
 */
export function onFileChanged(cb) {
  callbacks.onFileChanged.push(cb);
}
export function onDbgPaused(cb) {
  callbacks.onDbgPaused.push(cb);
}
export function onDbgResumed(cb) {
  callbacks.onDbgResumed.push(cb);
}

/**
 * Register callback for search requests relayed from bridge server.
 * Callback receives (query, options) and must return a Promise<results>.
 * @param {function} cb - async Callback(query, options) => results
 */
export function onSearchRequest(cb) {
  callbacks.onSearchRequest.push(cb);
}

// --- Internal ---

let _msgCounter = 0;

function _buildMessage(type, payload) {
  return {
    id: `ext_${Date.now()}_${++_msgCounter}`,
    type,
    source: 'extension',
    timestamp: Date.now(),
    payload,
  };
}

function _sendRequest(type, payload, timeout = 30000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('Not connected to bridge'));
      return;
    }

    const msg = _buildMessage(type, payload);

    const timer = setTimeout(() => {
      pending.delete(msg.id);
      reject(new Error(`Request timed out: ${type}`));
    }, timeout);

    pending.set(msg.id, { resolve, reject, timer });

    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      pending.delete(msg.id);
      clearTimeout(timer);
      reject(err);
    }
  });
}

function _handleBroadcast(msg) {
  switch (msg.type) {
    case 'BRIDGE_IDENTIFY':
      // Capture server-provided paths from identify reply
      if (msg.payload?.shimPath) bridgeShimPath = msg.payload.shimPath;
      if (msg.payload?.scriptsDir) bridgeScriptsDir = msg.payload.scriptsDir;
      break;
    case 'BRIDGE_SNAPSHOT_RESULT':
      _fireCallbacks('onSnapshotReceived', msg.payload);
      break;
    case 'BRIDGE_STATUS':
      _fireCallbacks('onStatusChange', msg.payload);
      break;
    case 'BRIDGE_ERROR':
      _fireCallbacks('onError', msg.payload);
      break;
    case 'BRIDGE_SCRIPT_PROGRESS':
      _fireCallbacks('onScriptUpdate', msg.payload);
      break;
    case 'BRIDGE_SCRIPT_FILE_CHANGED':
      _fireCallbacks('onFileChanged', msg.payload);
      break;
    case 'BRIDGE_DBG_PAUSED':
      _fireCallbacks('onDbgPaused', msg.payload);
      break;
    case 'BRIDGE_DBG_RESUMED':
      _fireCallbacks('onDbgResumed', msg.payload);
      break;
    case 'BRIDGE_SCHEDULE_UPDATE':
    case 'BRIDGE_SCHEDULE_DELETED':
      _fireCallbacks('onScheduleUpdate', msg.payload);
      break;
    case 'BRIDGE_SEARCH_SNAPSHOTS':
      _handleSearchRequest(msg);
      break;
  }
}

/**
 * Handle a search request relayed from the bridge server.
 * Calls registered onSearchRequest callbacks and sends the reply.
 */
async function _handleSearchRequest(msg) {
  const { query, limit } = msg.payload || {};
  console.log(`[BridgeClient] Search request: "${query}"`);

  try {
    let results = [];
    for (const cb of callbacks.onSearchRequest) {
      results = await cb(query, { limit });
      if (results && results.length > 0) break;
    }

    // Send reply back to server
    const reply = {
      id: `ext_${Date.now()}_${++_msgCounter}`,
      type: 'BRIDGE_SEARCH_SNAPSHOTS',
      source: 'extension',
      timestamp: Date.now(),
      replyTo: msg.id,
      payload: { success: true, results },
    };
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(reply));
    }
  } catch (err) {
    console.error('[BridgeClient] Search request failed:', err);
    const reply = {
      id: `ext_${Date.now()}_${++_msgCounter}`,
      type: 'BRIDGE_ERROR',
      source: 'extension',
      timestamp: Date.now(),
      replyTo: msg.id,
      payload: { error: err.message },
    };
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(reply));
    }
  }
}

function _fireCallbacks(event, data) {
  for (const cb of callbacks[event] || []) {
    try {
      cb(data);
    } catch (err) {
      console.error(`[BridgeClient] Callback error (${event}):`, err);
    }
  }
}

function _scheduleReconnect() {
  if (reconnectTimer) return;
  console.log(`[BridgeClient] Reconnecting in ${reconnectDelay}ms...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToBridge(port).catch(() => {
      // Exponential backoff
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    });
  }, reconnectDelay);
}
