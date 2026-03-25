/**
 * Agentiface mode — sidepanel controller for the SmartClient playground.
 *
 * Manages prompt input, app library, and status while the wrapper page
 * (wrapper.html?mode=playground) acts as a pure renderer. Communication
 * flows through background.js which holds the playgroundSession state.
 */

// ---- State ----
let bridgeConnected = false;
let broadcastListener = null;
let promptHistoryLocal = [];
let historyIdx = -1;

// ---- DOM refs ----
let els = {};

// ---- Lifecycle ----

export function init() {
  els = {
    statusBar:      document.getElementById('af-status-bar'),
    bridgeDot:      document.getElementById('af-bridge-dot'),
    statusText:     document.getElementById('af-status-text'),
    playgroundBtn:  document.getElementById('af-open-playground'),
    promptInput:    document.getElementById('af-prompt-input'),
    generateBtn:    document.getElementById('af-generate-btn'),
    saveBtn:        document.getElementById('af-save-btn'),
    undoBtn:        document.getElementById('af-undo-btn'),
    resetBtn:       document.getElementById('af-reset-btn'),
    configSummary:  document.getElementById('af-config-summary'),
    appLibrary:     document.getElementById('af-app-library'),
    appList:        document.getElementById('af-app-list'),
    errorText:      document.getElementById('af-error-text'),
  };

  els.generateBtn.addEventListener('click', handleGenerate);
  els.saveBtn.addEventListener('click', handleSave);
  els.undoBtn.addEventListener('click', handleUndo);
  els.resetBtn.addEventListener('click', handleReset);
  els.playgroundBtn.addEventListener('click', openPlayground);

  els.promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleGenerate();
    } else if (e.key === 'ArrowUp' && promptHistoryLocal.length > 0) {
      e.preventDefault();
      if (historyIdx < promptHistoryLocal.length - 1) historyIdx++;
      els.promptInput.value = promptHistoryLocal[promptHistoryLocal.length - 1 - historyIdx] || '';
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdx > 0) {
        historyIdx--;
        els.promptInput.value = promptHistoryLocal[promptHistoryLocal.length - 1 - historyIdx] || '';
      } else {
        historyIdx = -1;
        els.promptInput.value = '';
      }
    }
  });
}

export function activate() {
  requestPlaygroundState();
  loadAppLibrary();
  startBroadcastListener();
}

export function deactivate() {
  stopBroadcastListener();
}

// ---- Generate ----

function handleGenerate() {
  const prompt = els.promptInput.value.trim();
  if (!prompt) return;

  promptHistoryLocal.push(prompt);
  historyIdx = -1;
  els.promptInput.value = '';

  setGenerating(true);
  chrome.runtime.sendMessage({
    type: 'SC_PLAYGROUND_GENERATE',
    prompt,
  }, (response) => {
    setGenerating(false);
    if (response?.success) {
      showError(null);
    } else {
      showError(response?.error || 'Generation failed');
    }
  });
}

function setGenerating(active) {
  els.generateBtn.disabled = active;
  els.generateBtn.textContent = active ? 'Generating...' : 'Generate';
  els.promptInput.disabled = active;
}

// ---- Save / Undo / Reset ----

function handleSave() {
  els.saveBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_SAVE' }, (response) => {
    els.saveBtn.disabled = false;
    if (response?.success) {
      loadAppLibrary();
    } else {
      showError(response?.error || 'Save failed');
    }
  });
}

function handleUndo() {
  chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_UNDO' }, (response) => {
    if (!response?.success) {
      showError(response?.error || 'Nothing to undo');
    }
  });
}

function handleReset() {
  chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_RESET' });
}

// ---- Playground tab ----

function openPlayground() {
  chrome.tabs.create({
    url: chrome.runtime.getURL('smartclient-app/wrapper.html?mode=playground'),
  });
}

// ---- State sync ----

