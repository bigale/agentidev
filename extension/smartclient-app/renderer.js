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
  'ForgeListGrid', 'ForgeWizard', 'ForgeFilterBar',
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
            var record = source.getSelectedRecord();
            if (!record) {
              console.warn('[Renderer] No record selected in', node._payloadFrom, '— skipping', node._messageType);
              return;
            }
            Object.assign(payload, record);
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
  'scriptStep': function (component, node) {
    component.click = function () {
      var ds = window._dashState;
      if (!ds) return;
      var sid = ds.selectedScript
        ? (ds.selectedScript.scriptId || ds.selectedScript.id)
        : ds.selectedScriptId;
      if (!sid) return;
      var clearAll = (node._messagePayload && node._messagePayload.clearAll) || false;
      // V8 line-level pause: use DBG commands instead of checkpoint SCRIPT_STEP
      if (ds.v8Paused) {
        var msgType = clearAll ? 'DBG_CONTINUE' : 'DBG_STEP_OVER';
        dispatchAction(msgType, { scriptId: sid, pid: ds.v8Pid });
      } else {
        dispatchAction('SCRIPT_STEP', { scriptId: sid, clearAll: clearAll });
      }
    };
  },
  'v8Step': function (component, node) {
    component.click = function () {
      var sid = window._dashState && (window._dashState.selectedScript
        ? (window._dashState.selectedScript.scriptId || window._dashState.selectedScript.id)
        : window._dashState.selectedScriptId);
      var pid = window._dashState && window._dashState.v8Pid;
      if (!sid) return;
      dispatchAction(node._messageType, { scriptId: sid, pid: pid });
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
  'newSession': function (component) {
    // Wired dynamically in dashboard-app.js loadDashboard()
  },
  'newSchedule': function (component) {
    // Wired dynamically in dashboard-app.js loadDashboard()
  },
  'editSchedule': function (component) {
    // Wired dynamically in dashboard-app.js loadDashboard()
  },
  'debugLaunch': function (component) {
    // Wired dynamically in dashboard-app.js loadDashboard()
  },
  'evalExpression': function (component) {
    // Wired dynamically in dashboard-app.js loadDashboard()
  },
  'idbSync': function (component) {
    // Wired dynamically in dashboard-app.js loadDashboard()
  },
  // ---- Client-side compute action ----
  // Reads form values, evaluates safe math expressions, writes results back.
  // Supports _scheduleType:"amortization" to populate a target grid.
  'compute': function (component, node) {
    component.click = function () {
      var form = resolveRef(node._sourceForm || node._targetForm);
      if (!form) { console.warn('[Renderer] compute: no source form'); return; }
      var vals = form.getValues();

      // Evaluate _formulas: { targetFieldName: "expression" }
      if (node._formulas) {
        var computed = {};
        for (var field in node._formulas) {
          computed[field] = _safeEval(node._formulas[field], vals, computed);
        }
        var targetForm = resolveRef(node._targetForm);
        if (targetForm) {
          for (var f in computed) {
            targetForm.setValue(f, Math.round(computed[f] * 100) / 100);
          }
        }
        // Merge computed into vals for schedule generation
        for (var k in computed) vals[k] = computed[k];
      }

      // Generate amortization schedule if requested
      if (node._scheduleType === 'amortization') {
        var grid = resolveRef(node._targetGrid);
        if (grid) {
          var P = Number(vals[node._principalField || 'loanAmount']) || 0;
          var annualRate = Number(vals[node._rateField || 'annualRate']) || 0;
          var years = Number(vals[node._termField || 'termYears']) || 0;
          var r = annualRate / 100 / 12;
          var n = years * 12;
          var monthly = r > 0 ? P * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1) : (n > 0 ? P / n : 0);
          var schedule = [];
          var balance = P;
          for (var i = 1; i <= n; i++) {
            var interest = balance * r;
            var principal = monthly - interest;
            balance -= principal;
            if (balance < 0) balance = 0;
            var dt = new Date();
            dt.setMonth(dt.getMonth() + i);
            schedule.push({
              id: i,
              number: i,
              date: (dt.getMonth() + 1) + '/' + dt.getFullYear(),
              payment: Math.round(monthly * 100) / 100,
              principal: Math.round(principal * 100) / 100,
              interest: Math.round(interest * 100) / 100,
              balance: Math.round(balance * 100) / 100,
            });
          }
          grid.setData(schedule);
        }
      }
    };
  },
  // Clear form fields
  'clear': function (component, node) {
    component.click = function () {
      var form = resolveRef(node._targetForm);
      if (form) form.clearValues();
      var grid = resolveRef(node._targetGrid);
      if (grid) grid.setData([]);
    };
  },
};

