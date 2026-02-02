/**
 * Hybrid Field Finder
 *
 * Three-tier field finding strategy with automatic fallback:
 * 1. XPath (fastest, most precise) - Try structural queries on parsed XML
 * 2. Vector Search (semantic) - Find fields by embedding similarity
 * 3. LLM Disambiguation (slowest, most flexible) - Natural language understanding
 *
 * Phase 2.1 - Grammar-enhanced automation
 */

import { generateFormGrammar } from './form-grammar-generator.js';
import { parseFormWithGrammar, parseFormWithFallback, extractFieldsFromXML } from './form-xml-parser.js';
import { findFieldByXPath, getAllFields } from './xpath-field-finder.js';
import { findElementByIntent } from './semantic-finder.js';
import { generateText } from './chrome-prompt-api.js';

console.log('[Hybrid Finder] Module loaded');

/**
 * Find field using hybrid approach with automatic fallback
 *
 * @param {number} tabId - Tab ID to search in
 * @param {string} intent - User intent (e.g., "email field", "submit button")
 * @param {Object} options - Finder options
 * @returns {Promise<Object>} Result with selector and method used
 */
export async function findFieldHybrid(tabId, intent, options = {}) {
  const {
    useXPath = true,
    useVector = true,
    useLLM = true,
    highlightFields = false,
    grammarCache = true,
    timeout = 10000
  } = options;

  console.log('[Hybrid Finder] Finding field:', intent);
  console.log('[Hybrid Finder] Strategy: XPath →', useVector ? 'Vector →' : '', useLLM ? 'LLM' : '');

  const startTime = performance.now();
  const attempts = [];

  try {
    // Step 1: Try XPath (if enabled and grammar available)
    if (useXPath) {
      console.log('[Hybrid Finder] Tier 1: XPath structural query');

      const xpathResult = await tryXPathFinding(tabId, intent, { grammarCache });

      attempts.push({
        method: 'xpath',
        success: xpathResult.success,
        time: xpathResult.time
      });

      if (xpathResult.success) {
        const totalTime = performance.now() - startTime;
        console.log('[Hybrid Finder] ✓ XPath success in', totalTime.toFixed(2), 'ms');

        return {
          success: true,
          selector: xpathResult.selector,
          method: 'xpath',
          confidence: xpathResult.confidence || 0.95,
          totalTime,
          attempts
        };
      }

      console.log('[Hybrid Finder] XPath failed, falling back to vector search');
    }

    // Step 2: Try Vector Search (if enabled)
    if (useVector) {
      console.log('[Hybrid Finder] Tier 2: Vector semantic search');

      const vectorResult = await tryVectorFinding(tabId, intent, { highlightFields, useLLM: false });

      attempts.push({
        method: 'vector',
        success: vectorResult.success,
        time: vectorResult.time
      });

      if (vectorResult.success) {
        const totalTime = performance.now() - startTime;
        console.log('[Hybrid Finder] ✓ Vector success in', totalTime.toFixed(2), 'ms');

        return {
          success: true,
          selector: vectorResult.selector,
          method: 'vector',
          confidence: vectorResult.confidence || 0.80,
          totalTime,
          attempts
        };
      }

      console.log('[Hybrid Finder] Vector failed, falling back to LLM');
    }

    // Step 3: Try LLM Disambiguation (if enabled)
    if (useLLM) {
      console.log('[Hybrid Finder] Tier 3: LLM disambiguation');

      const llmResult = await tryLLMFinding(tabId, intent, { highlightFields });

      attempts.push({
        method: 'llm',
        success: llmResult.success,
        time: llmResult.time
      });

      if (llmResult.success) {
        const totalTime = performance.now() - startTime;
        console.log('[Hybrid Finder] ✓ LLM success in', totalTime.toFixed(2), 'ms');

        return {
          success: true,
          selector: llmResult.selector,
          method: 'llm',
          confidence: llmResult.confidence || 0.70,
          totalTime,
          attempts
        };
      }
    }

    // All methods failed
    const totalTime = performance.now() - startTime;
    console.log('[Hybrid Finder] ✗ All methods failed in', totalTime.toFixed(2), 'ms');

    return {
      success: false,
      error: 'Field not found with any method',
      totalTime,
      attempts
    };

  } catch (error) {
    console.error('[Hybrid Finder] Error:', error);

    const totalTime = performance.now() - startTime;

    return {
      success: false,
      error: error.message,
      totalTime,
      attempts
    };
  }
}

/**
 * Try XPath-based finding
 *
 * @param {number} tabId - Tab ID
 * @param {string} intent - User intent
 * @param {Object} options - Options
 * @returns {Promise<Object>} Result
 */
