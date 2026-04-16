#!/usr/bin/env node
/**
 * Agentidev setup script — run after cloning to set up dependencies.
 *
 * Usage: node scripts/setup.mjs
 *
 * What it does:
 *   1. Creates extension/lib/agentiface -> packages/forge (symlink or junction)
 *   2. Checks for SmartClient SDK at extension/smartclient/
 *   3. Installs npm dependencies
 */

import { existsSync, lstatSync, symlinkSync, mkdirSync, readlinkSync, unlinkSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { platform } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const isWindows = platform() === 'win32';
console.log(`\nAgentidev Setup (${platform()})`);
console.log('='.repeat(40));

// ---- 1. Forge symlink/junction ----

const forgeTarget = resolve(ROOT, 'packages', 'forge');
const forgeLink = resolve(ROOT, 'extension', 'lib', 'agentiface');

console.log('\n1. Forge toolkit (extension/lib/agentiface)');

if (existsSync(forgeTarget)) {
  let needsLink = true;

  if (existsSync(forgeLink)) {
    try {
      const stat = lstatSync(forgeLink);
      if (stat.isSymbolicLink() || stat.isDirectory()) {
        // Check if it's a working symlink
        const themeManager = join(forgeLink, 'theme-manager.js');
        if (existsSync(themeManager)) {
          console.log('   OK — already linked and working');
          needsLink = false;
        } else {
          console.log('   Broken link — removing and recreating');
          try { unlinkSync(forgeLink); } catch { /* ignore */ }
        }
      } else {
        // Might be a text file (broken symlink on Windows without Developer Mode)
        console.log('   Broken symlink file — removing and recreating');
        try { unlinkSync(forgeLink); } catch { /* ignore */ }
      }
    } catch {
      // Link doesn't resolve
      try { unlinkSync(forgeLink); } catch { /* ignore */ }
    }
  }

  if (needsLink) {
    try {
      if (isWindows) {
        // Use junction on Windows (doesn't require admin/Developer Mode)
        execSync(`mklink /J "${forgeLink}" "${forgeTarget}"`, { stdio: 'pipe', shell: true });
        console.log('   Created junction: extension/lib/agentiface -> packages/forge');
      } else {
        // Relative symlink on Linux/macOS
        symlinkSync('../../packages/forge', forgeLink);
        console.log('   Created symlink: extension/lib/agentiface -> ../../packages/forge');
      }
    } catch (err) {
      console.error('   FAILED:', err.message);
      if (isWindows) {
        console.error('   Try running as Administrator, or enable Developer Mode in Windows Settings');
      }
    }
  }
} else {
  console.log('   SKIP — packages/forge not found (npm install first?)');
}

// ---- 2. SmartClient SDK ----

const scDir = resolve(ROOT, 'extension', 'smartclient');
const scCheck = join(scDir, 'system', 'modules', 'ISC_Core.js');

console.log('\n2. SmartClient SDK (extension/smartclient)');

if (existsSync(scCheck)) {
  console.log('   OK — SmartClient SDK found');
} else if (existsSync(scDir) && lstatSync(scDir).isSymbolicLink()) {
  const target = readlinkSync(scDir);
  console.log(`   WARNING — symlink exists but target not found: ${target}`);
  console.log('   The SmartClient dashboard will not work without the SDK.');
  console.log('   Download the LGPL runtime from https://www.smartclient.com/product/download.jsp');
  console.log('   Then either:');
  if (isWindows) {
    console.log(`     mklink /J extension\\smartclient C:\\path\\to\\SmartClient\\smartclientRuntime\\isomorphic`);
  } else {
    console.log(`     ln -s /path/to/SmartClient/smartclientRuntime/isomorphic extension/smartclient`);
  }
} else {
  console.log('   NOT FOUND — SmartClient dashboard will not work.');
  console.log('   The core extension (sidepanel, capture, memory) works without it.');
  console.log('');
  console.log('   To enable the dashboard, download the LGPL runtime:');
  console.log('     https://www.smartclient.com/product/download.jsp');
  console.log('   Then link it:');
  if (isWindows) {
    console.log(`     mklink /J extension\\smartclient C:\\path\\to\\smartclientRuntime\\isomorphic`);
  } else {
    console.log(`     ln -s /path/to/smartclientRuntime/isomorphic extension/smartclient`);
  }
}

// ---- 3. npm dependencies ----

console.log('\n3. npm dependencies');
const nodeModules = resolve(ROOT, 'node_modules');
if (existsSync(nodeModules)) {
  console.log('   OK — node_modules exists');
} else {
  console.log('   Running npm install...');
  try {
    execSync('npm install', { cwd: ROOT, stdio: 'inherit' });
    console.log('   OK — npm install complete');
  } catch {
    console.error('   FAILED — run npm install manually');
  }
}

// ---- Summary ----

console.log('\n' + '='.repeat(40));
console.log('Setup complete.\n');
console.log('To load the extension:');
console.log('  1. Open chrome://extensions (or edge://extensions)');
console.log('  2. Enable Developer Mode');
console.log('  3. Click "Load unpacked" and select the extension/ directory');
console.log('');
if (!existsSync(scCheck)) {
  console.log('NOTE: SmartClient SDK not found — the dashboard tab will not work.');
  console.log('The sidepanel, memory, and capture features work without it.');
}
console.log('');
