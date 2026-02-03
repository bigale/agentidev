/**
 * Form Grammar Generator
 *
 * Uses LLM to analyze HTML form structure and generate IXML grammar
 * for normalizing form fields into queryable XML.
 *
 * Phase 2.1 - Grammar-enhanced automation
 * Enhanced with RAG: Queries IXML spec before generating grammar
 */

import { generateText } from './chrome-prompt-api.js';
import { queryIXMLSpec, getSpecIndexStatus } from './ixml-spec-indexer.js';

console.log('[Grammar Generator] Module loaded');

/**
 * Generate IXML grammar for a form
 *
 * @param {string} html - HTML content containing form
 * @param {string} url - Page URL (for caching)
 * @param {Object} options - Generation options
 * @returns {Promise<Object>} Grammar and metadata
 */
export async function generateFormGrammar(html, url, options = {}) {
  const {
    useCache = true,
    sampleSize = 3000 // Max HTML chars to analyze
  } = options;

  console.log('[Grammar Generator] Generating grammar for:', url);

  try {
    // Extract form signature for caching
    const signature = getFormSignature(html);
    const domain = new URL(url).hostname;
    const cacheKey = `${domain}:${signature}`;

    // Check cache
    if (useCache) {
      const cached = await getCachedGrammar(cacheKey);
      if (cached) {
        console.log('[Grammar Generator] Cache hit:', cacheKey);
        return {
          grammar: cached.grammar,
          cached: true,
          cacheKey,
          signature
        };
      }
    }

    // Extract form HTML
    const formHTML = extractFormHTML(html, sampleSize);

    if (!formHTML) {
      throw new Error('No form found in HTML');
    }

    console.log('[Grammar Generator] Analyzing form structure...');
    console.log('[Grammar Generator] Form HTML sample:', formHTML.substring(0, 200) + '...');

    // Generate grammar with LLM
    const grammar = await generateGrammarWithLLM(formHTML);

    // Validate grammar
    const validated = validateGrammar(grammar);

    if (!validated.valid) {
      throw new Error(`Invalid grammar: ${validated.error}`);
    }

    // Cache the grammar
    if (useCache) {
      await cacheGrammar(cacheKey, grammar);
      console.log('[Grammar Generator] Cached grammar:', cacheKey);
    }

    return {
      grammar,
      cached: false,
      cacheKey,
      signature,
      formSample: formHTML.substring(0, 500)
    };

  } catch (error) {
    console.error('[Grammar Generator] Failed:', error);
    throw error;
  }
}

/**
 * Generate IXML grammar using LLM (with RAG-enhanced spec context)
 *
 * @param {string} formHTML - Form HTML sample
 * @returns {Promise<string>} IXML grammar
 */
