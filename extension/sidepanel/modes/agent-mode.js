/**
 * Agent mode — form filling, DOM indexing, grammar viewer, XML field tester.
 * Extracted from sidepanel.js lines 307-1370.
 */

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

let currentXMLFields = null;

export function init() {
  // Agent fill button
  agentFillButton.addEventListener('click', handleAgentFill);

  // Grammar Viewer
  viewGrammarButton.addEventListener('click', handleViewGrammar);
  clearGrammarCacheButton.addEventListener('click', handleClearGrammarCache);
  testGrammarButton.addEventListener('click', handleTestGrammar);

  // DOM Indexing
  domIndexButton.addEventListener('click', handleDOMIndex);
  domSearchButton.addEventListener('click', handleDOMSearch);

  // XML Field Tester
  xmlGetFieldsButton.addEventListener('click', handleGetXMLFields);
  xmlHighlightButton.addEventListener('click', handleHighlightFields);
  xmlClearHighlightsButton.addEventListener('click', handleClearHighlights);

  // IXML Spec Indexer
  indexSpecButton.addEventListener('click', handleIndexSpec);
  clearSpecButton.addEventListener('click', handleClearSpec);

  // Check IXML spec status on startup
  checkSpecStatus();
}

// ---- Agent Form Fill ----

async function handleAgentFill() {
  const sourcePattern = agentSourceUrl.value.trim();
  const targetPattern = agentTargetUrl.value.trim();

  if (!targetPattern) { alert('Please enter target URL pattern'); return; }

  try {
    agentFillButton.disabled = true;
    agentFillButton.textContent = '🤖 Working...';
    agentResults.style.display = 'none';

    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let targetTabId = currentTab.id;

    if (targetPattern && !currentTab.url.includes(targetPattern)) {
      const tabs = await chrome.tabs.query({});
      const matchingTab = tabs.find(t => t.url.includes(targetPattern));
      if (matchingTab) targetTabId = matchingTab.id;
    }

    const response = await chrome.runtime.sendMessage({
      type: 'EXECUTE_WORKFLOW',
      workflowType: sourcePattern && sourcePattern.includes('google') ? 'fill_with_google_data' : 'custom',
      targetTabId: targetTabId,
      options: {}
    });

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
        <div style="font-size: 12px; color: #5f6368;">${response?.error || 'Unknown error occurred'}</div>
      `;
    }
  } catch (error) {
    console.error('[Agent] Error:', error);
    agentFillButton.disabled = false;
    agentFillButton.textContent = '🤖 Fill Form with Agent';
    agentResults.style.display = 'block';
    agentStatus.innerHTML = `
      <div style="color: #d93025; margin-bottom: 8px;">❌ Error</div>
      <div style="font-size: 12px; color: #5f6368;">${error.message}</div>
    `;
  }
}

// ---- Grammar Viewer ----

async function handleViewGrammar() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { alert('No active tab found'); return; }

    viewGrammarButton.disabled = true;
    viewGrammarButton.textContent = '⏳ Loading...';

    const response = await chrome.runtime.sendMessage({ type: 'GET_GRAMMAR', tabId: tab.id, url: tab.url });

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
}

async function handleClearGrammarCache() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const domain = new URL(tab.url).hostname;
    if (!confirm(`Clear grammar cache for ${domain}?`)) return;

    const response = await chrome.runtime.sendMessage({ type: 'CLEAR_GRAMMAR_CACHE', domain });

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
}

async function handleTestGrammar() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    testGrammarButton.disabled = true;
    testGrammarButton.textContent = '⏳ Testing...';
    grammarTestResult.style.display = 'none';

    const response = await chrome.runtime.sendMessage({ type: 'TEST_GRAMMAR', tabId: tab.id });

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

      if (response.xmlOutput) {
        xmlOutputViewer.style.display = 'block';
        xmlOutputContent.textContent = response.xmlOutput;
      } else {
        xmlOutputViewer.style.display = 'none';
      }

      if (response.debugHistory && response.debugHistory.length > 0) {
        debugHistoryViewer.style.display = 'block';
        let historyHTML = '<div style="font-weight: 600; margin-bottom: 8px;">LLM Self-Debugging:</div>';
        response.debugHistory.forEach((entry) => {
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
        <div style="color: #5f6368; margin-top: 4px;">${response?.error || 'Unknown error'}</div>
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
    grammarTestResult.innerHTML = `<div style="color: #d93025;">Error: ${error.message}</div>`;
  }
}

// ---- DOM Indexing ----

async function handleDOMIndex() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { domResults.innerHTML = '<div style="color: #d93025;">❌ No active tab found</div>'; return; }

  domIndexButton.disabled = true;
  domIndexButton.textContent = '⏳ Indexing...';
  domResults.innerHTML = '<div style="color: #5f6368;">Extracting DOM structure...</div>';

  chrome.runtime.sendMessage({ type: 'INDEX_DOM', tabId: tab.id }, (response) => {
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
}

async function handleDOMSearch() {
  const intent = domSearchInput.value.trim();
  if (!intent) { domResults.innerHTML = '<div style="color: #d93025;">Please enter a description</div>'; return; }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { domResults.innerHTML = '<div style="color: #d93025;">❌ No active tab found</div>'; return; }

  domSearchButton.disabled = true;
  domSearchButton.textContent = '⏳ Searching...';
  domResults.innerHTML = '<div style="color: #5f6368;">🔍 Vector search... → 🤖 LLM selection...</div>';

  chrome.runtime.sendMessage({
    type: 'FIND_ELEMENT', tabId: tab.id, intent, options: { highlight: true }
  }, (response) => {
    domSearchButton.disabled = false;
    domSearchButton.textContent = '🎯 Find & Highlight';

    if (response && response.success) {
      const element = response.element;
      const method = response.method || 'unknown';
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
            <div style="background: #fff; padding: 6px; border-radius: 4px; border-left: 3px solid #1a73e8;">${response.llmReasoning}</div>
          </div>
        ` : ''}
        <div style="margin-top: 8px; padding: 8px; background: #e8f0fe; border-radius: 4px; font-size: 11px; color: #1967d2;">
          💡 Element highlighted on page in yellow
        </div>
      `;
    } else {
      domResults.innerHTML = `
        <div style="color: #d93025;">❌ ${response?.error || 'No matches found'}</div>
        <div style="font-size: 11px; color: #5f6368;">Try indexing the page first, or use a different description.</div>
      `;
    }
  });
}

// ---- XML Field Tester ----

async function handleGetXMLFields() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { xmlFieldResults.innerHTML = '<div style="color: #d93025;">❌ No active tab</div>'; return; }

  xmlGetFieldsButton.disabled = true;
  xmlGetFieldsButton.textContent = '⏳ Getting fields...';
  xmlFieldResults.innerHTML = '<div style="color: #5f6368;">Requesting parsed fields...</div>';

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_XML_FIELDS' });

    xmlGetFieldsButton.disabled = false;
    xmlGetFieldsButton.textContent = '📋 Get Parsed Fields';

    if (response && response.success) {
      currentXMLFields = response.fields;
      xmlFieldResults.innerHTML = `
        <div style="color: #1e8e3e; margin-bottom: 8px;">✅ Found ${response.count} fields</div>
        <div style="font-size: 11px; color: #5f6368;">• Method: <strong>${response.method}</strong>• Fields parsed successfully</div>
      `;
      displayXMLFields(response.fields);
      xmlHighlightButton.style.display = 'block';
      xmlClearHighlightsButton.style.display = 'block';
    } else {
      xmlFieldResults.innerHTML = `
        <div style="color: #d93025;">❌ ${response?.error || 'Failed to get fields'}</div>
        <div style="font-size: 11px; color: #5f6368;">The page may not have been parsed yet, or contains no forms.</div>
      `;
      xmlFieldList.style.display = 'none';
      xmlHighlightButton.style.display = 'none';
      xmlClearHighlightsButton.style.display = 'none';
    }
  } catch (error) {
    xmlGetFieldsButton.disabled = false;
    xmlGetFieldsButton.textContent = '📋 Get Parsed Fields';
    xmlFieldResults.innerHTML = `<div style="color: #d93025;">❌ Error: ${error.message}</div>`;
  }
}

async function handleHighlightFields() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  xmlHighlightButton.disabled = true;
  xmlHighlightButton.textContent = '⏳ Highlighting...';

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'HIGHLIGHT_XML_FIELDS' });

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
      xmlFieldResults.innerHTML = `<div style="color: #d93025;">❌ Failed to highlight: ${response?.error || 'Unknown error'}</div>`;
    }
  } catch (error) {
    xmlHighlightButton.disabled = false;
    xmlHighlightButton.textContent = '🎯 Highlight All Fields';
    xmlFieldResults.innerHTML = `<div style="color: #d93025;">❌ Error: ${error.message}</div>`;
  }
}

async function handleClearHighlights() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_HIGHLIGHTS' });
    xmlFieldResults.innerHTML = `<div style="color: #5f6368;">🧹 Highlights cleared</div>`;
  } catch (error) {
    console.error('Clear highlights error:', error);
  }
}

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

// ---- IXML Spec Indexer ----

async function checkSpecStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_SPEC_STATUS' });
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

async function handleIndexSpec() {
  try {
    indexSpecButton.disabled = true;
    indexSpecButton.textContent = '⏳ Indexing...';
    specStatusText.textContent = 'Fetching and indexing specification...';

    const response = await chrome.runtime.sendMessage({ type: 'INDEX_IXML_SPEC' });
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
}

async function handleClearSpec() {
  if (!confirm('Clear IXML spec index?\n\nYou can re-index it anytime.')) return;

  try {
    const response = await chrome.runtime.sendMessage({ type: 'CLEAR_SPEC_INDEX' });
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
}
