/**
 * Structured Records Database
 *
 * Separate IndexedDB store for structured data extracted from HTML tables.
 * Follows the yaml-snapshot-store.js pattern (separate DB, singleton export).
 *
 * DB: 'struct-records-db' (version 1)
 * Stores: 'records' (extracted table rows), 'timeseries' (Phase 3 prep)
 */

const DB_NAME = 'struct-records-db';
const DB_VERSION = 1;
const RECORDS_STORE = 'records';
const TIMESERIES_STORE = 'timeseries';

class StructDB {
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

        // Records store: extracted structured data from tables
        if (!db.objectStoreNames.contains(RECORDS_STORE)) {
          const store = db.createObjectStore(RECORDS_STORE, {
            keyPath: 'id',
            autoIncrement: true
          });

          store.createIndex('sourceUrl', 'sourceUrl', { unique: false });
          store.createIndex('schemaType', 'schemaType', { unique: false });
          store.createIndex('domain', 'domain', { unique: false });
          store.createIndex('capturedAt', 'capturedAt', { unique: false });
          store.createIndex('entityKey', 'entityKey', { unique: false });
        }

        // Timeseries store: Phase 3 prep (empty for now)
        if (!db.objectStoreNames.contains(TIMESERIES_STORE)) {
          const store = db.createObjectStore(TIMESERIES_STORE, {
            keyPath: 'id',
            autoIncrement: true
          });

          store.createIndex('metricKey', 'metricKey', { unique: false });
          store.createIndex('capturedAt', 'capturedAt', { unique: false });
          store.createIndex('metricKey_capturedAt', ['metricKey', 'capturedAt'], { unique: false });
        }
      };
    });
  }

  /**
   * Add a single structured record
   * @param {object} data
   * @returns {Promise<number>} Record ID
   */
  async addRecord(data) {
    this._ensureDB();
    const transaction = this.db.transaction([RECORDS_STORE], 'readwrite');
    const store = transaction.objectStore(RECORDS_STORE);

    const record = {
      sourceUrl: data.sourceUrl,
      sourceChunkId: data.sourceChunkId || null,
      schemaType: data.schemaType || 'auto_table',
      fields: data.fields || {},
      headers: data.headers || [],
      domain: data.domain || '',
      entityKey: data.entityKey || null,
      capturedAt: data.capturedAt || new Date().toISOString()
    };

    return new Promise((resolve, reject) => {
      const request = store.add(record);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Add multiple structured records in a single transaction
   * @param {object[]} records
   * @returns {Promise<number[]>} Array of record IDs
   */
  async addRecords(records) {
    if (!records || records.length === 0) return [];
    this._ensureDB();

    const transaction = this.db.transaction([RECORDS_STORE], 'readwrite');
    const store = transaction.objectStore(RECORDS_STORE);
    const ids = [];

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve(ids);
      transaction.onerror = () => reject(transaction.error);

      for (const data of records) {
        const record = {
          sourceUrl: data.sourceUrl,
          sourceChunkId: data.sourceChunkId || null,
          schemaType: data.schemaType || 'auto_table',
          fields: data.fields || {},
          headers: data.headers || [],
          domain: data.domain || '',
          entityKey: data.entityKey || null,
          capturedAt: data.capturedAt || new Date().toISOString()
        };

        const request = store.add(record);
        request.onsuccess = () => ids.push(request.result);
      }
    });
  }

  /**
   * Query structured records with filters
   * @param {object} options
   * @param {string} [options.schemaType] - Filter by schema type
   * @param {string} [options.domain] - Filter by domain
   * @param {string} [options.afterDate] - ISO date string, only return records after this
   * @param {object} [options.fieldFilters] - Key-value pairs for field matching
   * @param {string} [options.sortBy] - Field name to sort by
   * @param {number} [options.limit=100] - Max results
   * @returns {Promise<object[]>}
   */
  async query(options = {}) {
    this._ensureDB();
    const {
      schemaType,
      domain,
      afterDate,
      fieldFilters,
      sortBy,
      limit = 100
    } = options;

    let records = await this._getAll(RECORDS_STORE);

    // Apply filters
    if (schemaType) {
      records = records.filter(r => r.schemaType === schemaType);
    }
    if (domain) {
      records = records.filter(r => r.domain === domain || r.domain?.endsWith('.' + domain));
    }
    if (afterDate) {
      const cutoff = new Date(afterDate);
      records = records.filter(r => new Date(r.capturedAt) >= cutoff);
    }

    // Field-level filtering (in-memory)
    if (fieldFilters && typeof fieldFilters === 'object') {
      records = records.filter(r => {
        for (const [key, value] of Object.entries(fieldFilters)) {
          const fieldVal = r.fields[key];
          if (fieldVal === undefined) return false;

          // Numeric comparison: support >, <, >=, <=
          if (typeof value === 'string') {
            const compMatch = value.match(/^([><]=?)(.+)$/);
            if (compMatch) {
              const op = compMatch[1];
              const num = parseFloat(compMatch[2]);
              const fieldNum = typeof fieldVal === 'number' ? fieldVal : parseFloat(fieldVal);
              if (isNaN(fieldNum) || isNaN(num)) return false;
              switch (op) {
                case '>': if (!(fieldNum > num)) return false; break;
                case '<': if (!(fieldNum < num)) return false; break;
                case '>=': if (!(fieldNum >= num)) return false; break;
                case '<=': if (!(fieldNum <= num)) return false; break;
              }
              continue;
            }
          }

          // Exact match (case-insensitive for strings)
          if (typeof fieldVal === 'string' && typeof value === 'string') {
            if (fieldVal.toLowerCase() !== value.toLowerCase()) return false;
          } else if (fieldVal !== value) {
            return false;
          }
        }
        return true;
      });
    }

    // Sort
    if (sortBy && records.length > 0) {
      records.sort((a, b) => {
        const aVal = a.fields[sortBy];
        const bVal = b.fields[sortBy];
        if (typeof aVal === 'number' && typeof bVal === 'number') {
          return bVal - aVal; // Descending for numbers
        }
        return String(aVal || '').localeCompare(String(bVal || ''));
      });
    }

    return records.slice(0, limit);
  }

  /**
   * Get store statistics
   * @returns {Promise<object>}
   */
  async getStats() {
    this._ensureDB();
    const records = await this._getAll(RECORDS_STORE);

    const bySchemaType = {};
    const byDomain = {};

    for (const r of records) {
      bySchemaType[r.schemaType] = (bySchemaType[r.schemaType] || 0) + 1;
      if (r.domain) {
        byDomain[r.domain] = (byDomain[r.domain] || 0) + 1;
      }
    }

    return {
      totalRecords: records.length,
      bySchemaType,
      byDomain
    };
  }

  /**
   * Clear all data
   */
  async clear() {
    this._ensureDB();

    const transaction = this.db.transaction([RECORDS_STORE, TIMESERIES_STORE], 'readwrite');

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);

      transaction.objectStore(RECORDS_STORE).clear();
      transaction.objectStore(TIMESERIES_STORE).clear();
    });
  }

  // --- Internal ---

  _ensureDB() {
    if (!this.db) {
      throw new Error('StructDB not initialized. Call init() first.');
    }
  }

  async _getAll(storeName) {
    const transaction = this.db.transaction([storeName], 'readonly');
    const store = transaction.objectStore(storeName);

    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

// Export singleton instance
export const structDB = new StructDB();
