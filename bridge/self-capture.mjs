#!/usr/bin/env node
/**
 * self-capture.mjs — Screenshot and snapshot our own extension pages via CDP.
 *
 * Problem: Playwright blocks chrome-extension:// URLs. External CDP Target.createTarget
 * also gets ERR_BLOCKED_BY_CLIENT for extension pages.
 *
 * Solution:
 *   1. Connect to the browser that has the extension loaded (npm run browser, port 9222)
 *   2. Find the extension's service worker via Target.getTargets
 *   3. Use Runtime.evaluate on the SW to call chrome.tabs.create() — opens pages
 *      from INSIDE the extension context (bypasses block)
 *   4. For sandboxed iframes (app.html): open as top-level tab (CDP can't screenshot
 *      iframe targets — "Command can only be executed on top-level targets")
 *   5. Raw WebSocket CDP with flattened sessionId for Page.captureScreenshot +
 *      Accessibility.getFullAXTree + DOMSnapshot.captureSnapshot
 *
 * Usage:
 *   node bridge/self-capture.mjs                           # defaults to port 9222
 *   CDP_PORT=9222 node bridge/self-capture.mjs             # explicit port
 *   CDP_PORT=9222 OUTPUT_DIR=./shots node bridge/self-capture.mjs
 *
 * Requires: npm run browser (Chromium with extension loaded on --remote-debugging-port=9222)
 */
import WebSocket from 'ws';
import { writeFileSync, mkdirSync } from 'fs';

const EXT_ID = 'dgiafohfhcccadmpanfknjajfkmgbkig';
const CDP_PORT = process.env.CDP_PORT || '9222';
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/tmp/self-capture';

mkdirSync(OUTPUT_DIR, { recursive: true });

// ---- Raw CDP helpers ----

/**
 * Open a raw WebSocket to the browser, find a target by URL, attach, and capture
 * screenshot + a11y tree + DOM snapshot.
 */
function captureByUrl(wsUrl, urlMatch, name, opts = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let id = 1;
    const pending = new Map();
    let sessionId = null;

    const send = (method, params = {}) => {
      const mid = id++;
      return new Promise((res, rej) => {
        pending.set(mid, { res, rej });
        const msg = { id: mid, method, params };
        if (sessionId) msg.sessionId = sessionId;
        ws.send(JSON.stringify(msg));
        setTimeout(() => {
          if (pending.has(mid)) { pending.delete(mid); rej(new Error(`Timeout: ${method}`)); }
        }, 15000);
      });
    };

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    });

    ws.on('open', async () => {
      try {
        // Find target by URL substring, preferring page targets over iframe
        const { targetInfos } = await send('Target.getTargets');
        const matches = targetInfos.filter(t => t.url && t.url.includes(urlMatch));
        const target = matches.find(t => t.type === 'page') || matches[0];
        if (!target) {
          console.log(`[${name}] Target not found: ${urlMatch}`);
          ws.close();
          resolve({ screenshotPath: null, axNodeCount: 0 });
          return;
        }
        console.log(`[${name}] Found: ${target.type} ${target.targetId.substring(0, 16)}`);

        // Attach with flattened protocol
        const att = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        sessionId = att.sessionId;
        await send('Page.enable').catch(() => {});

        // Viewport override (e.g. for sidepanel narrow width)
        if (opts.width) {
          await send('Emulation.setDeviceMetricsOverride', {
            width: opts.width, height: opts.height || 900, deviceScaleFactor: 1, mobile: false,
          }).catch(() => {});
          await new Promise(r => setTimeout(r, 500));
        }

        // Screenshot
        let screenshotPath = null;
        try {
          const ss = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
          if (ss && ss.data) {
            screenshotPath = `${OUTPUT_DIR}/${name}.png`;
            writeFileSync(screenshotPath, Buffer.from(ss.data, 'base64'));
            console.log(`[${name}] Screenshot saved`);
          }
        } catch (e) {
          console.log(`[${name}] Screenshot failed: ${e.message}`);
        }

        // Accessibility tree
        let axNodeCount = 0;
        try {
          const ax = await send('Accessibility.getFullAXTree');
          if (ax && ax.nodes) {
            axNodeCount = ax.nodes.length;
            writeFileSync(`${OUTPUT_DIR}/${name}-a11y.json`, JSON.stringify(ax.nodes, null, 2));
            console.log(`[${name}] A11y: ${axNodeCount} nodes`);
          }
        } catch (e) {
          console.log(`[${name}] A11y failed: ${e.message}`);
        }

        // DOM snapshot
        try {
          const dom = await send('DOMSnapshot.captureSnapshot', {
            computedStyles: ['display', 'visibility', 'opacity'],
          });
          if (dom && dom.documents) {
            writeFileSync(`${OUTPUT_DIR}/${name}-dom.json`, JSON.stringify(dom, null, 2));
            console.log(`[${name}] DOM: ${dom.documents.length} doc(s)`);
          }
        } catch (e) {
          console.log(`[${name}] DOM failed: ${e.message}`);
        }

        ws.close();
        resolve({ screenshotPath, axNodeCount });
      } catch (e) {
        console.log(`[${name}] Error: ${e.message}`);
        ws.close();
        resolve({ screenshotPath: null, axNodeCount: 0 });
      }
    });

    ws.on('error', () => resolve({ screenshotPath: null, axNodeCount: 0 }));
  });
}

