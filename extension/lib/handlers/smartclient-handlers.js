/**
 * SmartClient AI handlers — generate UI configs from natural language prompts.
 * Routes requests through the bridge server, which spawns a fresh `claude -p`
 * subprocess to generate SmartClient JSON configs that renderer.js instantiates.
 */
import * as bridgeClient from '../bridge-client.js';
import { saveApp } from './app-persistence.js';
import { saveProject, loadProject, listProjects } from './project-persistence.js';

// ---- Playground session state (sidepanel controller) ----
let playgroundSession = {
  config: null,
  appId: null,
  appName: null,
  projectId: null,
  projectName: null,
  projectDescription: null,
  pluginId: null,
  promptHistory: [],
  undoStack: [],
  status: 'idle',   // idle | generating | error
  error: null,
  capabilities: { skinPicker: true },
  skin: 'Tahoe',
  model: 'sonnet',
  mode: 'render',          // render | visual
  templatePrompt: null,    // domain-specific AI context from template
};

function broadcastPlaygroundState() {
  const msg = {
    type: 'AUTO_BROADCAST_SC_PLAYGROUND',
    status: playgroundSession.status,
    appName: playgroundSession.appName,
    appId: playgroundSession.appId,
    projectId: playgroundSession.projectId,
    projectName: playgroundSession.projectName,
    projectDescription: playgroundSession.projectDescription,
    pluginId: playgroundSession.pluginId,
    hasConfig: !!playgroundSession.config,
    promptCount: playgroundSession.promptHistory.length,
    undoCount: playgroundSession.undoStack.length,
    error: playgroundSession.error,
    capabilities: playgroundSession.capabilities,
    skin: playgroundSession.skin,
    model: playgroundSession.model,
    mode: playgroundSession.mode,
    templatePrompt: playgroundSession.templatePrompt,
  };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function broadcastConfig() {
  if (!playgroundSession.config) return;
  chrome.runtime.sendMessage({
    type: 'AUTO_BROADCAST_SC_CONFIG',
    config: structuredClone(playgroundSession.config),
    capabilities: playgroundSession.capabilities,
    skin: playgroundSession.skin,
  }).catch(() => {});
}

function validateConfig(config) {
  if (!config.dataSources || !Array.isArray(config.dataSources)) {
    throw new Error('Config must have dataSources array');
  }
  if (!config.layout || !config.layout._type) {
    throw new Error('Config must have layout object with _type');
  }
  for (const ds of config.dataSources) {
    if (!ds.ID) throw new Error('Each dataSource must have an ID');
    if (!ds.fields || !Array.isArray(ds.fields)) {
      throw new Error(`DataSource ${ds.ID} must have fields array`);
    }
  }
}

/**
 * Derive a short app name from a prompt string or URL.
 */
function deriveName(input) {
  if (!input) return 'Untitled App';
  // URL: extract hostname
  try {
    const url = new URL(input);
    return url.hostname.replace(/^www\./, '');
  } catch {
    // Not a URL — use first ~40 chars of prompt
  }
  const trimmed = input.trim();
  if (trimmed.length <= 40) return trimmed;
  return trimmed.slice(0, 40).replace(/\s+\S*$/, '') + '...';
}

async function handleGenerateUI(message) {
  const { prompt, currentConfig, projectDescription, templatePrompt, model } = message;
  if (!prompt || !prompt.trim()) {
    return { success: false, error: 'Prompt is required' };
  }

  if (!bridgeClient.isConnected()) {
    return { success: false, error: 'Bridge server not connected' };
  }

  try {
    const mode = currentConfig ? 'modify' : 'generate';
    console.log(`[SmartClient AI] ${mode} UI via bridge (${model || 'sonnet'}) for:`, prompt);
    const result = await bridgeClient.generateSmartClientUI(prompt, currentConfig, projectDescription || null, model || null, templatePrompt || null);

    if (!result.success) {
      return { success: false, error: result.error || 'Generation failed' };
    }

    // Safety net: re-validate config from bridge
    validateConfig(result.config);

    console.log('[SmartClient AI] Valid config:', result.config.dataSources.length, 'dataSources,', result.config.layout._type, 'layout');

    // Auto-save (non-fatal)
    let appId;
    try {
      const app = await saveApp({
        name: deriveName(prompt),
        type: 'generate',
        config: result.config,
        prompt,
        sourceUrl: null,
        cloneId: null,
      });
      appId = app.id;
      console.log('[SmartClient AI] Saved app:', appId);
    } catch (e) {
      console.warn('[SmartClient AI] Auto-save failed (non-fatal):', e.message);
    }

    return { success: true, config: result.config, appId };
  } catch (err) {
    console.error('[SmartClient AI] Generation failed:', err);
    return { success: false, error: err.message };
  }
}

async function handleClonePage(message) {
  const { sessionId, url, model } = message;
  if (!sessionId) {
    return { success: false, error: 'sessionId is required' };
  }

  if (!bridgeClient.isConnected()) {
    return { success: false, error: 'Bridge server not connected' };
  }

  try {
    console.log('[SmartClient AI] Cloning page via bridge, session:', sessionId, url ? `url: ${url}` : '(current page)');
    const result = await bridgeClient.clonePageToSmartClient(sessionId, { url, model });

    if (!result.success) {
      return { success: false, error: result.error || 'Clone failed' };
    }

    // Safety net: re-validate config from bridge
    validateConfig(result.config);

    console.log('[SmartClient AI] Clone valid config:', result.config.dataSources.length, 'dataSources,', result.config.layout._type, 'layout');

    // Auto-save (non-fatal)
    let appId;
    try {
      const app = await saveApp({
        name: deriveName(result.sources?.url || url),
        type: 'clone',
        config: result.config,
        prompt: null,
        sourceUrl: result.sources?.url || url || null,
        cloneId: result.cloneId || null,
      });
      appId = app.id;
      console.log('[SmartClient AI] Saved clone app:', appId);
    } catch (e) {
      console.warn('[SmartClient AI] Auto-save failed (non-fatal):', e.message);
    }

    return { success: true, config: result.config, sources: result.sources, appId };
  } catch (err) {
    console.error('[SmartClient AI] Clone failed:', err);
    return { success: false, error: err.message };
  }
}

// ---- Bridge-backed app persistence (Phase 5b) ----

async function handleAfAppSave(message) {
  if (!bridgeClient.isConnected()) {
    return { success: false, error: 'Bridge server not connected' };
  }
  try {
    return await bridgeClient.afAppSave(message);
  } catch (err) {
    console.error('[SmartClient AI] AF_APP_SAVE failed:', err);
    return { success: false, error: err.message };
  }
}

async function handleAfAppLoad(message) {
  if (!bridgeClient.isConnected()) {
    return { success: false, error: 'Bridge server not connected' };
  }
  try {
    return await bridgeClient.afAppLoad(message.id);
  } catch (err) {
    console.error('[SmartClient AI] AF_APP_LOAD failed:', err);
    return { success: false, error: err.message };
  }
}

async function handleAfAppList() {
  if (!bridgeClient.isConnected()) {
    return { success: false, error: 'Bridge server not connected' };
  }
  try {
    return await bridgeClient.afAppList();
  } catch (err) {
    console.error('[SmartClient AI] AF_APP_LIST failed:', err);
    return { success: false, error: err.message };
  }
}

async function handleAfAppDelete(message) {
  if (!bridgeClient.isConnected()) {
    return { success: false, error: 'Bridge server not connected' };
  }
  try {
    return await bridgeClient.afAppDelete(message.id);
  } catch (err) {
    console.error('[SmartClient AI] AF_APP_DELETE failed:', err);
    return { success: false, error: err.message };
  }
}

// ---- Bridge-backed project persistence ----

async function handleAfProjectSave(message) {
  if (!bridgeClient.isConnected()) {
    return { success: false, error: 'Bridge server not connected' };
  }
  try {
    return await bridgeClient.afProjectSave(message);
  } catch (err) {
    console.error('[SmartClient AI] AF_PROJECT_SAVE failed:', err);
    return { success: false, error: err.message };
  }
}

async function handleAfProjectLoad(message) {
  if (!bridgeClient.isConnected()) {
    return { success: false, error: 'Bridge server not connected' };
  }
  try {
    return await bridgeClient.afProjectLoad(message.id);
  } catch (err) {
    console.error('[SmartClient AI] AF_PROJECT_LOAD failed:', err);
    return { success: false, error: err.message };
  }
}

async function handleAfProjectList() {
  // Merge both sources: bridge disk + IndexedDB (dual-write resilience)
  let bridgeProjects = [];
  let idbProjects = [];

  // Try bridge
  if (bridgeClient.isConnected()) {
    try {
      const resp = await bridgeClient.afProjectList();
      if (resp?.success && resp.projects) bridgeProjects = resp.projects;
    } catch (err) {
      console.warn('[SmartClient AI] AF_PROJECT_LIST bridge failed:', err.message);
    }
  }

  // Always query IndexedDB
  try {
    idbProjects = await listProjects();
  } catch (err) {
    console.warn('[SmartClient AI] AF_PROJECT_LIST IndexedDB failed:', err.message);
  }

  // Merge: IndexedDB first, bridge overwrites (has richer metadata like historyCount)
  const byId = new Map();
  for (const p of idbProjects) byId.set(p.id, p);
  for (const p of bridgeProjects) byId.set(p.id, p);

  const projects = [...byId.values()];
  projects.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return { success: true, projects };
}

async function handleAfProjectDelete(message) {
  if (!bridgeClient.isConnected()) {
    return { success: false, error: 'Bridge server not connected' };
  }
  try {
    return await bridgeClient.afProjectDelete(message.id);
  } catch (err) {
    console.error('[SmartClient AI] AF_PROJECT_DELETE failed:', err);
    return { success: false, error: err.message };
  }
}

// ---- Playground session handlers ----

async function handlePlaygroundGenerate(message) {
  const { prompt } = message;
  if (!prompt || !prompt.trim()) {
    return { success: false, error: 'Prompt is required' };
  }

  // Push current config to undo stack before generating
  if (playgroundSession.config) {
    playgroundSession.undoStack.push(structuredClone(playgroundSession.config));
  }

  playgroundSession.status = 'generating';
  playgroundSession.error = null;
  broadcastPlaygroundState();

  try {
    const result = await handleGenerateUI({
      prompt,
      currentConfig: playgroundSession.config || undefined,
      projectDescription: playgroundSession.projectDescription || undefined,
      templatePrompt: playgroundSession.templatePrompt || undefined,
      model: playgroundSession.model || 'sonnet',
    });

    if (!result.success) {
      // Revert undo stack push on failure
      if (playgroundSession.config) playgroundSession.undoStack.pop();
      playgroundSession.status = 'error';
      playgroundSession.error = result.error;
      broadcastPlaygroundState();
      return result;
    }

    playgroundSession.config = structuredClone(result.config);
    playgroundSession.appId = result.appId || playgroundSession.appId;
    playgroundSession.appName = playgroundSession.appName || deriveName(prompt);
    playgroundSession.promptHistory.push(prompt);
    playgroundSession.status = 'idle';
    playgroundSession.error = null;

    // Auto-save config to project (both layers, non-fatal)
    if (playgroundSession.projectId) {
      autoSaveToProject(prompt).catch(e =>
        console.warn('[SmartClient AI] Project auto-save failed:', e.message));
    }

    broadcastConfig();
    broadcastPlaygroundState();
    return result;
  } catch (err) {
    if (playgroundSession.config) playgroundSession.undoStack.pop();
    playgroundSession.status = 'error';
    playgroundSession.error = err.message;
    broadcastPlaygroundState();
    return { success: false, error: err.message };
  }
}

function handlePlaygroundState() {
  return {
    success: true,
    ...playgroundSession,
    config: playgroundSession.config ? structuredClone(playgroundSession.config) : null,
    history: playgroundSession.promptHistory.map((prompt, i) => ({
      prompt,
      index: i,
    })),
  };
}

function handlePlaygroundRestoreVersion(message) {
  const { index } = message;
  if (index == null || index < 0 || index >= playgroundSession.undoStack.length) {
    return { success: false, error: 'Invalid version index' };
  }
  // Push current config so the restore itself is undoable
  if (playgroundSession.config) {
    playgroundSession.undoStack.push(structuredClone(playgroundSession.config));
    playgroundSession.promptHistory.push('(restored version)');
  }
  playgroundSession.config = structuredClone(playgroundSession.undoStack[index]);
  playgroundSession.status = 'idle';
  playgroundSession.error = null;

  broadcastConfig();
  broadcastPlaygroundState();
  return { success: true };
}

function handlePlaygroundUndo() {
  if (playgroundSession.undoStack.length === 0) {
    return { success: false, error: 'Nothing to undo' };
  }

  playgroundSession.config = playgroundSession.undoStack.pop();
  playgroundSession.promptHistory.pop();
  playgroundSession.status = 'idle';
  playgroundSession.error = null;

  broadcastConfig();
  broadcastPlaygroundState();
  return { success: true, config: structuredClone(playgroundSession.config) };
}

async function handlePlaygroundLoadApp(message) {
  const { id } = message;
  if (!id) return { success: false, error: 'App id is required' };

  const result = await handleAfAppLoad({ id });
  if (!result.success) return result;

  playgroundSession.config = structuredClone(result.app.config);
  playgroundSession.appId = result.app.id;
  playgroundSession.appName = result.app.name;
  playgroundSession.undoStack = [];
  playgroundSession.promptHistory = [];
  playgroundSession.status = 'idle';
  playgroundSession.error = null;

  broadcastConfig();
  broadcastPlaygroundState();
  return { success: true, app: result.app };
}

async function handlePlaygroundSave() {
  if (!playgroundSession.config) {
    return { success: false, error: 'No config to save' };
  }

  if (!bridgeClient.isConnected()) {
    return { success: false, error: 'Bridge server not connected' };
  }

  const lastPrompt = playgroundSession.promptHistory[playgroundSession.promptHistory.length - 1] || null;

  // Save to project if bound, otherwise save as flat app
  if (playgroundSession.projectId) {
    try {
      const result = await autoSaveToProject(lastPrompt);
      if (result.success) broadcastPlaygroundState();
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  try {
    const result = await bridgeClient.afAppSave({
      id: playgroundSession.appId || undefined,
      name: playgroundSession.appName || 'Untitled App',
      type: 'generate',
      config: structuredClone(playgroundSession.config),
      prompt: lastPrompt,
    });

    if (result.success && result.app) {
      playgroundSession.appId = result.app.id;
      playgroundSession.appName = result.app.name;
      broadcastPlaygroundState();
    }
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Save current playground config to the bound project (both IndexedDB and bridge disk).
 */
async function autoSaveToProject(prompt) {
  const projId = playgroundSession.projectId;
  if (!projId || !playgroundSession.config) return { success: false, error: 'No project bound' };

  const configClone = structuredClone(playgroundSession.config);

  // Save to IndexedDB
  try {
    await saveProject({
      id: projId,
      name: playgroundSession.projectName,
      description: playgroundSession.projectDescription || '',
      skin: playgroundSession.skin,
      capabilities: playgroundSession.capabilities,
      config: configClone,
      prompt: prompt || null,
    });
  } catch (e) {
    console.warn('[SmartClient AI] Project IndexedDB save failed:', e.message);
  }

  // Save to bridge disk
  if (bridgeClient.isConnected()) {
    try {
      const result = await bridgeClient.afProjectSave({
        id: projId,
        name: playgroundSession.projectName,
        description: playgroundSession.projectDescription || '',
        skin: playgroundSession.skin,
        capabilities: playgroundSession.capabilities,
        config: configClone,
        prompt: prompt || null,
      });
      return result;
    } catch (e) {
      console.warn('[SmartClient AI] Project bridge save failed:', e.message);
    }
  }

  return { success: true };
}

function handlePlaygroundSetSkin(message) {
  const { skin } = message;
  if (!skin) return { success: false, error: 'skin is required' };
  playgroundSession.skin = skin;
  chrome.runtime.sendMessage({
    type: 'AUTO_BROADCAST_SC_SKIN',
    skin,
  }).catch(() => {});
  broadcastPlaygroundState();
  return { success: true, skin };
}

function handlePlaygroundSetCapabilities(message) {
  const caps = message.capabilities || {};
  Object.assign(playgroundSession.capabilities, caps);
  broadcastConfig();
  broadcastPlaygroundState();
  return { success: true, capabilities: playgroundSession.capabilities };
}

function handlePlaygroundReset() {
  playgroundSession = {
    config: null, appId: null, appName: null,
    projectId: null, projectName: null, projectDescription: null,
    promptHistory: [], undoStack: [],
    status: 'idle', error: null,
    capabilities: { skinPicker: true },
    skin: 'Tahoe',
    model: 'sonnet',
    mode: 'render',
    templatePrompt: null,
  };
  broadcastConfig();
  broadcastPlaygroundState();
  return { success: true };
}

// ---- Project-bound playground handlers ----

async function handlePlaygroundCreateProject(message) {
  const { name, description, skin, capabilities } = message;
  if (!name || !name.trim()) {
    return { success: false, error: 'Project name is required' };
  }

  try {
    // Save to IndexedDB
    const project = await saveProject({
      name: name.trim(),
      description: (description || '').trim(),
      skin: skin || 'Tahoe',
      capabilities: capabilities || { skinPicker: true },
      config: null,
      prompt: null,
    });

    // Save to bridge disk (non-fatal)
    if (bridgeClient.isConnected()) {
      try {
        await bridgeClient.afProjectSave({
          id: project.id,
          name: project.name,
          description: project.description || '',
          skin: project.skin || 'Tahoe',
          capabilities: project.capabilities || {},
        });
      } catch (e) {
        console.warn('[SmartClient AI] Project bridge save failed:', e.message);
      }
    }

    // Bind playground to new project
    playgroundSession.projectId = project.id;
    playgroundSession.projectName = project.name;
    playgroundSession.projectDescription = project.description || null;
    playgroundSession.config = null;
    playgroundSession.appId = null;
    playgroundSession.appName = null;
    playgroundSession.undoStack = [];
    playgroundSession.promptHistory = [];
    playgroundSession.status = 'idle';
    playgroundSession.error = null;
    playgroundSession.skin = project.skin || 'Tahoe';
    playgroundSession.capabilities = project.capabilities || { skinPicker: true };

    broadcastPlaygroundState();
    return { success: true, project };
  } catch (err) {
    console.error('[SmartClient AI] Create project failed:', err);
    return { success: false, error: err.message };
  }
}

async function handlePlaygroundLoadProject(message) {
  const { id } = message;
  if (!id) return { success: false, error: 'Project id is required' };

  // Try bridge first (has history), fall back to IndexedDB
  let project = null;
  if (bridgeClient.isConnected()) {
    try {
      const result = await bridgeClient.afProjectLoad(id);
      if (result.success) project = result.project;
    } catch (e) {
      console.warn('[SmartClient AI] Bridge project load failed, trying IndexedDB:', e.message);
    }
  }

  if (!project) {
    try {
      project = await loadProject(id);
    } catch {
      // Fall through
    }
  }

  if (!project) return { success: false, error: `Project not found: ${id}` };

  // Bind playground to project
  playgroundSession.projectId = project.id;
  playgroundSession.projectName = project.name;
  playgroundSession.projectDescription = project.description || null;
  playgroundSession.config = project.config ? structuredClone(project.config) : null;
  playgroundSession.appId = null;
  playgroundSession.appName = null;
  // Restore undo history from disk (bridge projects have history[] with config snapshots)
  const history = project.history || [];
  playgroundSession.undoStack = history.map(h => structuredClone(h.config));
  playgroundSession.promptHistory = history.map(h => h.prompt || '');
  playgroundSession.status = 'idle';
  playgroundSession.error = null;
  playgroundSession.skin = project.skin || 'Tahoe';
  playgroundSession.capabilities = project.capabilities || { skinPicker: true };

  if (project.config) broadcastConfig();
  broadcastPlaygroundState();
  return { success: true, project };
}

async function handlePromoteAppToProject(message) {
  const { appId } = message;
  if (!appId) return { success: false, error: 'appId is required' };

  // Load the app
  let app = null;
  if (bridgeClient.isConnected()) {
    try {
      const result = await bridgeClient.afAppLoad(appId);
      if (result.success) app = result.app;
    } catch { /* fall through */ }
  }
  if (!app) return { success: false, error: `App not found: ${appId}` };

  // Create a new project from the app data
  try {
    const project = await saveProject({
      name: app.name || 'Promoted App',
      description: '',
      skin: 'Tahoe',
      capabilities: { skinPicker: true },
      config: app.config || null,
      prompt: app.prompt || null,
    });

    // Save to bridge disk
    if (bridgeClient.isConnected()) {
      try {
        await bridgeClient.afProjectSave({
          id: project.id,
          name: project.name,
          description: '',
          config: project.config,
          prompt: project.prompt,
        });
      } catch (e) {
        console.warn('[SmartClient AI] Bridge save for promoted project failed:', e.message);
      }
    }

    return { success: true, project };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ---- Visual edit + mode handlers ----

function handlePlaygroundConfigUpdated(message) {
  const { config } = message;
  if (!config) return { success: false, error: 'config is required' };

  try {
    validateConfig(config);
  } catch (err) {
    return { success: false, error: err.message };
  }

  // Push current config to undo stack
  if (playgroundSession.config) {
    playgroundSession.undoStack.push(structuredClone(playgroundSession.config));
    playgroundSession.promptHistory.push('(visual edit)');
  }

  playgroundSession.config = structuredClone(config);
  playgroundSession.status = 'idle';
  playgroundSession.error = null;

  // Accept plugin metadata if provided (from plugin mode loading)
  if (message.pluginId) {
    playgroundSession.pluginId = message.pluginId;
  }
  if (message.projectName) {
    playgroundSession.projectName = message.projectName;
  }
  if (message.projectDescription !== undefined) {
    playgroundSession.projectDescription = message.projectDescription;
  }

  // Auto-save to project if bound
  if (playgroundSession.projectId) {
    autoSaveToProject('(visual edit)').catch(e =>
      console.warn('[SmartClient AI] Visual edit auto-save failed:', e.message));
  }

  broadcastPlaygroundState();
  return { success: true };
}

function handlePlaygroundSetMode(message) {
  const { mode } = message;
  if (!mode || !['render', 'visual'].includes(mode)) {
    return { success: false, error: 'mode must be render or visual' };
  }
  playgroundSession.mode = mode;
  chrome.runtime.sendMessage({
    type: 'AUTO_BROADCAST_SC_MODE',
    mode,
  }).catch(() => {});
  broadcastPlaygroundState();
  return { success: true, mode };
}

function handlePlaygroundSetTemplate(message) {
  const { templatePrompt } = message;
  playgroundSession.templatePrompt = templatePrompt || null;
  broadcastPlaygroundState();
  return { success: true };
}

// ---- Template persistence (bridge-backed) ----

async function handleTemplateSave(message) {
  if (!bridgeClient.isConnected()) {
    return { success: false, error: 'Bridge server not connected' };
  }
  try {
    return await bridgeClient.afTemplateSave({
      id: message.id,
      name: message.name,
      description: message.description || '',
      category: message.category || 'Custom',
      config: message.config,
      aiSystemPrompt: message.aiSystemPrompt || '',
      suggestedPrompts: message.suggestedPrompts || [],
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleTemplateList() {
  if (!bridgeClient.isConnected()) {
    return { success: true, templates: [] };
  }
  try {
    return await bridgeClient.afTemplateList();
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleTemplateDelete(message) {
  if (!bridgeClient.isConnected()) {
    return { success: false, error: 'Bridge server not connected' };
  }
  try {
    return await bridgeClient.afTemplateDelete(message.id);
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export function register(handlers) {
  handlers['SC_GENERATE_UI'] = (msg) => handleGenerateUI(msg);
  handlers['SC_CLONE_PAGE'] = (msg) => handleClonePage(msg);

  // Bridge-backed persistence (Phase 5b) — parallel to IndexedDB SC_APP_* handlers
  handlers['AF_APP_SAVE'] = (msg) => handleAfAppSave(msg);
  handlers['AF_APP_LOAD'] = (msg) => handleAfAppLoad(msg);
  handlers['AF_APP_LIST'] = () => handleAfAppList();
  handlers['AF_APP_DELETE'] = (msg) => handleAfAppDelete(msg);

  // Playground session (sidepanel controller)
  handlers['SC_PLAYGROUND_GENERATE'] = (msg) => handlePlaygroundGenerate(msg);
  handlers['SC_PLAYGROUND_STATE'] = () => handlePlaygroundState();
  handlers['SC_PLAYGROUND_UNDO'] = () => handlePlaygroundUndo();
  handlers['SC_PLAYGROUND_LOAD_APP'] = (msg) => handlePlaygroundLoadApp(msg);
  handlers['SC_PLAYGROUND_SAVE'] = () => handlePlaygroundSave();
  handlers['SC_PLAYGROUND_RESET'] = () => handlePlaygroundReset();
  handlers['SC_PLAYGROUND_SET_SKIN'] = (msg) => handlePlaygroundSetSkin(msg);
  handlers['SC_PLAYGROUND_SET_CAPABILITIES'] = (msg) => handlePlaygroundSetCapabilities(msg);
  handlers['SC_PLAYGROUND_SET_MODEL'] = (msg) => {
    const model = msg.model;
    if (model && ['haiku', 'sonnet', 'opus'].includes(model)) {
      playgroundSession.model = model;
      broadcastPlaygroundState();
    }
    return { success: true };
  };

  // Project-bound playground
  handlers['SC_PLAYGROUND_CREATE_PROJECT'] = (msg) => handlePlaygroundCreateProject(msg);
  handlers['SC_PLAYGROUND_LOAD_PROJECT'] = (msg) => handlePlaygroundLoadProject(msg);
  handlers['SC_PLAYGROUND_RESTORE_VERSION'] = (msg) => handlePlaygroundRestoreVersion(msg);
  handlers['SC_PROMOTE_APP_TO_PROJECT'] = (msg) => handlePromoteAppToProject(msg);

  // Visual edit + inspector mode
  handlers['SC_PLAYGROUND_CONFIG_UPDATED'] = (msg) => handlePlaygroundConfigUpdated(msg);
  handlers['SC_PLAYGROUND_SET_MODE'] = (msg) => handlePlaygroundSetMode(msg);
  handlers['SC_PLAYGROUND_SET_TEMPLATE'] = (msg) => handlePlaygroundSetTemplate(msg);

  // Template CRUD
  handlers['SC_TEMPLATE_SAVE'] = (msg) => handleTemplateSave(msg);
  handlers['SC_TEMPLATE_LIST'] = () => handleTemplateList();
  handlers['SC_TEMPLATE_DELETE'] = (msg) => handleTemplateDelete(msg);

  // Bridge-backed project persistence (routed through bridge)
  handlers['AF_PROJECT_SAVE'] = (msg) => handleAfProjectSave(msg);
  handlers['AF_PROJECT_LOAD'] = (msg) => handleAfProjectLoad(msg);
  handlers['AF_PROJECT_LIST'] = () => handleAfProjectList();
  handlers['AF_PROJECT_DELETE'] = (msg) => handleAfProjectDelete(msg);
}
