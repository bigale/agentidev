/**
 * Claude Code WebSocket Client
 *
 * Node.js client for Claude Code to connect to the bridge server.
 * Same protocol as extension client but uses the `ws` npm package.
 * Enables Claude Code to control playwright sessions, take snapshots,
 * and collaborate with the extension on the same sessions.
 */

import WebSocket from 'ws';
import { MSG, buildMessage, buildReply, ROLES } from './protocol.mjs';

const DEFAULT_PORT = 9876;
const REQUEST_TIMEOUT = 30000;

let ws = null;
let connected = false;
let clientId = null;
let msgCounter = 0;

// Pending requests: id -> { resolve, reject, timer }
const pending = new Map();

// Event listeners
const listeners = {
  snapshot: [],
  status: [],
  error: [],
};

/**
 * Connect to the bridge server
 * @param {number} [port=9876] - Server port
 * @returns {Promise<{clientId, sessions}>}
 */
export async function connect(port = DEFAULT_PORT) {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      resolve({ clientId, sessions: [] });
      return;
    }

    ws = new WebSocket(`ws://localhost:${port}`);

    ws.on('open', async () => {
      console.log('[ClaudeClient] Connected to bridge server');
      connected = true;

      try {
        // Identify as Claude
        const result = await _sendRequest(MSG.BRIDGE_IDENTIFY, { role: ROLES.CLAUDE });
        clientId = result.clientId;
        console.log(`[ClaudeClient] Identified as: ${clientId}`);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Check pending requests
      if (msg.replyTo && pending.has(msg.replyTo)) {
        const { resolve: res, reject: rej, timer } = pending.get(msg.replyTo);
        pending.delete(msg.replyTo);
        clearTimeout(timer);

        if (msg.type === MSG.BRIDGE_ERROR) {
          rej(new Error(msg.payload?.error || 'Bridge error'));
        } else {
          res(msg.payload);
        }
        return;
      }

      // Handle broadcasts
      _handleBroadcast(msg);
    });

    ws.on('close', () => {
      console.log('[ClaudeClient] Disconnected');
      connected = false;
      _rejectAllPending('Connection closed');
    });

    ws.on('error', (err) => {
      console.error('[ClaudeClient] Connection error:', err.message);
      reject(err);
    });
  });
}

/**
 * Disconnect from the bridge server
 */
export function disconnect() {
  if (ws) {
    ws.close(1000);
    ws = null;
  }
  connected = false;
  _rejectAllPending('Client disconnected');
}

/**
 * Check if connected
 * @returns {boolean}
 */
export function isConnected() {
  return connected && ws?.readyState === WebSocket.OPEN;
}

// --- Session Management ---

/**
 * List all active sessions
 * @returns {Promise<Array>}
 */
export async function listSessions() {
  const result = await _sendRequest(MSG.BRIDGE_SESSION_LIST, {});
  return result.sessions || [];
}

/**
 * Create a new playwright session
 * @param {string} name - Session name
 * @param {object} [opts] - Options (authPath, timeout)
 * @returns {Promise<object>} Session info
 */
export async function createSession(name, opts = {}) {
  return _sendRequest(MSG.BRIDGE_SESSION_CREATE, { name, ...opts });
}

/**
 * Destroy a session
 * @param {string} sessionId
 * @returns {Promise<object>}
 */
export async function destroySession(sessionId) {
  return _sendRequest(MSG.BRIDGE_SESSION_DESTROY, { sessionId });
}

// --- Commands ---

/**
 * Send a generic command to a session
 * @param {string} sessionId
 * @param {string} command - Raw command string
 * @returns {Promise<object>}
 */
export async function sendCommand(sessionId, command) {
  return _sendRequest(MSG.BRIDGE_COMMAND, { sessionId, command });
}

/**
 * Take an accessibility snapshot
 * @param {string} sessionId
 * @returns {Promise<{yaml, url, lines, timestamp}>}
 */
export async function takeSnapshot(sessionId) {
  return _sendRequest(MSG.BRIDGE_SNAPSHOT, { sessionId });
}

