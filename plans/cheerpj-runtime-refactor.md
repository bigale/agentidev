# Plan: CheerpJ Runtime Refactor

Based on the full CheerpJ API documentation (see `docs/cheerpj-api-reference.md`).
Less dramatic than the CheerpX refactor — CheerpJ doesn't have direct
file I/O equivalents of DataDevice/IDBDevice — but several fixes and
improvements are available.

---

## Changes by priority

### P0 — Bug fixes (do now)

**1. Fix `clipboardMode: 'none'`**

`'none'` is not a valid `clipboardMode` value. The valid options are
`"java"` (default), `"system"`, and `"permission"`. Our init should
either omit it (to get the default `"java"`) or explicitly set `"java"`.

File: `~/.agentidev/cheerpx-assets/cheerpj-runtime.html` line 79.

**2. Upgrade CheerpJ from 4.0 to 4.2**

The docs reference 4.2 in all examples. 4.0 is over a year old.
Library mode Proxy hang may be fixed in 4.2.

File: `~/.agentidev/cheerpx-assets/cheerpj-runtime.html` line 19.

Change `cjrtnc.leaningtech.com/4.0/loader.js` → `cjrtnc.leaningtech.com/4.2/loader.js`.

### P1 — Use `/app/` mount for asset-server JARs

Since `cheerpj-runtime.html` is served from `http://localhost:9877`, all
files in `~/.agentidev/cheerpx-assets/` are accessible via `/app/` in
CheerpJ's virtual filesystem. This means:

```javascript
// Current: fetch JAR bytes → cheerpOSAddStringFile → run
const resp = await fetch(jarUrl);
const bytes = new Uint8Array(await resp.arrayBuffer());
cheerpOSAddStringFile('/str/jar.jar', bytes);
cheerpjRunMain('ClassName', '/str/jar.jar', ...args);

// Proposed: just reference the JAR at /app/
cheerpjRunMain('ClassName', '/app/jar.jar', ...args);
```

Eliminates the fetch + ArrayBuffer + inject roundtrip. CheerpJ handles
the HTTP fetch internally with proper caching.

**Caveats:**
- Only works for JARs served by the asset-server (localhost:9877).
- JARs from other origins (e.g., extension resources) still need `/str/`.
- The `extraJars` pattern (multiple JARs from different URLs) would need
  to handle mixed origins: some via `/app/`, others via `/str/`.

**Recommendation:** Keep the current `/str/` approach as the default
(works for all origins) but add an optimization path: if the jarUrl
starts with `http://localhost:9877/`, skip the fetch and use
`/app/<filename>` directly. Document the optimization in cheerpj-host.js.

### P2 — Use `javaProperties` for JUL suppression

Replace the `NoLogValidator` wrapper JAR with a `cheerpjInit` property:

```javascript
cheerpjInit({
  version: 11,
  javaProperties: [
    'java.util.logging.config.file=/dev/null',
  ],
});
```

This turns off java.util.logging globally without needing a wrapper
class. The NoLogValidator wrapper + the `extraJars` pattern still works
as a fallback for more targeted suppression, but the global property is
cleaner for cases where we just want to silence the StackStreamFactory
JNI issue.

**Caveat:** This disables ALL JUL logging, not just the problematic
ConsoleHandler formatter. If a plugin's Java code uses JUL for real
logging, this approach would silence it. May want to make this
configurable per-plugin via manifest.

### P3 — Use `cjFileBlob()` for reading Java output

CheerpJ provides `cjFileBlob(path)` that reads from `/files/`, `/app/`,
or `/str/`. Java can write output to `/files/result.json`, then JS reads:

```javascript
await cheerpjRunMain('MyClass', '/app/my.jar', '--output=/files/result.json');
const blob = await cjFileBlob('/files/result.json');
const text = await blob.text();
```

This is cleaner than console.log interception for structured output
(JSON reports, data files). The console.log approach is still needed for
capturing stdout from programs that print to System.out — but for
programs we control (wrapper classes), file-based output is more
reliable.

**Recommendation:** Offer both paths. The `runMain` command continues to
capture stdout via console.log for backward compat. Add a new `runJar`
command that supports a `outputPath` option — Java writes there, JS
reads via `cjFileBlob`.

### P4 — Re-test library mode on CheerpJ 4.2

After upgrading to 4.2 (P0), re-test `cheerpjRunLibrary`. If the Proxy
walk works:

```javascript
const lib = await cheerpjRunLibrary('/app/nist-validator.jar');
const Validator = await lib.com.aav.nist.BrowserValidator;
const result = await Validator.validate(hl7, profile);
// result is a Java String → JS string directly. No stdout capture needed.
```

This would be the cleanest path for the NIST validator and BeanShell:
- No wrapper classes
- No console.log interception
- Direct return values
- Reusable: load once, call many times (no re-importing class table)

If library mode still hangs on 4.2, try the long-running thread pattern:

```java
// Wrapper class
public class AgentidevBridge {
    public static native void registerBridge(AgentidevBridge bridge);
    public void validate(String hl7, String profile) { ... }
    public static void main(String[] args) {
        new Thread(() -> registerBridge(new AgentidevBridge())).start();
    }
}
```

```javascript
cheerpjInit({
  natives: {
    async Java_AgentidevBridge_registerBridge(lib, bridge) {
      window._javaBridge = bridge;
      return new Promise(() => {}); // Keep thread alive forever
    }
  }
});
await cheerpjRunMain('AgentidevBridge', '/app/nist-validator.jar');
// Now call methods directly:
const result = await window._javaBridge.validate(hl7, profile);
```

### P5 — Consider `execCallback` for horsebread

CheerpJ 3.1+ has `execCallback` that intercepts `Runtime.exec()` /
`ProcessBuilder` calls. If horsebread's Node.js pipeline runs on
CheerpJ (unlikely given it runs on CheerpX for x86), this callback
could route subprocess calls through the bridge.

Low priority — horsebread runs Python/Node on CheerpX, not CheerpJ.
But worth noting for future Java-heavy plugins.

---

## Files to modify

| File | Changes |
|---|---|
| `~/.agentidev/cheerpx-assets/cheerpj-runtime.html` | Fix clipboardMode, upgrade to 4.2, add /app/ optimization, add cjFileBlob read path |
| `extension/cheerpj-app/cheerpj-host.js` | Optional: skip fetch for localhost:9877 JARs |
| `extension/cheerpj-app/wrappers/NoLogValidator.java` | Keep but document javaProperties alternative |

---

## Verification checklist

1. cheerpjInit with `clipboardMode: 'java'` + version 4.2 boots without errors
2. Existing hello-runtime CheerpJ button still works (hello-main.jar)
3. BeanShell eval still works (bsh runtime)
4. NIST validator still works (Phase 1.8 test)
5. If library mode works on 4.2: Proxy walk resolves classes and methods
6. 145/145 Jest tests pass
