/**
 * CheerpJ runtime — library-style runtime backed by a localhost iframe.
 *
 * Architecture:
 *   App code calls host.runtimes.get('cheerpj').runMain({...})
 *     → this runtime impl sends a postMessage command via
 *       `host.message.send('cheerpj', ...)` to the wrapper relay, which
 *       routes to the cheerpj-app extension page, which forwards to the
 *       http://localhost:9877/cheerpj-runtime.html iframe where CheerpJ
 *       actually runs. Result flows back the same path.
 *
 * The localhost iframe approach sidesteps every MV3 extension-sandbox
 * quirk CheerpJ hits when run directly inside the extension: chrome.runtime
 * deprecation in c.js, MessagePort transfer failures across sandbox
 * boundaries, unsafe-eval CSP rejection in extension_pages.
 *
 * Runtime type: primarily 'library' (loadLibrary-style) but the simplest
 * first-class API exposed here is `runMain(jarBytes, className, args)` →
 * `{ exitCode, stdout }`. Proxy-walk loadLibrary + call is deferred until
 * we've resolved the nested-iframe Proxy hang.
 *
 * Classic-script file (not ESM). Loaded before host-chrome-extension.js.
 */

(function () {
  'use strict';

  function CheerpJRuntime(opts) {
    this.type = 'library';
    this.name = 'cheerpj';
    this.dependsOn = [];
    this._opts = opts || {};
    this._initPromise = null;
    this._error = null;
  }

  CheerpJRuntime.prototype.init = function (options) {
    if (this._initPromise) return this._initPromise;
    // Ensure the runtime iframe is loaded in its host page. We rely on a
    // dedicated extension page at chrome-extension://<id>/cheerpj-app/cheerpj.html
    // which embeds the localhost iframe and exposes window.CheerpJHost.
    //
    // For Phase 1.5 spike, that page must be opened manually (via CDP or
    // by the user) before this runtime is useful. A production version
    // would use the chrome.offscreen API to create the page on demand.
    var self = this;
    this._initPromise = (async function () {
      // At Phase 1.5, the runtime is usable as soon as the cheerpj-app
      // page has signaled readiness. Readiness is checked by pinging.
      try {
        await self._send('ping', {}, 5000);
        return true;
      } catch (e) {
        self._error = 'cheerpj-app/cheerpj.html is not open. Open it and retry.';
        throw new Error(self._error);
      }
    })();
    return this._initPromise;
  };

  CheerpJRuntime.prototype.isReady = function () {
    return !!this._initPromise;
  };

  CheerpJRuntime.prototype.getError = function () {
    return this._error;
  };

  /**
   * Run a Java main method from a JAR and capture stdout.
   *
   * @param {object} opts
   * @param {string} opts.jarUrl       Primary JAR URL (contains the main class)
   * @param {string[]} [opts.extraJars] Additional JAR URLs joined onto classpath
   * @param {string} opts.className    Fully-qualified class name with a main method
   * @param {string[]} [opts.args]     String args for main(String[] args)
   * @param {string} [opts.cacheKey]   Virtual JAR filename
   * @returns {Promise<{success: boolean, exitCode: number, stdout: string}>}
   */
  CheerpJRuntime.prototype.runMain = function (opts) {
    var self = this;
    return this.init().then(function () {
      return self._send('runMain', {
        jarUrl: opts.jarUrl,
        extraJars: opts.extraJars || [],
        className: opts.className,
        args: opts.args || [],
        cacheKey: opts.cacheKey,
      }, 120000);
    });
  };

  /**
   * Internal: send a command to the cheerpj-app page via host.message.send.
   */
  CheerpJRuntime.prototype._send = function (command, payload, timeoutMs) {
    // We route through the generic host.message.send channel which will
    // forward to whichever side has installed a 'cheerpj' listener.
    // In the chrome-extension host, that listener lives inside the
    // cheerpj-app/cheerpj.html page (window.CheerpJHost.*).
    //
    // The wrapper/service-worker message router will resolve 'cheerpj' as
    // a dispatch target once we register a handler there. For the Phase 1.5
    // spike, callers can invoke this directly from inside cheerpj-app via
    // window.CheerpJHost.runMain(...) — the runtime wrapper is for
    // registration completeness.
    if (typeof window !== 'undefined' && window.CheerpJHost && window.CheerpJHost[command]) {
      // In-process shortcut — we're already in cheerpj-app/cheerpj.html
      return window.CheerpJHost[command](payload);
    }
    // Otherwise route via host.message
    if (typeof window !== 'undefined' && window.Host && window.Host.get) {
      return window.Host.get().message.send('cheerpj-' + command, payload, { timeoutMs: timeoutMs });
    }
    return Promise.reject(new Error('No host.message transport available for cheerpj runtime'));
  };

  // Export
  if (typeof window !== 'undefined') {
    window.HostRuntimeCheerpJ = CheerpJRuntime;
  }
})();
