/**
 * Background Service Worker for Agentidev
 *
 * Responsibilities:
 * - Coordinate content capture from all tabs
 * - Manage vector database (IndexedDB for POC)
 * - Handle semantic queries from sidebar
 * - Generate embeddings (TF-IDF for POC, transformers.js later)
 * - Provide usage statistics
 *
 * Design: One-size-fits-all for personal and enterprise use
 */

import { vectorDB } from './lib/vectordb.js';
import { initEmbeddings, generateEmbedding, isInitialized } from './lib/embeddings.js';
import { checkAvailability, initSession, getStatus } from './lib/chrome-prompt-api.js';
import { structDB } from './lib/structdb.js';
import { yamlSnapshotStore } from './lib/yaml-snapshot-store.js';

// Shared initialization state
import { state } from './lib/init-state.js';

// Message router and handler modules
import { createMessageRouter } from './lib/message-router.js';
import { register as registerCapture } from './lib/handlers/capture-handlers.js';
import { register as registerExtract } from './lib/handlers/extract-handlers.js';
import { register as registerAgent } from './lib/handlers/agent-handlers.js';
import { register as registerGrammar } from './lib/handlers/grammar-handlers.js';
import { register as registerBridge, initBridgeCallbacks } from './lib/handlers/bridge-handlers.js';
import * as bridgeClient from './lib/bridge-client.js';
import { upsertShimImport } from './lib/shim-utils.js';
import { register as registerSnapshot, handleSnapshotStorage } from './lib/handlers/snapshot-handlers.js';
import { register as registerAutomation } from './lib/handlers/automation-handlers.js';
import { register as registerScript } from './lib/handlers/script-handlers.js';
import { register as registerDataSource } from './lib/handlers/datasource-handlers.js';
import { register as registerSmartClient } from './lib/handlers/smartclient-handlers.js';
import { register as registerAppPersistence } from './lib/handlers/app-persistence.js';
import { register as registerProjectPersistence } from './lib/handlers/project-persistence.js';
import { register as registerSync } from './lib/handlers/sync-handlers.js';
import { register as registerCheerpJ } from './lib/handlers/cheerpj-handlers.js';
import { register as registerCheerpX } from './lib/handlers/cheerpx-handlers.js';
import { register as registerHost } from './lib/handlers/host-handlers.js';
import { loadPlugins } from './lib/plugin-loader.js';

console.log('Agentidev: Background service worker started');
console.log('[Background] Note: Extension reload = re-initialize (models are cached, not re-downloaded)');

// ============================================================
// Example scripts — upsert bundled examples into library on each startup
// ============================================================

const EXAMPLE_SCRIPTS = [
  { name: 'duck_search', file: 'examples/duck_search.mjs' },
];

async function ensureExampleScripts() {
  try {
    const stored = await chrome.storage.local.get('bridge-scripts');
    const lib = stored['bridge-scripts'] || {};
    let changed = false;
    for (const ex of EXAMPLE_SCRIPTS) {
      if (lib[ex.name]) continue; // User has it (possibly edited) — don't overwrite
      const resp = await fetch(chrome.runtime.getURL(ex.file));
      if (!resp.ok) { console.warn(`[Background] Example ${ex.file} not found`); continue; }
      const source = await resp.text();
      lib[ex.name] = {
        name: ex.name,
        source,
        originalPath: ex.file,
        importedAt: Date.now(),
        modifiedAt: Date.now(),
        size: source.length,
      };
      changed = true;
    }
    if (changed) {
      await chrome.storage.local.set({ 'bridge-scripts': lib });
      console.log('[Background] ✓ Example scripts loaded into library');
      // Sync new examples to disk if bridge is already connected
      if (bridgeClient.isConnected()) {
        const shimPath = bridgeClient.getShimPath();
        for (const ex of EXAMPLE_SCRIPTS) {
          if (lib[ex.name]) {
            const src = shimPath ? upsertShimImport(lib[ex.name].source, shimPath) : lib[ex.name].source;
            try { await bridgeClient.saveScript(ex.name, src); } catch {}
          }
        }
        console.log('[Background] ✓ Example scripts synced to disk');
      }
    }
  } catch (err) {
    console.warn('[Background] Example scripts load failed:', err.message);
  }
}

// ============================================================
// Initialization
// ============================================================

