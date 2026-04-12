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
let hasConfig = false;
let historyOpen = false;
let lastHistoryData = [];
let currentMode = 'render';
let currentSuggestedPrompts = [];

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
    log:            document.getElementById('af-log'),
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
    // History panel
    historyBtn:     document.getElementById('af-history-btn'),
    historyPanel:   document.getElementById('af-history-panel'),
    historyList:    document.getElementById('af-history-list'),
    // Inspector + templates (Phase 4a)
    inspectorBtn:   document.getElementById('af-inspector-btn'),
    saveTemplateBtn: document.getElementById('af-save-template-btn'),
    publishPluginBtn: document.getElementById('af-publish-plugin-btn'),
    modeBar:        document.getElementById('af-mode-bar'),
    modeLabel:      document.getElementById('af-mode-label'),
    suggestedPrompts: document.getElementById('af-suggested-prompts'),
    suggestedList:  document.getElementById('af-suggested-list'),
    templateSelect: document.getElementById('af-new-project-template'),
    // Save-as-template form
    saveTemplateForm: document.getElementById('af-save-template-form'),
    tplName:        document.getElementById('af-tpl-name'),
    tplDesc:        document.getElementById('af-tpl-desc'),
    tplCategory:    document.getElementById('af-tpl-category'),
    tplAiPrompt:    document.getElementById('af-tpl-ai-prompt'),
    saveTemplateConfirmBtn: document.getElementById('af-save-template-confirm-btn'),
    cancelTemplateBtn: document.getElementById('af-cancel-template-btn'),
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

  els.historyBtn.addEventListener('click', handleToggleHistory);

  // Create project form
  els.newProjectBtn.addEventListener('click', handleNewProject);
  els.createProjectBtn.addEventListener('click', handleCreateProject);
  els.cancelCreateBtn.addEventListener('click', () => {
    els.createForm.style.display = 'none';
  });

  // Inspector toggle (Phase 4a)
  if (els.inspectorBtn) {
    els.inspectorBtn.addEventListener('click', handleToggleInspector);
  }

  // Save as template (Phase 4a)
  if (els.saveTemplateBtn) {
    els.saveTemplateBtn.addEventListener('click', () => {
      if (els.saveTemplateForm) {
        els.saveTemplateForm.style.display = '';
        els.tplName.value = '';
        els.tplDesc.value = '';
        els.tplCategory.value = 'Custom';
        els.tplAiPrompt.value = '';
        els.tplName.focus();
      }
    });
  }
  if (els.publishPluginBtn) {
    els.publishPluginBtn.addEventListener('click', handlePublishPlugin);
  }
  if (els.saveTemplateConfirmBtn) {
    els.saveTemplateConfirmBtn.addEventListener('click', handleSaveTemplate);
  }
  if (els.cancelTemplateBtn) {
    els.cancelTemplateBtn.addEventListener('click', () => {
      els.saveTemplateForm.style.display = 'none';
    });
  }
}

export function activate() {
  requestPlaygroundState();
  loadProjectLibrary();
  populateTemplateDropdown();
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

  const mode = hasConfig ? 'Modify' : 'Generate';
  const modelName = els.modelSelect?.selectedOptions[0]?.textContent || 'Sonnet';
  appendLog(`${mode}: "${prompt.length > 60 ? prompt.slice(0, 60) + '...' : prompt}"`);
  appendLog(`Model: ${modelName} | Sending to bridge...`);

  setGenerating(true, hasConfig);
  chrome.runtime.sendMessage({
    type: 'SC_PLAYGROUND_GENERATE',
    prompt,
  }, (response) => {
    const elapsed = thinkingStartTime ? Math.round((Date.now() - thinkingStartTime) / 1000) : 0;
    setGenerating(false, response?.success ? true : hasConfig);
    if (response?.success) {
      const ds = response.config?.dataSources?.length || 0;
      const layout = response.config?.layout?._type || 'unknown';
      appendLog(`Config received (${elapsed}s): ${ds} DS, ${layout} layout`, 'success');
      appendLog('Rendered to playground', 'success');
      showError(null);
    } else {
      appendLog(`Error (${elapsed}s): ${response?.error || 'Generation failed'}`, 'error');
      showError(response?.error || 'Generation failed');
    }
  });
}

