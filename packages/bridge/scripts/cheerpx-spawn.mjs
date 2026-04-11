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
const expr = `(async () => {
  const ch = new MessageChannel();
  const p = new Promise(r => { ch.port1.onmessage = e => r(e.data); });
  window.postMessage({ source: 'agentidev-cheerpx', id: 1, type: 'spawn', cmd: '/usr/bin/python3', args: ['-c', 'print(1+1)'] }, '*', [ch.port2]);
  // The runtime replies via postMessage to the source window, not via the port (handler above).
  // Use a side listener on window for the actual reply:
  const reply = await new Promise((resolve) => {
    window.addEventListener('message', function on(e) {
      if (e.data && e.data.source === 'agentidev-cheerpx-response' && e.data.id === 1) {
        window.removeEventListener('message', on);
        resolve(e.data.response);
      }
    });
  });
  return reply;
})()`;
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
if (r.result?.exceptionDetails) {
  console.error(JSON.stringify(r.result.exceptionDetails, null, 2));
} else {
  console.log(JSON.stringify(r.result?.result?.value, null, 2));
}
ws.close();
