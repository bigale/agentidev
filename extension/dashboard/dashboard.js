/**
 * Dashboard coordinator — 3-panel Monaco debugger layout.
 * Left: scripts + sessions  |  Center: Monaco source  |  Right: debug state + activity
 */

import { ScriptPanel } from './panels/script-panel.js';
import { SourcePanel } from './panels/source-panel.js';
import { DebugPanel } from './panels/debug-panel.js';
import { getSnippetsByCategory, getSnippet, renderSnippet, suggestFromElement } from '../lib/snippet-library.js';

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
  processes: [],           // discovered Playwright browser processes
};

// ---- DOM refs ----
const bridgeDot    = document.getElementById('dash-bridge-dot');
const bridgeStatus = document.getElementById('dash-bridge-status');
const connectBtn   = document.getElementById('dash-connect-btn');
const openBtn      = document.getElementById('dash-open-btn');
const modalOverlay = document.getElementById('dash-modal-overlay');
const importPath   = document.getElementById('dash-import-path');
const importBtn    = document.getElementById('dash-import-btn');
const libraryList  = document.getElementById('dash-library-list');
const libraryCount = document.getElementById('dash-library-count');
const newSessionBtn     = document.getElementById('dash-new-session-btn');
const destroySessionBtn = document.getElementById('dash-destroy-session-btn');

// Debug toolbar refs
const tbRun      = document.getElementById('tb-run');
const tbDebug    = document.getElementById('tb-debug');
const tbPause    = document.getElementById('tb-pause');
const tbResume   = document.getElementById('tb-resume');
const tbStop     = document.getElementById('tb-stop');
const tbStep     = document.getElementById('tb-step');
const tbContinue = document.getElementById('tb-continue');
const tbKill     = document.getElementById('tb-kill');
const tbAuth     = document.getElementById('tb-auth');
const tbUnload   = document.getElementById('tb-unload');

// Editor-local breakpoints (toggled via gutter clicks, persisted until script unloaded)
let editorBreakpoints = []; // checkpoint names toggled on in the editor

// Auth capture state
let authCaptureSessionId = null;  // active auth session, null when not capturing
let authCaptureScriptName = null; // script name for the active capture

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

// Wire gutter click → toggle editor-local breakpoints
// Dashboard is the single source of truth for breakpoint state (editorBreakpoints).
// Source panel just reports the clicked checkpoint name.
sourcePanel.onBreakpointToggle = (nameOrLine) => {
  const active = !editorBreakpoints.includes(nameOrLine);
  if (active) {
    editorBreakpoints.push(nameOrLine);
  } else {
    editorBreakpoints = editorBreakpoints.filter(n => n !== nameOrLine);
  }

  // If a matching script is running, send breakpoint to the bridge
  const running = findRunningScriptForEditor();
  if (running) {
    if (typeof nameOrLine === 'number' && v8Debug) {
      // V8 line breakpoint: set/remove via V8 inspector
      const scriptPath = sourcePanel.getOriginalPath();
      if (active) {
        chrome.runtime.sendMessage({
          type: 'DBG_SET_BREAKPOINT', scriptId: running.scriptId, pid: v8Pid,
          file: `file://${scriptPath}`, line: nameOrLine,
        });
      } else {
        // Note: removing V8 breakpoints by line requires tracking breakpointId — skip for now
      }
    } else {
      // Named checkpoint breakpoint
      chrome.runtime.sendMessage({ type: 'SCRIPT_SET_BREAKPOINT', scriptId: running.scriptId, name: nameOrLine, active });
    }
  }

  // Update decorations — always pass a fresh copy to avoid stale references
  sourcePanel.updateDecorations([...editorBreakpoints], sourcePanel.currentCheckpoint);
  updateToolbar();
};

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

// ---- Debug toolbar ----

/**
 * Update toolbar button states based on loaded script + running script state.
 * - "Run" enabled when a library script is loaded in editor but not currently running
 * - "Pause" enabled when running
 * - "Resume" shown (replacing Pause) when paused
 * - "Stop" enabled when active (running/paused/checkpoint)
 * - "Step/Continue" enabled only at checkpoint
 * - "Kill" enabled when active
 * - "Unload" enabled when any script is loaded in editor
 */
