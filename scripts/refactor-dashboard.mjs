#!/usr/bin/env node
// Splits extension/smartclient-app/dashboard-app.js into per-portlet files.
// Output goes to extension/smartclient-app/dashboard-new/ — original is untouched.
// Run: node scripts/refactor-dashboard.mjs
//   --clean    wipe dashboard-new/ first
//   --verify   round-trip: concat outputs and diff against source

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(REPO_ROOT, 'extension/smartclient-app/dashboard-app.js');
const OUT_DIR = path.join(REPO_ROOT, 'extension/smartclient-app/dashboard-new');
const PORTLET_DIR = path.join(OUT_DIR, 'dashboard');

const args = new Set(process.argv.slice(2));

// ---- Manifest: function name -> output file (relative to OUT_DIR) ----
const MANIFEST = {
  // shared.js
  escapeHtmlDash: 'dashboard/shared.js',
  formatDuration: 'dashboard/shared.js',
  parseIntervalInput: 'dashboard/shared.js',
  dispatchActionAsync: 'dashboard/shared.js',
  refreshToolbar: 'dashboard/shared.js',
  setButtonDisabled: 'dashboard/shared.js',

  // toolbar.js
  getSelectedSessionId: 'dashboard/toolbar.js',
  showSessionRunMenu: 'dashboard/toolbar.js',
  launchSelectedScript: 'dashboard/toolbar.js',
  addCaptureToggle: 'dashboard/toolbar.js',

  // session-record.js
  toggleTracing: 'dashboard/session-record.js',
  toggleVideo: 'dashboard/session-record.js',
  autoStopSessionRecording: 'dashboard/session-record.js',

  // auth-capture.js
  startAuthCapture: 'dashboard/auth-capture.js',
  showAuthCaptureDialog: 'dashboard/auth-capture.js',
  saveAuthCapture: 'dashboard/auth-capture.js',
  cancelAuthCapture: 'dashboard/auth-capture.js',

  // help.js
  showHelpWindow: 'dashboard/help.js',
  _filterHelp: 'dashboard/help.js',
  _buildHelpHTML: 'dashboard/help.js',

  // sessions.js
  showNewSessionDialog: 'dashboard/sessions.js',

  // scripts.js
  wireScriptsLibraryGrid: 'dashboard/scripts.js',
  refreshScriptsLibrary: 'dashboard/scripts.js',
  selectScriptInHistoryGrid: 'dashboard/scripts.js',
  selectScriptInLibrary: 'dashboard/scripts.js',
  loadScriptIntoEditor: 'dashboard/scripts.js',
  loadVersionHistory: 'dashboard/scripts.js',
  showOpenScriptDialog: 'dashboard/scripts.js',
  fileSave: 'dashboard/scripts.js',
  fileSaveAs: 'dashboard/scripts.js',
  refreshRecipeSelect: 'dashboard/scripts.js',
  loadRecipeForScript: 'dashboard/scripts.js',
  assignRecipeToScript: 'dashboard/scripts.js',

  // monaco.js
  loadMonacoEditor: 'dashboard/monaco.js',
  initMonacoEditor: 'dashboard/monaco.js',
  updateSourceViewer: 'dashboard/monaco.js',
  openMonacoWindow: 'dashboard/monaco.js',
  findCheckpointLines: 'dashboard/monaco.js',
  handleGlyphClick: 'dashboard/monaco.js',
  updateEditorDecorations: 'dashboard/monaco.js',
  scrollToCheckpoint: 'dashboard/monaco.js',
  handleV8Paused: 'dashboard/monaco.js',
  handleV8Resumed: 'dashboard/monaco.js',
  showEvaluatePanel: 'dashboard/monaco.js',
  hideEvaluatePanel: 'dashboard/monaco.js',
  runEvaluation: 'dashboard/monaco.js',

  // schedules.js
  buildScheduleFormFields: 'dashboard/schedules.js',
  populateScriptDropdown: 'dashboard/schedules.js',
  showNewScheduleDialog: 'dashboard/schedules.js',
  showEditScheduleDialog: 'dashboard/schedules.js',

  // run-plans.js
  showNewRunPlanDialog: 'dashboard/run-plans.js',
  showEditStepArgsDialog: 'dashboard/run-plans.js',

  // recipe.js
  actionSummary: 'dashboard/recipe.js',
  renderRecipeGrids: 'dashboard/recipe.js',
  renderRecipeGrid: 'dashboard/recipe.js',
  wireRecipeGrid: 'dashboard/recipe.js',
  showAddActionMenu: 'dashboard/recipe.js',
  showActionDialog: 'dashboard/recipe.js',
  commitAction: 'dashboard/recipe.js',
  saveRecipe: 'dashboard/recipe.js',
  generateRecipeName: 'dashboard/recipe.js',

  // artifacts.js
  wireArtifactsGrid: 'dashboard/artifacts.js',
  ensureArtifactGridEvents: 'dashboard/artifacts.js',
  loadArtifactPreview: 'dashboard/artifacts.js',
  renderArtifactPreview: 'dashboard/artifacts.js',
  openArtifactViewer: 'dashboard/artifacts.js',
  openCodeViewer: 'dashboard/artifacts.js',
  openTsvGridViewer: 'dashboard/artifacts.js',
  updateAssertionsGrid: 'dashboard/artifacts.js',
  handleArtifactBroadcast: 'dashboard/artifacts.js',

  // script-history.js
  wireScriptHistoryToggle: 'dashboard/script-history.js',
  switchToLiveMode: 'dashboard/script-history.js',
  switchToArchiveMode: 'dashboard/script-history.js',
  loadArchiveRuns: 'dashboard/script-history.js',
  handleArchiveRunSelect: 'dashboard/script-history.js',
  refreshSessionConsole: 'dashboard/script-history.js',
  refreshSessionNetwork: 'dashboard/script-history.js',

  // test-results.js
  loadTestResults: 'dashboard/test-results.js',

  // broadcast.js
  handleDashboardMessage: 'dashboard/broadcast.js',
  handleBroadcast: 'dashboard/broadcast.js',
  handleScriptBroadcast: 'dashboard/broadcast.js',
  handleActionResponse: 'dashboard/broadcast.js',
  updateConnectionUI: 'dashboard/broadcast.js',

  // layout.js
  saveLayout: 'dashboard/layout.js',
  debouncedSaveLayout: 'dashboard/layout.js',
  applyLayout: 'dashboard/layout.js',
};

