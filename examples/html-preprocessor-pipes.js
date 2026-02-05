/**
 * HTML Preprocessor with Pipe Delimiters
 *
 * Replace angle brackets with pipes to preserve structure
 *
 * Philosophy:
 * - Preprocessing = Linear (replace syntax)
 * - Parsing = Hierarchical (build meaning)
 */

/**
 * Strip <script> blocks entirely
 * @param {string} html - Input HTML
 * @returns {string} HTML without script blocks
 */
export function stripScriptTags(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
}

/**
 * Strip <style> blocks entirely
 * @param {string} html - Input HTML
 * @returns {string} HTML without style blocks
 */
export function stripStyleTags(html) {
  return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
}

/**
 * Replace angle brackets with pipes
 * Transforms: <div class="foo">Hello</div>
 * Into:      |div class="foo"|Hello|/div|
 *
 * @param {string} html - Input HTML
 * @returns {string} Pipe-delimited text
 */
export function replaceBracketsWithPipes(html) {
  return html
    .replace(/</g, '|')       // < → |
    .replace(/>/g, '|')       // > → |
    .replace(/\|\|+/g, '||'); // Collapse multiple pipes to double pipe
}

/**
 * Complete preprocessing pipeline
 * @param {string} html - Raw HTML input
 * @returns {Object} Result with intermediate steps
 */
export function preprocessHTML(html) {
  const steps = [];

  // Step 1: Strip scripts
  const afterScripts = stripScriptTags(html);
  steps.push({
    step: 1,
    name: 'Strip <script> tags',
    input: html,
    output: afterScripts
  });

  // Step 2: Strip styles
  const afterStyles = stripStyleTags(afterScripts);
  steps.push({
    step: 2,
    name: 'Strip <style> tags',
    input: afterScripts,
    output: afterStyles
  });

  // Step 3: Replace brackets with pipes
  const pipeDelimited = replaceBracketsWithPipes(afterStyles);
  steps.push({
    step: 3,
    name: 'Replace angle brackets with pipes',
    input: afterStyles,
    output: pipeDelimited
  });

  return {
    original: html,
    final: pipeDelimited,
    steps: steps
  };
}

/**
 * Quick preprocessing (no intermediate steps)
 * @param {string} html - Raw HTML input
 * @returns {string} Pipe-delimited text ready for IXML parsing
 */
export function preprocess(html) {
  return replaceBracketsWithPipes(
    stripStyleTags(
      stripScriptTags(html)
    )
  );
}

// Example usage
if (typeof window !== 'undefined') {
  window.htmlPreprocessorPipes = {
    stripScriptTags,
    stripStyleTags,
    replaceBracketsWithPipes,
    preprocessHTML,
    preprocess
  };
}
