/**
 * DataSource handlers — IndexedDB CRUD for SmartClient DataSources.
 * Each DataSource ID maps to an IndexedDB object store in the 'smartclient-data' database.
 */

const DB_NAME = 'smartclient-data';
const DB_VERSION = 1;

let db = null;

function openDB(storeName) {
  return new Promise((resolve, reject) => {
    if (db && db.objectStoreNames.contains(storeName)) {
      return resolve(db);
    }
    // Capture old version before closing
    const oldVersion = db ? db.version : 0;
    if (db) db.close();
    db = null;

    // First open: version 1. Adding a new store: increment version.
    const version = oldVersion ? oldVersion + 1 : DB_VERSION;
    const req = indexedDB.open(DB_NAME, version);
    req.onupgradeneeded = (e) => {
      const _db = e.target.result;
      if (!_db.objectStoreNames.contains(storeName)) {
        _db.createObjectStore(storeName, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

async function getStore(storeName, mode) {
  const _db = await openDB(storeName);
  const tx = _db.transaction(storeName, mode);
  return tx.objectStore(storeName);
}

function promisify(idbRequest) {
  return new Promise((resolve, reject) => {
    idbRequest.onsuccess = () => resolve(idbRequest.result);
    idbRequest.onerror = () => reject(idbRequest.error);
  });
}

// ---- Handlers ----

async function dsFetch(message) {
  const storeName = message.dataSource || 'default';
  try {
    const store = await getStore(storeName, 'readonly');
    const records = await promisify(store.getAll());
    return { status: 0, data: records, totalRows: records.length };
  } catch (err) {
    console.error('[DS] Fetch error:', err);
    return { status: -1, data: err.message };
  }
}

async function dsAdd(message) {
  const storeName = message.dataSource || 'default';
  try {
    const store = await getStore(storeName, 'readwrite');
    const record = { ...message.data };
    delete record.id; // let autoIncrement assign
    record.createdAt = record.createdAt || new Date().toISOString();
    const id = await promisify(store.add(record));
    return { status: 0, data: [{ ...record, id }] };
  } catch (err) {
    console.error('[DS] Add error:', err);
    return { status: -1, data: err.message };
  }
}

async function dsUpdate(message) {
  const storeName = message.dataSource || 'default';
  try {
    const store = await getStore(storeName, 'readwrite');
    const record = { ...message.data };
    await promisify(store.put(record));
    return { status: 0, data: [record] };
  } catch (err) {
    console.error('[DS] Update error:', err);
    return { status: -1, data: err.message };
  }
}

async function dsRemove(message) {
  const storeName = message.dataSource || 'default';
  try {
    const store = await getStore(storeName, 'readwrite');
    const id = message.data?.id ?? message.criteria?.id;
    await promisify(store.delete(id));
    return { status: 0, data: [{ id }] };
  } catch (err) {
    console.error('[DS] Remove error:', err);
    return { status: -1, data: err.message };
  }
}

export function register(handlers) {
  handlers['DS_FETCH']  = (msg) => dsFetch(msg);
  handlers['DS_ADD']    = (msg) => dsAdd(msg);
  handlers['DS_UPDATE'] = (msg) => dsUpdate(msg);
  handlers['DS_REMOVE'] = (msg) => dsRemove(msg);
}
