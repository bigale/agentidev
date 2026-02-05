/**
 * HTML Preprocessor - Pipe Delimiter Approach
 *
 * Converts HTML to pipe-delimited format for IXML parsing
 *
 * Philosophy:
 * - Preprocessing = Linear (remove syntax noise)
 * - Parsing = Hierarchical (build semantic meaning)
 *
 * Example:
 *   Input:  <form action="/login"><label>Email:</label><input type="email"></form>
 *   Output: |form action="/login"||label|Email:|/label||input type="email"||/form|
 */

console.log('[HTML Preprocessor] Module loaded');

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
 * Replace angle brackets with pipes to preserve structure
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
 * @returns {string} Pipe-delimited text ready for IXML parsing
 */
export function preprocessHTML(html) {
  console.log('[HTML Preprocessor] Starting preprocessing...');
  console.log('[HTML Preprocessor] Input length:', html.length);

  // Step 1: Strip scripts and styles
  let processed = stripScriptTags(html);
  processed = stripStyleTags(processed);
  console.log('[HTML Preprocessor] After stripping scripts/styles:', processed.length);

  // Step 2: Replace brackets with pipes
  processed = replaceBracketsWithPipes(processed);
  console.log('[HTML Preprocessor] After pipe replacement:', processed.length);
  console.log('[HTML Preprocessor] Sample output:', processed.substring(0, 200));

  return processed;
}

console.log('[HTML Preprocessor] Module ready');
