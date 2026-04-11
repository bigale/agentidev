#!/usr/bin/env node
/**
 * Open a CheerpJ test page and capture ALL network URLs fetched by the
 * page AND any workers it spawns.
 *
 * Uses Target.setAutoAttach(flatten:true) so child targets are attached
 * to the SAME session (flattened), and we get their Network events on
 * the same WebSocket.
 *
 * Usage:
 *   node packages/bridge/scripts/capture-cheerpj.mjs
 *   node packages/bridge/scripts/capture-cheerpj.mjs <url> [durationMs]
 */

import http from 'http';
import WebSocket from 'ws';

const URL_ARG = process.argv[2] || 'http://localhost:9877/cheerpj-test.html';
const DURATION = parseInt(process.argv[3] || '60000', 10);

function httpGet(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let d=''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
  });
}

// Connect to the browser-level CDP to create a new target and attach
// via the Target domain's flatten mode.
const version = await httpGet('http://localhost:9222/json/version');
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise(r => ws.once('open', r));

let nextId = 1;
const pending = new Map();
const sessions = new Set();
const events = [];

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(msg));
  });
}

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
    return;
  }
  if (msg.method) {
    events.push(msg);
    // When a new target (worker, iframe, etc.) attaches, enable Network on it
    if (msg.method === 'Target.attachedToTarget') {
      const s = msg.params.sessionId;
      const info = msg.params.targetInfo;
      sessions.add(s);
      console.log(`[attach] ${info.type} | ${(info.url || '').slice(0, 100)} | session=${s}`);
      // Enable Network + Runtime + propagate auto-attach to grand-children
      ws.send(JSON.stringify({ id: nextId++, sessionId: s, method: 'Network.enable', params: {} }));
      ws.send(JSON.stringify({ id: nextId++, sessionId: s, method: 'Runtime.enable', params: {} }));
      ws.send(JSON.stringify({ id: nextId++, sessionId: s, method: 'Target.setAutoAttach',
        params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } }));
    }
  }
});

// Create a new about:blank target
const created = await send('Target.createTarget', { url: 'about:blank' });
console.log(`[create] target ${created.targetId}`);

// Attach to it with flatten: true so child attaches share this session
const attached = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
const rootSession = attached.sessionId;
sessions.add(rootSession);
console.log(`[attach root] session ${rootSession}`);

// Enable Network + auto-attach on root
await send('Network.enable', {}, rootSession);
await send('Runtime.enable', {}, rootSession);
await send('Log.enable', {}, rootSession);
await send('Page.enable', {}, rootSession);
await send('Target.setAutoAttach',
  { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, rootSession);

// Navigate to the test URL
console.log(`[navigate] ${URL_ARG}`);
await send('Page.navigate', { url: URL_ARG }, rootSession);

// Wait DURATION ms, collecting events
await new Promise(r => setTimeout(r, DURATION));

// Filter + print interesting events
console.log(`\n=== Events (${events.length} total, ${sessions.size} sessions) ===\n`);

const seenUrls = new Set();
const fetched = [];

for (const evt of events) {
  if (evt.method === 'Network.requestWillBeSent') {
    const u = evt.params.request.url;
    if (!seenUrls.has(u)) {
      seenUrls.add(u);
      fetched.push({ method: evt.params.request.method, url: u, session: evt.sessionId || 'root' });
    }
  } else if (evt.method === 'Network.loadingFailed') {
    console.log(`[fail] session=${evt.sessionId || 'root'} ${evt.params.errorText}`);
  } else if (evt.method === 'Runtime.exceptionThrown') {
    const e = evt.params.exceptionDetails;
    console.log(`[exception] session=${evt.sessionId || 'root'} ${(e.exception && e.exception.description) || e.text}`);
  } else if (evt.method === 'Runtime.consoleAPICalled') {
    const args = (evt.params.args || []).map(a =>
      a.value !== undefined ? JSON.stringify(a.value) : (a.description || a.type)
    ).join(' ');
    console.log(`[console:${evt.params.type}] session=${evt.sessionId || 'root'} ${args.slice(0, 200)}`);
  } else if (evt.method === 'Log.entryAdded') {
    console.log(`[log:${evt.params.entry.level}] ${evt.params.entry.text.slice(0, 200)}`);
  }
}

console.log(`\n=== All unique URLs fetched (${fetched.length}) ===\n`);
for (const f of fetched) {
  console.log(`  ${f.method} ${f.url.slice(0, 130)}`);
}

ws.close();
process.exit(0);
