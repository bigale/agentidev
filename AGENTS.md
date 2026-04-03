<!-- Generated from docs/ai-context/. Do not edit directly. -->

# Contextual Recall — AI Context


# Browser Automation Bridge

You have access to a local browser automation bridge via WebSocket (port 9876).
Use the CLI to control Playwright Chromium browsers, run automation scripts, take accessibility snapshots, and debug interactively.

## Bridge CLI

All commands run from the workspace root:

```
node bridge/claude-client.mjs <command> [json-payload]
```

Shorthand below: `bcli` = `node bridge/claude-client.mjs`

## Startup

If the bridge is not running, start it before any commands:

```
npm run bridge &          # start bridge server (port 9876)
sleep 2
node bridge/launch-browser.mjs   # launch Chromium with extension + dashboard
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

- The bridge server (`bridge/server.mjs`) is a persistent Node.js process. It does NOT hot-reload -- run `npm run bridge:restart` after code changes.
- Always use Playwright bundled Chromium (not system Chrome) for extension support.
- Scripts in `~/.contextual-recall/scripts/` use `bridge/playwright-shim.mjs` for bridge integration.
- All data is local. No external API calls.
- JSON payloads on Windows may need double-quote escaping in the shell. Use single quotes when possible.


# Bridge Server (`bridge/server.mjs`)

WebSocket server on port 9876. Clients identify via `BRIDGE_IDENTIFY` with a role: `extension`, `script`, `cli`, or `claude`. Roles defined in `bridge/protocol.mjs` (`ROLES` export).

## Message Protocol

All messages use envelope: `{ id, type, source, timestamp, payload }`. Build with `buildMessage()` / `buildReply()` from `protocol.mjs`. All types prefixed `BRIDGE_`.

Categories: connection (`IDENTIFY`, `HEALTH`, `ERROR`, `STATUS`), sessions (`SESSION_CREATE/DESTROY/LIST/CLEAN`), scripts (`SCRIPT_REGISTER/PROGRESS/COMPLETE/PAUSE/RESUME/CANCEL/LIST/LAUNCH`), debugger (`SCRIPT_CHECKPOINT/STEP/SET_BREAKPOINT`, `DBG_*`), scheduling (`SCHEDULE_CREATE/UPDATE/DELETE/LIST/TRIGGER/HISTORY`), files (`SCRIPT_FILE_CHANGED/SAVE`), AI (`SC_GENERATE_UI/SC_CLONE_PAGE`).

## Script Lifecycle

State machine: `registered` -> `running` -> `checkpoint`/`paused` -> `complete`/`cancelled`/`killed`

- `BRIDGE_SCRIPT_LAUNCH`: server spawns child process via `launchScriptInternal()`, stores PID
- `BRIDGE_SCRIPT_REGISTER`: script self-registers with name, totalSteps, pid, checkpoints[]
- Force-kill: `BRIDGE_SCRIPT_CANCEL { force: true }` sends SIGTERM then SIGKILL after 2s

## Pending Maps Pattern

State held by PID between launch and register, transferred at `BRIDGE_SCRIPT_REGISTER`:
- `pendingBreakpoints` — breakpoints set before script connects (eliminates timing race)
- `pendingSessionLinks` — sessionId linked by PID, copied to `script.sessionId`
- `pendingInspectors` — V8 inspector WebSocket URLs by PID

## Playwright Shim (`bridge/playwright-shim.mjs`)

Drop-in replacement for `import { chromium } from 'playwright'`. Auto-connects ScriptClient, wraps Page instances. Intercepts navigate/click/fill/wait/eval/screenshot — declares checkpoints as `p1:navigate`, `p1:click`, etc. Reads `BRIDGE_CDP_ENDPOINT` env var to connect to existing session browser.

## Session-Script 1:1 Linking

One active script per session. Server injects `BRIDGE_CDP_ENDPOINT` env var at launch. `BRIDGE_SESSION_DESTROY` cascades to cancel linked scripts.

## V8 Inspector Debugging

Scripts launched with `--inspect-brk=0`. Server connects via `inspector-client.mjs`. ESM quirk: use `runIfWaitingForDebugger()` not `resume()`. PID-based inspector lookup since scripts haven't registered at line 1.

## File Watcher

Watches `~/.contextual-recall/scripts/` with `fs.watch`, 300ms debounce, echo suppression via `fileWatcherIgnore` Set.

## Scheduling

Persisted to `~/.contextual-recall/schedules.json`. Server-side cron with overlap prevention.

## Script Launch CWD

Server creates `node_modules` symlink in scripts dir pointing to nearest `node_modules` from `originalPath`. Sets `cwd: dirname(originalPath)` on spawn.

## Artifacts

Screenshots captured at checkpoints, console buffer always collected, run archive saved on completion via `BRIDGE_SCRIPT_RUN_COMPLETE`.


# Extension Handlers (`extension/lib/`)

## Message Routing

Background service worker dispatches by `type` string. Handler files export a `register(handlers)` function that adds entries to the handler map. Messages with `type.startsWith('EMBEDDINGS_')` route to offscreen document.

**Critical**: Always `return true` from `chrome.runtime.onMessage.addListener()` for async responses.

## DataSource Proxy (`extension/lib/handlers/datasource-handlers.js`)

`BRIDGE_BACKENDS` registry routes DS operations by dataSource ID to bridge functions:
- `BridgeSessions` -> `bridgeClient.listSessions()`, `createSession()`, `destroySession()`
- `BridgeScripts` -> `bridgeClient.listScripts()`
- `BridgeSchedules` -> `bridgeClient.listSchedules()`, `createSchedule()`, etc.
- `BridgeCommands` -> in-memory command log

Anything not in `BRIDGE_BACKENDS` falls through to IndexedDB (`smartclient-data` database).

### DS Response Format

Success: `{ status: 0, data: [...] }` — NOT `{ success: true }`
Error: `{ status: -1, data: errorMsg }` — NOT `{ error: ... }`

IndexedDB auto-creates object stores per DS ID with `keyPath: 'id'` and `autoIncrement: true`.

## Bridge Client (`extension/lib/bridge-client.js`)

WebSocket client connecting to bridge server. Callback arrays fire from broadcast handler:
- `onScriptUpdate` — script state changes
- `onRunComplete` — run archive ready
- `onFileChanged` — disk file changed
- `onSessionUpdate`, `onScheduleUpdate`, etc.

`isConnected()` checks WebSocket state before bridge operations.

## Script Library

Stored in `chrome.storage.local`:
- Key `bridge-scripts`: array of script library entries (name, source, originalPath)
- Key `script-versions`: version history per script (pruned to 20 entries)

`upsertShimImport(source, shimPath)` adds absolute shim import path to script source at import time.

## SmartClient AI Handler (`extension/lib/handlers/smartclient-handlers.js`)

`SC_GENERATE_UI` -> `bridgeClient.generateSmartClientUI(prompt)` -> validates config (must have `dataSources[]` and `layout._type`) -> auto-saves to app persistence -> returns config to sandbox iframe.


# Contextual Recall

Browser extension for semantic memory and automation. Local-first (IndexedDB), privacy-preserving, Chrome MV3.

## Architecture

- **Service worker** (`extension/background.js`): coordination, message routing, IndexedDB
- **Offscreen document** (`extension/offscreen.js`): DOM APIs, spawns Web Workers for ML inference
- **Web Workers**: `embeddings-worker.js` (all-MiniLM-L6-v2, 384-dim vectors), future `llm-worker.js`
- **Sandbox iframe** (`extension/smartclient-app/`): SmartClient UI dashboard, communicates via postMessage
- **Bridge server** (`bridge/server.mjs`): WebSocket on port 9876, manages sessions/scripts/scheduling
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

- Protocol constants: `bridge/protocol.mjs` (all message types)
- Script client SDK: `bridge/script-client.mjs`
- Playwright shim: `bridge/playwright-shim.mjs`
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


# RAG Pipeline

## Recursive Language Models (RLM) Integration

Incorporating concepts from the Recursive Language Models paper (arxiv.org/abs/2512.24601) to enable hierarchical query decomposition over large browsing histories.

Complex queries that span multiple time periods, topics, or require multi-hop reasoning cannot be answered with simple "retrieve top 5 chunks -> LLM" approach. Solution: Recursive query decomposition with token budget management.

Implementation Phases:
- **Phase 1**: LLM integration with token budget management (current)
- **Phase 1.5**: Recursive query handler with hierarchical decomposition (next)
- **Phase 2+**: Advanced aggregation strategies

## Phase 1: Basic RAG (Current)

```
Query -> Generate embedding -> Vector search -> Top 5 results
      -> Build context (token budget managed)
      -> LLM (Phi-3-mini) -> Natural language answer