/**
 * Evaluate an expression on the extension's service worker via raw CDP.
 */
function evalOnServiceWorker(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 1;
    const pending = new Map();
    let sessionId = null;

    const send = (method, params = {}) => {
      const mid = id++;
      return new Promise((res, rej) => {
        pending.set(mid, { res, rej });
        const msg = { id: mid, method, params };
        if (sessionId) msg.sessionId = sessionId;
        ws.send(JSON.stringify(msg));
        setTimeout(() => {
          if (pending.has(mid)) { pending.delete(mid); rej(new Error(`Timeout: ${method}`)); }
        }, 15000);
      });
    };

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    });

    ws.on('open', async () => {
      try {
        // Find service worker target
        const { targetInfos } = await send('Target.getTargets');
        const sw = targetInfos.find(t => t.type === 'service_worker' && t.url && t.url.includes(EXT_ID));
        if (!sw) {
          ws.close();
          reject(new Error('Extension service worker not found. Is npm run browser running?'));
          return;
        }

        const att = await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
        sessionId = att.sessionId;
        await send('Runtime.enable');

        const result = await send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });

        ws.close();
        if (result && result.result && result.result.value !== undefined) {
          resolve(result.result.value);
        } else if (result && result.exceptionDetails) {
          reject(new Error(result.exceptionDetails.text || 'SW eval error'));
        } else {
          resolve(result && result.result);
        }
      } catch (err) {
        ws.close();
        reject(err);
      }
    });

    ws.on('error', (err) => reject(err));
  });
}

// ---- Main ----

async function main() {
  const httpBase = `localhost:${CDP_PORT}`;
  console.log(`[self-capture] CDP: http://${httpBase}`);
  console.log(`[self-capture] Output: ${OUTPUT_DIR}/`);

  // Get browser WebSocket URL
  const versionData = await fetch(`http://${httpBase}/json/version`).then(r => r.json());
  const wsUrl = versionData.webSocketDebuggerUrl;

  // Verify service worker is present
  const targets = await fetch(`http://${httpBase}/json/list`).then(r => r.json());
  const swTarget = targets.find(t => t.type === 'service_worker' && t.url && t.url.includes(EXT_ID));
  if (!swTarget) {
    console.error('[self-capture] Extension service worker not found.');
    console.error('  Make sure `npm run browser` is running (Chromium with extension on port 9222).');
    console.error('  Session daemon browsers (from session:create) do NOT have the extension loaded.');
    process.exit(1);
  }
  console.log(`[self-capture] Service worker found: ${swTarget.url}`);

  // List existing extension targets
  const extTargets = targets.filter(t => t.url && t.url.includes(EXT_ID));
  console.log(`[self-capture] Extension targets: ${extTargets.length}`);
  for (const t of extTargets) {
    console.log(`  [${t.type}] ${t.title || '(untitled)'}`);
  }

  // --- Open pages via service worker (inside extension context) ---

  const tabIds = [];

  // SmartClient app.html as TOP-LEVEL tab (not inside wrapper iframe)
  // because CDP can't screenshot iframe targets
  console.log('\n[self-capture] Opening app.html as top-level tab...');
  const appTabId = await evalOnServiceWorker(wsUrl,
    `new Promise(r => chrome.tabs.create({ url: chrome.runtime.getURL('smartclient-app/app.html'), active: false }, t => r(t.id)))`
  );
  tabIds.push(appTabId);
  console.log(`  Tab ${appTabId} created, waiting 8s for SmartClient init...`);
  await new Promise(r => setTimeout(r, 8000));

  // Sidepanel as tab
  console.log('[self-capture] Opening sidepanel as tab...');
  const spTabId = await evalOnServiceWorker(wsUrl,
    `new Promise(r => chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/sidepanel.html'), active: false }, t => r(t.id)))`
  );
  tabIds.push(spTabId);
  console.log(`  Tab ${spTabId} created`);
  await new Promise(r => setTimeout(r, 2000));

  // --- Capture ---

  const app = await captureByUrl(wsUrl, 'smartclient-app/app.html', 'smartclient-app');
  const dashboard = await captureByUrl(wsUrl, 'dashboard/dashboard.html', 'dashboard');
  const sidepanel = await captureByUrl(wsUrl, 'sidepanel/sidepanel.html', 'sidepanel', { width: 400, height: 800 });

  // --- Cleanup: close tabs we opened ---
  for (const tabId of tabIds) {
    await evalOnServiceWorker(wsUrl, `chrome.tabs.remove(${tabId})`).catch(() => {});
  }

  // --- Summary ---
  console.log('\n=== Self-Capture Results ===');
  const results = { 'SmartClient app': app, Dashboard: dashboard, Sidepanel: sidepanel };
  for (const [label, r] of Object.entries(results)) {
    const ss = r.screenshotPath ? 'OK' : 'FAILED';
    const ax = r.axNodeCount || 0;
    console.log(`  ${label.padEnd(18)} screenshot: ${ss.padEnd(8)} a11y: ${ax} nodes`);
  }
  console.log(`  Output: ${OUTPUT_DIR}/`);
}

main().catch(err => {
  console.error('[self-capture] Fatal:', err.message);
  process.exit(1);
});
