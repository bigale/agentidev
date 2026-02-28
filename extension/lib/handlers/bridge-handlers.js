/**
 * Bridge (Playwright) message handlers.
 * Extracted from background.js lines 309-398.
 * Enhanced with command logging and broadcast forwarding (Phase 1).
 */
import * as bridgeClient from '../bridge-client.js';
import { state } from '../init-state.js';

// Command log: circular buffer for tracking all bridge commands
const commandLog = [];
const MAX_LOG = 200;

function logCommand(type, sessionId, request, source = 'extension') {
  const entry = {
    id: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type,
    sessionId,
    request,
    source,
    timestamp: Date.now(),
    status: 'running',
  };
  if (commandLog.length >= MAX_LOG) commandLog.shift();
  commandLog.push(entry);
  chrome.runtime.sendMessage({ type: 'AUTO_COMMAND_UPDATE', entry }).catch(() => {});
  return entry;
}

function completeCommand(entry, response, error) {
  entry.status = error ? 'error' : 'success';
  entry.response = error ? { error: error.message || String(error) } : response;
  entry.duration = Date.now() - entry.timestamp;
  chrome.runtime.sendMessage({ type: 'AUTO_COMMAND_UPDATE', entry }).catch(() => {});
}

// Wrap a bridge call with command logging
async function tracked(type, sessionId, request, fn) {
  const entry = logCommand(type, sessionId, request);
  try {
    const result = await fn();
    completeCommand(entry, result);
    return result;
  } catch (error) {
    completeCommand(entry, null, error);
    throw error;
  }
}

export function register(handlers) {
  handlers['BRIDGE_CONNECT'] = async (msg) => {
    await bridgeClient.connectToBridge(msg.port || 9876);
    return { success: true, connected: true };
  };

  handlers['BRIDGE_DISCONNECT'] = async () => {
    bridgeClient.disconnectFromBridge();
    return { success: true, connected: false };
  };

  handlers['BRIDGE_STATUS'] = async () => {
    return { connected: bridgeClient.isConnected() };
  };

  handlers['BRIDGE_CREATE_SESSION'] = async (msg) => {
    const result = await tracked('create_session', null, { name: msg.name }, () =>
      bridgeClient.createSession(msg.name, msg.options || {})
    );
    return { success: true, ...result };
  };

  handlers['BRIDGE_DESTROY_SESSION'] = async (msg) => {
    const result = await tracked('destroy_session', msg.sessionId, {}, () =>
      bridgeClient.destroySession(msg.sessionId)
    );
    return { success: true, ...result };
  };

  handlers['BRIDGE_LIST_SESSIONS'] = async () => {
    const result = await bridgeClient.listSessions();
    return { success: true, ...result };
  };

  handlers['BRIDGE_SEND_COMMAND'] = async (msg) => {
    const result = await tracked('command', msg.sessionId, { command: msg.command }, () =>
      bridgeClient.sendCommand(msg.sessionId, msg.command)
    );
    return { success: true, ...result };
  };

  handlers['BRIDGE_TAKE_SNAPSHOT'] = async (msg) => {
    const result = await tracked('snapshot', msg.sessionId, {}, () =>
      bridgeClient.takeSnapshot(msg.sessionId)
    );

    // Also store snapshot in vector DB for intelligence layer
    if (result.yaml) {
      try {
        // Import dynamically to avoid circular dependency
        const { handleSnapshotStorage } = await import('./snapshot-handlers.js');
        await handleSnapshotStorage(msg.sessionId, result.yaml, result.url);
      } catch (err) {
        console.warn('[Background] Snapshot storage failed (non-fatal):', err.message);
      }
    }
    return { success: true, ...result };
  };

  handlers['BRIDGE_NAVIGATE'] = async (msg) => {
    const result = await tracked('navigate', msg.sessionId, { url: msg.url }, () =>
      bridgeClient.navigateSession(msg.sessionId, msg.url)
    );
    return { success: true, ...result };
  };

  handlers['BRIDGE_CLICK'] = async (msg) => {
    const result = await tracked('click', msg.sessionId, { ref: msg.ref }, () =>
      bridgeClient.clickRef(msg.sessionId, msg.ref)
    );
    return { success: true, ...result };
  };

  handlers['BRIDGE_FILL'] = async (msg) => {
    const result = await tracked('fill', msg.sessionId, { ref: msg.ref, value: msg.value }, () =>
      bridgeClient.fillRef(msg.sessionId, msg.ref, msg.value)
    );
    return { success: true, ...result };
  };

  handlers['BRIDGE_EVAL'] = async (msg) => {
    const result = await tracked('eval', msg.sessionId, { expr: msg.expr }, () =>
      bridgeClient.evalInSession(msg.sessionId, msg.expr)
    );
    return { success: true, ...result };
  };

  // Command log retrieval
  handlers['GET_COMMAND_LOG'] = async () => {
    return { log: commandLog };
  };
}

/**
 * Set up bridge event callbacks that forward broadcasts to extension UIs.
 * Called once during background initialization.
 */
export function initBridgeCallbacks(snapshotStorageFn) {
  bridgeClient.onSnapshotReceived(async (data) => {
    console.log(`[Background] Snapshot broadcast received (${data.lines} lines)`);
    // Forward to sidepanel
    chrome.runtime.sendMessage({ type: 'AUTO_BROADCAST_SNAPSHOT', ...data }).catch(() => {});
    // Also store
    if (data.yaml && data.url) {
      try {
        await snapshotStorageFn(data.sessionId, data.yaml, data.url);
      } catch (err) {
        console.warn('[Background] Auto-store snapshot failed:', err.message);
      }
    }
  });

  bridgeClient.onStatusChange((data) => {
    console.log(`[Background] Bridge status: session=${data.sessionId} state=${data.state}`);
    chrome.runtime.sendMessage({ type: 'AUTO_BROADCAST_STATUS', ...data }).catch(() => {});
  });

  bridgeClient.onConnectionChange((data) => {
    console.log(`[Background] Bridge connection: ${data.connected ? 'connected' : 'disconnected'}`);
    chrome.runtime.sendMessage({ type: 'AUTO_BROADCAST_CONNECTION', ...data }).catch(() => {});
  });

  bridgeClient.onSearchRequest(async (query, options) => {
    console.log(`[Background] Bridge search request: "${query}"`);
    const { handleSnapshotSearch } = await import('./snapshot-handlers.js');
    return handleSnapshotSearch(query, options);
  });
}
