<!-- Generated from packages/ai-context/sources/. Do not edit directly. -->

---
description: Project overview and global coding rules
alwaysApply: true
---


# Agentidev

Browser extension for semantic memory and automation. Local-first (IndexedDB), privacy-preserving, Chrome MV3.

## Architecture

- **Service worker** (`extension/background.js`): coordination, message routing, IndexedDB
- **Offscreen document** (`extension/offscreen.js`): DOM APIs, spawns Web Workers for ML inference
- **Web Workers**: `embeddings-worker.js` (all-MiniLM-L6-v2, 384-dim vectors), future `llm-worker.js`
- **Sandbox iframe** (`extension/smartclient-app/`): SmartClient UI dashboard, communicates via postMessage
- **Bridge server** (`packages/bridge/server.mjs`): WebSocket on port 9876, manages sessions/scripts/scheduling
- No webpack — native ESM modules throughout

## Dev Commands

- `npm run build` — production build
- `npm run dev` — watch mode
- `npm test &` — always run tests in background
- `npm run bridge` / `npm run bridge:stop` / `npm run bridge:restart`
- `npm run browser` — launch Chromium with extension loaded

## Critical Rules

1. Never use transformers.js in service worker — must go through offscreen doc + Web Worker
2. Always `return true` from `chrome.runtime.onMessage.addListener()` for async responses
3. Bridge server does NOT hot-reload — restart after any change to `server.mjs`
4. No webpack — extension uses native ESM modules
5. Mermaid diagrams: no quotation marks, black font on non-black boxes
6. Log errors with context: `console.error('[Component] Failed to:', error)`
7. Wrap IndexedDB operations in promises; check `dbReady` before DB access

## Key File Locations

- Protocol constants: `packages/bridge/protocol.mjs` (all message types)
- Script client SDK: `packages/bridge/script-client.mjs`
- Playwright shim: `packages/bridge/playwright-shim.mjs`
- Extension bridge client: `extension/lib/bridge-client.js`
- Script handlers: `extension/lib/handlers/script-handlers.js`
- SmartClient renderer: `extension/smartclient-app/renderer.js`
- Vector DB: `extension/lib/vectordb.js`
- Embeddings bridge: `extension/lib/embeddings.js`
- Content script: `extension/content.js`
- Sidepanel UI: `extension/sidepanel/sidepanel.js`

## Key Principles

- Local-first: All data stays on device (IndexedDB, no cloud)
- Privacy-preserving: Raw content never leaves browser
- Semantic search: Neural embeddings (all-MiniLM-L6-v2, 384-dim vectors)
- Browser-native: Chrome extension with offscreen document + Web Worker architecture
- Exclude sensitive domains by default: banking, auth, login pages
