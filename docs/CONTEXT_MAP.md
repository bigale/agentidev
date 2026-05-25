# Context Map

Two views live in this document:

1. **Current domain** — what the system IS today, derived from [`AGENTS.md`](../AGENTS.md) (the generated rollup of `packages/ai-context/sources/`). This is canonical for understanding the codebase as it exists.
2. **Future / refactor target** — what the system MIGHT BECOME, per [`plans/zato-alt.md`](../plans/zato-alt.md) (cooked in an earlier session). Preserved for reference; not authoritative for the codebase as it exists today.

The current domain section was cooked from AGENTS.md after the refactor section. Treat the two as **independent maps** of the same territory at different points in time.

---

# Current domain (canonical)

agentidev is a **browser extension for semantic memory and automation**. Local-first (IndexedDB), privacy-preserving, Chrome MV3. The product has two headline capability areas (Memory, Automation), a UI delivery surface (Apps), a runtime testing capability (Testing), and one optional external-integration glue layer (Zato Integration).

## Bounded contexts

### Memory

Local-first semantic memory over the user's browsing. Owns: vector DB (`extension/lib/vectordb.js`), embeddings (all-MiniLM-L6-v2 via offscreen + Web Worker), capture from active tabs, RAG pipeline with token budget management, query classification + decomposition (Phase 1.5 planned), source partitioning (`browsing`/`showcase`/`reference`).

Docs: [`contexts/memory/CONTEXT.md`](contexts/memory/CONTEXT.md)

### Automation

Browser automation via a Node-side bridge. Owns: bridge WebSocket server (`packages/bridge/server.mjs`, port 9876), Playwright sessions, scripts in `~/.agentidev/scripts/`, schedules (cron), V8 inspector debugging, file watcher, Playwright shim, ScriptClient SDK, the BRIDGE_* message protocol.

Docs: [`contexts/automation/CONTEXT.md`](contexts/automation/CONTEXT.md)

### Apps

SmartClient-based UIs. Owns: renderer engine (`extension/smartclient-app/renderer.js`, ALLOWED_TYPES whitelist, ACTION_MAP, formatters), plugin system (`extension/apps/*`), the dashboard (`dashboard-config.js`, `dashboard-app.js`), sandbox iframe architecture, componentRegistry, DataSource binding patterns (RestDataSource, clientCustom), Monaco editor host.

Apps consumes Memory + Automation + Zato Integration through DataSources, ScriptClient messages, and `chrome.runtime` handler routing. Apps does not own data — it renders what other contexts produce.

Docs: [`contexts/apps/CONTEXT.md`](contexts/apps/CONTEXT.md)

### Testing

Runtime testing as a product feature, plus dev-time unit testing. Owns: ScriptClient SDK (`packages/bridge/script-client.mjs`), CDP plugin testing pattern (port 9222, AutoTest), Test Results portlet in the dashboard, assertion/artifact display, Jest configuration for the extension's handler modules. **api-to-app pipeline placement is deferred** (see open questions below).

Docs: [`contexts/testing/CONTEXT.md`](contexts/testing/CONTEXT.md)

### Zato Integration

The glue that lets agentidev talk to Zato services. Owns: `DS_ENTITY_MAP` routing, the bridge's `/ds/` HTTP endpoint, RestDataSource wire-protocol translation, `docker/zato/services/*.py` source files, `setup-channels.sh`, the EXTERNAL_PLUGINS_DIR side-car mechanism, channels.json shape.

The Zato framework itself is an **external dependency** (Python ESB in a Docker container, third-party), not a context we own.

Docs: [`contexts/zato-integration/CONTEXT.md`](contexts/zato-integration/CONTEXT.md)

## Platform infrastructure (not a context)

Cross-cutting plumbing every context uses. Not a bounded context because it has no ubiquitous language of its own — it's wires:

- Service Worker (`extension/background.js`) — message routing
- Offscreen document (`extension/offscreen.js`) — DOM APIs for ML
- Web Workers — `embeddings-worker.js`, future `llm-worker.js`
- Sandbox iframe — `extension/smartclient-app/wrapper.html`
- Content script (`extension/content.js`)
- Bridge WebSocket protocol — the wire format between browser and `packages/bridge/server.mjs`

When a contract crosses this plumbing, it belongs to one of the five contexts above; the plumbing just carries it.

## External dependencies (not contexts)

- **Zato framework** — Python ESB, Docker (3.3 quickstart). Customer/supplier: we are the customer.
- **SmartClient SDK** — LGPL UI framework, bundled at `extension/smartclient/`. Apps's whole rendering surface uses it.
- **Playwright** — browser automation library. Automation uses it via a shim.
- **transformers.js** — runs all-MiniLM-L6-v2 in a Web Worker. Memory uses it.

