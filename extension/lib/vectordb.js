/**
 * Simple Vector Database using IndexedDB
 *
 * Stores page content with embeddings and provides cosine similarity search.
 * This is a POC implementation - production would use LanceDB WASM.
 *
 * v2: Added keywords multiEntry index and hybrid search scoring.
 * v3: Added source partitioning index for scoped queries.
 */

const DB_NAME = 'agentidev-db';
const DB_VERSION = 3;
const STORE_NAME = 'pages';

// Recency half-life: 1 week in milliseconds
const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

class VectorDB {
  constructor() {
    this.db = null;
  }

  /**
   * Initialize the database
   */
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const oldVersion = event.oldVersion;

        // v1: Create object store for pages
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, {
            keyPath: 'id',
            autoIncrement: true
          });

          // Create indexes
          store.createIndex('url', 'url', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('domain', 'domain', { unique: false });
          store.createIndex('contentType', 'contentType', { unique: false });
        }

        // v2: Add keywords multiEntry index
        if (oldVersion < 2) {
          const store = event.target.transaction.objectStore(STORE_NAME);
          if (!store.indexNames.contains('keywords')) {
            store.createIndex('keywords', 'keywords', { unique: false, multiEntry: true });
          }
        }

        // v3: Add source partitioning index
        if (oldVersion < 3) {
          const store = event.target.transaction.objectStore(STORE_NAME);
          if (!store.indexNames.contains('source')) {
            store.createIndex('source', 'source', { unique: false });
          }
        }
      };
    });
  }

  /**
   * Add a page with its embedding to the database
   */
  async addPage(pageData) {
    const transaction = this.db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    const record = {
      url: pageData.url,
      title: pageData.title,
      text: pageData.text,
      html: pageData.html,
      timestamp: pageData.timestamp || new Date().toISOString(),
      domain: new URL(pageData.url).hostname,
      contentType: pageData.contentType || 'unknown',
      embedding: pageData.embedding, // Float32Array or regular array
      keywords: pageData.keywords || [],
      metadata: pageData.metadata || {},
      source: pageData.source || 'browsing'
    };

    return new Promise((resolve, reject) => {
      const request = store.add(record);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get pages matching any of the given keywords using the multiEntry index.
   * Returns a Map of page id -> page record for deduplication.
   */
  async getPagesByKeywords(keywords) {
    if (!keywords || keywords.length === 0) return new Map();

    const transaction = this.db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('keywords');
    const pageMap = new Map();

    const fetches = keywords.map(kw => {
      return new Promise((resolve, reject) => {
        const request = index.getAll(kw.toLowerCase());
        request.onsuccess = () => {
          for (const page of request.result) {
            if (!pageMap.has(page.id)) {
              pageMap.set(page.id, page);
            }
          }
          resolve();
        };
        request.onerror = () => reject(request.error);
      });
    });

    await Promise.all(fetches);
    return pageMap;
  }

  /**
   * Get pages matching any of the given source values using the source index.
   * @param {string[]} sources - Source values to fetch (e.g. ['browsing', 'showcase'])
   * @returns {Promise<Array>}
   */
  async getPagesBySources(sources) {
    if (!sources || sources.length === 0) return this.getAllPages();

    const transaction = this.db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('source');
    const allPages = [];

    const fetches = sources.map(source =>
      new Promise((resolve, reject) => {
        const request = index.getAll(source);
        request.onsuccess = () => { allPages.push(...request.result); resolve(); };
        request.onerror = () => reject(request.error);
      })
    );

    await Promise.all(fetches);
    return allPages;
  }

  /**
   * Search for similar pages using hybrid scoring:
   *   finalScore = vectorScore * 0.7 + keywordScore * 0.2 + recencyScore * 0.1
   *
   * @param {Array} queryEmbedding - The query embedding vector
   * @param {object} options
   * @param {number} [options.limit=10]
   * @param {string} [options.filter='all'] - Time/type filter
   * @param {number} [options.threshold=0.5]
   * @param {string[]} [options.queryKeywords] - Keywords extracted from the query
   * @param {string} [options.domainFilter] - Restrict results to this domain
   * @param {string} [options.afterDate] - ISO date string, only return results after this date
   * @param {string[]} [options.sources] - Source partitions to search (e.g. ['browsing', 'showcase'])
   */
  async search(queryEmbedding, options = {}) {
    const {
      limit = 10,
      filter = 'all',
      threshold = 0.5,
      queryKeywords = [],
      domainFilter = null,
      afterDate = null,
      sources = null
    } = options;

    const hasKeywords = queryKeywords.length > 0;
    const now = Date.now();

    // Use source index when filtering by partition, otherwise full scan
    let pages = sources && sources.length > 0
      ? await this.getPagesBySources(sources)
      : await this.getAllPages();

    // If keywords provided, also fetch keyword-matched pages to ensure they're included
    // (they'll be in the full scan too, but this ensures scoring works)
    let keywordMatchedIds = new Set();
    if (hasKeywords) {
      const keywordPages = await this.getPagesByKeywords(queryKeywords);
      keywordMatchedIds = new Set(keywordPages.keys());
    }

    // Apply standard filters (time-based, content-type)
    pages = this.applyFilters(pages, filter);

    // Apply domain filter
    if (domainFilter) {
      pages = pages.filter(p => p.domain === domainFilter || p.domain?.endsWith('.' + domainFilter));
    }

    // Apply afterDate filter
    if (afterDate) {
      const cutoff = new Date(afterDate);
      pages = pages.filter(p => new Date(p.timestamp) >= cutoff);
    }

    // Calculate hybrid scores
    const results = pages.map(page => {
      const vectorScore = this.cosineSimilarity(queryEmbedding, page.embedding);

      // Keyword score: fraction of query keywords found in page keywords
      let keywordScore = 0;
      if (hasKeywords && page.keywords && page.keywords.length > 0) {
        const pageKwSet = new Set(page.keywords.map(k => k.toLowerCase()));
        const matchCount = queryKeywords.filter(qk => pageKwSet.has(qk.toLowerCase())).length;
        keywordScore = matchCount / queryKeywords.length;
      }

      // Recency score: exponential decay with 1-week half-life
      const pageTime = new Date(page.timestamp).getTime();
      const ageMs = Math.max(0, now - pageTime);
      const recencyScore = Math.pow(0.5, ageMs / RECENCY_HALF_LIFE_MS);

      // Hybrid score
      const finalScore = hasKeywords
        ? vectorScore * 0.7 + keywordScore * 0.2 + recencyScore * 0.1
        : vectorScore * 0.9 + recencyScore * 0.1;

      return { ...page, score: finalScore, vectorScore, keywordScore, recencyScore };
    });

    // Sort by final score and filter by threshold
    results.sort((a, b) => b.score - a.score);

    return results
      .filter(r => r.score >= threshold)
      .slice(0, limit)
      .map(r => ({
        id: r.id,
        url: r.url,
        title: r.title,
        text: r.text,
        snippet: this.generateSnippet(r.text),
        timestamp: r.timestamp,
        score: r.score,
        source: r.source || 'browsing',
        contentType: r.contentType,
        keywords: r.keywords || [],
        chunkType: r.metadata?.chunkType || 'unknown',
        chunkIndex: r.metadata?.chunkIndex,
        chunkTotal: r.metadata?.chunkTotal,
        metadata: r.metadata, // Include full metadata for filtering
        // Also include these for backward compatibility
        isReference: r.metadata?.isReference,
        domain: r.domain || r.metadata?.domain,
        section: r.metadata?.section
      }));
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /**
   * Apply filters (time-based, content-type)
   */
  applyFilters(pages, filter) {
    const now = new Date();
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
    const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    switch (filter) {
      case 'today':
        return pages.filter(p => new Date(p.timestamp) >= oneDayAgo);

      case 'week':
        return pages.filter(p => new Date(p.timestamp) >= oneWeekAgo);

      case 'specs':
        return pages.filter(p => p.contentType === 'spec' || p.contentType === 'api_reference');

      case 'docs':
        return pages.filter(p => p.contentType === 'documentation');

      case 'dashboards':
        return pages.filter(p => p.contentType === 'dashboard');

      default: // 'all'
        return pages;
    }
  }

  /**
   * Generate a snippet from text (first 200 chars)
   */
  generateSnippet(text) {
    if (!text) return '';
    const snippet = text.substring(0, 200);
    return snippet + (text.length > 200 ? '...' : '');
  }

  /**
   * Get all pages from the database
   */
  async getAllPages() {
    const transaction = this.db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);

    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get database statistics
   */
  async getStats() {
    const chunks = await this.getAllPages();

    // Calculate total storage (rough estimate)
    const storageBytes = chunks.reduce((total, chunk) => {
      return total +
        (chunk.text?.length || 0) +
        (chunk.html?.length || 0) +
        (chunk.embedding?.length || 0) * 4; // Float32 = 4 bytes
    }, 0);

    // Count unique pages (by URL)
    const uniqueUrls = new Set(chunks.map(c => c.url));

    // Count queries today
    const today = new Date().toDateString();
    const stats = await chrome.storage.local.get('stats');
    const queriesToday = stats.stats?.lastQueryDate === today
      ? stats.stats.queriesToday
      : 0;

    // Group by source partition
    const bySource = {};
    for (const chunk of chunks) {
      const src = chunk.source || 'browsing';
      bySource[src] = (bySource[src] || 0) + 1;
    }

    return {
      pagesIndexed: chunks.length, // Total chunks
      pagesUnique: uniqueUrls.size, // Unique pages
      storageUsed: storageBytes,
      queriesToday: queriesToday,
      bySource
    };
  }

  /**
   * Clear all data (for testing)
   */
  async clear() {
    const transaction = this.db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    return new Promise((resolve, reject) => {
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}

// Export singleton instance
export const vectorDB = new VectorDB();
