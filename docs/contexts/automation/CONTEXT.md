# Automation

Browser automation through a Node-side bridge server. Lets users (or AI agents, or Scripts on a Schedule) drive Playwright sessions, capture snapshots, debug interactively, and run scheduled jobs.

## Ownership

- Bridge server — `packages/bridge/server.mjs`, WebSocket on port 9876. Persistent Node process. Does **not** hot-reload — restart after any change to `server.mjs`.
- Bridge protocol — `packages/bridge/protocol.mjs`. All `BRIDGE_*` message types. Envelope `{ id, type, source, timestamp, payload }`. Roles: `extension`, `script`, `cli`, `claude`.
- Sessions — Playwright-controlled browser pages launched by the bridge.
- Scripts — automation files in `~/.agentidev/scripts/`, file-watched (300ms debounce).
- Schedules — cron-driven Script launches, persisted to `~/.agentidev/schedules.json`.
- Checkpoints / Breakpoints — declared in Script source, set/cleared dynamically.
- V8 inspector relay — `inspector-client.mjs`, Scripts launched with `--inspect-brk=0`.
- Playwright shim — `packages/bridge/playwright-shim.mjs`, drop-in for `import { chromium } from 'playwright'`.
- CLI — `packages/bridge/claude-client.mjs` for ad-hoc commands.
- Extension bridge client — `extension/lib/bridge-client.js`, WebSocket client that connects the SW to the bridge.

## Invariants

1. The bridge is a **persistent host-side Node process**. Scripts and Sessions die when it does. Browser tabs are not affected.
2. **One Session ↔ one active Script** at a time. `BRIDGE_SESSION_DESTROY` cascades to cancel the linked Script.
3. State held by PID between launch and register is in **pending maps** (`pendingBreakpoints`, `pendingSessionLinks`, `pendingInspectors`), transferred at `BRIDGE_SCRIPT_REGISTER`.
4. Force-kill is SIGTERM → SIGKILL after 2s.
5. Scripts get a `node_modules` symlink created in the scripts dir pointing at the nearest one from `originalPath`. CWD is `dirname(originalPath)`.
6. Schedules use server-side cron with overlap prevention (one active run per schedule).

## Public surface

- WebSocket on `ws://localhost:9876` — primary protocol surface.
- HTTP on `:9876/ds/<EntityDS>` — owned by Zato Integration, not Automation (lives in the same Node process but is a separate concern).
- HTTP on `:9876/llm` — calls Claude Code via local subprocess for non-WebSocket clients (PocketFlow flows etc).
- HTTP on `:9876/health` — GET liveness probe used by external callers before forwarding work. Returns `{ ok, role, extensionConnected }`.
- HTTP on `:9876/plugin-message/<handler>` — POST forwards a JSON body to the extension SW via the existing WebSocket and returns the SW handler's reply. Used by external callers (e.g. a Cloudflare Worker reached through a cloudflared tunnel) to invoke SW-side plugin handlers that they couldn't reach directly. Auth: requires matching `x-operator-key` header when `BRIDGE_OPERATOR_KEY` env is set. When unset, only direct-loopback callers with no forwarded-for / cf-connecting-ip headers are allowed — so a tunnel-exposed bridge fails closed by default (cloudflared connects from 127.0.0.1 but adds forwarded headers we detect).
- CLI: `node packages/bridge/claude-client.mjs <command> [json-payload]` (alias: `bcli`).
- Extension consumes via `extension/lib/bridge-client.js` with callback arrays (`onScriptUpdate`, `onRunComplete`, `onFileChanged`, `onPluginMessage`).

## Failure modes

- Bridge not running → `isConnected()` returns false; extension features degrade gracefully (DataSource calls fall through to IndexedDB).
- Script hangs → manual force-cancel; CheerpX-related Scripts may need a tab reload.
- V8 inspector connect race → handled by pending-maps pattern.
- Cross-platform JSON quoting on Windows → use single quotes for payloads.

## Bridge-server-as-ESB tendencies

The bridge has accumulated responsibilities beyond pure automation: a `/ds/` HTTP endpoint (Zato Integration), AI generation calls (SmartClient AI handler relays through here), scheduling. The proposed future-state refactor (Browser ESB) would carve those out and leave Automation as the pure host-helper for Playwright + fs.watch + V8 inspector. Per the current domain framing, those responsibilities live where they live today.
