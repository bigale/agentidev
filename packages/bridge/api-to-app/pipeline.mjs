#!/usr/bin/env node
/**
 * api-to-app Pipeline — orchestrates the full flow:
 *   OpenAPI spec → PICT models → combinatorial rows → test scripts
 *
 * Supports single endpoint, multi-endpoint, and workflow modes.
 *
 * Usage:
 *   node packages/bridge/api-to-app/pipeline.mjs [options]
 *
 * Options:
 *   --spec=<path>       Path to OpenAPI spec (default: specs/petstore-v2.json)
 *   --endpoint=<op>     Operation ID (default: findPetsByStatus). Use "all" for multi.
 *   --base-url=<url>    API base URL (default: https://petstore.swagger.io/v2)
 *   --output=<dir>      Output directory (default: examples/)
 *   --order=<n>         PICT combinatorial order (default: 2 = pairwise)
 *   --seed=<n>          PICT random seed for reproducibility
 *   --workflow           Also generate a CRUD workflow test (POST → GET → DELETE)
 *   --run               Launch generated tests after creating them
 *   --dry-run           Print PICT models and rows, don't generate scripts
 */

import { ScriptClient } from '../script-client.mjs';
import { loadSpec, extractEndpoints, generatePictModel } from './spec-analyzer.mjs';
import { runAndParse, isPictAvailable } from './pict-runner.mjs';
import { generateTestScript, generateWorkflowTest } from './test-generator.mjs';
import { generateApp } from './app-generator.mjs';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = resolve(__dirname, '..', '..', '..', 'examples');

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const found = args.find(a => a.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : def;
};
const hasFlag = (name) => args.includes(`--${name}`);

const specPath = getArg('spec', resolve(__dirname, 'specs/petstore-v2.json'));
const targetEndpoint = getArg('endpoint', 'findPetsByStatus');
const baseUrl = getArg('base-url', 'https://petstore.swagger.io/v2');
const outputDir = getArg('output', EXAMPLES_DIR);
const order = parseInt(getArg('order', '2'), 10);
const seedArg = getArg('seed', undefined);
const dryRun = hasFlag('dry-run');
const runAfter = hasFlag('run');
const doWorkflow = hasFlag('workflow');
const doBuild = hasFlag('build');
const entityName = getArg('entity', 'Pet');

// Target endpoints for "all" mode
const PET_ENDPOINTS = ['findPetsByStatus', 'addPet', 'getPetById', 'deletePet'];

const isMulti = targetEndpoint === 'all';
const targetIds = isMulti ? PET_ENDPOINTS : [targetEndpoint];
const totalSteps = targetIds.length + (doWorkflow ? 1 : 0) + (doBuild ? 1 : 0) + 2;

const client = new ScriptClient('api-to-app-pipeline', { totalSteps });

