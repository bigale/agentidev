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
import { dispatch } from './transport.js';

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
- script_list / script_save / script_launch: manage and run automation scripts

**SmartClient UI Generation**:
- sc_generate: generate a SmartClient config from a description
- sc_validate: validate a config JSON for correctness

**Testing**:
- test_plugin: quick check — open plugin in tab, verify components rendered
- generate_plugin_test: create a full CDP test script from component IDs and click steps
- script_save + script_launch: save and run any script

IMPORTANT - Tool Usage Rules:
- Each tool is a FUNCTION you call directly — NOT a shell command
- browse_navigate, browse_click, browse_fill are separate tools, not shell commands
- exec_shell and exec_python run commands in the CheerpX VM, not the browser
- Never try to run tool names as shell commands

When testing plugins (quick check):
1. Call test_plugin with the plugin ID — returns rendered component list
2. Check configLoaded is true and expected components exist

When testing plugins (full CDP test — RECOMMENDED):
1. Call test_plugin to discover the component IDs
2. Call generate_plugin_test with:
   - componentIds: the IDs to verify exist (from test_plugin results)
   - clicks: buttons to click and grids to check for data
   - formValues: form fields to fill before clicking
3. Call script_launch to run the generated test
4. Results (pass/fail, screenshots) appear on the dashboard

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
// Allow provider changes to reset the agent
globalThis._resetAgent = () => { _agent = null; _ready = false; };

export async function initAgent() {
  if (_agent) return { agent: _agent, status: { ready: true } };

  // Import pi-agent-core dynamically (ESM, may be in node_modules)
  let Agent;
  try {
    const mod = await import('../../lib/vendor/pi-bundle.js');
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
  // getApiKey is a constructor option (not initialState) — it's called by
  // the agent loop before each LLM request to resolve the API key.
  // Ollama doesn't validate keys but pi-ai requires one.
  _agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools,
      thinkingLevel: 'off',
      toolExecution: 'sequential',
    },
    getApiKey: async (provider) => model.apiKey || 'ollama',
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
          const results = await dispatch('BRIDGE_SEARCH_VECTORDB', {
            query: userText,
            sources: ['browsing', 'reference'],
            topK: 3,
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
