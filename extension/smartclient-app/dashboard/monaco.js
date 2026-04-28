// dashboard/monaco.js
// Monaco editor lifecycle, breakpoints, V8 debugger pane.
// Functions: loadMonacoEditor, initMonacoEditor, updateSourceViewer, openMonacoWindow, findCheckpointLines, handleGlyphClick, updateEditorDecorations, scrollToCheckpoint, handleV8Paused, handleV8Resumed, showEvaluatePanel, hideEvaluatePanel, runEvaluation

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
  // Monaco now lives in a standalone Window, not the portlet.
  // Wire the Edit button to open the Monaco Window.
  var editBtn = resolveRef('btnEditSource');
  if (editBtn) {
    editBtn.click = function () {
      if (_dashState.currentSource) {
        openMonacoWindow(_loadedScriptName, _dashState.currentSource);
      } else {
        isc.say('Select a script first.');
      }
    };
  }
}

function updateSourceViewer(source) {
  var viewer = resolveRef('sourceViewer');
  if (!viewer) return;

  // Basic JS syntax highlighting
  var highlighted = escapeHtmlDash(source)
    .replace(/(\/\/.*)/g, '<span style="color:#6a9955">$1</span>')
    .replace(/\b(import|from|export|const|let|var|function|async|await|return|if|else|for|try|catch|throw|new|class|extends)\b/g, '<span style="color:#569cd6">$1</span>');

  viewer.setContents(
    '<pre id="source-pre" style="padding:8px;margin:0;font-size:12px;line-height:1.5;'
    + 'font-family:Consolas,Monaco,monospace;background:#1e1e1e;color:#d4d4d4;'
    + 'white-space:pre-wrap;word-break:break-word;min-height:100%;cursor:pointer;" '
    + 'title="Double-click to open editor">'
    + highlighted + '</pre>'
  );
}

function openMonacoWindow(scriptName, source) {
  // If already open, just focus it
  if (_monacoEditorWindow && !_monacoEditorWindow.destroyed) {
    if (_monacoEditor) _monacoEditor.setValue(source || '');
    _monacoEditorWindow.show();
    _monacoEditorWindow.bringToFront();
    return;
  }

  // Create the Window with a Canvas host for Monaco
  var hostId = 'monaco-win-host-' + Date.now();
  _monacoEditorWindow = isc.Window.create({
    title: (scriptName || 'Source') + ' — Editor',
    width: Math.round(window.innerWidth * 0.7),
    height: Math.round(window.innerHeight * 0.75),
    autoCenter: true,
    canDragResize: true,
    dragAppearance: 'target',
    resizeFrom: ['L', 'R', 'T', 'B', 'TL', 'TR', 'BL', 'BR'],
    isModal: false,
    showMinimizeButton: true,
    showMaximizeButton: true,
    items: [
      isc.Canvas.create({
        ID: 'monacoWindowCanvas',
        width: '100%',
        height: '100%',
        redrawOnResize: false,
        overflow: 'hidden',
        contents: '<style>'
          + '.monaco-bp-active { background: url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'14\' height=\'14\'%3E%3Ccircle cx=\'7\' cy=\'7\' r=\'5\' fill=\'%23e05252\'/%3E%3C/svg%3E") center/12px no-repeat; }'
          + '.monaco-bp-inactive { background: url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'14\' height=\'14\'%3E%3Ccircle cx=\'7\' cy=\'7\' r=\'5\' fill=\'none\' stroke=\'%23555\' stroke-width=\'1.5\'/%3E%3C/svg%3E") center/12px no-repeat; }'
          + '.monaco-bp-current { background: url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'14\' height=\'14\'%3E%3Cpolygon points=\'2,3 12,7 2,11\' fill=\'%23f9ab00\'/%3E%3C/svg%3E") center/12px no-repeat; }'
          + '.monaco-line-current { background: rgba(249, 171, 0, 0.12) !important; }'
          + '</style>'
          + '<div id="' + hostId + '" style="width:100%;height:100%;"></div>',
      }),
    ],
    closeClick: function () {
      // Sync edits back to the source viewer and state
      if (_monacoEditor && _loadedScriptName) {
        _dashState.currentSource = _monacoEditor.getValue();
        updateSourceViewer(_dashState.currentSource);
      }
      this.hide();
      return false; // hide, don't destroy
    },
  });
  _monacoEditorWindow.show();

  // Create Monaco inside the Window after it's drawn
  setTimeout(function () {
    var host = document.getElementById(hostId);
    if (!host || typeof monaco === 'undefined') return;

    // Size from the Canvas
    var canvas = resolveRef('monacoWindowCanvas');
    if (canvas) {
      host.style.width = canvas.getWidth() + 'px';
      host.style.height = canvas.getHeight() + 'px';
      canvas.resized = function () {
        host.style.width = canvas.getWidth() + 'px';
        host.style.height = canvas.getHeight() + 'px';
        if (_monacoEditor) _monacoEditor.layout();
      };
    }

    _monacoEditor = monaco.editor.create(host, {
      value: source || '',
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
      automaticLayout: true, // Safe in a Window (no PortalLayout reparenting)
      contextmenu: false,
      overviewRulerLanes: 0,
    });

    // Decoration collections
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
        fileSave();
      }
    });
  }, 300);
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

function handleV8Paused(payload) {
  _dashState.v8Paused = true;
  _dashState.v8PausedLine = payload.line || null;
  _dashState.v8PausedCallFrames = payload.callFrames || [];
  // Capture pid and scriptId from broadcast (safety net if launch response was missed)
  if (payload.pid) _dashState.v8Pid = payload.pid;
  if (payload.scriptId && !_dashState.selectedScriptId) {
    _dashState.selectedScriptId = payload.scriptId;
  }

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
