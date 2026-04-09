#!/usr/bin/env node
/**
 * Multi-Grammar Pipeline Test
 *
 * Demonstrates hierarchical grammar approach:
 * 1. Pass 1: SELECT-only grammar
 * 2. Pass 2: INPUT-only grammar
 * 3. Combine results
 */

import { readFileSync } from 'fs';
import { parse_ixml } from 'rustixml';

// Preprocessing
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

function extractForm(html) {
  const formMatch = html.match(/<form[^>]*>[\s\S]*?<\/form>/i);
  return formMatch ? formMatch[0] : null;
}

console.log('🔬 Multi-Grammar Pipeline Test\n');

// Load HTML and preprocess
const fullHtml = readFileSync(new URL('./', import.meta.url).pathname + 'roboform.html', 'utf8');
const formHtml = extractForm(fullHtml);
const preprocessed = preprocess(formHtml);

console.log('Preprocessed:', preprocessed.length, 'bytes\n');

// Load grammars
const selectGrammar = readFileSync('grammars/select-only.ixml', 'utf8');
const inputGrammar = readFileSync('grammars/input-only.ixml', 'utf8');

console.log('📝 Loaded Grammars:');
console.log('  - select-only.ixml:', selectGrammar.split('\n').length, 'lines');
console.log('  - input-only.ixml:', inputGrammar.split('\n').length, 'lines');
console.log('');

// Pass 1: Extract SELECTs
console.log('🔍 Pass 1: Extracting SELECTs...');
let selectResult;
try {
  selectResult = parse_ixml(selectGrammar, preprocessed);

  if (selectResult.success) {
    const selectCount = (selectResult.output.match(/<select-el>/g) || []).length;
    console.log('  ✅ Found', selectCount, 'SELECT elements');
    console.log('  Sample:', selectResult.output.substring(0, 300) + '...');
  } else {
    console.log('  ❌ Parse failed:', selectResult.error);
  }
} catch (error) {
  console.log('  ❌ Exception:', error.message);
}
console.log('');

// Pass 2: Extract INPUTs
console.log('🔍 Pass 2: Extracting INPUTs...');
let inputResult;
try {
  inputResult = parse_ixml(inputGrammar, preprocessed);

  if (inputResult.success) {
    const inputCount = (inputResult.output.match(/<input-el>/g) || []).length;
    console.log('  ✅ Found', inputCount, 'INPUT elements');
    console.log('  Sample:', inputResult.output.substring(0, 300) + '...');
  } else {
    console.log('  ❌ Parse failed:', inputResult.error);
  }
} catch (error) {
  console.log('  ❌ Exception:', error.message);
}
console.log('');

// Combine results
console.log('🎯 Combined Results:');
if (selectResult?.success && inputResult?.success) {
  const selectCount = (selectResult.output.match(/<select-el>/g) || []).length;
  const inputCount = (inputResult.output.match(/<input-el>/g) || []).length;
  const totalFields = selectCount + inputCount;

  console.log('  Total Fields Extracted:', totalFields);
  console.log('    - INPUTs:', inputCount);
  console.log('    - SELECTs:', selectCount);
  console.log('');
  console.log('  Expected: 41 fields (from fallback)');
  console.log('  Success Rate:', Math.round((totalFields / 41) * 100) + '%');
  console.log('');

  if (totalFields >= 41) {
    console.log('  🎉 100% SUCCESS! Multi-grammar pipeline works!');
  } else {
    console.log('  ⚠️ Missing', (41 - totalFields), 'fields');
  }
} else {
  console.log('  ❌ One or more passes failed');
}
