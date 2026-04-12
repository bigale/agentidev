#!/usr/bin/env node

/**
 * Bridge WebSocket Server
 *
 * Accepts connections from Chrome extension and Claude Code.
 * Manages playwright-cli sessions as child processes.
 * Serializes commands per session (queue-based).
 * Broadcasts state changes to all connected clients.
 *
 * Start: node packages/bridge/server.mjs [--port=9876]
 * Stop:  Ctrl+C or node packages/bridge/server.mjs --stop
 */

import { WebSocketServer, WebSocket } from 'ws';
import { spawn, execFile } from 'child_process';
import http from 'http';
import { readFile, writeFile, mkdir, stat, readdir, symlink, lstat, unlink, readlink, rm } from 'fs/promises';
import { watch } from 'fs';
import { resolve as pathResolve, dirname } from 'path';
import { Cron } from 'croner';
import { fileURLToPath, pathToFileURL } from 'url';
import { homedir, tmpdir } from 'os';
import { MSG, buildMessage, buildReply, buildError, ROLES } from './protocol.mjs';
import { PlaywrightSession, SESSION_STATE } from './playwright-session.mjs';
import { InspectorClient, parseInspectorUrl } from './inspector-client.mjs';
import { actionToCommandArgs } from './cli-commands.mjs';
import { initDB, saveRun, saveArtifact, upsertStore, exportAll } from './db.mjs';
import { initEmbeddings, isEmbeddingReady } from './embeddings.mjs';
import { initVectorDB, addPage as vectorAddPage, search as vectorSearch, getStats as vectorGetStats } from './vectordb.mjs';

const DEFAULT_PORT = 9876;
const HEALTH_INTERVAL = 30000; // 30s ping/pong
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = pathResolve(__dirname, '..', '..');
const SHIM_PATH = pathResolve(__dirname, 'playwright-shim.mjs');
const SCRIPTS_DIR = pathResolve(homedir(), '.agentidev', 'scripts');
const AUTH_DIR = pathResolve(homedir(), '.agentidev', 'auth');
const CLONES_DIR = pathResolve(homedir(), '.agentidev', 'clones');
const ARTIFACTS_DIR = pathResolve(homedir(), '.agentidev', 'artifacts');
const ARTIFACT_INLINE_LIMIT = 100 * 1024; // 100KB — below this, store as base64 inline
const CONSOLE_BUFFER_LIMIT = 500 * 1024;  // 500KB max console buffer per script

