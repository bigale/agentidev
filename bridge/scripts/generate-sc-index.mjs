#!/usr/bin/env node
/**
 * SmartClient Showcase Index Generator
 *
 * Parses exampleTree.js from the SmartClient SDK and generates a static
 * markdown index file (sc-showcase-index.md) for use by the Claude Code
 * /smartclient skill.
 *
 * Usage:
 *   node bridge/scripts/generate-sc-index.mjs
 *   node bridge/scripts/generate-sc-index.mjs --output=path/to/output.md
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- Configuration ----

const SDK_BASE = '/home/bigale/repos/SmartClient/SmartClient_v141p_2026-02-23_LGPL/smartclientSDK';
const EXAMPLE_TREE_PATH = join(SDK_BASE, 'isomorphic/system/reference/exampleTree.js');
const INLINE_EXAMPLES_DIR = join(SDK_BASE, 'isomorphic/system/reference/inlineExamples');
const DEFAULT_OUTPUT = join(__dirname, 'sc-showcase-index.md');

// SC component names for keyword extraction
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
  'TreeMenuButton', 'Slider',
  'DataSource', 'RestDataSource', 'WSDataSource',
  'RPCManager', 'DMI',
  'Offline', 'OfflineDataSource',
  'ResultSet', 'ResultTree',
  'RibbonBar', 'RibbonGroup',
  'AdaptiveMenu', 'BatchUploader', 'Progressbar', 'Snapbar', 'Scrollbar',
  'Splitbar', 'Hover', 'Tour', 'TourStep', 'PrintCanvas',
  'MultiSortDialog', 'DateChooser',
];

const SC_COMPONENT_RE = new RegExp(`isc\\.(${SC_COMPONENTS.join('|')})\\b`, 'g');

// ---- CLI args ----

const args = process.argv.slice(2);
const OUTPUT_PATH = (() => {
  const outArg = args.find(a => a.startsWith('--output='));
  return outArg ? outArg.split('=')[1] : DEFAULT_OUTPUT;
})();

// ---- Tree Parser (shared with index-showcase.mjs) ----

function parseExampleTree() {
  const source = readFileSync(EXAMPLE_TREE_PATH, 'utf8');
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
    const folderTitle = isRoot ? '' : (node.title || node.shortTitle || node.name || '');
    const childPath = folderTitle && !node.jsURL ? [...path, folderTitle] : path;
    for (const child of node.children) {
      examples.push(...collectExamples(child, childPath, false));
    }
  }
  return examples;
}

function extractKeywords(jsPath) {
  try {
    const source = readFileSync(jsPath, 'utf8');
    const keywords = new Set();
    let match;
    while ((match = SC_COMPONENT_RE.exec(source)) !== null) {
      keywords.add(match[1]);
    }
    SC_COMPONENT_RE.lastIndex = 0;
    return [...keywords];
  } catch {
    return [];
  }
}

// ---- Category Tree Builder ----

function buildCategoryTree(examples) {
  const tree = {};
  for (const ex of examples) {
    let node = tree;
    for (const segment of ex.categoryPath) {
      if (!node[segment]) node[segment] = { _examples: [], _children: {} };
      node = node[segment]._children;
    }
  }

  // Count examples per category path
  const counts = {};
  for (const ex of examples) {
    const key = ex.categoryPath.join(' > ') || 'root';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

// ---- Markdown Generator ----

function generateMarkdown(examples) {
  const lines = [];

  lines.push('# SmartClient Showcase Index');
  lines.push('');
  lines.push(`> ${examples.length} examples indexed from SmartClient SDK v14.1p`);
  lines.push(`> Generated: ${new Date().toISOString().split('T')[0]}`);
  lines.push('');

  // Category tree with counts
  lines.push('## Categories');
  lines.push('');

  const categoryCounts = buildCategoryTree(examples);
  const sortedCategories = Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1]);

  for (const [cat, count] of sortedCategories) {
    const depth = cat.split(' > ').length - 1;
    const indent = '  '.repeat(depth);
    const label = cat.split(' > ').pop();
    lines.push(`${indent}- **${label}** (${count})`);
  }
  lines.push('');

  // Component coverage
  lines.push('## Component Coverage');
  lines.push('');

  const componentCounts = {};
  for (const ex of examples) {
    const jsPath = join(INLINE_EXAMPLES_DIR, ex.jsURL);
    const kws = extractKeywords(jsPath);
    for (const kw of kws) {
      componentCounts[kw] = (componentCounts[kw] || 0) + 1;
    }
  }

  const sortedComponents = Object.entries(componentCounts)
    .sort((a, b) => b[1] - a[1]);

  lines.push('| Component | Examples |');
  lines.push('|-----------|---------|');
  for (const [comp, count] of sortedComponents.slice(0, 40)) {
    lines.push(`| ${comp} | ${count} |`);
  }
  if (sortedComponents.length > 40) {
    lines.push(`| ... | (${sortedComponents.length - 40} more) |`);
  }
  lines.push('');

  // Full example list grouped by top-level category
  lines.push('## Examples by Category');
  lines.push('');

  const grouped = {};
  for (const ex of examples) {
    const topCat = ex.categoryPath[0] || 'Other';
    if (!grouped[topCat]) grouped[topCat] = [];

    const jsPath = join(INLINE_EXAMPLES_DIR, ex.jsURL);
    const kws = extractKeywords(jsPath);
    const exampleId = ex.jsURL.replace(/\.js$/, '');

    grouped[topCat].push({
      title: ex.title,
      exampleId,
      keywords: kws.slice(0, 5),
      subCategory: ex.categoryPath.slice(1).join(' > '),
    });
  }

  const sortedGroups = Object.entries(grouped)
    .sort((a, b) => b[1].length - a[1].length);

  for (const [cat, items] of sortedGroups) {
    lines.push(`### ${cat} (${items.length})`);
    lines.push('');
    for (const item of items) {
      const kwStr = item.keywords.length > 0 ? ` [${item.keywords.join(', ')}]` : '';
      const subStr = item.subCategory ? ` _(${item.subCategory})_` : '';
      lines.push(`- **${item.title}**${subStr}${kwStr}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---- Main ----

function main() {
  console.log('SmartClient Showcase Index Generator');
  console.log('====================================\n');

  if (!existsSync(EXAMPLE_TREE_PATH)) {
    console.error(`ERROR: exampleTree.js not found at ${EXAMPLE_TREE_PATH}`);
    process.exit(1);
  }

  console.log('Parsing exampleTree.js...');
  const root = parseExampleTree();
  const examples = collectExamples(root);
  console.log(`Found ${examples.length} examples\n`);

  console.log('Generating markdown index...');
  const markdown = generateMarkdown(examples);

  writeFileSync(OUTPUT_PATH, markdown, 'utf8');
  console.log(`Written to: ${OUTPUT_PATH}`);
  console.log(`Size: ${(markdown.length / 1024).toFixed(1)} KB`);
}

main();