function setGenerating(active, hasConfig) {
  els.generateBtn.disabled = active;
  if (active) {
    els.generateBtn.textContent = hasConfig ? 'Modifying...' : 'Generating...';
  } else {
    els.generateBtn.textContent = hasConfig ? 'Modify' : 'Generate';
  }
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
  appendLog('Saving...');
  chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_SAVE' }, (response) => {
    els.saveBtn.disabled = false;
    if (response?.success) {
      appendLog('Saved', 'success');
      loadProjectLibrary();
    } else {
      appendLog('Save failed: ' + (response?.error || 'unknown'), 'error');
      showError(response?.error || 'Save failed');
    }
  });
}

function handleUndo() {
  chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_UNDO' }, (response) => {
    if (response?.success) {
      appendLog('Undo: reverted to previous config', 'success');
    } else {
      showError(response?.error || 'Nothing to undo');
    }
  });
}

function handleReset() {
  appendLog('Reset playground');
  clearLog();
  chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_RESET' });
}

// ---- History panel ----

function handleToggleHistory() {
  historyOpen = !historyOpen;
  if (historyOpen) {
    els.historyPanel.classList.add('open');
    els.historyBtn.textContent = 'Hide History';
    // Fetch fresh state to render entries
    chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_STATE' }, (response) => {
      if (response?.success) {
        lastHistoryData = response.history || [];
        renderHistoryEntries(lastHistoryData, response.undoCount);
      }
    });
  } else {
    els.historyPanel.classList.remove('open');
    els.historyBtn.textContent = 'History';
  }
}

function renderHistoryEntries(history, undoCount) {
  if (!els.historyList) return;
  if (!history || history.length === 0) {
    els.historyList.innerHTML = '<div class="af-history-empty">No history yet</div>';
    return;
  }

  // Show oldest first (index 0 = earliest), highlight the latest as active
  els.historyList.innerHTML = history.map((h, i) => {
    const isActive = i === history.length - 1;
    const promptSnippet = h.prompt
      ? (h.prompt.length > 50 ? h.prompt.slice(0, 50) + '...' : h.prompt)
      : '(no prompt)';
    return `<div class="af-history-entry${isActive ? ' active' : ''}" data-index="${h.index}">
      <span class="af-history-idx">${i + 1}</span>
      <span class="af-history-prompt">${esc(promptSnippet)}</span>
      <button class="af-history-restore" data-index="${h.index}">Restore</button>
    </div>`;
  }).join('');

  // Restore click handlers
  els.historyList.querySelectorAll('.af-history-restore').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index, 10);
      handleRestoreVersion(idx);
    });
  });

  // Scroll to bottom (latest)
  els.historyList.scrollTop = els.historyList.scrollHeight;
}

function handleRestoreVersion(index) {
  chrome.runtime.sendMessage({
    type: 'SC_PLAYGROUND_RESTORE_VERSION',
    index,
  }, (response) => {
    if (response?.success) {
      appendLog(`Restored version #${index + 1}`, 'success');
    } else {
      showError(response?.error || 'Restore failed');
    }
  });
}

// ---- Create Project ----

function handleNewProject() {
  els.createForm.style.display = '';
  els.newProjectName.value = '';
  els.newProjectDesc.value = '';
  els.newProjectSkin.value = 'Tahoe';
  if (els.templateSelect) els.templateSelect.value = '';
  els.newProjectName.focus();
}

