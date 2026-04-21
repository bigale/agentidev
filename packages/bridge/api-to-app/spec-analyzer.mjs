/**
 * OpenAPI Spec Analyzer — reads an OpenAPI 3.0 spec and extracts
 * endpoint metadata for PICT model generation.
 *
 * For each endpoint, generates a PICT model that covers:
 *   - Query/path/header parameters with valid + negative (~) values
 *   - Content-type and auth variations
 *   - Constraints between parameters
 */

import { readFileSync } from 'fs';

/**
 * Load an OpenAPI spec from a local file path.
 * @param {string} path - Path to JSON or YAML spec file
 * @returns {object} Parsed spec object
 */
export function loadSpec(path) {
  const raw = readFileSync(path, 'utf-8');
  // JSON or YAML — try JSON first (faster), fall back to YAML
  try {
    return JSON.parse(raw);
  } catch {
    // Lazy import yaml only if needed
    throw new Error('YAML specs not yet supported — convert to JSON first');
  }
}

/**
 * Extract all endpoints from a parsed OpenAPI spec.
 * @param {object} spec - Parsed OpenAPI spec
 * @returns {Array<object>} Endpoint descriptors
 */
export function extractEndpoints(spec) {
  const endpoints = [];
  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
      const op = pathItem[method];
      if (!op) continue;
      endpoints.push({
        method: method.toUpperCase(),
        path,
        operationId: op.operationId || `${method}_${path.replace(/[/{}]/g, '_')}`,
        parameters: op.parameters || pathItem.parameters || [],
        requestBody: op.requestBody || null,
        responses: op.responses || {},
        security: op.security || spec.security || [],
        tags: op.tags || [],
        summary: op.summary || '',
      });
    }
  }
  return endpoints;
}

/**
 * Generate a PICT model for a single endpoint.
 * @param {object} endpoint - From extractEndpoints()
 * @param {object} spec - Full spec (for resolving $ref)
 * @returns {{ model: string, paramMeta: object }} PICT model text + metadata
 */
export function generatePictModel(endpoint, spec) {
  const lines = [];
  const paramMeta = {}; // Track metadata for test generation

  lines.push(`# PICT model for ${endpoint.method} ${endpoint.path}`);
  lines.push(`# Generated from OpenAPI spec: ${spec.info?.title || 'unknown'}`);
  lines.push('');

  // ---- Parameters ----
  for (const param of endpoint.parameters) {
    // OpenAPI 3.0 uses param.schema; Swagger 2.0 uses param.type/enum/items directly
    const schema = param.schema
      ? resolveSchema(param.schema, spec)
      : param.items
        ? resolveSchema(param.items, spec)  // array param: use items schema
        : { type: param.type, enum: param.enum, format: param.format };
    const name = sanitizePictName(param.name);
    const values = generateValues(schema, param.required);

    paramMeta[name] = {
      originalName: param.name,
      in: param.in,
      required: param.required || false,
      schema,
      values,
    };

    lines.push(`${name}: ${values.join(', ')}`);
  }

  // ---- Accept header ----
  // OpenAPI 3.0: response content types. Swagger 2.0: spec.produces array
  const produces = endpoint.responses?.['200']?.content
    ? Object.keys(endpoint.responses['200'].content)
    : spec.produces || ['application/json'];
  if (produces.length > 0) {
    const acceptValues = produces.map(ct => ct.replace(/\//g, '_'));
    acceptValues.push('~text_plain'); // Negative: unsupported content type
    paramMeta['Accept'] = {
      originalName: 'Accept',
      in: 'header',
      required: false,
      values: acceptValues,
    };
    lines.push(`Accept: ${acceptValues.join(', ')}`);
  }

  // ---- Auth ----
  if (endpoint.security?.length > 0) {
    const authValues = ['valid_auth', '~no_auth', '~invalid_auth'];
    paramMeta['Auth'] = {
      originalName: 'Authorization',
      in: 'header',
      required: false,
      values: authValues,
    };
    lines.push(`Auth: ${authValues.join(', ')}`);
  }

  // ---- Constraints ----
  lines.push('');
  // If a parameter is required, constrain it away from empty/null negatives
  for (const param of endpoint.parameters) {
    if (param.required) {
      const name = sanitizePictName(param.name);
      const meta = paramMeta[name];
      const emptyNeg = meta?.values?.find(v => v === '~empty' || v === '~null');
      // PICT doesn't need explicit constraints for this — the ~prefix handles it
    }
  }

  return {
    model: lines.join('\n'),
    paramMeta,
    endpoint,
  };
}

/**
 * Resolve a $ref in the spec.
 */
function resolveSchema(schema, spec) {
  if (!schema) return { type: 'string' };
  if (schema.$ref) {
    const refPath = schema.$ref.replace('#/', '').split('/');
    let resolved = spec;
    for (const segment of refPath) resolved = resolved?.[segment];
    return resolved || { type: 'string' };
  }
  return schema;
}

/**
 * Generate PICT values for a schema, including ~negative values.
 */
function generateValues(schema, required = false) {
  const values = [];

  if (schema.enum) {
    // Enum: all valid values + one negative not in the enum
    values.push(...schema.enum);
    values.push('~unknown_enum');
  } else if (schema.type === 'integer' || schema.type === 'number') {
    values.push('1', '100', '999');
    values.push('~-1', '~abc');
    if (schema.minimum != null) values.push(String(schema.minimum));
    if (schema.maximum != null) values.push(String(schema.maximum));
  } else if (schema.type === 'boolean') {
    values.push('true', 'false');
  } else if (schema.type === 'array') {
    values.push('one_item', 'multiple_items');
    if (!schema.minItems || schema.minItems === 0) values.push('~empty_array');
  } else {
    // Default string
    values.push('valid_string', 'another_string');
    values.push('~empty', '~null');
  }

  return [...new Set(values)]; // deduplicate
}

/**
 * Sanitize a parameter name for PICT (no spaces, special chars).
 */
function sanitizePictName(name) {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}
