#!/usr/bin/env node
/**
 * CSV Analyzer plugin test.
 *
 * Opens the csv-analyzer plugin in the extension browser, verifies
 * SmartClient components rendered, loads a CSV via the Load button,
 * checks the summary grid populated, runs Describe Columns, and
 * executes a query.
 *
 * Uses CDP (port 9222) to interact with the sandbox iframe where
 * SmartClient runs. Bridge ScriptClient reports progress + assertions
 * to the dashboard.
 *
 * Run:  node examples/test-csv-analyzer.mjs
 * From dashboard:  register as script, click Run (no session needed)
 */

import { ScriptClient } from '../packages/bridge/script-client.mjs';
import http from 'http';
import WebSocket from 'ws';
import fs from 'fs';

const CDP_PORT = 9222;
const PLUGIN_MODE = 'csv-analyzer';
const TOTAL_STEPS = 6;

const client = new ScriptClient('test-csv-analyzer', { totalSteps: TOTAL_STEPS });

// ---- CDP Helpers ----

async function getTargets() {
  return JSON.parse(await new Promise((res, rej) => {
    http.get(`http://localhost:${CDP_PORT}/json`, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(d));
    }).on('error', rej);
  }));
}

async function cdpEval(wsUrl, expr, timeout = 15000) {
  const ws = new WebSocket(wsUrl);
  await new Promise(r => ws.once('open', r));
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cdpEval timeout')), timeout);
    const handler = raw => {
      const m = JSON.parse(raw.toString());
      if (m.id === 1) { ws.off('message', handler); clearTimeout(timer); resolve(m); }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true },
    }));
  });
  ws.close();
  if (result.result?.exceptionDetails) {
    throw new Error(result.result.exceptionDetails.exception?.description || result.result.exceptionDetails.text || 'eval error');
  }
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

async function findPluginTargets(modeName) {
  const targets = await getTargets();
  const page = targets.find(t => t.type === 'page' && t.url.includes('mode=' + modeName));
  if (!page) return null;
  // Find the sandbox iframe near this page target
  const pageIdx = targets.indexOf(page);
  for (const t of targets.slice(pageIdx + 1)) {
    if (t.type === 'iframe' && t.url.includes('app.html')) return { page, sandbox: t };
    if (t.type === 'page') break;
  }
  const iframes = targets.filter(t => t.type === 'iframe' && t.url.includes('app.html'));
  if (iframes.length === 1) return { page, sandbox: iframes[0] };
  if (iframes.length > 0) return { page, sandbox: iframes[iframes.length - 1] };
  return { page, sandbox: null };
}

async function getExtensionId() {
  const targets = await getTargets();
  const sw = targets.find(t => t.type === 'service_worker' && t.url.includes('chrome-extension://'));
  return sw?.url.match(/chrome-extension:\/\/([^/]+)/)?.[1];
}

// ---- Test ----

