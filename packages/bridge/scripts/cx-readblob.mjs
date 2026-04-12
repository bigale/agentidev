import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
await new Promise(r => ws.once('open', r));
const r = await new Promise(resolve => {
  ws.once('message', raw => resolve(JSON.parse(raw.toString())));
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
    expression: `(async () => {
      try {
        var blob = await _filesDevice.readFileAsBlob('/bintest.txt');
        return JSON.stringify({ size: blob.size, type: blob.type, text: await blob.text() });
      } catch (e) {
        return JSON.stringify({ error: e.message, stack: e.stack && e.stack.slice(0, 300) });
      }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  }}));
});
console.log(r.result?.result?.value);
ws.close();
