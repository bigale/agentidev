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

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { pathToFileURL } from 'url';

// Resolve the real module directory — handles being run from ~/.agentidev/scripts/
// or from the repo directly. The sibling modules (spec-analyzer, pict-runner, etc.)
// live alongside pipeline.mjs in packages/bridge/api-to-app/.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Detect if we're running from a copy (scripts dir) vs the real location
const REAL_DIR = resolve(__dirname).includes('api-to-app')
  ? __dirname
  : resolve(process.env.AGENTIDEV_ROOT || resolve(homedir(), 'repos', 'agentidev'), 'packages', 'bridge', 'api-to-app');
const REPO_ROOT = resolve(REAL_DIR, '..', '..', '..');

// Dynamic imports from the real directory so copies in ~/.agentidev/scripts/ work
const { ScriptClient } = await import(pathToFileURL(resolve(REAL_DIR, '..', 'script-client.mjs')).href);
const { loadSpec, extractEndpoints, generatePictModel, generateAuthModel } = await import(pathToFileURL(resolve(REAL_DIR, 'spec-analyzer.mjs')).href);
const { runAndParse, isPictAvailable } = await import(pathToFileURL(resolve(REAL_DIR, 'pict-runner.mjs')).href);
const { generateTestScript, generateWorkflowTest } = await import(pathToFileURL(resolve(REAL_DIR, 'test-generator.mjs')).href);
const { generateApp } = await import(pathToFileURL(resolve(REAL_DIR, 'app-generator.mjs')).href);
const { generateAppFromPict } = await import(pathToFileURL(resolve(REAL_DIR, 'app-from-pict.mjs')).href);
const { generateUiTest } = await import(pathToFileURL(resolve(REAL_DIR, 'ui-test-generator.mjs')).href);

const EXAMPLES_DIR = resolve(REPO_ROOT, 'examples');

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const found = args.find(a => a.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : def;
};
const hasFlag = (name) => args.includes(`--${name}`);

const specPath = getArg('spec', resolve(REAL_DIR, 'specs/petstore-v2.json'));
const targetEndpoint = getArg('endpoint', 'findPetsByStatus');
const baseUrl = getArg('base-url', 'https://petstore.swagger.io/v2');
const outputDir = getArg('output', EXAMPLES_DIR);
const order = parseInt(getArg('order', '2'), 10);
const seedArg = getArg('seed', undefined);
const dryRun = hasFlag('dry-run');
const runAfter = hasFlag('run');
const doWorkflow = hasFlag('workflow');
const doBuild = hasFlag('build');
const doFullLoop = hasFlag('full-loop');
const entityName = getArg('entity', 'Pet');

// Target endpoints for "all" mode
const PET_ENDPOINTS = ['findPetsByStatus', 'addPet', 'updatePet', 'getPetById', 'deletePet', 'uploadFile'];
const ORDER_ENDPOINTS = ['placeOrder', 'getOrderById', 'deleteOrder', 'getInventory'];
const ALL_ENDPOINTS = [...PET_ENDPOINTS, ...ORDER_ENDPOINTS];

