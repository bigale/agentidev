/**
 * pi-ai provider configuration for agentidev.
 *
 * Detects available LLM providers and returns the best available model.
 * Priority: Ollama (local) → stored API key (cloud) → prompt user.
 *
 * All providers route through the openai-completions API, which is the
 * most portable (Ollama, LM Studio, OpenAI, and any compatible endpoint).
 *
 * Runs in the sidepanel document (not the service worker).
 */

import { isWebGPUAvailable, createWebLLMModel, WEBLLM_MODELS, DEFAULT_MODEL as WEBLLM_DEFAULT } from './webllm-provider.js';

// Dynamic import to support lazy loading in the extension context
let _getModel = null;
let _cachedModel = null;
let _providerStatus = null; // { provider, model, baseUrl, ready }
let _isWebLLM = false; // true if using in-browser WebLLM

const OLLAMA_BASE = 'http://localhost:11434/v1';
const OLLAMA_TAG_API = 'http://localhost:11434/api/tags';
const STORAGE_KEY = 'agentidev_llm_config';

// Default models per provider
const DEFAULTS = {
  ollama: 'llama3.2:3b',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-20250514',
};

/**
 * Check if Ollama is running locally.
 * @returns {Promise<{available: boolean, models: string[]}>}
 */
async function detectOllama() {
  try {
    const resp = await fetch(OLLAMA_TAG_API, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return { available: false, models: [] };
    const data = await resp.json();
    const models = (data.models || []).map(m => m.name);
    return { available: true, models };
  } catch {
    return { available: false, models: [] };
  }
}

/**
 * Load saved LLM config from chrome.storage.local.
 * @returns {Promise<{provider?: string, model?: string, apiKey?: string, baseUrl?: string}>}
 */
async function loadConfig() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return result[STORAGE_KEY] || {};
  } catch {
    return {};
  }
}

/**
 * Save LLM config to chrome.storage.local.
 */
async function saveConfig(config) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: config });
  } catch (e) {
    console.warn('[AgentProvider] Failed to save config:', e.message);
  }
}

/**
 * Get the pi-ai getModel function (lazy import).
 */
async function ensureGetModel() {
  if (_getModel) return _getModel;
  const mod = await import('../../lib/vendor/pi-bundle.js');
  _getModel = mod.getModel;
  return _getModel;
}

/**
 * Initialize the LLM provider. Returns the configured model and status.
 *
 * @param {object} [overrides] - Optional overrides for provider/model/apiKey/baseUrl
 * @returns {Promise<{model: object, status: object}>}
 */
export async function initProvider(overrides = {}) {
  const getModelFn = await ensureGetModel();
  const saved = await loadConfig();
  const config = { ...saved, ...overrides };

  // Priority 1: Ollama (local, no API key needed)
  if (!config.provider || config.provider === 'ollama') {
    const ollama = await detectOllama();
    if (ollama.available) {
      const modelName = config.model || DEFAULTS.ollama;
      const hasModel = ollama.models.some(m => m === modelName || m.startsWith(modelName.split(':')[0]));
      const actualModel = hasModel ? modelName : (ollama.models[0] || DEFAULTS.ollama);

      // Create model object directly — getModel() is a registry lookup that
      // only works for pre-registered models, not custom Ollama ones.
      // apiKey: 'ollama' is a dummy — Ollama doesn't validate keys but
      // pi-ai checks for one before making the request.
      _cachedModel = {
        id: actualModel,
        name: actualModel,
        api: 'openai-completions',
        provider: 'ollama',
        baseUrl: OLLAMA_BASE,
        apiKey: 'ollama',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 2048,
      };
      _providerStatus = {
        provider: 'ollama',
        model: actualModel,
        baseUrl: OLLAMA_BASE,
        ready: true,
        availableModels: ollama.models,
      };
      await saveConfig({ provider: 'ollama', model: actualModel });
      console.log('[AgentProvider] Using Ollama:', actualModel);
      return { model: _cachedModel, status: _providerStatus };
    }
  }

  // Priority 2: WebLLM (in-browser via WebGPU, no server needed)
  if ((!config.provider || config.provider === 'webllm') && isWebGPUAvailable()) {
    const modelAlias = config.model || WEBLLM_DEFAULT;
    _cachedModel = createWebLLMModel(modelAlias);
    _isWebLLM = true;
    _providerStatus = {
      provider: 'webllm',
      model: modelAlias,
      baseUrl: 'in-browser (WebGPU)',
      ready: true,
      availableModels: Object.keys(WEBLLM_MODELS),
      note: 'First use downloads model weights (~500MB-4GB). Cached after.',
    };
    await saveConfig({ provider: 'webllm', model: modelAlias });
    console.log('[AgentProvider] Using WebLLM:', modelAlias);
    return { model: _cachedModel, status: _providerStatus };
  }

  // Priority 3: OpenAI-compatible with API key
  if (config.apiKey) {
    const provider = config.provider || 'openai';
    const modelName = config.model || DEFAULTS[provider] || DEFAULTS.openai;
    const api = provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
    const baseUrl = config.baseUrl || (provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com');

    // Try getModel for known models first, fall back to manual object
    _cachedModel = getModelFn(provider, modelName);
    if (!_cachedModel) {
      _cachedModel = {
        id: modelName,
        name: modelName,
        api,
        provider,
        baseUrl,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
        headers: provider === 'anthropic'
          ? { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' }
          : { 'Authorization': 'Bearer ' + config.apiKey },
      };
    }
    _providerStatus = {
      provider,
      model: modelName,
      baseUrl,
      ready: true,
    };
    console.log('[AgentProvider] Using', provider + ':', modelName);
    return { model: _cachedModel, status: _providerStatus };
  }

  // Priority 4: No provider available
  _providerStatus = { provider: null, model: null, ready: false };
  console.warn('[AgentProvider] No LLM provider available. Options: Ollama (local), WebLLM (in-browser, needs WebGPU), or API key.');
  return { model: null, status: _providerStatus };
}

/**
 * Get the current model (must call initProvider first).
 */
export function getModel() {
  return _cachedModel;
}

/**
 * Get the current provider status.
 */
export function getProviderStatus() {
  return _providerStatus;
}

/**
 * Check if the current provider is WebLLM (in-browser).
 */
export function isUsingWebLLM() {
  return _isWebLLM;
}

/**
 * Update provider configuration and re-initialize.
 * Also resets the agent if one exists (forces re-creation with new model).
 */
export async function setProviderConfig(config) {
  await saveConfig(config);
  _cachedModel = null;
  _isWebLLM = false;
  _providerStatus = null;
  // Signal to agent-setup that the agent needs re-creation
  if (typeof globalThis._resetAgent === 'function') globalThis._resetAgent();
  return initProvider(config);
}
