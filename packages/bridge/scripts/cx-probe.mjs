import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
await new Promise(r => ws.once('open', r));
async function send(method, params) {
  return new Promise((resolve) => {
    const id = Math.floor(Math.random() * 100000);
    const handler = raw => { const m = JSON.parse(raw.toString()); if (m.id === id) { ws.off('message', handler); resolve(m); } };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const r = await send('Runtime.evaluate', {
  expression: `(() => {
    var cxLocal = (typeof _cx !== 'undefined' ? _cx : null);
    if (!cxLocal) {
      // _cx isn't exported by our runtime page; check if it's elsewhere
      return { found: false };
    }
    return {
      found: true,
      hasSetConsole: typeof cxLocal.setConsole,
      hasSetCustomConsole: typeof cxLocal.setCustomConsole,
      methods: Object.getOwnPropertyNames(Object.getPrototypeOf(cxLocal)).filter(n => typeof cxLocal[n] === 'function').slice(0, 30),
    };
  })()`,
  returnByValue: true,
});
console.log(JSON.stringify(r.result?.result?.value, null, 2));
ws.close();
