/**
 * Web Worker for LLM (Text Generation)
 *
 * Runs transformers.js text generation in a separate Web Worker thread.
 * Supports TinyLlama-1.1B-Chat-v1.0 (default), instruction-tuned for chat and Q&A.
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
        const modelName = data?.model || 'Xenova/TinyLlama-1.1B-Chat-v1.0';
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
 * @param {string} modelName - Model identifier (e.g., distilgpt2, gpt2, gpt2-medium)
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

    // Disable multi-threading to avoid blob: workers (Chrome extension CSP restriction)
    env.backends.onnx.wasm.numThreads = 1;

    // Suppress ONNX Runtime warnings (model optimization messages)
    env.backends.onnx.logLevel = 'error';

    pipeline = pipelineFunc;

    console.log(`[LLM Worker] Loading ${modelName}...`);
    console.log('[LLM Worker] This may take 2-5 minutes on first run (~1GB download)');
    console.log('[LLM Worker] Download progress not shown - please wait for completion message');

    // Load the text generation model (use defaults for maximum compatibility)
    generator = await pipeline(
      'text-generation',
      modelName
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
  console.log(`[LLM Worker] Prompt length: ${prompt.length} chars`);
  console.log(`[LLM Worker] Prompt preview:`, prompt.substring(0, 200));

  // Generate text
  const startTime = Date.now();
  let result;

  try {
    result = await generator(prompt, {
      max_new_tokens,
      temperature,
      do_sample,
      top_p
    });
  } catch (error) {
    console.error(`[LLM Worker] Generation failed:`, error);
    console.error(`[LLM Worker] Error message:`, error.message);
    console.error(`[LLM Worker] Error stack:`, error.stack);
    throw error;
  }

  const elapsed = Date.now() - startTime;
  console.log(`[LLM Worker] Generated in ${elapsed}ms`);

  // Log result structure for debugging
  console.log(`[LLM Worker] Result structure:`, {
    isArray: Array.isArray(result),
    length: result?.length,
    hasGeneratedText: result?.[0]?.generated_text !== undefined,
    firstKey: result?.[0] ? Object.keys(result[0])[0] : null
  });

  // Extract generated text (handle different response formats)
  let generatedText;

  if (Array.isArray(result) && result[0]?.generated_text) {
    generatedText = result[0].generated_text;
  } else if (result?.generated_text) {
    generatedText = result.generated_text;
  } else if (typeof result === 'string') {
    generatedText = result;
  } else {
    console.error('[LLM Worker] Unexpected result format:', result);
    throw new Error('Unexpected LLM response format');
  }

  console.log(`[LLM Worker] Generated text length: ${generatedText?.length || 0}`);
  console.log(`[LLM Worker] Prompt length: ${prompt.length}`);
  console.log(`[LLM Worker] Generated text preview:`, generatedText?.substring(0, 200));

  // Try to extract only the new text (after the prompt)
  let output = generatedText;
  if (generatedText && generatedText.length > prompt.length && generatedText.startsWith(prompt)) {
    output = generatedText.slice(prompt.length).trim();
    console.log(`[LLM Worker] Removed prompt, output length: ${output.length}`);
  } else {
    console.log(`[LLM Worker] Using full generated text as output`);
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
