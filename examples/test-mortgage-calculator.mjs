#!/usr/bin/env node
/**
 * Mortgage Calculator end-to-end test.
 *
 * The calculator at sc-mortgage-demo.pages.dev is a STANDALONE web app
 * (not an extension plugin), so Playwright is the right primitive — no
 * sandbox iframe, no extension permissions to navigate.
 *
 * Uses the bridge's playwright-shim so progress/assertions/screenshots
 * surface in the agentidev dashboard's Test Results portlet, AND the
 * SmartClient SDK's `extendPage` helper for AutoTest-locator-based
 * interaction (the documented way to drive SC from Playwright — per
 * AGENTS.md "SmartClient Playwright Testing").
 *
 * Run:
 *   node examples/test-mortgage-calculator.mjs                          # live URL
 *   node examples/test-mortgage-calculator.mjs --url=http://localhost:8765
 *   node examples/test-mortgage-calculator.mjs --headed                  # show browser
 *
 * Coverage:
 *   1. Default load — form fields rendered, status reads "Click Calculate"
 *   2. Calculate — math correctness ($300K loan @ 7% × 30y = $1995.91)
 *   3. Save — URL hash updates, recents row appears
 *   4. Modified state — typing in a field flips status
 *   5. URL restore (live mode #i=) — populates form + recalcs
 *   6. URL restore (snapshot #z=) — populates + shows snapshot banner
 *   7. Share modal — opens with QR + URL + buttons
 *   8. Recents click — restores its inputs
 */

import { chromium, client } from '../packages/bridge/playwright-shim.mjs';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);

// ---- Args ----
const args = process.argv.slice(2);
const argUrl = (args.find((a) => a.startsWith('--url=')) || '').split('=').slice(1).join('=');
const TEST_URL = argUrl || 'https://sc-mortgage-demo.pages.dev/';
const HEADED = args.includes('--headed');

console.log(`Testing: ${TEST_URL}`);

// SmartClient's playwright commands are vendored into our repo so they
// resolve `@playwright/test` from our node_modules. The .cjs extension
// forces CommonJS interpretation. Original source lives at
// $SMARTCLIENT_SDK/tools/playwright/commands.js.
const cmdsPath = new URL('../packages/bridge/vendor/sc-playwright-commands.cjs', import.meta.url).pathname;
if (!existsSync(cmdsPath)) {
  console.error(`SmartClient playwright commands not found at: ${cmdsPath}`);
  process.exit(1);
}
const { extendPage } = require(cmdsPath);

