#!/usr/bin/env node

/**
 * Bridge WebSocket Server
 *
 * Accepts connections from Chrome extension and Claude Code.
 * Manages playwright-cli sessions as child processes.
 * Serializes commands per session (queue-based).
 * Broadcasts state changes to all connected clients.
 *
 * Start: node bridge/server.mjs [--port=9876]
 * Stop:  Ctrl+C or node bridge/server.mjs --stop
 */

import { WebSocketServer, WebSocket } from 'ws';
import { spawn, execFile } from 'child_process';
import http from 'http';
import { readFile, writeFile, mkdir, stat, readdir, symlink, lstat, unlink, readlink, rm } from 'fs/promises';
import { watch } from 'fs';
import { resolve as pathResolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { homedir, tmpdir } from 'os';
import { MSG, buildMessage, buildReply, buildError, ROLES } from './protocol.mjs';
import { PlaywrightSession, SESSION_STATE } from './playwright-session.mjs';
import { InspectorClient, parseInspectorUrl } from './inspector-client.mjs';
import { actionToCommandArgs } from './cli-commands.mjs';

const DEFAULT_PORT = 9876;
const HEALTH_INTERVAL = 30000; // 30s ping/pong
const __dirname = dirname(fileURLToPath(import.meta.url));
const SHIM_PATH = pathResolve(__dirname, 'playwright-shim.mjs');
const SCRIPTS_DIR = pathResolve(homedir(), '.contextual-recall', 'scripts');
const AUTH_DIR = pathResolve(homedir(), '.contextual-recall', 'auth');
const CLONES_DIR = pathResolve(homedir(), '.contextual-recall', 'clones');
const ARTIFACTS_DIR = pathResolve(homedir(), '.contextual-recall', 'artifacts');
const ARTIFACT_INLINE_LIMIT = 100 * 1024; // 100KB — below this, store as base64 inline
const CONSOLE_BUFFER_LIMIT = 500 * 1024;  // 500KB max console buffer per script

// Parse CLI args
const args = process.argv.slice(2);
const portArg = args.find(a => a.startsWith('--port='));
const PORT = portArg ? parseInt(portArg.split('=')[1]) : DEFAULT_PORT;

if (args.includes('--stop')) {
  console.log('Sending stop signal...');
  try {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.on('open', () => {
      ws.send(JSON.stringify(buildMessage('BRIDGE_SHUTDOWN', {}, 'cli')));
      setTimeout(() => process.exit(0), 500);
    });
    ws.on('error', () => {
      console.log('No server running on port', PORT);
      process.exit(0);
    });
  } catch {
    process.exit(0);
  }
} else {
  startServer();
}

/**
 * Discover running browser processes managed by this system.
 * Matches:
 *  - Playwright-launched Chromium (args contain 'playwright' or 'ms-playwright')
 *  - Our debug profile Chrome (args contain 'chrome-debug-profile' or 'contextual-recall/browser-profile')
 * Excludes sub-processes (renderer, gpu, utility, zygote, crashpad).
 * Correlates ppid against known script PIDs to identify owner.
 * @param {Map} scripts - Active scripts map
 * @returns {Promise<Array<{ pid, ppid, elapsedSeconds, ownerScriptId, ownerScriptName, type }>>}
 */
function discoverBrowserProcesses(scripts) {
  return new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid,ppid,etimes,args', '--no-headers'], (err, stdout) => {
      if (err) {
        console.warn('[Bridge] ps failed:', err.message);
        resolve([]);
        return;
      }
      // Build set of known script PIDs for owner correlation
      const scriptPidMap = new Map(); // pid → { scriptId, name }
      for (const [scriptId, s] of scripts) {
        if (s.pid) scriptPidMap.set(s.pid, { scriptId, name: s.name });
      }

      const subProcessTypes = ['--type=renderer', '--type=gpu-process', '--type=utility', '--type=zygote', 'crashpad_handler'];
      const processes = [];

      for (const line of stdout.trim().split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Parse: PID PPID ELAPSED ARGS...
        const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
        if (!match) continue;
        const [, pidStr, ppidStr, etimeStr, args] = match;

        // Must look like a chrome/chromium binary (not a sub-process)
        if (!args.includes('chromium') && !args.includes('chrome') && !args.includes('Chromium')) continue;
        // Exclude sub-processes
        if (subProcessTypes.some(t => args.includes(t))) continue;

        // Classify: what kind of browser is this?
        const isPlaywright = args.includes('playwright') || args.includes('ms-playwright');
        const isDebugProfile = args.includes('chrome-debug-profile') || args.includes('contextual-recall/browser-profile');
        if (!isPlaywright && !isDebugProfile) continue;

        const pid = parseInt(pidStr, 10);
        const ppid = parseInt(ppidStr, 10);
        const elapsedSeconds = parseInt(etimeStr, 10);

        // Check if ppid matches a known script
        const owner = scriptPidMap.get(ppid);

        // Extract --load-extension path for self-detection by dashboard
        const extMatch = args.match(/--load-extension=(\S+)/);

        processes.push({
          pid,
          ppid,
          elapsedSeconds,
          ownerScriptId: owner?.scriptId || null,
          ownerScriptName: owner?.name || null,
          type: isPlaywright ? 'playwright' : 'debug-profile',
          loadExtension: extMatch ? extMatch[1] : null,
        });
      }
      resolve(processes);
    });
  });
}

// ─── SmartClient helpers ─────────────────────────────────────

/**
 * Spawn `claude -p` and return stdout as a string.
 * Reusable for sc:generate, sc:clone, and future SmartClient AI commands.
 * @param {string} model - Claude model name (haiku, sonnet, opus)
 * @param {string} systemPrompt - System prompt text
 * @param {string} userPrompt - User prompt text
 * @param {object} [options]
 * @param {string} [options.addDir] - Directory to add via --add-dir
 * @param {string} [options.allowedTools] - Tools to allow (triggers --dangerously-skip-permissions)
 * @param {number} [options.timeout=60000] - Process timeout in ms
 * @returns {Promise<string>} Raw stdout from claude process
 */
function spawnClaude(model, systemPrompt, userPrompt, options = {}) {
  const timeout = options.timeout || 60000;
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--model', model,
      '--output-format', 'json',
      '--no-session-persistence',
      '--system-prompt', systemPrompt,
    ];
    if (options.addDir) {
      args.push('--add-dir', options.addDir);
    }
    if (options.allowedTools) {
      args.push('--allowedTools', options.allowedTools, '--dangerously-skip-permissions');
    }
    args.push(userPrompt);

    const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude process timed out after ${timeout / 1000}s`));
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude process exited with code ${code}: ${stderr || stdout}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Parse claude --output-format json output, extract the inner result,
 * then find and parse the JSON object from the response text.
 * @param {string} raw - Raw stdout from spawnClaude
 * @returns {object} Parsed JSON object
 */
function parseClaudeJsonResponse(raw) {
  let responseText;
  try {
    const jsonOutput = JSON.parse(raw);
    responseText = jsonOutput.result || raw;
  } catch {
    responseText = raw;
  }

  let cleaned = responseText.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON object found in Claude response');
  }
  return JSON.parse(jsonMatch[0]);
}

/**
 * Validate a SmartClient config object.
 * @param {object} config
 * @throws {Error} If config is invalid
 */
function validateSmartClientConfig(config) {
  if (!config.dataSources || !Array.isArray(config.dataSources)) {
    throw new Error('Config must have dataSources array');
  }
  if (!config.layout || !config.layout._type) {
    throw new Error('Config must have layout with _type');
  }
  for (const ds of config.dataSources) {
    if (!ds.ID) throw new Error('Each dataSource must have an ID');
    if (!ds.fields || !Array.isArray(ds.fields)) throw new Error(`DataSource ${ds.ID} must have fields array`);
  }
}

/**
 * Truncate a YAML snapshot to fit in a prompt, keeping semantic structure.
 * Keeps the first 80% and last 10% of lines, noting the omitted count.
 * @param {string} yaml - Full YAML snapshot
 * @param {number} [maxLines=300] - Maximum number of lines to keep
 * @returns {string} Truncated YAML
 */
function truncateSnapshot(yaml, maxLines = 300) {
  const lines = yaml.split('\n');
  if (lines.length <= maxLines) return yaml;

  const headCount = Math.floor(maxLines * 0.8);
  const tailCount = Math.floor(maxLines * 0.1);
  const omitted = lines.length - headCount - tailCount;

  return [
    ...lines.slice(0, headCount),
    `# ... ${omitted} lines omitted for brevity ...`,
    ...lines.slice(lines.length - tailCount),
  ].join('\n');
}

/**
 * Filter network request output for clone purposes.
 * Drops static assets (css, js, fonts, images, analytics), keeps API calls.
 * @param {string} output - Raw network output from playwright-cli
 * @param {number} [maxLines=200] - Maximum lines to keep
 * @returns {string} Filtered network output
 */
function filterNetworkForClone(output, maxLines = 200) {
  if (!output || !output.trim()) return '(no network requests captured)';

  const staticPatterns = [
    /\.(css|js|woff2?|ttf|eot|svg|png|jpe?g|gif|ico|webp|avif)(\?|$)/i,
    /google-analytics|googletagmanager|doubleclick|facebook\.net|analytics/i,
    /fonts\.googleapis|cdnjs\.cloudflare|unpkg\.com|cdn\.jsdelivr/i,
  ];

  const lines = output.split('\n');
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    return !staticPatterns.some(p => p.test(trimmed));
  });

  if (filtered.length === 0) return '(no API requests detected — only static assets)';
  if (filtered.length > maxLines) {
    return filtered.slice(0, maxLines).join('\n') + `\n# ... ${filtered.length - maxLines} more entries truncated`;
  }
  return filtered.join('\n');
}

/**
 * Build the user prompt for sc:clone.
 * @param {string} url - Page URL
 * @param {string} snapshot - Truncated accessibility snapshot (YAML)
 * @param {string} network - Filtered network request list
 * @param {string} screenshotPath - Absolute path to screenshot PNG
 * @returns {string} Assembled user prompt
 */
function buildClonePrompt(url, snapshot, network, screenshotPath) {
  return `Clone this web page into a SmartClient config.

URL: ${url}

SCREENSHOT: Read the file at ${screenshotPath} to see the visual layout, colors, spacing, and component arrangement.

ACCESSIBILITY SNAPSHOT (YAML — semantic structure):
\`\`\`yaml
${snapshot}
\`\`\`

NETWORK REQUESTS (API calls — infer data model from endpoints and response patterns):
\`\`\`
${network}
\`\`\`

Based on ALL three inputs (screenshot for visual layout, snapshot for semantic structure, network for data model), produce a SmartClient JSON config that replicates this page.`;
}

const SC_CLONE_SYSTEM_PROMPT = `You are a SmartClient UI cloner. Given a live web page's screenshot, accessibility snapshot, and network requests, you produce a SmartClient JSON config that replicates the page.

INSTRUCTIONS:
1. Use the Read tool to read the screenshot file to see visual layout, colors, spacing, and component arrangement.
2. Map the accessibility snapshot roles to SmartClient component types:
   - table/grid -> ListGrid
   - form/input fields -> DynamicForm
   - tabs -> TabSet with Tab members
   - sections/headings -> SectionStack
   - navigation -> ToolStrip with ToolStripButton
   - standalone text/HTML -> HTMLFlow or Label
3. Infer DataSource field schemas from network response URL patterns and the snapshot data.
4. Match visual proportions from the screenshot (widths, heights, spacing).
5. Wire interactions: grid selection -> form detail, buttons -> CRUD actions.

OUTPUT FORMAT — same as sc:generate:
{"dataSources":[...],"layout":{...}}

Rules:
- dataSources: array of {ID, fields:[{name,type,primaryKey,hidden,title,required,length,valueMap,canEdit}]}
  - ID must end with DS, always include {name:"id",type:"integer",primaryKey:true,hidden:true}
  - Field types: text, integer, float, date, datetime, boolean
  - For dropdowns use valueMap as an array of strings
- layout: component tree with _type and members[]
  - Allowed _type values: VLayout, HLayout, ListGrid, DynamicForm, Button, Label, TabSet, Tab, DetailViewer, SectionStack, HTMLFlow, Window, ToolStrip, ToolStripButton
  - ListGrid: set dataSource, autoFetchData:true, fields array with name and width
  - DynamicForm: set dataSource, fields with name and optionally editorType
  - Button: use _action for behavior: "new","save","delete". Set _targetForm and _targetGrid
  - ListGrid recordClick: set _action:"select" and _targetForm to auto-wire
  - Give components an ID string so buttons can reference them

Output ONLY the JSON object. No explanation, no markdown fences.`;