// ---- Safe expression evaluator (no eval, no Function) ----
// Supports: numbers, field names, +, -, *, /, **, Math.pow/round/floor/ceil/abs/min/max
function _safeEval(expr, vars, computed) {
  var all = {};
  for (var k in vars) all[k] = Number(vars[k]) || 0;
  for (var c in computed) all[c] = Number(computed[c]) || 0;

  var pos = 0;
  var str = String(expr).replace(/\s+/g, '');

  function peek() { return str[pos]; }
  function advance() { return str[pos++]; }
  function isDigit(ch) { return ch >= '0' && ch <= '9'; }
  function isAlpha(ch) { return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_'; }

  function parseNumber() {
    var s = pos;
    while (pos < str.length && (isDigit(str[pos]) || str[pos] === '.')) pos++;
    return parseFloat(str.slice(s, pos));
  }

  function parseIdent() {
    var s = pos;
    while (pos < str.length && (isAlpha(str[pos]) || isDigit(str[pos]))) pos++;
    return str.slice(s, pos);
  }

  function parsePrimary() {
    var ch = peek();
    if (ch === '(') { advance(); var v = parseAddSub(); advance(); return v; }
    if (ch === '-') { advance(); return -parsePrimary(); }
    if (isDigit(ch) || ch === '.') return parseNumber();
    if (isAlpha(ch)) {
      var name = parseIdent();
      if (name === 'Math' && peek() === '.') {
        advance(); // '.'
        var fn = parseIdent();
        if (peek() === '(') {
          advance(); // '('
          var args = [parseAddSub()];
          while (peek() === ',') { advance(); args.push(parseAddSub()); }
          advance(); // ')'
          if (typeof Math[fn] === 'function') return Math[fn].apply(null, args);
          return NaN;
        }
        return typeof Math[fn] === 'number' ? Math[fn] : NaN;
      }
      // Check for function-like call: pow(x, y)
      if (peek() === '(' && typeof Math[name] === 'function') {
        advance();
        var a2 = [parseAddSub()];
        while (peek() === ',') { advance(); a2.push(parseAddSub()); }
        advance();
        return Math[name].apply(null, a2);
      }
      return all.hasOwnProperty(name) ? all[name] : 0;
    }
    return 0;
  }

  function parsePower() {
    var left = parsePrimary();
    while (pos + 1 < str.length && str[pos] === '*' && str[pos + 1] === '*') {
      pos += 2; left = Math.pow(left, parsePrimary());
    }
    return left;
  }

  function parseMulDiv() {
    var left = parsePower();
    while (peek() === '*' || peek() === '/') {
      var op = advance();
      left = op === '*' ? left * parsePower() : left / parsePower();
    }
    return left;
  }

  function parseAddSub() {
    var left = parseMulDiv();
    while (peek() === '+' || peek() === '-') {
      var op = advance();
      left = op === '+' ? left + parseMulDiv() : left - parseMulDiv();
    }
    return left;
  }

  try { return parseAddSub(); }
  catch (e) { console.warn('[Renderer] Formula error:', expr, e); return NaN; }
}

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

function createComponent(node, nodePath) {
  if (!node || !node._type) return null;

  // Attach path for inspector click-to-select
  if (nodePath) node._nodePath = nodePath;

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
    if (key === 'members' || key === 'portlets' || key === 'tabs') continue;
    config[key] = node[key];
  }

  // Apply _formatter to ListGrid/ForgeListGrid fields
  if ((type === 'ListGrid' || type === 'ForgeListGrid') && Array.isArray(config.fields)) {
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
      var childPath = (nodePath || 'layout') + '.members[' + i + ']';
      var child = createComponent(node.members[i], childPath);
      if (child) config.members.push(child);
    }
  }

  // TabSet: create each tab's pane through createComponent so components get registered
  if (type === 'TabSet' && Array.isArray(node.tabs)) {
    config.tabs = node.tabs.map(function (tab, tabIdx) {
      var tabCfg = {};
      for (var k in tab) {
        if (k !== 'pane') tabCfg[k] = tab[k];
      }
      if (tab.pane) {
        var panePath = (nodePath || 'layout') + '.tabs[' + tabIdx + '].pane';
        tabCfg.pane = tab.pane._type ? createComponent(tab.pane, panePath) : tab.pane;
      }
      return tabCfg;
    });
  }

  // Create the component
  var component = isc[type].create(config);

  // PortalLayout: create and place portlets after layout exists
  if (type === 'PortalLayout' && Array.isArray(node.portlets)) {
    for (var p = 0; p < node.portlets.length; p++) {
      var pNode = node.portlets[p];
      var col = pNode._column || 0;
      var row = pNode._row || 0;
      var portletPath = (nodePath || 'layout') + '.portlets[' + p + ']';
      var portlet = createComponent(pNode, portletPath);
      if (portlet) component.addPortlet(portlet, col, row);
    }
  }

  // Register by ID for cross-references
  if (node.ID) {
    componentRegistry[node.ID] = component;
  }

  // Wire actions after creation (needs component reference)
  wireAction(component, node);

  // Inspector click-to-select: attach mouseDown handler for components with IDs
  if (node.ID && component.addProperties && node._nodePath) {
    (function (nodePath) {
      component.addProperties({
        mouseDown: function () {
          if (typeof InspectorUI !== 'undefined' && InspectorUI.isVisible()) {
            InspectorUI.selectByPath(nodePath);
          }
          return true; // allow default SC handling to continue
        },
      });
    })(node._nodePath);
  }

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

