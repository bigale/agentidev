import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
await new Promise(r => ws.once('open', r));
const r = await new Promise(resolve => {
  const timer = setTimeout(() => resolve({ timeout: true }), 30000);
  const handler = raw => { const m = JSON.parse(raw.toString()); if (m.id === 1) { ws.off('message', handler); clearTimeout(timer); resolve(m); } };
  ws.on('message', handler);
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
    expression: `(async () => {
      var host = window.Host.get();
      var results = {};
      // CheerpJ library mode
      try {
        var v = await host.runtimes.get('cheerpj').runLibrary({
          jarUrl: '/hello-main.jar',
          className: 'com.agentidev.Hello',
          method: 'version',
          args: [],
          cacheKey: 'hello-main'
        });
        results.cheerpj = { ok: true, version: v };
      } catch (e) { results.cheerpj = { ok: false, err: e.message }; }
      // Storage
      try {
        await host.storage.set('test', { from: 'web-app', n: 42 });
        var v2 = await host.storage.get('test');
        results.storage = { ok: true, value: v2 };
      } catch (e) { results.storage = { ok: false, err: e.message }; }
      // Network
      try {
        var r = await host.network.fetch('https://httpbin.org/get', {}, { as: 'json' });
        results.network = { ok: r.ok, status: r.status };
      } catch (e) { results.network = { ok: false, err: e.message }; }
      // Identity
      results.identity = host.identity;
      return JSON.stringify(results);
    })()`,
    returnByValue: true,
    awaitPromise: true,
  }}));
});
if (r.timeout) console.log('TIMEOUT');
else if (r.result?.exceptionDetails) console.log('EX:', r.result.exceptionDetails.text);
else console.log(r.result?.result?.value);
ws.close();
