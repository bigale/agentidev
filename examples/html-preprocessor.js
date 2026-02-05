/**
 * HTML Preprocessor - Linear Text Transformations
 *
 * Purpose: Remove markup syntax noise to prepare for hierarchical IXML parsing
 *
 * Philosophy:
 * - Preprocessing = Linear (remove syntax)
 * - Parsing = Hierarchical (build meaning)
 */

/**
 * Strip <script> blocks entirely
 * @param {string} html - Input HTML
 * @returns {string} HTML without script blocks
 */
export function stripScriptTags(html) {
  // Match <script...>...</script> including attributes and content
  // Replace with space to maintain word boundaries
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
}

/**
 * Strip <style> blocks entirely
 * @param {string} html - Input HTML
 * @returns {string} HTML without style blocks
 */
export function stripStyleTags(html) {
  // Match <style...>...</style> including attributes and content
  // Replace with space to maintain word boundaries
  return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
}

/**
 * Remove angle brackets to linearize HTML
 * Transforms: <div class="foo">Hello</div>
 * Into:      div class="foo" Hello
 *
 * Note: Closing tags are removed entirely - we only keep opening tags
 *
 * @param {string} html - Input HTML
 * @returns {string} Linearized text without < and >
 */
export function removeAngleBrackets(html) {
  return html
    .replace(/<\/[^>]+>/g, ' ')  // Remove closing tags entirely: </div> → (space)
    .replace(/</g, ' ')          // <div> → div (with leading space)
    .replace(/>/g, ' ')          // Close bracket becomes space
    .replace(/\s+/g, ' ')        // Collapse multiple spaces
    .trim();
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

  // Step 3: Remove angle brackets
  const linearized = removeAngleBrackets(afterStyles);
  steps.push({
    step: 3,
    name: 'Remove angle brackets',
    input: afterStyles,
    output: linearized
  });

  return {
    original: html,
    final: linearized,
    steps: steps
  };
}

/**
 * Quick preprocessing (no intermediate steps)
 * @param {string} html - Raw HTML input
 * @returns {string} Linearized text ready for IXML parsing
 */
export function preprocess(html) {
  return removeAngleBrackets(
    stripStyleTags(
      stripScriptTags(html)
    )
  );
}

// Example usage and tests
if (typeof window !== 'undefined') {
  window.htmlPreprocessor = {
    stripScriptTags,
    stripStyleTags,
    removeAngleBrackets,
    preprocessHTML,
    preprocess
  };
}
