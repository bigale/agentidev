# Plan: CheerpX Runtime Refactor

Based on the full CheerpX API documentation (see `docs/cheerpx-api-reference.md`),
our current implementation uses workarounds for capabilities that CheerpX
provides natively. This refactor replaces the workarounds with the documented
APIs, making everything faster, cleaner, and more reliable.

---

## Current state (what we're replacing)

| Operation | Current approach | Problems |
|---|---|---|
| **File upload** (JS → VM) | Chunked base64: split into 32KB, `echo b64 \| base64 -d >> path` per chunk via `cx.run` | 11 cx.run calls for 332KB. Slow. Base64 inflation. Shell quoting fragile. 36MB tarball hit practical limit at ~8MB. |
| **File read** (VM → JS) | `cx.run('/bin/cat', [path])` → capture via childNode walking on `<pre>` | Lossy on binary. Requires the `<pre>` element. No clean binary path. |
| **Stdout streaming** | `MutationObserver` on vmConsole `<p>` children | Fragile. Depends on CheerpX's internal DOM structure. No stderr separation. No stdin. |
| **Process kill** | Drop the port mapping (chunks ignored, process runs to completion) | Not a real kill. No Ctrl+C. |
| **Console setup** | `cx.setConsole(preElement)` fallback because `setCustomConsole` "didn't work" | We called it with wrong signature (1 arg instead of 3). The `vt` filter was missing. |

## Target state (what we're building)

| Operation | New approach | Benefit |
|---|---|---|
| **File upload** | `DataDevice.writeFile('/file', bytes)` + `cx.run('/bin/cp', ['/data/file', '/dest'])` | ONE API call + ONE cp. No encoding, no chunking, no shell. Handles any size. |
| **File read** | `cx.run('/bin/cp', ['/src', '/files/out'])` + `idbDevice.readFileAsBlob('/out')` | Clean binary. Returns JS Blob. No stdout capture needed. |
| **Stdout streaming** | `setCustomConsole((buf, vt) => {...}, 80, 24)` with `vt === 1` filter | Real streaming. Raw bytes. TextDecoder. No DOM dependency. |
| **Process kill** | `send(3)` via the function returned by `setCustomConsole` | Real Ctrl+C. Immediate. |
| **Console setup** | `setCustomConsole` with correct 3-arg signature | Replaces both setConsole AND the MutationObserver hack. |

---

## Changes by file

### 1. `~/.agentidev/cheerpx-assets/cheerpx-runtime.html`

The biggest changes. This is the runtime page that hosts CheerpX.

**Init (`ensureInit`)**:
- Create a `DataDevice` for JS→VM file transfer. Mount at `/data`.
- Create a dedicated `IDBDevice` for VM→JS file extraction. Mount at `/files`.
- Call `setCustomConsole(writeFunc, 80, 24)` with the correct 3-arg signature.
  Store the returned `send` function for input injection / Ctrl+C.
- Filter output by `vt === 1` in `writeFunc`.
- Remove the `consoleEl` (`<pre id="vmConsole">`) from the DOM and from
  all stdout capture paths. It's no longer needed.

**Mounts in `Linux.create`**:
```js
_cx = await CheerpX.Linux.create({
  mounts: [
    { type: 'ext2',   path: '/',        dev: overlayDevice },
    { type: 'dir',    path: '/data',    dev: _dataDevice },    // NEW
    { type: 'dir',    path: '/files',   dev: _filesDevice },   // NEW
    { type: 'devs',   path: '/dev' },
    { type: 'devpts', path: '/dev/pts' },
    { type: 'proc',   path: '/proc' },
  ],
});
```

**Spawn (`spawnQueued` / `pumpSpawnQueue`)**:
- Replace the `startChildCount` / childNode-walking logic with per-spawn
  stdout buffer management using the `setCustomConsole` writeFunc callback.
- Each spawn: clear buffer before run, accumulate during run, drain after.
- The `writeFunc` callback fires in real-time during `cx.run()` so streaming
  spawn (`spawn-stream`) gets chunks pushed through immediately instead of
  polling via MutationObserver.

**File upload (`fs-upload`)**:
- Replace the chunked base64 loop with:
  ```js
  await _dataDevice.writeFile('/' + filename, bytes);
  await _cx.run('/bin/mkdir', ['-p', dir]);
  await _cx.run('/bin/cp', ['/data/' + filename, path]);
  ```
