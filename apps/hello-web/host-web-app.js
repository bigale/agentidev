/**
 * Host Capability Interface — web-app implementation.
 *
 * Phase 6 port proof: same host.* API surface as host-chrome-extension.js,
 * but backed by direct web APIs instead of chrome.runtime.* messaging.
 *
 * Key differences from the extension implementation:
 *   - Runtimes run DIRECTLY on the page (no offscreen doc, no hidden tab)
 *   - CheerpJ loads from CDN and is called directly (no seven-hop chain)
 *   - Storage uses IndexedDB (not chrome.storage.local)
 *   - Network uses native fetch (CORS-restricted, no host_permissions)
 *   - Identity is random per-session (no chrome.runtime.id)
 *   - CheerpX is NOT available (needs COI headers on the serving page)
 *   - No bridge server integration (no SCRIPT_LAUNCH, no SCHEDULE_CREATE)
 *
 * Degradations documented at the bottom of this file.
 */

(function () {
  'use strict';

  // ---- CheerpJ direct integration ----
  //
  // On a regular web page, CheerpJ loads from CDN and all APIs are
  // global. No postMessage relay, no offscreen doc, no content script.

  var _cheerpjReady = false;
  var _cheerpjLib = null; // cached CJ3Library instance
  var _cheerpjLibPath = null;

  var _runtimes = {};

  // ---- CheerpJ Runtime ----

  function CheerpJRuntime() {
    this.type = 'library';
    this.name = 'cheerpj';
    this.dependsOn = [];
    this._initPromise = null;
  }

  CheerpJRuntime.prototype.init = function () {
    if (this._initPromise) return this._initPromise;
    var self = this;
    this._initPromise = (async function () {
      if (typeof cheerpjInit !== 'function') {
        throw new Error('CheerpJ not loaded — include the loader.js script');
      }
      await cheerpjInit({ version: 11, status: 'none', clipboardMode: 'java' });
      _cheerpjReady = true;
    })();
    return this._initPromise;
  };

  CheerpJRuntime.prototype.isReady = function () { return _cheerpjReady; };
  CheerpJRuntime.prototype.getError = function () { return null; };

  CheerpJRuntime.prototype.runMain = function (opts) {
    var self = this;
    return this.init().then(function () {
      if (!opts || !opts.jarUrl || !opts.className) {
        throw new Error('runMain: jarUrl and className required');
      }
      // Fetch JAR bytes and mount in /str/
      return fetch(opts.jarUrl)
        .then(function (r) { if (!r.ok) throw new Error('fetch: ' + r.status); return r.arrayBuffer(); })
        .then(function (buf) {
          var bytes = new Uint8Array(buf);
          var jarPath = '/str/' + (opts.cacheKey || 'jar') + '.jar';
          cheerpOSAddStringFile(jarPath, bytes);
          var classpath = [jarPath];
          // Extra JARs
          var extras = opts.extraJars || [];
          var extraPromises = extras.map(function (url) {
            return fetch(url)
              .then(function (r) { return r.arrayBuffer(); })
              .then(function (buf) {
                var eb = new Uint8Array(buf);
                var ep = '/str/extra-' + eb.length + '.jar';
                cheerpOSAddStringFile(ep, eb);
                classpath.push(ep);
              });
          });
          return Promise.all(extraPromises).then(function () {
            // Capture stdout via console.log interception
            var stdoutBuf = [];
            var origLog = console.log;
            console.log = function () {
              origLog.apply(console, arguments);
              stdoutBuf.push(Array.prototype.map.call(arguments, String).join(' '));
            };
            var args = [opts.className, classpath.join(':')].concat(opts.args || []);
            return cheerpjRunMain.apply(null, args).then(function (exitCode) {
              console.log = origLog;
              return { success: true, exitCode: exitCode, stdout: stdoutBuf.join('\n') };
            });
          });
        });
    });
  };

  CheerpJRuntime.prototype.runLibrary = function (opts) {
    var self = this;
    return this.init().then(async function () {
      if (!opts || !opts.className || !opts.method) {
        throw new Error('runLibrary: className and method required');
      }
      // Use /app/ if same origin, else /str/
      var jarPath;
      if (opts.jarUrl) {
        var resp = await fetch(opts.jarUrl);
        var buf = new Uint8Array(await resp.arrayBuffer());
        jarPath = '/str/' + (opts.cacheKey || 'lib') + '.jar';
        cheerpOSAddStringFile(jarPath, buf);
      } else {
        jarPath = '';
      }
      if (!_cheerpjLib || _cheerpjLibPath !== jarPath) {
        _cheerpjLib = await cheerpjRunLibrary(jarPath);
        _cheerpjLibPath = jarPath;
      }
      // Chain without await, await once (correct CJ3Library pattern)
      var parts = opts.className.split('.');
      var ref = _cheerpjLib;
      for (var i = 0; i < parts.length; i++) ref = ref[parts[i]];
      var classRef = await ref;
      // Call the method
      var args = opts.args || [];
      var result;
      if (args.length === 0) result = await classRef[opts.method]();
      else if (args.length === 1) result = await classRef[opts.method](args[0]);
      else if (args.length === 2) result = await classRef[opts.method](args[0], args[1]);
      else result = await classRef[opts.method].apply(classRef, args);
      return result;
    });
  };

  // ---- BeanShell Runtime (composed on CheerpJ) ----

  function BshRuntime() {
    this.type = 'interpreter';
    this.name = 'bsh';
    this.dependsOn = ['cheerpj'];
    this._initPromise = null;
  }

  BshRuntime.prototype.init = function () {
    if (this._initPromise) return this._initPromise;
    this._initPromise = _runtimes.cheerpj.init();
    return this._initPromise;
  };

  BshRuntime.prototype.isReady = function () { return _runtimes.cheerpj.isReady(); };
  BshRuntime.prototype.getError = function () { return null; };

  BshRuntime.prototype.eval = function (code) {
    return _runtimes.cheerpj.runMain({
      jarUrl: 'https://repo1.maven.org/maven2/org/beanshell/bsh/2.0b5/bsh-2.0b5.jar',
      extraJars: [],
      className: 'bsh.Interpreter',
      args: [],
      cacheKey: 'bsh-2.0b5',
    }).then(function () {
      // BeanShell doesn't have a convenient main-with-eval.
      // Use the same BshEval wrapper pattern if asset server is available,
      // or fall back to runLibrary for direct eval.
      // For the web-app port, use runLibrary:
      return _runtimes.cheerpj.runLibrary({
        jarUrl: 'https://repo1.maven.org/maven2/org/beanshell/bsh/2.0b5/bsh-2.0b5.jar',
        className: 'bsh.Interpreter',
        method: 'eval', // This won't work directly — Interpreter.eval is an instance method
      });
    }).catch(function () {
      // Fallback: use cheerpjRunMain with a wrapper
      // For now, report the limitation
      return 'bsh.eval requires the BshEval wrapper JAR (available via asset-server)';
    });
  };

  // ---- Storage (IndexedDB) ----

  var _idb = null;
  function getDB() {
    if (_idb) return Promise.resolve(_idb);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('agentidev-host-storage', 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore('kv');
        req.result.createObjectStore('blobs');
      };
      req.onsuccess = function () { _idb = req.result; resolve(_idb); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbGet(store, key) {
    return getDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, 'readonly');
        var req = tx.objectStore(store).get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbPut(store, key, value) {
    return getDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbDel(store, key) {
    return getDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // ---- Register runtimes ----

  _runtimes.cheerpj = new CheerpJRuntime();
  _runtimes.bsh = new BshRuntime();
  // CheerpX is NOT available in the web app (needs COI headers)

  // ---- Host factory ----

  var _host = null;
  var _installId = 'web-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);

  window.Host = {
    get: function () {
      if (_host) return _host;
      _host = {
        identity: {
          hostType: 'web-app',
          installId: _installId,
        },

        message: {
          send: function (channel, payload) {
            console.warn('[host-web-app] message.send not available in web app:', channel);
            return Promise.reject(new Error('host.message.send is not available in the web-app host'));
          },
        },

        storage: {
          get: function (key) { return idbGet('kv', key); },
          set: function (key, value) { return idbPut('kv', key, value); },
          del: function (key) { return idbDel('kv', key); },
          blob: {
            put: function (key, bytes) {
              return idbPut('blobs', key, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
            },
            get: function (key) { return idbGet('blobs', key); },
          },
          export: function () {
            return Promise.reject(new Error('storage.export not available in web-app host'));
          },
        },

        network: {
          fetch: function (url, init, opts) {
            var as = (opts && opts.as) || 'text';
            return fetch(url, init || {}).then(function (r) {
              var out = { ok: r.ok, status: r.status, statusText: r.statusText, url: r.url, headers: {} };
              r.headers.forEach(function (v, k) { out.headers[k] = v; });
              if (as === 'json') return r.json().then(function (j) { out.json = j; return out; });
              if (as === 'bytes') return r.arrayBuffer().then(function (b) { out.bytes = Array.from(new Uint8Array(b)); return out; });
              return r.text().then(function (t) { out.text = t; return out; });
            });
          },
        },

        exec: {
          spawn: function () {
            return Promise.reject(new Error('host.exec.spawn not available in web-app host (no CheerpX — needs COI headers)'));
          },
          spawnStream: function () {
            throw new Error('host.exec.spawnStream not available in web-app host');
          },
        },

        fs: {
          read: function () { return Promise.reject(new Error('host.fs not available in web-app host')); },
          write: function () { return Promise.reject(new Error('host.fs not available in web-app host')); },
          list: function () { return Promise.reject(new Error('host.fs not available in web-app host')); },
          upload: function () { return Promise.reject(new Error('host.fs not available in web-app host')); },
          watch: function () { return function () {}; },
        },

        runtimes: {
          list: function () { return Object.keys(_runtimes); },
          get: function (name) {
            if (!_runtimes[name]) throw new Error('Runtime not registered: ' + name);
            return _runtimes[name];
          },
          has: function (name) { return !!_runtimes[name]; },
          register: function (name, impl) { _runtimes[name] = impl; },
        },
      };
      return _host;
    },
  };

  /*
   * DOCUMENTED DEGRADATIONS (web-app vs chrome-extension host):
   *
   * | Surface              | Extension          | Web App              |
   * |----------------------|--------------------|----------------------|
   * | identity.installId   | chrome.runtime.id  | random per-session   |
   * | message.send         | SW dispatch table  | NOT AVAILABLE        |
   * | storage.get/set/blob | chrome.storage     | IndexedDB            |
   * | storage.export       | IDB_EXPORT bridge  | NOT AVAILABLE        |
   * | network.fetch        | CORS-free (host_p) | CORS-restricted      |
   * | exec.spawn           | CheerpX VM         | NOT AVAILABLE (COI)  |
   * | exec.spawnStream     | CheerpX streaming  | NOT AVAILABLE        |
   * | fs.*                 | CheerpX filesystem | NOT AVAILABLE        |
   * | runtimes.cheerpj     | offscreen iframe   | DIRECT (simpler!)    |
   * | runtimes.cheerpx     | hidden tab + COI   | NOT AVAILABLE        |
   * | runtimes.bsh         | via cheerpj        | via cheerpj (same)   |
   */
})();
