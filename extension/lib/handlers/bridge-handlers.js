/**
 * Bridge (Playwright) message handlers.
 * Extracted from background.js lines 309-398.
 * Enhanced with command logging and broadcast forwarding (Phase 1).
 */
import * as bridgeClient from '../bridge-client.js';
import { upsertShimImport } from '../shim-utils.js';
import { dsAdd } from './datasource-handlers.js';
import { state } from '../init-state.js';
import { startPeriodicSync } from './sync-handlers.js';

// Command log: circular buffer for tracking all bridge commands
const commandLog = [];

export function getCommandLog() { return commandLog; }
const MAX_LOG = 200;

function logCommand(type, sessionId, request, source = 'extension') {
  const entry = {
    id: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type,
    sessionId,
    request,
    source,
    timestamp: Date.now(),
    status: 'running',
  };
  if (commandLog.length >= MAX_LOG) commandLog.shift();
  commandLog.push(entry);
  chrome.runtime.sendMessage({ type: 'AUTO_COMMAND_UPDATE', entry }).catch(() => {});
  return entry;
}

function completeCommand(entry, response, error) {
  entry.status = error ? 'error' : 'success';
  entry.response = error ? { error: error.message || String(error) } : response;
  entry.duration = Date.now() - entry.timestamp;
  chrome.runtime.sendMessage({ type: 'AUTO_COMMAND_UPDATE', entry }).catch(() => {});
}

// Wrap a bridge call with command logging
async function tracked(type, sessionId, request, fn) {
  const entry = logCommand(type, sessionId, request);
  try {
    const result = await fn();
    completeCommand(entry, result);
    return result;
  } catch (error) {
    completeCommand(entry, null, error);
    throw error;
  }
}

