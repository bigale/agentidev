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
};
