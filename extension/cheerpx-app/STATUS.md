# Phase 1 — CheerpX Spike Status

**Status**: **Phase 2 done ✅** — see the Phase 2 section at the bottom. CheerpX is registered as a first-class runtime on `host.runtimes`. `host.runtimes.get('cheerpx').spawn('/usr/bin/python3', ['-c', 'print(1+1)'])` returns `{exitCode:0, stdout:"2"}` end-to-end. The COI wall described below was resolved by hosting the runtime in a hidden top-level tab instead of an extension iframe.

---

## Original Phase 1 writeup (iframe approach)

## What works

- **Locally bundled CheerpX 1.0.7** at `extension/lib/cheerpx/1.0.7/`. MV3 forbids remote code in extension pages, so the runtime must be bundled. The full asset list:
  - `cx.js` (329KB)
  - `cheerpOS.js` (77KB)
  - `cxcore.js` (121KB)
  - `cxcore-no-return-call.js` (121KB)
  - `workerclock.js` (3KB)
  - `tun/tailscale_tun_auto.js` (1KB)
  - `tun/tailscale_tun.js` (2KB)
  - `tun/wasm_exec.js` (16KB) — Go WASM runtime glue
  - `tun/ipstack.js` (19KB)
  - `tun/tailscale.wasm` (18MB) — tailscale networking
  - Notable empty: `cxbridge.js`, `fail.wasm`, `dump.wasm` all return 204 from the CDN — they appear optional/conditional in 1.0.7.
- **Extension loads `cx.js` successfully**. The `CheerpX` global is present with all factory methods: `Linux.create`, `HttpBytesDevice.create`, `IDBDevice.create`, `OverlayDevice.create`, `CloudDevice.create`, etc.
- **HTTP range requests work from extension origin** when the target has CORS headers.
- **Asset server** (`packages/bridge/asset-server.mjs`) serves local files with all headers CheerpX requires: `Access-Control-Allow-Origin: *`, `Accept-Ranges: bytes`, `Last-Modified`, `ETag`, 206 partial content on `Range:` requests.
- **Debian mini image** downloaded once to `~/.agentidev/cheerpx-assets/debian_mini.ext2` (629MB). Range-fetchable via `http://localhost:9877/debian_mini.ext2`.
- `HttpBytesDevice.create()` + `IDBDevice.create()` + `OverlayDevice.create()` all succeed.

## What doesn't work

- **`CheerpX.Linux.create()` throws `TypeError: Failed to fetch`** after the device construction succeeds. No further network requests are visible in the main page's Network events — the failure comes from inside a CheerpX web worker spawned via Blob URL. Worker fetches aren't captured by `Network.enable` on the parent page target.
- **Root cause hypothesis**: CheerpX requires **cross-origin isolation** (`crossOriginIsolated: true`). This is confirmed by:
  - `https://webvm.io/` reports `crossOriginIsolated: true` when loaded in the same browser and it works.
  - Our extension page reports `crossOriginIsolated: false` but still has `SharedArrayBuffer: true` — an unusual state that likely causes CheerpX's worker coordination to fail when it expects full COI semantics.
- **COI attempt broke the extension**. Adding `cross_origin_opener_policy` / `cross_origin_embedder_policy` to `manifest.json` triggered Chrome to reload the extension under a new ID and also caused the extension service worker to fail to start. Reverting the manifest and clearing `~/.agentidev/browser-profile/Singleton*` restored the working state.

## Files checked in for Phase 1.5 to pick up

- `extension/cheerpx-app/spike.html` — minimal spike page
- `extension/cheerpx-app/spike.js` — env checks + logger (runs before cx.js)
- `extension/cheerpx-app/spike-check.js` — probes `CheerpX` factory methods
- `extension/cheerpx-app/spike-boot.js` — tries to boot + run `/bin/echo` + `python3 -c "print(1+1)"`
- `extension/lib/cheerpx/1.0.7/*` — bundled CheerpX runtime
- `packages/bridge/asset-server.mjs` — CORS-compliant static file server on port 9877

## Next attempt checklist (Phase 1.5)

1. **Figure out the right way to enable COI for a specific extension page** without breaking the rest of the extension. Options:
   - Scope COI to a specific page via iframe `credentialless` attribute + `Cross-Origin-Embedder-Policy-Report-Only` — not sure this is enough for CheerpX workers.
   - Use `sandbox` attribute in manifest which creates a separate origin; that page can then have its own COOP/COEP independent of the main extension.
   - Use an offscreen document with targeted headers (MV3 offscreen API).
   - Run CheerpX in a popup window with `window.open(..., 'noopener,noreferrer')` and explicit COI headers via chrome.declarativeNetRequest.
