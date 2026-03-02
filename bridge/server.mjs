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
import { spawn } from 'child_process';
import { readFile, writeFile, mkdir, stat } from 'fs/promises';
import { watch } from 'fs';
import { resolve as pathResolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { MSG, buildMessage, buildReply, buildError, ROLES } from './protocol.mjs';
import { PlaywrightSession, SESSION_STATE } from './playwright-session.mjs';
import { InspectorClient, parseInspectorUrl } from './inspector-client.mjs';

const DEFAULT_PORT = 9876;
const HEALTH_INTERVAL = 30000; // 30s ping/pong
const __dirname = dirname(fileURLToPath(import.meta.url));
const SHIM_PATH = pathResolve(__dirname, 'playwright-shim.mjs');
const SCRIPTS_DIR = pathResolve(homedir(), '.contextual-recall', 'scripts');

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

  // File watcher: echo suppression for writes we initiated
  const fileWatcherIgnore = new Set();
  const fileWatcherDebounce = new Map(); // filename → timer
  let fileWatcher = null;
  const FILE_WATCH_DEBOUNCE = 300;

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
          broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, {
            scriptId, name: script.name, state: 'disconnected',
            step: script.step, total: script.totalSteps, errors: script.errors,
            checkpoints: script.checkpoints, activeBreakpoints: [], activity: '',
          }));
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
   * Get the InspectorClient for a script (by scriptId or pid).
   * Falls back to pendingInspectors for scripts that haven't registered yet.
   */
  function getInspector(scriptId, pid) {
    if (scriptId) {
      const script = scripts.get(scriptId);
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
        scripts.set(scriptId, {
          ws, name, totalSteps: totalSteps || 0,
          step: 0, label: '', errors: 0, activity: '',
          state: 'registered', metadata: metadata || {},
          startedAt: Date.now(),
          pid: pid || null,
          checkpoints: checkpoints || [],     // available checkpoint names (for UI display)
          breakpoints: new Set(),             // active breakpoints (user-toggled)
          stepOnce: false,                    // true = pause at next checkpoint (Step button)
          pendingStep: null,                  // resolve fn when paused at checkpoint
          currentCheckpoint: null,
          pages: new Map(),                   // pageId → { url, title } (from playwright-shim)
          inspector: null,                    // InspectorClient (V8 debugger)
        });
        // Attach V8 inspector if one was pending for this PID
        const script = scripts.get(scriptId);
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
        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, {
          scriptId, name: script.name, state: 'running',
          step: script.step, total: script.totalSteps,
          label: script.label, errors: script.errors,
          activity: script.activity,
          checkpoints: script.checkpoints,
          activeBreakpoints: Array.from(script.breakpoints),
        }));
        break;
      }

      case MSG.BRIDGE_SCRIPT_COMPLETE: {
        const { scriptId, results, errors, duration } = msg.payload || {};
        const script = scripts.get(scriptId);
        if (!script) {
          sendTo(ws, buildError('Script not found', msg.id));
          return;
        }
        script.state = 'complete';
        script.errors = errors ?? script.errors;
        script.results = results;
        script.pid = null; // process has exited
        script.duration = duration || (Date.now() - script.startedAt);
        console.log(`[Bridge] Script complete: ${script.name} (${script.duration}ms, ${script.errors} errors)`);
        sendTo(ws, buildReply(msg, { success: true, scriptId }));
        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, {
          scriptId, name: script.name, state: 'complete',
          step: script.totalSteps, total: script.totalSteps,
          label: 'Complete', errors: script.errors,
          results, duration: script.duration,
          checkpoints: script.checkpoints,
          activeBreakpoints: [],
          activity: '',
        }));
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
        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, {
          scriptId, name: script.name, state: 'paused',
          step: script.step, total: script.totalSteps,
          label: script.label, errors: script.errors,
          activity: script.activity,
          checkpoints: script.checkpoints,
          activeBreakpoints: Array.from(script.breakpoints),
        }));
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
        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, {
          scriptId, name: script.name, state: 'running',
          step: script.step, total: script.totalSteps,
          label: script.label, errors: script.errors,
          activity: script.activity,
          checkpoints: script.checkpoints,
          activeBreakpoints: Array.from(script.breakpoints),
        }));
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
          script.pid = null;
          sendTo(ws, buildReply(msg, { success: true, scriptId, state: 'killed' }));
          broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, {
            scriptId, name: script.name, state: 'killed',
            step: script.step, total: script.totalSteps,
            label: 'Force killed', errors: script.errors,
            checkpoints: script.checkpoints, activeBreakpoints: [], activity: '',
          }));
          return;
        }

        // Cooperative cancel
        script.state = 'cancelled';
        console.log(`[Bridge] Script cancelled: ${script.name} (${reason || 'no reason'})`);
        if (script.ws && script.ws.readyState === WebSocket.OPEN) {
          sendTo(script.ws, buildMessage(MSG.BRIDGE_SCRIPT_CANCEL, { scriptId, reason }));
        }
        sendTo(ws, buildReply(msg, { success: true, scriptId, state: 'cancelled' }));
        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, {
          scriptId, name: script.name, state: 'cancelled',
          step: script.step, total: script.totalSteps,
          label: `Cancelled: ${reason || ''}`, errors: script.errors,
          checkpoints: script.checkpoints,
          activeBreakpoints: Array.from(script.breakpoints),
          activity: '',
        }));
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

        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, {
          scriptId, name: script.name, state: 'checkpoint',
          step: script.step, total: script.totalSteps,
          label: script.label, errors: script.errors,
          checkpoint: { name, context },
          checkpoints: script.checkpoints,
          activeBreakpoints: Array.from(script.breakpoints),
          activity: script.activity,
        }));

        // Block until user clicks Step/Continue or script is cancelled
        await new Promise((resolve) => { script.pendingStep = resolve; });

        if (script._cancelledDuringStep) {
          delete script._cancelledDuringStep;
          sendTo(ws, buildReply(msg, { proceed: false, cancelled: true, name }));
          return;
        }

        script.state = 'running';
        script.currentCheckpoint = null;

        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, {
          scriptId, name: script.name, state: 'running',
          step: script.step, total: script.totalSteps,
          label: script.label, errors: script.errors,
          checkpoints: script.checkpoints,
          activeBreakpoints: Array.from(script.breakpoints),
          activity: script.activity,
        }));

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
        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, {
          scriptId, name: script.name, state: script.state,
          step: script.step, total: script.totalSteps,
          label: script.label, errors: script.errors,
          checkpoints: script.checkpoints,
          activeBreakpoints: Array.from(script.breakpoints),
          checkpoint: script.currentCheckpoint ? {
            name: script.currentCheckpoint.name,
            context: script.currentCheckpoint.context,
          } : null,
          activity: script.activity,
        }));
        break;
      }

      case MSG.BRIDGE_SCRIPT_LAUNCH: {
        const { path: scriptPath, args: scriptArgs = [], breakpoints: preBreakpoints, lineBreakpoints, debug } = msg.payload || {};
        if (!scriptPath) {
          sendTo(ws, buildError('Script path required', msg.id));
          break;
        }

        // V8 debug mode: launch with --inspect-brk when lineBreakpoints or debug flag is set
        const useV8Debug = debug || (Array.isArray(lineBreakpoints) && lineBreakpoints.length > 0);
        const nodeArgs = useV8Debug ? ['--inspect-brk=0', scriptPath, ...scriptArgs] : [scriptPath, ...scriptArgs];

        console.log(`[Bridge] Launching script: node ${nodeArgs.join(' ')}${useV8Debug ? ' [V8 DEBUG]' : ''}`);
        const child = spawn('node', nodeArgs, {
          detached: false,
          stdio: 'pipe',
          env: { ...process.env },
        });
        const launchId = `launch_${Date.now()}`;

        // Store checkpoint-level pre-breakpoints (existing system)
        if (Array.isArray(preBreakpoints) && preBreakpoints.length > 0 && child.pid) {
          pendingBreakpoints.set(child.pid, preBreakpoints);
          console.log(`[Bridge] Pre-breakpoints queued for PID ${child.pid}: ${preBreakpoints.join(', ')}`);
        }

        sendTo(ws, buildReply(msg, { success: true, launchId, pid: child.pid, v8Debug: useV8Debug }));
        child.stdout.on('data', d => console.log(`[Script:${launchId}] ${d.toString().trim()}`));

        // V8 Inspector: parse debugger URL from stderr and connect
        if (useV8Debug) {
          let inspectorConnected = false;
          child.stderr.on('data', async (d) => {
            const text = d.toString().trim();
            console.error(`[Script:${launchId}] ERR: ${text}`);

            if (inspectorConnected) return;
            const inspectorUrl = parseInspectorUrl(text);
            if (!inspectorUrl) return;

            inspectorConnected = true;
            console.log(`[Bridge] V8 Inspector URL: ${inspectorUrl}`);

            try {
              const inspector = new InspectorClient(inspectorUrl);
              await inspector.connect();
              await inspector.enable();

              // Store inspector keyed by PID (script hasn't registered yet, so no scriptId)
              pendingInspectors.set(child.pid, inspector);

              // Set initial line breakpoints
              if (Array.isArray(lineBreakpoints)) {
                const fileUrl = `file://${scriptPath}`;
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
              // Wire paused/resumed events
              inspector.onPaused(async (data) => {
                console.log(`[Bridge] V8 paused: ${data.file}:${data.line} (${data.reason})`);
                // ESM modules cause a "Break on start" pause after runIfWaitingForDebugger().
                // Auto-resume only the FIRST pause (the module entry pause at line 1).
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
                  scriptId,
                  pid: child.pid,
                  line: data.line,
                  file: data.file,
                  column: data.column,
                  reason: data.reason,
                  callFrames: data.callFrames,
                }));
              });

              inspector.onResumed(() => {
                const scriptId = findScriptIdByPid(child.pid);
                broadcast(buildMessage(MSG.BRIDGE_DBG_RESUMED, { scriptId, pid: child.pid }));
              });

              // Unblock the --inspect-brk initial pause (Runtime-level, not Debugger-level)
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
          child.stderr.on('data', d => console.error(`[Script:${launchId}] ERR: ${d.toString().trim()}`));
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
          // Clean up inspector
          if (pendingInspectors.has(child.pid)) {
            pendingInspectors.get(child.pid).disconnect();
            pendingInspectors.delete(child.pid);
          }
          // Also check script-keyed inspectors
          for (const [scriptId, script] of scripts) {
            if (script.pid === child.pid && script.inspector) {
              script.inspector.disconnect();
              script.inspector = null;
            }
          }
        });
        break;
      }

      case MSG.BRIDGE_SCRIPT_SAVE: {
        const { name, source } = msg.payload || {};
        if (!name || !source) {
          sendTo(ws, buildError('name and source required', msg.id));
          return;
        }
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
        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, {
          scriptId, name: script.name, state: script.state,
          step: script.step, total: script.totalSteps,
          label: script.label, errors: script.errors,
          checkpoints: script.checkpoints,
          activeBreakpoints: Array.from(script.breakpoints),
          activity: script.activity,
          pages: Object.fromEntries(script.pages),
        }));
        break;
      }

      case MSG.BRIDGE_SCRIPT_PAGE_STATUS: {
        const { scriptId, pageId, url, title } = msg.payload || {};
        const script = scripts.get(scriptId);
        if (!script) return; // fire-and-forget, no error reply needed
        script.pages.set(pageId, { url: url || '', title: title || '' });
        // Broadcast so UIs can label the intercept toggles with the current URL
        broadcast(buildMessage(MSG.BRIDGE_SCRIPT_PROGRESS, {
          scriptId, name: script.name, state: script.state,
          step: script.step, total: script.totalSteps,
          label: script.label, errors: script.errors,
          checkpoints: script.checkpoints,
          activeBreakpoints: Array.from(script.breakpoints),
          activity: script.activity,
          pages: Object.fromEntries(script.pages),
        }));
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
