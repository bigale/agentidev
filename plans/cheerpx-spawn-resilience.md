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

### Root Cause: Entropy Starvation (getrandom blocking)

The hangs are caused by **entropy starvation**. CheerpX's browser VM has no hardware entropy sources (no disk I/O jitter, no keyboard interrupts, no RDRAND). Debian Buster's kernel 4.19 blocks `getrandom()` until the entropy pool initializes — which never happens in a browser.

**Every symptom fits:**
- `sqlite3` calls `sqlite3OsRandomness()` → `getrandom()` → blocks forever
- `python3 import json` triggers hash randomization via `getrandom()` at startup → blocks
- `python3 -c "print(42)"` works: fast path before any C extension needing randomness
- `echo/ls/cp` work: never touch `/dev/urandom` or `getrandom()`
- `apt-get update`: SSL/TLS init calls `getrandom()` before even attempting DNS

See: Python bugs #26839, #25420; PEP 524; Debian BoottimeEntropyStarvation wiki.

**Ctrl+C won't help** for these hangs — the process is blocked in a kernel syscall (getrandom), not in userspace. But the timeout wrapper still prevents queue jams.

### Quick Fixes for Specific Tools

| Tool | Fix | How |
|------|-----|-----|
| Python | `PYTHONHASHSEED=0` env var | Disables hash randomization, skips `getrandom()` |
| sqlite3 | None known (calls from C, can't skip) | Needs image-level fix |
| Any | `LD_PRELOAD` fake `getrandom()` | Stub .so returns /dev/urandom-style bytes |
| All | Install `haveged` in image | Generates entropy from CPU jitter |
| All | Newer kernel (>= 5.4) | In-kernel jitter entropy collector |

### Known Hangs in Current Image

- `sqlite3` — any invocation (calls getrandom via sqlite3OsRandomness)
- `python3 import <anything>` — hash randomization calls getrandom
- Any SSL/TLS operation — OpenSSL init calls getrandom
- Any network operation (no Tailscale + no entropy)

### What Works

- `/bin/echo`, `/bin/ls`, `/bin/cp`, `/bin/cat` — ~200ms (no getrandom)
- `python3 -c "print(42)"` — ~1.3s (fast path, no imports)
- `python3` with `PYTHONHASHSEED=0` — should work with imports (bypasses getrandom)
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

## PYTHONHASHSEED=0 Results (Confirmed Apr 2026)

Setting `PYTHONHASHSEED=0` in env bypasses Python's hash randomization `getrandom()` call. Results:

| Import | With PYTHONHASHSEED=0 | Without |
|--------|----------------------|---------|
| json | 1.8s ok | HANG |
| csv | 1.9s ok | HANG |
| re | 1.3s ok | HANG |
| **sqlite3** | **1.9s ok (v3.27.2)** | HANG |
| hashlib | 1.6s ok | HANG |
| openpyxl | HANG (C-level getrandom via OpenSSL) | HANG |
| bs4 | untested | HANG |

**Key insight:** The sqlite3 CLI binary still hangs (calls getrandom from C), but Python's sqlite3 module works. The sqlite-query plugin should use `python3 -c "import sqlite3..."` instead of the `sqlite3` binary.

**Default PYTHONHASHSEED=0 for all CheerpX Python spawns** — add to the runtime page's spawn opts automatically when cmd contains `python`.

## What This Does NOT Fix

- **sqlite3 CLI binary** — calls getrandom from C, no Python env var helps
- **openpyxl / any library triggering OpenSSL** — C-level getrandom calls
- **Parallel execution** — queue stays serial
- **Network access** — Tailscale integration is separate
- **Image-level fix** — installing haveged or LD_PRELOAD getrandom stub would fix ALL hangs

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
