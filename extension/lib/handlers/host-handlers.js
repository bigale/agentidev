/**
 * Host capability SW handlers — the platform side of host.storage,
 * host.network, host.exec, and host.fs. These are dispatched from the
 * sandbox iframe via host.message.send(channel, payload), routed by the
 * existing wrapper.html bridge into the SW dispatch table.
 *
 * Each surface is intentionally thin — the SW is the authority for the
 * underlying capability and the methods on `window.Host` in
 * host-chrome-extension.js are postMessage adapters. Plugin code never
 * touches chrome.runtime.* directly.
 *
 * Surfaces:
 *   HOST_STORAGE_GET / SET             — chrome.storage.local key/value
 *   HOST_STORAGE_BLOB_PUT / GET        — base64-wrapped binary in storage.local
 *   HOST_STORAGE_DEL                   — remove a key
 *   HOST_NETWORK_FETCH                 — extension-origin fetch with full
 *                                        host_permissions; returns a
 *                                        serializable subset of Response
 *   HOST_EXEC_SPAWN                    — defaults to cheerpx (runtime: 'cheerpx')
 *                                        — thin pass-through to the cheerpx
 *                                        runtime's spawn handler
 *   HOST_FS_READ / WRITE / LIST        — fs operations against the cheerpx
 *                                        VM via cheerpx-* commands
 *
 * Streaming exec, host.fs.watch, and OPFS-backed blob storage are deferred
 * to Phase 4.6 (they need a different transport than chrome.runtime.sendMessage).
 */

// ---------------------------------------------------------------------------
// host.storage
// ---------------------------------------------------------------------------

async function storageGet(key) {
  const out = await chrome.storage.local.get(key);
  return { value: out[key] };
}

async function storageSet(key, value) {
  await chrome.storage.local.set({ [key]: value });
  return { success: true };
}

async function storageDel(key) {
  await chrome.storage.local.remove(key);
  return { success: true };
}

// host.storage.blob — opaque bytes wrapped in base64 in storage.local. This
// is fine for small blobs (a few hundred KB), bad for big ones. Phase 4.6
// will switch the implementation to OPFS without changing the API.