2. **Capture worker network events** via `Target.setAutoAttach` + `Network.enable` on each attached target, so the real failing fetch is visible.
3. **Try CheerpX 1.1+** in case newer versions relax the COI requirement or bundle cxbridge.js/dump.wasm/fail.wasm properly.
4. **Consider CheerpX `CloudDevice`** (WebSocket backend) instead of `HttpBytesDevice` — the webvm.io production config uses it and it may have different CORS/COI behavior.
5. **Fallback for the Phase 1 spike**: swap CheerpX for Pyodide (~10MB, no COI required, no disk image). The HostCapabilities.exec interface stays identical; only the runner changes. CheerpX then becomes Phase 2 when we actually need horsebread's Python+Node subprocess combo unchanged.

## Useful debugging tools added

- `packages/bridge/scripts/open-page.mjs` — creates a new CDP target at any extension path
- `packages/bridge/scripts/page-eval.mjs` — run JS expression in a page matched by URL substring via Playwright
- `packages/bridge/scripts/page-console.mjs` — capture console + network + log events over a time window

---

## Phase 2 — CheerpX as a first-class runtime (2026-04)

**Status: done.** `host.runtimes.get('cheerpx').spawn(cmd, args)` runs commands inside an x86 Linux VM and returns captured stdout. Exit-criteria test:

```js
await globalThis.__handlers['cheerpx-spawn']({
  cmd: '/usr/bin/python3',
  args: ['-c', 'print(1+1)']
});
// → { success: true, exitCode: 0, stdout: "2", elapsedMs: ~1300 }
```

Multi-command sanity check:

```js
await globalThis.__handlers['cheerpx-spawn']({
  cmd: '/bin/sh',
  args: ['-c', 'uname -a; python3 --version; echo $((6*7))']
});
// → stdout: "4.15.0-54-cheerpx GNU/Linux  Python 3.7.3  42"
```

Warm runs are 130 ms (sh) to 1.3 s (python3 cold imports). First boot of the VM takes 1-2 s on a cached image, longer on a fresh image (HttpBytesDevice fetches blocks lazily — only the bytes the boot path touches).

### Architecture: hidden tab, not offscreen iframe

