import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
await new Promise(r => ws.once('open', r));
const r = await new Promise(resolve => {
  const handler = raw => { const m = JSON.parse(raw.toString()); if (m.id === 1) { ws.off('message', handler); resolve(m); } };
  ws.on('message', handler);
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
    expression: 'document.getElementById("log").innerText',
    returnByValue: true
  }}));
});
console.log(r.result?.result?.value);
ws.close();