function updateToolbar() {
  const loadedName = sourcePanel.getScriptName();
  const hasLoaded = !!loadedName;

  // Find running script that matches the loaded editor script
  let runningScript = null;
  if (loadedName) {
    for (const s of state.scripts.values()) {
      if (s.name === loadedName && ['running', 'paused', 'checkpoint', 'registered'].includes(s.state)) {
        runningScript = s;
        break;
      }
    }
  }

  const scriptState = runningScript?.state || null;
  const isActive = ['running', 'paused', 'checkpoint'].includes(scriptState);
  const isCheckpoint = scriptState === 'checkpoint';
  const isPaused = scriptState === 'paused';
  const isRunning = scriptState === 'running';
  const isV8Paused = v8Debug && v8PausedLine !== null;

  // Run: only when loaded and NOT currently active
  tbRun.disabled = !hasLoaded || !state.connected || isActive;

  // Debug: same as Run — breakpoints are optional (can step from line 1)
  tbDebug.disabled = !hasLoaded || !state.connected || isActive;
  tbDebug.title = editorBreakpoints.length > 0
    ? `Launch with ${editorBreakpoints.length} breakpoint${editorBreakpoints.length > 1 ? 's' : ''} (V8 inspector)`
    : 'Launch with V8 inspector (step from start)';

  // Pause / Resume toggle
  tbPause.style.display = isPaused ? 'none' : '';
  tbResume.style.display = isPaused ? '' : 'none';
  tbPause.disabled = !isRunning;
  tbResume.disabled = !isPaused;

  // Stop
  tbStop.disabled = !isActive;

  // Step / Continue: enabled at checkpoint OR when V8 paused
  tbStep.disabled = !isCheckpoint && !isV8Paused;
  tbContinue.disabled = !isCheckpoint && !isV8Paused;

  // Step Into / Step Out: only when V8 paused
  const tbStepInto = document.getElementById('tb-step-into');
  const tbStepOut = document.getElementById('tb-step-out');
  if (tbStepInto) tbStepInto.disabled = !isV8Paused;
  if (tbStepOut) tbStepOut.disabled = !isV8Paused;

  // Kill
  tbKill.disabled = !isActive;

  // Auth: enabled when script loaded, connected, not running, not already capturing
  tbAuth.disabled = !hasLoaded || !state.connected || isActive || !!authCaptureSessionId;

  // Check if auth state exists for the loaded script (async, non-blocking UI update)
  if (hasLoaded && state.connected) {
    chrome.runtime.sendMessage({ type: 'AUTH_CHECK', scriptName: loadedName }, (response) => {
      if (response?.exists) {
        tbAuth.classList.add('has-auth');
        tbAuth.title = 'Auth state saved — click to recapture';
      } else {
        tbAuth.classList.remove('has-auth');
        tbAuth.title = 'Capture auth state';
      }
    });
  } else {
    tbAuth.classList.remove('has-auth');
  }

  // Unload: when anything is loaded
  tbUnload.disabled = !hasLoaded;
}

// ---- Debug toolbar button handlers ----

// V8 debug state: tracks whether we have a V8 inspector attached
let v8Debug = false;       // true when script was launched with V8 inspector
let v8Pid = null;          // PID of the V8-debugged process (for commands before script registers)
let v8PausedLine = null;   // line number (1-indexed) when V8 paused
let v8PausedCallFrames = []; // call frames from V8 paused event

/**
 * Launch a script from the editor.
 * Run = no breakpoints, no debugger.
 * Debug = V8 inspector + line breakpoints for true stepping.
 */
function launchFromEditor(debug = false) {
  const name = sourcePanel.getScriptName();
  if (!name || !state.connected) return;

  // Save first, then launch
  if (sourcePanel.isDirty()) {
    const source = sourcePanel.getSource();
    chrome.runtime.sendMessage({ type: 'SCRIPT_LIBRARY_SAVE', name, source });
  }

  chrome.runtime.sendMessage({ type: 'BRIDGE_GET_INFO' }, (info) => {
    const scriptsDir = info?.scriptsDir || '';
    const scriptPath = `${scriptsDir}/${name}.mjs`;

    if (debug) {
      // V8 Debug mode: send line numbers for V8 breakpoints
      // editorBreakpoints may contain checkpoint names (strings) or raw line numbers
      const lineBreakpoints = editorBreakpoints
        .map(bp => typeof bp === 'number' ? bp : sourcePanel.checkpointLines[bp])
        .filter(Boolean);
      const bpCount = lineBreakpoints.length;
      bridgeStatus.textContent = bpCount > 0
        ? `Debug: ${bpCount} breakpoint${bpCount > 1 ? 's' : ''} (V8 inspector)`
        : 'Debug: stepping mode (V8 inspector)';
      v8Debug = true;
      v8Pid = null;
      v8PausedLine = null;
      chrome.runtime.sendMessage({
        type: 'SCRIPT_LAUNCH', path: scriptPath, args: [],
        lineBreakpoints, debug: true,
      }, (response) => {
        if (response?.success) {
          v8Pid = response.pid || null;
        } else {
          bridgeStatus.textContent = `Launch failed: ${response?.error || 'Unknown error'}`;
          v8Debug = false;
        }
      });
    } else {
      // Run mode: no debugger, runs straight through
      v8Debug = false;
      v8PausedLine = null;
      chrome.runtime.sendMessage({
        type: 'SCRIPT_LAUNCH', path: scriptPath, args: [],
      }, (response) => {
        if (!response?.success) {
          bridgeStatus.textContent = `Launch failed: ${response?.error || 'Unknown error'}`;
        }
      });
    }
  });
}

// Run: launch without debugger
tbRun.addEventListener('click', () => launchFromEditor(false));

// Debug: launch with V8 inspector for true line-level debugging
tbDebug.addEventListener('click', () => launchFromEditor(true));

tbPause.addEventListener('click', () => {
  const s = findRunningScriptForEditor();
  if (s) chrome.runtime.sendMessage({ type: 'SCRIPT_PAUSE', scriptId: s.scriptId });
});

tbResume.addEventListener('click', () => {
  const s = findRunningScriptForEditor();
  if (s) chrome.runtime.sendMessage({ type: 'SCRIPT_RESUME', scriptId: s.scriptId });
});

tbStop.addEventListener('click', () => {
  const s = findRunningScriptForEditor();
  if (s) chrome.runtime.sendMessage({ type: 'SCRIPT_CANCEL', scriptId: s.scriptId, reason: 'Stopped from toolbar' });
});

// Step Over (F10): execute current line, pause at next line
tbStep.addEventListener('click', () => {
  if (v8Debug) {
    const s = findRunningScriptForEditor();
    chrome.runtime.sendMessage({ type: 'DBG_STEP_OVER', scriptId: s?.scriptId, pid: v8Pid });
  } else {
    const s = findRunningScriptForEditor();
    if (s) chrome.runtime.sendMessage({ type: 'SCRIPT_STEP', scriptId: s.scriptId, clearAll: false });
  }
});

