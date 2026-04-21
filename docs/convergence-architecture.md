# Convergence Architecture: Three Plans → One Stack

## The Three Plans

Three independent research documents converge into a single coherent architecture for agentidev:

1. **api-to-app.md** — OpenAPI spec → PICT test generation → LLM-driven service/UI implementation with TDD
2. **zato-alt.md** — Zato ESB capabilities mapped to in-browser JS/TS libraries (Hono + RxDB + XState + Zod)
3. **agentic-architecture-plan.md** — pi-mono agent loop + WebLLM/Ollama + Shadow Organization vision

Each plan was written independently. Together they describe a system where an AI agent can generate, test, and run a full-stack application entirely in a browser extension.

## How They Connect

```
                    OpenAPI Spec (or any structured input)
                        |
                        v
            +--- api-to-app (generation) ---+
            | Spec analyzer → endpoint tree  |
            | PICT → minimal covering tests  |
            | LLM → services + DDL + UI      |
            | pytest harness → red/green loop |
            +---------------+----------------+
                            |
                            v
            +--- zato-alt (runtime) ---------+
            | Hono in Service Worker          |
            |   = channel abstraction         |
            | RxDB on IndexedDB               |
            |   = persistence + sync          |
            | XState v5 actors                |
            |   = routing + orchestration     |
            | Zod schemas                     |
            |   = SIO validation              |
            | Croner                          |
            |   = scheduling                  |
            | BroadcastChannel                |
            |   = pub/sub                     |
            +---------------+----------------+
                            |
                            v
         +--- agentidev (substrate + brain) -------+
         | SmartClient renderer (UI output)         |
         | Plugin system (service registry)          |
         | Bridge server (testing, sessions, debug)  |
         | pi-mono agent (LLM loop + tool calling)   |
         | CheerpX (Python/Linux escape hatch)        |
         | Semantic memory (384-dim vector search)    |
         | Playwright (browser testing)               |
         +---------------------------------------------+
```

## What Already Exists

The agentidev extension is not starting from zero. Significant portions of the convergence stack are already built:

### Already Built (production-quality)
- **SmartClient renderer** — JSON-declarative UI configs, ALLOWED_TYPES whitelist, ACTION_MAP with dispatchAndDisplay/fetchAndLoadGrid/streamSpawnAndAppend, dynamic field inference, DataSource proxy to IndexedDB
- **Plugin system** — manifest.json + handlers.js + templates/, static registration in _loaded.js, storage-backed and file-backed plugins, plugin loader with handler registration
- **Bridge server** — WebSocket ESB on port 9876, session management, script lifecycle, cron scheduling, V8 debugging, trace/video recording, artifact archiving
- **Service Worker message routing** — type-based dispatch to handler map, 170+ registered handlers, async response pattern with MV3 compat
- **IndexedDB persistence** — auto-creating object stores per DataSource, CRUD via DS proxy, IDB sync to SQLite backup
- **Semantic memory** — all-MiniLM-L6-v2 embeddings, 384-dim, source-partitioned (browsing/showcase/reference), sub-300ms cosine search
- **Playwright integration** — sessions, snapshots, CDP screenshots, auth capture, tracing, video, console/network panels
- **CheerpX runtime** — x86 Linux VM with PYTHONHASHSEED=0 fix, spawn timeout + queue recovery, DataDevice file transfer
- **CheerpJ runtime** — Java-to-WASM, library mode, BeanShell scripting
- **Testing infrastructure** — ScriptClient.assert(), artifact registration, Assertions tab, Test Results portlet, 145 unit tests

