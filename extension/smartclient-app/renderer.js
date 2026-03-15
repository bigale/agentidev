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
]);

// Track created components for cleanup
let generatedComponents = [];
let generatedDataSources = [];

// Resolve a component ID from the current render batch
const componentRegistry = {};

function resolveRef(id) {
  return componentRegistry[id] || (typeof window[id] !== 'undefined' ? window[id] : null);
}

// ---- Action wiring ----

function wireAction(component, node) {
  const action = node._action;
  const formId = node._targetForm;
  const gridId = node._targetGrid;

  if (!action) return;

  if (action === 'new') {
    component.click = function () {
      const form = resolveRef(formId);
      if (form) form.editNewRecord();
    };
  } else if (action === 'save') {
    component.click = function () {
      const form = resolveRef(formId);
      const grid = resolveRef(gridId);
      if (form) {
        form.saveData(function (resp) {
          if (resp.status === 0 && grid) grid.invalidateCache();
        });
      }
    };
  } else if (action === 'delete') {
    component.click = function () {
      const grid = resolveRef(gridId);
      if (!grid) return;
      var record = grid.getSelectedRecord();
      if (record) {
        var ds = grid.getDataSource();
        ds.removeData(record, function () {
          var form = resolveRef(formId);
          if (form) form.clearValues();
          grid.invalidateCache();
        });
      }
    };
  } else if (action === 'select') {
    // Wired on ListGrid — recordClick edits form
    component.recordClick = function (viewer, record) {
      var form = resolveRef(formId);
      if (form) form.editRecord(record);
    };
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
    if (key === 'members') continue;
    config[key] = node[key];
  }

  // Recursively create members
  if (Array.isArray(node.members)) {
    config.members = [];
    for (var i = 0; i < node.members.length; i++) {
      var child = createComponent(node.members[i]);
      if (child) config.members.push(child);
    }
  }

  // Create the component
  var component = isc[type].create(config);

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
