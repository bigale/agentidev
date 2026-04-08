/**
 * Script Panel — left column script cards with kill/pause/breakpoint dots.
 */

export class ScriptPanel {
  constructor(listEl, countEl, { onSelect, onAction, onBreakpoint }) {
    this.listEl = listEl;
    this.countEl = countEl;
    this.onSelect = onSelect;
    this.onAction = onAction;
    this.onBreakpoint = onBreakpoint;
  }

  render(scripts, selectedId) {
    this.countEl.textContent = scripts.size;

    if (scripts.size === 0) {
      this.listEl.innerHTML = '<div class="dash-empty">No scripts registered.<br>Launch a script to begin.</div>';
      return;
    }

    const entries = [...scripts.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    this.listEl.innerHTML = entries.map(s => this._renderCard(s, selectedId)).join('');

    // Wire events
    this.listEl.querySelectorAll('.dash-script-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-action]') || e.target.closest('.dash-sc-bp')) return;
        this.onSelect(card.dataset.scriptId);
      });
    });

    this.listEl.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onAction(btn.dataset.action, btn.dataset.sid);
      });
    });

    this.listEl.querySelectorAll('.dash-sc-bp').forEach(dot => {
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        const isActive = dot.classList.contains('active');
        this.onBreakpoint(dot.dataset.sid, dot.dataset.bp, !isActive);
      });
    });
  }

  _renderCard(s, selectedId) {
    const pct = s.total > 0 ? Math.round((s.step / s.total) * 100) : 0;
    const fillClass = s.state === 'complete' ? 'complete' : s.errors > 0 ? 'error' : '';
    const isActive = ['running', 'paused', 'checkpoint'].includes(s.state);
    const isAtCp   = s.state === 'checkpoint';
    const activeBreakpoints = s.activeBreakpoints || [];
    const checkpoints = s.checkpoints || [];
    const selected = s.scriptId === selectedId;

    const isDead = ['disconnected', 'complete', 'cancelled', 'killed', 'error'].includes(s.state);
    const displayState = s.state === 'disconnected' && s.errors > 0 ? 'error' : s.state;

    const stateLabel = isAtCp
      ? `⏸ ${esc(s.checkpoint?.name || 'checkpoint')}`
      : displayState;

    const bpDots = checkpoints.length > 0 ? `
      <div class="dash-sc-bps">
        ${checkpoints.map(bp => {
          const on  = activeBreakpoints.includes(bp);
          const hit = isAtCp && s.checkpoint?.name === bp;
          return `<span class="dash-sc-bp ${on ? 'active' : ''} ${hit ? 'hit' : ''}"
                        data-sid="${s.scriptId}" data-bp="${bp}" title="${bp}">
            <span class="dash-sc-bp-dot">${on || hit ? '●' : '○'}</span>
            ${shortName(bp)}
          </span>`;
        }).join('')}
      </div>
    ` : '';

    const actions = isActive ? `
      <div class="dash-sc-actions">
        <button class="dash-sc-btn danger" data-action="kill" data-sid="${s.scriptId}" title="Force kill (SIGKILL)">Kill</button>
        ${s.state === 'running' ? `<button class="dash-sc-btn warn" data-action="pause" data-sid="${s.scriptId}">Pause</button>` : ''}
        ${s.state === 'paused'  ? `<button class="dash-sc-btn normal" data-action="resume" data-sid="${s.scriptId}">Resume</button>` : ''}
        ${isAtCp ? '' : `<button class="dash-sc-btn danger" data-action="cancel" data-sid="${s.scriptId}">Cancel</button>`}
      </div>
    ` : isDead ? `
      <div class="dash-sc-actions">
        <button class="dash-sc-btn normal" data-action="dismiss" data-sid="${s.scriptId}" title="Remove from list" aria-label="Dismiss ${esc(s.name)}">Dismiss</button>
      </div>
    ` : '';

    const sessionLabel = s.sessionId && s.sessionName
      ? `<span class="dash-sc-session">${esc(s.sessionName)}</span>` : '';

    return `
      <div class="dash-script-card ${selected ? 'selected' : ''} ${isAtCp ? 'checkpoint-active' : ''}"
           data-script-id="${s.scriptId}">
        <div class="dash-sc-header">
          <span class="dash-sc-name">${esc(s.name)}${sessionLabel}</span>
          <span class="dash-sc-state ${displayState}">${stateLabel}</span>
        </div>
        <div class="dash-sc-progress">
          <div class="dash-sc-progress-fill ${fillClass}" style="width:${pct}%"></div>
        </div>
        <div class="dash-sc-step">
          <span>${s.step || 0}/${s.total || '?'}</span>
          ${s.errors > 0 ? `<span class="dash-sc-errors">${s.errors} err</span>` : ''}
          ${s.label ? `<span style="color:#5f5f7f">— ${esc(s.label)}</span>` : ''}
        </div>
        ${s.activity ? `<div class="dash-sc-activity">${esc(s.activity)}</div>` : ''}
        ${s.poll?.polling ? this._renderPollRow(s.poll) : ''}
        ${bpDots}
        ${actions}
      </div>
    `;
  }

  _renderPollRow(poll) {
    const interval = poll.intervalMs >= 60000
      ? `${Math.round(poll.intervalMs / 60000)}m`
      : `${Math.round(poll.intervalMs / 1000)}s`;
    const next = poll.nextPollAt
      ? `next ${Math.max(0, Math.round((poll.nextPollAt - Date.now()) / 1000))}s`
      : '';
    return `<div class="dash-sc-poll">↻ Iteration ${poll.iteration || 0}${poll.maxIterations < Infinity ? '/' + poll.maxIterations : ''} · ${interval} interval${next ? ' · ' + next : ''}</div>`;
  }
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function shortName(name) {
  // Abbreviate long checkpoint names for dot labels
  return name.length > 8 ? name.slice(0, 7) + '…' : name;
}
