/**
 * Embeddings Module using transformers.js
 *
 * Generates semantic embeddings for text using all-MiniLM-L6-v2 model.
 * Runs locally in the browser (no API calls).
 */

// Note: transformers.js will be loaded via importScripts or dynamic import
let pipeline = null;
let extractor = null;

/**
 * Initialize the embedding model
 */
export async function initEmbeddings() {
  try {
    console.log('Initializing embeddings model...');

    // Dynamic import for ES modules
    const { pipeline: pipelineFunc, env } = await import(
      chrome.runtime.getURL('lib/transformers.min.js')
    );

    // Configure transformers.js for Chrome extension
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = true;

    pipeline = pipelineFunc;

    // Load the embedding model (all-MiniLM-L6-v2)
    // This model produces 384-dimensional embeddings
    extractor = await pipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2'
    );

    console.log('Embeddings model loaded successfully');
    return true;
  } catch (error) {
    console.error('Failed to initialize embeddings:', error);
    return false;
  }
}

/**
 * Generate embedding for a text string
 */
export async function generateEmbedding(text) {
  if (!extractor) {
    throw new Error('Embeddings model not initialized. Call initEmbeddings() first.');
  }

  try {
    // Truncate text to reasonable length (model has 512 token limit)
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
    console.error('Failed to generate embedding:', error);
    throw error;
  }
}

/**
 * Generate embeddings for multiple chunks of text
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
