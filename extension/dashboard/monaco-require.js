// Must run after loader.js — configures AMD paths and loads the editor.
require.config({
  paths: { vs: chrome.runtime.getURL('dashboard/lib/monaco/vs') },
  // Disable the CSS plugin: all CSS is already in editor.main.css loaded via <link>.
  // Without this, Monaco tries to load dozens of individual .css files that don't
  // exist in the CDN min build, producing console errors for each missing file.
  config: { 'vs/css': { disabled: true } }
});

// Pre-register the TypeScript/JavaScript language worker module as a no-op stub.
// editor.main.js lazy-loads vs/language/typescript/tsMode when any editor is created
// with language:'javascript' or 'typescript', but this file is NOT included in the
// CDN min build. Without this stub, the require() inside Monaco's onLanguage()
// callback fails with an unhandled "Uncaught (in promise) Error: [object Event]".
define('vs/language/typescript/tsMode', [], function () {
  return {
    setupTypeScript: function () {},
    setupJavaScript: function () {},
  };
});

require(['vs/editor/editor.main'], function () {
  window._monacoReady = true;
  window.dispatchEvent(new CustomEvent('monaco-ready'));
});
