/**
 * Boot CheerpX with the public Debian mini image and run a simple command.
 *
 * The disk image is pulled from GitHub release assets via HTTP range requests.
 * HttpBytesDevice only fetches the blocks actually read, so we don't download
 * the full 600MB up front — just the blocks touched by the boot path + echo.
 *
 * First run: slow (30-60s) as inode tables + binaries get fetched.
 * Subsequent runs: faster — IndexedDB overlay caches written blocks.
 */

(function () {
  'use strict';
  var logLine = window._spikeLog;
  if (!logLine) return;

  // Served by packages/bridge/asset-server.mjs from ~/.agentidev/cheerpx-assets/
  // with CORS headers enabled. GitHub release URLs don't send
  // Access-Control-Allow-Origin so CheerpX's `mode: "cors"` fetch blocks on them.
  var IMAGE_URL = 'http://localhost:9877/debian_mini.ext2';
  var IDB_OVERLAY_NAME = 'agentidev-phase1-spike-overlay';

  async function main() {
    try {
      logLine('info', '--- Booting CheerpX ---');
      logLine('info', 'Image: ' + IMAGE_URL);
      var t0 = performance.now();

      logLine('info', 'Creating HttpBytesDevice...');
      var blockDevice = await CheerpX.HttpBytesDevice.create(IMAGE_URL);
      logLine('ok', 'HttpBytesDevice ready (' + (performance.now() - t0).toFixed(0) + 'ms)');

      logLine('info', 'Creating IDBDevice overlay: ' + IDB_OVERLAY_NAME);
      var idbDevice = await CheerpX.IDBDevice.create(IDB_OVERLAY_NAME);
      logLine('ok', 'IDBDevice ready');

      logLine('info', 'Creating OverlayDevice...');
      var overlayDevice = await CheerpX.OverlayDevice.create(blockDevice, idbDevice);
      logLine('ok', 'OverlayDevice ready');

      logLine('info', 'Creating CheerpX.Linux (this may take 10-60s on first boot)...');
      var mountT0 = performance.now();
      var cx = await CheerpX.Linux.create({
        mounts: [
          { type: 'ext2', path: '/', dev: overlayDevice },
          { type: 'devs', path: '/dev' },
          { type: 'devpts', path: '/dev/pts' },
          { type: 'proc', path: '/proc' },
        ],
      });
      logLine('ok', 'Linux VM ready (' + (performance.now() - mountT0).toFixed(0) + 'ms)');
      window._cx = cx;  // expose for interactive probing

      // Create a console element for stdout capture
      var consoleEl = document.createElement('pre');
      consoleEl.id = 'cheerpx-console';
      consoleEl.style.cssText = 'background:#000;color:#0f0;padding:12px;margin:8px 0;font-size:11px;white-space:pre-wrap;border:1px solid #0f0;min-height:60px;';
      document.getElementById('log').appendChild(consoleEl);
      cx.setConsole(consoleEl);

      // Step 1: simplest sanity check — /bin/echo
      logLine('info', '--- Running /bin/echo hello-from-cheerpx ---');
      var runT0 = performance.now();
      await cx.run('/bin/echo', ['hello-from-cheerpx']);
      logLine('ok', '/bin/echo finished in ' + (performance.now() - runT0).toFixed(0) + 'ms');
      logLine('info', 'Console element text: ' + JSON.stringify(consoleEl.textContent));

      // Step 2: the real target — python3 -c "print(1+1)"
      logLine('info', '--- Running python3 -c "print(1+1)" ---');
      var pyT0 = performance.now();
      await cx.run('/usr/bin/python3', ['-c', 'print(1+1)']);
      logLine('ok', 'python3 finished in ' + (performance.now() - pyT0).toFixed(0) + 'ms');
      logLine('info', 'Console element text: ' + JSON.stringify(consoleEl.textContent));

      logLine('ok', '--- Phase 1 spike complete ---');
      logLine('ok', 'Total elapsed: ' + ((performance.now() - t0) / 1000).toFixed(1) + 's');
    } catch (err) {
      logLine('err', 'Boot error: ' + (err && err.stack || err));
    }
  }

  // Expose for manual trigger; also auto-run after a brief delay to let
  // env checks render first
  window._spikeBoot = main;
  setTimeout(main, 100);
})();
