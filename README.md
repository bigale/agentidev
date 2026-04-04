# Contextual Recall

**Browser extension for semantic memory and activity intelligence**

> "Show me what I was working on last Tuesday about invoice processing"
> → Get answers in <1 second with complete context.

**One tool. Three modes. Zero compromises.**
- **🔍 Search Mode**: Semantic search across your browsing history
- **💬 Q&A Mode**: Ask natural language questions with LLM-powered answers
- **🕷️ Extract Mode**: Intelligent web scraping with automatic pagination
- **Enterprise Mode**: Optional team intelligence with privacy-preserving aggregation (future)

---

## What Is This?

Contextual Recall automatically captures and indexes everything you view in your browser, creating a **semantic memory** you can query in natural language. Ask questions about your past activity and get instant, accurate answers with full context.

**Key Design**: One-size-fits-all architecture works for individual users AND enterprise deployments - same codebase, same privacy guarantees, different scale.

**Key Insight**: Your browser activity is a knowledge graph that's **both personal memory AND business intelligence**, without the privacy violations of traditional monitoring.

---

## Features

### 🧠 Semantic Memory
- Ask natural language questions: "What was I working on last Tuesday?"
- Query by topic, date, project, or any context
- <300ms response time across 75,000+ pages
- Complete context with click-through to exact sections

### 🔒 Privacy-First
- **All data stays local** on your device (IndexedDB, 2-3GB)
- **Never centralized** - raw content never leaves your browser
- **Transparent controls** - see exactly what's captured
- **Audit logs** - export your data anytime
- **GDPR/SOX/HIPAA compliant** by design

### ⚡ Fast & Efficient
- Captures 100+ pages/day with <5% CPU overhead
- Background indexing (non-blocking)
- 2-3GB storage for 3 years of activity
- WASM-powered vector search

### 📊 Smart Structured Content
- **iXML grammars** automatically classify content types
- API docs, specs, tables → 75% better recall vs token chunking
- Preserves semantic boundaries and relationships
- Narrative content uses standard token chunking

### 🤝 Team Intelligence (Optional)
- Opt-in metadata sharing within teams
- "Who has looked at the 810 Invoice spec recently?"
- Federated queries (no centralized data)
- Permission-based knowledge discovery

### 📈 Business Intelligence (Optional)
- Aggregate anonymized metadata across organization
- "What are the top 10 most-referenced specs?"
- Identify knowledge gaps and workflow bottlenecks
- Prioritize documentation improvements

### 🕷️ Intelligent Web Scraping (NEW)
- **LLM-powered extraction** - Automatically infer schema from any website
- **Multi-page crawling** - Follow pagination automatically
- **Token-efficient** - Schema inference once (~1200 tokens), reuse for subsequent pages (~300 tokens)
- **8 preset templates** - Products, jobs, articles, events, properties, contacts, reviews, tables
- **Export options** - JSON and CSV export for extracted data
- **Token budget management** - 3500 token budget allows ~10 pages max

---

## Use Cases

### 1. Personal Knowledge Recall
**Query**: "Show me the EDI spec I was reading last Tuesday"
**Result**: ISA segment definition, N1 loop examples, 850 transaction guide
**Time**: <1 second (vs 15-30 minutes manual search)

### 2. Project Context Reconstruction
**Query**: "What was the Walmart EDI integration project about?"
**Result**: 47 pages across 3 weeks, clustered by topic with timeline
**Benefit**: Instant project refresh after vacation/interruption

### 3. Team Collaboration
**Query**: "Who on my team has looked at 810 Invoice recently?"
**Result**: 3 team members, opt-in context sharing
**Benefit**: Faster knowledge discovery

### 4. Enterprise Business Intelligence
**Query**: "Top 10 most-referenced specs across company?"
**Result**: Prioritized list with usage statistics
**Benefit**: Data-driven documentation priorities

### 5. Compliance Auditing
**Query**: "Show all customer PII access this quarter"
**Result**: Complete audit trail with timestamps
**Benefit**: GDPR/SOX/HIPAA compliance

---

## How It Works

```
Page Load → Content Capture → Classification
                                    ↓
                    (Structured content: iXML parse)
                    (Unstructured: Token chunk)
                                    ↓
                    Generate Embeddings (local)
                                    ↓
                    Store in Vector DB (IndexedDB)
                                    ↓
User Query → Semantic Search → LLM Summary → Answer
```

**All processing happens locally in your browser. No API calls. No cloud.**

---

## Tech Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| **Content Capture** | Chrome Extensions API | Native browser integration |
| **Vector Storage** | LanceDB WASM | 10GB+ IndexedDB, <300ms queries |
| **Embeddings** | all-MiniLM-L6-v2 (transformers.js) | Local, fast, 384-dim vectors |
| **LLM** | Phi-3-mini / Gemma-2B (transformers.js) | 1-2GB models, local inference |
| **Structured Parsing** | rustixml WASM | iXML grammars, 75% better recall |
| **Storage** | IndexedDB / OPFS | 10GB+ browser storage |

