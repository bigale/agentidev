/**
 * Semantic Element Finder
 *
 * Finds DOM elements by natural language intent using hybrid approach:
 * 1. Vector search narrows to top candidates (fast)
 * 2. LLM picks best match from candidates (accurate)
 *
 * This is Phase 2 of the DOM interaction architecture.
 */

import { searchDOM } from './dom-indexer.js';
import { generateText } from './chrome-prompt-api.js';

/**
 * Find element by natural language intent
 * Returns the best matching element selector
 *
 * @param {number} tabId - Tab ID to search in
 * @param {string} intent - Natural language description (e.g., "submit button")
 * @param {Object} options - Search options
 * @returns {Promise<Object>} Best match with selector and metadata
 */
export async function findElementByIntent(tabId, intent, options = {}) {
  const {
    topK = 5,
    confidenceThreshold = 0.9,
    scoreGapThreshold = 0.1,
    useLLM = true
  } = options;

  console.log(`[Semantic Finder] Finding: "${intent}" in tab ${tabId}`);

  // Step 1: Vector search to get candidates
  const candidates = await searchDOM(tabId, intent, { topK });

  if (candidates.length === 0) {
    console.log('[Semantic Finder] No candidates found');
    return {
      success: false,
      error: 'No matching elements found',
      intent
    };
  }

  console.log(`[Semantic Finder] Vector search returned ${candidates.length} candidates`);
  console.log(`[Semantic Finder] Top candidate: ${candidates[0].tagName} "${candidates[0].text || candidates[0].label}" (score: ${candidates[0].score.toFixed(3)})`);

  // Step 2: Check if we have a clear winner (skip LLM for speed)
  const topScore = candidates[0].score;
  const secondScore = candidates.length > 1 ? candidates[1].score : 0;
  const scoreGap = topScore - secondScore;

  const isClearWinner = (
    topScore >= confidenceThreshold &&
    scoreGap >= scoreGapThreshold
  );

  if (isClearWinner) {
    console.log(`[Semantic Finder] Clear winner (score: ${topScore.toFixed(3)}, gap: ${scoreGap.toFixed(3)})`);
    return {
      success: true,
      selector: candidates[0].selector,
      element: candidates[0],
      method: 'vector-only',
      confidence: topScore,
      intent
    };
  }

  // Step 3: Ambiguous case - use LLM to pick best match
  if (!useLLM || candidates.length === 1) {
    console.log('[Semantic Finder] Using top match without LLM');
    return {
      success: true,
      selector: candidates[0].selector,
      element: candidates[0],
      method: 'vector-only',
      confidence: topScore,
      intent
    };
  }

  console.log(`[Semantic Finder] Ambiguous matches (top score: ${topScore.toFixed(3)}, gap: ${scoreGap.toFixed(3)})`);
  console.log('[Semantic Finder] Using LLM to select best match...');

  try {
    const selected = await selectBestMatchWithLLM(intent, candidates);

    if (selected) {
      console.log(`[Semantic Finder] LLM selected: ${selected.tagName} "${selected.text || selected.label}"`);
      return {
        success: true,
        selector: selected.selector,
        element: selected,
        method: 'llm-selection',
        confidence: selected.score,
        llmReasoning: selected.llmReasoning,
        intent
      };
    } else {
      // LLM failed, fall back to top vector match
      console.log('[Semantic Finder] LLM selection failed, using top vector match');
      return {
        success: true,
        selector: candidates[0].selector,
        element: candidates[0],
        method: 'vector-fallback',
        confidence: topScore,
        intent
      };
    }

  } catch (error) {
    console.error('[Semantic Finder] LLM selection error:', error);
    // Fall back to top vector match
    return {
      success: true,
      selector: candidates[0].selector,
      element: candidates[0],
      method: 'vector-fallback',
      confidence: topScore,
      error: error.message,
      intent
    };
  }
}

/**
 * Use LLM to select the best match from candidates
 * @param {string} intent - User's search intent
 * @param {Array} candidates - Candidate elements from vector search
 * @returns {Promise<Object>} Selected element
 */
