# Ubiquitous Language

Two views live in this document:

1. **Current canonical terms** — what words mean in the codebase today, derived from [`AGENTS.md`](../AGENTS.md). Use these when reading the code, writing PRs, or having design conversations about what exists.
2. **Future / refactor target terms** — vocabulary proposed in [`plans/zato-alt.md`](../plans/zato-alt.md) for the Browser-ESB refactor. Preserved for reference; not authoritative for the codebase as it exists.

When current and future use the same word with different meanings (Service, Channel, Pub/sub, Hot deploy), each entry calls out the conflict explicitly.

---

# Current canonical terms (from AGENTS.md)

Organized by [bounded context](CONTEXT_MAP.md#bounded-contexts).

## Memory context

### Page (Memory)

A captured web page stored in the vector DB. Shape: `{ id, url, title, content, embedding, source, addedAt }`. The unit of memory. Indexed by `source` for partition-scoped queries.

### Capture (Memory)

The act of saving a page's content from a browser tab into Memory. Driven by `extension/content.js` + `capture-handlers.js`. Excludes sensitive domains (banking, auth, login) by default. Always tagged `source: 'browsing'`.

### Source (Memory)

A partition tag on Page. Three values today: `browsing` (user activity), `showcase` (SmartClient SDK examples, bulk-loaded), `reference` (specs, docs, indexed reference material). Records without a `source` field default to `browsing` (no migration needed).

### Embedding (Memory)

A 384-dimensional vector produced by `all-MiniLM-L6-v2` running in a Web Worker spawned by the offscreen document. Service worker cannot run transformers.js directly (no WASM). Falls back to TF-IDF if embeddings fail. Neural similarity threshold: 0.3; TF-IDF threshold: 0.1.

### Query (Memory)

A natural-language search input. Classified before execution: temporal (`/last (week|month|year)/`), multi-topic (`/compare|both|and/`), multi-hop (`/related to|documentation for|error.*yesterday/`), or simple. Simple queries skip decomposition.

### Sub-query (Memory, RAG Phase 1.5)

A component of a decomposed Query, produced by a Query Decomposer. Sub-queries get exponentially less token budget by depth (`0.6^depth`). Max depth 3. Executed in parallel via `Promise.all()`. Future feature; not yet implemented.

### Token budget (Memory)

The 4K context window allocation for Phi-3-mini RAG queries. Managed by `TokenBudgetManager`. Always reserves ≥500 tokens for the final answer. Budget exhaustion (<500 tokens remaining) falls back to simple-query mode.

## Automation context

### Session (Automation)

A Playwright-controlled browser page launched by the bridge server. Has a sessionId. Created via `BRIDGE_SESSION_CREATE`, driven by ref-based commands (click, fill, navigate) from a snapshot. May be linked 1:1 to a Script.

### Script (Automation)

An automation file in `~/.agentidev/scripts/` driven by `packages/bridge/playwright-shim.mjs`. State machine: `registered → running → checkpoint|paused → complete|cancelled|killed`. Has a name, totalSteps, PID, and a `checkpoints[]` array. Source files are file-watched (300ms debounce). Force-killed with SIGTERM → SIGKILL after 2s.

> Open question (deferred): the user's framing is "Testapp" for the auto-generated test-Script flavor. Revisit when pinning api-to-app vocabulary.

### Checkpoint (Automation)

A named pause-point declared in a Script's source. Examples: `before_navigate`, `results_loaded`. Reached during execution; the Script reports `BRIDGE_SCRIPT_CHECKPOINT` and (if active as a breakpoint) blocks until stepped/cleared.

### Breakpoint (Automation)

A Checkpoint marked as **active** — execution pauses when reached. Set via `BRIDGE_SCRIPT_SET_BREAKPOINT`. Pending Breakpoints (set before the Script connects) are held in `pendingBreakpoints` by PID and transferred at register-time. Distinct from V8-level breakpoints used by the inspector.

### Schedule (Automation)

A cron-driven Script launch. Persisted to `~/.agentidev/schedules.json`. Server-side cron with overlap prevention (one active run per schedule). Triggered manually via `BRIDGE_SCHEDULE_TRIGGER`.

### Run (Automation)

A single execution of a Script from registration to completion. Each Run produces a Run archive saved via `BRIDGE_SCRIPT_RUN_COMPLETE`. Identified by runId distinct from scriptId and PID.

### Artifact (Automation, also surfaced in Testing)

An output captured during a Script run: screenshot, console buffer, file path, etc. Reported via `BRIDGE_SCRIPT_ARTIFACT`. Surfaces in the dashboard's Artifacts tab. Also produced by ScriptClient tests (`client.artifact({ type, label, filePath, contentType })`).

### Bridge protocol (Automation)

The WebSocket message format on port 9876. Envelope `{ id, type, source, timestamp, payload }`. Type prefix `BRIDGE_`. Built via `buildMessage()` / `buildReply()` in `protocol.mjs`. Roles: `extension`, `script`, `cli`, `claude`.

### Playwright shim (Automation)

`packages/bridge/playwright-shim.mjs` — drop-in for `import { chromium } from 'playwright'`. Auto-connects ScriptClient, wraps Page instances, intercepts navigate/click/fill/wait/eval/screenshot and declares them as checkpoints (`p1:navigate`, `p1:click`, etc.). Reads `BRIDGE_CDP_ENDPOINT` for session reuse.

## Apps context

### Plugin (Apps)

A bundle that declares a SmartClient app. Two variants exist:

- **In-tree plugin** — lives under `extension/apps/<id>/`, descriptor file is `manifest.json`. Loaded via wrapper iframe `?mode=<pluginId>`. Examples: `csv-analyzer`, `sqlite-query`, `hello-runtime`.
- **External plugin** — lives under `EXTERNAL_PLUGINS_DIR/<id>/`, descriptor file is `plugin.json` (different filename from in-tree). Loaded via wrapper iframe `?ext=<pluginId>`. May ship a `zato/` side-car with `services/*.py`, `schema.sql`, `channels.json`. See [external-plugin-spec.md](external-plugin-spec.md) for the canonical schema.

Both variants declare `id`, `name`, `version`, and a config payload (`dataSources[]`, `layout`). In-tree adds `modes`, `templates`, `handlers`, `requires.hostCapabilities`. External plugins are a cross-context artifact spanning Apps + Automation + Zato Integration.

### App (Apps)

A **dynamically created** SmartClient config persisted to IndexedDB (`sc-apps` database, `apps` object store). Record shape: `{ id, name, type: 'generate' | 'clone', config: { dataSources, layout }, prompt, sourceUrl, cloneId, createdAt, updatedAt }`. Two origins:

- `type: 'generate'` — produced by the AI generator (`SC_GENERATE_UI` handler → `bridgeClient.generateSmartClientUI(prompt)`), validated to have `dataSources[]` and `layout._type`, then auto-saved.
- `type: 'clone'` — copied from another page or app via `SC_CLONE_PAGE`.

Loaded via `?app=<id>` (IndexedDB lookup) or `?clone=1` (storage.session for in-flight clone preview).

The Plugin vs App axis is **how the config came into existence**:
- Plugins are written by developers and shipped in the repo (`extension/apps/`).
- Apps are created at runtime by users or AI generation, stored only on this device.

> Open question (deferred): the user's framing says the api-to-app pipeline produces an artifact that's part-Testapp (auto-generated tests), part-Plugin (final UI). Whether the pipeline's output should be a saved App (per-device IndexedDB record) or a Plugin (committed repo bundle) — or both — is still TBD.

### Plugin Mode (Apps)

A URL parameter on the wrapper iframe (`?mode=<pluginId>`) that names which Plugin to load. One Plugin may declare multiple Modes (e.g., dashboard mode + plugin-specific mode). The Mode value maps to a specific template in `manifest.json`.

### Renderer (Apps)

`extension/smartclient-app/renderer.js` — the engine that turns a JSON config into live SmartClient components. Validates against `ALLOWED_TYPES` whitelist. Resolves IDs via `componentRegistry`. Dispatches user-defined `_action` strings through `ACTION_MAP`. Applies cell `_formatter` strings (`stateDot`, `timestamp`, `elapsed`, `progressBar`). **No eval** — only declarative bindings.

### Component (Apps)

A SmartClient widget rendered from a config object. Must declare `_type` (from `ALLOWED_TYPES`: `VLayout`, `HLayout`, `ListGrid`, `DynamicForm`, `Button`, `Label`, `TabSet`, `Tab`, `DetailViewer`, `SectionStack`, `HTMLFlow`, `Window`, `ToolStrip`, `ToolStripButton`, `PortalLayout`, `Portlet`, `Canvas`, `Progressbar`, `ImgButton`, `ToolStripSeparator`, `ToolStripMenuButton`, `Menu`). Components with an `ID` are registered in `componentRegistry` for cross-component reference.

### componentRegistry (Apps)

The in-renderer `Map<componentId, componentRef>` used by `resolveRef(id)` to find live components across an App instance. Scope is one App instance. Only works in dashboard mode; plugins use `isc.AutoTest.getObject` instead.

### DataSource (Apps)

A SmartClient data binding declared in an App or Plugin config. Several backings exist today:
- **clientCustom** — for sandbox iframes that can't use XHR (which is cross-origin-blocked). Uses `fetch()` directly inside a `transformRequest` callback.
- **RestDataSource** — points at the bridge's `/ds/<EntityDS>` endpoint, which translates SmartClient's wire protocol into Zato calls.
- **IndexedDB-backed** — anything not in `BRIDGE_BACKENDS` falls through to the `smartclient-data` IndexedDB database, with object stores auto-created per DS ID.

DS response format is **always** `{ status: 0, data: [...] }` for success or `{ status: -1, data: errorMsg }` for error — **not** `{ success: true }`.

### Action (Apps)

An `_action` string on a Component that maps to a function in `ACTION_MAP`. Examples: `dsFetch` (calls `grid.fetchData(criteria)`), `dsAdd` (calls `grid.startEditingNew()`), `dsSave` (commits pending edits), `fetchUrlAndLoadGrid`, `fetchAndLoadGrid`. Composed declaratively from config; no eval.

### Formatter (Apps)

A `_formatter` string on a Component cell, mapped to a render function. Built-ins: `stateDot` (colored circle by state), `timestamp` (epoch → HH:MM:SS), `elapsed` (relative time), `progressBar`.

### Sandbox iframe (Apps)

`extension/smartclient-app/wrapper.html` loads `app.html` inside a sandboxed iframe. All communication uses `postMessage` via `bridge.js` (host page) ↔ `app.js` (sandbox). `bridge.js` translates DS operations to `chrome.runtime.sendMessage` calls.

## Testing context

### ScriptClient (Testing)

`packages/bridge/script-client.mjs` — the Node SDK that test Scripts use to report into the bridge: `connect()`, `assert(condition, label)`, `artifact({type,label,filePath,contentType})`, `progress(step, totalSteps)`, `complete({assertions})`, checkpoints. Results surface in the dashboard's Assertions tab in real-time, and in the Test Results portlet on completion.

### Assertion (Testing)

A single `client.assert(condition, description)` call inside a test Script. Tracked in `getAssertionSummary()`. Distinct from a Jest assertion (`expect(...)` matchers run in `npm test`).

### Test Results portlet (Testing)

The dashboard panel that surfaces ScriptClient assertion summaries and artifacts post-run. Plumbed via `BRIDGE_SCRIPT_RUN_COMPLETE`.

### CDP plugin test (Testing)

A test pattern documented in `.claude/rules/tests.md`: connects to the extension browser via CDP on port 9222, finds the sandbox iframe target, evaluates against `isc.AutoTest.getObject('//Button[ID="..."]')`, reports via ScriptClient. Used instead of Playwright sessions (which spawn separate browsers without the extension loaded). Reference: `examples/test-csv-analyzer.mjs`.

### AutoTest locator (Testing)

The string-based component selector SmartClient generates: `//Button[ID="btnNewSession"]`, `//ListGrid[ID="schedulesGrid"]/row[index=0]/col[name="name"]`. Always starts with `//`. Discovered at runtime via `isc.AutoTest.getLocator(element)` in the browser console. Never use CSS selectors for SmartClient components — they change on redraws.

### Jest test (Testing, dev-time)

Unit tests in `tests/` run via `npm test &` (always backgrounded). Mocks bridge-client functions and asserts handler routing logic. Distinct from runtime tests — Jest does not connect to the bridge.

## Zato Integration context

### REST channel (Zato Integration)

A Zato-side REST endpoint that exposes a Zato service. Created via `zato create-rest-channel --path ... --name ... --url-path ... --service ...`. URL paths must be unique per channel (no method-based routing on same path); `/api/pet/update` for PUT, `/api/pet/delete/{id}` for DELETE.

### Zato service (Zato Integration)

A Python class in `docker/zato/services/<plugin>/<file>.py` deployed via Zato's pickup directory. Quirks: `self.request.http.GET` doesn't reliably read query params (use `self.wsgi_environ['QUERY_STRING']`); SQLite needs `PRAGMA journal_mode=WAL` and `busy_timeout=5000`.

### SIO (Zato Integration)

Simple I/O — Zato's declared input/output schemas on a service (Integer / String / List etc.). Runtime-validated Python.

### DS_ENTITY_MAP (Zato Integration)

The bridge's routing table in `packages/bridge/server.mjs` that maps SmartClient DataSource IDs to Zato REST channel calls. Each entry declares: `fetch` (GET), `fetchById` (GET), `add` (POST), `update` (PUT), `remove` (DELETE). Per-method, with paths and queryParams.

### `/ds/` endpoint (Zato Integration)

The HTTP endpoint on the bridge (port 9876) that accepts SmartClient RestDataSource wire-protocol requests and translates them into Zato calls per `DS_ENTITY_MAP`. Handles update-merge (SmartClient sends partial fields; bridge fetches current record + merges) and response flattening (nested `category: {id, name}` → `category: "Dogs"`).

### EXTERNAL_PLUGINS_DIR (Apps + Automation; Zato Integration conditional)

Environment variable pointing to a sibling directory of plugin folders. Each external plugin always has a `plugin.json` (Apps concern). Plugins **may optionally** include a `zato/` subdirectory (`services/*.py`, optional `schema.sql`, `channels.json`) — only then does Zato Integration get involved (bridge merges `datasources` into `DS_ENTITY_MAP` at startup; provisioner deploys services + creates channels). Pure-browser external plugins use `clientCustom` or IndexedDB-backed DataSources and require no Zato. See [external-plugin-spec.md](external-plugin-spec.md).

### Hot-deploy (Zato Integration)

Zato's mechanism for loading new Python service code: drop `.py` files into the pickup directory, Zato detects and re-imports. Used by `setup-channels.sh` and the EXTERNAL_PLUGINS_DIR loader.

> Conflict with future-state: the refactor doc splits "Hot deploy" into SW update / Manifest reload / Config push / Script sync. None of those apply today — today, "Hot-deploy" means *exactly* Zato's pickup mechanism.

---

# Future / refactor target terms (from plans/zato-alt.md)

The terms below were cooked in an earlier session from `plans/zato-alt.md`. They describe a proposed future Browser-ESB architecture, **not** the current codebase. Some terms collide with current canonical terms (Service, Channel, Pub/sub, Hot deploy, Plugin) — when this happens, the current meaning above is authoritative for the codebase that exists.

## Strategic terms

### Browser ESB

The new primary runtime — see [contexts/browser-esb/CONTEXT.md](contexts/browser-esb/CONTEXT.md). Lives in the extension service worker, offscreen document, and sandbox iframe. Owns service routing, channels, scheduling, persistence, pub/sub.

### Host Helper

The shrunken bridge — see [contexts/host-helper/CONTEXT.md](contexts/host-helper/CONTEXT.md). A Node.js process that owns only capabilities the browser cannot do (spawn Playwright, fs.watch, V8 inspector). It is **not** an ESB.

---

## Runtime terms

### Service (Browser ESB)

A stateless request/response handler with Zod-validated input/output, as defined by the `Service<I, O>` base class in `plans/zato-alt.md`. Called through any channel (HTTP route in the SW, Comlink RPC, Croner tick, topic subscription). Channel-agnostic.

> Not the same as: a Zato Python service (similar shape, lives in a different runtime — see "Zato service" below), the browser's `ServiceWorker` global (we say "service worker" or "SW" for that), a SmartClient `DataSource` backend (a Service may *back* a DataSource, but DataSources are a separate concern owned by the renderer).

### Zato service (Zato context, external)

A Python class in `docker/zato/services/` deployed via Zato's pickup directory. Same conceptual shape as a Browser ESB Service (request/response, declared I/O), but runs in the Zato process out-of-browser. Reached via REST channels per `.claude/rules/restdatasource-zato.md`.

### Session (Host Helper)

A Playwright-controlled browser page launched by the Host Helper. Has a sessionId. May be linked 1:1 to a Script that drives it via CDP. Lives in Host Helper exclusively; the Browser ESB does not use this term. Auth/identity concepts (OIDC tokens, passkey state) use other names (see Security section, to be written).

### Script (Host Helper)

A long-running automation that lives in a **Host Helper Node child process** and drives a Playwright Chromium instance via CDP. Has a totalSteps progression and named checkpoints. Lives behind a PID. Emits progress events. Source files live under `~/.agentidev/scripts/` and are sync'd to/from the browser via Host Helper's file watcher.

Scripts cannot move into the Browser ESB — they require `child_process`, the V8 inspector module, and a separately-spawned Chromium.

### Job (Browser ESB)

A long-running automation that lives in the **Browser ESB**. Implemented as an Actor (see below). Has the same conceptual shape as a Script (totalSteps, checkpoints, progress events) but runs in-browser and drives the user's existing tab or an offscreen worker, not a separately-spawned Chromium.

Jobs and Scripts share the dashboard model (same envelope, same progress shape, same checkpoint mechanism) but are addressed differently — Jobs by an in-browser ID, Scripts by PID — and run in different contexts.

A Service can *invoke* a Job. A Job can *invoke* Services.

### Actor (Browser ESB) — runtime primitive

An XState v5 state-machine instance: addressable by ID, has a mailbox (receives events via `send`), holds internal state, supports persistent snapshots (serialize to RxDB, rehydrate on next boot). Actor is a **runtime primitive**, not a product-level concept.

Used by:
- Every Job (Jobs are always Actors)
- Some Services that need internal state — e.g., a connection pool, a stateful AI session, a long-lived subscription. Most Services are stateless and do not use Actor shape.

XState `fromPromise` is the canonical pattern for wrapping a request/response Service in an actor mailbox when needed.


### Channel (Browser ESB) — inbound only

An adapter that delivers an invocation to a Service. Four canonical channel types:

| Channel | Backed by | Lives in |
|---|---|---|
| HTTP | Hono routes | Service Worker |
| RPC | Comlink | Web Worker ↔ main thread |
| cron | Croner | Web Worker |
| topic | BroadcastChannel + RxDB collection (for durable replay) | SW + Workers |

Every Service is invokable through any channel type; channels are configured per-deployment via the declarative config (YAML/TS manifest parsed by Zod). Aligns with Zato's "channel" vocabulary directly.

### ServiceRegistry (Browser ESB)

The single global `Map<ServiceName, Service>` that owns all Service definitions for the Browser ESB. Loaded at boot from the declarative config. Channels resolve invocations against this registry. There is exactly one ServiceRegistry per Browser ESB instance.

`BRIDGE_BACKENDS` (current DS-handler routing in `extension/lib/handlers/datasource-handlers.js`) collapses into ServiceRegistry. Each SmartClient DataSource binds at config time to one Service for `fetch` or to a CRUD quartet of Services (`fetch` / `add` / `update` / `remove`). DataSource is therefore a **binding pattern**, not a registry.

### componentRegistry (renderer, per-app)

The existing in-renderer map of SmartClient component IDs → live component refs, owned by `extension/smartclient-app/renderer.js`. Scope is one SmartClient app instance (dashboard or plugin). Unchanged. Separate concern from ServiceRegistry.

### Outgoing connection (Browser ESB)

A configured handle to an external system the Browser ESB makes outbound calls *to*. Examples: `ky` HTTP client to Zato REST channels, RxDB replication plugin to Supabase, `nats.ws` client. Mirror of Channel but in the opposite direction. The bridge's previous DS proxy to Zato is conceptually an Outgoing connection in the new world.

### Zato REST channel (Zato context, external)

A REST endpoint configured in the Zato process that exposes a Zato service. Same conceptual shape as a Browser ESB HTTP channel, but lives in the Zato process. From the Browser ESB's perspective, Zato REST channels are reached via Outgoing connections.

## Deployment terms

"Hot deploy" is an umbrella, not a precise term. There are four distinct deployment mechanisms in agentidev, each named separately:

### SW update (Browser ESB)

Updating the Browser ESB's compiled SW code. The only CSP-safe path for changing Service implementation logic. Mechanism: publish new assets → SW detects update → `skipWaiting` + `clients.claim` swaps on next navigation. Slow path; requires a reload.

### Manifest reload (Browser ESB)

Re-parsing the declarative config (YAML/TS manifest in IndexedDB) and rebinding the ServiceRegistry — which Services exist, which Channels expose them, which Outgoing connections they use. Closest analog to Zato's pickup-directory hot deploy. Fast path; no SW reload. Cannot change Service implementation code — only configuration.

### Config push (SmartClient apps)

Existing mechanism: SmartClient app config JSON lives in IndexedDB, sandbox iframe reloads its renderer with the new config. Per `extension/smartclient-app/wrapper.html`. Instant.

### Script sync (Host Helper)

Host Helper's `fs.watch` on `~/.agentidev/scripts/` propagates source-file changes to/from the browser's IndexedDB-backed script library. Debounced. Bidirectional. Per `bridge-server` rule.

## Messaging terms

### Topic (Browser ESB)

A named stream. Producers publish messages to a Topic; subscribers receive them. Backed by BroadcastChannel for live delivery + an RxDB collection of the same name for durable replay. Topics are referenced by string name. Cross-tab / cross-context within the same origin; not cross-origin.

### Pub/sub (Browser ESB)

The pattern of publishing to and subscribing from named Topics. Distinct from:

- **Event bus** — in-process emitter inside one Worker (mitt or similar). Same-context only; not cross-tab. Use for tight inner-loop signalling within a single service.
- **Live query** — a reactive query over an RxDB collection (`collection.find(...).$.subscribe(...)`). A subscription to *data* (rows matching a query) rather than to *events* (named topic messages). Used by SmartClient grids to render reactive data.
- **Extension message** — `chrome.runtime.sendMessage` / `onMessage` with `sendResponse`. Request/response RPC between extension contexts (background, content script, sidepanel). Not pub/sub. The Browser ESB's RPC channel (Comlink) supersedes this for new code, but extension-API integrations still use it where they must.

### Topic channel (Browser ESB)

The inbound Channel type that delivers a Topic message to a Service. Listed in the Channel taxonomy above. A Service registered on a Topic channel is invoked once per published message on that Topic.

## Identity & validation terms

### Correlation ID (cid)

A short opaque string (recommended: `nanoid(12)`) that identifies one **logical operation** across Service invocations, Channel hops, and log lines. Generated at the inbound Channel edge if absent; threaded through `Ctx`; echoed on response headers and event payloads.

Distinct from:
- **Script ID / PID** — identifies a Script execution (Host Helper concept).
- **Session ID** — identifies a Playwright page (Host Helper concept).
- **Run ID** — identifies a single end-to-end Script or Job run (one Script invocation may have multiple cids if it issues sub-calls).
- **Message envelope ID** — identifies a single WebSocket/bridge message frame.

A cid may span many Run IDs and many Message envelope IDs, but is always finer-grained than a Session.

### Manifest (Browser ESB)

The declarative config that defines, at boot time:
- Which Services exist (name → Service class binding)
- Which Channels expose each Service (HTTP path, RPC method, cron schedule, Topic name)
- Which Outgoing connections each Service may use (handle → URL/credentials)
- Which Topics exist and whether they are durable (RxDB-backed) or in-memory only
- Which DataSources are bound to which Services or CRUD quartets

Stored in IndexedDB; parseable as YAML or TypeScript. Validated against a Zod schema at load. The ~80-line bootstrap that the plan calls out is responsible for reading the Manifest and populating the ServiceRegistry, registering Hono routes, etc.

Changing the Manifest triggers **Manifest reload** (see Deployment terms). It does not require a SW update.

## Product-feature terms

### Plugin

A deployable bundle that contributes to the global Manifest. A Plugin bundles **all the pieces needed to add a feature to agentidev**: Services with their Channel bindings, Outgoing connections, DataSource bindings, SmartClient app configs (templates), and a `requires` block declaring which contexts/host-capabilities it touches.

Three Plugin shapes occur in practice (per `.claude/rules/restdatasource-zato.md` and `extension/apps/`):

| Shape | Contributes | Example |
|---|---|---|
| Pure-browser | Browser ESB Services + UI config | `csv-analyzer` |
| Browser + Zato | DataSource bindings + Outgoing connections to Zato REST channels (+ Zato-side service files for external plugins) | pet store demo |
| Browser + Host Helper | Services that delegate to Host Helper via the WebSocket boundary | debug / Playwright-driven plugins |

These are not three distinct concepts — they are three *capability profiles* of the same Plugin concept. The `requires` block names which capabilities a given Plugin uses.

A Plugin is the canonical packaging unit for shipping a feature, including for external plugins loaded from `EXTERNAL_PLUGINS_DIR`.

### Plugin Manifest

The per-plugin descriptor file. **Filename differs between Plugin variants:**

- In-tree plugins (`extension/apps/<id>/`) use **`manifest.json`** — declares `id`, `name`, `version`, `description`, `modes`, `templates`, `handlers`, `requires.hostCapabilities`. Loaded by the extension at build/runtime.
- External plugins (`EXTERNAL_PLUGINS_DIR/<id>/`) use **`plugin.json`** — same purpose but typically embeds the full SmartClient config (`dataSources[]`, `layout`) inline rather than referencing template files. Served by the bridge at `/external-plugins/<id>/plugin.json`.

The filename split is convention, not enforced by any shared type. See [external-plugin-spec.md](external-plugin-spec.md) for the external variant.

Distinct from the future-state **Manifest** (singular, global) — that's the aggregated runtime config proposed by the Browser ESB refactor. Plugin Manifests would contribute fragments to it at install time in that future world.

### Plugin Mode

The way a Plugin's UI is opened: `chrome-extension://<extId>/smartclient-app/wrapper.html?mode=<pluginId>`. One Plugin may expose multiple Modes (e.g., `dashboard` vs `csv-analyzer`). The Mode names a specific SmartClient app config to load.

### Agent (Browser ESB)

An LLM-driven conversation with tool-call capability. Built on the pi-mono framework (currently `extension/lib/vendor/pi-bundle.js`).

**Shape:** an **Actor** (XState v5 state machine). The Agent owns its conversation state, model config, tool list, RAG transform, and turn loop. An Agent receives user messages, calls the LLM, parses tool calls, invokes Tools, feeds results back into the LLM, and emits responses.

**Persistence:** Agent state — including conversation history, tool-call log, and the Actor snapshot — lives in an RxDB collection. The Agent is durable across sidepanel close, extension reload, and Chrome restart.

**Execution context:** ephemeral. The Worker that runs the Agent Actor is spawned **on demand**:
- The sidepanel spawns a Worker to host the Agent for interactive chat.
- The Service Worker spawns a Worker for scheduled or background invocations of an Agent.
- Other UI surfaces (future sidebar, popup) attach to the same persistent Agent state.

The sidepanel is therefore a **view** onto the Agent, not the Agent's home.

**LLM provider:** reached via an Outgoing connection. Today: Ollama (local), WebLLM (in-browser WASM via offscreen document), or a cloud provider. The Agent's `model` config names the provider; the Outgoing connection is configured in the Manifest.

### Tool (Browser ESB)

A **Service flagged in the Manifest as agent-callable**, with an additional LLM-readable annotation:
- `tool.name` — short identifier the LLM sees (e.g., `browse_navigate`, `memory_search`)
- `tool.description` — natural-language description for the LLM
- The Service's input Zod schema is exposed to the LLM as the tool's parameter schema.

Tool is **not a new runtime primitive**. Every Tool is a Service. A Tool may be implemented as a local Service (e.g., `memory_search` over the vectordb) or as a Service that delegates via the Host Helper boundary (e.g., `browse_navigate` driving a Playwright Session) or via an Outgoing connection (e.g., `exec_python` into CheerpX). The Agent does not know or care which.

A Service may be exposed to multiple Agents with different `tool.name` / `tool.description` annotations. A Service may also be invoked directly by Hono routes / Comlink / DataSources independent of being a Tool — Tool is just an annotation overlay.

### Conversation (Browser ESB)

The durable message log for one Agent session — user turns, assistant turns, tool calls, tool results, RAG context injections. Stored as an RxDB collection separate from the Agent's Actor snapshot (the Actor snapshot is a *pointer* to a Conversation, not the messages themselves). Multiple UI surfaces can render the same Conversation via RxDB live queries.

### SIO (Simple I/O)

Zato's term for declared input/output schemas on a Service. In the Browser ESB, SIO is implemented as **Zod schemas** assigned to a Service's `input` and `output` fields. The Service base class validates inputs on `invoke()` and outputs before returning. One source of truth for both runtime validation and TypeScript types.
