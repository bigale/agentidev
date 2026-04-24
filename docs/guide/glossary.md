# Glossary

Architecture terms used throughout agentidev documentation and diagrams. If you see a term in a mermaid box, it's defined here.

---

## Core Components

**SW (Service Worker)** — The Chrome MV3 background script (`extension/background.js`). Runs persistently (with MV3 lifecycle management), handles all message routing via a 187-handler dispatch table. The SW coordinates between the sidepanel, content scripts, offscreen document, and bridge server. In Chrome MV3, service workers replaced the old "background pages."

**Bridge Server** — Node.js WebSocket server running on port 9876 (`packages/bridge/server.mjs`). The portable core of agentidev — manages Playwright sessions, script execution, scheduling, vector search, and AI generation. Has zero chrome.* API dependencies, making it deployable on any Node.js host. Also serves HTTP for the enterprise web UI on the same port.

**Sidepanel** — The Chrome extension side panel (`extension/sidepanel/sidepanel.html`). Contains the agent chat, search, Q&A, extract, automation, docs, and Agentiface modes. The AI agent lives here.

**Transport Abstraction** — The layer (`extension/sidepanel/agent/transport.js`) that decouples agent tools from any specific messaging system. In extension context, dispatches via `chrome.runtime.sendMessage`. In CLI/server context, dispatches via WebSocket directly to the bridge. This is the portability boundary between personal and enterprise tiers.

---

## AI & Agent

**AI Agent** — The pi-mono powered assistant with 21 tools that runs in the sidepanel. Uses the agent loop from pi-agent-core for streaming, tool calling, and self-correction. Communicates with LLM providers via pi-ai.

**pi-mono** — The external library stack: pi-ai (LLM abstraction), pi-agent-core (agent loop), pi-web-ui (chat components). Bundled into `extension/lib/vendor/pi-bundle.js` (981KB) via esbuild.

**Ollama** — Local LLM server. Default provider. Runs models like Llama 3.2 3B on your machine. Free, no API key needed. Requires `OLLAMA_ORIGINS=*` for Chrome extension access.

**WebLLM** — In-browser LLM inference via WebGPU. Fully offline — downloads model weights (~2GB) on first use, then runs entirely in the browser. Needs Chrome 113+ with WebGPU support.

**RAG (Retrieval-Augmented Generation)** — The agent's `transformContext` hook that searches the vector database before each LLM call and injects relevant browsing history as context. Automatic and transparent.

**Global Agent Selector** — The dropdown above the sidepanel tabs that selects the active LLM provider (Ollama, WebLLM, Sonnet, Haiku, Opus). Persists to `chrome.storage.local`, syncs across all modes.

---

## Browser Automation

**Playwright** — Node.js browser automation library. Agentidev uses Playwright's bundled Chromium (not system Chrome) for extension support. Sessions are managed by the bridge server.

**Session** — A Playwright-managed browser instance. Created via the dashboard or agent. Each session has its own CDP endpoint and can be controlled via commands (goto, click, fill, snapshot). Sessions are separate from the extension browser.

**Snapshot** — An accessibility tree of the current page in YAML format. Elements have refs like `[ref=e42]` that can be used for click/fill commands. Snapshots are the agent's "eyes" — structured text, not screenshots.

**CDP (Chrome DevTools Protocol)** — The wire protocol for remote browser debugging. Port 9222 is the extension browser (has the extension loaded). Session browsers get auto-assigned ports. CDP is used for plugin testing because `chrome.scripting.executeScript` can't target extension pages.

**Trace / Video** — Playwright's built-in recording features. Traces capture a timeline of network, DOM, and screenshot data viewable in Trace Viewer. Video records screen captures. Both are toggled from the dashboard toolbar and auto-stop on script completion.

---

## SmartClient

**SmartClient** — Isomorphic JavaScript UI framework (LGPL v14.1p, bundled at 27MB). Renders declarative JSON configs into rich data-driven UIs (grids, forms, trees). Runs inside a sandboxed iframe (`app.html`).

**SmartClient Dashboard** — The main control center (`extension/smartclient-app/wrapper.html?mode=dashboard`). A PortalLayout with panels for sessions, scripts, schedules, assertions, artifacts, and history.

**Sandbox (iframe)** — The `<iframe sandbox="allow-scripts">` that runs SmartClient (`app.html`). Isolated from the extension's CSP. Communication with the wrapper page is via `postMessage` through `bridge.js`.

