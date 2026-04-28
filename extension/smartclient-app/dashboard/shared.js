// dashboard/shared.js
// Cross-portlet helpers: dispatch, formatting, toolbar refresh.
// Functions: escapeHtmlDash, formatDuration, parseIntervalInput, dispatchActionAsync, refreshToolbar, setButtonDisabled

var DISPATCH_TIMEOUT_MS = 15000; // 15s default timeout for action dispatches

function escapeHtmlDash(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return Math.round(ms / 1000) + 's';
  if (ms < 3600000) return Math.round(ms / 60000) + 'm';
  var h = Math.floor(ms / 3600000);
  var m = Math.round((ms % 3600000) / 60000);
  return h + 'h ' + m + 'm';
}

function parseIntervalInput(val) {
  var str = String(val).trim().toLowerCase();
  var match = str.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!match) return 0;
  var num = parseFloat(match[1]);
  var unit = match[2] || 's';
  if (unit === 'ms') return Math.round(num);
  if (unit === 's') return Math.round(num * 1000);
  if (unit === 'm') return Math.round(num * 60000);
  if (unit === 'h') return Math.round(num * 3600000);
  return 0;
}

function dispatchActionAsync(messageType, payload, timeoutMs) {
  var id = ++_actionCounter;
  var timeout = timeoutMs || DISPATCH_TIMEOUT_MS;
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      delete _pendingDispatches[id];
      reject(new Error('Timeout: ' + messageType + ' (' + timeout + 'ms)'));
    }, timeout);
    _pendingDispatches[id] = function (response) {
      clearTimeout(timer);
      resolve(response);
    };
    window.parent.postMessage({
      source: 'smartclient-action',
      id: id,
      messageType: messageType,
      payload: payload || {},
    }, '*');
  });
}

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

  // New Session / New Schedule: enabled when connected
  setButtonDisabled('btnNewSession', !connected);
  setButtonDisabled('btnNewSchedule', !connected);
  setButtonDisabled('btnEditSchedule', !connected);

  // Run: enabled when selected, connected, NOT active
  setButtonDisabled('tbRun', !hasSelected || !connected || isActive);
  setButtonDisabled('tbSessionRun', !hasSelected || !connected || isActive);

  // Debug: same conditions as Run
  setButtonDisabled('tbDebug', !hasSelected || !connected || isActive);

  // Trace & Video: enabled when connected (toggle state shown in title)
  var hasSession = !!getSelectedSessionId();
  setButtonDisabled('tbTrace', !connected || (!hasSession && !_tracingSessionId));
  setButtonDisabled('tbVideo', !connected || (!hasSession && !_videoSessionId));
  var traceBtn = resolveRef('tbTrace');
  if (traceBtn) traceBtn.setTitle(_tracingSessionId ? 'Trace \u25cf' : 'Trace');
  var videoBtn = resolveRef('tbVideo');
  if (videoBtn) videoBtn.setTitle(_videoSessionId ? 'Video \u25cf' : 'Video');

  // Pause / Resume
  setButtonDisabled('tbPause', !isRunning);
  setButtonDisabled('tbResume', !isPaused);

  // Stop
  setButtonDisabled('tbStop', !isActive);

  // Step / Continue: enabled at checkpoint OR v8Paused
  setButtonDisabled('tbStep', !isCheckpoint && !v8Paused);
  setButtonDisabled('tbContinue', !isCheckpoint && !v8Paused);

  // V8 Step Into / Step Out: only when v8Paused
  setButtonDisabled('tbStepInto', !v8Paused);
  setButtonDisabled('tbStepOut', !v8Paused);

  // Kill
  setButtonDisabled('tbKill', !isActive);

  // Auth: enabled when script loaded, connected, not running, not already capturing
  setButtonDisabled('tbAuth', !_loadedScriptName || !connected || isActive || !!_authCaptureSessionId);

  // Update Auth button title based on saved auth state
  if (_loadedScriptName && connected) {
    dispatchActionAsync('AUTH_CHECK', { scriptName: _loadedScriptName }).then(function (r) {
      var btn = resolveRef('tbAuth');
      if (btn && btn.setTitle) btn.setTitle(r && r.exists ? 'Auth \u2713' : 'Auth');
    });
  }

  // Debug panel buttons
  setButtonDisabled('dbgStep', !isCheckpoint && !v8Paused);
  setButtonDisabled('dbgContinue', !isCheckpoint && !v8Paused);
  setButtonDisabled('dbgKill', !isActive);

}

function setButtonDisabled(id, disabled) {
  var btn = resolveRef(id);
  if (btn && btn.setDisabled) {
    btn.setDisabled(disabled);
  }
}
