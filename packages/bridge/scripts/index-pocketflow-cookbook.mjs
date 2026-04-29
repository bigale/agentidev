#!/usr/bin/env node
/**
 * PocketFlow Cookbook Indexer
 *
 * Walks ~/repos/PocketFlow/cookbook/pocketflow-* directories, concatenates
 * each example's README + flow.py + nodes.py, sends through the bridge for
 * neural embedding (all-MiniLM-L6-v2, 384-dim), stores in the bridge-side
 * LanceDB with source: 'reference' so pi-mono can semantic-search examples
 * when authoring flows.
 *
 * Usage:
 *   node packages/bridge/scripts/index-pocketflow-cookbook.mjs                # index all
 *   node packages/bridge/scripts/index-pocketflow-cookbook.mjs --dry-run      # parse only
 *   node packages/bridge/scripts/index-pocketflow-cookbook.mjs --limit=5      # first 5
 *   node packages/bridge/scripts/index-pocketflow-cookbook.mjs --cookbook=PATH # custom path
 */

import { ScriptClient } from '../script-client.mjs';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT_ARG = args.find((a) => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : null;
const COOKBOOK_ARG = args.find((a) => a.startsWith('--cookbook='));
const COOKBOOK_DIR = COOKBOOK_ARG
  ? COOKBOOK_ARG.split('=').slice(1).join('=')
  : join(homedir(), 'repos', 'PocketFlow', 'cookbook');

if (!existsSync(COOKBOOK_DIR)) {
  console.error(`Cookbook dir not found: ${COOKBOOK_DIR}`);
  console.error('Use --cookbook=PATH or clone PocketFlow into ~/repos/PocketFlow.');
  process.exit(1);
}

// ---- Discover cookbook examples ----

function discoverExamples() {
  const entries = readdirSync(COOKBOOK_DIR);
  const examples = [];
  for (const entry of entries) {
    if (!entry.startsWith('pocketflow-')) continue;
    const dir = join(COOKBOOK_DIR, entry);
    if (!statSync(dir).isDirectory()) continue;
    const category = entry.replace(/^pocketflow-/, '');
    examples.push({ name: entry, dir, category });
  }
  return examples;
}

function readIfExists(path) {
  try { return readFileSync(path, 'utf-8'); } catch { return null; }
}

function buildDocument(example) {
  const readme = readIfExists(join(example.dir, 'README.md'));
  const flow = readIfExists(join(example.dir, 'flow.py'));
  const nodes = readIfExists(join(example.dir, 'nodes.py'));
  const main = readIfExists(join(example.dir, 'main.py'));

  // Compose searchable text. README first (description) then code.
  const sections = [];
  if (readme) sections.push(`# ${example.name}\n\n${readme}`);
  if (flow) sections.push(`## flow.py\n\n\`\`\`python\n${flow}\n\`\`\``);
  if (nodes) sections.push(`## nodes.py\n\n\`\`\`python\n${nodes}\n\`\`\``);
  if (main && !flow) sections.push(`## main.py\n\n\`\`\`python\n${main}\n\`\`\``);

  if (sections.length === 0) return null; // empty / partial example

  const text = sections.join('\n\n');

  // Extract pocketflow class usages as keywords for the search index.
  const keywords = new Set([example.category]);
  const pfClasses = ['Node', 'BatchNode', 'Flow', 'BatchFlow', 'AsyncNode',
                     'AsyncBatchNode', 'AsyncParallelBatchNode', 'AsyncFlow',
                     'AsyncBatchFlow', 'AsyncParallelBatchFlow'];
  const blob = (flow || '') + (nodes || '') + (main || '');
  for (const cls of pfClasses) {
    if (new RegExp(`\\b${cls}\\b`).test(blob)) keywords.add(cls);
  }

  return {
    url: `pocketflow-cookbook://${example.name}`,
    title: example.name,
    text,
    contentType: 'text/markdown',
    source: 'reference',
    keywords: [...keywords],
    metadata: {
      framework: 'pocketflow',
      example: example.name,
      category: example.category,
      hasFlow: !!flow,
      hasNodes: !!nodes,
      hasReadme: !!readme,
    },
  };
}

// ---- Main ----

async function main() {
  const examples = discoverExamples();
  console.log(`Discovered ${examples.length} cookbook examples in ${COOKBOOK_DIR}`);

  const documents = [];
  for (const ex of examples) {
    const doc = buildDocument(ex);
    if (doc) documents.push(doc);
    else console.warn(`  skipping (no README/flow/nodes): ${ex.name}`);
  }
  console.log(`Built ${documents.length} indexable documents.`);

  // Top categories
  const byCategory = {};
  for (const d of documents) byCategory[d.metadata.category] = (byCategory[d.metadata.category] || 0) + 1;
  console.log('Categories:');
  for (const [cat, n] of Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${cat}: ${n}`);
  }

  const slice = LIMIT ? documents.slice(0, LIMIT) : documents;

  if (DRY_RUN) {
    console.log(`\nDRY RUN — would index ${slice.length} documents.`);
    for (const doc of slice.slice(0, 3)) {
      console.log(`\n--- ${doc.title} ---`);
      console.log(`  category:  ${doc.metadata.category}`);
      console.log(`  keywords:  ${doc.keywords.join(', ')}`);
      console.log(`  text:      ${doc.text.length} chars`);
      console.log(`  has flow:  ${doc.metadata.hasFlow}, nodes: ${doc.metadata.hasNodes}`);
    }
    return;
  }

  console.log('\nConnecting to bridge...');
  const client = new ScriptClient('index-pocketflow-cookbook', {
    totalSteps: slice.length,
    metadata: { type: 'indexer', target: 'pocketflow-cookbook' },
  });
  await client.connect();
  console.log('Connected. Indexing...\n');

  let indexed = 0;
  let errors = 0;
  const start = Date.now();
  for (let i = 0; i < slice.length; i++) {
    const doc = slice[i];
    try {
      const result = await client.indexContent(doc);
      if (result.success) {
        indexed++;
      } else {
        console.error(`  FAIL: ${doc.title} — ${result.error || 'unknown'}`);
        errors++;
      }
    } catch (err) {
      console.error(`  ERROR: ${doc.title} — ${err.message}`);
      errors++;
    }
    await client.progress(i + 1, slice.length, `Indexed: ${doc.title}`);
    if ((i + 1) % 10 === 0) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`  [${i + 1}/${slice.length}] ${elapsed}s elapsed`);
    }
  }

  const totalTime = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone. Indexed: ${indexed}, Errors: ${errors}, Time: ${totalTime}s`);
  await client.complete({ indexed, errors, totalTime: parseFloat(totalTime) });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
