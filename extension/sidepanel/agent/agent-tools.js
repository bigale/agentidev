/**
 * Agent tools — typed wrappers around agentidev's SW handlers.
 *
 * Each tool dispatches via the transport abstraction (transport.js) which
 * routes to chrome.runtime.sendMessage (extension) or bridge WebSocket
 * (CLI/server). TypeBox schemas define the parameter shapes the LLM fills.
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

import { dispatch as sendToSW, autoDetect, getTransportMode } from './transport.js';

// Auto-detect transport on load (extension or none)
autoDetect();

// TypeBox imported from the pi-ai re-export for convenience
// (pi-ai bundles @sinclair/typebox)
let Type = null;

async function ensureType() {
  if (Type) return Type;
  try {
    const mod = await import('../../lib/vendor/pi-bundle.js');
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

    {
      name: 'script_save',
      label: 'Save Script',
      description: 'Save a script to the script library and sync to disk (~/.agentidev/scripts/). The script can then be launched from the dashboard or via script_launch. Use this to create CDP test scripts for plugins.',
      parameters: T.Object({
        name: T.String({ description: 'Script name (no extension, e.g. "test-my-plugin")' }),
        source: T.String({ description: 'Full JavaScript source code of the script (.mjs)' }),
      }),
      execute: async (id, params) => {
        const r = await sendToSW('SCRIPT_LIBRARY_SAVE', { name: params.name, source: params.source });
        if (!r.success) return textResult('Save failed: ' + (r.error || 'unknown'), r);
        return textResult('Script saved: ' + params.name + '.mjs (' + params.source.length + ' bytes). It will appear in the dashboard Scripts panel.', r);
      },
    },
    {
      name: 'script_launch',
      label: 'Launch Script',
      description: 'Launch a script by path. The script runs as a Node.js process and reports progress/assertions to the dashboard via the bridge. No session needed for CDP-based plugin tests.',
      parameters: T.Object({
        name: T.String({ description: 'Script name (e.g. "test-csv-analyzer")' }),
      }),
      execute: async (id, params) => {
        // Resolve the script path from the library
        const lib = await sendToSW('SCRIPT_LIBRARY_GET', { name: params.name });
        const scriptPath = lib?.script?.originalPath || ('~/.agentidev/scripts/' + params.name + '.mjs');
        const r = await sendToSW('SCRIPT_LAUNCH', { path: scriptPath });
        if (!r.success) return textResult('Launch failed: ' + (r.error || 'unknown'), r);
        return textResult('Script launched: ' + params.name + ' (scriptId: ' + (r.scriptId || 'unknown') + '). Check the dashboard for progress and assertions.', r);
      },
    },

    // ---- Testing ----

    {
      name: 'test_plugin',
      label: 'Test Plugin',
      description: 'Test a plugin by opening it in a browser tab and checking that its SmartClient components rendered correctly. Returns the page title, component count, and a list of rendered components with their types and IDs. Does NOT use Playwright sessions — opens in the extension browser directly.',
      parameters: T.Object({
        pluginId: T.String({ description: 'Plugin ID (e.g. "csv-analyzer" or a generated plugin ID like "proj_xxx")' }),
      }),
      execute: async (id, params) => {
        const pluginId = params.pluginId;

        try {
          const r = await sendToSW('TEST_PLUGIN_IN_TAB', { pluginId });

          if (r.error) {
            return textResult('Test failed: ' + r.error, r);
          }

          // Format component list
          const compList = (r.components || []).map(c =>
            `  - ${c.id} (${c.type})${c.visible ? '' : ' [hidden]'}`
          ).join('\n');

          return textResult(
            'Plugin test results:\n' +
            'Title: ' + (r.title || '(none)') + '\n' +
            'Config loaded: ' + (r.configLoaded ? 'yes' : 'no') + '\n' +
            'Components rendered: ' + (r.componentCount || 0) + '\n' +
            'Tab ID: ' + r.tabId + '\n' +
            'URL: ' + r.url + '\n\n' +
            (compList ? 'Component tree:\n' + compList : 'No components detected.'),
            { tabId: r.tabId, url: r.url, componentCount: r.componentCount, components: r.components }
          );
        } catch (e) {
          return textResult('Test failed: ' + e.message);
        }
      },
    },

    {
      name: 'generate_plugin_test',
      label: 'Generate Plugin Test',
      description: 'Generate a CDP test script for a plugin and save it to the script library. Specify which components to verify and which buttons to click. The generated test opens the plugin via CDP (port 9222), checks components in the sandbox iframe, and reports results to the dashboard. Use test_plugin first to see what components exist, then use this to create a full test.',
      parameters: T.Object({
        pluginId: T.String({ description: 'Plugin ID to test (e.g. "csv-analyzer")' }),
        componentIds: T.Array(T.String(), { description: 'Component IDs to verify exist (e.g. ["loadForm", "btnLoad", "summaryGrid"])' }),
        clicks: T.Optional(T.Array(T.Object({
          buttonId: T.String({ description: 'Button ID to click (e.g. "btnLoad")' }),
          waitMs: T.Optional(T.Integer({ description: 'Wait time after click in ms (default 5000)' })),
          expectGrid: T.Optional(T.String({ description: 'Grid ID that should have rows after click' })),
        }), { description: 'Buttons to click in order, with optional grid verification' })),
        formValues: T.Optional(T.Array(T.Object({
          formId: T.String({ description: 'DynamicForm ID' }),
          field: T.String({ description: 'Field name' }),
          value: T.String({ description: 'Value to set' }),
        }), { description: 'Form values to set before clicking buttons' })),
      }),
      execute: async (id, params) => {
        const { pluginId, componentIds, clicks = [], formValues = [] } = params;
        const testName = 'test-' + pluginId;

        // Build the test script from template
        const componentChecks = componentIds.map(cid =>
          `      ${cid}: !!isc.AutoTest.getObject('//${cid.includes('Grid') ? 'ListGrid' : cid.includes('Form') ? 'DynamicForm' : cid.includes('btn') || cid.startsWith('btn') ? 'Button' : '*'}[ID="${cid}"]'),`
        ).join('\n');

        const componentAsserts = componentIds.map(cid =>
          `  client.assert(components?.${cid} === true, '${cid} rendered');`
        ).join('\n');

        const formSetSteps = formValues.map(fv =>
          `    var f = isc.AutoTest.getObject('//DynamicForm[ID="${fv.formId}"]'); if(f) f.setValue('${fv.field}', '${fv.value.replace(/'/g, "\\'")}');`
        ).join('\n');

        const clickSteps = clicks.map((c, i) => {
          const step = i + 3;
          const waitMs = c.waitMs || 5000;
          let gridCheck = '';
          if (c.expectGrid) {
            gridCheck = `
    var grid = isc.AutoTest.getObject('//ListGrid[ID="${c.expectGrid}"]');
    return { rows: grid ? grid.getTotalRows() : -1 };`;
          } else {
            gridCheck = `\n    return { clicked: true };`;
          }
          return `
  await client.progress(${step}, TOTAL, 'Click ${c.buttonId}');
  var click${i} = await cdpEval(targets.sandbox.webSocketDebuggerUrl, \`(async function() {
    var btn = isc.AutoTest.getObject('//Button[ID="${c.buttonId}"]');
    if (!btn) { var all = isc.Canvas._canvasList||[]; for(var j=0;j<all.length;j++) if(all[j].ID==="${c.buttonId}") { btn=all[j]; break; } }
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, ${waitMs}));${gridCheck}
  })()\`, ${waitMs + 5000});${c.expectGrid ? `
  client.assert(click${i}?.rows > 0, '${c.expectGrid} has ' + (click${i}?.rows||0) + ' rows after clicking ${c.buttonId}');` : `
  client.assert(click${i}?.clicked, '${c.buttonId} clicked');`}`;
        }).join('\n');

        const totalSteps = 2 + clicks.length + 1; // open + verify + clicks + summary

        const source = `#!/usr/bin/env node
/**
 * Auto-generated plugin test for ${pluginId}.
 * Generated by agentidev agent.
 */
