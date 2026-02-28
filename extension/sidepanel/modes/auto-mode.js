/**
 * Automation mode — browser automation control surface.
 * Phase 0: Extracted from sidepanel.js lines 1372-1678.
 * Phase 1: Enhanced with command feed, session tabs, broadcast reception.
 */

// State
let bridgeConnected = false;
let sessions = [];
let activeSessionId = null;
let commandFeed = [];
let lastSnapshot = null;
let collapsedSections = {};
let broadcastListener = null;
let scripts = new Map(); // scriptId -> script state

// DOM refs (resolved once in init)
let els = {};

export function init() {
  els = {
    bridgeDot: document.getElementById('bridge-dot'),
    bridgeStatusText: document.getElementById('bridge-status-text'),
    bridgeConnectBtn: document.getElementById('bridge-connect-btn'),
    sessionTabs: document.getElementById('auto-session-tabs'),
    newSessionBtn: document.getElementById('auto-new-session-btn'),
    commandInput: document.getElementById('auto-command-input'),
    sendBtn: document.getElementById('auto-send-btn'),
    snapshotBtn: document.getElementById('auto-snapshot-btn'),
    feedList: document.getElementById('auto-feed-list'),
    feedCount: document.getElementById('auto-feed-count'),
    snapshotViewer: document.getElementById('auto-snapshot-viewer'),
    snapshotInfo: document.getElementById('auto-snapshot-info'),
    snapFilter: document.getElementById('auto-snap-filter'),
    knowledgeInput: document.getElementById('auto-knowledge-input'),
    knowledgeSearchBtn: document.getElementById('auto-knowledge-search-btn'),
    knowledgeResults: document.getElementById('auto-knowledge-results'),
    scriptsList: document.getElementById('auto-scripts-list'),
    scriptsCount: document.getElementById('auto-scripts-count'),
  };

  // Bridge connect/disconnect
  els.bridgeConnectBtn.addEventListener('click', handleBridgeToggle);

  // New session
  els.newSessionBtn.addEventListener('click', handleNewSession);

  // Command input
  els.sendBtn.addEventListener('click', sendAutoCommand);
  els.commandInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendAutoCommand();
  });

  // Snapshot button
  els.snapshotBtn.addEventListener('click', handleSnapshot);

  // Quick actions
  document.querySelectorAll('.auto-action-btn').forEach(btn => {
    btn.addEventListener('click', () => handleQuickAction(btn.dataset.action));
  });

  // Section collapse
  document.querySelectorAll('[data-collapse]').forEach(header => {
    header.addEventListener('click', () => toggleSection(header.dataset.collapse));
  });

  // Snapshot filter
  if (els.snapFilter) {
    els.snapFilter.addEventListener('input', filterSnapshot);
  }

  // Page knowledge search
  els.knowledgeSearchBtn.addEventListener('click', searchPageKnowledge);
  els.knowledgeInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') searchPageKnowledge();
  });

  // Dashboard button
  const dashBtn = document.getElementById('auto-open-dashboard-btn');
  if (dashBtn) {
    dashBtn.addEventListener('click', openDashboard);
  }
}

export function activate() {
  checkBridgeStatus();
  startBroadcastListener();
  // Load existing command log
  chrome.runtime.sendMessage({ type: 'GET_COMMAND_LOG' }, (response) => {
    if (response?.log) {
      commandFeed = response.log;
      renderCommandFeed();
    }
  });
  // Load active scripts
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
  els.bridgeDot.className = bridgeConnected ? 'bridge-dot connected' : 'bridge-dot';
  els.bridgeStatusText.textContent = bridgeConnected ? 'Connected' : 'Disconnected';
  els.bridgeConnectBtn.textContent = bridgeConnected ? 'Disconnect' : 'Connect';
  els.bridgeConnectBtn.style.background = bridgeConnected ? '#d93025' : '#1a73e8';

  const hasSession = bridgeConnected && activeSessionId;
  els.newSessionBtn.disabled = !bridgeConnected;
  els.snapshotBtn.disabled = !hasSession;
  els.commandInput.disabled = !hasSession;
  els.sendBtn.disabled = !hasSession;

  // Quick action buttons
  document.querySelectorAll('.auto-action-btn').forEach(btn => {
    btn.disabled = !hasSession;
  });
}

