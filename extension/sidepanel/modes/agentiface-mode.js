/**
 * Agentiface mode — sidepanel controller for the SmartClient playground.
 *
 * Manages prompt input, project library, app library, and status while the
 * wrapper page (wrapper.html?mode=playground) acts as a pure renderer.
 * Communication flows through background.js which holds the playgroundSession state.
 */

// ---- State ----
let bridgeConnected = false;
let broadcastListener = null;
let promptHistoryLocal = [];
let historyIdx = -1;
let thinkingTimer = null;
let thinkingStartTime = 0;

// ---- DOM refs ----
let els = {};

// ---- Lifecycle ----

export function init() {
  els = {
    statusBar:      document.getElementById('af-status-bar'),
    bridgeDot:      document.getElementById('af-bridge-dot'),
    statusText:     document.getElementById('af-status-text'),
    playgroundBtn:  document.getElementById('af-open-playground'),
    projectBar:     document.getElementById('af-project-bar'),
    projectName:    document.getElementById('af-project-name'),
    projectDesc:    document.getElementById('af-project-desc'),
    promptInput:    document.getElementById('af-prompt-input'),
    generateBtn:    document.getElementById('af-generate-btn'),
    saveBtn:        document.getElementById('af-save-btn'),
    undoBtn:        document.getElementById('af-undo-btn'),
    resetBtn:       document.getElementById('af-reset-btn'),
    configSummary:  document.getElementById('af-config-summary'),
    capSkin:        document.getElementById('af-cap-skin'),
    skinSelect:     document.getElementById('af-skin-select'),
    modelSelect:    document.getElementById('af-model-select'),
    thinking:       document.getElementById('af-thinking'),
    thinkingLabel:  document.getElementById('af-thinking-label'),
    thinkingTimer:  document.getElementById('af-thinking-timer'),
    errorText:      document.getElementById('af-error-text'),
    // Create form
    createForm:     document.getElementById('af-create-form'),
    newProjectBtn:  document.getElementById('af-new-project-btn'),
    createProjectBtn: document.getElementById('af-create-project-btn'),
    cancelCreateBtn: document.getElementById('af-cancel-create-btn'),
    newProjectName: document.getElementById('af-new-project-name'),
    newProjectDesc: document.getElementById('af-new-project-desc'),
    newProjectSkin: document.getElementById('af-new-project-skin'),
    // Project library
    projectLibrary: document.getElementById('af-project-library'),
    projectList:    document.getElementById('af-project-list'),
    // Legacy app library
    legacySection:  document.getElementById('af-legacy-section'),
    appLibrary:     document.getElementById('af-app-library'),
    appList:        document.getElementById('af-app-list'),
  };

  els.generateBtn.addEventListener('click', handleGenerate);
  els.saveBtn.addEventListener('click', handleSave);
  els.undoBtn.addEventListener('click', handleUndo);
  els.resetBtn.addEventListener('click', handleReset);
  els.playgroundBtn.addEventListener('click', openPlayground);

  els.capSkin.addEventListener('change', () => {
    chrome.runtime.sendMessage({
      type: 'SC_PLAYGROUND_SET_CAPABILITIES',
      capabilities: { skinPicker: els.capSkin.checked },
    });
  });

  els.skinSelect.addEventListener('change', () => {
    chrome.runtime.sendMessage({
      type: 'SC_PLAYGROUND_SET_SKIN',
      skin: els.skinSelect.value,
    });
  });

  els.modelSelect.addEventListener('change', () => {
    chrome.runtime.sendMessage({
      type: 'SC_PLAYGROUND_SET_MODEL',
      model: els.modelSelect.value,
    });
  });

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

  // Create project form
  els.newProjectBtn.addEventListener('click', handleNewProject);
  els.createProjectBtn.addEventListener('click', handleCreateProject);
  els.cancelCreateBtn.addEventListener('click', () => {
    els.createForm.style.display = 'none';
  });
}

export function activate() {
  requestPlaygroundState();
  loadProjectLibrary();
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

  // Thinking indicator
  if (active) {
    startThinking();
  } else {
    stopThinking();
  }
}

function startThinking() {
  if (!els.thinking) return;
  const modelName = els.modelSelect ? els.modelSelect.selectedOptions[0]?.textContent || 'Sonnet' : 'Sonnet';
  els.thinkingLabel.textContent = `${modelName} is thinking...`;
  els.thinking.classList.add('active');
  thinkingStartTime = Date.now();
  els.thinkingTimer.textContent = '0s';
  thinkingTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - thinkingStartTime) / 1000);
    els.thinkingTimer.textContent = `${elapsed}s`;
  }, 1000);
}

function stopThinking() {
  if (!els.thinking) return;
  els.thinking.classList.remove('active');
  if (thinkingTimer) {
    clearInterval(thinkingTimer);
    thinkingTimer = null;
  }
}

// ---- Save / Undo / Reset ----

