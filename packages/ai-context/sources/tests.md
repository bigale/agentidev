---
description: Testing patterns and conventions
globs: ["tests/**"]
alwaysApply: false
---

# Testing

Jest for unit tests. Always run in background: `npm test &`

## Test Patterns

`datasource-handlers.test.js` replicates routing logic from datasource-handlers.js (ESM/CJS boundary) and mocks bridge-client functions.

Structure: mock bridge functions -> call handler -> assert response format.

### DS Response Assertions

Correct: `expect(result.status).toBe(0)` and check `result.data` array
Wrong: do NOT assert `result.success === true` — DS format uses `status: 0` for success, `status: -1` for error.

### Mock Setup

```javascript
const mockBridgeClient = {
  isConnected: jest.fn(() => true),
  listSessions: jest.fn(),
  createSession: jest.fn(),
  // ... other bridge functions
};
```

## CDP UI Testing (ui-testing skill)

Use CDP via scripts in `packages/bridge/scripts/` for live UI testing:

- `cdp-screenshot.mjs <ws-url> <path>` — screenshot any page/iframe
- `iframe-click.mjs <sandbox-ws> <js-expr>` — eval in SmartClient sandbox
- `sw-eval.mjs <js-expr>` — eval in service worker

### Plugin Testing Gotchas

- **SectionStack breaks buttons**: renderer only walks `members`, not `sections[].items[]`. Use VLayout + Labels instead.
- **DynamicForm payload**: `_payloadFrom` prefers `getValues` for forms (not `getSelectedRecord` which returns null). If handlers receive empty payload, check this.
- **AutoTest locators**: may miss components in non-standard nesting. Use tree-walk fallback from the root VLayout.
- **resolveRef**: only works in dashboard mode. In plugin mode, use `isc.AutoTest.getObject`.
- **CheerpX spawn queue**: one hung command (sqlite3, python import) permanently jams ALL subsequent commands. Only fix: reload CheerpX tab.
- **Extension reload**: kills CheerpX content script connections. Must reload CheerpX tab separately (25s+ boot).
- **CDP target ordering**: sandbox iframe position in target list varies. Always search by URL content, not index.

## ScriptClient Test Scripts

Test scripts in `examples/test-*.mjs` use `ScriptClient.assert()`:

```javascript
import { ScriptClient } from '../packages/bridge/script-client.mjs';
const client = new ScriptClient('my-test', { totalSteps: 3 });
await client.connect();
client.assert(condition, 'description');  // tracks pass/fail
await client.artifact({ type: 'screenshot', label: 'Result', filePath: '/tmp/shot.png', contentType: 'image/png' });
await client.complete({ assertions: client.getAssertionSummary() });
```

Results appear in the dashboard's Assertions tab (real-time) and Test Results portlet.

## CDP Plugin Testing Pattern

**Standard pattern for testing SmartClient plugins end-to-end.** Connects to the extension browser (port 9222) via CDP, opens the plugin, evaluates JS in the sandbox iframe, and reports assertions to the dashboard via ScriptClient.

**Why CDP instead of Playwright sessions**: Playwright sessions spawn separate browsers without the extension loaded, so `chrome-extension://` URLs fail. CDP on port 9222 connects to the browser that has the extension, so plugin URLs work.

### Architecture

```
Test Script (Node.js)
  ├── ScriptClient → bridge WebSocket (progress, assertions, artifacts)
  └── CDP WebSocket → port 9222 → extension browser
       ├── http://localhost:9222/json → find page + sandbox iframe targets
       ├── Runtime.evaluate in sandbox iframe → isc.AutoTest API
       └── Page.captureScreenshot → artifacts
```

### Template (copy for new plugin tests)

```javascript
import { ScriptClient } from '../packages/bridge/script-client.mjs';
import http from 'http';
import WebSocket from 'ws';
import fs from 'fs';

const CDP_PORT = 9222;
const PLUGIN_MODE = 'my-plugin-id';
const client = new ScriptClient('test-' + PLUGIN_MODE, { totalSteps: 4 });

// CDP helpers: getTargets(), cdpEval(), cdpScreenshot(), findPluginTargets()
// Copy from examples/test-csv-analyzer.mjs

try {
  await client.connect();

  // Step 1: Open plugin tab via CDP
  // PUT http://localhost:9222/json/new?chrome-extension://<extId>/smartclient-app/wrapper.html?mode=<pluginId>

  // Step 2: Verify components in sandbox iframe
  // cdpEval(sandbox.webSocketDebuggerUrl, `isc.AutoTest.getObject('//Button[ID="myBtn"]')`)

  // Step 3: Interact (click buttons, fill forms)
  // cdpEval(sandbox.ws, `isc.AutoTest.getObject('//Button[ID="btnLoad"]').click()`)

  // Step 4: Verify results (grid rows, status text)
  // cdpEval(sandbox.ws, `isc.AutoTest.getObject('//ListGrid[ID="myGrid"]').getTotalRows()`)

  const exitCode = client.summarize();
  await client.complete({ assertions: client.getAssertionSummary() });
  process.exit(exitCode);
} catch (err) {
  client.assert(false, 'Fatal: ' + err.message);
  client.summarize();
  await client.complete({ assertions: client.getAssertionSummary() }).catch(() => {});
  process.exit(1);
}
```

### Key SmartClient AutoTest APIs (use inside cdpEval)

```javascript
// Find component by ID
isc.AutoTest.getObject('//Button[ID="btnLoad"]')
isc.AutoTest.getObject('//ListGrid[ID="resultsGrid"]')
isc.AutoTest.getObject('//DynamicForm[ID="queryForm"]')

// Grid operations
grid.getTotalRows()
grid.getRecord(0)           // first row as object
grid.getFields().map(f => f.name)

// Form operations
form.setValue('fieldName', 'value')
form.getValues()            // all field values as object

// Button click
btn.click()

// HTMLFlow status text
flow.getContents()          // returns innerHTML string
```

### Running from Dashboard

1. Save script to `~/.agentidev/scripts/test-my-plugin.mjs`
2. Bridge file watcher auto-detects it
3. Select script in dashboard Scripts panel → click Run (no session needed)
4. Progress, assertions, screenshots appear in real-time

### Reference Implementation

`examples/test-csv-analyzer.mjs` — 16 assertions testing the CSV Analyzer plugin: component rendering, CSV load, column describe, query with sort/limit, screenshots at each stage.

### Agent-Generated Tests

The pi-mono agent can generate and run plugin tests via two tools:
- `script_save`: saves a test script to the library + disk
- `script_launch`: runs it and reports results to the dashboard

The agent should generate tests following this CDP pattern, NOT using Playwright sessions (which lack extension access).
