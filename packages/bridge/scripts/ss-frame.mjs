#!/usr/bin/env node
/**
 * Try Playwright frame screenshot — screenshot the SC sandbox iframe via
 * page.frames() + element locator on html.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const outPath = process.argv[2] || '/tmp/sc-frame.png';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const contexts = browser.contexts();

let wrapperPage = null;
for (const ctx of contexts) {
  for (const page of ctx.pages()) {
    if (page.url().includes('smartclient-app/wrapper.html')) {
      wrapperPage = page;
      break;
    }
  }
  if (wrapperPage) break;
}

if (!wrapperPage) { console.error('no wrapper'); process.exit(1); }

console.log(`Frames in wrapper: ${wrapperPage.frames().length}`);
for (const f of wrapperPage.frames()) {
  console.log(`  frame: ${f.url().slice(0, 100)}`);
}

// Try to locate the iframe element in the wrapper and screenshot it
try {
  const iframeEl = await wrapperPage.locator('iframe').first();
  const box = await iframeEl.boundingBox();
  console.log(`iframe bbox: ${JSON.stringify(box)}`);
  const buf = await iframeEl.screenshot({ type: 'png' });
  writeFileSync(outPath, buf);
  console.log(`Saved ${outPath} (${buf.length} bytes)`);
} catch (e) {
  console.error(`iframe screenshot failed: ${e.message}`);
}

await browser.close();
