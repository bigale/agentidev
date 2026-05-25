# Host Helper

A Node.js process that runs on the user's machine alongside the browser. Currently `packages/bridge/server.mjs` on port 9876.

After the migration per [ADR 001](../../adrs/001-browser-esb-replaces-bridge-as-runtime.md), Host Helper owns **only** capabilities the browser cannot do itself. It is not an ESB.

## What Host Helper owns

| Capability | Why it can't live in the browser |
|---|---|
| Spawn Playwright Chromium with the extension loaded | Browser can't spawn other browsers |
| Manage Playwright Sessions (Session-CRUD, CDP routing) | Tied to the spawned Chromium process |
| Spawn Scripts (Node child processes with Playwright) | Browser has no `child_process` |
| `fs.watch` on `~/.agentidev/scripts/` ↔ IndexedDB sync | No real fs-watch in browser; OPFS isn't watched externally |
| V8 inspector relay for debugging Scripts | Requires Node's `inspector` module + raw WebSocket to V8 |

## What Host Helper does NOT own

- ServiceRegistry, Channels, Outgoing connections (Browser ESB)
- Scheduling — Croner runs in the Browser ESB
- DataSource proxy — collapsed into Services in the Browser ESB
- AI generation calls — moved into a Service in the Browser ESB (which calls out via an Outgoing connection)
- Manifest reload — Browser ESB concept
- Pub/sub / Topics — Browser ESB concept

## Boundary contract with Browser ESB

Host Helper is **request-driven**: the Browser ESB issues commands; Host Helper responds. It does not initiate work and does not own application state.

Existing message types remaining in scope:
- `BRIDGE_SESSION_*` — Session lifecycle
- `BRIDGE_SCRIPT_LAUNCH` / `BRIDGE_SCRIPT_CANCEL` / `BRIDGE_SCRIPT_FILE_CHANGED` — Script lifecycle and file sync
- `BRIDGE_DBG_*` — V8 inspector commands

Existing message types that **move** to the Browser ESB during migration:
- `BRIDGE_SCHEDULE_*` — Scheduling moves to Croner inside the Browser ESB
- `BRIDGE_AF_*` — Agentiface app/project/template storage moves to IndexedDB-backed Services
- DS routing (currently `BRIDGE_BACKENDS`) — moves to Services

## Process lifecycle

- Starts before the browser (`npm run bridge` then `npm run browser`)
- Stays alive across browser reloads (so Sessions and Script sources persist)
- Stops via `BRIDGE_SHUTDOWN` over WebSocket (`npm run bridge:stop`)

## Failure modes that matter

- Browser ESB cannot use Host Helper capabilities when Host Helper is down. SW gracefully degrades: scheduling, Services, DS proxy, AI all keep working — only Script launch / Session create / debug fail with a clear error.
- The reverse is also true: if the Browser ESB is closed (no tabs open), Host Helper goes idle but its Sessions/Scripts continue running.