async function tryXPathFinding(tabId, intent, options = {}) {
  const startTime = performance.now();

  try {
    // Get page HTML
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';

    // Extract HTML from page
    const htmlResult = await chrome.tabs.sendMessage(tabId, {
      type: 'GET_PAGE_HTML'
    });

    if (!htmlResult || !htmlResult.html) {
      return {
        success: false,
        time: performance.now() - startTime,
        error: 'Failed to extract HTML'
      };
    }

    const html = htmlResult.html;

    // Generate or retrieve grammar
    console.log('[Hybrid Finder] Generating grammar for form...');

    const grammarResult = await generateFormGrammar(html, url, {
      useCache: options.grammarCache !== false
    });

    if (!grammarResult.grammar) {
      return {
        success: false,
        time: performance.now() - startTime,
        error: 'Failed to generate grammar'
      };
    }

    console.log('[Hybrid Finder] Grammar ready:', grammarResult.cached ? '(cached)' : '(generated)');

    // Parse HTML with grammar
    console.log('[Hybrid Finder] Parsing HTML with grammar...');

    const parseResult = await parseFormWithFallback(html, grammarResult.grammar);

    if (!parseResult.success || parseResult.method !== 'ixml') {
      return {
        success: false,
        time: performance.now() - startTime,
        error: 'IXML parsing failed'
      };
    }

    console.log('[Hybrid Finder] XML parsed successfully');

    // Query with XPath
    const xpathResult = findFieldByXPath(parseResult.xmlDoc, intent);

    if (xpathResult.success) {
      return {
        success: true,
        selector: xpathResult.selector,
        confidence: xpathResult.confidence,
        time: performance.now() - startTime
      };
    }

    return {
      success: false,
      time: performance.now() - startTime,
      error: 'No XPath match'
    };

  } catch (error) {
    console.error('[Hybrid Finder] XPath error:', error);
    return {
      success: false,
      time: performance.now() - startTime,
      error: error.message
    };
  }
}

/**
 * Try vector-based finding
 *
 * @param {number} tabId - Tab ID
 * @param {string} intent - User intent
 * @param {Object} options - Options
 * @returns {Promise<Object>} Result
 */
async function tryVectorFinding(tabId, intent, options = {}) {
  const startTime = performance.now();

  try {
    // Use existing semantic finder (vector search)
    const result = await findElementByIntent(tabId, intent, {
      useLLM: options.useLLM || false,
      highlightFields: options.highlightFields || false
    });

    return {
      success: result.success,
      selector: result.selector,
      confidence: result.confidence,
      time: performance.now() - startTime,
      error: result.error
    };

  } catch (error) {
    console.error('[Hybrid Finder] Vector error:', error);
    return {
      success: false,
      time: performance.now() - startTime,
      error: error.message
    };
  }
}

/**
 * Try LLM-based finding
 *
 * @param {number} tabId - Tab ID
 * @param {string} intent - User intent
 * @param {Object} options - Options
 * @returns {Promise<Object>} Result
 */
async function tryLLMFinding(tabId, intent, options = {}) {
  const startTime = performance.now();

  try {
    // Use semantic finder with LLM enabled
    const result = await findElementByIntent(tabId, intent, {
      useLLM: true,
      highlightFields: options.highlightFields || false
    });

    return {
      success: result.success,
      selector: result.selector,
      confidence: result.confidence,
      time: performance.now() - startTime,
      error: result.error
    };

  } catch (error) {
    console.error('[Hybrid Finder] LLM error:', error);
    return {
      success: false,
      time: performance.now() - startTime,
      error: error.message
    };
  }
}

/**
 * Batch find multiple fields using hybrid approach
 *
 * @param {number} tabId - Tab ID
 * @param {Array<string>} intents - Array of intents
 * @param {Object} options - Options
 * @returns {Promise<Array<Object>>} Results
 */
export async function findFieldsHybrid(tabId, intents, options = {}) {
  console.log('[Hybrid Finder] Batch find:', intents.length, 'fields');

  const results = [];

  for (const intent of intents) {
    const result = await findFieldHybrid(tabId, intent, options);
    results.push({
      intent,
      ...result
    });
  }

  const successCount = results.filter(r => r.success).length;
  console.log('[Hybrid Finder] Batch results:', successCount, '/', intents.length, 'found');

  // Calculate method distribution
  const methodCounts = {
    xpath: results.filter(r => r.method === 'xpath').length,
    vector: results.filter(r => r.method === 'vector').length,
    llm: results.filter(r => r.method === 'llm').length
  };

  console.log('[Hybrid Finder] Method distribution:', methodCounts);

  return results;
}

/**
 * Analyze form and recommend best finding strategy
 *
 * @param {number} tabId - Tab ID
 * @returns {Promise<Object>} Analysis result
 */
