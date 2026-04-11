# Phase 1.5 — CheerpJ Spike Status

**Status**: **DONE ✅** — Phases 1.6 and 1.7 both landed. CheerpJ is now a first-class runtime on the `host.runtimes` registry. Any extension page can call `host.runtimes.get('cheerpj').runMain(...)` and get Java output back in ~1 second. See the Phase 1.7 section at the bottom for the final architecture.

---

## Original Phase 1.5 writeup (sandbox approach — abandoned)

## What works

- **CheerpJ 4.0 locally bundled** at `extension/lib/cheerpj/4.0/` (7 files, ~4 MB total):
  - `loader.js` (7.5 KB) — stack-trace-based path detection, works with `chrome-extension://` URLs
  - `cj3.js` (626 KB) — main Cheerp-compiled runtime
  - `cj3.wasm` (474 KB) — core WASM
  - `cj3n8.wasm` (2.7 MB) — Java 8 runtime variant
  - `cj3n11.wasm` (2.7 MB) — Java 11 runtime variant
  - `cheerpOS.js` (81 KB) — virtual OS layer
  - `x11.wasm` (204 KB) — X11 support (pulled by AWT; may be optional)
- **MV3 sandbox page required.** The main `extension_pages` CSP `'self' 'wasm-unsafe-eval'` blocks `new Function(...)` which CheerpJ uses to JIT-compile Java bytecode. Adding the page to `manifest.sandbox.pages` lets it use `'unsafe-eval'`.
- **`cheerpjInit({ version: 11 })` completes successfully in 60-90ms**, inside the sandbox, with all APIs exposed:
  - `cheerpjRunMain`, `cheerpjRunJar`, `cheerpjRunLibrary`, `cheerpOSAddStringFile`, `cjFileBlob`, etc.
- **Test JAR builds and injects cleanly.** `/tmp/cheerpj-hello/com/agentidev/Hello.java` compiled with `javac -source 8 -target 8`, packaged to `hello.jar` (881 bytes), served from `extension/cheerpj-app/jars/hello.jar`, pre-fetched via `fetch()` + `arrayBuffer()`, injected via `cheerpOSAddStringFile('/str/hello.jar', bytes)`. All three steps succeed within 2ms total.
- **CDP debugging tooling** for sandbox iframes in `packages/bridge/scripts/`:
  - `open-page.mjs` — open extension URL in a new tab
  - `direct-eval.mjs` — bypass Playwright's page cache and eval via raw CDP
  - `reset-spike.mjs` — close all spike tabs and reopen fresh
  - `close-stale.mjs` — cleanup helper
  - `page-eval.mjs`, `page-console.mjs` — general debugging

## What doesn't work yet

