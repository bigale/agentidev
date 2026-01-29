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
import { initLLM, generateAnswer, estimateTokens, isInitialized as isLLMInitialized } from './lib/llm.js';
import { TokenBudgetManager } from './lib/token-budget.js';
import { RecursiveExtractor } from './lib/recursive-extractor.js';

console.log('Contextual Recall: Background service worker started');

// Initialize database, embeddings, and LLM
let dbReady = false;
let embeddingsReady = false;
let llmReady = false;

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

    // DISABLED: LLM initialization causing crashes with transformers.js
    // TODO: Debug transformers.js ONNX Runtime issues before re-enabling
    // For now, extension works without Q&A and Extract modes
    console.log('[Background] LLM initialization DISABLED (causing crashes)');
    console.log('[Background] Search mode available, Q&A and Extract disabled');
    llmReady = false;

    // Uncomment to enable LLM (requires fixing transformers.js issues first):
    // console.log('[Background] Starting LLM initialization...');
    // console.log('[Background] This may take 20-40 seconds on first run...');
    // llmReady = await initLLM();
    // if (llmReady) {
    //   console.log('[Background] LLM ready - Q&A enabled');
    // } else {
    //   console.warn('[Background] LLM failed - only search available');
    // }
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
  // Ignore embeddings/offscreen messages - those are handled by offscreen document
  if (message.type && message.type.startsWith('EMBEDDINGS_')) {
    return false; // Let offscreen document handle this
  }

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
      .catch(error => {
        console.error('[Background] GET_STATS error:', error);
        sendResponse({ pagesIndexed: 0, storageUsed: 0, queriesToday: 0 });
      });
    return true; // Async response
  }

  if (message.type === 'QUERY_LLM') {
    handleLLMQuery(message.query, message.filter)
      .then(result => sendResponse({ result }))
      .catch(error => {
        console.error('[Background] QUERY_LLM error:', error);
        sendResponse({ result: null, error: error.message });
      });
    return true; // Async response
  }

  if (message.type === 'EXTRACT') {
    handleExtraction(message.tabId, message.prompt, message.options)
      .then(result => sendResponse(result))
      .catch(error => {
        console.error('[Background] EXTRACT error:', error);
        sendResponse({ success: false, error: error.message, items: [], pagesProcessed: 0 });
      });
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

    // Chunk content using offscreen document (has DOM APIs)
    console.log(`[Capture] Chunking content (type: ${contentType})...`);
    const chunkResponse = await chrome.runtime.sendMessage({
      type: 'EMBEDDINGS_CHUNK',
      html: data.html,
      contentType: contentType
    });

    if (!chunkResponse || !chunkResponse.chunks) {
      console.error('[Capture] Chunking failed:', chunkResponse?.error);
      return;
    }

    const chunks = chunkResponse.chunks;
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
        queryEmbedding = await generateEmbedding(query);
      } catch (error) {
        console.error('[Query] Neural embedding failed, using TF-IDF:', error);
        queryEmbedding = generateSimpleEmbedding(query);
      }
    } else {
      queryEmbedding = generateSimpleEmbedding(query);
    }

    // Vector search with filter
    const threshold = isInitialized() ? 0.3 : 0.1;
    const results = await vectorDB.search(queryEmbedding, {
      limit: 10,
      filter: filter,
      threshold: threshold
    });

    console.log(`[Query] "${query}" - Found ${results.length} results`);
    if (results.length > 0) {
      console.log(`[Query] Top match: ${results[0].title} (${Math.round(results[0].score * 100)}% similarity)`);
    }
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

/**
 * Handle LLM-powered Q&A query with token budget management
 */
