/**
 * Offscreen Document Script for Embeddings
 *
 * Dedicated offscreen document for embeddings model.
 * Isolated from LLM to prevent model conflicts.
 */

console.log('[Offscreen-Embeddings] Offscreen document loaded');

// Embeddings worker
let embeddingsWorker = null;
let embeddingsInitialized = false;

// Message handling
let messageId = 0;
const pendingMessages = new Map();

// Listen for messages from Service Worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const isEmbeddings = message.type?.startsWith('EMBEDDINGS_');

  if (!isEmbeddings) {
    return false; // Not for us
  }

  console.log('[Offscreen-Embeddings] Received message:', message);

  if (message.type === 'EMBEDDINGS_INIT') {
    console.log('[Offscreen-Embeddings] Processing EMBEDDINGS_INIT...');
    initEmbeddings()
      .then(success => {
        console.log('[Offscreen-Embeddings] initEmbeddings completed with success:', success);
        sendResponse({ success });
      })
      .catch(error => {
        console.error('[Offscreen-Embeddings] initEmbeddings error:', error);
        sendResponse({ success: false, error: error.message });
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
    console.log('[Offscreen-Embeddings] Processing EMBEDDINGS_CHUNK...');
    try {
      // Import chunker here (has access to DOM APIs)
      import(chrome.runtime.getURL('lib/chunker.js'))
        .then(({ chunkContent }) => {
          const chunks = chunkContent(message.html, message.contentType);
          console.log('[Offscreen-Embeddings] Created', chunks.length, 'chunks');
          sendResponse({ chunks });
        })
        .catch(error => {
          console.error('[Offscreen-Embeddings] Chunking error:', error);
          sendResponse({ chunks: null, error: error.message });
        });
    } catch (error) {
      console.error('[Offscreen-Embeddings] Chunking error:', error);
      sendResponse({ chunks: null, error: error.message });
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
    console.log('[Offscreen-Embeddings] Creating Embeddings Web Worker...');

    // Create Web Worker (this works in offscreen documents!)
    embeddingsWorker = new Worker(
      chrome.runtime.getURL('lib/embeddings-worker.js'),
      { type: 'module' }
    );

    // Set up message handler
    embeddingsWorker.addEventListener('message', handleWorkerMessage);
    embeddingsWorker.addEventListener('error', (error) => {
      console.error('[Offscreen-Embeddings] Worker error:', error);
    });

    // Initialize the model
    console.log('[Offscreen-Embeddings] Initializing embeddings model...');
    const success = await sendMessageToWorker('INIT', null);

    if (success) {
      embeddingsInitialized = true;
      console.log('[Offscreen-Embeddings] Embeddings initialized successfully');
    } else {
      console.error('[Offscreen-Embeddings] Embeddings initialization failed');
    }

    return success;

  } catch (error) {
    console.error('[Offscreen-Embeddings] Failed to initialize embeddings:', error);
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

  return await sendMessageToWorker('GENERATE', { text });
}

/**
 * Send message to Web Worker and wait for response
 */
function sendMessageToWorker(type, data) {
  return new Promise((resolve, reject) => {
    if (!embeddingsWorker) {
      reject(new Error('Worker not created'));
      return;
    }

    const id = messageId++;

    // Store resolve/reject for this message
    pendingMessages.set(id, { resolve, reject });

    // Send message to worker
    embeddingsWorker.postMessage({ type, data, id });

    // Timeout after 60 seconds
    setTimeout(() => {
      if (pendingMessages.has(id)) {
        pendingMessages.delete(id);
        reject(new Error('Worker timeout'));
      }
    }, 60000);
  });
}

/**
 * Handle messages from Web Worker
 */
function handleWorkerMessage(event) {
  const { type, id, success, embedding, error } = event.data;

  const pending = pendingMessages.get(id);
  if (!pending) {
    console.warn('[Offscreen-Embeddings] Received message for unknown ID:', id);
    return;
  }

  pendingMessages.delete(id);

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

console.log('[Offscreen-Embeddings] Ready to create Embeddings Web Worker');
