/**
 * BeanShell runtime — type:'interpreter' composed on top of cheerpj.
 *
 * Purpose: prove the runtime-composition pattern from the host capability
 * interface plan. A "library" or "vm" runtime is self-contained, but an
 * "interpreter" runtime is typically not — it runs *inside* another
 * runtime that provides its execution substrate. BeanShell is a Java
 * scripting engine, so it runs inside CheerpJ.
 *
 * Architecture:
 *   app code
 *     └─ host.runtimes.get('bsh').eval('1 + 1')
 *         └─ this runtime's eval(code)
 *             └─ host.runtimes.get('cheerpj').runMain({
 *                  jarUrl: '...bsh-2.0b5.jar',
 *                  extraJars: ['...bsh-eval.jar'],
 *                  className: 'BshEval',
 *                  args: [code],
 *                })
 *                 └─ cheerpj runtime executes BshEval which:
 *                    - new bsh.Interpreter()
 *                    - interp.eval(args[0])
 *                    - System.out.println(result)
 *             └─ stdout flows back through cheerpj
 *         └─ this runtime parses stdout and returns the result
 *
 * `dependsOn: ['cheerpj']` declares the dependency. The host's init flow
 * resolves dependencies before initializing this runtime — see init()
 * below for the boot-order check.
 *
 * Originally this slot was meant for Jython, but Jython 2.7.x hits a
 * java.lang.ArrayIndexOutOfBoundsException during PyJavaType reflection
 * setup on CheerpJ — it makes assumptions about Java reflection internals
 * that CheerpJ's implementation doesn't satisfy. BeanShell is much smaller
 * (375 KB vs 50 MB), starts in ~5 s cold (vs minutes for Jython compile),
 * and proves the same composition pattern. See cheerpj-app/STATUS.md for
 * the Jython exception trace.
 *
 * Classic-script file (not ESM). Loaded after runtimes/cheerpj.js so the
 * host factory can resolve our `dependsOn` against the registry.
 */

(function () {
  'use strict';

  // URLs for the BeanShell jar and the wrapper class. Both are served by
  // packages/bridge/asset-server.mjs from ~/.agentidev/cheerpx-assets/.
  // The wrapper (BshEval.class) is a 924-byte JAR with one class that
  // takes the script as args[0] and prints the result. Its source lives
  // in /tmp/bsh-eval/BshEval.java in this repo's dev environment, but
  // for production we'd check the .java + the compiled .jar into the
  // extension bundle.
  var BSH_JAR_URL = 'http://localhost:9877/bsh-2.0b5.jar';
  var BSH_EVAL_WRAPPER_URL = 'http://localhost:9877/bsh-eval.jar';
  var WRAPPER_CLASS_NAME = 'BshEval';
  var CACHE_KEY = 'bsh-2.0b5';

  function BshRuntime(opts) {
    this.type = 'interpreter';
    this.name = 'bsh';
    this.dependsOn = ['cheerpj'];
    this._opts = opts || {};
    this._host = (opts && opts.host) || null;
    this._initPromise = null;
    this._error = null;
  }

  BshRuntime.prototype.init = function (options) {
    if (this._initPromise) return this._initPromise;
    var self = this;
    this._initPromise = (async function () {
      // Resolve dependsOn explicitly. If the host doesn't have cheerpj
      // registered, fail fast with a useful message rather than hanging
      // on the first eval call.
      if (!self._host || !self._host.runtimes) {
        self._error = 'bsh runtime needs a host with a runtimes surface';
        throw new Error(self._error);
      }
      if (!self._host.runtimes.has('cheerpj')) {
        self._error = 'bsh runtime depends on cheerpj, which is not registered';
        throw new Error(self._error);
      }
      var cheerpj = self._host.runtimes.get('cheerpj');
      // Initialize the dependency first. CheerpJ init is idempotent.
      await cheerpj.init();
      return true;
    })().catch(function (err) {
      self._error = (err && err.message) || String(err);
      self._initPromise = null;
      throw err;
    });
    return this._initPromise;
  };

  BshRuntime.prototype.isReady = function () {
    return !!this._initPromise;
  };

  BshRuntime.prototype.getError = function () {
    return this._error;
  };

  /**
   * Evaluate a BeanShell expression and return its result as a string.
   *
   * BeanShell is loosely Java-syntax: most Java expressions, plus loose
   * typing (`x = 1; y = 2; x + y`). The wrapper's main() prints the
   * eval result via toString(); we strip CheerpJ's banner lines and
   * return the trailing value.
   *
   * @param {string} code
   * @returns {Promise<string>}
   */
  BshRuntime.prototype.eval = function (code) {
    var self = this;
    return this.init().then(function () {
      var cheerpj = self._host.runtimes.get('cheerpj');
      return cheerpj.runMain({
        jarUrl: BSH_JAR_URL,
        extraJars: [BSH_EVAL_WRAPPER_URL],
        className: WRAPPER_CLASS_NAME,
        args: [String(code)],
        cacheKey: CACHE_KEY,
      });
    }).then(function (result) {
      // CheerpJ banners are static; strip them and return the last
      // non-empty line which is the eval result.
      var stdout = (result && result.stdout) || '';
      var lines = stdout.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      // Filter out CheerpJ banners
      var banners = ['CheerpJ runtime ready', 'Class is loaded, main is starting'];
      var meaningful = lines.filter(function (l) { return banners.indexOf(l) === -1; });
      return meaningful.length > 0 ? meaningful[meaningful.length - 1] : '';
    });
  };

  // Export
  if (typeof window !== 'undefined') {
    window.HostRuntimeBsh = BshRuntime;
  }
})();
