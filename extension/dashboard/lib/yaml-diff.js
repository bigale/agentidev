/**
 * Line-based YAML diff engine using LCS (Longest Common Subsequence).
 * O(n*m) dynamic programming — fine for 500-line snapshots.
 */

/**
 * Strip [ref=eNNN] markers so ref renumbering doesn't appear as changes.
 */
function stripRefs(text) {
  return text.replace(/\[ref=e\d+\]/g, '[ref=*]');
}

/**
 * Compute LCS table for two arrays of lines.
 */
function lcsTable(a, b) {
  const m = a.length;
  const n = b.length;
  // Use flat Uint16Array for speed; supports up to 65535 LCS length
  const dp = new Uint16Array((m + 1) * (n + 1));
  const w = n + 1;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i * w + j] = dp[(i - 1) * w + (j - 1)] + 1;
      } else {
        dp[i * w + j] = Math.max(dp[(i - 1) * w + j], dp[i * w + (j - 1)]);
      }
    }
  }
  return { dp, w, m, n };
}

/**
 * Backtrack through LCS table to produce diff result.
 * @returns {Array<{type: 'same'|'added'|'removed', text: string, lineA?: number, lineB?: number}>}
 */
function backtrack(dp, w, linesA, linesB, origA, origB) {
  const result = [];
  let i = linesA.length;
  let j = linesB.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
      result.push({ type: 'same', text: origA[i - 1], lineA: i, lineB: j });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[(i) * w + (j - 1)] >= dp[(i - 1) * w + j])) {
      result.push({ type: 'added', text: origB[j - 1], lineB: j });
      j--;
    } else {
      result.push({ type: 'removed', text: origA[i - 1], lineA: i });
      i--;
    }
  }

  return result.reverse();
}

/**
 * Compute diff between two YAML texts.
 * @param {string} yamlA - Left/original YAML
 * @param {string} yamlB - Right/new YAML
 * @param {Object} options
 * @param {boolean} options.stripRefs - Strip [ref=eNNN] before comparing (default true)
 * @returns {Array<{type: 'same'|'added'|'removed', text: string, lineA?: number, lineB?: number}>}
 */
export function computeDiff(yamlA, yamlB, { stripRefs: doStripRefs = true } = {}) {
  const origLinesA = (yamlA || '').split('\n');
  const origLinesB = (yamlB || '').split('\n');

  const compareA = doStripRefs ? origLinesA.map(stripRefs) : origLinesA;
  const compareB = doStripRefs ? origLinesB.map(stripRefs) : origLinesB;

  const { dp, w } = lcsTable(compareA, compareB);
  return backtrack(dp, w, compareA, compareB, origLinesA, origLinesB);
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render diff result as side-by-side HTML.
 * @param {Array} diffResult - Output from computeDiff
 * @returns {string} HTML for two-column diff view
 */
export function renderDiff(diffResult) {
  const leftLines = [];
  const rightLines = [];

  for (const entry of diffResult) {
    const escaped = escapeHtml(entry.text);

    if (entry.type === 'same') {
      leftLines.push(
        `<div class="dash-diff-line dash-diff-same"><span class="dash-diff-num">${entry.lineA}</span><span class="dash-diff-text">${escaped}</span></div>`
      );
      rightLines.push(
        `<div class="dash-diff-line dash-diff-same"><span class="dash-diff-num">${entry.lineB}</span><span class="dash-diff-text">${escaped}</span></div>`
      );
    } else if (entry.type === 'removed') {
      leftLines.push(
        `<div class="dash-diff-line dash-diff-removed"><span class="dash-diff-num">${entry.lineA}</span><span class="dash-diff-text">${escaped}</span></div>`
      );
      rightLines.push(
        `<div class="dash-diff-line dash-diff-empty"><span class="dash-diff-num"></span><span class="dash-diff-text"></span></div>`
      );
    } else if (entry.type === 'added') {
      leftLines.push(
        `<div class="dash-diff-line dash-diff-empty"><span class="dash-diff-num"></span><span class="dash-diff-text"></span></div>`
      );
      rightLines.push(
        `<div class="dash-diff-line dash-diff-added"><span class="dash-diff-num">${entry.lineB}</span><span class="dash-diff-text">${escaped}</span></div>`
      );
    }
  }

  return `<div class="dash-diff-container">` +
    `<div class="dash-diff-side dash-diff-left"><div class="dash-diff-header">A (original)</div>${leftLines.join('')}</div>` +
    `<div class="dash-diff-side dash-diff-right"><div class="dash-diff-header">B (new)</div>${rightLines.join('')}</div>` +
    `</div>`;
}

/**
 * Compute diff stats: counts of added, removed, same lines.
 */
export function diffStats(diffResult) {
  let added = 0, removed = 0, same = 0;
  for (const entry of diffResult) {
    if (entry.type === 'added') added++;
    else if (entry.type === 'removed') removed++;
    else same++;
  }
  return { added, removed, same, total: added + removed + same };
}