// Continue (F5): resume to next breakpoint
tbContinue.addEventListener('click', () => {
  if (v8Debug) {
    const s = findRunningScriptForEditor();
    chrome.runtime.sendMessage({ type: 'DBG_CONTINUE', scriptId: s?.scriptId, pid: v8Pid });
  } else {
    const s = findRunningScriptForEditor();
    if (s) chrome.runtime.sendMessage({ type: 'SCRIPT_STEP', scriptId: s.scriptId, clearAll: true });
  }
});

// Step Into (F11): step into function call (V8 only)
const tbStepIntoEl = document.getElementById('tb-step-into');
if (tbStepIntoEl) {
  tbStepIntoEl.addEventListener('click', () => {
    if (v8Debug) {
      const s = findRunningScriptForEditor();
      chrome.runtime.sendMessage({ type: 'DBG_STEP_INTO', scriptId: s?.scriptId, pid: v8Pid });
    }
  });
}

// Step Out (Shift+F11): step out of current function (V8 only)
const tbStepOutEl = document.getElementById('tb-step-out');
if (tbStepOutEl) {
  tbStepOutEl.addEventListener('click', () => {
    if (v8Debug) {
      const s = findRunningScriptForEditor();
      chrome.runtime.sendMessage({ type: 'DBG_STEP_OUT', scriptId: s?.scriptId, pid: v8Pid });
    }
  });
}

tbKill.addEventListener('click', () => {
  const s = findRunningScriptForEditor();
  if (s) chrome.runtime.sendMessage({ type: 'SCRIPT_CANCEL', scriptId: s.scriptId, reason: 'Force killed from toolbar', force: true });
});

tbUnload.addEventListener('click', () => {
  sourcePanel.unload();
  editorBreakpoints = [];
  state.selectedScriptId = null;
  v8Debug = false;
  v8Pid = null;
  v8PausedLine = null;
  v8PausedCallFrames = [];
  // Cancel any active auth capture
  if (authCaptureSessionId) {
    chrome.runtime.sendMessage({ type: 'BRIDGE_DESTROY_SESSION', sessionId: authCaptureSessionId });
    authCaptureSessionId = null;
    authCaptureScriptName = null;
    document.getElementById('auth-capture-bar').style.display = 'none';
    document.getElementById('auth-url-input').style.display = 'none';
  }
  scriptPanel.render(state.scripts, null);
  debugPanel.update(null);
  updateToolbar();
});

/**
 * Find the running script entry that matches whatever is loaded in the editor.
 */
function findRunningScriptForEditor() {
  const name = sourcePanel.getScriptName();
  if (!name) return null;
  for (const s of state.scripts.values()) {
    if (s.name === name && ['running', 'paused', 'checkpoint', 'registered'].includes(s.state)) {
      return s;
    }
  }
  return null;
}

// ---- Auth capture ----

/**
 * Extract the first page.goto('url') from script source.
 * Returns the URL string or null if not found (e.g. URL is a variable).
 */
function findFirstGotoUrl(source) {
  const m = source.match(/page\.goto\(\s*['"]([^'"]+)['"]\s*[,)]/);
  return m ? m[1] : null;
}

/**
 * Start auth capture: open browser to URL, let user log in.
 */
function startAuthCapture(scriptName, url) {
  const captureBar = document.getElementById('auth-capture-bar');
  const urlInput = document.getElementById('auth-url-input');

  authCaptureScriptName = scriptName;
  bridgeStatus.textContent = `Auth: opening browser for ${scriptName}...`;

  chrome.runtime.sendMessage({ type: 'AUTH_CAPTURE_START', scriptName, url }, (response) => {
    if (response?.success || response?.sessionId) {
      authCaptureSessionId = response.sessionId;
      captureBar.style.display = 'flex';
      urlInput.style.display = 'none';
      bridgeStatus.textContent = `Auth: log in at ${url}, then click Save`;
      updateToolbar();
    } else {
      bridgeStatus.textContent = `Auth capture failed: ${response?.error || 'Unknown error'}`;
      authCaptureSessionId = null;
      authCaptureScriptName = null;
    }
  });
}

// Auth button click
tbAuth.addEventListener('click', () => {
  const name = sourcePanel.getScriptName();
  if (!name || !state.connected) return;

  // Save dirty editor first
  if (sourcePanel.isDirty()) {
    const source = sourcePanel.getSource();
    chrome.runtime.sendMessage({ type: 'SCRIPT_LIBRARY_SAVE', name, source });
  }

  // Try to extract URL from source
  const source = sourcePanel.getSource();
  const url = findFirstGotoUrl(source);

  if (url) {
    startAuthCapture(name, url);
  } else {
    // Show URL input prompt
    const urlInput = document.getElementById('auth-url-input');
    const urlField = document.getElementById('auth-url-field');
    urlInput.style.display = 'flex';
    urlField.value = '';
    urlField.focus();
    authCaptureScriptName = name;
  }
});

// Auth URL input — Go button
document.getElementById('auth-url-ok').addEventListener('click', () => {
  const urlField = document.getElementById('auth-url-field');
  const url = urlField.value.trim();
  if (!url || !authCaptureScriptName) return;
  startAuthCapture(authCaptureScriptName, url);
});
document.getElementById('auth-url-field').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('auth-url-ok').click();
});

