/**
 * CheerpX handler — service worker routing between arbitrary extension
 * pages and a hidden background tab that hosts the runtime.
 *
 * Why a tab and not an offscreen iframe (the way CheerpJ is done):
 * CheerpX needs cross-origin isolation (SharedArrayBuffer + worker
 * coordination semantics). asset-server can send COOP/COEP for the
 * cheerpx-runtime.html page, but for the iframe inside an extension
 * offscreen document to claim COI=true, the entire ancestor chain has to
 * be COEP-enabled, and MV3 doesn't expose a way to set COEP on extension
 * pages. A top-level tab gets its own agent cluster and can be COI on its
 * own.
 *
 * Flow:
 *   any page
 *     -> host.runtimes.get('cheerpx').spawn(cmd, args, opts)
 *     -> host.message.send('cheerpx-spawn', payload)
 *     -> wrapper/bridge.js postMessage to service worker
 *     -> chrome.runtime.onMessage -> this handler
 *     -> ensureCheerpXTab(): finds or creates the hidden tab + injects
 *        the cheerpx-content bridge + waits for CHEERPX_TAB_READY
 *     -> chrome.tabs.sendMessage(tabId, { type: 'CHEERPX_INVOKE', ... })
 *     -> cheerpx-content.js bridge -> window.postMessage to runtime page
 *     -> CheerpX.Linux.run captures stdout, replies back through the chain
 */

const CHEERPX_URL_BASE = 'http://localhost:9877/cheerpx-runtime.html';
const CONTENT_SCRIPT = 'cheerpx-content.js';

// Cache-bust the runtime page on each fresh-tab creation. asset-server sends
// max-age=3600 for HTML, so without ?t= the browser HTTP cache may serve a
// stale runtime page after we update it during dev. The query string only
// matters for tab creation; once the tab is open, we leave it alone.
function freshUrl() {
  return CHEERPX_URL_BASE + '?t=' + Date.now();
}

let _tabId = null;
let _ensureInFlight = null;

// The content-script bridge pings the SW once its onMessage listener is
// installed. ensureCheerpXTab() blocks on this signal so the first
// CHEERPX_INVOKE doesn't race the bridge install.
let _readyPromise = null;
let _readyResolver = null;

function resetReadyPromise() {
  _readyPromise = new Promise((resolve) => { _readyResolver = resolve; });
}
resetReadyPromise();

/**
 * Called from the service worker's onMessage listener when the cheerpx
 * content-script bridge signals it's ready.
 */
export function markTabReady() {
  if (_readyResolver) _readyResolver();
}

async function findExistingTab() {
  try {
    const tabs = await chrome.tabs.query({ url: CHEERPX_URL_BASE + '*' });
    if (tabs && tabs.length > 0) {
      console.log('[CheerpX] found existing tab', tabs[0].id);
      return tabs[0].id;
    }
  } catch (err) {
    console.warn('[CheerpX] tabs.query failed:', err.message);
  }
  return null;
}

async function tabExists(tabId) {
  if (typeof tabId !== 'number') return false;
  try {
    const t = await chrome.tabs.get(tabId);
    return !!t;
  } catch {
    return false;
  }
}

async function injectBridge(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: [CONTENT_SCRIPT],
  });
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const t = await chrome.tabs.get(tabId);
  if (t.status === 'complete') return;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('cheerpx tab load timeout (' + timeoutMs + 'ms)'));
    }, timeoutMs);
    function listener(updatedId, info) {
      if (updatedId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Ensure a cheerpx-runtime tab exists, has the bridge installed, and has
 * signaled ready. Self-heals if the tracked tab was closed.
 */
async function ensureCheerpXTab() {
  // Self-heal: if our cached tabId points at a closed tab, drop it.
  if (_tabId !== null && !(await tabExists(_tabId))) {
    console.log('[CheerpX] cached tab', _tabId, 'is gone, resetting');
    _tabId = null;
    _ensureInFlight = null;
    resetReadyPromise();
  }

  if (_ensureInFlight) return _ensureInFlight;

  _ensureInFlight = (async () => {
    // First check if a previously-launched tab is still around (covers SW
    // restart where module state is lost but the tab is still alive).
    if (_tabId === null) {
      _tabId = await findExistingTab();
    }

    if (_tabId === null) {
      const url = freshUrl();
      console.log('[CheerpX] creating background tab:', url);
      resetReadyPromise();
      const tab = await chrome.tabs.create({ url, active: false });
      _tabId = tab.id;
      console.log('[CheerpX] tab created', _tabId);
      await waitForTabComplete(_tabId);
      console.log('[CheerpX] tab loaded, injecting bridge');
      await injectBridge(_tabId);
    } else {
      // Existing tab from a previous SW lifetime. The bridge was injected
      // before but is gone (tab navigation? extension reload?). Re-inject
      // — the script is idempotent via the __agentidevCheerpXBridgeInstalled
      // window flag, but a navigated/reloaded tab will accept it freshly.
      console.log('[CheerpX] reusing existing tab', _tabId, '— re-injecting bridge');
      resetReadyPromise();
      try {
        await injectBridge(_tabId);
      } catch (err) {
        console.warn('[CheerpX] bridge re-inject failed:', err.message);
      }
    }

    // Wait for the bridge to signal ready
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('CheerpX tab ready timeout (15s)')), 15000));
    await Promise.race([_readyPromise, timeout]);
    console.log('[CheerpX] tab ready');
  })();

  try {
    await _ensureInFlight;
  } catch (err) {
    _ensureInFlight = null;
    throw err;
  }
  return _ensureInFlight;
}

