/**
 * DuckDuckGo Search — example automation script.
 *
 * Demonstrates: browser launch, navigation, form fill, wait for results,
 * DOM evaluation, checkpoints, progress reporting, and error handling.
 *
 * Uses playwright-shim for bridge integration + named checkpoints.
 */

import { chromium, client } from '../../packages/bridge/playwright-shim.mjs';

const QUERY = 'playwright browser automation';

async function main() {
  client.setActivity('Launching browser...');
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // --- Checkpoint: before navigation ---
  await client.checkpoint('before_navigate', { query: QUERY });

  client.setActivity('Navigating to DuckDuckGo...');
  await page.goto('https://duckduckgo.com');
  await client.progress(1, 5, 'Loaded DuckDuckGo');

  // --- Checkpoint: before search ---
  await client.checkpoint('before_search', { url: page.url() });

  client.setActivity(`Typing search query: "${QUERY}"`);
  await page.fill('input[name="q"]', QUERY);
  await page.press('input[name="q"]', 'Enter');
  await client.progress(2, 5, 'Submitted search');

  // --- Checkpoint: after search ---
  client.setActivity('Waiting for results...');
  await page.waitForSelector('[data-testid="result"]', { timeout: 10000 });
  await client.progress(3, 5, 'Results loaded');
  await client.checkpoint('results_loaded', { url: page.url() });

  // --- Collect results ---
  client.setActivity('Collecting result titles...');
  const titles = await page.evaluate(() => {
    const headings = document.querySelectorAll('[data-testid="result-title-a"] span');
    return [...headings].slice(0, 5).map(h => h.textContent);
  });
  await client.progress(4, 5, `Found ${titles.length} results`);

  // --- Checkpoint: before complete ---
  await client.checkpoint('before_complete', { titles, count: titles.length });

  client.setActivity('Done!');
  await client.progress(5, 5, 'Complete');
  await browser.close();
  await client.complete({ titles, query: QUERY });
}

main().catch(async (err) => {
  console.error('Script error:', err);
  await client.reportError(err.message);
  await client.complete({ error: err.message });
  process.exit(1);
});
