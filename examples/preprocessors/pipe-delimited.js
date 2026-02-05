#!/usr/bin/env node
/**
 * Pipe-Delimited Preprocessor
 *
 * Replace < and > with | to preserve structure
 */

const html = process.argv[2];

if (!html) {
  console.error('Usage: pipe-delimited.js "<html>"');
  process.exit(1);
}

// Strip scripts and styles
let processed = html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');

// Replace brackets with pipes
processed = processed
  .replace(/</g, '|')
  .replace(/>/g, '|')
  .replace(/\|\|+/g, '||');

console.log(processed);
