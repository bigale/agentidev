import http from 'http';
import WebSocket from 'ws';

function httpGet(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

const targets = await httpGet('http://localhost:9222/json');
const sw = targets.find(t => t.type === 'service_worker');
if (!sw) { console.error('no sw'); process.exit(1); }

const ws = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise(r => ws.once('open', r));

await new Promise((resolve, reject) => {
  const id = 1;
  ws.once('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  });
  ws.send(JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: { expression: 'chrome.runtime.reload()', returnByValue: true },
  }));
});
console.log('reloaded');
ws.close();
