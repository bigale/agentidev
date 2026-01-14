/**
 * Simple Vector Database using IndexedDB
 *
 * Stores page content with embeddings and provides cosine similarity search.
 * This is a POC implementation - production would use LanceDB WASM.
 */

const DB_NAME = 'contextual-recall-db';
const DB_VERSION = 1;
const STORE_NAME = 'pages';

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

        // Create object store for pages
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
      metadata: pageData.metadata || {}
    };

    return new Promise((resolve, reject) => {
      const request = store.add(record);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Search for similar pages using cosine similarity
   */
  async search(queryEmbedding, options = {}) {
    const {
      limit = 10,
      filter = 'all',
      threshold = 0.5
    } = options;

    // Get all pages (for POC - production would use vector index)
    const pages = await this.getAllPages();

    // Filter by date/type if requested
    const filteredPages = this.applyFilters(pages, filter);

    // Calculate cosine similarity for each page
    const results = filteredPages.map(page => ({
      ...page,
      score: this.cosineSimilarity(queryEmbedding, page.embedding)
    }));

    // Sort by similarity score and filter by threshold
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
        contentType: r.contentType,
        chunkType: r.metadata?.chunkType || 'unknown',
        chunkIndex: r.metadata?.chunkIndex,
        chunkTotal: r.metadata?.chunkTotal
      }));
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) {
      console.warn('[VectorDB] Dimension mismatch:', a?.length, 'vs', b?.length);
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

    return {
      pagesIndexed: chunks.length, // Total chunks
      pagesUnique: uniqueUrls.size, // Unique pages
      storageUsed: storageBytes,
      queriesToday: queriesToday
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
