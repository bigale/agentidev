# CheerpX API Reference (from cheerpx.io/docs, crawled 2026-04-12)

Source: https://cheerpx.io/docs/overview

This document captures the full CheerpX API as documented plus undocumented
APIs discovered from WebVM source and TypeScript definitions. Intended for
ingestion into the agentidev local vector DB for AI-assisted development.

---

## CheerpX.Linux.create()

```typescript
static async create(options?: {
  mounts?: MountPointConfiguration[];
  networkInterface?: NetworkInterface;
}): Promise<Linux>;
```

### MountPointConfiguration

```typescript
interface MountPointConfiguration {
  type: "ext2" | "dir" | "devs" | "proc" | "devpts" | "sys";
  path: string;
  dev?: Device;  // Required for ext2 and dir; optional for devs, proc, devpts, sys
}
```

- First mount MUST be `"/"` (root).
- `ext2` requires a BlockDevice (OverlayDevice, HttpBytesDevice, CloudDevice).
- `dir` requires a CheerpOSDevice (WebDevice, DataDevice, IDBDevice).
- `devs`, `proc`, `devpts`, `sys` need no `dev` property.
- `devpts` and `sys` are undocumented but used by WebVM and work.

### NetworkInterface

```typescript
interface NetworkInterface {
  authKey?: string;           // Tailscale pre-auth key
  controlUrl?: string;        // Self-hosted Headscale URL (default: Tailscale)
  loginUrlCb?: (url: string) => void;    // Called with URL for manual login
  stateUpdateCb?: (state: number) => void;  // State 6 = connected/running
  netmapUpdateCb?: (map: any) => void;      // map.self.addresses[0] = current IP
}
```

---

## cx.run()

```typescript
async run(
  fileName: string,
  args: string[],
  options?: {
    env?: string[];   // "KEY=VALUE" format
    cwd?: string;     // Working directory
    uid?: number;
    gid?: number;
  }
): Promise<{ status: number }>;
```

- Returns a Promise that resolves WHEN THE PROCESS TERMINATES.
- `{ status: number }` is the exit code.
- NO way to kill/signal a running process from JS. Promise resolves only on natural exit.
- NO stdin/stdout pipe API. I/O goes through setConsole/setCustomConsole.
- If you run `/bin/bash --login`, the promise won't resolve until bash exits.

---

## Console API

### setConsole(element)

```typescript
setConsole(element: HTMLElement): void;
```

- Takes a `<pre>` element.
- Built-in terminal emulator. Handles keyboard input when element has focus.
- Output appears as `<p>` children (one per terminal line).
- Cannot programmatically intercept output or inject input.

### setCustomConsole(writeFunc, cols, rows) -> send

```typescript
setCustomConsole(
  writeFunc: (buf: Uint8Array, vt: number) => void,
  cols: number,
  rows: number
): (keyCode: number) => void;
```

- `writeFunc` receives output as `Uint8Array` buffer and a virtual terminal number.
- **CRITICAL**: The `vt` parameter indicates which virtual terminal is writing.
  WebVM filters with `if (vt != 1) return;` to only capture the main terminal.
  Without this filter, output from other VTs may be missed or mixed.
- Returns a `send` function: call `send(charCode)` to inject input characters.
- Send Ctrl+C: `send(3)` (ASCII ETX).
- For xterm.js: `term.write(new Uint8Array(buf))` in writeFunc.
- For programmatic capture: decode buf with TextDecoder and accumulate.
- The three-argument signature `(writeFunc, cols, rows)` is required. Calling
  with just `(writeFunc)` may silently fail.

### setActivateConsole(callback)

```typescript
setActivateConsole(
  callback: (idx: number) => void
): (idx: number) => void;
```

- For switching between virtual terminals (text vs graphical).
- WebVM uses VT 7 for the graphical display (KMS canvas).

---

## Devices

### HttpBytesDevice (BlockDevice, read-only)

