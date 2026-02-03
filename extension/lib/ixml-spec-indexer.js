/**
 * IXML Specification Indexer
 *
 * Fetches and indexes the Invisible XML specification for RAG-enhanced grammar generation.
 * The LLM can consult this when generating grammars to ensure correct syntax.
 *
 * Phase 2.1 Enhancement - Spec-aware grammar generation
 */

import { vectorDB } from './vectordb.js';
import { generateEmbedding } from './embeddings.js';

console.log('[IXML Spec] Module loaded');

const IXML_SPEC_URL = 'https://invisiblexml.org/1.0/';
const SPEC_CACHE_KEY = 'ixml_spec_indexed';

/**
 * Fetch and index the IXML specification
 *
 * @returns {Promise<Object>} Indexing result
 */
export async function indexIXMLSpec() {
  console.log('[IXML Spec] Fetching specification from:', IXML_SPEC_URL);

  try {
    // Check if already indexed
    const cached = await chrome.storage.local.get([SPEC_CACHE_KEY]);
    if (cached[SPEC_CACHE_KEY]) {
      const cacheAge = Date.now() - cached[SPEC_CACHE_KEY].timestamp;
      const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days

      if (cacheAge < maxAge) {
        console.log('[IXML Spec] Already indexed (age:', Math.round(cacheAge / (24 * 60 * 60 * 1000)), 'days)');
        return {
          success: true,
          cached: true,
          chunkCount: cached[SPEC_CACHE_KEY].chunkCount,
          timestamp: cached[SPEC_CACHE_KEY].timestamp
        };
      }
    }

    // Fetch the spec
    const response = await fetch(IXML_SPEC_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    console.log('[IXML Spec] Fetched HTML (length:', html.length, 'bytes)');

    // Extract relevant sections (text-based, no DOMParser needed in service worker)
    const chunks = extractSpecChunks(html);
    console.log('[IXML Spec] Extracted', chunks.length, 'chunks from spec');

    // Index chunks into vector DB
    const indexedCount = await indexChunks(chunks);

    // Cache indexing status
    await chrome.storage.local.set({
      [SPEC_CACHE_KEY]: {
        timestamp: Date.now(),
        chunkCount: indexedCount,
        url: IXML_SPEC_URL
      }
    });

    console.log('[IXML Spec] ✓ Indexed', indexedCount, 'chunks');

    return {
      success: true,
      cached: false,
      chunkCount: indexedCount,
      timestamp: Date.now()
    };

  } catch (error) {
    console.error('[IXML Spec] Failed to index:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Extract meaningful chunks from IXML spec HTML (text-based, no DOM parsing)
 *
 * @param {string} html - Raw HTML content
 * @returns {Array<Object>} Chunks with text and metadata
 */
function extractSpecChunks(html) {
  const chunks = [];

  // Try multiple extraction strategies

  // Strategy 1: Extract by <section> tags
  let sectionPattern = /<section[^>]*>([\s\S]*?)<\/section>/gi;
  let sections = [...html.matchAll(sectionPattern)];

  // Strategy 2: If no sections found, try <div> with id attributes
  if (sections.length === 0) {
    console.log('[IXML Spec] No <section> tags found, trying <div id="...">');
    sectionPattern = /<div[^>]*id="[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    sections = [...html.matchAll(sectionPattern)];
  }

  // Strategy 3: If still nothing, extract by headings
  if (sections.length === 0) {
    console.log('[IXML Spec] No sections found, extracting by headings');
    return extractByHeadings(html);
  }

  console.log('[IXML Spec] Found', sections.length, 'sections');

  sections.forEach((match, index) => {
    const sectionHTML = match[1];

    // Extract heading
    const headingMatch = sectionHTML.match(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/i);
    const title = headingMatch ? stripTags(headingMatch[1]).trim() : `Section ${index + 1}`;

    // Extract section ID if present
    const idMatch = match[0].match(/id="([^"]+)"/);
    const sectionId = idMatch ? idMatch[1] : '';

    // Extract code blocks separately
    const codePattern = /<(?:pre|code)[^>]*>([\s\S]*?)<\/(?:pre|code)>/gi;
    const codeBlocks = [...sectionHTML.matchAll(codePattern)];

    codeBlocks.forEach((codeMatch, codeIndex) => {
      const codeText = stripTags(codeMatch[1]).trim();
      if (codeText.length < 10) {
        return;
      }

      chunks.push({
        text: codeText,
        metadata: {
          type: 'code_example',
          section: title,
          url: IXML_SPEC_URL + (sectionId ? '#' + sectionId : ''),
          title: `${title} - Example ${codeIndex + 1}`,
          domain: 'invisiblexml.org',
          isReference: true,
          timestamp: new Date().toISOString()
        }
      });
    });

    // Get section text content (strip all HTML tags)
    let text = stripTags(sectionHTML)
      .replace(/\s+/g, ' ')
      .trim();

    // Skip empty or very short sections
    if (text.length < 50) {
      return;
    }

    // Split long sections into smaller chunks
    const maxChunkSize = 1000;
    if (text.length > maxChunkSize) {
      // Split by sentences
      const sentences = text.split(/\.\s+/);
      let currentChunk = '';

      sentences.forEach(sentence => {
        if (currentChunk.length + sentence.length > maxChunkSize) {
          if (currentChunk) {
            chunks.push({
              text: currentChunk.trim(),
              metadata: {
                type: 'spec_section',
                section: title,
                url: IXML_SPEC_URL + (sectionId ? '#' + sectionId : ''),
                title: title,
                domain: 'invisiblexml.org',
                isReference: true,
                timestamp: new Date().toISOString()
              }
            });
          }
          currentChunk = sentence + '. ';
        } else {
          currentChunk += sentence + '. ';
        }
      });

      // Add remaining chunk
      if (currentChunk.trim()) {
        chunks.push({
          text: currentChunk.trim(),
          metadata: {
            type: 'spec_section',
            section: title,
            url: IXML_SPEC_URL + (sectionId ? '#' + sectionId : ''),
            title: title,
            domain: 'invisiblexml.org',
            isReference: true,
            timestamp: new Date().toISOString()
          }
        });
      }
    } else {
      chunks.push({
        text: text,
        metadata: {
          type: 'spec_section',
          section: title,
          url: IXML_SPEC_URL + (sectionId ? '#' + sectionId : ''),
          title: title,
          domain: 'invisiblexml.org',
          isReference: true,
          timestamp: new Date().toISOString()
        }
      });
    }
  });

  return chunks;
}

/**
 * Extract chunks by splitting at headings (fallback strategy)
 *
 * @param {string} html - HTML content
 * @returns {Array<Object>} Chunks
 */
function extractByHeadings(html) {
  const chunks = [];

  // Split by h2 or h3 headings
  const headingPattern = /<h[23][^>]*>(.*?)<\/h[23]>/gi;
  const headings = [...html.matchAll(headingPattern)];

  console.log('[IXML Spec] Found', headings.length, 'headings');

  // Extract content between each heading and the next
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const title = stripTags(heading[1]).trim();

    const startPos = heading.index + heading[0].length;
    const endPos = i < headings.length - 1 ? headings[i + 1].index : html.length;

    const sectionHTML = html.substring(startPos, endPos);

    // Extract code blocks from this section
    const codePattern = /<(?:pre|code)[^>]*>([\s\S]*?)<\/(?:pre|code)>/gi;
    const codeBlocks = [...sectionHTML.matchAll(codePattern)];

    codeBlocks.forEach((codeMatch, codeIndex) => {
      const codeText = stripTags(codeMatch[1]).trim();
      if (codeText.length > 10) {
        chunks.push({
          text: codeText,
          metadata: {
            type: 'code_example',
            section: title,
            url: IXML_SPEC_URL,
            title: `${title} - Example ${codeIndex + 1}`,
            domain: 'invisiblexml.org',
            isReference: true,
            timestamp: new Date().toISOString()
          }
        });
      }
    });

    // Get text content
    const text = stripTags(sectionHTML).replace(/\s+/g, ' ').trim();

    if (text.length > 100) {
      // Split into chunks if too long
      const maxChunkSize = 800;
      if (text.length > maxChunkSize) {
        const sentences = text.split(/\.\s+/);
        let currentChunk = '';

        sentences.forEach(sentence => {
          if (currentChunk.length + sentence.length > maxChunkSize && currentChunk) {
            chunks.push({
              text: currentChunk.trim(),
              metadata: {
                type: 'spec_section',
                section: title,
                url: IXML_SPEC_URL,
                title: title,
                domain: 'invisiblexml.org',
                isReference: true,
                timestamp: new Date().toISOString()
              }
            });
            currentChunk = sentence + '. ';
          } else {
            currentChunk += sentence + '. ';
          }
        });

        if (currentChunk.trim()) {
          chunks.push({
            text: currentChunk.trim(),
            metadata: {
              type: 'spec_section',
              section: title,
              url: IXML_SPEC_URL,
              title: title,
              domain: 'invisiblexml.org',
              isReference: true,
              timestamp: new Date().toISOString()
            }
          });
        }
      } else {
        chunks.push({
          text: text,
          metadata: {
            type: 'spec_section',
            section: title,
            url: IXML_SPEC_URL,
            title: title,
            domain: 'invisiblexml.org',
            isReference: true,
            timestamp: new Date().toISOString()
          }
        });
      }
    }
  }

  return chunks;
}

/**
 * Strip HTML tags from string
 *
 * @param {string} html - HTML string
 * @returns {string} Plain text
 */
function stripTags(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remove scripts
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')   // Remove styles
    .replace(/<[^>]+>/g, '')                           // Remove all tags
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Index chunks into vector database
 *
 * @param {Array<Object>} chunks - Chunks to index
 * @returns {Promise<number>} Number of chunks indexed
 */
async function indexChunks(chunks) {
  let indexed = 0;

  for (const chunk of chunks) {
    try {
      // Generate embedding
      const embedding = await generateEmbedding(chunk.text);

      // Store in vector DB
      await vectorDB.add({
        id: `ixml_spec_${Date.now()}_${indexed}`,
        text: chunk.text,
        embedding: embedding,
        metadata: chunk.metadata
      });

      indexed++;

      // Progress logging every 10 chunks
      if (indexed % 10 === 0) {
        console.log('[IXML Spec] Indexed', indexed, '/', chunks.length, 'chunks');
      }

    } catch (error) {
      console.error('[IXML Spec] Failed to index chunk:', error);
      // Continue with other chunks
    }
  }

  return indexed;
}

/**
 * Query IXML spec for relevant syntax information
 *
 * @param {string} query - Query string (e.g., "attribute syntax", "nonterminal rules")
 * @param {Object} options - Query options
 * @returns {Promise<Array<Object>>} Relevant spec sections
 */
export async function queryIXMLSpec(query, options = {}) {
  const {
    maxResults = 3,
    minScore = 0.3
  } = options;

  console.log('[IXML Spec] Querying spec for:', query);

  try {
    // Generate query embedding
    const queryEmbedding = await generateEmbedding(query);

    // Search vector DB with filter for spec content
    const results = await vectorDB.search(queryEmbedding, {
      limit: maxResults * 2, // Get more, then filter
      threshold: minScore
    });

    // Filter for IXML spec content only
    const specResults = results
      .filter(r => r.metadata?.isReference && r.metadata?.domain === 'invisiblexml.org')
      .slice(0, maxResults);

    console.log('[IXML Spec] Found', specResults.length, 'relevant sections');

    return specResults.map(r => ({
      text: r.text,
      section: r.metadata?.section,
      url: r.metadata?.url,
      score: r.score
    }));

  } catch (error) {
    console.error('[IXML Spec] Query failed:', error);
    return [];
  }
}

/**
 * Check if IXML spec is indexed
 *
 * @returns {Promise<Object>} Index status
 */
export async function getSpecIndexStatus() {
  try {
    const cached = await chrome.storage.local.get([SPEC_CACHE_KEY]);

    if (cached[SPEC_CACHE_KEY]) {
      const age = Date.now() - cached[SPEC_CACHE_KEY].timestamp;
      const ageDays = Math.round(age / (24 * 60 * 60 * 1000));

      return {
        indexed: true,
        chunkCount: cached[SPEC_CACHE_KEY].chunkCount,
        timestamp: cached[SPEC_CACHE_KEY].timestamp,
        ageDays: ageDays
      };
    }

    return {
      indexed: false
    };

  } catch (error) {
    console.error('[IXML Spec] Status check failed:', error);
    return {
      indexed: false,
      error: error.message
    };
  }
}

/**
 * Clear IXML spec from index
 *
 * @returns {Promise<Object>} Clear result
 */
export async function clearSpecIndex() {
  try {
    // Remove from storage
    await chrome.storage.local.remove([SPEC_CACHE_KEY]);

    // TODO: Remove from vector DB (would need to query by metadata filter)
    // For now, spec chunks will remain in DB but status will be reset

    console.log('[IXML Spec] Cleared spec index status');

    return {
      success: true
    };

  } catch (error) {
    console.error('[IXML Spec] Clear failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

console.log('[IXML Spec] Module ready');