/**
 * Navigate to a URL
 * @param {string} sessionId
 * @param {string} url
 * @returns {Promise<object>}
 */
export async function navigate(sessionId, url) {
  return _sendRequest(MSG.BRIDGE_NAVIGATE, { sessionId, url });
}

/**
 * Click an element by ref
 * @param {string} sessionId
 * @param {string} ref - Element ref (e.g., "e123")
 * @returns {Promise<object>}
 */
export async function click(sessionId, ref) {
  return _sendRequest(MSG.BRIDGE_CLICK, { sessionId, ref });
}

/**
 * Fill an element with a value
 * @param {string} sessionId
 * @param {string} ref
 * @param {string} value
 * @returns {Promise<object>}
 */
export async function fill(sessionId, ref, value) {
  return _sendRequest(MSG.BRIDGE_FILL, { sessionId, ref, value });
}

/**
 * Evaluate JavaScript expression in the page
 * @param {string} sessionId
 * @param {string} expr
 * @returns {Promise<object>}
 */
export async function evaluate(sessionId, expr) {
  return _sendRequest(MSG.BRIDGE_EVAL, { sessionId, expr });
}

// --- Monitoring ---

/**
 * Register snapshot event callback
 * @param {function} cb - Callback({sessionId, yaml, url, lines, timestamp})
 */
export function onSnapshot(cb) {
  listeners.snapshot.push(cb);
}

/**
 * Register status change callback
 * @param {function} cb - Callback({sessionId, state, ...})
 */
export function onStatus(cb) {
  listeners.status.push(cb);
}

/**
 * Register error callback
 * @param {function} cb
 */
export function onError(cb) {
  listeners.error.push(cb);
}

// --- Intervention ---

/**
 * Pause a session (prevents extension from sending commands)
 * @param {string} sessionId
 * @returns {Promise<object>}
 */
export async function pauseSession(sessionId) {
  return _sendRequest(MSG.BRIDGE_PAUSE, { sessionId });
}

/**
 * Resume a paused session
 * @param {string} sessionId
 * @returns {Promise<object>}
 */
export async function resumeSession(sessionId) {
  return _sendRequest(MSG.BRIDGE_RESUME, { sessionId });
}

/**
 * Override a pending command
 * @param {string} sessionId
 * @param {object} cmd - Replacement command
 * @returns {Promise<object>}
 */
export async function overrideCommand(sessionId, cmd) {
  return _sendRequest(MSG.BRIDGE_OVERRIDE, { sessionId, command: cmd });
}

// --- Internal ---

function _buildMsg(type, payload) {
  return buildMessage(type, payload, 'claude');
}

function _sendRequest(type, payload, timeout = REQUEST_TIMEOUT) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('Not connected to bridge'));
      return;
    }

    const msg = _buildMsg(type, payload);

    const timer = setTimeout(() => {
      pending.delete(msg.id);
      reject(new Error(`Request timed out: ${type}`));
    }, timeout);

    pending.set(msg.id, { resolve, reject, timer });

    ws.send(JSON.stringify(msg));
  });
}

function _handleBroadcast(msg) {
  switch (msg.type) {
    case MSG.BRIDGE_SNAPSHOT_RESULT:
      _fire('snapshot', msg.payload);
      break;
    case MSG.BRIDGE_STATUS:
      _fire('status', msg.payload);
      break;
    case MSG.BRIDGE_ERROR:
      _fire('error', msg.payload);
      break;
  }
}

function _fire(event, data) {
  for (const cb of listeners[event] || []) {
    try { cb(data); } catch (err) {
      console.error(`[ClaudeClient] Callback error (${event}):`, err);
    }
  }
}

function _rejectAllPending(reason) {
  for (const [id, { reject: rej, timer }] of pending) {
    clearTimeout(timer);
    rej(new Error(reason));
  }
  pending.clear();
}

// ─── CLI Mode ───────────────────────────────────────────────
// When run directly: node bridge/claude-client.mjs <command> [json-payload]

