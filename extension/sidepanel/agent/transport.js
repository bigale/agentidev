/**
 * Transport abstraction for agent tool dispatch.
 *
 * In extension context: dispatches via chrome.runtime.sendMessage to the SW.
 * In CLI/server context: dispatches via WebSocket to the bridge server directly.
 *
 * This is the portability boundary — tools call dispatch() without knowing
 * which transport is active. The transport is auto-detected at import time
 * but can be overridden via setTransport().
 */

let _transport = null;
let _mode = 'none'; // 'extension' | 'bridge' | 'none'

/**
 * Override the transport function.
 * @param {(type: string, payload: object) => Promise<object>} fn
 * @param {string} mode - 'extension' or 'bridge'
 */
export function setTransport(fn, mode = 'custom') {
  _transport = fn;
  _mode = mode;
}

/**
 * Get the current transport mode.
 * @returns {string} 'extension' | 'bridge' | 'none'
 */
export function getTransportMode() {
  return _mode;
}

/**
 * Dispatch a message to the appropriate handler.
 * In extension context, this goes to the SW via chrome.runtime.sendMessage.
 * In bridge context, this goes directly to the bridge server via WebSocket.
 *
 * @param {string} type - Message type (e.g. 'BRIDGE_SEND_COMMAND', 'PLUGIN_LIST')
 * @param {object} payload - Message payload
 * @returns {Promise<object>} Response from the handler
 */
export function dispatch(type, payload = {}) {
  if (!_transport) {
    throw new Error('No transport configured. Call autoDetect() or setTransport() first.');
  }
  return _transport(type, payload);
}

/**
 * Auto-detect the available transport and configure it.
 * @returns {string} The detected mode: 'extension' or 'none'
 */
export function autoDetect() {
  // Extension context: chrome.runtime.sendMessage available
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    _transport = extensionTransport;
    _mode = 'extension';
    return 'extension';
  }
  // No transport available — caller must set up bridge transport
  _mode = 'none';
  return 'none';
}

/**
 * Configure bridge WebSocket transport for CLI/server context.
 * Connects to the bridge server and dispatches messages directly.
 *
 * @param {object} options
 * @param {string} [options.host='localhost']
 * @param {number} [options.port=9876]
 * @param {object} [options.ws] - Pre-connected WebSocket instance
 * @returns {Promise<string>} 'bridge' on success
 */
export async function configureBridgeTransport(options = {}) {
  const { host = 'localhost', port = 9876, ws: existingWs } = options;

  let ws = existingWs;
  if (!ws) {
    // Dynamic import for Node.js WebSocket (not available in browser)
    const WebSocket = globalThis.WebSocket || (await import('ws')).default;
    ws = new WebSocket(`ws://${host}:${port}`);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });

    // Identify as agent client
    const identifyMsg = JSON.stringify({
      id: `agent_${Date.now()}`,
      type: 'BRIDGE_IDENTIFY',
      source: 'agent',
      timestamp: Date.now(),
      payload: { role: 'claude', name: 'agent-transport' },
    });
    ws.send(identifyMsg);
    // Wait for identify response
    await new Promise(resolve => {
      const handler = (event) => {
        const data = typeof event.data === 'string' ? event.data : event.toString();
        const msg = JSON.parse(data);
        if (msg.type === 'BRIDGE_IDENTIFY') {
          ws.removeEventListener('message', handler);
          resolve(msg);
        }
      };
      ws.addEventListener('message', handler);
      setTimeout(resolve, 2000); // Don't block forever
    });
  }

  let msgCounter = 0;
  const pending = new Map();

  // Route incoming responses
  ws.addEventListener('message', (event) => {
    const data = typeof event.data === 'string' ? event.data : event.toString();
    const msg = JSON.parse(data);
    if (msg.inReplyTo && pending.has(msg.inReplyTo)) {
      const { resolve } = pending.get(msg.inReplyTo);
      pending.delete(msg.inReplyTo);
      resolve(msg.payload || msg);
    }
  });

  _transport = (type, payload) => {
    return new Promise((resolve, reject) => {
      const id = `agent_${Date.now()}_${++msgCounter}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Bridge request timed out: ${type}`));
      }, 30000);

      pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject,
      });

      // Map tool message types to bridge protocol types
      const bridgeType = BRIDGE_TYPE_MAP[type] || type;
      ws.send(JSON.stringify({
        id,
        type: bridgeType,
        source: 'agent',
        timestamp: Date.now(),
        payload,
      }));
    });
  };

  _mode = 'bridge';
  return 'bridge';
}

// ---- Extension transport ----

function extensionTransport(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response || {});
      }
    });
  });
}

// ---- Bridge type mapping ----
// Maps SW handler message types to bridge protocol message types.
// Types not in this map pass through unchanged (many are already BRIDGE_* prefixed).

const BRIDGE_TYPE_MAP = {
  // Session commands — SW wraps these with command logging, bridge handles directly
  'BRIDGE_CREATE_SESSION':  'BRIDGE_SESSION_CREATE',
  'BRIDGE_DESTROY_SESSION': 'BRIDGE_SESSION_DESTROY',
  'BRIDGE_LIST_SESSIONS':   'BRIDGE_SESSION_LIST',
  // Snapshot — bridge handles directly
  'BRIDGE_TAKE_SNAPSHOT':   'BRIDGE_TAKE_SNAPSHOT',
  // Commands — bridge handles directly
  'BRIDGE_SEND_COMMAND':    'BRIDGE_SEND_COMMAND',
  // Search — bridge has its own vector DB
  'BRIDGE_SEARCH_VECTORDB': 'BRIDGE_SEARCH_VECTORDB',
  // Scripts — bridge manages scripts directly
  'SCRIPT_LAUNCH':          'BRIDGE_SCRIPT_LAUNCH',
  'SCRIPT_LIBRARY_SAVE':    'BRIDGE_SCRIPT_SAVE',
  'SCRIPT_LIBRARY_LIST':    'BRIDGE_SCRIPT_LIST',
  'SCRIPT_LIBRARY_GET':     'BRIDGE_SCRIPT_SOURCE',
  // UI generation — bridge spawns claude CLI
  'SC_GENERATE_UI':         'BRIDGE_SC_GENERATE_UI',
  // Plugin list — extension-only, no bridge equivalent (returns error in bridge mode)
  // 'PLUGIN_LIST': no bridge mapping
  // Test plugin — extension-only (chrome.tabs), no bridge equivalent
  // 'TEST_PLUGIN_IN_TAB': no bridge mapping
};

/**
 * Check if a message type is supported in bridge transport mode.
 * @param {string} type
 * @returns {boolean}
 */
export function isBridgeSupported(type) {
  return type in BRIDGE_TYPE_MAP || type.startsWith('BRIDGE_');
}
