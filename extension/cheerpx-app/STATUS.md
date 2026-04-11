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
