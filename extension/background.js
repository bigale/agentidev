/**
 * Background Service Worker for Contextual Recall
 *
 * Responsibilities:
 * - Coordinate content capture from all tabs
 * - Manage vector database (LanceDB WASM)
 * - Handle semantic queries from sidebar
 * - Orchestrate iXML parsing and chunking
 * - Provide usage statistics
 *
 * Design: One-size-fits-all for personal and enterprise use
 */

console.log('Contextual Recall: Background service worker started');

// TODO: Initialize LanceDB WASM
// TODO: Set up message listeners for content scripts
// TODO: Implement query handler for popup
// TODO: Background indexing scheduler

chrome.runtime.onInstalled.addListener(() => {
  console.log('Contextual Recall installed');

  // Initialize storage
  chrome.storage.local.set({
    captureEnabled: true,
    retentionDays: 90,
    excludedDomains: [],
    stats: {
      pagesIndexed: 0,
      storageUsed: 0,
      queriesToday: 0,
      lastQueryDate: null
    }
  });
});

// Open sidebar when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// Listen for messages from content scripts and sidebar
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CAPTURE_PAGE') {
    handlePageCapture(message.data, sender.tab);
    sendResponse({ success: true });
  }

  if (message.type === 'QUERY') {
    handleQuery(message.query, message.filter).then(results => {
      sendResponse({ results });
    });
    return true; // Async response
  }

  if (message.type === 'GET_STATS') {
    getStats().then(stats => {
      sendResponse(stats);
    });
    return true; // Async response
  }
});

async function handlePageCapture(data, tab) {
  console.log('Capturing page:', tab.url);
  // TODO: Implement capture logic
  // 1. Classify content type
  // 2. Select iXML grammar or use token chunking
  // 3. Generate embeddings
  // 4. Store in LanceDB
}

async function handleQuery(query, filter = 'all') {
  console.log('Query:', query, 'Filter:', filter);

  // Update query stats
  const today = new Date().toDateString();
  const { stats } = await chrome.storage.local.get('stats');
  if (stats.lastQueryDate !== today) {
    stats.queriesToday = 1;
    stats.lastQueryDate = today;
  } else {
    stats.queriesToday++;
  }
  await chrome.storage.local.set({ stats });

  // TODO: Implement query logic
  // 1. Generate query embedding
  // 2. Vector search in LanceDB with filter
  // 3. Retrieve top-k chunks
  // 4. Pass to local LLM for summary (optional)
  return [];
}

async function getStats() {
  const { stats } = await chrome.storage.local.get('stats');
  return stats || {
    pagesIndexed: 0,
    storageUsed: 0,
    queriesToday: 0
  };
}
