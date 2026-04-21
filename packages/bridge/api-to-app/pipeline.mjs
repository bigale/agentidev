#!/usr/bin/env node
/**
 * api-to-app Pipeline — orchestrates the full flow:
 *   OpenAPI spec → PICT model → combinatorial rows → test script
 *
 * Runs as a bridge script with progress reporting to the dashboard.
 *
 * Usage:
 *   node packages/bridge/api-to-app/pipeline.mjs [options]
 *
 * Options:
 *   --spec=<path>       Path to OpenAPI spec (default: specs/petstore-v3.json)
 *   --endpoint=<op>     Operation ID or "METHOD /path" (default: findPetsByStatus)
 *   --base-url=<url>    API base URL (default: https://petstore3.swagger.io/api/v3)
 *   --output=<path>     Output test script path (default: auto-generated)
 *   --order=<n>         PICT combinatorial order (default: 2 = pairwise)
 *   --seed=<n>          PICT random seed for reproducibility
 *   --run               Also launch the generated test after creating it
 *   --dry-run           Print PICT model and rows but don't generate test script
 */

import { ScriptClient } from '../script-client.mjs';
import { loadSpec, extractEndpoints, generatePictModel } from './spec-analyzer.mjs';
import { runAndParse, isPictAvailable } from './pict-runner.mjs';
import { generateTestScript } from './test-generator.mjs';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOTAL_STEPS = 5;

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const found = args.find(a => a.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : def;
};
const hasFlag = (name) => args.includes(`--${name}`);

const specPath = getArg('spec', resolve(__dirname, 'specs/petstore-v3.json'));
const targetEndpoint = getArg('endpoint', 'findPetsByStatus');
const baseUrl = getArg('base-url', 'https://petstore3.swagger.io/api/v3');
const order = parseInt(getArg('order', '2'), 10);
const seed = getArg('seed', undefined);
const dryRun = hasFlag('dry-run');
const runAfter = hasFlag('run');

const client = new ScriptClient('api-to-app-pipeline', { totalSteps: TOTAL_STEPS });

try {
  await client.connect();
  console.log('api-to-app Pipeline');
  console.log('===================\n');

  // Step 1: Check prerequisites
  await client.progress(1, TOTAL_STEPS, 'Check prerequisites');
  if (!isPictAvailable()) {
    throw new Error('PICT binary not found. Install from https://github.com/microsoft/pict');
  }
  console.log('  PICT: available');

  // Step 2: Load and analyze spec
  await client.progress(2, TOTAL_STEPS, 'Analyze OpenAPI spec');
  console.log('  Spec:', specPath);
  const spec = loadSpec(specPath);
  console.log('  Title:', spec.info?.title, 'v' + spec.info?.version);

  const endpoints = extractEndpoints(spec);
  console.log('  Endpoints:', endpoints.length);

  // Find target endpoint by operationId or method+path
  const target = endpoints.find(ep =>
    ep.operationId === targetEndpoint ||
    `${ep.method} ${ep.path}` === targetEndpoint
  );
  if (!target) {
    const available = endpoints.map(ep => ep.operationId || `${ep.method} ${ep.path}`).join(', ');
    throw new Error(`Endpoint "${targetEndpoint}" not found. Available: ${available}`);
  }
  console.log('  Target:', target.method, target.path, `(${target.operationId})`);
  console.log('  Parameters:', target.parameters.length);

  // Step 3: Generate PICT model and run
  await client.progress(3, TOTAL_STEPS, 'Generate PICT model');
  const analysis = generatePictModel(target, spec);
  console.log('\n--- PICT Model ---');
  console.log(analysis.model);
  console.log('--- End Model ---\n');

  // Save model as artifact
  await client.artifact({
    type: 'text',
    label: 'PICT Model',
    content: analysis.model,
    contentType: 'text/plain',
  });

  // Run PICT
  const pictOptions = { order, caseSensitive: true };
  if (seed) pictOptions.seed = parseInt(seed, 10);

  const { headers, rows } = runAndParse(analysis.model, pictOptions);
  console.log(`  PICT generated ${rows.length} test cases (order=${order})`);
  console.log('  Headers:', headers.join(', '));

  // Show first few rows
  for (let i = 0; i < Math.min(3, rows.length); i++) {
    console.log(`  Row ${i + 1}:`, JSON.stringify(rows[i]));
  }
  if (rows.length > 3) console.log(`  ... and ${rows.length - 3} more`);

  // Save TSV as artifact
  const tsvContent = [headers.join('\t'), ...rows.map(r => headers.map(h => r[h]).join('\t'))].join('\n');
  await client.artifact({
    type: 'text',
    label: 'PICT Output (' + rows.length + ' rows)',
    content: tsvContent,
    contentType: 'text/tab-separated-values',
  });

  if (dryRun) {
    console.log('\n  --dry-run: skipping test generation');
    await client.progress(TOTAL_STEPS, TOTAL_STEPS, 'Complete (dry run)');
    await client.complete({ rows: rows.length, dryRun: true });
    process.exit(0);
  }

  // Step 4: Generate test script
  await client.progress(4, TOTAL_STEPS, 'Generate test script');
  const outputPath = getArg('output',
    resolve(__dirname, '..', '..', '..', 'examples',
      `test-petstore-${target.operationId || 'endpoint'}.mjs`));

  const scriptSource = generateTestScript(analysis, rows, {
    baseUrl,
    importPath: '../packages/bridge/script-client.mjs',
  });

  writeFileSync(outputPath, scriptSource, 'utf-8');
  console.log(`  Test script written: ${outputPath} (${scriptSource.length} bytes)`);
  console.log(`  Test cases: ${rows.length}`);

  // Save script as artifact
  await client.artifact({
    type: 'text',
    label: 'Generated Test Script',
    content: scriptSource,
    contentType: 'application/javascript',
  });

  // Step 5: Summary
  await client.progress(5, TOTAL_STEPS, 'Complete');
  console.log('\nPipeline complete:');
  console.log(`  Endpoint:   ${target.method} ${target.path}`);
  console.log(`  Parameters: ${Object.keys(analysis.paramMeta).length}`);
  console.log(`  PICT rows:  ${rows.length}`);
  console.log(`  Output:     ${outputPath}`);

  if (runAfter) {
    console.log('\n  --run: launching generated test...');
    // The test script is at outputPath — launch it
    const { execFile } = await import('child_process');
    const child = execFile('node', [outputPath], (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    await new Promise(resolve => child.on('close', resolve));
  }

  client.assert(rows.length > 0, 'PICT generated ' + rows.length + ' test cases');
  client.assert(scriptSource.length > 0, 'Test script generated (' + scriptSource.length + ' bytes)');
  const exitCode = client.summarize();
  await client.complete({
    assertions: client.getAssertionSummary(),
    endpoint: `${target.method} ${target.path}`,
    rows: rows.length,
    output: outputPath,
  });
  process.exit(exitCode);

} catch (err) {
  console.error('\nFatal:', err.message);
  client.assert(false, 'Fatal: ' + err.message);
  client.summarize();
  await client.complete({ assertions: client.getAssertionSummary() }).catch(() => {});
  process.exit(1);
}
