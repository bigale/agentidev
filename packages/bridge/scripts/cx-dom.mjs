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
      tag: el.tagName,
      childCount: el.childNodes.length,
      innerHTMLSample: el.innerHTML.slice(0, 600),
      childTypes: Array.from(el.childNodes).slice(0, 10).map(n => ({ type: n.nodeType, tag: n.tagName, text: (n.textContent || '').slice(0, 60) })),
      textContent: el.textContent.slice(0, 200),
      innerText: el.innerText ? el.innerText.slice(0, 200) : null,
    };
  })()`,
  returnByValue: true,
});
console.log(JSON.stringify(r.result?.result?.value, null, 2));
ws.close();