```

## Phase 1.5: Recursive RAG (Next)

```
Query -> Query Classifier
         |
   [Complex query?]
         |
   Query Decomposer -> [Sub-query 1, Sub-query 2, ...]
         |
   Allocate token budget per sub-query
         |
   Execute sub-queries recursively (parallel)
         |
   Result Aggregator -> Synthesized answer with all sources
```

## Token Budget Management

Critical for Phi-3-mini's 4K context window.

Always:
- Create TokenBudgetManager at start of each LLM query
- Track token usage for: query, context, answer generation
- Reserve tokens for final answer (500 tokens minimum)
- Check budget before adding more context chunks

Token Budget Allocation:
```javascript
// Phase 1: Simple queries
const tokenBudget = new TokenBudgetManager(4096); // Total budget
tokenBudget.recordUsage(estimatedQueryTokens);
const maxChunks = tokenBudget.getMaxChunks(500); // 500 tokens per chunk

// Phase 1.5: Recursive queries
const budgetPerSub = tokenBudget.allocateForSubQueries(numSubQueries, depth);
// Exponential decay: deeper queries get less budget (0.6^depth penalty)
```

Budget Exhaustion:
- If budget < 500 tokens: Fall back to simple query or return cached results
- Never exceed 4K token limit - Phi-3-mini will fail
- Log budget usage for debugging: `[TokenBudget] Used X/Y tokens`

Token Estimation:
- Simple heuristic: 1 token ~ 4 characters
- Use `estimateTokens(text)` function from llm.js
- Conservative estimates better than optimistic (add 10% buffer)

## Query Classification

- Temporal: /last (week|month|year)/, /evolution/, /timeline/
- Multi-topic: /compare/, /both/, /and/
- Multi-hop: /related to/, /documentation for/, /error.*yesterday/
- Simple: Everything else (no decomposition)

## Decomposition Rules

- Max depth: 3 (prevent runaway recursion)
- Parallel execution: Use `Promise.all()` for sub-queries
- Token allocation: Exponential decay by depth (0.6^depth)
- Base case: depth >= maxDepth OR budget < 500 tokens

## Aggregation Strategies

- Temporal: Build timeline narrative showing progression
- Multi-topic: Compare and contrast findings
- Multi-hop: Follow reasoning chain sequentially
- Always deduplicate sources by URL

## Common Pitfalls

- DON'T create circular decomposition (query -> sub-query -> same query)
- DON'T allocate equal budget to all sub-queries (use decay)
- DON'T aggregate without considering query type
- DON'T lose source references during aggregation
- DO track metadata (depth, sub-queries, token usage)
- DO show sub-queries to user for transparency
- DO fall back gracefully on errors

## Offscreen Architecture for ML

Service workers CANNOT use transformers.js directly (no WASM support). Always use offscreen document + Web Worker pattern for ML inference:
- `lib/embeddings-worker.js` (Web Worker) — all-MiniLM-L6-v2, 384-dim vectors
- `lib/embeddings.js` (bridge to offscreen document)
- Future: `lib/llm-worker.js` + `lib/llm.js` for Phi-3-mini

Check `isInitialized()` before using neural embeddings. Fall back to TF-IDF if embeddings fail. Neural threshold: 0.3, TF-IDF threshold: 0.1.


# SmartClient Dashboard (`extension/smartclient-app/`)

## Sandbox Architecture

Runs inside sandboxed iframe (`app.html` loaded by `wrapper.html`). All communication via postMessage through `bridge.js` (host page) <-> `app.js` (sandbox).

- `bridge.js`: translates postMessage DS operations to `chrome.runtime.sendMessage` calls
- `app.js`: receives configs, calls `renderer.js`, handles DS responses
- Loading modes: `?app=<id>` (IndexedDB), `?clone=1` (storage.session), or gallery

## Renderer (`renderer.js`)

Whitelist of allowed SmartClient types (ALLOWED_TYPES Set):
`VLayout`, `HLayout`, `ListGrid`, `DynamicForm`, `Button`, `Label`, `TabSet`, `Tab`, `DetailViewer`, `SectionStack`, `HTMLFlow`, `Window`, `ToolStrip`, `ToolStripButton`, `PortalLayout`, `Portlet`, `Canvas`, `Progressbar`, `ImgButton`, `ToolStripSeparator`, `ToolStripMenuButton`, `Menu`

Config is JSON with special properties:
- `_type` — SmartClient class name (must be in whitelist)
- `ID` — component ID, registered in `componentRegistry`
- `_action` — action descriptor mapped via `ACTION_MAP` (no eval)
- `_formatter` — cell formatter name (`stateDot`, `timestamp`, `elapsed`, `progressBar`)

Key functions:
- `resolveRef(id)` — finds components by ID in `componentRegistry`
- `dispatchAction(messageType, payload)` — fire-and-forget to bridge.js via postMessage
- `dispatchActionAsync(messageType, payload)` — returns Promise, uses `msg.id` for response matching

## Dashboard

`dashboard-config.js` defines PortalLayout config (3-column layout, toolbar, grids).
`dashboard-app.js` wires it up, handles `AUTO_BROADCAST_*` messages via `handleBroadcast(type, payload)`.

## Monaco Editor

SmartClient clobbers `window.DataView` in Simple Names mode. Fix:
1. Save native `DataView` before SC loads (`_nativeDataView`)
2. Restore before Monaco initialization
3. Save/restore AMD loader globals around Monaco loader

Monaco deferred 500ms to avoid blocking on extension reload. Host div sized programmatically from SC Canvas dimensions (CSS `height:100%` fails in SC layout).

## Cell Formatters

- `stateDot` — colored circle by state (running=green, paused=orange, error=red, etc.)
- `timestamp` — formats epoch to HH:MM:SS
- `elapsed` — relative time display
- `progressBar` — visual progress indicator


# SmartClient Playwright Testing

## Setup

Tests use the `SmartClientCommands` helper from `smartclientSDK/tools/playwright/commands.js`.
Add to Playwright test file:

```javascript
const { extendPage } = require('C:/Users/everiale/source/repos/smartclient/smartclientSDK/tools/playwright/commands.js');

