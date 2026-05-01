<!-- Generated from packages/ai-context/sources/. Do not edit directly. -->

# Agentidev — AI Context


# api-to-app Pipeline

PICT-driven test generation from OpenAPI specs. Reads a spec, generates combinatorial test models via PICT, and produces runnable ScriptClient test scripts.

## Architecture

```
OpenAPI Spec (JSON)
  spec-analyzer.mjs → PICT model text
  pict-runner.mjs   → PICT CLI → TSV rows
  test-generator.mjs → .mjs test script (ScriptClient + fetch)
  pipeline.mjs      → orchestrator (bridge script)
```

All modules are in `packages/bridge/api-to-app/`. Specs cached in `specs/`, generated tests in `examples/`.

## Modules

### spec-analyzer.mjs

- `loadSpec(path)` — parse JSON spec file
- `extractEndpoints(spec)` — walk paths, return endpoint descriptors
- `generatePictModel(endpoint, spec)` — generate PICT model text + paramMeta
- Handles both OpenAPI 3.0 and Swagger 2.0
- Resolves `$ref` to definitions/components
- Flattens body objects: scalar fields become PICT params, nested objects become shape variants (`valid`, `id_only`, `name_only`, `~malformed`, `omit`), arrays become count variants

### pict-runner.mjs

- `runPict(modelText, options)` — write model to temp file, execute `pict` CLI, return TSV
- `parseTsv(tsvString)` — split TSV into `{ headers, rows }` objects
- `runAndParse(modelText, options)` — convenience wrapper
- `isPictAvailable()` — check if `pict` binary is on PATH
- Options: `order` (default 2=pairwise), `seed` (deterministic), `seedFile` (TSV), `caseSensitive`

### test-generator.mjs

- `generateTestScript(analysis, rows, options)` — produce a complete `.mjs` test script
  - Builds fetch calls from PICT rows (query params, path params, JSON body, headers)
  - `~`-prefixed values flag negative test cases (expect 4xx or lenient 200)
  - GET/DELETE accept 404 as valid for stateful endpoints (shared server)
  - Uses ScriptClient for assertions and dashboard reporting
- `generateWorkflowTest(analyses, baseUrl, options)` — stateful CRUD test (POST→GET→DELETE)
  - Uses explicit small IDs to avoid JS int64 precision loss
  - Verifies create, read, read-not-found, read-malformed, delete, read-after-delete

### pipeline.mjs (bridge script)

Dashboard-integrated orchestrator. Reports progress, assertions, and artifacts via ScriptClient. Uses dynamic imports to work from any location (repo or `~/.agentidev/scripts/` copy).

```bash
# Generate tests (view in dashboard Artifacts tab)
node packages/bridge/api-to-app/pipeline.mjs \
  --endpoint=all --workflow --seed=42

# Generate AND run tests in one shot
node packages/bridge/api-to-app/pipeline.mjs \
  --endpoint=all --workflow --run --seed=42
```

Options: `--spec`, `--endpoint` (operationId or "all"), `--base-url`, `--output`, `--order`, `--seed`, `--workflow`, `--build`, `--run`, `--dry-run`

### Dashboard workflow

1. Select `api-to-app-pipeline` in Scripts panel → Run
2. Pipeline appears in Script History with live progress
3. Artifacts tab: PICT models, TSV outputs, generated test scripts (rendered inline)
4. Generated tests auto-register in Scripts panel for one-click re-run
5. Schedule with `--run` flag for automated generate+test on a cron

## PICT Model Generation

For each endpoint, the analyzer generates PICT parameters from:

| Source | PICT Parameter | Values |
|--------|---------------|--------|
| Query param with enum | `status` | `available, pending, sold, ~unknown_enum` |
| Path param (integer) | `petId` | `1, 100, 9999, ~-1, ~abc` |
| Body field (string) | `body_name` | `doggie, cat_42, ~empty_string` |
| Body field (enum) | `body_status` | `available, pending, sold, ~unknown_enum, omit` |
| Body field (nested obj) | `body_category_shape` | `valid, id_only, name_only, ~malformed, omit` |
| Body field (array) | `body_photoUrls` | `one_item, multiple_items, ~empty_array` |
| Content-Type (POST/PUT) | `ContentType` | `application_json, application_xml, ~text_plain` |
| Accept header | `Accept` | `application_json, ~text_plain` |
| Auth | `Auth` | `valid_auth, ~no_auth, ~invalid_auth` |

