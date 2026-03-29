/**
 * Bridge between sandboxed SmartClient iframe and chrome.runtime.
 * Translates postMessage DS operations to background service worker messages.
 * Also routes AI generation requests (smartclient-ai) to SC_GENERATE_UI handler.
 *
 * Loading modes:
 *   ?app=<id>  — load persisted app from IndexedDB (primary)
 *   ?clone=1   — load from chrome.storage.session (backward compat)
 *   (no params) — show app gallery
 */

const iframe = document.getElementById('sc-frame');
const urlParams = new URLSearchParams(window.location.search);

/**
 * Send a config to the sandboxed iframe as a smartclient-ai-response message.
 */
function sendConfigToIframe(config, capabilities) {
  const doSend = () => {
    try {
      iframe.contentWindow.postMessage({
        source: 'smartclient-ai-response',
        success: true,
        config,
        capabilities: capabilities || {},
      }, '*');
    } catch (e) {
      // iframe not ready yet
    }
  };
  // app.html is sandboxed (manifest) → contentDocument is null (unique origin).
  // Can't check readyState, so send immediately (works if loaded) and also
  // listen for load as fallback (works if still loading).
  doSend();
  iframe.addEventListener('load', doSend, { once: true });
}

// --- Mode 1: Load persisted app by ID ---
const appId = urlParams.get('app');
if (appId) {
  chrome.runtime.sendMessage({ type: 'SC_APP_LOAD', id: appId }, (response) => {
    if (response?.success && response.app?.config) {
      document.title = response.app.name + ' — SmartClient';
      sendConfigToIframe(response.app.config);
    } else {
      console.error('[Bridge] Failed to load app:', response?.error || 'not found');
    }
  });
}

// --- Mode 2: Clone compat (chrome.storage.session) ---
else if (urlParams.get('clone') === '1') {
  chrome.storage.session.get('sc_clone_config', (result) => {
    const config = result?.sc_clone_config;
    if (!config) return;
    chrome.storage.session.remove('sc_clone_config');
    sendConfigToIframe(config);
  });
}

// --- Mode 3: Dashboard (PortalLayout) ---
else if (urlParams.get('mode') === 'dashboard') {
  iframe.addEventListener('load', function () {
    iframe.contentWindow.postMessage({ source: 'smartclient-load-dashboard' }, '*');
  }, { once: true });
}

// --- Mode 4: Playground (prompt bar + default Notes app) ---
else if (urlParams.get('mode') === 'playground') {
  // Just let app.html load naturally — shows prompt bar + Notes CRUD
}

// --- Mode 5: Gallery (no params) ---
else {
  buildGallery();
}

