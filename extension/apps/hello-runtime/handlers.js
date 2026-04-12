/**
 * hello-runtime plugin handlers.
 *
 * Registers three SW dispatch entries that the dashboard's buttons fire.
 * Each one wraps the matching runtime's existing SW handler — proving
 * that a plugin's handlers can compose on top of the platform's handlers
 * without ever touching `chrome.runtime.*` directly.
 *
 * The plugin loader (extension/lib/plugin-loader.js) dynamic-imports this
 * file at SW boot and calls register(handlers, { manifest }) with the same
 * dispatch table the platform handlers use. We use the existing
 * cheerpj-* / cheerpx-* handlers (registered earlier in background.js)
 * by message-passing through them — but plugin handlers can also call any
 * other handler in the table directly.
 *
 * Pattern note: handlers reach the platform runtimes via the dispatch
 * table they're being registered into, not via direct imports. That keeps
 * plugins decoupled from the platform's internal module structure — a
 * plugin only needs to know the handler names, which are part of the
 * stable platform contract.
 */

export function register(handlers /*, { manifest } */) {
  /**
   * Run a BeanShell expression via the bsh runtime (which composes on cheerpj).
   * Routes through cheerpj-runMain because bsh is just a wrapper class.
   */
  handlers['HELLO_RUNTIME_BSH'] = async (msg) => {
    const code = msg && msg.code ? String(msg.code) : '1 + 1';
    if (typeof handlers['cheerpj-runMain'] !== 'function') {
      return { success: false, error: 'cheerpj-runMain handler not registered' };
    }
    const res = await handlers['cheerpj-runMain']({
      jarUrl: 'http://localhost:9877/bsh-2.0b5.jar',
      extraJars: ['http://localhost:9877/bsh-eval.jar'],
      className: 'BshEval',
      args: [code],
      cacheKey: 'bsh-2.0b5',
    });
    // Strip CheerpJ banners and return the trailing meaningful line
    const stdout = (res && res.stdout) || '';
    const lines = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => l !== 'CheerpJ runtime ready' && l !== 'Class is loaded, main is starting');
    const result = lines.length > 0 ? lines[lines.length - 1] : '';
    return { success: true, code, result, raw: stdout };
  };

  /**
   * Run a Linux command via the cheerpx runtime.
   * Defaults to printing 6*7 in python3.
   */
  handlers['HELLO_RUNTIME_CHEERPX'] = async (msg) => {
    if (typeof handlers['cheerpx-spawn'] !== 'function') {
      return { success: false, error: 'cheerpx-spawn handler not registered' };
    }
    const cmd = (msg && msg.cmd) || '/usr/bin/python3';
    const args = (msg && msg.args) || ['-c', 'print(6*7)'];
    const res = await handlers['cheerpx-spawn']({ cmd, args });
    return {
      success: true,
      cmd,
      args,
      exitCode: res.exitCode,
      stdout: res.stdout,
      elapsedMs: res.elapsedMs,
    };
  };

  /**
   * Run a Java main class via cheerpj-runMain.
   * Defaults to the bundled hello-main.jar (Phase 1.6 sanity test JAR).
   */
  handlers['HELLO_RUNTIME_CHEERPJ'] = async (msg) => {
    if (typeof handlers['cheerpj-runMain'] !== 'function') {
      return { success: false, error: 'cheerpj-runMain handler not registered' };
    }
    const jarUrl = (msg && msg.jarUrl) || 'http://localhost:9877/hello-main.jar';
    const className = (msg && msg.className) || 'com.agentidev.Hello';
    const args = (msg && msg.args) || ['hello-runtime'];
    const res = await handlers['cheerpj-runMain']({
      jarUrl,
      className,
      args,
      cacheKey: msg && msg.cacheKey,
    });
    return {
      success: true,
      jarUrl,
      className,
      args,
      exitCode: res.exitCode,
      stdout: res.stdout,
    };
  };
}