try {
  await client.connect();
  console.log('api-to-app Pipeline');
  console.log('===================\n');

  // Step 1: Prerequisites
  await client.progress(1, totalSteps, 'Check prerequisites');
  if (!isPictAvailable()) {
    throw new Error('PICT binary not found. Install from https://github.com/microsoft/pict');
  }

  // Step 2: Load spec
  await client.progress(2, totalSteps, 'Analyze OpenAPI spec');
  const spec = loadSpec(specPath);
  console.log('  Spec:', spec.info?.title, 'v' + spec.info?.version);

  const endpoints = extractEndpoints(spec);
  console.log('  Endpoints:', endpoints.length);
  mkdirSync(outputDir, { recursive: true });

  const generated = [];

  // Steps 3+: Process each target endpoint
  for (let idx = 0; idx < targetIds.length; idx++) {
    const opId = targetIds[idx];
    const stepNum = idx + 3;
    await client.progress(stepNum, totalSteps, opId);

    const target = endpoints.find(ep =>
      ep.operationId === opId || `${ep.method} ${ep.path}` === opId
    );
    if (!target) {
      console.log(`  SKIP: "${opId}" not found in spec`);
      client.assert(false, opId + ' not found in spec');
      continue;
    }

    console.log(`\n  === ${target.method} ${target.path} (${target.operationId}) ===`);
    console.log('  Parameters:', target.parameters.length,
      target.parameters.find(p => p.in === 'body') ? '+ body' : '');

    // Generate PICT model
    const analysis = generatePictModel(target, spec);
    console.log('  PICT params:', Object.keys(analysis.paramMeta).length);

    if (dryRun) {
      console.log('\n' + analysis.model + '\n');
    }

    // Save model as artifact
    await client.artifact({
      type: 'text',
      label: `PICT: ${target.operationId}`,
      content: analysis.model,
      contentType: 'text/plain',
    });

    // Run PICT
    const pictOpts = { order, caseSensitive: true };
    if (seedArg) pictOpts.seed = parseInt(seedArg, 10);

    const { rows } = runAndParse(analysis.model, pictOpts);
    console.log('  PICT cases:', rows.length);
    client.assert(rows.length > 0, target.operationId + ': ' + rows.length + ' PICT cases');

    if (dryRun) {
      for (let i = 0; i < Math.min(3, rows.length); i++) {
        console.log('  Row', i + 1 + ':', JSON.stringify(rows[i]));
      }
      continue;
    }

    // Generate test script
    const outputPath = resolve(outputDir, `test-petstore-${target.operationId}.mjs`);
    const scriptSource = generateTestScript(analysis, rows, {
      baseUrl,
      importPath: '../packages/bridge/script-client.mjs',
    });
    writeFileSync(outputPath, scriptSource, 'utf-8');
    console.log('  Output:', outputPath, `(${rows.length} cases, ${scriptSource.length} bytes)`);

    generated.push({
      operationId: target.operationId,
      method: target.method,
      path: target.path,
      cases: rows.length,
      outputPath,
    });
  }

  // Workflow test
  if (doWorkflow && !dryRun) {
    await client.progress(totalSteps - 1, totalSteps, 'Generate workflow');
    const workflowSource = generateWorkflowTest(null, baseUrl, {
      importPath: '../packages/bridge/script-client.mjs',
    });
    const workflowPath = resolve(outputDir, 'test-petstore-pet-workflow.mjs');
    writeFileSync(workflowPath, workflowSource, 'utf-8');
    console.log('\n  Workflow test:', workflowPath);
    generated.push({
      operationId: 'pet-workflow',
      method: 'CRUD',
      path: '/pet/*',
      cases: 6,
      outputPath: workflowPath,
    });
    client.assert(true, 'Workflow test generated');
  }

  // Build app from spec
  if (doBuild && !dryRun) {
    console.log('\n  === Build: Generate SmartClient App ===');
    try {
      const result = generateApp(specPath, {
        baseUrl,
        entity: entityName,
        operations: isMulti ? PET_ENDPOINTS : [targetEndpoint],
      });
      console.log('  Entity:', result.stats.entity);
      console.log('  Fields:', result.stats.fields);
      console.log('  Operations:', Object.entries(result.stats.operations).filter(([,v]) => v).map(([k]) => k).join(', '));

      // Write config + handlers as artifacts
      const configJson = JSON.stringify(result.config, null, 2);
      await client.artifact({
        type: 'text',
        label: 'Generated App Config',
        content: configJson,
        contentType: 'application/json',
      });
      await client.artifact({
        type: 'text',
        label: 'Generated Handlers',
        content: result.handlers,
        contentType: 'application/javascript',
      });

      // Save config to a file for review
      const configPath = resolve(outputDir, `app-${result.pluginId}-config.json`);
      writeFileSync(configPath, configJson, 'utf-8');
      console.log('  Config:', configPath);
      console.log('  Plugin ID:', result.pluginId);
      client.assert(true, 'App generated: ' + result.pluginId + ' (' + result.stats.fields + ' fields)');

      generated.push({
        operationId: result.pluginId,
        method: 'APP',
        path: '/' + entityName.toLowerCase() + '/*',
        cases: result.stats.fields,
        outputPath: configPath,
      });
    } catch (err) {
      console.error('  Build failed:', err.message);
      client.assert(false, 'App generation failed: ' + err.message);
    }
  }

  // Summary
  await client.progress(totalSteps, totalSteps, 'Complete');
  console.log('\n\nPipeline summary:');
  for (const g of generated) {
    console.log(`  ${g.method.padEnd(6)} ${g.path.padEnd(25)} ${String(g.cases).padStart(3)} cases → ${g.outputPath.split('/').pop()}`);
  }
  client.assert(generated.length > 0, generated.length + ' artifacts generated');

  // Run generated tests
  if (runAfter && generated.length > 0) {
    console.log('\n  Running generated tests...\n');
    const { execFileSync } = await import('child_process');
    for (const g of generated) {
      console.log(`  --- ${g.operationId} ---`);
      try {
        const output = execFileSync('node', [g.outputPath], {
          encoding: 'utf-8',
          timeout: 60000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        console.log(output);
      } catch (err) {
        console.log(err.stdout || '');
        console.error(err.stderr || err.message);
      }
    }
  }

  const exitCode = client.summarize();
  await client.complete({
    assertions: client.getAssertionSummary(),
    generated: generated.map(g => ({ ...g, outputPath: g.outputPath.split('/').pop() })),
  });
  process.exit(exitCode);

} catch (err) {
  console.error('\nFatal:', err.message);
  client.assert(false, 'Fatal: ' + err.message);
  client.summarize();
  await client.complete({ assertions: client.getAssertionSummary() }).catch(() => {});
  process.exit(1);
}
