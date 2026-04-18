# Agent Guide

The agentidev agent is an AI assistant with 16 tools that runs in the sidepanel. It uses pi-mono (pi-ai + pi-agent-core) for the agent loop and can target Ollama, WebLLM, or cloud APIs.

## Using the Agent

1. Open the sidepanel → click **Agent** tab (🤖)
2. The agent auto-detects your LLM provider
3. Type a message and press Enter
4. The agent streams its response and can call tools autonomously

## Provider Chain

The agent tries providers in order:

| Priority | Provider | When Used |
|----------|----------|-----------|
| 1 | **Ollama** | If running at localhost:11434 |
| 2 | **WebLLM** | If WebGPU available (in-browser, no server) |
| 3 | **Cloud API** | If API key configured (OpenAI or Anthropic) |
| 4 | **Prompt** | Asks user to install Ollama or enter key |

Click **Settings** to change provider or enter API keys.

### Ollama Setup

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.2:3b

# Required: allow Chrome extension origins
sudo mkdir -p /etc/systemd/system/ollama.service.d
echo -e '[Service]\nEnvironment="OLLAMA_ORIGINS=*"' | sudo tee /etc/systemd/system/ollama.service.d/override.conf
sudo systemctl daemon-reload && sudo systemctl restart ollama
```

### WebLLM (Offline)

No setup needed. Requires WebGPU (Chrome 113+, discrete GPU recommended). First use downloads model weights (~2GB for Phi-3 Mini). Models cached in browser Cache API.

Available models: Phi-3 Mini 3.8B, Llama 3.2 3B/1B, SmolLM2 1.7B, Qwen2.5 1.5B.

## Tools (16 Available)

### Browser Automation
| Tool | Description |
|------|-------------|
| `browse_navigate` | Navigate session to URL |
| `browse_snapshot` | Accessibility tree with element refs |
| `browse_click` | Click element by ref or selector |
| `browse_fill` | Type into input field |
| `session_list` | List active sessions |

### Semantic Memory
| Tool | Description |
|------|-------------|
| `memory_search` | Search browsing history by meaning |

### Code Execution (CheerpX VM)
| Tool | Description |
|------|-------------|
| `exec_python` | Run Python 3 code (PYTHONHASHSEED=0 auto-injected) |
| `exec_shell` | Run shell commands (ls, grep, sed, awk, find) |
| `fs_read` | Read file from VM |
| `fs_write` | Write file to VM |

### Network
| Tool | Description |
|------|-------------|
| `network_fetch` | Fetch any URL (CORS-free via extension) |

### UI Generation
| Tool | Description |
|------|-------------|
| `sc_generate` | Generate SmartClient UI from description |
| `sc_validate` | Validate SmartClient config JSON |

### Management
| Tool | Description |
|------|-------------|
| `plugin_list` | List installed plugins |
| `script_list` | List automation scripts |

## Example Conversations

### "What plugins are installed?"
Agent calls `plugin_list` → returns: Hello Runtime, SQLite Query, CSV Analyzer

### "Fetch example.com and show me the title"
Agent calls `network_fetch` with URL → parses HTML → extracts title

### "Run Python to calculate fibonacci(20)"
Agent calls `exec_python` with code → CheerpX VM executes → returns result

### "Generate a dashboard for tracking tasks"
Agent calls `sc_generate` → bridge spawns Claude → SmartClient config → rendered in playground

### "Search my history for React documentation"
Agent calls `memory_search` → vector DB search → returns relevant pages with similarity scores

## Context & Memory

The agent automatically injects relevant context from your browsing history on each message via `transformContext`. This RAG (Retrieval-Augmented Generation) injection searches the vector DB for content similar to your question and includes the top 3 results.

Conversation history persists for the session. Reloading the extension resets the conversation.

## Architecture

```
Sidepanel (agent-ui.js)
    ↓ user message
Agent Loop (pi-agent-core)
    ↓ system prompt + tools + context
pi-ai Provider (Ollama/WebLLM/cloud)
    ↓ LLM streaming response
    ↓ tool calls (if any)
Tool Execution (agent-tools.js)
    ↓ chrome.runtime.sendMessage
Service Worker Handlers (187+)
    ↓ bridge/CheerpX/IndexedDB/etc.
Results back to agent loop
    ↓ iterate or respond
Streaming display in chat UI
```

## Technical Notes

- Agent runs in sidepanel document (not SW) — has real DOM lifecycle, no MV3 sleep
- `pi-bundle.js` (981KB) bundles pi-ai + pi-agent-core + TypeBox + OpenAI SDK
- Unused providers stubbed at build time (Anthropic, Google, AWS, Mistral)
- Rebuild bundle: `node scripts/bundle-pi.mjs`
- `getApiKey` is a constructor option on Agent, not an initialState field
- Streaming uses `message_update` events with progressive `partial.content`
