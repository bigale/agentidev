/**
 * Multi-level PICT orchestration.
 *
 * L0 model: selects which endpoint to exercise + cross-cutting concerns
 *   (auth, content-type). Produces one row per test scenario.
 *
 * L1 models: per-endpoint parameter models. Seeded with L0 values so
 *   cross-cutting parameters are consistent across levels.
 *
 * L2 models (future): expand complex nested body schemas.
 *
 * The wrapper runs L0 first, then for each L0 row, finds the matching
 * L1 model and runs PICT with the L0 row as a seed. This gives cross-
 * endpoint coverage (every auth × endpoint pair tested) AND per-endpoint
 * parameter coverage (pairwise within each endpoint).
 */

import { loadSpec, extractEndpoints, generatePictModel } from './spec-analyzer.mjs';
import { runAndParse, runPict, parseTsv } from './pict-runner.mjs';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Generate the L0 (endpoint selection) PICT model.
 *
 * @param {object[]} endpoints - Endpoint descriptors from extractEndpoints
 * @param {object} spec - Full spec
 * @returns {{ model: string, endpointMap: Map<string, object> }}
 */
export function generateL0Model(endpoints, spec) {
  const endpointValues = endpoints.map(ep => ep.operationId);
  const lines = [];

  lines.push('# L0: Endpoint selection + cross-cutting concerns');
  lines.push('');

  // All parameters first (PICT requires params before constraints)
  lines.push('Endpoint: ' + endpointValues.join(', '));
  lines.push('Auth: valid_auth, ~no_auth, ~invalid_auth');
  lines.push('Accept: application_json, ~text_plain');

  const hasMutations = endpoints.some(ep => ep.method === 'POST' || ep.method === 'PUT');
  if (hasMutations) {
    lines.push('ContentType: application_json, ~text_plain');
  }

  // Constraints after all parameters
  if (hasMutations) {
    const readOps = endpoints.filter(ep => ep.method === 'GET' || ep.method === 'DELETE').map(ep => `"${ep.operationId}"`);
    if (readOps.length > 0) {
      lines.push('');
      lines.push(`IF [Endpoint] IN {${readOps.join(', ')}} THEN [ContentType] = "application_json";`);
    }
  }

  const endpointMap = new Map();
  for (const ep of endpoints) endpointMap.set(ep.operationId, ep);

  return { model: lines.join('\n'), endpointMap };
}

/**
 * Run the full multi-level pipeline.
 *
 * @param {string} specPath - Path to spec file
 * @param {object} options
 * @param {string[]} options.operationIds - Which endpoints to include
 * @param {number} [options.seed=42] - PICT seed
 * @param {number} [options.l0Order=2] - L0 combinatorial order
 * @param {number} [options.l1Order=2] - L1 combinatorial order
 * @returns {{ l0Rows: object[], l1Results: Map<string, object[]>, totalCases: number }}
 */
export function runMultiLevel(specPath, options = {}) {
  const { operationIds, seed = 42, l0Order = 2, l1Order = 2 } = options;
  const spec = loadSpec(specPath);
  const allEndpoints = extractEndpoints(spec);

  // Filter to requested endpoints
  const endpoints = operationIds
    ? allEndpoints.filter(ep => operationIds.includes(ep.operationId))
    : allEndpoints;

  if (endpoints.length === 0) throw new Error('No matching endpoints');

  // Step 1: Generate and run L0
  const { model: l0Model, endpointMap } = generateL0Model(endpoints, spec);
  const l0Result = runAndParse(l0Model, { order: l0Order, seed, caseSensitive: true });

  // Step 2: Generate L1 models for each endpoint
  const l1Models = new Map();
  for (const ep of endpoints) {
    const analysis = generatePictModel(ep, spec);
    l1Models.set(ep.operationId, analysis);
  }

  // Step 3: For each L0 row, run the matching L1 model with L0 seed values
  const l1Results = new Map(); // operationId -> expanded rows[]
  let totalCases = 0;

  for (const l0Row of l0Result.rows) {
    const opId = l0Row.Endpoint;
    const l1Analysis = l1Models.get(opId);
    if (!l1Analysis) continue;

    // Build seed TSV: inject L0 cross-cutting values into L1
    // L1 params that match L0 param names get seeded
    const l1ParamNames = Object.keys(l1Analysis.paramMeta);
    const seedHeaders = [];
    const seedValues = [];

    for (const l0Param of ['Auth', 'Accept', 'ContentType']) {
      if (l0Row[l0Param] && l1ParamNames.includes(l0Param)) {
        seedHeaders.push(l0Param);
        seedValues.push(l0Row[l0Param]);
      }
    }

    let l1Rows;
    if (seedHeaders.length > 0) {
      // Write seed TSV
      const seedTsv = seedHeaders.join('\t') + '\n' + seedValues.join('\t');
      const seedFile = join(tmpdir(), `pict-seed-${Date.now()}.tsv`);
      writeFileSync(seedFile, seedTsv, 'utf-8');

      try {
        l1Rows = runAndParse(l1Analysis.model, {
          order: l1Order, seed, caseSensitive: true, seedFile,
        }).rows;
      } catch {
        // Seed conflict — run without seed
        l1Rows = runAndParse(l1Analysis.model, {
          order: l1Order, seed, caseSensitive: true,
        }).rows;
      }
    } else {
      l1Rows = runAndParse(l1Analysis.model, {
        order: l1Order, seed, caseSensitive: true,
      }).rows;
    }

    // Tag each L1 row with the L0 context
    const expandedRows = l1Rows.map(row => ({
      _l0: l0Row,
      _endpoint: opId,
      ...row,
      // Override with L0 values for consistency
      ...(l0Row.Auth ? { Auth: l0Row.Auth } : {}),
      ...(l0Row.Accept ? { Accept: l0Row.Accept } : {}),
      ...(l0Row.ContentType ? { ContentType: l0Row.ContentType } : {}),
    }));

    if (!l1Results.has(opId)) l1Results.set(opId, []);
    l1Results.get(opId).push(...expandedRows);
    totalCases += expandedRows.length;
  }

  return {
    l0Model,
    l0Rows: l0Result.rows,
    l1Models: Object.fromEntries([...l1Models].map(([k, v]) => [k, v.model])),
    l1Results,
    totalCases,
    endpointMap,
  };
}
