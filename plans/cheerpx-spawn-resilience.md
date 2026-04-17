# Plan: CheerpX Spawn Queue Resilience

## Context

The CheerpX spawn queue is **strictly serial** — one `_spawnBusy` flag gates all execution. When `_cx.run()` hangs (sqlite3, Python imports, any blocked process), the Promise never resolves, the finally block never fires, `_spawnBusy` stays true forever, and all subsequent commands queue indefinitely.

This is a **blocker for any CheerpX-based plugin** — one bad command permanently breaks the VM until the tab is reloaded.

### Root Cause

```
_cx.run(cmd, args) → Promise that resolves ONLY when process exits
                   → NO timeout
                   → NO kill API from JS side
                   → Hung process = Promise hangs forever
                   → _spawnBusy = true forever
                   → Queue permanently jammed
```

The API explicitly states: "NO way to kill/signal a running process from JS. Promise resolves only on natural exit."

### Known Hangs in Current Image

- `sqlite3` — any invocation (even `--version`, `:memory:`)
- `python3 import <anything>` — all stdlib/third-party imports
- Any network operation (no Tailscale configured)
- Any process that blocks on I/O the VM can't fulfill

### What Works

- `/bin/echo`, `/bin/ls`, `/bin/cp`, `/bin/cat` — ~200ms
- `python3 -c "print(42)"` — ~1.3s (no imports)
- File upload via DataDevice + HOST_FS_UPLOAD — ~100ms
- All non-import Python (math, string ops, basic I/O)

## Solution: Three-Layer Defense

### Layer 1: Spawn Timeout with Ctrl+C Recovery (P0)

**File:** `~/.agentidev/cheerpx-assets/cheerpx-runtime.html` (lines 173-217)

Wrap `_cx.run()` in `Promise.race()` with a configurable timeout. On timeout, send Ctrl+C (charCode 3) via the `_sendFn` returned by `setCustomConsole`. Force-release `_spawnBusy` so the queue continues.

```javascript
function pumpSpawnQueue() {
  if (_spawnBusy || _spawnQueue.length === 0 || !_cx) return;
  var job = _spawnQueue.shift();
  _spawnBusy = true;
  var timeoutMs = (job.opts && job.opts.timeout) || 30000; // 30s default

  (async function () {
    var t0 = performance.now();
    _stdoutBuf = [];
    _stdoutCapturing = true;
    try {
      var result = await Promise.race([
        _cx.run(job.cmd, job.args || [], runOpts),
        new Promise(function (_, reject) {
          setTimeout(function () {
            // Try Ctrl+C before giving up
            if (_sendFn) _sendFn(3);
            reject(new Error('SPAWN_TIMEOUT: ' + job.cmd + ' after ' + timeoutMs + 'ms'));
          }, timeoutMs);
        }),
      ]);
      _stdoutCapturing = false;
      var stdout = _drainStdout();
      job.resolve({
        success: true,
        exitCode: result && typeof result.status === 'number' ? result.status : 0,
        stdout: stdout,
        elapsedMs: performance.now() - t0,
      });
    } catch (err) {
      _stdoutCapturing = false;
      var partialStdout = _drainStdout();
      job.resolve({
        success: false,
        exitCode: -1,
        stdout: partialStdout,
        error: err.message,
        timedOut: err.message.indexOf('SPAWN_TIMEOUT') === 0,
        elapsedMs: performance.now() - t0,
      });
    } finally {
      _spawnBusy = false;
      pumpSpawnQueue();
    }
  })();
}
```

**Key decisions:**
- Timeout resolves (not rejects) with `{ timedOut: true }` so callers get partial stdout
- Ctrl+C sent before timeout fires to give process a chance to exit
- `_spawnBusy` ALWAYS released in finally — queue never permanently jams
- Default 30s configurable per-command via `opts.timeout`
- Capture partial stdout before timeout for diagnostics

**Propagate timeout from handlers:**

In `cheerpx-handlers.js`, pass timeout from the caller:
```javascript
handlers['cheerpx-spawn'] = async (msg) => {
  return invokeTab('spawn', {
    cmd: msg.cmd, args: msg.args,
    opts: { timeout: msg.timeout || 30000 }
  });
};
```

