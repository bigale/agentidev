/**
 * Sidebar UI for Contextual Recall
 *
 * Persistent sidebar for semantic search across browsing history.
 * Works for both personal use and enterprise deployment.
 */

const queryInput = document.getElementById('query-input');
const resultsDiv = document.getElementById('results');
const filtersDiv = document.getElementById('filters');
const settingsButton = document.getElementById('settings-button');

let currentFilter = 'all';
let debounceTimer = null;

// Load statistics on startup
loadStats();

// Search on Enter key
queryInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    performSearch();
  }
});

// Optional: Search as you type (debounced)
queryInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (queryInput.value.trim().length > 3) {
      performSearch();
    }
  }, 500);
});

// Filter chip handling
filtersDiv.addEventListener('click', (e) => {
  if (e.target.classList.contains('filter-chip')) {
    // Update active state
    filtersDiv.querySelectorAll('.filter-chip').forEach(chip => {
      chip.classList.remove('active');
    });
    e.target.classList.add('active');

    // Update current filter
    currentFilter = e.target.dataset.filter;

    // Re-run search if there's a query
    if (queryInput.value.trim()) {
      performSearch();
    }
  }
});

// Settings button
settingsButton.addEventListener('click', () => {
  // TODO: Open settings page
  chrome.runtime.openOptionsPage();
});

async function performSearch() {
  const query = queryInput.value.trim();

  if (!query) {
    return;
  }

  // Show loading
  resultsDiv.innerHTML = '<div class="loading">Searching...</div>';

  // Send query to background worker with filter
  chrome.runtime.sendMessage({
    type: 'QUERY',
    query: query,
    filter: currentFilter
  }, (response) => {
    if (response && response.results) {
      displayResults(response.results);
    } else {
      resultsDiv.innerHTML = '<div class="loading">No results found. Try a different query.</div>';
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

    // Title
    const title = document.createElement('div');
    title.className = 'result-title';
    title.textContent = result.title || 'Untitled';

    // URL
    const url = document.createElement('div');
    url.className = 'result-url';
    url.textContent = result.url;

    // Snippet
    const snippet = document.createElement('div');
    snippet.className = 'result-snippet';
    snippet.textContent = result.snippet || result.text?.substring(0, 200) + '...';

    // Metadata (timestamp, relevance, etc.)
    const meta = document.createElement('div');
    meta.className = 'result-meta';

    const timestamp = document.createElement('span');
    timestamp.textContent = formatTimestamp(result.timestamp);

    const relevance = document.createElement('span');
    relevance.textContent = `${Math.round(result.score * 100)}% match`;

    meta.appendChild(timestamp);
    meta.appendChild(relevance);

    // Assemble item
    item.appendChild(title);
    item.appendChild(url);
    item.appendChild(snippet);
    item.appendChild(meta);

    // Click handler - open URL
    item.addEventListener('click', () => {
      chrome.tabs.create({ url: result.url });
    });

    resultsDiv.appendChild(item);
  });
}

async function loadStats() {
  // Request stats from background worker
  chrome.runtime.sendMessage({
    type: 'GET_STATS'
  }, (response) => {
    if (response) {
      document.getElementById('pages-indexed').textContent = response.pagesIndexed || 0;
      document.getElementById('storage-used').textContent = formatBytes(response.storageUsed || 0);
      document.getElementById('queries-today').textContent = response.queriesToday || 0;
    }
  });
}

function formatTimestamp(timestamp) {
  if (!timestamp) return 'Unknown';

  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 60) {
    return `${diffMins} min ago`;
  } else if (diffHours < 24) {
    return `${diffHours} hours ago`;
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    return date.toLocaleDateString();
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return mb.toFixed(1) + ' MB';
}
