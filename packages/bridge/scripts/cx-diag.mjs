import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
await new Promise(r => ws.once('open', r));
const r = await new Promise(resolve => {
  const timer = setTimeout(() => resolve({ timeout: true }), 3000);
  ws.once('message', raw => { clearTimeout(timer); resolve(JSON.parse(raw.toString())); });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
    expression: `JSON.stringify({ now: performance.now(), spawnBusy: typeof _spawnBusy !== 'undefined' ? _spawnBusy : 'undef', queueLen: typeof _spawnQueue !== 'undefined' ? _spawnQueue.length : 0 })`,
    returnByValue: true
  }}));
});
console.log(r.timeout ? 'TIMEOUT — runtime page is unresponsive' : r.result?.result?.value);
ws.close();
