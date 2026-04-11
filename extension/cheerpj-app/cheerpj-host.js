/**
 * CheerpJ runtime host — non-sandboxed extension page that embeds the
 * localhost iframe and exposes a Promise-based API at window.CheerpJHost.
 *
 * Architecture: this page is at chrome-extension://<id>/cheerpj-app/cheerpj.html
 * (non-sandboxed, full chrome.runtime access). It embeds
 * http://localhost:9877/cheerpj-runtime.html as a child iframe, which actually
 * runs CheerpJ (served by packages/bridge/asset-server.mjs). Communication is
 * via window.postMessage with a request/response ID pattern.
 *
 * Why: CheerpJ needs `new Function()` (unsafe-eval), which MV3 forbids in
 * extension_pages CSP. Sandbox pages allow it but break MessageChannel/Port
 * transfer across the sandbox boundary. Hosting CheerpJ in a localhost iframe
 * gives it a normal `http://` origin where CheerpJ's own CSP handling applies
 * and postMessage works normally. The extension page is a thin relay.
 */

(function () {
  'use strict';

  var log = document.getElementById('log');
  log.textContent = '';

  function logLine(cls, msg) {
    var line = document.createElement('div');
    line.className = cls;
    line.textContent = '[' + new Date().toISOString().slice(11, 23) + '] ' + msg;
    log.appendChild(line);
    console.log('[cheerpj-host]', cls.toUpperCase(), msg);
  }

  var iframe = document.getElementById('runtimeFrame');
  var runtimeReady = false;
  var runtimeReadyPromise = new Promise(function (resolve) {
    window.addEventListener('message', function onReady(event) {
      if (!event.data || event.data.source !== 'agentidev-cheerpj-ready') return;
      window.removeEventListener('message', onReady);
      runtimeReady = true;
      logLine('ok', 'runtime iframe ready');
      resolve();
    });
  });

  // ---- Request/response dispatch ----

  var _reqCounter = 0;
  var _pending = Object.create(null);

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.source !== 'agentidev-cheerpj-response') return;
    var entry = _pending[msg.id];
    if (!entry) return;
    clearTimeout(entry.timer);
    delete _pending[msg.id];
    if (msg.response && msg.response.success === false) {
      entry.reject(new Error(msg.response.error || 'runtime error'));
    } else {
      entry.resolve(msg.response);
    }
  });

  function sendCommand(type, payload, timeoutMs) {
    var id = 'cj-' + (++_reqCounter);
    var timeout = typeof timeoutMs === 'number' ? timeoutMs : 60000;
    return runtimeReadyPromise.then(function () {
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          delete _pending[id];
          reject(new Error('CheerpJ runtime timeout: ' + type + ' (' + timeout + 'ms)'));
        }, timeout);
        _pending[id] = { resolve: resolve, reject: reject, timer: timer };
        var message = Object.assign({ source: 'agentidev-cheerpj', id: id, type: type }, payload || {});
        iframe.contentWindow.postMessage(message, 'http://localhost:9877');
      });
    });
  }

  // ---- Public API ----

  window.CheerpJHost = {
    /** Ping the runtime. Returns { success, pong, cheerpjInitialized }. */
    ping: function () {
      return sendCommand('ping', {}, 5000);
    },

    /** Initialize CheerpJ. Idempotent — subsequent calls are no-ops. */
    init: function (options) {
      return sendCommand('init', { options: options || {} }, 30000);
    },

    /**
     * Run a Java main() method and capture its stdout.
     *
     * @param {object} opts
     * @param {string} opts.jarUrl       URL to fetch the JAR bytes from
     * @param {string} opts.className    Fully-qualified class with main, e.g. 'com.agentidev.Hello'
     * @param {string[]} [opts.args]     String args passed to main(String[] args)
     * @param {string} [opts.cacheKey]   Virtual JAR filename (defaults to "jar-<size>")
     * @param {object} [opts.options]    cheerpjInit options
     * @returns {Promise<{success: boolean, exitCode: number, stdout: string}>}
     */
    runMain: function (opts) {
      if (!opts || !opts.jarUrl || !opts.className) {
        return Promise.reject(new Error('runMain: jarUrl and className required'));
      }
      return fetch(opts.jarUrl).then(function (r) {
        if (!r.ok) throw new Error('fetch failed: ' + r.status);
        return r.arrayBuffer();
      }).then(function (buf) {
        var bytes = new Uint8Array(buf);
        return sendCommand('runMain', {
          bytes: bytes,
          cacheKey: opts.cacheKey || ('jar-' + bytes.length),
          sourceUrl: opts.jarUrl,
          className: opts.className,
          args: opts.args || [],
          options: opts.options || {},
        }, 120000);
      });
    },
  };

  logLine('info', 'extension host page loaded; waiting for runtime iframe');
})();
