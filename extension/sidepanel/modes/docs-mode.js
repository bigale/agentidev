/**
 * Docs mode — sidepanel documentation viewer.
 *
 * Loads markdown files from docs/guide/, renders as styled HTML,
 * provides table of contents and search. No external dependencies.
 */

let _container = null;
let _tocEl = null;
let _contentEl = null;
let _searchEl = null;
let _sections = [];
let _currentSection = null;

const DOCS_BASE = chrome.runtime.getURL('docs/guide/');

export function init() {
  // Docs container is set up on first activate
}

export function activate() {
  _container = document.getElementById('docs-container');
  if (!_container) return;

  if (!_container._docsInit) {
    _container.innerHTML = buildHTML();
    _tocEl = _container.querySelector('#docs-toc');
    _contentEl = _container.querySelector('#docs-content');
    _searchEl = _container.querySelector('#docs-search');
    _searchEl.addEventListener('input', handleSearch);
    _container._docsInit = true;
    loadIndex();
  }
}

export function deactivate() {}

function buildHTML() {
  return `
    <div style="display:flex;flex-direction:column;height:100%;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
      <div style="padding:8px 12px;background:#1a1a2e;border-bottom:1px solid #333;">
        <div style="font-size:14px;font-weight:600;color:#a8b4ff;margin-bottom:6px;">Documentation</div>
        <input id="docs-search" type="text" placeholder="Search docs..."
          style="width:100%;padding:5px 8px;background:#0d1117;color:#e6edf3;border:1px solid #333;border-radius:4px;font-size:12px;">
      </div>
      <div style="display:flex;flex:1;overflow:hidden;">
        <div id="docs-toc" style="width:160px;border-right:1px solid #333;overflow-y:auto;padding:8px;background:#0d1117;flex-shrink:0;"></div>
        <div id="docs-content" style="flex:1;overflow-y:auto;padding:12px 16px;background:#0d1117;color:#c9d1d9;font-size:13px;line-height:1.6;"></div>
      </div>
    </div>`;
}

async function loadIndex() {
  try {
    const resp = await fetch(DOCS_BASE + 'index.json');
    const index = await resp.json();
    _sections = index.sections;
    renderTOC();
    if (_sections.length > 0) loadSection(_sections[0].id);
  } catch (e) {
    _contentEl.innerHTML = '<p style="color:#f44336;">Failed to load docs index: ' + e.message + '</p>';
  }
}

function renderTOC() {
  _tocEl.innerHTML = _sections.map(s =>
    `<div class="docs-toc-item" data-id="${s.id}"
      style="padding:5px 8px;margin-bottom:2px;border-radius:4px;cursor:pointer;font-size:12px;color:#8b949e;"
      onmouseover="this.style.background='#161b22'" onmouseout="this.style.background=this.dataset.active?'#21262d':''"
      onclick="this.dispatchEvent(new CustomEvent('doc-nav',{bubbles:true,detail:'${s.id}'}))"
    >${s.title}</div>`
  ).join('');

  _tocEl.addEventListener('doc-nav', (e) => loadSection(e.detail));
}

async function loadSection(id) {
  const section = _sections.find(s => s.id === id);
  if (!section) return;
  _currentSection = id;

  // Highlight active TOC item
  _tocEl.querySelectorAll('.docs-toc-item').forEach(el => {
    const isActive = el.dataset.id === id;
    el.dataset.active = isActive ? '1' : '';
    el.style.background = isActive ? '#21262d' : '';
    el.style.color = isActive ? '#e6edf3' : '#8b949e';
    el.style.fontWeight = isActive ? '600' : '';
  });

  try {
    const resp = await fetch(DOCS_BASE + section.file);
    const md = await resp.text();
    _contentEl.innerHTML = renderMarkdown(md);
    _contentEl.scrollTop = 0;
  } catch (e) {
    _contentEl.innerHTML = '<p style="color:#f44336;">Failed to load: ' + section.file + '</p>';
  }
}

function handleSearch() {
  const query = _searchEl.value.toLowerCase().trim();
  if (!query) {
    // Show all TOC items
    _tocEl.querySelectorAll('.docs-toc-item').forEach(el => el.style.display = '');
    return;
  }
  // Filter TOC items by title match
  _tocEl.querySelectorAll('.docs-toc-item').forEach(el => {
    const title = el.textContent.toLowerCase();
    el.style.display = title.includes(query) ? '' : 'none';
  });

  // Also search content if loaded
  if (_contentEl.textContent.toLowerCase().includes(query)) {
    // Highlight matches (simple)
    const html = _contentEl.innerHTML;
    // Remove old highlights
    const clean = html.replace(/<mark class="doc-hl">/g, '').replace(/<\/mark>/g, '');
    // Add new highlights (case-insensitive, outside tags)
    const re = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    _contentEl.innerHTML = clean.replace(/>([^<]+)</g, (match, text) => {
      return '>' + text.replace(re, '<mark class="doc-hl" style="background:#4a3f00;color:#e6edf3;padding:1px 2px;border-radius:2px;">$1</mark>') + '<';
    });
  }
}

