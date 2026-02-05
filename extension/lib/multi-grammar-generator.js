/**
 * Multi-Grammar Generator
 *
 * Generates multiple specialized grammars for hierarchical parsing
 * Each grammar extracts one type of element (INPUT, SELECT, etc.)
 */

import { generateText } from './chrome-prompt-api.js';
import { preprocessHTML } from './html-preprocessor.js';

console.log('[Multi-Grammar Generator] Module loaded');

// Default prompt template
export const DEFAULT_MULTI_GRAMMAR_PROMPT = `You are an IXML grammar architect. Generate a SET of specialized grammars for parsing this form.

**IMPORTANT**: The HTML has been preprocessed to pipe-delimited format:
- All angle brackets < and > have been replaced with pipes |
- Example: <input type="text"> becomes |input type="text"|

**Preprocessed Form**:
\`\`\`
{PREPROCESSED_HTML}
\`\`\`

**Task**: Generate 2-3 specialized grammars, each extracting ONE type of element.

**Multi-Grammar Architecture**:
1. Each grammar focuses on ONE element type (input, select, textarea)
2. Structure: document → item* → (target-el | skip)
3. The skip rule ignores everything else
4. Results from all grammars are combined

**Working Example: INPUT-Only Grammar**:
\`\`\`ixml
{ INPUT-Only Grammar - Specialized Extractor }

document: item* .

item: input-el | skip .

input-el: -"|input", input-attrs?, -"|" .

input-attrs: " ", ~["|"]+ .

skip: ~["|"]+ | -"|", -skip-content, -"|" .
-skip-content: ~["|"]* .
\`\`\`

**Working Example: SELECT-Only Grammar**:
\`\`\`ixml
{ SELECT-Only Grammar - Specialized Extractor }

document: item* .

item: select-el | skip .

select-el: -"|SELECT", select-attrs, -"|", select-body, -"|/SELECT|"
         | -"|select", select-attrs, -"|", select-body, -"|/select|" .

select-attrs: (" ", ~["|"]+) | "" .

select-body: body-part* .
body-part: text-part | nested-tag .

text-part: ~["|"]+ .

nested-tag: -"|OPTION", -attrs?, -"|", option-text, -"|/OPTION|"
          | -"|option", -attrs?, -"|", option-text, -"|/option|"
          | -"|", -other-tag-name, -attrs?, -"|", -any-content, -"|/", -other-tag-name, -"|"
          | -"|", -other-tag-name, -attrs?, -"|" .

option-text: ~["|"]+ .

-attrs: " ", ~["|"]+ .
-other-tag-name: ~["|/ "]+ .
-any-content: (~["|"] | nested-pipe)* .
-nested-pipe: "|", ~["/"] .

skip: ~["|"]+ | -"|", -skip-content, -"|" .
-skip-content: ~["|"]* .
\`\`\`

**CRITICAL rustixml Syntax Rules**:
- Use ~["|"] to match any character EXCEPT pipes (NOT [^|])
- NEVER combine marks with negation: -~[...]+ is INVALID
- Instead use named rules: -skip-content: ~["|"]* .
- Each grammar should be FOCUSED on one element type
- Use the same skip pattern in all grammars

**Output Format** (JSON ONLY, no explanation):
{
  "grammars": [
    {
      "name": "input-only",
      "description": "Extracts INPUT elements",
      "grammar": "{ INPUT-Only Grammar }\\n\\ndocument: item* .\\n\\nitem: input-el | skip .\\n\\ninput-el: -\\"|input\\", input-attrs?, -\\"|" .\\n\\ninput-attrs: \\" \\", ~[\\"|\\"]+ .\\n\\nskip: ~[\\"|\\"]+ | -\\"|\\", -skip-content, -\\"|" .\\n-skip-content: ~[\\"|\\"]* ."
    },
    {
      "name": "select-only",
      "description": "Extracts SELECT elements",
      "grammar": "..."
    }
  ]
}

Analyze the preprocessed form and generate specialized grammars for the element types you find (typically INPUT and SELECT).`;

/**
 * Generate multiple specialized grammars
 *
 * @param {string} html - HTML content containing form
 * @param {Object} options - Generation options
 * @returns {Promise<Object>} Grammar set and metadata
 */
