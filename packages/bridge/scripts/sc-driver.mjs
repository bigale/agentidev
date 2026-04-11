#!/usr/bin/env node
/**
 * SmartClient Dashboard Driver — CDP remote control for the SC dashboard
 *
 * The SC dashboard lives at chrome-extension://<id>/smartclient-app/wrapper.html?mode=dashboard
 * and hosts a sandboxed iframe at app.html where SmartClient actually runs.
 *
 * Both the wrapper page and the sandbox iframe are separate CDP targets.
 * Use --frame=wrapper (default) to target the outer page, --frame=sandbox
 * to target the inner iframe where SmartClient lives.
 *
 * Commands:
 *   open                           — create target at wrapper URL (auto-detect extension ID)
 *   pages                          — list all relevant targets (wrapper + sandbox iframe)
 *   screenshot [path]              — capture PNG (wrapper frame only; iframe not independently visible)
 *   eval [--frame=sandbox] 'expr'  — evaluate JS in wrapper or sandbox
 *   console [--frame=sandbox] [--tail=N] — dump recent console messages
 *   status                         — SC dashboard state summary (uses sandbox frame)
 *
 * Requires browser launched with --remote-debugging-port=9222 (via `npm run browser`).
 */

import { get } from 'http';
import { writeFileSync } from 'fs';
import WebSocket from 'ws';

const CDP_PORT = 9222;
const DEFAULT_SCREENSHOT = '/tmp/sc-dashboard.png';
const SC_WRAPPER_HINT = 'smartclient-app/wrapper.html';
const SC_SANDBOX_HINT = 'smartclient-app/app.html';

// ---- CDP helpers ------------------------------------------------------------

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

function cdpSession(wsUrl, commands, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const results = new Array(commands.length);
    let received = 0;
    const timer = setTimeout(() => { ws.close(); reject(new Error('CDP session timed out')); }, timeoutMs);

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

    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// Persistent CDP for console capture
async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let idCounter = 0;
  const pending = new Map();
  const events = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  return {
    send: (method, params = {}) => {
      const id = ++idCounter;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    events,
    close: () => ws.close(),
  };
}

// ---- Target discovery -------------------------------------------------------

async function detectExtensionId() {
  const targets = await httpGet(`http://localhost:${CDP_PORT}/json`);
  const extTarget = targets.find(t => t.url.startsWith('chrome-extension://'));
  if (!extTarget) throw new Error('No chrome-extension targets found. Is the extension loaded?');
  return extTarget.url.split('/')[2];
}

async function findWrapperTarget() {
  const targets = await httpGet(`http://localhost:${CDP_PORT}/json`);
  const wrapper = targets.find(t => t.type === 'page' && t.url.includes(SC_WRAPPER_HINT));
  if (!wrapper) throw new Error(`No SC wrapper target found. Run 'sc-driver open' first.`);
  return wrapper;
}

async function findSandboxTarget() {
  const targets = await httpGet(`http://localhost:${CDP_PORT}/json`);
  const sandbox = targets.find(t => t.type === 'iframe' && t.url.includes(SC_SANDBOX_HINT));
  if (!sandbox) throw new Error(`No SC sandbox iframe target found. Wrapper must be open and loaded.`);
  return sandbox;
}

function parseFrame(args) {
  const frameArg = args.find(a => a.startsWith('--frame='));
  return frameArg ? frameArg.split('=')[1] : 'sandbox';  // default sandbox (where SC lives)
}

async function findTarget(frame) {
  if (frame === 'wrapper') return findWrapperTarget();
  if (frame === 'sandbox') return findSandboxTarget();
  throw new Error(`Unknown frame: ${frame}. Use 'wrapper' or 'sandbox'.`);
}

// ---- Commands ---------------------------------------------------------------

async function cmdOpen() {
  const extId = await detectExtensionId();
  const scUrl = `chrome-extension://${extId}/smartclient-app/wrapper.html?mode=dashboard`;

  // Check if already open
  const targets = await httpGet(`http://localhost:${CDP_PORT}/json`);
  const existing = targets.find(t => t.type === 'page' && t.url.includes(SC_WRAPPER_HINT));
  if (existing) {
    console.log(`Already open: ${existing.url}`);
    console.log(`Target ID: ${existing.id}`);
    return;
  }

  // Create new target via browser-level WS
  const browserInfo = await httpGet(`http://localhost:${CDP_PORT}/json/version`);
  const [result] = await cdpSession(browserInfo.webSocketDebuggerUrl, [
    { method: 'Target.createTarget', params: { url: scUrl } },
  ]);
  console.log(`Opened SC dashboard: ${scUrl}`);
  console.log(`Target ID: ${result.targetId}`);

  // Poll briefly for the sandbox iframe to appear
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    const updated = await httpGet(`http://localhost:${CDP_PORT}/json`);
    const sandbox = updated.find(t => t.type === 'iframe' && t.url.includes(SC_SANDBOX_HINT));
    if (sandbox) {
      console.log(`Sandbox iframe ready: ${sandbox.id}`);
      return;
    }
  }
  console.warn('Sandbox iframe not detected after 5s — it may still be loading.');
}

async function cmdPages() {
  const targets = await httpGet(`http://localhost:${CDP_PORT}/json`);
  const relevant = targets.filter(t =>
    t.url.includes(SC_WRAPPER_HINT) ||
    t.url.includes(SC_SANDBOX_HINT) ||
    t.type === 'iframe'
  );
  if (relevant.length === 0) {
    console.log('No SC targets. Run `sc-driver open` first.');
    return;
  }
  for (const t of relevant) {
    console.log(`[${t.type}] ${(t.title || '(no title)').slice(0, 50)}`);
    console.log(`  ID:  ${t.id}`);
    console.log(`  URL: ${t.url}`);
  }
}

