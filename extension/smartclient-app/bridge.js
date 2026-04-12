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
 * Buffers the config until the sandbox signals 'smartclient-ready' (after SC Page.load).
 * This prevents a race where config arrives before isc.Page.load, causing the default
 * Notes app to be created on top of the rendered config.
 */
let _sandboxReady = false;
let _pendingConfig = null;
let _pendingCapabilities = null;
let _navigating = false; // true while iframe is loading after src change

function sendConfigToIframe(config, capabilities) {
  if (_sandboxReady) {
    _doSendConfig(config, capabilities);
  } else {
    // Buffer until sandbox is ready
    _pendingConfig = config;
    _pendingCapabilities = capabilities;
  }
}

function _doSendConfig(config, capabilities) {
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
}

/** Call before changing iframe.src to invalidate stale ready signals. */
function _beginIframeNavigation() {
  _sandboxReady = false;
  _navigating = true;
}

// Listen for sandbox ready signal (sent after isc.Page.load in app.js)
window.addEventListener('message', (event) => {
  if (event.data?.source === 'smartclient-ready') {
    if (_navigating) return; // stale signal from old page being replaced
    _sandboxReady = true;
    if (_pendingConfig) {
      _doSendConfig(_pendingConfig, _pendingCapabilities);
      _pendingConfig = null;
      _pendingCapabilities = null;
    }
  }
});

// When iframe finishes loading, clear navigation flag so next ready signal is accepted
iframe.addEventListener('load', () => { _navigating = false; });

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

// --- Mode 4: Playground (DEPRECATED — redirects to plugin mode) ---
// + New now creates plugins directly. Legacy playground URLs redirect to
// the most recently edited plugin, or create a blank one if none exist.
else if (urlParams.get('mode') === 'playground') {
  chrome.runtime.sendMessage({ type: 'PLUGIN_LIST' }, (plugins) => {
    const list = Array.isArray(plugins) ? plugins : [];
    // Find the most recently created storage-backed plugin
    const storagePlugins = list.filter(p => p.description && p.description.includes('Published from Agentiface') || p.id && p.id.startsWith('proj_'));
    if (storagePlugins.length > 0) {
      // Redirect to the most recent one
      const latest = storagePlugins[storagePlugins.length - 1];
      const mode = (latest.modes && latest.modes[0]) || latest.id;
      window.location.replace('wrapper.html?mode=' + encodeURIComponent(mode));
    } else {
      // No plugins — fall back to the old playground behavior so
      // existing workflows don't break. This path will be removed in D4.
      const templateId = urlParams.get('template');
      chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_STATE' }, (state) => {
        if (!state) return;
        if (state.skin && state.skin !== 'Tahoe') {
          _beginIframeNavigation();
          iframe.src = 'app.html?skin=' + encodeURIComponent(state.skin);
        }
        if (state.config) {
          sendConfigToIframe(state.config, state.capabilities);
        } else if (templateId) {
          applyTemplate(templateId, state.capabilities);
        }
      });
    }
  });
}

// --- Mode 5: Load project by ID ---
else if (urlParams.get('project')) {
  const projectId = urlParams.get('project');
  sendMessageWithTimeout({ type: 'SC_PLAYGROUND_LOAD_PROJECT', id: projectId }).then((response) => {
    if (response?.success && response.project?.config) {
      document.title = response.project.name + ' — Agentiface';
      sendConfigToIframe(response.project.config, response.project.capabilities);
    } else if (response?.success) {
      // Project exists but has no config yet — just set title
      document.title = (response.project?.name || 'Project') + ' — Agentiface';
    } else {
      console.error('[Bridge] Failed to load project:', response?.error || 'not found');
    }
  }).catch((err) => {
    console.error('[Bridge] Failed to load project:', err.message);
  });
}

