/**
 * Capture, query, and stats message handlers.
 * Extracted from background.js lines 130-172.
 */
import { vectorDB } from '../vectordb.js';
import { initEmbeddings, generateEmbedding, isInitialized } from '../embeddings.js';
import { checkAvailability, initSession, generateText, estimateTokens, getStatus } from '../chrome-prompt-api.js';
import { TokenBudgetManager } from '../token-budget.js';
import { yamlSnapshotStore } from '../yaml-snapshot-store.js';
import { structDB } from '../structdb.js';
import { state } from '../init-state.js';

// Common stop words to filter from implicit keyword extraction
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'between',
  'through', 'during', 'before', 'after', 'above', 'below', 'and', 'but',
  'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each',
  'every', 'all', 'any', 'few', 'more', 'most', 'some', 'such', 'no',
  'only', 'own', 'same', 'than', 'too', 'very', 'just', 'because',
  'if', 'when', 'where', 'how', 'what', 'which', 'who', 'whom', 'this',
  'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your',
  'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they', 'them', 'their',
  'show', 'find', 'get', 'give', 'look', 'tell', 'want', 'like'
]);

/**
 * Parse structured filter syntax from a raw query string.
 */
function parseQueryFilters(rawQuery) {
  let domainFilter = null;
  let afterDate = null;
  const explicitKeywords = [];
  const remainingWords = [];

  const tokens = rawQuery.split(/\s+/);

  for (const token of tokens) {
    const domainMatch = token.match(/^domain:(.+)$/i);
    if (domainMatch) { domainFilter = domainMatch[1].toLowerCase(); continue; }

    const afterMatch = token.match(/^after:(\d{4}-\d{2}-\d{2})$/i);
    if (afterMatch) { afterDate = afterMatch[1]; continue; }

    const keywordMatch = token.match(/^keyword:(.+)$/i);
    if (keywordMatch) { explicitKeywords.push(keywordMatch[1].toLowerCase()); continue; }

    remainingWords.push(token);
  }

  const cleanQuery = remainingWords.join(' ');
  const implicitKeywords = remainingWords
    .map(w => w.replace(/[^\w-]/g, '').toLowerCase())
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));

  const queryKeywords = [...new Set([...explicitKeywords, ...implicitKeywords])];
  return { cleanQuery, queryKeywords, domainFilter, afterDate };
}

/**
 * Classify content type based on heuristics
 */
function classifyContent(data) {
  const { url, html, text } = data;

  if (url.includes('/api/') || url.includes('/reference/')) return 'api_reference';
  if (url.includes('/spec') || url.includes('/specification')) return 'spec';
  if (url.includes('/docs/') || url.includes('/documentation')) return 'documentation';
  if (url.includes('/dashboard')) return 'dashboard';
  if (html.includes('<table') || text.includes('| Column |')) return 'dashboard';
  if (html.includes('<code') && html.includes('<pre')) return 'api_reference';

  return 'general';
}

/**
 * Generate simple TF-IDF style embedding (fallback)
 */
