/**
 * Dashboard coordinator — 3-panel Monaco debugger layout.
 * Left: scripts + sessions  |  Center: Monaco source  |  Right: debug state + activity
 */

import { ScriptPanel } from './panels/script-panel.js';
import { SourcePanel } from './panels/source-panel.js';
import { DebugPanel } from './panels/debug-panel.js';

// ---- Wait for Monaco to be ready ----
await new Promise(resolve => {
  if (window._monacoReady) { resolve(); return; }
  window.addEventListener('monaco-ready', resolve, { once: true });
});

// ---- State ----
const state = {
  connected: false,
  sessions: [],
  activeSessionId: null,
  scripts: new Map(),      // scriptId → script
  selectedScriptId: null,
  snapshots: [],           // last N snapshots
  activities: [],          // last 20 activity strings
  lastSnapshot: null,
};

// ---- DOM refs ----
const bridgeDot    = document.getElementById('dash-bridge-dot');
const bridgeStatus = document.getElementById('dash-bridge-status');
const connectBtn   = document.getElementById('dash-connect-btn');
const openBtn      = document.getElementById('dash-open-btn');
const modalOverlay = document.getElementById('dash-modal-overlay');
const launchPath   = document.getElementById('dash-launch-path');
const launchArgs   = document.getElementById('dash-launch-args');
const launchBtn    = document.getElementById('dash-launch-btn');
const recentList   = document.getElementById('dash-recent-list');
const newSessionBtn     = document.getElementById('dash-new-session-btn');
const destroySessionBtn = document.getElementById('dash-destroy-session-btn');

// ---- Initialize panels ----
const scriptPanel = new ScriptPanel(
  document.getElementById('scripts-list'),
  document.getElementById('scripts-count'),
  { onSelect: selectScript, onAction: handleScriptAction, onBreakpoint: handleBreakpoint }
);

const sourcePanel = new SourcePanel(
  document.getElementById('monaco-container'),
  document.getElementById('snapshot-view'),
  document.getElementById('source-file-label'),
  document.getElementById('snap-filter-input'),
  document.getElementById('snap-filter-info'),
);

const debugPanel = new DebugPanel(
  document.getElementById('debug-body'),
  document.getElementById('debug-empty'),
  document.getElementById('debug-panel-title'),
  document.getElementById('activity-list'),
  { onStep: handleStep, onContinue: handleContinue, onCancel: handleCancel, onKill: handleKill }
);

// ---- View toggle (Source / Snapshot) ----
document.getElementById('view-source-btn').addEventListener('click', () => {
  setView('source');
});
document.getElementById('view-snap-btn').addEventListener('click', () => {
  setView('snapshot');
});

function setView(view) {
  const monacoEl = document.getElementById('monaco-container');
  const snapEl   = document.getElementById('snapshot-view');
  const snapBar  = document.getElementById('snap-filter-bar');
  const srcBtn   = document.getElementById('view-source-btn');
  const snapBtn  = document.getElementById('view-snap-btn');

  if (view === 'source') {
    monacoEl.style.display = '';
    snapEl.style.display   = 'none';
    snapBar.style.display  = 'none';
    srcBtn.classList.add('active');
    snapBtn.classList.remove('active');
  } else {
    monacoEl.style.display = 'none';
    snapEl.style.display   = '';
    snapBar.style.display  = state.lastSnapshot ? 'flex' : 'none';
    srcBtn.classList.remove('active');
    snapBtn.classList.add('active');
    if (state.lastSnapshot) {
      sourcePanel.renderSnapshot(state.lastSnapshot, document.getElementById('snapshot-view'));
    }
  }
}

// ---- Sessions section collapse ----
const sessionsToggle = document.getElementById('sessions-toggle');
const sessionsBody   = document.getElementById('sessions-body');
const sessionsArrow  = document.getElementById('sessions-arrow');
sessionsToggle.addEventListener('click', () => {
  const open = sessionsBody.style.display !== 'none';
  sessionsBody.style.display = open ? 'none' : '';
  sessionsArrow.classList.toggle('open', !open);
});