async function selectBestMatchWithLLM(intent, candidates) {
  // Build prompt with candidate descriptions
  const candidateDescriptions = candidates.map((candidate, index) => {
    const parts = [];

    // Number
    parts.push(`${index + 1}.`);

    // Element type
    parts.push(candidate.tagName);
    if (candidate.attributes?.type) {
      parts.push(`(${candidate.attributes.type})`);
    }

    // Label or text (most important!)
    const displayText = candidate.label || candidate.text || candidate.attributes?.placeholder || candidate.attributes?.ariaLabel;
    if (displayText) {
      parts.push(`- Label: "${displayText.substring(0, 60)}"`);
    } else {
      parts.push('- (no label)');
    }

    // Name/ID hints
    if (candidate.attributes?.name) {
      const hint = parseNameHint(candidate.attributes.name);
      if (hint) {
        parts.push(`- Hint: ${hint}`);
      } else {
        parts.push(`- name="${candidate.attributes.name}"`);
      }
    } else if (candidate.attributes?.id) {
      parts.push(`- id="${candidate.attributes.id}"`);
    }

    return parts.join(' ');
  }).join('\n');

  // Helper to parse name for human-readable hints
  function parseNameHint(name) {
    if (!name) return null;
    const lower = name.toLowerCase();

    // DOB patterns
    if (lower.includes('dob') && lower.includes('dd')) return 'Date of Birth Day';
    if (lower.includes('dob') && lower.includes('mm')) return 'Date of Birth Month';
    if (lower.includes('dob') && lower.includes('yy')) return 'Date of Birth Year';

    // Generic date patterns
    if (lower.includes('dd') && !lower.includes('address')) return 'Day field';
    if (lower.includes('mm') && !lower.includes('comm')) return 'Month field';
    if (lower.includes('yy') || lower.includes('year')) return 'Year field';

    // CC patterns
    if ((lower.includes('cc') || lower.includes('card')) && lower.includes('mm')) return 'Card Expiration Month';
    if ((lower.includes('cc') || lower.includes('card')) && lower.includes('yy')) return 'Card Expiration Year';

    return null;
  }

  const prompt = `You are helping locate the correct form field on a web page.

The user is looking for: "${intent}"

Here are the candidate elements (pick ONE):
${candidateDescriptions}

IMPORTANT:
- Read the user's intent carefully
- Match based on the label AND hint
- For "Date of Birth Day", pick the Day field with DOB/birth hint, NOT credit card or generic day
- For "password", pick password input, NOT password reset link
- Return ONLY a single number (1-${candidates.length})
- No explanation, just the number

Which element matches best? Number:`;

  console.log('[Semantic Finder] LLM Prompt:', prompt);

  try {
    const response = await generateText(prompt, {
      temperature: 0.1 // Low temperature for consistent selection
    });

    console.log('[Semantic Finder] LLM Response:', response.trim());

    // Extract number from response
    const match = response.trim().match(/\b([1-5])\b/);
    if (!match) {
      console.error('[Semantic Finder] Could not parse LLM response:', response);
      return null;
    }

    const selectedIndex = parseInt(match[1]) - 1;

    if (selectedIndex < 0 || selectedIndex >= candidates.length) {
      console.error('[Semantic Finder] LLM returned invalid index:', selectedIndex);
      return null;
    }

    const selected = candidates[selectedIndex];
    selected.llmReasoning = response.trim();

    return selected;

  } catch (error) {
    console.error('[Semantic Finder] LLM selection failed:', error);
    return null;
  }
}

/**
 * Find multiple elements matching intent
 * Useful for "find all buttons" type queries
 *
 * @param {number} tabId - Tab ID to search in
 * @param {string} intent - Natural language description
 * @param {Object} options - Search options
 * @returns {Promise<Array>} Array of matching elements
 */
export async function findElementsByIntent(tabId, intent, options = {}) {
  const {
    topK = 10,
    minScore = 0.7
  } = options;

  console.log(`[Semantic Finder] Finding multiple: "${intent}" in tab ${tabId}`);

  // Get more candidates for multiple matches
  const candidates = await searchDOM(tabId, intent, { topK });

  // Filter by minimum score
  const matches = candidates.filter(c => c.score >= minScore);

  console.log(`[Semantic Finder] Found ${matches.length} matches above threshold ${minScore}`);

  return matches.map(match => ({
    selector: match.selector,
    element: match,
    confidence: match.score
  }));
}

/**
 * Verify an element exists and matches expected properties
 * Useful for test assertions
 *
 * @param {number} tabId - Tab ID
 * @param {string} intent - Element description
 * @param {Object} expectedProps - Expected properties to verify
 * @returns {Promise<Object>} Verification result
 */
export async function verifyElement(tabId, intent, expectedProps = {}) {
  const result = await findElementByIntent(tabId, intent);

  if (!result.success) {
    return {
      success: false,
      error: 'Element not found',
      intent
    };
  }

  // Verify expected properties
  const element = result.element;
  const mismatches = [];

  if (expectedProps.tagName && element.tagName !== expectedProps.tagName.toLowerCase()) {
    mismatches.push(`Expected tag ${expectedProps.tagName}, got ${element.tagName}`);
  }

  if (expectedProps.type && element.attributes?.type !== expectedProps.type) {
    mismatches.push(`Expected type ${expectedProps.type}, got ${element.attributes?.type}`);
  }

  if (expectedProps.text && !element.text?.includes(expectedProps.text)) {
    mismatches.push(`Expected text containing "${expectedProps.text}", got "${element.text}"`);
  }

  if (mismatches.length > 0) {
    return {
      success: false,
      error: 'Element found but properties do not match',
      mismatches,
      element,
      intent
    };
  }

  return {
    success: true,
    element,
    selector: result.selector,
    intent
  };
}
