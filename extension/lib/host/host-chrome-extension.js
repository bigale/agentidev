/**
 * Host Capability Interface — chrome-extension implementation (sandbox-scoped).
 *
 * This file runs inside the SmartClient sandbox iframe (`smartclient-app/app.html`).
 * The sandbox has NO direct chrome.runtime access, so this implementation
 * routes all privileged operations to the wrapper page (`wrapper.html`) via
 * `window.parent.postMessage`. The wrapper's bridge.js relays to the service
 * worker via `chrome.runtime.sendMessage` and relays the response back.
 *
 * This is a classic <script> file (not ESM). It attaches `window.Host` with
 * a lazy factory. See host-interface.js for the full typedef.
 *
 * Phase 0 scope:
 *   - identity
 *   - message.send (the underlying transport)
 *   - storage.export (routed to existing IDB_EXPORT handler)
 *
 * Later phases fill in fs, exec, network, storage.get/set/blob, etc.
 *
 * ID collision note:
 *   Other code in the sandbox (dashboard-app.js) has its own
 *   `dispatchActionAsync` with its own numeric ID counter. To avoid
 *   collisions on the shared `smartclient-action-response` postMessage
 *   channel, this module uses string IDs prefixed with "host-". The
 *   `window.addEventListener('message', ...)` handler below only claims
 *   responses whose ID starts with "host-"; unrelated responses fall
 *   through to dashboard-app.js's handler.
 */