const activityToggle = document.getElementById('activity-toggle');
const activityBody   = document.getElementById('activity-body');
const activityArrow  = document.getElementById('activity-arrow');
activityToggle.addEventListener('click', () => {
  const open = activityBody.style.display !== 'none';
  activityBody.style.display = open ? 'none' : '';
  activityArrow.classList.toggle('open', !open);
});

// ---- Bridge connect/disconnect ----
connectBtn.addEventListener('click', handleBridgeToggle);

function updateTopBar() {
  bridgeDot.className    = state.connected ? 'dash-topbar-dot connected' : 'dash-topbar-dot';
  bridgeStatus.textContent = state.connected ? 'Connected' : 'Disconnected';
  connectBtn.textContent = state.connected ? 'Disconnect' : 'Connect';
  connectBtn.className   = state.connected ? 'dash-btn danger' : 'dash-btn secondary';
  openBtn.disabled       = !state.connected;
  newSessionBtn.disabled = !state.connected;
}

function handleBridgeToggle() {
  if (state.connected) {
    chrome.runtime.sendMessage({ type: 'BRIDGE_DISCONNECT' }, () => {
      state.connected = false;
      state.sessions = [];
      state.activeSessionId = null;
      updateTopBar();
      renderSessions();
    });
  } else {
    connectBtn.disabled = true;
    connectBtn.textContent = 'Connecting...';
    chrome.runtime.sendMessage({ type: 'BRIDGE_CONNECT', port: 9876 }, (response) => {
      connectBtn.disabled = false;
      if (response?.success) {
        state.connected = true;
        updateTopBar();
        loadSessions();
        loadScripts();
      } else {
        bridgeStatus.textContent = `Error: ${response?.error || 'Failed'}`;
        connectBtn.textContent = 'Connect';
        connectBtn.className = 'dash-btn secondary';
      }
    });
  }
}

// ---- Sessions ----
function loadSessions() {
  chrome.runtime.sendMessage({ type: 'BRIDGE_LIST_SESSIONS' }, (response) => {
    state.sessions = response?.sessions || [];
    if (!state.activeSessionId && state.sessions.length > 0) {
      state.activeSessionId = state.sessions[0].id;
    }
    renderSessions();
    destroySessionBtn.disabled = !state.activeSessionId;
  });
}

function renderSessions() {
  const body = document.getElementById('sessions-body');
  document.getElementById('sessions-count').textContent = state.sessions.length;
  destroySessionBtn.disabled = !state.activeSessionId || !state.connected;

  if (state.sessions.length === 0) {
    body.innerHTML = '<div class="dash-empty" style="padding:12px;">No sessions</div>';
    return;
  }
  body.innerHTML = state.sessions.map(s => {
    const stateClass = (s.state || 'IDLE').toUpperCase();
    return `<div class="dash-session-item ${s.id === state.activeSessionId ? 'active' : ''}" data-sid="${s.id}">
      <div class="dash-session-dot ${stateClass}"></div>
      <span class="dash-session-name">${escHtml(s.name || s.id)}</span>
      <span class="dash-session-state">${s.state || 'idle'}</span>
    </div>`;
  }).join('');
  body.querySelectorAll('.dash-session-item').forEach(el => {
    el.addEventListener('click', () => {
      state.activeSessionId = el.dataset.sid;
      destroySessionBtn.disabled = false;
      renderSessions();
    });
  });
}

newSessionBtn.addEventListener('click', () => {
  const name = prompt('Session name:', `session_${state.sessions.length + 1}`);
  if (!name) return;
  newSessionBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'BRIDGE_CREATE_SESSION', name, options: {} }, (response) => {
    newSessionBtn.disabled = false;
    if (response?.success) {
      state.activeSessionId = response.session?.id;
      loadSessions();
    }
  });
});

destroySessionBtn.addEventListener('click', () => {
  if (!state.activeSessionId) return;
  if (!confirm('Destroy this session?')) return;
  chrome.runtime.sendMessage({ type: 'BRIDGE_DESTROY_SESSION', sessionId: state.activeSessionId }, () => {
    state.activeSessionId = null;
    loadSessions();
  });
});

