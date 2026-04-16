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
  console.log('   OK — bundled SmartClient runtime found (LGPL v3)');
} else {
  console.log('   NOT FOUND — SmartClient dashboard will not work.');
  console.log('   The bundled runtime should be in extension/smartclient/ after clone.');
  console.log('   If missing, re-clone or check that git LFS (if configured) has pulled the files.');
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

// ---- 4. Playwright browsers ----

console.log('\n4. Playwright browsers');
try {
  // Check if playwright-cli is available
  const cliVersion = execSync('npx @playwright/cli --version 2>&1', { encoding: 'utf8', cwd: ROOT, shell: true }).trim();
  console.log('   playwright-cli:', cliVersion);
} catch {
  console.log('   playwright-cli not found — installing @playwright/cli...');
  try {
    execSync('npm install @playwright/cli', { cwd: ROOT, stdio: 'inherit', shell: true });
  } catch {
    console.error('   FAILED — install manually: npm install @playwright/cli');
  }
}

// Install Chromium browser (needed for sessions and automation)
console.log('   Checking Chromium browser...');
try {
  const installOutput = execSync('npx playwright install chromium 2>&1', {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 120000,
    shell: true,
  }).trim();
  if (installOutput.includes('already installed') || installOutput.includes('downloaded')) {
    console.log('   OK — Chromium installed');
  } else {
    console.log('   Chromium install output:', installOutput.substring(0, 200));
  }
} catch (err) {
  const msg = err.stdout || err.stderr || err.message || '';
  if (msg.includes('already') || msg.includes('Downloading')) {
    console.log('   OK — Chromium installed');
  } else {
    console.warn('   WARNING — Chromium install may have failed:', msg.substring(0, 200));
    console.log('   Run manually: npx playwright install chromium');
  }
}

// Verify playwright-cli can open a session
console.log('   Verifying playwright-cli works...');
try {
  const listOutput = execSync('npx @playwright/cli list 2>&1', {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 15000,
    shell: true,
  });
  if (listOutput.includes('Browsers')) {
    console.log('   OK — playwright-cli is functional');
  } else {
    console.log('   playwright-cli list output:', listOutput.substring(0, 200));
  }
} catch (err) {
  console.warn('   WARNING — playwright-cli list failed:', (err.message || '').substring(0, 200));
}

// ---- 5. Bridge server test ----

console.log('\n5. Bridge server');
try {
  // Just check if the server script exists and is parseable
  const serverPath = resolve(ROOT, 'packages', 'bridge', 'server.mjs');
  if (existsSync(serverPath)) {
    console.log('   OK — server.mjs found');
    console.log('   Start with: npm run bridge');
    console.log('   Launch browser with: npm run browser');
  } else {
    console.log('   NOT FOUND — packages/bridge/server.mjs missing');
  }
} catch {
  console.log('   Check failed');
}

// ---- Summary ----

console.log('\n' + '='.repeat(40));
console.log('Setup complete.\n');
console.log('To load the extension:');
console.log('  1. Open chrome://extensions (or edge://extensions)');
console.log('  2. Enable Developer Mode');
console.log('  3. Click "Load unpacked" and select the extension/ directory');
console.log('');
console.log('To start the automation stack:');
console.log('  1. npm run bridge          # start bridge server (port 9876)');
console.log('  2. npm run browser         # launch Chromium with extension');
console.log('  3. Open the SC Dashboard from the extension');
console.log('');
if (!existsSync(scCheck)) {
  console.log('NOTE: SmartClient SDK not found — the dashboard tab will not work.');
  console.log('The sidepanel, memory, and capture features work without it.');
}
console.log('');
