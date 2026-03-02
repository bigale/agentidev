/**
 * Background Service Worker for Contextual Recall
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
import { initEmbeddings } from './lib/embeddings.js';
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
import { register as registerSnapshot, handleSnapshotStorage } from './lib/handlers/snapshot-handlers.js';
import { register as registerAutomation } from './lib/handlers/automation-handlers.js';
import { register as registerScript } from './lib/handlers/script-handlers.js';

console.log('Contextual Recall: Background service worker started');
console.log('[Background] Note: Extension reload = re-initialize (models are cached, not re-downloaded)');

// ============================================================
// Initialization
// ============================================================

(async () => {
  try {
    console.log('[Background] ========================================');
    console.log('[Background] Starting initialization...');
    console.log('[Background] ========================================');

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
  console.log('Contextual Recall installed');

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

chrome.runtime.onMessage.addListener(createMessageRouter(handlers));

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
initBridgeCallbacks(handleSnapshotStorage);

// Auto-connect to bridge server on startup (silent failure if bridge not running)
bridgeClient.connectToBridge(9876).then(() => {
  console.log('[Background] Auto-connected to bridge server');
}).catch(() => {
  console.log('[Background] Bridge server not available — will auto-reconnect when ready');
});