const CLI_COMMANDS = {
  'status':             () => _sendRequest(MSG.BRIDGE_STATUS, {}),
  'session:list':       () => _sendRequest(MSG.BRIDGE_SESSION_LIST, {}),
  'session:create':     (p) => _sendRequest(MSG.BRIDGE_SESSION_CREATE, p),
  'session:destroy':    (p) => _sendRequest(MSG.BRIDGE_SESSION_DESTROY, p),
  'session:navigate':   (p) => _sendRequest(MSG.BRIDGE_NAVIGATE, p),
  'session:snapshot':   (p) => _sendRequest(MSG.BRIDGE_SNAPSHOT, p),
  'session:click':      (p) => _sendRequest(MSG.BRIDGE_CLICK, p),
  'session:fill':       (p) => _sendRequest(MSG.BRIDGE_FILL, p),
  'session:eval':       (p) => _sendRequest(MSG.BRIDGE_EVAL, p),
  'script:list':        () => _sendRequest(MSG.BRIDGE_SCRIPT_LIST, {}),
  'script:launch':      (p) => _sendRequest(MSG.BRIDGE_SCRIPT_LAUNCH, p),
  'script:cancel':      (p) => _sendRequest(MSG.BRIDGE_SCRIPT_CANCEL, p),
  'script:pause':       (p) => _sendRequest(MSG.BRIDGE_SCRIPT_PAUSE, p),
  'script:resume':      (p) => _sendRequest(MSG.BRIDGE_SCRIPT_RESUME, p),
  'script:step':        (p) => _sendRequest(MSG.BRIDGE_SCRIPT_STEP, p),
  'script:breakpoint':  (p) => _sendRequest(MSG.BRIDGE_SCRIPT_SET_BREAKPOINT, p),
  'script:save':        (p) => _sendRequest(MSG.BRIDGE_SCRIPT_SAVE, p),
  'schedule:list':      () => _sendRequest(MSG.BRIDGE_SCHEDULE_LIST, {}),
  'schedule:create':    (p) => _sendRequest(MSG.BRIDGE_SCHEDULE_CREATE, p),
  'schedule:update':    (p) => _sendRequest(MSG.BRIDGE_SCHEDULE_UPDATE, p),
  'schedule:delete':    (p) => _sendRequest(MSG.BRIDGE_SCHEDULE_DELETE, p),
  'schedule:trigger':   (p) => _sendRequest(MSG.BRIDGE_SCHEDULE_TRIGGER, p),
  'sc:generate':        (p) => _sendRequest(MSG.BRIDGE_SC_GENERATE_UI, p, 60000),
  'sc:clone':           (p) => _sendRequest(MSG.BRIDGE_SC_CLONE_PAGE, p, 120000),
};

async function runCLI() {
  const [,, command, payloadStr] = process.argv;

  if (!command || command === '--help' || command === '-h') {
    console.log('Usage: node bridge/claude-client.mjs <command> [json-payload]\n');
    console.log('Commands:');
    for (const cmd of Object.keys(CLI_COMMANDS)) {
      console.log(`  ${cmd}`);
    }
    process.exit(0);
  }

  const handler = CLI_COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    console.error(`Run with --help to see available commands`);
    process.exit(1);
  }

  let payload = {};
  if (payloadStr) {
    // sc:generate accepts a plain-text prompt (not JSON)
    if (command === 'sc:generate') {
      payload = { prompt: payloadStr };
    } else {
      try {
        payload = JSON.parse(payloadStr);
      } catch (err) {
        console.error(`Invalid JSON payload: ${err.message}`);
        process.exit(1);
      }
    }
  }

  try {
    await connect();
    const result = await handler(payload);
    console.log(JSON.stringify(result, null, 2));
    disconnect();
    process.exit(0);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

// Detect if running as CLI (not imported)
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('claude-client.mjs') ||
  process.argv[1].endsWith('claude-client')
);

if (isMainModule) {
  runCLI();
}
