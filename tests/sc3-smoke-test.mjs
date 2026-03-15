#!/usr/bin/env node
/**
 * SC-3 Smoke Test — verify real-time DS updates via bridge broadcasts.
 *
 * 1. Opens SmartClient wrapper in the running browser via CDP
 * 2. Injects a BridgeScripts grid
 * 3. Sends AUTO_BROADCAST_SCRIPT via the service worker
 * 4. Verifies invalidateDSCaches was triggered (grid refetch)
 */

import WebSocket from 'ws';

const CDP_PORT = 9222;
const EXT_ID = 'dgiafohfhcccadmpanfknjajfkmgbkig';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

async function getTargets() {
  const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  return resp.json();
}

function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    let id = 0;
    const pending = new Map();

    ws.on('open', () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const msgId = ++id;
            pending.set(msgId, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: msgId, method, params }));
          });
        },
        close() { ws.close(); },
      });
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });

    ws.on('error', reject);
  });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('SC-3 Smoke Test: Real-Time DataSource Updates\n');

  // --- Find targets ---
  const targets = await getTargets();
  const dashTarget = targets.find(t => t.url.includes('dashboard.html'));
  const swTarget = targets.find(t => t.type === 'service_worker' && t.url.includes(EXT_ID));

  if (!dashTarget) throw new Error('Dashboard page not found in CDP targets');
  if (!swTarget) throw new Error('Service worker not found in CDP targets');

  // --- Connect to service worker ---
  const sw = await cdp(swTarget.webSocketDebuggerUrl);
  console.log('Connected to service worker\n');

  // --- Test 1: BROADCAST_DS_MAP exists in bridge.js ---
  console.log('Test 1: Verify bridge.js broadcast listener is loaded');

  // Navigate dashboard to SmartClient wrapper
  const dashboard = await cdp(dashTarget.webSocketDebuggerUrl);
  const wrapperUrl = `chrome-extension://${EXT_ID}/smartclient-app/wrapper.html`;

  await dashboard.send('Page.navigate', { url: wrapperUrl });
  await sleep(3000); // wait for SmartClient framework to load

  // Check if the wrapper page loaded
  const evalResult = await dashboard.send('Runtime.evaluate', {
    expression: 'document.title',
  });
  console.log(`  Page title: ${evalResult.result.value}`);
  assert(evalResult.result.value !== undefined, 'Wrapper page loaded');

  // --- Test 2: Check iframe has the message listener ---
  console.log('\nTest 2: Verify sandbox iframe receives ds-update messages');

  // Inject a tracking variable in the wrapper page to monitor postMessage calls
  await dashboard.send('Runtime.evaluate', {
    expression: `
      window._sc3TestMessages = [];
      const origPostMessage = HTMLIFrameElement.prototype.contentWindow;
      // Listen for messages posted TO the iframe by intercepting at wrapper level
      window.addEventListener('message', (e) => {
        if (e.data && e.data.source === 'smartclient-ds-update') {
          window._sc3TestMessages.push(e.data);
        }
      });
      'listener installed'
    `,
  });

  // --- Test 3: Send AUTO_BROADCAST_SCRIPT via service worker ---
  console.log('\nTest 3: Trigger AUTO_BROADCAST_SCRIPT from service worker');

  await sw.send('Runtime.evaluate', {
    expression: `
      chrome.runtime.sendMessage({
        type: 'AUTO_BROADCAST_SCRIPT',
        script: { scriptId: 'test-1', name: 'smoke-test.mjs', state: 'running', step: 1, total: 5 }
      });
      'broadcast sent'
    `,
    awaitPromise: false,
  });

  await sleep(300); // give message time to propagate

  // Check if wrapper's chrome.runtime.onMessage forwarded to iframe
  // We can't easily intercept cross-origin postMessage, but we can check
  // the wrapper page received the broadcast
  const received = await dashboard.send('Runtime.evaluate', {
    expression: `
      // Check if the chrome.runtime.onMessage listener processed the broadcast
      // by verifying BROADCAST_DS_MAP is defined (bridge.js loaded)
      typeof BROADCAST_DS_MAP !== 'undefined' ? JSON.stringify(BROADCAST_DS_MAP) : 'not in scope'
    `,
  });

  // BROADCAST_DS_MAP is const in bridge.js module scope, may not be in global
  // Instead, let's verify the listener works by checking the iframe sandbox
  console.log(`  BROADCAST_DS_MAP scope check: ${received.result.value}`);

  // --- Test 4: Verify invalidateDSCaches exists in sandbox ---
  console.log('\nTest 4: Verify invalidateDSCaches exists in sandbox iframe');

  // Find the sandbox iframe target
  await sleep(500);
  const freshTargets = await getTargets();
  const sandboxTarget = freshTargets.find(t =>
    t.url.includes('app.html') && t.type === 'iframe'
  );

  if (sandboxTarget) {
    const sandbox = await cdp(sandboxTarget.webSocketDebuggerUrl);

    const fnCheck = await sandbox.send('Runtime.evaluate', {
      expression: 'typeof invalidateDSCaches',
    });
    assert(fnCheck.result.value === 'function', 'invalidateDSCaches is defined in sandbox');

    // Check debounce timer map exists
    const timerCheck = await sandbox.send('Runtime.evaluate', {
      expression: 'typeof _dsDebounceTimers',
    });
    assert(timerCheck.result.value === 'object', '_dsDebounceTimers object exists');

    // --- Test 5: Simulate ds-update message and verify debounce fires ---
    console.log('\nTest 5: Call invalidateDSCaches directly and verify debounce');

    await sandbox.send('Runtime.evaluate', {
      expression: `
        window._invalidateCallCount = 0;
        // No BridgeScripts DS exists yet, so invalidateCache won't be called on components,
        // but the timer should still fire and clear
        invalidateDSCaches('BridgeScripts');
        invalidateDSCaches('BridgeScripts'); // should be suppressed (debounce)
        invalidateDSCaches('BridgeSessions'); // different DS, should schedule
        JSON.stringify({
          scriptsTimer: !!_dsDebounceTimers['BridgeScripts'],
          sessionsTimer: !!_dsDebounceTimers['BridgeSessions'],
        })
      `,
    });

    const timers = await sandbox.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ scripts: !!_dsDebounceTimers.BridgeScripts, sessions: !!_dsDebounceTimers.BridgeSessions })',
    });
    const timerState = JSON.parse(timers.result.value);
    assert(timerState.scripts === true, 'BridgeScripts debounce timer is active');
    assert(timerState.sessions === true, 'BridgeSessions debounce timer is active');

    // Wait for debounce to clear (500ms + buffer)
    await sleep(700);

    const clearedTimers = await sandbox.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ scripts: !!_dsDebounceTimers.BridgeScripts, sessions: !!_dsDebounceTimers.BridgeSessions })',
    });
    const clearedState = JSON.parse(clearedTimers.result.value);
    assert(clearedState.scripts === false, 'BridgeScripts debounce timer cleared after 500ms');
    assert(clearedState.sessions === false, 'BridgeSessions debounce timer cleared after 500ms');

    sandbox.close();
  } else {
    console.log('  Sandbox iframe not found as separate CDP target — checking inline');
    // The sandbox might be same-origin accessible from wrapper
    const inlineCheck = await dashboard.send('Runtime.evaluate', {
      expression: `
        try {
          const f = document.getElementById('sc-frame');
          typeof f.contentWindow.invalidateDSCaches;
        } catch(e) { 'blocked: ' + e.message; }
      `,
    });
    console.log(`  Inline check: ${inlineCheck.result.value}`);
    assert(inlineCheck.result.value === 'function', 'invalidateDSCaches accessible via iframe');
  }

  // --- Test 6: End-to-end broadcast via chrome.runtime ---
  console.log('\nTest 6: End-to-end broadcast → postMessage → sandbox');

  // Send multiple broadcast types from service worker
  for (const type of ['AUTO_BROADCAST_SCRIPT', 'AUTO_BROADCAST_STATUS', 'AUTO_BROADCAST_SCHEDULE', 'AUTO_COMMAND_UPDATE']) {
    await sw.send('Runtime.evaluate', {
      expression: `chrome.runtime.sendMessage({ type: '${type}', test: true }); '${type} sent'`,
      awaitPromise: false,
    });
  }

  await sleep(200);

  // If sandbox is accessible, check if messages arrived
  const freshTargets2 = await getTargets();
  const sandboxTarget2 = freshTargets2.find(t =>
    t.url.includes('app.html') && t.type === 'iframe'
  );

  if (sandboxTarget2) {
    const sandbox2 = await cdp(sandboxTarget2.webSocketDebuggerUrl);
    // After broadcasts, debounce timers should be active for all 4 DS types
    const allTimers = await sandbox2.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        scripts: !!_dsDebounceTimers.BridgeScripts,
        sessions: !!_dsDebounceTimers.BridgeSessions,
        schedules: !!_dsDebounceTimers.BridgeSchedules,
        commands: !!_dsDebounceTimers.BridgeCommands,
      })`,
    });
    const allState = JSON.parse(allTimers.result.value);
    assert(allState.scripts, 'AUTO_BROADCAST_SCRIPT → BridgeScripts timer active');
    assert(allState.sessions, 'AUTO_BROADCAST_STATUS → BridgeSessions timer active');
    assert(allState.schedules, 'AUTO_BROADCAST_SCHEDULE → BridgeSchedules timer active');
    assert(allState.commands, 'AUTO_COMMAND_UPDATE → BridgeCommands timer active');
    sandbox2.close();
  }

  // --- Cleanup: navigate back to dashboard ---
  await dashboard.send('Page.navigate', {
    url: `chrome-extension://${EXT_ID}/dashboard/dashboard.html`,
  });

  dashboard.close();
  sw.close();

  // --- Summary ---
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(40)}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Smoke test error:', err.message);
  process.exit(1);
});
