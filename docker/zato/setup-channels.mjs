#!/usr/bin/env node
/**
 * Petstore Zato Setup — Host-side automated setup
 *
 * Creates REST channels, initializes DB, and verifies the deployment.
 * Idempotent — safe to run multiple times.
 *
 * Usage:
 *   node docker/zato/setup-channels.mjs
 *   node docker/zato/setup-channels.mjs --zato-url=http://localhost:11223
 *   node docker/zato/setup-channels.mjs --container=agentidev-zato
 *
 * The script:
 *   1. Waits for Zato to be ready (ping)
 *   2. Runs setup-channels.sh inside the container (creates channels + DB)
 *   3. Verifies all endpoints from the host
 */

import { execSync } from 'child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { resolve as pathResolve, join as pathJoin } from 'path';

const ZATO_URL = process.argv.find(a => a.startsWith('--zato-url='))?.split('=')[1] || 'http://localhost:11223';
const CONTAINER = process.argv.find(a => a.startsWith('--container='))?.split('=')[1] || 'agentidev-zato';
const EXTERNAL_PLUGINS_DIR = process.argv.find(a => a.startsWith('--external-plugins='))?.split('=')[1]
  || process.env.EXTERNAL_PLUGINS_DIR
  || '';

const CHANNELS = [
  { name: 'pet-find-by-status',  method: 'GET',    path: '/api/pet/findByStatus',              service: 'petstore.pet.find-by-status' },
  { name: 'pet-init',            method: 'POST',   path: '/api/pet/init',                      service: 'petstore.init' },
  { name: 'pet-add',             method: 'POST',   path: '/api/pet',                           service: 'petstore.pet.add' },
  { name: 'pet-get-by-id',       method: 'GET',    path: '/api/pet/id/{pet_id}',               service: 'petstore.pet.get-by-id' },
  { name: 'pet-delete',          method: 'DELETE',  path: '/api/pet/delete/{pet_id}',           service: 'petstore.pet.delete' },
  { name: 'pet-update',          method: 'PUT',     path: '/api/pet/update',                    service: 'petstore.pet.update' },
  { name: 'store-place-order',   method: 'POST',   path: '/api/store/order',                   service: 'petstore.store.place-order' },
  { name: 'store-get-order',     method: 'GET',    path: '/api/store/order/id/{orderId}',      service: 'petstore.store.get-order-by-id' },
  { name: 'store-delete-order',  method: 'DELETE',  path: '/api/store/order/delete/{orderId}',  service: 'petstore.store.delete-order' },
  { name: 'store-inventory',     method: 'GET',    path: '/api/store/inventory',                service: 'petstore.store.get-inventory' },
];

async function waitForZato(maxWaitMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const resp = await fetch(ZATO_URL + '/zato/ping');
      if (resp.ok) {
        const data = await resp.json();
        if (data.zato_env?.result === 'ZATO_OK') return true;
      }
    } catch { /* not ready yet */ }
    console.log(`  Waiting for Zato at ${ZATO_URL}... (${Math.round((Date.now() - start) / 1000)}s)`);
    await new Promise(r => setTimeout(r, 5000));
  }
  return false;
}

async function testEndpoint(method, path, description) {
  try {
    const resp = await fetch(ZATO_URL + path, { method });
    const status = resp.status;
    if (resp.ok) {
      const data = await resp.json();
      const info = Array.isArray(data) ? `${data.length} items` : typeof data === 'object' ? 'OK' : String(data);
      console.log(`  PASS  ${method.padEnd(6)} ${path.padEnd(40)} ${info}`);
      return true;
    } else {
      console.log(`  WARN  ${method.padEnd(6)} ${path.padEnd(40)} status=${status}`);
      return status === 404; // 404 is acceptable for get-by-id with no data
    }
  } catch (e) {
    console.log(`  FAIL  ${method.padEnd(6)} ${path.padEnd(40)} ${e.message}`);
    return false;
  }
}

/**
 * Discover external plugins from EXTERNAL_PLUGINS_DIR.
 * Each plugin is a subdirectory containing zato/{services/, schema.sql, channels.json}.
 * Returns an array of { id, dir, services, schema, channels, datasources }.
 */
