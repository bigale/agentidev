#!/usr/bin/env node
/**
 * Remove Brackets Preprocessor
 *
 * Remove < and > completely (original approach)
 */

const html = process.argv[2];

if (!html) {
  console.error('Usage: remove-brackets.js "<html>"');
  process.exit(1);
}

// Strip scripts and styles
let processed = html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');

// Remove closing tags entirely
processed = processed
  .replace(/<\/[^>]+>/g, ' ');

// Remove opening brackets
processed = processed
  .replace(/</g, ' ')
  .replace(/>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

console.log(processed);
