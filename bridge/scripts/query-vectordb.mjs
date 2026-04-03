/**
 * query-vectordb.mjs — One-shot vector search against bridge LanceDB and/or extension IndexedDB.
 *
 * Usage:
 *   node bridge/scripts/query-vectordb.mjs "your query"
 *   node bridge/scripts/query-vectordb.mjs "shuttle" --source=showcase
 *   node bridge/scripts/query-vectordb.mjs "react hooks" --source=browsing,reference
 *   node bridge/scripts/query-vectordb.mjs "..." --wait-for-neural   # wait for model before querying
 *   node bridge/scripts/query-vectordb.mjs "..." --topK=20
 */

import { ScriptClient } from '../script-client.mjs';
import { MSG } from '../protocol.mjs';

const args = process.argv.slice(2);
const sourceArg      = args.find(a => a.startsWith('--source='));
const topKArg        = args.find(a => a.startsWith('--topK='));
const WAIT_NEURAL    = args.includes('--wait-for-neural');
const sources        = sourceArg ? sourceArg.split('=')[1].split(',') : null;
const topK           = topKArg   ? parseInt(topKArg.split('=')[1], 10) : 10;
const query          = args.filter(a => !a.startsWith('--')).join(' ') || 'grid saved search builtin';

const client = new ScriptClient('query-vectordb', { totalSteps: 1 });

console.log(`\nSearching vector DB for: "${query}"${sources ? ` [sources: ${sources.join(',')}]` : ''}\n`);

try {
  await client.connect();

  // Optionally wait for neural embedding model to be ready on the bridge server
  if (WAIT_NEURAL) {
    process.stdout.write('Waiting for neural embedding model on bridge server...');
    for (let i = 0; i < 60; i++) {
      const stats = await client._sendRequest(MSG.BRIDGE_VECTORDB_STATS, {}, 5000).catch(() => ({}));
      if (stats.embeddingReady) { process.stdout.write(' ready!\n\n'); break; }
      if (i === 59)             { process.stdout.write(' timed out — using TF-IDF fallback\n\n'); break; }
      process.stdout.write('.');
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  const payload = {
    query,
    topK,
    threshold: 0.2,
    queryKeywords: query.toLowerCase().split(/\s+/).filter(w => w.length > 3),
  };
  if (sources) payload.sources = sources;

  // Timeout: 120s to allow neural model to finish loading on first bridge query
  const result = await client._sendRequest(MSG.BRIDGE_SEARCH_VECTORDB, payload, 120000);

  if (result.error) {
    console.error('Search error:', result.error);
  } else {
    const results = result.results || result.data || [];
    console.log(`Found ${results.length} result(s):\n`);
    results.forEach((r, i) => {
      console.log(`[${i + 1}] ${r.title || r.url}`);
      console.log(`    URL:   ${r.url}`);
      console.log(`    Score: ${(r.score ?? r.similarity ?? 0).toFixed(4)}`);
      if (r.source) console.log(`    Source: ${r.source}`);
      if (r.text)   console.log(`    Text:  ${r.text.slice(0, 200).replace(/\n/g, ' ')}...`);
      console.log();
    });
  }

  await client.complete({});
} catch (err) {
  console.error('Error:', err.message);
} finally {
  client.disconnect();
}