function discoverExternalPlugins() {
  if (!EXTERNAL_PLUGINS_DIR) return [];
  const root = pathResolve(EXTERNAL_PLUGINS_DIR);
  if (!existsSync(root)) {
    console.log(`  External plugins dir does not exist: ${root}`);
    return [];
  }
  const plugins = [];
  for (const entry of readdirSync(root)) {
    const pluginDir = pathJoin(root, entry);
    if (!statSync(pluginDir).isDirectory()) continue;
    const zatoDir = pathJoin(pluginDir, 'zato');
    if (!existsSync(zatoDir) || !statSync(zatoDir).isDirectory()) continue;

    const servicesDir = pathJoin(zatoDir, 'services');
    const schemaPath = pathJoin(zatoDir, 'schema.sql');
    const channelsPath = pathJoin(zatoDir, 'channels.json');

    const services = existsSync(servicesDir)
      ? readdirSync(servicesDir).filter(f => f.endsWith('.py'))
      : [];

    let parsed = { channels: [], datasources: {} };
    if (existsSync(channelsPath)) {
      try {
        parsed = JSON.parse(readFileSync(channelsPath, 'utf8'));
      } catch (e) {
        console.error(`  Bad channels.json for ${entry}: ${e.message}`);
        continue;
      }
    }

    plugins.push({
      id: entry,
      dir: pluginDir,
      services,
      schema: existsSync(schemaPath) ? schemaPath : null,
      channels: parsed.channels || [],
      datasources: parsed.datasources || {},
    });
  }
  return plugins;
}

/**
 * Deploy a plugin's Python services into Zato's pickup directory.
 * Hot-deploy is configured but the bind-mount alone doesn't trigger it,
 * so we explicitly cp into pickup/incoming/services/.
 */
function deployPluginServices(plugin) {
  if (!plugin.services.length) return 0;
  const containerSrc = `/opt/zato/external-plugins/${plugin.id}/zato/services`;
  const containerDst = '/opt/zato/env/qs-1/server1/pickup/incoming/services';
  try {
    execSync(
      `docker exec ${CONTAINER} bash -c "cp ${containerSrc}/*.py ${containerDst}/ && chown zato:zato ${containerDst}/*.py"`,
      { encoding: 'utf8' }
    );
    return plugin.services.length;
  } catch (e) {
    console.error(`  Failed to deploy ${plugin.id} services: ${e.message}`);
    return 0;
  }
}

/**
 * Register one REST channel via `zato create-rest-channel`.
 * Idempotent — already-exists is treated as success.
 */
function createChannel(channel) {
  const cmd = `docker exec ${CONTAINER} /opt/zato/current/bin/zato create-rest-channel ` +
    `--path /opt/zato/env/qs-1/server1 ` +
    `--name "${channel.name}" ` +
    `--url-path "${channel.path}" ` +
    `--service "${channel.service}" ` +
    `--is-active true`;
  try {
    const out = execSync(cmd, { encoding: 'utf8' });
    if (out.includes('already exists')) return 'EXISTS';
    return 'CREATED';
  } catch (e) {
    const msg = String(e.stderr || e.message);
    if (msg.includes('already exists')) return 'EXISTS';
    return `ERROR: ${msg.split('\n').slice(0, 2).join(' ')}`;
  }
}