// Sources stored in bridge LanceDB (not relayed to extension)
const BRIDGE_VECTOR_SOURCES = new Set(['showcase', 'reference', 'docs', 'template']);

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
 *  - Our debug profile Chrome (args contain 'chrome-debug-profile' or 'agentidev/browser-profile')
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
        const isDebugProfile = args.includes('chrome-debug-profile') || args.includes('agentidev/browser-profile');
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

  // Extract the first balanced JSON object using brace depth tracking
  // (greedy regex fails when model adds explanation text containing braces)
  const start = cleaned.indexOf('{');
  if (start === -1) {
    throw new Error('No JSON object found in Claude response');
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return JSON.parse(cleaned.slice(start, i + 1));
      }
    }
  }
  throw new Error('No complete JSON object found in Claude response');
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
  const SCHEDULES_FILE = pathResolve(homedir(), '.agentidev', 'schedules.json');

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
    if (sched.cronExpr) {
      const job = new Cron(sched.cronExpr, { timezone: 'America/New_York' }, () => triggerSchedule(id));
      scheduleTimers.set(id, job);
      sched.nextRunAt = job.nextRun() ? job.nextRun().getTime() : null;
      console.log(`[Bridge] Schedule timer started: ${sched.name} (cron: ${sched.cronExpr}, next: ${sched.nextRunAt ? new Date(sched.nextRunAt).toLocaleString() : 'none'})`);
    } else {
      sched.nextRunAt = Date.now() + sched.intervalMs;
      const timer = setInterval(() => triggerSchedule(id), sched.intervalMs);
      scheduleTimers.set(id, timer);
      console.log(`[Bridge] Schedule timer started: ${sched.name} (every ${sched.intervalMs}ms)`);
    }
  }

  function stopScheduleTimer(id) {
    const timer = scheduleTimers.get(id);
    if (timer) {
      if (typeof timer.stop === 'function') {
        timer.stop();
      } else {
        clearInterval(timer);
      }
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
      if (sched.enabled) {
        if (sched.cronExpr) {
          const job = scheduleTimers.get(id);
          sched.nextRunAt = job && job.nextRun() ? job.nextRun().getTime() : null;
        } else {
          sched.nextRunAt = Date.now() + sched.intervalMs;
        }
      } else {
        sched.nextRunAt = null;
      }

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
  initDB();
  // Initialize bridge-side vector DB and embedding model (non-blocking — bridge
  // accepts connections immediately; indexing waits for isEmbeddingReady())
  initVectorDB().catch(err => console.error('[Bridge] VectorDB init failed:', err.message));
  initEmbeddings().catch(err => console.error('[Bridge] Embeddings init failed:', err.message));

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

    // Dual-write to SQLite (non-blocking — failures are non-fatal)
    try {
      saveRun(runRecord);
      for (const a of artifactManifest) {
        saveArtifact({ runId: scriptId, ...a });
      }
    } catch (err) {
      console.warn(`[Bridge] SQLite dual-write failed (non-fatal): ${err.message}`);
    }

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
        for (const c of merged.cookies) {
          const key = `${c.name}|${c.domain}|${c.path}`;
          const existing = seen.get(key);
          if (!existing) { seen.set(key, c); continue; }
          // Prefer: later positive expiry > any positive > session; session cookies: last-file-wins
          // (domain files are added after script-specific files, so last-wins lets domain override stale script auth)
          const newExp = c.expires ?? -1;
          const oldExp = existing.expires ?? -1;
          if (newExp > 0 && oldExp > 0 && newExp > oldExp) seen.set(key, c);  // later expiry wins
          else if (newExp > 0 && oldExp <= 0) seen.set(key, c);               // positive beats session
          else if (newExp <= 0 && oldExp <= 0) seen.set(key, c);              // both session: last wins
        }
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
    // Return the most recently connected client with the given role.
    // When an extension reloads, the old WebSocket may linger briefly,
    // so we prefer the newest connection.
    let found = null;
    for (const [clientWs, info] of clients) {
      if (info.role === role && clientWs.readyState === WebSocket.OPEN) {
        found = clientWs;
      }
    }
    return found;
  }

  /**
   * Relay a message to a target role client and await the reply as a Promise.
   * Returns the reply payload, or {} on timeout/no client.
   */
  function awaitRelay(targetRole, msgType, payload, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const client = findClientByRole(targetRole);
      if (!client) { resolve({}); return; }
      const relayMsg = buildMessage(msgType, payload, 'server');
      const timer = setTimeout(() => {
        pendingRelays.delete(relayMsg.id);
        resolve({});
      }, timeoutMs);
      pendingRelays.set(relayMsg.id, {
        ws: null,
        originalMsgId: null,
        promiseResolve: (replyPayload) => { clearTimeout(timer); resolve(replyPayload); },
      });
      sendTo(client, relayMsg);
    });
  }

  /** Merge and de-duplicate results from bridge + extension, ranked by score. */
  function mergeVectorResults(bridgeResults, extResults, topK) {
    const seen = new Set();
    return [...bridgeResults, ...extResults]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .filter(r => { if (seen.has(r.url)) return false; seen.add(r.url); return true; })
      .slice(0, topK);
  }
  async function handleMessage(ws, msg) {
    const clientInfo = clients.get(ws);

    // Check if this is a relay reply from the extension
    if (msg.replyTo && pendingRelays.has(msg.replyTo)) {
      const { ws: requesterWs, originalMsgId, promiseResolve } = pendingRelays.get(msg.replyTo);
      pendingRelays.delete(msg.replyTo);
      if (promiseResolve) {
        // Promise-based relay — caller is awaiting the result
        promiseResolve(msg.payload || {});
      } else {
        // Classic WebSocket relay — forward reply to the original requester
        const relayed = { ...msg, replyTo: originalMsgId };
        sendTo(requesterWs, relayed);
      }
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

      case MSG.BRIDGE_VECTORDB_STATS: {
        try {
          const stats = await vectorGetStats();
          sendTo(ws, buildReply(msg, { ...stats, embeddingReady: isEmbeddingReady() }, 'server'));
        } catch (err) {
          sendTo(ws, buildReply(msg, { total: 0, bySource: {}, embeddingReady: isEmbeddingReady() }, 'server'));
        }
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

      case MSG.BRIDGE_INDEX_CONTENT: {
        const { source } = msg.payload || {};
        if (source && BRIDGE_VECTOR_SOURCES.has(source)) {
          // Store directly in bridge LanceDB — no extension round-trip
          try {
            const id = await vectorAddPage(msg.payload);
            sendTo(ws, buildReply(msg, { success: true, id }, 'server'));
          } catch (err) {
            sendTo(ws, buildError(`Bridge index failed: ${err.message}`, msg.id, 'server'));
          }
        } else {
          // Browsing / unknown sources → relay to extension
          const extClient = findClientByRole(ROLES.EXTENSION);
          if (!extClient) {
            sendTo(ws, buildError('No extension client connected', msg.id));
            return;
          }
          const indexMsg = buildMessage(MSG.BRIDGE_INDEX_CONTENT, msg.payload, 'server');
          pendingRelays.set(indexMsg.id, { ws, originalMsgId: msg.id });
          sendTo(extClient, indexMsg);
        }
        break;
      }

      case MSG.BRIDGE_SEARCH_VECTORDB: {
        const { query, sources, topK = 10, threshold, queryKeywords } = msg.payload || {};
        const wantsBridge   = !sources || sources.some(s => BRIDGE_VECTOR_SOURCES.has(s));
        const wantsBrowsing = !sources || sources.includes('browsing');

        let bridgeResults = [];
        let extResults    = [];

        if (wantsBridge) {
          const bridgeSources = sources ? sources.filter(s => BRIDGE_VECTOR_SOURCES.has(s)) : null;
          try {
            bridgeResults = await vectorSearch(query, {
              topK: topK * 2,
              threshold,
              sources: bridgeSources,
              queryKeywords,
            });
          } catch (err) {
            console.error('[Bridge] VectorDB search error:', err.message);
          }
        }

        if (wantsBrowsing) {
          const browsingPayload = { ...msg.payload, sources: ['browsing'] };
          const reply = await awaitRelay(ROLES.EXTENSION, MSG.BRIDGE_SEARCH_VECTORDB, browsingPayload, 8000);
          extResults = reply.results || [];
        }

        const results = mergeVectorResults(bridgeResults, extResults, topK);
        sendTo(ws, buildReply(msg, { success: true, results }, 'server'));
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

          // Verify state-save actually wrote the file (playwright-cli exits 0
          // even when the daemon isn't running, producing no output)
          const authStat = await stat(authFilePath).catch(() => null);
          if (!authStat || authStat.size === 0) {
            throw new Error('state-save exited 0 but wrote no file — is the playwright-cli daemon running?');
          }
          console.log(`[Bridge] Auth state saved: ${authFilePath} (${authStat.size} bytes)`);

          // Also save by domain name so any script accessing this domain gets auth
          let domainPath = null;
          try {
            const currentUrl = session.currentUrl;
            if (currentUrl && currentUrl.startsWith('http')) {
              const domain = new URL(currentUrl).hostname;
              domainPath = pathResolve(AUTH_DIR, `${domain}.json`);
              await session.sendCommand('state-save', [domainPath]);
              const domainStat = await stat(domainPath).catch(() => null);
              if (domainStat && domainStat.size > 0) {
                console.log(`[Bridge] Auth state saved by domain: ${domainPath} (${domainStat.size} bytes)`);
              } else {
                console.warn(`[Bridge] Auth domain save produced no file: ${domainPath}`);
                domainPath = null;
              }
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

      // ---- File serving for plugins (Phase H5) ----

      case MSG.BRIDGE_READ_FILE: {
        const filePath = (msg.payload || {}).path;
        const encoding = (msg.payload || {}).encoding || 'text';
        const MAX_SIZE = 50 * 1024 * 1024;
        try {
          if (!filePath) throw new Error('path is required');
          const fstat = await stat(filePath);
          if (!fstat.isFile()) throw new Error('not a file: ' + filePath);
          if (fstat.size > MAX_SIZE) throw new Error('file too large (' + fstat.size + ' bytes, max ' + MAX_SIZE + ')');
          if (encoding === 'base64') {
            const buf = await readFile(filePath);
            sendTo(ws, buildReply(msg, { success: true, base64: buf.toString('base64'), size: fstat.size }));
          } else {
            const text = await readFile(filePath, 'utf-8');
            sendTo(ws, buildReply(msg, { success: true, text, size: fstat.size }));
          }
        } catch (err) {
          sendTo(ws, buildReply(msg, { success: false, error: err.message }));
        }
        break;
      }

      case MSG.BRIDGE_COPY_TO_ASSETS: {
        const nodefs = await import('fs');
        const { join: pathJoin } = await import('path');
        const srcPath = (msg.payload || {}).src;
        const destName = (msg.payload || {}).dest;
        const ASSET_ROOT = pathJoin(homedir(), '.agentidev', 'cheerpx-assets');
        try {
          if (!srcPath || !destName) throw new Error('src and dest are required');
          if (destName.includes('..') || destName.includes('/')) throw new Error('dest must be a plain filename');
          if (!nodefs.existsSync(srcPath)) throw new Error('source not found: ' + srcPath);
          const destPath = pathJoin(ASSET_ROOT, destName);
          nodefs.copyFileSync(srcPath, destPath);
          const fstat2 = nodefs.statSync(destPath);
          sendTo(ws, buildReply(msg, { success: true, path: destPath, size: fstat2.size, url: 'http://localhost:9877/' + destName }));
        } catch (err) {
          sendTo(ws, buildReply(msg, { success: false, error: err.message }));
        }
        break;
      }

      case MSG.BRIDGE_FILE_PICKER: {
        const { filter, title } = msg.payload || {};
        const dlgTitle = title || 'Open Script';
        const dlgFilter = filter || 'JavaScript files (*.mjs;*.js)|*.mjs;*.js|All files (*.*)|*.*';
        // Requires -STA (WinForms OpenFileDialog crashes/hangs in MTA mode).
        // Keep owner visible offscreen — hiding it before ShowDialog strips the
        // dialog's topmost binding and the dialog becomes invisible behind the
        // browser (root cause of the "dashboard lockup" on File -> Browse).
        const psScript = [
          'Add-Type -AssemblyName System.Windows.Forms;',
          '$owner = New-Object System.Windows.Forms.Form;',
          '$owner.TopMost = $true;',
          '$owner.ShowInTaskbar = $false;',
          '$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None;',
          '$owner.Size = New-Object System.Drawing.Size(1,1);',
          '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual;',
          '$owner.Location = New-Object System.Drawing.Point(-2000,-2000);',
          '$owner.Opacity = 0;',
          '$owner.Show();',
          '[System.Windows.Forms.Application]::DoEvents();',
          '$f = New-Object System.Windows.Forms.OpenFileDialog;',
          `$f.Filter = '${dlgFilter.replace(/'/g, "''")}';`,
          `$f.Title = '${dlgTitle.replace(/'/g, "''")}';`,
          "if ($f.ShowDialog($owner) -eq 'OK') { Write-Output $f.FileName } else { Write-Output '' }",
          '$owner.Close();',
          '$owner.Dispose();',
        ].join(' ');
        let psChild = null;
        try {
          const selected = await new Promise((resolve, reject) => {
            // 60s is long enough for a user to browse and short enough to
            // recover from a stuck invisible dialog.
            psChild = execFile('powershell.exe', ['-Sta', '-NoProfile', '-Command', psScript], { timeout: 60000 }, (err, stdout) => {
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
        const { name, scriptPath, scriptName, args = [], sessionId = null, intervalMs, cronExpr = null, runOnStartup = false, maxConcurrent = 1, runNow = false, originalPath = null } = msg.payload || {};
        if (!scriptPath || (!intervalMs && !cronExpr)) {
          sendTo(ws, buildError('scriptPath and (intervalMs or cronExpr) required', msg.id));
          break;
        }
        let nextRunAt;
        if (cronExpr) {
          const probe = new Cron(cronExpr, { timezone: 'America/New_York' });
          nextRunAt = probe.nextRun() ? probe.nextRun().getTime() : null;
          probe.stop();
        } else {
          nextRunAt = Date.now() + intervalMs;
        }
        const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const schedule = {
          id, name: name || scriptName || scriptPath.split(/[/\\]/).pop(),
          scriptPath, scriptName: scriptName || null,
          originalPath,
          args, sessionId,
          intervalMs: cronExpr ? null : intervalMs,
          cronExpr: cronExpr || null,
          enabled: true,
          runOnStartup, maxConcurrent,
          createdAt: Date.now(), lastRunAt: null, lastRunScriptId: null,
          nextRunAt,
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
        for (const key of ['name', 'scriptName', 'intervalMs', 'cronExpr', 'args', 'sessionId', 'maxConcurrent', 'runOnStartup']) {
          if (updates[key] !== undefined) sched[key] = updates[key];
        }
        // Mutual exclusivity: setting cronExpr clears intervalMs and vice versa
        if (updates.cronExpr !== undefined && updates.cronExpr) sched.intervalMs = null;
        if (updates.intervalMs !== undefined && updates.intervalMs) sched.cronExpr = null;
        if (updates.enabled !== undefined) {
          sched.enabled = updates.enabled;
          if (sched.enabled) {
            startScheduleTimer(scheduleId);
          } else {
            stopScheduleTimer(scheduleId);
          }
        }
        if ((updates.intervalMs !== undefined || updates.cronExpr !== undefined) && sched.enabled) {
          // Restart timer with new interval/cron
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
        const { prompt, currentConfig, projectDescription, templatePrompt } = msg.payload || {};
        if (!prompt || !prompt.trim()) {
          sendTo(ws, buildError('Prompt is required', msg.id));
          break;
        }

        const SC_BASE_RULES = `Rules:
- dataSources: array of {ID, fields:[{name,type,primaryKey,hidden,title,required,length,valueMap,canEdit}]}
  - ID must end with DS, always include {name:"id",type:"integer",primaryKey:true,hidden:true}
  - Field types: text, integer, float, date, datetime, boolean
  - For dropdowns use valueMap as an array of strings
- layout: component tree with _type and members[]
  - Allowed _type values: VLayout, HLayout, ListGrid, ForgeListGrid, DynamicForm, Button, Label, TabSet, Tab, DetailViewer, SectionStack, HTMLFlow, Window, ToolStrip, ToolStripButton, PortalLayout, Portlet, Canvas, ForgeWizard, ForgeFilterBar, Menu
  - ForgeListGrid: enhanced ListGrid with skeleton loading. Use instead of ListGrid. Same props: dataSource, autoFetchData, fields, selectionType
  - ForgeFilterBar: search bar + advanced filter. Set targetGrid to a grid ID, searchFields to array of field names
  - ForgeWizard: multi-step form. Set steps:[{title,form:<DynamicForm config>}], onComplete is auto-wired
  - Menu: context menu with items[]. Each item: {title, _action, _targetGrid, _targetForm}. Wire to grid via showContextMenu
  - ListGrid/ForgeListGrid: set dataSource, autoFetchData:true, fields array with name and width. For context menu, set contextMenu to a Menu ID
  - DynamicForm: set dataSource, fields with name and optionally editorType (TextItem, TextAreaItem, SelectItem, DateItem, CheckboxItem, SpinnerItem)
  - Button: use _action for behavior: "new","save","delete","compute","clear". Set _targetForm and _targetGrid to reference component IDs
  - ListGrid recordClick: set _action:"select" and _targetForm to auto-wire
  - Give components an ID string so buttons can reference them
  - _action:"compute" — client-side math. Set _sourceForm (read values), _targetForm (write results), _formulas:{fieldName:"expression"} where expressions use field names + arithmetic (+,-,*,/,**) + Math.pow/round/floor/ceil/abs. For mortgage/loan calculators also set _scheduleType:"amortization", _targetGrid for amortization schedule, _principalField, _rateField (annual %), _termField (years)
  - _action:"clear" — reset form fields and clear grid. Set _targetForm and/or _targetGrid
  - _action:"dispatch" — fire-and-forget message to a handler. Set _messageType to the handler name, _messagePayload to an object of params
  - _action:"dispatchAndDisplay" — call a handler and show the result in a target component. Set _messageType, _messagePayload, _targetCanvas (ID of an HTMLFlow/Label to setContents on), _resultFormatter ("json","stdoutPre","text","rawHtml"), _resultPath (optional dot-path to extract from response), _timeoutMs (optional, default 60000)
  - _action:"streamSpawnAndAppend" — stream a Linux command's output progressively into a target HTMLFlow. Set _cmd (absolute path like "/usr/bin/python3"), _args (array of strings), _targetCanvas (HTMLFlow ID). Output renders in real-time as the command runs inside the CheerpX Linux VM.

Runtime integration:
  - To run a Python script: use streamSpawnAndAppend with _cmd:"/usr/bin/python3" and _args:["-c","print(42)"]
  - To run a shell command: use streamSpawnAndAppend with _cmd:"/bin/sh" and _args:["-c","echo hello"]
  - To call a Java method: use dispatchAndDisplay with _messageType:"HOST_EXEC_SPAWN" and _messagePayload:{cmd:"/usr/bin/python3",args:["-c","print(42)"]}
  - To evaluate BeanShell: use dispatchAndDisplay with _messageType:"HELLO_RUNTIME_BSH" and _messagePayload:{code:"1+1"}
  - For long-running commands use streamSpawnAndAppend (shows output progressively). For quick results use dispatchAndDisplay.
  - Always pair runtime buttons with an HTMLFlow output pane (ID it and reference via _targetCanvas)`;

        const SC_EXAMPLE = `Example for a task tracker:
{"dataSources":[{"ID":"TaskDS","fields":[{"name":"id","type":"integer","primaryKey":true,"hidden":true},{"name":"title","type":"text","required":true,"title":"Title","length":200},{"name":"status","type":"text","title":"Status","valueMap":["Todo","In Progress","Done"]},{"name":"dueDate","type":"date","title":"Due Date"}]}],"layout":{"_type":"VLayout","width":"100%","height":"100%","membersMargin":8,"layoutMargin":12,"members":[{"_type":"ForgeListGrid","ID":"taskGrid","width":"100%","height":"*","dataSource":"TaskDS","autoFetchData":true,"canEdit":false,"selectionType":"single","_action":"select","_targetForm":"taskForm","fields":[{"name":"title","width":"*"},{"name":"status","width":120},{"name":"dueDate","width":120}]},{"_type":"DynamicForm","ID":"taskForm","width":"100%","dataSource":"TaskDS","numCols":2,"colWidths":[120,"*"],"fields":[{"name":"title","editorType":"TextItem"},{"name":"status","editorType":"SelectItem"},{"name":"dueDate","editorType":"DateItem"}]},{"_type":"HLayout","height":30,"membersMargin":8,"members":[{"_type":"Button","title":"New","width":80,"_action":"new","_targetForm":"taskForm"},{"_type":"Button","title":"Save","width":80,"_action":"save","_targetForm":"taskForm","_targetGrid":"taskGrid"},{"_type":"Button","title":"Delete","width":80,"_action":"delete","_targetGrid":"taskGrid"}]}]}}`;

        let systemPrompt, userPrompt;

        if (currentConfig) {
          // Modification mode — edit existing config
          systemPrompt = `You are modifying an existing SmartClient UI. The current config JSON is provided below.
Apply the user's requested change and return the COMPLETE modified config.
Do not remove existing components unless the user asks. Preserve all IDs and DataSources.

${SC_BASE_RULES}

Output ONLY the modified JSON object. No explanation, no markdown fences.`;

          userPrompt = `Current config:\n${JSON.stringify(currentConfig)}\n\nUser request: ${prompt.trim()}`;
        } else {
          // Generation mode — create from scratch
          systemPrompt = `You are a SmartClient UI generator. Given a user description, output ONLY a JSON object with this structure:

{"dataSources":[...],"layout":{...}}

${SC_BASE_RULES}

${SC_EXAMPLE}

Output ONLY the JSON object. No explanation, no markdown fences.`;

          userPrompt = `User request: ${prompt.trim()}`;
        }

        // Prepend project + template context to system prompt if available
        if (templatePrompt) {
          systemPrompt = `Template context: ${templatePrompt}\n\n${systemPrompt}`;
        }
        if (projectDescription) {
          systemPrompt = `Project context: ${projectDescription}\n\n${systemPrompt}`;
        }

        const genModel = msg.payload.model || 'sonnet';
        const mode = currentConfig ? 'modify' : 'generate';
        console.log(`[Bridge] SC_GENERATE_UI (${mode}, ${genModel}): spawning claude -p for:`, prompt.trim().slice(0, 80));
        try {
          const raw = await spawnClaude(genModel, systemPrompt, userPrompt, { timeout: 180000 });
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

      // ---- IndexedDB Backup / Sync ----

      case MSG.BRIDGE_IDB_SYNC: {
        // Extension sends a dump of one or more IDB stores; upsert into SQLite.
        const { stores } = msg.payload || {};
        if (!stores || typeof stores !== 'object') {
          sendTo(ws, buildReply(msg, { success: false, error: 'Missing stores payload' }));
          break;
        }
        let totalRecords = 0;
        const errors = [];
        for (const [storeName, records] of Object.entries(stores)) {
          if (!Array.isArray(records)) continue;
          try {
            upsertStore(storeName, records);
            totalRecords += records.length;
            console.log(`[Bridge] IDB sync: stored ${records.length} records for "${storeName}"`);
          } catch (err) {
            console.warn(`[Bridge] IDB sync error for "${storeName}": ${err.message}`);
            errors.push(`${storeName}: ${err.message}`);
          }
        }
        sendTo(ws, buildReply(msg, {
          success: errors.length === 0,
          totalRecords,
          errors: errors.length ? errors : undefined,
        }));
        break;
      }

      case MSG.BRIDGE_IDB_RESTORE: {
        // Client requests SQLite data to be pushed back to the extension.
        const { stores: requestedStores } = msg.payload || {};
        try {
          const all = exportAll();
          // Build restore payload keyed by store name
          const restorePayload = {
            ScriptRuns:      all.script_runs,
            ScriptArtifacts: all.script_artifacts,
          };
          // Add any idb_stores rows grouped by store name
          for (const row of all.idb_stores) {
            if (!restorePayload[row.store]) restorePayload[row.store] = [];
            try { restorePayload[row.store].push(JSON.parse(row.data)); } catch { /* skip */ }
          }
          // Broadcast restore payload so extension can import it
          broadcast(buildMessage(MSG.BRIDGE_IDB_RESTORE, { stores: restorePayload }));
          sendTo(ws, buildReply(msg, { success: true }));
        } catch (err) {
          console.error('[Bridge] IDB restore failed:', err.message);
          sendTo(ws, buildReply(msg, { success: false, error: err.message }));
        }
        break;
      }

      // ── Agentiface App Persistence (Phase 5b) ────────────────────

      case MSG.BRIDGE_AF_APP_SAVE: {
        const { id, name, prompt: appPrompt, config, history } = msg.payload || {};
        if (!config) {
          sendTo(ws, buildError('config is required', msg.id));
          break;
        }
        try {
          const appsDir = pathResolve(homedir(), '.agentidev', 'agentiface-apps');
          await mkdir(appsDir, { recursive: true });

          const appId = id || `app_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const filePath = pathResolve(appsDir, `${appId}.json`);

          // Load existing to preserve history if updating
          let existing = null;
          try {
            existing = JSON.parse(await readFile(filePath, 'utf-8'));
          } catch { /* new app */ }

          const now = new Date().toISOString();
          const app = {
            id: appId,
            name: name || existing?.name || 'Untitled',
            prompt: appPrompt || existing?.prompt || '',
            config,
            createdAt: existing?.createdAt || now,
            updatedAt: now,
            history: history || existing?.history || [],
          };

          // Append to history if config changed
          if (appPrompt && (!existing || JSON.stringify(existing.config) !== JSON.stringify(config))) {
            app.history.push({ prompt: appPrompt, timestamp: now, config });
          }

          await writeFile(filePath, JSON.stringify(app, null, 2));
          console.log('[Bridge] AF app saved:', appId, '-', app.name);
          sendTo(ws, buildReply(msg, { success: true, app: { id: appId, name: app.name, updatedAt: now } }));
        } catch (err) {
          console.error('[Bridge] AF app save error:', err.message);
          sendTo(ws, buildReply(msg, { success: false, error: err.message }));
        }
        break;
      }

      case MSG.BRIDGE_AF_APP_LOAD: {
        const { id: loadId } = msg.payload || {};
        if (!loadId) {
          sendTo(ws, buildError('id is required', msg.id));
          break;
        }
        try {
          const filePath = pathResolve(homedir(), '.agentidev', 'agentiface-apps', `${loadId}.json`);
          const raw = await readFile(filePath, 'utf-8');
          const app = JSON.parse(raw);
          sendTo(ws, buildReply(msg, { success: true, app }));
        } catch (err) {
          sendTo(ws, buildReply(msg, { success: false, error: err.message }));
        }
        break;
      }

      case MSG.BRIDGE_AF_APP_LIST: {
        try {
          const appsDir = pathResolve(homedir(), '.agentidev', 'agentiface-apps');
          await mkdir(appsDir, { recursive: true });
          const files = await readdir(appsDir);
          const apps = [];
          for (const file of files) {
            if (!file.endsWith('.json')) continue;
            try {
              const raw = await readFile(pathResolve(appsDir, file), 'utf-8');
              const app = JSON.parse(raw);
              // Return metadata only (not full config/history)
              apps.push({
                id: app.id,
                name: app.name,
                prompt: app.prompt,
                createdAt: app.createdAt,
                updatedAt: app.updatedAt,
                historyCount: (app.history || []).length,
              });
            } catch { /* skip corrupt files */ }
          }
          apps.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
          sendTo(ws, buildReply(msg, { success: true, apps }));
        } catch (err) {
          sendTo(ws, buildReply(msg, { success: false, error: err.message }));
        }
        break;
      }

      case MSG.BRIDGE_AF_APP_DELETE: {
        const { id: delId } = msg.payload || {};
        if (!delId) {
          sendTo(ws, buildError('id is required', msg.id));
          break;
        }
        try {
          const filePath = pathResolve(homedir(), '.agentidev', 'agentiface-apps', `${delId}.json`);
          await rm(filePath);
          console.log('[Bridge] AF app deleted:', delId);
          sendTo(ws, buildReply(msg, { success: true }));
        } catch (err) {
          sendTo(ws, buildReply(msg, { success: false, error: err.message }));
        }
        break;
      }

      // ── Agentiface Project Persistence ────────────────────

      case MSG.BRIDGE_AF_PROJECT_SAVE: {
        const { id, name, description, skin, capabilities, prompt: projPrompt, config, history } = msg.payload || {};
        if (!name) {
          sendTo(ws, buildError('name is required', msg.id));
          break;
        }
        try {
          const projDir = pathResolve(homedir(), '.agentidev', 'agentiface-projects');
          await mkdir(projDir, { recursive: true });

          const projId = id || `proj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const filePath = pathResolve(projDir, `${projId}.json`);

          // Load existing to preserve history if updating
          let existing = null;
          try {
            existing = JSON.parse(await readFile(filePath, 'utf-8'));
          } catch { /* new project */ }

          const now = new Date().toISOString();
          const project = {
            id: projId,
            name: name || existing?.name || 'Untitled Project',
            description: description !== undefined ? description : (existing?.description || ''),
            skin: skin || existing?.skin || 'Tahoe',
            capabilities: capabilities || existing?.capabilities || {},
            config: config !== undefined ? config : (existing?.config || null),
            prompt: projPrompt || existing?.prompt || '',
            createdAt: existing?.createdAt || now,
            updatedAt: now,
            history: history || existing?.history || [],
          };

          // Append to history if config changed and there's a prompt
          if (projPrompt && config && (!existing || JSON.stringify(existing.config) !== JSON.stringify(config))) {
            project.history.push({ prompt: projPrompt, timestamp: now, config });
          }

          await writeFile(filePath, JSON.stringify(project, null, 2));
          console.log('[Bridge] AF project saved:', projId, '-', project.name);
          sendTo(ws, buildReply(msg, { success: true, project: { id: projId, name: project.name, description: project.description, updatedAt: now } }));
        } catch (err) {
          console.error('[Bridge] AF project save error:', err.message);
          sendTo(ws, buildReply(msg, { success: false, error: err.message }));
        }
        break;
      }

      case MSG.BRIDGE_AF_PROJECT_LOAD: {
        const { id: loadProjId } = msg.payload || {};
        if (!loadProjId) {
          sendTo(ws, buildError('id is required', msg.id));
          break;
        }
        try {
          const filePath = pathResolve(homedir(), '.agentidev', 'agentiface-projects', `${loadProjId}.json`);
          const raw = await readFile(filePath, 'utf-8');
          const project = JSON.parse(raw);
          sendTo(ws, buildReply(msg, { success: true, project }));
        } catch (err) {
          sendTo(ws, buildReply(msg, { success: false, error: err.message }));
        }
        break;
      }

      case MSG.BRIDGE_AF_PROJECT_LIST: {
        try {
          const projDir = pathResolve(homedir(), '.agentidev', 'agentiface-projects');
          await mkdir(projDir, { recursive: true });
          const files = await readdir(projDir);
          const projects = [];
          for (const file of files) {
            if (!file.endsWith('.json')) continue;
            try {
              const raw = await readFile(pathResolve(projDir, file), 'utf-8');
              const proj = JSON.parse(raw);
              // Return metadata only (not full config/history)
              const componentCount = proj.config?.dataSources?.length || 0;
              projects.push({
                id: proj.id,
                name: proj.name,
                description: proj.description || '',
                skin: proj.skin,
                prompt: proj.prompt,
                createdAt: proj.createdAt,
                updatedAt: proj.updatedAt,
                historyCount: (proj.history || []).length,
                componentCount,
              });
            } catch { /* skip corrupt files */ }
          }
          projects.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
          sendTo(ws, buildReply(msg, { success: true, projects }));
        } catch (err) {
          sendTo(ws, buildReply(msg, { success: false, error: err.message }));
        }
        break;
      }

      case MSG.BRIDGE_AF_PROJECT_DELETE: {
        const { id: delProjId } = msg.payload || {};
        if (!delProjId) {
          sendTo(ws, buildError('id is required', msg.id));
          break;
        }
        try {
          const filePath = pathResolve(homedir(), '.agentidev', 'agentiface-projects', `${delProjId}.json`);
          await rm(filePath);
          console.log('[Bridge] AF project deleted:', delProjId);
          sendTo(ws, buildReply(msg, { success: true }));
        } catch (err) {
          sendTo(ws, buildReply(msg, { success: false, error: err.message }));
        }
        break;
      }

      // ---- Agentiface template persistence (Phase 4a) ----

      case MSG.BRIDGE_AF_TEMPLATE_SAVE: {
        const { id: tplId, name: tplName, description: tplDesc, category: tplCat, config: tplConfig, aiSystemPrompt: tplPrompt, suggestedPrompts: tplSuggested } = msg.payload || {};
        if (!tplName) {
          sendTo(ws, buildError('name is required', msg.id));
          break;
        }
        try {
          const tplDir = pathResolve(homedir(), '.agentidev', 'agentiface-templates');
          await mkdir(tplDir, { recursive: true });

          const templateId = tplId || `tpl_user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const filePath = pathResolve(tplDir, `${templateId}.json`);

          const now = new Date().toISOString();
          const template = {
            id: templateId,
            name: tplName,
            description: tplDesc || '',
            category: tplCat || 'Custom',
            config: tplConfig || null,
            aiSystemPrompt: tplPrompt || '',
            suggestedPrompts: tplSuggested || [],
            createdAt: now,
            updatedAt: now,
            bundled: false,
          };

          await writeFile(filePath, JSON.stringify(template, null, 2));
          console.log('[Bridge] AF template saved:', templateId, '-', tplName);
          sendTo(ws, buildReply(msg, { success: true, template: { id: templateId, name: tplName } }));
        } catch (err) {
          sendTo(ws, buildReply(msg, { success: false, error: err.message }));
        }
        break;
      }

      case MSG.BRIDGE_AF_TEMPLATE_LIST: {
        try {
          const tplDir = pathResolve(homedir(), '.agentidev', 'agentiface-templates');
          await mkdir(tplDir, { recursive: true });
          const files = await readdir(tplDir);
          const templates = [];
          for (const file of files) {
            if (!file.endsWith('.json')) continue;
            try {
              const raw = await readFile(pathResolve(tplDir, file), 'utf-8');
              const tpl = JSON.parse(raw);
              templates.push({
                id: tpl.id,
                name: tpl.name,
                description: tpl.description || '',
                category: tpl.category || 'Custom',
                createdAt: tpl.createdAt,
                updatedAt: tpl.updatedAt,
                bundled: false,
              });
            } catch { /* skip corrupt files */ }
          }
          templates.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
          sendTo(ws, buildReply(msg, { success: true, templates }));
        } catch (err) {
          sendTo(ws, buildReply(msg, { success: false, error: err.message }));
        }
        break;
      }

      case MSG.BRIDGE_AF_TEMPLATE_DELETE: {
        const { id: delTplId } = msg.payload || {};
        if (!delTplId) {
          sendTo(ws, buildError('id is required', msg.id));
          break;
        }
        try {
          const filePath = pathResolve(homedir(), '.agentidev', 'agentiface-templates', `${delTplId}.json`);
          await rm(filePath);
          console.log('[Bridge] AF template deleted:', delTplId);
          sendTo(ws, buildReply(msg, { success: true }));
        } catch (err) {
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
