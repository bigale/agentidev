/**
 * SmartClient POC — Notes CRUD with IndexedDB via extension proxy.
 * Runs inside sandbox (eval allowed, no chrome.* APIs).
 * Communicates with wrapper.html via postMessage.
 *
 * AI integration: prompt bar sends descriptions to bridge server,
 * renderer.js creates SmartClient components from JSON configs.
 *
 * Phase 5b: Iterative workflow — tracks _currentConfig for modification mode,
 * prompt history with up/down arrow, save to bridge, undo to previous config.
 */

// Pending DS requests awaiting response
const pendingRequests = {};
let requestCounter = 0;

// ---- Iterative workflow state (Phase 5b) ----

var _currentConfig = null;     // Current rendered config (for modification mode)
var _currentAppId = null;      // Bridge app ID (set after save or load)
var _configHistory = [];       // Stack of previous configs for undo
var _promptHistory = [];       // All prompts in this session
var _promptHistoryIndex = -1;  // -1 = typing new, 0+ = browsing history

// ---- postMessage bridge ----

function sendDSRequest(dsRequest) {
  const id = ++requestCounter;
  return new Promise((resolve) => {
    pendingRequests[id] = resolve;
    window.parent.postMessage({
      source: 'smartclient-ds',
      id,
      operationType: dsRequest.operationType,
      dataSource: dsRequest.dataSource,
      data: dsRequest.data,
      criteria: dsRequest.criteria,
    }, '*');
  });
}

function sendAIRequest(prompt, currentConfig) {
  var msg = {
    source: 'smartclient-ai',
    prompt: prompt,
  };
  if (currentConfig) {
    msg.currentConfig = currentConfig;
  }
  window.parent.postMessage(msg, '*');
}

function sendAppAction(messageType, payload) {
  var id = ++requestCounter;
  return new Promise(function (resolve) {
    pendingRequests[id] = resolve;
    window.parent.postMessage({
      source: 'smartclient-action',
      id: id,
      messageType: messageType,
      payload: payload || {},
    }, '*');
  });
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg) return;

  // DS cache invalidation from bridge broadcasts
  if (msg.source === 'smartclient-ds-update') {
    invalidateDSCaches(msg.dataSource);
    return;
  }

  // Dashboard mode: action responses and broadcasts handled by dashboard-app.js
  if (msg.source === 'smartclient-action-response' || msg.source === 'smartclient-broadcast') {
    return;
  }

  // Dashboard mode: load dashboard layout
  if (msg.source === 'smartclient-load-dashboard') {
    if (typeof loadDashboard === 'function') loadDashboard();
    return;
  }

  // DS response
  if (msg.source === 'smartclient-ds-response' && pendingRequests[msg.id]) {
    pendingRequests[msg.id](msg);
    delete pendingRequests[msg.id];
    return;
  }

  // AI response
  if (msg.source === 'smartclient-ai-response') {
    handleAIResponse(msg);
  }
});

// ---- AI response handling ----

function handleAIResponse(msg) {
  var btn = document.getElementById('ai-generate');
  if (btn) btn.disabled = false;

  if (msg.success && msg.config) {
    setStatus('Rendering...');
    try {
      // Push current config to undo stack before replacing (already clean JSON)
      if (_currentConfig) {
        _configHistory.push(JSON.parse(JSON.stringify(_currentConfig)));
      }

      // Store clean JSON copy BEFORE rendering (SC mutates objects with functions)
      _currentConfig = JSON.parse(JSON.stringify(msg.config));

      clearNotesApp();
      renderConfig(msg.config);
      updateIterativeUI();
      setStatus('Done');
      setTimeout(function () { setStatus(''); }, 2000);
    } catch (err) {
      setStatus('Render error: ' + err.message);
      console.error('[App] Render error:', err);
    }
  } else {
    setStatus('Error: ' + (msg.error || 'Unknown error'));
    console.error('[App] AI error:', msg.error);
  }
}

function setStatus(text) {
  var el = document.getElementById('ai-status');
  if (el) el.textContent = text;
}

// ---- Iterative UI helpers ----

function updateIterativeUI() {
  var saveBtn = document.getElementById('ai-save');
  var undoBtn = document.getElementById('ai-undo');
  var genBtn = document.getElementById('ai-generate');

  if (saveBtn) saveBtn.style.display = _currentConfig ? '' : 'none';
  if (undoBtn) undoBtn.style.display = _configHistory.length > 0 ? '' : 'none';
  if (genBtn) genBtn.textContent = _currentConfig ? 'Modify' : 'Generate';
}

function handleUndo() {
  if (_configHistory.length === 0) return;
  var prevConfig = _configHistory.pop();
  clearNotesApp();
  renderConfig(prevConfig);
  _currentConfig = prevConfig;
  updateIterativeUI();
  setStatus('Undone');
  setTimeout(function () { setStatus(''); }, 1500);
}

function handleSave() {
  if (!_currentConfig) return;
  setStatus('Saving...');

  var name = _promptHistory.length > 0 ? _promptHistory[0] : 'Untitled App';
  if (name.length > 40) name = name.slice(0, 40).replace(/\s+\S*$/, '') + '...';

  var appData = {
    name: name,
    config: _currentConfig,
    prompt: _promptHistory[_promptHistory.length - 1] || '',
    history: _promptHistory.map(function (p) {
      return { prompt: p, timestamp: Date.now() };
    }),
  };
  if (_currentAppId) appData.id = _currentAppId;

  sendAppAction('AF_APP_SAVE', appData).then(function (resp) {
    if (resp && resp.response && resp.response.success) {
      _currentAppId = resp.response.app.id;
      setStatus('Saved');
    } else {
      setStatus('Save failed: ' + ((resp && resp.response && resp.response.error) || 'unknown'));
    }
    setTimeout(function () { setStatus(''); }, 2000);
  });
}

