# Memory

Local-first semantic memory over the user's browsing. The product's "remember everything I've seen, search it semantically later" headline feature.

## Ownership

- Vector DB — `extension/lib/vectordb.js`. IndexedDB-backed `pages` store with a `source` index for partition-scoped queries.
- Embeddings pipeline — `extension/lib/embeddings.js` (bridge to offscreen) + `extension/lib/embeddings-worker.js` (Web Worker running all-MiniLM-L6-v2 via transformers.js).
- Capture — `extension/lib/handlers/capture-handlers.js` + `extension/content.js`.
- RAG pipeline — `extension/lib/llm*.js` (Phase 1 today, Phase 1.5 RLM-style decomposition planned).
- Token budget management — `TokenBudgetManager` in `llm.js`.
- Source partitioning — `browsing`, `showcase`, `reference`.
- Bulk indexers — `extension/lib/handlers/bridge-handlers.js`, `ixml-spec-indexer.js`, `index-showcase.mjs`.

## Invariants

1. Embeddings run only in the Web Worker spawned by the offscreen document. The Service Worker cannot run transformers.js (no WASM). Always check `isInitialized()` before neural embeddings; fall back to TF-IDF if init fails.
2. All Pages have a `source` partition. Records without one default to `browsing` (backward-compat, no migration).
3. Sensitive domains (banking, auth, login pages) are excluded by Capture by default.
4. Token budgets are managed per-query. Never exceed Phi-3-mini's 4K context. Always reserve ≥500 tokens for the final answer.
5. Local-first: raw page content never leaves the browser.

## Public surface

Other contexts reach Memory via `chrome.runtime.sendMessage` handlers:

- `EMBEDDINGS_*` — route automatically to the offscreen document via type-prefix check in `background.js`.
- `CAPTURE_*` — capture-handlers.
- `MEMORY_SEARCH` — vector DB semantic search; supports `sources` filter.
- `VECTORDB_STATS` — Page counts by source for dashboard display.

## Failure modes

- transformers.js init fails → fall back to TF-IDF, log it, surface in stats.
- IndexedDB unavailable → operations queue + retry, but most flows fail gracefully.
- Token budget exhaustion → fall back to simple-query mode, log `[TokenBudget]` usage.

## Future direction (not current)

- LanceDB WASM for >1GB scale with HNSW indexing
- Phase 1.5 RLM-style query decomposition with exponential-decay budget allocation
- Phi-3-mini in `lib/llm-worker.js` (the Memory analog of embeddings-worker)