async function handleBridgeToggle() {
  if (bridgeConnected) {
    chrome.runtime.sendMessage({ type: 'BRIDGE_DISCONNECT' }, () => {
      bridgeConnected = false;
      sessions = [];
      activeSessionId = null;
      updateBridgeUI();
      renderSessionTabs();
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
      } else {
        els.bridgeStatusText.textContent = `Error: ${response?.error || 'Failed'}`;
        els.bridgeConnectBtn.textContent = 'Connect';
      }
    });
  }
}

// ---- Sessions ----

function refreshSessions() {
  chrome.runtime.sendMessage({ type: 'BRIDGE_LIST_SESSIONS' }, (response) => {
    sessions = response?.sessions || [];
    if (!activeSessionId && sessions.length > 0) {
      activeSessionId = sessions[0].id;
    }
    renderSessionTabs();
    updateBridgeUI();
  });
}

function renderSessionTabs() {
  if (!els.sessionTabs) return;

  if (sessions.length === 0) {
    els.sessionTabs.innerHTML = '<span style="color: #5f6368; font-size: 11px;">No sessions</span>';
    activeSessionId = null;
    updateBridgeUI();
    return;
  }

  els.sessionTabs.innerHTML = sessions.map(s => {
    const isActive = s.id === activeSessionId;
    const stateClass = (s.state || 'idle').toUpperCase();
    return `
      <div class="auto-session-tab ${isActive ? 'active' : ''}" data-session-id="${s.id}">
        <span class="state-dot ${stateClass}"></span>
        ${s.name || s.id}
      </div>
    `;
  }).join('');

  // Click handlers
  els.sessionTabs.querySelectorAll('.auto-session-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      activeSessionId = tab.dataset.sessionId;
      renderSessionTabs();
      updateBridgeUI();
    });
  });
}

async function handleNewSession() {
  const name = prompt('Session name:', `session_${sessions.length + 1}`);
  if (!name) return;

  els.newSessionBtn.disabled = true;
  els.newSessionBtn.textContent = '...';

  chrome.runtime.sendMessage({
    type: 'BRIDGE_CREATE_SESSION', name, options: {}
  }, (response) => {
    els.newSessionBtn.disabled = false;
    els.newSessionBtn.textContent = '+';
    if (response?.success && response.session) {
      activeSessionId = response.session.id;
      refreshSessions();
    } else {
      alert(`Failed: ${response?.error || 'Unknown error'}`);
    }
  });
}

// ---- Commands ----

function sendAutoCommand() {
  const input = els.commandInput.value.trim();
  if (!input || !activeSessionId) return;

  els.sendBtn.disabled = true;
  els.sendBtn.textContent = '...';

  const isRawCommand = /^(goto|click|fill|snapshot|evaluate|select|type|press|hover|scroll)\s/i.test(input);

  if (isRawCommand) {
    chrome.runtime.sendMessage({
      type: 'BRIDGE_SEND_COMMAND', sessionId: activeSessionId, command: input
    }, (response) => {
      els.sendBtn.disabled = false;
      els.sendBtn.textContent = 'Send';
      els.commandInput.value = '';

      if (response?.success) {
        els.snapshotViewer.textContent = response.output || 'Command executed';
      } else {
        els.snapshotViewer.textContent = `Error: ${response?.error}`;
      }
    });
  } else {
    chrome.runtime.sendMessage({
      type: 'AUTOMATION_REASON', intent: input, sessionId: activeSessionId
    }, (response) => {
      els.sendBtn.disabled = false;
      els.sendBtn.textContent = 'Send';
      els.commandInput.value = '';

      if (response?.success) {
        const output = [];
        if (response.message) output.push(response.message);
        if (response.commands && response.commands.length > 0) {
          output.push('\nCommands:');
          response.commands.forEach((cmd, i) => {
            output.push(`  ${i + 1}. ${cmd.type} ${cmd.ref || cmd.url || cmd.value || ''}`);
            if (cmd.reasoning) output.push(`     -> ${cmd.reasoning}`);
          });
        }
        els.snapshotViewer.textContent = output.join('\n');
      } else {
        els.snapshotViewer.textContent = `Error: ${response?.error}`;
      }
    });
  }
}

