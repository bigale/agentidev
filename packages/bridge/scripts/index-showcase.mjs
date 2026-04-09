#!/usr/bin/env node
/**
 * SmartClient Showcase Indexer
 *
 * Reads ~627 showcase examples from the SmartClient SDK, sends each through
 * the bridge for neural embedding (all-MiniLM-L6-v2, 384-dim),
 * and stores in the bridge-side LanceDB (source: 'showcase').
 *
 * Usage:
 *   node packages/bridge/scripts/index-showcase.mjs                      # index all examples
 *   node packages/bridge/scripts/index-showcase.mjs --dry-run            # parse only, print stats
 *   node packages/bridge/scripts/index-showcase.mjs --limit=10           # index first 10
 *   node packages/bridge/scripts/index-showcase.mjs --category=AI        # only AI category
 *   node packages/bridge/scripts/index-showcase.mjs --wait-for-neural    # wait for neural model before indexing
 */

import { ScriptClient } from '../script-client.mjs';
import { MSG } from '../protocol.mjs';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { createRequire } from 'module';
import vm from 'vm';

// ---- Configuration ----

const args = process.argv.slice(2);
const sdkPathArg = args.find(a => a.startsWith('--sdk-path='));
const SDK_BASE = sdkPathArg
  ? sdkPathArg.split('=').slice(1).join('=')
  : process.env.SMARTCLIENT_SDK || 'smartclientSDK';
const EXAMPLE_TREE_PATH = join(SDK_BASE, 'isomorphic/system/reference/exampleTree.js');
const INLINE_EXAMPLES_DIR = join(SDK_BASE, 'isomorphic/system/reference/inlineExamples');
const SHARED_DS_DIR = join(SDK_BASE, 'examples/shared/ds');

// Known isc.ComponentName patterns to extract as keywords
const SC_COMPONENTS = [
  'ListGrid', 'TreeGrid', 'TileGrid', 'DetailViewer', 'CubeGrid', 'ColumnTree',
  'DynamicForm', 'ValuesManager', 'FilterBuilder', 'SearchForm',
  'TextItem', 'TextAreaItem', 'SelectItem', 'ComboBoxItem', 'DateItem',
  'TimeItem', 'CheckboxItem', 'RadioGroupItem', 'SpinnerItem', 'SliderItem',
  'ColorItem', 'PasswordItem', 'UploadItem', 'RichTextEditor', 'ButtonItem',
  'HeaderItem', 'BlurbItem', 'CanvasItem', 'MultiComboBoxItem', 'PickTreeItem',
  'RelativeDateItem', 'DateRangeItem', 'MiniDateRangeItem',
  'TabSet', 'SectionStack', 'Window', 'Dialog', 'Portlet', 'PortalLayout',
  'NavigationBar', 'SplitPane', 'Deck',
  'Layout', 'HLayout', 'VLayout', 'HStack', 'VStack', 'FlowLayout',
  'Canvas', 'Img', 'Label', 'HTMLFlow', 'HTMLPane', 'ViewLoader',
  'ToolStrip', 'ToolStripButton', 'ToolStripMenuButton', 'MenuBar',
  'Menu', 'MenuButton', 'IMenuButton',
  'Calendar', 'Timeline',
  'DrawPane', 'DrawItem', 'DrawRect', 'DrawOval', 'DrawLine', 'DrawPath',
  'DrawTriangle', 'DrawLabel', 'DrawImage', 'Gauge',
  'FacetChart', 'ChartLabel',
  'TreeMenuButton', 'Slider', 'Shuttle', 'MultiPickerItem',
  'DataSource', 'RestDataSource', 'WSDataSource',
  'RPCManager', 'DMI',
  'Offline', 'OfflineDataSource',
  'ResultSet', 'ResultTree',
  'RibbonBar', 'RibbonGroup',
  'AdaptiveMenu',
  'BatchUploader',
  'Progressbar',
  'Snapbar',
  'Scrollbar',
  'Splitbar',
  'Hover',
  'Tour', 'TourStep',
  'PrintCanvas',
  'MultiSortDialog',
  'DateChooser',
];

// Build regex: matches isc.ComponentName
const SC_COMPONENT_RE = new RegExp(
  `isc\\.(${SC_COMPONENTS.join('|')})\\b`, 'g'
);

// ---- CLI args ----

const DRY_RUN = args.includes('--dry-run');
const WAIT_FOR_NEURAL = args.includes('--wait-for-neural');
const LIMIT = (() => {
  const limitArg = args.find(a => a.startsWith('--limit='));
  return limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;
})();
const CATEGORY_FILTER = (() => {
  const catArg = args.find(a => a.startsWith('--category='));
  return catArg ? catArg.split('=')[1].toLowerCase() : null;
})();

// ---- Tree Parser ----

