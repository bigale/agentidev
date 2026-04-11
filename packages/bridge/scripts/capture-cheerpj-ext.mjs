#!/usr/bin/env node
/**
 * Capture all network URLs fetched by the CheerpJ extension spike page
 * AND any workers it spawns, by navigating an already-open page with
 * Target.setAutoAttach(flatten: true) enabled BEFORE the navigation.
 */

import http from 'http';
import WebSocket from 'ws';

const DURATION = parseInt(process.argv[2] || '45000', 10);

function httpGet(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let d=''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
  });
}

// Find extension ID
const ts0 = await httpGet('http://localhost:9222/json');
const ext = ts0.find(t => t.url.startsWith('chrome-extension://'));
const extId = ext.url.split('/')[2];
const SPIKE_URL = `chrome-extension://${extId}/cheerpj-app/spike.html`;

const version = await httpGet('http://localhost:9222/json/version');
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise(r => ws.once('open', r));

let nextId = 1;
const pending = new Map();
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
    if (msg.method === 'Target.attachedToTarget') {
      const s = msg.params.sessionId;
      const info = msg.params.targetInfo;
      console.log(`[attach] ${info.type} | ${(info.url || '').slice(0, 100)} | session=${s} | waiting=${msg.params.waitingForDebugger}`);
      // Enable Network FIRST, then runtime and auto-attach
      ws.send(JSON.stringify({ id: nextId++, sessionId: s, method: 'Network.enable', params: {} }));
      ws.send(JSON.stringify({ id: nextId++, sessionId: s, method: 'Runtime.enable', params: {} }));
      ws.send(JSON.stringify({ id: nextId++, sessionId: s, method: 'Target.setAutoAttach',
        params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } }));
      // Now resume if the target was waiting
      if (msg.params.waitingForDebugger) {
        ws.send(JSON.stringify({ id: nextId++, sessionId: s, method: 'Runtime.runIfWaitingForDebugger', params: {} }));
      }
    }
  }
});

// Create a fresh target at about:blank and attach with flatten
const created = await send('Target.createTarget', { url: 'about:blank' });
console.log(`[create] ${created.targetId}`);
const attached = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
const rootSession = attached.sessionId;
console.log(`[root session] ${rootSession}`);

// Configure everything BEFORE navigation
await send('Network.enable', {}, rootSession);
await send('Runtime.enable', {}, rootSession);
await send('Log.enable', {}, rootSession);
await send('Page.enable', {}, rootSession);
await send('Target.setAutoAttach',
  { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, rootSession);

// Navigate to spike
console.log(`[navigate] ${SPIKE_URL}`);
await send('Page.navigate', { url: SPIKE_URL }, rootSession);

// Wait a bit, then trigger the run-library call from outside via a separate script
await new Promise(r => setTimeout(r, 5000));

console.log('[trigger] firing cheerpjRunLibrary via Runtime.evaluate (no await)');
// Fire-and-forget: don't await the promise, just start the work and observe.
// Store result on window._cjResult for optional later inspection.
await send('Runtime.evaluate', {
  expression: `(async () => {
    try {
      const bytes = new Uint8Array(await (await fetch("jars/hello.jar")).arrayBuffer());
      cheerpOSAddStringFile("/str/hello.jar", bytes);
      window._cjResult = 'pending';
      const lib = await cheerpjRunLibrary("/str/hello.jar");
      window._cjResult = 'lib ready ' + typeof lib;
      window._cjLib = lib;
    } catch (e) {
      window._cjResult = 'error: ' + e.message;
    }
  })();
  'fired';`,
  returnByValue: true,
  awaitPromise: false,  // don't wait
}, rootSession).catch(e => console.log('[trigger err]', e.message));
console.log('[trigger] fired, observing...');

// Wait the rest of the duration
await new Promise(r => setTimeout(r, Math.max(0, DURATION - 10000)));

// Print URL list
console.log(`\n=== Events: ${events.length} | Filtered output ===\n`);
const seen = new Set();
const fetched = [];
for (const evt of events) {
  if (evt.method === 'Network.requestWillBeSent') {
    const u = evt.params.request.url;
    if (!seen.has(u)) {
      seen.add(u);
      fetched.push({ method: evt.params.request.method, url: u, session: evt.sessionId });
    }
  } else if (evt.method === 'Network.loadingFailed') {
    const rid = evt.params.requestId;
    const match = events.find(e => e.method === 'Network.requestWillBeSent' && e.params.requestId === rid);
    const url = match ? match.params.request.url : '(unknown)';
    console.log(`[fail] ${evt.params.errorText} ${url.slice(0, 140)}`);
  }
}

console.log(`\n=== All unique URLs (${fetched.length}) ===\n`);
for (const f of fetched) {
  console.log(`  ${f.method} [${f.session ? f.session.slice(0, 8) : 'root'}] ${f.url.slice(0, 140)}`);
}

// Also dump the raw network events with session IDs
console.log(`\n=== Raw Network events by session ===\n`);
const bySession = {};
for (const evt of events) {
  if (evt.method && evt.method.startsWith('Network.')) {
    const s = evt.sessionId || 'root';
    (bySession[s] = bySession[s] || []).push(evt);
  }
}
for (const [s, evts] of Object.entries(bySession)) {
  console.log(`Session ${s}: ${evts.length} network events`);
  for (const e of evts) {
    const m = e.method.replace('Network.', '');
    if (m === 'requestWillBeSent') {
      console.log(`  REQ   ${e.params.request.method} ${e.params.request.url.slice(0, 130)}`);
    } else if (m === 'loadingFailed') {
      console.log(`  FAIL  ${e.params.requestId} ${e.params.errorText} type=${e.params.type}`);
    } else if (m === 'responseReceived') {
      console.log(`  RES   ${e.params.response.status} ${e.params.response.url.slice(0, 130)}`);
    } else {
      console.log(`  ${m}`);
    }
  }
}

// Also print any console messages from the worker / main page
console.log(`\n=== Console messages ===\n`);
for (const evt of events) {
  if (evt.method === 'Runtime.consoleAPICalled') {
    const args = (evt.params.args || []).map(a =>
      a.value !== undefined ? JSON.stringify(a.value) : (a.description || a.type)
    ).join(' ');
    console.log(`[${evt.params.type}] ${args.slice(0, 300)}`);
  } else if (evt.method === 'Runtime.exceptionThrown') {
    const e = evt.params.exceptionDetails;
    console.log(`[exception] ${(e.exception && e.exception.description) || e.text}`);
  } else if (evt.method === 'Log.entryAdded') {
    console.log(`[log:${evt.params.entry.level}] ${evt.params.entry.text.slice(0, 300)}`);
  }
}

ws.close();
process.exit(0);