try {
  await client.connect();
  console.log('CSV Analyzer Plugin Test');
  console.log('========================\n');

  // Step 1: Open the plugin tab
  await client.progress(1, TOTAL_STEPS, 'Open CSV Analyzer tab');
  let targets = await findPluginTargets(PLUGIN_MODE);
  if (!targets) {
    const extId = await getExtensionId();
    client.assert(extId != null, 'Extension detected');
    if (extId) {
      const url = `chrome-extension://${extId}/smartclient-app/wrapper.html?mode=${PLUGIN_MODE}`;
      console.log('  Opening:', url);
      await new Promise((res, rej) => {
        const req = http.request({
          method: 'PUT', hostname: 'localhost', port: CDP_PORT,
          path: '/json/new?' + encodeURI(url),
        }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); });
        req.on('error', rej);
        req.end();
      });
      await new Promise(r => setTimeout(r, 5000));
      targets = await findPluginTargets(PLUGIN_MODE);
    }
  }
  client.assert(targets != null, 'Plugin tab found');
  client.assert(targets?.sandbox != null, 'Sandbox iframe found');
  if (!targets?.sandbox) throw new Error('Cannot find sandbox iframe — aborting');
  console.log('  Tab:', targets.page.title);

  // Step 2: Verify SmartClient components rendered
  await client.progress(2, TOTAL_STEPS, 'Verify components');
  let components = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise(r => setTimeout(r, 2000));
    targets = await findPluginTargets(PLUGIN_MODE) || targets;
    if (!targets?.sandbox) continue;
    try {
      components = await cdpEval(targets.sandbox.webSocketDebuggerUrl, `(function() {
        if (typeof isc === 'undefined' || !isc.AutoTest) return null;
        return {
          loadForm: !!isc.AutoTest.getObject('//DynamicForm[ID="loadForm"]'),
          btnLoad: !!isc.AutoTest.getObject('//Button[ID="btnLoad"]'),
          btnDescribe: !!isc.AutoTest.getObject('//Button[ID="btnDescribe"]'),
          summaryGrid: !!isc.AutoTest.getObject('//ListGrid[ID="summaryGrid"]'),
          statsGrid: !!isc.AutoTest.getObject('//ListGrid[ID="statsGrid"]'),
          queryForm: !!isc.AutoTest.getObject('//DynamicForm[ID="queryForm"]'),
          resultsGrid: !!isc.AutoTest.getObject('//ListGrid[ID="resultsGrid"]'),
        };
      })()`);
      if (components?.loadForm) break;
    } catch (e) {
      console.log('  (retry ' + (attempt + 1) + ': ' + e.message + ')');
    }
  }
  client.assert(components?.loadForm === true, 'loadForm rendered');
  client.assert(components?.btnLoad === true, 'btnLoad rendered');
  client.assert(components?.btnDescribe === true, 'btnDescribe rendered');
  client.assert(components?.summaryGrid === true, 'summaryGrid rendered');
  client.assert(components?.statsGrid === true, 'statsGrid rendered');
  client.assert(components?.queryForm === true, 'queryForm rendered');
  client.assert(components?.resultsGrid === true, 'resultsGrid rendered');
  console.log('  All 7 components verified');

  // Screenshot: initial state
  const initPath = '/tmp/test-csv-init.png';
  await cdpScreenshot(targets.page.webSocketDebuggerUrl, initPath);
  await client.artifact({ type: 'screenshot', label: 'Initial state', filePath: initPath, contentType: 'image/png' });

  // Step 3: Load a CSV — use a small inline CSV via data: URL
  // (avoids dependency on external servers or sample files)
  await client.progress(3, TOTAL_STEPS, 'Load CSV');
  const csvData = `Name,Age,City,Score
Alice,28,London,92
Bob,35,Paris,87
Charlie,42,Tokyo,95
Diana,31,Berlin,88
Eve,26,Sydney,91
Frank,39,Dublin,78
Grace,33,Oslo,96
Harry,45,Rome,82`;

  const loadResult = await cdpEval(targets.sandbox.webSocketDebuggerUrl, `(async function() {
    // Set a data: URL with CSV content
    var form = isc.AutoTest.getObject('//DynamicForm[ID="loadForm"]');
    form.setValue('url', 'data:text/csv;base64,${Buffer.from(csvData).toString('base64')}');
    var btn = isc.AutoTest.getObject('//Button[ID="btnLoad"]');
    btn.click();
    // Wait for handler response
    await new Promise(r => setTimeout(r, 5000));
    var grid = isc.AutoTest.getObject('//ListGrid[ID="summaryGrid"]');
    var status = isc.AutoTest.getObject('//HTMLFlow[ID="loadStatus"]');
    return {
      rows: grid ? grid.getTotalRows() : -1,
      statusHtml: status ? status.getContents() : '',
    };
  })()`, 15000);

  const csvLoaded = loadResult?.rows > 0 || loadResult?.statusHtml?.includes('records loaded');
  client.assert(csvLoaded, 'CSV loaded into summaryGrid (' + (loadResult?.rows || 0) + ' rows, status: ' + (loadResult?.statusHtml || '').replace(/<[^>]*>/g, '').substring(0, 60) + ')');
  console.log('  Summary grid rows:', loadResult?.rows);
  console.log('  Status:', (loadResult?.statusHtml || '').replace(/<[^>]*>/g, ''));

  // Step 4: Describe Columns
  await client.progress(4, TOTAL_STEPS, 'Describe columns');
  const describeResult = await cdpEval(targets.sandbox.webSocketDebuggerUrl, `(async function() {
    var btn = isc.AutoTest.getObject('//Button[ID="btnDescribe"]');
    btn.click();
    await new Promise(r => setTimeout(r, 5000));
    var grid = isc.AutoTest.getObject('//ListGrid[ID="statsGrid"]');
    var rows = grid ? grid.getTotalRows() : -1;
    var firstRecord = (rows > 0) ? grid.getRecord(0) : null;
    var fields = grid ? grid.getFields().map(function(f) { return f.name; }) : [];
    return { rows: rows, firstRecord: firstRecord, fields: fields };
  })()`, 15000);

  client.assert(describeResult?.rows > 0, 'Stats grid has ' + (describeResult?.rows || 0) + ' rows (column descriptions)');
  if (describeResult?.rows > 0) {
    client.assert(describeResult.firstRecord?.column != null, 'Stats record has column name');
    client.assert(describeResult.firstRecord?.type != null, 'Stats record has type');
    console.log('  Column stats:', describeResult.rows, 'columns described');
    console.log('  First column:', JSON.stringify(describeResult.firstRecord));
    console.log('  Fields:', describeResult.fields?.join(', '));
  }

  // Screenshot: after load + describe
  const loadedPath = '/tmp/test-csv-loaded.png';
  await cdpScreenshot(targets.page.webSocketDebuggerUrl, loadedPath);
  await client.artifact({ type: 'screenshot', label: 'After load + describe', filePath: loadedPath, contentType: 'image/png' });

  // Step 5: Run a query
  await client.progress(5, TOTAL_STEPS, 'Run query');
  const queryResult = await cdpEval(targets.sandbox.webSocketDebuggerUrl, `(async function() {
    var form = isc.AutoTest.getObject('//DynamicForm[ID="queryForm"]');
    form.setValue('sort', 'Score desc');
    form.setValue('limit', 5);
    var btn = isc.AutoTest.getObject('//Button[ID="btnQuery"]');
    if (!btn) {
      // btnQuery might be directly in the layout, not in queryForm
      var canvases = isc.Canvas._canvasList || [];
      for (var i = 0; i < canvases.length; i++) {
        if (canvases[i].ID === 'btnQuery' || (canvases[i].title && canvases[i].title.includes('Query'))) {
          btn = canvases[i]; break;
        }
      }
    }
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 5000));
    var grid = isc.AutoTest.getObject('//ListGrid[ID="resultsGrid"]');
    var rows = grid ? grid.getTotalRows() : -1;
    var firstRecord = (rows > 0) ? grid.getRecord(0) : null;
    var fields = grid ? grid.getFields().map(function(f) { return f.name; }) : [];
    var statusEl = isc.AutoTest.getObject('//HTMLFlow[ID="queryStatus"]');
    return { rows: rows, firstRecord: firstRecord, fields: fields, status: statusEl ? statusEl.getContents() : '' };
  })()`, 15000);

  client.assert(queryResult?.rows > 0, 'Query returned ' + (queryResult?.rows || 0) + ' rows');
  if (queryResult?.rows > 0) {
    client.assert(queryResult.fields?.length > 0, 'Results grid has ' + (queryResult.fields?.length || 0) + ' columns');
    console.log('  Query results:', queryResult.rows, 'rows');
    console.log('  First record:', JSON.stringify(queryResult.firstRecord));
    console.log('  Columns:', queryResult.fields?.join(', '));
    console.log('  Status:', (queryResult.status || '').replace(/<[^>]*>/g, ''));
  }

  // Screenshot: after query
  const queryPath = '/tmp/test-csv-query.png';
  await cdpScreenshot(targets.page.webSocketDebuggerUrl, queryPath);
  await client.artifact({ type: 'screenshot', label: 'After query', filePath: queryPath, contentType: 'image/png' });

  // Step 6: Summary
  await client.progress(6, TOTAL_STEPS, 'Complete');
  console.log('\n');
  const exitCode = client.summarize();

  // Close the test tab
  try {
    const tabTargets = await getTargets();
    const pluginPage = tabTargets.find(t => t.type === 'page' && t.url.includes('mode=' + PLUGIN_MODE));
    if (pluginPage) {
      const ws = new WebSocket(pluginPage.webSocketDebuggerUrl);
      await new Promise(r => ws.once('open', r));
      ws.send(JSON.stringify({ id: 99, method: 'Page.close' }));
      await new Promise(r => setTimeout(r, 500));
      ws.close();
    }
  } catch (_) {}

  await client.complete({ assertions: client.getAssertionSummary() });
  process.exit(exitCode);

} catch (err) {
  console.error('\nFatal error:', err.message);
  client.assert(false, 'Fatal: ' + err.message);
  client.summarize();
  await client.complete({ assertions: client.getAssertionSummary() }).catch(() => {});
  process.exit(1);
}
