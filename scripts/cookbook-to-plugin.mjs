#!/usr/bin/env node
/**
 * Cookbook-to-plugin generator.
 *
 * Reads a PocketFlow cookbook example, generates a wrapping agentidev plugin:
 *   extension/apps/<plugin-id>/{manifest.json,handlers.js,templates/dashboard.json}
 * Updates extension/apps/index.json + _loaded.js.
 *
 * Usage:
 *   node scripts/cookbook-to-plugin.mjs --example=pocketflow-batch
 *   node scripts/cookbook-to-plugin.mjs --example=pocketflow-batch --id=pf-batch-translate
 *   node scripts/cookbook-to-plugin.mjs --example=PATH --dry-run
 *
 * Best-effort. The generator does mechanical work (concat files, swap imports,
 * add stdin/stdout shim, detect inputs from prep()). Examples using input(),
 * unusual call_llm signatures, or stateful loops require manual review —
 * the generator prints WARNINGS for the cases it spots.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const APPS_DIR = path.resolve(REPO_ROOT, 'extension/apps');
const COOKBOOK_DEFAULT = path.resolve(process.env.HOME || '', 'repos/PocketFlow/cookbook');

const args = process.argv.slice(2);
function getArg(name) {
  const a = args.find((x) => x.startsWith('--' + name + '='));
  return a ? a.split('=').slice(1).join('=') : null;
}
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const EXAMPLE = getArg('example');
let PLUGIN_ID = getArg('id');
const COOKBOOK_DIR = getArg('cookbook') || COOKBOOK_DEFAULT;

if (!EXAMPLE) {
  console.error('Usage: cookbook-to-plugin.mjs --example=<cookbook-name-or-path> [--id=<plugin-id>] [--dry-run] [--force]');
  process.exit(1);
}

// ---- Resolve example dir ----
let exampleDir = EXAMPLE;
if (!path.isAbsolute(exampleDir)) {
  exampleDir = path.resolve(COOKBOOK_DIR, EXAMPLE);
}
if (!fs.existsSync(exampleDir) || !fs.statSync(exampleDir).isDirectory()) {
  console.error(`Cookbook example not found: ${exampleDir}`);
  process.exit(1);
}

const exampleName = path.basename(exampleDir);
if (!PLUGIN_ID) {
  // pocketflow-batch -> pf-batch (drop "pocketflow-" prefix, prepend "pf-")
  PLUGIN_ID = exampleName.replace(/^pocketflow-/, 'pf-');
}
const PLUGIN_DIR = path.resolve(APPS_DIR, PLUGIN_ID);

if (fs.existsSync(PLUGIN_DIR) && !FORCE) {
  console.error(`Plugin already exists: ${PLUGIN_DIR}\n  Use --force to overwrite.`);
  process.exit(1);
}

// ---- Read source files ----
function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}
const readme = readIfExists(path.join(exampleDir, 'README.md'));
const filesInOrder = ['nodes.py', 'flow.py', 'utils.py', 'main.py'];
const sourceParts = [];
for (const f of filesInOrder) {
  const s = readIfExists(path.join(exampleDir, f));
  if (s) sourceParts.push({ name: f, src: s });
}
if (sourceParts.length === 0) {
  console.error(`No Python files found in ${exampleDir}`);
  process.exit(1);
}

// ---- Build the flow source ----

// Strip per-file imports/__main__ blocks and concat. Replacement order matters.
function transformSourceFile(name, src) {
  let out = src;

  // Replace utils-import lines with agentidev_llm. Catch every shape we've
  // seen in the cookbook: `from utils import call_llm`, `from .utils import
  // call_llm`, `from utils.call_llm import call_llm`, etc.
  out = out.replace(/^\s*from\s+utils(?:\.[a-zA-Z_]+)?\s+import\s+call_llm.*$/gm, 'from agentidev_llm import call_llm');
  out = out.replace(/^\s*from\s+\.utils(?:\.[a-zA-Z_]+)?\s+import\s+call_llm.*$/gm, 'from agentidev_llm import call_llm');
  out = out.replace(/^\s*from\s+utils\s+import\s+.*$/gm, '# (utils import elided — using agentidev_llm)');

  // Strip cross-file imports — flow.py / nodes.py / main.py become one file
  // after concatenation, so `from flow import x` / `from nodes import Y` /
  // `from main import Z` no longer point at anything. The symbols are
  // already in scope from the prior file in the concat.
  out = out.replace(/^\s*from\s+(flow|nodes|main)(?:\.[a-zA-Z_]+)?\s+import\s+.*$/gm, '# (cross-file import elided — single concatenated source)');
  out = out.replace(/^\s*import\s+(flow|nodes|main)\s*$/gm, '# (cross-file import elided)');

  // utils.py / utils/*.py: any provider-keyed shim gets replaced with a
  // pass-through comment. The agentidev_llm import is added once at the top
  // of the combined source.
  if (name === 'utils.py' || /utils\//.test(name)) {
    if (/from openai import|from anthropic import|OpenAI\(|Anthropic\(/.test(out)) {
      return '# utils.py replaced by agentidev_llm (bridge /llm endpoint)\n';
    }
  }

  // Strip if __name__ == "__main__": blocks — we'll inject our stdin/stdout shim once
  out = out.replace(/^if\s+__name__\s*==\s*["']__main__["']\s*:[\s\S]*$/m, '');

  return out;
}

const transformedParts = sourceParts.map((p) => `# === ${p.name} ===\n${transformSourceFile(p.name, p.src).trim()}\n`);
let combined = transformedParts.join('\n\n');

// Ensure the agentidev_llm import is present — flows might lose it after the
// utils.py was elided. If any call_llm() reference remains and the import is
// missing, prepend it.
if (/\bcall_llm\s*\(/.test(combined) && !/from\s+agentidev_llm\s+import\s+call_llm/.test(combined)) {
  combined = 'from agentidev_llm import call_llm\n\n' + combined;
}

// Detect available `flow` symbol at module scope to decide stdin/stdout shim
const flowSymbolMatch = combined.match(/^\s*([a-z_][a-z0-9_]*)\s*=\s*Flow\s*\(/im);
const flowSymbol = flowSymbolMatch ? flowSymbolMatch[1] : null;

// Detect input fields from prep() shared.get / shared["x"] usage
const inputFields = new Set();
const sharedGetRe = /shared\.get\s*\(\s*["']([a-zA-Z_][a-zA-Z0-9_]*)["']/g;
const sharedIdxRe = /shared\s*\[\s*["']([a-zA-Z_][a-zA-Z0-9_]*)["']\s*\]/g;
let m;
while ((m = sharedGetRe.exec(combined)) !== null) inputFields.add(m[1]);
while ((m = sharedIdxRe.exec(combined)) !== null) inputFields.add(m[1]);
// Filter out obvious internal keys plugins shouldn't surface
for (const k of Array.from(inputFields)) {
  if (/^(messages|history|results?|errors?|out|output|response)$/i.test(k)) inputFields.delete(k);
}

// Detect warnings
const warnings = [];
if (/\binput\s*\(/.test(combined)) {
  warnings.push('Source uses input() for interactive prompts — flow will hang headless. Refactor to read from shared state.');
}
if (/from openai import|anthropic\.|gpt-4|gpt-3|claude-/.test(combined) && !/from agentidev_llm/.test(combined)) {
  warnings.push('Source references a specific LLM provider directly — replace those calls with `from agentidev_llm import call_llm`.');
}
if (/call_llm\s*\(\s*messages\s*\)/.test(combined)) {
  warnings.push('Source calls `call_llm(messages)` — agentidev_llm.call_llm takes a single prompt string. Format messages into a prompt before calling.');
}

// ---- Compose the flow source ----

const flowMain = flowSymbol
  ? `if __name__ == "__main__":
    import json, sys
    shared = {}
    if not sys.stdin.isatty():
        raw = sys.stdin.read()
        if raw.strip():
            try: shared = json.loads(raw)
            except json.JSONDecodeError: shared = {}
    try:
        ${flowSymbol}.run(shared)
    except Exception as e:
        shared["error"] = str(e)
    json.dump(shared, sys.stdout, indent=2, default=str)
    sys.stdout.write("\\n")
`
  : `# WARNING: no `+'`flow = Flow(...)`'+` symbol detected — add a stdin/stdout shim manually.\n`;

const finalFlowSource = `"""\n${PLUGIN_ID} — generated from cookbook/${exampleName}\n\nGenerated by scripts/cookbook-to-plugin.mjs. Edit the plugin's handlers.js\n(FLOW_SOURCE constant) to customize. Each click on the plugin re-saves\nthe flow to ~/.agentidev/flows/${PLUGIN_ID}.py.\n"""\n${combined}\n\n${flowMain}`;

// ---- Manifest ----

function deriveTitle(id) {
  return id.replace(/^pf-/, '').split(/[-_]/).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}
const pluginTitle = deriveTitle(PLUGIN_ID);

const description = (readme && readme.split('\n').slice(1, 5).join(' ').replace(/\s+/g, ' ').trim().slice(0, 200))
  || `Adapted from PocketFlow cookbook/${exampleName}.`;

const manifest = {
  id: PLUGIN_ID,
  name: pluginTitle,
  version: '0.1.0',
  description,
  modes: [PLUGIN_ID],
  templates: { dashboard: 'templates/dashboard.json' },
  handlers: 'handlers.js',
  requires: { hostCapabilities: ['message'] },
};

// ---- Handler ----

const messageType = 'PF_' + PLUGIN_ID.replace(/^pf-/, '').toUpperCase().replace(/-/g, '_');

const handlerSource = `/**
 * ${PLUGIN_ID} plugin handlers — generated from cookbook/${exampleName}.
 *
 * Idempotent FLOW_DEFINE on each run keeps the plugin file as the
 * source of truth. Form values flow into the Python flow via shared state.
 *
 * Generated by scripts/cookbook-to-plugin.mjs. Hand-edit as needed.
 */

