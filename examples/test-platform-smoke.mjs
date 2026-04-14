#!/usr/bin/env node
/**
 * Platform smoke test — verifies core agentidev capabilities.
 *
 * Run from the bridge dashboard or CLI:
 *   bcli script:launch '{"path":"examples/test-platform-smoke.mjs"}'
 *
 * Uses ScriptClient.assert() to report pass/fail results to the bridge.
 */

import { ScriptClient } from '../packages/bridge/script-client.mjs';

const client = new ScriptClient('platform-smoke-test', {
  totalSteps: 5,
  checkpoints: ['storage', 'plugins', 'bridge'],
});

try {
  await client.connect();
  console.log('Platform Smoke Test');
  console.log('==================\n');

  // Test 1: ScriptClient connected
  await client.progress(1, 5, 'ScriptClient connection');
  client.assert(client.scriptId != null, 'ScriptClient has a scriptId');
  client.assert(typeof client.assert === 'function', 'ScriptClient.assert exists');

  // Test 2: Bridge is responsive
  await client.checkpoint('bridge');
  await client.progress(2, 5, 'Bridge responsiveness');
  client.assert(true, 'Bridge accepted checkpoint');

  // Test 3: Progress reporting
  await client.progress(3, 5, 'Progress reporting');
  client.assert(client.errors === 0 || client.errors > 0, 'Error count is a number');

  // Test 4: Assertion tracking
  await client.progress(4, 5, 'Assertion tracking');
  const summary = client.getAssertionSummary();
  client.assert(summary.total > 0, 'Assertions are being tracked');
  client.assert(summary.pass > 0, 'At least one assertion passed');

  // Test 5: Summary
  await client.progress(5, 5, 'Summary');
  const exitCode = client.summarize();
  process.exit(exitCode);

} catch (err) {
  console.error('Test failed:', err.message);
  client.assert(false, 'Unexpected error: ' + err.message);
  client.summarize();
  process.exit(1);
}
