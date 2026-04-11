# Phase 1.5 — CheerpJ Spike Status

**Status**: partial. CheerpJ boots cleanly inside an extension sandbox iframe (in 60–90ms), all APIs are available, test JAR builds and injects. Blocked on the `cheerpjRunLibrary` resolution step — on a fresh init it does not resolve within 30 seconds with a custom JAR. Needs a dedicated debugging session.

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

## Relation to Phase 1 CheerpX

This is the same category of problem. Both runtimes work fine in their normal hosting context (regular web pages) but hit an opaque hang inside an extension sandbox iframe during a resource-loading phase that happens in a worker we can't observe. The CheerpX fix might be exactly the same as the CheerpJ fix once we find it.

The Phase 2 CheerpX unlock (via `CheerpX.DataDevice.create(Uint8Array)`) bypasses the HTTP transport layer entirely. There may be a CheerpJ equivalent — maybe `cheerpOSAddStringFile` with the entire JRE as bytes, if we can extract a JRE blob from somewhere.
