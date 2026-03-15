/**
 * App Persistence handlers — IndexedDB CRUD for saved SmartClient apps.
 * Separate database 'sc-apps' to avoid version conflicts with 'smartclient-data'.
 *
 * App record schema:
 * {
 *   id: 'app_{timestamp}_{random4}',
 *   name: string,
 *   type: 'generate' | 'clone',
 *   config: { dataSources, layout },
 *   prompt: string | null,
 *   sourceUrl: string | null,
 *   cloneId: string | null,
 *   createdAt: ISO string,
 *   updatedAt: ISO string,
 * }
 */

import * as bridgeClient from '../bridge-client.js';

const DB_NAME = 'sc-apps';
const DB_VERSION = 1;
const STORE_NAME = 'apps';

let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const _db = e.target.result;
      if (!_db.objectStoreNames.contains(STORE_NAME)) {
        const store = _db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

async function getStore(mode) {
  const _db = await openDB();
  const tx = _db.transaction(STORE_NAME, mode);
  return tx.objectStore(STORE_NAME);
}

function promisify(idbRequest) {
  return new Promise((resolve, reject) => {
    idbRequest.onsuccess = () => resolve(idbRequest.result);
    idbRequest.onerror = () => reject(idbRequest.error);
  });
}

function generateId() {
  const rand = Math.random().toString(36).slice(2, 6);
  return `app_${Date.now()}_${rand}`;
}

// ---- Exported for direct import ----

/**
 * Save an app record (create or update by id).
 * Called by smartclient-handlers.js after validateConfig() succeeds.
 * @param {object} record - Partial app record (id optional for new apps)
 * @returns {Promise<object>} The saved app record with id
 */
export async function saveApp(record) {
  const now = new Date().toISOString();
  const store = await getStore('readwrite');

  if (!record.id) {
    record.id = generateId();
    record.createdAt = now;
  }
  record.updatedAt = now;

  await promisify(store.put(record));
  return record;
}

// ---- Message handlers ----

async function handleSave(message) {
  try {
    const app = await saveApp(message);
    return { success: true, app };
  } catch (err) {
    console.error('[AppPersistence] Save error:', err);
    return { success: false, error: err.message };
  }
}

async function handleList() {
  try {
    const store = await getStore('readonly');
    const records = await promisify(store.getAll());
    // Sort by updatedAt descending
    records.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return { success: true, apps: records };
  } catch (err) {
    console.error('[AppPersistence] List error:', err);
    return { success: false, error: err.message };
  }
}

async function handleLoad(message) {
  const { id } = message;
  if (!id) return { success: false, error: 'id is required' };
  try {
    const store = await getStore('readonly');
    const app = await promisify(store.get(id));
    if (!app) return { success: false, error: `App not found: ${id}` };
    return { success: true, app };
  } catch (err) {
    console.error('[AppPersistence] Load error:', err);
    return { success: false, error: err.message };
  }
}

async function handleDelete(message) {
  const { id } = message;
  if (!id) return { success: false, error: 'id is required' };
  try {
    // Load first to check for cloneId
    const store = await getStore('readwrite');
    const app = await promisify(store.get(id));
    if (!app) return { success: false, error: `App not found: ${id}` };

    await promisify(store.delete(id));

    // Clean up disk artifacts for clones
    if (app.cloneId && bridgeClient.isConnected()) {
      try {
        await bridgeClient.deleteCloneArtifacts(app.cloneId);
      } catch (e) {
        console.warn('[AppPersistence] Clone artifact cleanup failed (non-fatal):', e.message);
      }
    }

    return { success: true, id };
  } catch (err) {
    console.error('[AppPersistence] Delete error:', err);
    return { success: false, error: err.message };
  }
}

async function handleRename(message) {
  const { id, name } = message;
  if (!id) return { success: false, error: 'id is required' };
  if (!name || !name.trim()) return { success: false, error: 'name is required' };
  try {
    const store = await getStore('readwrite');
    const app = await promisify(store.get(id));
    if (!app) return { success: false, error: `App not found: ${id}` };

    app.name = name.trim();
    app.updatedAt = new Date().toISOString();
    await promisify(store.put(app));

    return { success: true, app };
  } catch (err) {
    console.error('[AppPersistence] Rename error:', err);
    return { success: false, error: err.message };
  }
}

export function register(handlers) {
  handlers['SC_APP_SAVE']   = (msg) => handleSave(msg);
  handlers['SC_APP_LIST']   = ()    => handleList();
  handlers['SC_APP_LOAD']   = (msg) => handleLoad(msg);
  handlers['SC_APP_DELETE'] = (msg) => handleDelete(msg);
  handlers['SC_APP_RENAME'] = (msg) => handleRename(msg);
}
