#!/usr/bin/env node
/**
 * Bundle pi-ai + pi-agent-core + TypeBox into a single browser-compatible
 * ESM file for use in Chrome extension pages. This resolves bare module
 * specifiers that Chrome extensions can't handle (no import map support).
 *
 * Output: extension/lib/vendor/pi-bundle.js
 *
 * Run: node scripts/bundle-pi.mjs
 */

import { build } from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Bundle entry point — import SPECIFIC files, not the top-level index
// (which pulls in ALL provider registrations including Google/Anthropic SDKs).
const entryContent = `
// Re-export only what we need from specific pi-ai internals
export { Type } from '@sinclair/typebox';

// Agent core
export { Agent } from '@mariozechner/pi-agent-core';

// pi-ai: model registry + streaming
export { getModel, streamSimple, getProviders } from '@mariozechner/pi-ai';
`;

// Plugin to stub out unused provider files and Node.js modules.
// pi-ai lazy-loads providers via dynamic import(), so the unused ones
// are only referenced but never executed. We replace entire provider
// files (not just their SDK deps) with empty modules to avoid pulling
// in Anthropic/Google/AWS/Mistral SDKs.
const stubPlugin = {
  name: 'stub-unused',
  setup(build) {
    // Stub entire provider files we won't use.
    // Match resolved absolute paths containing these provider filenames.
    const unusedProviders = [
      'anthropic', 'amazon-bedrock', 'azure-openai-responses',
      'google.js', 'google-vertex', 'google-shared', 'google-gemini-cli',
      'mistral', 'openai-codex', 'openai-responses',
    ];
    // Match any file under pi-ai/dist/providers/ that we don't need
    build.onLoad({ filter: /pi-ai\/dist\/providers\/(anthropic|amazon-bedrock|azure-openai-responses|google|google-vertex|google-shared|google-gemini-cli|mistral|openai-codex|openai-responses)\.(js|ts)$/ }, () => ({
      contents: 'export function stream() {} export function streamSimple() {} export default {};',
      loader: 'js',
    }));

    // Stub Node.js built-ins
    const nodeStubs = ['fs', 'node:readline', 'node:fs', 'node:path', 'node:url', 'undici'];
    const nodeFilter = new RegExp('^(' + nodeStubs.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$');
    build.onResolve({ filter: nodeFilter }, args => ({
      path: args.path,
      namespace: 'stub-node',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub-node' }, () => ({
      contents: 'export default {};',
      loader: 'js',
    }));

    // Stub AJV (validation skipped in MV3 via chrome.runtime.id check)
    build.onResolve({ filter: /^ajv(-formats)?$/ }, args => ({
      path: args.path,
      namespace: 'stub-node',
    }));
  },
};

await build({
  stdin: {
    contents: entryContent,
    resolveDir: ROOT,
    loader: 'js',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome113',
  outfile: resolve(ROOT, 'extension/lib/vendor/pi-bundle.js'),
  plugins: [stubPlugin],
  minify: false,
  sourcemap: false,
  treeShaking: true,
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.versions': '{}',
    'process.env': '{}',
    'process.platform': '"browser"',
  },
});

// Check output size
import { statSync } from 'fs';
const stats = statSync(resolve(ROOT, 'extension/lib/vendor/pi-bundle.js'));
console.log(`Bundle created: extension/lib/vendor/pi-bundle.js (${(stats.size / 1024).toFixed(0)} KB)`);
