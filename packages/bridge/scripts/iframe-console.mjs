import WebSocket from 'ws';
import http from 'http';
function httpGet(url) { return new Promise((res,rej)=>{http.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)))}).on('error',rej);}); }
const ts = await httpGet('http://localhost:9222/json');
const target = ts.find(t => t.url.includes(process.argv[2] || 'cheerpj-runtime'));
if (!target) { console.error('no matching target'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.once('open', r));
let _id = 0;
function send(method, params) {
  const id = ++_id;
  return new Promise((resolve) => {
    const handler = raw => { const m = JSON.parse(raw.toString()); if (m.id === id) { ws.off('message', handler); resolve(m); } };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const seen = [];
ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (m.method === 'Runtime.consoleAPICalled' || m.method === 'Runtime.exceptionThrown') {
    seen.push(m);
  }
});
await send('Runtime.enable');
// Trigger any pending events
await send('Runtime.evaluate', { expression: '1', returnByValue: true });
console.log('events seen during enable:', seen.length);
for (const e of seen.slice(-20)) {
  if (e.method === 'Runtime.consoleAPICalled') {
    const args = e.params.args.map(a => a.value || a.description).join(' ');
    console.log('[' + e.params.type + ']', args.slice(0, 200));
  } else if (e.method === 'Runtime.exceptionThrown') {
    console.log('[exception]', e.params.exceptionDetails.text, e.params.exceptionDetails.exception?.description?.slice(0, 200));
  }
}
ws.close();
