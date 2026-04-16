#!/usr/bin/env node
/**
 * Timed test: install pip in the CheerpX VM via apt-get.
 *
 * Run from the SC Dashboard or: node examples/test-cheerpx-pip-install.mjs
 *
 * This writes to the IDBDevice overlay — once it succeeds, pip stays
 * installed for the rest of this browser's lifetime (until IndexedDB
 * is cleared or the overlay name changes).
 */

import { ScriptClient } from '../packages/bridge/script-client.mjs';
import http from 'http';
import WebSocket from 'ws';

const client = new ScriptClient('cheerpx-pip-install', { totalSteps: 4 });

async function swEval(expr, timeout = 300000) {
  const targets = await new Promise((res, rej) => {
    http.get('http://localhost:9222/json', r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
  const sw = targets.find(t => t.type === 'service_worker');
  if (!sw) throw new Error('No service worker found');

  const ws = new WebSocket(sw.webSocketDebuggerUrl);
  await new Promise(r => ws.once('open', r));
  const result = await new Promise((resolve, reject) => {
    const id = 1;
    const timer = setTimeout(() => reject(new Error('swEval timeout')), timeout);
    const handler = raw => {
      const m = JSON.parse(raw.toString());
      if (m.id === id) { ws.off('message', handler); clearTimeout(timer); resolve(m); }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true },
    }));
  });
  ws.close();
  if (result.result?.exceptionDetails) {
    throw new Error(result.result.exceptionDetails.exception?.description || 'eval error');
  }
  return result.result?.result?.value;
}

try {
  await client.connect();
  console.log('CheerpX pip install test\n');

  // 1. Check current state
  await client.progress(1, 4, 'Check if pip is already installed');
  const precheck = await swEval(`
    (async () => {
      const r = await globalThis.__handlers['HOST_EXEC_SPAWN']({
        cmd: '/bin/sh', args: ['-c', 'which pip3 2>/dev/null || echo NOT_INSTALLED']
      });
      return { exit: r.exitCode, stdout: (r.stdout || '').trim() };
    })()
  `, 30000);
  console.log('  Current pip3:', precheck.stdout);
  const alreadyInstalled = precheck.stdout.includes('/') && precheck.exit === 0;
  client.assert(true, 'Pre-check complete: ' + (alreadyInstalled ? 'already installed' : 'not installed'));

  if (alreadyInstalled) {
    console.log('\npip3 is already installed, skipping install.');
  } else {
    // 2. apt-get update
    await client.progress(2, 4, 'Running apt-get update');
    console.log('\n  Running: apt-get update (this may take 30-60s)');
    const t1 = Date.now();
    const update = await swEval(`
      (async () => {
        const r = await globalThis.__handlers['HOST_EXEC_SPAWN']({
          cmd: '/usr/bin/apt-get', args: ['update']
        });
        return { exit: r.exitCode, stdout: (r.stdout || '').slice(-500), stderr: (r.stderr || '').slice(-500) };
      })()
    `, 180000);
    const updateDur = ((Date.now() - t1) / 1000).toFixed(1);
    console.log('  apt-get update: exit=' + update.exit + ' (' + updateDur + 's)');
    if (update.stderr) console.log('  stderr tail:', update.stderr);
    client.assert(update.exit === 0, 'apt-get update completed');

    // 3. apt-get install python3-pip
    await client.progress(3, 4, 'Running apt-get install -y python3-pip');
    console.log('\n  Running: apt-get install -y python3-pip (this may take 2-5 minutes)');
    const t2 = Date.now();
    const install = await swEval(`
      (async () => {
        const r = await globalThis.__handlers['HOST_EXEC_SPAWN']({
          cmd: '/usr/bin/apt-get', args: ['install', '-y', 'python3-pip']
        });
        return { exit: r.exitCode, stdout: (r.stdout || '').slice(-500), stderr: (r.stderr || '').slice(-500) };
      })()
    `, 600000);
    const installDur = ((Date.now() - t2) / 1000).toFixed(1);
    console.log('  apt-get install: exit=' + install.exit + ' (' + installDur + 's)');
    if (install.stderr) console.log('  stderr tail:', install.stderr);
    client.assert(install.exit === 0, 'apt-get install python3-pip completed');
  }

  // 4. Verify
  await client.progress(4, 4, 'Verify pip3 works');
  const verify = await swEval(`
    (async () => {
      const r = await globalThis.__handlers['HOST_EXEC_SPAWN']({
        cmd: '/bin/sh', args: ['-c', 'pip3 --version']
      });
      return { exit: r.exitCode, stdout: (r.stdout || '').trim() };
    })()
  `, 30000);
  console.log('\n  pip3 --version: ' + verify.stdout);
  client.assert(verify.exit === 0, 'pip3 runs successfully');
  client.assert(verify.stdout.includes('pip'), 'pip3 reports version');

  console.log('\nResult: pip3 is now available for the CheerpX VM.');
  console.log('Persisted in IndexedDB: agentidev-cheerpx-overlay-v1');

  const exitCode = client.summarize();
  await client.complete({ assertions: client.getAssertionSummary() });
  process.exit(exitCode);
} catch (err) {
  console.error('\nFatal:', err.message);
  client.assert(false, 'Fatal: ' + err.message);
  client.summarize();
  await client.complete({ assertions: client.getAssertionSummary() });
  process.exit(1);
}
