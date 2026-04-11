import http from 'http';
import WebSocket from 'ws';
import { writeFileSync } from 'fs';

function httpGet(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d))); }).on('error', rej);
  });
}

const targets = await httpGet('http://localhost:9222/json');
const sandbox = targets.find(t => t.type === 'iframe' && t.url.includes('smartclient-app/app.html'));
if (!sandbox) { console.error('no sandbox target'); process.exit(1); }
console.log('Sandbox target:', sandbox.id);

const ws = new WebSocket(sandbox.webSocketDebuggerUrl);
await new Promise(r => ws.once('open', r));

const result = await new Promise((resolve, reject) => {
  ws.once('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  });
  ws.send(JSON.stringify({
    id: 1,
    method: 'Page.captureScreenshot',
    params: { format: 'png', captureBeyondViewport: true },
  }));
});

writeFileSync('/tmp/sc-sandbox.png', Buffer.from(result.data, 'base64'));
console.log('Saved /tmp/sc-sandbox.png', Buffer.from(result.data, 'base64').length, 'bytes');
ws.close();