function bytesToBase64(bytes) {
  // bytes: Uint8Array | number[]
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

async function storageBlobPut(key, bytes) {
  const b64 = bytesToBase64(bytes);
  const storeKey = '__blob__:' + key;
  await chrome.storage.local.set({ [storeKey]: b64 });
  return { success: true, size: b64.length };
}

async function storageBlobGet(key) {
  const storeKey = '__blob__:' + key;
  const out = await chrome.storage.local.get(storeKey);
  const b64 = out[storeKey];
  if (b64 == null) return { found: false };
  // Return as a number array for postMessage transport (Uint8Array doesn't
  // serialize across postMessage boundary cleanly in all hosts).
  return { found: true, bytes: Array.from(base64ToBytes(b64)) };
}

// ---------------------------------------------------------------------------
// host.network
// ---------------------------------------------------------------------------

/**
 * Fetch a URL from the SW context and return a serializable subset of the
 * Response. The SW has full host_permissions so this works for any URL.
 *
 * Plugins use this when they need to call an external API but don't want to
 * (or can't) deal with CORS in their own context.
 *
 * @param {string} url
 * @param {object} [init]   fetch RequestInit (method, headers, body)
 * @param {string} [as]     'text' | 'json' | 'bytes' (default 'text')
 */
async function networkFetch(url, init, as) {
  const r = await fetch(url, init || {});
  const headers = {};
  for (const [k, v] of r.headers.entries()) headers[k] = v;
  const out = {
    ok: r.ok,
    status: r.status,
    statusText: r.statusText,
    url: r.url,
    headers,
  };
  const want = as || 'text';
  if (want === 'json') {
    try { out.json = await r.json(); } catch (e) { out.error = 'json parse: ' + e.message; }
  } else if (want === 'bytes') {
    const buf = await r.arrayBuffer();
    out.bytes = Array.from(new Uint8Array(buf));
  } else {
    out.text = await r.text();
  }
  return out;
}

// ---------------------------------------------------------------------------
// host.exec — defaults to cheerpx
// ---------------------------------------------------------------------------

/**
 * Run a command in the default exec runtime. Today the default is `cheerpx`
 * (the only registered vm-style runtime). Callers wanting a different
 * runtime should call host.runtimes.get('<name>').spawn(...) directly.
 */
async function execSpawn(handlers, msg) {
  if (typeof handlers['cheerpx-spawn'] !== 'function') {
    throw new Error('host.exec.spawn: no cheerpx runtime registered');
  }
  return handlers['cheerpx-spawn']({
    cmd: msg.cmd,
    args: msg.args || [],
    opts: msg.opts || {},
    timeout: msg.timeout, // propagate caller-specified timeout
  });
}

// ---------------------------------------------------------------------------
// host.fs — operates on the cheerpx VM filesystem via cheerpx-fs handlers
// ---------------------------------------------------------------------------

/**
 * Each fs operation routes to a corresponding cheerpx-* command on the
 * runtime page. Read/write are byte-oriented through base64 to survive
 * postMessage cleanly; write is currently bounded by command-line argv
 * length (~64 KB after base64 expansion) — bigger files want a stdin pipe
 * which is Phase 4.6 work.
 */
async function fsRead(handlers, path, as) {
  if (as === 'bytes') {
    if (typeof handlers['cheerpx-fs-read-bytes'] !== 'function') {
      throw new Error('host.fs.read(as:bytes): cheerpx fs-read-bytes handler not registered');
    }
    const r = await handlers['cheerpx-fs-read-bytes']({ path });
    if (!r.success) return r;
    // The runtime returns { bytes: number[] } via IDBDevice.readFileAsBlob.
    return { success: true, exitCode: r.exitCode, bytes: r.bytes || [] };
  }
  if (typeof handlers['cheerpx-fs-read'] !== 'function') {
    throw new Error('host.fs.read: cheerpx fs handler not registered');
  }
  return handlers['cheerpx-fs-read']({ path });
}

async function fsWrite(handlers, path, content) {
  if (typeof handlers['cheerpx-fs-write'] !== 'function') {
    throw new Error('host.fs.write: cheerpx fs handler not registered');
  }
  return handlers['cheerpx-fs-write']({ path, content });
}

async function fsList(handlers, path) {
  if (typeof handlers['cheerpx-fs-list'] !== 'function') {
    throw new Error('host.fs.list: cheerpx fs handler not registered');
  }
  return handlers['cheerpx-fs-list']({ path });
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export function register(handlers) {
  // ---- storage ----
  handlers['HOST_STORAGE_GET'] = async (msg) => storageGet(msg.key);
  handlers['HOST_STORAGE_SET'] = async (msg) => storageSet(msg.key, msg.value);
  handlers['HOST_STORAGE_DEL'] = async (msg) => storageDel(msg.key);
  handlers['HOST_STORAGE_BLOB_PUT'] = async (msg) => storageBlobPut(msg.key, msg.bytes || []);
  handlers['HOST_STORAGE_BLOB_GET'] = async (msg) => storageBlobGet(msg.key);

  // ---- network ----
  handlers['HOST_NETWORK_FETCH'] = async (msg) => networkFetch(msg.url, msg.init, msg.as);

  // ---- exec (delegates to cheerpx) ----
  // Wrapped in a closure so the handler captures the handlers map at register
  // time and can find cheerpx-spawn at call time.
  handlers['HOST_EXEC_SPAWN'] = async (msg) => execSpawn(handlers, msg);

  // Streaming exec — caller provides a clientStreamId; the SW relays each
  // chunk via chrome.runtime.sendMessage broadcast (CHEERPX_STREAM_EVENT)
  // which wrapper.html forwards to the sandbox.
  handlers['HOST_EXEC_SPAWN_STREAM_START'] = async (msg) => {
    if (typeof handlers['cheerpx-spawn-stream-start'] !== 'function') {
      throw new Error('host.exec.spawnStream: cheerpx stream handler not registered');
    }
    return handlers['cheerpx-spawn-stream-start']({
      streamId: msg.streamId,
      cmd: msg.cmd,
      args: msg.args || [],
      opts: msg.opts || {},
    });
  };

  handlers['HOST_EXEC_SPAWN_STREAM_KILL'] = async (msg) => {
    if (typeof handlers['cheerpx-spawn-stream-kill'] !== 'function') {
      throw new Error('host.exec.spawnStream.kill: cheerpx stream handler not registered');
    }
    return handlers['cheerpx-spawn-stream-kill']({ streamId: msg.streamId });
  };

  // ---- fs (delegates to cheerpx-fs-*) ----
  handlers['HOST_FS_READ']  = async (msg) => fsRead(handlers, msg.path, msg.as);
  handlers['HOST_FS_WRITE'] = async (msg) => fsWrite(handlers, msg.path, msg.content);
  handlers['HOST_FS_LIST']  = async (msg) => fsList(handlers, msg.path);

  /**
   * Upload a URL's contents into the VM filesystem. The runtime page
   * fetches the URL (same-origin to its localhost:9877 host), chunks
   * the bytes, and writes them via base64-encoded cx.run shell commands.
   * This bypasses the 64 KB host.fs.write limit.
   */
  handlers['HOST_FS_UPLOAD'] = async (msg) => {
    if (typeof handlers['cheerpx-fs-upload'] !== 'function') {
      throw new Error('host.fs.upload: cheerpx fs-upload handler not registered');
    }
    return handlers['cheerpx-fs-upload']({ url: msg.url, path: msg.path });
  };

  // ---- fetch + transform (generic API → grid records) ----
  handlers['HOST_FETCH_AND_TRANSFORM'] = async (msg) => {
    const { url, init, jsonPath, fields } = msg;
    if (!url) return { success: false, error: 'url required' };
    try {
      const r = await fetch(url, init || {});
      if (!r.ok) return { success: false, error: 'fetch failed: ' + r.status };
      const json = await r.json();
      // Extract the array from jsonPath (e.g., "features")
      let records = json;
      if (jsonPath) {
        for (const p of jsonPath.split('.')) records = records?.[p];
      }
      if (!Array.isArray(records)) return { success: false, error: 'jsonPath did not resolve to array' };
      // Flatten: if records have a .properties sub-object, merge it up
      const flat = records.map((r, i) => {
        const base = { _rowId: i };
        const props = r.properties || r;
        if (fields) {
          for (const f of fields) base[f] = props[f] ?? '';
        } else {
          Object.assign(base, props);
        }
        return base;
      });
      return { success: true, data: flat, totalRows: flat.length };
    } catch (err) {
      return { success: false, error: err.message };
    }
  };

  // ---- identity ----
  // Surface the real chrome.runtime.id plus a per-install nonce that's
  // generated once and persisted in chrome.storage.local. The result is
  // stable across SW restarts but distinct per install.
  handlers['HOST_IDENTITY_GET'] = async () => {
    let nonce;
    try {
      const stored = await chrome.storage.local.get('__hostInstallNonce');
      nonce = stored && stored.__hostInstallNonce;
      if (!nonce) {
        nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
        await chrome.storage.local.set({ __hostInstallNonce: nonce });
      }
    } catch {
      nonce = 'unknown';
    }
    return {
      hostType: 'chrome-extension',
      extensionId: chrome.runtime.id,
      installId: chrome.runtime.id + ':' + nonce,
    };
  };
}
