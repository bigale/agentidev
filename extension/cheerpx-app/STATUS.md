# Phase 1 — CheerpX Spike Status

**Status**: partial. Bundle + asset server working, hitting cross-origin isolation wall. Needs dedicated Phase 1.5 to resolve COI without breaking the rest of the extension.

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