function handleSnapshot() {
  if (!activeSessionId) return;
  els.snapshotBtn.disabled = true;
  els.snapshotBtn.textContent = '...';

  chrome.runtime.sendMessage({
    type: 'BRIDGE_TAKE_SNAPSHOT', sessionId: activeSessionId
  }, (response) => {
    els.snapshotBtn.disabled = false;
    els.snapshotBtn.textContent = 'Snap';

    if (response?.success && response.yaml) {
      lastSnapshot = {
        yaml: response.yaml,
        url: response.url,
        lines: response.lines,
        timestamp: response.timestamp,
        sessionId: activeSessionId
      };
      renderSnapshot();
    } else {
      els.snapshotViewer.textContent = `Error: ${response?.error || 'Failed'}`;
    }
  });
}

// ---- Quick Actions ----

function handleQuickAction(action) {
  if (!activeSessionId) return;

  const actions = {
    dismiss: { type: 'BRIDGE_SEND_COMMAND', command: 'press Escape' },
    refresh: { type: 'BRIDGE_EVAL', expr: 'location.reload()' },
    back: { type: 'BRIDGE_EVAL', expr: 'history.back()' },
    scroll: { type: 'BRIDGE_EVAL', expr: 'window.scrollBy(0, 500)' },
  };

  const spec = actions[action];
  if (!spec) return;

  chrome.runtime.sendMessage({
    ...spec, sessionId: activeSessionId
  }, (response) => {
    if (!response?.success) {
      console.warn(`[Auto] Quick action ${action} failed:`, response?.error);
    }
  });
}

// ---- Command Feed ----

function renderCommandFeed() {
  if (!els.feedList) return;

  els.feedCount.textContent = commandFeed.length;

  if (commandFeed.length === 0) {
    els.feedList.innerHTML = '<div style="padding: 8px 12px; color: #5f6368; font-size: 11px;">No commands yet</div>';
    return;
  }

  // Show newest first, max 50
  const visible = commandFeed.slice(-50).reverse();
  els.feedList.innerHTML = visible.map(entry => {
    const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
    const duration = entry.duration ? `${entry.duration}ms` : '';
    const statusClass = entry.status;
    const statusIcon = entry.status === 'success' ? '✓' : entry.status === 'error' ? '✗' : '…';

    return `
      <div class="auto-feed-entry" data-cmd-id="${entry.id}">
        <span style="color: #70757a; min-width: 55px;">${time}</span>
        <span class="cmd-type">${entry.type}</span>
        <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #5f6368;">${summarizeRequest(entry.request)}</span>
        <span class="cmd-source">${entry.source}</span>
        <span class="cmd-status ${statusClass}">${statusIcon} ${duration}</span>
      </div>
    `;
  }).join('');

  // Click to expand
  els.feedList.querySelectorAll('.auto-feed-entry').forEach(el => {
    el.addEventListener('click', () => toggleFeedDetail(el));
  });
}

function summarizeRequest(request) {
  if (!request) return '';
  if (request.command) return request.command;
  if (request.ref) return `ref=${request.ref}`;
  if (request.url) return request.url;
  if (request.name) return request.name;
  if (request.expr) return request.expr.substring(0, 40);
  return JSON.stringify(request).substring(0, 40);
}

function toggleFeedDetail(el) {
  const existing = el.querySelector('.feed-detail');
  if (existing) {
    existing.remove();
    return;
  }

  const cmdId = el.dataset.cmdId;
  const entry = commandFeed.find(e => e.id === cmdId);
  if (!entry) return;

  const detail = document.createElement('div');
  detail.className = 'feed-detail';
  detail.style.cssText = 'padding: 6px 0 0; font-size: 10px; color: #5f6368; white-space: pre-wrap; word-break: break-all; border-top: 1px solid #f0f0f0; margin-top: 4px;';
  detail.textContent = JSON.stringify({ request: entry.request, response: entry.response }, null, 2);
  el.appendChild(detail);
}

