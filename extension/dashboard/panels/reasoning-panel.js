/**
 * Reasoning Panel — bottom-right.
 * AI reasoning trace timeline with command input, phase dots, expandable detail.
 */

const PHASES = ['snapshot', 'search', 'prompt', 'generate', 'execute', 'verify'];

export function initReasoningPanel(container, state) {
  const body = container.querySelector('#dash-reasoning-body');
  const inputBar = container.querySelector('#dash-reason-input-bar');
  const countBadge = container.querySelector('#dash-trace-count');

  // Build input bar
  inputBar.innerHTML = `
    <input id="dash-reason-input" class="dash-reason-input"
      placeholder="Natural language intent..." disabled>
    <button id="dash-reason-send" class="dash-btn-sm" disabled>Send</button>
  `;

  const input = inputBar.querySelector('#dash-reason-input');
  const sendBtn = inputBar.querySelector('#dash-reason-send');

  sendBtn.addEventListener('click', () => sendIntent(state, input, sendBtn));
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendIntent(state, input, sendBtn);
  });

  function updateInputState() {
    const connected = state.get('bridgeConnected');
    const hasSession = !!state.get('activeSessionId');
    input.disabled = !(connected && hasSession);
    sendBtn.disabled = !(connected && hasSession);
  }

  function render() {
    const traces = state.get('reasoningTraces') || [];
    const activeIdx = state.get('activeTraceIndex');

    countBadge.textContent = traces.length;

    if (traces.length === 0) {
      body.innerHTML = '<div class="dash-empty">Send a natural language intent to see AI reasoning traces</div>';
      return;
    }

    body.innerHTML = `<div class="dash-trace-list">${traces.slice().reverse().map((trace, rIdx) => {
      const idx = traces.length - 1 - rIdx;
      const isActive = idx === activeIdx;
      return renderTraceCard(trace, idx, isActive);
    }).join('')}</div>`;

    // Toggle detail on header click
    body.querySelectorAll('.dash-trace-header').forEach(header => {
      header.addEventListener('click', () => {
        const traceIdx = parseInt(header.dataset.traceIdx, 10);
        state.set('activeTraceIndex', state.get('activeTraceIndex') === traceIdx ? -1 : traceIdx);
      });
    });
  }

  state.addEventListener('change', (e) => {
    const k = e.detail.key;
    if (k === 'reasoningTraces' || k === 'activeTraceIndex') render();
    if (k === 'bridgeConnected' || k === 'activeSessionId') updateInputState();
  });

  updateInputState();
  render();
}

function sendIntent(state, input, sendBtn) {
  const intent = input.value.trim();
  const sessionId = state.get('activeSessionId');
  if (!intent || !sessionId) return;

  sendBtn.disabled = true;
  sendBtn.textContent = '...';
  input.value = '';

  // Add running trace
  const traceId = `trace_${Date.now()}`;
  const startTime = Date.now();
  state.push('reasoningTraces', {
    id: traceId,
    intent,
    sessionId,
    status: 'running',
    startTime,
    phases: { snapshot: 'active' },
    commands: [],
    executionResults: [],
    reasoning: '',
    verification: null,
    metadata: null,
  }, 50);
  state.set('activeTraceIndex', (state.get('reasoningTraces') || []).length - 1);

  chrome.runtime.sendMessage({
    type: 'AUTOMATION_REASON', intent, sessionId
  }, (response) => {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';

    const duration = Date.now() - startTime;
    const success = response?.commands?.length > 0;

    state.updateItem('reasoningTraces', t => t.id === traceId, (t) => ({
      ...t,
      status: success ? 'success' : 'error',
      duration,
      commands: response?.commands || [],
      executionResults: response?.executionResults || [],
      reasoning: response?.reasoning || response?.error || '',
      expectedOutcome: response?.expectedOutcome || '',
      verification: response?.verification || null,
      metadata: response?.metadata || null,
      phases: buildPhases(response),
    }));
  });
}