// ---- Encode a scenario the way the page does — proves URL portability ----
async function encodeShared(input, output) {
  const blob = { i: input, t: Date.now(), v: 1 };
  if (output) blob.o = output;
  const json = JSON.stringify(blob);
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = Buffer.from(await new Response(stream).arrayBuffer());
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---- Bootstrap ----
const browser = await chromium.launch({ headless: !HEADED });
const ctx = await browser.newContext();
const page = await ctx.newPage();
extendPage(page);
// scAutoWait off — `isc.AutoTest.waitForSystemDone` never resolves on this
// page (likely a quirk with how the QR-data-URI img triggers SC's busy
// counter). Each test uses explicit waitForTimeout / waitForFunction.
page.configureSC({ scCommandTimeout: 15000, scAutoWait: false, scLogLevel: 'silent' });

await client.checkpoint('start', { url: TEST_URL });

try {
  // ===== Test 1: Default load =====
  await page.goto(TEST_URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof isc !== "undefined" && typeof calcForm !== "undefined", null, { timeout: 15000 });
  await client.checkpoint('loaded');

  const form = await page.getSCObject('//DynamicForm[ID="calcForm"]');
  // page.getSCObject returns an object with .values containing form values
  const initialValues = await page.evaluate(() => calcForm.getValues());
  client.assert(initialValues.principal === 350000, 'principal default is 350000');
  client.assert(initialValues.downPayment === 50000, 'downPayment default is 50000');
  client.assert(initialValues.rate === 7, 'rate default is 7');
  client.assert(initialValues.years === 30, 'years default is 30');

  const initialStatus = await page.evaluate(() => shareStatus.getContents());
  client.assert(/Click Calculate/i.test(initialStatus), 'fresh load shows "Click Calculate" status');
  const initialHash = await page.evaluate(() => location.hash);
  client.assert(initialHash === '', 'fresh load has empty hash (URL doesnt morph)');

  // ===== Test 2: Calculate =====
  await page.clickSC('//Button[ID="btnCalc"]');
  await page.waitForTimeout(150);
  const result1 = await page.evaluate(() => result.getContents());
  client.assert(/\$1,995\.91/.test(result1), 'default calc returns $1,995.91/mo');
  client.assert(/PMI/.test(result1), 'PMI line shown when down < 20%');
  const hashAfterCalc = await page.evaluate(() => location.hash);
  client.assert(hashAfterCalc === '', 'Calculate does NOT touch the URL hash');
  await client.checkpoint('calculated');

  // ===== Test 3: Save =====
  // saveScenario() is async; the SC click handler doesn't await its
  // promise. Wait for the hash to populate as a deterministic signal that
  // the async work (saveRecent + history.replaceState) finished.
  await page.clickSC('//Button[ID="btnSave"]');
  await page.waitForFunction(() => location.hash.length > 50, null, { timeout: 5000 });
  const hashAfterSave = await page.evaluate(() => location.hash);
  client.assert(hashAfterSave.length > 80, `Save populates URL hash (${hashAfterSave.length} chars)`);
  const statusAfterSave = await page.evaluate(() => shareStatus.getContents());
  client.assert(/Saved/.test(statusAfterSave), 'status shows "Saved" after save');
  const recentsCount1 = await page.evaluate(() => getRecents().length);
  client.assert(recentsCount1 === 1, `1 entry in recents (got ${recentsCount1})`);
  const anchorCount = await page.evaluate(() => document.querySelectorAll('a[href^="javascript:location.hash"]').length);
  client.assert(anchorCount === 1, 'recents row rendered as anchor in DOM');
  await client.artifact({
    type: 'screenshot',
    label: 'After Save',
    contentType: 'image/png',
    data: (await page.screenshot()).toString('base64'),
  });
  await client.checkpoint('saved');

  // ===== Test 4: Modified state =====
  // Two assertions, separated:
  //   (a) the change handler is wired (integration check)
  //   (b) value change → status flips to "Modified" (behavior check)
  // We can't reliably use typeSC to drive form items via AutoTest locators
  // (waitForElement is strict about the DOM element it expects), so we
  // verify the wiring statically and exercise behavior via setValue + the
  // same refreshStatus call the change handler would make.
  const changeWired = await page.evaluate(() => {
    const item = calcForm.getItem('rate');
    return typeof (item.change || (item._typeProp && item._typeProp.change)) === 'function';
  });
  client.assert(changeWired, 'rate field has a change handler wired');

  await page.evaluate(() => {
    calcForm.setValue('rate', 6);
    refreshStatus();  // mirror what the change handler does
  });
  const statusAfterEdit = await page.evaluate(() => shareStatus.getContents());
  client.assert(/Modified/.test(statusAfterEdit), 'value change flips status to "Modified"');
  const hashStillSame = await page.evaluate(() => location.hash);
  client.assert(hashStillSame === hashAfterSave, 'hash unchanged on edit (only Save touches URL)');

  // Save again — rate changed so a new label produces a 2nd recent entry.
  // Invoke saveScenario directly so we can AWAIT its async work (the SC
  // button click fires the handler but doesn't await the returned promise).
  await page.evaluate(() => saveScenario());
  const statusReSave = await page.evaluate(() => shareStatus.getContents());
  client.assert(/Saved/.test(statusReSave), 'status returns to "Saved" after re-save');
  const recentsCount2 = await page.evaluate(() => getRecents().length);
  client.assert(recentsCount2 === 2, `rate-changed save adds new entry (2 recents now, got ${recentsCount2})`);
  const newHash = await page.evaluate(() => location.hash);
  client.assert(newHash !== hashAfterSave && newHash.length > 50, 'URL hash updates to new scenario');
  await client.checkpoint('modified-flow');

  // ===== Test 5: Share modal =====
  await page.clickSC('//Button[ID="btnShareSnap"]');
  await page.waitForTimeout(400);  // window animation
  const modal = await page.evaluate(() => {
    const qrImgs = document.querySelectorAll('img[src^="data:image"]');
    const urlInput = document.getElementById('shareUrlInput');
    return {
      qrCount: qrImgs.length,
      qrPx: qrImgs.length ? qrImgs[0].width : 0,
      hasUrlInput: !!urlInput,
      urlValue: urlInput ? urlInput.value : '',
    };
  });
  client.assert(modal.qrCount === 1, 'share modal renders exactly 1 QR image');
  client.assert(modal.qrPx > 100 && modal.qrPx < 300, `QR sized reasonably (${modal.qrPx}px)`);
  client.assert(modal.hasUrlInput, 'share modal has URL input field');
  client.assert(/^https?:.+#z=/.test(modal.urlValue), 'URL is snapshot mode (#z=)');
  client.assert(modal.urlValue.length < 600, `snapshot URL is QR-safe < 600 chars (${modal.urlValue.length})`);
  await client.artifact({
    type: 'screenshot',
    label: 'Share modal with QR',
    contentType: 'image/png',
    data: (await page.screenshot()).toString('base64'),
  });
  // Dismiss modal
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await client.checkpoint('share-modal');

  // ===== Test 6: URL restore — live mode (#i=) =====
  // External-encoded URL proves portability; matches what the page emits.
  const liveInput = { principal: 500000, downPayment: 100000, rate: 6.25, years: 15 };
  const liveHash = await encodeShared(liveInput);
  await page.goto(TEST_URL + '#i=' + liveHash, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof isc !== "undefined" && typeof calcForm !== "undefined", null, { timeout: 15000 });
  await page.waitForFunction(() => calcForm.getValue('principal') === 500000, { timeout: 5000 });
  const liveRestored = await page.evaluate(() => calcForm.getValues());
  client.assert(liveRestored.principal === 500000, 'live URL restored principal');
  client.assert(liveRestored.rate === 6.25, 'live URL restored rate');
  client.assert(liveRestored.years === 15, 'live URL restored years');
  // P=400000, rate=6.25/100/12, n=180 → $3,429.69
  const liveResult = await page.evaluate(() => result.getContents());
  client.assert(/\$3,429\.69/.test(liveResult), 'live URL recomputed monthly correctly ($3,429.69)');
  const liveStatus = await page.evaluate(() => shareStatus.getContents());
  client.assert(/Saved/.test(liveStatus), 'restored URL is the "Saved" baseline');
  await client.checkpoint('live-restore');

  // ===== Test 7: URL restore — snapshot mode (#z=) =====
  const snapInput = { principal: 250000, downPayment: 50000, rate: 5, years: 20 };
  const snapOutput = { monthly: 1319.91, total: 316778, interest: 116778, pmi: 0 };
  const snapHash = await encodeShared(snapInput, snapOutput);
  await page.goto(TEST_URL + '#z=' + snapHash, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof isc !== "undefined" && typeof calcForm !== "undefined", null, { timeout: 15000 });
  await page.waitForFunction(() => calcForm.getValue('principal') === 250000, { timeout: 5000 });
  const snapBannerVisible = await page.evaluate(() =>
    snapshotBanner.isVisible() && snapshotBanner.getContents().includes('Snapshot'));
  client.assert(snapBannerVisible, 'snapshot URL shows the snapshot banner');
  const snapBannerText = await page.evaluate(() => snapshotBanner.getContents());
  client.assert(/Sender's monthly was/.test(snapBannerText), 'banner shows captured monthly');
  await client.artifact({
    type: 'screenshot',
    label: 'Snapshot URL restored',
    contentType: 'image/png',
    data: (await page.screenshot()).toString('base64'),
  });
  await client.checkpoint('snapshot-restore');

  // ===== Test 8: Recents → restore =====
  // Recents persist in localStorage across navigations (same origin). The
  // store has Test 3's $350K@7% and Test 4's $350K@6% saves. Form is
  // currently at $250K (from Test 7's snapshot URL). Drive the same data
  // path the anchor click triggers: set location.hash to the saved entry,
  // hashchange listener fires, restoreFromHash populates the form.
  const recentsBefore = await page.evaluate(() => {
    const all = getRecents();
    return { count: all.length, labels: all.map((r) => r.label) };
  });
  client.assert(recentsBefore.count >= 2,
    `recents persist across navigation (${recentsBefore.count} entries: ${JSON.stringify(recentsBefore.labels)})`);

  await page.evaluate(() => {
    const target = getRecents().find((r) => r.label.includes('$350,000 @ 7%'));
    if (target) location.hash = 'i=' + target.hash;
  });
  await page.waitForFunction(() => calcForm.getValue('principal') === 350000, { timeout: 5000 });
  const afterClick = await page.evaluate(() => calcForm.getValues());
  client.assert(afterClick.principal === 350000, 'restored principal from recent');
  client.assert(afterClick.rate === 7, 'restored rate from recent');
  await client.checkpoint('recents-click');

  // ===== Wrap up =====
  const exitCode = client.summarize();
  await client.complete({ assertions: client.getAssertionSummary() });
  await browser.close();
  process.exit(exitCode);

} catch (err) {
  console.error('Test failed:', err.message);
  console.error(err.stack);
  client.assert(false, 'Unexpected error: ' + err.message);
  client.summarize();
  await client.complete({ assertions: client.getAssertionSummary() }).catch(() => {});
  await browser.close().catch(() => {});
  process.exit(1);
}
