// dashboard-app.js — entry point + state + loadDashboard orchestrator.
// Portlet wiring lives in dashboard/*.js (loaded via separate <script> tags).
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
// Monaco now lives in a standalone SmartClient Window (not the Source portlet).
// The portlet shows a read-only <pre> viewer. Double-clicking opens Monaco.
var _monacoEditor = null;
var _monacoEditorWindow = null;  // SmartClient Window hosting Monaco
var _monacoDecorations = null;
var _v8Decorations = null;
var _checkpointLines = {};       // { name: lineNumber }
var _editorBreakpoints = [];     // active breakpoint names (strings) or line numbers
var _currentCheckpoint = null;   // name of checkpoint we're paused at
var _loadedScriptName = null;

// ---- Auth capture state ----
var _authCaptureSessionId = null;
var _authCaptureScriptName = null;

// ---- Session recording state ----
var _tracingSessionId = null;   // sessionId currently being traced
var _videoSessionId = null;     // sessionId currently being video-recorded

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

// ---- Context menus ----
var _historyContextMenu = null;

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

  // Wire sessions grid click to refresh toolbar (enables Trace/Video buttons)
  var sessionsGrid = resolveRef('sessionsGrid');
  if (sessionsGrid) {
    sessionsGrid.recordClick = function () { refreshToolbar(); };
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

      // Show assertions if available (from live progress)
      updateAssertionsGrid(record ? record.assertions : null);

      // Load artifacts for completed/disconnected scripts (they were broadcast earlier)
      if (record && (record.state === 'complete' || record.state === 'disconnected')) {
        var scriptId = record.scriptId || record.id;
        if (scriptId) {
          dispatchActionAsync('SCRIPT_RUN_GET', { scriptId: scriptId }).then(function (resp) {
            var artifacts = (resp && resp.success && resp.artifacts) ? resp.artifacts : [];
            var artifactsGrid = resolveRef('artifactsGrid');
            if (artifactsGrid) { artifactsGrid.setData(artifacts); ensureArtifactGridEvents(artifactsGrid); }
          });
        }
      } else {
        var artifactsGrid = resolveRef('artifactsGrid');
        if (artifactsGrid) artifactsGrid.setData([]);
      }

      // Load script source into Monaco editor
      if (record && record.name) {
        loadScriptIntoEditor(record.name);
      }

      refreshToolbar();
    };

    // Double-click: always open script in editor (works in both Live and Archive mode)
    scriptsGrid.recordDoubleClick = function (viewer, record) {
      if (record && record.name) {
        loadScriptIntoEditor(record.name);
        // Also select in scripts library grid
        selectScriptInLibrary(record.name);
      }
    };

    // Right-click context menu
    scriptsGrid.showContextMenu = function () {
      var record = this.getSelectedRecord();
      if (!record || !record.name) return false;
      var scriptName = record.name;
      if (!_historyContextMenu) {
        _historyContextMenu = isc.Menu.create({
          ID: 'historyContextMenu',
          data: [
            { title: 'Open in Editor', icon: '[SKIN]/actions/edit.png' },
            { title: 'Run Script', icon: '[SKIN]/actions/forward.png' },
          ],
        });
      }
      _historyContextMenu.setData([
        { title: 'Open in Editor', click: function () {
          loadScriptIntoEditor(scriptName);
          selectScriptInLibrary(scriptName);
        }},
        { title: 'Run Script', click: function () {
          _loadedScriptName = scriptName;
          _dashState.selectedScriptId = scriptName;
          _dashState.selectedScript = { id: scriptName, name: scriptName };
          launchSelectedScript(false, null);
        }},
      ]);
      _historyContextMenu.showContextMenu();
      return false;
    };
  }

  // Wire Run button (standalone — always launches a new browser)
  var tbRun = resolveRef('tbRun');
  if (tbRun) {
    tbRun.click = function () {
      launchSelectedScript(false, null);
    };
  }

  // Wire Session Run menu button — dynamically lists available sessions
  var tbSessionRun = resolveRef('tbSessionRun');
  if (tbSessionRun) {
    tbSessionRun.click = function () {
      showSessionRunMenu(tbSessionRun, false);
    };
  }

  // Wire Debug button handler
  var tbDebug = resolveRef('tbDebug');
  if (tbDebug) {
    tbDebug.click = function () {
      launchSelectedScript(true, null);
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
      var source = _monacoEditor ? _monacoEditor.getValue() : (_dashState.currentSource || '');
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

  // Wire Trace toggle button
  var tbTrace = resolveRef('tbTrace');
  if (tbTrace) {
    tbTrace.click = function () { toggleTracing(); };
  }

  // Wire Video toggle button
  var tbVideo = resolveRef('tbVideo');
  if (tbVideo) {
    tbVideo.click = function () { toggleVideo(); };
  }

  // Wire Help button
  var tbHelp = resolveRef('tbHelp');
  if (tbHelp) {
    tbHelp.click = function () { showHelpWindow(); };
  }

  // Wire Script Detail tab change — auto-refresh Console/Network when selected
  var detailTabs = resolveRef('scriptDetailTabs');
  if (detailTabs) {
    detailTabs.tabSelected = function (tabNum) {
      // Tabs: 0=State, 1=Assertions, 2=Artifacts, 3=Console, 4=Network
      if (tabNum === 3) refreshSessionConsole();
      if (tabNum === 4) refreshSessionNetwork();
    };
  }

  // Wire Console/Network refresh buttons
  var btnRefreshConsole = resolveRef('btnRefreshConsole');
  if (btnRefreshConsole) {
    btnRefreshConsole.click = function () { refreshSessionConsole(); };
  }
  var btnRefreshNetwork = resolveRef('btnRefreshNetwork');
  if (btnRefreshNetwork) {
    btnRefreshNetwork.click = function () { refreshSessionNetwork(); };
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

  // ==== Run Plans (Automation portlet) ====
  var btnNewRunPlan = resolveRef('btnNewRunPlan');
  if (btnNewRunPlan) {
    btnNewRunPlan.click = function () { showNewRunPlanDialog(); };
  }
  var btnRunRunPlan = resolveRef('btnRunRunPlan');
  if (btnRunRunPlan) {
    btnRunRunPlan.click = function () {
      var tree = resolveRef('runPlansTree');
      var rec = tree && tree.getSelectedRecord();
      if (!rec) { isc.warn('Select a plan to run'); return; }
      var planId = rec.isPlan ? rec.id : rec.parentId;
      if (!planId) return;
      dispatchActionAsync('RUN_PLAN_EXECUTE', { id: planId }).then(function (resp) {
        if (resp && resp.success) {
          isc.say('Plan started: runId=' + resp.runId + ' (' + resp.stepsToRun + ' steps)');
        } else {
          isc.warn('Run failed: ' + (resp && resp.error ? resp.error : 'unknown'));
        }
      });
    };
  }
  var btnDeleteRunPlan = resolveRef('btnDeleteRunPlan');
  if (btnDeleteRunPlan) {
    btnDeleteRunPlan.click = function () {
      var tree = resolveRef('runPlansTree');
      var rec = tree && tree.getSelectedRecord();
      if (!rec || !rec.isPlan) { isc.warn('Select a plan (not a step) to delete'); return; }
      isc.ask('Delete plan "' + rec.name + '"?', function (ok) {
        if (!ok) return;
        dispatchActionAsync('RUN_PLAN_DELETE', { id: rec.id }).then(function () {
          var t = resolveRef('runPlansTree');
          if (t) t.invalidateCache();
        });
      });
    };
  }
  var btnRefreshRunPlans = resolveRef('btnRefreshRunPlans');
  if (btnRefreshRunPlans) {
    btnRefreshRunPlans.click = function () {
      var t = resolveRef('runPlansTree');
      if (t) t.invalidateCache();
    };
  }

  // Right-click context menu on the run-plan tree.
  // Items conditional on whether the row is a plan (parent) or a step (child).
  var runPlansTree = resolveRef('runPlansTree');
  if (runPlansTree) {
    // Toggle helper used by both the context menu and the enabled-column click.
    function toggleRunPlanEnabled(rec) {
      var isPlan = !!rec.isPlan;
      var planId = isPlan ? rec.id : rec.parentId;
      var stepId = isPlan ? null : rec.stepId;
      dispatchActionAsync('RUN_PLAN_GET', { id: planId }).then(function (resp) {
        if (!resp || !resp.success) return;
        var plan = resp.plan;
        var payload;
        if (isPlan) {
          payload = {
            id: plan.id, name: plan.name, description: plan.description,
            enabled: !plan.enabled, steps: plan.steps,
          };
        } else {
          var patchedSteps = plan.steps.map(function (s) {
            if (s.id !== stepId) return s;
            return Object.assign({}, s, { enabled: s.enabled === false ? true : false });
          });
          payload = {
            id: plan.id, name: plan.name, description: plan.description,
            enabled: plan.enabled, steps: patchedSteps,
          };
        }
        dispatchActionAsync('RUN_PLAN_SAVE', payload).then(function () {
          var t = resolveRef('runPlansTree');
          if (t) t.invalidateCache();
        });
      });
    }

    // Click on the enabled column cell toggles the boolean directly.
    // canEdit is false on the tree, so checkboxes are decorative — we have to
    // route the click ourselves rather than rely on inline edit.
    runPlansTree.recordClick = function (viewer, record, recordNum, field) {
      if (!record || !field) return;
      if (field.name === 'enabled') {
        toggleRunPlanEnabled(record);
      }
    };

    // cellContextClick gets the right-clicked record directly — no race with
    // selection state like showContextMenu had.
    runPlansTree.cellContextClick = function (rec) {
      if (!rec) {
        // Right-click on empty area — give a "New Plan" affordance only
        var newOnlyMenu = isc.Menu.create({
          autoDraw: false,
          data: [{ title: 'New Plan...', click: function () { showNewRunPlanDialog(); } }],
        });
        newOnlyMenu.showContextMenu();
        return false;
      }
      var isPlan = !!rec.isPlan;
      var planId = isPlan ? rec.id : rec.parentId;
      var stepId = isPlan ? null : rec.stepId;
      var items = [];
      if (isPlan) {
        items.push({
          title: 'Run Plan',
          click: function () {
            dispatchActionAsync('RUN_PLAN_EXECUTE', { id: planId }).then(function (resp) {
              if (resp && resp.success) isc.say('Plan started: runId=' + resp.runId + ' (' + resp.stepsToRun + ' steps)');
              else isc.warn('Run failed: ' + (resp && resp.error ? resp.error : 'unknown'));
            });
          },
        });
        items.push({
          title: 'Edit Plan...',
          click: function () {
            dispatchActionAsync('RUN_PLAN_GET', { id: planId }).then(function (resp) {
              if (resp && resp.success && resp.plan) showNewRunPlanDialog(resp.plan);
              else isc.warn('Could not load plan: ' + (resp && resp.error || 'not found'));
            });
          },
        });
        items.push({
          title: rec.enabled ? 'Disable' : 'Enable',
          click: function () { toggleRunPlanEnabled(rec); },
        });
        items.push({ isSeparator: true });
        items.push({
          title: 'Delete Plan...',
          click: function () {
            isc.ask('Delete plan "' + rec.name + '"?', function (ok) {
              if (!ok) return;
              dispatchActionAsync('RUN_PLAN_DELETE', { id: planId }).then(function () {
                var t = resolveRef('runPlansTree');
                if (t) t.invalidateCache();
              });
            });
          },
        });
        items.push({ isSeparator: true });
        items.push({ title: 'New Plan...', click: function () { showNewRunPlanDialog(); } });
      } else {
        // Step row
        items.push({
          title: 'Edit Step Args...',
          click: function () { showEditStepArgsDialog(planId, stepId); },
        });
        items.push({
          title: rec.enabled ? 'Disable Step' : 'Enable Step',
          click: function () { toggleRunPlanEnabled(rec); },
        });
        items.push({ isSeparator: true });
        items.push({
          title: 'Edit Parent Plan...',
          click: function () {
            dispatchActionAsync('RUN_PLAN_GET', { id: planId }).then(function (resp) {
              if (resp && resp.success && resp.plan) showNewRunPlanDialog(resp.plan);
            });
          },
        });
        items.push({
          title: 'Run Parent Plan',
          click: function () {
            dispatchActionAsync('RUN_PLAN_EXECUTE', { id: planId }).then(function (resp) {
              if (resp && resp.success) isc.say('Plan started');
              else isc.warn('Run failed: ' + (resp && resp.error ? resp.error : 'unknown'));
            });
          },
        });
      }
      var menu = isc.Menu.create({ autoDraw: false, data: items });
      menu.showContextMenu();
      return false;  // suppress browser native menu
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
