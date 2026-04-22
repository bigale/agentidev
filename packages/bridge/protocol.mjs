/**
 * Bridge Protocol - Message types and envelope builder
 *
 * Every message follows: { id, type, source, timestamp, payload }
 * Used by bridge server, extension client, and Claude Code client.
 */

let messageCounter = 0;

// Message type constants
export const MSG = {
  // Connection
  BRIDGE_IDENTIFY: 'BRIDGE_IDENTIFY',
  BRIDGE_HEALTH: 'BRIDGE_HEALTH',
  BRIDGE_ERROR: 'BRIDGE_ERROR',
  BRIDGE_STATUS: 'BRIDGE_STATUS',

  // Session management
  BRIDGE_SESSION_CREATE: 'BRIDGE_SESSION_CREATE',
  BRIDGE_SESSION_DESTROY: 'BRIDGE_SESSION_DESTROY',
  BRIDGE_SESSION_LIST: 'BRIDGE_SESSION_LIST',
  BRIDGE_SESSION_CLEAN: 'BRIDGE_SESSION_CLEAN',

  // Commands
  BRIDGE_COMMAND: 'BRIDGE_COMMAND',
  BRIDGE_SNAPSHOT: 'BRIDGE_SNAPSHOT',
  BRIDGE_SNAPSHOT_RESULT: 'BRIDGE_SNAPSHOT_RESULT',
  BRIDGE_NAVIGATE: 'BRIDGE_NAVIGATE',
  BRIDGE_CLICK: 'BRIDGE_CLICK',
  BRIDGE_FILL: 'BRIDGE_FILL',
  BRIDGE_EVAL: 'BRIDGE_EVAL',

  // Search / indexing (bridge-routed or relayed to extension)
  BRIDGE_SEARCH_SNAPSHOTS: 'BRIDGE_SEARCH_SNAPSHOTS',
  BRIDGE_SEARCH_VECTORDB: 'BRIDGE_SEARCH_VECTORDB',
  BRIDGE_INDEX_CONTENT: 'BRIDGE_INDEX_CONTENT',
  BRIDGE_VECTORDB_STATS: 'BRIDGE_VECTORDB_STATS',  // stats + embedding readiness

  // Claude-specific (Phase E)
  BRIDGE_PAUSE: 'BRIDGE_PAUSE',
  BRIDGE_RESUME: 'BRIDGE_RESUME',
  BRIDGE_OVERRIDE: 'BRIDGE_OVERRIDE',

  // Script integration (Phase 3)
  BRIDGE_SCRIPT_REGISTER: 'BRIDGE_SCRIPT_REGISTER',
  BRIDGE_SCRIPT_PROGRESS: 'BRIDGE_SCRIPT_PROGRESS',
  BRIDGE_SCRIPT_COMPLETE: 'BRIDGE_SCRIPT_COMPLETE',
  BRIDGE_SCRIPT_PAUSE: 'BRIDGE_SCRIPT_PAUSE',
  BRIDGE_SCRIPT_RESUME: 'BRIDGE_SCRIPT_RESUME',
  BRIDGE_SCRIPT_CANCEL: 'BRIDGE_SCRIPT_CANCEL',
  BRIDGE_SCRIPT_LIST: 'BRIDGE_SCRIPT_LIST',
  BRIDGE_SCRIPT_LAUNCH: 'BRIDGE_SCRIPT_LAUNCH',

  // Script micro-management (debugger + force-kill)
  BRIDGE_SCRIPT_CHECKPOINT: 'BRIDGE_SCRIPT_CHECKPOINT',      // script hits named breakpoint
  BRIDGE_SCRIPT_STEP: 'BRIDGE_SCRIPT_STEP',                  // extension: advance past checkpoint
  BRIDGE_SCRIPT_SET_BREAKPOINT: 'BRIDGE_SCRIPT_SET_BREAKPOINT', // extension: toggle breakpoint
  BRIDGE_SCRIPT_VERIFY_SESSION: 'BRIDGE_SCRIPT_VERIFY_SESSION', // script: auth pre-flight
  BRIDGE_SCRIPT_SOURCE: 'BRIDGE_SCRIPT_SOURCE',              // dashboard: load script source file
  BRIDGE_SCRIPT_DECLARE_CHECKPOINT: 'BRIDGE_SCRIPT_DECLARE_CHECKPOINT', // script: add checkpoint dynamically (e.g. new page)
  BRIDGE_SCRIPT_PAGE_STATUS: 'BRIDGE_SCRIPT_PAGE_STATUS',    // script: update page URL/title for UI display
  BRIDGE_SCRIPT_SAVE: 'BRIDGE_SCRIPT_SAVE',                  // extension: save script source to disk
  BRIDGE_SCRIPT_FILE_CHANGED: 'BRIDGE_SCRIPT_FILE_CHANGED',  // server: file changed on disk (reverse sync)

  // Script polling
  BRIDGE_SCRIPT_POLL_STATE: 'BRIDGE_SCRIPT_POLL_STATE',          // script: report poll loop state

  // Script run archive & artifacts
  BRIDGE_SCRIPT_RUN_COMPLETE: 'BRIDGE_SCRIPT_RUN_COMPLETE',      // broadcast: run record + artifact manifest on completion
  BRIDGE_SCRIPT_ARTIFACT: 'BRIDGE_SCRIPT_ARTIFACT',              // broadcast: artifact captured during execution
  BRIDGE_SCRIPT_ADD_ARTIFACT: 'BRIDGE_SCRIPT_ADD_ARTIFACT',      // script→bridge: register artifact (file or inline data)
  BRIDGE_SCRIPT_GET_ARTIFACT: 'BRIDGE_SCRIPT_GET_ARTIFACT',      // request: read artifact file from disk → base64

  // Scheduling (server-side auto-launch)
  BRIDGE_SCHEDULE_CREATE: 'BRIDGE_SCHEDULE_CREATE',
  BRIDGE_SCHEDULE_UPDATE: 'BRIDGE_SCHEDULE_UPDATE',
  BRIDGE_SCHEDULE_DELETE: 'BRIDGE_SCHEDULE_DELETE',
  BRIDGE_SCHEDULE_LIST: 'BRIDGE_SCHEDULE_LIST',
  BRIDGE_SCHEDULE_TRIGGER: 'BRIDGE_SCHEDULE_TRIGGER',
  BRIDGE_SCHEDULE_HISTORY: 'BRIDGE_SCHEDULE_HISTORY',

  // V8 Inspector debugging (line-level)
  BRIDGE_DBG_SET_BREAKPOINT: 'BRIDGE_DBG_SET_BREAKPOINT',    // set breakpoint by file + line
  BRIDGE_DBG_REMOVE_BREAKPOINT: 'BRIDGE_DBG_REMOVE_BREAKPOINT',
  BRIDGE_DBG_STEP_OVER: 'BRIDGE_DBG_STEP_OVER',
  BRIDGE_DBG_STEP_INTO: 'BRIDGE_DBG_STEP_INTO',
  BRIDGE_DBG_STEP_OUT: 'BRIDGE_DBG_STEP_OUT',
  BRIDGE_DBG_CONTINUE: 'BRIDGE_DBG_CONTINUE',               // resume to next breakpoint
  BRIDGE_DBG_EVALUATE: 'BRIDGE_DBG_EVALUATE',                // eval expression in paused frame
  BRIDGE_DBG_RESTART_FRAME: 'BRIDGE_DBG_RESTART_FRAME',      // restart current frame
  BRIDGE_DBG_PAUSED: 'BRIDGE_DBG_PAUSED',                    // broadcast: script paused (V8)
  BRIDGE_DBG_RESUMED: 'BRIDGE_DBG_RESUMED',                  // broadcast: script resumed (V8)

  // Session tracing & video recording
  BRIDGE_SESSION_TRACING_START: 'BRIDGE_SESSION_TRACING_START',
  BRIDGE_SESSION_TRACING_STOP: 'BRIDGE_SESSION_TRACING_STOP',
  BRIDGE_SESSION_VIDEO_START: 'BRIDGE_SESSION_VIDEO_START',
  BRIDGE_SESSION_VIDEO_STOP: 'BRIDGE_SESSION_VIDEO_STOP',
  BRIDGE_SESSION_VIDEO_CHAPTER: 'BRIDGE_SESSION_VIDEO_CHAPTER',
  BRIDGE_SESSION_CONSOLE: 'BRIDGE_SESSION_CONSOLE',
  BRIDGE_SESSION_NETWORK: 'BRIDGE_SESSION_NETWORK',

  // Auth capture (save/load login state for scripts)
  BRIDGE_AUTH_CAPTURE: 'BRIDGE_AUTH_CAPTURE',                // start auth capture session (open browser, navigate)
  BRIDGE_AUTH_SAVE: 'BRIDGE_AUTH_SAVE',                      // save auth state from session and close it
  BRIDGE_AUTH_CHECK: 'BRIDGE_AUTH_CHECK',                    // check if auth state file exists for a script

  // System process management
  BRIDGE_SYSTEM_PROCESSES: 'BRIDGE_SYSTEM_PROCESSES',        // discover running Playwright browser processes
  BRIDGE_KILL_PROCESS: 'BRIDGE_KILL_PROCESS',                // kill a process by PID
  BRIDGE_FILE_PICKER: 'BRIDGE_FILE_PICKER',                  // open native file picker dialog
  BRIDGE_TRACE_VIEW: 'BRIDGE_TRACE_VIEW',                      // launch show-trace local server, return URL
  BRIDGE_SERVE_ARTIFACT: 'BRIDGE_SERVE_ARTIFACT',              // copy artifact to asset-server and return URL
  BRIDGE_READ_FILE: 'BRIDGE_READ_FILE',                      // read a local file (text or base64)
  BRIDGE_COPY_TO_ASSETS: 'BRIDGE_COPY_TO_ASSETS',            // copy a local file to the asset-server root

  // SmartClient AI (route through Claude Code)
  BRIDGE_SC_GENERATE_UI: 'BRIDGE_SC_GENERATE_UI',            // generate SmartClient UI config via claude -p
  BRIDGE_PUBLISH_PLUGIN: 'BRIDGE_PUBLISH_PLUGIN',            // publish plugin config (relayed to extension)
  BRIDGE_SC_CLONE_PAGE: 'BRIDGE_SC_CLONE_PAGE',              // clone a live page to SmartClient config via snapshot+screenshot+network
  BRIDGE_SC_DELETE_CLONE_ARTIFACTS: 'BRIDGE_SC_DELETE_CLONE_ARTIFACTS', // delete persisted clone artifacts by cloneId

  // IndexedDB backup / sync
  BRIDGE_IDB_SYNC: 'BRIDGE_IDB_SYNC',        // extension → bridge: push store dump to SQLite
  BRIDGE_IDB_RESTORE: 'BRIDGE_IDB_RESTORE',  // bridge → extension: send SQLite data for IDB import

  // Agentiface app persistence (Phase 5b)
  BRIDGE_AF_APP_SAVE: 'BRIDGE_AF_APP_SAVE',      // save/update app config JSON to disk
  BRIDGE_AF_APP_LOAD: 'BRIDGE_AF_APP_LOAD',      // load app config by ID from disk
  BRIDGE_AF_APP_LIST: 'BRIDGE_AF_APP_LIST',      // list all saved apps (metadata only)
  BRIDGE_AF_APP_DELETE: 'BRIDGE_AF_APP_DELETE',   // delete app config from disk

  // Agentiface project persistence
  BRIDGE_AF_PROJECT_SAVE: 'BRIDGE_AF_PROJECT_SAVE',      // save/update project to disk
  BRIDGE_AF_PROJECT_LOAD: 'BRIDGE_AF_PROJECT_LOAD',      // load project by ID from disk
  BRIDGE_AF_PROJECT_LIST: 'BRIDGE_AF_PROJECT_LIST',      // list all projects (metadata only)
  BRIDGE_AF_PROJECT_DELETE: 'BRIDGE_AF_PROJECT_DELETE',   // delete project from disk

  // Agentiface template persistence (Phase 4a)
  BRIDGE_AF_TEMPLATE_SAVE: 'BRIDGE_AF_TEMPLATE_SAVE',      // save user template to disk
  BRIDGE_AF_TEMPLATE_LIST: 'BRIDGE_AF_TEMPLATE_LIST',      // list all user templates
  BRIDGE_AF_TEMPLATE_DELETE: 'BRIDGE_AF_TEMPLATE_DELETE',   // delete user template from disk

};