function buildPhases(response) {
  if (!response) return phasesAllError();

  const phases = {};
  // Snapshot was taken if we have commands
  phases.snapshot = response.commands ? 'complete' : 'error';
  // Search (vector retrieval) — check metadata
  phases.search = response.metadata?.sectionsRetrieved ? 'complete' :
                   response.metadata?.stablePatternsUsed ? 'complete' : 'complete';
  // Prompt building
  phases.prompt = response.commands ? 'complete' : 'error';
  // LLM generation
  phases.generate = response.commands?.length > 0 ? 'complete' : 'error';
  // Execution
  const results = response.executionResults || [];
  const anyFail = results.some(r => !r.success);
  phases.execute = results.length > 0 ? (anyFail ? 'error' : 'complete') : 'error';
  // Verification
  phases.verify = response.verification
    ? (response.verification.success ? 'complete' : 'error')
    : 'complete';

  return phases;
}

function phasesAllError() {
  return Object.fromEntries(PHASES.map(p => [p, 'error']));
}

function renderTraceCard(trace, idx, isExpanded) {
  const durationStr = trace.duration ? `${(trace.duration / 1000).toFixed(1)}s` : '';

  const phaseDots = PHASES.map(phase => {
    const pState = trace.phases?.[phase] || 'pending';
    const dotClass = pState === 'complete' ? 'complete'
      : pState === 'active' ? 'active'
      : pState === 'error' ? 'error' : '';
    return `<div class="dash-phase-step">
      <div class="dash-phase-dot ${dotClass}" title="${phase}: ${pState}"></div>
      <span class="dash-phase-label">${phase.substring(0, 4)}</span>
    </div>`;
  }).join('');

  let detail = '';
  if (isExpanded) {
    detail = renderTraceDetail(trace);
  }

  return `
    <div class="dash-trace-card ${isExpanded ? 'active' : ''}">
      <div class="dash-trace-header" data-trace-idx="${idx}">
        <span class="dash-trace-status-badge ${trace.status}">${trace.status}</span>
        <span class="dash-trace-intent">${escapeHtml(trace.intent)}</span>
        <span class="dash-trace-duration">${durationStr}</span>
      </div>
      <div class="dash-trace-phases">${phaseDots}</div>
      ${detail}
    </div>
  `;
}

function renderTraceDetail(trace) {
  const parts = [];

  // Commands list
  if (trace.commands?.length > 0) {
    const cmds = trace.commands.map((cmd, i) => {
      const result = trace.executionResults?.[i];
      const ok = result?.success !== false;
      return `<li class="${ok ? 'cmd-ok' : 'cmd-fail'}">${ok ? '✓' : '✗'} ${escapeHtml(cmd.type)} ${escapeHtml(cmd.ref || cmd.url || cmd.value || '')}</li>`;
    }).join('');
    parts.push(`<ul class="dash-trace-commands">${cmds}</ul>`);
  }

  // Token budget bar
  if (trace.metadata?.tokenBudget) {
    const budget = trace.metadata.tokenBudget;
    const pct = budget.percentUsed || (budget.used / budget.total * 100);
    const cls = pct > 90 ? 'danger' : pct > 70 ? 'warn' : '';
    parts.push(`
      <div style="font-size:10px;color:#5f5f7f;margin-top:4px;">Tokens: ${budget.used || 0} / ${budget.total || 0} (${Math.round(pct)}%)</div>
      <div class="dash-token-bar"><div class="dash-token-bar-fill ${cls}" style="width:${Math.min(pct, 100)}%"></div></div>
    `);
  }

  // Reasoning text
  if (trace.reasoning) {
    parts.push(`<div class="dash-trace-reasoning">${escapeHtml(trace.reasoning)}</div>`);
  }

  // Expected outcome
  if (trace.expectedOutcome) {
    parts.push(`<div style="font-size:10px;color:#8f8faf;margin-top:4px;">Expected: ${escapeHtml(trace.expectedOutcome)}</div>`);
  }

  // Verification
  if (trace.verification) {
    const v = trace.verification;
    const cls = v.success ? 'pass' : 'fail';
    parts.push(`<div class="dash-trace-verification ${cls}">${v.success ? '✓ Verified' : '✗ Verification failed'}: ${escapeHtml(v.details || '')}</div>`);
  }

  return `<div class="dash-trace-detail">${parts.join('')}</div>`;
}

function escapeHtml(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
