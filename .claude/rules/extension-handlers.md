<!-- Generated from docs/ai-context/. Do not edit directly. -->

---
description: Extension message handlers, DataSource proxy, bridge client, script library
paths: ["extension/lib/**"]
---


# Extension Handlers (`extension/lib/`)

## Message Routing

Background service worker dispatches by `type` string. Handler files export a `register(handlers)` function that adds entries to the handler map. Messages with `type.startsWith('EMBEDDINGS_')` route to offscreen document.

**Critical**: Always `return true` from `chrome.runtime.onMessage.addListener()` for async responses.

## DataSource Proxy (`extension/lib/handlers/datasource-handlers.js`)

`BRIDGE_BACKENDS` registry routes DS operations by dataSource ID to bridge functions:
- `BridgeSessions` -> `bridgeClient.listSessions()`, `createSession()`, `destroySession()`
- `BridgeScripts` -> `bridgeClient.listScripts()`
- `BridgeSchedules` -> `bridgeClient.listSchedules()`, `createSchedule()`, etc.
- `BridgeCommands` -> in-memory command log

Anything not in `BRIDGE_BACKENDS` falls through to IndexedDB (`smartclient-data` database).

### DS Response Format

Success: `{ status: 0, data: [...] }` — NOT `{ success: true }`
Error: `{ status: -1, data: errorMsg }` — NOT `{ error: ... }`

IndexedDB auto-creates object stores per DS ID with `keyPath: 'id'` and `autoIncrement: true`.

## Bridge Client (`extension/lib/bridge-client.js`)

WebSocket client connecting to bridge server. Callback arrays fire from broadcast handler:
- `onScriptUpdate` — script state changes
- `onRunComplete` — run archive ready
- `onFileChanged` — disk file changed
- `onSessionUpdate`, `onScheduleUpdate`, etc.

`isConnected()` checks WebSocket state before bridge operations.

## Script Library

Stored in `chrome.storage.local`:
- Key `bridge-scripts`: array of script library entries (name, source, originalPath)
- Key `script-versions`: version history per script (pruned to 20 entries)

`upsertShimImport(source, shimPath)` adds absolute shim import path to script source at import time.

## SmartClient AI Handler (`extension/lib/handlers/smartclient-handlers.js`)

`SC_GENERATE_UI` -> `bridgeClient.generateSmartClientUI(prompt)` -> validates config (must have `dataSources[]` and `layout._type`) -> auto-saves to app persistence -> returns config to sandbox iframe.
