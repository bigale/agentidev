#!/usr/bin/env node
/**
 * Debug Roboform Grammar - Act as LLM Debugger
 */

import { readFileSync } from 'fs';
import { parse_ixml } from '/home/bigale/repos/rustixml/pkg-nodejs/rustixml.js';

// Preprocessing functions
function stripScriptTags(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
}

function stripStyleTags(html) {
  return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
}

function replaceBracketsWithPipes(html) {
  return html
    .replace(/</g, '|')
    .replace(/>/g, '|')
    .replace(/\|\|+/g, '||');
}

function preprocess(html) {
  return replaceBracketsWithPipes(stripStyleTags(stripScriptTags(html)));
}

// Extract form from HTML
function extractForm(html) {
  const formMatch = html.match(/<form[^>]*>[\s\S]*?<\/form>/i);
  return formMatch ? formMatch[0] : null;
}

// Read the form HTML
console.log('🔬 Debugging Roboform Grammar\n');

const fullHtml = readFileSync('/home/bigale/repos/contextual-recall/examples/roboform.html', 'utf8');
const formHtml = extractForm(fullHtml);

if (!formHtml) {
  console.error('❌ No form found');
  process.exit(1);
}

console.log('Form HTML length:', formHtml.length);
console.log('First 200 chars:', formHtml.substring(0, 200));
console.log('');

// Preprocess
const preprocessed = preprocess(formHtml);
console.log('Preprocessed length:', preprocessed.length);
console.log('First 400 chars of preprocessed:');
console.log(preprocessed.substring(0, 400));
console.log('\n...\n');

// Show sample structure
const lines = preprocessed.split('\n').slice(0, 20);
console.log('First 20 lines:');
lines.forEach((line, i) => console.log(`${i + 1}: ${line}`));

console.log('\n---\n');

// Key observations
console.log('📊 Key Observations:');
console.log('1. No |label| tags - labels are plain text in divs');
console.log('2. Pattern: |div||div class="col-xs-6 text-right"|LABEL TEXT|/div||div class="col-xs-6"||input ...||/div||/div|');
console.log('3. SELECT elements: |SELECT NAME="..."|...options...|/SELECT|');
console.log('4. Deeply nested structure with many divs');

console.log('\n---\n');
console.log('💡 Grammar Strategy:');
console.log('- Match any element recursively');
console.log('- Extract |input| and |SELECT| wherever they appear');
console.log('- Capture preceding text as potential labels');
console.log('- Ignore all structural divs');
