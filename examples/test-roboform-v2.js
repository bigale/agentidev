#!/usr/bin/env node
/**
 * Test Roboform Grammar with rustixml
 */

import { readFileSync } from 'fs';
import { parse_ixml } from '/home/bigale/repos/rustixml/pkg-nodejs/rustixml.js';

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

// Main test
console.log('🧪 Testing Roboform Grammar\n');

const fullHtml = readFileSync('/home/bigale/repos/contextual-recall/examples/roboform.html', 'utf8');
const formHtml = extractForm(fullHtml);
const preprocessed = preprocess(formHtml);

console.log('Form HTML:', formHtml.length, 'bytes');
console.log('Preprocessed:', preprocessed.length, 'bytes');
console.log('');

// Load grammar
const grammar = readFileSync('grammars/roboform-v2.ixml', 'utf8');
console.log('Grammar loaded:', grammar.split('\n').length, 'lines');
console.log('');

// Parse
console.log('Parsing...');
try {
  const result = parse_ixml(grammar, preprocessed);

  if (result.success) {
    console.log('✅ SUCCESS!');
    console.log('');
    console.log('Output length:', result.output.length, 'bytes');
    console.log('First 500 chars:');
    console.log(result.output.substring(0, 500));
    console.log('');

    // Count elements
    const inputCount = (result.output.match(/<input-el>/g) || []).length;
    const selectCount = (result.output.match(/<select-el>/g) || []).length;
    const textDivCount = (result.output.match(/<text-div>/g) || []).length;

    console.log('📊 Extracted Elements:');
    console.log('  Inputs:', inputCount);
    console.log('  Selects:', selectCount);
    console.log('  Text Divs (potential labels):', textDivCount);

  } else {
    console.log('❌ PARSE FAILED');
    console.log('Error:', result.error);
  }

} catch (error) {
  console.log('❌ EXCEPTION');
  console.log('Error:', error.message);
}
