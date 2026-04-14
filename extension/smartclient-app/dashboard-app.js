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
  recipe: { preActions: [], postActions: [] },
  recipeId: null,
  selectedLibScript: null,
  scriptHistoryMode: 'live',       // 'live' | 'archive'
  selectedRunArtifacts: [],        // artifacts for selected archived run
  captureArtifacts: false,         // launch dialog toggle
};

// ---- Monaco editor state ----
var _monacoEditor = null;
var _monacoDecorations = null;
var _v8Decorations = null;
var _checkpointLines = {};       // { name: lineNumber }
var _editorBreakpoints = [];     // active breakpoint names (strings) or line numbers
var _currentCheckpoint = null;   // name of checkpoint we're paused at
var _loadedScriptName = null;

// ---- Auth capture state ----
var _authCaptureSessionId = null;
var _authCaptureScriptName = null;

// ---- Async dispatch tracking ----
var _pendingDispatches = {};

// ---- Helpers ----

// Coerce recipeId to integer or null — guards against string "undefined"/"null"
// from stale storage or SmartClient SelectItem string coercion.
function toRecipeId(val) {
  if (val == null || val === '' || val === 'undefined' || val === 'null') return null;
  var n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

// Extract first page.goto('...') URL from script source
function findFirstGotoUrl(source) {
  var m = source.match(/page\.goto\(\s*['"]([^'"]+)['"]\s*[,)]/);
  return m ? m[1] : null;
}

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
      if (_dashState.scriptHistoryMode === 'archive') {
        // Archive mode: load run detail + artifacts
        handleArchiveRunSelect(record);
        return;
      }
      // Live mode: existing behavior
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

  // Wire Sync (IDB export) button.
  // Routes through the Host Capability Interface (Phase 0 proof-of-concept).
  // Previously: dispatchActionAsync('IDB_EXPORT', {}, 30000)
  // Now: host.storage.export({ timeoutMs: 30000 })
  // The underlying postMessage → wrapper → service worker → sync-handlers
  // path is unchanged; only the caller-facing API is abstracted.
  var tbSync = resolveRef('tbSync');
  if (tbSync) {
    tbSync.click = function () {
      var btn = this;
      btn.setTitle('Syncing…');
      btn.setDisabled(true);
      var host = window.Host && window.Host.get && window.Host.get();
      if (!host || !host.storage || !host.storage.export) {
        btn.setTitle('Sync ✗');
        setTimeout(function () { btn.setTitle('Sync'); btn.setDisabled(false); }, 2500);
        console.error('[Dashboard] Host capability interface not loaded');
        return;
      }
      host.storage.export({ timeoutMs: 30000 })
        .then(function (result) {
          var label = result && result.success ? 'Sync ✓' : 'Sync ✗';
          btn.setTitle(label);
          setTimeout(function () { btn.setTitle('Sync'); btn.setDisabled(false); }, 2500);
          console.log('[Dashboard] IDB sync result (via host):', result);
        })
        .catch(function (err) {
          btn.setTitle('Sync ✗');
          setTimeout(function () { btn.setTitle('Sync'); btn.setDisabled(false); }, 2500);
          console.warn('[Dashboard] IDB sync failed (via host):', err.message);
        });
    };
  }

  // Wire Auth button
  var tbAuth = resolveRef('tbAuth');
  if (tbAuth) {
    tbAuth.click = function () {
      if (!_loadedScriptName || !_dashState.connected) return;
      var source = _monacoEditor ? _monacoEditor.getValue() : '';
      var url = findFirstGotoUrl(source);
      if (url) {
        startAuthCapture(_loadedScriptName, url);
      } else {
        isc.askForValue('Login URL for ' + _loadedScriptName, function (url) {
          if (url) startAuthCapture(_loadedScriptName, url);
        }, { defaultValue: '', width: 400 });
      }
    };
  }

  // Wire Test Results buttons
  var btnRunTests = resolveRef('btnRunTests');
  if (btnRunTests) {
    btnRunTests.click = function () {
      var testStatusLabel = resolveRef('testStatusLabel');
      if (testStatusLabel) testStatusLabel.setContents('<span style="color:#888;">Launching tests...</span>');
      // Get the repo root from bridge info, then launch the test
      dispatchActionAsync('BRIDGE_GET_INFO', {}).then(function (info) {
        var base = (info && info.shimPath) ? info.shimPath.replace(/packages\/bridge\/playwright-shim\.mjs$/, '') : '';
        dispatchAction('SCRIPT_LAUNCH', { path: base + 'examples/test-internal-ops.mjs' });
        setTimeout(loadTestResults, 20000);
      });
    };
  }
  var btnRefreshTests = resolveRef('btnRefreshTests');
  if (btnRefreshTests) {
    btnRefreshTests.click = function () { loadTestResults(); };
  }
  // Load test results on dashboard open
  setTimeout(loadTestResults, 2000);

  // Wire New Session button
  var btnNewSession = resolveRef('btnNewSession');
  if (btnNewSession) {
    btnNewSession.click = function () {
      showNewSessionDialog();
    };
  }

  // Wire New Schedule button
  var btnNewSchedule = resolveRef('btnNewSchedule');
  if (btnNewSchedule) {
    btnNewSchedule.click = function () {
      showNewScheduleDialog();
    };
  }

  // Wire Edit Schedule button
  var btnEditSchedule = resolveRef('btnEditSchedule');
  if (btnEditSchedule) {
    btnEditSchedule.click = function () {
      var grid = resolveRef('schedulesGrid');
      var record = grid && grid.getSelectedRecord();
      if (!record || !record.id) return;
      showEditScheduleDialog(record);
    };
  }

  // Wire Recipe buttons
  var btnAddPre = resolveRef('btnAddPre');
  if (btnAddPre) {
    btnAddPre.click = function () { showAddActionMenu('preActions'); };
  }
  var btnAddPost = resolveRef('btnAddPost');
  if (btnAddPost) {
    btnAddPost.click = function () { showAddActionMenu('postActions'); };
  }
  var btnSaveRecipe = resolveRef('btnSaveRecipe');
  if (btnSaveRecipe) {
    btnSaveRecipe.click = function () { saveRecipe(); };
  }

  // Wire recipe grids: remove icon click + drag reorder
  wireRecipeGrid('preActionsGrid', 'preActions');
  wireRecipeGrid('postActionsGrid', 'postActions');

  // Wire schedules grid: master-detail selection, formatting, and inline edit save
  var schedulesGrid = resolveRef('schedulesGrid');
  if (schedulesGrid) {
    schedulesGrid.recordClick = function (viewer, record) {
      var runsGrid = resolveRef('scheduleRunsGrid');
      if (!record || !record.id) {
        if (runsGrid) runsGrid.setData([]);
        return;
      }
      dispatchActionAsync('SCHEDULE_HISTORY', { scheduleId: record.id }).then(function (resp) {
        if (runsGrid && resp && resp.history) {
          runsGrid.setData(resp.history.slice().reverse());
        }
      });
    };
    schedulesGrid.formatCellValue = function (value, record, rowNum, colNum) {
      var fieldName = this.getFieldName(colNum);
      if (fieldName === 'cronExpr') {
        if (record && record.cronExpr) return record.cronExpr;
        if (record && typeof record.intervalMs === 'number') return formatDuration(record.intervalMs);
        return '';
      }
      if (fieldName === 'nextRunAt' && typeof value === 'number') {
        var diff = Math.max(0, Math.round((value - Date.now()) / 1000));
        if (diff >= 86400) return Math.round(diff / 86400) + 'd';
        if (diff >= 3600) return Math.floor(diff / 3600) + 'h ' + Math.round((diff % 3600) / 60) + 'm';
        if (diff >= 60) return Math.round(diff / 60) + 'm';
        return 'in ' + diff + 's';
      }
      return value;
    };

    // Persist inline edits to the bridge (name, scriptName, enabled only — schedule timing via Edit dialog)
    schedulesGrid.editComplete = function (rowNum, colNum, newValues, oldValues, editCompletionEvent) {
      var record = this.getRecord(rowNum);
      if (!record || !record.id) return;
      var updates = {};
      var changed = false;
      if (newValues.name !== undefined && newValues.name !== oldValues.name) {
        updates.name = newValues.name;
        changed = true;
      }
      if (newValues.scriptName !== undefined && newValues.scriptName !== oldValues.scriptName) {
        updates.scriptName = newValues.scriptName;
        changed = true;
      }
      if (newValues.enabled !== undefined && newValues.enabled !== oldValues.enabled) {
        updates.enabled = !!newValues.enabled;
        changed = true;
      }
      if (changed) {
        dispatchActionAsync('SCHEDULE_UPDATE', { scheduleId: record.id, ...updates }).then(function (resp) {
          if (!resp || !resp.success) {
            console.warn('[Dashboard] Schedule update failed:', resp && resp.error);
          }
        });
      }
    };
  }

  // Wire runs grid formatCellValue
  var scheduleRunsGrid = resolveRef('scheduleRunsGrid');
  if (scheduleRunsGrid) {
    scheduleRunsGrid.formatCellValue = function (value, record, rowNum, colNum) {
      var fieldName = this.getFieldName(colNum);
      if (fieldName === 'startedAt' && typeof value === 'number') {
        return new Date(value).toLocaleTimeString();
      }
      if (fieldName === 'durationMs' && typeof value === 'number') {
        return formatDuration(value);
      }
      return value == null ? '' : value;
    };
  }

  // Wire File menu
  var fileMenu = resolveRef('tbFileMenu');
  if (fileMenu && fileMenu.menu) {
    fileMenu.menu.itemClick = function (item) {
      if (item.title === 'Open Script...') showOpenScriptDialog();
      else if (item.title === 'Save') fileSave();
      else if (item.title === 'Save As...') fileSaveAs();
    };
  }

  // Wire scripts library grid
  wireScriptsLibraryGrid();

  // Wire recipe assign button
  var btnAssignRecipe = resolveRef('btnAssignRecipe');
  if (btnAssignRecipe) {
    btnAssignRecipe.click = function () { assignRecipeToScript(); };
  }

  // Wire Live/Archive toggle for Script History
  wireScriptHistoryToggle();

  // Wire artifacts grid
  wireArtifactsGrid();

  // Add capture artifacts toggle to toolbar
  setTimeout(addCaptureToggle, 100);

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
      fileSave();
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

    // Load recipe — prefer DataSource recipe by recipeId, fall back to embedded
    var scriptRecipeId = toRecipeId(response.script.recipeId);
    if (scriptRecipeId) {
      _dashState.recipeId = scriptRecipeId;
      dispatchActionAsync('DS_FETCH', { dataSource: 'Recipes', criteria: { id: scriptRecipeId } }).then(function (r) {
        var data = (r && r.status === 0 && Array.isArray(r.data)) ? r.data : [];
        if (data.length > 0) {
          _dashState.recipe = {
            preActions: data[0].preActions || [],
            postActions: data[0].postActions || [],
          };
        }
        renderRecipeGrids();
      });
    } else {
      _dashState.recipeId = null;
      var recipe = response.script.recipe;
      if (recipe && (recipe.preActions || recipe.postActions)) {
        _dashState.recipe = {
          preActions: recipe.preActions || [],
          postActions: recipe.postActions || [],
        };
      } else {
        _dashState.recipe = { preActions: [], postActions: [] };
      }
      renderRecipeGrids();
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

    // Capture artifacts toggle
    if (_dashState.captureArtifacts) {
      payload.captureArtifacts = true;
    }

    // Attach recipe pre/post actions — prefer DataSource recipe, fall back to in-memory
    function doLaunch(pre, post) {
      if (pre && pre.length > 0) payload.preActions = pre;
      if (post && post.length > 0) payload.postActions = post;
      dispatchActionAsync('SCRIPT_LAUNCH', payload).then(function (resp) {
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
        }
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
          var browseBtn = this;
          browseBtn.setDisabled && browseBtn.setDisabled(true);
          statusLabel.setContents('<span style="color:#888;">Opening file dialog... (if you do not see it, check behind the browser window)</span>');
          dispatchActionAsync('FILE_PICKER', {
            title: 'Open Script',
            filter: 'JavaScript files (*.mjs;*.js)|*.mjs;*.js|All files (*.*)|*.*',
          }).then(function (result) {
            if (dlg.destroyed) return;
            browseBtn.setDisabled && browseBtn.setDisabled(false);
            if (result && result.success && result.path) {
              pathForm.setValue('path', result.path);
              statusLabel.setContents('');
            } else if (result && result.cancelled) {
              statusLabel.setContents('');
            } else {
              statusLabel.setContents('<span style="color:#FF9800;">File browser not available — type path manually</span>');
            }
          }).catch(function (err) {
            if (dlg.destroyed) return;
            browseBtn.setDisabled && browseBtn.setDisabled(false);
            statusLabel.setContents('<span style="color:#FF9800;">File browser failed: ' + escapeHtmlDash(err && err.message || String(err)) + ' — type path manually</span>');
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
    closeClick: function () { this.destroy(); },
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
              refreshScriptsLibrary();
              var scriptName = (response.script && response.script.name) || response.name;
              if (scriptName) {
                // Select the imported script so Run/Debug buttons enable
                _dashState.selectedScriptId = scriptName;
                _dashState.selectedScript = { id: scriptName, name: scriptName };
                _dashState.selectedLibScript = scriptName;
                loadScriptIntoEditor(scriptName);
                loadVersionHistory(scriptName);
                refreshToolbar();
              }
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

// ---- New Session dialog ----

function showNewSessionDialog() {
  var sessionsGrid = resolveRef('sessionsGrid');
  var currentCount = sessionsGrid ? sessionsGrid.getTotalRows() : 0;
  var defaultName = 'session_' + (currentCount + 1);

  var nameForm = isc.DynamicForm.create({
    width: '100%',
    numCols: 2,
    colWidths: [100, '*'],
    fields: [
      {
        name: 'sessionName',
        title: 'Session name',
        editorType: 'TextItem',
        width: '*',
        defaultValue: defaultName,
        selectOnFocus: true,
      },
    ],
  });

  var statusLabel = isc.Label.create({
    width: '100%',
    height: 20,
    contents: '',
  });

  var okBtn = isc.Button.create({
    title: 'OK',
    click: function () {
      var name = (nameForm.getValue('sessionName') || '').trim();
      if (!name) {
        statusLabel.setContents('<span style="color:#f44336;">Please enter a session name</span>');
        return;
      }

      okBtn.setDisabled(true);
      cancelBtn.setDisabled(true);
      nameForm.setDisabled(true);
      statusLabel.setContents(
        '<span style="color:#888;">' +
        '<span style="display:inline-block;width:12px;height:12px;border:2px solid #555;' +
        'border-top-color:#aaa;border-radius:50%;animation:spin .8s linear infinite;' +
        'vertical-align:middle;margin-right:6px;"></span>' +
        'Creating session\u2026</span>'
      );

      dispatchActionAsync('SESSION_CREATE', { name: name, options: {} }).then(function (resp) {
        if (resp && resp.success) {
          dlg.destroy();
          if (sessionsGrid && sessionsGrid.invalidateCache) sessionsGrid.invalidateCache();
        } else {
          okBtn.setDisabled(false);
          cancelBtn.setDisabled(false);
          nameForm.setDisabled(false);
          var err = (resp && resp.error) || 'Failed to create session';
          statusLabel.setContents('<span style="color:#f44336;">' + escapeHtmlDash(err) + '</span>');
        }
      }).catch(function (e) {
        okBtn.setDisabled(false);
        cancelBtn.setDisabled(false);
        nameForm.setDisabled(false);
        statusLabel.setContents('<span style="color:#f44336;">Error: ' + escapeHtmlDash(e.message || String(e)) + '</span>');
      });
    },
  });

  var cancelBtn = isc.Button.create({
    title: 'Cancel',
    click: function () { dlg.destroy(); },
  });

  var dlg = isc.Dialog.create({
    title: 'New Session',
    width: 360,
    height: 160,
    isModal: true,
    showModalMask: true,
    autoCenter: true,
    closeClick: function () { this.destroy(); },
    items: [nameForm, statusLabel],
    buttons: [okBtn, cancelBtn],
  });
  dlg.show();
  nameForm.focusInItem('sessionName');
}

// ---- New Schedule dialog ----

function buildScheduleFormFields(scriptOptions) {
  return [
    {
      name: 'name',
      title: 'Name',
      editorType: 'TextItem',
      width: '*',
      colSpan: 3,
      hint: 'my-poller',
      showHintInField: true,
    },
    {
      name: 'scriptName',
      title: 'Script',
      editorType: 'SelectItem',
      width: '*',
      colSpan: 3,
      valueMap: scriptOptions,
      defaultValue: '',
    },
    {
      name: 'scheduleMode',
      title: 'Mode',
      editorType: 'RadioGroupItem',
      colSpan: 3,
      valueMap: { 'interval': 'Interval', 'cron': 'Cron' },
      defaultValue: 'interval',
      vertical: false,
      changed: function (form, item, value) {
        form.getField('interval').setDisabled(value !== 'interval');
        form.getField('unit').setDisabled(value !== 'interval');
        form.getField('cronExpr').setDisabled(value !== 'cron');
      },
    },
    {
      name: 'interval',
      title: 'Every',
      editorType: 'SpinnerItem',
      width: 60,
      colSpan: 1,
      defaultValue: 30,
      min: 1,
    },
    {
      name: 'unit',
      title: '',
      editorType: 'SelectItem',
      width: 60,
      colSpan: 1,
      startRow: false,
      showTitle: false,
      valueMap: { '1000': 'sec', '60000': 'min', '3600000': 'hr' },
      defaultValue: '60000',
    },
    {
      name: 'cronExpr',
      title: 'Cron',
      editorType: 'TextItem',
      width: '*',
      colSpan: 3,
      hint: '0 4 * * *',
      showHintInField: true,
      disabled: true,
    },
    {
      name: 'args',
      title: 'Args',
      editorType: 'TextItem',
      width: '*',
      colSpan: 3,
      hint: '--flag=value',
      showHintInField: true,
    },
    {
      name: 'runNow',
      title: 'Run now',
      editorType: 'CheckboxItem',
      colSpan: 3,
      defaultValue: false,
    },
  ];
}

function populateScriptDropdown(form, statusLabel) {
  var scriptOptions = { '': '-- select script --' };
  var seen = {};
  dispatchActionAsync('SCRIPT_LIBRARY_LIST', {}).then(function (libResp) {
    if (libResp && libResp.success) {
      for (var i = 0; i < (libResp.scripts || []).length; i++) {
        var s = libResp.scripts[i];
        if (!seen[s.name]) {
          seen[s.name] = true;
          scriptOptions[s.name] = s.name;
        }
      }
    }
    return dispatchActionAsync('SCRIPT_LIST', {});
  }).then(function (scriptResp) {
    if (scriptResp && scriptResp.success) {
      for (var j = 0; j < (scriptResp.scripts || []).length; j++) {
        var s = scriptResp.scripts[j];
        var sName = (s.name || '').replace(/\.(mjs|js)$/, '');
        if (sName && !seen[sName]) {
          seen[sName] = true;
          scriptOptions[sName] = sName;
        }
      }
    }
    form.getField('scriptName').setValueMap(scriptOptions);
    if (statusLabel) statusLabel.setContents('');
  }).catch(function () {
    if (statusLabel) statusLabel.setContents('<span style="color:#FF9800;">Could not load scripts — type name manually</span>');
  });
  return scriptOptions;
}

function showNewScheduleDialog() {
  var statusLabel = isc.Label.create({
    width: '100%',
    height: 20,
    contents: '<span style="color:#888;">Loading scripts...</span>',
  });

  var scriptOptions = { '': '-- select script --' };

  var schedForm = isc.DynamicForm.create({
    width: '100%',
    numCols: 4,
    colWidths: [80, '*', 60, 60],
    fields: buildScheduleFormFields(scriptOptions),
  });

  var okBtn = isc.Button.create({
    title: 'Create',
    click: function () {
      var vals = schedForm.getValues();
      if (!vals.scriptName) {
        statusLabel.setContents('<span style="color:#f44336;">Please select a script</span>');
        return;
      }
      var isCron = vals.scheduleMode === 'cron';
      if (isCron && !(vals.cronExpr || '').trim()) {
        statusLabel.setContents('<span style="color:#f44336;">Please enter a cron expression</span>');
        return;
      }
      var intervalMs = isCron ? null : (vals.interval || 30) * parseInt(vals.unit || '60000', 10);
      var cronExpr = isCron ? (vals.cronExpr || '').trim() : null;
      var scheduleName = (vals.name || '').trim() || vals.scriptName;

      okBtn.setDisabled(true);
      cancelBtn.setDisabled(true);
      schedForm.setDisabled(true);
      statusLabel.setContents(
        '<span style="color:#888;">' +
        '<span style="display:inline-block;width:12px;height:12px;border:2px solid #555;' +
        'border-top-color:#aaa;border-radius:50%;animation:spin .8s linear infinite;' +
        'vertical-align:middle;margin-right:6px;"></span>' +
        'Creating schedule\u2026</span>'
      );

      dispatchActionAsync('BRIDGE_GET_INFO', {}).then(function (info) {
        var scriptsDir = (info && info.scriptsDir) || '';
        var scriptPath = scriptsDir + '/' + vals.scriptName + '.mjs';

        return dispatchActionAsync('SCRIPT_LIBRARY_GET', { name: vals.scriptName }).then(function (libResp) {
          var originalPath = (libResp && libResp.success) ? (libResp.script && libResp.script.originalPath) : null;
          var argsArr = vals.args ? vals.args.trim().split(/\s+/) : [];

          var payload = {
            name: scheduleName,
            scriptPath: scriptPath,
            scriptName: vals.scriptName,
            args: argsArr,
            runNow: !!vals.runNow,
            originalPath: originalPath,
          };
          if (isCron) { payload.cronExpr = cronExpr; } else { payload.intervalMs = intervalMs; }

          return dispatchActionAsync('SCHEDULE_CREATE', payload);
        });
      }).then(function (resp) {
        if (resp && resp.success) {
          dlg.destroy();
          var grid = resolveRef('schedulesGrid');
          if (grid && grid.invalidateCache) grid.invalidateCache();
        } else {
          okBtn.setDisabled(false);
          cancelBtn.setDisabled(false);
          schedForm.setDisabled(false);
          var err = (resp && resp.error) || 'Failed to create schedule';
          statusLabel.setContents('<span style="color:#f44336;">' + escapeHtmlDash(err) + '</span>');
        }
      }).catch(function (e) {
        okBtn.setDisabled(false);
        cancelBtn.setDisabled(false);
        schedForm.setDisabled(false);
        statusLabel.setContents('<span style="color:#f44336;">Error: ' + escapeHtmlDash(e.message || String(e)) + '</span>');
      });
    },
  });

  var cancelBtn = isc.Button.create({
    title: 'Cancel',
    click: function () { dlg.destroy(); },
  });

  var dlg = isc.Dialog.create({
    title: 'New Schedule',
    width: 420,
    height: 340,
    isModal: true,
    showModalMask: true,
    autoCenter: true,
    closeClick: function () { this.destroy(); },
    items: [schedForm, statusLabel],
    buttons: [okBtn, cancelBtn],
  });
  dlg.show();

  populateScriptDropdown(schedForm, statusLabel);
}

function showEditScheduleDialog(record) {
  var statusLabel = isc.Label.create({
    width: '100%',
    height: 20,
    contents: '',
  });

  var scriptOptions = { '': '-- select script --' };
  if (record.scriptName) scriptOptions[record.scriptName] = record.scriptName;

  var isCron = !!record.cronExpr;
  var fields = buildScheduleFormFields(scriptOptions);
  // Remove runNow from edit dialog
  fields = fields.filter(function (f) { return f.name !== 'runNow'; });

  var schedForm = isc.DynamicForm.create({
    width: '100%',
    numCols: 4,
    colWidths: [80, '*', 60, 60],
    fields: fields,
  });

  // Set initial values from the record
  var unitMs = '60000';
  var intervalNum = 30;
  if (record.intervalMs) {
    if (record.intervalMs >= 3600000) {
      unitMs = '3600000';
      intervalNum = Math.round(record.intervalMs / 3600000);
    } else if (record.intervalMs >= 60000) {
      unitMs = '60000';
      intervalNum = Math.round(record.intervalMs / 60000);
    } else {
      unitMs = '1000';
      intervalNum = Math.round(record.intervalMs / 1000);
    }
  }
  schedForm.setValues({
    name: record.name || '',
    scriptName: record.scriptName || '',
    scheduleMode: isCron ? 'cron' : 'interval',
    interval: intervalNum,
    unit: unitMs,
    cronExpr: record.cronExpr || '',
    args: (record.args || []).join(' '),
  });
  // Apply initial disabled state for mode fields
  schedForm.getField('interval').setDisabled(isCron);
  schedForm.getField('unit').setDisabled(isCron);
  schedForm.getField('cronExpr').setDisabled(!isCron);

  var okBtn = isc.Button.create({
    title: 'Save',
    click: function () {
      var vals = schedForm.getValues();
      var updates = { scheduleId: record.id };
      var editCron = vals.scheduleMode === 'cron';

      if (editCron && !(vals.cronExpr || '').trim()) {
        statusLabel.setContents('<span style="color:#f44336;">Please enter a cron expression</span>');
        return;
      }

      if ((vals.name || '').trim() !== (record.name || '')) updates.name = (vals.name || '').trim();
      if ((vals.scriptName || '') !== (record.scriptName || '')) updates.scriptName = vals.scriptName;

      if (editCron) {
        updates.cronExpr = (vals.cronExpr || '').trim();
      } else {
        updates.intervalMs = (vals.interval || 30) * parseInt(vals.unit || '60000', 10);
      }

      var argsStr = (vals.args || '').trim();
      var argsArr = argsStr ? argsStr.split(/\s+/) : [];
      var oldArgs = (record.args || []).join(' ');
      if (argsStr !== oldArgs) updates.args = argsArr;

      okBtn.setDisabled(true);
      cancelBtn.setDisabled(true);
      schedForm.setDisabled(true);
      statusLabel.setContents(
        '<span style="color:#888;">' +
        '<span style="display:inline-block;width:12px;height:12px;border:2px solid #555;' +
        'border-top-color:#aaa;border-radius:50%;animation:spin .8s linear infinite;' +
        'vertical-align:middle;margin-right:6px;"></span>' +
        'Saving\u2026</span>'
      );

      dispatchActionAsync('SCHEDULE_UPDATE', updates).then(function (resp) {
        if (resp && resp.success) {
          dlg.destroy();
          var grid = resolveRef('schedulesGrid');
          if (grid && grid.invalidateCache) grid.invalidateCache();
        } else {
          okBtn.setDisabled(false);
          cancelBtn.setDisabled(false);
          schedForm.setDisabled(false);
          var err = (resp && resp.error) || 'Failed to update schedule';
          statusLabel.setContents('<span style="color:#f44336;">' + escapeHtmlDash(err) + '</span>');
        }
      }).catch(function (e) {
        okBtn.setDisabled(false);
        cancelBtn.setDisabled(false);
        schedForm.setDisabled(false);
        statusLabel.setContents('<span style="color:#f44336;">Error: ' + escapeHtmlDash(e.message || String(e)) + '</span>');
      });
    },
  });

  var cancelBtn = isc.Button.create({
    title: 'Cancel',
    click: function () { dlg.destroy(); },
  });

  var dlg = isc.Dialog.create({
    title: 'Edit Schedule: ' + (record.name || record.id),
    width: 420,
    height: 320,
    isModal: true,
    showModalMask: true,
    autoCenter: true,
    closeClick: function () { this.destroy(); },
    items: [schedForm, statusLabel],
    buttons: [okBtn, cancelBtn],
  });
  dlg.show();

  populateScriptDropdown(schedForm, null);
}

// ---- Async dispatch ----

var DISPATCH_TIMEOUT_MS = 15000; // 15s default timeout for action dispatches

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

    case 'AUTO_BROADCAST_ARTIFACT':
      handleArtifactBroadcast(payload);
      break;

    case 'AUTO_BROADCAST_RUN_COMPLETE':
      // Run archived — if in archive mode, refresh the grid
      if (_dashState.scriptHistoryMode === 'archive') {
        loadArchiveRuns();
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

// ---- Auth capture ----

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

  // New Session / New Schedule: enabled when connected
  setButtonDisabled('btnNewSession', !connected);
  setButtonDisabled('btnNewSchedule', !connected);
  setButtonDisabled('btnEditSchedule', !connected);

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

// ---- Recipe (pre/post actions) ----

function actionSummary(action) {
  var parts = [action.command];
  var def = window.CLI_COMMANDS[action.command];
  if (def && def.args) {
    for (var i = 0; i < def.args.length; i++) {
      var val = action.args && action.args[def.args[i].name];
      if (val != null && val !== '') parts.push(String(val));
    }
  }
  if (def && def.options) {
    for (var j = 0; j < def.options.length; j++) {
      var oval = action.options && action.options[def.options[j].name];
      if (oval != null && oval !== '' && oval !== false) {
        parts.push('--' + def.options[j].name + '=' + String(oval));
      }
    }
  }
  return parts.join(' ');
}

function renderRecipeGrids() {
  renderRecipeGrid('preActionsGrid', _dashState.recipe.preActions);
  renderRecipeGrid('postActionsGrid', _dashState.recipe.postActions);
}

function renderRecipeGrid(gridId, actions) {
  var grid = resolveRef(gridId);
  if (!grid) return;
  var data = [];
  for (var i = 0; i < actions.length; i++) {
    data.push({ idx: i + 1, summary: actionSummary(actions[i]), _actionIdx: i });
  }
  grid.setData(data);
}

function wireRecipeGrid(gridId, phase) {
  var grid = resolveRef(gridId);
  if (!grid) return;

  // Remove icon click
  grid.recordClick = function (viewer, record, recordNum, field) {
    if (field && field.name === '_remove') {
      var arr = _dashState.recipe[phase];
      var idx = record._actionIdx;
      if (idx >= 0 && idx < arr.length) {
        arr.splice(idx, 1);
        renderRecipeGrid(gridId, arr);
      }
      return false;
    }
    // Double-click to edit
    return true;
  };

  grid.recordDoubleClick = function (viewer, record) {
    var arr = _dashState.recipe[phase];
    var idx = record._actionIdx;
    if (idx >= 0 && idx < arr.length) {
      showActionDialog(phase, arr[idx], idx);
    }
  };

  // Drag reorder sync
  grid.recordDrop = function (dropRecords, targetRecord, index, sourceWidget) {
    // After SC reorders the visual list, rebuild the action array
    var self = this;
    // Defer so SC finishes its internal reorder first
    setTimeout(function () {
      var newArr = [];
      var data = self.getData();
      var oldArr = _dashState.recipe[phase];
      for (var i = 0; i < data.length; i++) {
        var row = data[i];
        if (row._actionIdx >= 0 && row._actionIdx < oldArr.length) {
          newArr.push(oldArr[row._actionIdx]);
        }
      }
      _dashState.recipe[phase] = newArr;
      renderRecipeGrid(gridId, newArr);
    }, 0);
  };
}

function showAddActionMenu(phase) {
  var categories = window.CATEGORIES || {};
  var commands = window.CLI_COMMANDS || {};

  // Build menu items grouped by category
  var menuData = [];
  for (var catKey in categories) {
    var subItems = [];
    for (var cmd in commands) {
      if (commands[cmd].category === catKey) {
        subItems.push({ title: cmd, _command: cmd, _phase: phase });
      }
    }
    if (subItems.length > 0) {
      menuData.push({ title: categories[catKey], submenu: subItems });
    }
  }

  // Destroy previous menu to prevent Canvas leak
  if (showAddActionMenu._lastMenu) {
    showAddActionMenu._lastMenu.destroy();
    showAddActionMenu._lastMenu = null;
  }
  var menu = isc.Menu.create({
    autoDraw: false,
    data: menuData,
    itemClick: function (item) {
      if (item._command) {
        showActionDialog(item._phase, { command: item._command, args: {}, options: {} }, -1);
      }
    },
  });
  showAddActionMenu._lastMenu = menu;
  menu.showContextMenu();
}

function showActionDialog(phase, action, editIdx) {
  var cmd = action.command;
  var def = window.CLI_COMMANDS[cmd];
  if (!def) return;

  var fields = [];
  // Build form fields from command args
  if (def.args) {
    for (var i = 0; i < def.args.length; i++) {
      var arg = def.args[i];
      var field = {
        name: 'arg_' + arg.name,
        title: arg.name,
        width: '*',
        defaultValue: (action.args && action.args[arg.name]) || '',
      };
      if (arg.type === 'enum' && arg.values) {
        field.editorType = 'SelectItem';
        var vm = {};
        for (var v = 0; v < arg.values.length; v++) vm[arg.values[v]] = arg.values[v];
        field.valueMap = vm;
        field.defaultValue = (action.args && action.args[arg.name]) || arg.values[0];
      } else if (arg.type === 'number') {
        field.editorType = 'SpinnerItem';
        field.defaultValue = (action.args && action.args[arg.name]) || '';
      } else if (arg.type === 'boolean') {
        field.editorType = 'CheckboxItem';
        field.defaultValue = !!(action.args && action.args[arg.name]);
      } else if (arg.type === 'code') {
        field.editorType = 'TextAreaItem';
        field.height = 60;
      } else {
        field.editorType = 'TextItem';
      }
      if (arg.placeholder) field.hint = arg.placeholder;
      fields.push(field);
    }
  }
  // Build form fields from command options
  if (def.options) {
    for (var j = 0; j < def.options.length; j++) {
      var opt = def.options[j];
      var oField = {
        name: 'opt_' + opt.name,
        title: opt.name,
        width: '*',
        defaultValue: (action.options && action.options[opt.name]) || '',
      };
      if (opt.type === 'enum' && opt.values) {
        oField.editorType = 'SelectItem';
        var ovm = { '': '(none)' };
        for (var ov = 0; ov < opt.values.length; ov++) ovm[opt.values[ov]] = opt.values[ov];
        oField.valueMap = ovm;
      } else if (opt.type === 'number') {
        oField.editorType = 'SpinnerItem';
      } else if (opt.type === 'boolean') {
        oField.editorType = 'CheckboxItem';
        oField.defaultValue = !!(action.options && action.options[opt.name]);
      } else {
        oField.editorType = 'TextItem';
      }
      if (opt.placeholder) oField.hint = opt.placeholder;
      fields.push(oField);
    }
  }

  if (fields.length === 0) {
    // No args/options — just add the action directly
    commitAction(phase, cmd, def, {}, editIdx);
    return;
  }

  var form = isc.DynamicForm.create({
    width: '100%',
    numCols: 2,
    colWidths: [100, '*'],
    fields: fields,
  });

  var dlg = isc.Dialog.create({
    title: cmd,
    width: 400,
    height: Math.min(80 + fields.length * 40, 400),
    isModal: true,
    showModalMask: true,
    autoCenter: true,
    closeClick: function () { this.destroy(); },
    items: [form],
    buttons: [
      isc.Button.create({
        title: 'OK',
        click: function () {
          var vals = form.getValues();
          commitAction(phase, cmd, def, vals, editIdx);
          dlg.destroy();
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

function commitAction(phase, cmd, def, formVals, editIdx) {
  var actionObj = { command: cmd, args: {}, options: {} };

  if (def.args) {
    for (var i = 0; i < def.args.length; i++) {
      var name = def.args[i].name;
      var val = formVals['arg_' + name];
      if (val != null && val !== '') actionObj.args[name] = val;
    }
  }
  if (def.options) {
    for (var j = 0; j < def.options.length; j++) {
      var oName = def.options[j].name;
      var oVal = formVals['opt_' + oName];
      if (oVal != null && oVal !== '' && oVal !== false) actionObj.options[oName] = oVal;
    }
  }

  var arr = _dashState.recipe[phase];
  if (editIdx >= 0 && editIdx < arr.length) {
    arr[editIdx] = actionObj;
  } else {
    arr.push(actionObj);
  }

  var gridId = phase === 'preActions' ? 'preActionsGrid' : 'postActionsGrid';
  renderRecipeGrid(gridId, arr);
}

function saveRecipe() {
  if (!_loadedScriptName) {
    isc.say('No script loaded — select a script first.');
    return;
  }
  var pre = _dashState.recipe.preActions || [];
  var post = _dashState.recipe.postActions || [];
  var recipeName = generateRecipeName(pre, post);

  // Save to Recipes DataSource (IndexedDB)
  var recipeData = {
    name: recipeName,
    preActions: pre,
    postActions: post,
    modifiedAt: Date.now(),
  };

  if (_dashState.recipeId) {
    // Update existing recipe
    recipeData.id = _dashState.recipeId;
    dispatchActionAsync('DS_UPDATE', { dataSource: 'Recipes', data: recipeData }).then(function (resp) {
      if (resp && resp.status === 0) {
        isc.say('Recipe saved.');
        refreshRecipeSelect();
      } else {
        var err = (resp && typeof resp.data === 'string') ? resp.data : 'unknown error';
        isc.warn('Failed to save recipe: ' + err);
      }
    });
  } else {
    // Create new recipe
    dispatchActionAsync('DS_ADD', { dataSource: 'Recipes', data: recipeData }).then(function (resp) {
      if (resp && resp.status === 0) {
        var newId = toRecipeId(resp.data && resp.data[0] && resp.data[0].id);
        if (newId) {
          _dashState.recipeId = newId;
          // Auto-assign to current script
          if (_dashState.selectedLibScript) {
            dispatchActionAsync('SCRIPT_LIBRARY_UPDATE', {
              name: _dashState.selectedLibScript,
              recipeId: newId,
            });
          }
          var recipeSelect = resolveRef('recipeSelect');
          if (recipeSelect) recipeSelect.setValue(newId);
        }
        isc.say('Recipe saved.');
        refreshRecipeSelect();
      } else {
        var err = (resp && typeof resp.data === 'string') ? resp.data : 'unknown error';
        isc.warn('Failed to save recipe: ' + err);
      }
    });
  }
}

// ---- Recipe name generation ----

function generateRecipeName(preActions, postActions) {
  var allActions = (preActions || []).concat(postActions || []);
  if (allActions.length === 0) return 'empty-recipe';
  var parts = [];
  for (var i = 0; i < allActions.length; i++) {
    var cmd = allActions[i].command || '';
    parts.push(cmd.substring(0, 3));
  }
  return parts.join('-');
}

// ---- Scripts library grid ----

function wireScriptsLibraryGrid() {
  var grid = resolveRef('scriptsLibraryGrid');
  if (!grid) return;

  grid.formatCellValue = function (value, record, rowNum, colNum) {
    var fieldName = this.getFieldName(colNum);
    if (fieldName === 'modifiedAt' && typeof value === 'number') {
      return new Date(value).toLocaleString();
    }
    return value == null ? '' : value;
  };

  grid.recordClick = function (viewer, record) {
    if (!record || !record.name) return;
    _dashState.selectedLibScript = record.name;
    _dashState.recipeId = toRecipeId(record.recipeId);
    // Select script so Run/Debug toolbar buttons become active
    _dashState.selectedScriptId = record.name;
    _dashState.selectedScript = { id: record.name, name: record.name };

    // Load into editor
    loadScriptIntoEditor(record.name);

    // Also select in scriptsGrid if running
    selectScriptInHistoryGrid(record.name);

    // Load version history
    loadVersionHistory(record.name);

    // Update recipe picker
    loadRecipeForScript(record);

    refreshToolbar();
  };

  // Initial load
  refreshScriptsLibrary();
}

function refreshScriptsLibrary() {
  dispatchActionAsync('SCRIPT_LIBRARY_LIST', {}).then(function (resp) {
    var grid = resolveRef('scriptsLibraryGrid');
    if (grid && resp && resp.success) {
      grid.setData(resp.scripts || []);
    }
  });
}

function selectScriptInHistoryGrid(name) {
  var grid = resolveRef('scriptsGrid');
  if (!grid) return;
  var data = grid.getData();
  if (!data || !data.length) return;
  for (var i = 0; i < data.length; i++) {
    if (data[i] && data[i].name === name) {
      grid.selectSingleRecord(data[i]);
      _dashState.selectedScriptId = data[i].id;
      _dashState.selectedScript = data[i];

      var dv = resolveRef('debugViewer');
      if (dv) dv.setData([data[i]]);
      return;
    }
  }
}

// ---- Script version history ----

function loadVersionHistory(scriptName) {
  dispatchActionAsync('SCRIPT_VERSION_LIST', { scriptName: scriptName }).then(function (resp) {
    var grid = resolveRef('scriptVersionsGrid');
    if (grid && resp && resp.success) {
      grid.setData(resp.versions || []);
    }
  });

  // Wire version grid formatCellValue + recordClick
  var vGrid = resolveRef('scriptVersionsGrid');
  if (vGrid && !vGrid._dashWired) {
    vGrid._dashWired = true;

    vGrid.formatCellValue = function (value, record, rowNum, colNum) {
      var fieldName = this.getFieldName(colNum);
      if (fieldName === 'modifiedAt' && typeof value === 'number') {
        return new Date(value).toLocaleString();
      }
      return value == null ? '' : value;
    };

    vGrid.recordClick = function (viewer, record) {
      if (!record || !record.modifiedAt) return;
      var scriptName = _dashState.selectedLibScript;
      if (!scriptName) return;
      dispatchActionAsync('SCRIPT_VERSION_GET', {
        scriptName: scriptName,
        modifiedAt: record.modifiedAt,
      }).then(function (resp) {
        if (resp && resp.success && resp.version && _monacoEditor) {
          _monacoEditor.setValue(resp.version.source || '');
        }
      });
    };
  }
}

// ---- Recipe picker ----

function refreshRecipeSelect() {
  dispatchActionAsync('DS_FETCH', { dataSource: 'Recipes' }).then(function (resp) {
    var select = resolveRef('recipeSelect');
    if (!select) return;
    var valueMap = {};
    var data = (resp && resp.status === 0 && Array.isArray(resp.data)) ? resp.data : [];
    for (var i = 0; i < data.length; i++) {
      valueMap[data[i].id] = data[i].name;
    }
    select.setValueMap(valueMap);
  });
}

function loadRecipeForScript(record) {
  refreshRecipeSelect();
  var rid = toRecipeId(record.recipeId);
  var select = resolveRef('recipeSelect');
  if (select) {
    select.setValue(rid);
  }

  // If script has a recipeId, load its pre/post actions
  if (rid) {
    dispatchActionAsync('DS_FETCH', { dataSource: 'Recipes', criteria: { id: record.recipeId } }).then(function (resp) {
      var data = (resp && resp.status === 0 && Array.isArray(resp.data)) ? resp.data : [];
      if (data.length > 0) {
        _dashState.recipe = {
          preActions: data[0].preActions || [],
          postActions: data[0].postActions || [],
        };
        _dashState.recipeId = data[0].id;
        renderRecipeGrids();
      }
    });
  }
}

function assignRecipeToScript() {
  var scriptName = _dashState.selectedLibScript;
  if (!scriptName) {
    isc.say('No script selected — select a script first.');
    return;
  }
  var form = resolveRef('recipePickerForm');
  var recipeId = toRecipeId(form ? form.getValue('recipeId') : null);

  dispatchActionAsync('SCRIPT_LIBRARY_UPDATE', {
    name: scriptName,
    recipeId: recipeId,
  }).then(function (resp) {
    if (resp && resp.success) {
      _dashState.recipeId = recipeId;
      // If assigned, load recipe actions
      if (recipeId) {
        dispatchActionAsync('DS_FETCH', { dataSource: 'Recipes', criteria: { id: recipeId } }).then(function (r) {
          var data = (r && r.status === 0 && Array.isArray(r.data)) ? r.data : [];
          if (data.length > 0) {
            _dashState.recipe = {
              preActions: data[0].preActions || [],
              postActions: data[0].postActions || [],
            };
            renderRecipeGrids();
          }
        });
      } else {
        _dashState.recipe = { preActions: [], postActions: [] };
        renderRecipeGrids();
      }
      refreshScriptsLibrary();
    } else {
      isc.warn('Failed to assign recipe: ' + ((resp && resp.error) || 'unknown error'));
    }
  });
}

// ---- File > Save / Save As ----

function fileSave() {
  if (!_loadedScriptName || !_monacoEditor) {
    isc.say('No script loaded.');
    return;
  }
  dispatchActionAsync('SCRIPT_LIBRARY_SAVE', {
    name: _loadedScriptName,
    source: _monacoEditor.getValue(),
    recipeId: toRecipeId(_dashState.recipeId),
  }).then(function (resp) {
    if (resp && resp.success) {
      refreshScriptsLibrary();
      loadVersionHistory(_loadedScriptName);
    } else {
      isc.warn('Save failed: ' + ((resp && resp.error) || 'unknown error'));
    }
  });
}

function fileSaveAs() {
  if (!_monacoEditor) {
    isc.say('No script loaded.');
    return;
  }

  var nameForm = isc.DynamicForm.create({
    width: '100%',
    numCols: 2,
    colWidths: [80, '*'],
    fields: [
      {
        name: 'newName',
        title: 'Name',
        editorType: 'TextItem',
        width: '*',
        defaultValue: (_loadedScriptName || '') + '-copy',
        selectOnFocus: true,
      },
    ],
  });

  var statusLabel = isc.Label.create({
    width: '100%',
    height: 20,
    contents: '',
  });

  var okBtn = isc.Button.create({
    title: 'Save',
    click: function () {
      var newName = (nameForm.getValue('newName') || '').trim();
      if (!newName) {
        statusLabel.setContents('<span style="color:#f44336;">Please enter a name</span>');
        return;
      }

      okBtn.setDisabled(true);
      statusLabel.setContents('<span style="color:#888;">Saving...</span>');

      dispatchActionAsync('SCRIPT_LIBRARY_SAVE', {
        name: newName,
        source: _monacoEditor.getValue(),
        recipeId: toRecipeId(_dashState.recipeId),
      }).then(function (resp) {
        if (resp && resp.success) {
          _loadedScriptName = newName;
          _dashState.selectedLibScript = newName;
          dlg.destroy();
          refreshScriptsLibrary();
          loadVersionHistory(newName);
        } else {
          okBtn.setDisabled(false);
          var err = (resp && resp.error) || 'Save failed';
          statusLabel.setContents('<span style="color:#f44336;">' + escapeHtmlDash(err) + '</span>');
        }
      });
    },
  });

  var dlg = isc.Dialog.create({
    title: 'Save As',
    width: 360,
    height: 150,
    isModal: true,
    showModalMask: true,
    autoCenter: true,
    closeClick: function () { this.destroy(); },
    items: [nameForm, statusLabel],
    buttons: [
      okBtn,
      isc.Button.create({
        title: 'Cancel',
        click: function () { dlg.destroy(); },
      }),
    ],
  });
  dlg.show();
  nameForm.focusInItem('newName');
}

// ---- Script History: Live/Archive toggle ----

function wireScriptHistoryToggle() {
  var btnLive = resolveRef('btnHistoryLive');
  var btnArchive = resolveRef('btnHistoryArchive');

  function updateToggleStyle() {
    if (btnLive) {
      btnLive.setTitle(_dashState.scriptHistoryMode === 'live' ? '<b>Live</b>' : 'Live');
    }
    if (btnArchive) {
      btnArchive.setTitle(_dashState.scriptHistoryMode === 'archive' ? '<b>Archive</b>' : 'Archive');
    }
  }

  if (btnLive) {
    btnLive.click = function () {
      if (_dashState.scriptHistoryMode === 'live') return;
      _dashState.scriptHistoryMode = 'live';
      updateToggleStyle();
      switchToLiveMode();
    };
  }

  if (btnArchive) {
    btnArchive.click = function () {
      if (_dashState.scriptHistoryMode === 'archive') return;
      _dashState.scriptHistoryMode = 'archive';
      updateToggleStyle();
      switchToArchiveMode();
    };
  }

  updateToggleStyle();
}

function switchToLiveMode() {
  var grid = resolveRef('scriptsGrid');
  if (!grid) return;
  // Re-bind to BridgeScripts DataSource
  var ds = isc.DataSource.get('BridgeScripts');
  if (ds) grid.setDataSource(ds);
  grid.setFields([
    { name: 'name',       width: '*' },
    { name: 'state',      width: 80, _formatter: 'stateDot' },
    { name: 'step',       width: 35 },
    { name: 'totalSteps', width: 35, title: '/' },
    { name: 'startedAt',  width: 70, title: 'Started' },
  ]);
  grid.fetchData();
  grid.formatCellValue = function (value, record, rowNum, colNum) {
    var fieldName = this.getFieldName(colNum);
    if (fieldName === 'startedAt' && typeof value === 'number') {
      return new Date(value).toLocaleTimeString();
    }
    return value;
  };
}

function switchToArchiveMode() {
  var grid = resolveRef('scriptsGrid');
  if (!grid) return;
  // Unbind DataSource, switch to manual data
  grid.setDataSource(null);
  grid.setFields([
    { name: 'name',          title: 'Script',    width: '*' },
    { name: 'state',         title: 'State',     width: 70 },
    { name: 'startedAt',     title: 'Started',   width: 90 },
    { name: 'durationMs',    title: 'Duration',  width: 60 },
    { name: 'artifactCount', title: 'Artifacts', width: 55 },
  ]);
  loadArchiveRuns();
}

function loadArchiveRuns() {
  dispatchActionAsync('SCRIPT_RUN_LIST', {}).then(function (resp) {
    var grid = resolveRef('scriptsGrid');
    if (!grid || _dashState.scriptHistoryMode !== 'archive') return;
    var runs = (resp && resp.success && resp.runs) ? resp.runs : [];
    grid.setData(runs);

    // Apply formatters
    grid.formatCellValue = function (value, record, rowNum, colNum) {
      var fieldName = this.getFieldName(colNum);
      if (fieldName === 'startedAt' && typeof value === 'number') {
        return new Date(value).toLocaleString();
      }
      if (fieldName === 'durationMs' && typeof value === 'number') {
        return formatDuration(value);
      }
      return value == null ? '' : value;
    };
  });
}

function handleArchiveRunSelect(record) {
  if (!record) return;
  var scriptId = record.scriptId || record.id;

  // Show run summary in debug viewer
  var dv = resolveRef('debugViewer');
  if (dv) dv.setData([record]);

  // Load artifacts for this run
  dispatchActionAsync('SCRIPT_RUN_GET', { scriptId: scriptId }).then(function (resp) {
    var artifacts = (resp && resp.success && resp.artifacts) ? resp.artifacts : [];
    _dashState.selectedRunArtifacts = artifacts;
    var artifactsGrid = resolveRef('artifactsGrid');
    if (artifactsGrid) {
      artifactsGrid.setData(artifacts);
      // Apply formatters
      artifactsGrid.formatCellValue = function (value, record, rowNum, colNum) {
        var fieldName = this.getFieldName(colNum);
        if (fieldName === 'timestamp' && typeof value === 'number') {
          return new Date(value).toLocaleTimeString();
        }
        if (fieldName === 'size' && typeof value === 'number') {
          if (value < 1024) return value + 'B';
          return Math.round(value / 1024) + 'KB';
        }
        return value == null ? '' : value;
      };
    }

    // Switch to Artifacts tab if there are artifacts
    if (artifacts.length > 0) {
      var tabs = resolveRef('scriptDetailTabs');
      if (tabs) tabs.selectTab(1);
    }
  });
}

// ---- Artifacts grid ----

function wireArtifactsGrid() {
  var grid = resolveRef('artifactsGrid');
  if (!grid) return;

  grid.recordClick = function (viewer, record) {
    if (!record) return;
    loadArtifactPreview(record);
  };

  // Apply formatters
  grid.formatCellValue = function (value, record, rowNum, colNum) {
    var fieldName = this.getFieldName(colNum);
    if (fieldName === 'timestamp' && typeof value === 'number') {
      return new Date(value).toLocaleTimeString();
    }
    if (fieldName === 'size' && typeof value === 'number') {
      if (value < 1024) return value + 'B';
      return Math.round(value / 1024) + 'KB';
    }
    return value == null ? '' : value;
  };
}

function loadArtifactPreview(artifact) {
  var preview = resolveRef('artifactPreview');
  if (!preview) return;

  // If we already have inline data, show it immediately
  if (artifact.data) {
    renderArtifactPreview(preview, artifact, artifact.data);
    return;
  }

  // Need to lazy-load from disk or IndexedDB
  preview.setContents('<div style="padding:8px;color:#888;font-size:11px;">Loading...</div>');

  var payload = {};
  if (artifact.diskPath) {
    payload.diskPath = artifact.diskPath;
  } else if (artifact.id != null) {
    payload.id = artifact.id;
  } else {
    preview.setContents('<div style="padding:8px;color:#f44336;font-size:11px;">No data source for artifact</div>');
    return;
  }

  dispatchActionAsync('SCRIPT_ARTIFACT_GET', payload).then(function (resp) {
    if (resp && resp.success && resp.data) {
      renderArtifactPreview(preview, artifact, resp.data);
    } else {
      var err = (resp && resp.error) || 'Failed to load';
      preview.setContents('<div style="padding:8px;color:#f44336;font-size:11px;">' + escapeHtmlDash(err) + '</div>');
    }
  });
}

function renderArtifactPreview(preview, artifact, data) {
  var type = artifact.type || '';
  var label = artifact.label || '';

  switch (type) {
    case 'screenshot':
      var src = data.startsWith('data:') ? data : 'data:image/png;base64,' + data;
      preview.setContents(
        '<div style="padding:4px;text-align:center;">'
        + '<img src="' + src + '" style="max-width:100%;cursor:pointer;border:1px solid #333;" '
        + 'onclick="window._openScreenshotViewer && window._openScreenshotViewer(this.src, \'' + escapeHtmlDash(label) + '\')" />'
        + '</div>'
      );
      break;
    case 'snapshot':
      preview.setContents('<pre style="padding:4px;font-size:11px;font-family:monospace;white-space:pre-wrap;color:#ccc;margin:0;max-height:300px;overflow:auto;">' + escapeHtmlDash(data) + '</pre>');
      break;
    case 'console':
      preview.setContents('<pre style="padding:4px;font-size:11px;font-family:monospace;white-space:pre-wrap;color:#aaa;margin:0;max-height:300px;overflow:auto;">' + escapeHtmlDash(data) + '</pre>');
      break;
    case 'debug':
    case 'result':
      var formatted = data;
      try {
        if (typeof data === 'string') formatted = JSON.stringify(JSON.parse(data), null, 2);
      } catch (e) { /* not valid JSON, show as-is */ }
      preview.setContents('<pre style="padding:4px;font-size:11px;font-family:monospace;white-space:pre-wrap;color:#4CAF50;margin:0;max-height:300px;overflow:auto;">' + escapeHtmlDash(formatted) + '</pre>');
      break;
    default:
      preview.setContents('<pre style="padding:4px;font-size:11px;font-family:monospace;white-space:pre-wrap;color:#888;margin:0;">' + escapeHtmlDash(data) + '</pre>');
  }
}

// Global hook for screenshot viewer (called from inline onclick in HTMLFlow)
window._openScreenshotViewer = function (src, label) {
  isc.Window.create({
    title: label || 'Screenshot',
    width: Math.min(window.innerWidth - 100, 900),
    height: Math.min(window.innerHeight - 100, 700),
    autoCenter: true,
    canDragResize: true,
    closeClick: function () { this.destroy(); },
    items: [
      isc.Canvas.create({
        width: '100%',
        height: '100%',
        overflow: 'auto',
        contents: '<img src="' + src + '" style="max-width:100%;" />',
      }),
    ],
  }).show();
};

// ---- Real-time artifact streaming ----

function handleArtifactBroadcast(payload) {
  if (!payload || !payload.artifact) return;
  var scriptId = payload.scriptId;
  var artifact = payload.artifact;

  // If viewing this script in live mode, append to artifacts grid
  if (_dashState.selectedScriptId && _dashState.selectedScriptId === scriptId) {
    var grid = resolveRef('artifactsGrid');
    if (grid) {
      var data = grid.getData();
      if (Array.isArray(data)) {
        data.push(artifact);
        grid.setData(data);
        // Auto-scroll to latest
        grid.scrollToRow(data.length - 1);
      }
    }
  }
}

// ---- Capture artifacts toggle in toolbar ----
// Add a checkbox to the toolbar area for capture artifacts toggle
// This is wired programmatically since adding DynamicForm to ToolStrip in config is complex

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


// ---- Test Results ----

function loadTestResults() {
  dispatchActionAsync('SCRIPT_RUN_LIST', {}).then(function (resp) {
    if (!resp || !resp.runs) return;
    // Filter to runs that have assertion data
    var testRuns = resp.runs.filter(function (r) { return r.assertions; });
    var grid = resolveRef('testResultsGrid');
    var statusLabel = resolveRef('testStatusLabel');
    if (!grid) return;

    var records = testRuns.map(function (r) {
      return {
        name: r.name,
        pass: r.assertions ? r.assertions.pass : '',
        fail: r.assertions ? r.assertions.fail : '',
        state: r.state,
        durationMs: r.durationMs,
        completedAt: r.completedAt,
      };
    });
    grid.setData(records);

    if (statusLabel) {
      var totalPass = 0, totalFail = 0;
      for (var i = 0; i < records.length; i++) {
        totalPass += (records[i].pass || 0);
        totalFail += (records[i].fail || 0);
      }
      if (records.length > 0) {
        var color = totalFail > 0 ? '#f44336' : '#4CAF50';
        statusLabel.setContents('<span style="color:' + color + ';">' + records.length + ' runs | ' + totalPass + ' pass | ' + totalFail + ' fail</span>');
      } else {
        statusLabel.setContents('<span style="color:#888;">No test runs yet</span>');
      }
    }
  }).catch(function (err) {
    console.warn('[Dashboard] loadTestResults failed:', err.message);
  });
}
