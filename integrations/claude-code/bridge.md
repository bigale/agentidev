# Browser Automation Bridge

You have access to a local browser automation stack via a WebSocket bridge server.
Use it to control Playwright Chromium browsers, run automation scripts, take accessibility snapshots, and debug interactively.

## System Paths

- **Bridge CLI**: `node packages/bridge/claude-client.mjs`
- **Bridge server**: `packages/bridge/server.mjs`
- **Browser launcher**: `packages/bridge/launch-browser.mjs`
- **Scripts directory**: `~/.agentidev/scripts/`
- **npm commands** (run from the repo root):
  - `npm run bridge` — start bridge server (port 9876)
  - `npm run bridge:stop` — stop bridge server
  - `npm run bridge:restart` — restart bridge server
  - `npm run browser` — launch Playwright Chromium with extension + dashboard

## Quick Reference

The bridge CLI is: `node packages/bridge/claude-client.mjs <command> [json]`

Shorthand for examples below: `bridge-cli` = the full node command above.

### Lifecycle
```
bridge-cli status                                    # check if bridge is running
bridge-cli session:list                              # list active browser sessions
bridge-cli script:list                               # list registered scripts
```

### Sessions (Playwright-controlled browser pages)
```
bridge-cli session:create '{"name":"my-session"}'
bridge-cli session:navigate '{"sessionId":"ID","url":"https://example.com"}'
bridge-cli session:snapshot '{"sessionId":"ID"}'     # accessibility tree (YAML)
bridge-cli session:click '{"sessionId":"ID","ref":"e42"}'
bridge-cli session:fill '{"sessionId":"ID","ref":"e42","value":"hello"}'
bridge-cli session:eval '{"sessionId":"ID","expr":"document.title"}'
bridge-cli session:destroy '{"sessionId":"ID"}'
```

### Scripts (automation scripts with checkpoints)
```
bridge-cli script:launch '{"path":"/home/bigale/.agentidev/scripts/my-script.mjs"}'
bridge-cli script:launch '{"path":"...", "breakpoints":["before_navigate","results_loaded"]}'
bridge-cli script:cancel '{"scriptId":"ID"}'
bridge-cli script:cancel '{"scriptId":"ID","force":true}'   # SIGKILL
bridge-cli script:step '{"scriptId":"ID"}'                   # advance one checkpoint
bridge-cli script:step '{"scriptId":"ID","clearAll":true}'   # continue (clear breakpoints)
bridge-cli script:breakpoint '{"scriptId":"ID","name":"checkpoint_name","active":true}'
```

## Startup Sequence

If the bridge is not running, start it before any commands:

```bash
npm run bridge &
sleep 2
node packages/bridge/launch-browser.mjs   # launches Chromium with extension, opens dashboard
```

After launch, the extension auto-connects to the bridge. Sessions can then be created and controlled.

## Snapshot-Driven Workflow

The primary interaction pattern is:
1. Navigate to a page
2. Take a snapshot (returns YAML accessibility tree with `[ref=eNNN]` element references)
3. Parse the snapshot to find elements
4. Click/fill using ref IDs
5. Take another snapshot to verify

Snapshots are the "eyes" — they show what's on the page as a structured accessibility tree, not screenshots.

## Important Notes

- The bridge server is a persistent Node.js process on ws://localhost:9876. It does NOT hot-reload — restart after code changes.
- Always use Playwright bundled Chromium (not system Chrome) for extension support.
- Scripts in `~/.agentidev/scripts/` use the playwright-shim for bridge integration.
- All data is local. No external API calls.

## User Request

$ARGUMENTS
