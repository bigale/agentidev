# Agentic Architecture Plan: pi-mono + agentidev

## The Shadow Organization

The product-level vision that frames everything below.

A **Shadow Organization** is an airgapped environment where a team of AI agents has read-only access to all organizational resources — documents, code, communications, data — and works autonomously: analyzing, planning, recommending. Human approval is required before any action touches the real world.

The key insight: **the analysis IS the product.** A Shadow CFO that reads every invoice, every contract, every bank statement and produces a weekly financial health report is valuable even if it never touches a bank account. A Shadow CTO that reads every PR, every architecture doc, every incident report and says "here's what's actually going on in your codebase" is valuable even if it never writes a line of code.

The read-only constraint isn't a limitation. It's the feature. It's what makes this deployable in environments where no sane person would let an AI agent have write access.

### Properties

- **Read-only / airgapped**: agents cannot corrupt real resources. Analysis happens in a sandbox.
- **Team of specialists**: Shadow CTO, Shadow CFO, Shadow PM — each agent has role-specific tools and data access. They collaborate via internal messaging (OpenClaw + Slack).
- **Human approval gates**: real people review and approve agent recommendations before execution. The agent does the analysis; the human makes the decision.
- **Progressive scale**: Shadow Person (individual) -> Shadow Small Business -> Shadow Department -> Shadow Company.

### How It Scales

**Shadow Person:** Browser history, bookmarks, email (read-only), calendar. One agent. "What should I focus on today?" "You have 3 overdue follow-ups, a meeting where the attendee just published a relevant paper, and your AWS bill spiked 40%."

**Shadow Small Business:** Quickbooks (read-only), CRM, email, social analytics. 2-3 agents. The bookkeeper notices cash flow will be tight in 6 weeks. The marketing agent sees which posts drove conversions. They coordinate a recommendation.

**Shadow Company:** Full department mirroring. Shadow Engineering reads every repo, CI pipeline, incident channel. Shadow Sales reads every CRM opportunity. Shadow Legal reads every contract. They talk to each other and surface cross-functional insights humans would miss.

### The Architecture

```
Real World (read-only mirror)
    |
    | authenticated browser sessions (agentidev extension)
    | semantic memory accumulation over time
    | document indexing into local vector DB
    v
+-------- Airgapped Shadow Environment --------+
|                                                |
|  Shadow CEO  <-->  Shadow CTO                  |
|      |                  |                      |
|  Shadow CFO  <-->  Shadow PM                   |
|                                                |
|  OpenClaw: agent-to-agent messaging            |
|  BrowserPod: sandboxed computation             |
|  CheerpJ/CheerpX: offline code execution       |
|  SmartClient: generated dashboards/reports      |
+----------------------+-------------------------+
                       |
                       | recommendations only
                       v
                 Human Approval Gate
                       |
                       | approved actions
                       v
                  Real World (write)
```

### The Moat

The moat isn't the AI. It's the **authenticated read-only access layer** — which is exactly what the agentidev extension provides:
- Log into any SaaS as the user (auth state capture + replay)
- Accumulate semantic memory over months of browsing (local vector DB)
- Run code without network access (CheerpJ/CheerpX WASM runtimes)
- Generate rich UI from analysis results (SmartClient declarative rendering)
- Coordinate multiple agents (OpenClaw messaging)
- Schedule autonomous background work (bridge cron)

That's the shadow environment. It already mostly exists. The agents are the last piece.

---

## Technical Vision

A specialized in-browser agentic AI that is an expert in its own tools. Small, local-first, privacy-preserving. Can run entirely in the browser (WebLLM), upgrade to local server (Ollama), or use cloud APIs when available. The agent drives the same capability surface that humans currently operate manually through the dashboard.

Most people don't have agentic AI on their systems. A browser extension that ships one — with real tools, real memory, and real automation — is genuinely new.

## What We Have (The Substrate)

```
+---------------------------+     +---------------------------+
|    Chrome MV3 Extension   |     |      Bridge Server        |
|                           |     |      (port 9876)          |
|  - Sidepanel (6 tabs)     |     |  - Playwright sessions    |
|  - window.Host interface  |     |  - Script lifecycle       |
|  - CheerpJ / CheerpX / BSH     |  - Cron scheduling        |
|  - 384-dim vector search  |     |  - V8 debugging           |
|  - SmartClient renderer   |     |  - Trace/video recording  |
|  - Plugin system           |     |  - LanceDB vectors       |
+---------------------------+     +---------------------------+
            |                               |
            +----------- WebSocket ---------+
```

**Capabilities already exposed via window.Host:**
- storage (get/set/del/blob)
- network (CORS-free fetch)
- exec (CheerpX spawn, CheerpJ runMain/runLibrary)
- fs (read/write/list/upload)
- identity (extension/install IDs)
- runtimes (cheerpj, cheerpx, bsh)

**Playwright tools via bridge:**
- session:create/destroy/navigate/snapshot/screenshot
- session:click/fill/eval/press
- session:tracing-start/stop, video-start/stop
- session:console, network
- script:launch/cancel/step