test.beforeEach(async ({ page }) => {
  extendPage(page);
  await page.goto('chrome-extension://jgkjpplhfkpoagkobjfepkkmilbfdgcg/smartclient-app/wrapper.html?mode=dashboard');
  await page.waitForSCDone();
});
```

## AutoTest Locators

All SmartClient element refs start with `//`. Use `isc.AutoTest.getLocator(element)` in the browser console to discover them.

Common locator patterns:
```javascript
// Component by ID
'//ListGrid[ID="schedulesGrid"]'
'//Button[ID="btnNewSession"]'

// Grid cell by row and column
'//ListGrid[ID="scriptsGrid"]/row[index=0]/col[name="name"]'

// Tab by title
'//TabSet[ID="scriptDetailTabs"]/tab[title="Artifacts"]'

// Form field
'//DynamicForm[ID="someForm"]/item[name="fieldName"]'
```

**Never use CSS selectors or `page.locator()` for SmartClient components.** SmartClient generates complex DOM that changes on redraws.

## Core Commands (from `extendPage`)

```javascript
// Resolve locator, wait for SC system done, return ElementHandle
const el = await page.getSC('//Button[ID="btnNewSession"]');

// Click (resolves locator + clicks center via mouse.move/down/up)
await page.clickSC('//Button[ID="btnNewSession"]');

// Type into a field (clicks first to focus, Ctrl+A to clear, then types)
await page.typeSC('//DynamicForm[ID="someForm"]/item[name="name"]', 'my-session');

// Hover
await page.hoverSC('//ListGrid[ID="scriptsGrid"]/row[index=0]');

// Scroll SmartClient Canvas (not native scroll — required for custom scrollbars)
await page.scrollSC('//ListGrid[ID="scriptsGrid"]', 0, 200);

// Wait for all SC async ops to complete
await page.waitForSCDone();

// Get SC component object (returns serializable JS object, not DOM element)
const grid = await page.getSCObject('//ListGrid[ID="schedulesGrid"]');

// Check element exists
const exists = await page.existsSCElement('//Button[ID="btnRun"]');

// Get text content
const text = await page.scGetLocatorText('//ListGrid[ID="scriptsGrid"]/row[index=0]/col[name="name"]');

// Drag and drop (recipe reorder, etc.)
await page.dragAndDropSC(
  '//ListGrid[ID="preActionsGrid"]/row[index=1]',
  '//ListGrid[ID="preActionsGrid"]/row[index=0]',
  { dropPosition: 'before' }
);
```

