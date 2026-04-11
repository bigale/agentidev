#!/usr/bin/env node
/**
 * Launch Browser with Extension
 *
 * Uses Playwright Node.js API to launch Chromium with the Agentidev
 * extension loaded. Must use Playwright bundled Chromium — Google Chrome
 * blocks --load-extension in automation mode since ~Chrome 130.
 *
 * Features:
 *  - Extension auto-loads and auto-connects to bridge server
 *  - Opens dashboard automatically
 *  - Outputs extension ID and connection info
 *  - Persistent profile preserves extension data across restarts
 *
 * Usage:
 *   node bridge/launch-browser.mjs                     # default: Chromium + dashboard
 *   node bridge/launch-browser.mjs --url=https://...   # open specific URL instead
 *   node bridge/launch-browser.mjs --profile=/path     # custom profile directory
 *   node bridge/launch-browser.mjs --headless           # headless mode
 *   node bridge/launch-browser.mjs --chrome             # use system Chrome (no extensions)
 *
 * npm scripts:
 *   npm run browser          # launch with extension
 *   npm run browser:chrome   # launch system Chrome (no extension support)
 */

import { chromium } from 'playwright';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = resolve(__dirname, '..', '..', 'extension');
const DEFAULT_PROFILE = resolve(process.env.HOME ?? process.env.USERPROFILE, '.agentidev', 'browser-profile');

// Parse args
const args = process.argv.slice(2);
const profileArg = args.find(a => a.startsWith('--profile='));
const urlArg = args.find(a => a.startsWith('--url='));
const headless = args.includes('--headless');
const useChrome = args.includes('--chrome');
const userDataDir = profileArg ? profileArg.split('=')[1] : DEFAULT_PROFILE;
const startUrl = urlArg ? urlArg.split('=').slice(1).join('=') : null;

// Ensure profile directory exists
mkdirSync(userDataDir, { recursive: true });

async function main() {
  let context;

  try {
    // Google Chrome blocks --load-extension in automation mode (~Chrome 130+)
    // Must use Playwright bundled Chromium for extension support
    const channel = useChrome ? 'chrome' : undefined;
    console.log(`[Launch] ${channel ? 'System Chrome (extensions NOT supported)' : 'Playwright Chromium'}`);
    console.log(`[Launch] Extension: ${EXTENSION_PATH}`);
    console.log(`[Launch] Profile:   ${userDataDir}`);

    context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      channel,
      args: [
        '--disable-gpu',
        '--no-sandbox',
        '--remote-debugging-port=9222',
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
      viewport: null,
      ignoreHTTPSErrors: true,
    });

    console.log('[Launch] Browser opened');

    // Wait for the extension's service worker
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      console.log('[Launch] Waiting for extension service worker...');
      try {
        serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15000 });
      } catch {
        console.error('[Launch] Extension service worker not detected after 15s');
        if (channel === 'chrome') {
          console.error('[Launch] Google Chrome blocks --load-extension in automation mode.');
          console.error('[Launch] Remove --chrome flag to use Playwright Chromium instead.');
        }
        console.log('[Launch] Browser is open but extension is not loaded.');
        console.log('[Launch] Press Ctrl+C to close.');
        await new Promise(r => { process.on('SIGINT', r); context.on('close', r); });
        return;
      }
    }

    const extensionId = serviceWorker.url().split('/')[2];

    // Health check
    try {
      const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
      console.log(`[Launch] ${manifest.name} v${manifest.version} (${extensionId})`);
    } catch {
      console.log(`[Launch] Extension ID: ${extensionId}`);
    }

    // Navigate to dashboard or custom URL
    const dashboardUrl = `chrome-extension://${extensionId}/dashboard/dashboard.html`;
    const page = context.pages()[0] || await context.newPage();

    if (startUrl) {
      await page.goto(startUrl);
      console.log(`[Launch] Navigated to: ${startUrl}`);
    } else {
      await page.goto(dashboardUrl);
      console.log(`[Launch] Dashboard: ${dashboardUrl}`);
    }

    // Connection info for tools/scripts
    console.log(JSON.stringify({
      extensionId,
      dashboardUrl,
      sidepanelUrl: `chrome-extension://${extensionId}/sidepanel/sidepanel.html`,
      profileDir: userDataDir,
    }, null, 2));

    console.log('[Launch] Ready. Press Ctrl+C to close.');

    // Keep alive
    await new Promise((resolve) => {
      process.on('SIGINT', resolve);
      process.on('SIGTERM', resolve);
      context.on('close', resolve);
    });

  } catch (err) {
    console.error(`[Launch] Error: ${err.message}`);
    if (err.message.includes('Target page, context or browser has been closed')) {
      console.error('[Launch] Browser crashed. Try: --disable-gpu or check DISPLAY.');
    }
    process.exit(1);
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
  }
}

main();
