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

    // Initialize embeddings FIRST (fully complete before LLM)
    console.log('[Background] Starting embeddings initialization...');
    embeddingsReady = await initEmbeddings();
    if (embeddingsReady) {
      console.log('[Background] Embeddings ready - neural search enabled');
    } else {
      console.warn('[Background] Embeddings failed - using TF-IDF fallback');
    }

    console.log('[Background] Embeddings complete, starting Chrome Prompt API init...');

    // Initialize Chrome Prompt API (Gemini Nano)
    console.log('[Background] Checking Chrome Prompt API availability...');
    console.log('[Background] checkAvailability function:', typeof checkAvailability);

    try {
      console.log('[Background] Calling checkAvailability()...');
      const apiAvailable = await checkAvailability();
      console.log('[Background] checkAvailability returned:', apiAvailable);

      if (apiAvailable) {
        console.log('[Background] Chrome Prompt API available - initializing Gemini Nano...');
        console.log('[Background] First use may take 1-3 minutes to download model (~5GB)...');
        llmReady = await initSession();

        if (llmReady) {
          console.log('[Background] Gemini Nano ready - Q&A and Extract enabled');
          const status = getStatus();
          console.log('[Background] Model:', status.model, '| Context:', status.contextWindow, 'tokens');
        } else {
          console.warn('[Background] Gemini Nano initialization failed - Q&A and Extract disabled');
        }
      } else {
        console.warn('[Background] Chrome Prompt API not available (Chrome 138+ required)');
        console.warn('[Background] Q&A and Extract modes disabled');
        console.warn('[Background] Search mode still works with embeddings');
      }
    } catch (error) {
      console.error('[Background] Chrome Prompt API initialization error:', error);
      llmReady = false;
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