function startServer() {
  // Connected clients: Map<WebSocket, { role, id, connectedAt }>
  const clients = new Map();

  // Active playwright sessions: Map<sessionId, PlaywrightSession>
  const sessions = new Map();

  // Command queue per session for priority handling
  const commandQueues = new Map();

  // Pending relay messages: searchMsgId -> { ws, originalMsgId }
  const pendingRelays = new Map();

  // Registered scripts: Map<scriptId, { ws, name, totalSteps, step, label, errors, state, metadata, startedAt }>
  const scripts = new Map();

  // Pre-breakpoints: breakpoints to apply when a script registers (keyed by PID)
  const pendingBreakpoints = new Map();

  // V8 Inspectors: keyed by PID until script registers, then moved to script object
  const pendingInspectors = new Map();

  // Pending session links: pid → sessionId (script launched against a session)
  const pendingSessionLinks = new Map();

  // Pending post-actions: pid → { sessionId, actions[] } (execute after script completes)
  const pendingPostActions = new Map();

  // Pending artifact capture flag: pid → boolean (set at launch, applied at register)
  const pendingCaptureArtifacts = new Map();

  // Console buffers: pid → string (stdout+stderr, started at launch, transferred to script at register)
  const pendingConsoleBuffers = new Map();

  // File watcher: echo suppression for writes we initiated
  const fileWatcherIgnore = new Set();
  const fileWatcherDebounce = new Map(); // filename → timer
  let fileWatcher = null;
  const FILE_WATCH_DEBOUNCE = 300;

  // ---- Schedule engine ----
  const schedules = new Map();       // scheduleId → schedule object
  const scheduleTimers = new Map();  // scheduleId → setInterval handle
  const SCHEDULES_FILE = pathResolve(homedir(), '.contextual-recall', 'schedules.json');

  async function loadSchedules() {
    try {
      const data = await readFile(SCHEDULES_FILE, 'utf8');
      const arr = JSON.parse(data);
      let cleaned = false;
      for (const sched of arr) {
        // Close out stale "running" entries from previous server instance
        if (sched.history) {
          for (const h of sched.history) {
            if (h.state === 'running' && !h.completedAt) {
              h.completedAt = Date.now();
              h.durationMs = h.completedAt - h.startedAt;
              h.state = 'failed';
              h.error = 'Server restarted (process lost)';
              cleaned = true;
            }
          }
        }
        schedules.set(sched.id, sched);
        if (sched.enabled) startScheduleTimer(sched.id);
      }
      if (cleaned) await saveSchedules();
      console.log(`[Bridge] Loaded ${schedules.size} schedule(s)`);
    } catch {
      // No file or invalid — start fresh
    }
  }

  async function saveSchedules() {
    const dir = dirname(SCHEDULES_FILE);
    await mkdir(dir, { recursive: true });
    await writeFile(SCHEDULES_FILE, JSON.stringify([...schedules.values()], null, 2));
  }

  function startScheduleTimer(id) {
    const sched = schedules.get(id);
    if (!sched || !sched.enabled) return;
    stopScheduleTimer(id);
    sched.nextRunAt = Date.now() + sched.intervalMs;
    const timer = setInterval(() => triggerSchedule(id), sched.intervalMs);
    scheduleTimers.set(id, timer);
    console.log(`[Bridge] Schedule timer started: ${sched.name} (every ${sched.intervalMs}ms)`);
  }

  function stopScheduleTimer(id) {
    const timer = scheduleTimers.get(id);
    if (timer) {
      clearInterval(timer);
      scheduleTimers.delete(id);
    }
    const sched = schedules.get(id);
    if (sched) sched.nextRunAt = null;
  }

  async function triggerSchedule(id) {
    const sched = schedules.get(id);
    if (!sched) return;

    // maxConcurrent check: skip if previous run still active
    // Look up by PID since launchId and scriptId differ (launch vs registration)
    if (sched.maxConcurrent >= 1 && sched.lastRunPid) {
      for (const [, s] of scripts) {
        if (s.pid === sched.lastRunPid && ['registered', 'running', 'paused', 'checkpoint'].includes(s.state)) {
          console.log(`[Bridge] Schedule "${sched.name}" skipped — previous run still active (pid ${s.pid})`);
          return;
        }
      }
    }

    try {
      const result = await launchScriptInternal({
        path: sched.scriptPath,
        args: sched.args || [],
        sessionId: sched.sessionId || null,
        originalPath: sched.originalPath || null,
      });

      sched.lastRunAt = Date.now();
      sched.lastRunScriptId = result.launchId;
      sched.lastRunPid = result.pid;
      sched.runCount++;
      sched.nextRunAt = sched.enabled ? Date.now() + sched.intervalMs : null;

      if (!sched.history) sched.history = [];
      sched.history.push({
        launchId: result.launchId,
        pid: result.pid,
        startedAt: Date.now(),
        completedAt: null,
        durationMs: null,
        state: 'running',
        error: null,
      });
      if (sched.history.length > 10) sched.history.shift();

      await saveSchedules();
      console.log(`[Bridge] Schedule "${sched.name}" triggered → launch ${result.launchId}`);

      // Broadcast update
      broadcast(buildMessage(MSG.BRIDGE_SCHEDULE_UPDATE, { schedule: sched }));
    } catch (err) {
      console.error(`[Bridge] Schedule "${sched.name}" trigger failed: ${err.message}`);
    }
  }

  // Start file watcher on scripts directory
  async function startFileWatcher() {
    try {
      await mkdir(SCRIPTS_DIR, { recursive: true });
    } catch { /* already exists */ }
    try {
      fileWatcher = watch(SCRIPTS_DIR, (eventType, filename) => {
        if (!filename || !filename.endsWith('.mjs')) return;

        // Debounce: editors write multiple times
        if (fileWatcherDebounce.has(filename)) {
          clearTimeout(fileWatcherDebounce.get(filename));
        }
        fileWatcherDebounce.set(filename, setTimeout(() => {
          fileWatcherDebounce.delete(filename);
          handleFileChange(filename);
        }, FILE_WATCH_DEBOUNCE));
      });
      console.log(`[Bridge] Watching scripts dir: ${SCRIPTS_DIR}`);
    } catch (err) {
      console.warn(`[Bridge] File watcher failed (non-fatal): ${err.message}`);
    }
  }

  async function handleFileChange(filename) {
    const filePath = pathResolve(SCRIPTS_DIR, filename);

    // Echo suppression: skip if we wrote this file ourselves
    if (fileWatcherIgnore.has(filePath)) {
      fileWatcherIgnore.delete(filePath);
      return;
    }

    const name = filename.replace(/\.mjs$/, '');

    try {
      const fileStat = await stat(filePath);
      const source = await readFile(filePath, 'utf-8');
      console.log(`[Bridge] File changed on disk: ${filename} (${source.length} bytes)`);
      broadcast(buildMessage(MSG.BRIDGE_SCRIPT_FILE_CHANGED, {
        name,
        source,
        path: filePath,
        size: source.length,
        modifiedAt: fileStat.mtimeMs,
      }));
    } catch (err) {
      if (err.code === 'ENOENT') {
        // File was deleted
        console.log(`[Bridge] File deleted: ${filename}`);
        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_FILE_CHANGED, {
          name,
          source: null,
          path: filePath,
          deleted: true,
        }));
      } else {
        console.warn(`[Bridge] Error reading changed file ${filename}: ${err.message}`);
      }
    }
  }

  startFileWatcher();
  loadSchedules();

  const wss = new WebSocketServer({ port: PORT });

  console.log(`[Bridge] WebSocket server listening on ws://localhost:${PORT}`);
  console.log(`[Bridge] Waiting for connections (extension, Claude Code)...`);

  // Health check interval
  const healthTimer = setInterval(() => {
    for (const [ws, info] of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch {
          // Will be cleaned up by close handler
        }
      }
    }
  }, HEALTH_INTERVAL);

  wss.on('connection', (ws) => {
    const clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    clients.set(ws, { role: null, id: clientId, connectedAt: Date.now() });
    console.log(`[Bridge] New connection: ${clientId}`);

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        sendTo(ws, buildError('Invalid JSON'));
        return;
      }

      try {
        await handleMessage(ws, msg);
      } catch (err) {
        console.error(`[Bridge] Error handling ${msg.type}:`, err);
        sendTo(ws, buildError(err.message, msg.id));
      }
    });

    ws.on('close', () => {
      const info = clients.get(ws);
      console.log(`[Bridge] Disconnected: ${info?.id} (${info?.role || 'unknown'})`);
      clients.delete(ws);

      // Clean up scripts owned by this connection
      for (const [scriptId, script] of scripts) {
        if (script.ws === ws) {
          script.state = 'disconnected';
          script.ws = null;
          // Unblock any checkpoint wait so the async handler can exit cleanly
          if (script.pendingStep) {
            script._cancelledDuringStep = true;
            const resolve = script.pendingStep;
            script.pendingStep = null;
            resolve();
          }
          console.log(`[Bridge] Script disconnected: ${script.name} (${scriptId})`);
          broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, scriptProgressPayload(scriptId, script, {
            state: 'disconnected', activeBreakpoints: [],
          })));
        }
      }
    });

    ws.on('error', (err) => {
      console.error(`[Bridge] WebSocket error:`, err.message);
    });

    ws.on('pong', () => {
      const info = clients.get(ws);
      if (info) info.lastPong = Date.now();
    });
  });

  /**
   * Find scriptId by PID (for V8 inspector events that fire before scriptId is known)
   */
  function findScriptIdByPid(pid) {
    for (const [scriptId, script] of scripts) {
      if (script.pid === pid) return scriptId;
    }
    return null;
  }

  /**
   * Build a standard script progress payload, always including sessionId.
   */
  function scriptProgressPayload(scriptId, script, overrides = {}) {
    return {
      scriptId,
      name: script.name,
      state: script.state,
      step: script.step,
      total: script.totalSteps,
      label: script.label,
      errors: script.errors,
      checkpoints: script.checkpoints || [],
      activeBreakpoints: Array.from(script.breakpoints || []),
      activity: script.activity || '',
      sessionId: script.sessionId || null,
      startedAt: script.startedAt || null,
      poll: script.poll || null,
      ...overrides,
    };
  }

  /**
   * Take a screenshot of the session browser's active page via CDP.
   * Returns a Buffer with PNG data, or null on failure.
   * Picks the most recently active non-blank, non-extension page.
   */
  async function cdpScreenshot(cdpEndpoint) {
    // Fetch page list from CDP
    const pageList = await new Promise((resolve, reject) => {
      const url = new URL('/json', cdpEndpoint);
      http.get(url.toString(), (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      }).on('error', reject);
    });

    // Find the best page: prefer navigated (http/https) page, skip extensions/devtools
    const candidates = pageList.filter(p =>
      p.type === 'page' &&
      p.url &&
      !p.url.startsWith('chrome-extension://') &&
      !p.url.startsWith('devtools://') &&
      p.url !== 'about:blank'
    );

    // Sort by most recently active (last in list tends to be newest tab)
    const target = candidates[candidates.length - 1] || pageList.find(p => p.type === 'page');
    if (!target || !target.webSocketDebuggerUrl) return null;

    // Connect and call Page.captureScreenshot via CDP
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      const timer = setTimeout(() => { ws.close(); reject(new Error('CDP screenshot timeout')); }, 15000);
      ws.once('open', () => {
        ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png', captureBeyondViewport: false } }));
      });
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id === 1) {
            clearTimeout(timer);
            ws.close();
            if (msg.result && msg.result.data) {
              resolve(Buffer.from(msg.result.data, 'base64'));
            } else {
              reject(new Error('CDP screenshot: no data returned'));
            }
          }
        } catch (e) {
          clearTimeout(timer);
          ws.close();
          reject(e);
        }
      });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }

  /**
   * Capture a screenshot at a checkpoint and store as artifact.
   * Uses CDP directly for the session's active page (playwright-cli
   * screenshot command only sees its own pages, not CDP-connected ones).
   */
  async function captureCheckpointScreenshot(scriptId, script, checkpointName) {
    const session = getSession(script.sessionId);
    if (!session || !session._cdpEndpoint) return;

    const timestamp = Date.now();
    const safeName = checkpointName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = pathResolve(ARTIFACTS_DIR, scriptId);
    await mkdir(dir, { recursive: true });
    const filename = `checkpoint_${safeName}_${timestamp}.png`;
    const filePath = pathResolve(dir, filename);

    try {
      const pngBuffer = await cdpScreenshot(session._cdpEndpoint);
      if (!pngBuffer) throw new Error('No page available for screenshot');
      await writeFile(filePath, pngBuffer);
      const size = pngBuffer.length;

      const artifact = {
        type: 'screenshot',
        label: `${checkpointName} screenshot`,
        timestamp,
        size,
        diskPath: filePath,
        contentType: 'image/png',
      };
      script.artifacts.push(artifact);

      // Broadcast artifact metadata (no binary)
      broadcast(buildMessage(MSG.BRIDGE_SCRIPT_ARTIFACT, {
        scriptId,
        artifact,
      }));
      console.log(`[Bridge] Artifact captured: ${filename} (${size} bytes)`);
    } catch (err) {
      console.warn(`[Bridge] Screenshot capture failed at ${checkpointName}: ${err.message}`);
    }
  }

  /**
   * Build a run record + artifact manifest for a completed script.
   * Broadcasts BRIDGE_SCRIPT_RUN_COMPLETE.
   */
  function broadcastRunComplete(scriptId, script, finalState) {
    const now = Date.now();
    const durationMs = script.duration || (now - script.startedAt);

    // Add console buffer as artifact
    if (script.consoleBuffer && script.consoleBuffer.length > 0) {
      script.artifacts.push({
        type: 'console',
        label: 'Console output',
        timestamp: now,
        size: script.consoleBuffer.length,
        data: script.consoleBuffer,
        diskPath: null,
        contentType: 'text/plain',
      });
    }

    // Add script results as artifact if available
    if (script.results) {
      const resultsStr = typeof script.results === 'string' ? script.results : JSON.stringify(script.results, null, 2);
      script.artifacts.push({
        type: 'result',
        label: 'Script results',
        timestamp: now,
        size: resultsStr.length,
        data: resultsStr,
        diskPath: null,
        contentType: 'application/json',
      });
    }

    const runRecord = {
      scriptId,
      name: script.name,
      state: finalState,
      startedAt: script.startedAt,
      completedAt: now,
      durationMs,
      step: script.step,
      totalSteps: script.totalSteps,
      errors: script.errors || 0,
      sessionId: script.sessionId || null,
      artifactCount: script.artifacts.length,
    };

    // Build artifact manifest (strip large inline data for broadcast — send metadata only)
    const artifactManifest = script.artifacts.map((a, idx) => ({
      id: idx,
      type: a.type,
      label: a.label,
      timestamp: a.timestamp,
      size: a.size,
      diskPath: a.diskPath || null,
      contentType: a.contentType,
      // Include inline data only for small non-screenshot artifacts
      data: (!a.diskPath && a.data && a.size < ARTIFACT_INLINE_LIMIT) ? a.data : null,
    }));

    broadcast(buildMessage(MSG.BRIDGE_SCRIPT_RUN_COMPLETE, {
      run: runRecord,
      artifacts: artifactManifest,
    }));
    console.log(`[Bridge] Run complete broadcast: ${script.name} (${finalState}, ${script.artifacts.length} artifacts)`);
  }

  /**
   * Find nearest node_modules directory by walking up from startDir.
   * Used to symlink dependencies for scripts launched from the synced scripts dir.
   */
  async function findNearestNodeModules(startDir) {
    let dir = startDir;
    while (true) {
      const candidate = pathResolve(dir, 'node_modules');
      try {
        const s = await stat(candidate);
        if (s.isDirectory()) return candidate;
      } catch {}
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  /**
   * Launch a script process. Reusable by both BRIDGE_SCRIPT_LAUNCH and schedule triggers.
   * @param {object} payload - { path, args, breakpoints, lineBreakpoints, debug, sessionId, originalPath }
   * @returns {Promise<{ success: true, launchId: string, pid: number, v8Debug: boolean }>}
   * @throws {Error} on validation or launch failures
   */
  async function launchScriptInternal(payload) {
    const { path: scriptPath, args: scriptArgs = [], breakpoints: preBreakpoints, lineBreakpoints, debug, sessionId: launchSessionId, originalPath, preActions, postActions, captureArtifacts } = payload;

    const useV8Debug = debug || (Array.isArray(lineBreakpoints) && lineBreakpoints.length > 0);
    const nodeArgs = useV8Debug ? ['--inspect-brk=0', scriptPath, ...scriptArgs] : [scriptPath, ...scriptArgs];
    const launchEnv = { ...process.env };

    // Session linking
    if (launchSessionId) {
      const linkedSession = getSession(launchSessionId);
      if (!linkedSession) throw new Error(`Session not found: ${launchSessionId}`);
      const sessionInfo = linkedSession.getInfo();
      if (!sessionInfo.cdpEndpoint) throw new Error(`Session "${linkedSession.name}" has no CDP endpoint (browser may not be running)`);
      for (const [, s] of scripts) {
        if (s.sessionId === launchSessionId && ['registered', 'running', 'paused', 'checkpoint'].includes(s.state)) {
          throw new Error(`Session "${linkedSession.name}" already has an active script: ${s.name}`);
        }
      }
      launchEnv.BRIDGE_CDP_ENDPOINT = sessionInfo.cdpEndpoint;
      console.log(`[Bridge] Script will connect to session "${linkedSession.name}" via CDP (${sessionInfo.cdpEndpoint})`);
    }

    // Auth state merge
    try {
      const scriptBaseName = scriptPath.split(/[/\\]/).pop().replace(/\.(mjs|js)$/, '');
      const allFiles = await readdir(AUTH_DIR).catch(() => []);
      const authFiles = [];
      const scriptAuthPath = pathResolve(AUTH_DIR, `${scriptBaseName}.json`);
      try { await stat(scriptAuthPath); authFiles.push(scriptAuthPath); } catch {}
      for (const f of allFiles) {
        if (!f.endsWith('.json')) continue;
        if (f.startsWith('_')) continue;
        const base = f.slice(0, -5);
        if (base === scriptBaseName) continue;
        if (base.includes('.')) authFiles.push(pathResolve(AUTH_DIR, f));
      }
      if (authFiles.length > 0) {
        const merged = { cookies: [], origins: [] };
        for (const af of authFiles) {
          try {
            const s = JSON.parse(await readFile(af, 'utf8'));
            merged.cookies.push(...(s.cookies || []));
            merged.origins.push(...(s.origins || []));
          } catch {}
        }
        const seen = new Map();
        for (const c of merged.cookies) seen.set(`${c.name}|${c.domain}|${c.path}`, c);
        merged.cookies = [...seen.values()];
        const mergedPath = pathResolve(AUTH_DIR, `_merged_${scriptBaseName}.json`);
        await writeFile(mergedPath, JSON.stringify(merged));
        launchEnv.PLAYWRIGHT_AUTH_STATE = mergedPath;
        console.log(`[Bridge] Auth state merged (${authFiles.length} file(s)): ${authFiles.map(f => f.split(/[/\\]/).pop()).join(', ')}`);
      }
    } catch (err) { console.warn(`[Bridge] Auth state merge failed: ${err.message}`); }

    // Dependency resolution
    let launchCwd = undefined;
    if (originalPath) {
      const originalDir = dirname(originalPath);
      launchCwd = originalDir;
      try {
        const nodeModulesPath = await findNearestNodeModules(originalDir);
        if (nodeModulesPath) {
          const symlinkDest = pathResolve(SCRIPTS_DIR, 'node_modules');
          try {
            const existing = await lstat(symlinkDest);
            if (existing.isSymbolicLink()) {
              const currentTarget = await readlink(symlinkDest);
              if (currentTarget !== nodeModulesPath) {
                await unlink(symlinkDest);
                await symlink(nodeModulesPath, symlinkDest, 'dir');
              }
            }
          } catch {
            await symlink(nodeModulesPath, symlinkDest, 'dir');
          }
          console.log(`[Bridge] node_modules symlink: ${SCRIPTS_DIR}/node_modules → ${nodeModulesPath}`);
        }
      } catch (err) {
        console.warn(`[Bridge] node_modules symlink failed (non-fatal): ${err.message}`);
      }
    }

    // Execute pre-actions on the linked session before spawning the script
    if (Array.isArray(preActions) && preActions.length > 0 && launchSessionId) {
      const session = getSession(launchSessionId);
      if (!session) throw new Error(`Pre-actions: session not found: ${launchSessionId}`);
      for (let i = 0; i < preActions.length; i++) {
        const action = preActions[i];
        try {
          const { command, cmdArgs } = actionToCommandArgs(action);
          console.log(`[Bridge] Pre-action ${i + 1}/${preActions.length}: ${command} ${cmdArgs.join(' ')}`);
          await session.sendCommand(command, cmdArgs);
        } catch (err) {
          throw new Error(`Pre-action failed (${action.command}): ${err.message}`);
        }
      }
    }

    console.log(`[Bridge] Launching script: node ${nodeArgs.join(' ')}${useV8Debug ? ' [V8 DEBUG]' : ''}${launchCwd ? ` [cwd: ${launchCwd}]` : ''}`);
    const child = spawn('node', nodeArgs, {
      detached: false,
      stdio: 'pipe',
      env: launchEnv,
      ...(launchCwd && { cwd: launchCwd }),
    });
    const launchId = `launch_${Date.now()}`;

    if (Array.isArray(preBreakpoints) && preBreakpoints.length > 0 && child.pid) {
      pendingBreakpoints.set(child.pid, preBreakpoints);
      console.log(`[Bridge] Pre-breakpoints queued for PID ${child.pid}: ${preBreakpoints.join(', ')}`);
    }
    if (launchSessionId && child.pid) {
      pendingSessionLinks.set(child.pid, launchSessionId);
    }
    if (Array.isArray(postActions) && postActions.length > 0 && launchSessionId && child.pid) {
      pendingPostActions.set(child.pid, { sessionId: launchSessionId, actions: postActions });
    }
    if (captureArtifacts && child.pid) {
      pendingCaptureArtifacts.set(child.pid, true);
    }

    // Console buffer — always capture stdout/stderr for run archive
    if (child.pid) pendingConsoleBuffers.set(child.pid, '');
    function appendConsoleBuffer(pid, text) {
      // Append to script object if registered, otherwise to pending buffer
      let target = null;
      for (const [, s] of scripts) {
        if (s.pid === pid) { target = s; break; }
      }
      if (target) {
        target.consoleBuffer = (target.consoleBuffer || '') + text;
        if (target.consoleBuffer.length > CONSOLE_BUFFER_LIMIT) {
          target.consoleBuffer = target.consoleBuffer.slice(-CONSOLE_BUFFER_LIMIT);
        }
      } else if (pendingConsoleBuffers.has(pid)) {
        let buf = pendingConsoleBuffers.get(pid) + text;
        if (buf.length > CONSOLE_BUFFER_LIMIT) buf = buf.slice(-CONSOLE_BUFFER_LIMIT);
        pendingConsoleBuffers.set(pid, buf);
      }
    }

    child.stdout.on('data', d => {
      const text = d.toString();
      console.log(`[Script:${launchId}] ${text.trim()}`);
      appendConsoleBuffer(child.pid, text);
    });

    if (useV8Debug) {
      let inspectorConnected = false;
      child.stderr.on('data', async (d) => {
        const text = d.toString().trim();
        console.error(`[Script:${launchId}] ERR: ${text}`);
        appendConsoleBuffer(child.pid, text + '\n');
        if (inspectorConnected) return;
        const inspectorUrl = parseInspectorUrl(text);
        if (!inspectorUrl) return;
        inspectorConnected = true;
        console.log(`[Bridge] V8 Inspector URL: ${inspectorUrl}`);
        try {
          const inspector = new InspectorClient(inspectorUrl);
          await inspector.connect();
          await inspector.enable();
          pendingInspectors.set(child.pid, inspector);
          if (Array.isArray(lineBreakpoints)) {
            const fileUrl = pathToFileURL(scriptPath).href;
            for (const line of lineBreakpoints) {
              try {
                const bp = await inspector.setBreakpoint(fileUrl, line);
                console.log(`[Bridge] V8 breakpoint set: line ${bp.actualLine} (requested ${line})`);
              } catch (err) {
                console.warn(`[Bridge] V8 breakpoint failed at line ${line}: ${err.message}`);
              }
            }
          }
          let firstPauseHandled = false;
          inspector.onPaused(async (data) => {
            console.log(`[Bridge] V8 paused: ${data.file}:${data.line} (${data.reason})`);
            if (!firstPauseHandled) {
              firstPauseHandled = true;
              if (data.reason === 'Break on start' || (!data.file && data.line === 1)) {
                console.log(`[Bridge] Auto-resuming past ESM entry pause`);
                try { await inspector.resume(); } catch {}
                return;
              }
            }
            const scriptId = findScriptIdByPid(child.pid);
            broadcast(buildMessage(MSG.BRIDGE_DBG_PAUSED, {
              scriptId, pid: child.pid,
              line: data.line, file: data.file, column: data.column,
              reason: data.reason, callFrames: data.callFrames,
            }));
          });
          inspector.onResumed(() => {
            const scriptId = findScriptIdByPid(child.pid);
            broadcast(buildMessage(MSG.BRIDGE_DBG_RESUMED, { scriptId, pid: child.pid }));
          });
          try {
            await inspector.runIfWaitingForDebugger();
            console.log(`[Bridge] V8 Inspector attached, initial breakpoints set, script running`);
          } catch (resumeErr) {
            console.warn(`[Bridge] V8 initial runIfWaitingForDebugger failed: ${resumeErr.message}`);
          }
        } catch (err) {
          console.error(`[Bridge] V8 Inspector connect failed: ${err.message}`);
        }
      });
    } else {
      child.stderr.on('data', d => {
        const text = d.toString();
        console.error(`[Script:${launchId}] ERR: ${text.trim()}`);
        appendConsoleBuffer(child.pid, text);
      });
    }

    child.on('error', err => {
      console.error(`[Bridge] Script launch error: ${err.message}`);
      broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, {
        scriptId: launchId, name: scriptPath, state: 'error',
        label: err.message, step: 0, total: 0, errors: 1,
      }));
    });
    child.on('exit', (code) => {
      console.log(`[Bridge] Script exited: ${scriptPath} (code ${code})`);
      if (pendingInspectors.has(child.pid)) {
        pendingInspectors.get(child.pid).disconnect();
        pendingInspectors.delete(child.pid);
      }
      for (const [, script] of scripts) {
        if (script.pid === child.pid && script.inspector) {
          script.inspector.disconnect();
          script.inspector = null;
        }
      }
      // Close out schedule history for scripts that crashed before registering
      if (code !== 0) {
        for (const [, sched] of schedules) {
          const entry = sched.history?.find(h => h.pid === child.pid && !h.completedAt);
          if (entry) {
            entry.completedAt = Date.now();
            entry.durationMs = entry.completedAt - entry.startedAt;
            entry.state = 'failed';
            entry.error = `Process exited with code ${code}`;
            saveSchedules();
            broadcast(buildMessage(MSG.BRIDGE_SCHEDULE_UPDATE, { schedule: sched }));
            break;
          }
        }
      }
    });

    return { success: true, launchId, pid: child.pid, v8Debug: useV8Debug };
  }

  /**
   * Get the InspectorClient for a script (by scriptId or pid).
   * Falls back to pendingInspectors for scripts that haven't registered yet.
   */
  function getInspector(scriptId, pid) {
    if (scriptId) {
      const script = scripts.get(scriptId);
      console.log(`[getInspector] scriptId=${scriptId} found=${!!script} hasInspector=${!!script?.inspector} pid=${pid} pendingKeys=[${[...pendingInspectors.keys()]}]`);
      if (script?.inspector) return script.inspector;
    }
    // pendingInspectors keys are numeric PIDs; coerce in case payload sent a string
    const numPid = pid ? Number(pid) : null;
    if (numPid && pendingInspectors.has(numPid)) {
      return pendingInspectors.get(numPid);
    }
    return null;
  }

  /**
   * Find first connected client with a given role
   */
  function findClientByRole(role) {
    for (const [clientWs, info] of clients) {
      if (info.role === role && clientWs.readyState === WebSocket.OPEN) {
        return clientWs;
      }
    }
    return null;
  }

  /**
   * Handle incoming message
   */
  async function handleMessage(ws, msg) {
    const clientInfo = clients.get(ws);

    // Check if this is a relay reply from the extension
    if (msg.replyTo && pendingRelays.has(msg.replyTo)) {
      const { ws: requesterWs, originalMsgId } = pendingRelays.get(msg.replyTo);
      pendingRelays.delete(msg.replyTo);
      // Forward the reply with the original message ID so the requester can match it
      const relayed = { ...msg, replyTo: originalMsgId };
      sendTo(requesterWs, relayed);
      return;
    }

    switch (msg.type) {
      case MSG.BRIDGE_IDENTIFY: {
        const role = msg.payload?.role;
        if (!role || !Object.values(ROLES).includes(role)) {
          sendTo(ws, buildError('Invalid role. Use "extension", "claude", or "cli"', msg.id));
          return;
        }
        clientInfo.role = role;
        console.log(`[Bridge] Client ${clientInfo.id} identified as: ${role}`);
        sendTo(ws, buildReply(msg, {
          success: true,
          clientId: clientInfo.id,
          role,
          sessions: listSessionInfos(),
          shimPath: SHIM_PATH,
          scriptsDir: SCRIPTS_DIR,
        }));
        break;
      }

      case MSG.BRIDGE_HEALTH: {
        sendTo(ws, buildReply(msg, {
          uptime: process.uptime(),
          clients: clients.size,
          sessions: sessions.size,
          scripts: scripts.size,
        }));
        break;
      }

      case MSG.BRIDGE_SESSION_CREATE: {
        const { name, authPath, timeout } = msg.payload || {};
        const sessionName = name || `session_${sessions.size + 1}`;

        // Check for duplicate name
        for (const s of sessions.values()) {
          if (s.name === sessionName && s.state !== SESSION_STATE.DESTROYED) {
            sendTo(ws, buildError(`Session "${sessionName}" already exists`, msg.id));
            return;
          }
        }

        const session = new PlaywrightSession(sessionName, { authPath, timeout });
        session.onStateChange((id, state, meta) => {
          broadcast(buildMessage(MSG.BRIDGE_STATUS, {
            sessionId: id,
            state,
            ...meta,
          }));
        });

        sessions.set(session.id, session);

        try {
          await session.spawn();
          sendTo(ws, buildReply(msg, { success: true, session: session.getInfo() }));
          broadcast(buildMessage(MSG.BRIDGE_STATUS, {
            sessionId: session.id,
            state: session.state,
            name: session.name,
          }));
        } catch (err) {
          sessions.delete(session.id);
          sendTo(ws, buildError(`Failed to create session: ${err.message}`, msg.id));
        }
        break;
      }

      case MSG.BRIDGE_SESSION_DESTROY: {
        const session = getSession(msg.payload?.sessionId);
        if (!session) {
          sendTo(ws, buildError('Session not found', msg.id));
          return;
        }

        // Cancel any active scripts linked to this session
        for (const [scriptId, s] of scripts) {
          if (s.sessionId === session.id && ['registered', 'running', 'paused', 'checkpoint'].includes(s.state)) {
            s.state = 'cancelled';
            if (s.ws && s.ws.readyState === WebSocket.OPEN) {
              sendTo(s.ws, buildMessage(MSG.BRIDGE_SCRIPT_CANCEL, { scriptId, reason: 'Session destroyed' }));
            }
            broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, {
              scriptId, name: s.name, state: 'cancelled',
              step: s.step, total: s.totalSteps,
              label: 'Session destroyed', errors: s.errors,
              checkpoints: s.checkpoints,
              activeBreakpoints: Array.from(s.breakpoints),
              activity: '',
              sessionId: s.sessionId,
            }));
            console.log(`[Bridge] Cancelled script "${s.name}" (linked to destroyed session "${session.name}")`);
          }
        }

        await session.destroy();
        sessions.delete(session.id);
        sendTo(ws, buildReply(msg, { success: true }));
        broadcast(buildMessage(MSG.BRIDGE_STATUS, {
          sessionId: session.id,
          state: SESSION_STATE.DESTROYED,
        }));
        break;
      }

      case MSG.BRIDGE_SESSION_LIST: {
        sendTo(ws, buildReply(msg, { sessions: listSessionInfos() }));
        break;
      }

      case MSG.BRIDGE_SESSION_CLEAN: {
        // Destroy all dead/stale sessions, optionally destroy all
        const destroyAll = msg.payload?.all === true;
        const cleaned = [];
        for (const [id, session] of sessions) {
          if (session.state === SESSION_STATE.DESTROYED) {
            sessions.delete(id);
            cleaned.push({ id, name: session.name, reason: 'already_destroyed' });
            continue;
          }
          if (destroyAll) {
            await session.destroy();
            sessions.delete(id);
            cleaned.push({ id, name: session.name, reason: 'force_cleaned' });
            continue;
          }
          // Check if browser is still alive
          const alive = await session.isAlive();
          if (!alive) {
            await session.destroy();
            sessions.delete(id);
            cleaned.push({ id, name: session.name, reason: 'dead_browser' });
          }
        }
        sendTo(ws, buildReply(msg, {
          success: true,
          cleaned,
          remaining: listSessionInfos(),
        }));
        break;
      }

      case MSG.BRIDGE_SNAPSHOT: {
        const session = getSession(msg.payload?.sessionId);
        if (!session) {
          sendTo(ws, buildError('Session not found', msg.id));
          return;
        }
        try {
          const yaml = await session.snapshot();
          const result = {
            sessionId: session.id,
            url: session.currentUrl,
            yaml,
            lines: yaml.split('\n').length,
            timestamp: Date.now(),
          };
          sendTo(ws, buildReply(msg, result));
          // Broadcast snapshot to all clients
          broadcast(buildMessage(MSG.BRIDGE_SNAPSHOT_RESULT, result));
        } catch (err) {
          sendTo(ws, buildError(`Snapshot failed: ${err.message}`, msg.id));
        }
        break;
      }

      case MSG.BRIDGE_NAVIGATE: {
        const session = getSession(msg.payload?.sessionId);
        if (!session) {
          sendTo(ws, buildError('Session not found', msg.id));
          return;
        }
        try {
          const result = await session.navigate(msg.payload.url);
          sendTo(ws, buildReply(msg, {
            success: true,
            sessionId: session.id,
            url: msg.payload.url,
            output: result,
          }));
        } catch (err) {
          sendTo(ws, buildError(`Navigate failed: ${err.message}`, msg.id));
        }
        break;
      }

      case MSG.BRIDGE_CLICK: {
        const session = getSession(msg.payload?.sessionId);
        if (!session) {
          sendTo(ws, buildError('Session not found', msg.id));
          return;
        }
        try {
          const result = await session.click(msg.payload.ref);
          sendTo(ws, buildReply(msg, {
            success: true,
            sessionId: session.id,
            ref: msg.payload.ref,
            output: result,
          }));
        } catch (err) {
          sendTo(ws, buildError(`Click failed: ${err.message}`, msg.id));
        }
        break;
      }

      case MSG.BRIDGE_FILL: {
        const session = getSession(msg.payload?.sessionId);
        if (!session) {
          sendTo(ws, buildError('Session not found', msg.id));
          return;
        }
        try {
          const result = await session.fill(msg.payload.ref, msg.payload.value);
          sendTo(ws, buildReply(msg, {
            success: true,
            sessionId: session.id,
            ref: msg.payload.ref,
            output: result,
          }));
        } catch (err) {
          sendTo(ws, buildError(`Fill failed: ${err.message}`, msg.id));
        }
        break;
      }

      case MSG.BRIDGE_EVAL: {
        const session = getSession(msg.payload?.sessionId);
        if (!session) {
          sendTo(ws, buildError('Session not found', msg.id));
          return;
        }
        try {
          const result = await session.evaluate(msg.payload.expr);
          sendTo(ws, buildReply(msg, {
            success: true,
            sessionId: session.id,
            result,
          }));
        } catch (err) {
          sendTo(ws, buildError(`Eval failed: ${err.message}`, msg.id));
        }
        break;
      }

      case MSG.BRIDGE_COMMAND: {
        // Generic command - route to session
        const session = getSession(msg.payload?.sessionId);
        if (!session) {
          sendTo(ws, buildError('Session not found', msg.id));
          return;
        }
        try {
          const parts = msg.payload.command.trim().split(/\s+/);
          const cmd = parts[0];
          const cmdArgs = parts.slice(1);
          const result = await session.sendCommand(cmd, cmdArgs);
          sendTo(ws, buildReply(msg, {
            success: true,
            sessionId: session.id,
            output: result,
          }));
        } catch (err) {
          sendTo(ws, buildError(`Command failed: ${err.message}`, msg.id));
        }
        break;
      }

      case MSG.BRIDGE_PAUSE: {
        const session = getSession(msg.payload?.sessionId);
        if (!session) {
          sendTo(ws, buildError('Session not found', msg.id));
          return;
        }
        // Only Claude Code can pause sessions
        if (clientInfo.role !== ROLES.CLAUDE) {
          sendTo(ws, buildError('Only Claude Code can pause sessions', msg.id));
          return;
        }
        session._paused = true;
        sendTo(ws, buildReply(msg, { success: true, sessionId: session.id, paused: true }));
        broadcast(buildMessage(MSG.BRIDGE_STATUS, {
          sessionId: session.id,
          state: 'paused',
          pausedBy: clientInfo.id,
        }));
        break;
      }

      case MSG.BRIDGE_RESUME: {
        const session = getSession(msg.payload?.sessionId);
        if (!session) {
          sendTo(ws, buildError('Session not found', msg.id));
          return;
        }
        session._paused = false;
        sendTo(ws, buildReply(msg, { success: true, sessionId: session.id, paused: false }));
        broadcast(buildMessage(MSG.BRIDGE_STATUS, {
          sessionId: session.id,
          state: session.state,
          resumed: true,
        }));
        break;
      }

      case MSG.BRIDGE_SEARCH_SNAPSHOTS: {
        // Forward search request to the extension client and relay reply
        const extClient = findClientByRole(ROLES.EXTENSION);
        if (!extClient) {
          sendTo(ws, buildError('No extension client connected', msg.id));
          return;
        }
        // Forward the message to extension, relay its reply back to the requester
        const searchMsg = buildMessage(MSG.BRIDGE_SEARCH_SNAPSHOTS, msg.payload, 'server');
        // Store pending relay: when extension replies, forward to original requester
        pendingRelays.set(searchMsg.id, { ws, originalMsgId: msg.id });
        sendTo(extClient, searchMsg);
        break;
      }

      // ---- Script Integration (Phase 3) ----

      case MSG.BRIDGE_SCRIPT_REGISTER: {
        const { name, totalSteps, metadata, pid, checkpoints } = msg.payload || {};
        if (!name) {
          sendTo(ws, buildError('Script name required', msg.id));
          return;
        }
        const scriptId = `script_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        // Resolve session link from pending map (set at launch time)
        let sessionId = null;
        if (pid && pendingSessionLinks.has(pid)) {
          sessionId = pendingSessionLinks.get(pid);
          pendingSessionLinks.delete(pid);
          console.log(`[Bridge] Script linked to session: ${name} → ${sessionId}`);
        }
        scripts.set(scriptId, {
          ws, name, totalSteps: totalSteps || 0,
          step: 0, label: '', errors: 0, activity: '',
          state: 'registered', metadata: metadata || {},
          startedAt: Date.now(),
          pid: pid || null,
          sessionId,                          // linked session (null if standalone)
          checkpoints: checkpoints || [],     // available checkpoint names (for UI display)
          breakpoints: new Set(),             // active breakpoints (user-toggled)
          stepOnce: false,                    // true = pause at next checkpoint (Step button)
          pendingStep: null,                  // resolve fn when paused at checkpoint
          currentCheckpoint: null,
          pages: new Map(),                   // pageId → { url, title } (from playwright-shim)
          inspector: null,                    // InspectorClient (V8 debugger)
          captureArtifacts: false,            // set from launch payload
          artifacts: [],                      // accumulated artifact metadata during execution
          consoleBuffer: '',                  // stdout+stderr rolling buffer
        });
        // Transfer post-actions from pending map
        const script = scripts.get(scriptId);
        if (pid && pendingPostActions.has(pid)) {
          script.postActions = pendingPostActions.get(pid);
          pendingPostActions.delete(pid);
        }
        // Transfer captureArtifacts flag
        if (pid && pendingCaptureArtifacts.has(pid)) {
          script.captureArtifacts = true;
          pendingCaptureArtifacts.delete(pid);
        }
        // Transfer console buffer accumulated before registration
        if (pid && pendingConsoleBuffers.has(pid)) {
          script.consoleBuffer = pendingConsoleBuffers.get(pid);
          pendingConsoleBuffers.delete(pid);
        }
        // Attach V8 inspector if one was pending for this PID
        if (pid && pendingInspectors.has(pid)) {
          script.inspector = pendingInspectors.get(pid);
          pendingInspectors.delete(pid);
          console.log(`[Bridge] V8 Inspector attached to script: ${name} (${scriptId})`);
        }
        if (pid && pendingBreakpoints.has(pid)) {
          const preBreaks = pendingBreakpoints.get(pid);
          pendingBreakpoints.delete(pid);
          for (const bp of preBreaks) {
            script.breakpoints.add(bp);
          }
          console.log(`[Bridge] Script registered: ${name} (${scriptId}, ${totalSteps} steps, pid=${pid}) [pre-breakpoints: ${preBreaks.join(', ')}]`);
        } else {
          console.log(`[Bridge] Script registered: ${name} (${scriptId}, ${totalSteps} steps, pid=${pid || 'unknown'})`);
        }
        sendTo(ws, buildReply(msg, { success: true, scriptId, name }));
        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, {
          scriptId, name, state: 'registered',
          step: 0, total: totalSteps || 0, label: '', errors: 0,
          metadata: metadata || {},
          checkpoints: checkpoints || [],
          activeBreakpoints: Array.from(script.breakpoints),
          activity: '',
          sessionId: script.sessionId || null,
        }));
        break;
      }

      case MSG.BRIDGE_SCRIPT_PROGRESS: {
        const { scriptId, step, total, label, errors, activity } = msg.payload || {};
        const script = scripts.get(scriptId);
        if (!script) {
          sendTo(ws, buildError('Script not found', msg.id));
          return;
        }
        script.step = step ?? script.step;
        script.totalSteps = total ?? script.totalSteps;
        script.label = label ?? script.label;
        script.errors = errors ?? script.errors;
        script.activity = activity ?? script.activity;
        script.state = 'running';
        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, scriptProgressPayload(scriptId, script)));
        break;
      }

      case MSG.BRIDGE_SCRIPT_COMPLETE: {
        const { scriptId, results, errors, duration } = msg.payload || {};
        const script = scripts.get(scriptId);
        if (!script) {
          sendTo(ws, buildError('Script not found', msg.id));
          return;
        }
        const completedPid = script.pid;
        script.state = 'complete';
        script.errors = errors ?? script.errors;
        script.results = results;
        script.pid = null; // process has exited
        script.duration = duration || (Date.now() - script.startedAt);
        console.log(`[Bridge] Script complete: ${script.name} (${script.duration}ms, ${script.errors} errors)`);
        sendTo(ws, buildReply(msg, { success: true, scriptId }));
        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, scriptProgressPayload(scriptId, script, {
          step: script.totalSteps, label: 'Complete',
          results, duration: script.duration,
          activeBreakpoints: [],
        })));

        // Close out schedule history entry — match by PID (launchId and scriptId differ)
        if (completedPid) {
          for (const [, sched] of schedules) {
            const entry = sched.history?.find(h => h.pid === completedPid && !h.completedAt);
            if (entry) {
              entry.completedAt = Date.now();
              entry.durationMs = entry.completedAt - entry.startedAt;
              entry.state = (errors && errors > 0) ? 'failed' : 'completed';
              entry.error = (errors && errors > 0) ? `${errors} error(s)` : null;
              saveSchedules();
              broadcast(buildMessage(MSG.BRIDGE_SCHEDULE_UPDATE, { schedule: sched }));
              break;
            }
          }
        }

        // Execute post-actions (errors logged but don't affect script result)
        if (script.postActions) {
          const { sessionId: paSessionId, actions } = script.postActions;
          const paSession = getSession(paSessionId);
          if (paSession) {
            for (let i = 0; i < actions.length; i++) {
              try {
                const { command, cmdArgs } = actionToCommandArgs(actions[i]);
                console.log(`[Bridge] Post-action ${i + 1}/${actions.length}: ${command} ${cmdArgs.join(' ')}`);
                await paSession.sendCommand(command, cmdArgs);
              } catch (err) {
                console.warn(`[Bridge] Post-action failed (${actions[i].command}): ${err.message}`);
              }
            }
          } else {
            console.warn(`[Bridge] Post-actions skipped: session ${paSessionId} not found`);
          }
          script.postActions = null;
        }

        // Broadcast run-complete record + artifact manifest for archival
        broadcastRunComplete(scriptId, script, 'complete');
        break;
      }

      case MSG.BRIDGE_SCRIPT_PAUSE: {
        const { scriptId, reason } = msg.payload || {};
        const script = scripts.get(scriptId);
        if (!script) {
          sendTo(ws, buildError('Script not found', msg.id));
          return;
        }
        script.state = 'paused';
        console.log(`[Bridge] Script paused: ${script.name} (${reason || 'no reason'})`);
        // Forward pause to the script's WebSocket connection
        if (script.ws && script.ws.readyState === WebSocket.OPEN) {
          sendTo(script.ws, buildMessage(MSG.BRIDGE_SCRIPT_PAUSE, { scriptId, reason }));
        }
        sendTo(ws, buildReply(msg, { success: true, scriptId, state: 'paused' }));
        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, scriptProgressPayload(scriptId, script)));
        break;
      }

      case MSG.BRIDGE_SCRIPT_RESUME: {
        const { scriptId } = msg.payload || {};
        const script = scripts.get(scriptId);
        if (!script) {
          sendTo(ws, buildError('Script not found', msg.id));
          return;
        }
        script.state = 'running';
        console.log(`[Bridge] Script resumed: ${script.name}`);
        if (script.ws && script.ws.readyState === WebSocket.OPEN) {
          sendTo(script.ws, buildMessage(MSG.BRIDGE_SCRIPT_RESUME, { scriptId }));
        }
        sendTo(ws, buildReply(msg, { success: true, scriptId, state: 'running' }));
        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, scriptProgressPayload(scriptId, script)));
        break;
      }

      case MSG.BRIDGE_SCRIPT_CANCEL: {
        const { scriptId, reason, force } = msg.payload || {};
        const script = scripts.get(scriptId);
        if (!script) {
          sendTo(ws, buildError('Script not found', msg.id));
          return;
        }

        // Unblock checkpoint if script is paused there
        if (script.pendingStep) {
          script._cancelledDuringStep = true;
          const resolve = script.pendingStep;
          script.pendingStep = null;
          resolve();
        }

        if (force && script.pid) {
          // Force-kill: SIGTERM now, SIGKILL after 2s
          console.log(`[Bridge] Force-killing script: ${script.name} (pid=${script.pid})`);
          try { process.kill(script.pid, 'SIGTERM'); } catch { /* already dead */ }
          const pidToKill = script.pid;
          setTimeout(() => {
            try { process.kill(pidToKill, 'SIGKILL'); } catch { /* already dead */ }
          }, 2000);
          script.state = 'killed';
          script.duration = Date.now() - script.startedAt;
          script.pid = null;
          sendTo(ws, buildReply(msg, { success: true, scriptId, state: 'killed' }));
          broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, scriptProgressPayload(scriptId, script, {
            label: 'Force killed', activeBreakpoints: [],
          })));
          broadcastRunComplete(scriptId, script, 'killed');
          return;
        }

        // Cooperative cancel
        script.state = 'cancelled';
        script.duration = Date.now() - script.startedAt;
        console.log(`[Bridge] Script cancelled: ${script.name} (${reason || 'no reason'})`);
        if (script.ws && script.ws.readyState === WebSocket.OPEN) {
          sendTo(script.ws, buildMessage(MSG.BRIDGE_SCRIPT_CANCEL, { scriptId, reason }));
        }
        sendTo(ws, buildReply(msg, { success: true, scriptId, state: 'cancelled' }));
        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, scriptProgressPayload(scriptId, script, {
          label: `Cancelled: ${reason || ''}`,
        })));
        broadcastRunComplete(scriptId, script, 'cancelled');
        break;
      }

      case MSG.BRIDGE_SCRIPT_LIST: {
        const scriptList = [];
        for (const [scriptId, s] of scripts) {
          scriptList.push({
            scriptId, name: s.name, state: s.state,
            step: s.step, total: s.totalSteps,
            label: s.label, errors: s.errors,
            metadata: s.metadata, startedAt: s.startedAt,
            duration: s.duration || null,
            activity: s.activity || '',
            checkpoints: s.checkpoints || [],
            activeBreakpoints: Array.from(s.breakpoints),
            checkpoint: s.currentCheckpoint ? {
              name: s.currentCheckpoint.name,
              context: s.currentCheckpoint.context,
            } : null,
            sessionId: s.sessionId || null,
            poll: s.poll || null,
          });
        }
        sendTo(ws, buildReply(msg, { success: true, scripts: scriptList }));
        break;
      }

      // ---- Script Debugger (micro-management) ----

      case MSG.BRIDGE_SCRIPT_VERIFY_SESSION: {
        const { scriptId, sessionId, checks } = msg.payload || {};
        const session = getSession(sessionId);
        if (!session) {
          sendTo(ws, buildReply(msg, { ok: false, reason: `Session not found: ${sessionId}` }));
          return;
        }
        const { urlContains, snapshotContains } = checks || {};

        if (urlContains && session.currentUrl && !session.currentUrl.includes(urlContains)) {
          sendTo(ws, buildReply(msg, {
            ok: false,
            reason: `URL check failed: expected "${urlContains}" in "${session.currentUrl || 'none'}"`,
          }));
          return;
        }

        if (snapshotContains && snapshotContains.length > 0) {
          try {
            const snap = await session.snapshot();
            const snapLower = snap.toLowerCase();
            const found = snapshotContains.some(s => snapLower.includes(s.toLowerCase()));
            if (!found) {
              sendTo(ws, buildReply(msg, {
                ok: false,
                reason: `Session snapshot missing auth indicator (checked: ${snapshotContains.join(', ')})`,
              }));
              return;
            }
          } catch (err) {
            sendTo(ws, buildReply(msg, { ok: false, reason: `Snapshot failed: ${err.message}` }));
            return;
          }
        }

        sendTo(ws, buildReply(msg, { ok: true }));
        break;
      }

      case MSG.BRIDGE_SCRIPT_CHECKPOINT: {
        const { scriptId, name, context } = msg.payload || {};
        const script = scripts.get(scriptId);
        if (!script) {
          sendTo(ws, buildError('Script not found', msg.id));
          return;
        }

        // Artifact capture at checkpoint (async, non-blocking for pause logic)
        if (script.captureArtifacts && script.sessionId) {
          captureCheckpointScreenshot(scriptId, script, name).catch(err => {
            console.warn(`[Bridge] Checkpoint screenshot failed: ${err.message}`);
          });
        }

        // Should we pause here?
        // - stepOnce: Step was pressed → pause at ANY checkpoint, then clear flag
        // - breakpoint active: user set a breakpoint on this checkpoint
        const shouldPause = script.stepOnce || script.breakpoints.has(name);
        if (script.stepOnce) {
          script.stepOnce = false; // consume the single-step flag
        }

        if (!shouldPause) {
          sendTo(ws, buildReply(msg, { proceed: true, name, active: false }));
          return;
        }

        // Pause script, wait for Step or Continue or Cancel
        script.state = 'checkpoint';
        script.currentCheckpoint = { name, context, timestamp: Date.now() };
        console.log(`[Bridge] Script paused at checkpoint "${name}": ${script.name}`);

        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, scriptProgressPayload(scriptId, script, {
          checkpoint: { name, context },
        })));

        // Block until user clicks Step/Continue or script is cancelled
        await new Promise((resolve) => { script.pendingStep = resolve; });

        if (script._cancelledDuringStep) {
          delete script._cancelledDuringStep;
          sendTo(ws, buildReply(msg, { proceed: false, cancelled: true, name }));
          return;
        }

        script.state = 'running';
        script.currentCheckpoint = null;

        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, scriptProgressPayload(scriptId, script)));

        sendTo(ws, buildReply(msg, { proceed: true, name }));
        break;
      }

      case MSG.BRIDGE_SCRIPT_STEP: {
        const { scriptId, clearAll } = msg.payload || {};
        const script = scripts.get(scriptId);
        if (!script) {
          sendTo(ws, buildError('Script not found', msg.id));
          return;
        }
        if (!script.pendingStep) {
          sendTo(ws, buildError('Script is not paused at a checkpoint', msg.id));
          return;
        }
        if (clearAll) {
          // Continue: resume and pause at next active breakpoint (don't clear them)
          console.log(`[Bridge] Continue: ${script.name} (breakpoints preserved)`);
        } else {
          // Step: pause at the very next checkpoint regardless of breakpoints
          script.stepOnce = true;
          console.log(`[Bridge] Step (next checkpoint): ${script.name}`);
        }
        const resolve = script.pendingStep;
        script.pendingStep = null;
        resolve();
        sendTo(ws, buildReply(msg, { success: true, scriptId }));
        break;
      }

      case MSG.BRIDGE_SCRIPT_SET_BREAKPOINT: {
        const { scriptId, name, active } = msg.payload || {};
        const script = scripts.get(scriptId);
        if (!script) {
          sendTo(ws, buildError('Script not found', msg.id));
          return;
        }
        if (active) {
          script.breakpoints.add(name);
        } else {
          script.breakpoints.delete(name);
        }
        console.log(`[Bridge] Breakpoint ${active ? 'set' : 'cleared'}: ${script.name} @ ${name}`);
        sendTo(ws, buildReply(msg, {
          success: true, scriptId, name, active,
          activeBreakpoints: Array.from(script.breakpoints),
        }));
        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, scriptProgressPayload(scriptId, script, {
          checkpoint: script.currentCheckpoint ? {
            name: script.currentCheckpoint.name,
            context: script.currentCheckpoint.context,
          } : null,
        })));
        break;
      }

      case MSG.BRIDGE_SCRIPT_LAUNCH: {
        const payload = msg.payload || {};
        if (!payload.path) {
          sendTo(ws, buildError('Script path required', msg.id));
          break;
        }
        try {
          const result = await launchScriptInternal(payload);
          sendTo(ws, buildReply(msg, result));
        } catch (err) {
          sendTo(ws, buildError(err.message, msg.id));
        }
        break;
      }

      case MSG.BRIDGE_SCRIPT_SAVE: {
        const { name: rawName, source } = msg.payload || {};
        if (!rawName || !source) {
          sendTo(ws, buildError('name and source required', msg.id));
          return;
        }
        // Sanitize name: extract filename if a full path was sent (Windows compat)
        const name = rawName.split(/[/\\]/).pop().replace(/\.(mjs|js)$/, '');
        try {
          await mkdir(SCRIPTS_DIR, { recursive: true });
          const filePath = pathResolve(SCRIPTS_DIR, `${name}.mjs`);
          // Echo suppression: mark this path so the file watcher ignores our own write
          fileWatcherIgnore.add(filePath);
          await writeFile(filePath, source, 'utf-8');
          console.log(`[Bridge] Script saved: ${filePath} (${source.length} bytes)`);
          sendTo(ws, buildReply(msg, { success: true, path: filePath }));
        } catch (err) {
          sendTo(ws, buildError(`Failed to save script: ${err.message}`, msg.id));
        }
        break;
      }

      case MSG.BRIDGE_SCRIPT_SOURCE: {
        const { scriptPath } = msg.payload || {};
        if (!scriptPath) {
          sendTo(ws, buildError('scriptPath required', msg.id));
          return;
        }
        try {
          const source = await readFile(scriptPath, 'utf-8');
          sendTo(ws, buildReply(msg, { success: true, source, path: scriptPath }));
        } catch (err) {
          sendTo(ws, buildError(`Cannot read file: ${err.message}`, msg.id));
        }
        break;
      }

      case MSG.BRIDGE_SCRIPT_GET_ARTIFACT: {
        const { diskPath } = msg.payload || {};
        if (!diskPath) {
          sendTo(ws, buildError('diskPath required', msg.id));
          return;
        }
        // Security: only allow reading from ARTIFACTS_DIR
        const resolved = pathResolve(diskPath);
        if (!resolved.startsWith(ARTIFACTS_DIR)) {
          sendTo(ws, buildError('Access denied: path outside artifacts directory', msg.id));
          return;
        }
        try {
          const fileData = await readFile(resolved);
          const base64 = fileData.toString('base64');
          sendTo(ws, buildReply(msg, { success: true, data: `data:image/png;base64,${base64}` }));
        } catch (err) {
          sendTo(ws, buildError(`Cannot read artifact: ${err.message}`, msg.id));
        }
        break;
      }

      case MSG.BRIDGE_SCRIPT_DECLARE_CHECKPOINT: {
        const { scriptId, name } = msg.payload || {};
        const script = scripts.get(scriptId);
        if (!script) {
          sendTo(ws, buildError('Script not found', msg.id));
          return;
        }
        if (name && !script.checkpoints.includes(name)) {
          script.checkpoints.push(name);
        }
        sendTo(ws, buildReply(msg, { success: true }));
        // Broadcast updated checkpoint list so UIs show the new toggle immediately
        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, scriptProgressPayload(scriptId, script, {
          pages: Object.fromEntries(script.pages),
        })));
        break;
      }

      case MSG.BRIDGE_SCRIPT_PAGE_STATUS: {
        const { scriptId, pageId, url, title } = msg.payload || {};
        const script = scripts.get(scriptId);
        if (!script) return; // fire-and-forget, no error reply needed
        script.pages.set(pageId, { url: url || '', title: title || '' });
        // Broadcast so UIs can label the intercept toggles with the current URL
        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, scriptProgressPayload(scriptId, script, {
          pages: Object.fromEntries(script.pages),
        })));
        break;
      }

      // ---- Poll state (fire-and-forget, like PAGE_STATUS) ----

      case MSG.BRIDGE_SCRIPT_POLL_STATE: {
        const { scriptId, ...pollData } = msg.payload || {};
        const script = scripts.get(scriptId);
        if (!script) return;
        script.poll = pollData;
        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, scriptProgressPayload(scriptId, script)));
        break;
      }

      // ---- V8 Inspector Debugging (line-level) ----

      case MSG.BRIDGE_DBG_STEP_OVER:
      case MSG.BRIDGE_DBG_STEP_INTO:
      case MSG.BRIDGE_DBG_STEP_OUT:
      case MSG.BRIDGE_DBG_CONTINUE: {
        const { scriptId, pid } = msg.payload || {};
        const inspector = getInspector(scriptId, pid);
        if (!inspector) {
          sendTo(ws, buildError('No V8 debugger attached to this script', msg.id));
          return;
        }
        try {
          switch (msg.type) {
            case MSG.BRIDGE_DBG_STEP_OVER: await inspector.stepOver(); break;
            case MSG.BRIDGE_DBG_STEP_INTO: await inspector.stepInto(); break;
            case MSG.BRIDGE_DBG_STEP_OUT:  await inspector.stepOut(); break;
            case MSG.BRIDGE_DBG_CONTINUE:  await inspector.resume(); break;
          }
          sendTo(ws, buildReply(msg, { success: true, scriptId }));
        } catch (err) {
          sendTo(ws, buildError(`V8 debug command failed: ${err.message}`, msg.id));
        }
        break;
      }

      case MSG.BRIDGE_DBG_SET_BREAKPOINT: {
        const { scriptId, pid, file, line } = msg.payload || {};
        const inspector = getInspector(scriptId, pid);
        if (!inspector) {
          sendTo(ws, buildError('No V8 debugger attached to this script', msg.id));
          return;
        }
        try {
          const result = await inspector.setBreakpoint(file, line);
          sendTo(ws, buildReply(msg, { success: true, ...result }));
        } catch (err) {
          sendTo(ws, buildError(`Set breakpoint failed: ${err.message}`, msg.id));
        }
        break;
      }

      case MSG.BRIDGE_DBG_REMOVE_BREAKPOINT: {
        const { scriptId, pid, breakpointId } = msg.payload || {};
        const inspector = getInspector(scriptId, pid);
        if (!inspector) {
          sendTo(ws, buildError('No V8 debugger attached', msg.id));
          return;
        }
        try {
          await inspector.removeBreakpoint(breakpointId);
          sendTo(ws, buildReply(msg, { success: true }));
        } catch (err) {
          sendTo(ws, buildError(`Remove breakpoint failed: ${err.message}`, msg.id));
        }
        break;
      }

      case MSG.BRIDGE_DBG_EVALUATE: {
        const { scriptId, pid, expression, callFrameId } = msg.payload || {};
        const inspector = getInspector(scriptId, pid);
        if (!inspector) {
          sendTo(ws, buildError('No V8 debugger attached', msg.id));
          return;
        }
        try {
          const result = await inspector.evaluate(expression, callFrameId);
          sendTo(ws, buildReply(msg, { success: true, ...result }));
        } catch (err) {
          sendTo(ws, buildError(`Evaluate failed: ${err.message}`, msg.id));
        }
        break;
      }

      case MSG.BRIDGE_DBG_RESTART_FRAME: {
        const { scriptId, pid, callFrameId } = msg.payload || {};
        const inspector = getInspector(scriptId, pid);
        if (!inspector) {
          sendTo(ws, buildError('No V8 debugger attached', msg.id));
          return;
        }
        try {
          await inspector.restartFrame(callFrameId);
          sendTo(ws, buildReply(msg, { success: true }));
        } catch (err) {
          sendTo(ws, buildError(`Restart frame failed: ${err.message}`, msg.id));
        }
        break;
      }

      // ---- Auth capture ----

      case MSG.BRIDGE_AUTH_CAPTURE: {
        const { scriptName, url } = msg.payload || {};
        if (!scriptName || !url) {
          sendTo(ws, buildError('scriptName and url required', msg.id));
          break;
        }
        try {
          await mkdir(AUTH_DIR, { recursive: true });

          // Destroy any existing auth session for this script (prevent duplicates)
          const authSessionName = `auth_${scriptName}`;
          for (const [id, session] of sessions) {
            if (session.name === authSessionName) {
              try { await session.destroy(); } catch { /* ignore */ }
              sessions.delete(id);
            }
          }

          const session = new PlaywrightSession(authSessionName);
          sessions.set(session.id, session);
          await session.spawn();
          await session.navigate(url);

          console.log(`[Bridge] Auth capture started: ${authSessionName} → ${url}`);
          sendTo(ws, buildReply(msg, { sessionId: session.id, sessionName: authSessionName }));
        } catch (err) {
          sendTo(ws, buildError(`Auth capture failed: ${err.message}`, msg.id));
        }
        break;
      }

      case MSG.BRIDGE_AUTH_SAVE: {
        const { sessionId, scriptName } = msg.payload || {};
        if (!sessionId || !scriptName) {
          sendTo(ws, buildError('sessionId and scriptName required', msg.id));
          break;
        }
        const session = getSession(sessionId);
        if (!session) {
          sendTo(ws, buildError('Session not found', msg.id));
          break;
        }
        try {
          // Save by script name (backward compat)
          const authFilePath = pathResolve(AUTH_DIR, `${scriptName}.json`);
          await session.sendCommand('state-save', [authFilePath]);
          console.log(`[Bridge] Auth state saved: ${authFilePath}`);

          // Also save by domain name so any script accessing this domain gets auth
          let domainPath = null;
          try {
            const currentUrl = session.currentUrl;
            if (currentUrl && currentUrl.startsWith('http')) {
              const domain = new URL(currentUrl).hostname;
              domainPath = pathResolve(AUTH_DIR, `${domain}.json`);
              await session.sendCommand('state-save', [domainPath]);
              console.log(`[Bridge] Auth state saved by domain: ${domainPath}`);
            }
          } catch {}

          await session.destroy();
          sessions.delete(sessionId);
          sendTo(ws, buildReply(msg, { success: true, path: authFilePath, domainPath }));
        } catch (err) {
          sendTo(ws, buildError(`Auth save failed: ${err.message}`, msg.id));
        }
        break;
      }

      case MSG.BRIDGE_AUTH_CHECK: {
        const { scriptName } = msg.payload || {};
        if (!scriptName) {
          sendTo(ws, buildError('scriptName required', msg.id));
          break;
        }
        try {
          const authFilePath = pathResolve(AUTH_DIR, `${scriptName}.json`);
          await stat(authFilePath);
          sendTo(ws, buildReply(msg, { exists: true, path: authFilePath }));
        } catch {
          sendTo(ws, buildReply(msg, { exists: false, path: null }));
        }
        break;
      }

      case MSG.BRIDGE_SYSTEM_PROCESSES: {
        try {
          const processes = await discoverBrowserProcesses(scripts);
          sendTo(ws, buildReply(msg, { success: true, processes }));
        } catch (err) {
          sendTo(ws, buildError(`Process discovery failed: ${err.message}`, msg.id));
        }
        break;
      }

      case MSG.BRIDGE_KILL_PROCESS: {
        const { pid: killPid } = msg.payload || {};
        if (!killPid) {
          sendTo(ws, buildError('pid required', msg.id));
          return;
        }
        try {
          process.kill(killPid, 'SIGTERM');
          // Delayed SIGKILL if still alive
          const pidToKill = killPid;
          setTimeout(() => {
            try { process.kill(pidToKill, 'SIGKILL'); } catch { /* already dead */ }
          }, 2000);
          console.log(`[Bridge] Killed process: ${killPid}`);
          sendTo(ws, buildReply(msg, { success: true, pid: killPid }));
        } catch (err) {
          sendTo(ws, buildError(`Kill failed: ${err.message}`, msg.id));
        }
        break;
      }

      case MSG.BRIDGE_FILE_PICKER: {
        const { filter, title } = msg.payload || {};
        const dlgTitle = title || 'Open Script';
        const dlgFilter = filter || 'JavaScript files (*.mjs;*.js)|*.mjs;*.js|All files (*.*)|*.*';
        const psScript = [
          'Add-Type -AssemblyName System.Windows.Forms;',
          '$f = New-Object System.Windows.Forms.OpenFileDialog;',
          `$f.Filter = '${dlgFilter.replace(/'/g, "''")}';`,
          `$f.Title = '${dlgTitle.replace(/'/g, "''")}';`,
          // Create a topmost owner form so the dialog appears in front of the browser
          '$owner = New-Object System.Windows.Forms.Form;',
          '$owner.TopMost = $true;',
          '$owner.ShowInTaskbar = $false;',
          '$owner.Width = 0; $owner.Height = 0;',
          '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual;',
          '$owner.Location = New-Object System.Drawing.Point(-1000,-1000);',
          '$owner.Show(); $owner.Hide();',
          "if ($f.ShowDialog($owner) -eq 'OK') { Write-Output $f.FileName } else { Write-Output '' }",
          '$owner.Dispose();',
        ].join(' ');
        try {
          const selected = await new Promise((resolve, reject) => {
            execFile('powershell.exe', ['-NoProfile', '-Command', psScript], { timeout: 120000 }, (err, stdout) => {
              if (err) return reject(err);
              resolve(stdout.trim());
            });
          });
          if (!selected) {
            sendTo(ws, buildReply(msg, { cancelled: true }));
          } else {
            // Convert Windows path to WSL path
            const wslPath = await new Promise((resolve, reject) => {
              execFile('wslpath', ['-u', selected], (err, stdout) => {
                if (err) return resolve(selected); // fallback to raw path
                resolve(stdout.trim());
              });
            });
            console.log(`[Bridge] File picker: ${wslPath}`);
            sendTo(ws, buildReply(msg, { success: true, path: wslPath, windowsPath: selected }));
          }
        } catch (err) {
          sendTo(ws, buildError(`File picker failed: ${err.message}`, msg.id));
        }
        break;
      }

      // ---- Scheduling ----

      case MSG.BRIDGE_SCHEDULE_CREATE: {
        const { name, scriptPath, scriptName, args = [], sessionId = null, intervalMs, runOnStartup = false, maxConcurrent = 1, runNow = false, originalPath = null } = msg.payload || {};
        if (!scriptPath || !intervalMs) {
          sendTo(ws, buildError('scriptPath and intervalMs required', msg.id));
          break;
        }
        const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const schedule = {
          id, name: name || scriptName || scriptPath.split(/[/\\]/).pop(),
          scriptPath, scriptName: scriptName || null,
          originalPath,
          args, sessionId, intervalMs, enabled: true,
          runOnStartup, maxConcurrent,
          createdAt: Date.now(), lastRunAt: null, lastRunScriptId: null,
          nextRunAt: Date.now() + intervalMs,
          runCount: 0, history: [],
        };
        schedules.set(id, schedule);
        startScheduleTimer(id);
        await saveSchedules();
        sendTo(ws, buildReply(msg, { success: true, schedule }));
        broadcast(buildMessage(MSG.BRIDGE_SCHEDULE_UPDATE, { schedule }));
        if (runNow) triggerSchedule(id);
        break;
      }

      case MSG.BRIDGE_SCHEDULE_UPDATE: {
        const { scheduleId, ...updates } = msg.payload || {};
        const sched = schedules.get(scheduleId);
        if (!sched) {
          sendTo(ws, buildError(`Schedule not found: ${scheduleId}`, msg.id));
          break;
        }
        // Apply allowed updates
        for (const key of ['name', 'scriptName', 'intervalMs', 'args', 'sessionId', 'maxConcurrent', 'runOnStartup']) {
          if (updates[key] !== undefined) sched[key] = updates[key];
        }
        if (updates.enabled !== undefined) {
          sched.enabled = updates.enabled;
          if (sched.enabled) {
            startScheduleTimer(scheduleId);
          } else {
            stopScheduleTimer(scheduleId);
          }
        }
        if (updates.intervalMs !== undefined && sched.enabled) {
          // Restart timer with new interval
          startScheduleTimer(scheduleId);
        }
        await saveSchedules();
        sendTo(ws, buildReply(msg, { success: true, schedule: sched }));
        broadcast(buildMessage(MSG.BRIDGE_SCHEDULE_UPDATE, { schedule: sched }));
        break;
      }

      case MSG.BRIDGE_SCHEDULE_DELETE: {
        const { scheduleId } = msg.payload || {};
        const sched = schedules.get(scheduleId);
        if (!sched) {
          sendTo(ws, buildError(`Schedule not found: ${scheduleId}`, msg.id));
          break;
        }
        stopScheduleTimer(scheduleId);
        schedules.delete(scheduleId);
        await saveSchedules();
        sendTo(ws, buildReply(msg, { success: true, scheduleId }));
        broadcast(buildMessage('BRIDGE_SCHEDULE_DELETED', { scheduleId }));
        break;
      }

      case MSG.BRIDGE_SCHEDULE_LIST: {
        sendTo(ws, buildReply(msg, { success: true, schedules: [...schedules.values()] }));
        break;
      }

      case MSG.BRIDGE_SCHEDULE_TRIGGER: {
        const { scheduleId } = msg.payload || {};
        const sched = schedules.get(scheduleId);
        if (!sched) {
          sendTo(ws, buildError(`Schedule not found: ${scheduleId}`, msg.id));
          break;
        }
        sendTo(ws, buildReply(msg, { success: true, scheduleId }));
        triggerSchedule(scheduleId);
        break;
      }

      case MSG.BRIDGE_SCHEDULE_HISTORY: {
        const { scheduleId } = msg.payload || {};
        const sched = schedules.get(scheduleId);
        if (!sched) {
          sendTo(ws, buildError(`Schedule not found: ${scheduleId}`, msg.id));
          break;
        }
        sendTo(ws, buildReply(msg, { success: true, history: sched.history || [] }));
        break;
      }

      case MSG.BRIDGE_SC_GENERATE_UI: {
        const { prompt } = msg.payload || {};
        if (!prompt || !prompt.trim()) {
          sendTo(ws, buildError('Prompt is required', msg.id));
          break;
        }

        const SC_GENERATE_SYSTEM_PROMPT = `You are a SmartClient UI generator. Given a user description, output ONLY a JSON object with this structure:

{"dataSources":[...],"layout":{...}}

Rules:
- dataSources: array of {ID, fields:[{name,type,primaryKey,hidden,title,required,length,valueMap,canEdit}]}
  - ID must end with DS, always include {name:"id",type:"integer",primaryKey:true,hidden:true}
  - Field types: text, integer, float, date, datetime, boolean
  - For dropdowns use valueMap as an array of strings
- layout: component tree with _type and members[]
  - Allowed _type values: VLayout, HLayout, ListGrid, DynamicForm, Button, Label, TabSet, Tab, DetailViewer, SectionStack, HTMLFlow, Window, ToolStrip, ToolStripButton
  - ListGrid: set dataSource, autoFetchData:true, fields array with name and width
  - DynamicForm: set dataSource, fields with name and optionally editorType (TextItem, TextAreaItem, SelectItem, DateItem, CheckboxItem, SpinnerItem)
  - Button: use _action for behavior: "new","save","delete". Set _targetForm and _targetGrid to reference component IDs
  - ListGrid recordClick: set _action:"select" and _targetForm to auto-wire
  - Give components an ID string so buttons can reference them

Example for a task tracker:
{"dataSources":[{"ID":"TaskDS","fields":[{"name":"id","type":"integer","primaryKey":true,"hidden":true},{"name":"title","type":"text","required":true,"title":"Title","length":200},{"name":"status","type":"text","title":"Status","valueMap":["Todo","In Progress","Done"]},{"name":"dueDate","type":"date","title":"Due Date"}]}],"layout":{"_type":"VLayout","width":"100%","height":"100%","membersMargin":8,"layoutMargin":12,"members":[{"_type":"ListGrid","ID":"taskGrid","width":"100%","height":"*","dataSource":"TaskDS","autoFetchData":true,"canEdit":false,"selectionType":"single","_action":"select","_targetForm":"taskForm","fields":[{"name":"title","width":"*"},{"name":"status","width":120},{"name":"dueDate","width":120}]},{"_type":"DynamicForm","ID":"taskForm","width":"100%","dataSource":"TaskDS","numCols":2,"colWidths":[120,"*"],"fields":[{"name":"title","editorType":"TextItem"},{"name":"status","editorType":"SelectItem"},{"name":"dueDate","editorType":"DateItem"}]},{"_type":"HLayout","height":30,"membersMargin":8,"members":[{"_type":"Button","title":"New","width":80,"_action":"new","_targetForm":"taskForm"},{"_type":"Button","title":"Save","width":80,"_action":"save","_targetForm":"taskForm","_targetGrid":"taskGrid"},{"_type":"Button","title":"Delete","width":80,"_action":"delete","_targetGrid":"taskGrid"}]}]}}

Output ONLY the JSON object. No explanation, no markdown fences.`;

        console.log('[Bridge] SC_GENERATE_UI: spawning claude -p for:', prompt.trim().slice(0, 80));
        try {
          const raw = await spawnClaude('haiku', SC_GENERATE_SYSTEM_PROMPT, `User request: ${prompt.trim()}`);
          const config = parseClaudeJsonResponse(raw);
          validateSmartClientConfig(config);

          console.log('[Bridge] SC_GENERATE_UI: valid config with', config.dataSources.length, 'dataSources');
          sendTo(ws, buildReply(msg, { success: true, config }));
        } catch (err) {
          console.error('[Bridge] SC_GENERATE_UI error:', err.message);
          sendTo(ws, buildReply(msg, { success: false, error: err.message }));
        }
        break;
      }

      case MSG.BRIDGE_SC_CLONE_PAGE: {
        const { sessionId, url, model } = msg.payload || {};
        if (!sessionId) {
          sendTo(ws, buildError('sessionId is required', msg.id));
          break;
        }

        const cloneSession = getSession(sessionId);
        if (!cloneSession) {
          sendTo(ws, buildError(`Session not found: ${sessionId}`, msg.id));
          break;
        }

        const cloneModel = model || 'sonnet';
        const cloneTs = Date.now();
        const cloneRand = Math.random().toString(36).slice(2, 6);
        const cloneId = `clone_${cloneTs}_${cloneRand}`;
        const cloneDir = pathResolve(CLONES_DIR, cloneId);

        console.log(`[Bridge] SC_CLONE_PAGE: session=${sessionId}, url=${url || '(current page)'}, model=${cloneModel}, cloneId=${cloneId}`);

        try {
          // Create persistent clone directory
          await mkdir(cloneDir, { recursive: true });

          // Navigate if URL provided, then wait for page settle
          if (url) {
            console.log(`[Bridge] SC_CLONE_PAGE: navigating to ${url}`);
            await cloneSession.navigate(url);
            await new Promise(r => setTimeout(r, 3000));
          }

          // Capture: snapshot, screenshot, network (sequentially via session queue)
          console.log('[Bridge] SC_CLONE_PAGE: capturing snapshot...');
          const snapshotYaml = await cloneSession.snapshot();

          const screenshotPath = pathResolve(cloneDir, 'page.png');
          console.log('[Bridge] SC_CLONE_PAGE: capturing screenshot...');
          await cloneSession.screenshotToFile(screenshotPath);

          console.log('[Bridge] SC_CLONE_PAGE: capturing network requests...');
          let networkOutput;
          try {
            networkOutput = await cloneSession.networkRequests();
          } catch (netErr) {
            console.warn('[Bridge] SC_CLONE_PAGE: network capture failed (non-fatal):', netErr.message);
            networkOutput = '(network capture unavailable)';
          }

          // Process captures
          const pageUrl = url || cloneSession.currentUrl || '(unknown)';
          const truncatedSnapshot = truncateSnapshot(snapshotYaml);
          const filteredNetwork = filterNetworkForClone(networkOutput);
          const prompt = buildClonePrompt(pageUrl, truncatedSnapshot, filteredNetwork, screenshotPath);

          // Persist raw materials
          await writeFile(pathResolve(cloneDir, 'snapshot.yaml'), snapshotYaml);
          await writeFile(pathResolve(cloneDir, 'network.txt'), networkOutput);
          await writeFile(pathResolve(cloneDir, 'meta.json'), JSON.stringify({
            url: pageUrl,
            timestamp: new Date(cloneTs).toISOString(),
            snapshotLines: snapshotYaml.split('\n').length,
            networkEntries: filteredNetwork.split('\n').length,
          }, null, 2));

          console.log(`[Bridge] SC_CLONE_PAGE: snapshot=${snapshotYaml.split('\n').length} lines, network=${filteredNetwork.split('\n').length} lines`);
          console.log('[Bridge] SC_CLONE_PAGE: spawning claude -p (model:', cloneModel, ')...');

          const raw = await spawnClaude(cloneModel, SC_CLONE_SYSTEM_PROMPT, prompt, {
            addDir: cloneDir,
            allowedTools: 'Read',
            timeout: 120000,
          });

          const config = parseClaudeJsonResponse(raw);
          validateSmartClientConfig(config);

          console.log('[Bridge] SC_CLONE_PAGE: valid config with', config.dataSources.length, 'dataSources');
          sendTo(ws, buildReply(msg, {
            success: true,
            config,
            cloneId,
            sources: {
              url: pageUrl,
              snapshotLines: snapshotYaml.split('\n').length,
              networkEntries: filteredNetwork.split('\n').length,
              screenshotPath,
            },
          }));
        } catch (err) {
          console.error('[Bridge] SC_CLONE_PAGE error:', err.message);
          sendTo(ws, buildReply(msg, { success: false, error: err.message }));
          // Cleanup on failure only
          try {
            await rm(cloneDir, { recursive: true, force: true });
          } catch {}
        }
        break;
      }

      case MSG.BRIDGE_SC_DELETE_CLONE_ARTIFACTS: {
        const { cloneId } = msg.payload || {};
        if (!cloneId || !/^clone_\d+_[a-z0-9]+$/.test(cloneId)) {
          sendTo(ws, buildError('Invalid cloneId', msg.id));
          break;
        }
        const clonePath = pathResolve(CLONES_DIR, cloneId);
        try {
          await rm(clonePath, { recursive: true, force: true });
          console.log(`[Bridge] Deleted clone artifacts: ${cloneId}`);
          sendTo(ws, buildReply(msg, { success: true, cloneId }));
        } catch (err) {
          console.error(`[Bridge] Failed to delete clone ${cloneId}:`, err.message);
          sendTo(ws, buildReply(msg, { success: false, error: err.message }));
        }
        break;
      }

      case 'BRIDGE_SHUTDOWN': {
        console.log('[Bridge] Shutdown requested');
        await shutdown();
        break;
      }

      default:
        sendTo(ws, buildError(`Unknown message type: ${msg.type}`, msg.id));
    }
  }

  /**
   * Send a message to a specific client
   */
  function sendTo(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Broadcast a message to all connected clients
   */
  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const [ws, info] of clients) {
      if (ws.readyState === WebSocket.OPEN && info.role) {
        ws.send(data);
      }
    }
  }

  /**
   * Get a session by ID or name
   */
  function getSession(sessionId) {
    if (!sessionId) return null;
    // Try by ID first
    if (sessions.has(sessionId)) return sessions.get(sessionId);
    // Then by name
    for (const s of sessions.values()) {
      if (s.name === sessionId && s.state !== SESSION_STATE.DESTROYED) return s;
    }
    return null;
  }

  /**
   * List all session infos
   */
  function listSessionInfos() {
    return Array.from(sessions.values())
      .filter(s => s.state !== SESSION_STATE.DESTROYED)
      .map(s => s.getInfo());
  }

  /**
   * Graceful shutdown
   */
  async function shutdown() {
    console.log('[Bridge] Shutting down...');

    // Stop all schedule timers
    for (const [id] of scheduleTimers) stopScheduleTimer(id);

    // Stop file watcher
    if (fileWatcher) {
      fileWatcher.close();
      fileWatcher = null;
    }
    for (const timer of fileWatcherDebounce.values()) clearTimeout(timer);
    fileWatcherDebounce.clear();

    // Destroy all sessions
    for (const session of sessions.values()) {
      try {
        await session.destroy();
      } catch (err) {
        console.error(`[Bridge] Error destroying session ${session.name}:`, err);
      }
    }

    // Close all connections
    for (const [ws] of clients) {
      ws.close(1001, 'Server shutting down');
    }

    clearInterval(healthTimer);
    wss.close(() => {
      console.log('[Bridge] Server closed');
      process.exit(0);
    });
  }

  // Handle process signals
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