In `host-handlers.js` HOST_EXEC_SPAWN:
```javascript
handlers['HOST_EXEC_SPAWN'] = async (msg) => {
  return handlers['cheerpx-spawn']({
    cmd: msg.cmd, args: msg.args,
    timeout: msg.timeout || 30000
  });
};
```

### Layer 2: CPU Activity Monitoring (P1)

**File:** `~/.agentidev/cheerpx-assets/cheerpx-runtime.html`

Register `cpuActivity` callback during init. If the CPU stays in "wait" state for >5s during a spawn, the process is likely hung — send Ctrl+C proactively before the full timeout.

```javascript
// In ensureInit(), after CheerpX.Linux.create:
var _lastCpuActivity = 0;
_cx.registerCallback('cpuActivity', function (state) {
  if (state === 'ready') _lastCpuActivity = performance.now();
});

// In pumpSpawnQueue(), add a stall checker:
var stallChecker = setInterval(function () {
  if (performance.now() - _lastCpuActivity > 5000 && _sendFn) {
    log('warn', 'CPU stalled >5s, sending Ctrl+C');
    _sendFn(3);
    clearInterval(stallChecker);
  }
}, 1000);
// Clear in finally block
```

### Layer 3: Queue Health Monitoring (P2)

**File:** `~/.agentidev/cheerpx-assets/cheerpx-runtime.html`

Add a new message handler `queue-status` that reports queue health. The dashboard or diagnostic tools can poll this to detect stuck queues.

```javascript
case 'queue-status':
  reply({
    busy: _spawnBusy,
    queueLength: _spawnQueue.length,
    booted: !!_cx,
    uptime: performance.now(),
  });
  break;
```

Expose via SW handler in `cheerpx-handlers.js`:
```javascript
handlers['cheerpx-queue-status'] = async () => {
  return invokeTab('queue-status', {});
};
```

## Files to Modify

| File | Change | Layer |
|------|--------|-------|
| `~/.agentidev/cheerpx-assets/cheerpx-runtime.html` | Promise.race timeout in pumpSpawnQueue, cpuActivity callback, queue-status handler | L1, L2, L3 |
| `extension/lib/handlers/cheerpx-handlers.js` | Pass timeout to invokeTab, add queue-status handler | L1, L3 |
| `extension/lib/handlers/host-handlers.js` | Pass timeout through HOST_EXEC_SPAWN | L1 |
| `extension/lib/host/host-chrome-extension.js` | Expose timeout option on host.exec.spawn | L1 |

## Testing

### Manual

1. Reload CheerpX tab
2. Run `/bin/echo hello` → verify works (~200ms)
3. Run `sqlite3 --version` → verify **times out after 30s** with `timedOut: true`
4. Run `/bin/echo after` → verify works (queue not jammed)

### Automated (test script)

```javascript
// test-cheerpx-timeout.mjs
client.assert(echo.exitCode === 0, 'echo works');
client.assert(sqlite.timedOut === true, 'sqlite3 timed out instead of hanging');
client.assert(sqlite.elapsedMs < 35000, 'timeout was ~30s');
client.assert(echoAfter.exitCode === 0, 'queue recovered after timeout');
```

## What This Does NOT Fix

- **The underlying hang** — sqlite3/Python imports still won't work. The image needs rebuilding for that.
- **Parallel execution** — queue stays serial. Multi-tab pool is a separate future enhancement.
- **Network access** — Tailscale integration is separate.

## What This DOES Fix

- **Queue resilience** — hung commands time out and release the queue
- **Partial output** — callers get whatever stdout was captured before timeout
- **Diagnostic visibility** — queue-status endpoint for monitoring
- **Graceful degradation** — plugins can detect `timedOut: true` and show a helpful message ("This command is not available in the current VM image")

## Verification

1. `npm test &` — 145+ tests pass
2. Reload CheerpX tab
3. Run echo → sqlite3 → echo. Before: second echo never returns. After: sqlite3 times out at 30s, second echo works.
4. Test from csv-analyzer/sqlite-query plugin UIs
