/**
 * Playwright Bridge Shim
 *
 * Drop-in replacement for `playwright` that transparently wires any Playwright
 * script into the bridge: auto-connect, per-page intercept breakpoints,
 * step counting, and auto-complete on exit.
 *
 * Usage — change ONE line in any Playwright script:
 *
 *   // Before:
 *   import { chromium } from 'playwright';
 *
 *   // After (everything else stays the same):
 *   import { chromium } from '../bridge/playwright-shim.mjs';
 *
 * What you get for free:
 *   - Script appears in dashboard with live step count
 *   - Per-page intercept toggles in dashboard/sidepanel:
 *       p1:navigate  p1:click  p1:input  p1:wait  p1:eval  p1:screenshot
 *   - Force-kill (SIGKILL) from dashboard always works
 *   - Script auto-completes when process exits normally
 *   - Uncaught exceptions forwarded to bridge as errors
 *
 * Optional — if you want named checkpoints, import client directly:
 *   import { chromium, client } from '../bridge/playwright-shim.mjs';
 *   await client.checkpoint('my_checkpoint', { race, step });
 */

import path from 'path';
import playwright from 'playwright';
import { ScriptClient } from './script-client.mjs';

// ---- Auto-detected script name from process.argv[1] ----
const scriptName = process.argv[1]
  ? path.basename(process.argv[1], path.extname(process.argv[1]))
  : 'script';

// ---- Create and connect bridge client ----
export const client = new ScriptClient(scriptName, {
  pid: process.pid,
  // totalSteps unknown — progress shows raw count, no percentage
});

try {
  await client.connect();
} catch {
  // Bridge unavailable — run normally without instrumentation
  console.warn('[playwright-shim] Bridge unavailable — running without instrumentation');
}

// ---- Lifecycle hooks ----

let _completed = false;

async function _autoComplete() {
  if (_completed || !client.scriptId) return;
  _completed = true;
  try { await client.complete(); } catch { /* ignore */ }
}

process.on('beforeExit', async () => {
  await _autoComplete();
});

// Patch process.exit so explicit exit() also completes
const _origExit = process.exit.bind(process);
process.exit = async (code) => {
  await _autoComplete();
  _origExit(code);
};

process.on('uncaughtException', async (err) => {
  await client.reportError(`Uncaught: ${err.message}`);
  _origExit(1);
});

process.on('unhandledRejection', async (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  await client.reportError(`Unhandled rejection: ${msg}`);
  _origExit(1);
});

// ---- Page intercept categories ----

const INTERCEPT_CATEGORIES = {
  navigate:   ['goto', 'reload', 'goBack', 'goForward', 'waitForURL'],
  click:      ['click', 'dblclick', 'tap', 'hover'],
  input:      ['fill', 'type', 'press', 'check', 'uncheck', 'selectOption', 'setInputFiles'],
  wait:       ['waitForSelector', 'waitForLoadState', 'waitForFunction', 'waitForTimeout'],
  eval:       ['evaluate', '$eval', '$$eval'],
  screenshot: ['screenshot'],
};

// method → category (reverse lookup)
const METHOD_CATEGORY = {};
for (const [cat, methods] of Object.entries(INTERCEPT_CATEGORIES)) {
  for (const m of methods) METHOD_CATEGORY[m] = cat;
}

// ---- Session browser endpoint (from BRIDGE_CDP_ENDPOINT env) ----
const _bridgeCdpEndpoint = process.env.BRIDGE_CDP_ENDPOINT || null;
if (_bridgeCdpEndpoint) {
  console.log(`[playwright-shim] Will connect to session browser via CDP: ${_bridgeCdpEndpoint}`);
}

// ---- Auth state auto-load (from PLAYWRIGHT_AUTH_STATE env) ----
const _authStatePath = process.env.PLAYWRIGHT_AUTH_STATE || null;
if (_authStatePath) {
  console.log(`[playwright-shim] Auth state will be injected: ${_authStatePath}`);
}

let _pageCounter = 0;

// ---- Wrap a Page instance ----