**Renderer** — The module (`extension/smartclient-app/renderer.js`) that converts JSON config into SmartClient components. Has an `ALLOWED_TYPES` whitelist and `ACTION_MAP` for wiring buttons to handler calls.

**Plugin** — A self-contained tool with a manifest, handlers, and a SmartClient UI template. File-backed plugins live in `extension/apps/<id>/`. Storage-backed plugins are published from Agentiface projects.

**Agentiface (AF)** — The sidepanel mode for generating SmartClient UIs from natural language prompts. Uses either the local agent (Ollama/WebLLM) or bridge Claude CLI for generation.

---

## Data & Search

**VectorDB** — IndexedDB-based vector database (`extension/lib/vectordb.js`). Stores 384-dimension embeddings from all-MiniLM-L6-v2. Cosine similarity search with source partitioning (browsing, showcase, reference).

**LanceDB** — Server-side vector database used by the bridge server. Stores embeddings for docs, showcase examples, and reference material. Faster than the extension-side IndexedDB VectorDB for large datasets.

**Embeddings** — 384-dimensional vectors from the all-MiniLM-L6-v2 model. Generated in a Web Worker via the offscreen document (SW can't run WASM directly). Used for semantic search over browsing history.

**Source Partitioning** — VectorDB records are tagged with a source: `browsing` (captured pages), `showcase` (SmartClient examples), `reference` (docs, specs). Searches can filter by source.

---

## Testing

**ScriptClient** — The bridge SDK for test scripts (`packages/bridge/script-client.mjs`). Provides `assert()`, `artifact()`, `progress()`, `checkpoint()`, and `complete()`. Results appear on the dashboard in real-time.

**PICT (Pairwise Independent Combinatorial Testing)** — Microsoft's combinatorial test case generator. Takes a model of parameters and values, outputs the minimal set of test cases that covers every pair. Installed at `/usr/local/bin/pict`.

**L0 / L1 / L2 Models** — Multi-level PICT hierarchy. L0 selects which endpoint + cross-cutting concerns (auth, content-type). L1 expands per-endpoint parameters. L2 (future) expands nested body schemas. TSV seeding propagates L0 values into L1 runs.

**CDP Plugin Testing** — The pattern for testing SmartClient plugins: connect to port 9222 via CDP, open the plugin in a tab, evaluate `isc.AutoTest.getObject()` in the sandbox iframe, assert results. Used by `test_plugin` tool and `generate_plugin_test` tool.

**Assertions Tab** — Dashboard panel showing real-time pass/fail results from `ScriptClient.assert()` calls. Green checkmarks and red crosses with messages.

---

## api-to-app Pipeline

**api-to-app** — The pipeline that generates test suites and SmartClient apps from OpenAPI specs. Modules: spec-analyzer, pict-runner, test-generator, app-generator, multi-level, pipeline. Lives in `packages/bridge/api-to-app/`.

**Spec Analyzer** — Reads OpenAPI 3.0 or Swagger 2.0 specs, extracts endpoints, and generates PICT model text with valid + negative (~prefixed) values per parameter.

**PICT Runner** — Executes the PICT CLI binary, writes model to temp file, parses TSV output into JavaScript objects.

**Test Generator** — Converts PICT rows into runnable `.mjs` test scripts using ScriptClient. Builds fetch calls, handles path/query/body params, flags negative cases.

**App Generator** — Generates SmartClient plugin configs from OpenAPI specs. Produces DataSources, ListGrids, DynamicForms, and handler code for API proxying.

**Negative Value (~prefix)** — PICT convention for invalid test inputs. A value like `~unknown_enum` is stripped to `unknown_enum` when sent to the API, but the test expects an error response (4xx). Agentidev tests are lenient — they accept 200 from servers that don't validate strictly.

---

## Runtimes

**CheerpX** — x86 Linux virtual machine running in WebAssembly (CheerpX 1.0.7). Provides Python 3, shell commands, and a Linux filesystem in the browser. Has entropy starvation issue (mitigated with `PYTHONHASHSEED=0`).

**CheerpJ** — Java Virtual Machine running in WebAssembly (CheerpJ 4.2). Supports running JAR files and Java classes in the browser. Library mode available.

**BeanShell** — Java scripting language. Runs inside CheerpJ. Used for lightweight Java scripting without compilation.

**Offscreen Document** — A hidden Chrome extension page (`extension/offscreen.html`) that provides DOM APIs not available in the SW. Hosts Web Workers for ML inference (embeddings). Required because service workers can't run WASM directly.

---

## Infrastructure

**Handler** — A function registered on the SW or bridge dispatch table by message type string (e.g., `BRIDGE_SESSION_CREATE`). The extension has 187 handlers. Handlers are the service layer — they process requests and return responses.

**Zod Schema** — Runtime validation schemas for handler payloads (`packages/bridge/handler-schemas.mjs`). 12 handler types have Zod input/output definitions. Validation is non-blocking (warns on invalid payloads).

**Croner** — Cron expression library used by the bridge server for scheduling scripts. Schedules persist to `~/.agentidev/schedules.json`.

**Monaco Editor** — VS Code's editor component, embedded in the SmartClient dashboard for script editing. Has a DataView compatibility fix for SmartClient's Simple Names mode.

**esbuild** — Build tool used to bundle pi-mono into `pi-bundle.js` (981KB). Uses a provider stub plugin to exclude unused LLM provider SDKs.

---

## Deployment

**Personal Tier** — Chrome extension + bridge server on an always-on PC. The bridge survives browser crashes. Local-first, privacy-preserving. The user's data never leaves their machine.

**Enterprise Tier** — Same bridge server deployed to a cloud VM. Web UI served at `http://host:9876/`. No Chrome extension needed. Same 22 tools, same pipeline, WebSocket transport instead of chrome.runtime. Optional Zato Docker backend.

**Portability Boundary** — The transport abstraction layer. Everything below it (bridge server, Playwright, LanceDB, PICT, scripts) is portable. Everything above it (extension UI, chrome.* APIs) is Chrome-specific. The boundary is clean and narrow.

---

## Backend / ESB

**Zato** — Open-source Python ESB (Enterprise Service Bus) running in Docker. Provides service orchestration, REST channels, database connections (PostgreSQL, SQLite), caching (Redis), and enterprise adapters (AMQP, JMS, SOAP). The bridge server connects to Zato via HTTP as a client. Zato handles service-to-service and service-to-database concerns.

**Frontend ESB** — The bridge server's role: handles browser-to-service concerns (UI protocol, agent tools, browser automation, PICT pipeline). Complements the backend ESB (Zato) rather than replacing it.

**Backend ESB** — Zato's role: handles service-to-service concerns (database connections, API composition, enterprise adapters, hot-deploy). The bridge calls Zato REST channels over HTTP.

**REST Channel** — Zato's term for an HTTP endpoint that maps to a service. Created via `zato create-rest-channel` CLI or web admin. Each channel has a URL path, HTTP method, and linked service.

**SIO (SimpleIO)** — Zato's service interface definition. Declares input/output parameters for a service. In Zato 3.x uses tuples; in 4.x uses dataclasses.

**enmasse** — Zato's bulk configuration tool. Imports/exports channel definitions, connections, and security config from YAML files. Used for reproducible deployments.

**Hot Deploy** — Zato's ability to load new services by dropping Python files into the pickup directory. No server restart needed. The bridge uses this for agent-driven service generation.

**BrowserPod** — Leaning Technologies' Node.js-in-browser runtime via WebAssembly. Portals create public URLs routing traffic to servers running inside the browser. Potential future integration for serverless deployment.

**Portal (BrowserPod)** — A public URL that routes traffic to a server process running inside a BrowserPod in the user's browser. Created automatically when code listens on a port. Enables sharing running applications without backend infrastructure.

**fetchUrlAndLoadGrid** — SmartClient renderer action that calls an API directly via HOST_NETWORK_FETCH without custom SW handlers. Supports GET (query params) and POST (JSON body). Used by storage-backed plugins generated from the api-to-app pipeline.

**RestDataSource** — SmartClient's LGPL (free) DataSource type for JSON-over-HTTP CRUD. Implements fetch/add/update/remove wire protocol. The bridge server can implement this protocol to give SmartClient grids full inline editing backed by Zato services.

**State Machine Test** — An exploratory test that walks through entity lifecycle transitions (create → read → update → list → delete → re-create). Catches bugs that linear workflow tests miss. Generated by `state-machine.mjs`.