// --- Mode 7: Plugin mode (any other ?mode=<id> resolves via plugin loader) ---
else if (urlParams.get('mode')) {
  const pluginMode = urlParams.get('mode');
  // Ask the SW if a plugin claims this mode. PLUGIN_LIST returns the
  // installed plugins; we match by id (which is what the manifest's modes
  // entries are expected to use 1:1 in the simple case).
  chrome.runtime.sendMessage({ type: 'PLUGIN_LIST' }, (plugins) => {
    if (chrome.runtime.lastError) {
      console.error('[Bridge] PLUGIN_LIST failed:', chrome.runtime.lastError.message);
      return;
    }
    const list = Array.isArray(plugins) ? plugins : [];
    const match = list.find((p) =>
      p.id === pluginMode || (Array.isArray(p.modes) && p.modes.includes(pluginMode)));
    if (!match) {
      console.warn('[Bridge] No plugin claims mode:', pluginMode, '— installed:', list.map((p) => p.id));
      // Fall back to the gallery so the user isn't stuck on a blank page
      buildGallery();
      return;
    }
    // Fetch the plugin's dashboard template via the SW and feed it to the
    // sandbox via the same path the AI generation uses.
    chrome.runtime.sendMessage({ type: 'PLUGIN_GET_TEMPLATE', id: match.id, template: 'dashboard' }, (resp) => {
      if (chrome.runtime.lastError) {
        console.error('[Bridge] PLUGIN_GET_TEMPLATE failed:', chrome.runtime.lastError.message);
        return;
      }
      if (!resp || resp.error || !resp.config) {
        console.error('[Bridge] plugin template error:', resp && resp.error);
        return;
      }
      document.title = match.name + ' — Agentidev';
      sendConfigToIframe(resp.config);
      // Push the plugin config to the playground session so the sidebar
      // can see it (Inspector button visibility, AI modification, etc.)
      chrome.runtime.sendMessage({
        type: 'SC_PLAYGROUND_CONFIG_UPDATED',
        config: resp.config,
      });
    });
  });
}

// --- Mode 6: Gallery (no params) ---
else {
  buildGallery();
}

/**
 * Load a bundled template config from the sandbox's TemplateManager and send to background.
 */