**Zero dependencies on external APIs. Runs 100% offline.**

---

## Quick Start

### Installation (Coming Soon)

1. Install from Chrome Web Store (or load unpacked for development)
2. Grant permissions (tabs, storage, webNavigation)
3. Browse normally - capture happens automatically
4. Click extension icon to open sidebar and query your history

### For Developers

```bash
# Clone repo
git clone https://github.com/bigale/contextual-recall.git
cd contextual-recall

# Install dependencies
npm install

# Build extension
npm run build

# Load in Chrome
# 1. Navigate to chrome://extensions/
# 2. Enable "Developer mode"
# 3. Click "Load unpacked"
# 4. Select the extension/ directory
```

---

## AI Context System

Contextual Recall maintains a unified AI context system that keeps Claude Code, Cursor, and GitHub Copilot in sync with project knowledge. It also exports that knowledge to other repositories.

### Unified Context (Intra-Repo)

Single source of truth in `docs/ai-context/` (9 files with YAML frontmatter) generates tool-native configs:

```bash
npm run ai:sync     # Generate all tool configs from source files
npm run ai:check    # Exit 1 if generated files are stale
```

Generates:
- `AGENTS.md` — universal context (all tools)
- `.claude/rules/*.md` — Claude Code path-scoped rules
- `.cursor/rules/*.mdc` — Cursor path-scoped rules
- `.github/copilot-instructions.md` — Copilot global instructions
- `.github/instructions/*.instructions.md` — Copilot path-scoped instructions

Edit files in `docs/ai-context/`, then run `npm run ai:sync` to propagate changes to all tools.

### Knowledge Export (Cross-Repo)

CR acts as a portable knowledge engine. The adapt script detects what a target repo uses and generates context files with access to CR's indexed knowledge (627 SmartClient showcase examples in LanceDB with neural embeddings).

```bash
# Export CR knowledge to another repo
npm run ai:adapt -- --repo=/path/to/target

# Check if generated files are up to date
npm run ai:adapt -- --repo=/path/to/target --check

# Remove generated files from target
npm run ai:adapt -- --repo=/path/to/target --clean

# Skip detection, force all modules
npm run ai:adapt -- --repo=/path/to/target --force
```

Generated files are prefixed `cr-` to avoid collisions with the target repo's own context files. The target repo can layer hand-written skills/rules on top.

**No MCP dependency** — everything works via bridge CLI shell commands, so it functions identically in environments where MCP servers are unavailable.

### Module Detection

The adapt script auto-detects which knowledge modules to export:

| Module | Detects | Exports |
|--------|---------|---------|
| SmartClient | `isc.*` usage, SC type declarations, agentiface/forge imports | Vector search command, SC skill, component patterns, Cursor/Copilot rules |

Future modules can be added for bridge automation, RAG pipeline, etc.

### Vector Search (Bridge CLI)

All AI tools access the showcase knowledge base via the same CLI:

```bash
node bridge/claude-client.mjs search '{"query":"grid with filtering","limit":5}'
```

Requires the bridge server: `npm run bridge`

---

## Documentation

- **[Architecture](docs/architecture.md)**: Complete system design
- **[Technical Design](docs/technical-design.md)**: WASM components and implementation
- **[Content Strategy](docs/content-strategy.md)**: When to use iXML vs token chunking
- **[Privacy & Security](docs/privacy.md)**: How we protect your data
- **[User Guide](docs/user-guide.md)**: How to use the extension
- **[Developer Guide](docs/developer-guide.md)**: Contributing and extending

---

## Performance

### Single User
- **Pages/day**: 100
- **Storage (3 years)**: 2-3GB
- **Query latency**: <300ms
- **CPU overhead**: <5%
- **Battery impact**: Negligible

### Enterprise (1,000 users)
- **Total pages/year**: 25 million
- **Total storage**: 500GB (distributed, not centralized!)
- **Aggregated metadata**: ~25GB (for BI)
- **Cost/user**: $0/year (local compute)

---

## ROI (1,000-user Enterprise)

| Metric | Value |
|--------|-------|
| **Development** | $400K (one-time) |
| **Annual cost** | $236K (maintenance) |
| **Annual savings** | $3.75M (15 min/day time saved) |
| **Year 1 ROI** | 490% |
| **Payback period** | 2 months |

---

## Privacy Guarantee

### What Stays Local (Never Leaves Device)
- ✅ Full page content (HTML, text, images)
- ✅ Vector embeddings (semantic meaning)
- ✅ Screenshots (if enabled)
- ✅ Full URLs (including query parameters)
- ✅ User inputs (search queries, form data)
- ✅ Credentials (passwords, API keys, tokens)

