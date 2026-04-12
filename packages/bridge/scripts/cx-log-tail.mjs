import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
await new Promise(r => ws.once('open', r));
const r = await new Promise(resolve => {
  const id = 1;
  ws.once('message', raw => resolve(JSON.parse(raw.toString())));
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
    expression: `document.getElementById('log').innerText.split('\\n').slice(-15).join('\\n')`,
    returnByValue: true
  }}));
});
console.log(r.result?.result?.value);
ws.close();
