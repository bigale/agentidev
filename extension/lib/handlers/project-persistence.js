/**
 * Project Persistence handlers — IndexedDB CRUD for Agentiface projects.
 * Separate database 'sc-projects' to avoid version conflicts.
 *
 * Project record schema:
 * {
 *   id: 'proj_{timestamp}_{random4}',
 *   name: string,
 *   description: string,
 *   skin: string,
 *   capabilities: object,
 *   config: { dataSources, layout } | null,
 *   prompt: string | null,
 *   type: 'generate' | 'clone' | null,
 *   sourceUrl: string | null,
 *   cloneId: string | null,
 *   createdAt: ISO string,
 *   updatedAt: ISO string,
 * }
 */

import * as bridgeClient from '../bridge-client.js';

const DB_NAME = 'sc-projects';
const DB_VERSION = 1;
const STORE_NAME = 'projects';

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
  return `proj_${Date.now()}_${rand}`;
}

// ---- Exported for direct import ----

/**
 * Save a project record (create or update by id).
 * @param {object} record - Partial project record (id optional for new projects)
 * @returns {Promise<object>} The saved project record with id
 */
export async function saveProject(record) {
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

/**
 * Load a project by ID from IndexedDB.
 * @param {string} id - Project ID
 * @returns {Promise<object|null>} The project record or null
 */
export async function loadProject(id) {
  const store = await getStore('readonly');
  return promisify(store.get(id));
}

// ---- Message handlers ----

async function handleSave(message) {
  try {
    const project = await saveProject(message);
    return { success: true, project };
  } catch (err) {
    console.error('[ProjectPersistence] Save error:', err);
    return { success: false, error: err.message };
  }
}

async function handleList() {
  try {
    const store = await getStore('readonly');
    const records = await promisify(store.getAll());
    records.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return { success: true, projects: records };
  } catch (err) {
    console.error('[ProjectPersistence] List error:', err);
    return { success: false, error: err.message };
  }
}

async function handleLoad(message) {
  const { id } = message;
  if (!id) return { success: false, error: 'id is required' };
  try {
    const store = await getStore('readonly');
    const project = await promisify(store.get(id));
    if (!project) return { success: false, error: `Project not found: ${id}` };
    return { success: true, project };
  } catch (err) {
    console.error('[ProjectPersistence] Load error:', err);
    return { success: false, error: err.message };
  }
}

async function handleDelete(message) {
  const { id } = message;
  if (!id) return { success: false, error: 'id is required' };
  try {
    const store = await getStore('readwrite');
    const project = await promisify(store.get(id));
    if (!project) return { success: false, error: `Project not found: ${id}` };

    await promisify(store.delete(id));

    // Also delete from bridge disk if connected
    if (bridgeClient.isConnected()) {
      try {
        await bridgeClient.afProjectDelete(id);
      } catch (e) {
        console.warn('[ProjectPersistence] Bridge delete failed (non-fatal):', e.message);
      }
    }

    return { success: true, id };
  } catch (err) {
    console.error('[ProjectPersistence] Delete error:', err);
    return { success: false, error: err.message };
  }
}

async function handleRename(message) {
  const { id, name } = message;
  if (!id) return { success: false, error: 'id is required' };
  if (!name || !name.trim()) return { success: false, error: 'name is required' };
  try {
    const store = await getStore('readwrite');
    const project = await promisify(store.get(id));
    if (!project) return { success: false, error: `Project not found: ${id}` };

    project.name = name.trim();
    project.updatedAt = new Date().toISOString();
    await promisify(store.put(project));

    return { success: true, project };
  } catch (err) {
    console.error('[ProjectPersistence] Rename error:', err);
    return { success: false, error: err.message };
  }
}

export function register(handlers) {
  handlers['SC_PROJECT_SAVE']   = (msg) => handleSave(msg);
  handlers['SC_PROJECT_LIST']   = ()    => handleList();
  handlers['SC_PROJECT_LOAD']   = (msg) => handleLoad(msg);
  handlers['SC_PROJECT_DELETE'] = (msg) => handleDelete(msg);
  handlers['SC_PROJECT_RENAME'] = (msg) => handleRename(msg);
}
