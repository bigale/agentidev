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
  // Fields are type:"text" so values are strings; calculate() parses to numbers.
  client.assert(String(initialValues.principal) === '350000', 'principal default is 350000');
  client.assert(String(initialValues.downPayment) === '50000', 'downPayment default is 50000');
  client.assert(String(initialValues.rate) === '7', 'rate default is 7');
  client.assert(String(initialValues.years) === '30', 'years default is 30');

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
  // Save▾ split-button: open menu, expect 1 row matching the just-saved scenario.
  await page.evaluate(() => openSavesMenu(btnSavesMenu));
  await page.waitForTimeout(150);
  const menuRowCount = await page.evaluate(() =>
    document.querySelectorAll('#savesMenu .cssz-saves-menu-row').length);
  client.assert(menuRowCount === 1, `Save▾ menu shows 1 row after save (got ${menuRowCount})`);
  await page.evaluate(() => { document.getElementById('savesMenu').style.display = 'none'; });
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
  // Field uses `changed` (fires after value commit) not `change` (per-keystroke).
  const changeWired = await page.evaluate(() => {
    const item = calcForm.getItem('rate');
    return typeof (item.changed || item.change) === 'function';
  });
  client.assert(changeWired, 'rate field has a changed/change handler wired');

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

  // ===== Test 8: Save▾ menu → restore (real menu click) =====
  // Saves persist in localStorage across navigations (same origin). The
  // store has Test 3's $350K@7% and Test 4's $350K@6% saves. Form is
  // currently at $250K (from Test 7's snapshot URL). The Save▾ split-button
  // dropdown replaces the old bottom "Your saves" row (2026-05-02). CLICKING
  // the menu row (vs setting location.hash via evaluate) is what catches the
  // dispatcher / event-handler regressions.
  const recentsBefore = await page.evaluate(() => {
    const all = getRecents();
    return { count: all.length, labels: all.map((r) => r.label) };
  });
  client.assert(recentsBefore.count >= 2,
    `recents persist across navigation (${recentsBefore.count} entries: ${JSON.stringify(recentsBefore.labels)})`);

  // Open Save▾ menu, find the row whose label contains $350,000 @ 7%, click it.
  await page.evaluate(() => openSavesMenu(btnSavesMenu));
  await page.waitForTimeout(150);
  const targetLabel = '$350,000 @ 7%';
  const targetMenuRow = await page.evaluateHandle((label) => {
    const rows = Array.from(document.querySelectorAll('#savesMenu .cssz-saves-menu-row'));
    return rows.find((r) => r.textContent.includes(label)) || null;
  }, targetLabel);
  client.assert(await targetMenuRow.evaluate((a) => !!a), `Save▾ menu row for "${targetLabel}" present`);
  await targetMenuRow.asElement().click();
  await page.waitForTimeout(300);

  // Page must still have its layout (no navigation regression).
  const stillRendered = await page.evaluate(() => !!isc.AutoTest.getObject('//VLayout[ID="root"]'));
  client.assert(stillRendered, 'page survives menu row click');

  await page.waitForFunction(() => calcForm.getValue('principal') == 350000, { timeout: 5000 });
  const afterClick = await page.evaluate(() => calcForm.getValues());
  client.assert(String(afterClick.principal) === '350000', 'restored principal from menu row');
  client.assert(String(afterClick.rate) === '7', 'restored rate from menu row');
  await client.checkpoint('recents-click');

  // ===== Test 9: Regression — real user typing must reach the model =====
  // Locks in the ISC_DataBinding fix. If DataBinding is dropped from the
  // bundle, SC's form change handler throws silently on every keystroke,
  // input reverts on blur, and Save captures the OLD value — exactly the
  // user-reported "edits don't take" bug.
  //
  // Strategy: navigate to a clean URL, type a fresh value via real
  // keyboard events, click Save, verify the URL hash encodes the typed
  // value (not the default).
  await page.goto(TEST_URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof calcForm !== 'undefined', null, { timeout: 10000 });

  await page.locator('input[name="principal"]').click({ clickCount: 3 });
  await page.keyboard.type('425000', { delay: 30 });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);

  // Both the DOM AND the SC model should now show 425000.
  const typedState = await page.evaluate(() => ({
    inputVal: document.querySelector('input[name="principal"]').value,
    scVal: calcForm.getValue('principal'),
  }));
  client.assert(typedState.inputVal === '425000',
    `DOM input shows typed value ('${typedState.inputVal}')`);
  client.assert(String(typedState.scVal) === '425000',
    `SC model received typed value ('${typedState.scVal}') — fails if ISC_DataBinding missing`);

  // Click Calculate then Save; the URL hash should encode 425000.
  await page.clickSC('//Button[ID="btnCalc"]');
  await page.waitForTimeout(150);
  await page.evaluate(() => saveScenario());
  const recents9 = await page.evaluate(() => getRecents());
  const newest = recents9[0];
  client.assert(newest && newest.label.includes('$425,000'),
    `Save captured the typed principal ('${newest && newest.label}')`);
  await client.checkpoint('typing-regression');

  // ===== Test 10: Archetype picker — click first archetype card =====
  // Verifies the bundle exposes archetypes and the picker click handler
  // populates the form with the archetype's converted-to-4-input shape +
  // displayedRate. Per spec docs/contexts/mortgage/specs/archetype-picker.md.
  await page.goto(TEST_URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof calcForm !== 'undefined' && window.MortgageBundle, null, { timeout: 10000 });

  // Bundle exposes 6 archetypes
  const bundleArchetypes = await page.evaluate(() => window.MortgageBundle.archetypes);
  client.assert(Array.isArray(bundleArchetypes) && bundleArchetypes.length === 6,
    `MortgageBundle.archetypes has 6 entries (got ${bundleArchetypes && bundleArchetypes.length})`);

  // First archetype is first-time-buyer-fha
  const first = bundleArchetypes[0];
  client.assert(first.id === 'first-time-buyer-fha',
    `first archetype is first-time-buyer-fha (got ${first && first.id})`);

  // Picker DOM has the Common Scenarios header. The "Your saves" header was
  // removed when saves moved into the Save▾ split-button dropdown (2026-05-02).
  const subsections = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('div')).map(d => d.textContent || '');
    return {
      hasCommonHeader: labels.some(t => t.trim() === 'Common scenarios'),
      hasSaveDropdownButton: !!document.querySelector('[eventproxy="btnSavesMenu"]'),
    };
  });
  client.assert(subsections.hasCommonHeader, 'Common scenarios subsection rendered');
  client.assert(subsections.hasSaveDropdownButton, 'Save▾ dropdown button rendered');

  // Click handler: invoke loadArchetype directly (the click dispatcher).
  // This avoids hunting for the right anchor element + simulates the same
  // path a real click takes.
  await page.evaluate(() => loadArchetype('first-time-buyer-fha'));
  await page.waitForTimeout(400);  // hashchange → restoreFromHash → recalc

  // Form populated with the archetype's converted shape
  const afterArchetype = await page.evaluate(() => calcForm.getValues());
  client.assert(String(afterArchetype.principal) === '200000',
    `archetype loaded principal ('${afterArchetype.principal}' from $200K starter home)`);
  client.assert(String(afterArchetype.downPayment) === '7000',
    `archetype loaded downPayment ('${afterArchetype.downPayment}' from 3.5% × $200K)`);
  client.assert(String(afterArchetype.years) === '30',
    `archetype loaded years ('${afterArchetype.years}')`);

  // displayedRate flows into the rate field. For First-time Buyer (FHA, Good
  // credit, 96.5% LTV, 30y, Current env): 6.5 base + 0 (30y) - 0.25 (FHA)
  // + 0.25 (Good) + 0.25 (LTV>95) = 6.75%.
  client.assert(String(afterArchetype.rate) === '6.75',
    `archetype displayedRate flows to rate field ('${afterArchetype.rate}', expected 6.75 for First-time Buyer FHA)`);

  // Result panel shows the archetype's monthly P&I. $193,000 loan @ 6.75% × 30y
  // = $1,251.79 (exact via standard amortization formula). Match $1,251.XX
  // pattern in the result panel HTML.
  const resultText = await page.evaluate(() => result.getContents());
  client.assert(/\$1,251\.\d{2}/.test(resultText),
    `result panel shows archetype monthly ($1,251.XX expected)`);
  await client.checkpoint('archetype-click');

  // ===== Test 11: Calc Layout v2 =====
  // Verifies the layout reorg shipped:
  // - composition chart removed (no #amortChart element)
  // - balance chart has 3 line series (cumulative chart)
  // - Details section exists, default closed; expanding shows income input
  //   + grouped grid; income change updates DTI in real time
  // - Picker is side-by-side with form on desktop (isHandset=false)
  // Per spec docs/contexts/mortgage/specs/calc-layout-v2.md.
  await page.goto(TEST_URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof isc !== 'undefined' && window.MortgageBundle, null, { timeout: 10000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => recalc());
  await page.waitForTimeout(400);

  // Composition chart gone
  const noCompositionChart = await page.evaluate(() => !document.getElementById('amortChart'));
  client.assert(noCompositionChart, 'composition chart (#amortChart) removed');

  // Balance chart now has 3 line paths (balance, cum-principal, cum-interest)
  const balanceLineCount = await page.evaluate(() => {
    const host = document.getElementById('balanceChartHost');
    if (!host) return 0;
    return host.querySelectorAll('path[class*="balance-line"], path[class*="cum-principal"], path[class*="cum-interest"]').length;
  });
  client.assert(balanceLineCount === 3,
    `balance chart has 3 line series (got ${balanceLineCount})`);

  // Details section exists; default closed
  const detailsClosed = await page.evaluate(() => !exploreStack.sectionIsExpanded('section_details'));
  client.assert(detailsClosed, 'Details section default closed');

  // Expand Details → income input + DTI row appear
  await page.evaluate(() => {
    exploreStack.expandSection('section_details');
    setupDetailsIncome();
    renderDetails(getInput());
  });
  await page.waitForTimeout(300);

  const detailsState = await page.evaluate(() => ({
    incomeValue: document.getElementById('incomeInput')?.value,
    hasLoanGroup: document.querySelector('.cssz-details-section-title')?.textContent === 'Loan',
    hasDTIRow: Array.from(document.querySelectorAll('.cssz-details-row span')).some(s => s.textContent.trim() === 'DTI'),
  }));
  client.assert(detailsState.incomeValue === '65000',
    `income input default $65,000 (got '${detailsState.incomeValue}')`);
  client.assert(detailsState.hasLoanGroup, 'Details first group is "Loan"');
  client.assert(detailsState.hasDTIRow, 'Details Borrower group has DTI row');

  // Change income → DTI updates
  const dtiBefore = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.cssz-details-row'));
    const dtiRow = rows.find(r => r.textContent.includes('DTI'));
    return dtiRow?.querySelector('.cssz-details-val')?.textContent;
  });
  await page.evaluate(() => onIncomeChange(150000));
  await page.waitForTimeout(300);
  const dtiAfter = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.cssz-details-row'));
    const dtiRow = rows.find(r => r.textContent.includes('DTI'));
    return dtiRow?.querySelector('.cssz-details-val')?.textContent;
  });
  client.assert(dtiBefore !== dtiAfter,
    `DTI updates when income changes ('${dtiBefore}' → '${dtiAfter}')`);

  // Picker side-by-side with form on desktop. archetypesList is one widget;
  // the form column is in the same HLayout.
  const layoutCheck = await page.evaluate(() => {
    const archetypesEl = document.querySelector('[eventproxy="archetypesList"]');
    const formEl = document.querySelector('[eventproxy="calcForm"]');
    if (!archetypesEl || !formEl) return null;
    const archRect = archetypesEl.getBoundingClientRect();
    const formRect = formEl.getBoundingClientRect();
    return {
      archX: archRect.x,
      formX: formRect.x,
      archIsRightOfForm: archRect.x > formRect.x + formRect.width / 2,
    };
  });
  client.assert(layoutCheck && layoutCheck.archIsRightOfForm,
    `picker is side-by-side right of form (formX=${layoutCheck?.formX}, archX=${layoutCheck?.archX})`);
  await client.checkpoint('layout-v2');

  // ===== Test 12: Form Expansion =====
  // Verifies the 3 advanced fields (loan_type / credit_tier / occupancy) ship:
  // - "Show advanced options" toggle present + initially hidden form
  // - Click toggle → advancedForm visible with 3 SelectItems
  // - Switching loan_type to FHA shifts the displayed rate (FHA -0.5%)
  // - Switching credit_tier to Subprime shifts the rate again (+1.5%)
  // - URL hash with old format (4 fields) still decodes (backwards-compat)
  // - Archetype click auto-expands advanced section + sets all 3 fields
  // Per spec docs/contexts/mortgage/specs/form-expansion.md.
  await page.goto(TEST_URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('sc-mortgage:advanced-shown'));
  await page.goto(TEST_URL + '?v=' + Date.now(), { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof advancedForm !== 'undefined' && window.MortgageBundle, null, { timeout: 10000 });
  await page.waitForTimeout(500);

  // Toggle present + form initially hidden
  const toggleInitial = await page.evaluate(() => ({
    toggleHasShowText: !!Array.from(document.querySelectorAll("a[onclick*='toggleAdvanced']"))
                          .find(a => a.textContent.includes('Show advanced options')),
    advHidden: !advancedForm.isVisible(),
  }));
  client.assert(toggleInitial.toggleHasShowText, '"Show advanced options" toggle present on first load');
  client.assert(toggleInitial.advHidden, 'advancedForm initially hidden');

  // Click toggle → advancedForm visible
  await page.evaluate(() => toggleAdvanced());
  await page.waitForTimeout(200);
  const toggleClicked = await page.evaluate(() => ({
    toggleHasHideText: !!Array.from(document.querySelectorAll("a[onclick*='toggleAdvanced']"))
                          .find(a => a.textContent.includes('Hide advanced options')),
    advVisible: advancedForm.isVisible(),
  }));
  client.assert(toggleClicked.toggleHasHideText, 'toggle text flips to "Hide advanced options" after click');
  client.assert(toggleClicked.advVisible, 'advancedForm visible after toggle');

  // FHA recomputes rate. Use form input pulse via setValue + handler.
  const beforeFHA = await page.evaluate(() => calcForm.getValue('rate'));
  await page.evaluate(() => {
    advancedForm.setValue('loan_type', 'FHA');
    _recomputeDisplayedRate();
    recalc();
  });
  await page.waitForTimeout(200);
  const afterFHA = await page.evaluate(() => calcForm.getValue('rate'));
  client.assert(parseFloat(afterFHA) < parseFloat(beforeFHA),
    `loan_type=FHA drops displayed rate (${beforeFHA} → ${afterFHA})`);

  // Subprime bumps rate above the FHA-only rate.
  await page.evaluate(() => {
    advancedForm.setValue('credit_tier', 'Subprime');
    _recomputeDisplayedRate();
    recalc();
  });
  await page.waitForTimeout(200);
  const afterSub = await page.evaluate(() => calcForm.getValue('rate'));
  client.assert(parseFloat(afterSub) > parseFloat(afterFHA),
    `credit_tier=Subprime bumps rate above FHA-only (${afterFHA} → ${afterSub})`);

  // getInput merges all 7 fields, including the 3 advanced.
  const fullInput = await page.evaluate(() => getInput());
  client.assert(fullInput.loan_type === 'FHA' && fullInput.credit_tier === 'Subprime'
                && fullInput.occupancy === 'Primary',
    `getInput merges advanced fields (loan_type=${fullInput.loan_type}, credit_tier=${fullInput.credit_tier}, occupancy=${fullInput.occupancy})`);

  // Backwards-compat: load an old 4-field hash → defaults applied to advancedForm.
  const oldHash = await encodeShared({ principal: 350000, downPayment: 50000, rate: 7, years: 30 });
  await page.evaluate((h) => { location.hash = 'i=' + h; }, oldHash);
  await page.waitForTimeout(500);
  const afterOldHash = await page.evaluate(() => advancedForm.getValues());
  client.assert(afterOldHash.loan_type === 'Conventional'
                && afterOldHash.credit_tier === 'Good'
                && afterOldHash.occupancy === 'Primary',
    `old 4-field hash leaves advancedForm at defaults (${JSON.stringify(afterOldHash)})`);

  // Forward-compat: load a 7-field hash → advancedForm restored, section auto-expanded.
  const sevenFieldHash = await encodeShared({
    principal: 425000, downPayment: 85000, rate: 6.25, years: 30,
    loan_type: 'VA', credit_tier: 'Excellent', occupancy: 'Investment',
  });
  await page.evaluate((h) => { location.hash = 'i=' + h; }, sevenFieldHash);
  await page.waitForTimeout(500);
  const afterNewHash = await page.evaluate(() => ({
    adv: advancedForm.getValues(),
    visible: advancedForm.isVisible(),
  }));
  client.assert(afterNewHash.adv.loan_type === 'VA'
                && afterNewHash.adv.credit_tier === 'Excellent'
                && afterNewHash.adv.occupancy === 'Investment',
    `7-field hash restores advancedForm (${JSON.stringify(afterNewHash.adv)})`);
  client.assert(afterNewHash.visible, '7-field hash auto-expands advanced section');

  // Archetype click flows 3 advanced fields through the hash → form.
  await page.evaluate(() => loadArchetype('first-time-buyer-fha'));
  await page.waitForTimeout(500);
  const advAfterArchetype = await page.evaluate(() => ({
    adv: advancedForm.getValues(),
    visible: advancedForm.isVisible(),
  }));
  client.assert(advAfterArchetype.adv.loan_type === 'FHA',
    `archetype "first-time-buyer-fha" sets loan_type=FHA on advancedForm (got ${advAfterArchetype.adv.loan_type})`);
  client.assert(advAfterArchetype.visible, 'archetype click auto-expands advanced section');
  await client.checkpoint('form-expansion');

  // ===== Test 13: iPhone-width responsive layout =====
  // Regression guard for the iPhone-overflow bug: handset width must clamp
  // to viewport (was hardcoded 520, iPhones are 375-430 → 25% horizontal scroll).
  // Detection now falls back to viewport-width threshold since SC's
  // isc.Browser.isHandset misses Chromium under Playwright (no touch events).
  // Tests at 3 representative iPhone widths.
  for (const [name, w] of [['iphone-se', 375], ['iphone-12', 390], ['iphone-15-pm', 430]]) {
    const phoneCtx = await browser.newContext({
      viewport: { width: w, height: 800 },
      deviceScaleFactor: 2, isMobile: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
    });
    const phonePage = await phoneCtx.newPage();
    await phonePage.goto(TEST_URL, { waitUntil: 'networkidle' });
    await phonePage.waitForFunction(() => typeof advancedForm !== 'undefined', null, { timeout: 10000 });
    await phonePage.waitForTimeout(400);
    const dims = await phonePage.evaluate(() => ({
      bodyW: document.body.scrollWidth,
      btnTitle: btnCalc.getTitle(),
    }));
    client.assert(dims.bodyW <= w,
      `${name} (vw=${w}): no horizontal overflow (body=${dims.bodyW})`);
    client.assert(dims.btnTitle === 'Calc',
      `${name}: action bar uses short button labels (got "${dims.btnTitle}")`);
    await phoneCtx.close();
  }
  await client.checkpoint('iphone-responsive');

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
