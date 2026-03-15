/**
 * SmartClient POC — Notes CRUD with IndexedDB via extension proxy.
 * Runs inside sandbox (eval allowed, no chrome.* APIs).
 * Communicates with wrapper.html via postMessage.
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

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg && msg.source === 'smartclient-ds-response' && pendingRequests[msg.id]) {
    pendingRequests[msg.id](msg);
    delete pendingRequests[msg.id];
  }
});

// ---- Wait for SmartClient framework ----

isc.Page.setEvent('load', function () {

  // ---- DataSource ----

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
      sendDSRequest(dsRequest).then((resp) => {
        this.processResponse(dsRequest.requestId, {
          status: resp.status || 0,
          data: resp.data,
          totalRows: resp.totalRows,
        });
      });
    },
  });

  // ---- UI Components ----

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

  isc.VLayout.create({
    width: '100%',
    height: '100%',
    members: [notesGrid, notesForm, buttonBar],
    membersMargin: 8,
    layoutMargin: 12,
  });

});
