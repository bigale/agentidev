#!/usr/bin/env node
/**
 * LLM Build Driver — generates a SmartClient plugin from an OpenAPI spec,
 * informed by PICT test results.
 *
 * The TDD loop:
 *   1. Pipeline generates PICT tests from spec
 *   2. Tests run against the real API → pass/fail results
 *   3. Build driver reads spec + test results
 *   4. Constructs a detailed prompt for the LLM
 *   5. LLM generates SmartClient plugin config + handlers
 *   6. Plugin is published and optionally tested
 *
 * Uses the bridge's SC_GENERATE_UI handler (claude -p) or the programmatic
 * app-generator as a fallback when no LLM is available.
 *
 * Usage:
 *   node packages/bridge/api-to-app/build-driver.mjs [options]
 *
 * Options:
 *   --spec=<path>       OpenAPI spec (default: petstore-v2)
 *   --base-url=<url>    API base URL
 *   --entity=<name>     Primary entity (default: Pet)
 *   --test-results=<path>  JSON file with test results (optional)
 *   --no-llm            Skip LLM, use programmatic generator only
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REAL_DIR = __dirname.includes('api-to-app')
  ? __dirname
  : resolve(process.env.AGENTIDEV_ROOT || resolve(homedir(), 'repos', 'agentidev'), 'packages', 'bridge', 'api-to-app');
const REPO_ROOT = resolve(REAL_DIR, '..', '..', '..');

const { ScriptClient } = await import(pathToFileURL(resolve(REAL_DIR, '..', 'script-client.mjs')).href);
const { loadSpec, extractEndpoints, resolveSchema } = await import(pathToFileURL(resolve(REAL_DIR, 'spec-analyzer.mjs')).href);
const { generateApp } = await import(pathToFileURL(resolve(REAL_DIR, 'app-generator.mjs')).href);

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const found = args.find(a => a.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : def;
};
const hasFlag = (name) => args.includes(`--${name}`);

const specPath = getArg('spec', resolve(REAL_DIR, 'specs/petstore-v2.json'));
const baseUrl = getArg('base-url', 'https://petstore.swagger.io/v2');
const entityName = getArg('entity', 'Pet');
const testResultsPath = getArg('test-results', null);
const noLlm = hasFlag('no-llm');

const TOTAL_STEPS = 4;
const client = new ScriptClient('build-driver', { totalSteps: TOTAL_STEPS });

try {
  await client.connect();
  console.log('LLM Build Driver');
  console.log('=================\n');

  // Step 1: Load spec and test results
  await client.progress(1, TOTAL_STEPS, 'Load spec + test results');
  const spec = loadSpec(specPath);
  console.log('  Spec:', spec.info?.title, 'v' + spec.info?.version);
  console.log('  Entity:', entityName);
  console.log('  Base URL:', baseUrl);

  let testResults = null;
  if (testResultsPath && existsSync(testResultsPath)) {
    testResults = JSON.parse(readFileSync(testResultsPath, 'utf-8'));
    console.log('  Test results:', testResults.pass, 'pass /', testResults.fail, 'fail');
  }

  // Step 2: Build the LLM prompt
  await client.progress(2, TOTAL_STEPS, 'Build prompt');

  const endpoints = extractEndpoints(spec);
  const entityEndpoints = endpoints.filter(ep =>
    ep.tags?.some(t => t.toLowerCase() === entityName.toLowerCase()) ||
    ep.path.toLowerCase().includes('/' + entityName.toLowerCase())
  );

  const prompt = buildPrompt(spec, entityEndpoints, entityName, baseUrl, testResults);
  console.log('  Prompt length:', prompt.length, 'chars');
  console.log('  Endpoints:', entityEndpoints.map(ep => ep.method + ' ' + ep.path).join(', '));

  // Save prompt as artifact
  await client.artifact({
    type: 'text',
    label: 'Build Prompt',
    data: prompt,
    contentType: 'text/plain',
  });

  // Step 3: Generate the app
  await client.progress(3, TOTAL_STEPS, noLlm ? 'Generate (programmatic)' : 'Generate (LLM)');

  let appConfig;
  let handlers;
  let pluginId;

  if (noLlm) {
    // Programmatic generation (always works, no LLM needed)
    console.log('  Using programmatic app-generator (--no-llm)');
    const result = generateApp(specPath, { baseUrl, entity: entityName });
    appConfig = result.config;
    handlers = result.handlers;
    pluginId = result.pluginId;
    console.log('  Generated:', result.stats.fields, 'fields,', Object.entries(result.stats.operations).filter(([,v]) => v).length, 'operations');
  } else {
    // Try LLM via bridge, fall back to programmatic
    console.log('  Requesting LLM generation via bridge...');
    try {
      const llmResult = await client._sendRequest('BRIDGE_SC_GENERATE_UI', {
        prompt,
        model: 'haiku',
      }, 120000);

      if (llmResult.success && llmResult.config) {
        appConfig = llmResult.config;
        pluginId = entityName.toLowerCase() + '-api';
        handlers = '// LLM-generated — handlers embedded in config actions';
        console.log('  LLM generated config successfully');
      } else {
        throw new Error(llmResult.error || 'No config returned');
      }
    } catch (llmErr) {
      console.log('  LLM failed:', llmErr.message);
      console.log('  Falling back to programmatic generator');
      const result = generateApp(specPath, { baseUrl, entity: entityName });
      appConfig = result.config;
      handlers = result.handlers;
      pluginId = result.pluginId;
    }
  }

  // Save generated config as artifact
  const configJson = JSON.stringify(appConfig, null, 2);
  await client.artifact({
    type: 'text',
    label: 'Generated App Config',
    data: configJson,
    contentType: 'application/json',
  });

  // Save handlers as artifact
  if (handlers && handlers.length > 50) {
    await client.artifact({
      type: 'text',
      label: 'Generated Handlers',
      data: handlers,
      contentType: 'application/javascript',
    });
  }

  // Write config to file
  const outputDir = resolve(REPO_ROOT, 'examples');
  const configPath = resolve(outputDir, `app-${pluginId}-config.json`);
  writeFileSync(configPath, configJson, 'utf-8');
  console.log('  Config:', configPath);

  // Step 4: Summary
  await client.progress(4, TOTAL_STEPS, 'Complete');
  console.log('\nBuild complete:');
  console.log('  Plugin ID:', pluginId);
  console.log('  Config:', configJson.length, 'bytes');
  console.log('  Layout:', appConfig.layout?._type);
  console.log('  Members:', appConfig.layout?.members?.length || 0);

  client.assert(appConfig.layout != null, 'App has layout');
  client.assert(appConfig.layout?.members?.length > 0, 'Layout has ' + (appConfig.layout?.members?.length || 0) + ' members');

  const exitCode = client.summarize();
  await client.complete({
    assertions: client.getAssertionSummary(),
    pluginId,
    configSize: configJson.length,
  });
  process.exit(exitCode);

} catch (err) {
  console.error('\nFatal:', err.message);
  client.assert(false, 'Fatal: ' + err.message);
  client.summarize();
  await client.complete({ assertions: client.getAssertionSummary() }).catch(() => {});
  process.exit(1);
}

/**
 * Build a detailed prompt for the LLM that includes:
 * - The OpenAPI spec fragment for the entity
 * - Test results showing API behavior
 * - SmartClient config format requirements
 * - Agentidev plugin constraints
 */
