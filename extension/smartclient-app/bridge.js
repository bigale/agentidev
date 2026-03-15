/**
 * Bridge between sandboxed SmartClient iframe and chrome.runtime.
 * Translates postMessage DS operations to background service worker messages.
 * Also routes AI generation requests (smartclient-ai) to SC_GENERATE_UI handler.
 */

const iframe = document.getElementById('sc-frame');

window.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg) return;

  // DataSource CRUD operations
  if (msg.source === 'smartclient-ds') {
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
    return;
  }

  // AI UI generation
  if (msg.source === 'smartclient-ai') {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SC_GENERATE_UI',
        prompt: msg.prompt,
      });

      iframe.contentWindow.postMessage({
        source: 'smartclient-ai-response',
        success: response.success,
        config: response.config,
        error: response.error,
      }, '*');
    } catch (err) {
      iframe.contentWindow.postMessage({
        source: 'smartclient-ai-response',
        success: false,
        error: err.message,
      }, '*');
    }
  }
});
