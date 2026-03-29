/**
 * SmartClient AI handlers — generate UI configs from natural language prompts.
 * Routes requests through the bridge server, which spawns a fresh `claude -p`
 * subprocess to generate SmartClient JSON configs that renderer.js instantiates.
 */
import * as bridgeClient from '../bridge-client.js';
import { saveApp } from './app-persistence.js';

// ---- Playground session state (sidepanel controller) ----
let playgroundSession = {
  config: null,
  appId: null,
  appName: null,
  promptHistory: [],
  undoStack: [],
  status: 'idle',   // idle | generating | error
  error: null,
  capabilities: { skinPicker: true },
  skin: 'Tahoe',
};

function broadcastPlaygroundState() {
  const msg = {
    type: 'AUTO_BROADCAST_SC_PLAYGROUND',
    status: playgroundSession.status,
    appName: playgroundSession.appName,
    appId: playgroundSession.appId,
    hasConfig: !!playgroundSession.config,
    promptCount: playgroundSession.promptHistory.length,
    undoCount: playgroundSession.undoStack.length,
    error: playgroundSession.error,
    capabilities: playgroundSession.capabilities,
    skin: playgroundSession.skin,
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
  const { prompt, currentConfig } = message;
  if (!prompt || !prompt.trim()) {
    return { success: false, error: 'Prompt is required' };
  }

  if (!bridgeClient.isConnected()) {
    return { success: false, error: 'Bridge server not connected' };
  }

  try {
    const mode = currentConfig ? 'modify' : 'generate';
    console.log(`[SmartClient AI] ${mode} UI via bridge for:`, prompt);
    const result = await bridgeClient.generateSmartClientUI(prompt, currentConfig);

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
  };
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

  try {
    const result = await bridgeClient.afAppSave({
      id: playgroundSession.appId || undefined,
      name: playgroundSession.appName || 'Untitled App',
      type: 'generate',
      config: structuredClone(playgroundSession.config),
      prompt: playgroundSession.promptHistory[playgroundSession.promptHistory.length - 1] || null,
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
    promptHistory: [], undoStack: [],
    status: 'idle', error: null,
    capabilities: { skinPicker: true },
    skin: 'Tahoe',
  };
  broadcastConfig();
  broadcastPlaygroundState();
  return { success: true };
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
}
