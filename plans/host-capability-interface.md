# Plan: Host Capability Interface + Plugin Architecture

Make agentidev a host-abstracted extensible platform. The chrome extension is the **baseline host**. Domain apps (plugins) target a stable `HostCapabilities` interface. Porting to other hosts (web app, Tauri, iOS, etc.) means implementing the same interface — not rewriting the app.

This plan covers the platform. It does **not** cover any specific domain app. The forcing function for the design is the ability to run an arbitrary Python + Node workload inside an in-browser Linux VM via CheerpX, orchestrated by the existing SmartClient UI, with live acquire routed through the extension's existing bridge infrastructure. The demo plugin is a minimal "Python Playground" (`extension/apps/hello-python/`) that proves the whole stack in ~200 lines.

---

## Host Strategy: Extension First, Port Later

**The chrome extension is the capability superset.** It has host permissions, `chrome.runtime` messaging, service workers, generous IndexedDB/OPFS quotas, offscreen documents, and sandbox pages. Everything a regular web page has plus privileged cross-origin access, persistent identity, and messaging between frames. Designing to a lesser host first would force us to architect around constraints that the real baseline doesn't have.

**Rule**: every feature targets a documented host-capability interface. The chrome extension implements the full interface. A port (web app, Tauri, Apple/Android app stores, etc.) implements whatever subset its environment supports and stubs, proxies, or degrades the rest. App code never calls `chrome.runtime.*`, `fetch`, or platform APIs directly — it calls `host.*`.

**Port-by-removal, not port-by-addition.** Extension → web is "drop privileges that aren't available." Web → extension would be "add features you didn't have." The first is mechanical; the second is redesign.

---

## Host Capability Interface

The abstraction we build in this POC. Every app targets this interface; every host implements it.

```ts
interface HostCapabilities {
  // Key/value + opaque blob persistence
  storage: {
    get(key: string): Promise<any>;
    set(key: string, value: any): Promise<void>;
    blob: {
      put(key: string, bytes: Uint8Array): Promise<void>;
      get(key: string): Promise<Uint8Array>;
    };
  };

  // Virtual filesystem (OPFS in extension, real FS in Tauri, etc.)
  fs: {
    read(path: string): Promise<Uint8Array>;
    write(path: string, bytes: Uint8Array): Promise<void>;
    list(path: string): Promise<string[]>;
    watch(path: string, cb: (evt: FsEvent) => void): () => void;
  };

  // Run a command inside whatever execution substrate the host supports
  exec: {
    spawn(cmd: string, args: string[], opts?: ExecOpts): ExecHandle;
    // ExecHandle: streams stdout/stderr, returns exit code
  };

  // Cross-origin fetch. Extension: unrestricted via host_permissions.
  // Web app: CORS-restricted, may require server proxy.
  network: {
    fetch(url: string, init?: RequestInit): Promise<Response>;
    websocket(url: string): WebSocket;
  };

  // Privileged bridge: talk to another process/worker/tab
  message: {
    send(channel: string, payload: any): Promise<any>;
    subscribe(channel: string, cb: (msg: any) => void): () => void;
  };

  // Identity and persistence scope
  identity: {
    hostType: 'chrome-extension' | 'web-app' | 'tauri' | 'electron' | 'ios' | 'android';
    installId: string;  // stable per install
  };
}
```

