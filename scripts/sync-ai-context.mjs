#!/usr/bin/env node
/**
 * Sync AI context from docs/ai-context/ to tool-native formats.
 *
 * Generates:
 *   AGENTS.md                              — universal (concatenated, no frontmatter)
 *   .claude/rules/*.md                     — Claude Code format
 *   .cursor/rules/*.mdc                    — Cursor format
 *   .github/copilot-instructions.md        — Copilot global (always-apply content)
 *   .github/instructions/*.instructions.md — Copilot path-scoped
 *
 * Usage:
 *   node scripts/sync-ai-context.mjs          # generate all
 *   node scripts/sync-ai-context.mjs --check  # exit 1 if stale
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SOURCE_DIR = join(ROOT, 'docs', 'ai-context');
const HEADER = '<!-- Generated from docs/ai-context/. Do not edit directly. -->\n\n';
const CHECK_MODE = process.argv.includes('--check');

// ---------------------------------------------------------------------------
// Parse YAML frontmatter (simple: handles description, globs, alwaysApply)
// ---------------------------------------------------------------------------
function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };

  const meta = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'globs') {
      // Handle both ["a","b"] and bare a,b
      const trimmed = val.trim();
      if (!trimmed || trimmed === '[]') {
        meta.globs = [];
      } else if (trimmed.startsWith('[')) {
        meta.globs = JSON.parse(trimmed);
      } else {
        meta.globs = trimmed.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
      }
    } else if (key === 'alwaysApply') {
      meta.alwaysApply = val.trim() === 'true';
    } else {
      meta[key] = val.trim();
    }
  }
  return { meta, body: match[2] };
}

// ---------------------------------------------------------------------------
// Read all source files
// ---------------------------------------------------------------------------
function readSources() {
  const files = readdirSync(SOURCE_DIR)
    .filter(f => f.endsWith('.md'))
    .sort();
  return files.map(f => {
    const raw = readFileSync(join(SOURCE_DIR, f), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    return { name: basename(f, '.md'), meta, body, raw };
  });
}

// ---------------------------------------------------------------------------
// Generate AGENTS.md (universal, concatenated)
// ---------------------------------------------------------------------------
function generateAgents(sources) {
  let out = HEADER;
  out += '# Contextual Recall — AI Context\n\n';
  for (const s of sources) {
    out += s.body.trimEnd() + '\n\n';
  }
  return out.trimEnd() + '\n';
}

// ---------------------------------------------------------------------------
// Generate .claude/rules/*.md
// ---------------------------------------------------------------------------
function generateClaudeRules(sources) {
  const files = {};
  for (const s of sources) {
    let fm = '---\n';
    if (s.meta.description) fm += `description: ${s.meta.description}\n`;
    if (s.meta.globs && s.meta.globs.length > 0) {
      fm += `paths: ${JSON.stringify(s.meta.globs)}\n`;
    }
    if (s.meta.alwaysApply) fm += `alwaysApply: true\n`;
    fm += '---\n\n';
    files[`.claude/rules/${s.name}.md`] = HEADER + fm + s.body.trimEnd() + '\n';
  }
  return files;
}

// ---------------------------------------------------------------------------
// Generate .cursor/rules/*.mdc
// ---------------------------------------------------------------------------
function generateCursorRules(sources) {
  const files = {};
  for (const s of sources) {
    let fm = '---\n';
    if (s.meta.description) fm += `description: ${s.meta.description}\n`;
    if (s.meta.globs && s.meta.globs.length > 0) {
      fm += `globs: ${s.meta.globs.join(', ')}\n`;
    } else {
      fm += `globs:\n`;
    }
    fm += `alwaysApply: ${s.meta.alwaysApply ? 'true' : 'false'}\n`;
    fm += '---\n\n';
    files[`.cursor/rules/${s.name}.mdc`] = HEADER + fm + s.body.trimEnd() + '\n';
  }
  return files;
}

// ---------------------------------------------------------------------------
// Generate .github/copilot-instructions.md + .github/instructions/*.instructions.md
// ---------------------------------------------------------------------------
function generateCopilotRules(sources) {
  const files = {};

  // Global: concatenate always-apply sources
  const alwaysApply = sources.filter(s => s.meta.alwaysApply);
  let global = HEADER;
  for (const s of alwaysApply) {
    global += s.body.trimEnd() + '\n\n';
  }
  files['.github/copilot-instructions.md'] = global.trimEnd() + '\n';

  // Path-scoped: sources with globs (not always-apply-only)
  for (const s of sources) {
    if (!s.meta.globs || s.meta.globs.length === 0) continue;
    let fm = '---\n';
    fm += `applyTo: ${JSON.stringify(s.meta.globs)}\n`;
    fm += '---\n\n';
    files[`.github/instructions/${s.name}.instructions.md`] = HEADER + fm + s.body.trimEnd() + '\n';
  }
  return files;
}

// ---------------------------------------------------------------------------
// Write or check files
// ---------------------------------------------------------------------------
function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function writeOrCheck(relPath, content) {
  const absPath = join(ROOT, relPath);
  if (CHECK_MODE) {
    if (!existsSync(absPath)) {
      console.error(`MISSING: ${relPath}`);
      return false;
    }
    const existing = readFileSync(absPath, 'utf8');
    if (existing !== content) {
      console.error(`STALE: ${relPath}`);
      return false;
    }
    return true;
  }
  ensureDir(absPath);
  writeFileSync(absPath, content, 'utf8');
  console.log(`  wrote ${relPath}`);
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const sources = readSources();
let allFresh = true;

console.log(CHECK_MODE ? 'Checking ai-context sync...' : 'Syncing ai-context...');

// AGENTS.md
allFresh = writeOrCheck('AGENTS.md', generateAgents(sources)) && allFresh;

// Claude rules
for (const [path, content] of Object.entries(generateClaudeRules(sources))) {
  allFresh = writeOrCheck(path, content) && allFresh;
}

// Cursor rules
for (const [path, content] of Object.entries(generateCursorRules(sources))) {
  allFresh = writeOrCheck(path, content) && allFresh;
}

// Copilot rules
for (const [path, content] of Object.entries(generateCopilotRules(sources))) {
  allFresh = writeOrCheck(path, content) && allFresh;
}

if (CHECK_MODE) {
  if (allFresh) {
    console.log('All files are up to date.');
    process.exit(0);
  } else {
    console.error('Run `npm run ai:sync` to regenerate.');
    process.exit(1);
  }
} else {
  console.log('Done.');
}