export function register(handlers) {
  handlers['BRIDGE_CONNECT'] = async (msg) => {
    await bridgeClient.connectToBridge(msg.port || 9876);
    return { success: true, connected: true };
  };

  handlers['BRIDGE_DISCONNECT'] = async () => {
    bridgeClient.disconnectFromBridge();
    return { success: true, connected: false };
  };

  handlers['BRIDGE_STATUS'] = async () => {
    return { connected: bridgeClient.isConnected() };
  };

  handlers['BRIDGE_CREATE_SESSION'] = async (msg) => {
    const result = await tracked('create_session', null, { name: msg.name }, () =>
      bridgeClient.createSession(msg.name, msg.options || {})
    );
    return { success: true, ...result };
  };
  handlers['SESSION_CREATE'] = handlers['BRIDGE_CREATE_SESSION'];

  handlers['BRIDGE_DESTROY_SESSION'] = async (msg) => {
    const sessionId = msg.sessionId || msg.id;
    const result = await tracked('destroy_session', sessionId, {}, () =>
      bridgeClient.destroySession(sessionId)
    );
    return { success: true, ...result };
  };
  handlers['SESSION_DESTROY'] = handlers['BRIDGE_DESTROY_SESSION'];

  handlers['BRIDGE_LIST_SESSIONS'] = async () => {
    const result = await bridgeClient.listSessions();
    return { success: true, ...result };
  };

  handlers['BRIDGE_SEND_COMMAND'] = async (msg) => {
    const result = await tracked('command', msg.sessionId, { command: msg.command }, () =>
      bridgeClient.sendCommand(msg.sessionId, msg.command)
    );
    return { success: true, ...result };
  };

  handlers['BRIDGE_TAKE_SNAPSHOT'] = async (msg) => {
    const result = await tracked('snapshot', msg.sessionId, {}, () =>
      bridgeClient.takeSnapshot(msg.sessionId)
    );

    // Also store snapshot in vector DB for intelligence layer
    if (result.yaml) {
      try {
        // Import dynamically to avoid circular dependency
        const { handleSnapshotStorage } = await import('./snapshot-handlers.js');
        await handleSnapshotStorage(msg.sessionId, result.yaml, result.url);
      } catch (err) {
        console.warn('[Background] Snapshot storage failed (non-fatal):', err.message);
      }
    }
    return { success: true, ...result };
  };

  handlers['BRIDGE_NAVIGATE'] = async (msg) => {
    const result = await tracked('navigate', msg.sessionId, { url: msg.url }, () =>
      bridgeClient.navigateSession(msg.sessionId, msg.url)
    );
    return { success: true, ...result };
  };

  handlers['BRIDGE_CLICK'] = async (msg) => {
    const result = await tracked('click', msg.sessionId, { ref: msg.ref }, () =>
      bridgeClient.clickRef(msg.sessionId, msg.ref)
    );
    return { success: true, ...result };
  };

  handlers['BRIDGE_FILL'] = async (msg) => {
    const result = await tracked('fill', msg.sessionId, { ref: msg.ref, value: msg.value }, () =>
      bridgeClient.fillRef(msg.sessionId, msg.ref, msg.value)
    );
    return { success: true, ...result };
  };

  handlers['BRIDGE_EVAL'] = async (msg) => {
    const result = await tracked('eval', msg.sessionId, { expr: msg.expr }, () =>
      bridgeClient.evalInSession(msg.sessionId, msg.expr)
    );
    return { success: true, ...result };
  };

  // Command log retrieval
  handlers['GET_COMMAND_LOG'] = async () => {
    return { log: commandLog };
  };

  // System process discovery and kill
  handlers['SYSTEM_PROCESSES'] = async () => {
    if (!bridgeClient.isConnected()) {
      return { success: false, error: 'Not connected to bridge', processes: [] };
    }
    const result = await bridgeClient.getSystemProcesses();
    return { success: true, ...result };
  };

  handlers['KILL_PROCESS'] = async (msg) => {
    if (!bridgeClient.isConnected()) {
      return { success: false, error: 'Not connected to bridge' };
    }
    const result = await bridgeClient.killProcess(msg.pid);
    return { success: true, ...result };
  };

  // Native file picker (via bridge → powershell.exe)
  handlers['FILE_PICKER'] = async (msg) => {
    if (!bridgeClient.isConnected()) {
      return { success: false, error: 'Not connected to bridge' };
    }
    const result = await bridgeClient.filePicker({ title: msg.title, filter: msg.filter });
    return { success: true, ...result };
  };

  // Read a local file from the host filesystem via the bridge server
  handlers['BRIDGE_READ_FILE'] = async (msg) => {
    if (!bridgeClient.isConnected()) {
      return { success: false, error: 'Not connected to bridge' };
    }
    return bridgeClient.readFile(msg.path, msg.encoding || 'text');
  };

  // Copy a local file to the asset-server root
  handlers['BRIDGE_COPY_TO_ASSETS'] = async (msg) => {
    if (!bridgeClient.isConnected()) {
      return { success: false, error: 'Not connected to bridge' };
    }
    return bridgeClient.copyToAssets(msg.src, msg.dest);
  };

  // Bridge info (scripts dir, shim path)
  handlers['BRIDGE_GET_INFO'] = async () => {
    return {
      success: true,
      shimPath: bridgeClient.getShimPath(),
      scriptsDir: bridgeClient.getScriptsDir(),
      connected: bridgeClient.isConnected(),
    };
  };

  // Script source file loading (for Monaco dashboard)
  handlers['SCRIPT_GET_SOURCE'] = async (msg) => {
    if (!bridgeClient.isConnected()) {
      return { success: false, error: 'Not connected to bridge' };
    }
    const result = await bridgeClient.getScriptSource(msg.path);
    return { success: true, ...result };
  };

  // Report viewer — load HTML file from disk
  handlers['REPORT_LOAD'] = async (msg) => {
    if (!bridgeClient.isConnected()) {
      return { success: false, error: 'Not connected to bridge' };
    }
    const result = await bridgeClient.getScriptSource(msg.path);
    return { success: true, ...result };
  };
}

/**
 * Set up bridge event callbacks that forward broadcasts to extension UIs.
 * Called once during background initialization.
 */