// Functions (and the orchestrator) that stay in dashboard-app.js entry file.
const KEEP_IN_ENTRY = new Set([
  'loadDashboard',
  'toRecipeId',
  'findFirstGotoUrl',
]);

// Stray top-level `var` declarations interleaved between functions in the
// source. Each is a single line — route to the portlet that uses it.
const STRAY_VARS = {
  2310: 'dashboard/shared.js',  // var DISPATCH_TIMEOUT_MS = 15000;
  3831: 'dashboard/help.js',    // var _helpWindow = null;
};

// Multi-line stray code blocks (window.* assignments, etc.) interleaved
// between functions. [startLine, endLine] inclusive -> target file.
const STRAY_RANGES = [
  // window._openScreenshotViewer = function (...) { ... };
  // Called from inline onclick in renderArtifactPreview's HTMLFlow.
  { start: 3740, end: 3758, target: 'dashboard/artifacts.js' },
  // window._openTraceViewer = function (...) { ... };
  { start: 3760, end: 3777, target: 'dashboard/artifacts.js' },
];

const FILE_HEADERS = {
  'dashboard/shared.js': 'Cross-portlet helpers: dispatch, formatting, toolbar refresh.',
  'dashboard/toolbar.js': 'Top toolbar buttons: Run, Session Run, Debug, Eval, capture toggle.',
  'dashboard/session-record.js': 'Trace and video recording toggles for sessions.',
  'dashboard/auth-capture.js': 'Auth capture flow (login -> save credentials for replay).',
  'dashboard/help.js': 'Help window content + filter.',
  'dashboard/sessions.js': 'Sessions portlet: New Session dialog.',
  'dashboard/scripts.js': 'Scripts library, editor loading, file save, recipe binding.',
  'dashboard/monaco.js': 'Monaco editor lifecycle, breakpoints, V8 debugger pane.',
  'dashboard/schedules.js': 'Schedules portlet dialogs and form helpers.',
  'dashboard/run-plans.js': 'Run plan composition dialogs.',
  'dashboard/recipe.js': 'Recipe (pre/post action) builder.',
  'dashboard/artifacts.js': 'Artifacts grid, preview, code/TSV viewers, assertions.',
  'dashboard/script-history.js': 'Live/Archive history toggle + Console/Network refresh.',
  'dashboard/test-results.js': 'Test Results portlet.',
  'dashboard/broadcast.js': 'Bridge broadcast handlers + connection UI.',
  'dashboard/layout.js': 'Portal layout persistence.',
};

