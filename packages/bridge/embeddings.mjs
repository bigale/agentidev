/**
 * bridge/embeddings.mjs — Node.js neural embeddings for the bridge server
 *
 * Uses Xenova/all-MiniLM-L6-v2 (same model as the extension web worker).
 * Initialized once at bridge startup; stays warm in the Node.js process.
 */

import { pipeline } from '@xenova/transformers';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIM = 384;

let _embedder = null;
let _initPromise = null;

/**
 * Initialize the embedding pipeline. Safe to call multiple times — returns
 * the same promise on repeated calls.
 */
export async function initEmbeddings() {
  if (_embedder) return true;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    console.log('[Embeddings] Loading all-MiniLM-L6-v2...');
    const t0 = Date.now();
    _embedder = await pipeline('feature-extraction', MODEL_ID, { quantized: true });
    console.log(`[Embeddings] Model ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return true;
  })().catch(err => {
    console.error('[Embeddings] Failed to load model:', err.message);
    _initPromise = null;
    return false;
  });

  return _initPromise;
}

/** Returns true once the model is loaded and ready. */
export function isEmbeddingReady() {
  return _embedder !== null;
}

/**
 * Generate a 384-dim normalized embedding for the given text.
 * Truncates to 8192 chars before embedding to keep inference fast.
 * @returns {number[]} Float32 array of length 384
 */
export async function embed(text) {
  if (!_embedder) throw new Error('[Embeddings] Model not initialized — call initEmbeddings() first');
  const truncated = String(text).slice(0, 8192);
  const output = await _embedder(truncated, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/**
 * Simple TF-IDF fallback when neural model is not ready.
 * Returns a sparse EMBEDDING_DIM-length float array.
 */
export function embedSimple(text) {
  const words = String(text).toLowerCase().split(/\W+/).filter(w => w.length > 2);
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  const vec = new Float32Array(EMBEDDING_DIM);
  for (const [w, count] of Object.entries(freq)) {
    let h = 5381;
    for (let i = 0; i < w.length; i++) h = ((h << 5) + h) ^ w.charCodeAt(i);
    const idx = Math.abs(h) % EMBEDDING_DIM;
    vec[idx] += count / words.length;
  }
  // L2 normalize
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec).map(v => v / norm);
}
