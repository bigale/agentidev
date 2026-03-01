// Must run after loader.js — configures AMD paths and loads the editor.
require.config({
  paths: { vs: chrome.runtime.getURL('dashboard/lib/monaco/vs') },
  // Disable the CSS plugin: all CSS is already in editor.main.css loaded via <link>.
  // Without this, Monaco tries to create <link> tags for dozens of individual .css
  // files that don't exist in the CDN min build.
  config: { 'vs/css': { disabled: true } }
});

// Pre-register language service worker modules as no-op stubs.
//
// Monaco's CDN min build does NOT include these files — they're expected to be loaded
// on-demand from a full server. Without stubs, any editor creation triggers an AMD
// require() for the missing file → script 404 → error event → unhandled Promise rejection.
//
// vs/basic-languages/*/  tokenizer grammars ARE separate files (we vendor only javascript.js).
// vs/language/*/Mode     full language services — we don't need IntelliSense in a read-only editor.
define('vs/language/typescript/tsMode', [], function () {
  return { setupTypeScript: function () {}, setupJavaScript: function () {} };
});
define('vs/language/css/cssMode', [], function () {
  return { setupMode: function () {} };
});
define('vs/language/html/htmlMode', [], function () {
  return { setupMode: function () {} };
});
define('vs/language/json/jsonMode', [], function () {
  return { setupMode: function () {} };
});

require(['vs/editor/editor.main'], function () {
  window._monacoReady = true;
  window.dispatchEvent(new CustomEvent('monaco-ready'));
});
