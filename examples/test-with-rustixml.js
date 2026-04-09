#!/usr/bin/env node
/**
 * Test preprocessing + grammar with rustixml (Node.js)
 */

import { readFileSync } from 'fs';
import { parse_ixml } from 'rustixml';

const TEST_CASES = {
  simple_form: '<form action="/submit"><label>Name:</label><input type="text" name="name"></form>',
  login_form: '<form action="/login"><label>Email:</label><input type="email" name="email"><label>Password:</label><input type="password" name="pwd"><input type="submit" value="Login"></form>'
};

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

async function runTests() {
  console.log('🔬 Testing rustixml with our pipeline\n');

  // Load grammar
  const grammar = readFileSync('grammars/llm-form-rustixml.ixml', 'utf8');
  console.log('✓ Grammar loaded:', grammar.split('\n').length, 'lines\n');

  // Run tests
  for (const [name, html] of Object.entries(TEST_CASES)) {
    console.log(`Testing: ${name}`);
    console.log('  Input HTML:', html.substring(0, 60) + '...');

    // Preprocess
    const preprocessed = preprocess(html);
    console.log('  Preprocessed:', preprocessed.substring(0, 60) + '...');

    // Parse
    try {
      const result = parse_ixml(grammar, preprocessed);

      if (result.success) {
        console.log('  ✅ PASS');
        console.log('  Output:', result.output.substring(0, 200) + '...\n');
      } else {
        console.log('  ❌ FAIL');
        console.log('  Error:', result.error, '\n');
      }
    } catch (error) {
      console.log('  ❌ EXCEPTION');
      console.log('  Error:', error.message, '\n');
    }
  }
}

runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
