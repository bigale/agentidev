/**
 * Agent tools — typed wrappers around agentidev's SW handlers.
 *
 * Each tool dispatches to the service worker via chrome.runtime.sendMessage
 * and returns structured results for the agent loop. TypeBox schemas define
 * the parameter shapes that the LLM will fill.
 *
 * Tools are grouped by capability surface:
 *   browse_*   — Playwright session commands
 *   memory_*   — semantic vector search
 *   exec_*     — CheerpX Linux VM execution
 *   fs_*       — CheerpX filesystem
 *   network_*  — CORS-free HTTP fetch
 *   ui_*       — SmartClient UI generation
 *   plugin_*   — plugin management
 *   script_*   — automation scripts
 */

// TypeBox imported from the pi-ai re-export for convenience
// (pi-ai bundles @sinclair/typebox)
let Type = null;

async function ensureType() {
  if (Type) return Type;
  try {
    const mod = await import('../../lib/vendor/typebox/index.mjs');
    Type = mod.Type;
  } catch {
    // Fallback: define a minimal Type.Object / Type.String / etc.
    Type = {
      Object: (props, opts) => ({ type: 'object', properties: props, ...opts }),
      String: (opts) => ({ type: 'string', ...opts }),
      Number: (opts) => ({ type: 'number', ...opts }),
      Integer: (opts) => ({ type: 'integer', ...opts }),
      Boolean: (opts) => ({ type: 'boolean', ...opts }),
      Optional: (schema) => ({ ...schema, optional: true }),
      Array: (items, opts) => ({ type: 'array', items, ...opts }),
    };
  }
  return Type;
}

/**
 * Send a message to the SW and return the response.
 * Wraps chrome.runtime.sendMessage with error handling.
 */
function sendToSW(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response || {});
      }
    });
  });
}

/**
 * Helper: make a tool result from text.
 */
function textResult(text, details = {}) {
  return {
    content: [{ type: 'text', text: String(text) }],
    details,
  };
}

/**
 * Build and return the complete tool registry.
 * @returns {Promise<object[]>} Array of AgentTool objects
 */