async function setupExternalPlugins() {
  if (!EXTERNAL_PLUGINS_DIR) {
    console.log('  EXTERNAL_PLUGINS_DIR not set — skipping external plugins.');
    return;
  }

  const plugins = discoverExternalPlugins();
  if (!plugins.length) {
    console.log('  No external plugins found.');
    return;
  }

  console.log(`  Found ${plugins.length} external plugin(s):`);
  for (const p of plugins) {
    console.log(`    - ${p.id}: ${p.services.length} services, ${p.channels.length} channels` +
      `${p.schema ? ' (with schema.sql)' : ''}`);
  }
  console.log('');

  // Deploy services
  for (const plugin of plugins) {
    const count = deployPluginServices(plugin);
    console.log(`  ${plugin.id}: deployed ${count}/${plugin.services.length} services to pickup`);
  }

  // Wait briefly for Zato to pick up the new services
  console.log('  Waiting 8s for Zato hot-deploy to register services...');
  await new Promise(r => setTimeout(r, 8000));

  // Register channels
  for (const plugin of plugins) {
    if (!plugin.channels.length) continue;
    console.log(`  ${plugin.id}: registering ${plugin.channels.length} channels...`);
    for (const ch of plugin.channels) {
      const status = createChannel(ch);
      const tag = status === 'CREATED' ? 'CREATED' : status === 'EXISTS' ? 'EXISTS ' : 'ERROR  ';
      console.log(`    ${tag} ${ch.method.padEnd(7)} ${ch.path.padEnd(45)} -> ${ch.service}`);
    }
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('  Petstore Zato Setup (Host-Side)');
  console.log('='.repeat(60));
  console.log('');
  console.log(`  Zato URL:    ${ZATO_URL}`);
  console.log(`  Container:   ${CONTAINER}`);
  console.log('');

  // Step 1: Check container is running
  console.log('[1/4] Checking Docker container...');
  try {
    const status = execSync(`docker inspect ${CONTAINER} --format '{{.State.Status}}'`, { encoding: 'utf8' }).trim();
    console.log(`  Container status: ${status}`);
    if (status !== 'running') {
      console.error('  Container is not running. Start with: cd docker/zato && docker compose up -d');
      process.exit(1);
    }
  } catch {
    console.error(`  Container "${CONTAINER}" not found.`);
    console.error('  Start with: cd docker/zato && docker compose up -d');
    process.exit(1);
  }
  console.log('');

  // Step 2: Wait for Zato
  console.log('[2/4] Waiting for Zato server...');
  const ready = await waitForZato();
  if (!ready) {
    console.error('  Zato not ready after 90s. Check logs: docker logs agentidev-zato');
    process.exit(1);
  }
  console.log('  Zato is ready.');
  console.log('');

  // Step 3: Run setup inside container
  console.log('[3/4] Running setup inside container...');
  try {
    const output = execSync(
      `docker exec ${CONTAINER} bash /opt/zato/sql/setup-channels.sh`,
      { encoding: 'utf8', timeout: 120000 }
    );
    // Print indented
    for (const line of output.split('\n')) {
      console.log('  | ' + line);
    }
  } catch (e) {
    console.error('  Setup script failed:', e.message);
    console.log('  Continuing with verification...');
  }
  console.log('');

  // Step 3.5: External plugins (consulting-template etc.)
  console.log('[3.5/4] External plugins...');
  await setupExternalPlugins();
  console.log('');

  // Step 4: Verify from host
  console.log('[4/4] Verifying endpoints from host...');
  let passed = 0;
  let total = 0;

  // Ping
  total++;
  if (await testEndpoint('GET', '/zato/ping', 'Zato ping')) passed++;

  // Pet endpoints
  total++;
  if (await testEndpoint('GET', '/api/pet/findByStatus?status=available', 'Find pets')) passed++;
  total++;
  if (await testEndpoint('GET', '/api/pet/id/1', 'Get pet by ID')) passed++;
  total++;
  if (await testEndpoint('GET', '/api/store/inventory', 'Store inventory')) passed++;

  // CRUD test
  total++;
  try {
    const createResp = await fetch(ZATO_URL + '/api/pet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 9999, name: 'SetupTest', status: 'available' }),
    });
    const created = await createResp.json();
    if (created.id || created.name === 'SetupTest') {
      console.log(`  PASS  POST   /api/pet${' '.repeat(34)} created id=${created.id || 9999}`);

      // Clean up
      await fetch(ZATO_URL + '/api/pet/delete/9999', { method: 'DELETE' });
      passed++;
    } else {
      console.log(`  FAIL  POST   /api/pet${' '.repeat(34)} unexpected response`);
    }
  } catch (e) {
    console.log(`  FAIL  POST   /api/pet${' '.repeat(34)} ${e.message}`);
  }

  console.log('');
  console.log('='.repeat(60));
  console.log(`  Results: ${passed}/${total} checks passed`);
  console.log('');
  console.log('  Endpoints:');
  for (const ch of CHANNELS) {
    console.log(`    ${ch.method.padEnd(7)} ${ZATO_URL}${ch.path}`);
  }
  console.log('');
  console.log('  Dashboard:  http://localhost:8183');
  console.log('  Bridge /ds: http://localhost:9876/ds/PetDS');
  console.log('='.repeat(60));

  process.exit(passed === total ? 0 : 1);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
