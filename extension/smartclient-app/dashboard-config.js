/**
 * SC-4b: Dashboard PortalLayout configuration.
 * Sets window._dashboardConfig consumed by dashboard-app.js → renderConfig().
 *
 * DataSources: BridgeSessions, BridgeScripts, BridgeSchedules, BridgeCommands
 * Layout: VLayout → ToolStrip + PortalLayout (3 columns)
 */

// ---- CLI_COMMANDS / CATEGORIES (inlined — sandbox cannot import ESM) ----

window.CLI_COMMANDS = {
  // Navigation
  'goto':       { category: 'navigation', args: [{ name: 'url', type: 'url', required: true }] },
  'go-back':    { category: 'navigation', args: [] },
  'go-forward': { category: 'navigation', args: [] },
  'reload':     { category: 'navigation', args: [] },
  // Interaction
  'click':   { category: 'interaction', args: [{ name: 'ref', type: 'ref', required: true }, { name: 'button', type: 'enum', values: ['left', 'right', 'middle'] }] },
  'fill':    { category: 'interaction', args: [{ name: 'ref', type: 'ref', required: true }, { name: 'text', type: 'text', required: true }] },
  'type':    { category: 'interaction', args: [{ name: 'text', type: 'text', required: true }] },
  'select':  { category: 'interaction', args: [{ name: 'ref', type: 'ref', required: true }, { name: 'val', type: 'text', required: true }] },
  'hover':   { category: 'interaction', args: [{ name: 'ref', type: 'ref', required: true }] },
  'check':   { category: 'interaction', args: [{ name: 'ref', type: 'ref', required: true }] },
  'uncheck': { category: 'interaction', args: [{ name: 'ref', type: 'ref', required: true }] },
  // Keyboard
  'press': { category: 'keyboard', args: [{ name: 'key', type: 'text', required: true, placeholder: 'Enter, Tab, ArrowDown...' }] },
  // Window
  'resize': { category: 'window', args: [{ name: 'w', type: 'number', required: true }, { name: 'h', type: 'number', required: true }] },
  // Capture
  'screenshot': { category: 'capture', args: [{ name: 'ref', type: 'ref' }], options: [{ name: 'filename', type: 'text' }, { name: 'full-page', type: 'boolean' }] },
  'pdf':        { category: 'capture', args: [], options: [{ name: 'filename', type: 'text' }] },
  'snapshot':   { category: 'capture', args: [] },
  // Storage
  'state-load':        { category: 'storage', args: [{ name: 'filename', type: 'file', required: true }] },
  'state-save':        { category: 'storage', args: [{ name: 'filename', type: 'file' }] },
  'cookie-set':        { category: 'storage', args: [{ name: 'name', type: 'text', required: true }, { name: 'value', type: 'text', required: true }], options: [{ name: 'domain', type: 'text' }, { name: 'path', type: 'text' }, { name: 'httpOnly', type: 'boolean' }, { name: 'secure', type: 'boolean' }] },
  'cookie-clear':      { category: 'storage', args: [] },
  'localstorage-set':  { category: 'storage', args: [{ name: 'key', type: 'text', required: true }, { name: 'value', type: 'text', required: true }] },
  'localstorage-clear':{ category: 'storage', args: [] },
  // Network
  'route':   { category: 'network', args: [{ name: 'pattern', type: 'text', required: true, placeholder: '**/api/*' }], options: [{ name: 'status', type: 'number', placeholder: '200' }, { name: 'body', type: 'text' }, { name: 'content-type', type: 'text' }] },
  'unroute': { category: 'network', args: [{ name: 'pattern', type: 'text' }] },
  // DevTools
  'eval':    { category: 'devtools', args: [{ name: 'func', type: 'code', required: true }, { name: 'ref', type: 'ref' }] },
  'console': { category: 'devtools', args: [{ name: 'min-level', type: 'enum', values: ['log', 'warn', 'error'] }] },
  // Tabs
  'tab-new':    { category: 'tabs', args: [{ name: 'url', type: 'url' }] },
  'tab-select': { category: 'tabs', args: [{ name: 'index', type: 'number', required: true }] },
  'tab-close':  { category: 'tabs', args: [{ name: 'index', type: 'number' }] },
  // Wait
  'wait-for-selector': { category: 'wait', args: [{ name: 'selector', type: 'text', required: true }], options: [{ name: 'timeout', type: 'number', placeholder: '30000' }, { name: 'state', type: 'enum', values: ['visible', 'hidden', 'attached', 'detached'] }] },
  'wait-for-url':      { category: 'wait', args: [{ name: 'pattern', type: 'text', required: true, placeholder: '**/dashboard' }], options: [{ name: 'timeout', type: 'number', placeholder: '30000' }] },
  'sleep':             { category: 'wait', args: [{ name: 'ms', type: 'number', required: true, placeholder: '1000' }] },
};

