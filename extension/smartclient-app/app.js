/**
 * SmartClient POC — Notes CRUD with IndexedDB via extension proxy.
 * Runs inside sandbox (eval allowed, no chrome.* APIs).
 * Communicates with wrapper.html via postMessage.
 *
 * AI integration: prompt bar sends descriptions to Gemini Nano,
 * renderer.js creates SmartClient components from JSON configs.
 */

// Pending DS requests awaiting response
const pendingRequests = {};
let requestCounter = 0;

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

function sendAIRequest(prompt) {
  window.parent.postMessage({
    source: 'smartclient-ai',
    prompt: prompt,
  }, '*');
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg) return;

  // DS cache invalidation from bridge broadcasts
  if (msg.source === 'smartclient-ds-update') {
    invalidateDSCaches(msg.dataSource);
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
      clearNotesApp();
      renderConfig(msg.config);
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
  var btn = document.getElementById('ai-generate');

  if (!input || !btn) return;

  btn.addEventListener('click', function () {
    var prompt = input.value.trim();
    if (!prompt) return;
    btn.disabled = true;
    setStatus('Generating...');
    sendAIRequest(prompt);
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      btn.click();
    }
  });
}

// ---- Wait for SmartClient framework ----

isc.Page.setEvent('load', function () {
  // Load default Notes app
  loadNotesApp();

  // Bind prompt bar
  initPromptBar();
});
