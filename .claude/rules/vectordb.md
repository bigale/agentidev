<!-- Generated from docs/ai-context/. Do not edit directly. -->

---
description: Vector database architecture, source partitioning, search and indexing
paths: ["extension/lib/vectordb*"]
---


# Vector Database (`extension/lib/vectordb.js`)

## Overview

IndexedDB-based vector database (POC implementation). Stores page content with 384-dim embeddings from all-MiniLM-L6-v2. Provides cosine similarity search. Future: LanceDB WASM for 10GB+ storage with HNSW index.

## Source Partitioning (DB v3)

`source` index on `pages` store enables scoped queries:
- `browsing` — content captures from browser activity
- `showcase` — SmartClient SDK examples
- `reference` — specs, docs, indexed reference material

Records without `source` field default to `'browsing'` (backward compat, no migration needed).

## Key APIs

- `addPage({ url, title, content, embedding, source })` — store with source tag
- `search(queryEmbedding, { limit, sources })` — pre-filter by source index, then cosine similarity
- `getPagesBySources(sources)` — IndexedDB index lookup, avoids loading all records
- `getStats()` — returns `bySource` breakdown

## Callsite Source Tags

- `capture-handlers.js` -> `source: 'browsing'`
- `bridge-handlers.js` -> `source: 'reference'`
- `ixml-spec-indexer.js` -> `source: 'reference'`
- `index-showcase.mjs` -> `source: 'showcase'`

## Performance

- Current: O(n) cosine similarity scan over all pages in source partition
- Target: <300ms query latency
- Storage: 2-3GB for 3 years of activity (1,000-10,000 pages)
- Future LanceDB WASM: HNSW index for sub-linear search

## IndexedDB Patterns

- Always wrap operations in promises
- Use transactions for multi-step operations
- Check `dbReady` before any database access
- `keyPath: 'id'` with `autoIncrement: true` for object stores

## CLI

`bridge/query-vectordb.mjs` supports `--source=showcase` flag for partition-scoped queries.
