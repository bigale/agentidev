/**
 * Offscreen Document Script for LLM
 *
 * Dedicated offscreen document for LLM model.
 * Isolated from embeddings to prevent model conflicts.
 */

console.log('[Offscreen-LLM] Offscreen document loaded');

// LLM worker
let llmWorker = null;
let llmInitialized = false;

// Message handling
let messageId = 0;
const pendingMessages = new Map();

// Listen for messages from Service Worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const isLLM = message.type?.startsWith('LLM_');

  if (!isLLM) {
    return false; // Not for us
  }

  console.log('[Offscreen-LLM] Received message:', message);

  if (message.type === 'LLM_INIT') {
    console.log('[Offscreen-LLM] Processing LLM_INIT...');
    initLLM(message.model)
      .then(result => {
        console.log('[Offscreen-LLM] LLM init completed:', result);
        sendResponse(result);
      })
      .catch(error => {
        console.error('[Offscreen-LLM] LLM init error:', error);
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
});

/**
 * Initialize the LLM Web Worker
 */
async function initLLM(modelName) {
  // Don't re-initialize if already initialized with same model
  if (llmInitialized && llmWorker) {
    console.log('[Offscreen-LLM] LLM already initialized');
    return { success: true, model: modelName };
  }

  try {
    console.log('[Offscreen-LLM] Creating LLM Web Worker...');

    // Create LLM Web Worker
    llmWorker = new Worker(
      chrome.runtime.getURL('lib/llm-worker.js'),
      { type: 'module' }
    );

    // Set up message handler
    llmWorker.addEventListener('message', handleWorkerMessage);
    llmWorker.addEventListener('error', (error) => {
      console.error('[Offscreen-LLM] Worker error:', error);
    });

    // Initialize the model
    console.log('[Offscreen-LLM] Initializing LLM model:', modelName);
    const success = await sendMessageToWorker('INIT', { model: modelName });

    if (success) {
      llmInitialized = true;
      console.log('[Offscreen-LLM] LLM initialized successfully');
      return { success: true, model: modelName };
    } else {
      console.error('[Offscreen-LLM] LLM initialization failed');
      return { success: false, error: 'Model initialization failed' };
    }

  } catch (error) {
    console.error('[Offscreen-LLM] Failed to initialize LLM:', error);
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

  return await sendMessageToWorker('GENERATE', { prompt, options });
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

  return await sendMessageToWorker('ESTIMATE_TOKENS', { text });
}

/**
 * Send message to Web Worker and wait for response
 */
function sendMessageToWorker(type, data) {
  return new Promise((resolve, reject) => {
    if (!llmWorker) {
      reject(new Error('Worker not created'));
      return;
    }

    const id = messageId++;

    // Store resolve/reject for this message
    pendingMessages.set(id, { resolve, reject });

    // Send message to worker
    llmWorker.postMessage({ type, data, id });

    // Timeout after 120 seconds (LLM can be slow)
    setTimeout(() => {
      if (pendingMessages.has(id)) {
        pendingMessages.delete(id);
        reject(new Error('Worker timeout'));
      }
    }, 120000);
  });
}

/**
 * Handle messages from Web Worker
 */
function handleWorkerMessage(event) {
  const { type, id, success, text, tokens, tokensUsed, error, model } = event.data;

  const pending = pendingMessages.get(id);
  if (!pending) {
    console.warn('[Offscreen-LLM] Received message for unknown ID:', id);
    return;
  }

  pendingMessages.delete(id);

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

console.log('[Offscreen-LLM] Ready to create LLM Web Worker');
