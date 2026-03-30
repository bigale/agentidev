/**
 * templates.js — Bundled starter templates for Agentiface projects.
 *
 * Each template provides:
 *   - config: complete {dataSources, layout} that renders immediately
 *   - aiSystemPrompt: domain-specific context injected into Claude generation
 *   - suggestedPrompts: follow-up prompt ideas for the user
 *
 * Templates are read-only (bundled). User-created templates are stored
 * on disk via bridge (BRIDGE_AF_TEMPLATE_SAVE/LIST/DELETE).
 */

(function () {
  var BUNDLED_TEMPLATES = [
    // 1. Blank Canvas
    {
      id: 'tpl_blank',
      name: 'Blank Canvas',
      description: 'Empty layout — start from scratch with AI prompts.',
      category: 'General',
      tags: ['starter', 'empty'],
      config: {
        dataSources: [],
        layout: {
          _type: 'VLayout',
          width: '100%',
          height: '100%',
          layoutMargin: 12,
          membersMargin: 8,
          members: [],
        },
      },
      aiSystemPrompt: '',
      suggestedPrompts: [
        'Add a data grid with sample task data',
        'Create a form for entering customer information',
        'Build a dashboard with summary cards',
      ],
    },

    // 2. CRUD Manager
    {
      id: 'tpl_crud',
      name: 'CRUD Manager',
      description: 'Grid + form + action buttons for managing records.',
      category: 'Data',
      tags: ['crud', 'grid', 'form', 'data entry'],
      config: {
        dataSources: [
          {
            ID: 'ItemDS',
            fields: [
              { name: 'id', type: 'integer', primaryKey: true, hidden: true },
              { name: 'name', type: 'text', required: true, title: 'Name', length: 200 },
              { name: 'status', type: 'text', title: 'Status', valueMap: ['Active', 'Inactive', 'Pending'] },
              { name: 'description', type: 'text', title: 'Description', length: 1000 },
              { name: 'createdAt', type: 'datetime', title: 'Created', canEdit: false },
            ],
          },
        ],
        layout: {
          _type: 'VLayout',
          width: '100%',
          height: '100%',
          layoutMargin: 12,
          membersMargin: 8,
          members: [
            {
              _type: 'ForgeListGrid',
              ID: 'itemGrid',
              dataSource: 'ItemDS',
              autoFetchData: true,
              selectionType: 'single',
              height: '*',
              fields: [
                { name: 'name', width: '*' },
                { name: 'status', width: 100 },
                { name: 'createdAt', width: 160 },
              ],
            },
            {
              _type: 'DynamicForm',
              ID: 'itemForm',
              dataSource: 'ItemDS',
              numCols: 2,
            },
            {
              _type: 'HLayout',
              height: 30,
              membersMargin: 8,
              members: [
                { _type: 'Button', ID: 'newBtn', title: 'New', width: 80, _action: 'new', _targetForm: 'itemForm' },
                { _type: 'Button', ID: 'saveBtn', title: 'Save', width: 80, _action: 'save', _targetForm: 'itemForm', _targetGrid: 'itemGrid' },
                { _type: 'Button', ID: 'deleteBtn', title: 'Delete', width: 80, _action: 'delete', _targetGrid: 'itemGrid' },
              ],
            },
          ],
        },
      },
      aiSystemPrompt: 'This is a CRUD data management app. The user wants to manage records with create, read, update, delete operations. Prefer grid+form patterns. Always include New/Save/Delete buttons with proper _action and _target bindings.',
      suggestedPrompts: [
        'Add a search filter bar above the grid',
        'Add a status column with color-coded badges',
        'Add a priority field with High/Medium/Low options',
        'Make the form appear in a popup window on edit',
      ],
    },

    // 3. Master-Detail
    {
      id: 'tpl_master_detail',
      name: 'Master-Detail',
      description: 'Two linked DataSources with parent-child relationship.',
      category: 'Data',
      tags: ['master', 'detail', 'foreign key', 'tabs'],
      config: {
        dataSources: [
          {
            ID: 'CategoryDS',
            fields: [
              { name: 'id', type: 'integer', primaryKey: true, hidden: true },
              { name: 'name', type: 'text', required: true, title: 'Category' },
              { name: 'description', type: 'text', title: 'Description' },
            ],
          },
          {
            ID: 'ItemDS',
            fields: [
              { name: 'id', type: 'integer', primaryKey: true, hidden: true },
              { name: 'categoryId', type: 'integer', title: 'Category', foreignKey: 'CategoryDS.id', hidden: true },
              { name: 'name', type: 'text', required: true, title: 'Item Name' },
              { name: 'value', type: 'float', title: 'Value' },
              { name: 'notes', type: 'text', title: 'Notes' },
            ],
          },
        ],
        layout: {
          _type: 'HLayout',
          width: '100%',
          height: '100%',
          layoutMargin: 12,
          membersMargin: 10,
          members: [
            {
              _type: 'VLayout',
              width: '35%',
              height: '100%',
              membersMargin: 8,
              members: [
                { _type: 'Label', contents: '<b>Categories</b>', height: 24 },
                {
                  _type: 'ForgeListGrid',
                  ID: 'categoryGrid',
                  dataSource: 'CategoryDS',
                  autoFetchData: true,
                  selectionType: 'single',
                  height: '*',
                  fields: [{ name: 'name', width: '*' }],
                },
              ],
            },
            {
              _type: 'VLayout',
              width: '65%',
              height: '100%',
              membersMargin: 8,
              members: [
                { _type: 'Label', contents: '<b>Items</b>', height: 24 },
                {
                  _type: 'ForgeListGrid',
                  ID: 'itemGrid',
                  dataSource: 'ItemDS',
                  autoFetchData: false,
                  selectionType: 'single',
                  height: '*',
                  fields: [
                    { name: 'name', width: '*' },
                    { name: 'value', width: 100 },
                  ],
                },
                {
                  _type: 'DynamicForm',
                  ID: 'itemForm',
                  dataSource: 'ItemDS',
                  numCols: 2,
                },
                {
                  _type: 'HLayout',
                  height: 30,
                  membersMargin: 8,
                  members: [
                    { _type: 'Button', ID: 'newItemBtn', title: 'New', width: 80, _action: 'new', _targetForm: 'itemForm' },
                    { _type: 'Button', ID: 'saveItemBtn', title: 'Save', width: 80, _action: 'save', _targetForm: 'itemForm', _targetGrid: 'itemGrid' },
                  ],
                },
              ],
            },
          ],
        },
      },
      aiSystemPrompt: 'This is a master-detail app with two linked DataSources. CategoryDS is the parent, ItemDS has a foreignKey to CategoryDS.id. When the user selects a category row, the item grid should filter by categoryId. Use HLayout to show master on left, detail on right.',
      suggestedPrompts: [
        'Add delete buttons for both categories and items',
        'Add a tab set in the detail panel with Items and Notes tabs',
        'Add a category count badge showing how many items each has',
        'Add a search bar to filter categories',
      ],
    },

    // 4. Dashboard
    {
      id: 'tpl_dashboard',
      name: 'Dashboard',
      description: 'PortalLayout with summary cards and a data grid.',
      category: 'Layout',
      tags: ['dashboard', 'portal', 'cards', 'summary'],
      config: {
        dataSources: [
          {
            ID: 'MetricsDS',
            fields: [
              { name: 'id', type: 'integer', primaryKey: true, hidden: true },
              { name: 'label', type: 'text', title: 'Metric' },
              { name: 'value', type: 'float', title: 'Value' },
              { name: 'trend', type: 'text', title: 'Trend', valueMap: ['Up', 'Down', 'Flat'] },
              { name: 'updatedAt', type: 'datetime', title: 'Updated' },
            ],
          },
        ],
        layout: {
          _type: 'VLayout',
          width: '100%',
          height: '100%',
          layoutMargin: 12,
          membersMargin: 10,
          members: [
            {
              _type: 'HLayout',
              height: 30,
              membersMargin: 8,
              members: [
                { _type: 'Label', contents: '<h2 style="margin:0">Dashboard</h2>', width: '*', height: 30 },
              ],
            },
            {
              _type: 'PortalLayout',
              ID: 'dashPortal',
              height: '*',
              numColumns: 3,
              portlets: [
                {
                  _type: 'Portlet',
                  title: 'Summary',
                  height: 200,
                  items: [
                    { _type: 'DetailViewer', ID: 'summaryViewer', dataSource: 'MetricsDS' },
                  ],
                },
                {
                  _type: 'Portlet',
                  title: 'Metrics Grid',
                  height: 300,
                  items: [
                    {
                      _type: 'ForgeListGrid',
                      ID: 'metricsGrid',
                      dataSource: 'MetricsDS',
                      autoFetchData: true,
                      fields: [
                        { name: 'label', width: '*' },
                        { name: 'value', width: 80 },
                        { name: 'trend', width: 80 },
                      ],
                    },
                  ],
                },
                {
                  _type: 'Portlet',
                  title: 'Quick Actions',
                  height: 150,
                  items: [
                    {
                      _type: 'VLayout',
                      membersMargin: 8,
                      layoutMargin: 8,
                      members: [
                        { _type: 'Button', title: 'Refresh Data', width: '100%', _action: 'select', _targetGrid: 'metricsGrid' },
                        { _type: 'Button', title: 'Add Metric', width: '100%', _action: 'new', _targetForm: 'metricsGrid' },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      aiSystemPrompt: 'This is a dashboard app using PortalLayout for user-arrangeable tiles. Each Portlet is a draggable card. Use numColumns to control grid layout. Summary cards should use DetailViewer or HTMLFlow. Data tables use ForgeListGrid. Include quick-action buttons.',
      suggestedPrompts: [
        'Add a chart portlet showing trend over time',
        'Add a recent activity feed portlet',
        'Change to a 2-column layout with wider summary',
        'Add a date range filter at the top',
      ],
    },

    // 5. Calculator
    {
      id: 'tpl_calculator',
      name: 'Calculator',
      description: 'Form with compute action for formula-based calculations.',
      category: 'Input',
      tags: ['calculator', 'compute', 'formula', 'math'],
      config: {
        dataSources: [
          {
            ID: 'CalcDS',
            fields: [
              { name: 'id', type: 'integer', primaryKey: true, hidden: true },
              { name: 'principal', type: 'float', title: 'Principal ($)', required: true },
              { name: 'rate', type: 'float', title: 'Annual Rate (%)', required: true },
              { name: 'years', type: 'integer', title: 'Years', required: true },
              { name: 'result', type: 'float', title: 'Result', canEdit: false },
            ],
          },
        ],
        layout: {
          _type: 'VLayout',
          width: '100%',
          height: '100%',
          layoutMargin: 20,
          membersMargin: 12,
          members: [
            { _type: 'Label', contents: '<h2 style="margin:0">Loan Calculator</h2>', height: 30 },
            {
              _type: 'DynamicForm',
              ID: 'calcForm',
              dataSource: 'CalcDS',
              numCols: 2,
              colWidths: [140, '*'],
              width: 400,
            },
            {
              _type: 'HLayout',
              height: 30,
              membersMargin: 8,
              members: [
                {
                  _type: 'Button',
                  ID: 'computeBtn',
                  title: 'Calculate',
                  width: 120,
                  _action: 'compute',
                  _targetForm: 'calcForm',
                  _formula: 'principal * (rate / 100 / 12) * (1 + rate / 100 / 12) ** (years * 12) / ((1 + rate / 100 / 12) ** (years * 12) - 1)',
                  _resultField: 'result',
                },
                { _type: 'Button', title: 'Clear', width: 80, _action: 'clear', _targetForm: 'calcForm' },
              ],
            },
            {
              _type: 'Label',
              ID: 'resultLabel',
              contents: '<i>Enter values and click Calculate</i>',
              height: 40,
            },
          ],
        },
      },
      aiSystemPrompt: 'This is a calculator app. Use DynamicForm for inputs and Button with _action:"compute" for calculations. The _formula property uses safe math expressions with field names from the form. _resultField specifies which form field receives the result. Support: +, -, *, /, **, Math.* functions. For loan amortization use _action:"compute" with _formula:"amortization_schedule" and _resultField pointing to a grid.',
      suggestedPrompts: [
        'Add an amortization schedule grid below the calculator',
        'Add a compound interest calculator tab',
        'Show the monthly payment result in a large styled label',
        'Add a comparison mode for two different loan scenarios',
      ],
    },

    // 6. Wizard
    {
      id: 'tpl_wizard',
      name: 'Wizard',
      description: 'Multi-step form with ForgeWizard step indicator.',
      category: 'Navigation',
      tags: ['wizard', 'steps', 'multi-step', 'onboarding'],
      config: {
        dataSources: [
          {
            ID: 'OnboardDS',
            fields: [
              { name: 'id', type: 'integer', primaryKey: true, hidden: true },
              { name: 'firstName', type: 'text', required: true, title: 'First Name' },
              { name: 'lastName', type: 'text', required: true, title: 'Last Name' },
              { name: 'email', type: 'text', required: true, title: 'Email' },
              { name: 'company', type: 'text', title: 'Company' },
              { name: 'role', type: 'text', title: 'Role', valueMap: ['Developer', 'Designer', 'Manager', 'Executive'] },
              { name: 'plan', type: 'text', title: 'Plan', valueMap: ['Free', 'Pro', 'Enterprise'] },
              { name: 'agreeTerms', type: 'boolean', title: 'I agree to the terms' },
            ],
          },
        ],
        layout: {
          _type: 'VLayout',
          width: '100%',
          height: '100%',
          layoutMargin: 20,
          membersMargin: 12,
          members: [
            { _type: 'Label', contents: '<h2 style="margin:0">Setup Wizard</h2>', height: 30 },
            {
              _type: 'ForgeWizard',
              ID: 'setupWizard',
              width: '100%',
              height: '*',
              steps: [
                {
                  title: 'Personal Info',
                  pane: {
                    _type: 'DynamicForm',
                    ID: 'step1Form',
                    dataSource: 'OnboardDS',
                    numCols: 2,
                    fields: [
                      { name: 'firstName' },
                      { name: 'lastName' },
                      { name: 'email' },
                    ],
                  },
                },
                {
                  title: 'Organization',
                  pane: {
                    _type: 'DynamicForm',
                    ID: 'step2Form',
                    dataSource: 'OnboardDS',
                    numCols: 2,
                    fields: [
                      { name: 'company' },
                      { name: 'role' },
                    ],
                  },
                },
                {
                  title: 'Confirm',
                  pane: {
                    _type: 'VLayout',
                    membersMargin: 12,
                    members: [
                      {
                        _type: 'DynamicForm',
                        ID: 'step3Form',
                        dataSource: 'OnboardDS',
                        numCols: 2,
                        fields: [
                          { name: 'plan' },
                          { name: 'agreeTerms' },
                        ],
                      },
                      { _type: 'Button', title: 'Complete Setup', width: 150, _action: 'save', _targetForm: 'step3Form' },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
      aiSystemPrompt: 'This is a multi-step wizard app using ForgeWizard. Each step has a title and a pane (usually a DynamicForm). ForgeWizard provides built-in Next/Back navigation and a step indicator. Place the final submit action in the last step. Group related fields by step.',
      suggestedPrompts: [
        'Add a 4th step for payment information',
        'Add validation so email must be valid before advancing',
        'Show a summary of all entered data on the confirm step',
        'Add a progress bar showing completion percentage',
      ],
    },

    // 7. Search Explorer
    {
      id: 'tpl_search_explorer',
      name: 'Search Explorer',
      description: 'ForgeFilterBar + ForgeListGrid + DetailViewer for data exploration.',
      category: 'Data',
      tags: ['search', 'filter', 'explore', 'detail'],
      config: {
        dataSources: [
          {
            ID: 'RecordDS',
            fields: [
              { name: 'id', type: 'integer', primaryKey: true, hidden: true },
              { name: 'title', type: 'text', required: true, title: 'Title' },
              { name: 'category', type: 'text', title: 'Category', valueMap: ['Article', 'Documentation', 'Tutorial', 'Reference'] },
              { name: 'author', type: 'text', title: 'Author' },
              { name: 'summary', type: 'text', title: 'Summary', length: 2000 },
              { name: 'createdAt', type: 'datetime', title: 'Created' },
              { name: 'tags', type: 'text', title: 'Tags' },
            ],
          },
        ],
        layout: {
          _type: 'VLayout',
          width: '100%',
          height: '100%',
          layoutMargin: 12,
          membersMargin: 8,
          members: [
            {
              _type: 'ForgeFilterBar',
              ID: 'searchBar',
              targetGrid: 'recordGrid',
              placeholder: 'Search records...',
            },
            {
              _type: 'HLayout',
              height: '*',
              membersMargin: 10,
              members: [
                {
                  _type: 'ForgeListGrid',
                  ID: 'recordGrid',
                  dataSource: 'RecordDS',
                  autoFetchData: true,
                  selectionType: 'single',
                  width: '60%',
                  height: '100%',
                  fields: [
                    { name: 'title', width: '*' },
                    { name: 'category', width: 110 },
                    { name: 'author', width: 120 },
                    { name: 'createdAt', width: 140 },
                  ],
                },
                {
                  _type: 'VLayout',
                  width: '40%',
                  height: '100%',
                  membersMargin: 8,
                  members: [
                    { _type: 'Label', contents: '<b>Details</b>', height: 24 },
                    {
                      _type: 'DetailViewer',
                      ID: 'recordDetail',
                      dataSource: 'RecordDS',
                      width: '100%',
                      height: '*',
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      aiSystemPrompt: 'This is a search/explore app. ForgeFilterBar provides combined quick-search and advanced filter that targets a ForgeListGrid via targetGrid. Use DetailViewer for read-only record display on the side. HLayout splits the view into list (left) and detail (right). The filter bar auto-filters the grid when the user types.',
      suggestedPrompts: [
        'Add a tag cloud filter in the detail panel',
        'Add inline editing to the grid',
        'Add export buttons for CSV and JSON',
        'Add a bookmark/favorite toggle on each row',
      ],
    },
  ];

  // ---- Template Manager ----

  var TemplateManager = {
    /**
     * Get all bundled templates.
     * @returns {Array}
     */
    getBundled: function () {
      return BUNDLED_TEMPLATES.map(function (t) {
        return Object.assign({}, t, { bundled: true });
      });
    },

    /**
     * Get a bundled template by ID.
     * @param {string} id
     * @returns {Object|null}
     */
    getById: function (id) {
      for (var i = 0; i < BUNDLED_TEMPLATES.length; i++) {
        if (BUNDLED_TEMPLATES[i].id === id) {
          return Object.assign({}, BUNDLED_TEMPLATES[i], { bundled: true });
        }
      }
      return null;
    },

    /**
     * Get templates by category.
     * @param {string} category
     * @returns {Array}
     */
    getByCategory: function (category) {
      return BUNDLED_TEMPLATES.filter(function (t) {
        return t.category === category;
      });
    },

    /**
     * Get all template categories.
     * @returns {string[]}
     */
    getCategories: function () {
      var cats = {};
      BUNDLED_TEMPLATES.forEach(function (t) { cats[t.category] = true; });
      return Object.keys(cats).sort();
    },

    /**
     * Validate a template object has required fields.
     * @param {Object} template
     * @returns {{valid: boolean, errors: string[]}}
     */
    validate: function (template) {
      var errors = [];
      if (!template) { return { valid: false, errors: ['Template is null'] }; }
      if (!template.id) errors.push('Missing id');
      if (!template.name) errors.push('Missing name');
      if (!template.config) errors.push('Missing config');
      if (template.config) {
        if (!template.config.layout) errors.push('Config missing layout');
        if (!Array.isArray(template.config.dataSources)) errors.push('Config missing dataSources array');
      }
      return { valid: errors.length === 0, errors: errors };
    },

    /**
     * Create a user template from current config + metadata.
     * @param {Object} opts
     * @param {string} opts.name
     * @param {string} [opts.description]
     * @param {string} [opts.category]
     * @param {Object} opts.config
     * @param {string} [opts.aiSystemPrompt]
     * @param {string[]} [opts.suggestedPrompts]
     * @returns {Object} template object ready for saving
     */
    createUserTemplate: function (opts) {
      return {
        id: 'tpl_user_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name: opts.name,
        description: opts.description || '',
        category: opts.category || 'Custom',
        tags: ['user-created'],
        config: JSON.parse(JSON.stringify(opts.config)),
        aiSystemPrompt: opts.aiSystemPrompt || '',
        suggestedPrompts: opts.suggestedPrompts || [],
        bundled: false,
        createdAt: new Date().toISOString(),
      };
    },
  };

  // ---- Exports ----

  if (typeof window !== 'undefined') {
    window.Agentiface = window.Agentiface || {};
    window.Agentiface.TemplateManager = TemplateManager;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TemplateManager: TemplateManager, BUNDLED_TEMPLATES: BUNDLED_TEMPLATES };
  }
})();