**Semantic memory:**
- all-MiniLM-L6-v2 embeddings (384-dim)
- Source-partitioned: browsing, showcase, reference
- Sub-300ms cosine search, fully local IndexedDB

## What We're Missing (The Brain)

1. **Agent loop** — no run cycle, no self-correction, no tool chaining
2. **LLM abstraction** — single hand-rolled Haiku call in Agentiface
3. **Streaming UI** — no chat interface, no progressive rendering
4. **Context management** — no RAG-as-middleware, no token budgeting
5. **Tool-calling protocol** — capabilities exist but aren't agent-callable

## pi-mono: The Missing Layer

Three packages, clean separation, all browser-viable:

### pi-ai (LLM Abstraction)
- 10 API backends, 20+ providers (Anthropic, OpenAI, Google, Ollama, LM Studio, etc.)
- Lazy-loaded providers (only import what you use)
- Streaming events: text_delta, toolcall_delta, thinking_delta, done, error
- TypeBox schemas for typed tools with AJV validation
- OpenAI-compatible API means same code targets WebLLM, Ollama, and cloud

### pi-agent-core (Agent Loop)
- Inner loop: stream response -> execute tools -> check steering -> repeat
- Outer loop: follow-up messages after agent would stop
- transformContext() hook: prune/inject at message level (RAG injection point)
- beforeToolCall/afterToolCall hooks: approval gates, error handling
- Parallel or sequential tool execution
- AgentMessage[] (app-specific) vs Message[] (LLM-specific) separation
- Custom message types via TypeScript declaration merging

### pi-web-ui (Chat Interface)
- Lit web components (no Shadow DOM, Tailwind CSS)
- ChatPanel, AgentInterface, ArtifactsPanel, SandboxIframe
- MV3 sandbox support via sandboxUrlProvider
- Streaming display with partial JSON rendering
- Registry-based custom tool renderers
- Embeddable: drop ChatPanel into any container

## In-Browser LLM Options

| Model | Size | Speed (dGPU) | Tool Calling | Notes |
|-------|------|-------------|--------------|-------|
| SmolLM2 1.7B | ~1GB | 40-60 tok/s | Poor | Classification/extraction only |
| Phi-3 Mini 3.8B q4 | ~2GB | 30-50 tok/s | Acceptable | Minimum viable for agentic |
| Llama 3.2 3B q4 | ~2GB | 25-40 tok/s | Acceptable | Good structured output |
| Llama 3.1 8B q4 | ~5GB | 20-30 tok/s | Good | Best quality, high VRAM |
| Gemini Nano (Chrome) | ~1.7GB | N/A | None | Summarization only, no tools |

**Practical floor for agentic tool-calling: Phi-3 Mini 3.8B**

**Hybrid strategy:**
- In-browser (WebLLM): simple tasks, classification, extraction, summarization
- Local server (Ollama): complex tool chains, multi-step reasoning
- Cloud API: highest quality, user provides key
- Same pi-ai abstraction layer targets all three

## Integration Architecture

```
+---------------------------------------------------+
|              Sidepanel / Dashboard                  |
|                                                     |
|  +------------------+  +------------------------+  |
|  | pi-web-ui        |  | Existing SC Dashboard  |  |
|  | ChatPanel        |  | (Sessions, Scripts,    |  |
|  | ArtifactsPanel   |  |  Traces, etc.)         |  |
|  +--------+---------+  +------------------------+  |
|           |                                         |
+---------------------------------------------------+
            |
  +---------v-----------+
  |  pi-agent-core       |
  |  Agent Loop          |
  |  - transformContext   |  <-- RAG injection from vector DB
  |  - beforeToolCall     |  <-- approval gates
  |  - afterToolCall      |  <-- error recovery
  +---------+------------+
            |
  +---------v-----------+
  |  pi-ai               |
  |  LLM Provider        |
  |  - WebLLM (browser)  |
  |  - Ollama (local)    |
  |  - Cloud APIs        |
  +---------+------------+
            |
  +---------v-----------+
  |  Agent Tools         |       (window.Host + Bridge)
  |                      |
  |  browse.*            |  navigate, click, fill, snapshot, screenshot
  |  memory.*            |  search, add, stats
  |  exec.*              |  cheerpx.spawn, cheerpj.run, bsh.eval
  |  fs.*                |  read, write, list, upload
  |  ui.*                |  sc.proposeSpec, sc.validate, sc.render
  |  schedule.*          |  create, list, trigger
  |  auth.*              |  capture, load, check
  |  trace.*             |  start, stop, view
  +----------------------+
```

## Implementation Phases

### Phase A: pi-ai Provider Layer (1-2 days)
- Install @mariozechner/pi-ai
- Create agentidev provider config: default to Ollama if available, fall back to WebLLM
- Replace Agentiface hand-rolled Haiku call with pi-ai streaming
- Add model selector to settings (Ollama models, WebLLM models, cloud with API key)
- Verify streaming works in both sidepanel and sandbox contexts

