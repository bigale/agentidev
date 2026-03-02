/**
 * Shared utility: auto-upsert playwright-shim import line.
 * Replaces `from 'playwright'` / `require('playwright')` with the shim path.
 * Used by script-handlers.js (forward sync) and bridge-handlers.js (reverse sync).
 */

export function upsertShimImport(source, shimPath) {
  if (!shimPath) return source;
  const esmPattern = /^(import\s+\{[^}]+\}\s+from\s+)(['"])playwright\2/m;
  const cjsPattern = /^((const|let|var)\s+\{[^}]+\}\s*=\s*require\s*\(\s*)(['"])playwright\3/m;
  if (esmPattern.test(source)) {
    return source.replace(esmPattern, `$1$2${shimPath}$2`);
  }
  if (cjsPattern.test(source)) {
    return source.replace(cjsPattern, `$1$3${shimPath}$3`);
  }
  return source;
}
