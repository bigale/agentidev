/**
 * SC-4b: Dashboard PortalLayout configuration.
 * Sets window._dashboardConfig consumed by dashboard-app.js → renderConfig().
 *
 * DataSources: BridgeSessions, BridgeScripts, BridgeSchedules, BridgeCommands
 * Layout: VLayout → ToolStrip + PortalLayout (3 columns)
 */

window._dashboardConfig = {

  dataSources: [
    {
      ID: 'BridgeSessions',
      fields: [
        { name: 'id',     type: 'text',    primaryKey: true, hidden: true },
        { name: 'name',   type: 'text',    title: 'Name',   width: '*' },
        { name: 'status', type: 'text',    title: 'Status', width: 80 },
      ],
    },
    {
      ID: 'BridgeScripts',
      fields: [
        { name: 'id',         type: 'text',    primaryKey: true, hidden: true },
        { name: 'name',       type: 'text',    title: 'Script',  width: '*' },
        { name: 'state',      type: 'text',    title: 'State',   width: 100 },
        { name: 'step',       type: 'integer', title: 'Step',    width: 50 },
        { name: 'totalSteps', type: 'integer', title: 'Total',   width: 50 },
        { name: 'sessionId',  type: 'text',    hidden: true },
        { name: 'activity',   type: 'text',    title: 'Activity', width: 120 },
      ],
    },
    {
      ID: 'BridgeSchedules',
      fields: [
        { name: 'id',       type: 'text',    primaryKey: true, hidden: true },
        { name: 'name',     type: 'text',    title: 'Name',     width: '*' },
        { name: 'cron',     type: 'text',    title: 'Cron',     width: 100 },
        { name: 'enabled',  type: 'boolean', title: 'Enabled',  width: 60 },
        { name: 'lastRun',  type: 'text',    title: 'Last Run', width: 100 },
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
            _action: 'dispatch',
            _messageType: 'SCRIPT_LAUNCH',
            _payloadFrom: 'scriptsGrid',
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
            _action: 'dispatch',
            _messageType: 'SCRIPT_STEP',
            _messagePayload: { clearAll: false },
          },
          {
            _type: 'ToolStripButton',
            ID: 'tbContinue',
            title: 'Continue',
            disabled: true,
            _action: 'dispatch',
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
                      { name: 'status', width: 80 },
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
                        title: 'New',
                        width: 60,
                        _action: 'dispatch',
                        _messageType: 'SESSION_CREATE',
                        _messagePayload: { name: 'Session' },
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

          // ==== Column 0: Scripts ====
          {
            _type: 'Portlet',
            _column: 0,
            _row: 1,
            title: 'Scripts',
            height: 260,
            members: [
              {
                _type: 'ListGrid',
                ID: 'scriptsGrid',
                width: '100%',
                height: '100%',
                dataSource: 'BridgeScripts',
                autoFetchData: true,
                selectionType: 'single',
                canEdit: false,
                fields: [
                  { name: 'name',  width: '*' },
                  { name: 'state', width: 90, _formatter: 'stateDot' },
                  { name: 'step',  width: 40 },
                  { name: 'totalSteps', width: 40, title: '/' },
                ],
                _action: 'select',
                _targetForm: 'debugViewer',
              },
            ],
          },

          // ==== Column 0: Schedules ====
          {
            _type: 'Portlet',
            _column: 0,
            _row: 2,
            title: 'Schedules',
            height: 200,
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
                    canEdit: false,
                    fields: [
                      { name: 'name',    width: '*' },
                      { name: 'cron',    width: 80 },
                      { name: 'enabled', width: 50 },
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

          // ==== Column 1: Source (placeholder) ====
          {
            _type: 'Portlet',
            _column: 1,
            _row: 0,
            title: 'Source',
            height: '100%',
            members: [
              {
                _type: 'HTMLFlow',
                ID: 'sourcePanel',
                width: '100%',
                height: '100%',
                contents: '<div style="padding:24px;color:#888;font-family:monospace;font-size:13px;">'
                  + 'Source editor placeholder.<br>Monaco integration planned for SC-4c.</div>',
              },
            ],
          },

          // ==== Column 2: Debug State ====
          {
            _type: 'Portlet',
            _column: 2,
            _row: 0,
            title: 'Debug State',
            height: 300,
            members: [
              {
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
                        _action: 'dispatch',
                        _messageType: 'SCRIPT_STEP',
                        _messagePayload: { clearAll: false },
                      },
                      {
                        _type: 'Button',
                        ID: 'dbgContinue',
                        title: 'Continue',
                        width: 70,
                        disabled: true,
                        _action: 'dispatch',
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
            ],
          },

          // ==== Column 2: Activity ====
          {
            _type: 'Portlet',
            _column: 2,
            _row: 1,
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
        ],
      },
    ],
  },
};
