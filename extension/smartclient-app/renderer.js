/**
 * SmartClient AI Renderer — walks LLM-generated JSON config trees
 * and creates SmartClient components. No eval of LLM output.
 *
 * LLM generates action descriptors (_action), renderer maps them
 * to real SmartClient function calls via ACTION_MAP.
 */

// Only these SmartClient types can be instantiated
const ALLOWED_TYPES = new Set([
  'VLayout', 'HLayout', 'ListGrid', 'DynamicForm', 'Button', 'Label',
  'TabSet', 'Tab', 'DetailViewer', 'SectionStack', 'HTMLFlow',
  'Window', 'ToolStrip', 'ToolStripButton',
  'PortalLayout', 'Portlet', 'Canvas', 'Progressbar', 'ImgButton',
  'ToolStripSeparator', 'ToolStripMenuButton', 'Menu',
]);

// Track created components for cleanup
let generatedComponents = [];
let generatedDataSources = [];

// Resolve a component ID from the current render batch
const componentRegistry = {};

function resolveRef(id) {
  return componentRegistry[id] || (typeof window[id] !== 'undefined' ? window[id] : null);
}

// ---- Dispatch bridge action via postMessage ----

var _actionCounter = 0;

function dispatchAction(messageType, payload) {
  window.parent.postMessage({
    source: 'smartclient-action',
    id: ++_actionCounter,
    messageType: messageType,
    payload: payload || {},
  }, '*');
}

// ---- Cell formatters ----

var FORMATTERS = {
  stateDot: function (value) {
    var colors = {
      running: '#4CAF50', paused: '#FF9800', checkpoint: '#FF9800',
      complete: '#2196F3', cancelled: '#9E9E9E', killed: '#f44336',
      error: '#f44336', registered: '#00BCD4',
    };
    var color = colors[value] || '#666';
    return '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:'
      + color + ';margin-right:6px;"></span>' + (value || '');
  },
  timestamp: function (value) {
    if (!value) return '';
    var d = new Date(value);
    var h = d.getHours().toString().padStart(2, '0');
    var m = d.getMinutes().toString().padStart(2, '0');
    var s = d.getSeconds().toString().padStart(2, '0');
    return h + ':' + m + ':' + s;
  },
  elapsed: function (value) {
    if (!value) return '';
    var now = Date.now();
    var ms = now - new Date(value).getTime();
    if (ms < 60000) return Math.round(ms / 1000) + 's ago';
    if (ms < 3600000) return Math.round(ms / 60000) + 'm ago';
    return Math.round(ms / 3600000) + 'h ago';
  },
  progressBar: function (value, record) {
    var step = record ? (record.step || 0) : 0;
    var total = record ? (record.totalSteps || 1) : 1;
    var pct = Math.round((step / total) * 100);
    return '<div style="background:#333;border-radius:3px;height:14px;width:100%;">'
      + '<div style="background:#4CAF50;height:100%;border-radius:3px;width:' + pct + '%;"></div></div>';
  },
};

// ---- Action wiring ----

var ACTION_MAP = {
  'new': function (component, node) {
    component.click = function () {
      var form = resolveRef(node._targetForm);
      if (form) form.editNewRecord();
    };
  },
  'save': function (component, node) {
    component.click = function () {
      var form = resolveRef(node._targetForm);
      var grid = resolveRef(node._targetGrid);
      if (form) {
        form.saveData(function (resp) {
          if (resp.status === 0 && grid) grid.invalidateCache();
        });
      }
    };
  },
  'delete': function (component, node) {
    component.click = function () {
      var grid = resolveRef(node._targetGrid);
      if (!grid) return;
      var record = grid.getSelectedRecord();
      if (record) {
        var ds = grid.getDataSource();
        ds.removeData(record, function () {
          var form = resolveRef(node._targetForm);
          if (form) form.clearValues();
          grid.invalidateCache();
        });
      }
    };
  },
  'select': function (component, node) {
    component.recordClick = function (viewer, record) {
      var form = resolveRef(node._targetForm);
      if (form) form.editRecord(record);
    };
  },
  'dispatch': function (component, node) {
    component.click = function () {
      var payload = Object.assign({}, node._messagePayload || {});
      if (node._payloadFrom) {
        var source = resolveRef(node._payloadFrom);
        if (source) {
          if (source.getSelectedRecord) {
            Object.assign(payload, source.getSelectedRecord() || {});
          } else if (source.getValues) {
            Object.assign(payload, source.getValues() || {});
          }
        }
      }
      dispatchAction(node._messageType, payload);
    };
  },
  'scriptPause': function (component, node) {
    component.click = function () {
      var grid = resolveRef(node._targetGrid);
      var record = grid && grid.getSelectedRecord();
      if (record) dispatchAction('SCRIPT_PAUSE', { scriptId: record.id });
    };
  },
  'scriptResume': function (component, node) {
    component.click = function () {
      var grid = resolveRef(node._targetGrid);
      var record = grid && grid.getSelectedRecord();
      if (record) dispatchAction('SCRIPT_RESUME', { scriptId: record.id });
    };
  },
  'scriptCancel': function (component, node) {
    component.click = function () {
      var grid = resolveRef(node._targetGrid);
      var record = grid && grid.getSelectedRecord();
      if (record) {
        var payload = Object.assign(
          { scriptId: record.id, reason: 'Cancelled from SC dashboard' },
          node._messagePayload || {}
        );
        dispatchAction('SCRIPT_CANCEL', payload);
      }
    };
  },
  'bridgeConnect': function (component) {
    component.click = function () {
      dispatchAction('BRIDGE_CONNECT', { port: 9876 });
    };
  },
  'bridgeDisconnect': function (component) {
    component.click = function () {
      dispatchAction('BRIDGE_DISCONNECT', {});
    };
  },
  'debugLaunch': function (component) {
    // Wired dynamically in dashboard-app.js loadDashboard()
  },
  'evalExpression': function (component) {
    // Wired dynamically in dashboard-app.js loadDashboard()
  },
};