async function generateGrammarWithLLM(formHTML) {
  // Query IXML spec for relevant syntax rules (RAG enhancement)
  let specContext = '';

  try {
    const specStatus = await getSpecIndexStatus();

    if (specStatus.indexed) {
      console.log('[Grammar Generator] Querying IXML spec for syntax rules...');

      const queries = [
        'IXML attribute syntax rules',
        'IXML nonterminal definitions',
        'IXML grammar examples'
      ];

      const allResults = [];
      for (const query of queries) {
        const results = await queryIXMLSpec(query, { maxResults: 2 });
        allResults.push(...results);
      }

      if (allResults.length > 0) {
        specContext = '\n**IXML Specification Reference** (consult these rules):\n';
        allResults.forEach((result, i) => {
          specContext += `\n[${i + 1}] ${result.section}:\n${result.text.substring(0, 500)}...\n`;
        });
        console.log('[Grammar Generator] Added', allResults.length, 'spec sections to context');
      }
    } else {
      console.log('[Grammar Generator] IXML spec not indexed - proceeding without spec context');
    }
  } catch (error) {
    console.warn('[Grammar Generator] Failed to query spec:', error);
    // Continue without spec context
  }

  const prompt = `You are an IXML grammar expert. Analyze this HTML form and generate an IXML grammar to extract form fields.
${specContext}

**HTML Form Sample**:
\`\`\`html
${formHTML}
\`\`\`

**Task**: Generate an IXML grammar that:
1. Extracts all input fields with their labels
2. Extracts select dropdowns with their labels
3. Extracts buttons (submit, reset, etc.)
4. Associates labels with fields (via label[for], parent label, or nearby text)
5. Outputs XML with: field type, name, label, and CSS selector

**Output Format** (IXML grammar):
\`\`\`ixml
form: field* .
field: input-field | select-field | button-field .

input-field: label?, -'<input', @type, @name, @id?, @placeholder?, -'/>' .
select-field: label?, -'<select', @name, @id?, -'>', option+, -'</select>' .
button-field: -'<button', @type?, -'>', button-text, -'</button>' .

label: -'<label', @for?, -'>', label-text, -'</label>' .
option: -'<option', @value?, -'>', option-text, -'</option>' .

@type: -'type="', type-value, -'"' .
@name: -'name="', name-value, -'"' .
@id: -'id="', id-value, -'"' .
@for: -'for="', for-value, -'"' .
@value: -'value="', value-text, -'"' .
@placeholder: -'placeholder="', placeholder-text, -'"' .

label-text: text .
button-text: text .
option-text: text .
type-value: text .
name-value: text .
id-value: text .
for-value: text .
value-text: text .
placeholder-text: text .
text: [^<>]+ .
\`\`\`

**Important**:
- Keep it simple - focus on extracting the core field information
- Use "-" to hide literals (e.g., -'<input')
- Use @ for attributes
- DO NOT use # prefix with attributes (just use the nonterminal name directly)
- For character classes, use [^<>]+ to match text (excludes angle brackets only)
- DO NOT use quotes inside character classes - they cause parsing errors
- Make labels optional (some fields don't have labels)
- Capture text content for labels and button text

Generate ONLY the IXML grammar, no explanation:`;

  console.log('[Grammar Generator] Sending LLM prompt (length:', prompt.length, 'chars)');

  const response = await generateText(prompt, {
    temperature: 0.1, // Low temp for consistent grammar
    maxTokens: 1500
  });

  console.log('[Grammar Generator] LLM response (length:', response.length, 'chars)');

  // Extract grammar from response (LLM might wrap in markdown)
  let grammar = response.trim();

  // Remove markdown code fences if present
  grammar = grammar.replace(/^```ixml\n?/, '').replace(/\n?```$/, '');
  grammar = grammar.trim();

  console.log('[Grammar Generator] Generated grammar:', grammar.substring(0, 200) + '...');

  return grammar;
}

/**
 * Extract form HTML from page
 *
 * @param {string} html - Full page HTML
 * @param {number} sampleSize - Max chars to extract
 * @returns {string} Form HTML sample
 */
function extractFormHTML(html, sampleSize) {
  // Try to find <form> tag
  const formMatch = html.match(/<form[^>]*>[\s\S]*?<\/form>/i);

  if (formMatch) {
    let formHTML = formMatch[0];

    // Truncate if too long
    if (formHTML.length > sampleSize) {
      formHTML = formHTML.substring(0, sampleSize);
    }

    return formHTML;
  }

  // No explicit form tag - extract interactive elements
  const interactivePattern = /<(input|select|textarea|button)[^>]*>[\s\S]{0,200}/gi;
  const matches = html.match(interactivePattern);

  if (matches && matches.length > 0) {
    // Take first few interactive elements
    return matches.slice(0, 10).join('\n');
  }

  return null;
}

/**
 * Get form signature for caching
 *
 * @param {string} html - Form HTML
 * @returns {string} Signature hash
 */
function getFormSignature(html) {
  // Extract field names and types for signature
  const fieldPattern = /<(input|select|textarea|button)[^>]*(?:name|id)="([^"]+)"[^>]*(?:type="([^"]+)")?/gi;
  const matches = [...html.matchAll(fieldPattern)];

  const fields = matches.map(m => {
    const tag = m[1];
    const nameOrId = m[2];
    const type = m[3] || tag;
    return `${tag}:${type}:${nameOrId}`;
  });

  fields.sort(); // Sort for consistency

  const signatureString = fields.join('|');

  // Simple hash
  return simpleHash(signatureString);
}

/**
 * Simple string hash function
 *
 * @param {string} str - String to hash
 * @returns {string} Hash
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Validate IXML grammar
 *
 * @param {string} grammar - IXML grammar text
 * @returns {Object} Validation result
 */
