/**
 * Attempts to initialize CheerpJ after loader.js has loaded.
 * Runs AFTER loader.js.
 */

(function () {
  'use strict';
  var logLine = window._cjLog;
  if (!logLine) return;

  logLine('info', '--- CheerpJ loader ---');
  logLine('info', 'cheerpjInit defined: ' + (typeof cheerpjInit === 'function'));
  logLine('info', 'cj3LoaderPath: ' + (typeof cj3LoaderPath !== 'undefined' ? cj3LoaderPath : '(undefined)'));

  if (typeof cheerpjInit !== 'function') {
    logLine('err', 'cheerpjInit is not a function — loader did not run?');
    return;
  }

  (async function () {
    try {
      logLine('info', '--- Calling cheerpjInit({ version: 11 }) ---');
      var t0 = performance.now();
      // Per AAV Gotcha #1: always pass version (8 for Java 8 layout, 11 for Java 11 modules)
      // status: 'none' suppresses the default CheerpJ loading overlay
      // clipboardMode: 'none' avoids permissions prompts
      await cheerpjInit({
        clipboardMode: 'none',
        status: 'none',
        version: 8,  // Java 8 — smaller JRE, works for simple tests
      });
      logLine('ok', 'cheerpjInit completed in ' + (performance.now() - t0).toFixed(0) + 'ms');
      logLine('info', 'API check:');
      logLine('info', '  cheerpjRunMain: ' + (typeof cheerpjRunMain));
      logLine('info', '  cheerpjRunJar: ' + (typeof cheerpjRunJar));
      logLine('info', '  cheerpjRunLibrary: ' + (typeof cheerpjRunLibrary));
      logLine('info', '  cheerpOSAddStringFile: ' + (typeof cheerpOSAddStringFile));

      logLine('ok', '--- Spike complete: CheerpJ initialized ---');
    } catch (err) {
      logLine('err', 'Error: ' + (err && err.stack || err));
      logLine('err', 'Error message: ' + (err && err.message));
    }
  })();
})();