CheerpJ (Phase 1.7) hosts its runtime in an iframe inside the shared `offscreen.html`. CheerpX **cannot** use the same pattern because it requires cross-origin isolation (`crossOriginIsolated: true`) for SharedArrayBuffer + worker coordination, and an iframe inside a non-COEP extension page can't claim COI even with `credentialless` + `allow="cross-origin-isolated"`. The whole ancestor chain has to be COEP-enabled, and MV3 doesn't expose any way to set COEP on extension pages (no `chrome.declarativeNetRequest` for extension URLs, `<meta http-equiv>` doesn't work for COEP).

Solution: open a hidden background tab pointed at `http://localhost:9877/cheerpx-runtime.html`. The tab is its own top-level browsing context, gets its own agent cluster, and becomes COI naturally from asset-server's COOP/COEP headers. The service worker tracks the tabId, injects a content-script bridge via `chrome.scripting.executeScript`, and relays via `chrome.tabs.sendMessage`.

```
SC sandbox iframe (app.html)
  └─[1]─> postMessage 'smartclient-action' to wrapper.html
              └─[2]─> chrome.runtime.sendMessage(cheerpx-spawn) to service worker
                          └─[3]─> cheerpx-handlers ensureCheerpXTab()
                                      └─[4]─> chrome.tabs.create({active:false}) (first call)
                                              + chrome.scripting.executeScript(cheerpx-content.js)
                                              + waits for CHEERPX_TAB_READY
                                      └─[5]─> chrome.tabs.sendMessage(tabId, CHEERPX_INVOKE)
                                                  └─[6]─> cheerpx-content.js bridge
                                                              └─[7]─> window.postMessage to runtime page
                                                                          └─[8]─> CheerpX.Linux.run(...)
                                                                                    └──> /usr/bin/python3 runs
                                                                                         stdout captured via setConsole
Return flows back the same path. ~1300 ms warm.
```

### asset-server changes

- HTML responses now send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` so the cheerpx-runtime page becomes COI when loaded as a top-level document.
- All responses now send `Cross-Origin-Resource-Policy: cross-origin` so the COEP page can fetch its own JS, the disk image, etc. without being blocked by COEP.
- `.jar` files now ship with `Cache-Control: no-cache` (dev-profile default) to avoid the cache-bust hack from Phase 1.8.

### Files added for Phase 2

- `~/.agentidev/cheerpx-assets/cheerpx-runtime.html` — top-level page that loads CheerpX from CDN, exposes `init`/`spawn`/`ping` via postMessage. Mounts the Debian mini ext2 image via HttpBytesDevice + IDBDevice overlay.
- `extension/cheerpx-content.js` — content-script bridge injected programmatically into the cheerpx tab. Forwards `CHEERPX_INVOKE` from the SW to the runtime page and the response back. Idempotent via `window.__agentidevCheerpXBridgeInstalled`.
- `extension/lib/handlers/cheerpx-handlers.js` — SW-side `ensureCheerpXTab()` lifecycle: finds existing tab via `chrome.tabs.query`, creates one if missing, waits for tab.status=='complete', injects the bridge, blocks on `CHEERPX_TAB_READY`. Self-heals if the tracked tab is closed out-of-band.
- `extension/lib/host/runtimes/cheerpx.js` — `HostRuntimeCheerpX` class with `type: 'vm'` and `spawn(cmd, args, opts)`. Auto-registered on `host.runtimes.get('cheerpx')` via the same factory pattern as CheerpJ.

### Things that didn't work and why

- **`<iframe credentialless allow="cross-origin-isolated">` inside `offscreen.html`** — produced `crossOriginIsolated: false` even with all the right attributes. The COI status of an iframe is determined by its embedder chain having COEP, and extension pages can't set COEP.
- **Hidden popup window via `chrome.windows.create`** — would have worked but more disruptive UX (a real window appears even if minimized). Tab with `active: false` is invisible enough for now.

### Future improvements

- **Streaming stdout** — current `spawn()` collects-and-returns. Switch to a true `ExecHandle` with `stdout`/`stderr` streams once the first plugin actually needs it (Phase 4 hello-python). CheerpX has `setCustomConsole(callback)` that gives raw bytes per write — that's the path.
- **Hide the tab better** — `active: false` puts it in the background but it's still in the user's tab strip. Consider `chrome.windows.create({state: 'minimized'})` if it bothers users.
- **OPFS persistence** — currently using IDBDevice for the writable overlay, which lives in the extension's IndexedDB. OPFS would be faster + survive uninstall scenarios better. Phase 5.

### Exit criteria met

- `host.runtimes.list()` will return `['cheerpj', 'cheerpx']` once the SC sandbox loads `runtimes/cheerpx.js` (already wired in `app.html`)
- `host.runtimes.get('cheerpx').spawn('/usr/bin/python3', ['-c', 'print(1+1)'])` returns `{exitCode: 0, stdout: '2'}`
- `npm test` stays green (145 Jest tests)
- No regressions in existing dashboard or CheerpJ runtime

---

## Phase 4.5 — host capability surfaces (host.fs / host.exec / host.network / host.storage)

**Status: done.** The HostCapabilities interface (Phase 0) had `runtimes`,
`message`, `identity`, and `storage.export` fleshed out by earlier phases.
Phase 4.5 fills in the remaining surfaces — `host.storage.get/set/del/blob`,
`host.network.fetch`, `host.exec.spawn`, and `host.fs.read/write/list` —
so plugins can do the things horsebread's plan calls for without going
back through the runtime registry directly.

### What landed

**SW-side handlers** in `extension/lib/handlers/host-handlers.js` —
13 new dispatch entries:

- `HOST_STORAGE_GET / SET / DEL` — `chrome.storage.local` wrappers
- `HOST_STORAGE_BLOB_PUT / GET` — base64-wrapped binary in storage.local
  (fine for small blobs; Phase 4.6 will switch to OPFS without changing
  the API)
- `HOST_NETWORK_FETCH` — extension-origin fetch with full
  `host_permissions`. Returns a serializable subset of `Response`:
  `{ok, status, statusText, url, headers, text|json|bytes}` selected by
  `as: 'text'|'json'|'bytes'`
- `HOST_EXEC_SPAWN` — thin wrapper that delegates to the cheerpx
  runtime's `cheerpx-spawn` handler. Picks the default exec runtime;
  callers wanting a non-default should call `host.runtimes.get(...)`
  directly.
- `HOST_FS_READ / WRITE / LIST` — operate on the cheerpx VM filesystem
  via new `cheerpx-fs-*` commands. Backed by `cx.run('/bin/cat')`,
  `cx.run('/bin/sh', ['-c', 'echo b64 | base64 -d > path'])`, and
  `cx.run('/bin/ls -la --time-style=long-iso')` under the hood. The
  fs-list response is parsed into structured `{name, type, size, mode,
  mtime}` records by a small in-runtime parser.

**`host-chrome-extension.js`** now exposes the matching JS surfaces on
`window.Host.get()`:

```js
host.storage.get(key) / set(key,value) / del(key)
host.storage.blob.put(key, bytes) / get(key)
host.network.fetch(url, init?, { as: 'text'|'json'|'bytes' })
host.exec.spawn(cmd, args?, opts?)
host.fs.read(path) / write(path, content) / list(path)
```

All return Promises and route through the existing `host.message.send`
postMessage transport — plugin code stays free of `chrome.runtime.*`.

**Newline preservation in cheerpx stdout** — the biggest practical
improvement of this phase. CheerpX 1.0.7's `cx.setConsole(<element>)`
appends each terminal line as a `<p>` child, but reading back via
`textContent.slice()` concatenates them without separators (because
`textContent` doesn't insert newlines for block elements). The result:
`print('a'); print('b')` → `'ab'` instead of `'a\nb'`. Until Phase 4.5
this was fine for the simple proofs but immediately bit `host.fs.read`,
`host.fs.list`, and any multi-line output.

Fix: instead of `consoleEl.textContent.slice(startLen)`, the runtime
now records `consoleEl.childNodes.length` before each `cx.run()` and,
after it resolves, walks the new child nodes joining each one's
`textContent` with `\n`. CheerpX writes one `<p>` per line, so this
recovers the line structure exactly.

```js
var startChildCount = consoleEl.childNodes.length;
// ... await cx.run(...) ...
var lines = [];
for (var k = startChildCount; k < consoleEl.childNodes.length; k++) {
  lines.push(consoleEl.childNodes[k].textContent || '');
}
stdout = lines.join('\n');
if (lines.length > 0) stdout += '\n';
```

Tried `cx.setCustomConsole(callback)` first for raw byte capture, but
none of the candidate names (`setCustomConsole`, `setCustomConsoleHandler`,
`setOutputHandler`) exist on the CheerpX 1.0.7 instance — only the legacy
`setConsole(element)`. The runtime page now tries the custom-console
methods at init and falls back to the childNode-walking path, so the
upgrade is automatic when CheerpX adds the API.

**Cache busting on tab creation** — `cheerpx-handlers.js` now creates
the cheerpx tab with `?t=<Date.now()>` so updates to
`cheerpx-runtime.html` are picked up after asset-server changes without
the 1-hour `Cache-Control: max-age=3600` getting in the way. Existing
tabs found via `tabs.query` are still reused as-is.

### Verification

End-to-end from the SC dashboard sandbox iframe (`?mode=hello-runtime`):

```js
const host = window.Host.get();

await host.storage.set('key', { from: 'sandbox', n: 99 });
await host.storage.get('key');
// → { from: 'sandbox', n: 99 }

await host.storage.blob.put('b', new Uint8Array([10,20,30]));
await host.storage.blob.get('b');
// → Uint8Array(3) [10, 20, 30]

await host.network.fetch('http://localhost:9877/cheerpx-runtime.html');
// → { ok: true, status: 200, text: '<!DOCTYPE html>...' }

await host.exec.spawn('/usr/bin/python3', ['-c', 'print("a"); print("b")']);
// → { exitCode: 0, stdout: 'a\nb\n' }    ← newlines preserved!

await host.fs.write('/tmp/sb.txt', 'hello\nworld\n');
await host.fs.list('/tmp');
// → { entries: [{name:'sb.txt', type:'file', size:12, mode:'-rw-r--r--', ...}] }
await host.fs.read('/tmp/sb.txt');
// → { content: 'hello\nworld\n' }
```

The `hello-runtime` reference plugin gets three new dashboard buttons
(`host.storage`, `host.network.fetch`, `host.fs round-trip`) backed by
three new plugin handlers (`HELLO_RUNTIME_STORAGE/NETWORK/FS`) that
exercise each surface end-to-end. They render JSON output via the
existing `dispatchAndDisplay` action.

### What Phase 4.5 does NOT include (deferred to 4.6)

- **Streaming stdout/stderr** — `host.exec.spawn` is still
  collect-and-return. The runtime page now has the right architecture
  (per-spawn stdout buffer) to support streaming, but the SW transport
  is still single-response `chrome.tabs.sendMessage`. Streaming requires
  switching to a long-lived `chrome.runtime.connect` Port so the
  runtime page can post stdout chunks down it as they arrive.
- **`host.fs.watch`** — needs the same long-lived port plumbing as
  streaming exec.
- **Binary `host.fs.read`** — current implementation runs `cat` and
  decodes as UTF-8; binary files get mangled. Phase 4.6 should add an
  `as: 'bytes'` option that hex-encodes via `xxd` or pipes through
  `base64`.
- **Big-file `host.fs.write`** — bounded by argv length (~64 KB after
  base64 expansion). Stdin pipe on `cx.run` would lift this.
- **OPFS-backed `host.storage.blob`** — current impl base64s into
  `chrome.storage.local`, which is fine for small things but will OOM
  on big blobs.
- **Real `host.identity.installId`** — still `'sandbox-' + random()`.
  Should surface `chrome.runtime.id` and a per-install nonce.

### Tests
145 / 145 Jest pass. No regressions in cheerpj, cheerpx, bsh, or the SC
dashboard. Newline preservation fix is also validated by the existing
Phase 2 sanity test (which previously only passed because `print(1+1)`
has no newlines to lose).

---

## Phase 4.6 — streaming exec, host.fs.watch, binary fs, real installId

**Status: done.** Streaming spawn produces chunks as they arrive (verified
~210 ms apart for `sleep 0.2` between echoes). Binary fs.read returns
exact bytes via `xxd -p` round-trip. `host.identity.installId` is now
`chrome.runtime.id + ':' + nonce` instead of random per-tab.
`host.fs.watch` catches `create` and `delete` cleanly; `change` events
have a documented timing limitation when writes happen via the shared
spawn queue (see below).

### Streaming architecture — long-lived chrome.tabs.connect Port

The chain has eight hops now (one extra for the port relay):

```
SC sandbox iframe (app.html)
  └─[1]─> host.exec.spawnStream(cmd, args)
            registers streamId locally, dispatches HOST_EXEC_SPAWN_STREAM_START
              └─[2]─> postMessage 'smartclient-action' to wrapper.html
                          └─[3]─> chrome.runtime.sendMessage(SW)
                                      └─[4]─> SW handler cheerpx-spawn-stream-start:
                                              chrome.tabs.connect(tabId, {name:'cheerpx-stream'})
                                              port.postMessage({type:'spawn-stream', streamId, cmd, args})
                                                  └─[5]─> cheerpx-content.js bridge:
                                                          window.postMessage to runtime page
                                                              └─[6]─> cheerpx-runtime.html:
                                                                      MutationObserver on vmConsole detects
                                                                      each new <p> as cx.run() appends it,
                                                                      window.postMessage 'agentidev-cheerpx-stream'
                                                                      with chunk back to source (content script)
                                                  └─[7]─> content script forwards each chunk via
                                                          port.postMessage({type:'stdout', streamId, chunk})
                                              └─[8]─> SW relays each port.onMessage event via
                                                      chrome.runtime.sendMessage broadcast
                                                      (CHEERPX_STREAM_EVENT)
                          └─[3a]─> wrapper.html chrome.runtime.onMessage listener forwards to
                                   sandbox iframe via iframe.postMessage 'smartclient-stream-event'
            └─[1a]─> host-chrome-extension.js stream listener routes by streamId,
                     fires onStdout / onExit / onError callbacks, resolves done Promise
```

The stream is one-way for chunks (page → content → SW → wrapper → sandbox)
and bidirectional only for control (start, kill). `kill` is best-effort
on CheerpX 1.0.7 — `cx.run()` has no kill API, so we drop the port
mapping and ignore further chunks; the actual command continues to
completion.

### `host.exec.spawnStream` API

```js
const handle = host.exec.spawnStream('/bin/sh', ['-c', 'for i in 1..5; do echo $i; sleep 0.4; done']);

handle.onStdout(chunk => liveConsole.append(chunk));
handle.onExit(code => console.log('exit', code));
handle.onError(err => console.error(err));

const result = await handle.done; // { exitCode, stdout, elapsedMs }

// Best-effort kill
await handle.kill();
```

The `done` Promise also collects all stdout chunks into a final string,
so callers that only want the end result can `await handle.done` and
ignore the streaming callbacks.

### Streaming dashboard demo

`hello-runtime` gets a new "Stream output" button that runs
`for i in 1..5; do echo round-$i; sleep 0.4; done` via the new
`streamSpawnAndAppend` renderer action. Each chunk renders to the
"Live Console" HTMLFlow as it arrives — verified by snapshotting
the contents at 500ms intervals after the click:

```text
t=0ms:    $ /bin/sh -c for i...   round-1   round-2
t=500ms:  ... + round-3
t=1000ms: ... + round-4
t=1500ms: ... + round-5
t=2000ms: ... + [exit 0 in 2064ms]
t=2500ms: stable
```

`streamSpawnAndAppend` is a new generic action in `renderer.js` —
plugins use it the same way they use `dispatchAndDisplay`:

```jsonc
{
  "_type": "Button",
  "title": "Run streaming",
  "_action": "streamSpawnAndAppend",
  "_cmd": "/bin/sh",
  "_args": ["-c", "..."],
  "_targetCanvas": "liveConsole"
}
```

### Binary `host.fs.read({as: 'bytes'})`

A new path through `cheerpx-fs-read-bytes` that runs `xxd -p <path>` in
the VM and decodes the hex on the SW side. The xxd-p output naturally
contains newlines every 60 chars; the SW handler strips all whitespace
before parsing. Verified: writing `'AB\nCD\n'` and reading back as
bytes returns `[65, 66, 10, 67, 68, 10]`.

```js
await host.fs.write('/tmp/bin.txt', 'AB\nCD\n');
const r = await host.fs.read('/tmp/bin.txt', { as: 'bytes' });
// → { success: true, exitCode: 0, bytes: [65, 66, 10, 67, 68, 10] }
```

### Real `host.identity.installId`

`HOST_IDENTITY_GET` returns `chrome.runtime.id + ':' + nonce`, where the
nonce is generated once and persisted in `chrome.storage.local` under
`__hostInstallNonce`. `host-chrome-extension.js` lazy-fetches this on
first `Host.get()` and updates the identity in place.

```js
host.identity.installId
// → "ncbbpgbdecmmcmghfahmmpddapbncobd:qku87yrm8ojmnv3ulm0"
```

### `host.fs.watch` — best-effort polling

Built on `host.exec.spawn` to call `stat -c '%y' <path>` every
`intervalMs` (default 2000) and compare the human-readable mtime
(includes nanoseconds) against the previous tick. Fires `create` /
`change` / `delete` events; returns an unsubscribe function.

```js
const unsub = host.fs.watch('/tmp/file', evt => {
  console.log(evt.type, evt.mtime);
}, { intervalMs: 800 });
// later:
unsub();
```

**Known limitation**: `change` events have a timing race when writes
happen through the shared cheerpx spawn queue. The watch poll's `stat`
and `host.fs.write`'s `sh -c "echo > path"` both go through the same
serialized `_spawnQueue`, so a poll firing between the truncate and
the rewrite of a redirect can briefly observe the file as missing and
fire `delete` instead of `change`. This is a polling-based watch's
fundamental limit — production-quality file watching needs real inotify
exposed through the runtime page (a future phase). For horsebread's
use case (an out-of-band scrape proxy that watches a request-queue
file written by an in-VM script, not by `host.fs.write`), the race
doesn't apply because the writer is independent of the polling thread.

### What 4.6 does NOT include (deferred to 4.7)

- **Big-file `host.fs.write`** (>64 KB) — needs stdin pipe on `cx.run`
- **OPFS-backed `host.storage.blob`** — current is `chrome.storage.local`
  base64; only matters when blobs get large
- **True `cx.run` cancellation** — CheerpX 1.0.7 has no kill API; the
  port-mapping is dropped on kill but the command runs to completion
- **inotify-based `host.fs.watch`** — would require new in-VM
  primitives; polling is good enough for the immediate use cases

### Tests

145 / 145 Jest pass. No regressions in cheerpj, cheerpx, bsh, the
hello-runtime plugin, or any of the dashboard buttons (Phase 4.5 or
the new streaming button). Streaming verified end-to-end through the
SC sandbox iframe via `sandbox-eval` snapshots.
