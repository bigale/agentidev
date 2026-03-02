/**
 * Snippet Library — parameterized Playwright code templates.
 * Each snippet generates native Playwright API code (page.goto, page.click, etc.)
 * that works with playwright-shim for bridge integration.
 *
 * Snippets are filled from manual input or from parsed snapshot elements.
 */

const SNIPPETS = [
  {
    id: 'navigate',
    name: 'Navigate to URL',
    category: 'navigation',
    description: 'Navigate page to a URL with checkpoint',
    params: [
      { name: 'url', label: 'URL', default: 'https://example.com' },
      { name: 'checkpoint', label: 'Checkpoint name', default: 'after_navigate' },
    ],
    template: `await page.goto('{{url}}');
await client.checkpoint('{{checkpoint}}');`,
  },
  {
    id: 'click',
    name: 'Click Element',
    category: 'interaction',
    description: 'Click an element by CSS selector or accessibility ref',
    params: [
      { name: 'selector', label: 'Selector', default: 'button[type="submit"]' },
      { name: 'description', label: 'Description', default: 'Submit button' },
    ],
    template: `await page.click('{{selector}}'); // {{description}}`,
  },
  {
    id: 'fill',
    name: 'Fill Input',
    category: 'interaction',
    description: 'Type text into an input field',
    params: [
      { name: 'selector', label: 'Selector', default: 'input[name="search"]' },
      { name: 'value', label: 'Value', default: '' },
    ],
    template: `await page.fill('{{selector}}', '{{value}}');`,
  },
  {
    id: 'waitForSelector',
    name: 'Wait For Element',
    category: 'interaction',
    description: 'Wait for an element to appear on the page',
    params: [
      { name: 'selector', label: 'Selector', default: '.results' },
      { name: 'timeout', label: 'Timeout (ms)', default: '30000' },
    ],
    template: `await page.waitForSelector('{{selector}}', { timeout: {{timeout}} });`,
  },
  {
    id: 'snapshot',
    name: 'Take Snapshot',
    category: 'data',
    description: 'Take an accessibility snapshot of the page',
    params: [],
    template: `const snap = await page.accessibility.snapshot();
console.log(JSON.stringify(snap, null, 2));`,
  },
  {
    id: 'evaluate',
    name: 'Evaluate JS',
    category: 'data',
    description: 'Run JavaScript in the page context',
    params: [
      { name: 'expr', label: 'Expression', default: 'document.title' },
    ],
    template: `const result = await page.evaluate(() => {{expr}});`,
  },
  {
    id: 'authPreflight',
    name: 'Auth Pre-Flight',
    category: 'auth',
    description: 'Verify session is authenticated before running script',
    params: [
      { name: 'sessionId', label: 'Session ID/name', default: 'SESSION' },
      { name: 'urlContains', label: 'URL must contain', default: 'example.com' },
      { name: 'indicators', label: 'Auth indicators (comma-separated)', default: 'logout, sign out, my account' },
    ],
    template: `await client.authGuard({{sessionId}}, {
  urlContains: '{{urlContains}}',
  snapshotContains: [{{indicators}}],
});`,
    renderValues(values) {
      // Format indicators as quoted array items
      if (values.indicators) {
        values.indicators = values.indicators.split(',')
          .map(s => `'${s.trim()}'`).join(', ');
      }
      return values;
    },
  },
  {
    id: 'scriptBoilerplate',
    name: 'Script Boilerplate',
    category: 'lifecycle',
    description: 'Full script skeleton with shim import, browser launch, and cleanup',
    params: [
      { name: 'scriptName', label: 'Script name', default: 'my_script' },
      { name: 'shimPath', label: 'Shim path', default: './playwright-shim.mjs' },
    ],
    template: `import { chromium } from '{{shimPath}}';

const browser = await chromium.launchPersistentContext('/tmp/pw-profile', {
  headless: false,
});
const page = browser.pages()[0] || await browser.newPage();

try {
  // --- Script logic here ---

  await client.complete({ success: true });
} catch (err) {
  if (err.name === 'ScriptCancelledError') {
    console.log('Script cancelled');
  } else {
    console.error(err);
    await client.reportError(err.message);
    await client.complete({ error: err.message });
  }
} finally {
  await browser.close();
  client.disconnect();
}`,
  },
  {
    id: 'loopWithProgress',
    name: 'Loop with Progress',
    category: 'lifecycle',
    description: 'For loop with progress reporting and checkpoint',
    params: [
      { name: 'items', label: 'Items variable', default: 'items' },
      { name: 'checkpoint', label: 'Checkpoint name', default: 'loop_start' },
    ],
    template: `for (let i = 0; i < {{items}}.length; i++) {
  await client.checkpoint('{{checkpoint}}', { step: i, total: {{items}}.length });
  await client.progress(i + 1, {{items}}.length, \`Processing \${i + 1}/\${{{items}}.length}\`);

  const item = {{items}}[i];
  // --- Process item here ---

  await client.sleep(1000);
}`,
  },
];

