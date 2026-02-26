#!/usr/bin/env node

/**
 * bridge-cli: Browser Automation from Any Terminal
 *
 * Stateless CLI that maps terminal commands 1:1 to bridge WebSocket messages.
 * Each invocation: connect → identify → send command → receive reply → disconnect.
 *
 * stdout: Always valid JSON (or raw YAML with --raw). Machine-parseable.
 * stderr: Human-readable status messages. Suppressible with --quiet.
 * Exit codes: 0 = success, 1 = error, 2 = usage error.
 *
 * Usage: bridge-cli <command> [args] [--port=9876] [--pretty] [--timeout=30000] [--raw] [--quiet]
 */

import WebSocket from 'ws';
import { MSG, buildMessage, ROLES } from './protocol.mjs';

// --- Globals ---

const DEFAULT_PORT = 9876;
const DEFAULT_TIMEOUT = 30000;

// --- Argument Parsing ---

const rawArgs = process.argv.slice(2);

// Extract flags
const flags = {
  port: DEFAULT_PORT,
  pretty: false,
  timeout: DEFAULT_TIMEOUT,
  raw: false,
  quiet: false,
};

const positional = [];
for (const arg of rawArgs) {
  if (arg.startsWith('--port=')) {
    flags.port = parseInt(arg.split('=')[1], 10);
  } else if (arg === '--pretty') {
    flags.pretty = true;
  } else if (arg.startsWith('--timeout=')) {
    flags.timeout = parseInt(arg.split('=')[1], 10);
  } else if (arg === '--raw') {
    flags.raw = true;
  } else if (arg === '--quiet') {
    flags.quiet = true;
  } else if (arg.startsWith('--auth=')) {
    flags.auth = arg.split('=')[1];
  } else if (arg.startsWith('--limit=')) {
    flags.limit = parseInt(arg.split('=')[1], 10);
  } else if (arg === '--help' || arg === '-h') {
    printUsage();
    process.exit(0);
  } else {
    positional.push(arg);
  }
}

const command = positional[0];
const subcommand = positional[1];

// --- Helpers ---

function stderr(msg) {
  if (!flags.quiet) process.stderr.write(msg + '\n');
}

function output(data) {
  if (flags.pretty) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    process.stdout.write(JSON.stringify(data) + '\n');
  }
}

function outputRaw(text) {
  process.stdout.write(text);
  if (!text.endsWith('\n')) process.stdout.write('\n');
}

function usageError(msg) {
  process.stderr.write(`Error: ${msg}\n`);
  process.stderr.write('Run bridge-cli --help for usage\n');
  process.exit(2);
}

function printUsage() {
  process.stderr.write(`bridge-cli - Browser Automation from Any Terminal

Usage: bridge-cli <command> [args] [flags]

Commands:
  status                              Bridge health + connected clients
  sessions                            List sessions
  session create <name> [--auth=path] Create playwright session
  session destroy <id>                Destroy session
  session info <id>                   Get session info
  snapshot <session> [--raw]          Take accessibility snapshot (YAML)
  navigate <session> <url>            Navigate to URL
  click <session> <ref>               Click element by ref
  fill <session> <ref> <value>        Fill element with value
  eval <session> <expr>               Evaluate JS expression
  command <session> <raw_cmd>         Send raw playwright command
  watch <session>                     Stream events in real-time (NDJSON)
  search <query> [--limit=N]          Search snapshot vector store
  context <session>                   Snapshot + parse race context as JSON

Flags:
  --port=N      Bridge server port (default: 9876)
  --pretty      Pretty-print JSON output
  --timeout=N   Request timeout in ms (default: 30000)
  --raw         For snapshot: output raw YAML instead of JSON wrapper
  --quiet       Suppress stderr status messages
  --help, -h    Show this help
`);
}

// --- WebSocket Connection ---

/**
 * Connect to bridge, identify as CLI, return ws + clientId
 */
function connectToBridge() {
  return new Promise((resolve, reject) => {
    const url = `ws://localhost:${flags.port}`;
    stderr(`Connecting to ${url}...`);

    const ws = new WebSocket(url);
    let settled = false;

    const connTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.terminate();
        reject(new Error('Connection timed out'));
      }
    }, Math.min(flags.timeout, 10000));

    ws.on('open', () => {
      clearTimeout(connTimer);
      stderr('Connected');
      resolve(ws);
    });

    ws.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(connTimer);
        if (err.code === 'ECONNREFUSED') {
          reject(new Error(`Connection refused on port ${flags.port} - is the bridge server running?`));
        } else {
          reject(new Error(`Connection error: ${err.message}`));
        }
      }
    });

    ws.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(connTimer);
        reject(new Error('Connection closed unexpectedly'));
      }
    });
  });
}

/**
 * Send BRIDGE_IDENTIFY and wait for reply
 */
