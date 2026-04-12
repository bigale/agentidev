// Run a streaming spawn and inspect the vmConsole DOM during/after
import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
await new Promise(r => ws.once('open', r));
async function send(method, params) {
  return new Promise((resolve) => {
    const id = Math.floor(Math.random() * 100000);
    const handler = raw => { const m = JSON.parse(raw.toString()); if (m.id === id) { ws.off('message', handler); resolve(m); } };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const r = await send('Runtime.evaluate', {
  expression: `(() => {
    var el = document.getElementById('vmConsole');
    return {
      childCount: el.childNodes.length,
      lastTen: Array.from(el.childNodes).slice(-10).map(n => ({ tag: n.tagName, text: n.textContent })),
    };
  })()`,
  returnByValue: true,
});
console.log(JSON.stringify(r.result?.result?.value, null, 2));
ws.close();