function generateSimpleEmbedding(text) {
  if (!text) return new Array(128).fill(0);

  const words = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  const embedding = new Array(128).fill(0);

  for (const word of words) {
    const hash = simpleHash(word) % 128;
    embedding[hash] += 1;
  }

  const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  if (magnitude > 0) {
    for (let i = 0; i < embedding.length; i++) {
      embedding[i] /= magnitude;
    }
  }
  return embedding;
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

// Exported for use by snapshot-handlers
export { generateSimpleEmbedding, simpleHash };

async function handlePageCapture(data, tab) {
  if (!state.dbReady) {
    console.warn('Database not ready, skipping capture');
    return;
  }

  console.log('Capturing page:', data.url);

  const settings = await chrome.storage.local.get(['captureEnabled', 'excludedDomains']);
  if (!settings.captureEnabled) return;

  const domain = new URL(data.url).hostname;
  if (settings.excludedDomains.some(excluded => domain.includes(excluded))) {
    console.log('Skipping excluded domain:', domain);
    return;
  }

  const contentType = classifyContent(data);

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
  const structuredRecords = chunkResponse.structuredRecords || [];
  console.log(`[Capture] Created ${chunks.length} chunks, ${structuredRecords.length} structured records`);

  let chunksIndexed = 0;
  const chunkIds = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

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

    const chunkId = await vectorDB.addPage({
      url: data.url,
      title: chunk.title || data.title,
      text: chunk.text,
      html: data.html,
      timestamp: data.timestamp,
      contentType: contentType,
      embedding: embedding,
      keywords: chunk.keywords || [],
      source: 'browsing',
      metadata: {
        ...data.metadata,
        chunkIndex: i,
        chunkTotal: chunks.length,
        chunkType: chunk.type
      }
    });

    chunkIds.push({ id: chunkId, tableIndex: chunk.tableIndex });
    chunksIndexed++;
  }

  // Store structured records for table chunks
  if (structuredRecords.length > 0) {
    const pageDomain = new URL(data.url).hostname;
    const tableRecordsToStore = [];

    for (const sr of structuredRecords) {
      const matchingChunk = chunkIds.find(c => c.tableIndex === sr.tableIndex);
      tableRecordsToStore.push({
        sourceUrl: data.url,
        sourceChunkId: matchingChunk ? matchingChunk.id : null,
        schemaType: 'auto_table',
        fields: sr.fields,
        headers: sr.headers,
        domain: pageDomain
      });
    }

    if (tableRecordsToStore.length > 0) {
      try {
        await structDB.addRecords(tableRecordsToStore);
        console.log(`[Capture] Stored ${tableRecordsToStore.length} structured records from:`, data.url);
      } catch (error) {
        console.error('[Capture] Failed to store structured records:', error);
      }
    }
  }

  console.log(`[Capture] Indexed ${chunksIndexed} chunks from:`, data.url);

  const stats = await vectorDB.getStats();
  await chrome.storage.local.set({ stats });
}

export async function handleQuery(query, filter = 'all') {
  if (!state.dbReady) {
    console.warn('Database not ready');
    return [];
  }

  console.log('Query:', query, 'Filter:', filter);

  try {
    const today = new Date().toDateString();
    const { stats } = await chrome.storage.local.get('stats');
    if (stats.lastQueryDate !== today) {
      stats.queriesToday = 1;
      stats.lastQueryDate = today;
    } else {
      stats.queriesToday++;
    }
    await chrome.storage.local.set({ stats });

    const { cleanQuery, queryKeywords, domainFilter, afterDate } = parseQueryFilters(query);
    const searchQuery = cleanQuery || query;

    let queryEmbedding;
    if (isInitialized()) {
      try {
        queryEmbedding = await generateEmbedding(searchQuery);
      } catch (error) {
        console.error('[Query] Neural embedding failed, using TF-IDF:', error);
        queryEmbedding = generateSimpleEmbedding(searchQuery);
      }
    } else {
      queryEmbedding = generateSimpleEmbedding(searchQuery);
    }

    const threshold = isInitialized() ? 0.3 : 0.1;
    const results = await vectorDB.search(queryEmbedding, {
      limit: 10,
      filter: filter,
      threshold: threshold,
      queryKeywords,
      domainFilter,
      afterDate
    });

    console.log(`[Query] "${query}" - Found ${results.length} results (keywords: [${queryKeywords.join(', ')}]${domainFilter ? ', domain: ' + domainFilter : ''}${afterDate ? ', after: ' + afterDate : ''})`);
    if (results.length > 0) {
      console.log(`[Query] Top match: ${results[0].title} (${Math.round(results[0].score * 100)}% similarity)`);
    }
    return results;
  } catch (error) {
    console.error('Query failed:', error);
    return [];
  }
}

export async function getStats() {
  const baseStats = state.dbReady
    ? await vectorDB.getStats()
    : { pagesIndexed: 0, storageUsed: 0, queriesToday: 0 };

  try {
    const snapshotStats = await yamlSnapshotStore.getStats();
    baseStats.snapshotChunks = snapshotStats.totalRecords || 0;
    baseStats.pagesIndexed += baseStats.snapshotChunks;
  } catch {
    baseStats.snapshotChunks = 0;
  }

  try {
    const structStats = await structDB.getStats();
    baseStats.structuredRecords = structStats.totalRecords || 0;
  } catch {
    baseStats.structuredRecords = 0;
  }

  return baseStats;
}

