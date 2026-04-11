/**
 * CheerpX Phase 1 spike — runs at extension page load.
 * Inline <script> is blocked by MV3 CSP, so we run as an external file.
 *
 * Step 1: environment checks (SharedArrayBuffer, crossOriginIsolated, etc.)
 * Step 2: verify CheerpX global is available after cx.js loads
 * Step 3: probe known factory methods
 * Step 4: (deferred) actually boot a VM and run a command
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
    console.log('[spike]', cls.toUpperCase(), msg);
  }

  window._spikeLog = logLine;

  // Environment checks
  logLine('info', '--- Environment ---');
  logLine('info', 'location: ' + location.href);
  logLine('info', 'crossOriginIsolated: ' + self.crossOriginIsolated);
  logLine('info', 'SharedArrayBuffer: ' + (typeof SharedArrayBuffer !== 'undefined'));
  logLine('info', 'WebAssembly: ' + (typeof WebAssembly !== 'undefined'));
  logLine('info', 'Atomics: ' + (typeof Atomics !== 'undefined'));
  logLine('info', 'navigator.hardwareConcurrency: ' + navigator.hardwareConcurrency);
})();
