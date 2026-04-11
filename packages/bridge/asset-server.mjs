#!/usr/bin/env node
/**
 * Static HTTP asset server for the agentidev bridge.
 *
 * Serves files from ~/.agentidev/cheerpx-assets/ on http://localhost:9877/
 * with CORS headers enabled, so chrome extension pages (including the
 * CheerpX sandbox iframe) can fetch large binary assets like ext2 disk
 * images without hitting CORS blocks.
 *
 * Range requests are supported (required by CheerpX HttpBytesDevice).
 *
 * Usage:
 *   node packages/bridge/asset-server.mjs           # foreground on 9877
 *   node packages/bridge/asset-server.mjs --port=9878 --root=/custom/dir
 *
 * This is a standalone script for the Phase 1 CheerpX spike. Later phases
 * will fold this into server.mjs as a proper asset-serving subsystem.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const portArg = args.find(a => a.startsWith('--port='));
const rootArg = args.find(a => a.startsWith('--root='));

const PORT = portArg ? parseInt(portArg.split('=')[1], 10) : 9877;
const ROOT = rootArg ? rootArg.split('=')[1] : path.join(os.homedir(), '.agentidev', 'cheerpx-assets');

if (!fs.existsSync(ROOT)) {
  console.error(`Error: asset root does not exist: ${ROOT}`);
  console.error('Create it and place assets there, e.g.:');
  console.error(`  mkdir -p ${ROOT}`);
  console.error(`  cp some-image.ext2 ${ROOT}/`);
  process.exit(1);
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  'Access-Control-Max-Age': '86400',
};

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ext2' || ext === '.wasm' || ext === '.data') return 'application/octet-stream';
  if (ext === '.js' || ext === '.mjs') return 'application/javascript';
  if (ext === '.json') return 'application/json';
  if (ext === '.html') return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

// Cross-origin isolation headers — required by CheerpX (which needs
// SharedArrayBuffer + COI semantics for its workers).
//
// HTML pages get COOP+COEP so the document is itself cross-origin isolated.
// Non-HTML resources get CORP: cross-origin so they can be loaded by a COEP
// document (otherwise the iframe would refuse to fetch JS, wasm, or the
// disk image).
// Only the cheerpx-runtime.html page needs COOP/COEP. CheerpJ runs fine
// without COI (it doesn't need SharedArrayBuffer), and slapping COOP/COEP
// on the cheerpj-runtime.html breaks something inside CheerpJ's worker
// dispatch — first-run cheerpjRunMain hangs indefinitely.
function coiHeadersFor(ext, relPath) {
  if (ext === '.html' && relPath === 'cheerpx-runtime.html') {
    return {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };
  }
  return { 'Cross-Origin-Resource-Policy': 'cross-origin' };
}

const server = http.createServer((req, res) => {
  // OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Allow': 'GET, HEAD, OPTIONS', ...CORS_HEADERS });
    res.end('Method not allowed');
    return;
  }

  // Strip query string and leading slash
  let relPath = decodeURIComponent(req.url.split('?')[0].replace(/^\/+/, ''));
  // Block path traversal
  if (relPath.includes('..')) {
    res.writeHead(400, CORS_HEADERS);
    res.end('Invalid path');
    return;
  }

  const absPath = path.join(ROOT, relPath);
  // Verify it's still inside ROOT after normalization
  if (!absPath.startsWith(ROOT)) {
    res.writeHead(400, CORS_HEADERS);
    res.end('Invalid path');
    return;
  }

  fs.stat(absPath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, CORS_HEADERS);
      res.end('Not found');
      return;
    }

    const size = stat.size;
    const ext = path.extname(absPath).toLowerCase();
    const ctype = contentType(absPath);
    // CheerpX HttpBytesDevice requires Last-Modified or ETag so it can
    // validate that the file didn't change between range requests.
    const lastModified = stat.mtime.toUTCString();
    const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    // .jar files: send no-cache for the dev profile so JAR updates are
    // picked up without requiring ?v=<ts> cache busting from callers.
    const cacheControl = ext === '.jar' ? 'no-cache' : 'public, max-age=3600';
    const baseHeaders = {
      'Content-Type': ctype,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl,
      'Last-Modified': lastModified,
      'ETag': etag,
      ...CORS_HEADERS,
      ...coiHeadersFor(ext, relPath),
    };

    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      if (!match) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, ...baseHeaders });
        res.end();
        return;
      }
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : size - 1;
      if (start >= size || end >= size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, ...baseHeaders });
        res.end();
        return;
      }
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': chunkSize,
      });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(absPath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...baseHeaders, 'Content-Length': size });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(absPath).pipe(res);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[asset-server] Listening on http://localhost:${PORT}/`);
  console.log(`[asset-server] Root: ${ROOT}`);
  const files = fs.readdirSync(ROOT).filter(f => fs.statSync(path.join(ROOT, f)).isFile());
  if (files.length) {
    console.log(`[asset-server] Serving ${files.length} file(s):`);
    for (const f of files) {
      const sz = fs.statSync(path.join(ROOT, f)).size;
      console.log(`  http://localhost:${PORT}/${f}  (${(sz / 1024 / 1024).toFixed(1)} MB)`);
    }
  } else {
    console.log('[asset-server] No files in root (add some and they will be served automatically)');
  }
});