export function initBridgeCallbacks(snapshotStorageFn, deps = {}) {
  bridgeClient.onSnapshotReceived(async (data) => {
    console.log(`[Background] Snapshot broadcast received (${data.lines} lines)`);
    // Forward to sidepanel
    chrome.runtime.sendMessage({ type: 'AUTO_BROADCAST_SNAPSHOT', ...data }).catch(() => {});
    // Also store
    if (data.yaml && data.url) {
      try {
        await snapshotStorageFn(data.sessionId, data.yaml, data.url);
      } catch (err) {
        console.warn('[Background] Auto-store snapshot failed:', err.message);
      }
    }
  });

  bridgeClient.onStatusChange((data) => {
    console.log(`[Background] Bridge status: session=${data.sessionId} state=${data.state}`);
    chrome.runtime.sendMessage({ type: 'AUTO_BROADCAST_STATUS', ...data }).catch(() => {});
  });

  bridgeClient.onConnectionChange(async (data) => {
    console.log(`[Background] Bridge connection: ${data.connected ? 'connected' : 'disconnected'}`);
    chrome.runtime.sendMessage({ type: 'AUTO_BROADCAST_CONNECTION', ...data }).catch(() => {});

    // Start periodic IDB sync for browser-only stores on first connect
    if (data.connected) startPeriodicSync();

    // Auto-sync all library scripts to disk on bridge connect
    if (data.connected) {
      try {
        const stored = await chrome.storage.local.get('bridge-scripts');
        const lib = stored['bridge-scripts'] || {};
        let dirty = false;

        // Migrate corrupted entries where name is a full path (Windows .split('/') bug)
        for (const name of Object.keys(lib)) {
          if (name.includes('/') || name.includes('\\')) {
            const safeName = name.split(/[/\\]/).pop().replace(/\.(mjs|js)$/, '');
            console.log(`[Background] Migrating corrupted library entry: "${name}" → "${safeName}"`);
            const entry = lib[name];
            entry.name = safeName;
            const shimPath = bridgeClient.getShimPath();
            if (shimPath) entry.source = upsertShimImport(entry.source, shimPath);
            lib[safeName] = entry;
            delete lib[name];
            dirty = true;
          }
        }
        if (dirty) await chrome.storage.local.set({ 'bridge-scripts': lib });

        const names = Object.keys(lib);
        if (names.length > 0) {
          console.log(`[Background] Auto-syncing ${names.length} library scripts to bridge...`);
          const shimPath = bridgeClient.getShimPath();
          for (const name of names) {
            try {
              const source = shimPath ? upsertShimImport(lib[name].source, shimPath) : lib[name].source;
              await bridgeClient.saveScript(name, source);
            } catch (err) {
              console.warn(`[Background] Failed to sync ${name}:`, err.message);
            }
          }
          console.log(`[Background] Library sync complete`);
        }
      } catch (err) {
        console.warn('[Background] Library sync failed:', err.message);
      }
    }
  });

  bridgeClient.onSearchRequest(async (query, options) => {
    console.log(`[Background] Bridge search request: "${query}"`);
    const { handleSnapshotSearch } = await import('./snapshot-handlers.js');
    return handleSnapshotSearch(query, options);
  });

  if (deps.generateEmbedding && deps.vectorDB) {
    bridgeClient.onSearchVectorDB(async (payload) => {
      const { query, limit, threshold, queryKeywords, sources } = payload;
      console.log(`[Background] VectorDB search: "${query}"${sources ? ` [sources: ${sources.join(',')}]` : ''}`);

      let embedding;
      if (deps.isInitialized()) {
        try {
          embedding = await deps.generateEmbedding(query);
        } catch (err) {
          console.error('[Background] Neural embedding failed for search, using TF-IDF:', err);
          embedding = deps.generateSimpleEmbedding(query);
        }
      } else {
        embedding = deps.generateSimpleEmbedding(query);
      }

      const results = await deps.vectorDB.search(embedding, {
        limit: limit || 10,
        threshold: threshold || (deps.isInitialized() ? 0.3 : 0.1),
        queryKeywords: queryKeywords || [],
        sources: sources || null,
      });

      return results;
    });

    bridgeClient.onIndexContent(async (payload) => {
      const { url, title, text, html, contentType, keywords, metadata } = payload;
      console.log(`[Background] Index content: "${title}"`);

      let embedding;
      if (deps.isInitialized()) {
        try {
          embedding = await deps.generateEmbedding(text);
        } catch (err) {
          console.error('[Background] Neural embedding failed, using TF-IDF:', err);
          embedding = deps.generateSimpleEmbedding(text);
        }
      } else {
        embedding = deps.generateSimpleEmbedding(text);
      }

      const id = await deps.vectorDB.addPage({
        url: url || `indexed://${Date.now()}`,
        title: title || 'Untitled',
        text: text || '',
        html: html || '',
        timestamp: Date.now(),
        contentType: contentType || 'general',
        embedding,
        keywords: keywords || [],
        metadata: metadata || {},
        source: payload.source || metadata?.source || 'reference',
      });

      return { success: true, id };
    });
  }

  bridgeClient.onScriptUpdate((data) => {
    console.log(`[Background] Script update: ${data.name} state=${data.state} ${data.step}/${data.total}`);
    chrome.runtime.sendMessage({ type: 'AUTO_BROADCAST_SCRIPT', ...data }).catch(() => {});
  });

  // V8 Inspector debug events → forward to dashboard
  bridgeClient.onDbgPaused((data) => {
    console.log(`[Background] V8 paused: ${data.file}:${data.line} (${data.reason})`);
    chrome.runtime.sendMessage({ type: 'AUTO_BROADCAST_DBG_PAUSED', ...data }).catch(() => {});
  });

  bridgeClient.onDbgResumed((data) => {
    console.log(`[Background] V8 resumed: ${data.scriptId}`);
    chrome.runtime.sendMessage({ type: 'AUTO_BROADCAST_DBG_RESUMED', ...data }).catch(() => {});
  });

  bridgeClient.onScheduleUpdate((data) => {
    console.log(`[Background] Schedule update: ${data.schedule?.name || data.scheduleId || 'unknown'}`);
    chrome.runtime.sendMessage({ type: 'AUTO_BROADCAST_SCHEDULE', ...data }).catch(() => {});
  });

  bridgeClient.onRunComplete(async (data) => {
    const { run, artifacts } = data;
    console.log(`[Background] Run complete: ${run?.name} (${run?.state}, ${artifacts?.length || 0} artifacts)`);
    // Persist run + artifacts to IndexedDB directly (chrome.runtime.sendMessage is SW-to-SW and fails in MV3)
    if (run && run.scriptId) {
      try {
        const runResp = await dsAdd({ dataSource: 'ScriptRuns', data: run });
        if (runResp.status !== 0) console.warn('[Background] Failed to save run:', runResp.data);
        else console.log(`[Background] Run saved to IndexedDB: ${run.name} (${run.scriptId})`);
      } catch (err) {
        console.warn('[Background] Failed to save run:', err.message);
      }
      if (Array.isArray(artifacts)) {
        for (const artifact of artifacts) {
          try {
            await dsAdd({
              dataSource: 'ScriptArtifacts',
              data: {
                runId: run.scriptId,
                type: artifact.type,
                timestamp: artifact.timestamp,
                label: artifact.label || '',
                data: artifact.data || null,
                diskPath: artifact.diskPath || null,
                size: artifact.size || 0,
                contentType: artifact.contentType || 'application/octet-stream',
              },
            });
          } catch (err) {
            console.warn('[Background] Failed to save artifact:', err.message);
          }
        }
      }
    }
    // Forward to dashboard UIs
    chrome.runtime.sendMessage({ type: 'AUTO_BROADCAST_RUN_COMPLETE', ...data }).catch(() => {});
  });

  bridgeClient.onArtifact((data) => {
    console.log(`[Background] Artifact: ${data.artifact?.label} (${data.artifact?.type})`);
    chrome.runtime.sendMessage({ type: 'AUTO_BROADCAST_ARTIFACT', ...data }).catch(() => {});
  });

  // IDB restore broadcast: bridge sends SQLite data → import into IndexedDB
  bridgeClient.onIdbRestore(async (data) => {
    const { stores } = data || {};
    if (!stores) return;
    console.log(`[Background] IDB restore broadcast received: ${Object.keys(stores).join(', ')}`);
    try {
      const { importStores } = await import('./sync-handlers.js');
      const result = await importStores(stores);
      console.log(`[Background] IDB restore complete: ${result.totalImported} records`);
      chrome.runtime.sendMessage({ type: 'AUTO_BROADCAST_IDB_RESTORED', result }).catch(() => {});
    } catch (err) {
      console.warn('[Background] IDB restore failed:', err.message);
    }
  });

  bridgeClient.onFileChanged(async (data) => {
    const { name, source, path, size, modifiedAt, deleted } = data;
    console.log(`[Background] File changed on disk: ${name} ${deleted ? '(deleted)' : `(${size} bytes)`}`);

    const STORAGE_KEY = 'bridge-scripts';
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const lib = stored[STORAGE_KEY] || {};

    if (deleted) {
      // Remove from library if it exists
      if (lib[name]) {
        delete lib[name];
        await chrome.storage.local.set({ [STORAGE_KEY]: lib });
      }
    } else {
      // Upsert into library with shim import
      const shimPath = bridgeClient.getShimPath();
      const shimmedSource = upsertShimImport(source, shimPath);
      lib[name] = {
        name,
        source: shimmedSource,
        originalPath: path,
        importedAt: lib[name]?.importedAt || Date.now(),
        modifiedAt: modifiedAt || Date.now(),
        size: shimmedSource.length,
      };
      await chrome.storage.local.set({ [STORAGE_KEY]: lib });
    }

    // Broadcast to dashboard/sidepanel UIs
    chrome.runtime.sendMessage({
      type: 'AUTO_BROADCAST_FILE_CHANGED',
      name, source, path, size, modifiedAt, deleted,
    }).catch(() => {});
  });
}