function wrapPage(page) {
  const pageId = `p${++_pageCounter}`;
  let _stepCount = 0;

  // Declare intercept checkpoints for this page
  for (const cat of Object.keys(INTERCEPT_CATEGORIES)) {
    client.declareCheckpoint(`${pageId}:${cat}`).catch(() => {});
  }

  // Track URL updates
  function reportUrl() {
    try {
      const url = page.url();
      if (url && url !== 'about:blank') {
        client.reportPage(pageId, url, '');
      }
    } catch { /* ignore */ }
  }

  page.on('load', reportUrl);
  page.on('domcontentloaded', reportUrl);

  // Report initial URL
  reportUrl();

  return new Proxy(page, {
    get(target, prop, receiver) {
      const category = METHOD_CATEGORY[prop];
      if (category && typeof target[prop] === 'function') {
        return async function (...args) {
          _stepCount++;

          // Build context for the checkpoint panel
          const context = { method: prop };
          if (prop === 'goto' || prop === 'waitForURL') context.url = args[0];
          else if (typeof args[0] === 'string') context.selector = args[0];

          // Checkpoint — zero-cost if not toggled, blocks if active
          await client.checkpoint(`${pageId}:${category}`, context);

          // Auto-increment progress counter
          client.setActivity(`${pageId}: ${prop}(${args[0] ? String(args[0]).slice(0, 60) : ''})`);

          const result = await target[prop].apply(target, args);

          // After navigation: update page URL
          if (category === 'navigate') {
            reportUrl();
          }

          return result;
        };
      }

      // newPage inside frames — not typical but handle gracefully
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
}

// ---- Wrap a BrowserContext instance ----

function wrapContext(context) {
  const origNewPage = context.newPage.bind(context);
  context.newPage = async (...args) => {
    const page = await origNewPage(...args);
    return wrapPage(page);
  };
  return context;
}

// ---- Wrap a Browser instance ----

function wrapBrowser(browser, isSessionBrowser = false) {
  const origNewPage = browser.newPage.bind(browser);
  const origNewContext = browser.newContext.bind(browser);

  browser.newPage = async (opts = {}) => {
    if (_authStatePath && !opts.storageState) {
      opts = { ...opts, storageState: _authStatePath };
    }
    const page = await origNewPage(opts);
    return wrapPage(page);
  };

  browser.newContext = async (opts = {}) => {
    if (_authStatePath && !opts.storageState) {
      opts = { ...opts, storageState: _authStatePath };
    }
    const context = await origNewContext(opts);
    return wrapContext(context);
  };

  // Session browser: close() disconnects only (don't kill the session's browser)
  if (isSessionBrowser) {
    browser.close = async () => {
      console.log('[playwright-shim] Disconnecting from session browser (not closing)');
      // Close only contexts created by this script, then disconnect
      for (const ctx of browser.contexts()) {
        try { await ctx.close(); } catch { /* ignore */ }
      }
    };
  }

  return browser;
}

// ---- Wrap a BrowserType (chromium / firefox / webkit) ----

function wrapBrowserType(browserType) {
  return new Proxy(browserType, {
    get(target, prop, receiver) {
      if (prop === 'launch') {
        return async (...args) => {
          // If session CDP endpoint is set, connect instead of launching a new browser
          if (_bridgeCdpEndpoint) {
            console.log(`[playwright-shim] Connecting to session browser via CDP instead of launching`);
            const browser = await target.connectOverCDP(_bridgeCdpEndpoint);
            return wrapBrowser(browser, true);
          }
          // Default to headed unless headless is explicitly set
          const opts = args[0] && typeof args[0] === 'object' ? args[0] : {};
          if (opts.headless === undefined) {
            args[0] = { ...opts, headless: false };
          }
          const browser = await target.launch(...args);
          return wrapBrowser(browser, false);
        };
      }
      if (prop === 'launchPersistentContext') {
        return async (userDataDir, opts = {}) => {
          if (_authStatePath && !opts.storageState) {
            opts = { ...opts, storageState: _authStatePath };
          }
          // If session CDP endpoint is set, connect + create a new context
          if (_bridgeCdpEndpoint) {
            console.log(`[playwright-shim] Connecting to session browser via CDP (persistent context mode)`);
            const browser = await target.connectOverCDP(_bridgeCdpEndpoint);
            const wrapped = wrapBrowser(browser, true);
            const context = await wrapped.newContext(opts);
            return wrapContext(context);
          }
          const context = await target.launchPersistentContext(userDataDir, opts);
          return wrapContext(context);
        };
      }
      if (prop === 'connect' || prop === 'connectOverCDP') {
        return async (...args) => {
          const browser = await target[prop](...args);
          return wrapBrowser(browser, false);
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
}

// ---- Exports (same API surface as 'playwright') ----

export const chromium = wrapBrowserType(playwright.chromium);
export const firefox  = wrapBrowserType(playwright.firefox);
export const webkit   = wrapBrowserType(playwright.webkit);

// Re-export everything else from playwright unchanged
export const { devices, errors, selectors, request } = playwright;
export default playwright;
