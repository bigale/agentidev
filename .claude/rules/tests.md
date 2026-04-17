<!-- Generated from packages/ai-context/sources/. Do not edit directly. -->

---
description: Testing patterns and conventions
paths: ["tests/**"]
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