function requestPlaygroundState() {
  chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_STATE' }, (response) => {
    if (response?.success) updateUI(response);
  });

  // Also check bridge status
  chrome.runtime.sendMessage({ type: 'BRIDGE_STATUS' }, (response) => {
    bridgeConnected = response?.connected || false;
    updateBridgeDot();
  });
}

function updateUI(state) {
  if (!els.statusText) return;

  // Status
  const statusLabel = {
    idle: 'Ready',
    generating: 'Generating...',
    error: 'Error',
  }[state.status] || state.status;
  els.statusText.textContent = statusLabel;

  // Error
  showError(state.status === 'error' ? state.error : null);

  // Button visibility
  els.saveBtn.style.display = state.hasConfig ? '' : 'none';
  els.undoBtn.style.display = state.undoCount > 0 ? '' : 'none';
  els.resetBtn.style.display = state.hasConfig ? '' : 'none';

  // Config summary
  if (state.hasConfig && state.config) {
    const dsCount = state.config.dataSources?.length || 0;
    const layoutType = state.config.layout?._type || 'unknown';
    els.configSummary.textContent = `${dsCount} DataSource${dsCount !== 1 ? 's' : ''} | ${layoutType}`;
    els.configSummary.style.display = '';
  } else if (state.hasConfig) {
    els.configSummary.textContent = state.appName || 'Config loaded';
    els.configSummary.style.display = '';
  } else {
    els.configSummary.style.display = 'none';
  }

  // Generating state
  setGenerating(state.status === 'generating');
}

function updateBridgeDot() {
  if (!els.bridgeDot) return;
  els.bridgeDot.className = bridgeConnected ? 'bridge-dot connected' : 'bridge-dot';
}

function showError(msg) {
  if (!els.errorText) return;
  if (msg) {
    els.errorText.textContent = msg;
    els.errorText.style.display = '';
  } else {
    els.errorText.style.display = 'none';
  }
}

// ---- App Library ----

function loadAppLibrary() {
  if (!els.appList) return;

  chrome.runtime.sendMessage({ type: 'AF_APP_LIST' }, (response) => {
    if (!response?.success || !response.apps) {
      els.appList.innerHTML = '<div class="af-empty">No saved apps</div>';
      return;
    }

    const apps = response.apps.sort((a, b) =>
      (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    if (apps.length === 0) {
      els.appList.innerHTML = '<div class="af-empty">No saved apps</div>';
      return;
    }

    els.appList.innerHTML = apps.map(app => {
      const dsCount = app.config?.dataSources?.length || 0;
      return `<div class="af-app-card" data-id="${esc(app.id)}">
        <div class="af-app-name">${esc(app.name)}</div>
        <div class="af-app-meta">${dsCount} DS</div>
        <button class="af-app-delete" data-id="${esc(app.id)}" title="Delete">x</button>
      </div>`;
    }).join('');

    // Click to load
    els.appList.querySelectorAll('.af-app-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.classList.contains('af-app-delete')) return;
        const id = card.dataset.id;
        chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_LOAD_APP', id });
      });
    });

    // Delete
    els.appList.querySelectorAll('.af-app-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        chrome.runtime.sendMessage({ type: 'AF_APP_DELETE', id }, () => {
          loadAppLibrary();
        });
      });
    });
  });
}

// ---- Broadcast Listener ----

function startBroadcastListener() {
  if (broadcastListener) return;

  broadcastListener = (message) => {
    if (message.type === 'AUTO_BROADCAST_SC_PLAYGROUND') {
      updateUI(message);
    }
    if (message.type === 'AUTO_BROADCAST_CONNECTION') {
      bridgeConnected = message.connected;
      updateBridgeDot();
    }
  };

  chrome.runtime.onMessage.addListener(broadcastListener);
}

function stopBroadcastListener() {
  if (broadcastListener) {
    chrome.runtime.onMessage.removeListener(broadcastListener);
    broadcastListener = null;
  }
}

// ---- Utilities ----

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
