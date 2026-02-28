/**
 * Snapshot intelligence message handlers.
 * Extracted from background.js lines 400-420, 1537-1708.
 */
import { generateEmbedding, isInitialized } from '../embeddings.js';
import { chunkYAMLSnapshot, extractRaceMetadata, normalizeStructure } from '../yaml-snapshot-chunker.js';
import { yamlSnapshotStore } from '../yaml-snapshot-store.js';
import { generateSimpleEmbedding, simpleHash } from './capture-handlers.js';

/**
 * Chunk, embed, and store a YAML snapshot
 */
export async function handleSnapshotStorage(sessionId, yamlText, url) {
  console.log(`[Snapshot] Storing snapshot (${yamlText.split('\n').length} lines) for ${url}`);

  const metadata = extractRaceMetadata(yamlText);
  const chunks = chunkYAMLSnapshot(yamlText, { url, sessionId, ...metadata });
  console.log(`[Snapshot] Created ${chunks.length} chunks`);

  const urlPattern = url ? url.replace(/\/\d+/g, '/*').replace(/\?.*$/, '') : '';
  let stored = 0;
  let skipped = 0;

  for (const chunk of chunks) {
    try {
      const normalized = normalizeStructure(chunk.yamlText);
      const contentHash = simpleHash(normalized);

      const existing = await yamlSnapshotStore.findByHash(urlPattern, chunk.sectionType, contentHash);
      if (existing) {
        await yamlSnapshotStore.updateTimestamp(existing.id);
        skipped++;
        continue;
      }

      let embedding;
      if (isInitialized()) {
        embedding = await generateEmbedding(chunk.textDescription);
      } else {
        embedding = generateSimpleEmbedding(chunk.textDescription);
      }

      await yamlSnapshotStore.storeSnapshot({
        url,
        urlPattern,
        track: metadata.track || null,
        race: metadata.race || null,
        sectionType: chunk.sectionType,
        yamlText: chunk.yamlText,
        textDescription: chunk.textDescription,
        embedding,
        contentHash,
        metadata: {
          ...chunk.metadata,
          sessionId,
          snapshotSize: yamlText.length,
        },
      });
      stored++;
    } catch (err) {
      console.warn(`[Snapshot] Failed to store chunk ${chunk.sectionType}:`, err.message);
    }
  }

  // Check for stable patterns
  if (url) {
    try {
      await detectStablePatterns(url);
    } catch (err) {
      console.warn('[Snapshot] Stable pattern detection failed:', err.message);
    }
  }

  console.log(`[Snapshot] Stored ${stored} new, skipped ${skipped} unchanged (${chunks.length} total chunks)`);
  return { chunksStored: stored, totalChunks: chunks.length, metadata };
}

/**
 * Search snapshot store by natural language query
 */
export async function handleSnapshotSearch(query, options = {}) {
  console.log(`[Snapshot Search] "${query}"`);

  let queryEmbedding;
  if (isInitialized()) {
    queryEmbedding = await generateEmbedding(query);
  } else {
    queryEmbedding = generateSimpleEmbedding(query);
  }

  const results = await yamlSnapshotStore.search(queryEmbedding, {
    limit: options.limit || 5,
    sectionType: options.sectionType || null,
    stableOnly: options.stableOnly || false,
    threshold: options.threshold || (isInitialized() ? 0.3 : 0.05),
  });

  console.log(`[Snapshot Search] Found ${results.length} results`);
  return results;
}

/**
 * Detect stable patterns for a URL
 */
async function detectStablePatterns(url) {
  const urlPattern = url.replace(/\/\d+/g, '/*').replace(/\?.*$/, '');
  const existing = await yamlSnapshotStore.getByUrlPattern(urlPattern);

  const bySection = {};
  for (const record of existing) {
    if (!bySection[record.sectionType]) bySection[record.sectionType] = [];
    bySection[record.sectionType].push(record);
  }

  for (const [sectionType, records] of Object.entries(bySection)) {
    if (records.length >= 3 && !records.some(r => r.isStablePattern)) {
      const latest = records.sort((a, b) => b.timestamp - a.timestamp)[0];
      await yamlSnapshotStore.markAsStablePattern(latest.id);
      console.log(`[Snapshot] Marked ${sectionType} as stable pattern for ${urlPattern}`);
    }
  }
}

export function register(handlers) {
  handlers['SNAPSHOT_STORE'] = async (msg) => {
    const result = await handleSnapshotStorage(msg.sessionId, msg.yaml, msg.url);
    return { success: true, ...result };
  };

  handlers['SNAPSHOT_SEARCH'] = async (msg) => {
    const results = await handleSnapshotSearch(msg.query, msg.options);
    return { success: true, results };
  };

  handlers['SNAPSHOT_GET_CACHED'] = async (msg) => {
    const result = await yamlSnapshotStore.getCachedStructure(msg.url, msg.sectionType);
    return { success: true, ...result };
  };
}