// ---- Scripts ----
function loadScripts() {
  chrome.runtime.sendMessage({ type: 'SCRIPT_LIST' }, (response) => {
    if (response?.success && response.scripts) {
      state.scripts.clear();
      for (const s of response.scripts) {
        state.scripts.set(s.scriptId, s);
      }
      scriptPanel.render(state.scripts, state.selectedScriptId);
    }
  });
}

function selectScript(scriptId) {
  state.selectedScriptId = scriptId;
  scriptPanel.render(state.scripts, state.selectedScriptId);

  const script = state.scripts.get(scriptId);
  debugPanel.update(script);

  // Load source into Monaco
  const scriptPath = script?.metadata?.path;
  if (scriptPath && state.connected) {
    chrome.runtime.sendMessage({ type: 'SCRIPT_GET_SOURCE', path: scriptPath }, (response) => {
      if (response?.success && response.source) {
        const checkpointLines = findCheckpointLines(response.source);
        sourcePanel.loadSource(response.source, scriptPath, checkpointLines,
          script?.activeBreakpoints || [], script?.checkpoint?.name || null);
      }
    });
  }
}

function findCheckpointLines(source) {
  // Returns { checkpointName: lineNumber (1-based) }
  const map = {};
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    const m = line.match(/client\.checkpoint\(['"]([^'"]+)['"]/);
    if (m) map[m[1]] = i + 1;
  });
  return map;
}

// ---- Script actions ----
function handleScriptAction(action, scriptId) {
  const msgs = {
    pause:    { type: 'SCRIPT_PAUSE', scriptId },
    resume:   { type: 'SCRIPT_RESUME', scriptId },
    cancel:   { type: 'SCRIPT_CANCEL', scriptId, reason: 'Cancelled from dashboard' },
    kill:     { type: 'SCRIPT_CANCEL', scriptId, reason: 'Force killed from dashboard', force: true },
  };
  const msg = msgs[action];
  if (msg) chrome.runtime.sendMessage(msg);
}

function handleBreakpoint(scriptId, name, active) {
  chrome.runtime.sendMessage({ type: 'SCRIPT_SET_BREAKPOINT', scriptId, name, active });
}

function handleStep(scriptId) {
  chrome.runtime.sendMessage({ type: 'SCRIPT_STEP', scriptId, clearAll: false });
}
function handleContinue(scriptId) {
  chrome.runtime.sendMessage({ type: 'SCRIPT_STEP', scriptId, clearAll: true });
}
function handleCancel(scriptId) {
  chrome.runtime.sendMessage({ type: 'SCRIPT_CANCEL', scriptId, reason: 'Cancelled from debugger' });
}
function handleKill(scriptId) {
  chrome.runtime.sendMessage({ type: 'SCRIPT_CANCEL', scriptId, reason: 'Force killed from debugger', force: true });
}

// ---- Open Script modal ----
const RECENT_KEY = 'dash-recent-scripts';
const RECENT_MAX = 8;

function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}
function saveRecent(path) {
  const list = [path, ...loadRecent().filter(p => p !== path)].slice(0, RECENT_MAX);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
}
function renderRecent() {
  const items = loadRecent();
  if (items.length === 0) {
    recentList.innerHTML = '<div class="dash-recent-empty">No recent scripts</div>';
    return;
  }
  recentList.innerHTML = items.map(p => {
    const name = p.split('/').pop();
    const dir  = p.split('/').slice(0, -1).join('/');
    return `<div class="dash-recent-item" data-path="${escHtml(p)}" title="${escHtml(p)}">
      <span class="dash-recent-item-icon">▶</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        <strong style="color:#c0c0d0;">${escHtml(name)}</strong>
        <span style="color:#3a3a5a;"> — ${escHtml(dir)}</span>
      </span>
    </div>`;
  }).join('');
  recentList.querySelectorAll('.dash-recent-item').forEach(el => {
    el.addEventListener('click', () => {
      launchPath.value = el.dataset.path;
      launchPath.focus();
    });
  });
}

function openModal() {
  renderRecent();
  modalOverlay.classList.add('open');
  launchPath.focus();
  launchPath.select();
}
function closeModal() {
  modalOverlay.classList.remove('open');
}

