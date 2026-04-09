/**
 * bridge/vectordb.mjs — LanceDB vector store for the bridge server
 *
 * Stores curated reference data (showcase, docs, specs) with HNSW indexing.
 * Private browsing captures stay in the extension's IndexedDB.
 *
 * Storage: ~/.agentidev/vectors/
 */

import * as lancedb from '@lancedb/lancedb';
import { embed, embedSimple, isEmbeddingReady, initEmbeddings, EMBEDDING_DIM } from './embeddings.mjs';
import { homedir } from 'os';
import { join } from 'path';
import { mkdir } from 'fs/promises';

const DB_PATH = join(homedir(), '.agentidev', 'vectors');
const TABLE_NAME = 'pages';

// Build an ANN index once the table grows past this size.
// For datasets < this size, LanceDB brute-force scan is fast (< 5ms) and exact.
// Raising this high avoids stale IVF-PQ centroids if data is re-indexed with a
// different embedding model (e.g. going from TF-IDF to neural).
const INDEX_THRESHOLD = 10000;

let _db = null;
let _table = null;     // null until first record or openTable succeeds
let _count = 0;        // cached row count, updated on add
let _indexBuilt = false;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export async function initVectorDB() {
  await mkdir(DB_PATH, { recursive: true });
  _db = await lancedb.connect(DB_PATH);

  const names = await _db.tableNames();
  if (names.includes(TABLE_NAME)) {
    _table = await _db.openTable(TABLE_NAME);
    _count = await _table.countRows();
    console.log(`[VectorDB] Opened table "${TABLE_NAME}" — ${_count} records`);
  } else {
    console.log('[VectorDB] Table "pages" not yet created — will create on first addPage()');
  }
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/**
 * Add or update a page in the vector store.
 * Upserts by id = `${source}::${url}`.
 */
export async function addPage({ url, title, text, source, keywords = [], metadata = {} }) {
  if (!_db) throw new Error('[VectorDB] Not initialized');

  const id = `${source}::${encodeURIComponent(url)}`;

  // Compute embedding — neural if ready, TF-IDF fallback otherwise
  const vector = isEmbeddingReady()
    ? await embed(text)
    : embedSimple(text);

  const record = {
    id,
    url,
    title: title || '',
    text: String(text).slice(0, 32768),
    vector,
    source: source || 'reference',
    keywords: JSON.stringify(keywords),
    timestamp: Date.now(),
    metadata: JSON.stringify(metadata),
  };

  if (!_table) {
    // First record — create the table; schema inferred from data
    _table = await _db.createTable(TABLE_NAME, [record]);
    _count = 1;
  } else {
    // Upsert: remove old record, then add new
    try {
      await _table.delete(`id = '${id.replace(/'/g, "''")}'`);
    } catch { /* may not exist */ }
    await _table.add([record]);
    _count++;
  }

  // Build ANN index once threshold is crossed (idempotent)
  if (!_indexBuilt && _count >= INDEX_THRESHOLD) {
    await _maybeCreateIndex();
  }

  return id;
}

// ---------------------------------------------------------------------------
// Search path
// ---------------------------------------------------------------------------

/**
 * Semantic search across bridge-stored reference data.
 *
 * @param {string} queryText - Raw query text (will be embedded)
 * @param {object} options
 * @param {number} [options.topK=10]
 * @param {number} [options.threshold=0.25]
 * @param {string[]|null} [options.sources] - Source filter, null = all bridge sources
 * @param {string[]} [options.queryKeywords] - Keyword boost list
 * @returns {Array} Ranked results with { id, url, title, text, source, score, ... }
 */
export async function search(queryText, {
  topK = 10,
  threshold = 0.1,
  sources = null,
  queryKeywords = [],
} = {}) {
  if (!_table) return [];

  // Wait for neural model — TF-IDF query vectors won't match neural-indexed data
  if (!isEmbeddingReady()) {
    console.log('[VectorDB] Waiting for embedding model before search...');
    await initEmbeddings();
  }

  const queryVec = isEmbeddingReady()
    ? await embed(queryText)
    : embedSimple(queryText); // only if init failed

  // Over-fetch so threshold pruning can pick best topK
  let q = _table
    .vectorSearch(queryVec)
    .limit(topK * 4);

  // SQL source filter
  if (sources && sources.length > 0) {
    const inList = sources.map(s => `'${s.replace(/'/g, "''")}'`).join(', ');
    q = q.where(`source IN (${inList})`);
  }

  q = q.select(['id', 'url', 'title', 'text', 'source', 'keywords', 'timestamp']);

  let rows;
  try {
    rows = await q.toArray();
  } catch (err) {
    console.error('[VectorDB] Search error:', err.message);
    return [];
  }

  // Convert L2 distance to cosine similarity (valid for normalized unit vectors)
  // ||a - b||² = 2 - 2*cos_sim  →  cos_sim = 1 - d²/2
  const results = rows
    .map(row => ({
      id:        row.id,
      url:       row.url,
      title:     row.title,
      text:      row.text,
      source:    row.source,
      keywords:  tryParseJSON(row.keywords, []),
      timestamp: Number(row.timestamp),
      score:     Math.max(0, 1 - (row._distance * row._distance) / 2),
    }))
    .filter(r => r.score >= threshold);

  // Keyword boost: bump score for results whose stored keywords overlap the query
  if (queryKeywords.length > 0) {
    const qkSet = new Set(queryKeywords.map(k => k.toLowerCase()));
    for (const r of results) {
      const kws = Array.isArray(r.keywords) ? r.keywords : [];
      const matchCount = kws.filter(k => qkSet.has(k.toLowerCase())).length;
      if (matchCount > 0) r.score = Math.min(1, r.score + 0.05 * matchCount);
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export async function getStats() {
  if (!_table) return { total: 0, bySource: {} };

  const total = await _table.countRows();
  const rows = await _table.query().select(['source']).toArray();
  const bySource = {};
  for (const row of rows) {
    const s = row.source || 'unknown';
    bySource[s] = (bySource[s] || 0) + 1;
  }
  return { total, bySource };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function _maybeCreateIndex() {
  try {
    await _table.createIndex('vector', {
      config: lancedb.Index.ivfPq({
        numPartitions: 16,
        numSubVectors: 8,
      }),
    });
    _indexBuilt = true;
    console.log('[VectorDB] IVF-PQ index built');
  } catch (err) {
    if (err.message?.includes('already exists') || err.message?.includes('already created')) {
      _indexBuilt = true;
    } else {
      console.warn('[VectorDB] Index creation skipped:', err.message);
    }
  }
}

function tryParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}
