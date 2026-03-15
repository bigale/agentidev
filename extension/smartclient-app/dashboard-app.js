/**
 * SC-4b: Dashboard app logic — renders the PortalLayout config,
 * manages state from bridge broadcasts, and refreshes toolbar buttons.
 *
 * Loaded inside the sandbox iframe (app.html).
 * Communicates with bridge.js via postMessage.
 */

// ---- Dashboard state ----
var _dashState = {
  connected: false,
  selectedScriptId: null,
  selectedScript: null,
  v8Paused: false,
};

// ---- Load dashboard ----

function loadDashboard() {
  // Hide prompt bar — not needed in dashboard mode
  var promptBar = document.getElementById('ai-prompt-bar');
  if (promptBar) promptBar.style.display = 'none';
  document.body.style.paddingTop = '0';

  // Clear default Notes app
  clearNotesApp();

  // Render the dashboard config
  if (window._dashboardConfig) {
    renderConfig(window._dashboardConfig);
  }

  // Wire scripts grid recordClick for selection tracking
  var scriptsGrid = resolveRef('scriptsGrid');
  if (scriptsGrid) {
    scriptsGrid.recordClick = function (viewer, record) {
      _dashState.selectedScriptId = record ? record.id : null;
      _dashState.selectedScript = record || null;

      var dv = resolveRef('debugViewer');
      if (dv && record) dv.setData([record]);
      else if (dv) dv.setData([]);

      refreshToolbar();
    };
  }

  // Listen for broadcasts
  window.addEventListener('message', handleDashboardMessage);

  // Request initial connection status
  dispatchAction('BRIDGE_STATUS', {});

  console.log('[Dashboard] Loaded SC-4 dashboard');
}

// ---- Broadcast handler ----

function handleDashboardMessage(event) {
  var msg = event.data;
  if (!msg) return;

  if (msg.source === 'smartclient-broadcast') {
    handleBroadcast(msg.type, msg.payload);
    return;
  }

  if (msg.source === 'smartclient-action-response') {
    handleActionResponse(msg);
    return;
  }
}

function handleBroadcast(type, payload) {
  switch (type) {
    case 'AUTO_BROADCAST_CONNECTION':
      _dashState.connected = payload.connected;
      updateConnectionUI();
      refreshToolbar();
      break;

    case 'AUTO_BROADCAST_SCRIPT':
      handleScriptBroadcast(payload);
      break;

    case 'AUTO_BROADCAST_STATUS':
      // Sessions updated — grids auto-refresh via DS invalidation
      break;

    case 'AUTO_BROADCAST_SCHEDULE':
      // Schedules updated — grids auto-refresh via DS invalidation
      break;

    case 'AUTO_COMMAND_UPDATE':
      // Activity log — grids auto-refresh via DS invalidation
      break;
  }
}

function handleScriptBroadcast(payload) {
  // Track selected script state
  if (_dashState.selectedScriptId && payload.scriptId === _dashState.selectedScriptId) {
    _dashState.selectedScript = payload;

    // Update debug viewer
    var dv = resolveRef('debugViewer');
    if (dv) dv.setData([payload]);
  }

  refreshToolbar();
}

function handleActionResponse(msg) {
  // Handle connection response — update state
  if (msg.response && typeof msg.response.connected !== 'undefined') {
    _dashState.connected = msg.response.connected;
    updateConnectionUI();
    refreshToolbar();
  }
}

// ---- Connection UI ----

function updateConnectionUI() {
  var dot = document.getElementById('sc-status-dot');
  if (dot) {
    dot.style.background = _dashState.connected ? '#4CAF50' : '#f44336';
  }

  var label = resolveRef('tbStatusLabel');
  if (label) {
    label.setContents(_dashState.connected ? 'Connected' : 'Disconnected');
  }

  var connectBtn = resolveRef('tbConnect');
  if (connectBtn) {
    connectBtn.setTitle(_dashState.connected ? 'Disconnect' : 'Connect');
    // Rewire action based on state
    if (_dashState.connected) {
      connectBtn.click = function () { dispatchAction('BRIDGE_DISCONNECT', {}); };
    } else {
      connectBtn.click = function () { dispatchAction('BRIDGE_CONNECT', { port: 9876 }); };
    }
  }
}

// ---- Toolbar state management ----
// Mirrors logic from dashboard.js updateToolbar()

function refreshToolbar() {
  var script = _dashState.selectedScript;
  var hasSelected = !!_dashState.selectedScriptId;
  var connected = _dashState.connected;

  var scriptState = script ? script.state : null;
  var isActive = ['running', 'paused', 'checkpoint'].indexOf(scriptState) >= 0;
  var isRunning = scriptState === 'running';
  var isPaused = scriptState === 'paused';
  var isCheckpoint = scriptState === 'checkpoint';
  var v8Paused = _dashState.v8Paused;

  // Run: enabled when selected, connected, NOT active
  setButtonDisabled('tbRun', !hasSelected || !connected || isActive);

  // Pause / Resume
  setButtonDisabled('tbPause', !isRunning);
  setButtonDisabled('tbResume', !isPaused);

  // Stop
  setButtonDisabled('tbStop', !isActive);

  // Step / Continue: enabled at checkpoint OR v8Paused
  setButtonDisabled('tbStep', !isCheckpoint && !v8Paused);
  setButtonDisabled('tbContinue', !isCheckpoint && !v8Paused);

  // Kill
  setButtonDisabled('tbKill', !isActive);

  // Debug panel buttons
  setButtonDisabled('dbgStep', !isCheckpoint && !v8Paused);
  setButtonDisabled('dbgContinue', !isCheckpoint && !v8Paused);
  setButtonDisabled('dbgKill', !isActive);

  // Wire scriptId into Step/Continue dispatch payloads
  if (script && script.id) {
    wireStepPayload('tbStep', script.id, false);
    wireStepPayload('tbContinue', script.id, true);
    wireStepPayload('dbgStep', script.id, false);
    wireStepPayload('dbgContinue', script.id, true);
  }
}

function setButtonDisabled(id, disabled) {
  var btn = resolveRef(id);
  if (btn && btn.setDisabled) {
    btn.setDisabled(disabled);
  }
}

function wireStepPayload(id, scriptId, clearAll) {
  var btn = resolveRef(id);
  if (btn) {
    btn.click = function () {
      dispatchAction('SCRIPT_STEP', { scriptId: scriptId, clearAll: clearAll });
    };
  }
}