```typescript
static async create(url: string): Promise<HttpBytesDevice>;
```

- Streams ext2 disk image via HTTP range requests.
- Server MUST support Range requests + Last-Modified or ETag.
- Fetches blocks on demand (lazy loading).
- Requires CORS headers if cross-origin.

### CloudDevice (BlockDevice, read-only, undocumented)

```typescript
static async create(url: string): Promise<CloudDevice>;
```

- Uses WebSocket protocol (wss://) for streaming from Leaning Technologies CDN.
- Preferred for large images (2GB+). Global CDN for low latency.
- Falls back to HTTPS if WSS fails.

### IDBDevice (CheerpOSDevice AND BlockDevice)

```typescript
static async create(dbName: string): Promise<IDBDevice>;
async readFileAsBlob(path: string): Promise<Blob>;
async reset(): Promise<void>;
```

- Dual-role: can be used as a dir-type CheerpOSDevice mount OR as a BlockDevice
  for OverlayDevice's writable layer.
- **readFileAsBlob(path)**: reads a file from the IDBDevice and returns a JS Blob.
  Path is relative to device root. This is the ONLY documented way to read file
  content OUT of the VM into JavaScript.
- **reset()**: clears ALL stored data (factory reset).
- Persists across page loads via IndexedDB.

### OverlayDevice (BlockDevice)

```typescript
static async create(
  base: BlockDevice,
  overlay: IDBDevice
): Promise<OverlayDevice>;
```

- Copy-on-write: reads from base, writes to overlay.
- Base is typically HttpBytesDevice or CloudDevice (read-only disk image).
- Overlay is IDBDevice (writable, cached).
- Modified blocks are stored in IDB overlay.
- Persists across page loads.

### DataDevice (CheerpOSDevice, in-memory, write-only from JS)

```typescript
static async create(): Promise<DataDevice>;
async writeFile(path: string, data: string | Uint8Array): Promise<void>;
```

- **writeFile(path, data)**: accepts string OR Uint8Array directly. Path is
  relative to device root (e.g., `/filename`), NOT the mount point.
- **CRITICAL**: DataDevice does NOT support the executable bit. Files written
  to DataDevice CANNOT be executed directly. Copy them to an ext2 or IDB
  filesystem first: `await cx.run("/bin/cp", ["/data/file", "/tmp/file"])`.
- In-memory only. Does NOT persist across page loads.
- There is NO readFile method on DataDevice.
- Mount type is `"dir"`.

### WebDevice (CheerpOSDevice, read-only)

```typescript
static async create(path: string): Promise<WebDevice>;
```

- Read-only HTTP directory access.
- Requires `index.list` files for directory listing (HTTP has no native ls).
- Paths are relative to current page URL.
- CAN use third-party origins with proper CORS headers.
- Binary files must be served as `application/octet-stream`.

### FileDevice (BlockDevice, undocumented)

```typescript
static async create(
  parent: CheerpOSDevice,
  fileName: string
): Promise<FileDevice>;
```

- Creates a block device from a single file on a CheerpOSDevice.
- Purpose unclear. Could be used to mount a disk image file from an IDBDevice.

---

## Networking

Networking requires Tailscale. There is no general networking without it.

Browser limitations: only HTTP(S) subject to CORS. No raw TCP/UDP. Even fetch
is not usable from inside the VM because HTTPS traffic is encrypted at the
application layer, and CORS rules block most cross-domain requests.

Tailscale VPN via WebSockets gives a full TCP/IP stack inside the VM.

Setup options:
1. Pre-authenticated: pass `authKey` in networkInterface.
2. Interactive login: use `loginUrlCb` to get login URL, then `cx.networkLogin()`.
3. Self-hosted: set `controlUrl` to your Headscale server URL.

Exit node required for internet access. Not needed for Tailscale-internal
communication (WebVM-to-WebVM or WebVM-to-local-machine).

`cx.networkLogin()` exists (used by WebVM) but is not in TypeScript types.

---

## Cross-Origin Isolation

**Mandatory.** CheerpX requires SharedArrayBuffer, which requires COI.

Required HTTP headers on the page hosting CheerpX:

```
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

- `file://` protocol CANNOT work.
- `localhost` is exempt from HTTPS requirement, but headers still needed.
- Production must use HTTPS.
- These headers may break third-party iframes and cross-origin popups.
- Error without COI: `DataCloneError: The SharedArrayBuffer object cannot be serialized.`
- Subresources loaded by a COEP page must send `Cross-Origin-Resource-Policy: cross-origin`.

---

## Event Callbacks

```typescript
cx.registerCallback("cpuActivity", (state: "ready" | "wait") => void);
cx.registerCallback("diskActivity", (state: "ready" | "wait") => void);
cx.registerCallback("diskLatency", (latency: number) => void);
cx.registerCallback("processCreated", () => void);
```

- `processCreated` fires when any native process is created inside the VM.
- `cpuActivity` and `diskActivity` can drive activity indicators.

---

## KMS Canvas (graphical output)

```typescript
cx.setKmsCanvas(canvas: HTMLCanvasElement, width: number, height: number): void;
```

Enables graphical output (e.g., Xorg) on an HTML canvas. WebVM uses VT 7
for graphics, VT 1 for text console.

---

## Cleanup

```typescript
cx.delete(): void;
device.delete(): void;
```

Both exist in TypeScript definitions but are not documented. Presumably
for teardown/cleanup.

---

## Custom Disk Images

Requirements:
- Must be i386 (32-bit x86). CheerpX does NOT support 64-bit executables.
- Build with: `FROM --platform=i386 i386/debian:buster` in Dockerfile.
- Extract with: `podman unshare` + `podman mount`.
- Create ext2: `mkfs.ext2 -b 4096 -d <dir> <image> 600M`.
- Block size of 4096 is required.

---

## Key Gotchas Summary

1. DataDevice files are NOT executable. Must copy to ext2/IDB first.
2. No readFile on DataDevice. Write-only from JS side.
3. setCustomConsole requires 3 args (writeFunc, cols, rows) and the vt
   parameter matters. Filter by vt === 1 for main terminal output.
4. No process kill API from JS. Send Ctrl+C (charCode 3) through the
   send function returned by setCustomConsole, or use `kill` from inside.
5. cx.run() blocks until exit. Interactive shell = Promise never resolves
   until shell exits.
6. readFileAsBlob works only on IDBDevice mounts. Copy files there first.
7. WebDevice needs index.list for directory listing.
8. COI breaks third-party iframes and popups.
9. 32-bit x86 only. No 64-bit.
10. In-VM networking requires Tailscale. No shortcut.
11. IDBDevice.readFileAsBlob does NOT stream. Use setCustomConsole for
    real-time output.
12. Linux.delete() and Device.delete() exist but are undocumented.
13. CloudDevice is undocumented but is the primary recommended disk backend.

---

## Agentidev-Specific Patterns (discovered during implementation)

### Current approach (pre-refactor)
- File upload: chunked base64 via cx.run('/bin/sh', ['-c', 'echo b64 | base64 -d >> path'])
- File read: cx.run('/bin/cat', [path]) with childNode walking on the vmConsole <pre>
- Streaming: MutationObserver on vmConsole <p> children
- Stdout capture: walk new <p> children after cx.run resolves

### Recommended approach (post-refactor using documented APIs)
- File upload: DataDevice.writeFile(path, bytes) + cx.run('/bin/cp', ['/data/file', '/dest'])
- File read: cx.run('/bin/cp', ['/source', '/files/output']) + idbDevice.readFileAsBlob('/output')
- Streaming: setCustomConsole(writeFunc, 80, 24) with vt filter + TextDecoder
- Kill: send(3) from the setCustomConsole return value
- Activity monitoring: registerCallback('cpuActivity' | 'processCreated')
