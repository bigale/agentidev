/**
 * Web Worker for Embeddings
 *
 * Runs transformers.js in a separate Web Worker thread.
 * Service workers can't use dynamic import(), but Web Workers can.
 */

let pipeline = null;
let extractor = null;

// Listen for messages from the service worker
self.addEventListener('message', async (event) => {
  const { type, data, id } = event.data;

  try {
    switch (type) {
      case 'INIT':
        const success = await initEmbeddings();
        self.postMessage({ type: 'INIT_RESPONSE', success, id });
        break;

      case 'GENERATE':
        const embedding = await generateEmbedding(data.text);
        self.postMessage({ type: 'GENERATE_RESPONSE', embedding, id });
        break;

      default:
        self.postMessage({
          type: 'ERROR',
          error: `Unknown message type: ${type}`,
          id
        });
    }
  } catch (error) {
    self.postMessage({
      type: 'ERROR',
      error: error.message,
      id
    });
  }
});

/**
 * Initialize the embedding model
 */
async function initEmbeddings() {
  if (extractor) {
    return true;
  }

  try {
    console.log('[Worker] Initializing transformers.js...');

    // Import transformers.js from local bundle (Chrome extension compatible)
    const transformersUrl = self.location.origin + '/lib/transformers/transformers.js';
    console.log('[Worker] Loading from:', transformersUrl);
    const { pipeline: pipelineFunc, env } = await import(transformersUrl);

    // Configure transformers.js
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = true;

    // Disable multi-threading to avoid blob: workers (Chrome extension CSP restriction)
    env.backends.onnx.wasm.numThreads = 1;

    pipeline = pipelineFunc;

    console.log('[Worker] Loading all-MiniLM-L6-v2 model (384-dim)...');

    // Load the embedding model
    extractor = await pipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2'
    );

    console.log('[Worker] Model loaded successfully');
    return true;
  } catch (error) {
    console.error('[Worker] Failed to initialize:', error);
    return false;
  }
}

/**
 * Generate embedding for a text string
 */
async function generateEmbedding(text) {
  if (!extractor) {
    throw new Error('Model not initialized');
  }

  // Truncate text to reasonable length
  const truncated = text.substring(0, 2000);

  // Generate embedding
  const output = await extractor(truncated, {
    pooling: 'mean',
    normalize: true
  });

  // Convert to regular array
  return Array.from(output.data);
}

console.log('[Worker] Embeddings worker ready');