function handleSave() {
  els.saveBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_SAVE' }, (response) => {
    els.saveBtn.disabled = false;
    if (response?.success) {
      loadProjectLibrary();
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

// ---- Create Project ----

function handleNewProject() {
  els.createForm.style.display = '';
  els.newProjectName.value = '';
  els.newProjectDesc.value = '';
  els.newProjectSkin.value = 'Tahoe';
  els.newProjectName.focus();
}

function handleCreateProject() {
  const name = els.newProjectName.value.trim();
  if (!name) {
    els.newProjectName.focus();
    return;
  }

  els.createProjectBtn.disabled = true;
  chrome.runtime.sendMessage({
    type: 'SC_PLAYGROUND_CREATE_PROJECT',
    name,
    description: els.newProjectDesc.value.trim(),
    skin: els.newProjectSkin.value,
    capabilities: { skinPicker: els.capSkin.checked },
  }, (response) => {
    els.createProjectBtn.disabled = false;
    if (response?.success) {
      els.createForm.style.display = 'none';
      loadProjectLibrary();
      openPlayground();
    } else {
      showError(response?.error || 'Failed to create project');
    }
  });
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
  els.resetBtn.style.display = state.hasConfig || state.projectId ? '' : 'none';

  // Project bar
  if (state.projectId && els.projectBar) {
    els.projectBar.style.display = '';
    els.projectName.textContent = state.projectName || 'Untitled Project';
    els.projectDesc.textContent = state.projectDescription || '';
  } else if (els.projectBar) {
    els.projectBar.style.display = 'none';
  }

  // Prompt placeholder
  if (state.projectName) {
    els.promptInput.placeholder = `Describe changes to ${state.projectName}...`;
  } else {
    els.promptInput.placeholder = 'Describe a UI to generate...';
  }

  // Config summary
  if (state.hasConfig && state.config) {
    const dsCount = state.config.dataSources?.length || 0;
    const layoutType = state.config.layout?._type || 'unknown';
    els.configSummary.textContent = `${dsCount} DataSource${dsCount !== 1 ? 's' : ''} | ${layoutType}`;
    els.configSummary.style.display = '';
  } else if (state.hasConfig) {
    els.configSummary.textContent = state.projectName || state.appName || 'Config loaded';
    els.configSummary.style.display = '';
  } else {
    els.configSummary.style.display = 'none';
  }

  // Capabilities sync
  if (state.capabilities && els.capSkin) {
    els.capSkin.checked = !!state.capabilities.skinPicker;
  }
  if (state.skin && els.skinSelect) {
    els.skinSelect.value = state.skin;
  }
  if (state.model && els.modelSelect) {
    els.modelSelect.value = state.model;
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

// ---- Project Library ----

function loadProjectLibrary() {
  if (!els.projectList) return;

  // Load projects from bridge
  chrome.runtime.sendMessage({ type: 'AF_PROJECT_LIST' }, (projResponse) => {
    const projects = (projResponse?.success && projResponse.projects) ? projResponse.projects : [];
    projects.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    if (projects.length === 0) {
      els.projectList.innerHTML = '<div class="af-empty">No projects yet</div>';
    } else {
      els.projectList.innerHTML = projects.map(proj => {
        const compCount = proj.componentCount || 0;
        const descSnippet = proj.description ? ` - ${esc(proj.description).slice(0, 50)}` : '';
        return `<div class="af-project-card" data-id="${esc(proj.id)}">
          <div class="af-project-card-header">
            <div class="af-project-card-name">${esc(proj.name)}</div>
            <div class="af-project-card-meta">${compCount} DS</div>
            <button class="af-app-delete" data-id="${esc(proj.id)}" data-type="project" title="Delete">x</button>
          </div>
          ${proj.description ? `<div class="af-project-card-desc">${esc(proj.description)}</div>` : ''}
        </div>`;
      }).join('');

      // Click to load project
      els.projectList.querySelectorAll('.af-project-card').forEach(card => {
        card.addEventListener('click', (e) => {
          if (e.target.classList.contains('af-app-delete')) return;
          const id = card.dataset.id;
          chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_LOAD_PROJECT', id }, (response) => {
            if (response?.success) openPlayground();
          });
        });
      });

      // Delete project
      els.projectList.querySelectorAll('.af-app-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.dataset.id;
          chrome.runtime.sendMessage({ type: 'SC_PROJECT_DELETE', id }, () => {
            // Also delete from bridge
            chrome.runtime.sendMessage({ type: 'AF_PROJECT_DELETE', id }, () => {
              loadProjectLibrary();
            });
          });
        });
      });
    }

    // Load legacy apps
    loadLegacyApps();
  });
}

function loadLegacyApps() {
  if (!els.appList) return;

  chrome.runtime.sendMessage({ type: 'AF_APP_LIST' }, (response) => {
    if (!response?.success || !response.apps || response.apps.length === 0) {
      els.legacySection.style.display = 'none';
      return;
    }

    const apps = response.apps.sort((a, b) =>
      (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    els.legacySection.style.display = '';
    els.appList.innerHTML = apps.map(app => {
      const dsCount = app.config?.dataSources?.length || 0;
      return `<div class="af-app-card" data-id="${esc(app.id)}">
        <div class="af-app-name">${esc(app.name)}</div>
        <div class="af-app-meta">${dsCount} DS</div>
        <button class="af-app-delete" data-id="${esc(app.id)}" title="Delete">x</button>
      </div>`;
    }).join('');

    // Click to load legacy app
    els.appList.querySelectorAll('.af-app-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.classList.contains('af-app-delete')) return;
        const id = card.dataset.id;
        chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_LOAD_APP', id });
      });
    });

    // Delete legacy app
    els.appList.querySelectorAll('.af-app-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        chrome.runtime.sendMessage({ type: 'AF_APP_DELETE', id }, () => {
          loadProjectLibrary();
        });
      });
    });
  });
}

// ---- Bridge-backed project list handler ----

function handleAfProjectList(message) {
  // Handled by smartclient-handlers via bridge
  if (!bridgeConnected) {
    return { success: false, error: 'Bridge not connected' };
  }
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