// ---- Snapshot Viewer ----

function renderSnapshot() {
  if (!lastSnapshot) {
    els.snapshotViewer.textContent = 'No snapshot yet';
    els.snapshotInfo.textContent = '';
    return;
  }

  els.snapshotViewer.textContent = lastSnapshot.yaml;
  els.snapshotInfo.textContent = `${lastSnapshot.lines} lines | ${new Date(lastSnapshot.timestamp).toLocaleTimeString()}`;

  // Show search if snapshot section visible
  const searchDiv = document.getElementById('auto-snapshot-search');
  if (searchDiv) searchDiv.style.display = 'block';
}

function filterSnapshot() {
  if (!lastSnapshot || !els.snapFilter) return;
  const filter = els.snapFilter.value.toLowerCase().trim();

  if (!filter) {
    els.snapshotViewer.textContent = lastSnapshot.yaml;
    return;
  }

  const lines = lastSnapshot.yaml.split('\n');
  const filtered = lines.filter(line => line.toLowerCase().includes(filter));
  els.snapshotViewer.textContent = filtered.length > 0
    ? `[${filtered.length}/${lines.length} lines matching "${filter}"]\n\n${filtered.join('\n')}`
    : `No lines matching "${filter}"`;
}

// ---- Section collapse ----

function toggleSection(name) {
  collapsedSections[name] = !collapsedSections[name];
  const section = document.querySelector(`[data-collapse="${name}"]`)?.closest('.auto-section');
  if (!section) return;

  const content = section.querySelector('.auto-feed-list, .auto-snapshot-viewer, #auto-knowledge-results, #auto-scripts-list, #auto-snapshot-search');
  if (content) {
    content.style.display = collapsedSections[name] ? 'none' : '';
  }
}

// ---- Broadcast Listener ----