- No chunk loop, no base64, no shell quoting.

**File read (`fs-read` / `fs-read-bytes`)**:
- Replace `cx.run('/bin/cat', [path])` → childNode walk with:
  ```js
  await _cx.run('/bin/cp', [path, '/files/' + filename]);
  const blob = await _filesDevice.readFileAsBlob('/' + filename);
  // text: await blob.text()
  // binary: Array.from(new Uint8Array(await blob.arrayBuffer()))
  ```
- Clean binary support without xxd hex round-trip.

**Streaming spawn (`spawn-stream`)**:
- Replace MutationObserver with direct `setCustomConsole` writeFunc pushes.
- Each stdout chunk from `writeFunc` is posted back to the content script
  immediately — no observer delay.

**Kill**:
- Store the `send` function from `setCustomConsole`.
- On kill request: `_sendFn(3)` (Ctrl+C / ETX).
- Also expose a `spawn-kill` message type that sends Ctrl+C to the
  currently-running process.

### 2. `extension/cheerpx-content.js`

- Handle new `spawn-kill` message type by forwarding to the runtime page.
- No other changes needed — the content script is a generic relay.

### 3. `extension/lib/handlers/cheerpx-handlers.js`

- Wire `cheerpx-spawn-kill` handler (sends kill via the existing stream port
  or via a new invokeTab call).
- No changes to the fs-upload/read handlers — they just pass through to the
  runtime page which changes internally.

### 4. `extension/lib/host/host-chrome-extension.js`

- No API changes needed. `host.fs.upload`, `host.fs.read`, `host.exec.spawn`,
  `host.exec.spawnStream` all keep the same signatures. The improvements are
  internal to the runtime page.
- `ExecHandle.kill()` now actually sends Ctrl+C instead of just dropping the
  port mapping.

### 5. Other files

- `extension/lib/handlers/host-handlers.js` — no changes.
- `extension/smartclient-app/renderer.js` — no changes.
- `extension/apps/hello-runtime/` — no changes (same API).
- `extension/apps/horsebread/` — no changes (same API).

---

## Migration notes

- The `<pre id="vmConsole">` element stays in the HTML for backward compat
  but is no longer used for stdout capture. Can be removed in a future cleanup.
- The `fs-upload` chunked-base64 path is REMOVED, not kept as a fallback.
  If DataDevice doesn't work for some reason, we'd need to investigate rather
  than silently fall back to the slow path.
- The IDBDevice at `/files` is separate from the OverlayDevice's IDB (which
  uses `agentidev-cheerpx-overlay-v1` as its IndexedDB name). The new one uses
  `agentidev-cheerpx-files` so they don't collide.
- `setCustomConsole` disables `setConsole`. You can't use both simultaneously.
  Since we're switching to `setCustomConsole`, the `<pre>` element won't
  receive any output.

---

## Verification checklist

After the refactor, verify:

1. `host.fs.upload('/tmp/repo.tar.gz', 'http://localhost:9877/horsebread-repo.tar.gz')`
   uploads the 332KB tarball in ONE DataDevice.writeFile call (not 11 chunks)
2. `host.fs.read('/tmp/repo.tar.gz', { as: 'bytes' })` returns exact bytes
   via IDBDevice.readFileAsBlob (not xxd hex)
3. `host.exec.spawn('/usr/bin/python3', ['-c', 'print("a"); print("b")'])`
   returns `'a\nb\n'` (newlines preserved via setCustomConsole, not childNode walk)
4. `host.exec.spawnStream` chunks arrive in real-time via writeFunc callback
   (not MutationObserver polling)
5. `ExecHandle.kill()` sends Ctrl+C and the process actually stops
6. horsebread H2 pipeline still works end-to-end
7. hello-runtime dashboard buttons all still work
8. 145/145 Jest tests pass

---

## Estimated scope

The refactor is concentrated in ONE file (`cheerpx-runtime.html`). The rest
of the chain (content script → SW handlers → host surfaces → plugins) stays
the same because the API contracts are unchanged — only the internal
implementation of each runtime command changes.

This is a good candidate for a single-commit refactor branch since there's
no incremental value in landing partial changes (e.g., DataDevice without
setCustomConsole would leave two different stdout paths active).
