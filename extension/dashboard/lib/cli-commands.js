/**
 * Static registry of playwright-cli commands with typed argument definitions.
 * Browser-compatible copy of bridge/cli-commands.mjs for dashboard UI rendering.
 */

export const CLI_COMMANDS = {
  // ---- Navigation ----
  'goto':       { category: 'navigation', args: [{ name: 'url', type: 'url', required: true }] },
  'go-back':    { category: 'navigation', args: [] },
  'go-forward': { category: 'navigation', args: [] },
  'reload':     { category: 'navigation', args: [] },

  // ---- Interaction ----
  'click':   { category: 'interaction', args: [{ name: 'ref', type: 'ref', required: true }, { name: 'button', type: 'enum', values: ['left', 'right', 'middle'] }] },
  'fill':    { category: 'interaction', args: [{ name: 'ref', type: 'ref', required: true }, { name: 'text', type: 'text', required: true }] },
  'type':    { category: 'interaction', args: [{ name: 'text', type: 'text', required: true }] },
  'select':  { category: 'interaction', args: [{ name: 'ref', type: 'ref', required: true }, { name: 'val', type: 'text', required: true }] },
  'hover':   { category: 'interaction', args: [{ name: 'ref', type: 'ref', required: true }] },
  'check':   { category: 'interaction', args: [{ name: 'ref', type: 'ref', required: true }] },
  'uncheck': { category: 'interaction', args: [{ name: 'ref', type: 'ref', required: true }] },

  // ---- Keyboard ----
  'press': { category: 'keyboard', args: [{ name: 'key', type: 'text', required: true, placeholder: 'Enter, Tab, ArrowDown...' }] },

  // ---- Window ----
  'resize': { category: 'window', args: [{ name: 'w', type: 'number', required: true }, { name: 'h', type: 'number', required: true }] },

  // ---- Capture ----
  'screenshot': { category: 'capture', args: [{ name: 'ref', type: 'ref' }], options: [
    { name: 'filename', type: 'text' },
    { name: 'full-page', type: 'boolean' },
  ]},
  'pdf': { category: 'capture', args: [], options: [
    { name: 'filename', type: 'text' },
  ]},
  'snapshot': { category: 'capture', args: [] },

  // ---- Storage ----
  'state-load': { category: 'storage', args: [{ name: 'filename', type: 'file', required: true }] },
  'state-save': { category: 'storage', args: [{ name: 'filename', type: 'file' }] },
  'cookie-set': { category: 'storage', args: [
    { name: 'name', type: 'text', required: true },
    { name: 'value', type: 'text', required: true },
  ], options: [
    { name: 'domain', type: 'text' },
    { name: 'path', type: 'text' },
    { name: 'httpOnly', type: 'boolean' },
    { name: 'secure', type: 'boolean' },
  ]},
  'cookie-clear':       { category: 'storage', args: [] },
  'localstorage-set':   { category: 'storage', args: [{ name: 'key', type: 'text', required: true }, { name: 'value', type: 'text', required: true }] },
  'localstorage-clear': { category: 'storage', args: [] },

  // ---- Network ----
  'route': { category: 'network', args: [{ name: 'pattern', type: 'text', required: true, placeholder: '**/api/*' }], options: [
    { name: 'status', type: 'number', placeholder: '200' },
    { name: 'body', type: 'text' },
    { name: 'content-type', type: 'text' },
  ]},
  'unroute': { category: 'network', args: [{ name: 'pattern', type: 'text' }] },

  // ---- DevTools ----
  'eval':    { category: 'devtools', args: [{ name: 'func', type: 'code', required: true }, { name: 'ref', type: 'ref' }] },
  'console': { category: 'devtools', args: [{ name: 'min-level', type: 'enum', values: ['log', 'warn', 'error'] }] },

  // ---- Tabs ----
  'tab-new':    { category: 'tabs', args: [{ name: 'url', type: 'url' }] },
  'tab-select': { category: 'tabs', args: [{ name: 'index', type: 'number', required: true }] },
  'tab-close':  { category: 'tabs', args: [{ name: 'index', type: 'number' }] },

  // ---- Wait ----
  'wait-for-selector': { category: 'wait', args: [{ name: 'selector', type: 'text', required: true }], options: [
    { name: 'timeout', type: 'number', placeholder: '30000' },
    { name: 'state', type: 'enum', values: ['visible', 'hidden', 'attached', 'detached'] },
  ]},
  'wait-for-url': { category: 'wait', args: [{ name: 'pattern', type: 'text', required: true, placeholder: '**/dashboard' }], options: [
    { name: 'timeout', type: 'number', placeholder: '30000' },
  ]},
  'sleep': { category: 'wait', args: [{ name: 'ms', type: 'number', required: true, placeholder: '1000' }] },
};

export const CATEGORIES = {
  navigation:  'Navigation',
  interaction: 'Interaction',
  keyboard:    'Keyboard',
  window:      'Window',
  capture:     'Capture',
  storage:     'Storage',
  network:     'Network',
  devtools:    'DevTools',
  tabs:        'Tabs',
  wait:        'Wait',
};
