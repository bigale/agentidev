/**
 * PICT Runner — executes the PICT CLI and parses TSV output.
 *
 * PICT (Pairwise Independent Combinatorial Testing) generates minimal
 * covering arrays from parameter models. This module wraps the CLI
 * binary and converts its TSV output to JavaScript objects.
 */

import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PICT_BIN = 'pict';

/**
 * Run PICT on a model string, return raw TSV output.
 *
 * @param {string} modelText - PICT model file content
 * @param {object} [options]
 * @param {number} [options.order=2] - Combinatorial order (2=pairwise)
 * @param {number} [options.seed] - Deterministic random seed (/r:N)
 * @param {string} [options.seedFile] - TSV seed file path (/e:file)
 * @param {boolean} [options.caseSensitive=true] - Case-sensitive params (/c)
 * @returns {string} Raw TSV output from PICT
 */
export function runPict(modelText, options = {}) {
  const { order = 2, seed, seedFile, caseSensitive = true } = options;

  // Write model to temp file (PICT reads from file path, not stdin)
  const tmpFile = join(tmpdir(), `pict-model-${Date.now()}.pict`);
  writeFileSync(tmpFile, modelText, 'utf-8');

  const args = [tmpFile];
  if (order !== 2) args.push(`/o:${order}`);
  if (seed != null) args.push(`/r:${seed}`);
  if (seedFile) args.push(`/e:${seedFile}`);
  if (caseSensitive) args.push('/c');

  try {
    const result = execFileSync(PICT_BIN, args, {
      encoding: 'utf-8',
      timeout: 30000,
    });
    return result;
  } catch (err) {
    const stderr = err.stderr?.toString() || '';
    const message = stderr || err.message;
    throw new Error(`PICT execution failed: ${message}`);
  } finally {
    try { unlinkSync(tmpFile); } catch (_) {}
  }
}

/**
 * Parse PICT TSV output into an array of row objects.
 *
 * @param {string} tsvString - Raw TSV from PICT
 * @returns {{ headers: string[], rows: object[] }}
 */
export function parseTsv(tsvString) {
  const lines = tsvString.trim().split('\n');
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = lines[0].split('\t');
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split('\t');
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || '';
    }
    rows.push(row);
  }

  return { headers, rows };
}

/**
 * Run PICT and parse the output in one step.
 *
 * @param {string} modelText - PICT model content
 * @param {object} [options] - Same as runPict options
 * @returns {{ headers: string[], rows: object[] }}
 */
export function runAndParse(modelText, options = {}) {
  const tsv = runPict(modelText, options);
  return parseTsv(tsv);
}

/**
 * Check if PICT is installed and accessible.
 * @returns {boolean}
 */
export function isPictAvailable() {
  try {
    execFileSync('which', [PICT_BIN], { encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}
