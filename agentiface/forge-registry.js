/**
 * ForgeRegistry — Agentiface component registration system
 *
 * Central registry for all Forge components, used by the builder
 * platform (Phase 4) to populate palettes and provide defaults.
 *
 * Usage:
 *   Agentiface.Registry.register('Data Grid', {
 *     type: 'ForgeListGrid',
 *     category: 'Data',
 *     defaults: { width: '100%', height: 300, showSkeletonLoading: true },
 *     icon: 'grid',
 *     description: 'Enhanced data grid with skeleton loading',
 *   });
 *
 *   var paletteData = Agentiface.Registry.getPaletteData();
 *   var allByCategory = Agentiface.Registry.getByCategory('Data');
 */

window.Agentiface = window.Agentiface || {};

(function () {
  var _components = {};

  var Registry = {
    /**
     * Register a component in the Forge registry.
     * @param {string} name - Display name (e.g., 'Data Grid')
     * @param {Object} config
     * @param {string} config.type - SC class name (e.g., 'ForgeListGrid')
     * @param {string} [config.category='General'] - Category for palette grouping
     * @param {Object} [config.defaults] - Default properties when creating
     * @param {string} [config.icon] - Icon identifier
     * @param {string} [config.description] - Human-readable description
     */
    register: function (name, config) {
      _components[name] = Object.assign({ name: name }, config);
    },

    /**
     * Get a registered component by name.
     * @param {string} name
     * @returns {Object|null}
     */
    get: function (name) {
      return _components[name] || null;
    },

    /**
     * Get all registered components.
     * @returns {Object} Map of name -> config
     */
    getAll: function () {
      return Object.assign({}, _components);
    },

    /**
     * Get components grouped by category.
     * @param {string} [category] - If provided, return only that category
     * @returns {Object} Map of category -> array of configs
     */
    getByCategory: function (category) {
      var grouped = {};
      for (var name in _components) {
        var comp = _components[name];
        var cat = comp.category || 'General';
        if (category && cat !== category) continue;
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(comp);
      }
      return grouped;
    },

    /**
     * Get all category names.
     * @returns {string[]}
     */
    getCategories: function () {
      var cats = {};
      for (var name in _components) {
        cats[_components[name].category || 'General'] = true;
      }
      return Object.keys(cats).sort();
    },

    /**
     * Build TreePalette-compatible data for the screen builder.
     * Returns a flat array with parent/child relationships.
     * @returns {Array}
     */
    getPaletteData: function () {
      var categories = this.getByCategory();
      var data = [];
      var id = 0;

      for (var cat in categories) {
        var parentId = ++id;
        data.push({
          id: parentId,
          title: cat,
          isFolder: true,
        });

        var items = categories[cat];
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          data.push({
            id: ++id,
            parentId: parentId,
            title: item.name,
            type: item.type,
            defaults: item.defaults || {},
            icon: item.icon,
            description: item.description,
          });
        }
      }

      return data;
    },

    /**
     * Create an instance of a registered component.
     * @param {string} name - Registered component name
     * @param {Object} [overrides] - Properties to override defaults
     * @returns {Object|null} SC component instance
     */
    create: function (name, overrides) {
      var config = _components[name];
      if (!config) {
        console.warn('[Registry] Unknown component:', name);
        return null;
      }

      var type = config.type;
      if (!isc[type]) {
        console.warn('[Registry] Unknown SC class:', type);
        return null;
      }

      var props = Object.assign({}, config.defaults || {}, overrides || {});
      return isc[type].create(props);
    },

    /**
     * Get the count of registered components.
     * @returns {number}
     */
    count: function () {
      return Object.keys(_components).length;
    },
  };

  // ── Register built-in Agentiface components ────────────

  Registry.register('Data Grid', {
    type: 'ForgeListGrid',
    category: 'Data',
    defaults: { width: '100%', height: 300 },
    icon: 'grid',
    description: 'Enhanced data grid with skeleton loading and token styling',
  });

  Registry.register('Form', {
    type: 'DynamicForm',
    category: 'Input',
    defaults: { width: '100%', numCols: 2, cellPadding: 4 },
    icon: 'form',
    description: 'Data entry form with validation',
  });

  Registry.register('Filter Bar', {
    type: 'ForgeFilterBar',
    category: 'Input',
    defaults: { width: '100%' },
    icon: 'search',
    description: 'Combined search + advanced filter for grids',
  });

  Registry.register('Wizard', {
    type: 'ForgeWizard',
    category: 'Navigation',
    defaults: { width: '100%', height: 400 },
    icon: 'wizard',
    description: 'Multi-step form with step indicator',
  });

  Registry.register('Button', {
    type: 'Button',
    category: 'Action',
    defaults: { width: 100, height: 30 },
    icon: 'button',
    description: 'Clickable button',
  });

  Registry.register('Label', {
    type: 'Label',
    category: 'Display',
    defaults: { width: '100%', height: 24 },
    icon: 'label',
    description: 'Text label',
  });

  Registry.register('Vertical Layout', {
    type: 'VLayout',
    category: 'Layout',
    defaults: { width: '100%', height: '100%', membersMargin: 8 },
    icon: 'vlayout',
    description: 'Vertical stack layout',
  });

  Registry.register('Horizontal Layout', {
    type: 'HLayout',
    category: 'Layout',
    defaults: { width: '100%', height: 50, membersMargin: 8 },
    icon: 'hlayout',
    description: 'Horizontal stack layout',
  });

  Registry.register('Tab Set', {
    type: 'TabSet',
    category: 'Navigation',
    defaults: { width: '100%', height: 300 },
    icon: 'tabs',
    description: 'Tabbed content container',
  });

  Registry.register('Section Stack', {
    type: 'SectionStack',
    category: 'Layout',
    defaults: { width: '100%', height: 300, visibilityMode: 'mutex' },
    icon: 'sections',
    description: 'Collapsible section stack (accordion)',
  });

  Registry.register('Detail Viewer', {
    type: 'DetailViewer',
    category: 'Display',
    defaults: { width: '100%' },
    icon: 'detail',
    description: 'Read-only record display',
  });

  Registry.register('HTML Content', {
    type: 'HTMLFlow',
    category: 'Display',
    defaults: { width: '100%', height: 100 },
    icon: 'html',
    description: 'HTML content area',
  });

  Registry.register('Portal Dashboard', {
    type: 'PortalLayout',
    category: 'Layout',
    defaults: { width: '100%', height: '100%', numColumns: 3 },
    icon: 'portal',
    description: 'User-arrangeable tile dashboard',
  });

  Registry.register('Window', {
    type: 'Window',
    category: 'Container',
    defaults: { width: 400, height: 300, autoCenter: true, canDragReposition: true, canDragResize: true },
    icon: 'window',
    description: 'Floating dialog window',
  });

  Registry.register('Toolbar', {
    type: 'ToolStrip',
    category: 'Action',
    defaults: { width: '100%', height: 30 },
    icon: 'toolbar',
    description: 'Horizontal toolbar with buttons',
  });

  Agentiface.Registry = Registry;
})();
