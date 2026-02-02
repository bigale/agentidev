/**
 * Embeddings Module using transformers.js
 *
 * Generates semantic embeddings for text using all-MiniLM-L6-v2 model.
 * Runs locally in the browser (no API calls).
 *
 * Uses Offscreen Document API to create Web Workers (Service Workers can't create Workers directly)
 */

let initialized = false;
let initPromise = null;
let offscreenCreated = false;

/**
 * Create offscreen document if needed
 * Shared offscreen document for both embeddings and LLM
 */
async function setupOffscreenDocument() {
  // Check if offscreen document already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen.html')]
  });

  if (existingContexts.length > 0) {
    offscreenCreated = true;
    return;
  }

  // Create offscreen document
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: ['WORKERS'],
    justification: 'Run transformers.js in Web Workers for embeddings and LLM'
  });

  offscreenCreated = true;
  console.log('[Embeddings] Offscreen document created (offscreen.html)');
}

/**
 * Initialize the embedding model
 */
export async function initEmbeddings() {
  // If already initializing, return the same promise
  if (initPromise) {
    return initPromise;
  }

  // If already initialized, return immediately
  if (initialized) {
    return true;
  }

  initPromise = (async () => {
    try {
      console.log('[Embeddings] Setting up offscreen document...');

      // Create offscreen document (can create Web Workers)
      await setupOffscreenDocument();

      // Initialize embeddings in offscreen document
      console.log('[Embeddings] Initializing model...');
      console.log('[Embeddings] Note: Model files (~50MB) are cached after first download');

      const startTime = Date.now();
      const response = await chrome.runtime.sendMessage({
        type: 'EMBEDDINGS_INIT'
      });
      const elapsed = Date.now() - startTime;

      console.log('[Embeddings] Received response:', JSON.stringify(response));
      console.log('[Embeddings] Response type:', typeof response);
      console.log('[Embeddings] Response keys:', Object.keys(response || {}));
      console.log('[Embeddings] Response.success:', response?.success);

      if (!response) {
        console.error('[Embeddings] No response from offscreen document - check offscreen console');
        initPromise = null;
        return false;
      }

      if (response.success) {
        initialized = true;
        const cached = elapsed < 2000; // If < 2s, likely cached
        if (cached) {
          console.log(`[Embeddings] ✓ Model loaded from cache (${elapsed}ms)`);
        } else {
          console.log(`[Embeddings] ✓ Model loaded (${elapsed}ms - first time download)`);
        }
      } else {
        console.error('[Embeddings] Model initialization failed:', response.error);
        console.error('[Embeddings] Full response:', response);
      }

      initPromise = null;
      return response.success;
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
  if (!initialized) {
    // Auto-initialize if needed
    const success = await initEmbeddings();
    if (!success) {
      throw new Error('Failed to initialize embeddings model');
    }
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'EMBEDDINGS_GENERATE',
      text: text
    });

    if (response.error) {
      throw new Error(response.error);
    }

    return response.embedding;
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
  return initialized;
}
