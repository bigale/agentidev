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

// Script injected into srcdoc to fix anchor links (sandbox blocks normal # navigation)
const ANCHOR_FIX = `<script>document.addEventListener('click',function(e){var a=e.target.closest('a[href^="#"]');if(!a)return;e.preventDefault();var id=a.getAttribute('href').slice(1);var el=document.getElementById(id)||document.querySelector('[name="'+id+'"]');if(el)el.scrollIntoView({behavior:'smooth'});});window.addEventListener('message',function(e){if(e.data&&e.data.type==='scroll-to'){var el=document.getElementById(e.data.id)||document.querySelector('[name="'+e.data.id+'"]');if(el)el.scrollIntoView({behavior:'smooth'});}});<\/script>`;

// Strip reload patterns that would blank an srcdoc iframe, inject anchor fix
function cleanHtml(html) {
  let cleaned = html
    .replace(/setTimeout\s*\([^)]*location\.reload[^)]*\)\s*;?/g, '/* reload stripped */')
    .replace(/location\.reload\s*\([^)]*\)\s*;?/g, '/* reload stripped */');
  // Inject anchor fix before </body> or at end
  if (cleaned.includes('</body>')) {
    cleaned = cleaned.replace('</body>', ANCHOR_FIX + '</body>');
  } else {
    cleaned += ANCHOR_FIX;
  }
  return cleaned;
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

    const html = cleanHtml(response.source);

    // Only update iframe if content actually changed
    if (html !== currentContent) {
      currentContent = html;
      frame.srcdoc = html;
      frame.style.display = 'block';
      errorEl.style.display = 'none';
      // Scroll to fragment from parent URL after iframe loads
      const hash = location.hash.slice(1);
      if (hash) {
        frame.addEventListener('load', () => {
          frame.contentWindow.postMessage({ type: 'scroll-to', id: hash }, '*');
        }, { once: true });
      }
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
