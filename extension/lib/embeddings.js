/**
 * Embeddings Module using transformers.js
 *
 * Generates semantic embeddings for text using all-MiniLM-L6-v2 model.
 * Runs locally in the browser (no API calls).
 *
 * Note: Uses CDN for transformers.js to avoid bundling complexity
 */

let pipeline = null;
let extractor = null;
let initPromise = null;

/**
 * Initialize the embedding model
 */
export async function initEmbeddings() {
  // If already initializing, return the same promise
  if (initPromise) {
    return initPromise;
  }

  // If already initialized, return immediately
  if (extractor) {
    return true;
  }

  initPromise = (async () => {
    try {
      console.log('[Embeddings] Initializing transformers.js...');

      // Import transformers.js from CDN (works in service workers)
      const { pipeline: pipelineFunc, env } = await import(
        'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2'
      );

      // Configure transformers.js for Chrome extension
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      env.useBrowserCache = true;

      pipeline = pipelineFunc;

      console.log('[Embeddings] Loading all-MiniLM-L6-v2 model (384-dim)...');
      console.log('[Embeddings] First load will download ~50MB model files...');

      // Load the embedding model (all-MiniLM-L6-v2)
      // This model produces 384-dimensional embeddings
      // First load downloads ~50MB, cached afterwards
      extractor = await pipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2'
      );

      console.log('[Embeddings] Model loaded successfully');
      initPromise = null;
      return true;
    } catch (error) {
      console.error('[Embeddings] Failed to initialize:', error);
      initPromise = null;
      return false;
    }
  })();

  return initPromise;
}

/**
 * Generate embedding for a text string
 */
export async function generateEmbedding(text) {
  if (!extractor) {
    // Auto-initialize if needed
    const success = await initEmbeddings();
    if (!success) {
      throw new Error('Failed to initialize embeddings model');
    }
  }

  try {
    // Truncate text to reasonable length (model has 512 token limit)
    // ~500 chars ≈ ~128 tokens (rough estimate)
    const truncated = text.substring(0, 2000);

    // Generate embedding
    const output = await extractor(truncated, {
      pooling: 'mean',
      normalize: true
    });

    // Convert to regular array (from tensor)
    const embedding = Array.from(output.data);

    return embedding;
  } catch (error) {
    console.error('[Embeddings] Failed to generate embedding:', error);
    throw error;
  }
}

/**
 * Generate embeddings for multiple chunks of text (batched)
 */
export async function generateEmbeddings(chunks) {
  const embeddings = [];

  for (const chunk of chunks) {
    const embedding = await generateEmbedding(chunk);
    embeddings.push(embedding);
  }

  return embeddings;
}

/**
 * Check if embeddings are initialized
 */
export function isInitialized() {
  return extractor !== null;
}
