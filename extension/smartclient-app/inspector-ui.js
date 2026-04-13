/**
 * inspector-ui.js — SmartClient-based visual inspector for Agentiface configs.
 *
 * Runs inside the sandbox iframe (app.html). Provides:
 *  - Collapsible left panel with component tree + property editor
 *  - Click-to-select in tree highlights component in canvas
 *  - Property changes → immutable config update → re-render
 *  - Add Component menu from ForgeRegistry categories
 *
 * Depends on: inspector.js (ConfigInspector), forge-registry.js (Agentiface.Registry)
 */

(function () {
  // ---- State ----

  var _inspectorVisible = false;
  var _selectedNodePath = null;
  var _splitPane = null;
  var _treeGrid = null;
  var _propForm = null;
  var _toolbar = null;
  var _treeData = null;
  var _mainCanvas = null;     // the canvas that holds the rendered app
  var _renderDebounce = null;

  var INSPECTOR_WIDTH = 280;

  // ---- Public API ----

  var InspectorUI = {

    /**
     * Initialize the inspector. Called once after SC loads.
     * Creates the SplitPane structure but keeps it hidden.
     */
    init: function () {
      _buildToolbar();
      _buildTreeGrid();
      _buildPropertyForm();
      _buildSplitPane();
    },

    /**
     * Show/hide the inspector panel.
     */
    toggle: function () {
      _inspectorVisible = !_inspectorVisible;
      if (_inspectorVisible) {
        this.refresh();
        _splitPane.show();
        if (_toolbar) _toolbar.show();
      } else {
        _splitPane.hide();
        if (_toolbar) _toolbar.hide();
      }
      _updateToggleButton();
    },

    /**
     * Check if inspector is currently visible.
     */
    isVisible: function () {
      return _inspectorVisible;
    },

    /**
     * Refresh the tree from current config.
     */
    refresh: function () {
      if (!_inspectorVisible) return;
      var config = _getCurrentConfig();
      if (!config) return;

      var treeNodes = ConfigInspector.buildTreeFromConfig(config);
      _treeData = isc.Tree.create({
        modelType: 'parent',
        idField: 'id',
        parentIdField: 'parentId',
        data: treeNodes,
      });
      _treeGrid.setData(_treeData);
      _treeData.openAll();

      // Restore selection if path still exists
      if (_selectedNodePath) {
        _selectNodeByPath(_selectedNodePath);
      }
    },

    /**
     * Select a component by its nodePath (called from canvas click handlers).
     */
    selectByPath: function (nodePath) {
      if (!_inspectorVisible) return;
      _selectedNodePath = nodePath;
      _selectNodeByPath(nodePath);
      _loadPropertiesForPath(nodePath);
    },

    /**
     * Get the SplitPane component (for embedding in the main layout).
     */
    getSplitPane: function () {
      return _splitPane;
    },

    /**
     * Get the toolbar component.
     */
    getToolbar: function () {
      return _toolbar;
    },

    /**
     * Destroy all inspector components.
     */
    destroy: function () {
      if (_splitPane) { try { _splitPane.destroy(); } catch (e) {} }
      if (_toolbar) { try { _toolbar.destroy(); } catch (e) {} }
      _splitPane = null;
      _toolbar = null;
      _treeGrid = null;
      _propForm = null;
      _inspectorVisible = false;
    },
  };

  // ---- Internal: Build Components ----

  function _buildToolbar() {
    _toolbar = isc.ToolStrip.create({
      width: '100%',
      height: 30,
      visibility: 'hidden',
      members: [
        isc.ToolStripButton.create({
          ID: 'inspectorToggleBtn',
          title: 'Inspector',
          icon: '[SKINIMG]actions/configure.png',
          showDown: false,
          click: function () {
            InspectorUI.toggle();
          },
        }),
        isc.ToolStripSeparator.create(),
        isc.Label.create({
          ID: 'inspectorModeLabel',
          contents: 'Mode: AI',
          width: 100,
          height: 22,
        }),
        'separator',
        isc.ToolStripMenuButton.create({
          ID: 'addComponentBtn',
          title: 'Add Component',
          menu: _buildAddComponentMenu(),
        }),
      ],
    });
  }

  function _buildAddComponentMenu() {
    var registry = (typeof Agentiface !== 'undefined' && Agentiface.Registry) ? Agentiface.Registry : null;
    if (!registry) return isc.Menu.create({ data: [] });

    var categories = registry.getByCategory();
    var menuItems = [];
    for (var cat in categories) {
      var subItems = [];
      var items = categories[cat];
      for (var i = 0; i < items.length; i++) {
        (function (item) {
          subItems.push({
            title: item.name,
            click: function () { _addComponentFromRegistry(item); },
          });
        })(items[i]);
      }
      menuItems.push({
        title: cat,
        submenu: subItems,
      });
    }

    return isc.Menu.create({ data: menuItems });
  }

  function _buildTreeGrid() {
    _treeGrid = isc.TreeGrid.create({
      ID: 'inspectorTree',
      width: '100%',
      height: '60%',
      showHeader: true,
      fields: [
        { name: 'title', title: 'Component', width: '*' },
      ],
      selectionType: 'single',
      canReorderRecords: true,
      canAcceptDroppedRecords: true,
      canReparentNodes: true,
      showConnectors: true,
      nodeClick: function (viewer, node) {
        _selectedNodePath = node.nodePath;
        _loadPropertiesForPath(node.nodePath);
        _highlightComponent(node.nodePath);
      },
      showRollOverCanvas: false,
      contextMenu: isc.Menu.create({
        data: [
          { title: 'Delete', click: function () { _deleteSelectedNode(); } },
          { title: 'Move Up', click: function () { _moveSelectedNode(-1); } },
          { title: 'Move Down', click: function () { _moveSelectedNode(1); } },
        ],
      }),
    });
  }

  function _buildPropertyForm() {
    _propForm = isc.DynamicForm.create({
      ID: 'inspectorProps',
      width: '100%',
      height: '40%',
      overflow: 'auto',
      numCols: 2,
      colWidths: [100, '*'],
      cellPadding: 4,
      fields: [
        { name: '_placeholder', type: 'StaticTextItem', value: 'Select a component', showTitle: false, colSpan: 2 },
      ],
    });
  }

  function _buildSplitPane() {
    // Inspector is a draggable SC Window pinned to top-right.
    _splitPane = isc.Window.create({
      ID: 'inspectorSplitPane',
      title: 'Inspector',
      width: INSPECTOR_WIDTH,
      height: 420,
      canDragReposition: true,
      canDragResize: true,
      showMinimizeButton: true,
      showCloseButton: true,
      closeClick: function () { InspectorUI.toggle(); return false; },
      items: [
        isc.VLayout.create({
          width: '100%',
          height: '100%',
          members: [_treeGrid, _propForm],
        }),
      ],
      // Pin to top-right, offset from edge
      left: Math.max(0, (isc.Page.getWidth() - INSPECTOR_WIDTH - 16)),
      top: 36,
      visibility: 'hidden',
      autoDraw: true,
    });
  }

  // ---- Internal: Property Editing ----

  function _loadPropertiesForPath(nodePath) {
    var config = _getCurrentConfig();
    if (!config || !_propForm) return;

    var node = ConfigInspector.getNodeAtPath(config, nodePath);
    if (!node) return;

    var type = node._type || node.type || '';

    // Get schema from registry if available
    var schemaFields = [];
    if (typeof Agentiface !== 'undefined' && Agentiface.Registry && Agentiface.Registry.getPropertySchema) {
      schemaFields = Agentiface.Registry.getPropertySchema(type);
    }

    // Resolve dynamic valueMaps
    var dsNames = (config.dataSources || []).map(function (ds) { return ds.ID; });
    var compIDs = _collectComponentIDs(config.layout);

    var formFields = [];
    for (var i = 0; i < schemaFields.length; i++) {
      var s = schemaFields[i];
      var field = {
        name: s.name,
        title: s.label || s.name,
        defaultValue: node[s.name],
        changed: function (form, item, value) {
          _onPropertyChanged(item.name, value);
        },
      };

      if (s.type === 'boolean') {
        field.type = 'BooleanItem';
      } else if (s.type === 'integer') {
        field.type = 'SpinnerItem';
        field.step = 1;
      } else if (s.type === 'enum') {
        field.type = 'SelectItem';
        if (s.valueMapFrom === 'dataSources') {
          field.valueMap = dsNames;
        } else if (s.valueMapFrom === 'componentIDs') {
          field.valueMap = compIDs;
        } else if (s.valueMap) {
          field.valueMap = s.valueMap;
        }
      } else if (s.type === 'readonly') {
        field.type = 'StaticTextItem';
        field.value = s.label || '(complex)';
      } else {
        field.type = 'TextItem';
      }

      formFields.push(field);
    }

    if (formFields.length === 0) {
      // Fallback: show raw properties
      var props = ConfigInspector.getPropertiesForNode(config, nodePath);
      for (var j = 0; j < props.length; j++) {
        var p = props[j];
        formFields.push({
          name: p.name,
          title: p.name,
          type: p.editable ? 'TextItem' : 'StaticTextItem',
          defaultValue: typeof p.value === 'object' ? JSON.stringify(p.value) : p.value,
          changed: function (form, item, value) {
            _onPropertyChanged(item.name, value);
          },
        });
      }
    }

    _propForm.setFields(formFields);
    // setFields + defaultValue can be stale; explicitly set values from node
    var values = {};
    for (var vi = 0; vi < formFields.length; vi++) {
      var fn = formFields[vi].name;
      if (fn && node[fn] !== undefined) {
        values[fn] = node[fn];
      } else if (formFields[vi].defaultValue !== undefined) {
        values[fn] = formFields[vi].defaultValue;
      }
    }
    _propForm.setValues(values);
  }

  function _collectComponentIDs(node) {
    var ids = [];
    if (!node) return ids;
    if (node.ID) ids.push(node.ID);
    var childArrays = ['members', 'tabs', 'panes', 'items', 'portlets', 'sections', 'controls'];
    for (var i = 0; i < childArrays.length; i++) {
      var arr = node[childArrays[i]];
      if (!Array.isArray(arr)) continue;
      for (var j = 0; j < arr.length; j++) {
        ids = ids.concat(_collectComponentIDs(arr[j]));
      }
    }
    return ids;
  }

  function _onPropertyChanged(propName, value) {
    if (!_selectedNodePath) return;
    var config = _getCurrentConfig();
    if (!config) return;

    // Coerce types
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (value !== '' && !isNaN(Number(value)) && typeof value === 'string') {
      // Only coerce if it looks like a pure number (not "100%")
      if (!/[%*]/.test(value)) value = Number(value);
    }

    var newConfig = ConfigInspector.setPropertyOnConfig(config, _selectedNodePath, propName, value);
    _applyConfigUpdate(newConfig);
  }

  // ---- Internal: Tree Actions ----

  function _deleteSelectedNode() {
    if (!_selectedNodePath || _selectedNodePath === 'layout') return;
    var config = _getCurrentConfig();
    if (!config) return;

    var newConfig = ConfigInspector.removeNodeFromConfig(config, _selectedNodePath);
    _selectedNodePath = null;
    _propForm.setFields([{ name: '_placeholder', type: 'StaticTextItem', value: 'Select a component', showTitle: false, colSpan: 2 }]);
    _applyConfigUpdate(newConfig);
  }

  function _moveSelectedNode(direction) {
    if (!_selectedNodePath || _selectedNodePath === 'layout') return;
    var config = _getCurrentConfig();
    if (!config) return;

    // Parse path to find current index in parent
    var lastDot = _selectedNodePath.lastIndexOf('.');
    if (lastDot === -1) return;

    var parentSegment = _selectedNodePath.substring(0, lastDot);
    var childSegment = _selectedNodePath.substring(lastDot + 1);
    var bracketMatch = childSegment.match(/^(\w+)\[(\d+)\]$/);
    if (!bracketMatch) return;

    var childKey = bracketMatch[1];
    var currentIdx = parseInt(bracketMatch[2], 10);
    var newIdx = currentIdx + direction;
    if (newIdx < 0) return;

    // Resolve parent path to get the actual parent container path
    // parentSegment is like "layout" or "layout.members[2]"
    var parentNode = ConfigInspector.getNodeAtPath(config, parentSegment);
    if (!parentNode || !Array.isArray(parentNode[childKey])) return;
    if (newIdx >= parentNode[childKey].length) return;

    // Swap in a cloned config
    var newConfig = JSON.parse(JSON.stringify(config));
    var parentInNew = ConfigInspector.getNodeAtPath(newConfig, parentSegment);
    var arr = parentInNew[childKey];
    var tmp = arr[currentIdx];
    arr[currentIdx] = arr[newIdx];
    arr[newIdx] = tmp;

    _selectedNodePath = parentSegment + '.' + childKey + '[' + newIdx + ']';
    _applyConfigUpdate(newConfig);
  }

  function _addComponentFromRegistry(registryItem) {
    var config = _getCurrentConfig();
    if (!config) return;

    var targetPath = _selectedNodePath || 'layout';
    var targetNode = ConfigInspector.getNodeAtPath(config, targetPath);

    // If the selected node isn't a container, add to its parent
    if (targetNode && !_isContainer(targetNode)) {
      var lastDot = targetPath.lastIndexOf('.');
      if (lastDot > 0) {
        targetPath = targetPath.substring(0, targetPath.lastIndexOf('['));
        // Actually go up to the parent node
        var parts = targetPath.split('.');
        parts.pop(); // remove the members/tabs array key
        targetPath = parts.join('.') || 'layout';
      } else {
        targetPath = 'layout';
      }
    }

    var newNode = Object.assign({ _type: registryItem.type }, registryItem.defaults || {});
    var newConfig = ConfigInspector.addNodeToConfig(config, targetPath, newNode);
    _applyConfigUpdate(newConfig);
  }

  function _isContainer(node) {
    var type = node._type || node.type || '';
    return /Layout|TabSet|SectionStack|PortalLayout|Window/i.test(type);
  }

  // ---- Internal: Config Application ----

  var _persistDebounce = null;

  function _applyConfigUpdate(newConfig) {
    // Debounced post to bridge.js for persistence + undo (avoids one history
    // entry per keystroke when editing text properties)
    if (_persistDebounce) clearTimeout(_persistDebounce);
    _persistDebounce = setTimeout(function () {
      window.parent.postMessage({
        source: 'smartclient-config-updated',
        config: newConfig,
      }, '*');
    }, 800);

    // Debounced re-render (faster than persist so UI feels responsive)
    if (_renderDebounce) clearTimeout(_renderDebounce);
    _renderDebounce = setTimeout(function () {
      _setCurrentConfig(newConfig);

      // Re-render
      if (typeof clearNotesApp === 'function') clearNotesApp();
      if (typeof renderConfig === 'function') {
        renderConfig(newConfig, {
          skin: typeof _skinName !== 'undefined' ? _skinName : 'Tahoe',
        });
      }

      // Refresh tree
      InspectorUI.refresh();
    }, 200);
  }

  function _getCurrentConfig() {
    return typeof _currentConfig !== 'undefined' ? _currentConfig : null;
  }

  function _setCurrentConfig(config) {
    if (typeof window !== 'undefined') {
      window._currentConfig = JSON.parse(JSON.stringify(config));
    }
  }

  // ---- Internal: Visual Feedback ----

  function _highlightComponent(nodePath) {
    var node = ConfigInspector.getNodeAtPath(_getCurrentConfig(), nodePath);
    if (!node || !node.ID) return;

    var comp = window[node.ID];
    if (!comp || !comp.setBorder) return;

    var originalBorder = comp.border || '';
    comp.setBorder('2px solid #2196F3');
    setTimeout(function () {
      try { comp.setBorder(originalBorder); } catch (e) {}
    }, 1200);
  }

  function _selectNodeByPath(nodePath) {
    if (!_treeGrid || !_treeData) return;

    var allNodes = _treeData.getAllNodes();
    for (var i = 0; i < allNodes.length; i++) {
      if (allNodes[i].nodePath === nodePath) {
        _treeGrid.deselectAllRecords();
        _treeGrid.selectRecord(allNodes[i]);
        _treeGrid.scrollToRow(_treeGrid.getRecordIndex(allNodes[i]));
        return;
      }
    }
  }

  function _updateToggleButton() {
    var btn = window.inspectorToggleBtn;
    if (!btn) return;
    btn.setTitle(_inspectorVisible ? 'Hide Inspector' : 'Inspector');

    var label = window.inspectorModeLabel;
    if (label) {
      label.setContents(_inspectorVisible ? 'Mode: Visual' : 'Mode: AI');
    }
  }

  // ---- Exports ----

  window.InspectorUI = InspectorUI;
})();
