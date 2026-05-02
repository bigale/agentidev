#!/usr/bin/env node
// Run a PocketFlow flow with the vendored pocketflow on PYTHONPATH.
//
// Usage:
//   node packages/bridge/scripts/run-flow.mjs <flow_file> [shared_json]
//
// If shared_json is omitted, reads from stdin (or sends empty {} on a TTY).
// Final shared state is printed to stdout as JSON.
//
// Exit codes:
//   0 — flow completed
//   1 — usage error
//   2 — flow not found
//   3 — flow raised an exception

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const VENDOR_DIR = resolve(REPO_ROOT, 'packages/bridge/vendor');

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: run-flow.mjs <flow_file> [shared_json]');
  process.exit(1);
}

const flowPath = resolve(args[0]);
if (!existsSync(flowPath)) {
  console.error(`Flow not found: ${flowPath}`);
  process.exit(2);
}

const sharedJson = args[1];

// PYTHONPATH points at the vendor dir so `from pocketflow import ...` resolves.
const env = {
  ...process.env,
  PYTHONPATH: VENDOR_DIR + (process.env.PYTHONPATH ? `:${process.env.PYTHONPATH}` : ''),
};

const child = spawn('python3', [flowPath], {
  env,
  stdio: ['pipe', 'inherit', 'inherit'],
});

if (sharedJson !== undefined) {
  child.stdin.write(sharedJson);
  child.stdin.end();
} else if (process.stdin.isTTY) {
  // No piped stdin and no arg — flow gets empty {} per its own handling
  child.stdin.end();
} else {
  process.stdin.pipe(child.stdin);
}

child.on('exit', (code) => {
  process.exit(code === null ? 3 : code);
});

child.on('error', (err) => {
  console.error(`spawn failed: ${err.message}`);
  process.exit(3);
});