// Auth URL input — Cancel
document.getElementById('auth-url-cancel').addEventListener('click', () => {
  document.getElementById('auth-url-input').style.display = 'none';
  authCaptureScriptName = null;
});

// Auth capture — Save & Close
document.getElementById('auth-save-btn').addEventListener('click', () => {
  if (!authCaptureSessionId || !authCaptureScriptName) return;

  bridgeStatus.textContent = 'Auth: saving state...';
  chrome.runtime.sendMessage({
    type: 'AUTH_CAPTURE_SAVE',
    sessionId: authCaptureSessionId,
    scriptName: authCaptureScriptName,
  }, (response) => {
    document.getElementById('auth-capture-bar').style.display = 'none';
    if (response?.success || response?.path) {
      bridgeStatus.textContent = `Auth state saved for ${authCaptureScriptName}`;
      pushActivity(`Auth state saved: ${authCaptureScriptName}`);
    } else {
      bridgeStatus.textContent = `Auth save failed: ${response?.error || 'Unknown error'}`;
    }
    authCaptureSessionId = null;
    authCaptureScriptName = null;
    updateToolbar();
  });
});

// Auth capture — Cancel
document.getElementById('auth-cancel-btn').addEventListener('click', () => {
  if (authCaptureSessionId) {
    // Destroy the session without saving
    chrome.runtime.sendMessage({ type: 'BRIDGE_DESTROY_SESSION', sessionId: authCaptureSessionId });
  }
  document.getElementById('auth-capture-bar').style.display = 'none';
  bridgeStatus.textContent = 'Auth capture cancelled';
  authCaptureSessionId = null;
  authCaptureScriptName = null;
  updateToolbar();
});

// ---- Snippet palette toggle ----
document.getElementById('view-snippets-btn').addEventListener('click', () => {
  const palette = document.getElementById('snippet-palette');
  const snippetBtn = document.getElementById('view-snippets-btn');
  const isOpen = palette.style.display !== 'none';
  if (isOpen) {
    palette.style.display = 'none';
    snippetBtn.classList.remove('active');
  } else {
    palette.style.display = '';
    snippetBtn.classList.add('active');
    renderSnippetPalette();
  }
});

function renderSnippetPalette() {
  const container = document.getElementById('snippet-categories');
  const formEl = document.getElementById('snippet-form');
  formEl.style.display = 'none';

  const groups = getSnippetsByCategory();
  container.innerHTML = Object.entries(groups).map(([category, snippets]) => {
    const items = snippets.map(s =>
      `<div class="dash-snippet-item" data-snippet-id="${s.id}">
        <span class="dash-snippet-item-name">${escHtml(s.name)}</span>
        <span class="dash-snippet-item-desc">${escHtml(s.description)}</span>
      </div>`
    ).join('');
    return `<div class="dash-snippet-cat-label">${escHtml(category)}</div>${items}`;
  }).join('');

  container.querySelectorAll('.dash-snippet-item').forEach(el => {
    el.addEventListener('click', () => openSnippetForm(el.dataset.snippetId));
  });
}

function openSnippetForm(snippetId, prefilled = {}) {
  const snippet = getSnippet(snippetId);
  if (!snippet) return;

  const container = document.getElementById('snippet-categories');
  const formEl = document.getElementById('snippet-form');
  container.style.display = 'none';
  formEl.style.display = '';

  const paramRows = snippet.params.map(p =>
    `<div class="dash-snippet-form-row">
      <span class="dash-snippet-form-label">${escHtml(p.label)}</span>
      <input class="dash-snippet-form-input" data-param="${p.name}" value="${escHtml(prefilled[p.name] ?? p.default ?? '')}" spellcheck="false">
    </div>`
  ).join('');

  const initialValues = Object.fromEntries(snippet.params.map(p => [p.name, prefilled[p.name] ?? p.default ?? '']));
  const preview = renderSnippet(snippetId, initialValues);

  formEl.innerHTML = `
    <div class="dash-snippet-form-title">${escHtml(snippet.name)}</div>
    ${paramRows}
    <div class="dash-snippet-preview" id="snippet-preview">${escHtml(preview)}</div>
    <div class="dash-snippet-form-btns">
      <button class="dash-btn secondary" id="snippet-back">Back</button>
      <button class="dash-btn primary" id="snippet-insert">Insert</button>
    </div>
  `;

  // Live preview on input change
  const inputs = formEl.querySelectorAll('.dash-snippet-form-input');
  inputs.forEach(input => {
    input.addEventListener('input', () => {
      const values = {};
      inputs.forEach(inp => { values[inp.dataset.param] = inp.value; });
      document.getElementById('snippet-preview').textContent = renderSnippet(snippetId, values);
    });
  });

  document.getElementById('snippet-back').addEventListener('click', () => {
    formEl.style.display = 'none';
    container.style.display = '';
  });

  document.getElementById('snippet-insert').addEventListener('click', () => {
    const values = {};
    inputs.forEach(inp => { values[inp.dataset.param] = inp.value; });
    const code = renderSnippet(snippetId, values);
    sourcePanel.insertSnippet(code);

    // Close palette and switch to source view
    document.getElementById('snippet-palette').style.display = 'none';
    document.getElementById('view-snippets-btn').classList.remove('active');
    setView('source');
  });
}

