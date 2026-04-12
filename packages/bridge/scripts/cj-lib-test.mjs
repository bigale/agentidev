import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
await new Promise(r => ws.once('open', r));
const r = await new Promise(resolve => {
  const timer = setTimeout(() => resolve({ timeout: true }), 60000);
  const handler = raw => { const m = JSON.parse(raw.toString()); if (m.id === 1) { ws.off('message', handler); clearTimeout(timer); resolve(m); } };
  ws.on('message', handler);
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
    expression: `(async () => {
      var steps = [];
      try {
        // The library should be cached from the previous attempt
        steps.push('start');
        var lib = await cheerpjRunLibrary('/app/hello-main.jar:/app/agentidev-bridge.jar');
        steps.push('lib loaded');
        var com = await lib.com;
        steps.push('com: ' + typeof com);
        var agentidev = await com.agentidev;
        steps.push('agentidev: ' + typeof agentidev);
        var Hello = await agentidev.Hello;
        steps.push('Hello: ' + typeof Hello);
        var result = await Hello.version();
        steps.push('version() returned: typeof=' + typeof result);

        // Try the native bridge
        var Bridge = await lib.com.agentidev.AgentidevBridge;
        steps.push('Bridge: ' + typeof Bridge);

        // Set up the result promise BEFORE calling sendResult
        var resultPromise = window._waitForNativeResult();
        steps.push('waiting for native result...');

        // Pass the Java String Proxy to Bridge.sendResult — LiveConnect
        // should convert it at the parameter boundary
        await Bridge.sendResult(result);
        steps.push('sendResult called');

        var jsString = await resultPromise;
        steps.push('native result: ' + JSON.stringify(jsString));
        return steps.join(' | ');
      } catch (e) {
        steps.push('ERROR: ' + (e && e.message || String(e)));
        return steps.join(' | ');
      }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  }}));
});
if (r.timeout) console.log('TIMEOUT');
else if (r.result?.exceptionDetails) console.log('EX:', r.result.exceptionDetails.text);
else console.log(r.result?.result?.value);
ws.close();
