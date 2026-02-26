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
import { MSG, buildMessage, buildReply, buildError, ROLES } from './protocol.mjs';
import { PlaywrightSession, SESSION_STATE } from './playwright-session.mjs';

const DEFAULT_PORT = 9876;
const HEALTH_INTERVAL = 30000; // 30s ping/pong

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
        }));
        break;
      }

      case MSG.BRIDGE_HEALTH: {
        sendTo(ws, buildReply(msg, {
          uptime: process.uptime(),
          clients: clients.size,
          sessions: sessions.size,
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
