import http from 'http';
import WebSocket from 'ws';
function httpGet(url) { return new Promise((res,rej)=>{http.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)))}).on('error',rej);}); }
const ts = await httpGet('http://localhost:9222/json');
const iframe = ts.find(t => t.type === 'iframe' && t.url.includes('cheerpj-runtime'));
if (!iframe) { console.error('no iframe'); process.exit(1); }
const ws = new WebSocket(iframe.webSocketDebuggerUrl);
await new Promise(r => ws.once('open', r));
const expr = process.argv[2] || 'document.getElementById("log").innerText';
const result = await new Promise((resolve, reject) => {
  ws.once('message', raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
});
if (result.exceptionDetails) {
  console.error('exception:', result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  process.exit(1);
}
console.log(JSON.stringify(result.result?.value, null, 2));
ws.close();
