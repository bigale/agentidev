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

  // Pluggable compute runtimes (CheerpJ, CheerpX, Pyodide, Jython, ...)
  // See the "Runtimes" section below for the full protocol.
  runtimes: {
    list(): string[];
    get(name: string): Runtime;
    register(name: string, impl: Runtime): void;
    has(name: string): boolean;
  };
}

// Each runtime exposes only the methods appropriate to its type.
// Runtimes may compose — one runtime can declare it depends on another
// (e.g., Jython is implemented on top of CheerpJ).
interface Runtime {
  type: 'vm' | 'library' | 'interpreter';
  name: string;
  dependsOn?: string[];                 // other runtime names that must init first
  init(opts?: any): Promise<void>;
  isReady(): boolean;
  getError(): string | null;

  // VM-style (CheerpX, BrowserPod Linux, Tauri shell)
  spawn?(cmd: string, args: string[], opts?: ExecOpts): ExecHandle;

  // Library-style (CheerpJ, .NET Blazor WASM)
  loadLibrary?(config: LibraryConfig): Promise<Library>;

  // Interpreter-style (Pyodide eval, Jython eval, raw Function)
  eval?(code: string, ctx?: any): Promise<any>;
}

interface LibraryConfig {
  sourceUrl: string;          // '/jars/fhir.jar', '/wasm/pyodide.whl', etc.
  entryPoint: string;         // 'com.aav.fhir.FhirValidator' or equivalent
  cacheKey: string;           // dedup key for concurrent loads
  initTimeoutMs?: number;
}

interface Library {
  call(method: string, ...args: string[]): Promise<string>;
  isReady(): boolean;
  getError(): string | null;
}
```

**Extension implementation** (baseline, everything works):
- `storage` → `chrome.storage.local` + IndexedDB
- `fs` → OPFS via offscreen doc or sandbox iframe indirection (sandbox can't call OPFS directly)
- `exec` → thin wrapper that routes to `runtimes.get(defaultRuntime).spawn(...)`
- `network.fetch` → extension-level `fetch()` bypassing CORS for declared `host_permissions`
- `message` → `chrome.runtime.sendMessage` in-extension; WebSocket out-of-extension
- `identity.hostType` → `'chrome-extension'`
- `runtimes` → in-memory registry populated at boot with each runtime's sandbox iframe and postMessage bridge

**Web app port** (degraded, documented):
- `network.fetch` restricted to CORS-allowing endpoints or requires a server proxy
- `runtimes` — same shape; CheerpJ/CheerpX/Pyodide all run equally well in a regular web page
- `message` uses `BroadcastChannel` / `postMessage` instead of `chrome.runtime`
- `storage.blob` backed by OPFS directly

**Tauri port** (upgraded, different tradeoffs):
- `runtimes.get('native-shell').spawn(...)` can call real OS binaries via Tauri commands as an alternative to WASM-backed runtimes
- `fs` backed by real filesystem (with permission prompts)
- `network` unrestricted

**iOS/Android** (most constrained):
- `runtimes` limited to WASM-backed implementations; no spawn
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

## Runtimes

The `runtimes` capability is a registry of pluggable compute substrates. Each runtime is one of three shapes:

- **`vm`** — process-oriented. `spawn(cmd, args)` launches a binary inside the substrate and streams stdout/stderr. CheerpX, BrowserPod, Tauri shell.
- **`library`** — load-and-call-methods oriented. `loadLibrary({ sourceUrl, entryPoint })` returns a handle whose `call(method, ...args)` invokes static methods with string in/out. CheerpJ, .NET Blazor WASM.
- **`interpreter`** — evaluate code. `eval(code)` runs an expression and returns the result. Pyodide, Jython, raw JS Function, xeus kernels.

A runtime implementation only needs to provide the methods matching its `type`. `spawn` on a library-style runtime is undefined; calling it throws.

### Registration and lookup

Runtimes register themselves with the host at boot:

```js
host.runtimes.register('cheerpj', new CheerpJRuntime({ sandboxIframe: cheerpjFrame }));
host.runtimes.register('cheerpx', new CheerpXRuntime({ sandboxIframe: cheerpxFrame }));
host.runtimes.register('jython',  new JythonRuntime({ cheerpjRuntime: host.runtimes.get('cheerpj') }));
```

Apps look them up by name:

```js
// Library-style: load a JAR, call a method
const fhir = await host.runtimes.get('cheerpj').loadLibrary({
  sourceUrl: '/jars/fhir-validator.jar',
  entryPoint: 'com.aav.fhir.FhirValidator',
  cacheKey: 'fhir-validator',
});
const report = JSON.parse(await fhir.call('validate', fhirJson, profileUrl));