function wireAction(component, node) {
  var action = node._action;
  if (!action) return;
  var handler = ACTION_MAP[action];
  if (handler) {
    handler(component, node);
  } else {
    console.warn('[Renderer] Unknown action:', action);
  }
}

// ---- DataSource creation ----

function createDataSource(dsConfig) {
  var ds = isc.DataSource.create({
    ID: dsConfig.ID,
    dataProtocol: 'clientCustom',
    fields: dsConfig.fields,
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
  generatedDataSources.push(ds);
  return ds;
}

// ---- Recursive component creation ----

function createComponent(node) {
  if (!node || !node._type) return null;

  var type = node._type;
  if (!ALLOWED_TYPES.has(type)) {
    console.warn('[Renderer] Blocked type:', type);
    return null;
  }

  if (!isc[type]) {
    console.warn('[Renderer] Unknown SmartClient class:', type);
    return null;
  }

  // Build config — strip _-prefixed meta keys
  var config = {};
  for (var key in node) {
    if (key.charAt(0) === '_') continue;
    if (key === 'members' || key === 'portlets') continue;
    config[key] = node[key];
  }

  // Apply _formatter to ListGrid fields
  if (type === 'ListGrid' && Array.isArray(config.fields)) {
    config.fields = config.fields.map(function (field) {
      if (field._formatter && FORMATTERS[field._formatter]) {
        var fn = FORMATTERS[field._formatter];
        return Object.assign({}, field, {
          formatCellValue: function (value, record) { return fn(value, record); },
          _formatter: undefined,
        });
      }
      return field;
    });
  }

  // Recursively create members (skip for PortalLayout — uses portlets instead)
  if (Array.isArray(node.members) && type !== 'PortalLayout') {
    config.members = [];
    for (var i = 0; i < node.members.length; i++) {
      var child = createComponent(node.members[i]);
      if (child) config.members.push(child);
    }
  }

  // Create the component
  var component = isc[type].create(config);

  // PortalLayout: create and place portlets after layout exists
  if (type === 'PortalLayout' && Array.isArray(node.portlets)) {
    for (var p = 0; p < node.portlets.length; p++) {
      var pNode = node.portlets[p];
      var col = pNode._column || 0;
      var row = pNode._row || 0;
      var portlet = createComponent(pNode);
      if (portlet) component.addPortlet(portlet, col, row);
    }
  }

  // Register by ID for cross-references
  if (node.ID) {
    componentRegistry[node.ID] = component;
  }

  // Wire actions after creation (needs component reference)
  wireAction(component, node);

  generatedComponents.push(component);
  return component;
}

// ---- Lifecycle ----

function clearGeneratedUI() {
  // Destroy components in reverse order
  for (var i = generatedComponents.length - 1; i >= 0; i--) {
    try {
      if (generatedComponents[i] && generatedComponents[i].destroy) {
        generatedComponents[i].destroy();
      }
    } catch (e) {
      // Component may already be destroyed by parent
    }
  }
  generatedComponents = [];

  // Destroy DataSources
  for (var j = generatedDataSources.length - 1; j >= 0; j--) {
    try {
      if (generatedDataSources[j] && generatedDataSources[j].destroy) {
        generatedDataSources[j].destroy();
      }
    } catch (e) {
      // ignore
    }
  }
  generatedDataSources = [];

  // Clear registry
  for (var key in componentRegistry) {
    delete componentRegistry[key];
  }
}

// ---- Real-time DS invalidation (SC-3) ----

var _dsDebounceTimers = {};

function invalidateDSCaches(dsId) {
  if (_dsDebounceTimers[dsId]) return;           // already scheduled
  _dsDebounceTimers[dsId] = setTimeout(function () {
    delete _dsDebounceTimers[dsId];
    var ds = isc.DataSource.get(dsId);
    if (!ds) return;
    for (var i = 0; i < generatedComponents.length; i++) {
      var comp = generatedComponents[i];
      if (comp && !comp.destroyed && comp.getDataSource
          && comp.getDataSource() === ds && comp.invalidateCache) {
        comp.invalidateCache();
      }
    }
  }, 500);
}

// ---- Entry point ----

function renderConfig(config) {
  clearGeneratedUI();

  // Create DataSources first
  if (config.dataSources) {
    for (var i = 0; i < config.dataSources.length; i++) {
      createDataSource(config.dataSources[i]);
    }
  }

  // Create component tree
  if (config.layout) {
    createComponent(config.layout);
  }

  console.log('[Renderer] Created', generatedComponents.length, 'components,',
    generatedDataSources.length, 'dataSources');
}