async function buildGallery() {
  // Hide iframe, show gallery in wrapper page
  iframe.style.display = 'none';

  const overlay = document.createElement('div');
  overlay.id = 'app-gallery';
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', background: '#1a1a2e', color: '#e0e0e0',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    overflow: 'auto', padding: '32px',
  });

  overlay.innerHTML = '<h1 style="margin:0 0 8px 0;font-size:22px;">SmartClient Apps</h1>'
    + '<p style="color:#888;margin:0 0 24px 0;font-size:13px;">Saved apps from AI generation and site cloning</p>'
    + '<div id="gallery-list" style="display:flex;flex-wrap:wrap;gap:16px;"></div>';

  document.body.appendChild(overlay);

  try {
    // Merge apps from IndexedDB (SC_APP_LIST) and bridge disk (AF_APP_LIST)
    const [idbResponse, bridgeResponse] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'SC_APP_LIST' }).catch(() => null),
      sendMessageWithTimeout({ type: 'AF_APP_LIST' }).catch(() => null),
    ]);

    const appMap = new Map();
    // IndexedDB apps first
    if (idbResponse?.success && idbResponse.apps) {
      for (const a of idbResponse.apps) appMap.set(a.id, a);
    }
    // Bridge apps override (disk is source of truth for Phase 5b)
    if (bridgeResponse?.success && bridgeResponse.apps) {
      for (const a of bridgeResponse.apps) appMap.set(a.id, a);
    }
    const allApps = [...appMap.values()].sort((a, b) =>
      (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    const list = document.getElementById('gallery-list');

    if (allApps.length === 0) {
      list.innerHTML = '<p style="color:#666;">No saved apps yet. Generate or clone one from the dashboard.</p>';
      return;
    }

    for (const app of allApps) {
      const card = document.createElement('div');
      Object.assign(card.style, {
        background: '#252540', borderRadius: '8px', padding: '16px', width: '240px',
        cursor: 'pointer', border: '1px solid #333', transition: 'border-color 0.15s',
      });
      card.onmouseenter = () => card.style.borderColor = '#5a5a8a';
      card.onmouseleave = () => card.style.borderColor = '#333';

      const badge = app.type === 'clone'
        ? '<span style="background:#2d6a4f;color:#b7e4c7;padding:2px 6px;border-radius:3px;font-size:10px;margin-left:8px;">CLONE</span>'
        : '<span style="background:#1d3557;color:#a8dadc;padding:2px 6px;border-radius:3px;font-size:10px;margin-left:8px;">GEN</span>';

      const date = app.updatedAt ? new Date(app.updatedAt).toLocaleDateString() : '';
      const dsCount = app.config?.dataSources?.length || 0;

      card.innerHTML = `<div style="font-weight:600;font-size:14px;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">`
        + `${escapeHtml(app.name)}${badge}</div>`
        + `<div style="font-size:11px;color:#888;">${dsCount} DataSource${dsCount !== 1 ? 's' : ''} &middot; ${date}</div>`;

      card.addEventListener('click', () => {
        window.location.href = `wrapper.html?app=${encodeURIComponent(app.id)}`;
      });

      // Delete button
      const delBtn = document.createElement('button');
      Object.assign(delBtn.style, {
        marginTop: '10px', background: 'transparent', border: '1px solid #555',
        color: '#888', padding: '3px 8px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer',
      });
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        // Delete from both IndexedDB and bridge disk
        await Promise.all([
          chrome.runtime.sendMessage({ type: 'SC_APP_DELETE', id: app.id }).catch(() => null),
          sendMessageWithTimeout({ type: 'AF_APP_DELETE', id: app.id }).catch(() => null),
        ]);
        card.remove();
      });
      card.appendChild(delBtn);

      list.appendChild(card);
    }
  } catch (err) {
    document.getElementById('gallery-list').innerHTML = `<p style="color:#c44;">Error loading apps: ${escapeHtml(err.message)}</p>`;
  }
}

function escapeHtml(str) {
  const el = document.createElement('span');
  el.textContent = str || '';
  return el.innerHTML;
}

// --- Broadcast → DataSource invalidation ---
// Forward bridge broadcasts to the sandbox so grids auto-refresh.

const BROADCAST_DS_MAP = {
  AUTO_BROADCAST_SCRIPT: 'BridgeScripts',
  AUTO_BROADCAST_STATUS: 'BridgeSessions',
  AUTO_BROADCAST_SCHEDULE: 'BridgeSchedules',
  AUTO_COMMAND_UPDATE: 'BridgeCommands',
  AUTO_BROADCAST_ARTIFACT: null,         // No DS invalidation, just forward
  AUTO_BROADCAST_RUN_COMPLETE: 'ScriptRuns', // Invalidate ScriptRuns DS
};

chrome.runtime.onMessage.addListener((message) => {
  // Playground mode: skin change triggers iframe reload
  if (message.type === 'AUTO_BROADCAST_SC_SKIN' && urlParams.get('mode') === 'playground') {
    iframe.src = 'app.html?skin=' + encodeURIComponent(message.skin);
    iframe.addEventListener('load', () => {
      chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_STATE' }, (state) => {
        if (state?.config) {
          sendConfigToIframe(state.config, state.capabilities);
        }
      });
    }, { once: true });
    return;
  }

  // Playground mode: accept broadcast configs from sidepanel controller
  if (message.type === 'AUTO_BROADCAST_SC_CONFIG' && urlParams.get('mode') === 'playground') {
    if (message.config) sendConfigToIframe(message.config, message.capabilities);
    return;
  }

  const dsId = BROADCAST_DS_MAP[message.type];
  if (dsId) {
    try {
      iframe.contentWindow.postMessage({
        source: 'smartclient-ds-update',
        dataSource: dsId,
      }, '*');
    } catch (e) {
      // iframe may not be loaded yet — safe to ignore
    }
  }

  // Forward full broadcast payloads for dashboard-app.js
  if (message.type && (message.type.startsWith('AUTO_BROADCAST_') || message.type === 'AUTO_COMMAND_UPDATE')) {
    try {
      iframe.contentWindow.postMessage({
        source: 'smartclient-broadcast',
        type: message.type,
        payload: message,
      }, '*');
    } catch (e) {
      // iframe may not be loaded yet
    }
  }
});

