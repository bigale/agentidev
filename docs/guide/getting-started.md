# Getting Started

## What is Agentidev?

Agentidev is a Chrome/Edge extension for browser automation, semantic memory, and AI-powered UI generation. Everything runs locally — your data never leaves your machine.

**Core capabilities:**
- **Browser automation** via Playwright sessions (navigate, click, fill, screenshot, trace, video)
- **Semantic memory** over your browsing history (384-dim vector search, all-MiniLM-L6-v2)
- **AI agent** with 16 tools (chat in sidepanel, Ollama or WebLLM for offline inference)
- **SmartClient dashboard** for sessions, scripts, schedules, test results
- **Plugin system** for custom tools and UIs (csv-analyzer, sqlite-query, hello-runtime)
- **CheerpX VM** for running Python/Linux commands in the browser (x86 WASM)
- **CheerpJ** for running Java in the browser (WASM)

## Installation

### Prerequisites
- Node.js 18+ 
- Chrome 113+ or Edge (for WebGPU support)
- Git

### Clone and Setup

```bash
git clone https://github.com/bigale/agentidev.git
cd agentidev
node scripts/setup.mjs
```

The setup script:
1. Creates the forge toolkit junction/symlink (`extension/lib/agentiface`)
2. Checks SmartClient SDK (bundled in repo, 27MB LGPL)
3. Installs npm dependencies
4. Installs Playwright Chromium browser
5. Verifies playwright-cli works

### Load the Extension

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer Mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `extension/` directory
5. The Agentidev icon appears in the toolbar

### Start the Bridge Server

The bridge server manages Playwright sessions, scripts, and schedules:

```bash
npm run bridge
```

Keep this terminal open. The bridge listens on `ws://localhost:9876`.

### Launch the Browser (Optional)

For browser automation with the extension pre-loaded:

```bash
npm run browser
```

This opens Playwright's bundled Chromium with the extension, sidepanel, and dashboard.

## First Steps

### Open the Sidepanel

Click the Agentidev icon in the toolbar, then click the sidepanel icon. You'll see tabs:
- **Search** — semantic search over browsing history
- **Q&A** — ask questions about your history
- **Agent** — AI chat with 16 tools
- **Auto** — automation scripts and plugins
- **AF** — Agentiface UI builder

### Chat with the Agent

1. Click the **Agent** tab (🤖)
2. The agent auto-detects your LLM provider:
   - **Ollama** (if running at localhost:11434) — best quality
   - **WebLLM** (if WebGPU available) — fully offline
   - **API key** — configure via Settings button
3. Type a message and press Enter

Try: "What plugins are installed?" — the agent will call the `plugin_list` tool.

### Open the Dashboard

The SmartClient dashboard is your control center:
1. Open a new tab
2. Navigate to the extension's dashboard URL (shown in the Auto tab)
3. Or: `chrome-extension://<ID>/smartclient-app/wrapper.html?mode=dashboard`

The dashboard shows: Sessions, Scripts, Script History, Schedules, Test Results, Activity.

### Create a Session

1. In the dashboard, click **New** in the Sessions portlet
2. Enter a name (e.g., "s1")
3. A headed Chromium browser opens
4. Select the session, then use **Session** dropdown to run scripts in it

## LLM Provider Setup

### Ollama (Recommended)

```bash
# Install
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model
ollama pull llama3.2:3b

# Allow Chrome extension access
sudo mkdir -p /etc/systemd/system/ollama.service.d
echo -e '[Service]\nEnvironment="OLLAMA_ORIGINS=*"' | sudo tee /etc/systemd/system/ollama.service.d/override.conf
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

The `OLLAMA_ORIGINS=*` setting is required because Chrome extensions have `chrome-extension://` origins that Ollama blocks by default.

### WebLLM (No Server)

WebLLM runs LLMs entirely in the browser via WebGPU. No setup needed — just select it in the Agent tab's Settings. First use downloads the model (~2GB for Phi-3 Mini).

Requires: Chrome 113+ with WebGPU support and a discrete GPU.

### Cloud API

Click Settings in the Agent tab and enter an OpenAI or Anthropic API key.

## Project Structure

```
agentidev/
├── extension/              # Chrome MV3 extension
│   ├── manifest.json       # Extension manifest
│   ├── background.js       # Service worker (187+ handlers)
│   ├── sidepanel/          # Sidepanel UI (Search, Q&A, Agent, Auto, AF)
│   │   └── agent/          # pi-mono agent (provider, tools, setup, UI)
│   ├── smartclient-app/    # SmartClient dashboard + sandbox
│   ├── smartclient/        # Bundled SmartClient LGPL runtime
│   ├── apps/               # Plugins (hello-runtime, csv-analyzer, sqlite-query)
│   ├── lib/                # Core libraries (bridge-client, handlers, host, vendor)
│   └── cheerpx-app/        # CheerpX runtime page
├── packages/
│   ├── bridge/             # Bridge server (WebSocket, Playwright, scripts)
│   ├── forge/              # SmartClient UI components
│   └── ai-context/         # AI rule sync
├── docs/                   # Documentation
├── plans/                  # Architecture plans
├── scripts/                # Setup, bundle, start scripts
└── examples/               # Test scripts
```