function applyTemplate(templateId, capabilities) {
  // Wait for iframe to be ready, then ask it for the template config
  const onLoad = () => {
    iframe.contentWindow.postMessage({
      source: 'smartclient-get-template',
      templateId,
    }, '*');
  };
  iframe.addEventListener('load', onLoad, { once: true });

  // Listen for the template response
  const handler = (event) => {
    const msg = event.data;
    if (msg?.source === 'smartclient-template-response' && msg.templateId === templateId) {
      window.removeEventListener('message', handler);
      if (msg.config) {
        // Push config to background session
        chrome.runtime.sendMessage({
          type: 'SC_PLAYGROUND_CONFIG_UPDATED',
          config: msg.config,
        });
        // Set template prompt for AI context
        if (msg.aiSystemPrompt) {
          chrome.runtime.sendMessage({
            type: 'SC_PLAYGROUND_SET_TEMPLATE',
            templatePrompt: msg.aiSystemPrompt,
          });
        }
        // Render in iframe
        sendConfigToIframe(msg.config, capabilities);
      }
    }
  };
  window.addEventListener('message', handler);
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

  overlay.innerHTML = '<h1 style="margin:0 0 8px 0;font-size:22px;">Agentiface</h1>'
    + '<p style="color:#888;margin:0 0 24px 0;font-size:13px;">Projects and apps from AI generation and site cloning</p>'
    + '<div id="gallery-projects" style="margin-bottom:24px;"></div>'
    + '<div id="gallery-apps"></div>';

  document.body.appendChild(overlay);

  try {
    // Fetch projects and apps in parallel
    const [projResponse, idbResponse, bridgeResponse] = await Promise.all([
      sendMessageWithTimeout({ type: 'AF_PROJECT_LIST' }).catch(() => null),
      chrome.runtime.sendMessage({ type: 'SC_APP_LIST' }).catch(() => null),
      sendMessageWithTimeout({ type: 'AF_APP_LIST' }).catch(() => null),
    ]);

    // ---- Projects section ----
    const projSection = document.getElementById('gallery-projects');
    const projects = (projResponse?.success && projResponse.projects) ? projResponse.projects : [];

    if (projects.length > 0) {
      projSection.innerHTML = '<h2 style="margin:0 0 12px 0;font-size:16px;color:#a8b4ff;">Projects</h2>'
        + '<div style="display:flex;flex-wrap:wrap;gap:16px;"></div>';
      const projList = projSection.querySelector('div');

      for (const proj of projects) {
        const card = document.createElement('div');
        Object.assign(card.style, {
          background: '#252540', borderRadius: '8px', padding: '16px', width: '240px',
          cursor: 'pointer', border: '1px solid #3a3a6a', transition: 'border-color 0.15s',
        });
        card.onmouseenter = () => card.style.borderColor = '#6a6aaa';
        card.onmouseleave = () => card.style.borderColor = '#3a3a6a';

        const badge = '<span style="background:#1d3557;color:#a8dadc;padding:2px 6px;border-radius:3px;font-size:10px;margin-left:8px;">PROJECT</span>';
        const date = proj.updatedAt ? new Date(proj.updatedAt).toLocaleDateString() : '';
        const compCount = proj.componentCount || 0;

        card.innerHTML = `<div style="font-weight:600;font-size:14px;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">`
          + `${escapeHtml(proj.name)}${badge}</div>`
          + (proj.description ? `<div style="font-size:11px;color:#aaa;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(proj.description)}</div>` : '')
          + `<div style="font-size:11px;color:#888;">${compCount} DataSource${compCount !== 1 ? 's' : ''} &middot; ${date}</div>`;

        card.addEventListener('click', () => {
          window.location.href = `wrapper.html?project=${encodeURIComponent(proj.id)}`;
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
          await Promise.all([
            chrome.runtime.sendMessage({ type: 'SC_PROJECT_DELETE', id: proj.id }).catch(() => null),
            sendMessageWithTimeout({ type: 'AF_PROJECT_DELETE', id: proj.id }).catch(() => null),
          ]);
          card.remove();
        });
        card.appendChild(delBtn);

        projList.appendChild(card);
      }
    }

    // ---- Legacy Apps section ----
    const appMap = new Map();
    if (idbResponse?.success && idbResponse.apps) {
      for (const a of idbResponse.apps) appMap.set(a.id, a);
    }
    if (bridgeResponse?.success && bridgeResponse.apps) {
      for (const a of bridgeResponse.apps) appMap.set(a.id, a);
    }
    const allApps = [...appMap.values()].sort((a, b) =>
      (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    const appSection = document.getElementById('gallery-apps');

    if (allApps.length === 0 && projects.length === 0) {
      appSection.innerHTML = '<p style="color:#666;">No projects or apps yet. Create one from the sidepanel.</p>';
      return;
    }

    if (allApps.length > 0) {
      appSection.innerHTML = '<h2 style="margin:0 0 12px 0;font-size:16px;color:#aaa;">Legacy Apps</h2>'
        + '<div style="display:flex;flex-wrap:wrap;gap:16px;"></div>';
      const appList = appSection.querySelector('div');

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
          await Promise.all([
            chrome.runtime.sendMessage({ type: 'SC_APP_DELETE', id: app.id }).catch(() => null),
            sendMessageWithTimeout({ type: 'AF_APP_DELETE', id: app.id }).catch(() => null),
          ]);
          card.remove();
        });
        card.appendChild(delBtn);

        appList.appendChild(card);
      }
    }
  } catch (err) {
    document.getElementById('gallery-apps').innerHTML = `<p style="color:#c44;">Error loading: ${escapeHtml(err.message)}</p>`;
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
  // Streaming events from the cheerpx tab via the SW. We forward these
  // to the sandbox iframe so host.exec.spawnStream's per-stream listener
  // can route them by streamId. The wrapper page itself doesn't care
  // about the contents — we just relay.
  if (message && message.type === 'CHEERPX_STREAM_EVENT') {
    try {
      iframe.contentWindow.postMessage({
        source: 'smartclient-stream-event',
        streamId: message.streamId,
        event: message.event,
      }, '*');
    } catch (e) {
      // iframe may not be loaded yet
    }
    return;
  }

  // Skin change triggers iframe reload — works in playground AND plugin modes
  if (message.type === 'AUTO_BROADCAST_SC_SKIN' && urlParams.get('mode')) {
    _beginIframeNavigation();
    iframe.src = 'app.html?skin=' + encodeURIComponent(message.skin);
    // After new skin loads, re-send current config (buffered via ready signal)
    chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_STATE' }, (state) => {
      if (state?.config) {
        sendConfigToIframe(state.config, state.capabilities);
      }
    });
    return;
  }

  // Accept broadcast configs from sidepanel — works in all modes
  if (message.type === 'AUTO_BROADCAST_SC_CONFIG' && urlParams.get('mode')) {
    if (message.config) sendConfigToIframe(message.config, message.capabilities);
    return;
  }

  // Inspector mode toggle from sidepanel — works in playground AND plugin modes
  if (message.type === 'AUTO_BROADCAST_SC_MODE' && urlParams.get('mode')) {
    try {
      iframe.contentWindow.postMessage({
        source: 'smartclient-set-mode',
        mode: message.mode,
      }, '*');
    } catch (e) {}
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

  // Inspector: config updated from visual editing in sandbox
  if (msg.source === 'smartclient-config-updated') {
    chrome.runtime.sendMessage({
      type: 'SC_PLAYGROUND_CONFIG_UPDATED',
      config: msg.config,
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

});