export async function generateMultiGrammar(html, options = {}) {
  const {
    promptTemplate = DEFAULT_MULTI_GRAMMAR_PROMPT,
    sampleSize = 3000
  } = options;

  console.log('[Multi-Grammar] Generating grammar set...');

  try {
    // Extract form HTML
    const formHTML = extractFormHTML(html, sampleSize);

    if (!formHTML) {
      throw new Error('No form found in HTML');
    }

    // Preprocess
    const preprocessed = preprocessHTML(formHTML);
    console.log('[Multi-Grammar] Preprocessed form:', preprocessed.length, 'bytes');

    // Replace template variables
    const prompt = promptTemplate
      .replace('{PREPROCESSED_HTML}', preprocessed.substring(0, 800) + '\n...(truncated)');

    console.log('[Multi-Grammar] Sending prompt to LLM...');

    // Generate with LLM
    const response = await generateText(prompt, {
      temperature: 0.1,
      maxTokens: 3000 // More tokens for multiple grammars
    });

    console.log('[Multi-Grammar] LLM response received');

    // Parse JSON response
    let grammarSet;
    try {
      // Remove markdown code fences if present
      let cleaned = response.trim();
      cleaned = cleaned.replace(/^```json\n?/, '').replace(/\n?```$/, '');
      cleaned = cleaned.trim();

      grammarSet = JSON.parse(cleaned);
    } catch (parseError) {
      console.error('[Multi-Grammar] Failed to parse JSON:', parseError);
      console.error('[Multi-Grammar] Response was:', response);
      throw new Error(`Failed to parse grammar set: ${parseError.message}`);
    }

    // Validate grammar set
    if (!grammarSet.grammars || !Array.isArray(grammarSet.grammars)) {
      throw new Error('Invalid grammar set format');
    }

    console.log('[Multi-Grammar] Generated', grammarSet.grammars.length, 'grammars:',
      grammarSet.grammars.map(g => g.name).join(', '));

    // Auto-fix common errors in each grammar
    grammarSet.grammars.forEach(g => {
      g.grammar = fixCommonGrammarErrors(g.grammar);
    });

    return {
      grammars: grammarSet.grammars,
      count: grammarSet.grammars.length,
      formSample: formHTML.substring(0, 500)
    };

  } catch (error) {
    console.error('[Multi-Grammar] Failed:', error);
    throw error;
  }
}

/**
 * Extract form HTML from page
 */
function extractFormHTML(html, sampleSize) {
  const formMatch = html.match(/<form[^>]*>[\s\S]*?<\/form>/i);

  if (formMatch) {
    let formHTML = formMatch[0];

    if (formHTML.length > sampleSize) {
      formHTML = formHTML.substring(0, sampleSize);
    }

    return formHTML;
  }

  // No form tag - extract interactive elements
  const interactivePattern = /<(input|select|textarea|button)[^>]*>[\s\S]{0,200}/gi;
  const matches = html.match(interactivePattern);

  if (matches && matches.length > 0) {
    return matches.slice(0, 10).join('\n');
  }

  return null;
}

/**
 * Fix common grammar errors
 */
function fixCommonGrammarErrors(grammar) {
  // Fix 1: Cannot combine mark (-) with negation (~)
  const invalidPattern = /-~\[([^\]]+)\]([*+?])/g;

  if (invalidPattern.test(grammar)) {
    console.log('[Multi-Grammar] ⚠️ Found invalid -~[...] pattern, fixing...');
    grammar = grammar.replace(/-~\[/g, '~[');
  }

  return grammar;
}

/**
 * Get custom prompt template from storage
 */
export async function getPromptTemplate() {
  try {
    const result = await chrome.storage.local.get(['customGrammarPrompt', 'useCustomPrompt']);

    if (result.useCustomPrompt && result.customGrammarPrompt) {
      console.log('[Multi-Grammar] Using custom prompt template');
      return result.customGrammarPrompt;
    }

    return DEFAULT_MULTI_GRAMMAR_PROMPT;

  } catch (error) {
    console.error('[Multi-Grammar] Failed to load custom prompt:', error);
    return DEFAULT_MULTI_GRAMMAR_PROMPT;
  }
}

/**
 * Save custom prompt template
 */
export async function savePromptTemplate(template) {
  try {
    await chrome.storage.local.set({
      customGrammarPrompt: template,
      useCustomPrompt: true
    });

    console.log('[Multi-Grammar] Custom prompt template saved');
    return { success: true };

  } catch (error) {
    console.error('[Multi-Grammar] Failed to save prompt:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Reset to default prompt
 */
export async function resetPromptTemplate() {
  try {
    await chrome.storage.local.set({
      useCustomPrompt: false
    });

    console.log('[Multi-Grammar] Reset to default prompt');
    return { success: true };

  } catch (error) {
    console.error('[Multi-Grammar] Failed to reset:', error);
    return { success: false, error: error.message };
  }
}

console.log('[Multi-Grammar Generator] Module ready');
