#!/usr/bin/env node
// build-mortgage-skin.mjs
// =============================================================================
// Sync the modern skin CSS from agentidev → sc-mortgage-demo.
//
// Source of truth: packages/forge/skins/modern/{sc-cssz-adapter,theme-modern,
// theme-sunset}.css
// Destination:    SC_MORTGAGE_DEMO_DIR/skin/{same files}
//                 (defaults to ~/repos/sc-mortgage-demo)
//
// Idempotent: re-running with no source changes prints "Already in sync."
// Non-destructive: pure file copy + comparison. Doesn't touch git.
//
//   $ npm run build:mortgage-skin
//
// To target a different deploy clone:
//   $ SC_MORTGAGE_DEMO_DIR=/path/to/sc-mortgage-demo npm run build:mortgage-skin
// =============================================================================
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = resolve(SCRIPT_DIR, '..', 'packages', 'forge', 'skins', 'modern');

// Where the sc-mortgage-demo deploy clone lives. Tries env var first, then
// the in-tree location used today, then the sibling-repo convention.
async function resolveDestRepo() {
  if (process.env.SC_MORTGAGE_DEMO_DIR) return process.env.SC_MORTGAGE_DEMO_DIR;
  const candidates = [
    resolve(SCRIPT_DIR, '..', 'experiments', 'mortgage-calculator', 'dist'),
    resolve(homedir(), 'repos', 'sc-mortgage-demo'),
  ];
  for (const c of candidates) {
    if (await exists(c)) return c;
  }
  return candidates[0]; // first candidate gets the "not found" error message
}

const FILES = ['sc-cssz-adapter.css', 'theme-modern.css', 'theme-sunset.css'];

async function exists(path) {
  try { await stat(path); return true; }
  catch { return false; }
}

async function main() {
  // Validate source dir
  if (!(await exists(SOURCE_DIR))) {
    console.error(`✗ Source not found: ${SOURCE_DIR}`);
    process.exit(1);
  }

  const DEST_REPO = await resolveDestRepo();
  const DEST_DIR = resolve(DEST_REPO, 'skin');

  // Validate destination repo (must be cloned)
  if (!(await exists(DEST_REPO))) {
    console.error(`✗ sc-mortgage-demo repo not found at: ${DEST_REPO}`);
    console.error(`  Clone it first, or set SC_MORTGAGE_DEMO_DIR to your clone path.`);
    process.exit(1);
  }
  if (!(await exists(DEST_DIR))) {
    console.error(`✗ skin/ dir not found at: ${DEST_DIR}`);
    console.error(`  Expected layout: ${DEST_REPO}/skin/{sc-cssz-adapter,theme-modern,theme-sunset}.css`);
    process.exit(1);
  }

  console.log(`Source: ${SOURCE_DIR}`);
  console.log(`Dest:   ${DEST_DIR}\n`);

  let changed = 0;
  for (const f of FILES) {
    const srcPath = resolve(SOURCE_DIR, f);
    const dstPath = resolve(DEST_DIR, f);

    if (!(await exists(srcPath))) {
      console.error(`  ✗ ${f} missing at source`);
      process.exit(1);
    }

    const src = await readFile(srcPath, 'utf8');
    let dst = '';
    try { dst = await readFile(dstPath, 'utf8'); } catch {}

    if (src === dst) {
      console.log(`  = ${f} (in sync)`);
    } else {
      await writeFile(dstPath, src);
      const arrow = dst.length === 0 ? 'created' : `${dst.length} → ${src.length} bytes`;
      console.log(`  → ${f} (${arrow})`);
      changed++;
    }
  }

  if (changed === 0) {
    console.log('\nAlready in sync. Nothing to commit.');
    return;
  }
  console.log(`\n${changed} file(s) updated. Next:`);
  console.log(`  cd ${DEST_REPO}`);
  console.log(`  git diff skin/`);
  console.log(`  git add skin/ && git commit -m '...' && git push`);
}

main().catch((err) => {
  console.error('✗ build-mortgage-skin failed:', err.message);
  process.exit(1);
});
