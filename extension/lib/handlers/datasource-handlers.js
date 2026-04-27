/**
 * DataSource handlers — IndexedDB CRUD for SmartClient DataSources.
 * Each DataSource ID maps to an IndexedDB object store in the 'smartclient-data' database.
 *
 * Bridge-backed DataSources: certain IDs (BridgeSessions, BridgeScripts, etc.)
 * route to bridge-client.js instead of IndexedDB.
 */
import * as bridgeClient from '../bridge-client.js';
import { getCommandLog } from './bridge-handlers.js';

const DB_NAME = 'smartclient-data';
const DB_VERSION = 1;

let db = null;

// ---- Bridge-backed DataSource registry ----

const BRIDGE_BACKENDS = {
  BridgeSessions: {
    listKey: 'sessions',
    list: () => bridgeClient.listSessions(),
    idField: 'id',
    add: (data) => bridgeClient.createSession(data.name, data),
    remove: (id) => bridgeClient.destroySession(id),
  },
  BridgeScripts: {
    listKey: 'scripts',
    list: () => bridgeClient.listScripts(),
    idField: 'scriptId',
  },
  BridgeSchedules: {
    listKey: 'schedules',
    list: () => bridgeClient.listSchedules(),
    idField: 'id',
    add: (data) => bridgeClient.createSchedule(data),
    update: (data) => bridgeClient.updateSchedule(data.id, data),
    remove: (id) => bridgeClient.deleteSchedule(id),
  },
  BridgeCommands: {
    listKey: 'log',
    list: () => ({ log: getCommandLog() }),
    idField: 'id',
  },
  // Run Plans flattened for TreeGrid: each plan is a parent row,
  // each step is a child row with parentId = plan.id.
  RunPlans: {
    listKey: 'rows',
    list: async () => {
      const reply = await bridgeClient.listRunPlans();
      const plans = reply?.plans || [];
      const rows = [];
      for (const plan of plans) {
        rows.push({
          id: plan.id,
          parentId: null,
          isPlan: true,
          name: plan.name,
          description: plan.description || '',
          enabled: plan.enabled,
          schedule: plan.schedule || null,
          stepCount: (plan.steps || []).length,
          updatedAt: plan.updatedAt,
        });
        for (const step of plan.steps || []) {
          rows.push({
            id: `${plan.id}::${step.id}`,
            parentId: plan.id,
            isPlan: false,
            name: step.script,
            stepId: step.id,
            script: step.script,
            args: Object.entries(step.args || {})
              .map(([k, v]) => `--${k}=${v}`)
              .join(' '),
            argsObj: step.args || {},
            enabled: step.enabled !== false,
            stopOnFailure: !!step.stopOnFailure,
          });
        }
      }
      return { rows };
    },
    idField: 'id',
  },
};

function applyCriteria(records, criteria) {
  if (!criteria || Object.keys(criteria).length === 0) return records;
  return records.filter((r) =>
    Object.entries(criteria).every(([k, v]) => r[k] === v)
  );
}

async function bridgeFetch(backend, criteria) {
  if (!bridgeClient.isConnected() && typeof backend.list !== 'function') {
    return { status: -1, data: 'Bridge server not connected' };
  }
  try {
    const result = await backend.list();
    let records = result[backend.listKey] || [];
    // Remap idField → id for SmartClient primary key consistency
    if (backend.idField && backend.idField !== 'id') {
      records = records.map((r) => ({ ...r, id: r[backend.idField] }));
    }
    records = applyCriteria(records, criteria);
    return { status: 0, data: records, totalRows: records.length };
  } catch (err) {
    console.error('[DS] Bridge fetch error:', err);
    return { status: -1, data: err.message };
  }
}

// ---- IndexedDB helpers ----

let _openDBPending = null;

function upgradeDB(storeName, currentVersion, resolve, reject) {
  const req = indexedDB.open(DB_NAME, currentVersion + 1);
  req.onupgradeneeded = (e) => {
    const _db = e.target.result;
    if (!_db.objectStoreNames.contains(storeName)) {
      _db.createObjectStore(storeName, { keyPath: 'id', autoIncrement: true });
    }
  };
  req.onsuccess = (e) => { db = e.target.result; resolve(db); };
  req.onerror = (e) => reject(e.target.error);
}

