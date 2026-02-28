/**
 * Search mode — semantic search across browsing history.
 * Extracted from sidepanel.js search/results rendering.
 */

const resultsDiv = document.getElementById('results');

export function init() {
  // Results click-through handled by displayResults
}

export function activate() {
  // Nothing to do on activate — search happens on query
}

export function performSearch(query, filter) {
  if (filter === 'structured') {
    performStructuredSearch(query);
  } else {
    performSemanticSearch(query, filter);
  }
}

function performSemanticSearch(query, filter) {
  resultsDiv.innerHTML = '<div class="loading">Searching...</div>';

  chrome.runtime.sendMessage({
    type: 'QUERY',
    query: query,
    filter: filter
  }, (response) => {
    if (response && response.results) {
      displayResults(response.results);
    } else {
      resultsDiv.innerHTML = '<div class="loading">No results found. Try a different query.</div>';
    }
  });
}

function performStructuredSearch(query) {
  resultsDiv.innerHTML = '<div class="loading">Searching structured data...</div>';

  const fieldFilters = {};
  const queryParts = [];
  for (const token of query.split(/\s+/)) {
    const fieldMatch = token.match(/^(\w+):(.+)$/);
    if (fieldMatch && !['domain', 'after', 'keyword'].includes(fieldMatch[1].toLowerCase())) {
      fieldFilters[fieldMatch[1]] = fieldMatch[2];
    } else {
      queryParts.push(token);
    }
  }

  const options = {
    limit: 100,
    fieldFilters: Object.keys(fieldFilters).length > 0 ? fieldFilters : undefined
  };

  const domainToken = query.split(/\s+/).find(t => t.match(/^domain:/i));
  if (domainToken) {
    options.domain = domainToken.replace(/^domain:/i, '');
  }

  chrome.runtime.sendMessage({
    type: 'STRUCTURED_QUERY',
    options
  }, (response) => {
    if (response && response.results && response.results.length > 0) {
      displayStructuredResults(response.results);
    } else {
      resultsDiv.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📊</div>
          <div class="empty-state-text">
            No structured data found.<br>
            Browse pages with HTML tables to populate this index.<br>
            Try field filters like: price:>100 or name:Widget
          </div>
        </div>
      `;
    }
  });
}

function displayResults(results) {
  if (!results || results.length === 0) {
    resultsDiv.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🤷</div>
        <div class="empty-state-text">
          No results found. Try a different query or filter.
        </div>
      </div>
    `;
    return;
  }

  resultsDiv.innerHTML = '';

  results.forEach(result => {
    const item = document.createElement('div');
    item.className = 'result-item';

    const title = document.createElement('div');
    title.className = 'result-title';
    title.textContent = result.title || 'Untitled';

    const url = document.createElement('div');
    url.className = 'result-url';
    url.textContent = result.url;

    const snippet = document.createElement('div');
    snippet.className = 'result-snippet';
    snippet.textContent = result.snippet || result.text?.substring(0, 200) + '...';

    const meta = document.createElement('div');
    meta.className = 'result-meta';

    const timestamp = document.createElement('span');
    timestamp.textContent = formatTimestamp(result.timestamp);

    const chunkInfo = document.createElement('span');
    const chunkIcon = result.chunkType === 'heading' ? '📄' :
                       result.chunkType === 'table' ? '📊' :
                       result.chunkType === 'code' ? '💻' :
                       result.chunkType === 'token' ? '📝' : '📎';
    if (result.chunkTotal > 1) {
      chunkInfo.textContent = `${chunkIcon} Part ${(result.chunkIndex || 0) + 1}/${result.chunkTotal}`;
    } else {
      chunkInfo.textContent = `${chunkIcon} ${result.chunkType}`;
    }

    const relevance = document.createElement('span');
    relevance.textContent = `${Math.round(result.score * 100)}% match`;

    meta.appendChild(timestamp);
    meta.appendChild(chunkInfo);
    meta.appendChild(relevance);

    let keywordChipsEl = null;
    if (result.keywords && result.keywords.length > 0) {
      keywordChipsEl = document.createElement('div');
      keywordChipsEl.className = 'keyword-chips';
      result.keywords.slice(0, 5).forEach(kw => {
        const chip = document.createElement('span');
        chip.className = 'keyword-chip';
        chip.textContent = kw;
        keywordChipsEl.appendChild(chip);
      });
    }

    item.appendChild(title);
    item.appendChild(url);
    item.appendChild(snippet);
    item.appendChild(meta);
    if (keywordChipsEl) item.appendChild(keywordChipsEl);

    item.addEventListener('click', () => {
      chrome.tabs.create({ url: result.url });
    });

    resultsDiv.appendChild(item);
  });
}

function displayStructuredResults(records) {
  if (!records || records.length === 0) {
    resultsDiv.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📊</div>
        <div class="empty-state-text">No structured records found.</div>
      </div>
    `;
    return;
  }

  const allHeaders = [];
  const sourceUrls = new Set();
  for (const record of records) {
    sourceUrls.add(record.sourceUrl);
    if (record.headers) {
      for (const h of record.headers) {
        if (!allHeaders.includes(h)) allHeaders.push(h);
      }
    }
  }

  const container = document.createElement('div');
  container.className = 'struct-results-container';

  const summary = document.createElement('div');
  summary.className = 'struct-results-summary';
  summary.textContent = `${records.length} records from ${sourceUrls.size} page${sourceUrls.size !== 1 ? 's' : ''}`;
  container.appendChild(summary);

  if (allHeaders.length > 0) {
    const table = document.createElement('table');
    table.className = 'struct-results-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const h of allHeaders) {
      const th = document.createElement('th');
      th.textContent = h;
      headerRow.appendChild(th);
    }
    const sourceTh = document.createElement('th');
    sourceTh.textContent = 'Source';
    headerRow.appendChild(sourceTh);
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const record of records) {
      const tr = document.createElement('tr');
      for (const h of allHeaders) {
        const td = document.createElement('td');
        const val = record.fields[h];
        td.textContent = val !== undefined && val !== null ? String(val) : '';
        tr.appendChild(td);
      }
      const sourceTd = document.createElement('td');
      const sourceLink = document.createElement('span');
      sourceLink.className = 'struct-source-link';
      try {
        sourceLink.textContent = new URL(record.sourceUrl).hostname;
      } catch {
        sourceLink.textContent = record.sourceUrl;
      }
      sourceLink.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.tabs.create({ url: record.sourceUrl });
      });
      sourceTd.appendChild(sourceLink);
      tr.appendChild(sourceTd);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    const tableWrap = document.createElement('div');
    tableWrap.style.overflowX = 'auto';
    tableWrap.style.maxHeight = '500px';
    tableWrap.style.overflowY = 'auto';
    tableWrap.appendChild(table);
    container.appendChild(tableWrap);
  } else {
    const pre = document.createElement('pre');
    pre.style.fontSize = '11px';
    pre.style.maxHeight = '400px';
    pre.style.overflow = 'auto';
    pre.textContent = JSON.stringify(records.map(r => r.fields), null, 2);
    container.appendChild(pre);
  }

  resultsDiv.innerHTML = '';
  resultsDiv.appendChild(container);
}

function formatTimestamp(timestamp) {
  if (!timestamp) return 'Unknown';

  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hours ago`;
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString();
}
