/**
 * Popup UI for Contextual Recall
 */

const queryInput = document.getElementById('query-input');
const searchButton = document.getElementById('search-button');
const resultsDiv = document.getElementById('results');
const statsDiv = document.getElementById('stats');

// Load statistics
loadStats();

// Search on button click
searchButton.addEventListener('click', performSearch);

// Search on Enter key
queryInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    performSearch();
  }
});

async function performSearch() {
  const query = queryInput.value.trim();

  if (!query) {
    return;
  }

  // Show loading
  resultsDiv.innerHTML = '<div class="loading">Searching...</div>';

  // Send query to background worker
  chrome.runtime.sendMessage({
    type: 'QUERY',
    query: query
  }, (response) => {
    displayResults(response.results);
  });
}

function displayResults(results) {
  if (!results || results.length === 0) {
    resultsDiv.innerHTML = '<div class="loading">No results found. Try a different query.</div>';
    return;
  }

  resultsDiv.innerHTML = '';

  results.forEach(result => {
    const item = document.createElement('div');
    item.className = 'result-item';

    const title = document.createElement('div');
    title.className = 'result-title';
    title.textContent = result.title;

    const snippet = document.createElement('div');
    snippet.className = 'result-snippet';
    snippet.textContent = result.snippet;

    item.appendChild(title);
    item.appendChild(snippet);

    item.addEventListener('click', () => {
      // Open the URL in a new tab
      chrome.tabs.create({ url: result.url });
    });

    resultsDiv.appendChild(item);
  });
}

async function loadStats() {
  // TODO: Get real stats from background worker
  // For now, show placeholder
  statsDiv.innerHTML = `
    📊 Pages indexed: 0<br>
    💾 Storage used: 0 MB<br>
    🔍 Queries today: 0
  `;
}
