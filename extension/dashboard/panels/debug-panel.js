/**
 * Debug Panel — right column showing checkpoint context + script stats.
 *
 * States:
 *  - null / no selection  → empty prompt
 *  - script.state === 'checkpoint'  → yellow checkpoint panel with Step/Continue/Kill buttons
 *  - script running/paused/complete → stats panel (step, errors, elapsed, activity)
 */

export class DebugPanel {
  constructor(bodyEl, emptyEl, titleEl, activityListEl, { onStep, onContinue, onCancel, onKill }) {
    this.bodyEl        = bodyEl;
    this.emptyEl       = emptyEl;
    this.titleEl       = titleEl;
    this.activityListEl = activityListEl;
    this.onStep     = onStep;
    this.onContinue = onContinue;
    this.onCancel   = onCancel;
    this.onKill     = onKill;

    this._currentId = null;
  }

  update(script) {
    if (!script) {
      this._showEmpty();
      return;
    }

    this._currentId = script.scriptId;
    this.emptyEl.style.display = 'none';

    if (script.state === 'checkpoint') {
      this._renderCheckpoint(script);
    } else {
      this._renderStats(script);
    }
  }

  // ---- Private ----

  _showEmpty() {
    this._currentId = null;
    this.titleEl.textContent = 'Debug State';
    // Remove anything dynamically inserted
    for (const el of this.bodyEl.querySelectorAll('.dash-checkpoint-panel, .dash-script-stats')) {
      el.remove();
    }
    this.emptyEl.style.display = '';
  }

  _renderCheckpoint(script) {
    const cp = script.checkpoint || {};
    const name = cp.name || 'checkpoint';
    const ctx  = cp.context || {};

    this.titleEl.textContent = `⏸ Paused`;

    // Build context rows
    const ctxRows = Object.entries(ctx).map(([k, v]) => {
      const valStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `<div class="dash-ctx-row">
        <span class="dash-ctx-key">${esc(k)}</span>
        <span class="dash-ctx-val">${esc(valStr)}</span>
      </div>`;
    }).join('');

    const html = `
      <div class="dash-checkpoint-panel">
        <div class="dash-checkpoint-name">⏸ ${esc(name)}</div>
        ${ctxRows ? `<div class="dash-checkpoint-ctx">${ctxRows}</div>` : ''}
        <div class="dash-checkpoint-btns">
          <button class="dash-dbg-btn step"     data-dbg-action="step">Step →</button>
          <button class="dash-dbg-btn continue" data-dbg-action="continue">Continue ▶</button>
          <button class="dash-dbg-btn cancel"   data-dbg-action="kill">Kill ⚡</button>
        </div>
      </div>
      ${this._statsHTML(script)}
    `;

    this._setBody(html);
    this._wireButtons(script.scriptId);
  }

  _renderStats(script) {
    this.titleEl.textContent = script.name || 'Script';
    this._setBody(this._statsHTML(script));
    this._wireButtons(script.scriptId);
  }

  _statsHTML(script) {
    const pct     = script.total > 0 ? Math.round((script.step / script.total) * 100) : 0;
    const elapsed = script.startedAt ? _elapsed(script.startedAt) : '—';
    const isActive = ['running', 'paused', 'checkpoint'].includes(script.state);
    const fillClass = script.state === 'complete' ? 'complete' : script.errors > 0 ? 'error' : '';

    const killBtn = isActive && script.state !== 'checkpoint'
      ? `<div class="dash-dbg-kill-row" style="padding:8px 12px; display:flex; gap:4px; flex-shrink:0;">
           <button class="dash-dbg-btn step" style="font-size:9px; padding:3px 0;" data-dbg-action="cancel">Cancel ✕</button>
           <button class="dash-dbg-btn cancel" style="font-size:9px; padding:3px 0;" data-dbg-action="kill">Kill ⚡</button>
         </div>`
      : '';

    return `
      <div class="dash-script-stats">
        <div class="dash-stat-row">
          <span class="dash-stat-label">State</span>
          <span class="dash-stat-val">${esc(script.state || '—')}</span>
        </div>
        <div class="dash-stat-row">
          <span class="dash-stat-label">Progress</span>
          <span class="dash-stat-val">${script.step || 0} / ${script.total || '?'} (${pct}%)</span>
        </div>
        <div style="height:3px; background:#2a2a4a; border-radius:2px; margin:4px 0 8px;">
          <div class="${fillClass}" style="height:100%; width:${pct}%; background:${fillClass === 'complete' ? '#1e8e3e' : fillClass === 'error' ? '#d93025' : '#1a73e8'}; border-radius:2px; transition:width .4s;"></div>
        </div>
        ${script.errors > 0 ? `<div class="dash-stat-row"><span class="dash-stat-label">Errors</span><span class="dash-stat-val" style="color:#f44336;">${script.errors}</span></div>` : ''}
        <div class="dash-stat-row">
          <span class="dash-stat-label">Elapsed</span>
          <span class="dash-stat-val">${elapsed}</span>
        </div>
        ${script.label ? `<div class="dash-stat-row"><span class="dash-stat-label">Label</span><span class="dash-stat-val" style="color:#8f8faf;">${esc(script.label)}</span></div>` : ''}
        ${script.activity ? `<div style="margin-top:8px; font-size:10px; color:#5b8dee; font-style:italic; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(script.activity)}">${esc(script.activity)}</div>` : ''}
      </div>
      ${killBtn}
    `;
  }

  _setBody(html) {
    // Replace any dynamic content but leave the persistent #debug-empty in place
    for (const el of this.bodyEl.querySelectorAll('.dash-checkpoint-panel, .dash-script-stats, .dash-dbg-kill-row')) {
      el.remove();
    }
    this.emptyEl.insertAdjacentHTML('afterend', html);
  }

  _wireButtons(scriptId) {
    this.bodyEl.querySelectorAll('[data-dbg-action]').forEach(btn => {
      btn.onclick = () => {
        switch (btn.dataset.dbgAction) {
          case 'step':     this.onStep(scriptId);     break;
          case 'continue': this.onContinue(scriptId); break;
          case 'cancel':   this.onCancel(scriptId);   break;
          case 'kill':     this.onKill(scriptId);     break;
        }
      };
    });
  }
}

// ---- Helpers ----

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _elapsed(startedAt) {
  const ms = Date.now() - startedAt;
  if (ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
