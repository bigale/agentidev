import WebSocket from 'ws';
const wsUrl = process.argv[2];
const extId = process.argv[3];
if (!wsUrl || !extId) { console.error('usage: enable-ext.mjs <wsUrl> <extId>'); process.exit(1); }
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.once('open', r));
let _id = 0;
async function send(method, params) {
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
const r = await send('Runtime.evaluate', {
  expression: `(async () => {
    const mgr = document.querySelector('extensions-manager');
    // service is a shared Service-like object
    const service = mgr.delegate_ || mgr.delegate;
    if (service && service.setItemEnabled) {
      await service.setItemEnabled('${extId}', true);
      return 'enabled via delegate';
    }
    // Fallback: click the toggle
    const items = mgr.shadowRoot.querySelector('extensions-item-list').shadowRoot.querySelectorAll('extensions-item');
    for (const it of items) {
      if (it.id === '${extId}') {
        const toggle = it.shadowRoot.querySelector('#enableToggle');
        if (toggle) { toggle.click(); return 'toggled'; }
      }
    }
    return 'not found';
  })()`,
  returnByValue: true,
  awaitPromise: true,
});
console.log(JSON.stringify(r.result, null, 2));
if (r.result?.exceptionDetails) console.error(JSON.stringify(r.result.exceptionDetails, null, 2));
ws.close();
