/**
 * Grammar Debugger
 *
 * LLM-powered grammar debugging loop for IXML parse errors.
 * Analyzes errors, suggests fixes, and retries parsing.
 *
 * Phase 2.1 Enhancement - Self-debugging automation
 */

import { generateText } from './chrome-prompt-api.js';

console.log('[Grammar Debugger] Module loaded');

/**
 * Debug grammar with LLM analysis and automatic retry
 *
 * @param {string} grammar - Original IXML grammar
 * @param {string} html - HTML that failed to parse
 * @param {string} error - Error message from parser
 * @param {Object} options - Debug options
 * @returns {Promise<Object>} Debug result with fixed grammar or failure
 */
export async function debugGrammar(grammar, html, error, options = {}) {
  const {
    maxRetries = 2,
    htmlSample = 1000 // Show limited HTML to LLM
  } = options;

  console.log('[Grammar Debugger] Starting debug loop...');
  console.log('[Grammar Debugger] Error:', error);

  const htmlSnippet = html.substring(0, htmlSample);

  const prompt = `You are debugging an IXML grammar that failed to parse HTML.

**Error**: ${error}

**Grammar**:
\`\`\`ixml
${grammar}
\`\`\`

**HTML Sample** (first ${htmlSample} chars):
\`\`\`html
${htmlSnippet}
\`\`\`

**Analysis Task**:
1. Identify why the grammar failed
2. Suggest a specific fix to the grammar
3. Explain your reasoning

**Common Issues**:
- "Unterminated character class" → Quote inside character class like [^<"]
- "Parse succeeded but input remains" → Grammar too specific, doesn't handle all HTML variations
- "Lexer error" → Invalid IXML syntax

**Important**:
- If the error is "input remains", the grammar may be too strict
- Consider making patterns more flexible
- Add optional whitespace handling
- Make sure the root rule can match the entire document

Provide your response in this format:

**Problem**: <brief explanation>

**Fix**: <what to change>

**Updated Grammar**:
\`\`\`ixml
<the corrected grammar>
\`\`\``;

  try {
    console.log('[Grammar Debugger] Sending error to LLM for analysis...');

    const response = await generateText(prompt, {
      temperature: 0.2, // Low temp for consistent fixes
      maxTokens: 2000
    });

    console.log('[Grammar Debugger] LLM response received');

    // Extract the fixed grammar from response
    const grammarMatch = response.match(/```ixml\n([\s\S]*?)\n```/);

    if (!grammarMatch) {
      console.error('[Grammar Debugger] Could not extract grammar from LLM response');
      return {
        success: false,
        error: 'Failed to extract fixed grammar from LLM response',
        llmResponse: response
      };
    }

    const fixedGrammar = grammarMatch[1].trim();

    // Extract problem and fix explanation
    const problemMatch = response.match(/\*\*Problem\*\*:\s*(.+?)(?:\n|$)/);
    const fixMatch = response.match(/\*\*Fix\*\*:\s*(.+?)(?:\n|$)/);

    const problem = problemMatch ? problemMatch[1].trim() : 'Unknown';
    const fix = fixMatch ? fixMatch[1].trim() : 'See updated grammar';

    console.log('[Grammar Debugger] ✓ Problem identified:', problem);
    console.log('[Grammar Debugger] ✓ Fix suggested:', fix);
    console.log('[Grammar Debugger] ✓ Updated grammar extracted');

    return {
      success: true,
      fixedGrammar: fixedGrammar,
      problem: problem,
      fix: fix,
      llmResponse: response
    };

  } catch (error) {
    console.error('[Grammar Debugger] Debug failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Debug loop with automatic retry
 *
 * @param {Function} grammarGenerator - Function that generates grammar
 * @param {Function} parser - Function that parses with grammar
 * @param {string} html - HTML to parse
 * @param {Object} options - Options
 * @returns {Promise<Object>} Final result after debug attempts
 */
export async function debugLoopWithRetry(grammarGenerator, parser, html, options = {}) {
  const {
    maxAttempts = 3,
    enableDebugging = true
  } = options;

  console.log('[Grammar Debugger] Debug loop enabled, max attempts:', maxAttempts);

  let currentGrammar = await grammarGenerator();
  let attempt = 1;
  const debugHistory = [];

  while (attempt <= maxAttempts) {
    console.log(`[Grammar Debugger] Attempt ${attempt}/${maxAttempts}`);

    try {
      // Try parsing with current grammar
      const result = await parser(html, currentGrammar);

      if (result.success && result.method === 'ixml') {
        console.log('[Grammar Debugger] ✓ Parse successful on attempt', attempt);
        return {
          success: true,
          result: result,
          attempts: attempt,
          debugHistory: debugHistory,
          finalGrammar: currentGrammar
        };
      }

      // If we got here, parsing failed
      throw new Error(result.error || 'Parsing failed');

    } catch (error) {
      console.log(`[Grammar Debugger] Attempt ${attempt} failed:`, error.message);

      // If this was the last attempt or debugging is disabled, give up
      if (attempt >= maxAttempts || !enableDebugging) {
        console.log('[Grammar Debugger] ✗ Max attempts reached, giving up');
        return {
          success: false,
          error: error.message,
          attempts: attempt,
          debugHistory: debugHistory,
          finalGrammar: currentGrammar
        };
      }

      // Debug the grammar
      const debugResult = await debugGrammar(currentGrammar, html, error.message);

      debugHistory.push({
        attempt: attempt,
        error: error.message,
        problem: debugResult.problem,
        fix: debugResult.fix
      });

      if (!debugResult.success) {
        console.log('[Grammar Debugger] ✗ Debugging failed, giving up');
        return {
          success: false,
          error: 'Grammar debugging failed',
          attempts: attempt,
          debugHistory: debugHistory,
          finalGrammar: currentGrammar
        };
      }

      // Use the fixed grammar for next attempt
      currentGrammar = debugResult.fixedGrammar;
      attempt++;
    }
  }

  // Shouldn't reach here, but just in case
  return {
    success: false,
    error: 'Debug loop ended unexpectedly',
    attempts: attempt,
    debugHistory: debugHistory,
    finalGrammar: currentGrammar
  };
}

console.log('[Grammar Debugger] Module ready');
