// dashboard/auth-capture.js
// Auth capture flow (login -> save credentials for replay).
// Functions: startAuthCapture, showAuthCaptureDialog, saveAuthCapture, cancelAuthCapture

function startAuthCapture(scriptName, url) {
  _authCaptureScriptName = scriptName;
  dispatchActionAsync('AUTH_CAPTURE_START', { scriptName: scriptName, url: url })
    .then(function (response) {
      if (response && (response.success || response.sessionId)) {
        _authCaptureSessionId = response.sessionId;
        refreshToolbar();
        showAuthCaptureDialog(scriptName, url);
      } else {
        _authCaptureScriptName = null;
        isc.warn('Auth capture failed: ' + (response && response.error || 'Unknown error'));
      }
    });
}

function showAuthCaptureDialog(scriptName, url) {
  isc.Window.create({
    ID: 'authCaptureWindow',
    title: 'Auth Capture - ' + scriptName,
    width: 420, height: 130,
    isModal: true, showModalMask: true,
    canDragReposition: true, autoCenter: true,
    items: [
      isc.Label.create({ contents: 'Log in at <b>' + url + '</b>, then click Save.', padding: 10 }),
      isc.HLayout.create({ height: 40, membersMargin: 8, align: 'right', layoutRightMargin: 10, members: [
        isc.Button.create({ title: 'Save & Close', click: function () { saveAuthCapture(); } }),
        isc.Button.create({ title: 'Cancel', click: function () { cancelAuthCapture(); } }),
      ]}),
    ],
  });
}

function saveAuthCapture() {
  if (!_authCaptureSessionId || !_authCaptureScriptName) return;
  dispatchActionAsync('AUTH_CAPTURE_SAVE', {
    sessionId: _authCaptureSessionId,
    scriptName: _authCaptureScriptName,
  }).then(function () {
    if (typeof authCaptureWindow !== 'undefined' && authCaptureWindow) authCaptureWindow.destroy();
    _authCaptureSessionId = null;
    _authCaptureScriptName = null;
    refreshToolbar();
  });
}

function cancelAuthCapture() {
  if (_authCaptureSessionId) {
    dispatchAction('BRIDGE_DESTROY_SESSION', { sessionId: _authCaptureSessionId });
  }
  if (typeof authCaptureWindow !== 'undefined' && authCaptureWindow) authCaptureWindow.destroy();
  _authCaptureSessionId = null;
  _authCaptureScriptName = null;
  refreshToolbar();
}