import { ScriptClient } from '../packages/bridge/script-client.mjs';
import http from 'http';
import WebSocket from 'ws';
import fs from 'fs';

const CDP_PORT = 9222;
const PLUGIN_MODE = '${pluginId}';
const TOTAL = ${totalSteps};
const client = new ScriptClient('${testName}', { totalSteps: TOTAL });

async function getTargets() {
  return JSON.parse(await new Promise((res, rej) => {
    http.get('http://localhost:'+CDP_PORT+'/json', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(d)); }).on('error', rej);
  }));
}
async function cdpEval(wsUrl, expr, timeout=15000) {
  const ws = new WebSocket(wsUrl);
  await new Promise(r => ws.once('open', r));
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cdpEval timeout')), timeout);
    const handler = raw => { const m=JSON.parse(raw.toString()); if(m.id===1){ws.off('message',handler);clearTimeout(timer);resolve(m);} };
    ws.on('message', handler);
    ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:expr,returnByValue:true,awaitPromise:true}}));
  });
  ws.close();
  if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text||'eval error');
  return result.result?.result?.value;
}
async function cdpScreenshot(wsUrl, path) {
  const ws = new WebSocket(wsUrl); await new Promise(r => ws.once('open', r));
  const result = await new Promise(resolve => {
    const handler = raw => { const m=JSON.parse(raw.toString()); if(m.id===1){ws.off('message',handler);resolve(m);} };
    ws.on('message', handler);
    ws.send(JSON.stringify({id:1,method:'Page.captureScreenshot',params:{format:'png'}}));
  });
  ws.close();
  if (result.result?.data) { fs.writeFileSync(path,Buffer.from(result.result.data,'base64')); return path; }
  return null;
}
async function findPluginTargets(mode) {
  const targets = await getTargets();
  const page = targets.find(t => t.type==='page' && t.url.includes('mode='+mode));
  if (!page) return null;
  const idx = targets.indexOf(page);
  for (const t of targets.slice(idx+1)) {
    if (t.type==='iframe' && t.url.includes('app.html')) return {page,sandbox:t};
    if (t.type==='page') break;
  }
  const iframes = targets.filter(t => t.type==='iframe' && t.url.includes('app.html'));
  if (iframes.length>0) return {page,sandbox:iframes[iframes.length-1]};
  return {page,sandbox:null};
}