async function cmdScreenshot(outputPath = DEFAULT_SCREENSHOT) {
  // Raw CDP Page.captureScreenshot on the wrapper produces a black PNG under
  // WSL2 + --disable-gpu because the software compositor can't composite the
  // cross-origin sandboxed iframe into the parent surface.
  //
  // Workaround: use Playwright's connectOverCDP + iframe element screenshot,
  // which routes compositing through the browser process.
  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  try {
    let wrapperPage = null;
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        if (page.url().includes(SC_WRAPPER_HINT)) { wrapperPage = page; break; }
      }
      if (wrapperPage) break;
    }
    if (!wrapperPage) throw new Error('SC wrapper page not found. Run `sc-driver open` first.');
    const iframeEl = wrapperPage.locator('iframe').first();
    const buf = await iframeEl.screenshot({ type: 'png' });
    writeFileSync(outputPath, buf);
    console.log(`Screenshot saved: ${outputPath} (${buf.length} bytes)`);
  } finally {
    await browser.close();
  }
}

async function cmdEval(expression, frame) {
  const target = await findTarget(frame);
  const [result] = await cdpSession(target.webSocketDebuggerUrl, [
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

async function cmdConsole(frame, tailCount = 50, durationMs = 2000) {
  const target = await findTarget(frame);
  const session = await cdpConnect(target.webSocketDebuggerUrl);
  try {
    await session.send('Runtime.enable');
    await session.send('Log.enable');
    // Capture existing messages + new ones for durationMs
    await new Promise(r => setTimeout(r, durationMs));

    const messages = [];
    for (const evt of session.events) {
      if (evt.method === 'Runtime.consoleAPICalled') {
        const args = (evt.params.args || []).map(a =>
          a.value !== undefined ? String(a.value) :
          a.description || a.type
        ).join(' ');
        messages.push({ type: evt.params.type, text: args, timestamp: evt.params.timestamp });
      } else if (evt.method === 'Log.entryAdded') {
        const e = evt.params.entry;
        messages.push({ type: `[log:${e.level}]`, text: e.text, timestamp: e.timestamp });
      } else if (evt.method === 'Runtime.exceptionThrown') {
        const e = evt.params.exceptionDetails;
        messages.push({
          type: 'exception',
          text: e.exception?.description || e.text,
          timestamp: evt.params.timestamp,
        });
      }
    }

    const shown = messages.slice(-tailCount);
    if (shown.length === 0) {
      console.log(`(no console messages in last ${durationMs}ms)`);
    } else {
      for (const m of shown) {
        console.log(`[${m.type}] ${m.text}`);
      }
    }
  } finally {
    session.close();
  }
}

async function cmdStatus() {
  const target = await findSandboxTarget();  // SC lives in the iframe
  const js = `(() => {
    const status = {
      iscDefined: typeof isc !== 'undefined',
      renderConfigDefined: typeof renderConfig === 'function',
      dashboardConfigDefined: !!window._dashboardConfig,
      loadedScriptName: typeof _loadedScriptName !== 'undefined' ? _loadedScriptName : null,
      connected: typeof _dashState !== 'undefined' ? _dashState.connected : null,
    };
    if (status.iscDefined) {
      try {
        status.scVersion = isc.version;
        status.hasAutoTest = !!isc.AutoTest;
      } catch {}
      try {
        const toolbar = isc.Canvas.getById && isc.Canvas.getById('dashToolbar');
        status.toolbarFound = !!toolbar;
      } catch {}
    }
    return status;
  })()`;
  const [result] = await cdpSession(target.webSocketDebuggerUrl, [
    { method: 'Runtime.evaluate', params: { expression: js, returnByValue: true } },
  ]);
  if (result.exceptionDetails) {
    console.error('Error:', result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    process.exit(1);
  }
  console.log(JSON.stringify(result.result?.value, null, 2));
}

// ---- Main -------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0];
const positional = args.filter(a => !a.startsWith('--'));
const tailArg = args.find(a => a.startsWith('--tail='));
const tailCount = tailArg ? parseInt(tailArg.split('=')[1], 10) : 50;

try {
  switch (command) {
    case 'open':
      await cmdOpen();
      break;
    case 'pages':
      await cmdPages();
      break;
    case 'screenshot':
      await cmdScreenshot(positional[1]);
      break;
    case 'eval':
      if (!positional[1]) { console.error('Usage: sc-driver eval [--frame=sandbox|wrapper] <expr>'); process.exit(1); }
      await cmdEval(positional[1], parseFrame(args));
      break;
    case 'console':
      await cmdConsole(parseFrame(args), tailCount);
      break;
    case 'status':
      await cmdStatus();
      break;
    default:
      console.log('SC Dashboard Driver — CDP control for smartclient-app/wrapper.html?mode=dashboard\n');
      console.log('Commands:');
      console.log('  open                              Create target at SC dashboard URL');
      console.log('  pages                             List wrapper + sandbox targets');
      console.log('  screenshot [path]                 Save PNG of wrapper (default /tmp/sc-dashboard.png)');
      console.log('  eval [--frame=sandbox] <expr>     Evaluate JS in wrapper or sandbox (default: sandbox)');
      console.log('  console [--frame=sandbox] [--tail=N]  Dump console messages');
      console.log('  status                            SC dashboard state summary');
      console.log('\nRequires browser launched with `npm run browser` (opens on --remote-debugging-port=9222).');
      process.exit(command ? 1 : 0);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
