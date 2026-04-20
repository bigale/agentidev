/**
 * Agent UI — mounts a simple chat interface in the sidepanel.
 *
 * We build a lightweight chat UI rather than using pi-web-ui's ChatPanel
 * because the full ChatPanel has heavy dependencies (lit, pdfjs-dist, xlsx,
 * docx-preview) that would bloat the extension and require CSP adjustments.
 *
 * This minimal UI provides:
 *   - Message list with user/assistant distinction
 *   - Streaming text display
 *   - Tool call visualization
 *   - Input field with send button
 *   - Provider status indicator
 *
 * The agent instance from agent-setup.js drives everything.
 */

import { initAgent, getAgent } from './agent-setup.js';
import { getProviderStatus, setProviderConfig } from './agent-provider.js';

let _container = null;
let _messageList = null;
let _input = null;
let _statusBar = null;
let _busy = false;

/**
 * Initialize the agent UI in the given container element.
 * @param {HTMLElement} container
 */
export async function mountAgentUI(container) {
  _container = container;
  _container.innerHTML = buildHTML();

  _messageList = _container.querySelector('#agent-messages');
  _input = _container.querySelector('#agent-input');
  _statusBar = _container.querySelector('#agent-status');

  // Wire send button
  _container.querySelector('#agent-send').addEventListener('click', handleSend);
  _input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });

  // Wire stop button
  const stopBtn = _container.querySelector('#agent-stop');
  stopBtn.addEventListener('click', () => {
    const agent = getAgent();
    if (agent) {
      agent.abort();
      addMessage('system', 'Generation stopped.');
      _busy = false;
      setBusy(false);
    }
  });

  // Wire clear button
  _container.querySelector('#agent-clear-btn').addEventListener('click', () => {
    const agent = getAgent();
    if (agent) {
      // Reset agent state by clearing messages
      agent.state.messages = [];
    }
    _messageList.innerHTML = '';
    addMessage('system', 'Conversation cleared. Type a message to begin.');
    _busy = false;
  });

  // Initialize agent
  updateStatus('Initializing agent...');
  const { agent, status } = await initAgent();
  if (status.ready) {
    updateStatus(`${status.provider.provider}: ${status.provider.model}`);
    addMessage('system', 'Agent ready. ' + status.toolCount + ' tools available. Type a message to begin.');
  } else {
    updateStatus('Not connected');
    addMessage('system', 'No LLM provider available. ' + (status.error || ''));
    addMessage('system', 'Install Ollama (ollama.com) or select a different agent from the dropdown above.');
  }

  // React to global agent selector changes
  document.addEventListener('agent-changed', async (e) => {
    const agent = e.detail?.agent;
    if (!agent) return;
    // Map global agent values to provider configs
    if (agent === 'ollama') {
      updateStatus('Switching to Ollama...');
      const { status: s } = await setProviderConfig({ provider: 'ollama' });
      updateStatus(s.ready ? `ollama: ${s.model}` : 'Ollama not available');
    } else if (agent === 'webllm') {
      updateStatus('Switching to WebLLM...');
      const { status: s } = await setProviderConfig({ provider: 'webllm' });
      updateStatus(s.ready ? `webllm: ${s.model}` : 'WebLLM not available');
    }
    // Bridge models (sonnet/haiku/opus) use the bridge server for AF generation
    // but aren't available for the pi-mono agent loop. Fall back to Ollama.
    if (agent === 'sonnet' || agent === 'haiku' || agent === 'opus') {
      updateStatus('Switching to Ollama (bridge agent for AF)...');
      const { status: s } = await setProviderConfig({ provider: 'ollama' });
      updateStatus(s.ready ? `ollama: ${s.model}` : 'Ollama not available');
      if (s.ready) {
        addMessage('system', `Agent chat uses Ollama. ${agent.charAt(0).toUpperCase() + agent.slice(1)} is used for AF generation via bridge.`);
      }
    }
  });
}

function buildHTML() {
  return `
    <div style="display:flex;flex-direction:column;height:100%;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
      <div style="display:flex;align-items:center;padding:6px 10px;background:#1a1a2e;border-bottom:1px solid #333;">
        <span style="font-size:13px;font-weight:600;color:#a8b4ff;flex:1;">Agent</span>
        <span id="agent-status" style="font-size:11px;color:#888;margin-right:8px;"></span>
        <button id="agent-clear-btn" style="background:none;border:1px solid #555;color:#aaa;padding:2px 8px;border-radius:3px;cursor:pointer;font-size:11px;" title="Clear conversation">Clear</button>
      </div>
      <div id="agent-messages" style="flex:1;overflow-y:auto;padding:8px;background:#0d1117;"></div>
      <div style="display:flex;padding:8px;background:#1a1a2e;border-top:1px solid #333;">
        <textarea id="agent-input" rows="2" placeholder="Ask the agent anything..."
          style="flex:1;background:#0d1117;color:#e6edf3;border:1px solid #333;border-radius:4px;padding:6px 8px;font-size:13px;resize:none;font-family:inherit;"></textarea>
        <button id="agent-send" style="margin-left:6px;background:#1976d2;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:13px;align-self:flex-end;">Send</button>
        <button id="agent-stop" style="display:none;margin-left:4px;background:#c33;color:#fff;border:none;border-radius:4px;padding:6px 10px;cursor:pointer;font-size:16px;align-self:flex-end;line-height:1;" title="Stop generation">&#9632;</button>
      </div>
    </div>`;
}

