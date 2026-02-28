/**
 * Feed Panel — bottom-left.
 * Filterable command feed with dynamic dropdowns and text search.
 */

export function initFeedPanel(container, state) {
  const body = container.querySelector('#dash-feed-body');
  const filterBar = container.querySelector('#dash-feed-filters');
  const countBadge = container.querySelector('#dash-feed-count');

  // Build filter bar
  filterBar.innerHTML = `
    <select id="dash-filter-type" class="dash-filter-select" title="Filter by type">
      <option value="">Type</option>
    </select>
    <select id="dash-filter-session" class="dash-filter-select" title="Filter by session">
      <option value="">Session</option>
    </select>
    <select id="dash-filter-status" class="dash-filter-select" title="Filter by status">
      <option value="">Status</option>
      <option value="success">success</option>
      <option value="error">error</option>
      <option value="running">running</option>
    </select>
    <select id="dash-filter-source" class="dash-filter-select" title="Filter by source">
      <option value="">Source</option>
    </select>
    <input id="dash-filter-text" class="dash-filter-input" placeholder="Search..." type="text">
  `;

  const typeSelect = filterBar.querySelector('#dash-filter-type');
  const sessionSelect = filterBar.querySelector('#dash-filter-session');
  const statusSelect = filterBar.querySelector('#dash-filter-status');
  const sourceSelect = filterBar.querySelector('#dash-filter-source');
  const textInput = filterBar.querySelector('#dash-filter-text');

  // Wire filter changes
  [typeSelect, sessionSelect, statusSelect, sourceSelect].forEach(sel => {
    sel.addEventListener('change', () => applyFilters());
  });
  textInput.addEventListener('input', () => applyFilters());

  function applyFilters() {
    state.merge('feedFilters', {
      type: typeSelect.value || null,
      session: sessionSelect.value || null,
      status: statusSelect.value || null,
      source: sourceSelect.value || null,
      text: textInput.value.trim().toLowerCase(),
    });
  }

  function populateDropdowns(feed) {
    const types = [...new Set(feed.map(e => e.type).filter(Boolean))].sort();
    const sessions = [...new Set(feed.map(e => e.sessionId).filter(Boolean))].sort();
    const sources = [...new Set(feed.map(e => e.source).filter(Boolean))].sort();

    updateOptions(typeSelect, types);
    updateOptions(sessionSelect, sessions);
    updateOptions(sourceSelect, sources);
  }

  function updateOptions(select, values) {
    const current = select.value;
    const firstOption = select.options[0].outerHTML;
    select.innerHTML = firstOption + values.map(v =>
      `<option value="${escapeAttr(v)}">${escapeHtml(v)}</option>`
    ).join('');
    select.value = current;
  }

  function getFilteredFeed() {
    const feed = state.get('commandFeed') || [];
    const filters = state.get('feedFilters') || {};

    return feed.filter(entry => {
      if (filters.type && entry.type !== filters.type) return false;
      if (filters.session && entry.sessionId !== filters.session) return false;
      if (filters.status && entry.status !== filters.status) return false;
      if (filters.source && entry.source !== filters.source) return false;
      if (filters.text) {
        const haystack = [
          entry.type, entry.sessionId, entry.source,
          summarizeRequest(entry.request)
        ].join(' ').toLowerCase();
        if (!haystack.includes(filters.text)) return false;
      }
      return true;
    });
  }

  function render() {
    const feed = state.get('commandFeed') || [];
    const filtered = getFilteredFeed();

    countBadge.textContent = `${filtered.length} / ${feed.length}`;
    populateDropdowns(feed);

    if (filtered.length === 0) {
      body.innerHTML = `<div class="dash-empty">No commands${feed.length > 0 ? ' matching filters' : ' yet'}</div>`;
      return;
    }

    // Newest first
    const visible = filtered.slice().reverse();
    const html = `<div class="dash-feed-list">${visible.map(entry => {
      const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
      const duration = entry.duration ? `${entry.duration}ms` : '';
      const icon = entry.status === 'success' ? '✓' : entry.status === 'error' ? '✗' : '…';

      return `
        <div class="dash-feed-entry" data-cmd-id="${escapeAttr(entry.id)}">
          <span class="dash-feed-time">${time}</span>
          <span class="dash-feed-type">${escapeHtml(entry.type)}</span>
          <span class="dash-feed-summary">${escapeHtml(summarizeRequest(entry.request))}</span>
          <span class="dash-feed-source">${escapeHtml(entry.source || '')}</span>
          <span class="dash-feed-status ${entry.status}">${icon} ${duration}</span>
        </div>
      `;
    }).join('')}</div>`;

    body.innerHTML = html;

    // Click to expand detail
    body.querySelectorAll('.dash-feed-entry').forEach(el => {
      el.addEventListener('click', () => toggleDetail(el, state));
    });
  }

  state.addEventListener('change', (e) => {
    const k = e.detail.key;
    if (k === 'commandFeed' || k === 'feedFilters') {
      render();
    }
  });

  render();
}

function toggleDetail(el, state) {
  const cmdId = el.dataset.cmdId;
  const existing = el.nextElementSibling;
  if (existing?.classList.contains('dash-feed-detail')) {
    existing.remove();
    return;
  }

  const feed = state.get('commandFeed') || [];
  const entry = feed.find(e => e.id === cmdId);
  if (!entry) return;

  const detail = document.createElement('div');
  detail.className = 'dash-feed-detail';
  detail.textContent = JSON.stringify({ request: entry.request, response: entry.response }, null, 2);
  el.insertAdjacentElement('afterend', detail);
}

function summarizeRequest(request) {
  if (!request) return '';
  if (request.command) return request.command;
  if (request.ref) return `ref=${request.ref}`;
  if (request.url) return request.url;
  if (request.name) return request.name;
  if (request.expr) return String(request.expr).substring(0, 60);
  return JSON.stringify(request).substring(0, 60);
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text) {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
