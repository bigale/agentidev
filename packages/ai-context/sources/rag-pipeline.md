---
description: RLM-inspired RAG pipeline, token budget management, recursive query decomposition
globs: ["extension/lib/llm*", "extension/lib/embeddings*", "extension/lib/vectordb*"]
alwaysApply: false
---

# RAG Pipeline

## Recursive Language Models (RLM) Integration

Incorporating concepts from the Recursive Language Models paper (arxiv.org/abs/2512.24601) to enable hierarchical query decomposition over large browsing histories.

Complex queries that span multiple time periods, topics, or require multi-hop reasoning cannot be answered with simple "retrieve top 5 chunks -> LLM" approach. Solution: Recursive query decomposition with token budget management.

Implementation Phases:
- **Phase 1**: LLM integration with token budget management (current)
- **Phase 1.5**: Recursive query handler with hierarchical decomposition (next)
- **Phase 2+**: Advanced aggregation strategies

## Phase 1: Basic RAG (Current)

```
Query -> Generate embedding -> Vector search -> Top 5 results
      -> Build context (token budget managed)
      -> LLM (Phi-3-mini) -> Natural language answer
```

## Phase 1.5: Recursive RAG (Next)

```
Query -> Query Classifier
         |
   [Complex query?]
         |
   Query Decomposer -> [Sub-query 1, Sub-query 2, ...]
         |
   Allocate token budget per sub-query
         |
   Execute sub-queries recursively (parallel)
         |
   Result Aggregator -> Synthesized answer with all sources
```

## Token Budget Management

Critical for Phi-3-mini's 4K context window.

Always:
- Create TokenBudgetManager at start of each LLM query
- Track token usage for: query, context, answer generation
- Reserve tokens for final answer (500 tokens minimum)
- Check budget before adding more context chunks

Token Budget Allocation:
```javascript
// Phase 1: Simple queries
const tokenBudget = new TokenBudgetManager(4096); // Total budget
tokenBudget.recordUsage(estimatedQueryTokens);
const maxChunks = tokenBudget.getMaxChunks(500); // 500 tokens per chunk

// Phase 1.5: Recursive queries
const budgetPerSub = tokenBudget.allocateForSubQueries(numSubQueries, depth);
// Exponential decay: deeper queries get less budget (0.6^depth penalty)
```

Budget Exhaustion:
- If budget < 500 tokens: Fall back to simple query or return cached results
- Never exceed 4K token limit - Phi-3-mini will fail
- Log budget usage for debugging: `[TokenBudget] Used X/Y tokens`

Token Estimation:
- Simple heuristic: 1 token ~ 4 characters
- Use `estimateTokens(text)` function from llm.js
- Conservative estimates better than optimistic (add 10% buffer)

## Query Classification

- Temporal: /last (week|month|year)/, /evolution/, /timeline/
- Multi-topic: /compare/, /both/, /and/
- Multi-hop: /related to/, /documentation for/, /error.*yesterday/
- Simple: Everything else (no decomposition)

## Decomposition Rules

- Max depth: 3 (prevent runaway recursion)
- Parallel execution: Use `Promise.all()` for sub-queries
- Token allocation: Exponential decay by depth (0.6^depth)
- Base case: depth >= maxDepth OR budget < 500 tokens

## Aggregation Strategies

- Temporal: Build timeline narrative showing progression
- Multi-topic: Compare and contrast findings
- Multi-hop: Follow reasoning chain sequentially
- Always deduplicate sources by URL

## Common Pitfalls

- DON'T create circular decomposition (query -> sub-query -> same query)
- DON'T allocate equal budget to all sub-queries (use decay)
- DON'T aggregate without considering query type
- DON'T lose source references during aggregation
- DO track metadata (depth, sub-queries, token usage)
- DO show sub-queries to user for transparency
- DO fall back gracefully on errors

## Offscreen Architecture for ML

Service workers CANNOT use transformers.js directly (no WASM support). Always use offscreen document + Web Worker pattern for ML inference:
- `lib/embeddings-worker.js` (Web Worker) — all-MiniLM-L6-v2, 384-dim vectors
- `lib/embeddings.js` (bridge to offscreen document)
- Future: `lib/llm-worker.js` + `lib/llm.js` for Phi-3-mini

Check `isInitialized()` before using neural embeddings. Fall back to TF-IDF if embeddings fail. Neural threshold: 0.3, TF-IDF threshold: 0.1.