function identify(ws) {
  return sendRequest(ws, MSG.BRIDGE_IDENTIFY, { role: ROLES.CLI });
}

/**
 * Send a message and wait for reply matching replyTo
 */
function sendRequest(ws, type, payload) {
  return new Promise((resolve, reject) => {
    const msg = buildMessage(type, payload, 'cli');

    const timer = setTimeout(() => {
      reject(new Error(`Request timed out after ${flags.timeout}ms`));
    }, flags.timeout);

    const handler = (raw) => {
      let reply;
      try {
        reply = JSON.parse(raw.toString());
      } catch {
        return; // ignore non-JSON
      }

      if (reply.replyTo === msg.id) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        if (reply.type === MSG.BRIDGE_ERROR) {
          reject(new Error(reply.payload?.error || 'Bridge error'));
        } else {
          resolve(reply.payload);
        }
      }
    };

    ws.on('message', handler);
    ws.send(JSON.stringify(msg));
  });
}

/**
 * Full lifecycle: connect, identify, run callback, disconnect
 */
async function withBridge(fn) {
  let ws;
  try {
    ws = await connectToBridge();
    await identify(ws);
    const result = await fn(ws);
    return result;
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close(1000);
    }
  }
}

// --- Race Context Parser (ported from claude-automation.mjs) ---

function parseRaceContext(yaml) {
  const context = {
    track: null,
    race: null,
    betType: null,
    betAmount: null,
    modifier: null,
    horses: [],
    betTotal: null,
    conditions: null,
  };

  const trackMatch = yaml.match(
    /heading "(Aqueduct|Tampa Bay|Gulfstream|Oaklawn|Penn National|Charles Town|Turfway|Santa Anita|Del Mar|Saratoga|Belmont|Churchill|Keeneland|Pimlico|Laurel)"/i
  );
  if (trackMatch) context.track = trackMatch[1];

  const raceMatch = yaml.match(/RACE (\d+)/);
  if (raceMatch) context.race = parseInt(raceMatch[1]);

  const betMatch = yaml.match(/heading "(Win|Exacta|Trifecta|Superfecta|Daily Double|Pick \d|Quinella)"/i);
  if (betMatch) context.betType = betMatch[1];

  const amtMatch = yaml.match(/heading "\$([^"]+)"/);
  if (amtMatch) context.betAmount = amtMatch[1];

  const modMatch = yaml.match(/heading "(Key Box|Box|Straight|Key|Wheel)"/i);
  if (modMatch) context.modifier = modMatch[1];

  const horsePattern = /generic "(\d+): ([^"]+)"/g;
  let hm;
  while ((hm = horsePattern.exec(yaml)) !== null) {
    context.horses.push({ pp: parseInt(hm[1]), name: hm[2] });
  }

  const totalMatch = yaml.match(/Bet Total:.*?\$([0-9.]+)/);
  if (totalMatch) context.betTotal = `$${totalMatch[1]}`;

  const condMatch = yaml.match(/\$\d+K?\s+(CLAIMING|ALLOWANCE|MAIDEN|STARTER[^.]*)/i);
  if (condMatch) context.conditions = condMatch[0];

  return context;
}

// --- Command Handlers ---

async function cmdStatus() {
  const result = await withBridge(ws => sendRequest(ws, MSG.BRIDGE_HEALTH, {}));
  output(result);
}

async function cmdSessions() {
  const result = await withBridge(ws => sendRequest(ws, MSG.BRIDGE_SESSION_LIST, {}));
  output(result);
}

async function cmdSessionCreate() {
  const name = positional[2];
  if (!name) usageError('session create requires a name');
  const payload = { name };
  if (flags.auth) payload.authPath = flags.auth;

  const result = await withBridge(ws => sendRequest(ws, MSG.BRIDGE_SESSION_CREATE, payload));
  output(result);
}

async function cmdSessionDestroy() {
  const sessionId = positional[2];
  if (!sessionId) usageError('session destroy requires a session ID');
  const result = await withBridge(ws =>
    sendRequest(ws, MSG.BRIDGE_SESSION_DESTROY, { sessionId })
  );
  output(result);
}

async function cmdSessionInfo() {
  const sessionId = positional[2];
  if (!sessionId) usageError('session info requires a session ID');
  // Get all sessions and filter by ID
  const result = await withBridge(ws => sendRequest(ws, MSG.BRIDGE_SESSION_LIST, {}));
  const session = (result.sessions || []).find(
    s => s.id === sessionId || s.name === sessionId
  );
  if (!session) {
    output({ error: 'Session not found' });
    process.exit(1);
  }
  output(session);
}

async function cmdSnapshot() {
  const sessionId = positional[1];
  if (!sessionId) usageError('snapshot requires a session ID');

  const result = await withBridge(ws =>
    sendRequest(ws, MSG.BRIDGE_SNAPSHOT, { sessionId })
  );

  if (flags.raw) {
    outputRaw(result.yaml || '');
  } else {
    output(result);
  }
}

