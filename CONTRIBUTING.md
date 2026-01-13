# Contributing to Contextual Recall

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## Code of Conduct

Be respectful, inclusive, and constructive. We're building a tool to help people work better - let's create a welcoming community.

## How to Contribute

### Reporting Bugs

1. Check if the issue already exists in [Issues](https://github.com/bigale/contextual-recall/issues)
2. If not, create a new issue with:
   - Clear description of the problem
   - Steps to reproduce
   - Expected vs actual behavior
   - Browser version and OS
   - Extension version

### Suggesting Features

1. Check [Discussions](https://github.com/bigale/contextual-recall/discussions) for similar ideas
2. Create a new discussion explaining:
   - The use case
   - How it would work
   - Why it's valuable
   - Any privacy/security considerations

### Contributing Code

1. **Fork the repository**
2. **Create a branch**: `git checkout -b feature/your-feature-name`
3. **Make your changes**
4. **Test thoroughly** (manual testing for now, automated tests coming)
5. **Commit with clear messages**: Follow [Conventional Commits](https://www.conventionalcommits.org/)
6. **Push to your fork**
7. **Create a Pull Request**

### Code Style

- Use 2 spaces for indentation
- Use semicolons
- Use single quotes for strings
- Run `npm run format` before committing
- Run `npm run lint` to check for issues

### Commit Messages

Follow Conventional Commits format:

```
feat: Add LanceDB WASM integration
fix: Resolve memory leak in content script
docs: Update architecture documentation
refactor: Simplify query processing logic
test: Add unit tests for classifier
```

## Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/contextual-recall.git
cd contextual-recall

# Install dependencies
npm install

# Build the extension
npm run dev

# Load in Chrome
# 1. Go to chrome://extensions/
# 2. Enable "Developer mode"
# 3. Click "Load unpacked"
# 4. Select the extension/ directory
```

## Project Structure

```
contextual-recall/
├── extension/          # Chrome extension code
│   ├── background.js   # Service worker
│   ├── content.js      # Content script
│   ├── popup/          # Popup UI
│   └── lib/            # Libraries (WASM, ML models)
├── grammars/           # iXML grammars
├── docs/               # Documentation
└── tests/              # Tests
```

## Areas Needing Help

### High Priority
- [ ] LanceDB WASM integration
- [ ] transformers.js setup (embeddings + LLM)
- [ ] iXML grammar library (10+ common doc types)
- [ ] Content classifier implementation
- [ ] Smart chunking logic

### Medium Priority
- [ ] UI/UX improvements
- [ ] Performance optimization
- [ ] Privacy controls
- [ ] Documentation and tutorials
- [ ] Test suite

### Future
- [ ] Team collaboration features
- [ ] Enterprise BI dashboard
- [ ] Workflow pattern recognition
- [ ] Proactive suggestions

## Privacy Guidelines

**Critical**: All PRs must maintain privacy-first principles:

- ✅ Raw content NEVER leaves device
- ✅ Aggregation is opt-in only
- ✅ User controls are transparent
- ✅ No tracking, no analytics without consent
- ✅ Audit logs for all data access

Any PR that violates these principles will be rejected.

## Testing

Currently manual testing:
1. Load extension in Chrome
2. Browse various websites (specs, docs, dashboards)
3. Test capture (check console logs)
4. Test queries (search from popup)
5. Verify storage (check IndexedDB in DevTools)

Automated tests coming in Phase 1.

## Documentation

When adding features:
- Update README.md if user-facing
- Update docs/architecture.md if architectural
- Add code comments for complex logic
- Create examples for new APIs

## Questions?

- **General questions**: [GitHub Discussions](https://github.com/bigale/contextual-recall/discussions)
- **Bug reports**: [GitHub Issues](https://github.com/bigale/contextual-recall/issues)
- **Security issues**: Email [your email] (don't open public issue)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

**Thank you for contributing to Contextual Recall!** 🧠✨
