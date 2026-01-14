/**
 * Background Service Worker for Contextual Recall
 *
 * Responsibilities:
 * - Coordinate content capture from all tabs
 * - Manage vector database (IndexedDB for POC)
 * - Handle semantic queries from sidebar
 * - Generate embeddings (TF-IDF for POC, transformers.js later)
 * - Provide usage statistics
 *
 * Design: One-size-fits-all for personal and enterprise use
 */

import { vectorDB } from './lib/vectordb.js';
import { initEmbeddings, generateEmbedding, isInitialized } from './lib/embeddings.js';
import { chunkContent, extractCodeBlocks } from './lib/chunker.js';

console.log('Contextual Recall: Background service worker started');

// Initialize database and embeddings
let dbReady = false;
let embeddingsReady = false;

(async () => {
  try {
    // Initialize database first (fast)
    await vectorDB.init();
    dbReady = true;
    console.log('[Background] Vector database initialized');

    // Initialize embeddings in background (slow - downloads ~50MB on first run)
    console.log('[Background] Starting embeddings initialization...');
    embeddingsReady = await initEmbeddings();
    if (embeddingsReady) {
      console.log('[Background] Embeddings ready - neural search enabled');
    } else {
      console.warn('[Background] Embeddings failed - using TF-IDF fallback');
    }
  } catch (error) {
    console.error('[Background] Initialization failed:', error);
  }
})();

chrome.runtime.onInstalled.addListener(() => {
  console.log('Contextual Recall installed');

  // Initialize storage
  chrome.storage.local.set({
    captureEnabled: true,
    retentionDays: 90,
    excludedDomains: ['accounts.google.com', 'login.', 'auth.'],
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
    handlePageCapture(message.data, sender.tab)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Async response
  }

  if (message.type === 'QUERY') {
    handleQuery(message.query, message.filter)
      .then(results => sendResponse({ results }))
      .catch(error => sendResponse({ results: [], error: error.message }));
    return true; // Async response
  }

  if (message.type === 'GET_STATS') {
    getStats()
      .then(stats => sendResponse(stats))
      .catch(error => sendResponse({ pagesIndexed: 0, storageUsed: 0, queriesToday: 0 }));
    return true; // Async response
  }
});

/**
 * Handle page capture and indexing
 */
async function handlePageCapture(data, tab) {
  if (!dbReady) {
    console.warn('Database not ready, skipping capture');
    return;
  }

  console.log('Capturing page:', data.url);

  try {
    // Check if domain is excluded
    const settings = await chrome.storage.local.get(['captureEnabled', 'excludedDomains']);
    if (!settings.captureEnabled) {
      return;
    }

    const domain = new URL(data.url).hostname;
    if (settings.excludedDomains.some(excluded => domain.includes(excluded))) {
      console.log('Skipping excluded domain:', domain);
      return;
    }

    // Classify content type (simple heuristics for now)
    const contentType = classifyContent(data);

    // Chunk content based on type (semantic chunking)
    console.log(`[Capture] Chunking content (type: ${contentType})...`);
    const chunks = chunkContent(data.html, contentType);
    console.log(`[Capture] Created ${chunks.length} chunks`);

    // Store each chunk separately with its own embedding
    let chunksIndexed = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      // Generate embedding for this chunk (neural if ready, TF-IDF fallback)
      let embedding;
      if (isInitialized()) {
        try {
          embedding = await generateEmbedding(chunk.text);
        } catch (error) {
          console.error('[Capture] Neural embedding failed, using TF-IDF:', error);
          embedding = generateSimpleEmbedding(chunk.text);
        }
      } else {
        embedding = generateSimpleEmbedding(chunk.text);
      }

      // Store chunk in database
      await vectorDB.addPage({
        url: data.url,
        title: chunk.title || data.title,
        text: chunk.text,
        html: data.html, // Keep full HTML for context
        timestamp: data.timestamp,
        contentType: contentType,
        embedding: embedding,
        metadata: {
          ...data.metadata,
          chunkIndex: i,
          chunkTotal: chunks.length,
          chunkType: chunk.type
        }
      });

      chunksIndexed++;
    }

    console.log(`[Capture] Indexed ${chunksIndexed} chunks from:`, data.url);

    // Update stats
    const stats = await vectorDB.getStats();
    await chrome.storage.local.set({ stats });

  } catch (error) {
    console.error('Failed to capture page:', error);
    throw error;
  }
}

/**
 * Handle semantic query
 */
async function handleQuery(query, filter = 'all') {
  if (!dbReady) {
    console.warn('Database not ready');
    return [];
  }

  console.log('Query:', query, 'Filter:', filter);

  try {
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

    // Generate query embedding (neural if ready, TF-IDF fallback)
    let queryEmbedding;
    if (isInitialized()) {
      try {
        console.log('[Query] Generating neural query embedding...');
        queryEmbedding = await generateEmbedding(query);
      } catch (error) {
        console.error('[Query] Neural embedding failed, using TF-IDF:', error);
        queryEmbedding = generateSimpleEmbedding(query);
      }
    } else {
      console.log('[Query] Embeddings not ready, using TF-IDF');
      queryEmbedding = generateSimpleEmbedding(query);
    }

    // Vector search with filter
    const results = await vectorDB.search(queryEmbedding, {
      limit: 10,
      filter: filter,
      threshold: isInitialized() ? 0.3 : 0.1 // Higher threshold for neural embeddings
    });

    console.log(`Found ${results.length} results`);
    return results;

  } catch (error) {
    console.error('Query failed:', error);
    return [];
  }
}

/**
 * Get database statistics
 */
async function getStats() {
  if (!dbReady) {
    return { pagesIndexed: 0, storageUsed: 0, queriesToday: 0 };
  }

  return await vectorDB.getStats();
}

/**
 * Classify content type based on heuristics
 */
function classifyContent(data) {
  const { url, title, html, text } = data;

  // Check URL patterns
  if (url.includes('/api/') || url.includes('/reference/')) {
    return 'api_reference';
  }
  if (url.includes('/spec') || url.includes('/specification')) {
    return 'spec';
  }
  if (url.includes('/docs/') || url.includes('/documentation')) {
    return 'documentation';
  }
  if (url.includes('/dashboard')) {
    return 'dashboard';
  }

  // Check content patterns
  if (html.includes('<table') || text.includes('| Column |')) {
    return 'dashboard';
  }
  if (html.includes('<code') && html.includes('<pre')) {
    return 'api_reference';
  }

  return 'general';
}

/**
 * Generate simple TF-IDF style embedding
 * (POC implementation - will use transformers.js later)
 */
function generateSimpleEmbedding(text) {
  if (!text) return new Array(128).fill(0);

  // Tokenize and count terms
  const words = text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);

  // Create fixed-size embedding (128 dimensions)
  const embedding = new Array(128).fill(0);

  // Simple hash-based embedding
  for (const word of words) {
    const hash = simpleHash(word) % 128;
    embedding[hash] += 1;
  }

  // Normalize
  const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  if (magnitude > 0) {
    for (let i = 0; i < embedding.length; i++) {
      embedding[i] /= magnitude;
    }
  }

  return embedding;
}

/**
 * Simple string hash function
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}
