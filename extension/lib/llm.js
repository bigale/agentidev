/**
 * LLM Module using transformers.js
 *
 * Generates text responses using distilGPT-2 (default) or other supported models.
 * Runs locally in the browser (no API calls).
 *
 * Uses Offscreen Document API to create Web Workers (Service Workers can't create Workers directly)
 */

let initialized = false;
let initPromise = null;
let currentModel = null;
let offscreenCreated = false;

/**
 * Create offscreen document if needed
 * Shared offscreen document (should already exist from embeddings)
 */
async function setupOffscreenDocument() {
  // Check if offscreen document already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen.html')]
  });

  if (existingContexts.length > 0) {
    offscreenCreated = true;
    console.log('[LLM] Using existing offscreen document');
    return;
  }

  // Create offscreen document (fallback if embeddings didn't create it)
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: ['WORKERS'],
    justification: 'Run transformers.js in Web Workers for embeddings and LLM'
  });

  offscreenCreated = true;
  console.log('[LLM] Offscreen document created (offscreen.html)');
}

/**
 * Initialize the LLM model
 * @param {string} modelName - Optional model name (defaults to distilgpt2)
 * Supported models:
 * - Xenova/distilgpt2 (default, ~300MB, most reliable in browsers)
 * - Xenova/gpt2 (~500MB, more capable but heavier)
 * - Xenova/gpt2-medium (~1.5GB, best quality but slowest)
 */
export async function initLLM(modelName = 'Xenova/distilgpt2') {
  // If already initializing, return the same promise
  if (initPromise) {
    return initPromise;
  }

  // If already initialized with the same model, return immediately
  if (initialized && currentModel === modelName) {
    return true;
  }

  initPromise = (async () => {
    try {
      console.log('[LLM] Setting up offscreen document...');

      // Create offscreen document (can create Web Workers)
      await setupOffscreenDocument();

      console.log('[LLM] Initializing model:', modelName);
      console.log('[LLM] First load will download ~300MB model files...');
      console.log('[LLM] This may take 20-40 seconds. Please wait...');

      const response = await chrome.runtime.sendMessage({
        type: 'LLM_INIT',
        model: modelName
      });

      if (!response) {
        console.error('[LLM] No response from offscreen document');
        initPromise = null;
        return false;
      }

      if (response.success) {
        initialized = true;
        currentModel = response.model;
        console.log('[LLM] Model loaded successfully:', currentModel);
      } else {
        console.error('[LLM] Model initialization failed:', response.error);
      }

      initPromise = null;
      return response.success;
    } catch (error) {
      console.error('[LLM] Failed to initialize:', error);
      initPromise = null;
      return false;
    }
  })();

  return initPromise;
}

/**
 * Generate text answer using the LLM
 * @param {string} prompt - Input prompt
 * @param {object} options - Generation options
 * @returns {Promise<string>} Generated text
 */
export async function generateAnswer(prompt, options = {}) {
  if (!initialized) {
    // Auto-initialize if needed
    const success = await initLLM();
    if (!success) {
      throw new Error('Failed to initialize LLM model');
    }
  }

  try {
    const {
      max_tokens = 256,
      temperature = 0.3,
      do_sample = false,
      top_p = 0.9
    } = options;

    const response = await chrome.runtime.sendMessage({
      type: 'LLM_GENERATE',
      prompt: prompt,
      options: {
        max_new_tokens: max_tokens,
        temperature,
        do_sample,
        top_p
      }
    });

    if (response.error) {
      throw new Error(response.error);
    }

    return response.text;
  } catch (error) {
    console.error('[LLM] Failed to generate text:', error);
    throw error;
  }
}

/**
 * Estimate token count for text
 * @param {string} text - Input text
 * @returns {Promise<number>} Estimated token count
 */
export async function estimateTokens(text) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'LLM_ESTIMATE_TOKENS',
      text: text
    });

    if (response.error) {
      // Fallback to simple estimation if worker fails
      return Math.ceil((text || '').length / 4);
    }

    return response.tokens;
  } catch (error) {
    console.error('[LLM] Failed to estimate tokens:', error);
    // Fallback: 1 token ≈ 4 characters
    return Math.ceil((text || '').length / 4);
  }
}

/**
 * Check if LLM is initialized
 */
export function isInitialized() {
  return initialized;
}

/**
 * Get current model name
 */
export function getCurrentModel() {
  return currentModel;
}
