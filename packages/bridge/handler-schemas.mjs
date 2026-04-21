/**
 * Zod schemas for bridge message handler payloads.
 *
 * Defines input/output schemas for each bridge message type. Used for:
 *   - Runtime validation of incoming messages
 *   - Auto-generated API documentation
 *   - TypeScript-style type safety without TypeScript
 *   - Self-documenting handler contracts
 *
 * Each schema exports: { input, output, description }
 */

import { object, string, number, boolean, array, optional, enum as zenum, union, literal, any } from 'zod';

// ---- Session handlers ----

export const SESSION_CREATE = {
  description: 'Create a new Playwright browser session',
  input: object({
    name: string().describe('Session name'),
    options: optional(object({
      authPath: optional(string()).describe('Path to auth state file'),
      timeout: optional(number()).describe('Command timeout in ms'),
    })),
  }),
  output: object({
    success: boolean(),
    session: optional(object({
      id: string(),
      name: string(),
      state: string(),
      cdpEndpoint: optional(string()),
    })),
  }),
};

export const SESSION_DESTROY = {
  description: 'Destroy a browser session and close its browser',
  input: object({
    sessionId: string().describe('Session ID to destroy'),
  }),
  output: object({ success: boolean() }),
};

export const SESSION_LIST = {
  description: 'List all active browser sessions',
  input: object({}),
  output: object({
    sessions: array(object({
      id: string(),
      name: string(),
      state: string(),
      currentUrl: optional(string()),
      cdpEndpoint: optional(string()),
    })),
  }),
};

// ---- Command handlers ----

export const SEND_COMMAND = {
  description: 'Send a Playwright command to a session (goto, click, fill, eval, etc.)',
  input: object({
    sessionId: string().describe('Target session ID'),
    command: string().describe('Command string (e.g. "goto https://example.com", "click e42")'),
  }),
  output: object({
    success: boolean(),
    output: optional(string()),
  }),
};

export const TAKE_SNAPSHOT = {
  description: 'Take an accessibility snapshot of the current page',
  input: object({
    sessionId: string().describe('Target session ID'),
  }),
  output: object({
    success: boolean(),
    yaml: optional(string()).describe('YAML accessibility tree'),
    url: optional(string()),
    lines: optional(number()),
  }),
};

// ---- Script handlers ----

export const SCRIPT_LAUNCH = {
  description: 'Launch a script as a child process',
  input: object({
    path: string().describe('Script file path (.mjs)'),
    args: optional(array(string())).describe('CLI arguments'),
    sessionId: optional(string()).describe('Link to session for CDP endpoint'),
    debug: optional(boolean()).describe('Launch with V8 inspector'),
    breakpoints: optional(array(string())),
  }),
  output: object({
    success: boolean(),
    launchId: optional(string()),
    pid: optional(number()),
    v8Debug: optional(boolean()),
  }),
};

export const SCRIPT_LIST = {
  description: 'List all registered scripts with their status',
  input: object({}),
  output: object({
    scripts: array(object({
      scriptId: string(),
      name: string(),
      state: string(),
      step: number(),
      total: number(),
      label: optional(string()),
      errors: number(),
    })),
  }),
};

export const SCRIPT_SAVE = {
  description: 'Save a script to disk (~/.agentidev/scripts/)',
  input: object({
    name: string().describe('Script name (no extension)'),
    source: string().describe('Script source code'),
  }),
  output: object({
    success: boolean(),
    path: optional(string()),
  }),
};

// ---- Search handlers ----

export const SEARCH_VECTORDB = {
  description: 'Semantic vector search over indexed content',
  input: object({
    query: string().describe('Natural language search query'),
    sources: optional(array(string())).describe('Filter by source: browsing, showcase, reference'),
    topK: optional(number()).describe('Number of results (default 5)'),
  }),
  output: object({
    results: array(object({
      url: optional(string()),
      title: optional(string()),
      content: optional(string()),
      similarity: optional(number()),
      source: optional(string()),
    })),
  }),
};

export const INDEX_CONTENT = {
  description: 'Index content into the vector database',
  input: object({
    url: string().describe('Content URL (for deduplication)'),
    title: string().describe('Content title'),
    text: string().describe('Content text to embed'),
    source: optional(string()).describe('Source tag: browsing, showcase, reference'),
  }),
  output: object({ success: boolean() }),
};

// ---- AI handlers ----

export const SC_GENERATE_UI = {
  description: 'Generate a SmartClient UI config via LLM',
  input: object({
    prompt: string().describe('Natural language UI description'),
    model: optional(string()).describe('LLM model to use'),
    systemPrompt: optional(string()),
  }),
  output: object({
    success: boolean(),
    config: optional(any()),
    error: optional(string()),
  }),
};

// ---- Health ----

export const HEALTH = {
  description: 'Health check',
  input: object({}),
  output: object({
    status: literal('ok'),
    uptime: number(),
    clients: number(),
    sessions: number(),
    scripts: number(),
  }),
};

// ---- Registry ----

/**
 * Map of bridge message types to their schemas.
 * Used for validation and documentation.
 */
export const SCHEMA_REGISTRY = {
  BRIDGE_SESSION_CREATE: SESSION_CREATE,
  BRIDGE_SESSION_DESTROY: SESSION_DESTROY,
  BRIDGE_SESSION_LIST: SESSION_LIST,
  BRIDGE_SEND_COMMAND: SEND_COMMAND,
  BRIDGE_TAKE_SNAPSHOT: TAKE_SNAPSHOT,
  BRIDGE_SCRIPT_LAUNCH: SCRIPT_LAUNCH,
  BRIDGE_SCRIPT_LIST: SCRIPT_LIST,
  BRIDGE_SCRIPT_SAVE: SCRIPT_SAVE,
  BRIDGE_SEARCH_VECTORDB: SEARCH_VECTORDB,
  BRIDGE_INDEX_CONTENT: INDEX_CONTENT,
  BRIDGE_SC_GENERATE_UI: SC_GENERATE_UI,
  BRIDGE_HEALTH: HEALTH,
};

/**
 * Validate an incoming message payload against its schema.
 * Returns { valid: true, data } on success, { valid: false, error } on failure.
 *
 * @param {string} type - Message type
 * @param {object} payload - Message payload
 * @returns {{ valid: boolean, data?: object, error?: string }}
 */
export function validatePayload(type, payload) {
  const schema = SCHEMA_REGISTRY[type];
  if (!schema) return { valid: true, data: payload }; // No schema = no validation

  try {
    const data = schema.input.parse(payload);
    return { valid: true, data };
  } catch (err) {
    return { valid: false, error: err.message || 'Validation failed' };
  }
}

/**
 * Get a human-readable API reference for all registered schemas.
 * @returns {string}
 */
export function getApiReference() {
  const lines = ['# Bridge API Reference\n'];
  for (const [type, schema] of Object.entries(SCHEMA_REGISTRY)) {
    lines.push(`## ${type}`);
    lines.push(schema.description || '');
    lines.push('');
  }
  return lines.join('\n');
}
