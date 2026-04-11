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
     * @param {string} opts.jarUrl       Primary JAR URL (contains the main class)
     * @param {string[]} [opts.extraJars] Additional JAR URLs joined onto classpath
     *                                    (wrappers, dependencies, etc.)
     * @param {string} opts.className    Fully-qualified class with main
     * @param {string[]} [opts.args]     String args passed to main(String[] args)
     * @param {string} [opts.cacheKey]   Virtual JAR filename for the primary JAR
     * @param {object} [opts.options]    cheerpjInit options
     * @returns {Promise<{success: boolean, exitCode: number, stdout: string}>}
     */
    runMain: function (opts) {
      if (!opts || !opts.jarUrl || !opts.className) {
        return Promise.reject(new Error('runMain: jarUrl and className required'));
      }
      function fetchBytes(url) {
        return fetch(url).then(function (r) {
          if (!r.ok) throw new Error('fetch failed: ' + url + ' ' + r.status);
          return r.arrayBuffer();
        }).then(function (buf) { return new Uint8Array(buf); });
      }
      var primaryP = fetchBytes(opts.jarUrl);
      var extraUrls = Array.isArray(opts.extraJars) ? opts.extraJars : [];
      var extraP = Promise.all(extraUrls.map(function (url) {
        return fetchBytes(url).then(function (bytes) {
          // Derive a cacheKey from the URL filename
          var name = url.split('/').pop().replace(/\.jar$/, '').replace(/[^A-Za-z0-9_-]/g, '_');
          return { bytes: bytes, cacheKey: name + '-' + bytes.length };
        });
      }));
      return Promise.all([primaryP, extraP]).then(function (parts) {
        var bytes = parts[0];
        var extraJars = parts[1];
        return sendCommand('runMain', {
          bytes: bytes,
          cacheKey: opts.cacheKey || ('jar-' + bytes.length),
          sourceUrl: opts.jarUrl,
          extraJars: extraJars,
          className: opts.className,
          args: opts.args || [],
          options: opts.options || {},
        }, opts.timeoutMs || 600000); // 10 min — Jython cold init can hit several minutes
      });
    },
  };

  logLine('info', 'extension host page loaded; waiting for runtime iframe');

  // ---- Service worker message routing ----
  //
  // When this page runs as an offscreen document, the service worker routes
  // CHEERPJ_INVOKE messages here. We dispatch each to the corresponding
  // CheerpJHost method and return the result via the sendResponse callback.
  //
  // Must return `true` from the onMessage listener to keep sendResponse
  // alive for the async reply (standard MV3 pattern).
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || msg.type !== 'CHEERPJ_INVOKE') return;
      var command = msg.command;
      var payload = msg.payload || {};

      var handler = window.CheerpJHost[command];
      if (typeof handler !== 'function') {
        sendResponse({ success: false, error: 'unknown command: ' + command });
        return true;
      }

      // For init/ping, pass options directly. For runMain, the payload is
      // the opts object already.
      var promise;
      if (command === 'init') {
        promise = handler.call(window.CheerpJHost, payload.options || {});
      } else if (command === 'ping') {
        promise = handler.call(window.CheerpJHost);
      } else if (command === 'runMain') {
        promise = handler.call(window.CheerpJHost, payload);
      } else {
        promise = handler.call(window.CheerpJHost, payload);
      }

      promise.then(function (result) {
        sendResponse({ success: true, ...result });
      }).catch(function (err) {
        sendResponse({ success: false, error: (err && err.message) || String(err) });
      });

      return true; // async response
    });
    logLine('info', 'chrome.runtime.onMessage listener installed (offscreen mode)');

    // Tell the service worker we're ready to receive CHEERPJ_INVOKE. This
    // solves the race where the service worker calls chrome.runtime.sendMessage
    // before the listener is installed and gets "port closed before response".
    try {
      chrome.runtime.sendMessage({ type: 'CHEERPJ_OFFSCREEN_READY' }, function () {
        if (chrome.runtime.lastError) {
          logLine('err', 'ready signal error: ' + chrome.runtime.lastError.message);
        } else {
          logLine('ok', 'ready signal acknowledged by service worker');
        }
      });
    } catch (e) {
      logLine('err', 'failed to signal ready: ' + e.message);
    }
  }
})();
