// dashboard/toolbar.js
// Top toolbar buttons: Run, Session Run, Debug, Eval, capture toggle.
// Functions: getSelectedSessionId, showSessionRunMenu, launchSelectedScript, addCaptureToggle

function getSelectedSessionId() {
  var g = resolveRef('sessionsGrid');
  if (!g) return null;
  var rec = g.getSelectedRecord();
  return (rec && rec.id) ? rec.id : null;
}

function showSessionRunMenu(button, debug) {
  // Read sessions from the grid data (already fetched from bridge)
  var grid = resolveRef('sessionsGrid');
  if (!grid) return;
  var data = grid.getData();
  if (!data || !data.getLength) return;

  var ready = [];
  for (var i = 0; i < data.getLength(); i++) {
    var s = data.get(i);
    if (s && s.state === 'ready') {
      ready.push(s);
    }
  }
  if (ready.length === 0) {
    isc.warn('No ready sessions.<br>Create a session first, then use <b>Session</b> to run the script in it.');
    return;
  }
  var menuData = [];
  for (var j = 0; j < ready.length; j++) {
    (function (sess) {
      menuData.push({
        title: sess.name + (sess.currentUrl ? ' — ' + sess.currentUrl : ''),
        click: function () {
          launchSelectedScript(debug, sess.id);
        },
      });
    })(ready[j]);
  }
  var menu = isc.Menu.create({ data: menuData });
  menu.showNextTo(button, 'bottom');
}

function launchSelectedScript(debug, sessionId) {
  var script = _dashState.selectedScript;
  if (!script || !script.name) {
    console.warn('[Dashboard] Cannot launch — no script selected');
    return;
  }
  console.log('[Dashboard] launchSelectedScript: name=' + script.name + ' debug=' + debug + ' sessionId=' + (sessionId || 'none'));

  // Get originalPath from library
  dispatchActionAsync('SCRIPT_LIBRARY_GET', { name: script.name }).then(function (response) {
    if (!response || !response.success || !response.script) {
      console.warn('[Dashboard] Cannot launch — script not found in library:', script.name);
      isc.warn('Script not in library: <b>' + script.name + '</b><br>Try opening it via the Open button first.');
      return;
    }

    var path = response.script.originalPath || script.name;
    // If path is relative, strip to just the filename — the bridge will find it in the scripts dir
    if (path && !path.startsWith('/') && !path.match(/^[A-Z]:\\/)) {
      path = path.split(/[/\\]/).pop();
    }
    var payload = { path: path, args: '' };

    // Attach sessionId if explicitly provided (from Session Run menu)
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    if (debug) {
      payload.debug = true;
      // Map editor breakpoints to line numbers for V8
      var lineBreakpoints = [];
      for (var i = 0; i < _editorBreakpoints.length; i++) {
        var bp = _editorBreakpoints[i];
        if (typeof bp === 'number') {
          lineBreakpoints.push(bp);
        } else if (typeof bp === 'string' && _checkpointLines[bp]) {
          lineBreakpoints.push(_checkpointLines[bp]);
        }
      }
      payload.lineBreakpoints = lineBreakpoints;
    }

    // Capture artifacts toggle
    if (_dashState.captureArtifacts) {
      payload.captureArtifacts = true;
    }

    // Attach recipe pre/post actions — prefer DataSource recipe, fall back to in-memory
    function doLaunch(pre, post) {
      if (pre && pre.length > 0) payload.preActions = pre;
      if (post && post.length > 0) payload.postActions = post;
      console.log('[Dashboard] SCRIPT_LAUNCH payload:', JSON.stringify(payload));
      dispatchActionAsync('SCRIPT_LAUNCH', payload).then(function (resp) {
        console.log('[Dashboard] SCRIPT_LAUNCH response:', JSON.stringify(resp));
        if (resp && resp.success) {
          if (resp.launchId) {
            _dashState.selectedScriptId = resp.launchId;
            _dashState.selectedScript = Object.assign({}, _dashState.selectedScript, {
              id: resp.launchId, scriptId: resp.launchId,
            });
          }
          if (debug && resp.pid) {
            _dashState.v8Pid = resp.pid;
          }
        } else if (resp) {
          isc.warn('Launch failed: ' + (resp.error || 'Unknown error'));
        }
      }).catch(function (err) {
        console.error('[Dashboard] SCRIPT_LAUNCH error:', err.message);
        isc.warn('Launch error: ' + err.message);
      });
    }

    if (_dashState.recipeId) {
      dispatchActionAsync('DS_FETCH', { dataSource: 'Recipes', criteria: { id: _dashState.recipeId } }).then(function (r) {
        var data = (r && r.status === 0 && Array.isArray(r.data)) ? r.data : [];
        if (data.length > 0) {
          doLaunch(data[0].preActions || [], data[0].postActions || []);
        } else {
          doLaunch(_dashState.recipe.preActions, _dashState.recipe.postActions);
        }
      }).catch(function () {
        doLaunch(_dashState.recipe.preActions, _dashState.recipe.postActions);
      });
      return; // Early return — launch happens in callback
    }
    doLaunch(_dashState.recipe.preActions, _dashState.recipe.postActions);
  });
}

function addCaptureToggle() {
  var toolbar = resolveRef('dashToolbar');
  if (!toolbar) return;

  var toggle = isc.DynamicForm.create({
    width: 130,
    height: 28,
    numCols: 2,
    colWidths: [18, '*'],
    fields: [
      {
        name: 'captureArtifacts',
        title: 'Capture',
        editorType: 'CheckboxItem',
        showTitle: true,
        titleOrientation: 'right',
        textBoxStyle: 'labelAnchor',
        changed: function (form, item, value) {
          _dashState.captureArtifacts = !!value;
        },
      },
    ],
  });
  toolbar.addMember(toggle);
}
