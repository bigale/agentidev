/**
 * Host Capability Interface — JSDoc typedefs.
 *
 * The abstraction that every agentidev app targets. The chrome extension is
 * the baseline host and implements the full interface; other hosts (web app,
 * Tauri, iOS, etc.) implement subsets + bridge the rest.
 *
 * App code should NEVER call `chrome.runtime.*`, `fetch`, or platform APIs
 * directly. It calls `host.*`. Porting swaps the host binding, not the app.
 *
 * This file is pure documentation — no runtime code. Implementations attach
 * to the global namespace `window.Host` via classic <script> loads.
 * See `host-chrome-extension.js` for the baseline implementation.
 *
 * ---------------------------------------------------------------------------
 * Full interface definition
 * ---------------------------------------------------------------------------
 *
 * @typedef {Object} HostCapabilities
 * @property {HostStorage}  storage   Key/value + opaque blob persistence
 * @property {HostFs}       fs        Virtual filesystem (OPFS, real FS, etc.)
 * @property {HostExec}     exec      Run commands in a compute substrate
 * @property {HostNetwork}  network   Cross-origin fetch + WebSocket
 * @property {HostMessage}  message   Privileged cross-process messaging
 * @property {HostIdentity} identity  Host type + install ID
 *
 * ---------------------------------------------------------------------------
 * storage — Phase 0 has only `export`. Later phases add get/set/blob.
 * ---------------------------------------------------------------------------
 *
 * @typedef {Object} HostStorage
 * @property {(opts?: {stores?: string[]}) => Promise<HostStorageExportResult>} export
 *   Export app storage to the host's backing store (bridge server, cloud,
 *   local disk, etc.). `opts.stores` optionally limits to named stores.
 * @property {(key: string) => Promise<any>} [get]              // Phase 1+
 * @property {(key: string, value: any) => Promise<void>} [set] // Phase 1+
 * @property {HostStorageBlob} [blob]                            // Phase 1+
 *
 * @typedef {Object} HostStorageExportResult
 * @property {boolean} success
 * @property {number} [storesCount]
 * @property {number} [totalRecords]
 * @property {string} [error]
 *
 * @typedef {Object} HostStorageBlob
 * @property {(key: string, bytes: Uint8Array) => Promise<void>} put
 * @property {(key: string) => Promise<Uint8Array>} get
 *
 * ---------------------------------------------------------------------------
 * fs — Phase 2+
 * ---------------------------------------------------------------------------
 *
 * @typedef {Object} HostFs
 * @property {(path: string) => Promise<Uint8Array>} read
 * @property {(path: string, bytes: Uint8Array) => Promise<void>} write
 * @property {(path: string) => Promise<string[]>} list
 * @property {(path: string, cb: (evt: HostFsEvent) => void) => () => void} watch
 *
 * @typedef {Object} HostFsEvent
 * @property {'add'|'change'|'remove'} type
 * @property {string} path
 *
 * ---------------------------------------------------------------------------
 * exec — Phase 1+ (CheerpX spike)
 * ---------------------------------------------------------------------------
 *
 * @typedef {Object} HostExec
 * @property {(cmd: string, args: string[], opts?: HostExecOpts) => HostExecHandle} spawn
 *
 * @typedef {Object} HostExecOpts
 * @property {string} [cwd]
 * @property {Object<string, string>} [env]
 * @property {number} [timeoutMs]
 *
 * @typedef {Object} HostExecHandle
 * @property {AsyncIterable<string>} stdout
 * @property {AsyncIterable<string>} stderr
 * @property {Promise<number>} exit
 * @property {() => void} kill
 *
 * ---------------------------------------------------------------------------
 * network — Phase 1+
 * ---------------------------------------------------------------------------
 *
 * @typedef {Object} HostNetwork
 * @property {(url: string, init?: RequestInit) => Promise<Response>} fetch
 * @property {(url: string) => WebSocket} websocket
 *
 * ---------------------------------------------------------------------------
 * message — Phase 0 has send only. subscribe is Phase 1+.
 * ---------------------------------------------------------------------------
 *
 * @typedef {Object} HostMessage
 * @property {(channel: string, payload: any, opts?: {timeoutMs?: number}) => Promise<any>} send
 * @property {(channel: string, cb: (msg: any) => void) => () => void} [subscribe]
 *
 * ---------------------------------------------------------------------------
 * identity — Phase 0
 * ---------------------------------------------------------------------------
 *
 * @typedef {Object} HostIdentity
 * @property {'chrome-extension'|'chrome-extension-sandbox'|'web-app'|'tauri'|'electron'|'ios'|'android'} hostType
 * @property {string} installId
 *
 * ---------------------------------------------------------------------------
 * Runtime expectation
 * ---------------------------------------------------------------------------
 *
 * After loading a host implementation script, callers access the instance via:
 *
 *   var host = window.Host.get();
 *   host.storage.export().then(function (r) { ... });
 *
 * `window.Host.get()` must be lazy (creates on first call) and memoized.
 */

// Nothing to export at runtime. This file is documentation only.
// A sanity marker for loaders that check whether the interface is loaded:
if (typeof window !== 'undefined') {
  window.HostInterfaceLoaded = true;
}