function updateStatus(text) {
  if (_statusBar) _statusBar.textContent = text;
}

function setBusy(busy) {
  const sendBtn = _container?.querySelector('#agent-send');
  const stopBtn = _container?.querySelector('#agent-stop');
  if (sendBtn) sendBtn.style.display = busy ? 'none' : '';
  if (stopBtn) stopBtn.style.display = busy ? '' : 'none';
  if (_input) _input.disabled = busy;
}

function addMessage(role, content) {
  if (!_messageList) return null;
  const div = document.createElement('div');
  div.style.cssText = 'margin-bottom:8px;padding:8px;border-radius:6px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word;';
  if (role === 'user') {
    div.style.cssText += 'background:#1e3a5f;color:#e6edf3;margin-left:40px;';
  } else if (role === 'assistant') {
    div.style.cssText += 'background:#1a1a2e;color:#c9d1d9;border:1px solid #333;margin-right:40px;';
  } else if (role === 'tool') {
    div.style.cssText += 'background:#0d2818;color:#7ee787;border:1px solid #1a4d2e;font-family:monospace;font-size:11px;margin-right:40px;';
  } else {
    div.style.cssText += 'color:#888;font-size:11px;text-align:center;';
  }
  div.textContent = content;
  _messageList.appendChild(div);
  _messageList.scrollTop = _messageList.scrollHeight;
  return div;
}

async function handleSend() {
  const agent = getAgent();
  if (!agent) {
    addMessage('system', 'Agent not initialized. Select a provider from the dropdown above.');
    return;
  }
  if (_busy) return;

  const text = _input.value.trim();
  if (!text) return;
  _input.value = '';

  addMessage('user', text);
  _busy = true;
  setBusy(true);
  updateStatus('Thinking...');

  // Create a streaming assistant message element
  const assistantDiv = addMessage('assistant', '');
  let fullText = '';

  try {
    // Subscribe to agent events for streaming
    const unsubscribe = agent.subscribe(async (event) => {
      // Streaming text — agent.subscribe fires 'message_update' with progressive
      // partial text on event.partial.content or event.message.content
      if (event.type === 'message_update') {
        const partial = event.partial || event.message;
        if (partial && partial.role === 'assistant' && partial.content) {
          let newText = '';
          for (const block of partial.content) {
            if (block.type === 'text') newText += block.text || '';
          }
          if (newText && newText !== fullText) {
            fullText = newText;
            assistantDiv.textContent = fullText;
            _messageList.scrollTop = _messageList.scrollHeight;
          }
        }
        updateStatus('Generating...');
      }
      if (event.type === 'tool_execution_start') {
        const toolName = event.toolCall?.name || event.toolCall?.function?.name || 'unknown';
        addMessage('tool', '🔧 Calling: ' + toolName);
        updateStatus('Running tool: ' + toolName);
      }
      if (event.type === 'tool_execution_end') {
        const result = event.result;
        if (result?.content?.[0]?.text) {
          const preview = result.content[0].text.substring(0, 300);
          addMessage('tool', '→ ' + preview + (result.content[0].text.length > 300 ? '...' : ''));
        }
        updateStatus('Thinking...');
      }
    });

    // Send the user message to the agent
    await agent.prompt(text);

    unsubscribe();

    // Set final text from agent state messages (in case streaming didn't populate)
    if (agent.state.messages.length > 0) {
      const lastMsg = agent.state.messages[agent.state.messages.length - 1];
      if (lastMsg.role === 'assistant' && lastMsg.content) {
        let finalText = '';
        for (const block of lastMsg.content) {
          if (block.type === 'text') finalText += block.text || '';
        }
        if (finalText && finalText !== fullText) {
          fullText = finalText;
          assistantDiv.textContent = fullText;
        }
      }
      if (!fullText) {
        assistantDiv.textContent = lastMsg.errorMessage || '(no response)';
        if (lastMsg.errorMessage) assistantDiv.style.color = '#f44336';
      }
    }
  } catch (err) {
    assistantDiv.textContent = 'Error: ' + err.message;
    assistantDiv.style.color = '#f44336';
    console.error('[AgentUI] Error:', err);
  }

  _busy = false;
  setBusy(false);
  const status = getProviderStatus();
  updateStatus(status ? `${status.provider}: ${status.model}` : 'Ready');
}

/**
 * Cleanup when the agent tab is deactivated.
 */
export function unmountAgentUI() {
  // Agent state persists in memory — just clear the UI reference
  _container = null;
  _messageList = null;
  _input = null;
  _statusBar = null;
}
