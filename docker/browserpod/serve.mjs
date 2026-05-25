#!/usr/bin/env node
/**
 * Simple static server for the BrowserPod proxy page.
 * Serves with Cross-Origin Isolation headers (required for SharedArrayBuffer/WebAssembly).
 *
 * Usage: node docker/browserpod/serve.mjs [--port=8080]
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || '8080');

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  // Cross-Origin Isolation headers (required for SharedArrayBuffer / WebAssembly threads)
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.join(__dirname, urlPath);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`BrowserPod proxy page: http://localhost:${PORT}`);
  console.log(`Open in browser to boot the pod and expose Petstore via Portal URL`);
  console.log('');
  console.log('Prerequisites:');
  console.log('  - Zato running: docker compose up -d (in docker/zato/)');
  console.log('  - BrowserPod API key (get from https://console.browserpod.io)');
});
