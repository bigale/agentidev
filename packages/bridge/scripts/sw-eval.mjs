#!/usr/bin/env node
// Eval a JS expression in the extension service worker context.
import http from 'http';
import WebSocket from 'ws';

function httpGet(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
  });
}

const ts = await httpGet('http://localhost:9222/json');
const sw = ts.find(t => t.type === 'service_worker');
if (!sw) { console.error('no service worker'); process.exit(1); }

const ws = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise(r => ws.once('open', r));

const expr = process.argv[2];
if (!expr) { console.error('usage: sw-eval.mjs <expr>'); process.exit(1); }

const reqId = 1;
const result = await new Promise((resolve, reject) => {
  const handler = (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id === reqId) {
      ws.off('message', handler);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  ws.on('message', handler);
  ws.send(JSON.stringify({
    id: reqId,
    method: 'Runtime.evaluate',
    params: { expression: expr, returnByValue: true, awaitPromise: true },
  }));
});

if (result && result.exceptionDetails) {
  console.error('exception:', result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  process.exit(1);
}
console.log(JSON.stringify(result && result.result && result.result.value, null, 2));
ws.close();
