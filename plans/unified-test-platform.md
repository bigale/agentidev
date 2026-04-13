# Plan: Unified Dev + Test Platform

## Vision

The SC Dashboard becomes the single hub for development, testing, and
operations. Three testing levels, one interface, one script format.

```
┌─────────────────────────────────────────────────────────────┐
│                    SC Dashboard                              │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │ Level 1     │  │ Level 2      │  │ Level 3            │  │
│  │ Internal    │  │ Generated    │  │ External           │  │
│  │ Ops Testing │  │ App Testing  │  │ Testing            │  │
│  │             │  │              │  │                    │  │
│  │ Sidebar     │  │ Plugin UIs   │  │ Any website        │  │
│  │ Host caps   │  │ DataSources  │  │ Playwright scrapes │  │
│  │ Runtimes    │  │ Actions      │  │ Auth flows         │  │
│  │ Bridge      │  │ Rendering    │  │ API endpoints      │  │
│  └─────────────┘  └──────────────┘  └────────────────────┘  │
│                                                              │
│  Scripts    │  Schedules  │  Artifacts  │  Live Console      │
└─────────────────────────────────────────────────────────────┘
```

## What we have today

### The SC Dashboard (`?mode=dashboard`)
- 3-column PortalLayout: sessions, scripts, schedules
- Monaco editor for script source
- Live console (stdout streaming)
- Artifact browser with inline preview
- Script lifecycle: registered → running → checkpoint → complete
- V8 debugger integration
- Cron scheduling with overlap prevention
- Auth capture for Playwright sessions

### The old React Dashboard (`dashboard/dashboard.html`)
- Duplicate of some SC Dashboard features (script list, session list)
- Built before the SC Dashboard existed
- No unique capabilities the SC Dashboard doesn't have
- **Deprecate**: remove from the Auto tab, keep the code for reference

### Playwright + Bridge CLI
- `session:create/navigate/snapshot/click/fill/eval` — full browser control
- `script:launch/cancel/step` — script lifecycle management
- Accessibility snapshots (YAML trees with ref IDs)
- Screenshot capture at checkpoints
- Auth state save/replay

### CDP Tools (from Claude Code)
- `cdp-screenshot.mjs` — screenshot any page/iframe
- `iframe-click.mjs` — eval in SmartClient sandbox
- `sw-eval.mjs` — eval in service worker
- `sandbox-eval.mjs` — eval in SC sandbox by URL match
- SmartClient AutoTest locators (`//Button[ID="..."]`)

### Plugin System
- Create/edit/delete via SC_PUBLISH_PLUGIN
- Storage-backed (sidebar-created) and file-backed (assemble.sh)
- Every plugin gets: skin picker, DS persistence, Inspector, AI prompt
- `fetchAndLoadGrid`, `dispatchAndDisplay`, `streamSpawnAndAppend` actions
- `HOST_NETWORK_FETCH`, `HOST_EXEC_SPAWN`, `HOST_FS_*` handlers

## Deprecation: React Dashboard

### What to do
1. Remove the "Dashboard" button from the Auto tab (only "SC Dashboard" remains)
2. Keep `dashboard/dashboard.html` in the repo for reference but mark as deprecated
3. Any unique features (if any) get ported to the SC Dashboard first

### Why
- The SC Dashboard does everything the React dashboard does
- SmartClient grids are more capable (sort, filter, group, edit)
- The SC Dashboard integrates with the plugin system
- One codebase to maintain, not two

## Level 1: Internal Ops Testing

**What**: test the sidebar, host capabilities, runtimes, bridge, plugin
system — the platform itself.

**Script pattern**:
```javascript
// internal-ops-test.mjs — launched from SC Dashboard
import { chromium } from 'playwright-shim.mjs';

// Test: host.storage round-trip
const stored = await eval_in_sw(`
  await globalThis.__handlers['HOST_STORAGE_SET']({ key: 'test', value: 42 });
  return (await globalThis.__handlers['HOST_STORAGE_GET']({ key: 'test' })).value;
`);
assert(stored === 42, 'storage round-trip');

// Test: plugin list includes hello-runtime
const plugins = await eval_in_sw(`
  return (await globalThis.__handlers['PLUGIN_LIST']({})).map(p => p.id);
`);
assert(plugins.includes('hello-runtime'), 'hello-runtime registered');

// Test: CheerpX spawn
const cx = await eval_in_sw(`
  return await globalThis.__handlers['HOST_EXEC_SPAWN']({ cmd: '/bin/echo', args: ['test'] });
`);
assert(cx.stdout.trim() === 'test', 'cheerpx echo');
```

**Where the scripts live**: `~/.agentidev/scripts/internal-tests/`

**How to run**: SC Dashboard → Scripts panel → select test → Run

### Specific tests needed
- [ ] All HOST_* handlers respond without error
- [ ] PLUGIN_LIST returns expected plugins
- [ ] CheerpX spawn works (echo, python3)
- [ ] CheerpJ runMain works (hello-main.jar)
- [ ] CheerpJ runLibrary works (library mode)
- [ ] BeanShell eval works
- [ ] Bridge connection status
- [ ] Plugin create/save/delete round-trip
- [ ] Skin change applies to correct plugin

## Level 2: Generated App Testing

**What**: test plugins created via Agentiface — the UIs we generate.

