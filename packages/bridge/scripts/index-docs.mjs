#!/usr/bin/env node
/**
 * Index agentidev documentation into the vector DB for agent RAG.
 *
 * Reads all markdown files from docs/guide/, chunks them by section,
 * and indexes each chunk as a 'reference' source page in LanceDB.
 * The agent's transformContext then auto-injects relevant doc chunks
 * when the user asks questions.
 *
 * Usage: node packages/bridge/scripts/index-docs.mjs
 *   Requires: bridge server running (npm run bridge)
 */

import { ScriptClient } from '../script-client.mjs';
import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = resolve(__dirname, '../../../docs/guide');

const client = new ScriptClient('index-docs', { totalSteps: 3 });

function chunkMarkdown(content, title, file) {
  // Split by ## headers into sections
  const sections = [];
  const lines = content.split('\n');
  let currentSection = title;
  let currentContent = [];

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,3})\s+(.*)/);
    if (headerMatch && currentContent.length > 0) {
      const text = currentContent.join('\n').trim();
      if (text.length > 50) { // Skip tiny sections
        sections.push({
          title: currentSection,
          content: text,
          file,
        });
      }
      currentSection = headerMatch[2];
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }
  // Last section
  const text = currentContent.join('\n').trim();
  if (text.length > 50) {
    sections.push({ title: currentSection, content: text, file });
  }
  return sections;
}

try {
  await client.connect();
  console.log('Indexing agentidev documentation\n');

  // Step 1: Read all doc files
  await client.progress(1, 3, 'Reading docs');
  const files = readdirSync(DOCS_DIR).filter(f => f.endsWith('.md'));
  console.log(`Found ${files.length} doc files: ${files.join(', ')}`);

  // Step 2: Chunk and index
  await client.progress(2, 3, 'Indexing chunks');
  let totalChunks = 0;
  let indexed = 0;

  for (const file of files) {
    const content = readFileSync(resolve(DOCS_DIR, file), 'utf-8');
    const title = content.match(/^#\s+(.*)/m)?.[1] || file.replace('.md', '');
    const chunks = chunkMarkdown(content, title, file);
    totalChunks += chunks.length;

    for (const chunk of chunks) {
      try {
        await client.indexContent({
          url: `agentidev://docs/guide/${file}#${chunk.title.replace(/\s+/g, '-').toLowerCase()}`,
          title: `${title} — ${chunk.title}`,
          text: chunk.content.substring(0, 2000), // Cap at 2000 chars for embedding
          source: 'reference',
        });
        indexed++;
        process.stdout.write(`\r  Indexed ${indexed}/${totalChunks} chunks`);
      } catch (e) {
        console.warn(`\n  Failed to index "${chunk.title}": ${e.message}`);
      }
    }
    console.log(`\n  ${file}: ${chunks.length} sections`);
  }

  // Step 3: Summary
  await client.progress(3, 3, 'Complete');
  console.log(`\nDone: ${indexed}/${totalChunks} chunks indexed as source='reference'`);
  console.log('The agent will now include relevant docs in its context via transformContext.');

  await client.complete({ indexed, totalChunks, files: files.length });
  process.exit(0);
} catch (err) {
  console.error('Fatal:', err.message);
  process.exit(1);
}