export async function analyzeFormStrategy(tabId) {
  console.log('[Hybrid Finder] Analyzing form for optimal strategy...');

  const startTime = performance.now();

  try {
    // Try to parse form with grammar
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';

    const htmlResult = await chrome.tabs.sendMessage(tabId, {
      type: 'GET_PAGE_HTML'
    });

    if (!htmlResult || !htmlResult.html) {
      return {
        success: false,
        error: 'Failed to extract HTML'
      };
    }

    const html = htmlResult.html;

    // Try grammar generation
    let grammarAvailable = false;
    let xpathRecommended = false;

    try {
      const grammarResult = await generateFormGrammar(html, url, { useCache: true });
      const parseResult = await parseFormWithFallback(html, grammarResult.grammar);

      if (parseResult.success && parseResult.method === 'ixml') {
        grammarAvailable = true;

        // Check field count
        const fields = extractFieldsFromXML(parseResult.xmlDoc);
        if (fields.length >= 3) {
          xpathRecommended = true;
        }
      }
    } catch (error) {
      console.log('[Hybrid Finder] Grammar not available:', error.message);
    }

    const analysis = {
      success: true,
      grammarAvailable,
      xpathRecommended,
      recommendedStrategy: xpathRecommended ? 'xpath-first' : 'vector-first',
      reason: xpathRecommended
        ? 'Form has structured fields, XPath will be fast and precise'
        : grammarAvailable
        ? 'Form is simple, vector search sufficient'
        : 'Grammar generation failed, use vector/LLM fallback',
      analysisTime: performance.now() - startTime
    };

    console.log('[Hybrid Finder] Analysis:', analysis);

    return analysis;

  } catch (error) {
    console.error('[Hybrid Finder] Analysis error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Benchmark hybrid finder performance
 *
 * @param {number} tabId - Tab ID
 * @param {Array<string>} testIntents - Test intents
 * @returns {Promise<Object>} Benchmark results
 */
export async function benchmarkHybridFinder(tabId, testIntents = null) {
  console.log('[Hybrid Finder] Running benchmark...');

  const defaultIntents = [
    'email field',
    'password field',
    'phone number',
    'full name',
    'submit button'
  ];

  const intents = testIntents || defaultIntents;

  const startTime = performance.now();

  // Test each method independently
  const xpathResults = await findFieldsHybrid(tabId, intents, {
    useXPath: true,
    useVector: false,
    useLLM: false
  });

  const vectorResults = await findFieldsHybrid(tabId, intents, {
    useXPath: false,
    useVector: true,
    useLLM: false
  });

  const llmResults = await findFieldsHybrid(tabId, intents, {
    useXPath: false,
    useVector: false,
    useLLM: true
  });

  // Test hybrid (all methods)
  const hybridResults = await findFieldsHybrid(tabId, intents, {
    useXPath: true,
    useVector: true,
    useLLM: true
  });

  const totalTime = performance.now() - startTime;

  const benchmark = {
    totalTime: totalTime.toFixed(2),
    intentsCount: intents.length,
    methods: {
      xpath: {
        successRate: (xpathResults.filter(r => r.success).length / intents.length * 100).toFixed(1) + '%',
        avgTime: (xpathResults.reduce((sum, r) => sum + (r.totalTime || 0), 0) / intents.length).toFixed(2) + 'ms'
      },
      vector: {
        successRate: (vectorResults.filter(r => r.success).length / intents.length * 100).toFixed(1) + '%',
        avgTime: (vectorResults.reduce((sum, r) => sum + (r.totalTime || 0), 0) / intents.length).toFixed(2) + 'ms'
      },
      llm: {
        successRate: (llmResults.filter(r => r.success).length / intents.length * 100).toFixed(1) + '%',
        avgTime: (llmResults.reduce((sum, r) => sum + (r.totalTime || 0), 0) / intents.length).toFixed(2) + 'ms'
      },
      hybrid: {
        successRate: (hybridResults.filter(r => r.success).length / intents.length * 100).toFixed(1) + '%',
        avgTime: (hybridResults.reduce((sum, r) => sum + (r.totalTime || 0), 0) / intents.length).toFixed(2) + 'ms'
      }
    },
    recommendation: null
  };

  // Determine recommendation
  const hybridSuccessRate = hybridResults.filter(r => r.success).length / intents.length;
  const xpathSuccessRate = xpathResults.filter(r => r.success).length / intents.length;

  if (xpathSuccessRate >= 0.8 && xpathSuccessRate === hybridSuccessRate) {
    benchmark.recommendation = 'Use XPath-only for this form (fast and sufficient)';
  } else if (hybridSuccessRate > xpathSuccessRate) {
    benchmark.recommendation = 'Use hybrid approach for best results';
  } else {
    benchmark.recommendation = 'Form may benefit from manual selector tuning';
  }

  console.log('[Hybrid Finder] Benchmark complete:', benchmark);

  return benchmark;
}

console.log('[Hybrid Finder] Module ready');
