/**
 * Shared initialization state for background service worker modules.
 * Handler modules import this to check readiness flags.
 */
export const state = {
  dbReady: false,
  embeddingsReady: false,
  llmReady: false
};
