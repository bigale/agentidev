#!/usr/bin/env node
/**
 * Sync docs/guide/ to the GitHub wiki.
 *
 * Transforms markdown files from docs/guide/ into GitHub wiki format:
 *   - Renames to Title-Case (kebab-case → Title-Case)
 *   - Generates _Sidebar.md navigation
 *   - Generates Home.md landing page
 *   - Copies architecture docs from docs/
 *   - Pushes to bigale/agentidev.wiki.git
 *
 * Usage:
 *   node scripts/sync-wiki.mjs           # sync and push
 *   node scripts/sync-wiki.mjs --dry-run # show what would change, don't push
 *
 * Prerequisite: wiki repo must be initialized (create first page via GitHub web UI).
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, cpSync, rmSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const GUIDE_DIR = join(ROOT, 'docs', 'guide');
const DOCS_DIR = join(ROOT, 'docs');
const WIKI_DIR = join(ROOT, '.wiki'); // Local wiki checkout
const WIKI_REMOTE = 'git@github.com:bigale/agentidev.wiki.git';
const DRY_RUN = process.argv.includes('--dry-run');

// Guide files in display order (from index.json)
const INDEX = JSON.parse(readFileSync(join(GUIDE_DIR, 'index.json'), 'utf-8'));

// Additional architecture docs to include
const EXTRA_DOCS = [
  { source: 'docs/convergence-architecture.md', title: 'Convergence Architecture' },
  { source: 'docs/runtime-automation.md', title: 'Runtime Automation' },
];

// Map guide section to wiki page filename.
// GitHub wiki URLs use the filename (minus .md), so "Dashboard-Guide.md" → /wiki/Dashboard-Guide
function toWikiName(section) {
  // Use the title as the wiki page name (spaces → hyphens)
  return section.title.replace(/\s+/g, '-');
}

function toWikiNameFromFile(filename) {
  // Fallback for extra docs: title-case the kebab-case filename
  return filename
    .replace('.md', '')
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('-');
}

// Transform internal links: [text](file.md) → [[Display|Page-Name]]
function transformLinks(content, fileMap) {
  return content.replace(/\[([^\]]+)\]\(([^)]+\.md)\)/g, (match, text, href) => {
    const base = basename(href, '.md');
    const wikiName = fileMap[base];
    if (wikiName) return `[[${text}|${wikiName}]]`;
    return match;
  });
}

// ---- Main ----

console.log('Syncing docs/guide/ to GitHub wiki\n');

// Step 1: Clone or update wiki repo
if (!existsSync(WIKI_DIR)) {
  console.log('Cloning wiki repo...');
  try {
    execSync(`git clone ${WIKI_REMOTE} ${WIKI_DIR}`, { stdio: 'pipe' });
  } catch (err) {
    console.error('Failed to clone wiki repo. Have you created the first page via the GitHub web UI?');
    console.error('Go to: https://github.com/bigale/agentidev/wiki/_new');
    process.exit(1);
  }
} else {
  console.log('Updating wiki repo...');
  execSync('git pull --rebase', { cwd: WIKI_DIR, stdio: 'pipe' });
}

// Step 2: Build file map (guide filename base → wiki page name)
const fileMap = {};
for (const section of INDEX.sections) {
  const base = section.file.replace('.md', '');
  fileMap[base] = toWikiName(section);
}
for (const extra of EXTRA_DOCS) {
  const base = basename(extra.source, '.md');
  fileMap[base] = toWikiNameFromFile(basename(extra.source));
}

console.log('File map:', Object.entries(fileMap).map(([k, v]) => `${k} → ${v}`).join(', '));

// Step 3: Copy and transform guide docs
const pages = [];
for (const section of INDEX.sections) {
  const sourcePath = join(GUIDE_DIR, section.file);
  const wikiName = toWikiName(section);
  const destPath = join(WIKI_DIR, wikiName + '.md');

  let content = readFileSync(sourcePath, 'utf-8');
  content = transformLinks(content, fileMap);

  if (DRY_RUN) {
    console.log(`  [dry-run] ${section.file} → ${wikiName}.md (${content.length} bytes)`);
  } else {
    writeFileSync(destPath, content, 'utf-8');
    console.log(`  ${section.file} → ${wikiName}.md`);
  }
  pages.push({ title: section.title, wikiName });
}

// Step 4: Copy extra architecture docs
for (const extra of EXTRA_DOCS) {
  const sourcePath = join(ROOT, extra.source);
  if (!existsSync(sourcePath)) { console.log(`  SKIP: ${extra.source} not found`); continue; }
  const wikiName = toWikiNameFromFile(basename(extra.source));
  const destPath = join(WIKI_DIR, wikiName + '.md');

  let content = readFileSync(sourcePath, 'utf-8');
  content = transformLinks(content, fileMap);

  if (DRY_RUN) {
    console.log(`  [dry-run] ${extra.source} → ${wikiName}.md`);
  } else {
    writeFileSync(destPath, content, 'utf-8');
    console.log(`  ${extra.source} → ${wikiName}.md`);
  }
  pages.push({ title: extra.title, wikiName });
}

// Step 5: Generate Home.md
const homeContent = `# Agentidev Documentation

AI-powered browser automation, semantic memory, and agentic UI generation platform.

## Guides

${INDEX.sections.map(s => `- [[${s.title}|${toWikiName(s)}]]`).join('\n')}

## Architecture

${EXTRA_DOCS.map(d => `- [[${d.title}|${toWikiNameFromFile(basename(d.source))}]]`).join('\n')}

---

Source: [docs/guide/](https://github.com/bigale/agentidev/tree/master/docs/guide) | Synced via \`node scripts/sync-wiki.mjs\`
`;

if (DRY_RUN) {
  console.log('  [dry-run] Home.md');
} else {
  writeFileSync(join(WIKI_DIR, 'Home.md'), homeContent, 'utf-8');
  console.log('  Home.md (landing page)');
}

// Step 6: Generate _Sidebar.md
const sidebarContent = `**Agentidev**

**Guides**
${INDEX.sections.map(s => `- [[${s.title}|${toWikiName(s)}]]`).join('\n')}

**Architecture**
${EXTRA_DOCS.map(d => `- [[${d.title}|${toWikiNameFromFile(basename(d.source))}]]`).join('\n')}

---
[Main Repo](https://github.com/bigale/agentidev)
`;

if (DRY_RUN) {
  console.log('  [dry-run] _Sidebar.md');
} else {
  writeFileSync(join(WIKI_DIR, '_Sidebar.md'), sidebarContent, 'utf-8');
  console.log('  _Sidebar.md (navigation)');
}

// Step 7: Commit and push
if (DRY_RUN) {
  console.log('\n[dry-run] Would commit and push', pages.length + 2, 'files');
  process.exit(0);
}

console.log('\nCommitting...');
execSync('git add -A', { cwd: WIKI_DIR });

// Check if there are changes
const status = execSync('git status --porcelain', { cwd: WIKI_DIR, encoding: 'utf-8' }).trim();
if (!status) {
  console.log('No changes to push.');
  process.exit(0);
}

const fileCount = status.split('\n').length;
execSync(`git commit -m "Sync ${fileCount} pages from docs/guide/"`, { cwd: WIKI_DIR, stdio: 'pipe' });
console.log('Pushing to wiki...');
execSync('git push', { cwd: WIKI_DIR, stdio: 'pipe' });
console.log(`\nDone: ${fileCount} files pushed to https://github.com/bigale/agentidev/wiki`);
