# CheerpJ API Reference (from cheerpj.com/docs, crawled 2026-04-12)

Source: https://cheerpj.com/docs/overview

This document captures the full CheerpJ API as documented. Intended for
ingestion into the agentidev local vector DB for AI-assisted development.

---

## cheerpjInit()

```typescript
async function cheerpjInit(options?: {
  version?: 8 | 11 | 17;                    // Default: 8. Java runtime version.
  status?: "splash" | "none" | "default";    // Loading message verbosity.
  clipboardMode?: "permission" | "system" | "java";  // Default: "java". NOT "none".
  logCanvasUpdates?: boolean;                // Debug: log display area updates.
  preloadResources?: { [key: string]: number[] };  // Parallel download of runtime chunks.
  preloadProgress?: (done: number, total: number) => void;
  beepCallback?: () => void;
  enableInputMethods?: boolean;              // Default: true (v4.0+). CJK support.
  overrideShortcuts?: (evt: KeyboardEvent) => boolean;
  appletParamFilter?: (name: string, value: string) => string;
  natives?: { [method: string]: Function };  // JS implementations of Java native methods.
  overrideDocumentBase?: string;
  javaProperties?: string[];                 // "-Dkey=value" equivalent. Array of "key=value".
  tailscaleControlUrl?: string;
  tailscaleDnsIp?: string;                   // Default: "8.8.8.8".
  tailscaleAuthKey?: string;
  tailscaleLoginUrlCb?: (url: string) => void;
  tailscaleIpCb?: (ip: string) => void;
  licenseKey?: string;
  execCallback?: (cmdPath: string, argsArray: string[]) => void;  // Since 3.1. Intercepts Runtime.exec().
  enableDebug?: boolean;                     // Since 3.1.
}): Promise<void>;
```

Must be called exactly once per page. Returns a Promise.

### Key options for agentidev

- **`javaProperties`**: Array of `"key=value"` strings. Could replace the
  NoLogValidator wrapper — `javaProperties: ['java.util.logging.config.file=/dev/null']`
  would disable JUL without needing a wrapper class.
- **`natives`**: Register JS implementations of Java native methods. Key naming:
  `Java_<package_underscored>_<class>_<method>`. First param is always `lib` (CJ3Library).
  Could replace console.log interception — have wrapper classes call a native
  method with the result string.
- **`execCallback`**: Intercepts `Runtime.exec()` / `ProcessBuilder` calls.
  Horsebread's Node.js pipeline spawns Python subprocesses — this callback
  could intercept and route them through agentidev's bridge.

---

## cheerpjRunMain()

```typescript
async function cheerpjRunMain(
  className: string,    // e.g. "com.app.MyClass"
  classPath: string,    // colon-separated, e.g. "/app/main.jar:/app/dep.jar"
  ...args: string[]     // variadic string args for main(String[] args)
): Promise<number>;     // exit code (0 = success)
```

Our current usage is correct: `cheerpjRunMain.apply(null, [className, classpath, ...args])`.

---

## cheerpjRunJar()

```typescript
async function cheerpjRunJar(
  jarName: string,      // e.g. "/app/application.jar"
  ...args: string[]
): Promise<number>;     // exit code
```

Reads `Main-Class` from the JAR's `MANIFEST.MF`. Does NOT accept a classpath
parameter — single JAR only. For multiple JARs, use `cheerpjRunMain`.

---

## cheerpjRunLibrary()

```typescript
async function cheerpjRunLibrary(classPath: string): Promise<CJ3Library>;
```

Returns a `CJ3Library` Proxy. Every step must be awaited:

```javascript
const lib = await cheerpjRunLibrary("/app/example.jar");
const Example = await lib.com.example.Example;     // Resolve class
const obj = await new Example();                     // Construct instance
const result = await obj.computeSomething("input");  // Call method — returns JS value!
await Example.staticMethod();                        // Static method call
```

### Type conversion (LiveConnect)

| JavaScript | Java | Note |
|---|---|---|
| `Uint8Array` | `boolean[]` | By reference |
| `Int8Array` | `byte[]` | By reference |
| `Int32Array` | `int[]` | By reference |
| `Float64Array` | `double[]` | By reference |
| string | String | Automatic |
| number | int/float/double | Automatic |

### CJ3Library#getJNIDataView()

Returns a `DataView` of the library's raw JNI memory (advanced).

### Long-running thread pattern (critical for persistent interop)

```java
// Java
public static native void nativeSetApplication(Example app);
public static void main(String[] args) {
    Example app = new Example();
    new Thread(() -> { nativeSetApplication(app); }).start();
}
```

```javascript
// JavaScript — register via cheerpjInit({ natives: { ... } })
async function Java_Example_nativeSetApplication(lib, app) {
    window.myApp = app;        // Save the Java instance globally
    return new Promise(() => {}); // NEVER resolves — keeps Java thread alive
}

// Later, from any JS code:
const result = await window.myApp.processInput("hello");
```

The `return new Promise(() => {})` pattern keeps a Java thread alive so
JavaScript can call back into Java at any time. This is the key to making
library mode work for persistent interop.

---

## cheerpOSAddStringFile() / cheerpOSRemoveStringFile()

```typescript
function cheerpOSAddStringFile(path: string, data: string | Uint8Array): void;
function cheerpOSRemoveStringFile(path: string): void;
```