// Track Notes app components for cleanup when AI generates new UI
var notesAppComponents = [];

function clearNotesApp() {
  for (var i = notesAppComponents.length - 1; i >= 0; i--) {
    try {
      if (notesAppComponents[i] && notesAppComponents[i].destroy) {
        notesAppComponents[i].destroy();
      }
    } catch (e) { /* already destroyed by parent */ }
  }
  notesAppComponents = [];
  // Also destroy the DataSource
  try {
    var ds = isc.DataSource.get('NotesDS');
    if (ds) ds.destroy();
  } catch (e) { /* ignore */ }
}

// ---- Default Notes app ----

function loadNotesApp() {
  isc.DataSource.create({
    ID: 'NotesDS',
    dataProtocol: 'clientCustom',
    fields: [
      { name: 'id',        type: 'integer', primaryKey: true, hidden: true },
      { name: 'title',     type: 'text',    required: true,   title: 'Title',   length: 200 },
      { name: 'content',   type: 'text',    title: 'Content', length: 4000 },
      { name: 'createdAt', type: 'datetime', title: 'Created', canEdit: false },
    ],
    transformRequest: function (dsRequest) {
      sendDSRequest(dsRequest).then(function (resp) {
        this.processResponse(dsRequest.requestId, {
          status: resp.status || 0,
          data: resp.data,
          totalRows: resp.totalRows,
        });
      }.bind(this));
    },
  });

  isc.ListGrid.create({
    ID: 'notesGrid',
    width: '100%',
    height: '*',
    dataSource: 'NotesDS',
    autoFetchData: true,
    canEdit: false,
    selectionType: 'single',
    fields: [
      { name: 'title',     width: '*' },
      { name: 'createdAt', width: 180 },
    ],
    recordClick: function (viewer, record) {
      notesForm.editRecord(record);
    },
  });

  isc.DynamicForm.create({
    ID: 'notesForm',
    width: '100%',
    dataSource: 'NotesDS',
    numCols: 2,
    colWidths: [120, '*'],
    fields: [
      { name: 'title',   editorType: 'TextItem' },
      { name: 'content', editorType: 'TextAreaItem', height: 100 },
    ],
  });

  isc.HLayout.create({
    ID: 'buttonBar',
    height: 30,
    membersMargin: 8,
    members: [
      isc.Button.create({
        title: 'New',
        width: 80,
        click: function () {
          notesForm.editNewRecord();
        },
      }),
      isc.Button.create({
        title: 'Save',
        width: 80,
        click: function () {
          notesForm.saveData(function (resp, data) {
            if (resp.status === 0) {
              notesGrid.invalidateCache();
            }
          });
        },
      }),
      isc.Button.create({
        title: 'Delete',
        width: 80,
        click: function () {
          var record = notesGrid.getSelectedRecord();
          if (record) {
            NotesDS.removeData(record, function () {
              notesForm.clearValues();
              notesGrid.invalidateCache();
            });
          }
        },
      }),
    ],
  });

  var mainLayout = isc.VLayout.create({
    width: '100%',
    height: '100%',
    members: [notesGrid, notesForm, buttonBar],
    membersMargin: 8,
    layoutMargin: 12,
  });

  notesAppComponents.push(mainLayout);
}

// ---- Prompt bar event handlers ----

function initPromptBar() {
  var input = document.getElementById('ai-prompt');
  var genBtn = document.getElementById('ai-generate');
  var saveBtn = document.getElementById('ai-save');
  var undoBtn = document.getElementById('ai-undo');

  if (!input || !genBtn) return;

  genBtn.addEventListener('click', function () {
    var prompt = input.value.trim();
    if (!prompt) return;
    genBtn.disabled = true;
    setStatus(_currentConfig ? 'Modifying...' : 'Generating...');

    // Record prompt in history
    _promptHistory.push(prompt);
    _promptHistoryIndex = -1;

    // Send with currentConfig for modification mode
    sendAIRequest(prompt, _currentConfig);
    input.value = '';
  });

  if (saveBtn) {
    saveBtn.addEventListener('click', handleSave);
  }

  if (undoBtn) {
    undoBtn.addEventListener('click', handleUndo);
  }

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      genBtn.click();
      return;
    }

    // Up arrow: browse prompt history
    if (e.key === 'ArrowUp' && _promptHistory.length > 0) {
      e.preventDefault();
      if (_promptHistoryIndex === -1) {
        _promptHistoryIndex = _promptHistory.length - 1;
      } else if (_promptHistoryIndex > 0) {
        _promptHistoryIndex--;
      }
      input.value = _promptHistory[_promptHistoryIndex];
    }

    // Down arrow: browse prompt history
    if (e.key === 'ArrowDown' && _promptHistoryIndex >= 0) {
      e.preventDefault();
      if (_promptHistoryIndex < _promptHistory.length - 1) {
        _promptHistoryIndex++;
        input.value = _promptHistory[_promptHistoryIndex];
      } else {
        _promptHistoryIndex = -1;
        input.value = '';
      }
    }
  });

  // Initialize button states
  updateIterativeUI();
}

// ---- Wait for SmartClient framework ----

isc.Page.setEvent('load', function () {
  // Load default Notes app
  loadNotesApp();

  // Bind prompt bar
  initPromptBar();
});
