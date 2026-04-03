# CLAUDE.md

Modular rules in `.claude/rules/` (auto-loaded per path). Shared context source in `docs/ai-context/`.

Run `npm run ai:sync` after editing any file in `docs/ai-context/` to regenerate tool-native configs.

## Claude-Specific

- Always run tests in background: `npm test &`
- Mermaid diagrams: no quotation marks, black font on non-black boxes
- Auto-memory: `~/.claude/projects/.../memory/` (personal, not synced)
