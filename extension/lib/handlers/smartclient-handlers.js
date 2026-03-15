/**
 * SmartClient AI handlers — generate UI configs from natural language prompts.
 * Routes requests through the bridge server, which spawns a fresh `claude -p`
 * subprocess to generate SmartClient JSON configs that renderer.js instantiates.
 */
import * as bridgeClient from '../bridge-client.js';
import { saveApp } from './app-persistence.js';

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
  const { prompt } = message;
  if (!prompt || !prompt.trim()) {
    return { success: false, error: 'Prompt is required' };
  }

  if (!bridgeClient.isConnected()) {
    return { success: false, error: 'Bridge server not connected' };
  }

  try {
    console.log('[SmartClient AI] Generating UI via bridge for:', prompt);
    const result = await bridgeClient.generateSmartClientUI(prompt);

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

export function register(handlers) {
  handlers['SC_GENERATE_UI'] = (msg) => handleGenerateUI(msg);
  handlers['SC_CLONE_PAGE'] = (msg) => handleClonePage(msg);
}
