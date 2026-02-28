/**
 * Extraction message handlers.
 * Extracted from background.js lines 174-182, 964-1026.
 */
import { checkAvailability, initSession, generateText } from '../chrome-prompt-api.js';
import { RecursiveExtractor } from '../recursive-extractor.js';
import { state } from '../init-state.js';

async function handleExtraction(tabId, prompt, options = {}) {
  if (!state.llmReady) {
    console.log('[Extract] Gemini Nano not ready, attempting to initialize...');
    try {
      const apiAvailable = await checkAvailability();
      if (apiAvailable) state.llmReady = await initSession();
    } catch (error) {
      console.error('[Extract] Initialization error:', error);
    }

    if (!state.llmReady) {
      console.warn('[Extract] Gemini Nano not available');
      return { success: false, error: 'Gemini Nano not available. Requires Chrome 138+ with flag enabled.', items: [], pagesProcessed: 0 };
    }
    console.log('[Extract] Gemini Nano initialized successfully');
  }

  try {
    console.log('[Extract] Starting extraction on tab', tabId);
    console.log('[Extract] Prompt:', prompt);
    console.log('[Extract] Options:', options);

    const llmInterface = {
      generate: async (promptText, genOptions = {}) => {
        return await generateText(promptText, genOptions);
      }
    };

    const extractor = new RecursiveExtractor(llmInterface, 4500);
    const result = await extractor.extract(tabId, prompt, options);

    console.log('[Extract] Extraction complete:', {
      success: result.success,
      items: result.items?.length || 0,
      pages: result.pagesProcessed
    });

    return result;
  } catch (error) {
    console.error('[Extract] Failed:', error);
    return { success: false, error: error.message, items: [], pagesProcessed: 0 };
  }
}

export function register(handlers) {
  handlers['EXTRACT'] = async (msg) => {
    return await handleExtraction(msg.tabId, msg.prompt, msg.options);
  };
}