## Configuration

```javascript
page.configureSC({
  scCommandTimeout: 15000,  // default 30000ms
  scLogCommands: true,      // logs each SC command
  scLogLevel: 'info',       // 'debug' | 'info' | 'warn' | 'error' | 'silent'
  scAutoWait: true,         // auto-call waitForSCDone after each command
});
```

## Critical Interaction Rules

### Checkboxes and SelectItems
SmartClient `CheckboxItem`, `SelectItem`, `ComboBoxItem` are **custom HTML** — not native browser controls.
- Use `clickSC()` — NOT `page.check()`, `page.selectOption()`, or `.fill()`
- For grid cell checkboxes (e.g. `enabled` in schedulesGrid): double-click to enter edit mode first, then click the checkbox cell

```javascript
// Enter edit mode on row
await page.clickSC('//ListGrid[ID="schedulesGrid"]/row[index=0]/col[name="name"]');
await page.clickSC('//ListGrid[ID="schedulesGrid"]/row[index=0]/col[name="name"]');
// (double-click = editEvent: 'doubleClick')
```

### Click Masks
Some SC interactions (inline edit, dropdowns) show a click-mask. To dismiss:
```javascript
// Use force: true option
await page.mouse.click(x, y, { force: true });
```

### Grid Inline Editing
schedulesGrid uses `editEvent: 'doubleClick'`. Single click selects row, double-click opens edit.
After editing, pressing Tab or clicking elsewhere triggers `editComplete` and saves to bridge.

