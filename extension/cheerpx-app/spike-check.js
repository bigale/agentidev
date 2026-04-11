/**
 * Runs AFTER cx.js loads. Checks if the CheerpX global is available
 * and probes factory methods.
 */

(function () {
  'use strict';
  var logLine = window._spikeLog;
  if (!logLine) return;

  logLine('info', '--- CheerpX ---');
  if (typeof CheerpX === 'undefined') {
    logLine('err', 'CheerpX global is NOT defined after loading cx.js');
    return;
  }
  logLine('ok', 'CheerpX global present');
  try {
    var keys = Object.keys(CheerpX).sort().join(', ');
    logLine('info', 'CheerpX keys: ' + keys);
  } catch (e) {
    logLine('err', 'Failed to enumerate CheerpX: ' + e.message);
  }

  var probeTargets = ['Linux', 'HttpBytesDevice', 'IDBDevice', 'OverlayDevice', 'CloudDevice'];
  for (var i = 0; i < probeTargets.length; i++) {
    var key = probeTargets[i];
    var obj = CheerpX[key];
    var hasType = obj && typeof obj.create === 'function';
    logLine(hasType ? 'ok' : 'info', '  CheerpX.' + key + '.create = ' + (hasType ? 'function' : 'absent'));
  }

  logLine('info', '--- Done with probe ---');
})();
