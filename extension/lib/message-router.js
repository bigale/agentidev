/**
 * Message router for background service worker.
 * Replaces the 34-clause if-chain with a dispatch table.
 */

const OFFSCREEN_PREFIXES = ['EMBEDDINGS_', 'LLM_'];

export function createMessageRouter(handlers) {
  return (message, sender, sendResponse) => {
    if (!message?.type) return false;

    // Let offscreen document handle its own messages
    for (const prefix of OFFSCREEN_PREFIXES) {
      if (message.type.startsWith(prefix)) return false;
    }

    const handler = handlers[message.type];
    if (!handler) return false;

    handler(message, sender)
      .then(result => sendResponse(result))
      .catch(error => {
        console.error(`[Router] ${message.type} error:`, error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Async response
  };
}