function buildPrompt(spec, endpoints, entity, baseUrl, testResults) {
  const entitySchema = findSchema(entity, spec);

  let prompt = `Generate a SmartClient UI dashboard config for the ${entity} entity from the ${spec.info?.title} API.

Base URL: ${baseUrl}

Endpoints:
${endpoints.map(ep => `- ${ep.method} ${ep.path} (${ep.operationId}): ${ep.summary || ''}`).join('\n')}

${entity} schema fields:
${entitySchema ? Object.entries(entitySchema.properties || {}).map(([name, prop]) => {
    const resolved = resolveSchema(prop, spec);
    return `- ${name}: ${resolved.type || 'object'}${resolved.enum ? ' enum(' + resolved.enum.join(',') + ')' : ''}${(entitySchema.required || []).includes(name) ? ' REQUIRED' : ''}`;
  }).join('\n') : 'No schema found'}

Requirements:
1. Use VLayout as root with 100% width and height
2. Include a filter form at the top for the list endpoint query parameter
3. Include a Fetch button that calls the list endpoint via fetchAndLoadGrid action
4. Include a ListGrid showing the entity fields
5. Include a create form with fields for required properties
6. Include a Create button that calls the create endpoint
7. Use _messageType for handler names: ${entity.toUpperCase()}_LIST and ${entity.toUpperCase()}_CREATE
8. Use _payloadFrom to read form values at click time
9. Use _dynamicFields: true on grids so columns auto-infer from response
10. All buttons use fetchAndLoadGrid action with _targetGrid and _statusCanvas
11. Give every interactive component a unique ID`;

  if (testResults) {
    prompt += `\n\nTest results from PICT combinatorial testing:
- Total cases: ${testResults.pass + testResults.fail}
- Passed: ${testResults.pass}
- Failed: ${testResults.fail}
${testResults.findings ? '\nFindings:\n' + testResults.findings.join('\n') : ''}
\nThe generated UI should handle the failure cases gracefully (error messages, validation).`;
  }

  prompt += `\n\nReturn ONLY the JSON config object with { dataSources: [], layout: { _type: "VLayout", ... } }. Include an empty dataSources array (required by the renderer). Handlers provide data directly via actions.`;

  return prompt;
}

function findSchema(entity, spec) {
  const schemas = spec.components?.schemas || spec.definitions || {};
  return schemas[entity] || null;
}
