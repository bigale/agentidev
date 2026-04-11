// Listen for console events on a target for N seconds
import WebSocket from 'ws';
import http from 'http';
function httpGet(url) { return new Promise((res,rej)=>{http.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)))}).on('error',rej);}); }
const urlSub = process.argv[2] || 'cheerpj-runtime';
const seconds = parseInt(process.argv[3] || '5', 10);
const ts = await httpGet('http://localhost:9222/json');
const target = ts.find(t => t.url.includes(urlSub));
if (!target) { console.error('no target'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.once('open', r));
let _id = 0;
ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (m.method === 'Runtime.consoleAPICalled') {
    const args = m.params.args.map(a => a.value !== undefined ? JSON.stringify(a.value) : (a.description || '?')).join(' ');
    console.log('[' + m.params.type + ']', args.slice(0, 300));
  } else if (m.method === 'Runtime.exceptionThrown') {
    console.log('[ex]', (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 400));
  }
});
function send(method, params) {
  const id = ++_id;
  ws.send(JSON.stringify({ id, method, params }));
}
send('Runtime.enable');
console.log('listening for', seconds, 'seconds...');
await new Promise(r => setTimeout(r, seconds * 1000));
ws.close();
