/**
 * SC-4b/4c/4d: Dashboard app logic — renders the PortalLayout config,
 * manages state from bridge broadcasts, refreshes toolbar buttons,
 * embeds Monaco editor, handles V8 debugger, and persists layout.
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
  v8Pid: null,
  v8PausedLine: null,
  v8PausedCallFrames: [],
};

// ---- Monaco editor state ----
var _monacoEditor = null;
var _monacoDecorations = null;
var _v8Decorations = null;
var _checkpointLines = {};       // { name: lineNumber }
var _editorBreakpoints = [];     // active breakpoint names (strings) or line numbers
var _currentCheckpoint = null;   // name of checkpoint we're paused at
var _loadedScriptName = null;

// ---- Async dispatch tracking ----
var _pendingDispatches = {};

// ---- Layout persistence debounce ----
var _layoutSaveTimer = null;

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

  // Wire scripts grid recordClick for selection tracking + editor loading
  var scriptsGrid = resolveRef('scriptsGrid');
  if (scriptsGrid) {
    scriptsGrid.recordClick = function (viewer, record) {
      _dashState.selectedScriptId = record ? record.id : null;
      _dashState.selectedScript = record || null;

      var dv = resolveRef('debugViewer');
      if (dv && record) dv.setData([record]);
      else if (dv) dv.setData([]);

      // Load script source into Monaco editor
      if (record && record.name) {
        loadScriptIntoEditor(record.name);
      }

      refreshToolbar();
    };
  }

  // Wire custom Run button handler (needs originalPath from library)
  var tbRun = resolveRef('tbRun');
  if (tbRun) {
    tbRun.click = function () {
      launchSelectedScript(false);
    };
  }

  // Wire Debug button handler
  var tbDebug = resolveRef('tbDebug');
  if (tbDebug) {
    tbDebug.click = function () {
      launchSelectedScript(true);
    };
  }

  // Wire Evaluate Run button
  var evalRunBtn = resolveRef('evalRunBtn');
  if (evalRunBtn) {
    evalRunBtn.click = function () {
      runEvaluation();
    };
  }

  // Listen for broadcasts
  window.addEventListener('message', handleDashboardMessage);

  // Load Monaco editor — deferred to avoid blocking SmartClient init on extension reload
  setTimeout(function () {
    loadMonacoEditor().then(function () {
      initMonacoEditor();
      console.log('[Dashboard] Monaco editor ready');
    }).catch(function (err) {
      console.warn('[Dashboard] Monaco load failed (editor will be unavailable):', err.message);
    });
  }, 500);

  // Wire File menu
  var fileMenu = resolveRef('tbFileMenu');
  if (fileMenu && fileMenu.menu) {
    fileMenu.menu.itemClick = function (item) {
      if (item.title === 'Open Script...') showOpenScriptDialog();
    };
  }

  // Request initial connection status
  dispatchAction('BRIDGE_STATUS', {});

  // Request saved layout
  window.parent.postMessage({ source: 'smartclient-load-layout' }, '*');

  console.log('[Dashboard] Loaded SC-4 dashboard');
}

// ---- Monaco editor loading ----

function loadMonacoEditor() {
  return new Promise(function (resolve, reject) {
    // Load Monaco CSS
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '../dashboard/lib/monaco/vs/editor/editor.main.css';
    document.head.appendChild(link);

    // Stub MonacoEnvironment — no workers in sandbox (null origin blocks them)
    window.MonacoEnvironment = {
      getWorkerUrl: function () { return ''; },
    };

    // Restore native DataView that SmartClient clobbers in Simple Names mode
    // (Monaco uses DataView for binary buffer operations)
    if (window._nativeDataView) {
      window.DataView = window._nativeDataView;
    }

    // Save SmartClient's AMD globals before Monaco loader overwrites them
    var savedRequire = window.require;
    var savedDefine = window.define;

    // Load AMD loader
    var script = document.createElement('script');
    script.src = '../dashboard/lib/monaco/vs/loader.js';
    script.onload = function () {
      // Grab Monaco's require before restoring SmartClient's
      var monacoRequire = window.require;

      // Configure AMD paths
      monacoRequire.config({
        paths: { vs: '../dashboard/lib/monaco/vs' },
        config: { 'vs/css': { disabled: true } },
      });

      // Load Monaco editor module
      monacoRequire(['vs/editor/editor.main'], function () {
        // Restore SmartClient's globals now that Monaco is loaded
        if (savedRequire) window.require = savedRequire;
        if (savedDefine) window.define = savedDefine;
        resolve();
      }, function (err) {
        if (savedRequire) window.require = savedRequire;
        if (savedDefine) window.define = savedDefine;
        reject(err || new Error('Monaco require failed'));
      });
    };
    script.onerror = function () {
      if (savedRequire) window.require = savedRequire;
      if (savedDefine) window.define = savedDefine;
      reject(new Error('Failed to load Monaco loader.js'));
    };
    document.head.appendChild(script);
  });
}

function initMonacoEditor() {
  var host = document.getElementById('monaco-host');
  if (!host || typeof monaco === 'undefined') return;

  // Size the host div from the SmartClient Canvas dimensions
  var sourceCanvas = resolveRef('sourcePanel');
  if (sourceCanvas) {
    var w = sourceCanvas.getWidth();
    var h = sourceCanvas.getHeight();
    host.style.width = w + 'px';
    host.style.height = h + 'px';

    // Re-size when SmartClient resizes the Canvas
    sourceCanvas.resized = function () {
      var nw = sourceCanvas.getWidth();
      var nh = sourceCanvas.getHeight();
      host.style.width = nw + 'px';
      host.style.height = nh + 'px';
      if (_monacoEditor) _monacoEditor.layout();
    };
  }

  _monacoEditor = monaco.editor.create(host, {
    value: '// Select a script from the Scripts grid to view source',
    language: 'javascript',
    theme: 'vs-dark',
    readOnly: false,
    minimap: { enabled: false },
    lineNumbers: 'on',
    glyphMargin: true,
    folding: true,
    wordWrap: 'off',
    scrollBeyondLastLine: false,
    fontSize: 12,
    lineHeight: 18,
    renderLineHighlight: 'none',
    automaticLayout: true,
    contextmenu: false,
    overviewRulerLanes: 0,
  });

  // Create decoration collections
  _monacoDecorations = _monacoEditor.createDecorationsCollection([]);
  _v8Decorations = _monacoEditor.createDecorationsCollection([]);

  // Glyph margin click → breakpoint toggle
  _monacoEditor.onMouseDown(function (e) {
    if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
      var line = e.target.position ? e.target.position.lineNumber : null;
      if (!line) return;
      handleGlyphClick(line);
    }
  });

  // Ctrl+S → save
  _monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function () {
    if (_loadedScriptName && _monacoEditor) {
      dispatchAction('SCRIPT_LIBRARY_SAVE', {
        name: _loadedScriptName,
        source: _monacoEditor.getValue(),
      });
    }
  });
}

// ---- Script loading ----

function loadScriptIntoEditor(name) {
  if (!name) return;
  _loadedScriptName = name;

  dispatchActionAsync('SCRIPT_LIBRARY_GET', { name: name }).then(function (response) {
    if (!response || !response.success || !response.script) {
      console.warn('[Dashboard] Failed to load script:', name);
      return;
    }

    var source = response.script.source || '';
    if (_monacoEditor) {
      _monacoEditor.setValue(source);
    }

    // Detect checkpoint lines
    _checkpointLines = findCheckpointLines(source);

    // Merge server breakpoints if script is active
    var script = _dashState.selectedScript;
    if (script && script.activeBreakpoints) {
      var serverBp = script.activeBreakpoints;
      for (var i = 0; i < serverBp.length; i++) {
        if (_editorBreakpoints.indexOf(serverBp[i]) < 0) {
          _editorBreakpoints.push(serverBp[i]);
        }
      }
    }

    // Update current checkpoint if paused
    _currentCheckpoint = (script && script.checkpoint) ? script.checkpoint.name : null;

    updateEditorDecorations();
  });
}

function findCheckpointLines(source) {
  var map = {};
  var lines = source.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/client\.checkpoint\(['"]([^'"]+)['"]/);
    if (m) map[m[1]] = i + 1; // 1-indexed
  }
  return map;
}

// ---- Breakpoint management ----

function handleGlyphClick(line) {
  // Find checkpoint name at this line, or use raw line number
  var name = null;
  for (var cpName in _checkpointLines) {
    if (_checkpointLines[cpName] === line) {
      name = cpName;
      break;
    }
  }
  var bp = name || line;

  // Toggle in editorBreakpoints
  var idx = _editorBreakpoints.indexOf(bp);
  if (idx >= 0) {
    _editorBreakpoints.splice(idx, 1);
  } else {
    _editorBreakpoints.push(bp);
  }

  // If script is active, send breakpoint toggle to bridge
  var script = _dashState.selectedScript;
  if (script && script.id && typeof name === 'string') {
    var active = idx < 0; // was not in array → now active
    dispatchAction('SCRIPT_SET_BREAKPOINT', {
      scriptId: script.id,
      name: name,
      active: active,
    });
  }

  updateEditorDecorations();
}

function updateEditorDecorations() {
  if (!_monacoEditor || !_monacoDecorations) return;

  var decorations = [];
  var decoratedLines = {};

  for (var name in _checkpointLines) {
    var line = _checkpointLines[name];
    decoratedLines[line] = true;
    var isCurrent = name === _currentCheckpoint;
    var isActive = _editorBreakpoints.indexOf(name) >= 0;

    if (isCurrent) {
      decorations.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: 'monaco-bp-current',
          className: 'monaco-line-current',
          isWholeLine: true,
        },
      });
    } else if (isActive) {
      decorations.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: 'monaco-bp-active',
        },
      });
    } else {
      decorations.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: 'monaco-bp-inactive',
        },
      });
    }
  }

  // Raw line-level breakpoints (not at checkpoint lines)
  for (var i = 0; i < _editorBreakpoints.length; i++) {
    var bp = _editorBreakpoints[i];
    if (typeof bp === 'number' && !decoratedLines[bp]) {
      decorations.push({
        range: new monaco.Range(bp, 1, bp, 1),
        options: {
          glyphMarginClassName: 'monaco-bp-active',
        },
      });
    }
  }

  _monacoDecorations.set(decorations);
}

function scrollToCheckpoint(name) {
  if (!_monacoEditor || !_checkpointLines[name]) return;
  _monacoEditor.revealLineInCenter(_checkpointLines[name]);
}

// ---- V8 debugger state ----

function handleV8Paused(payload) {
  _dashState.v8Paused = true;
  _dashState.v8PausedLine = payload.line || null;
  _dashState.v8PausedCallFrames = payload.callFrames || [];

  // Highlight paused line in Monaco
  if (_v8Decorations && _dashState.v8PausedLine && _monacoEditor) {
    _v8Decorations.set([{
      range: new monaco.Range(_dashState.v8PausedLine, 1, _dashState.v8PausedLine, 1),
      options: {
        glyphMarginClassName: 'monaco-bp-current',
        className: 'monaco-line-current',
        isWholeLine: true,
      },
    }]);
    _monacoEditor.revealLineInCenter(_dashState.v8PausedLine);
  }

  showEvaluatePanel(_dashState.v8PausedCallFrames);
  refreshToolbar();
}

function handleV8Resumed() {
  _dashState.v8Paused = false;
  _dashState.v8PausedLine = null;
  _dashState.v8PausedCallFrames = [];

  // Clear V8 highlight
  if (_v8Decorations) _v8Decorations.set([]);

  hideEvaluatePanel();
  refreshToolbar();
}

// ---- Evaluate panel ----

function showEvaluatePanel(callFrames) {
  var portlet = resolveRef('evalPortlet');
  if (portlet && portlet.show) portlet.show();

  // Populate frame selector
  var form = resolveRef('evalForm');
  if (form && callFrames && callFrames.length > 0) {
    var valueMap = {};
    for (var i = 0; i < callFrames.length; i++) {
      var cf = callFrames[i];
      var label = (cf.functionName || '(anonymous)') + ':' + (cf.location ? cf.location.lineNumber : '?');
      valueMap[cf.callFrameId] = label;
    }
    var field = form.getField('callFrame');
    if (field) {
      field.setValueMap(valueMap);
      field.setValue(callFrames[0].callFrameId);
    }
  }
}

function hideEvaluatePanel() {
  var portlet = resolveRef('evalPortlet');
  if (portlet && portlet.hide) portlet.hide();

  // Clear result
  var result = resolveRef('evalResult');
  if (result) {
    result.setContents('<div style="padding:4px;color:#888;font-family:monospace;font-size:11px;">Result will appear here</div>');
  }
}

function runEvaluation() {
  var form = resolveRef('evalForm');
  if (!form) return;

  var expression = form.getValue('expression');
  var callFrameId = form.getValue('callFrame');
  if (!expression) return;

  var script = _dashState.selectedScript;
  var scriptId = script ? script.id : null;
  var pid = _dashState.v8Pid;

  dispatchActionAsync('DBG_EVALUATE', {
    expression: expression,
    callFrameId: callFrameId,
    scriptId: scriptId,
    pid: pid,
  }).then(function (response) {
    var result = resolveRef('evalResult');
    if (!result) return;

    if (response && response.success && response.result) {
      var val = response.result.value !== undefined
        ? String(response.result.value)
        : JSON.stringify(response.result, null, 2);
      result.setContents('<pre style="padding:4px;color:#4CAF50;font-family:monospace;font-size:11px;margin:0;white-space:pre-wrap;">'
        + escapeHtmlDash(val) + '</pre>');
    } else {
      var err = (response && response.error) ? response.error : 'Evaluation failed';
      result.setContents('<pre style="padding:4px;color:#f44336;font-family:monospace;font-size:11px;margin:0;white-space:pre-wrap;">'
        + escapeHtmlDash(err) + '</pre>');
    }
  });
}

function escapeHtmlDash(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- Script launch ----

function launchSelectedScript(debug) {
  var script = _dashState.selectedScript;
  if (!script || !script.name) return;

  // Get originalPath from library
  dispatchActionAsync('SCRIPT_LIBRARY_GET', { name: script.name }).then(function (response) {
    if (!response || !response.success || !response.script) {
      console.warn('[Dashboard] Cannot launch — script not found in library:', script.name);
      return;
    }

    var path = response.script.originalPath || script.name;
    var payload = { path: path, args: '' };

    // Attach sessionId from selected session if available
    var sessionsGrid = resolveRef('sessionsGrid');
    if (sessionsGrid) {
      var session = sessionsGrid.getSelectedRecord();
      if (session && session.id) {
        payload.sessionId = session.id;
      }
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

    dispatchActionAsync('SCRIPT_LAUNCH', payload).then(function (resp) {
      if (resp && resp.success && debug && resp.pid) {
        _dashState.v8Pid = resp.pid;
      }
    });
  });
}

// ---- Open Script dialog ----

function showOpenScriptDialog() {
  // Use local refs instead of global IDs to avoid collisions on re-open
  var pathForm = isc.DynamicForm.create({
    width: '100%',
    numCols: 3,
    colWidths: [90, '*', 70],
    fields: [
      {
        name: 'path',
        title: 'Script path',
        editorType: 'TextItem',
        width: '*',
        colSpan: 1,
        hint: '/home/user/scripts/my-script.mjs',
        showHintInField: true,
      },
      {
        name: '_browse',
        editorType: 'ButtonItem',
        title: 'Browse',
        width: 65,
        startRow: false,
        click: function () {
          statusLabel.setContents('<span style="color:#888;">Opening file dialog...</span>');
          dispatchActionAsync('FILE_PICKER', {
            title: 'Open Script',
            filter: 'JavaScript files (*.mjs;*.js)|*.mjs;*.js|All files (*.*)|*.*',
          }).then(function (result) {
            if (result && result.success && result.path) {
              pathForm.setValue('path', result.path);
              statusLabel.setContents('');
            } else if (result && result.cancelled) {
              statusLabel.setContents('');
            } else {
              statusLabel.setContents('<span style="color:#FF9800;">File browser not available — type path manually</span>');
            }
          }).catch(function () {
            statusLabel.setContents('<span style="color:#FF9800;">File browser not available — type path manually</span>');
          });
        },
      },
    ],
  });

  var statusLabel = isc.Label.create({
    width: '100%',
    height: 20,
    contents: '',
  });

  var dlg = isc.Dialog.create({
    title: 'Open Script',
    width: 520,
    height: 200,
    isModal: true,
    showModalMask: true,
    autoCenter: true,
    items: [pathForm, statusLabel],
    buttons: [
      isc.Button.create({
        title: 'Import',
        click: function () {
          var path = (pathForm.getValue('path') || '').trim();
          if (!path) {
            statusLabel.setContents('<span style="color:#f44336;">Please enter a file path</span>');
            return;
          }
          statusLabel.setContents('<span style="color:#888;">Importing...</span>');
          console.log('[Dashboard] SCRIPT_IMPORT:', path);

          dispatchActionAsync('SCRIPT_IMPORT', { path: path }).then(function (response) {
            console.log('[Dashboard] SCRIPT_IMPORT response:', JSON.stringify(response));
            if (response && response.success) {
              dlg.destroy();
              var grid = resolveRef('scriptsGrid');
              if (grid && grid.invalidateCache) grid.invalidateCache();
              var scriptName = (response.script && response.script.name) || response.name;
              if (scriptName) loadScriptIntoEditor(scriptName);
            } else {
              var err = (response && response.error) || 'Import failed';
              statusLabel.setContents('<span style="color:#f44336;">' + escapeHtmlDash(err) + '</span>');
            }
          }).catch(function (e) {
            console.error('[Dashboard] SCRIPT_IMPORT error:', e);
            statusLabel.setContents('<span style="color:#f44336;">Import error: ' + escapeHtmlDash(e.message || String(e)) + '</span>');
          });
        },
      }),
      isc.Button.create({
        title: 'Cancel',
        click: function () { dlg.destroy(); },
      }),
    ],
  });
  dlg.show();
}

// ---- Async dispatch ----

function dispatchActionAsync(messageType, payload) {
  var id = ++_actionCounter;
  return new Promise(function (resolve) {
    _pendingDispatches[id] = resolve;
    window.parent.postMessage({
      source: 'smartclient-action',
      id: id,
      messageType: messageType,
      payload: payload || {},
    }, '*');
  });
}

// ---- Layout persistence ----

function saveLayout() {
  var portal = resolveRef('dashPortal');
  if (!portal) return;

  // Read current column widths
  var widths = [];
  try {
    for (var i = 0; i < 3; i++) {
      var col = portal.getColumn(i);
      if (col) widths.push(col.getWidth() + 'px');
    }
  } catch (e) {
    // PortalLayout API may vary — fall back to config defaults
    return;
  }

  if (widths.length === 3) {
    window.parent.postMessage({
      source: 'smartclient-save-layout',
      layout: { columnWidths: widths },
    }, '*');
  }
}

function debouncedSaveLayout() {
  if (_layoutSaveTimer) clearTimeout(_layoutSaveTimer);
  _layoutSaveTimer = setTimeout(saveLayout, 1000);
}

function applyLayout(layout) {
  if (!layout || !layout.columnWidths) return;
  var portal = resolveRef('dashPortal');
  if (!portal) return;

  try {
    // Apply saved column widths
    var widths = layout.columnWidths;
    for (var i = 0; i < widths.length && i < 3; i++) {
      var col = portal.getColumn(i);
      if (col) col.setWidth(widths[i]);
    }
  } catch (e) {
    console.warn('[Dashboard] Failed to apply saved layout:', e.message);
  }
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
  }
}

function handleScriptBroadcast(payload) {
  // Track selected script state
  if (_dashState.selectedScriptId && payload.scriptId === _dashState.selectedScriptId) {
    _dashState.selectedScript = payload;

    // Update debug viewer
    var dv = resolveRef('debugViewer');
    if (dv) dv.setData([payload]);

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

  // Debug: same conditions as Run
  setButtonDisabled('tbDebug', !hasSelected || !connected || isActive);

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

    // Wire V8 step buttons with scriptId and pid
    wireV8StepButton('tbStepInto', 'DBG_STEP_INTO', script.id);
    wireV8StepButton('tbStepOut', 'DBG_STEP_OUT', script.id);
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

function wireV8StepButton(id, messageType, scriptId) {
  var btn = resolveRef(id);
  if (btn) {
    btn.click = function () {
      dispatchAction(messageType, { scriptId: scriptId, pid: _dashState.v8Pid });
    };
  }
}