### Newly Built (Apr 2026)
- **pi-mono agent loop** — LIVE. Agent runs in sidepanel with 14 tools, Ollama Llama 3.2 3B. Tool calling verified (plugin_list, network_fetch, exec_python). Self-corrects on tool failures. Progressive LLM chain: Ollama → WebLLM → cloud API.
- **pi-bundle.js** — 981KB esbuild bundle of pi-ai + pi-agent-core + TypeBox + OpenAI SDK. Unused providers stubbed. Loads in Chrome extension pages.
- **Dashboard enhancements** — Two-button Run (standalone vs Session), Assertions tab, Trace/Video toggles, Console/Network panels, Help window, timestamp formatting, Script History right-click
- **Playwright native features** — tracing (auto-stop + artifact), video recording, console/network capture, trace viewer (show-trace in new tab)
- **CheerpX spawn resilience** — Promise.race timeout, Ctrl+C on hang, PYTHONHASHSEED=0 auto-injection. Entropy starvation root cause identified.
- **CSV Analyzer plugin** — pure SW-side JS parsing, filter/sort/limit queries, dynamic grid columns
- **Windows compatibility** — junctions, npx.cmd, CDP port parsing, path escaping, bridge conflict detection, PowerShell trace zip
- **SmartClient bundled** — 27MB LGPL runtime committed (5 skins, all modules)
- **Setup script** — `node scripts/setup.mjs` handles forge junction, Playwright install, SmartClient check

### Partially Built (needs enhancement)
- **Agentiface loop** — still one-shot (prompt → Claude Haiku → JSON → render). Phase D planned: agent-driven iteration with sc.proposeSpec → sc.validate → sc.render → sc.revise
- **Service framework** — handlers ARE services (name-based dispatch, async, context-aware) but no formal Service class, no SIO validation, no correlation IDs
- **Config-driven bootstrap** — manifest.json + index.json pattern exists for plugins but not for services/channels/connections in the Zato sense
- **Agent streaming display** — text deltas empty from Ollama SSE (full text on done event works). Needs investigation of pi-ai openai-completions delta parsing.

### Built (Apr 20-21 2026 sprint)
- **Transport abstraction** — pluggable dispatch: chrome.runtime (extension) or WebSocket (CLI/server). Agent tools have zero chrome.* dependencies.
- **api-to-app pipeline** — LIVE. Spec analyzer, PICT runner, test generator, app generator, multi-level orchestration. 4 Petstore endpoints, 127 test cases, 93.7% pass against live API.
- **Multi-level PICT** — L0 endpoint selection with TSV seed flow to L1 per-endpoint models. 553 expanded cases.
- **CDP plugin testing** — test_plugin (quick component check), generate_plugin_test (full CDP test with assertions + screenshots). test-csv-analyzer.mjs: 16/16 pass.
- **Global agent selector** — persistent dropdown above tabs, syncs Agent chat + AF mode
- **Web UI (enterprise tier)** — bridge serves agent chat at http://localhost:9876/. Same protocol, no extension needed.
- **Zod schema validation** — 12 handler schemas in handler-schemas.mjs, non-blocking validation on message dispatch
- **App generator** — SmartClient plugin configs from OpenAPI specs (DataSources, ListGrids, DynamicForms, handlers)
- **Agent tools** — expanded to 21 tools: script_save, script_launch, generate_plugin_test, api_to_app

### Not Yet Built
- **Hono in Service Worker** — formal HTTP channel abstraction (currently hand-rolled message routing)
- **XState actors** — routing/orchestration (currently flat handler map)
- **RxDB** — reactive collections with sync (currently raw IndexedDB via Dexie-like proxy)
- **WebLLM live inference** — bundle + provider ready, WebGPU detected, but untested with actual model download + chat
- **CheerpX base image rebuild** — current debian_mini.ext2 has entropy starvation. Need haveged or getrandom stub for full Python/sqlite3 support
- **LLM build driver** — agent-driven red-green TDD loop: feed failing tests + spec to LLM, generate implementation

## Why pi-mono Is the Next Logical Step

pi-mono fills the single biggest gap: **the agent loop**. Everything else is infrastructure. The agent loop is what turns infrastructure into a self-driving system.

### What pi-mono provides that we can't build faster ourselves

1. **pi-ai** — Provider-agnostic LLM abstraction. 10 APIs, 20+ providers, lazy-loaded. Streaming events (text_delta, toolcall_delta, thinking_delta, done). TypeBox schemas for typed tools. OpenAI-compatible API works with WebLLM, Ollama, and cloud providers through the same interface.

