/**
 * WebLLM provider for pi-ai — runs LLM inference entirely in the browser via WebGPU.
 *
 * This wraps @mlc-ai/web-llm's MLCEngine to produce the same streaming event
 * interface that pi-ai's Agent expects. The engine runs directly in the
 * sidepanel document (which has WebGPU access).
 *
 * Models: Phi-3 Mini 3.8B q4 (~2GB download, cached in browser Cache API),
 *         Llama 3.2 3B, SmolLM2 1.7B, Qwen2.5 1.5B/3B/7B, etc.
 *
 * First load downloads the model weights (~500MB-4GB). Subsequent loads
 * from cache take 5-15 seconds.
 */

let _engine = null;
let _engineModelId = null;
let _initPromise = null;
let _webllmModule = null;

// Recommended models (balance quality vs size vs speed)
export const WEBLLM_MODELS = {
  'phi-3-mini':     'Phi-3-mini-4k-instruct-q4f16_1-MLC',
  'llama-3.2-3b':   'Llama-3.2-3B-Instruct-q4f16_1-MLC',
  'llama-3.2-1b':   'Llama-3.2-1B-Instruct-q4f16_1-MLC',
  'smollm2-1.7b':   'SmolLM2-1.7B-Instruct-q4f16_1-MLC',
  'qwen2.5-1.5b':   'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
};

export const DEFAULT_MODEL = 'phi-3-mini';

/**
 * Check if WebGPU is available in this context.
 */
export function isWebGPUAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

/**
 * Initialize the WebLLM engine with a specific model.
 * Downloads model on first use (~500MB-4GB), cached after.
 *
 * @param {string} modelAlias - Key from WEBLLM_MODELS or a full MLC model ID
 * @param {function} [onProgress] - Progress callback (progress: {text, progress})
 * @returns {Promise<object>} The MLCEngine instance
 */
export async function initWebLLM(modelAlias = DEFAULT_MODEL, onProgress = null) {
  if (!isWebGPUAvailable()) {
    throw new Error('WebGPU not available in this browser/context');
  }

  const modelId = WEBLLM_MODELS[modelAlias] || modelAlias;

  // Return cached engine if same model
  if (_engine && _engineModelId === modelId) return _engine;

  // Prevent concurrent init
  if (_initPromise && _engineModelId === modelId) return _initPromise;

  _initPromise = (async () => {
    // Lazy import WebLLM
    if (!_webllmModule) {
      _webllmModule = await import('../../lib/vendor/web-llm/index.js');
    }

    console.log('[WebLLM] Initializing', modelId, '...');
    const t0 = performance.now();

    _engine = await _webllmModule.CreateMLCEngine(modelId, {
      initProgressCallback: (report) => {
        console.log('[WebLLM] Init:', report.text);
        if (onProgress) onProgress(report);
      },
    });

    _engineModelId = modelId;
    console.log('[WebLLM] Ready in', ((performance.now() - t0) / 1000).toFixed(1) + 's');
    return _engine;
  })();

  return _initPromise;
}

/**
 * Create a pi-ai compatible model object that routes through WebLLM.
 *
 * This returns an object with the same shape pi-ai expects from getModel(),
 * allowing the Agent to use WebLLM transparently. The key trick: we override
 * the streaming function to call WebLLM's engine directly instead of fetch().
 *
 * @param {string} [modelAlias] - Model to use (default: phi-3-mini)
 * @param {function} [onProgress] - Download progress callback
 * @returns {object} pi-ai compatible model descriptor
 */
export function createWebLLMModel(modelAlias = DEFAULT_MODEL, onProgress = null) {
  const modelId = WEBLLM_MODELS[modelAlias] || modelAlias;

  // Return a model descriptor that pi-ai's agent loop can use.
  // The actual streaming is handled by our custom streamFn.
  return {
    api: 'webllm-local',
    id: modelId,
    displayName: modelAlias,
    contextWindow: 4096,
    maxTokens: 2048,

    // pi-ai calls this to get the streaming function.
    // We provide a custom one that goes through WebLLM.
    _webllmAlias: modelAlias,
    _webllmOnProgress: onProgress,
  };
}

/**
 * Stream a chat completion through WebLLM.
 * This is called by our custom agent wrapper instead of pi-ai's built-in streaming.
 *
 * @param {object[]} messages - OpenAI-format messages [{role, content}]
 * @param {object[]} [tools] - Tool definitions (OpenAI format)
 * @param {object} [options] - temperature, max_tokens, etc.
 * @returns {AsyncGenerator<object>} Yields OpenAI-format SSE chunks
 */
export async function* streamWebLLMCompletion(messages, tools = [], options = {}) {
  const engine = await initWebLLM(options._webllmAlias || DEFAULT_MODEL, options._webllmOnProgress);

  const requestBody = {
    messages,
    temperature: options.temperature || 0.7,
    max_tokens: options.max_tokens || 2048,
    stream: true,
  };

  // WebLLM supports tool calling for some models
  if (tools && tools.length > 0) {
    requestBody.tools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  const stream = await engine.chat.completions.create(requestBody);

  // WebLLM returns an AsyncIterable of OpenAI-format chunks
  for await (const chunk of stream) {
    yield chunk;
  }
}

/**
 * Non-streaming completion (for simple one-shot calls).
 */
export async function completeWebLLM(messages, options = {}) {
  const engine = await initWebLLM(options._webllmAlias || DEFAULT_MODEL);

  return engine.chat.completions.create({
    messages,
    temperature: options.temperature || 0.7,
    max_tokens: options.max_tokens || 2048,
    stream: false,
  });
}

/**
 * Get engine stats (tokens/sec, memory usage, etc.)
 */
export async function getWebLLMStats() {
  if (!_engine) return null;
  try {
    return await _engine.runtimeStatsText();
  } catch {
    return null;
  }
}

/**
 * Unload the model to free GPU memory.
 */
export async function unloadWebLLM() {
  if (_engine) {
    try { await _engine.unload(); } catch {}
    _engine = null;
    _engineModelId = null;
    _initPromise = null;
  }
}