// ---- Sessions section collapse ----
const sessionsToggle = document.getElementById('sessions-toggle');
const sessionsBody   = document.getElementById('sessions-body');
const sessionsArrow  = document.getElementById('sessions-arrow');
sessionsToggle.addEventListener('click', (e) => {
  // Don't collapse when clicking the Refresh button
  if (e.target.id === 'dash-refresh-processes') return;
  const open = sessionsBody.style.display !== 'none';
  sessionsBody.style.display = open ? 'none' : '';
  sessionsArrow.classList.toggle('open', !open);
});

// Refresh button — scan for running browser processes
document.getElementById('dash-refresh-processes').addEventListener('click', (e) => {
  e.stopPropagation();
  const btn = e.target;
  btn.textContent = 'Scanning...';
  btn.disabled = true;
  loadSessions();
  loadProcesses();
  setTimeout(() => { btn.textContent = 'Refresh'; btn.disabled = false; }, 1000);
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
  const totalCount = state.sessions.length + state.processes.length;
  document.getElementById('sessions-count').textContent = totalCount;
  destroySessionBtn.disabled = !state.activeSessionId || !state.connected;

  let html = '';

  // Playwright API sessions
  if (state.sessions.length > 0) {
    html += state.sessions.map(s => {
      const stateClass = (s.state || 'IDLE').toUpperCase();
      return `<div class="dash-session-item ${s.id === state.activeSessionId ? 'active' : ''}" data-sid="${s.id}">
        <div class="dash-session-dot ${stateClass}"></div>
        <span class="dash-session-name">${escHtml(s.name || s.id)}</span>
        <span class="dash-session-state">${s.state || 'idle'}</span>
      </div>`;
    }).join('');
  }

  // Browser processes
  if (state.processes.length > 0) {
    html += '<div class="dash-process-subhdr">Browser Processes</div>';
    html += state.processes.map(p => {
      const isOrphan = !p.ownerScriptId;
      const dotClass = isOrphan ? 'orphan' : 'owned';
      const typeLabel = p.type === 'debug-profile' ? 'chrome' : 'playwright';
      const label = isOrphan ? `${typeLabel}` : escHtml(p.ownerScriptName);
      const isSelf = p.isSelf;
      const killBtn = isSelf
        ? '<span style="font-size:9px;color:#5f5f7f;" title="This is the browser running the dashboard">self</span>'
        : `<button class="dash-process-kill" data-kill-pid="${p.pid}">Kill</button>`;
      return `<div class="dash-process-item" data-pid="${p.pid}">
        <div class="dash-process-dot ${dotClass}"></div>
        <span class="dash-process-pid">${p.pid}</span>
        <span class="dash-process-info">${label}</span>
        <span class="dash-process-elapsed">${formatElapsed(p.elapsedSeconds)}</span>
        ${killBtn}
      </div>`;
    }).join('');
  }

  if (!html) {
    html = '<div class="dash-empty" style="padding:12px;">No sessions</div>';
  }

  body.innerHTML = html;

  // Wire session click handlers
  body.querySelectorAll('.dash-session-item').forEach(el => {
    el.addEventListener('click', () => {
      state.activeSessionId = el.dataset.sid;
      destroySessionBtn.disabled = false;
      renderSessions();
    });
  });

  // Wire kill buttons
  body.querySelectorAll('.dash-process-kill').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pid = parseInt(btn.dataset.killPid, 10);
      // No confirm() — auto-dismissed in Playwright Chromium
      btn.disabled = true;
      btn.textContent = 'Killing...';
      chrome.runtime.sendMessage({ type: 'KILL_PROCESS', pid }, () => {
        setTimeout(() => loadProcesses(), 1500);
      });
    });
  });
}

function loadProcesses() {
  if (!state.connected) { state.processes = []; renderSessions(); return; }
  chrome.runtime.sendMessage({ type: 'SYSTEM_PROCESSES' }, (response) => {
    const extPath = chrome.runtime.getURL('').replace('chrome-extension://', '').replace(/\/$/, '');
    state.processes = (response?.processes || []).map(p => ({
      ...p,
      // Tag "self" if this browser loaded our extension
      isSelf: p.loadExtension && chrome.runtime.getURL('').includes(chrome.runtime.id) &&
              p.loadExtension.includes('contextual-recall/extension')
    }));
    renderSessions();
  });
}

function formatElapsed(seconds) {
  if (seconds == null) return '';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// Session create — inline name input (prompt() is auto-dismissed in Playwright automation Chromium)
const sessionActions  = document.getElementById('session-actions');
const sessionNameRow  = document.getElementById('session-name-input');
const sessionNameField = document.getElementById('session-name-field');
const sessionNameOk   = document.getElementById('session-name-ok');
const sessionNameCancel = document.getElementById('session-name-cancel');

function showSessionNameInput() {
  sessionNameField.value = `session_${state.sessions.length + 1}`;
  sessionActions.style.display = 'none';
  sessionNameRow.style.display = 'flex';
  sessionNameField.focus();
  sessionNameField.select();
}
function hideSessionNameInput() {
  sessionNameRow.style.display = 'none';
  sessionActions.style.display = 'flex';
}
function createSessionWithName() {
  const name = sessionNameField.value.trim();
  if (!name) return;
  hideSessionNameInput();
  newSessionBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'BRIDGE_CREATE_SESSION', name, options: {} }, (response) => {
    newSessionBtn.disabled = false;
    if (response?.success) {
      state.activeSessionId = response.session?.id;
      loadSessions();
    }
  });
}

newSessionBtn.addEventListener('click', showSessionNameInput);
sessionNameOk.addEventListener('click', createSessionWithName);
sessionNameCancel.addEventListener('click', hideSessionNameInput);
sessionNameField.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createSessionWithName();
  if (e.key === 'Escape') hideSessionNameInput();
});