/**
 * Render a snippet by replacing {{param}} placeholders with values.
 * @param {string} snippetId - Snippet ID
 * @param {object} values - { paramName: value }
 * @returns {string} Rendered code
 */
export function renderSnippet(snippetId, values = {}) {
  const snippet = SNIPPETS.find(s => s.id === snippetId);
  if (!snippet) return '';

  // Allow snippet-specific value transforms
  let vals = { ...values };
  if (snippet.renderValues) {
    vals = snippet.renderValues(vals);
  }

  let code = snippet.template;
  for (const param of snippet.params) {
    const val = vals[param.name] ?? param.default ?? '';
    code = code.replace(new RegExp(`\\{\\{${param.name}\\}\\}`, 'g'), val);
  }
  return code;
}

/**
 * Get a snippet by ID.
 * @param {string} snippetId
 * @returns {object|null}
 */
export function getSnippet(snippetId) {
  return SNIPPETS.find(s => s.id === snippetId) || null;
}

/**
 * Get all snippets grouped by category.
 * @returns {object} { category: [snippet, ...] }
 */
export function getSnippetsByCategory() {
  const groups = {};
  for (const s of SNIPPETS) {
    if (!groups[s.category]) groups[s.category] = [];
    groups[s.category].push(s);
  }
  return groups;
}

/**
 * Get list of unique categories.
 * @returns {string[]}
 */
export function getCategories() {
  return [...new Set(SNIPPETS.map(s => s.category))];
}

/**
 * Given a parsed snapshot element, suggest the best snippet + pre-filled values.
 * @param {{ ref: string, role: string, text: string, type: string, name: string }} element
 * @returns {{ snippetId: string, values: object, label: string }[]}
 */
export function suggestFromElement(element) {
  const suggestions = [];
  const { ref, role, text, type } = element;

  // Build a selector from the ref
  const selector = ref ? `[ref="${ref}"]` : '';
  const desc = text || element.name || role || '';

  if (role === 'button' || role === 'link' || role === 'menuitem' || role === 'tab') {
    suggestions.push({
      snippetId: 'click',
      values: { selector, description: desc },
      label: `Click: ${desc}`,
    });
  }

  if (role === 'textbox' || role === 'searchbox' || role === 'combobox' ||
      (role === 'input' && (type === 'text' || type === 'email' || type === 'password' || type === 'search' || !type))) {
    suggestions.push({
      snippetId: 'fill',
      values: { selector, value: '' },
      label: `Fill: ${desc}`,
    });
  }

  if (role === 'checkbox' || role === 'radio' || role === 'switch') {
    suggestions.push({
      snippetId: 'click',
      values: { selector, description: `Select ${desc}` },
      label: `Select: ${desc}`,
    });
  }

  // Always offer "wait for this"
  suggestions.push({
    snippetId: 'waitForSelector',
    values: { selector, timeout: '30000' },
    label: `Wait for: ${desc}`,
  });

  return suggestions;
}

/**
 * Get all snippets (flat list).
 * @returns {object[]}
 */
export function getAllSnippets() {
  return SNIPPETS;
}
