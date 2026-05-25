#!/usr/bin/env node
/**
 * Expose local Zato to the internet via Cloudflare quick tunnel.
 *
 * Usage:
 *   npm run zato:expose            # uses port 11223
 *   node docker/zato/expose.mjs    # same
 *
 * Prints the trycloudflare.com URL prominently when ready.
 * Ctrl-C to tear down the tunnel — the URL is ephemeral and won't return.
 *
 * Auto-installs cloudflared to ~/bin/cloudflared if missing (Linux x86_64 only).
 * For other platforms, install manually: https://github.com/cloudflare/cloudflared/releases
 */
import { spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { homedir, platform, arch } from 'os';
import { join } from 'path';

const ZATO_PORT = process.env.ZATO_PORT || 11223;
const BIN_DIR = join(homedir(), 'bin');
const BIN = join(BIN_DIR, 'cloudflared');

async function ensureBinary() {
  if (existsSync(BIN)) return BIN;
  if (platform() !== 'linux' || arch() !== 'x64') {
    console.error(`cloudflared not found at ${BIN} and auto-install only supports linux/x64.`);
    console.error('Install manually: https://github.com/cloudflare/cloudflared/releases');
    process.exit(1);
  }
  const url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
  console.log(`Installing cloudflared to ${BIN}...`);
  mkdirSync(BIN_DIR, { recursive: true });
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) {
    console.error(`Download failed: ${resp.status} ${resp.statusText}`);
    process.exit(1);
  }
  writeFileSync(BIN, Buffer.from(await resp.arrayBuffer()));
  chmodSync(BIN, 0o755);
  return BIN;
}

const bin = await ensureBinary();

console.log(`Starting Cloudflare quick tunnel for http://localhost:${ZATO_PORT}...`);
const proc = spawn(bin, ['tunnel', '--url', `http://localhost:${ZATO_PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let urlPrinted = false;
const onChunk = (chunk) => {
  const text = chunk.toString();
  process.stderr.write(text);
  if (urlPrinted) return;
  const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m) {
    urlPrinted = true;
    const url = m[0];
    console.log('\n============================================================');
    console.log('  Zato is now public at:');
    console.log('  ' + url);
    console.log();
    console.log('  Try:');
    console.log(`    curl ${url}/api/pet/findByStatus?status=available`);
    console.log();
    console.log('  Ctrl-C to stop. URL is ephemeral — restarting yields a new one.');
    console.log('============================================================\n');
  }
};
proc.stdout.on('data', onChunk);
proc.stderr.on('data', onChunk);

const shutdown = () => proc.kill('SIGINT');
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
proc.on('exit', (code) => process.exit(code ?? 0));
