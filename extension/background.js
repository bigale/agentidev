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
import { checkAvailability, initSession, generateText, generateJSON, estimateTokens, getStatus } from './lib/chrome-prompt-api.js';
import { TokenBudgetManager } from './lib/token-budget.js';
import { RecursiveExtractor } from './lib/recursive-extractor.js';
import { extractGooglePersonalInfo, extractFormFields, fillFormFields, findTabByUrl } from './lib/agent-workflows.js';
import { runDiagnostics } from './lib/diagnostic-helper.js';
import { indexDOM, searchDOM, clearDOMIndex } from './lib/dom-indexer.js';
import { findElementByIntent } from './lib/semantic-finder.js';
// Phase 2.0 MVP: Automation workflows
import { fillFormWithGoogleData, executeFormFillWorkflow, fillFormWithData } from './lib/agent-workflow.js';
// Phase 2.1: Grammar generation and parsing
import { generateFormGrammar, clearGrammarCache, getGrammarCacheStats } from './lib/form-grammar-generator.js';
import { indexIXMLSpec, getSpecIndexStatus, clearSpecIndex } from './lib/ixml-spec-indexer.js';

console.log('Contextual Recall: Background service worker started');
console.log('[Background] Note: Extension reload = re-initialize (models are cached, not re-downloaded)');

// Initialize database, embeddings, and LLM
let dbReady = false;
let embeddingsReady = false;
let llmReady = false;