async function invokeTab(command, payload) {
  await ensureCheerpXTab();
  let response;
  try {
    response = await chrome.tabs.sendMessage(_tabId, {
      type: 'CHEERPX_INVOKE',
      command: command,
      payload: payload || {},
    });
  } catch (err) {
    // Tab might have been closed between ensure and sendMessage
    _tabId = null;
    _ensureInFlight = null;
    throw new Error('CheerpX tab unreachable: ' + (err && err.message || err));
  }
  if (!response) {
    throw new Error('CheerpX tab returned no response');
  }
  if (response.success === false) {
    throw new Error(response.error || 'CheerpX invoke failed');
  }
  return response;
}

// ---------------------------------------------------------------------------
// Register message handlers
// ---------------------------------------------------------------------------

export function register(handlers) {
  // The content-script bridge signals readiness here.
  handlers['CHEERPX_TAB_READY'] = async (msg) => {
    console.log('[CheerpX] tab ready signal received');
    markTabReady();
    return { success: true };
  };

  handlers['cheerpx-ping'] = async (msg) => {
    return invokeTab('ping', {});
  };

  handlers['cheerpx-init'] = async (msg) => {
    return invokeTab('init', { options: msg.options || {} });
  };

  handlers['cheerpx-spawn'] = async (msg) => {
    return invokeTab('spawn', {
      cmd: msg.cmd,
      args: msg.args || [],
      opts: msg.opts || {},
      options: msg.options || {},
    });
  };

  // ---- Filesystem operations ----
  // Each routes to a corresponding `fs-*` command on the runtime page,
  // which uses cx.run() under the hood (cat / sh / ls). Phase 4.6 will
  // replace these with native CheerpX filesystem APIs once we surface
  // them through the runtime iframe.

  handlers['cheerpx-fs-read'] = async (msg) => {
    return invokeTab('fs-read', { path: msg.path });
  };

  handlers['cheerpx-fs-write'] = async (msg) => {
    return invokeTab('fs-write', { path: msg.path, content: msg.content });
  };

  handlers['cheerpx-fs-list'] = async (msg) => {
    return invokeTab('fs-list', { path: msg.path });
  };

  handlers['cheerpx-fs-read-bytes'] = async (msg) => {
    return invokeTab('fs-read-bytes', { path: msg.path });
  };

  // ---- Streaming spawn via long-lived chrome.tabs.connect Port ----
  //
  // The caller (host.exec.spawnStream → HOST_EXEC_SPAWN_STREAM_START)
  // provides a streamId. We open a port to the cheerpx tab's content
  // script, send the spawn-stream command, and relay each port message
  // (stdout chunk, exit, error) to the wider extension via
  // chrome.runtime.sendMessage broadcast — wrapper.html's onMessage
  // listener picks them up and forwards to the SC sandbox iframe.

  const _streamPorts = new Map(); // streamId -> Port

  handlers['cheerpx-spawn-stream-start'] = async (msg) => {
    if (!msg.streamId) throw new Error('spawn-stream requires streamId');
    await ensureCheerpXTab();

    const port = chrome.tabs.connect(_tabId, { name: 'cheerpx-stream' });
    _streamPorts.set(msg.streamId, port);

    port.onMessage.addListener((evt) => {
      if (!evt || !evt.type) return;
      // Broadcast to all extension contexts (wrapper.html will pick it up)
      chrome.runtime.sendMessage({
        type: 'CHEERPX_STREAM_EVENT',
        streamId: msg.streamId,
        event: evt,
      }).catch(() => {}); // ignore errors when no listeners present
      if (evt.type === 'exit' || evt.type === 'error') {
        _streamPorts.delete(msg.streamId);
        try { port.disconnect(); } catch {}
      }
    });

    port.onDisconnect.addListener(() => {
      _streamPorts.delete(msg.streamId);
    });

    port.postMessage({
      type: 'spawn-stream',
      streamId: msg.streamId,
      cmd: msg.cmd,
      args: msg.args || [],
      opts: msg.opts || {},
    });

    return { success: true, streamId: msg.streamId };
  };

  handlers['cheerpx-spawn-stream-kill'] = async (msg) => {
    const port = _streamPorts.get(msg.streamId);
    if (!port) return { success: false, error: 'no such stream' };
    try {
      port.postMessage({ type: 'kill', streamId: msg.streamId });
    } catch {}
    _streamPorts.delete(msg.streamId);
    try { port.disconnect(); } catch {}
    return { success: true };
  };
}

// Re-export the tab id reference so SW eval can inspect it for diagnostics
// (only useful in dev — production callers should never need it).
function _getTabId() { return _tabId; }
export { _getTabId };