openBtn.addEventListener('click', openModal);
document.getElementById('dash-modal-close').addEventListener('click', closeModal);
document.getElementById('dash-modal-cancel').addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
launchPath.addEventListener('keydown', (e) => { if (e.key === 'Enter') launchBtn.click(); });

// ---- Launch ----
launchBtn.addEventListener('click', () => {
  const path = launchPath.value.trim();
  if (!path) { launchPath.focus(); return; }
  const args = launchArgs.value.trim() ? launchArgs.value.trim().split(/\s+/) : [];
  launchBtn.disabled = true;
  launchBtn.textContent = 'Launching...';
  chrome.runtime.sendMessage({ type: 'SCRIPT_LAUNCH', path, args }, (response) => {
    launchBtn.disabled = false;
    launchBtn.textContent = 'Launch ▶';
    if (!response?.success) {
      launchPath.focus();
      launchPath.select();
      bridgeStatus.textContent = `Launch failed: ${response?.error || 'Unknown error'}`;
    } else {
      saveRecent(path);
      launchPath.value = '';
      launchArgs.value = '';
      closeModal();
    }
  });
});

// ---- Broadcast listener ----
chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'AUTO_BROADCAST_SCRIPT': {
      const prev = state.scripts.get(message.scriptId) || {};
      const updated = { ...prev, ...message };
      state.scripts.set(message.scriptId, updated);

      // Track activity
      if (message.activity && message.activity !== prev.activity) {
        pushActivity(message.activity);
      }

      scriptPanel.render(state.scripts, state.selectedScriptId);

      if (message.scriptId === state.selectedScriptId) {
        debugPanel.update(updated);

        // Update Monaco decorations when checkpoint state changes
        if (updated.activeBreakpoints || updated.checkpoint !== prev.checkpoint) {
          sourcePanel.updateDecorations(
            updated.activeBreakpoints || [],
            updated.checkpoint?.name || null
          );
        }
        // Scroll to current checkpoint line
        if (updated.state === 'checkpoint' && updated.checkpoint?.name) {
          sourcePanel.scrollToCheckpoint(updated.checkpoint.name);
        }
      }
      break;
    }

    case 'AUTO_BROADCAST_SNAPSHOT': {
      state.lastSnapshot = { yaml: message.yaml, url: message.url, timestamp: Date.now() };
      // If snapshot view is active, update it
      const snapEl = document.getElementById('snapshot-view');
      if (snapEl.style.display !== 'none') {
        sourcePanel.renderSnapshot(state.lastSnapshot, snapEl);
      }
      break;
    }

    case 'AUTO_BROADCAST_STATUS': {
      const session = state.sessions.find(s => s.id === message.sessionId);
      if (session) { session.state = message.state; renderSessions(); }
      break;
    }

    case 'AUTO_BROADCAST_CONNECTION': {
      state.connected = message.connected;
      updateTopBar();
      if (message.connected) { loadSessions(); loadScripts(); }
      break;
    }
  }
});

function pushActivity(text) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  state.activities.unshift({ text, time });
  if (state.activities.length > 20) state.activities.pop();
  renderActivityFeed();
}

function renderActivityFeed() {
  const list = document.getElementById('activity-list');
  if (state.activities.length === 0) {
    list.innerHTML = '<div class="dash-empty" style="padding:8px;">No activity yet</div>';
    return;
  }
  list.innerHTML = state.activities.map(a =>
    `<div class="dash-activity-item"><span class="dash-activity-time">${a.time}</span>${escHtml(a.text)}</div>`
  ).join('');
}

// ---- Utilities ----
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ---- Startup ----
function init() {
  updateTopBar();
  renderSessions();
  renderActivityFeed();
  scriptPanel.render(state.scripts, null);
  debugPanel.update(null);

  chrome.runtime.sendMessage({ type: 'BRIDGE_STATUS' }, (response) => {
    state.connected = response?.connected || false;
    updateTopBar();
    if (state.connected) {
      loadSessions();
      loadScripts();
    }
  });
}

init();
console.log('[Dashboard] Monaco debugger initialized');
