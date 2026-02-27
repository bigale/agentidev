/**
 * Offscreen Document Script
 *
 * Runs in an offscreen document (hidden page) that CAN create Web Workers.
 * Acts as a bridge between the Service Worker and the Web Workers.
 * Manages both embeddings and LLM workers.
 */

console.log('[Offscreen] Offscreen document loaded');

// Embeddings worker
let embeddingsWorker = null;
let embeddingsInitialized = false;

// LLM worker
let llmWorker = null;
let llmInitialized = false;

// Message handling
let messageId = 0;
const pendingEmbeddingsMessages = new Map();
const pendingLLMMessages = new Map();

// Listen for messages from Service Worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle both embeddings and LLM messages
  const isEmbeddings = message.type?.startsWith('EMBEDDINGS_');
  const isLLM = message.type?.startsWith('LLM_');

  if (!isEmbeddings && !isLLM) {
    return false; // Not for us
  }

  console.log('[Offscreen] Received message:', message);
  console.log('[Offscreen] Message type:', message?.type);

  // Handle LLM messages
  if (isLLM) {
    return handleLLMMessage(message, sendResponse);
  }

  // Handle embeddings messages (existing code)

  if (message.type === 'EMBEDDINGS_INIT') {
    console.log('[Offscreen] Processing EMBEDDINGS_INIT...');
    initEmbeddings()
      .then(success => {
        console.log('[Offscreen] initEmbeddings completed with success:', success);
        const response = { success };
        console.log('[Offscreen] Sending response:', response);
        sendResponse(response);
      })
      .catch(error => {
        console.error('[Offscreen] initEmbeddings error:', error);
        const response = { success: false, error: error.message };
        console.log('[Offscreen] Sending error response:', response);
        sendResponse(response);
      });
    return true; // Async response
  }

  if (message.type === 'EMBEDDINGS_GENERATE') {
    generateEmbedding(message.text)
      .then(embedding => sendResponse({ embedding }))
      .catch(error => sendResponse({ embedding: null, error: error.message }));
    return true; // Async response
  }

  if (message.type === 'EMBEDDINGS_STATUS') {
    sendResponse({ initialized: embeddingsInitialized });
    return false;
  }

  if (message.type === 'EMBEDDINGS_CHUNK') {
    console.log('[Offscreen] Processing EMBEDDINGS_CHUNK...');
    try {
      // Import chunker here (has access to DOM APIs)
      import(chrome.runtime.getURL('lib/chunker.js'))
        .then(({ chunkContent }) => {
          const result = chunkContent(message.html, message.contentType);
          console.log('[Offscreen] Created', result.chunks.length, 'chunks,', (result.structuredRecords || []).length, 'structured records');
          sendResponse({
            chunks: result.chunks,
            structuredRecords: result.structuredRecords || []
          });
        })
        .catch(error => {
          console.error('[Offscreen] Chunking error:', error);
          sendResponse({ chunks: null, structuredRecords: [], error: error.message });
        });
    } catch (error) {
      console.error('[Offscreen] Chunking error:', error);
      sendResponse({ chunks: null, structuredRecords: [], error: error.message });
    }
    return true; // Async response
  }
});

/**
 * Initialize the embeddings Web Worker
 */
async function initEmbeddings() {
  if (embeddingsInitialized) {
    return true;
  }

  try {
    console.log('[Offscreen] Creating Embeddings Web Worker...');

    // Create Web Worker (this works in offscreen documents!)
    embeddingsWorker = new Worker(
      chrome.runtime.getURL('lib/embeddings-worker.js'),
      { type: 'module' }
    );

    // Set up message handler
    embeddingsWorker.addEventListener('message', handleEmbeddingsWorkerMessage);
    embeddingsWorker.addEventListener('error', (error) => {
      console.error('[Offscreen] Embeddings Worker error:', error);
    });

    // Initialize the model
    console.log('[Offscreen] Initializing embeddings model...');
    const success = await sendMessageToEmbeddingsWorker('INIT', null);

    if (success) {
      embeddingsInitialized = true;
      console.log('[Offscreen] Embeddings initialized successfully');
    } else {
      console.error('[Offscreen] Embeddings initialization failed');
    }

    return success;

  } catch (error) {
    console.error('[Offscreen] Failed to initialize embeddings:', error);
    return false;
  }
}

/**
 * Generate embedding for text
 */
async function generateEmbedding(text) {
  if (!embeddingsInitialized) {
    throw new Error('Embeddings not initialized');
  }

  return await sendMessageToEmbeddingsWorker('GENERATE', { text });
}

/**
 * Send message to Embeddings Web Worker and wait for response
 */
function sendMessageToEmbeddingsWorker(type, data) {
  return new Promise((resolve, reject) => {
    if (!embeddingsWorker) {
      reject(new Error('Embeddings Worker not created'));
      return;
    }

    const id = messageId++;

    // Store resolve/reject for this message
    pendingEmbeddingsMessages.set(id, { resolve, reject });

    // Send message to worker
    embeddingsWorker.postMessage({ type, data, id });

    // Timeout after 60 seconds
    setTimeout(() => {
      if (pendingEmbeddingsMessages.has(id)) {
        pendingEmbeddingsMessages.delete(id);
        reject(new Error('Embeddings Worker timeout'));
      }
    }, 60000);
  });
}

/**
 * Handle messages from Embeddings Web Worker
 */