try {
  await client.connect();
  // Step 1: Open plugin
  await client.progress(1, TOTAL, 'Open plugin');
  let targets = await findPluginTargets(PLUGIN_MODE);
  if (!targets) {
    const all = await getTargets();
    const extId = all.find(t=>t.type==='service_worker'&&t.url.includes('chrome-extension://'))?.url.match(/chrome-extension:\\/\\/([^/]+)/)?.[1];
    if (extId) {
      await new Promise((res,rej) => { const req=http.request({method:'PUT',hostname:'localhost',port:CDP_PORT,path:'/json/new?'+encodeURI('chrome-extension://'+extId+'/smartclient-app/wrapper.html?mode='+PLUGIN_MODE)},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(d));}); req.on('error',rej); req.end(); });
      await new Promise(r => setTimeout(r, 5000));
      targets = await findPluginTargets(PLUGIN_MODE);
    }
  }
  client.assert(targets!=null, 'Plugin tab found');
  client.assert(targets?.sandbox!=null, 'Sandbox iframe found');
  if (!targets?.sandbox) throw new Error('No sandbox iframe');

  // Step 2: Verify components
  await client.progress(2, TOTAL, 'Verify components');
  let components = null;
  for (let attempt=0; attempt<6; attempt++) {
    await new Promise(r => setTimeout(r, 2000));
    targets = await findPluginTargets(PLUGIN_MODE) || targets;
    if (!targets?.sandbox) continue;
    try {
      components = await cdpEval(targets.sandbox.webSocketDebuggerUrl, \`(function(){
        if(typeof isc==='undefined'||!isc.AutoTest) return null;
        return {
${componentChecks}
        };
      })()\`);
      if (components && Object.values(components).some(v=>v)) break;
    } catch(e) { /* retry */ }
  }
${componentAsserts}
${formSetSteps ? '\n  // Set form values\n  await cdpEval(targets.sandbox.webSocketDebuggerUrl, \\`(function(){\\n' + formSetSteps + '\\n  })()\\`);' : ''}
${clickSteps}

  // Screenshot
  const shotPath = '/tmp/${testName}.png';
  await cdpScreenshot(targets.page.webSocketDebuggerUrl, shotPath);
  await client.artifact({type:'screenshot',label:'Final state',filePath:shotPath,contentType:'image/png'});

  // Summary
  await client.progress(TOTAL, TOTAL, 'Complete');
  const exitCode = client.summarize();
  await client.complete({assertions:client.getAssertionSummary()});
  process.exit(exitCode);
} catch(err) {
  client.assert(false, 'Fatal: '+err.message);
  client.summarize();
  await client.complete({assertions:client.getAssertionSummary()}).catch(()=>{});
  process.exit(1);
}
`;

        // Save via SW handler
        const saveResult = await sendToSW('SCRIPT_LIBRARY_SAVE', { name: testName, source });
        if (!saveResult.success) return textResult('Failed to save test: ' + (saveResult.error || 'unknown'));

        return textResult(
          'Test script generated and saved: ' + testName + '.mjs\n' +
          'Components to verify: ' + componentIds.join(', ') + '\n' +
          'Click steps: ' + (clicks.length > 0 ? clicks.map(c => c.buttonId).join(' → ') : 'none') + '\n' +
          'Total assertions: ~' + (2 + componentIds.length + clicks.length) + '\n\n' +
          'Use script_launch("' + testName + '") to run it, or run from the dashboard.',
          { testName, totalSteps }
        );
      },
    },

    // ---- API-to-App Pipeline ----

    {
      name: 'api_to_app',
      label: 'API Test Generator',
      description: 'Generate combinatorial API test scripts from an OpenAPI spec using PICT. Analyzes the spec, generates PICT models for endpoint parameters, runs PICT to produce pairwise test cases, and creates runnable test scripts. Use --endpoint=all for all pet CRUD endpoints, or specify an operationId. Results appear on the dashboard.',
      parameters: T.Object({
        spec: T.Optional(T.String({ description: 'Path to OpenAPI spec JSON file (default: petstore-v2)' })),
        endpoint: T.Optional(T.String({ description: 'Operation ID (e.g. "findPetsByStatus", "addPet", "getPetById", "deletePet") or "all" for all pet endpoints. Default: "all"' })),
        baseUrl: T.Optional(T.String({ description: 'API base URL (default: https://petstore.swagger.io/v2)' })),
        workflow: T.Optional(T.Boolean({ description: 'Also generate a CRUD workflow test (default: true)' })),
        build: T.Optional(T.Boolean({ description: 'Also generate a SmartClient app from the spec (default: false)' })),
        run: T.Optional(T.Boolean({ description: 'Run the generated tests after creating them (default: false)' })),
      }),
      execute: async (id, params) => {
        const pipelinePath = 'packages/bridge/api-to-app/pipeline.mjs';
        const args = [];
        if (params.spec) args.push('--spec=' + params.spec);
        args.push('--endpoint=' + (params.endpoint || 'all'));
        if (params.baseUrl) args.push('--base-url=' + params.baseUrl);
        if (params.workflow !== false) args.push('--workflow');
        if (params.build) args.push('--build');
        args.push('--seed=42'); // Deterministic for reproducibility
        if (params.run) args.push('--run');

        try {
          const r = await sendToSW('SCRIPT_LAUNCH', { path: pipelinePath, args });
          if (!r.success) return textResult('Pipeline launch failed: ' + (r.error || 'unknown'), r);
          return textResult(
            'api-to-app pipeline launched (scriptId: ' + (r.scriptId || r.launchId || 'unknown') + ')\n' +
            'Args: ' + args.join(' ') + '\n' +
            'Check the dashboard Scripts panel for progress, PICT models, and generated test scripts.\n' +
            'Generated tests will appear in examples/test-petstore-*.mjs',
            r
          );
        } catch (e) {
          return textResult('Pipeline launch failed: ' + e.message);
        }
      },
    },

    // ---- SmartClient UI Generation (Phase D) ----

    {
      name: 'sc_generate',
      label: 'Generate SmartClient UI',
      description: 'Generate a SmartClient dashboard UI config from a natural language prompt. The config is a JSON object with dataSources and layout. Use this to create data-driven UIs with grids, forms, buttons. The generated config is rendered in the extension\'s sandbox iframe.',
      parameters: T.Object({
        prompt: T.String({ description: 'Natural language description of the UI to generate' }),
      }),
      execute: async (id, params) => {
        const r = await sendToSW('SC_GENERATE_UI', { prompt: params.prompt });
        if (!r.success) return textResult('Generation failed: ' + (r.error || 'unknown'), r);
        // Validate the config
        const config = r.config;
        const issues = [];
        if (!config.dataSources && !config.layout) issues.push('Missing both dataSources and layout');
        if (config.layout && !config.layout._type) issues.push('Layout missing _type');
        if (config.dataSources && !Array.isArray(config.dataSources)) issues.push('dataSources must be an array');
        if (issues.length > 0) {
          return textResult('Config generated but has issues:\n' + issues.join('\n') + '\n\nConfig preview:\n' + JSON.stringify(config).substring(0, 500), { config, issues });
        }
        return textResult('UI generated successfully.\n\nComponents: ' + (config.layout?._type || 'unknown') + '\nDataSources: ' + (config.dataSources?.length || 0) + '\n\nThe config has been rendered in the playground.', { config });
      },
    },
    {
      name: 'sc_validate',
      label: 'Validate SC Config',
      description: 'Validate a SmartClient config JSON object. Checks for required fields, allowed component types, and DataSource structure. Returns a list of issues or confirms the config is valid.',
      parameters: T.Object({
        config: T.String({ description: 'JSON string of the SmartClient config to validate' }),
      }),
      execute: async (id, params) => {
        try {
          const config = JSON.parse(params.config);
          const ALLOWED = ['VLayout','HLayout','ListGrid','DynamicForm','Button','Label','TabSet','Tab','DetailViewer','SectionStack','HTMLFlow','Window','ToolStrip','ToolStripButton','PortalLayout','Portlet','Canvas','Progressbar','ImgButton','ToolStripSeparator','ToolStripMenuButton','Menu','ForgeListGrid'];
          const issues = [];
          if (!config.layout) issues.push('Missing layout');
          if (config.layout && !config.layout._type) issues.push('Layout missing _type');
          if (config.layout && !ALLOWED.includes(config.layout._type)) issues.push('Layout _type "' + config.layout._type + '" not in allowed list');
          // Check dataSources
          if (config.dataSources) {
            for (const ds of config.dataSources) {
              if (!ds.ID) issues.push('DataSource missing ID');
              if (!ds.fields || !Array.isArray(ds.fields)) issues.push('DataSource ' + (ds.ID || '?') + ' missing fields array');
            }
          }
          // Walk layout tree for invalid types
          function walk(node, path) {
            if (!node) return;
            if (node._type && !ALLOWED.includes(node._type)) issues.push(path + ': unknown _type "' + node._type + '"');
            if (node.members) node.members.forEach((m, i) => walk(m, path + '.members[' + i + ']'));
            if (node.tabs) node.tabs.forEach((t, i) => { walk(t.pane, path + '.tabs[' + i + '].pane'); });
          }
          walk(config.layout, 'layout');
          if (issues.length === 0) return textResult('Config is valid. ' + (config.dataSources?.length || 0) + ' DataSources, layout type: ' + config.layout?._type);
          return textResult(issues.length + ' issues found:\n' + issues.map((s, i) => (i + 1) + '. ' + s).join('\n'));
        } catch (e) {
          return textResult('Invalid JSON: ' + e.message);
        }
      },
    },
  ];
}
