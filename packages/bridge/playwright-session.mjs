/**
 * Playwright Session Manager
 *
 * Wraps playwright-cli as a one-shot-per-command tool.
 * Each command spawns `playwright-cli -s=<name> <command> [args]`,
 * captures stdout, and returns when the process exits.
 * Commands are queued and serialized per session.
 *
 * After spawn(), reads the daemon's .session file to extract the
 * auto-assigned cdpPort, exposing it as cdpEndpoint for script linking.
 */

import { execFile } from 'child_process';
import { readFile, readdir } from 'fs/promises';
import { resolve as pathResolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTOMATION_CONFIG = pathResolve(__dirname, 'playwright-automation.config.json');
const DAEMON_BASE = (() => {
  if (process.env.PLAYWRIGHT_DAEMON_SESSION_DIR) return process.env.PLAYWRIGHT_DAEMON_SESSION_DIR;
  const home = homedir();
  if (process.platform === 'win32') return pathResolve(process.env.LOCALAPPDATA || pathResolve(home, 'AppData', 'Local'), 'ms-playwright', 'daemon');
  if (process.platform === 'darwin') return pathResolve(home, 'Library', 'Caches', 'ms-playwright', 'daemon');
  return pathResolve(process.env.XDG_CACHE_HOME || pathResolve(home, '.cache'), 'ms-playwright', 'daemon');
})();

// Session states
export const SESSION_STATE = {
  IDLE: 'idle',
  NAVIGATING: 'navigating',
  READY: 'ready',
  ERROR: 'error',
  DESTROYED: 'destroyed',
};

export class PlaywrightSession {
  /**
   * @param {string} name - Session name
   * @param {object} options
   * @param {string} [options.authPath] - Path to auth state file
   * @param {number} [options.timeout=30000] - Command timeout in ms
   */
  constructor(name, options = {}) {
    this.name = name;
    this.id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.authPath = options.authPath || null;
    this.timeout = options.timeout || 30000;

    this.state = SESSION_STATE.IDLE;
    this.currentUrl = null;
    this.lastSnapshot = null;
    this.lastError = null;
    this._cdpEndpoint = null; // http://localhost:<cdpPort> for script connections

    // Command queue for serialization
    this._commandQueue = [];
    this._processing = false;
    this._onStateChange = null;
  }

  /**
   * Set state change callback
   * @param {function} cb - Callback(sessionId, newState, metadata)
   */
  onStateChange(cb) {
    this._onStateChange = cb;
  }

  /**
   * Update session state and notify
   */
  _setState(newState, metadata = {}) {
    const oldState = this.state;
    this.state = newState;
    if (this._onStateChange && oldState !== newState) {
      this._onStateChange(this.id, newState, { ...metadata, oldState });
    }
  }

  /**
   * Build the base args array for playwright-cli
   */
  _baseArgs() {
    const args = [`--config=${AUTOMATION_CONFIG}`];
    if (this.name) args.push(`-s=${this.name}`);
    return args;
  }

  /**
   * Run a single playwright-cli command and return its stdout
   * @param {string} command - Command name (e.g., 'open', 'snapshot', 'goto')
   * @param {string[]} [cmdArgs=[]] - Additional arguments
   * @returns {Promise<string>} stdout output
   */
  _exec(command, cmdArgs = []) {
    return new Promise((resolve, reject) => {
      const args = [...this._baseArgs(), command, ...cmdArgs];
      console.log(`[Session ${this.name}] exec: playwright-cli ${args.join(' ')}`);

      execFile('playwright-cli', args, {
        timeout: this.timeout,
        cwd: process.cwd(),
        env: { ...process.env },
        maxBuffer: 10 * 1024 * 1024, // 10MB for large snapshots
        shell: process.platform === 'win32',
      }, (err, stdout, stderr) => {
        if (stderr) {
          console.error(`[Session ${this.name}] stderr: ${stderr.trim()}`);
        }
        if (err) {
          this.lastError = err.message;
          reject(err);
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }

  /**
   * Open the browser session via playwright-cli open
   * @returns {Promise<boolean>} True if opened successfully
   */
  async spawn() {
    // Use Playwright bundled Chromium — Google Chrome blocks --load-extension
    // in automation mode (~Chrome 130+) and crashes in WSL2 GPU-less environments
    const openArgs = ['--headed', '--persistent'];
    if (this.authPath) {
      openArgs.push(`--profile=${this.authPath}`);
    }

    try {
      const result = await this._exec('open', openArgs);
      this._setState(SESSION_STATE.READY);
      console.log(`[Session ${this.name}] Opened (id: ${this.id})`);
      console.log(`[Session ${this.name}] ${result}`);

      // Extract cdpPort from daemon session file for script linking.
      // Retry with delay — the daemon may not have written the file yet.
      for (let attempt = 0; attempt < 5; attempt++) {
        await this._resolveCdpEndpoint();
        if (this._cdpEndpoint) break;
        await new Promise(r => setTimeout(r, 1000));
      }

      return true;
    } catch (err) {
      this.lastError = err.message;
      this._setState(SESSION_STATE.ERROR, { error: err.message });
      throw err;
    }
  }

  /**
   * Read the playwright-cli daemon's .session file to extract the cdpPort.
   * The daemon auto-assigns a --remote-debugging-port for every Chromium session
   * and stores it in: ~/.cache/ms-playwright/daemon/<hash>/<name>.session
   */
  async _resolveCdpEndpoint() {
    try {
      const hashDirs = await readdir(DAEMON_BASE).catch(() => []);
      for (const hash of hashDirs) {
        const sessionFile = pathResolve(DAEMON_BASE, hash, `${this.name}.session`);
        try {
          const raw = await readFile(sessionFile, 'utf-8');
          const data = JSON.parse(raw);
          // CDP port location varies by Playwright version and platform:
          // - Some versions: browser.launchOptions.cdpPort (explicit field)
          // - Older versions: resolvedConfig.browser.launchOptions.cdpPort
          // - Windows/newer: in args as --remote-debugging-port=PORT
          let cdpPort = data?.browser?.launchOptions?.cdpPort
            || data?.resolvedConfig?.browser?.launchOptions?.cdpPort;
          if (!cdpPort) {
            const args = data?.browser?.launchOptions?.args || data?.resolvedConfig?.browser?.launchOptions?.args || [];
            for (const arg of args) {
              const m = /--remote-debugging-port=(\d+)/.exec(arg);
              if (m) { cdpPort = parseInt(m[1], 10); break; }
            }
          }
          if (cdpPort) {
            this._cdpEndpoint = `http://127.0.0.1:${cdpPort}`;
            console.log(`[Session ${this.name}] CDP endpoint: ${this._cdpEndpoint}`);
            return;
          }
        } catch {
          // Not in this hash dir, try next
        }
      }
      console.warn(`[Session ${this.name}] Could not find cdpPort in daemon session files`);
    } catch (err) {
      console.warn(`[Session ${this.name}] Failed to resolve CDP endpoint: ${err.message}`);
    }
  }

  /**
   * Queue a command for serialized execution
   * @param {string} command - Command name
   * @param {string[]} [cmdArgs=[]] - Additional arguments
   * @returns {Promise<string>} Command output
   */
  async sendCommand(command, cmdArgs = []) {
    return new Promise((resolve, reject) => {
      this._commandQueue.push({ command, cmdArgs, resolve, reject });
      this._processQueue();
    });
  }

  /**
   * Process command queue (one at a time)
   */
  async _processQueue() {
    if (this._processing || this._commandQueue.length === 0) return;
    this._processing = true;

    while (this._commandQueue.length > 0) {
      const { command, cmdArgs, resolve, reject } = this._commandQueue.shift();
      try {
        const result = await this._exec(command, cmdArgs);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    }

    this._processing = false;
  }

  /**
   * Parse the snapshot file path and page URL from playwright-cli stdout
   * @param {string} stdout - Raw stdout from playwright-cli snapshot
   * @returns {{ yamlPath: string|null, url: string|null }}
   */
  _parseSnapshotOutput(stdout) {
    const pathMatch = stdout.match(/\[Snapshot\]\(([^)]+\.yml)\)/);
    const urlMatch = stdout.match(/Page URL:\s*(\S+)/);
    return {
      yamlPath: pathMatch ? pathMatch[1] : null,
      url: urlMatch ? urlMatch[1] : null,
    };
  }

  /**
   * Take an accessibility snapshot of the current page
   * @returns {Promise<string>} YAML snapshot text
   */
  async snapshot() {
    this._setState(SESSION_STATE.NAVIGATING);
    try {
      const stdout = await this.sendCommand('snapshot');
      const { yamlPath, url } = this._parseSnapshotOutput(stdout);

      if (url) this.currentUrl = url;

      let yaml = stdout; // fallback to raw stdout
      if (yamlPath) {
        try {
          const fullPath = pathResolve(process.cwd(), yamlPath);
          yaml = await readFile(fullPath, 'utf-8');
        } catch (readErr) {
          console.error(`[Session ${this.name}] Could not read snapshot file: ${readErr.message}`);
        }
      }

      this.lastSnapshot = yaml;
      this._setState(SESSION_STATE.READY);
      return yaml;
    } catch (err) {
      this._setState(SESSION_STATE.ERROR, { error: err.message });
      throw err;
    }
  }

  /**
   * Navigate to a URL
   * @param {string} url - URL to navigate to
   * @returns {Promise<string>} Navigation result
   */
  async navigate(url) {
    this._setState(SESSION_STATE.NAVIGATING, { url });
    try {
      const result = await this.sendCommand('goto', [url]);
      this.currentUrl = url;
      this._setState(SESSION_STATE.READY, { url });
      return result;
    } catch (err) {
      this._setState(SESSION_STATE.ERROR, { error: err.message, url });
      throw err;
    }
  }

  /**
   * Click an element by ref
   * @param {string} ref - Element ref (e.g., 'e123')
   * @returns {Promise<string>} Click result
   */
  async click(ref) {
    return this.sendCommand('click', [ref]);
  }

  /**
   * Fill an element with a value
   * @param {string} ref - Element ref
   * @param {string} value - Value to fill
   * @returns {Promise<string>} Fill result
   */
  async fill(ref, value) {
    return this.sendCommand('fill', [ref, value]);
  }

  /**
   * Evaluate a JavaScript expression in the page
   * @param {string} expr - JavaScript expression
   * @returns {Promise<string>} Evaluation result
   */
  async evaluate(expr) {
    return this.sendCommand('eval', [expr]);
  }

  /**
   * Take a screenshot and save to a file path
   * @param {string} filePath - Absolute path for the output PNG
   * @param {object} [options]
   * @param {boolean} [options.fullPage=true] - Capture full page
   * @returns {Promise<string>} The file path
   */
  async screenshotToFile(filePath, options = {}) {
    const args = ['--filename', filePath];
    if (options.fullPage !== false) args.push('--full-page');
    await this.sendCommand('screenshot', args);
    return filePath;
  }

  /**
   * Get network requests captured by the session
   * @returns {Promise<string>} Network request log output
   */
  async networkRequests() {
    return this.sendCommand('network', []);
  }

  /**
   * Start tracing (captures HAR, DOM snapshots, console logs)
   * @returns {Promise<string>} Tracing start result
   */
  async tracingStart() {
    return this.sendCommand('tracing-start', []);
  }

  /**
   * Stop tracing and save trace.zip
   * @returns {Promise<string>} Tracing stop result (includes file path)
   */
  async tracingStop() {
    return this.sendCommand('tracing-stop', []);
  }

  /**
   * Check if the playwright-cli session is still alive
   * @returns {Promise<boolean>}
   */
  async isAlive() {
    try {
      const stdout = await new Promise((resolve, reject) => {
        execFile('playwright-cli', ['list'], {
          timeout: 5000,
          shell: process.platform === 'win32',
        }, (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        });
      });
      // Check if our session name appears with status: open
      return stdout.includes(`- ${this.name}:`) && stdout.includes('status: open');
    } catch {
      return false;
    }
  }

  /**
   * Destroy the session and close the browser.
   * Gracefully handles already-dead sessions.
   */
  async destroy() {
    if (this.state === SESSION_STATE.DESTROYED) return;

    const alive = await this.isAlive();
    if (alive) {
      try {
        await this._exec('close');
        console.log(`[Session ${this.name}] Closed`);
      } catch (err) {
        console.error(`[Session ${this.name}] Error during close:`, err.message);
      }
    } else {
      console.log(`[Session ${this.name}] Already dead, cleaning up`);
    }
    this._cdpEndpoint = null;
    this._setState(SESSION_STATE.DESTROYED);
    this._commandQueue = [];
  }

  /**
   * Get session info for listing
   * @returns {object} Session summary
   */
  getInfo() {
    return {
      id: this.id,
      name: this.name,
      state: this.state,
      currentUrl: this.currentUrl,
      hasSnapshot: !!this.lastSnapshot,
      snapshotLines: this.lastSnapshot ? this.lastSnapshot.split('\n').length : 0,
      lastError: this.lastError,
      cdpEndpoint: this._cdpEndpoint,
    };
  }
}
