/**
 * LLM Module using transformers.js
 *
 * Generates text responses using Phi-3-mini or Gemma-2B models.
 * Runs locally in the browser (no API calls).
 *
 * Uses Offscreen Document API to create Web Workers (Service Workers can't create Workers directly)
 */

let initialized = false;
let initPromise = null;
let currentModel = null;

/**
 * Offscreen document is shared with embeddings module
 * No need to create a new one - it's already created by embeddings.js
 */

/**
 * Initialize the LLM model
 * @param {string} modelName - Optional model name (defaults to Phi-3-mini)
 */
export async function initLLM(modelName = 'Xenova/Phi-3-mini-4k-instruct') {
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
      console.log('[LLM] Initializing model:', modelName);
      console.log('[LLM] First load will download ~1.5GB model files...');
      console.log('[LLM] This may take 1-2 minutes. Please wait...');

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
