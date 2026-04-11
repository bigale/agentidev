#!/usr/bin/env node
/**
 * Capture console messages from an extension page over a short window.
 * Uses CDP directly for persistent listener.
 *
 * Usage:
 *   node packages/bridge/scripts/page-console.mjs <url-substring> [durationMs]
 */
import http from 'http';
import WebSocket from 'ws';

const urlHint = process.argv[2];
const durationMs = parseInt(process.argv[3] || '3000', 10);
if (!urlHint) { console.error('usage: page-console.mjs <url-substring> [durationMs]'); process.exit(1); }

function httpGet(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d))); }).on('error', rej);
  });
}

const targets = await httpGet('http://localhost:9222/json');
const page = targets.find(t => t.type === 'page' && t.url.includes(urlHint));
if (!page) { console.error(`no page matching "${urlHint}"`); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.once('open', r));

const events = [];
let nextId = 1;
const pending = new Map();

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg.result);
  } else if (msg.method) {
    events.push(msg);
  }
});

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
await new Promise(r => setTimeout(r, durationMs));

for (const evt of events) {
  if (evt.method === 'Runtime.consoleAPICalled') {
    const args = (evt.params.args || []).map(a =>
      a.value !== undefined ? JSON.stringify(a.value) :
      a.description || a.type
    ).join(' ');
    console.log(`[console:${evt.params.type}] ${args}`);
  } else if (evt.method === 'Runtime.exceptionThrown') {
    const e = evt.params.exceptionDetails;
    console.log(`[exception] ${e.exception?.description || e.text}`);
  } else if (evt.method === 'Log.entryAdded') {
    const e = evt.params.entry;
    console.log(`[log:${e.level}] ${e.text}`);
  } else if (evt.method === 'Network.requestWillBeSent') {
    const req = evt.params.request;
    console.log(`[net:req] ${req.method} ${req.url.slice(0, 120)}`);
  } else if (evt.method === 'Network.responseReceived') {
    const r = evt.params.response;
    console.log(`[net:res] ${r.status} ${r.url.slice(0, 120)}`);
  } else if (evt.method === 'Network.loadingFailed') {
    console.log(`[net:fail] ${evt.params.errorText} ${evt.params.requestId}`);
  }
}

ws.close();
