/**
 * SmartClient AI handlers — generate UI configs from natural language prompts.
 * Routes requests through the bridge server, which spawns a fresh `claude -p`
 * subprocess to generate SmartClient JSON configs that renderer.js instantiates.
 */
import * as bridgeClient from '../bridge-client.js';

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
    return { success: true, config: result.config };
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
    return { success: true, config: result.config, sources: result.sources };
  } catch (err) {
    console.error('[SmartClient AI] Clone failed:', err);
    return { success: false, error: err.message };
  }
}

export function register(handlers) {
  handlers['SC_GENERATE_UI'] = (msg) => handleGenerateUI(msg);
  handlers['SC_CLONE_PAGE'] = (msg) => handleClonePage(msg);
}