function handleEmbeddingsWorkerMessage(event) {
  const { type, id, success, embedding, error } = event.data;

  const pending = pendingEmbeddingsMessages.get(id);
  if (!pending) {
    console.warn('[Offscreen] Received embeddings message for unknown ID:', id);
    return;
  }

  pendingEmbeddingsMessages.delete(id);

  switch (type) {
    case 'INIT_RESPONSE':
      pending.resolve(success);
      break;

    case 'GENERATE_RESPONSE':
      pending.resolve(embedding);
      break;

    case 'ERROR':
      pending.reject(new Error(error));
      break;

    default:
      pending.reject(new Error(`Unknown response type: ${type}`));
  }
}

// ============================================================================
// LLM Functions
// ============================================================================

/**
 * Handle LLM messages
 */
function handleLLMMessage(message, sendResponse) {
  if (message.type === 'LLM_INIT') {
    console.log('[Offscreen] Processing LLM_INIT...');
    initLLM(message.model)
      .then(result => {
        console.log('[Offscreen] LLM init completed:', result);
        sendResponse(result);
      })
      .catch(error => {
        console.error('[Offscreen] LLM init error:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Async response
  }

  if (message.type === 'LLM_GENERATE') {
    generateText(message.prompt, message.options)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ text: null, error: error.message }));
    return true; // Async response
  }

  if (message.type === 'LLM_ESTIMATE_TOKENS') {
    estimateTokens(message.text)
      .then(tokens => sendResponse({ tokens }))
      .catch(error => sendResponse({ tokens: null, error: error.message }));
    return true; // Async response
  }

  if (message.type === 'LLM_STATUS') {
    sendResponse({ initialized: llmInitialized });
    return false;
  }

  return false;
}

/**
 * Initialize the LLM Web Worker
 */
async function initLLM(modelName) {
  // Don't re-initialize if already initialized with same model
  if (llmInitialized && llmWorker) {
    console.log('[Offscreen] LLM already initialized');
    return { success: true, model: modelName };
  }

  try {
    console.log('[Offscreen] Creating LLM Web Worker...');

    // Create LLM Web Worker
    llmWorker = new Worker(
      chrome.runtime.getURL('lib/llm-worker.js'),
      { type: 'module' }
    );

    // Set up message handler
    llmWorker.addEventListener('message', handleLLMWorkerMessage);
    llmWorker.addEventListener('error', (error) => {
      console.error('[Offscreen] LLM Worker error:', error);
    });

    // Initialize the model (this can take 1-5 minutes for TinyLlama)
    console.log('[Offscreen] Initializing LLM model:', modelName);
    console.log('[Offscreen] This may take up to 5 minutes on first run...');

    // Log progress every 10 seconds to show it's still working
    const progressInterval = setInterval(() => {
      console.log('[Offscreen] LLM still loading... (please wait)');
    }, 10000);

    try {
      const success = await sendMessageToLLMWorker('INIT', { model: modelName });
      clearInterval(progressInterval);

      if (success) {
        llmInitialized = true;
        console.log('[Offscreen] LLM initialized successfully');
        return { success: true, model: modelName };
      } else {
        console.error('[Offscreen] LLM initialization failed');
        return { success: false, error: 'Model initialization failed' };
      }
    } catch (error) {
      clearInterval(progressInterval);
      throw error;
    }

  } catch (error) {
    console.error('[Offscreen] Failed to initialize LLM:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Generate text using LLM
 */
async function generateText(prompt, options) {
  if (!llmInitialized) {
    throw new Error('LLM not initialized');
  }

  return await sendMessageToLLMWorker('GENERATE', { prompt, options });
}

/**
 * Estimate tokens for text
 */
async function estimateTokens(text) {
  // Can work without LLM initialized (uses simple heuristic)
  if (!llmWorker) {
    // Fallback: simple estimation
    return Math.ceil((text || '').length / 4);
  }

  return await sendMessageToLLMWorker('ESTIMATE_TOKENS', { text });
}

/**
 * Send message to LLM Web Worker and wait for response
 */
function sendMessageToLLMWorker(type, data) {
  return new Promise((resolve, reject) => {
    if (!llmWorker) {
      reject(new Error('LLM Worker not created'));
      return;
    }

    const id = messageId++;

    // Store resolve/reject for this message
    pendingLLMMessages.set(id, { resolve, reject });

    // Send message to worker
    llmWorker.postMessage({ type, data, id });

    // Timeout after 5 minutes for INIT (downloading 1GB model), 2 minutes for generation
    const timeoutMs = type === 'INIT' ? 300000 : 120000;
    setTimeout(() => {
      if (pendingLLMMessages.has(id)) {
        pendingLLMMessages.delete(id);
        reject(new Error(`LLM Worker timeout after ${timeoutMs/1000}s`));
      }
    }, timeoutMs);
  });
}

/**
 * Handle messages from LLM Web Worker
 */
function handleLLMWorkerMessage(event) {
  const { type, id, success, text, tokens, tokensUsed, error, model } = event.data;

  const pending = pendingLLMMessages.get(id);
  if (!pending) {
    console.warn('[Offscreen] Received LLM message for unknown ID:', id);
    return;
  }

  pendingLLMMessages.delete(id);

  switch (type) {
    case 'INIT_RESPONSE':
      pending.resolve(success);
      break;

    case 'GENERATE_RESPONSE':
      pending.resolve({ text, tokensUsed });
      break;

    case 'ESTIMATE_RESPONSE':
      pending.resolve(tokens);
      break;

    case 'ERROR':
      pending.reject(new Error(error));
      break;

    default:
      pending.reject(new Error(`Unknown response type: ${type}`));
  }
}

console.log('[Offscreen] Ready to create Web Workers (Embeddings + LLM)');
