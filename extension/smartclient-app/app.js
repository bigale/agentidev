/**
 * SmartClient POC — Notes CRUD with IndexedDB via extension proxy.
 * Runs inside sandbox (eval allowed, no chrome.* APIs).
 * Communicates with wrapper.html via postMessage.
 *
 * AI-generated configs arrive via postMessage from bridge.js (sidepanel controls
 * generation, save, undo — no prompt bar in this iframe).
 */

// Pending DS requests awaiting response
const pendingRequests = {};
let requestCounter = 0;

// Current rendered config (updated when sidepanel broadcasts new configs)
var _currentConfig = null;

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

  // Inspector mode toggle from sidepanel via bridge
  if (msg.source === 'smartclient-set-mode') {
    if (typeof InspectorUI !== 'undefined') {
      if (msg.mode === 'visual' && !InspectorUI.isVisible()) {
        InspectorUI.toggle();
      } else if (msg.mode === 'render' && InspectorUI.isVisible()) {
        InspectorUI.toggle();
      }
    }
    return;
  }

  // Component selected in canvas (from renderer click handlers)
  if (msg.source === 'smartclient-component-selected') {
    if (typeof InspectorUI !== 'undefined') {
      InspectorUI.selectByPath(msg.nodePath);
    }
    return;
  }

  // Template request from bridge.js — look up bundled template config
  if (msg.source === 'smartclient-get-template') {
    var tplId = msg.templateId;
    var tpl = null;
    if (typeof Agentiface !== 'undefined' && Agentiface.TemplateManager) {
      tpl = Agentiface.TemplateManager.getById(tplId);
    }
    window.parent.postMessage({
      source: 'smartclient-template-response',
      templateId: tplId,
      config: tpl ? tpl.config : null,
      aiSystemPrompt: tpl ? tpl.aiSystemPrompt : null,
      suggestedPrompts: tpl ? tpl.suggestedPrompts : null,
    }, '*');
    return;
  }
});

// ---- AI response handling ----

function handleAIResponse(msg) {
  if (msg.success && msg.config) {
    try {
      // Store clean JSON copy BEFORE rendering (SC mutates objects with functions)
      _currentConfig = JSON.parse(JSON.stringify(msg.config));

      clearNotesApp();
      renderConfig(msg.config, {
        capabilities: msg.capabilities,
        skin: typeof _skinName !== 'undefined' ? _skinName : 'Tahoe',
      });
      console.log('[App] Config rendered');

      // Refresh inspector tree if visible
      if (typeof InspectorUI !== 'undefined' && InspectorUI.isVisible()) {
        InspectorUI.refresh();
      }
    } catch (err) {
      console.error('[App] Render error:', err);
    }
  } else {
    console.error('[App] AI error:', msg.error);
  }
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

// ---- Wait for SmartClient framework ----

isc.Page.setEvent('load', function () {
  // Only load default Notes app if no AI config was already rendered
  // (playground mode may deliver config via postMessage before Page.load fires)
  if (!_currentConfig) {
    loadNotesApp();
  }

  // Initialize inspector (hidden by default)
  if (typeof InspectorUI !== 'undefined') {
    InspectorUI.init();
  }

  // Signal readiness to bridge.js so it can send buffered configs
  window.parent.postMessage({ source: 'smartclient-ready' }, '*');
});