function handleCreateProject() {
  const name = els.newProjectName.value.trim();
  if (!name) {
    els.newProjectName.focus();
    return;
  }

  const templateId = els.templateSelect ? els.templateSelect.value : '';

  els.createProjectBtn.disabled = true;
  chrome.runtime.sendMessage({
    type: 'SC_PLAYGROUND_CREATE_PROJECT',
    name,
    description: els.newProjectDesc.value.trim(),
    skin: els.newProjectSkin.value,
    capabilities: { skinPicker: els.capSkin.checked },
    templateId: templateId || undefined,
  }, (response) => {
    els.createProjectBtn.disabled = false;
    if (response?.success) {
      els.createForm.style.display = 'none';

      // Also publish as a plugin so it appears in the Plugins list immediately
      // We'll get the config after the playground renders and publish then.
      // For now, just open the playground — the user can publish from there.
      loadProjectLibrary();

      openPlayground(templateId || undefined);
    } else {
      showError(response?.error || 'Failed to create project');
    }
  });
}


// ---- Playground tab ----

function openPlayground(templateId) {
  let url = chrome.runtime.getURL('smartclient-app/wrapper.html?mode=playground');
  if (templateId) url += '&template=' + encodeURIComponent(templateId);
  chrome.tabs.create({ url });
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
  els.historyBtn.style.display = (state.undoCount > 0 || state.projectId) ? '' : 'none';
  els.resetBtn.style.display = state.hasConfig || state.projectId ? '' : 'none';

  // Auto-refresh history panel if open
  if (historyOpen && state.history) {
    lastHistoryData = state.history;
    renderHistoryEntries(state.history, state.undoCount);
  }

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
  } else if (state.hasConfig) {
    els.promptInput.placeholder = 'Describe modifications to the UI...';
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

  // Inspector/template buttons (Phase 4a)
  if (els.inspectorBtn) {
    els.inspectorBtn.style.display = state.hasConfig ? '' : 'none';
  }
  if (els.saveTemplateBtn) {
    els.saveTemplateBtn.style.display = state.hasConfig ? '' : 'none';
  }
  if (els.publishPluginBtn) {
    els.publishPluginBtn.style.display = state.hasConfig ? '' : 'none';
  }

  // Sync mode
  if (state.mode) {
    currentMode = state.mode;
    updateModeUI();
  }

  // Track config state for button label
  hasConfig = !!state.hasConfig;

  // Generating state
  setGenerating(state.status === 'generating', hasConfig);
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

  // Load plugins (primary) + legacy projects (secondary)
  chrome.runtime.sendMessage({ type: 'PLUGIN_LIST' }, (plugins) => {
    const pluginList = Array.isArray(plugins) ? plugins : [];

    // Also load legacy projects
    chrome.runtime.sendMessage({ type: 'AF_PROJECT_LIST' }, (projResponse) => {
      const projects = (projResponse?.success && projResponse.projects) ? projResponse.projects : [];
      // Filter out projects that are already published as plugins
      const pluginIds = new Set(pluginList.map(p => p.id));
      const legacyProjects = projects.filter(p => !pluginIds.has(p.id));

      const items = [];

      // Plugins first
      for (const p of pluginList) {
        const isFileBacked = !p.description?.includes('Published from Agentiface') && !p.id?.startsWith('proj_');
        const badge = isFileBacked ? '<span style="color:#888;font-size:9px;margin-left:4px;">file</span>' : '';
        items.push(`<div class="af-project-card" data-id="${esc(p.id)}" data-source="plugin">
          <div class="af-project-card-header">
            <div class="af-project-card-name">${esc(p.name)}${badge}</div>
            <div class="af-project-card-meta">${esc(p.version || '')}</div>
            ${!isFileBacked ? `<button class="af-app-delete" data-id="${esc(p.id)}" data-type="plugin" title="Delete">x</button>` : ''}
          </div>
          ${p.description ? `<div class="af-project-card-desc">${esc(p.description).slice(0, 60)}</div>` : ''}
        </div>`);
      }

      // Legacy projects (not yet published as plugins)
      if (legacyProjects.length > 0) {
        items.push('<div style="font-size:10px;color:#666;padding:6px 4px 2px;border-top:1px solid #333;margin-top:4px;">Legacy Projects</div>');
        for (const proj of legacyProjects) {
          const compCount = proj.componentCount || 0;
          items.push(`<div class="af-project-card" data-id="${esc(proj.id)}" data-source="project">
            <div class="af-project-card-header">
              <div class="af-project-card-name">${esc(proj.name)}</div>
              <div class="af-project-card-meta">${compCount} DS</div>
              <button class="af-app-delete" data-id="${esc(proj.id)}" data-type="project" title="Delete">x</button>
            </div>
            ${proj.description ? `<div class="af-project-card-desc">${esc(proj.description)}</div>` : ''}
          </div>`);
        }
      }

      if (items.length === 0) {
        els.projectList.innerHTML = '<div class="af-empty">No plugins yet — click + New</div>';
      } else {
        els.projectList.innerHTML = items.join('');
      }

      // Click handlers
      els.projectList.querySelectorAll('.af-project-card').forEach(card => {
        card.addEventListener('click', (e) => {
          if (e.target.classList.contains('af-app-delete')) return;
          const id = card.dataset.id;
          const source = card.dataset.source;
          if (source === 'plugin') {
            // Open the plugin in its own mode (editable if storage-backed)
            openPluginMode(id);
          } else {
            // Legacy: load project into playground
            chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_LOAD_PROJECT', id }, (response) => {
              if (response?.success) openPlayground();
            });
          }
        });
      });

      // Delete handlers
      els.projectList.querySelectorAll('.af-app-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.dataset.id;
          const type = btn.dataset.type;
          if (type === 'plugin') {
            chrome.runtime.sendMessage({ type: 'SC_UNPUBLISH_PLUGIN', id }, () => {
              loadProjectLibrary();
            });
          } else {
            chrome.runtime.sendMessage({ type: 'SC_PROJECT_DELETE', id }, () => {
              chrome.runtime.sendMessage({ type: 'AF_PROJECT_DELETE', id }, () => {
                loadProjectLibrary();
              });
            });
          }
        });
      });

      // Load legacy apps
      loadLegacyApps();
    });
  });
}

