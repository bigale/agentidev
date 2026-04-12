// Capture historical console events from SW after enabling Runtime
import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
await new Promise(r => ws.once('open', r));
const events = [];
ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (m.method === 'Runtime.consoleAPICalled' || m.method === 'Runtime.exceptionThrown' || m.method === 'Log.entryAdded') {
    events.push(m);
  }
});
function send(id, method, params) {
  return new Promise((resolve) => {
    const handler = raw => { const m = JSON.parse(raw.toString()); if (m.id === id) { ws.off('message', handler); resolve(m); } };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
await send(1, 'Log.enable', {});
await send(2, 'Runtime.enable', {});
// Force the SW to wake up so any deferred console messages flush
await send(3, 'Runtime.evaluate', { expression: 'globalThis.__handlers ? "ok" : "no"', returnByValue: true });
await new Promise(r => setTimeout(r, 1000));
console.log('captured', events.length, 'events');
for (const e of events.slice(-30)) {
  if (e.method === 'Runtime.consoleAPICalled') {
    const args = e.params.args.map(a => a.value !== undefined ? JSON.stringify(a.value) : (a.description || '?')).join(' ');
    console.log('[' + e.params.type + ']', args.slice(0, 400));
  } else if (e.method === 'Runtime.exceptionThrown') {
    console.log('[ex]', (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text || '').slice(0, 600));
  } else if (e.method === 'Log.entryAdded') {
    console.log('[' + e.params.entry.level + ']', (e.params.entry.text || '').slice(0, 400));
  }
}
ws.close();