function openDB(storeName) {
  // Serialize concurrent openDB calls to prevent version race conditions
  if (_openDBPending) {
    return _openDBPending.then(() => openDB(storeName));
  }
  if (db && db.objectStoreNames.contains(storeName)) {
    return Promise.resolve(db);
  }

  _openDBPending = new Promise((resolve, reject) => {
    if (db) {
      const oldVersion = db.version;
      db.close();
      db = null;
      upgradeDB(storeName, oldVersion, resolve, reject);
    } else {
      // Probe current version with a versionless open, then close and reopen with +1
      const probe = indexedDB.open(DB_NAME);
      probe.onsuccess = (e) => {
        const probeDb = e.target.result;
        const currentVersion = probeDb.version;
        if (probeDb.objectStoreNames.contains(storeName)) {
          // Store already exists — just use this connection
          db = probeDb;
          resolve(db);
          return;
        }
        probeDb.close();
        upgradeDB(storeName, currentVersion, resolve, reject);
      };
      probe.onerror = (e) => reject(e.target.error);
    }
  }).finally(() => { _openDBPending = null; });

  return _openDBPending;
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
  const dsId = message.dataSource || 'default';
  const backend = BRIDGE_BACKENDS[dsId];
  if (backend) return bridgeFetch(backend, message.criteria);

  try {
    const store = await getStore(dsId, 'readonly');
    let records = await promisify(store.getAll());
    records = applyCriteria(records, message.criteria);
    return { status: 0, data: records, totalRows: records.length };
  } catch (err) {
    console.error('[DS] Fetch error:', err);
    return { status: -1, data: err.message };
  }
}

async function dsAdd(message) {
  const dsId = message.dataSource || 'default';
  const backend = BRIDGE_BACKENDS[dsId];
  if (backend) {
    if (!backend.add) return { status: -1, data: `${dsId} is read-only` };
    try {
      const result = await backend.add(message.data);
      return { status: 0, data: [result] };
    } catch (err) {
      console.error('[DS] Bridge add error:', err);
      return { status: -1, data: err.message };
    }
  }

  try {
    const store = await getStore(dsId, 'readwrite');
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
  const dsId = message.dataSource || 'default';
  const backend = BRIDGE_BACKENDS[dsId];
  if (backend) {
    if (!backend.update) return { status: -1, data: `${dsId} does not support update` };
    try {
      const result = await backend.update(message.data);
      return { status: 0, data: [result] };
    } catch (err) {
      console.error('[DS] Bridge update error:', err);
      return { status: -1, data: err.message };
    }
  }

  try {
    const store = await getStore(dsId, 'readwrite');
    const record = { ...message.data };
    await promisify(store.put(record));
    return { status: 0, data: [record] };
  } catch (err) {
    console.error('[DS] Update error:', err);
    return { status: -1, data: err.message };
  }
}

async function dsRemove(message) {
  const dsId = message.dataSource || 'default';
  const backend = BRIDGE_BACKENDS[dsId];
  if (backend) {
    if (!backend.remove) return { status: -1, data: `${dsId} does not support remove` };
    const id = message.data?.id ?? message.criteria?.id;
    try {
      const result = await backend.remove(id);
      return { status: 0, data: [result || { id }] };
    } catch (err) {
      console.error('[DS] Bridge remove error:', err);
      return { status: -1, data: err.message };
    }
  }

  try {
    const store = await getStore(dsId, 'readwrite');
    const id = message.data?.id ?? message.criteria?.id;
    await promisify(store.delete(id));
    return { status: 0, data: [{ id }] };
  } catch (err) {
    console.error('[DS] Remove error:', err);
    return { status: -1, data: err.message };
  }
}

export { dsAdd, dsFetch };

export function register(handlers) {
  handlers['DS_FETCH']  = (msg) => dsFetch(msg);
  handlers['DS_ADD']    = (msg) => dsAdd(msg);
  handlers['DS_UPDATE'] = (msg) => dsUpdate(msg);
  handlers['DS_REMOVE'] = (msg) => dsRemove(msg);
}