(async () => {
  try {
    console.log('[Background] ========================================');
    console.log('[Background] Starting initialization...');
    console.log('[Background] ========================================');

    // Ensure bundled example scripts are in the library
    await ensureExampleScripts();

    // Initialize databases first (fast)
    await vectorDB.init();
    await structDB.init();
    state.dbReady = true;
    console.log('[Background] ✓ Vector database ready');
    console.log('[Background] ✓ Structured records database ready');

    // Initialize embeddings FIRST (fully complete before LLM)
    console.log('[Background] Initializing embeddings (all-MiniLM-L6-v2)...');
    state.embeddingsReady = await initEmbeddings();
    if (state.embeddingsReady) {
      console.log('[Background] ✓ Embeddings ready (neural search enabled)');
    } else {
      console.warn('[Background] ✗ Embeddings failed (TF-IDF fallback)');
    }

    // Initialize Chrome Prompt API (Gemini Nano)
    console.log('[Background] Initializing Gemini Nano...');

    try {
      const apiAvailable = await checkAvailability();

      if (apiAvailable) {
        state.llmReady = await initSession();

        if (state.llmReady) {
          console.log('[Background] ✓ Gemini Nano ready (Q&A, Extract, DOM Selection enabled)');
          const status = getStatus();
          console.log(`[Background]   Model: ${status.model} | Context: ${status.contextWindow} tokens`);
        } else {
          console.warn('[Background] ✗ Gemini Nano init failed (Q&A and Extract disabled)');
        }
      } else {
        console.warn('[Background] ✗ Chrome Prompt API not available (need Chrome 138+)');
        console.warn('[Background]   Q&A and Extract modes disabled, Search still works');
      }
    } catch (error) {
      console.error('[Background] ✗ Chrome Prompt API error:', error.message);
      state.llmReady = false;
    }

    console.log('[Background] ========================================');
    console.log('[Background] Initialization complete');
    console.log('[Background] ✓ Database:', state.dbReady);
    console.log('[Background] ✓ Embeddings:', state.embeddingsReady);
    console.log('[Background] ✓ Gemini Nano:', state.llmReady);
    console.log('[Background] ========================================');
  } catch (error) {
    console.error('[Background] Initialization failed:', error);
  }
})();

// ============================================================
// Extension lifecycle
// ============================================================

chrome.runtime.onInstalled.addListener(() => {
  console.log('Agentidev installed');

  chrome.storage.local.set({
    captureEnabled: true,
    retentionDays: 90,
    excludedDomains: ['accounts.google.com', 'login.', 'auth.'],
    stats: {
      pagesIndexed: 0,
      storageUsed: 0,
      queriesToday: 0,
      lastQueryDate: null
    }
  });
});

// Open sidebar when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// ============================================================
// Message routing (dispatch table replaces 34-clause if-chain)
// ============================================================

const handlers = {};
registerCapture(handlers);
registerExtract(handlers);
registerAgent(handlers);
registerGrammar(handlers);
registerBridge(handlers);
registerSnapshot(handlers);
registerAutomation(handlers);
registerScript(handlers);
registerDataSource(handlers);
registerSmartClient(handlers);
registerAppPersistence(handlers);
registerProjectPersistence(handlers);
registerSync(handlers);
registerCheerpJ(handlers);
registerCheerpX(handlers);
registerHost(handlers); // host.storage / host.network / host.exec / host.fs surfaces

// Discover and load plugins from extension/apps/. Each plugin's handlers.js
// is dynamic-imported and registered on the same dispatch table as the
// platform handlers above. Failures are non-fatal — a broken plugin should
// not crash the SW boot.
loadPlugins(handlers).then(({ loaded, failed }) => {
  console.log('[Background] plugins loaded:', loaded.length, 'failed:', failed.length);
  if (failed.length) {
    for (const f of failed) console.warn(`[Background] plugin ${f.id} failed:`, f.error);
  }
}).catch((err) => {
  console.warn('[Background] plugin loader threw:', err.message);
});

chrome.runtime.onMessage.addListener(createMessageRouter(handlers));

// Expose handlers on globalThis for CDP Runtime.evaluate debugging. This
// lets `sw-eval.mjs` call internal handler functions directly — useful for
// end-to-end tests of the cheerpj runtime chain and similar flows where
// chrome.runtime.sendMessage-to-self is filtered out by MV3.
globalThis.__handlers = handlers;

// ============================================================
// Snapshot store initialization & bridge event callbacks
// ============================================================

(async () => {
  try {
    await yamlSnapshotStore.init();
    console.log('[Background] Snapshot store ready');
  } catch (err) {
    console.warn('[Background] Snapshot store init failed (non-fatal):', err.message);
  }
})();

// Set up bridge event forwarding (broadcasts snapshots/status to sidepanel)
import { generateSimpleEmbedding } from './lib/handlers/capture-handlers.js';
initBridgeCallbacks(handleSnapshotStorage, {
  generateEmbedding, isInitialized, generateSimpleEmbedding, vectorDB,
});

// Auto-connect to bridge server on startup (silent failure if bridge not running)
bridgeClient.connectToBridge(9876).then(() => {
  console.log('[Background] Auto-connected to bridge server');
}).catch(() => {
  console.log('[Background] Bridge server not available — will auto-reconnect when ready');
});