function parseExampleTree() {
  const source = readFileSync(EXAMPLE_TREE_PATH, 'utf8');

  // Mock isc.ExampleTree.create() to capture the tree data
  let captured = null;
  const sandbox = {
    isc: {
      ExampleTree: {
        create: (data) => { captured = data; return data; },
      },
    },
  };

  vm.runInNewContext(source, sandbox, { filename: 'exampleTree.js' });

  if (!captured || !captured.root) {
    throw new Error('Failed to parse exampleTree.js');
  }

  return captured.root;
}

/**
 * Walk tree recursively, collect leaf examples with jsURL (skip ref entries).
 * Tracks category path from parent folder titles.
 */
function collectExamples(node, path = [], isRoot = true) {
  const examples = [];

  if (node.jsURL && !node.ref) {
    examples.push({
      ...node,
      categoryPath: [...path],
      category: path.length > 0 ? path[path.length - 1] : 'root',
    });
  }

  if (node.children) {
    // Skip the root node's name ("root/") from path
    const folderTitle = isRoot ? '' : (node.title || node.shortTitle || node.name || '');
    const childPath = folderTitle && !node.jsURL ? [...path, folderTitle] : path;
    for (const child of node.children) {
      examples.push(...collectExamples(child, childPath, false));
    }
  }

  return examples;
}

// ---- Keyword Extractor ----

function extractKeywords(jsSource) {
  const keywords = new Set();
  let match;
  while ((match = SC_COMPONENT_RE.exec(jsSource)) !== null) {
    keywords.add(match[1].toLowerCase());
  }
  // Reset regex lastIndex for reuse
  SC_COMPONENT_RE.lastIndex = 0;
  return [...keywords];
}

// ---- DataSource Resolver ----

function resolveDataSource(dsName) {
  // Try inlineExamples tree first (recursive search would be slow, check shared dir)
  const sharedPath = join(SHARED_DS_DIR, `${dsName}.ds.xml`);
  if (existsSync(sharedPath)) {
    return readFileSafe(sharedPath);
  }

  // Search inlineExamples subdirectories for <name>.ds.xml
  // Common locations based on the tree structure
  const searchDirs = ['grids/ds', 'forms/ds', 'trees/ds', 'charts/ds', 'calendar/ds', 'portal/ds'];
  for (const subdir of searchDirs) {
    const path = join(INLINE_EXAMPLES_DIR, subdir, `${dsName}.ds.xml`);
    if (existsSync(path)) {
      return readFileSafe(path);
    }
  }

  return null;
}

function resolveTabUrl(url) {
  const path = join(INLINE_EXAMPLES_DIR, url);
  if (existsSync(path)) {
    return readFileSafe(path);
  }
  return null;
}

function readFileSafe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// ---- HTML Stripping ----

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- Document Builder ----

function buildDocument(example) {
  const jsPath = join(INLINE_EXAMPLES_DIR, example.jsURL);
  const jsSource = readFileSafe(jsPath);

  if (!jsSource) {
    return null; // Skip examples whose JS file is missing
  }

  const exampleId = example.jsURL.replace(/\.js$/, '');
  const url = `smartclient://showcase/${exampleId}`;
  const title = `${example.title} - SmartClient Showcase`;
  const description = stripHtml(example.description);

  // Collect DataSource XMLs
  const dsXmls = [];
  if (example.tabs) {
    for (const tab of example.tabs) {
      if (tab.dataSource) {
        const xml = resolveDataSource(tab.dataSource);
        if (xml) {
          dsXmls.push({ name: tab.dataSource, xml });
        }
      }
      if (tab.url && tab.url.endsWith('.xml')) {
        const xml = resolveTabUrl(tab.url);
        if (xml) {
          dsXmls.push({ name: basename(tab.url), xml });
        }
      }
    }
  }

  // Build text content
  const parts = [title];
  if (description) parts.push(description);
  parts.push('--- Source Code ---');
  parts.push(jsSource);
  if (dsXmls.length > 0) {
    for (const ds of dsXmls) {
      parts.push(`--- DataSource: ${ds.name} ---`);
      parts.push(ds.xml);
    }
  }
  const text = parts.join('\n\n');

  // Extract keywords
  const keywords = extractKeywords(jsSource);

  // Category from path
  const category = example.categoryPath.join(' > ');

  return {
    url,
    title,
    text,
    html: '',
    contentType: 'api_reference',
    source: 'showcase',
    keywords,
    metadata: {
      source: 'smartclient-showcase',
      category,
      exampleId,
      hasDataSource: dsXmls.length > 0,
      version: example.version || '',
      jsURL: example.jsURL,
    },
  };
}

// ---- Main ----

