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

  // Idempotency guard — executeScript can fire twice if the SW restarts.
  if (window.__agentidevCheerpXBridgeInstalled) return;
  window.__agentidevCheerpXBridgeInstalled = true;

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
})();
