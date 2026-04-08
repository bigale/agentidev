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