// VM-style: run a process
const handle = host.runtimes.get('cheerpx').spawn('python3', ['-c', 'print(1+1)']);
for await (const line of handle.stdout) console.log(line);

// Interpreter-style: evaluate code
const result = await host.runtimes.get('jython').eval('1 + 1');
```

### Runtime composition

Runtimes may depend on other runtimes. **Jython-on-CheerpJ** is the canonical example: Jython is a Python interpreter packaged as a JAR that runs on the JVM, so the `jython` runtime is implemented as a thin wrapper over the `cheerpj` runtime:

```js
class JythonRuntime {
  type = 'interpreter';
  name = 'jython';
  dependsOn = ['cheerpj'];

  constructor({ cheerpjRuntime }) {
    this._cheerpj = cheerpjRuntime;
    this._lib = null;
  }

  async init() {
    await this._cheerpj.init();
    this._lib = await this._cheerpj.loadLibrary({
      sourceUrl: '/jars/jython-standalone-2.7.3.jar',
      entryPoint: 'org.python.util.PythonInterpreter',
      cacheKey: 'jython-interp',
    });
  }

  async eval(code) {
    return this._lib.call('exec', code);
  }
}
```

App code that calls `host.runtimes.get('jython').eval(...)` never knows Jython sits on CheerpJ. Swapping Jython for Pyodide-backed Python later requires changing only the runtime registration, not any app code. The host boot sequence respects `dependsOn` by initializing runtimes in topological order.

### Runtime landscape (Python subset)

| Runtime | Python version | C extensions | Size | COI needed? | Best for |
|---|---|---|---|---|---|
| **CheerpX + CPython** | 3.11+ | All of them | ~600MB rootfs | Likely yes | horsebread as-is (pymupdf, numpy, pytesseract) |
| **Pyodide** | 3.11+ | Some (numpy ✓, pymupdf ✗) | ~10MB + wheels | No | Clean interface demos, pure-Python workloads |
| **Jython on CheerpJ** | 2.7 | None, but has JVM interop | ~15MB JAR + CheerpJ runtime | No (if CheerpJ works in ext) | Scripting over Java libraries, SmartClient server control |

For horsebread specifically, CheerpX is the best fit — its requirements track closest to horsebread's actual needs. Jython doesn't replace CheerpX for horsebread; it opens a different product: **Python as a scripting layer over any JVM library** running in the browser with no servers. Agentauthvault's HL7/FHIR validators become scriptable from Python in a chrome extension.

### Phase 1 proof-of-life: CheerpJ, not CheerpX

An earlier draft of this plan picked CheerpX for Phase 1. That's wrong for two reasons:

1. **Agentauthvault has already battle-tested CheerpJ in production** (NIST HL7 v2 + HAPI FHIR R4 validators, 4 documented gotchas, 39 unit tests). The loader is a single script, the pattern is "pre-fetch JAR bytes → inject via `cheerpOSAddStringFile` → `cheerpjRunLibrary` → walk class path". No cross-origin isolation gymnastics required — AAV runs it in a normal React page.
2. **CheerpX hits a cross-origin isolation wall** in extension pages that will take a dedicated session to resolve (see `extension/cheerpx-app/STATUS.md`). Its unlock probably involves `CheerpX.DataDevice.create(Uint8Array)` — bypass HTTP entirely, same pattern AAV uses for JARs — but verifying that is Phase 2 work.

So Phase 1 proves the `runtimes` abstraction with **CheerpJ as runtime #1**. Phase 2 tackles CheerpX as runtime #2 with the abstraction already in place. Phase 3 adds Jython on top of CheerpJ to validate runtime composition. Pyodide is evaluated based on demand.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ chrome-extension://<id>/smartclient-app/wrapper.html?mode=<plugin-mode>      │
│                                                                              │
│  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐             │
│  │ SmartClient      │ │ CheerpJ sandbox  │ │ CheerpX sandbox  │             │
│  │ sandbox iframe   │ │ iframe           │ │ iframe           │             │
│  │ (existing        │ │ (new cheerpj-app/│ │ (new cheerpx-app/│             │
│  │  app.html)       │ │  cheerpj.html)   │ │  cheerpx.html)   │             │
│  │                  │ │                  │ │                  │             │
│  │ Plugin template  │ │ JVM in WASM      │ │ x86 Linux VM     │             │
│  │ Grids, Monaco    │ │ JAR loader       │ │ Rootfs from OPFS │             │
│  │ HTMLFlow output  │ │ lib.call() API   │ │ spawn() stdout   │             │
│  │                  │ │ Jython runs here │ │                  │             │
│  └────────┬─────────┘ └────────┬─────────┘ └────────┬─────────┘             │
│           │                    │                    │                       │
│           └────────────────────┼────────────────────┘                       │
│                                ▼                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ Host bridge (wrapper.html — has chrome.runtime)                         │ │
│  │   Implements HostCapabilities.* by routing to:                          │ │
│  │     - chrome.runtime.sendMessage → service worker                        │ │
│  │     - postMessage → SmartClient sandbox                                  │ │
│  │     - postMessage → runtime sandbox (cheerpj / cheerpx / ...)            │ │
│  │                                                                          │ │
│  │   host.runtimes registry populated at boot:                              │ │
│  │     runtimes.register('cheerpj', CheerpJRuntime)                         │ │
│  │     runtimes.register('cheerpx', CheerpXRuntime)                         │ │
│  │     runtimes.register('jython',  JythonRuntime) // composes on cheerpj   │ │
│  └──────────────────────────────┬─────────────────────────────────────────┘ │
│                                 │                                            │
│                                 ▼                                            │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ Service worker (background.js) + handlers                               │ │
│  │   - existing: datasource, script, bridge-client, smartclient            │ │
│  │   - new: plugin-registered handlers (assembled at build time)           │ │
│  │   - network.fetch via host_permissions                                  │ │
│  │   - storage → chrome.storage.local + IndexedDB + OPFS                   │ │
│  │   - message → WebSocket to bridge server on localhost:9876              │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
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
  manifest.json                             # + cheerpj-app/cheerpj.html and
                                            # cheerpx-app/cheerpx.html in sandbox.pages
  lib/
    host/                                   # host capability interface
      host-interface.js                     # JSDoc typedef + factory (done Phase 0)
      host-chrome-extension.js              # extension impl (done Phase 0)
      runtimes/                             # NEW: runtime implementations
        cheerpj.js                          # library-style runtime
        cheerpx.js                          # vm-style runtime
        jython.js                           # interpreter-style, composes on cheerpj
    cheerpj/                                # NEW: bundled CheerpJ 4.0 loader + glue
      loader.js                             # cx.js equivalent
      4.0/                                  # version-scoped binaries
    cheerpx/                                # NEW: bundled CheerpX 1.0.7 loader + glue (done Phase 1.5 partial)
      1.0.7/
    plugin-api/                             # NEW: plugin registration + assembly hooks
      registry.js                           # reads extension/apps/*/manifest.json
      mode-dispatcher.js                    # extends wrapper.html mode routing
  smartclient-app/
    wrapper.html                            # existing; gains plugin-mode registration +
                                            # runtime iframe hosting
    app.html                                # existing SmartClient sandbox (unchanged)
  cheerpj-app/                              # NEW: CheerpJ sandbox iframe
    cheerpj.html                            # sandboxed page that owns the JVM
    cheerpj-sandbox.js                      # in-sandbox glue: loadLibrary, call
  cheerpx-app/                              # NEW: CheerpX sandbox iframe
    cheerpx.html                            # sandboxed page that owns the x86 VM
    cheerpx-sandbox.js                      # in-sandbox glue: spawn, stdout relay
  apps/                                     # NEW: assembled plugins (gitignored except hello-*)
    hello-java/                             # demo plugin — exercises cheerpj runtime
      manifest.json
      templates/main.json
      handlers.js
      jars/hello.jar                        # tiny demo JAR with static version() method
    hello-python/                           # demo plugin — exercises cheerpx runtime
      manifest.json
      templates/main.json
      handlers.js
scripts/
  assemble-plugin.sh                        # NEW: plugin-path → copy into extension/apps/<id>/
.gitignore                                  # + extension/apps/* (except hello-*/)
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

### Phase 0 — Host capability interface stub ✅ DONE
**Goal**: Introduce `HostCapabilities` and the chrome-extension implementation. Prove the shape works against the existing SC dashboard.

**Delivered**: `extension/lib/host/host-interface.js` (JSDoc typedef) + `host-chrome-extension.js` (sandbox-scoped impl with `identity`, `message.send`, `storage.export`). Dashboard Sync button routes through `host.storage.export()`. 145 Jest tests green. Commit `09f26be`.

### Phase 1 (partial, pivoted) — CheerpX spike hit COI wall
**Status**: partial. Locally bundled CheerpX 1.0.7 runtime works, CheerpX global loads, factory methods probe. `HttpBytesDevice.create()` succeeds but `Linux.create()` fails inside a worker with "TypeError: Failed to fetch" — cross-origin isolation wall. Full writeup in `extension/cheerpx-app/STATUS.md`. Commit `33c322f`.

**Pivoted to**: Phase 1.5 leads with CheerpJ, not CheerpX. CheerpX becomes Phase 2 with the DataDevice(bytes) unlock informed by the AAV CheerpJ pattern.

### Phase 1.5 — CheerpJ runtime (NEXT)
**Goal**: Introduce the `runtimes` registry as a first-class HostCapabilities surface. Register CheerpJ as runtime #1. Prove `host.runtimes.get('cheerpj').loadLibrary(...).call('method', ...)` works end-to-end inside an extension sandbox iframe.

**Why CheerpJ first, not CheerpX**: agentauthvault has already battle-tested CheerpJ 4.0 in a production React SPA (see `agentauthvault/docs/CHEERPJ-ANALYSIS.md`) with 4 documented gotchas. No cross-origin isolation requirement. Loader is a single script. JAR bundles are 24MB–102MB. The `fetch → arrayBuffer → cheerpOSAddStringFile` pattern bypasses HTTP transport entirely inside workers — the exact thing that bit us on Phase 1 CheerpX.

**Deliverables**:
- `extension/lib/cheerpj/4.0/` — bundled CheerpJ 4.0 loader (MV3 forbids remote code)
- `extension/cheerpj-app/cheerpj.html` — new sandbox page, listed in `manifest.sandbox.pages`
- `extension/cheerpj-app/cheerpj-sandbox.js` — in-sandbox glue (init, loadLibrary, call, exception unwrapping per AAV Gotcha #4)
- `extension/lib/host/runtimes/cheerpj.js` — Runtime implementation wrapping the sandbox via postMessage
- `extension/lib/host/host-interface.js` — extend typedef with `runtimes`, `Runtime`, `Library`, `LibraryConfig`
- `extension/lib/host/host-chrome-extension.js` — register the cheerpj runtime at boot
- A trivial demo JAR or a call into a JDK stdlib class (`java.lang.System.currentTimeMillis` → string) for the smoke test — no Maven/shading work needed in this phase

**Exit criteria**: from any extension page, `await host.runtimes.get('cheerpj').init(); const lib = await host.runtimes.get('cheerpj').loadLibrary({...}); await lib.call('version')` returns a string. `npm test` green. Dashboard Sync button still works.

### Phase 2 — CheerpX runtime
**Goal**: CheerpX as runtime #2. Sidestep the worker CORS/COI issue that blocked Phase 1 by adopting the CheerpJ bytes-injection pattern.

**Delivered (partial)**: `extension/lib/cheerpx/1.0.7/` bundle, `packages/bridge/asset-server.mjs` with CORS + Range + Last-Modified + ETag. See `extension/cheerpx-app/STATUS.md`.

**Remaining**:
- Try `CheerpX.DataDevice.create(Uint8Array)` as replacement for `HttpBytesDevice.create(url)`. Fetch the image via extension-context `fetch()`, pass bytes to DataDevice. No worker fetches → no CORS/COI issue.
- Fallback diagnostic: `Target.setAutoAttach` on worker targets to capture the real failing URL if DataDevice doesn't exist or doesn't work.
- Implement `extension/lib/host/runtimes/cheerpx.js` Runtime with `spawn()` streaming stdout.
- Register alongside CheerpJ.

**Exit criteria**: `host.runtimes.get('cheerpx').spawn('python3', ['-c', 'print(1+1)'])` streams back `"2\n"` and exit code 0 inside an extension sandbox iframe.

### Phase 3 — Jython runtime (composition proof)
**Goal**: Register Jython as runtime #3, composed on top of CheerpJ via `dependsOn`. Validate runtime composition.

**Deliverables**:
- `extension/lib/host/runtimes/jython.js` — thin wrapper loading `jython-standalone-2.7.x.jar` via the cheerpj runtime, exposing an `eval` interface
- Bundled `jython-standalone-2.7.x.jar` (~15MB)

**Exit criteria**: `await host.runtimes.get('jython').init(); await host.runtimes.get('jython').eval('1 + 1')` returns `2`. Boot order respects `dependsOn` — CheerpJ init completes before Jython init starts.

### Phase 4 — Plugin architecture + hello-java + hello-python demos
**Goal**: Plugin manifest format, assembly script, mode dispatcher. Two reference plugins that exercise two different runtimes.

**Deliverables**:
- `lib/plugin-api/`, `scripts/assemble-plugin.sh`
- `extension/apps/hello-java/` — `?mode=hello-java`, one button loads a JAR, calls a method, renders result. Exercises the `cheerpj` runtime.
- `extension/apps/hello-python/` — `?mode=hello-python`, one button runs `python3 -c "print(1+1)"`, renders stdout. Exercises the `cheerpx` runtime.

**Exit criteria**: both demos render and work. Each plugin's code is fully contained in `apps/hello-*/`. Platform code has no hard-coded knowledge of either plugin.

### Phase 5 — Rootfs bootstrap + OPFS persistence
**Goal**: For CheerpX plugins, first-run rootfs fetch → OPFS → mounted into CheerpX. Plugin manifest can declare `rootfs.pip: ['numpy']`.

**Deliverables**: `extension/lib/cheerpx/fs-bridge.js`, `BRIDGE_GET_ASSET` handler server-side, rootfs spec in plugin manifest.

**Exit criteria**: hello-python plugin runs `python3 -c "import numpy; print(numpy.zeros(3))"` on second load without refetching the image.

### Phase 6 — Port proof (web app)
**Goal**: Implement `host-web-app.js` as a second HostCapabilities implementation in a minimal vite-served localhost page. Same plugin code, different host binding. Document which capabilities degrade.

**Deliverable**: `apps/hello-web/` (outside extension), 100% shared plugin code, only the host binding differs.

**Exit criteria**: both hello-java and hello-python run in extension AND web app with identical UI. Documented degradations (`network.fetch` CORS restrictions, absent `chrome.runtime`, etc.).

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

1. Chrome extension is the primary host. Do NOT build anything as a
   regular web page. Everything lives inside extension/.
2. Every host-dependent call goes through extension/lib/host/host-interface.js.
   Do not call chrome.runtime.* directly from plugin or feature code.
3. The SmartClient sandbox pattern (extension/smartclient-app/) is reused.
   New plugins are new modes (?mode=<plugin-id>).
4. Each compute runtime (CheerpJ, CheerpX, ...) lives in its own sandbox
   iframe declared in manifest.sandbox.pages. Runtimes are registered
   with host.runtimes at boot and accessed via runtimes.get(name).

Current state:
- Phase 0 DONE (commit 09f26be): HostCapabilities with identity, message,
  storage. Dashboard Sync button routes through host.storage.export().
- Phase 1 partial (commit 33c322f): CheerpX bundled, cx.js loads, but
  Linux.create fails at cross-origin isolation wall. Asset server ready.
  Full status in extension/cheerpx-app/STATUS.md.
- Phase 1.5 NEXT: CheerpJ as runtime #1 using the AAV pattern (no COI
  required, loads JARs via cheerpOSAddStringFile bytes injection).

Start Phase 1.5:
1. Bundle CheerpJ 4.0 locally into extension/lib/cheerpj/4.0/ (MV3
   forbids remote script loading).
2. Create extension/cheerpj-app/cheerpj.html as a sandbox page and
   add it to manifest.sandbox.pages.
3. Extend extension/lib/host/host-interface.js typedef with the
   runtimes surface + Runtime/Library/LibraryConfig shapes.
4. Implement extension/lib/host/runtimes/cheerpj.js as the first
   Runtime implementation wrapping the sandbox via postMessage.
5. Register at boot in host-chrome-extension.js.
6. Smoke test: load a trivial demo JAR OR just call into java.lang stdlib
   via cheerpjRunLibrary (no Maven/shading needed for Phase 1.5 itself).

Verify progress with:
- `npm test &` (must stay green — 145 tests)
- `node packages/bridge/launch-browser.mjs` to launch Chromium
- `node packages/bridge/scripts/sc-driver.mjs screenshot` for visual check
- `node packages/bridge/scripts/page-eval.mjs` for runtime calls

Reference docs:
- agentauthvault/docs/CHEERPJ-ANALYSIS.md — 4 documented gotchas from
  AAV's battle-tested CheerpJ integration in production React SPA
- extension/cheerpx-app/STATUS.md — what we learned from the Phase 1
  CheerpX partial attempt; informs the DataDevice(bytes) path for Phase 2
```

---

## References

- **BrowserPod announcement**: https://labs.leaningtech.com/blog/browserpod-beta-announcement
- **CheerpX (WebVM) demo**: https://webvm.io/
- **CheerpJ docs**: https://cheerpx.io/docs (and sibling cheerpj.io)
- **Agentauthvault CheerpJ production usage**: `/home/bigale/repos/agentauthvault/docs/CHEERPJ-ANALYSIS.md` — 4 gotchas battle-tested in production, including the pre-fetch-and-inject-bytes pattern that unlocks CheerpX too
- **Agentidev SmartClient sandbox**: `extension/smartclient-app/` in this repo
- **Prior theoretical foundation** (not publicly committed): `/home/bigale/repos/icpxmldb/docs/ADVANCED-UNIVERSAL-AI-RESEARCH-V2.md` — Pemberton's representation neutrality extended to software logic; the HostCapabilities interface is a specialization of the USIR concept applied to host/runtime axis
