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
const extractContainer = document.getElementById('extract-container');
const extractTemplate = document.getElementById('extract-template');
const extractPrompt = document.getElementById('extract-prompt');
const extractPagination = document.getElementById('extract-pagination');
const extractMaxPages = document.getElementById('extract-max-pages');
const extractButton = document.getElementById('extract-button');
const extractResults = document.getElementById('extract-results');
const extractItemCount = document.getElementById('extract-item-count');
const extractStats = document.getElementById('extract-stats');
const extractPreview = document.getElementById('extract-preview');
const exportJSON = document.getElementById('export-json');
const exportCSV = document.getElementById('export-csv');
const filtersDiv = document.getElementById('filters');
const settingsButton = document.getElementById('settings-button');
const modeSearchBtn = document.getElementById('mode-search');
const modeQABtn = document.getElementById('mode-qa');
const modeExtractBtn = document.getElementById('mode-extract');
const modeAgentBtn = document.getElementById('mode-agent');
const agentContainer = document.getElementById('agent-container');
const agentSourceUrl = document.getElementById('agent-source-url');
const agentTargetUrl = document.getElementById('agent-target-url');
const agentFillButton = document.getElementById('agent-fill-button');
const agentResults = document.getElementById('agent-results');
const agentStatus = document.getElementById('agent-status');
const domIndexButton = document.getElementById('dom-index-button');
const domSearchInput = document.getElementById('dom-search-input');
const domSearchButton = document.getElementById('dom-search-button');
const domResults = document.getElementById('dom-results');

let currentMode = 'search'; // 'search', 'qa', 'extract', or 'agent'
let currentFilter = 'all';
let debounceTimer = null;
let lastExtractionResults = null;

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

// Optional: Search as you type (debounced - 7 second delay)
queryInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (queryInput.value.trim().length > 3) {
      performSearch();
    }
  }, 7000);
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

modeExtractBtn.addEventListener('click', () => {
  setMode('extract');
});

modeAgentBtn.addEventListener('click', () => {
  setMode('agent');
});

function setMode(mode) {
  currentMode = mode;

  if (mode === 'search') {
    // Activate search mode
    modeSearchBtn.classList.add('active');
    modeQABtn.classList.remove('active');
    modeExtractBtn.classList.remove('active');
    modeAgentBtn.classList.remove('active');
    queryInput.style.display = 'block';
    filtersDiv.style.display = 'flex';
    queryInput.placeholder = 'Search your browsing history...';
    answerContainer.style.display = 'none';
    extractContainer.style.display = 'none';
    agentContainer.style.display = 'none';
    resultsDiv.style.display = 'block';
  } else if (mode === 'qa') {
    // Activate Q&A mode
    modeQABtn.classList.add('active');
    modeSearchBtn.classList.remove('active');
    modeExtractBtn.classList.remove('active');
    modeAgentBtn.classList.remove('active');
    queryInput.style.display = 'block';
    filtersDiv.style.display = 'flex';
    queryInput.placeholder = 'Ask a question about your history...';
    resultsDiv.style.display = 'none';
    extractContainer.style.display = 'none';
    agentContainer.style.display = 'none';
    answerContainer.style.display = 'block';
  } else if (mode === 'extract') {
    // Activate Extract mode
    modeExtractBtn.classList.add('active');
    modeSearchBtn.classList.remove('active');
    modeQABtn.classList.remove('active');
    modeAgentBtn.classList.remove('active');
    queryInput.style.display = 'none';
    filtersDiv.style.display = 'none';
    resultsDiv.style.display = 'none';
    answerContainer.style.display = 'none';
    extractContainer.style.display = 'block';
    agentContainer.style.display = 'none';
  } else if (mode === 'agent') {
    // Activate Agent mode
    modeAgentBtn.classList.add('active');
    modeSearchBtn.classList.remove('active');
    modeQABtn.classList.remove('active');
    modeExtractBtn.classList.remove('active');
    queryInput.style.display = 'none';
    filtersDiv.style.display = 'none';
    resultsDiv.style.display = 'none';
    answerContainer.style.display = 'none';
    extractContainer.style.display = 'none';
    agentContainer.style.display = 'block';
  }
}