Negative values (`~` prefix) are stripped before sending but flag the test case as expecting error responses.

## Coverage Numbers (Petstore v2)

| Endpoint | Params | PICT Cases | Notes |
|----------|--------|-----------|-------|
| GET /pet/findByStatus | 3 | 13 | query enum + accept + auth |
| POST /pet | 9 | 69 | body fields + content-type + auth |
| GET /pet/{petId} | 3 | 14 | path int + accept + auth |
| DELETE /pet/{petId} | 4 | 25 | path int + header + accept + auth |
| CRUD workflow | — | 6 | stateful: POST→GET→GET(404)→GET(abc)→DELETE→GET(gone) |

## Key Patterns

### Body construction from PICT rows

Body fields are prefixed `body_` in PICT params. The test generator builds JSON from these:
- Scalar: `body_name=doggie` → `{ name: "doggie" }`
- Enum: `body_status=available` → `{ status: "available" }`
- Nested: `body_category_shape=valid` → `{ category: { id: 1, name: "Test" } }`
- Array: `body_photoUrls=one_item` → `{ photoUrls: ["https://..."] }`
- Omit: `body_status=omit` → field excluded from body

### Negative value handling

`~` prefix signals an invalid input. The PICT model includes negatives like `~-1`, `~abc`, `~unknown_enum`, `~empty_string`. In generated tests:
- Value is stripped: `~abc` → `abc` is actually sent
- Test expects 4xx OR lenient 200 (some servers don't validate strictly)
- Console logs whether server was strict or lenient

### Stateful endpoint tolerance

GET/DELETE with path IDs may return 404 on shared servers (resource doesn't exist). Generated tests accept 404 for non-POST positive cases. For strict testing, use the workflow test which creates its own data.

## Adding New Endpoints

1. Add the operationId to `PET_ENDPOINTS` array in pipeline.mjs (or use `--endpoint=operationId`)
2. If the endpoint has a complex body schema with nested `$ref`, check that `spec-analyzer` resolves it correctly
3. Run `--dry-run` first to verify the PICT model looks right
4. The test generator auto-handles GET/POST/PUT/DELETE differences

## PICT Binary

PICT must be installed at `/usr/local/bin/pict` (or on PATH). Install from https://github.com/microsoft/pict. The runner writes temp files to `/tmp/` and cleans up after execution.


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
bcli script:launch '{"path":"~/.agentidev/scripts/my-script.mjs"}'
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
- Scripts in `~/.agentidev/scripts/` use `packages/bridge/playwright-shim.mjs` for bridge integration.
- All data is local. No external API calls.
- JSON payloads on Windows may need double-quote escaping in the shell. Use single quotes when possible.


# Bridge Server (`packages/bridge/server.mjs`)

WebSocket server on port 9876. Clients identify via `BRIDGE_IDENTIFY` with a role: `extension`, `script`, `cli`, or `claude`. Roles defined in `packages/bridge/protocol.mjs` (`ROLES` export).

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

## Playwright Shim (`packages/bridge/playwright-shim.mjs`)

Drop-in replacement for `import { chromium } from 'playwright'`. Auto-connects ScriptClient, wraps Page instances. Intercepts navigate/click/fill/wait/eval/screenshot — declares checkpoints as `p1:navigate`, `p1:click`, etc. Reads `BRIDGE_CDP_ENDPOINT` env var to connect to existing session browser.

## Session-Script 1:1 Linking

One active script per session. Server injects `BRIDGE_CDP_ENDPOINT` env var at launch. `BRIDGE_SESSION_DESTROY` cascades to cancel linked scripts.

## V8 Inspector Debugging

Scripts launched with `--inspect-brk=0`. Server connects via `inspector-client.mjs`. ESM quirk: use `runIfWaitingForDebugger()` not `resume()`. PID-based inspector lookup since scripts haven't registered at line 1.

## File Watcher

Watches `~/.agentidev/scripts/` with `fs.watch`, 300ms debounce, echo suppression via `fileWatcherIgnore` Set.

## Scheduling

Persisted to `~/.agentidev/schedules.json`. Server-side cron with overlap prevention.

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


# RestDataSource → Bridge → Zato Data Chain

## Architecture

```
SmartClient ListGrid (canEdit, canRemoveRecords)
    ↓ fetch() from sandbox iframe
    ↓ (XHR blocked cross-origin, fetch() works)
Bridge Server :9876 /ds/<EntityDS>
    ↓ HTTP to Zato Docker
Zato REST Channel :11223
    ↓ Python service (SIO)
SQLite Database
```

SmartClient grids get full CRUD (inline edit, add row, delete row) backed by Zato services. The bridge server translates between SmartClient's RestDataSource wire protocol and Zato's REST channels.

## How It Works

### 1. SmartClient DataSource (sandbox iframe)

The renderer creates a `clientCustom` DataSource that uses `fetch()` internally (not XHR, because sandbox XHR is blocked cross-origin):

```javascript
// renderer.js — when config has _type: "RestDataSource"
ds = isc.DataSource.create({
  ID: 'PetDS',
  dataProtocol: 'clientCustom',
  fields: [...],
  transformRequest: function(dsRequest) {
    var url = dataURL + '?_operationType=' + dsRequest.operationType;
    // Add criteria as query params for fetch, JSON body for add/update/remove
    fetch(url, fetchOpts).then(resp => resp.json()).then(result => {
      this.processResponse(dsRequest.requestId, result.response);
    });
  }
});
```

Key: `isc.RPCManager.allowCrossDomainCalls = true` must be set to suppress SmartClient's cross-origin warning dialog.

### 2. Bridge /ds/ Endpoint (HTTP)

The bridge server handles `/ds/<EntityDS>` requests on the same HTTP port (9876):

**Request format** (SmartClient RestDataSource wire protocol):
- Fetch: `GET /ds/PetDS?_operationType=fetch&status=available&_startRow=0&_endRow=75`
- Add: `POST /ds/PetDS` body: `{"_operationType":"add","name":"Rex","status":"available"}`
- Update: `POST /ds/PetDS` body: `{"_operationType":"update","id":4,"name":"New Name"}`
- Remove: `POST /ds/PetDS` body: `{"_operationType":"remove","id":4}`

**Response format** (SmartClient expects):
```json
{
  "response": {
    "status": 0,
    "startRow": 0,
    "endRow": 6,
    "totalRows": 7,
    "data": [{"id": 4, "name": "Buddy", "status": "available", ...}]
  }
}
```

**Entity routing** (`DS_ENTITY_MAP` in server.mjs):
```javascript
PetDS: {
  fetch:     { method: 'GET',    path: '/api/pet/findByStatus', queryParam: 'status' },
  fetchById: { method: 'GET',    path: '/api/pet/id/' },
  add:       { method: 'POST',   path: '/api/pet' },
  update:    { method: 'PUT',    path: '/api/pet/update' },
  remove:    { method: 'DELETE', path: '/api/pet/delete/' },
}
```

**Update merge**: SmartClient sends only changed fields. The bridge fetches the current record from Zato, merges with changes, then PUTs the full record.

**Response flattening**: Nested objects (`category: {id:1, name:"Dogs"}`) are flattened to strings (`category: "Dogs"`) for grid display.

### 3. Zato REST Channels (Docker)

Zato 3.3 quickstart in Docker. Services hot-deployed via pickup directory.

**Services** (in `docker/zato/services/petstore/pet.py`):
- `petstore.pet.find-by-status` — GET, filters by status query param
- `petstore.pet.get-by-id` — GET, returns single pet by ID
- `petstore.pet.add` — POST, creates pet from JSON body
- `petstore.pet.update` — PUT, updates pet from JSON body
- `petstore.pet.delete` — DELETE, removes pet by ID

**Zato 3.3 gotchas**:
- `self.request.http.GET` doesn't reliably read query params. Use `self.wsgi_environ['QUERY_STRING']` instead.
- SQLite needs `PRAGMA journal_mode=WAL` and `busy_timeout=5000` for concurrent access from Zato workers.
- URL paths must be unique per channel (no method-based routing on same path). Use `/api/pet/update` for PUT, `/api/pet/delete/{id}` for DELETE.
- Channel creation: `zato create-rest-channel --path /opt/zato/env/qs-1/server1 --name <name> --url-path <path> --service <service>`

### 4. Plugin Config

```json
{
  "dataSources": [{
    "ID": "PetDS",
    "_type": "RestDataSource",
    "dataURL": "http://localhost:9876/ds/PetDS",
    "fields": [
      {"name": "id", "type": "integer", "primaryKey": true},
      {"name": "name", "type": "text", "required": true},
      {"name": "status", "type": "text", "valueMap": {"available":"Available","pending":"Pending","sold":"Sold"}}
    ]
  }],
  "layout": {
    "_type": "VLayout",
    "members": [
      {"_type": "ListGrid", "ID": "petGrid", "dataSource": "PetDS",
       "autoFetchData": true, "canEdit": true, "canRemoveRecords": true},
      {"_type": "Button", "_action": "dsFetch", "_targetGrid": "petGrid", "_payloadFrom": "filterForm"},
      {"_type": "Button", "_action": "dsAdd", "_targetGrid": "petGrid"},
      {"_type": "Button", "_action": "dsSave", "_targetGrid": "petGrid"}
    ]
  }
}
```

### 5. Renderer Actions for DataSource Grids

| Action | What it does |
|--------|-------------|
| `dsFetch` | Calls `grid.fetchData(criteria)` with form values from `_payloadFrom` |
| `dsAdd` | Calls `grid.startEditingNew()` — opens inline edit for a new row |
| `dsSave` | Calls `grid.saveAllEdits()` — commits all pending edits |

These are in addition to `fetchUrlAndLoadGrid` (for plugins without DataSource binding) and `fetchAndLoadGrid` (for handler-based data loading).

## Docker Setup

```bash
cd docker/zato && docker compose up -d   # Start Zato
# Services auto-deployed from docker/zato/services/ volume mount
# Channels created via: docker exec agentidev-zato /opt/zato/current/bin/zato create-rest-channel ...
```

## External Plugins (EXTERNAL_PLUGINS_DIR)

The framework supports loading plugins from a sibling directory (e.g. private `consulting-template` repo) without adding them to this public repo.

Set the env var to a directory containing plugin subdirectories:

```bash
export EXTERNAL_PLUGINS_DIR=~/repos/consulting-template/plugins
cd docker/zato && docker compose up -d
node setup-channels.mjs
```

Each external plugin must follow this layout:

```
<plugin-id>/
├── plugin.json              # SmartClient plugin config
└── zato/
    ├── services/*.py        # Hot-deployed into Zato
    ├── schema.sql           # Optional, called by an init service
    └── channels.json        # { channels: [...], datasources: {...} }
```

What the framework does on `setup-channels.mjs`:
- Walks `EXTERNAL_PLUGINS_DIR/*/zato/`
- Copies `services/*.py` to Zato's `pickup/incoming/services/` (triggers hot-deploy)
- Reads `channels.json` and registers each channel via `zato create-rest-channel`

What the bridge does on startup:
- Walks `EXTERNAL_PLUGINS_DIR/*/zato/channels.json`
- Merges each plugin's `datasources` block into `DS_ENTITY_MAP`
- Logs: `[Bridge] Loaded external DataSource: <id> (from plugin <plugin-id>)`

Schema files inside the container appear at `/opt/zato/external-plugins/<plugin-id>/zato/schema.sql` — init services should reference that path.

## PICT Testing Against Zato

The same PICT test suite runs against Zato:
```bash
node packages/bridge/api-to-app/pipeline.mjs \
  --spec=packages/bridge/api-to-app/specs/petstore-zato.json \
  --base-url=http://localhost:11223/api \
  --endpoint=all --seed=42
```

239/289 pass (82%). Failures are SQLite concurrency under rapid writes — a real bug PICT exposed.

## Key Files

- `packages/bridge/server.mjs` — `/ds/` endpoint, `DS_ENTITY_MAP`, `handleRestDataSource()`
- `extension/smartclient-app/renderer.js` — RestDataSource creation, `dsFetch`/`dsAdd`/`dsSave` actions
- `docker/zato/services/petstore/pet.py` — Zato services with SQLite
- `docker/zato/docker-compose.yml` — Zato 3.3 quickstart container
- `examples/app-pet-restds-config.json` — Plugin config for RestDataSource CRUD
- `packages/bridge/api-to-app/specs/petstore-zato.json` — Zato-specific OpenAPI spec


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
const { extendPage } = require(process.env.SMARTCLIENT_SDK + '/tools/playwright/commands.js');

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
const { extendPage } = require(process.env.SMARTCLIENT_SDK + '/tools/playwright/commands.js');

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

## Critical SmartClient module dependencies

**`ISC_DataBinding.js` is required for forms to accept input** — even when you don't use a DataSource. SC's form change handler internally calls `RPCManager.startQueue()` which lives in DataBinding. Without it:

- typing into a field updates the DOM input
- but SC's model never gets the new value (`handleChange` throws a silent `TypeError: Cannot read properties of undefined (reading 'startQueue')`)
- on blur, SC reverts the visible input back to the model's stale value
- `change`/`changed` handlers never fire
- the form looks editable but every save captures the original defaults

**Minimum module set for a working form** (raw → brotli@5):
- `ISC_Core` (1.9 MB → 389 KB)
- `ISC_Foundation` (479 KB → 91 KB)
- `ISC_Containers` (190 KB → 37 KB)
- `ISC_Forms` (1.2 MB → 221 KB)
- `ISC_DataBinding` (1.9 MB → 393 KB)  *required even without DataSource*
- Tahoe `load_skin.js` + `skin_styles.css` (~40 KB brotli)

Total wire size: ~1.4 MB brotli. `HTMLFlow` also lives in `ISC_DataBinding`, so loading it gets you that for free.

## Standalone SmartClient app testing (Playwright via bridge)

For testing **standalone web apps** (no extension iframe), use Playwright through the bridge's playwright-shim — assertions and screenshots surface in the dashboard's Test Results portlet.

```javascript
import { chromium, client } from '../packages/bridge/playwright-shim.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Vendored at packages/bridge/vendor/sc-playwright-commands.cjs (.cjs forces
// CommonJS interpretation; resolves @playwright/test from our node_modules).
const { extendPage } = require('../packages/bridge/vendor/sc-playwright-commands.cjs');

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
extendPage(page);
page.configureSC({ scAutoWait: false, scLogLevel: 'silent' });
```

`@playwright/test` must be a dev dep (the SC commands.cjs requires it).

### When to use which interaction primitive

| Goal | Use | Notes |
|---|---|---|
| Click a SC button | `clickSC('//Button[ID="..."]')` | Real mouse events, fires SC click handler |
| Read a SC component's state | `page.evaluate(() => isc.AutoTest.getObject('...').getX())` | Most flexible |
| Fill a SC text item | `page.evaluate(() => calcForm.setValue('x', 'val'))` | `typeSC` often fails — see below |
| Verify model state after async | `waitForFunction(() => location.hash === expected, ...)` | Deterministic signals |
| Trigger an async function and await it | `page.evaluate(() => fnReturningPromise())` | SC click handlers don't await returned promises |

### `typeSC` and form-item locators don't reliably work

The vendored commands.cjs uses `isc.AutoTest.waitForElement` (stricter than `getObject`) and **doesn't resolve `//DynamicForm[ID="X"]/item[name="Y"]` locators** — `typeSC` fails for most form items. Workaround: drive the form via `calcForm.setValue(name, value)` programmatically. SC's `setValue` does NOT fire change handlers (intentional, prevents loops), so verify the change handler is wired statically as a separate assertion:

```javascript
const wired = await page.evaluate(() => typeof calcForm.getItem('rate').changed === 'function');
client.assert(wired, 'change handler is wired');

await page.evaluate(() => {
  calcForm.setValue('rate', 6);
  refreshStatus();  // mirror what the change handler does on real keystroke
});
```

For tests that need to simulate true user typing (e.g., regression tests for a typing-broken bug), use Playwright's keyboard:
```javascript
await page.locator('input[name="rate"]').click({ clickCount: 3 });
await page.keyboard.type('6.5', { delay: 30 });
await page.keyboard.press('Tab');
```

### `scAutoWait` and `waitForSCDone` cautions

`isc.AutoTest.waitForSystemDone` can hang indefinitely on pages that bump SC's busy counter — most commonly **data-URI images** (e.g., a QR code rendered as `<img src="data:...">`). Symptom: `waitForSCDone` times out at the configured timeout, your script dies.

- **Disable** `scAutoWait: false` in `configureSC` and replace `waitForSCDone` with explicit signals: `waitForFunction(() => calcForm.getValue('x') === expected)` or `waitForTimeout(150)`.
- **Vendored bug fix**: the SDK's `waitForSCDone` references `timeout` in its catch block but declares it inside the try (out of scope → ReferenceError swallows the actual timeout error). Hoist it to outer scope when vendoring.

### Async click handlers

SC button click handlers **don't await async function returns**. If your handler calls `async function save()`, the `clickSC` returns immediately and your `waitForFunction` may race the async work.

For testing, pick the path:
- Test the button-to-handler integration **once** with `clickSC` + a deterministic wait
- Test subsequent invocations with `page.evaluate(() => save())` so you can `await` the promise

### Layout gotcha — Label `valign`

SmartClient `Label` defaults to `valign: "center"`. If you use a Label as a container for stacked HTML rows (e.g., a recents list), set `valign: "top"` explicitly — otherwise a single row appears mid-container with empty space above.

### `change` vs `changed` handler

- `change` — fires per-keystroke when `changeOnKeypress: true` (default for most items). Receives `(form, item, value, oldValue)`.
- `changed` — fires after the value is committed (blur, programmatic change, etc.).

For an explicit Calculate-button workflow, `changed` is usually the right choice — `change` would fire too eagerly while the user is still typing.


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

## CDP UI Testing (ui-testing skill)

Use CDP via scripts in `packages/bridge/scripts/` for live UI testing:

- `cdp-screenshot.mjs <ws-url> <path>` — screenshot any page/iframe
- `iframe-click.mjs <sandbox-ws> <js-expr>` — eval in SmartClient sandbox
- `sw-eval.mjs <js-expr>` — eval in service worker

### Plugin Testing Gotchas

- **SectionStack breaks buttons**: renderer only walks `members`, not `sections[].items[]`. Use VLayout + Labels instead.
- **DynamicForm payload**: `_payloadFrom` prefers `getValues` for forms (not `getSelectedRecord` which returns null). If handlers receive empty payload, check this.
- **AutoTest locators**: may miss components in non-standard nesting. Use tree-walk fallback from the root VLayout.
- **resolveRef**: only works in dashboard mode. In plugin mode, use `isc.AutoTest.getObject`.
- **CheerpX spawn queue**: one hung command (sqlite3, python import) permanently jams ALL subsequent commands. Only fix: reload CheerpX tab.
- **Extension reload**: kills CheerpX content script connections. Must reload CheerpX tab separately (25s+ boot).
- **CDP target ordering**: sandbox iframe position in target list varies. Always search by URL content, not index.

## ScriptClient Test Scripts

Test scripts in `examples/test-*.mjs` use `ScriptClient.assert()`:

```javascript
import { ScriptClient } from '../packages/bridge/script-client.mjs';
const client = new ScriptClient('my-test', { totalSteps: 3 });
await client.connect();
client.assert(condition, 'description');  // tracks pass/fail
await client.artifact({ type: 'screenshot', label: 'Result', filePath: '/tmp/shot.png', contentType: 'image/png' });
await client.complete({ assertions: client.getAssertionSummary() });
```

Results appear in the dashboard's Assertions tab (real-time) and Test Results portlet.

## CDP Plugin Testing Pattern

**Standard pattern for testing SmartClient plugins end-to-end.** Connects to the extension browser (port 9222) via CDP, opens the plugin, evaluates JS in the sandbox iframe, and reports assertions to the dashboard via ScriptClient.

**Why CDP instead of Playwright sessions**: Playwright sessions spawn separate browsers without the extension loaded, so `chrome-extension://` URLs fail. CDP on port 9222 connects to the browser that has the extension, so plugin URLs work.

### Architecture

```
Test Script (Node.js)
  ├── ScriptClient → bridge WebSocket (progress, assertions, artifacts)
  └── CDP WebSocket → port 9222 → extension browser
       ├── http://localhost:9222/json → find page + sandbox iframe targets
       ├── Runtime.evaluate in sandbox iframe → isc.AutoTest API
       └── Page.captureScreenshot → artifacts
```

### Template (copy for new plugin tests)

```javascript
import { ScriptClient } from '../packages/bridge/script-client.mjs';
import http from 'http';
import WebSocket from 'ws';
import fs from 'fs';

const CDP_PORT = 9222;
const PLUGIN_MODE = 'my-plugin-id';
const client = new ScriptClient('test-' + PLUGIN_MODE, { totalSteps: 4 });

// CDP helpers: getTargets(), cdpEval(), cdpScreenshot(), findPluginTargets()
// Copy from examples/test-csv-analyzer.mjs

try {
  await client.connect();

  // Step 1: Open plugin tab via CDP
  // PUT http://localhost:9222/json/new?chrome-extension://<extId>/smartclient-app/wrapper.html?mode=<pluginId>

  // Step 2: Verify components in sandbox iframe
  // cdpEval(sandbox.webSocketDebuggerUrl, `isc.AutoTest.getObject('//Button[ID="myBtn"]')`)

  // Step 3: Interact (click buttons, fill forms)
  // cdpEval(sandbox.ws, `isc.AutoTest.getObject('//Button[ID="btnLoad"]').click()`)

  // Step 4: Verify results (grid rows, status text)
  // cdpEval(sandbox.ws, `isc.AutoTest.getObject('//ListGrid[ID="myGrid"]').getTotalRows()`)

  const exitCode = client.summarize();
  await client.complete({ assertions: client.getAssertionSummary() });
  process.exit(exitCode);
} catch (err) {
  client.assert(false, 'Fatal: ' + err.message);
  client.summarize();
  await client.complete({ assertions: client.getAssertionSummary() }).catch(() => {});
  process.exit(1);
}
```

### Key SmartClient AutoTest APIs (use inside cdpEval)

```javascript
// Find component by ID
isc.AutoTest.getObject('//Button[ID="btnLoad"]')
isc.AutoTest.getObject('//ListGrid[ID="resultsGrid"]')
isc.AutoTest.getObject('//DynamicForm[ID="queryForm"]')

// Grid operations
grid.getTotalRows()
grid.getRecord(0)           // first row as object
grid.getFields().map(f => f.name)

// Form operations
form.setValue('fieldName', 'value')
form.getValues()            // all field values as object

// Button click
btn.click()

// HTMLFlow status text
flow.getContents()          // returns innerHTML string
```

### Running from Dashboard

1. Save script to `~/.agentidev/scripts/test-my-plugin.mjs`
2. Bridge file watcher auto-detects it
3. Select script in dashboard Scripts panel → click Run (no session needed)
4. Progress, assertions, screenshots appear in real-time

### Reference Implementation

`examples/test-csv-analyzer.mjs` — 16 assertions testing the CSV Analyzer plugin: component rendering, CSV load, column describe, query with sort/limit, screenshots at each stage.

### Agent-Generated Tests

The pi-mono agent can generate and run plugin tests via two tools:
- `script_save`: saves a test script to the library + disk
- `script_launch`: runs it and reports results to the dashboard

The agent should generate tests following this CDP pattern, NOT using Playwright sessions (which lack extension access).


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

`packages/bridge/scripts/query-vectordb.mjs` supports `--source=showcase` flag for partition-scoped queries.
