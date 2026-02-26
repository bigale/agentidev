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

// Pending request/response map: id -> { resolve, reject, timer }
const pending = new Map();

// Event callbacks
const callbacks = {
  onSnapshotReceived: [],
  onStatusChange: [],
  onError: [],
  onConnectionChange: [],
  onSearchRequest: [],
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
    case 'BRIDGE_SNAPSHOT_RESULT':
      _fireCallbacks('onSnapshotReceived', msg.payload);
      break;
    case 'BRIDGE_STATUS':
      _fireCallbacks('onStatusChange', msg.payload);
      break;
    case 'BRIDGE_ERROR':
      _fireCallbacks('onError', msg.payload);
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