## Waiting Patterns

`getSC()` automatically calls `waitForSCDone()` after resolving — no need to add extra waits after most operations.

Explicit waits needed for:
- Bridge async operations (use `page.waitForTimeout(500)` after dispatch)
- Grid data refresh after `invalidateCache()` calls
- Modal dialogs appearing after button click

## Dashboard-Specific Locators

```javascript
// Toolbar buttons
'//ToolStripButton[ID="tbRun"]'
'//ToolStripButton[ID="tbDebug"]'

// Sessions grid
'//ListGrid[ID="sessionsGrid"]/row[index=0]/col[name="name"]'

// Scripts library
'//ListGrid[ID="scriptsGrid"]/row[index=0]/col[name="name"]'

// Schedules grid
'//ListGrid[ID="schedulesGrid"]/row[index=0]/col[name="name"]'
'//ListGrid[ID="schedulesGrid"]/row[index=0]/col[name="enabled"]'

// Script History tabs
'//ListGrid[ID="scriptHistoryGrid"]'
'//Button[ID="btnHistoryLive"]'
'//Button[ID="btnHistoryArchive"]'

// Artifacts
'//ListGrid[ID="artifactsGrid"]'
'//HTMLFlow[ID="artifactPreview"]'
```

## Test Structure

```javascript
const { test, expect } = require('@playwright/test');
const { extendPage } = require('C:/Users/everiale/source/repos/smartclient/smartclientSDK/tools/playwright/commands.js');

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    extendPage(page);
    await page.goto('chrome-extension://jgkjpplhfkpoagkobjfepkkmilbfdgcg/smartclient-app/wrapper.html?mode=dashboard');
    await page.waitForSCDone({ timeout: 15000 });
  });

  test('creates a new session', async ({ page }) => {
    await page.clickSC('//Button[ID="btnNewSession"]');
    await page.waitForSCDone();
    // Dialog should appear — interact with it
    await page.typeSC('//DynamicForm/item[name="sessionName"]', 'test-session');
    await page.clickSC('//Button[title="OK"]');
    await page.waitForTimeout(1000); // bridge async
    const name = await page.scGetLocatorText('//ListGrid[ID="sessionsGrid"]/row[index=0]/col[name="name"]');
    expect(name).toBe('test-session');
  });
});
```

