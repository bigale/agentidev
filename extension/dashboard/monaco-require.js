// Must run after loader.js — configures AMD paths and loads the editor.
require.config({
  paths: { vs: chrome.runtime.getURL('dashboard/lib/monaco/vs') }
});
require(['vs/editor/editor.main'], function () {
  window._monacoReady = true;
  window.dispatchEvent(new CustomEvent('monaco-ready'));
});
