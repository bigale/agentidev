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
    const activeId = state.get('activeSessionId');
    const connected = state.get('bridgeConnected');

    countBadge.textContent = sessions.length;
    createBtn.disabled = !connected;
    destroyBtn.disabled = !connected || !activeId;

    if (sessions.length === 0) {
      body.innerHTML = `<div class="dash-empty">${connected ? 'No sessions — create one' : 'Connect to bridge first'}</div>`;
      return;
    }

    body.innerHTML = `<div class="dash-session-list">${sessions.map(s => {
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

    body.querySelectorAll('.dash-session-item').forEach(el => {
      el.addEventListener('click', () => {
        state.set('activeSessionId', el.dataset.sid);
      });
    });
  }

  state.addEventListener('change', (e) => {
    const k = e.detail.key;
    if (k === 'sessions' || k === 'activeSessionId' || k === 'bridgeConnected') {
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

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