(function () {
  'use strict';

  // ---- Internal dispatch state ----

  var _counter = 0;
  var _pending = Object.create(null); // id -> { resolve, reject, timer }
  var _listenerInstalled = false;

  function installListener() {
    if (_listenerInstalled) return;
    _listenerInstalled = true;
    window.addEventListener('message', function (event) {
      var msg = event.data;
      if (!msg || msg.source !== 'smartclient-action-response') return;
      var id = msg.id;
      if (typeof id !== 'string' || id.slice(0, 5) !== 'host-') return;
      var entry = _pending[id];
      if (!entry) return;
      clearTimeout(entry.timer);
      delete _pending[id];
      entry.resolve(msg.response);
    });
  }

  /**
   * Send a message to the wrapper host bridge via postMessage.
   * Returns a promise that resolves with the service worker's response.
   *
   * @param {string} messageType  e.g. "IDB_EXPORT"
   * @param {Object} payload
   * @param {number} [timeoutMs=15000]
   * @returns {Promise<any>}
   */
  function dispatch(messageType, payload, timeoutMs) {
    installListener();
    var id = 'host-' + (++_counter);
    var timeout = typeof timeoutMs === 'number' ? timeoutMs : 15000;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        delete _pending[id];
        reject(new Error('Host dispatch timeout: ' + messageType + ' (' + timeout + 'ms)'));
      }, timeout);
      _pending[id] = { resolve: resolve, reject: reject, timer: timer };
      window.parent.postMessage({
        source: 'smartclient-action',
        id: id,
        messageType: messageType,
        payload: payload || {},
      }, '*');
    });
  }

  // ---- Install ID ----
  //
  // Phase 0: use a stable-per-tab value. Later phases should surface the real
  // extension install ID from chrome.runtime.id via the service worker and
  // cache it here. For now, use a string that distinguishes sessions but
  // does not claim to be a real install identifier.
  var _installId = 'sandbox-' + Math.random().toString(36).slice(2, 10);

  // ---- Runtimes registry ----

  var _runtimes = {};

  function createRuntimesSurface(hostRef) {
    return {
      list: function () { return Object.keys(_runtimes); },
      get: function (name) {
        var r = _runtimes[name];
        if (!r) throw new Error('Runtime not registered: ' + name);
        return r;
      },
      has: function (name) { return _runtimes.hasOwnProperty(name); },
      register: function (name, impl) {
        if (!impl || typeof impl !== 'object') {
          throw new Error('runtimes.register: impl must be an object');
        }
        _runtimes[name] = impl;
        return impl;
      },
    };
  }

  // ---- Factory ----

  var _host = null;

  function createHost() {
    var host = {
      identity: {
        hostType: 'chrome-extension-sandbox',
        installId: _installId,
      },

      message: {
        /**
         * Generic channel send. Thin wrapper over dispatch().
         * Used by apps that need to talk to a handler without going through
         * one of the named capability surfaces.
         */
        send: function (channel, payload, opts) {
          var timeoutMs = opts && opts.timeoutMs;
          return dispatch(channel, payload, timeoutMs);
        },
      },

      storage: {
        /**
         * Get a value previously stored via host.storage.set().
         * @param {string} key
         * @returns {Promise<any>}  resolves to the stored value or undefined
         */
        get: function (key) {
          return dispatch('HOST_STORAGE_GET', { key: key }).then(function (r) {
            return r && r.value;
          });
        },

        /**
         * Set a value in host-managed key/value storage.
         * @param {string} key
         * @param {any} value  any structured-clonable value
         * @returns {Promise<void>}
         */
        set: function (key, value) {
          return dispatch('HOST_STORAGE_SET', { key: key, value: value }).then(function () {});
        },

        /**
         * Delete a key.
         * @param {string} key
         * @returns {Promise<void>}
         */
        del: function (key) {
          return dispatch('HOST_STORAGE_DEL', { key: key }).then(function () {});
        },

        /**
         * Opaque blob storage. Phase 4.5 wraps base64 in storage.local;
         * Phase 4.6 will switch to OPFS without changing the API.
         */
        blob: {
          put: function (key, bytes) {
            // bytes is Uint8Array | number[] — postMessage transports number[]
            var arr = bytes instanceof Uint8Array ? Array.from(bytes) : (bytes || []);
            return dispatch('HOST_STORAGE_BLOB_PUT', { key: key, bytes: arr }, 60000)
              .then(function (r) { return r; });
          },
          get: function (key) {
            return dispatch('HOST_STORAGE_BLOB_GET', { key: key }, 60000).then(function (r) {
              if (!r || !r.found) return null;
              return new Uint8Array(r.bytes || []);
            });
          },
        },

        /**
         * Export app storage to the host's backing store. In the chrome
         * extension, this routes to the existing IDB_EXPORT handler which
         * serializes IndexedDB stores and pushes them to the bridge server.
         *
         * @param {{stores?: string[], timeoutMs?: number}} [opts]
         * @returns {Promise<{success: boolean, [key: string]: any}>}
         */
        export: function (opts) {
          var payload = {};
          if (opts && opts.stores) payload.stores = opts.stores;
          var timeoutMs = (opts && opts.timeoutMs) || 30000;
          return dispatch('IDB_EXPORT', payload, timeoutMs);
        },
      },

      network: {
        /**
         * Fetch a URL via the SW (which has full host_permissions).
         * Returns a serializable subset of Response: { ok, status, statusText,
         * url, headers, text|json|bytes }. The body shape is selected by `as`.
         *
         * @param {string} url
         * @param {object} [init]  fetch init (method, headers, body)
         * @param {object} [opts]
         * @param {string} [opts.as]   'text' (default) | 'json' | 'bytes'
         * @returns {Promise<object>}
         */
        fetch: function (url, init, opts) {
          var as = (opts && opts.as) || 'text';
          var timeoutMs = (opts && opts.timeoutMs) || 60000;
          return dispatch('HOST_NETWORK_FETCH', {
            url: url,
            init: init || {},
            as: as,
          }, timeoutMs);
        },
      },

      exec: {
        /**
         * Run a command in the default exec runtime (today: cheerpx).
         * For non-default runtimes, call host.runtimes.get('<name>').spawn(...)
         * directly.
         *
         * Currently collect-and-return; streaming ExecHandle is Phase 4.6.
         *
         * @param {string} cmd        Absolute path to executable
         * @param {string[]} [args]
         * @param {object} [opts]     cwd, env, etc. (passed to runtime)
         * @returns {Promise<{success, exitCode, stdout, elapsedMs}>}
         */
        spawn: function (cmd, args, opts) {
          return dispatch('HOST_EXEC_SPAWN', {
            cmd: cmd,
            args: args || [],
            opts: opts || {},
          }, 300000);
        },
      },

      fs: {
        /**
         * Read a file from the default vm runtime's filesystem (cheerpx).
         * Returns text content. Binary support comes in Phase 4.6.
         *
         * @param {string} path
         * @returns {Promise<{success, exitCode, content}>}
         */
        read: function (path) {
          return dispatch('HOST_FS_READ', { path: path }, 60000);
        },

        /**
         * Write a string to a file in the default vm runtime's filesystem.
         * Phase 4.5 caps content size around ~64 KB due to argv length;
         * stdin streaming comes in Phase 4.6.
         *
         * @param {string} path
         * @param {string} content
         * @returns {Promise<{success, exitCode, bytesWritten}>}
         */
        write: function (path, content) {
          return dispatch('HOST_FS_WRITE', { path: path, content: content }, 60000);
        },

        /**
         * List a directory in the default vm runtime's filesystem.
         * @param {string} path
         * @returns {Promise<{success, entries: Array<{name,type,size,mode,mtime}>}>}
         */
        list: function (path) {
          return dispatch('HOST_FS_LIST', { path: path }, 60000);
        },
      },
    };

    host.runtimes = createRuntimesSurface(host);

    // Auto-register runtimes whose implementations have been loaded by
    // script tags before us. Each runtime class attaches itself to window
    // (HostRuntimeCheerpJ, HostRuntimeCheerpX, ...) and we instantiate here.
    if (typeof window.HostRuntimeCheerpJ === 'function') {
      try {
        host.runtimes.register('cheerpj', new window.HostRuntimeCheerpJ({ host: host }));
      } catch (e) {
        console.warn('[Host] cheerpj runtime registration failed:', e.message);
      }
    }
    if (typeof window.HostRuntimeCheerpX === 'function') {
      try {
        host.runtimes.register('cheerpx', new window.HostRuntimeCheerpX({ host: host }));
      } catch (e) {
        console.warn('[Host] cheerpx runtime registration failed:', e.message);
      }
    }
    if (typeof window.HostRuntimeBsh === 'function') {
      try {
        host.runtimes.register('bsh', new window.HostRuntimeBsh({ host: host }));
      } catch (e) {
        console.warn('[Host] bsh runtime registration failed:', e.message);
      }
    }

    return host;
  }

  window.Host = {
    /** Lazy singleton factory. */
    get: function () {
      if (!_host) _host = createHost();
      return _host;
    },
  };

  // Sanity marker
  window.HostChromeExtensionLoaded = true;
})();