function startBroadcastListener() {
  if (broadcastListener) return;

  broadcastListener = (message) => {
    if (message.type === 'AUTO_COMMAND_UPDATE') {
      const entry = message.entry;
      const idx = commandFeed.findIndex(e => e.id === entry.id);
      if (idx >= 0) {
        commandFeed[idx] = entry;
      } else {
        commandFeed.push(entry);
      }
      renderCommandFeed();
    }

    if (message.type === 'AUTO_BROADCAST_SNAPSHOT') {
      lastSnapshot = {
        yaml: message.yaml,
        url: message.url,
        lines: message.lines,
        timestamp: Date.now(),
        sessionId: message.sessionId
      };
      renderSnapshot();
    }

    if (message.type === 'AUTO_BROADCAST_STATUS') {
      // Update session state in our list
      const session = sessions.find(s => s.id === message.sessionId);
      if (session) {
        session.state = message.state;
        renderSessionTabs();
      }
    }

    if (message.type === 'AUTO_BROADCAST_CONNECTION') {
      bridgeConnected = message.connected;
      updateBridgeUI();
      if (bridgeConnected) refreshSessions();
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

// ---- Scripts ----

function loadScripts() {
  if (!bridgeConnected) {
    renderScripts();
    return;
  }
  chrome.runtime.sendMessage({ type: 'SCRIPT_LIST' }, (response) => {
    if (response?.success && response.scripts) {
      scripts.clear();
      for (const s of response.scripts) {
        scripts.set(s.scriptId, s);
      }
    }
    renderScripts();
  });
}

function updateScript(data) {
  if (!data.scriptId) return;
  scripts.set(data.scriptId, { ...scripts.get(data.scriptId), ...data });
  renderScripts();
}

function renderScripts() {
  if (!els.scriptsList) return;
  els.scriptsCount.textContent = scripts.size;

  if (scripts.size === 0) {
    els.scriptsList.innerHTML = '<div style="padding: 8px 12px; color: #5f6368; font-size: 11px;">No scripts registered</div>';
    return;
  }

  const entries = [...scripts.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  els.scriptsList.innerHTML = entries.map(s => {
    const pct = s.total > 0 ? Math.round((s.step / s.total) * 100) : 0;
    const progressClass = s.state === 'complete' ? 'complete' : s.errors > 0 ? 'error' : '';
    const isActive = s.state === 'running' || s.state === 'paused';

    return `
      <div class="auto-script-card" data-script-id="${s.scriptId}">
        <div class="auto-script-header">
          <span class="auto-script-name">${escapeHtml(s.name)}</span>
          <span class="auto-script-state ${s.state}">${s.state}</span>
        </div>
        <div class="auto-script-progress">
          <div class="auto-script-progress-fill ${progressClass}" style="width: ${pct}%"></div>
        </div>
        <div class="auto-script-detail">
          <span>${s.step || 0}/${s.total || '?'} ${s.label ? '— ' + escapeHtml(s.label) : ''}</span>
          ${s.errors > 0 ? `<span class="auto-script-errors">${s.errors} errors</span>` : ''}
          <div class="auto-script-actions">
            ${isActive && s.state === 'running' ? `<button data-action="pause" data-sid="${s.scriptId}">Pause</button>` : ''}
            ${s.state === 'paused' ? `<button data-action="resume" data-sid="${s.scriptId}">Resume</button>` : ''}
            ${isActive ? `<button class="danger" data-action="cancel" data-sid="${s.scriptId}">Cancel</button>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Wire action buttons
  els.scriptsList.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleScriptAction(btn.dataset.action, btn.dataset.sid);
    });
  });
}

function handleScriptAction(action, scriptId) {
  const typeMap = { pause: 'SCRIPT_PAUSE', resume: 'SCRIPT_RESUME', cancel: 'SCRIPT_CANCEL' };
  const type = typeMap[action];
  if (!type) return;

  chrome.runtime.sendMessage({
    type, scriptId, reason: action === 'cancel' ? 'Cancelled from sidepanel' : undefined
  }, (response) => {
    if (!response?.success) {
      console.warn(`[Auto] Script ${action} failed:`, response?.error);
    }
  });
}

function escapeHtml(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- Dashboard ----

function openDashboard() {
  const dashUrl = chrome.runtime.getURL('dashboard/dashboard.html');
  chrome.tabs.query({}, (tabs) => {
    const existing = tabs.find(t => t.url === dashUrl);
    if (existing) {
      chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId) chrome.windows.update(existing.windowId, { focused: true });
    } else {
      chrome.tabs.create({ url: dashUrl });
    }
  });
}

// ---- Page Knowledge ----

function searchPageKnowledge() {
  const query = els.knowledgeInput.value.trim();
  if (!query) return;

  els.knowledgeSearchBtn.disabled = true;
  els.knowledgeSearchBtn.textContent = '...';

  chrome.runtime.sendMessage({
    type: 'SNAPSHOT_SEARCH', query, options: { limit: 5 }
  }, (response) => {
    els.knowledgeSearchBtn.disabled = false;
    els.knowledgeSearchBtn.textContent = 'Search';

    if (response?.success && response.results?.length > 0) {
      els.knowledgeResults.innerHTML = response.results.map(r => `
        <div class="snapshot-search-result">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <span style="font-weight: 600; color: #202124;">${r.sectionType}</span>
            <span class="score">${Math.round(r.score * 100)}%</span>
          </div>
          <div style="font-size: 11px; color: #5f6368; margin-bottom: 4px;">${r.textDescription}</div>
          ${r.isStablePattern ? '<div style="font-size: 10px; color: #1e8e3e;">Stable pattern</div>' : ''}
          <div style="font-size: 10px; color: #70757a;">${r.track || ''} ${r.race ? 'R' + r.race : ''} | ${new Date(r.timestamp).toLocaleString()}</div>
        </div>
      `).join('');
    } else {
      els.knowledgeResults.innerHTML = `<div style="color: #5f6368;">No cached snapshots match "${query}"</div>`;
    }
  });
}
