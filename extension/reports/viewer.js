/**
 * Report Viewer — loads HTML files from disk via bridge and renders in sandboxed iframe.
 * Polls every 60s and updates only when content changes.
 */

const params = new URLSearchParams(location.search);
const filePath = params.get('file');

const pathEl = document.getElementById('viewer-path');
const infoEl = document.getElementById('viewer-refresh-info');
const refreshBtn = document.getElementById('viewer-refresh-btn');
const frame = document.getElementById('viewer-frame');
const errorEl = document.getElementById('viewer-error');

let currentContent = null;
let pollTimer = null;

// Strip reload patterns that would blank an srcdoc iframe
function stripReload(html) {
  return html
    .replace(/setTimeout\s*\([^)]*location\.reload[^)]*\)\s*;?/g, '/* reload stripped */')
    .replace(/location\.reload\s*\([^)]*\)\s*;?/g, '/* reload stripped */');
}

function showError(msg) {
  frame.style.display = 'none';
  errorEl.style.display = 'block';
  errorEl.textContent = msg;
}

function updateTimestamp() {
  const now = new Date();
  infoEl.textContent = `Last refresh: ${now.toLocaleTimeString()}`;
}

async function loadReport() {
  if (!filePath) {
    showError('No file path specified. Use ?file=/path/to/report.html');
    return;
  }

  pathEl.textContent = filePath;
  document.title = `Report: ${filePath.split('/').pop()}`;

  try {
    const response = await chrome.runtime.sendMessage({ type: 'REPORT_LOAD', path: filePath });
    if (!response || response.error) {
      showError(response?.error || 'Failed to load report. Is the bridge connected?');
      return;
    }

    const html = stripReload(response.source);

    // Only update iframe if content actually changed
    if (html !== currentContent) {
      currentContent = html;
      frame.srcdoc = html;
      frame.style.display = 'block';
      errorEl.style.display = 'none';
    }
    updateTimestamp();
  } catch (err) {
    showError(`Error: ${err.message}`);
  }
}

// Manual refresh
refreshBtn.addEventListener('click', loadReport);

// Initial load
loadReport();

// Poll every 60s
pollTimer = setInterval(loadReport, 60000);
