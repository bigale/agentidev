import WebSocket from 'ws';
import http from 'http';
function httpGet(url) { return new Promise((res,rej)=>{http.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)))}).on('error',rej);}); }
const ts = await httpGet('http://localhost:9222/json');
const workers = ts.filter(t => t.type === 'worker');
console.log('found', workers.length, 'worker(s)');
for (const w of workers) {
  console.log('---');
  console.log('url:', w.url);
  console.log('title:', w.title);
  try {
    const ws = new WebSocket(w.webSocketDebuggerUrl);
    await new Promise((r, rej) => { ws.once('open', r); ws.once('error', rej); setTimeout(() => rej(new Error('connect timeout')), 3000); });
    const result = await new Promise((resolve) => {
      ws.once('message', raw => resolve(JSON.parse(raw.toString())));
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify({now: performance.now(), heap: typeof performance.memory !== "undefined" ? Math.round(performance.memory.usedJSHeapSize/1024/1024) : 0, ttl: self.constructor.name})', returnByValue: true } }));
      setTimeout(() => resolve({ timeout: true }), 3000);
    });
    console.log('eval:', result.timeout ? 'TIMEOUT (worker is busy)' : result.result?.result?.value);
    ws.close();
  } catch (err) {
    console.log('error:', err.message);
  }
}
