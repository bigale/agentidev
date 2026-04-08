<!-- Generated from packages/ai-context/sources/. Do not edit directly. -->


# Browser Automation Bridge

You have access to a local browser automation bridge via WebSocket (port 9876).
Use the CLI to control Playwright Chromium browsers, run automation scripts, take accessibility snapshots, and debug interactively.

## Bridge CLI

All commands run from the workspace root:

```
node packages/bridge/claude-client.mjs <command> [json-payload]
```

Shorthand below: `bcli` = `node packages/bridge/claude-client.mjs`

## Startup

If the bridge is not running, start it before any commands:

```
npm run bridge &          # start bridge server (port 9876)
sleep 2
node packages/bridge/launch-browser.mjs   # launch Chromium with extension + dashboard
```

The extension auto-connects once the browser is up.

## Lifecycle

```
bcli status                                    # bridge health check
bcli session:list                              # list active browser sessions
bcli script:list                               # list registered scripts
```

## Sessions (Playwright-controlled browser pages)

```
bcli session:create '{"name":"my-session"}'
bcli session:navigate '{"sessionId":"ID","url":"https://example.com"}'
bcli session:snapshot '{"sessionId":"ID"}'     # accessibility tree (YAML)
bcli session:click '{"sessionId":"ID","ref":"e42"}'
bcli session:fill '{"sessionId":"ID","ref":"e42","value":"hello"}'
bcli session:eval '{"sessionId":"ID","expr":"document.title"}'
bcli session:destroy '{"sessionId":"ID"}'
```

## Scripts (automation scripts with checkpoints)

```
bcli script:launch '{"path":"~/.contextual-recall/scripts/my-script.mjs"}'
bcli script:launch '{"path":"...","breakpoints":["before_navigate","results_loaded"]}'
bcli script:cancel '{"scriptId":"ID"}'
bcli script:cancel '{"scriptId":"ID","force":true}'
bcli script:step '{"scriptId":"ID"}'
bcli script:step '{"scriptId":"ID","clearAll":true}'
bcli script:breakpoint '{"scriptId":"ID","name":"checkpoint_name","active":true}'
bcli script:save '{"name":"my-script","source":"import { chromium } from ..."}'
```

## Schedules

```
bcli schedule:list
bcli schedule:create '{"name":"daily-check","path":"...","cron":"0 9 * * *"}'
bcli schedule:update '{"scheduleId":"ID","enabled":false}'
bcli schedule:delete '{"scheduleId":"ID"}'
bcli schedule:trigger '{"scheduleId":"ID"}'
```

## SmartClient AI

```
bcli sc:generate "Create a ListGrid with name, email, status columns"
bcli sc:clone '{"sessionId":"ID"}'
```

## Snapshot-Driven Workflow

The primary interaction pattern:
1. Navigate to a page
2. Take a snapshot (returns YAML accessibility tree with `[ref=eNNN]` element references)
3. Parse the snapshot to find target elements
4. Click/fill using ref IDs
5. Take another snapshot to verify

Snapshots are the "eyes" -- structured accessibility tree, not screenshots.

## Important Notes

- The bridge server (`packages/bridge/server.mjs`) is a persistent Node.js process. It does NOT hot-reload -- run `npm run bridge:restart` after code changes.
- Always use Playwright bundled Chromium (not system Chrome) for extension support.
- Scripts in `~/.contextual-recall/scripts/` use `packages/bridge/playwright-shim.mjs` for bridge integration.
- All data is local. No external API calls.
- JSON payloads on Windows may need double-quote escaping in the shell. Use single quotes when possible.


# Contextual Recall

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
