#!/usr/bin/env node
/**
 * Playwright-based screenshot of the SC dashboard.
 * Connects to running Chromium via CDP and uses Playwright's full page API
 * (which correctly composites cross-origin iframes).
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const outPath = process.argv[2] || '/tmp/sc-pw.png';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const contexts = browser.contexts();
console.log(`Contexts: ${contexts.length}`);

let targetPage = null;
for (const ctx of contexts) {
  for (const page of ctx.pages()) {
    if (page.url().includes('smartclient-app/wrapper.html')) {
      targetPage = page;
      break;
    }
  }
  if (targetPage) break;
}

if (!targetPage) {
  console.error('SC wrapper page not found in any context.');
  await browser.close();
  process.exit(1);
}

console.log(`Target: ${targetPage.url()}`);

// Full-page screenshot (composites iframes)
const buf = await targetPage.screenshot({ fullPage: true, type: 'png' });
writeFileSync(outPath, buf);
console.log(`Saved ${outPath} (${buf.length} bytes)`);

await browser.close();
