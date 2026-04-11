import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:9222/devtools/page/7D1D506AEAC79C09B7D149DCC685D389');
await new Promise(r => ws.once('open', r));
async function send(id, method, params) {
  return new Promise((resolve, reject) => {
    const handler = raw => {
      const m = JSON.parse(raw.toString());
      if (m.id === id) { ws.off('message', handler); resolve(m); }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
await send(1, 'Runtime.enable');
const r = await send(2, 'Runtime.evaluate', {
  expression: `(async () => {
    const svc = document.querySelector('extensions-manager')?.shadowRoot?.querySelector('extensions-item-list')?.shadowRoot?.querySelectorAll('extensions-item');
    const ids = [];
    if (svc) svc.forEach(el => ids.push({ id: el.id, enabled: el.data?.state === 'ENABLED', error: el.data?.runtimeErrors?.length || 0 }));
    return ids;
  })()`,
  returnByValue: true,
  awaitPromise: true,
});
console.log(JSON.stringify(r.result, null, 2));
ws.close();