// ---- helpers ----

function awkExtractRanges(sourcePath) {
  // Top-level functions: open with /^function name/ and close with /^}$/
  // (column-1 brace). Verified earlier: source has exactly 89 of each, matched.
  const awkProgram = `
    /^function [a-zA-Z_]/ {
      match($0, /function ([a-zA-Z_][a-zA-Z0-9_]*)/, arr)
      start = NR
      name = arr[1]
      next
    }
    name && /^}$/ {
      print start "\\t" NR "\\t" name
      name = ""
    }
  `;
  const out = execSync(`awk '${awkProgram}' '${sourcePath}'`, { encoding: 'utf8' });
  return out.trim().split('\n').map((line) => {
    const [start, end, name] = line.split('\t');
    return { start: +start, end: +end, name };
  });
}

function fileHeader(relPath, names) {
  const desc = FILE_HEADERS[relPath] || '';
  const list = names.join(', ');
  return `// ${relPath}\n// ${desc}\n// Functions: ${list}\n\n`;
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

// ---- main ----

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`Source not found: ${SOURCE}`);
    process.exit(1);
  }

  if (args.has('--clean')) rmrf(OUT_DIR);
  if (fs.existsSync(OUT_DIR)) {
    console.error(`Output already exists: ${OUT_DIR}\n  Use --clean to overwrite.`);
    process.exit(1);
  }
  fs.mkdirSync(PORTLET_DIR, { recursive: true });

  const sourceText = fs.readFileSync(SOURCE, 'utf8');
  const sourceLines = sourceText.split('\n');
  const ranges = awkExtractRanges(SOURCE);

  // ---- coverage check ----
  const sourceFns = new Set(ranges.map((r) => r.name));
  const manifestFns = new Set([...Object.keys(MANIFEST), ...KEEP_IN_ENTRY]);
  const unclassified = [...sourceFns].filter((n) => !manifestFns.has(n));
  const phantom = [...manifestFns].filter((n) => !sourceFns.has(n));
  if (unclassified.length || phantom.length) {
    if (unclassified.length) console.error(`Unclassified (in source, not in manifest): ${unclassified.join(', ')}`);
    if (phantom.length) console.error(`Phantom (in manifest, not in source): ${phantom.join(', ')}`);
    process.exit(2);
  }

  // ---- bucket function bodies by output file ----
  const buckets = {};   // relPath -> [{ name, lines: [start..end], srcStart }]
  for (const r of ranges) {
    const target = KEEP_IN_ENTRY.has(r.name) ? null : MANIFEST[r.name];
    if (!target) continue; // entry-file functions handled separately
    if (!buckets[target]) buckets[target] = [];
    const body = sourceLines.slice(r.start - 1, r.end).join('\n');
    buckets[target].push({ name: r.name, body, srcStart: r.start });
  }

  // ---- distribute stray vars + ranges into their portlet buckets ----
  const strayPrefixes = {};  // relPath -> string (top of file)
  const straySuffixes = {};  // relPath -> string (bottom of file)
  for (const [lineStr, target] of Object.entries(STRAY_VARS)) {
    const src = sourceLines[+lineStr - 1];
    strayPrefixes[target] = (strayPrefixes[target] || '') + src + '\n';
  }
  for (const r of STRAY_RANGES) {
    const block = sourceLines.slice(r.start - 1, r.end).join('\n');
    straySuffixes[r.target] = (straySuffixes[r.target] || '') + '\n\n' + block;
  }

  // ---- emit portlet files ----
  for (const [relPath, fns] of Object.entries(buckets)) {
    fns.sort((a, b) => a.srcStart - b.srcStart);
    const names = fns.map((f) => f.name);
    const prefix = strayPrefixes[relPath] ? strayPrefixes[relPath] + '\n' : '';
    const suffix = straySuffixes[relPath] ? straySuffixes[relPath] + '\n' : '';
    const text = fileHeader(relPath, names)
      + prefix
      + fns.map((f) => f.body).join('\n\n')
      + suffix
      + '\n';
    const outPath = path.join(OUT_DIR, relPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, text);
  }

  // ---- emit entry file (dashboard-app.js) ----
  // Strategy: delete the line ranges that have moved out (function bodies +
  // stray var lines). Keep top-of-file state, KEEP_IN_ENTRY function bodies,
  // and the surrounding context exactly as written.
  const movedRanges = ranges
    .filter((r) => !KEEP_IN_ENTRY.has(r.name))
    .map((r) => [r.start, r.end]);
  for (const lineStr of Object.keys(STRAY_VARS)) {
    const n = +lineStr;
    movedRanges.push([n, n]);
  }
  for (const r of STRAY_RANGES) movedRanges.push([r.start, r.end]);
  movedRanges.sort((a, b) => a[0] - b[0]);

  const keepLines = [];
  let cursor = 1;
  for (const [s, e] of movedRanges) {
    while (cursor < s) keepLines.push(sourceLines[cursor - 1]), cursor++;
    cursor = e + 1;
  }
  while (cursor <= sourceLines.length) keepLines.push(sourceLines[cursor - 1]), cursor++;

  // Collapse runs of 3+ blank lines (left behind where functions were excised).
  let compact = [];
  let blanks = 0;
  for (const line of keepLines) {
    if (line.trim() === '') {
      blanks++;
      if (blanks <= 2) compact.push(line);
    } else {
      blanks = 0;
      compact.push(line);
    }
  }

  // After loadDashboard's closing `}`, the rest of the entry is just orphan
  // section markers and JSDoc fragments whose functions moved out. Find the
  // end of loadDashboard in the compacted output and truncate after it.
  const endOfLoadDash = (() => {
    let depth = 0, started = false;
    for (let i = 0; i < compact.length; i++) {
      const line = compact[i];
      if (!started && /^function loadDashboard\b/.test(line)) started = true;
      if (!started) continue;
      for (const c of line) {
        if (c === '{') depth++;
        else if (c === '}') depth--;
      }
      if (started && depth === 0 && /\}/.test(line)) return i;  // index of the closing `}` line
    }
    return -1;
  })();
  if (endOfLoadDash >= 0) compact = compact.slice(0, endOfLoadDash + 1).concat(['']);

  const entryHeader = [
    '// dashboard-app.js — entry point + state + loadDashboard orchestrator.',
    '// Portlet wiring lives in dashboard/*.js (loaded via separate <script> tags).',
    '',
  ].join('\n');
  fs.writeFileSync(
    path.join(OUT_DIR, 'dashboard-app.js'),
    entryHeader + compact.join('\n')
  );

  // ---- emit load-order.txt ----
  // Order: shared.js first (helpers), then portlets, then dashboard-app.js last.
  const portletOrder = [
    'dashboard/shared.js',
    'dashboard/layout.js',
    'dashboard/broadcast.js',
    'dashboard/help.js',
    'dashboard/auth-capture.js',
    'dashboard/session-record.js',
    'dashboard/toolbar.js',
    'dashboard/sessions.js',
    'dashboard/schedules.js',
    'dashboard/run-plans.js',
    'dashboard/recipe.js',
    'dashboard/artifacts.js',
    'dashboard/script-history.js',
    'dashboard/scripts.js',
    'dashboard/monaco.js',
    'dashboard/test-results.js',
    'dashboard-app.js',
  ];
  const loadOrder = portletOrder
    .map((p) => `<script src="${p}"></script>`)
    .join('\n') + '\n';
  fs.writeFileSync(path.join(OUT_DIR, 'load-order.txt'), loadOrder);

  // ---- summary ----
  console.log('--- output files ---');
  let totalOut = 0;
  for (const relPath of portletOrder) {
    const full = path.join(OUT_DIR, relPath);
    if (!fs.existsSync(full)) continue;
    const lc = fs.readFileSync(full, 'utf8').split('\n').length;
    totalOut += lc;
    const fnCount = relPath === 'dashboard-app.js'
      ? KEEP_IN_ENTRY.size
      : (buckets[relPath] || []).length;
    console.log(`  ${relPath.padEnd(34)} ${String(lc).padStart(5)} lines  ${fnCount} fns`);
  }
  console.log('--- totals ---');
  console.log(`  source                              ${String(sourceLines.length).padStart(5)} lines  ${ranges.length} fns`);
  console.log(`  output (sum)                        ${String(totalOut).padStart(5)} lines  ${ranges.length} fns`);
  console.log(`  diff                                ${String(totalOut - sourceLines.length).padStart(5)} lines  (headers + trimmed orphans)`);
  console.log('--- output ---');
  console.log(`  ${OUT_DIR}`);

  // ---- optional sdiff -s set-difference verification ----
  // Sorts source and concatenated-output, runs sdiff -s, and bins lines by
  // gutter marker. After the refactor the only differences should be
  // file-header lines we ADDED (right-only) and orphan section markers we
  // TRIMMED (left-only). Any line of real code in left-only is a bug.
  if (args.has('--sdiff')) {
    const tmpA = '/tmp/refactor-dash-orig.txt';
    const tmpB = '/tmp/refactor-dash-new.txt';
    execSync(`sort '${SOURCE}' > '${tmpA}'`);
    const portletGlob = path.join(PORTLET_DIR, '*.js');
    execSync(`cat ${portletGlob} '${path.join(OUT_DIR, 'dashboard-app.js')}' | sort > '${tmpB}'`, { shell: '/bin/bash' });
    let raw;
    try {
      raw = execSync(`sdiff -s '${tmpA}' '${tmpB}'`, { encoding: 'utf8' });
    } catch (e) {
      // sdiff exits non-zero when files differ; that's expected
      raw = e.stdout || '';
    }
    const lines = raw.split('\n');
    const left = lines.filter((l) => /<$/.test(l));
    const right = lines.filter((l) => /^\t+ +>/.test(l));
    const changed = lines.filter((l) => / \| /.test(l));
    console.log('\n--- sdiff -s set-difference (sorted) ---');
    console.log(`  left-only (orig, missing from new):  ${left.length}`);
    console.log(`  right-only (new, not in orig):       ${right.length}`);
    console.log(`  changed (modified in place):         ${changed.length}`);

    // Audit: any left-only line that isn't an orphan section marker, blank,
    // or trivial closing brace is a bug.
    const suspicious = left
      .map((l) => l.replace(/\s+<$/, ''))
      .filter((l) => {
        const t = l.trim();
        if (!t) return false;
        if (/^\/\//.test(t)) return false;          // any line comment
        if (/^\/\*|^\*|^\*\//.test(t)) return false; // JSDoc fragments
        return true;
      });
    if (suspicious.length) {
      console.error(`\n  SUSPICIOUS left-only lines (potential lost code):`);
      for (const s of suspicious.slice(0, 20)) console.error(`    ${s}`);
      if (suspicious.length > 20) console.error(`    ... and ${suspicious.length - 20} more`);
      process.exit(4);
    } else {
      console.log(`  OK: all left-only lines are trimmed orphans (comments/blanks).`);
    }
  }

  // ---- optional round-trip verify ----
  if (args.has('--verify')) {
    console.log('\n--- verify: each source function should appear in exactly one output file ---');
    let bad = 0;
    for (const r of ranges) {
      const target = KEEP_IN_ENTRY.has(r.name) ? 'dashboard-app.js' : MANIFEST[r.name];
      const text = fs.readFileSync(path.join(OUT_DIR, target), 'utf8');
      const matches = text.match(new RegExp(`^function ${r.name}\\b`, 'gm')) || [];
      if (matches.length !== 1) {
        console.error(`  BAD ${r.name}: ${matches.length} occurrences in ${target}`);
        bad++;
      }
    }
    if (bad === 0) console.log(`  OK: all ${ranges.length} functions placed exactly once.`);
    else process.exit(3);
  }
}

main();