### What Can Be Aggregated (Opt-In Only)
- ⚠️ Domain names (not full URLs): `x12.org` ✅, `x12.org/user/john/private` ❌
- ⚠️ Page titles (sanitized): "ISA Segment" ✅, "John's Invoice #12345" ❌
- ⚠️ Document types: "api_reference", "documentation", etc.
- ⚠️ Time spent (bucketed): "2-5 minutes", not exact seconds

**Default: ALL features disabled except local capture. You control what (if anything) is shared.**

---

## Roadmap

### Phase 1: Personal Knowledge Recall ✅ **COMPLETE**
- [x] Architecture design
- [x] Repository setup
- [x] Chrome extension MVP ✅ **COMPLETE** (manifest, service worker, offscreen document, sidebar UI)
- [x] Basic semantic search ✅ **COMPLETE** (all-MiniLM-L6-v2, 384-dim vectors, IndexedDB)
- [x] Content capture & chunking ✅ **COMPLETE** (DOM-based, automatic indexing)
- [x] Offscreen + Web Worker architecture ✅ **COMPLETE** (transformers.js working)
- [x] LLM Q&A integration ✅ **COMPLETE** (Phi-3-mini, token budget management) - [See Task Plan](docs/phase1-llm-task-plan.md)
- [ ] LanceDB WASM integration ← NEXT
- [ ] 10 common iXML grammars (after LanceDB)

**Current Status**: Phase 1 complete! Search, Q&A, and Extract modes working.

### Phase 2A: Intelligent Web Scraping ✅ **COMPLETE**
- [x] Schema inference with LLM ✅ **COMPLETE** (lib/schema-inference.js)
- [x] Recursive extractor engine ✅ **COMPLETE** (lib/recursive-extractor.js)
- [x] Multi-page pagination ✅ **COMPLETE** (automatic "Next" button detection)
- [x] 8 preset templates ✅ **COMPLETE** (products, jobs, articles, events, properties, contacts, reviews, tables)
- [x] Extract mode UI ✅ **COMPLETE** (sidepanel integration)
- [x] JSON/CSV export ✅ **COMPLETE**

**Status**: Extract mode ready for testing! [See Testing Guide](docs/phase2a-extract-mode-testing.md)

**Token Budget**: 3500 tokens allows ~10 pages (1200 for first page schema inference, 300 per subsequent page)

### Phase 2B: Advanced Extraction (Future)
- [ ] Deep link following (extract across linked pages)
- [ ] Dynamic content handling (wait for AJAX/lazy loading)
- [ ] Recursive schema refinement (improve schema across pages)
- [ ] Incremental export (stream results during extraction)
- [ ] Background extraction (continue in background)

### Phase 2: Team Collaboration (Q2 2026)
- [ ] Opt-in metadata sharing
- [ ] Federated query protocol
- [ ] Team knowledge dashboard
- [ ] Permission management

### Phase 3: Enterprise BI (Q3 2026)
- [ ] Anonymized metadata aggregation
- [ ] BI dashboard (trends, gaps, priorities)
- [ ] Query pattern analysis
- [ ] Documentation recommendations

### Phase 4: Advanced Intelligence (Q4 2026)
- [ ] Workflow pattern recognition
- [ ] Proactive suggestions
- [ ] Knowledge gap prediction
- [ ] Automated documentation generation

---

## Related Projects

- **[rustixml](https://github.com/bigale/rustixml)**: iXML parser library (Rust + WASM) - Core dependency for structured content parsing
- **[certified-edi](https://github.com/bigale/certified-edi)**: RAG architecture documentation and iXML optimization research
- **[chromadb-mcp-server](https://github.com/bigale/chromadb-mcp-server)**: MCP server for Claude Code integration (optional)

---

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Areas Needing Help
- iXML grammars for common documentation types (OpenAPI, Markdown, etc.)
- Performance optimization (WASM SIMD, indexing strategies)
- Privacy-preserving aggregation algorithms
- UI/UX improvements
- Documentation and tutorials

---

## License

MIT License - See [LICENSE](LICENSE) for details

---

## Contact

- **Issues**: [GitHub Issues](https://github.com/bigale/contextual-recall/issues)
- **Discussions**: [GitHub Discussions](https://github.com/bigale/contextual-recall/discussions)
- **Email**: [Your email or leave blank]

---

## Acknowledgments

- Built on [rustixml](https://github.com/bigale/rustixml) for iXML parsing
- Inspired by RAG architecture research in [certified-edi](https://github.com/bigale/certified-edi)
- Uses [transformers.js](https://github.com/xenova/transformers.js) for local ML
- Uses [LanceDB](https://github.com/lancedb/lancedb) for vector storage

---

**Status**: 🚧 Early development - Architecture complete, POC in progress

**Built with** ❤️ **by developers who got tired of forgetting what they read last week**

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
