// dashboard/broadcast.js
// Bridge broadcast handlers + connection UI.
// Functions: handleDashboardMessage, handleBroadcast, handleScriptBroadcast, handleActionResponse, updateConnectionUI

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

  if (msg.source === 'smartclient-layout-loaded') {
    applyLayout(msg.layout);
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

    case 'AUTO_BROADCAST_DBG_PAUSED':
      handleV8Paused(payload);
      break;

    case 'AUTO_BROADCAST_DBG_RESUMED':
      handleV8Resumed();
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

    case 'AUTO_BROADCAST_ARTIFACT':
      handleArtifactBroadcast(payload);
      break;

    case 'AUTO_BROADCAST_RUN_COMPLETE':
      // Run archived — if in archive mode, refresh the grid
      if (_dashState.scriptHistoryMode === 'archive') {
        loadArchiveRuns();
      }
      // Auto-stop tracing/video if the completed script was on the traced/recorded session
      if (payload && payload.run) {
        autoStopSessionRecording(payload.run);
      }
      break;
  }
}

function handleScriptBroadcast(payload) {
  // Track selected script state — match by scriptId, by name, or by known script name
  var selectedName = _dashState.selectedScript ? _dashState.selectedScript.name : null;
  var matches = _dashState.selectedScriptId
    && (payload.scriptId === _dashState.selectedScriptId
        || (payload.name && payload.name === _dashState.selectedScriptId)
        || (payload.name && selectedName && payload.name === selectedName));
  if (matches) {
    // Lock onto the real bridge scriptId once known
    if (payload.scriptId && payload.scriptId !== _dashState.selectedScriptId) {
      _dashState.selectedScriptId = payload.scriptId;
    }
    _dashState.selectedScript = payload;

    // Update debug viewer
    var dv = resolveRef('debugViewer');
    if (dv) dv.setData([payload]);

    // Update assertions grid if assertions data available
    updateAssertionsGrid(payload.assertions);

    // Update checkpoint decorations if paused at checkpoint
    if (payload.state === 'checkpoint' && payload.checkpoint) {
      _currentCheckpoint = payload.checkpoint.name;
      updateEditorDecorations();
      scrollToCheckpoint(payload.checkpoint.name);
    } else if (payload.state !== 'checkpoint') {
      if (_currentCheckpoint) {
        _currentCheckpoint = null;
        updateEditorDecorations();
      }
    }
  }

  refreshToolbar();
}

function handleActionResponse(msg) {
  // Resolve pending async dispatches
  if (msg.id && _pendingDispatches[msg.id]) {
    _pendingDispatches[msg.id](msg.response);
    delete _pendingDispatches[msg.id];
  }

  // Handle connection response — update state
  if (msg.response && typeof msg.response.connected !== 'undefined') {
    _dashState.connected = msg.response.connected;
    updateConnectionUI();
    refreshToolbar();
  }
}

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
      connectBtn.click = function () {
        // Attempt connection, show setup guidance if it fails
        dispatchActionAsync('BRIDGE_CONNECT', { port: 9876 }, 5000).then(function (resp) {
          if (!resp || !resp.connected) {
            showBridgeSetupDialog();
          }
        }).catch(function () {
          showBridgeSetupDialog();
        });
      };
    }
  }
}