// --- Timeout helper for chrome.runtime.sendMessage ---

const MSG_TIMEOUT_MS = 15000; // 15s default

function sendMessageWithTimeout(outMsg, timeoutMs = MSG_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout: ${outMsg.type} (${timeoutMs}ms)`));
    }, timeoutMs);
    chrome.runtime.sendMessage(outMsg, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// --- DataSource CRUD and AI message forwarding ---

window.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg) return;

  // Skin change from in-app picker (sandbox postMessage → extension message)
  if (msg.source === 'smartclient-skin-change') {
    chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_SET_SKIN', skin: msg.skin });
    return;
  }

  // Action proxy — forward arbitrary chrome.runtime.sendMessage calls from sandbox
  if (msg.source === 'smartclient-action') {
    const outMsg = { type: msg.messageType, ...msg.payload };
    console.log('[Bridge] Action relay:', JSON.stringify(outMsg));
    sendMessageWithTimeout(outMsg).then((response) => {
      try {
        iframe.contentWindow.postMessage({
          source: 'smartclient-action-response',
          id: msg.id,
          response: response,
        }, '*');
      } catch (e) {
        // ignore
      }
    }).catch((err) => {
      console.warn('[Bridge] Action timeout/error:', outMsg.type, err.message);
      try {
        iframe.contentWindow.postMessage({
          source: 'smartclient-action-response',
          id: msg.id,
          response: { success: false, error: err.message },
        }, '*');
      } catch (e) {
        // ignore
      }
    });
    return;
  }

  // DataSource CRUD operations
  if (msg.source === 'smartclient-ds') {
    const type = 'DS_' + msg.operationType.toUpperCase();

    try {
      const response = await sendMessageWithTimeout({
        type,
        dataSource: msg.dataSource,
        data: msg.data,
        criteria: msg.criteria,
      });

      iframe.contentWindow.postMessage({
        source: 'smartclient-ds-response',
        id: msg.id,
        status: response?.status ?? -1,
        data: response?.data,
        totalRows: response?.totalRows,
      }, '*');
    } catch (err) {
      iframe.contentWindow.postMessage({
        source: 'smartclient-ds-response',
        id: msg.id,
        status: -1,
        data: err.message,
      }, '*');
    }
    return;
  }

  // Layout persistence — save
  if (msg.source === 'smartclient-save-layout') {
    chrome.storage.local.set({ sc_dashboard_layout: msg.layout });
    return;
  }

  // Layout persistence — load
  if (msg.source === 'smartclient-load-layout') {
    chrome.storage.local.get('sc_dashboard_layout', (result) => {
      try {
        iframe.contentWindow.postMessage({
          source: 'smartclient-layout-loaded',
          layout: result?.sc_dashboard_layout || null,
        }, '*');
      } catch (e) {
        // iframe may not be ready
      }
    });
    return;
  }

  // Agentiface theme persistence
  if (msg.source === 'agentiface-theme-set') {
    chrome.storage.local.set({ agentiface_theme: msg.theme });
    return;
  }
  if (msg.source === 'agentiface-theme-request') {
    chrome.storage.local.get('agentiface_theme', (result) => {
      try {
        iframe.contentWindow.postMessage({
          source: 'agentiface-theme-response',
          theme: result?.agentiface_theme || 'light',
        }, '*');
      } catch (e) {
        // iframe may not be ready
      }
    });
    return;
  }

  // AI UI generation (Phase 5b: supports modification mode via currentConfig)
  // Uses 60s timeout — modification mode sends larger payload to claude -p
  if (msg.source === 'smartclient-ai') {
    try {
      const outMsg = { type: 'SC_GENERATE_UI', prompt: msg.prompt };
      if (msg.currentConfig) outMsg.currentConfig = msg.currentConfig;

      const response = await sendMessageWithTimeout(outMsg, 60000);

      iframe.contentWindow.postMessage({
        source: 'smartclient-ai-response',
        success: response.success,
        config: response.config,
        error: response.error,
      }, '*');
    } catch (err) {
      iframe.contentWindow.postMessage({
        source: 'smartclient-ai-response',
        success: false,
        error: err.message,
      }, '*');
    }
  }
});
