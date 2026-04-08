#!/usr/bin/env node
/**
 * Dashboard Screenshot Tool
 *
 * Connects to the running browser via Chrome DevTools Protocol (CDP)
 * and captures a screenshot of the dashboard page.
 *
 * Requires: browser launched with --remote-debugging-port=9222
 *
 * Usage:
 *   node bridge/dashboard-screenshot.mjs                    # save to /tmp/dashboard.png
 *   node bridge/dashboard-screenshot.mjs /path/to/file.png  # save to specific path
 *   node bridge/dashboard-screenshot.mjs --list             # list available pages
 */

import { get } from 'http';
import { writeFileSync } from 'fs';
import WebSocket from 'ws';

const CDP_PORT = 9222;
const DEFAULT_OUTPUT = '/tmp/dashboard.png';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON from ${url}`)); }
      });
    }).on('error', reject);
  });
}

function cdpCommand(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('CDP command timed out'));
    }, 10000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id === 1) {
        clearTimeout(timer);
        ws.close();
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function listPages() {
  const targets = await httpGet(`http://localhost:${CDP_PORT}/json`);
  console.log('Available pages:');
  for (const t of targets) {
    if (t.type === 'page') {
      console.log(`  [${t.type}] ${t.title || '(no title)'}`);
      console.log(`    URL: ${t.url}`);
    }
  }
  return targets;
}

async function findDashboard() {
  const targets = await httpGet(`http://localhost:${CDP_PORT}/json`);
  // Look for dashboard page
  const dashboard = targets.find(t =>
    t.type === 'page' && t.url.includes('dashboard/dashboard.html')
  );
  if (!dashboard) {
    // Fall back to any extension page
    const extPage = targets.find(t =>
      t.type === 'page' && t.url.startsWith('chrome-extension://')
    );
    if (extPage) return extPage;
    // Fall back to first page
    const firstPage = targets.find(t => t.type === 'page');
    if (firstPage) return firstPage;
    throw new Error('No page targets found. Is the browser running with --remote-debugging-port=9222?');
  }
  return dashboard;
}

async function screenshot(outputPath) {
  const target = await findDashboard();
  console.log(`[Screenshot] Target: ${target.title || target.url}`);

  const wsUrl = target.webSocketDebuggerUrl;
  if (!wsUrl) {
    throw new Error('Target has no webSocketDebuggerUrl. It may already be attached by DevTools.');
  }

  const result = await cdpCommand(wsUrl, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  });

  const buf = Buffer.from(result.data, 'base64');
  writeFileSync(outputPath, buf);
  console.log(`[Screenshot] Saved ${buf.length} bytes to ${outputPath}`);
  return outputPath;
}

// ─── CLI ───
const args = process.argv.slice(2);

if (args.includes('--list')) {
  await listPages();
} else {
  const output = args[0] || DEFAULT_OUTPUT;
  try {
    await screenshot(output);
  } catch (err) {
    console.error(`[Screenshot] Error: ${err.message}`);
    process.exit(1);
  }
}
