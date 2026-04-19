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
  // Playground button removed (D1). Keep the listener guard in case
  // the element still exists in old cached HTML.
  if (els.playgroundBtn) els.playgroundBtn.addEventListener('click', openPlayground);

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

  // Use agent-powered generation if available (Ollama/WebLLM),
  // fall back to one-shot bridge claude -p spawn
  if (modelName === 'Agent') {
    handleAgentGenerate(prompt);
    return;
  }

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

      // Auto-save: get current state and publish/update plugin
      chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_STATE' }, (state) => {
        if (state?.pluginId || state?.projectId) {
          // Update existing plugin
          chrome.runtime.sendMessage({
            type: 'SC_PUBLISH_PLUGIN',
            name: state.projectName || 'Generated App',
            description: state.projectDescription || prompt,
            projectId: state.pluginId || state.projectId,
            config: response.config,
          }, () => {
            appendLog('Plugin updated', 'success');
            loadProjectLibrary();
          });
          // Open the plugin mode tab
          openPluginMode(state.pluginId || state.projectId);
        } else {
          // No active plugin — create one
          chrome.runtime.sendMessage({
            type: 'SC_PUBLISH_PLUGIN',
            name: prompt.length > 40 ? prompt.substring(0, 40) : prompt,
            description: 'Generated: ' + prompt,
            config: response.config,
          }, (pubResp) => {
            if (pubResp?.success) {
              appendLog('Saved as plugin: ' + pubResp.id, 'success');
              loadProjectLibrary();
              openPluginMode(pubResp.id);
            }
          });
        }
      });
      showError(null);
    } else {
      appendLog(`Error (${elapsed}s): ${response?.error || 'Generation failed'}`, 'error');
      showError(response?.error || 'Generation failed');
    }
  });
}

async function handleAgentGenerate(prompt) {
  appendLog('Agent mode: using pi-mono agent loop');
  setGenerating(true, hasConfig);

  try {
    const { initProvider, getModel } = await import('../agent/agent-provider.js');
    const { Agent } = await import('../../lib/vendor/pi-bundle.js');

    await initProvider();
    const model = getModel();
    if (!model) {
      appendLog('No LLM provider available (install Ollama or enable WebLLM)', 'error');
      setGenerating(false, hasConfig);
      return;
    }

    // Create a focused UI-generation agent
    const agent = new Agent({
      initialState: {
        systemPrompt: `You are a SmartClient UI generator. When given a description, call the sc_generate tool with a clear prompt. After generation, check if there are issues and report them. Be very brief in your responses — the UI is the output, not text.`,
        model,
        tools: [{
          name: 'sc_generate',
          label: 'Generate UI',
          description: 'Generate a SmartClient dashboard config from a prompt',
          parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'UI description' } }, required: ['prompt'] },
          execute: async (id, params) => {
            return new Promise((resolve) => {
              // Use SC_PLAYGROUND_GENERATE to update the session state AND generate
              chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_GENERATE', prompt: params.prompt }, (r) => {
                if (r?.success) {
                  // Open a wrapper tab to show the result
                  const extId = chrome.runtime.id;
                  chrome.tabs.create({
                    url: `chrome-extension://${extId}/smartclient-app/wrapper.html?mode=playground`,
                    active: false,
                  });
                  resolve({ content: [{ type: 'text', text: 'UI generated and opened in a new tab. Layout: ' + (r.config?.layout?._type || 'unknown') + ', DataSources: ' + (r.config?.dataSources?.length || 0) }], details: r });
                } else {
                  resolve({ content: [{ type: 'text', text: 'Generation failed: ' + (r?.error || 'unknown') }] });
                }
              });
            });
          },
        }],
        thinkingLevel: 'off',
        toolExecution: 'sequential',
      },
      getApiKey: async () => model.apiKey || 'ollama',
    });

    // Subscribe to events for logging
    agent.subscribe((event) => {
      if (event.type === 'tool_execution_start') appendLog('Calling sc_generate...');
      if (event.type === 'tool_execution_end') {
        const result = event.result?.details;
        if (result?.success) {
          const ds = result.config?.dataSources?.length || 0;
          const layout = result.config?.layout?._type || 'unknown';
          appendLog(`Config: ${ds} DS, ${layout} layout`, 'success');
        }
      }
      if (event.type === 'message_update') {
        const partial = event.partial || event.message;
        if (partial?.content) {
          let text = '';
          for (const b of partial.content) if (b.type === 'text') text += b.text;
          if (text) appendLog(text.substring(0, 100));
        }
      }
    });

    const t0 = Date.now();
    await agent.prompt(prompt);
    const elapsed = Math.round((Date.now() - t0) / 1000);
    appendLog(`Agent complete (${elapsed}s)`, 'success');
    showError(null);

    // Auto-save: publish/update plugin
    chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_STATE' }, (state) => {
      const config = state?.config;
      if (!config) return;
      if (state?.pluginId || state?.projectId) {
        chrome.runtime.sendMessage({
          type: 'SC_PUBLISH_PLUGIN',
          name: state.projectName || prompt.substring(0, 40),
          description: state.projectDescription || prompt,
          projectId: state.pluginId || state.projectId,
          config,
        }, () => {
          appendLog('Plugin updated', 'success');
          loadProjectLibrary();
          openPluginMode(state.pluginId || state.projectId);
        });
      } else {
        const name = prompt.length > 40 ? prompt.substring(0, 40) : prompt;
        chrome.runtime.sendMessage({
          type: 'SC_PUBLISH_PLUGIN',
          name, description: 'Agent: ' + prompt, config,
        }, (resp) => {
          if (resp?.success) {
            appendLog('Saved as plugin: ' + resp.id, 'success');
            loadProjectLibrary();
            openPluginMode(resp.id);
          }
        });
      }
    });

  } catch (err) {
    appendLog('Agent error: ' + err.message, 'error');
    showError(err.message);
  }

  setGenerating(false, true);
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
    if (response?.success) {
      // Also update the plugin storage if this config was loaded from a
      // published plugin. This makes Save = save project + update plugin
      // so changes persist when the plugin is re-opened.
      chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_STATE' }, (state) => {
        els.saveBtn.disabled = false;
        if (state?.config && state?.projectName) {
          chrome.runtime.sendMessage({
            type: 'SC_PUBLISH_PLUGIN',
            name: state.projectName,
            description: state.projectDescription || state.projectName,
            projectId: state.pluginId || state.projectId || null,
            config: state.config,
          }, (pubResponse) => {
            if (pubResponse?.success) {
              appendLog('Saved + plugin updated', 'success');
            } else {
              appendLog('Saved (plugin update failed: ' + (pubResponse?.error || '') + ')', 'success');
            }
            loadProjectLibrary();
          });
        } else {
          appendLog('Saved', 'success');
          loadProjectLibrary();
        }
      });
    } else {
      els.saveBtn.disabled = false;
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
  const description = els.newProjectDesc.value.trim();

  els.createProjectBtn.disabled = true;

  // If a template is selected, we need to get its config first
  if (templateId) {
    // Create the project (for undo/history) then publish as a plugin
    chrome.runtime.sendMessage({
      type: 'SC_PLAYGROUND_CREATE_PROJECT',
      name,
      description,
      skin: els.newProjectSkin.value,
      capabilities: { skinPicker: els.capSkin.checked },
      templateId,
    }, (response) => {
      els.createProjectBtn.disabled = false;
      if (response?.success) {
        els.createForm.style.display = 'none';
        // Get the config that was generated from the template
        chrome.runtime.sendMessage({ type: 'SC_PLAYGROUND_STATE' }, (state) => {
          const config = state?.config || { layout: { _type: 'VLayout', width: '100%', height: '100%', members: [] } };
          _publishAndOpen(name, description, config, state?.projectId);
        });
      } else {
        showError(response?.error || 'Failed to create project');
      }
    });
  } else {
    // No template — create a blank plugin directly
    els.createProjectBtn.disabled = false;
    els.createForm.style.display = 'none';
    const blankConfig = { layout: { _type: 'VLayout', width: '100%', height: '100%', members: [] } };
    _publishAndOpen(name, description, blankConfig, null);
  }
}