const FLOW_SOURCE = ${JSON.stringify(finalFlowSource)};

const FLOW_NAME = ${JSON.stringify(PLUGIN_ID)};
const PLUGIN_ID = ${JSON.stringify(PLUGIN_ID)};

export function register(handlers) {
  handlers[${JSON.stringify(messageType)}] = async (msg) => {
    const defineRes = await handlers['FLOW_DEFINE']({ name: FLOW_NAME, source: FLOW_SOURCE });
    if (!defineRes.success) {
      return { success: false, error: 'flow define failed: ' + (defineRes.error || 'unknown') };
    }
    // Pass the form values as the initial shared state. Field names should
    // match the keys the flow's prep() reads from shared.
    const shared = Object.assign({}, msg || {});
    delete shared.type; // dispatch metadata, not for the flow
    const runRes = await handlers['FLOW_RUN']({
      name: FLOW_NAME,
      pluginId: PLUGIN_ID,
      shared,
      timeout: 90000,
    });
    if (!runRes.success) {
      return { success: false, error: 'flow run failed: ' + (runRes.error || 'unknown'), stderr: runRes.stderr };
    }
    const final = runRes.shared || {};
    return { success: !final.error, shared: final, error: final.error || null };
  };
}
`;

// ---- Dashboard template ----

const inputFieldArray = Array.from(inputFields).sort();
const formFields = inputFieldArray.length > 0
  ? inputFieldArray.map((name) => ({
      name,
      title: name,
      type: 'textArea',
      height: 80,
      width: '*',
      defaultValue: '',
    }))
  : [{
      name: 'shared_json',
      title: 'Shared (JSON)',
      type: 'textArea',
      height: 200,
      width: '*',
      defaultValue: '{}',
    }];

const dashboard = {
  dataSources: [{
    ID: 'plugin-runs',
    fields: [
      { name: 'id', type: 'integer', primaryKey: true },
      { name: 'pluginId', type: 'text' },
      { name: 'flowName', type: 'text' },
      { name: 'ts', type: 'integer' },
      { name: 'durationMs', type: 'integer' },
      { name: 'success', type: 'boolean' },
      { name: 'error', type: 'text' },
      { name: 'sharedIn', type: 'text' },
      { name: 'sharedOut', type: 'text' },
    ],
  }],
  layout: {
    _type: 'VLayout',
    ID: PLUGIN_ID.replace(/-/g, '_') + 'Root',
    width: '100%',
    height: '100%',
    padding: 12,
    membersMargin: 8,
    members: [
      {
        _type: 'Label',
        height: 26,
        contents: `<div style='font-size:16px;font-weight:600;color:#a8b4ff;'>${pluginTitle} <span style='font-size:11px;color:#888;font-weight:400;margin-left:8px;'>cookbook/${exampleName}</span></div>`,
      },
      {
        _type: 'TabSet',
        ID: 'pluginTabs',
        width: '100%',
        height: '*',
        tabs: [
          {
            title: 'Run',
            ID: 'tabRun',
            pane: {
              _type: 'VLayout',
              padding: 12,
              membersMargin: 8,
              overflow: 'auto',
              members: [
                {
                  _type: 'DynamicForm',
                  ID: 'inputForm',
                  width: '100%',
                  height: Math.min(80 * formFields.length + 30, 360),
                  numCols: 2,
                  colWidths: [100, '*'],
                  titleOrientation: 'left',
                  fields: formFields,
                },
                {
                  _type: 'HLayout',
                  height: 32,
                  membersMargin: 8,
                  members: [
                    {
                      _type: 'Button',
                      ID: 'btnRun',
                      title: 'Run',
                      width: 120,
                      _action: 'dispatchAndDisplay',
                      _messageType: messageType,
                      _payloadFrom: 'inputForm',
                      _targetCanvas: 'outputShared',
                      _resultPath: 'shared',
                      _resultFormatter: 'json',
                      _timeoutMs: 90000,
                    },
                    {
                      _type: 'Label',
                      width: '*',
                      contents: '<div style=\'font-size:11px;color:#888;line-height:1.4;\'>Form values flow into the Python flow as initial shared state.</div>',
                    },
                  ],
                },
                { _type: 'Label', height: 16, contents: '<div style=\'font-size:11px;color:#666;\'>Final shared state</div>' },
                {
                  _type: 'HTMLFlow',
                  ID: 'outputShared',
                  height: '*',
                  padding: 4,
                  overflow: 'auto',
                  contents: '<em style=\'color:#888;\'>Click Run to execute the flow.</em>',
                },
              ],
            },
          },
          {
            title: 'History',
            ID: 'tabHistory',
            pane: {
              _type: 'VLayout',
              padding: 12,
              membersMargin: 8,
              members: [
                {
                  _type: 'HLayout',
                  height: 28,
                  membersMargin: 8,
                  members: [
                    { _type: 'Button', ID: 'btnRefreshHistory', title: 'Refresh', width: 100, _action: 'dsFetch', _targetGrid: 'runHistoryGrid' },
                    { _type: 'Label', width: '*', contents: '<div style=\'font-size:11px;color:#888;line-height:1.4;\'>Click any row to replay its inputs.</div>' },
                  ],
                },
                {
                  _type: 'ListGrid',
                  ID: 'runHistoryGrid',
                  height: '*',
                  dataSource: 'plugin-runs',
                  autoFetchData: true,
                  criteria: { pluginId: PLUGIN_ID },
                  initialCriteria: { pluginId: PLUGIN_ID },
                  sortField: 'ts',
                  sortDirection: 'descending',
                  showHeader: true,
                  canEdit: false,
                  _replayInto: ['inputForm'],
                  _replaySwitchTab: ['pluginTabs', 'tabRun'],
                  emptyMessage: 'No runs yet — click Run to record one.',
                  fields: [
                    { name: 'ts', title: 'When', width: 160, _formatter: 'timestamp' },
                    { name: 'durationMs', title: 'Duration', width: 90, align: 'right' },
                    { name: 'success', title: 'OK', width: 50, type: 'boolean' },
                    { name: 'flowName', title: 'Flow', width: 140 },
                    { name: 'error', title: 'Error', width: '*' },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  },
};

// ---- Output ----

if (DRY_RUN) {
  console.log('--- DRY RUN ---');
  console.log(`Plugin id:        ${PLUGIN_ID}`);
  console.log(`Title:            ${pluginTitle}`);
  console.log(`Plugin dir:       ${PLUGIN_DIR}`);
  console.log(`Source files:     ${sourceParts.map((p) => p.name).join(', ')}`);
  console.log(`Detected inputs:  ${inputFieldArray.length > 0 ? inputFieldArray.join(', ') : '(none — fallback to JSON textarea)'}`);
  console.log(`Flow symbol:      ${flowSymbol || '(not detected)'}`);
  console.log(`Message type:     ${messageType}`);
  console.log(`Description:      ${description.slice(0, 80)}...`);
  if (warnings.length > 0) {
    console.log('\nWARNINGS (manual review needed):');
    for (const w of warnings) console.log('  • ' + w);
  }
  console.log('\nFlow source preview (first 600 chars):');
  console.log(finalFlowSource.slice(0, 600) + '...\n');
  process.exit(0);
}

// Write files
fs.mkdirSync(path.join(PLUGIN_DIR, 'templates'), { recursive: true });
fs.writeFileSync(path.join(PLUGIN_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(PLUGIN_DIR, 'handlers.js'), handlerSource);
fs.writeFileSync(path.join(PLUGIN_DIR, 'templates/dashboard.json'), JSON.stringify(dashboard, null, 2) + '\n');

// Update index.json
const indexPath = path.join(APPS_DIR, 'index.json');
const indexJson = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
if (!indexJson.plugins.includes(PLUGIN_ID)) {
  indexJson.plugins.push(PLUGIN_ID);
  fs.writeFileSync(indexPath, JSON.stringify(indexJson, null, 2) + '\n');
}

// Update _loaded.js
const loadedPath = path.join(APPS_DIR, '_loaded.js');
let loadedSrc = fs.readFileSync(loadedPath, 'utf-8');
const camelId = 'register' + PLUGIN_ID.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
const newImport = `import { register as ${camelId} } from './${PLUGIN_ID}/handlers.js';`;
if (!loadedSrc.includes(newImport)) {
  // Insert import after the last import line
  loadedSrc = loadedSrc.replace(
    /(import \{ register as register[^}]*\} from '[^']+'.*\n)(\nexport)/s,
    `$1${newImport}\n$2`,
  );
  // Insert registry entry — match (optional trailing comma)+newline+`};` so
  // we replace the existing closer cleanly. Without consuming the trailing
  // comma we'd produce `entry,,\n  newEntry,` (double comma).
  loadedSrc = loadedSrc.replace(
    /(,?\s*\n\s*\};\s*)$/,
    `,\n  '${PLUGIN_ID}': ${camelId},\n};\n`,
  );
  fs.writeFileSync(loadedPath, loadedSrc);
}

// Update .gitignore allow-list (in case it's gitignored by the apps/* rule)
const gitignorePath = path.resolve(REPO_ROOT, '.gitignore');
let gitignore = fs.readFileSync(gitignorePath, 'utf-8');
const allowLine = `!extension/apps/${PLUGIN_ID}/`;
if (!gitignore.includes(allowLine)) {
  gitignore = gitignore.replace(
    /(!extension\/apps\/csv-analyzer\/)/,
    `$1\n${allowLine}`,
  );
  fs.writeFileSync(gitignorePath, gitignore);
}

// ---- Summary ----
console.log(`Generated plugin: ${PLUGIN_ID}`);
console.log(`  Title:    ${pluginTitle}`);
console.log(`  Dir:      ${PLUGIN_DIR}`);
console.log(`  Source:   ${sourceParts.map((p) => p.name).join(', ')}`);
console.log(`  Inputs:   ${inputFieldArray.length > 0 ? inputFieldArray.join(', ') : '(none — JSON textarea fallback)'}`);
console.log(`  Message:  ${messageType}`);
console.log(`  Mode URL: chrome-extension://<ext>/smartclient-app/wrapper.html?mode=${PLUGIN_ID}`);
if (warnings.length > 0) {
  console.log('\nWARNINGS (manual review may be needed):');
  for (const w of warnings) console.log('  • ' + w);
}
console.log('\nNext: reload the extension to pick up the new plugin.');
