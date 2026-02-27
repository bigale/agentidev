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
const extractTableButton = document.getElementById('extract-table-button');
const extractResults = document.getElementById('extract-results');
const extractItemCount = document.getElementById('extract-item-count');
const extractStats = document.getElementById('extract-stats');
const extractPreview = document.getElementById('extract-preview');
const exportJSON = document.getElementById('export-json');
const exportJSONStructured = document.getElementById('export-json-structured');
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
const viewGrammarButton = document.getElementById('view-grammar-button');
const grammarViewer = document.getElementById('grammar-viewer');
const grammarContent = document.getElementById('grammar-content');
const grammarStatus = document.getElementById('grammar-status');
const clearGrammarCacheButton = document.getElementById('clear-grammar-cache-button');
const testGrammarButton = document.getElementById('test-grammar-button');
const grammarTestResult = document.getElementById('grammar-test-result');
const xmlOutputViewer = document.getElementById('xml-output-viewer');
const xmlOutputContent = document.getElementById('xml-output-content');
const debugHistoryViewer = document.getElementById('debug-history-viewer');
const debugHistoryContent = document.getElementById('debug-history-content');
const indexSpecButton = document.getElementById('index-spec-button');
const clearSpecButton = document.getElementById('clear-spec-button');
const specStatusText = document.getElementById('spec-status-text');
const xmlGetFieldsButton = document.getElementById('xml-get-fields-button');
const xmlHighlightButton = document.getElementById('xml-highlight-button');
const xmlClearHighlightsButton = document.getElementById('xml-clear-highlights-button');
const xmlFieldResults = document.getElementById('xml-field-results');
const xmlFieldList = document.getElementById('xml-field-list');
const xmlFieldTableBody = document.getElementById('xml-field-table-body');

// Automation mode elements
const modeAutomationBtn = document.getElementById('mode-automation');
const automationContainer = document.getElementById('automation-container');
const bridgeDot = document.getElementById('bridge-dot');
const bridgeStatusText = document.getElementById('bridge-status-text');
const bridgeConnectBtn = document.getElementById('bridge-connect-btn');
const autoNewSessionBtn = document.getElementById('auto-new-session-btn');
const autoSessionList = document.getElementById('auto-session-list');
const autoSnapshotBtn = document.getElementById('auto-snapshot-btn');
const autoNavigateBtn = document.getElementById('auto-navigate-btn');
const autoClickBtn = document.getElementById('auto-click-btn');
const autoFillBtn = document.getElementById('auto-fill-btn');
const autoCommandInput = document.getElementById('auto-command-input');
const autoSendBtn = document.getElementById('auto-send-btn');
const autoSnapshotViewer = document.getElementById('auto-snapshot-viewer');
const autoSnapshotInfo = document.getElementById('auto-snapshot-info');
const autoKnowledgeInput = document.getElementById('auto-knowledge-input');
const autoKnowledgeSearchBtn = document.getElementById('auto-knowledge-search-btn');
const autoKnowledgeResults = document.getElementById('auto-knowledge-results');

let currentMode = 'search'; // 'search', 'qa', 'extract', 'agent', or 'automation'
let currentFilter = 'all';
let debounceTimer = null;
let lastExtractionResults = null;
let currentXMLFields = null; // Phase 2.2 - XML UI Integration

// Load statistics on startup
loadStats();

// Check IXML spec index status on startup
checkSpecStatus();

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

modeAutomationBtn.addEventListener('click', () => {
  setMode('automation');
  checkBridgeStatus();
});

function setMode(mode) {
  currentMode = mode;

  // Deactivate all mode buttons
  modeSearchBtn.classList.remove('active');
  modeQABtn.classList.remove('active');
  modeExtractBtn.classList.remove('active');
  modeAgentBtn.classList.remove('active');
  modeAutomationBtn.classList.remove('active');

  // Hide all containers
  queryInput.style.display = 'none';
  filtersDiv.style.display = 'none';
  resultsDiv.style.display = 'none';
  answerContainer.style.display = 'none';
  extractContainer.style.display = 'none';
  agentContainer.style.display = 'none';
  automationContainer.style.display = 'none';

  if (mode === 'search') {
    modeSearchBtn.classList.add('active');
    queryInput.style.display = 'block';
    filtersDiv.style.display = 'flex';
    queryInput.placeholder = 'Search your browsing history...';
    resultsDiv.style.display = 'block';
  } else if (mode === 'qa') {
    modeQABtn.classList.add('active');
    queryInput.style.display = 'block';
    filtersDiv.style.display = 'flex';
    queryInput.placeholder = 'Ask a question about your history...';
    answerContainer.style.display = 'block';
  } else if (mode === 'extract') {
    modeExtractBtn.classList.add('active');
    extractContainer.style.display = 'block';
  } else if (mode === 'agent') {
    modeAgentBtn.classList.add('active');
    agentContainer.style.display = 'block';
  } else if (mode === 'automation') {
    modeAutomationBtn.classList.add('active');
    automationContainer.style.display = 'block';
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
    extractButton.textContent = '🕷️ Extract Now (LLM)';

    if (response && response.success) {
      lastExtractionResults = response;
      displayExtractionResults(response);
    } else {
      alert(`Extraction failed: ${response?.error || 'Unknown error'}`);
    }
  });
});