function validateGrammar(grammar) {
  // Basic validation
  if (!grammar || grammar.length < 20) {
    return { valid: false, error: 'Grammar too short' };
  }

  // Check for basic IXML structure
  if (!grammar.includes(':') || !grammar.includes('.')) {
    return { valid: false, error: 'Missing IXML syntax (: or .)' };
  }

  // Check for form-related rules
  const hasFieldRules = grammar.includes('input') || grammar.includes('select') || grammar.includes('field');

  if (!hasFieldRules) {
    return { valid: false, error: 'Grammar missing field extraction rules' };
  }

  return { valid: true };
}

/**
 * Get cached grammar
 *
 * @param {string} cacheKey - Cache key
 * @returns {Promise<Object|null>} Cached grammar or null
 */
async function getCachedGrammar(cacheKey) {
  try {
    const result = await chrome.storage.local.get([`grammar_${cacheKey}`]);
    const cached = result[`grammar_${cacheKey}`];

    if (cached) {
      // Check TTL (30 days)
      const age = Date.now() - cached.timestamp;
      const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days

      if (age < maxAge) {
        return cached;
      } else {
        console.log('[Grammar Generator] Cache expired:', cacheKey);
        // Remove expired cache
        await chrome.storage.local.remove([`grammar_${cacheKey}`]);
      }
    }

    return null;

  } catch (error) {
    console.error('[Grammar Generator] Cache read error:', error);
    return null;
  }
}

/**
 * Cache grammar
 *
 * @param {string} cacheKey - Cache key
 * @param {string} grammar - Grammar to cache
 * @returns {Promise<void>}
 */
async function cacheGrammar(cacheKey, grammar) {
  try {
    await chrome.storage.local.set({
      [`grammar_${cacheKey}`]: {
        grammar,
        timestamp: Date.now(),
        cacheKey
      }
    });

    console.log('[Grammar Generator] Grammar cached successfully');

  } catch (error) {
    console.error('[Grammar Generator] Cache write error:', error);
    // Non-fatal - continue without cache
  }
}

/**
 * Clear grammar cache
 *
 * @param {string} domain - Optional domain to clear (or all if not specified)
 * @returns {Promise<void>}
 */
export async function clearGrammarCache(domain = null) {
  try {
    const all = await chrome.storage.local.get(null);
    const grammarKeys = Object.keys(all).filter(k => k.startsWith('grammar_'));

    if (domain) {
      // Clear specific domain
      const toRemove = grammarKeys.filter(k => all[k].cacheKey?.startsWith(domain));
      await chrome.storage.local.remove(toRemove);
      console.log('[Grammar Generator] Cleared cache for domain:', domain, '(', toRemove.length, 'entries)');
    } else {
      // Clear all
      await chrome.storage.local.remove(grammarKeys);
      console.log('[Grammar Generator] Cleared all grammar cache (', grammarKeys.length, 'entries)');
    }

  } catch (error) {
    console.error('[Grammar Generator] Cache clear error:', error);
  }
}

/**
 * Get cache statistics
 *
 * @returns {Promise<Object>} Cache stats
 */
export async function getGrammarCacheStats() {
  try {
    const all = await chrome.storage.local.get(null);
    const grammarKeys = Object.keys(all).filter(k => k.startsWith('grammar_'));

    const stats = {
      totalEntries: grammarKeys.length,
      totalSize: 0,
      oldestEntry: null,
      newestEntry: null,
      byDomain: {}
    };

    grammarKeys.forEach(key => {
      const entry = all[key];
      const size = JSON.stringify(entry).length;
      stats.totalSize += size;

      if (!stats.oldestEntry || entry.timestamp < stats.oldestEntry.timestamp) {
        stats.oldestEntry = entry;
      }

      if (!stats.newestEntry || entry.timestamp > stats.newestEntry.timestamp) {
        stats.newestEntry = entry;
      }

      // Track by domain
      const domain = entry.cacheKey?.split(':')[0];
      if (domain) {
        stats.byDomain[domain] = (stats.byDomain[domain] || 0) + 1;
      }
    });

    return stats;

  } catch (error) {
    console.error('[Grammar Generator] Stats error:', error);
    return { totalEntries: 0, totalSize: 0 };
  }
}

console.log('[Grammar Generator] Module ready');