(async () => {
  try {
    console.log('[Background] ========================================');
    console.log('[Background] Starting initialization...');
    console.log('[Background] ========================================');

    // Initialize database first (fast)
    await vectorDB.init();
    dbReady = true;
    console.log('[Background] ✓ Vector database ready');

    // Initialize embeddings FIRST (fully complete before LLM)
    console.log('[Background] Initializing embeddings (all-MiniLM-L6-v2)...');
    embeddingsReady = await initEmbeddings();
    if (embeddingsReady) {
      console.log('[Background] ✓ Embeddings ready (neural search enabled)');
    } else {
      console.warn('[Background] ✗ Embeddings failed (TF-IDF fallback)');
    }

    // Initialize Chrome Prompt API (Gemini Nano)
    console.log('[Background] Initializing Gemini Nano...');

    try {
      const apiAvailable = await checkAvailability();

      if (apiAvailable) {
        llmReady = await initSession();

        if (llmReady) {
          console.log('[Background] ✓ Gemini Nano ready (Q&A, Extract, DOM Selection enabled)');
          const status = getStatus();
          console.log(`[Background]   Model: ${status.model} | Context: ${status.contextWindow} tokens`);
        } else {
          console.warn('[Background] ✗ Gemini Nano init failed (Q&A and Extract disabled)');
        }
      } else {
        console.warn('[Background] ✗ Chrome Prompt API not available (need Chrome 138+)');
        console.warn('[Background]   Q&A and Extract modes disabled, Search still works');
      }
    } catch (error) {
      console.error('[Background] ✗ Chrome Prompt API error:', error.message);
      llmReady = false;
    }

    console.log('[Background] ========================================');
    console.log('[Background] Initialization complete');
    console.log('[Background] ✓ Database:', dbReady);
    console.log('[Background] ✓ Embeddings:', embeddingsReady);
    console.log('[Background] ✓ Gemini Nano:', llmReady);
    console.log('[Background] ========================================');
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

  if (message.type === 'AGENT_FILL_FORM') {
    handleAgentFormFill(message.sourceUrl, message.targetUrl)
      .then(result => sendResponse(result))
      .catch(error => {
        console.error('[Background] AGENT_FILL_FORM error:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Async response
  }

  if (message.type === 'INDEX_DOM') {
    handleDOMIndexing(message.tabId)
      .then(result => sendResponse(result))
      .catch(error => {
        console.error('[Background] INDEX_DOM error:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Async response
  }

  if (message.type === 'SEARCH_DOM') {
    handleDOMSearch(message.tabId, message.intent, message.options)
      .then(results => sendResponse({ results }))
      .catch(error => {
        console.error('[Background] SEARCH_DOM error:', error);
        sendResponse({ results: [], error: error.message });
      });
    return true; // Async response
  }

  if (message.type === 'FIND_ELEMENT') {
    handleFindElement(message.tabId, message.intent, message.options)
      .then(result => sendResponse(result))
      .catch(error => {
        console.error('[Background] FIND_ELEMENT error:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Async response
  }

  // Phase 2.0 MVP: Automation message handlers

  if (message.type === 'EXECUTE_WORKFLOW') {
    handleExecuteWorkflow(message.workflowType, message.targetTabId, message.options)
      .then(result => sendResponse(result))
      .catch(error => {
        console.error('[Background] EXECUTE_WORKFLOW error:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Async response
  }

  if (message.type === 'FILL_FORM_WITH_DATA') {
    handleFillFormWithData(message.data, message.targetTabId)
      .then(result => sendResponse(result))
      .catch(error => {
        console.error('[Background] FILL_FORM_WITH_DATA error:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Async response
  }

  // Phase 2.1 - Grammar viewer handlers
  if (message.type === 'GET_GRAMMAR') {
    handleGetGrammar(message.tabId, message.url)
      .then(result => sendResponse(result))
      .catch(error => {
        console.error('[Background] GET_GRAMMAR error:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Async response
  }

  if (message.type === 'CLEAR_GRAMMAR_CACHE') {
    handleClearGrammarCache(message.domain)
      .then(result => sendResponse(result))
      .catch(error => {
        console.error('[Background] CLEAR_GRAMMAR_CACHE error:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Async response
  }

  if (message.type === 'TEST_GRAMMAR') {
    handleTestGrammar(message.tabId)
      .then(result => sendResponse(result))
      .catch(error => {
        console.error('[Background] TEST_GRAMMAR error:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Async response
  }

  // IXML Spec indexer handlers
  if (message.type === 'INDEX_IXML_SPEC') {
    indexIXMLSpec()
      .then(result => sendResponse(result))
      .catch(error => {
        console.error('[Background] INDEX_IXML_SPEC error:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Async response
  }

  if (message.type === 'GET_SPEC_STATUS') {
    getSpecIndexStatus()
      .then(result => sendResponse(result))
      .catch(error => {
        console.error('[Background] GET_SPEC_STATUS error:', error);
        sendResponse({ indexed: false, error: error.message });
      });
    return true; // Async response
  }

  if (message.type === 'CLEAR_SPEC_INDEX') {
    clearSpecIndex()
      .then(result => sendResponse(result))
      .catch(error => {
        console.error('[Background] CLEAR_SPEC_INDEX error:', error);
        sendResponse({ success: false, error: error.message });
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

  // Check if LLM is ready, if not try to initialize
  if (!llmReady) {
    console.log('[LLM Query] Gemini Nano not ready, attempting to initialize...');

    try {
      const apiAvailable = await checkAvailability();
      if (apiAvailable) {
        llmReady = await initSession();
      }
    } catch (error) {
      console.error('[LLM Query] Initialization error:', error);
    }

    // If still not ready after initialization attempt, fallback to search
    if (!llmReady) {
      console.warn('[LLM Query] LLM not available - falling back to search');
      const searchResults = await handleQuery(query, filter);
      return {
        answer: 'Gemini Nano not available. Here are the search results instead.',
        sources: searchResults,
        metadata: { llmReady: false }
      };
    }

    console.log('[LLM Query] Gemini Nano initialized successfully');
  }

  try {
    console.log('[LLM Query] Processing:', query);

    // Initialize token budget for Gemini Nano (6000 context window)
    const tokenBudget = new TokenBudgetManager(6000, 768);

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
  // Build prompt for Gemini Nano (instruction-tuned model)
  // Gemini Nano works well with clear, simple instructions
  const systemPrompt = `You are a helpful AI assistant that answers questions based on the user's browsing history.

Context from browsing history:
${context}

Question: ${query}

Instructions:
- Answer using ONLY the information in the context above
- Keep your answer concise (2-3 sentences)
- Cite sources using [Source N] notation
- If the context doesn't contain enough information, say so

Answer:`;

  // Get recommended max tokens based on remaining budget
  const maxAnswerTokens = tokenBudget.getRecommendedMaxTokens();
  console.log(`[LLM Query] Generating answer (budget allows ${maxAnswerTokens} tokens)...`);

  // Generate answer using Chrome Prompt API
  const startTime = Date.now();
  const answer = await generateText(systemPrompt, {
    temperature: 0.3  // Low temp for factual responses
  });
  const elapsed = Date.now() - startTime;

  console.log(`[LLM Query] Answer generated in ${elapsed}ms`);
  console.log(`[LLM Query] Raw answer:`, answer.substring(0, 200));

  // Clean up answer (Gemini Nano is well-behaved, minimal cleanup needed)
  let cleanAnswer = answer.trim();

  // Remove common artifacts if present
  if (cleanAnswer.startsWith('Answer:')) {
    cleanAnswer = cleanAnswer.substring(7).trim();
  }

  // Estimate answer tokens
  const answerTokens = estimateTokens(cleanAnswer);
  tokenBudget.recordUsage(answerTokens);

  const budgetSummary = tokenBudget.getSummary();
  console.log(`[LLM Query] Final budget: ${budgetSummary.used}/${budgetSummary.total} tokens (${budgetSummary.percentUsed}%)`);
  console.log(`[LLM Query] Clean answer:`, cleanAnswer);

  return {
    answer: cleanAnswer,
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
  // Check if LLM is ready, if not try to initialize
  if (!llmReady) {
    console.log('[Extract] Gemini Nano not ready, attempting to initialize...');

    try {
      const apiAvailable = await checkAvailability();
      if (apiAvailable) {
        llmReady = await initSession();
      }
    } catch (error) {
      console.error('[Extract] Initialization error:', error);
    }

    if (!llmReady) {
      console.warn('[Extract] Gemini Nano not available');
      return {
        success: false,
        error: 'Gemini Nano not available. Requires Chrome 138+ with flag enabled.',
        items: [],
        pagesProcessed: 0
      };
    }

    console.log('[Extract] Gemini Nano initialized successfully');
  }

  try {
    console.log('[Extract] Starting extraction on tab', tabId);
    console.log('[Extract] Prompt:', prompt);
    console.log('[Extract] Options:', options);

    // Create LLM interface for extractor (using Chrome Prompt API)
    const llmInterface = {
      generate: async (promptText, genOptions = {}) => {
        return await generateText(promptText, genOptions);
      }
    };

    // Create extractor with token budget (4500 tokens - Gemini Nano limit is 6000, leaving 1500 for generation)
    const extractor = new RecursiveExtractor(llmInterface, 4500);

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

/**
 * Agent workflow: Fill form using data from another tab
 * @param {string} sourceUrl - URL pattern of source data (e.g., Google account)
 * @param {string} targetUrl - URL pattern of target form
 */
async function handleAgentFormFill(sourceUrl, targetUrl) {
  console.log('[Agent] Starting form fill workflow');
  console.log('[Agent] Source:', sourceUrl);
  console.log('[Agent] Target:', targetUrl);

  // Check if LLM is ready, if not try to initialize
  if (!llmReady) {
    console.log('[Agent] Gemini Nano not ready, attempting to initialize...');

    try {
      const apiAvailable = await checkAvailability();
      if (apiAvailable) {
        console.log('[Agent] Chrome Prompt API available, creating session...');
        llmReady = await initSession();

        if (!llmReady) {
          return {
            success: false,
            error: 'Failed to initialize Gemini Nano. Please check console for details.'
          };
        }

        console.log('[Agent] Gemini Nano initialized successfully');
      } else {
        return {
          success: false,
          error: 'Chrome Prompt API not available. Requires Chrome 138+ with flag enabled.'
        };
      }
    } catch (error) {
      console.error('[Agent] Initialization error:', error);
      return {
        success: false,
        error: `Initialization failed: ${error.message}`
      };
    }
  }

  try {
    // Step 1: Find source and target tabs
    console.log('[Agent] Step 1: Finding tabs...');
    const sourceTab = await findTabByUrl(sourceUrl);
    const targetTab = await findTabByUrl(targetUrl);

    if (!sourceTab) {
      return {
        success: false,
        error: `Source tab not found. Please open ${sourceUrl}`
      };
    }

    if (!targetTab) {
      return {
        success: false,
        error: `Target tab not found. Please open ${targetUrl}`
      };
    }

    console.log('[Agent] Found source tab:', sourceTab.id);
    console.log('[Agent] Found target tab:', targetTab.id);

    // Step 2: Extract data from source
    console.log('[Agent] Step 2: Extracting data from source...');
    const sourceData = await extractGooglePersonalInfo(sourceTab.id);

    if (!sourceData || Object.keys(sourceData).length === 0) {
      return {
        success: false,
        error: 'Could not extract data from source tab'
      };
    }

    console.log('[Agent] Extracted data:', sourceData);

    // Step 3: Analyze target form
    console.log('[Agent] Step 3: Analyzing target form...');
    const formFields = await extractFormFields(targetTab.id);

    if (!formFields || Object.keys(formFields).length === 0) {
      return {
        success: false,
        error: 'No form fields found in target tab'
      };
    }

    console.log('[Agent] Found form fields:', Object.keys(formFields).length);

    // Step 4: Use Gemini Nano to map fields
    console.log('[Agent] Step 4: Mapping fields with Gemini Nano...');
    const mapping = await mapFieldsWithLLM(sourceData, formFields);

    if (!mapping) {
      return {
        success: false,
        error: 'Failed to map fields'
      };
    }

    console.log('[Agent] Field mapping created:', Object.keys(mapping).length, 'mappings');

    // Step 5: Fill the form
    console.log('[Agent] Step 5: Filling form...');
    const fillResult = await fillFormFields(targetTab.id, mapping);

    if (!fillResult) {
      return {
        success: false,
        error: 'Failed to fill form'
      };
    }

    // Step 6: Switch to target tab to show results
    await chrome.tabs.update(targetTab.id, { active: true });

    console.log('[Agent] Workflow complete!');

    return {
      success: true,
      sourceData,
      fieldsMapped: Object.keys(mapping).length,
      fieldsFilled: fillResult.fieldsFilled || 0,
      message: `Successfully filled ${Object.keys(mapping).length} fields`
    };

  } catch (error) {
    console.error('[Agent] Workflow failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Use Gemini Nano to intelligently map source data to form fields
 * @param {Object} sourceData - Data from source (e.g., Google account)
 * @param {Object} formFields - Target form field structure
 * @returns {Promise<Object>} Mapping of field IDs to values
 */
async function mapFieldsWithLLM(sourceData, formFields) {
  console.log('[Agent] Using Gemini Nano to map fields...');

  try {
    // Build prompt for Gemini Nano
    const prompt = `You are a form-filling assistant. Map the available data to the form fields.

Available data:
${JSON.stringify(sourceData, null, 2)}

Form fields to fill:
${Object.entries(formFields).map(([id, field]) =>
  `- ${id}: ${field.label || field.name || field.placeholder} (type: ${field.type})`
).join('\n')}

Instructions:
1. Match each form field to the appropriate data value
2. Handle field variations (e.g., "Full Name" vs "First Name"/"Last Name")
3. Format data appropriately (e.g., phone numbers)
4. Only map fields where you have data
5. Return ONLY a JSON object mapping field IDs to values

Required JSON format:
{
  "field_id_1": "value1",
  "field_id_2": "value2"
}

JSON output:`;

    const result = await generateText(prompt, {
      temperature: 0.1  // Low temperature for consistent mapping
    });

    console.log('[Agent] LLM response:', result.substring(0, 200));

    // Extract JSON from response
    let jsonText = result.trim();

    // Remove markdown code blocks if present
    if (jsonText.startsWith('```json')) {
      jsonText = jsonText.substring(7).trim();
    }
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.substring(3).trim();
    }
    if (jsonText.endsWith('```')) {
      jsonText = jsonText.substring(0, jsonText.length - 3).trim();
    }

    // Extract JSON object
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonText = jsonMatch[0];
    }

    const mapping = JSON.parse(jsonText);
    console.log('[Agent] Parsed mapping:', mapping);

    return mapping;

  } catch (error) {
    console.error('[Agent] Failed to map fields:', error);
    return null;
  }
}

/**
 * Handle DOM indexing for a tab
 * Extracts DOM structure from content script and indexes it
 */
async function handleDOMIndexing(tabId) {
  console.log(`[DOM Index] Starting indexing for tab ${tabId}`);

  try {
    // Ensure embeddings are initialized
    if (!embeddingsReady) {
      console.log('[DOM Index] Initializing embeddings...');
      embeddingsReady = await initEmbeddings();
      if (!embeddingsReady) {
        throw new Error('Failed to initialize embeddings');
      }
    }

    // Step 1: Extract DOM structure from content script
    console.log('[DOM Index] Extracting DOM structure from page...');
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'EXTRACT_DOM_STRUCTURE'
    });

    if (!response || !response.chunks) {
      throw new Error('Failed to extract DOM structure');
    }

    const domChunks = response.chunks;
    console.log(`[DOM Index] Extracted ${domChunks.length} DOM chunks`);

    // Step 2: Index the DOM chunks (generates embeddings and stores)
    console.log('[DOM Index] Indexing chunks...');
    const result = await indexDOM(tabId, domChunks);

    if (!result.success) {
      throw new Error(result.error || 'Indexing failed');
    }

    console.log(`[DOM Index] Successfully indexed ${result.count} elements in ${result.elapsed}ms`);

    return {
      success: true,
      count: result.count,
      elapsed: result.elapsed,
      collection: result.collection
    };

  } catch (error) {
    console.error('[DOM Index] Indexing failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Handle DOM search by intent
 * Returns matching elements for natural language query
 */
async function handleDOMSearch(tabId, intent, options = {}) {
  console.log(`[DOM Search] Searching for "${intent}" in tab ${tabId}`);

  try {
    // Search indexed DOM
    const results = await searchDOM(tabId, intent, options);

    console.log(`[DOM Search] Found ${results.length} matches`);

    // Highlight top match if requested
    if (options.highlight && results.length > 0) {
      const topMatch = results[0];
      await chrome.tabs.sendMessage(tabId, {
        type: 'HIGHLIGHT_ELEMENT',
        selector: topMatch.selector
      });
    }

    return results;

  } catch (error) {
    console.error('[DOM Search] Search failed:', error);
    throw error;
  }
}

/**
 * Handle finding element by intent using semantic finder
 * This is Phase 2: Vector search + LLM selection for best match
 */
async function handleFindElement(tabId, intent, options = {}) {
  console.log(`[Find Element] Finding "${intent}" in tab ${tabId}`);

  try {
    // Ensure LLM is ready
    if (!llmReady) {
      console.log('[Find Element] Gemini Nano not ready, attempting to initialize...');
      try {
        const apiAvailable = await checkAvailability();
        if (apiAvailable) {
          llmReady = await initSession();
        }
      } catch (error) {
        console.warn('[Find Element] LLM initialization failed, will use vector-only:', error.message);
        // Continue anyway - semantic finder will fall back to vector-only
      }
    }

    // Use semantic finder (Phase 2: vector + LLM)
    const result = await findElementByIntent(tabId, intent, {
      ...options,
      useLLM: llmReady // Only use LLM if it's ready
    });

    if (!result.success) {
      return result;
    }

    console.log(`[Find Element] Found element via ${result.method}`);

    // Highlight element if requested
    if (options.highlight !== false) { // Default to true
      await chrome.tabs.sendMessage(tabId, {
        type: 'HIGHLIGHT_ELEMENT',
        selector: result.selector
      });
    }

    return result;

  } catch (error) {
    console.error('[Find Element] Search failed:', error);
    return {
      success: false,
      error: error.message,
      intent
    };
  }
}

/**
 * Phase 2.0 MVP: Automation Handlers
 */

/**
 * Execute an automation workflow
 */
async function handleExecuteWorkflow(workflowType, targetTabId, options = {}) {
  console.log(`[Workflow] Executing ${workflowType} workflow on tab ${targetTabId}`);

  try {
    // Use static imports (defined at top of file)
    if (workflowType === 'fill_with_google_data') {
      return await fillFormWithGoogleData(targetTabId);
    } else if (workflowType === 'custom' && options.mapping) {
      return await executeFormFillWorkflow(
        options.sourceTabId,
        targetTabId,
        options.mapping,
        options
      );
    } else {
      return {
        success: false,
        error: `Unknown workflow type: ${workflowType}`
      };
    }

  } catch (error) {
    console.error('[Workflow] Execution failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Fill form with provided data
 */
async function handleFillFormWithData(data, targetTabId) {
  console.log('[Fill Form] Filling form with data on tab', targetTabId);

  try {
    // Use static import (defined at top of file)
    return await fillFormWithData(data, targetTabId);

  } catch (error) {
    console.error('[Fill Form] Failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Get grammar for current page (Phase 2.1)
 */
async function handleGetGrammar(tabId, url) {
  console.log('[Grammar] Getting grammar for:', url);

  try {
    // Get HTML from tab
    const htmlResult = await chrome.tabs.sendMessage(tabId, {
      type: 'GET_PAGE_HTML'
    });

    if (!htmlResult || !htmlResult.html) {
      return { success: false, error: 'Failed to get page HTML' };
    }

    // Generate or retrieve grammar
    const grammarResult = await generateFormGrammar(htmlResult.html, url, { useCache: true });

    return {
      success: true,
      grammar: grammarResult.grammar,
      cached: grammarResult.cached || false,
      cacheKey: grammarResult.cacheKey
    };

  } catch (error) {
    console.error('[Grammar] Failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Clear grammar cache for domain (Phase 2.1)
 */
async function handleClearGrammarCache(domain) {
  console.log('[Grammar] Clearing cache for:', domain);

  try {
    await clearGrammarCache(domain);

    // Get stats to return count
    const stats = await getGrammarCacheStats();
    const count = domain ? (stats.byDomain[domain] || 0) : stats.totalEntries;

    return {
      success: true,
      count: count
    };

  } catch (error) {
    console.error('[Grammar] Clear cache failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Test grammar parsing on current page (Phase 2.1)
 */
async function handleTestGrammar(tabId) {
  console.log('[Grammar] Testing parse on tab:', tabId);

  try {
    // Delegate to content script which will parse and return result
    const parseResult = await chrome.tabs.sendMessage(tabId, {
      type: 'PARSE_FORM_WITH_GRAMMAR',
      intent: null, // No specific intent, just test parse
      html: null,
      grammar: null
    });

    if (parseResult && parseResult.success) {
      return {
        success: true,
        method: parseResult.parseMethod || parseResult.method,
        fieldCount: parseResult.fields ? parseResult.fields.length : 0,
        xmlOutput: parseResult.xmlOutput || null
      };
    } else {
      return {
        success: false,
        error: parseResult?.error || 'Parse failed'
      };
    }

  } catch (error) {
    console.error('[Grammar] Test failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
}
