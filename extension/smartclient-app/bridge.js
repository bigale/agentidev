/**
 * Bridge between sandboxed SmartClient iframe and chrome.runtime.
 * Translates postMessage DS operations to background service worker messages.
 */

const iframe = document.getElementById('sc-frame');

window.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg || msg.source !== 'smartclient-ds') return;

  const type = 'DS_' + msg.operationType.toUpperCase();

  try {
    const response = await chrome.runtime.sendMessage({
      type,
      dataSource: msg.dataSource,
      data: msg.data,
      criteria: msg.criteria,
    });

    iframe.contentWindow.postMessage({
      source: 'smartclient-ds-response',
      id: msg.id,
      status: response.status,
      data: response.data,
      totalRows: response.totalRows,
    }, '*');
  } catch (err) {
    iframe.contentWindow.postMessage({
      source: 'smartclient-ds-response',
      id: msg.id,
      status: -1,
      data: err.message,
    }, '*');
  }
});
