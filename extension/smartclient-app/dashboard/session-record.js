// dashboard/session-record.js
// Trace and video recording toggles for sessions.
// Functions: toggleTracing, toggleVideo, autoStopSessionRecording

function toggleTracing() {
  var sessionId = getSelectedSessionId();
  if (!sessionId) {
    isc.warn('Select a session first.');
    return;
  }
  if (_tracingSessionId) {
    // Stop
    var stoppingSession = _tracingSessionId;
    _tracingSessionId = null;
    refreshToolbar();
    dispatchActionAsync('BRIDGE_SEND_COMMAND', { sessionId: stoppingSession, command: 'tracing-stop' }, 30000).then(function (resp) {
      console.log('[Dashboard] Tracing stopped:', resp);
      // Extract trace path from output
      var output = (resp && resp.output) || '';
      var match = output.match(/\[Trace\]\(([^)]+)\)/);
      if (match) {
        console.log('[Dashboard] Trace saved:', match[1]);
      }
    });
  } else {
    // Start
    dispatchActionAsync('BRIDGE_SEND_COMMAND', { sessionId: sessionId, command: 'tracing-start' }, 30000).then(function (resp) {
      if (resp && resp.success) {
        _tracingSessionId = sessionId;
        console.log('[Dashboard] Tracing started on', sessionId);
      } else {
        isc.warn('Tracing failed: ' + (resp && resp.error || 'Unknown error'));
      }
      refreshToolbar();
    });
  }
}

function toggleVideo() {
  var sessionId = getSelectedSessionId();
  if (!sessionId) {
    isc.warn('Select a session first.');
    return;
  }
  if (_videoSessionId) {
    // Stop
    var stoppingVideoSession = _videoSessionId;
    _videoSessionId = null;
    refreshToolbar();
    dispatchActionAsync('BRIDGE_SEND_COMMAND', { sessionId: stoppingVideoSession, command: 'video-stop' }, 30000).then(function (resp) {
      console.log('[Dashboard] Video stopped:', resp);
      var output = (resp && resp.output) || '';
      var match = output.match(/\[Video\]\(([^)]+)\)/);
      if (match) {
        console.log('[Dashboard] Video saved:', match[1]);
      }
    });
  } else {
    // Start
    dispatchActionAsync('BRIDGE_SEND_COMMAND', { sessionId: sessionId, command: 'video-start' }, 30000).then(function (resp) {
      if (resp && resp.success) {
        _videoSessionId = sessionId;
        console.log('[Dashboard] Video started on', sessionId);
      } else {
        isc.warn('Video failed: ' + (resp && resp.error || 'Unknown error'));
      }
      refreshToolbar();
    });
  }
}

function autoStopSessionRecording(run) {
  var runSessionId = run.sessionId;
  var scriptId = run.scriptId || run.id;

  // Auto-stop trace if this script's session was being traced
  if (_tracingSessionId && runSessionId && _tracingSessionId === runSessionId) {
    console.log('[Dashboard] Auto-stopping trace for completed script:', run.name);
    _tracingSessionId = null;
    refreshToolbar();
    // Fire-and-forget: the bridge server handles stopping trace + artifact registration
    // via the BRIDGE_SESSION_RECORDING_STOP handler (server-side, avoids MV3 port-close)
    dispatchActionAsync('BRIDGE_SEND_COMMAND', { sessionId: runSessionId, command: 'tracing-stop' }, 30000)
      .then(function (resp) {
        console.log('[Dashboard] Trace auto-stopped:', (resp && resp.output) || '');
      }).catch(function () {});
  }

  // Auto-stop video if this script's session was being recorded
  if (_videoSessionId && runSessionId && _videoSessionId === runSessionId) {
    console.log('[Dashboard] Auto-stopping video for completed script:', run.name);
    _videoSessionId = null;
    refreshToolbar();
    dispatchActionAsync('BRIDGE_SEND_COMMAND', { sessionId: runSessionId, command: 'video-stop' }, 30000)
      .then(function (resp) {
        console.log('[Dashboard] Video auto-stopped:', (resp && resp.output) || '');
      }).catch(function () {});
  }
}