window.CATEGORIES = {
  navigation:  'Navigation',
  interaction: 'Interaction',
  keyboard:    'Keyboard',
  window:      'Window',
  capture:     'Capture',
  storage:     'Storage',
  network:     'Network',
  devtools:    'DevTools',
  tabs:        'Tabs',
  wait:        'Wait',
};

window._dashboardConfig = {

  dataSources: [
    {
      ID: 'BridgeSessions',
      fields: [
        { name: 'id',     type: 'text',    primaryKey: true, hidden: true },
        { name: 'name',   type: 'text',    title: 'Name',   width: '*' },
        { name: 'state',  type: 'text',    title: 'Status', width: 80 },
      ],
    },
    {
      ID: 'BridgeScripts',
      fields: [
        { name: 'id',         type: 'text',    primaryKey: true, hidden: true },
        { name: 'name',       type: 'text',    title: 'Script',    width: '*' },
        { name: 'state',      type: 'text',    title: 'State',     width: 100 },
        { name: 'step',       type: 'integer', title: 'Step',      width: 50 },
        { name: 'totalSteps', type: 'integer', title: 'Total',     width: 50 },
        { name: 'sessionId',  type: 'text',    hidden: true },
        { name: 'activity',   type: 'text',    title: 'Activity',  width: 120 },
        { name: 'startedAt',  type: 'integer', title: 'Started',   width: 75, _formatter: 'timestamp' },
      ],
    },
    {
      ID: 'BridgeSchedules',
      fields: [
        { name: 'id',         type: 'text',    primaryKey: true, hidden: true },
        { name: 'name',       type: 'text',    title: 'Name',       width: '*' },
        { name: 'scriptName', type: 'text',    title: 'Script',     width: 100 },
        { name: 'intervalMs', type: 'integer', title: 'Interval',   width: 70 },
        { name: 'cronExpr',  type: 'text',    title: 'Cron',       width: 100 },
        { name: 'enabled',    type: 'boolean', title: 'On',         width: 35 },
        { name: 'runCount',   type: 'integer', title: 'Runs',       width: 45 },
        { name: 'nextRunAt',  type: 'integer', title: 'Next Run',   width: 80, _formatter: 'timestamp' },
        { name: 'modifiedAt', type: 'integer', title: 'Modified',   width: 80, _formatter: 'timestamp' },
      ],
    },
    {
      ID: 'BridgeCommands',
      fields: [
        { name: 'id',        type: 'integer', primaryKey: true, hidden: true },
        { name: 'type',      type: 'text',    title: 'Type',      width: 160 },
        { name: 'summary',   type: 'text',    title: 'Summary',   width: '*' },
        { name: 'timestamp', type: 'text',    title: 'Time',      width: 80 },
      ],
    },
    {
      ID: 'Recipes',
      fields: [
        { name: 'id',         type: 'integer', primaryKey: true, hidden: true },
        { name: 'name',       type: 'text',    title: 'Recipe',     width: '*' },
        { name: 'modifiedAt', type: 'integer', title: 'Modified',   width: 100, _formatter: 'timestamp' },
      ],
    },
    {
      ID: 'ScriptRuns',
      fields: [
        { name: 'id',            type: 'integer', primaryKey: true, hidden: true },
        { name: 'scriptId',      type: 'text',    hidden: true },
        { name: 'name',          type: 'text',    title: 'Script',    width: '*' },
        { name: 'state',         type: 'text',    title: 'State',     width: 80 },
        { name: 'startedAt',     type: 'integer', title: 'Started',   width: 100, _formatter: 'timestamp' },
        { name: 'completedAt',   type: 'integer', title: 'Completed', width: 100, _formatter: 'timestamp' },
        { name: 'durationMs',    type: 'integer', title: 'Duration',  width: 70 },
        { name: 'step',          type: 'integer', title: 'Step',      width: 40 },
        { name: 'totalSteps',    type: 'integer', title: 'Total',     width: 40 },
        { name: 'artifactCount', type: 'integer', title: 'Artifacts', width: 60 },
      ],
    },
    {
      ID: 'ScriptArtifacts',
      fields: [
        { name: 'id',          type: 'integer', primaryKey: true, hidden: true },
        { name: 'runId',       type: 'text',    hidden: true },
        { name: 'type',        type: 'text',    title: 'Type',     width: 80 },
        { name: 'label',       type: 'text',    title: 'Label',    width: '*' },
        { name: 'timestamp',   type: 'integer', title: 'Time',     width: 80 },
        { name: 'size',        type: 'integer', title: 'Size',     width: 60 },
        { name: 'data',        type: 'text',    hidden: true },
        { name: 'diskPath',    type: 'text',    hidden: true },
        { name: 'contentType', type: 'text',    hidden: true },
      ],
    },
    {
      // Run plans flattened into TreeGrid rows. Each plan is a parent;
      // each step is a child with parentId = plan.id.
      // The bridge backend (RunPlans in datasource-handlers.js) returns
      // this shape.
      ID: 'RunPlans',
      fields: [
        { name: 'id',         type: 'text',    primaryKey: true, hidden: true },
        { name: 'parentId',   type: 'text',    hidden: true },
        { name: 'isPlan',     type: 'boolean', hidden: true },
        { name: 'name',       type: 'text',    title: 'Name',     width: '*' },
        { name: 'enabled',    type: 'boolean', title: 'On',       width: 35 },
        { name: 'stepCount',  type: 'integer', title: 'Steps',    width: 50 },
        { name: 'args',       type: 'text',    title: 'Args',     width: '*' },
        { name: 'updatedAt',  type: 'text',    title: 'Updated',  width: 150 },
        { name: 'description',type: 'text',    hidden: true },
        { name: 'script',     type: 'text',    hidden: true },
        { name: 'stepId',     type: 'text',    hidden: true },
        { name: 'stopOnFailure', type: 'boolean', hidden: true },
        { name: 'argsObj',    type: 'text',    hidden: true },
        { name: 'schedule',   type: 'text',    hidden: true },
      ],
    },
  ],

  layout: {
    _type: 'VLayout',
    width: '100%',
    height: '100%',
    members: [

      // ---- Top toolbar ----
      {
        _type: 'ToolStrip',
        ID: 'dashToolbar',
        height: 44,
        membersMargin: 4,
        members: [
          // File menu
          {
            _type: 'ToolStripMenuButton',
            ID: 'tbFileMenu',
            title: 'File',
            menu: {
              _type: 'Menu',
              data: [
                { title: 'Open Script...' },
                { title: 'Save' },
                { title: 'Save As...' },
              ],
            },
          },
          { _type: 'ToolStripSeparator' },

          // Bridge status
          {
            _type: 'Canvas',
            ID: 'tbStatusDot',
            width: 14,
            height: 14,
            contents: '<div id="sc-status-dot" style="width:10px;height:10px;border-radius:50%;background:#f44336;margin:2px;"></div>',
          },
          {
            _type: 'Label',
            ID: 'tbStatusLabel',
            contents: 'Disconnected',
            width: 100,
            wrap: false,
          },
          {
            _type: 'ToolStripButton',
            ID: 'tbConnect',
            title: 'Connect',
            _action: 'bridgeConnect',
          },
          { _type: 'ToolStripSeparator' },

          // Script control
          {
            _type: 'ToolStripButton',
            ID: 'tbRun',
            title: 'Run',
            disabled: true,
          },
          {
            _type: 'ToolStripMenuButton',
            ID: 'tbSessionRun',
            title: 'Session',
            disabled: true,
          },
          {
            _type: 'ToolStripButton',
            ID: 'tbPause',
            title: 'Pause',
            disabled: true,
            _action: 'scriptPause',
            _targetGrid: 'scriptsGrid',
          },
          {
            _type: 'ToolStripButton',
            ID: 'tbResume',
            title: 'Resume',
            disabled: true,
            _action: 'scriptResume',
            _targetGrid: 'scriptsGrid',
          },
          {
            _type: 'ToolStripButton',
            ID: 'tbStop',
            title: 'Stop',
            disabled: true,
            _action: 'scriptCancel',
            _targetGrid: 'scriptsGrid',
          },
          { _type: 'ToolStripSeparator' },

          // Debug controls
          {
            _type: 'ToolStripButton',
            ID: 'tbStep',
            title: 'Step',
            disabled: true,
            _action: 'scriptStep',
            _messageType: 'SCRIPT_STEP',
            _messagePayload: { clearAll: false },
          },
          {
            _type: 'ToolStripButton',
            ID: 'tbContinue',
            title: 'Continue',
            disabled: true,
            _action: 'scriptStep',
            _messageType: 'SCRIPT_STEP',
            _messagePayload: { clearAll: true },
          },
          {
            _type: 'ToolStripButton',
            ID: 'tbKill',
            title: 'Kill',
            disabled: true,
            _action: 'scriptCancel',
            _targetGrid: 'scriptsGrid',
            _messagePayload: { force: true },
          },
          { _type: 'ToolStripSeparator' },

          // V8 debug controls
          {
            _type: 'ToolStripButton',
            ID: 'tbDebug',
            title: 'Debug',
            disabled: true,
            _action: 'debugLaunch',
          },
          {
            _type: 'ToolStripButton',
            ID: 'tbStepInto',
            title: 'Step Into',
            disabled: true,
            _action: 'v8Step',
            _messageType: 'DBG_STEP_INTO',
          },
          {
            _type: 'ToolStripButton',
            ID: 'tbStepOut',
            title: 'Step Out',
            disabled: true,
            _action: 'v8Step',
            _messageType: 'DBG_STEP_OUT',
          },
          // Auth capture
          {
            _type: 'ToolStripButton',
            ID: 'tbAuth',
            title: 'Auth',
            disabled: true,
          },
          { _type: 'ToolStripSeparator' },

          // Session recording
          {
            _type: 'ToolStripButton',
            ID: 'tbTrace',
            title: 'Trace',
            disabled: true,
          },
          {
            _type: 'ToolStripButton',
            ID: 'tbVideo',
            title: 'Video',
            disabled: true,
          },
          { _type: 'ToolStripSeparator' },
          // IDB Sync
          {
            _type: 'ToolStripButton',
            ID: 'tbSync',
            title: 'Sync',
            icon: '[SKINIMG]actions/refresh.png',
            _action: 'idbSync',
          },
          // Help
          {
            _type: 'ToolStripButton',
            ID: 'tbHelp',
            title: '?',
            width: 28,
            prompt: 'Help',
          },
        ],
      },

      // ---- PortalLayout (3 columns) ----
      {
        _type: 'PortalLayout',
        ID: 'dashPortal',
        width: '100%',
        height: '*',
        numColumns: 3,
        columnWidths: ['260px', '*', '280px'],
        canResizePortlets: true,
        showColumnMenus: false,

        portlets: [

          // ==== Column 0: Sessions ====
          {
            _type: 'Portlet',
            _column: 0,
            _row: 0,
            title: 'Sessions',
            height: 200,
            members: [
              {
                _type: 'VLayout',
                width: '100%',
                height: '100%',
                members: [
                  {
                    _type: 'ListGrid',
                    ID: 'sessionsGrid',
                    width: '100%',
                    height: '*',
                    dataSource: 'BridgeSessions',
                    autoFetchData: true,
                    selectionType: 'single',
                    canEdit: false,
                    showHeader: true,
                    fields: [
                      { name: 'name',   width: '*' },
                      { name: 'state',  width: 80, title: 'Status' },
                    ],
                  },
                  {
                    _type: 'HLayout',
                    height: 30,
                    membersMargin: 4,
                    layoutMargin: 4,
                    members: [
                      {
                        _type: 'Button',
                        ID: 'btnNewSession',
                        title: 'New',
                        width: 60,
                        _action: 'newSession',
                      },
                      {
                        _type: 'Button',
                        title: 'Destroy',
                        width: 60,
                        _action: 'dispatch',
                        _messageType: 'SESSION_DESTROY',
                        _payloadFrom: 'sessionsGrid',
                      },
                    ],
                  },
                ],
              },
            ],
          },

          // ==== Column 0: Scripts (Library) ====
          {
            _type: 'Portlet',
            _column: 0,
            _row: 1,
            title: 'Scripts',
            height: 280,
            members: [
              {
                _type: 'VLayout',
                width: '100%',
                height: '100%',
                members: [
                  {
                    _type: 'ListGrid',
                    ID: 'scriptsLibraryGrid',
                    width: '100%',
                    height: '*',
                    selectionType: 'single',
                    canEdit: false,
                    showHeader: true,
                    sortField: 'modifiedAt',
                    sortDirection: 'descending',
                    fields: [
                      { name: 'name',       type: 'text',    title: 'Name',     width: '*' },
                      { name: 'modifiedAt', type: 'integer', title: 'Modified', width: 80 },
                      { name: 'size',       type: 'integer', title: 'Size',     width: 50 },
                    ],
                    emptyMessage: 'No scripts imported',
                  },
                  {
                    _type: 'ListGrid',
                    ID: 'scriptVersionsGrid',
                    width: '100%',
                    height: 100,
                    selectionType: 'single',
                    canEdit: false,
                    showHeader: true,
                    sortField: 'modifiedAt',
                    sortDirection: 'descending',
                    fields: [
                      { name: 'modifiedAt', type: 'integer', title: 'Modified', width: '*' },
                      { name: 'size',       type: 'integer', title: 'Size',     width: 50 },
                    ],
                    emptyMessage: 'Select a script to view versions',
                  },
                  {
                    _type: 'HLayout',
                    height: 30,
                    membersMargin: 4,
                    layoutMargin: 4,
                    defaultLayoutAlign: 'center',
                    members: [
                      {
                        _type: 'DynamicForm',
                        ID: 'recipePickerForm',
                        width: '*',
                        numCols: 2,
                        colWidths: [50, '*'],
                        fields: [
                          {
                            name: 'recipeId',
                            title: 'Recipe',
                            editorType: 'SelectItem',
                            ID: 'recipeSelect',
                            width: '*',
                            allowEmptyValue: true,
                            emptyDisplayValue: '(none)',
                          },
                        ],
                      },
                      {
                        _type: 'Button',
                        ID: 'btnAssignRecipe',
                        title: 'Assign',
                        width: 60,
                      },
                    ],
                  },
                ],
              },
            ],
          },

          // ==== Column 0: Script History (running/completed) ====
          {
            _type: 'Portlet',
            _column: 0,
            _row: 2,
            title: 'Script History',
            height: 240,
            members: [
              {
                _type: 'VLayout',
                width: '100%',
                height: '100%',
                members: [
                  {
                    _type: 'HLayout',
                    height: 28,
                    membersMargin: 4,
                    layoutMargin: 4,
                    defaultLayoutAlign: 'center',
                    members: [
                      {
                        _type: 'Button',
                        ID: 'btnHistoryLive',
                        title: 'Live',
                        width: 60,
                        baseStyle: 'toolStripButton',
                      },
                      {
                        _type: 'Button',
                        ID: 'btnHistoryArchive',
                        title: 'Archive',
                        width: 60,
                        baseStyle: 'toolStripButton',
                      },
                    ],
                  },
                  {
                    _type: 'ListGrid',
                    ID: 'scriptsGrid',
                    width: '100%',
                    height: '*',
                    dataSource: 'BridgeScripts',
                    autoFetchData: true,
                    selectionType: 'single',
                    canEdit: false,
                    sortField: 'startedAt',
                    sortDirection: 'descending',
                    fields: [
                      { name: 'name',      width: '*' },
                      { name: 'state',     width: 80, _formatter: 'stateDot' },
                      { name: 'step',      width: 35 },
                      { name: 'totalSteps', width: 35, title: '/' },
                      { name: 'startedAt', type: 'integer', width: 90, title: 'Started', _formatter: 'timestamp' },
                    ],
                    _action: 'select',
                    _targetForm: 'debugViewer',
                  },
                ],
              },
            ],
          },

          // ==== Column 0: Schedules ====
          {
            _type: 'Portlet',
            _column: 0,
            _row: 3,
            title: 'Schedules',
            height: 360,
            members: [
              {
                _type: 'VLayout',
                width: '100%',
                height: '100%',
                members: [
                  {
                    _type: 'ListGrid',
                    ID: 'schedulesGrid',
                    width: '100%',
                    height: '*',
                    dataSource: 'BridgeSchedules',
                    autoFetchData: true,
                    selectionType: 'single',
                    recordEnabledProperty: '_gridEnabled',
                    canEdit: true,
                    editEvent: 'doubleClick',
                    modalEditing: false,
                    autoSaveEdits: true,
                    fields: [
                      { name: 'name',       width: '*',  canEdit: true },
                      { name: 'scriptName', width: 80,   canEdit: true },
                      { name: 'cronExpr',   title: 'Schedule', width: 90,  canEdit: false },
                      { name: 'enabled',    width: 35,   canEdit: true },
                      { name: 'runCount',   width: 40,   canEdit: false },
                      { name: 'nextRunAt',  width: 75,   canEdit: false },
                    ],
                  },
                  {
                    _type: 'ListGrid',
                    ID: 'scheduleRunsGrid',
                    width: '100%',
                    height: 120,
                    showHeader: true,
                    selectionType: 'none',
                    canEdit: false,
                    emptyMessage: 'Select a schedule to view run history',
                    fields: [
                      { name: 'startedAt',  type: 'integer', title: 'Started',  width: 90, _formatter: 'timestamp' },
                      { name: 'state',       type: 'text',    title: 'State',    width: 70 },
                      { name: 'durationMs',  type: 'integer', title: 'Duration', width: 70 },
                      { name: 'error',       type: 'text',    title: 'Error',    width: '*' },
                    ],
                  },
                  {
                    _type: 'HLayout',
                    height: 30,
                    membersMargin: 4,
                    layoutMargin: 4,
                    members: [
                      {
                        _type: 'Button',
                        ID: 'btnNewSchedule',
                        title: 'New',
                        width: 60,
                        _action: 'newSchedule',
                      },
                      {
                        _type: 'Button',
                        ID: 'btnEditSchedule',
                        title: 'Edit',
                        width: 60,
                        _action: 'editSchedule',
                      },
                      {
                        _type: 'Button',
                        title: 'Trigger',
                        width: 60,
                        _action: 'dispatch',
                        _messageType: 'SCHEDULE_TRIGGER',
                        _payloadFrom: 'schedulesGrid',
                      },
                      {
                        _type: 'Button',
                        title: 'Delete',
                        width: 60,
                        _action: 'dispatch',
                        _messageType: 'SCHEDULE_DELETE',
                        _payloadFrom: 'schedulesGrid',
                      },
                    ],
                  },
                ],
              },
            ],
          },

          // ==== Column 0, row 4: Automation (Run Plans) ====
          {
            _type: 'Portlet',
            _column: 0,
            _row: 4,
            title: 'Automation (Run Plans)',
            height: 320,
            members: [
              {
                _type: 'VLayout',
                width: '100%',
                height: '100%',
                members: [
                  {
                    _type: 'TreeGrid',
                    ID: 'runPlansTree',
                    width: '100%',
                    height: '*',
                    dataSource: 'RunPlans',
                    autoFetchData: true,
                    selectionType: 'single',
                    showOpenIcons: true,
                    showConnectors: true,
                    canEdit: false,
                    // Don't fold parent rows on double-click of body — only the
                    // explicit +/- icon should toggle expand. Otherwise the
                    // double-click is captured here and our context menu /
                    // edit affordances feel hijacked.
                    openOnDoubleClick: false,
                    parentIdField: 'parentId',
                    idField: 'id',
                    rootValue: null,
                    showHeader: true,
                    fields: [
                      { name: 'name',         title: 'Name',     width: '*',  treeField: true },
                      { name: 'enabled',      title: 'On',       type: 'boolean', width: 35 },
                      { name: 'stepCount',    title: 'Steps',    width: 50 },
                      { name: 'args',         title: 'Args',     width: '*' },
                      { name: 'updatedAt',    title: 'Updated',  width: 150 },
                    ],
                    emptyMessage: 'No run plans yet — click New Plan to create one',
                  },
                  {
                    _type: 'HLayout',
                    height: 30,
                    membersMargin: 4,
                    layoutMargin: 4,
                    members: [
                      {
                        _type: 'Button',
                        ID: 'btnNewRunPlan',
                        title: 'New Plan',
                        width: 80,
                        _action: 'newRunPlan',
                      },
                      {
                        _type: 'Button',
                        ID: 'btnRunRunPlan',
                        title: 'Run',
                        width: 60,
                        _action: 'runRunPlan',
                      },
                      {
                        _type: 'Button',
                        ID: 'btnDeleteRunPlan',
                        title: 'Delete',
                        width: 70,
                        _action: 'deleteRunPlan',
                      },
                      {
                        _type: 'Button',
                        ID: 'btnRefreshRunPlans',
                        title: 'Refresh',
                        width: 70,
                        _action: 'refreshRunPlans',
                      },
                    ],
                  },
                ],
              },
            ],
          },

          // ==== Column 1: Source (read-only viewer + Edit button) ====
          {
            _type: 'Portlet',
            _column: 1,
            _row: 0,
            title: 'Source',
            height: '100%',
            members: [
              {
                _type: 'VLayout',
                width: '100%',
                height: '100%',
                members: [
                  {
                    _type: 'HLayout',
                    height: 26,
                    width: '100%',
                    membersMargin: 4,
                    layoutMargin: 2,
                    members: [
                      {
                        _type: 'Button',
                        ID: 'btnEditSource',
                        title: 'Edit',
                        width: 50,
                        height: 22,
                      },
                      {
                        _type: 'Label',
                        ID: 'sourceLabel',
                        width: '*',
                        height: 22,
                        contents: '<span style="font-size:11px;color:#888;">Select a script, click Edit to open editor</span>',
                      },
                    ],
                  },
                  {
                    _type: 'HTMLFlow',
                    ID: 'sourceViewer',
                    width: '100%',
                    height: '*',
                    overflow: 'auto',
                    contents: '<pre style="padding:8px;margin:0;font-size:12px;line-height:1.5;'
                      + 'font-family:Consolas,Monaco,monospace;background:#1e1e1e;color:#d4d4d4;'
                      + 'white-space:pre-wrap;word-break:break-word;min-height:100%;">'
                      + '<span style="color:#6a9955">// Select a script from the Scripts grid to view source</span></pre>',
                  },
                ],
              },
            ],
          },

          // ==== Column 1: Recipe (pre/post actions) ====
          {
            _type: 'Portlet',
            _column: 1,
            _row: 1,
            title: 'Recipe',
            height: 260,
            members: [
              {
                _type: 'VLayout',
                width: '100%',
                height: '100%',
                membersMargin: 2,
                layoutMargin: 4,
                members: [
                  {
                    _type: 'HLayout',
                    height: 24,
                    membersMargin: 4,
                    members: [
                      { _type: 'Label', contents: '<b>PRE-ACTIONS</b>', width: '*', height: 24 },
                      { _type: 'Button', ID: 'btnAddPre', title: '+Add', width: 50, height: 22 },
                    ],
                  },
                  {
                    _type: 'ListGrid',
                    ID: 'preActionsGrid',
                    width: '100%',
                    height: '*',
                    showHeader: false,
                    selectionType: 'single',
                    canReorderRecords: true,
                    canEdit: false,
                    emptyMessage: 'No pre-actions',
                    fields: [
                      { name: 'idx', title: '#', width: 25, canEdit: false },
                      { name: 'summary', title: 'Action', width: '*', canEdit: false },
                      { name: '_remove', title: ' ', width: 25, type: 'icon', cellIcon: '[SKIN]/actions/remove.png', canEdit: false },
                    ],
                  },
                  {
                    _type: 'HLayout',
                    height: 24,
                    membersMargin: 4,
                    members: [
                      { _type: 'Label', contents: '<b>POST-ACTIONS</b>', width: '*', height: 24 },
                      { _type: 'Button', ID: 'btnAddPost', title: '+Add', width: 50, height: 22 },
                    ],
                  },
                  {
                    _type: 'ListGrid',
                    ID: 'postActionsGrid',
                    width: '100%',
                    height: '*',
                    showHeader: false,
                    selectionType: 'single',
                    canReorderRecords: true,
                    canEdit: false,
                    emptyMessage: 'No post-actions',
                    fields: [
                      { name: 'idx', title: '#', width: 25, canEdit: false },
                      { name: 'summary', title: 'Action', width: '*', canEdit: false },
                      { name: '_remove', title: ' ', width: 25, type: 'icon', cellIcon: '[SKIN]/actions/remove.png', canEdit: false },
                    ],
                  },
                  {
                    _type: 'HLayout',
                    height: 28,
                    membersMargin: 4,
                    defaultLayoutAlign: 'center',
                    members: [
                      { _type: 'Button', ID: 'btnSaveRecipe', title: 'Save Recipe', width: 100 },
                    ],
                  },
                ],
              },
            ],
          },

          // ==== Column 2: Script Detail (State + Artifacts tabs) ====
          {
            _type: 'Portlet',
            _column: 2,
            _row: 0,
            title: 'Script Detail',
            height: 380,
            members: [
              {
                _type: 'TabSet',
                ID: 'scriptDetailTabs',
                width: '100%',
                height: '100%',
                tabs: [
                  {
                    title: 'State',
                    pane: {
                      _type: 'VLayout',
                      width: '100%',
                      height: '100%',
                      members: [
                        {
                          _type: 'DetailViewer',
                          ID: 'debugViewer',
                          width: '100%',
                          height: '*',
                          fields: [
                            { name: 'name',      title: 'Script' },
                            { name: 'state',     title: 'State' },
                            { name: 'step',      title: 'Step' },
                            { name: 'totalSteps', title: 'Total' },
                            { name: 'activity',  title: 'Activity' },
                            { name: 'sessionId', title: 'Session' },
                          ],
                          emptyMessage: 'Select a script',
                        },
                        {
                          _type: 'HLayout',
                          height: 30,
                          membersMargin: 4,
                          layoutMargin: 4,
                          members: [
                            {
                              _type: 'Button',
                              ID: 'dbgStep',
                              title: 'Step',
                              width: 60,
                              disabled: true,
                              _action: 'scriptStep',
                              _messageType: 'SCRIPT_STEP',
                              _messagePayload: { clearAll: false },
                            },
                            {
                              _type: 'Button',
                              ID: 'dbgContinue',
                              title: 'Continue',
                              width: 70,
                              disabled: true,
                              _action: 'scriptStep',
                              _messageType: 'SCRIPT_STEP',
                              _messagePayload: { clearAll: true },
                            },
                            {
                              _type: 'Button',
                              ID: 'dbgKill',
                              title: 'Kill',
                              width: 50,
                              disabled: true,
                              _action: 'scriptCancel',
                              _targetGrid: 'scriptsGrid',
                              _messagePayload: { force: true },
                            },
                          ],
                        },
                      ],
                    },
                  },
                  {
                    title: 'Assertions',
                    pane: {
                      _type: 'VLayout',
                      width: '100%',
                      height: '100%',
                      members: [
                        {
                          _type: 'Label',
                          ID: 'assertionSummaryLabel',
                          width: '100%',
                          height: 24,
                          contents: '',
                          padding: 4,
                        },
                        {
                          _type: 'ListGrid',
                          ID: 'assertionsGrid',
                          width: '100%',
                          height: '*',
                          selectionType: 'none',
                          canEdit: false,
                          showHeader: true,
                          emptyMessage: 'No assertions recorded',
                          fields: [
                            { name: 'passed', type: 'boolean', title: 'OK',      width: 35 },
                            { name: 'message', type: 'text',   title: 'Assertion', width: '*' },
                            { name: 'time',   type: 'integer', title: 'Time',     width: 70, _formatter: 'timestamp' },
                          ],
                        },
                      ],
                    },
                  },
                  {
                    title: 'Artifacts',
                    pane: {
                      _type: 'VLayout',
                      width: '100%',
                      height: '100%',
                      members: [
                        {
                          _type: 'ListGrid',
                          ID: 'artifactsGrid',
                          width: '100%',
                          height: 160,
                          selectionType: 'single',
                          canEdit: false,
                          showHeader: true,
                          emptyMessage: 'No artifacts',
                          fields: [
                            { name: 'type',      type: 'text',    title: 'Type',  width: 70 },
                            { name: 'label',     type: 'text',    title: 'Label', width: '*' },
                            { name: 'timestamp', type: 'integer', title: 'Time',  width: 70 },
                            { name: 'size',      type: 'integer', title: 'Size',  width: 60 },
                          ],
                        },
                        {
                          _type: 'HTMLFlow',
                          ID: 'artifactPreview',
                          width: '100%',
                          height: '*',
                          overflow: 'auto',
                          contents: '<div style="padding:8px;color:#888;font-size:11px;">Select an artifact to preview</div>',
                        },
                      ],
                    },
                  },
                  {
                    title: 'Console',
                    pane: {
                      _type: 'VLayout',
                      width: '100%',
                      height: '100%',
                      members: [
                        {
                          _type: 'HLayout',
                          height: 28,
                          membersMargin: 4,
                          layoutMargin: 4,
                          defaultLayoutAlign: 'center',
                          members: [
                            {
                              _type: 'Button',
                              ID: 'btnRefreshConsole',
                              title: 'Refresh',
                              width: 60,
                              baseStyle: 'toolStripButton',
                            },
                            {
                              _type: 'Label',
                              ID: 'consoleSummaryLabel',
                              width: '*',
                              height: 20,
                              contents: '',
                            },
                          ],
                        },
                        {
                          _type: 'HTMLFlow',
                          ID: 'consoleOutput',
                          width: '100%',
                          height: '*',
                          overflow: 'auto',
                          contents: '<div style="padding:8px;color:#888;font-size:11px;">Select a session to view console</div>',
                        },
                      ],
                    },
                  },
                  {
                    title: 'Network',
                    pane: {
                      _type: 'VLayout',
                      width: '100%',
                      height: '100%',
                      members: [
                        {
                          _type: 'HLayout',
                          height: 28,
                          membersMargin: 4,
                          layoutMargin: 4,
                          defaultLayoutAlign: 'center',
                          members: [
                            {
                              _type: 'Button',
                              ID: 'btnRefreshNetwork',
                              title: 'Refresh',
                              width: 60,
                              baseStyle: 'toolStripButton',
                            },
                            {
                              _type: 'Label',
                              ID: 'networkSummaryLabel',
                              width: '*',
                              height: 20,
                              contents: '',
                            },
                          ],
                        },
                        {
                          _type: 'HTMLFlow',
                          ID: 'networkOutput',
                          width: '100%',
                          height: '*',
                          overflow: 'auto',
                          contents: '<div style="padding:8px;color:#888;font-size:11px;">Select a session to view network</div>',
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },

          // ==== Column 2: Evaluate ====
          {
            _type: 'Portlet',
            _column: 2,
            _row: 1,
            title: 'Evaluate',
            height: 220,
            visibility: 'hidden',
            ID: 'evalPortlet',
            members: [
              {
                _type: 'VLayout',
                width: '100%',
                height: '100%',
                membersMargin: 4,
                layoutMargin: 4,
                members: [
                  {
                    _type: 'DynamicForm',
                    ID: 'evalForm',
                    width: '100%',
                    numCols: 1,
                    fields: [
                      {
                        name: 'callFrame',
                        title: 'Frame',
                        editorType: 'SelectItem',
                        ID: 'evalFrameSelect',
                        width: '*',
                      },
                      {
                        name: 'expression',
                        title: 'Expr',
                        editorType: 'TextAreaItem',
                        ID: 'evalInput',
                        width: '*',
                        height: 60,
                      },
                    ],
                  },
                  {
                    _type: 'HLayout',
                    height: 28,
                    membersMargin: 4,
                    members: [
                      {
                        _type: 'Button',
                        ID: 'evalRunBtn',
                        title: 'Run',
                        width: 60,
                        _action: 'evalExpression',
                      },
                    ],
                  },
                  {
                    _type: 'HTMLFlow',
                    ID: 'evalResult',
                    width: '100%',
                    height: '*',
                    overflow: 'auto',
                    contents: '<div style="padding:4px;color:#888;font-family:monospace;font-size:11px;">Result will appear here</div>',
                  },
                ],
              },
            ],
          },

          // ==== Column 2: Activity ====
          {
            _type: 'Portlet',
            _column: 2,
            _row: 2,
            title: 'Activity',
            height: 360,
            members: [
              {
                _type: 'ListGrid',
                ID: 'activityGrid',
                width: '100%',
                height: '100%',
                dataSource: 'BridgeCommands',
                autoFetchData: true,
                canEdit: false,
                showHeader: true,
                sortField: 'timestamp',
                sortDirection: 'descending',
                fields: [
                  { name: 'type',      width: 140 },
                  { name: 'summary',   width: '*' },
                  { name: 'timestamp', width: 70, _formatter: 'timestamp' },
                ],
              },
            ],
          },

          // ==== Column 2: Test Results ====
          {
            _type: 'Portlet',
            _column: 2,
            _row: 3,
            title: 'Test Results',
            height: 220,
            members: [
              {
                _type: 'VLayout',
                width: '100%',
                height: '100%',
                membersMargin: 4,
                members: [
                  {
                    _type: 'HLayout',
                    height: 28,
                    membersMargin: 4,
                    members: [
                      {
                        _type: 'Button',
                        ID: 'btnRunTests',
                        title: 'Run All Tests',
                        width: 100,
                      },
                      {
                        _type: 'Button',
                        ID: 'btnRefreshTests',
                        title: 'Refresh',
                        width: 70,
                      },
                      {
                        _type: 'Label',
                        ID: 'testStatusLabel',
                        width: '*',
                        height: 24,
                        contents: '',
                      },
                    ],
                  },
                  {
                    _type: 'ListGrid',
                    ID: 'testResultsGrid',
                    width: '100%',
                    height: '*',
                    canEdit: false,
                    showHeader: true,
                    sortField: 'completedAt',
                    sortDirection: 'descending',
                    fields: [
                      { name: 'name',       title: 'Test',   width: '*' },
                      { name: 'pass',       title: 'Pass',   width: 40 },
                      { name: 'fail',       title: 'Fail',   width: 40 },
                      { name: 'state',      title: 'Status', width: 60 },
                      { name: 'durationMs', title: 'ms',     width: 50 },
                    ],
                    data: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};
