/**
 * YAML Snapshot Vector Store
 *
 * Separate IndexedDB store for playwright-cli YAML snapshots.
 * Mirrors vectordb.js pattern (cosine similarity, IndexedDB wrapping).
 * Stores chunked snapshot sections with embeddings for semantic retrieval.
 *
 * DB: 'yaml-snapshot-db' (version 1)
 * Store: 'snapshots' (auto-increment)
 */

const DB_NAME = 'yaml-snapshot-db';
const DB_VERSION = 2;
const STORE_NAME = 'snapshots';

class YAMLSnapshotStore {
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

        let store;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          store = db.createObjectStore(STORE_NAME, {
            keyPath: 'id',
            autoIncrement: true,
          });

          store.createIndex('url', 'url', { unique: false });
          store.createIndex('sectionType', 'sectionType', { unique: false });
          store.createIndex('track', 'track', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('isStablePattern', 'isStablePattern', { unique: false });
          store.createIndex('urlPattern', 'urlPattern', { unique: false });
        }

        // v2: Add contentHash index for dedup
        if (oldVersion < 2) {
          if (!store) {
            store = event.target.transaction.objectStore(STORE_NAME);
          }
          if (!store.indexNames.contains('contentHash')) {
            store.createIndex('contentHash', 'contentHash', { unique: false });
          }
        }
      };
    });
  }

  /**
   * Store a snapshot chunk
   * @param {object} data
   * @param {string} data.url
   * @param {string} data.urlPattern
   * @param {string} data.track
   * @param {string} data.race
   * @param {string} data.sectionType
   * @param {string} data.yamlText
   * @param {string} data.textDescription
   * @param {Array|Float32Array} data.embedding
   * @param {object} [data.metadata]
   * @returns {Promise<number>} Record ID
   */
  async storeSnapshot(data) {
    this._ensureDB();
    const transaction = this.db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    const record = {
      url: data.url,
      urlPattern: data.urlPattern || '',
      track: data.track || null,
      race: data.race || null,
      sectionType: data.sectionType,
      yamlText: data.yamlText,
      textDescription: data.textDescription,
      embedding: data.embedding,
      contentHash: data.contentHash || null,
      timestamp: Date.now(),
      isStablePattern: false,
      metadata: data.metadata || {},
    };

    return new Promise((resolve, reject) => {
      const request = store.add(record);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Search for similar snapshots using cosine similarity
   * @param {Array|Float32Array} queryEmbedding
   * @param {object} [options]
   * @param {number} [options.limit=5]
   * @param {string} [options.sectionType] - Filter by section type
   * @param {boolean} [options.stableOnly] - Only return stable patterns
   * @param {number} [options.threshold=0.3]
   * @returns {Promise<Array>}
   */
  async search(queryEmbedding, options = {}) {
    this._ensureDB();
    const {
      limit = 5,
      sectionType = null,
      stableOnly = false,
      threshold = 0.3,
    } = options;

    let records = await this._getAll();

    // Apply filters
    if (sectionType) {
      records = records.filter(r => r.sectionType === sectionType);
    }
    if (stableOnly) {
      records = records.filter(r => r.isStablePattern);
    }

    // Calculate similarity
    const results = records.map(r => ({
      ...r,
      score: this._cosineSimilarity(queryEmbedding, r.embedding),
    }));

    // Sort: stable patterns first (priority), then by score
    results.sort((a, b) => {
      if (a.isStablePattern !== b.isStablePattern) {
        return a.isStablePattern ? -1 : 1;
      }
      return b.score - a.score;
    });

    return results
      .filter(r => r.score >= threshold)
      .slice(0, limit)
      .map(r => ({
        id: r.id,
        url: r.url,
        sectionType: r.sectionType,
        track: r.track,
        race: r.race,
        yamlText: r.yamlText,
        textDescription: r.textDescription,
        score: r.score,
        isStablePattern: r.isStablePattern,
        timestamp: r.timestamp,
        metadata: r.metadata,
      }));
  }

  /**
   * Get cached structure for a URL and section type
   * Returns the most recent matching record
   * @param {string} url
   * @param {string} sectionType
   * @returns {Promise<object|null>}
   */
  async getCachedStructure(url, sectionType) {
    this._ensureDB();
    const records = await this._getAll();

    const urlPattern = url.replace(/\/\d+/g, '/*').replace(/\?.*$/, '');

    const matches = records
      .filter(r =>
        (r.url === url || r.urlPattern === urlPattern) &&
        r.sectionType === sectionType
      )
      .sort((a, b) => {
        // Prefer stable patterns, then most recent
        if (a.isStablePattern !== b.isStablePattern) {
          return a.isStablePattern ? -1 : 1;
        }
        return b.timestamp - a.timestamp;
      });

    if (matches.length > 0) {
      const match = matches[0];
      return {
        found: true,
        yamlText: match.yamlText,
        textDescription: match.textDescription,
        isStablePattern: match.isStablePattern,
        timestamp: match.timestamp,
      };
    }

    return { found: false };
  }

  /**
   * Mark a record as a stable pattern
   * @param {number} id
   */
  async markAsStablePattern(id) {
    this._ensureDB();
    const transaction = this.db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    return new Promise((resolve, reject) => {
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const record = getReq.result;
        if (record) {
          record.isStablePattern = true;
          const putReq = store.put(record);
          putReq.onsuccess = () => resolve(true);
          putReq.onerror = () => reject(putReq.error);
        } else {
          resolve(false);
        }
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  /**
   * Get all records matching a URL pattern
   * @param {string} pattern
   * @returns {Promise<Array>}
   */
  async getByUrlPattern(pattern) {
    this._ensureDB();
    const transaction = this.db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('urlPattern');

    return new Promise((resolve, reject) => {
      const request = index.getAll(pattern);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get store statistics
   * @returns {Promise<object>}
   */
  async getStats() {
    this._ensureDB();
    const records = await this._getAll();

    const bySection = {};
    const byTrack = {};
    let stableCount = 0;

    for (const r of records) {
      bySection[r.sectionType] = (bySection[r.sectionType] || 0) + 1;
      if (r.track) byTrack[r.track] = (byTrack[r.track] || 0) + 1;
      if (r.isStablePattern) stableCount++;
    }

    return {
      totalRecords: records.length,
      stablePatterns: stableCount,
      bySection,
      byTrack,
    };
  }

  /**
   * Clear all data
   */
  async clear() {
    this._ensureDB();
    const transaction = this.db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    return new Promise((resolve, reject) => {
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Find an existing record by content hash, URL pattern, and section type
   * @param {string} urlPattern
   * @param {string} sectionType
   * @param {number} contentHash
   * @returns {Promise<object|null>} Matching record or null
   */
  async findByHash(urlPattern, sectionType, contentHash) {
    this._ensureDB();
    const transaction = this.db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('contentHash');

    return new Promise((resolve, reject) => {
      const request = index.getAll(contentHash);
      request.onsuccess = () => {
        const match = request.result.find(
          r => r.urlPattern === urlPattern && r.sectionType === sectionType
        );
        resolve(match || null);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Update the timestamp of an existing record without re-storing
   * @param {number} id - Record ID
   * @returns {Promise<boolean>}
   */
  async updateTimestamp(id) {
    this._ensureDB();
    const transaction = this.db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    return new Promise((resolve, reject) => {
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const record = getReq.result;
        if (record) {
          record.timestamp = Date.now();
          const putReq = store.put(record);
          putReq.onsuccess = () => resolve(true);
          putReq.onerror = () => reject(putReq.error);
        } else {
          resolve(false);
        }
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  // --- Internal ---

  _ensureDB() {
    if (!this.db) {
      throw new Error('Snapshot store not initialized. Call init() first.');
    }
  }

  async _getAll() {
    const transaction = this.db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);

    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  _cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;

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
export const yamlSnapshotStore = new YAMLSnapshotStore();
