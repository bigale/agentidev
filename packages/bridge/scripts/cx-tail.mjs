import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
await new Promise(r => ws.once('open', r));
const r = await new Promise(resolve => {
  ws.once('message', raw => resolve(JSON.parse(raw.toString())));
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
    expression: `(() => {
      var el = document.getElementById('log');
      var children = el.childNodes;
      var total = children.length;
      var last = [];
      for (var i = Math.max(0, total-5); i < total; i++) {
        last.push(children[i].textContent);
      }
      return JSON.stringify({ total, last });
    })()`,
    returnByValue: true
  }}));
});
console.log(r.result?.result?.value);
ws.close();
