#!/usr/bin/env node
/**
 * Internal ops test suite — verifies all host capabilities, runtimes,
 * plugin system, and bridge integration.
 *
 * Run from the bridge dashboard or CLI:
 *   node examples/test-internal-ops.mjs
 *   bcli script:launch '{"path":"examples/test-internal-ops.mjs"}'
 *
 * Requires: bridge server running, extension loaded + enabled, asset-server running.
 */

import { ScriptClient } from '../packages/bridge/script-client.mjs';
import http from 'http';

const client = new ScriptClient('internal-ops-test', { totalSteps: 8 });

// ---- Helpers ----

function httpGet(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej);
  });
}

async function swEval(expr) {
  // Find the service worker via CDP and evaluate
  const targets = JSON.parse(await httpGet('http://localhost:9222/json'));
  const sw = targets.find(t => t.type === 'service_worker');
  if (!sw) throw new Error('No service worker found — is the extension loaded?');

  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(sw.webSocketDebuggerUrl);
  await new Promise(r => ws.once('open', r));

  const result = await new Promise((resolve, reject) => {
    const id = 1;
    const handler = raw => {
      const m = JSON.parse(raw.toString());
      if (m.id === id) { ws.off('message', handler); resolve(m); }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true },
    }));
    setTimeout(() => reject(new Error('swEval timeout')), 30000);
  });

  ws.close();
  if (result.result?.exceptionDetails) {
    throw new Error(result.result.exceptionDetails.exception?.description || result.result.exceptionDetails.text);
  }
  return result.result?.result?.value;
}

// ---- Tests ----

try {
  await client.connect();
  console.log('Internal Ops Test Suite');
  console.log('======================\n');

  // 1. Bridge connectivity
  await client.progress(1, 8, 'Bridge connectivity');
  client.assert(client.scriptId != null, 'Bridge: ScriptClient connected');

  // 2. Extension service worker
  await client.progress(2, 8, 'Extension service worker');
  const handlersExist = await swEval('typeof globalThis.__handlers === "object"');
  client.assert(handlersExist === true, 'SW: __handlers object exists');

  const handlerCount = await swEval('Object.keys(globalThis.__handlers).length');
  client.assert(handlerCount > 30, 'SW: 30+ handlers registered (got ' + handlerCount + ')');

  // 3. Plugin system
  await client.progress(3, 8, 'Plugin system');
  const plugins = await swEval("(async () => (await globalThis.__handlers['PLUGIN_LIST']({})).map(p => p.id))()");
  client.assert(Array.isArray(plugins), 'Plugins: PLUGIN_LIST returns array');
  client.assert(plugins.includes('hello-runtime'), 'Plugins: hello-runtime registered');
  client.assert(plugins.length >= 2, 'Plugins: at least 2 plugins (got ' + plugins.length + ')');

  // 4. host.storage
  await client.progress(4, 8, 'host.storage');
  const storageSet = await swEval("(async () => await globalThis.__handlers['HOST_STORAGE_SET']({ key: '__test__', value: { n: 42 } }))()");
  client.assert(storageSet?.success === true, 'Storage: set succeeded');

  const storageGet = await swEval("(async () => await globalThis.__handlers['HOST_STORAGE_GET']({ key: '__test__' }))()");
  client.assert(storageGet?.value?.n === 42, 'Storage: get round-trip (n=' + storageGet?.value?.n + ')');

  await swEval("(async () => await globalThis.__handlers['HOST_STORAGE_DEL']({ key: '__test__' }))()");

  // 5. host.network
  await client.progress(5, 8, 'host.network');
  const netFetch = await swEval("(async () => { var r = await globalThis.__handlers['HOST_NETWORK_FETCH']({ url: 'http://localhost:9877/hello-main.jar', as: 'text' }); return { ok: r.ok, status: r.status }; })()");
  client.assert(netFetch?.ok === true, 'Network: fetch asset-server (status ' + netFetch?.status + ')');

  // 6. host.identity
  await client.progress(6, 8, 'host.identity');
  const identity = await swEval("(async () => await globalThis.__handlers['HOST_IDENTITY_GET']())()");
  client.assert(identity?.extensionId != null, 'Identity: extensionId exists');
  client.assert(identity?.installId?.length > 10, 'Identity: installId is non-trivial');

  // 7. CheerpJ runtime
  await client.progress(7, 8, 'CheerpJ runtime');
  const cjPing = await swEval("(async () => await globalThis.__handlers['cheerpj-ping']({}))()");
  client.assert(cjPing?.success === true, 'CheerpJ: ping succeeded');

  const cjRun = await swEval("(async () => { var r = await globalThis.__handlers['cheerpj-runMain']({ jarUrl: 'http://localhost:9877/hello-main.jar', className: 'com.agentidev.Hello', args: ['test'] }); return { exit: r.exitCode, hasStdout: r.stdout && r.stdout.length > 0 }; })()");
  client.assert(cjRun?.exit === 0, 'CheerpJ: runMain exit code 0');
  client.assert(cjRun?.hasStdout === true, 'CheerpJ: runMain produced stdout');

  // 8. CheerpX runtime
  await client.progress(8, 8, 'CheerpX runtime');
  const cxPing = await swEval("(async () => await globalThis.__handlers['cheerpx-ping']({}))()");
  client.assert(cxPing?.success === true, 'CheerpX: ping succeeded');
  client.assert(cxPing?.crossOriginIsolated === true, 'CheerpX: cross-origin isolated');

  const cxSpawn = await swEval("(async () => { var r = await globalThis.__handlers['HOST_EXEC_SPAWN']({ cmd: '/bin/echo', args: ['hello'] }); return { exit: r.exitCode, stdout: (r.stdout || '').trim() }; })()");
  client.assert(cxSpawn?.exit === 0, 'CheerpX: echo exit code 0');
  client.assert(cxSpawn?.stdout === 'hello', 'CheerpX: echo stdout = "hello" (got "' + cxSpawn?.stdout + '")');

  // Done
  console.log('');
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