2. **pi-agent-core** — The agent loop. Inner loop (stream → execute tools → check steering → repeat) and outer loop (follow-up messages). `transformContext()` for RAG injection. `beforeToolCall`/`afterToolCall` hooks for approval gates. Parallel or sequential tool execution. Custom AgentMessage types via TypeScript declaration merging.

3. **pi-web-ui** — MV3-compatible chat interface. Lit web components, sandboxUrlProvider for extension CSP, ArtifactsPanel for rendered previews, streaming display with partial JSON rendering. Embeddable anywhere via `new ChatPanel()`.

### The integration path

**Phase A: pi-ai provider layer** — DONE
**Phase B: Agent tools** — DONE (21 tools including api-to-app, plugin testing, script management)
**Phase C: Agent loop + chat UI** — DONE (sidepanel chat, streaming, RAG injection)
**Phase D: Agentiface loop upgrade** — DONE (agent-powered generation in AF mode)
**Phase E: WebLLM in-browser inference** — PARTIAL (provider ready, untested with model download)
**Phase F: Transport abstraction** — DONE (pluggable dispatch, enterprise web UI)
**Phase G: api-to-app pipeline** — DONE (spec → PICT → tests → app, multi-level, Zod validation)

### After pi-mono: the convergence becomes possible

Once the agent loop exists, the api-to-app and zato-alt visions become concrete:

- The agent can **read an OpenAPI spec** (tool: fs_read or browse_navigate)
- The agent can **generate PICT models** (tool: exec_python with PYTHONHASHSEED=0)
- The agent can **run PICT** (tool: exec_spawn)
- The agent can **generate service code** (LLM itself, with exemplar-pinned system prompt)
- The agent can **render SmartClient UIs** (tool: ui_generate via the existing renderer)
- The agent can **run tests** (tool: script_launch via the bridge)
- The agent can **iterate on failures** (the agent loop itself)

Without the agent loop, each of these is a manual step. With it, the user says "build me a Petstore app" and the agent drives the pipeline.

## The Progressive Capability Chain

The full vision is ambitious but the path is incremental. Each step adds value independently:

```
Today:      Human drives CLI/dashboard manually
Phase A:    LLM responds to prompts with streaming (pi-ai)
Phase B:    LLM can call agentidev tools (agent tools)
Phase C:    Agent loop runs autonomously with context (pi-agent-core)
Phase D:    UI generation self-corrects (agentiface loop)
Phase E:    Works offline with in-browser LLM (WebLLM)
Future:     Agent generates full apps from specs (api-to-app)
Future:     Generated services run in SW (zato-alt)
Future:     Shadow teams collaborate on analysis (Shadow Org)
```

Each phase is independently useful. Phase A alone makes Agentiface better. Phase C alone makes the dashboard agentic. Phase E alone makes the extension work without internet. The convergence is the long game.

## Architectural Decisions (Locked In)

These decisions are stable across all three plans:

1. **Agent lives in sidepanel, not service worker.** Sidepanel has a real document lifecycle (no MV3 sleep). SW handles messaging only.

2. **Bridge is the executor, agent is the brain.** Tools dispatch to bridge; bridge does the thing; result returns as tool output. Don't dual-drive.

3. **LLM provider chain is progressive.** Ollama (best quality) → WebLLM (no server) → cloud (API key) → prompt user. Same pi-ai abstraction targets all.

4. **Read-only first, write with approval.** Shadow Organization principle. Agent analyzes freely; actions require human confirmation via beforeToolCall hook.

5. **CheerpX is a tool, not a home.** Agent is native JS. CheerpX is called when Python/Linux is needed. Don't run the agent in emulated x86.

6. **SmartClient is the UI output format.** JSON-declarative, whitelist-validated, DataSource-backed. Already proven. Not switching.

7. **Tests are the contract.** api-to-app generates tests first, then implementation. The test harness IS the specification.
