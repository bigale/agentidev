import WebSocket from 'ws';
import http from 'http';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function cdp(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const timeout = setTimeout(() => reject(new Error(`CDP ${method} timeout`)), 10000);
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id === id) {
        clearTimeout(timeout);
        ws.off('message', handler);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const targets = await httpGet('http://localhost:9222/json');
const extId = 'ncbbpgbdecmmcmghfahmmpddapbncobd';
const scUrl = `chrome-extension://${extId}/smartclient-app/wrapper.html?mode=dashboard`;

// Connect to browser-level WS to create new target
const browserInfo = await httpGet('http://localhost:9222/json/version');
const browserWs = new WebSocket(browserInfo.webSocketDebuggerUrl);
await new Promise(r => browserWs.once('open', r));

const result = await cdp(browserWs, 'Target.createTarget', { url: scUrl });
console.log('Created target:', result.targetId);
browserWs.close();

// Wait a bit for page to load then list new targets
await new Promise(r => setTimeout(r, 3000));
const newTargets = await httpGet('http://localhost:9222/json');
console.log('\n--- Targets after open ---');
for (const t of newTargets) {
  if (t.url.includes('smartclient-app') || t.type === 'iframe') {
    console.log(t.type.padEnd(12), '|', (t.title || '').slice(0, 30).padEnd(30), '|', t.url.slice(0, 90));
  }
}
