import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
await new Promise(r => ws.once('open', r));
const r = await new Promise(resolve => {
  const timer = setTimeout(() => resolve({ timeout: true }), 30000);
  const handler = raw => { const m = JSON.parse(raw.toString()); if (m.id === 1) { ws.off('message', handler); clearTimeout(timer); resolve(m); } };
  ws.on('message', handler);
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
    expression: "(async () => { try { var lib = await cheerpjRunLibrary('/app/hello-main.jar'); var Hello = await lib.com.agentidev.Hello; var result = await Hello.version(); return 'typeof=' + typeof result; } catch(e) { return 'ERR:' + (e && e.message ? e.message : String(e)) + ' STACK:' + (e && e.stack ? e.stack.slice(0,200) : 'none'); } })()",
    returnByValue: true,
    awaitPromise: true,
  }}));
});
if (r.timeout) console.log('TIMEOUT');
else console.log(r.result?.result?.value || JSON.stringify(r.result));
ws.close();