// Template selection
extractTemplate.addEventListener('change', (e) => {
  const templateId = e.target.value;

  // Update prompt based on template
  const templates = {
    'products': 'Extract all products with title, price, currency, rating, review count, image URL, and product URL',
    'jobs': 'Extract all job listings with title, company, location, salary, job type, posted date, and apply URL',
    'articles': 'Extract all articles with headline, author, publish date, summary, full text, and article URL',
    'events': 'Extract all events with title, date, time, location, venue, price, and event URL',
    'properties': 'Extract all properties with address, price, bedrooms, bathrooms, square footage, and listing URL',
    'contacts': 'Extract all contacts with name, email, phone, company, title, and address',
    'reviews': 'Extract all reviews with reviewer name, rating, review text, date, and helpful count',
    'table': 'Extract all data from the table on this page',
    'custom': ''
  };

  extractPrompt.value = templates[templateId] || '';
  extractPrompt.disabled = templateId !== 'custom';
});

// Extract button
extractButton.addEventListener('click', async () => {
  const prompt = extractPrompt.value.trim();

  if (!prompt) {
    alert('Please enter an extraction prompt');
    return;
  }

  // Show loading state
  extractButton.disabled = true;
  extractButton.textContent = '🕷️ Extracting...';
  extractResults.style.display = 'none';

  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Send extraction request
  chrome.runtime.sendMessage({
    type: 'EXTRACT',
    tabId: tab.id,
    prompt: prompt,
    options: {
      followPagination: extractPagination.checked,
      maxPages: parseInt(extractMaxPages.value) || 10
    }
  }, (response) => {
    extractButton.disabled = false;
    extractButton.textContent = '🕷️ Extract Now';

    if (response && response.success) {
      lastExtractionResults = response;
      displayExtractionResults(response);
    } else {
      alert(`Extraction failed: ${response?.error || 'Unknown error'}`);
    }
  });
});

// Agent fill button
agentFillButton.addEventListener('click', async () => {
  const sourceUrl = agentSourceUrl.value.trim();
  const targetUrl = agentTargetUrl.value.trim();

  if (!sourceUrl || !targetUrl) {
    alert('Please enter both source and target URLs');
    return;
  }

  // Show loading state
  agentFillButton.disabled = true;
  agentFillButton.textContent = '🤖 Working...';
  agentResults.style.display = 'none';

  // Send agent fill request
  chrome.runtime.sendMessage({
    type: 'AGENT_FILL_FORM',
    sourceUrl: sourceUrl,
    targetUrl: targetUrl
  }, (response) => {
    agentFillButton.disabled = false;
    agentFillButton.textContent = '🤖 Fill Form with Agent';

    agentResults.style.display = 'block';

    if (response && response.success) {
      agentStatus.innerHTML = `
        <div style="color: #1e8e3e; margin-bottom: 8px;">✅ Success!</div>
        <div style="font-size: 12px; color: #5f6368;">
          <div>📊 Fields mapped: ${response.fieldsMapped || 0}</div>
          <div>✏️ Fields filled: ${response.fieldsFilled || 0}</div>
          <div style="margin-top: 8px; padding: 8px; background: #f1f3f4; border-radius: 4px;">
            ${response.message || 'Form filled successfully'}
          </div>
        </div>
      `;
    } else {
      agentStatus.innerHTML = `
        <div style="color: #d93025; margin-bottom: 8px;">❌ Failed</div>
        <div style="font-size: 12px; color: #5f6368;">
          ${response?.error || 'Unknown error occurred'}
        </div>
      `;
    }
  });
});

// DOM Indexing button handler
domIndexButton.addEventListener('click', async () => {
  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab) {
    domResults.innerHTML = '<div style="color: #d93025;">❌ No active tab found</div>';
    return;
  }

  domIndexButton.disabled = true;
  domIndexButton.textContent = '⏳ Indexing...';
  domResults.innerHTML = '<div style="color: #5f6368;">Extracting DOM structure...</div>';

  // Index current tab's DOM
  chrome.runtime.sendMessage({
    type: 'INDEX_DOM',
    tabId: tab.id
  }, (response) => {
    domIndexButton.disabled = false;
    domIndexButton.textContent = '📑 Index Current Page';

    if (response && response.success) {
      domResults.innerHTML = `
        <div style="color: #1e8e3e; margin-bottom: 4px;">✅ Indexed successfully!</div>
        <div style="font-size: 11px; color: #5f6368;">
          • ${response.count} elements indexed
          • Completed in ${response.elapsed}ms
          • Collection: ${response.collection}
        </div>
      `;
    } else {
      domResults.innerHTML = `
        <div style="color: #d93025;">❌ Indexing failed</div>
        <div style="font-size: 11px; color: #5f6368;">${response?.error || 'Unknown error'}</div>
      `;
    }
  });
});