async function main() {
  console.log('SmartClient Showcase Indexer');
  console.log('===========================\n');

  // Verify SDK exists
  if (!existsSync(EXAMPLE_TREE_PATH)) {
    console.error(`ERROR: exampleTree.js not found at ${EXAMPLE_TREE_PATH}`);
    process.exit(1);
  }

  // Parse tree
  console.log('Parsing exampleTree.js...');
  const root = parseExampleTree();
  let examples = collectExamples(root);
  console.log(`Found ${examples.length} examples (excluding ref duplicates)\n`);

  // Apply category filter
  if (CATEGORY_FILTER) {
    examples = examples.filter(ex =>
      ex.categoryPath.some(p => p.toLowerCase().includes(CATEGORY_FILTER)) ||
      ex.categoryPath.join(' > ').toLowerCase().includes(CATEGORY_FILTER)
    );
    console.log(`Filtered to ${examples.length} examples matching category "${CATEGORY_FILTER}"\n`);
  }

  // Apply limit
  if (LIMIT < examples.length) {
    examples = examples.slice(0, LIMIT);
    console.log(`Limited to first ${LIMIT} examples\n`);
  }

  // Build documents
  console.log('Building documents...');
  const documents = [];
  let skipped = 0;
  for (const example of examples) {
    const doc = buildDocument(example);
    if (doc) {
      documents.push(doc);
    } else {
      skipped++;
    }
  }
  console.log(`Built ${documents.length} documents (${skipped} skipped - missing JS files)\n`);

  // Category breakdown
  const categories = {};
  for (const doc of documents) {
    const cat = doc.metadata.category || 'uncategorized';
    categories[cat] = (categories[cat] || 0) + 1;
  }
  console.log('Category breakdown:');
  for (const [cat, count] of Object.entries(categories).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }
  console.log();

  // Keyword stats
  const allKeywords = {};
  for (const doc of documents) {
    for (const kw of doc.keywords) {
      allKeywords[kw] = (allKeywords[kw] || 0) + 1;
    }
  }
  const topKeywords = Object.entries(allKeywords)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);
  console.log('Top 20 SC components found:');
  for (const [kw, count] of topKeywords) {
    console.log(`  ${kw}: ${count}`);
  }
  console.log();

  if (DRY_RUN) {
    console.log('DRY RUN — no indexing performed.');
    console.log(`Would index ${documents.length} documents.`);
    // Show first 3 documents as sample
    for (const doc of documents.slice(0, 3)) {
      console.log(`\n--- ${doc.title} ---`);
      console.log(`URL: ${doc.url}`);
      console.log(`Keywords: ${doc.keywords.join(', ')}`);
      console.log(`Category: ${doc.metadata.category}`);
      console.log(`Text length: ${doc.text.length} chars`);
    }
    process.exit(0);
  }

  // Connect to bridge
  console.log('Connecting to bridge server...');
  const client = new ScriptClient('index-showcase', {
    totalSteps: documents.length,
    metadata: { type: 'indexer', target: 'smartclient-showcase' },
  });

  try {
    await client.connect();
    console.log('Connected. Starting indexing...\n');

    // If --wait-for-neural, poll until the bridge embedding model is ready
    if (WAIT_FOR_NEURAL) {
      process.stdout.write('Waiting for neural embedding model...');
      for (let attempt = 0; attempt < 120; attempt++) {
        const stats = await client._sendRequest(MSG.BRIDGE_VECTORDB_STATS, {}, 5000).catch(() => ({}));
        if (stats.embeddingReady) { process.stdout.write(' ready!\n\n'); break; }
        if (attempt === 119) { process.stdout.write(' timed out — using TF-IDF fallback\n\n'); break; }
        process.stdout.write('.');
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    let indexed = 0;
    let errors = 0;
    const startTime = Date.now();

    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      try {
        const result = await client.indexContent({
          url: doc.url,
          title: doc.title,
          text: doc.text,
          html: doc.html,
          contentType: doc.contentType,
          source: doc.source,
          keywords: doc.keywords,
          metadata: doc.metadata,
        });

        if (result.success) {
          indexed++;
        } else {
          console.error(`  FAIL: ${doc.title} — ${result.error || 'unknown error'}`);
          errors++;
        }
      } catch (err) {
        console.error(`  ERROR: ${doc.title} — ${err.message}`);
        errors++;
      }

      await client.progress(i + 1, documents.length, `Indexed: ${doc.metadata.exampleId}`);

      // Log progress every 50
      if ((i + 1) % 50 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = ((i + 1) / parseFloat(elapsed)).toFixed(1);
        console.log(`  [${i + 1}/${documents.length}] ${elapsed}s elapsed, ${rate} docs/sec`);
      }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nIndexing complete!`);
    console.log(`  Indexed: ${indexed}`);
    console.log(`  Errors:  ${errors}`);
    console.log(`  Time:    ${totalTime}s`);
    console.log(`  Rate:    ${(indexed / parseFloat(totalTime)).toFixed(1)} docs/sec`);

    await client.complete({ indexed, errors, totalTime: parseFloat(totalTime) });
  } catch (err) {
    console.error('Fatal error:', err.message);
    try { await client.error(err.message); } catch {}
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