## Relationships

```
┌─────────────────────────── Browser tab ───────────────────────────┐
│                                                                    │
│   Apps (sandbox iframe — SmartClient renderer + Plugins)           │
│         │                                                          │
│         │ postMessage → chrome.runtime.sendMessage                 │
│         ▼                                                          │
│   Extension Service Worker (message routing — platform)            │
│         │           │              │                               │
│         ▼           ▼              ▼                               │
│   ┌─────────┐  ┌──────────┐  ┌──────────┐                          │
│   │ Memory  │  │Automation│  │ Testing  │                          │
│   │ • RAG   │  │  client  │  │ScriptCli │                          │
│   │ • Capture│ │ bridge ws│  │ent SDK   │                          │
│   │ • Vector │ │          │  │          │                          │
│   │   DB     │ │          │  │          │                          │
│   └────┬─────┘ └────┬─────┘ └────┬─────┘                           │
│        │            │            │                                 │
│   Embeddings    Bridge WS   ScriptClient WS                        │
│    (offscreen)  port 9876     port 9876                            │
└────────│────────────│────────────│─────────────────────────────────┘
         │            │            │
         │            ▼            ▼
         │      ┌──────────────────────────┐
         │      │  Node Bridge Server      │
         │      │  packages/bridge/        │
         │      │   server.mjs             │
         │      │  • Playwright sessions   │
         │      │  • Script child procs    │
         │      │  • Cron scheduler        │
         │      │  • /ds/ HTTP endpoint    │
         │      │  • V8 inspector relay    │
         │      └──────────┬───────────────┘
         │                 │ HTTP (optional)
         │                 ▼
         │           ┌─────────────────┐
         │           │ Zato Integration│
         │           │ (glue we own)   │
         │           │   • DS_ENTITY_  │
         │           │     MAP         │
         │           │   • channels.   │
         │           │     json        │
         │           │   • services/   │
         │           │     *.py        │
         │           └──────┬──────────┘
         │                  │
         │                  ▼
         │           ┌─────────────────┐
         │           │ Zato framework  │
         │           │ (external)      │
         │           │  Docker, Python │
         │           └─────────────────┘
         ▼
   transformers.js (external dep)
   all-MiniLM-L6-v2
```

## Open questions (deferred during this cook)

- **api-to-app placement.** The user's framing: "api-to-app is really api-to-testapp-to-plugin." Testapp is auto-generated tests proving an API works; Plugin is the SmartClient UI that wraps the API for users. The pipeline currently stops at testapp. This blurs Testing and Apps. Defer until we pin the Plugin / App / Testapp terms.

## Resolved cross-context concerns

- **External plugin layout (resolved 2026-05-23).** External plugins (`EXTERNAL_PLUGINS_DIR/<id>/`) come in two variants:
  - **Pure-browser** — `plugin.json` only. Crosses **two contexts**: Apps (the config + renderer) and Automation (the bridge HTTP server hosting `/external-plugins/*`). No Zato Integration involvement.
  - **Zato-backed** — `plugin.json` + `zato/{services,channels.json[,schema.sql]}`. Crosses **three contexts**: adds Zato Integration (the side-car loader + provisioner).

  The mechanism is Apps + Automation by default; Zato Integration is conditional, triggered by the presence of a `zato/` directory. The canonical schema and contract live in [external-plugin-spec.md](external-plugin-spec.md), with invariants pinned in the affected context CONTEXT.md files. The descriptor filename split (in-tree `manifest.json` vs external `plugin.json`) is documented but not unified — flagged as a suggested future improvement in the spec doc.

---

# Future / refactor target (preserved, not canonical)

This was cooked earlier from `plans/zato-alt.md`. Captured for reference. Do not treat as a description of the current system.

See [ADR 001](adrs/001-browser-esb-replaces-bridge-as-runtime.md) for the strategic decision, and [ADR 002](adrs/002-agent-state-in-rxdb-execution-in-worker.md) for the Agent persistence model.

The proposed future-state collapses the current five-context picture into two: a Browser ESB context (Hono + RxDB + XState + Zod inside the SW, replacing the bridge as runtime) and a Host Helper context (the shrunken bridge, doing only Playwright + fs.watch + V8 inspector). Memory, Apps, Testing, and Zato Integration get absorbed into the Browser ESB as Services, Plugins, Tools, Outgoing connections, etc.

- Browser ESB CONTEXT: [`contexts/browser-esb/CONTEXT.md`](contexts/browser-esb/CONTEXT.md)
- Host Helper CONTEXT: [`contexts/host-helper/CONTEXT.md`](contexts/host-helper/CONTEXT.md)

The refactor framing is not wrong, but it's a target. The current domain section above is what the codebase looks like today.
