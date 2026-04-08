/**
 * IndexedDB backup / sync handlers.
 *
 * IDB_EXPORT  — serialize all (or named) IDB stores → send as BRIDGE_IDB_SYNC
 * IDB_IMPORT  — receive records from bridge → upsert into IndexedDB via dsAdd
 *
 * Periodic auto-export: every 15 minutes for Recipes + NotesDS.
 */
import * as bridgeClient from '../bridge-client.js';
import { dsAdd } from './datasource-handlers.js';

// Stores that only live in the browser (no automatic bridge-side equivalent)
const BROWSER_ONLY_STORES = ['Recipes', 'NotesDS'];

// All stores to include in a full manual export
const ALL_STORES = ['ScriptRuns', 'ScriptArtifacts', 'Recipes', 'NotesDS'];

// ---------------------------------------------------------------------------
// IndexedDB read helper (avoids importing the full datasource-handlers internals)
// ---------------------------------------------------------------------------

const DB_NAME = 'smartclient-data';

function readAllFromStore(storeName) {
  return new Promise((resolve, reject) => {
    const probe = indexedDB.open(DB_NAME);
    probe.onsuccess = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        resolve([]);
        return;
      }
      try {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => { db.close(); resolve(req.result || []); };
        req.onerror  = () => { db.close(); reject(req.error); };
      } catch (err) {
        db.close();
        reject(err);
      }
    };
    probe.onerror = (e) => reject(e.target.error);
  });
}

// ---------------------------------------------------------------------------
// Export: read IDB stores → send BRIDGE_IDB_SYNC
// ---------------------------------------------------------------------------

async function exportStores(storeNames) {
  if (!bridgeClient.isConnected()) {
    console.warn('[Sync] Not connected to bridge — skipping IDB export');
    return { success: false, error: 'Bridge not connected' };
  }

  const stores = {};
  for (const name of storeNames) {
    try {
      stores[name] = await readAllFromStore(name);
      console.log(`[Sync] Exporting "${name}": ${stores[name].length} records`);
    } catch (err) {
      console.warn(`[Sync] Failed to read "${name}": ${err.message}`);
      stores[name] = [];
    }
  }

  try {
    const result = await bridgeClient.sendRaw({ type: 'BRIDGE_IDB_SYNC', payload: { stores } });
    console.log(`[Sync] IDB export sent (${Object.values(stores).reduce((n, r) => n + r.length, 0)} total records)`);
    return result;
  } catch (err) {
    console.error('[Sync] IDB export failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Import: receive records from bridge → upsert into IndexedDB
// ---------------------------------------------------------------------------

export async function importStores(stores) {
  if (!stores || typeof stores !== 'object') {
    return { success: false, error: 'No stores payload' };
  }

  let totalImported = 0;
  const errors = [];

  for (const [storeName, records] of Object.entries(stores)) {
    if (!Array.isArray(records) || records.length === 0) continue;
    console.log(`[Sync] Importing "${storeName}": ${records.length} records`);
    for (const record of records) {
      try {
        await dsAdd({ dataSource: storeName, data: record });
        totalImported++;
      } catch (err) {
        errors.push(`${storeName}: ${err.message}`);
      }
    }
  }

  console.log(`[Sync] IDB import complete: ${totalImported} records imported`);
  return { success: errors.length === 0, totalImported, errors: errors.length ? errors : undefined };
}

// ---------------------------------------------------------------------------
// Register message handlers
// ---------------------------------------------------------------------------

export function register(handlers) {
  // Manual or auto full export — sends all stores to bridge SQLite
  handlers['IDB_EXPORT'] = async (msg) => {
    const storeNames = msg.stores || ALL_STORES;
    return exportStores(storeNames);
  };

  // Triggered by BRIDGE_IDB_RESTORE broadcast from bridge — import records
  handlers['IDB_IMPORT'] = async (msg) => {
    return importStores(msg.stores);
  };
}

// ---------------------------------------------------------------------------
// Periodic auto-export (every 15 min) for browser-only stores
// ---------------------------------------------------------------------------

let _periodicTimer = null;

export function startPeriodicSync(intervalMs = 15 * 60 * 1000) {
  if (_periodicTimer) return; // already running
  _periodicTimer = setInterval(async () => {
    if (!bridgeClient.isConnected()) return;
    console.log('[Sync] Periodic IDB auto-export starting...');
    await exportStores(BROWSER_ONLY_STORES);
  }, intervalMs);
  console.log(`[Sync] Periodic IDB sync scheduled every ${intervalMs / 1000}s`);
}

export function stopPeriodicSync() {
  if (_periodicTimer) {
    clearInterval(_periodicTimer);
    _periodicTimer = null;
  }
}
