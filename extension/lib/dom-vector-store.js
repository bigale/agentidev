/**
 * DOM Vector Store
 *
 * Specialized vector database for DOM elements
 * Uses separate IndexedDB database from page content
 */

const DOM_DB_NAME = 'dom-vector-db';
const DOM_DB_VERSION = 1;

class DOMVectorStore {
  constructor() {
    this.db = null;
  }

  /**
   * Initialize the database
   */
  async init() {
    if (this.db) return; // Already initialized

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DOM_DB_NAME, DOM_DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Create object store for DOM chunks
        // We'll use collection name as keyPath prefix (e.g., "dom-123-0")
        if (!db.objectStoreNames.contains('chunks')) {
          const store = db.createObjectStore('chunks', {
            keyPath: 'id'
          });

          // Create indexes
          store.createIndex('collection', 'collection', { unique: false });
          store.createIndex('type', 'type', { unique: false });
        }
      };
    });
  }

  /**
   * Store a chunk with its embedding
   * @param {string} collection - Collection name (e.g., "dom-123")
   * @param {Object} chunk - Chunk data
   * @param {Array} embedding - Vector embedding
   */
  async storeChunk(collection, chunk, embedding) {
    if (!this.db) await this.init();

    const transaction = this.db.transaction(['chunks'], 'readwrite');
    const store = transaction.objectStore('chunks');

    // Generate unique ID
    const id = `${collection}-${chunk.index || Date.now()}`;

    const record = {
      id,
      collection,
      ...chunk,
      embedding: Array.from(embedding) // Ensure it's a regular array
    };

    return new Promise((resolve, reject) => {
      const request = store.put(record); // Use put to allow updates
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Search chunks in a collection by vector similarity
   * @param {string} collection - Collection name
   * @param {Array} queryEmbedding - Query vector
   * @param {number} topK - Number of results
   */
  async searchChunks(collection, queryEmbedding, topK = 5) {
    if (!this.db) await this.init();

    // Get all chunks from collection
    const chunks = await this.getChunksByCollection(collection);

    if (chunks.length === 0) {
      return [];
    }

    // Calculate cosine similarity for each chunk
    const results = chunks.map(chunk => ({
      ...chunk,
      score: this.cosineSimilarity(queryEmbedding, chunk.embedding)
    }));

    // Sort by similarity and return top K
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, topK);
  }

  /**
   * Get all chunks from a collection
   */
  async getChunksByCollection(collection) {
    if (!this.db) await this.init();

    const transaction = this.db.transaction(['chunks'], 'readonly');
    const store = transaction.objectStore('chunks');
    const index = store.index('collection');

    return new Promise((resolve, reject) => {
      const request = index.getAll(collection);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear a collection
   */
  async clearCollection(collection) {
    if (!this.db) await this.init();

    const chunks = await this.getChunksByCollection(collection);

    const transaction = this.db.transaction(['chunks'], 'readwrite');
    const store = transaction.objectStore('chunks');

    return new Promise((resolve, reject) => {
      let deleted = 0;

      chunks.forEach(chunk => {
        const request = store.delete(chunk.id);
        request.onsuccess = () => {
          deleted++;
          if (deleted === chunks.length) {
            resolve(deleted);
          }
        };
        request.onerror = () => reject(request.error);
      });

      // Handle empty collection case
      if (chunks.length === 0) {
        resolve(0);
      }
    });
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
}

// Export singleton instance
export const domVectorStore = new DOMVectorStore();