async function handleLLMQuery(query, filter = 'all') {
  if (!dbReady) {
    console.warn('[LLM Query] Database not ready');
    return {
      answer: 'Database not ready. Please wait a moment and try again.',
      sources: []
    };
  }

  if (!llmReady) {
    console.warn('[LLM Query] LLM not ready - falling back to search');
    const searchResults = await handleQuery(query, filter);
    return {
      answer: 'LLM is still initializing. Here are the search results instead.',
      sources: searchResults,
      metadata: { llmReady: false }
    };
  }

  try {
    console.log('[LLM Query] Processing:', query);

    // Initialize token budget for GPT-2 (1024 context window)
    // Note: GPT-2 has a smaller context than originally planned, but works reliably
    const tokenBudget = new TokenBudgetManager(1024, 256);

    // 1. Vector search to find relevant chunks
    const searchResults = await handleQuery(query, filter);

    if (searchResults.length === 0) {
      return {
        answer: 'No relevant content found in your browsing history.',
        sources: [],
        metadata: { tokensUsed: 0 }
      };
    }

    // 2. Estimate query tokens
    const queryTokens = await estimateTokens(query);
    tokenBudget.recordUsage(queryTokens);

    // 3. Determine how many chunks we can afford
    const maxChunks = tokenBudget.getMaxChunks(500); // Assume 500 tokens per chunk
    const selectedResults = searchResults.slice(0, Math.min(maxChunks, 5));

    console.log(`[LLM Query] Using ${selectedResults.length} chunks (budget allows ${maxChunks})`);

    // 4. Build context from selected results
    const contextParts = selectedResults.map((r, i) =>
      `[Source ${i + 1}] ${r.title}\n${r.text.substring(0, 2000)}`
    );
    const context = contextParts.join('\n\n---\n\n');

    // 5. Verify context fits in budget
    const contextTokens = await estimateTokens(context);
    console.log(`[LLM Query] Context: ${contextTokens} tokens`);

    if (!tokenBudget.canAfford(contextTokens)) {
      console.warn('[LLM Query] Context too large, reducing chunks...');
      // Retry with fewer chunks
      const reducedResults = searchResults.slice(0, Math.max(1, selectedResults.length - 2));
      const reducedContext = reducedResults.map((r, i) =>
        `[Source ${i + 1}] ${r.title}\n${r.text.substring(0, 1500)}`
      ).join('\n\n---\n\n');

      const reducedContextTokens = await estimateTokens(reducedContext);
      tokenBudget.recordUsage(reducedContextTokens);

      console.log(`[LLM Query] Reduced to ${reducedResults.length} chunks (${reducedContextTokens} tokens)`);

      return await generateLLMAnswer(query, reducedContext, reducedResults, tokenBudget);
    }

    tokenBudget.recordUsage(contextTokens);

    // 6. Generate answer with LLM
    return await generateLLMAnswer(query, context, selectedResults, tokenBudget);

  } catch (error) {
    console.error('[LLM Query] Failed:', error);
    return {
      answer: `Error generating answer: ${error.message}`,
      sources: [],
      metadata: { error: error.message }
    };
  }
}

/**
 * Generate LLM answer with proper prompting
 */
async function generateLLMAnswer(query, context, sources, tokenBudget) {
  // Build prompt
  const systemPrompt = `You are a helpful assistant that answers questions based on the user's browser history.

Context from the user's browsing history:
${context}

Question: ${query}

Answer the question using ONLY the information in the context above. If the context doesn't contain enough information, say so. Keep your answer concise (2-3 sentences). Cite sources using [Source N] notation.

Answer:`;

  // Get recommended max tokens based on remaining budget
  const maxAnswerTokens = tokenBudget.getRecommendedMaxTokens();
  console.log(`[LLM Query] Generating answer (max ${maxAnswerTokens} tokens)...`);

  // Generate answer
  const startTime = Date.now();
  const answer = await generateAnswer(systemPrompt, {
    max_tokens: maxAnswerTokens,
    temperature: 0.3
  });
  const elapsed = Date.now() - startTime;

  console.log(`[LLM Query] Answer generated in ${elapsed}ms`);

  // Estimate answer tokens
  const answerTokens = await estimateTokens(answer);
  tokenBudget.recordUsage(answerTokens);

  const budgetSummary = tokenBudget.getSummary();
  console.log(`[LLM Query] Final budget: ${budgetSummary.used}/${budgetSummary.total} tokens (${budgetSummary.percentUsed}%)`);

  return {
    answer: answer,
    sources: sources,
    metadata: {
      tokensUsed: budgetSummary.used,
      tokensAvailable: budgetSummary.total,
      chunksUsed: sources.length,
      generationTimeMs: elapsed,
      llmReady: true
    }
  };
}

/**
 * Handle web scraping extraction with LLM
 */
async function handleExtraction(tabId, prompt, options = {}) {
  if (!llmReady) {
    console.warn('[Extract] LLM not ready');
    return {
      success: false,
      error: 'LLM is still initializing. Please wait and try again.',
      items: [],
      pagesProcessed: 0
    };
  }

  try {
    console.log('[Extract] Starting extraction on tab', tabId);
    console.log('[Extract] Prompt:', prompt);
    console.log('[Extract] Options:', options);

    // Create LLM interface for extractor
    const llmInterface = {
      generate: async (promptText, genOptions = {}) => {
        return await generateAnswer(promptText, genOptions);
      }
    };

    // Create extractor with token budget (768 tokens - GPT-2 limit is 1024, leaving 256 for answer)
    const extractor = new RecursiveExtractor(llmInterface, 768);

    // Run extraction
    const result = await extractor.extract(tabId, prompt, options);

    console.log('[Extract] Extraction complete:', {
      success: result.success,
      items: result.items?.length || 0,
      pages: result.pagesProcessed
    });

    return result;

  } catch (error) {
    console.error('[Extract] Failed:', error);
    return {
      success: false,
      error: error.message,
      items: [],
      pagesProcessed: 0
    };
  }
}