// Session destroy — no confirm() (auto-dismissed in Playwright Chromium)
destroySessionBtn.addEventListener('click', () => {
  if (!state.activeSessionId) return;
  destroySessionBtn.disabled = true;
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

  // Load source into Monaco — first try library, then fall back to bridge file read
  const scriptName = script?.name;
  if (scriptName) {
    chrome.runtime.sendMessage({ type: 'SCRIPT_LIBRARY_GET', name: scriptName }, (response) => {
      if (response?.success && response.script) {
        const checkpointLines = findCheckpointLines(response.script.source);
        // Merge server breakpoints into editor breakpoints
        const serverBp = script?.activeBreakpoints || [];
        editorBreakpoints = [...new Set([...editorBreakpoints, ...serverBp])];
        sourcePanel.loadSource(response.script.source, response.script.originalPath,
          checkpointLines, editorBreakpoints, script?.checkpoint?.name || null, scriptName);
        updateToolbar();
      } else {
        // Fall back to loading from disk via bridge
        const scriptPath = script?.metadata?.path;
        if (scriptPath && state.connected) {
          chrome.runtime.sendMessage({ type: 'SCRIPT_GET_SOURCE', path: scriptPath }, (srcResp) => {
            if (srcResp?.success && srcResp.source) {
              const checkpointLines = findCheckpointLines(srcResp.source);
              sourcePanel.loadSource(srcResp.source, scriptPath, checkpointLines,
                script?.activeBreakpoints || [], script?.checkpoint?.name || null, null);
              updateToolbar();
            }
          });
        }
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
  if (action === 'dismiss') {
    state.scripts.delete(scriptId);
    if (state.selectedScriptId === scriptId) {
      state.selectedScriptId = null;
      debugPanel.update(null);
      updateToolbar();
    }
    scriptPanel.render(state.scripts, state.selectedScriptId);
    return;
  }
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

// ---- Script Library modal ----

let libraryScripts = []; // cached library entries
let selectedLibraryName = null;

function openModal() {
  loadLibrary();
  modalOverlay.classList.add('open');
  importPath.focus();
}
function closeModal() {
  modalOverlay.classList.remove('open');
  selectedLibraryName = null;
}

function loadLibrary() {
  chrome.runtime.sendMessage({ type: 'SCRIPT_LIBRARY_LIST' }, (response) => {
    libraryScripts = response?.scripts || [];
    renderLibrary();
  });
}

function renderLibrary() {
  libraryCount.textContent = libraryScripts.length > 0 ? `(${libraryScripts.length})` : '';
  if (libraryScripts.length === 0) {
    libraryList.innerHTML = '<div class="dash-recent-empty">No scripts imported</div>';
    return;
  }
  libraryList.innerHTML = libraryScripts.map(s => {
    const sizeStr = s.size > 1024 ? `${(s.size / 1024).toFixed(0)}KB` : `${s.size}B`;
    const dateStr = new Date(s.modifiedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const isSelected = s.name === selectedLibraryName;
    return `<div class="dash-library-item ${isSelected ? 'selected' : ''}" data-name="${escHtml(s.name)}" title="${escHtml(s.originalPath || '')}">
      <span class="dash-library-name">${escHtml(s.name)}</span>
      <span class="dash-library-meta">${sizeStr}</span>
      <span class="dash-library-meta">${dateStr}</span>
      <button class="dash-library-open" data-name="${escHtml(s.name)}" title="Open in editor">Open</button>
      <button class="dash-library-remove" data-name="${escHtml(s.name)}" title="Remove from library">&#x2715;</button>
    </div>`;
  }).join('');

  // Click to select (highlight only, no auto-load)
  libraryList.querySelectorAll('.dash-library-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('dash-library-remove') || e.target.classList.contains('dash-library-open')) return;
      selectedLibraryName = el.dataset.name;
      renderLibrary();
    });
  });

  // Open button → load into Monaco
  libraryList.querySelectorAll('.dash-library-open').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      loadLibraryScript(btn.dataset.name);
    });
  });

  // Remove button
  libraryList.querySelectorAll('.dash-library-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = btn.dataset.name;
      chrome.runtime.sendMessage({ type: 'SCRIPT_LIBRARY_REMOVE', name }, () => {
        if (selectedLibraryName === name) {
          selectedLibraryName = null;
        }
        loadLibrary();
      });
    });
  });
}

function loadLibraryScript(name) {
  chrome.runtime.sendMessage({ type: 'SCRIPT_LIBRARY_GET', name }, (response) => {
    if (response?.success && response.script) {
      const script = response.script;
      const checkpointLines = findCheckpointLines(script.source);
      // Reset editor breakpoints when loading a new script
      editorBreakpoints = [];
      sourcePanel.loadSource(
        script.source,
        script.originalPath || `~/.contextual-recall/scripts/${name}.mjs`,
        checkpointLines,
        [], null,
        name
      );
      setView('source');
      closeModal();
      updateToolbar();
    }
  });
}

openBtn.addEventListener('click', openModal);
document.getElementById('dash-modal-close').addEventListener('click', closeModal);
document.getElementById('dash-modal-cancel').addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
importPath.addEventListener('keydown', (e) => { if (e.key === 'Enter') importBtn.click(); });

