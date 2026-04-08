/**
 * Shared utility: auto-upsert playwright-shim import line.
 * Replaces `from 'playwright'` / `require('playwright')` with the shim path.
 * Used by script-handlers.js (forward sync) and bridge-handlers.js (reverse sync).
 */

export function upsertShimImport(source, shimPath) {
  if (!shimPath) return source;

  // On Windows, Node ESM rejects bare drive-letter paths (e.g. C:\...).
  // Convert to file:/// URL so the import resolves correctly.
  let safePath = shimPath;
  if (/^[A-Za-z]:[\\/]/.test(shimPath)) {
    safePath = 'file:///' + shimPath.replace(/\\/g, '/');
  }

  // Match `from 'playwright'` OR any existing shim path (stale absolute paths from other machines)
  const esmPattern = /^(import\s+\{[^}]+\}\s+from\s+)(['"])(?:playwright|[^'"]*playwright-shim\.mjs)\2/m;
  const cjsPattern = /^((const|let|var)\s+\{[^}]+\}\s*=\s*require\s*\(\s*)(['"])(?:playwright|[^'"]*playwright-shim\.mjs)\3/m;
  if (esmPattern.test(source)) {
    return source.replace(esmPattern, `$1$2${safePath}$2`);
  }
  if (cjsPattern.test(source)) {
    return source.replace(cjsPattern, `$1$3${safePath}$3`);
  }
  return source;
}