export async function createTools() {
  const T = await ensureType();

  return [
    // ---- Browse ----

    {
      name: 'browse_navigate',
      label: 'Navigate',
      description: 'Navigate a Playwright browser session to a URL. Requires an active session.',
      parameters: T.Object({
        sessionId: T.String({ description: 'Session ID from session list' }),
        url: T.String({ description: 'URL to navigate to' }),
      }),
      execute: async (id, params) => {
        const r = await sendToSW('BRIDGE_SEND_COMMAND', { sessionId: params.sessionId, command: 'goto ' + params.url });
        return textResult(r.output || 'Navigated to ' + params.url, r);
      },
    },
    {
      name: 'browse_snapshot',
      label: 'Snapshot',
      description: 'Take an accessibility snapshot of the current page in a session. Returns a YAML tree with element refs like [ref=e42].',
      parameters: T.Object({
        sessionId: T.String({ description: 'Session ID' }),
      }),
      execute: async (id, params) => {
        const r = await sendToSW('BRIDGE_TAKE_SNAPSHOT', { sessionId: params.sessionId });
        return textResult(r.yaml || 'No snapshot', { url: r.url, lines: r.lines });
      },
    },
    {
      name: 'browse_click',
      label: 'Click',
      description: 'Click an element on the page by its ref ID (from a snapshot) or CSS selector.',
      parameters: T.Object({
        sessionId: T.String({ description: 'Session ID' }),
        target: T.String({ description: 'Element ref (e.g. e42) or CSS selector' }),
      }),
      execute: async (id, params) => {
        const r = await sendToSW('BRIDGE_SEND_COMMAND', { sessionId: params.sessionId, command: 'click ' + params.target });
        return textResult(r.output || 'Clicked ' + params.target, r);
      },
    },
    {
      name: 'browse_fill',
      label: 'Fill',
      description: 'Fill text into an input field identified by ref or selector.',
      parameters: T.Object({
        sessionId: T.String({ description: 'Session ID' }),
        target: T.String({ description: 'Element ref or selector' }),
        value: T.String({ description: 'Text to fill' }),
      }),
      execute: async (id, params) => {
        const r = await sendToSW('BRIDGE_SEND_COMMAND', { sessionId: params.sessionId, command: 'fill ' + params.target + ' ' + params.value });
        return textResult(r.output || 'Filled ' + params.target, r);
      },
    },

    // ---- Memory ----

    {
      name: 'memory_search',
      label: 'Search Memory',
      description: 'Search the user\'s browsing history and indexed content via semantic vector search. Returns the most relevant pages.',
      parameters: T.Object({
        query: T.String({ description: 'Natural language search query' }),
        sources: T.Optional(T.Array(T.String(), { description: 'Filter by source: browsing, showcase, reference' })),
        topK: T.Optional(T.Integer({ description: 'Number of results (default 5)' })),
      }),
      execute: async (id, params) => {
        const r = await sendToSW('BRIDGE_SEARCH_VECTORDB', {
          query: params.query,
          sources: params.sources,
          topK: params.topK || 5,
        });
        if (!r.results || r.results.length === 0) return textResult('No results found for: ' + params.query);
        const formatted = r.results.map((r, i) =>
          `${i + 1}. [${(r.similarity * 100).toFixed(0)}%] ${r.title || 'Untitled'}\n   ${r.url || ''}\n   ${(r.content || '').substring(0, 200)}`
        ).join('\n\n');
        return textResult(formatted, { resultCount: r.results.length });
      },
    },

    // ---- Exec ----

    {
      name: 'exec_python',
      label: 'Run Python',
      description: 'Execute a Python 3 script in the CheerpX Linux VM. PYTHONHASHSEED=0 is auto-injected. Available stdlib: json, csv, re, sqlite3, hashlib, base64, math, os, sys.',
      parameters: T.Object({
        code: T.String({ description: 'Python code to execute (passed via -c flag)' }),
        timeout: T.Optional(T.Integer({ description: 'Timeout in ms (default 30000)' })),
      }),
      execute: async (id, params) => {
        const r = await sendToSW('HOST_EXEC_SPAWN', {
          cmd: '/usr/bin/python3',
          args: ['-c', params.code],
          timeout: params.timeout || 30000,
        });
        if (r.timedOut) return textResult('Python execution timed out after ' + (params.timeout || 30000) + 'ms', r);
        if (r.exitCode !== 0) return textResult('Python error (exit ' + r.exitCode + '):\n' + (r.stdout || r.error || ''), r);
        return textResult(r.stdout || '(no output)', r);
      },
    },
    {
      name: 'exec_shell',
      label: 'Run Shell',
      description: 'Execute a shell command in the CheerpX Linux VM. Available: ls, cat, grep, sed, awk, find, tar, gzip, cp, mv, rm.',
      parameters: T.Object({
        command: T.String({ description: 'Shell command to run (passed to /bin/sh -c)' }),
        timeout: T.Optional(T.Integer({ description: 'Timeout in ms (default 15000)' })),
      }),
      execute: async (id, params) => {
        const r = await sendToSW('HOST_EXEC_SPAWN', {
          cmd: '/bin/sh',
          args: ['-c', params.command],
          timeout: params.timeout || 15000,
        });
        if (r.timedOut) return textResult('Command timed out', r);
        return textResult(r.stdout || '(no output)', r);
      },
    },

    // ---- Filesystem ----

    {
      name: 'fs_read',
      label: 'Read File',
      description: 'Read a file from the CheerpX VM filesystem.',
      parameters: T.Object({
        path: T.String({ description: 'Absolute path in the VM (e.g. /tmp/data.txt)' }),
      }),
      execute: async (id, params) => {
        const r = await sendToSW('HOST_FS_READ', { path: params.path });
        if (!r.success) return textResult('Error: ' + (r.error || 'read failed'), r);
        return textResult(r.content || '(empty file)', r);
      },
    },
    {
      name: 'fs_write',
      label: 'Write File',
      description: 'Write content to a file in the CheerpX VM filesystem.',
      parameters: T.Object({
        path: T.String({ description: 'Absolute path in the VM' }),
        content: T.String({ description: 'File content to write' }),
      }),
      execute: async (id, params) => {
        const r = await sendToSW('HOST_FS_WRITE', { path: params.path, content: params.content });
        return textResult(r.success ? 'Written ' + (r.bytesWritten || 0) + ' bytes to ' + params.path : 'Error: ' + r.error, r);
      },
    },

    // ---- Network ----

    {
      name: 'network_fetch',
      label: 'Fetch URL',
      description: 'Fetch any URL via the extension (CORS-free, no restrictions). Returns the response body as text.',
      parameters: T.Object({
        url: T.String({ description: 'URL to fetch' }),
        method: T.Optional(T.String({ description: 'HTTP method (default GET)' })),
      }),
      execute: async (id, params) => {
        const init = {};
        if (params.method) init.method = params.method;
        const r = await sendToSW('HOST_NETWORK_FETCH', { url: params.url, init, as: 'text' });
        if (!r.ok) return textResult('Fetch failed: ' + r.status + ' ' + (r.statusText || ''), r);
        const text = r.text || '';
        // Truncate large responses
        const truncated = text.length > 5000 ? text.substring(0, 5000) + '\n... (truncated, ' + text.length + ' total chars)' : text;
        return textResult(truncated, { status: r.status, url: r.url, fullLength: text.length });
      },
    },

    // ---- UI Generation ----

    {
      name: 'ui_generate',
      label: 'Generate UI',
      description: 'Generate a SmartClient dashboard UI from a natural language description. Returns a JSON config that renders in the extension.',
      parameters: T.Object({
        prompt: T.String({ description: 'Description of the UI to generate' }),
        model: T.Optional(T.String({ description: 'LLM model to use (default: haiku)' })),
      }),
      execute: async (id, params) => {
        const r = await sendToSW('SC_GENERATE_UI', { prompt: params.prompt, model: params.model });
        if (!r.success) return textResult('UI generation failed: ' + (r.error || 'unknown'), r);
        return textResult('UI generated successfully. Config has ' + JSON.stringify(r.config).length + ' chars.', { config: r.config });
      },
    },

    // ---- Plugins ----

    {
      name: 'plugin_list',
      label: 'List Plugins',
      description: 'List all installed plugins with their IDs, names, and descriptions.',
      parameters: T.Object({}),
      execute: async () => {
        const plugins = await sendToSW('PLUGIN_LIST');
        if (!Array.isArray(plugins)) return textResult('Failed to list plugins');
        const formatted = plugins.map(p => `- ${p.name} (${p.id}): ${p.description || 'no description'}`).join('\n');
        return textResult(plugins.length + ' plugins installed:\n' + formatted, { plugins });
      },
    },

    // ---- Sessions ----

    {
      name: 'session_list',
      label: 'List Sessions',
      description: 'List all active Playwright browser sessions with their status and CDP endpoints.',
      parameters: T.Object({}),
      execute: async () => {
        const r = await sendToSW('BRIDGE_LIST_SESSIONS');
        const sessions = r.sessions || [];
        if (sessions.length === 0) return textResult('No active sessions. Create one with the dashboard.');
        const formatted = sessions.map(s => `- ${s.name} (${s.id}): state=${s.state}, url=${s.currentUrl || 'none'}`).join('\n');
        return textResult(sessions.length + ' sessions:\n' + formatted, { sessions });
      },
    },

    // ---- Scripts ----

    {
      name: 'script_list',
      label: 'List Scripts',
      description: 'List all registered automation scripts with their status.',
      parameters: T.Object({}),
      execute: async () => {
        const r = await sendToSW('SCRIPT_LIBRARY_LIST');
        if (!r.success) return textResult('Failed to list scripts');
        const scripts = r.scripts || [];
        const formatted = scripts.map(s => `- ${s.name} (${s.size} bytes)`).join('\n');
        return textResult(scripts.length + ' scripts:\n' + formatted, { scripts });
      },
    },
  ];
}