- Path must begin with `/str/`.
- Synchronous. Must be called AFTER `cheerpjInit()` resolves.
- Overwrites existing file at that path.
- `cheerpOSRemoveStringFile` removes a `/str/` file (no-op if doesn't exist).

---

## cjFileBlob()

```typescript
async function cjFileBlob(path: string): Promise<Blob>;
```

Reads from `/files/`, `/app/`, OR `/str/` paths. Returns a Blob.

This means we could read output files from Java without console.log
interception: Java writes to `/files/output.txt`, then JS reads with
`cjFileBlob("/files/output.txt")`.

---

## File System (Virtual Mounts)

| Mount | Description | JS Write | Java Write | JS Read | Java Read | Persistent |
|---|---|---|---|---|---|---|
| `/app/` | HTTP-based, maps to web server root | No | No | No | Yes | N/A |
| `/files/` | IndexedDB-backed persistent storage | No | Yes | Yes (cjFileBlob) | Yes | Yes* |
| `/str/` | Transient JS-to-Java data passing | Yes (cheerpOSAddStringFile) | No | Yes (cjFileBlob) | Yes | No |

*`/files/` persistence depends on browser data retention.

### Key insight for agentidev

Since our runtime page is served from `http://localhost:9877`, JARs in the
asset-server root are accessible via `/app/` WITHOUT needing
`cheerpOSAddStringFile`. For example:
```javascript
// Instead of: fetch → arrayBuffer → cheerpOSAddStringFile → run
// We could just: cheerpjRunMain("MyClass", "/app/myjar.jar")
```
This eliminates the fetch + inject roundtrip for JARs that are served by the
asset-server. The `/str/` path is still needed for JARs fetched from other
origins (e.g., extension resources).

---

## Classpath Format

Colon-separated paths in the virtual filesystem:
```
/app/main.jar:/app/lib1.jar:/str/wrapper.jar
```

Works with any mount: `/app/`, `/str/`, `/files/`.

Only `cheerpjRunMain` accepts classpath. `cheerpjRunJar` and
`cheerpjRunLibrary` take a single path.

---

## Console/stdout Capture

**No official API to redirect Java stdout.** CheerpJ routes
`System.out.println()` through the browser's `console.log()`.

Our console.log interception approach is the documented workaround.

### Alternatives

1. **Native methods**: Have Java call a native method with the result.
   Requires modifying the Java source (or using a wrapper class).
2. **Library mode**: Call methods directly and get return values. Bypasses
   stdout entirely since values are marshalled directly.
3. **File-based**: Java writes to `/files/output.txt`, JS reads with
   `cjFileBlob("/files/output.txt")`.

---

## Networking

- Same-origin HTTP/HTTPS: Java can use `URLConnection`, `HttpClient`, etc.
  CheerpJ uses the browser's `fetch` internally. CORS rules apply.
- Raw TCP/UDP: Requires Tailscale VPN integration.
- Configured via `cheerpjInit` Tailscale options.

---

## Performance

- **2-tier JIT**: Interpreter (profiles code) + JIT compiler (hot paths → JS).
- **Runtime chunks**: ~10-20 MB total, loaded on demand, browser-cached.
- **`cjGetRuntimeResources()`**: Run in console after a session to get chunk
  map for `preloadResources` option (parallel download on future loads).
- **`cjGetProguardConfiguration()`**: Generates ProGuard config for tree-shaking.

---

## Known Limitations

1. Java versions 8, 11, 17 only. Applets are Java 8 only.
2. Must be served over HTTP/HTTPS — `file://` doesn't work.
3. Server must support HTTP Range requests.
4. Some browser shortcuts cannot be overridden (Ctrl+T/N/W).
5. `clipboardMode: "permission"` requires HTTPS.
6. Raw TCP/UDP requires Tailscale.
7. 404 errors in console are NORMAL (CheerpJ's HTTP filesystem probes).
8. COOP/COEP headers BREAK CheerpJ (no SharedArrayBuffer needed).
9. Reflection and dynamic class generation ARE supported.

---

## Version Note

The project loads CheerpJ 4.0 (`cjrtnc.leaningtech.com/4.0/loader.js`).
Current docs reference 4.2 (`cjrtnc.leaningtech.com/4.2/loader.js`).
Upgrading may fix the library mode Proxy hang.

---

## Agentidev-Specific: Current vs Recommended Patterns

### Current hacks

1. **Console.log interception for stdout** — monkey-patches `console.log`.
   Fragile; mixes non-Java output.
2. **`clipboardMode: 'none'`** — not a valid value. Should be `'java'`.
3. **cheerpOSAddStringFile for every JAR** — unnecessary for JARs served
   by the asset-server (they're accessible via `/app/`).
4. **Library mode unused** — code exists but hangs in nested-iframe
   contexts. May be fixable by upgrading to CheerpJ 4.2 or using the
   long-running thread pattern.
5. **NoLogValidator wrapper** — could be replaced by `javaProperties:
   ['java.util.logging.config.file=/dev/null']`.

### Recommended improvements

1. **Fix `clipboardMode`** to `'java'` (the default).
2. **Upgrade to CheerpJ 4.2** and re-test library mode.
3. **Use `/app/` for asset-server JARs** — skip the fetch + inject.
4. **Use `cjFileBlob()`** for reading Java output files.
5. **Use `javaProperties`** instead of NoLogValidator for JUL suppression.
6. **Consider native methods** for direct stdout channel (no console.log).
7. **Consider `execCallback`** for intercepting subprocess calls in
   horsebread's Node.js pipeline running on CheerpJ.
8. **Use `preloadResources`** for faster repeat loads.