async function handleLLMQuery(query, filter = 'all') {
  if (!state.dbReady) {
    console.warn('[LLM Query] Database not ready');
    return { answer: 'Database not ready. Please wait a moment and try again.', sources: [] };
  }

  if (!state.llmReady) {
    console.log('[LLM Query] Gemini Nano not ready, attempting to initialize...');
    try {
      const apiAvailable = await checkAvailability();
      if (apiAvailable) state.llmReady = await initSession();
    } catch (error) {
      console.error('[LLM Query] Initialization error:', error);
    }

    if (!state.llmReady) {
      console.warn('[LLM Query] LLM not available - falling back to search');
      const searchResults = await handleQuery(query, filter);
      return { answer: 'Gemini Nano not available. Here are the search results instead.', sources: searchResults, metadata: { llmReady: false } };
    }
    console.log('[LLM Query] Gemini Nano initialized successfully');
  }

  try {
    console.log('[LLM Query] Processing:', query);
    const tokenBudget = new TokenBudgetManager(6000, 768);
    const searchResults = await handleQuery(query, filter);

    if (searchResults.length === 0) {
      return { answer: 'No relevant content found in your browsing history.', sources: [], metadata: { tokensUsed: 0 } };
    }

    const queryTokens = await estimateTokens(query);
    tokenBudget.recordUsage(queryTokens);

    const maxChunks = tokenBudget.getMaxChunks(500);
    const selectedResults = searchResults.slice(0, Math.min(maxChunks, 5));
    console.log(`[LLM Query] Using ${selectedResults.length} chunks (budget allows ${maxChunks})`);

    const contextParts = selectedResults.map((r, i) =>
      `[Source ${i + 1}] ${r.title}\n${r.text.substring(0, 2000)}`
    );
    const context = contextParts.join('\n\n---\n\n');

    const contextTokens = await estimateTokens(context);
    console.log(`[LLM Query] Context: ${contextTokens} tokens`);

    if (!tokenBudget.canAfford(contextTokens)) {
      console.warn('[LLM Query] Context too large, reducing chunks...');
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
    return await generateLLMAnswer(query, context, selectedResults, tokenBudget);
  } catch (error) {
    console.error('[LLM Query] Failed:', error);
    return { answer: `Error generating answer: ${error.message}`, sources: [], metadata: { error: error.message } };
  }
}

async function generateLLMAnswer(query, context, sources, tokenBudget) {
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

  const maxAnswerTokens = tokenBudget.getRecommendedMaxTokens();
  console.log(`[LLM Query] Generating answer (budget allows ${maxAnswerTokens} tokens)...`);

  const startTime = Date.now();
  const answer = await generateText(systemPrompt, { temperature: 0.3 });
  const elapsed = Date.now() - startTime;

  console.log(`[LLM Query] Answer generated in ${elapsed}ms`);
  console.log(`[LLM Query] Raw answer:`, answer.substring(0, 200));

  let cleanAnswer = answer.trim();
  if (cleanAnswer.startsWith('Answer:')) cleanAnswer = cleanAnswer.substring(7).trim();

  const answerTokens = estimateTokens(cleanAnswer);
  tokenBudget.recordUsage(answerTokens);

  const budgetSummary = tokenBudget.getSummary();
  console.log(`[LLM Query] Final budget: ${budgetSummary.used}/${budgetSummary.total} tokens (${budgetSummary.percentUsed}%)`);

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

export function register(handlers) {
  handlers['CAPTURE_PAGE'] = async (msg, sender) => {
    await handlePageCapture(msg.data, sender.tab);
    return { success: true };
  };

  handlers['QUERY'] = async (msg) => {
    const results = await handleQuery(msg.query, msg.filter);
    return { results };
  };

  handlers['STRUCTURED_QUERY'] = async (msg) => {
    const results = await structDB.query(msg.options || {});
    return { results };
  };

  handlers['GET_STATS'] = async () => {
    return await getStats();
  };

  handlers['QUERY_LLM'] = async (msg) => {
    const result = await handleLLMQuery(msg.query, msg.filter);
    return { result };
  };
}
