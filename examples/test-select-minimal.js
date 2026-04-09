#!/usr/bin/env node
import { parse_ixml } from 'rustixml';
import { readFileSync } from 'fs';

// Minimal SELECT test
const html = '|SELECT NAME="test"|OPTION|foo|/OPTION||/SELECT|';

const grammar = readFileSync('grammars/roboform-v2.ixml', 'utf8');

console.log('Input:', html);
console.log('');

try {
  const result = parse_ixml(grammar, html);
  if (result.success) {
    console.log('✅ SUCCESS');
    console.log(result.output);
  } else {
    console.log('❌ FAILED');
    console.log(result.error);
  }
} catch (e) {
  console.log('❌ EXCEPTION:', e.message);
}
