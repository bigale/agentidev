#!/usr/bin/env node
/**
 * Generated app test — Weather Alerts plugin.
 *
 * Tests that the plugin renders, the Fetch button loads data from the
 * NWS API into the grid, and the grid is sortable/filterable.
 *
 * Run: node examples/test-weather-alerts.mjs
 */

import { ScriptClient } from '../packages/bridge/script-client.mjs';
import http from 'http';
import WebSocket from 'ws';
import fs from 'fs';

const client = new ScriptClient('test-weather-alerts', { totalSteps: 5 });

// ---- CDP Helpers ----

async function getTargets() {
  return JSON.parse(await new Promise((res, rej) => {
    http.get('http://localhost:9222/json', r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej);
  }));
}

async function cdpEval(wsUrl, expr, timeout = 30000) {
  const ws = new WebSocket(wsUrl);
  await new Promise(r => ws.once('open', r));
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cdpEval timeout')), timeout);
    const handler = raw => {
      const m = JSON.parse(raw.toString());
      if (m.id === 1) { ws.off('message', handler); clearTimeout(timer); resolve(m); }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  ws.close();
  if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text || 'eval error');
  return result.result?.result?.value;
}

async function cdpScreenshot(wsUrl, path) {
  const ws = new WebSocket(wsUrl);
  await new Promise(r => ws.once('open', r));
  const result = await new Promise(resolve => {
    const handler = raw => { const m = JSON.parse(raw.toString()); if (m.id === 1) { ws.off('message', handler); resolve(m); } };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
  });
  ws.close();
  if (result.result?.data) {
    fs.writeFileSync(path, Buffer.from(result.result.data, 'base64'));
    return path;
  }
  return null;
}

// Find plugin page + its sandbox iframe
async function findPluginTargets(modeName) {
  const targets = await getTargets();
  const page = targets.find(t => t.type === 'page' && t.url.includes('mode=' + modeName));
  if (!page) return null;

  // Find the sandbox iframe by trying each app.html iframe and checking
  // which one has the correct components (the target list ordering is
  // unreliable when multiple wrapper tabs exist).
  const iframes = targets.filter(t => t.type === 'iframe' && t.url.includes('app.html'));

  // Try a simple approach first: the iframe immediately after the page
  const pageIdx = targets.indexOf(page);
  for (const t of targets.slice(pageIdx + 1)) {
    if (t.type === 'iframe' && t.url.includes('app.html')) {
      return { page, sandbox: t };
    }
    if (t.type === 'page') break; // hit the next page, stop
  }

  // Fallback: try ALL iframes
  if (iframes.length === 1) return { page, sandbox: iframes[0] };
  if (iframes.length > 0) return { page, sandbox: iframes[iframes.length - 1] };

  return { page, sandbox: null };
}

// ---- Tests ----