function _publishAndOpen(name, description, config, projectId) {
  chrome.runtime.sendMessage({
    type: 'SC_PUBLISH_PLUGIN',
    name,
    description: description || name,
    projectId,
    config,
  }, (response) => {
    if (response?.success) {
      loadProjectLibrary();
      openPluginMode(response.id);
    } else {
      showError(response?.error || 'Failed to create plugin');
    }
  });
}

// ---- Open a plugin or playground tab ----

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

  // Generate button: enabled only when a plugin/project is active or we're in a fresh state
  const hasPlugin = !!state.pluginId || !!state.projectId;
  els.generateBtn.disabled = false; // Always allow generation
  if (hasPlugin) {
    els.promptInput.placeholder = `Describe changes to ${state.projectName || 'plugin'}...`;
    els.generateBtn.textContent = state.hasConfig ? 'Modify' : 'Generate';
  } else if (state.hasConfig) {
    els.promptInput.placeholder = 'Describe modifications...';
  } else {
    els.promptInput.placeholder = 'Click + New to create a plugin, then generate...';
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

  // Load plugins only — legacy projects deprecated
  chrome.runtime.sendMessage({ type: 'PLUGIN_LIST' }, (plugins) => {
    const pluginList = Array.isArray(plugins) ? plugins : [];

    // Known file-backed plugin IDs that shouldn't have a delete button
    // (they're managed externally via assemble.sh)
    const FILE_BACKED = new Set(['hello-runtime', 'horsebread']);

    const items = [];
    for (const p of pluginList) {
      const isFile = FILE_BACKED.has(p.id);
      const badge = isFile ? '<span style="color:#888;font-size:9px;margin-left:4px;">file</span>' : '';
      items.push(`<div class="af-project-card" data-id="${esc(p.id)}" data-source="plugin">
        <div class="af-project-card-header">
          <div class="af-project-card-name">${esc(p.name)}${badge}</div>
          <div class="af-project-card-meta">${esc(p.version || '')}</div>
          ${!isFile ? `<button class="af-app-delete" data-id="${esc(p.id)}" data-type="plugin" title="Delete">x</button>` : ''}
        </div>
        ${p.description ? `<div class="af-project-card-desc">${esc(p.description).slice(0, 60)}</div>` : ''}
      </div>`);
    }

    if (items.length === 0) {
      els.projectList.innerHTML = '<div class="af-empty">No plugins yet — click + New</div>';
    } else {
      els.projectList.innerHTML = items.join('');
    }

    // Click → open plugin mode
    els.projectList.querySelectorAll('.af-project-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.classList.contains('af-app-delete')) return;
        openPluginMode(card.dataset.id);
      });
    });

    // Delete → unpublish
    els.projectList.querySelectorAll('.af-app-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'SC_UNPUBLISH_PLUGIN', id: btn.dataset.id }, () => {
          loadProjectLibrary();
        });
      });
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
