/**
 * CheerpX content-script bridge — injected into the cheerpx-runtime tab.
 *
 * The cheerpx-runtime.html page lives at http://localhost:9877 (top-level
 * browsing context) so it can claim cross-origin isolation from
 * asset-server's COOP/COEP headers. We can't host it inside an extension
 * iframe because the chain of extension parents has no COEP, blocking COI.
 *
 * This content script bridges the SW and the page:
 *   1. Listens for `chrome.runtime.onMessage` CHEERPX_INVOKE from the SW
 *   2. Forwards to the page via `window.postMessage` with envelope
 *      { source: 'agentidev-cheerpx', type, ...payload, id }
 *   3. Listens for the page's response via `window.postMessage`
 *      { source: 'agentidev-cheerpx-response', id, response }
 *   4. Replies to the SW via `sendResponse`
 *
 * One bridge instance per tab; the SW tracks the tabId and uses
 * `chrome.tabs.sendMessage(tabId, ...)` so we don't broadcast across all
 * tabs.
 *
 * Injected programmatically via `chrome.scripting.executeScript` from the
 * service worker, NOT declared in manifest.json — so it only loads in the
 * single tab the SW opened, never in user-visible tabs.
 */

(function () {
  'use strict';

  // On extension reload, the previous content script's listeners are GC'd
  // (they belonged to the old extension context) but the page persists with
  // __agentidevCheerpXBridgeInstalled still set. So we MUST re-install every
  // time — checking a window flag would skip installation and leave no
  // working bridge. Duplicate listeners are harmless: each request/response
  // is matched by unique id/streamId, so a duplicate listener just drops
  // the message it can't match.
  console.log('[cheerpx-bridge] installing on', location.href);

  var _reqCounter = 0;
  var _pending = Object.create(null); // pageReqId -> sendResponse callback

  // Wait for the page to signal it's ready (it sends agentidev-cheerpx-ready
  // from cheerpx-runtime.html on script load).
  var pageReadyPromise = new Promise(function (resolve) {
    var resolved = false;
    function check(event) {
      if (event.data && event.data.source === 'agentidev-cheerpx-ready') {
        if (!resolved) { resolved = true; resolve(); }
      }
    }
    window.addEventListener('message', check);
    // Race: page may have signaled before content script loaded. Probe via
    // a ping after a short delay.
    setTimeout(function () {
      if (!resolved) { resolved = true; resolve(); }
    }, 500);
  });

  // Listen for responses from the page
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.source !== 'agentidev-cheerpx-response') return;
    var entry = _pending[msg.id];
    if (!entry) return;
    delete _pending[msg.id];
    entry(msg.response);
  });

  // Listen for SW → tab messages
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'CHEERPX_INVOKE') return;

    pageReadyPromise.then(function () {
      var pageReqId = 'cxp-' + (++_reqCounter);
      _pending[pageReqId] = sendResponse;
      var envelope = Object.assign({
        source: 'agentidev-cheerpx',
        id: pageReqId,
        type: msg.command,
      }, msg.payload || {});
      window.postMessage(envelope, location.origin);
    });

    return true; // async response
  });

  // Tell the SW we're ready to receive CHEERPX_INVOKE
  pageReadyPromise.then(function () {
    try {
      chrome.runtime.sendMessage({ type: 'CHEERPX_TAB_READY' }, function () {
        if (chrome.runtime.lastError) {
          console.warn('[cheerpx-bridge] ready signal error:', chrome.runtime.lastError.message);
        } else {
          console.log('[cheerpx-bridge] ready signal acknowledged');
        }
      });
    } catch (e) {
      console.warn('[cheerpx-bridge] failed to signal ready:', e.message);
    }
  });

  // ---- Streaming via long-lived chrome.runtime.Port ----
  //
  // The SW opens a port via chrome.tabs.connect(tabId, {name:'cheerpx-stream'})
  // when it wants to start a streaming spawn. Each port carries one stream:
  //   SW → port: { type: 'spawn-stream', streamId, cmd, args, opts }
  //   page → port: { type: 'stdout', streamId, chunk }
  //                { type: 'exit', streamId, exitCode }
  //                { type: 'error', streamId, error }
  //
  // The runtime page emits stream events as window.postMessage with
  // source 'agentidev-cheerpx-stream'; we filter by streamId so multiple
  // concurrent streams (theoretically — CheerpX serializes today) don't
  // mix.
  var _activeStreams = Object.create(null); // streamId -> port

  // Listen for stream events from the runtime page and route them to the
  // matching port. One global listener handles all in-flight streams.
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.source !== 'agentidev-cheerpx-stream') return;
    var port = _activeStreams[msg.streamId];
    if (!port) return;
    try {
      port.postMessage({
        type: msg.type,
        streamId: msg.streamId,
        chunk: msg.chunk,
        exitCode: msg.exitCode,
        elapsedMs: msg.elapsedMs,
        error: msg.error,
      });
      if (msg.type === 'exit' || msg.type === 'error') {
        delete _activeStreams[msg.streamId];
      }
    } catch (e) {
      // Port may have been disconnected; clean up
      delete _activeStreams[msg.streamId];
    }
  });

  chrome.runtime.onConnect.addListener(function (port) {
    if (port.name !== 'cheerpx-stream') return;
    console.log('[cheerpx-bridge] stream port opened');

    port.onMessage.addListener(function (msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'spawn-stream') {
        var streamId = msg.streamId;
        if (!streamId) {
          port.postMessage({ type: 'error', error: 'spawn-stream requires streamId' });
          return;
        }
        // Register port for stream events
        _activeStreams[streamId] = port;
        // Forward to runtime page
        window.postMessage({
          source: 'agentidev-cheerpx',
          id: 'stream-' + streamId,
          type: 'spawn-stream',
          streamId: streamId,
          cmd: msg.cmd,
          args: msg.args || [],
          opts: msg.opts || {},
        }, location.origin);
      } else if (msg.type === 'kill') {
        // CheerpX 1.0.7's cx.run has no kill API. Best effort: drop the
        // port mapping so further chunks are ignored. The actual command
        // continues until it exits naturally. Phase 4.7 territory.
        if (msg.streamId) delete _activeStreams[msg.streamId];
      }
    });

    port.onDisconnect.addListener(function () {
      // Garbage-collect any streams owned by this port
      for (var sid in _activeStreams) {
        if (_activeStreams[sid] === port) delete _activeStreams[sid];
      }
    });
  });
})();
