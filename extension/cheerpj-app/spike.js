/**
 * CheerpJ Phase 1.5 spike — env checks + logger.
 * Runs BEFORE loader.js.
 */

(function () {
  'use strict';

  var log = document.getElementById('log');
  log.textContent = '';

  function logLine(cls, msg) {
    var line = document.createElement('div');
    line.className = cls;
    line.textContent = msg;
    log.appendChild(line);
    console.log('[cheerpj-spike]', cls.toUpperCase(), msg);
  }

  window._cjLog = logLine;

  logLine('info', '--- Environment ---');
  logLine('info', 'location: ' + location.href);
  logLine('info', 'crossOriginIsolated: ' + self.crossOriginIsolated);
  logLine('info', 'SharedArrayBuffer: ' + (typeof SharedArrayBuffer !== 'undefined'));
  logLine('info', 'WebAssembly: ' + (typeof WebAssembly !== 'undefined'));
})();
