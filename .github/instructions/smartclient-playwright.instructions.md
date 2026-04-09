<!-- Generated from packages/ai-context/sources/. Do not edit directly. -->

---
applyTo: ["tests/e2e/**","tests/playwright/**"]
---


# SmartClient Playwright Testing

## Setup

Tests use the `SmartClientCommands` helper from `smartclientSDK/tools/playwright/commands.js`.
Add to Playwright test file:

```javascript
const { extendPage } = require(process.env.SMARTCLIENT_SDK + '/tools/playwright/commands.js');

test.beforeEach(async ({ page }) => {
  extendPage(page);
  await page.goto('chrome-extension://jgkjpplhfkpoagkobjfepkkmilbfdgcg/smartclient-app/wrapper.html?mode=dashboard');
  await page.waitForSCDone();
});
```

## AutoTest Locators

All SmartClient element refs start with `//`. Use `isc.AutoTest.getLocator(element)` in the browser console to discover them.

Common locator patterns:
```javascript
// Component by ID
'//ListGrid[ID="schedulesGrid"]'
'//Button[ID="btnNewSession"]'

// Grid cell by row and column
'//ListGrid[ID="scriptsGrid"]/row[index=0]/col[name="name"]'

// Tab by title
'//TabSet[ID="scriptDetailTabs"]/tab[title="Artifacts"]'

// Form field
'//DynamicForm[ID="someForm"]/item[name="fieldName"]'
```

**Never use CSS selectors or `page.locator()` for SmartClient components.** SmartClient generates complex DOM that changes on redraws.

## Core Commands (from `extendPage`)

```javascript
// Resolve locator, wait for SC system done, return ElementHandle
const el = await page.getSC('//Button[ID="btnNewSession"]');

// Click (resolves locator + clicks center via mouse.move/down/up)
await page.clickSC('//Button[ID="btnNewSession"]');

// Type into a field (clicks first to focus, Ctrl+A to clear, then types)
await page.typeSC('//DynamicForm[ID="someForm"]/item[name="name"]', 'my-session');

// Hover
await page.hoverSC('//ListGrid[ID="scriptsGrid"]/row[index=0]');

// Scroll SmartClient Canvas (not native scroll — required for custom scrollbars)
await page.scrollSC('//ListGrid[ID="scriptsGrid"]', 0, 200);

// Wait for all SC async ops to complete
await page.waitForSCDone();

// Get SC component object (returns serializable JS object, not DOM element)
const grid = await page.getSCObject('//ListGrid[ID="schedulesGrid"]');

// Check element exists
const exists = await page.existsSCElement('//Button[ID="btnRun"]');

// Get text content
const text = await page.scGetLocatorText('//ListGrid[ID="scriptsGrid"]/row[index=0]/col[name="name"]');

// Drag and drop (recipe reorder, etc.)
await page.dragAndDropSC(
  '//ListGrid[ID="preActionsGrid"]/row[index=1]',
  '//ListGrid[ID="preActionsGrid"]/row[index=0]',
  { dropPosition: 'before' }
);
```

## Configuration

```javascript
page.configureSC({
  scCommandTimeout: 15000,  // default 30000ms
  scLogCommands: true,      // logs each SC command
  scLogLevel: 'info',       // 'debug' | 'info' | 'warn' | 'error' | 'silent'
  scAutoWait: true,         // auto-call waitForSCDone after each command
});
```

## Critical Interaction Rules

### Checkboxes and SelectItems
SmartClient `CheckboxItem`, `SelectItem`, `ComboBoxItem` are **custom HTML** — not native browser controls.
- Use `clickSC()` — NOT `page.check()`, `page.selectOption()`, or `.fill()`
- For grid cell checkboxes (e.g. `enabled` in schedulesGrid): double-click to enter edit mode first, then click the checkbox cell

```javascript
// Enter edit mode on row
await page.clickSC('//ListGrid[ID="schedulesGrid"]/row[index=0]/col[name="name"]');
await page.clickSC('//ListGrid[ID="schedulesGrid"]/row[index=0]/col[name="name"]');
// (double-click = editEvent: 'doubleClick')
```

### Click Masks
Some SC interactions (inline edit, dropdowns) show a click-mask. To dismiss:
```javascript
// Use force: true option
await page.mouse.click(x, y, { force: true });
```

### Grid Inline Editing
schedulesGrid uses `editEvent: 'doubleClick'`. Single click selects row, double-click opens edit.
After editing, pressing Tab or clicking elsewhere triggers `editComplete` and saves to bridge.

## Waiting Patterns

`getSC()` automatically calls `waitForSCDone()` after resolving — no need to add extra waits after most operations.

Explicit waits needed for:
- Bridge async operations (use `page.waitForTimeout(500)` after dispatch)
- Grid data refresh after `invalidateCache()` calls
- Modal dialogs appearing after button click

## Dashboard-Specific Locators

```javascript
// Toolbar buttons
'//ToolStripButton[ID="tbRun"]'
'//ToolStripButton[ID="tbDebug"]'

// Sessions grid
'//ListGrid[ID="sessionsGrid"]/row[index=0]/col[name="name"]'

// Scripts library
'//ListGrid[ID="scriptsGrid"]/row[index=0]/col[name="name"]'

// Schedules grid
'//ListGrid[ID="schedulesGrid"]/row[index=0]/col[name="name"]'
'//ListGrid[ID="schedulesGrid"]/row[index=0]/col[name="enabled"]'

// Script History tabs
'//ListGrid[ID="scriptHistoryGrid"]'
'//Button[ID="btnHistoryLive"]'
'//Button[ID="btnHistoryArchive"]'

// Artifacts
'//ListGrid[ID="artifactsGrid"]'
'//HTMLFlow[ID="artifactPreview"]'
```

## Test Structure

```javascript
const { test, expect } = require('@playwright/test');
const { extendPage } = require(process.env.SMARTCLIENT_SDK + '/tools/playwright/commands.js');

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    extendPage(page);
    await page.goto('chrome-extension://jgkjpplhfkpoagkobjfepkkmilbfdgcg/smartclient-app/wrapper.html?mode=dashboard');
    await page.waitForSCDone({ timeout: 15000 });
  });

  test('creates a new session', async ({ page }) => {
    await page.clickSC('//Button[ID="btnNewSession"]');
    await page.waitForSCDone();
    // Dialog should appear — interact with it
    await page.typeSC('//DynamicForm/item[name="sessionName"]', 'test-session');
    await page.clickSC('//Button[title="OK"]');
    await page.waitForTimeout(1000); // bridge async
    const name = await page.scGetLocatorText('//ListGrid[ID="sessionsGrid"]/row[index=0]/col[name="name"]');
    expect(name).toBe('test-session');
  });
});
```

## Discovering Locators at Runtime

In browser console (inside the sandbox iframe):
```javascript
// Get locator for a component you clicked on
isc.AutoTest.getLocator(document.elementFromPoint(x, y))

// Get locator for a known component by ID
isc.AutoTest.getLocator(isc.AutoTest.getObject('//ListGrid[ID="scriptsGrid"]').getCell(0, 0))
```