## Discovering Locators at Runtime

In browser console (inside the sandbox iframe):
```javascript
// Get locator for a component you clicked on
isc.AutoTest.getLocator(document.elementFromPoint(x, y))

// Get locator for a known component by ID
isc.AutoTest.getLocator(isc.AutoTest.getObject('//ListGrid[ID="scriptsGrid"]').getCell(0, 0))
```


# Testing

Jest for unit tests. Always run in background: `npm test &`

## Test Patterns

`datasource-handlers.test.js` replicates routing logic from datasource-handlers.js (ESM/CJS boundary) and mocks bridge-client functions.

Structure: mock bridge functions -> call handler -> assert response format.

### DS Response Assertions

Correct: `expect(result.status).toBe(0)` and check `result.data` array
Wrong: do NOT assert `result.success === true` — DS format uses `status: 0` for success, `status: -1` for error.

### Mock Setup

```javascript
const mockBridgeClient = {
  isConnected: jest.fn(() => true),
  listSessions: jest.fn(),
  createSession: jest.fn(),
  // ... other bridge functions
};
```


# Vector Database (`extension/lib/vectordb.js`)

## Overview

IndexedDB-based vector database (POC implementation). Stores page content with 384-dim embeddings from all-MiniLM-L6-v2. Provides cosine similarity search. Future: LanceDB WASM for 10GB+ storage with HNSW index.

## Source Partitioning (DB v3)

`source` index on `pages` store enables scoped queries:
- `browsing` — content captures from browser activity
- `showcase` — SmartClient SDK examples
- `reference` — specs, docs, indexed reference material

Records without `source` field default to `'browsing'` (backward compat, no migration needed).

## Key APIs

- `addPage({ url, title, content, embedding, source })` — store with source tag
- `search(queryEmbedding, { limit, sources })` — pre-filter by source index, then cosine similarity
- `getPagesBySources(sources)` — IndexedDB index lookup, avoids loading all records
- `getStats()` — returns `bySource` breakdown

## Callsite Source Tags

- `capture-handlers.js` -> `source: 'browsing'`
- `bridge-handlers.js` -> `source: 'reference'`
- `ixml-spec-indexer.js` -> `source: 'reference'`
- `index-showcase.mjs` -> `source: 'showcase'`

## Performance

- Current: O(n) cosine similarity scan over all pages in source partition
- Target: <300ms query latency
- Storage: 2-3GB for 3 years of activity (1,000-10,000 pages)
- Future LanceDB WASM: HNSW index for sub-linear search

## IndexedDB Patterns

- Always wrap operations in promises
- Use transactions for multi-step operations
- Check `dbReady` before any database access
- `keyPath: 'id'` with `autoIncrement: true` for object stores

## CLI

`bridge/query-vectordb.mjs` supports `--source=showcase` flag for partition-scoped queries.
