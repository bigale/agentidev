import http from 'http';
import WebSocket from 'ws';
function httpGet(url) { return new Promise((res,rej)=>{http.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)))}).on('error',rej);}); }
const browserInfo = await httpGet('http://localhost:9222/json/version');
const bws = new WebSocket(browserInfo.webSocketDebuggerUrl);
await new Promise(r => bws.once('open', r));
function bsend(m, p) { return new Promise((r,j) => { const id = Math.floor(Math.random()*1e9); const h = (x) => { const msg = JSON.parse(x.toString()); if (msg.id === id) { bws.off('message', h); if (msg.error) j(new Error(msg.error.message)); else r(msg.result); } }; bws.on('message', h); bws.send(JSON.stringify({id, method: m, params: p})); }); }
const ts = await httpGet('http://localhost:9222/json');
const targets = ts.filter(t => t.url.includes('cheerpj') || t.url.includes('localhost:9877'));
for (const t of targets) {
  if (t.type === 'page') await bsend('Target.closeTarget', { targetId: t.id });
}
console.log('closed', targets.length);
bws.close();