// ---- Import ----
importBtn.addEventListener('click', () => {
  const path = importPath.value.trim();
  if (!path) { importPath.focus(); return; }
  if (!state.connected) {
    bridgeStatus.textContent = 'Connect to bridge first to import scripts';
    return;
  }
  importBtn.disabled = true;
  importBtn.textContent = 'Importing...';
  chrome.runtime.sendMessage({ type: 'SCRIPT_IMPORT', path }, (response) => {
    importBtn.disabled = false;
    importBtn.textContent = 'Import';
    if (response?.success) {
      importPath.value = '';
      loadLibrary();
      // Load imported script into editor
      loadLibraryScript(response.script.name);
    } else {
      bridgeStatus.textContent = `Import failed: ${response?.error || 'Unknown error'}`;
    }
  });
});

// ---- Ctrl+S Save (wired to source panel) ----
sourcePanel.onSave = (name, source) => {
  chrome.runtime.sendMessage({ type: 'SCRIPT_LIBRARY_SAVE', name, source }, (response) => {
    if (response?.success) {
      console.log(`[Dashboard] Saved ${name}`);
    } else {
      console.error(`[Dashboard] Save failed:`, response?.error);
      bridgeStatus.textContent = `Save failed: ${response?.error || 'Unknown error'}`;
    }
  });
};