**Extension implementation** (baseline, everything works):
- `storage` → `chrome.storage.local` + IndexedDB
- `fs` → OPFS via offscreen doc or sandbox iframe indirection (sandbox can't call OPFS directly)
- `exec` → routes to the CheerpX sandbox iframe via `postMessage`
- `network.fetch` → extension-level `fetch()` bypassing CORS for declared `host_permissions`
- `message` → `chrome.runtime.sendMessage` in-extension; WebSocket out-of-extension
- `identity.hostType` → `'chrome-extension'`

**Web app port** (degraded, documented):
- `network.fetch` restricted to CORS-allowing endpoints or requires a server proxy
- `exec` still works (CheerpX runs in any page)
- `message` uses `BroadcastChannel` / `postMessage` instead of `chrome.runtime`
- `storage.blob` backed by OPFS directly

**Tauri port** (upgraded, different tradeoffs):
- `exec` can optionally call real OS binaries via Tauri commands instead of CheerpX
- `fs` backed by real filesystem (with permission prompts)
- `network` unrestricted

**iOS/Android** (most constrained):
- `exec` likely only WASM runtimes, no spawn
- `fs` app-sandboxed
- `network` has platform quirks

---

## Plugin Architecture

Apps are plugins. A plugin is:

1. **A manifest** describing which modes it registers, which templates and handlers it provides, and any assets it needs fetched
2. **One or more SmartClient templates** (JSON configs)
3. **Optional handlers** registered with the service worker's message router
4. **Optional rootfs assets** for CheerpX (git-clone hook, pre-installed packages, mount points)

Plugins live in **their own repos** (public or private). They are **assembled into the extension at build time** by copying into `extension/apps/<plugin-name>/`. The `extension/apps/` directory is gitignored in the agentidev repo — plugin code never touches agentidev's git history.

### Plugin manifest (draft)

```json
{
  "id": "hello-python",
  "name": "Python Playground",
  "version": "0.1.0",
  "modes": ["hello-python"],
  "templates": {
    "main": "templates/main.json"
  },
  "handlers": "handlers.js",
  "rootfs": {
    "base": "debian-slim",
    "pip": [],
    "mount": []
  },
  "requires": {
    "hostCapabilities": ["exec", "fs", "message"]
  }
}
```

### Build-time assembly

A small script at the platform level walks `extension/apps/*/manifest.json`, registers each plugin's modes with `smartclient-app/wrapper.html`, wires its handlers into the service worker's message router, and stages any rootfs assets. No dynamic code loading at runtime (extension CSP forbids it).

A plugin author runs `./scripts/assemble-plugin.sh <path-to-plugin-repo>` before `npm run browser`. The script copies (or symlinks in dev) the plugin into `extension/apps/<id>/` and regenerates the registration file.

### Why assembly, not runtime install

Chrome extension CSP forbids loading code from arbitrary URLs. "Runtime install" would require a full package signing + approval flow we don't want to build. Build-time assembly is simple, keeps the security model intact, and makes plugins git-trackable in their own repos.

---

## Reference Patterns We Already Have

### From `/home/bigale/repos/agentauthvault/` (CheerpJ POC) — runtime integration pattern

- CheerpJ runtime loaded via CDN `<script>`, zero-overhead until first `cheerpjInit()`
- Centralized service singleton boots the runtime once per app lifetime
- Fetches binaries and injects into virtual FS
- JS-to-runtime: thin wrapper returning JSON strings, exposed as async JS proxies
- Lazy-init: UI components poll `isReady()` before enabling

**Takeaway**: the runtime integration pattern (loader, singleton, lazy init, async proxy) is portable across hosts. That's what we reuse — not agentauthvault's "regular SPA page" hosting context.

### From `/home/bigale/repos/agentidev/extension/smartclient-app/` — SmartClient sandbox pattern

- Host page (`wrapper.html`) + sandboxed iframe (`app.html`) — SmartClient runs in iframe declared in `manifest.sandbox.pages`
- Communication: `postMessage` between host and sandbox; host has `chrome.runtime` access, sandbox does not
- `renderer.js` whitelist-based component creation from JSON config
- DataSource proxy: `app.js` postMessage → `bridge.js` (host) → `chrome.runtime.sendMessage` → service worker → handlers → IndexedDB
- Templates system with bundled configs + AI system prompts
- Mode dispatch via query string: `?mode=dashboard`, `?mode=playground`, etc.

**This is the host architecture we extend.** Plugins become new modes. CheerpX is a new sandbox iframe sibling.

---

## Runtime Options for In-Browser Compute

### Option A: CheerpX (WebVM) — recommended for POC

Full x86 Linux in browser via x86-to-WASM virtualization. Ships a rootfs image, boots like a VM, runs unmodified binaries (Python, Node, pip, apt).

**Pros**: unmodified binaries run as-is; `spawnSync` works; full package ecosystem (`pip install`); real sqlite3, real file paths, real subprocess.

**Cons**: image is 100–400MB on first load (cached after); slower boot than native WASM runtimes; no GPU/workers inside the VM.

**Maturity**: production-ready; used in WebVM public demos.

### Option B: BrowserPod (WASM-native) — graduation target

Leaning Technologies' newer WASM-native sandbox. Currently Node.js is supported; Python and Ruby are "coming soon" per the [beta announcement](https://labs.leaningtech.com/blog/browserpod-beta-announcement).

**Pros (when Python lands)**: smaller footprint, faster startup, explicitly targeted at AI code sandboxes.

**Cons (today)**: Python runtime not yet available; native extensions uncertain; Python + Node orchestration across two pods requires message bus.

### Option C: Pyodide — eliminated for this POC

Runs Python today but no Node, no subprocess, many native deps unpackaged. Not worth porting the orchestration model when CheerpX runs everything unchanged.

### Decision

- **Phase 1**: CheerpX. Works today, runs anything.
- **Phase N (future)**: migrate pure-compute modules to BrowserPod when Python lands. The SmartClient orchestration layer and the HostCapabilities contract stay identical — only the "runner" behind `host.exec.spawn` changes.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│ chrome-extension://<id>/smartclient-app/wrapper.html?mode=<plugin-mode>  │
│  ┌──────────────────────────────┐  ┌──────────────────────────────┐     │
│  │ SmartClient sandbox iframe    │  │ CheerpX sandbox iframe        │     │
│  │  (existing app.html)          │  │  (new cheerpx-app/cheerpx.html)│    │
│  │  - Plugin template            │  │  - x86 Linux VM                │     │
│  │  - Grids, Monaco, toolbar     │  │  - Rootfs from OPFS            │     │
│  │  - HTMLFlow for output        │  │  - stdout via postMessage      │     │
│  └──────────────┬───────────────┘  └──────────────┬─────────────────┘     │
│                 │                                  │                       │
│                 ▼                                  ▼                       │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Host bridge (wrapper.html — has chrome.runtime)                     │  │
│  │   Implements HostCapabilities.* by routing to:                      │  │
│  │     - chrome.runtime.sendMessage → service worker                    │  │
│  │     - postMessage → SmartClient sandbox                              │  │
│  │     - postMessage → CheerpX sandbox                                  │  │
│  └─────────────────────────────┬──────────────────────────────────────┘  │
│                                │                                          │
│                                ▼                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Service worker (background.js) + handlers                           │  │
│  │   - existing: datasource, script, bridge-client, smartclient        │  │
│  │   - new: plugin-registered handlers (assembled at build time)       │  │
│  │   - network.fetch via host_permissions                              │  │
│  │   - storage → chrome.storage.local + IndexedDB + OPFS               │  │
│  │   - message → WebSocket to bridge server on localhost:9876          │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

### Where the CheerpX rootfs lives

**Not in the extension package** — too large. Two-stage load:

1. **First run**: host bridge detects no cached rootfs. `host.network.fetch` pulls the image from (a) the local agentidev bridge server via a `BRIDGE_GET_ASSET` handler, or (b) Leaning Technologies' CDN with the origin in `content_security_policy.extension_pages`. Writes to OPFS via `host.storage.blob.put`. Progress UI in the SmartClient pane using HTMLFlow.
2. **Subsequent runs**: CheerpX sandbox reads from OPFS on boot. No network.

The extension's manifest gets a `host_permissions` entry for whichever origin we use, and `content_security_policy.extension_pages` keeps `wasm-unsafe-eval` (already present).

---

## Key Technical Challenges

| Challenge | Mitigation |
|---|---|
| **Extension CSP blocks CheerpX CDN scripts** | Default CSP forbids external script URLs. Bundle the CheerpX loader locally in `extension/lib/cheerpx/`. One less network dependency at launch. |
| **Rootfs image size (100s of MB)** | Not shippable in the extension zip. Two-stage load to OPFS. Progress UI in SmartClient HTMLFlow. |
| **OPFS access from sandboxed iframes** | Sandbox iframes have limited storage APIs. The CheerpX sandbox asks the host bridge for `host.fs.read(...)`, which routes via `chrome.runtime.sendMessage` to the service worker or an offscreen doc that owns OPFS. Same indirection pattern the SmartClient sandbox uses for IndexedDB. |
| **Stdout streaming across two iframe hops** | CheerpX exposes child process stdout as async iterator. CheerpX sandbox → wrapper.html → SC sandbox → HTMLFlow append. Each hop is `postMessage`; keep chunks line-sized or ~1KB buffered. |
| **Large WASM + service worker restart** | MV3 service workers restart at any time. CheerpX state lives in the sandbox iframe, not the SW. The SW just routes messages. Same constraint the existing SC dashboard already lives with. |
| **Debugging inside the VM** | V8 debugger can't attach across iframe boundary to CheerpX. For POC, rely on stdout capture. Later: integrate xterm.js as a real terminal pane in the SmartClient sandbox. |
| **Plugin code can't load dynamically** | Extension CSP forbids runtime code injection. Plugins are assembled at build time — they're just files in `extension/apps/<id>/` that the service worker imports normally. |

---

## File Layout (Platform Only)

```
extension/
  manifest.json                             # + cheerpx-app/cheerpx.html in sandbox.pages
  lib/
    host/                                   # NEW: host capability interface
      host-interface.js                     # JSDoc typedef + factory
      host-chrome-extension.js              # extension implementation
    cheerpx/                                # NEW: bundled CheerpX loader + glue
      loader.js
      fs-bridge.js                          # OPFS <-> CheerpX virtual FS shim
    plugin-api/                             # NEW: plugin registration + assembly hooks
      registry.js                           # reads extension/apps/*/manifest.json
      mode-dispatcher.js                    # extends wrapper.html mode routing
  smartclient-app/
    wrapper.html                            # existing; gains plugin-mode registration
    app.html                                # existing SmartClient sandbox (unchanged)
  cheerpx-app/                              # NEW: CheerpX sandbox iframe
    cheerpx.html
    cheerpx-sandbox.js                      # in-sandbox glue: receive exec/fs, talk to CheerpX
  apps/                                     # NEW: assembled plugins (gitignored except hello-python)
    hello-python/                           # demo plugin — lives in the repo as a reference
      manifest.json
      templates/main.json
      handlers.js
scripts/
  assemble-plugin.sh                        # NEW: plugin-path → copy into extension/apps/<id>/
.gitignore                                  # + extension/apps/* (except hello-python/)
```

**Why this layout**:
- Plugin modes are added alongside existing `?mode=dashboard`, `?mode=playground` via the new dispatcher. Mode dispatch is already in place.
- The CheerpX sandbox is a new entry in `manifest.sandbox.pages` — same sandboxing model as `smartclient-app/app.html`.
- Host bridge, service worker, and bridge client are all existing infrastructure.
- **No new build system.** The extension has no webpack — native ESM modules.
- The `lib/host/` interface is the reusable contribution. Every future plugin targets it.
- The `hello-python` demo is checked in as a reference; all other plugins are assembled from external repos.

---

## Phase Breakdown

### Phase 0 — Host capability interface stub (1 session)
**Goal**: Introduce `HostCapabilities` and the chrome-extension implementation, *without* CheerpX. Prove the shape works against the existing SC dashboard.

**Deliverable**: `extension/lib/host/host-interface.js` (JSDoc typedef) + `host-chrome-extension.js` (impl). Route one existing feature (e.g., dashboard `IDB_EXPORT`) through `host.storage` instead of calling `chrome.runtime.sendMessage` directly.

**Exit criteria**: existing dashboard still works, one feature routes via the host interface, `npm test` green.

### Phase 1 — CheerpX spike inside the extension
**Goal**: `extension/cheerpx-app/cheerpx.html` loads CheerpX (locally bundled loader, base image fetched on demand), runs `python3 -c "print(1+1)"`, output returned via postMessage.

**Deliverable**: new sandbox page + `manifest.sandbox.pages` entry. Host route `host.exec.spawn('python3', ['-c', 'print(1+1)'])` returns `{ stdout: '2\n', exit: 0 }`.

**Exit criteria**: open the extension, see "2" from Python in a WASM x86 Linux VM inside a sandbox iframe.

### Phase 2 — Plugin architecture + hello-python demo
**Goal**: Plugin manifest format, assembly script, mode dispatcher extension, and a reference plugin in `extension/apps/hello-python/` that registers a `?mode=hello-python` with one button ("Run Python") that calls `host.exec.spawn('python3', ['-c', ...])` and renders output in a SmartClient HTMLFlow.

**Deliverable**: `lib/plugin-api/`, `scripts/assemble-plugin.sh`, `extension/apps/hello-python/` (manifest, template, handler).

**Exit criteria**: open `?mode=hello-python`, click Run, see Python output in the UI. The demo plugin is fully contained in `extension/apps/hello-python/` with no platform code scattered elsewhere.

### Phase 3 — Rootfs bootstrap + OPFS persistence
**Goal**: First-run rootfs fetch → OPFS → mounted into CheerpX. Plugin can declare `rootfs.pip: ['numpy']` and those packages are available at runtime.

**Deliverable**: `extension/lib/cheerpx/fs-bridge.js`, `BRIDGE_GET_ASSET` handler server-side, rootfs spec in plugin manifest.

**Exit criteria**: hello-python plugin can run `python3 -c "import numpy; print(numpy.zeros(3))"` on second load without refetching the image.

### Phase 4 — Port proof (web app)
**Goal**: Implement `host-web-app.js` in a minimal vite-served localhost page that runs the same hello-python plugin with identical UI. Document which capabilities degrade.

**Deliverable**: `apps/hello-python-web/` (outside extension), 100% shared plugin code, only the host binding differs.

**Exit criteria**: hello-python runs in both extension and web app with identical UI. Documented degradations (CORS for `network.fetch`, absent `chrome.runtime`, etc.).

---

## Non-Goals (for this plan)

- **No domain-specific code** in the platform plan. Each domain app is its own plugin with its own private plan.
- **No dynamic plugin install.** Plugins are assembled at build time. If we need runtime install later, that's a separate security design.
- **No Playwright in the sandbox.** Scraping stays in the existing bridge server / extension content script path.
- **No LLM inside CheerpX.** LLM calls go through the existing bridge → Claude CLI route.
- **No new SmartClient components.** Reuse existing Agentiface Forge components and templates.
- **No multi-user, no auth, no cloud persistence.** Single-user, local-only POC.

---

## Open Questions

1. **CheerpX licensing**: free for personal use, paid for commercial. Confirm the POC falls under free tier.
2. **Rootfs distribution**: served by local agentidev bridge server for dev (simplest) vs Leaning Technologies CDN for distribution (no bridge dependency). Recommend local for Phase 1–3, revisit for public distribution.
3. **Plugin manifest schema**: the draft above is a starting point. Validate it against the hello-python demo + one real domain plugin before freezing.
4. **Plugin assembly: copy vs symlink in dev?** Copy is safer (no accidental edit-in-place); symlink is faster iteration. Offer both via a flag.

---

## Work Environment Prompt

When picking this up at a clean session, paste this:

```
Read plans/host-capability-interface.md. Key constraints:

1. The chrome extension is the primary host. Do NOT build this as a
   regular web page. Everything lives inside extension/.
2. Every host-dependent call goes through extension/lib/host/host-interface.js.
   Do not call chrome.runtime.* directly from plugin or feature code.
3. The SmartClient sandbox pattern (extension/smartclient-app/) is reused.
   New plugins are new modes (?mode=<plugin-id>).
4. CheerpX runs in a new sandbox iframe entry in manifest.sandbox.pages,
   sibling to smartclient-app/app.html.

Start with Phase 0: introduce the Host Capability Interface and route ONE
existing dashboard feature through it. No CheerpX yet.

Verify progress with:
- `npm test &` (must stay green)
- `node packages/bridge/launch-browser.mjs` to launch Chromium with extension
- `node packages/bridge/scripts/sc-driver.mjs open/status/console/screenshot`
  to verify the SC dashboard still loads after the refactor

Exit criteria for Phase 0: host interface stubbed, one feature routed through
it, `npm test` green, SC dashboard still loads and the routed feature works.
```

---

## References

- **BrowserPod announcement**: https://labs.leaningtech.com/blog/browserpod-beta-announcement
- **CheerpX (WebVM) demo**: https://webvm.io/
- **Pyodide (eliminated)**: https://github.com/pyodide/pyodide
- **Agentauthvault CheerpJ integration**: `/home/bigale/repos/agentauthvault/src/frontend/services/CheerpJLibraryService.ts`
- **Agentidev SmartClient sandbox**: `extension/smartclient-app/` in this repo
- **Prior theoretical foundation** (not publicly committed): `/home/bigale/repos/icpxmldb/docs/ADVANCED-UNIVERSAL-AI-RESEARCH-V2.md` — Pemberton's representation neutrality extended to software logic; the HostCapabilities interface is a specialization of the USIR concept applied to host/runtime axis