function openPluginMode(pluginId) {
  // Open the plugin in a new tab (or reuse existing)
  const mode = pluginId;
  chrome.tabs.create({
    url: chrome.runtime.getURL('smartclient-app/wrapper.html?mode=' + encodeURIComponent(mode)),
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

// ---- Inspector toggle (Phase 4a) ----

function handleToggleInspector() {
  currentMode = currentMode === 'render' ? 'visual' : 'render';
  chrome.runtime.sendMessage({
    type: 'SC_PLAYGROUND_SET_MODE',
    mode: currentMode,
  });
  updateModeUI();
}

function updateModeUI() {
  if (els.inspectorBtn) {
    els.inspectorBtn.textContent = currentMode === 'visual' ? 'Hide Inspector' : 'Inspector';
  }
  if (els.modeBar) {
    els.modeBar.style.display = currentMode === 'visual' ? '' : 'none';
    if (els.modeLabel) {
      els.modeLabel.textContent = 'Mode: ' + (currentMode === 'visual' ? 'Visual' : 'Render');
      els.modeLabel.className = currentMode === 'visual' ? 'mode-visual' : '';
    }
  }
}

// ---- Templates (Phase 4a) ----

// Bundled template data (loaded from templates.js via fetch or inline)
const BUNDLED_TEMPLATES = [
  { id: 'tpl_blank', name: 'Blank Canvas', category: 'General' },
  { id: 'tpl_crud', name: 'CRUD Manager', category: 'Data' },
  { id: 'tpl_master_detail', name: 'Master-Detail', category: 'Data' },
  { id: 'tpl_dashboard', name: 'Dashboard', category: 'Layout' },
  { id: 'tpl_calculator', name: 'Calculator', category: 'Input' },
  { id: 'tpl_wizard', name: 'Wizard', category: 'Navigation' },
  { id: 'tpl_search_explorer', name: 'Search Explorer', category: 'Data' },
];

function populateTemplateDropdown() {
  if (!els.templateSelect) return;
  els.templateSelect.innerHTML = '<option value="">None (blank)</option>';
  for (const tpl of BUNDLED_TEMPLATES) {
    const opt = document.createElement('option');
    opt.value = tpl.id;
    opt.textContent = tpl.name;
    els.templateSelect.appendChild(opt);
  }
  // Also fetch user templates from bridge
  chrome.runtime.sendMessage({ type: 'SC_TEMPLATE_LIST' }, (response) => {
    if (response?.success && response.templates?.length > 0) {
      const sep = document.createElement('option');
      sep.disabled = true;
      sep.textContent = '── User Templates ──';
      els.templateSelect.appendChild(sep);
      for (const tpl of response.templates) {
        const opt = document.createElement('option');
        opt.value = tpl.id;
        opt.textContent = tpl.name;
        els.templateSelect.appendChild(opt);
      }
    }
  });
}

function showSuggestedPrompts(prompts) {
  currentSuggestedPrompts = prompts || [];
  if (!els.suggestedPrompts || !els.suggestedList) return;
  if (currentSuggestedPrompts.length === 0) {
    els.suggestedPrompts.style.display = 'none';
    return;
  }
  els.suggestedPrompts.style.display = '';
  els.suggestedList.innerHTML = currentSuggestedPrompts.map(p =>
    `<span class="af-suggestion">${esc(p)}</span>`
  ).join('');
  els.suggestedList.querySelectorAll('.af-suggestion').forEach((el, i) => {
    el.addEventListener('click', () => {
      els.promptInput.value = currentSuggestedPrompts[i];
      els.promptInput.focus();
    });
  });
}

function handleSaveTemplate() {
  const name = els.tplName.value.trim();
  if (!name) {
    els.tplName.focus();
    return;
  }
  els.saveTemplateConfirmBtn.disabled = true;
  // Get current config from background
  chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_STATE' }, (state) => {
    if (!state?.config) {
      els.saveTemplateConfirmBtn.disabled = false;
      showError('No config to save as template');
      return;
    }
    chrome.runtime.sendMessage({
      type: 'SC_TEMPLATE_SAVE',
      name,
      description: els.tplDesc.value.trim(),
      category: els.tplCategory.value.trim() || 'Custom',
      config: state.config,
      aiSystemPrompt: els.tplAiPrompt.value.trim(),
      suggestedPrompts: [],
    }, (response) => {
      els.saveTemplateConfirmBtn.disabled = false;
      if (response?.success) {
        els.saveTemplateForm.style.display = 'none';
        appendLog('Saved as template: ' + name, 'success');
        populateTemplateDropdown();
      } else {
        showError(response?.error || 'Failed to save template');
      }
    });
  });
}

function handlePublishPlugin() {
  chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_STATE' }, (state) => {
    if (!state?.config) {
      showError('No config to publish as plugin');
      return;
    }
    const name = state.projectName || prompt('Plugin name:');
    if (!name) return;

    chrome.runtime.sendMessage({
      type: 'SC_PUBLISH_PLUGIN',
      name: name,
      description: state.projectDescription || name,
      projectId: state.projectId || null,
      config: state.config,
    }, (response) => {
      if (response?.success) {
        appendLog('Published as plugin: ' + name + ' (mode: ' + response.mode + ')', 'success');
        appendLog('Open from sidebar Plugins menu or: wrapper.html?mode=' + response.mode, 'info');
      } else {
        showError(response?.error || 'Failed to publish plugin');
      }
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

// ---- Status log ----

function appendLog(message, type) {
  if (!els.log) return;
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const entry = document.createElement('div');
  entry.className = 'af-log-entry' + (type ? ' ' + type : '');
  entry.innerHTML = `<span class="af-log-time">${time}</span>${esc(message)}`;
  els.log.appendChild(entry);
  els.log.scrollTop = els.log.scrollHeight;
  // Keep last 20 entries
  while (els.log.children.length > 20) els.log.removeChild(els.log.firstChild);
}

function clearLog() {
  if (els.log) els.log.innerHTML = '';
}

// ---- Utilities ----

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