### Phase B: Agent Tools — Wrap Host Capabilities (2-3 days)
- Create TypeBox schemas for each Host capability
- Implement AgentTool wrappers:
  - `browse_navigate`, `browse_click`, `browse_fill`, `browse_snapshot`, `browse_screenshot`
  - `memory_search`, `memory_add`
  - `exec_spawn` (CheerpX), `exec_java` (CheerpJ), `exec_bsh` (BeanShell)
  - `fs_read`, `fs_write`, `fs_list`
  - `ui_generate` (SmartClient JSON spec)
  - `schedule_create`, `schedule_list`
- Tools dispatch over WebSocket to bridge or call Host directly
- beforeToolCall hook wired to existing pause/resume/cancel mechanism

### Phase C: Agent Loop + Chat UI (2-3 days)
- Install @mariozechner/pi-agent-core and pi-web-ui
- Drop ChatPanel into a new sidepanel tab (replacing Q&A)
- Wire agent to tool registry from Phase B
- transformContext injects top-k vector search results per turn
- System prompt: specialized agentidev expert (knows all tools, dashboard, capabilities)
- Streaming responses with tool execution visualization

### Phase D: Agentiface Loop Upgrade (1-2 days)
- Replace one-shot pipeline with agent loop:
  - `sc.proposeSpec` — generate SmartClient JSON
  - `sc.validateSpec` — run whitelist check before rendering
  - `sc.renderPreview` — render in sandbox, capture screenshot
  - `sc.revise` — agent sees errors/screenshot and fixes
- Agent can now self-correct render failures (2-3 iteration loop)

### Phase E: WebLLM In-Browser Inference (2-3 days)
- Integrate WebLLM as a pi-ai provider (OpenAI-compatible shim)
- Model download UI with progress (Cache API persistence)
- Phi-3 Mini 3.8B q4 as default in-browser model
- Offscreen document for WebGPU inference (service worker can't use WebGPU)
- Graceful degradation: if no WebGPU, prompt for Ollama or cloud

### Phase F: Background Agent Tasks (2-3 days)
- Agent can run scheduled tasks via cron (bridge triggers agent loop)
- Background tasks: competitor monitoring, changelog scraping, price tracking
- Results stored as artifacts, surfaced in dashboard
- Agent state persisted to IndexedDB between runs

## Killer Use Cases (Ordered by ROI)

### Easy Wins (Local LLM sufficient)
1. **PR Review Prep** — search browsing history for related docs, build context brief
2. **Newsletter Curator** — weekly cron crawls feeds, ranks by semantic similarity to interests
3. **Dependency Vulnerability Triage** — cross-reference CVEs with project deps
4. **Job Board Aggregator** — scrape listings, score against local resume/preferences

### Medium Complexity
5. **Local API Doc Indexer** — crawl internal wikis, embed, answer questions locally
6. **Competitor Changelog Monitor** — scheduled scraping + diff summarization
7. **Research Paper Cross-Reference** — auto-search vector DB for related papers while reading
8. **UI Screenshot Diff** — daily staging screenshots, visual regression detection

### High Value (May need cloud LLM)
9. **Meeting Prep Researcher** — scrape attendee profiles, compile one-pager
10. **Regression Test Generator** — read bug report, record repro steps as Playwright script
11. **Incident Response Runbook** — auto-open dashboards, capture metrics, compile brief
12. **Form-Fill Automation** — record once, replay with different data across gov/enterprise portals

### The Unique Advantage
What makes these valuable is the combination no other tool has:
- **Real authenticated browser sessions** (not headless, handles MFA)
- **Local semantic memory** over actual browsing history (private)
- **Zero-install code execution** (Java/Linux in WASM)
- **Always available** (browser extension, no server required for basic ops)
- **Progressive capability** (browser LLM -> local server -> cloud)

## Architectural Decisions

### Who owns the loop?
**pi-agent-core is the brain, bridge is the executor.** Tools dispatch over WebSocket to the bridge; the bridge does the thing and returns a tool result. Don't dual-drive.

### Where does agent state live?
**Sidepanel document, not service worker.** The sidepanel has a real document lifecycle (no MV3 sleep). Service worker handles bridge messaging and passive capture only. Agent state persisted to IndexedDB after every turn for crash recovery.

### What about CheerpX?
**Agent is native JS in the extension; CheerpX is a tool the agent calls.** Don't run the agent loop inside emulated x86. The separation is what makes the architecture clean.

### How does the LLM provider chain work?
```
User message
    |
    v
pi-agent-core (agent loop)
    |
    v
pi-ai provider resolution:
    1. Check for Ollama at localhost:11434 -> use if available (best quality)
    2. Check for WebLLM model in cache -> use if available (no server needed)
    3. Check for API key in settings -> use cloud provider
    4. Prompt user: "Install Ollama for best experience, or enter API key"
```

### System prompt strategy
The agent's system prompt is the most important piece. It should be:
- Generated from the codebase (ai-context sync pipeline)
- Include all available tools with examples
- Include the user's recent browsing context (top-k from vector DB)
- Be specialized: "You are an agentidev expert. You know SmartClient, Playwright, the bridge protocol..."
- Updated when plugins are installed (new tools = new prompt section)