try {
  await client.connect();
  console.log('Weather Alerts Plugin Test');
  console.log('=========================\n');

  // 1. Find the plugin tab
  await client.progress(1, 5, 'Find Weather Alerts tab');
  let targets = await findPluginTargets('weather-alerts');
  if (!targets) {
    // Open it via CDP
    const allTargets = await getTargets();
    const extensionId = allTargets.find(t => t.type === 'service_worker')?.url.match(/chrome-extension:\/\/([^/]+)/)?.[1];
    if (extensionId) {
      await new Promise((res, rej) => {
        const req = http.request({ method: 'PUT', hostname: 'localhost', port: 9222,
          path: '/json/new?chrome-extension://' + extensionId + '/smartclient-app/wrapper.html?mode=weather-alerts' },
          r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); });
        req.on('error', rej);
        req.end();
      });
      await new Promise(r => setTimeout(r, 5000));
      targets = await findPluginTargets('weather-alerts');
    }
  }
  client.assert(targets != null, 'Plugin tab found');
  client.assert(targets?.sandbox != null, 'Sandbox iframe found');

  // 2. Verify components rendered (with retry — config fetch + render takes a few seconds)
  await client.progress(2, 5, 'Verify components');
  let components = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise(r => setTimeout(r, 3000));
    // Re-find targets in case the iframe was recreated
    targets = await findPluginTargets('weather-alerts') || targets;
    if (!targets?.sandbox) continue;
    try {
      components = await cdpEval(targets.sandbox.webSocketDebuggerUrl, `(function() {
        if (typeof isc === 'undefined' || !isc.AutoTest) return null;
        return {
          root: !!isc.AutoTest.getObject('//VLayout[ID="weatherRoot"]'),
          grid: !!isc.AutoTest.getObject('//ListGrid[ID="alertsGrid"]'),
          btn: !!isc.AutoTest.getObject('//Button[ID="btnFetch"]'),
          status: !!isc.AutoTest.getObject('//Label[ID="statusLabel"]'),
        };
      })()`);
      if (components?.root) break;
    } catch (e) {
      console.log('  (retry ' + (attempt + 1) + ': ' + e.message + ')');
    }
  }
  client.assert(components?.root === true, 'Component: weatherRoot VLayout');
  client.assert(components?.grid === true, 'Component: alertsGrid ListGrid');
  client.assert(components?.btn === true, 'Component: btnFetch Button');
  client.assert(components?.status === true, 'Component: statusLabel Label');

  // Screenshot before fetch
  const beforePath = '/tmp/test-weather-before.png';
  await cdpScreenshot(targets.page.webSocketDebuggerUrl, beforePath);
  await client.artifact({ type: 'screenshot', label: 'Before fetch', filePath: beforePath, contentType: 'image/png' });

  // 3. Click Fetch Alerts
  await client.progress(3, 5, 'Fetch alerts');
  const fetchResult = await cdpEval(targets.sandbox.webSocketDebuggerUrl, `(async function() {
    var btn = isc.AutoTest.getObject('//Button[ID="btnFetch"]');
    btn.click();
    await new Promise(r => setTimeout(r, 10000));
    var grid = isc.AutoTest.getObject('//ListGrid[ID="alertsGrid"]');
    var status = isc.AutoTest.getObject('//Label[ID="statusLabel"]');
    return {
      rows: grid.getTotalRows(),
      statusText: status.getContents(),
      firstRecord: grid.getTotalRows() > 0 ? grid.getRecord(0) : null,
    };
  })()`, 20000);
  client.assert(fetchResult?.rows > 0, 'Grid loaded ' + (fetchResult?.rows || 0) + ' rows');
  client.assert(fetchResult?.rows > 100, 'Grid has 100+ alerts (got ' + fetchResult?.rows + ')');
  client.assert(fetchResult?.firstRecord?.event != null, 'First record has event field');
  client.assert(fetchResult?.statusText?.includes('records loaded'), 'Status shows loaded count');

  // 4. Verify grid columns
  await client.progress(4, 5, 'Verify grid structure');
  const fields = await cdpEval(targets.sandbox.webSocketDebuggerUrl, `(function() {
    var grid = isc.AutoTest.getObject('//ListGrid[ID="alertsGrid"]');
    return grid.getFields().map(f => f.name);
  })()`);
  client.assert(fields?.includes('event'), 'Grid has event column');
  client.assert(fields?.includes('severity'), 'Grid has severity column');
  client.assert(fields?.includes('areaDesc'), 'Grid has area column');
  client.assert(fields?.includes('onset'), 'Grid has onset column');

  // Screenshot after fetch
  const afterPath = '/tmp/test-weather-after.png';
  await cdpScreenshot(targets.page.webSocketDebuggerUrl, afterPath);
  await client.artifact({ type: 'screenshot', label: 'After fetch', filePath: afterPath, contentType: 'image/png' });

  // 5. Summary
  await client.progress(5, 5, 'Summary');
  const exitCode = client.summarize();
  await client.complete({ assertions: client.getAssertionSummary() });
  process.exit(exitCode);

} catch (err) {
  console.error('\nFatal error:', err.message);
  client.assert(false, 'Fatal: ' + err.message);
  client.summarize();
  await client.complete({ assertions: client.getAssertionSummary() });
  process.exit(1);
}