/**
 * Minimal markdown-to-HTML renderer. Handles:
 * - Headers (# through ####)
 * - Code blocks (``` with language)
 * - Inline code (`code`)
 * - Bold (**text**) and italic (*text*)
 * - Links [text](url)
 * - Unordered lists (- item)
 * - Ordered lists (1. item)
 * - Tables (| col | col |)
 * - Horizontal rules (---)
 * - Blockquotes (> text)
 */
function renderMarkdown(md) {
  const lines = md.split('\n');
  let html = '';
  let inCode = false;
  let codeLang = '';
  let codeLines = [];
  let inTable = false;
  let tableRows = [];
  let inList = false;
  let listType = '';

  function closeList() {
    if (inList) { html += listType === 'ul' ? '</ul>' : '</ol>'; inList = false; }
  }
  function closeTable() {
    if (inTable) {
      html += '<table style="border-collapse:collapse;width:100%;font-size:12px;margin:8px 0;">';
      tableRows.forEach((row, i) => {
        const tag = i === 0 ? 'th' : 'td';
        const bgStyle = i === 0 ? 'background:#21262d;font-weight:600;' : (i % 2 === 0 ? 'background:#0d1117;' : '');
        html += '<tr>' + row.map(cell =>
          `<${tag} style="padding:4px 8px;border:1px solid #333;${bgStyle}">${inlineFormat(cell.trim())}</${tag}>`
        ).join('') + '</tr>';
      });
      html += '</table>';
      inTable = false;
      tableRows = [];
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code blocks
    if (line.startsWith('```')) {
      if (inCode) {
        html += '<pre style="background:#161b22;padding:10px;border-radius:6px;overflow-x:auto;font-size:12px;color:#e6edf3;margin:8px 0;border:1px solid #333;"><code>' +
          escapeHtml(codeLines.join('\n')) + '</code></pre>';
        inCode = false;
        codeLines = [];
      } else {
        closeList(); closeTable();
        inCode = true;
        codeLang = line.slice(3).trim();
      }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }

    // Table
    if (line.includes('|') && line.trim().startsWith('|')) {
      closeList();
      const cells = line.split('|').slice(1, -1);
      if (cells.every(c => /^[\s-:]+$/.test(c))) continue; // separator row
      if (!inTable) inTable = true;
      tableRows.push(cells);
      continue;
    } else { closeTable(); }

    // Empty line
    if (line.trim() === '') { closeList(); continue; }

    // Headers
    const hMatch = line.match(/^(#{1,4})\s+(.*)/);
    if (hMatch) {
      closeList();
      const level = hMatch[1].length;
      const sizes = { 1: '20px', 2: '16px', 3: '14px', 4: '13px' };
      const colors = { 1: '#a8b4ff', 2: '#58a6ff', 3: '#c9d1d9', 4: '#8b949e' };
      const margins = { 1: '20px 0 8px', 2: '16px 0 6px', 3: '12px 0 4px', 4: '8px 0 4px' };
      html += `<div style="font-size:${sizes[level]};font-weight:600;color:${colors[level]};margin:${margins[level]};${level <= 2 ? 'border-bottom:1px solid #333;padding-bottom:4px;' : ''}">${inlineFormat(hMatch[2])}</div>`;
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) { html += '<hr style="border:none;border-top:1px solid #333;margin:12px 0;">'; continue; }

    // Blockquote
    if (line.startsWith('> ')) {
      closeList();
      html += `<div style="border-left:3px solid #444;padding:4px 12px;margin:8px 0;color:#8b949e;font-style:italic;">${inlineFormat(line.slice(2))}</div>`;
      continue;
    }

    // Unordered list
    if (/^[-*]\s/.test(line.trim())) {
      if (!inList || listType !== 'ul') { closeList(); html += '<ul style="margin:4px 0 4px 20px;padding:0;">'; inList = true; listType = 'ul'; }
      html += '<li style="margin:2px 0;">' + inlineFormat(line.trim().slice(2)) + '</li>';
      continue;
    }

    // Ordered list
    if (/^\d+\.\s/.test(line.trim())) {
      if (!inList || listType !== 'ol') { closeList(); html += '<ol style="margin:4px 0 4px 20px;padding:0;">'; inList = true; listType = 'ol'; }
      html += '<li style="margin:2px 0;">' + inlineFormat(line.trim().replace(/^\d+\.\s/, '')) + '</li>';
      continue;
    }

    // Paragraph
    closeList();
    html += '<p style="margin:6px 0;">' + inlineFormat(line) + '</p>';
  }
  closeList(); closeTable();
  return html;
}

function inlineFormat(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code style="background:#161b22;padding:1px 4px;border-radius:3px;font-size:12px;color:#79c0ff;">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#58a6ff;" target="_blank">$1</a>');
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