// ---- Snapshot element click → snippet context menu ----
sourcePanel.onElementClick = (element, event) => {
  // Remove any existing context menu
  const existing = document.querySelector('.dash-snap-ctx-menu');
  if (existing) existing.remove();

  const suggestions = suggestFromElement(element);
  if (suggestions.length === 0) return;

  const menu = document.createElement('div');
  menu.className = 'dash-snap-ctx-menu';
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  menu.innerHTML = suggestions.map((s, i) =>
    `<div class="dash-snap-ctx-item" data-idx="${i}">${escHtml(s.label)}</div>`
  ).join('');

  document.body.appendChild(menu);

  // Adjust if off-screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;

  menu.querySelectorAll('.dash-snap-ctx-item').forEach(item => {
    item.addEventListener('click', () => {
      const s = suggestions[parseInt(item.dataset.idx)];
      menu.remove();
      // Open snippet form with pre-filled values
      openSnippetForm(s.snippetId, s.values);
      // Show snippet palette + source view
      document.getElementById('snippet-palette').style.display = '';
      document.getElementById('view-snippets-btn').classList.add('active');
    });
  });

  // Close on click outside
  const closeHandler = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', closeHandler, true);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
};

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

      // Auto-select script that matches the loaded editor script
      const loadedName = sourcePanel.getScriptName();
      if (loadedName && updated.name === loadedName) {
        if (['running', 'registered', 'checkpoint', 'paused'].includes(updated.state)) {
          state.selectedScriptId = message.scriptId;
        } else if (['complete', 'cancelled', 'killed', 'error'].includes(updated.state) &&
                   state.selectedScriptId === message.scriptId) {
          // Clear selection on terminal state so next launch can auto-select
          state.selectedScriptId = null;
          // Clear checkpoint highlight but keep editor breakpoints visible
          sourcePanel.updateDecorations([...editorBreakpoints], null);
          // Clear V8 debug state
          if (v8Debug) {
            v8Debug = false;
            v8Pid = null;
            v8PausedLine = null;
            v8PausedCallFrames = [];
            sourcePanel.clearV8Highlight();
          }
          debugPanel.update(updated);
        }
      }

      scriptPanel.render(state.scripts, state.selectedScriptId);
      updateToolbar();

      if (message.scriptId === state.selectedScriptId) {
        debugPanel.update(updated);

        // Update Monaco decorations when checkpoint state changes
        // Merge server breakpoints with editor-local breakpoints for display
        if (updated.activeBreakpoints || updated.checkpoint !== prev.checkpoint) {
          const merged = [...new Set([...editorBreakpoints, ...(updated.activeBreakpoints || [])])];
          sourcePanel.updateDecorations(merged, updated.checkpoint?.name || null);
        }
        // Scroll to current checkpoint line when paused at checkpoint
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
      if (message.state === 'destroyed') {
        state.sessions = state.sessions.filter(s => s.id !== message.sessionId);
        if (state.activeSessionId === message.sessionId) state.activeSessionId = null;
        renderSessions();
      } else {
        const session = state.sessions.find(s => s.id === message.sessionId);
        if (session) {
          session.state = message.state;
          renderSessions();
        } else {
          loadSessions(); // new session created in another UI
        }
      }
      break;
    }

    case 'AUTO_BROADCAST_CONNECTION': {
      state.connected = message.connected;
      updateTopBar();
      updateToolbar();
      if (message.connected) { loadSessions(); loadScripts(); loadLibrary(); loadProcesses(); }
      break;
    }

    case 'AUTO_BROADCAST_DBG_PAUSED': {
      // V8 inspector paused at a line
      v8PausedLine = message.line;
      v8PausedCallFrames = message.callFrames || [];
      sourcePanel.highlightV8Line(message.line);
      pushActivity(`V8 paused: line ${message.line} (${message.reason || 'breakpoint'})`);
      updateToolbar();
      // Update debug panel with V8 pause info
      if (state.selectedScriptId) {
        const script = state.scripts.get(state.selectedScriptId);
        if (script) {
          script._v8Paused = true;
          script._v8Line = message.line;
          script._v8CallFrames = message.callFrames || [];
          debugPanel.update(script);
        }
      }
      break;
    }

    case 'AUTO_BROADCAST_DBG_RESUMED': {
      // V8 inspector resumed
      v8PausedLine = null;
      v8PausedCallFrames = [];
      sourcePanel.clearV8Highlight();
      updateToolbar();
      if (state.selectedScriptId) {
        const script = state.scripts.get(state.selectedScriptId);
        if (script) {
          script._v8Paused = false;
          script._v8Line = null;
          script._v8CallFrames = [];
          debugPanel.update(script);
        }
      }
      break;
    }

    case 'AUTO_BROADCAST_FILE_CHANGED': {
      const { name, deleted } = message;
      // Refresh library list in modal
      loadLibrary();

      if (deleted) break;

      // Check if the changed file is currently open in Monaco
      const currentName = sourcePanel.getScriptName();
      if (currentName && currentName === name) {
        if (sourcePanel.isDirty()) {
          // Editor has unsaved changes — show notification bar
          showFileChangedBar(name);
        } else {
          // Editor is clean — auto-reload from storage
          reloadEditorFromStorage(name);
        }
      }
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

// ---- File-changed notification bar ----
function showFileChangedBar(name) {
  const existing = document.getElementById('file-changed-bar');
  if (existing) existing.remove();

  const bar = document.createElement('div');
  bar.id = 'file-changed-bar';
  bar.className = 'dash-file-changed-bar';
  bar.innerHTML = `<span>File <b>${escHtml(name)}.mjs</b> changed on disk.</span>
    <button class="dash-btn primary" id="file-changed-reload">Reload</button>
    <button class="dash-btn secondary" id="file-changed-keep">Keep mine</button>`;

  const centerCol = document.getElementById('center-col');
  const toolbar = centerCol.querySelector('.dash-source-toolbar');
  toolbar.after(bar);

  document.getElementById('file-changed-reload').addEventListener('click', () => {
    reloadEditorFromStorage(name);
    bar.remove();
  });
  document.getElementById('file-changed-keep').addEventListener('click', () => {
    bar.remove();
  });
}

function reloadEditorFromStorage(name) {
  chrome.runtime.sendMessage({ type: 'SCRIPT_LIBRARY_GET', name }, (response) => {
    if (response?.success && response.script) {
      const checkpointLines = findCheckpointLines(response.script.source);
      const script = state.scripts.get(state.selectedScriptId);
      sourcePanel.loadSource(response.script.source, response.script.originalPath,
        checkpointLines, script?.activeBreakpoints || [], script?.checkpoint?.name || null, name);
    }
  });
}

// ---- Utilities ----
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ---- Startup ----
function init() {
  updateTopBar();
  updateToolbar();
  renderSessions();
  renderActivityFeed();
  scriptPanel.render(state.scripts, null);
  debugPanel.update(null);

  // Load library from chrome.storage.local (works without bridge)
  loadLibrary();

  chrome.runtime.sendMessage({ type: 'BRIDGE_STATUS' }, (response) => {
    state.connected = response?.connected || false;
    updateTopBar();
    updateToolbar();
    if (state.connected) {
      loadSessions();
      loadScripts();
      loadProcesses();
    }
  });
}

init();
console.log('[Dashboard] Monaco debugger initialized');

// ---- Test API (exposed for dashboard-driver.mjs) ----
window.__dashTest = {
  toggleBreakpoint(name) {
    if (sourcePanel.onBreakpointToggle) sourcePanel.onBreakpointToggle(name);
  },
  getBreakpoints() { return [...editorBreakpoints]; },
  getState() {
    return {
      connected: state.connected,
      selectedScriptId: state.selectedScriptId,
      loadedScript: sourcePanel.getScriptName(),
      editorBreakpoints: [...editorBreakpoints],
      v8Debug,
      v8Pid,
      v8PausedLine,
      scripts: [...state.scripts.entries()].map(([id, s]) => ({
        id, name: s.name, state: s.state,
        checkpoint: s.checkpoint?.name || null,
        activeBreakpoints: s.activeBreakpoints || [],
      })),
    };
  },
  launchRun() { launchFromEditor(false); },
  launchDebug() { launchFromEditor(true); },
  step() {
    if (v8Debug) {
      const s = findRunningScriptForEditor();
      chrome.runtime.sendMessage({ type: 'DBG_STEP_OVER', scriptId: s?.scriptId, pid: v8Pid });
      return 'v8-step pid=' + v8Pid;
    }
    const s = findRunningScriptForEditor();
    if (!s) return 'no running script';
    chrome.runtime.sendMessage({ type: 'SCRIPT_STEP', scriptId: s.scriptId, clearAll: false });
    return 'stepped ' + s.scriptId;
  },
  continue() {
    if (v8Debug) {
      const s = findRunningScriptForEditor();
      chrome.runtime.sendMessage({ type: 'DBG_CONTINUE', scriptId: s?.scriptId, pid: v8Pid });
      return 'v8-continue pid=' + v8Pid;
    }
    const s = findRunningScriptForEditor();
    if (!s) return 'no running script';
    chrome.runtime.sendMessage({ type: 'SCRIPT_STEP', scriptId: s.scriptId, clearAll: true });
    return 'continued ' + s.scriptId;
  },
  stepInto() {
    if (!v8Debug) return 'no V8 debug session';
    const s = findRunningScriptForEditor();
    chrome.runtime.sendMessage({ type: 'DBG_STEP_INTO', scriptId: s?.scriptId, pid: v8Pid });
    return 'step-into pid=' + v8Pid;
  },
  stepOut() {
    if (!v8Debug) return 'no V8 debug session';
    const s = findRunningScriptForEditor();
    chrome.runtime.sendMessage({ type: 'DBG_STEP_OUT', scriptId: s?.scriptId, pid: v8Pid });
    return 'step-out pid=' + v8Pid;
  },
};