// ---- Capabilities: skin picker ToolStrip ----

var SKIN_LIST = [
  'Tahoe', 'Obsidian', 'Graphite', 'Stratus', 'Simplicity', 'SilverWave',
  'Enterprise', 'EnterpriseBlue', 'Cascade', 'TreeFrog', 'BlackOps',
  'Twilight', 'fleet', 'Cupertino', 'Shiva', 'ShivaBlue', 'ShivaDark',
  'Mobile', 'SmartClient',
];

function createCapabilitiesBar(options) {
  var members = [];

  if (options.capabilities && options.capabilities.skinPicker) {
    var currentSkin = options.skin || (typeof _skinName !== 'undefined' ? _skinName : 'Tahoe');

    var valueMap = {};
    for (var i = 0; i < SKIN_LIST.length; i++) {
      valueMap[SKIN_LIST[i]] = SKIN_LIST[i];
    }

    var skinForm = isc.DynamicForm.create({
      width: 180,
      numCols: 2,
      colWidths: [40, '*'],
      fields: [{
        name: 'skin',
        title: 'Skin',
        editorType: 'SelectItem',
        valueMap: valueMap,
        defaultValue: currentSkin,
        width: 130,
        changed: function (form, item, value) {
          window.parent.postMessage({ source: 'smartclient-skin-change', skin: value }, '*');
        },
      }],
    });
    members.push(skinForm);
  }

  if (members.length === 0) return null;

  var bar = isc.ToolStrip.create({
    width: '100%',
    height: 32,
    members: members,
  });
  generatedComponents.push(bar);
  return bar;
}

// ---- Entry point ----

function renderConfig(config, options) {
  clearGeneratedUI();

  options = options || {};

  // Create DataSources first
  if (config.dataSources) {
    for (var i = 0; i < config.dataSources.length; i++) {
      createDataSource(config.dataSources[i]);
    }
  }

  // Create component tree
  var mainLayout = null;
  if (config.layout) {
    mainLayout = createComponent(config.layout, 'layout');
  }

  // Inject capabilities bar if enabled
  var capBar = createCapabilitiesBar(options);
  if (capBar && mainLayout) {
    var wrapper = isc.VLayout.create({
      width: '100%',
      height: '100%',
      members: [capBar, mainLayout],
    });
    generatedComponents.push(wrapper);
    // Ensure original layout fills remaining space
    mainLayout.setHeight('*');
  }

  // Deferred cross-reference resolution (for components that reference others by ID)
  for (var i = 0; i < generatedComponents.length; i++) {
    var comp = generatedComponents[i];
    if (!comp || comp.destroyed) continue;

    // ForgeFilterBar: resolve targetGrid string to live reference
    if (comp.getClassName && comp.getClassName() === 'ForgeFilterBar' && typeof comp.targetGrid === 'string') {
      var gridRef = resolveRef(comp.targetGrid);
      if (gridRef) {
        comp.targetGrid = gridRef;
      }
    }
  }

  // A11y enhancement pass
  if (typeof Agentiface !== 'undefined' && Agentiface.A11y) {
    for (var j = 0; j < generatedComponents.length; j++) {
      Agentiface.A11y.enhance(generatedComponents[j]);
    }
  }

  console.log('[Renderer] Created', generatedComponents.length, 'components,',
    generatedDataSources.length, 'dataSources');
}
