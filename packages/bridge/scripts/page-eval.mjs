#!/usr/bin/env node
/**
 * Evaluate JS in a specific extension page matched by URL substring.
 * Uses Playwright connectOverCDP for clean frame targeting.
 *
 * Usage:
 *   node packages/bridge/scripts/page-eval.mjs <url-substring> '<expr>'
 *   node packages/bridge/scripts/page-eval.mjs spike.html 'document.body.innerText'
 */
import { chromium } from 'playwright';

const urlHint = process.argv[2];
const expr = process.argv[3];
if (!urlHint || !expr) {
  console.error('usage: page-eval.mjs <url-substring> <expr>');
  process.exit(1);
}

const browser = await chromium.connectOverCDP('http://localhost:9222');
try {
  let page = null;
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (p.url().includes(urlHint)) { page = p; break; }
    }
    if (page) break;
  }
  if (!page) { console.error(`no page matching "${urlHint}"`); process.exit(1); }
  console.log('Target:', page.url());
  const result = await page.evaluate(expr);
  console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result));
} finally {
  await browser.close();
}
