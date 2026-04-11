/**
 * CheerpX runtime — vm-style runtime backed by a localhost iframe.
 *
 * Architecture:
 *   App code calls host.runtimes.get('cheerpx').spawn(cmd, args, opts)
 *     → this runtime impl sends a postMessage command via
 *       `host.message.send('cheerpx-spawn', ...)` to the wrapper relay,
 *       which routes to the cheerpx-app extension page, which forwards to
 *       the http://localhost:9877/cheerpx-runtime.html iframe where CheerpX
 *       actually runs (cross-origin isolated via asset-server COOP/COEP).
 *       Result flows back the same path.
 *
 * The localhost iframe approach unblocks the COI wall the original Phase 1
 * spike hit: extension pages can't easily be made cross-origin isolated,
 * but a localhost iframe with the right server headers can — and CheerpX
 * needs COI for SharedArrayBuffer + worker coordination.
 *
 * Runtime type: 'vm'. Exposes spawn(cmd, args, opts) → {exitCode, stdout}.
 * Streaming stdout (true ExecHandle) is a future enhancement; for now we
 * collect-and-return because the first consumers (test harnesses, hello-
 * python plugin) need the full output anyway.
 *
 * Classic-script file (not ESM). Loaded before host-chrome-extension.js.
 */

(function () {
  'use strict';

  function CheerpXRuntime(opts) {
    this.type = 'vm';
    this.name = 'cheerpx';
    this.dependsOn = [];
    this._opts = opts || {};
    this._initPromise = null;
    this._error = null;
  }

  CheerpXRuntime.prototype.init = function (options) {
    if (this._initPromise) return this._initPromise;
    var self = this;
    this._initPromise = (async function () {
      try {
        // ping first to confirm the chain is up; spawn() will lazily
        // trigger the actual VM boot inside the runtime page on first call.
        await self._send('ping', {}, 5000);
        return true;
      } catch (e) {
        self._error = 'CheerpX runtime not reachable: ' + (e && e.message || e);
        throw new Error(self._error);
      }
    })();
    return this._initPromise;
  };

  CheerpXRuntime.prototype.isReady = function () {
    return !!this._initPromise;
  };

  CheerpXRuntime.prototype.getError = function () {
    return this._error;
  };

  /**
   * Run a command in the Linux VM and capture stdout.
   *
   * @param {string} cmd        Absolute path to executable, e.g. '/usr/bin/python3'
   * @param {string[]} [args]   Argv (without argv[0])
   * @param {object} [opts]     cwd, env, uid, gid passed to CheerpX.Linux.run
   * @returns {Promise<{success: boolean, exitCode: number, stdout: string, elapsedMs: number}>}
   */
  CheerpXRuntime.prototype.spawn = function (cmd, args, opts) {
    var self = this;
    return this.init().then(function () {
      return self._send('spawn', {
        cmd: cmd,
        args: args || [],
        opts: opts || {},
      }, 300000);
    });
  };

  /**
   * Internal: send a command to the cheerpx-app page via host.message.send,
   * or directly if we're already inside that page (testing).
   */
  CheerpXRuntime.prototype._send = function (command, payload, timeoutMs) {
    if (typeof window !== 'undefined' && window.CheerpXHost && window.CheerpXHost[command]) {
      // In-process shortcut — we're already in cheerpx-app/cheerpx.html
      return window.CheerpXHost[command](payload);
    }
    if (typeof window !== 'undefined' && window.Host && window.Host.get) {
      return window.Host.get().message.send('cheerpx-' + command, payload, { timeoutMs: timeoutMs });
    }
    return Promise.reject(new Error('No host.message transport available for cheerpx runtime'));
  };

  // Export
  if (typeof window !== 'undefined') {
    window.HostRuntimeCheerpX = CheerpXRuntime;
  }
})();
