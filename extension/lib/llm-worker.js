/**
 * Web Worker for LLM (Text Generation)
 *
 * Runs transformers.js text generation in a separate Web Worker thread.
 * Supports Phi-3-mini and Gemma-2B models for local Q&A.
 */

let pipeline = null;
let generator = null;
let currentModel = null;

// Listen for messages from the offscreen document
self.addEventListener('message', async (event) => {
  const { type, data, id } = event.data;

  try {
    switch (type) {
      case 'INIT':
        const modelName = data?.model || 'Xenova/Phi-3-mini-4k-instruct';
        const success = await initLLM(modelName);
        self.postMessage({ type: 'INIT_RESPONSE', success, model: currentModel, id });
        break;

      case 'GENERATE':
        const output = await generateText(data.prompt, data.options);
        const tokensUsed = estimateTokens(data.prompt) + estimateTokens(output);
        self.postMessage({
          type: 'GENERATE_RESPONSE',
          text: output,
          tokensUsed,
          id
        });
        break;

      case 'ESTIMATE_TOKENS':
        const tokens = estimateTokens(data.text);
        self.postMessage({ type: 'ESTIMATE_RESPONSE', tokens, id });
        break;

      default:
        self.postMessage({
          type: 'ERROR',
          error: `Unknown message type: ${type}`,
          id
        });
    }
  } catch (error) {
    console.error('[LLM Worker] Error:', error);
    self.postMessage({
      type: 'ERROR',
      error: error.message,
      id
    });
  }
});

/**
 * Initialize the LLM model
 * @param {string} modelName - Model identifier (Phi-3-mini or Gemma-2B)
 */
async function initLLM(modelName) {
  if (generator && currentModel === modelName) {
    console.log('[LLM Worker] Model already loaded:', currentModel);
    return true;
  }

  try {
    console.log('[LLM Worker] Initializing transformers.js...');

    // Import transformers.js from local bundle
    const transformersUrl = self.location.origin + '/lib/transformers/transformers.js';
    console.log('[LLM Worker] Loading from:', transformersUrl);
    const { pipeline: pipelineFunc, env } = await import(transformersUrl);

    // Configure transformers.js
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = true;

    pipeline = pipelineFunc;

    console.log(`[LLM Worker] Loading ${modelName}...`);
    console.log('[LLM Worker] This may take 1-2 minutes on first run (~1.5GB download)');

    // Load the text generation model
    generator = await pipeline(
      'text-generation',
      modelName,
      {
        dtype: 'q4',         // 4-bit quantization for smaller size
        device: 'wasm'       // WASM backend
      }
    );

    currentModel = modelName;
    console.log('[LLM Worker] Model loaded successfully:', currentModel);
    return true;

  } catch (error) {
    console.error('[LLM Worker] Failed to initialize:', error);
    return false;
  }
}

/**
 * Generate text using the LLM
 * @param {string} prompt - Input prompt
 * @param {object} options - Generation options
 */
async function generateText(prompt, options = {}) {
  if (!generator) {
    throw new Error('LLM not initialized');
  }

  const {
    max_new_tokens = 256,
    temperature = 0.3,
    do_sample = false,
    top_p = 0.9
  } = options;

  console.log(`[LLM Worker] Generating (max ${max_new_tokens} tokens)...`);

  // Generate text
  const startTime = Date.now();
  const result = await generator(prompt, {
    max_new_tokens,
    temperature,
    do_sample,
    top_p
  });

  const elapsed = Date.now() - startTime;
  console.log(`[LLM Worker] Generated in ${elapsed}ms`);

  // Extract generated text (remove input prompt)
  const generatedText = result[0].generated_text;

  // Try to extract only the new text (after the prompt)
  let output = generatedText;
  if (generatedText.startsWith(prompt)) {
    output = generatedText.slice(prompt.length).trim();
  }

  return output;
}

/**
 * Estimate token count for text
 * Simple heuristic: 1 token ≈ 4 characters
 * @param {string} text - Input text
 * @returns {number} Estimated token count
 */
function estimateTokens(text) {
  if (!text) return 0;

  // Simple heuristic: ~1 token per 4 characters
  // This is conservative for Phi-3/Gemma tokenizers
  return Math.ceil(text.length / 4);
}

console.log('[LLM Worker] Ready for text generation');
