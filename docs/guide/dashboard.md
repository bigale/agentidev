# Dashboard Guide

The SmartClient Dashboard is the central hub for browser automation, script development, testing, and scheduling.

## Toolbar

| Button | Action |
|--------|--------|
| **File** | Open/Save/Save As scripts |
| **Connect/Disconnect** | Toggle bridge server connection |
| **Run** | Launch script in a new browser (standalone) |
| **Session ▼** | Dropdown: pick a session to run the script in its browser |
| **Pause/Resume/Stop** | Script checkpoint controls |
| **Step/Continue** | Advance one checkpoint at a time |
| **Kill** | Force-terminate script (SIGTERM + SIGKILL) |
| **Debug** | Launch with V8 inspector (--inspect-brk) |
| **Step Into/Step Out** | V8 debugger line-level controls |
| **Auth** | Capture browser login state for script reuse |
| **Trace** | Toggle trace recording on selected session |
| **Video** | Toggle video recording on selected session |
| **Sync** | Export IndexedDB to bridge for backup |
| **Capture** | Toggle artifact capture at checkpoints |
| **?** | Help window with searchable reference |

## Sessions

A **session** is a persistent Playwright-managed browser. Sessions stay open so you can observe automation in real time.

- **New**: Create a named session — a headed Chromium browser opens
- **Destroy**: Close the session and its browser
- **Status**: Shows `idle`, `ready`, `navigating`, `error`, `destroyed`

### Session-Linked Scripts

When you click **Session ▼** and pick a session before running, the script connects to that session's browser via CDP instead of opening a new one. The session browser stays open after the script finishes — you can inspect the result.

**Key behavior:**
- Scripts are responsible for their own preconditions (navigate to start URL, clear cookies if needed)
- The session is a shared viewport, not a clean room
- State accumulates across runs (cookies, navigation history)

## Scripts

### Scripts Library (Column 1)

Lists all scripts registered with the bridge. Scripts appear here when:
- Saved to `~/.agentidev/scripts/` (bridge file watcher auto-syncs)
- Saved to `EXTERNAL_SCRIPTS_DIR` (e.g. a sibling suite repo) — the bridge watches both directories and emits FILE_CHANGED so the extension auto-imports them on connect
- Opened via File → Open
- Saved from the editor

Click a script to load it in the Monaco editor. The version sub-grid shows prior saves.

### Script History (below Scripts Library)

**Live** mode shows running/recently-launched scripts with real-time step/state updates.
**Archive** mode shows completed runs from the database with timing and artifact counts.

- Double-click any entry to open its source in the editor
- Right-click for context menu: Open in Editor, Run Script

### Source Editor (Center)

Full Monaco editor with JavaScript syntax highlighting:
- Click glyph margin to toggle breakpoints at `client.checkpoint()` lines
- Current paused checkpoint highlighted in gold
- Ctrl+S saves to library and disk

### Script Detail (Right)

Five tabs:
- **State**: Live script status, step progress, debugger controls
- **Assertions**: Pass/fail results from `client.assert()` calls, streamed in real time
- **Artifacts**: Screenshots, traces, videos, console logs with inline preview
- **Console**: Browser console messages from the session (color-coded by level)
- **Network**: HTTP requests from the session (method, status, URL)

## Trace & Video Recording

### Trace

1. Select a session in the Sessions grid
2. Click **Trace** — shows "Trace ●" while recording
3. Run a script via **Session ▼**
4. When the script completes, trace auto-stops
5. Trace appears as an artifact — click **Open Trace Viewer** to see the full Playwright timeline

Traces capture: actions, screenshots, DOM snapshots, network requests, console messages.

### Video

Same pattern as Trace. Click **Video** to start/stop. Output is a `.webm` file. Auto-stops when a session-linked script completes.

## Schedules

Automatically run scripts on a cron expression. The grid shows name, script, cron, enabled toggle, run count, and next run time.

- **New**: Create schedule with name, script, cron expression
- **Edit**: Double-click to inline-edit name, script, enabled
- **Trigger**: Run immediately (ignores schedule)
- **Delete**: Remove schedule

## Test Results

Displays pass/fail counts for test scripts that use `client.assert()`.

- **Run All Tests**: Launches `test-internal-ops.mjs`
- **Refresh**: Reloads stored results
- Shows: test name, pass count, fail count, status, duration

## Recipes

Pre/post actions that run before and after a script launch:
- Navigate to a URL
- Set a cookie
- Clear storage
- Take a screenshot

Actions selected from a command palette, reorderable by drag, removable individually. Recipes saved independently and assigned to scripts via the library picker.

## Activity Log

Scrolling log of bridge commands and events in reverse-chronological order. Shows message type, summary, and timestamp.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Ctrl+S | Save current script |