async function cmdNavigate() {
  const sessionId = positional[1];
  const url = positional[2];
  if (!sessionId || !url) usageError('navigate requires <session> <url>');

  const result = await withBridge(ws =>
    sendRequest(ws, MSG.BRIDGE_NAVIGATE, { sessionId, url })
  );
  output(result);
}

async function cmdClick() {
  const sessionId = positional[1];
  const ref = positional[2];
  if (!sessionId || !ref) usageError('click requires <session> <ref>');

  const result = await withBridge(ws =>
    sendRequest(ws, MSG.BRIDGE_CLICK, { sessionId, ref })
  );
  output(result);
}

async function cmdFill() {
  const sessionId = positional[1];
  const ref = positional[2];
  const value = positional.slice(3).join(' ');
  if (!sessionId || !ref || !value) usageError('fill requires <session> <ref> <value>');

  const result = await withBridge(ws =>
    sendRequest(ws, MSG.BRIDGE_FILL, { sessionId, ref, value })
  );
  output(result);
}

async function cmdEval() {
  const sessionId = positional[1];
  const expr = positional.slice(2).join(' ');
  if (!sessionId || !expr) usageError('eval requires <session> <expr>');

  const result = await withBridge(ws =>
    sendRequest(ws, MSG.BRIDGE_EVAL, { sessionId, expr })
  );
  output(result);
}

async function cmdCommand() {
  const sessionId = positional[1];
  const rawCmd = positional.slice(2).join(' ');
  if (!sessionId || !rawCmd) usageError('command requires <session> <raw_cmd>');

  const result = await withBridge(ws =>
    sendRequest(ws, MSG.BRIDGE_COMMAND, { sessionId, command: rawCmd })
  );
  output(result);
}

async function cmdWatch() {
  const sessionId = positional[1];
  if (!sessionId) usageError('watch requires a session ID');

  stderr('Watching session (Ctrl+C to stop)...');

  const ws = await connectToBridge();
  await identify(ws);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Only output broadcast events related to our session (or all if watching)
    if (msg.type === MSG.BRIDGE_STATUS || msg.type === MSG.BRIDGE_SNAPSHOT_RESULT) {
      if (!msg.payload?.sessionId || msg.payload.sessionId === sessionId) {
        output({ event: msg.type, ...msg.payload, timestamp: msg.timestamp });
      }
    }
  });

  ws.on('close', () => {
    stderr('Connection closed');
    process.exit(0);
  });

  // Stay alive until SIGINT
  process.on('SIGINT', () => {
    stderr('\nStopping watch...');
    ws.close(1000);
    process.exit(0);
  });
}

async function cmdSearch() {
  const query = positional.slice(1).join(' ');
  if (!query) usageError('search requires a query');

  const payload = { query };
  if (flags.limit) payload.limit = flags.limit;

  const result = await withBridge(ws =>
    sendRequest(ws, MSG.BRIDGE_SEARCH_SNAPSHOTS, payload)
  );
  output(result);
}

async function cmdContext() {
  const sessionId = positional[1];
  if (!sessionId) usageError('context requires a session ID');

  const result = await withBridge(ws =>
    sendRequest(ws, MSG.BRIDGE_SNAPSHOT, { sessionId })
  );

  const yaml = result.yaml || '';
  const context = parseRaceContext(yaml);
  context.sessionId = result.sessionId;
  context.url = result.url;
  context.snapshotLines = result.lines;
  context.timestamp = result.timestamp;
  output(context);
}

// --- Dispatch ---

async function main() {
  if (!command) {
    printUsage();
    process.exit(2);
  }

  try {
    switch (command) {
      case 'status':
        await cmdStatus();
        break;

      case 'sessions':
        await cmdSessions();
        break;

      case 'session':
        switch (subcommand) {
          case 'create':
            await cmdSessionCreate();
            break;
          case 'destroy':
            await cmdSessionDestroy();
            break;
          case 'info':
            await cmdSessionInfo();
            break;
          default:
            usageError(`Unknown session subcommand: ${subcommand}`);
        }
        break;

      case 'snapshot':
        await cmdSnapshot();
        break;

      case 'navigate':
        await cmdNavigate();
        break;

      case 'click':
        await cmdClick();
        break;

      case 'fill':
        await cmdFill();
        break;

      case 'eval':
        await cmdEval();
        break;

      case 'command':
        await cmdCommand();
        break;

      case 'watch':
        await cmdWatch();
        break;

      case 'search':
        await cmdSearch();
        break;

      case 'context':
        await cmdContext();
        break;

      default:
        usageError(`Unknown command: ${command}`);
    }
  } catch (err) {
    output({ error: err.message });
    stderr(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
