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

  // Search (routed to extension)
  BRIDGE_SEARCH_SNAPSHOTS: 'BRIDGE_SEARCH_SNAPSHOTS',

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
