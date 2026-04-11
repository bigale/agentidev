import WebSocket from 'ws';
import http from 'http';
function httpGet(url) { return new Promise((res,rej)=>{http.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)))}).on('error',rej);}); }
const ts = await httpGet('http://localhost:9222/json');
const sandbox = ts.find(t => t.type === 'iframe' && t.url.includes('smartclient-app/app.html'));
if (!sandbox) { console.error('no sandbox iframe'); process.exit(1); }
const ws = new WebSocket(sandbox.webSocketDebuggerUrl);
await new Promise(r => ws.once('open', r));
const expr = process.argv[2];
if (!expr) { console.error('usage: sandbox-eval.mjs <expr>'); process.exit(1); }
const reqId = 1;
const result = await new Promise((resolve, reject) => {
  const handler = raw => {
    const m = JSON.parse(raw.toString());
    if (m.id === reqId) { ws.off('message', handler); resolve(m); }
  };
  ws.on('message', handler);
  ws.send(JSON.stringify({ id: reqId, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
});
if (result.error || result.result?.exceptionDetails) {
  console.error('exception:', JSON.stringify(result.error || result.result.exceptionDetails, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(result.result?.result?.value, null, 2));
ws.close();