// DOM Search button handler
domSearchButton.addEventListener('click', async () => {
  const intent = domSearchInput.value.trim();

  if (!intent) {
    domResults.innerHTML = '<div style="color: #d93025;">Please enter a description</div>';
    return;
  }

  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab) {
    domResults.innerHTML = '<div style="color: #d93025;">❌ No active tab found</div>';
    return;
  }

  domSearchButton.disabled = true;
  domSearchButton.textContent = '⏳ Searching...';
  domResults.innerHTML = '<div style="color: #5f6368;">Searching DOM...</div>';

  // Search DOM for intent
  chrome.runtime.sendMessage({
    type: 'SEARCH_DOM',
    tabId: tab.id,
    intent: intent,
    options: { topK: 5, highlight: true }
  }, (response) => {
    domSearchButton.disabled = false;
    domSearchButton.textContent = '🎯 Find & Highlight';

    if (response && response.results && response.results.length > 0) {
      const topMatch = response.results[0];

      domResults.innerHTML = `
        <div style="color: #1e8e3e; margin-bottom: 8px;">✅ Found ${response.results.length} matches!</div>
        <div style="background: #f1f3f4; padding: 8px; border-radius: 4px; margin-bottom: 8px;">
          <div style="font-weight: 600; margin-bottom: 4px;">Top match:</div>
          <div style="font-size: 11px; color: #5f6368;">
            • ${topMatch.tagName}: "${topMatch.text || topMatch.label}"
            • Confidence: ${(topMatch.score * 100).toFixed(1)}%
            • Selector: <code style="background: #fff; padding: 2px 4px;">${topMatch.selector}</code>
          </div>
        </div>
        ${response.results.length > 1 ? `
          <div style="font-size: 11px; color: #5f6368;">
            Other matches: ${response.results.slice(1).map(r =>
              `${r.tagName} (${(r.score * 100).toFixed(0)}%)`
            ).join(', ')}
          </div>
        ` : ''}
        <div style="margin-top: 8px; padding: 8px; background: #e8f0fe; border-radius: 4px; font-size: 11px; color: #1967d2;">
          💡 Element highlighted on page in yellow
        </div>
      `;
    } else {
      domResults.innerHTML = `
        <div style="color: #d93025;">❌ No matches found</div>
        <div style="font-size: 11px; color: #5f6368;">
          Try indexing the page first, or use a different description.
        </div>
      `;
    }
  });
});

// Export handlers
exportJSON.addEventListener('click', () => {
  if (!lastExtractionResults) return;

  const json = JSON.stringify(lastExtractionResults.items, null, 2);
  downloadFile(json, 'extraction.json', 'application/json');
});

exportCSV.addEventListener('click', () => {
  if (!lastExtractionResults || !lastExtractionResults.schema) return;

  const csv = itemsToCSV(lastExtractionResults.items, lastExtractionResults.schema);
  downloadFile(csv, 'extraction.csv', 'text/csv');
});

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

function displayExtractionResults(results) {
  // Show results container
  extractResults.style.display = 'block';

  // Update item count
  extractItemCount.textContent = results.items?.length || 0;

  // Display stats
  const stats = [];
  if (results.pagesProcessed) {
    stats.push(`📄 ${results.pagesProcessed} pages`);
  }
  if (results.tokensUsed && results.tokenBudget) {
    const percentUsed = Math.round((results.tokensUsed / results.tokenBudget.total) * 100);
    stats.push(`🪙 ${results.tokensUsed}/${results.tokenBudget.total} tokens (${percentUsed}%)`);
  }
  extractStats.innerHTML = stats.join(' &nbsp;•&nbsp; ');

  // Display preview
  const preview = JSON.stringify(results.items, null, 2);
  extractPreview.textContent = preview;
}

function itemsToCSV(items, schema) {
  if (!items || items.length === 0 || !schema || !schema.fields) {
    return '';
  }

  // Header row
  const headers = schema.fields.map(f => f.name);
  let csv = headers.join(',') + '\n';

  // Data rows
  items.forEach(item => {
    const row = headers.map(header => {
      const value = item[header];
      if (value === null || value === undefined) return '';

      // Escape quotes and wrap in quotes if contains comma or quote
      const strValue = String(value);
      if (strValue.includes(',') || strValue.includes('"') || strValue.includes('\n')) {
        return '"' + strValue.replace(/"/g, '""') + '"';
      }
      return strValue;
    });
    csv += row.join(',') + '\n';
  });

  return csv;
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
