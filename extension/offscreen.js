/**
 * Offscreen Document Script
 *
 * Runs in an offscreen document (hidden page) that CAN create Web Workers.
 * Acts as a bridge between the Service Worker and the embeddings Web Worker.
 */

console.log('[Offscreen] Offscreen document loaded');

let worker = null;
let initialized = false;
let messageId = 0;
const pendingMessages = new Map();

// Listen for messages from Service Worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only handle embeddings-related messages
  if (!message.type || !message.type.startsWith('EMBEDDINGS_')) {
    return false; // Not for us
  }

  console.log('[Offscreen] Received message:', message);
  console.log('[Offscreen] Message type:', message?.type);

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
    sendResponse({ initialized });
    return false;
  }

  if (message.type === 'EMBEDDINGS_CHUNK') {
    console.log('[Offscreen] Processing EMBEDDINGS_CHUNK...');
    try {
      // Import chunker here (has access to DOM APIs)
      import(chrome.runtime.getURL('lib/chunker.js'))
        .then(({ chunkContent }) => {
          const chunks = chunkContent(message.html, message.contentType);
          console.log('[Offscreen] Created', chunks.length, 'chunks');
          sendResponse({ chunks });
        })
        .catch(error => {
          console.error('[Offscreen] Chunking error:', error);
          sendResponse({ chunks: null, error: error.message });
        });
    } catch (error) {
      console.error('[Offscreen] Chunking error:', error);
      sendResponse({ chunks: null, error: error.message });
    }
    return true; // Async response
  }
});

/**
 * Initialize the embeddings Web Worker
 */
async function initEmbeddings() {
  if (initialized) {
    return true;
  }

  try {
    console.log('[Offscreen] Creating Web Worker...');

    // Create Web Worker (this works in offscreen documents!)
    worker = new Worker(
      chrome.runtime.getURL('lib/embeddings-worker.js'),
      { type: 'module' }
    );

    // Set up message handler
    worker.addEventListener('message', handleWorkerMessage);
    worker.addEventListener('error', (error) => {
      console.error('[Offscreen] Worker error:', error);
    });

    // Initialize the model
    console.log('[Offscreen] Initializing embeddings model...');
    const success = await sendMessageToWorker('INIT', null);

    if (success) {
      initialized = true;
      console.log('[Offscreen] Embeddings initialized successfully');
    } else {
      console.error('[Offscreen] Embeddings initialization failed');
    }

    return success;

  } catch (error) {
    console.error('[Offscreen] Failed to initialize:', error);
    return false;
  }
}

/**
 * Generate embedding for text
 */
async function generateEmbedding(text) {
  if (!initialized) {
    throw new Error('Embeddings not initialized');
  }

  return await sendMessageToWorker('GENERATE', { text });
}

/**
 * Send message to Web Worker and wait for response
 */
function sendMessageToWorker(type, data) {
  return new Promise((resolve, reject) => {
    if (!worker) {
      reject(new Error('Worker not created'));
      return;
    }

    const id = messageId++;

    // Store resolve/reject for this message
    pendingMessages.set(id, { resolve, reject });

    // Send message to worker
    worker.postMessage({ type, data, id });

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
    console.warn('[Offscreen] Received message for unknown ID:', id);
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

console.log('[Offscreen] Ready to create Web Workers');