// Grammar-based table extraction (Phase 2.2)
extractTableButton.addEventListener('click', async () => {
  extractTableButton.disabled = true;
  extractTableButton.textContent = '⏳ Extracting tables...';
  extractResults.style.display = 'none';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'EXTRACT_TABLES_WITH_GRAMMAR'
    });

    extractTableButton.disabled = false;
    extractTableButton.textContent = '📊 Quick Extract Tables (Grammar)';

    if (response && response.success) {
      // Convert table data to extraction format
      lastExtractionResults = {
        success: true,
        items: response.allRows,
        pagesProcessed: 1,
        tokensUsed: 0,
        tokenBudget: { total: 0, used: 0, remaining: 0 },
        schema: response.schema
      };
      displayExtractionResults(lastExtractionResults);
    } else {
      alert(`Table extraction failed: ${response?.error || 'No tables found'}`);
    }
  } catch (error) {
    extractTableButton.disabled = false;
    extractTableButton.textContent = '📊 Quick Extract Tables (Grammar)';
    alert(`Error: ${error.message}`);
  }
});

// Agent fill button (Phase 2.0 MVP)
agentFillButton.addEventListener('click', async () => {
  const sourcePattern = agentSourceUrl.value.trim();
  const targetPattern = agentTargetUrl.value.trim();

  if (!targetPattern) {
    alert('Please enter target URL pattern');
    return;
  }

  try {
    // Show loading state
    agentFillButton.disabled = true;
    agentFillButton.textContent = '🤖 Working...';
    agentResults.style.display = 'none';

    // Find target tab
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let targetTabId = currentTab.id;

    // If target pattern specified and doesn't match current tab, try to find it
    if (targetPattern && !currentTab.url.includes(targetPattern)) {
      const tabs = await chrome.tabs.query({});
      const matchingTab = tabs.find(t => t.url.includes(targetPattern));
      if (matchingTab) {
        targetTabId = matchingTab.id;
      }
    }

    // Execute workflow
    const response = await chrome.runtime.sendMessage({
      type: 'EXECUTE_WORKFLOW',
      workflowType: sourcePattern && sourcePattern.includes('google') ? 'fill_with_google_data' : 'custom',
      targetTabId: targetTabId,
      options: {}
    });

    // Reset button state
    agentFillButton.disabled = false;
    agentFillButton.textContent = '🤖 Fill Form with Agent';
    agentResults.style.display = 'block';

    if (response && response.success) {
      const filledCount = Object.keys(response.filled || {}).length;
      const errorCount = (response.errors || []).length;

      agentStatus.innerHTML = `
        <div style="color: #1e8e3e; margin-bottom: 8px;">✅ Success!</div>
        <div style="font-size: 12px; color: #5f6368;">
          <div>✏️ Fields filled: ${filledCount}</div>
          ${errorCount > 0 ? `<div style="color: #ea8600;">⚠️ Errors: ${errorCount}</div>` : ''}
          <div style="margin-top: 8px; padding: 8px; background: #f1f3f4; border-radius: 4px;">
            <strong>Filled fields:</strong><br>
            ${Object.entries(response.filled || {}).map(([k, v]) => `• ${k}: ${v}`).join('<br>')}
          </div>
          ${errorCount > 0 ? `
            <div style="margin-top: 8px; padding: 8px; background: #fef7e0; border-radius: 4px; color: #ea8600;">
              <strong>Errors:</strong><br>
              ${response.errors.map(e => `• ${e.field || 'Unknown'}: ${e.error}`).join('<br>')}
            </div>
          ` : ''}
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

  } catch (error) {
    console.error('[Agent] Error:', error);
    agentFillButton.disabled = false;
    agentFillButton.textContent = '🤖 Fill Form with Agent';
    agentResults.style.display = 'block';
    agentStatus.innerHTML = `
      <div style="color: #d93025; margin-bottom: 8px;">❌ Error</div>
      <div style="font-size: 12px; color: #5f6368;">
        ${error.message}
      </div>
    `;
  }
});

// Grammar Viewer handlers (Phase 2.1)
viewGrammarButton.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      alert('No active tab found');
      return;
    }

    viewGrammarButton.disabled = true;
    viewGrammarButton.textContent = '⏳ Loading...';

    // Request grammar from background
    const response = await chrome.runtime.sendMessage({
      type: 'GET_GRAMMAR',
      tabId: tab.id,
      url: tab.url
    });

    viewGrammarButton.disabled = false;
    viewGrammarButton.textContent = '📋 View Grammar';

    if (response && response.success) {
      grammarViewer.style.display = 'block';
      grammarContent.textContent = response.grammar;
      grammarStatus.textContent = response.cached ? '✅ Cached' : '🆕 Generated';
      grammarStatus.style.color = response.cached ? '#1e8e3e' : '#8e44ad';
    } else {
      alert('Failed to load grammar: ' + (response?.error || 'Unknown error'));
    }

  } catch (error) {
    console.error('[Grammar Viewer] Error:', error);
    viewGrammarButton.disabled = false;
    viewGrammarButton.textContent = '📋 View Grammar';
    alert('Error: ' + error.message);
  }
});

clearGrammarCacheButton.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      return;
    }

    const domain = new URL(tab.url).hostname;

    if (!confirm(`Clear grammar cache for ${domain}?`)) {
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: 'CLEAR_GRAMMAR_CACHE',
      domain: domain
    });

    if (response && response.success) {
      grammarViewer.style.display = 'none';
      alert(`Cleared ${response.count || 0} cached grammars for ${domain}`);
    } else {
      alert('Failed to clear cache: ' + (response?.error || 'Unknown error'));
    }

  } catch (error) {
    console.error('[Grammar Viewer] Clear cache error:', error);
    alert('Error: ' + error.message);
  }
});

testGrammarButton.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      return;
    }

    testGrammarButton.disabled = true;
    testGrammarButton.textContent = '⏳ Testing...';
    grammarTestResult.style.display = 'none';

    const response = await chrome.runtime.sendMessage({
      type: 'TEST_GRAMMAR',
      tabId: tab.id
    });

    testGrammarButton.disabled = false;
    testGrammarButton.textContent = '✅ Test Grammar Parse';
    grammarTestResult.style.display = 'block';

    if (response && response.success) {
      const isIXML = response.method === 'ixml';
      const isFallback = response.method === 'fallback' || response.method === 'fields';

      grammarTestResult.innerHTML = `
        <div style="color: ${isIXML ? '#1e8e3e' : '#ea8600'}; font-weight: 500;">
          ${isIXML ? '✅ IXML Parse Success!' : '⚠️ Fallback Used'}
        </div>
        <div style="color: #5f6368; margin-top: 4px;">
          Method: <strong>${response.method || 'unknown'}</strong><br>
          Fields found: ${response.fieldCount || 0}<br>
          ${isFallback ? '<div style="color: #ea8600; margin-top: 4px;">⚠️ Using regex extraction (grammar failed)</div>' : ''}
          ${response.xmlOutput ? '<div style="margin-top: 4px;">📄 XML output available below</div>' : ''}
        </div>
      `;
      grammarTestResult.style.background = isIXML ? '#e6f4ea' : '#fef7e0';
      grammarTestResult.style.border = `1px solid ${isIXML ? '#1e8e3e' : '#ea8600'}`;
      grammarTestResult.style.padding = '8px';
      grammarTestResult.style.borderRadius = '4px';

      // Show XML output if available
      if (response.xmlOutput) {
        xmlOutputViewer.style.display = 'block';
        xmlOutputContent.textContent = response.xmlOutput;
      } else {
        xmlOutputViewer.style.display = 'none';
      }

      // Show debug history if available
      if (response.debugHistory && response.debugHistory.length > 0) {
        debugHistoryViewer.style.display = 'block';
        let historyHTML = '<div style="font-weight: 600; margin-bottom: 8px;">LLM Self-Debugging:</div>';
        response.debugHistory.forEach((entry, i) => {
          historyHTML += `
            <div style="margin-bottom: 8px; padding: 8px; background: white; border-radius: 4px;">
              <div style="font-weight: 600; color: #ea8600;">Attempt ${entry.attempt}:</div>
              <div style="margin-top: 4px;"><strong>Problem:</strong> ${entry.problem}</div>
              <div style="margin-top: 4px;"><strong>Fix:</strong> ${entry.fix}</div>
            </div>
          `;
        });
        debugHistoryContent.innerHTML = historyHTML;
      } else {
        debugHistoryViewer.style.display = 'none';
      }
    } else {
      grammarTestResult.innerHTML = `
        <div style="color: #d93025; font-weight: 500;">❌ Parse failed</div>
        <div style="color: #5f6368; margin-top: 4px;">
          ${response?.error || 'Unknown error'}
        </div>
      `;
      grammarTestResult.style.background = '#fce8e6';
      grammarTestResult.style.border = '1px solid #d93025';
      grammarTestResult.style.padding = '8px';
      grammarTestResult.style.borderRadius = '4px';
      xmlOutputViewer.style.display = 'none';
    }

  } catch (error) {
    console.error('[Grammar Viewer] Test error:', error);
    testGrammarButton.disabled = false;
    testGrammarButton.textContent = '✅ Test Grammar Parse';
    grammarTestResult.style.display = 'block';
    grammarTestResult.innerHTML = `
      <div style="color: #d93025;">Error: ${error.message}</div>
    `;
  }
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
  domResults.innerHTML = '<div style="color: #5f6368;">🔍 Vector search... → 🤖 LLM selection...</div>';

  // Use semantic finder (Phase 2: vector + LLM)
  chrome.runtime.sendMessage({
    type: 'FIND_ELEMENT',
    tabId: tab.id,
    intent: intent,
    options: { highlight: true }
  }, (response) => {
    domSearchButton.disabled = false;
    domSearchButton.textContent = '🎯 Find & Highlight';

    if (response && response.success) {
      const element = response.element;
      const method = response.method || 'unknown';

      // Method display
      const methodBadge = {
        'vector-only': '⚡ Vector (fast)',
        'llm-selection': '🤖 LLM Selection',
        'vector-fallback': '⚡ Vector (LLM failed)'
      }[method] || method;

      domResults.innerHTML = `
        <div style="color: #1e8e3e; margin-bottom: 8px;">✅ Found element!</div>
        <div style="background: #f1f3f4; padding: 8px; border-radius: 4px; margin-bottom: 8px;">
          <div style="font-weight: 600; margin-bottom: 4px;">Match:</div>
          <div style="font-size: 11px; color: #5f6368;">
            • ${element.tagName}${element.attributes?.type ? ` (${element.attributes.type})` : ''}: "${element.text || element.label || element.attributes?.placeholder || 'no label'}"
            • Confidence: ${(response.confidence * 100).toFixed(1)}%
            • Method: ${methodBadge}
            • Selector: <code style="background: #fff; padding: 2px 4px; display: block; margin-top: 4px; overflow-x: auto;">${response.selector}</code>
          </div>
        </div>
        ${response.llmReasoning ? `
          <div style="font-size: 11px; color: #5f6368; margin-bottom: 8px;">
            <div style="font-weight: 600; margin-bottom: 2px;">🤖 LLM reasoning:</div>
            <div style="background: #fff; padding: 6px; border-radius: 4px; border-left: 3px solid #1a73e8;">
              ${response.llmReasoning}
            </div>
          </div>
        ` : ''}
        <div style="margin-top: 8px; padding: 8px; background: #e8f0fe; border-radius: 4px; font-size: 11px; color: #1967d2;">
          💡 Element highlighted on page in yellow
        </div>
      `;
    } else {
      domResults.innerHTML = `
        <div style="color: #d93025;">❌ ${response?.error || 'No matches found'}</div>
        <div style="font-size: 11px; color: #5f6368;">
          Try indexing the page first, or use a different description.
        </div>
      `;
    }
  });
});

// XML Field Tester handlers (Phase 2.2)
xmlGetFieldsButton.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab) {
    xmlFieldResults.innerHTML = '<div style="color: #d93025;">❌ No active tab</div>';
    return;
  }

  xmlGetFieldsButton.disabled = true;
  xmlGetFieldsButton.textContent = '⏳ Getting fields...';
  xmlFieldResults.innerHTML = '<div style="color: #5f6368;">Requesting parsed fields...</div>';

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'GET_XML_FIELDS'
    });

    xmlGetFieldsButton.disabled = false;
    xmlGetFieldsButton.textContent = '📋 Get Parsed Fields';

    if (response && response.success) {
      currentXMLFields = response.fields;

      xmlFieldResults.innerHTML = `
        <div style="color: #1e8e3e; margin-bottom: 8px;">✅ Found ${response.count} fields</div>
        <div style="font-size: 11px; color: #5f6368;">
          • Method: <strong>${response.method}</strong>
          • Fields parsed successfully
        </div>
      `;

      // Show field list
      displayXMLFields(response.fields);

      // Show action buttons
      xmlHighlightButton.style.display = 'block';
      xmlClearHighlightsButton.style.display = 'block';

    } else {
      xmlFieldResults.innerHTML = `
        <div style="color: #d93025;">❌ ${response?.error || 'Failed to get fields'}</div>
        <div style="font-size: 11px; color: #5f6368;">
          The page may not have been parsed yet, or contains no forms.
        </div>
      `;
      xmlFieldList.style.display = 'none';
      xmlHighlightButton.style.display = 'none';
      xmlClearHighlightsButton.style.display = 'none';
    }
  } catch (error) {
    xmlGetFieldsButton.disabled = false;
    xmlGetFieldsButton.textContent = '📋 Get Parsed Fields';
    xmlFieldResults.innerHTML = `
      <div style="color: #d93025;">❌ Error: ${error.message}</div>
    `;
  }
});

xmlHighlightButton.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  xmlHighlightButton.disabled = true;
  xmlHighlightButton.textContent = '⏳ Highlighting...';

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'HIGHLIGHT_XML_FIELDS'
    });

    xmlHighlightButton.disabled = false;
    xmlHighlightButton.textContent = '🎯 Highlight All Fields';

    if (response && response.success) {
      const accuracy = ((response.foundCount / response.total) * 100).toFixed(1);

      xmlFieldResults.innerHTML = `
        <div style="color: #1e8e3e; margin-bottom: 8px;">
          ✅ Highlighted ${response.foundCount}/${response.total} fields (${accuracy}% accuracy)
        </div>
        ${response.missingCount > 0 ? `
          <div style="color: #ea8600; font-size: 11px; margin-top: 8px;">
            ⚠️ ${response.missingCount} selectors not found in DOM:
            <div style="background: #fef7e0; padding: 6px; border-radius: 4px; margin-top: 4px; font-family: monospace; max-height: 100px; overflow-y: auto;">
              ${response.missing.join('<br>')}
            </div>
          </div>
        ` : ''}
        <div style="margin-top: 8px; padding: 8px; background: #e8f0fe; border-radius: 4px; font-size: 11px; color: #1967d2;">
          💡 Fields highlighted in yellow on page
        </div>
      `;
    } else {
      xmlFieldResults.innerHTML = `
        <div style="color: #d93025;">❌ Failed to highlight: ${response?.error || 'Unknown error'}</div>
      `;
    }
  } catch (error) {
    xmlHighlightButton.disabled = false;
    xmlHighlightButton.textContent = '🎯 Highlight All Fields';
    xmlFieldResults.innerHTML = `
      <div style="color: #d93025;">❌ Error: ${error.message}</div>
    `;
  }
});

xmlClearHighlightsButton.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'CLEAR_HIGHLIGHTS'
    });

    xmlFieldResults.innerHTML = `
      <div style="color: #5f6368;">🧹 Highlights cleared</div>
    `;
  } catch (error) {
    console.error('Clear highlights error:', error);
  }
});

function displayXMLFields(fields) {
  xmlFieldList.style.display = 'block';

  xmlFieldTableBody.innerHTML = fields.map(field => `
    <tr style="border-bottom: 1px solid #e0e0e0;">
      <td style="padding: 4px;">${field.type}</td>
      <td style="padding: 4px; font-family: monospace; font-size: 10px; max-width: 150px; overflow: hidden; text-overflow: ellipsis;">${field.selector}</td>
      <td style="padding: 4px;">${field.name || field.id || '-'}</td>
      <td style="padding: 4px; color: #5f6368;">${field.grammarSource || '-'}</td>
    </tr>
  `).join('');
}

// Export handlers
exportJSON.addEventListener('click', () => {
  if (!lastExtractionResults) return;

  const json = JSON.stringify(lastExtractionResults.items, null, 2);
  downloadFile(json, 'extraction.json', 'application/json');
});

exportJSONStructured.addEventListener('click', () => {
  if (!lastExtractionResults || !lastExtractionResults.tables) return;

  const json = JSON.stringify(lastExtractionResults.tables, null, 2);
  downloadFile(json, 'extraction-by-table.json', 'application/json');
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

  if (currentMode === 'search' && currentFilter === 'structured') {
    // Structured data query mode
    resultsDiv.innerHTML = '<div class="loading">Searching structured data...</div>';

    // Parse field:value syntax from query
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

    // Extract domain filter from query
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
      loadStats();
    });

  } else if (currentMode === 'search') {
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

    // Keyword chips (show up to 5)
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

    // Assemble item
    item.appendChild(title);
    item.appendChild(url);
    item.appendChild(snippet);
    item.appendChild(meta);
    if (keywordChipsEl) {
      item.appendChild(keywordChipsEl);
    }

    // Click handler - open URL
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

  // Collect all unique headers and source pages
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

  // Summary
  const summary = document.createElement('div');
  summary.className = 'struct-results-summary';
  summary.textContent = `${records.length} records from ${sourceUrls.size} page${sourceUrls.size !== 1 ? 's' : ''}`;
  container.appendChild(summary);

  // Table
  if (allHeaders.length > 0) {
    const table = document.createElement('table');
    table.className = 'struct-results-table';

    // Header row
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const h of allHeaders) {
      const th = document.createElement('th');
      th.textContent = h;
      headerRow.appendChild(th);
    }
    // Source column
    const sourceTh = document.createElement('th');
    sourceTh.textContent = 'Source';
    headerRow.appendChild(sourceTh);
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Data rows
    const tbody = document.createElement('tbody');
    for (const record of records) {
      const tr = document.createElement('tr');
      for (const h of allHeaders) {
        const td = document.createElement('td');
        const val = record.fields[h];
        td.textContent = val !== undefined && val !== null ? String(val) : '';
        tr.appendChild(td);
      }
      // Source link
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

    // Wrap in scrollable div
    const tableWrap = document.createElement('div');
    tableWrap.style.overflowX = 'auto';
    tableWrap.style.maxHeight = '500px';
    tableWrap.style.overflowY = 'auto';
    tableWrap.appendChild(table);
    container.appendChild(tableWrap);
  } else {
    // Fallback: show as JSON
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
  if (results.tableCount) {
    stats.push(`📊 ${results.tableCount} tables`);
  }
  extractStats.innerHTML = stats.join(' &nbsp;•&nbsp; ');

  // Show structured export button if tables are available
  if (results.tables && results.tables.length > 0) {
    exportJSONStructured.style.display = 'inline-block';
  } else {
    exportJSONStructured.style.display = 'none';
  }

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

// IXML Spec Indexer handlers
async function checkSpecStatus() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_SPEC_STATUS'
    });

    if (response && response.indexed) {
      specStatusText.textContent = `✅ Indexed (${response.chunkCount} chunks, ${response.ageDays} days old)`;
      specStatusText.style.color = '#1e8e3e';
      clearSpecButton.style.display = 'block';
      indexSpecButton.textContent = '🔄 Re-index IXML Spec';
    } else {
      specStatusText.textContent = '❌ Not indexed';
      specStatusText.style.color = '#d93025';
      clearSpecButton.style.display = 'none';
      indexSpecButton.textContent = '📚 Index IXML Spec';
    }
  } catch (error) {
    console.error('[Spec Status] Error:', error);
    specStatusText.textContent = '⚠️ Error checking status';
  }
}

indexSpecButton.addEventListener('click', async () => {
  try {
    indexSpecButton.disabled = true;
    indexSpecButton.textContent = '⏳ Indexing...';
    specStatusText.textContent = 'Fetching and indexing specification...';

    const response = await chrome.runtime.sendMessage({
      type: 'INDEX_IXML_SPEC'
    });

    indexSpecButton.disabled = false;

    if (response && response.success) {
      if (response.cached) {
        alert(`IXML spec already indexed (${response.chunkCount} chunks)`);
      } else {
        alert(`✅ Successfully indexed IXML specification!\n\n${response.chunkCount} chunks indexed\n\nThe LLM will now consult the spec when generating grammars.`);
      }
      checkSpecStatus();
    } else {
      alert('Failed to index spec: ' + (response?.error || 'Unknown error'));
      indexSpecButton.textContent = '📚 Index IXML Spec';
      specStatusText.textContent = '❌ Indexing failed';
    }

  } catch (error) {
    console.error('[Index Spec] Error:', error);
    indexSpecButton.disabled = false;
    indexSpecButton.textContent = '📚 Index IXML Spec';
    alert('Error: ' + error.message);
  }
});

clearSpecButton.addEventListener('click', async () => {
  if (!confirm('Clear IXML spec index?\n\nYou can re-index it anytime.')) {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'CLEAR_SPEC_INDEX'
    });

    if (response && response.success) {
      alert('✅ Spec index cleared');
      checkSpecStatus();
    } else {
      alert('Failed to clear: ' + (response?.error || 'Unknown error'));
    }

  } catch (error) {
    console.error('[Clear Spec] Error:', error);
    alert('Error: ' + error.message);
  }
});

// ============================================================
// Automation Mode Handlers (Phase 2.5)
// ============================================================

let bridgeConnected = false;
let activeSessions = [];
let activeSessionId = null;

function checkBridgeStatus() {
  chrome.runtime.sendMessage({ type: 'BRIDGE_STATUS' }, (response) => {
    bridgeConnected = response?.connected || false;
    updateBridgeUI();
    if (bridgeConnected) {
      refreshSessions();
    }
  });
}

function updateBridgeUI() {
  bridgeDot.className = bridgeConnected ? 'bridge-dot connected' : 'bridge-dot';
  bridgeStatusText.textContent = bridgeConnected ? 'Connected' : 'Disconnected';
  bridgeConnectBtn.textContent = bridgeConnected ? 'Disconnect' : 'Connect';
  bridgeConnectBtn.style.background = bridgeConnected ? '#d93025' : '#1a73e8';

  // Enable/disable controls based on connection
  const connected = bridgeConnected;
  autoNewSessionBtn.disabled = !connected;
  autoSnapshotBtn.disabled = !connected || !activeSessionId;
  autoNavigateBtn.disabled = !connected || !activeSessionId;
  autoClickBtn.disabled = !connected || !activeSessionId;
  autoFillBtn.disabled = !connected || !activeSessionId;
  autoCommandInput.disabled = !connected || !activeSessionId;
  autoSendBtn.disabled = !connected || !activeSessionId;
}

// Bridge connect/disconnect
bridgeConnectBtn.addEventListener('click', async () => {
  if (bridgeConnected) {
    chrome.runtime.sendMessage({ type: 'BRIDGE_DISCONNECT' }, () => {
      bridgeConnected = false;
      activeSessions = [];
      activeSessionId = null;
      updateBridgeUI();
      autoSessionList.innerHTML = 'No sessions';
    });
  } else {
    bridgeConnectBtn.disabled = true;
    bridgeConnectBtn.textContent = 'Connecting...';
    chrome.runtime.sendMessage({ type: 'BRIDGE_CONNECT', port: 9876 }, (response) => {
      bridgeConnectBtn.disabled = false;
      if (response?.success) {
        bridgeConnected = true;
        updateBridgeUI();
        refreshSessions();
      } else {
        bridgeStatusText.textContent = `Error: ${response?.error || 'Failed'}`;
        bridgeConnectBtn.textContent = 'Connect';
      }
    });
  }
});

// New session
autoNewSessionBtn.addEventListener('click', async () => {
  const name = prompt('Session name:', `session_${activeSessions.length + 1}`);
  if (!name) return;

  autoNewSessionBtn.disabled = true;
  autoNewSessionBtn.textContent = 'Creating...';

  chrome.runtime.sendMessage({
    type: 'BRIDGE_CREATE_SESSION',
    name,
    options: {}
  }, (response) => {
    autoNewSessionBtn.disabled = false;
    autoNewSessionBtn.textContent = '+ New';

    if (response?.success && response.session) {
      activeSessionId = response.session.id;
      refreshSessions();
    } else {
      alert(`Failed: ${response?.error || 'Unknown error'}`);
    }
  });
});

function refreshSessions() {
  chrome.runtime.sendMessage({ type: 'BRIDGE_LIST_SESSIONS' }, (response) => {
    activeSessions = response?.sessions || [];
    renderSessions();
  });
}

function renderSessions() {
  if (activeSessions.length === 0) {
    autoSessionList.innerHTML = '<div style="color: #5f6368;">No active sessions</div>';
    activeSessionId = null;
    updateBridgeUI();
    return;
  }

  // Auto-select first session if none selected
  if (!activeSessionId && activeSessions.length > 0) {
    activeSessionId = activeSessions[0].id;
  }

  autoSessionList.innerHTML = activeSessions.map(s => `
    <div class="session-item" data-session-id="${s.id}" style="cursor: pointer; ${s.id === activeSessionId ? 'border-color: #1a73e8; border-width: 2px;' : ''}">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span class="session-name">${s.name}</span>
        <span class="session-state ${s.state}">${s.state}</span>
      </div>
      ${s.currentUrl ? `<div class="session-url">${s.currentUrl}</div>` : ''}
      ${s.hasSnapshot ? `<div style="font-size: 10px; color: #1e8e3e;">${s.snapshotLines} lines cached</div>` : ''}
    </div>
  `).join('');

  // Click handler for session selection
  autoSessionList.querySelectorAll('.session-item').forEach(el => {
    el.addEventListener('click', () => {
      activeSessionId = el.dataset.sessionId;
      renderSessions();
      updateBridgeUI();
    });
  });

  updateBridgeUI();
}

// Quick command buttons
autoSnapshotBtn.addEventListener('click', () => {
  if (!activeSessionId) return;
  autoSnapshotBtn.disabled = true;
  autoSnapshotBtn.textContent = 'Taking...';

  chrome.runtime.sendMessage({
    type: 'BRIDGE_TAKE_SNAPSHOT',
    sessionId: activeSessionId
  }, (response) => {
    autoSnapshotBtn.disabled = false;
    autoSnapshotBtn.textContent = 'Snapshot';

    if (response?.success && response.yaml) {
      autoSnapshotViewer.textContent = response.yaml;
      autoSnapshotInfo.textContent = `${response.lines} lines | ${new Date(response.timestamp).toLocaleTimeString()}`;
    } else {
      autoSnapshotViewer.textContent = `Error: ${response?.error || 'Failed'}`;
    }
  });
});

autoNavigateBtn.addEventListener('click', () => {
  const url = prompt('Navigate to URL:');
  if (!url || !activeSessionId) return;

  chrome.runtime.sendMessage({
    type: 'BRIDGE_NAVIGATE',
    sessionId: activeSessionId,
    url
  }, (response) => {
    if (response?.success) {
      autoSnapshotViewer.textContent = `Navigated to ${url}`;
      refreshSessions();
    } else {
      autoSnapshotViewer.textContent = `Navigate error: ${response?.error}`;
    }
  });
});

autoClickBtn.addEventListener('click', () => {
  const ref = prompt('Click element ref (e.g., e123):');
  if (!ref || !activeSessionId) return;

  chrome.runtime.sendMessage({
    type: 'BRIDGE_CLICK',
    sessionId: activeSessionId,
    ref
  }, (response) => {
    if (response?.success) {
      autoSnapshotViewer.textContent = `Clicked ${ref}\n${response.output || ''}`;
    } else {
      autoSnapshotViewer.textContent = `Click error: ${response?.error}`;
    }
  });
});

autoFillBtn.addEventListener('click', () => {
  const ref = prompt('Element ref to fill (e.g., e123):');
  if (!ref || !activeSessionId) return;
  const value = prompt('Value to fill:');
  if (value === null) return;

  chrome.runtime.sendMessage({
    type: 'BRIDGE_FILL',
    sessionId: activeSessionId,
    ref,
    value
  }, (response) => {
    if (response?.success) {
      autoSnapshotViewer.textContent = `Filled ${ref} with "${value}"\n${response.output || ''}`;
    } else {
      autoSnapshotViewer.textContent = `Fill error: ${response?.error}`;
    }
  });
});

// Generic command / natural language input
autoSendBtn.addEventListener('click', sendAutoCommand);
autoCommandInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendAutoCommand();
});

function sendAutoCommand() {
  const input = autoCommandInput.value.trim();
  if (!input || !activeSessionId) return;

  autoSendBtn.disabled = true;
  autoSendBtn.textContent = '...';

  // Check if it looks like a raw command (starts with goto, click, fill, snapshot, evaluate)
  const isRawCommand = /^(goto|click|fill|snapshot|evaluate|select|type|press|hover|scroll)\s/i.test(input);

  if (isRawCommand) {
    // Send as raw bridge command
    chrome.runtime.sendMessage({
      type: 'BRIDGE_SEND_COMMAND',
      sessionId: activeSessionId,
      command: input
    }, (response) => {
      autoSendBtn.disabled = false;
      autoSendBtn.textContent = 'Send';
      autoCommandInput.value = '';

      if (response?.success) {
        autoSnapshotViewer.textContent = response.output || 'Command executed';
      } else {
        autoSnapshotViewer.textContent = `Error: ${response?.error}`;
      }
    });
  } else {
    // Route to automation reasoning (natural language intent)
    chrome.runtime.sendMessage({
      type: 'AUTOMATION_REASON',
      intent: input,
      sessionId: activeSessionId
    }, (response) => {
      autoSendBtn.disabled = false;
      autoSendBtn.textContent = 'Send';
      autoCommandInput.value = '';

      if (response?.success) {
        const output = [];
        if (response.message) output.push(response.message);
        if (response.commands && response.commands.length > 0) {
          output.push('\nCommands:');
          response.commands.forEach((cmd, i) => {
            output.push(`  ${i + 1}. ${cmd.type} ${cmd.ref || cmd.url || cmd.value || ''}`);
            if (cmd.reasoning) output.push(`     -> ${cmd.reasoning}`);
          });
        }
        autoSnapshotViewer.textContent = output.join('\n');
      } else {
        autoSnapshotViewer.textContent = `Error: ${response?.error}`;
      }
    });
  }
}

// Page Knowledge search
autoKnowledgeSearchBtn.addEventListener('click', searchPageKnowledge);
autoKnowledgeInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') searchPageKnowledge();
});

function searchPageKnowledge() {
  const query = autoKnowledgeInput.value.trim();
  if (!query) return;

  autoKnowledgeSearchBtn.disabled = true;
  autoKnowledgeSearchBtn.textContent = '...';

  chrome.runtime.sendMessage({
    type: 'SNAPSHOT_SEARCH',
    query,
    options: { limit: 5 }
  }, (response) => {
    autoKnowledgeSearchBtn.disabled = false;
    autoKnowledgeSearchBtn.textContent = 'Search';

    if (response?.success && response.results?.length > 0) {
      autoKnowledgeResults.innerHTML = response.results.map(r => `
        <div class="snapshot-search-result">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <span style="font-weight: 600; color: #202124;">${r.sectionType}</span>
            <span class="score">${Math.round(r.score * 100)}%</span>
          </div>
          <div style="font-size: 11px; color: #5f6368; margin-bottom: 4px;">${r.textDescription}</div>
          ${r.isStablePattern ? '<div style="font-size: 10px; color: #1e8e3e;">Stable pattern</div>' : ''}
          <div style="font-size: 10px; color: #70757a;">${r.track || ''} ${r.race ? 'R' + r.race : ''} | ${new Date(r.timestamp).toLocaleString()}</div>
        </div>
      `).join('');
    } else {
      autoKnowledgeResults.innerHTML = `<div style="color: #5f6368;">No cached snapshots match "${query}"</div>`;
    }
  });
}
