/**
 * Grammar and IXML spec message handlers.
 * Extracted from background.js lines 247-306, 1438-1535.
 */
import { generateFormGrammar, clearGrammarCache, getGrammarCacheStats } from '../form-grammar-generator.js';
import { indexIXMLSpec, getSpecIndexStatus, clearSpecIndex } from '../ixml-spec-indexer.js';

async function handleGetGrammar(tabId, url) {
  console.log('[Grammar] Getting grammar for:', url);

  try {
    const htmlResult = await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_HTML' });
    if (!htmlResult || !htmlResult.html) {
      return { success: false, error: 'Failed to get page HTML' };
    }

    const grammarResult = await generateFormGrammar(htmlResult.html, url, { useCache: true });
    return { success: true, grammar: grammarResult.grammar, cached: grammarResult.cached || false, cacheKey: grammarResult.cacheKey };
  } catch (error) {
    console.error('[Grammar] Failed:', error);
    return { success: false, error: error.message };
  }
}

async function handleClearGrammarCache(domain) {
  console.log('[Grammar] Clearing cache for:', domain);

  try {
    const statsBefore = await getGrammarCacheStats();
    const countBefore = domain ? (statsBefore.byDomain[domain] || 0) : statsBefore.totalEntries;
    await clearGrammarCache(domain);
    return { success: true, count: countBefore };
  } catch (error) {
    console.error('[Grammar] Clear cache failed:', error);
    return { success: false, error: error.message };
  }
}

async function handleTestGrammar(tabId) {
  console.log('[Grammar] Testing parse on tab:', tabId);

  try {
    const parseResult = await chrome.tabs.sendMessage(tabId, {
      type: 'PARSE_FORM_WITH_GRAMMAR',
      intent: null,
      html: null,
      grammar: null
    });

    if (parseResult && parseResult.success) {
      return {
        success: true,
        method: parseResult.parseMethod || parseResult.method,
        fieldCount: parseResult.fields ? parseResult.fields.length : 0,
        xmlOutput: parseResult.xmlOutput || null,
        debugHistory: parseResult.debugHistory || []
      };
    } else {
      return { success: false, error: parseResult?.error || 'Parse failed' };
    }
  } catch (error) {
    console.error('[Grammar] Test failed:', error);
    return { success: false, error: error.message };
  }
}

export function register(handlers) {
  handlers['GET_GRAMMAR'] = async (msg) => {
    return await handleGetGrammar(msg.tabId, msg.url);
  };

  handlers['CLEAR_GRAMMAR_CACHE'] = async (msg) => {
    return await handleClearGrammarCache(msg.domain);
  };

  handlers['TEST_GRAMMAR'] = async (msg) => {
    return await handleTestGrammar(msg.tabId);
  };

  handlers['INDEX_IXML_SPEC'] = async () => {
    return await indexIXMLSpec();
  };

  handlers['GET_SPEC_STATUS'] = async () => {
    return await getSpecIndexStatus();
  };

  handlers['CLEAR_SPEC_INDEX'] = async () => {
    return await clearSpecIndex();
  };
}
