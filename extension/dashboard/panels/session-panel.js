/**
 * Session Panel — top-left.
 * Vertical session list with state dots, active highlight, create/destroy.
 */

export function initSessionPanel(container, state) {
  const body = container.querySelector('#dash-session-body');
  const countBadge = container.querySelector('#dash-session-count');

  // Create actions bar at bottom of body
  const actionsBar = document.createElement('div');
  actionsBar.className = 'dash-session-actions';
  actionsBar.innerHTML = `
    <button id="dash-create-session" class="dash-btn-sm" disabled>+ New Session</button>
    <button id="dash-destroy-session" class="dash-btn-sm danger" disabled>Destroy</button>
  `;
  // Insert after body in the panel
  body.parentElement.appendChild(actionsBar);

  const createBtn = actionsBar.querySelector('#dash-create-session');
  const destroyBtn = actionsBar.querySelector('#dash-destroy-session');

  createBtn.addEventListener('click', () => handleCreate(state));
  destroyBtn.addEventListener('click', () => handleDestroy(state));

  function render() {
    const sessions = state.get('sessions') || [];
    const scripts = state.get('scripts') || [];
    const activeId = state.get('activeSessionId');
    const connected = state.get('bridgeConnected');

    countBadge.textContent = sessions.length + (scripts.length > 0 ? ` + ${scripts.length}s` : '');
    createBtn.disabled = !connected;
    destroyBtn.disabled = !connected || !activeId;

    let html = '';

    if (sessions.length === 0 && scripts.length === 0) {
      html = `<div class="dash-empty">${connected ? 'No sessions — create one' : 'Connect to bridge first'}</div>`;
    } else {
      // Sessions
      if (sessions.length > 0) {
        html += `<div class="dash-session-list">${sessions.map(s => {
          const isActive = s.id === activeId;
          const stateClass = (s.state || 'IDLE').toUpperCase();
          return `
            <div class="dash-session-item ${isActive ? 'active' : ''}" data-sid="${s.id}">
              <div class="dash-session-dot ${stateClass}"></div>
              <span class="dash-session-name">${escapeHtml(s.name || s.id)}</span>
              <span class="dash-session-state">${stateClass}</span>
            </div>
          `;
        }).join('')}</div>`;
      }

      // Scripts
      if (scripts.length > 0) {
        html += `<div style="padding:6px 12px 2px;font-size:10px;color:#5f5f7f;text-transform:uppercase;letter-spacing:0.5px;">Scripts</div>`;
        html += scripts.map(s => renderScriptCard(s)).join('');
      }
    }

    body.innerHTML = html;

    body.querySelectorAll('.dash-session-item').forEach(el => {
      el.addEventListener('click', () => {
        state.set('activeSessionId', el.dataset.sid);
      });
    });

    // Wire script action buttons
    body.querySelectorAll('[data-script-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleScriptAction(btn.dataset.scriptAction, btn.dataset.scriptId);
      });
    });
  }

  state.addEventListener('change', (e) => {
    const k = e.detail.key;
    if (k === 'sessions' || k === 'activeSessionId' || k === 'bridgeConnected' || k === 'scripts') {
      render();
    }
  });

  render();
}

function handleCreate(state) {
  const name = prompt('Session name:', `session_${(state.get('sessions') || []).length + 1}`);
  if (!name) return;

  chrome.runtime.sendMessage({
    type: 'BRIDGE_CREATE_SESSION', name, options: {}
  }, (response) => {
    if (response?.success && response.session) {
      state.set('activeSessionId', response.session.id);
      refreshSessions(state);
    }
  });
}

function handleDestroy(state) {
  const activeId = state.get('activeSessionId');
  if (!activeId || !confirm(`Destroy session ${activeId}?`)) return;

  chrome.runtime.sendMessage({
    type: 'BRIDGE_DESTROY_SESSION', sessionId: activeId
  }, () => {
    state.set('activeSessionId', null);
    refreshSessions(state);
  });
}

function refreshSessions(state) {
  chrome.runtime.sendMessage({ type: 'BRIDGE_LIST_SESSIONS' }, (response) => {
    const sessions = response?.sessions || [];
    state.set('sessions', sessions);
    if (!state.get('activeSessionId') && sessions.length > 0) {
      state.set('activeSessionId', sessions[0].id);
    }
  });
}

function renderScriptCard(s) {
  const pct = s.total > 0 ? Math.round((s.step / s.total) * 100) : 0;
  const isActive = s.state === 'running' || s.state === 'paused';
  const stateColors = {
    running: '#1e8e3e', paused: '#f9ab00', complete: '#1967d2',
    cancelled: '#d93025', registered: '#5f5f7f', disconnected: '#d93025',
  };
  const color = stateColors[s.state] || '#5f5f7f';

  const actions = [];
  if (isActive && s.state === 'running') actions.push(`<button class="dash-btn-sm" style="padding:2px 6px;font-size:9px;" data-script-action="pause" data-script-id="${s.scriptId}">Pause</button>`);
  if (s.state === 'paused') actions.push(`<button class="dash-btn-sm" style="padding:2px 6px;font-size:9px;" data-script-action="resume" data-script-id="${s.scriptId}">Resume</button>`);
  if (isActive) actions.push(`<button class="dash-btn-sm danger" style="padding:2px 6px;font-size:9px;" data-script-action="cancel" data-script-id="${s.scriptId}">Cancel</button>`);

  return `
    <div style="padding:6px 12px;border-bottom:1px solid #2a2a4a;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
        <span style="font-size:12px;color:#e0e0e0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(s.name)}</span>
        <span style="font-size:9px;padding:1px 5px;border-radius:3px;background:${color}22;color:${color};">${s.state}</span>
      </div>
      <div style="height:4px;background:#2a2a4a;border-radius:2px;overflow:hidden;margin-bottom:3px;">
        <div style="height:100%;width:${pct}%;background:${color};border-radius:2px;transition:width 0.3s;"></div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:10px;color:#5f5f7f;">
        <span>${s.step || 0}/${s.total || '?'} ${s.label ? '— ' + escapeHtml(s.label) : ''}</span>
        ${s.errors > 0 ? `<span style="color:#d93025;">${s.errors}err</span>` : ''}
        <div style="display:flex;gap:3px;">${actions.join('')}</div>
      </div>
    </div>
  `;
}

function handleScriptAction(action, scriptId) {
  const typeMap = { pause: 'SCRIPT_PAUSE', resume: 'SCRIPT_RESUME', cancel: 'SCRIPT_CANCEL' };
  const type = typeMap[action];
  if (!type) return;
  chrome.runtime.sendMessage({
    type, scriptId, reason: action === 'cancel' ? 'Cancelled from dashboard' : undefined
  });
}

function escapeHtml(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
