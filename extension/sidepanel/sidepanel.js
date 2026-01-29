/**
 * Sidebar UI for Contextual Recall
 *
 * Persistent sidebar for semantic search across browsing history.
 * Works for both personal use and enterprise deployment.
 */

const queryInput = document.getElementById('query-input');
const resultsDiv = document.getElementById('results');
const answerContainer = document.getElementById('answer-container');
const answerText = document.getElementById('answer-text');
const answerSources = document.getElementById('answer-sources');
const sourceList = document.getElementById('source-list');
const answerMetadata = document.getElementById('answer-metadata');
const filtersDiv = document.getElementById('filters');
const settingsButton = document.getElementById('settings-button');
const modeSearchBtn = document.getElementById('mode-search');
const modeQABtn = document.getElementById('mode-qa');

let currentMode = 'search'; // 'search' or 'qa'
let currentFilter = 'all';
let debounceTimer = null;

// Load statistics on startup
loadStats();

// Refresh stats every 5 seconds
setInterval(() => {
  loadStats();
}, 5000);

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

// Mode selector
modeSearchBtn.addEventListener('click', () => {
  setMode('search');
});

modeQABtn.addEventListener('click', () => {
  setMode('qa');
});

function setMode(mode) {
  currentMode = mode;

  if (mode === 'search') {
    // Activate search mode
    modeSearchBtn.classList.add('active');
    modeQABtn.classList.remove('active');
    queryInput.placeholder = 'Search your browsing history...';
    answerContainer.style.display = 'none';
    resultsDiv.style.display = 'block';
  } else if (mode === 'qa') {
    // Activate Q&A mode
    modeQABtn.classList.add('active');
    modeSearchBtn.classList.remove('active');
    queryInput.placeholder = 'Ask a question about your history...';
    resultsDiv.style.display = 'none';
    answerContainer.style.display = 'block';
  }
}

async function performSearch() {
  const query = queryInput.value.trim();

  if (!query) {
    return;
  }

  if (currentMode === 'search') {
    // Search mode - semantic search
    resultsDiv.innerHTML = '<div class="loading">Searching...</div>';

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

      // Refresh stats after search
      loadStats();
    });

  } else if (currentMode === 'qa') {
    // Q&A mode - LLM-powered Q&A
    answerText.innerHTML = '<div class="loading"><span class="thinking-spinner"></span>Thinking...</div>';
    sourceList.innerHTML = '';
    answerMetadata.innerHTML = '';

    chrome.runtime.sendMessage({
      type: 'QUERY_LLM',
      query: query,
      filter: currentFilter
    }, (response) => {
      if (response && response.result) {
        displayAnswer(response.result);
      } else {
        answerText.innerHTML = `<div class="loading">❌ Error: ${response?.error || 'Unknown error'}</div>`;
      }

      // Refresh stats after query
      loadStats();
    });
  }
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

    // Metadata (timestamp, relevance, chunk info)
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

function displayAnswer(result) {
  // Display the LLM-generated answer
  answerText.textContent = result.answer || 'No answer generated.';

  // Display sources
  sourceList.innerHTML = '';

  if (result.sources && result.sources.length > 0) {
    answerSources.style.display = 'block';

    result.sources.forEach((source, i) => {
      const sourceItem = document.createElement('div');
      sourceItem.className = 'source-item';

      const title = document.createElement('div');
      title.className = 'source-title';
      title.textContent = `[${i + 1}] ${source.title || 'Untitled'}`;

      const url = document.createElement('div');
      url.className = 'source-url';
      url.textContent = source.url;

      sourceItem.appendChild(title);
      sourceItem.appendChild(url);

      // Click handler - open URL
      sourceItem.addEventListener('click', () => {
        chrome.tabs.create({ url: source.url });
      });

      sourceList.appendChild(sourceItem);
    });
  } else {
    answerSources.style.display = 'none';
  }

  // Display metadata (token usage, generation time, etc.)
  if (result.metadata) {
    const meta = result.metadata;
    const parts = [];

    if (meta.chunksUsed) {
      parts.push(`📊 ${meta.chunksUsed} sources`);
    }

    if (meta.tokensUsed && meta.tokensAvailable) {
      const percentUsed = Math.round((meta.tokensUsed / meta.tokensAvailable) * 100);
      parts.push(`🪙 ${meta.tokensUsed}/${meta.tokensAvailable} tokens (${percentUsed}%)`);
    }

    if (meta.generationTimeMs) {
      const seconds = (meta.generationTimeMs / 1000).toFixed(1);
      parts.push(`⏱️ ${seconds}s`);
    }

    if (!meta.llmReady) {
      parts.push('⚠️ LLM initializing');
    }

    answerMetadata.innerHTML = parts.join(' &nbsp;•&nbsp; ');
  }
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
