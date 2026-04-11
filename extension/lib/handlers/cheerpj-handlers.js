/**
 * CheerpJ handler — service worker routing between arbitrary extension
 * pages and the cheerpj-app offscreen document that hosts the runtime.
 *
 * Flow:
 *   any page
 *     -> host.runtimes.get('cheerpj').runMain(...) in runtimes/cheerpj.js
 *     -> host.message.send('cheerpj-runMain', payload)
 *     -> wrapper/bridge.js postMessage to service worker
 *     -> chrome.runtime.onMessage -> this handler
 *     -> ensureOffscreen() creates cheerpj-app/cheerpj.html as offscreen doc (once)
 *     -> chrome.runtime.sendMessage({ type: 'CHEERPJ_INVOKE', command, payload })
 *        routed to offscreen doc
 *     -> offscreen doc's cheerpj-host.js relays via window.postMessage to the
 *        localhost iframe that actually runs CheerpJ
 *     -> response flows back the same path
 *
 * The offscreen document is created lazily on first cheerpj request and
 * stays alive for the life of the service worker. MV3 only permits one
 * offscreen document per extension — if one already exists for a
 * different purpose, creation is a no-op.
 */

// The CheerpJ host iframe is embedded inside the shared extension offscreen
// document at offscreen.html (MV3 only allows one offscreen doc per extension,
// so we can't have a dedicated one for CheerpJ). We rely on embeddings.js or
// llm.js having already created the offscreen doc, OR we create it here with
// WORKERS as the reason since that's what the shared doc serves.
const OFFSCREEN_URL = 'offscreen.html';
const OFFSCREEN_REASONS = ['WORKERS', 'IFRAME_SCRIPTING'];
const OFFSCREEN_JUSTIFICATION =
  'Shared offscreen document: transformers.js workers for embeddings/LLM and an iframe hosting the CheerpJ runtime.';

let _ensureInFlight = null;
let _offscreenReady = false;

// The offscreen document pings the service worker once its onMessage
// listener is installed. We resolve `_readyResolver` at that point so
// ensureOffscreen() can hold until the listener is actually receiving.
let _readyPromise = null;
let _readyResolver = null;

function resetReadyPromise() {
  _readyPromise = new Promise((resolve) => { _readyResolver = resolve; });
}
resetReadyPromise();

/**
 * Called from the service worker's onMessage listener when the offscreen
 * document signals it's ready to receive CHEERPJ_INVOKE messages.
 */
export function markOffscreenReady() {
  _offscreenReady = true;
  if (_readyResolver) _readyResolver();
}

/**
 * Ensure the CheerpJ offscreen document exists AND its message listener
 * is installed. Creates lazily on first call.
 */
async function ensureOffscreen() {
  // Self-heal: if the cached promise is resolved but the actual offscreen
  // doc has been torn down (closeDocument from another flow, crash, etc.),
  // reset so we re-create rather than sending to a ghost.
  if (_ensureInFlight && chrome.offscreen && chrome.offscreen.hasDocument) {
    try {
      const stillThere = await chrome.offscreen.hasDocument();
      if (!stillThere) {
        console.log('[CheerpJ] cached ensure is stale (doc gone), resetting');
        _ensureInFlight = null;
        _offscreenReady = false;
        resetReadyPromise();
      }
    } catch {}
  }
  if (_ensureInFlight) return _ensureInFlight;
  _ensureInFlight = (async () => {
    if (!chrome.offscreen || !chrome.offscreen.hasDocument) {
      throw new Error('chrome.offscreen API not available (Chrome 109+ required)');
    }
    const existing = await chrome.offscreen.hasDocument();
    if (existing) {
      console.log('[CheerpJ] offscreen document already exists');
      // If the service worker was restarted, _offscreenReady is false but
      // the doc is alive. We can either wait for its next ready signal or
      // trust that it's alive. Trust for now.
      _offscreenReady = true;
      if (_readyResolver) _readyResolver();
      return;
    }
    console.log('[CheerpJ] creating offscreen document:', OFFSCREEN_URL);
    resetReadyPromise();
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: OFFSCREEN_REASONS,
        justification: OFFSCREEN_JUSTIFICATION,
      });
      console.log('[CheerpJ] offscreen document created, waiting for ready signal');
      // Wait (with timeout) for the offscreen doc to signal its listener
      // is installed. Without this, the first chrome.runtime.sendMessage
      // can race the listener install and fail with "port closed".
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('CheerpJ offscreen ready timeout (10s)')), 10000));
      await Promise.race([_readyPromise, timeout]);
      console.log('[CheerpJ] offscreen ready');
    } catch (err) {
      console.error('[CheerpJ] createDocument failed:', err.message);
      _ensureInFlight = null;
      throw err;
    }
  })();
  try {
    await _ensureInFlight;
  } catch (err) {
    _ensureInFlight = null;
    throw err;
  }
  return _ensureInFlight;
}

/**
 * Send a command to the offscreen CheerpJ host page and await its response.
 * Uses chrome.runtime.sendMessage; the offscreen doc's listener returns
 * the runtime result.
 */
async function invokeOffscreen(command, payload) {
  await ensureOffscreen();
  // Target the offscreen doc specifically by including a dedicated envelope
  // type. Regular chrome.runtime.sendMessage broadcasts to all listeners,
  // but our handler registry filters on `type`, so the offscreen listener
  // only responds to CHEERPJ_INVOKE.
  const response = await chrome.runtime.sendMessage({
    type: 'CHEERPJ_INVOKE',
    command: command,
    payload: payload || {},
  });
  if (!response) {
    throw new Error('CheerpJ offscreen returned no response');
  }
  if (response.success === false) {
    throw new Error(response.error || 'CheerpJ invoke failed');
  }
  return response;
}

// ---------------------------------------------------------------------------
// Register message handlers
// ---------------------------------------------------------------------------

export function register(handlers) {
  // Offscreen doc signals its listener is installed via this handler.
  // Return `true` synchronously to keep the reply channel alive.
  handlers['CHEERPJ_OFFSCREEN_READY'] = async (msg) => {
    console.log('[CheerpJ] offscreen ready signal received');
    markOffscreenReady();
    return { success: true };
  };

  handlers['cheerpj-ping'] = async (msg) => {
    return invokeOffscreen('ping', {});
  };

  handlers['cheerpj-init'] = async (msg) => {
    return invokeOffscreen('init', { options: msg.options || {} });
  };

  handlers['cheerpj-runMain'] = async (msg) => {
    return invokeOffscreen('runMain', {
      jarUrl: msg.jarUrl,
      extraJars: msg.extraJars || [],
      className: msg.className,
      args: msg.args || [],
      cacheKey: msg.cacheKey,
      timeoutMs: msg.timeoutMs,
    });
  };
}
