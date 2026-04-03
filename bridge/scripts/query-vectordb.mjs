/**
 * query-vectordb.mjs — One-shot vector search via bridge relay to extension.
 * Usage: node bridge/scripts/query-vectordb.mjs "your query text"
 */

import { ScriptClient } from '../script-client.mjs';
import { MSG } from '../protocol.mjs';

const args = process.argv.slice(2);
const sourceArg = args.find(a => a.startsWith('--source='));
const sources = sourceArg ? sourceArg.split('=')[1].split(',') : null;
const query = args.filter(a => !a.startsWith('--')).join(' ') || 'grid saved search builtin';

const client = new ScriptClient('query-vectordb', { totalSteps: 1 });

console.log(`\nSearching vector DB for: "${query}"${sources ? ` [sources: ${sources.join(',')}]` : ''}\n`);

try {
  await client.connect();

  // BRIDGE_SEARCH_VECTORDB relays to extension → vector search → results
  const payload = {
    query,
    topK: 5,
    threshold: 0.2,
    queryKeywords: query.toLowerCase().split(/\s+/).filter(w => w.length > 3),
  };
  if (sources) payload.sources = sources;

  const result = await client._sendRequest(MSG.BRIDGE_SEARCH_VECTORDB, payload, 30000);

  if (result.error) {
    console.error('Search error:', result.error);
  } else {
    const results = result.results || result.data || [];
    console.log(`Found ${results.length} result(s):\n`);
    results.forEach((r, i) => {
      console.log(`[${i + 1}] ${r.title || r.url}`);
      console.log(`    URL:   ${r.url}`);
      console.log(`    Score: ${(r.score ?? r.similarity ?? 0).toFixed(4)}`);
      if (r.text) console.log(`    Text:  ${r.text.slice(0, 200).replace(/\n/g, ' ')}...`);
      console.log();
    });
  }

  await client.complete({});
} catch (err) {
  console.error('Error:', err.message);
} finally {
  client.disconnect();
}
