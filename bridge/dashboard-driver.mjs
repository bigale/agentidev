#!/usr/bin/env node
/**
 * Dashboard Driver — remote control the dashboard via CDP
 *
 * Connects to the running browser via Chrome DevTools Protocol (CDP port 9222)
 * and allows screenshot, eval, and click commands on the dashboard page.
 *
 * Usage:
 *   node bridge/dashboard-driver.mjs screenshot [path]     # save screenshot (default: /tmp/dashboard.png)
 *   node bridge/dashboard-driver.mjs eval 'js expression'  # evaluate JS in dashboard context
 *   node bridge/dashboard-driver.mjs click '#selector'     # click an element by CSS selector
 *   node bridge/dashboard-driver.mjs pages                 # list available pages
 *   node bridge/dashboard-driver.mjs status                # get dashboard state summary
 */

import { get } from 'http';
import { writeFileSync } from 'fs';
import WebSocket from 'ws';

const CDP_PORT = 9222;
const DEFAULT_SCREENSHOT = '/tmp/dashboard.png';

// ─── CDP Helpers ────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON from ${url}`)); }
      });
    }).on('error', reject);
  });
}

/**
 * Send one or more CDP commands over a single WebSocket connection.
 * @param {string} wsUrl - WebSocket debugger URL
 * @param {Array<{method: string, params?: object}>} commands - Commands to send
 * @returns {Promise<Array<object>>} Results in order
 */
function cdpSession(wsUrl, commands) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const results = new Array(commands.length);
    let received = 0;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('CDP session timed out'));
    }, 15000);

    ws.on('open', () => {
      commands.forEach((cmd, i) => {
        ws.send(JSON.stringify({ id: i + 1, method: cmd.method, params: cmd.params || {} }));
      });
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id >= 1 && msg.id <= commands.length) {
        if (msg.error) {
          clearTimeout(timer);
          ws.close();
          reject(new Error(`CDP error (${commands[msg.id - 1].method}): ${msg.error.message}`));
          return;
        }
        results[msg.id - 1] = msg.result;
        received++;
        if (received === commands.length) {
          clearTimeout(timer);
          ws.close();
          resolve(results);
        }
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function findDashboard() {
  const targets = await httpGet(`http://localhost:${CDP_PORT}/json`);
  const dashboard = targets.find(t =>
    t.type === 'page' && t.url.includes('dashboard/dashboard.html')
  );
  if (dashboard) return dashboard;

  const extPage = targets.find(t =>
    t.type === 'page' && t.url.startsWith('chrome-extension://')
  );
  if (extPage) return extPage;

  const firstPage = targets.find(t => t.type === 'page');
  if (firstPage) return firstPage;

  throw new Error('No page targets found. Is the browser running with --remote-debugging-port=9222?');
}

function getWsUrl(target) {
  const wsUrl = target.webSocketDebuggerUrl;
  if (!wsUrl) {
    throw new Error('No webSocketDebuggerUrl — target may be attached by DevTools.');
  }
  return wsUrl;
}

// ─── Commands ───────────────────────────────────────────────

async function cmdScreenshot(outputPath = DEFAULT_SCREENSHOT) {
  const target = await findDashboard();
  const [result] = await cdpSession(getWsUrl(target), [
    { method: 'Page.captureScreenshot', params: { format: 'png', captureBeyondViewport: true } },
  ]);
  const buf = Buffer.from(result.data, 'base64');
  writeFileSync(outputPath, buf);
  console.log(`Screenshot saved: ${outputPath} (${buf.length} bytes)`);
}

async function cmdEval(expression) {
  const target = await findDashboard();
  const [result] = await cdpSession(getWsUrl(target), [
    { method: 'Runtime.evaluate', params: {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }},
  ]);

  if (result.exceptionDetails) {
    const desc = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    console.error(`Error: ${desc}`);
    process.exit(1);
  }

  const val = result.result?.value;
  if (val !== undefined) {
    console.log(typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val));
  } else {
    console.log(result.result?.description || result.result?.type || '(no return value)');
  }
}

async function cmdClick(selector) {
  const js = `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: 'Element not found: ${selector}' };
      el.click();
      return { clicked: true, tag: el.tagName, id: el.id, text: el.textContent?.slice(0, 50) };
    })()
  `;
  await cmdEval(js);
}

async function cmdPages() {
  const targets = await httpGet(`http://localhost:${CDP_PORT}/json`);
  for (const t of targets) {
    if (t.type === 'page') {
      console.log(`[${t.type}] ${t.title || '(no title)'}`);
      console.log(`  URL: ${t.url}`);
    }
  }
}

async function cmdStatus() {
  const js = `
    (() => {
      const bridgeStatus = document.getElementById('dash-bridge-status')?.textContent;
      const fileLabel = document.getElementById('source-file-label')?.textContent;
      const scriptCount = document.getElementById('scripts-count')?.textContent;
      const debugTitle = document.getElementById('debug-panel-title')?.textContent;
      const tbRun = document.getElementById('tb-run');
      const tbDebug = document.getElementById('tb-debug');
      const tbStep = document.getElementById('tb-step');
      const tbStepInto = document.getElementById('tb-step-into');
      const tbStepOut = document.getElementById('tb-step-out');
      const tbContinue = document.getElementById('tb-continue');
      const dashState = window.__dashTest?.getState?.() || {};
      return {
        bridgeStatus,
        loadedScript: fileLabel,
        scriptCount,
        debugTitle,
        buttons: {
          run: tbRun ? !tbRun.disabled : null,
          debug: tbDebug ? !tbDebug.disabled : null,
          step: tbStep ? !tbStep.disabled : null,
          stepInto: tbStepInto ? !tbStepInto.disabled : null,
          stepOut: tbStepOut ? !tbStepOut.disabled : null,
          continue: tbContinue ? !tbContinue.disabled : null,
        },
        v8Debug: dashState.v8Debug || false,
        v8PausedLine: dashState.v8PausedLine || null,
        // Count gutter decorations by class
        breakpoints: document.querySelectorAll('.monaco-bp-active').length,
        checkpoints: document.querySelectorAll('.monaco-bp-inactive').length,
        currentLine: document.querySelectorAll('.monaco-bp-current').length,
      };
    })()
  `;
  await cmdEval(js);
}

// ─── CLI ────────────────────────────────────────────────────
const [command, ...rest] = process.argv.slice(2);

if (!command || command === '--help' || command === '-h') {
  console.log(`Dashboard Driver — remote control via CDP

Commands:
  screenshot [path]       Take screenshot (default: /tmp/dashboard.png)
  eval 'js expression'    Evaluate JS in dashboard page context
  click '#selector'       Click element by CSS selector
  pages                   List available browser pages
  status                  Get dashboard state summary

Requires browser launched with --remote-debugging-port=9222`);
  process.exit(0);
}

try {
  switch (command) {
    case 'screenshot': await cmdScreenshot(rest[0]); break;
    case 'eval':       await cmdEval(rest.join(' ')); break;
    case 'click':      await cmdClick(rest[0]); break;
    case 'pages':      await cmdPages(); break;
    case 'status':     await cmdStatus(); break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
