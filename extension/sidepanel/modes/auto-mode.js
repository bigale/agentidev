/**
 * Automation mode — compact bridge status + page intercept controls.
 *
 * Full bridge management (sessions, script launch, source viewer, debug panel)
 * lives in the dashboard, opened via the "Dashboard ↗" button.
 *
 * This panel shows:
 *   - Bridge connection status + connect/disconnect
 *   - Active script name + state + step count
 *   - Per-page intercept toggles (nav/clk/inp/wt/ev/ss) for playwright-shim scripts
 */

// ---- State ----
let bridgeConnected = false;
let sessions        = [];
let activeSessionId = null;
let broadcastListener = null;
let scripts         = new Map(); // scriptId → script state

// ---- DOM refs ----
let els = {};

const INTERCEPT_CATEGORIES = ['navigate', 'click', 'input', 'wait', 'eval', 'screenshot'];
const IC_LABEL = { navigate: 'nav', click: 'clk', input: 'inp', wait: 'wt', eval: 'ev', screenshot: 'ss' };

// ---- Lifecycle ----

export function init() {
  els = {
    bridgeDot:              document.getElementById('bridge-dot'),
    bridgeStatusText:       document.getElementById('bridge-status-text'),
    bridgeConnectBtn:       document.getElementById('bridge-connect-btn'),
    activeScript:           document.getElementById('auto-active-script'),
    pageInterceptsSection:  document.getElementById('auto-page-intercepts-section'),
    pageIntercepts:         document.getElementById('auto-page-intercepts'),
  };

  els.bridgeConnectBtn.addEventListener('click', handleBridgeToggle);

  // React Dashboard removed (T1) — SC Dashboard is the only dashboard
  const scDashBtn = document.getElementById('auto-open-sc-dashboard-btn');
  if (scDashBtn) scDashBtn.addEventListener('click', openSCDashboard);
  initPluginMenu();
}

export function activate() {
  checkBridgeStatus();
  startBroadcastListener();
  loadScripts();
}

export function deactivate() {
  stopBroadcastListener();
}

// ---- Bridge connection ----

function checkBridgeStatus() {
  chrome.runtime.sendMessage({ type: 'BRIDGE_STATUS' }, (response) => {
    bridgeConnected = response?.connected || false;
    updateBridgeUI();
    if (bridgeConnected) refreshSessions();
  });
}

function updateBridgeUI() {
  els.bridgeDot.className       = bridgeConnected ? 'bridge-dot connected' : 'bridge-dot';
  els.bridgeStatusText.textContent = bridgeConnected ? 'Connected' : 'Disconnected';
  els.bridgeConnectBtn.textContent = bridgeConnected ? 'Disconnect' : 'Connect';
  els.bridgeConnectBtn.style.background = bridgeConnected ? '#d93025' : '#1a73e8';
}

function handleBridgeToggle() {
  if (bridgeConnected) {
    chrome.runtime.sendMessage({ type: 'BRIDGE_DISCONNECT' }, () => {
      bridgeConnected = false;
      sessions = [];
      activeSessionId = null;
      scripts.clear();
      updateBridgeUI();
      renderScriptView();
    });
  } else {
    els.bridgeConnectBtn.disabled = true;
    els.bridgeConnectBtn.textContent = 'Connecting...';
    chrome.runtime.sendMessage({ type: 'BRIDGE_CONNECT', port: 9876 }, (response) => {
      els.bridgeConnectBtn.disabled = false;
      if (response?.success) {
        bridgeConnected = true;
        updateBridgeUI();
        refreshSessions();
        loadScripts();
      } else {
        els.bridgeStatusText.textContent = `Error: ${response?.error || 'Failed'}`;
        els.bridgeConnectBtn.textContent = 'Connect';
      }
    });
  }
}

// ---- Sessions (tracked for status, not displayed) ----

function refreshSessions() {
  chrome.runtime.sendMessage({ type: 'BRIDGE_LIST_SESSIONS' }, (response) => {
    sessions = response?.sessions || [];
    if (!activeSessionId && sessions.length > 0) activeSessionId = sessions[0].id;
    updateBridgeUI();
  });
}

// ---- Dashboard ----

function openDashboard() {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
}

function openSCDashboard() {
  chrome.tabs.create({ url: chrome.runtime.getURL('smartclient-app/wrapper.html?mode=dashboard') });
}

// ---- Plugins dropdown ----

function initPluginMenu() {
  const btn = document.getElementById('auto-plugins-btn');
  const dropdown = document.getElementById('auto-plugin-dropdown');
  if (!btn || !dropdown) return;

  let open = false;

  btn.addEventListener('click', () => {
    open = !open;
    if (open) {
      loadPluginList(dropdown);
      dropdown.style.display = 'block';
    } else {
      dropdown.style.display = 'none';
    }
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!btn.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.style.display = 'none';
      open = false;
    }
  });
}