**Script pattern**:
```javascript
// test-weather-alerts.mjs
import { chromium } from 'playwright-shim.mjs';

// Open the Weather Alerts plugin
const page = await browser.newPage();
await page.goto('chrome-extension://<id>/smartclient-app/wrapper.html?mode=weather-alerts');
await page.waitForSCDone();

// Click Fetch Alerts
await page.clickSC('//Button[ID="btnFetch"]');
await page.waitForTimeout(8000);

// Verify grid loaded
const rows = await page.evaluate(() => {
  return isc.AutoTest.getObject('//ListGrid[ID="alertsGrid"]').getTotalRows();
});
assert(rows > 0, 'alerts loaded: ' + rows + ' rows');

// Screenshot
await page.screenshot({ path: 'weather-alerts-loaded.png' });
```

**What this tests**:
- Plugin config renders correctly
- Buttons wire to correct handlers
- API calls succeed (HOST_NETWORK_FETCH, HOST_FETCH_AND_TRANSFORM)
- Grid populates with data
- DataSource persistence works
- Skin switching works
- Visual regression (screenshot comparison)

### SmartClient-specific test patterns
- Use AutoTest locators (not CSS selectors)
- `waitForSCDone()` after interactions
- Grid assertions: `getTotalRows()`, `getRecord(n)`, `getSelectedRecord()`
- Form assertions: `getValues()`, `getField('name').getValue()`
- Button state: `isDisabled()`, `getTitle()`

## Level 3: External Testing

**What**: test any website — the existing Playwright capability.

This is what the SC Dashboard already does today:
- Create a session → navigate → snapshot → interact → assert
- The bridge CLI wraps this as a scriptable pipeline
- Scripts can run from the dashboard with checkpoints + live console
- Auth capture + replay for authenticated sites

### What's new for Level 3
- Scripts can ALSO call host capabilities (CheerpX, CheerpJ)
- A scraping script can fetch data, process it in Python (CheerpX),
  and store results in a plugin's DataSource
- Horsebread is the canonical Level 3 example: Playwright scrapes +
  Python processing + dashboard display

## The Unified Script Format

All three levels use the same script format:
```javascript
import { chromium } from 'playwright-shim.mjs';
// OR for non-Playwright scripts:
import { ScriptClient } from 'script-client.mjs';

// The script runs locally on the bridge server.
// It has access to:
//   - Playwright browser automation (sessions)
//   - Bridge CLI commands (via ScriptClient)
//   - Node.js fs/path/etc for local file access
//   - The bridge's WebSocket for real-time communication
//
// For host.* operations (storage, exec, fs, runtimes), the script
// calls the extension's SW handlers via the bridge's message relay.
```

Scripts are launched from:
1. **SC Dashboard** — click Run, see live console + checkpoints
2. **Bridge CLI** — `bcli script:launch '{"path":"..."}'`
3. **Claude Code** — `node packages/bridge/scripts/sw-eval.mjs ...`
4. **Cron schedule** — bridge's scheduler triggers automatically

## New SC Dashboard: Test Runner Mode

A new mode or section in the SC Dashboard dedicated to test results:

### Test Panel (in addition to existing Scripts/Sessions/Schedules)
- Test suite list (groups of test scripts)
- Run all / run selected
- Results grid: pass/fail/skip per test, with elapsed time
- Artifact comparison: before/after screenshots side by side
- Failure details: expected vs actual, stack trace
- History: test results over time (trend chart)

### How it works
- Test scripts are regular bridge scripts with a naming convention
  (`test-*.mjs`) or a manifest that declares them as tests
- The bridge server collects pass/fail assertions from script stdout
  (or via a dedicated `ScriptClient.assert()` method)
- Results are stored in the bridge's run archive
- The dashboard's Test Panel reads from the archive and displays

## Implementation Phases

### Phase T1: Deprecate React Dashboard
- Remove "Dashboard" button from Auto tab sidebar
- SC Dashboard becomes the only dashboard
- Clean up any React dashboard-only features

### Phase T2: Test script infrastructure
- Add `ScriptClient.assert(condition, message)` to the script SDK
- Bridge server collects assertion results from script messages
- Run archive includes assertion summary (pass/fail/total)
- SC Dashboard shows assertion results in the Script History tab

### Phase T3: Internal ops test suite
- Write test scripts for all HOST_* handlers
- Write test scripts for plugin CRUD
- Write test scripts for CheerpX/CheerpJ/BeanShell
- Bundle as `~/.agentidev/scripts/internal-tests/`
- Add to the SC Dashboard's test runner

### Phase T4: Generated app test framework
- SmartClient AutoTest wrapper for the bridge's Playwright shim
- `page.clickSC()`, `page.waitForSCDone()`, `page.getSCObject()`
- Screenshot capture at checkpoints for visual regression
- Plugin-specific test template: open mode, verify components, click
  buttons, check results

### Phase T5: Test runner dashboard section
- New Portlet in the SC Dashboard for test results
- Suite/test hierarchy with pass/fail badges
- Before/after screenshot comparison
- Trend chart over time
- One-click "Run All Tests" button

## What this enables

1. **Dogfood the stack**: we test agentidev WITH agentidev. The SC
   Dashboard launches test scripts that test the SC Dashboard.

2. **Plugin confidence**: every generated app gets a test script that
   verifies it renders, buttons work, API calls succeed, data persists.

3. **Regression detection**: run the full test suite before every
   commit. Screenshots catch visual regressions. Assertion counts
   catch behavioral regressions.

4. **QA as a feature**: users can write their own test scripts for
   their plugins and run them from the dashboard. The same Playwright
   infrastructure that drives horsebread's scraping also drives QA.

5. **AI-assisted test generation**: "generate a test for this plugin"
   → the AI knows about AutoTest locators, assertions, and the script
   format. Test generation is a natural extension of UI generation.
