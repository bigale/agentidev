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

  // ---- Stream subscriptions ----
  // Used by host.exec.spawnStream and host.fs.watch. Each entry is keyed
  // by streamId and points at an ExecHandle / WatchHandle whose onChunk /
  // onExit / onError callbacks fan out broadcasted CHEERPX_STREAM_EVENT
  // messages.
  var _streamHandles = Object.create(null); // streamId -> handle
  var _streamCounter = 0;

  function installListener() {
    if (_listenerInstalled) return;
    _listenerInstalled = true;
    window.addEventListener('message', function (event) {
      var msg = event.data;
      if (!msg) return;
      // Action responses (single-request/response)
      if (msg.source === 'smartclient-action-response') {
        var id = msg.id;
        if (typeof id !== 'string' || id.slice(0, 5) !== 'host-') return;
        var entry = _pending[id];
        if (!entry) return;
        clearTimeout(entry.timer);
        delete _pending[id];
        entry.resolve(msg.response);
        return;
      }
      // Stream events forwarded by wrapper.html bridge.js
      if (msg.source === 'smartclient-stream-event') {
        var sid = msg.streamId;
        var handle = _streamHandles[sid];
        if (!handle) return;
        var evt = msg.event || {};
        try {
          if (evt.type === 'stdout' && handle._onStdout) {
            handle._onStdout.forEach(function (cb) { try { cb(evt.chunk); } catch (e) {} });
          } else if (evt.type === 'stderr' && handle._onStderr) {
            handle._onStderr.forEach(function (cb) { try { cb(evt.chunk); } catch (e) {} });
          } else if (evt.type === 'exit') {
            handle._onExit.forEach(function (cb) { try { cb(evt.exitCode); } catch (e) {} });
            handle._resolve({
              exitCode: evt.exitCode,
              stdout: handle._collectedStdout,
              elapsedMs: evt.elapsedMs,
            });
            delete _streamHandles[sid];
          } else if (evt.type === 'error') {
            handle._onError.forEach(function (cb) { try { cb(new Error(evt.error)); } catch (e) {} });
            handle._reject(new Error(evt.error));
            delete _streamHandles[sid];
          }
          if (evt.type === 'stdout' && handle._collectStdout) {
            handle._collectedStdout += evt.chunk;
          }
        } catch (e) {
          console.warn('[Host stream] callback threw:', e && e.message);
        }
        return;
      }
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
  // Phase 4.6: lazily fetched from the SW via HOST_IDENTITY_GET, which
  // surfaces chrome.runtime.id plus a per-install nonce stored in
  // chrome.storage.local. Until the first call resolves we fall back to a
  // sandbox-prefixed value so callers always get a string.
  var _installId = 'sandbox-' + Math.random().toString(36).slice(2, 10);
  var _hostType = 'chrome-extension-sandbox';
  var _identityFetched = false;
  function fetchIdentityOnce() {
    if (_identityFetched) return Promise.resolve();
    _identityFetched = true;
    return dispatch('HOST_IDENTITY_GET', {}, 5000).then(function (id) {
      if (id && id.installId) {
        _installId = id.installId;
        if (id.hostType) _hostType = id.hostType;
        if (_host) _host.identity.installId = _installId;
      }
    }).catch(function () { _identityFetched = false; });
  }

  // ---- ExecHandle factory (used by host.exec.spawnStream) ----
  function _makeExecHandle(streamId) {
    var resolveDone, rejectDone;
    var done = new Promise(function (res, rej) { resolveDone = res; rejectDone = rej; });
    var handle = {
      streamId: streamId,
      done: done,
      _onStdout: [],
      _onStderr: [],
      _onExit: [],
      _onError: [],
      _collectStdout: true,    // accumulate stdout chunks for the done payload
      _collectedStdout: '',
      _resolve: resolveDone,
      _reject: rejectDone,
      onStdout: function (cb) { this._onStdout.push(cb); return this; },
      onStderr: function (cb) { this._onStderr.push(cb); return this; },
      onExit:   function (cb) { this._onExit.push(cb);   return this; },
      onError:  function (cb) { this._onError.push(cb);  return this; },
      kill: function () {
        return dispatch('HOST_EXEC_SPAWN_STREAM_KILL', { streamId: streamId }, 5000);
      },
    };
    return handle;
  }

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
    // Kick off identity fetch in the background — non-blocking
    fetchIdentityOnce();
    var host = {
      identity: {
        hostType: _hostType,
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
         * Collect-and-return — see spawnStream() for the streaming variant.
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

        /**
         * Streaming spawn — returns an ExecHandle whose onStdout / onStderr
         * / onExit / onError callbacks fire as data arrives. The `done`
         * Promise resolves with the final exit info when the process
         * exits.
         *
         *   var handle = host.exec.spawnStream('/usr/bin/python3', ['-c', 'for i in range(3): print(i)']);
         *   handle.onStdout(function (chunk) { console.log(chunk); });
         *   await handle.done;  // → { exitCode: 0, stdout: '0\n1\n2\n', elapsedMs: ... }
         *
         * @param {string} cmd
         * @param {string[]} [args]
         * @param {object} [opts]
         * @returns {ExecHandle}
         */
        spawnStream: function (cmd, args, opts) {
          installListener();
          var streamId = 'estream-' + (++_streamCounter) + '-' + Date.now();
          var handle = _makeExecHandle(streamId);
          _streamHandles[streamId] = handle;
          // Kick off the stream. We don't await — chunks arrive via the
          // installed listener and resolve handle.done.
          dispatch('HOST_EXEC_SPAWN_STREAM_START', {
            streamId: streamId,
            cmd: cmd,
            args: args || [],
            opts: opts || {},
          }, 30000).then(function (resp) {
            if (!resp || !resp.success) {
              var err = new Error((resp && resp.error) || 'spawnStream start failed');
              handle._onError.forEach(function (cb) { try { cb(err); } catch (e) {} });
              handle._reject(err);
              delete _streamHandles[streamId];
            }
          }).catch(function (err) {
            handle._onError.forEach(function (cb) { try { cb(err); } catch (e) {} });
            handle._reject(err);
            delete _streamHandles[streamId];
          });
          return handle;
        },
      },

      fs: {
        /**
         * Read a file from the default vm runtime's filesystem (cheerpx).
         *
         * @param {string} path
         * @param {object} [opts]
         * @param {string} [opts.as]   'text' (default) or 'bytes' (returns
         *                              { bytes: number[] } using xxd hex
         *                              encoding to survive transport)
         * @returns {Promise<{success, exitCode, content?, bytes?}>}
         */
        read: function (path, opts) {
          return dispatch('HOST_FS_READ', { path: path, as: opts && opts.as }, 60000);
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

        /**
         * Watch a file or directory for changes. The callback fires whenever
         * the path's mtime changes (file modified, deleted, or appears for
         * the first time). Implementation: client-side polling on top of
         * host.fs.list/host.exec.spawn — no real inotify support yet.
         *
         * @param {string} path
         * @param {(evt: {type: 'change'|'delete'|'create', mtime?: string}) => void} cb
         * @param {object} [opts]
         * @param {number} [opts.intervalMs=2000]   poll interval
         * @returns {() => void}                     unsubscribe function
         */
        watch: function (path, cb, opts) {
          var intervalMs = (opts && opts.intervalMs) || 2000;
          var lastMtime = null;
          var lastExists = null;
          var stopped = false;
          // Use the parent dir + filename split so we can poll via /bin/stat
          // (or, fall back to spawn with stat -c '%Y') instead of relying on
          // host.fs.list of a directory which is overkill for one file.
          function tick() {
            if (stopped) return;
            // stat -c '%y' returns human-readable mtime including nanoseconds
            // (e.g., "2026-04-12 01:46:13.123456789 +0000"), so writes within
            // the same epoch second produce distinct strings. Nonzero exit
            // means the file is missing — handled below.
            dispatch('HOST_EXEC_SPAWN', {
              cmd: '/bin/sh',
              args: ['-c', "stat -c '%y' '" + String(path).replace(/'/g, "'\\''") + "' 2>/dev/null"],
            }, 10000).then(function (r) {
              if (stopped) return;
              var stdout = (r && r.stdout) || '';
              var mtime = stdout.trim();
              if (!mtime) {
                // File doesn't exist
                if (lastExists === true) {
                  try { cb({ type: 'delete' }); } catch (e) {}
                  lastMtime = null;
                }
                lastExists = false;
              } else {
                if (lastExists === false) {
                  try { cb({ type: 'create', mtime: mtime }); } catch (e) {}
                } else if (lastMtime !== null && mtime !== lastMtime) {
                  try { cb({ type: 'change', mtime: mtime }); } catch (e) {}
                }
                lastExists = true;
                lastMtime = mtime;
              }
            }).catch(function (err) {
              console.warn('[host.fs.watch] poll error:', err && err.message);
            }).finally(function () {
              if (!stopped) setTimeout(tick, intervalMs);
            });
          }
          tick();
          return function unsubscribe() { stopped = true; };
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