function loadPluginList(dropdown) {
  dropdown.innerHTML = '<div style="padding:8px;color:#888;font-size:11px;">Loading...</div>';
  chrome.runtime.sendMessage({ type: 'PLUGIN_LIST' }, (plugins) => {
    if (chrome.runtime.lastError || !Array.isArray(plugins) || plugins.length === 0) {
      dropdown.innerHTML = '<div style="padding:8px;color:#888;font-size:11px;">No plugins installed</div>';
      return;
    }
    dropdown.innerHTML = '';
    for (const p of plugins) {
      const item = document.createElement('div');
      item.style.cssText = 'padding:6px 12px;cursor:pointer;font-size:12px;color:#e0e0e0;white-space:nowrap;';
      item.textContent = p.name;
      item.title = p.description || p.id;
      item.addEventListener('mouseenter', () => { item.style.background = '#3a3a5a'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
      item.addEventListener('click', () => {
        const mode = (p.modes && p.modes[0]) || p.id;
        chrome.tabs.create({ url: chrome.runtime.getURL('smartclient-app/wrapper.html?mode=' + encodeURIComponent(mode)) });
        dropdown.style.display = 'none';
      });
      dropdown.appendChild(item);
    }
  });
}

// ---- Scripts ----

function loadScripts() {
  if (!bridgeConnected) { renderScriptView(); return; }
  chrome.runtime.sendMessage({ type: 'SCRIPT_LIST' }, (response) => {
    if (response?.success && response.scripts) {
      scripts.clear();
      for (const s of response.scripts) scripts.set(s.scriptId, s);
    }
    renderScriptView();
  });
}

function updateScript(data) {
  if (!data.scriptId) return;
  scripts.set(data.scriptId, { ...scripts.get(data.scriptId), ...data });
  renderScriptView();
}

function getMostActiveScript() {
  const all = [...scripts.values()];
  return (
    all.find(s => s.state === 'checkpoint') ||
    all.find(s => s.state === 'paused') ||
    all.find(s => s.state === 'running') ||
    all.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0] ||
    null
  );
}

function renderScriptView() {
  if (!els.activeScript) return;

  const script = getMostActiveScript();
  if (!script) {
    els.activeScript.innerHTML = '<span style="color:#9aa0a6;">No active script — launch from Dashboard</span>';
    if (els.pageInterceptsSection) els.pageInterceptsSection.style.display = 'none';
    return;
  }

  const stateColor = {
    running:    '#1e8e3e',
    checkpoint: '#e37400',
    paused:     '#f9ab00',
    complete:   '#1967d2',
    cancelled:  '#d93025',
    killed:     '#d93025',
  }[script.state] || '#5f6368';

  const stepStr = script.total > 0
    ? `${script.step}/${script.total}`
    : script.step > 0 ? `step ${script.step}` : '';

  els.activeScript.innerHTML =
    `<span class="script-name">${esc(script.name)}</span>` +
    `<span style="color:${stateColor}; margin-left:6px; font-size:10px;">● ${esc(script.state)}</span>` +
    (stepStr ? `<span style="color:#9aa0a6; margin-left:6px; font-size:10px;">${esc(stepStr)}</span>` : '');

  renderPageIntercepts(script);
}

function renderPageIntercepts(script) {
  if (!els.pageIntercepts || !els.pageInterceptsSection) return;

  const checkpoints      = script.checkpoints || [];
  const activeBreakpoints = script.activeBreakpoints || [];
  const pages            = script.pages || {};

  // Detect page IDs from checkpoints like 'p1:navigate', 'p2:click'
  const pageIds = [...new Set(
    checkpoints
      .filter(cp => /^p\d+:/.test(cp))
      .map(cp => cp.split(':')[0])
  )];

  if (pageIds.length === 0) {
    els.pageInterceptsSection.style.display = 'none';
    return;
  }

  els.pageInterceptsSection.style.display = '';
  els.pageIntercepts.innerHTML = pageIds.map(pageId => {
    const pageInfo  = pages[pageId] || {};
    const displayUrl = pageInfo.url
      ? pageInfo.url.replace(/^https?:\/\//, '').slice(0, 38)
      : pageId;

    const dots = INTERCEPT_CATEGORIES
      .filter(cat => checkpoints.includes(`${pageId}:${cat}`))
      .map(cat => {
        const name   = `${pageId}:${cat}`;
        const isActive = activeBreakpoints.includes(name);
        const isHit    = script.state === 'checkpoint' && script.checkpoint?.name === name;
        return `<span class="auto-ic-dot ${isActive ? 'active' : ''} ${isHit ? 'hit' : ''}"
                      data-name="${name}" data-sid="${esc(script.scriptId)}"
                      title="${name}">${IC_LABEL[cat]}</span>`;
      }).join('');

    return `<div class="auto-page-row">
      <span class="auto-page-id">${esc(pageId)}</span>
      <span class="auto-page-url" title="${esc(pageInfo.url || '')}">${esc(displayUrl)}</span>
      <span class="auto-ic-dots">${dots}</span>
    </div>`;
  }).join('');

  // Wire intercept toggle clicks
  els.pageIntercepts.querySelectorAll('.auto-ic-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      const name     = dot.dataset.name;
      const scriptId = dot.dataset.sid;
      const active   = !dot.classList.contains('active');
      chrome.runtime.sendMessage({ type: 'SCRIPT_SET_BREAKPOINT', scriptId, name, active });
      dot.classList.toggle('active', active);
    });
  });
}

// ---- Broadcast Listener ----

function startBroadcastListener() {
  if (broadcastListener) return;

  broadcastListener = (message) => {
    if (message.type === 'AUTO_BROADCAST_STATUS') {
      if (message.state === 'destroyed') {
        sessions = sessions.filter(s => s.id !== message.sessionId);
        if (activeSessionId === message.sessionId) activeSessionId = null;
        updateBridgeUI();
      } else {
        const session = sessions.find(s => s.id === message.sessionId);
        if (session) {
          session.state = message.state;
        } else {
          refreshSessions();
        }
      }
    }

    if (message.type === 'AUTO_BROADCAST_CONNECTION') {
      bridgeConnected = message.connected;
      updateBridgeUI();
      if (bridgeConnected) { refreshSessions(); loadScripts(); }
    }

    if (message.type === 'AUTO_BROADCAST_SCRIPT') {
      updateScript(message);
    }
  };

  chrome.runtime.onMessage.addListener(broadcastListener);
}

function stopBroadcastListener() {
  if (broadcastListener) {
    chrome.runtime.onMessage.removeListener(broadcastListener);
    broadcastListener = null;
  }
}

// ---- Utilities ----

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
