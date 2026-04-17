/**
 * Agent setup — creates and configures the pi-agent-core Agent instance.
 *
 * Wires:
 *   - Model from agent-provider.js
 *   - Tools from agent-tools.js
 *   - transformContext for RAG injection
 *   - beforeToolCall for approval logging
 *   - System prompt specialized for agentidev
 *
 * Runs in the sidepanel document.
 */

import { initProvider, getModel, isUsingWebLLM } from './agent-provider.js';
import { createTools } from './agent-tools.js';
import { streamWebLLMCompletion } from './webllm-provider.js';

let _agent = null;
let _ready = false;

const SYSTEM_PROMPT = `You are an agentidev assistant — a specialized AI that helps users with browser automation, data analysis, and UI generation.

You have access to powerful tools:

**Browser Automation** (requires an active session):
- browse_navigate: go to any URL
- browse_snapshot: get an accessibility tree with element refs
- browse_click: click elements by ref (e.g. e42)
- browse_fill: type into input fields
- session_list: see what sessions exist

**Semantic Memory**:
- memory_search: search the user's browsing history and indexed content by meaning

**Code Execution** (CheerpX Linux VM):
- exec_python: run Python 3 code (json, csv, re, sqlite3, math available)
- exec_shell: run shell commands (ls, grep, sed, awk, find, etc.)
- fs_read / fs_write: read/write files in the VM

**Network**:
- network_fetch: fetch any URL with no CORS restrictions

**UI & Plugins**:
- ui_generate: create SmartClient dashboard UIs from descriptions
- plugin_list: see installed plugins
- script_list: see automation scripts

Guidelines:
- Explain what you're about to do before calling a tool
- When browsing, take a snapshot first to understand the page structure
- For data processing, prefer Python over shell for complex logic
- Keep responses concise and focused
- If a tool fails, explain the error and suggest alternatives`;

/**
 * Initialize the agent. Must be called once before use.
 * @returns {Promise<{agent: object, status: object}>}
 */
export async function initAgent() {
  if (_agent) return { agent: _agent, status: { ready: true } };

  // Import pi-agent-core dynamically (ESM, may be in node_modules)
  let Agent;
  try {
    const mod = await import('../../lib/vendor/pi-agent-core/index.js');
    Agent = mod.Agent;
  } catch (e) {
    console.error('[AgentSetup] Failed to import pi-agent-core:', e.message);
    return { agent: null, status: { ready: false, error: 'pi-agent-core not available: ' + e.message } };
  }

  // Initialize provider
  const { model, status: providerStatus } = await initProvider();
  if (!model) {
    return { agent: null, status: { ready: false, error: 'No LLM provider available', provider: providerStatus } };
  }

  // Create tools
  const tools = await createTools();

  // Create agent
  _agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools,
      thinkingLevel: 'off',
      toolExecution: 'sequential', // Tools run one at a time for clarity
    },
  });

  // Wire transformContext for RAG injection
  _agent.state.transformContext = async (messages) => {
    // Find the last user message for context injection
    const lastUserIdx = messages.length - 1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const userText = messages[i].content;
        if (typeof userText !== 'string' || userText.length < 5) break;

        try {
          const results = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
              type: 'BRIDGE_SEARCH_VECTORDB',
              query: userText,
              sources: ['browsing', 'reference'],
              topK: 3,
            }, (resp) => {
              if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
              else resolve(resp);
            });
          });

          if (results?.results?.length > 0) {
            const contextText = 'Relevant context from the user\'s browsing history:\n' +
              results.results.map(r =>
                `- ${r.title || 'Untitled'} (${r.url || ''}): ${(r.content || '').substring(0, 150)}`
              ).join('\n');

            // Insert context as a system message before the user message
            const contextMsg = { role: 'system', content: contextText };
            return [...messages.slice(0, i), contextMsg, ...messages.slice(i)];
          }
        } catch (e) {
          // RAG injection is best-effort; don't break the conversation
          console.warn('[AgentSetup] RAG injection failed:', e.message);
        }
        break;
      }
    }
    return messages;
  };

  // Wire beforeToolCall for logging
  _agent.state.beforeToolCall = async (context) => {
    console.log('[Agent] Tool call:', context.toolCall?.name, context.toolCall?.arguments);
    // Return nothing = allow the call. Return { block: true, reason } to prevent.
    return undefined;
  };

  _ready = true;
  console.log('[AgentSetup] Agent initialized with', tools.length, 'tools, provider:', providerStatus.provider);
  return { agent: _agent, status: { ready: true, provider: providerStatus, toolCount: tools.length } };
}

/**
 * Get the initialized agent (null if not yet initialized).
 */
export function getAgent() {
  return _agent;
}

/**
 * Check if the agent is ready.
 */
export function isReady() {
  return _ready;
}
