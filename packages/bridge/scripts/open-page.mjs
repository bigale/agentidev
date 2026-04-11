#!/usr/bin/env node
/**
 * Open an extension URL in a new tab via CDP Target.createTarget.
 *
 * Usage:
 *   node packages/bridge/scripts/open-page.mjs cheerpx-app/spike.html
 */
import http from 'http';
import WebSocket from 'ws';

function httpGet(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d))); }).on('error', rej);
  });
}

const relPath = process.argv[2];
if (!relPath) { console.error('usage: open-page.mjs <relative-path>'); process.exit(1); }

const targets = await httpGet('http://localhost:9222/json');
const ext = targets.find(t => t.url.startsWith('chrome-extension://'));
if (!ext) { console.error('no extension target'); process.exit(1); }
const extId = ext.url.split('/')[2];
const url = `chrome-extension://${extId}/${relPath}`;

const browserInfo = await httpGet('http://localhost:9222/json/version');
const ws = new WebSocket(browserInfo.webSocketDebuggerUrl);
await new Promise(r => ws.once('open', r));

const result = await new Promise((resolve, reject) => {
  ws.once('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  });
  ws.send(JSON.stringify({
    id: 1,
    method: 'Target.createTarget',
    params: { url },
  }));
});
console.log('Opened:', url);
console.log('Target ID:', result.targetId);
ws.close();
