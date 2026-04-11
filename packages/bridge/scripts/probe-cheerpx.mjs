import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
await new Promise(r => ws.once('open', r));
let _id = 0;
function send(method, params) {
  const id = ++_id;
  return new Promise((resolve, reject) => {
    const handler = raw => {
      const m = JSON.parse(raw.toString());
      if (m.id === id) { ws.off('message', handler); resolve(m); }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
await send('Runtime.enable');
const expr = `JSON.stringify({
  coi: typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : null,
  sab: typeof SharedArrayBuffer === 'function',
  cheerpx: typeof CheerpX,
  log: document.getElementById('log').innerText.split('\\n').slice(-10).join('\\n'),
})`;
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
console.log(r.result?.result?.value);
ws.close();
