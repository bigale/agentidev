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
function sendConfigToIframe(config) {
  const doSend = () => {
    iframe.contentWindow.postMessage({
      source: 'smartclient-ai-response',
      success: true,
      config,
    }, '*');
  };
  if (iframe.contentDocument?.readyState === 'complete') {
    doSend();
  } else {
    iframe.addEventListener('load', doSend, { once: true });
  }
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

// --- Mode 3: Gallery (no params) ---
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
    const response = await chrome.runtime.sendMessage({ type: 'SC_APP_LIST' });
    const list = document.getElementById('gallery-list');

    if (!response?.success || !response.apps?.length) {
      list.innerHTML = '<p style="color:#666;">No saved apps yet. Generate or clone one from the dashboard.</p>';
      return;
    }

    for (const app of response.apps) {
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
        const resp = await chrome.runtime.sendMessage({ type: 'SC_APP_DELETE', id: app.id });
        if (resp?.success) card.remove();
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
};

chrome.runtime.onMessage.addListener((message) => {
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
});

// --- DataSource CRUD and AI message forwarding ---

window.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg) return;

  // DataSource CRUD operations
  if (msg.source === 'smartclient-ds') {
    const type = 'DS_' + msg.operationType.toUpperCase();

    try {
      const response = await chrome.runtime.sendMessage({
        type,
        dataSource: msg.dataSource,
        data: msg.data,
        criteria: msg.criteria,
      });

      iframe.contentWindow.postMessage({
        source: 'smartclient-ds-response',
        id: msg.id,
        status: response.status,
        data: response.data,
        totalRows: response.totalRows,
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

  // AI UI generation
  if (msg.source === 'smartclient-ai') {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SC_GENERATE_UI',
        prompt: msg.prompt,
      });

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
