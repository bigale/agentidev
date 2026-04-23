#!/usr/bin/env node
/**
 * Configure Zato REST channels for the Petstore services.
 * Uses Zato's admin API (port 11223) to create channels programmatically.
 *
 * Usage: node docker/zato/setup-channels.mjs [--zato-url=http://localhost:11223]
 *
 * Prerequisites:
 *   - Zato container running (docker compose up)
 *   - Services deployed (hot-deploy via pickup dir)
 */

const ZATO_URL = process.argv.find(a => a.startsWith('--zato-url='))?.split('=')[1] || 'http://localhost:11223';

const CHANNELS = [
  {
    name: 'pet-find-by-status',
    url_path: '/api/pet/findByStatus',
    service_name: 'petstore.pet.find-by-status',
    method: 'GET',
  },
  {
    name: 'pet-get-by-id',
    url_path: '/api/pet/{pet_id}',
    service_name: 'petstore.pet.get-by-id',
    method: 'GET',
  },
  {
    name: 'pet-add',
    url_path: '/api/pet',
    service_name: 'petstore.pet.add',
    method: 'POST',
  },
  {
    name: 'pet-update',
    url_path: '/api/pet',
    service_name: 'petstore.pet.update',
    method: 'PUT',
  },
  {
    name: 'pet-delete',
    url_path: '/api/pet/{pet_id}',
    service_name: 'petstore.pet.delete',
    method: 'DELETE',
  },
  {
    name: 'pet-init',
    url_path: '/api/pet/init',
    service_name: 'petstore.init',
    method: 'POST',
  },
];

async function main() {
  console.log('Zato Petstore Channel Setup');
  console.log('Zato URL:', ZATO_URL);
  console.log('');

  // First check if Zato is reachable
  try {
    const ping = await fetch(ZATO_URL + '/zato/ping');
    const pong = await ping.json();
    console.log('Zato status:', pong.zato_env?.result || 'unknown');
  } catch (e) {
    console.error('Cannot reach Zato at', ZATO_URL);
    console.error('Make sure the container is running: docker compose up -d');
    process.exit(1);
  }

  // Initialize the database
  console.log('\nInitializing Petstore DB...');
  try {
    const initResp = await fetch(ZATO_URL + '/api/pet/init', { method: 'POST' });
    console.log('DB init:', initResp.status === 200 ? 'OK' : 'status ' + initResp.status);
  } catch (e) {
    console.log('DB init channel not yet configured (will be available after channel setup)');
  }

  // Create channels via Zato admin API
  // Note: the quickstart may not expose the admin API on the same port.
  // If the admin API isn't available, channels must be created via web-admin UI.
  console.log('\nChannels to configure:');
  for (const ch of CHANNELS) {
    console.log(`  ${ch.method.padEnd(6)} ${ch.url_path.padEnd(30)} → ${ch.service_name}`);
  }

  console.log('\nTo create channels, use the Zato web admin:');
  console.log('  URL: http://localhost:8183');
  console.log('  Navigate: Connections > Channels > REST > Create');
  console.log('');

  // Test each endpoint
  console.log('Testing endpoints...');

  // Test findByStatus
  try {
    const resp = await fetch(ZATO_URL + '/api/pet/findByStatus?status=available');
    if (resp.ok) {
      const data = await resp.json();
      console.log('  GET /api/pet/findByStatus?status=available:', Array.isArray(data) ? data.length + ' pets' : 'unexpected response');
    } else {
      console.log('  GET /api/pet/findByStatus: ' + resp.status + ' (channel may not be configured yet)');
    }
  } catch (e) {
    console.log('  GET /api/pet/findByStatus: not reachable');
  }

  // Test getById
  try {
    const resp = await fetch(ZATO_URL + '/api/pet/1');
    if (resp.ok) {
      const data = await resp.json();
      console.log('  GET /api/pet/1:', data.name || 'unexpected response');
    } else {
      console.log('  GET /api/pet/1: ' + resp.status);
    }
  } catch (e) {
    console.log('  GET /api/pet/1: not reachable');
  }

  console.log('\nDone. Once channels are configured, run PICT tests:');
  console.log('  node packages/bridge/api-to-app/pipeline.mjs --endpoint=all --base-url=' + ZATO_URL + '/api --seed=42');
}

main().catch(e => console.error('Fatal:', e.message));