/**
 * Build a message envelope
 * @param {string} type - Message type from MSG constants
 * @param {object} payload - Message payload
 * @param {string} source - Message source ('server' | 'extension' | 'claude')
 * @param {string} [replyTo] - ID of message being replied to
 * @returns {object} Complete message envelope
 */
export function buildMessage(type, payload = {}, source = 'server', replyTo = null) {
  const msg = {
    id: `msg_${Date.now()}_${++messageCounter}`,
    type,
    source,
    timestamp: Date.now(),
    payload,
  };
  if (replyTo) {
    msg.replyTo = replyTo;
  }
  return msg;
}

/**
 * Build a reply to a received message
 * @param {object} originalMsg - The message being replied to
 * @param {object} payload - Reply payload
 * @param {string} source - Reply source
 * @returns {object} Reply message envelope
 */
export function buildReply(originalMsg, payload = {}, source = 'server') {
  return buildMessage(originalMsg.type, payload, source, originalMsg.id);
}

/**
 * Build an error message
 * @param {string} error - Error message
 * @param {string} [replyTo] - ID of message that caused the error
 * @param {string} source - Source identifier
 * @returns {object} Error message envelope
 */
export function buildError(error, replyTo = null, source = 'server') {
  return buildMessage(MSG.BRIDGE_ERROR, { error }, source, replyTo);
}

/**
 * Client roles
 */
export const ROLES = {
  EXTENSION: 'extension',
  CLAUDE: 'claude',
  CLI: 'cli',
  SCRIPT: 'script',
};