- **`cheerpjRunLibrary('/str/hello.jar')` does not resolve within 30 seconds** on a fresh post-init call. The Promise just sits there with no error, no console output, no visible network activity (worker fetches aren't captured by parent-page CDP Network events — same blind spot we hit in Phase 1 CheerpX).
- **Second call fails with "Only one library thread supported"** — CheerpJ apparently only allows one concurrent library thread. Running `cheerpjRunLibrary` a second time before the first settles errors out.
- **One prior call DID resolve in ~8 seconds** during this session (to an opaque object), but the class-path walk afterwards (`await lib.java`, `await javaPkg.lang`, etc.) either hung or returned empty.

## Hypotheses for the hang

Most likely → least likely:

1. **Missing JRE resources.** `cheerpjRunLibrary` tries to resolve classes in the JAR (like `java.lang.Object`, `java.lang.String`) against the Java runtime library. The cj3.js code explicitly references `/jre/lib/rt.jar`, `/jre/lib/charsets.jar`, `/jre/lib/cheerpj-awt.jar`, etc. All of those return `204 No Content` from `https://cjrtnc.leaningtech.com/4.0/` on direct probe. AAV works in production, so the JRE MUST be accessible somehow — probably either:
   - Bundled into `cj3n8.wasm` / `cj3n11.wasm` (which are 2.7 MB each — plausible for a compressed JRE image)
   - Served from a different CDN path we haven't found
   - Lazily fetched from a path that returns 204 on HEAD but actual bytes on a range-GET from CheerpJ's internal loader
2. **Extension URL resolution quirk.** CheerpJ's XHR-based resource loader may not handle `chrome-extension://` base URLs correctly in all code paths. One path (cheerpOS.js + cj3n8.wasm) works; another (class loading during run-library) may not.
3. **Proxy serialization hazard.** `cheerpjRunLibrary` returns a JS Proxy whose properties are lazily-awaitable. Each `await ref[part]` may require a roundtrip through a CheerpJ worker. In a sandboxed iframe with CSP restrictions, the worker coordination may be slower or broken.
4. **CORS/credentialless issue on the extension origin.** The `null` origin of sandbox pages combined with `chrome-extension://` resource paths may trip up CheerpJ's XHR code in some way that isn't visible.

## Known-good reference (AAV, documented 2026-02)

From `/home/bigale/repos/agentauthvault/docs/CHEERPJ-ANALYSIS.md`:

1. Load `<script src="https://cjrtnc.leaningtech.com/4.0/loader.js"></script>` from CDN (remote — we can't do this in MV3)
2. Call `await window.cheerpjInit({ version: 11 })`
3. `await (await fetch(jarUrl)).arrayBuffer()` → `cheerpOSAddStringFile('/str/name.jar', bytes)`
4. `const lib = await cheerpjRunLibrary('/str/name.jar')` — **this is where AAV succeeds and we hang**
5. Walk dot-path: `for (const part of 'com.aav.fhir.FhirValidator'.split('.')) ref = await ref[part];`
6. `const result = await ref.validate(fhirJson, profileUrl)`

The only difference between AAV's working code and our hanging code is the hosting context. AAV hosts CheerpJ from the CDN; we bundle and host from `chrome-extension://<id>/lib/cheerpj/4.0/`. One of the code paths CheerpJ takes during run-library is probably expecting the origin to be the CDN, or to be a "normal" HTTP origin, not a sandbox `null` origin inside a chrome extension.

## Files staged for Phase 1.5 continuation

- `extension/cheerpj-app/spike.html` — loads CheerpJ + runs spike scripts
- `extension/cheerpj-app/spike.js` — env checks + logger
- `extension/cheerpj-app/spike-init.js` — calls `cheerpjInit()`
- `extension/cheerpj-app/jars/hello.jar` — tiny Java 8 test JAR
- `extension/lib/cheerpj/4.0/` — full bundled runtime
- `extension/manifest.json` — sandbox page entry + web_accessible_resources for cheerpj/cheerpx paths
- `packages/bridge/scripts/{open-page,page-eval,page-console,direct-eval,reset-spike,close-stale}.mjs` — debugging tools

## Next attempt checklist (Phase 1.6)

1. **Find where the JRE really lives.** Either:
   - Launch CheerpJ from its public CDN in our Playwright browser (outside the extension context) and watch the Network tab to see what URLs the working version fetches when running a JAR. Mirror those URLs into our local bundle.
   - Or dump `cj3n8.wasm` and check if it embeds a JRE image.
2. **Capture worker fetches.** Set up `Target.setAutoAttach` to enable `Network.enable` on CheerpJ's worker targets — the run-library blocking fetch is probably happening in a worker we can't see from the parent page.
3. **Try `version: 8` vs `version: 11`.** Different JRE layouts (`rt.jar` vs `lib/modules`). If one works and the other doesn't, we know which one CheerpJ is actually bundling.
4. **Try `cheerpjRunMain` instead of `cheerpjRunLibrary`.** It has a different code path. If one works and the other doesn't, we know where in CheerpJ the failure is.
5. **Try hosting CheerpJ from the asset server** (`localhost:9877`) instead of `chrome-extension://`. If it works there, we've proven the issue is specifically about extension origin handling inside CheerpJ, and we can work around it via a relay layer.
6. **If all else fails**: open an issue with Leaning Technologies (they're generally responsive on their Discord) describing the CheerpJ-in-MV3-sandbox state.

---

## Update 2026-04 — deep network capture session

After the Phase 1.5 commit, I ran a focused debugging session using
`Target.setAutoAttach(flatten: true)` with `waitForDebuggerOnStart: true`
to capture worker-level network events across the CheerpJ iframe. What we
found:

### CDN test (known-good baseline)

Loaded `http://localhost:9877/cheerpj-test.html` (hosted by asset-server,
**NOT** inside the extension) which uses the public CheerpJ CDN loader.
`cheerpjRunLibrary` **resolved in ~4.8 seconds** to a real object.

Observed network fetches — 25 unique URLs including:

```
https://cjrtnc.leaningtech.com/4.0/loader.js
https://cjrtnc.leaningtech.com/4.0/cj3.js
https://cjrtnc.leaningtech.com/4.0/cj3.wasm
https://cjrtnc.leaningtech.com/4.0/cj3n8.wasm     ← note: 8, not 11
https://cjrtnc.leaningtech.com/4.0/cheerpOS.js
https://cjrtnc.leaningtech.com/4.0/cheerpj.css
https://cjrtnc.leaningtech.com/4.0/c.html
https://cjrtnc.leaningtech.com/4.0/c.js           ← critical support file
https://cjrtnc.leaningtech.com/4.0/8/jre/lib/rt.jar          (26.8 MB)
https://cjrtnc.leaningtech.com/4.0/8/jre/lib/charsets.jar    (1.8 MB)
https://cjrtnc.leaningtech.com/4.0/8/jre/lib/jce.jar
https://cjrtnc.leaningtech.com/4.0/8/jre/lib/jsse.jar
https://cjrtnc.leaningtech.com/4.0/8/jre/lib/resources.jar
https://cjrtnc.leaningtech.com/4.0/8/jre/lib/javaws.jar
https://cjrtnc.leaningtech.com/4.0/8/jre/lib/cheerpj-awt.jar
https://cjrtnc.leaningtech.com/4.0/8/lib/ext/localedata.jar
https://cjrtnc.leaningtech.com/4.0/8/lib/ext/sunjce_provider.jar
https://cjrtnc.leaningtech.com/4.0/8/lib/ext/meta-index
https://cjrtnc.leaningtech.com/4.0/8/lib/ext/index.list
https://cjrtnc.leaningtech.com/4.0/etc/users
https://cjrtnc.leaningtech.com/4.0/etc/localtime
```

**Key discovery**: the JRE lives at paths like `/4.0/8/jre/lib/rt.jar` —
with a **`/8/` version prefix** inside the path. Earlier probes of
`/4.0/jre/lib/rt.jar` (without `/8/`) returned 204 because that path
doesn't exist. I've since mirrored the full set into
`extension/lib/cheerpj/4.0/` preserving the nested structure (~39 MB
total for the Java 8 runtime).

### Extension test (still hanging)

Even with the full JRE bundled locally AND the correct path structure,
`cheerpjRunLibrary` inside the extension sandbox iframe still hangs
indefinitely. The iframe session shows only these network events after
our trigger runs:

```
GET cheerpOS.js   200
GET c.js          200
```

And **nothing else**. No JRE fetches, no further requests.

### Root cause discovery: c.js

`c.js` (4KB) contains explicit handling for `chrome-extension:` origin
that was designed for MV2 content scripts:

```js
if (location.protocol == "chrome-extension:") {
  packagePromise = new Promise(s => chrome.runtime.getPackageDirectoryEntry(s));
  extensionUrlPrefix = "chrome-extension://" + chrome.runtime.id + "/";
}
```

`chrome.runtime.getPackageDirectoryEntry` is a **deprecated MV2-only
API** that **never fires its callback in MV3**. Inside the iframe (which
actually does have access to `chrome.runtime` because c.html is an
extension page), the packagePromise hangs forever, and every file-load
message from the main cj3.js worker waits on it.

### Patch attempted

Modified our local `extension/lib/cheerpj/4.0/c.js` to force the
fall-through DirectDownloader (XHR) path regardless of protocol:

```js
console.log('[cj-c.js] loaded at', location.href, '- forcing DirectDownloader path');
var controlPort = null;
var packagePromise = null;
var extensionUrlPrefix = null;
// (chrome.runtime block removed entirely)
```

### Patch revealed a second problem

With the c.js patch in place, the extension still hangs. Added debug
logging inside `handleMessage` to trace incoming postMessages. **The
iframe c.js log shows it loads correctly but never receives ANY
postMessage from its parent** — not even the initial `{t:'port'}`
handshake. `controlPort` stays `null`, no "load" messages ever arrive,
no JRE fetches ever happen.

**This suggests a MessagePort transfer issue across the sandbox → extension-iframe boundary.** cj3.js in the sandboxed spike.html tries
to do `iframe.contentWindow.postMessage({t:'port', port: port2}, '*', [port2])` but either:

- The targetOrigin mismatch (sandbox `null` origin → child iframe
  which may or may not also be null origin) silently drops the message
- OR the MessagePort transfer fails across the boundary
- OR cj3.js is waiting for the iframe `load` event and that event
  never fires the way cj3 expects under sandbox semantics

### Files modified (committed)

- `extension/lib/cheerpj/4.0/` — full bundle including:
  - loader.js, cj3.js, cj3.wasm, cj3n8.wasm, cj3n11.wasm, cheerpOS.js,
    x11.wasm, c.html, c.js (patched), cheerpj.css
  - `8/jre/lib/*.jar` — Java 8 runtime (rt, charsets, jce, jsse,
    resources, javaws, cheerpj-awt) — 39 MB
  - `8/lib/ext/*` — extensions (localedata, sunjce_provider, meta-index)
  - `etc/users` — auxiliary config file

### Real next step (Phase 1.6)

The problem is **not** "CheerpJ missing resources" anymore. We now have
the full runtime + JRE bundled locally. The problem is specifically
**postMessage MessagePort transfer across the chrome-extension sandbox
boundary**. Investigation paths:

1. **Run CheerpJ in a non-sandboxed extension page** with
   `'unsafe-eval'` explicitly in `content_security_policy.extension_pages`.
   MV3 allows `'unsafe-eval'` in extension_pages — verify by adding it.
   If this works, we sidestep the sandbox iframe issue entirely.

2. **Add instrumentation to cj3.js** (via a monkey-patch in spike-init.js)
   to log every `postMessage` call it makes. Confirm the parent is
   sending the port handshake.

3. **Use `window.open()` instead of an iframe** for c.html. If cj3 has
   a mode where the helper is in a popup rather than an iframe, the
   sandbox rules don't apply.

4. **Investigate `cheerpjRunMain`** — it might take a different
   communication path that doesn't need the MessageChannel bridge.

5. **Test CheerpJ in an offscreen document** (MV3 offscreen API) —
   offscreen docs have relaxed CSP that allows `unsafe-eval` AND are
   not sandboxed, so both requirements are satisfied.

**Recommended first attempt**: option 1. Add `'unsafe-eval'` to
`extension_pages` CSP, remove cheerpj-app/spike.html from sandbox.pages,
retry. If the CheerpJ main-page check for `chrome.runtime.getPackageDirectoryEntry`
passes (because chrome.runtime IS available in a non-sandboxed extension
page with full chrome.* access), we may actually work WITHOUT the c.js
patch because the package-directory-entry API might need... let me check
MV3 docs for whether `getPackageDirectoryEntry` was removed or just
changed.

---

## Phase 1.6 — RESOLUTION (2026-04)

The sandbox-based approach was the wrong path. Key facts:

- `'unsafe-eval'` in `extension_pages` CSP: **forbidden by MV3**. Adding
  it causes silent extension load failure, no service worker starts.
  Confirmed by direct test.
- Sandbox pages allow `unsafe-eval` but break MessagePort transfer across
  the sandbox boundary, so CheerpJ's c.html iframe never receives the
  port handshake.
- `chrome.runtime.getPackageDirectoryEntry` is a deprecated MV2 API that
  never fires its callback in MV3.

### The fix: localhost iframe inside a regular extension page

Architecture:

```
chrome-extension://<id>/cheerpj-app/cheerpj.html   (regular extension page,
                                                    non-sandboxed, has
                                                    chrome.runtime access)
  │
  │  postMessage with cache-busted src
  │
  └── iframe src="http://localhost:9877/cheerpj-runtime.html?t=<ts>"
                                                    (real http:// origin,
                                                    served by agentidev
                                                    asset-server.mjs)
        │
        │  CheerpJ loads normally from its public CDN
        │  (external scripts allowed in http:// pages)
        │
        └── <script src="https://cjrtnc.leaningtech.com/4.0/loader.js">
              │
              └── Creates its own c.html iframe at the CDN origin.
                  MessagePort handshake works because both iframes are
                  in normal web origins. c.js takes the DirectDownloader
                  path because location.protocol is "https:" (from CDN).
                  JRE fetches work normally.
```

**Why it works:**

1. The extension page is regular (not sandboxed) — inline script
   restriction applies (fixed by moving cache-buster to external file)
   but no other weirdness.
2. `frame-src http://localhost:9877` in `content_security_policy.extension_pages`
   allows embedding the localhost iframe.
3. The localhost iframe has a normal `http://` origin — CheerpJ's own
   code paths treat it as a standard web page. No MV3 constraints apply
   inside it. CheerpJ uses `'unsafe-eval'` freely.
4. The nested CDN c.html iframe is at `https://cjrtnc.leaningtech.com/` —
   also normal, same-origin as loader.js, port handshake works.
5. JARs are fetched by the extension host page (which has
   `host_permissions: ["<all_urls>"]`) and shipped as bytes via
   postMessage to the localhost iframe, which injects them via
   `cheerpOSAddStringFile`.

**Critical workaround: use `cheerpjRunMain`, not `cheerpjRunLibrary`.**
The Proxy-walk pattern documented in the AAV CheerpJ integration
(`await lib.java.lang.System.currentTimeMillis()`) hangs indefinitely in
this nested-iframe context. The first proxy access (`await lib.com`)
never resolves. Not sure why — it works in AAV's React SPA context but
not here. Workaround: compile a Java class with a `public static void
main` that prints results to stdout, run via `cheerpjRunMain`, capture
the intercepted `console.log` output. This is a different CheerpJ code
path that does not rely on the class-walking Proxy.

### Files delivered

New platform files:

- `extension/cheerpj-app/cheerpj.html` — non-sandboxed extension host page
- `extension/cheerpj-app/cheerpj-cachebust.js` — sets iframe src with
  cache-busting query string (inline scripts blocked by MV3)
- `extension/cheerpj-app/cheerpj-host.js` — `window.CheerpJHost` with
  `ping()`, `init()`, `runMain({ jarUrl, className, args, cacheKey })`
- `extension/cheerpj-app/jars/hello-main.jar` — test JAR with
  `public static void main` (1033 bytes)
- `extension/lib/host/runtimes/cheerpj.js` — `CheerpJRuntime` class
  implementing the Runtime interface from `host-interface.js`. Library-
  type runtime with a `runMain()` method. (Host registration is Phase
  1.7; for now the runtime class exists and can be called from inside
  cheerpj-app via `window.CheerpJHost.runMain(...)`.)

New asset-server files:

- `~/.agentidev/cheerpx-assets/cheerpj-runtime.html` — the actual
  CheerpJ host page, served at `http://localhost:9877/cheerpj-runtime.html`.
  Loads CheerpJ from the public CDN, handles postMessage commands
  (`ping`, `init`, `runMain`), intercepts `console.log` to capture
  stdout during `cheerpjRunMain` execution.
- `~/.agentidev/cheerpx-assets/hello-main.jar` — copy of the test JAR
  (unused since the extension host fetches from its own resource path;
  kept for standalone testing).

Manifest changes:

- Removed `cheerpj-app/spike.html` from `sandbox.pages` (no longer
  needed — not a sandbox anymore).
- Added `frame-src 'self' http://localhost:9877 http://127.0.0.1:9877`
  to `content_security_policy.extension_pages` to allow the iframe.

### End-to-end demonstration

```js
// From the extension host page console (or any caller with
// access to window.CheerpJHost):
const r = await window.CheerpJHost.runMain({
  jarUrl: "jars/hello-main.jar",
  className: "com.agentidev.Hello",
  args: ["agentidev"],
  cacheKey: "hello-main"
});
// {
//   success: true,
//   exitCode: 0,
//   stdout: "CheerpJ runtime ready\n
//            Class is loaded, main is starting\n
//            AGENTIDEV_HELLO_VERSION=hello-0.1.0\n\n\n
//            AGENTIDEV_HELLO_GREET=Hello, agentidev!\n\n"
// }
// Elapsed: 1.3 seconds on subsequent calls (CheerpJ already warm)
```

### What Phase 1.6 does NOT fix

- **Proxy-walk loadLibrary + callStatic pattern** is still blocked.
  We go through `runMain` for now. When/if we need library mode (e.g.
  to call a method repeatedly without re-running main), this needs
  dedicated debugging. AAV makes it work in a React SPA — the nested
  iframe context is the difference, and we don't fully understand why.

### Phase 1.7 — next increment

1. **Wire the cheerpj runtime into `host.runtimes.register('cheerpj', ...)`
   at boot.** Requires the wrapper/service-worker message relay to route
   `cheerpj-*` messages to the cheerpj-app page. Or use
   `chrome.offscreen.createDocument` to spawn `cheerpj-app/cheerpj.html`
   as a managed offscreen doc automatically when first used.
2. **Try `cheerpjRunMain` + stdin/stdout-piped JARs** for horsebread's
   use cases. Most of horsebread's Python isn't Java, so this runtime
   is primarily for the HL7/FHIR validator and SmartClient server JARs.
3. **Tackle Phase 2 CheerpX** with the same lesson — host it via the
   asset server in a localhost iframe instead of fighting extension
   sandbox restrictions. The CheerpX bundle is already in place.
4. **Eventually**: resolve the Proxy-walk hang so `loadLibrary()` +
   `call()` work for libraries that don't expose a main method (the
   NIST/FHIR validator pattern from AAV).

## Relation to Phase 1 CheerpX

This is the same category of problem. Both runtimes work fine in their normal hosting context (regular web pages) but hit an opaque hang inside an extension sandbox iframe during a resource-loading phase that happens in a worker we can't observe. The CheerpX fix might be exactly the same as the CheerpJ fix once we find it.

The Phase 2 CheerpX unlock (via `CheerpX.DataDevice.create(Uint8Array)`) bypasses the HTTP transport layer entirely. There may be a CheerpJ equivalent — maybe `cheerpOSAddStringFile` with the entire JRE as bytes, if we can extract a JRE blob from somewhere.

---

## Phase 1.7 — host.runtimes registration (2026-04)

**Status: done.** CheerpJ is now reachable from any extension page via the
`host.runtimes` registry. Verified end-to-end from the SC dashboard sandbox
iframe: `host.runtimes.get('cheerpj').runMain({...})` returns Java stdout in
**968 ms** on a warm runtime.

### What landed

1. **`host.runtimes` capability surface** added to `host-chrome-extension.js`
   with `list()`, `get()`, `has()`, `register()`. The host factory auto-registers
   any runtime class that attached itself to `window` by the time the host is
   constructed (e.g., `window.HostRuntimeCheerpJ` → registered as `cheerpj`).

2. **SC sandbox loads `runtimes/cheerpj.js` before `host-chrome-extension.js`**
   in `smartclient-app/app.html`, so the runtime class is available for
   auto-registration.

3. **Service worker routing via `lib/handlers/cheerpj-handlers.js`.** Registers
   three handlers: `cheerpj-ping`, `cheerpj-init`, `cheerpj-runMain`. Each
   forwards to the offscreen document via an internal `CHEERPJ_INVOKE`
   envelope sent with `chrome.runtime.sendMessage`.

4. **Offscreen document hosts CheerpJ as an embedded iframe.**
   MV3 appears to allow multiple offscreen documents in current Chrome
   versions, but to stay compatible and reuse the existing infrastructure,
   we extended the shared `offscreen.html` (already used for transformers.js
   embeddings + LLM workers) to also contain a hidden iframe pointing at
   `cheerpj-app/cheerpj.html`. The cheerpj iframe loads `cheerpj-host.js`
   which sets up its own `chrome.runtime.onMessage` listener for
   `CHEERPJ_INVOKE` and relays commands to its localhost iframe child.

5. **Ready handshake.** When `cheerpj-host.js` installs its `onMessage`
   listener, it immediately sends `{ type: 'CHEERPJ_OFFSCREEN_READY' }` to
   the service worker so the handler knows it's safe to dispatch real work.
   Without this, the first `CHEERPJ_INVOKE` raced the listener install and
   failed with "The message port closed before a response was received".

### Call chain (seven hops)

```
SC sandbox iframe (app.html)
  └─[1]─> postMessage 'smartclient-action' to wrapper.html
              └─[2]─> chrome.runtime.sendMessage(cheerpj-runMain) to service worker
                          └─[3]─> cheerpj-handlers invokeOffscreen('runMain', ...)
                                      └─[4]─> chrome.runtime.sendMessage(CHEERPJ_INVOKE) to offscreen
                                                  └─[5]─> offscreen.html's iframe cheerpj-app/cheerpj.html
                                                              └─[6]─> postMessage to localhost iframe
                                                                          └─[7]─> CheerpJ cheerpjRunMain(...)
                                                                                    └──> Java main() runs,
                                                                                         System.out captured
Return flows back the same seven hops. Total elapsed: ~968 ms warm.
```

### Gotchas resolved

- **MV3 allows multiple offscreen docs (or at least Chrome 147 does).**
  Earlier writeup assumed strict single-offscreen constraint. Confirmed
  both `offscreen.html` AND `cheerpj-app/cheerpj.html` can exist as
  offscreen contexts simultaneously. But keeping the CheerpJ iframe
  inside the shared `offscreen.html` is still cleaner — one lifecycle,
  less manifest churn.
- **Ready handshake is essential.** The first `CHEERPJ_INVOKE` arriving
  before the offscreen doc installed its listener closed the port
  immediately. Fix: offscreen signals ready, service worker's
  `ensureOffscreen()` blocks until the ready signal arrives.
- **Fresh profiles help.** Stale browser profile state caused the
  registry to show duplicate offscreen contexts from prior runs.
  Wiping `~/.agentidev/browser-profile` clears the confusion.

### Exit criteria met

- `host.runtimes.list()` returns `['cheerpj']` inside the SC sandbox
- `host.runtimes.get('cheerpj').runMain(...)` returns `{ success: true,
  exitCode: 0, stdout: ... }` with Java stdout in under 1 second on warm
  runtime
- `npm test` stays green (145 Jest tests)
- No regressions in existing dashboard features
- Same architecture ready to port to CheerpX (Phase 2) with minimal
  changes — just add a `cheerpx-app/cheerpx.html` iframe to
  `offscreen.html` and a `cheerpx-handlers.js` alongside `cheerpj-handlers.js`.

---

## Phase 1.8 — real-world JAR proof: NIST HL7 v2 validator (2026-04)

**Status: done.** A 24 MB shaded fat JAR (NIST IGAMT HL7 v2 conformance
validator from `/home/bigale/repos/agentauthvault`) runs end-to-end through
the full seven-hop chain. The validator parses an XML profile, validates an
HL7 v2 VXU^V04 message against it, and returns a JSON report — all in
**~2.9 s wall-clock** on a warm CheerpJ runtime.

### Result

```text
{
  "valid": false,
  "engine": "nist-cheerpj",
  "duration": 651,
  "summary": { "totalErrors": 1, "totalWarnings": 0, "totalInfos": 0 },
  "errors": [ { "classification": "ERROR", "description": "...schema..." } ]
}
```

The `valid: false` is content-driven (a real schema validation finding from
the NIST profile XML), not a runtime failure. The validator's full Kotlin +
Java + HAPI + javax.xml stack executed inside CheerpJ.

### What this proves

- **Scale**: 24 MB JAR with ~16 000 classes (vs the prior 1 KB hello-main
  test) loads, mounts, and runs without code changes to the runtime
  abstraction.
- **Real Java APIs**: javax.xml.parsers, java.util.logging, javax.xml.bind,
  HAPI HL7, gson — all work.
- **Multi-JAR classpath**: a wrapper JAR + the main JAR are joined with
  `:` and passed to `cheerpjRunMain` as a single classpath. New
  `extraJars: string[]` option on the runtime API.
- **Large args**: HL7 message (1.6 KB) and profile XML (12.8 KB) round-trip
  through every hop unchanged.

### Workarounds discovered

These are the rough edges of running real-world JARs on CheerpJ 4.0; each
has a clean fix that lives in `~/.agentidev/cheerpx-assets/` and the runtime
host page (no changes to caller code):

1. **`StackStreamFactory_checkStackWalkModes` JNI is missing in CheerpJ
   Java 11.** The moment any code calls `Logger.info(...)`, the default
   `SimpleFormatter` walks the stack to infer the caller class and dies.
   **Fix**: a one-class wrapper JAR (`nolog-wrap.jar`, 874 bytes) that
   calls `LogManager.getLogManager().reset()` and forwards to the real
   `main()`. Wrapper class: `NoLogValidator`. The runtime accepts it via
   `extraJars: ['http://localhost:9877/nolog-wrap.jar']` and invokes
   `className: 'NoLogValidator'`.

2. **Mixed bytecode versions in shaded JARs.** AAV's NIST validator is
   built `--release 11`, but the shaded `lib-hl7v2-nist-validator` from
   the NIST nexus contains 5 Kotlin classes compiled to Java 17 (major 61)
   and even 2 Kotlin classes at major 65 (Java 21). CheerpJ 4.0 caps at
   Java 11 (major 55). **Fix**: byte-flip the version field in those 7
   classes from 61/65 → 55. The Kotlin classes don't actually use Java
   12+ bytecode features — just the toolchain default. Script:

   ```python
   import os, struct
   for root, _, files in os.walk('.'):
       for f in files:
           if not f.endswith('.class'): continue
           p = os.path.join(root, f)
           data = bytearray(open(p, 'rb').read())
           if data[:4] != b'\xca\xfe\xba\xbe': continue
           major = struct.unpack('>H', data[6:8])[0]
           if major > 55:
               data[4:6] = b'\x00\x00'
               data[6:8] = struct.pack('>H', 55)
               open(p, 'wb').write(bytes(data))
   ```

   Re-jar and serve. **Caveat**: this only works if the downgraded classes
   don't depend on Java 12+ APIs at runtime. For the NIST Kotlin classes
   (companion objects, exception classes) it works. For arbitrary Java 17
   code that uses records, sealed classes, pattern matching, etc., this
   would fail with `VerifyError`. A real solution would be a proper ASM
   transform or an upstream rebuild against Java 11.

3. **Browser HTTP cache hides JAR updates.** asset-server sends
   `Cache-Control: max-age=3600`. After re-uploading a JAR, append
   `?v=<timestamp>` to bust. Eventually we should switch the asset-server
   default for `.jar` to `no-cache` for the dev profile.

4. **`cheerpjRunMain` is variadic.** Initial wiring passed `args` as a
   single positional array argument; CheerpJ expects each arg as a separate
   parameter. Fixed in `cheerpj-runtime.html` with
   `cheerpjRunMain.apply(null, [className, classpath].concat(args))`.

5. **`ensureOffscreen()` cached a stale promise** if the offscreen doc
   was torn down out-of-band (closeDocument from another flow, crash).
   Fixed by re-checking `chrome.offscreen.hasDocument()` on entry and
   resetting if the doc is gone.

### New extraJars API

`runMain` now accepts an `extraJars: string[]` option — additional JAR
URLs that the runtime fetches in parallel and joins onto the classpath.
Wrapper classes, runtime patches, and dependencies can all live in
separate JARs without rebuilding the primary application.

```js
const result = await window.Host.get().runtimes.get('cheerpj').runMain({
  jarUrl: 'http://localhost:9877/nist-validator.jar',
  extraJars: ['http://localhost:9877/nolog-wrap.jar'],
  className: 'NoLogValidator',
  args: [hl7Message, profileXml],
  cacheKey: 'nist-validator'
});
```

### Files added/modified for Phase 1.8

- `~/.agentidev/cheerpx-assets/nist-validator.jar` (24 MB, downgraded)
- `~/.agentidev/cheerpx-assets/nolog-wrap.jar` (874 B)
- `~/.agentidev/cheerpx-assets/vxu-v04-nist-conformance.hl7` (1.6 KB)
- `~/.agentidev/cheerpx-assets/nist-vxu-profile.xml` (12.8 KB)
- `~/.agentidev/cheerpx-assets/cheerpj-runtime.html` — version: 11 default,
  variadic args fix, extraJars classpath joining
- `extension/lib/handlers/cheerpj-handlers.js` — extraJars passthrough,
  self-healing `ensureOffscreen()`
- `extension/lib/host/runtimes/cheerpj.js` — extraJars on `runMain` opts
- `extension/cheerpj-app/cheerpj-host.js` — parallel fetch of primary +
  extra JARs, derives cacheKey from URL filename
- `extension/background.js` — exposes `globalThis.__handlers` for CDP
  Runtime.evaluate testing of internal handler chains

### How to repro

```bash
node packages/bridge/scripts/sw-eval.mjs "(async () => {
  const hl7 = await (await fetch('http://localhost:9877/vxu-v04-nist-conformance.hl7')).text();
  const profile = await (await fetch('http://localhost:9877/nist-vxu-profile.xml')).text();
  const res = await globalThis.__handlers['cheerpj-runMain']({
    jarUrl: 'http://localhost:9877/nist-validator.jar',
    extraJars: ['http://localhost:9877/nolog-wrap.jar'],
    className: 'NoLogValidator',
    args: [hl7, profile],
    cacheKey: 'nist-validator'
  });
  return res;
})()"
```

### What Phase 1.8 does NOT prove

- **Library-mode (`cheerpjRunLibrary` + Proxy walk + repeated `call`).**
  Still blocked by the nested-iframe Proxy hang. For high-throughput
  validation we'd want to load the JAR once and call validate() many
  times without re-running main. Today every call goes through `runMain`,
  which re-imports class table state. Cold runs are ~5 s, warm runs are
  ~3 s — fine for interactive use, expensive for batch.
- **CheerpJ Java 17.** No path until Leaning Technologies ships it.
  Bytecode flipping is a hack that only works for trivial cases.

---

## Phase 3 — Runtime composition: BeanShell on CheerpJ (2026-04)

**Status: done.** A third runtime — `bsh` — is registered alongside
`cheerpj` and `cheerpx`, with `dependsOn: ['cheerpj']`. It demonstrates
the runtime composition pattern from the host capability interface plan:
an `interpreter`-type runtime that runs *inside* a `library`-type
runtime. Exit-criteria test from the SC dashboard sandbox iframe:

```js
const host = window.Host.get();
host.runtimes.list();
// → ['cheerpj', 'cheerpx', 'bsh']

const bsh = host.runtimes.get('bsh');
bsh.type;        // → 'interpreter'
bsh.dependsOn;   // → ['cheerpj']

await bsh.eval('1 + 1');                            // → "2"   (~2.7 s cold, ~1.3 s warm)
await bsh.eval('40 * 2 + 2');                       // → "82"
await bsh.eval('Math.sqrt(2025)');                  // → "45.0"
await bsh.eval('String s = "hello"; s.toUpperCase()'); // → "HELLO"
```

### Architecture

The BSH runtime is ~150 lines and contains no CheerpJ-specific glue. It
calls the cheerpj runtime for everything:

```
app code
  └─ host.runtimes.get('bsh').eval(code)
      └─ this runtime's init() — calls host.runtimes.get('cheerpj').init() first
      └─ this runtime's eval(code)
          └─ host.runtimes.get('cheerpj').runMain({
                jarUrl: '...bsh-2.0b5.jar',
                extraJars: ['...bsh-eval.jar'],   // wrapper class
                className: 'BshEval',
                args: [code],
              })
              └─ cheerpj iframe: cheerpjRunMain('BshEval', classpath, code)
                  └─ BshEval.main(args):
                       new bsh.Interpreter().eval(args[0])
                       System.out.println(result)
              └─ stdout flows back through cheerpj
          └─ this runtime parses stdout, returns the trailing value
```

`dependsOn: ['cheerpj']` is checked explicitly in `init()`: if `cheerpj`
isn't registered, `bsh.init()` rejects with a clear error. This proves
boot-order resolution works — though for true topological dependency
ordering across many runtimes, the host factory should walk the deps
graph at registration time. Today the SC dashboard's app.html script tag
order does the ordering implicitly (cheerpj.js → cheerpx.js → bsh.js).

### Files added

- `~/.agentidev/cheerpx-assets/bsh-2.0b5.jar` (375 KB) — BeanShell from
  Maven Central (`org.beanshell:bsh:2.0b5`)
- `~/.agentidev/cheerpx-assets/bsh-eval.jar` (924 B) — wrapper class
  `BshEval` that takes code as `args[0]`, calls
  `bsh.Interpreter().eval(...)`, prints the result. Source in this repo
  at `/tmp/bsh-eval/BshEval.java` for now (should be checked in alongside
  the runtime so it's reproducible — TODO).
- `extension/lib/host/runtimes/bsh.js` — `HostRuntimeBsh` class with
  `type: 'interpreter'`, `dependsOn: ['cheerpj']`, `init()`, `eval(code)`

### Why BeanShell, not Jython

The Phase 3 plan called for Jython (`jython-standalone-2.7.4.jar`, 50 MB)
as the canonical composition demo. We tried it; the result is documented
here so we don't try it again:

1. **Jython 2.7.4 fails on CheerpJ during PyType registry init**:
   ```
   java.lang.ExceptionInInitializerError
     at org.python.core.PySystemState.<clinit>
   Caused by: java.lang.ArrayIndexOutOfBoundsException
     at org.python.core.PyJavaType.type___setattr__
     at org.python.core.PyType.addMethod
     at org.python.core.PyJavaType.addMethodsForObject
     at org.python.core.PyJavaType.init
   ```
   Jython's PyJavaType walks `Class.getDeclaredMethods()` and indexes by
   parameter count via array math; it makes assumptions about Java's
   reflection layout that CheerpJ's reimplementation of reflection doesn't
   satisfy. Hits before any user code runs. Not fixable from our side.

2. **The composition pattern is the value, not Python-on-Java**.
   BeanShell proves the pattern in a 375 KB JAR with a 5-second cold
   start. Same `interpreter`/`dependsOn` design, ~99% smaller, works.

### Boot-order nicety

The plan called out: "CheerpJ init completes before Jython init starts."
Implemented two ways for safety:

1. **Static**: app.html loads `cheerpj.js` before `bsh.js` so the
   factory's auto-registration runs in dependency order.
2. **Dynamic**: `BshRuntime.init()` calls
   `host.runtimes.get('cheerpj').init()` and awaits before considering
   itself initialized. CheerpJ init is idempotent so calling it from
   both BSH init and any direct caller is safe.

If we ever add a runtime with multi-level transitive deps, we should
move dependency resolution into the host's `runtimes.register()` so
init order is automatic at the topological-sort level. Not needed yet.

### Regression also fixed in this phase

While debugging the Jython hang we found a real regression introduced in
Phase 2: applying `Cross-Origin-Opener-Policy: same-origin` +
`Cross-Origin-Embedder-Policy: require-corp` to *all* HTML files served
by `asset-server.mjs` broke the cheerpj-runtime page. Even with `coi:
false` reported by the iframe (it's not a top-level context, so it
doesn't actually become COI), the COEP header changes how blob: workers
inherit headers, which broke CheerpJ's worker dispatch — `cheerpjRunMain`
hung indefinitely on any JAR after a fresh init.

Fix: the COI headers in `coiHeadersFor()` are now scoped to
`cheerpx-runtime.html` only. The cheerpj-runtime.html (and any other
HTML in `~/.agentidev/cheerpx-assets/`) gets only `Cross-Origin-Resource-Policy:
cross-origin`, which is enough for it to be loaded into a COEP parent
without breaking its own worker dispatch.

```js
function coiHeadersFor(ext, relPath) {
  if (ext === '.html' && relPath === 'cheerpx-runtime.html') {
    return {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };
  }
  return { 'Cross-Origin-Resource-Policy': 'cross-origin' };
}
```

### Exit criteria met

- `host.runtimes.list()` returns `['cheerpj', 'cheerpx', 'bsh']`
- `host.runtimes.get('bsh').dependsOn` is `['cheerpj']`
- `host.runtimes.get('bsh').type` is `'interpreter'`
- `await host.runtimes.get('bsh').eval('1 + 1')` returns `'2'`
- Cheerpj boot order respected (init() resolves deps first)
- 145 / 145 Jest tests pass
- No regressions in cheerpj or cheerpx
- BeanShell + composition pattern reachable from the SC dashboard
  sandbox iframe (the user-facing path)
