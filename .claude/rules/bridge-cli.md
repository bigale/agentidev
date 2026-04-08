<!-- Generated from packages/ai-context/sources/. Do not edit directly. -->

---
description: Browser automation bridge CLI reference for controlling Playwright sessions, scripts, and schedules
alwaysApply: true
---


# Browser Automation Bridge

You have access to a local browser automation bridge via WebSocket (port 9876).
Use the CLI to control Playwright Chromium browsers, run automation scripts, take accessibility snapshots, and debug interactively.

## Bridge CLI

All commands run from the workspace root:

```
node packages/bridge/claude-client.mjs <command> [json-payload]
```

Shorthand below: `bcli` = `node packages/bridge/claude-client.mjs`

## Startup

If the bridge is not running, start it before any commands:

```
npm run bridge &          # start bridge server (port 9876)
sleep 2
node packages/bridge/launch-browser.mjs   # launch Chromium with extension + dashboard
```

The extension auto-connects once the browser is up.

## Lifecycle

```
bcli status                                    # bridge health check
bcli session:list                              # list active browser sessions
bcli script:list                               # list registered scripts
```

## Sessions (Playwright-controlled browser pages)

```
bcli session:create '{"name":"my-session"}'
bcli session:navigate '{"sessionId":"ID","url":"https://example.com"}'
bcli session:snapshot '{"sessionId":"ID"}'     # accessibility tree (YAML)
bcli session:click '{"sessionId":"ID","ref":"e42"}'
bcli session:fill '{"sessionId":"ID","ref":"e42","value":"hello"}'
bcli session:eval '{"sessionId":"ID","expr":"document.title"}'
bcli session:destroy '{"sessionId":"ID"}'
```

## Scripts (automation scripts with checkpoints)

```
bcli script:launch '{"path":"~/.contextual-recall/scripts/my-script.mjs"}'
bcli script:launch '{"path":"...","breakpoints":["before_navigate","results_loaded"]}'
bcli script:cancel '{"scriptId":"ID"}'
bcli script:cancel '{"scriptId":"ID","force":true}'
bcli script:step '{"scriptId":"ID"}'
bcli script:step '{"scriptId":"ID","clearAll":true}'
bcli script:breakpoint '{"scriptId":"ID","name":"checkpoint_name","active":true}'
bcli script:save '{"name":"my-script","source":"import { chromium } from ..."}'
```

## Schedules

```
bcli schedule:list
bcli schedule:create '{"name":"daily-check","path":"...","cron":"0 9 * * *"}'
bcli schedule:update '{"scheduleId":"ID","enabled":false}'
bcli schedule:delete '{"scheduleId":"ID"}'
bcli schedule:trigger '{"scheduleId":"ID"}'
```

## SmartClient AI

```
bcli sc:generate "Create a ListGrid with name, email, status columns"
bcli sc:clone '{"sessionId":"ID"}'
```

## Snapshot-Driven Workflow

The primary interaction pattern:
1. Navigate to a page
2. Take a snapshot (returns YAML accessibility tree with `[ref=eNNN]` element references)
3. Parse the snapshot to find target elements
4. Click/fill using ref IDs
5. Take another snapshot to verify

Snapshots are the "eyes" -- structured accessibility tree, not screenshots.

## Important Notes

- The bridge server (`packages/bridge/server.mjs`) is a persistent Node.js process. It does NOT hot-reload -- run `npm run bridge:restart` after code changes.
- Always use Playwright bundled Chromium (not system Chrome) for extension support.
- Scripts in `~/.contextual-recall/scripts/` use `packages/bridge/playwright-shim.mjs` for bridge integration.
- All data is local. No external API calls.
- JSON payloads on Windows may need double-quote escaping in the shell. Use single quotes when possible.
