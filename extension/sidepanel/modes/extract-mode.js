/**
 * Extract mode — web scraping with LLM and grammar-based extraction.
 * Extracted from sidepanel.js extraction controls/results.
 */

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

let lastExtractionResults = null;

export function init() {
  // Template selection
  extractTemplate.addEventListener('change', (e) => {
    const templateId = e.target.value;
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

  // Extract button (LLM)
  extractButton.addEventListener('click', async () => {
    const prompt = extractPrompt.value.trim();
    if (!prompt) { alert('Please enter an extraction prompt'); return; }

    extractButton.disabled = true;
    extractButton.textContent = '🕷️ Extracting...';
    extractResults.style.display = 'none';

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

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

  // Grammar-based table extraction
  extractTableButton.addEventListener('click', async () => {
    extractTableButton.disabled = true;
    extractTableButton.textContent = '⏳ Extracting tables...';
    extractResults.style.display = 'none';

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_TABLES_WITH_GRAMMAR' });

      extractTableButton.disabled = false;
      extractTableButton.textContent = '📊 Quick Extract Tables (Grammar)';

      if (response && response.success) {
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
}

function displayExtractionResults(results) {
  extractResults.style.display = 'block';
  extractItemCount.textContent = results.items?.length || 0;

  const stats = [];
  if (results.pagesProcessed) stats.push(`📄 ${results.pagesProcessed} pages`);
  if (results.tokensUsed && results.tokenBudget) {
    const percentUsed = Math.round((results.tokensUsed / results.tokenBudget.total) * 100);
    stats.push(`🪙 ${results.tokensUsed}/${results.tokenBudget.total} tokens (${percentUsed}%)`);
  }
  if (results.tableCount) stats.push(`📊 ${results.tableCount} tables`);
  extractStats.innerHTML = stats.join(' &nbsp;•&nbsp; ');

  if (results.tables && results.tables.length > 0) {
    exportJSONStructured.style.display = 'inline-block';
  } else {
    exportJSONStructured.style.display = 'none';
  }

  extractPreview.textContent = JSON.stringify(results.items, null, 2);
}

function itemsToCSV(items, schema) {
  if (!items || items.length === 0 || !schema || !schema.fields) return '';

  const headers = schema.fields.map(f => f.name);
  let csv = headers.join(',') + '\n';

  items.forEach(item => {
    const row = headers.map(header => {
      const value = item[header];
      if (value === null || value === undefined) return '';
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