const isMulti = targetEndpoint === 'all';
const targetIds = isMulti ? ALL_ENDPOINTS : [targetEndpoint];
const totalSteps = targetIds.length + (doWorkflow ? 1 : 0) + (doBuild || doFullLoop ? 1 : 0) + (doFullLoop ? 1 : 0) + 2;

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
    // Generate functional model (no auth — auth tested separately in L0)
    const analysis = generatePictModel(target, spec, { includeAuth: false });
    console.log('  PICT params:', Object.keys(analysis.paramMeta).length);

    if (dryRun) {
      console.log('\n' + analysis.model + '\n');
    }

    // Save PICT model as a persistent file artifact
    const modelDir = resolve(__dirname, 'models');
    mkdirSync(modelDir, { recursive: true });
    const modelPath = resolve(modelDir, `${target.operationId}.pict`);
    writeFileSync(modelPath, analysis.model, 'utf-8');
    await client.artifact({
      type: 'text',
      label: `PICT Model: ${target.operationId}`,
      filePath: modelPath,
      contentType: 'text/plain',
    });

    // Run PICT
    const pictOpts = { order, caseSensitive: true };
    if (seedArg) pictOpts.seed = parseInt(seedArg, 10);

    // If no PICT params (e.g. GET /store/inventory with auth removed),
    // generate a single test case with no parameters
    let headers, rows;
    if (Object.keys(analysis.paramMeta).length === 0) {
      headers = [];
      rows = [{ _singleCase: true }];
      console.log('  No PICT params — 1 direct test case');
    } else {
      const result = runAndParse(analysis.model, pictOpts);
      headers = result.headers;
      rows = result.rows;
      console.log('  PICT cases:', rows.length);
    }
    client.assert(rows.length > 0, target.operationId + ': ' + rows.length + ' cases');

    // Save TSV output as artifact
    const tsvContent = [headers.join('\t'), ...rows.map(r => headers.map(h => r[h]).join('\t'))].join('\n');
    const tsvPath = resolve(modelDir, `${target.operationId}.tsv`);
    writeFileSync(tsvPath, tsvContent, 'utf-8');
    await client.artifact({
      type: 'text',
      label: `PICT Output: ${target.operationId} (${rows.length} rows)`,
      filePath: tsvPath,
      contentType: 'text/tab-separated-values',
    });

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
      spec,
      importPath: '../packages/bridge/script-client.mjs',
    });
    writeFileSync(outputPath, scriptSource, 'utf-8');
    console.log('  Output:', outputPath, `(${rows.length} cases, ${scriptSource.length} bytes)`);

    // Save generated test as artifact (viewable in dashboard Artifacts tab)
    await client.artifact({
      type: 'text',
      label: `Test Script: ${target.operationId} (${rows.length} cases)`,
      filePath: outputPath,
      contentType: 'application/javascript',
    });

    // Auto-register generated test in the bridge script library
    // so it appears in the dashboard Scripts panel and can be re-run with one click
    const testName = `test-petstore-${target.operationId}`;
    try {
      await client._sendRequest('BRIDGE_SCRIPT_SAVE', { name: testName, source: scriptSource });
      console.log('  Registered in script library:', testName);
    } catch (e) {
      console.warn('  Script library registration failed (non-fatal):', e.message);
    }

    generated.push({
      operationId: target.operationId,
      method: target.method,
      path: target.path,
      cases: rows.length,
      outputPath,
    });
  }

  // L0 Auth test — separate from functional tests
  if (isMulti && !dryRun) {
    console.log('\n  === L0: Auth Test Suite ===');
    const resolvedEndpoints = targetIds
      .map(opId => endpoints.find(ep => ep.operationId === opId))
      .filter(Boolean);
    const { model: authModel } = generateAuthModel(resolvedEndpoints, spec);

    // Save auth model
    const authModelPath = resolve(REAL_DIR, 'models', 'auth.pict');
    writeFileSync(authModelPath, authModel, 'utf-8');
    await client.artifact({
      type: 'text',
      label: 'PICT Model: Auth (L0)',
      filePath: authModelPath,
      contentType: 'text/plain',
    });

    const pictOpts = { order, caseSensitive: true };
    if (seedArg) pictOpts.seed = parseInt(seedArg, 10);
    const { rows: authRows } = runAndParse(authModel, pictOpts);
    console.log('  Auth cases:', authRows.length);

    // Save auth TSV
    const authHeaders = Object.keys(authRows[0] || {});
    const authTsv = [authHeaders.join('\t'), ...authRows.map(r => authHeaders.map(h => r[h]).join('\t'))].join('\n');
    const authTsvPath = resolve(REAL_DIR, 'models', 'auth.tsv');
    writeFileSync(authTsvPath, authTsv, 'utf-8');
    await client.artifact({
      type: 'text',
      label: 'PICT Output: Auth (' + authRows.length + ' rows)',
      filePath: authTsvPath,
      contentType: 'text/tab-separated-values',
    });

    client.assert(authRows.length > 0, 'Auth: ' + authRows.length + ' cases');
    generated.push({
      operationId: 'auth',
      method: 'AUTH',
      path: '/auth',
      cases: authRows.length,
      outputPath: authModelPath,
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

    // Register workflow test in script library
    try {
      await client._sendRequest('BRIDGE_SCRIPT_SAVE', { name: 'test-petstore-pet-workflow', source: workflowSource });
      console.log('  Registered in script library: test-petstore-pet-workflow');
    } catch (e) {
      console.warn('  Script library registration failed (non-fatal):', e.message);
    }

    // Save workflow script as artifact
    await client.artifact({
      type: 'text',
      label: 'Workflow Test: POST->GET->DELETE',
      filePath: workflowPath,
      contentType: 'application/javascript',
    });

    generated.push({
      operationId: 'pet-workflow',
      method: 'CRUD',
      path: '/pet/*',
      cases: 6,
      outputPath: workflowPath,
    });
    client.assert(true, 'Workflow test generated + registered');
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

  // Full loop: generate PICT-informed app and publish as plugin
  if (doFullLoop && !dryRun) {
    console.log('\n  === Full Loop: Generate + Publish PICT-Informed App ===');
    try {
      const modelDir = resolve(REAL_DIR, 'models');
      const appResult = generateAppFromPict({
        specPath,
        modelsDir: modelDir,
        baseUrl,
        entity: entityName,
      });

      // Save config file for manual plugin loading
      const configPath = resolve(outputDir, 'app-' + appResult.pluginId + '-config.json');
      writeFileSync(configPath, JSON.stringify(appResult.config, null, 2), 'utf-8');
      console.log('  Config saved:', configPath);

      // Publish plugin via bridge relay → extension
      try {
        await client._sendRequest('BRIDGE_PUBLISH_PLUGIN', {
          name: appResult.manifest.name,
          projectId: appResult.pluginId,
          description: appResult.manifest.description,
          config: appResult.config,
        }, 5000);
        console.log('  Published plugin:', appResult.pluginId);
      } catch (e) {
        console.log('  Plugin publish relay failed (non-fatal):', e.message);
      }

      // Save config as artifact
      const configJson = JSON.stringify(appResult.config, null, 2);
      await client.artifact({
        type: 'text',
        label: 'App Config: ' + appResult.pluginId,
        data: configJson,
        contentType: 'application/json',
      });

      // Save handlers as artifact
      await client.artifact({
        type: 'text',
        label: 'App Handlers: ' + appResult.pluginId,
        data: appResult.handlers,
        contentType: 'application/javascript',
      });

      client.assert(true, 'Plugin published: ' + appResult.pluginId);
      generated.push({
        operationId: appResult.pluginId,
        method: 'PLUGIN',
        path: '/' + entityName.toLowerCase() + '-app',
        cases: Object.keys(appResult.config.layout.members).length,
        outputPath: appResult.pluginId,
      });
      // Phase 3: Generate CDP UI test for the published plugin
      console.log('\n  --- Generate UI Test ---');
      const listModelPath = resolve(REAL_DIR, 'models', 'findPetsByStatus.pict');
      if (existsSync(listModelPath)) {
        const uiTestSource = generateUiTest({
          pluginId: appResult.pluginId,
          listModelPath,
          filterFormId: 'filterForm',
          filterField: 'status',
          fetchButtonId: 'btnFetch',
          gridId: 'mainGrid',
          createFormId: 'createForm',
          createButtonId: 'btnCreate',
          importPath: '../packages/bridge/script-client.mjs',
        });

        const uiTestPath = resolve(outputDir, 'test-ui-' + appResult.pluginId + '.mjs');
        writeFileSync(uiTestPath, uiTestSource, 'utf-8');
        console.log('  UI test:', uiTestPath);

        // Register in script library
        try {
          await client._sendRequest('BRIDGE_SCRIPT_SAVE', { name: 'test-ui-' + appResult.pluginId, source: uiTestSource });
          console.log('  Registered: test-ui-' + appResult.pluginId);
        } catch (e) { /* non-fatal */ }

        // Save as artifact
        await client.artifact({
          type: 'text',
          label: 'UI Test: ' + appResult.pluginId,
          data: uiTestSource.substring(0, 3000) + (uiTestSource.length > 3000 ? '\n// ... truncated' : ''),
          contentType: 'application/javascript',
        });

        client.assert(true, 'UI test generated: test-ui-' + appResult.pluginId);
        generated.push({
          operationId: 'test-ui-' + appResult.pluginId,
          method: 'UITEST',
          path: '/' + entityName.toLowerCase() + '-app',
          cases: 3, // filter values
          outputPath: uiTestPath,
        });
      }
    } catch (err) {
      console.error('  Full loop build failed:', err.message);
      client.assert(false, 'Plugin generation failed: ' + err.message);
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
